// First writable Desktop contact delegates the canonical project architecture
// to Agentlas Core. Restricted read and Site Agent App runs never enter here.
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../store/db";
import {
  ensureDesktopProjectBootstrap,
  projectBootstrapAccessAllowed,
  type ProjectBootstrapAccess,
  type ProjectBootstrapResult,
} from "./project-bootstrap";

export interface VisitResult {
  visits: number;
  activated: boolean;
  /** True only on the turn activation first happened (for UI/log surfacing). */
  justActivated: boolean;
  bootstrapMode: ProjectBootstrapResult["mode"];
}

interface StableFsFingerprint {
  dev: string | null;
  ino: string | null;
  birthtimeNs: string | null;
}

interface FolderRootIdentity {
  requestedPath: string;
  canonicalPath: string;
  entryKind: "directory" | "symlink";
  entry: StableFsFingerprint;
  target: StableFsFingerprint;
}

interface ActivatedFolderIdentity extends FolderRootIdentity {
  version: 1;
  memoryCanonicalPath: string;
  memoryTarget: StableFsFingerprint;
}

const ACTIVATED_FOLDER_IDENTITY_TABLE = "activated_folder_identity";

function normalizeFsPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function fingerprint(stat: fs.BigIntStats): StableFsFingerprint {
  return {
    // Some Windows/network filesystems expose zero for one or both identifiers.
    // Treat those fields as unavailable rather than rejecting an otherwise stable
    // canonical directory. birthtime is the platform-safe replacement signal.
    dev: stat.dev > 0n ? stat.dev.toString() : null,
    ino: stat.ino > 0n ? stat.ino.toString() : null,
    birthtimeNs: stat.birthtimeNs > 0n ? stat.birthtimeNs.toString() : null,
  };
}

function captureFolderRootIdentity(projectPath: string): FolderRootIdentity {
  const requestedPath = path.resolve(projectPath);
  const entryStat = fs.lstatSync(requestedPath, { bigint: true });
  const entryKind = entryStat.isSymbolicLink()
    ? "symlink"
    : entryStat.isDirectory()
      ? "directory"
      : null;
  if (!entryKind) throw new Error("Activated project path is not a directory.");
  const canonicalPath = fs.realpathSync.native(requestedPath);
  const targetStat = fs.statSync(canonicalPath, { bigint: true });
  if (!targetStat.isDirectory()) throw new Error("Activated project target is not a directory.");
  return {
    requestedPath: normalizeFsPath(requestedPath),
    canonicalPath: normalizeFsPath(canonicalPath),
    entryKind,
    entry: fingerprint(entryStat),
    target: fingerprint(targetStat),
  };
}

function pathIsInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function captureActivatedFolderIdentity(projectPath: string): ActivatedFolderIdentity {
  const root = captureFolderRootIdentity(projectPath);
  const memoryPath = path.join(path.resolve(projectPath), ".agentlas");
  const memoryEntry = fs.lstatSync(memoryPath, { bigint: true });
  if (memoryEntry.isSymbolicLink() || !memoryEntry.isDirectory()) {
    throw new Error("Activated project memory root must be a real directory.");
  }
  const memoryCanonicalPath = fs.realpathSync.native(memoryPath);
  const rootCanonicalPath = fs.realpathSync.native(path.resolve(projectPath));
  if (!pathIsInside(rootCanonicalPath, memoryCanonicalPath)) {
    throw new Error("Activated project memory root escaped its project.");
  }
  const memoryTarget = fs.statSync(memoryCanonicalPath, { bigint: true });
  if (!memoryTarget.isDirectory()) {
    throw new Error("Activated project memory target is not a directory.");
  }
  return {
    version: 1,
    ...root,
    memoryCanonicalPath: normalizeFsPath(memoryCanonicalPath),
    memoryTarget: fingerprint(memoryTarget),
  };
}

function fingerprintMatches(expected: StableFsFingerprint, actual: StableFsFingerprint): boolean {
  if (expected.dev !== null && actual.dev !== null && expected.dev !== actual.dev) return false;
  if (expected.ino !== null && actual.ino !== null && expected.ino !== actual.ino) return false;
  if (
    expected.birthtimeNs !== null &&
    actual.birthtimeNs !== null &&
    expected.birthtimeNs !== actual.birthtimeNs
  ) return false;
  // At least one stable filesystem signal is required when canonical paths
  // alone cannot distinguish a same-path replacement.
  const sharedStableSignal =
    (expected.ino !== null && actual.ino !== null) ||
    (expected.birthtimeNs !== null && actual.birthtimeNs !== null);
  return sharedStableSignal || expected.dev === actual.dev;
}

