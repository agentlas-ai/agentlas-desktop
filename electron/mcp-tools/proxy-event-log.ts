import fs from "node:fs";
import path from "node:path";
import { userDataDir } from "../runtime-paths";

/**
 * Operator-readable record of abnormal MCP proxy bridge events.
 *
 * Why a file of its own. The bridge lives in the process that runs the model: Main for window-hosted runs, the background
 * service for the personal agent and group rooms. The service's console output is counted and dropped on purpose
 * (daemon/diagnostic-log.ts), so every "[mcp-proxy] bridge closed ... reason=..." warning it raised never reached any log.
 * Production 1.3.3, 2026-10-12: all 26 proxied browser / computer-use calls of service-owned runs failed with "agentlas proxy
 * reconnecting (bridge_response_error)" (the other 794 calls, owned by the window process, all worked) and nothing said why.
 *
 * What may be written: event kind, server key, an 8-character handle prefix, a machine reason token, the code location that
 * ended the wire, counts and ages. Never a prompt, tool argument or result, URL, path, header or token.
 * File: <userData>/diagnostics/mcp-proxy.log (0600, 256 KB, two archives, 7 days), beside agentlasd.log.
 */
const MAX_BYTES = 256 * 1024;
const ARCHIVES = 2;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINES_PER_MINUTE = 120;
const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,79}$/;

export type McpProxyLogEvent = "closed" | "refused" | "result_withheld" | "result_truncated" | "upstream_failed";
export interface McpProxyLogFields {
  server?: string | null;
  handle?: string | null;
  initialized?: boolean;
  /** Machine reason token or a thrown value; reduced to a safe token before it is written. */
  reason?: unknown;
  /** Which part of the bridge ended the wire (a fixed vocabulary, not free text). */
  where?: string;
  inflight?: number;
  wireAgeMs?: number;
}

let windowStartedAt = 0;
let windowLines = 0;
let suppressed = 0;

/** A token an operator can grep for. Free text (paths, URLs, messages with spaces) collapses to the error class. */
export function safeProxyReason(cause: unknown): string {
  if (cause === undefined || cause === null) return "none";
  if (typeof cause === "string") {
    if (TOKEN.test(cause)) return cause;
    // "upstream_transport_error:<message>": keep the machine prefix, drop the free text.
    const prefix = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,59}):/.exec(cause);
    return prefix ? prefix[1] : "other";
  }
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && TOKEN.test(code)) return code;
    if (TOKEN.test(cause.message)) return cause.message;
    const name = TOKEN.test(cause.name) ? cause.name : "Error";
    return `error:${name}`;
  }
  return "other";
}

function token(value: unknown, fallback: string): string {
  return typeof value === "string" && TOKEN.test(value) ? value : fallback;
}

function role(): "main" | "service" {
  return process.type === "browser" && process.env.ELECTRON_RUN_AS_NODE !== "1" ? "main" : "service";
}

export function mcpProxyEventLogPath(): string {
  return path.join(userDataDir(), "diagnostics", "mcp-proxy.log");
}

function rotate(file: string, incoming: number): void {
  let size = 0, ageMs = 0;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("mcp_proxy_log_invalid");
    size = stat.size; ageMs = Date.now() - stat.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (size + incoming <= MAX_BYTES && ageMs <= RETENTION_MS) return;
  for (let index = ARCHIVES; index >= 1; index -= 1) {
    const source = index === 1 ? file : `${file}.${index - 1}`;
    try { fs.renameSync(source, `${file}.${index}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Never throws and never blocks a call: a diagnostic must not become a second failure. */
export function recordMcpProxyEvent(event: McpProxyLogEvent, fields: McpProxyLogFields = {}): void {
  try {
    const now = Date.now();
    if (now - windowStartedAt >= 60_000) {
      windowStartedAt = now; windowLines = 0;
      if (suppressed > 0) {
        const note = `${new Date(now).toISOString()} role=${role()} pid=${process.pid} event=suppressed count=${suppressed}\n`;
        suppressed = 0;
        append(note);
      }
    }
    if (windowLines >= MAX_LINES_PER_MINUTE) { suppressed++; return; }
    windowLines++;
    const parts = [
      new Date(now).toISOString(), `role=${role()}`, `pid=${process.pid}`, `event=${event}`,
      `server=${token(fields.server, "unknown")}`,
      ...(fields.handle ? [`handle=${token(String(fields.handle).slice(0, 8), "unknown")}`] : []),
      ...(fields.initialized === undefined ? [] : [`initialized=${fields.initialized ? "true" : "false"}`]),
      `reason=${safeProxyReason(fields.reason)}`,
      ...(fields.where ? [`where=${token(fields.where, "unknown")}`] : []),
      ...(Number.isSafeInteger(fields.inflight) ? [`inflight=${fields.inflight}`] : []),
      ...(Number.isSafeInteger(fields.wireAgeMs) ? [`wire_age_ms=${fields.wireAgeMs}`] : []),
    ];
    append(parts.join(" ") + "\n");
  } catch { /* best effort */ }
}

function append(line: string): void {
  const file = mcpProxyEventLogPath();
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  rotate(file, Buffer.byteLength(line));
  fs.appendFileSync(file, line, { mode: 0o600 });
}
