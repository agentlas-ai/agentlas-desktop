"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const env = require("./python-env.cjs");

const PLUGIN_VERSION = "0.1.0";
const CAPABILITIES = require("../capabilities.json");
const GUARDS = CAPABILITIES.guards;
const RUNTIME = CAPABILITIES.runtime;

class MedchemError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

function only(args, allowed, code) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new MedchemError(code);
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new MedchemError(code, `Unknown argument: ${key}`);
}
function bool(value, fallback, code) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new MedchemError(code);
  return value;
}
function integer(value, min, max, fallback, code) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new MedchemError(code);
  return value;
}

function molecules(value, max) {
  const list = typeof value === "string" ? [{ smiles: value }] : value;
  if (!Array.isArray(list) || list.length < 1 || list.length > max) throw new MedchemError("molecules-invalid", `Supply 1-${max} molecules.`);
  return list.map((item, index) => {
    const molecule = typeof item === "string" ? { smiles: item } : item;
    if (!molecule || typeof molecule !== "object" || Array.isArray(molecule)) throw new MedchemError("molecule-invalid", `Molecule ${index} is not an object.`);
    for (const key of Object.keys(molecule)) if (!["name", "smiles"].includes(key)) throw new MedchemError("molecule-invalid", `Molecule ${index}: unknown key ${key}`);
    if (typeof molecule.smiles !== "string" || !molecule.smiles.trim() || molecule.smiles.length > GUARDS.maxSmilesLength || /[\s\u0000-\u001f]/u.test(molecule.smiles.trim())) {
      throw new MedchemError("molecule-smiles-invalid", `Molecule ${index}: SMILES must be one token of at most ${GUARDS.maxSmilesLength} characters.`);
    }
    if (molecule.name !== undefined && (typeof molecule.name !== "string" || molecule.name.length > 120 || /[\u0000-\u001f]/u.test(molecule.name))) throw new MedchemError("molecule-name-invalid");
    return { smiles: molecule.smiles.trim(), ...(molecule.name ? { name: molecule.name.trim() } : {}) };
  });
}

function bounded(result, budget, rowKeys) {
  let bytes = Buffer.byteLength(JSON.stringify(result));
  let trimmed = false;
  while (bytes > budget) {
    let cut = false;
    for (const key of rowKeys) if (Array.isArray(result[key]) && result[key].length > 1) { result[key].length = Math.max(1, Math.floor(result[key].length * 0.7)); cut = true; }
    if (!cut) break;
    trimmed = true;
    bytes = Buffer.byteLength(JSON.stringify(result));
  }
  result.resultBytes = bytes;
  if (trimmed) result.truncatedForSize = true;
  return result;
}

function ketcherHandoff(row) {
  const smiles = row.standardizedSmiles || row.canonicalSmiles;
  if (!smiles) return null;
  return { contract: "agentlas.smiles-to-ketcher", input: { title: row.name || row.formula || smiles.slice(0, 60), smiles } };
}

