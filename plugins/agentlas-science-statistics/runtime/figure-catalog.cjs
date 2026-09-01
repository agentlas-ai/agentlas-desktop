"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_FILE = "figure-catalog.json";
const CATALOG_SCHEMA = "agentlas.science.statistics.figure-catalog/v1";
const MAX_CATALOG_BYTES = 512 * 1024;
const MIN_TEMPLATE_COUNT = 40;
const MIN_FAMILY_COVERAGE = 4;

const FAMILIES = Object.freeze([
  "distribution",
  "estimation",
  "regression-diagnostics",
  "classification",
  "survival",
  "multivariate",
  "time-series-signal",
  "contingency",
  "3d-numeric",
]);

const ROOT_KEYS = Object.freeze(["schema", "catalogVersion", "templates"]);
const TEMPLATE_KEYS = Object.freeze([
  "id",
  "family",
  "question",
  "requiredFields",
  "requiredStatistics",
  "renderer",
  "marks",
  "interactions",
  "exportProfiles",
  "unsupportedWithoutRawData",
]);
const FIELD_KEYS = Object.freeze(["role", "type", "cardinality", "constraints", "provenance"]);
const STATISTIC_KEYS = Object.freeze(["name", "assumptions", "provenance"]);
const RENDERER_KEYS = Object.freeze(["id", "capabilities"]);

const FIELD_TYPES = new Set(["quantitative", "nominal", "ordinal", "temporal", "binary"]);
const FIELD_CARDINALITIES = new Set(["one", "optional-one", "one-or-more", "two-or-more", "matrix", "grid-3d", "vector-3d"]);
const FIELD_CONSTRAINTS = new Set([
  "finite",
  "nonnegative",
  "positive",
  "probability",
  "integer",
  "ordered",
  "unique-identifier",
  "consistent-length",
  "two-level",
  "three-dimensional",
  "regular-grid",
  "monotonic-time",
  "censoring-coded",
  "no-empty-cells",
  "bounded-domain",
  "same-units",
  "normalized",
  "complete-cases",
  "calibrated-score",
  "event-aligned",
  "replicate-aware",
]);
const FIELD_PROVENANCE = new Set(["raw-observation", "derived-observation", "model-output", "summary-input"]);
const STATISTIC_PROVENANCE = new Set(["raw-data-derived", "model-derived", "summary-verified"]);

const RENDERER_CAPABILITIES = Object.freeze({
  "agentlas.vega": new Set([
    "cartesian-2d",
    "layered-marks",
    "faceting",
    "binning",
    "density-transform",
    "quantile-transform",
    "error-bands",
    "heatmap",
    "contour-2d",
    "linked-selections",
    "vector-export",
  ]),
  "agentlas.three-numeric": new Set([
    "surface-3d",
    "observed-points",
    "support-mask",
    "orbit-controls",
    "persisted-view-state",
    "raster-capture",
  ]),
});

const MARKS = new Set([
  "area",
  "band",
  "bar",
  "boxplot",
  "cell",
  "circle",
  "contour",
  "errorbar",
  "heatmap",
  "line",
  "link",
  "mesh",
  "point",
  "rect",
  "rule",
  "surface",
  "text",
  "tick",
  "trail",
  "vector",
  "violin",
  "volume",
]);
const INTERACTIONS = new Set([
  "none",
  "tooltip",
  "legend-filter",
  "brush-select",
  "zoom-pan",
  "linked-highlight",
  "threshold-control",
  "slice-control",
  "rotate-3d",
]);
const EXPORT_PROFILES = new Set([
  "journal-vector",
  "journal-raster-300dpi",
  "journal-raster-600dpi",
  "supplement-static",
  "supplement-interactive-local",
]);

const REMOTE_SOURCE = /(?:\b(?:https?|ftp):\/\/|\b(?:file|data|javascript):)/iu;
const ARBITRARY_CODE = /(?:<script\b|\b(?:eval|Function|require|import|fetch|WebSocket|exec|spawn)\s*\(|=>|\bchild_process\b|\bprocess\.)/iu;

class FigureCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FigureCatalogError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FigureCatalogError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail("STAT_FIGURE_SCHEMA", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("STAT_FIGURE_SCHEMA", `${label} has unknown or missing fields`);
  }
}

function safeString(value, label, maximum = 2_000) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximum || /[\u0000-\u001f]/u.test(value)) {
    fail("STAT_FIGURE_SCHEMA", `${label} must be a bounded non-empty string`);
  }
  if (REMOTE_SOURCE.test(value)) fail("STAT_FIGURE_REMOTE_SOURCE", `${label} must not contain a remote or executable URI`);
  if (ARBITRARY_CODE.test(value)) fail("STAT_FIGURE_ARBITRARY_CODE", `${label} must not contain executable code`);
  return value;
}

