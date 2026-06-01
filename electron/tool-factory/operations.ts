import fs from "node:fs/promises";
import path from "node:path";
import { getServer, installCustomServer, removeServer } from "../mcp-tools/registry";
import { getAgentToolByRoot } from "../store/agent-tools";
import type { JsonObject, ToolFactoryMcpInstallResult, ToolFactoryRootRequest } from "../../shared/types";

export async function installToolMcp(
  input: ToolFactoryRootRequest,
): Promise<ToolFactoryMcpInstallResult> {
  if (!path.isAbsolute(input.rootPath)) {
    throw new Error("Tool Factory rootPath must be absolute.");
  }
  const rootPath = path.resolve(input.rootPath);
  const configPath = path.join(rootPath, "agentlas.tool.json");
  const mcpPath = path.join(rootPath, "mcp", "server.mjs");
  assertInside(rootPath, configPath);
  assertInside(rootPath, mcpPath);

  const definition = await readDefinition(configPath);
  await fs.access(mcpPath);

  const existingRecord = getAgentToolByRoot(rootPath);
  const existingServer =
    existingRecord?.installedServerId ? getServer(existingRecord.installedServerId) : null;
  const command = nodeExecPath();
  const args = [mcpPath];
  const server =
    existingServer ??
    installCustomServer({
      name: `Agentlas Tool · ${stringValue(definition.name) || path.basename(rootPath)}`,
      transport: "stdio",
      command,
      args,
      envKeys: [],
    });

  return {
    rootPath,
    configPath,
    mcpPath,
    command,
    args,
    server,
    installedAt: new Date().toISOString(),
  };
}

export async function archiveToolPackage(input: ToolFactoryRootRequest): Promise<{
  rootPath: string;
  archivePath: string;
  manifestPath: string;
  removed: boolean;
  removedServerId: string | null;
  reversible: boolean;
  archivedAt: string;
  summary: string;
}> {
  if (!path.isAbsolute(input.rootPath)) {
    throw new Error("Tool Factory rootPath must be absolute.");
  }
  const rootPath = path.resolve(input.rootPath);
  const configPath = path.join(rootPath, "agentlas.tool.json");
  assertInside(rootPath, configPath);
  const definition = await readDefinition(configPath);
  const archivedAt = new Date().toISOString();
  const baseDir = toolFactoryBaseDir(rootPath);
  const archiveDir = path.join(baseDir, ".agentlas", "archive", "tools");
  const archivePath = await nextArchivePath(archiveDir, path.basename(rootPath), archivedAt);
  assertInside(baseDir, archivePath);
  await fs.mkdir(path.dirname(archivePath), { recursive: true });

  const record = getAgentToolByRoot(rootPath);
  const removedServerId = record?.installedServerId ?? null;
  if (removedServerId) {
    removeServer(removedServerId);
  }

  const manifestPath = path.join(rootPath, "agentlas.archive.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: "0.1",
        kind: "agentlas-tool-archive",
        originalRootPath: rootPath,
        archivePath,
        archivedAt,
        reversible: true,
        removedServerId,
        tool: {
          id: stringValue(definition.id) || path.basename(rootPath),
          requestedId: stringValue(definition.requestedId) || null,
          name: stringValue(definition.name) || path.basename(rootPath),
          domain: stringValue(definition.domain) || null,
          kind: stringValue(definition.kind) || null,
        },
        restore: {
          operation: "toolFactory.restore",
          rootPath,
        },
        gc: {
          operation: "delete-archive",
          policy: "manual-confirmation-required",
          note: "Generated tool archives are retained until the user explicitly purges them.",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.rename(rootPath, archivePath);
  return {
    rootPath,
    archivePath,
    manifestPath: path.join(archivePath, "agentlas.archive.json"),
    removed: true,
    removedServerId,
    reversible: true,
    archivedAt,
    summary: removedServerId
      ? `Generated tool moved to reversible archive and MCP server was unregistered: ${archivePath}`
      : `Generated tool moved to reversible archive: ${archivePath}`,
  };
}

export async function restoreToolPackage(input: ToolFactoryRootRequest): Promise<{
  rootPath: string;
  archivePath: string | null;
  restored: boolean;
  restoredServerId: string | null;
  restoredAt: string;
  summary: string;
}> {
  if (!path.isAbsolute(input.rootPath)) {
    throw new Error("Tool Factory rootPath must be absolute.");
  }
  const rootPath = path.resolve(input.rootPath);
  const configPath = path.join(rootPath, "agentlas.tool.json");
  assertInside(rootPath, configPath);
  if (await exists(configPath)) {
    return {
      rootPath,
      archivePath: null,
      restored: false,
      restoredServerId: null,
      restoredAt: new Date().toISOString(),
      summary: "Generated tool already exists at its original root.",
    };
  }

  const archived = await findLatestArchivedToolPath(rootPath);
  if (!archived) {
    throw new Error(`No reversible archive found for generated tool: ${rootPath}`);
  }
  const baseDir = toolFactoryBaseDir(rootPath);
  assertInside(baseDir, archived);
  await fs.mkdir(path.dirname(rootPath), { recursive: true });
  await fs.rename(archived, rootPath);
  const restoredAt = new Date().toISOString();
  const restoredServerId = await restoreToolMcpRegistration(rootPath);
  return {
    rootPath,
    archivePath: archived,
    restored: true,
    restoredServerId,
    restoredAt,
    summary: restoredServerId
      ? `Generated tool restored from reversible archive and MCP server was re-registered: ${archived}`
      : `Generated tool restored from reversible archive: ${archived}`,
  };
}

async function restoreToolMcpRegistration(rootPath: string): Promise<string | null> {
  const archiveManifestPath = path.join(rootPath, "agentlas.archive.json");
  const mcpPath = path.join(rootPath, "mcp", "server.mjs");
  assertInside(rootPath, archiveManifestPath);
  assertInside(rootPath, mcpPath);
  if (!(await exists(archiveManifestPath)) || !(await exists(mcpPath))) return null;
  const manifest = await readDefinition(archiveManifestPath);
  const removedServerId = stringValue(manifest.removedServerId);
  if (!removedServerId) return null;
  const configPath = path.join(rootPath, "agentlas.tool.json");
  const definition = await readDefinition(configPath);
  const existingRecord = getAgentToolByRoot(rootPath);
  const existingServer =
    existingRecord?.installedServerId ? getServer(existingRecord.installedServerId) : null;
  const server =
    existingServer ??
    installCustomServer({
      name: `Agentlas Tool · ${stringValue(definition.name) || path.basename(rootPath)}`,
      transport: "stdio",
      command: nodeExecPath(),
      args: [mcpPath],
      envKeys: [],
    });
  return server.id;
}

async function readDefinition(configPath: string): Promise<JsonObject> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed)) {
    throw new Error(`Invalid Agentlas tool definition: ${configPath}`);
  }
  return parsed;
}

