"use strict";

const crypto = require("node:crypto");

const PLUGIN_VERSION = "0.2.0";
const ENSEMBL_ORIGIN = "https://rest.ensembl.org";
const ENSEMBL_FTP_ORIGIN = "https://ftp.ensembl.org";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}

function text(value, maximum, pattern, code) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || !pattern.test(value)) throw new Error(code);
  return value.trim();
}

function nullableText(value, maximum) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function finite(value, minimum, maximum, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}

function buildReferenceAssemblyManifestRequest(input) {
  const value = object(input, "reference-assembly-manifest-request-invalid");
  if (Object.keys(value).some((key) => key !== "species")) throw new Error("reference-assembly-manifest-request-unknown-field");
  if (!Array.isArray(value.species) || value.species.length < 2 || value.species.length > 8) throw new Error("reference-assembly-manifest-species-invalid");
  const species = value.species.map((item) => text(item, 80, /^[a-z][a-z0-9_]+$/u, "reference-assembly-manifest-species-invalid"));
  if (new Set(species).size !== species.length) throw new Error("reference-assembly-manifest-species-duplicate");
  species.sort();
  const releaseUrl = new URL("/info/data", ENSEMBL_ORIGIN);
  releaseUrl.searchParams.set("content-type", "application/json");
  const requests = species.map((speciesName) => {
    const genomeUrl = new URL(`/info/genomes/${encodeURIComponent(speciesName)}`, ENSEMBL_ORIGIN);
    genomeUrl.searchParams.set("content-type", "application/json");
    const assemblyUrl = new URL(`/info/assembly/${encodeURIComponent(speciesName)}`, ENSEMBL_ORIGIN);
    assemblyUrl.searchParams.set("content-type", "application/json");
    const fastaBase = `/pub/current_fasta/${encodeURIComponent(speciesName)}/dna/`;
    return {
      species: speciesName,
      genomeUrl: genomeUrl.toString(),
      assemblyUrl: assemblyUrl.toString(),
      readmeUrl: new URL(`${fastaBase}README`, ENSEMBL_FTP_ORIGIN).toString(),
      checksumsUrl: new URL(`${fastaBase}CHECKSUMS`, ENSEMBL_FTP_ORIGIN).toString(),
      fastaBaseUrl: new URL(fastaBase, ENSEMBL_FTP_ORIGIN).toString(),
    };
  });
  return { input: { species }, releaseUrl: releaseUrl.toString(), requests };
}

function readmeAssemblyAccession(readmeText) {
  if (typeof readmeText !== "string" || readmeText.length < 1 || readmeText.length > 1024 * 1024) throw new Error("reference-assembly-manifest-readme-invalid");
  const matches = [...readmeText.matchAll(/(?:assembly accession|assembly id)\s*[:=]?\s*(GC[AF]_\d+\.\d+)/giu)].map((match) => match[1]);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) throw new Error("reference-assembly-manifest-readme-accession-invalid");
  return unique[0];
}

function selectToplevelFasta(checksumsText) {
  if (typeof checksumsText !== "string" || checksumsText.length < 1 || checksumsText.length > 2 * 1024 * 1024) throw new Error("reference-assembly-manifest-checksums-invalid");
  const entries = checksumsText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) throw new Error("reference-assembly-manifest-checksums-invalid");
    const providerChecksum = match[1];
    const blockCount = Number(match[2]);
    const filename = match[3];
    if (!Number.isSafeInteger(blockCount) || blockCount < 1 || blockCount > 100_000_000 || !/^[A-Za-z0-9_.-]+$/u.test(filename)) throw new Error("reference-assembly-manifest-checksums-invalid");
    return { providerChecksum, blockCount, filename };
  });
  const matches = entries.filter((entry) => /\.dna\.toplevel\.fa\.gz$/u.test(entry.filename));
  if (matches.length !== 1) throw new Error("reference-assembly-manifest-toplevel-fasta-invalid");
  return matches[0];
}

