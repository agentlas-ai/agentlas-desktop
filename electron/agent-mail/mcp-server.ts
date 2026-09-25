import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

// Built-in inline MCP server: One reads and sends its own agent mail. The child
// holds no credentials — each tool call is forwarded to Main's loopback control
// server (control-server.ts), which calls the web API with the owner's session.

export const AGENTLAS_AGENT_MAIL_CATALOG_ID = "agent-mail";
export const AGENT_MAIL_CONTROL_ENV = "AGENTLAS_AGENT_MAIL_CONTROL_FILE";
export const AGENTLAS_AGENT_MAIL_TOOL_NAMES = [
  "agent_mail_status",
  "agent_mail_list",
  "agent_mail_read",
  "agent_mail_send",
] as const;

const SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const http = require("node:http");
const CONTROL_ENV = "AGENTLAS_AGENT_MAIL_CONTROL_FILE";
const MAX_REQUEST_BYTES = 512 * 1024;
function control() {
  const file = process.env[CONTROL_ENV];
  if (!file || file.length > 4096) throw new Error("Agent mail is not connected in this run.");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8192) throw new Error("Agent mail capability is invalid.");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("Agent mail capability permissions are invalid.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || typeof value.capabilityId !== "string") throw new Error("Agent mail capability is invalid.");
  return value;
}
function request(operation, input) {
  const info = control();
  const body = JSON.stringify({ ...input, operation, token: info.token, capabilityId: info.capabilityId });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new Error("Agent mail request is too large."));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: info.port, path: "/agent-mail", method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, timeout: 90000 }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => { total += chunk.length; if (total <= 4 * MAX_REQUEST_BYTES) chunks.push(chunk); else req.destroy(new Error("Agent mail response is too large.")); });
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) reject(new Error(value.error || "agent-mail-failed")); else resolve(value.result); } catch { reject(new Error("Agent mail returned an invalid response.")); } });
    });
    req.once("timeout", () => req.destroy(new Error("Agent mail request timed out.")));
    req.once("error", reject);
    req.end(body);
  });
}
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const addresses = { type: "array", items: { type: "string", maxLength: 320 }, maxItems: 50 };
const tools = [
  { name: "agent_mail_status", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, description: "Your own agent email address and this month's remaining recipient allowance (counted as To+Cc+Bcc recipients per UTC calendar month).", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "agent_mail_list", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, description: "List messages in your agent mailbox, newest first. Returns summaries and a cursor for the next page.", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["inbound", "outbound"] }, limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string", maxLength: 512 } }, additionalProperties: false } },
  { name: "agent_mail_read", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, description: "Read one message (full text) from your agent mailbox by id.", inputSchema: { type: "object", properties: { message_id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["message_id"], additionalProperties: false } },
  { name: "agent_mail_send", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, description: "Send an email from your own agent address. Use only when the owner asked for it or a configured automation requires it. Each To/Cc/Bcc recipient counts against the monthly allowance; the server refuses when it is used up. If the result status is 'uncertain', do NOT send again — report it.", inputSchema: { type: "object", properties: { to: addresses, cc: addresses, bcc: addresses, subject: { type: "string", minLength: 1, maxLength: 998 }, text: { type: "string", minLength: 1, maxLength: 200000 }, in_reply_to: { type: "string", maxLength: 998 } }, required: ["to", "subject", "text"], additionalProperties: false } },
];
function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-agent-mail", version: "1.0.0" } };
  if (requestValue.method === "notifications/initialized" || requestValue.method === "ping") return requestValue.method === "ping" ? {} : undefined;
  if (requestValue.method === "tools/list") return { tools };
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  const args = requestValue.params && requestValue.params.arguments && typeof requestValue.params.arguments === "object" ? requestValue.params.arguments : {};
  if (name === "agent_mail_status") return request("status", {});
  if (name === "agent_mail_list") return request("list", { direction: args.direction, limit: args.limit, cursor: args.cursor });
  if (name === "agent_mail_read") return request("read", { messageId: args.message_id });
  if (name === "agent_mail_send") return request("send", { to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.text, inReplyTo: args.in_reply_to });
  return Promise.resolve(error("Unknown agent mail tool."));
}
function line(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return; }
  Promise.resolve().then(() => handle(parsed)).then((result) => {
    if (parsed.id === undefined || result === undefined) return;
    const wireResult = parsed.method === "tools/call" ? (result && result.content ? result : text(result)) : result;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: wireResult }) + "\n");
  }).catch((err) => { if (parsed.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: error(err.message || "agent-mail-failed") }) + "\n"); });
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) process.exit(78); let end; while ((end = input.indexOf("\n")) >= 0) { line(input.slice(0, end).replace(/\r$/, "")); input = input.slice(end + 1); } });
`;

const SOURCE_SHA256 = createHash("sha256").update(SOURCE).digest("hex");
const BOOTSTRAP =
  `const z=require("node:zlib"),c=require("node:crypto"),v=require("node:vm"),b=z.gunzipSync(Buffer.from(process.argv[1],"base64"),{maxOutputLength:65536});` +
  `if(b.length>65536||c.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(SOURCE_SHA256)})process.exit(78);` +
  `v.runInThisContext(b.toString("utf8"),{filename:"agentlas-agent-mail.cjs"});`;
const PAYLOAD = gzipSync(Buffer.from(SOURCE, "utf8"), { level: 9 }).toString("base64");

export function agentMailMcpLaunchArgs(): string[] {
  return ["-e", BOOTSTRAP, PAYLOAD];
}

export function agentMailMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(agentMailMcpLaunchArgs()).length <= 12_000;
}

export function agentMailMcpSourceDigest(): string {
  return SOURCE_SHA256;
}

export function isAuthenticAgentMailMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || command !== process.execPath || !agentMailMcpLaunchWithinBudget()) return false;
  if (args.length !== 3 || args[0] !== "-e" || args[1] !== BOOTSTRAP) return false;
  try {
    return createHash("sha256").update(gunzipSync(Buffer.from(args[2], "base64"))).digest("hex") === SOURCE_SHA256;
  } catch {
    return false;
  }
}
