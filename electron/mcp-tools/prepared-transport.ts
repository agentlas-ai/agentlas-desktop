import fs from "node:fs";
import { createHash } from "node:crypto";
import type { InstalledMcpServer } from "../../shared/types";
import { mainToolConsentDigest } from "../runtime/tool-consent";
import type { McpConfigBuildOptions } from "./mcp-config";
import type { RuntimeToolPermissionAsk } from "../runtime/tool-approval";
import { ownedStdioEnvironment } from "./owned-stdio-transport";

/** Opaque Main-only admission. File contents or renderer objects cannot mint it. */
export interface PreparedMcpBinding { readonly configKey: string; readonly server: InstalledMcpServer }
/** Actual canonical approval scope captured from a Main-prepared proxy launch.
 * It grants no builtin file/shell authority to the raw runner request. */
export interface PreparedMcpProxyScope {
  readonly runtime: string; readonly sessionKey: string;
  readonly permission?: RuntimeToolPermissionAsk["permission"];
  readonly cwd: string; readonly cwdDev: number; readonly cwdIno: number;
  readonly chatId?: string; readonly planMode: boolean; readonly unattended: boolean;
}
export function preparedMcpProxyScopeMatchesAsk(scope: PreparedMcpProxyScope, ask: RuntimeToolPermissionAsk): boolean {
  return ask.runtime === scope.runtime && ask.sessionKey === scope.sessionKey && ask.cwd === scope.cwd
    && ask.permission === scope.permission && ask.chatId === scope.chatId
    && Boolean(ask.planMode) === scope.planMode && Boolean(ask.unattended) === scope.unattended;
}
/** Native-host delegation metadata. A pathname or renderer object cannot export
 * this: the sending host must own a current, opaque prepared seal. Credentials
 * stay in native RPC memory; the receiving config retains the original aliases. */
export interface PreparedMcpAdmission {
  schema: "agentlas.prepared-mcp-admission.v1";
  sourcePath: string;
  sourceDigest: string;
  proxyScope?: PreparedMcpProxyScope;
  buildOptions: Omit<McpConfigBuildOptions, "admissionCurrent">;
  servers: Array<{ configKey: string; serverId: string; configurationDigest: string }>;
}
export type PreparedMcpTransport =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; runtimeRoot: string | null }
  | { kind: "http" | "sse"; url: string; headers: Record<string, string>; runtimeRoot: null };
type Seal = { path: string; digest: string; current: () => boolean; invalid?: boolean; bindings: PreparedMcpBinding[];
  environmentChecks: Map<string, string>;
  buildOptions?: Omit<McpConfigBuildOptions, "admissionCurrent"> };
