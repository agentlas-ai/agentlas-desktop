"use strict";

// The plugin's managed Python environment for RDKit.
//
// Where it lives: <plugin>/.state/python/<key>/ — `.state/` is the one host/user-owned entry of an installed plugin
// release (materialize keeps it across version swaps; integrity checks skip it). Nothing is written to the owner's
// site-packages, the Science kernel or a system Python.
//
// Which interpreter builds it, in order: the Python the Agentlas release ships (resources/python-runtime), the uv that
// Agentlas provisions for uvx servers (~/.agentlas/uv) or a uv on PATH (its Python downloads and wheel cache stay inside
// .state), then a python3 on PATH of a version RDKit publishes wheels for. Only binary wheels are installed; nothing is
// compiled. The install is a one-time, on-demand step like the uvx bootstrap: it starts when the server starts and a tool
// result reports its state until it is ready.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const CAPABILITIES = require("../capabilities.json");
const RUNTIME = CAPABILITIES.runtime;

function stateRoot() {
  // Tests point this at an owned temporary root; the host never sets it, so installed plugins use .state.
  const override = process.env.AGENTLAS_MEDCHEM_STATE_DIR;
  return override && path.isAbsolute(override) ? override : path.join(PLUGIN_ROOT, ".state", "python");
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function requirement() {
  return RUNTIME.packages[platformKey()] || RUNTIME.packages.default;
}

function environmentKey() {
  return `${requirement().replace(/[^A-Za-z0-9.]+/gu, "-")}-${platformKey()}`;
}

function environmentDir() {
  return path.join(stateRoot(), environmentKey());
}

function venvPython(directory) {
  return process.platform === "win32" ? path.join(directory, "Scripts", "python.exe") : path.join(directory, "bin", "python");
}

function isFile(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function readJson(file, maxBytes = 64 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

function pathDirs() {
  return String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
}

function onPath(names) {
  for (const dir of pathDirs()) for (const name of names) {
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** Interpreter and uv candidates in preference order; each is a plain description, probed by the installer. */
function interpreterCandidates() {
  const candidates = [];
  const explicit = process.env.AGENTLAS_MEDCHEM_PYTHON;
  if (explicit && path.isAbsolute(explicit) && isFile(explicit)) candidates.push({ kind: "python", source: "explicit", command: explicit });
  const bundledRel = process.platform === "win32" ? ["python-runtime", "python.exe"] : ["python-runtime", "bin", "python3"];
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, ...bundledRel);
    if (isFile(bundled)) candidates.push({ kind: "python", source: "agentlas-bundled", command: bundled });
  }
  const home = os.homedir();
  const uvExe = process.platform === "win32" ? "uv.exe" : "uv";
  const agentlasUv = [path.join(home, ".agentlas", "uv", "bin", uvExe)];
  const prepared = readJson(path.join(home, ".agentlas", "uv", "prepared.json"), 1024);
  if (prepared && typeof prepared.directory === "string" && /^runtime-[A-Za-z0-9_-]+$/u.test(prepared.directory)) {
    agentlasUv.push(path.join(home, ".agentlas", "uv", prepared.directory, "bin", uvExe));
  }
  for (const candidate of agentlasUv) if (isFile(candidate)) { candidates.push({ kind: "uv", source: "agentlas-uv", command: candidate }); break; }
  const pathUv = onPath([uvExe]);
  if (pathUv) candidates.push({ kind: "uv", source: "path-uv", command: pathUv });
  const system = onPath(process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"]);
  if (system) candidates.push({ kind: "python", source: "path-python", command: system });
  return candidates;
}

function receipt() {
  const directory = environmentDir();
  const ready = readJson(path.join(directory, "ready.json"));
  if (!ready || ready.requirement !== requirement() || !isFile(venvPython(directory))) return null;
  return ready;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function lockState() {
  const owner = readJson(path.join(stateRoot(), "install.lock", "owner.json"));
  if (!owner) return fs.existsSync(path.join(stateRoot(), "install.lock")) ? { stale: true } : null;
  const ageMs = Date.now() - Date.parse(owner.startedAt || 0);
  const alive = pidAlive(owner.pid);
  return { ...owner, ageMs, alive, stale: !alive || ageMs > RUNTIME.installTimeoutMs + 60_000 };
}

function status() {
  const ready = receipt();
  if (ready) return { state: "ready", requirement: requirement(), rdkitVersion: ready.rdkitVersion, python: ready.python, packages: ready.packages, installedAt: ready.installedAt, source: ready.source };
  const lock = lockState();
  if (lock && !lock.stale) return { state: "installing", requirement: requirement(), step: readJson(path.join(stateRoot(), "progress.json"))?.step ?? "starting", startedAt: lock.startedAt, source: lock.source ?? null, oneTime: true };
  const failed = readJson(path.join(stateRoot(), `failed-${environmentKey()}.json`));
  if (failed) return { state: "failed", requirement: requirement(), code: failed.code, detail: failed.detail, failedAt: failed.failedAt, attempts: failed.attempts };
  return { state: "absent", requirement: requirement(), candidates: interpreterCandidates().map((item) => item.source) };
}

/**
 * Start the one-time install when it is not ready and no live installer owns the lock. The installer is a detached
 * child so it can finish even if this server stops between turns; it removes its own staging on failure.
 */
function ensureInstallStarted({ force = false } = {}) {
  const current = status();
  if (current.state === "ready" || current.state === "installing") return current;
  if (current.state === "failed" && !force) {
    const age = Date.now() - Date.parse(current.failedAt || 0);
    if (age < RUNTIME.retryAfterFailureMs) return current;
  }
  const candidates = interpreterCandidates();
  if (!candidates.length) return { state: "failed", requirement: requirement(), code: "python-interpreter-unavailable", detail: "No Agentlas-bundled Python, uv or python3 found." };
  fs.mkdirSync(stateRoot(), { recursive: true });
  // The lock is taken here, before the installer exists, so two servers (or two calls) never start two installers:
  // mkdir is atomic; a live owner keeps it, a dead or overdue one is replaced.
  const lockDir = path.join(stateRoot(), "install.lock");
  try { fs.mkdirSync(lockDir); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const lock = lockState();
    if (lock && !lock.stale) return status();
    fs.rmSync(lockDir, { recursive: true, force: true });
    try { fs.mkdirSync(lockDir); } catch { return status(); }
  }
  const plan = {
    schema: "agentlas.medchem.install-plan/v1",
    stateRoot: stateRoot(),
    environmentDir: environmentDir(),
    environmentKey: environmentKey(),
    requirement: requirement(),
    pythonRange: RUNTIME.python,
    acceptedMinor: RUNTIME.acceptedPythonMinors,
    indexUrl: RUNTIME.indexUrl,
    timeoutMs: RUNTIME.installTimeoutMs,
    candidates,
  };
  const child = spawn(process.execPath, [path.join(__dirname, "install-rdkit.cjs"), JSON.stringify(plan)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1" },
  });
  child.unref();
  const ownerFile = path.join(lockDir, "owner.json");
  const temporary = `${ownerFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), requirement: requirement(), source: candidates[0].source }), { mode: 0o600 });
  fs.renameSync(temporary, ownerFile);
  return { state: "installing", requirement: requirement(), step: "starting", startedAt: new Date().toISOString(), oneTime: true };
}

async function waitReady(timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const current = status();
    if (current.state !== "installing" || Date.now() >= end) return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Run one worker request in the managed environment. */
function runWorker(request, { timeoutMs }) {
  const ready = receipt();
  if (!ready) return Promise.resolve({ ok: false, error: { code: "medchem-runtime-not-ready" } });
  const python = venvPython(environmentDir());
  return new Promise((resolve) => {
    const child = spawn(python, ["-I", "-B", path.join(__dirname, "medchem_worker.py")], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: environmentDir(),
      env: { PATH: process.env.PATH || "", HOME: os.homedir(), PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONIOENCODING: "utf-8", ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows" } : {}) },
    });
    const out = [];
    let outBytes = 0;
    const err = [];
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish({ ok: false, error: { code: "medchem-worker-timeout" } }); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > 64 * 1024 * 1024) { try { child.kill("SIGKILL"); } catch {} finish({ ok: false, error: { code: "medchem-worker-output-too-large" } }); return; }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => { if (err.length < 64) err.push(chunk); });
    child.once("error", () => finish({ ok: false, error: { code: "medchem-worker-spawn-failed" } }));
    child.once("close", (code) => {
      const text = Buffer.concat(out).toString("utf8");
      try { finish(JSON.parse(text)); }
      catch { finish({ ok: false, error: { code: "medchem-worker-output-invalid", exitCode: code, stderr: Buffer.concat(err).toString("utf8").slice(-400) } }); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

module.exports = { status, ensureInstallStarted, waitReady, runWorker, environmentDir, stateRoot, requirement, interpreterCandidates, venvPython, platformKey };
