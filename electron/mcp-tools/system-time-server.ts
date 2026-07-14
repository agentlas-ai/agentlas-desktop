import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENTLAS_SYSTEM_TIME_CATALOG_ID = "agentlas-time";
export const AGENTLAS_SYSTEM_TIME_TOOL_NAMES = ["get_current_time", "convert_time"] as const;

const SYSTEM_TIME_SERVER_SOURCE = String.raw`"use strict";
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+.-]{0,63}(?:\/[A-Za-z0-9_+.-]{1,64}){0,3}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_REQUEST_BYTES = 64 * 1024;

function validZone(value) {
  const zone = typeof value === "string" ? value.trim() : "";
  if (!zone || zone.length > 160 || !TZ_RE.test(zone)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return null;
  }
}

function parts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

function offsetMinutes(date, timeZone) {
  const value = parts(date, timeZone).timeZoneName || "GMT";
  const match = value.match(/^GMT(?:(\+|-)(\d{1,2})(?::?(\d{2}))?)?$/);
  if (!match) return 0;
  const total = Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return match[1] === "-" ? -total : total;
}

function zonedIso(date, timeZone) {
  const value = parts(date, timeZone);
  const offset = offsetMinutes(date, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const suffix = sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
  return value.year + "-" + value.month + "-" + value.day + "T" + value.hour + ":" + value.minute + ":" + value.second + suffix;
}

function localWallClockUtc(sourceTimezone, hhmm) {
  const now = new Date();
  const source = parts(now, sourceTimezone);
  const [hour, minute] = hhmm.split(":").map(Number);
  const wallUtc = Date.UTC(Number(source.year), Number(source.month) - 1, Number(source.day), hour, minute, 0);
  let candidate = new Date(wallUtc - offsetMinutes(new Date(wallUtc), sourceTimezone) * 60_000);
  candidate = new Date(wallUtc - offsetMinutes(candidate, sourceTimezone) * 60_000);
  return candidate;
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const tools = [
  {
    name: "get_current_time",
    description: "Get the current time in one IANA timezone.",
    inputSchema: {
      type: "object",
      properties: { timezone: { type: "string", maxLength: 160 } },
      required: ["timezone"],
      additionalProperties: false,
    },
  },
  {
    name: "convert_time",
    description: "Convert today's HH:MM wall-clock time between two IANA timezones.",
    inputSchema: {
      type: "object",
      properties: {
        source_timezone: { type: "string", maxLength: 160 },
        time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
        target_timezone: { type: "string", maxLength: 160 },
      },
      required: ["source_timezone", "time", "target_timezone"],
      additionalProperties: false,
    },
  },
];

function handle(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "agentlas-system-time", version: "1.0.0" },
    };
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method !== "tools/call") throw Object.assign(new Error("Method not found"), { code: -32601 });
  const name = request.params && request.params.name;
  const args = request.params && request.params.arguments && typeof request.params.arguments === "object"
    ? request.params.arguments
    : {};
  if (name === "get_current_time") {
    const timezone = validZone(args.timezone);
    if (!timezone) return errorResult("A valid IANA timezone is required.");
    const now = new Date();
    return textResult({ timezone, datetime: zonedIso(now, timezone) });
  }
  if (name === "convert_time") {
    const sourceTimezone = validZone(args.source_timezone);
    const targetTimezone = validZone(args.target_timezone);
    const time = typeof args.time === "string" && TIME_RE.test(args.time) ? args.time : null;
    if (!sourceTimezone || !targetTimezone || !time) {
      return errorResult("Valid source_timezone, target_timezone, and 24-hour HH:MM are required.");
    }
    const sourceInstant = localWallClockUtc(sourceTimezone, time);
    return textResult({
      source: { timezone: sourceTimezone, datetime: zonedIso(sourceInstant, sourceTimezone) },
      target: { timezone: targetTimezone, datetime: zonedIso(sourceInstant, targetTimezone) },
    });
  }
  return errorResult("Unknown tool.");
}

function handleLine(line) {
  if (!line || Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    process.stderr.write("System Time MCP rejected an oversized request.\n");
    process.exit(78);
  }
  let request;
  try {
    request = JSON.parse(line);
    const result = handle(request);
    if (request.id === undefined || result === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  } catch (error) {
    if (!request || request.id === undefined) return;
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: Number(error && error.code) || -32603, message: "System Time MCP request failed." },
    }) + "\n");
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    handleLine(line);
  }
  if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
    process.stderr.write("System Time MCP rejected an oversized request.\n");
    process.exit(78);
  }
});
`;