function normalizeReferenceAssemblyManifest(input) {
  const value = object(input, "reference-assembly-manifest-normalize-input-invalid");
  if (Object.keys(value).some((key) => !["request", "releaseResponse", "speciesResponses", "title"].includes(key))) throw new Error("reference-assembly-manifest-normalize-input-unknown-field");
  const built = buildReferenceAssemblyManifestRequest(value.request);
  const title = text(value.title, 240, /^[^\u0000-\u001f\u007f]+$/u, "reference-assembly-manifest-title-invalid");
  const releaseResponse = object(value.releaseResponse, "reference-assembly-manifest-release-invalid");
  if (!Array.isArray(releaseResponse.releases) || releaseResponse.releases.length < 1 || releaseResponse.releases.length > 8) throw new Error("reference-assembly-manifest-release-invalid");
  const releases = [...new Set(releaseResponse.releases.map((release) => integer(release, 1, 10000, "reference-assembly-manifest-release-invalid")))].sort((a, b) => b - a);
  if (!Array.isArray(value.speciesResponses) || value.speciesResponses.length !== built.input.species.length) throw new Error("reference-assembly-manifest-responses-invalid");
  const bySpecies = new Map(value.speciesResponses.map((raw) => {
    const response = object(raw, "reference-assembly-manifest-response-invalid");
    if (Object.keys(response).some((key) => !["species", "genomeResponse", "assemblyResponse", "readmeText", "checksumsText"].includes(key))) throw new Error("reference-assembly-manifest-response-unknown-field");
    const speciesName = text(response.species, 80, /^[a-z][a-z0-9_]+$/u, "reference-assembly-manifest-species-invalid");
    if (built.input.species.includes(speciesName) === false) throw new Error("reference-assembly-manifest-response-species-invalid");
    return [speciesName, response];
  }));
  if (bySpecies.size !== built.input.species.length) throw new Error("reference-assembly-manifest-response-duplicate");
  const assemblies = built.input.species.map((speciesName) => {
    const response = bySpecies.get(speciesName);
    if (!response) throw new Error("reference-assembly-manifest-response-missing");
    const genome = object(response.genomeResponse, "reference-assembly-manifest-genome-invalid");
    const assembly = object(response.assemblyResponse, "reference-assembly-manifest-assembly-invalid");
    const scientificName = text(genome.scientific_name, 240, /^[^\u0000-\u001f\u007f]+$/u, "reference-assembly-manifest-scientific-name-invalid");
    const assemblyName = text(genome.assembly_name, 160, /^[A-Za-z0-9_.-]+$/u, "reference-assembly-manifest-assembly-name-invalid");
    const assemblyAccession = text(genome.assembly_accession, 32, /^GC[AF]_\d+\.\d+$/u, "reference-assembly-manifest-accession-invalid");
    const taxonomyId = integer(genome.taxonomy_id, 1, 2_147_483_647, "reference-assembly-manifest-taxonomy-invalid");
    const baseCount = integer(genome.base_count, 1, 100_000_000_000, "reference-assembly-manifest-base-count-invalid");
    const genomeRecordDataReleaseId = integer(genome.data_release_id, 1, 10000, "reference-assembly-manifest-data-release-invalid");
    if (assembly.assembly_name !== assemblyName || assembly.assembly_accession !== assemblyAccession) throw new Error("reference-assembly-manifest-assembly-mismatch");
    const readmeAccession = readmeAssemblyAccession(response.readmeText);
    if (readmeAccession !== assemblyAccession) throw new Error("reference-assembly-manifest-readme-accession-mismatch");
    const fasta = selectToplevelFasta(response.checksumsText);
    const topLevelRegions = Array.isArray(assembly.top_level_region) ? assembly.top_level_region : (() => { throw new Error("reference-assembly-manifest-regions-invalid"); })();
    if (topLevelRegions.length < 1 || topLevelRegions.length > 100_000) throw new Error("reference-assembly-manifest-regions-invalid");
    let topLevelBases = 0;
    const coordinateSystemCounts = {};
    for (const rawRegion of topLevelRegions) {
      const region = object(rawRegion, "reference-assembly-manifest-region-invalid");
      topLevelBases += integer(region.length, 1, 10_000_000_000, "reference-assembly-manifest-region-length-invalid");
      const coordinateSystem = text(region.coord_system, 40, /^[A-Za-z0-9_.-]+$/u, "reference-assembly-manifest-coordinate-system-invalid");
      coordinateSystemCounts[coordinateSystem] = (coordinateSystemCounts[coordinateSystem] ?? 0) + 1;
    }
    const request = built.requests.find((item) => item.species === speciesName);
    if (!request) throw new Error("reference-assembly-manifest-request-missing");
    return {
      species: speciesName, scientificName, displayName: nullableText(genome.display_name, 240), taxonomyId,
      assemblyName, assemblyAccession, ensemblRelease: releases[0], genomeRecordDataReleaseId, assemblyLevel: nullableText(genome.assembly_level, 80),
      baseCount, topLevelRegionCount: topLevelRegions.length, topLevelBases, coordinateSystemCounts,
      fasta: { filename: fasta.filename, url: new URL(fasta.filename, request.fastaBaseUrl).toString(), providerChecksum: fasta.providerChecksum, providerChecksumAlgorithm: "BSD-sum", blockCount: fasta.blockCount, contentDownloaded: false, contentCryptographicallyVerified: false },
      receipts: { genomeUrl: request.genomeUrl, assemblyUrl: request.assemblyUrl, readmeUrl: request.readmeUrl, checksumsUrl: request.checksumsUrl, readmeAssemblyAccession: readmeAccession },
    };
  });
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title,
    columns: [
      { id: "species", label: "Extant species", type: "string", unit: null },
      { id: "taxonomyId", label: "NCBI taxonomy ID", type: "integer", unit: null },
      { id: "assembly", label: "Assembly", type: "string", unit: null },
      { id: "accession", label: "Assembly accession", type: "string", unit: null },
      { id: "release", label: "Ensembl release", type: "integer", unit: null },
      { id: "bases", label: "Assembly bases", type: "integer", unit: "bp" },
      { id: "regions", label: "Top-level regions", type: "integer", unit: "count" },
      { id: "asset", label: "Pinned toplevel FASTA asset", type: "string", unit: null },
      { id: "providerChecksum", label: "Provider checksum (BSD sum)", type: "string", unit: null },
    ],
    rows: assemblies.map((item) => [item.scientificName, item.taxonomyId, item.assemblyName, item.assemblyAccession, item.ensemblRelease, item.baseCount, item.topLevelRegionCount, item.fasta.filename, item.fasta.providerChecksum]),
    notes: [
      "Assembly identity is cross-checked across Ensembl genome metadata, assembly metadata, and the provider README.",
      "The listed FASTA checksum is the provider CHECKSUMS BSD sum, not SHA-256.",
      "FASTA contents were not downloaded or cryptographically verified by this operation.",
      "These are extant reference assemblies; no extinct-species genome, sequence, chromosome, phenotype, embryo, or hatching claim is emitted.",
    ],
  };
  const core = {
    schema: "agentlas.extant-reference-assembly-manifest/v1", provider: "ensembl", providerRelease: releases,
    request: built.input, title, assemblies, publicationTable,
    evidenceBoundary: {
      observed: ["exact-provider-response-bytes", "assembly-identity-cross-check", "provider-fasta-asset-locator", "provider-bsd-checksum"],
      notObserved: ["fasta-content", "annotation-content", "busco-quality", "chromosome-homology", "ancestral-sequence"],
      prohibitedInference: ["extinct-species-dna", "extinct-species-genome", "chromosome-reconstruction", "phenotype", "embryo-viability", "hatching"],
    },
    warnings: ["Provider CHECKSUMS values are BSD sums and must not be represented as cryptographic content digests.", "Download and independently hash sequence assets before any base-level analysis."],
  };
  return { ...core, deterministicHash: sha256(stableStringify(core)) };
}

