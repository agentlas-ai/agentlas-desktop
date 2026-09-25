import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

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

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const tools = [
  {
    name: "get_current_time",
    description: "Get the current time in one IANA timezone.",
    annotations: READ_ONLY,
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
    annotations: READ_ONLY,
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

// Both tools carry MCP readOnlyHint (READ_ONLY above; kept terse because the
// source rides in argv). codex exec runs every write/automation turn with
// approval_policy "never" and refused each unannotated call before the server saw
// it: "MCP tool call requires approval, but approval policy is never" (Threads
// automation 2026-09-24 14:14Z/19:11Z, 2026-09-25 00:03Z; probed on codex-cli
// 0.156.1 — same source without the hint failed, with it completed).
// Contract: scripts/system-time-tools-are-read-only-contract.cjs.
//
// Keep the audited server in the signed Main bundle and launch it from an
// in-memory compressed payload. A pathname under ~/.agentlas (or even a
// packaged resource) can be replaced after validation but before the child
// process opens it. Exact argv removes that validate-then-open window across
// macOS, Windows portable/installers, and Linux packages.
const SYSTEM_TIME_SOURCE_SHA256 = createHash("sha256").update(SYSTEM_TIME_SERVER_SOURCE).digest("hex");
const SYSTEM_TIME_INLINE_BOOTSTRAP =
  `const z=require("node:zlib"),c=require("node:crypto"),v=require("node:vm"),b=z.gunzipSync(Buffer.from(process.argv[1],"base64"),{maxOutputLength:65536});` +
  `if(b.length>65536||c.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(SYSTEM_TIME_SOURCE_SHA256)})process.exit(78);` +
  `v.runInThisContext(b.toString("utf8"),{filename:"agentlas-system-time.cjs"});`;
const SYSTEM_TIME_INLINE_PAYLOAD = gzipSync(Buffer.from(SYSTEM_TIME_SERVER_SOURCE, "utf8"), {
  level: 9,
}).toString("base64");

/** Conservative guard for Claude's Windows .cmd command-line boundary. */
export const AGENTLAS_SYSTEM_TIME_INLINE_ARGS_MAX_JSON_CHARS = 4_096;

export function systemTimeMcpLaunchArgs(): string[] {
  return ["-e", SYSTEM_TIME_INLINE_BOOTSTRAP, SYSTEM_TIME_INLINE_PAYLOAD];
}

export function systemTimeMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(systemTimeMcpLaunchArgs()).length <= AGENTLAS_SYSTEM_TIME_INLINE_ARGS_MAX_JSON_CHARS;
}

export function systemTimeMcpSourceDigest(): string {
  return SYSTEM_TIME_SOURCE_SHA256;
}

/**
 * ★압축된 바이트로 판정하지 않는다 — 같은 병이 컴퓨터 유즈에서 실제로 터졌다
 * (2026-09-07: 소스 sha256 은 바이트까지 같은데 gzip 결과가 6372 vs 6424 로 달라
 * 설치된 서버가 "위조"로 걸려 MCP 설정에서 통째로 빠졌다. 화면엔 아무 오류도 없었다).
 * gzip 출력은 zlib 버전이 바뀌면 재현되지 않으므로, 앱 업데이트가 곧 기능 소멸이 된다.
 *
 * 지켜야 할 것은 "저 인자가 **우리 코드**를 실행하는가"다. 그러니 소스 해시로 판정한다.
 * 자세한 근거는 electron/computer-use/mcp-server.ts 의 같은 함수 주석에 있다.
 */
export function isAuthenticSystemTimeMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || path.resolve(command) !== path.resolve(process.execPath)) return false;
  if (!systemTimeMcpLaunchWithinBudget()) return false;
  if (args.length !== 3 || args[0] !== "-e" || args[1] !== SYSTEM_TIME_INLINE_BOOTSTRAP) return false;
  return systemTimeInlinePayloadDigest(args[2]) === SYSTEM_TIME_SOURCE_SHA256;
}

/** 인라인 payload 를 풀어 소스 sha256 을 낸다. 못 풀면 null. 상한은 부트스트랩과 같다. */
export function systemTimeInlinePayloadDigest(payloadBase64: string): string | null {
  try {
    if (typeof payloadBase64 !== "string" || payloadBase64.length > AGENTLAS_SYSTEM_TIME_INLINE_ARGS_MAX_JSON_CHARS) return null;
    const source = gunzipSync(Buffer.from(payloadBase64, "base64"), { maxOutputLength: 65_536 });
    if (source.length > 65_536) return null;
    return createHash("sha256").update(source).digest("hex");
  } catch {
    return null;
  }
}

export function isCanonicalSystemTimeMcpServer(server: {
  catalogId: string | null;
  configurationValid?: boolean;
  transport: string;
  command: string | null;
  args: readonly string[];
  url: string | null;
  envKeys: readonly string[];
}): boolean {
  return server.catalogId === AGENTLAS_SYSTEM_TIME_CATALOG_ID &&
    server.configurationValid !== false &&
    server.transport === "stdio" &&
    server.url === null &&
    server.envKeys.length === 0 &&
    isAuthenticSystemTimeMcpLaunch(server.command, server.args);
}