export function systemTimeMcpServerPath(): string {
  const testRoot = process.env.AGENTLAS_E2E === "1" && path.isAbsolute(process.env.AGENTLAS_E2E_SYSTEM_TIME_ROOT ?? "")
    ? path.resolve(process.env.AGENTLAS_E2E_SYSTEM_TIME_ROOT!)
    : null;
  return path.join(testRoot ?? path.join(os.homedir(), ".agentlas"), "mcp", "agentlas-system-time.cjs");
}

export function systemTimeMcpSourceDigest(): string {
  return createHash("sha256").update(SYSTEM_TIME_SERVER_SOURCE).digest("hex");
}

function sameStableSystemTimeStat(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs &&
    a.birthtimeNs === b.birthtimeNs;
}

function sameSystemTimePathAndFdIdentity(pathStat: fs.BigIntStats, fdStat: fs.BigIntStats): boolean {
  if (pathStat.dev !== fdStat.dev || pathStat.mode !== fdStat.mode || pathStat.size !== fdStat.size) return false;
  if (pathStat.ino !== 0n || fdStat.ino !== 0n) return pathStat.ino === fdStat.ino;
  return pathStat.birthtimeNs === fdStat.birthtimeNs && pathStat.mtimeNs === fdStat.mtimeNs &&
    pathStat.ctimeNs === fdStat.ctimeNs;
}

/** Leaf-symlink-safe, bounded single-descriptor read used by materialization,
 * integrity checks, and the final MCP transport preflight. */
export function readStableSystemTimeMcpSource(file: string, enforcePrivateMode = false): Buffer | null {
  if (!path.isAbsolute(file)) return null;
  let fd: number | null = null;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const initial = fs.fstatSync(fd, { bigint: true });
    if (!initial.isFile() || initial.size < 1n || initial.size > 64n * 1024n) return null;
    const initialPath = fs.lstatSync(file, { bigint: true });
    if (initialPath.isSymbolicLink() || !initialPath.isFile() ||
        !sameSystemTimePathAndFdIdentity(initialPath, initial)) return null;
    if (enforcePrivateMode && process.platform !== "win32") fs.fchmodSync(fd, 0o600);

    const before = fs.fstatSync(fd, { bigint: true });
    const pathBefore = fs.lstatSync(file, { bigint: true });
    const canonicalBefore = fs.realpathSync.native(file);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() ||
        !sameSystemTimePathAndFdIdentity(pathBefore, before)) return null;
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extra, 0, 1, offset) !== 0) return null;
    const after = fs.fstatSync(fd, { bigint: true });
    const pathAfter = fs.lstatSync(file, { bigint: true });
    const canonicalAfter = fs.realpathSync.native(file);
    if (!sameStableSystemTimeStat(before, after) || pathAfter.isSymbolicLink() || !pathAfter.isFile() ||
        !sameSystemTimePathAndFdIdentity(pathAfter, after) || canonicalAfter !== canonicalBefore) return null;
    return bytes;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

