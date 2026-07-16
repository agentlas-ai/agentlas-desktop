import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export type NativeInputAction =
  | { action: "status" }
  | { action: "listApps" }
  | { action: "focusApp"; app: string }
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
  | { action: "key"; key: string; modifiers?: string[]; repeat?: number };

export interface NativeInputResult {
  ok: boolean;
  error?: string;
  message?: string;
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
): Promise<NativeInputResult> {
  const driver = nativeInputDriverPath();
  if (!driver) {
    return Promise.resolve({
      ok: false,
      error: process.platform === "darwin" ? "driver-not-installed" : "platform-not-supported",
      message: "Agentlas native Computer Use input driver is unavailable.",
    });
  }
  return new Promise((resolve) => {
    const child = spawn(driver, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
      windowsHide: true,
      shell: false,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (result: NativeInputResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({ ok: false, error: "driver-timeout", message: "Native input driver timed out." });
    }, Math.max(250, Math.min(timeoutMs, 10_000)));

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 256 * 1024) stdout.push(chunk);
      else {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        finish({ ok: false, error: "driver-response-too-large", message: "Native input driver response was rejected." });
      }
    });
    child.once("error", () => {
      finish({ ok: false, error: "driver-launch-failed", message: "Native input driver could not start." });
    });
    child.once("close", (code) => {
      if (settled) return;
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as NativeInputResult;
        if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") throw new Error("invalid");
        finish(parsed);
      } catch {
        finish({
          ok: false,
          error: code === 77 ? "accessibility-permission-required" : "driver-invalid-response",
          message: "Native input driver returned an invalid response.",
        });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
