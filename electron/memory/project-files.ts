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
  SUPER_ONTOLOGY_CONTRACT_FILE,
  SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE,
  SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE,
  SUPER_ONTOLOGY_ASSURANCE_CASE_FILE,
  SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE,
  SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE,
  SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE,
  SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE,
  SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE,
  SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE,
  SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE,
  SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE,
  SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE,
  SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE,
  SUPER_ONTOLOGY_STAKEHOLDER_PREFERENCE_GOVERNANCE_FILE,
  SUPER_ONTOLOGY_NORMATIVE_AUTHORITY_DRIFT_FILE,
  SUPER_ONTOLOGY_SIDE_EFFECT_CONTAINMENT_FILE,
  SUPER_ONTOLOGY_SOURCE_LINEAGE_VERSION_FILE,
  SUPER_ONTOLOGY_ENTITY_IDENTITY_RESOLUTION_FILE,
  SUPER_ONTOLOGY_TEMPORAL_STATE_TRANSITION_FILE,
  SUPER_ONTOLOGY_CAPABILITY_DELEGATION_AUTHORITY_FILE,
  SUPER_ONTOLOGY_PRIVACY_CONFIDENTIALITY_BOUNDARY_FILE,
  SUPER_ONTOLOGY_STRATEGIC_INCENTIVE_COMPATIBILITY_FILE,
  SUPER_ONTOLOGY_REFLEXIVE_FEEDBACK_STABILITY_FILE,
  SUPER_ONTOLOGY_EVIDENCE_FILE,
  SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE,
  SUPER_ONTOLOGY_REPLAYS_FILE,
  SUPER_ONTOLOGY_TASK_COVERAGE_FILE,
} from "../architecture/manifest";

export function projectMemoryDir(projectPath: string): string {
  return path.join(projectPath, PROJECT_MEMORY_DIR);
}

const AUTO_SECTION = "## Auto-curated memory";
const CREDENTIAL_INDEX_SECTION = "## Local Credential Index (read first)";

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
): { content: string; stat: fs.BigIntStats } | null {
  const before = assertSafeProjectFile(identity, filePath, label);
  if (!before) return null;
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

/** Refresh the deterministic file tree while preserving user-maintained node annotations. */
export function refreshProjectSitemap(projectPath: string): ProjectSitemap | null {
  try {
    const identity = resolveProjectFsIdentity(projectPath);
    const dir = path.join(identity.root, PROJECT_MEMORY_DIR);
    ensureRealProjectDirectory(identity, dir, "The project memory directory");
    const outputPath = path.join(dir, SITEMAP_FILE);
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
    let previous: Record<string, unknown> | null = null;
    try {
      const existing = readStableProjectText(identity, outputPath, "The project sitemap");
      previous = existing ? sitemapRecord(JSON.parse(existing.content)) : null;
    } catch {
      previous = null;
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

function superOntologyContractSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-contract",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimeGraphWriteEnabled: false,
      zeroErrorClaim: false,
      operatorManagedPromotion: {
        enabled: true,
        runtimePromotionModel: "operator_managed_local",
        securityGateMode: "context_folder_routing_only",
        blockingSecurityGate: false,
        requiredBeforePromotion: [
          "project_root",
          "source_folder",
          "owner",
          "evidence_refs",
          "rollback_or_replay_path",
        ],
        publicExportRemainsValueFree: true,
        notes:
          "Local operators may promote when structure and ownership are explicit. Security labels are routing metadata, not a generic runtime stop sign.",
      },
      layers: [
        "source_intake",
        "evidence_packet",
        "belief_ledger",
        "knowledge_capsule",
        "affordance_action_binding",
        "agentlas_integration_contract",
        "memory_curator_bridge",
        "open_world_coverage_contract",
        "consensus_coordination_contract",
        "task_coverage_contract",
        "contextual_flow_contract",
        "causal_impact_contract",
        "assurance_case_contract",
        "knowledge_homeostasis_contract",
        "adversarial_provenance_contract",
        "epistemic_calibration_contract",
        "semantic_alignment_contract",
        "resilience_control_contract",
        "invariant_verification_contract",
        "observability_telemetry_contract",
        "objective_proxy_validity_contract",
        "stakeholder_preference_governance_contract",
        "normative_authority_drift_contract",
        "side_effect_containment_contract",
        "source_lineage_version_contract",
        "entity_identity_resolution_contract",
        "temporal_state_transition_contract",
        "capability_delegation_authority_contract",
        "privacy_confidentiality_boundary_contract",
        "strategic_incentive_compatibility_contract",
        "reflexive_feedback_stability_contract",
        "promotion_readiness",
        "promotion_replay_drill",
        "architecture_sync_review",
      ],
      evidenceLedgers: {
        replays: `.agentlas/${SUPER_ONTOLOGY_REPLAYS_FILE}`,
        promotionEvidence: `.agentlas/${SUPER_ONTOLOGY_EVIDENCE_FILE}`,
        memoryTickets: `.agentlas/${MEMORY_LOG_FILE}`,
        memoryCuratorBridge: `.agentlas/${SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE}`,
        openWorldCoverage: `.agentlas/${SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE}`,
        consensusCoordination: `.agentlas/${SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE}`,
        taskCoverage: `.agentlas/${SUPER_ONTOLOGY_TASK_COVERAGE_FILE}`,
        contextualFlow: `.agentlas/${SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE}`,
        causalImpact: `.agentlas/${SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE}`,
        assuranceCase: `.agentlas/${SUPER_ONTOLOGY_ASSURANCE_CASE_FILE}`,
        knowledgeHomeostasis: `.agentlas/${SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE}`,
        adversarialProvenance: `.agentlas/${SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE}`,
        epistemicCalibration: `.agentlas/${SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE}`,
        semanticAlignment: `.agentlas/${SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE}`,
        resilienceControl: `.agentlas/${SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE}`,
        invariantVerification: `.agentlas/${SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE}`,
        observabilityTelemetry: `.agentlas/${SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE}`,
        objectiveProxyValidity: `.agentlas/${SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE}`,
        stakeholderPreferenceGovernance: `.agentlas/${SUPER_ONTOLOGY_STAKEHOLDER_PREFERENCE_GOVERNANCE_FILE}`,
        normativeAuthorityDrift: `.agentlas/${SUPER_ONTOLOGY_NORMATIVE_AUTHORITY_DRIFT_FILE}`,
        sideEffectContainment: `.agentlas/${SUPER_ONTOLOGY_SIDE_EFFECT_CONTAINMENT_FILE}`,
        sourceLineageVersion: `.agentlas/${SUPER_ONTOLOGY_SOURCE_LINEAGE_VERSION_FILE}`,
        entityIdentityResolution: `.agentlas/${SUPER_ONTOLOGY_ENTITY_IDENTITY_RESOLUTION_FILE}`,
        temporalStateTransition: `.agentlas/${SUPER_ONTOLOGY_TEMPORAL_STATE_TRANSITION_FILE}`,
        capabilityDelegationAuthority: `.agentlas/${SUPER_ONTOLOGY_CAPABILITY_DELEGATION_AUTHORITY_FILE}`,
        privacyConfidentialityBoundary: `.agentlas/${SUPER_ONTOLOGY_PRIVACY_CONFIDENTIALITY_BOUNDARY_FILE}`,
        strategicIncentiveCompatibility: `.agentlas/${SUPER_ONTOLOGY_STRATEGIC_INCENTIVE_COMPATIBILITY_FILE}`,
        reflexiveFeedbackStability: `.agentlas/${SUPER_ONTOLOGY_REFLEXIVE_FEEDBACK_STABILITY_FILE}`,
      },
      hardStops: [
        "zero_error_claim",
        "raw_source_to_graph_write",
        "forbidden_context_join",
        "whole_graph_exposure",
        "tool_authority_without_provenance",
        "missing_open_world_coverage_contract",
        "proposal_example_equals_all_tasks",
        "unknown_combination_to_runtime_write",
        "untested_modality_to_memory_write",
        "implicit_degradation_as_complete_data",
        "adversarial_source_as_authority",
        "forbidden_authority_to_action",
        "missing_consensus_coordination_contract",
        "agent_agreement_as_truth",
        "majority_vote_as_write_authority",
        "debate_stability_as_proof",
        "model_judge_as_final_evidence",
        "distributed_replica_merge_without_review",
        "route_sync_without_quorum",
        "last_writer_wins_architecture_update",
        "peer_pressure_to_memory_write",
        "validator_disagreement_to_release",
        "appbridge_source_of_truth_write",
        "missing_rollback",
        "missing_shadow_or_canary_evidence",
        "missing_memory_curator_bridge",
        "missing_task_coverage_contract",
        "missing_contextual_flow_contract",
        "forbidden_context_flow",
        "missing_causal_impact_contract",
        "missing_assurance_case_contract",
        "missing_knowledge_homeostasis_contract",
        "error_budget_overrun_continues",
        "critical_homeostasis_runtime_write",
        "privacy_incident_public_export",
        "missing_adversarial_provenance_contract",
        "prompt_injection_as_instruction",
        "forged_provenance_as_trusted_source",
        "poisoned_source_to_memory",
        "tool_output_tampering_to_action",
        "stale_trusted_source_replay_as_current_truth",
        "missing_epistemic_calibration_contract",
        "uncalibrated_confidence_to_answer",
        "unknown_state_to_runtime_write",
        "conflicting_sources_as_current_truth",
        "low_retrieval_relevance_as_confident_answer",
        "wide_judge_interval_to_regulated_answer",
        "missing_semantic_alignment_contract",
        "same_label_as_same_meaning",
        "embedding_similarity_as_exact_match",
        "close_match_as_transitive_truth",
        "generated_label_as_ontology_class",
        "appbridge_route_as_source_ontology_edit",
        "same_individual_without_stable_identifier",
        "unit_label_without_unit_compatibility",
        "source_conflict_to_memory_merge",
        "no_match_promoted_to_weak_match",
        "missing_resilience_control_contract",
        "validator_disagreement_to_graph_write",
        "retrieval_drift_to_current_answer",
        "semantic_regression_to_memory_merge",
        "curator_backlog_to_direct_memory_write",
        "tool_error_spike_to_unbounded_retry",
        "sync_drift_to_release_surface",
        "degraded_parser_to_ontology_class",
        "emergency_stop_bypass_by_route",
        "missing_invariant_verification_contract",
        "memory_write_without_ticket_invariant",
        "graph_write_without_evidence_invariant",
        "tool_action_without_authority_invariant",
        "public_export_without_flow_invariant",
        "route_sync_without_source_contract_invariant",
        "rollback_not_observed_after_violation",
        "emergency_stop_transition_bypassed",
        "unordered_multi_agent_write",
        "non_idempotent_replay_mutation",
        "missing_observability_telemetry_contract",
        "write_without_trace_id",
        "memory_ticket_without_span_lineage",
        "tool_action_without_audit_receipt",
        "public_export_with_stale_metric",
        "route_sync_without_correlation_id",
        "release_seed_when_audit_sink_down",
        "redaction_missing_in_telemetry",
        "metric_green_without_sample_size",
        "alert_suppressed_during_degraded_mode",
        "shadow_replay_not_recorded",
        "repair_without_before_after_snapshot",
        "rollback_without_observed_event",
        "unobservable_runtime_write",
        "missing_objective_proxy_validity_contract",
        "metric_improvement_as_goal_completion",
        "approval_rate_as_trust",
        "benchmark_score_as_reliability",
        "test_pass_rate_as_maintainability",
        "open_rate_as_customer_value",
        "self_judge_score_as_truth",
        "edge_count_as_knowledge_quality",
        "short_term_profit_as_compliance",
        "cost_per_execution_as_sustainability",
        "reward_score_as_quality",
        "label_leakage_as_accuracy",
        "green_dashboard_as_health",
        "proxy_optimization_without_countermetric",
        "optimization_without_stakeholder_map",
        "metric_gaming_without_probe",
        "reward_tampering_to_promotion",
        "construct_underdefined_to_runtime_write",
        "unvalidated_proxy_to_public_release",
        "missing_stakeholder_preference_governance_contract",
        "single_stakeholder_preference_as_global_goal",
        "owner_preference_as_all_stakeholders",
        "majority_preference_as_rights_clearance",
        "average_utility_over_protected_constraint",
        "hidden_affected_party",
        "missing_appeal_path",
        "missing_dissent_capture",
        "strategic_preference_report_as_truth",
        "preference_aggregation_without_rule",
        "preference_conflict_to_runtime_write",
        "consent_absent_to_personalization",
        "minority_harm_hidden_by_aggregate",
        "irreversible_action_without_stakeholder_review",
        "private_preference_to_public_release",
        "cross_context_preference_reuse_without_scope",
        "role_power_as_legitimacy",
        "arrow_impossibility_ignored",
        "manipulable_vote_as_stable_preference",
        "stakeholder_map_missing_for_release",
        "missing_normative_authority_drift_contract",
        "stale_policy_as_current_rule",
        "wrong_jurisdiction_as_valid_policy",
        "draft_policy_as_enforced_rule",
        "superseded_contract_as_current_authority",
        "terms_of_service_without_effective_date",
        "local_custom_as_global_policy",
        "internal_preference_as_legal_requirement",
        "policy_exception_without_owner",
        "conflicting_authorities_without_precedence",
        "regulation_summary_as_primary_law",
        "compliance_claim_without_citation",
        "policy_translation_as_authoritative_text",
        "expired_consent_as_current_permission",
        "missing_retention_or_deletion_rule",
        "cross_border_transfer_without_jurisdiction",
        "licensing_constraint_ignored",
        "audit_requirement_missing_before_release",
        "emergency_exception_without_expiry",
        "legal_advice_without_review",
        "missing_side_effect_containment_contract",
        "read_permission_as_write_permission",
        "preview_as_send",
        "dry_run_result_as_committed",
        "non_idempotent_retry_to_external_action",
        "irreversible_action_without_human_approval",
        "deletion_without_recovery_plan",
        "payment_without_idempotency_key",
        "customer_message_without_review",
        "release_without_rollback",
        "connector_write_without_scope",
        "cross_tool_chain_without_transaction",
        "compensation_plan_missing",
        "blast_radius_unknown",
        "idempotency_key_missing",
        "external_commit_without_receipt",
        "partial_failure_without_saga_state",
        "physical_action_without_safety_interlock",
        "scheduled_action_without_cancellation",
        "side_effect_logging_missing",
        "hosted_tool_without_local_side_effect_wrapper",
        "missing_source_lineage_version_contract",
        "filename_as_version",
        "latest_folder_as_current_source",
        "pdf_export_as_primary_source",
        "summary_as_primary_source",
        "ocr_text_without_source_span",
        "spreadsheet_sheet_without_workbook_revision",
        "email_attachment_without_message_context",
        "duplicate_title_as_same_artifact",
        "checksum_missing_for_authoritative_source",
        "stale_cache_as_current_record",
        "connector_snapshot_without_capture_time",
        "transitive_derivation_as_primary_source",
        "merged_record_without_parent_refs",
        "redacted_copy_as_complete_source",
        "translation_as_authoritative_source",
        "chunk_without_source_span",
        "embedding_hit_without_artifact_version",
        "memory_fact_without_lineage",
        "public_export_without_lineage_evidence",
        "training_example_without_dataset_version",
        "graph_edge_without_derivation_chain",
        "superseded_source_to_runtime_write",
        "lineage_cycle_unresolved",
        "missing_entity_identity_resolution_contract",
        "name_as_identity",
        "email_domain_as_company",
        "fuzzy_match_as_merge",
        "embedding_cluster_as_identity",
        "llm_canonical_name_as_id",
        "crm_id_cross_tenant_merge",
        "recycled_employee_id_as_same_person",
        "redacted_name_as_public_identity",
        "stale_alias_as_current_entity",
        "merged_account_without_split_policy",
        "split_entity_without_tombstone",
        "external_uri_without_context",
        "relationship_edge_without_identity_evidence",
        "memory_note_as_identity_authority",
        "missing_temporal_state_transition_contract",
        "current_snapshot_as_truth",
        "missing_valid_time",
        "missing_transaction_time",
        "local_timestamp_as_global_order",
        "spreadsheet_order_as_event_order",
        "llm_summary_as_event_log",
        "late_event_ignored",
        "retroactive_correction_without_tx_history",
        "future_effective_as_current",
        "expired_state_as_active",
        "deleted_state_without_tombstone",
        "non_idempotent_replay",
        "materialized_view_as_source_of_truth",
        "projection_without_version",
        "recurring_event_without_rule",
        "timezone_free_deadline",
        "state_transition_without_precondition",
        "partial_failure_as_success",
        "clock_skew_as_fact",
        "scheduled_job_without_receipt",
        "memory_fact_without_validity_interval",
        "graph_edge_without_temporal_bounds",
        "missing_capability_delegation_authority_contract",
        "role_as_capability",
        "oauth_scope_as_task_permission",
        "api_key_as_actor",
        "read_access_as_write_authority",
        "parent_agent_unbounded_delegation",
        "delegation_chain_missing",
        "purpose_mismatch_authority",
        "capability_without_caveats",
        "stale_capability_token_as_current",
        "cross_context_capability_reuse",
        "capability_escalation_by_tool_choice",
        "subagent_exceeds_parent_authority",
        "human_consent_reused_for_new_purpose",
        "permission_prompt_as_policy",
        "tool_schema_as_authorization",
        "cached_auth_decision_without_fresh_context",
        "break_glass_without_expiry",
        "admin_role_as_all_actions",
        "shared_service_account_as_identity",
        "task_goal_as_permission",
        "hidden_tool_call_without_policy_decision",
        "missing_privacy_confidentiality_boundary_contract",
        "pii_as_normal_fact",
        "secret_as_graph_label",
        "confidential_deck_as_public_context",
        "consent_missing_for_personal_data",
        "legal_basis_missing_for_processing",
        "purpose_reuse_without_privacy_review",
        "training_on_private_material",
        "public_export_without_redaction",
        "retention_expired_memory",
        "data_subject_delete_ignored",
        "cross_tenant_context_bleed",
        "customer_data_as_public_demo",
        "personal_life_as_company_context",
        "employee_note_as_hr_decision",
        "inferred_sensitive_attribute_to_output",
        "redacted_text_reidentified",
        "connector_cache_as_allowed_use",
        "screenshot_ocr_without_classification",
        "embedding_of_secret_without_policy",
        "vector_search_private_neighbor_leak",
        "shared_memory_without_audience_boundary",
        "confidential_source_to_untrusted_model",
        "legal_privilege_lost_by_disclosure",
        "missing_strategic_incentive_compatibility_contract",
        "self_report_as_truth",
        "kpi_as_objective",
        "commission_report_as_fact",
        "manager_approval_as_no_conflict",
        "vendor_claim_as_source_quality",
        "customer_rating_as_value",
        "agent_vote_as_independent_signal",
        "benchmark_score_as_general_capability",
        "cheap_provider_as_best_provider",
        "data_provider_label_as_quality",
        "compliance_attestation_as_compliance",
        "peer_pressure_as_consensus",
        "hidden_affiliation_as_neutral_review",
        "survey_response_as_stable_preference",
        "retention_metric_as_satisfaction",
        "access_request_as_need_to_know",
        "family_pressure_as_user_preference",
        "approval_chain_as_truthfulness",
        "cost_saving_as_system_health",
        "strategic_silence_as_no_risk",
        "collusive_agents_as_quorum",
        "mechanism_missing_to_runtime_write",
        "incentive_conflict_to_memory_write",
        "reward_model_as_human_goal",
        "missing_reflexive_feedback_stability_contract",
        "observation_after_intervention_as_neutral_truth",
        "recommendation_effect_as_preference",
        "self_generated_content_as_training_data",
        "model_output_as_source_corpus",
        "dashboard_change_as_system_improvement",
        "metric_response_as_real_world_gain",
        "repeated_retrieval_as_relevance",
        "agent_self_score_as_external_feedback",
        "closed_loop_without_counterfactual",
        "runaway_feedback_to_runtime_write",
        "oscillation_as_adaptation",
        "delayed_harm_ignored",
        "synthetic_data_loop_as_real_distribution",
        "intervention_without_stop_condition",
        "user_adaptation_as_stable_preference",
        "market_response_as_causal_truth",
        "personal_nudge_as_identity_change",
        "training_on_ai_outputs_without_real_anchor",
        "feedback_loop_to_memory_write",
        "feedback_loop_to_policy_write",
        "externality_free_assumption",
        "correlation_as_causation",
        "unsupported_claim",
        "direct_durable_memory_write",
        "raw_prompt_or_secret_memory_capture",
      ],
      promotionPolicy: {
        shadowRequired: true,
        canaryRequiredForMixedContext: true,
        rollbackRequired: true,
        syncReviewRequired: true,
        appbridgeSourceWritesBlocked: true,
        memoryCuratorBridgeRequired: true,
        openWorldCoverageRequired: true,
        unknownCombinationRuntimeWritesBlocked: true,
        uncoveredModalityRuntimeWritesBlocked: true,
        consensusCoordinationRequired: true,
        agentAgreementRuntimeWritesBlocked: true,
        majorityVoteRuntimeWritesBlocked: true,
        splitBrainRuntimeWritesBlocked: true,
        taskCoverageRequired: true,
        contextualFlowRequired: true,
        causalImpactRequired: true,
        assuranceCaseRequired: true,
        knowledgeHomeostasisRequired: true,
        adversarialProvenanceRequired: true,
        untrustedSourceRuntimeWritesBlocked: true,
        epistemicCalibrationRequired: true,
        uncalibratedRuntimeWritesBlocked: true,
        semanticAlignmentRequired: true,
        highAuthorityAlignmentReviewRequired: true,
        unreviewedSemanticRuntimeWritesBlocked: true,
        resilienceControlRequired: true,
        degradedRuntimeWritesBlocked: true,
        emergencyStopBypassBlocked: true,
        invariantVerificationRequired: true,
        runtimeInvariantWritesBlocked: true,
        forbiddenTransitionBlocked: true,
        observabilityTelemetryRequired: true,
        unobservableRuntimeWritesBlocked: true,
        auditSinkRequired: true,
        crossSurfaceCorrelationRequired: true,
        objectiveProxyValidityRequired: true,
        proxyOptimizationRuntimeWritesBlocked: true,
        countermetricRequired: true,
        metricGamingProbeRequired: true,
        stakeholderPreferenceGovernanceRequired: true,
        singleStakeholderRuntimeWritesBlocked: true,
        aggregationRuleRequired: true,
        appealPathRequired: true,
        normativeAuthorityDriftRequired: true,
        stalePolicyRuntimeWritesBlocked: true,
        jurisdictionScopeRequired: true,
        authorityHierarchyRequired: true,
        sideEffectContainmentRequired: true,
        irreversibleRuntimeActionsBlocked: true,
        idempotencyKeyRequired: true,
        compensationPlanRequired: true,
        sourceLineageVersionRequired: true,
        unversionedSourceRuntimeWritesBlocked: true,
        derivedArtifactPromotionBlocked: true,
        lineageRepairRequired: true,
        entityIdentityResolutionRequired: true,
        ambiguousIdentityRuntimeWritesBlocked: true,
        identityMergeReviewRequired: true,
        identityRollbackRequired: true,
        temporalStateTransitionRequired: true,
        timelessStateRuntimeWritesBlocked: true,
        eventReplayRequired: true,
        projectionVersionRequired: true,
        capabilityDelegationAuthorityRequired: true,
        unscopedCapabilityRuntimeWritesBlocked: true,
        delegationChainRequired: true,
        capabilityAttenuationRequired: true,
        purposeBoundCapabilityRequired: true,
        directDurableMemoryWritesBlocked: true,
        privacyConfidentialityBoundaryRequired: true,
        unclassifiedPrivateRuntimeWritesBlocked: true,
        privacyBoundaryReviewRequired: true,
        publicTrainingDisclosureFlagRequired: true,
        deletionAndRetentionStateRequired: true,
        crossTenantPrivacyBleedBlocked: true,
        strategicIncentiveCompatibilityRequired: true,
        incentiveConflictRuntimeWritesBlocked: true,
        mechanismReviewRequired: true,
        independentVerificationRequired: true,
        collusionCheckRequired: true,
        mechanismRedesignRequired: true,
        reflexiveFeedbackStabilityRequired: true,
        postInterventionRuntimeWritesBlocked: true,
        feedbackHoldoutRequired: true,
        realWorldAnchorRequired: true,
        dampingAndStopConditionRequired: true,
        modelCollapseLoopBlocked: true,
      },
      surfacePolicy: {
        desktopTerminal: {
          defaultDecision: "shadow_required",
          notes: "Local graph-write behavior needs permission audit and replay.",
        },
        appbridge: {
          defaultDecision: "blocked",
          notes: "AppBridge remains a route adapter, never the source of truth.",
        },
      },
    },
    null,
    2,
  );
}

function superOntologyContextualFlowSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-contextual-flow",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "contextual_flow_required_before_boundary_crossing",
      flowStages: [
        "user_to_agent",
        "agent_to_tool",
        "tool_to_agent",
        "agent_to_agent",
        "agent_to_memory",
        "agent_to_output",
        "agent_to_public_surface",
      ],
      contexts: ["personal", "company", "customer", "public", "regulated", "agent_internal"],
      requiredParameters: [
        "source_context",
        "target_context",
        "sender_role",
        "recipient_role",
        "subject_role",
        "attribute_type",
        "transmission_principle",
        "purpose",
        "authority_basis",
        "sensitivity",
        "retention_policy",
        "audit_refs",
      ],
      decisions: ["allow", "redact", "aggregate_only", "review_required", "block"],
      researchBasis: [
        "contextual_integrity",
        "privacy_flow_graph",
        "multi_agent_contextual_privacy",
        "compositional_privacy",
        "information_flow_control",
        "nist_ai_rmf_gai_profile",
        "w3c_prov",
        "stpa_mode_confusion",
      ],
      hardStops: [
        "same_user_means_all_contexts_joinable",
        "tool_response_as_need_to_know",
        "public_output_after_private_handoff",
        "raw_prompt_or_transcript_to_memory",
        "customer_data_to_public_surface_without_consent",
        "regulated_data_to_training_without_consent_delete_path",
        "agent_internal_trace_to_user_output",
        "cross_project_join_without_scope_review",
      ],
    },
    null,
    2,
  );
}

function superOntologyCausalImpactSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-causal-impact",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "counterfactual_required_before_state_change",
      causalClaimTypes: [
        "correlation_only",
        "causal_hypothesis",
        "intervention",
        "counterfactual",
        "temporal_causal",
        "memory_intervention",
        "multi_agent_plan",
        "external_side_effect",
        "physical_or_train",
      ],
      requiredChecks: [
        "intervention_target",
        "expected_outcomes",
        "adverse_outcomes",
        "counterfactual_checks",
        "observability",
        "reversibility",
        "blast_radius",
        "blocked_write_surfaces",
        "rollback_plan",
      ],
      decisions: [
        "allow_read",
        "draft_only",
        "review_required",
        "shadow_required",
        "block",
      ],
      researchBasis: [
        "causal_rag",
        "causal_counterfactual_rag",
        "counterfactual_benchmark",
        "causal_planning",
        "causal_memory_intervention",
        "structural_causal_model",
        "resilience_engineering",
        "systems_theory",
      ],
      hardStops: [
        "correlation_as_causation",
        "retrieved_relation_as_action_permission",
        "missing_counterfactual_check",
        "missing_adverse_outcome",
        "missing_blast_radius",
        "missing_observability",
        "state_change_without_rollback",
        "physical_action_without_human_protocol",
        "training_without_consent_or_delete_path",
        "multi_agent_write_without_ordered_handoff",
      ],
    },
    null,
    2,
  );
}

function superOntologyAssuranceCaseSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-assurance-case",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "evidence_linked_claim_required",
      claimTypes: [
        "scope_boundary",
        "source_provenance",
        "knowledge_integrity",
        "memory_safety",
        "action_safety",
        "task_coverage",
        "world_coverage",
        "promotion_safety",
        "sync_integrity",
        "red_team_reporting",
        "rejected_overclaim",
      ],
      evidenceKinds: [
        "schema_check",
        "fixture_check",
        "public_safety_check",
        "typecheck",
        "build",
        "sync_check",
        "shadow_replay",
        "canary_replay",
        "rollback_drill",
        "constraint_validation",
        "provenance_standard",
        "official_standard",
        "red_team_report",
        "human_review",
        "rejected_claim",
      ],
      validators: [
        "json_schema",
        "jsonl_fixture_checker",
        "public_safety_scan",
        "typecheck",
        "sync_gate",
        "shadow_canary_replay",
        "rollback_drill",
        "provenance_ledger",
        "constraint_shape",
        "red_team_question_bank",
        "human_review_queue",
      ],
      researchBasis: [
        "assurance_case",
        "argument_graph",
        "compliance_by_construction",
        "w3c_prov",
        "w3c_shacl",
        "nist_ai_rmf_gai_profile",
        "genai_red_team_reporting",
        "llm_kg_construction",
        "ontology_validation",
        "no_free_lunch",
      ],
      hardStops: [
        "unsupported_claim",
        "missing_required_evidence",
        "hidden_missing_evidence",
        "missing_validator",
        "missing_residual_risk",
        "missing_rollback_plan",
        "perfect_or_zero_error_claim",
        "red_team_without_followup",
        "runtime_claim_without_shadow_or_canary",
        "appbridge_source_of_truth_claim",
      ],
    },
    null,
    2,
  );
}

function superOntologyKnowledgeHomeostasisSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-knowledge-homeostasis",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "homeostasis_required_before_runtime_or_memory_write",
      signals: [
        "contradiction_rate",
        "stale_claim_age",
        "schema_violation_rate",
        "parser_error_rate",
        "unsupported_claim_rate",
        "repair_backlog",
        "replay_failure_rate",
        "drift_rate",
        "source_freshness",
        "authority_expiry",
        "privacy_incident",
        "promotion_evidence_gap",
        "user_correction_rate",
        "runtime_desync_rate",
      ],
      decisions: [
        "continue",
        "quarantine",
        "degrade_to_read_only",
        "require_review",
        "replay",
        "repair",
        "rollback",
        "block_promotion",
        "retire",
      ],
      requiredParameters: [
        "monitored_artifact",
        "scope_id",
        "surface",
        "signal_type",
        "measurement",
        "severity",
        "affected_contexts",
        "affected_lenses",
        "affected_claims",
        "affected_surfaces",
        "error_budget",
        "control_decision",
        "automation_level",
        "escalation",
        "evidence_refs",
        "rollback_plan",
        "memory_curator_policy",
        "public_export_policy",
      ],
      researchBasis: [
        "shacl_validation",
        "kg_repair_evaluation",
        "ontology_change_propagation",
        "truth_maintenance",
        "data_observability",
        "resilience_engineering",
        "homeostatic_control",
        "w3c_prov",
        "nist_ai_rmf",
        "ai_agent_index",
      ],
      hardStops: [
        "error_budget_overrun_continues",
        "critical_homeostasis_runtime_write",
        "privacy_incident_public_export",
        "appbridge_route_as_source_authority",
        "stale_claim_as_current_truth",
        "parser_error_as_complete_source",
        "missing_homeostasis_evidence",
        "memory_write_without_ticket_or_quarantine",
        "runtime_desync_ignored",
        "literal_perfection_claim",
      ],
    },
    null,
    2,
  );
}

function superOntologyAdversarialProvenanceSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-adversarial-provenance",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "zero_trust_provenance_required_before_retrieval_memory_tool_or_public_seed",
      sourceChannels: [
        "upload",
        "web",
        "email",
        "chat",
        "tool_response",
        "connector",
        "memory_recall",
        "public_repo",
        "media_asset",
        "appbridge_route",
        "generated_artifact",
        "dataset",
      ],
      attackVectors: [
        "prompt_injection",
        "instruction_smuggling",
        "data_poisoning",
        "provenance_forgery",
        "citation_spoofing",
        "tool_output_tampering",
        "ocr_hidden_text",
        "cross_context_exfiltration",
        "supply_chain_tampering",
        "memory_poisoning",
        "social_engineering",
        "model_policy_bypass",
        "media_provenance_conflict",
        "stale_trusted_source_replay",
      ],
      trustBoundaries: [
        "untrusted_external",
        "user_private",
        "company_internal",
        "customer_confidential",
        "public_web",
        "runtime_tool",
        "agent_internal",
        "memory_store",
        "release_artifact",
      ],
      instructionPolicies: [
        "treat_as_data_only",
        "strip_instructions",
        "quote_only",
        "sandbox_tool_output",
        "require_signature",
        "require_human_review",
        "block",
      ],
      retrievalPolicies: [
        "exclude_from_retrieval",
        "metadata_only",
        "citation_only",
        "quarantined_candidate",
        "low_trust_retrieval",
        "allow_after_verification",
      ],
      memoryPolicies: [
        "no_memory",
        "quarantine_ticket",
        "redact_then_ticket",
        "supersede_after_review",
        "discard",
      ],
      toolPolicies: [
        "no_tool_use",
        "dry_run_only",
        "allowlisted_read_only",
        "require_human_approval",
        "block_external_effect",
      ],
      promotionDecisions: [
        "allow_read",
        "quarantine",
        "review_required",
        "shadow_required",
        "block",
        "retire_source",
      ],
      requiredParameters: [
        "source_channel",
        "attack_vector",
        "trust_boundary",
        "claimed_authority",
        "observed_artifact",
        "provenance_evidence",
        "integrity_checks",
        "instruction_policy",
        "retrieval_policy",
        "memory_policy",
        "tool_policy",
        "promotion_decision",
        "required_controls",
        "must_not_do",
        "evidence_refs",
        "rollback_plan",
      ],
      researchBasis: [
        "owasp_llm_top10",
        "mitre_atlas",
        "nist_adversarial_ml",
        "slsa_provenance",
        "in_toto_attestation",
        "c2pa_content_credentials",
        "zero_trust_architecture",
        "information_flow_control",
        "adversarial_rag",
        "secure_rag_prompt_injection",
      ],
      hardStops: [
        "prompt_injection_as_instruction",
        "instruction_smuggling_as_policy",
        "poisoned_source_to_memory",
        "forged_provenance_as_trusted_source",
        "spoofed_citation_as_grounded_fact",
        "tool_output_tampering_to_action",
        "hidden_ocr_instruction_as_user_intent",
        "cross_context_exfiltration",
        "unsigned_release_artifact",
        "route_output_as_source_write_authority",
        "stale_trusted_source_replay_as_current_truth",
        "missing_adversarial_provenance_evidence",
      ],
    },
    null,
    2,
  );
}

function superOntologyEpistemicCalibrationSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-epistemic-calibration",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "calibrated_uncertainty_required_before_answer_memory_tool_or_public_seed",
      contextTypes: [
        "user_personal",
        "company_internal",
        "customer_confidential",
        "public_web",
        "regulated",
        "scientific",
        "software",
        "finance_compliance",
        "physical",
        "creative",
        "agent_internal",
        "mixed_context",
        "multimodal",
        "appbridge_route",
        "release_surface",
      ],
      claimTypes: [
        "factual_answer",
        "graph_edge",
        "ontology_class",
        "relation_mapping",
        "action_plan",
        "memory_write",
        "tool_action",
        "public_export",
        "legal_or_policy",
        "financial_estimate",
        "scientific_claim",
        "physical_action",
        "creative_generation",
        "route_sync",
        "generated_artifact",
      ],
      uncertaintySources: [
        "missing_evidence",
        "conflicting_sources",
        "low_retrieval_relevance",
        "distribution_shift",
        "ambiguous_intent",
        "insufficient_permissions",
        "temporal_staleness",
        "noisy_ocr",
        "model_disagreement",
        "tool_inconclusive",
        "causal_unknown",
        "private_context_gap",
        "benchmark_gap",
        "low_calibration_support",
        "adversarial_source_uncertain",
        "no_ground_truth",
      ],
      epistemicStates: [
        "known_enough_for_read",
        "partially_supported",
        "contested",
        "underspecified",
        "out_of_distribution",
        "uncalibrated",
        "unknowable_for_now",
      ],
      calibrationSignals: [
        "conformal_set_size",
        "confidence_interval",
        "prediction_set",
        "abstention_score",
        "evidence_coverage",
        "retrieval_entropy",
        "contradiction_score",
        "judge_interval",
        "self_eval_none_of_above",
        "ensemble_disagreement",
        "holdout_error_rate",
        "calibration_error",
        "ood_score",
        "human_feedback_gap",
      ],
      confidenceBands: [
        "calibrated_high",
        "calibrated_medium",
        "calibrated_low",
        "uncalibrated",
        "unknown",
      ],
      riskTiers: ["low", "moderate", "high", "critical"],
      allowedOutputs: [
        "answer_with_caveat",
        "ask_clarifying_question",
        "retrieve_more",
        "cite_only",
        "draft_only",
        "human_review",
        "abstain",
        "block",
        "shadow_replay",
      ],
      requiredParameters: [
        "context_type",
        "claim_type",
        "uncertainty_source",
        "epistemic_state",
        "calibration_signal",
        "confidence_band",
        "risk_tier",
        "allowed_output",
        "required_controls",
        "blocked_shortcuts",
        "evidence_refs",
        "research_basis",
        "memory_policy",
        "tool_policy",
        "public_export_policy",
        "rollback_plan",
      ],
      researchBasis: [
        "conformal_prediction",
        "conformal_risk_control",
        "selective_prediction",
        "abstention_policy",
        "llm_self_evaluation",
        "verbalized_confidence_calibration",
        "rag_uncertainty_benchmark",
        "nist_ai_rmf",
        "ood_detection",
        "human_in_the_loop",
        "calibration_error",
        "uncertainty_alignment",
      ],
      hardStops: [
        "missing_evidence_as_complete_answer",
        "conflicting_sources_as_current_truth",
        "low_retrieval_relevance_as_confident_answer",
        "ambiguous_intent_to_memory_write",
        "distribution_shift_to_financial_estimate",
        "stale_policy_as_current_policy",
        "model_disagreement_as_consensus",
        "noisy_ocr_as_ontology_class",
        "inconclusive_tool_output_to_action",
        "causal_unknown_to_physical_action",
        "benchmark_gap_to_public_release",
        "uncalibrated_route_sync",
        "adversarial_uncertainty_to_graph_edge",
        "wide_judge_interval_to_regulated_answer",
      ],
    },
    null,
    2,
  );
}

function superOntologySemanticAlignmentSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-semantic-alignment",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "scoped_candidate_alignment_required_before_graph_memory_or_public_seed",
      sourceContexts: [
        "company_internal",
        "user_personal",
        "customer_confidential",
        "public_web",
        "regulated",
        "scientific",
        "software_schema",
        "finance_compliance",
        "multimodal_ocr",
        "appbridge_route",
        "release_surface",
        "cross_team",
        "legacy_system",
        "mixed_context",
        "generated_artifact",
      ],
      artifactTypes: [
        "glossary",
        "database_schema",
        "spreadsheet",
        "presentation",
        "contract",
        "policy_doc",
        "source_code",
        "ticket",
        "email",
        "pdf",
        "image_ocr",
        "ontology",
        "knowledge_graph",
        "app_route",
        "generated_output",
      ],
      alignmentIntents: [
        "synonym_discovery",
        "schema_column_match",
        "class_alignment",
        "property_alignment",
        "entity_resolution",
        "hierarchy_mapping",
        "relation_mapping",
        "unit_mapping",
        "business_process_mapping",
        "compliance_mapping",
        "source_system_merge",
        "ontology_change",
        "release_sync",
        "memory_merge",
        "no_match_detection",
      ],
      candidateRelations: [
        "exact_match",
        "close_match",
        "broad_match",
        "narrow_match",
        "related_match",
        "equivalent_class",
        "equivalent_property",
        "same_individual",
        "synonym",
        "no_match",
        "conflict",
      ],
      alignmentScopes: [
        "local_task",
        "project",
        "team",
        "company",
        "customer",
        "regulated_domain",
        "public_export",
        "appbridge_route",
        "release_surface",
      ],
      ambiguityTypes: [
        "homonym",
        "synonym",
        "polysemy",
        "abbreviation",
        "language_variant",
        "unit_mismatch",
        "temporal_version",
        "scope_collision",
        "granularity_mismatch",
        "relation_direction_unknown",
        "entity_class_confusion",
        "ocr_noise",
        "source_conflict",
        "generated_label",
        "missing_definition",
      ],
      validationChecks: [
        "candidate_retrieval",
        "bidirectional_check",
        "contradiction_check",
        "disjointness_check",
        "transitivity_check",
        "sample_instance_check",
        "roundtrip_query_check",
        "shacl_validation",
        "owl_consistency",
        "kgcl_diff",
        "human_owner_review",
        "rollback_drill",
        "shadow_replay",
        "relation_direction_check",
        "unit_compatibility",
      ],
      researchBasis: [
        "skos_mapping",
        "owl_reasoning",
        "shacl_validation",
        "kgcl_change_language",
        "llm_schema_matching",
        "retrieval_augmented_ontology_matching",
        "human_in_loop_schema_discovery",
        "schema_rollup_drilldown",
        "entity_resolution",
        "data_contracts",
        "provenance_review",
        "ontology_change_management",
      ],
      hardStops: [
        "same_label_as_same_meaning",
        "embedding_similarity_as_exact_match",
        "close_match_as_transitive_truth",
        "abbreviation_without_owner_glossary",
        "broad_or_narrow_without_direction_check",
        "generated_label_as_ontology_class",
        "ocr_label_as_property_alignment",
        "appbridge_route_as_source_ontology_edit",
        "source_conflict_to_memory_merge",
        "customer_confidential_mapping_to_public_export",
        "release_sync_without_rollback",
        "ontology_change_without_diff",
        "same_individual_without_stable_identifier",
        "unit_label_without_unit_compatibility",
        "no_match_promoted_to_weak_match",
      ],
    },
    null,
    2,
  );
}

function superOntologyResilienceControlSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-resilience-control",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "degrade_authority_before_runtime_graph_memory_tool_or_sync_write",
      controlLoopPhases: ["monitor", "analyze", "plan", "execute", "learn", "sync"],
      operatingModes: [
        "nominal",
        "watch",
        "degraded",
        "shadow_only",
        "read_only",
        "quarantine",
        "owner_review",
        "rollback",
        "emergency_stop",
      ],
      degradationSignals: [
        "contradiction_spike",
        "validator_disagreement",
        "retrieval_drift",
        "semantic_alignment_regression",
        "provenance_gap",
        "memory_curator_backlog",
        "tool_error_spike",
        "user_correction_spike",
        "unknown_task_family",
        "context_flow_violation",
        "causal_impact_uncertain",
        "sync_drift",
        "model_judge_divergence",
        "latency_budget_overrun",
        "replay_failure",
        "permission_boundary_unknown",
        "sensor_or_parser_degraded",
        "external_side_effect_detected",
      ],
      hazardTypes: [
        "unsafe_control_action",
        "missing_feedback",
        "delayed_feedback",
        "wrong_mode",
        "authority_escalation",
        "control_loop_oscillation",
        "stale_process_model",
        "degraded_sensor",
        "conflicting_controller",
        "runaway_repair",
        "unbounded_retry",
        "brittle_threshold",
        "silent_fail_open",
        "operator_overload",
      ],
      controlDecisions: [
        "continue",
        "observe",
        "ask_clarify",
        "retrieve_more",
        "shadow_only",
        "read_only",
        "quarantine",
        "require_owner_review",
        "rollback",
        "emergency_stop",
      ],
      requiredFeedback: [
        "fresh_source_retrieval",
        "validator_matrix",
        "curator_queue_depth",
        "tool_trace",
        "source_identity_check",
        "contextual_flow_replay",
        "causal_impact_review",
        "semantic_alignment_replay",
        "epistemic_calibration_replay",
        "architecture_sync_diff",
        "rollback_confirmation",
        "owner_review_ticket",
      ],
      researchBasis: [
        "mape_k",
        "self_adaptive_systems",
        "stpa",
        "unsafe_control_actions",
        "robustness_analysis",
        "degradation_state_analysis",
        "agentic_self_awareness",
        "adaptive_hierarchical_kg",
        "resilience_engineering",
        "cybernetics_feedback",
        "incident_command",
        "sociotechnical_escalation",
      ],
      hardStops: [
        "validator_disagreement_to_graph_write",
        "retrieval_drift_to_current_answer",
        "semantic_regression_to_memory_merge",
        "provenance_gap_to_tool_authority",
        "curator_backlog_to_direct_memory_write",
        "tool_error_spike_to_unbounded_retry",
        "unknown_task_to_normal_execution",
        "context_flow_violation_to_public_export",
        "sync_drift_to_release_surface",
        "judge_divergence_to_regulated_answer",
        "degraded_parser_to_ontology_class",
        "rollback_failure_to_runtime_promotion",
        "emergency_stop_bypass_by_route",
      ],
    },
    null,
    2,
  );
}

function superOntologyInvariantVerificationSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-invariant-verification",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "runtime_monitor_required_before_graph_memory_tool_route_release_or_public_write",
      eventStreams: [
        "source_intake",
        "evidence_packet",
        "belief_update",
        "semantic_alignment",
        "resilience_mode",
        "memory_ticket",
        "graph_write",
        "tool_call",
        "public_export",
        "route_sync",
        "release_seed",
        "rollback",
        "emergency_stop",
      ],
      invariantTypes: [
        "safety",
        "liveness",
        "ordering",
        "separation",
        "cardinality",
        "idempotency",
        "provenance",
        "authority",
        "consent",
        "rollback",
        "audit",
        "determinism",
      ],
      temporalOperators: ["always", "never", "eventually", "until", "before", "after", "within", "once"],
      monitors: [
        "json_schema",
        "event_sequence",
        "state_machine",
        "temporal_logic",
        "property_test",
        "shadow_replay",
        "model_check",
        "sync_check",
        "curator_ticket_audit",
        "human_owner_review",
      ],
      violationActions: [
        "block",
        "reject",
        "quarantine",
        "rollback",
        "emergency_stop",
        "ask_clarify",
        "review_required",
        "shadow_only",
      ],
      researchBasis: [
        "runtime_verification",
        "temporal_logic",
        "model_checking",
        "contract_based_design",
        "assume_guarantee_contracts",
        "finite_state_monitor",
        "agent_runtime_monitoring",
        "formal_methods_for_planning",
        "formal_skill_verification",
        "multi_agent_safety_invariants",
        "memory_safety_invariants",
        "audit_log_invariants",
      ],
      hardStops: [
        "memory_write_without_ticket_invariant",
        "graph_write_without_evidence_invariant",
        "tool_action_without_authority_invariant",
        "public_export_without_flow_invariant",
        "route_sync_without_source_contract_invariant",
        "rollback_not_observed_after_violation",
        "emergency_stop_transition_bypassed",
        "unordered_multi_agent_write",
        "non_idempotent_replay_mutation",
      ],
    },
    null,
    2,
  );
}

function superOntologyObservabilityTelemetrySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-observability-telemetry",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "observability_required_before_runtime_graph_memory_tool_route_release_or_public_write",
      eventTypes: [
        "source_intake",
        "evidence_packet",
        "belief_update",
        "graph_write",
        "memory_ticket",
        "tool_action",
        "public_export",
        "route_sync",
        "release_seed",
        "repair_event",
        "rollback",
        "emergency_stop",
      ],
      failureModes: [
        "missing_trace_id",
        "dropped_span",
        "partial_log",
        "stale_metric",
        "redaction_gap",
        "audit_sink_down",
        "clock_skew",
        "sample_bias",
        "alert_suppression",
        "replay_not_recorded",
        "repair_without_snapshot",
        "cross_surface_correlation_missing",
      ],
      requiredTelemetry: [
        "trace_id",
        "span_id",
        "parent_span_id",
        "correlation_id",
        "source_ref",
        "evidence_ref",
        "actor_role",
        "authority_state",
        "decision_state",
        "risk_tier",
        "redaction_policy",
        "retention_policy",
        "clock_source",
        "checksum",
        "before_snapshot_ref",
        "after_snapshot_ref",
        "rollback_ref",
        "alert_ref",
        "audit_sink_ref",
        "sample_size",
      ],
      traceStates: ["complete", "partial", "missing", "corrupted", "untrusted", "redacted"],
      auditChannels: [
        "jsonl_ledger",
        "otel_trace",
        "memory_ticket",
        "sync_log",
        "release_log",
        "tool_receipt",
        "owner_review_queue",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "shadow_required",
        "sync_review_required",
        "quarantine",
        "rollback",
        "emergency_stop",
        "blocked",
      ],
      researchBasis: [
        "agent_execution_provenance",
        "agent_observability_telemetry",
        "trace_reasoning_benchmark",
        "opentelemetry",
        "w3c_trace_context",
        "sre_monitoring",
        "nist_ai_rmf_gai_profile",
        "runtime_assurance",
        "audit_log_invariants",
        "data_observability",
      ],
      hardStops: [
        "missing_observability_telemetry_contract",
        "write_without_trace_id",
        "memory_ticket_without_span_lineage",
        "tool_action_without_audit_receipt",
        "public_export_with_stale_metric",
        "route_sync_without_correlation_id",
        "release_seed_when_audit_sink_down",
        "redaction_missing_in_telemetry",
        "metric_green_without_sample_size",
        "alert_suppressed_during_degraded_mode",
        "shadow_replay_not_recorded",
        "repair_without_before_after_snapshot",
        "rollback_without_observed_event",
        "unobservable_runtime_write",
      ],
    },
    null,
    2,
  );
}

function superOntologyObjectiveProxyValiditySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-objective-proxy-validity",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "construct_validity_required_before_metric_driven_runtime_graph_memory_tool_route_release_or_public_write",
      constructs: [
        "user_value",
        "business_outcome",
        "safety",
        "quality",
        "truthfulness",
        "trust",
        "learning",
        "wellbeing",
        "compliance",
        "fairness",
        "reliability",
        "maintainability",
        "environmental_impact",
        "financial_return",
        "operational_efficiency",
        "reputation",
      ],
      proxyMetrics: [
        "approval_rate",
        "open_rate",
        "click_rate",
        "benchmark_score",
        "test_pass_rate",
        "self_judge_score",
        "ontology_edge_count",
        "memory_recall_count",
        "short_term_profit",
        "cost_per_execution",
        "green_dashboard_percentage",
        "reward_score_delta",
      ],
      validityGaps: [
        "construct_underdefined",
        "proxy_not_construct",
        "proxy_overoptimized",
        "benchmark_contamination",
        "reward_tampering",
        "metric_gaming",
        "stakeholder_harm_hidden",
        "short_term_metric_long_term_harm",
        "sample_not_representative",
        "measurement_noninvariance",
        "label_leakage",
        "evaluator_conflict",
        "target_shift",
      ],
      goodhartModes: [
        "regressional",
        "extremal",
        "causal",
        "adversarial",
        "campbell_law",
        "reward_hacking",
        "proxy_gaming",
        "benchmark_gaming",
      ],
      requiredValidityEvidence: [
        "construct_definition",
        "stakeholder_map",
        "countermetric",
        "negative_control",
        "holdout_distribution",
        "baseline_comparison",
        "item_level_analysis",
        "causal_path",
        "gaming_probe",
        "benchmark_provenance",
        "human_owner_review",
        "longitudinal_check",
        "measurement_invariance_check",
        "sample_size",
        "error_bar",
        "rollback_plan",
      ],
      countermetrics: [
        "harm_rate",
        "complaint_rate",
        "long_term_retention",
        "quality_review_score",
        "fairness_delta",
        "safety_incident_rate",
        "source_grounding_rate",
        "maintenance_burden",
        "cost_per_success",
        "reversal_rate",
        "learning_transfer",
        "user_trust_signal",
        "denominator",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "shadow_required",
        "human_review_required",
        "redesign_metric",
        "quarantine",
        "block_optimization",
        "rollback",
        "emergency_stop",
      ],
      researchBasis: [
        "goodharts_law",
        "campbells_law",
        "construct_validity",
        "psychometrics",
        "measurement_theory",
        "reward_hacking",
        "specification_gaming",
        "benchmark_validity",
        "ai_risk_management",
        "sociotechnical_evaluation",
        "causal_inference",
        "program_evaluation",
      ],
      hardStops: [
        "missing_objective_proxy_validity_contract",
        "metric_improvement_as_goal_completion",
        "approval_rate_as_trust",
        "benchmark_score_as_reliability",
        "test_pass_rate_as_maintainability",
        "open_rate_as_customer_value",
        "self_judge_score_as_truth",
        "edge_count_as_knowledge_quality",
        "short_term_profit_as_compliance",
        "cost_per_execution_as_sustainability",
        "reward_score_as_quality",
        "label_leakage_as_accuracy",
        "green_dashboard_as_health",
        "proxy_optimization_without_countermetric",
        "optimization_without_stakeholder_map",
        "metric_gaming_without_probe",
        "reward_tampering_to_promotion",
        "construct_underdefined_to_runtime_write",
        "unvalidated_proxy_to_public_release",
      ],
    },
    null,
    2,
  );
}

function superOntologyStakeholderPreferenceGovernanceSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-stakeholder-preference-governance",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "stakeholder_preference_governance_required_before_multi_party_runtime_graph_memory_tool_route_release_or_public_write",
      stakeholderRoles: [
        "individual_user",
        "project_owner",
        "team_member",
        "manager",
        "executive",
        "customer",
        "customer_end_user",
        "legal_compliance",
        "security_privacy",
        "sales_marketing",
        "operations_support",
        "finance_procurement",
        "public_audience",
        "regulator",
        "minority_or_vulnerable_group",
        "future_maintainer",
        "student",
        "teacher",
        "parent_guardian",
        "patient_or_caregiver",
      ],
      preferenceSignals: [
        "explicit_instruction",
        "approval_vote",
        "ranking",
        "policy_requirement",
        "legal_obligation",
        "contractual_constraint",
        "customer_feedback",
        "complaint",
        "usage_behavior",
        "accessibility_need",
        "safety_objection",
        "privacy_preference",
        "quality_review",
        "maintenance_burden",
        "cost_constraint",
        "minority_report",
        "professional_standard",
        "recency_check",
      ],
      conflictTypes: [
        "stakeholder_conflict",
        "value_tradeoff",
        "rights_constraint",
        "consent_boundary",
        "power_asymmetry",
        "minority_harm",
        "short_term_long_term_conflict",
        "private_public_tension",
        "role_scope_collision",
        "regulatory_conflict",
        "resource_allocation_conflict",
        "strategic_misreporting",
        "preference_drift",
        "unrepresented_party",
      ],
      aggregationRules: [
        "consent_required",
        "veto_for_rights",
        "owner_review",
        "policy_precedence",
        "weighted_deliberation",
        "ranked_choice",
        "majority_with_veto",
        "pareto_screen",
        "minimax_regret",
        "rawlsian_priority",
        "human_governance_board",
        "case_by_case_review",
        "no_aggregation_allowed",
      ],
      requiredGovernanceEvidence: [
        "stakeholder_map",
        "preference_source",
        "scope_of_authority",
        "affected_party_analysis",
        "aggregation_rule",
        "rights_constraint_check",
        "minority_report",
        "dissent_capture",
        "consent_record",
        "appeal_path",
        "rollback_plan",
        "review_owner",
        "tradeoff_rationale",
        "public_private_boundary",
        "recency_check",
        "policy_or_contract_ref",
        "manipulation_probe",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "ask_clarify",
        "human_review_required",
        "policy_review_required",
        "consent_required",
        "redesign_tradeoff",
        "quarantine",
        "block_write",
        "rollback",
        "emergency_stop",
      ],
      researchBasis: [
        "social_choice_theory",
        "arrow_impossibility",
        "gibbard_satterthwaite",
        "pluralistic_alignment",
        "multi_stakeholder_alignment",
        "deliberative_democracy",
        "stakeholder_theory",
        "value_sensitive_design",
        "participatory_design",
        "procedural_justice",
        "ai_risk_management",
        "human_subjects_ethics",
        "governance_risk_compliance",
      ],
      hardStops: [
        "missing_stakeholder_preference_governance_contract",
        "single_stakeholder_preference_as_global_goal",
        "owner_preference_as_all_stakeholders",
        "majority_preference_as_rights_clearance",
        "average_utility_over_protected_constraint",
        "hidden_affected_party",
        "missing_appeal_path",
        "missing_dissent_capture",
        "strategic_preference_report_as_truth",
        "preference_aggregation_without_rule",
        "preference_conflict_to_runtime_write",
        "consent_absent_to_personalization",
        "minority_harm_hidden_by_aggregate",
        "irreversible_action_without_stakeholder_review",
        "private_preference_to_public_release",
        "cross_context_preference_reuse_without_scope",
        "role_power_as_legitimacy",
        "arrow_impossibility_ignored",
        "manipulable_vote_as_stable_preference",
        "stakeholder_map_missing_for_release",
      ],
    },
    null,
    2,
  );
}

function superOntologyNormativeAuthorityDriftSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-normative-authority-drift",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "normative_authority_required_before_policy_legal_compliance_contract_license_consent_or_runtime_write",
      authorityTypes: [
        "law",
        "regulation",
        "contract",
        "terms_of_service",
        "internal_policy",
        "security_policy",
        "privacy_policy",
        "data_retention_policy",
        "license",
        "standard",
        "professional_guideline",
        "customer_commitment",
        "board_decision",
        "manager_directive",
        "emergency_exception",
      ],
      scopeDimensions: [
        "jurisdiction",
        "effective_date",
        "expiry_date",
        "organization",
        "workspace",
        "role",
        "customer_segment",
        "data_category",
        "system_surface",
        "action_type",
        "retention_period",
        "transfer_region",
        "license_scope",
        "exception_scope",
      ],
      conflictTypes: [
        "stale_authority",
        "wrong_jurisdiction",
        "draft_vs_enforced",
        "superseded_rule",
        "authority_conflict",
        "exception_misuse",
        "translation_mismatch",
        "summary_vs_primary_source",
        "role_authority_gap",
        "license_conflict",
        "retention_conflict",
        "cross_border_conflict",
        "emergency_override",
        "professional_boundary",
      ],
      effectiveTimeStates: [
        "current",
        "stale",
        "future_effective",
        "expired",
        "draft",
        "superseded",
        "unknown",
        "exception_active",
        "emergency_exception",
      ],
      jurisdictionStates: [
        "in_scope",
        "out_of_scope",
        "mixed",
        "unknown",
        "cross_border",
        "local_only",
        "global_claim_unverified",
      ],
      authorityHierarchyRules: [
        "primary_source_precedence",
        "newer_version_precedence",
        "contract_clause_precedence",
        "stricter_rule_precedence",
        "local_law_precedence",
        "internal_policy_after_law",
        "exception_requires_owner_expiry",
        "human_legal_review",
        "no_precedence_available",
      ],
      requiredAuthorityEvidence: [
        "primary_source_ref",
        "effective_date",
        "version_id",
        "jurisdiction_scope",
        "authority_owner",
        "precedence_rule",
        "exception_owner",
        "expiry_or_review_date",
        "policy_citation",
        "contract_clause",
        "license_text",
        "retention_rule",
        "transfer_rule",
        "review_owner",
        "rollback_plan",
        "audit_trail",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "ask_clarify",
        "human_review_required",
        "policy_review_required",
        "legal_review_required",
        "security_review_required",
        "quarantine",
        "block_write",
        "rollback",
        "emergency_stop",
      ],
      researchBasis: [
        "legal_informatics",
        "governance_risk_compliance",
        "policy_as_code",
        "compliance_automation",
        "temporal_knowledge_graphs",
        "deontic_logic",
        "defeasible_reasoning",
        "regulatory_change_management",
        "records_management",
        "data_protection",
        "software_supply_chain_governance",
        "provenance_standards",
        "rights_expression_language",
        "ai_management_systems",
      ],
      hardStops: [
        "missing_normative_authority_drift_contract",
        "stale_policy_as_current_rule",
        "wrong_jurisdiction_as_valid_policy",
        "draft_policy_as_enforced_rule",
        "superseded_contract_as_current_authority",
        "terms_of_service_without_effective_date",
        "local_custom_as_global_policy",
        "internal_preference_as_legal_requirement",
        "policy_exception_without_owner",
        "conflicting_authorities_without_precedence",
        "regulation_summary_as_primary_law",
        "compliance_claim_without_citation",
        "policy_translation_as_authoritative_text",
        "expired_consent_as_current_permission",
        "missing_retention_or_deletion_rule",
        "cross_border_transfer_without_jurisdiction",
        "licensing_constraint_ignored",
        "audit_requirement_missing_before_release",
        "emergency_exception_without_expiry",
        "legal_advice_without_review",
      ],
    },
    null,
    2,
  );
}

function superOntologySideEffectContainmentSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-side-effect-containment",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "containment_required_before_external_file_finance_release_message_route_memory_training_or_physical_action",
      sideEffectClasses: [
        "file_mutation",
        "external_message",
        "payment_or_finance",
        "customer_record_update",
        "public_release",
        "account_permission_change",
        "data_transfer",
        "memory_write",
        "training_update",
        "code_execution",
        "physical_actuation",
        "scheduled_job",
        "multi_system_workflow",
        "legal_or_compliance_commitment",
      ],
      actionSurfaces: [
        "local_file_system",
        "email_or_chat",
        "crm_or_customer_system",
        "payment_or_procurement",
        "public_web_or_social",
        "release_pipeline",
        "cloud_admin",
        "database_write",
        "memory_curator",
        "training_pipeline",
        "physical_or_sensor",
        "appbridge_route",
        "hosted_connector",
        "shell_or_code_runner",
      ],
      reversibilityStates: [
        "read_only",
        "preview_only",
        "reversible",
        "compensable",
        "retryable_after_pivot",
        "irreversible",
        "unknown",
      ],
      transactionBoundaries: [
        "single_local_transaction",
        "saga_compensating_transaction",
        "external_api_commit",
        "human_approval_boundary",
        "two_phase_commit_required",
        "no_transaction_boundary",
        "scheduled_future_commit",
        "physical_world_boundary",
      ],
      idempotencyStates: [
        "idempotent_key_present",
        "idempotent_by_design",
        "non_idempotent",
        "duplicate_risk_unknown",
        "retry_guard_missing",
        "replay_safe_dry_run",
      ],
      blastRadii: [
        "user_local",
        "workspace",
        "customer",
        "organization",
        "public",
        "financial",
        "legal_compliance",
        "physical_safety",
        "cross_system",
        "cross_border_data",
      ],
      externalCommitStates: [
        "not_committed",
        "dry_run_only",
        "pending_human_commit",
        "committed_with_receipt",
        "partial_commit",
        "ambiguous_commit",
        "scheduled_commit",
        "irreversible_commit",
      ],
      requiredContainmentEvidence: [
        "user_intent_span",
        "tool_scope",
        "auth_scope",
        "idempotency_key",
        "dry_run_receipt",
        "preflight_diff",
        "approval_receipt",
        "transaction_log",
        "compensation_action",
        "rollback_snapshot",
        "cancellation_path",
        "rate_limit_budget",
        "blast_radius_bound",
        "external_commit_receipt",
        "audit_trace",
        "policy_gate_ref",
        "memory_ticket_ref",
        "safety_interlock",
        "operator_owner",
        "post_action_verification",
      ],
      decisions: [
        "allow_read",
        "allow_dry_run",
        "prepare_only",
        "ask_clarify",
        "human_approval_required",
        "policy_review_required",
        "security_review_required",
        "containment_required",
        "block_execute",
        "rollback",
        "compensate",
        "emergency_stop",
      ],
      researchBasis: [
        "excessive_agency",
        "least_privilege",
        "systems_security_engineering",
        "saga_pattern",
        "compensating_transaction",
        "idempotent_workflow",
        "human_in_the_loop",
        "complete_mediation",
        "rate_limiting",
        "auditability",
        "safety_engineering",
        "transaction_processing",
        "secure_agent_guardrails",
        "disaster_recovery",
      ],
      hardStops: [
        "missing_side_effect_containment_contract",
        "read_permission_as_write_permission",
        "preview_as_send",
        "dry_run_result_as_committed",
        "non_idempotent_retry_to_external_action",
        "irreversible_action_without_human_approval",
        "deletion_without_recovery_plan",
        "payment_without_idempotency_key",
        "customer_message_without_review",
        "release_without_rollback",
        "connector_write_without_scope",
        "cross_tool_chain_without_transaction",
        "compensation_plan_missing",
        "blast_radius_unknown",
        "idempotency_key_missing",
        "external_commit_without_receipt",
        "partial_failure_without_saga_state",
        "physical_action_without_safety_interlock",
        "scheduled_action_without_cancellation",
        "side_effect_logging_missing",
        "hosted_tool_without_local_side_effect_wrapper",
      ],
    },
    null,
    2,
  );
}

function superOntologySourceLineageVersionSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-source-lineage-version",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "lineage_required_before_graph_memory_public_training_tool_or_route_authority",
      documentFamilies: [
        "policy",
        "contract",
        "sales_deck",
        "spreadsheet",
        "hwp_doc",
        "pdf_export",
        "email_attachment",
        "crm_record",
        "code_artifact",
        "dataset",
        "model_artifact",
        "sensor_log",
        "meeting_notes",
        "public_web_page",
      ],
      sourceArtifactTypes: [
        "primary_document",
        "derived_document",
        "exported_pdf",
        "spreadsheet_workbook",
        "sheet_tab",
        "email_message",
        "attachment",
        "connector_record",
        "database_snapshot",
        "web_snapshot",
        "chunk",
        "embedding_vector",
        "summary",
        "translation",
        "redacted_copy",
        "dataset_snapshot",
        "model_checkpoint",
        "sensor_batch",
      ],
      lineageEvents: [
        "ingest",
        "parse",
        "chunk",
        "summarize",
        "transform",
        "export",
        "attach",
        "duplicate",
        "merge",
        "split",
        "translate",
        "ocr",
        "embed",
        "index",
        "retrieve",
        "update",
        "delete",
        "approve",
      ],
      versionStates: [
        "canonical_current",
        "draft",
        "superseded",
        "expired",
        "conflicting_branch",
        "duplicate_unknown",
        "exported_copy",
        "summary_copy",
        "redacted_copy",
        "partial_extract",
        "unknown_version",
      ],
      derivationStates: [
        "primary_source",
        "direct_derivation",
        "transitive_derivation",
        "quoted_from",
        "revision_of",
        "generated_summary",
        "transformed_format",
        "inferred_link",
        "imported_external",
        "unknown_derivation",
      ],
      authorityStates: [
        "authoritative_source",
        "candidate_source",
        "stale_authority",
        "unapproved_export",
        "conflicting_authority",
        "user_assertion_only",
        "connector_snapshot",
        "unknown_authority",
      ],
      transformationTypes: [
        "none",
        "format_conversion",
        "ocr",
        "translation",
        "summarization",
        "chunking",
        "embedding",
        "schema_mapping",
        "aggregation",
        "redaction",
        "merge_join",
        "dedup",
        "model_inference",
        "manual_edit",
      ],
      identityResolutionStates: [
        "stable_id",
        "checksum_match",
        "content_hash_match",
        "filename_only",
        "fuzzy_title_match",
        "path_only",
        "connector_id",
        "missing_id",
        "conflicting_ids",
        "unknown",
      ],
      freshnessStates: [
        "current",
        "stale",
        "future_effective",
        "expired",
        "snapshot_unknown",
        "source_unavailable",
        "cache_only",
        "retention_limited",
      ],
      requiredLineageEvidence: [
        "source_uri",
        "source_checksum",
        "content_hash",
        "version_id",
        "revision_id",
        "effective_date",
        "capture_time",
        "transformation_log",
        "derivation_chain",
        "parent_artifact_ref",
        "primary_source_ref",
        "authority_owner",
        "approval_record",
        "deprecation_record",
        "supersedes_ref",
        "checksum_or_signature",
        "connector_snapshot_id",
        "parser_version",
        "chunk_span",
        "memory_ticket_ref",
        "audit_trace",
        "rollback_snapshot",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "ask_clarify",
        "lineage_repair_required",
        "source_owner_review_required",
        "deprecate",
        "quarantine",
        "block_graph_write",
        "block_memory_write",
        "block_public_export",
        "rollback",
      ],
      researchBasis: [
        "w3c_prov",
        "openlineage",
        "data_version_control",
        "source_control",
        "supply_chain_traceability",
        "records_management",
        "digital_preservation",
        "reproducible_research",
        "data_contracts",
        "information_retrieval",
        "entity_resolution",
        "auditability",
        "scientific_lineage",
      ],
      hardStops: [
        "missing_source_lineage_version_contract",
        "filename_as_version",
        "latest_folder_as_current_source",
        "pdf_export_as_primary_source",
        "summary_as_primary_source",
        "ocr_text_without_source_span",
        "spreadsheet_sheet_without_workbook_revision",
        "email_attachment_without_message_context",
        "duplicate_title_as_same_artifact",
        "checksum_missing_for_authoritative_source",
        "stale_cache_as_current_record",
        "connector_snapshot_without_capture_time",
        "transitive_derivation_as_primary_source",
        "merged_record_without_parent_refs",
        "redacted_copy_as_complete_source",
        "translation_as_authoritative_source",
        "chunk_without_source_span",
        "embedding_hit_without_artifact_version",
        "memory_fact_without_lineage",
        "public_export_without_lineage_evidence",
        "training_example_without_dataset_version",
        "graph_edge_without_derivation_chain",
        "superseded_source_to_runtime_write",
        "lineage_cycle_unresolved",
      ],
    },
    null,
    2,
  );
}

function superOntologyEntityIdentityResolutionSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-entity-identity-resolution",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "identity_evidence_required_before_canonical_graph_memory_public_training_tool_or_route_authority",
      entityFamilies: [
        "person",
        "company",
        "customer_account",
        "vendor",
        "product",
        "project",
        "policy",
        "contract",
        "dataset",
        "model",
        "location",
        "asset",
        "team",
        "event",
        "legal_matter",
        "patient_or_user",
        "device",
        "document",
      ],
      mentionArtifactTypes: [
        "name_string",
        "alias",
        "email_address",
        "phone_number",
        "domain",
        "crm_id",
        "tax_id",
        "employee_id",
        "connector_record",
        "spreadsheet_row",
        "file_path",
        "extracted_mention",
        "knowledge_node",
        "external_uri",
        "embedding_cluster",
        "llm_generated_canonical",
        "redacted_identifier",
        "merged_record",
      ],
      identityEvents: [
        "extract",
        "link",
        "dedup",
        "merge",
        "split",
        "alias",
        "rename",
        "transfer",
        "deactivate",
        "reassign",
        "reconcile",
        "canonicalize",
        "disambiguate",
        "import",
        "export",
        "retrieve",
        "memory_write",
        "graph_write",
      ],
      resolutionStates: [
        "unresolved",
        "stable_canonical_id",
        "source_system_id",
        "candidate_match",
        "fuzzy_match",
        "alias_match",
        "conflicting_ids",
        "many_to_one_collision",
        "one_to_many_split",
        "synthetic_llm_id",
        "redacted_or_pseudonymous",
        "recycled_id",
        "deprecated_entity",
        "human_confirmed",
      ],
      matchSignalStates: [
        "exact_id",
        "exact_key",
        "high_similarity",
        "weak_similarity",
        "name_only",
        "structural_context",
        "temporal_context",
        "relational_context",
        "negative_evidence",
        "conflicting_evidence",
        "missing_evidence",
        "privacy_limited",
      ],
      conflictStates: [
        "none",
        "duplicate_claim",
        "homonym",
        "synonym",
        "alias_collision",
        "merge_conflict",
        "split_conflict",
        "stale_alias",
        "jurisdiction_conflict",
        "tenant_boundary_conflict",
        "privacy_boundary_conflict",
        "role_change_conflict",
      ],
      temporalStates: [
        "current",
        "stale",
        "unknown_time",
        "renamed",
        "superseded",
        "merged",
        "split",
        "transferred",
        "deleted",
        "recycled",
        "future_effective",
      ],
      privacyStates: [
        "public",
        "internal",
        "confidential",
        "pii",
        "regulated",
        "redacted",
        "pseudonymous",
        "cross_tenant",
        "consent_limited",
      ],
      authorityStates: [
        "candidate_entity",
        "canonical_entity",
        "source_system_authority",
        "owner_confirmed",
        "conflicting_authority",
        "inferred_authority",
        "stale_authority",
        "unknown_authority",
      ],
      requiredIdentityEvidence: [
        "canonical_entity_id",
        "source_system_id",
        "entity_type",
        "source_uri",
        "source_span",
        "source_checksum",
        "alias_registry",
        "negative_evidence",
        "disambiguating_attributes",
        "relational_neighborhood",
        "temporal_validity",
        "tenant_or_context_id",
        "owner_review",
        "human_confirmation",
        "merge_policy",
        "split_policy",
        "tombstone_record",
        "supersedes_ref",
        "privacy_basis",
        "consent_record",
        "audit_trace",
        "rollback_snapshot",
        "confidence_score",
        "comparison_pairs",
        "blocking_key",
        "external_uri",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "ask_clarify",
        "identity_repair_required",
        "owner_review_required",
        "quarantine",
        "block_merge",
        "block_graph_write",
        "block_memory_write",
        "block_public_export",
        "split_entity",
        "deprecate_alias",
        "rollback",
      ],
      researchBasis: [
        "entity_resolution",
        "record_linkage",
        "knowledge_graph_alignment",
        "owl_sameas",
        "w3c_prov",
        "llm_entity_matching",
        "active_learning",
        "privacy_engineering",
        "data_contracts",
        "master_data_management",
        "auditability",
        "temporal_knowledge_graph",
        "named_entity_linking",
      ],
      hardStops: [
        "missing_entity_identity_resolution_contract",
        "name_as_identity",
        "email_domain_as_company",
        "same_title_as_same_project",
        "fuzzy_match_as_merge",
        "embedding_cluster_as_identity",
        "llm_canonical_name_as_id",
        "crm_id_cross_tenant_merge",
        "recycled_employee_id_as_same_person",
        "redacted_name_as_public_identity",
        "stale_alias_as_current_entity",
        "merged_account_without_split_policy",
        "split_entity_without_tombstone",
        "external_uri_without_context",
        "tax_id_without_scope",
        "phone_number_as_person_identity",
        "partial_address_as_location",
        "product_sku_reuse_as_same_product",
        "project_codename_as_unique_id",
        "same_pdf_author_as_employee",
        "relationship_edge_without_identity_evidence",
        "memory_note_as_identity_authority",
      ],
    },
    null,
    2,
  );
}

function superOntologyTemporalStateTransitionSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-temporal-state-transition",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "temporal_state_evidence_required_before_graph_memory_public_training_tool_route_scheduled_permission_financial_release_or_customer_authority",
      stateSubjectFamilies: [
        "person",
        "company",
        "customer_account",
        "vendor",
        "product",
        "project",
        "policy",
        "contract",
        "dataset",
        "model",
        "document",
        "workflow",
        "task",
        "asset",
        "device",
        "payment",
        "permission",
        "release",
        "memory_fact",
        "graph_edge",
      ],
      eventArtifactTypes: [
        "timestamp",
        "valid_interval",
        "transaction_record",
        "event_log_entry",
        "state_snapshot",
        "spreadsheet_row",
        "document_revision",
        "calendar_event",
        "webhook_event",
        "connector_delta",
        "message_thread",
        "scheduled_job",
        "audit_log",
        "migration_batch",
        "derived_projection",
        "llm_summary",
        "memory_note",
        "graph_edge",
      ],
      temporalEvents: [
        "create",
        "update",
        "delete",
        "correct",
        "backfill",
        "import",
        "export",
        "schedule",
        "expire",
        "renew",
        "supersede",
        "merge",
        "split",
        "replay",
        "rollback",
        "project",
        "materialize",
        "graph_write",
        "memory_write",
        "route_update",
        "tool_action",
      ],
      lifecycleStates: [
        "planned",
        "active",
        "expired",
        "superseded",
        "deleted",
        "archived",
        "merged",
        "split",
        "pending",
        "effective_future",
        "suspended",
        "failed",
        "rolled_back",
        "unknown",
      ],
      validTimeStates: [
        "valid_known",
        "valid_missing",
        "valid_interval_open",
        "valid_conflict",
        "retroactive",
        "future_effective",
        "stale",
        "out_of_order",
        "late_arriving",
        "clock_skewed",
        "timezone_ambiguous",
        "recurring",
        "unknown",
      ],
      transactionTimeStates: [
        "tx_known",
        "tx_missing",
        "tx_conflict",
        "ingestion_delayed",
        "backfilled",
        "replayed",
        "reprocessed",
        "corrected_after_read",
        "compaction_lost",
        "unknown",
      ],
      eventOrderStates: [
        "ordered",
        "unordered",
        "partially_ordered",
        "duplicate_event",
        "missing_event",
        "late_event",
        "causal_cycle",
        "concurrent_conflict",
        "idempotency_unknown",
        "sequence_gap",
        "clock_conflict",
      ],
      stateTransitionStates: [
        "valid_transition",
        "invalid_transition",
        "missing_precondition",
        "missing_postcondition",
        "skipped_state",
        "forbidden_transition",
        "non_idempotent_retry",
        "partial_failure",
        "projection_drift",
        "stale_snapshot",
        "impossible_state",
        "unknown",
      ],
      projectionStates: [
        "source_of_truth",
        "candidate_projection",
        "materialized_view",
        "stale_projection",
        "denormalized_summary",
        "llm_summary",
        "spreadsheet_export",
        "public_artifact",
        "memory_projection",
        "graph_projection",
        "training_projection",
      ],
      authorityStates: [
        "candidate_state",
        "source_system_authority",
        "owner_confirmed",
        "derived_projection_authority",
        "stale_authority",
        "conflicting_authority",
        "inferred_authority",
        "unknown_authority",
      ],
      requiredTemporalEvidence: [
        "valid_time",
        "transaction_time",
        "event_id",
        "event_sequence",
        "source_uri",
        "source_span",
        "source_checksum",
        "actor_or_system",
        "pre_state",
        "post_state",
        "state_machine_rule",
        "transition_guard",
        "causality_ref",
        "idempotency_key",
        "dedupe_key",
        "timezone",
        "clock_source",
        "retention_policy",
        "correction_policy",
        "replay_log",
        "rollback_snapshot",
        "projection_version",
        "materialization_query",
        "owner_review",
        "audit_trace",
        "tombstone_record",
        "supersedes_ref",
        "expiry_or_ttl",
        "scheduler_receipt",
        "post_action_verification",
      ],
      decisions: [
        "allow_read",
        "candidate_only",
        "ask_clarify",
        "temporal_repair_required",
        "owner_review_required",
        "quarantine",
        "block_projection",
        "block_graph_write",
        "block_memory_write",
        "block_public_export",
        "block_tool_action",
        "rollback",
        "expire_state",
        "tombstone_state",
        "replay_required",
      ],
      researchBasis: [
        "temporal_knowledge_graph",
        "bitemporal_modeling",
        "event_sourcing",
        "process_mining",
        "state_machines",
        "distributed_systems",
        "data_contracts",
        "auditability",
        "workflow_modeling",
        "temporal_logic",
      ],
      hardStops: [
        "missing_temporal_state_transition_contract",
        "current_snapshot_as_truth",
        "missing_valid_time",
        "missing_transaction_time",
        "local_timestamp_as_global_order",
        "spreadsheet_order_as_event_order",
        "llm_summary_as_event_log",
        "late_event_ignored",
        "retroactive_correction_without_tx_history",
        "future_effective_as_current",
        "expired_state_as_active",
        "deleted_state_without_tombstone",
        "non_idempotent_replay",
        "materialized_view_as_source_of_truth",
        "projection_without_version",
        "recurring_event_without_rule",
        "timezone_free_deadline",
        "stale_cache_as_current",
        "state_transition_without_precondition",
        "partial_failure_as_success",
        "clock_skew_as_fact",
        "scheduled_job_without_receipt",
        "memory_fact_without_validity_interval",
        "graph_edge_without_temporal_bounds",
      ],
    },
    null,
    2,
  );
}

function superOntologyCapabilityDelegationAuthoritySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-capability-delegation-authority",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "capability_evidence_required_before_graph_memory_public_training_tool_route_scheduled_permission_financial_release_customer_or_physical_authority",
      principalTypes: [
        "human_user",
        "delegated_agent",
        "child_agent",
        "service_account",
        "oauth_client",
        "api_key_holder",
        "mcp_tool",
        "scheduler",
        "workflow_runner",
        "enterprise_connector",
        "browser_session",
        "unknown_principal",
      ],
      capabilityArtifactTypes: [
        "role",
        "group_membership",
        "oauth_scope",
        "api_key",
        "service_account_key",
        "session_cookie",
        "tool_schema",
        "policy_decision",
        "approval_record",
        "delegation_token",
        "agent_identity_token",
        "signed_attestation",
        "capability_token",
        "cached_authorization_decision",
      ],
      authoritySurfaces: [
        "graph_authority",
        "memory_authority",
        "public_export_authority",
        "training_authority",
        "tool_authority",
        "route_authority",
        "scheduled_authority",
        "permission_authority",
        "financial_authority",
        "release_authority",
        "customer_output_authority",
        "physical_authority",
      ],
      requiredCapabilityEvidence: [
        "actor_identity",
        "agent_identity",
        "user_intent",
        "task_id",
        "workflow_step",
        "delegation_chain",
        "parent_capability",
        "policy_decision",
        "policy_version",
        "resource_id",
        "operation",
        "scope",
        "purpose",
        "caveat_set",
        "consent_record",
        "owner_approval",
        "time_bound",
        "recipient_bound",
        "environment_context",
        "proof_of_possession",
        "revocation_check",
        "audit_trace",
        "rollback_snapshot",
        "post_action_verification",
      ],
      hardStops: [
        "role_as_capability",
        "oauth_scope_as_task_permission",
        "api_key_as_actor",
        "read_access_as_write_authority",
        "parent_agent_unbounded_delegation",
        "delegation_chain_missing",
        "purpose_mismatch_authority",
        "capability_without_caveats",
        "stale_capability_token_as_current",
        "cross_context_capability_reuse",
        "capability_escalation_by_tool_choice",
        "subagent_exceeds_parent_authority",
        "human_consent_reused_for_new_purpose",
        "permission_prompt_as_policy",
        "tool_schema_as_authorization",
        "cached_auth_decision_without_fresh_context",
        "break_glass_without_expiry",
        "admin_role_as_all_actions",
        "shared_service_account_as_identity",
        "task_goal_as_permission",
        "hidden_tool_call_without_policy_decision",
      ],
      researchBasis: [
        "least_privilege",
        "zero_trust",
        "abac",
        "rebac",
        "capability_security",
        "macaroons",
        "zanzibar",
        "oauth_oidc",
        "oidc_agents",
        "agentic_jwt",
        "privilege_control",
        "contextual_integrity",
        "policy_as_code",
        "proof_of_possession",
        "auditability",
        "delegation_logic",
        "threat_modeling",
      ],
    },
    null,
    2,
  );
}

function superOntologyPrivacyConfidentialityBoundarySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-privacy-confidentiality-boundary",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "privacy_boundary_evidence_required_before_graph_memory_public_training_tool_route_customer_output_personalization_retrieval_or_analytics_authority",
      dataClassifications: [
        "public",
        "internal",
        "confidential",
        "restricted",
        "regulated_pii",
        "sensitive_pii",
        "credentials_or_secret",
        "financial",
        "health",
        "legal_privileged",
        "biometric",
        "location",
        "behavioral_profile",
        "inferred_sensitive",
        "unknown",
      ],
      boundarySurfaces: [
        "graph_authority",
        "memory_authority",
        "public_export_authority",
        "training_authority",
        "tool_authority",
        "route_authority",
        "customer_output_authority",
        "personalization_authority",
        "retrieval_authority",
        "analytics_authority",
      ],
      requiredPrivacyEvidence: [
        "data_classification",
        "sensitivity_label",
        "source_span",
        "data_subject_category",
        "controller_or_owner",
        "processing_purpose",
        "legal_basis_or_owner_approval",
        "consent_or_confidentiality_basis",
        "audience",
        "minimization_reason",
        "redaction_policy",
        "retention_policy",
        "deletion_or_legal_hold_state",
        "transfer_basis",
        "model_trust_tier",
        "training_allowed_flag",
        "public_disclosure_allowed_flag",
        "access_policy_decision",
        "audit_trace",
        "rollback_snapshot",
        "breach_response_owner",
        "reidentification_risk_assessment",
        "vector_index_policy",
        "memory_write_scope",
      ],
      hardStops: [
        "pii_as_normal_fact",
        "secret_as_graph_label",
        "confidential_deck_as_public_context",
        "consent_missing",
        "legal_basis_missing",
        "purpose_reuse_without_review",
        "training_on_private_material",
        "public_export_without_redaction",
        "retention_expired_memory",
        "data_subject_delete_ignored",
        "cross_tenant_context_bleed",
        "customer_data_as_demo",
        "personal_life_as_company_context",
        "employee_note_as_hr_decision",
        "inferred_sensitive_attribute_public",
        "redacted_text_reidentified",
        "connector_cache_as_allowed_use",
        "screenshot_ocr_without_classification",
        "embedding_of_secret_without_policy",
        "vector_search_leaks_private_neighbors",
        "shared_memory_without_audience_boundary",
        "confidential_source_in_prompt_to_untrusted_model",
        "trade_secret_as_embedding_neighbor",
        "legal_privilege_lost_by_disclosure",
      ],
      researchBasis: [
        "nist_privacy_framework",
        "nist_pii_confidentiality",
        "oecd_privacy_principles",
        "gdpr_principles",
        "contextual_integrity",
        "data_minimization",
        "purpose_limitation",
        "privacy_by_design",
        "information_flow_control",
        "privacy_risk_management",
        "reidentification_risk",
        "secrets_management",
        "records_retention",
        "zero_trust",
        "auditability",
      ],
    },
    null,
    2,
  );
}


