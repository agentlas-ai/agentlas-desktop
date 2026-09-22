import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onHostShutdown } from "../host-lifecycle";
import { isPackagedRuntime, optionalElectronAppPath } from "../runtime-paths";
import { killCliTree } from "../runtime/exec";
import {
  CHROMIUM_PRINT_HELPER_FLAG, CHROMIUM_PRINT_RESULT_PREFIX, CHROMIUM_PRINT_SCHEMA,
  chromiumPrintFailureReason, type ChromiumHelperResult, type ChromiumPdfOptions, type ChromiumPrintResult,
} from "./chromium-print-protocol";

interface PrintJob {
  html: string;
  requestId: string;
  resolve: (result: ChromiumPrintResult) => void;
  cancelled: string | null;
  child?: ChildProcessWithoutNullStreams;
  killTimer?: NodeJS.Timeout;
  deadline?: NodeJS.Timeout;
  detachSignal: () => void;
}

const queue: PrintJob[] = [];
let active: PrintJob | null = null;
let closing = false;
let settlement: Promise<void> = Promise.resolve();

function killOwnedProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode === null) killCliTree(child, 0);
  } catch { /* The exact owned process/group has already exited. */ }
}

function finishQueued(job: PrintJob): void {
  if (job.deadline) clearTimeout(job.deadline);
  job.detachSignal();
  job.resolve({ ok: false, engine: "chromium", reason: job.cancelled || "science_chromium_cancelled" });
}

function cancel(job: PrintJob, reason: string): void {
  if (job.cancelled) return;
  job.cancelled = reason;
  const position = queue.indexOf(job);
  if (position >= 0) {
    queue.splice(position, 1);
    finishQueued(job);
    return;
  }
  if (job.child) {
    // Cooperative shutdown destroys Chromium's window before exiting. Escalation
    // is a cleanup grace period, never an implicit limit on a running print job.
    if (process.platform === "win32") killCliTree(job.child, 1_000);
    if (job.child.stdin.writable) job.child.stdin.write(`${JSON.stringify({ type: "cancel", requestId: job.requestId })}\n`, () => {});
    job.killTimer = setTimeout(() => killOwnedProcessGroup(job.child!, "SIGKILL"), 1_000);
    job.killTimer.unref();
  }
}

