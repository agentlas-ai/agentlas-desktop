// Per-project memory artifacts inside the user's working folder:
//   <folder>/.agentlas/project-soul-memory.md  — human-readable durable memory (PM Soul)
//   <folder>/.agentlas/sitemap.json            — AI Sitemap (Task Bias governance)
//   <folder>/.agentlas/memory-log.jsonl        — append-only curated event log
//
// These are intentionally plain files: portable, diff-able, and visible to the user.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import Database from "better-sqlite3";
import {
  autoLocalEmbedding,
  cosineSimilarity,
} from "./local-embedding";
import {
  generateProjectSitemap,
  ProjectArtifactError,
  PROJECT_PM_DIR,
  PROJECT_SITEMAP_MAX_ENTRIES,
  type ProjectSitemap,
} from "./project-artifacts";
import { getDb } from "../store/db";
import {
  activeHubMemoryNestPaths,
  ensureActiveHubMemoryNest,
  hubMemoryNestPathsForOwnerScope,
  normalizeHubMemorySlug,
  readableActiveHubMemoryNestRoots,
} from "../agents/hub-memory-nest";
import {
  beginMemoryProjectionWrite,
  commitMemoryProjectionWrites,
  finishMemoryProjectionWrite,
  type MemoryProjectionWriterLease,
  NATIVE_TWIN_SOURCE_SUFFIX,
} from "./revocations";
import {
  CAREER_GRAPH_CONFIG_FILE,
  CAREER_GRAPH_DB_FILE,
  CAREER_GRAPH_INBOX_DIR,
  CAREER_GRAPH_SOURCE_MANIFEST_FILE,
  CURATOR_DECISIONS_FILE,
  EXPERIENCE_RELATION_LEDGER_FILE,
  LOCAL_CREDENTIALS_MAP_FILE,
  MEMORY_LOG_FILE,
  ONTOLOGY_DB_FILE,
  ONTOLOGY_INBOX_DIR,
  ONTOLOGY_RUNTIME_FILE,
  ONTOLOGY_SOURCE_MANIFEST_FILE,
  PROJECT_CREDENTIALS_DIR,
  PROJECT_CREDENTIALS_README_FILE,
  PROJECT_ENV_EXAMPLE_FILE,
  PROJECT_MEMORY_DIR,
  PROJECT_SIGNING_DIR,
  PROJECT_SOUL_FILE,
  SITEMAP_FILE,
  SKILL_REGISTRY_FILE,
  SKILL_TRIALS_FILE,
} from "../architecture/manifest";

export function projectMemoryDir(projectPath: string): string {
  return path.join(projectPath, PROJECT_MEMORY_DIR);
}

const AUTO_SECTION = "## Auto-curated memory";
const CREDENTIAL_INDEX_SECTION = "## Local Credential Index (read first)";
const MEMORY_PROJECTION_CLEANUP_MAX_FILE_BYTES = 8n * 1024n * 1024n;

interface ProjectFsIdentity {
  root: string;
  stat: fs.BigIntStats;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameFsObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  if (left.dev > 0n && right.dev > 0n && left.dev !== right.dev) return false;
  if (left.ino > 0n && right.ino > 0n && left.ino !== right.ino) return false;
  if (
    left.birthtimeNs > 0n &&
    right.birthtimeNs > 0n &&
    left.birthtimeNs !== right.birthtimeNs
  ) return false;
  return true;
}

function sameStableRegularFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.isFile() &&
    right.isFile() &&
    sameFsObject(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function lstatBigIntOrNull(target: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function projectPathError(message: string): never {
  throw new ProjectArtifactError("race-detected", message);
}

function resolveProjectFsIdentity(projectPath: string): ProjectFsIdentity {
  if (typeof projectPath !== "string" || !projectPath.trim() || projectPath.includes("\0")) {
    throw new ProjectArtifactError("invalid-input", "An explicit project root is required.");
  }
  const requested = path.resolve(projectPath);
  let requestedStat: fs.BigIntStats;
  let root: string;
  try {
    requestedStat = fs.lstatSync(requested, { bigint: true });
    root = fs.realpathSync.native(requested);
  } catch {
    throw new ProjectArtifactError("unsafe-project-root", "The project root is unavailable.");
  }
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
    throw new ProjectArtifactError("unsafe-project-root", "The project root must be a real directory.");
  }
  const normalized = path.resolve(root);
  const stat = fs.lstatSync(normalized, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() || !sameFsObject(requestedStat, stat)) {
    throw new ProjectArtifactError("unsafe-project-root", "The project root must resolve to a real directory.");
  }
  if (
    normalized === path.parse(normalized).root ||
    sameCanonicalPath(normalized, fs.realpathSync.native(os.homedir()))
  ) {
    throw new ProjectArtifactError("unsafe-project-root", "Filesystem roots and the home directory are not projects.");
  }
  return { root: normalized, stat };
}

function assertProjectFsIdentity(identity: ProjectFsIdentity): void {
  try {
    const current = fs.lstatSync(identity.root, { bigint: true });
    const real = fs.realpathSync.native(identity.root);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameFsObject(identity.stat, current) ||
      !sameCanonicalPath(real, identity.root)
    ) projectPathError("The project root changed during memory provisioning.");
  } catch (error) {
    if (error instanceof ProjectArtifactError) throw error;
    projectPathError("The project root changed during memory provisioning.");
  }
}

function assertRealProjectDirectory(
  identity: ProjectFsIdentity,
  directory: string,
  label: string,
): fs.BigIntStats {
  const resolved = path.resolve(directory);
  if (!pathIsInside(identity.root, resolved) || sameCanonicalPath(identity.root, resolved)) {
    throw new ProjectArtifactError("path-traversal", `${label} must stay below the project root.`);
  }
  const stat = lstatBigIntOrNull(resolved);
  if (stat?.isSymbolicLink()) {
    throw new ProjectArtifactError("symlink-denied", `${label} must not be a symbolic link.`);
  }
  if (!stat || !stat.isDirectory()) {
    throw new ProjectArtifactError("not-a-directory", `${label} must be a real directory.`);
  }
  let real: string;
  try {
    real = fs.realpathSync.native(resolved);
  } catch {
    throw new ProjectArtifactError("not-a-directory", `${label} is unavailable.`);
  }
  if (!sameCanonicalPath(real, resolved) || !pathIsInside(identity.root, real)) {
    throw new ProjectArtifactError("symlink-denied", `${label} cannot be redirected outside the project.`);
  }
  assertProjectFsIdentity(identity);
  return stat;
}

function assertDirectoryUnchanged(
  identity: ProjectFsIdentity,
  directory: string,
  expected: fs.BigIntStats,
  label: string,
): void {
  if (sameCanonicalPath(directory, identity.root)) {
    assertProjectFsIdentity(identity);
    const current = fs.lstatSync(identity.root, { bigint: true });
    if (!sameFsObject(expected, current)) projectPathError(`${label} changed during memory provisioning.`);
    return;
  }
  const current = assertRealProjectDirectory(identity, directory, label);
  if (!sameFsObject(expected, current)) projectPathError(`${label} changed during memory provisioning.`);
}

function ensureRealProjectDirectory(
  identity: ProjectFsIdentity,
  directory: string,
  label: string,
): fs.BigIntStats {
  const resolved = path.resolve(directory);
  if (!pathIsInside(identity.root, resolved) || sameCanonicalPath(identity.root, resolved)) {
    throw new ProjectArtifactError("path-traversal", `${label} must stay below the project root.`);
  }
  const relative = path.relative(identity.root, resolved);
  let parent = identity.root;
  let parentStat = identity.stat;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    const current = path.join(parent, part);
    assertProjectFsIdentity(identity);
    assertDirectoryUnchanged(
      identity,
      parent,
      parentStat,
      sameCanonicalPath(parent, identity.root) ? "The project root" : "A project memory parent directory",
    );
    let stat = lstatBigIntOrNull(current);
    if (!stat) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatBigIntOrNull(current);
    }
    if (stat?.isSymbolicLink()) {
      throw new ProjectArtifactError("symlink-denied", `${label} must not contain symbolic links.`);
    }
    if (!stat || !stat.isDirectory()) {
      throw new ProjectArtifactError("not-a-directory", `${label} must be a real directory.`);
    }
    const real = fs.realpathSync.native(current);
    if (!sameCanonicalPath(real, current) || !pathIsInside(identity.root, real)) {
      throw new ProjectArtifactError("symlink-denied", `${label} cannot be redirected outside the project.`);
    }
    assertDirectoryUnchanged(
      identity,
      parent,
      parentStat,
      sameCanonicalPath(parent, identity.root) ? "The project root" : "A project memory parent directory",
    );
    parent = current;
    parentStat = stat;
  }
  return assertRealProjectDirectory(identity, resolved, label);
}

function assertSafeProjectFile(
  identity: ProjectFsIdentity,
  filePath: string,
  label: string,
): fs.BigIntStats | null {
  const resolved = path.resolve(filePath);
  if (!pathIsInside(identity.root, resolved) || sameCanonicalPath(identity.root, resolved)) {
    throw new ProjectArtifactError("path-traversal", `${label} must stay below the project root.`);
  }
  const parent = path.dirname(resolved);
  if (sameCanonicalPath(parent, identity.root)) {
    assertProjectFsIdentity(identity);
  } else {
    assertRealProjectDirectory(identity, parent, `${label} parent directory`);
  }
  const stat = lstatBigIntOrNull(resolved);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    throw new ProjectArtifactError("symlink-denied", `${label} must not be a symbolic link.`);
  }
  if (!stat.isFile()) {
    throw new ProjectArtifactError("not-a-regular-file", `${label} must be a regular file.`);
  }
  if (stat.nlink !== 1n) {
    throw new ProjectArtifactError("hardlink-denied", `${label} must not be hard-linked.`);
  }
  const real = fs.realpathSync.native(resolved);
  if (!sameCanonicalPath(real, resolved) || !pathIsInside(identity.root, real)) {
    throw new ProjectArtifactError("symlink-denied", `${label} cannot be redirected outside the project.`);
  }
  assertProjectFsIdentity(identity);
  return stat;
}

function openNoFollow(target: string, flags: number, mode?: number): number {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  try {
    return fs.openSync(target, flags | noFollow, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== "win32" ||
      noFollow === 0 ||
      (code !== "EINVAL" && code !== "ENOTSUP")
    ) throw error;
    return fs.openSync(target, flags, mode);
  }
}

function readStableProjectText(
  identity: ProjectFsIdentity,
  filePath: string,
  label: string,
  maximumBytes?: bigint,
): { content: string; stat: fs.BigIntStats } | null {
  const before = assertSafeProjectFile(identity, filePath, label);
  if (!before) return null;
  if (maximumBytes !== undefined && before.size > maximumBytes) {
    throw new ProjectArtifactError("limit-exceeded", `${label} exceeds the cleanup read limit.`);
  }
  const parent = path.dirname(filePath);
  const parentStat = sameCanonicalPath(parent, identity.root)
    ? identity.stat
    : assertRealProjectDirectory(identity, parent, `${label} parent directory`);
  let fd: number;
  try {
    fd = openNoFollow(filePath, fs.constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ProjectArtifactError("symlink-denied", `${label} must not be a symbolic link.`);
    }
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameStableRegularFile(before, opened)) {
      projectPathError(`${label} changed before it could be read.`);
    }
    const content = fs.readFileSync(fd, "utf8");
    const afterDescriptor = fs.fstatSync(fd, { bigint: true });
    if (!sameStableRegularFile(opened, afterDescriptor)) {
      projectPathError(`${label} changed while it was being read.`);
    }
    const afterPath = assertSafeProjectFile(identity, filePath, label);
    if (!afterPath || !sameStableRegularFile(afterDescriptor, afterPath)) {
      projectPathError(`${label} changed after it was read.`);
    }
    if (sameCanonicalPath(parent, identity.root)) {
      assertProjectFsIdentity(identity);
    } else {
      assertDirectoryUnchanged(identity, parent, parentStat, `${label} parent directory`);
    }
    return { content, stat: afterPath };
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support directory fsync; file fsync still applies.
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function atomicPrivateProjectWrite(
  identity: ProjectFsIdentity,
  filePath: string,
  content: string,
  expected: fs.BigIntStats | null,
  label: string,
): void {
  const parent = path.dirname(filePath);
  const parentStat = sameCanonicalPath(parent, identity.root)
    ? identity.stat
    : assertRealProjectDirectory(identity, parent, `${label} parent directory`);
  const current = assertSafeProjectFile(identity, filePath, label);
  if (
    (expected === null && current !== null) ||
    (expected !== null && (!current || !sameStableRegularFile(expected, current)))
  ) projectPathError(`${label} changed before the atomic write.`);

  const temporary = path.join(
    parent,
    `.${path.basename(filePath)}.agentlas-${process.pid}-${randomUUID()}.tmp`,
  );
  let tempStat: fs.BigIntStats | null = null;
  try {
    const fd = openNoFollow(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) {
        projectPathError(`The temporary ${label} file is unsafe.`);
      }
      const bytes = Buffer.from(content, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
        if (written <= 0) projectPathError(`The temporary ${label} file could not be written completely.`);
        offset += written;
      }
      fs.fsyncSync(fd);
      tempStat = fs.fstatSync(fd, { bigint: true });
      if (!tempStat.isFile() || tempStat.nlink !== 1n || !sameFsObject(opened, tempStat)) {
        projectPathError(`The temporary ${label} file changed while it was written.`);
      }
    } finally {
      fs.closeSync(fd);
    }

    const tempPathStat = fs.lstatSync(temporary, { bigint: true });
    if (!tempStat || !sameStableRegularFile(tempStat, tempPathStat)) {
      projectPathError(`The temporary ${label} file changed before installation.`);
    }
    if (sameCanonicalPath(parent, identity.root)) {
      assertProjectFsIdentity(identity);
    } else {
      assertDirectoryUnchanged(identity, parent, parentStat, `${label} parent directory`);
    }
    const beforeRename = assertSafeProjectFile(identity, filePath, label);
    if (
      (expected === null && beforeRename !== null) ||
      (expected !== null && (!beforeRename || !sameStableRegularFile(expected, beforeRename)))
    ) projectPathError(`${label} changed before installation.`);

    fs.renameSync(temporary, filePath);
    const installed = assertSafeProjectFile(identity, filePath, label);
    if (
      !installed ||
      !tempStat ||
      !sameFsObject(tempStat, installed) ||
      tempStat.size !== installed.size ||
      tempStat.mtimeNs !== installed.mtimeNs
    ) {
      projectPathError(`${label} changed during installation.`);
    }
    if (sameCanonicalPath(parent, identity.root)) {
      assertProjectFsIdentity(identity);
    } else {
      assertDirectoryUnchanged(identity, parent, parentStat, `${label} parent directory`);
    }
    fsyncDirectory(parent);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The atomic rename normally consumes the private temporary file.
    }
  }
}

