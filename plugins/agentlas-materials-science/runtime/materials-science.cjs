"use strict";

const { createHash } = require("node:crypto");

const OQMD_ENDPOINT = "https://oqmd.org/optimade/v1/structures";
const COD_SEARCH_ENDPOINT = "https://www.crystallography.net/cod/result";
const COD_CIF_ORIGIN = "https://www.crystallography.net";
const MAX_OPTIMADE_BYTES = 8 * 1024 * 1024;
const MAX_COD_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_CIF_BYTES = 4 * 1024 * 1024;
const MAX_OPTIMADE_RESULTS = 50;
const MAX_COD_MATCHES = 100;
const MAX_SITES = 1_000;
const MAX_CIF_SITES = 5_000;
const AVOGADRO_PER_MOL = 6.02214076e23;
const ELEMENTS = new Set((
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn " +
  "Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce " +
  "Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn " +
  "Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og"
).split(" "));

class MaterialsScienceError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "MaterialsScienceError";
    this.code = code;
    this.details = details;
  }
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MaterialsScienceError("materials-non-finite-number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MaterialsScienceError("materials-json-value-invalid");
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new MaterialsScienceError("materials-json-undefined");
    output[key] = canonicalValue(value[key]);
  }
  return output;
}

function stableStringify(value) { return JSON.stringify(canonicalValue(value)); }
function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8")).digest("hex");
}

function exactObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MaterialsScienceError(`${label}-invalid`);
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new MaterialsScienceError(`${label}-unknown-field`, `${label}: unknown field ${extras[0]}`);
  return value;
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new MaterialsScienceError(`${label}-invalid`);
  return value;
}

function finite(value, min, max, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new MaterialsScienceError(`${label}-invalid`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function text(value, min, max, label) {
  if (typeof value !== "string") throw new MaterialsScienceError(`${label}-invalid`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new MaterialsScienceError(`${label}-invalid`);
  }
  return normalized;
}

function optionalText(value, max, label) {
  if (value === null || value === undefined || value === "") return null;
  return text(String(value), 1, max, label);
}

function optionalFinite(value, min, max, label) {
  if (value === null || value === undefined || value === "" || value === "." || value === "?") return null;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/\(\d+\)$/, ""));
  return finite(numeric, min, max, label);
}

function elementSymbol(value, label) {
  const symbol = text(String(value), 1, 3, label);
  if (!ELEMENTS.has(symbol)) throw new MaterialsScienceError(`${label}-invalid`);
  return symbol;
}

function speciesChemicalSymbol(value, label) {
  if (value === "vacancy") return "vacancy";
  return elementSymbol(value, label);
}

function normalizeOqmdInput(input) {
  const value = exactObject(input, ["elements", "limit", "offset"], "optimade-search-input");
  if (!Array.isArray(value.elements) || value.elements.length < 1 || value.elements.length > 8) {
    throw new MaterialsScienceError("optimade-elements-invalid");
  }
  const elements = value.elements.map((entry, index) => elementSymbol(entry, `optimade-element-${index}`));
  if (new Set(elements).size !== elements.length) throw new MaterialsScienceError("optimade-elements-duplicate");
  return {
    elements: [...elements].sort(),
    limit: value.limit === undefined ? 20 : integer(value.limit, 1, MAX_OPTIMADE_RESULTS, "optimade-limit"),
    offset: value.offset === undefined ? 0 : integer(value.offset, 0, 10_000, "optimade-offset"),
  };
}

function buildOqmdUrl(input) {
  const normalized = normalizeOqmdInput(input);
  const params = new URLSearchParams();
  params.set("filter", `elements HAS ALL ${normalized.elements.map((symbol) => `"${symbol}"`).join(",")}`);
  params.set("page_limit", String(normalized.limit));
  params.set("page_offset", String(normalized.offset));
  params.set("sort", "id");
  params.set("response_fields", [
    "elements", "nelements", "chemical_formula_reduced", "chemical_formula_descriptive",
    "dimension_types", "nperiodic_dimensions", "lattice_vectors", "cartesian_site_positions",
    "species_at_sites", "species", "last_modified", "structure_features", "_oqmd_band_gap",
    "_oqmd_delta_e", "_oqmd_entry_id",
  ].join(","));
  return { input: normalized, url: `${OQMD_ENDPOINT}?${params.toString()}` };
}

function vector3(value, label, min = -1e7, max = 1e7) {
  if (!Array.isArray(value) || value.length !== 3) throw new MaterialsScienceError(`${label}-invalid`);
  return value.map((entry, index) => finite(entry, min, max, `${label}-${index}`));
}

function normalizeSpecies(value, index) {
  const item = exactObject(value, ["name", "chemical_symbols", "concentration", "mass", "original_name", "attached"], `optimade-species-${index}`);
  const name = text(item.name, 1, 120, `optimade-species-name-${index}`);
  if (!Array.isArray(item.chemical_symbols) || !Array.isArray(item.concentration) || item.chemical_symbols.length < 1 || item.chemical_symbols.length !== item.concentration.length) {
    throw new MaterialsScienceError("optimade-species-composition-invalid");
  }
  const chemicalSymbols = item.chemical_symbols.map((entry, symbolIndex) => speciesChemicalSymbol(entry, `optimade-species-symbol-${index}-${symbolIndex}`));
  const concentration = item.concentration.map((entry, concentrationIndex) => finite(entry, 0, 1, `optimade-species-concentration-${index}-${concentrationIndex}`));
  const sum = concentration.reduce((total, entry) => total + entry, 0);
  if (Math.abs(sum - 1) > 1e-5) throw new MaterialsScienceError("optimade-species-concentration-sum-invalid");
  return { name, chemicalSymbols, concentration };
}