function helperLaunch(directory: string): { executable: string; args: string[] } {
  let electron: { app?: { isPackaged: boolean } } | string | undefined;
  try { electron = require("electron"); } catch { /* Report unavailable below. */ }
  const executable = process.versions.electron ? process.execPath : typeof electron === "string" ? electron : null;
  if (!executable || !fs.existsSync(executable)) throw new Error("science_chromium_electron_runtime_unavailable");
  const app = typeof electron === "object" ? electron.app : undefined;
  const packaged = app?.isPackaged ?? (process.env.AGENTLAS_RUNTIME_APP_METADATA
    ? isPackagedRuntime() : /\.asar(?:[/\\]|$)/u.test(__filename));
  if (packaged) {
    const appRoot = optionalElectronAppPath() || path.resolve(__dirname, "../../..");
    const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")) as { main?: unknown };
    if (manifest.main !== "dist/electron/entry.js") throw new Error("science_chromium_helper_entry_update_required");
  }
  const args = [CHROMIUM_PRINT_HELPER_FLAG, `--agentlas-science-print-dir=${directory}`, `--agentlas-science-print-parent=${process.pid}`];
  // Electron's default app may load CJS through an ESM loader, where
  // require.main !== module. Use the same explicit bootstrap dispatch in dev.
  if (!packaged) args.unshift(path.join(__dirname, "..", "entry.js"));
  return { executable, args };
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Carry OS session essentials, not app DB paths, provider keys, Node injection
  // options, dev-server URLs, or ELECTRON_RUN_AS_NODE into the renderer host.
  for (const name of ["PATH", "Path", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

async function execute(job: PrintJob): Promise<ChromiumPrintResult> {
  let directory: string | undefined;
  try {
    if (job.cancelled) return { ok: false, engine: "chromium", reason: job.cancelled };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-print-"));
    fs.writeFileSync(path.join(directory, "input.html"), job.html, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const launch = helperLaunch(directory);
    const result = await new Promise<ChromiumPrintResult>((resolve) => {
      const child = spawn(launch.executable, launch.args, {
        cwd: directory, env: helperEnvironment(), stdio: ["pipe", "pipe", "pipe"],
        // This owned group is kept attached by its pipes, not unref'd or reused.
        detached: process.platform !== "win32", windowsHide: true,
      });
      job.child = child;
      let output = "";
      let receipt: ChromiumHelperResult | null = null;
      let processError: string | null = null;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        for (;;) {
          const newline = output.indexOf("\n");
          if (newline < 0) break;
          const line = output.slice(0, newline); output = output.slice(newline + 1);
          if (!line.startsWith(CHROMIUM_PRINT_RESULT_PREFIX)) continue;
          try {
            const parsed = JSON.parse(line.slice(CHROMIUM_PRINT_RESULT_PREFIX.length)) as ChromiumHelperResult;
            if (parsed.schema !== CHROMIUM_PRINT_SCHEMA || parsed.requestId !== job.requestId || typeof parsed.ok !== "boolean" || receipt) throw new Error("protocol");
            receipt = parsed;
          } catch { processError = "science_chromium_helper_protocol_invalid"; cancel(job, processError); }
        }
        if (output.length > 64_000) { processError = "science_chromium_helper_protocol_invalid"; cancel(job, processError); output = ""; }
      });
      // Drain Chromium diagnostics without retaining private HTML or unbounded logs.
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", error => { processError = chromiumPrintFailureReason(error); });
      child.on("close", (code) => {
        if (job.killTimer) clearTimeout(job.killTimer);
        // Reap a renderer still unwinding after its browser process crashed.
        killOwnedProcessGroup(child, "SIGKILL");
        if (job.cancelled || processError) { resolve({ ok: false, engine: "chromium", reason: job.cancelled || processError! }); return; }
        if (code !== 0 || !receipt?.ok) { resolve({ ok: false, engine: "chromium", reason: receipt?.reason || `science_chromium_helper_exited:${code ?? "signal"}` }); return; }
        try {
          const outputPath = path.join(directory!, "output.pdf");
          if (!fs.lstatSync(outputPath).isFile() || fs.lstatSync(outputPath).isSymbolicLink()) throw new Error("science_chromium_pdf_invalid");
          const bytes = fs.readFileSync(outputPath);
          if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("science_chromium_pdf_invalid");
          if (!receipt.readiness || !child.pid) throw new Error("science_chromium_helper_receipt_missing");
          resolve({ ok: true, engine: "chromium", bytes, chromium: {
            ...receipt.readiness, helperPid: child.pid, javascript: false, sandbox: true, network: "blocked",
          } });
        } catch (error) { resolve({ ok: false, engine: "chromium", reason: chromiumPrintFailureReason(error) }); }
      });
      child.stdin.write(`${JSON.stringify({ schema: CHROMIUM_PRINT_SCHEMA, type: "render", requestId: job.requestId })}\n`);
      if (job.cancelled) {
        const reason = job.cancelled; job.cancelled = null; cancel(job, reason);
      }
    });
    return result;
  } catch (error) {
    return { ok: false, engine: "chromium", reason: job.cancelled || chromiumPrintFailureReason(error) };
  } finally {
    if (directory) {
      try { fs.rmSync(directory, { recursive: true, force: true }); }
      catch { throw new Error("science_chromium_temporary_cleanup_failed"); }
    }
  }
}

function pump(): void {
  if (active || !queue.length) return;
  const job = queue.shift()!;
  active = job;
  settlement = (async () => {
    try { job.resolve(await execute(job)); }
    catch (error) { job.resolve({ ok: false, engine: "chromium", reason: chromiumPrintFailureReason(error) }); }
    finally {
      if (job.deadline) clearTimeout(job.deadline);
      job.detachSignal();
      active = null;
      pump();
    }
  })();
}

/** Serial admission prevents one renderer process tree per simultaneous request. */
export function printHtmlInChromiumHelper(html: string, options: ChromiumPdfOptions = {}): Promise<ChromiumPrintResult> {
  if (closing) return Promise.resolve({ ok: false, engine: "chromium", reason: "science_chromium_host_closed" });
  if (typeof html !== "string" || !html.trim()) return Promise.resolve({ ok: false, engine: "chromium", reason: "science_chromium_html_required" });
  const timeout = options.timeoutMs ?? 0;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) return Promise.resolve({ ok: false, engine: "chromium", reason: "science_chromium_deadline_invalid" });
  if (options.signal?.aborted) return Promise.resolve({ ok: false, engine: "chromium", reason: "science_chromium_cancelled" });
  return new Promise(resolve => {
    const job: PrintJob = { html, requestId: randomUUID(), resolve, cancelled: null, detachSignal: () => {} };
    const abort = () => cancel(job, "science_chromium_cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    job.detachSignal = () => options.signal?.removeEventListener("abort", abort);
    if (timeout > 0) job.deadline = setTimeout(() => cancel(job, "science_chromium_deadline_exceeded"), timeout);
    queue.push(job);
    pump();
  });
}

export async function closeChromiumPrintHelpers(): Promise<void> {
  closing = true;
  for (const job of [...queue]) cancel(job, "science_chromium_host_closed");
  if (active) cancel(active, "science_chromium_host_closed");
  await settlement;
}

onHostShutdown(() => { void closeChromiumPrintHelpers(); });
process.once("exit", () => { if (active?.child) killOwnedProcessGroup(active.child, "SIGKILL"); });
