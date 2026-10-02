import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

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
] as const;

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
  return value;
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
  { name: "one_team_list", annotations: ro, description: "Your teammates (the owner's One team: name, member id, what they are doing now) and the teammate sessions this conversation already started with their status.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "one_team_start_session", annotations: act, description: "Hand a piece of work to a teammate in the teammate's OWN session (it appears in the owner's team list, not inside this chat). Use when the owner asks you to give/assign/delegate work to a named teammate. Write the brief as intent: what to produce, why, and what 'done' looks like - not step-by-step instructions. It starts right away (no extra approval). The same brief to the same teammate is never started twice. After starting, call one_team_session_status with wait_seconds to get the result; if you end your turn instead, the result is reported back into this conversation when the teammate finishes. The conversation shows the owner an 'Open session' link on its own: do not print session ids. A started result has confirmed:true and owner_message (already in the owner's language): tell the owner that, do not guess. A refusal says exactly why and that nothing was started. Calling again with the same brief returns the existing session (already_started:true), never a duplicate: when unsure whether a handoff happened, call this again or one_team_list instead of doing the teammate's work yourself.", inputSchema: { type: "object", properties: { member: { type: "string", minLength: 1, maxLength: 200, description: "Teammate name or member id (see one_team_list)." }, brief: { type: "string", minLength: 1, maxLength: 8000 }, new_session: { type: "boolean", description: "Default true: a new session. false continues the teammate's latest session." } }, required: ["member", "brief"], additionalProperties: false } },
  { name: "one_team_steer", annotations: act, description: "Send a follow-up direction to a teammate session you started (queued after its current step if it is still working; reopens it if it had finished).", inputSchema: { type: "object", properties: { session_id: session, message: { type: "string", minLength: 1, maxLength: 8000 } }, required: ["session_id", "message"], additionalProperties: false } },
  { name: "one_team_session_status", annotations: ro, description: "Status of a teammate session you started; when finished, includes the teammate's final answer. wait_seconds (0-180) waits for it to finish first.", inputSchema: { type: "object", properties: { session_id: session, wait_seconds: { type: "integer", minimum: 0, maximum: 180 } }, required: ["session_id"], additionalProperties: false } },
  { name: "one_team_create_member", annotations: act, description: "Create a NEW teammate on the owner's One team (same as the owner's New Agent button: own chat, memory and a default character) and, by default, invite them into this group chat. Use when the owner asks you to make/create/hire an agent or teammate, or when the work needs a specialist nobody on one_team_list covers. Give a short human name, the role, and optionally a personality/working style. It needs write or full permission. The same name is never created twice (an existing teammate with that name is returned instead). A refusal (team full, read-only run, invalid name) says exactly why and that nobody was created. A created result has confirmed:true and owner_message in the owner's language: tell the owner that. Then hand work with one_team_start_session.", inputSchema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 80 }, role: { type: "string", maxLength: 100, description: "One line: what this teammate is responsible for." }, personality: { type: "string", maxLength: 1200 }, invite: { type: "boolean", description: "Default true: also add them to this group chat (ignored when this chat is not a group chat)." } }, required: ["name"], additionalProperties: false } },
  { name: "one_team_invite", annotations: act, description: "Invite an EXISTING teammate (see one_team_list) into this group chat. Use when the owner asks you to invite/bring/add a teammate to this group. It needs write or full permission and this conversation must be a group chat. A refusal (not a group chat, group full, unknown teammate) says exactly why and that the group is unchanged.", inputSchema: { type: "object", properties: { member: { type: "string", minLength: 1, maxLength: 200, description: "Teammate name or member id (see one_team_list)." } }, required: ["member"], additionalProperties: false } },
  { name: "one_team_compose_group", annotations: act, description: "Make this exact One conversation a group with specified EXISTING active local teammates, or add them to its existing group. Use only when the owner requests a group conversation. First check one_team_list.conversation and use exact member_id values from teammates; create a missing teammate separately. Needs write or full permission. Preserves this conversation, task, goal, messages and runtime. Never removes current members or starts work. Repeating the same composition returns the same group without duplicates. Check confirmed, created, added_member_ids and owner_message; hand work separately with one_team_start_session.", inputSchema: { type: "object", properties: { members: { type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: { type: "string", minLength: 3, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$" }, description: "Exact member_id values returned by one_team_list for existing active local teammates." } }, required: ["members"], additionalProperties: false } },
];
function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-one-team", version: "1.0.0" } };
  if (requestValue.method === "notifications/initialized" || requestValue.method === "ping") return requestValue.method === "ping" ? {} : undefined;
  if (requestValue.method === "tools/list") return { tools };
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  const args = requestValue.params && requestValue.params.arguments && typeof requestValue.params.arguments === "object" ? requestValue.params.arguments : {};
  if (name === "one_team_list") return request("list", {});
  if (name === "one_team_start_session") return request("start", { member: args.member, brief: args.brief, newSession: args.new_session });
  if (name === "one_team_steer") return request("steer", { sessionId: args.session_id, message: args.message });
  if (name === "one_team_session_status") return request("status", { sessionId: args.session_id, waitSeconds: args.wait_seconds });
  if (name === "one_team_create_member") return request("create", { name: args.name, role: args.role, personality: args.personality, invite: args.invite });
  if (name === "one_team_invite") return request("invite", { member: args.member });
  if (name === "one_team_compose_group") return request("compose_group", { members: args.members });
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
