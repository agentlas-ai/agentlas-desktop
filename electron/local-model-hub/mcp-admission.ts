import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { userDataPath } from "../runtime-paths";
import { mainToolConsentDigest } from "../runtime/tool-consent";
import { listInstalledServers } from "../mcp-tools/registry";
import { buildMcpConfigFile, type McpConfigBuildOptions } from "../mcp-tools/mcp-config";
import { mcpServerConfigurationDigest, preparedMcpBindings, preparedMcpProxyScope,
  type PreparedMcpAdmission } from "../mcp-tools/prepared-transport";

function refused(): never { throw Object.assign(new Error("local_model_remote_mcp_admission_invalid"), { code: "local_model_remote_mcp_admission_invalid" }); }

/** Receiving native host only, after service identity + boot admission. The
 * sender's opaque seal exports intent, never a transport to trust or a seal to
 * JSON-clone. This host builds the exact selection through the stock builder,
 * which creates its own approval proxies, credential bindings and opaque seal. */
export async function admitRemoteLocalMcp(input: PreparedMcpAdmission,
  assertOwner: () => void): Promise<{ configPath: string; runtimeEnv: Record<string, string>; proxyScope: ReturnType<typeof preparedMcpProxyScope>; cleanup(): void }> {
  const root = userDataPath("mcp");
  if (!input || input.schema !== "agentlas.prepared-mcp-admission.v1" || typeof input.sourcePath !== "string"
    || path.dirname(input.sourcePath) !== root || !/^[0-9a-f]{64}$/.test(input.sourceDigest)
    || !input.buildOptions || typeof input.buildOptions !== "object" || Array.isArray(input.buildOptions)
    || Object.prototype.hasOwnProperty.call(input.buildOptions, "admissionCurrent")
    || !Array.isArray(input.servers) || input.servers.length === 0 || input.servers.length > 256) refused();
  const installed = () => new Map(listInstalledServers().map(server => [server.id, server]));
  const expected = new Map<string, string>();
  const keys = new Set<string>();
  for (const row of input.servers) {
    if (!row || typeof row.configKey !== "string" || typeof row.serverId !== "string"
      || !/^[0-9a-f]{64}$/.test(row.configurationDigest) || keys.has(row.configKey) || expected.has(row.serverId)) refused();
    keys.add(row.configKey); expected.set(row.serverId, row.configurationDigest);
  }
  const current = () => {
    assertOwner();
    const fd = fs.openSync(input.sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) refused();
      if (createHash("sha256").update(fs.readFileSync(fd)).digest("hex") !== input.sourceDigest) refused();
    } finally { fs.closeSync(fd); }
    const registry = installed();
    for (const [id, digest] of expected) {
      const server = registry.get(id);
      if (!server || !server.enabled || server.configurationValid === false
        || mcpServerConfigurationDigest(server) !== digest) refused();
    }
    return true;
  };
  current();
  // Selection is the exact surviving server IDs, never a default/catalog union.
  const options: McpConfigBuildOptions = { ...input.buildOptions, serverIds: [...expected.keys()],
    catalogIds: undefined, skipDefaultSeed: true, configKey: `local-${randomUUID()}`,
    admissionCurrent: () => { try { return current(); } catch { return false; } } };
  let config: Awaited<ReturnType<typeof buildMcpConfigFile>>;
  try { config = await buildMcpConfigFile(options); }
  catch { throw Object.assign(new Error("local_model_remote_mcp_admission_prepare_failed"),
    { code: "local_model_remote_mcp_admission_prepare_failed" }); }
  if (!config) refused();
  try {
    current();
    const actual = preparedMcpBindings(config.configPath);
    if (actual.length !== input.servers.length || actual.some(binding =>
      !keys.has(binding.configKey) || expected.get(binding.server.id) !== mcpServerConfigurationDigest(binding.server))) refused();
    const proxyScope = preparedMcpProxyScope(config.configPath);
    // Sender metadata is intent only. Authority comes from this receiver's
    // actual reconstructed preparation, with exact canonical inode identity.
    if (mainToolConsentDigest(proxyScope ?? null) !== mainToolConsentDigest(input.proxyScope ?? null)) refused();
    return { configPath: config.configPath, runtimeEnv: config.runtimeEnv, proxyScope, cleanup: () => config.cleanup?.() };
  } catch (error) { config.cleanup?.(); throw error; }
}
