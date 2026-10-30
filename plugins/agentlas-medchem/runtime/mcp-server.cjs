#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const toolCatalog = require("../schemas/tools.json");
const env = require("./python-env.cjs");
const { PLUGIN_VERSION, createMedchemClient, MedchemError } = require("./medchem.cjs");

const client = createMedchemClient();

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
function toolError(error) {
  const known = error instanceof MedchemError;
  const value = { error: { code: known ? error.code : "medchem-internal-error", message: known ? error.message : "Internal error", details: known ? error.details ?? null : null } };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

const HANDLERS = {
  compute_molecular_properties: (args) => client.computeMolecularProperties(args),
  standardize_smiles: (args) => client.standardizeSmiles(args),
  draw_compound_grid: (args) => client.drawCompoundGrid(args),
  describe_medchem_runtime: (args) => client.describeMedchemRuntime(args),
};

async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  try { return toolResult(await handler(args ?? {})); }
  catch (error) { return toolError(error); }
}

async function handle(message) {
  if (message.method === "initialize") {
    // The one-time RDKit environment starts building as soon as a run brings this server up, so the first calculation
    // usually finds it ready. Never blocks the handshake.
    try { env.ensureInstallStarted(); } catch { /* reported by describe_medchem_runtime and every result */ }
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-medchem", version: PLUGIN_VERSION } };
  }
  if (message.method === "tools/list") return { tools: toolCatalog.tools };
  if (message.method === "tools/call") return callTool(message.params?.name, message.params?.arguments);
  if (message.method === "ping") return {};
  if (message.method?.startsWith("notifications/")) return null;
  throw Object.assign(new Error(`Unknown method: ${message.method}`), { rpcCode: -32601 });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }
  if (message.id === undefined) { try { await handle(message); } catch { /* notifications never answer */ } return; }
  try {
    const result = await handle(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error.rpcCode ?? -32603, message: error.message } })}\n`);
  }
});
