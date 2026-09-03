#!/usr/bin/env node
"use strict";
const readline = require("node:readline");
const tools = require("../schemas/tools.json").tools;
const runtime = require("./paleontology.cjs");
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-paleontology", version: runtime.PLUGIN_VERSION } };
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const name = message.params?.name, args = message.params?.arguments ?? {};
    if (name === "build_pbdb_taxon_request") return result(runtime.buildTaxonUrl(args));
    if (name === "build_pbdb_occurrence_request") return result(runtime.buildOccurrencesUrl(args));
    if (name === "analyze_paleontology_stratigraphic_support") return result(runtime.analyzeStratigraphicEvidence(args));
    if (name === "compare_fossil_candidate_evidence") return result(runtime.compareFossilCandidateEvidence(args));
    if (name === "assess_deextinction_feasibility") return result(runtime.assessDeextinctionFeasibility(args));
    if (name === "describe_paleontology_capabilities") return result(runtime.describeCapabilities(args));
    throw new Error("paleontology-tool-not-found");
  }
  if (message.method?.startsWith("notifications/")) return null;
  throw new Error("paleontology-method-not-found");
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); return; }
  if (message.id === undefined) { try { await handle(message); } catch {} return; }
  try { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: await handle(message) })}\n`); }
  catch (error) {
    const errorCode = error instanceof Error ? error.message : "paleontology-tool-failed";
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32010, message: errorCode, data: { errorCode } } })}\n`);
  }
});
