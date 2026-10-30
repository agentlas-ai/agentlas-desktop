#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const toolCatalog = require("../schemas/tools.json");
const { PLUGIN_VERSION, createStructuralBiologyClient, StructuralBiologyError, PluginHttpError } = require("./structural-biology.cjs");

const client = createStructuralBiologyClient();

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(error) {
  const known = error instanceof StructuralBiologyError || error instanceof PluginHttpError;
  const value = { error: { code: known ? error.code : "structural-biology-internal-error", message: known ? error.message : "Internal error", details: known ? error.details ?? null : null } };
  if (value.error.details && Array.isArray(value.error.details.attempts)) {
    value.error.details = { ...value.error.details, attempts: value.error.details.attempts.map(({ url, status, errorCode }) => ({ url, status, errorCode })) };
  }
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

const HANDLERS = {
  search_protein_structures: (args) => client.searchProteinStructures(args),
  fetch_protein_structure: (args) => client.fetchProteinStructure(args),
  fetch_alphafold_model: (args) => client.fetchAlphafoldModel(args),
  describe_binding_site: (args) => client.describeBindingSite(args),
  fetch_chembl_activities: (args) => client.fetchChemblActivities(args),
  fetch_clinical_trials: (args) => client.fetchClinicalTrials(args),
  describe_structural_biology_capabilities: (args) => {
    if (args && Object.keys(args).length) throw new StructuralBiologyError("capabilities-input-invalid");
    return require("../capabilities.json");
  },
};

async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  try { return toolResult(await handler(args ?? {})); }
  catch (error) { return toolError(error); }
}

async function handle(message) {
  if (message.method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-structural-biology", version: PLUGIN_VERSION } };
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
