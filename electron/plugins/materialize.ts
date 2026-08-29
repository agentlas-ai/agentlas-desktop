// Materialize bundled plugins as exact releases under ~/.agentlas/plugins.
// Only `.state/` is host/user data. The release itself is staged and verified
// before an atomic directory swap, so plugin.json can never claim a new
// version over a partial mixture of old and new files.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { app } from "electron";

function bundledPluginsRoot(): string {
  return path.join(app.getAppPath(), "dist", "plugins");
}

function installedPluginsRoot(): string {
  return path.join(os.homedir(), ".agentlas", "plugins");
}

function isHostOwned(name: string): boolean {
  // Dot-prefixed package content such as `.claude-plugin/` is part of an
  // exact release. Only these two entries are written by the host.
  return name === ".state" || name === ".install.json";
}

function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value) && !value.includes("..");
}

function lstatIfPresent(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertRealDirectory(target: string, label: string): void {
  const stat = lstatIfPresent(target);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

type PluginManifestIdentity = { slug: string; version: string };

type SemverIdentity = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
};

function parseSemver(value: string): SemverIdentity | null {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => /^\d+$/u.test(part) ? Number(part) : part)
    : [];
  if (prerelease.some((part) => typeof part === "number" && !Number.isSafeInteger(part))) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error("plugin version must be exact SemVer");
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "string") return -1;
    if (typeof av === "string" && typeof bv === "number") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function readManifestIdentity(dir: string): PluginManifestIdentity {
  assertRealDirectory(dir, "plugin directory");
  const manifestPath = path.join(dir, "plugin.json");
  const manifestStat = lstatIfPresent(manifestPath);
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error("plugin.json must be a real file");
  }
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { slug?: unknown; version?: unknown };
  const slug = typeof value.slug === "string" ? value.slug.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  if (!validSlug(slug) || !version || version.length > 128 || !parseSemver(version)) {
    throw new Error("invalid plugin manifest identity");
  }
  return { slug, version };
}

function releaseDigest(root: string): string {
  assertRealDirectory(root, "plugin release");
  const hash = createHash("sha256");
  const visit = (dir: string, relativeDir: string, topLevel: boolean): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (topLevel && isHostOwned(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.posix.join(relativeDir, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`plugin release contains symlink: ${relative}`);
      if (stat.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        visit(absolute, relative, false);
      } else if (stat.isFile()) {
        hash.update(`F\0${relative}\0${stat.size}\0${stat.mode & 0o777}\0`);
        hash.update(fs.readFileSync(absolute));
      } else {
        throw new Error(`plugin release contains unsupported entry: ${relative}`);
      }
    }
  };
  visit(root, "", true);
  return `sha256:${hash.digest("hex")}`;
}

type ReleaseCopier = (source: string, destination: string) => void;

function copyExactTree(from: string, to: string, copier: ReleaseCopier, topLevel = true): number {
  assertRealDirectory(from, "copy source");
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  let count = 0;
  const entries = fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (topLevel && isHostOwned(entry.name)) continue;
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`copy source contains symlink: ${entry.name}`);
    if (stat.isDirectory()) {
      count += copyExactTree(source, destination, copier, false);
    } else if (stat.isFile()) {
      copier(source, destination);
      fs.chmodSync(destination, stat.mode & 0o777);
      count += 1;
    } else {
      throw new Error(`copy source contains unsupported entry: ${entry.name}`);
    }
  }
  return count;
}

function invalidateFalseCurrent(
  destination: string,
  expectedVersion: string,
  expectedDigest: string,
): void {
  try {
    const current = readManifestIdentity(destination);
    if (current.version !== expectedVersion) return;
    // A concurrent exact repair may have won after our failed staging attempt.
    // Never invalidate that release merely because this caller failed.
    if (releaseDigest(destination) === expectedDigest) return;
    const manifestPath = path.join(destination, "plugin.json");
    const invalidPath = path.join(destination, ".plugin.invalid.json");
    if (lstatIfPresent(invalidPath)) fs.rmSync(invalidPath, { force: true });
    fs.renameSync(manifestPath, invalidPath);
  } catch {
    // Unsafe/unavailable destinations are not followed just to write a marker.
  }
}

