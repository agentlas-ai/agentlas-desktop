import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  CURATOR_DECISIONS_FILE,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  PROJECT_MEMORY_DIR,
  type MemoryKind,
  type MemoryScope,
} from "../architecture/manifest";
import { looksSecret } from "../../shared/secret-patterns";

/** Project-manager handoff notes live below the private project memory root. */
export const PROJECT_PM_DIR = "pm";

export const CURATOR_DECISION_MAX_CONTENT_BYTES = 8 * 1024 * 1024;
export const CURATOR_DECISIONS_MAX_FILE_BYTES = 64 * 1024 * 1024;

export const PROJECT_PM_DEFAULT_MAX_FILES = 32;
export const PROJECT_PM_DEFAULT_MAX_FILE_BYTES = 512 * 1024;
export const PROJECT_PM_DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const PROJECT_PM_HARD_MAX_FILES = 128;
const PROJECT_PM_HARD_MAX_FILE_BYTES = 4 * 1024 * 1024;
const PROJECT_PM_HARD_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const SITEMAP_DEFAULT_MAX_DEPTH = 32;
// 25_000 let this workspace's sitemap reach 13MB, which then blew the memory
// read cap and made the file unreadable — injected as nothing. Injection only
// emits per-status counts, so a coarser tree is lossless for recall while
// keeping the file readable; the hard ceiling below still allows an explicit
// large crawl.
const SITEMAP_DEFAULT_MAX_ENTRIES = 4_000;
const SITEMAP_HARD_MAX_DEPTH = 64;
const SITEMAP_HARD_MAX_ENTRIES = 100_000;

export type ProjectArtifactErrorCode =
  | "invalid-input"
  | "unsafe-project-root"
  | "invalid-metadata"
  | "path-traversal"
  | "symlink-denied"
  | "not-a-directory"
  | "not-a-regular-file"
  | "hardlink-denied"
  | "limit-exceeded"
  | "invalid-utf8"
  | "race-detected";

export class ProjectArtifactError extends Error {
  readonly code: ProjectArtifactErrorCode;

  constructor(code: ProjectArtifactErrorCode, message: string) {
    super(message);
    this.name = "ProjectArtifactError";
    this.code = code;
  }
}

function fail(code: ProjectArtifactErrorCode, message: string): never {
  throw new ProjectArtifactError(code, message);
}

interface ProjectRootIdentity {
  root: string;
  stat: fs.BigIntStats;
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

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.isFile() &&
    right.isFile() &&
    sameFsObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveExplicitProjectRoot(projectRoot: string): ProjectRootIdentity {
  if (typeof projectRoot !== "string" || !projectRoot.trim() || projectRoot.includes("\0")) {
    fail("invalid-input", "An explicit project root is required.");
  }

  let root: string;
  let stat: fs.BigIntStats;
  try {
    root = fs.realpathSync.native(path.resolve(projectRoot));
    stat = fs.lstatSync(root, { bigint: true });
  } catch {
    fail("unsafe-project-root", "The explicit project root is unavailable.");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("unsafe-project-root", "The explicit project root must resolve to a real directory.");
  }

  const normalized = path.resolve(root);
  const home = path.resolve(os.homedir());
  if (normalized === path.parse(normalized).root || samePath(normalized, home)) {
    fail("unsafe-project-root", "Filesystem roots and the home directory are not project roots.");
  }
  return { root: normalized, stat };
}

function assertProjectRootIdentity(identity: ProjectRootIdentity): void {
  try {
    const current = fs.lstatSync(identity.root, { bigint: true });
    const real = fs.realpathSync.native(identity.root);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameFsObject(identity.stat, current) ||
      !samePath(real, identity.root)
    ) {
      fail("race-detected", "The project root changed during the operation.");
    }
  } catch (error) {
    if (error instanceof ProjectArtifactError) throw error;
    fail("race-detected", "The project root changed during the operation.");
  }
}

