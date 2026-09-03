"use strict";

/**
 * Registry of the pure analysis tools shipped by the Agentlas Astronomy plugin.
 * Each entry is declared by a JSON schema under ../schemas and binds an MCP tool name
 * to one runtime module export. The registry converts snake_case MCP arguments to the
 * camelCase runtime contract; unknown keys are rejected by the runtime's exact-key
 * validation after conversion, so no argument can slip through the rename.
 */

const path = require("node:path");
const { AstronomyDataError } = require("./analysis-common.cjs");

const SCHEMA_DIR = path.join(__dirname, "..", "schemas");
const INDEX = require(path.join(SCHEMA_DIR, "analysis-tools.json"));

function camelKey(key) {
  return key.replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase());
}

function camelizeKeys(value) {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === "object") {
    const converted = {};
    for (const [key, entry] of Object.entries(value)) converted[camelKey(key)] = camelizeKeys(entry);
    return converted;
  }
  return value;
}

function loadRegistry() {
  if (INDEX.schema !== "agentlas.astronomy.analysis-tool-index/v1" || !Array.isArray(INDEX.tools)) throw new AstronomyDataError("astronomy-analysis-tool-index-invalid");
  const tools = INDEX.tools.map((file) => {
    const schema = require(path.join(SCHEMA_DIR, file));
    const binding = schema["x-agentlas"];
    if (!binding || binding.schema !== "agentlas.astronomy.tool-schema/v1" || typeof binding.toolName !== "string" || typeof binding.runtimeModule !== "string" || typeof binding.runtimeExport !== "string") {
      throw new AstronomyDataError("astronomy-analysis-tool-schema-invalid", `${file}: missing x-agentlas binding`);
    }
    const runtime = require(path.join(__dirname, "..", binding.runtimeModule));
    const analyze = runtime[binding.runtimeExport];
    if (typeof analyze !== "function") throw new AstronomyDataError("astronomy-analysis-tool-schema-invalid", `${file}: ${binding.runtimeExport} is not exported by ${binding.runtimeModule}`);
    const { "x-agentlas": _binding, $schema: _draft, $id, title, description, ...inputSchema } = schema;
    return { id: file.replace(/\.json$/, ""), schemaId: $id, name: binding.toolName, description, resultSchema: binding.resultSchema, runtimeModule: binding.runtimeModule, runtimeExport: binding.runtimeExport, inputSchema, analyze };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new AstronomyDataError("astronomy-analysis-tool-index-invalid", "duplicate tool names");
  return tools;
}

const ANALYSIS_TOOLS = loadRegistry();
const BY_NAME = new Map(ANALYSIS_TOOLS.map((tool) => [tool.name, tool]));

function analysisToolCatalog() {
  return ANALYSIS_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

function callAnalysisTool(name, snakeCaseArguments) {
  const tool = BY_NAME.get(name);
  if (!tool) throw new AstronomyDataError("astronomy-tool-not-found", `Unknown Astronomy analysis tool: ${name}`);
  if (!snakeCaseArguments || typeof snakeCaseArguments !== "object" || Array.isArray(snakeCaseArguments)) throw new AstronomyDataError("astronomy-analysis-mcp-input-invalid");
  const result = tool.analyze(camelizeKeys(snakeCaseArguments));
  if (result.schema !== tool.resultSchema) throw new AstronomyDataError("astronomy-analysis-result-schema-mismatch", `${name} returned ${result.schema}`);
  return result;
}

module.exports = { ANALYSIS_TOOLS, analysisToolCatalog, callAnalysisTool, camelizeKeys };