function createPrivateProjectFileIfMissing(
  identity: ProjectFsIdentity,
  filePath: string,
  content: string,
  label: string,
): boolean {
  if (assertSafeProjectFile(identity, filePath, label)) return false;
  atomicPrivateProjectWrite(identity, filePath, content, null, label);
  return true;
}

function writePrivateProjectTextIfChanged(
  identity: ProjectFsIdentity,
  filePath: string,
  content: string,
  label: string,
): boolean {
  const existing = readStableProjectText(identity, filePath, label);
  if (existing?.content === content) return false;
  atomicPrivateProjectWrite(identity, filePath, content, existing?.stat ?? null, label);
  return true;
}

function credentialIndexSectionTemplate(): string {
  return `${CREDENTIAL_INDEX_SECTION}

- For deploy, release, store, billing, auth, API, or cloud work, read
  .agentlas/${LOCAL_CREDENTIALS_MAP_FILE} before saying a credential is missing.
- Real values may live in .env, .env.local, ${PROJECT_SIGNING_DIR}/,
  ${PROJECT_CREDENTIALS_DIR}/, local keychain/vault, or project-scoped global env
  keys like AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME>.
- Keep this memory value-free: record env names, local relative paths, owner,
  stale-check notes, and validation commands only.

| Need | Look here first | Memory record |
|------|-----------------|---------------|
| Scalar env key | .env or .env.local | env name only |
| Store/signing file | ${PROJECT_SIGNING_DIR}/ | relative path only |
| App/provider config | ${PROJECT_CREDENTIALS_DIR}/ | relative path only |
| Shared local env | AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME> | project-scoped env name |
`;
}

function soulTemplate(projectName: string): string {
  return `# Project Soul Memory: ${projectName}

Durable memory for this project folder, maintained by the Agentlas PM Soul.
Keep it concise. Auto-curated items are appended under the last section.

${credentialIndexSectionTemplate()}

## Project Purpose

## Current State

## Decisions

| Date | Decision | Rationale | Evidence |
|------|----------|-----------|----------|

## Pending Work

| Owner | Workstream | Next Action | Status |
|-------|------------|-------------|--------|

## Risks

| Risk | Impact | Mitigation | Status |
|------|--------|------------|--------|

## User Preferences

## Lessons Learned

${AUTO_SECTION}
`;
}

function ensureSoulCredentialIndex(identity: ProjectFsIdentity, soulPath: string): void {
  const existing = readStableProjectText(identity, soulPath, "The project soul file");
  if (!existing) return;
  const content = existing.content;
  if (content.includes(CREDENTIAL_INDEX_SECTION)) return;
  const section = credentialIndexSectionTemplate();
  const marker = "\n## Project Purpose";
  const next = content.includes(marker)
    ? content.replace(marker, `\n${section}\n## Project Purpose`)
    : `${content.trimEnd()}\n\n${section}\n`;
  atomicPrivateProjectWrite(
    identity,
    soulPath,
    next.endsWith("\n") ? next : `${next}\n`,
    existing.stat,
    "The project soul file",
  );
}

// The sitemap walker owns exactly these node kinds. Every other kind belongs to
// whoever maintains the map by hand and survives a refresh untouched.
const GENERATOR_OWNED_SITEMAP_KINDS: ReadonlySet<string> = new Set(["directory", "file"]);

function sitemapSkeleton(projectName: string, now: string): string {
  return JSON.stringify(
    {
      project: projectName,
      created_at: now,
      updated_at: now,
      priority_policy:
        "priority = risk_weight*risk + (1 - completion_score) + staleness + blocking_dependencies",
      nodes: [],
    },
    null,
    2,
  );
}

function sitemapRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Refresh the deterministic file tree while preserving user-maintained node
 * annotations. Returns null without writing when the existing sitemap is a
 * hand-maintained artifact this generator did not produce.
 */
export function refreshProjectSitemap(projectPath: string): ProjectSitemap | null {
  try {
    const identity = resolveProjectFsIdentity(projectPath);
    const dir = path.join(identity.root, PROJECT_MEMORY_DIR);
    ensureRealProjectDirectory(identity, dir, "The project memory directory");
    const outputPath = path.join(dir, SITEMAP_FILE);

    let previous: Record<string, unknown> | null = null;
    try {
      const existing = readStableProjectText(identity, outputPath, "The project sitemap");
      previous = existing ? sitemapRecord(JSON.parse(existing.content)) : null;
    } catch {
      previous = null;
    }

    // One sitemap holds two kinds of node by design. The walker owns the file
    // tree (kind "directory"/"file"); an operator owns surface nodes — ui-route,
    // interaction-surface, runtime-flow, release-gate — under the same schema
    // the Task Bias role definition in ../architecture/manifest.ts describes.
    // No directory walk can reconstruct those, and the kind+relative_path merge
    // below cannot match them (they have no relative_path), so carry them
    // through untouched instead of regenerating over them.
    const curatedNodes = (Array.isArray(previous?.nodes) ? previous.nodes : [])
      .map((candidate) => sitemapRecord(candidate))
      .filter((node): node is Record<string, unknown> =>
        Boolean(node) && typeof node!.kind === "string" &&
        !GENERATOR_OWNED_SITEMAP_KINDS.has(node!.kind as string));

    let generated: ProjectSitemap;
    try {
      generated = generateProjectSitemap(projectPath, {
        maxEntries: PROJECT_SITEMAP_MAX_ENTRIES,
      });
    } catch (error) {
      if (!(error instanceof ProjectArtifactError) || error.code !== "race-detected") throw error;
      // A build may atomically replace one directory while the sitemap walks.
      // Retry once from a fresh root identity; persistent churn still defers.
      generated = generateProjectSitemap(projectPath, {
        maxEntries: PROJECT_SITEMAP_MAX_ENTRIES,
      });
    }

    const previousNodes = new Map<string, Record<string, unknown>>();
    if (Array.isArray(previous?.nodes)) {
      for (const candidate of previous.nodes) {
        const node = sitemapRecord(candidate);
        if (!node) continue;
        const kind = node.kind === "directory" || node.kind === "file" ? node.kind : null;
        const relativePath = typeof node.relative_path === "string" ? node.relative_path : null;
        if (kind && relativePath) previousNodes.set(`${kind}\0${relativePath}`, node);
      }
    }
    generated.nodes = generated.nodes.map((node) => {
      const old = previousNodes.get(`${node.kind}\0${node.relative_path}`);
      if (!old) return node;
      return {
        ...node,
        status: typeof old.status === "string" ? old.status : node.status,
        completion_score: typeof old.completion_score === "number"
          ? Math.max(0, Math.min(1, old.completion_score))
          : node.completion_score,
        risk_level: typeof old.risk_level === "string" ? old.risk_level : node.risk_level,
        last_modified: typeof old.last_modified === "string" ? old.last_modified : node.last_modified,
        last_tested: typeof old.last_tested === "string" ? old.last_tested : node.last_tested,
        dependencies: Array.isArray(old.dependencies) ? old.dependencies : node.dependencies,
        acceptance_checks: Array.isArray(old.acceptance_checks) ? old.acceptance_checks : node.acceptance_checks,
        evidence: Array.isArray(old.evidence) ? old.evidence : node.evidence,
        provisional: typeof old.provisional === "boolean" ? old.provisional : node.provisional,
      } as typeof node;
    });
    // Operator-owned nodes lead: they carry the real priority signal, and they
    // cannot join the walker's relative_path ordering anyway.
    generated.nodes = [
      ...(curatedNodes as unknown as typeof generated.nodes),
      ...generated.nodes,
    ];
    writePrivateProjectTextIfChanged(
      identity,
      outputPath,
      `${JSON.stringify(generated, null, 2)}\n`,
      "The project sitemap",
    );
    return generated;
  } catch (error) {
    console.warn(`[memory] sitemap refresh deferred: ${error instanceof Error ? error.message : "unknown"}`);
    return null;
  }
}

function ontologyRuntimeSkeleton(projectPath: string, projectName: string): string {
  const dir = path.join(projectPath, PROJECT_MEMORY_DIR);
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-ontology-runtime",
      state: "active",
      activation: "automatic",
      projectRoot: projectPath,
      projectName,
      dbPath: path.join(dir, ONTOLOGY_DB_FILE),
      inboxPath: path.join(dir, ONTOLOGY_INBOX_DIR),
      sourceManifest: path.join(dir, ONTOLOGY_SOURCE_MANIFEST_FILE),
      defaultScope: "internal",
      autoIngestPolicy: {
        mode: "inbox_and_registered_sources_only",
        neverScanHomeDirectory: true,
        neverScanSiblingProjects: true,
        crossProjectSearchDefault: "disabled",
        privateScopeDefaultSearch: "excluded",
      },
      promotionMode: {
        operatorManagedLocal: true,
        securityGateMode: "context_folder_routing_only",
        blockingSecurityGate: false,
        notes:
          "Local promotion is blocked by missing project/folder/owner/evidence/rollback structure, not by a generic security gate.",
      },
      memoryPolicy: {
        durableWrites: "candidate-ticket-only",
        workingMemory: "runtime-cache-only",
      },
    },
    null,
    2,
  );
}

function ontologySourceManifestSkeleton(projectPath: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-ontology-source-manifest",
      projectRoot: projectPath,
      sources: [],
    },
    null,
    2,
  );
}

function careerGraphSkeleton(projectPath: string, projectName: string): string {
  const dir = path.join(projectPath, PROJECT_MEMORY_DIR);
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-career-graph",
      state: "active",
      model: "ledger_first_derived_index",
      projectRoot: projectPath,
      projectName,
      dbPath: path.join(dir, CAREER_GRAPH_DB_FILE),
      inboxPath: path.join(dir, CAREER_GRAPH_INBOX_DIR),
      sourceManifest: path.join(dir, CAREER_GRAPH_SOURCE_MANIFEST_FILE),
      canonicalSourcePolicy: {
        sourceOfTruth: "markdown_jsonl_json",
        graphIsRebuildable: true,
        fallbackWhenStale: "read_canonical_files",
        neverScanHomeDirectory: true,
        neverScanSiblingProjects: true,
      },
    },
    null,
    2,
  );
}

function careerGraphSourceManifestSkeleton(projectPath: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-career-graph-source-manifest",
      projectRoot: projectPath,
      sources: [],
    },
    null,
    2,
  );
}

function localCredentialsMapSkeleton(projectPath: string, projectName: string, now: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-local-credential-store",
      projectName,
      projectRoot: projectPath,
      createdAt: now,
      updatedAt: now,
      envFiles: [".env", ".env.local"],
      secretDirs: [PROJECT_SIGNING_DIR, PROJECT_CREDENTIALS_DIR],
      entries: [],
    },
    null,
    2,
  );
}

function envExampleTemplate(): string {
  return `# Agentlas local project environment.
# Copy this file to .env and fill real values only on this machine.

# File-path style for tools that expect a local JSON credential file.
SUPPLY_JSON_KEY=${PROJECT_SIGNING_DIR}/google-play.json

# Inline JSON style for tools that support reading a credential directly from env.
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=
`;
}

