import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHephaestus } from "../hephaestus/engine";

export interface ProjectBootstrapAccess {
  permission: string | null | undefined;
  restrictedReadBoundary?: boolean;
  agentAppMode?: boolean;
}

export interface ProjectBootstrapResult {
  mode: "core" | "desktop-fallback";
  created: string[];
  privacyIgnoreInstalled: boolean;
}

type CoreProjectBootstrapRunner = typeof runHephaestus;

const inFlight = new Map<string, Promise<ProjectBootstrapResult>>();
const settled = new Map<string, ProjectBootstrapResult>();
const FALLBACK_IGNORE_START = "# >>> agentlas desktop fallback private state >>>";
const FALLBACK_IGNORE_END = "# <<< agentlas desktop fallback private state <<<";
const MAX_GITIGNORE_READ_BYTES = 4 * 1024 * 1024;

export function projectBootstrapAccessAllowed(access: ProjectBootstrapAccess): boolean {
  return (
    (access.permission === "write" || access.permission === "full") &&
    access.restrictedReadBoundary !== true &&
    access.agentAppMode !== true
  );
}

function writableProjectRoot(projectPath: string, access: ProjectBootstrapAccess): string {
  if (!projectBootstrapAccessAllowed(access)) {
    throw new Error("Project bootstrap requires an interactive writable Desktop project.");
  }
  const root = fs.realpathSync.native(projectPath);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error("Project bootstrap target is not a directory.");
  const normalized = path.resolve(root);
  if (normalized === path.parse(normalized).root || normalized === path.resolve(os.homedir())) {
    throw new Error("Refusing to bootstrap an unsafe project root.");
  }
  fs.accessSync(normalized, fs.constants.R_OK | fs.constants.W_OK);
  return normalized;
}

function cleanProjectName(projectName: string | undefined, root: string): string {
  const raw = (projectName || path.basename(root) || "Project")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return raw.slice(0, 120) || "Project";
}

function ensurePrivateAgentlasDir(root: string): string {
  const dir = path.join(root, ".agentlas");
  try {
    const existing = fs.lstatSync(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("Refusing to use a non-directory or symlinked .agentlas path.");
    }
    try { fs.chmodSync(dir, 0o700); } catch { /* Windows/filesystem ACLs remain authoritative. */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  return dir;
}

function hasEffectiveWholeAgentlasIgnore(content: string): boolean {
  let ignored = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\/?\.agentlas\/?$/.test(line)) ignored = true;
    if (/^!\/?\.agentlas(?:\/|$)/.test(line)) ignored = false;
  }
  return ignored;
}

function installWholeAgentlasIgnore(root: string): boolean {
  const ignorePath = path.join(root, ".gitignore");
  let existing = "";
  try {
    const stat = fs.lstatSync(ignorePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Refusing to modify a non-file or symlinked .gitignore.");
    }
    if (stat.size <= MAX_GITIGNORE_READ_BYTES) existing = fs.readFileSync(ignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (hasEffectiveWholeAgentlasIgnore(existing)) return false;
  const block = [FALLBACK_IGNORE_START, ".agentlas/", FALLBACK_IGNORE_END, ""].join("\n");
  const prefix = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";
  fs.appendFileSync(ignorePath, `${prefix}${block}`, { encoding: "utf8", mode: 0o644, flag: "a" });
  return true;
}

function writeMissingPrivateFile(filePath: string, content: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function installMergeOnlyFallback(root: string, projectName?: string): ProjectBootstrapResult {
  installWholeAgentlasIgnore(root);
  const dir = ensurePrivateAgentlasDir(root);
  const name = cleanProjectName(projectName, root);
  const projectId = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const created: string[] = [];
  const soul = [
    "# Project Soul Memory",
    "",
    "## Intent",
    "",
    `Preserve local continuity for ${name} until the canonical Agentlas Core project bootstrap is available.`,
    "",
    "## Decisions",
    "",
    "## Open Loops",
    "",
    "## Acceptance Criteria",
    "",
    "- Durable additions remain local, value-free, evidence-linked, and operator controlled.",
    "",
  ].join("\n");
  const sitemap = JSON.stringify({
    schemaVersion: "1.0",
    kind: "agentlas-ai-sitemap",
    projectId,
    state: "fallback-seed",
    memoryRoots: [".agentlas/project-soul-memory.md", ".agentlas/memory-tickets.jsonl"],
    codeMap: ".agentlas/code-map/project-map.json",
    ontologyRuntime: ".agentlas/ontology-runtime.json",
    careerGraph: ".agentlas/career-graph.json",
    mergeOnly: true,
  }, null, 2) + "\n";
  for (const [relative, content] of [
    ["project-soul-memory.md", soul],
    ["sitemap.json", sitemap],
    ["memory-tickets.jsonl", ""],
  ] as const) {
    if (writeMissingPrivateFile(path.join(dir, relative), content)) created.push(`.agentlas/${relative}`);
  }
  return { mode: "desktop-fallback", created, privacyIgnoreInstalled: true };
}

async function bootstrapOnce(input: {
  root: string;
  projectName?: string;
  reason: string;
  runCore: CoreProjectBootstrapRunner;
}): Promise<ProjectBootstrapResult> {
  try {
    const result = await input.runCore<{
      schemaVersion?: string;
      status?: string;
      mergeOnly?: boolean;
      privacyBlockInstalled?: boolean;
    }>(
      "agentlas_cloud",
      ["project", "ensure", "--project", input.root, "--reason", input.reason],
      { cwd: input.root, timeoutMs: 120_000 },
    );
    if (
      result.ok &&
      result.json?.schemaVersion === "agentlas.project-bootstrap.v1" &&
      result.json.status === "active" &&
      result.json.mergeOnly === true &&
      result.json.privacyBlockInstalled === true
    ) {
      return { mode: "core", created: [], privacyIgnoreInstalled: true };
    }
  } catch {
    // Missing/older Core is a supported degraded state. The fallback below is
    // deliberately tiny and never expands into Desktop's legacy full seed.
  }
  return installMergeOnlyFallback(input.root, input.projectName);
}

/**
 * First writable Desktop contact delegates canonical project setup to Core.
 * A process-local cache prevents duplicate scans; a later app launch retries a
 * previously missing/older Core and upgrades the merge-only fallback in place.
 */
export async function ensureDesktopProjectBootstrap(input: {
  projectPath: string;
  projectName?: string;
  reason?: string;
  access: ProjectBootstrapAccess;
  /** Test seam only. Production callers use the bundled Core bridge. */
  runCore?: CoreProjectBootstrapRunner;
}): Promise<ProjectBootstrapResult> {
  const root = writableProjectRoot(input.projectPath, input.access);
  const prior = settled.get(root);
  if (prior) return prior;
  const pending = inFlight.get(root);
  if (pending) return pending;
  const run = bootstrapOnce({
    root,
    projectName: input.projectName,
    reason: input.reason ?? "desktop-first-contact",
    runCore: input.runCore ?? runHephaestus,
  });
  inFlight.set(root, run);
  try {
    const result = await run;
    settled.set(root, result);
    return result;
  } finally {
    inFlight.delete(root);
  }
}
