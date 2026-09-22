import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

// This is intentionally not a transcript log. A helper can print prompts,
// credentials and private paths in an exception, so child output is counted
// and discarded before it reaches disk or Desktop's main.log.
const MAX_BYTES = 256 * 1024;
const ARCHIVES = 2;
const MAX_LINE_BYTES = 4 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_REASONS = new Set(["initial", "version_skew", "owner_mismatch", "timeout", "exited", "signal", "error", "unknown"]);
const SAFE_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);
const SAFE_PHASES = new Set([
  "identity_ready", "store_ready", "control_socket_ready", "control_socket_failed",
  "mobile_bridge_ready", "mobile_bridge_delegated", "mobile_bridge_failed", "mobile_bridge_recovery_failed",
  "claim_rollback_failed", "startup_failed", "shutdown_started", "parent_exited",
]);

function classifyDaemonLine(line: string): string | null {
  if (line.startsWith("[agentlasd] identity ready:")) return "identity_ready";
  if (line === "[agentlasd] store ready") return "store_ready";
  if (line.startsWith("[agentlasd] control socket:")) return "control_socket_ready";
  if (line.startsWith("[agentlasd] control socket failed to start:")) return "control_socket_failed";
  if (line === "[agentlasd] mobile bridge ready") return "mobile_bridge_ready";
  if (line === "[agentlasd] mobile bridge delegated to Desktop") return "mobile_bridge_delegated";
  if (line.startsWith("[agentlasd] mobile bridge failed to start:")) return "mobile_bridge_failed";
  if (line.startsWith("[agentlasd] Mobile Bridge recovery failed;")) return "mobile_bridge_recovery_failed";
  if (line.startsWith("[agentlasd] Mobile Bridge claim rollback failed;")) return "claim_rollback_failed";
  if (line.startsWith("[agentlasd] failed to start:")) return "startup_failed";
  if (line.includes(" — running shutdown hooks") && line.startsWith("[agentlasd] ")) return "shutdown_started";
  if (line.startsWith("[agentlasd] Desktop parent ") && line.includes(" exited;")) return "parent_exited";
  return null;
}

export type DaemonDiagnosticEvent =
  | "spawn_requested" | "spawn_ready" | "spawn_unready" | "spawn_exit"
  | "spawn_error" | "already_running" | "version_skew" | "owner_mismatch" | "shutdown_requested"
  | "shutdown_timeout" | "stdout_redacted" | "stderr_redacted" | "child_report";

export interface DaemonDiagnosticFields {
  appInstanceId?: string | null;
  bootId?: string | null;
  pid?: number | null;
  parentPid?: number | null;
  restartCount?: number;
  bytes?: number;
  lines?: number;
  reason?: "initial" | "version_skew" | "owner_mismatch" | "timeout" | "exited" | "signal" | "error" | "unknown";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  heartbeatAgeMs?: number;
  phase?: string;
}

const SAFE_INSTANCE_ID = /^desktop_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path is never returned or logged: compare the actual opened store handles
 * using a per-Desktop-instance digest, including through symlinked userData. */
export function storeIdentityDigest(storePath: string | null, appInstanceId: string | null): string | null {
  if (!storePath || !appInstanceId || !SAFE_INSTANCE_ID.test(appInstanceId)) return null;
  try {
    return createHash("sha256").update(`${appInstanceId}\0${fs.realpathSync(storePath)}`).digest("hex");
  } catch { return null; }
}

export function validAppInstanceId(value: unknown): value is string {
  return typeof value === "string" && SAFE_INSTANCE_ID.test(value);
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class DaemonDiagnosticLog {
  readonly filePath: string;

  constructor(userDataDir: string) {
    const directory = path.join(userDataDir, "diagnostics");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("daemon_diagnostics_directory_invalid");
    fs.chmodSync(directory, 0o700);
    this.filePath = path.join(directory, "agentlasd.log");
  }

  private rotateIfNeeded(incomingBytes: number): void {
    let size = 0;
    let ageMs = 0;
    try {
      const stat = fs.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("daemon_diagnostics_file_invalid");
      size = stat.size;
      ageMs = Date.now() - stat.mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size + incomingBytes > MAX_BYTES || ageMs > RETENTION_MS) {
      for (let index = ARCHIVES; index >= 1; index -= 1) {
        const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
        const target = `${this.filePath}.${index}`;
        try {
          const stat = fs.lstatSync(source);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("daemon_diagnostics_archive_invalid");
          fs.renameSync(source, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    for (let index = 1; index <= ARCHIVES; index += 1) {
      const archive = `${this.filePath}.${index}`;
      try {
        const stat = fs.lstatSync(archive);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("daemon_diagnostics_archive_invalid");
        if (Date.now() - stat.mtimeMs > RETENTION_MS) fs.unlinkSync(archive);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  record(event: DaemonDiagnosticEvent, fields: DaemonDiagnosticFields = {}): void {
    const payload = {
      at: new Date().toISOString(),
      processRole: "desktop-daemon",
      event,
      ...(validAppInstanceId(fields.appInstanceId) ? { appInstanceId: fields.appInstanceId } : {}),
      ...(typeof fields.bootId === "string" && SAFE_BOOT_ID.test(fields.bootId) ? { bootId: fields.bootId } : {}),
      ...(safeInteger(fields.pid) !== null ? { pid: fields.pid } : {}),
      ...(safeInteger(fields.parentPid) !== null ? { parentPid: fields.parentPid } : {}),
      ...(safeInteger(fields.restartCount) !== null ? { restartCount: fields.restartCount } : {}),
      ...(safeInteger(fields.bytes) !== null ? { bytes: fields.bytes } : {}),
      ...(safeInteger(fields.lines) !== null ? { lines: fields.lines } : {}),
      ...(safeInteger(fields.exitCode) !== null ? { exitCode: fields.exitCode } : {}),
      ...(safeInteger(fields.heartbeatAgeMs) !== null ? { heartbeatAgeMs: fields.heartbeatAgeMs } : {}),
      ...(fields.reason && SAFE_REASONS.has(fields.reason) ? { reason: fields.reason } : {}),
      ...(fields.signal && SAFE_SIGNALS.has(fields.signal) ? { signal: fields.signal } : {}),
      ...(fields.phase && SAFE_PHASES.has(fields.phase) ? { phase: fields.phase } : {}),
    };
    const line = `${JSON.stringify(payload)}\n`;
    this.rotateIfNeeded(Buffer.byteLength(line));
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
      (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(this.filePath, flags, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  }

  capture(stream: Readable | null, source: "stdout" | "stderr", pid: number | null,
    appInstanceId?: string): void {
    if (!stream) return;
    let pending = "";
    let discarded = false;
    const flush = (bytes: number) => {
      const phase = discarded ? null : classifyDaemonLine(pending);
      try {
        this.record(phase ? "child_report" : source === "stdout" ? "stdout_redacted" : "stderr_redacted", {
          pid, appInstanceId, bytes: Math.min(bytes, MAX_LINE_BYTES), lines: 1,
          ...(phase ? { phase } : {}),
        });
      } catch { /* Diagnostics must not crash the owner or leak raw output. */ }
      pending = "";
      discarded = false;
    };
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const byte of bytes) {
        if (byte === 10) { flush(pending.length + 1); continue; }
        if (!discarded && pending.length < MAX_LINE_BYTES) pending += String.fromCharCode(byte);
        else discarded = true;
      }
    });
    stream.on("end", () => { if (pending || discarded) flush(pending.length); });
  }
}