function poscarForOrderedStructure(record) {
  const speciesByName = new Map(record.species.map((entry) => [entry.name, entry]));
  const sites = record.speciesAtSites.map((name, index) => {
    const definition = speciesByName.get(name);
    if (!definition || definition.chemicalSymbols.length !== 1 || !ELEMENTS.has(definition.chemicalSymbols[0]) || definition.concentration.length !== 1 || definition.concentration[0] !== 1) return null;
    return { symbol: definition.chemicalSymbols[0], position: record.cartesianSitePositions[index], index };
  });
  if (sites.some((entry) => entry === null)) return null;
  const symbols = [];
  for (const site of sites) if (!symbols.includes(site.symbol)) symbols.push(site.symbol);
  const grouped = symbols.flatMap((symbol) => sites.filter((site) => site.symbol === symbol));
  const lines = [
    `${record.formulaReduced ?? record.formulaDescriptive ?? record.id} | OQMD OPTIMADE ${record.id}`,
    "1.0",
    ...record.latticeVectors.map((row) => row.map((value) => String(value)).join(" ")),
    symbols.join(" "),
    symbols.map((symbol) => String(sites.filter((site) => site.symbol === symbol).length)).join(" "),
    "Cartesian",
    ...grouped.map((site) => site.position.map((value) => String(value)).join(" ")),
  ];
  return `${lines.join("\n")}\n`;
}

function normalizeOqmdOptimade(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.data)) {
    throw new MaterialsScienceError("optimade-response-invalid");
  }
  if (raw.data.length > MAX_OPTIMADE_RESULTS) throw new MaterialsScienceError("optimade-result-count-limit");
  const ids = new Set();
  const structures = raw.data.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.type !== "structures") {
      throw new MaterialsScienceError("optimade-structure-invalid", `structure ${index} is invalid`);
    }
    const id = typeof entry.id === "number" && Number.isSafeInteger(entry.id)
      ? String(entry.id) : text(entry.id, 1, 160, `optimade-id-${index}`);
    if (ids.has(id)) throw new MaterialsScienceError("optimade-id-duplicate");
    ids.add(id);
    const attributes = entry.attributes;
    if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) throw new MaterialsScienceError("optimade-attributes-invalid");
    if (!Array.isArray(attributes.elements) || attributes.elements.length < 1 || attributes.elements.length > 118) throw new MaterialsScienceError("optimade-elements-invalid");
    const elements = attributes.elements.map((symbol, elementIndex) => elementSymbol(symbol, `optimade-record-element-${index}-${elementIndex}`));
    if (new Set(elements).size !== elements.length) throw new MaterialsScienceError("optimade-record-elements-duplicate");
    const nelements = integer(attributes.nelements, 1, 118, `optimade-nelements-${index}`);
    if (nelements !== elements.length) throw new MaterialsScienceError("optimade-nelements-mismatch");
    if (!Array.isArray(attributes.lattice_vectors) || attributes.lattice_vectors.length !== 3) throw new MaterialsScienceError("optimade-lattice-invalid");
    const latticeVectors = attributes.lattice_vectors.map((row, rowIndex) => vector3(row, `optimade-lattice-${index}-${rowIndex}`));
    if (!Array.isArray(attributes.cartesian_site_positions) || attributes.cartesian_site_positions.length > MAX_SITES) throw new MaterialsScienceError("optimade-site-count-limit");
    const cartesianSitePositions = attributes.cartesian_site_positions.map((row, rowIndex) => vector3(row, `optimade-position-${index}-${rowIndex}`));
    if (!Array.isArray(attributes.species_at_sites) || attributes.species_at_sites.length !== cartesianSitePositions.length) throw new MaterialsScienceError("optimade-species-sites-mismatch");
    const speciesAtSites = attributes.species_at_sites.map((name, siteIndex) => text(name, 1, 120, `optimade-site-species-${index}-${siteIndex}`));
    if (!Array.isArray(attributes.species) || attributes.species.length < 1 || attributes.species.length > 1_000) throw new MaterialsScienceError("optimade-species-invalid");
    const species = attributes.species.map((definition, speciesIndex) => normalizeSpecies(definition, speciesIndex));
    const speciesNames = new Set(species.map((definition) => definition.name));
    if (speciesAtSites.some((name) => !speciesNames.has(name))) throw new MaterialsScienceError("optimade-site-species-undefined");
    if (!Array.isArray(attributes.dimension_types) || attributes.dimension_types.length !== 3) throw new MaterialsScienceError("optimade-dimension-types-invalid");
    const dimensionTypes = attributes.dimension_types.map((value, dimensionIndex) => integer(value, 0, 1, `optimade-dimension-${index}-${dimensionIndex}`));
    const nperiodicDimensions = integer(attributes.nperiodic_dimensions, 0, 3, `optimade-periodic-dimensions-${index}`);
    if (dimensionTypes.reduce((sum, value) => sum + value, 0) !== nperiodicDimensions) throw new MaterialsScienceError("optimade-periodicity-mismatch");
    const record = {
      id,
      elements,
      nelements,
      formulaReduced: optionalText(attributes.chemical_formula_reduced, 500, `optimade-formula-reduced-${index}`),
      formulaDescriptive: optionalText(attributes.chemical_formula_descriptive, 500, `optimade-formula-descriptive-${index}`),
      dimensionTypes,
      nperiodicDimensions,
      latticeVectors,
      cartesianSitePositions,
      speciesAtSites,
      species,
      structureFeatures: Array.isArray(attributes.structure_features)
        ? attributes.structure_features.map((feature, featureIndex) => text(feature, 1, 120, `optimade-feature-${index}-${featureIndex}`)) : [],
      lastModified: optionalText(attributes.last_modified, 100, `optimade-last-modified-${index}`),
      oqmdEntryId: attributes._oqmd_entry_id === null || attributes._oqmd_entry_id === undefined
        ? null : integer(Number(attributes._oqmd_entry_id), 0, Number.MAX_SAFE_INTEGER, `oqmd-entry-id-${index}`),
      bandGapEv: optionalFinite(attributes._oqmd_band_gap, -1e3, 1e3, `oqmd-band-gap-${index}`),
      formationEnergyEvPerAtom: optionalFinite(attributes._oqmd_delta_e, -1e6, 1e6, `oqmd-delta-e-${index}`),
    };
    const poscarText = poscarForOrderedStructure(record);
    return { ...record, poscarText, poscarSha256: poscarText === null ? null : sha256(poscarText) };
  });
  structures.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const warnings = [];
  if (structures.some((record) => record.poscarText === null)) warnings.push("POSCAR is omitted for disordered or partial-occupancy structures; normalized site coordinates remain available.");
  const normalized = {
    schema: "agentlas.materials.oqmd-optimade/v1",
    source: {
      provider: "Open Quantum Materials Database (OQMD)",
      canonicalUri: "optimade:https://oqmd.org/optimade/v1",
      license: "CC-BY-4.0",
    },
    structureCount: structures.length,
    structures,
    table: {
      schema: "agentlas.science-table/v1",
      columns: [
        { id: "id", label: "OQMD OPTIMADE ID", type: "string", unit: null },
        { id: "formula", label: "Formula", type: "string", unit: null },
        { id: "nelements", label: "Elements", type: "number", unit: null },
        { id: "nsites", label: "Sites", type: "number", unit: null },
        { id: "bandGapEv", label: "Band gap", type: "number", unit: "eV" },
        { id: "formationEnergyEvPerAtom", label: "Formation energy", type: "number", unit: "eV/atom" },
      ],
      rows: structures.map((record) => [record.id, record.formulaReduced ?? record.formulaDescriptive, record.nelements, record.cartesianSitePositions.length, record.bandGapEv, record.formationEnergyEvPerAtom]),
    },
    rendererCompatibility: {
      structure: { rendererIds: ["agentlas.3dmol"], formats: ["vasp-poscar"], hostRequired: true, bundledRenderer: false },
      table: { rendererIds: ["agentlas.vega"], formats: ["agentlas.science-table/v1"], hostRequired: true, bundledRenderer: false },
    },
    warnings,
  };
  return { ...normalized, normalizedSha256: sha256(stableStringify(normalized)) };
}

