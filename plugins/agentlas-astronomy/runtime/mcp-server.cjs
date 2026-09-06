#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const toolCatalog = require("../schemas/tools.json");
const { AstronomyDataError, analyzeAstrometricKinematics, analyzeLightCurvePeriodicity, createAstronomyClient } = require("./astronomy.cjs");
const { ANALYSIS_TOOLS, analysisToolCatalog, callAnalysisTool } = require("./analysis-tools.cjs");

const client = createAstronomyClient();
const ANALYSIS_TOOL_NAMES = new Set(ANALYSIS_TOOLS.map((tool) => tool.name));
const describeIndex = toolCatalog.tools.findIndex((tool) => tool.name === "describe_astronomy_capabilities");
const TOOL_LIST = [...toolCatalog.tools.slice(0, describeIndex), ...analysisToolCatalog(), ...toolCatalog.tools.slice(describeIndex)];

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function exactArguments(value, allowed, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AstronomyDataError(code);
  const unknownFields = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknownFields.length) throw new AstronomyDataError(code, code, { unknownFields: unknownFields.sort() });
}

async function callTool(name, args) {
  if (name === "search_simbad_catalog") {
    exactArguments(args, ["center_ra_deg", "center_dec_deg", "radius_deg", "limit", "format"], "simbad-mcp-input-invalid");
    return toolResult(await client.search({
      centerRaDeg: args.center_ra_deg,
      centerDecDeg: args.center_dec_deg,
      radiusDeg: args.radius_deg,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      ...(args.format === undefined ? {} : { format: args.format }),
    }));
  }
  if (name === "analyze_astrometric_kinematics") {
    exactArguments(args, ["source_content_sha256", "measurements", "max_fractional_parallax_error", "max_fractional_proper_motion_error"], "astronomy-kinematics-mcp-input-invalid");
    if (!Array.isArray(args.measurements)) throw new AstronomyDataError("astronomy-kinematics-mcp-input-invalid");
    const measurements = args.measurements.map((measurement, index) => {
      exactArguments(measurement, [
        "stable_object_id", "main_id", "parallax_mas", "parallax_error_mas", "proper_motion_ra_mas_yr",
        "proper_motion_dec_mas_yr", "proper_motion_error_ellipse",
      ], "astronomy-kinematics-mcp-measurement-invalid");
      const ellipse = measurement.proper_motion_error_ellipse;
      if (ellipse !== null && ellipse !== undefined) {
        exactArguments(ellipse, ["major_mas_yr", "minor_mas_yr", "angle_deg"], "astronomy-kinematics-mcp-error-ellipse-invalid");
      }
      return {
        stableObjectId: measurement.stable_object_id,
        mainId: measurement.main_id,
        parallaxMas: measurement.parallax_mas,
        parallaxErrorMas: measurement.parallax_error_mas,
        properMotionRaMasYr: measurement.proper_motion_ra_mas_yr,
        properMotionDecMasYr: measurement.proper_motion_dec_mas_yr,
        properMotionErrorEllipse: ellipse === null || ellipse === undefined ? ellipse : {
          majorMasYr: ellipse.major_mas_yr,
          minorMasYr: ellipse.minor_mas_yr,
          angleDeg: ellipse.angle_deg,
        },
      };
    });
    return toolResult(analyzeAstrometricKinematics({
      sourceContentSha256: args.source_content_sha256,
      measurements,
      ...(args.max_fractional_parallax_error === undefined ? {} : { maxFractionalParallaxError: args.max_fractional_parallax_error }),
      ...(args.max_fractional_proper_motion_error === undefined ? {} : { maxFractionalProperMotionError: args.max_fractional_proper_motion_error }),
    }));
  }
  if (name === "analyze_light_curve_periodicity") {
    exactArguments(args, [
      "source_content_sha256", "target_id", "time_system", "time_offset_days", "value_kind", "value_unit", "weighting",
      "minimum_period_days", "maximum_period_days", "frequency_count", "maximum_peaks", "measurements",
    ], "astronomy-periodogram-mcp-input-invalid");
    if (!Array.isArray(args.measurements)) throw new AstronomyDataError("astronomy-periodogram-mcp-input-invalid");
    const measurements = args.measurements.map((measurement) => {
      exactArguments(measurement, ["observation_id", "time", "value", "standard_error", "use"], "astronomy-periodogram-mcp-measurement-invalid");
      return {
        observationId: measurement.observation_id,
        time: measurement.time,
        value: measurement.value,
        standardError: measurement.standard_error,
        use: measurement.use,
      };
    });
    return toolResult(analyzeLightCurvePeriodicity({
      sourceContentSha256: args.source_content_sha256,
      targetId: args.target_id,
      timeSystem: args.time_system,
      timeOffsetDays: args.time_offset_days,
      valueKind: args.value_kind,
      valueUnit: args.value_unit,
      weighting: args.weighting,
      minimumPeriodDays: args.minimum_period_days,
      maximumPeriodDays: args.maximum_period_days,
      frequencyCount: args.frequency_count,
      ...(args.maximum_peaks === undefined ? {} : { maximumPeaks: args.maximum_peaks }),
      measurements,
    }));
  }
  if (name === "describe_astronomy_capabilities") {
    exactArguments(args, [], "astronomy-capabilities-input-invalid");
    return toolResult(client.describeCapabilities());
  }
  if (ANALYSIS_TOOL_NAMES.has(name)) return toolResult(callAnalysisTool(name, args));
  throw new AstronomyDataError("astronomy-tool-not-found", `Unknown Astronomy tool: ${name}`);
}

async function handle(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "agentlas-astronomy", version: "1.2.2" },
    };
  }
  if (message.method === "tools/list") return { tools: TOOL_LIST };
  if (message.method === "tools/call") return callTool(message.params?.name, message.params?.arguments ?? {});
  if (message.method?.startsWith("notifications/")) return null;
  throw new AstronomyDataError("astronomy-method-not-found", `Unknown JSON-RPC method: ${message.method}`);
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
    try { await handle(message); } catch { /* JSON-RPC notifications never receive a response */ }
    return;
  }
  try {
    const result = await handle(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  } catch (error) {
    const code = error instanceof AstronomyDataError ? -32020 : -32603;
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code,
        message: error.message,
        data: { errorCode: error.code ?? "astronomy-internal-error", details: error.details ?? null },
      },
    })}\n`);
  }
});