export function materializeSystemTimeMcpServer(): string {
  const destination = systemTimeMcpServerPath();
  const root = path.dirname(path.dirname(destination));
  const directory = path.dirname(destination);
  const ensurePrivateDirectory = (candidate: string): { dev: number; ino: number } => {
    if (!fs.existsSync(candidate)) {
      try {
        fs.mkdirSync(candidate, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = fs.lstatSync(candidate);
    // lstat rejects a symlink at the controlled directory itself. Do not
    // reject macOS's normal /var -> /private/var ancestor mapping.
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Agentlas System Time MCP directory is unsafe.");
    }
    if (process.platform !== "win32") fs.chmodSync(candidate, 0o700);
    return { dev: stat.dev, ino: stat.ino };
  };
  const rootIdentity = ensurePrivateDirectory(root);
  const directoryIdentity = ensurePrivateDirectory(directory);
  const assertDirectoryIdentity = (candidate: string, expected: { dev: number; ino: number }) => {
    const stat = fs.lstatSync(candidate);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== expected.dev ||
      (expected.ino !== 0 && stat.ino !== expected.ino)
    ) throw new Error("Agentlas System Time MCP directory changed during materialization.");
  };
  let current: string | null = null;
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agentlas System Time MCP file is unsafe.");
    current = readStableSystemTimeMcpSource(destination)?.toString("utf8") ?? null;
  }
  if (current !== SYSTEM_TIME_SERVER_SOURCE) {
    const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, SYSTEM_TIME_SERVER_SOURCE, { encoding: "utf8", mode: 0o600, flag: "wx" });
      assertDirectoryIdentity(root, rootIdentity);
      assertDirectoryIdentity(directory, directoryIdentity);
      replaceSystemTimeMcpFileAtomically(temp, destination);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  assertDirectoryIdentity(root, rootIdentity);
  assertDirectoryIdentity(directory, directoryIdentity);
  // Another Desktop process may atomically install the same audited bytes
  // between our pathname checks. Retry only the stable read/identity proof;
  // never accept a mismatched digest and never rewrite based on a failed read.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const installed = readStableSystemTimeMcpSource(destination, true);
    if (installed && createHash("sha256").update(installed).digest("hex") === systemTimeMcpSourceDigest()) {
      return destination;
    }
    if (attempt < 7) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw new Error("Agentlas System Time MCP integrity verification failed.");
}

/** Windows cannot rename over an existing destination. Keep an old regular
 * file as a same-directory rollback until the new audited source is in place. */
export function replaceSystemTimeMcpFileAtomically(
  temp: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32" || !fs.existsSync(destination)) {
    fs.renameSync(temp, destination);
    return;
  }
  const existing = fs.lstatSync(destination);
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error("Agentlas System Time MCP file is unsafe.");
  }
  const backup = `${destination}.${process.pid}.${randomUUID()}.bak`;
  let backedUp = false;
  let installed = false;
  let preserveBackup = false;
  try {
    try {
      fs.renameSync(destination, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      fs.renameSync(temp, destination);
      installed = true;
    } catch (error) {
      // A concurrent materializer may already have installed the same audited
      // source. Never overwrite an unknown winner or restore over it.
      if (isAuthenticSystemTimeMcpSource(destination)) {
        installed = true;
        return;
      }
      if (backedUp && !fs.existsSync(destination)) {
        try {
          fs.renameSync(backup, destination);
          backedUp = false;
        } catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError(
            [error as Error, restoreError as Error],
            `Agentlas System Time MCP replacement failed; the previous source remains at ${backup}`,
          );
        }
      }
      if (backedUp) preserveBackup = true;
      throw error;
    }
  } finally {
    if (backedUp && installed && !preserveBackup) fs.rmSync(backup, { force: true });
  }
}

export function isAuthenticSystemTimeMcpSource(file: string): boolean {
  if (path.resolve(file) !== path.resolve(systemTimeMcpServerPath())) return false;
  const source = readStableSystemTimeMcpSource(file);
  return Boolean(source && createHash("sha256").update(source).digest("hex") === systemTimeMcpSourceDigest());
}