function lstatOrNull(target: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertRealDirectory(
  identity: ProjectRootIdentity,
  directory: string,
  options: { create?: boolean; label: string },
): fs.BigIntStats {
  if (!pathIsInside(identity.root, directory) || samePath(identity.root, directory)) {
    fail("unsafe-project-root", `${options.label} is outside the explicit project root.`);
  }

  let stat = lstatOrNull(directory);
  if (!stat && options.create) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    stat = lstatOrNull(directory);
  }
  if (stat?.isSymbolicLink()) {
    fail("symlink-denied", `${options.label} must not be a symbolic link.`);
  }
  if (!stat || !stat.isDirectory()) {
    fail("not-a-directory", `${options.label} must be a directory.`);
  }

  let real: string;
  try {
    real = fs.realpathSync.native(directory);
  } catch {
    fail("not-a-directory", `${options.label} is unavailable.`);
  }
  if (!samePath(real, directory) || !pathIsInside(identity.root, real)) {
    fail("symlink-denied", `${options.label} must stay inside the explicit project root.`);
  }
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

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function opaqueHash(domain: string, value: string): string {
  if (Buffer.byteLength(value, "utf8") > 4096) {
    fail("limit-exceeded", "An opaque decision identifier exceeds the safe limit.");
  }
  return createHash("sha256").update(domain).update("\0").update(value, "utf8").digest("hex");
}

const CURATOR_DECISION_ACTIONS = [
  "written",
  "deduped",
  "redacted",
  "session",
  "discarded",
  "deferred",
] as const;
const CURATOR_MODES = ["semantic", "policy", "policy_fallback", "read_only"] as const;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
const SENSITIVITY_LEVELS = ["public", "internal", "private", "confidential", "secret"] as const;

export type CuratorDecisionAction = typeof CURATOR_DECISION_ACTIONS[number];
export type CuratorDecisionMode = typeof CURATOR_MODES[number];
export type CuratorDecisionConfidence = typeof CONFIDENCE_LEVELS[number];
export type CuratorDecisionSensitivity = typeof SENSITIVITY_LEVELS[number];

export interface CuratorDecisionAppendInput {
  /** Raw candidate bytes are hashed in memory and are never serialized. */
  content: string | Uint8Array;
  action: CuratorDecisionAction;
  reasonCode: string;
  ticketId?: string | null;
  targetMemoryId?: string | null;
  candidateIndex?: number;
  memoryKind?: MemoryKind;
  proposedScope?: MemoryScope;
  resolvedScope?: MemoryScope;
  confidence?: CuratorDecisionConfidence;
  sensitivity?: CuratorDecisionSensitivity;
  curatorMode?: CuratorDecisionMode;
}

export interface CuratorDecisionRecord {
  schema_version: "1.0";
  kind: "agentlas-curator-decision";
  decision_id: string;
  recorded_at: string;
  hash_algorithm: "sha256";
  content_hash: string;
  content_bytes: number;
  action: CuratorDecisionAction;
  reason_code: string;
  ticket_hash?: string;
  target_memory_hash?: string;
  candidate_index?: number;
  memory_kind?: MemoryKind;
  proposed_scope?: MemoryScope;
  resolved_scope?: MemoryScope;
  confidence?: CuratorDecisionConfidence;
  sensitivity?: CuratorDecisionSensitivity;
  curator_mode?: CuratorDecisionMode;
}

export interface AppendCuratorDecisionOptions {
  now?: Date;
  fsync?: boolean;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail("invalid-metadata", `${label} is not an allowed curator decision value.`);
  }
  return value as T;
}

function safeReasonCode(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value) ||
    looksSecret(value)
  ) {
    fail("invalid-metadata", "reasonCode must be a short value-free code.");
  }
  return value;
}

function optionalOpaqueHash(domain: string, value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid-metadata", "Decision identifiers must be non-empty strings.");
  }
  return opaqueHash(domain, value);
}

function decisionContentBytes(content: string | Uint8Array): Buffer {
  if (typeof content !== "string" && !(content instanceof Uint8Array)) {
    fail("invalid-input", "Decision content must be text or bytes.");
  }
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  if (bytes.length === 0 || bytes.length > CURATOR_DECISION_MAX_CONTENT_BYTES) {
    fail("limit-exceeded", "Decision content is empty or exceeds the safe hashing limit.");
  }
  return bytes;
}

