import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolveManagedNodeRuntime } from "../runtime/managed-node";
import type { ResolvedScienceRendererExecutor } from "./renderer-registry";

const MAX_LOG_BYTES = 64 * 1024;

export interface SignedScienceExecutorReceipt {
  output: Buffer;
  childPid: number;
  exitCode: 0;
  entrySha256: string;
  executorDescriptorSha256: string;
  sandbox: "macos-seatbelt-deny-network-write-fork-v1";
  nodeRuntime: "managed" | "development-electron-node";
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVerifiedFile(target: string, expectedSha256: string, maximum = 32 * 1024 * 1024): Buffer {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(target, flags);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maximum) throw new Error("science-signed-executor-file-invalid");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error("science-signed-executor-file-short-read");
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("science-signed-executor-file-changed");
    if (sha256(bytes) !== expectedSha256) throw new Error("science-signed-executor-file-digest-mismatch");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function resolveNodeRuntime(): { path: string; kind: SignedScienceExecutorReceipt["nodeRuntime"] } {
  // Electron's run-as-Node contract tests intentionally have no `app` export.
  // Production browser processes do, and must use the checksum-pinned runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronApp = (require("electron") as { app?: { isPackaged?: boolean } }).app;
  if (!electronApp?.isPackaged) return { path: process.execPath, kind: "development-electron-node" };
  const managed = resolveManagedNodeRuntime();
  if (!managed.ok) throw new Error("science-signed-executor-managed-node-unavailable");
  return { path: managed.runtime.node, kind: "managed" };
}

function seatbeltProfile(jobRoot: string): string {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sensitive = [
    path.join(os.homedir(), ".ssh"),
    path.join(os.homedir(), ".aws"),
    path.join(os.homedir(), ".gnupg"),
    path.join(os.homedir(), ".config", "gh"),
    path.join(os.homedir(), "Library", "Keychains"),
  ];
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-fork)",
    "(deny file-write*)",
    `(allow file-write* (subpath "${escape(jobRoot)}"))`,
    ...sensitive.map((target) => `(deny file-read* (subpath "${escape(target)}"))`),
  ].join("\n");
}

function runChild(command: string, args: string[], cwd: string, timeoutMs: number, onSpawn?: (pid: number) => void): Promise<{ pid: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ELECTRON_RUN_AS_NODE: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TMPDIR: cwd },
    });
    const pid = child.pid;
    if (!pid) return reject(new Error("science-signed-executor-child-pid-missing"));
    try { onSpawn?.(pid); } catch (error) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* exited */ }
      return reject(error);
    }
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < MAX_LOG_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_LOG_BYTES - Buffer.byteLength(stderr));
    });
    const timer = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* exited */ }
      if (!settled) {
        settled = true;
        reject(new Error("science-signed-executor-timeout"));
      }
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new Error(`science-signed-executor-failed:${code ?? signal ?? "unknown"}:${stderr.trim().slice(0, 512)}`));
      else resolve({ pid, stderr });
    });
  });
}

export async function runSignedScienceExecutor(
  authority: ResolvedScienceRendererExecutor,
  input: Buffer,
  onSpawn?: (pid: number) => void,
): Promise<SignedScienceExecutorReceipt> {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) throw new Error("science-signed-executor-os-sandbox-unavailable");
  if (input.length < 2 || input.length > authority.executor.maxInputBytes) throw new Error("science-signed-executor-input-invalid");
  const jobRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-executor-")));
  fs.chmodSync(jobRoot, 0o700);
  try {
    const entryBytes = readVerifiedFile(authority.entryPath, authority.executor.entrySha256);
    const entryName = path.basename(authority.executor.entry);
    const entryPath = path.join(jobRoot, entryName);
    fs.writeFileSync(entryPath, entryBytes, { flag: "wx", mode: 0o400 });
    const usedNames = new Set([entryName, "input.json", "output.json"]);
    for (const asset of authority.assets) {
      const name = path.basename(asset.path);
      if (usedNames.has(name)) throw new Error("science-signed-executor-asset-name-conflict");
      usedNames.add(name);
      fs.writeFileSync(path.join(jobRoot, name), readVerifiedFile(asset.path, asset.sha256, 64 * 1024 * 1024), { flag: "wx", mode: 0o400 });
    }
    fs.writeFileSync(path.join(jobRoot, "input.json"), input, { flag: "wx", mode: 0o400 });
    const node = resolveNodeRuntime();
    const profile = seatbeltProfile(jobRoot);
    const result = await runChild(
      "/usr/bin/sandbox-exec",
      ["-p", profile, node.path, entryPath, path.join(jobRoot, "input.json"), path.join(jobRoot, "output.json")],
      jobRoot,
      authority.executor.timeoutMs,
      onSpawn,
    );
    const output = readVerifiedFile(path.join(jobRoot, "output.json"), sha256(fs.readFileSync(path.join(jobRoot, "output.json"))), authority.executor.maxOutputBytes);
    return {
      output,
      childPid: result.pid,
      exitCode: 0,
      entrySha256: authority.executor.entrySha256,
      executorDescriptorSha256: authority.executorDescriptorSha256,
      sandbox: "macos-seatbelt-deny-network-write-fork-v1",
      nodeRuntime: node.kind,
    };
  } finally {
    fs.rmSync(jobRoot, { recursive: true, force: true });
  }
}
