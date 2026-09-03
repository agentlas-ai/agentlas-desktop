"use strict";

const crypto = require("node:crypto");

const ENGINE_VERSION = "0.1.0";
const REQUEST_SCHEMA = "agentlas.comparative-genomics.extant-archosaur-locus-panel-request/v1";
const RESULT_SCHEMA = "agentlas.comparative-genomics.extant-archosaur-locus-panel-result/v1";
const TREE_SCHEMA = "agentlas.comparative-genomics-gene-tree/v1";
const ASSEMBLY_SCHEMA = "agentlas.extant-reference-assembly-manifest/v1";
const MAX_SITE_BINS = 400;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const ASR_DNA = /^[ACGTRYSWKMBDHVN-]+$/u;
const IUPAC = Object.freeze({
  A: ["A"], C: ["C"], G: ["G"], T: ["T"],
  R: ["A", "G"], Y: ["C", "T"], S: ["C", "G"], W: ["A", "T"],
  K: ["G", "T"], M: ["A", "C"], B: ["C", "G", "T"],
  D: ["A", "G", "T"], H: ["A", "C", "T"], V: ["A", "C", "G"],
  N: ["A", "C", "G", "T"],
});

function fail(code) {
  throw new Error(code);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function rejectUnknownFields(value, allowed, code) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}

function text(value, maximum, code) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value.trim();
}

function safeId(value, code) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !SAFE_ID.test(value)) fail(code);
  return value;
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function finite(value, minimum, maximum, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function ascii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function validateHash(value, code) {
  const deterministicHash = value.deterministicHash;
  if (typeof deterministicHash !== "string" || !/^[a-f0-9]{64}$/u.test(deterministicHash)) fail(code);
  const core = { ...value };
  delete core.deterministicHash;
  if (sha256(stableStringify(core)) !== deterministicHash) fail(code);
}

function validateReleases(value, code) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) fail(code);
  const releases = value.map((item) => integer(item, 1, 10_000, code));
  if (new Set(releases).size !== releases.length) fail(code);
  if (releases.some((release, index) => index > 0 && releases[index - 1] < release)) fail(code);
  return releases;
}

