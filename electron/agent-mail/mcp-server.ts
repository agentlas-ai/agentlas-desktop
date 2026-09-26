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
  "agent_mail_search",
  "agent_mail_read",
  "agent_mail_thread",
  "agent_mail_send",
  "agent_mail_reply",
  "agent_mail_draft",
  "agent_mail_mark_read",
  "agent_mail_archive",
  "agent_mail_attachments",
  "agent_mail_download_attachment",
  "agent_mail_delete",
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
const id = { type: "string", minLength: 1, maxLength: 64 };
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const views = { type: "string", enum: ["inbox", "waiting", "sent", "archived", "all"], description: "inbox = received and not archived (default), waiting = waiting for their reply, sent = threads you sent in, archived, all." };
const page = { limit: { type: "integer", minimum: 1, maximum: 50 }, cursor: { type: "string", maxLength: 512 } };
const body = { type: "string", minLength: 1, maxLength: 200000, description: "Plain text. Do not add a signature: the server adds the owner's saved signature." };
const noteSend = " Works in every permission mode of this conversation, read-only included: do not ask for full access to send mail. Each To/Cc/Bcc recipient counts against the monthly allowance; the server refuses when it is used up. If the result status is 'uncertain', do NOT send again - report it.";
const tools = [
  { name: "agent_mail_status", annotations: ro, description: "Your own agent email address, the sender name people see, whether you can send in this conversation, and this month's remaining recipient allowance (To+Cc+Bcc recipients per UTC calendar month).", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "agent_mail_list", annotations: ro, description: "List conversations (threads) in your mailbox, newest first: subject, people, snippet, unread count, who sent last. Use the thread id with agent_mail_thread to read it.", inputSchema: { type: "object", properties: { view: views, ...page }, additionalProperties: false } },
  { name: "agent_mail_search", annotations: ro, description: "Search your mailbox. Words must all match subject, body, sender or recipients. Operators: from:x to:x subject:x has:attachment is:unread is:read, \"exact phrase\".", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 }, view: views, ...page }, required: ["query"], additionalProperties: false } },
  { name: "agent_mail_read", annotations: ro, description: "Read one message (full text) by message id. Reading does not mark it read for the owner.", inputSchema: { type: "object", properties: { message_id: id }, required: ["message_id"], additionalProperties: false } },
  { name: "agent_mail_thread", annotations: ro, description: "Read a whole conversation by thread id: every message oldest first, plus any saved reply drafts.", inputSchema: { type: "object", properties: { thread_id: id }, required: ["thread_id"], additionalProperties: false } },
  { name: "agent_mail_send", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, description: "Send a new email from your own agent address. Use only when the owner asked for it or a configured automation requires it. To answer a message, prefer agent_mail_reply (it keeps the conversation together)." + noteSend, inputSchema: { type: "object", properties: { to: addresses, cc: addresses, bcc: addresses, subject: { type: "string", minLength: 1, maxLength: 998 }, text: body, reply_to_message_id: { ...id, description: "Our message id this answers; the server links the conversation." } }, required: ["to", "subject", "text"], additionalProperties: false } },
  { name: "agent_mail_reply", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, description: "Reply to a message in its conversation. Recipients and 'Re:' subject come from the original; the server sets the reply headers. reply_all also copies the other people on it. Use only when the owner asked for it or the mailbox is set to reply for them." + noteSend, inputSchema: { type: "object", properties: { message_id: id, text: body, reply_all: { type: "boolean" }, cc: addresses, subject: { type: "string", maxLength: 998 } }, required: ["message_id", "text"], additionalProperties: false } },
  { name: "agent_mail_draft", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: "Save an email as a draft in the owner's mailbox without sending it. With reply_to_message_id it becomes a reply draft in that conversation (recipients filled from the original when 'to' is empty).", inputSchema: { type: "object", properties: { to: addresses, cc: addresses, bcc: addresses, subject: { type: "string", maxLength: 998 }, text: body, reply_to_message_id: id, reply_all: { type: "boolean" } }, required: ["text"], additionalProperties: false } },
  { name: "agent_mail_mark_read", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "Mark a conversation (thread_id) or one message (message_id) read or unread for the owner.", inputSchema: { type: "object", properties: { thread_id: id, message_id: id, read: { type: "boolean" } }, additionalProperties: false } },
  { name: "agent_mail_archive", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, description: "Archive a conversation (or bring it back with archived=false). Archived mail is kept and searchable.", inputSchema: { type: "object", properties: { thread_id: id, archived: { type: "boolean" } }, required: ["thread_id"], additionalProperties: false } },
  { name: "agent_mail_attachments", annotations: ro, description: "List the attachments of a message: index, file name, type, size, and whether it can be downloaded.", inputSchema: { type: "object", properties: { message_id: id }, required: ["message_id"], additionalProperties: false } },
  { name: "agent_mail_download_attachment", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, description: "Save one attachment as a file. In a run that may edit files it goes to mail-attachments/ in the project folder; otherwise to the app's mail folder. Returns the saved path. Never overwrites a file.", inputSchema: { type: "object", properties: { message_id: id, index: { type: "integer", minimum: 0, maximum: 999 } }, required: ["message_id", "index"], additionalProperties: false } },
  { name: "agent_mail_delete", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, description: "Permanently delete a conversation (thread_id) or one message (message_id) from the mailbox. Only when the owner asked for it.", inputSchema: { type: "object", properties: { thread_id: id, message_id: id }, additionalProperties: false } },
];
function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-agent-mail", version: "1.1.0" } };
  if (requestValue.method === "notifications/initialized" || requestValue.method === "ping") return requestValue.method === "ping" ? {} : undefined;
  if (requestValue.method === "tools/list") return { tools };
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  const args = requestValue.params && requestValue.params.arguments && typeof requestValue.params.arguments === "object" ? requestValue.params.arguments : {};
  if (name === "agent_mail_status") return request("status", {});
  if (name === "agent_mail_list") return request("list", { view: args.view, limit: args.limit, cursor: args.cursor });
  if (name === "agent_mail_search") return request("list", { query: args.query, view: args.view || "all", limit: args.limit, cursor: args.cursor });
  if (name === "agent_mail_read") return request("read", { messageId: args.message_id });
  if (name === "agent_mail_thread") return request("thread", { threadId: args.thread_id });
  if (name === "agent_mail_send") return request("send", { to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.text, replyToMessageId: args.reply_to_message_id });
  if (name === "agent_mail_reply") return request("reply", { messageId: args.message_id, text: args.text, replyAll: args.reply_all === true, cc: args.cc, subject: args.subject });
  if (name === "agent_mail_draft") return request("draft", { to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.text, replyToMessageId: args.reply_to_message_id, replyAll: args.reply_all === true });
  if (name === "agent_mail_mark_read") return request("mark_read", { threadId: args.thread_id, messageId: args.message_id, read: args.read !== false });
  if (name === "agent_mail_archive") return request("archive", { threadId: args.thread_id, archived: args.archived !== false });
  if (name === "agent_mail_attachments") return request("attachments", { messageId: args.message_id });
  if (name === "agent_mail_download_attachment") return request("download_attachment", { messageId: args.message_id, index: args.index });
  if (name === "agent_mail_delete") return request("delete", { threadId: args.thread_id, messageId: args.message_id });
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
