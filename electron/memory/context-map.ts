import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { verifyActivatedFolderIdentity } from "../architecture/activation";

const MAX_TASK_CHARS = 12_000;
const MAX_RESULT_BYTES = 1_500_000;
const SLICE_TIMEOUT_MS = 4_000;
const refreshTriggered = new Set<string>();

type ContextSliceResult = {
  schemaVersion?: string;
  rendered?: string;
  receipt?: { receiptDigest?: string };
};

function hephaestusBin(): string | null {
  const candidates = [
    process.env.HEPHAESTUS_BIN,
    path.join(os.homedir(), ".agentlas", "runtime", "current", "bin", "hephaestus"),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Try the next locally installed runtime.
    }
  }
  return null;
}

/** Refresh in the background. The current turn may consume the last valid map. */
export function triggerProjectContextMapRefresh(projectPath: string): boolean {
  if (!verifyActivatedFolderIdentity(projectPath)) return false;
  if (refreshTriggered.has(projectPath)) return true;
  const binary = hephaestusBin();
  if (!binary) return false;
  refreshTriggered.add(projectPath);
  try {
    const child = spawn(
      binary,
      ["context", "refresh", "--project", projectPath],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    child.unref();
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
): string | null {
  if (!projectPath || !verifyActivatedFolderIdentity(projectPath)) return null;
  const task = String(taskPrompt ?? "").slice(0, MAX_TASK_CHARS);
  if (!task.trim()) return null;
  triggerProjectContextMapRefresh(projectPath);
  const binary = hephaestusBin();
  if (!binary) return null;
  try {
    const result = spawnSync(
      binary,
      [
        "context",
        "slice",
        "--project",
        projectPath,
        "--task-stdin",
        "--no-refresh",
        "--render",
      ],
      {
        input: task,
        encoding: "utf8",
        timeout: SLICE_TIMEOUT_MS,
        maxBuffer: MAX_RESULT_BYTES,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
