#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const catalog = require("../schemas/tools.json");
const runtime = require("./comparative-genomics.cjs");
const hypotheticalAsr = require("./hypothetical-asr.cjs");
const extantArchosaurLocusPanel = require("./extant-archosaur-locus-panel.cjs");

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

async function callTool(name, args) {
  if (name === "build_ensembl_reference_assembly_manifest_request") return result(runtime.buildReferenceAssemblyManifestRequest(args));
  if (name === "normalize_ensembl_reference_assembly_manifest") return result(runtime.normalizeReferenceAssemblyManifest(args));
  if (name === "build_ensembl_compara_gene_tree_request") return result(runtime.buildGeneTreeRequest(args));
  if (name === "normalize_ensembl_compara_gene_tree") return result(runtime.normalizeGeneTree(args));
  if (name === "reconstruct_hypothetical_ancestor_fitch") return result(hypotheticalAsr.reconstructHypotheticalAncestor(args));
  if (name === "compute_extant_archosaur_locus_panel") return result(extantArchosaurLocusPanel.materializeExtantArchosaurLocusPanel(args));
  if (name === "describe_comparative_genomics_capabilities") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) throw new Error("comparative-genomics-capabilities-input-invalid");
    return result({
      schema: "agentlas.comparative-genomics-capabilities/v1",
      provider: "Ensembl Compara",
      origin: runtime.ENSEMBL_ORIGIN,
      operations: ["reference-assembly-manifest", "version-receipt", "rooted-gene-tree", "provider-alignment", "alignment-qc-table", "vega-tree", "exploratory-hypothetical-fitch-ambiguity-sets", "extant-archosaur-locus-panel"],
      unavailable: ["local-realignment", "alternative-topology-sensitivity", "publication-grade-ancestral-sequence-reconstruction", "extinct-species-genome", "phenotype-prediction", "embryo-or-hatching-assessment"],
      evidencePolicy: { extantProviderBytes: "observed", orthologyAlignmentTree: "inferred", ancestralSequence: "hypothetical-only" },
    });
  }
  throw new Error("comparative-genomics-tool-not-found");
}

async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-comparative-genomics", version: runtime.PLUGIN_VERSION } };
  if (message.method === "tools/list") return { tools: catalog.tools };
  if (message.method === "tools/call") return callTool(message.params?.name, message.params?.arguments ?? {});
  if (message.method?.startsWith("notifications/")) return null;
  throw new Error("comparative-genomics-method-not-found");
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
    return;
  }
  if (message.id === undefined) { try { await handle(message); } catch { /* notifications have no response */ } return; }
  try {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: await handle(message) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32031, message: error instanceof Error ? error.message : "comparative-genomics-internal-error" } })}\n`);
  }
});