function normalizeCodSearchInput(input) {
  const value = exactObject(input, ["ids", "formula", "maxMatches"], "cod-search-input");
  const hasIds = value.ids !== undefined;
  const hasFormula = value.formula !== undefined;
  if (hasIds === hasFormula) throw new MaterialsScienceError("cod-search-selector-invalid", "provide exactly one of ids or formula");
  let ids = null;
  let formula = null;
  if (hasIds) {
    if (!Array.isArray(value.ids) || value.ids.length < 1 || value.ids.length > 20) throw new MaterialsScienceError("cod-ids-invalid");
    ids = value.ids.map((entry, index) => {
      const id = text(String(entry), 7, 7, `cod-id-${index}`);
      if (!/^\d{7}$/.test(id)) throw new MaterialsScienceError(`cod-id-${index}-invalid`);
      return id;
    });
    if (new Set(ids).size !== ids.length) throw new MaterialsScienceError("cod-ids-duplicate");
    ids.sort();
  } else {
    formula = text(value.formula, 1, 160, "cod-formula");
    const tokens = formula.split(/\s+/);
    if (tokens.length < 1 || tokens.length > 8 || tokens.some((token) => !/^[A-Z][a-z]?(?:\d+(?:\.\d+)?)?$/.test(token))) {
      throw new MaterialsScienceError("cod-formula-invalid", "COD formula must use 1-8 space-separated Hill-style element tokens");
    }
    for (const token of tokens) elementSymbol(token.match(/^[A-Z][a-z]?/)[0], "cod-formula-element");
    formula = tokens.join(" ");
  }
  return { ids, formula, maxMatches: value.maxMatches === undefined ? 50 : integer(value.maxMatches, 1, MAX_COD_MATCHES, "cod-max-matches") };
}

function buildCodSearchUrl(input, format) {
  if (format !== "count" && format !== "json") throw new MaterialsScienceError("cod-format-invalid");
  const normalized = normalizeCodSearchInput(input);
  const params = new URLSearchParams();
  params.set("format", format);
  if (normalized.ids) params.set("id", normalized.ids.join(","));
  else params.set("formula", normalized.formula);
  return { input: normalized, url: `${COD_SEARCH_ENDPOINT}?${params.toString()}` };
}