const seals = new Map<string, Seal>();
const bindings = new WeakMap<PreparedMcpBinding, { seal: Seal; transport: PreparedMcpTransport; targetTransport: PreparedMcpTransport; consentResource: string; proxyScope?: PreparedMcpProxyScope }>();
const proxyAsks = new WeakMap<object, { binding: PreparedMcpBinding; scope: PreparedMcpProxyScope }>();
export class PreparedMcpScopeChangedError extends Error {
  readonly code = "mcp_prepared_scope_changed";
  constructor() { super("mcp_prepared_scope_changed"); }
}
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
  path: string; servers: Array<{ configKey: string; server: InstalledMcpServer; transport: unknown; runtimeRoot?: string | null;
    /** Main's actual target before its per-run approval proxy is added. */
    consentTransport?: unknown; proxyScope?: PreparedMcpProxyScope }>;
  runtimeEnv: Record<string, string>; isCurrent: () => boolean;
  /** Only the stock native config builder supplies reconstruction intent. */
  buildOptions?: Omit<McpConfigBuildOptions, "admissionCurrent">;
}): () => boolean {
  const resolve = (value: string) => value.replace(/\$\{(AGENTLAS_MCP_SECRET_[A-Za-z0-9_]+)\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(input.runtimeEnv, key)) throw new Error("mcp_prepared_secret_unavailable");
    return input.runtimeEnv[key];
  });
  const seal: Seal = { path: input.path, digest: fileDigest(input.path), current: input.isCurrent, bindings: [], environmentChecks: new Map(),
    ...(input.buildOptions ? { buildOptions: structuredClone(input.buildOptions) } : {}) };
  const resolveTransport = (value: unknown, runtimeRoot: string | null): PreparedMcpTransport => {
    const spec = value as Record<string, unknown>;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("mcp_prepared_transport_invalid");
    let transport: PreparedMcpTransport;
    if (typeof spec.command === "string" && Array.isArray(spec.args) && spec.args.every((arg) => typeof arg === "string")) {
      let env = stringRecord(spec.env ?? {});
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
      // Freeze operational defaults before authority capture, and refuse a
      // changed host context rather than silently adding new temp/auth env.
      const command = spec.command;
      if (!seal.environmentChecks.has(command)) {
        seal.environmentChecks.set(command, mainToolConsentDigest(ownedStdioEnvironment(command)));
      }
      env = ownedStdioEnvironment(command, env);
      transport = { kind: "stdio", command: spec.command, args: [...spec.args] as string[], env, runtimeRoot };
    } else if ((spec.type === "http" || spec.type === "sse") && typeof spec.url === "string") {
      const headers = stringRecord(spec.headers ?? {});
      for (const key of Object.keys(headers)) headers[key] = resolve(headers[key]);
      transport = { kind: spec.type, url: resolve(spec.url), headers, runtimeRoot: null };
    } else throw new Error("mcp_prepared_transport_invalid");
    return transport;
  };
  for (const row of input.servers) {
    const transport = resolveTransport(row.transport, row.runtimeRoot ?? null);
    const targetTransport = row.consentTransport === undefined ? transport : resolveTransport(row.consentTransport, row.runtimeRoot ?? null);
    const consentResource = mainToolConsentDigest({ configKey: row.configKey,
      configuration: mcpServerConfigurationDigest(row.server), transport: targetTransport });
    const server = Object.freeze({ ...row.server, args: Object.freeze([...row.server.args]) as unknown as string[], envKeys: Object.freeze([...row.server.envKeys]) as unknown as string[] });
    const binding = Object.freeze({ configKey: row.configKey, server });
    const proxyScope = row.proxyScope ? Object.freeze({ ...row.proxyScope }) : undefined;
    bindings.set(binding, { seal, transport, targetTransport, consentResource, proxyScope }); seal.bindings.push(binding);
  }
  if (!seal.current()) throw new PreparedMcpScopeChangedError();
  seals.set(input.path, seal);
  // Eviction fails closed for an old handle; it never falls back to registry.
  while (seals.size > 256) seals.delete(seals.keys().next().value!);
  // Capture the actual seal, not just its pathname. A late cleanup must never
  // revoke a replacement preparation or remove a file changed by another owner.
  return () => {
    seal.invalid = true;
    if (seals.get(input.path) !== seal) return false;
    seals.delete(input.path);
    try { return fileDigest(input.path) === seal.digest; } catch { return false; }
  };
}
function validate(seal: Seal): void {
  try {
    if (seal.invalid || seals.get(seal.path) !== seal || !seal.current()
      || ![...seal.environmentChecks].every(([command, digest]) => mainToolConsentDigest(ownedStdioEnvironment(command)) === digest)
      || fileDigest(seal.path) !== seal.digest) throw new PreparedMcpScopeChangedError();
    for (const binding of seal.bindings) {
      const scope = bindings.get(binding)?.proxyScope;
      if (!scope) continue;
      const stat = fs.statSync(scope.cwd);
      if (fs.realpathSync(scope.cwd) !== scope.cwd || !stat.isDirectory()
        || stat.dev !== scope.cwdDev || stat.ino !== scope.cwdIno) throw new PreparedMcpScopeChangedError();
      fs.accessSync(scope.cwd, fs.constants.R_OK | fs.constants.X_OK);
    }
  } catch { seal.invalid = true; throw new PreparedMcpScopeChangedError(); }
}
export function preparedMcpBindings(path: string): PreparedMcpBinding[] {
  const seal = seals.get(path);
  if (!seal) throw new Error("mcp_prepared_config_unapproved");
  validate(seal); return [...seal.bindings];
}
/** Never reconstruct a grant from JSON. Only an already admitted native host
 * can delegate its exact selection to another installation/epoch-fenced host. */