function signingReadmeTemplate(): string {
  return `# ${PROJECT_SIGNING_DIR}/

Put release signing material here when this project needs local deploy or store
automation. This folder is ignored by git except for this README.

Examples:

- Google Play release JSON used by SUPPLY_JSON_KEY
- Apple signing certificates or provisioning profiles
- Notarization or release upload keys

Do not commit files from this folder.
`;
}

function credentialsReadmeTemplate(): string {
  return `# ${PROJECT_CREDENTIALS_DIR}/

Put app or service configuration files here when this project needs local runtime
access. This folder is ignored by git except for this README.

Examples:

- Android google-services.json
- iOS GoogleService-Info.plist
- provider config files used only by this local project

Do not commit files from this folder.
`;
}

// Everything Agentlas writes into a user's project that describes THEM rather
// than the product: their directory layout, their code index, their project
// memory, their work log. These are per-machine outputs of features each user
// runs on their own files — nobody else consumes another person's copy — and
// publishing one leaks the shape of a private working tree. Keep them out of
// git by default. Listed separately so the migration path below can add them to
// projects provisioned before this existed.
const AGENTLAS_PRIVATE_PROJECT_STATE_IGNORE: readonly string[] = [
  `.agentlas/${SITEMAP_FILE}`,
  ".agentlas/code-map/",
  `.agentlas/${PROJECT_SOUL_FILE}`,
  `.agentlas/${MEMORY_LOG_FILE}`,
  `.agentlas/${CURATOR_DECISIONS_FILE}`,
  `.agentlas/${SKILL_TRIALS_FILE}`,
  `.agentlas/${LOCAL_CREDENTIALS_MAP_FILE}`,
];

function ensureAgentlasCredentialIgnore(identity: ProjectFsIdentity): void {
  const gitignorePath = path.join(identity.root, ".gitignore");
  const marker = "# Agentlas local credentials";
  const block = `${marker}
.env
.env.local
.env.*.local
._*
${PROJECT_SIGNING_DIR}/*
!${PROJECT_SIGNING_DIR}/
!${PROJECT_SIGNING_DIR}/${PROJECT_CREDENTIALS_README_FILE}
${PROJECT_CREDENTIALS_DIR}/*
!${PROJECT_CREDENTIALS_DIR}/
!${PROJECT_CREDENTIALS_DIR}/${PROJECT_CREDENTIALS_README_FILE}
.agentlas/${ONTOLOGY_DB_FILE}*
.agentlas/${CAREER_GRAPH_DB_FILE}*
.agentlas/${EXPERIENCE_RELATION_LEDGER_FILE}*
.agentlas/.${EXPERIENCE_RELATION_LEDGER_FILE}.*
${AGENTLAS_PRIVATE_PROJECT_STATE_IGNORE.join("\n")}
`;
  const existingRead = readStableProjectText(identity, gitignorePath, "The project .gitignore");
  const existing = existingRead?.content ?? "";
  if (existing.includes(marker)) {
    const requiredLines = [
      "._*",
      `.agentlas/${ONTOLOGY_DB_FILE}*`,
      `.agentlas/${CAREER_GRAPH_DB_FILE}*`,
      `.agentlas/${EXPERIENCE_RELATION_LEDGER_FILE}*`,
      `.agentlas/.${EXPERIENCE_RELATION_LEDGER_FILE}.*`,
      ...AGENTLAS_PRIVATE_PROJECT_STATE_IGNORE,
    ];
    let next = existing.trimEnd();
    for (const line of requiredLines) {
      if (!next.split(/\r?\n/).includes(line)) next += `\n${line}`;
    }
    next += "\n";
    if (next !== existing) {
      atomicPrivateProjectWrite(
        identity,
        gitignorePath,
        next,
        existingRead?.stat ?? null,
        "The project .gitignore",
      );
    }
    return;
  }
  const next = existing.trimEnd()
    ? `${existing.trimEnd()}\n\n${block}`
    : `${block}`;
  atomicPrivateProjectWrite(
    identity,
    gitignorePath,
    next.endsWith("\n") ? next : `${next}\n`,
    existingRead?.stat ?? null,
    "The project .gitignore",
  );
}

function ensureLocalCredentialStore(identity: ProjectFsIdentity, projectName: string, now: string): void {
  const projectPath = identity.root;
  const dir = projectMemoryDir(projectPath);
  const signingDir = path.join(projectPath, PROJECT_SIGNING_DIR);
  const credentialsDir = path.join(projectPath, PROJECT_CREDENTIALS_DIR);
  ensureRealProjectDirectory(identity, signingDir, "The project signing directory");
  ensureRealProjectDirectory(identity, credentialsDir, "The project credentials directory");

  const envExample = path.join(projectPath, PROJECT_ENV_EXAMPLE_FILE);
  createPrivateProjectFileIfMissing(
    identity,
    envExample,
    envExampleTemplate(),
    "The project environment example",
  );

  const signingReadme = path.join(signingDir, PROJECT_CREDENTIALS_README_FILE);
  createPrivateProjectFileIfMissing(
    identity,
    signingReadme,
    signingReadmeTemplate(),
    "The signing directory README",
  );

  const credentialsReadme = path.join(credentialsDir, PROJECT_CREDENTIALS_README_FILE);
  createPrivateProjectFileIfMissing(
    identity,
    credentialsReadme,
    credentialsReadmeTemplate(),
    "The credentials directory README",
  );

  const localCredentialsMap = path.join(dir, LOCAL_CREDENTIALS_MAP_FILE);
  createPrivateProjectFileIfMissing(
    identity,
    localCredentialsMap,
    localCredentialsMapSkeleton(projectPath, projectName, now),
    "The local credentials map",
  );

  ensureAgentlasCredentialIgnore(identity);
}

function skillRegistrySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-skill-lifecycle-registry",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      defaultTier: "candidate",
      runtimeFirstClassRecallEnabled: false,
      predicatesRequired: true,
      curatorQuarantineRequired: true,
      evidenceLedgers: {
        trials: `.agentlas/${SKILL_TRIALS_FILE}`,
        curatorDecisions: `.agentlas/${CURATOR_DECISIONS_FILE}`,
        memoryEvents: `.agentlas/${MEMORY_LOG_FILE}`,
      },
      hardStops: [
        "permission_change",
        "credential_change",
        "payment_or_billing_effect",
        "regulated_or_irreversible_side_effect",
        "same_authority_patch_and_validator",
        "holdout_contamination",
        "missing_rollback_snapshot",
      ],
      effectiveErrorBudgetTerms: [
        "first_class_error_mass",
        "quarantine_false_accept_estimate",
        "blind_spot_estimate",
        "drift_estimate",
      ],
      niches: [],
      skills: [],
      rolloutPolicy: {
        staticOnlyCanApprove: false,
        sandboxRequired: true,
        holdoutRequired: true,
        shadowRequiredForFastPathChanges: true,
        lowRiskCanaryOnly: true,
        severeFailureTolerance: 0,
      },
    },
    null,
    2,
  );
}

const PROJECT_ONTOLOGY_INDEX_FILE = "agentlas-project-index.md";

function projectProvisionDirectories(projectRoot: string): string[] {
  const memoryRoot = path.join(projectRoot, PROJECT_MEMORY_DIR);
  return [
    memoryRoot,
    path.join(projectRoot, PROJECT_SIGNING_DIR),
    path.join(projectRoot, PROJECT_CREDENTIALS_DIR),
    path.join(memoryRoot, ONTOLOGY_INBOX_DIR),
    path.join(memoryRoot, PROJECT_PM_DIR),
    path.join(memoryRoot, CAREER_GRAPH_INBOX_DIR),
  ];
}

function projectProvisionFiles(projectRoot: string): string[] {
  const memoryRoot = path.join(projectRoot, PROJECT_MEMORY_DIR);
  const memoryFiles = [
    PROJECT_SOUL_FILE,
    SITEMAP_FILE,
    MEMORY_LOG_FILE,
    LOCAL_CREDENTIALS_MAP_FILE,
    SKILL_REGISTRY_FILE,
    SKILL_TRIALS_FILE,
    CURATOR_DECISIONS_FILE,
    ONTOLOGY_RUNTIME_FILE,
    ONTOLOGY_SOURCE_MANIFEST_FILE,
    ONTOLOGY_DB_FILE,
    `${ONTOLOGY_DB_FILE}-wal`,
    `${ONTOLOGY_DB_FILE}-shm`,
    `${ONTOLOGY_DB_FILE}-journal`,
    CAREER_GRAPH_CONFIG_FILE,
    CAREER_GRAPH_SOURCE_MANIFEST_FILE,
    CAREER_GRAPH_DB_FILE,
    `${CAREER_GRAPH_DB_FILE}-wal`,
    `${CAREER_GRAPH_DB_FILE}-shm`,
    `${CAREER_GRAPH_DB_FILE}-journal`,
    EXPERIENCE_RELATION_LEDGER_FILE,
  ];
  return [
    path.join(projectRoot, ".gitignore"),
    path.join(projectRoot, PROJECT_ENV_EXAMPLE_FILE),
    path.join(projectRoot, PROJECT_SIGNING_DIR, PROJECT_CREDENTIALS_README_FILE),
    path.join(projectRoot, PROJECT_CREDENTIALS_DIR, PROJECT_CREDENTIALS_README_FILE),
    ...memoryFiles.map((fileName) => path.join(memoryRoot, fileName)),
    path.join(memoryRoot, ONTOLOGY_INBOX_DIR, PROJECT_ONTOLOGY_INDEX_FILE),
  ];
}

/** Validate every path the provisioner may touch before the first write. */
function preflightProjectProvisionTargets(identity: ProjectFsIdentity): void {
  assertProjectFsIdentity(identity);
  const directories = projectProvisionDirectories(identity.root)
    .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length);
  for (const directory of directories) {
    if (!lstatBigIntOrNull(directory)) continue;
    assertRealProjectDirectory(identity, directory, "A project provision directory");
  }
  for (const filePath of projectProvisionFiles(identity.root)) {
    const parent = path.dirname(filePath);
    if (!sameCanonicalPath(parent, identity.root) && !lstatBigIntOrNull(parent)) continue;
    assertSafeProjectFile(identity, filePath, "A project provision target");
  }
  assertProjectFsIdentity(identity);
}

/** Create .agentlas/ + skeleton files if missing. Returns the dir, or null on failure. */
export function ensureProjectMemory(
  projectPath: string,
  projectName?: string,
): string | null {
  try {
    const identity = resolveProjectFsIdentity(projectPath);
    preflightProjectProvisionTargets(identity);
    const projectRoot = identity.root;
    const dir = projectMemoryDir(projectRoot);
    for (const directory of projectProvisionDirectories(projectRoot)) {
      ensureRealProjectDirectory(identity, directory, "A project provision directory");
    }
    // Recheck every target after directory creation but before the first file write.
    preflightProjectProvisionTargets(identity);
    const name = projectName || path.basename(projectRoot) || "Project";
    const now = new Date().toISOString();
    ensureLocalCredentialStore(identity, name, now);

    const soul = path.join(dir, PROJECT_SOUL_FILE);
    createPrivateProjectFileIfMissing(identity, soul, soulTemplate(name), "The project soul file");
    ensureSoulCredentialIndex(identity, soul);

    const sitemap = path.join(dir, SITEMAP_FILE);
    const sitemapRead = readStableProjectText(identity, sitemap, "The project sitemap");
    let sitemapNeedsGeneration = !sitemapRead;
    if (sitemapRead) {
      try {
        const existing = JSON.parse(sitemapRead.content) as { state?: unknown; nodes?: unknown };
        sitemapNeedsGeneration = existing.state !== "generated" || !Array.isArray(existing.nodes) || existing.nodes.length === 0;
      } catch {
        sitemapNeedsGeneration = true;
      }
    }
    if (sitemapNeedsGeneration && !refreshProjectSitemap(projectRoot)) {
      createPrivateProjectFileIfMissing(
        identity,
        sitemap,
        sitemapSkeleton(name, now),
        "The project sitemap",
      );
    }

    const skillRegistry = path.join(dir, SKILL_REGISTRY_FILE);
    createPrivateProjectFileIfMissing(
      identity,
      skillRegistry,
      skillRegistrySkeleton(name),
      "The project skill registry",
    );

    const ontologyInbox = path.join(dir, ONTOLOGY_INBOX_DIR);
    ensureRealProjectDirectory(identity, ontologyInbox, "The project ontology inbox");

    const projectPm = path.join(dir, PROJECT_PM_DIR);
    ensureRealProjectDirectory(identity, projectPm, "The project PM directory");

    const ontologyRuntime = path.join(dir, ONTOLOGY_RUNTIME_FILE);
    createPrivateProjectFileIfMissing(
      identity,
      ontologyRuntime,
      ontologyRuntimeSkeleton(projectRoot, name),
      "The ontology runtime config",
    );

    const ontologySources = path.join(dir, ONTOLOGY_SOURCE_MANIFEST_FILE);
    createPrivateProjectFileIfMissing(
      identity,
      ontologySources,
      ontologySourceManifestSkeleton(projectRoot),
      "The ontology source manifest",
    );

    const careerGraphInbox = path.join(dir, CAREER_GRAPH_INBOX_DIR);
    ensureRealProjectDirectory(identity, careerGraphInbox, "The career graph inbox");

    const careerGraphConfig = path.join(dir, CAREER_GRAPH_CONFIG_FILE);
    createPrivateProjectFileIfMissing(
      identity,
      careerGraphConfig,
      careerGraphSkeleton(projectRoot, name),
      "The career graph config",
    );

    const careerGraphSources = path.join(dir, CAREER_GRAPH_SOURCE_MANIFEST_FILE);
    createPrivateProjectFileIfMissing(
      identity,
      careerGraphSources,
      careerGraphSourceManifestSkeleton(projectRoot),
      "The career graph source manifest",
    );

    const skillTrials = path.join(dir, SKILL_TRIALS_FILE);
    createPrivateProjectFileIfMissing(identity, skillTrials, "", "The project skill trial ledger");

    const curatorDecisions = path.join(dir, CURATOR_DECISIONS_FILE);
    createPrivateProjectFileIfMissing(identity, curatorDecisions, "", "The curator decision ledger");

    preflightProjectProvisionTargets(identity);
    return dir;
  } catch {
    return null;
  }
}

