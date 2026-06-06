import fs from "node:fs";
import path from "node:path";
import {
  ONTOLOGY_DB_FILE,
  ONTOLOGY_INBOX_DIR,
  ONTOLOGY_RUNTIME_FILE,
  ONTOLOGY_SOURCE_MANIFEST_FILE,
  PROJECT_MEMORY_DIR,
} from "../architecture/manifest";
import { ensureProjectMemory } from "../memory/project-files";
import { getProject } from "../store/projects";
import type {
  OntologyInboxEntry,
  OntologyProjectStatus,
  OntologyRegisteredSource,
  OntologySourceKind,
  OntologySourceScope,
} from "../../shared/types";

const SUPPORTED_INGEST_EXTS = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".tsv"]);
const DEFAULT_POLICY: OntologyProjectStatus["policy"] = {
  mode: "inbox_and_registered_sources_only",
  neverScanHomeDirectory: true,
  neverScanSiblingProjects: true,
  crossProjectSearchDefault: "disabled",
  privateScopeDefaultSearch: "excluded",
};

interface SourceManifest {
  schemaVersion?: string;
  kind?: string;
  projectRoot?: string;
  sources?: Array<{
    path?: string;
    scope?: string;
    kind?: string;
    registeredAt?: string;
  }>;
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function normalizeScope(value: string | undefined): OntologySourceScope {
  return value === "public" || value === "private" ? value : "internal";
}

function normalizeKind(value: string | undefined): OntologySourceKind {
  return value === "company" || value === "personal" ? value : "project";
}

function manifestFor(projectPath: string): SourceManifest {
  return {
    schemaVersion: "1.0",
    kind: "agentlas-ontology-source-manifest",
    projectRoot: projectPath,
    sources: [],
  };
}

function listInboxEntries(inboxPath: string): OntologyInboxEntry[] {
  if (!fs.existsSync(inboxPath)) return [];
  const entries: OntologyInboxEntry[] = [];
  for (const entry of fs.readdirSync(inboxPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(inboxPath, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
    if (!kind) continue;
    entries.push({
      name: entry.name,
      path: full,
      kind,
      size: kind === "file" ? stat.size : 0,
      supported: kind === "dir" || SUPPORTED_INGEST_EXTS.has(path.extname(entry.name).toLowerCase()),
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries.slice(0, 80);
}

function readSources(sourceManifestPath: string): OntologyRegisteredSource[] {
  const manifest = readJsonFile<SourceManifest>(sourceManifestPath, { sources: [] });
  return (manifest.sources ?? []).map((source) => {
    const sourcePath = path.resolve(String(source.path ?? ""));
    return {
      path: sourcePath,
      scope: normalizeScope(source.scope),
      kind: normalizeKind(source.kind),
      exists: fs.existsSync(sourcePath),
      registeredAt: source.registeredAt,
    };
  });
}

export function getProjectOntologyStatus(projectId: string): OntologyProjectStatus {
  const project = getProject(projectId);
  if (!project) {
    return {
      projectId,
      projectName: "",
      state: "error",
      projectPath: null,
      memoryDir: null,
      inboxPath: null,
      dbPath: null,
      configPath: null,
      sourceManifestPath: null,
      policy: DEFAULT_POLICY,
      sources: [],
      inboxEntries: [],
      error: "Project not found.",
    };
  }
  if (!project.folderPath) {
    return {
      projectId,
      projectName: project.name,
      state: "needs_project_folder",
      projectPath: null,
      memoryDir: null,
      inboxPath: null,
      dbPath: null,
      configPath: null,
      sourceManifestPath: null,
      policy: DEFAULT_POLICY,
      sources: [],
      inboxEntries: [],
    };
  }

  const projectPath = path.resolve(project.folderPath);
  const memoryDir = ensureProjectMemory(projectPath, project.name);
  if (!memoryDir) {
    return {
      projectId,
      projectName: project.name,
      state: "error",
      projectPath,
      memoryDir: null,
      inboxPath: null,
      dbPath: null,
      configPath: null,
      sourceManifestPath: null,
      policy: DEFAULT_POLICY,
      sources: [],
      inboxEntries: [],
      error: "Could not activate .agentlas ontology folder.",
    };
  }

  const inboxPath = path.join(memoryDir, ONTOLOGY_INBOX_DIR);
  const configPath = path.join(memoryDir, ONTOLOGY_RUNTIME_FILE);
  const sourceManifestPath = path.join(memoryDir, ONTOLOGY_SOURCE_MANIFEST_FILE);
  const dbPath = path.join(memoryDir, ONTOLOGY_DB_FILE);
  fs.mkdirSync(inboxPath, { recursive: true });
  if (!fs.existsSync(sourceManifestPath)) {
    writeJsonFile(sourceManifestPath, manifestFor(projectPath));
  }

  return {
    projectId,
    projectName: project.name,
    state: "active",
    projectPath,
    memoryDir: path.join(projectPath, PROJECT_MEMORY_DIR),
    inboxPath,
    dbPath,
    configPath,
    sourceManifestPath,
    policy: DEFAULT_POLICY,
    sources: readSources(sourceManifestPath),
    inboxEntries: listInboxEntries(inboxPath),
  };
}

export function addProjectOntologySource(
  projectId: string,
  absPath: string,
  scope: OntologySourceScope,
  kind: OntologySourceKind,
): OntologyProjectStatus {
  const status = getProjectOntologyStatus(projectId);
  if (status.state !== "active" || !status.sourceManifestPath || !status.projectPath) {
    throw new Error(status.error || "Project ontology is not active.");
  }
  const sourcePath = path.resolve(absPath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }

  const manifest = readJsonFile<SourceManifest>(status.sourceManifestPath, manifestFor(status.projectPath));
  const existing = (manifest.sources ?? []).filter((source) => {
    try {
      return path.resolve(String(source.path ?? "")) !== sourcePath;
    } catch {
      return false;
    }
  });
  existing.push({
    path: sourcePath,
    scope,
    kind,
    registeredAt: new Date().toISOString(),
  });
  manifest.schemaVersion = "1.0";
  manifest.kind = "agentlas-ontology-source-manifest";
  manifest.projectRoot = status.projectPath;
  manifest.sources = existing;
  writeJsonFile(status.sourceManifestPath, manifest);
  return getProjectOntologyStatus(projectId);
}
