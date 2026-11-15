import { BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS, defineBuiltinMcpLaunch } from "../mcp-tools/builtin-mcp-launch";
import { ONE_GRAPH_TOOLS, ONE_GRAPH_TOOL_NAMES } from "../../shared/graph-authoring";
import { ONE_SUPERVISOR_TOOLS, ONE_SUPERVISOR_TOOL_NAMES } from "../../shared/one-supervisor-tools";
import { ONE_PERSONAL_TOOLS, ONE_PERSONAL_TOOL_NAMES } from '../../shared/one-personal-tools';
import { ONE_HISTORY_TOOLS, ONE_HISTORY_TOOL_NAMES } from '../../shared/one-history-tools';
import { WORK_SESSION_TOOL_NAMES } from "../../shared/work-session-tools";
import { workSessionToolDefinitions } from "../work/session-policy";

// Built-in inline MCP server: One starts and steers a teammate's own session.
// The child holds no authority — each call is forwarded to Main's loopback
// control server (team-control-server.ts), which re-checks the caller chat.

export const AGENTLAS_ONE_TEAM_CATALOG_ID = "one-team";
export const ONE_TEAM_CONTROL_ENV = "AGENTLAS_ONE_TEAM_CONTROL_FILE";
export const AGENTLAS_ONE_TEAM_TOOL_NAMES = [
  "one_team_list",
  "one_team_start_session",
  "one_team_steer",
  "one_team_stop",
  "one_team_session_status",
  "one_team_create_member",
  "one_team_new_chat",
  "one_team_add_to_chat",
  "one_team_attach_project",
  ...ONE_GRAPH_TOOL_NAMES,
  ...ONE_SUPERVISOR_TOOL_NAMES,
  ...ONE_PERSONAL_TOOL_NAMES,
  ...ONE_HISTORY_TOOL_NAMES,
  ...WORK_SESSION_TOOL_NAMES,
] as const;

/** The room, add-to-room and project tools (Agentlas 2.0 D5): the personal agent's own conversation only; team-control-server.ts takes them out of every other capability's list. */
export const PERSONAL_ROOM_TOOL_NAMES = ["one_team_new_chat", "one_team_add_to_chat", "one_team_attach_project"] as const;

/** Offered only to a teammate working on a hand-off from a group room (its own capability), never to One. */
export const ROOM_MEMBER_TOOL_NAMES = ["room_say"] as const;
/**
 * A message to another conversation of the same project (Agentlas 2.0 N6). Granted per capability, never listed by default: only a conversation
 * of a project that has another conversation to write to carries it (electron/harness/peer-tool.ts), so every other turn's tool list is unchanged.
 */
export const PEER_MESSAGE_TOOL_NAMES = ["message_send"] as const;
/**
 * Per-item outside-effect tools (one/graph-effect-items.ts): offered only to a session acting for a room-saved graph
 * step (its graph-step grant, or a teammate on a dispatch that step owns), never to an unscoped One conversation.
 */
export const GRAPH_EFFECT_ITEM_TOOL_NAMES = ["effect_item_check", "effect_item_record"] as const;

