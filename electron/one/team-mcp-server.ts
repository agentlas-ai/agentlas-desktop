import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { ONE_GRAPH_TOOLS, ONE_GRAPH_TOOL_NAMES } from "../../shared/graph-authoring";
import { ONE_SUPERVISOR_TOOLS, ONE_SUPERVISOR_TOOL_NAMES } from "../../shared/one-supervisor-tools";

// Built-in inline MCP server: One starts and steers a teammate's own session.
// The child holds no authority — each call is forwarded to Main's loopback
// control server (team-control-server.ts), which re-checks the caller chat.

export const AGENTLAS_ONE_TEAM_CATALOG_ID = "one-team";
export const ONE_TEAM_CONTROL_ENV = "AGENTLAS_ONE_TEAM_CONTROL_FILE";
export const AGENTLAS_ONE_TEAM_TOOL_NAMES = [
  "one_team_list",
  "one_team_start_session",
  "one_team_steer",
  "one_team_session_status",
  "one_team_create_member",
  "one_team_invite",
  "one_team_compose_group",
  ...ONE_GRAPH_TOOL_NAMES,
  ...ONE_SUPERVISOR_TOOL_NAMES,
] as const;

// Inline discovery uses concise guidance; canonical input schemas and annotations
// remain exact. This keeps the authenticated gzip launch below its 12k limit.
const INLINE_GRAPH_DESCRIPTIONS: Record<string, string> = {
  one_graph_schema: "Get canonical blueprint schema or installed MCP argument schema/digest by catalog_id. Include registration protocol only for typed monitor sources.",
  one_graph_inspect: "Inspect this conversation's saved graphs/revisions. Omit graph_id to list; node_ids, node_offset or offset/limit page large results. if_cache_key avoids unchanged instructions.",
  one_graph_save: "Compile/save blueprint. Updating needs graph_id/current expected_revision. Identical creation reuses its receipt. Enables if ready unless enabled:false; no implicit Goal/workspace grant.",
  one_graph_patch: "Update exact node instructions/MCP arguments and purpose with current expected_revision; preserves topology, runtime, effects and grants. Revise code via one_graph_save, not patch.",
  one_graph_set_enabled: "Enable exact inspected revision after connection/effect checks, or disable and Stop. Stop works with read permission. Never replaces a job.",
  one_graph_run: "Execute enabled graph with current expected_revision/stable request_id and named string input. Retries reuse execution. Wait up to 50s (default20); retain event_id and read one_graph_result if running.",
  one_graph_result: "Read your exact graph event; reads never execute. Wait up to50s; outputs/failures bounded. Page longer node output with node_id/offset/limit.",
  toolchain_create: "Delegate natural-language request to system orchestrator for generalized inputs/typed contracts/implementation/examples. It reuses existing capability or improves same ID; no task-graph migration. Stable request_id prevents retries duplicating assets.",
  toolchain_publish: "Validate draft version by real example executions and typed expected outputs. Only passed validation makes callable. Effectful validation needs explicit owner verification; never implicitly sends posts/payments.",
  toolchain_search: "Find callable capabilities; returns independent toolchain_id/version, typed schemas/examples. Check when_not_to_use; empty means work normally. Call toolchain_run or compose native toolchain_call; graph/MCP IDs differ.",
  toolchain_inspect: "Read independent asset contract/immutable versions, without source instructions. Omit version for stable release.",
  toolchain_run: "Run exact published asset/version with typed args/stable request_id. Identical retry returns receipt; changed args refused. Permissions cap implementation. Retain call_id/read toolchain_result if running.",
  toolchain_result: "Read your exact call's typed result/status by call_id; never executes, even after withdrawal. Unresolved effects are not success.",
  toolchain_report: "Report your call's wrong result with call_id/problem/expected. No automatic repair or cross-chat changes. Repair by new published version; prior pins stay unchanged.",
};
const INLINE_GRAPH_TOOLS = ONE_GRAPH_TOOLS.map((tool) => ({
  ...tool, description: INLINE_GRAPH_DESCRIPTIONS[tool.name] ?? tool.description,
}));

