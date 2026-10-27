// System proxy and system trust store for Node networking in every Agentlas
// host process (Desktop Main, background daemon). No Electron import: the
// daemon runs as plain Node (ELECTRON_RUN_AS_NODE) and loads this too.
//
// Node's fetch (undici), http(s).request and `ws` never look at the Windows
// system proxy (WinINET / PAC) or the Windows certificate store; they use
// Node's bundled root list only. On a company network that requires a proxy
// or inspects TLS with its own root (common in Korean enterprises), login
// session checks, billing, Agentlas serving, BYOK, the phone relay and npm
// installs failed with "fetch failed" / UNABLE_TO_GET_ISSUER_CERT_LOCALLY
// while the browser on the same PC worked.
//
// What this module does, once per process:
//   1. trust = Node's default roots + the OS store (tls.getCACertificates("system")).
//      Only additions: nothing Node trusted before is removed.
//   2. proxy = the user's explicit HTTPS_PROXY/HTTP_PROXY env, else the system
//      proxy the host resolved (Main: Chromium's resolver incl. PAC; daemon:
//      the WinINET registry value). Applied with Node's own
//      http.setGlobalProxyFromEnv, which covers fetch and http(s).globalAgent.
//      Loopback is always bypassed, so local models and local servers stay direct.
//   With no proxy configured the process is exactly as before (direct).

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";

export type SystemProxySource = "env" | "system" | "windows-registry";

export interface SystemProxyConfig {
  /** Proxy for https:// (and wss://) targets, as an http:// or https:// proxy URL. */
  readonly httpsProxy?: string;
  /** Proxy for http:// (and ws://) targets. */
  readonly httpProxy?: string;
  /** Comma-separated bypass list (hosts, .suffixes, host:port); loopback is always included. */
  readonly noProxy: string;
  readonly source: SystemProxySource;
  /** Short, credential-free notes for the startup log (e.g. "pac-split:2"). */
  readonly notes?: readonly string[];
}

export const LOOPBACK_NO_PROXY: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "::1"];

// ── Proxy text formats ──────────────────────────────────────────────────────

/** Remove user:password from a proxy URL before it is logged. */
export function redactProxyUrl(value: string | undefined): string {
  if (!value) return "none";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "invalid";
  }
}

function proxyUrlOrNull(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!url.hostname) return undefined;
    return withScheme.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/**
 * One entry of Chromium's resolveProxy answer ("PROXY host:80; DIRECT").
 * Returns the proxy URL for the first entry, null for DIRECT, and
 * "unsupported" for SOCKS/QUIC (Node's built-in proxy speaks HTTP CONNECT only).
 */
export function proxyUrlFromChromiumRules(rules: string): string | null | "unsupported" {
  const first = rules.split(";").map((part) => part.trim()).find(Boolean);
  if (!first) return null;
  const [scheme, target] = first.split(/\s+/, 2);
  const kind = scheme.toUpperCase();
  if (kind === "DIRECT") return null;
  if (!target) return "unsupported";
  if (kind === "PROXY" || kind === "HTTP") return proxyUrlOrNull(`http://${target}`) ?? "unsupported";
  if (kind === "HTTPS") return proxyUrlOrNull(`https://${target}`) ?? "unsupported";
  return "unsupported";
}

export interface WindowsInternetSettings {
  readonly proxyEnable: boolean;
  readonly proxyServer: string;
  readonly proxyOverride: string;
  readonly autoConfigUrl: string;
}

/** `reg query "HKCU\...\Internet Settings"` output → the four proxy values. */
export function parseWindowsInternetSettings(stdout: string): WindowsInternetSettings {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/);
    if (match) values.set(match[1].toLowerCase(), match[3].trim());
  }
  const enable = values.get("proxyenable") ?? "";
  return {
    proxyEnable: /^0x0*1$/i.test(enable) || enable === "1",
    proxyServer: values.get("proxyserver") ?? "",
    proxyOverride: values.get("proxyoverride") ?? "",
    autoConfigUrl: values.get("autoconfigurl") ?? "",
  };
}

/**
 * WinINET ProxyOverride ("<local>;*.corp.example;intranet") → NO_PROXY entries.
 * "<local>" (dotless names) is covered by the loopback entries for local
 * servers; wildcards inside a name ("10.*") cannot be expressed and are
 * counted instead of guessed.
 */
