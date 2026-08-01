import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyActivatedFolderIdentity } from "../architecture/activation";
import { resolveHephaestusSyncLaunch } from "../hephaestus/engine";

const MAX_TASK_CHARS = 12_000;
const MAX_RESULT_BYTES = 1_500_000;
const SLICE_TIMEOUT_MS = 4_000;
const REFRESH_TIMEOUT_MS = 15_000;
const refreshTriggered = new Set<string>();

type ContextSliceResult = {
  schemaVersion?: string;
  rendered?: string;
  receipt?: { receiptDigest?: string };
};

type CodeMapResult = {
  schemaVersion?: string;
  defIndex?: unknown;
  refIndex?: unknown;
  verificationGraph?: {
    schemaVersion?: string;
    graphDigest?: string;
  };
};

function contextLaunch(args: string[]): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} | null {
  const explicitBin = process.env.HEPHAESTUS_BIN?.trim();
  if (explicitBin) {
    try {
      fs.accessSync(explicitBin, fs.constants.X_OK);
      return {
        command: explicitBin,
        args: ["context", ...args],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      };
    } catch {
      // Invalid explicit shell bridge falls through to the canonical runtime.
    }
  }
  return resolveHephaestusSyncLaunch("agentlas_cloud", ["context", ...args]);
}

function hasCanonicalCodeMap(projectPath: string): boolean {
  try {
    const payload = JSON.parse(
      fs.readFileSync(
        path.join(projectPath, ".agentlas", "code-map", "project-map.json"),
        "utf8",
      ),
    ) as CodeMapResult;
    return (
      payload.schemaVersion === "agentlas.code-map.v2"
      && payload.defIndex !== null
      && typeof payload.defIndex === "object"
      && payload.refIndex !== null
      && typeof payload.refIndex === "object"
      && payload.verificationGraph?.schemaVersion === "agentlas.verification-map.v1"
      && /^sha256:[0-9a-f]{64}$/.test(payload.verificationGraph.graphDigest ?? "")
    );
  } catch {
    return false;
  }
}

/**
 * Refresh through the public Core command and return true only after the
 * canonical v2 map with the verification graph is present. Process creation
 * is not a refresh receipt.
 */
export function triggerProjectContextMapRefresh(projectPath: string): boolean {
  if (!verifyActivatedFolderIdentity(projectPath)) return false;
  if (refreshTriggered.has(projectPath) && hasCanonicalCodeMap(projectPath)) return true;
  const launch = contextLaunch(["refresh", "--project", projectPath]);
  if (!launch) return false;
  try {
    const result = spawnSync(
      launch.command,
      launch.args,
      {
        encoding: "utf8",
        timeout: REFRESH_TIMEOUT_MS,
        maxBuffer: MAX_RESULT_BYTES,
        windowsHide: true,
        env: launch.env,
      },
    );
    if (result.status !== 0 || !hasCanonicalCodeMap(projectPath)) {
      refreshTriggered.delete(projectPath);
      console.warn(
        `[memory] context-map refresh failed (${projectPath}): `
        + `${String(result.stderr || result.error?.message || "invalid canonical map").trim().slice(0, 500)}`,
      );
      return false;
    }
    refreshTriggered.add(projectPath);
    return true;
  } catch {
    refreshTriggered.delete(projectPath);
    return false;
  }
}

/**
 * Ask Core for the exact same dependency-selected slice used by Terminal,
 * Claude/Codex adapters, and Workforce. The task travels on stdin so it never
 * appears in a process list or network request.
 */
export function buildProjectContextSlice(
  projectPath: string | null,
  taskPrompt: string | undefined,
  options: { refresh?: boolean } = {},
): string | null {
  if (!projectPath || !verifyActivatedFolderIdentity(projectPath)) return null;
  const task = String(taskPrompt ?? "").slice(0, MAX_TASK_CHARS);
  if (!task.trim()) return null;
  // Read-only recall may consume an already materialized map, but it must not
  // turn a question into project-local writes. The caller grants refresh
  // authority explicitly; `slice --no-refresh` then preserves that boundary
  // all the way through Core.
  if (options.refresh !== false) triggerProjectContextMapRefresh(projectPath);
  const launch = contextLaunch([
    "slice",
    "--project",
    projectPath,
    "--task-stdin",
    "--no-refresh",
    "--render",
  ]);
  if (!launch) return null;
  try {
    const result = spawnSync(
      launch.command,
      launch.args,
      {
        input: task,
        encoding: "utf8",
        timeout: SLICE_TIMEOUT_MS,
        maxBuffer: MAX_RESULT_BYTES,
        windowsHide: true,
        env: launch.env,
      },
    );
    if (result.status !== 0 || !result.stdout) return null;
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