function normalizeCodRows(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_COD_MATCHES) throw new MaterialsScienceError("cod-search-response-invalid");
  const ids = new Set();
  const records = raw.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new MaterialsScienceError("cod-search-row-invalid");
    const id = text(String(row.file ?? ""), 7, 7, `cod-result-id-${index}`);
    if (!/^\d{7}$/.test(id) || ids.has(id)) throw new MaterialsScienceError("cod-result-id-invalid");
    ids.add(id);
    return {
      id,
      formula: optionalText(row.formula, 500, `cod-formula-${index}`),
      calculatedFormula: optionalText(row.calcformula, 500, `cod-calculated-formula-${index}`),
      cellFormula: optionalText(row.cellformula, 500, `cod-cell-formula-${index}`),
      commonName: optionalText(row.commonname, 500, `cod-common-name-${index}`),
      chemicalName: optionalText(row.chemname, 1_000, `cod-chemical-name-${index}`),
      mineralName: optionalText(row.mineral, 500, `cod-mineral-${index}`),
      cell: {
        aAngstrom: optionalFinite(row.a, 0, 1e6, `cod-a-${index}`),
        bAngstrom: optionalFinite(row.b, 0, 1e6, `cod-b-${index}`),
        cAngstrom: optionalFinite(row.c, 0, 1e6, `cod-c-${index}`),
        alphaDegree: optionalFinite(row.alpha, 0, 180, `cod-alpha-${index}`),
        betaDegree: optionalFinite(row.beta, 0, 180, `cod-beta-${index}`),
        gammaDegree: optionalFinite(row.gamma, 0, 180, `cod-gamma-${index}`),
        volumeAngstrom3: optionalFinite(row.vol, 0, 1e18, `cod-volume-${index}`),
        z: optionalFinite(row.Z, 0, 1e9, `cod-z-${index}`),
      },
      spaceGroup: optionalText(row.sg, 500, `cod-space-group-${index}`),
      spaceGroupHall: optionalText(row.sgHall, 500, `cod-space-group-hall-${index}`),
      spaceGroupNumber: row.sgNumber === null || row.sgNumber === undefined || row.sgNumber === "" ? null : integer(Number(row.sgNumber), 1, 230, `cod-space-group-number-${index}`),
      title: optionalText(row.title, 4_000, `cod-title-${index}`),
      authors: optionalText(row.authors, 4_000, `cod-authors-${index}`),
      journal: optionalText(row.journal, 1_000, `cod-journal-${index}`),
      year: row.year === null || row.year === undefined || row.year === "" ? null : integer(Number(row.year), 1500, 2500, `cod-year-${index}`),
      doi: optionalText(row.doi, 500, `cod-doi-${index}`),
      status: optionalText(row.status, 200, `cod-status-${index}`),
      flags: optionalText(row.flags, 500, `cod-flags-${index}`),
      duplicateOf: optionalText(row.duplicateof, 500, `cod-duplicate-${index}`),
      optimal: optionalText(row.optimal, 200, `cod-optimal-${index}`),
      revision: row.svnrevision === null || row.svnrevision === undefined || row.svnrevision === "" ? null : integer(Number(row.svnrevision), 0, Number.MAX_SAFE_INTEGER, `cod-revision-${index}`),
      cifUrl: `${COD_CIF_ORIGIN}/cod/${id}.cif`,
    };
  });
  records.sort((a, b) => a.id.localeCompare(b.id));
  const normalized = {
    schema: "agentlas.materials.cod-search/v1",
    source: { provider: "Crystallography Open Database (COD)", canonicalUri: "cod:search", license: "CC0-1.0" },
    recordCount: records.length,
    records,
    table: {
      schema: "agentlas.science-table/v1",
      columns: [
        { id: "id", label: "COD ID", type: "string", unit: null },
        { id: "formula", label: "Formula", type: "string", unit: null },
        { id: "volume", label: "Cell volume", type: "number", unit: "angstrom^3" },
        { id: "spaceGroup", label: "Space group", type: "string", unit: null },
        { id: "year", label: "Year", type: "number", unit: null },
      ],
      rows: records.map((record) => [record.id, record.formula, record.cell.volumeAngstrom3, record.spaceGroup, record.year]),
    },
    rendererCompatibility: {
      table: { rendererIds: ["agentlas.vega"], formats: ["agentlas.science-table/v1"], hostRequired: true, bundledRenderer: false },
    },
  };
  return { ...normalized, normalizedSha256: sha256(stableStringify(normalized)) };
}

function tokenizeCif(cifText) {
  const tokens = [];
  const lines = cifText.replace(/\r\n?/g, "\n").split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line.startsWith(";")) {
      const block = [];
      lineIndex += 1;
      while (lineIndex < lines.length && !lines[lineIndex].startsWith(";")) {
        block.push(lines[lineIndex]);
        lineIndex += 1;
      }
      if (lineIndex >= lines.length) throw new MaterialsScienceError("cif-multiline-unclosed");
      tokens.push({ value: block.join("\n"), quoted: true });
      continue;
    }
    let index = 0;
    while (index < line.length) {
      while (index < line.length && /\s/.test(line[index])) index += 1;
      if (index >= line.length || line[index] === "#") break;
      if (line[index] === "'" || line[index] === '"') {
        const quote = line[index];
        index += 1;
        let value = "";
        while (index < line.length && line[index] !== quote) { value += line[index]; index += 1; }
        if (index >= line.length) throw new MaterialsScienceError("cif-quote-unclosed");
        index += 1;
        tokens.push({ value, quoted: true });
      } else {
        const start = index;
        while (index < line.length && !/\s/.test(line[index]) && line[index] !== "#") index += 1;
        tokens.push({ value: line.slice(start, index), quoted: false });
        if (line[index] === "#") break;
      }
    }
  }
  return tokens;
}

function isControlToken(token) {
  if (!token || token.quoted) return false;
  const lower = token.value.toLowerCase();
  return lower === "loop_" || lower === "stop_" || lower === "global_" || lower.startsWith("data_") || lower.startsWith("save_") || lower.startsWith("_");
}

function parseCif(cifText) {
  if (typeof cifText !== "string" || cifText.length < 1 || Buffer.byteLength(cifText, "utf8") > MAX_CIF_BYTES || cifText.includes("\u0000")) {
    throw new MaterialsScienceError("cif-text-invalid");
  }
  const tokens = tokenizeCif(cifText);
  const scalars = new Map();
  const loops = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const lower = token.value.toLowerCase();
    if (!token.quoted && lower === "loop_") {
      index += 1;
      const tags = [];
      while (index < tokens.length && !tokens[index].quoted && tokens[index].value.startsWith("_")) {
        tags.push(tokens[index].value.toLowerCase());
        index += 1;
      }
      if (!tags.length) throw new MaterialsScienceError("cif-loop-tags-missing");
      const values = [];
      while (index < tokens.length && !isControlToken(tokens[index])) { values.push(tokens[index].value); index += 1; }
      if (values.length % tags.length !== 0) throw new MaterialsScienceError("cif-loop-row-width-invalid");
      const rows = [];
      for (let valueIndex = 0; valueIndex < values.length; valueIndex += tags.length) {
        const row = {};
        tags.forEach((tag, tagIndex) => { row[tag] = values[valueIndex + tagIndex]; });
        rows.push(row);
      }
      loops.push({ tags, rows });
      continue;
    }
    if (!token.quoted && lower.startsWith("_")) {
      if (!tokens[index + 1] || isControlToken(tokens[index + 1])) throw new MaterialsScienceError("cif-scalar-value-missing");
      scalars.set(lower, tokens[index + 1].value);
      index += 2;
      continue;
    }
    index += 1;
  }
  return { scalars, loops };
}