function buildCuratorDecisionRecord(
  input: CuratorDecisionAppendInput,
  options: AppendCuratorDecisionOptions,
): CuratorDecisionRecord {
  const content = decisionContentBytes(input.content);
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("invalid-metadata", "The curator decision timestamp is invalid.");
  }
  if (
    input.candidateIndex !== undefined &&
    (!Number.isSafeInteger(input.candidateIndex) || input.candidateIndex < 0)
  ) {
    fail("invalid-metadata", "candidateIndex must be a non-negative safe integer.");
  }

  const contentHash = sha256(content);
  const ticketHash = optionalOpaqueHash("agentlas-curator-ticket", input.ticketId);
  const targetHash = optionalOpaqueHash("agentlas-curator-target", input.targetMemoryId);
  const decisionId = ticketHash
    ? `acd_${sha256(`agentlas-curator-decision\0${ticketHash}\0${input.candidateIndex ?? "episode"}\0${contentHash}`).slice(0, 40)}`
    : `acd_${randomUUID()}`;
  const record: CuratorDecisionRecord = {
    schema_version: "1.0",
    kind: "agentlas-curator-decision",
    decision_id: decisionId,
    recorded_at: now.toISOString(),
    hash_algorithm: "sha256",
    content_hash: contentHash,
    content_bytes: content.length,
    action: requireEnum(input.action, CURATOR_DECISION_ACTIONS, "action"),
    reason_code: safeReasonCode(input.reasonCode),
  };

  if (ticketHash) record.ticket_hash = ticketHash;
  if (targetHash) record.target_memory_hash = targetHash;
  if (input.candidateIndex !== undefined) record.candidate_index = input.candidateIndex;
  if (input.memoryKind !== undefined) {
    record.memory_kind = requireEnum(input.memoryKind, MEMORY_KINDS, "memoryKind");
  }
  if (input.proposedScope !== undefined) {
    record.proposed_scope = requireEnum(input.proposedScope, MEMORY_SCOPES, "proposedScope");
  }
  if (input.resolvedScope !== undefined) {
    record.resolved_scope = requireEnum(input.resolvedScope, MEMORY_SCOPES, "resolvedScope");
  }
  if (input.confidence !== undefined) {
    record.confidence = requireEnum(input.confidence, CONFIDENCE_LEVELS, "confidence");
  }
  if (input.sensitivity !== undefined) {
    record.sensitivity = requireEnum(input.sensitivity, SENSITIVITY_LEVELS, "sensitivity");
  }
  if (input.curatorMode !== undefined) {
    record.curator_mode = requireEnum(input.curatorMode, CURATOR_MODES, "curatorMode");
  }
  return record;
}

interface CuratorDecisionIdCache {
  size: bigint;
  ids: Set<string>;
}

const curatorDecisionIdCaches = new Map<string, CuratorDecisionIdCache>();

function decisionIdCache(outputPath: string, stat: fs.BigIntStats | null): CuratorDecisionIdCache {
  const size = stat?.size ?? 0n;
  const cached = curatorDecisionIdCaches.get(outputPath);
  if (cached && cached.size === size) return cached;
  const ids = new Set<string>();
  if (stat && size > 0n) {
    const raw = fs.readFileSync(outputPath, "utf8");
    for (const match of raw.matchAll(/"decision_id":"(acd_[A-Za-z0-9-]+)"/g)) ids.add(match[1]);
  }
  const next = { size, ids };
  curatorDecisionIdCaches.set(outputPath, next);
  return next;
}

function assertSerializedDecisionIsValueFree(serialized: string): void {
  const forbiddenKey = /"(?:prompt|raw_prompt|project_path|target_path|cwd|secret)"\s*:/i;
  const absolutePath = /(?:file:\/\/|\/(?:Users|home|private|var|opt)\/|[A-Za-z]:[\\/])/;
  if (forbiddenKey.test(serialized) || absolutePath.test(serialized) || looksSecret(serialized)) {
    fail("invalid-metadata", "The curator decision record is not privacy-safe.");
  }
}

/**
 * Append one value-free curator disposition to `.agentlas/curator-decisions.jsonl`.
 * Raw candidate content and opaque runtime identifiers are hashed before the
 * record is built; caller-supplied objects are never spread into the JSON line.
 * This is a storage boundary, not an authorization grant: callers must already
 * hold the Desktop write permission for the explicit project root.
 */