function superOntologyStrategicIncentiveCompatibilitySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-strategic-incentive-compatibility",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "incentive_evidence_required_before_graph_memory_public_training_tool_route_release_financial_hiring_policy_customer_output_analytics_evaluation_or_personalization_authority",
      incentiveSignalTypes: [
        "kpi_bonus",
        "commission",
        "promotion",
        "cost_savings",
        "approval_rate",
        "benchmark_score",
        "customer_rating",
        "retention_metric",
        "compliance_attestation",
        "vote_power",
        "access_grant",
        "data_payment",
        "social_status",
        "family_pressure",
        "none_declared",
      ],
      authoritySurfaces: [
        "graph_authority",
        "memory_authority",
        "public_export_authority",
        "training_authority",
        "tool_authority",
        "route_authority",
        "release_authority",
        "financial_authority",
        "hiring_authority",
        "policy_authority",
        "customer_output_authority",
        "analytics_authority",
        "evaluation_authority",
        "personalization_authority",
      ],
      requiredIncentiveEvidence: [
        "principal_id",
        "agent_id",
        "role_or_delegation",
        "private_information_inventory",
        "objective_function",
        "payoff_or_reward_model",
        "conflict_of_interest_disclosure",
        "strategic_behavior_hypothesis",
        "counterfactual_truthfulness_check",
        "holdout_or_audit_sample",
        "independent_verification",
        "collusion_check",
        "peer_pressure_check",
        "mechanism_constraint",
        "counter_incentive",
        "review_owner",
        "appeal_or_challenge_path",
        "audit_trace",
        "rollback_snapshot",
        "post_decision_monitoring",
        "data_quality_contribution",
        "budget_or_transfer_rule",
        "incentive_compatibility_argument",
        "residual_incentive_risk",
      ],
      hardStops: [
        "self_report_as_truth",
        "kpi_as_objective",
        "commission_report_as_fact",
        "manager_approval_as_no_conflict",
        "vendor_claim_as_source_quality",
        "customer_rating_as_value",
        "agent_vote_as_independent_signal",
        "benchmark_score_as_general_capability",
        "cheap_provider_as_best_provider",
        "data_provider_label_as_quality",
        "compliance_attestation_as_compliance",
        "peer_pressure_as_consensus",
        "hidden_affiliation_as_neutral_review",
        "survey_response_as_stable_preference",
        "retention_metric_as_satisfaction",
        "access_request_as_need_to_know",
        "family_pressure_as_user_preference",
        "approval_chain_as_truthfulness",
        "cost_saving_as_system_health",
        "strategic_silence_as_no_risk",
        "collusive_agents_as_quorum",
        "mechanism_missing_to_runtime_write",
        "incentive_conflict_to_memory_write",
        "reward_model_as_human_goal",
      ],
      researchBasis: [
        "mechanism_design",
        "incentive_compatibility",
        "principal_agent_theory",
        "information_asymmetry",
        "moral_hazard",
        "adverse_selection",
        "strategic_classification",
        "goodhart_law",
        "campbell_law",
        "game_theory",
        "multi_agent_systems",
        "nist_ai_rmf",
        "nist_genai_profile",
        "oecd_ai_principles",
        "auditability",
        "human_factors",
      ],
    },
    null,
    2,
  );
}

function superOntologyReflexiveFeedbackStabilitySkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-reflexive-feedback-stability",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision:
        "feedback_stability_evidence_required_before_graph_memory_public_training_tool_route_release_financial_hiring_policy_customer_output_analytics_evaluation_physical_or_personalization_authority",
      interventionTypes: [
        "recommendation",
        "ranking",
        "notification",
        "automation",
        "memory_write",
        "retrieval_biasing",
        "dashboard_metric",
        "pricing_or_budget_change",
        "training_update",
        "route_update",
        "access_policy_change",
        "social_prompt",
        "customer_message",
        "physical_action",
        "none_declared",
      ],
      loopSignalTypes: [
        "post_intervention_observation",
        "behavior_change",
        "data_distribution_shift",
        "self_generated_content",
        "model_output_reuse",
        "metric_response",
        "user_adaptation",
        "agent_self_evaluation",
        "market_response",
        "social_contagion",
        "scheduler_replay",
      ],
      authoritySurfaces: [
        "graph_authority",
        "memory_authority",
        "public_export_authority",
        "training_authority",
        "tool_authority",
        "route_authority",
        "release_authority",
        "financial_authority",
        "hiring_authority",
        "policy_authority",
        "customer_output_authority",
        "analytics_authority",
        "evaluation_authority",
        "personalization_authority",
        "physical_authority",
      ],
      requiredFeedbackEvidence: [
        "intervention_id",
        "pre_intervention_baseline",
        "feedback_path_map",
        "time_lag_window",
        "post_intervention_observation",
        "counterfactual_or_holdout",
        "real_world_data_anchor",
        "synthetic_data_ratio",
        "stability_margin_or_error_budget",
        "damping_or_rate_limit",
        "saturation_bound",
        "externality_map",
        "affected_stakeholders",
        "monitoring_trace",
        "rollback_snapshot",
        "stop_condition",
        "owner_review",
        "residual_feedback_risk",
      ],
      hardStops: [
        "observation_after_intervention_as_neutral_truth",
        "recommendation_effect_as_preference",
        "self_generated_content_as_training_data",
        "model_output_as_source_corpus",
        "dashboard_change_as_system_improvement",
        "metric_response_as_real_world_gain",
        "repeated_retrieval_as_relevance",
        "agent_self_score_as_external_feedback",
        "closed_loop_without_counterfactual",
        "runaway_feedback_to_runtime_write",
        "oscillation_as_adaptation",
        "delayed_harm_ignored",
        "synthetic_data_loop_as_real_distribution",
        "intervention_without_stop_condition",
        "user_adaptation_as_stable_preference",
        "market_response_as_causal_truth",
        "personal_nudge_as_identity_change",
        "training_on_ai_outputs_without_real_anchor",
        "feedback_loop_to_memory_write",
        "feedback_loop_to_policy_write",
        "externality_free_assumption",
      ],
      researchBasis: [
        "performative_prediction",
        "control_theory",
        "cybernetics",
        "systems_dynamics",
        "model_collapse",
        "distribution_shift",
        "causal_inference",
        "reinforcement_learning_feedback",
        "human_factors",
        "fairness_feedback_loops",
        "nist_ai_rmf",
        "safety_engineering",
        "ecological_feedback",
        "social_contagion",
      ],
    },
    null,
    2,
  );
}

function superOntologyOpenWorldCoverageSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-open-world-coverage",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "lower_authority_before_unknown_combination_write",
      worldFamilies: [
        "personal_life",
        "company_operations",
        "public_research",
        "scientific_observation",
        "social_institutional",
        "creative_media",
        "regulated_health",
        "legal_compliance",
        "industrial_physical",
        "environmental_geospatial",
        "software_enterprise",
        "education",
        "finance_compliance",
        "multimodal_brand",
        "unknown_mixed",
      ],
      modalities: [
        "text",
        "table",
        "slide",
        "pdf",
        "hwp",
        "image",
        "video",
        "audio",
        "sensor",
        "code",
        "database",
        "email",
        "calendar",
        "web",
        "geospatial",
      ],
      faultModels: [
        "none",
        "explicit_error",
        "implicit_degradation",
        "mixed_fault",
        "missing_field",
        "stale_source",
        "adversarial_source",
        "permission_gap",
        "semantic_ambiguity",
        "causal_gap",
      ],
      authorityStates: [
        "public_allowed",
        "owner_authority_present",
        "authority_unknown",
        "regulated_requires_review",
        "forbidden",
      ],
      coverageGaps: [
        "covered",
        "new_combination",
        "underrepresented_world",
        "missing_fault_fixture",
        "missing_modality_fixture",
        "missing_authority_fixture",
      ],
      requiredGates: [
        "task_coverage",
        "contextual_flow",
        "epistemic_calibration",
        "semantic_alignment",
        "adversarial_provenance",
        "causal_impact",
        "knowledge_homeostasis",
        "resilience_control",
        "invariant_verification",
        "memory_curator_bridge",
        "assurance_case",
        "shadow_canary_replay",
        "owner_review",
      ],
      samplingActions: [
        "allow_as_research_fixture",
        "add_fixture",
        "ask_clarify",
        "shadow_replay",
        "quarantine",
        "block",
        "require_owner_review",
      ],
      promotionDecisions: [
        "candidate_only",
        "shadow_required",
        "sync_review_required",
        "blocked",
      ],
      researchBasis: [
        "open_world_evaluation",
        "professional_agent_benchmarks",
        "real_computer_environment_benchmarks",
        "ontology_oriented_kg_construction",
        "enterprise_ontology_scope_limits",
        "no_free_lunch",
        "zero_trust_architecture",
      ],
      hardStops: [
        "missing_open_world_coverage_contract",
        "proposal_example_equals_all_tasks",
        "unknown_combination_to_runtime_write",
        "untested_modality_to_memory_write",
        "implicit_degradation_as_complete_data",
        "adversarial_source_as_authority",
        "forbidden_authority_to_action",
        "open_world_case_without_shadow_replay",
        "open_world_case_without_owner_or_sync_review",
      ],
    },
    null,
    2,
  );
}

function superOntologyConsensusCoordinationSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-consensus-coordination",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      defaultDecision: "treat_agent_agreement_as_candidate_signal_not_write_authority",
      coordinationTopologies: [
        "independent_parallel",
        "star_orchestrator",
        "round_robin",
        "majority_vote",
        "weighted_vote",
        "debate",
        "owner_review_board",
        "distributed_replicas",
        "cross_runtime_sync",
      ],
      failureModes: [
        "majority_corruption",
        "peer_pressure",
        "sycophancy",
        "split_brain",
        "stale_replica",
        "double_write",
        "authority_escalation",
        "validator_disagreement",
        "collusion",
        "unreliable_judge",
        "network_partition",
        "race_condition",
      ],
      requiredGates: [
        "adversarial_provenance",
        "epistemic_calibration",
        "semantic_alignment",
        "knowledge_homeostasis",
        "resilience_control",
        "invariant_verification",
        "memory_curator_bridge",
        "assurance_case",
        "shadow_canary_replay",
        "owner_review",
        "sync_gate",
      ],
      consensusPolicies: [
        "independent_verification",
        "stability_detection",
        "evidence_weighted",
        "unanimity_for_high_risk",
        "owner_tiebreak",
        "quorum_plus_veto",
        "read_only_shadow",
        "two_phase_commit",
        "crdt_merge_with_review",
        "block",
      ],
      conflictResolutions: [
        "ask_clarify",
        "quarantine",
        "shadow_replay",
        "owner_review",
        "sync_review",
        "rollback",
        "emergency_stop",
        "merge_as_contested",
        "reject",
        "read_only_mode",
      ],
      researchBasis: [
        "multi_agent_consensus_risk",
        "peer_pressure_research",
        "distributed_systems_consensus",
        "ontology_conflict_resolution",
        "assurance_case",
        "zero_trust_architecture",
      ],
      hardStops: [
        "missing_consensus_coordination_contract",
        "agent_agreement_as_truth",
        "majority_vote_as_write_authority",
        "debate_stability_as_proof",
        "model_judge_as_final_evidence",
        "distributed_replica_merge_without_review",
        "route_sync_without_quorum",
        "last_writer_wins_architecture_update",
        "peer_pressure_to_memory_write",
        "validator_disagreement_to_release",
      ],
    },
    null,
    2,
  );
}

