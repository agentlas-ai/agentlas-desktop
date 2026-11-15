import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { cliUserHome } from "./product-home-identity";

// Official kimi-code v0.28 managed provider/file-token contract. Unknown TOML
// features or credential scopes do not authorize sending a key to an endpoint.
export const KIMI_MANAGED_BASE_URL = "https://api.kimi.com/coding/v1";
export type KimiAuthResolution =
  /* credentialFingerprint names this exact token (it changes on every refresh). accountFingerprint names the signed-in
   * account and stays the same across refreshes; see kimiAccountFingerprintOf. */
  | { state: "resolved"; token: string; baseUrl: string; managed: boolean; credentialFingerprint: string; accountFingerprint: string }
  | { state: "signed-out" | "unknown"; reason: string };
/** The credential the config selects, before asking whether it can still be sent. */
type KimiSelection =
  | { state: "selected"; token: string; baseUrl: string; managed: boolean; expired: boolean }
  | { state: "signed-out" | "unknown"; reason: string };

function kimiHome(env: NodeJS.ProcessEnv): string {
  return env.KIMI_CODE_HOME || path.join(cliUserHome(env), ".kimi-code");
}

/** The files that decide which Kimi account is signed in: the config, and the stored sign-in it may point at. */
export function kimiAuthFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = kimiHome(env);
  return [path.join(home, "config.toml"), path.join(home, "credentials", "kimi-code.json")];
}

function sha16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The subject claim of a JWT-shaped token, unverified. It is used only to tell two local sign-ins apart. */
function tokenSubject(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/u.test(part))) return undefined;
  try {
    const subject = (JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown } | null)?.sub;
    if (typeof subject === "number" && Number.isFinite(subject)) return String(subject);
    return typeof subject === "string" && subject.trim() && subject.length <= 256 ? subject.trim() : undefined;
  } catch { return undefined; }
}

/**
 * Which account a credential belongs to. The stored sign-in is read for its token and expiry and no account id field is
 * known for it, so the one stable name available locally is the token's own subject claim: a refresh issues a new token
 * for the same subject, a different sign-in carries another. A token without one (an API key, an opaque token) is its
 * own identity: the exact credential. That keeps a different account always detected, at the price of a refresh of such
 * a token looking like a new account.
 */
function kimiAccountFingerprintOf(baseUrl: string, token: string): string {
  const subject = tokenSubject(token);
  return sha16(subject ? `kimi-account:${baseUrl}:${subject}` : `kimi:${baseUrl}:${token}`);
}

function stripComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && c === "\\") { escaped = true; continue; }
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i).trim();
  }
  if (quote) throw new Error("unsupported-config");
  return line.trim();
}

function stringValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && !value.startsWith('"""')) {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
  }
  if (value.startsWith("'") && value.endsWith("'") && !value.startsWith("'''")) return value.slice(1, -1);
  throw new Error("unsupported-config");
}

function sectionParts(value: string): string[] {
  const parts: string[] = [];
  const pattern = /(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.|\s*$)/gu;
  let consumed = 0;
  for (const hit of value.matchAll(pattern)) {
    if (hit.index !== consumed) throw new Error("unsupported-config");
    const part = hit[0].replace(/\s*\.\s*$/u, "").trim();
    parts.push(part.startsWith('"') || part.startsWith("'") ? stringValue(part) : part);
    consumed = hit.index + hit[0].length;
  }
  if (consumed !== value.length || !parts.length) throw new Error("unsupported-config");
  return parts;
}

/** Deliberately supports only the generated scalar auth/model TOML subset.
 * An unsupported relevant construct is unknown, never a guessed provider. */