export function appendCuratorDecision(
  projectRoot: string,
  input: CuratorDecisionAppendInput,
  options: AppendCuratorDecisionOptions = {},
): CuratorDecisionRecord {
  const identity = resolveExplicitProjectRoot(projectRoot);
  const record = buildCuratorDecisionRecord(input, options);
  const serialized = JSON.stringify(record);
  assertSerializedDecisionIsValueFree(serialized);
  const line = Buffer.from(`${serialized}\n`, "utf8");
  const memoryRoot = path.join(identity.root, PROJECT_MEMORY_DIR);
  const memoryStat = assertRealDirectory(identity, memoryRoot, {
    create: true,
    label: "The project memory root",
  });
  const outputPath = path.join(memoryRoot, CURATOR_DECISIONS_FILE);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertProjectRootIdentity(identity);
    const currentMemory = assertRealDirectory(identity, memoryRoot, {
      label: "The project memory root",
    });
    if (!sameFsObject(memoryStat, currentMemory)) {
      fail("race-detected", "The project memory root changed during the append.");
    }

    const before = lstatOrNull(outputPath);
    if (before) {
      if (before.isSymbolicLink()) {
        fail("symlink-denied", "The curator decision log must not be a symbolic link.");
      }
      if (!before.isFile()) {
        fail("not-a-regular-file", "The curator decision log must be a regular file.");
      }
      if (before.nlink !== 1n) {
        fail("hardlink-denied", "The curator decision log must not be hard-linked.");
      }
      if (before.size + BigInt(line.length) > BigInt(CURATOR_DECISIONS_MAX_FILE_BYTES)) {
        fail("limit-exceeded", "The curator decision log reached its safe size limit.");
      }
    }
    const cachedIds = decisionIdCache(outputPath, before);
    if (cachedIds.ids.has(record.decision_id)) return record;

    const createFlags = before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL;
    let fd: number;
    try {
      fd = openNoFollow(
        outputPath,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | createFlags,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((!before && code === "EEXIST") || (before && code === "ENOENT")) continue;
      if (code === "ELOOP") {
        fail("symlink-denied", "The curator decision log must not be a symbolic link.");
      }
      throw error;
    }

    let retry = false;
    let appendedFileIdentity: fs.BigIntStats | null = null;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile()) {
        fail("not-a-regular-file", "The curator decision log changed type.");
      }
      if (opened.nlink !== 1n) {
        fail("hardlink-denied", "The curator decision log must not be hard-linked.");
      }
      if (before) {
        if (!sameStableFile(before, opened)) retry = true;
      } else if (opened.size !== 0n) {
        retry = true;
      }
      if (opened.size + BigInt(line.length) > BigInt(CURATOR_DECISIONS_MAX_FILE_BYTES)) {
        fail("limit-exceeded", "The curator decision log reached its safe size limit.");
      }
      if (!retry) {
        const written = fs.writeSync(fd, line, 0, line.length, null);
        if (written !== line.length) {
          fail("race-detected", "The curator decision line was not appended atomically.");
        }
        if (options.fsync !== false) fs.fsyncSync(fd);
        const afterDescriptor = fs.fstatSync(fd, { bigint: true });
        if (!afterDescriptor.isFile() || !sameFsObject(opened, afterDescriptor)) {
          fail("race-detected", "The curator decision log changed during the append.");
        }
        appendedFileIdentity = afterDescriptor;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (retry) continue;

    const afterPath = lstatOrNull(outputPath);
    if (
      !afterPath ||
      !appendedFileIdentity ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink !== 1n ||
      !sameFsObject(appendedFileIdentity, afterPath)
    ) {
      fail("race-detected", "The curator decision log changed after the append.");
    }
    assertRealDirectory(identity, memoryRoot, { label: "The project memory root" });
    assertProjectRootIdentity(identity);
    cachedIds.ids.add(record.decision_id);
    cachedIds.size = appendedFileIdentity.size;
    return record;
  }
  fail("race-detected", "The curator decision log changed repeatedly.");
}

export const DEFAULT_SITEMAP_EXCLUDED_DIRECTORIES = [
  ".agentlas",
  ".cache",
  ".git",
  ".gradle",
  ".hg",
  ".idea",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".svn",
  ".turbo",
  ".venv",
  ".vscode",
  "DerivedData",
  "Pods",
  "__pycache__",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "output",
  "outputs",
  "release",
  "target",
  "temp",
  "tmp",
  "vendor",
  "venv",
] as const;

export const DEFAULT_SITEMAP_EXCLUDED_FILES = [
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
] as const;

const PRIVATE_FILE_EXTENSIONS = new Set([
  ".der",
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pem",
  ".pfx",
]);

export interface GenerateProjectSitemapOptions {
  maxDepth?: number;
  maxEntries?: number;
  excludeDirectories?: readonly string[];
  excludeFiles?: readonly string[];
}

export interface ProjectSitemapNode {
  node_id: string;
  kind: "directory" | "file";
  relative_path: string;
  extension: string | null;
  size_bytes: number | null;
  status: "unknown";
  completion_score: 0;
  risk_level: "unknown";
  last_modified: null;
  last_tested: null;
  dependencies: [];
  acceptance_checks: [];
  evidence: [];
  provisional: true;
}