function cifNumber(value, min, max, label) { return optionalFinite(value, min, max, label); }
function cifScalar(scalars, ...tags) {
  for (const tag of tags) if (scalars.has(tag)) return scalars.get(tag);
  return null;
}

function deriveCifElement(typeSymbol, label, rowIndex) {
  if (typeSymbol && typeSymbol !== "." && typeSymbol !== "?") {
    const match = String(typeSymbol).match(/[A-Z][a-z]?/);
    if (match && ELEMENTS.has(match[0])) return match[0];
  }
  const match = String(label ?? "").match(/[A-Z][a-z]?/);
  if (match && ELEMENTS.has(match[0])) return match[0];
  throw new MaterialsScienceError("cif-atom-element-invalid", `cannot derive atom element at row ${rowIndex}`);
}

function normalizeCodCif(cifText, codId, revision = null) {
  const id = text(String(codId), 7, 7, "cod-cif-id");
  if (!/^\d{7}$/.test(id)) throw new MaterialsScienceError("cod-cif-id-invalid");
  const parsed = parseCif(cifText);
  const atomLoop = parsed.loops.find((loop) => ["_atom_site_fract_x", "_atom_site_fract_y", "_atom_site_fract_z"].every((tag) => loop.tags.includes(tag)));
  const atomSites = atomLoop ? atomLoop.rows.map((row, rowIndex) => {
    const label = optionalText(row._atom_site_label, 160, `cif-atom-label-${rowIndex}`);
    const x = cifNumber(row._atom_site_fract_x, -10, 10, `cif-fract-x-${rowIndex}`);
    const y = cifNumber(row._atom_site_fract_y, -10, 10, `cif-fract-y-${rowIndex}`);
    const z = cifNumber(row._atom_site_fract_z, -10, 10, `cif-fract-z-${rowIndex}`);
    if (x === null || y === null || z === null) return null;
    return {
      label,
      element: deriveCifElement(row._atom_site_type_symbol, label, rowIndex),
      fractionalPosition: [x, y, z],
      occupancy: cifNumber(row._atom_site_occupancy, 0, 1.1, `cif-occupancy-${rowIndex}`) ?? 1,
    };
  }).filter(Boolean) : [];
  if (atomSites.length > MAX_CIF_SITES) throw new MaterialsScienceError("cif-atom-site-count-limit");
  const scalarId = cifScalar(parsed.scalars, "_cod_database_code");
  if (scalarId && scalarId !== "." && scalarId !== "?" && String(scalarId) !== id) throw new MaterialsScienceError("cif-cod-id-mismatch");
  const formula = optionalText(cifScalar(parsed.scalars, "_chemical_formula_sum"), 500, "cif-formula");
  const normalized = {
    schema: "agentlas.materials.cod-crystal/v1",
    source: { provider: "Crystallography Open Database (COD)", codId: id, revision, license: "CC0-1.0" },
    codId: id,
    revision,
    formula,
    formulaUnitsZ: cifNumber(cifScalar(parsed.scalars, "_cell_formula_units_z"), 0, 1e9, "cif-formula-units-z"),
    formulaWeightGramsPerMol: cifNumber(cifScalar(parsed.scalars, "_chemical_formula_weight"), 0, 1e9, "cif-formula-weight"),
    declaredDensityGramsPerCm3: cifNumber(cifScalar(parsed.scalars, "_exptl_crystal_density_diffrn"), 0, 1e6, "cif-declared-density"),
    spaceGroup: optionalText(cifScalar(parsed.scalars, "_space_group_name_h-m_alt", "_symmetry_space_group_name_h-m"), 500, "cif-space-group"),
    cell: {
      aAngstrom: cifNumber(cifScalar(parsed.scalars, "_cell_length_a"), 0, 1e6, "cif-cell-a"),
      bAngstrom: cifNumber(cifScalar(parsed.scalars, "_cell_length_b"), 0, 1e6, "cif-cell-b"),
      cAngstrom: cifNumber(cifScalar(parsed.scalars, "_cell_length_c"), 0, 1e6, "cif-cell-c"),
      alphaDegree: cifNumber(cifScalar(parsed.scalars, "_cell_angle_alpha"), 0, 180, "cif-cell-alpha"),
      betaDegree: cifNumber(cifScalar(parsed.scalars, "_cell_angle_beta"), 0, 180, "cif-cell-beta"),
      gammaDegree: cifNumber(cifScalar(parsed.scalars, "_cell_angle_gamma"), 0, 180, "cif-cell-gamma"),
      volumeAngstrom3: cifNumber(cifScalar(parsed.scalars, "_cell_volume"), 0, 1e18, "cif-cell-volume"),
    },
    atomSiteCount: atomSites.length,
    atomSites,
    cifText,
    rawCifSha256: sha256(Buffer.from(cifText, "utf8")),
    rendererCompatibility: {
      primaryMimeType: "chemical/x-cif",
      rendererIds: ["agentlas.3dmol"],
      formats: ["cif"],
      hostRequired: true,
      bundledRenderer: false,
    },
    warnings: ["Atom sites are the deposited asymmetric-unit rows; this adapter does not expand crystallographic symmetry."],
  };
  const hashable = { ...normalized };
  delete hashable.cifText;
  return { ...normalized, normalizedSha256: sha256(stableStringify(hashable)) };
}

function determinant3(matrix) {
  return matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
    - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
    + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
}

