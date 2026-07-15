import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * Durable main-process log file.
 *
 * Console output from a packaged Electron app goes nowhere the user can reach:
 * launching Agentlas.app from Finder discards stdout entirely. That made every
 * `[updater]` / `[mobile-bridge-relay]` diagnostic invisible in exactly the
 * situations they exist for — a silent auto-update failure or a remote relay
 * that never connects. Mirroring console output to a file under the platform's
 * standard log directory is what turns those messages into something a user can
 * actually send us.
 *
 * The existing console call sites are already written to be secret-free (tokens,
 * cookies, pairing codes and relay secrets are never passed to console). This
 * only changes WHERE those same lines land, so it must not become a reason to
 * start logging sensitive values.
 */

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_FILE = "main.log";
const PREVIOUS_LOG_FILE = "main.previous.log";

type ConsoleMethod = "log" | "info" | "warn" | "error";

let logStream: fs.WriteStream | null = null;
let activeLogPath: string | null = null;

function formatArgument(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Keeps exactly one previous log so a long-running install cannot fill the disk. */
function rotateIfOversized(file: string, previous: string): void {
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
    fs.rmSync(previous, { force: true });
    fs.renameSync(file, previous);
  } catch {
    // A missing or unreadable log is not a startup failure.
  }
}

/**
 * Mirrors console output into the platform log directory
 * (macOS: ~/Library/Logs/Agentlas, Windows: %APPDATA%/Agentlas/logs).
 * Returns the active log path, or null when logging could not be started —
 * logging must never prevent the app from booting.
 */
export function initFileLogging(): string | null {
  if (activeLogPath) return activeLogPath;
  try {
    const directory = app.getPath("logs");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, LOG_FILE);
    rotateIfOversized(file, path.join(directory, PREVIOUS_LOG_FILE));
    const stream = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
    stream.on("error", () => {
      // A broken log stream must not take the app down or spam the console.
      logStream = null;
    });
    logStream = stream;
    activeLogPath = file;

    for (const method of ["log", "info", "warn", "error"] as ConsoleMethod[]) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        original(...args);
        if (!logStream) return;
        try {
          const line = args.map(formatArgument).join(" ");
          logStream.write(`${new Date().toISOString()} [${method}] ${line}\n`);
        } catch {
          // Never let logging throw into a caller's control flow.
        }
      };
    }
    console.info(`[logging] main process log: ${file}`);
    return file;
  } catch {
    return null;
  }
}

/** Absolute path of the active log file, or null when file logging is off. */
export function mainLogFilePath(): string | null {
  return activeLogPath;
}
