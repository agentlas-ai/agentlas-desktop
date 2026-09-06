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

/**
 * A packaged app can inherit stdout/stderr from a short-lived launcher. Once
 * that launcher closes its pipe, Node's original console method may throw
 * EPIPE synchronously. Console mirroring is diagnostic-only, so a dead parent
 * pipe must never escape into Electron's main-process control flow.
 */
export function writeOriginalConsoleSafely(
  original: (...args: unknown[]) => void,
  args: unknown[],
): void {
  try {
    original(...args);
  } catch {
    // The durable file sink below remains authoritative when stdio is gone.
  }
}

let logStream: fs.WriteStream | null = null;
let activeLogPath: string | null = null;
/*
 * ★로그가 조용히 죽던 자리 둘 (실측 2026-08-27).
 *
 * 오너 기기에서 앱이 **네 시간 동안 한 줄도 남기지 않았다.** 프로세스는 살아 있는데
 * 로그도 업데이트도 멈춰 있었고, 로그가 없으니 무엇이 멈춘 건지 볼 수가 없었다 —
 * 로그가 존재하는 이유가 바로 그런 상황인데 그때 없어진다.
 *
 * ① 회전이 시작할 때 한 번만 돌았다. 오래 켜 두는 앱에서는 그 한 번이 지난 뒤로
 *    5MB 상한이 아무 의미가 없고 파일이 끝없이 자란다. 그래서 쓰면서도 잰다.
 * ② 스트림이 한 번 오류를 내면 `logStream = null` 로 **영구히** 꺼졌다. 다시 여는
 *    코드가 없어서 그 세션은 끝까지 침묵한다. 일시적인 오류 하나가 영구 실명이 된다.
 *    이제 다시 열어 본다 — 다만 무한히는 아니고, 정말 못 쓰는 디스크면 포기한다.
 */
let bytesSinceOpen = 0;
let reopenAttempts = 0;
let rotateFailures = 0;
let bytesSinceExistenceCheck = 0;
const MAX_REOPEN_ATTEMPTS = 5;
const MAX_ROTATE_FAILURES = 3;
/*
 * ★밖에서 로그를 치워도 앱은 모른다.
 *
 * 파일을 지워도 열린 손잡이는 살아 있어서 쓰기가 **성공한다** — 사라진 내용물에.
 * 오류가 안 나니 다시 열 계기도 없고, 그 뒤로 남는 줄이 하나도 없다. 오너 기기에서
 * 관찰된 침묵이 정확히 이 모양이었다. 그래서 가끔 "그 자리에 아직 파일이 있는가"를
 * 직접 확인한다. 줄마다 확인하면 비싸므로 일정량마다 한 번만 본다.
 */
const EXISTENCE_CHECK_BYTES = 256 * 1024;

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

/** Opens the log stream and arms the error handler. Returns false when it could not. */
function openLogStream(file: string): boolean {
  try {
    const stream = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
    stream.on("error", () => {
      // 스트림을 버리되 **영구히 끄지는 않는다.** 다음 줄이 다시 열어 본다.
      logStream = null;
    });
    logStream = stream;
    bytesSinceOpen = (() => {
      try { return fs.statSync(file).size; } catch { return 0; }
    })();
    return true;
  } catch {
    logStream = null;
    return false;
  }
}

/**
 * 이 줄을 쓸 수 있는 스트림을 돌려준다 — 필요하면 회전하고, 끊겼으면 다시 연다.
 *
 * 조용히 실패해도 되지만 **조용히 영원히** 실패해서는 안 된다. 그 차이가 이 함수다.
 */
function streamForWrite(byteLength: number): fs.WriteStream | null {
  const file = activeLogPath;
  if (!file) return null;
  if (bytesSinceOpen + byteLength >= MAX_LOG_BYTES && logStream) {
    /*
     * 쓰면서 상한에 닿았다 — 시작할 때 한 번 재는 것으로는 오래 켜 둔 앱을 못 지킨다.
     *
     * ★순서가 중요하다: **이름부터 바꾸고 그 다음에 닫는다.**
     *   처음엔 닫고 나서 파일 크기를 다시 재 회전 여부를 정했는데, 스트림 버퍼가 아직
     *   디스크에 안 내려간 상태라 크기가 작게 보여 회전이 거부됐다 — 게이트가 8.2MB 로
     *   자란 파일을 잡아냈다. 이미 얼마를 썼는지는 세고 있으니 다시 잴 이유가 없다.
     *   POSIX 에서 이름을 바꿔도 열린 손잡이는 같은 내용을 따라가므로, 그 뒤 닫으면
     *   버퍼가 옮겨진 파일로 흘러들어 한 줄도 잃지 않는다.
     */
    const previous = path.join(path.dirname(file), PREVIOUS_LOG_FILE);
    const closing = logStream;
    logStream = null;
    try {
      fs.rmSync(previous, { force: true });
      fs.renameSync(file, previous);
      rotateFailures = 0;
      try { closing.end(); } catch { /* 닫기 실패는 회전을 막지 않는다 */ }
    } catch {
      /*
       * 아직 옮길 파일이 없거나(스트림이 파일을 만들기 전) 이름을 못 바꾸는 플랫폼이다.
       * 카운터를 0으로 되돌리면 다음 회전까지 또 상한만큼 자라므로 **그대로 두고 다시
       * 시도한다.** 다만 무한히는 아니다 — 연속으로 실패하면 회전을 포기하고 계속 쓴다.
       * 커지는 파일이 침묵보다 낫다.
       */
      logStream = closing;
      rotateFailures += 1;
      if (rotateFailures >= MAX_ROTATE_FAILURES) {
        rotateFailures = 0;
        bytesSinceOpen = 0;
      }
      return logStream;
    }
  }
  bytesSinceExistenceCheck += byteLength;
  if (logStream && bytesSinceExistenceCheck >= EXISTENCE_CHECK_BYTES) {
    bytesSinceExistenceCheck = 0;
    if (!fs.existsSync(file)) {
      // 우리가 쓰던 파일이 사라졌다. 손잡이는 멀쩡해 보이지만 아무 데도 안 남는다.
      try { logStream.end(); } catch { /* 닫기 실패는 재개를 막지 않는다 */ }
      logStream = null;
      bytesSinceOpen = 0;
    }
  }
  if (!logStream) {
    if (reopenAttempts >= MAX_REOPEN_ATTEMPTS) return null;
    reopenAttempts += 1;
    if (!openLogStream(file)) return null;
    // 성공했으면 시도 횟수를 되돌린다 — 상한은 "연속 실패"에만 걸려야 한다.
    reopenAttempts = 0;
  }
  return logStream;
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
    activeLogPath = file;
    if (!openLogStream(file)) return null;

    for (const method of ["log", "info", "warn", "error"] as ConsoleMethod[]) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        writeOriginalConsoleSafely(original, args);
        try {
          const line = `${new Date().toISOString()} [${method}] ${args.map(formatArgument).join(" ")}\n`;
          const bytes = Buffer.byteLength(line);
          const stream = streamForWrite(bytes);
          if (!stream) return;
          stream.write(line);
          bytesSinceOpen += bytes;
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
