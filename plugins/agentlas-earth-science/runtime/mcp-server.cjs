#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const toolCatalog = require("../schemas/tools.json");
const {
  PLUGIN_VERSION,
  analyzeAftershockProductivity,
  analyzeClimateTrend,
  analyzeDroughtIndex,
  analyzeFloodFrequency,
  analyzeGutenbergRichter,
  analyzeIsochron,
  analyzeOmoriUtsu,
  analyzeSeismicityBValue,
  analyzeSpatialAutocorrelation,
  analyzeTasClassification,
  analyzeTidalHarmonics,
  createEarthScienceClient,
  normalizeNoaaCoopsWaterLevel,
  normalizeUsgsEventDetail,
  normalizeUsgsGeoJson,
  EarthScienceError,
} = require("./earth-science.cjs");

const client = createEarthScienceClient();

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

async function callTool(name, args) {
  if (name === "search_usgs_earthquakes") return toolResult(await client.searchUsgsEarthquakes(args));
  if (name === "analyze_usgs_gutenberg_richter") return toolResult(analyzeGutenbergRichter(args));
  if (name === "analyze_usgs_omori_utsu") return toolResult(analyzeOmoriUtsu(args));
  if (name === "analyze_usgs_seismicity_b_value") return toolResult(analyzeSeismicityBValue(args));
  if (name === "analyze_usgs_aftershock_productivity") return toolResult(analyzeAftershockProductivity(args));
  if (name === "analyze_tidal_harmonics") return toolResult(analyzeTidalHarmonics(args));
  if (name === "analyze_climate_trend") return toolResult(analyzeClimateTrend(args));
  if (name === "analyze_drought_index") return toolResult(analyzeDroughtIndex(args));
  if (name === "analyze_flood_frequency") return toolResult(analyzeFloodFrequency(args));
  if (name === "analyze_isochron") return toolResult(analyzeIsochron(args));
  if (name === "classify_tas") return toolResult(analyzeTasClassification(args));
  if (name === "analyze_spatial_autocorrelation") return toolResult(analyzeSpatialAutocorrelation(args));
  if (name === "get_usgs_event_detail") return toolResult(await client.getUsgsEventDetail(args));
  if (name === "fetch_noaa_coops_water_levels") return toolResult(await client.fetchNoaaCoopsWaterLevels(args));
  if (name === "normalize_usgs_earthquake_geojson") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !["geojson", "orderBy", "offset", "limit"].includes(key))) {
      throw new EarthScienceError("earth-normalize-input-invalid");
    }
    return toolResult(normalizeUsgsGeoJson(args.geojson, { orderBy: args.orderBy, offset: args.offset, limit: args.limit }));
  }
  if (name === "normalize_usgs_event_detail_geojson") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => key !== "geojson")) {
      throw new EarthScienceError("earth-normalize-detail-input-invalid");
    }
    return toolResult(normalizeUsgsEventDetail(args.geojson));
  }
  if (name === "normalize_noaa_coops_water_level_json") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !["response", "stationId", "startTime", "endTime", "datum", "units"].includes(key))) {
      throw new EarthScienceError("earth-normalize-noaa-input-invalid");
    }
    return toolResult(normalizeNoaaCoopsWaterLevel(args.response, {
      stationId: args.stationId,
      startTime: args.startTime,
      endTime: args.endTime,
      datum: args.datum,
      ...(args.units === undefined ? {} : { units: args.units }),
    }));
  }
  if (name === "describe_earth_science_capabilities") {
    if (args && (typeof args !== "object" || Array.isArray(args) || Object.keys(args).length)) throw new EarthScienceError("earth-capabilities-input-invalid");
    return toolResult(require("../capabilities.json"));
  }
  throw new EarthScienceError("earth-tool-not-found", `Unknown Earth Science tool: ${name}`);
}

async function handle(message) {
  if (message.method === "initialize") {
    return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentlas-earth-science", version: PLUGIN_VERSION } };
  }
  if (message.method === "tools/list") return { tools: toolCatalog.tools };
  if (message.method === "tools/call") return callTool(message.params?.name, message.params?.arguments ?? {});
  if (message.method?.startsWith("notifications/")) return null;
  throw new EarthScienceError("earth-method-not-found", `Unknown JSON-RPC method: ${message.method}`);
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
    const code = error instanceof EarthScienceError ? -32010 : -32603;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: error.message, data: { errorCode: error.code ?? "earth-internal-error", details: error.details ?? null } } })}\n`);
  }
});