function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to read outside tool root: ${target}`);
  }
}

function toolFactoryBaseDir(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const toolsDir = path.dirname(resolved);
  const agentlasDir = path.dirname(toolsDir);
  if (path.basename(toolsDir) === "tools" && path.basename(agentlasDir) === ".agentlas") {
    return path.dirname(agentlasDir);
  }
  return path.dirname(resolved);
}

async function nextArchivePath(archiveDir: string, toolId: string, archivedAt: string): Promise<string> {
  const suffix = archivedAt.replace(/\.\d{3}Z$/, "Z").replace(/[:]/g, "-");
  let candidate = path.join(archiveDir, `${toolId}-${suffix}`);
  let i = 1;
  while (await exists(candidate)) {
    candidate = path.join(archiveDir, `${toolId}-${suffix}-${i}`);
    i += 1;
  }
  return candidate;
}

async function findLatestArchivedToolPath(rootPath: string): Promise<string | null> {
  const baseDir = toolFactoryBaseDir(rootPath);
  const archiveDir = path.join(baseDir, ".agentlas", "archive", "tools");
  const toolId = path.basename(rootPath);
  if (!(await exists(archiveDir))) return null;
  const entries = await fs.readdir(archiveDir, { withFileTypes: true });
  const matches: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${toolId}-`)) continue;
    const candidate = path.join(archiveDir, entry.name);
    const configPath = path.join(candidate, "agentlas.tool.json");
    if (!(await exists(configPath))) continue;
    const stat = await fs.stat(candidate);
    matches.push({ path: candidate, mtimeMs: stat.mtimeMs });
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0]?.path ?? null;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nodeExecPath(): string {
  const versions = process.versions as NodeJS.ProcessVersions & { electron?: string };
  return process.env.npm_node_execpath || process.env.NODE || (versions.electron ? "node" : process.execPath);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