function triclinicCellVolume(cell) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) throw new MaterialsScienceError("materials-lattice-cell-invalid");
  const a = finite(cell.aAngstrom, Number.MIN_VALUE, 1e6, "materials-lattice-a");
  const b = finite(cell.bAngstrom, Number.MIN_VALUE, 1e6, "materials-lattice-b");
  const c = finite(cell.cAngstrom, Number.MIN_VALUE, 1e6, "materials-lattice-c");
  const alpha = finite(cell.alphaDegree, Number.MIN_VALUE, 180 - Number.EPSILON, "materials-lattice-alpha") * Math.PI / 180;
  const beta = finite(cell.betaDegree, Number.MIN_VALUE, 180 - Number.EPSILON, "materials-lattice-beta") * Math.PI / 180;
  const gamma = finite(cell.gammaDegree, Number.MIN_VALUE, 180 - Number.EPSILON, "materials-lattice-gamma") * Math.PI / 180;
  const cosAlpha = Math.cos(alpha);
  const cosBeta = Math.cos(beta);
  const cosGamma = Math.cos(gamma);
  const radicand = 1 + 2 * cosAlpha * cosBeta * cosGamma - cosAlpha ** 2 - cosBeta ** 2 - cosGamma ** 2;
  if (!(radicand > 0) || !Number.isFinite(radicand)) throw new MaterialsScienceError("materials-lattice-geometry-invalid");
  const volume = a * b * c * Math.sqrt(radicand);
  if (!(volume > 0) || !Number.isFinite(volume)) throw new MaterialsScienceError("materials-lattice-volume-invalid");
  return volume;
}

function verifiedCodCrystal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== "agentlas.materials.cod-crystal/v1") throw new MaterialsScienceError("materials-lattice-cif-invalid");
  exactObject(value, ["schema", "source", "codId", "revision", "formula", "formulaUnitsZ", "formulaWeightGramsPerMol", "declaredDensityGramsPerCm3", "spaceGroup", "cell", "atomSiteCount", "atomSites", "cifText", "rawCifSha256", "rendererCompatibility", "warnings", "normalizedSha256", "provenance"], "materials-lattice-cif");
  if (typeof value.cifText !== "string" || sha256(Buffer.from(value.cifText, "utf8")) !== value.rawCifSha256) throw new MaterialsScienceError("materials-lattice-cif-raw-hash-mismatch");
  const core = {
    schema: value.schema,
    source: value.source,
    codId: value.codId,
    revision: value.revision,
    formula: value.formula,
    formulaUnitsZ: value.formulaUnitsZ,
    formulaWeightGramsPerMol: value.formulaWeightGramsPerMol,
    declaredDensityGramsPerCm3: value.declaredDensityGramsPerCm3,
    spaceGroup: value.spaceGroup,
    cell: value.cell,
    atomSiteCount: value.atomSiteCount,
    atomSites: value.atomSites,
    rawCifSha256: value.rawCifSha256,
    rendererCompatibility: value.rendererCompatibility,
    warnings: value.warnings,
  };
  if (!/^[a-f0-9]{64}$/.test(String(value.normalizedSha256 ?? "")) || sha256(stableStringify(core)) !== value.normalizedSha256) throw new MaterialsScienceError("materials-lattice-normalized-hash-mismatch");
  return core;
}

function verifiedOptimadeDataset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== "agentlas.materials.oqmd-optimade/v1") throw new MaterialsScienceError("materials-lattice-optimade-invalid");
  exactObject(value, ["schema", "source", "structureCount", "structures", "table", "rendererCompatibility", "warnings", "normalizedSha256", "query", "provenance"], "materials-lattice-optimade");
  const core = {
    schema: value.schema,
    source: value.source,
    structureCount: value.structureCount,
    structures: value.structures,
    table: value.table,
    rendererCompatibility: value.rendererCompatibility,
    warnings: value.warnings,
  };
  if (!/^[a-f0-9]{64}$/.test(String(value.normalizedSha256 ?? "")) || sha256(stableStringify(core)) !== value.normalizedSha256) throw new MaterialsScienceError("materials-lattice-normalized-hash-mismatch");
  return core;
}