export interface ProjectSitemap {
  schemaVersion: "1.0";
  kind: "agentlas-ai-sitemap";
  project: string;
  projectId: string;
  state: "generated";
  priority_policy: string;
  source: {
    scope: "explicit-project-root";
    root: ".";
    followsSymlinks: false;
    scansHome: false;
    scansSiblingProjects: false;
  };
  exclusions: {
    directories: string[];
    files: string[];
    privateFileExtensions: string[];
  };
  stats: {
    directories: number;
    files: number;
    excludedDirectories: number;
    excludedFiles: number;
    skippedSymlinks: number;
    skippedSpecialEntries: number;
    truncated: boolean;
  };
  nodes: ProjectSitemapNode[];
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  hardMax: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMax) {
    fail("limit-exceeded", `${label} is outside the enforced safe range.`);
  }
  return resolved;
}

function portableRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sitemapNode(kind: "directory" | "file", relativePath: string, size: bigint | null): ProjectSitemapNode {
  if (size !== null && size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("limit-exceeded", "A project file is too large to represent safely in the sitemap.");
  }
  const portable = relativePath === "" ? "." : portableRelativePath(relativePath);
  const extension = kind === "file" ? path.extname(relativePath).slice(1).toLowerCase() || null : null;
  return {
    node_id: `smp_${sha256(`${kind}\0${portable}`).slice(0, 24)}`,
    kind,
    relative_path: portable,
    extension,
    size_bytes: size === null ? null : Number(size),
    status: "unknown",
    completion_score: 0,
    risk_level: "unknown",
    last_modified: null,
    last_tested: null,
    dependencies: [],
    acceptance_checks: [],
    evidence: [],
    provisional: true,
  };
}

function normalizeExclusionNames(values: readonly string[], label: string): string[] {
  const normalized = [...new Set(values)];
  for (const value of normalized) {
    if (
      typeof value !== "string" ||
      !value ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      value.includes("\0")
    ) {
      fail("invalid-input", `${label} entries must be single path-component names.`);
    }
  }
  return normalized.sort(compareStable);
}

function isPrivateSitemapFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (lower === "id_rsa" || lower === "id_ed25519") return true;
  return PRIVATE_FILE_EXTENSIONS.has(path.extname(lower));
}

interface DirectoryWorkItem {
  absolutePath: string;
  relativePath: string;
  depth: number;
}

/**
 * Build a stable, timestamp-free AI Sitemap from one explicit project root.
 * The walker never ascends, never follows symlinks, and excludes private state,
 * dependency caches, generated output, VCS internals, and common secret files.
 * Callers remain responsible for obtaining project-read authorization.
 */
