import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { reportSystemPermissionIssue } from "../os-permission-guidance";

export type NativeInputAction =
  | { action: "status" }
  | { action: "listApps" }
  | { action: "listCaptureTargets" }
  | { action: "focusApp"; app: string; windowId?:number; processStartMs?:number }
  | { action: "windowFrame"; app: string }
  | { action: "setWindowFrame"; app: string; x: number; y: number; width: number; height: number }
  | { action: "move"; x: number; y: number }
  | { action: "click"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: 1 | 2 }
  | {
      action: "drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      durationMs?: number;
      button?: "left" | "right" | "middle";
    }
  | { action: "scroll"; deltaX?: number; deltaY?: number }
  | { action: "typeText"; text: string; targetPid?: number }
  | { action: "selectText"; targetPid?: number }
  | { action: "observeApp"; app: string; maxDepth?: number; maxNodes?: number }
  | {
      action: "elementAction";
      operation: "click" | "setValue" | "secondaryAction" | "selectText";
      ref: NativeElementReference;
      value?: string;
      actionName?: string;
      text?: string;
      prefix?: string;
      suffix?: string;
      selectionType?: "text" | "cursor_before" | "cursor_after";
    }
  | { action: "key"; key: string; modifiers?: string[]; repeat?: number };

export interface NativeElementReference {
  pid: number;
  bundleIdentifier: string;
  processStartMs: number;
  /** Exact AX child-index path, bounded to 32 components and kept private by the control server. */
  path: number[];
  fingerprint: string;
}

export interface NativeObservedElement {
  ref: NativeElementReference;
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  value?: string;
  frame?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  focused?: boolean;
  actions: string[];
}

export interface NativeAppObservation {
  capturedAt: string;
  app: { name: string; pid: number; bundleIdentifier: string; processStartMs: number };
  elements: NativeObservedElement[];
  truncated: boolean;
}

export interface NativeInputResult {
  ok: boolean;
  error?: string;
  message?: string;
  observation?: NativeAppObservation;
  [key: string]: unknown;
}

function isExecutableRegularFile(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Packaged builds use the nested, signed universal helper. Development builds
 * use the exact artifact emitted by scripts/build-macos-input-driver.cjs.
 */
export function nativeInputDriverPath(): string | null {
  if (process.platform !== "darwin") return null;
  const packaged = path.join(process.resourcesPath, "native", "macos", "agentlas-input-driver");
  if (app.isPackaged) return isExecutableRegularFile(packaged) ? packaged : null;
  const development = path.resolve(__dirname, "../../../build-resources/native/macos/agentlas-input-driver");
  return isExecutableRegularFile(development) ? development : null;
}

export function nativeInputDriverAvailable(): boolean {
  return nativeInputDriverPath() !== null;
}

export function invokeNativeInputDriver(
  request: NativeInputAction,
  timeoutMs = request.action === "drag" ? 8_000 : 4_000,
  signal?: AbortSignal,
): Promise<NativeInputResult> {
  return withOneSensitiveOperation(() => invokeNativeInputDriverUnlocked(request, timeoutMs, signal));
}
function invokeNativeInputDriverUnlocked(
  request: NativeInputAction,
  timeoutMs = request.action === "drag" ? 8_000 : 4_000,
  signal?: AbortSignal,
): Promise<NativeInputResult> {
  const aborted: NativeInputResult = { ok: false, error: "driver-aborted", message: "Native input driver was cancelled." };
  if (signal?.aborted) return Promise.resolve(aborted);
  const driver = nativeInputDriverPath();
  if (!driver) {
    return Promise.resolve({
      ok: false,
      error: process.platform === "darwin" ? "driver-not-installed" : "platform-not-supported",
      message: "Agentlas native Computer Use input driver is unavailable.",
    });
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(driver, [], { stdio: ["pipe", "pipe", "pipe"], env: {}, windowsHide: true, shell: false });
    } catch {
      // A synchronous spawn failure created no child to drain.
      resolve({ ok: false, error: "driver-launch-failed", message: "Native input driver could not start." });
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false, killRequested = false;
    let stopped: NativeInputResult | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
    const finish = (result: NativeInputResult) => {
      if (settled) return;
      settled = true;
      clearTimer();
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = (result: NativeInputResult) => {
      if (settled) return;
      stopped ??= result;
      clearTimer();
      // A kill request (including false/throw) is not a physical exit proof.
      // Keep the caller's resource lease and sensitive-operation barrier until close.
      if (!killRequested) {
        killRequested = true;
        try { child.kill("SIGKILL"); } catch { /* close remains the drain barrier */ }
      }
    };
    const onAbort = () => stop(aborted);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stopped || settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 256 * 1024) stdout.push(chunk);
      else {
        stdout.length = 0;
        stop({ ok: false, error: "driver-response-too-large", message: "Native input driver response was rejected." });
      }
    });
    // Node emits close after a failed spawn's error too. An error with no PID
    // never manufactures a successful drain; observe it and await that close.
    child.on("error", () => stop({ ok: false, error: "driver-launch-failed", message: "Native input driver could not start." }));
    child.once("close", (code) => {
      if (stopped) { finish(stopped); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as NativeInputResult;
        if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") throw new Error("invalid");
        if (parsed.error === "accessibility-permission-required") reportSystemPermissionIssue("accessibility", "computer-use");
        finish(parsed);
      } catch {
        if (code === 77) reportSystemPermissionIssue("accessibility", "computer-use");
        finish({ ok: false, error: code === 77 ? "accessibility-permission-required" : "driver-invalid-response", message: "Native input driver returned an invalid response." });
      }
    });
    child.stdout!.on("error", () => stop({ ok: false, error: "driver-response-failed", message: "Native input driver output failed." }));
    // Drain stderr without retaining/logging raw output. A bounded diagnostic
    // stream cannot backpressure the child forever or bypass its drain barrier.
    let stderrBytes = 0;
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stopped || settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > 256 * 1024) stop({ ok: false, error: "driver-response-too-large", message: "Native input driver response was rejected." });
    });
    child.stderr!.on("error", () => stop({ ok: false, error: "driver-response-failed", message: "Native input driver output failed." }));
    child.stdin!.on("error", () => {});
    timer = setTimeout(() => stop({ ok: false, error: "driver-timeout", message: "Native input driver timed out." }), Math.max(250, Math.min(timeoutMs, 10_000)));
    signal?.addEventListener("abort", onAbort, { once: true });
    // Abort may have happened during spawn, before the listener was installed.
    if (signal?.aborted) onAbort();
    if (!stopped) {
      try { child.stdin!.end(JSON.stringify(request)); }
      catch { stop({ ok: false, error: "driver-launch-failed", message: "Native input driver could not start." }); }
    }
  });
}
import { withOneSensitiveOperation } from '../secrets/sensitive-surface';
