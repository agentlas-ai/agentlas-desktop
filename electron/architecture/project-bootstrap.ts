import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { runHephaestus } from "../hephaestus/engine";
import type { HephaestusResult } from "../hephaestus/engine";

export interface ProjectBootstrapAccess {
  permission: string | null | undefined;
  restrictedReadBoundary?: boolean;
  agentAppMode?: boolean;
}

export interface ProjectBootstrapResult {
  mode: "core" | "core-privacy-warning" | "desktop-fallback";
  created: string[];
  privacyIgnoreInstalled: boolean;
}

type CoreProjectBootstrapRunner = typeof runHephaestus;

interface CoreProjectBootstrapPayload {
  schemaVersion?: string;
  status?: string;
  mergeOnly?: boolean;
  privacyBlockInstalled?: boolean;
  privateModeCompliant?: boolean;
  missing?: unknown[];
  overwritten?: unknown[];
  permissionIssues?: unknown[];
  trackedSensitivePaths?: unknown[];
  trackedSensitiveScanComplete?: boolean;
  privacyWarnings?: unknown[];
}

const inFlight = new Map<string, Promise<ProjectBootstrapResult>>();
const settled = new Map<string, ProjectBootstrapResult>();
const FALLBACK_IGNORE_START = "# >>> agentlas desktop fallback private state >>>";
const FALLBACK_IGNORE_END = "# <<< agentlas desktop fallback private state <<<";
const MAX_GITIGNORE_READ_BYTES = 1024 * 1024;

interface RegularFileSnapshot {
  exists: boolean;
  content: string;
  mode: number;
  stat: fs.Stats | null;
}

interface ProjectBootstrapTestHooks {
  beforeFallbackIgnoreAppend?: (ignorePath: string) => void;
}

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

function hasGitMarkerInAncestors(root: string): boolean {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true;
  let current = path.resolve(root);
  while (true) {
    try {
      fs.lstatSync(path.join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    if (
      current === path.resolve(root) &&
      fs.existsSync(path.join(current, "HEAD")) &&
      fs.existsSync(path.join(current, "objects"))
    ) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
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

function readRegularUtf8FileNoFollow(filePath: string): RegularFileSnapshot {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, content: "", mode: 0o644, stat: null };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(".gitignore must be a regular non-symbolic-link file.");
  }
  if (before.size > MAX_GITIGNORE_READ_BYTES) {
    throw new Error(`.gitignore exceeds the ${MAX_GITIGNORE_READ_BYTES}-byte safe bootstrap limit.`);
  }

  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !noFollow || !["EINVAL", "ENOTSUP"].includes(code ?? "")) throw error;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error(".gitignore changed type during bootstrap.");
    if (opened.size > MAX_GITIGNORE_READ_BYTES) {
      throw new Error(`.gitignore exceeds the ${MAX_GITIGNORE_READ_BYTES}-byte safe bootstrap limit.`);
    }
    if (before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error(".gitignore changed during bootstrap.");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_GITIGNORE_READ_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_GITIGNORE_READ_BYTES + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > MAX_GITIGNORE_READ_BYTES) {
      throw new Error(`.gitignore exceeds the ${MAX_GITIGNORE_READ_BYTES}-byte safe bootstrap limit.`);
    }
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(".gitignore changed while it was being read.");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new Error(".gitignore must contain valid UTF-8 text.");
    }
    return { exists: true, content, mode: before.mode & 0o777, stat: before };
  } finally {
    fs.closeSync(fd);
  }
}

function installWholeAgentlasIgnore(root: string, testHooks?: ProjectBootstrapTestHooks): boolean {
  const ignorePath = path.join(root, ".gitignore");
  const block = [FALLBACK_IGNORE_START, ".agentlas/", FALLBACK_IGNORE_END, ""].join("\n");
  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = readRegularUtf8FileNoFollow(ignorePath);
    if (snapshot.content.endsWith(block)) return attempt > 0;
    const prefix = snapshot.content.length === 0 ? "" : snapshot.content.endsWith("\n") ? "\n" : "\n\n";
    const addition = Buffer.from(`${prefix}${block}`, "utf8");
    if ((snapshot.stat?.size ?? 0) + addition.length > MAX_GITIGNORE_READ_BYTES) {
      throw new Error(`.gitignore exceeds the ${MAX_GITIGNORE_READ_BYTES}-byte safe bootstrap limit.`);
    }
    const createFlags = snapshot.exists ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL;
    testHooks?.beforeFallbackIgnoreAppend?.(ignorePath);
    let fd: number;
    try {
      fd = fs.openSync(ignorePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow | createFlags, 0o644);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!snapshot.exists && code === "EEXIST") continue;
      if (process.platform !== "win32" || !noFollow || !["EINVAL", "ENOTSUP"].includes(code ?? "")) throw error;
      fd = fs.openSync(ignorePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | createFlags, 0o644);
    }
    let retry = false;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) throw new Error(".gitignore changed type during bootstrap.");
      if (snapshot.exists) {
        const original = snapshot.stat;
        if (
          !original || opened.dev !== original.dev || opened.ino !== original.ino ||
          opened.size !== original.size || opened.mtimeMs !== original.mtimeMs
        ) retry = true;
      } else if (opened.size !== 0) {
        retry = true;
      }
      if (!retry) {
        fs.writeSync(fd, addition, 0, addition.length);
        fs.fsyncSync(fd);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (retry) continue;
    const finalSnapshot = readRegularUtf8FileNoFollow(ignorePath);
    if (finalSnapshot.content.endsWith(block)) return true;
  }
  throw new Error(".gitignore changed repeatedly during bootstrap.");
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

