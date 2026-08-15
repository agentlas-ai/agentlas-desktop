#!/usr/bin/env node
// Generate shared/model-catalog.snapshot.ts from models.dev (PRD 2026-08-15 D-4, tier 1).
//
// Policy (Cline's rule, adopted): consume the public catalog, do not maintain a
// hand-written model registry. This file is a GENERATED, trimmed, attributed
// copy so the app has an offline first-run answer for context windows and
// reasoning efforts. Tier 2 (remote refresh) overrides it at runtime; tier 3
// (runtime probes) decides what is actually available; tier 4 (overrides) wins.
//
// Usage:
//   node scripts/build-model-catalog-snapshot.cjs                # fetch models.dev
//   node scripts/build-model-catalog-snapshot.cjs --from <api.json>
//
// models.dev requires a User-Agent (403 without one — measured 2026-08-15).
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_URL = "https://models.dev/api.json";
const USER_AGENT = "agentlas-desktop/1.0 (+https://agentlas.ai; model-catalog-snapshot)";
// Providers this product can actually route to (BYOK backends + CLI vendors).
const PROVIDERS = [
  "anthropic", "openai", "google", "xai", "deepseek",
  "moonshotai", "kimi-for-coding", "zai", "zai-coding-plan",
  "minimax", "upstage", "mistral",
];
const OUT = path.join(__dirname, "..", "shared", "model-catalog.snapshot.ts");

async function load(argv) {
  const idx = argv.indexOf("--from");
  if (idx >= 0) return JSON.parse(fs.readFileSync(argv[idx + 1], "utf8"));
  const res = await fetch(SOURCE_URL, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`models.dev ${res.status} ${res.statusText}`);
  return res.json();
}

function trim(model, providerId) {
  const reasoningOptions = Array.isArray(model.reasoning_options) ? model.reasoning_options : [];
  const efforts = reasoningOptions
    .filter((opt) => opt && opt.type === "effort" && Array.isArray(opt.values))
    .flatMap((opt) => opt.values.map(String));
  return {
    provider: providerId,
    id: String(model.id),
    ...(model.name ? { name: String(model.name) } : {}),
    ...(model.limit && Number.isFinite(model.limit.context) ? { contextWindow: Number(model.limit.context) } : {}),
    ...(model.limit && Number.isFinite(model.limit.output) ? { maxOutput: Number(model.limit.output) } : {}),
    ...(typeof model.tool_call === "boolean" ? { toolCall: model.tool_call } : {}),
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
    ...(efforts.length ? { reasoningEfforts: [...new Set(efforts)] } : {}),
    ...(model.modalities && Array.isArray(model.modalities.input) ? { inputModalities: model.modalities.input.map(String) } : {}),
    ...(model.cost && (Number.isFinite(model.cost.input) || Number.isFinite(model.cost.output))
      ? { cost: { ...(Number.isFinite(model.cost.input) ? { input: model.cost.input } : {}), ...(Number.isFinite(model.cost.output) ? { output: model.cost.output } : {}) } }
      : {}),
    ...(model.release_date ? { releaseDate: String(model.release_date) } : {}),
  };
}

(async () => {
  const api = await load(process.argv.slice(2));
  const models = [];
  const providers = [];
  for (const providerId of PROVIDERS) {
    const provider = api[providerId];
    if (!provider || !provider.models) continue;
    providers.push({ id: providerId, name: String(provider.name || providerId) });
    for (const model of Object.values(provider.models)) models.push(trim(model, providerId));
  }
  models.sort((a, b) => (a.provider + "\u0000" + a.id).localeCompare(b.provider + "\u0000" + b.id));
  const total = Object.values(api).reduce((n, p) => n + Object.keys((p && p.models) || {}).length, 0);
  const generatedAt = new Date().toISOString().slice(0, 10);
  const snapshot = {
    schemaVersion: "agentlas.model-catalog-snapshot.v1",
    generatedAt,
    source: SOURCE_URL,
    attribution: "Data © models.dev contributors (anomalyco/models.dev), MIT License. Trimmed to the providers Agentlas routes to.",
    upstream: { providers: Object.keys(api).length, models: total },
    providers,
    models,
  };
  const body = [
    "// GENERATED FILE — do not edit by hand. Regenerate with:",
    "//   node scripts/build-model-catalog-snapshot.cjs",
    "// Tier-1 (offline) layer of the 4-tier model catalog. See shared/model-catalog.ts.",
    "// Attribution: models.dev (anomalyco/models.dev), MIT. Providers trimmed to Agentlas backends.",
    "import type { CatalogSnapshot } from \"./model-catalog\";",
    "",
    "export const MODEL_CATALOG_SNAPSHOT: CatalogSnapshot = " + JSON.stringify(snapshot, null, 2) + ";",
    "",
  ].join("\n");
  fs.writeFileSync(OUT, body);
  console.log(`model-catalog snapshot: ${models.length} models / ${providers.length} providers (upstream ${total} models) -> ${path.relative(process.cwd(), OUT)}`);
})().catch((err) => {
  console.error("build-model-catalog-snapshot: " + (err && err.message ? err.message : err));
  process.exit(1);
});
