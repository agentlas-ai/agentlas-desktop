import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeBorrowedOwnerScopeKey,
  borrowedOwnerPartitionDirectory,
  DEVICE_LOCAL_BORROWED_OWNER_SCOPE,
} from "./borrowed-owner-scope";

const HUB_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function normalizeHubMemorySlug(value: unknown): string | null {
  const slug = typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  return HUB_SLUG_RE.test(slug) ? slug : null;
}

function assertDirectoryChain(target: string, create: boolean): boolean {
  const home = path.resolve(os.homedir());
  const resolved = path.resolve(target);
  const relative = path.relative(home, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let cursor = home;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (!create) return false;
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (process.platform !== "win32") {
      try { fs.chmodSync(cursor, 0o700); } catch {}
    }
  }
  return cursor === resolved;
}

export function activeHubMemoryNestPaths(slugValue: unknown): {
  slug: string;
  ownerScopeKey: string;
  writableMemoryRoot: string;
  readableMemoryRoots: string[];
} | null {
  const slug = normalizeHubMemorySlug(slugValue);
  if (!slug) return null;
  const ownerScopeKey = activeBorrowedOwnerScopeKey();
  const agentRoot = path.join(os.homedir(), ".agentlas", "networking", "hub-agents", slug);
  const flatMemoryRoot = path.join(agentRoot, "memory");
  if (ownerScopeKey === DEVICE_LOCAL_BORROWED_OWNER_SCOPE) {
    // No Hub account is signed in, so there is nothing to isolate. The flat
    // <slug>/memory root IS the canonical per-agent drawer, shared byte-for-byte
    // with the OS/terminal Python surfaces (memory_hook, one_workspace, and
    // workforce/local_registry all resolve <slug>/memory). Writing to an owner
    // partition here forked the same agent's experience across surfaces, so
    // neither Desktop nor the CLI could recall the other's (2026-08-12
    // adversarial set 3). Keep reading the previously owner-partitioned
    // device-local copy so nothing already accumulated is lost.
    const legacyOwnerRoot = path.join(
      agentRoot,
      "owners",
      borrowedOwnerPartitionDirectory(ownerScopeKey),
      "memory",
    );
    return {
      slug,
      ownerScopeKey,
      writableMemoryRoot: flatMemoryRoot,
      readableMemoryRoots: [flatMemoryRoot, legacyOwnerRoot],
    };
  }
  // A Hub account is signed in: isolate its experience under an opaque owner
  // partition (raw Hub IDs never touch the filesystem). The Python CLI surfaces
  // carry no Hub-account identity and intentionally stay on the flat root, which
  // a Hub login never adopts or reads as this account's data.
  const ownerDirectory = borrowedOwnerPartitionDirectory(ownerScopeKey);
  const writableMemoryRoot = path.join(agentRoot, "owners", ownerDirectory, "memory");
  return { slug, ownerScopeKey, writableMemoryRoot, readableMemoryRoots: [writableMemoryRoot] };
}

export function ensureActiveHubMemoryNest(slugValue: unknown): string | null {
  const paths = activeHubMemoryNestPaths(slugValue);
  if (!paths || !assertDirectoryChain(paths.writableMemoryRoot, true)) return null;
  return paths.writableMemoryRoot;
}

export function readableActiveHubMemoryNestRoots(slugValue: unknown): string[] {
  const paths = activeHubMemoryNestPaths(slugValue);
  if (!paths) return [];
  return paths.readableMemoryRoots.filter((root) => assertDirectoryChain(root, false));
}