function uniqueKnownStrings(value, known, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 32) {
    fail("STAT_FIGURE_SCHEMA", `${label} must be a bounded${allowEmpty ? "" : " non-empty"} array`);
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    safeString(item, `${label}[${index}]`, 160);
    if (!known.has(item)) fail("STAT_FIGURE_REGISTRY", `${label} contains an unknown value`);
    if (seen.has(item)) fail("STAT_FIGURE_SCHEMA", `${label} contains duplicates`);
    seen.add(item);
  }
  return value;
}

function freeformStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    fail("STAT_FIGURE_SCHEMA", `${label} must be a bounded non-empty string array`);
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    safeString(item, `${label}[${index}]`);
    if (seen.has(item)) fail("STAT_FIGURE_SCHEMA", `${label} contains duplicates`);
    seen.add(item);
  }
  return value;
}

function validateRequiredFields(value, templateId) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    fail("STAT_FIGURE_SCHEMA", `${templateId}.requiredFields must be a bounded non-empty array`);
  }
  const roles = new Set();
  for (const [index, field] of value.entries()) {
    const label = `${templateId}.requiredFields[${index}]`;
    exactKeys(field, FIELD_KEYS, label);
    const role = safeString(field.role, `${label}.role`, 120);
    if (!/^[a-z][a-z0-9-]{0,119}$/u.test(role) || roles.has(role)) fail("STAT_FIGURE_SCHEMA", `${templateId} field roles must be unique slugs`);
    roles.add(role);
    if (!FIELD_TYPES.has(field.type)) fail("STAT_FIGURE_REGISTRY", `${label}.type is unknown`);
    if (!FIELD_CARDINALITIES.has(field.cardinality)) fail("STAT_FIGURE_REGISTRY", `${label}.cardinality is unknown`);
    uniqueKnownStrings(field.constraints, FIELD_CONSTRAINTS, `${label}.constraints`, { allowEmpty: true });
    if (!FIELD_PROVENANCE.has(field.provenance)) fail("STAT_FIGURE_PROVENANCE", `${label}.provenance is unknown`);
  }
}

function validateRequiredStatistics(value, templateId) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) {
    fail("STAT_FIGURE_SCHEMA", `${templateId}.requiredStatistics must be a bounded non-empty array`);
  }
  const names = new Set();
  for (const [index, statistic] of value.entries()) {
    const label = `${templateId}.requiredStatistics[${index}]`;
    exactKeys(statistic, STATISTIC_KEYS, label);
    const name = safeString(statistic.name, `${label}.name`, 200);
    if (names.has(name)) fail("STAT_FIGURE_SCHEMA", `${templateId} statistic names must be unique`);
    names.add(name);
    freeformStringArray(statistic.assumptions, `${label}.assumptions`);
    if (!STATISTIC_PROVENANCE.has(statistic.provenance)) fail("STAT_FIGURE_PROVENANCE", `${label}.provenance is unknown`);
  }
}

function validateRenderer(value, templateId) {
  exactKeys(value, RENDERER_KEYS, `${templateId}.renderer`);
  safeString(value.id, `${templateId}.renderer.id`, 120);
  const capabilities = RENDERER_CAPABILITIES[value.id];
  if (!capabilities) fail("STAT_FIGURE_RENDERER", `${templateId} uses an unknown renderer`);
  try {
    uniqueKnownStrings(value.capabilities, capabilities, `${templateId}.renderer.capabilities`);
  } catch (error) {
    if (error?.code === "STAT_FIGURE_REGISTRY") fail("STAT_FIGURE_RENDERER", `${templateId} claims a capability unavailable on ${value.id}`);
    throw error;
  }
}

function validateProvenance(template) {
  const fieldProvenance = new Set(template.requiredFields.map((field) => field.provenance));
  const statisticProvenance = new Set(template.requiredStatistics.map((statistic) => statistic.provenance));
  if (template.unsupportedWithoutRawData) {
    if (!fieldProvenance.has("raw-observation") || fieldProvenance.has("summary-input") || statisticProvenance.has("summary-verified")) {
      fail("STAT_FIGURE_PROVENANCE", `${template.id} declares a raw-data requirement but permits summary-only provenance`);
    }
  } else if (!fieldProvenance.has("model-output") && !fieldProvenance.has("summary-input")) {
    fail("STAT_FIGURE_PROVENANCE", `${template.id} must name the model or verified summary input that permits raw-data-free rendering`);
  }
  if (statisticProvenance.has("summary-verified") && !fieldProvenance.has("summary-input")) {
    fail("STAT_FIGURE_PROVENANCE", `${template.id} has summary statistics without a verified summary input`);
  }
  if (statisticProvenance.has("model-derived") && !fieldProvenance.has("model-output") && !fieldProvenance.has("raw-observation")) {
    fail("STAT_FIGURE_PROVENANCE", `${template.id} has model-derived statistics without model or raw-data lineage`);
  }
}

