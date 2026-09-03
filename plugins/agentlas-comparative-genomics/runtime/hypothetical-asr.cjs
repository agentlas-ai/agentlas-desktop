"use strict";

const crypto = require("node:crypto");

const ENGINE_VERSION = "0.1.0";
const REQUEST_SCHEMA = "agentlas.comparative-genomics.hypothetical-asr-request/v1";
const RESULT_SCHEMA = "agentlas.comparative-genomics.hypothetical-asr-result/v1";
const LIMITS = Object.freeze({
  maxLeaves: 256,
  maxNodes: 511,
  maxSites: 20_000,
  maxTotalSequenceCharacters: 2_000_000,
  maxNodeIdLength: 80,
});

const STATE_ORDER = Object.freeze(["A", "C", "G", "T", "-"]);
const IUPAC_STATES = Object.freeze({
  A: ["A"],
  C: ["C"],
  G: ["G"],
  T: ["T"],
  R: ["A", "G"],
  Y: ["C", "T"],
  S: ["C", "G"],
  W: ["A", "T"],
  K: ["G", "T"],
  M: ["A", "C"],
  B: ["C", "G", "T"],
  D: ["A", "G", "T"],
  H: ["A", "C", "T"],
  V: ["A", "C", "G"],
  N: ["A", "C", "G", "T"],
  "-": ["-"],
});

const STATES_TO_IUPAC = new Map(
  Object.entries(IUPAC_STATES).map(([symbol, states]) => [states.join(""), symbol]),
);

const PROHIBITED_NAME_PATTERN = /(?:dinosaur|tyrannosaur|velociraptor|triceratops|stegosaur|jurassic|extinct|de[-_ ]?extinction|resurrect|revival|genome|embryo|hatch|공룡|멸종|부활|복원|게놈|유전체|배아|부화)/iu;

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

function requireObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function rejectUnknownFields(value, allowed, code) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}

function requireSafeName(value, code) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > LIMITS.maxNodeIdLength
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)
    || PROHIBITED_NAME_PATTERN.test(value)
  ) fail(code);
  return value;
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStates(states) {
  return [...states].sort((left, right) => STATE_ORDER.indexOf(left) - STATE_ORDER.indexOf(right));
}

function intersect(left, right) {
  return new Set([...left].filter((state) => right.has(state)));
}

function union(left, right) {
  return new Set([...left, ...right]);
}

function displayState(states) {
  const ordered = sortedStates(states);
  return STATES_TO_IUPAC.get(ordered.join("")) ?? `{${ordered.join("|")}}`;
}