// Inline discovery uses concise guidance; canonical input schemas and annotations remain exact. (Written to fit the
// former 12k argv budget; the launch no longer carries the source, so lengthening these is a prompt change for an A/B.)
const INLINE_GRAPH_DESCRIPTIONS: Record<string, string> = {
  one_graph_schema: "Get canonical blueprint schema or installed MCP argument schema/digest by catalog_id. Include registration protocol only for typed monitor sources.",
  one_graph_inspect: "Inspect this conversation's saved graphs/revisions. Omit graph_id to list; node_ids, node_offset or offset/limit page large results. if_cache_key avoids unchanged instructions.",
  one_graph_save: "For work that comes back with different inputs or on a schedule (find topics, then the team works on the result; monitor performance). Never for one occasion (episode 20, the 19th's report): do that directly, or pass the date or item as an input. Never for fixed code or tool steps alone: that is a tool (toolchain_create). Compile/save blueprint. Updating needs graph_id/current expected_revision. Identical creation reuses its receipt. Enables if ready unless enabled:false; no implicit Goal/workspace grant.",
  one_graph_patch: "Update exact node instructions/MCP arguments and purpose with current expected_revision; preserves topology, runtime, effects and grants. Revise code via one_graph_save, not patch.",
  one_graph_set_enabled: "Enable exact inspected revision after connection/effect checks, or disable and Stop. Stop works with read permission. Never replaces a job.",
  one_graph_run: "Execute enabled graph with current expected_revision/stable request_id and named string input. Retries reuse execution. Wait up to 50s (default20); retain event_id and read one_graph_result if running.",
  one_graph_result: "Read your exact graph event; reads never execute. Wait up to50s; outputs/failures bounded. Page longer node output with node_id/offset/limit.",
  toolchain_create: "A deterministic MCP-style tool for an app or page you keep operating by hand (a desktop app with no MCP such as Blender; a browser flow such as posting to Threads): one asset per capability, never per task/topic/version. Not for workflows or schedules (those are graphs) and not for one-off work. Delegate natural-language request to system orchestrator for generalized inputs/typed contracts/implementation/examples. It reuses existing capability or improves same ID; no task-graph migration. Stable request_id prevents retries duplicating assets.",
  toolchain_publish: "Validate draft version by real example executions and typed expected outputs. Only passed validation makes callable. Effectful validation needs explicit owner verification; never implicitly sends posts/payments.",
  toolchain_search: "Callable Toolchains are already tc_ tools. Before operating an app or page by hand where no tc_ tool fits, call this: it may find one not listed yet. Returns toolchain_id/version, typed schemas/examples; check when_not_to_use; empty means work normally. Run with toolchain_run or a graph's native toolchain_call; graph/MCP IDs differ.",
  toolchain_inspect: "Read independent asset contract/immutable versions, without source instructions. Omit version for stable release.",
  toolchain_run: "Run exact published asset/version with typed args/stable request_id. Identical retry returns receipt; changed args refused. Permissions cap implementation. Retain call_id/read toolchain_result if running.",
  toolchain_result: "Read your exact call's typed result/status by call_id; never executes, even after withdrawal. Unresolved effects are not success.",
  toolchain_report: "Report your call's wrong result with call_id/problem/expected. No automatic repair or cross-chat changes. Then continue without that toolchain. Repair by new published version; prior pins stay unchanged.",
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
  let stat;
  // The file is removed when the run that granted it ends, is stopped or is replaced: say that, not the raw lstat error.
  try { stat = fs.lstatSync(file); } catch (e) { throw e && e.code === "ENOENT" ? new Error("One team tools are no longer available in this turn: the run that granted them has ended or was replaced. Do not call them again in this turn; tell the owner what you could not do.") : e; }
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
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) reject(new Error(value.error || "one-team-failed")); else resolve(value.isError === true ? { content: [{ type: "text", text: JSON.stringify(value.result) }], isError: true, _meta: { "agentlas/errorCode": String(value.errorCode || "tool_failed") } } : value.result); } catch { reject(new Error("One team returned an invalid response.")); } });
    });
    req.once("timeout", () => req.destroy(new Error("One team request timed out.")));
    req.once("error", reject);
    req.end(body);
  });
}
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const TOOLCHAIN_TOOL = /^tc_[a-z0-9_]{1,46}$/;
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const session = { type: "string", minLength: 1, maxLength: 128, description: "session_id returned by one_team_start_session. It is an internal handle for these tools only: never show it to the owner (the conversation already shows an 'Open session' link)." };
const tools = [
  ...${JSON.stringify(workSessionToolDefinitions())},
  ...${JSON.stringify(INLINE_GRAPH_TOOLS)},
  { name: "one_team_list", annotations: ro, description: "List registered agents (name, id, can_start, can_join_chat) and sessions this conversation started with status. Optional query narrows by name or description; limit pages (default 20, see roster.total).", inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 120 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: "one_team_start_session", annotations: act, description: "Assign work to an existing registered agent's own session. Write intent, purpose and done criteria. Starts immediately; identical member/brief reuses receipt. By default continue this room's latest session with that agent; new_session:true explicitly isolates a new conversation. Completion wakes this conversation: end your turn, do not poll. Tell owner confirmed owner_message; refusal means nothing started. Session ids are internal; UI shows Open session. Recover uncertain handoff via same request or one_team_list.", inputSchema: { type: "object", properties: { member: { type: "string", minLength: 1, maxLength: 200, description: "Agent name or member id (see one_team_list)." }, brief: { type: "string", minLength: 1, maxLength: 8000 }, new_session: { type: "boolean", description: "Default false: continue this room's latest session with that agent. true explicitly starts an isolated new conversation." } }, required: ["member", "brief"], additionalProperties: false } },
  { name: "one_team_steer", annotations: act, description: "Send a follow-up direction to an agent session you started (queued after its current step if it is still working; reopens it if it had finished).", inputSchema: { type: "object", properties: { session_id: session, message: { type: "string", minLength: 1, maxLength: 8000 } }, required: ["session_id", "message"], additionalProperties: false } },
  { name: "one_team_stop", annotations: act, description: "Stop an agent job you started, running or queued, because the owner replaced or withdrew it (for example gave it to another agent or said to drop it). Not for a job that is only slow. Nothing is reported afterwards: tell the owner it was stopped.", inputSchema: { type: "object", properties: { session_id: session }, required: ["session_id"], additionalProperties: false } },
  { name: "one_team_session_status", annotations: ro, description: "Status of an agent session you started; final answer once finished. While running it says next=end_turn (max 2 reads/session per turn); completion wakes you.", inputSchema: { type: "object", properties: { session_id: session, wait_seconds: { type: "integer", minimum: 0, maximum: 180 } }, required: ["session_id"], additionalProperties: false } },
  { name: "one_team_create_member", annotations: act, description: "Create an agent with own chat/memory/default character. Use for owner-requested hiring or a missing specialist after one_team_list. Requires write/full. Existing name reuses the agent. Tell owner confirmed owner_message; refusal means nobody created. Then use one_team_new_chat or one_team_start_session.", inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 80 }, role: { type: "string", maxLength: 100, description: "One line: what this agent is responsible for." }, personality: { type: "string", maxLength: 1200 } }, required: ["name"], additionalProperties: false } },
  { name: "one_team_new_chat", annotations: act, description: "Open a NEW Agent Chat with registered agents, as the owner's New chat does: one agent = a one-to-one chat, two or more = a group room led by the first. Optional project_id. Needs write or full. Sends nothing: speak into it with one_chat_send (chat_id). Check confirmed, chat_id, kind, owner_message. An unregistered agent is refused with the words to register it; nothing was opened.", inputSchema: { type: "object", properties: { members: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 200 }, description: "Agent names or member_id values from one_team_list; the first leads a group." }, project_id: { type: "string", maxLength: 200, description: "A project id from one_app_call projects.list." }, title: { type: "string", maxLength: 80 } }, required: ["members"], additionalProperties: false } },
  { name: "one_team_add_to_chat", annotations: act, description: "Add registered agents to an existing Agent Chat room (a one-to-one becomes a group, its agent stays the lead). New agents read the room only from the moment they join. Not for your own conversation. Needs write or full. Starts no work, sends nothing.", inputSchema: { type: "object", properties: { chat_id: { type: "string", minLength: 1, maxLength: 128 }, members: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", minLength: 1, maxLength: 200 } } }, required: ["chat_id", "members"], additionalProperties: false } },
  { name: "one_team_attach_project", annotations: act, description: "Join a Work session that has no project to an existing project, as the owner's join does: from its next turn it uses the project's folder and memory. A running turn is refused (try again when it ends). Needs write or full.", inputSchema: { type: "object", properties: { chat_id: { type: "string", minLength: 1, maxLength: 128 }, project_id: { type: "string", minLength: 1, maxLength: 200 } }, required: ["chat_id", "project_id"], additionalProperties: false } },
];
tools.push({ name: "room_say", annotations: act, description: "Post a short message in the group room as yourself while you work: hand off, ask another agent, or answer a message. to = an agent's name, or One (the personal agent that runs this room); reply_to = a room message id.", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 4000 }, to: { type: "string", maxLength: 200 }, reply_to: { type: "string", maxLength: 128 } }, required: ["text"], additionalProperties: false } });
tools.push({ name: "message_send", annotations: act, description: "Send a message to another conversation of this project: a session, or a group room (its lead receives it). It is delivered after that conversation's current turn; an answer, if any, comes back to you as a message. to = its title or id. The first one asks the owner.", inputSchema: { type: "object", properties: { to: { type: "string", minLength: 1, maxLength: 200 }, text: { type: "string", minLength: 1, maxLength: 4000 }, reply_to: { type: "string", maxLength: 128 } }, required: ["to", "text"], additionalProperties: false } });
const itemKey = { type: "string", minLength: 1, maxLength: 200, description: "One work item's key, same in every retry (e.g. 2026-10-17-time-machine-longform)." };
tools.push({ name: "effect_item_check", annotations: ro, description: "Before publishing a work item (upload/post/send) for this automation. published = done, never publish it again; not_published = publish it, then effect_item_record. A publish click without a check is refused.", inputSchema: { type: "object", properties: { item_key: itemKey }, required: ["item_key"], additionalProperties: false } });
tools.push({ name: "effect_item_record", annotations: act, description: "After publishing, record the id the site returned (e.g. YouTube video id) under the same item_key. First record wins; a different id is refused.", inputSchema: { type: "object", properties: { item_key: itemKey, external_id: { type: "string", minLength: 1, maxLength: 512 } }, required: ["item_key", "external_id"], additionalProperties: false } });
tools.push(...${JSON.stringify(ONE_SUPERVISOR_TOOLS)});
tools.push(...${JSON.stringify(ONE_PERSONAL_TOOLS)});
tools.push(...${JSON.stringify(ONE_HISTORY_TOOLS)});
function handle(requestValue) {
  if (requestValue.method === "initialize") {
    const consumer = allowedTools();
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-one-team", version: "1.0.0" },
      ...(consumer && !(consumer.length === 1 && consumer[0] === "message_send") ? { instructions: "Tools named tc_... are Toolchains: deterministic tools for an app or web page that was operated by hand before. When one fits (check its Not for), call it instead of doing those steps yourself; if it fails, do the work your own way. Before operating an app or page by hand where no tc_ tool fits, call toolchain_search: it may find one not listed yet, run with toolchain_run (toolchain_id, version, stable request_id, args matching input_schema). Read toolchain_result with call_id while a call is running. An empty result means do the work normally. Graph ids and MCP tools are separate from Toolchain ids." } : {}) };
  }
  if (requestValue.method === "notifications/initialized" || requestValue.method === "ping") return requestValue.method === "ping" ? {} : undefined;
  const allowed = allowedTools();
  if (requestValue.method === "tools/list") {
    const base = allowed ? tools.filter((tool) => allowed.includes(tool.name)) : tools.filter((tool) => tool.name !== "room_say" && tool.name !== "message_send" && !tool.name.startsWith("effect_item_"));
    // Callable Toolchains are tools of their own; Main decides which this conversation sees. Without an answer the list is the base.
    return Promise.resolve().then(() => request("toolchain_tools", {})).then((value) => ({ tools: base.concat(value && Array.isArray(value.tools)
      ? value.tools.filter((tool) => tool && TOOLCHAIN_TOOL.test(String(tool.name)) && tool.inputSchema && typeof tool.inputSchema === "object") : []) }),
      () => ({ tools: base }));
  }
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  if (allowed && !allowed.includes(name) && !(typeof name === "string" && TOOLCHAIN_TOOL.test(name))) return Promise.resolve(error("This One team tool is not available in this conversation."));
  const args = requestValue.params && requestValue.params.arguments && typeof requestValue.params.arguments === "object" ? requestValue.params.arguments : {};
  if (typeof name === "string" && ${JSON.stringify(WORK_SESSION_TOOL_NAMES)}.includes(name)) return request("work", { name, input: args });
  if (typeof name === "string" && TOOLCHAIN_TOOL.test(name)) return request("toolchain_tool", { name, input: args });
  if (name === "room_say") return request("room", { text: args.text, to: args.to, replyTo: args.reply_to });
  if (name === "message_send") return request("message", { to: args.to, text: args.text, replyTo: args.reply_to });
  if (name === "effect_item_check" || name === "effect_item_record") return allowed ? request("effect", { name, input: args }) : Promise.resolve(error("This One team tool is not available in this conversation."));
  if (name === "one_team_list") return request("list", { query: args.query, limit: args.limit });
  if (name === "one_team_start_session") return request("start", { member: args.member, brief: args.brief, newSession: args.new_session });
  if (name === "one_team_steer") return request("steer", { sessionId: args.session_id, message: args.message });
  if (name === "one_team_stop") return request("stop", { sessionId: args.session_id });
  if (name === "one_team_session_status") return request("status", { sessionId: args.session_id, waitSeconds: args.wait_seconds });
  if (name === "one_team_create_member") return request("create", { name: args.name, role: args.role, personality: args.personality });
  if (name === "one_team_new_chat") return request("new_chat", { members: args.members, project_id: args.project_id, title: args.title });
  if (name === "one_team_add_to_chat") return request("add_to_chat", { chat_id: args.chat_id, members: args.members });
  if (name === "one_team_attach_project") return request("attach_project", { chat_id: args.chat_id, project_id: args.project_id });
  if (${JSON.stringify(ONE_SUPERVISOR_TOOL_NAMES)}.includes(name)) return request("supervisor", { name, input: args });
  if (${JSON.stringify(ONE_PERSONAL_TOOL_NAMES)}.includes(name)) return request('personal', { name, input: args });
  if (${JSON.stringify(ONE_HISTORY_TOOL_NAMES)}.includes(name)) return request('history', { name, input: args });
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

// The source is a file the child verifies before running it (mcp-tools/builtin-mcp-launch.ts); argv stays short.
const LAUNCH = defineBuiltinMcpLaunch("agentlas-one-team", SOURCE);

export function oneTeamMcpLaunchArgs(): string[] {
  return LAUNCH.launchArgs();
}

/** Gate assertion only (not part of authenticity): the launch is a fixed loader and a path, whatever the source size. */
export function oneTeamMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(oneTeamMcpLaunchArgs()).length <= BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS;
}

export function oneTeamMcpSourceDigest(): string {
  return LAUNCH.sourceSha256;
}

export function isAuthenticOneTeamMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || command !== process.execPath) return false;
  return LAUNCH.isAuthenticArgs(args);
}
