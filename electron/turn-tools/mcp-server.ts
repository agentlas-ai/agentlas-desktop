import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { MEMORY_KINDS, MEMORY_SCOPES } from "../architecture/manifest";

/*
 * agentlas-turn: per-run built-in MCP server holding the typed replacements for the text control blocks a model used
 * to append to its reply (owner 2026-10-13: "we do not depend on prompts"). The child holds no authority: each call is
 * forwarded to Main's loopback control server (control-server.ts), which re-checks the run capability and feeds the
 * SAME pipeline the parsed block fed. The text parsers stay as the fallback for runtimes without this tool.
 *
 * Tools now: memory_note (replaces the `## Memory Events` envelope; the per-turn receipt/turn_summary is host-built).
 *
 * Must not import electron (the daemon loads it). The source rides in argv as an audited, hash-checked inline launch
 * (same contract as agent-mail / workspace-preview): no disk path exists to swap.
 */
export const AGENTLAS_TURN_CATALOG_ID = "agentlas-turn";
export const AGENT_TURN_CONTROL_ENV = "AGENTLAS_TURN_CONTROL_FILE";
export const AGENTLAS_TURN_TOOL_NAMES = ["memory_note", "goal_wait", "goal_complete"] as const;
/** Offered on every turn this server is attached to. goal_wait / goal_complete are added on Goal turns only (capability `tools`). */
export const TURN_TOOLS_BASE = ["memory_note"] as const;
export const TURN_TOOLS_GOAL = ["memory_note", "goal_wait", "goal_complete"] as const;
export const GOAL_WAIT_SUBJECT_KINDS = ["invocation", "artifact", "automation", "timer"] as const;
export const GOAL_WAIT_CONDITIONS = ["terminal", "changed", "due"] as const;

/** Scopes the tool offers: "agent_team" is only a legacy alias the text parser still maps to team_memory. */
export const MEMORY_NOTE_SCOPES = MEMORY_SCOPES.filter((scope) => scope !== "agent_team");
const idString = { type: "string", maxLength: 500 };

// Tool definitions are prompt tokens too (owner 2026-10-13): the schema carries the enums, the host validates and
// screens; the description says only what the schema cannot.
export const MEMORY_NOTE_DESCRIPTION =
  "Save one durable learning (owner preference, decision, risk, procedure) to curated memory. English content; the owner's own wording in content_native. Never secrets.";

export const AGENTLAS_TURN_TOOLS = [
  {
    name: "memory_note",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: MEMORY_NOTE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 4000 },
        content_native: { type: "string", maxLength: 4000 },
        memory_kind: { type: "string", enum: [...MEMORY_KINDS] },
        suggested_scope: { type: "string", enum: [...MEMORY_NOTE_SCOPES] },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        evidence: { type: "array", items: idString, maxItems: 20 },
        supersedes: { type: "string", pattern: "^h:[0-9a-f]{16}$" },
        request_context: { type: "object" },
      },
      required: ["content", "memory_kind", "suggested_scope"],
      additionalProperties: false,
    },
  },
  {
    name: "goal_wait",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Pause this Goal until an observed invocation ends, an artifact or saved automation output changes, or a time arrives, then end the turn; only real observed IDs.",
    inputSchema: {
      type: "object",
      properties: {
        subject_kind: { type: "string", enum: [...GOAL_WAIT_SUBJECT_KINDS] },
        condition: { type: "string", enum: [...GOAL_WAIT_CONDITIONS], description: "invocation=terminal, artifact/automation=changed, timer=due." },
        invocation_run_id: idString,
        chat_id: idString,
        artifact_id: idString,
        automation_id: idString,
        not_before: { type: "string", description: "Timer: future ISO timestamp." },
        next_action: { type: "string", minLength: 1, maxLength: 2000 },
        deadline: { type: "string", description: "Optional ISO timestamp." },
      },
      required: ["subject_kind", "condition", "next_action"],
      additionalProperties: false,
    },
  },
  {
    name: "goal_complete",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Declare that every acceptance criterion of this Goal is verified; never while work remains.",
    inputSchema: {
      type: "object",
      properties: { evidence: { type: "string", maxLength: 240, description: "What was verified and where." }, summary: { type: "string", maxLength: 240 } },
      additionalProperties: false,
    },
  },
] as const;