export function readProjectSoul(projectPath: string): string | null {
  try {
    return fs.readFileSync(path.join(projectMemoryDir(projectPath), PROJECT_SOUL_FILE), "utf8");
  } catch {
    return null;
  }
}

export function readSitemap(projectPath: string): unknown | null {
  try {
    const raw = fs.readFileSync(path.join(projectMemoryDir(projectPath), SITEMAP_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function appendMemoryLog(projectPath: string, record: unknown): void {
  try {
    const dir = ensureProjectMemory(projectPath);
    if (!dir) return;
    fs.appendFileSync(
      path.join(dir, MEMORY_LOG_FILE),
      JSON.stringify(record) + "\n",
      "utf8",
    );
  } catch {
    // best-effort
  }
}

/** Append durable items under the auto-curated section of the soul file. */
export function appendSoulMemory(
  projectPath: string,
  lines: string[],
): void {
  if (lines.length === 0) return;
  try {
    const dir = ensureProjectMemory(projectPath);
    if (!dir) return;
    const soulPath = path.join(dir, PROJECT_SOUL_FILE);
    let content = "";
    try {
      content = fs.readFileSync(soulPath, "utf8");
    } catch {
      content = soulTemplate(path.basename(projectPath) || "Project");
    }
    const block = lines.map((l) => `- ${l}`).join("\n") + "\n";
    // The engine's One curator also appends project blocks to this file
    // (Agentlas-OS 4330d444). Rewriting the whole file from an earlier read
    // would drop a block written in between; with the section present, only
    // append (O_APPEND writes do not erase each other).
    if (content.includes(AUTO_SECTION) && fs.existsSync(soulPath)) {
      fs.appendFileSync(soulPath, (content.endsWith("\n") ? "" : "\n") + block, "utf8");
      return;
    }
    content += `\n${AUTO_SECTION}\n`;
    fs.writeFileSync(soulPath, content.replace(/\s*$/, "\n") + block, "utf8");
  } catch {
    // best-effort
  }
}

export interface ProjectMemoryForgetResult {
  soulRemoved: number;
  logRedacted: number;
}

function forgetContentHash(value: string): string {
  return createHash("sha256")
    .update(value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase(), "utf8")
    .digest("hex");
}

/**
 * Remove the exact auto-curated project projections of a forgotten DB entry.
 * Hand-authored soul prose is left alone; the append-only log keeps a
 * value-free tombstone in the removed record's position.
 */
export function forgetProjectMemoryProjection(
  projectPath: string,
  kind: string,
  contentHash: string,
  forgottenAt: string,
  sourceMemoryIds: string[] = [],
): ProjectMemoryForgetResult {
  const identity = resolveProjectFsIdentity(projectPath);
  const dir = projectMemoryDir(identity.root);
  const soulPath = path.join(dir, PROJECT_SOUL_FILE);
  const logPath = path.join(dir, MEMORY_LOG_FILE);
  let soulRemoved = 0;
  let logRedacted = 0;

  const soul = readStableProjectText(
    identity,
    soulPath,
    "The project soul file",
    MEMORY_PROJECTION_CLEANUP_MAX_FILE_BYTES,
  );
  if (soul) {
    const hadTrailingNewline = soul.content.endsWith("\n");
    let inAutoSection = false;
    const kept = soul.content.split(/\r?\n/).filter((line) => {
      if (line.trim() === AUTO_SECTION) {
        inAutoSection = true;
        return true;
      }
      if (/^##\s+/.test(line) && line.trim() !== AUTO_SECTION) inAutoSection = false;
      const match = /^- \(([^)]+)\) (.*)$/.exec(line);
      if (!inAutoSection || !match || match[1] !== kind || forgetContentHash(match[2]) !== contentHash) return true;
      soulRemoved += 1;
      return false;
    });
    if (soulRemoved > 0) {
      const next = kept.join("\n").replace(/\n{3,}/g, "\n\n");
      atomicPrivateProjectWrite(
        identity,
        soulPath,
        hadTrailingNewline && !next.endsWith("\n") ? `${next}\n` : next,
        soul.stat,
        "The project soul file",
      );
    }
  }

  const log = readStableProjectText(
    identity,
    logPath,
    "The project memory log",
    MEMORY_PROJECTION_CLEANUP_MAX_FILE_BYTES,
  );
  if (log) {
    const sourceIds = new Set(sourceMemoryIds.map((id) => id.trim()).filter(Boolean));
    const rows = log.content.split(/\r?\n/);
    const nextRows = rows.map((line) => {
      if (!line.trim()) return line;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (
          typeof parsed.content !== "string"
          || parsed.kind !== kind
          || forgetContentHash(parsed.content) !== contentHash
        ) return line;
        const curatorProjection = parsed.action === "written"
          && (parsed.source_provenance === "assistant-turn" || parsed.source_provenance === "task-force-synthesis");
        const exactSource = curatorProjection
          && typeof parsed.memory_id === "string"
          && (sourceIds.size === 0 || sourceIds.has(parsed.memory_id));
        const legacyCuratorProjection = curatorProjection && parsed.memory_id === undefined;
        if (!exactSource && !legacyCuratorProjection) return line;
        logRedacted += 1;
        return JSON.stringify({
          action: "forgotten",
          kind,
          content_hash: contentHash,
          at: forgottenAt,
        });
      } catch {
        return line;
      }
    });
    if (logRedacted > 0) {
      atomicPrivateProjectWrite(
        identity,
        logPath,
        nextRows.join("\n"),
        log.stat,
        "The project memory log",
      );
    }
  }
  return { soulRemoved, logRedacted };
}

/** Verify the exact structured projection is absent after an idempotent retry. */
export function isProjectMemoryProjectionForgotten(
  projectPath: string,
  kind: string,
  contentHash: string,
  sourceMemoryIds: string[] = [],
): boolean {
  const identity = resolveProjectFsIdentity(projectPath);
  const dir = projectMemoryDir(identity.root);
  const soul = readStableProjectText(
    identity,
    path.join(dir, PROJECT_SOUL_FILE),
    "The project soul file",
    MEMORY_PROJECTION_CLEANUP_MAX_FILE_BYTES,
  );
  if (soul) {
    let inAutoSection = false;
    for (const line of soul.content.split(/\r?\n/)) {
      if (line.trim() === AUTO_SECTION) {
        inAutoSection = true;
        continue;
      }
      if (/^##\s+/.test(line)) inAutoSection = false;
      const match = /^- \(([^)]+)\) (.*)$/.exec(line);
      if (inAutoSection && match && match[1] === kind && forgetContentHash(match[2]) === contentHash) return false;
    }
  }
  const log = readStableProjectText(
    identity,
    path.join(dir, MEMORY_LOG_FILE),
    "The project memory log",
    MEMORY_PROJECTION_CLEANUP_MAX_FILE_BYTES,
  );
  const sourceIds = new Set(sourceMemoryIds.map((id) => id.trim()).filter(Boolean));
  if (log?.content.split(/\r?\n/).some((line) => {
    if (!line.trim()) return false;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!(typeof parsed.content === "string"
        && parsed.kind === kind
        && forgetContentHash(parsed.content) === contentHash)) return false;
      const curatorProjection = parsed.action === "written"
        && (parsed.source_provenance === "assistant-turn" || parsed.source_provenance === "task-force-synthesis");
      const exactSource = curatorProjection
        && typeof parsed.memory_id === "string"
        && (sourceIds.size === 0 || sourceIds.has(parsed.memory_id));
      return exactSource || (curatorProjection && parsed.memory_id === undefined);
    } catch {
      return false;
    }
  })) return false;
  return true;
}

const PROJECT_CLEANUP_CHUNK_BYTES = 512 * 1024;
const PROJECT_CLEANUP_MAX_LINE_BYTES = 1024 * 1024;
const PROJECT_CLEANUP_READ_BYTES = 64 * 1024;
const PROJECT_CLEANUP_CURSOR_VERSION = 1;
const PROJECT_CLEANUP_UTF8 = new TextDecoder("utf-8", { fatal: true });

interface ProjectCleanupFingerprint {
  dev: string;
  ino: string;
  birthtimeNs: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

interface ProjectCleanupCursor {
  version: 1;
  phase: "soul" | "log";
  fingerprint: ProjectCleanupFingerprint | null;
  inputOffset: number;
  outputBytes: number;
  inAutoSection: boolean;
}

export interface ProjectMemoryProjectionCleanupInput {
  targetId: string;
  cleanupToken: string;
  sourceMemoryId: string;
  projectPath: string;
  kind: string;
  contentHash: string;
  forgottenAt: string;
  progressCursor: string | null;
}

export interface ProjectMemoryProjectionCleanupResult {
  complete: boolean;
  reason: string;
  progressCursor: string | null;
}

class ProjectCleanupSourceChangedError extends Error {}
class ProjectCleanupLineTooLargeError extends Error {}
class ProjectCleanupInvalidUtf8Error extends Error {}
class ProjectCleanupTemporaryResetError extends Error {}

function cleanupFingerprint(stat: fs.BigIntStats): ProjectCleanupFingerprint {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function matchesCleanupFingerprint(
  stat: fs.BigIntStats,
  expected: ProjectCleanupFingerprint,
): boolean {
  const actual = cleanupFingerprint(stat);
  return Object.keys(actual).every((key) => (
    actual[key as keyof ProjectCleanupFingerprint] === expected[key as keyof ProjectCleanupFingerprint]
  ));
}

function initialProjectCleanupCursor(phase: ProjectCleanupCursor["phase"]): ProjectCleanupCursor {
  return {
    version: PROJECT_CLEANUP_CURSOR_VERSION,
    phase,
    fingerprint: null,
    inputOffset: 0,
    outputBytes: 0,
    inAutoSection: false,
  };
}

function parseProjectCleanupCursor(raw: string | null): ProjectCleanupCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectCleanupCursor>;
    if (
      parsed.version !== PROJECT_CLEANUP_CURSOR_VERSION
      || (parsed.phase !== "soul" && parsed.phase !== "log")
      || !Number.isSafeInteger(parsed.inputOffset)
      || !Number.isSafeInteger(parsed.outputBytes)
      || Number(parsed.inputOffset) < 0
      || Number(parsed.outputBytes) < 0
      || typeof parsed.inAutoSection !== "boolean"
    ) return null;
    let fingerprint: ProjectCleanupFingerprint | null = null;
    if (parsed.fingerprint !== null) {
      if (!parsed.fingerprint || typeof parsed.fingerprint !== "object") return null;
      const values = parsed.fingerprint as Partial<ProjectCleanupFingerprint>;
      if ([values.dev, values.ino, values.birthtimeNs, values.size, values.mtimeNs, values.ctimeNs]
        .some((value) => typeof value !== "string" || !/^\d+$/.test(value))) return null;
      fingerprint = values as ProjectCleanupFingerprint;
    }
    return {
      version: PROJECT_CLEANUP_CURSOR_VERSION,
      phase: parsed.phase,
      fingerprint,
      inputOffset: Number(parsed.inputOffset),
      outputBytes: Number(parsed.outputBytes),
      inAutoSection: parsed.inAutoSection,
    };
  } catch {
    return null;
  }
}

function projectCleanupCursorJson(cursor: ProjectCleanupCursor): string {
  return JSON.stringify(cursor);
}

function projectCleanupPaths(
  identity: ProjectFsIdentity,
  phase: ProjectCleanupCursor["phase"],
  targetId: string,
): { sourcePath: string; temporaryPath: string; label: string } {
  if (!/^mct_[0-9a-f]{32}$/.test(targetId)) {
    throw new ProjectArtifactError("invalid-input", "A canonical cleanup target is required.");
  }
  const fileName = phase === "soul" ? PROJECT_SOUL_FILE : MEMORY_LOG_FILE;
  const sourcePath = path.join(projectMemoryDir(identity.root), fileName);
  return {
    sourcePath,
    temporaryPath: path.join(
      path.dirname(sourcePath),
      `.${fileName}.agentlas-cleanup-${targetId}.tmp`,
    ),
    label: phase === "soul" ? "The project soul file" : "The project memory log",
  };
}

function removeProjectCleanupTemporary(
  identity: ProjectFsIdentity,
  temporaryPath: string,
): void {
  const stat = assertSafeProjectFile(identity, temporaryPath, "The project cleanup temporary file");
  if (!stat) return;
  fs.unlinkSync(temporaryPath);
  fsyncDirectory(path.dirname(temporaryPath));
}

function openProjectCleanupTemporary(
  identity: ProjectFsIdentity,
  temporaryPath: string,
  outputBytes: number,
  fresh: boolean,
): number {
  if (fresh) removeProjectCleanupTemporary(identity, temporaryPath);
  else {
    const existing = assertSafeProjectFile(
      identity,
      temporaryPath,
      "The project cleanup temporary file",
    );
    if (!existing || existing.size < BigInt(outputBytes)) {
      throw new ProjectCleanupTemporaryResetError();
    }
  }
  const flags = fresh
    ? fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL
    : fs.constants.O_RDWR;
  const fd = openNoFollow(temporaryPath, flags, 0o600);
  try {
    const descriptor = fs.fstatSync(fd, { bigint: true });
    const pathStat = assertSafeProjectFile(identity, temporaryPath, "The project cleanup temporary file");
    if (
      !descriptor.isFile()
      || descriptor.nlink !== 1n
      || !pathStat
      || !sameFsObject(descriptor, pathStat)
    ) {
      projectPathError("The project cleanup temporary file is unsafe.");
    }
    if (BigInt(outputBytes) > descriptor.size) {
      throw new ProjectCleanupTemporaryResetError();
    }
    fs.ftruncateSync(fd, outputBytes);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function decodeProjectCleanupLine(bytes: Buffer): string {
  try {
    return PROJECT_CLEANUP_UTF8.decode(bytes);
  } catch {
    throw new ProjectCleanupInvalidUtf8Error();
  }
}

function writeProjectCleanupBytes(fd: number, bytes: Buffer, position: number): number {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, position + offset);
    if (written <= 0) projectPathError("The project cleanup temporary file could not be written completely.");
    offset += written;
  }
  return position + offset;
}

function splitProjectCleanupLine(raw: Buffer): { body: Buffer; newline: Buffer } {
  if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) {
    return { body: raw, newline: Buffer.alloc(0) };
  }
  if (raw.length >= 2 && raw[raw.length - 2] === 0x0d) {
    return { body: raw.subarray(0, raw.length - 2), newline: raw.subarray(raw.length - 2) };
  }
  return { body: raw.subarray(0, raw.length - 1), newline: raw.subarray(raw.length - 1) };
}