function validateComparativeAssessment(raw) {
  const assessment = object(raw, "extant-archosaur-locus-panel-comparative-assessment-invalid");
  rejectUnknownFields(assessment, [
    "schema", "provider", "providerRelease", "request", "title", "geneTreeId", "rooted",
    "targetNode", "nodes", "leaves", "alignment", "diagnostics", "publicationTable", "spec",
    "evidenceBoundary", "warnings", "deterministicHash",
  ], "extant-archosaur-locus-panel-comparative-assessment-unknown-field");
  if (assessment.schema !== TREE_SCHEMA || assessment.provider !== "ensembl-compara" || assessment.rooted !== true) {
    fail("extant-archosaur-locus-panel-comparative-assessment-invalid");
  }
  validateHash(assessment, "extant-archosaur-locus-panel-comparative-assessment-hash-invalid");
  const providerRelease = validateReleases(assessment.providerRelease, "extant-archosaur-locus-panel-comparative-release-invalid");
  const request = object(assessment.request, "extant-archosaur-locus-panel-comparative-request-invalid");
  rejectUnknownFields(request, ["species", "geneId", "pruneTaxon", "sequenceType"], "extant-archosaur-locus-panel-comparative-request-invalid");
  if (request.sequenceType !== "cdna" && request.sequenceType !== "protein") fail("extant-archosaur-locus-panel-sequence-type-invalid");
  safeId(assessment.geneTreeId, "extant-archosaur-locus-panel-gene-tree-id-invalid");

  if (!Array.isArray(assessment.nodes) || assessment.nodes.length < 3 || assessment.nodes.length > 2500) {
    fail("extant-archosaur-locus-panel-tree-size-invalid");
  }
  const nodes = assessment.nodes.map((rawNode) => {
    const node = object(rawNode, "extant-archosaur-locus-panel-node-invalid");
    rejectUnknownFields(node, [
      "nodeId", "parentId", "depth", "label", "taxonomyId", "scientificName", "commonName",
      "event", "branchLength", "bootstrap", "duplicationConfidence", "geneId", "proteinIds", "leaf",
    ], "extant-archosaur-locus-panel-node-invalid");
    const nodeId = safeId(node.nodeId, "extant-archosaur-locus-panel-node-id-invalid");
    const parentId = node.parentId === null ? null : safeId(node.parentId, "extant-archosaur-locus-panel-parent-id-invalid");
    const depth = integer(node.depth, 0, 256, "extant-archosaur-locus-panel-node-depth-invalid");
    if (node.leaf !== true && node.leaf !== false) fail("extant-archosaur-locus-panel-node-leaf-invalid");
    if (node.bootstrap !== null) finite(node.bootstrap, 0, 100, "extant-archosaur-locus-panel-node-bootstrap-invalid");
    if (node.event !== null && typeof node.event !== "string") fail("extant-archosaur-locus-panel-node-event-invalid");
    return { ...node, nodeId, parentId, depth };
  });
  const nodeById = new Map();
  for (const node of nodes) {
    if (nodeById.has(node.nodeId)) fail("extant-archosaur-locus-panel-duplicate-node-id");
    nodeById.set(node.nodeId, node);
  }
  const childrenById = new Map(nodes.map((node) => [node.nodeId, []]));
  const roots = [];
  for (const node of nodes) {
    if (node.parentId === null) roots.push(node);
    else {
      if (!nodeById.has(node.parentId) || node.parentId === node.nodeId) fail("extant-archosaur-locus-panel-parent-invalid");
      childrenById.get(node.parentId).push(node.nodeId);
    }
  }
  if (roots.length !== 1 || roots[0].depth !== 0) fail("extant-archosaur-locus-panel-root-invalid");
  const root = roots[0];
  const visited = new Set();
  const visiting = new Set();
  function visit(nodeId, depth) {
    if (visiting.has(nodeId)) fail("extant-archosaur-locus-panel-tree-cycle");
    if (visited.has(nodeId)) fail("extant-archosaur-locus-panel-multiple-parent-path");
    const node = nodeById.get(nodeId);
    if (node.depth !== depth) fail("extant-archosaur-locus-panel-node-depth-mismatch");
    const children = childrenById.get(nodeId);
    if (node.leaf !== (children.length === 0)) fail("extant-archosaur-locus-panel-node-leaf-mismatch");
    visiting.add(nodeId);
    children.sort(ascii).forEach((childId) => visit(childId, depth + 1));
    visiting.delete(nodeId);
    visited.add(nodeId);
  }
  visit(root.nodeId, 0);
  if (visited.size !== nodes.length) fail("extant-archosaur-locus-panel-tree-disconnected");

  const alignment = object(assessment.alignment, "extant-archosaur-locus-panel-alignment-invalid");
  rejectUnknownFields(alignment, ["sequenceType", "length", "sha256", "leafCount"], "extant-archosaur-locus-panel-alignment-invalid");
  if (alignment.sequenceType !== request.sequenceType) fail("extant-archosaur-locus-panel-alignment-sequence-type-mismatch");
  const alignmentLength = integer(alignment.length, 3, 200_000, "extant-archosaur-locus-panel-alignment-length-invalid");
  if (typeof alignment.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(alignment.sha256)) fail("extant-archosaur-locus-panel-alignment-hash-invalid");
  if (!Array.isArray(assessment.leaves) || assessment.leaves.length < 3 || assessment.leaves.length > 2500) {
    fail("extant-archosaur-locus-panel-leaves-invalid");
  }
  const leaves = assessment.leaves.map((rawLeaf) => {
    const leaf = object(rawLeaf, "extant-archosaur-locus-panel-leaf-invalid");
    rejectUnknownFields(leaf, [
      "nodeId", "geneId", "proteinIds", "scientificName", "commonName", "taxonomyId",
      "alignedSequence", "alignmentLength", "residueCount", "gapFraction", "missingFraction",
    ], "extant-archosaur-locus-panel-leaf-invalid");
    const nodeId = safeId(leaf.nodeId, "extant-archosaur-locus-panel-leaf-id-invalid");
    const geneId = safeId(leaf.geneId, "extant-archosaur-locus-panel-leaf-gene-id-invalid");
    if (typeof leaf.scientificName !== "string" || !leaf.scientificName.trim()) fail("extant-archosaur-locus-panel-leaf-name-invalid");
    if (leaf.taxonomyId !== null) integer(leaf.taxonomyId, 1, 2_147_483_647, "extant-archosaur-locus-panel-leaf-taxonomy-invalid");
    if (typeof leaf.alignedSequence !== "string" || leaf.alignedSequence.length !== alignmentLength || !/^[A-Za-z*?\-.]+$/u.test(leaf.alignedSequence)) {
      fail("extant-archosaur-locus-panel-leaf-sequence-invalid");
    }
    if (leaf.alignmentLength !== alignmentLength) fail("extant-archosaur-locus-panel-leaf-alignment-length-invalid");
    const gapCount = [...leaf.alignedSequence].filter((character) => character === "-").length;
    const missingCount = [...leaf.alignedSequence].filter((character) => character === "?" || character === ".").length;
    if (leaf.residueCount !== alignmentLength - gapCount - missingCount
      || leaf.gapFraction !== gapCount / alignmentLength
      || leaf.missingFraction !== missingCount / alignmentLength) {
      fail("extant-archosaur-locus-panel-leaf-qc-mismatch");
    }
    return { ...leaf, nodeId, geneId };
  });
  if (alignment.leafCount !== leaves.length) fail("extant-archosaur-locus-panel-alignment-leaf-count-mismatch");
  const leafById = new Map();
  for (const leaf of leaves) {
    if (leafById.has(leaf.nodeId) || nodeById.get(leaf.nodeId)?.leaf !== true) fail("extant-archosaur-locus-panel-leaf-mismatch");
    leafById.set(leaf.nodeId, leaf);
  }
  const treeLeafIds = nodes.filter((node) => node.leaf).map((node) => node.nodeId).sort(ascii);
  const alignmentLeafIds = leaves.map((leaf) => leaf.nodeId).sort(ascii);
  if (stableStringify(treeLeafIds) !== stableStringify(alignmentLeafIds)) fail("extant-archosaur-locus-panel-leaf-mismatch");
  const alignmentReceipt = leaves.map((leaf) => `${leaf.geneId}\t${leaf.alignedSequence}\n`).join("");
  if (sha256(alignmentReceipt) !== alignment.sha256) fail("extant-archosaur-locus-panel-alignment-hash-mismatch");

  return {
    assessment,
    providerRelease,
    request,
    nodes,
    nodeById,
    childrenById,
    root,
    leaves,
    leafById,
    alignment,
    alignmentLength,
  };
}