export function generateProjectSitemap(
  projectRoot: string,
  options: GenerateProjectSitemapOptions = {},
): ProjectSitemap {
  const identity = resolveExplicitProjectRoot(projectRoot);
  const maxDepth = boundedInteger(
    options.maxDepth,
    SITEMAP_DEFAULT_MAX_DEPTH,
    SITEMAP_HARD_MAX_DEPTH,
    "maxDepth",
  );
  const maxEntries = boundedInteger(
    options.maxEntries,
    SITEMAP_DEFAULT_MAX_ENTRIES,
    SITEMAP_HARD_MAX_ENTRIES,
    "maxEntries",
  );
  const excludedDirectories = normalizeExclusionNames(
    [...DEFAULT_SITEMAP_EXCLUDED_DIRECTORIES, ...(options.excludeDirectories ?? [])],
    "excludeDirectories",
  );
  const excludedFiles = normalizeExclusionNames(
    [...DEFAULT_SITEMAP_EXCLUDED_FILES, ...(options.excludeFiles ?? [])],
    "excludeFiles",
  );
  const excludedDirectorySet = new Set(excludedDirectories);
  // The private Agentlas area is an invariant even when callers add custom exclusions.
  excludedDirectorySet.add(PROJECT_MEMORY_DIR);
  const excludedFileSet = new Set(excludedFiles);

  const nodes: ProjectSitemapNode[] = [sitemapNode("directory", "", null)];
  const stats = {
    directories: 1,
    files: 0,
    excludedDirectories: 0,
    excludedFiles: 0,
    skippedSymlinks: 0,
    skippedSpecialEntries: 0,
    truncated: false,
  };
  const work: DirectoryWorkItem[] = [{
    absolutePath: identity.root,
    relativePath: "",
    depth: 0,
  }];

  while (work.length > 0) {
    const current = work.pop()!;
    if (current.depth > maxDepth) {
      fail("limit-exceeded", "The project tree exceeds the sitemap depth limit.");
    }
    const before = fs.lstatSync(current.absolutePath, { bigint: true });
    if (before.isSymbolicLink()) {
      fail("symlink-denied", "A sitemap directory changed into a symbolic link.");
    }
    if (!before.isDirectory()) {
      fail("not-a-directory", "A sitemap directory changed type during traversal.");
    }
    const real = fs.realpathSync.native(current.absolutePath);
    if (!samePath(real, current.absolutePath) || !pathIsInside(identity.root, real)) {
      fail("symlink-denied", "A sitemap directory escaped the explicit project root.");
    }

    const entries = fs.readdirSync(current.absolutePath, { withFileTypes: true })
      .sort((left, right) => compareStable(left.name, right.name));
    const childDirectories: DirectoryWorkItem[] = [];
    for (const entry of entries) {
      const absolutePath = path.join(current.absolutePath, entry.name);
      const relativePath = current.relativePath
        ? path.join(current.relativePath, entry.name)
        : entry.name;
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      if (stat.isSymbolicLink()) {
        stats.skippedSymlinks += 1;
        continue;
      }
      if (stat.isDirectory()) {
        if (excludedDirectorySet.has(entry.name)) {
          stats.excludedDirectories += 1;
          continue;
        }
        if (current.depth + 1 > maxDepth) {
          stats.excludedDirectories += 1;
          stats.truncated = true;
          continue;
        }
        if (nodes.length >= maxEntries) {
          stats.truncated = true;
          break;
        }
        nodes.push(sitemapNode("directory", relativePath, null));
        stats.directories += 1;
        childDirectories.push({ absolutePath, relativePath, depth: current.depth + 1 });
        continue;
      }
      if (stat.isFile()) {
        if (excludedFileSet.has(entry.name) || isPrivateSitemapFile(entry.name)) {
          stats.excludedFiles += 1;
          continue;
        }
        if (nodes.length >= maxEntries) {
          stats.truncated = true;
          break;
        }
        nodes.push(sitemapNode("file", relativePath, stat.size));
        stats.files += 1;
        continue;
      }
      stats.skippedSpecialEntries += 1;
    }

    const after = fs.lstatSync(current.absolutePath, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameFsObject(before, after)) {
      fail("race-detected", "A sitemap directory changed during traversal.");
    }
    if (stats.truncated && nodes.length >= maxEntries) break;
    // Stack insertion is reversed so traversal remains lexicographically stable.
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      work.push(childDirectories[index]);
    }
  }

  assertProjectRootIdentity(identity);
  nodes.sort((left, right) => compareStable(left.relative_path, right.relative_path));
  const project = path.basename(identity.root) || "Project";
  const projectId = project.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  return {
    schemaVersion: "1.0",
    kind: "agentlas-ai-sitemap",
    project,
    projectId,
    state: "generated",
    priority_policy:
      "priority = risk_weight*risk + (1 - completion_score) + staleness + blocking_dependencies",
    source: {
      scope: "explicit-project-root",
      root: ".",
      followsSymlinks: false,
      scansHome: false,
      scansSiblingProjects: false,
    },
    exclusions: {
      directories: [...excludedDirectorySet].sort(compareStable),
      files: excludedFiles,
      privateFileExtensions: [...PRIVATE_FILE_EXTENSIONS].sort(compareStable),
    },
    stats,
    nodes,
  };
}

export interface ProjectPmReadLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface ProjectPmTextFile {
  relativePath: string;
  bytes: number;
  sha256: string;
  content: string;
}

interface ResolvedPmReadLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

function resolvePmReadLimits(limits: ProjectPmReadLimits): ResolvedPmReadLimits {
  const resolved = {
    maxFiles: boundedInteger(
      limits.maxFiles,
      PROJECT_PM_DEFAULT_MAX_FILES,
      PROJECT_PM_HARD_MAX_FILES,
      "maxFiles",
    ),
    maxFileBytes: boundedInteger(
      limits.maxFileBytes,
      PROJECT_PM_DEFAULT_MAX_FILE_BYTES,
      PROJECT_PM_HARD_MAX_FILE_BYTES,
      "maxFileBytes",
    ),
    maxTotalBytes: boundedInteger(
      limits.maxTotalBytes,
      PROJECT_PM_DEFAULT_MAX_TOTAL_BYTES,
      PROJECT_PM_HARD_MAX_TOTAL_BYTES,
      "maxTotalBytes",
    ),
  };
  resolved.maxFileBytes = Math.min(resolved.maxFileBytes, resolved.maxTotalBytes);
  return resolved;
}