export function noProxyFromWindowsOverride(override: string): { entries: string[]; skipped: number } {
  const entries: string[] = [];
  let skipped = 0;
  for (const raw of override.split(/[;,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry || entry === "<local>") continue;
    const suffix = entry.replace(/^\*\./, ".");
    if (suffix.includes("*")) {
      skipped += 1;
      continue;
    }
    entries.push(suffix);
  }
  return { entries, skipped };
}

/** WinINET ProxyServer ("host:8080" or "http=h:80;https=h:443;socks=…") → proxy config. */
export function proxyConfigFromWindowsSettings(settings: WindowsInternetSettings): SystemProxyConfig | null {
  if (!settings.proxyEnable || !settings.proxyServer.trim()) return null;
  const server = settings.proxyServer.trim();
  let httpsProxy: string | undefined;
  let httpProxy: string | undefined;
  if (server.includes("=")) {
    const byScheme = new Map<string, string>();
    for (const part of server.split(";")) {
      const [scheme, value] = part.split("=", 2).map((text) => text?.trim() ?? "");
      if (scheme && value) byScheme.set(scheme.toLowerCase(), value);
    }
    httpsProxy = proxyUrlOrNull(byScheme.get("https") ?? byScheme.get("http"));
    httpProxy = proxyUrlOrNull(byScheme.get("http"));
  } else {
    httpsProxy = proxyUrlOrNull(server);
    httpProxy = httpsProxy;
  }
  if (!httpsProxy && !httpProxy) return null;
  const override = noProxyFromWindowsOverride(settings.proxyOverride);
  return {
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(httpProxy ? { httpProxy } : {}),
    noProxy: mergeNoProxy(override.entries),
    source: "windows-registry",
    ...(override.skipped ? { notes: [`override-wildcards-skipped:${override.skipped}`] } : {}),
  };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name.toLowerCase()]?.trim() || env[name.toUpperCase()]?.trim() || undefined;
}

/** The user's explicit proxy env (the convention every CLI follows), or null. */
export function proxyConfigFromEnv(env: NodeJS.ProcessEnv): SystemProxyConfig | null {
  const httpsProxy = proxyUrlOrNull(envValue(env, "https_proxy"));
  const httpProxy = proxyUrlOrNull(envValue(env, "http_proxy"));
  if (!httpsProxy && !httpProxy) return null;
  return {
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(httpProxy ? { httpProxy } : {}),
    noProxy: mergeNoProxy((envValue(env, "no_proxy") ?? "").split(/[,\s]+/)),
    source: "env",
  };
}

/** Loopback first, then the given entries, de-duplicated. */
export function mergeNoProxy(...lists: ReadonlyArray<readonly string[]>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...LOOPBACK_NO_PROXY, ...lists.flat()]) {
    const text = entry.trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out.join(",");
}

/**
 * The same bypass rule Node's fetch applies (undici EnvHttpProxyAgent):
 * exact host, or a subdomain of an entry; ".x" and "*.x" mean the suffix;
 * "host:port" only for that port; "*" bypasses everything.
 */
export function noProxyMatches(noProxy: string, hostname: string, port: number): boolean {
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(/[,\s]+/)) {
    if (!raw) continue;
    if (raw === "*") return true;
    const parsed = raw.match(/^(.+):(\d+)$/);
    const entryHost = (parsed && !raw.startsWith("::") ? parsed[1] : raw).replace(/^\*?\./, "").toLowerCase();
    const entryPort = parsed && !raw.startsWith("::") ? Number.parseInt(parsed[2], 10) : 0;
    if (entryPort && entryPort !== port) continue;
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

// ── Process-wide state ──────────────────────────────────────────────────────

let activeProxy: SystemProxyConfig | null = null;
let restoreProxy: (() => void) | null = null;
let proxyResolutionReady = false;
let proxyConfiguredForHost = false;

type SetGlobalProxyFromEnv = (env: Record<string, string>) => () => void;

/** Node 24.5+ (Electron 43) has it; older Node keeps today's direct behaviour. */
export function nodeSupportsGlobalProxy(): boolean {
  return typeof (http as unknown as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === "function";
}

function proxyConfigKey(config: SystemProxyConfig | null): string {
  return config ? JSON.stringify([config.httpsProxy ?? "", config.httpProxy ?? "", config.noProxy]) : "";
}

/**
 * Make `config` the process proxy for fetch and http(s).globalAgent, replacing
 * the previous one; null returns to direct connections. Returns whether the
 * process state changed.
 */
export function applySystemProxy(config: SystemProxyConfig | null): boolean {
  proxyResolutionReady = true;
  proxyConfiguredForHost = config !== null;
  if (proxyConfigKey(config) === proxyConfigKey(activeProxy)) {
    activeProxy = config;
    return false;
  }
  if (restoreProxy) {
    try { restoreProxy(); } catch { /* the previous dispatcher is replaced below either way */ }
    restoreProxy = null;
  }
  activeProxy = null;
  if (!config || !nodeSupportsGlobalProxy()) return true;
  const setGlobalProxyFromEnv = (http as unknown as { setGlobalProxyFromEnv: SetGlobalProxyFromEnv }).setGlobalProxyFromEnv;
  restoreProxy = setGlobalProxyFromEnv({
    ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy } : {}),
    ...(config.httpProxy ? { HTTP_PROXY: config.httpProxy } : {}),
    NO_PROXY: config.noProxy,
  });
  activeProxy = config;
  return true;
}

