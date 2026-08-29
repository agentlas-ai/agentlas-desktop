#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const schemaPath = path.join(repo, "shared", "one-briefing-contract.v1.json");
const desktopOutput = path.join(repo, "shared", "one-briefing-contract.generated.ts");
const mobileOutput = path.resolve(
  repo,
  "..",
  "mobile",
  "app",
  "lib",
  "core",
  "models",
  "one_briefing_contract.generated.dart",
);
const check = process.argv.includes("--check") || process.argv.includes("--check-all");
const requireMobile = process.argv.includes("--check-all");

// Git may check this repository out with CRLF on Windows. The contract digest
// and generated files are release artifacts, so platform line endings must not
// change their bytes or make an otherwise identical checkout look stale.
const readNormalizedUtf8 = (file) => fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
const raw = readNormalizedUtf8(schemaPath);
const schema = JSON.parse(raw);
const digest = crypto.createHash("sha256").update(raw).digest("hex");

function assertContract() {
  if (schema.schemaVersion !== 1 || schema.contractVersion !== "1.0.0") {
    throw new Error("Unsupported One Briefing contract schema");
  }
  const groups = ["kinds", "cadences", "confidences", "sources", "actions", "reasons"];
  for (const group of groups) {
    if (!Array.isArray(schema[group]) || schema[group].length === 0) {
      throw new Error(`One Briefing ${group} must be a non-empty array`);
    }
    const wire = new Set();
    const dart = new Set();
    for (const item of schema[group]) {
      if (!item || typeof item.wire !== "string" || !/^[a-z][a-z0-9_]*$/.test(item.wire)) {
        throw new Error(`Invalid One Briefing ${group} wire value`);
      }
      if (typeof item.dart !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(item.dart)) {
        throw new Error(`Invalid One Briefing ${group} Dart value`);
      }
      if (wire.has(item.wire) || dart.has(item.dart)) {
        throw new Error(`Duplicate One Briefing ${group} value`);
      }
      wire.add(item.wire);
      dart.add(item.dart);
    }
  }
  const sources = new Set(schema.sources.map((item) => item.wire));
  for (const item of [...schema.actions, ...schema.reasons]) {
    if (!sources.has(item.source)) throw new Error(`Unknown One Briefing source ${item.source}`);
  }
}

const quoted = (value) => JSON.stringify(value);
const tsArray = (name, values) =>
  `export const ${name} = [${values.map((value) => quoted(value)).join(", ")}] as const;`;
const tsMap = (name, entries) => [
  `export const ${name} = {`,
  ...entries.map((item) => `  ${quoted(item.wire)}: ${quoted(item.source)},`),
  `} as const;`,
].join("\n");

function renderDesktop() {
  return [
    "// GENERATED from one-briefing-contract.v1.json. Do not edit by hand.",
    `// schema-sha256: ${digest}`,
    `export const ONE_BRIEFING_CONTRACT_VERSION = ${quoted(schema.contractVersion)} as const;`,
    tsArray("ONE_BRIEFING_KINDS", schema.kinds.map((item) => item.wire)),
    tsArray("ONE_BRIEFING_CADENCES", schema.cadences.map((item) => item.wire)),
    tsArray("ONE_BRIEFING_CONFIDENCES", schema.confidences.map((item) => item.wire)),
    tsArray("ONE_BRIEFING_SOURCE_KINDS", schema.sources.map((item) => item.wire)),
    tsArray("ONE_BRIEFING_PREPARED_ACTION_KINDS", schema.actions.map((item) => item.wire)),
    tsArray("ONE_BRIEFING_REASON_CODES", schema.reasons.map((item) => item.wire)),
    tsMap("ONE_BRIEFING_ACTION_SOURCE", schema.actions),
    tsMap("ONE_BRIEFING_REASON_SOURCE", schema.reasons),
    "export type OneBriefingKind = typeof ONE_BRIEFING_KINDS[number];",
    "export type OneBriefingCadence = typeof ONE_BRIEFING_CADENCES[number];",
    "export type OneBriefingConfidence = typeof ONE_BRIEFING_CONFIDENCES[number];",
    "export type OneBriefingSourceKind = typeof ONE_BRIEFING_SOURCE_KINDS[number];",
    "export type OneBriefingPreparedActionKind = typeof ONE_BRIEFING_PREPARED_ACTION_KINDS[number];",
    "export type OneBriefingReasonCode = typeof ONE_BRIEFING_REASON_CODES[number];",
    "",
  ].join("\n");
}

const dartEnum = (name, values) => `enum ${name} { ${values.map((item) => item.dart).join(", ")} }`;
const dartMap = (name, type, values) => [
  `const ${name} = <String, ${type}>{`,
  ...values.map((item) => `  ${quoted(item.wire)}: ${type}.${item.dart},`),
  "};",
].join("\n");
const dartStringMap = (name, values) => [
  `const ${name} = <String, String>{`,
  ...values.map((item) => `  ${quoted(item.wire)}: ${quoted(item.source)},`),
  "};",
].join("\n");

function renderMobile() {
  return [
    "// GENERATED from Agentlas Desktop shared/one-briefing-contract.v1.json.",
    "// Do not edit by hand.",
    `// schema-sha256: ${digest}`,
    `const oneBriefingContractVersion = ${quoted(schema.contractVersion)};`,
    dartEnum("OneDeviceBriefingCadence", schema.cadences),
    dartEnum("OneDeviceProactiveKind", schema.kinds),
    dartEnum("OneDeviceBriefingReason", schema.reasons),
    dartEnum("OneDeviceBriefingSourceKind", schema.sources),
    dartEnum("OneDeviceBriefingConfidence", schema.confidences),
    dartEnum("OneDevicePreparedActionKind", schema.actions),
    dartMap("oneBriefingCadenceByWire", "OneDeviceBriefingCadence", schema.cadences),
    dartMap("oneBriefingKindByWire", "OneDeviceProactiveKind", schema.kinds),
    dartMap("oneBriefingReasonByWire", "OneDeviceBriefingReason", schema.reasons),
    dartMap("oneBriefingSourceKindByWire", "OneDeviceBriefingSourceKind", schema.sources),
    dartMap("oneBriefingConfidenceByWire", "OneDeviceBriefingConfidence", schema.confidences),
    dartMap("oneBriefingActionKindByWire", "OneDevicePreparedActionKind", schema.actions),
    dartStringMap("oneBriefingReasonSourceByWire", schema.reasons),
    dartStringMap("oneBriefingActionSourceByWire", schema.actions),
  ].join("\n\n") + "\n";
}

function syncFile(target, expected, required) {
  if (!fs.existsSync(path.dirname(target))) {
    if (required) throw new Error(`Required generated target is unavailable: ${target}`);
    return;
  }
  if (check) {
    const current = fs.existsSync(target) ? readNormalizedUtf8(target) : "";
    if (current !== expected) throw new Error(`Generated One Briefing contract drift: ${target}`);
    return;
  }
  fs.writeFileSync(target, expected);
}

assertContract();
syncFile(desktopOutput, renderDesktop(), true);
syncFile(mobileOutput, renderMobile(), requireMobile);
console.log(`One Briefing contract ${check ? "verified" : "generated"}: ${digest.slice(0, 16)}`);