function normalizePmRelativePath(requestedPath: string): { portable: string; segments: string[] } {
  if (typeof requestedPath !== "string" || !requestedPath || requestedPath.includes("\0")) {
    fail("path-traversal", "PM reads require a non-empty relative path.");
  }
  if (path.posix.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath)) {
    fail("path-traversal", "Absolute PM read paths are denied.");
  }
  const portable = requestedPath.replace(/\\/g, "/");
  const segments = portable.split("/");
  const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      /[\u0000-\u001f]/.test(segment) ||
      /[. ]$/.test(segment) ||
      windowsDeviceName.test(segment)
    )
  ) {
    fail("path-traversal", "PM read paths must be canonical and traversal-free.");
  }
  return { portable: segments.join("/"), segments };
}

function assertPmParentChain(
  identity: ProjectRootIdentity,
  pmRoot: string,
  segments: readonly string[],
): void {
  let current = pmRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (stat?.isSymbolicLink()) {
      fail("symlink-denied", "Symbolic links are denied in PM read paths.");
    }
    if (!stat || !stat.isDirectory()) {
      fail("not-a-directory", "A PM read parent must be a directory.");
    }
    const real = fs.realpathSync.native(current);
    if (!samePath(real, current) || !pathIsInside(pmRoot, real) || !pathIsInside(identity.root, real)) {
      fail("symlink-denied", "A PM read parent escaped the project memory area.");
    }
  }
}

function readStablePmTextFile(
  identity: ProjectRootIdentity,
  pmRoot: string,
  segments: readonly string[],
  maxBytes: number,
): ProjectPmTextFile {
  assertPmParentChain(identity, pmRoot, segments);
  const absolutePath = path.join(pmRoot, ...segments);
  if (!pathIsInside(pmRoot, absolutePath) || samePath(pmRoot, absolutePath)) {
    fail("path-traversal", "The PM read path escaped its private root.");
  }
  const before = lstatOrNull(absolutePath);
  if (!before) fail("not-a-regular-file", "The requested PM file does not exist.");
  if (before.isSymbolicLink()) fail("symlink-denied", "Symbolic PM files are denied.");
  if (!before.isFile()) fail("not-a-regular-file", "PM reads accept regular files only.");
  if (before.nlink !== 1n) fail("hardlink-denied", "Hard-linked PM files are denied.");
  if (before.size > BigInt(maxBytes)) {
    fail("limit-exceeded", "A requested PM file exceeds the byte limit.");
  }

  let fd: number;
  try {
    fd = openNoFollow(absolutePath, fs.constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      fail("symlink-denied", "Symbolic PM files are denied.");
    }
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameStableFile(before, opened)) {
      fail("race-detected", "The PM file changed before it could be read.");
    }
    if (opened.nlink !== 1n) fail("hardlink-denied", "Hard-linked PM files are denied.");
    if (opened.size > BigInt(maxBytes)) {
      fail("limit-exceeded", "A requested PM file exceeds the byte limit.");
    }
    const buffer = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) fail("race-detected", "The PM file changed while it was being read.");
      offset += count;
    }
    const afterDescriptor = fs.fstatSync(fd, { bigint: true });
    if (!sameStableFile(opened, afterDescriptor) || afterDescriptor.nlink !== 1n) {
      fail("race-detected", "The PM file changed while it was being read.");
    }
    const afterPath = fs.lstatSync(absolutePath, { bigint: true });
    if (afterPath.isSymbolicLink() || !sameStableFile(afterDescriptor, afterPath)) {
      fail("race-detected", "The PM file changed after it was read.");
    }
    assertPmParentChain(identity, pmRoot, segments);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      fail("invalid-utf8", "PM text files must contain valid UTF-8.");
    }
    return {
      relativePath: segments.join("/"),
      bytes: buffer.length,
      sha256: sha256(buffer),
      content,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read an explicit, bounded set of UTF-8 files from `.agentlas/pm`.
 * Paths are canonicalized and sorted, every parent and final file must be a
 * real non-linked filesystem object, and count/per-file/aggregate caps cannot
 * be disabled by callers. This filesystem boundary does not replace the
 * caller's activated-folder/read-permission check.
 */
export function readProjectPmTextFiles(
  projectRoot: string,
  relativePaths: readonly string[],
  limits: ProjectPmReadLimits = {},
): ProjectPmTextFile[] {
  if (!Array.isArray(relativePaths)) {
    fail("invalid-input", "PM reads require an explicit list of relative paths.");
  }
  const resolvedLimits = resolvePmReadLimits(limits);
  if (relativePaths.length > resolvedLimits.maxFiles) {
    fail("limit-exceeded", "The PM read request exceeds the file-count limit.");
  }
  const normalized = relativePaths.map(normalizePmRelativePath);
  normalized.sort((left, right) => compareStable(left.portable, right.portable));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].portable === normalized[index].portable) {
      fail("invalid-input", "Duplicate PM read paths are not allowed.");
    }
  }
  if (normalized.length === 0) return [];

  const identity = resolveExplicitProjectRoot(projectRoot);
  const memoryRoot = path.join(identity.root, PROJECT_MEMORY_DIR);
  const memoryStat = assertRealDirectory(identity, memoryRoot, {
    label: "The project memory root",
  });
  const pmRoot = path.join(memoryRoot, PROJECT_PM_DIR);
  const pmStat = assertRealDirectory(identity, pmRoot, { label: "The PM memory root" });

  const files: ProjectPmTextFile[] = [];
  let totalBytes = 0;
  for (const requested of normalized) {
    const remaining = resolvedLimits.maxTotalBytes - totalBytes;
    if (remaining < 0) fail("limit-exceeded", "The PM read request exceeds the aggregate byte limit.");
    const file = readStablePmTextFile(
      identity,
      pmRoot,
      requested.segments,
      Math.min(resolvedLimits.maxFileBytes, remaining),
    );
    totalBytes += file.bytes;
    if (totalBytes > resolvedLimits.maxTotalBytes) {
      fail("limit-exceeded", "The PM read request exceeds the aggregate byte limit.");
    }
    files.push(file);
  }

  const currentMemory = assertRealDirectory(identity, memoryRoot, {
    label: "The project memory root",
  });
  const currentPm = assertRealDirectory(identity, pmRoot, { label: "The PM memory root" });
  if (!sameFsObject(memoryStat, currentMemory) || !sameFsObject(pmStat, currentPm)) {
    fail("race-detected", "The PM memory roots changed during the read.");
  }
  assertProjectRootIdentity(identity);
  return files;
}

