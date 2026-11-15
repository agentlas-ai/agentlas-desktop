import path from "node:path";
import { BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS, defineBuiltinMcpLaunch } from "../mcp-tools/builtin-mcp-launch";
import { purposePrompt } from "../runtime/purpose-prompts";

/*
 * agentlas-server-apps: the bridge between a runtime's tool list and the personal agent's connected apps that live on the server (Agentlas 2.0 DD,
 * contracts/desktop-server-tools.md section 4). The child holds NO key, NO address and NO authority: the keys are in the server's vault and the
 * calls are signed by Main with the device key. The child only
 *   - lists the tools Main minted for this turn (`server_apps_tools`: Main answers from the list it stored, never from the network),
 *   - hands every call to Main's loopback control server (turn-tools/control-server.ts) with the turn's capability, and prints Main's answer.
 * Main re-reads who is calling at EVERY call (harness/tool-caller.ts) and decides whether a change may go out; the child cannot say either.
 *
 * Same shape as the agentlas-turn child (turn-tools/mcp-server.ts): a content-addressed source file the child verifies before running, the turn's
 * capability file named by the environment, a loopback request with the capability's token. It listens on no port of its own. Must not import electron.
 */
export const SERVER_APPS_CONTROL_ENV = "AGENTLAS_SERVER_APPS_CONTROL_FILE";
export const SERVER_APPS_CAPABILITY_TOOLS = ["server_apps_tools", "server_apps_call", "server_apps_status"] as const;

/** Registered module (docs/PROMPT-COMPOSITION-POLICY.md; ledger recipe desktop.server-apps.tools, channel tool-description): the one fixed fact the child says about itself. */
export const SERVER_APPS_STATUS_DESCRIPTION = purposePrompt([
  { id: "tool.agentlas-server-apps.status", revision: 1, stability: "fixed-policy", changeTriggers: ["release"],
    text: "State of a connected-app job that was still running: pass its callId." },
]);
export const SERVER_APPS_STATUS_INPUT_SCHEMA = {
  type: "object",
  properties: { callId: { type: "string", maxLength: 64 } },
  additionalProperties: false,
} as const;

/*
 * The child's two size ceilings (each now has a measured ground; the numbers themselves are unchanged, so the child's source digest is too).
 *  MAX_REQUEST_BYTES   128 KiB: basis: the same ceiling the app's other Main loopback children keep (computer-use/mcp-server.ts MAX_REQUEST_BYTES, browser/main-browser-broker.ts MAX_REQUEST), and the
 *                      largest legitimate request is the server's arguments ceiling (16 KiB, SERVER_APPS_LIMITS.argumentBytes) plus the envelope: 8 times room. Reached: the child
 *                      refuses the request (`Connected apps request is too large.`, a tool error) and nothing leaves; an input line over it ends the child (exit 78).
 * MAX_RESPONSE_BYTES 8 MiB: basis: measured (evidence/dd2-desktop/dd2-values-probe.cjs): the largest answer Main can give this child is the minted tool list of a stored list at its 1 MiB ceiling
 *                      (SERVER_APPS_LIMITS.stateBytes); with minimal tools it mints to 2.18 MB (2.08 times the stored size), with 4 KiB schemas to 0.82 MB; a call's result is the server's own cut of 64 KiB.
 * 8 MiB is 3.9 times the worst measured answer. Reached: the child ends the request (`Connected apps response is too large.`): a call is a tool error, the list is empty.
 */
const SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const http = require("node:http");
const CONTROL_ENV = ${JSON.stringify(SERVER_APPS_CONTROL_ENV)};
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// The server waits 60 s for an app and Main adds its own 5 s; this wait is above both so the child never gives up first and a change is never read as "not done".
const CALL_WAIT_MS = 75000;
function control() {
  const file = process.env[CONTROL_ENV];
  if (!file || file.length > 4096) throw new Error("Connected apps are not available in this run.");
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { throw e && e.code === "ENOENT" ? new Error("Connected apps are no longer available in this turn: the run that granted them has ended. Do not call them again; tell the owner what you could not do.") : e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 8192) throw new Error("Connected apps capability is invalid.");
  if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) throw new Error("Connected apps capability permissions are invalid.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || value.schemaVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || typeof value.capabilityId !== "string") throw new Error("Connected apps capability is invalid.");
  return value;
}
function request(operation, args, timeout) {
  const info = control();
  const body = JSON.stringify({ operation, args, token: info.token, capabilityId: info.capabilityId, capabilityToken: info.capabilityToken });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new Error("Connected apps request is too large."));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: info.port, path: "/turn", method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, timeout }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => { total += chunk.length; if (total <= MAX_RESPONSE_BYTES) chunks.push(chunk); else req.destroy(new Error("Connected apps response is too large.")); });
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value.ok) reject(new Error(value.error || "server-apps-failed")); else resolve(value.result); } catch { reject(new Error("Connected apps returned an invalid response.")); } });
    });
    req.once("timeout", () => req.destroy(new Error("Connected apps request timed out.")));
    req.once("error", reject);
    req.end(body);
  });
}
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });
async function handle(requestValue) {
  if (requestValue.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-server-apps", version: "1.0.0" } };
  if (requestValue.method === "notifications/initialized") return undefined;
  if (requestValue.method === "ping") return {};
  if (requestValue.method === "tools/list") {
    try { const answer = await request("server_apps_tools", {}, 15000); return { tools: Array.isArray(answer && answer.tools) ? answer.tools : [] }; }
    catch { return { tools: [] }; }
  }
  if (requestValue.method !== "tools/call") throw new Error("Method not found");
  const params = requestValue.params || {};
  const name = params.name;
  const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
  if (typeof name !== "string" || !name) return error("Unknown connected-app tool.");
  const result = name === ${JSON.stringify("server_apps_status")} ? await request("server_apps_status", args, 30000) : await request("server_apps_call", { name, arguments: args }, CALL_WAIT_MS);
  return result && result.content ? result : { content: [{ type: "text", text: JSON.stringify(result) }] };
}
function line(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return; }
  Promise.resolve().then(() => handle(parsed)).then((result) => {
    if (parsed.id === undefined || result === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }) + "\n");
  }).catch((err) => { if (parsed.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: error((err && err.message) || "server-apps-failed") }) + "\n"); });
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) process.exit(78); let end; while ((end = input.indexOf("\n")) >= 0) { line(input.slice(0, end).replace(/\r$/, "")); input = input.slice(end + 1); } });
process.stdin.on("end", () => process.exit(0));
`;

const LAUNCH = defineBuiltinMcpLaunch("agentlas-server-apps", SOURCE);

export function serverAppsMcpLaunchArgs(): string[] { return LAUNCH.launchArgs(); }
export function serverAppsMcpLaunchWithinBudget(): boolean { return JSON.stringify(serverAppsMcpLaunchArgs()).length <= BUILTIN_MCP_LAUNCH_ARGV_MAX_CHARS; }
export function serverAppsMcpSourceDigest(): string { return LAUNCH.sourceSha256; }
export function serverAppsMcpSourceForGate(): string { return SOURCE; }
export function isAuthenticServerAppsMcpLaunch(command: string | null, args: readonly string[]): boolean {
  if (!command || path.resolve(command) !== path.resolve(process.execPath)) return false;
  return LAUNCH.isAuthenticArgs(args);
}