function buildGeneTreeRequest(input) {
  const value = object(input, "comparative-genomics-request-invalid");
  const allowed = ["species", "geneId", "pruneTaxon", "sequenceType"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("comparative-genomics-request-unknown-field");
  const species = text(value.species, 80, /^[a-z][a-z0-9_]+$/u, "comparative-genomics-species-invalid");
  const geneId = text(value.geneId, 80, /^[A-Za-z0-9_.-]+$/u, "comparative-genomics-gene-id-invalid");
  const pruneTaxon = integer(value.pruneTaxon, 1, 2_147_483_647, "comparative-genomics-prune-taxon-invalid");
  const sequenceType = value.sequenceType === "cdna" ? "cdna" : value.sequenceType === "protein" ? "protein" : (() => { throw new Error("comparative-genomics-sequence-type-invalid"); })();
  const releaseUrl = new URL("/info/data", ENSEMBL_ORIGIN);
  releaseUrl.searchParams.set("content-type", "application/json");
  const treeUrl = new URL(`/genetree/member/id/${encodeURIComponent(species)}/${encodeURIComponent(geneId)}`, ENSEMBL_ORIGIN);
  treeUrl.search = `?aligned=1;sequence=${sequenceType};prune_taxon=${pruneTaxon};content-type=application/json`;
  return { input: { species, geneId, pruneTaxon, sequenceType }, releaseUrl: releaseUrl.toString(), treeUrl: treeUrl.toString() };
}

function accession(value) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  return nullableText(record?.accession, 160);
}

