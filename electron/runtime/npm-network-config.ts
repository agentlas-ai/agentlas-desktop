// Network transport settings the managed npm keeps from the user's own npm
// setup. The managed install pins the registry, cache, prefix and config files
// (install-cli.ts) and therefore dropped every npm_config_* variable and the
// user's .npmrc — including the proxy and CA file a company network needs.
// kimi has no Windows native build and installs only through npm, so on a
// proxy-only Windows PC it could never be connected.
//
// Kept: how npm reaches the network (proxy, https-proxy, noproxy, cafile).
// Never kept: registry, auth tokens, scripts, strict-ssl=false, or anything
// else — the managed install stays on the official registry with TLS checks.

export const NPM_TRANSPORT_KEYS = ["proxy", "https-proxy", "noproxy", "cafile"] as const;
export type NpmTransportKey = (typeof NPM_TRANSPORT_KEYS)[number];
export type NpmTransportSettings = Partial<Record<NpmTransportKey, string>>;

const KEY_SET = new Set<string>(NPM_TRANSPORT_KEYS);

function normalizeKey(raw: string): NpmTransportKey | null {
  const key = raw.trim().toLowerCase().replace(/_/g, "-");
  return KEY_SET.has(key) ? (key as NpmTransportKey) : null;
}

function cleanValue(raw: string): string | null {
  let value = raw.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  // A literal newline/NUL can never be a proxy URL or a path; refuse it rather
  // than write it into the managed npmrc where it would start a new key.
  if (!value || /[\r\n\0]/.test(value) || value === "null" || value === "false") return null;
  return value;
}

/** Transport keys from .npmrc text (ini: `key=value`, `;`/`#` comments, sections ignored). */
export function npmTransportFromNpmrc(text: string): NpmTransportSettings {
  const out: NpmTransportSettings = {};
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inSection = true;
      continue;
    }
    if (inSection) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const key = normalizeKey(trimmed.slice(0, at));
    if (!key) continue;
    const value = cleanValue(trimmed.slice(at + 1));
    if (value) out[key] = value;
  }
  return out;
}

/** Transport keys from npm_config_* env (any case; npm reads both _ and -). */
export function npmTransportFromEnv(env: NodeJS.ProcessEnv): NpmTransportSettings {
  const out: NpmTransportSettings = {};
  for (const [name, raw] of Object.entries(env)) {
    const lower = name.toLowerCase();
    if (!lower.startsWith("npm_config_") || raw === undefined) continue;
    const key = normalizeKey(lower.slice("npm_config_".length));
    if (!key) continue;
    const value = cleanValue(raw);
    if (value) out[key] = value;
  }
  return out;
}

/** ini lines for the managed npmrc, in a fixed order so the file is stable. */
export function npmTransportNpmrcLines(settings: NpmTransportSettings): string {
  return NPM_TRANSPORT_KEYS
    .filter((key) => settings[key])
    .map((key) => `${key}=${settings[key]}\n`)
    .join("");
}

/** NPM_CONFIG_* env overrides for one managed npm run. */
export function npmTransportEnv(settings: NpmTransportSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of NPM_TRANSPORT_KEYS) {
    const value = settings[key];
    if (value) out[`NPM_CONFIG_${key.toUpperCase().replace(/-/g, "_")}`] = value;
  }
  return out;
}

/**
 * The system proxy (system-network-core child env) fills only what the user
 * did not set for npm: an explicit npm proxy setting always wins.
 */
export function npmTransportWithSystemProxy(
  settings: NpmTransportSettings,
  systemEnv: Readonly<Record<string, string>>,
): NpmTransportSettings {
  const out: NpmTransportSettings = { ...settings };
  if (!out["https-proxy"] && systemEnv.HTTPS_PROXY) out["https-proxy"] = systemEnv.HTTPS_PROXY;
  if (!out.proxy && systemEnv.HTTP_PROXY) out.proxy = systemEnv.HTTP_PROXY;
  if (!out.noproxy && systemEnv.NO_PROXY) out.noproxy = systemEnv.NO_PROXY;
  return out;
}
