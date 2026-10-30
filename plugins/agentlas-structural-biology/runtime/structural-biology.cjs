"use strict";

// Agentlas Structural Biology: RCSB PDB search and structure retrieval, AlphaFold DB models with pLDDT, ligand binding-site
// residues computed from deposited coordinates, ChEMBL bioactivity and ClinicalTrials.gov registrations. Every endpoint is
// public and keyless. Results default to a compact summary view; `view: "full"` returns more rows, still bounded.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createPoliteHttp, PluginHttpError, sha256 } = require("./polite-http.cjs");
const { parseMmcif, categoryRows, atomSites, structConnections, missing } = require("./mmcif.cjs");

const PLUGIN_VERSION = "0.1.0";
const USER_AGENT = `Agentlas-Structural-Biology/${PLUGIN_VERSION} (structural biology research; https://agentlas.cloud)`;
const CAPABILITIES = require("../capabilities.json");
const GUARDS = CAPABILITIES.guards;

class StructuralBiologyError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

const PDB_ID = /^[0-9][A-Za-z0-9]{3}$/;
const UNIPROT = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/;
const CHEMBL_ID = /^CHEMBL[0-9]{1,10}$/;
const COMP_ID = /^[A-Za-z0-9]{1,5}$/;
const SOLVENT_AND_IONS = new Set(["HOH", "DOD", "WAT", "SO4", "PO4", "GOL", "EDO", "PEG", "ACT", "CL", "NA", "K", "MG", "ZN", "CA", "MN", "FE", "CU", "NI", "CO", "IOD", "BR", "DMS", "FMT", "MPD", "TRS", "EPE", "MES", "NO3", "NH4", "CD", "HG"]);

function object(value, code) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StructuralBiologyError(code);
  return value;
}
function only(args, allowed, code) {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new StructuralBiologyError(code, `Unknown argument: ${key}`);
}
function text(value, max, code, { optional = false, pattern = null } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new StructuralBiologyError(code);
  }
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new StructuralBiologyError(code);
  const trimmed = value.trim();
  if (!trimmed || (pattern && !pattern.test(trimmed))) throw new StructuralBiologyError(code);
  return trimmed;
}
function integer(value, min, max, fallback, code) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new StructuralBiologyError(code);
  return value;
}
function number(value, min, max, fallback, code) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new StructuralBiologyError(code);
  return value;
}
function choice(value, options, fallback, code) {
  if (value === undefined) return fallback;
  if (!options.includes(value)) throw new StructuralBiologyError(code);
  return value;
}
function bool(value, fallback, code) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new StructuralBiologyError(code);
  return value;
}
const clip = (value, max) => (typeof value === "string" && value.length > max ? `${value.slice(0, max - 1)}…` : value ?? null);
const round = (value, digits = 2) => (typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Keep a result under its byte budget: shorten the declared row arrays, never the scalar facts. */
function bounded(result, budget, rowKeys) {
  let bytes = Buffer.byteLength(JSON.stringify(result));
  let trimmed = false;
  while (bytes > budget) {
    let cut = false;
    for (const key of rowKeys) {
      const rows = key.split(".").reduce((value, part) => (value ? value[part] : undefined), result);
      if (Array.isArray(rows) && rows.length > 1) { rows.length = Math.max(1, Math.floor(rows.length * 0.7)); cut = true; }
    }
    if (!cut) break;
    trimmed = true;
    bytes = Buffer.byteLength(JSON.stringify(result));
  }
  result.resultBytes = bytes;
  if (trimmed) result.truncatedForSize = true;
  return result;
}

function receipt(provider, attempts, extra = {}) {
  return {
    schema: "agentlas.structural-biology.receipt/v1",
    provider: provider.id,
    license: provider.license,
    docsUrl: provider.docsUrl,
    retrievedAt: new Date().toISOString(),
    requests: attempts.map((attempt) => ({ url: attempt.url, method: attempt.method, status: attempt.status, byteLength: attempt.byteLength, rawSha256: attempt.rawSha256, elapsedMs: attempt.elapsedMs, errorCode: attempt.errorCode })),
    ...extra,
  };
}

const PROVIDERS = Object.fromEntries(CAPABILITIES.providers.map((provider) => [provider.id, provider]));

/**
 * Files are written only beneath the run's working folder (`agentlas-structures/<ID>/`), never above it, never into the
 * home or filesystem root, never through a link. When the folder is not a project folder the result keeps every fact and
 * says why no file was written.
 */
function workingFolderGuard(cwd) {
  const resolved = path.resolve(cwd);
  const home = process.env.HOME || process.env.USERPROFILE || null;
  if (resolved === path.parse(resolved).root) return { ok: false, reason: "working-folder-is-filesystem-root" };
  if (home && path.resolve(home) === resolved) return { ok: false, reason: "working-folder-is-home" };
  if (resolved.startsWith(path.resolve(__dirname, "..") + path.sep) || resolved === path.resolve(__dirname, "..")) return { ok: false, reason: "working-folder-is-plugin-release" };
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory()) return { ok: false, reason: "working-folder-not-directory" };
  } catch { return { ok: false, reason: "working-folder-missing" }; }
  return { ok: true, root: resolved };
}

