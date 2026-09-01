#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const toolCatalog = require("../schemas/tools.json");
const { analyzeHepDataChiSquare, createPhysicsClient, normalizeHepDataTable, normalizeNumericDataset, PhysicsError } = require("./physics.cjs");

const client = createPhysicsClient();
function toolResult(value) { return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }; }

async function callTool(name, args) {
  if (name === "search_inspire_literature") return toolResult(await client.searchInspireLiterature(args));
  if (name === "fetch_hepdata_record") return toolResult(await client.fetchHepDataRecord(args));
  if (name === "fetch_hepdata_table") return toolResult(await client.fetchHepDataTable(args));
  if (name === "normalize_hepdata_table") return toolResult(normalizeHepDataTable(args));
  if (name === "analyze_hepdata_chi_square") return toolResult(analyzeHepDataChiSquare(args));
  if (name === "normalize_physics_dataset") return toolResult(normalizeNumericDataset(args));
  if (name === "describe_physics_capabilities") {
    if (args && (typeof args !== "object" || Array.isArray(args) || Object.keys(args).length)) throw new PhysicsError("physics-capabilities-input-invalid");
    return toolResult(require("../capabilities.json"));
  }
  throw new PhysicsError("physics-tool-not-found", `Unknown Physics tool: ${name}`);
}

async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-physics", version: "0.2.0" } };
  if (message.method === "tools/list") return { tools: toolCatalog.tools };
  if (message.method === "tools/call") return callTool(message.params?.name, message.params?.arguments ?? {});
  if (message.method?.startsWith("notifications/")) return null;
  throw new PhysicsError("physics-method-not-found", `Unknown JSON-RPC method: ${message.method}`);
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
    const code = error instanceof PhysicsError ? -32020 : -32603;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: error.message, data: { errorCode: error.code ?? "physics-internal-error", details: error.details ?? null } } })}\n`);
  }
});