function validateAndNormalize(input) {
  const request = requireObject(input, "hypothetical-asr-request-invalid");
  rejectUnknownFields(
    request,
    ["schema", "moleculeType", "tree", "targetNodeId", "alignment"],
    "hypothetical-asr-request-unknown-field",
  );
  if (request.schema !== REQUEST_SCHEMA) fail("hypothetical-asr-schema-invalid");
  if (request.moleculeType !== "dna") fail("hypothetical-asr-molecule-type-unsupported");

  const tree = requireObject(request.tree, "hypothetical-asr-tree-invalid");
  rejectUnknownFields(tree, ["rooted", "rootId", "nodes"], "hypothetical-asr-tree-unknown-field");
  if (tree.rooted !== true) fail("hypothetical-asr-tree-must-be-rooted");
  const declaredRootId = requireSafeName(tree.rootId, "hypothetical-asr-root-id-invalid");
  const targetNodeId = requireSafeName(request.targetNodeId, "hypothetical-asr-target-id-invalid");
  if (!Array.isArray(tree.nodes) || tree.nodes.length < 5 || tree.nodes.length > LIMITS.maxNodes) {
    fail("hypothetical-asr-tree-size-invalid");
  }

  const nodes = tree.nodes.map((rawNode) => {
    const node = requireObject(rawNode, "hypothetical-asr-node-invalid");
    rejectUnknownFields(node, ["id", "children"], "hypothetical-asr-node-unknown-field");
    const id = requireSafeName(node.id, "hypothetical-asr-node-id-invalid");
    if (!Array.isArray(node.children) || (node.children.length !== 0 && node.children.length !== 2)) {
      fail("hypothetical-asr-tree-must-be-bifurcating");
    }
    const children = node.children.map((child) => requireSafeName(child, "hypothetical-asr-child-id-invalid"));
    if (new Set(children).size !== children.length) fail("hypothetical-asr-duplicate-child");
    return { id, children: [...children].sort(compareAscii) };
  }).sort((left, right) => compareAscii(left.id, right.id));

  const nodeById = new Map();
  for (const node of nodes) {
    if (nodeById.has(node.id)) fail("hypothetical-asr-duplicate-node-id");
    nodeById.set(node.id, node);
  }
  if (!nodeById.has(declaredRootId)) fail("hypothetical-asr-root-missing");
  if (!nodeById.has(targetNodeId)) fail("hypothetical-asr-target-missing");

  const parentCount = new Map(nodes.map((node) => [node.id, 0]));
  for (const node of nodes) {
    for (const childId of node.children) {
      if (!nodeById.has(childId)) fail("hypothetical-asr-child-missing");
      parentCount.set(childId, parentCount.get(childId) + 1);
      if (parentCount.get(childId) > 1) fail("hypothetical-asr-multiple-parents");
    }
  }
  const inferredRoots = nodes.filter((node) => parentCount.get(node.id) === 0).map((node) => node.id);
  if (inferredRoots.length !== 1) fail("hypothetical-asr-root-ambiguous");
  if (inferredRoots[0] !== declaredRootId) fail("hypothetical-asr-root-mismatch");
  if (nodeById.get(declaredRootId).children.length !== 2) fail("hypothetical-asr-root-must-be-internal");

  const visiting = new Set();
  const visited = new Set();
  const postorder = [];
  function visit(nodeId) {
    if (visiting.has(nodeId)) fail("hypothetical-asr-tree-cycle");
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const childId of nodeById.get(nodeId).children) visit(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
    postorder.push(nodeId);
  }
  visit(declaredRootId);
  if (visited.size !== nodes.length) fail("hypothetical-asr-tree-disconnected");

  const targetNode = nodeById.get(targetNodeId);
  if (targetNode.children.length === 0) fail("hypothetical-asr-target-must-be-internal");
  if (targetNodeId === declaredRootId) fail("hypothetical-asr-root-target-unsupported");

  const leafIds = nodes.filter((node) => node.children.length === 0).map((node) => node.id).sort();
  if (leafIds.length < 3 || leafIds.length > LIMITS.maxLeaves) fail("hypothetical-asr-leaf-count-invalid");

  const alignment = requireObject(request.alignment, "hypothetical-asr-alignment-invalid");
  rejectUnknownFields(alignment, ["sequences"], "hypothetical-asr-alignment-unknown-field");
  if (!Array.isArray(alignment.sequences) || alignment.sequences.length !== leafIds.length) {
    fail("hypothetical-asr-leaf-mismatch");
  }

  let siteCount = null;
  let totalSequenceCharacters = 0;
  const sequences = alignment.sequences.map((rawSequence) => {
    const record = requireObject(rawSequence, "hypothetical-asr-sequence-record-invalid");
    rejectUnknownFields(
      record,
      ["leafId", "sequence", "extant", "evidenceStatus"],
      "hypothetical-asr-sequence-record-unknown-field",
    );
    const leafId = requireSafeName(record.leafId, "hypothetical-asr-leaf-id-invalid");
    if (record.extant !== true || record.evidenceStatus !== "observed") {
      fail("hypothetical-asr-extant-observed-evidence-required");
    }
    if (typeof record.sequence !== "string" || record.sequence.length < 1) {
      fail("hypothetical-asr-sequence-invalid");
    }
    if (record.sequence.length > LIMITS.maxSites) fail("hypothetical-asr-alignment-too-long");
    if (!/^[ACGTRYSWKMBDHVN-]+$/u.test(record.sequence)) fail("hypothetical-asr-sequence-invalid");
    totalSequenceCharacters += record.sequence.length;
    if (totalSequenceCharacters > LIMITS.maxTotalSequenceCharacters) fail("hypothetical-asr-input-too-large");
    if (siteCount === null) siteCount = record.sequence.length;
    if (record.sequence.length !== siteCount) fail("hypothetical-asr-alignment-length-mismatch");
    return { leafId, sequence: record.sequence, extant: true, evidenceStatus: "observed" };
  }).sort((left, right) => compareAscii(left.leafId, right.leafId));

  const sequenceIds = sequences.map((record) => record.leafId);
  if (new Set(sequenceIds).size !== sequenceIds.length) fail("hypothetical-asr-duplicate-leaf-sequence");
  if (sequenceIds.some((leafId, index) => leafId !== leafIds[index])) fail("hypothetical-asr-leaf-mismatch");

  for (let siteIndex = 0; siteIndex < siteCount; siteIndex += 1) {
    if (sequences.every((record) => record.sequence[siteIndex] === "-")) {
      fail("hypothetical-asr-all-gap-site");
    }
  }

  return {
    schema: REQUEST_SCHEMA,
    moleculeType: "dna",
    tree: { rooted: true, rootId: declaredRootId, nodes },
    targetNodeId,
    alignment: { sequences },
    postorder,
    leafIds,
    siteCount,
    nodeById,
  };
}