function authConfig(raw: string): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  let section: string[] = [];
  for (const source of raw.split(/\r?\n/u)) {
    const line = stripComment(source);
    if (!line) continue;
    if (line.startsWith("[")) {
      if (!line.endsWith("]") || line.startsWith("[[")) throw new Error("unsupported-config");
      section = sectionParts(line.slice(1, -1).trim());
      continue;
    }
    const hit = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/u.exec(line);
    if (!hit) throw new Error("unsupported-config");
    const key = hit[1];
    const relevant = section.length === 0 ? ["default_model", "models", "providers"].includes(key)
      : section[0] === "providers" || (section[0] === "models" && key === "provider");
    if (!relevant) continue;
    const tableKey = JSON.stringify(section);
    let table = tables.get(tableKey);
    if (!table) { table = new Map(); tables.set(tableKey, table); }
    if (table.has(key)) throw new Error("unsupported-config");
    table.set(key, stringValue(hit[2]));
  }
  return tables;
}

function endpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
  } catch { return null; }
}

/** Reads the config and the stored sign-in. Throws on an unreadable or unsupported file; callers turn that into "unknown". */
function selectKimiCredential(env: NodeJS.ProcessEnv): KimiSelection {
  if (env.KIMI_MODEL_NAME) return { state: "unknown", reason: "model-env-override" };
  const [file, tokenFile] = kimiAuthFiles(env);
  if (!fs.existsSync(file)) return { state: "signed-out", reason: "no-model-configured" };
  const tables = authConfig(fs.readFileSync(file, "utf8"));
  const model = tables.get("[]")?.get("default_model");
  if (!model) return { state: "signed-out", reason: "no-model-configured" };
  const providerName = tables.get(JSON.stringify(["models", model]))?.get("provider");
  if (!providerName) return { state: "unknown", reason: "selected-provider-unknown" };
  const provider = tables.get(JSON.stringify(["providers", providerName]));
  if (!provider) return { state: "unknown", reason: "selected-provider-unknown" };
  if (!["kimi", "openai", "openai_responses"].includes(provider.get("type") ?? "")) return { state: "unknown", reason: "provider-protocol-unsupported" };
  if ([...tables.keys()].some(key => {
    const parts = JSON.parse(key) as string[];
    return parts[0] === "providers" && parts[1] === providerName && ["env", "custom_headers"].includes(parts[2]);
  })) return { state: "unknown", reason: "provider-overrides-unsupported" };
  const oauth = tables.get(JSON.stringify(["providers", providerName, "oauth"]));
  const apiKey = provider.get("api_key");
  if (apiKey && oauth) return { state: "unknown", reason: "ambiguous-auth-scope" };
  const base = provider.get("base_url") ?? (providerName === "managed:kimi-code" ? env.KIMI_CODE_BASE_URL || KIMI_MANAGED_BASE_URL : undefined);
  const baseUrl = base ? endpoint(base) : null;
  if (!baseUrl) return { state: "unknown", reason: "endpoint-unknown" };
  // Official managed runtime gives its base-url env override precedence and
  // moves OAuth credentials into a different slot. Do not probe the old slot.
  if (providerName === "managed:kimi-code" && env.KIMI_CODE_BASE_URL && endpoint(env.KIMI_CODE_BASE_URL) !== baseUrl)
    return { state: "unknown", reason: "managed-endpoint-override" };
  const managed = baseUrl === KIMI_MANAGED_BASE_URL;
  let token = apiKey;
  let expired = false;
  if (!token) {
    if (!managed || providerName !== "managed:kimi-code" || oauth?.get("storage") !== "file"
      || !["oauth/kimi-code", "kimi-code"].includes(oauth.get("key") ?? "")
      || (oauth.get("oauth_host") && oauth.get("oauth_host") !== "https://auth.kimi.com")
      || [env.KIMI_CODE_OAUTH_HOST, env.KIMI_OAUTH_HOST].some(host => host && host !== "https://auth.kimi.com"))
      return { state: "unknown", reason: "oauth-scope-unsupported" };
    if (!fs.existsSync(tokenFile)) return { state: "signed-out", reason: "no-stored-credential" };
    const credential = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    if (typeof credential.access_token !== "string" || !credential.access_token) return { state: "signed-out", reason: "no-stored-credential" };
    expired = typeof credential.expires_at === "number" && credential.expires_at > 0 && credential.expires_at * 1000 <= Date.now() + 30_000;
    token = credential.access_token;
  }
  return { state: "selected", token: token ?? "", baseUrl, managed, expired };
}