function transformProjectCleanupLine(
  raw: Buffer,
  cursor: ProjectCleanupCursor,
  input: ProjectMemoryProjectionCleanupInput,
): { output: Buffer; inAutoSection: boolean } {
  const { body, newline } = splitProjectCleanupLine(raw);
  const line = decodeProjectCleanupLine(body);
  if (cursor.phase === "soul") {
    let inAutoSection = cursor.inAutoSection;
    if (line.trim() === AUTO_SECTION) inAutoSection = true;
    else if (/^##\s+/.test(line)) inAutoSection = false;
    const match = /^- \(([^)]+)\) (.*)$/.exec(line);
    const remove = Boolean(
      inAutoSection
      && match
      && match[1] === input.kind
      && forgetContentHash(match[2]) === input.contentHash,
    );
    return { output: remove ? Buffer.alloc(0) : raw, inAutoSection };
  }
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const curatorProjection = parsed.action === "written"
      && (parsed.source_provenance === "assistant-turn" || parsed.source_provenance === "task-force-synthesis");
    const exactSource = curatorProjection && parsed.memory_id === projectionMemoryId(input.sourceMemoryId);
    const legacySource = curatorProjection && parsed.memory_id === undefined;
    if (
      typeof parsed.content === "string"
      && parsed.kind === input.kind
      && forgetContentHash(parsed.content) === input.contentHash
      && (exactSource || legacySource)
    ) {
      return {
        output: Buffer.concat([
          Buffer.from(JSON.stringify({
            action: "forgotten",
            kind: input.kind,
            content_hash: input.contentHash,
            at: input.forgottenAt,
          }), "utf8"),
          newline,
        ]),
        inAutoSection: false,
      };
    }
  } catch (error) {
    if (error instanceof ProjectCleanupInvalidUtf8Error) throw error;
  }
  return { output: raw, inAutoSection: false };
}

/**
 * The memory id a projection line was written under. An original-wording twin
 * cleanup target (English migration, revocations.ts) carries the memory id plus
 * a suffix so it can have its own lease row; the soul/log lines carry the id.
 */
function projectionMemoryId(sourceMemoryId: string): string {
  return sourceMemoryId.endsWith(NATIVE_TWIN_SOURCE_SUFFIX)
    ? sourceMemoryId.slice(0, -NATIVE_TWIN_SOURCE_SUFFIX.length)
    : sourceMemoryId;
}

function withCurrentProjectCleanupLease<T>(
  input: ProjectMemoryProjectionCleanupInput,
  operation: () => T,
): { executed: boolean; value: T | null } {
  return getDb().transaction(() => {
    const current = getDb().prepare(
      `SELECT 1
         FROM memory_revocation_cleanup_targets target
        WHERE target.target_id = ? AND target.source_memory_id = ?
          AND target.state = 'leased' AND target.lease_kind = 'cleanup'
          AND target.lease_token = ? AND target.revocation_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM memory_revocation_sources source
             WHERE source.source_memory_id = target.source_memory_id
               AND source.revocation_id = target.revocation_id
          )`,
    ).get(input.targetId, input.sourceMemoryId, input.cleanupToken);
    if (!current) return { executed: false, value: null };
    return { executed: true, value: operation() };
  }).immediate();
}

function projectCleanupFilesFitImmediatePath(identity: ProjectFsIdentity): boolean {
  for (const [fileName, label] of [
    [PROJECT_SOUL_FILE, "The project soul file"],
    [MEMORY_LOG_FILE, "The project memory log"],
  ] as const) {
    const stat = assertSafeProjectFile(identity, path.join(projectMemoryDir(identity.root), fileName), label);
    if (stat && stat.size > MEMORY_PROJECTION_CLEANUP_MAX_FILE_BYTES) return false;
  }
  return true;
}

function finalizeProjectCleanupTemporaryUnderLease(
  identity: ProjectFsIdentity,
  sourcePath: string,
  temporaryPath: string,
  sourceFingerprint: ProjectCleanupFingerprint,
): void {
  const sourceStat = assertSafeProjectFile(identity, sourcePath, "The project projection source file");
  if (!sourceStat || !matchesCleanupFingerprint(sourceStat, sourceFingerprint)) {
    throw new ProjectCleanupSourceChangedError();
  }
  const temporaryStat = assertSafeProjectFile(
    identity,
    temporaryPath,
    "The project cleanup temporary file",
  );
  if (!temporaryStat) projectPathError("The project cleanup temporary file disappeared.");
  fs.renameSync(temporaryPath, sourcePath);
  const installed = assertSafeProjectFile(identity, sourcePath, "The project projection source file");
  if (!installed || !sameFsObject(temporaryStat, installed) || installed.size !== temporaryStat.size) {
    projectPathError("The project cleanup replacement changed during installation.");
  }
  fsyncDirectory(path.dirname(sourcePath));
}

function streamProjectCleanupChunkUnderLease(
  input: ProjectMemoryProjectionCleanupInput,
  identity: ProjectFsIdentity,
  cursorValue: ProjectCleanupCursor,
): ProjectMemoryProjectionCleanupResult {
  const paths = projectCleanupPaths(identity, cursorValue.phase, input.targetId);
  const sourceStat = assertSafeProjectFile(identity, paths.sourcePath, paths.label);
  if (!sourceStat) {
    removeProjectCleanupTemporary(identity, paths.temporaryPath);
    if (cursorValue.phase === "soul") {
      return {
        complete: false,
        reason: "project-projection-continued",
        progressCursor: projectCleanupCursorJson(initialProjectCleanupCursor("log")),
      };
    }
    return { complete: true, reason: "project-projection-absent", progressCursor: null };
  }

  const fresh = cursorValue.fingerprint === null;
  const cursor: ProjectCleanupCursor = fresh
    ? { ...initialProjectCleanupCursor(cursorValue.phase), fingerprint: cleanupFingerprint(sourceStat) }
    : cursorValue;
  if (!cursor.fingerprint || !matchesCleanupFingerprint(sourceStat, cursor.fingerprint)) {
    removeProjectCleanupTemporary(identity, paths.temporaryPath);
    return {
      complete: false,
      reason: "project-projection-source-changed",
      progressCursor: projectCleanupCursorJson(initialProjectCleanupCursor(cursor.phase)),
    };
  }

  let sourceFd: number | null = null;
  let temporaryFd: number | null = null;
  try {
    sourceFd = openNoFollow(paths.sourcePath, fs.constants.O_RDONLY);
    const openedSource = fs.fstatSync(sourceFd, { bigint: true });
    if (!openedSource.isFile() || openedSource.nlink !== 1n || !matchesCleanupFingerprint(openedSource, cursor.fingerprint)) {
      throw new ProjectCleanupSourceChangedError();
    }
    temporaryFd = openProjectCleanupTemporary(
      identity,
      paths.temporaryPath,
      cursor.outputBytes,
      fresh,
    );
    let inputOffset = cursor.inputOffset;
    let outputBytes = cursor.outputBytes;
    let inAutoSection = cursor.inAutoSection;
    let processedBytes = 0;
    let pending = Buffer.alloc(0);
    let scanOffset = inputOffset;
    let reachedEof = false;

    while (processedBytes < PROJECT_CLEANUP_CHUNK_BYTES) {
      const chunk = Buffer.allocUnsafe(PROJECT_CLEANUP_READ_BYTES);
      const read = fs.readSync(sourceFd, chunk, 0, chunk.length, scanOffset);
      if (read === 0) {
        reachedEof = true;
        if (pending.length > 0) {
          if (pending.length > PROJECT_CLEANUP_MAX_LINE_BYTES) throw new ProjectCleanupLineTooLargeError();
          const transformed = transformProjectCleanupLine(
            pending,
            { ...cursor, inAutoSection },
            input,
          );
          if (transformed.output.length > 0) {
            outputBytes = writeProjectCleanupBytes(temporaryFd, transformed.output, outputBytes);
          }
          inputOffset += pending.length;
          processedBytes += pending.length;
          inAutoSection = transformed.inAutoSection;
          pending = Buffer.alloc(0);
        }
        break;
      }
      const available = chunk.subarray(0, read);
      let start = 0;
      while (start < available.length) {
        const newlineIndex = available.indexOf(0x0a, start);
        if (newlineIndex < 0) {
          pending = Buffer.concat([pending, available.subarray(start)]);
          if (pending.length > PROJECT_CLEANUP_MAX_LINE_BYTES) throw new ProjectCleanupLineTooLargeError();
          scanOffset += available.length - start;
          break;
        }
        const segment = available.subarray(start, newlineIndex + 1);
        const rawLine = pending.length > 0 ? Buffer.concat([pending, segment]) : segment;
        if (rawLine.length > PROJECT_CLEANUP_MAX_LINE_BYTES) throw new ProjectCleanupLineTooLargeError();
        const transformed = transformProjectCleanupLine(
          rawLine,
          { ...cursor, inAutoSection },
          input,
        );
        if (transformed.output.length > 0) {
          outputBytes = writeProjectCleanupBytes(temporaryFd, transformed.output, outputBytes);
        }
        inputOffset += rawLine.length;
        processedBytes += rawLine.length;
        inAutoSection = transformed.inAutoSection;
        pending = Buffer.alloc(0);
        start = newlineIndex + 1;
        scanOffset = inputOffset;
        if (processedBytes >= PROJECT_CLEANUP_CHUNK_BYTES) break;
      }
    }

    fs.fsyncSync(temporaryFd);
    const afterSource = fs.fstatSync(sourceFd, { bigint: true });
    const afterPath = assertSafeProjectFile(identity, paths.sourcePath, paths.label);
    if (
      !matchesCleanupFingerprint(afterSource, cursor.fingerprint)
      || !afterPath
      || !matchesCleanupFingerprint(afterPath, cursor.fingerprint)
    ) throw new ProjectCleanupSourceChangedError();

    if (!reachedEof) {
      return {
        complete: false,
        reason: "project-projection-continued",
        progressCursor: projectCleanupCursorJson({
          ...cursor,
          inputOffset,
          outputBytes,
          inAutoSection,
        }),
      };
    }
  } catch (error) {
    if (error instanceof ProjectCleanupSourceChangedError) {
      try { removeProjectCleanupTemporary(identity, paths.temporaryPath); } catch {}
      return {
        complete: false,
        reason: "project-projection-source-changed",
        progressCursor: projectCleanupCursorJson(initialProjectCleanupCursor(cursor.phase)),
      };
    }
    if (error instanceof ProjectCleanupLineTooLargeError) {
      return {
        complete: false,
        reason: "project-projection-line-too-large",
        progressCursor: projectCleanupCursorJson(cursor),
      };
    }
    if (error instanceof ProjectCleanupInvalidUtf8Error) {
      return {
        complete: false,
        reason: "project-projection-invalid-utf8",
        progressCursor: projectCleanupCursorJson(cursor),
      };
    }
    if (error instanceof ProjectCleanupTemporaryResetError) {
      removeProjectCleanupTemporary(identity, paths.temporaryPath);
      return {
        complete: false,
        reason: "project-projection-continued",
        progressCursor: projectCleanupCursorJson(initialProjectCleanupCursor(cursor.phase)),
      };
    }
    throw error;
  } finally {
    if (temporaryFd !== null) fs.closeSync(temporaryFd);
    if (sourceFd !== null) fs.closeSync(sourceFd);
  }

  try {
    finalizeProjectCleanupTemporaryUnderLease(
      identity,
      paths.sourcePath,
      paths.temporaryPath,
      cursor.fingerprint,
    );
  } catch (error) {
    if (error instanceof ProjectCleanupSourceChangedError) {
      try { removeProjectCleanupTemporary(identity, paths.temporaryPath); } catch {}
      return {
        complete: false,
        reason: "project-projection-source-changed",
        progressCursor: projectCleanupCursorJson(initialProjectCleanupCursor(cursor.phase)),
      };
    }
    throw error;
  }
  if (cursor.phase === "soul") {
    return {
      complete: false,
      reason: "project-projection-continued",
      progressCursor: projectCleanupCursorJson(initialProjectCleanupCursor("log")),
    };
  }
  return { complete: true, reason: "project-projection-clean", progressCursor: null };
}

