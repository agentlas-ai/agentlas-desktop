#!/usr/bin/env node
"use strict";

// One-time installer for the medchem plugin's managed RDKit environment. Started detached by python-env.cjs with a JSON
// plan. It owns <state>/install.lock while it runs, builds the environment in a staging directory beside the target,
// verifies `import rdkit`, and only then renames staging into place and writes ready.json. Any failure removes its
// staging, records failed-<key>.json and releases the lock. Only binary wheels; nothing is compiled.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const plan = JSON.parse(process.argv[2] || "{}");
if (plan.schema !== "agentlas.medchem.install-plan/v1" || !path.isAbsolute(plan.stateRoot || "") || !path.isAbsolute(plan.environmentDir || "")) process.exit(2);

const lockDir = path.join(plan.stateRoot, "install.lock");
const progressFile = path.join(plan.stateRoot, "progress.json");
const failedFile = path.join(plan.stateRoot, `failed-${plan.environmentKey}.json`);
const logFile = path.join(plan.stateRoot, "install.log");
const deadline = Date.now() + plan.timeoutMs;
const home = os.homedir();
const scrub = (value) => String(value).split(home).join("~");

function writeJson(file, value) {
  const temporary = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function log(line) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${scrub(line)}\n`, { mode: 0o600 });
    if (fs.statSync(logFile).size > 256 * 1024) fs.writeFileSync(logFile, fs.readFileSync(logFile, "utf8").slice(-128 * 1024));
  } catch { /* logging is best effort */ }
}
function progress(step, source) { try { writeJson(progressFile, { step, source, at: new Date().toISOString() }); } catch {} }

/** The starter (python-env.cjs) took the lock and names this process as its owner; adopt it only when that is so. */
async function acquire() {
  const ownerFile = path.join(lockDir, "owner.json");
  for (let waited = 0; waited < 5000; waited += 100) {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); } catch {}
    if (owner) return owner.pid === process.pid;
    if (!fs.existsSync(lockDir)) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function run(command, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    const tail = [];
    const keep = (chunk) => { tail.push(chunk); if (tail.length > 40) tail.shift(); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: -1, output: String(error.message) }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, output: Buffer.concat(tail).toString("utf8").slice(-2000) }); });
  });
}

const venvPython = (directory) => (process.platform === "win32" ? path.join(directory, "Scripts", "python.exe") : path.join(directory, "bin", "python"));
const baseEnv = () => ({ PATH: process.env.PATH || "", HOME: home, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1", PIP_NO_CACHE_DIR: "1",
  ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows", TEMP: process.env.TEMP || "", TMP: process.env.TMP || "" } : { TMPDIR: process.env.TMPDIR || "/tmp" }) });

async function pythonMinor(command) {
  const probe = await run(command, ["-I", "-c", "import sys;print('%d.%d' % sys.version_info[:2])"], baseEnv(), 20_000);
  return probe.code === 0 ? probe.output.trim().split(/\s+/).pop() : null;
}

async function build(candidate, staging) {
  const env = baseEnv();
  if (candidate.kind === "uv") {
    const uvEnv = { ...env, UV_CACHE_DIR: path.join(plan.stateRoot, "uv-cache"), UV_PYTHON_INSTALL_DIR: path.join(plan.stateRoot, "uv-python"), UV_NO_CONFIG: "1" };
    progress("create-environment", candidate.source);
    const venv = await run(candidate.command, ["venv", "--quiet", "--no-project", "--python", plan.pythonRange, staging], uvEnv, 300_000);
    if (venv.code !== 0) return { ok: false, code: "uv-venv-failed", detail: venv.output };
    progress("install-rdkit", candidate.source);
    const install = await run(candidate.command, ["pip", "install", "--quiet", "--no-config", "--python", venvPython(staging), "--only-binary", ":all:", "--index-url", plan.indexUrl, plan.requirement], uvEnv, plan.timeoutMs);
    fs.rmSync(uvEnv.UV_CACHE_DIR, { recursive: true, force: true });
    if (install.code !== 0) return { ok: false, code: "uv-pip-install-failed", detail: install.output };
    return { ok: true, python: { source: candidate.source } };
  }
  const minor = await pythonMinor(candidate.command);
  if (!minor || !plan.acceptedMinor.includes(minor)) return { ok: false, code: "python-version-unsupported", detail: `python ${minor ?? "unknown"}` };
  progress("create-environment", candidate.source);
  const venv = await run(candidate.command, ["-I", "-m", "venv", staging], env, 300_000);
  if (venv.code !== 0) return { ok: false, code: "venv-failed", detail: venv.output };
  progress("install-rdkit", candidate.source);
  const install = await run(venvPython(staging), ["-I", "-m", "pip", "install", "--quiet", "--no-cache-dir", "--only-binary=:all:", "--index-url", plan.indexUrl, plan.requirement], env, plan.timeoutMs);
  if (install.code !== 0) return { ok: false, code: "pip-install-failed", detail: install.output };
  return { ok: true, python: { source: candidate.source, version: minor } };
}

async function main() {
  if (!(await acquire())) { log("lock not owned by this installer"); return; }
  // A previous installer that was killed leaves its staging behind; only this lock owner removes those, by exact name shape.
  for (const name of fs.readdirSync(plan.stateRoot)) {
    if (name.startsWith(`${path.basename(plan.environmentDir)}.staging-`) && /\.staging-[a-f0-9]{10}$/u.test(name)) fs.rmSync(path.join(plan.stateRoot, name), { recursive: true, force: true });
  }
  let attempts = [];
  try {
    for (const candidate of plan.candidates) {
      if (Date.now() > deadline) break;
      const staging = `${plan.environmentDir}.staging-${crypto.randomBytes(5).toString("hex")}`;
      log(`try ${candidate.source}`);
      try {
        const built = await build(candidate, staging);
        if (!built.ok) { attempts.push({ source: candidate.source, code: built.code, detail: scrub(built.detail || "").slice(-600) }); log(`${candidate.source} ${built.code}`); continue; }
        progress("verify", candidate.source);
        const verify = await run(venvPython(staging), ["-I", "-c", "import json,sys,rdkit,numpy,PIL; from rdkit.Chem import QED, FilterCatalog; from rdkit.Chem.MolStandardize import rdMolStandardize; print(json.dumps({'rdkit': rdkit.__version__, 'numpy': numpy.__version__, 'pillow': PIL.__version__, 'python': sys.version.split()[0]}))"], baseEnv(), 120_000);
        if (verify.code !== 0) { attempts.push({ source: candidate.source, code: "rdkit-import-failed", detail: scrub(verify.output).slice(-600) }); continue; }
        const versions = JSON.parse(verify.output.trim().split(/\r?\n/).pop());
        fs.rmSync(plan.environmentDir, { recursive: true, force: true });
        fs.renameSync(staging, plan.environmentDir);
        writeJson(path.join(plan.environmentDir, "ready.json"), {
          schema: "agentlas.medchem.runtime-receipt/v1", requirement: plan.requirement, rdkitVersion: versions.rdkit,
          python: { version: versions.python, source: candidate.source }, packages: { rdkit: versions.rdkit, numpy: versions.numpy, pillow: versions.pillow },
          source: candidate.source, indexUrl: plan.indexUrl, onlyBinaryWheels: true, installedAt: new Date().toISOString(),
        });
        fs.rmSync(failedFile, { force: true });
        log(`ready rdkit ${versions.rdkit} via ${candidate.source}`);
        return;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(failedFile, "utf8")); } catch {}
    writeJson(failedFile, { code: attempts.length ? attempts[attempts.length - 1].code : "no-candidate-succeeded", detail: attempts, failedAt: new Date().toISOString(), attempts: (previous?.attempts ?? 0) + 1 });
  } catch (error) {
    writeJson(failedFile, { code: "installer-error", detail: scrub(error && error.message), failedAt: new Date().toISOString(), attempts: 1 });
  } finally {
    fs.rmSync(progressFile, { force: true });
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

main().catch(() => process.exit(1));
