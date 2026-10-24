import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { verifyActivatedFolderIdentity } from "../architecture/activation";
import { resolveHephaestusStdioLaunch } from "../hephaestus/engine";
import { hephaestusContextRoot } from "../hephaestus/root";

const MAX_TASK_CHARS = 12_000;
const MAX_RESULT_BYTES = 1_500_000;
const SLICE_TIMEOUT_MS = 4_000;
// Core's passive freshness check walks the whole
// repository — measured on the pilot: 11.0s, i.e. the call could never finish
// inside SLICE_TIMEOUT_MS and Desktop silently produced no slice at all. Core
// now accepts a freshness budget and serves the last complete map labelled
// `unverified_served` when the budget runs out. Measured end to end on the
// same repository: 1.94s at 0.4s, against 11.4s (an outright `context_map_stale`
// error) before. Small projects still verify fully inside the budget.
const SLICE_FRESHNESS_BUDGET_SECONDS = 0.4;
const REFRESH_TIMEOUT_MS = 15_000;
const NON_GIT_SIGNATURE_MAX_FILES = 5_000;
const NON_GIT_SOURCE_RE = /\.(?:[cm]?[jt]sx?|json|mdx?|py|rs|go|java|kts?|swift|c|cc|cpp|h|hpp|cs|rb|php|scala|sh|zsh|bash|sql|toml|ya?ml|xml|html?|css|scss|sass|less|vue|svelte|dart|exs?|erl|hrl|lua|r|ipynb)$/i;
const NON_GIT_IGNORED_DIRS = new Set([
  ".agentlas", ".git", ".next", ".venv", "build", "coverage", "dist",
  "node_modules", "out", "target", "vendor",
]);
// A map is refreshed once per unchanged source snapshot, not once per process.
// The old Set made a long-lived Desktop session keep serving the first map even
// after later turns edited the repository. A cheap Git/status signature lets us
// avoid a full Core scan on every turn while reopening the refresh gate as soon
// as tracked or untracked source changes are observed.
const refreshTriggered = new Map<string, string>();
const sourceSignatureJobs = new Map<string, SharedJob<string>>();
const refreshJobs = new Map<string, SharedJob<boolean>>();

type SharedJob<T> = {
  controller: AbortController;
  promise: Promise<T>;
  settled: boolean;
  waiters: number;
};

type ProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  overflowed: boolean;
  errorMessage?: string;
};

type ContextSliceResult = {
  schemaVersion?: string;
  rendered?: string;
  receipt?: { receiptDigest?: string };
};

type CodeMapResult = {
  schemaVersion?: string;
  snapshotId?: string;
  defIndex?: unknown;
  refIndex?: unknown;
  fileRoles?: unknown;
  dependencyEdges?: unknown;
  verificationGraph?: {
    schemaVersion?: string;
    graphDigest?: string;
  };
};

function abortedProcessResult(): ProcessResult {
  return {
    status: null,
    stdout: "",
    stderr: "",
    aborted: true,
    timedOut: false,
    overflowed: false,
  };
}

function runBoundedProcess(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxBuffer: number;
    env?: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.resolve(abortedProcessResult());
  return new Promise((resolve) => {
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let overflowed = false;
    let errorMessage: string | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(command, args, {
      windowsHide: true,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let hardKillTimer: NodeJS.Timeout | null = null;
    let forcedSettleTimer: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout;
    const onAbort = (): void => {
      aborted = true;
      terminate(false);
    };
    const finish = (status: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (forcedSettleTimer) clearTimeout(forcedSettleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        aborted,
        timedOut,
        overflowed,
        ...(errorMessage ? { errorMessage } : {}),
      });
    };
    const terminate = (force: boolean): void => {
      const leaderRunning = child.exitCode === null && child.signalCode === null;
      if (process.platform === "win32") {
        if (force && child.pid) {
          try {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
            killer.once("error", () => { /* child.kill fallback below */ });
            killer.unref();
          } catch {
            /* child.kill fallback below */
          }
        }
        if (leaderRunning) {
          try { child.kill(force ? "SIGKILL" : undefined); } catch { /* best effort */ }
        }
      } else if (child.pid) {
        // The leader may have exited while one of its descendants still owns
        // our stdout/stderr pipes. The detached process-group id remains the
        // launch pid, so signal the group even when ChildProcess.exitCode is set.
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
        catch {
          if (leaderRunning) {
            try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* best effort */ }
          }
        }
      }
      if (!force) {
        hardKillTimer ??= setTimeout(() => terminate(true), 250);
        hardKillTimer.unref?.();
      }
      forcedSettleTimer ??= setTimeout(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null);
      }, 1_000);
      forcedSettleTimer.unref?.();
    };
    timeout = setTimeout(() => {
      timedOut = true;
      terminate(false);
    }, options.timeoutMs);
    timeout.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const collect = (parts: Buffer[], chunk: Buffer | string, currentBytes: number): number => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, options.maxBuffer - currentBytes);
      if (value.length > remaining) {
        if (remaining > 0) parts.push(value.subarray(0, remaining));
        overflowed = true;
        terminate(false);
        return options.maxBuffer;
      }
      parts.push(value);
      return currentBytes + value.length;
    };
    child.stdout?.on("data", (chunk) => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
    child.stderr?.on("data", (chunk) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
    child.once("error", (error) => { errorMessage = error.message; });
    child.once("close", finish);
    if (options.input !== undefined) {
      child.stdin?.on("error", () => { /* close/result owns the failure */ });
      child.stdin?.end(options.input);
    }
  });
}