function streamProjectCleanupChunk(
  input: ProjectMemoryProjectionCleanupInput,
  identity: ProjectFsIdentity,
  cursorValue: ProjectCleanupCursor,
): ProjectMemoryProjectionCleanupResult {
  const result = withCurrentProjectCleanupLease(input, () => (
    streamProjectCleanupChunkUnderLease(input, identity, cursorValue)
  ));
  return result.executed && result.value
    ? result.value
    : {
        complete: false,
        reason: "project-projection-authority-lost",
        progressCursor: input.progressCursor,
      };
}

/**
 * Cleanup worker entrypoint. Small files keep the original synchronous path;
 * large files are transformed in bounded, content-free-cursor chunks.
 */
export function reconcileProjectMemoryProjectionCleanup(
  input: ProjectMemoryProjectionCleanupInput,
): ProjectMemoryProjectionCleanupResult {
  const identity = resolveProjectFsIdentity(input.projectPath);
  const parsedCursor = parseProjectCleanupCursor(input.progressCursor);
  if (!parsedCursor && projectCleanupFilesFitImmediatePath(identity)) {
    const immediate = withCurrentProjectCleanupLease(input, () => {
      if (input.progressCursor) {
        for (const phase of ["soul", "log"] as const) {
          const paths = projectCleanupPaths(identity, phase, input.targetId);
          removeProjectCleanupTemporary(identity, paths.temporaryPath);
        }
      }
      forgetProjectMemoryProjection(
        identity.root,
        input.kind,
        input.contentHash,
        input.forgottenAt,
        [projectionMemoryId(input.sourceMemoryId)],
      );
      return isProjectMemoryProjectionForgotten(
        identity.root,
        input.kind,
        input.contentHash,
        [projectionMemoryId(input.sourceMemoryId)],
      );
    });
    return immediate.executed
      ? {
          complete: immediate.value === true,
          reason: immediate.value === true ? "project-projection-clean" : "project-projection-remains",
          progressCursor: null,
        }
      : {
          complete: false,
          reason: "project-projection-authority-lost",
          progressCursor: input.progressCursor,
        };
  }
  return streamProjectCleanupChunk(
    input,
    identity,
    parsedCursor ?? initialProjectCleanupCursor("soul"),
  );
}

// Legacy human-readable nest helper. Runtime recall now uses experience.sqlite
// below; this path remains only for old callers that explicitly request a
// markdown export and is no longer called by the Memory Curator.
// 빌린(고용한) 허브 에이전트의 전역 기억 둥지:
//   ~/.agentlas/networking/hub-agents/<slug>/memory/project-soul-memory.md
// 프로젝트 격리 유지: 이 레거시 helper도 agent_repo 용도 외에는 호출하면 안 된다.
function hubAgentNestSoulPath(slug: string): string | null {
  const memoryRoot = ensureActiveHubMemoryNest(slug);
  return memoryRoot ? path.join(memoryRoot, PROJECT_SOUL_FILE) : null;
}

function normalizedHubAgentSlug(slug: string): string | null {
  return normalizeHubMemorySlug(slug);
}

function stableNestHash(...parts: string[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part).update("\0");
  return digest.digest("hex");
}

export interface AgentNestExperienceItem {
  id: string;
  kind: string;
  content: string;
  confidence: "high" | "medium" | "low";
  sensitivity: "public" | "internal" | "private" | "confidential" | "secret";
  tags?: string[];
  updatedAt: string;
}

interface AgentNestGovernanceRelationInput {
  fromSourceMemoryId: string;
  toSourceMemoryId: string;
  relationType: "supersedes" | "contradicts";
  reason: string;
}

function normalizeAgentNestGovernanceRelation(
  input: AgentNestGovernanceRelationInput,
): AgentNestGovernanceRelationInput | null {
  const fromSourceMemoryId = input.fromSourceMemoryId.trim();
  const toSourceMemoryId = input.toSourceMemoryId.trim();
  if (!fromSourceMemoryId || !toSourceMemoryId || fromSourceMemoryId === toSourceMemoryId) {
    return null;
  }
  if (input.relationType !== "supersedes" && input.relationType !== "contradicts") return null;
  const reason = input.reason.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!reason) return null;
  return {
    fromSourceMemoryId,
    toSourceMemoryId,
    relationType: input.relationType,
    reason,
  };
}

/** Write one reviewed edge only when both active rows share this exact agent and privacy scope. */
function writeAgentNestExperienceGovernanceRelation(
  db: Database.Database,
  agentId: string,
  input: AgentNestGovernanceRelationInput,
): boolean {
  const normalized = normalizeAgentNestGovernanceRelation(input);
  if (!normalized) return false;
  const selectTicket = db.prepare(
    `SELECT ticket_id, status, privacy_scope FROM memory_candidates
      WHERE agent_id = ? AND source_memory_id = ? AND suggested_scope = 'agent_repo'`,
  );
  const from = selectTicket.get(agentId, normalized.fromSourceMemoryId) as {
    ticket_id: string;
    status: string;
    privacy_scope: string | null;
  } | undefined;
  const to = selectTicket.get(agentId, normalized.toSourceMemoryId) as {
    ticket_id: string;
    status: string;
    privacy_scope: string | null;
  } | undefined;
  if (
    !from || !to
    || from.status !== "active" || to.status !== "active"
    || from.privacy_scope !== to.privacy_scope
  ) return false;
  db.prepare(`
    INSERT OR REPLACE INTO memory_links (
      link_id, from_ticket, to_ticket, link_type, score, reason, created_at
    ) VALUES (?, ?, ?, ?, 1.0, ?, ?)
  `).run(
    stableNestHash("memory-link", from.ticket_id, to.ticket_id, normalized.relationType).slice(0, 24),
    from.ticket_id,
    to.ticket_id,
    normalized.relationType,
    normalized.reason,
    new Date().toISOString(),
  );
  return true;
}

/** Replay Desktop's authoritative ledger when a nest is first built or rebuilt. */
function replayAgentNestExperienceGovernanceRelations(
  db: Database.Database,
  normalizedSlug: string,
  touchedSourceMemoryIds: string[],
): number {
  const sourceIds = [...new Set(touchedSourceMemoryIds.map((id) => id.trim()).filter(Boolean))];
  if (sourceIds.length === 0) return 0;
  try {
    const authoritativeDb = getDb();
    const relations = new Map<string, AgentNestGovernanceRelationInput>();
    // Keep bind counts below conservative SQLite host-parameter limits. A
    // relation found through both endpoints is de-duplicated by relation_id.
    for (let offset = 0; offset < sourceIds.length; offset += 400) {
      const batch = sourceIds.slice(offset, offset + 400);
      const placeholders = batch.map(() => "?").join(",");
      const rows = authoritativeDb.prepare(`
        SELECT DISTINCT relation.relation_id,
               from_candidate.source_memory_id AS from_source_memory_id,
               to_candidate.source_memory_id AS to_source_memory_id,
               relation.relation_type, relation.reason
          FROM experience_governance_relations relation
          JOIN experience_candidates from_candidate
            ON from_candidate.id = relation.from_candidate_id
           AND from_candidate.pack_id = relation.pack_id
           AND from_candidate.agent_id = relation.agent_id
          JOIN experience_candidates to_candidate
            ON to_candidate.id = relation.to_candidate_id
           AND to_candidate.pack_id = relation.pack_id
           AND to_candidate.agent_id = relation.agent_id
         WHERE from_candidate.status = 'promoted'
           AND to_candidate.status = 'promoted'
           AND (
             from_candidate.source_memory_id IN (${placeholders})
             OR to_candidate.source_memory_id IN (${placeholders})
           )
         ORDER BY relation.created_at ASC, relation.relation_id ASC
      `).all(...batch, ...batch) as Array<{
        relation_id: string;
        from_source_memory_id: string;
        to_source_memory_id: string;
        relation_type: "supersedes" | "contradicts";
        reason: string;
      }>;
      for (const row of rows) {
        relations.set(row.relation_id, {
          fromSourceMemoryId: row.from_source_memory_id,
          toSourceMemoryId: row.to_source_memory_id,
          relationType: row.relation_type,
          reason: row.reason,
        });
      }
    }
    const agentId = `hub:${normalizedSlug}`;
    let written = 0;
    for (const relation of relations.values()) {
      if (writeAgentNestExperienceGovernanceRelation(db, agentId, relation)) written += 1;
    }
    return written;
  } catch {
    // Projection also runs in standalone helpers before the Desktop store is
    // initialized. The durable Desktop ledger can be replayed on a later write.
    return 0;
  }
}

function confidenceValue(value: AgentNestExperienceItem["confidence"]): number {
  return value === "high" ? 0.9 : value === "medium" ? 0.7 : 0.45;
}

/**
 * Mirror reviewed agent_repo memory into the public-core ontology schema.
 * This projection is a private rebuildable cache: Desktop Memory remains the
 * owner, and semantic edges never manufacture supersedes/contradicts.
 */
