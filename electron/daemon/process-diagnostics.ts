import { redactOperationalSecrets } from "../invocation/event-secret-redaction";

/**
 * The background service's own console output and uncaught errors, kept as typed codes (flow audit 2026-10-18, I-D1).
 *
 * Desktop spawns the service with stdio ignored (daemon/app-launcher.ts), and the service had no uncaughtException or
 * unhandledRejection listener: Node's default ended the process on the first one, so every daemon-owned run (Yotube
 * daemon turns, Hope, Alive, local models, Science) died with no stack and no code (W7 2026-10-17: an EPIPE ended the
 * service and Main only saw "child exited reason=error"). The 10-11..10-13 "database is locked" failures could not be
 * traced for the same reason: agentlasd.log held lifecycle lines only.
 *
 * Main logs and keeps running (logging.ts installMainProcessErrorSink); the service now does the same. What reaches
 * disk is never the raw text: a line keeps its bracket tag, its level and the typed codes in it (snake_case reason
 * codes, Node errno codes, ERR_* and SQLITE_*), after secrets are redacted and paths, URLs and quoted values are
 * dropped. An error keeps its name, its code and the names of the functions on its stack, never file paths or
 * arguments. Electron-free: the service runs as plain Node (ELECTRON_RUN_AS_NODE).
 */

export type DaemonConsoleLevel = "log" | "info" | "warn" | "error";
export type DaemonRuntimeEvent = "console_line" | "uncaught_exception" | "unhandled_rejection";
export interface DaemonRuntimeFields {
  level?: DaemonConsoleLevel;
  tag?: string | null;
  codes?: string[];
  errorCode?: string | null;
  errorName?: string | null;
  frames?: string[];
  suppressed?: number;
}

const SNAKE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,11}$/;
const ERR_CODE = /^ERR_[A-Z0-9_]{2,60}$/;
const SQLITE_CODE = /^SQLITE_[A-Z_]{2,40}$/;
const NODE_CODES = new Set([
  "EPIPE", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOENT", "EACCES", "EPERM", "EADDRINUSE", "ETIMEDOUT",
  "EMFILE", "ENFILE", "ENOSPC", "EBUSY", "EEXIST", "ENOTDIR", "EISDIR", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN",
  "ENOTEMPTY", "EINVAL", "ESRCH", "ENOTCONN", "EBADF",
]);
/** Words a typed code is made of, never free text that happens to contain an underscore. */
const PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bdatabase is locked\b/i, "sqlite_busy"],
  [/\bdatabase disk image is malformed\b/i, "sqlite_corrupt"],
  [/\bheap out of memory\b/i, "out_of_memory"],
];
const MAX_CODES = 8;
const MAX_FRAMES = 8;
const TAG = /^\s*\[([A-Za-z][A-Za-z0-9_.:-]{0,39})\]/;
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,40}$/;
const FRAME_NAME = /^[A-Za-z_$][\w$.<>]{0,80}$/;

/** A typed reason code (or Node/SQLite error code), else null. Long digit runs are ids, never codes. */
export function safeDiagnosticCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 3 || value.length > 80) return null;
  if (SNAKE_CODE.test(value)) return value.split("_").every((part) => part.length <= 32) && !/\d{6,}/.test(value) ? value : null;
  return NODE_CODES.has(value) || ERR_CODE.test(value) || SQLITE_CODE.test(value) ? value : null;
}

export function safeDiagnosticTag(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,39}$/.test(value) ? value : null;
}

export function safeDiagnosticErrorName(value: unknown): string | null {
  return typeof value === "string" && ERROR_NAME.test(value) ? value : null;
}

export function safeDiagnosticFrame(value: unknown): string | null {
  return typeof value === "string" && FRAME_NAME.test(value) ? value : null;
}