// control() bounds a capability's tool allow-list by this server's own catalog (`tools`), not a fixed count: a fixed
// 16 rejected every room's list of 17 non-supervisor tools in 1.2.61-1.2.62, so every One team tool failed with
// "One team capability is invalid." outside the personal One conversation (production 2026-10-05 16:39 UTC, Thread).
const SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const http = require("node:http");
const CONTROL_ENV = "AGENTLAS_ONE_TEAM_CONTROL_FILE";
const MAX_REQUEST_BYTES = 64 * 1024;
function control() {
  const file = process.env[CONTROL_ENV];
  if (!file || file.length > 4096) throw new Error("One team tools are not connected in this run.");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8192) throw new Error("One team capability is invalid.");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("One team capability permissions are invalid.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || typeof value.capabilityId !== "string") throw new Error("One team capability is invalid.");
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length > tools.length || value.tools.some((name) => typeof name !== "string" || !tools.some((tool) => tool.name === name)))) throw new Error("One team capability is invalid.");
  return value;
}
function allowedTools() {
  try { const info = control(); return Array.isArray(info.tools) ? info.tools : null; } catch { return null; }
}
function request(operation, input) {
  const info = control();
  const body = JSON.stringify({ ...input, operation, token: info.token, capabilityId: info.capabilityId });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new Error("One team request is too large."));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: info.port, path: "/one-team", method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, timeout: 200000 }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => { total += chunk.length; if (total <= 4 * MAX_REQUEST_BYTES) chunks.push(chunk); else req.destroy(new Error("One team response is too large.")); });
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) reject(new Error(value.error || "one-team-failed")); else resolve(value.result); } catch { reject(new Error("One team returned an invalid response.")); } });
    });
    req.once("timeout", () => req.destroy(new Error("One team request timed out.")));
    req.once("error", reject);
    req.end(body);
  });
}
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const session = { type: "string", minLength: 1, maxLength: 128, description: "session_id returned by one_team_start_session. It is an internal handle for these tools only: never show it to the owner (the conversation already shows an 'Open session' link)." };
const tools = [
  ...${JSON.stringify(INLINE_GRAPH_TOOLS)},
  { name: "one_team_list", annotations: ro, description: "List teammates with exact member ids/current work and sessions this conversation started with status.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "one_team_start_session", annotations: act, description: "Assign work to an existing teammate's own session. Write intent, purpose and done criteria. Starts immediately; identical member/brief reuses receipt. Default new_session:true; false continues latest session. Read one_team_session_status with wait_seconds or let completion wake this conversation. Tell owner confirmed owner_message; refusal means nothing started. Session ids are internal; UI shows Open session. Recover uncertain handoff via same request or one_team_list.", inputSchema: { type: "object", properties: { member: { type: "string", minLength: 1, maxLength: 200, description: "Teammate name or member id (see one_team_list)." }, brief: { type: "string", minLength: 1, maxLength: 8000 }, new_session: { type: "boolean", description: "Default true: a new session. false continues the teammate's latest session." } }, required: ["member", "brief"], additionalProperties: false } },
  { name: "one_team_steer", annotations: act, description: "Send a follow-up direction to a teammate session you started (queued after its current step if it is still working; reopens it if it had finished).", inputSchema: { type: "object", properties: { session_id: session, message: { type: "string", minLength: 1, maxLength: 8000 } }, required: ["session_id", "message"], additionalProperties: false } },
  { name: "one_team_session_status", annotations: ro, description: "Status of a teammate session you started; when finished, includes the teammate's final answer. wait_seconds (0-180) waits for it to finish first.", inputSchema: { type: "object", properties: { session_id: session, wait_seconds: { type: "integer", minimum: 0, maximum: 180 } }, required: ["session_id"], additionalProperties: false } },
  { name: "one_team_create_member", annotations: act, description: "Create teammate with own chat/memory/default character; default invite:true adds to this group. Use for owner-requested hiring or a missing specialist after one_team_list. Requires write/full. Existing name reuses teammate. Tell owner confirmed owner_message; refusal means nobody created. Delegate separately with one_team_start_session.", inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 80 }, role: { type: "string", maxLength: 100, description: "One line: what this teammate is responsible for." }, personality: { type: "string", maxLength: 1200 }, invite: { type: "boolean", description: "Default true: also add them to this group chat (ignored when this chat is not a group chat)." } }, required: ["name"], additionalProperties: false } },
  { name: "one_team_invite", annotations: act, description: "Invite an EXISTING teammate (see one_team_list) into this group chat. Use when the owner asks you to invite/bring/add a teammate to this group. It needs write or full permission and this conversation must be a group chat. A refusal (not a group chat, group full, unknown teammate) says exactly why and that the group is unchanged.", inputSchema: { type: "object", properties: { member: { type: "string", minLength: 1, maxLength: 200, description: "Teammate name or member id (see one_team_list)." } }, required: ["member"], additionalProperties: false } },
  { name: "one_team_compose_group", annotations: act, description: "Make this exact One conversation a group with specified EXISTING active local teammates, or add them to its existing group. Use only when the owner requests a group conversation. First check one_team_list.conversation and use exact member_id values from teammates; create a missing teammate separately. Needs write or full permission. Preserves this conversation, task, goal, messages and runtime. Never removes current members or starts work. Repeating the same composition returns the same group without duplicates. Check confirmed, created, added_member_ids and owner_message; hand work separately with one_team_start_session.", inputSchema: { type: "object", properties: { members: { type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 3, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$" }, description: "Exact member_id values returned by one_team_list for existing active local teammates." } }, required: ["members"], additionalProperties: false } },
];
tools.push(...${JSON.stringify(ONE_SUPERVISOR_TOOLS)});
function handle(requestValue) {
  if (requestValue.method === "initialize") {
    const consumer = allowedTools();
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-one-team", version: "1.0.0" },
      ...(consumer ? { instructions: "Toolchains are independent generalized capabilities with immutable versions. Before repeating work, call toolchain_search. If the returned contract fits (check when_not_to_use), use toolchain_run with toolchain_id, version, stable request_id and typed args matching input_schema. Read toolchain_result with call_id if running. An empty result means do the work normally. Graph ids and MCP tools are separate from Toolchain ids." } : {}) };
  }
  if (requestValue.method === "notifications/initialized" || requestValue.method === "ping") return requestValue.method === "ping" ? {} : undefined;
  const allowed = allowedTools();
  if (requestValue.method === "tools/list") return { tools: allowed ? tools.filter((tool) => allowed.includes(tool.name)) : tools };
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  if (allowed && !allowed.includes(name)) return Promise.resolve(error("This One team tool is not available in this conversation."));
  const args = requestValue.params && requestValue.params.arguments && typeof requestValue.params.arguments === "object" ? requestValue.params.arguments : {};
  if (name === "one_team_list") return request("list", {});
  if (name === "one_team_start_session") return request("start", { member: args.member, brief: args.brief, newSession: args.new_session });
  if (name === "one_team_steer") return request("steer", { sessionId: args.session_id, message: args.message });
  if (name === "one_team_session_status") return request("status", { sessionId: args.session_id, waitSeconds: args.wait_seconds });
  if (name === "one_team_create_member") return request("create", { name: args.name, role: args.role, personality: args.personality, invite: args.invite });
  if (name === "one_team_invite") return request("invite", { member: args.member });
  if (name === "one_team_compose_group") return request("compose_group", { members: args.members });
  if (${JSON.stringify(ONE_SUPERVISOR_TOOL_NAMES)}.includes(name)) return request("supervisor", { name, input: args });
  if (${JSON.stringify(ONE_GRAPH_TOOL_NAMES)}.includes(name)) return request("graph", { name, input: args });
  return Promise.resolve(error("Unknown One team tool."));
}
function line(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return; }
  Promise.resolve().then(() => handle(parsed)).then((result) => {
    if (parsed.id === undefined || result === undefined) return;
    const wireResult = parsed.method === "tools/call" ? (result && result.content ? result : text(result)) : result;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: wireResult }) + "\n");
  }).catch((err) => { if (parsed.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: error(err.message || "one-team-failed") }) + "\n"); });
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) process.exit(78); let end; while ((end = input.indexOf("\n")) >= 0) { line(input.slice(0, end).replace(/\r$/, "")); input = input.slice(end + 1); } });
`;

const SOURCE_SHA256 = createHash("sha256").update(SOURCE).digest("hex");
const BOOTSTRAP =
  `const z=require("node:zlib"),c=require("node:crypto"),v=require("node:vm"),b=z.gunzipSync(Buffer.from(process.argv[1],"base64"),{maxOutputLength:65536});` +
  `if(b.length>65536||c.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(SOURCE_SHA256)})process.exit(78);` +
  `v.runInThisContext(b.toString("utf8"),{filename:"agentlas-one-team.cjs"});`;
const PAYLOAD = gzipSync(Buffer.from(SOURCE, "utf8"), { level: 9 }).toString("base64");

export function oneTeamMcpLaunchArgs(): string[] {
  return ["-e", BOOTSTRAP, PAYLOAD];
}

export function oneTeamMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(oneTeamMcpLaunchArgs()).length <= 12_000;
}

export function isAuthenticOneTeamMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || command !== process.execPath || !oneTeamMcpLaunchWithinBudget()) return false;
  if (args.length !== 3 || args[0] !== "-e" || args[1] !== BOOTSTRAP) return false;
  try {
    return createHash("sha256").update(gunzipSync(Buffer.from(args[2], "base64"))).digest("hex") === SOURCE_SHA256;
  } catch {
    return false;
  }
}
