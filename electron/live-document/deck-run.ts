import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Runs a model-written pptxgenjs script and returns the .pptx bytes (document.deck.build, live-document/deck-ports.ts).
 *
 * The script is the model's own design: palette, fonts and layout are its choices, drawn with shapes, text boxes, tables and
 * native charts. The host owns the part that must not depend on the model: a bundled pptxgenjs (nothing is installed on the
 * person's computer), the process boundary and the file write.
 *
 * Boundary: the script runs in a child process of this app's own Node (ELECTRON_RUN_AS_NODE, so no `node` on PATH is needed)
 * under the same OS sandbox the graph code runner uses (workflow/code-runner.ts): macOS Seatbelt and Linux bubblewrap allow
 * writes to one private temp folder only, hide the secret folders and deny the network; Windows has no such boundary without
 * administrator rights, so there the child is process-isolated only and the result says so (`isolation`). The child gets an
 * allow-listed environment (no API keys). It never writes the person's files: it saves into the temp folder and the caller
 * writes the final path after checking the bytes.
 *
 * No electron import: the daemon loads the harness ports.
 */

export const DECK_SCRIPT_MAX_CHARS = 200_000;
export const DECK_OUTPUT_MAX_BYTES = 60 * 1024 * 1024;
export const DECK_TIMEOUT_DEFAULT_MS = 60_000;
export const DECK_TIMEOUT_MAX_MS = 120_000;
const STREAM_LIMIT = 64 * 1024;
const RESULT_MARKER = "__AGENTLAS_DECK_RESULT__";
const FAILURE_MARKER = "__AGENTLAS_DECK_FAILURE__";
/** Written on stdout the moment the model's script starts: a deadline before it is the runtime's, after it the script's. */
const STARTED_MARKER = "__AGENTLAS_DECK_SCRIPT_STARTED__";
/** The runner's stream markers (the gates write fake child output with them). */
export const DECK_RUN_MARKERS = { result: RESULT_MARKER, failure: FAILURE_MARKER, started: STARTED_MARKER } as const;

export type DeckIsolation = "os-sandboxed" | "process-isolated";

/**
 * Who a failure belongs to, decided from machine facts only (never from the wording of an error):
 * - host: the deck runtime itself: the child could not start or was killed before the script began (sandbox launch, missing
 *   binary, a runtime that did not start before the deadline), the bundled library or one of its packages could not be loaded
 *   (module resolution inside the app bundle), or the finished file could not be saved to the run's folder.
 * - script: the model's code: a syntax error, an exception it threw or caused, a forbidden module, a script that never returns.
 */
export type DeckFailureCause = "host" | "script";
/** Where the runner was when it failed: boot (loading the library), compile, run (the script), package (pptxgenjs writes the deck), save. */
export type DeckRunPhase = "boot" | "compile" | "run" | "package" | "save";

export type DeckRunResult =
  | { ok: true; bytes: Uint8Array; isolation: DeckIsolation; logs: string[]; seconds: number }
  | { ok: false; code: "deck_script_too_large" | "deck_runtime_unavailable" | "deck_runtime_failed" | "deck_script_failed" | "deck_script_timeout" | "deck_output_missing" | "deck_cancelled";
      reason: string; cause?: DeckFailureCause; phase?: DeckRunPhase; line?: number; logs?: string[]; isolation?: DeckIsolation; seconds?: number };

/**
 * The script's contract, as the child sees it. Kept as source text next to the host code (materialized into the temp folder
 * per run) so a packaged app needs no loose file and the host and child cannot drift apart.
 *
 * - `require("pptxgenjs")` and the `pptxgen` / `PptxGenJS` parameters are the same class: pptxgenjs with `writeFile` replaced, so
 *   a script that ends with `await pres.writeFile({ fileName: "x.pptx" })` saves to the host's temp file whatever the name.
 * - The script may `return pres`; without a return the last created instance is used; without any call the instance is saved.
 * - `require("path")` and nothing else: no fs, no child_process, no network modules.
 */
export const DECK_RUNNER_SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const path = require("node:path");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const OUT = process.env.AGENTLAS_DECK_OUT;
const instances = [];
const logs = [];
const exit = process.exit.bind(process);
let saved = false;
let phase = "boot";
// The failure handlers come before anything that can fail, the library load included: a load error used to reach the host as
// Node's own uncaught-error print, cut to its last lines (the require stack, without "Cannot find module ...").
function fail(error) {
  const text = String((error && error.stack) || error);
  const match = phase === "run" || phase === "compile" ? /<anonymous>:(\d+):\d+/.exec(text) : null;
  const report = { phase, error: String((error && error.message) || error).slice(0, 1500), code: error && typeof error.code === "string" ? error.code : undefined,
    requireStack: error && Array.isArray(error.requireStack) ? error.requireStack.slice(0, 4).map(String) : undefined,
    stack: text.split("\n").slice(0, 6).join("\n").slice(0, 1200), line: match ? Math.max(1, Number(match[1]) - 2) : undefined, logs };
  // Synchronous: process.exit right after an asynchronous pipe write can drop the report.
  try { fs.writeSync(2, "\n" + ${JSON.stringify(FAILURE_MARKER)} + JSON.stringify(report)); } catch (_) { /* nothing more to say */ }
  exit(1);
}
process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);
let Base;
try { Base = require(process.env.AGENTLAS_PPTXGENJS); } catch (error) { fail(error); }
class Deck extends Base {
  constructor(...args) { super(...args); instances.push(this); }
  async writeFile() { await persist(this); return OUT; }
}
async function persist(deck) {
  const before = phase;
  phase = "package";
  const data = await Base.prototype.write.call(deck, { outputType: "nodebuffer" });
  phase = "save";
  fs.writeFileSync(OUT, data);
  saved = true;
  phase = before;
}
// A script that ends the process itself is the script's failure, not a silent crash of the runtime.
process.exit = (code) => fail(new Error("the script called process.exit(" + (code === undefined ? "" : code) + "); end the script with return pres instead"));
const sandboxRequire = (name) => {
  if (name === "pptxgenjs") return Deck;
  if (name === "path" || name === "node:path") return path;
  throw new Error("module '" + name + "' is not available in document.deck.build (only 'pptxgenjs' and 'path'). Draw icons with shapes or text glyphs and charts with pres.addChart.");
};
// pptxgenjs reports its own repairs through the global console (a colour it could not read becomes black: "red" is not a valid
// scheme color or hex RGB). Collect every level, the library's and the script's, so the model is told instead of getting black text.
const seen = new Set();
for (const level of ["log", "info", "warn", "error"]) console[level] = (...args) => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 400);
  if (logs.length < 40 && !seen.has(line)) { seen.add(line); logs.push(line); }
};
const consoleShim = console;
(async () => {
  const source = fs.readFileSync(process.env.AGENTLAS_DECK_SCRIPT, "utf8");
  phase = "compile";
  const run = new AsyncFunction("require", "pptxgen", "PptxGenJS", "console", "path", source);
  phase = "run";
  fs.writeSync(1, "\n" + ${JSON.stringify(STARTED_MARKER)} + "\n");
  const returned = await run(sandboxRequire, Deck, Deck, consoleShim, path);
  const deck = returned && typeof returned.write === "function" ? returned : instances[instances.length - 1];
  if (!deck) throw new Error("the script created no pptxgen instance: start with const pres = new pptxgen(), and return pres at the end");
  if (!saved) await persist(deck);
  process.stdout.write("\n" + ${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ ok: true, logs }));
})().catch(fail);
`;

function pptxgenjsEntry(): string | null {
  try {
    const resolved = require.resolve("pptxgenjs");
    // A packaged app keeps node code in app.asar; a child process needs the real files (asarUnpack in electron-builder.yml).
    const unpacked = resolved.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    if (unpacked !== resolved && fs.existsSync(unpacked)) return unpacked;
    return resolved;
  } catch { return null; }
}

function allowedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "ComSpec", "PATHEXT"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

/** The child launch line for this OS: the OS sandbox where there is one, nothing on Windows (reported as process-isolated). */
async function launchLine(execPath: string, runner: string, tmp: string): Promise<{ file: string; args: string[]; isolation: DeckIsolation } | { error: string }> {
  if (process.platform === "darwin") {
    const sandboxExec = "/usr/bin/sandbox-exec";
    if (!fs.existsSync(sandboxExec)) return { error: "macOS sandbox-exec is missing, so the script is not run without its boundary" };
    try {
      const { buildSeatbeltProfile } = await import("../workflow/code-runner");
      const profile = buildSeatbeltProfile({ writable: [tmp], network: "denied" });
      return { file: sandboxExec, args: ["-p", profile, execPath, runner], isolation: "os-sandboxed" };
    } catch (error) { return { error: `the macOS sandbox profile could not be built: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}` }; }
  }
  if (process.platform === "linux") {
    try {
      const { buildBwrapArgs, linuxSandbox } = await import("../workflow/linux-sandbox");
      const bwrap = linuxSandbox();
      if (bwrap) return { file: bwrap.path, args: buildBwrapArgs({ writable: [tmp], network: "denied" }, execPath, [runner]), isolation: "os-sandboxed" };
    } catch { /* a host without bubblewrap runs process-isolated, like the graph code runner */ }
    return { file: execPath, args: [runner], isolation: "process-isolated" };
  }
  return { file: execPath, args: [runner], isolation: "process-isolated" };
}

const MODULE_LOAD_CODES = new Set(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_REQUIRE_ESM", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_DLOPEN_FAILED", "ERR_INVALID_PACKAGE_CONFIG"]);

/** The package a require stack entry belongs to (the last node_modules/<name> or node_modules/@scope/<name> in its path). */
function packageOf(file: string): string | undefined {
  const parts = file.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return undefined;
  return parts[at + 1].startsWith("@") && parts[at + 2] ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
}

/**
 * The first line of a crash print that says what happened ("Error: Cannot find module 'pako'", "sandbox-exec: ... Operation not
 * permitted", "FATAL ERROR: ... heap out of memory"), so a report keeps the key sentence instead of the tail of a stack. Used for
 * the words shown, never to decide who failed.
 */
export function keyErrorLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const key = lines.find((line) => /^(?:[A-Za-z]*Error(?: \[[A-Z_]+\])?:|FATAL ERROR|sandbox-exec:|bwrap:|Fatal|Abort|Segmentation)/.test(line))
    ?? lines.find((line) => !/^at\s|^-\s|^Require stack|^Node\.js v|^\^+$|^\{|^\}$/.test(line) && !/^\S+:\d+$/.test(line));
  return (key ?? "").slice(0, 400);
}

interface ChildReport { phase?: DeckRunPhase; error?: string; code?: string; requireStack?: string[]; stack?: string; line?: number; logs?: string[] }

/**
 * Who a failed child run belongs to, from machine facts: the runner's own report (its phase, the error's code and require stack),
 * whether the script had started, the exit code and signal. Exported for the gates.
 */
export function classifyDeckFailure(input: { exitCode: number | null; signal?: string | null; spawnError?: string; timedOut: boolean; timeoutMs: number; stdout: string; stderr: string; runnerFile?: string }):
  Extract<DeckRunResult, { ok: false }> {
  const started = input.stdout.includes(STARTED_MARKER);
  if (input.spawnError !== undefined) return { ok: false, code: "deck_runtime_failed", cause: "host", phase: "boot", reason: `the deck runtime could not be started (${input.spawnError.slice(0, 200)})` };
  if (input.timedOut) {
    return started
      ? { ok: false, code: "deck_script_timeout", cause: "script", phase: "run", reason: `the script ran longer than ${Math.round(input.timeoutMs / 1000)} seconds and was stopped` }
      : { ok: false, code: "deck_runtime_failed", cause: "host", phase: "boot", reason: `the deck runtime did not start the script within ${Math.round(input.timeoutMs / 1000)} seconds` };
  }
  const at = input.stderr.lastIndexOf(FAILURE_MARKER);
  let report: ChildReport | null = null;
  if (at >= 0) { try { report = JSON.parse(input.stderr.slice(at + FAILURE_MARKER.length)) as ChildReport; } catch { report = null; } }
  const exit = input.signal ? `signal ${input.signal}` : `exit code ${input.exitCode}`;
  if (!report) {
    const key = keyErrorLine(input.stderr);
    // Nothing from the runner: it never got going (sandbox or launch refused, binary crashed) or it died with no word while the
    // script ran (out of memory, killed). Before the script started it is the runtime; after, the script's own run.
    return started
      ? { ok: false, code: "deck_script_failed", cause: "script", phase: "run", reason: `the deck runtime stopped while the script ran (${exit})${key ? `: ${key}` : ""}` }
      : { ok: false, code: "deck_runtime_failed", cause: "host", phase: "boot", reason: `the deck runtime stopped before the script started (${exit})${key ? `: ${key}` : ""}` };
  }
  const message = (report.error ?? "").split(/\r?\n/)[0].trim() || keyErrorLine(report.stack ?? "") || `the child failed (${exit})`;
  const fromLibrary = (report.requireStack ?? []).some((file) => file !== input.runnerFile && !/[\\/]runner\.cjs$/.test(file));
  const moduleLoad = !!report.code && MODULE_LOAD_CODES.has(report.code);
  const phase = report.phase;
  const extra = { ...(report.logs?.length ? { logs: report.logs } : {}), ...(phase ? { phase } : {}) };
  if (phase === "boot" || phase === "save" || (moduleLoad && (fromLibrary || phase === "package"))) {
    const owner = moduleLoad ? packageOf(report.requireStack?.[0] ?? "") : undefined;
    const where = phase === "save" ? " while saving the finished deck" : moduleLoad ? ` (${owner ? `needed by ${owner}` : "needed by the bundled pptxgenjs"} inside this app's bundle)` : " while loading the bundled pptxgenjs";
    return { ok: false, code: "deck_runtime_failed", cause: "host", reason: `${message}${where}`.slice(0, 600), ...extra };
  }
  return { ok: false, code: "deck_script_failed", cause: "script", reason: (report.error ?? message).slice(0, 1500), ...(report.line ? { line: report.line } : {}), ...extra };
}

