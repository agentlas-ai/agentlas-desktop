#!/usr/bin/env node
"use strict";

// Release operations keep child output in runner-owned temporary storage.
// Only a typed stage and process outcome cross the public Actions log boundary.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync, execFileSync } = require("node:child_process");

function portableCommand(command, args, platform = process.platform, executable = process.execPath, env = process.env) {
  if (/^node(?:\.exe)?$/i.test(command)) return { command: executable, args };
  if (platform !== "win32" || !/^(?:npm|npx)(?:\.cmd)?$/i.test(command)) return { command, args };
  // Execute npm's JS entry directly: .cmd cannot be spawned without a shell,
  // and a shell would reinterpret metacharacters in verifier arguments.
  const entry = /^npx/i.test(command) ? "npx-cli.js" : "npm-cli.js";
  const candidates = [env.npm_execpath, path.join(path.dirname(executable), "node_modules", "npm", "bin", entry)];
  const script = candidates.find(candidate => candidate && path.isAbsolute(candidate)
    && path.basename(candidate).toLowerCase() === entry && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (!script) throw Object.assign(new Error("npm entry unavailable"), { code: "ENOENT" });
  return { command: executable, args: [script, ...args] };
}

function windowsSystemCommand(command, env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT;
  if (typeof root !== "string" || !path.win32.isAbsolute(root)
    || !/^[A-Za-z]:[\\/]/.test(root)
    || !/^(?:whoami|icacls|taskkill)\.exe$/.test(command)) {
    throw new Error("Windows system command unavailable");
  }
  return path.win32.join(root, "System32", command);
}

let privateLogFile = null;

function privateLog() {
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary || !path.isAbsolute(temporary)) throw new Error("runner temporary directory required");
  const root = fs.realpathSync(temporary);
  if (!fs.statSync(root).isDirectory()) throw new Error("runner temporary directory invalid");
  const directory = fs.mkdtempSync(path.join(root, "agentlas-release-private-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "output.log");
  privateLogFile = file;
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    if (process.platform === "win32") {
      // Windows chmod does not enforce POSIX owner bits. Remove inherited ACLs
      // and grant only this runner identity access to the temporary directory/file.
      const identity = execFileSync(windowsSystemCommand("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", stdio: ["ignore", "pipe", fd] });
      const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
      if (!sid) throw new Error("runner identity unavailable");
      execFileSync(windowsSystemCommand("icacls.exe"), [directory, "/reset"], { stdio: ["ignore", fd, fd] });
      execFileSync(windowsSystemCommand("icacls.exe"), [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: ["ignore", fd, fd] });
      execFileSync(windowsSystemCommand("icacls.exe"), [file, "/reset"], { stdio: ["ignore", fd, fd] });
      execFileSync(windowsSystemCommand("icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${sid}:F`], { stdio: ["ignore", fd, fd] });
    } else if ((fs.fstatSync(fd).mode & 0o777) !== 0o600 || (fs.statSync(directory).mode & 0o777) !== 0o700) {
      throw new Error("private output permissions unavailable");
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

async function stopProcessTree(child, signal, fd) {
  const record = error => { try { fs.writeSync(fd, String(error?.stack || error)); } catch {} };
  const exists = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM" && pid < 0 && process.platform !== "win32") {
        // Some hosts deny kill(0) after group teardown. Confirm absence against
        // the OS group list rather than treating a permission error as success.
        const groups = execFileSync("/bin/ps", ["-axo", "pgid="], {
          encoding: "utf8", stdio: ["ignore", "pipe", fd], timeout: 250, maxBuffer: 1024 * 1024,
        });
        return groups.split(/\r?\n/).some(group => /^\s*\d+\s*$/.test(group) && Number(group.trim()) === -pid);
      }
      throw error;
    }
  };
  const waitUntilGone = async (pid, milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (exists(pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return true;
  };
  if (process.platform === "win32") {
    // /T terminates descendants too; a root-only kill cannot confirm cleanup.
    try {
      execFileSync(windowsSystemCommand("taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", fd, fd], windowsHide: true, timeout: 2000,
      });
      return await waitUntilGone(child.pid, 500);
    } catch (error) {
      record(error);
      try { child.kill(signal); } catch {}
      return false;
    }
  }
  const group = -child.pid;
  try { process.kill(group, signal); }
  catch (error) { if (error.code === "ESRCH" || !exists(group)) return true; throw error; }
  if (await waitUntilGone(group, 2000)) return true;
  try { process.kill(group, "SIGKILL"); }
  catch (error) { if (error.code === "ESRCH" || !exists(group)) return true; throw error; }
  return await waitUntilGone(group, 500);
}

// On failure, only typed facts from public build scripts cross the public log boundary: the npm script that was
// running, the progress markers printed by public build scripts, and (inside the build:electron phase only, where no
// private verifier runs) the first TypeScript diagnostics for product source files and the first error line.
const PUBLIC_MARKER = /^((?:\[(?:release-preflight|science-release-catalog|copy-builtin-plugins|sandbox-preloads|computer-use)\] |One Briefing contract verified|app screen routes verified)[\x20-\x7e]{0,160})$/;
const NPM_SCRIPT = /^> agentlas-desktop@\S+ ([A-Za-z0-9:_-]{1,64})$/;
const TS_DIAGNOSTIC = /^((?:electron|shared|renderer)\/[A-Za-z0-9._@\/-]{1,120}\(\d+,\d+\): error TS\d+: [\x20-\x7e]{0,200})$/;
const ERROR_LINE = /^((?:[A-Za-z]*Error|FATAL ERROR|fatal): [\x20-\x7e]{0,200})$/;
const ABSOLUTE_PATH = /(^|[\s"'(=:])((?:\/[A-Za-z0-9._@+-]+){2,})/g;
const scrub = text => text.replace(ABSOLUTE_PATH, "$1<path>").slice(0, 200);
// The owned release-gate runner prints one JSON line per gate. Only counts and generic snake_case failure codes cross
// the public log boundary: never a gate name, a path, a stack frame or any other text of the private verifiers.
const GATE_CODE = /^[a-z][a-z0-9_]{2,80}$/;
function collectCodes(value, codes, depth = 0) {
  if (depth > 6 || !value || typeof value !== "object") return;
  if (typeof value.code === "string" && GATE_CODE.test(value.code)) codes.add(value.code);
  for (const inner of Object.values(value)) if (inner && typeof inner === "object") collectCodes(inner, codes, depth + 1);
}
function ownedGateHints(text) {
  let gates = 0;
  let passed = 0;
  let firstFailed = null;
  const codes = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (GATE_CODE.test(line)) { codes.add(line); continue; }
    if (line.length > 20000 || line[0] !== "{" || line[line.length - 1] !== "}") continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (typeof value?.releaseGate === "string") {
      gates += 1;
      if (value.result === "passed") passed += 1;
      else if (value.result === "failed" && firstFailed === null) firstFailed = gates;
    }
    collectCodes(value, codes);
  }
  if (!gates && !codes.size) return "";
  const parts = [];
  if (gates) parts.push(`gates_seen=${gates} gates_passed=${passed}`);
  if (firstFailed !== null) parts.push(`first_failed_index=${firstFailed}`);
  if (codes.size) parts.push(`codes=${[...codes].slice(0, 6).join(",")}`);
  return parts.join(" ");
}
function failureHints(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return ""; }
  let script = null;
  let inBuild = false;
  const markers = [];
  const diagnostics = [];
  let firstError = null;
  for (const line of text.split(/\r?\n/)) {
    const s = NPM_SCRIPT.exec(line);
    if (s) { script = s[1]; inBuild = s[1] === "build:electron"; continue; }
    const m = PUBLIC_MARKER.exec(line);
    if (m) { markers.push(m[1]); continue; }
    if (!inBuild) continue;
    const d = TS_DIAGNOSTIC.exec(line);
    if (d) { if (diagnostics.length < 3) diagnostics.push(d[1]); continue; }
    const e = ERROR_LINE.exec(line);
    if (e && !firstError) firstError = e[1];
  }
  const owned = ownedGateHints(text);
  const parts = [];
  if (script) parts.push(`script=${script}`);
  if (markers.length) parts.push(`markers=${markers.slice(-6).map(scrub).join(" | ")}`);
  if (diagnostics.length) parts.push(`ts=${diagnostics.map(scrub).join(" | ")}`);
  if (firstError) parts.push(`error=${scrub(firstError)}`);
  if (owned) parts.push(owned);
  return parts.join(" ");
}

// The owned release-gate runner (MAC_PRIVATE_CONTRACTS) builds its root under os.tmpdir() and the engine looks for the
// nearest ".agentlas" folder above its working directory. A ".agentlas" left in any parent of the runner's temp folder
// (for example the account home that contains it) is then taken for the project and read from outside the owned root,
// which the runner rejects (core_python_path_outside_owner). Give this one stage a fresh temp folder directly under
// /private/tmp, whose parents can never hold project metadata, and remove it afterwards.
function cleanStageTemp(stage) {
  if (stage !== "MAC_PRIVATE_CONTRACTS" || process.platform !== "darwin") return null;
  const dir = fs.realpathSync.native(fs.mkdtempSync("/private/tmp/agentlas-owned-gates-"));
  const marker = `${dir}.owner.json`;
  fs.writeFileSync(marker, JSON.stringify({ owner: "run-private-release-gate", stage, pid: process.pid, created: new Date().toISOString() }), { mode: 0o600 });
  return { dir, marker };
}
function removeStageTemp(temp) {
  if (!temp) return true;
  try { fs.rmSync(temp.dir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(temp.marker, { force: true }); } catch {}
  return !fs.existsSync(temp.dir) && !fs.existsSync(temp.marker);
}

// The owned contracts read the prepared Core tree (dist/embedded-core); no earlier step of the macOS preflight job
// prepares it, so a clean runner would fail the second gate on a missing receipt. Preparing it is a local, deterministic
// copy of the pinned Core checkout and the same command the packaging flow runs.
function prepareStage(stage, env, fd) {
  if (stage !== "MAC_PRIVATE_CONTRACTS") return 0;
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--silent", "prepare:embedded-core"], { env, stdio: ["ignore", fd, fd] });
  return Number.isInteger(result.status) ? result.status : 1;
}

// The owned core fixture registers the interpreter it was given (HEPHAESTUS_PYTHON = realpath of sys.executable) and
// then refuses every child command that is not that exact string. A Homebrew Python always reports its stable
// /opt/homebrew/opt/... alias as sys.executable, whatever path it was started through, so the engine's own
// "<sys.executable> -m ontology ..." command never matches and the second gate stops on core_python_denied_effect.
// For this one stage, put an interpreter whose reported path equals its real path first on PATH.
const PYTHON_NAMES = ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3.9"];
function pythonProbe(command, args, env) {
  try { return execFileSync(command, ["-I", "-c", ...args], { env: { PATH: env.PATH || "/usr/bin:/bin" }, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
function pythonCandidates(env, roots) {
  const found = [];
  const add = (file, source) => { try { fs.accessSync(file, fs.constants.X_OK); if (!found.some(item => item.file === file)) found.push({ file, source }); } catch {} };
  for (const dir of (env.PATH || "").split(path.delimiter).filter(Boolean)) for (const name of PYTHON_NAMES) add(path.join(dir, name), "path");
  const children = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
  for (const version of children(path.join(roots.toolCache, "Python"))) for (const arch of children(path.join(roots.toolCache, "Python", version))) add(path.join(roots.toolCache, "Python", version, arch, "bin", "python3"), "toolcache");
  for (const version of children(roots.frameworks)) add(path.join(roots.frameworks, version, "bin", "python3"), "framework");
  add(roots.system, "system");
  return found;
}
function consistentPython(env, roots = { toolCache: env.RUNNER_TOOL_CACHE || "/Users/runner/hostedtoolcache", frameworks: "/Library/Frameworks/Python.framework/Versions", system: "/usr/bin/python3" }) {
  let best = null;
  for (const candidate of pythonCandidates(env, roots)) {
    const real = pythonProbe(candidate.file, ["import os,sys;print(os.path.realpath(sys.executable))"], env);
    if (!real || !path.isAbsolute(real)) continue;
    const reported = pythonProbe(real, ["import sys;print(sys.executable)"], env);
    const version = pythonProbe(real, ["import sys;print(sys.version_info[0]*100+sys.version_info[1])"], env);
    if (reported !== real || !(Number(version) >= 311)) continue;
    if (!best || Number(version) > best.version) best = { real, source: candidate.source, version: Number(version) };
  }
  return best;
}

// When no installed interpreter reports its own real path (a runner whose only Python is Homebrew's), a copy-style
// virtual environment built from the default python3 does: its executable is a real file inside the stage's own
// temporary folder, so the reported path and the real path are the same string.
function venvPython(env, dir) {
  const target = path.join(dir, "pyvenv");
  try {
    execFileSync("python3", ["-I", "-m", "venv", "--copies", "--without-pip", target], { env: { PATH: env.PATH || "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "ignore"], timeout: 60000 });
    const file = path.join(target, "bin", "python3");
    const real = pythonProbe(file, ["import os,sys;print(os.path.realpath(sys.executable))"], env);
    if (real && pythonProbe(real, ["import sys;print(sys.executable)"], env) === real) return { real, source: "venv" };
  } catch {}
  return null;
}

async function run(stage, command, args) {
  let fd;
  try { fd = privateLog(); }
  catch { process.stdout.write(`RELEASE_STAGE_LOG_UNAVAILABLE ${stage} exit=73\n`); process.exitCode = 73; return; }
  let child;
  let stageTemp = null;
  let pythonSource = null;
  let spawnError = null;
  let requestedSignal = null;
  let cancellation = null;
  let announceCancellation;
  const cancellationStarted = new Promise(resolve => { announceCancellation = resolve; });
  const beginCancellation = signal => {
    requestedSignal ||= signal;
    cancellation ||= stopProcessTree(child, requestedSignal, fd).catch(error => {
      try { fs.writeSync(fd, String(error?.stack || error)); } catch {}
      return false;
    });
    announceCancellation();
    return cancellation;
  };
  const signals = ["SIGINT", "SIGTERM"];
  const handlers = new Map(signals.map(signal => [signal, () => {
    if (!child?.pid) return;
    beginCancellation(signal);
  }]));
  try {
    const selected = portableCommand(command, args);
    stageTemp = cleanStageTemp(stage);
    const childEnv = stageTemp ? { ...process.env, TMPDIR: stageTemp.dir } : process.env;
    if (stageTemp) {
      const python = consistentPython(process.env) || venvPython(process.env, stageTemp.dir);
      pythonSource = python ? python.source : "none_consistent";
      if (python) {
        const shim = path.join(stageTemp.dir, "pybin");
        fs.mkdirSync(shim, { mode: 0o700 });
        fs.symlinkSync(python.real, path.join(shim, "python3"));
        childEnv.PATH = `${shim}${path.delimiter}${process.env.PATH || ""}`;
      }
    }
    const prepared = prepareStage(stage, childEnv, fd);
    if (prepared !== 0) {
      process.stdout.write(`RELEASE_STAGE_FAILURE_HINT ${stage} step=prepare:embedded-core\n`);
      process.stdout.write(`RELEASE_STAGE_FAILED ${stage} exit=${prepared}\n`);
      process.exitCode = prepared;
      return;
    }
    child = spawn(selected.command, selected.args, { env: childEnv, stdio: ["inherit", fd, fd], windowsHide: true, detached: process.platform !== "win32" });
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const closed = new Promise(resolve => {
      child.once("error", error => { spawnError = error; });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const result = await Promise.race([closed, cancellationStarted.then(async () => {
      await cancellation;
      return { code: null, signal: requestedSignal };
    })]);
    if (spawnError) throw spawnError;
    const terminalSignal = requestedSignal || result.signal;
    if (terminalSignal) {
      const cleaned = await beginCancellation(terminalSignal);
      if (!cleaned) process.stdout.write(`RELEASE_STAGE_CLEANUP_FAILED ${stage} exit=1\n`);
      process.stdout.write(`RELEASE_STAGE_SIGNAL ${stage} signal=${terminalSignal}\n`);
      for (const [signal, handler] of handlers) process.off(signal, handler);
      fs.closeSync(fd); fd = undefined;
      try { process.kill(process.pid, terminalSignal); }
      catch { process.exitCode = 128 + (os.constants.signals[terminalSignal] || 1); }
      return;
    }
    const code = Number.isInteger(result.code) ? result.code : 1;
    if (code !== 0 && privateLogFile) {
      const hints = [failureHints(privateLogFile), pythonSource ? `python=${pythonSource}` : ""].filter(Boolean).join(" ");
      if (hints) process.stdout.write(`RELEASE_STAGE_FAILURE_HINT ${stage} ${hints}\n`);
    }
    process.stdout.write(`RELEASE_STAGE_${code === 0 ? "OK" : "FAILED"} ${stage} exit=${code}\n`);
    process.exitCode = code;
  } catch (error) {
    try { fs.writeSync(fd, String(error?.stack || error)); } catch {}
    const code = error?.code === "ENOENT" ? 127 : error?.code === "EACCES" ? 126 : 1;
    process.stdout.write(`RELEASE_STAGE_SPAWN_FAILED ${stage} exit=${code}\n`);
    process.exitCode = code;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (fd !== undefined) fs.closeSync(fd);
    if (!removeStageTemp(stageTemp)) {
      process.stdout.write(`RELEASE_STAGE_CLEANUP_FAILED ${stage} exit=1\n`);
      if (!process.exitCode) process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  const [stage, separator, command, ...args] = process.argv.slice(2);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(stage || "") || separator !== "--" || !command) {
    process.stdout.write("RELEASE_STAGE_INPUT_INVALID exit=64\n"); process.exitCode = 64;
  } else run(stage, command, args).catch(() => {
    process.stdout.write(`RELEASE_STAGE_WRAPPER_FAILED ${stage} exit=1\n`); process.exitCode = 1;
  });
}

module.exports = { portableCommand, consistentPython, venvPython };