function rootIdentityMatches(expected: FolderRootIdentity, actual: FolderRootIdentity): boolean {
  return expected.requestedPath === actual.requestedPath &&
    expected.canonicalPath === actual.canonicalPath &&
    expected.entryKind === actual.entryKind &&
    fingerprintMatches(expected.entry, actual.entry) &&
    fingerprintMatches(expected.target, actual.target);
}

function activatedIdentityMatches(
  expected: ActivatedFolderIdentity,
  actual: ActivatedFolderIdentity,
): boolean {
  return rootIdentityMatches(expected, actual) &&
    expected.memoryCanonicalPath === actual.memoryCanonicalPath &&
    fingerprintMatches(expected.memoryTarget, actual.memoryTarget);
}

function isActivatedFolderIdentity(value: unknown): value is ActivatedFolderIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ActivatedFolderIdentity>;
  const validFingerprint = (item: unknown): item is StableFsFingerprint => {
    if (!item || typeof item !== "object") return false;
    const fp = item as Partial<StableFsFingerprint>;
    return [fp.dev, fp.ino, fp.birthtimeNs].every((field) => field === null || typeof field === "string");
  };
  return candidate.version === 1 &&
    typeof candidate.requestedPath === "string" &&
    typeof candidate.canonicalPath === "string" &&
    (candidate.entryKind === "directory" || candidate.entryKind === "symlink") &&
    validFingerprint(candidate.entry) &&
    validFingerprint(candidate.target) &&
    typeof candidate.memoryCanonicalPath === "string" &&
    validFingerprint(candidate.memoryTarget);
}

function ensureActivatedFolderIdentityTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ${ACTIVATED_FOLDER_IDENTITY_TABLE} (
      path TEXT PRIMARY KEY,
      identity_json TEXT NOT NULL,
      captured_at TEXT NOT NULL
    )
  `);
}

function readStoredActivatedFolderIdentity(projectPath: string): ActivatedFolderIdentity | null {
  ensureActivatedFolderIdentityTable();
  const row = getDb()
    .prepare(`SELECT identity_json FROM ${ACTIVATED_FOLDER_IDENTITY_TABLE} WHERE path = ?`)
    .get(projectPath) as { identity_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.identity_json) as unknown;
    return isActivatedFolderIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeActivatedFolderIdentity(
  projectPath: string,
  identity: ActivatedFolderIdentity,
  capturedAt: string,
): void {
  ensureActivatedFolderIdentityTable();
  getDb()
    .prepare(
      `INSERT INTO ${ACTIVATED_FOLDER_IDENTITY_TABLE} (path, identity_json, captured_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET identity_json = excluded.identity_json, captured_at = excluded.captured_at`,
    )
    .run(projectPath, JSON.stringify(identity), capturedAt);
}

/**
 * Re-check the persisted activation identity without writing to the project or
 * visit ledger. Missing legacy identity fails closed until an authorized write
 * turn (or explicit activation) binds the current folder.
 */
export function verifyActivatedFolderIdentity(projectPath: string): boolean {
  try {
    const stored = readStoredActivatedFolderIdentity(projectPath);
    if (!stored) return false;
    return activatedIdentityMatches(stored, captureActivatedFolderIdentity(projectPath));
  } catch {
    return false;
  }
}

/**
 * Record the first authorized writable contact, await canonical setup, and then
 * mark the folder active. Later calls reuse the process-local bootstrap result.
 */
export async function recordFolderVisit(
  projectPath: string,
  projectName: string | undefined,
  access: ProjectBootstrapAccess,
): Promise<VisitResult> {
  if (!projectBootstrapAccessAllowed(access)) {
    throw new Error("Project activation is unavailable outside an interactive writable Desktop run.");
  }
  const db = getDb();
  const existing = db
    .prepare("SELECT visits, activated_at FROM folder_activity WHERE path = ?")
    .get(projectPath) as { visits: number; activated_at: string | null } | undefined;
  const storedIdentity = existing?.activated_at
    ? readStoredActivatedFolderIdentity(projectPath)
    : null;
  if (storedIdentity && !activatedIdentityMatches(storedIdentity, captureActivatedFolderIdentity(projectPath))) {
    throw new Error("Activated project folder identity changed; explicit reactivation is required.");
  }
  const beforeRoot = captureFolderRootIdentity(projectPath);
  const bootstrap = await ensureDesktopProjectBootstrap({
    projectPath,
    projectName,
    access,
    reason: "desktop-first-contact",
  });
  const capturedIdentity = bootstrap.mode === "core"
    ? captureActivatedFolderIdentity(projectPath)
    : null;
  if (capturedIdentity && !rootIdentityMatches(beforeRoot, capturedIdentity)) {
    throw new Error("Project folder changed while activation was running.");
  }
  if (storedIdentity && capturedIdentity && !activatedIdentityMatches(storedIdentity, capturedIdentity)) {
    throw new Error("Project memory root changed while activation was running.");
  }
  const now = new Date().toISOString();
  const row = db
    .prepare("SELECT visits, activated_at FROM folder_activity WHERE path = ?")
    .get(projectPath) as { visits: number; activated_at: string | null } | undefined;

  let visits: number;
  let activatedAt: string | null;
  if (row) {
    visits = row.visits + 1;
    activatedAt = row.activated_at;
    db.prepare("UPDATE folder_activity SET visits = ?, last_seen = ? WHERE path = ?").run(
      visits,
      now,
      projectPath,
    );
  } else {
    visits = 1;
    activatedAt = null;
    db.prepare(
      "INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?, ?, NULL, ?, ?)",
    ).run(projectPath, visits, now, now);
  }

  let justActivated = false;
  // The tiny Desktop fallback is intentionally not promoted to active memory:
  // doing so would let legacy curator code expand it beyond the safe seed.
  if (bootstrap.mode === "core" && !activatedAt) {
    db.prepare("UPDATE folder_activity SET activated_at = ? WHERE path = ?").run(now, projectPath);
    activatedAt = now;
    justActivated = true;
  }
  if (bootstrap.mode === "core" && activatedAt && capturedIdentity) {
    // This also binds legacy activated rows that predate identity storage, but
    // only after an authorized writable Desktop contact.
    storeActivatedFolderIdentity(projectPath, capturedIdentity, now);
  }

  return {
    visits,
    activated: bootstrap.mode === "core" && Boolean(activatedAt),
    justActivated,
    bootstrapMode: bootstrap.mode,
  };
}

export function isFolderActivated(projectPath: string): boolean {
  const row = getDb()
    .prepare("SELECT activated_at FROM folder_activity WHERE path = ?")
    .get(projectPath) as { activated_at: string | null } | undefined;
  return Boolean(row?.activated_at);
}

/**
 * Existing local project memory may be read by an ordinary Desktop turn even
 * when its tool permission is read-only. This never activates/materializes a
 * project and is forbidden for Mobile/restricted and browser Agent App runs.
 */
export function canReadActivatedFolderMemory(
  projectPath: string,
  access: ProjectBootstrapAccess,
): boolean {
  if (access.restrictedReadBoundary === true || access.agentAppMode === true) return false;
  if (access.permission !== "read" && access.permission !== "write" && access.permission !== "full") return false;
  try {
    return isFolderActivated(projectPath) && verifyActivatedFolderIdentity(projectPath);
  } catch {
    // A damaged/unavailable local store removes optional recall; it must never
    // block the user's turn or cause a new project activation as recovery.
    return false;
  }
}

/** Force-activate now (used by explicit UI/CLI actions). */
export async function activateFolder(
  projectPath: string,
  projectName: string | undefined,
  access: ProjectBootstrapAccess,
): Promise<ProjectBootstrapResult["mode"]> {
  if (!projectBootstrapAccessAllowed(access)) {
    throw new Error("Project activation is unavailable outside an interactive writable Desktop run.");
  }
  const beforeRoot = captureFolderRootIdentity(projectPath);
  const bootstrap = await ensureDesktopProjectBootstrap({
    projectPath,
    projectName,
    access,
    reason: "desktop-explicit-activation",
  });
  if (bootstrap.mode !== "core") return bootstrap.mode;
  const capturedIdentity = captureActivatedFolderIdentity(projectPath);
  if (!rootIdentityMatches(beforeRoot, capturedIdentity)) {
    throw new Error("Project folder changed while activation was running.");
  }
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare("SELECT visits FROM folder_activity WHERE path = ?")
    .get(projectPath) as { visits: number } | undefined;
  if (row) {
    db.prepare("UPDATE folder_activity SET activated_at = COALESCE(activated_at, ?), last_seen = ? WHERE path = ?").run(
      now,
      now,
      projectPath,
    );
  } else {
    db.prepare(
      "INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?, 1, ?, ?, ?)",
    ).run(projectPath, now, now, now);
  }
  // Explicit activation is the user-authorized path for rebinding a folder that
  // was deliberately replaced at the same visible path.
  storeActivatedFolderIdentity(projectPath, capturedIdentity, now);
  return bootstrap.mode;
}