export async function runDeckScript(input: { script: string; timeoutMs?: number; signal?: AbortSignal }): Promise<DeckRunResult> {
  const script = String(input.script ?? "");
  if (!script.trim()) return { ok: false, code: "deck_script_failed", cause: "script", reason: "script is empty" };
  if (script.length > DECK_SCRIPT_MAX_CHARS) return { ok: false, code: "deck_script_too_large", cause: "script", reason: `the script is ${script.length} characters; the limit is ${DECK_SCRIPT_MAX_CHARS}` };
  const entry = pptxgenjsEntry();
  if (!entry) return { ok: false, code: "deck_runtime_unavailable", cause: "host", reason: "the pptxgenjs library bundled with this app could not be found" };
  const timeoutMs = Math.max(5_000, Math.min(DECK_TIMEOUT_MAX_MS, input.timeoutMs ?? DECK_TIMEOUT_DEFAULT_MS));
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-deck-")));
  const runner = path.join(tmp, "runner.cjs");
  const scriptFile = path.join(tmp, "deck.js");
  const outFile = path.join(tmp, "out.pptx");
  const startedAt = Date.now();
  try {
    fs.writeFileSync(runner, DECK_RUNNER_SOURCE, { mode: 0o600 });
    fs.writeFileSync(scriptFile, script, { mode: 0o600 });
    const line = await launchLine(process.execPath, runner, tmp);
    if ("error" in line) return { ok: false, code: "deck_runtime_unavailable", cause: "host", reason: line.error };
    const env = allowedEnv({ ELECTRON_RUN_AS_NODE: "1", AGENTLAS_PPTXGENJS: entry, AGENTLAS_DECK_OUT: outFile, AGENTLAS_DECK_SCRIPT: scriptFile });
    const { detachedSpawnOpts, trackRunChild } = await import("../runtime/exec");
    const { killCodeTree } = await import("../workflow/code-runner");
    const child = spawn(line.file, line.args, { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"], ...detachedSpawnOpts() });
    trackRunChild(child);
    let stdout = "", stderr = "", timedOut = false, cancelled = false, spawnError: string | undefined, signal: string | null = null;
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < STREAM_LIMIT) stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < STREAM_LIMIT) stderr += chunk.toString("utf8"); });
    const timer = setTimeout(() => { timedOut = true; killCodeTree(child); }, timeoutMs);
    const onAbort = () => { cancelled = true; killCodeTree(child); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", (error: NodeJS.ErrnoException) => { spawnError = error.code ?? error.message; resolve(-1); });
      child.on("close", (exit, killedBy) => { signal = killedBy; resolve(exit); });
    });
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    if (cancelled) return { ok: false, code: "deck_cancelled", reason: "the run was cancelled", isolation: line.isolation, seconds };
    if (timedOut || spawnError !== undefined || code !== 0) {
      return { ...classifyDeckFailure({ exitCode: code, signal, spawnError, timedOut, timeoutMs, stdout, stderr, runnerFile: runner }), isolation: line.isolation, seconds };
    }
    if (!fs.existsSync(outFile)) return { ok: false, code: "deck_output_missing", cause: "script", reason: "the script finished without saving a deck", isolation: line.isolation, seconds };
    const size = fs.statSync(outFile).size;
    if (size > DECK_OUTPUT_MAX_BYTES) return { ok: false, code: "deck_output_missing", reason: `the deck is ${Math.round(size / 1048576)} MB; the limit is ${Math.round(DECK_OUTPUT_MAX_BYTES / 1048576)} MB`, isolation: line.isolation, seconds };
    let logs: string[] = [];
    const marker = stdout.lastIndexOf(RESULT_MARKER);
    if (marker >= 0) { try { logs = (JSON.parse(stdout.slice(marker + RESULT_MARKER.length)) as { logs?: string[] }).logs ?? []; } catch { /* logs are best effort */ } }
    return { ok: true, bytes: new Uint8Array(fs.readFileSync(outFile)), isolation: line.isolation, logs, seconds };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the temp folder is this run's own */ }
  }
}
