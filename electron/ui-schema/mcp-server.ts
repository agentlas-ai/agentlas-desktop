import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { intellectUiToolText } from "../../shared/intellect-ui-prompt";
import { SURFACE_PROTOCOL } from "../surface-emitter";
import { AUTOMATION_PROTOCOL } from "../automation-emitter";

/*
 * agentlas-ui: a keyless, read-only built-in MCP server with three tools, `read_ui_schema`,
 * `read_automation_protocol` (the recurring-run registration spec) and `read_surface_protocol` (the interactive surface spec, ~19K chars, which used to be inlined into the
 * system prompt by a keyword gate and on every One-team turn).
 *
 * Why a tool and not a prompt section: whether a turn needs the Intellect UI component schema
 * (~1.1k tokens) is the MODEL's decision, not a keyword list over the user's prompt. The system
 * prompt carries a one-line rule (INTELLECT_UI_CORE_RULE); when the model wants to render a
 * component it calls this tool and receives the schema. Nothing here touches the network, the
 * filesystem, Main, or any credential, and the module must not import electron (the daemon loads
 * it; a top-level electron import crash-looped the daemon once already).
 *
 * The text is embedded at build time and rides in argv as an audited, hash-checked inline source
 * (same launch contract as system-time / workspace-preview): there is no disk path to swap.
 */
export const AGENTLAS_UI_CATALOG_ID = "agentlas-ui";
export const AGENTLAS_UI_TOOL_NAMES = ["read_ui_schema", "read_surface_protocol", "read_automation_protocol"] as const;

const SOURCE_HEAD = String.raw`"use strict";
const MAX_REQUEST_BYTES = 64 * 1024;
`;
const SOURCE_TAIL = String.raw`const tools = [
  { name: "read_ui_schema", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "Return the chat's native UI component schema (agentlas-ui blocks) and the chart/visual block guidance. Read-only; call it before emitting any agentlas-ui, chart or visual block.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "read_surface_protocol", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "Return the spec for an interactive surface (tracker, dashboard, operating console or board the user returns to and acts on): the hidden manifest block, widgets, data, jobs and trust rules. Read it before emitting a surface; never emit one unread.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "read_automation_protocol", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "Return the spec for scheduling, monitoring or changing a recurring run: the ## Automation registration block, schedules, monitor sources, steps and rules. Read it before emitting an automation block; never emit one unread.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];
function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-ui", version: "1.0.0" } };
  if (requestValue.method === "notifications/initialized") return undefined;
  if (requestValue.method === "ping") return {};
  if (requestValue.method === "tools/list") return { tools };
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  if (name === "read_ui_schema") return { content: [{ type: "text", text: SCHEMA_TEXT }] };
  if (name === "read_surface_protocol") return { content: [{ type: "text", text: SURFACE_TEXT }] };
  if (name === "read_automation_protocol") return { content: [{ type: "text", text: AUTOMATION_TEXT }] };
  return { content: [{ type: "text", text: "Unknown agentlas-ui tool." }], isError: true };
}
function line(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return; }
  Promise.resolve().then(() => handle(parsed)).then((result) => {
    if (parsed.id === undefined || result === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }) + "\n");
  }).catch((err) => { if (parsed.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32601, message: (err && err.message) || "agentlas-ui-failed" } }) + "\n"); });
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) process.exit(78); let end; while ((end = input.indexOf("\n")) >= 0) { line(input.slice(0, end).replace(/\r$/, "")); input = input.slice(end + 1); } });
`;

const SOURCE = `${SOURCE_HEAD}const SCHEMA_TEXT = ${JSON.stringify(intellectUiToolText())};\nconst SURFACE_TEXT = ${JSON.stringify(SURFACE_PROTOCOL)};\nconst AUTOMATION_TEXT = ${JSON.stringify(AUTOMATION_PROTOCOL)};\n${SOURCE_TAIL}`;
const SOURCE_SHA256 = createHash("sha256").update(SOURCE).digest("hex");
const BOOTSTRAP =
  `const z=require("node:zlib"),c=require("node:crypto"),v=require("node:vm"),b=z.gunzipSync(Buffer.from(process.argv[1],"base64"),{maxOutputLength:131072});` +
  `if(b.length>131072||c.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(SOURCE_SHA256)})process.exit(78);` +
  `v.runInThisContext(b.toString("utf8"),{filename:"agentlas-ui.cjs"});`;
const PAYLOAD = gzipSync(Buffer.from(SOURCE, "utf8"), { level: 9 }).toString("base64");

export function uiSchemaMcpLaunchArgs(): string[] {
  return ["-e", BOOTSTRAP, PAYLOAD];
}

// The bound is the spawn's command line, not a prompt: Windows caps a whole command line at 32,767 chars,
// so the inline launch (bootstrap + gzip payload of both texts, ~14K) stays under 24,000 with headroom.
export function uiSchemaMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(uiSchemaMcpLaunchArgs()).length <= 24_000;
}

export function uiSchemaMcpSourceDigest(): string { return SOURCE_SHA256; }

/** Authenticity is the decompressed source hash, never the compressed bytes (zlib versions differ). */
export function isAuthenticUiSchemaMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || path.resolve(command) !== path.resolve(process.execPath) || !uiSchemaMcpLaunchWithinBudget()) return false;
  if (args.length !== 3 || args[0] !== "-e" || args[1] !== BOOTSTRAP) return false;
  try {
    const source = gunzipSync(Buffer.from(args[2], "base64"), { maxOutputLength: 131_072 });
    return source.length <= 131_072 && createHash("sha256").update(source).digest("hex") === SOURCE_SHA256;
  } catch { return false; }
}

export function isCanonicalUiSchemaMcpServer(server: {
  catalogId: string | null;
  configurationValid?: boolean;
  transport: string;
  command: string | null;
  args: readonly string[];
  url: string | null;
  envKeys: readonly string[];
}): boolean {
  return server.catalogId === AGENTLAS_UI_CATALOG_ID &&
    server.configurationValid !== false &&
    server.transport === "stdio" &&
    server.url === null &&
    server.envKeys.length === 0 &&
    isAuthenticUiSchemaMcpLaunch(server.command, server.args);
}
