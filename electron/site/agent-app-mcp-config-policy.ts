import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstalledMcpServer, McpInvocationRequest } from "../../shared/types";
import { getCatalogEntry } from "../mcp-tools/catalog";
import {
  MCP_CHILD_ENV_WRAPPER_SHA256,
  mcpRuntimeSecretAlias,
} from "../mcp-tools/mcp-config";
import {
  AGENTLAS_SYSTEM_TIME_CATALOG_ID,
  isAuthenticSystemTimeMcpLaunch,
  isCanonicalSystemTimeMcpServer,
} from "../mcp-tools/system-time-server";
import { isSiteAgentAppMcpCatalogId } from "./agent-app-tool-policy";

const SECRET_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;
export const SITE_AGENT_APP_MCP_CONFIG_MAX_BYTES = 256 * 1024;
export const SITE_AGENT_APP_INLINE_MCP_CONFIG_MAX_CHARS = 4_096;

export type SiteAgentAppMcpServerBinding = {
  serverId: string;
  catalogId: string;
  configKey: string;
};

function sameStableStat(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs;
}

type StableFileIdentity = Pick<fs.BigIntStats,
  "dev" | "ino" | "mode" | "size" | "mtimeNs" | "ctimeNs" | "birthtimeNs">;

export function sameStablePathAndFdIdentity(pathStat: StableFileIdentity, fdStat: StableFileIdentity): boolean {
  if (pathStat.dev !== fdStat.dev || pathStat.mode !== fdStat.mode || pathStat.size !== fdStat.size) return false;
  if (pathStat.ino !== 0n || fdStat.ino !== 0n) return pathStat.ino === fdStat.ino;
  return pathStat.birthtimeNs === fdStat.birthtimeNs && pathStat.mtimeNs === fdStat.mtimeNs &&
    pathStat.ctimeNs === fdStat.ctimeNs;
}

/**
 * Open without following the leaf symlink and read a bounded regular file from
 * one descriptor. The before/after descriptor and pathname identities must
 * remain unchanged, so callers parse and hash the same accepted bytes.
 */