function createSharedJob<T>(
  jobs: Map<string, SharedJob<T>>,
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
): SharedJob<T> {
  const existing = jobs.get(key);
  if (existing) return existing;
  const controller = new AbortController();
  const job: SharedJob<T> = {
    controller,
    promise: Promise.resolve(undefined as T),
    settled: false,
    waiters: 0,
  };
  job.promise = run(controller.signal).finally(() => {
    job.settled = true;
    if (jobs.get(key) === job) jobs.delete(key);
  });
  jobs.set(key, job);
  return job;
}

async function waitForSharedJob<T>(
  job: SharedJob<T>,
  signal: AbortSignal | undefined,
  abortedValue: T,
): Promise<T> {
  if (signal?.aborted) {
    if (job.waiters === 0 && !job.settled) job.controller.abort();
    return abortedValue;
  }
  job.waiters += 1;
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await job.promise;
    return await Promise.race([
      job.promise,
      new Promise<T>((resolve) => {
        onAbort = () => resolve(abortedValue);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    job.waiters -= 1;
    if (job.waiters === 0 && !job.settled) job.controller.abort();
  }
}

async function nonGitProjectSourceSignature(
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const pending = [projectPath];
  const rows: string[] = [];
  let truncated = false;
  while (pending.length > 0 && rows.length < NON_GIT_SIGNATURE_MAX_FILES) {
    if (signal?.aborted) return "";
    const current = pending.pop();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = (await fs.promises.readdir(current, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (rows.length >= NON_GIT_SIGNATURE_MAX_FILES) {
        truncated = true;
        break;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!NON_GIT_IGNORED_DIRS.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || !NON_GIT_SOURCE_RE.test(entry.name)) continue;
      const relative = path.relative(projectPath, absolute);
      try {
        const stat = await fs.promises.stat(absolute);
        rows.push(`${relative}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        rows.push(`${relative}:missing`);
      }
    }
  }
  rows.sort();
  return `non-git:${truncated || pending.length > 0 ? "truncated" : "complete"}\n${rows.join("\n")}`;
}

async function contextLaunch(args: string[], signal?: AbortSignal): Promise<{
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} | null> {
  if (signal?.aborted) return null;
  const explicitBin = process.env.HEPHAESTUS_BIN?.trim();
  if (explicitBin) {
    try {
      await fs.promises.access(explicitBin, fs.constants.X_OK);
      if (signal?.aborted) return null;
      return {
        command: explicitBin,
        args: ["context", ...args],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      };
    } catch {
      // Invalid explicit shell bridge falls through to the canonical runtime.
    }
  }
  const contextRoot = hephaestusContextRoot();
  if (!contextRoot) return null;
  const launch = await resolveHephaestusStdioLaunch(
    "agentlas_cloud",
    ["context", ...args],
    contextRoot,
    { includeJudgeRuntime: false },
  );
  return signal?.aborted || !launch
    ? null
    : {
        ...launch,
        env: { ...process.env, ...launch.env, ELECTRON_RUN_AS_NODE: "1" },
      };
}

async function hasCanonicalCodeMap(projectPath: string): Promise<boolean> {
  try {
    const payload = JSON.parse(
      await fs.promises.readFile(
        path.join(projectPath, ".agentlas", "code-map", "project-map.json"),
        "utf8",
      ),
    ) as CodeMapResult;
    const manifest = JSON.parse(
      await fs.promises.readFile(
        path.join(projectPath, ".agentlas", "code-map", "manifest.json"),
        "utf8",
      ),
    ) as { schemaVersion?: string; snapshotId?: string; complete?: boolean };
    const verificationSchema = payload.verificationGraph?.schemaVersion ?? "";
    return (
      payload.schemaVersion === "agentlas.code-map.v2"
      && /^sha256:[0-9a-f]{64}$/.test(payload.snapshotId ?? "")
      && manifest.schemaVersion === "agentlas.code-map-manifest.v3"
      && manifest.snapshotId === payload.snapshotId
      && manifest.complete === true
      && payload.defIndex !== null
      && typeof payload.defIndex === "object"
      && payload.refIndex !== null
      && typeof payload.refIndex === "object"
      && payload.fileRoles !== null
      && typeof payload.fileRoles === "object"
      && Array.isArray(payload.dependencyEdges)
      && ["agentlas.verification-map.v1", "agentlas.verification-map.v2"]
        .includes(verificationSchema)
      && /^sha256:[0-9a-f]{64}$/.test(payload.verificationGraph?.graphDigest ?? "")
    );
  } catch {
    return false;
  }
}

async function computeProjectSourceSignature(
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const parts: string[] = [];
  try {
    const git = await runBoundedProcess(
      "git",
      ["-C", projectPath, "status", "--porcelain=v1", "--untracked-files=all"],
      { timeoutMs: 1_500, maxBuffer: 2_000_000, signal },
    );
    if (signal?.aborted || git.aborted) return "";
    if (git.status === 0 && !git.timedOut && !git.overflowed) {
      const head = await runBoundedProcess(
        "git",
        ["-C", projectPath, "rev-parse", "--verify", "HEAD"],
        { timeoutMs: 1_500, maxBuffer: 64_000, signal },
      );
      if (signal?.aborted || head.aborted) return "";
      parts.push(
        head.status === 0 && !head.timedOut && !head.overflowed
          ? `HEAD:${String(head.stdout || "").trim()}`
          : "HEAD:unborn",
      );
      const status = String(git.stdout || "");
      parts.push(status);
      const paths = status.split(/\r?\n/)
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .map((value) => value.includes(" -> ") ? value.slice(value.lastIndexOf(" -> ") + 4) : value)
        .map((value) => value.replace(/^"|"$/g, ""));
      const boundedPaths = paths.slice(0, 2_000);
      for (let offset = 0; offset < boundedPaths.length; offset += 64) {
        if (signal?.aborted) return "";
        const rows = await Promise.all(boundedPaths.slice(offset, offset + 64).map(async (relative) => {
          try {
            const stat = await fs.promises.stat(path.join(projectPath, relative));
            return `${relative}:${stat.size}:${stat.mtimeMs}`;
          } catch {
            return `${relative}:missing`;
          }
        }));
        parts.push(...rows);
      }
      if (signal?.aborted) return "";
      const diff = await runBoundedProcess(
        "git",
        ["-C", projectPath, "diff", "--numstat", "HEAD", "--"],
        { timeoutMs: 2_500, maxBuffer: 2_000_000, signal },
      );
      if (signal?.aborted || diff.aborted) return "";
      if (diff.status === 0 && !diff.timedOut && !diff.overflowed) {
        parts.push(String(diff.stdout || ""));
      }
    } else {
      parts.push(await nonGitProjectSourceSignature(projectPath, signal));
    }
  } catch {
    parts.push(await nonGitProjectSourceSignature(projectPath, signal));
  }
  return parts.join("\n");
}

export function projectSourceSignature(
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const job = createSharedJob(sourceSignatureJobs, projectPath, (jobSignal) => (
    computeProjectSourceSignature(projectPath, jobSignal)
  ));
  return waitForSharedJob(job, signal, "");
}

/**
 * Refresh through the public Core command and return true only after the
 * canonical v3 manifest and its v2 compatibility map are present. Process creation
 * is not a refresh receipt.
 */
export async function triggerProjectContextMapRefresh(
  projectPath: string,
  options: { signal?: AbortSignal; sourceSignature?: string } = {},
): Promise<boolean> {
  if (options.signal?.aborted || !verifyActivatedFolderIdentity(projectPath)) return false;
  const sourceSignature = options.sourceSignature
    ?? await projectSourceSignature(projectPath, options.signal);
  if (options.signal?.aborted || !sourceSignature || !verifyActivatedFolderIdentity(projectPath)) return false;
  if (
    refreshTriggered.get(projectPath) === sourceSignature
    && await hasCanonicalCodeMap(projectPath)
    && !options.signal?.aborted
    && verifyActivatedFolderIdentity(projectPath)
  ) return true;
  const signatureDigest = createHash("sha256").update(sourceSignature).digest("hex");
  const key = `${projectPath}\0${signatureDigest}`;
  const job = createSharedJob(refreshJobs, key, async (jobSignal) => {
    if (jobSignal.aborted || !verifyActivatedFolderIdentity(projectPath)) return false;
    const launch = await contextLaunch(["refresh", "--project", projectPath], jobSignal);
    if (!launch || jobSignal.aborted) return false;
    try {
      const result = await runBoundedProcess(
        launch.command,
        launch.args,
        {
          timeoutMs: REFRESH_TIMEOUT_MS,
          maxBuffer: MAX_RESULT_BYTES,
          env: launch.env,
          signal: jobSignal,
        },
      );
      if (jobSignal.aborted) return false;
      const canonical = result.status === 0
        && !result.timedOut
        && !result.overflowed
        && verifyActivatedFolderIdentity(projectPath)
        && await hasCanonicalCodeMap(projectPath);
      if (
        jobSignal.aborted
        || (canonical && !verifyActivatedFolderIdentity(projectPath))
      ) return false;
      if (!canonical) {
        if (refreshTriggered.get(projectPath) === sourceSignature) refreshTriggered.delete(projectPath);
        if (!result.aborted) {
          console.warn(
            `[memory] context-map refresh failed (${projectPath}): `
            + `${String(result.stderr || result.errorMessage || "invalid canonical map").trim().slice(0, 500)}`,
          );
        }
        return false;
      }
      refreshTriggered.set(projectPath, sourceSignature);
      return true;
    } catch {
      if (refreshTriggered.get(projectPath) === sourceSignature) refreshTriggered.delete(projectPath);
      return false;
    }
  });
  return waitForSharedJob(job, options.signal, false);
}

/**
 * Ask Core for the exact same dependency-selected slice used by Terminal,
 * Claude/Codex adapters, and Workforce. The task travels on stdin so it never
 * appears in a process list or network request.
 */
export async function buildProjectContextSlice(
  projectPath: string | null,
  taskPrompt: string | undefined,
  options: { refresh?: boolean; signal?: AbortSignal; sourceSignature?: string } = {},
): Promise<string | null> {
  if (options.signal?.aborted) return null;
  if (!projectPath || !verifyActivatedFolderIdentity(projectPath)) return null;
  const task = String(taskPrompt ?? "").slice(0, MAX_TASK_CHARS);
  if (!task.trim()) return null;
  // Read-only recall may consume an already materialized map, but it must not
  // turn a question into project-local writes. The caller grants refresh
  // authority explicitly; `slice --no-refresh` then preserves that boundary
  // all the way through Core.
  if (options.refresh !== false) {
    await triggerProjectContextMapRefresh(projectPath, {
      signal: options.signal,
      sourceSignature: options.sourceSignature,
    });
  }
  if (options.signal?.aborted || !verifyActivatedFolderIdentity(projectPath)) return null;
  const launch = await contextLaunch([
    "slice",
    "--project",
    projectPath,
    "--task-stdin",
    "--no-refresh",
    "--render",
    // Recall must degrade to a labelled map, never to nothing: another session
    // editing the project made every slice `context_map_stale`, and this call
    // site turns any non-zero exit into `null`.
    "--allow-stale",
    "--freshness-budget",
    String(SLICE_FRESHNESS_BUDGET_SECONDS),
  ], options.signal);
  if (!launch) return null;
  try {
    const result = await runBoundedProcess(
      launch.command,
      launch.args,
      {
        input: task,
        timeoutMs: SLICE_TIMEOUT_MS,
        maxBuffer: MAX_RESULT_BYTES,
        env: launch.env,
        signal: options.signal,
      },
    );
    if (
      options.signal?.aborted
      || result.aborted
      || result.timedOut
      || result.overflowed
      || result.status !== 0
      || !result.stdout
      || !verifyActivatedFolderIdentity(projectPath)
    ) return null;
    const payload = JSON.parse(result.stdout) as ContextSliceResult;
    if (
      payload.schemaVersion !== "agentlas.context-slice.v1"
      || typeof payload.rendered !== "string"
      || !payload.rendered.trim()
    ) {
      return null;
    }
    return payload.rendered.trim();
  } catch {
    return null;
  }
}