/** The same working-folder rule as the structural-biology plugin: beneath the run's folder, never root/home/links. */
function writeOutputs(cwd, files) {
  const resolved = path.resolve(cwd);
  const home = process.env.HOME || process.env.USERPROFILE || null;
  if (resolved === path.parse(resolved).root) return { written: [], skippedReason: "working-folder-is-filesystem-root" };
  if (home && path.resolve(home) === resolved) return { written: [], skippedReason: "working-folder-is-home" };
  const pluginRoot = path.resolve(__dirname, "..");
  if (resolved === pluginRoot || resolved.startsWith(pluginRoot + path.sep)) return { written: [], skippedReason: "working-folder-is-plugin-release" };
  try { if (!fs.lstatSync(resolved).isDirectory()) return { written: [], skippedReason: "working-folder-not-directory" }; }
  catch { return { written: [], skippedReason: "working-folder-missing" }; }
  const dir = path.join(resolved, "agentlas-medchem");
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { written: [], skippedReason: "output-folder-not-plain-directory" };
  } catch (error) { if (error.code !== "ENOENT") throw error; fs.mkdirSync(dir, { mode: 0o755 }); }
  const written = [];
  for (const file of files) {
    const target = path.join(dir, file.name);
    try { const stat = fs.lstatSync(target); if (stat.isSymbolicLink() || !stat.isFile()) return { written, skippedReason: "output-file-not-plain-file" }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(dir, `.${file.name}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    fs.writeFileSync(temporary, file.bytes, { mode: 0o644, flag: "wx" });
    fs.renameSync(temporary, target);
    written.push({ role: file.role, path: `agentlas-medchem/${file.name}`, mediaType: file.mediaType, byteLength: file.bytes.length, sha256: crypto.createHash("sha256").update(file.bytes).digest("hex") });
  }
  return { written, skippedReason: null };
}

function createMedchemClient(options = {}) {
  const cwd = () => options.cwd || process.cwd();

  async function compute(op, list, workerOptions) {
    const current = env.status().state === "ready" ? env.status() : await env.waitReady(options.firstCallWaitMs ?? RUNTIME.firstCallWaitMs);
    if (current.state !== "ready") {
      const started = current.state === "absent" || current.state === "failed" ? env.ensureInstallStarted() : current;
      return { pending: true, runtime: { ...started, note: started.state === "installing" ? "RDKit is being installed once into this plugin's managed Python environment; the same call succeeds once it is ready." : undefined, retryAfterSeconds: started.state === "installing" ? 20 : null } };
    }
    const response = await env.runWorker({ op, molecules: list, options: workerOptions }, { timeoutMs: RUNTIME.workerTimeoutMs });
    if (!response.ok) {
      if (response.error?.code === "rdkit-import-failed" || response.error?.code === "medchem-worker-spawn-failed") {
        // The environment was built against an interpreter that is gone (for example an app update): rebuild it once.
        fs.rmSync(path.join(env.environmentDir(), "ready.json"), { force: true });
        env.ensureInstallStarted({ force: true });
      }
      throw new MedchemError(response.error?.code || "medchem-worker-failed", response.error?.message, response.error?.stderr ? { stderr: response.error.stderr } : null);
    }
    return { pending: false, runtime: current, value: response.result };
  }

  const runtimeFacts = (runtime) => ({ engine: "RDKit", rdkitVersion: runtime.rdkitVersion, python: runtime.python?.version ?? null, source: runtime.source });

  async function computeMolecularProperties(args = {}) {
    only(args, ["molecules", "include_alerts", "view"], "properties-arguments-invalid");
    const list = molecules(args.molecules, GUARDS.maxMolecules);
    const view = args.view === undefined ? "summary" : args.view;
    if (!["summary", "full"].includes(view)) throw new MedchemError("properties-view-invalid");
    const outcome = await compute("properties", list, { include_alerts: bool(args.include_alerts, true, "properties-include-alerts-invalid"), view });
    if (outcome.pending) return { schema: "agentlas.medchem.properties/v1", status: "runtime-preparing", runtime: outcome.runtime };
    const rows = outcome.value.rows.map((row) => ({ ...row, ...(row.error ? {} : { ketcher: ketcherHandoff(row) }) }));
    const columns = ["name", "formula", "molecularWeight", "cLogP", "tpsa", "hbdLipinski", "hbaLipinski", "rotatableBonds", "aromaticRings", "fractionCsp3", "qed", "lipinskiViolations", "veber"];
    const table = {
      schema: "agentlas.science-table/v1",
      columns,
      rows: rows.filter((row) => !row.error).map((row) => [row.name ?? row.canonicalSmiles, row.formula, row.molecularWeight, row.cLogP, row.tpsa, row.hbdLipinski, row.hbaLipinski, row.rotatableBonds, row.aromaticRings, row.fractionCsp3, row.qed, row.rules.lipinskiRo5.violations, row.rules.veber.pass]),
    };
    return bounded({
      schema: "agentlas.medchem.properties/v1",
      status: "ok",
      view,
      count: rows.length,
      failed: rows.filter((row) => row.error).length,
      table,
      molecules: rows,
      units: { molecularWeight: "g/mol", exactMass: "Da", tpsa: "Å²" },
      runtime: runtimeFacts(outcome.runtime),
    }, view === "full" ? GUARDS.fullResultBytes : GUARDS.summaryResultBytes, ["molecules"]);
  }

  async function standardizeSmiles(args = {}) {
    only(args, ["molecules", "keep_largest_fragment", "neutralize", "canonical_tautomer"], "standardize-arguments-invalid");
    const list = molecules(args.molecules, GUARDS.maxMolecules);
    const outcome = await compute("standardize", list, {
      keep_largest_fragment: bool(args.keep_largest_fragment, true, "standardize-fragment-invalid"),
      neutralize: bool(args.neutralize, true, "standardize-neutralize-invalid"),
      canonical_tautomer: bool(args.canonical_tautomer, false, "standardize-tautomer-invalid"),
    });
    if (outcome.pending) return { schema: "agentlas.medchem.standardized/v1", status: "runtime-preparing", runtime: outcome.runtime };
    const rows = outcome.value.rows.map((row) => ({ ...row, ...(row.error ? {} : { ketcher: ketcherHandoff(row) }) }));
    return bounded({ schema: "agentlas.medchem.standardized/v1", status: "ok", count: rows.length, changed: rows.filter((row) => row.changed).length, molecules: rows, runtime: runtimeFacts(outcome.runtime) }, GUARDS.fullResultBytes, ["molecules"]);
  }

  async function drawCompoundGrid(args = {}) {
    only(args, ["molecules", "mols_per_row", "sub_image_size", "save_files", "title"], "grid-arguments-invalid");
    const list = molecules(args.molecules, GUARDS.maxGridMolecules);
    const perRow = integer(args.mols_per_row, 1, 8, 4, "grid-mols-per-row-invalid");
    const size = integer(args.sub_image_size, 150, 600, 300, "grid-size-invalid");
    const save = bool(args.save_files, true, "grid-save-files-invalid");
    if (args.title !== undefined && (typeof args.title !== "string" || args.title.length > 80)) throw new MedchemError("grid-title-invalid");
    const outcome = await compute("grid", list, { mols_per_row: perRow, sub_image_size: size });
    if (outcome.pending) return { schema: "agentlas.medchem.compound-grid/v1", status: "runtime-preparing", runtime: outcome.runtime };
    if (outcome.value.error) throw new MedchemError(outcome.value.error, null, { failures: outcome.value.failures });
    const svg = Buffer.from(outcome.value.svgBase64, "base64");
    const png = Buffer.from(outcome.value.pngBase64, "base64");
    const slug = (args.title || "compound-grid").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40) || "compound-grid";
    const stem = `${slug}-${outcome.value.pngSha256.slice(0, 8)}`;
    const written = save ? writeOutputs(cwd(), [
      { role: "grid-svg", name: `${stem}.svg`, bytes: svg, mediaType: "image/svg+xml" },
      { role: "grid-png", name: `${stem}.png`, bytes: png, mediaType: "image/png" },
    ]) : { written: [], skippedReason: "save-files-false" };
    return {
      schema: "agentlas.medchem.compound-grid/v1",
      status: "ok",
      drawn: outcome.value.drawn,
      failures: outcome.value.failures,
      layout: { molsPerRow: outcome.value.molsPerRow, subImageSize: outcome.value.subImageSize },
      images: { svgSha256: outcome.value.svgSha256, pngSha256: outcome.value.pngSha256, pngBytes: png.length },
      files: written.written,
      ...(written.skippedReason ? { fileWriteSkipped: written.skippedReason } : {}),
      ketcher: list.map((molecule) => ({ contract: "agentlas.smiles-to-ketcher", input: { title: molecule.name || molecule.smiles.slice(0, 60), smiles: molecule.smiles } })),
      runtime: runtimeFacts(outcome.runtime),
    };
  }

  async function describeMedchemRuntime(args = {}) {
    only(args, ["prepare"], "runtime-arguments-invalid");
    const prepare = bool(args.prepare, false, "runtime-prepare-invalid");
    const current = prepare ? env.ensureInstallStarted({ force: true }) : env.status();
    return { schema: "agentlas.medchem.runtime/v1", platform: env.platformKey(), ...current, policy: { location: RUNTIME.location, onlyBinaryWheels: true, indexUrl: RUNTIME.indexUrl, network: RUNTIME.network } };
  }

  return { computeMolecularProperties, standardizeSmiles, drawCompoundGrid, describeMedchemRuntime };
}

module.exports = { PLUGIN_VERSION, createMedchemClient, MedchemError };
