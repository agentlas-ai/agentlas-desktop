#!/usr/bin/env node
"use strict";

// Release operations keep child output in runner-owned temporary storage.
// Only a typed stage and process outcome cross the public Actions log boundary.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");

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

function privateLog() {
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary || !path.isAbsolute(temporary)) throw new Error("runner temporary directory required");
  const root = fs.realpathSync(temporary);
  if (!fs.statSync(root).isDirectory()) throw new Error("runner temporary directory invalid");
  const directory = fs.mkdtempSync(path.join(root, "agentlas-release-private-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "output.log");
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

async function run(stage, command, args) {
  let fd;
  try { fd = privateLog(); }
  catch { process.stdout.write(`RELEASE_STAGE_LOG_UNAVAILABLE ${stage} exit=73\n`); process.exitCode = 73; return; }
  let child;
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
    child = spawn(selected.command, selected.args, { env: process.env, stdio: ["inherit", fd, fd], windowsHide: true, detached: process.platform !== "win32" });
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

module.exports = { portableCommand };