function validateFigureCatalog(catalog) {
  exactKeys(catalog, ROOT_KEYS, "figure catalog");
  if (catalog.schema !== CATALOG_SCHEMA) fail("STAT_FIGURE_SCHEMA", "unsupported figure catalog schema");
  if (typeof catalog.catalogVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(catalog.catalogVersion)) {
    fail("STAT_FIGURE_SCHEMA", "catalogVersion must be semantic version text");
  }
  if (!Array.isArray(catalog.templates) || catalog.templates.length < MIN_TEMPLATE_COUNT || catalog.templates.length > 500) {
    fail("STAT_FIGURE_COVERAGE", `figure catalog must contain at least ${MIN_TEMPLATE_COUNT} bounded templates`);
  }

  const ids = new Set();
  const familyCounts = Object.fromEntries(FAMILIES.map((family) => [family, 0]));
  for (const [index, template] of catalog.templates.entries()) {
    const label = `templates[${index}]`;
    exactKeys(template, TEMPLATE_KEYS, label);
    const id = safeString(template.id, `${label}.id`, 120);
    if (!/^[a-z][a-z0-9-]{2,119}$/u.test(id) || ids.has(id)) fail("STAT_FIGURE_REGISTRY", "figure template ids must be unique slugs");
    ids.add(id);
    if (!FAMILIES.includes(template.family)) fail("STAT_FIGURE_REGISTRY", `${id} uses an unknown family`);
    familyCounts[template.family] += 1;
    safeString(template.question, `${id}.question`);
    validateRequiredFields(template.requiredFields, id);
    validateRequiredStatistics(template.requiredStatistics, id);
    validateRenderer(template.renderer, id);
    uniqueKnownStrings(template.marks, MARKS, `${id}.marks`);
    uniqueKnownStrings(template.interactions, INTERACTIONS, `${id}.interactions`);
    if (template.interactions.includes("none") && template.interactions.length !== 1) {
      fail("STAT_FIGURE_SCHEMA", `${id}.interactions cannot combine none with active interactions`);
    }
    uniqueKnownStrings(template.exportProfiles, EXPORT_PROFILES, `${id}.exportProfiles`);
    if (typeof template.unsupportedWithoutRawData !== "boolean") fail("STAT_FIGURE_SCHEMA", `${id}.unsupportedWithoutRawData must be boolean`);
    validateProvenance(template);
  }

  for (const family of FAMILIES) {
    if (familyCounts[family] < MIN_FAMILY_COVERAGE) {
      fail("STAT_FIGURE_COVERAGE", `${family} must contain at least ${MIN_FAMILY_COVERAGE} templates`);
    }
  }
  return catalog;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function loadFigureCatalog(pluginRoot = path.resolve(__dirname, "..")) {
  const file = path.join(pluginRoot, CATALOG_FILE);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail("STAT_FIGURE_IO", "figure catalog is missing");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_CATALOG_BYTES) {
    fail("STAT_FIGURE_IO", "figure catalog must be a bounded regular file");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("STAT_FIGURE_SCHEMA", "figure catalog must be valid JSON");
  }
  return deepFreeze(validateFigureCatalog(parsed));
}

function summarizeFigureCatalog(catalog) {
  const validated = validateFigureCatalog(catalog);
  return Object.freeze({
    schema: validated.schema,
    catalogVersion: validated.catalogVersion,
    templateCount: validated.templates.length,
    familyCounts: Object.freeze(Object.fromEntries(FAMILIES.map((family) => [family, validated.templates.filter((template) => template.family === family).length]))),
    rawDataRequiredCount: validated.templates.filter((template) => template.unsupportedWithoutRawData).length,
  });
}

module.exports = {
  CATALOG_FILE,
  CATALOG_SCHEMA,
  EXPORT_PROFILES,
  FAMILIES,
  FigureCatalogError,
  INTERACTIONS,
  MARKS,
  RENDERER_CAPABILITIES,
  loadFigureCatalog,
  summarizeFigureCatalog,
  validateFigureCatalog,
};