function writeFiles(cwd, folder, files) {
  const guard = workingFolderGuard(cwd);
  if (!guard.ok) return { written: [], skippedReason: guard.reason };
  const relativeDir = path.posix.join("agentlas-structures", folder);
  const absoluteDir = path.join(guard.root, ...relativeDir.split("/"));
  let cursor = guard.root;
  for (const part of relativeDir.split("/")) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { written: [], skippedReason: "output-folder-not-plain-directory" };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(cursor, { mode: 0o755 });
    }
  }
  const written = [];
  for (const file of files) {
    if (!/^[A-Za-z0-9._-]{1,120}$/u.test(file.name)) throw new StructuralBiologyError("output-file-name-invalid");
    const target = path.join(absoluteDir, file.name);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) return { written, skippedReason: "output-file-not-plain-file" };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = path.join(absoluteDir, `.${file.name}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    fs.writeFileSync(temporary, file.bytes, { mode: 0o644, flag: "wx" });
    fs.renameSync(temporary, target);
    written.push({ role: file.role, path: path.posix.join(relativeDir, file.name), absolutePath: target, mediaType: file.mediaType, byteLength: file.bytes.length, sha256: sha256(file.bytes) });
  }
  return { written, skippedReason: null };
}

function createStructuralBiologyClient(options = {}) {
  const http = options.http || createPoliteHttp({
    userAgent: USER_AGENT,
    hosts: Object.fromEntries(CAPABILITIES.providers.flatMap((provider) => provider.hosts.map((host) => [host, { minimumRequestIntervalMs: provider.guards.minimumRequestIntervalMs, timeoutMs: provider.guards.requestTimeoutMs }]))),
    requestTimeoutMs: GUARDS.requestTimeoutMs,
    maximumAttempts: GUARDS.maximumAttempts,
    retryableStatuses: GUARDS.retryableStatuses,
    maximumRetryAfterMs: GUARDS.maximumRetryAfterMs,
  });
  const cwd = () => options.cwd || process.cwd();
  const deadline = () => Date.now() + GUARDS.totalDeadlineMs;
  const structureCache = new Map();

  async function graphqlEntries(ids, deadlineAt) {
    const query = `{ entries(entry_ids: ${JSON.stringify(ids)}) { rcsb_id struct { title } exptl { method } rcsb_entry_info { resolution_combined nonpolymer_bound_components polymer_entity_count_protein deposited_atom_count } rcsb_accession_info { initial_release_date } polymer_entities { rcsb_polymer_entity { pdbx_description } rcsb_entity_source_organism { scientific_name } rcsb_polymer_entity_container_identifiers { auth_asym_ids reference_sequence_identifiers { database_name database_accession } } entity_poly { rcsb_mutation_count } } nonpolymer_entities { rcsb_nonpolymer_entity_container_identifiers { auth_asym_ids } nonpolymer_comp { chem_comp { id name formula formula_weight } rcsb_chem_comp_descriptor { SMILES InChIKey } } } } }`;
    const response = await http.postJson("https://data.rcsb.org/graphql", { query }, { maxBytes: PROVIDERS["rcsb-pdb"].guards.maxMetadataBytes, deadlineAt });
    if (!response.value || !response.value.data || !Array.isArray(response.value.data.entries)) throw new StructuralBiologyError("rcsb-graphql-response-invalid");
    return { entries: response.value.data.entries.filter(Boolean), attempts: response.attempts };
  }

  function entrySummary(entry, full) {
    const polymers = entry.polymer_entities || [];
    const ligands = (entry.nonpolymer_entities || []).map((item) => ({
      id: item.nonpolymer_comp?.chem_comp?.id ?? null,
      name: clip(item.nonpolymer_comp?.chem_comp?.name, 120),
      formula: item.nonpolymer_comp?.chem_comp?.formula ?? null,
      formulaWeight: round(item.nonpolymer_comp?.chem_comp?.formula_weight, 3),
      chains: item.rcsb_nonpolymer_entity_container_identifiers?.auth_asym_ids ?? [],
      smiles: full ? item.nonpolymer_comp?.rcsb_chem_comp_descriptor?.SMILES ?? null : undefined,
      inchiKey: full ? item.nonpolymer_comp?.rcsb_chem_comp_descriptor?.InChIKey ?? null : undefined,
      solventOrIon: SOLVENT_AND_IONS.has(item.nonpolymer_comp?.chem_comp?.id ?? ""),
    }));
    const uniprot = [...new Set(polymers.flatMap((polymer) => (polymer.rcsb_polymer_entity_container_identifiers?.reference_sequence_identifiers || [])
      .filter((ref) => ref.database_name === "UniProt").map((ref) => ref.database_accession)))];
    return {
      pdbId: entry.rcsb_id,
      title: clip(entry.struct?.title, full ? 400 : 160),
      method: (entry.exptl || []).map((item) => item.method).join(", ") || null,
      resolutionAngstrom: round(entry.rcsb_entry_info?.resolution_combined?.[0], 2),
      releaseDate: entry.rcsb_accession_info?.initial_release_date?.slice(0, 10) ?? null,
      organisms: [...new Set(polymers.flatMap((polymer) => (polymer.rcsb_entity_source_organism || []).map((item) => item.scientific_name)).filter(Boolean))],
      uniprotAccessions: uniprot,
      ligands: full ? ligands : ligands.filter((ligand) => !ligand.solventOrIon).map(({ id, name, chains }) => ({ id, name, chains })),
      ...(full ? {
        polymerEntities: polymers.map((polymer) => ({ description: clip(polymer.rcsb_polymer_entity?.pdbx_description, 160), chains: polymer.rcsb_polymer_entity_container_identifiers?.auth_asym_ids ?? [], mutationCount: polymer.entity_poly?.rcsb_mutation_count ?? null })),
        depositedAtomCount: entry.rcsb_entry_info?.deposited_atom_count ?? null,
      } : {}),
      entryUrl: `https://www.rcsb.org/structure/${entry.rcsb_id}`,
    };
  }

  async function searchProteinStructures(rawArgs) {
    const args = object(rawArgs, "search-arguments-invalid");
    only(args, ["query", "uniprot_accession", "ligand_id", "sequence", "experimental_only", "max_results", "offset", "view"], "search-arguments-invalid");
    const query = text(args.query, 300, "search-query-invalid", { optional: true });
    const uniprot = typeof args.uniprot_accession === "string" ? text(args.uniprot_accession.toUpperCase(), 10, "search-uniprot-invalid", { pattern: UNIPROT }) : text(args.uniprot_accession, 10, "search-uniprot-invalid", { optional: true });
    const ligand = text(args.ligand_id, 5, "search-ligand-id-invalid", { optional: true, pattern: COMP_ID });
    const sequence = text(args.sequence, 5000, "search-sequence-invalid", { optional: true, pattern: /^[ACDEFGHIKLMNPQRSTVWYXBZUO]{10,5000}$/iu });
    if (!query && !uniprot && !ligand && !sequence) throw new StructuralBiologyError("search-criterion-required", "Supply at least one of query, uniprot_accession, ligand_id or sequence.");
    const view = choice(args.view, ["summary", "full"], "summary", "search-view-invalid");
    const limit = Math.min(integer(args.max_results, 1, 25, view === "full" ? 25 : 8, "search-max-results-invalid"), view === "full" ? 25 : 10);
    const offset = integer(args.offset, 0, 10000, 0, "search-offset-invalid");
    const experimentalOnly = bool(args.experimental_only, true, "search-experimental-only-invalid");
    const nodes = [];
    if (query) nodes.push({ type: "terminal", service: "full_text", parameters: { value: query } });
    if (uniprot) nodes.push({ type: "terminal", service: "text", parameters: { attribute: "rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession", operator: "exact_match", value: uniprot.toUpperCase() } });
    if (ligand) nodes.push({ type: "terminal", service: "text", parameters: { attribute: "rcsb_nonpolymer_entity_container_identifiers.nonpolymer_comp_id", operator: "exact_match", value: ligand.toUpperCase() } });
    if (sequence) nodes.push({ type: "terminal", service: "sequence", parameters: { evalue_cutoff: 0.1, identity_cutoff: 0.9, sequence_type: "protein", value: sequence.toUpperCase() } });
    const body = {
      query: nodes.length === 1 ? nodes[0] : { type: "group", logical_operator: "and", nodes },
      return_type: "entry",
      request_options: { paginate: { start: offset, rows: limit }, results_content_type: experimentalOnly ? ["experimental"] : ["experimental", "computational"], sort: [{ sort_by: "score", direction: "desc" }] },
    };
    const deadlineAt = deadline();
    const search = await http.postJson("https://search.rcsb.org/rcsbsearch/v2/query", body, { maxBytes: PROVIDERS["rcsb-pdb"].guards.maxMetadataBytes, deadlineAt });
    const hits = search.value?.result_set || [];
    const total = search.value?.total_count ?? 0;
    const ids = hits.map((hit) => hit.identifier).filter((id) => PDB_ID.test(id));
    let entries = [];
    let attempts = [...search.attempts];
    if (ids.length) {
      const details = await graphqlEntries(ids, deadlineAt);
      attempts = attempts.concat(details.attempts);
      const byId = new Map(details.entries.map((entry) => [entry.rcsb_id, entry]));
      entries = ids.map((id, index) => (byId.get(id) ? { rank: offset + index + 1, score: round(hits[index].score, 3), ...entrySummary(byId.get(id), view === "full") } : { rank: offset + index + 1, pdbId: id, detailsUnavailable: true }));
    }
    return bounded({
      schema: "agentlas.structural-biology.structure-search/v1",
      view,
      criteria: { query, uniprotAccession: uniprot, ligandId: ligand?.toUpperCase() ?? null, sequenceLength: sequence ? sequence.length : null, experimentalOnly },
      totalCount: total,
      offset,
      returned: entries.length,
      nextOffset: offset + entries.length < total ? offset + entries.length : null,
      results: entries,
      provenance: receipt(PROVIDERS["rcsb-pdb"], attempts),
    }, view === "full" ? GUARDS.fullResultBytes : GUARDS.summaryResultBytes, ["results"]);
  }

  async function structureText(pdbId, format, deadlineAt) {
    const key = `${pdbId}:${format}`;
    if (structureCache.has(key)) return { ...structureCache.get(key), attempts: [], cached: true };
    const url = `https://files.rcsb.org/download/${pdbId}.${format === "pdb" ? "pdb" : "cif"}`;
    const response = await http.request({ url, accept: ["chemical/x-cif", "chemical/x-mmcif", "chemical/x-pdb", "text/plain", "application/octet-stream"], maxBytes: PROVIDERS["rcsb-pdb"].guards.maxStructureBytes, deadlineAt });
    const value = { url, bytes: response.bytes, sha256: response.sha256 };
    structureCache.set(key, value);
    if (structureCache.size > 4) structureCache.delete(structureCache.keys().next().value);
    return { ...value, attempts: response.attempts, cached: false };
  }

  function ligandInstances(atoms) {
    const instances = new Map();
    for (const atom of atoms) {
      if (atom.group !== "HETATM" || SOLVENT_AND_IONS.has(atom.compId) || atom.modelNum !== atoms[0].modelNum) continue;
      const key = `${atom.compId}|${atom.authAsymId}|${atom.authSeqId}|${atom.insertionCode}`;
      const instance = instances.get(key) || { compId: atom.compId, authAsymId: atom.authAsymId, labelAsymId: atom.labelAsymId, authSeqId: atom.authSeqId, insertionCode: atom.insertionCode, atomCount: 0 };
      instance.atomCount++;
      instances.set(key, instance);
    }
    return [...instances.values()];
  }

  /** Science's residue-interaction contract: unique residues in strict key order, the focus among them. */
  function residueInteraction(locators, focus) {
    const key = (value) => [value.modelNum, value.operatorName, value.labelAsymId, value.authAsymId, value.labelSeqId === null ? "~" : value.labelSeqId,
      value.authSeqId, value.insertionCode, value.compId].join("\u001f");
    const unique = new Map();
    for (const item of [focus, ...locators].filter(Boolean)) unique.set(key(item), item);
    const residues = [...unique.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, value]) => value);
    return { schema: "agentlas.science-residue-interaction/v1", granularity: "residue", residues, focus: focus || null };
  }

  function locator(atom) {
    return { modelNum: atom.modelNum, operatorName: "1_555", labelAsymId: atom.labelAsymId, authAsymId: atom.authAsymId, labelSeqId: atom.labelSeqId, authSeqId: atom.authSeqId, insertionCode: atom.insertionCode, compId: atom.compId };
  }

  function molstarView({ title, entryRef, format, contentSha256, representation, colorTheme, interaction, files, extraViewState = {} }) {
    return {
      schema: "agentlas.molstar-view/v1",
      contract: "agentlas.source-to-molstar",
      // Same artifact shape as Agentlas Science's agentlas.source-to-molstar (kind/rendererId/payload keys); the structure is
      // referenced by provider entry + exact content hash instead of a Science source version, which only Science can mint.
      artifact: {
        kind: "protein.structure",
        rendererId: "agentlas.molstar",
        title,
        payload: { structure: { sourceRef: entryRef, contentSha256, format }, representation, colorTheme },
      },
      scienceSourceQuery: entryRef.provider === "rcsb-pdb" ? { provider: "rcsb-pdb", entryId: entryRef.entryId } : null,
      interaction: interaction || null,
      viewState: { representation, colorTheme, ...extraViewState },
      files,
    };
  }

  async function fetchProteinStructure(rawArgs) {
    const args = object(rawArgs, "structure-arguments-invalid");
    only(args, ["pdb_id", "format", "save_files", "representation", "color_theme", "focus_ligand_id", "include_preview_image"], "structure-arguments-invalid");
    const pdbId = text(args.pdb_id, 4, "structure-pdb-id-invalid", { pattern: PDB_ID }).toUpperCase();
    const format = choice(args.format, ["mmcif", "pdb"], "mmcif", "structure-format-invalid");
    const save = bool(args.save_files, true, "structure-save-files-invalid");
    const representation = choice(args.representation, ["cartoon", "ball-and-stick", "surface"], "cartoon", "structure-representation-invalid");
    const colorTheme = choice(args.color_theme, ["chain-id", "element-symbol", "secondary-structure"], "chain-id", "structure-color-theme-invalid");
    const focusLigand = text(args.focus_ligand_id, 5, "structure-focus-ligand-invalid", { optional: true, pattern: COMP_ID });
    const withPreview = bool(args.include_preview_image, true, "structure-preview-invalid");
    const deadlineAt = deadline();
    const details = await graphqlEntries([pdbId], deadlineAt);
    if (!details.entries.length) throw new StructuralBiologyError("structure-not-found", `No RCSB entry ${pdbId}`);
    const summary = entrySummary(details.entries[0], true);
    const structure = await structureText(pdbId, format, deadlineAt);
    let attempts = details.attempts.concat(structure.attempts);
    let analysis = null;
    let interaction = null;
    let cifForAnalysis = format === "mmcif" ? structure : null;
    if (!cifForAnalysis && focusLigand) {
      cifForAnalysis = await structureText(pdbId, "mmcif", deadlineAt);
      attempts = attempts.concat(cifForAnalysis.attempts);
    }
    if (cifForAnalysis) {
      const atoms = atomSites(parseMmcif(cifForAnalysis.bytes.toString("utf8"), ["_atom_site"]));
      const firstModel = atoms.filter((atom) => atom.modelNum === atoms[0].modelNum);
      const chains = [...new Set(firstModel.filter((atom) => atom.group === "ATOM").map((atom) => atom.authAsymId))];
      const ligands = ligandInstances(atoms);
      analysis = { atomCount: firstModel.length, models: new Set(atoms.map((atom) => atom.modelNum)).size, proteinChains: chains, ligandInstances: ligands.slice(0, 20) };
      if (focusLigand) {
        const instance = ligands.find((item) => item.compId === focusLigand.toUpperCase());
        if (!instance) throw new StructuralBiologyError("structure-focus-ligand-absent", `${focusLigand} is not a ligand of ${pdbId}`, { ligands: ligands.map((item) => item.compId) });
        const focusAtom = firstModel.find((atom) => atom.compId === instance.compId && atom.authAsymId === instance.authAsymId && atom.authSeqId === instance.authSeqId);
        interaction = residueInteraction([], locator(focusAtom));
      }
    }
    const files = [];
    let preview = null;
    if (save) {
      const extension = format === "pdb" ? "pdb" : "cif";
      const outputs = [{ role: "structure", name: `${pdbId}.${extension}`, bytes: structure.bytes, mediaType: format === "pdb" ? "chemical/x-pdb" : "chemical/x-mmcif" }];
      if (withPreview) {
        const lower = pdbId.toLowerCase();
        try {
          const image = await http.request({ url: `https://cdn.rcsb.org/images/structures/${lower.slice(1, 3)}/${lower}/${lower}_assembly-1.jpeg`, accept: ["image/jpeg"], maxBytes: PROVIDERS["rcsb-pdb"].guards.maxImageBytes, deadlineAt });
          attempts = attempts.concat(image.attempts);
          outputs.push({ role: "preview-image", name: `${pdbId}_assembly-1.jpeg`, bytes: image.bytes, mediaType: "image/jpeg" });
          preview = { source: "RCSB PDB assembly image (rendered by RCSB with Mol*)", sha256: image.sha256 };
        } catch (error) {
          preview = { unavailable: error.code || "preview-image-failed" };
        }
      }
      const view = molstarView({ title: `${pdbId} — ${summary.title}`, entryRef: { provider: "rcsb-pdb", entryId: pdbId }, format, contentSha256: structure.sha256, representation, colorTheme, interaction, files: null });
      outputs.push({ role: "molstar-view", name: `${pdbId}.molstar.json`, bytes: Buffer.from(`${JSON.stringify({ ...view, files: { structure: `${pdbId}.${extension}` } }, null, 2)}\n`), mediaType: "application/json" });
      const written = writeFiles(cwd(), pdbId, outputs);
      files.push(...written.written);
      if (written.skippedReason) preview = { ...(preview || {}), fileWriteSkipped: written.skippedReason };
    }
    return {
      schema: "agentlas.structural-biology.structure/v1",
      entry: summary,
      structure: { format, url: structure.url, byteLength: structure.bytes.length, sha256: structure.sha256 },
      analysis,
      molstarView: molstarView({ title: `${pdbId} — ${summary.title}`, entryRef: { provider: "rcsb-pdb", entryId: pdbId }, format, contentSha256: structure.sha256, representation, colorTheme, interaction, files: files.map(({ role, path: relative, sha256: digest }) => ({ role, path: relative, sha256: digest })) }),
      files: files.map(({ absolutePath: _absolute, ...file }) => file),
      preview,
      provenance: receipt(PROVIDERS["rcsb-pdb"], attempts),
    };
  }

  async function fetchAlphafoldModel(rawArgs) {
    const args = object(rawArgs, "alphafold-arguments-invalid");
    only(args, ["uniprot_accession", "format", "save_files", "low_confidence_threshold"], "alphafold-arguments-invalid");
    const accession = text(typeof args.uniprot_accession === "string" ? args.uniprot_accession.toUpperCase() : args.uniprot_accession, 10, "alphafold-uniprot-invalid", { pattern: UNIPROT });
    const format = choice(args.format, ["mmcif", "pdb"], "mmcif", "alphafold-format-invalid");
    const save = bool(args.save_files, true, "alphafold-save-files-invalid");
    const threshold = number(args.low_confidence_threshold, 30, 90, 50, "alphafold-threshold-invalid");
    const deadlineAt = deadline();
    const api = await http.getJson(`https://alphafold.ebi.ac.uk/api/prediction/${accession}`, { maxBytes: PROVIDERS["alphafold-db"].guards.maxMetadataBytes, deadlineAt });
    const models = Array.isArray(api.value) ? api.value : [];
    if (!models.length) throw new StructuralBiologyError("alphafold-model-not-found", `No AlphaFold DB model for ${accession}`);
    const model = models.find((item) => item.uniprotAccession === accession) || models[0];
    const fileUrl = format === "pdb" ? model.pdbUrl : model.cifUrl;
    if (typeof fileUrl !== "string") throw new StructuralBiologyError("alphafold-file-url-missing");
    const file = await http.request({ url: fileUrl, accept: ["chemical/x-cif", "chemical/x-mmcif", "chemical/x-pdb", "text/plain", "application/octet-stream"], maxBytes: PROVIDERS["alphafold-db"].guards.maxStructureBytes, deadlineAt });
    let attempts = api.attempts.concat(file.attempts);
    let cifBytes = file.bytes;
    if (format === "pdb") {
      const cif = await http.request({ url: model.cifUrl, accept: ["chemical/x-cif", "chemical/x-mmcif", "text/plain", "application/octet-stream"], maxBytes: PROVIDERS["alphafold-db"].guards.maxStructureBytes, deadlineAt });
      attempts = attempts.concat(cif.attempts);
      cifBytes = cif.bytes;
    }
    const atoms = atomSites(parseMmcif(cifBytes.toString("utf8"), ["_atom_site"]));
    const residues = atoms.filter((atom) => atom.atom === "CA" && atom.group === "ATOM").map((atom) => ({ seq: atom.authSeqId, compId: atom.compId, plddt: atom.bFactor }));
    const scores = residues.map((residue) => residue.plddt).filter((value) => typeof value === "number");
    const segments = [];
    let open = null;
    for (const residue of residues) {
      if (residue.plddt !== null && residue.plddt < threshold) {
        if (open && residue.seq === open.end + 1) open.end = residue.seq;
        else { open = { start: residue.seq, end: residue.seq }; segments.push(open); }
      } else open = null;
    }
    const outputs = [];
    let written = { written: [], skippedReason: null };
    const label = model.entryId || model.modelEntityId || `AF-${accession}-F1`;
    const view = molstarView({ title: `AlphaFold ${label} (${model.uniprotDescription || accession})`, entryRef: { provider: "alphafold-db", entryId: label }, format, contentSha256: file.sha256, representation: "cartoon", colorTheme: "chain-id", interaction: null, files: null, extraViewState: { molstarColorTheme: "plddt-confidence" } });
    if (save) {
      const extension = format === "pdb" ? "pdb" : "cif";
      outputs.push({ role: "structure", name: `${label}.${extension}`, bytes: file.bytes, mediaType: format === "pdb" ? "chemical/x-pdb" : "chemical/x-mmcif" });
      outputs.push({ role: "molstar-view", name: `${label}.molstar.json`, bytes: Buffer.from(`${JSON.stringify({ ...view, files: { structure: `${label}.${extension}` } }, null, 2)}\n`), mediaType: "application/json" });
      written = writeFiles(cwd(), label, outputs);
    }
    return {
      schema: "agentlas.structural-biology.alphafold-model/v1",
      model: {
        entryId: label, uniprotAccession: model.uniprotAccession, description: model.uniprotDescription ?? null, gene: model.gene ?? null,
        organism: model.organismScientificName ?? null, sequenceLength: model.sequence ? model.sequence.length : residues.length,
        modelVersion: model.latestVersion ?? null, createdDate: model.modelCreatedDate?.slice(0, 10) ?? null, toolUsed: model.toolUsed ?? null,
      },
      confidence: {
        meanPlddt: round(scores.reduce((sum, value) => sum + value, 0) / (scores.length || 1), 1),
        providerGlobalPlddt: model.globalMetricValue ?? null,
        fractionVeryHigh: model.fractionPlddtVeryHigh ?? round(scores.filter((value) => value > 90).length / (scores.length || 1), 3),
        fractionConfident: model.fractionPlddtConfident ?? round(scores.filter((value) => value > 70 && value <= 90).length / (scores.length || 1), 3),
        fractionLow: model.fractionPlddtLow ?? round(scores.filter((value) => value > 50 && value <= 70).length / (scores.length || 1), 3),
        fractionVeryLow: model.fractionPlddtVeryLow ?? round(scores.filter((value) => value <= 50).length / (scores.length || 1), 3),
        lowConfidenceThreshold: threshold,
        lowConfidenceSegments: segments.slice(0, 20).map((segment) => ({ start: segment.start, end: segment.end, length: segment.end - segment.start + 1 })),
        interpretation: "pLDDT is the model's own per-residue confidence; it is not an experimental measurement.",
      },
      structure: { format, url: fileUrl, byteLength: file.bytes.length, sha256: file.sha256 },
      molstarView: { ...view, files: written.written.map(({ role, path: relative, sha256: digest }) => ({ role, path: relative, sha256: digest })) },
      files: written.written.map(({ absolutePath: _absolute, ...item }) => item),
      ...(written.skippedReason ? { fileWriteSkipped: written.skippedReason } : {}),
      provenance: receipt(PROVIDERS["alphafold-db"], attempts, { license: PROVIDERS["alphafold-db"].license }),
    };
  }

  async function describeBindingSite(rawArgs) {
    const args = object(rawArgs, "binding-site-arguments-invalid");
    only(args, ["pdb_id", "ligand_id", "chain_id", "radius_angstrom", "include_waters", "view"], "binding-site-arguments-invalid");
    const pdbId = text(args.pdb_id, 4, "binding-site-pdb-id-invalid", { pattern: PDB_ID }).toUpperCase();
    const ligandId = text(args.ligand_id, 5, "binding-site-ligand-id-invalid", { pattern: COMP_ID }).toUpperCase();
    const chainId = text(args.chain_id, 4, "binding-site-chain-invalid", { optional: true, pattern: /^[A-Za-z0-9]{1,4}$/u });
    const radius = number(args.radius_angstrom, 2, 8, 4.5, "binding-site-radius-invalid");
    const waters = bool(args.include_waters, false, "binding-site-waters-invalid");
    const view = choice(args.view, ["summary", "full"], "summary", "binding-site-view-invalid");
    const deadlineAt = deadline();
    const structure = await structureText(pdbId, "mmcif", deadlineAt);
    const parsed = parseMmcif(structure.bytes.toString("utf8"), ["_atom_site", "_struct_conn", "_chem_comp"]);
    const atoms = atomSites(parsed);
    const model = atoms[0].modelNum;
    const firstModel = atoms.filter((atom) => atom.modelNum === model && (atom.altId === "" || atom.altId === "A"));
    const instances = ligandInstances(firstModel).filter((item) => item.compId === ligandId && (!chainId || item.authAsymId === chainId));
    if (!instances.length) {
      const present = [...new Set(ligandInstances(firstModel).map((item) => item.compId))];
      throw new StructuralBiologyError("binding-site-ligand-absent", `${ligandId} is not a ligand of ${pdbId}${chainId ? ` chain ${chainId}` : ""}`, { ligandsInEntry: present });
    }
    const instance = instances[0];
    const ligandAtoms = firstModel.filter((atom) => atom.compId === instance.compId && atom.authAsymId === instance.authAsymId && atom.authSeqId === instance.authSeqId && atom.insertionCode === instance.insertionCode);
    const heavy = (atom) => atom.element !== "H" && atom.element !== "D";
    const residues = new Map();
    const covalentGeometry = [];
    for (const atom of firstModel) {
      if (ligandAtoms.includes(atom) || !heavy(atom)) continue;
      const water = atom.compId === "HOH" || atom.compId === "WAT" || atom.compId === "DOD";
      if (water && !waters) continue;
      let best = Infinity;
      let closest = null;
      for (const ligandAtom of ligandAtoms) {
        if (!heavy(ligandAtom)) continue;
        const distance = Math.hypot(atom.x - ligandAtom.x, atom.y - ligandAtom.y, atom.z - ligandAtom.z);
        if (distance < best) { best = distance; closest = ligandAtom; }
      }
      if (best > radius) continue;
      const key = `${atom.authAsymId}|${atom.authSeqId}|${atom.insertionCode}|${atom.compId}`;
      const row = residues.get(key) || { chain: atom.authAsymId, compId: atom.compId, authSeqId: atom.authSeqId, labelSeqId: atom.labelSeqId, insertionCode: atom.insertionCode, kind: atom.group === "ATOM" ? "polymer" : water ? "water" : "other-ligand", minDistance: Infinity, contacts: 0, closestPair: null, locator: locator(atom) };
      row.contacts++;
      if (best < row.minDistance) { row.minDistance = best; row.closestPair = { residueAtom: atom.atom, ligandAtom: closest.atom }; }
      residues.set(key, row);
      if (best < 2.2 && atom.group === "ATOM") covalentGeometry.push({ chain: atom.authAsymId, compId: atom.compId, authSeqId: atom.authSeqId, residueAtom: atom.atom, ligandAtom: closest.atom, distance: round(best, 2) });
    }
    const sorted = [...residues.values()].sort((left, right) => left.minDistance - right.minDistance);
    const declaredCovalent = structConnections(parsed).filter((connection) => connection.type === "covale").filter((connection) => [connection.partner1, connection.partner2]
      .some((partner) => partner.compId === instance.compId && partner.authAsymId === instance.authAsymId && partner.authSeqId === instance.authSeqId))
      .map((connection) => {
        const other = connection.partner1.compId === instance.compId && connection.partner1.authSeqId === instance.authSeqId ? connection.partner2 : connection.partner1;
        const mine = other === connection.partner2 ? connection.partner1 : connection.partner2;
        return { residue: `${other.compId} ${other.authSeqId} (chain ${other.authAsymId})`, residueAtom: other.atom, ligandAtom: mine.atom, distance: connection.distance, labelSeqId: other.labelSeqId };
      });
    const chemComp = categoryRows(parsed, "_chem_comp").find((row) => row.id === ligandId);
    const limit = view === "full" ? 200 : 25;
    const polymer = sorted.filter((row) => row.kind === "polymer");
    const ligandLocator = locator(ligandAtoms[0]);
    const interaction = residueInteraction(polymer.slice(0, view === "full" ? 511 : 39).map((row) => row.locator), ligandLocator);
    const result = {
      schema: "agentlas.structural-biology.binding-site/v1",
      view,
      pdbId,
      ligand: {
        id: ligandId, name: chemComp && !missing(chemComp.name) ? chemComp.name : null, formula: chemComp && !missing(chemComp.formula) ? chemComp.formula : null,
        chain: instance.authAsymId, authSeqId: instance.authSeqId, atomCount: ligandAtoms.length, heavyAtomCount: ligandAtoms.filter(heavy).length,
        instancesInEntry: instances.map((item) => `${item.compId} ${item.authSeqId} (chain ${item.authAsymId})`),
      },
      radiusAngstrom: radius,
      counts: { polymerResidues: polymer.length, otherLigands: sorted.filter((row) => row.kind === "other-ligand").length, waters: sorted.filter((row) => row.kind === "water").length },
      covalentBonds: { declaredInEntry: declaredCovalent, geometricUnder2_2A: covalentGeometry.slice(0, 10) },
      residues: sorted.slice(0, limit).map((row) => ({
        residue: `${row.compId} ${row.authSeqId}${row.insertionCode}`, chain: row.chain, kind: row.kind, minDistance: round(row.minDistance, 2), contacts: row.contacts,
        ...(view === "full" ? { closestPair: row.closestPair, labelSeqId: row.labelSeqId } : {}),
      })),
      residuesTruncated: sorted.length > limit,
      method: `Heavy-atom distances from deposited coordinates of model ${model} (altloc blank or A); residues with any heavy atom within ${radius} Å of any ligand heavy atom.`,
      structure: { url: structure.url, sha256: structure.sha256, byteLength: structure.bytes.length },
      molstarView: molstarView({ title: `${pdbId} ${ligandId} binding site`, entryRef: { provider: "rcsb-pdb", entryId: pdbId }, format: "mmcif", contentSha256: structure.sha256, representation: "cartoon", colorTheme: "element-symbol", interaction, files: null, extraViewState: { focusLigand: ligandLocator, radiusAngstrom: radius } }),
      provenance: receipt(PROVIDERS["rcsb-pdb"], structure.attempts, { structureCached: structure.cached }),
    };
    return bounded(result, view === "full" ? GUARDS.fullResultBytes : GUARDS.summaryResultBytes, ["residues"]);
  }

  const CHEMBL = "https://www.ebi.ac.uk/chembl/api/data";
  async function resolveMolecule(name, deadlineAt, attempts) {
    const encoded = encodeURIComponent(name);
    for (const query of [`molecule.json?pref_name__iexact=${encoded}&limit=5`, `molecule.json?molecule_synonyms__molecule_synonym__iexact=${encoded}&limit=5`]) {
      const response = await http.getJson(`${CHEMBL}/${query}&only=molecule_chembl_id,pref_name,max_phase`, { maxBytes: PROVIDERS.chembl.guards.maxMetadataBytes, deadlineAt });
      attempts.push(...response.attempts);
      const molecules = response.value?.molecules || [];
      if (molecules.length) return { chemblId: molecules[0].molecule_chembl_id, prefName: molecules[0].pref_name, resolvedBy: query.split("?")[1].split("=")[0], alternatives: molecules.slice(1).map((item) => item.molecule_chembl_id) };
    }
    const search = await http.getJson(`${CHEMBL}/molecule/search.json?q=${encoded}&limit=5&only=molecule_chembl_id,pref_name,max_phase`, { maxBytes: PROVIDERS.chembl.guards.maxMetadataBytes, deadlineAt });
    attempts.push(...search.attempts);
    const hits = search.value?.molecules || [];
    if (!hits.length) throw new StructuralBiologyError("chembl-molecule-not-found", `No ChEMBL molecule named ${name}`);
    return { chemblId: hits[0].molecule_chembl_id, prefName: hits[0].pref_name, resolvedBy: "search-top-hit", alternatives: hits.slice(1).map((item) => item.molecule_chembl_id) };
  }
  async function resolveTarget(queryText, deadlineAt, attempts) {
    const response = await http.getJson(`${CHEMBL}/target/search.json?q=${encodeURIComponent(queryText)}&limit=10&only=target_chembl_id,pref_name,organism,target_type`, { maxBytes: PROVIDERS.chembl.guards.maxMetadataBytes, deadlineAt });
    attempts.push(...response.attempts);
    const targets = response.value?.targets || [];
    const preferred = targets.find((item) => item.target_type === "SINGLE PROTEIN" && item.organism === "Homo sapiens") || targets[0];
    if (!preferred) throw new StructuralBiologyError("chembl-target-not-found", `No ChEMBL target for ${queryText}`);
    return { chemblId: preferred.target_chembl_id, prefName: preferred.pref_name, organism: preferred.organism, type: preferred.target_type, resolvedBy: "single-protein-human-first", alternatives: targets.filter((item) => item !== preferred).slice(0, 4).map((item) => ({ id: item.target_chembl_id, name: item.pref_name, type: item.target_type })) };
  }
  const NANOMOLAR = { nM: 1, uM: 1000, "µM": 1000, mM: 1e6, pM: 0.001 };

  async function fetchChemblActivities(rawArgs) {
    const args = object(rawArgs, "chembl-arguments-invalid");
    only(args, ["target_chembl_id", "target_query", "molecule_chembl_id", "molecule_name", "activity_types", "mutation", "max_results", "view"], "chembl-arguments-invalid");
    const targetId = text(typeof args.target_chembl_id === "string" ? args.target_chembl_id.toUpperCase() : args.target_chembl_id, 20, "chembl-target-id-invalid", { optional: true, pattern: CHEMBL_ID });
    const targetQuery = text(args.target_query, 120, "chembl-target-query-invalid", { optional: true });
    const moleculeId = text(typeof args.molecule_chembl_id === "string" ? args.molecule_chembl_id.toUpperCase() : args.molecule_chembl_id, 20, "chembl-molecule-id-invalid", { optional: true, pattern: CHEMBL_ID });
    const moleculeName = text(args.molecule_name, 120, "chembl-molecule-name-invalid", { optional: true });
    if (!targetId && !targetQuery && !moleculeId && !moleculeName) throw new StructuralBiologyError("chembl-criterion-required", "Supply a target or a molecule.");
    const types = args.activity_types === undefined ? ["IC50"] : args.activity_types;
    if (!Array.isArray(types) || !types.length || types.length > 6 || types.some((item) => !["IC50", "Ki", "Kd", "EC50", "GI50", "Inhibition"].includes(item))) throw new StructuralBiologyError("chembl-activity-types-invalid");
    const mutation = text(args.mutation, 20, "chembl-mutation-invalid", { optional: true, pattern: /^[A-Z][0-9]{1,5}[A-Z*]$/u });
    const view = choice(args.view, ["summary", "full"], "summary", "chembl-view-invalid");
    const maximum = Math.min(integer(args.max_results, 1, 500, view === "full" ? 200 : 100, "chembl-max-results-invalid"), view === "full" ? 500 : 200);
    const deadlineAt = deadline();
    const attempts = [];
    const molecule = moleculeId ? { chemblId: moleculeId, resolvedBy: "argument" } : moleculeName ? await resolveMolecule(moleculeName, deadlineAt, attempts) : null;
    const target = targetId ? { chemblId: targetId, resolvedBy: "argument" } : targetQuery ? await resolveTarget(targetQuery, deadlineAt, attempts) : null;
    const filters = [`standard_type__in=${types.join(",")}`, ...(molecule ? [`molecule_chembl_id=${molecule.chemblId}`] : []), ...(target ? [`target_chembl_id=${target.chemblId}`] : [])];
    const rows = [];
    let total = null;
    let offset = 0;
    while (rows.length < maximum) {
      const page = Math.min(100, maximum - rows.length);
      const response = await http.getJson(`${CHEMBL}/activity.json?${filters.join("&")}&limit=${page}&offset=${offset}`, { maxBytes: PROVIDERS.chembl.guards.maxMetadataBytes, deadlineAt });
      attempts.push(...response.attempts);
      total = response.value?.page_meta?.total_count ?? total;
      const activities = response.value?.activities || [];
      rows.push(...activities);
      offset += activities.length;
      if (!activities.length || !response.value?.page_meta?.next) break;
    }
    const normalized = rows.map((row) => {
      const factor = NANOMOLAR[row.standard_units];
      const value = row.standard_value === null || row.standard_value === undefined ? null : Number(row.standard_value);
      const descriptionMentions = mutation ? new RegExp(`\\b${mutation.replace("*", "\\*")}\\b`, "u").test(row.assay_description || "") : false;
      return {
        activityId: row.activity_id, molecule: row.molecule_chembl_id, moleculeName: row.molecule_pref_name, target: row.target_chembl_id, targetName: row.target_pref_name,
        type: row.standard_type, relation: row.standard_relation, value, units: row.standard_units,
        valueNm: factor && value !== null ? round(value * factor, 4) : null, pchembl: row.pchembl_value === null ? null : Number(row.pchembl_value),
        variant: row.assay_variant_mutation || null, mutationEvidence: mutation ? (row.assay_variant_mutation && row.assay_variant_mutation.split(",").includes(mutation) ? "variant-field" : descriptionMentions ? "assay-description" : null) : undefined,
        assay: row.assay_chembl_id, assayType: row.assay_type, assayDescription: clip(row.assay_description, view === "full" ? 300 : 110),
        document: row.document_chembl_id, year: row.document_year, dataValidity: row.data_validity_comment || null,
      };
    });
    const selected = mutation ? normalized.filter((row) => row.mutationEvidence) : normalized;
    const groups = new Map();
    for (const row of selected) {
      const key = `${row.molecule}|${row.type}`;
      const group = groups.get(key) || { molecule: row.molecule, moleculeName: row.moleculeName, type: row.type, n: 0, exact: [], pchembl: [] };
      group.n++;
      if (row.relation === "=" && row.valueNm !== null) group.exact.push(row.valueNm);
      if (row.pchembl !== null) group.pchembl.push(row.pchembl);
      groups.set(key, group);
    }
    const aggregates = [...groups.values()].map((group) => ({
      molecule: group.molecule, moleculeName: group.moleculeName, type: group.type, records: group.n, exactValueRecords: group.exact.length,
      medianNm: round(median(group.exact), 3), minNm: group.exact.length ? round(Math.min(...group.exact), 3) : null, maxNm: group.exact.length ? round(Math.max(...group.exact), 3) : null,
      medianPchembl: round(median(group.pchembl), 2),
    })).sort((left, right) => (right.medianPchembl ?? -1) - (left.medianPchembl ?? -1));
    const shown = [...selected].sort((left, right) => (right.pchembl ?? -1) - (left.pchembl ?? -1)).slice(0, view === "full" ? maximum : 15);
    return bounded({
      schema: "agentlas.structural-biology.chembl-activities/v1",
      view,
      molecule, target, activityTypes: types, mutation: mutation || null,
      totalMatchingInChembl: total, retrieved: rows.length, afterMutationFilter: selected.length,
      aggregates: aggregates.slice(0, view === "full" ? 100 : 20),
      rows: shown,
      rowsTruncated: selected.length > shown.length,
      notes: ["valueNm converts nM/µM/mM/pM only; other units stay null.", "Aggregates use exact (=) values; censored values (<, >) are counted in records only."],
      provenance: receipt(PROVIDERS.chembl, attempts),
    }, view === "full" ? GUARDS.fullResultBytes : GUARDS.summaryResultBytes, ["rows", "aggregates"]);
  }

  async function fetchClinicalTrials(rawArgs) {
    const args = object(rawArgs, "trials-arguments-invalid");
    only(args, ["intervention", "condition", "term", "phases", "statuses", "max_results", "page_token", "view"], "trials-arguments-invalid");
    const intervention = text(args.intervention, 200, "trials-intervention-invalid", { optional: true });
    const condition = text(args.condition, 200, "trials-condition-invalid", { optional: true });
    const term = text(args.term, 200, "trials-term-invalid", { optional: true });
    if (!intervention && !condition && !term) throw new StructuralBiologyError("trials-criterion-required", "Supply intervention, condition or term.");
    const phases = args.phases === undefined ? [] : args.phases;
    const PHASES = ["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4", "NA"];
    if (!Array.isArray(phases) || phases.length > 6 || phases.some((item) => !PHASES.includes(item))) throw new StructuralBiologyError("trials-phases-invalid");
    const statuses = args.statuses === undefined ? [] : args.statuses;
    const STATUSES = ["RECRUITING", "NOT_YET_RECRUITING", "ACTIVE_NOT_RECRUITING", "COMPLETED", "TERMINATED", "WITHDRAWN", "SUSPENDED", "ENROLLING_BY_INVITATION", "UNKNOWN"];
    if (!Array.isArray(statuses) || statuses.length > 9 || statuses.some((item) => !STATUSES.includes(item))) throw new StructuralBiologyError("trials-statuses-invalid");
    const view = choice(args.view, ["summary", "full"], "summary", "trials-view-invalid");
    const limit = Math.min(integer(args.max_results, 1, 100, 20, "trials-max-results-invalid"), view === "full" ? 100 : 50);
    const pageToken = text(args.page_token, 200, "trials-page-token-invalid", { optional: true, pattern: /^[A-Za-z0-9_-]{1,200}$/u });
    const params = new URLSearchParams({ format: "json", countTotal: "true", pageSize: String(limit) });
    if (intervention) params.set("query.intr", intervention);
    if (condition) params.set("query.cond", condition);
    if (term) params.set("query.term", term);
    if (statuses.length) params.set("filter.overallStatus", statuses.join(","));
    if (phases.length) params.set("filter.advanced", phases.map((phase) => `AREA[Phase]${phase}`).join(" OR "));
    if (pageToken) params.set("pageToken", pageToken);
    const deadlineAt = deadline();
    const response = await http.getJson(`https://clinicaltrials.gov/api/v2/studies?${params}`, { maxBytes: PROVIDERS["clinicaltrials-gov"].guards.maxMetadataBytes, deadlineAt });
    const studies = response.value?.studies || [];
    const trials = studies.map((study) => {
      const p = study.protocolSection || {};
      const row = {
        nctId: p.identificationModule?.nctId ?? null,
        title: clip(p.identificationModule?.briefTitle, view === "full" ? 300 : 140),
        acronym: p.identificationModule?.acronym ?? null,
        phases: p.designModule?.phases ?? [],
        status: p.statusModule?.overallStatus ?? null,
        enrollment: p.designModule?.enrollmentInfo?.count ?? null,
        enrollmentType: p.designModule?.enrollmentInfo?.type ?? null,
        startDate: p.statusModule?.startDateStruct?.date ?? null,
        primaryCompletionDate: p.statusModule?.primaryCompletionDateStruct?.date ?? null,
        sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name ?? null,
        conditions: (p.conditionsModule?.conditions || []).slice(0, view === "full" ? 10 : 3),
        interventions: (p.armsInterventionsModule?.interventions || []).map((item) => item.name).slice(0, view === "full" ? 12 : 4),
        hasResults: study.hasResults === true,
        url: p.identificationModule?.nctId ? `https://clinicaltrials.gov/study/${p.identificationModule.nctId}` : null,
      };
      if (view === "full") {
        row.briefSummary = clip(p.descriptionModule?.briefSummary, 600);
        row.primaryOutcomes = (p.outcomesModule?.primaryOutcomes || []).slice(0, 4).map((item) => ({ measure: clip(item.measure, 200), timeFrame: clip(item.timeFrame, 120) }));
        row.arms = (p.armsInterventionsModule?.armGroups || []).length;
        row.countries = [...new Set((p.contactsLocationsModule?.locations || []).map((item) => item.country).filter(Boolean))].length;
      }
      return row;
    });
    return bounded({
      schema: "agentlas.structural-biology.clinical-trials/v1",
      view,
      criteria: { intervention, condition, term, phases, statuses },
      totalCount: response.value?.totalCount ?? null,
      returned: trials.length,
      nextPageToken: response.value?.nextPageToken ?? null,
      trials,
      notes: ["Registry entries describe the protocol as registered; efficacy numbers such as ORR or PFS come from posted results or publications, not from this listing."],
      provenance: receipt(PROVIDERS["clinicaltrials-gov"], response.attempts),
    }, view === "full" ? GUARDS.fullResultBytes : GUARDS.summaryResultBytes, ["trials"]);
  }

  return { searchProteinStructures, fetchProteinStructure, fetchAlphafoldModel, describeBindingSite, fetchChemblActivities, fetchClinicalTrials };
}

module.exports = { PLUGIN_VERSION, USER_AGENT, createStructuralBiologyClient, StructuralBiologyError, PluginHttpError, workingFolderGuard };