export function activeSystemProxy(): SystemProxyConfig | null {
  return activeProxy;
}

/** Automatic OS trust may include ordinary public roots; only explicit custom bundles gate gzip. */
export function requestCompressionNetworkState(): import("../../shared/http-request-compression").RequestCompressionNetworkState {
  return {
    ready: proxyResolutionReady,
    proxyConfigured: proxyConfiguredForHost,
    additionalCaCertificates: Boolean(process.env.NODE_EXTRA_CA_CERTS?.trim() || process.env.SSL_CERT_FILE?.trim() || process.env.SSL_CERT_DIR?.trim()),
  };
}

/**
 * `ws` builds its own TLS connection and ignores the global proxy unless an
 * agent is passed. Returns the proxying global agent for a ws:// or wss:// URL
 * that must go through the active proxy, else undefined (direct, as before).
 */
export function webSocketAgentFor(target: string): http.Agent | undefined {
  const config = activeProxy;
  if (!config) return undefined;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  if (secure ? !config.httpsProxy : !config.httpProxy) return undefined;
  const hostname = url.host.replace(/:\d*$/, "");
  const port = Number.parseInt(url.port, 10) || (secure ? 443 : 80);
  if (noProxyMatches(config.noProxy, hostname, port)) return undefined;
  return secure ? https.globalAgent : http.globalAgent;
}

/**
 * Env for a child process that should use the same proxy (engine Python, npm):
 * empty when no proxy is active, so the child's own behaviour is unchanged.
 * The user's own NO_PROXY entries are kept; loopback is always bypassed
 * (Windows urllib's "<local>" does not cover 127.0.0.1).
 */
export function systemNetworkChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const config = activeProxy;
  if (!config) return {};
  const noProxy = mergeNoProxy(config.noProxy.split(","), (envValue(baseEnv, "no_proxy") ?? "").split(/[,\s]+/));
  return {
    ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, https_proxy: config.httpsProxy } : {}),
    ...(config.httpProxy ? { HTTP_PROXY: config.httpProxy, http_proxy: config.httpProxy } : {}),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

// ── Trust store ─────────────────────────────────────────────────────────────

type CertificateList = () => string[];

function nodeCertificates(kind: "default" | "system"): string[] {
  const get = (tls as unknown as { getCACertificates?: (kind: string) => string[] }).getCACertificates;
  if (typeof get !== "function") return [];
  try {
    return get(kind);
  } catch {
    return [];
  }
}

function certificateKey(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, "");
}

/** OS-store roots that Node's default list does not already have. */
export function systemOnlyCertificates(systemCertificates: CertificateList = () => nodeCertificates("system")): string[] {
  const known = new Set(nodeCertificates("default").map(certificateKey));
  const out: string[] = [];
  for (const pem of systemCertificates()) {
    const key = certificateKey(pem);
    if (!key || known.has(key)) continue;
    known.add(key);
    out.push(pem.trim());
  }
  return out;
}

let certificatesInstalled: { added: number } | null = null;

/**
 * Trust Node's default roots plus the OS store for every later TLS connection
 * in this process (fetch, https, ws). Idempotent. Returns how many roots were
 * added; 0 when the OS store adds nothing or Node lacks the API.
 */