export function resolveKimiAuth(env: NodeJS.ProcessEnv = process.env): KimiAuthResolution {
  try {
    const selected = selectKimiCredential(env);
    if (selected.state !== "selected") return selected;
    // The CLI may still refresh this account. Read-only metadata probing
    // cannot mutate tokens or infer that a refreshable account signed out.
    if (selected.expired) return { state: "unknown", reason: "credential-expired" };
    const { token, baseUrl, managed } = selected;
    if (!token || /[\r\n]/u.test(token)) return { state: "unknown", reason: "credential-invalid" };
    return { state: "resolved", token, baseUrl, managed,
      credentialFingerprint: sha16(`kimi:${baseUrl}:${token}`), accountFingerprint: kimiAccountFingerprintOf(baseUrl, token) };
  } catch { return { state: "unknown", reason: "config-or-credential-unreadable" }; }
}

/**
 * The signed-in account, whether or not its token can be sent right now. An expired token still names its account: the
 * CLI refreshes it later, and neither the expiry nor the refresh is a change of account. Undefined when signed out or
 * when the config cannot be read.
 */
export function kimiAccountFingerprint(env: NodeJS.ProcessEnv = process.env): { fingerprint: string; managed: boolean } | undefined {
  try {
    const selected = selectKimiCredential(env);
    if (selected.state !== "selected" || !selected.token || /[\r\n]/u.test(selected.token)) return undefined;
    return { fingerprint: kimiAccountFingerprintOf(selected.baseUrl, selected.token), managed: selected.managed };
  } catch { return undefined; }
}

export async function fetchKimiMetadata(auth: Extract<KimiAuthResolution, { state: "resolved" }>, route: "models" | "usages", signal?: AbortSignal): Promise<
  { ok: true; payload: unknown } | { ok: false; status?: number; reason: string }
> {
  if (signal?.aborted) return { ok: false, reason: "aborted" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 8_000);
  try {
    let request: typeof fetch = fetch;
    try { const { net } = require("electron") as typeof import("electron"); if (net?.fetch) request = net.fetch.bind(net) as typeof fetch; } catch { /* Node/headless. */ }
    const response = await request(`${auth.baseUrl}/${route}`, { method: "GET", redirect: "error",
      headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}` };
    return { ok: true, payload: await response.json() };
  } catch { return { ok: false, reason: signal?.aborted ? "aborted" : controller.signal.aborted ? "timeout" : "network-or-schema-error" }; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export async function probeKimiAuth(options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<
  { state: "signed-in" | "signed-out" | "unknown"; reason?: string; evidence: string[] }
> {
  if (options.signal?.aborted) return { state: "unknown", reason: "aborted", evidence: [] };
  const auth = resolveKimiAuth(options.env);
  if (auth.state !== "resolved") return { ...auth, evidence: ["kimi:selected-config"] };
  const result = await fetchKimiMetadata(auth, "models", options.signal);
  if (!result.ok) return { state: result.status === 401 || result.status === 403 ? "signed-out" : "unknown", reason: result.reason, evidence: ["kimi:readonly-models-get"] };
  const data = (result.payload as { data?: unknown })?.data;
  const valid = Array.isArray(data) && data.length > 0 && data.every(model => model && typeof model.id === "string" && model.id.length > 0);
  return { state: valid ? "signed-in" : "unknown", ...(valid ? {} : { reason: "models-schema-unknown" }), evidence: ["kimi:readonly-models-get"] };
}