function validateAssemblyManifest(raw) {
  const manifest = object(raw, "extant-archosaur-locus-panel-assembly-manifest-invalid");
  rejectUnknownFields(manifest, [
    "schema", "provider", "providerRelease", "request", "title", "assemblies", "publicationTable",
    "evidenceBoundary", "warnings", "deterministicHash",
  ], "extant-archosaur-locus-panel-assembly-manifest-unknown-field");
  if (manifest.schema !== ASSEMBLY_SCHEMA || manifest.provider !== "ensembl") fail("extant-archosaur-locus-panel-assembly-manifest-invalid");
  validateHash(manifest, "extant-archosaur-locus-panel-assembly-manifest-hash-invalid");
  const providerRelease = validateReleases(manifest.providerRelease, "extant-archosaur-locus-panel-assembly-release-invalid");
  if (!Array.isArray(manifest.assemblies) || manifest.assemblies.length < 2 || manifest.assemblies.length > 8) {
    fail("extant-archosaur-locus-panel-assemblies-invalid");
  }
  const assemblies = manifest.assemblies.map((rawAssembly) => {
    const assembly = object(rawAssembly, "extant-archosaur-locus-panel-assembly-invalid");
    const taxonomyId = integer(assembly.taxonomyId, 1, 2_147_483_647, "extant-archosaur-locus-panel-assembly-taxonomy-invalid");
    const assemblyAccession = safeId(assembly.assemblyAccession, "extant-archosaur-locus-panel-assembly-accession-invalid");
    const ensemblRelease = integer(assembly.ensemblRelease, 1, 10_000, "extant-archosaur-locus-panel-assembly-release-invalid");
    if (typeof assembly.scientificName !== "string" || !assembly.scientificName.trim()) fail("extant-archosaur-locus-panel-assembly-name-invalid");
    return { ...assembly, taxonomyId, assemblyAccession, ensemblRelease };
  });
  return { manifest, providerRelease, assemblies };
}

