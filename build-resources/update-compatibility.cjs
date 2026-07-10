const fs = require("node:fs");
const path = require("node:path");

const FIELDS = [
  "minimumSourceAppVersion",
  "minimumRuntimeVersion",
  "minimumSchemaVersion",
  "targetSchemaVersion",
  "bundledRuntimeVersion",
];

function loadUpdateCompatibility(packageJsonPath) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const value = pkg.agentlasUpdateCompatibility;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("package.json.agentlasUpdateCompatibility is required for release feeds");
  }
  for (const field of FIELDS) {
    if (!(field in value)) throw new Error(`agentlasUpdateCompatibility.${field} is required`);
  }
  for (const field of ["minimumSourceAppVersion", "minimumRuntimeVersion", "bundledRuntimeVersion"]) {
    if (typeof value[field] !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value[field])) {
      throw new Error(`agentlasUpdateCompatibility.${field} must be a semantic version`);
    }
  }
  for (const field of ["minimumSchemaVersion", "targetSchemaVersion"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new Error(`agentlasUpdateCompatibility.${field} must be a non-negative integer`);
    }
  }
  if (value.targetSchemaVersion < value.minimumSchemaVersion) {
    throw new Error("targetSchemaVersion cannot be lower than minimumSchemaVersion");
  }
  return Object.fromEntries(FIELDS.map((field) => [field, value[field]]));
}

function withoutCompatibilityBlock(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line === "agentlasCompatibility:");
  if (start < 0) return lines.join("\n").replace(/\n*$/, "\n");
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith("  ") || lines[end].trim() === "")) end += 1;
  lines.splice(start, end - start);
  return lines.join("\n").replace(/\n*$/, "\n");
}

function compatibilityYaml(compatibility) {
  return [
    "agentlasCompatibility:",
    `  minimumSourceAppVersion: '${compatibility.minimumSourceAppVersion}'`,
    `  minimumRuntimeVersion: '${compatibility.minimumRuntimeVersion}'`,
    `  minimumSchemaVersion: ${compatibility.minimumSchemaVersion}`,
    `  targetSchemaVersion: ${compatibility.targetSchemaVersion}`,
    `  bundledRuntimeVersion: '${compatibility.bundledRuntimeVersion}'`,
    "",
  ].join("\n");
}

function stampUpdateCompatibilityFile(filePath, packageJsonPath) {
  const compatibility = loadUpdateCompatibility(packageJsonPath);
  const source = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, `${withoutCompatibilityBlock(source)}${compatibilityYaml(compatibility)}`, "utf8");
  return compatibility;
}

module.exports = {
  FIELDS,
  compatibilityYaml,
  loadUpdateCompatibility,
  stampUpdateCompatibilityFile,
  withoutCompatibilityBlock,
};
