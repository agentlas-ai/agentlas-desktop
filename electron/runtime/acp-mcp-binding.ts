// The MCP servers an ACP turn binds, made self-contained, and the resident-process identity they imply.
//
// Main's MCP config (mcp-config.ts) carries per-invocation secrets as opaque aliases: a stdio entry names
// `AGENTLAS_MCP_SECRET_<32 hex>` in its env with the value `${AGENTLAS_MCP_SECRET_<32 hex>}`, a remote entry puts
// `Bearer ${…}` in a header or `${…}` as its url, and Main merges the alias values into the runner env. Claude Code
// expands those references from its own env; ACP agents do not. Measured 2026-10-16 with the installed Grok Build
// 1.0.51 and Kimi Code 0.28.0 (a fake stdio MCP server logging its env): an ACP `mcpServers` env pair
// `NAME="${NAME}"` reaches the server as the literal text `${NAME}`, even when the agent's own env holds NAME. So every
// keyed MCP server on an ACP lane received a placeholder instead of its credential, and the per-run alias values had to
// live in the agent process env, which put them into the resident-pool key (a new process every turn).
//
// Here the references are resolved inline from the turn's env (the same structural resolution prepared-transport.ts
// applies to native task browser configs), the alias names leave the agent's spawn env, and the turn's table gets two
// digests: the grant (server names) and the table (resolved content). A process that can rebind its servers in place
// is keyed on the grant and rebound each reused turn; any other is keyed on the table, so it is reused only when the
// table is byte-identical (no per-invocation handle).
import { createHash } from "node:crypto";

/** mcp-config.ts mcpRuntimeSecretAlias: an opaque per-server name whose value is a vault secret or a per-run capability. */
export const ACP_MCP_SECRET_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;
const REFERENCE_RE = /\$\{(AGENTLAS_MCP_SECRET_[A-F0-9]{32})\}/g;

export interface AcpResolvedMcpConfig {
  config: { mcpServers: Record<string, unknown> } | null;
  /** Sorted server names; "" without a config. */
  grant: string;
  /** Resolved content digest; "" without a config. */
  table: string;
  /** Entries that referenced an alias the turn's env did not carry: dropped (fail closed), names only. */
  dropped: string[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Resolve every `${AGENTLAS_MCP_SECRET_…}` reference in Main's MCP config from `env`: stdio env values (and the env of
 * a proxied target inside AGENTLAS_MCP_PROXY_TARGET, parsed structurally), remote headers and url. An entry whose
 * reference has no value is dropped instead of handing the server a placeholder. Other text is never touched.
 */
export function resolveAcpMcpConfig(config: unknown, env: NodeJS.ProcessEnv): AcpResolvedMcpConfig {
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { config: null, grant: "", table: "", dropped: [] };
  const dropped: string[] = [];
  const resolve = (value: string): string | null => {
    let missing = false;
    const out = value.replace(REFERENCE_RE, (_match, alias: string) => {
      const actual = env[alias];
      if (typeof actual !== "string" || actual.length === 0) { missing = true; return ""; }
      return actual;
    });
    return missing ? null : out;
  };
  const resolveRecord = (value: unknown): Record<string, unknown> | null => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw !== "string") { out[key] = raw; continue; }
      const resolved = resolve(raw);
      if (resolved === null) return null;
      out[key] = resolved;
    }
    return out;
  };
  const resolved: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { resolved[name] = raw; continue; }
    const entry = { ...(raw as Record<string, unknown>) };
    if (entry.env !== undefined) {
      const env = resolveRecord(entry.env);
      if (!env) { dropped.push(name); continue; }
      const target = env.AGENTLAS_MCP_PROXY_TARGET;
      if (typeof target === "string") {
        try {
          const parsed = JSON.parse(target) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.env !== undefined) {
            const targetEnv = resolveRecord(parsed.env);
            if (!targetEnv) { dropped.push(name); continue; }
            env.AGENTLAS_MCP_PROXY_TARGET = JSON.stringify({ ...parsed, env: targetEnv });
          }
        } catch { /* not JSON: the proxy refuses it itself; nothing to resolve */ }
      }
      entry.env = env;
    }
    if (entry.headers !== undefined) {
      const headers = resolveRecord(entry.headers);
      if (!headers) { dropped.push(name); continue; }
      entry.headers = headers;
    }
    if (typeof entry.url === "string") {
      const url = resolve(entry.url);
      if (url === null) { dropped.push(name); continue; }
      entry.url = url;
    }
    resolved[name] = entry;
  }
  const names = Object.keys(resolved).sort();
  return {
    config: { mcpServers: resolved },
    grant: createHash("sha256").update("acp-mcp-grant-v1\0").update(JSON.stringify(names)).digest("hex"),
    table: createHash("sha256").update("acp-mcp-table-v1\0").update(stableJson(resolved)).digest("hex"),
    dropped: dropped.sort(),
  };
}

/**
 * The agent process env without the MCP secret aliases. No ACP agent reads them: the servers that need them get the
 * resolved values inline (resolveAcpMcpConfig), and proxied servers get theirs from Main's launch handle. Keeping them
 * would also hand every per-run capability to the agent's own shell tools for the life of a resident process.
 */
export function acpSpawnEnvWithoutMcpSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!ACP_MCP_SECRET_ALIAS_RE.test(name)) out[name] = value;
  return out;
}