function reconstructHypotheticalAncestor(input) {
  const normalized = validateAndNormalize(input);
  const sequenceByLeafId = new Map(
    normalized.alignment.sequences.map((record) => [record.leafId, record.sequence]),
  );
  const sites = [];

  for (let siteIndex = 0; siteIndex < normalized.siteCount; siteIndex += 1) {
    const stateSets = new Map();
    let minimumChangeCount = 0;
    for (const nodeId of normalized.postorder) {
      const node = normalized.nodeById.get(nodeId);
      if (node.children.length === 0) {
        stateSets.set(nodeId, new Set(IUPAC_STATES[sequenceByLeafId.get(nodeId)[siteIndex]]));
        continue;
      }
      const left = stateSets.get(node.children[0]);
      const right = stateSets.get(node.children[1]);
      const shared = intersect(left, right);
      if (shared.size > 0) stateSets.set(nodeId, shared);
      else {
        stateSets.set(nodeId, union(left, right));
        minimumChangeCount += 1;
      }
    }
    const targetStates = sortedStates(stateSets.get(normalized.targetNodeId));
    sites.push({
      site: siteIndex + 1,
      states: targetStates,
      displayState: displayState(new Set(targetStates)),
      ambiguous: targetStates.length !== 1,
      minimumChangeCount,
      evidenceStatus: "hypothetical",
    });
  }

  const normalizedInput = {
    schema: normalized.schema,
    moleculeType: normalized.moleculeType,
    tree: normalized.tree,
    targetNodeId: normalized.targetNodeId,
    alignment: normalized.alignment,
  };
  const inputSha256 = sha256(stableStringify(normalizedInput));
  const core = {
    schema: RESULT_SCHEMA,
    engine: {
      name: "fitch-parsimony-ambiguity-sets",
      version: ENGINE_VERSION,
      deterministic: true,
    },
    evidenceStatus: "hypothetical",
    target: {
      nodeId: normalized.targetNodeId,
      evidenceStatus: "hypothetical",
    },
    alignment: {
      moleculeType: normalized.moleculeType,
      leafCount: normalized.leafIds.length,
      siteCount: normalized.siteCount,
      inputSha256,
    },
    sites,
    diagnostics: {
      ambiguousSiteCount: sites.filter((site) => site.ambiguous).length,
      totalMinimumChangeCount: sites.reduce((sum, site) => sum + site.minimumChangeCount, 0),
    },
    limitations: [
      "This deterministic Fitch-parsimony result is a provenance and UX green slice, not publication-grade ancestral sequence reconstruction.",
      "It reports ambiguity sets only and does not estimate posterior probabilities, likelihoods, confidence, or biological feasibility.",
      "It uses only caller-supplied extant observed alignment states and does not establish any organism-level, reproductive, or whole-reference reconstruction claim.",
      "Independent alignment, substitution-model, topology, taxon-sampling, and experimental validation remain required.",
    ],
  };
  return { ...core, deterministicHash: sha256(stableStringify(core)) };
}

module.exports = {
  ENGINE_VERSION,
  REQUEST_SCHEMA,
  RESULT_SCHEMA,
  LIMITS,
  reconstructHypotheticalAncestor,
  stableStringify,
};