const MATERIALIZE_LOCK_WAIT_MS = 15_000;
type MaterializeLock = { database: Database.Database; token: string };

/**
 * Cross-process materialization lock backed by SQLite's OS file lock.
 *
 * A mkdir lease needs a stale-owner reaper. Two reapers can observe the same
 * stale directory, then one can move a newly-created live directory after an
 * ABA path reuse. SQLite transactions do not reap or replace a canonical lock
 * path: the kernel releases the writer lock when a process exits, and every
 * contender waits on the same database inode. One database per slug keeps
 * unrelated plugin releases independent.
 */
function acquireMaterializeLock(parent: string, slug: string): MaterializeLock {
  const lockPath = path.join(parent, `.${slug}.materialize-lock.sqlite3`);
  const existing = lstatIfPresent(lockPath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("plugin materialize lock database must be a real file");
  }
  const token = randomUUID();
  const database = new Database(lockPath, { timeout: MATERIALIZE_LOCK_WAIT_MS });
  try {
    const opened = lstatIfPresent(lockPath);
    if (!opened || opened.isSymbolicLink() || !opened.isFile()) {
      throw new Error("plugin materialize lock database changed during open");
    }
    fs.chmodSync(lockPath, 0o600);
    database.pragma(`busy_timeout = ${MATERIALIZE_LOCK_WAIT_MS}`);
    database.exec("BEGIN IMMEDIATE");
    database.exec(`
      CREATE TABLE IF NOT EXISTS materialize_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token TEXT NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL
      )
    `);
    database.prepare(`
      INSERT INTO materialize_owner (singleton, token, pid, acquired_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        token = excluded.token,
        pid = excluded.pid,
        acquired_at = excluded.acquired_at
    `).run(token, process.pid, Date.now());
    return { database, token };
  } catch (error) {
    try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { /* surface acquisition failure */ }
    try { database.close(); } catch { /* surface acquisition failure */ }
    throw error;
  }
}

function releaseMaterializeLock(lock: MaterializeLock): void {
  try {
    const owner = lock.database
      .prepare("SELECT token FROM materialize_owner WHERE singleton = 1")
      .get() as { token?: unknown } | undefined;
    if (owner?.token === lock.token && lock.database.inTransaction) lock.database.exec("COMMIT");
    else if (lock.database.inTransaction) lock.database.exec("ROLLBACK");
  } catch {
    try { if (lock.database.inTransaction) lock.database.exec("ROLLBACK"); } catch { /* close releases OS lock */ }
  } finally {
    try { lock.database.close(); } catch { /* process exit also releases the OS lock */ }
  }
}

function installationToken(destination: string): string | null {
  try {
    const stat = lstatIfPresent(path.join(destination, ".install.json"));
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
    const value = JSON.parse(fs.readFileSync(path.join(destination, ".install.json"), "utf8")) as {
      installationId?: unknown;
    };
    return typeof value.installationId === "string" ? value.installationId : null;
  } catch {
    return null;
  }
}

function exactInstalledMetadata(
  destination: string,
  slug: string,
  version: string,
  digest: string,
): boolean {
  try {
    const metadataPath = path.join(destination, ".install.json");
    const stat = lstatIfPresent(metadataPath);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
    const value = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      schema?: unknown;
      slug?: unknown;
      version?: unknown;
      digest?: unknown;
    };
    return value.schema === "agentlas.plugin-install/v1"
      && value.slug === slug
      && value.version === version
      && value.digest === digest;
  } catch {
    return false;
  }
}

export interface MaterializeReceipt {
  slug: string;
  action: "installed" | "updated" | "unchanged" | "failed";
  version?: string;
  digest?: string;
  files?: number;
  reason?: string;
  /** Host state or an owned failed generation retained for manual recovery. */
  recoveryPaths?: string[];
}