export function exportPreparedMcpAdmission(path: string): PreparedMcpAdmission {
  const admitted = preparedMcpBindings(path);
  const seal = seals.get(path)!;
  if (!seal.buildOptions) throw new Error("local_model_remote_mcp_admission_required");
  const proxyScope = preparedMcpProxyScope(path);
  return { schema: "agentlas.prepared-mcp-admission.v1", sourcePath: path, sourceDigest: seal.digest,
    ...(proxyScope ? { proxyScope: { ...proxyScope } } : {}),
    buildOptions: structuredClone(seal.buildOptions),
    servers: admitted.map(binding => {
      return { configKey: binding.configKey, serverId: binding.server.id,
        configurationDigest: mcpServerConfigurationDigest(binding.server) };
    }) };
}
/** Return the current opaque scope object; replacement preparations have a new
 * identity even when their serialized policy happens to match. */
export function preparedMcpProxyScope(path: string): PreparedMcpProxyScope | undefined {
  const scopes = preparedMcpBindings(path).map(binding => bindings.get(binding)?.proxyScope).filter(
    (scope): scope is PreparedMcpProxyScope => Boolean(scope));
  const first = scopes[0];
  if (first && scopes.some(scope => mainToolConsentDigest(scope) !== mainToolConsentDigest(first))) {
    throw new PreparedMcpScopeChangedError();
  }
  return first;
}
/** Only an actual prepared proxy binds provenance to this exact ask object.
 * JSON fields, copied asks and session IDs cannot select the proxy family. */
export function bindPreparedMcpProxyAsk(ask: RuntimeToolPermissionAsk, binding: PreparedMcpBinding): void {
  const row = bindings.get(binding);
  if (!row?.proxyScope) throw new Error("mcp_prepared_proxy_scope_unapproved");
  validate(row.seal);
  if (!preparedMcpProxyScopeMatchesAsk(row.proxyScope, ask)) throw new PreparedMcpScopeChangedError();
  proxyAsks.set(ask, { binding, scope: row.proxyScope });
}
export function preparedMcpProxyAskScope(ask: RuntimeToolPermissionAsk): PreparedMcpProxyScope | undefined {
  const provenance = proxyAsks.get(ask);
  if (!provenance) return undefined;
  const row = bindings.get(provenance.binding);
  if (!row || row.proxyScope !== provenance.scope) throw new PreparedMcpScopeChangedError();
  validate(row.seal);
  if (!preparedMcpProxyScopeMatchesAsk(provenance.scope, ask)) throw new PreparedMcpScopeChangedError();
  // Each server has a binding, while one native run registers its shared scope.
  return preparedMcpProxyScope(row.seal.path);
}
export function preparedMcpTransport(binding: PreparedMcpBinding, server: InstalledMcpServer): PreparedMcpTransport {
  const row = bindings.get(binding);
  if (!row || binding.server !== server) throw new Error("mcp_prepared_binding_unapproved");
  validate(row.seal);
  return row.transport.kind === "stdio" ? { ...row.transport, args: [...row.transport.args], env: { ...row.transport.env } }
    : { ...row.transport, headers: { ...row.transport.headers } };
}

/** Sealed target/credential identity, independent of the approval session ID. */
export function preparedMcpConsentResource(binding: PreparedMcpBinding, server: InstalledMcpServer): string {
  const row = bindings.get(binding);
  if (!row || binding.server !== server) throw new Error("mcp_prepared_binding_unapproved");
  validate(row.seal);
  return row.consentResource;
}

/** Main-only actual upstream; the same opaque binding/seal fences proxy recursion. */
export function preparedMcpTargetTransport(binding: PreparedMcpBinding, server: InstalledMcpServer): PreparedMcpTransport {
  const row = bindings.get(binding);
  if (!row || binding.server !== server) throw new Error("mcp_prepared_binding_unapproved");
  validate(row.seal);
  return row.targetTransport.kind === "stdio"
    ? { ...row.targetTransport, args: [...row.targetTransport.args], env: { ...row.targetTransport.env } }
    : { ...row.targetTransport, headers: { ...row.targetTransport.headers } };
}
