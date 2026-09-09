import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const AGENTLAS_WORKSPACE_PREVIEW_CATALOG_ID = "workspace-preview";
export const AGENTLAS_WORKSPACE_PREVIEW_TOOL_NAMES = [
  "start_preview",
  "status_preview",
  "stop_preview",
  "list_previews",
] as const;

const SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const http = require("node:http");
const CONTROL_ENV = "AGENTLAS_WORKSPACE_PREVIEW_CONTROL_FILE";
const MAX_REQUEST_BYTES = 64 * 1024;
function control() {
  const file = process.env[CONTROL_ENV];
  if (!file || file.length > 4096) throw new Error("Workspace preview control capability is unavailable.");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8192) throw new Error("Workspace preview control capability is invalid.");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("Workspace preview control capability permissions are invalid.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || typeof value.capabilityId !== "string") throw new Error("Workspace preview control capability is invalid.");
  return value;
}
function request(operation, input) {
  const info = control();
  const body = JSON.stringify({ ...input, operation, token: info.token, capabilityId: info.capabilityId });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new Error("Workspace preview request is too large."));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: info.port, path: "/preview", method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, timeout: 120000 }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => { total += chunk.length; if (total <= MAX_REQUEST_BYTES) chunks.push(chunk); else req.destroy(new Error("Workspace preview response is too large.")); });
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) reject(new Error(value.error || "workspace-preview-failed")); else resolve(value.result); } catch { reject(new Error("Workspace preview returned an invalid response.")); } });
    });
    req.once("timeout", () => req.destroy(new Error("Workspace preview request timed out.")));
    req.once("error", reject);
    req.end(body);
  });
}
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const tools = [
  { name: "start_preview", description: "Start or reuse a Main-owned project preview. Use only for a long-lived local development server; expected_url must be loopback.", inputSchema: { type: "object", properties: { command: { type: "string", minLength: 1, maxLength: 4000 }, expected_url: { type: "string", maxLength: 2000 } }, required: ["command"], additionalProperties: false } },
  { name: "status_preview", description: "Check a project preview process and its loopback URL health.", inputSchema: { type: "object", properties: { preview_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["preview_id"], additionalProperties: false } },
  { name: "stop_preview", description: "Stop a project preview owned by this task.", inputSchema: { type: "object", properties: { preview_id: { type: "string", minLength: 1, maxLength: 128 } }, required: ["preview_id"], additionalProperties: false } },
  { name: "list_previews", description: "List live project previews owned by this task.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];
function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-workspace-preview", version: "1.0.0" } };
  if (requestValue.method === "notifications/initialized" || requestValue.method === "ping") return requestValue.method === "ping" ? {} : undefined;
  if (requestValue.method === "tools/list") return { tools };
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const name = requestValue.params && requestValue.params.name;
  const args = requestValue.params && requestValue.params.arguments && typeof requestValue.params.arguments === "object" ? requestValue.params.arguments : {};
  if (name === "start_preview") return request("start", { command: args.command, expectedUrl: args.expected_url });
  if (name === "status_preview") return request("status", { previewId: args.preview_id });
  if (name === "stop_preview") return request("stop", { previewId: args.preview_id });
  if (name === "list_previews") return request("list", {});
  return Promise.resolve(error("Unknown workspace preview tool."));
}
function line(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return; }
  Promise.resolve().then(() => handle(parsed)).then((result) => {
    if (parsed.id === undefined || result === undefined) return;
    const wireResult = parsed.method === "tools/call" ? (result && result.content ? result : text(result)) : result;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: wireResult }) + "\n");
  }).catch((err) => { if (parsed.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: error(err.message || "workspace-preview-failed") }) + "\n"); });
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) process.exit(78); let end; while ((end = input.indexOf("\n")) >= 0) { line(input.slice(0, end).replace(/\r$/, "")); input = input.slice(end + 1); } });
`;

const SOURCE_SHA256 = createHash("sha256").update(SOURCE).digest("hex");
const BOOTSTRAP =
  `const z=require("node:zlib"),c=require("node:crypto"),v=require("node:vm"),b=z.gunzipSync(Buffer.from(process.argv[1],"base64"),{maxOutputLength:65536});` +
  `if(b.length>65536||c.createHash("sha256").update(b).digest("hex")!==${JSON.stringify(SOURCE_SHA256)})process.exit(78);` +
  `v.runInThisContext(b.toString("utf8"),{filename:"agentlas-workspace-preview.cjs"});`;
const PAYLOAD = gzipSync(Buffer.from(SOURCE, "utf8"), { level: 9 }).toString("base64");

export function workspacePreviewMcpLaunchArgs(): string[] {
  return ["-e", BOOTSTRAP, PAYLOAD];
}

export function workspacePreviewMcpLaunchWithinBudget(): boolean {
  return JSON.stringify(workspacePreviewMcpLaunchArgs()).length <= 12_000;
}

export function workspacePreviewMcpSourceDigest(): string { return SOURCE_SHA256; }

export function isAuthenticWorkspacePreviewMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || command !== process.execPath || !workspacePreviewMcpLaunchWithinBudget()) return false;
  if (args.length !== 3 || args[0] !== "-e" || args[1] !== BOOTSTRAP) return false;
  try { return createHash("sha256").update(gunzipSync(Buffer.from(args[2], "base64"))).digest("hex") === SOURCE_SHA256; } catch { return false; }
}