/** Exact-release primitive exported for isolated filesystem regression tests. */
export function materializePluginRelease(input: {
  slug: string;
  sourceDir: string;
  destinationDir: string;
  copyFile?: ReleaseCopier;
  /** Private fixture hook; production never injects lifecycle callbacks. */
  onAfterDestinationBackup?: () => void;
  /** Private fixture hook for a path-based state writer during the swap. */
  onAfterReleaseSwap?: () => void;
  /** Private fixture hook for a writer arriving after post-swap state reconciliation. */
  onBeforeBackupRetention?: () => void;
}): MaterializeReceipt {
  const { slug, sourceDir, destinationDir } = input;
  const copyFile = input.copyFile ?? ((source, destination) => fs.copyFileSync(source, destination));
  let version: string | undefined;
  let digest: string | undefined;
  let presentVersion: string | null = null;
  let presentDigest: string | null = null;
  let stage = "";
  let backup = "";
  let swapped = false;
  let stateMoved = false;
  const recoveryPaths = new Set<string>();
  const installationId = randomUUID();
  let lock: MaterializeLock | null = null;
  try {
    if (!validSlug(slug) || path.basename(sourceDir) !== slug || path.basename(destinationDir) !== slug) {
      throw new Error("plugin slug/path mismatch");
    }
    const sourceIdentity = readManifestIdentity(sourceDir);
    if (sourceIdentity.slug !== slug) throw new Error("bundled plugin slug mismatch");
    version = sourceIdentity.version;
    digest = releaseDigest(sourceDir);

    const parent = path.dirname(destinationDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertRealDirectory(parent, "installed plugins root");
    lock = acquireMaterializeLock(parent, slug);
    const destinationStat = lstatIfPresent(destinationDir);
    if (destinationStat) {
      if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        throw new Error("plugin destination must be a real directory");
      }
      try {
        const identity = readManifestIdentity(destinationDir);
        presentVersion = identity.slug === slug ? identity.version : null;
        presentDigest = releaseDigest(destinationDir);
      } catch {
        presentVersion = null;
        presentDigest = null;
      }
      if (presentVersion === version && presentDigest === digest) {
        return { slug, action: "unchanged", version, digest };
      }
      if (presentVersion && presentDigest && compareSemver(presentVersion, version) > 0) {
        if (exactInstalledMetadata(destinationDir, slug, presentVersion, presentDigest)) {
          return {
            slug,
            action: "unchanged",
            version: presentVersion,
            digest: presentDigest,
            reason: `newer installed release ${presentVersion} preserved`,
          };
        }
        throw new Error(`newer installed release ${presentVersion} was preserved but could not be integrity-verified`);
      }
    }

    stage = fs.mkdtempSync(path.join(parent, `.${slug}.stage-`));
    const files = copyExactTree(sourceDir, stage, copyFile);
    const stagedIdentity = readManifestIdentity(stage);
    const stagedDigest = releaseDigest(stage);
    if (stagedIdentity.slug !== slug || stagedIdentity.version !== version || stagedDigest !== digest) {
      throw new Error("staged plugin release failed identity verification");
    }
    fs.writeFileSync(
      path.join(stage, ".install.json"),
      `${JSON.stringify({ schema: "agentlas.plugin-install/v1", slug, version, digest, installationId }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    if (destinationStat) {
      backup = path.join(parent, `.${slug}.backup-${randomUUID()}`);
      fs.renameSync(destinationDir, backup);
      input.onAfterDestinationBackup?.();
    }
    try {
      fs.renameSync(stage, destinationDir);
      stage = "";
      swapped = true;
      input.onAfterReleaseSwap?.();
      const backupState = backup ? path.join(backup, ".state") : "";
      const destinationState = path.join(destinationDir, ".state");
      const backupStateExists = Boolean(backupState && lstatIfPresent(backupState));
      const destinationStateExists = Boolean(lstatIfPresent(destinationState));
      if (backupStateExists && !destinationStateExists) {
        // Re-read after the public swap rather than trusting a pre-swap
        // snapshot. A writer holding the renamed old directory may create its
        // first `.state` entry after destination→backup. Move that exact inode
        // into the active release when there is no competing new-path state.
        fs.renameSync(backupState, destinationState);
        stateMoved = true;
      } else if (backupStateExists && destinationStateExists) {
        // Two independently written host-state trees cannot be merged without
        // application semantics. Keep the new public-path state active and
        // retain the old tree as explicit recovery material; delete neither.
        recoveryPaths.add(backup);
      }
      input.onBeforeBackupRetention?.();
    } catch (error) {
      if (backup && !lstatIfPresent(destinationDir) && lstatIfPresent(backup)) {
        fs.renameSync(backup, destinationDir);
        backup = "";
      }
      throw error;
    }
    if (installationToken(destinationDir) !== installationId) {
      throw new Error("installed plugin generation changed during swap");
    }
    if (releaseDigest(destinationDir) !== digest) throw new Error("installed plugin digest mismatch after swap");
    // A directory that was once the public plugin path is never recursively
    // deleted in this transaction. An old-path/open-directory writer can
    // create its first `.state` after every possible lstat; retaining the old
    // release is the only race-free choice without a writer-quiescence
    // protocol. A later explicit recovery/GC flow may inspect these paths.
    if (backup) recoveryPaths.add(backup);
    return {
      slug,
      action: destinationStat ? "updated" : "installed",
      version,
      digest,
      files,
      ...(recoveryPaths.size > 0
        ? { reason: "host state recovery retained", recoveryPaths: [...recoveryPaths] }
        : {}),
    };
  } catch (error) {
    if (stage && lstatIfPresent(stage)) {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* report original failure */ }
    }
    const ownsDestination = swapped && installationToken(destinationDir) === installationId;
    if (ownsDestination && stateMoved && backup && lstatIfPresent(path.join(destinationDir, ".state"))) {
      try {
        fs.renameSync(path.join(destinationDir, ".state"), path.join(backup, ".state"));
        stateMoved = false;
      } catch { /* do not delete the only surviving host-state inode */ }
    }
    if (ownsDestination && lstatIfPresent(destinationDir)) {
      // Never recursively delete a directory that has been visible at the
      // public plugin path: an external host writer can create `.state` after
      // any check. Atomically move our exact generation aside instead. This
      // preserves both the original state inode and any path-based write that
      // raced the swap; a later materialization can inspect the recovery tree.
      const recovery = path.join(
        path.dirname(destinationDir),
        `.${slug}.recovery-${installationId}`,
      );
      try {
        fs.renameSync(destinationDir, recovery);
        recoveryPaths.add(recovery);
        swapped = false;
      } catch {
        // Leave the live tree untouched if it cannot be moved safely.
      }
    }
    if (backup && !lstatIfPresent(destinationDir) && lstatIfPresent(backup)) {
      try { fs.renameSync(backup, destinationDir); } catch { /* surfaced by failed receipt */ }
    }
    if (backup && lstatIfPresent(backup)) recoveryPaths.add(backup);
    // Same-version non-exact content must not continue advertising itself as
    // current when repair fails. `.state` stays in place, but the package is
    // unavailable until a later exact materialization succeeds.
    if (version && digest && presentVersion === version && presentDigest !== digest) {
      invalidateFalseCurrent(destinationDir, version, digest);
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      slug,
      action: "failed",
      ...(version ? { version } : {}),
      ...(digest ? { digest } : {}),
      reason,
      ...(recoveryPaths.size > 0 ? { recoveryPaths: [...recoveryPaths] } : {}),
    };
  } finally {
    if (lock) releaseMaterializeLock(lock);
  }
}

export function materializeBuiltinPlugins(): MaterializeReceipt[] {
  const source = bundledPluginsRoot();
  let slugs: string[];
  try {
    assertRealDirectory(source, "bundled plugins root");
    slugs = fs
      .readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && validSlug(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[plugins] bundled packages unreadable:", source, reason);
    return [{ slug: "*", action: "failed", reason }];
  }

  const receipts = slugs.map((slug) => materializePluginRelease({
    slug,
    sourceDir: path.join(source, slug),
    destinationDir: path.join(installedPluginsRoot(), slug),
  }));
  for (const receipt of receipts) {
    if (receipt.action === "failed") console.error(`[plugins] ${receipt.slug} materialize failed:`, receipt.reason);
  }
  console.log(`[plugins] builtin packages — ${receipts.map((receipt) => `${receipt.slug}:${receipt.action}`).join(" ") || "(none bundled)"}`);
  return receipts;
}