export function installSystemCertificates(systemCertificates?: CertificateList): { added: number; supported: boolean } {
  const setDefault = (tls as unknown as { setDefaultCACertificates?: (certs: string[]) => void }).setDefaultCACertificates;
  if (typeof setDefault !== "function" || typeof (tls as unknown as { getCACertificates?: unknown }).getCACertificates !== "function") {
    return { added: 0, supported: false };
  }
  if (certificatesInstalled) return { added: certificatesInstalled.added, supported: true };
  const extra = systemOnlyCertificates(systemCertificates);
  if (extra.length) setDefault([...nodeCertificates("default"), ...extra]);
  certificatesInstalled = { added: extra.length };
  return { added: extra.length, supported: true };
}

/**
 * Write the OS-only roots (plus an existing NODE_EXTRA_CA_CERTS file's roots)
 * to `file` for a child Node process (npm), which reads NODE_EXTRA_CA_CERTS at
 * start-up. Returns the file path, or null when there is nothing to add.
 */
export function writeChildExtraCaBundle(file: string, baseEnv: NodeJS.ProcessEnv = process.env, systemCertificates?: CertificateList): string | null {
  const extra = systemOnlyCertificates(systemCertificates);
  if (!extra.length) return null;
  let existing = "";
  const userBundle = baseEnv.NODE_EXTRA_CA_CERTS?.trim();
  if (userBundle && path.resolve(userBundle) !== path.resolve(file)) {
    try {
      existing = fs.readFileSync(userBundle, "utf8").trim();
    } catch {
      existing = "";
    }
  }
  const content = `${[existing, ...extra].filter(Boolean).join("\n")}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let current = "";
  try { current = fs.readFileSync(file, "utf8"); } catch { current = ""; }
  if (current !== content) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return file;
}

// ── Non-Electron hosts (daemon) ─────────────────────────────────────────────

export type RegistryReader = () => Promise<string | null>;

/** `reg query` of the current user's Internet Settings, or null when unavailable. */
export function readWindowsInternetSettingsText(): Promise<string | null> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFile } = require("node:child_process") as typeof import("node:child_process");
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    execFile(
      path.win32.join(systemRoot, "System32", "reg.exe"),
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
      { windowsHide: true, timeout: 3_000, encoding: "latin1", maxBuffer: 256 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });
}

export interface NodeHostSystemNetworkOptions {
  readonly host: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly readRegistry?: RegistryReader;
  readonly log?: (line: string) => void;
}

/**
 * Daemon/plain-Node hosts: OS trust store now; proxy from the user's env,
 * else (Windows) the WinINET registry value. A PAC-only setup cannot be
 * evaluated without Chromium and is logged, not guessed.
 */
export async function installNodeHostSystemNetwork(options: NodeHostSystemNetworkOptions): Promise<SystemProxyConfig | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const log = options.log ?? ((line: string) => console.info(line));
  const certificates = installSystemCertificates();
  let config = proxyConfigFromEnv(env);
  const notes: string[] = [];
  if (!config && platform === "win32") {
    const text = await (options.readRegistry ?? readWindowsInternetSettingsText)().catch(() => null);
    if (text) {
      const settings = parseWindowsInternetSettings(text);
      config = proxyConfigFromWindowsSettings(settings);
      if (!config && settings.autoConfigUrl) notes.push("pac-not-evaluated");
    }
  }
  applySystemProxy(config);
  log(systemNetworkStatusLine(options.host, certificates, config, notes));
  return config;
}

export function systemNetworkStatusLine(
  host: string,
  certificates: { added: number; supported: boolean },
  config: SystemProxyConfig | null,
  notes: readonly string[] = [],
): string {
  const allNotes = [...(config?.notes ?? []), ...notes, ...(config && !nodeSupportsGlobalProxy() ? ["node-proxy-unsupported"] : [])];
  return `[system-network] host=${host} ca=${certificates.supported ? `+${certificates.added}` : "unsupported"}`
    + ` proxy=${config ? `${redactProxyUrl(config.httpsProxy ?? config.httpProxy)} source=${config.source}` : "direct"}`
    + `${config ? ` bypass=${config.noProxy.split(",").length}` : ""}${allNotes.length ? ` notes=${allNotes.join(",")}` : ""}`;
}
