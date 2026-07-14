import { createHash } from "node:crypto";
import path from "node:path";
import { gzipSync } from "node:zlib";

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

export function isAuthenticSystemTimeMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || path.resolve(command) !== path.resolve(process.execPath)) return false;
  const expected = systemTimeMcpLaunchArgs();
  return systemTimeMcpLaunchWithinBudget() &&
    args.length === expected.length && args.every((arg, index) => arg === expected[index]);
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