function analyzeLatticeMetrics(input) {
  const value = exactObject(input, ["sourceKind", "normalized", "structureId", "declaredVolumeToleranceRelative"], "materials-lattice-input");
  const sourceKind = text(value.sourceKind, 1, 40, "materials-lattice-source-kind");
  if (sourceKind !== "cod-cif" && sourceKind !== "optimade") throw new MaterialsScienceError("materials-lattice-source-kind-invalid");
  const tolerance = value.declaredVolumeToleranceRelative === undefined ? 0.005 : finite(value.declaredVolumeToleranceRelative, 0, 0.1, "materials-lattice-volume-tolerance");
  let sourceLineage;
  let structure;
  let volumeAngstrom3;
  let declaredVolumeAngstrom3 = null;
  let formula = null;
  let formulaUnitsZ = null;
  let formulaWeightGramsPerMol = null;
  let declaredDensityGramsPerCm3 = null;
  let volumeMethod;
  if (sourceKind === "cod-cif") {
    if (value.structureId !== undefined) throw new MaterialsScienceError("materials-lattice-structure-id-not-allowed");
    structure = verifiedCodCrystal(value.normalized);
    volumeAngstrom3 = triclinicCellVolume(structure.cell);
    declaredVolumeAngstrom3 = structure.cell.volumeAngstrom3;
    formula = structure.formula;
    formulaUnitsZ = structure.formulaUnitsZ;
    formulaWeightGramsPerMol = structure.formulaWeightGramsPerMol;
    declaredDensityGramsPerCm3 = structure.declaredDensityGramsPerCm3;
    volumeMethod = "triclinic-cell-parameters";
    sourceLineage = { normalizedSha256: value.normalized.normalizedSha256, rawCifSha256: structure.rawCifSha256, codId: structure.codId, revision: structure.revision };
  } else {
    const dataset = verifiedOptimadeDataset(value.normalized);
    const structureId = text(value.structureId, 1, 160, "materials-lattice-structure-id");
    const matches = dataset.structures.filter((entry) => entry.id === structureId);
    if (matches.length !== 1) throw new MaterialsScienceError("materials-lattice-structure-not-found");
    structure = matches[0];
    if (structure.nperiodicDimensions !== 3 || structure.dimensionTypes.some((entry) => entry !== 1)) throw new MaterialsScienceError("materials-lattice-three-dimensional-required");
    const determinant = determinant3(structure.latticeVectors);
    volumeAngstrom3 = Math.abs(determinant);
    if (!(volumeAngstrom3 > 0) || !Number.isFinite(volumeAngstrom3)) throw new MaterialsScienceError("materials-lattice-volume-invalid");
    formula = structure.formulaReduced ?? structure.formulaDescriptive;
    volumeMethod = "absolute-lattice-determinant";
    sourceLineage = { normalizedSha256: value.normalized.normalizedSha256, structureId };
  }
  let volumeValidation;
  if (declaredVolumeAngstrom3 === null) {
    volumeValidation = { status: "not-declared", declaredVolumeAngstrom3: null, absoluteDifferenceAngstrom3: null, relativeDifference: null, toleranceRelative: tolerance };
  } else {
    const absoluteDifferenceAngstrom3 = Math.abs(volumeAngstrom3 - declaredVolumeAngstrom3);
    const relativeDifference = absoluteDifferenceAngstrom3 / declaredVolumeAngstrom3;
    if (relativeDifference > tolerance) throw new MaterialsScienceError("materials-lattice-declared-volume-mismatch", "Computed cell volume exceeds the declared-volume tolerance.", { computedVolumeAngstrom3: volumeAngstrom3, declaredVolumeAngstrom3, relativeDifference, toleranceRelative: tolerance });
    volumeValidation = { status: "within-tolerance", declaredVolumeAngstrom3, absoluteDifferenceAngstrom3, relativeDifference, toleranceRelative: tolerance };
  }
  const missingDensityInputs = [];
  if (formula === null) missingDensityInputs.push("explicit-composition");
  if (formulaUnitsZ === null) missingDensityInputs.push("formula-units-Z");
  if (formulaWeightGramsPerMol === null) missingDensityInputs.push("formula-weight-g-per-mol");
  let density;
  if (missingDensityInputs.length) {
    density = { status: "not-computed", gramsPerCm3: null, formula, formulaUnitsZ, formulaWeightGramsPerMol, declaredDensityGramsPerCm3, missingInputs: missingDensityInputs, method: null };
  } else {
    if (!(formulaUnitsZ > 0) || !(formulaWeightGramsPerMol > 0)) throw new MaterialsScienceError("materials-lattice-density-input-invalid");
    const gramsPerCm3 = formulaUnitsZ * formulaWeightGramsPerMol / (AVOGADRO_PER_MOL * volumeAngstrom3 * 1e-24);
    if (!(gramsPerCm3 > 0) || !Number.isFinite(gramsPerCm3)) throw new MaterialsScienceError("materials-lattice-density-invalid");
    density = { status: "computed", gramsPerCm3, formula, formulaUnitsZ, formulaWeightGramsPerMol, declaredDensityGramsPerCm3, missingInputs: [], method: "Z-times-explicit-formula-weight-over-Avogadro-and-cell-volume" };
  }
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `Validated lattice metrics: ${sourceKind === "cod-cif" ? structure.codId : structure.id}`,
    columns: [
      { id: "metric", label: "Metric", type: "string", unit: null },
      { id: "value", label: "Value", type: "number", unit: null },
      { id: "unit", label: "Unit", type: "string", unit: null },
      { id: "method", label: "Method/status", type: "string", unit: null },
    ],
    rows: [
      ["cell_volume", volumeAngstrom3, "angstrom^3", volumeMethod],
      ["density", density.gramsPerCm3, "g/cm^3", density.status],
    ],
  };
  const normalized = {
    schema: "agentlas.materials.lattice-metrics/v1",
    sourceKind,
    sourceLineage,
    volume: { angstrom3: volumeAngstrom3, method: volumeMethod, validation: volumeValidation },
    density,
    publicationTable,
    constants: { avogadroPerMol: AVOGADRO_PER_MOL, angstromCubedToCmCubed: 1e-24 },
    warnings: density.status === "computed" ? [] : ["Density was not computed because every required explicit field (composition, Z, and formula weight) was not present; no chemical mass or Z was inferred."],
  };
  return { ...normalized, analysisSha256: sha256(stableStringify(normalized)) };
}

function createRateGate({ minIntervalMs, clockMs, sleep }) {
  let tail = Promise.resolve();
  let lastStartedAt = -Infinity;
  return async (operation) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, lastStartedAt + minIntervalMs - clockMs());
      if (waitMs > 0) await sleep(waitMs);
      lastStartedAt = clockMs();
      return await operation();
    } finally { release(); }
  };
}

async function readBoundedResponse(response, maxBytes, label) {
  if (!response || typeof response.arrayBuffer !== "function") throw new MaterialsScienceError(`${label}-response-invalid`);
  const status = Number(response.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) throw new MaterialsScienceError(`${label}-http-error`, `${label} returned HTTP ${status}`, { status });
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new MaterialsScienceError(`${label}-response-too-large`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new MaterialsScienceError(`${label}-response-too-large`);
  return bytes;
}

async function fetchBytes(fetchImpl, url, { timeoutMs, maxBytes, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: label === "cod-cif" ? "chemical/x-cif,text/plain;q=0.9,*/*;q=0.1" : "application/json,text/plain;q=0.5" }, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new MaterialsScienceError(`${label}-timeout`);
    throw new MaterialsScienceError(`${label}-network-error`, error?.message ?? `${label} network error`);
  } finally { clearTimeout(timer); }
  return readBoundedResponse(response, maxBytes, label);
}

function decodeJson(bytes, label) {
  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new MaterialsScienceError(`${label}-utf8-invalid`); }
  try { return JSON.parse(decoded); } catch { throw new MaterialsScienceError(`${label}-json-invalid`); }
}