function superOntologyTaskCoverageSkeleton(projectName: string): string {
  return JSON.stringify(
    {
      schemaVersion: "1.0",
      kind: "agentlas-super-ontology-task-coverage",
      state: "local_candidate",
      projectId: projectName,
      draftId: null,
      runtimePromotionAllowed: false,
      taskFamilies: [
        "retrieve_answer",
        "summarize_synthesize",
        "draft_artifact",
        "transform_format",
        "analyze_decide",
        "plan_sequence",
        "coordinate_social",
        "execute_tool",
        "monitor_repair",
        "personalize_memory",
        "regulated_boundary",
        "multimodal_generate",
        "physical_or_sensor",
        "software_change",
        "financial_or_compliance",
        "education_or_coaching",
      ],
      affordanceTypes: [
        "read",
        "draft",
        "write",
        "publish",
        "execute",
        "physical",
        "train",
      ],
      evidenceModes: [
        "citation",
        "current_approved_source",
        "owner_authority",
        "policy_or_law",
        "measurement_or_dataset",
        "license_or_consent",
        "runtime_test",
        "rollback_plan",
      ],
      defaultDecision: "classify_before_action",
      hardStops: [
        "missing_task_family",
        "missing_affordance_type",
        "missing_evidence_mode",
        "write_without_rollback",
        "publish_execute_physical_or_train_without_authority",
      ],
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
    SUPER_ONTOLOGY_CONTRACT_FILE,
    SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE,
    SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE,
    SUPER_ONTOLOGY_ASSURANCE_CASE_FILE,
    SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE,
    SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE,
    SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE,
    SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE,
    SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE,
    SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE,
    SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE,
    SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE,
    SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE,
    SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE,
    SUPER_ONTOLOGY_STAKEHOLDER_PREFERENCE_GOVERNANCE_FILE,
    SUPER_ONTOLOGY_NORMATIVE_AUTHORITY_DRIFT_FILE,
    SUPER_ONTOLOGY_SIDE_EFFECT_CONTAINMENT_FILE,
    SUPER_ONTOLOGY_SOURCE_LINEAGE_VERSION_FILE,
    SUPER_ONTOLOGY_ENTITY_IDENTITY_RESOLUTION_FILE,
    SUPER_ONTOLOGY_TEMPORAL_STATE_TRANSITION_FILE,
    SUPER_ONTOLOGY_CAPABILITY_DELEGATION_AUTHORITY_FILE,
    SUPER_ONTOLOGY_PRIVACY_CONFIDENTIALITY_BOUNDARY_FILE,
    SUPER_ONTOLOGY_STRATEGIC_INCENTIVE_COMPATIBILITY_FILE,
    SUPER_ONTOLOGY_REFLEXIVE_FEEDBACK_STABILITY_FILE,
    SUPER_ONTOLOGY_REPLAYS_FILE,
    SUPER_ONTOLOGY_EVIDENCE_FILE,
    SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE,
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

    const secureWriteMissing = (filePath: string, content: string, _encoding?: string): void => {
      createPrivateProjectFileIfMissing(
        identity,
        filePath,
        content,
        `The project memory file ${path.basename(filePath)}`,
      );
    };

    const superOntologyContract = path.join(dir, SUPER_ONTOLOGY_CONTRACT_FILE);
    if (!fs.existsSync(superOntologyContract)) {
      secureWriteMissing(superOntologyContract, superOntologyContractSkeleton(name), "utf8");
    }

    const superOntologyOpenWorldCoverage = path.join(dir, SUPER_ONTOLOGY_OPEN_WORLD_COVERAGE_FILE);
    if (!fs.existsSync(superOntologyOpenWorldCoverage)) {
      secureWriteMissing(
        superOntologyOpenWorldCoverage,
        superOntologyOpenWorldCoverageSkeleton(name),
        "utf8",
      );
    }

    const superOntologyConsensusCoordination = path.join(dir, SUPER_ONTOLOGY_CONSENSUS_COORDINATION_FILE);
    if (!fs.existsSync(superOntologyConsensusCoordination)) {
      secureWriteMissing(
        superOntologyConsensusCoordination,
        superOntologyConsensusCoordinationSkeleton(name),
        "utf8",
      );
    }

    const superOntologyTaskCoverage = path.join(dir, SUPER_ONTOLOGY_TASK_COVERAGE_FILE);
    if (!fs.existsSync(superOntologyTaskCoverage)) {
      secureWriteMissing(superOntologyTaskCoverage, superOntologyTaskCoverageSkeleton(name), "utf8");
    }

    const superOntologyContextualFlow = path.join(dir, SUPER_ONTOLOGY_CONTEXTUAL_FLOW_FILE);
    if (!fs.existsSync(superOntologyContextualFlow)) {
      secureWriteMissing(superOntologyContextualFlow, superOntologyContextualFlowSkeleton(name), "utf8");
    }

    const superOntologyCausalImpact = path.join(dir, SUPER_ONTOLOGY_CAUSAL_IMPACT_FILE);
    if (!fs.existsSync(superOntologyCausalImpact)) {
      secureWriteMissing(superOntologyCausalImpact, superOntologyCausalImpactSkeleton(name), "utf8");
    }

    const superOntologyAssuranceCase = path.join(dir, SUPER_ONTOLOGY_ASSURANCE_CASE_FILE);
    if (!fs.existsSync(superOntologyAssuranceCase)) {
      secureWriteMissing(superOntologyAssuranceCase, superOntologyAssuranceCaseSkeleton(name), "utf8");
    }

    const superOntologyKnowledgeHomeostasis = path.join(dir, SUPER_ONTOLOGY_KNOWLEDGE_HOMEOSTASIS_FILE);
    if (!fs.existsSync(superOntologyKnowledgeHomeostasis)) {
      secureWriteMissing(superOntologyKnowledgeHomeostasis, superOntologyKnowledgeHomeostasisSkeleton(name), "utf8");
    }

    const superOntologyAdversarialProvenance = path.join(dir, SUPER_ONTOLOGY_ADVERSARIAL_PROVENANCE_FILE);
    if (!fs.existsSync(superOntologyAdversarialProvenance)) {
      secureWriteMissing(
        superOntologyAdversarialProvenance,
        superOntologyAdversarialProvenanceSkeleton(name),
        "utf8",
      );
    }

    const superOntologyEpistemicCalibration = path.join(dir, SUPER_ONTOLOGY_EPISTEMIC_CALIBRATION_FILE);
    if (!fs.existsSync(superOntologyEpistemicCalibration)) {
      secureWriteMissing(
        superOntologyEpistemicCalibration,
        superOntologyEpistemicCalibrationSkeleton(name),
        "utf8",
      );
    }

    const superOntologySemanticAlignment = path.join(dir, SUPER_ONTOLOGY_SEMANTIC_ALIGNMENT_FILE);
    if (!fs.existsSync(superOntologySemanticAlignment)) {
      secureWriteMissing(
        superOntologySemanticAlignment,
        superOntologySemanticAlignmentSkeleton(name),
        "utf8",
      );
    }

    const superOntologyResilienceControl = path.join(dir, SUPER_ONTOLOGY_RESILIENCE_CONTROL_FILE);
    if (!fs.existsSync(superOntologyResilienceControl)) {
      secureWriteMissing(
        superOntologyResilienceControl,
        superOntologyResilienceControlSkeleton(name),
        "utf8",
      );
    }

    const superOntologyInvariantVerification = path.join(dir, SUPER_ONTOLOGY_INVARIANT_VERIFICATION_FILE);
    if (!fs.existsSync(superOntologyInvariantVerification)) {
      secureWriteMissing(
        superOntologyInvariantVerification,
        superOntologyInvariantVerificationSkeleton(name),
        "utf8",
      );
    }

    const superOntologyObservabilityTelemetry = path.join(dir, SUPER_ONTOLOGY_OBSERVABILITY_TELEMETRY_FILE);
    if (!fs.existsSync(superOntologyObservabilityTelemetry)) {
      secureWriteMissing(
        superOntologyObservabilityTelemetry,
        superOntologyObservabilityTelemetrySkeleton(name),
        "utf8",
      );
    }

    const superOntologyObjectiveProxyValidity = path.join(dir, SUPER_ONTOLOGY_OBJECTIVE_PROXY_VALIDITY_FILE);
    if (!fs.existsSync(superOntologyObjectiveProxyValidity)) {
      secureWriteMissing(
        superOntologyObjectiveProxyValidity,
        superOntologyObjectiveProxyValiditySkeleton(name),
        "utf8",
      );
    }

    const superOntologyStakeholderPreferenceGovernance = path.join(
      dir,
      SUPER_ONTOLOGY_STAKEHOLDER_PREFERENCE_GOVERNANCE_FILE,
    );
    if (!fs.existsSync(superOntologyStakeholderPreferenceGovernance)) {
      secureWriteMissing(
        superOntologyStakeholderPreferenceGovernance,
        superOntologyStakeholderPreferenceGovernanceSkeleton(name),
        "utf8",
      );
    }

    const superOntologyNormativeAuthorityDrift = path.join(
      dir,
      SUPER_ONTOLOGY_NORMATIVE_AUTHORITY_DRIFT_FILE,
    );
    if (!fs.existsSync(superOntologyNormativeAuthorityDrift)) {
      secureWriteMissing(
        superOntologyNormativeAuthorityDrift,
        superOntologyNormativeAuthorityDriftSkeleton(name),
        "utf8",
      );
    }

    const superOntologySideEffectContainment = path.join(
      dir,
      SUPER_ONTOLOGY_SIDE_EFFECT_CONTAINMENT_FILE,
    );
    if (!fs.existsSync(superOntologySideEffectContainment)) {
      secureWriteMissing(
        superOntologySideEffectContainment,
        superOntologySideEffectContainmentSkeleton(name),
        "utf8",
      );
    }

    const superOntologySourceLineageVersion = path.join(
      dir,
      SUPER_ONTOLOGY_SOURCE_LINEAGE_VERSION_FILE,
    );
    if (!fs.existsSync(superOntologySourceLineageVersion)) {
      secureWriteMissing(
        superOntologySourceLineageVersion,
        superOntologySourceLineageVersionSkeleton(name),
        "utf8",
      );
    }

    const superOntologyEntityIdentityResolution = path.join(
      dir,
      SUPER_ONTOLOGY_ENTITY_IDENTITY_RESOLUTION_FILE,
    );
    if (!fs.existsSync(superOntologyEntityIdentityResolution)) {
      secureWriteMissing(
        superOntologyEntityIdentityResolution,
        superOntologyEntityIdentityResolutionSkeleton(name),
        "utf8",
      );
    }

    const superOntologyTemporalStateTransition = path.join(
      dir,
      SUPER_ONTOLOGY_TEMPORAL_STATE_TRANSITION_FILE,
    );
    if (!fs.existsSync(superOntologyTemporalStateTransition)) {
      secureWriteMissing(
        superOntologyTemporalStateTransition,
        superOntologyTemporalStateTransitionSkeleton(name),
        "utf8",
      );
    }

    const superOntologyCapabilityDelegationAuthority = path.join(
      dir,
      SUPER_ONTOLOGY_CAPABILITY_DELEGATION_AUTHORITY_FILE,
    );
    if (!fs.existsSync(superOntologyCapabilityDelegationAuthority)) {
      secureWriteMissing(
        superOntologyCapabilityDelegationAuthority,
        superOntologyCapabilityDelegationAuthoritySkeleton(name),
        "utf8",
      );
    }

    const superOntologyPrivacyConfidentialityBoundary = path.join(
      dir,
      SUPER_ONTOLOGY_PRIVACY_CONFIDENTIALITY_BOUNDARY_FILE,
    );
    if (!fs.existsSync(superOntologyPrivacyConfidentialityBoundary)) {
      secureWriteMissing(
        superOntologyPrivacyConfidentialityBoundary,
        superOntologyPrivacyConfidentialityBoundarySkeleton(name),
        "utf8",
      );
    }

    const superOntologyStrategicIncentiveCompatibility = path.join(
      dir,
      SUPER_ONTOLOGY_STRATEGIC_INCENTIVE_COMPATIBILITY_FILE,
    );
    if (!fs.existsSync(superOntologyStrategicIncentiveCompatibility)) {
      secureWriteMissing(
        superOntologyStrategicIncentiveCompatibility,
        superOntologyStrategicIncentiveCompatibilitySkeleton(name),
        "utf8",
      );
    }

    const superOntologyReflexiveFeedbackStability = path.join(
      dir,
      SUPER_ONTOLOGY_REFLEXIVE_FEEDBACK_STABILITY_FILE,
    );
    if (!fs.existsSync(superOntologyReflexiveFeedbackStability)) {
      secureWriteMissing(
        superOntologyReflexiveFeedbackStability,
        superOntologyReflexiveFeedbackStabilitySkeleton(name),
        "utf8",
      );
    }

    for (const fileName of [
      SUPER_ONTOLOGY_REPLAYS_FILE,
      SUPER_ONTOLOGY_EVIDENCE_FILE,
      SUPER_ONTOLOGY_MEMORY_BRIDGE_FILE,
    ]) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) secureWriteMissing(filePath, "", "utf8");
    }

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
    if (!content.includes(AUTO_SECTION)) content += `\n${AUTO_SECTION}\n`;
    const block = lines.map((l) => `- ${l}`).join("\n") + "\n";
    fs.writeFileSync(soulPath, content.replace(/\s*$/, "\n") + block, "utf8");
  } catch {
    // best-effort
  }
}

// Legacy human-readable nest helper. Runtime recall now uses experience.sqlite
// below; this path remains only for old callers that explicitly request a
// markdown export and is no longer called by the Memory Curator.
// 빌린(고용한) 허브 에이전트의 전역 기억 둥지:
//   ~/.agentlas/networking/hub-agents/<slug>/memory/project-soul-memory.md
// 프로젝트 격리 유지: 이 레거시 helper도 agent_repo 용도 외에는 호출하면 안 된다.
function hubAgentNestSoulPath(slug: string): string | null {
  // Hephaestus 대여 엔진의 _norm_slug와 반드시 동일한 정규화.
  // (engine: re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-"))
  const norm = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!norm) return null;
  return path.join(os.homedir(), ".agentlas", "networking", "hub-agents", norm, "memory", PROJECT_SOUL_FILE);
}

function normalizedHubAgentSlug(slug: string): string | null {
  const normalized = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || null;
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
  const memoryDir = path.join(
    os.homedir(),
    ".agentlas",
    "networking",
    "hub-agents",
    normalizedSlug,
    "memory",
  );
  const dbPath = path.join(memoryDir, "experience.sqlite");
  let db: Database.Database | null = null;
  try {
    fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(memoryDir, 0o700);
    if (fs.existsSync(dbPath)) {
      const stat = fs.lstatSync(dbPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
    }
    db = new Database(dbPath);
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
    write(items);
    replayAgentNestExperienceGovernanceRelations(
      db,
      normalizedSlug,
      items.map((item) => item.id),
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
    return true;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* best-effort projection */ }
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
  const dbPath = path.join(
    os.homedir(),
    ".agentlas",
    "networking",
    "hub-agents",
    normalizedSlug,
    "memory",
    "experience.sqlite",
  );
  let db: Database.Database | null = null;
  try {
    if (!fs.existsSync(dbPath)) return false;
    const stat = fs.lstatSync(dbPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
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
    reconcile();
    return true;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* best-effort projection */ }
  }
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
    const dbPath = path.join(root, entry.name, "memory", "experience.sqlite");
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
      for (const match of matches) ownership[match.source_memory_id]?.push(slug);
    } catch {
      // One corrupt/unreadable private cache must not block other agents.
    } finally {
      try { db?.close(); } catch { /* best-effort scan */ }
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
    const dbPath = path.join(
      os.homedir(),
      ".agentlas",
      "networking",
      "hub-agents",
      slug,
      "memory",
      "experience.sqlite",
    );
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