export function readStableRegularFile(file: string, maxBytes: number): Buffer | null {
  if (!path.isAbsolute(file) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  let fd: number | null = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) return null;
    const pathBefore = fs.lstatSync(file, { bigint: true });
    const canonicalBefore = fs.realpathSync.native(file);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() ||
        !sameStablePathAndFdIdentity(pathBefore, before)) return null;

    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extra, 0, 1, offset) !== 0) return null;

    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(file, { bigint: true });
    const canonicalAfter = fs.realpathSync.native(file);
    if (!sameStableStat(before, after) || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        !sameStablePathAndFdIdentity(pathAfter, after) || canonicalAfter !== canonicalBefore) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function regularNonSymlinkFile(file: string, executable = false): boolean {
  if (!path.isAbsolute(file)) return false;
  try {
    const link = fs.lstatSync(file);
    if (link.isSymbolicLink() || !link.isFile()) return false;
    if (executable) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function hasPinnedSiteAgentAppExecutable(server: InstalledMcpServer): boolean {
  if (server.configurationValid === false || !Array.isArray(server.args) ||
      server.args.some((arg) => typeof arg !== "string") || !Array.isArray(server.envKeys) ||
      server.envKeys.some((key) => typeof key !== "string") ||
      (server.command !== null && typeof server.command !== "string") ||
      (server.url !== null && typeof server.url !== "string")) return false;
  return server.catalogId === AGENTLAS_SYSTEM_TIME_CATALOG_ID && isCanonicalSystemTimeMcpServer(server);
}

export function hasExactSiteAgentAppCatalogEnv(server: InstalledMcpServer): boolean {
  if (server.configurationValid === false || !Array.isArray(server.envKeys) ||
      server.envKeys.some((key) => typeof key !== "string")) return false;
  if (!server.catalogId || !isSiteAgentAppMcpCatalogId(server.catalogId)) return false;
  const entry = getCatalogEntry(server.catalogId);
  if (!entry) return false;
  const required = entry.envRequirements.filter((item) => item.required).map((item) => item.key).sort();
  return new Set(server.envKeys).size === server.envKeys.length &&
    JSON.stringify([...server.envKeys].sort()) === JSON.stringify(required);
}

function exactSerializedServer(
  value: unknown,
  server: InstalledMcpServer,
  binding: SiteAgentAppMcpServerBinding,
  configPath: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as { command?: unknown; args?: unknown; env?: unknown };
  if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["args", "command", "env"])) return false;
  if (entry.command !== process.execPath || !Array.isArray(entry.args) || !entry.env ||
      typeof entry.env !== "object" || Array.isArray(entry.env)) return false;
  if (entry.args.some((arg) => typeof arg !== "string" || arg.length > 8_192)) return false;
  const args = entry.args as string[];
  if (isAuthenticSystemTimeMcpLaunch(server.command, server.args)) {
    const env = entry.env as Record<string, unknown>;
    return isAuthenticSystemTimeMcpLaunch(entry.command, args) &&
      JSON.stringify(Object.keys(env)) === JSON.stringify(["ELECTRON_RUN_AS_NODE"]) &&
      env.ELECTRON_RUN_AS_NODE === "1";
  }
  if (args.length !== 4 + server.args.length) return false;
  const wrapperBytes = readStableRegularFile(args[0] ?? "", 64 * 1024);
  if (
    path.dirname(args[0]) !== path.dirname(configPath) ||
    path.basename(args[0]) !== "mcp-child-env-wrapper.cjs" ||
    !wrapperBytes || createHash("sha256").update(wrapperBytes).digest("hex") !== MCP_CHILD_ENV_WRAPPER_SHA256 ||
    args[1] !== require.resolve("cross-spawn") ||
    args[3] !== expandHome(server.command ?? "") ||
    JSON.stringify(args.slice(4)) !== JSON.stringify(server.args.map(expandHome))
  ) return false;

  let mapping: Record<string, string>;
  try {
    const parsed = JSON.parse(args[2]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    mapping = parsed as Record<string, string>;
  } catch {
    return false;
  }
  const expectedMapping = Object.fromEntries(server.envKeys.map((key) => [
    key,
    mcpRuntimeSecretAlias(binding.configKey, key),
  ]));
  if (JSON.stringify(mapping) !== JSON.stringify(expectedMapping)) return false;
  const aliases = Object.values(mapping);
  if (new Set(aliases).size !== aliases.length || aliases.some((alias) => !SECRET_ALIAS_RE.test(alias))) return false;
  const env = entry.env as Record<string, unknown>;
  const expectedEnvKeys = ["ELECTRON_RUN_AS_NODE", ...aliases].sort();
  if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify(expectedEnvKeys) || env.ELECTRON_RUN_AS_NODE !== "1") return false;
  return aliases.every((alias) => env[alias] === `\${${alias}}`);
}

export type ValidatedSiteAgentAppMcpConfig = {
  sha256: string;
  runtimeAliases: string[];
  /** Compact, newline-free JSON passed directly to Claude --mcp-config. */
  inlineConfig: string;
};

