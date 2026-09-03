#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const toolCatalog = require("../schemas/tools.json");
const { PLUGIN_VERSION, analyzeLatticeMetrics, createMaterialsScienceClient, MaterialsScienceError } = require("./materials-science.cjs");

const client = createMaterialsScienceClient();

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

async function callTool(name, args) {
  if (name === "search_oqmd_optimade_structures") return toolResult(await client.searchOqmdOptimadeStructures(args));
  if (name === "search_cod_crystals") return toolResult(await client.searchCodCrystals(args));
  if (name === "fetch_cod_cif") return toolResult(await client.fetchCodCif(args));
  if (name === "analyze_lattice_metrics") return toolResult(analyzeLatticeMetrics(args));
  if (name === "describe_materials_science_capabilities") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new MaterialsScienceError("materials-capabilities-input-invalid");
    return toolResult(require("../capabilities.json"));
  }
  throw new MaterialsScienceError("materials-tool-not-found", `Unknown Materials Science tool: ${name}`);
}

async function handle(message) {
  if (message.method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-materials-science", version: PLUGIN_VERSION } };
  }
  if (message.method === "tools/list") return { tools: toolCatalog.tools };
  if (message.method === "tools/call") return callTool(message.params?.name, message.params?.arguments ?? {});
  if (message.method?.startsWith("notifications/")) return null;
  throw new MaterialsScienceError("materials-method-not-found", `Unknown JSON-RPC method: ${message.method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }
  if (message.id === undefined) {
    try { await handle(message); } catch { /* notifications never receive a response */ }
    return;
  }
  try {
    const result = await handle(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    const code = error instanceof MaterialsScienceError ? -32010 : -32603;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: error.message, data: { errorCode: error.code ?? "materials-internal-error", details: error.details ?? null } } })}\n`);
  }
});
