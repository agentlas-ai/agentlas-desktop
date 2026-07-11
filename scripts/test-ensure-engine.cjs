#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const ensureScript = path.join(root, "scripts", "ensure-engine.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-ensure-engine-"));
const seed = path.join(temp, "seed");
const remote = path.join(temp, "Agentlas-OS.git");

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function must(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result;
}

function git(cwd, ...args) {
  return must("git", args, { cwd });
}

function writeRuntime(version) {
  fs.mkdirSync(path.join(seed, "agentlas_cloud"), { recursive: true });
  fs.writeFileSync(path.join(seed, "agentlas_cloud", "__main__.py"), "# fixture\n", "utf8");
  fs.writeFileSync(path.join(seed, "manifest.json"), `${JSON.stringify({ version }, null, 2)}\n`, "utf8");
}

function ensure(dir, ref) {
  return run(process.execPath, [ensureScript], {
    cwd: root,
    env: {
      ...process.env,
      HEPHAESTUS_REPO: remote,
      HEPHAESTUS_REF: ref,
      HEPHAESTUS_DIR: dir,
    },
  });
}

try {
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "release-test@agentlas.local");
  git(seed, "config", "user.name", "Agentlas Release Test");
  writeRuntime("1.0.0");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "runtime v1.0.0");
  git(seed, "tag", "v1.0.0");
  writeRuntime("1.0.1");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "runtime v1.0.1");
  git(seed, "tag", "v1.0.1");
  must("git", ["init", "-q", "--bare", remote]);
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main", "--tags");

  const existing = path.join(temp, "existing");
  must("git", ["clone", "-q", "--branch", "v1.0.0", remote, existing]);
  const upgraded = ensure(existing, "v1.0.1");
  assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(existing, "manifest.json"), "utf8")).version, "1.0.1");
  assert.equal(
    git(existing, "rev-parse", "HEAD^{commit}").stdout.trim(),
    git(existing, "rev-parse", "v1.0.1^{commit}").stdout.trim(),
  );

  const alreadyPinned = ensure(existing, "v1.0.1");
  assert.equal(alreadyPinned.status, 0, alreadyPinned.stderr || alreadyPinned.stdout);
  assert.match(alreadyPinned.stdout, /already pinned/);

  const dirtyManifest = path.join(existing, "manifest.json");
  const dirtyBytes = `${fs.readFileSync(dirtyManifest, "utf8")} `;
  fs.writeFileSync(dirtyManifest, dirtyBytes, "utf8");
  const refused = ensure(existing, "v1.0.0");
  assert.notEqual(refused.status, 0, "dirty embedded runtimes must fail closed");
  assert.match(refused.stderr, /local changes; refusing to overwrite/);
  assert.equal(fs.readFileSync(dirtyManifest, "utf8"), dirtyBytes, "dirty runtime bytes must remain untouched");

  const fresh = path.join(temp, "fresh");
  const cloned = ensure(fresh, "v1.0.0");
  assert.equal(cloned.status, 0, cloned.stderr || cloned.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, "manifest.json"), "utf8")).version, "1.0.0");

  const unverifiable = path.join(temp, "unverifiable");
  fs.mkdirSync(path.join(unverifiable, "agentlas_cloud"), { recursive: true });
  fs.writeFileSync(path.join(unverifiable, "agentlas_cloud", "__main__.py"), "# fixture\n", "utf8");
  const rejected = ensure(unverifiable, "v1.0.0");
  assert.notEqual(rejected.status, 0, "a sentinel without Git provenance must fail closed");
  assert.match(rejected.stderr, /not a verifiable Git checkout/);

  console.log("ensure-engine pin and dirty-checkout contract: PASS");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