/** Full canonical config validation over exactly the bytes returned by stableRead. */
export function validateSiteAgentAppMcpConfigBytes(input: {
  bytes: Buffer;
  configPath: string;
  bindings: SiteAgentAppMcpServerBinding[];
  servers: InstalledMcpServer[];
}): ValidatedSiteAgentAppMcpConfig | null {
  const { bytes, configPath, bindings, servers } = input;
  if (!path.isAbsolute(configPath) || bytes.length < 1 ||
      bytes.length > Math.min(SITE_AGENT_APP_MCP_CONFIG_MAX_BYTES, SITE_AGENT_APP_INLINE_MCP_CONFIG_MAX_CHARS) ||
      bindings.length < 1 || bindings.length !== servers.length) return null;
  if (new Set(bindings.map((item) => item.serverId)).size !== bindings.length ||
      new Set(bindings.map((item) => item.catalogId)).size !== bindings.length ||
      new Set(bindings.map((item) => item.configKey)).size !== bindings.length) return null;

  let parsed: { mcpServers?: unknown };
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed)) !== JSON.stringify(["mcpServers"]) ||
      !parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) return null;
  const serialized = parsed.mcpServers as Record<string, unknown>;
  if (JSON.stringify(Object.keys(serialized).sort()) !== JSON.stringify(bindings.map((item) => item.configKey).sort())) return null;

  const rows = new Map(servers.map((server) => [server.id, server]));
  const aliases: string[] = [];
  for (const binding of bindings) {
    const server = rows.get(binding.serverId);
    if (!server || !server.enabled || server.catalogId !== binding.catalogId ||
        binding.configKey !== binding.catalogId || !isSiteAgentAppMcpCatalogId(binding.catalogId) ||
        !hasExactSiteAgentAppCatalogEnv(server) || !hasPinnedSiteAgentAppExecutable(server) ||
        !exactSerializedServer(serialized[binding.configKey], server, binding, configPath)) return null;
    aliases.push(...server.envKeys.map((key) => mcpRuntimeSecretAlias(binding.configKey, key)));
  }
  if (new Set(aliases).size !== aliases.length) return null;
  const inlineConfig = JSON.stringify(parsed);
  if (!inlineConfig || /[\r\n\0]/.test(inlineConfig) ||
      Buffer.byteLength(inlineConfig, "utf8") > SITE_AGENT_APP_INLINE_MCP_CONFIG_MAX_CHARS) return null;
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    runtimeAliases: aliases.sort(),
    inlineConfig,
  };
}

/**
 * Revalidate the complete JIT grant immediately before Main dispatch and
 * return only the canonical in-memory config. No runner receives the mutable
 * preflight pathname, even if that file or its registry row changes later.
 */
export function resolveSiteAgentAppInlineMcpConfigForDispatch(
  grant: NonNullable<McpInvocationRequest["agentAppRuntimeToolGrant"]>,
  installedServers: InstalledMcpServer[],
): string | null {
  if (
    !grant || typeof grant !== "object" ||
    grant.schemaVersion !== 1 ||
    grant.runtimeStatus !== "prepared" ||
    !Array.isArray(grant.availableCatalogIds) ||
    grant.availableCatalogIds.length < 1 ||
    grant.availableCatalogIds.some((id) => typeof id !== "string") ||
    new Set(grant.availableCatalogIds).size !== grant.availableCatalogIds.length ||
    !Array.isArray(grant.mcpServerBindings) ||
    grant.mcpServerBindings.length !== grant.availableCatalogIds.length ||
    grant.mcpServerBindings.some((item) => !item || typeof item !== "object" ||
      typeof item.serverId !== "string" || typeof item.catalogId !== "string" ||
      typeof item.configKey !== "string") ||
    !grant.mcpRuntimeEnv || typeof grant.mcpRuntimeEnv !== "object" ||
    Array.isArray(grant.mcpRuntimeEnv)
  ) return null;

  const bindingCatalogIds = grant.mcpServerBindings.map((item) => item.catalogId).sort();
  if (JSON.stringify(bindingCatalogIds) !== JSON.stringify([...grant.availableCatalogIds].sort())) return null;

  const rows = new Map(installedServers.map((server) => [server.id, server]));
  const boundServers: InstalledMcpServer[] = [];
  for (const binding of grant.mcpServerBindings) {
    const server = rows.get(binding.serverId);
    if (!server) return null;
    boundServers.push(server);
  }

  const bytes = readStableRegularFile(grant.mcpConfigPath, SITE_AGENT_APP_MCP_CONFIG_MAX_BYTES);
  const validated = bytes ? validateSiteAgentAppMcpConfigBytes({
    bytes,
    configPath: grant.mcpConfigPath,
    bindings: grant.mcpServerBindings,
    servers: boundServers,
  }) : null;
  if (
    !validated ||
    !/^[a-f0-9]{64}$/.test(grant.mcpConfigSha256) ||
    validated.sha256 !== grant.mcpConfigSha256 ||
    JSON.stringify(Object.keys(grant.mcpRuntimeEnv).sort()) !== JSON.stringify(validated.runtimeAliases)
  ) return null;
  return validated.inlineConfig;
}
