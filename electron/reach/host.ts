import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { ExecFn, ExecOptions, ExecResult, ReachFs, ReachHost, ReachPlatform } from "./types";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

// Runs one program with an argument vector. No shell, no inherited stdin, a hard deadline and an output ceiling: a dictionary
// of an app is data an app controls, so reading it must not be able to hang or exhaust the host.
export const nodeExec: ExecFn = (file: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> =>
  new Promise((resolve) => {
    const maxBuffer = options.maxBytes ?? DEFAULT_MAX_BYTES;
    execFile(
      file,
      [...args],
      { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer, encoding: "utf8", windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        const overflow = failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        resolve({
          code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: Boolean(failure?.killed) && !overflow,
          truncated: overflow,
        });
      },
    );
  });

export const nodeFs: ReachFs = {
  async readdir(path) {
    const entries = await fs.readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  },
  async readFile(path, maxBytes = 4 * 1024 * 1024) {
    const handle = await fs.open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  },
  realpath: (path) => fs.realpath(path),
  async mtimeMs(path) {
    try {
      return (await fs.stat(path)).mtimeMs;
    } catch {
      return null;
    }
  },
  async exists(path) {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  },
};

export function currentPlatform(): ReachPlatform {
  if (process.platform === "darwin" || process.platform === "win32" || process.platform === "linux") return process.platform;
  throw new Error(`reach_platform_unsupported:${process.platform}`);
}

export function createNodeHost(overrides: Partial<ReachHost> = {}): ReachHost {
  return {
    platform: currentPlatform(),
    arch: process.arch,
    release: os.release(),
    homedir: os.homedir(),
    env: process.env,
    exec: nodeExec,
    fs: nodeFs,
    now: () => new Date(),
    ...overrides,
  };
}