const SOURCE_HEAD = String.raw`"use strict";
const fs = require("node:fs");
const http = require("node:http");
const CONTROL_ENV = "AGENTLAS_TURN_CONTROL_FILE";
const MAX_REQUEST_BYTES = 128 * 1024;
`;
const SOURCE_TAIL = String.raw`function control() {
  const file = process.env[CONTROL_ENV];
  if (!file || file.length > 4096) throw new Error("Turn tools are not connected in this run.");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8192) throw new Error("Turn tool capability is invalid.");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("Turn tool capability permissions are invalid.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || typeof value.capabilityId !== "string") throw new Error("Turn tool capability is invalid.");
  return value;
}
function allowedTools() {
  try { const info = control(); if (Array.isArray(info.tools)) return info.tools; } catch { /* no capability: base tools only */ }
  return ["memory_note"];
}
function request(operation, args) {
  const info = control();
  const body = JSON.stringify({ operation, args, token: info.token, capabilityId: info.capabilityId });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new Error("Turn tool request is too large."));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: info.port, path: "/turn", method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, timeout: 30000 }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => { total += chunk.length; if (total <= MAX_REQUEST_BYTES) chunks.push(chunk); else req.destroy(new Error("Turn tool response is too large.")); });
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) reject(new Error(value.error || "turn-tool-failed")); else resolve(value.result); } catch { reject(new Error("Turn tool returned an invalid response.")); } });
    });
    req.once("timeout", () => req.destroy(new Error("Turn tool request timed out.")));
    req.once("error", reject);
    req.end(body);
  });
}
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-turn", version: "1.0.0" } };
  if (requestValue.method === "notifications/initialized") return undefined;
  if (requestValue.method === "ping") return {};
  if (requestValue.method === "tools/list") return { tools: tools.filter((tool) => allowedTools().includes(tool.name)) };
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  const args = requestValue.params && requestValue.params.arguments && typeof requestValue.params.arguments === "object" ? requestValue.params.arguments : {};
  if (!tools.some((tool) => tool.name === name) || !allowedTools().includes(name)) return Promise.resolve(error("Unknown agentlas-turn tool."));
  return request(name, args);
}
function line(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return; }
  Promise.resolve().then(() => handle(parsed)).then((result) => {
    if (parsed.id === undefined || result === undefined) return;
    const wireResult = parsed.method === "tools/call" ? (result && result.content ? result : text(result)) : result;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: wireResult }) + "\n");
  }).catch((err) => { if (parsed.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: error((err && err.message) || "turn-tool-failed") }) + "\n"); });
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) process.exit(78); let end; while ((end = input.indexOf("\n")) >= 0) { line(input.slice(0, end).replace(/\r$/, "")); input = input.slice(end + 1); } });
`;

const SOURCE = `${SOURCE_HEAD}const tools = ${JSON.stringify(AGENTLAS_TURN_TOOLS)};\n${SOURCE_TAIL}`;
const SOURCE_SHA256 = createHash("sha256").update(SOURCE).digest("hex");
const MAX_SOURCE_BYTES = 65_536;
const BOOTSTRAP =
  `const z=require("node:zlib"),c=require("node:crypto"),v=require("node:vm"),b=z.gunzipSync(Buffer.from(process.argv[1],"base64"),{maxOutputLength:${MAX_SOURCE_BYTES}});` +
  `if(b.length>${MAX_SOURCE_BYTES}||c.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(SOURCE_SHA256)})process.exit(78);` +
  `v.runInThisContext(b.toString("utf8"),{filename:"agentlas-turn.cjs"});`;
const PAYLOAD = gzipSync(Buffer.from(SOURCE, "utf8"), { level: 9 }).toString("base64");

export function turnToolsMcpLaunchArgs(): string[] {
  return ["-e", BOOTSTRAP, PAYLOAD];
}

// The bound is the spawn's command line (Windows caps a whole one at 32,767 chars).
export function turnToolsMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(turnToolsMcpLaunchArgs()).length <= 16_000;
}

export function turnToolsMcpSourceDigest(): string { return SOURCE_SHA256; }

/** Authenticity is the decompressed source hash, never the compressed bytes (zlib versions differ). */
export function isAuthenticTurnToolsMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || path.resolve(command) !== path.resolve(process.execPath) || !turnToolsMcpLaunchWithinBudget()) return false;
  if (args.length !== 3 || args[0] !== "-e" || args[1] !== BOOTSTRAP) return false;
  try {
    const source = gunzipSync(Buffer.from(args[2], "base64"), { maxOutputLength: MAX_SOURCE_BYTES });
    return source.length <= MAX_SOURCE_BYTES && createHash("sha256").update(source).digest("hex") === SOURCE_SHA256;
  } catch { return false; }
}

export function isCanonicalTurnToolsMcpServer(server: {
  catalogId: string | null;
  configurationValid?: boolean;
  transport: string;
  command: string | null;
  args: readonly string[];
  url: string | null;
  envKeys: readonly string[];
}): boolean {
  return server.catalogId === AGENTLAS_TURN_CATALOG_ID &&
    server.configurationValid !== false &&
    server.transport === "stdio" &&
    server.url === null &&
    server.envKeys.length === 0 &&
    isAuthenticTurnToolsMcpLaunch(server.command, server.args);
}
