import fs from "node:fs";
import { createHash } from "node:crypto";
import type { InstalledMcpServer } from "../../shared/types";

/** Opaque Main-only admission. File contents or renderer objects cannot mint it. */
export interface PreparedMcpBinding { readonly configKey: string; readonly server: InstalledMcpServer }
export type PreparedMcpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; runtimeRoot: string | null }
  | { kind: "http" | "sse"; url: string; headers: Record<string, string>; runtimeRoot: null };
type Seal = { path: string; digest: string; current: () => boolean; invalid?: boolean; bindings: PreparedMcpBinding[] };
const seals = new Map<string, Seal>();
const bindings = new WeakMap<PreparedMcpBinding, { seal: Seal; transport: PreparedMcpTransport }>();
function fileDigest(path: string): string {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("mcp_prepared_config_invalid");
    return createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
  } finally { fs.closeSync(fd); }
}
export function mcpServerConfigurationDigest(server: InstalledMcpServer): string {
  return createHash("sha256").update(JSON.stringify([server.id, server.catalogId, server.transport,
    server.command, server.args, server.url, server.envKeys, server.enabled, server.configurationValid])).digest("hex");
}
function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.values(value).some((item) => typeof item !== "string")) throw new Error("mcp_prepared_transport_invalid");
  return { ...value as Record<string, string> };
}
/** Called only by the Main config builder after its private file is written. */
export function registerPreparedMcpConfig(input: {
  path: string; servers: Array<{ configKey: string; server: InstalledMcpServer; transport: unknown; runtimeRoot?: string | null }>;
  runtimeEnv: Record<string, string>; isCurrent: () => boolean;
}): void {
  const resolve = (value: string) => value.replace(/\$\{(AGENTLAS_MCP_SECRET_[A-Za-z0-9_]+)\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(input.runtimeEnv, key)) throw new Error("mcp_prepared_secret_unavailable");
    return input.runtimeEnv[key];
  });
  const seal: Seal = { path: input.path, digest: fileDigest(input.path), current: input.isCurrent, bindings: [] };
  for (const row of input.servers) {
    const spec = row.transport as Record<string, unknown>;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("mcp_prepared_transport_invalid");
    let transport: PreparedMcpTransport;
    if (typeof spec.command === "string" && Array.isArray(spec.args) && spec.args.every((arg) => typeof arg === "string")) {
      const env = stringRecord(spec.env ?? {});
      for (const key of Object.keys(env)) if (key.startsWith("AGENTLAS_MCP_SECRET_")) env[key] = resolve(env[key]);
      // proxy-child overlays target.env over its inherited environment. Resolve
      // the Main-generated target's aliases structurally too; textual JSON
      // substitution would corrupt credentials containing quotes/backslashes.
      if (env.AGENTLAS_MCP_PROXY_TARGET) {
        const target = JSON.parse(env.AGENTLAS_MCP_PROXY_TARGET) as Record<string, unknown>;
        if (!target || typeof target !== "object" || Array.isArray(target)
          || typeof target.command !== "string" || !Array.isArray(target.args)
          || target.args.some((arg) => typeof arg !== "string")) throw new Error("mcp_prepared_transport_invalid");
        const targetEnv = stringRecord(target.env ?? {});
        for (const key of Object.keys(targetEnv)) if (key.startsWith("AGENTLAS_MCP_SECRET_")) targetEnv[key] = resolve(targetEnv[key]);
        env.AGENTLAS_MCP_PROXY_TARGET = JSON.stringify({ ...target, env: targetEnv });
      }
      transport = { kind: "stdio", command: spec.command, args: [...spec.args] as string[], env, runtimeRoot: row.runtimeRoot ?? null };
    } else if ((spec.type === "http" || spec.type === "sse") && typeof spec.url === "string") {
      const headers = stringRecord(spec.headers ?? {});
      for (const key of Object.keys(headers)) headers[key] = resolve(headers[key]);
      transport = { kind: spec.type, url: resolve(spec.url), headers, runtimeRoot: null };
    } else throw new Error("mcp_prepared_transport_invalid");
    const server = Object.freeze({ ...row.server, args: Object.freeze([...row.server.args]) as unknown as string[], envKeys: Object.freeze([...row.server.envKeys]) as unknown as string[] });
    const binding = Object.freeze({ configKey: row.configKey, server });
    bindings.set(binding, { seal, transport }); seal.bindings.push(binding);
  }
  if (!seal.current()) throw new Error("mcp_prepared_scope_changed");
  seals.set(input.path, seal);
  // Eviction fails closed for an old handle; it never falls back to registry.
  while (seals.size > 256) seals.delete(seals.keys().next().value!);
}
function validate(seal: Seal): void {
  try {
    if (seal.invalid || seals.get(seal.path) !== seal || !seal.current() || fileDigest(seal.path) !== seal.digest) throw new Error("mcp_prepared_scope_changed");
  } catch { seal.invalid = true; throw new Error("mcp_prepared_scope_changed"); }
}
export function preparedMcpBindings(path: string): PreparedMcpBinding[] {
  const seal = seals.get(path);
  if (!seal) throw new Error("mcp_prepared_config_unapproved");
  validate(seal); return [...seal.bindings];
}
export function preparedMcpTransport(binding: PreparedMcpBinding, server: InstalledMcpServer): PreparedMcpTransport {
  const row = bindings.get(binding);
  if (!row || binding.server !== server) throw new Error("mcp_prepared_binding_unapproved");
  validate(row.seal);
  return row.transport.kind === "stdio" ? { ...row.transport, args: [...row.transport.args], env: { ...row.transport.env } }
    : { ...row.transport, headers: { ...row.transport.headers } };
}
