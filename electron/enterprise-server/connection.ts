/**
 * Company Enterprise Server connection — managed configuration (docs/enterprise-server/04-UPDATE-CHAIN.md §3).
 *
 * The company IT pushes ONE machine-level file with MDM/GPO. When the file is absent (every personal install) this
 * module returns null and the Desktop keeps its existing behaviour byte for byte: the updater reads the Agentlas
 * release registry exactly as before. Pure Node — no Electron import — so the daemon and tests can load it.
 */
import fs from "node:fs";
import path from "node:path";

export const ENTERPRISE_CONNECTION_SCHEMA = "agentlas.enterprise-server-connection.v1";
export interface EnterpriseServerConnection {
  readonly serverUrl: string; // origin only, no trailing slash
  readonly serverKeyFingerprint: string; // sha256 hex of the server's raw Ed25519 public key
  readonly updates: "company" | "agentlas";
  readonly enrollmentCode: string | null;
  readonly source: string; // which file supplied it
}

/** Machine-level locations, most specific first. `env` override exists for tests and advanced IT setups. */
export function managedConfigCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const list: string[] = [];
  const override = env.AGENTLAS_ENTERPRISE_SERVER_CONFIG?.trim();
  if (override) list.push(override);
  if (platform === "darwin") list.push("/Library/Application Support/Agentlas/enterprise-server.json");
  else if (platform === "win32") list.push(path.win32.join(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData", "Agentlas", "enterprise-server.json"));
  else list.push("/etc/agentlas/enterprise-server.json");
  return list;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** https only; plain http is accepted for loopback development servers. Paths, credentials and queries are refused. */
export function normalizeServerUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u.origin;
  return null;
}

export function parseEnterpriseConnection(raw: unknown, source: string): EnterpriseServerConnection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const allowed = ["schema", "serverUrl", "serverKeyFingerprint", "updates", "enrollmentCode"];
  if (Object.keys(o).some(k => !allowed.includes(k)) || o.schema !== ENTERPRISE_CONNECTION_SCHEMA) return null;
  const serverUrl = normalizeServerUrl(o.serverUrl);
  const fp = typeof o.serverKeyFingerprint === "string" ? o.serverKeyFingerprint.trim().toLowerCase() : "";
  const updates = o.updates === undefined ? "company" : o.updates;
  const code = o.enrollmentCode === undefined ? null : o.enrollmentCode;
  if (!serverUrl || !/^[a-f0-9]{64}$/.test(fp) || (updates !== "company" && updates !== "agentlas")
    || (code !== null && (typeof code !== "string" || !/^ENR-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)))) return null;
  return { serverUrl, serverKeyFingerprint: fp, updates, enrollmentCode: code as string | null, source };
}

/** Read the managed configuration. A present-but-invalid file is reported (so IT sees it) and treated as absent. */
export function readEnterpriseConnection(opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; warn?: (m: string) => void; onIgnored?: (file: string) => void } = {}): EnterpriseServerConnection | null {
  for (const file of managedConfigCandidates(opts.platform, opts.env)) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { opts.warn?.(`[enterprise-server] ignoring unreadable managed config ${file}`); opts.onIgnored?.(file); return null; }
    const conn = parseEnterpriseConnection(parsed, file);
    if (!conn) { opts.warn?.(`[enterprise-server] ignoring invalid managed config ${file}`); opts.onIgnored?.(file); }
    return conn;
  }
  return null;
}

/**
 * A connection this person entered on this device (Settings → company server), kept in the user data folder. It exists only
 * after a successful enrollment, carries no code, and never moves the update feed: only a machine-level managed file can.
 */
export const USER_CONNECTION_SCHEMA = "agentlas.enterprise-server-user-connection.v1";
export function userConnectionFile(stateDir: string): string { return path.join(stateDir, "connection.json"); }
export function readUserEnterpriseConnection(stateDir: string): EnterpriseServerConnection | null {
  const file = userConnectionFile(stateDir);
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "schema,serverKeyFingerprint,serverUrl" || o.schema !== USER_CONNECTION_SCHEMA) return null;
  const serverUrl = normalizeServerUrl(o.serverUrl);
  const fp = typeof o.serverKeyFingerprint === "string" ? o.serverKeyFingerprint : "";
  if (!serverUrl || !/^[a-f0-9]{64}$/.test(fp)) return null;
  return { serverUrl, serverKeyFingerprint: fp, updates: "agentlas", enrollmentCode: null, source: "user" };
}
export function writeUserEnterpriseConnection(stateDir: string, c: { serverUrl: string; serverKeyFingerprint: string }): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = userConnectionFile(stateDir), tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: USER_CONNECTION_SCHEMA, serverUrl: c.serverUrl, serverKeyFingerprint: c.serverKeyFingerprint }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Same response shape as https://agentlas.cloud/api/desktop/latest (API-CONTRACT.md §4.3). */
export const enterpriseReleaseMetadataUrl = (c: EnterpriseServerConnection) => `${c.serverUrl}/api/v1/desktop/latest`;
/** electron-updater generic feed base for one release tag (`v1.2.3`). */
export const enterpriseFeedUrl = (c: EnterpriseServerConnection, tag: string) => `${c.serverUrl}/updates/desktop/${tag}/`;
export const usesCompanyUpdates = (c: EnterpriseServerConnection | null): c is EnterpriseServerConnection => !!c && c.updates === "company";