const PROJECT_PM_TEXT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
]);
const PROJECT_PM_MAX_DISCOVERY_DEPTH = 8;

/** Discover only bounded, regular text files below `.agentlas/pm`. */
export function discoverProjectPmTextPaths(projectRoot: string, maxFiles = PROJECT_PM_DEFAULT_MAX_FILES): string[] {
  const limit = boundedInteger(maxFiles, PROJECT_PM_DEFAULT_MAX_FILES, PROJECT_PM_HARD_MAX_FILES, "maxFiles");
  const identity = resolveExplicitProjectRoot(projectRoot);
  const memoryRoot = path.join(identity.root, PROJECT_MEMORY_DIR);
  assertRealDirectory(identity, memoryRoot, { label: "The project memory root" });
  const pmRoot = path.join(memoryRoot, PROJECT_PM_DIR);
  if (!lstatOrNull(pmRoot)) return [];
  assertRealDirectory(identity, pmRoot, { label: "The PM memory root" });

  const paths: string[] = [];
  const work = [{ absolutePath: pmRoot, relativePath: "", depth: 0 }];
  while (work.length > 0 && paths.length < limit) {
    const current = work.pop()!;
    const entries = fs.readdirSync(current.absolutePath, { withFileTypes: true })
      .sort((left, right) => compareStable(left.name, right.name));
    const childDirectories: typeof work = [];
    for (const entry of entries) {
      if (paths.length >= limit) break;
      const absolutePath = path.join(current.absolutePath, entry.name);
      const relativePath = current.relativePath
        ? path.join(current.relativePath, entry.name)
        : entry.name;
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (current.depth < PROJECT_PM_MAX_DISCOVERY_DEPTH) {
          const real = fs.realpathSync.native(absolutePath);
          if (samePath(real, absolutePath) && pathIsInside(pmRoot, real)) {
            childDirectories.push({ absolutePath, relativePath, depth: current.depth + 1 });
          }
        }
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1n) continue;
      if (!PROJECT_PM_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      paths.push(portableRelativePath(relativePath));
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      work.push(childDirectories[index]);
    }
  }
  assertProjectRootIdentity(identity);
  return paths.sort(compareStable);
}

export function readDiscoveredProjectPmTextFiles(
  projectRoot: string,
  limits: ProjectPmReadLimits = {},
): ProjectPmTextFile[] {
  const resolved = resolvePmReadLimits(limits);
  const paths = discoverProjectPmTextPaths(projectRoot, resolved.maxFiles);
  return readProjectPmTextFiles(projectRoot, paths, resolved);
}