function validateSelection(raw, nodeById) {
  const selection = object(raw, "extant-archosaur-locus-panel-selection-invalid");
  rejectUnknownFields(selection, ["avianLeafNodeIds", "crocodilianLeafNodeIds"], "extant-archosaur-locus-panel-selection-unknown-field");
  function group(value, name) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 4) fail(`extant-archosaur-locus-panel-${name}-selection-count-invalid`);
    const ids = value.map((item) => safeId(item, `extant-archosaur-locus-panel-${name}-leaf-id-invalid`)).sort(ascii);
    if (new Set(ids).size !== ids.length) fail(`extant-archosaur-locus-panel-${name}-selection-duplicate`);
    if (ids.some((id) => nodeById.get(id)?.leaf !== true)) fail(`extant-archosaur-locus-panel-${name}-selection-not-leaf`);
    return ids;
  }
  const avianLeafNodeIds = group(selection.avianLeafNodeIds, "avian");
  const crocodilianLeafNodeIds = group(selection.crocodilianLeafNodeIds, "crocodilian");
  if (avianLeafNodeIds.some((id) => crocodilianLeafNodeIds.includes(id))) fail("extant-archosaur-locus-panel-selection-overlap");
  return { avianLeafNodeIds, crocodilianLeafNodeIds };
}

function ancestorChain(nodeId, nodeById) {
  const chain = [];
  let current = nodeById.get(nodeId);
  while (current) {
    chain.push(current.nodeId);
    current = current.parentId === null ? null : nodeById.get(current.parentId);
  }
  return chain;
}

function mrca(nodeIds, nodeById) {
  const chains = nodeIds.map((nodeId) => ancestorChain(nodeId, nodeById));
  const otherSets = chains.slice(1).map((chain) => new Set(chain));
  return chains[0].find((nodeId) => otherSets.every((set) => set.has(nodeId)));
}

function childBelow(ancestorId, leafId, nodeById) {
  let current = nodeById.get(leafId);
  while (current.parentId !== ancestorId) {
    if (current.parentId === null) return null;
    current = nodeById.get(current.parentId);
  }
  return current.nodeId;
}

function statesFor(character) {
  const normalized = character.toUpperCase();
  if (normalized === "-" || normalized === "?" || normalized === ".") return new Set();
  return new Set(IUPAC[normalized] ?? [normalized]);
}

function unionStates(sets) {
  return new Set(sets.flatMap((set) => [...set]));
}

function intersectionSize(left, right) {
  for (const value of left) if (right.has(value)) return 1;
  return 0;
}

function variableObservedState(sets) {
  const callable = sets.filter((set) => set.size > 0);
  if (callable.length < 2) return false;
  let shared = new Set(callable[0]);
  for (const set of callable.slice(1)) shared = new Set([...shared].filter((state) => set.has(state)));
  return shared.size === 0;
}