function receipt({ provider, url, request, bytes, retrievedAt, license, docsUrl }) {
  return {
    schema: "agentlas.provenance-receipt/v1",
    provider,
    request: { method: "GET", url, descriptorSha256: sha256(stableStringify(request)) },
    response: { rawSha256: sha256(bytes), byteLength: bytes.length },
    retrievedAt,
    license,
    docsUrl,
  };
}

function createMaterialsScienceClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new MaterialsScienceError("materials-fetch-unavailable");
  const clockMs = options.clockMs ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const optimadeGate = createRateGate({ minIntervalMs: 1_000, clockMs, sleep });
  const codGate = createRateGate({ minIntervalMs: 1_000, clockMs, sleep });

  async function searchOqmdOptimadeStructures(input) {
    const built = buildOqmdUrl(input);
    return optimadeGate(async () => {
      const bytes = await fetchBytes(fetchImpl, built.url, { timeoutMs: 30_000, maxBytes: MAX_OPTIMADE_BYTES, label: "optimade" });
      const normalized = normalizeOqmdOptimade(decodeJson(bytes, "optimade"));
      return {
        ...normalized,
        query: built.input,
        provenance: receipt({ provider: "OQMD OPTIMADE", url: built.url, request: built.input, bytes, retrievedAt: new Date(clockMs()).toISOString(), license: "CC-BY-4.0", docsUrl: "https://www.oqmd.org/optimade/" }),
      };
    });
  }

  async function searchCodCrystals(input) {
    const countBuilt = buildCodSearchUrl(input, "count");
    return codGate(async () => {
      const countBytes = await fetchBytes(fetchImpl, countBuilt.url, { timeoutMs: 20_000, maxBytes: 128, label: "cod-count" });
      let countText;
      try { countText = new TextDecoder("utf-8", { fatal: true }).decode(countBytes).trim(); } catch { throw new MaterialsScienceError("cod-count-utf8-invalid"); }
      if (!/^\d+$/.test(countText)) throw new MaterialsScienceError("cod-count-invalid");
      const matchCount = integer(Number(countText), 0, Number.MAX_SAFE_INTEGER, "cod-count");
      const countReceipt = receipt({ provider: "COD", url: countBuilt.url, request: { ...countBuilt.input, phase: "count" }, bytes: countBytes, retrievedAt: new Date(clockMs()).toISOString(), license: "CC0-1.0", docsUrl: "https://wiki.crystallography.net/RESTful_API/" });
      if (matchCount > countBuilt.input.maxMatches) {
        return {
          schema: "agentlas.materials.cod-search-bounded/v1",
          status: "too-broad",
          query: countBuilt.input,
          matchCount,
          maxMatches: countBuilt.input.maxMatches,
          records: [],
          provenance: { count: countReceipt, results: null },
          warning: "COD does not document a result-limit parameter; JSON retrieval was not attempted because the count exceeded maxMatches.",
        };
      }
      const resultBuilt = buildCodSearchUrl(input, "json");
      const resultBytes = await fetchBytes(fetchImpl, resultBuilt.url, { timeoutMs: 20_000, maxBytes: MAX_COD_SEARCH_BYTES, label: "cod-search" });
      const normalized = normalizeCodRows(decodeJson(resultBytes, "cod-search"));
      if (normalized.recordCount !== matchCount) throw new MaterialsScienceError("cod-count-result-mismatch", "COD count and JSON result lengths differ", { matchCount, recordCount: normalized.recordCount });
      return {
        ...normalized,
        status: "complete",
        query: countBuilt.input,
        matchCount,
        provenance: {
          count: countReceipt,
          results: receipt({ provider: "COD", url: resultBuilt.url, request: { ...resultBuilt.input, phase: "results" }, bytes: resultBytes, retrievedAt: new Date(clockMs()).toISOString(), license: "CC0-1.0", docsUrl: "https://wiki.crystallography.net/RESTful_API/" }),
        },
      };
    });
  }

  async function fetchCodCif(input) {
    const value = exactObject(input, ["codId", "revision"], "cod-cif-input");
    const codId = text(String(value.codId), 7, 7, "cod-cif-id");
    if (!/^\d{7}$/.test(codId)) throw new MaterialsScienceError("cod-cif-id-invalid");
    const revision = value.revision === undefined ? null : integer(value.revision, 0, Number.MAX_SAFE_INTEGER, "cod-cif-revision");
    const suffix = revision === null ? "" : `@${revision}`;
    const url = `${COD_CIF_ORIGIN}/cod/${codId}.cif${suffix}`;
    return codGate(async () => {
      const bytes = await fetchBytes(fetchImpl, url, { timeoutMs: 20_000, maxBytes: MAX_CIF_BYTES, label: "cod-cif" });
      let cifText;
      try { cifText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new MaterialsScienceError("cod-cif-utf8-invalid"); }
      const normalized = normalizeCodCif(cifText, codId, revision);
      if (normalized.rawCifSha256 !== sha256(bytes)) throw new MaterialsScienceError("cod-cif-byte-hash-mismatch");
      return {
        ...normalized,
        provenance: receipt({ provider: "COD", url, request: { codId, revision }, bytes, retrievedAt: new Date(clockMs()).toISOString(), license: "CC0-1.0", docsUrl: "https://wiki.crystallography.net/RESTful_API/" }),
      };
    });
  }

  return { searchOqmdOptimadeStructures, searchCodCrystals, fetchCodCif };
}

module.exports = {
  MaterialsScienceError,
  buildOqmdUrl,
  normalizeOqmdOptimade,
  buildCodSearchUrl,
  normalizeCodRows,
  parseCif,
  normalizeCodCif,
  analyzeLatticeMetrics,
  createMaterialsScienceClient,
  sha256,
  stableStringify,
  constants: { OQMD_ENDPOINT, COD_SEARCH_ENDPOINT, COD_CIF_ORIGIN, MAX_OPTIMADE_RESULTS, MAX_COD_MATCHES, MAX_SITES, MAX_CIF_SITES, AVOGADRO_PER_MOL },
};