function installMergeOnlyFallback(
  root: string,
  projectName?: string,
  testHooks?: ProjectBootstrapTestHooks,
): ProjectBootstrapResult {
  installWholeAgentlasIgnore(root, testHooks);
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
  testHooks?: ProjectBootstrapTestHooks;
}): Promise<ProjectBootstrapResult> {
  let result: HephaestusResult<CoreProjectBootstrapPayload>;
  try {
    result = await input.runCore<CoreProjectBootstrapPayload>(
      "agentlas_cloud",
      ["project", "ensure", "--project", input.root, "--reason", input.reason],
      { cwd: input.root, timeoutMs: 120_000 },
    );
  } catch {
    throw new Error("Agentlas Core project bootstrap failed before its write state could be verified.");
  }
  if (!result.ok) {
    const safePreflightFailure =
      result.exitCode === null && result.json === null && result.stdout === "" && result.stderr === "" &&
      [
        "Could not find the Hephaestus engine (bundle missing).",
        "Hephaestus 엔진을 찾을 수 없습니다(번들 누락).",
        "Could not find Python 3.9+. Install it from python.org or Homebrew (python3) and try again.",
        "Python 3.9+ 를 찾을 수 없습니다. python.org 또는 Homebrew(python3)로 설치 후 다시 시도하세요.",
      ].includes(result.error ?? "");
    if (safePreflightFailure) return installMergeOnlyFallback(input.root, input.projectName, input.testHooks);
    throw new Error("Agentlas Core project bootstrap failed before its write state could be verified.");
  }
  const payload = result.json;
  const trackedSensitivePaths = Array.isArray(payload?.trackedSensitivePaths) ? payload.trackedSensitivePaths : null;
  const privacyWarnings = Array.isArray(payload?.privacyWarnings) ? payload.privacyWarnings : null;
  const commonContractValid =
    payload?.schemaVersion === "agentlas.project-bootstrap.v1" &&
    payload.mergeOnly === true &&
    payload.privacyBlockInstalled === true &&
    payload.privateModeCompliant === true &&
    Array.isArray(payload.missing) && payload.missing.length === 0 &&
    Array.isArray(payload.overwritten) && payload.overwritten.length === 0 &&
    Array.isArray(payload.permissionIssues) && payload.permissionIssues.length === 0 &&
    trackedSensitivePaths !== null &&
    typeof payload.trackedSensitiveScanComplete === "boolean" &&
    privacyWarnings !== null;
  if (
    commonContractValid && payload.status === "active" &&
    trackedSensitivePaths.length === 0 &&
    payload.trackedSensitiveScanComplete === true &&
    privacyWarnings.length === 0
  ) {
    return { mode: "core", created: [], privacyIgnoreInstalled: true };
  }
  if (commonContractValid && payload.status === "privacy_warning") {
    const nonGitTrackedScanWarningOnly =
      trackedSensitivePaths.length === 0 &&
      payload.trackedSensitiveScanComplete === false &&
      privacyWarnings.length === 1 &&
      privacyWarnings[0] === "tracked_sensitive_scan_incomplete" &&
      !hasGitMarkerInAncestors(input.root);
    if (nonGitTrackedScanWarningOnly) {
      return { mode: "core", created: [], privacyIgnoreInstalled: true };
    }
    return { mode: "core-privacy-warning", created: [], privacyIgnoreInstalled: true };
  }
  throw new Error("Agentlas Core returned an incomplete project bootstrap contract.");
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
  /** Test seam only. Production callers never inject fallback filesystem races. */
  testHooks?: ProjectBootstrapTestHooks;
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
    testHooks: input.testHooks,
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