function buildSiteBins(alignmentLength, avianLeaves, crocodilianLeaves) {
  const binCount = Math.min(MAX_SITE_BINS, alignmentLength);
  const bins = [];
  for (let index = 0; index < binCount; index += 1) {
    const startSite = Math.floor(index * alignmentLength / binCount) + 1;
    const endSite = Math.floor((index + 1) * alignmentLength / binCount);
    const siteCount = endSite - startSite + 1;
    let avianCallableCells = 0;
    let crocodilianCallableCells = 0;
    let avianVariableSiteCount = 0;
    let crocodilianVariableSiteCount = 0;
    let sharedObservedStateSiteCount = 0;
    let lineageDistinctObservedStateSiteCount = 0;
    let crossGroupCallableSiteCount = 0;
    for (let site = startSite - 1; site < endSite; site += 1) {
      const avianSets = avianLeaves.map((leaf) => statesFor(leaf.alignedSequence[site]));
      const crocodilianSets = crocodilianLeaves.map((leaf) => statesFor(leaf.alignedSequence[site]));
      avianCallableCells += avianSets.filter((set) => set.size > 0).length;
      crocodilianCallableCells += crocodilianSets.filter((set) => set.size > 0).length;
      if (variableObservedState(avianSets)) avianVariableSiteCount += 1;
      if (variableObservedState(crocodilianSets)) crocodilianVariableSiteCount += 1;
      const avianStates = unionStates(avianSets);
      const crocodilianStates = unionStates(crocodilianSets);
      if (avianStates.size > 0 && crocodilianStates.size > 0) {
        crossGroupCallableSiteCount += 1;
        if (intersectionSize(avianStates, crocodilianStates)) sharedObservedStateSiteCount += 1;
        else lineageDistinctObservedStateSiteCount += 1;
      }
    }
    bins.push({
      bin: index + 1,
      startSite,
      endSite,
      midSite: (startSite + endSite) / 2,
      siteCount,
      avianCallableFraction: rounded(avianCallableCells / (siteCount * avianLeaves.length)),
      crocodilianCallableFraction: rounded(crocodilianCallableCells / (siteCount * crocodilianLeaves.length)),
      avianVariableSiteCount,
      crocodilianVariableSiteCount,
      sharedObservedStateSiteCount,
      lineageDistinctObservedStateSiteCount,
      crossGroupCallableSiteCount,
    });
  }
  return bins;
}

const REASON_ORDER = Object.freeze([
  "sequence-type-not-cdna",
  "tree-not-strictly-bifurcating",
  "alignment-not-asr-compatible",
  "joint-mrca-is-root",
  "selected-lineages-not-separated-at-joint-mrca",
  "assembly-identity-unresolved",
  "no-cross-group-callable-sites",
  "provider-release-mismatch",
  "duplication-or-gene-split-on-induced-path",
  "low-bootstrap-on-induced-path",
  "unreported-bootstrap-on-induced-path",
]);

function makeSpec(title, status, alignmentLength, siteBins) {
  return {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: 760,
    height: 320,
    padding: { left: 56, right: 24, top: 72, bottom: 48 },
    title: {
      text: title,
      subtitle: `Extant avian/crocodilian alignment QC · ${status}`,
      anchor: "start",
      fontSize: 16,
      subtitleFontSize: 11,
    },
    data: [{ name: "siteBins", values: siteBins }],
    scales: [
      { name: "x", type: "linear", domain: [1, alignmentLength], range: "width", zero: false, nice: false },
      { name: "y", type: "linear", domain: [0, 1], range: "height", zero: true, nice: false },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "Alignment site" },
      { orient: "left", scale: "y", title: "Callable fraction", format: ".0%" },
    ],
    marks: [
      {
        type: "rect",
        from: { data: "siteBins" },
        encode: { update: {
          x: { scale: "x", field: "startSite" }, x2: { scale: "x", field: "endSite" },
          y: { value: 0 }, y2: { value: 5 }, fill: { value: "#A65A44" },
          opacity: { value: 0.3 },
          tooltip: { field: "lineageDistinctObservedStateSiteCount" },
        } },
      },
      {
        type: "line",
        from: { data: "siteBins" },
        encode: { update: {
          x: { scale: "x", field: "midSite" },
          y: { scale: "y", field: "avianCallableFraction" },
          stroke: { value: "#39765A" }, strokeWidth: { value: 2 },
        } },
      },
      {
        type: "line",
        from: { data: "siteBins" },
        encode: { update: {
          x: { scale: "x", field: "midSite" },
          y: { scale: "y", field: "crocodilianCallableFraction" },
          stroke: { value: "#3E6487" }, strokeWidth: { value: 2 },
        } },
      },
    ],
  };
}

