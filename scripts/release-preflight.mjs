#!/usr/bin/env node
// Runs the deterministic release-contract gates the way the tag CI runs them,
// BEFORE a tag is pushed.
//
// Why this exists: the release contract asserts things about the pinned
// Agentlas OS runtime, but test-update-release-contract.cjs reads that runtime
// from ./Hephaestus — a git-ignored directory that is, on a developer machine, a
// live working checkout with uncommitted changes. `ensure:engine` rightly
// refuses to overwrite it, so the local copy drifts from the pin and the gate
// reports a failure that has nothing to do with the change under test. A gate
// that cries wolf locally stops being run locally, so release-contract misses
// (a missing README or CHANGELOG section, most often) are only ever caught by
// CI twenty minutes after the tag is pushed — over and over.
//
// So this resolves the pin into an immutable per-commit cache and never touches
// the developer's checkout. Same answer as CI, no work destroyed.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = pkg.agentlasBundledRuntimeSource;

function fail(message) {
  console.error(`[release-preflight] ${message}`);
  process.exit(1);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  return result.status === 0;
}

if (!source?.repository || !source?.ref || !/^[0-9a-f]{40}$/.test(source.commit ?? "")) {
  fail("package.json agentlasBundledRuntimeSource must pin repository, ref, and a full commit.");
}

// Per-commit path: a cache entry can never be stale for the commit it names, so
// there is no invalidation to get wrong.
const cacheRoot = join(root, "node_modules", ".cache", "agentlas-pinned-runtime");
const pinnedRoot = join(cacheRoot, source.commit);

function checkoutIsPinned(dir) {
  if (!existsSync(join(dir, "manifest.json"))) return false;
  return capture("git", ["-C", dir, "rev-parse", "HEAD^{commit}"]) === source.commit;
}

let runtimeRoot = null;

// Fast path: the developer's own checkout already sits exactly on the pin, so
// use it rather than spending a clone.
const embedded = join(root, "Hephaestus");
if (checkoutIsPinned(embedded) && !capture("git", ["-C", embedded, "status", "--porcelain"])) {
  runtimeRoot = embedded;
  console.log(`[release-preflight] embedded checkout is clean and on ${source.ref}`);
} else if (checkoutIsPinned(pinnedRoot)) {
  runtimeRoot = pinnedRoot;
  console.log(`[release-preflight] reusing cached ${source.ref}`);
} else {
  console.log(`[release-preflight] fetching ${source.ref} into an immutable cache (the working checkout is left alone)`);
  mkdirSync(cacheRoot, { recursive: true });
  spawnSync("rm", ["-rf", pinnedRoot]);
  if (!run("git", ["clone", "--quiet", "--depth", "1", "--branch", source.ref, source.repository, pinnedRoot])) {
    fail(`could not clone ${source.repository}@${source.ref}. Network access is required the first time a pin changes.`);
  }
  // The ref is a moving name; the commit is the contract. Fail closed on drift.
  const actual = capture("git", ["-C", pinnedRoot, "rev-parse", "HEAD^{commit}"]);
  if (actual !== source.commit) {
    fail(`${source.ref} resolves to ${actual}, but package.json pins ${source.commit}.`);
  }
  runtimeRoot = pinnedRoot;
}

const manifestVersion = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")).version;
console.log(`[release-preflight] runtime ${manifestVersion} (${source.commit.slice(0, 8)})`);

// The contract gate imports from dist/, so a stale build would test stale code.
if (!run("npm", ["run", "build:electron"], { cwd: root })) {
  fail("build:electron failed; the release contract reads dist/.");
}

const env = { ...process.env, HEPHAESTUS_RUNTIME_ROOT: runtimeRoot };
if (!run("node", ["scripts/test-update-release-contract.cjs"], { cwd: root, env })) {
  fail(
    `release contract failed for v${pkg.version}.\n` +
      "  A tag pushed now would fail the macOS and Linux gates the same way.\n" +
      "  Most often this means README.md and CHANGELOG.md have no section for the\n" +
      "  current version bound to the pinned runtime.",
  );
}

console.log(`[release-preflight] PASS — v${pkg.version} satisfies the release contract`);
