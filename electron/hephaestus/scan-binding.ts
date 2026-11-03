/**
 * A security scan result belongs to the exact package content it scanned.
 *
 * The build scans the package once, then the engine fills derived files (`contract complete`), the model repairs
 * contract blockers in targeted rounds, and `cards migrate --overwrite` writes the local cards. The first scan used to be
 * returned as the build's final scan whatever happened to the files after it, so repaired or added content showed
 * the earlier PASS. Now the digest of the package tree is taken before the scan and again at the end: equal digests keep the
 * result; different ones rerun the scan on the final tree, and a scan that cannot be rerun (or a tree still changing)
 * is `unverified`, which every consumer already reads as "not passing" (renderer/lib/build-scan.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Host-written bookkeeping and tool noise: not package content, written after the scan by design. */
const SKIPPED_NAMES = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db"]);
const SKIPPED_RELATIVE = new Set([".agentlas/interview-receipt.json"]);
const MAX_FILES = 20_000;
const MAX_HASHED_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 24;

/**
 * sha256 over every file's relative path and content (symlinks: their target text). `null` when the tree cannot be
 * measured exactly (unreadable entry, too many files): the caller treats an unmeasurable tree as changed.
 */
export function packageContentDigest(root: string): string | null {
  const hash = createHash("sha256");
  let files = 0;
  const walk = (dir: string, relative: string, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIPPED_NAMES.has(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (SKIPPED_RELATIVE.has(rel)) continue;
      const full = path.join(dir, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          hash.update(`L\0${rel}\0${fs.readlinkSync(full)}\0`);
        } else if (entry.isDirectory()) {
          hash.update(`D\0${rel}\0`);
          if (!walk(full, rel, depth + 1)) return false;
        } else if (entry.isFile()) {
          files += 1;
          if (files > MAX_FILES) return false;
          const stat = fs.statSync(full);
          if (stat.size > MAX_HASHED_BYTES) return false;
          hash.update(`F\0${rel}\0${stat.size}\0`);
          hash.update(fs.readFileSync(full));
          hash.update("\0");
        }
      } catch {
        return false;
      }
    }
    return true;
  };
  return walk(root, "", 0) ? hash.digest("hex") : null;
}

export interface BoundScan {
  /** The scan result to report. Never a result for content other than `digest`'s. */
  scan: unknown;
  /** Digest of the package content the reported scan is bound to; null when it is not bound to anything measurable. */
  digest: string | null;
  /** Machine code of what happened to the first scan: kept, rescanned, or marked unverified. */
  binding: "unchanged" | "rescanned" | "unverified_changed" | "unverified_rescan_failed" | "not_applicable";
}

function isUnverified(scan: unknown): boolean {
  return !!scan && typeof scan === "object" && !Array.isArray(scan) && (scan as { status?: unknown }).status === "unverified";
}

/**
 * Settle the first scan against the package as it is now.
 * - `scannedDigest` is the digest taken BEFORE the first scan ran (a change during the scan shows up too).
 * - `rescan` scans the current tree and returns its JSON (or null / throws when it cannot).
 * - `aborted` says the build was cancelled: no new scan starts, the old result is no longer vouched for.
 */
export async function settleScanAgainstPackage(input: {
  scan: unknown;
  scannedDigest: string | null;
  root: string;
  rescan: () => Promise<unknown>;
  aborted?: () => boolean;
  digestOf?: (root: string) => string | null;
}): Promise<BoundScan> {
  const digestOf = input.digestOf ?? packageContentDigest;
  // A scan that already says "unverified" claims nothing about any content.
  if (isUnverified(input.scan)) return { scan: input.scan, digest: null, binding: "not_applicable" };
  const before = digestOf(input.root);
  if (before !== null && before === input.scannedDigest) return { scan: input.scan, digest: before, binding: "unchanged" };
  const unverified = (binding: BoundScan["binding"], reason: string): BoundScan => ({
    scan: { status: "unverified", reason },
    digest: null,
    binding,
  });
  if (input.aborted?.()) return unverified("unverified_changed", "package changed after scan");
  let rescanned: unknown;
  try {
    rescanned = await input.rescan();
  } catch (error) {
    return unverified("unverified_rescan_failed", `package changed after scan; rescan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (rescanned === null || rescanned === undefined) return unverified("unverified_rescan_failed", "package changed after scan; rescan returned no result");
  if (isUnverified(rescanned)) return { scan: rescanned, digest: null, binding: "unverified_rescan_failed" };
  const after = digestOf(input.root);
  // The tree moved again while the rescan ran: the result cannot be tied to one content.
  if (after === null) return unverified("unverified_changed", "package content could not be measured after the security scan");
  if (after !== before) return unverified("unverified_changed", "package kept changing during the security scan");
  return { scan: rescanned, digest: after, binding: "rescanned" };
}