function materializeExtantArchosaurLocusPanel(input) {
  const request = object(input, "extant-archosaur-locus-panel-request-invalid");
  rejectUnknownFields(request, ["schema", "title", "comparativeAssessment", "assemblyManifest", "selection"], "extant-archosaur-locus-panel-request-unknown-field");
  if (request.schema !== REQUEST_SCHEMA) fail("extant-archosaur-locus-panel-request-schema-invalid");
  const title = text(request.title, 240, "extant-archosaur-locus-panel-title-invalid");
  const comparative = validateComparativeAssessment(request.comparativeAssessment);
  const assembly = validateAssemblyManifest(request.assemblyManifest);
  const selection = validateSelection(request.selection, comparative.nodeById);
  const selectedIds = [...selection.avianLeafNodeIds, ...selection.crocodilianLeafNodeIds];
  const avianNodeId = mrca(selection.avianLeafNodeIds, comparative.nodeById);
  const crocodilianNodeId = mrca(selection.crocodilianLeafNodeIds, comparative.nodeById);
  const jointNodeId = mrca(selectedIds, comparative.nodeById);
  if (!avianNodeId || !crocodilianNodeId || !jointNodeId) fail("extant-archosaur-locus-panel-mrca-invalid");

  const inducedNodeIds = new Set([jointNodeId]);
  const edgeKeys = new Set();
  const edges = [];
  for (const leafId of selectedIds) {
    let current = comparative.nodeById.get(leafId);
    while (current.nodeId !== jointNodeId) {
      const parentId = current.parentId;
      if (parentId === null) fail("extant-archosaur-locus-panel-induced-path-invalid");
      inducedNodeIds.add(current.nodeId);
      inducedNodeIds.add(parentId);
      const key = `${parentId}\u0000${current.nodeId}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ sourceNodeId: parentId, targetNodeId: current.nodeId });
      }
      current = comparative.nodeById.get(parentId);
    }
  }
  const orderedNodeIds = [...inducedNodeIds].sort((left, right) => {
    const depthDifference = comparative.nodeById.get(left).depth - comparative.nodeById.get(right).depth;
    return depthDifference || ascii(left, right);
  });
  edges.sort((left, right) => ascii(left.sourceNodeId, right.sourceNodeId) || ascii(left.targetNodeId, right.targetNodeId));
  const internalNodeIds = orderedNodeIds.filter((nodeId) => comparative.childrenById.get(nodeId).length > 0);
  const duplicationOrGeneSplitNodeIds = internalNodeIds.filter((nodeId) => ["duplication", "gene_split"].includes(comparative.nodeById.get(nodeId).event));
  const lowSupportNodeIds = internalNodeIds.filter((nodeId) => {
    const bootstrap = comparative.nodeById.get(nodeId).bootstrap;
    return bootstrap !== null && bootstrap < 70;
  });
  const unreportedSupportNodeIds = internalNodeIds.filter((nodeId) => nodeId !== comparative.root.nodeId && comparative.nodeById.get(nodeId).bootstrap === null);

  const avianChildIds = new Set(selection.avianLeafNodeIds.map((leafId) => childBelow(jointNodeId, leafId, comparative.nodeById)));
  const crocodilianChildIds = new Set(selection.crocodilianLeafNodeIds.map((leafId) => childBelow(jointNodeId, leafId, comparative.nodeById)));
  const lineagesSeparated = avianChildIds.size === 1 && crocodilianChildIds.size === 1
    && !avianChildIds.has(null) && !crocodilianChildIds.has(null)
    && [...avianChildIds][0] !== [...crocodilianChildIds][0];

  const assembliesByTaxonomyId = new Map();
  for (const item of assembly.assemblies) {
    const matches = assembliesByTaxonomyId.get(item.taxonomyId) ?? [];
    matches.push(item);
    assembliesByTaxonomyId.set(item.taxonomyId, matches);
  }
  let assemblyIdentityUnresolved = false;
  const selected = [
    ...selection.avianLeafNodeIds.map((leafNodeId) => ({ group: "avian", leafNodeId })),
    ...selection.crocodilianLeafNodeIds.map((leafNodeId) => ({ group: "crocodilian", leafNodeId })),
  ];
  const leafQc = selected.map(({ group, leafNodeId }) => {
    const leaf = comparative.leafById.get(leafNodeId);
    const matches = leaf.taxonomyId === null ? [] : assembliesByTaxonomyId.get(leaf.taxonomyId) ?? [];
    const matchedAssembly = matches.length === 1 ? matches[0] : null;
    if (!matchedAssembly) assemblyIdentityUnresolved = true;
    let pathEdgeCount = 0;
    let current = comparative.nodeById.get(leafNodeId);
    while (current.nodeId !== jointNodeId) {
      pathEdgeCount += 1;
      current = comparative.nodeById.get(current.parentId);
    }
    return {
      group,
      leafNodeId,
      scientificName: leaf.scientificName,
      taxonomyId: leaf.taxonomyId,
      geneId: leaf.geneId,
      assemblyAccession: matchedAssembly?.assemblyAccession ?? null,
      assemblyRelease: matchedAssembly?.ensemblRelease ?? null,
      residueCount: leaf.residueCount,
      gapFraction: rounded(leaf.gapFraction),
      missingFraction: rounded(leaf.missingFraction),
      pathEdgeCount,
    };
  });

  const avianLeaves = selection.avianLeafNodeIds.map((id) => comparative.leafById.get(id));
  const crocodilianLeaves = selection.crocodilianLeafNodeIds.map((id) => comparative.leafById.get(id));
  const siteBins = buildSiteBins(comparative.alignmentLength, avianLeaves, crocodilianLeaves);
  const crossGroupCallableSiteCount = siteBins.reduce((sum, bin) => sum + bin.crossGroupCallableSiteCount, 0);
  const strictlyBifurcating = comparative.nodes.filter((node) => !node.leaf).every((node) => comparative.childrenById.get(node.nodeId).length === 2);
  const asrCompatibleAlignment = comparative.leaves.every((leaf) => ASR_DNA.test(leaf.alignedSequence));

  const reasons = [];
  function reason(condition, code, severity) {
    if (condition) reasons.push({ code, severity });
  }
  reason(comparative.request.sequenceType !== "cdna", "sequence-type-not-cdna", "block");
  reason(!strictlyBifurcating, "tree-not-strictly-bifurcating", "block");
  reason(!asrCompatibleAlignment, "alignment-not-asr-compatible", "block");
  reason(jointNodeId === comparative.root.nodeId, "joint-mrca-is-root", "block");
  reason(!lineagesSeparated, "selected-lineages-not-separated-at-joint-mrca", "block");
  reason(assemblyIdentityUnresolved, "assembly-identity-unresolved", "block");
  reason(crossGroupCallableSiteCount === 0, "no-cross-group-callable-sites", "block");
  reason(comparative.providerRelease[0] !== assembly.providerRelease[0], "provider-release-mismatch", "review");
  reason(duplicationOrGeneSplitNodeIds.length > 0, "duplication-or-gene-split-on-induced-path", "review");
  reason(lowSupportNodeIds.length > 0, "low-bootstrap-on-induced-path", "review");
  reason(unreportedSupportNodeIds.length > 0, "unreported-bootstrap-on-induced-path", "review");
  reasons.sort((left, right) => REASON_ORDER.indexOf(left.code) - REASON_ORDER.indexOf(right.code));
  const status = reasons.some((item) => item.severity === "block")
    ? "blocked"
    : reasons.some((item) => item.severity === "review")
      ? "review-required"
      : "candidate-for-exploratory-asr";

  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${title}: selected extant lineage QC`,
    columns: [
      { id: "group", label: "Extant group", type: "string", unit: null },
      { id: "taxon", label: "Extant taxon", type: "string", unit: null },
      { id: "leafNodeId", label: "Gene-tree leaf", type: "string", unit: null },
      { id: "geneId", label: "Ensembl gene ID", type: "string", unit: null },
      { id: "assemblyAccession", label: "Assembly accession", type: "string", unit: null },
      { id: "release", label: "Ensembl release", type: "integer", unit: null },
      { id: "residues", label: "Non-gap residues", type: "integer", unit: comparative.request.sequenceType === "cdna" ? "nt" : "aa" },
      { id: "gapFraction", label: "Gap fraction", type: "number", unit: "fraction" },
      { id: "missingFraction", label: "Missing fraction", type: "number", unit: "fraction" },
      { id: "pathEdges", label: "Edges to joint MRCA", type: "integer", unit: "count" },
    ],
    rows: leafQc.map((leaf) => [
      leaf.group, leaf.scientificName, leaf.leafNodeId, leaf.geneId, leaf.assemblyAccession,
      leaf.assemblyRelease, leaf.residueCount, leaf.gapFraction, leaf.missingFraction, leaf.pathEdgeCount,
    ]),
    notes: [
      "Rows describe caller-selected extant lineages and exact assembly identities only.",
      "The tree and alignment are provider inferences; the MRCA and induced path are deterministic graph derivations from that inferred tree.",
      "Provider FASTA CHECKSUMS values are BSD sums, not cryptographic content hashes, and FASTA contents were not downloaded by the manifest operation.",
      "This panel emits no ancestral sequence, extinct-species genome, chromosome organization, phenotype, embryo viability, or hatching claim.",
    ],
  };
  const core = {
    schema: RESULT_SCHEMA,
    engine: { name: "extant-archosaur-locus-panel", version: ENGINE_VERSION, deterministic: true },
    title,
    decision: { status, reasons },
    selection,
    analysis: {
      locus: {
        geneTreeId: comparative.assessment.geneTreeId,
        sequenceType: comparative.request.sequenceType,
        alignmentLength: comparative.alignmentLength,
        alignmentSha256: comparative.alignment.sha256,
      },
      mrca: { avianNodeId, crocodilianNodeId, jointNodeId, targetNodeId: jointNodeId },
      inducedPath: { nodeIds: orderedNodeIds, internalNodeIds, edges, duplicationOrGeneSplitNodeIds, lowSupportNodeIds, unreportedSupportNodeIds },
      leafQc,
      siteBins,
    },
    publicationTable,
    spec: makeSpec(title, status, comparative.alignmentLength, siteBins),
    evidenceBoundary: {
      observed: ["caller-selected-extant-sequence-records", "version-pinned-extant-assembly-identities"],
      inferred: ["provider-multiple-sequence-alignment", "provider-rooted-gene-tree", "mrca-and-induced-path-derived-from-provider-tree"],
      hypothetical: [],
      prohibitedInference: ["extinct-species-dna", "extinct-species-genome", "chromosome-reconstruction", "phenotype", "embryo-viability", "hatching"],
    },
    warnings: [
      "Decision status is a workflow gate for exploratory hypothetical ASR, not biological feasibility or publication acceptance.",
      "No raw aligned sequence is included in this result; use the pinned parent comparative assessment for authorized downstream computation.",
      "Independent alignment, topology, substitution-model, taxon-sampling, and experimental review remain required.",
    ],
  };
  return { ...core, deterministicHash: sha256(stableStringify(core)) };
}

module.exports = {
  ENGINE_VERSION,
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  materializeExtantArchosaurLocusPanel,
};
