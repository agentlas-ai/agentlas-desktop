"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const KETCHER_VERSION = "3.17.2";
const INDIGO_VERSION = "1.45.1";
const CHECKS = "valence;radicals;pseudoatoms;stereochemistry;overlapping_atoms;overlapping_bonds;3d";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(value, maximum, field) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(`science-tool-${field}-invalid`);
  return value.trim();
}

function documentText(value, maximum, field) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(`science-tool-${field}-invalid`);
  return value.trim();
}

function exactSdfText(value, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail("science-tool-sdf-invalid");
  const terminators = value.match(/^\$\$\$\$\s*$/gm) || [];
  if (terminators.length !== 1 || !/\$\$\$\$\s*$/.test(value)) fail("science-tool-sdf-record-count-invalid");
  return value;
}

function molCounts(molfile) {
  const lines = molfile.replace(/\r/g, "").split("\n");
  const counts = lines.find((line) => /V2000\s*$/.test(line));
  if (!counts) fail("science-tool-molfile-counts-missing");
  const atomCount = Number.parseInt(counts.slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt(counts.slice(3, 6).trim(), 10);
  if (!Number.isSafeInteger(atomCount) || atomCount < 1 || atomCount > 50_000
    || !Number.isSafeInteger(bondCount) || bondCount < 0 || bondCount > 100_000) fail("science-tool-molfile-counts-invalid");
  return { atomCount, bondCount };
}

function warningLabels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("science-tool-indigo-check-invalid");
  return Object.entries(value)
    .filter(([, warning]) => warning !== "" && warning !== null && warning !== undefined && warning !== false)
    .map(([key]) => key)
    .sort();
}

async function main() {
  const [inputArg, outputArg] = process.argv.slice(2);
  const cwd = fs.realpathSync(process.cwd());
  const inputPath = path.resolve(String(inputArg || ""));
  const outputPath = path.resolve(String(outputArg || ""));
  if (inputPath !== path.join(cwd, "input.json") || outputPath !== path.join(cwd, "output.json")) fail("science-tool-path-denied");
  const stat = fs.lstatSync(inputPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 8 * 1024 * 1024) fail("science-tool-input-invalid");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const directInput = input && input.schema === "agentlas.science-ketcher-validation-input/v1";
  const sourceInput = input && input.schema === "agentlas.science-source-to-ketcher-input/v1";
  if ((!directInput && !sourceInput) || !input.source
    || (directInput && !["smiles", "ket"].includes(input.source.format))
    || (sourceInput && input.source.format !== "sdf")) fail("science-tool-input-schema-invalid");
  if (sourceInput) {
    const keys = Object.keys(input.source).sort().join(",");
    if (keys !== "contentSha256,format,id,value,versionId"
      || typeof input.source.id !== "string" || typeof input.source.versionId !== "string"
      || typeof input.source.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.source.contentSha256)) {
      fail("science-tool-source-binding-invalid");
    }
  }
  const title = text(input.title, 240, "title");
  const source = input.source.format === "sdf"
    ? exactSdfText(input.source.value, 4 * 1024 * 1024)
    : input.source.format === "ket"
      ? documentText(input.source.value, 3 * 1024 * 1024, input.source.format)
    : text(input.source.value, 100_000, input.source.format);
  if (sourceInput && sha256(Buffer.from(source, "utf8")) !== input.source.contentSha256) fail("science-tool-source-content-mismatch");

  const initialize = require("./indigo-ketcher-norender.js");
  const indigo = await initialize();
  const validatorVersion = text(indigo.version(), 240, "indigo-version");
  if (!validatorVersion.startsWith(`${INDIGO_VERSION}.`)) fail("science-tool-indigo-version-mismatch");

  const inputOptions = new indigo.MapStringString();
  if (input.source.format === "smiles") inputOptions.set("input-format", "chemical/x-daylight-smiles");
  if (input.source.format === "sdf") inputOptions.set("input-format", "chemical/x-mdl-sdfile");
  let ket;
  let canonicalSmiles;
  let molfile;
  try {
    if (sourceInput) {
      const sourceCanonicalSmiles = indigo.convert(source, "smiles", inputOptions).trim();
      const sourceInchi = indigo.convert(source, "inchi", inputOptions).trim();
      ket = indigo.layout(source, "ket", inputOptions);
      const ketOptions = new indigo.MapStringString();
      ketOptions.set("input-format", "ket");
      try {
        canonicalSmiles = indigo.convert(ket, "smiles", ketOptions).trim();
        const derivedInchi = indigo.convert(ket, "inchi", ketOptions).trim();
        molfile = indigo.convert(ket, "molfile", ketOptions);
        if (canonicalSmiles !== sourceCanonicalSmiles || derivedInchi !== sourceInchi) {
          fail("science-tool-source-2d-identity-mismatch");
        }
      } finally {
        ketOptions.delete();
      }
    } else {
      ket = input.source.format === "ket" ? source : indigo.convert(source, "ket", inputOptions);
      canonicalSmiles = indigo.convert(source, "smiles", inputOptions).trim();
      molfile = indigo.convert(source, "molfile", inputOptions);
    }
  } finally {
    inputOptions.delete();
  }
  ket = documentText(ket, 3 * 1024 * 1024, "ket");
  canonicalSmiles = text(canonicalSmiles, 200_000, "canonical-smiles");
  const checkOptions = new indigo.MapStringString();
  let warnings;
  try {
    warnings = warningLabels(JSON.parse(indigo.check(ket, CHECKS, checkOptions)));
  } finally {
    checkOptions.delete();
  }
  if (warnings.length > 0) fail(`science-tool-chemistry-warning:${warnings.join(",")}`);
  const counts = molCounts(molfile);
  const ketSha256 = sha256(ket);
  const canonicalSmilesSha256 = sha256(canonicalSmiles);
  const output = {
    schema: "agentlas.science-tool-artifact-candidate/v2",
    artifact: {
      kind: "chemistry.document",
      title,
      rendererId: "agentlas.ketcher",
      payload: {
        document: { format: "ket", ket, ketSha256, canonicalSmiles, canonicalSmilesSha256 },
        validation: {
          schema: "agentlas.science-chemistry-validation/v1",
          engine: "Ketcher",
          engineVersion: KETCHER_VERSION,
          validator: "Indigo",
          validatorVersion,
          ketSha256,
          canonicalSmilesSha256,
          atomCount: counts.atomCount,
          bondCount: counts.bondCount,
          warnings: [],
          code: "structure-valid",
        },
      },
      semantic: {
        title,
        summary: `An Indigo-validated molecular structure prepared for interactive Ketcher editing. Canonical SMILES: ${canonicalSmiles}`,
        entities: [],
        observations: [
          { label: "Atoms", value: counts.atomCount, unit: null },
          { label: "Bonds", value: counts.bondCount, unit: null },
          { label: "Canonical SMILES", value: canonicalSmiles, unit: null },
        ],
        warnings: sourceInput
          ? ["This editable Ketcher document is an Indigo-normalized conversion, not the original immutable SDF bytes."]
          : [],
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(output), "utf8");
  if (bytes.length > 4 * 1024 * 1024) fail("science-tool-output-too-large");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

void main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