/** Typed codes in a console line or error message. Paths, URLs and quoted values go before the scan. */
export function diagnosticCodesInText(text: string): string[] {
  const masked = redactOperationalSecrets(text.slice(0, 16 * 1024))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, " ")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s,;)]*/g, " ");
  const codes: string[] = [];
  for (const [pattern, code] of PHRASES) if (pattern.test(masked) && !codes.includes(code)) codes.push(code);
  for (const token of masked.split(/[^A-Za-z0-9_]+/)) {
    if (codes.length >= MAX_CODES) break;
    const code = safeDiagnosticCode(token);
    if (code && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function ownCode(error: object): string | null {
  try {
    const code = (error as { code?: unknown }).code;
    return safeDiagnosticCode(code);
  } catch { return null; }
}

/** Function names on an error's stack, innermost first. File paths and arguments are never kept. */
export function diagnosticStackFrames(stack: unknown): string[] {
  if (typeof stack !== "string") return [];
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1, 40)) {
    const match = /^\s*at (?:async )?(?:new )?([^\s(]+)(?: \[as [^\]]+\])? \(/.exec(line);
    const name = match ? safeDiagnosticFrame(match[1]) : null;
    if (name) frames.push(name);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

export function diagnosticErrorShape(error: unknown): Required<Pick<DaemonRuntimeFields, "errorCode" | "errorName" | "frames" | "codes">> {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return { errorCode: null, errorName: null, frames: [], codes: typeof error === "string" ? diagnosticCodesInText(error) : [] };
  }
  let name: unknown, message: unknown, stack: unknown;
  try { name = (error as Error).name; message = (error as Error).message; stack = (error as Error).stack; } catch { /* a hostile proxy */ }
  return {
    errorCode: ownCode(error),
    errorName: safeDiagnosticErrorName(name),
    frames: diagnosticStackFrames(stack),
    codes: typeof message === "string" ? diagnosticCodesInText(message) : [],
  };
}

/** One console call as a typed line: tag of the first string, codes from the strings and from any error argument. */
export function diagnosticConsoleLine(level: DaemonConsoleLevel, args: readonly unknown[]): DaemonRuntimeFields {
  const first = typeof args[0] === "string" ? TAG.exec(args[0]) : null;
  const codes: string[] = [];
  let errorCode: string | null = null, errorName: string | null = null, frames: string[] = [];
  const add = (code: string) => { if (codes.length < MAX_CODES && !codes.includes(code)) codes.push(code); };
  for (const arg of args.slice(0, 8)) {
    if (typeof arg === "string") { for (const code of diagnosticCodesInText(arg)) add(code); continue; }
    if (arg && typeof arg === "object") {
      const shape = diagnosticErrorShape(arg);
      if (shape.errorCode) add(shape.errorCode);
      for (const code of shape.codes) add(code);
      if (!errorName && shape.errorName && (arg instanceof Error)) { errorName = shape.errorName; errorCode = shape.errorCode; frames = shape.frames; }
    }
  }
  return { level, tag: first ? safeDiagnosticTag(first[1].toLowerCase()) : null, codes,
    ...(errorName ? { errorName, errorCode, frames } : {}) };
}

export interface DaemonProcessDiagnosticsOptions {
  now?: () => number;
  /** Lines per minute: warnings and errors, and ordinary log lines, each on their own budget. */
  perMinute?: { alert: number; log: number };
  /** Test seam; the real process by default. */
  target?: NodeJS.Process;
  console?: Pick<Console, DaemonConsoleLevel>;
}

let installed = false;

/**
 * Install once per service process: a dead stdio pipe is ignored, an uncaught exception or unhandled rejection is
 * recorded and the service keeps running (the Main rule), and every console line is mirrored as a typed line.
 * The sink must not throw; a sink failure is swallowed so diagnostics never end the process.
 */
export function installDaemonProcessDiagnostics(
  sink: (event: DaemonRuntimeEvent, fields: DaemonRuntimeFields) => void,
  options: DaemonProcessDiagnosticsOptions = {},
): boolean {
  if (installed && !options.target) return false;
  if (!options.target) installed = true;
  const target = options.target ?? process;
  const out = options.console ?? console;
  const now = options.now ?? Date.now;
  const limits = options.perMinute ?? { alert: 120, log: 60 };
  let writing = false;
  const record = (event: DaemonRuntimeEvent, fields: DaemonRuntimeFields) => {
    if (writing) return;
    writing = true;
    try { sink(event, fields); } catch { /* Diagnostics never end or loop the service. */ } finally { writing = false; }
  };
  for (const stream of [target.stdout, target.stderr]) {
    try { stream?.on?.("error", () => { /* A closed pipe is not a service failure; never write back to it. */ }); } catch { /* no stream */ }
  }
  const originals = {} as Record<DaemonConsoleLevel, (...args: unknown[]) => void>;
  for (const level of ["log", "info", "warn", "error"] as const) originals[level] = out[level].bind(out);
  const fault = (event: "uncaught_exception" | "unhandled_rejection", error: unknown) => {
    const shape = diagnosticErrorShape(error);
    record(event, { errorCode: shape.errorCode, errorName: shape.errorName, frames: shape.frames, codes: shape.codes });
    try { originals.error(event === "uncaught_exception" ? "[agentlasd] uncaught exception" : "[agentlasd] unhandled rejection",
      shape.errorName ?? "", shape.errorCode ?? ""); } catch { /* stdio is ignored in production */ }
  };
  target.on("uncaughtException", (error) => fault("uncaught_exception", error));
  target.on("unhandledRejection", (reason) => fault("unhandled_rejection", reason));
  const windows = { alert: { start: 0, used: 0, suppressed: 0 }, log: { start: 0, used: 0, suppressed: 0 } };
  for (const level of ["log", "info", "warn", "error"] as const) {
    out[level] = (...args: unknown[]) => {
      try { originals[level](...args); } catch { /* stdio is ignored in production */ }
      if (writing) return;
      const bucket = level === "warn" || level === "error" ? windows.alert : windows.log;
      const budget = level === "warn" || level === "error" ? limits.alert : limits.log;
      const at = now();
      if (at - bucket.start >= 60_000) { bucket.start = at; bucket.used = 0; }
      if (bucket.used >= budget) { bucket.suppressed += 1; return; }
      bucket.used += 1;
      let fields: DaemonRuntimeFields;
      try { fields = diagnosticConsoleLine(level, args); } catch { return; }
      if (bucket.suppressed > 0) { fields.suppressed = bucket.suppressed; bucket.suppressed = 0; }
      record("console_line", fields);
    };
  }
  return true;
}