export function appendAgentNestExperienceMemory(
  slug: string,
  items: AgentNestExperienceItem[],
): boolean {
  if (items.length === 0) return false;
  const normalizedSlug = normalizedHubAgentSlug(slug);
  if (!normalizedSlug) return false;
  const activePaths = activeHubMemoryNestPaths(normalizedSlug);
  if (!activePaths) return false;
  const leasedItems: Array<{ item: AgentNestExperienceItem; lease: MemoryProjectionWriterLease }> = [];
  for (const item of items) {
    const lease = beginMemoryProjectionWrite({
      sourceMemoryId: item.id,
      targetKind: "agent-nest-scan",
      targetRef: activePaths.ownerScopeKey,
    });
    if (lease) leasedItems.push({ item, lease });
  }
  if (leasedItems.length === 0) return false;
  const memoryDir = ensureActiveHubMemoryNest(normalizedSlug);
  if (!memoryDir) {
    for (const { lease } of leasedItems) finishMemoryProjectionWrite(lease);
    return false;
  }
  const dbPath = path.join(memoryDir, "experience.sqlite");
  try {
    const receipt = commitMemoryProjectionWrites(
      leasedItems.map(({ item, lease }) => ({ lease, value: item })),
      (validItems) => {
        fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") fs.chmodSync(memoryDir, 0o700);
        if (fs.existsSync(dbPath)) {
          const stat = fs.lstatSync(dbPath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error("agent nest projection target is not a regular file");
          }
        }
        const db = new Database(dbPath);
        try {
          db.pragma("journal_mode = WAL");
          db.pragma("foreign_keys = ON");
          db.exec(`
      CREATE TABLE IF NOT EXISTS memory_candidates (
        ticket_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        query TEXT NOT NULL,
        candidate_text TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        risk TEXT NOT NULL,
        expiry TEXT,
        suggested_scope TEXT NOT NULL,
        status TEXT NOT NULL,
        durable_write_enabled INTEGER NOT NULL DEFAULT 0 CHECK (durable_write_enabled = 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        agent_id TEXT,
        memory_kind TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        salience REAL NOT NULL DEFAULT 0.5,
        privacy_scope TEXT,
        source_memory_id TEXT,
        source_updated_at TEXT,
        embedding_adapter TEXT,
        embedding_dimensions INTEGER,
        embedding_json TEXT,
        embedding_content_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_agent_status
        ON memory_candidates(agent_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_candidates_source
        ON memory_candidates(agent_id, source_memory_id);
      CREATE TABLE IF NOT EXISTS memory_links (
        link_id TEXT PRIMARY KEY,
        from_ticket TEXT NOT NULL REFERENCES memory_candidates(ticket_id) ON DELETE CASCADE,
        to_ticket TEXT NOT NULL REFERENCES memory_candidates(ticket_id) ON DELETE CASCADE,
        link_type TEXT NOT NULL CHECK(link_type IN ('similar_to','supersedes','contradicts')),
        score REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(from_ticket, to_ticket, link_type)
      );
      CREATE TABLE IF NOT EXISTS runtime_adapters (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
          const agentId = `hub:${normalizedSlug}`;
    // v1 of this Desktop projection used review-state `accepted`, while Core
    // recall intentionally reads only active experience states. This cache is
    // already downstream of curator approval, so upgrade those old rows in
    // place instead of leaving an invisible cross-project memory island.
    db.prepare(
      `UPDATE memory_candidates SET status = 'active'
        WHERE agent_id = ? AND suggested_scope = 'agent_repo' AND status = 'accepted'`,
    ).run(agentId);
    const selectCreated = db.prepare(
      "SELECT created_at FROM memory_candidates WHERE ticket_id = ?",
    );
    const upsert = db.prepare(`
      INSERT INTO memory_candidates (
        ticket_id, idempotency_key, query, candidate_text, source_refs_json,
        reason, confidence, risk, expiry, suggested_scope, status,
        durable_write_enabled, created_at, updated_at, agent_id, memory_kind,
        tags_json, salience, privacy_scope, source_memory_id, source_updated_at,
        embedding_adapter, embedding_dimensions, embedding_json, embedding_content_hash
      ) VALUES (?, ?, '', ?, ?, 'desktop-memory-curator', ?, ?, NULL, 'agent_repo',
        'active', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET
        candidate_text = excluded.candidate_text,
        source_refs_json = excluded.source_refs_json,
        confidence = excluded.confidence,
        risk = excluded.risk,
        status = excluded.status,
        updated_at = excluded.updated_at,
        memory_kind = excluded.memory_kind,
        tags_json = excluded.tags_json,
        salience = excluded.salience,
        privacy_scope = excluded.privacy_scope,
        source_updated_at = excluded.source_updated_at,
        embedding_adapter = excluded.embedding_adapter,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding_json = excluded.embedding_json,
        embedding_content_hash = excluded.embedding_content_hash
    `);
    const write = db.transaction((batch: AgentNestExperienceItem[]) => {
      for (const item of batch) {
        if (!item.id.trim() || !item.content.trim() || item.sensitivity === "secret") continue;
        const ticketId = stableNestHash("agent-memory-ticket-v1", normalizedSlug, item.id).slice(0, 24);
        const idempotencyKey = stableNestHash("agent-memory-idempotency-v1", normalizedSlug, item.id);
        const embedding = autoLocalEmbedding(item.content);
        const confidence = confidenceValue(item.confidence);
        // Core's exact-agent query accepts public/internal/private. Preserve
        // confidential data as the narrowest readable local scope; secret
        // material was already rejected above and is never projected.
        const privacyScope = new Set(["public", "internal", "private"])
          .has(item.sensitivity) ? item.sensitivity : "private";
        const createdAt = (selectCreated.get(ticketId) as { created_at?: string } | undefined)?.created_at
          ?? item.updatedAt;
        const tags = [...new Set([item.kind, ...(item.tags ?? [])]
          .map((tag) => String(tag).normalize("NFKC").trim().toLowerCase())
          .filter(Boolean))].slice(0, 32);
        upsert.run(
          ticketId,
          idempotencyKey,
          item.content,
          JSON.stringify([{ kind: "desktop-memory", memory_id: item.id, agent_slug: normalizedSlug }]),
          confidence,
          item.sensitivity === "confidential" ? "medium" : "low",
          createdAt,
          item.updatedAt,
          agentId,
          item.kind,
          JSON.stringify(tags),
          confidence,
          privacyScope,
          item.id,
          item.updatedAt,
          embedding.model,
          embedding.dimensions,
          JSON.stringify(embedding.vector),
          embedding.contentHash,
        );
      }
    });
          write(validItems);
          replayAgentNestExperienceGovernanceRelations(
            db,
            normalizedSlug,
            validItems.map((item) => item.id),
          );

    // Re-embed stale rows before rebuilding derived links. Adapter identity,
    // model checksum, and text hash changes invalidate old vectors without a
    // destructive migration; explicit governance edges remain untouched.
    const embeddingRows = db.prepare(
      `SELECT ticket_id, candidate_text, embedding_adapter,
              embedding_dimensions, embedding_json, embedding_content_hash
         FROM memory_candidates
        WHERE agent_id = ? AND status = 'active'
        ORDER BY updated_at DESC, ticket_id ASC`,
    ).all(agentId) as Array<{
      ticket_id: string;
      candidate_text: string;
      embedding_adapter: string | null;
      embedding_dimensions: number | null;
      embedding_json: string | null;
      embedding_content_hash: string | null;
    }>;
    const updateEmbedding = db.prepare(
      `UPDATE memory_candidates
          SET embedding_adapter = ?, embedding_dimensions = ?,
              embedding_json = ?, embedding_content_hash = ?
        WHERE ticket_id = ?`,
    );
    const rows = embeddingRows.map((row) => {
      const embedding = autoLocalEmbedding(row.candidate_text);
      const vectorJson = JSON.stringify(embedding.vector);
      // Core's canonical schema stores the adapter NAME here; full immutable
      // identity is registered in runtime_adapters.config_json. Writing the
      // Desktop identity string would make every Core cosine incompatible.
      if (
        row.embedding_adapter !== embedding.model ||
        row.embedding_dimensions !== embedding.dimensions ||
        row.embedding_json !== vectorJson ||
        row.embedding_content_hash !== embedding.contentHash
      ) {
        updateEmbedding.run(
          embedding.model,
          embedding.dimensions,
          vectorJson,
          embedding.contentHash,
          row.ticket_id,
        );
      }
      return { ticket_id: row.ticket_id, embedding };
    });

    // Register the full immutable adapter identity in Core's own drift table.
    // memory_candidates.embedding_adapter stays the short executable name;
    // runtime_adapters makes a same-name model revision trigger Core reindex.
    const projectionEmbedding = rows[0]?.embedding;
    if (projectionEmbedding) {
      db.prepare(`
        INSERT OR REPLACE INTO runtime_adapters (
          name, kind, status, config_json, updated_at
        ) VALUES (?, 'vector', ?, ?, ?)
      `).run(
        projectionEmbedding.model,
        projectionEmbedding.degraded ? "degraded_fallback" : "available",
        JSON.stringify({
          name: projectionEmbedding.model,
          status: projectionEmbedding.degraded ? "degraded_fallback" : "available",
          identity: projectionEmbedding.adapter,
          dimensions: projectionEmbedding.dimensions,
          local_only: true,
          model_sha256: projectionEmbedding.modelSha256,
        }),
        new Date().toISOString(),
      );
    }

    // Rebuild only derived similarity links for this one private agent cache.
    db.prepare("DELETE FROM memory_links WHERE link_type = 'similar_to'").run();
    const insertSimilar = db.prepare(`
      INSERT OR REPLACE INTO memory_links (
        link_id, from_ticket, to_ticket, link_type, score, reason, created_at
      ) VALUES (?, ?, ?, 'similar_to', ?, 'local vector cosine', ?)
    `);
    const now = new Date().toISOString();
    const linkRows = rows.slice(0, 512);
    for (let leftIndex = 0; leftIndex < linkRows.length; leftIndex += 1) {
      const left = linkRows[leftIndex].embedding.vector;
      for (let rightIndex = leftIndex + 1; rightIndex < linkRows.length; rightIndex += 1) {
        const right = linkRows[rightIndex].embedding.vector;
        const similarity = cosineSimilarity(left, right);
        if (similarity < 0.5) continue;
        const fromTicket = linkRows[rightIndex].ticket_id;
        const toTicket = linkRows[leftIndex].ticket_id;
        insertSimilar.run(
          stableNestHash("memory-link", fromTicket, toTicket, "similar_to").slice(0, 24),
          fromTicket,
          toTicket,
          Number(similarity.toFixed(6)),
          now,
        );
      }
    }
          if (process.platform !== "win32") {
            fs.chmodSync(dbPath, 0o600);
            for (const suffix of ["-wal", "-shm"]) {
              if (fs.existsSync(`${dbPath}${suffix}`)) fs.chmodSync(`${dbPath}${suffix}`, 0o600);
            }
          }
        } finally {
          try { db.close(); } catch { /* best-effort projection */ }
        }
      },
    );
    return receipt.committedTargetIds.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reconcile Desktop-owned supersession into one borrowed agent's rebuildable
 * experience projection. A typed edge is emitted only when the caller can name
 * one unambiguous successor; set-level consolidation with multiple successors
 * retires the old rows without inventing false pairwise authority.
 */
export function supersedeAgentNestExperienceMemory(
  slug: string,
  sourceMemoryIds: string[],
  successorSourceMemoryId?: string,
): boolean {
  const normalizedSlug = normalizedHubAgentSlug(slug);
  const sourceIds = [...new Set(sourceMemoryIds.map((id) => id.trim()).filter(Boolean))];
  if (!normalizedSlug || sourceIds.length === 0) return false;
  const paths = activeHubMemoryNestPaths(normalizedSlug);
  if (!paths) return false;
  // Retire the source ids in EVERY readable root, not just the writable one.
  // After the device-local flat move (c0e2931), memories that predate it live in
  // a read-only legacy owner root; a consolidation that only touched the writable
  // root could never supersede them, so a curator-corrected misdiagnosis kept
  // being recalled alongside its replacement (2026-08-12 set 4). The successor
  // edge is written only in the db that actually holds the successor (links do
  // not cross sqlite files); a retired target elsewhere is still marked
  // superseded so recall (status='active') stops surfacing it.
  let attempted = 0;
  let reconciled = 0;
  for (const root of paths.readableMemoryRoots) {
    const dbPath = path.join(root, "experience.sqlite");
    if (!fs.existsSync(dbPath)) continue;
    let isFile = false;
    try {
      const st = fs.lstatSync(dbPath);
      isFile = !st.isSymbolicLink() && st.isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    attempted += 1;
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath);
      db.pragma("foreign_keys = ON");
      // The device-local flat db is now shared with the Python writer; wait on a
      // transient lock rather than fail, so a retire is not silently dropped and
      // a corrected misdiagnosis cannot stay recalled beside its replacement
      // (2026-08-12 set 5 partial-failure edge).
      db.pragma("busy_timeout = 5000");
      const agentId = `hub:${normalizedSlug}`;
      const now = new Date().toISOString();
      const selectTicket = db.prepare(
        `SELECT ticket_id, status, privacy_scope FROM memory_candidates
          WHERE agent_id = ? AND source_memory_id = ? AND suggested_scope = 'agent_repo'`,
      );
      const updateStatus = db.prepare(
        `UPDATE memory_candidates SET status = 'superseded', updated_at = ?
          WHERE agent_id = ? AND source_memory_id = ? AND suggested_scope = 'agent_repo'
            AND status = 'active'`,
      );
      const deleteDerivedLinks = db.prepare(
        `DELETE FROM memory_links
          WHERE link_type = 'similar_to' AND (from_ticket = ? OR to_ticket = ?)`,
      );
      const insertSupersedes = db.prepare(`
        INSERT OR REPLACE INTO memory_links (
          link_id, from_ticket, to_ticket, link_type, score, reason, created_at
        ) VALUES (?, ?, ?, 'supersedes', 1.0, 'desktop memory consolidation', ?)
      `);
      const successor = successorSourceMemoryId?.trim()
        ? selectTicket.get(agentId, successorSourceMemoryId.trim()) as {
            ticket_id: string;
            status: string;
            privacy_scope: string | null;
          } | undefined
        : undefined;
      const reconcile = db.transaction(() => {
        for (const sourceId of sourceIds) {
          const target = selectTicket.get(agentId, sourceId) as {
            ticket_id: string;
            status: string;
            privacy_scope: string | null;
          } | undefined;
          if (!target || target.ticket_id === successor?.ticket_id) continue;
          updateStatus.run(now, agentId, sourceId);
          deleteDerivedLinks.run(target.ticket_id, target.ticket_id);
          if (
            successor?.status === "active"
            && successor.privacy_scope === target.privacy_scope
          ) {
            insertSupersedes.run(
              stableNestHash("memory-link", successor.ticket_id, target.ticket_id, "supersedes").slice(0, 24),
              successor.ticket_id,
              target.ticket_id,
              now,
            );
          }
        }
      });
      // Retry a transient busy/lock (the shared flat db) a few times before
      // giving up on this root, so a real collision does not silently strand a
      // still-active stale row.
      let committed = false;
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3 && !committed; attempt += 1) {
        try {
          reconcile();
          committed = true;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!committed) throw lastErr ?? new Error("reconcile failed");
      reconciled += 1;
    } catch {
      // this root missed — reconciled is not incremented, so a partial failure
      // is reported by the return value instead of masked as full success
    } finally {
      try { db?.close(); } catch { /* best-effort projection */ }
    }
  }
  // true only when every db we attempted actually committed; a partial failure
  // returns false so the caller cannot treat a still-active stale row as retired.
  return attempted > 0 && reconciled === attempted;
}

/** Remove raw recall material from one exact borrowed-agent cache source. */
export function forgetAgentNestExperienceMemory(
  slug: string,
  sourceMemoryIds: string[],
  forgottenAt: string,
): boolean {
  const normalizedSlug = normalizedHubAgentSlug(slug);
  const sourceIds = [...new Set(sourceMemoryIds.map((id) => id.trim()).filter(Boolean))];
  if (!normalizedSlug || sourceIds.length === 0) return false;
  const paths = activeHubMemoryNestPaths(normalizedSlug);
  if (!paths) return true;
  let attempted = 0;
  let reconciled = 0;
  for (const root of paths.readableMemoryRoots) {
    const dbPath = path.join(root, "experience.sqlite");
    if (!fs.existsSync(dbPath)) continue;
    let db: Database.Database | null = null;
    try {
      const stat = fs.lstatSync(dbPath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      attempted += 1;
      db = new Database(dbPath);
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      const agentId = `hub:${normalizedSlug}`;
      const select = db.prepare(
        `SELECT ticket_id FROM memory_candidates
          WHERE agent_id = ? AND source_memory_id = ? AND suggested_scope = 'agent_repo'`,
      );
      const redact = db.prepare(
        `UPDATE memory_candidates
            SET candidate_text = '', source_refs_json = '[]', reason = 'forgotten',
                status = 'superseded', tags_json = '[]', salience = 0,
                privacy_scope = 'private', embedding_adapter = NULL,
                embedding_dimensions = NULL, embedding_json = NULL,
                embedding_content_hash = NULL, updated_at = ?
          WHERE agent_id = ? AND source_memory_id = ? AND suggested_scope = 'agent_repo'`,
      );
      const deleteLinks = db.prepare(
        "DELETE FROM memory_links WHERE from_ticket = ? OR to_ticket = ?",
      );
      db.transaction(() => {
        for (const sourceId of sourceIds) {
          const rows = select.all(agentId, sourceId) as Array<{ ticket_id: string }>;
          for (const row of rows) deleteLinks.run(row.ticket_id, row.ticket_id);
          redact.run(forgottenAt, agentId, sourceId);
        }
      }).immediate();
      reconciled += 1;
    } catch {
      // false below preserves the unresolved mirror as an observable failure.
    } finally {
      try { db?.close(); } catch { /* best-effort close */ }
    }
  }
  return attempted === reconciled;
}

export interface AgentNestForgetScanResult {
  complete: boolean;
  scannedDatabases: number;
  matchedRows: number;
  nextCursor: string | null;
}

/**
 * Reconcile one source id only inside the opaque owner partition captured when
 * its projection was registered. Account switches cannot redirect this scan.
 */
export function forgetAgentNestExperienceMemoryForOwnerScope(
  ownerScopeKey: string,
  sourceMemoryId: string,
  forgottenAt: string,
  afterSlug: string | null = null,
  maximumSlugs = 1,
): AgentNestForgetScanResult {
  const sourceId = sourceMemoryId.trim();
  if (!sourceId) return { complete: false, scannedDatabases: 0, matchedRows: 0, nextCursor: afterSlug };
  const agentRoot = path.join(os.homedir(), ".agentlas", "networking", "hub-agents");
  let entries: fs.Dirent[];
  try {
    const stat = fs.lstatSync(agentRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { complete: false, scannedDatabases: 0, matchedRows: 0, nextCursor: afterSlug };
    }
    entries = fs.readdirSync(agentRoot, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { complete: true, scannedDatabases: 0, matchedRows: 0, nextCursor: null };
    }
    return { complete: false, scannedDatabases: 0, matchedRows: 0, nextCursor: afterSlug };
  }
  let complete = true;
  let scannedDatabases = 0;
  let matchedRows = 0;
  let scannedSlugs = 0;
  let lastCompletedSlug = afterSlug;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = normalizedHubAgentSlug(entry.name);
    if (!slug || slug !== entry.name) continue;
    if (afterSlug && slug <= afterSlug) continue;
    if (scannedSlugs >= Math.max(1, Math.min(64, Math.floor(maximumSlugs)))) {
      return { complete: false, scannedDatabases, matchedRows, nextCursor: lastCompletedSlug };
    }
    const paths = hubMemoryNestPathsForOwnerScope(slug, ownerScopeKey);
    if (!paths) return { complete: false, scannedDatabases, matchedRows, nextCursor: lastCompletedSlug };
    let slugComplete = true;
    for (const memoryRoot of paths.readableMemoryRoots) {
      const dbPath = path.join(memoryRoot, "experience.sqlite");
      let db: Database.Database | null = null;
      try {
        const stat = fs.lstatSync(dbPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          complete = false;
          slugComplete = false;
          continue;
        }
        db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        db.pragma("busy_timeout = 250");
        const table = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_candidates'",
        ).get();
        if (!table) {
          scannedDatabases += 1;
          continue;
        }
        const agentId = `hub:${slug}`;
        const rows = db.prepare(
          `SELECT ticket_id FROM memory_candidates
            WHERE agent_id = ? AND source_memory_id = ? AND suggested_scope = 'agent_repo'`,
        ).all(agentId, sourceId) as Array<{ ticket_id: string }>;
        matchedRows += rows.length;
        const redact = db.prepare(
          `UPDATE memory_candidates
              SET candidate_text = '', source_refs_json = '[]', reason = 'forgotten',
                  status = 'superseded', tags_json = '[]', salience = 0,
                  privacy_scope = 'private', embedding_adapter = NULL,
                  embedding_dimensions = NULL, embedding_json = NULL,
                  embedding_content_hash = NULL, updated_at = ?
            WHERE agent_id = ? AND source_memory_id = ? AND suggested_scope = 'agent_repo'`,
        );
        const deleteLinks = db.prepare(
          "DELETE FROM memory_links WHERE from_ticket = ? OR to_ticket = ?",
        );
        db.transaction(() => {
          for (const row of rows) deleteLinks.run(row.ticket_id, row.ticket_id);
          redact.run(forgottenAt, agentId, sourceId);
        }).immediate();
        const residual = db.prepare(
          `SELECT 1 FROM memory_candidates
            WHERE agent_id = ? AND source_memory_id = ? AND suggested_scope = 'agent_repo'
              AND (candidate_text <> '' OR source_refs_json <> '[]' OR status <> 'superseded')
            LIMIT 1`,
        ).get(agentId, sourceId);
        if (residual) complete = false;
        scannedDatabases += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          complete = false;
          slugComplete = false;
        }
      } finally {
        try { db?.close(); } catch {
          complete = false;
          slugComplete = false;
        }
      }
    }
    if (!slugComplete) {
      return { complete: false, scannedDatabases, matchedRows, nextCursor: lastCompletedSlug };
    }
    scannedSlugs += 1;
    lastCompletedSlug = slug;
  }
  return { complete, scannedDatabases, matchedRows, nextCursor: complete ? null : lastCompletedSlug };
}

/** Resolve exact source-memory -> borrowed-agent projection ownership. */
export function agentNestExperienceOwnership(
  sourceMemoryIds: string[],
): Record<string, string[]> {
  const sourceIds = [...new Set(sourceMemoryIds.map((id) => id.trim()).filter(Boolean))];
  const ownership = Object.fromEntries(sourceIds.map((id) => [id, [] as string[]]));
  if (sourceIds.length === 0) return ownership;
  const root = path.join(os.homedir(), ".agentlas", "networking", "hub-agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return ownership;
  }
  const placeholders = sourceIds.map(() => "?").join(",");
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = normalizedHubAgentSlug(entry.name);
    if (!slug || slug !== entry.name) continue;
    for (const memoryRoot of readableActiveHubMemoryNestRoots(slug)) {
      const dbPath = path.join(memoryRoot, "experience.sqlite");
      let db: Database.Database | null = null;
      try {
        const stat = fs.lstatSync(dbPath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const table = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_candidates'",
        ).get();
        if (!table) continue;
        const matches = db.prepare(
          `SELECT DISTINCT source_memory_id FROM memory_candidates
            WHERE agent_id = ? AND source_memory_id IN (${placeholders})`,
        ).all(`hub:${slug}`, ...sourceIds) as Array<{ source_memory_id: string }>;
        for (const match of matches) {
          if (!ownership[match.source_memory_id]?.includes(slug)) {
            ownership[match.source_memory_id]?.push(slug);
          }
        }
      } catch {
        // One corrupt/unreadable private cache must not block other agents.
      } finally {
        try { db?.close(); } catch { /* best-effort scan */ }
      }
    }
  }
  for (const sourceId of sourceIds) ownership[sourceId].sort();
  return ownership;
}

/** Resolve the union of borrowed-agent projections that own source rows. */
export function findAgentNestExperienceSlugs(sourceMemoryIds: string[]): string[] {
  const ownership = agentNestExperienceOwnership(sourceMemoryIds);
  return [...new Set(Object.values(ownership).flat())].sort();
}

/**
 * Project a consolidated result back into every exact borrowed-agent nest that
 * held an absorbed source, then retire those stale rows. Returns the slugs that
 * were reconciled; a failed replacement write leaves the old projection live.
 */
export function reconcileAgentNestExperienceConsolidation(
  absorbedSourceMemoryIds: string[],
  consolidatedItems: AgentNestExperienceItem[],
): string[] {
  const sourceIds = [...new Set(absorbedSourceMemoryIds.map((id) => id.trim()).filter(Boolean))];
  if (sourceIds.length === 0 || consolidatedItems.length === 0) return [];
  const ownership = agentNestExperienceOwnership(sourceIds);
  const signatures = sourceIds.map((sourceId) => JSON.stringify(ownership[sourceId] ?? []));
  // Never combine memories owned by different borrowed agents. The caller must
  // partition consolidation by identical owner set before generating a rule.
  if (signatures.some((signature) => signature !== signatures[0])) return [];
  const slugs = ownership[sourceIds[0]] ?? [];
  const reconciled: string[] = [];
  for (const slug of slugs) {
    if (!appendAgentNestExperienceMemory(slug, consolidatedItems)) continue;
    if (!supersedeAgentNestExperienceMemory(
      slug,
      sourceIds,
      consolidatedItems.length === 1 ? consolidatedItems[0].id : undefined,
    )) continue;
    reconciled.push(slug);
  }
  return reconciled;
}

/** Mirror an explicit reviewed Experience governance edge into matching nests. */
export function recordAgentNestExperienceGovernanceRelation(input: {
  fromSourceMemoryId: string;
  toSourceMemoryId: string;
  relationType: "supersedes" | "contradicts";
  reason: string;
}): string[] {
  const normalized = normalizeAgentNestGovernanceRelation(input);
  if (!normalized) return [];
  const ownership = agentNestExperienceOwnership([
    normalized.fromSourceMemoryId,
    normalized.toSourceMemoryId,
  ]);
  const toOwners = new Set(ownership[normalized.toSourceMemoryId] ?? []);
  const sharedSlugs = (ownership[normalized.fromSourceMemoryId] ?? [])
    .filter((slug) => toOwners.has(slug));
  const written: string[] = [];
  for (const slug of sharedSlugs) {
    const paths = activeHubMemoryNestPaths(slug);
    if (!paths) continue;
    const dbPath = path.join(paths.writableMemoryRoot, "experience.sqlite");
    let db: Database.Database | null = null;
    try {
      const stat = fs.lstatSync(dbPath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      db = new Database(dbPath);
      db.pragma("foreign_keys = ON");
      const agentId = `hub:${slug}`;
      if (writeAgentNestExperienceGovernanceRelation(db, agentId, normalized)) {
        written.push(slug);
      }
    } catch {
      // The Desktop governance ledger remains authoritative; a broken cache is
      // rebuildable and must not make the reviewed local decision fail.
    } finally {
      try { db?.close(); } catch { /* best-effort bridge */ }
    }
  }
  return written;
}

/** @deprecated Runtime recall uses appendAgentNestExperienceMemory. */
export function appendAgentNestSoulMemory(slug: string, lines: string[]): boolean {
  if (lines.length === 0) return false;
  const soulPath = hubAgentNestSoulPath(slug);
  if (!soulPath) return false;
  try {
    fs.mkdirSync(path.dirname(soulPath), { recursive: true });
    let content = "";
    try {
      content = fs.readFileSync(soulPath, "utf8");
    } catch {
      content = `# ${slug} — Agent Memory\n\nDurable skills and gotchas this agent learned across projects.\n`;
    }
    if (!content.includes(AUTO_SECTION)) content += `\n${AUTO_SECTION}\n`;
    const block = lines.map((l) => `- ${l}`).join("\n") + "\n";
    fs.writeFileSync(soulPath, content.replace(/\s*$/, "\n") + block, "utf8");
    return true;
  } catch {
    return false; // 둥지 쓰기 실패가 사용자 작업을 막지 않는다
  }
}