function normalizeGeneTree(input) {
  const value = object(input, "comparative-genomics-normalize-input-invalid");
  if (Object.keys(value).some((key) => !["request", "releaseResponse", "treeResponse", "title"].includes(key))) throw new Error("comparative-genomics-normalize-input-unknown-field");
  const request = buildGeneTreeRequest(value.request).input;
  const title = text(value.title, 240, /^[^\u0000-\u001f\u007f]+$/u, "comparative-genomics-title-invalid");
  const releaseResponse = object(value.releaseResponse, "comparative-genomics-release-response-invalid");
  if (!Array.isArray(releaseResponse.releases) || releaseResponse.releases.length < 1 || releaseResponse.releases.length > 8) throw new Error("comparative-genomics-release-response-invalid");
  const releases = [...new Set(releaseResponse.releases.map((release) => integer(release, 1, 10000, "comparative-genomics-release-response-invalid")))].sort((a, b) => b - a);
  const response = object(value.treeResponse, "comparative-genomics-tree-response-invalid");
  if (response.rooted !== 1 || response.type !== "gene tree") throw new Error("comparative-genomics-tree-unrooted-or-invalid");
  const geneTreeId = text(response.id, 160, /^[A-Za-z0-9_.-]+$/u, "comparative-genomics-tree-id-invalid");
  const root = object(response.tree, "comparative-genomics-tree-response-invalid");
  const nodes = [];
  const leaves = [];
  let alignmentLength = null;
  let totalSequenceCharacters = 0;

  function visit(rawNode, parentId, depth) {
    if (depth > 256 || nodes.length >= 2500) throw new Error("comparative-genomics-tree-too-large");
    const node = object(rawNode, "comparative-genomics-node-invalid");
    const nodeId = `node-${String(nodes.length + 1).padStart(5, "0")}`;
    const taxonomy = node.taxonomy && typeof node.taxonomy === "object" && !Array.isArray(node.taxonomy) ? node.taxonomy : {};
    const taxonomyId = Number.isSafeInteger(taxonomy.id) && taxonomy.id > 0 ? taxonomy.id : null;
    const scientificName = nullableText(taxonomy.scientific_name, 240);
    const commonName = nullableText(taxonomy.common_name, 240);
    const event = node.events && typeof node.events === "object" && !Array.isArray(node.events) ? nullableText(node.events.type, 80) : null;
    const branchLength = node.branch_length === undefined ? null : finite(node.branch_length, 0, 1_000_000, "comparative-genomics-branch-length-invalid");
    const confidence = node.confidence && typeof node.confidence === "object" && !Array.isArray(node.confidence) ? node.confidence : {};
    const bootstrap = confidence.bootstrap === undefined ? null : finite(confidence.bootstrap, 0, 100, "comparative-genomics-bootstrap-invalid");
    const duplicationConfidence = confidence.duplication_confidence_score === undefined ? null : finite(confidence.duplication_confidence_score, 0, 1, "comparative-genomics-duplication-confidence-invalid");
    const geneId = accession(node.id);
    const sequence = node.sequence && typeof node.sequence === "object" && !Array.isArray(node.sequence) ? node.sequence : null;
    const proteinIds = Array.isArray(sequence?.id) ? sequence.id.map(accession).filter(Boolean) : [];
    const alignedSequence = nullableText(sequence?.mol_seq?.seq, 200_000);
    if (alignedSequence !== null && !/^[A-Za-z*?\-.]+$/u.test(alignedSequence)) throw new Error("comparative-genomics-aligned-sequence-invalid");
    if (alignedSequence !== null) {
      totalSequenceCharacters += alignedSequence.length;
      if (totalSequenceCharacters > 8 * 1024 * 1024) throw new Error("comparative-genomics-alignment-too-large");
      if (alignmentLength === null) alignmentLength = alignedSequence.length;
      if (alignedSequence.length !== alignmentLength) throw new Error("comparative-genomics-alignment-length-mismatch");
    }
    const children = Array.isArray(node.children) ? node.children : [];
    const label = scientificName ?? commonName ?? geneId ?? nodeId;
    nodes.push({ nodeId, parentId, depth, label, taxonomyId, scientificName, commonName, event, branchLength, bootstrap, duplicationConfidence, geneId, proteinIds, leaf: children.length === 0 });
    if (children.length === 0) {
      if (!geneId || !scientificName || !alignedSequence) throw new Error("comparative-genomics-leaf-evidence-incomplete");
      const gapCount = [...alignedSequence].filter((character) => character === "-").length;
      const missingCount = [...alignedSequence].filter((character) => character === "?" || character === ".").length;
      leaves.push({ nodeId, geneId, proteinIds, scientificName, commonName, taxonomyId, alignedSequence, alignmentLength: alignedSequence.length, residueCount: alignedSequence.length - gapCount - missingCount, gapFraction: gapCount / alignedSequence.length, missingFraction: missingCount / alignedSequence.length });
    }
    children.forEach((child) => visit(child, nodeId, depth + 1));
  }

  visit(root, null, 0);
  if (leaves.length < 3 || alignmentLength === null || alignmentLength < 3) throw new Error("comparative-genomics-insufficient-alignment");
  const rootNode = nodes[0];
  const requestedTaxonNode = nodes.find((node) => node.taxonomyId === request.pruneTaxon);
  if (!requestedTaxonNode) throw new Error("comparative-genomics-pruned-taxon-unwitnessed");
  const duplicationNodeCount = nodes.filter((node) => node.event === "duplication" || node.event === "gene_split").length;
  const lowSupportNodeCount = nodes.filter((node) => node.bootstrap !== null && node.bootstrap < 70).length;
  const alignmentSha256 = sha256(leaves.map((leaf) => `${leaf.geneId}\t${leaf.alignedSequence}\n`).join(""));
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${title}: extant sequence and alignment QC`,
    columns: [
      { id: "taxon", label: "Extant taxon", type: "string", unit: null },
      { id: "geneId", label: "Ensembl gene ID", type: "string", unit: null },
      { id: "proteinIds", label: "Sequence IDs", type: "string", unit: null },
      { id: "residues", label: "Non-gap residues", type: "integer", unit: request.sequenceType === "protein" ? "aa" : "nt" },
      { id: "gapFraction", label: "Gap fraction", type: "number", unit: "fraction" },
      { id: "missingFraction", label: "Missing fraction", type: "number", unit: "fraction" },
    ],
    rows: leaves.map((leaf) => [leaf.scientificName, leaf.geneId, leaf.proteinIds.join("; ") || null, leaf.residueCount, Number(leaf.gapFraction.toFixed(6)), Number(leaf.missingFraction.toFixed(6))]),
    notes: [
      `Exact Ensembl release response: ${releases.join(", ")}.`,
      "The multiple-sequence alignment and gene tree are Ensembl Compara inferences, not directly observed ancestry.",
      "No ancestral sequence, extinct-species genome, chromosome organization, phenotype, embryo viability, or hatching claim is emitted.",
    ],
  };
  const spec = {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: 760,
    height: Math.max(360, Math.min(1200, leaves.length * 24)),
    padding: { left: 24, right: 220, top: 72, bottom: 36 },
    title: { text: title, subtitle: `Ensembl Compara gene tree ${geneTreeId} · release ${releases[0]} · extant-taxon MRCA only`, anchor: "start", fontSize: 16, subtitleFontSize: 11 },
    data: [
      { name: "nodes", values: nodes.map((node) => ({ ...node, displayLabel: node.leaf ? `${node.scientificName} · ${node.geneId}` : node.label })) , transform: [
        { type: "stratify", key: "nodeId", parentKey: "parentId" },
        { type: "tree", method: "tidy", size: [Math.max(360, Math.min(1200, leaves.length * 24)), 760], as: ["y", "x", "depth", "children"] },
      ] },
      { name: "links", source: "nodes", transform: [{ type: "treelinks" }, { type: "linkpath", orient: "horizontal", shape: "diagonal" }] },
    ],
    scales: [{ name: "eventColor", type: "ordinal", domain: ["speciation", "duplication", "gene_split"], range: ["#39765A", "#A65A44", "#8D5F9B"] }],
    marks: [
      { type: "path", from: { data: "links" }, encode: { update: { path: { field: "path" }, stroke: { value: "#B8B6B2" }, strokeWidth: { value: 1.2 } } } },
      { type: "symbol", from: { data: "nodes" }, encode: { update: { x: { field: "x" }, y: { field: "y" }, size: { value: 38 }, fill: { scale: "eventColor", field: "event", default: "#6D716F" }, tooltip: { field: "displayLabel" } } } },
      { type: "text", from: { data: "nodes" }, encode: { update: { x: { field: "x", offset: 7 }, y: { field: "y" }, baseline: { value: "middle" }, text: { field: "displayLabel" }, fill: { value: "#2F302E" }, fontSize: { value: 10 }, limit: { value: 210 } } } },
    ],
  };
  const core = {
    schema: "agentlas.comparative-genomics-gene-tree/v1",
    provider: "ensembl-compara",
    providerRelease: releases,
    request,
    title,
    geneTreeId,
    rooted: true,
    targetNode: { nodeId: requestedTaxonNode.nodeId, taxonomyId: requestedTaxonNode.taxonomyId, scientificName: requestedTaxonNode.scientificName, meaning: "provider-returned-node-for-requested-prune-taxon" },
    nodes,
    leaves,
    alignment: { sequenceType: request.sequenceType, length: alignmentLength, sha256: alignmentSha256, leafCount: leaves.length },
    diagnostics: { nodeCount: nodes.length, leafCount: leaves.length, duplicationNodeCount, lowSupportNodeCount },
    publicationTable,
    spec,
    evidenceBoundary: {
      observed: ["exact-provider-response-bytes", "extant-sequence-records-returned-by-provider"],
      inferred: ["orthology-paralogy", "multiple-sequence-alignment", "rooted-gene-tree", "duplication-events"],
      hypothetical: [],
      prohibitedInference: ["extinct-species-dna", "extinct-species-genome", "chromosome-reconstruction", "phenotype", "embryo-viability", "hatching"],
    },
    warnings: [
      "This is a provider-inferred gene-family tree over sampled extant lineages, not a species-level extinct genome.",
      ...(duplicationNodeCount ? ["Duplication or gene-split nodes are present; one-to-one orthology must not be assumed."] : []),
      ...(lowSupportNodeCount ? ["At least one reported internal branch has bootstrap support below 70."] : []),
      "No local alternative-alignment, model, or topology sensitivity analysis has been run yet.",
    ],
  };
  return { ...core, deterministicHash: sha256(stableStringify(core)) };
}

module.exports = { PLUGIN_VERSION, ENSEMBL_ORIGIN, ENSEMBL_FTP_ORIGIN, sha256, stableStringify, buildReferenceAssemblyManifestRequest, normalizeReferenceAssemblyManifest, buildGeneTreeRequest, normalizeGeneTree };
