"use strict";
const crypto = require("node:crypto");
const PLUGIN_VERSION = "0.2.0";
const PBDB_ENDPOINT = "https://paleobiodb.org/data1.2";
const USER_AGENT = "Agentlas-Science/1.0 (paleontology research; https://agentlas.ai)";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function exactTaxonName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 500 || /[*?%\u0000-\u001f]/u.test(value)) throw new Error("paleontology-taxon-name-invalid");
  return value.trim();
}
function buildTaxonUrl(input) {
  const request = plainObject(input, "paleontology-taxon-request-invalid");
  exactKeys(request, ["taxonName"], "paleontology-taxon-request-unknown-field");
  const taxonName = exactTaxonName(request.taxonName);
  const url = new URL(`${PBDB_ENDPOINT}/taxa/single.json`);
  url.searchParams.set("name", taxonName); url.searchParams.set("vocab", "pbdb"); url.searchParams.set("show", "full");
  return { input: { taxonName }, url: url.toString() };
}
function buildOccurrencesUrl(input) {
  const request = plainObject(input, "paleontology-occurrence-request-invalid");
  exactKeys(request, ["taxonName", "limit", "offset"], "paleontology-occurrence-request-unknown-field");
  const taxonName = exactTaxonName(request.taxonName);
  const limit = request.limit === undefined ? 100 : request.limit;
  const offset = request.offset === undefined ? 0 : request.offset;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("paleontology-limit-invalid");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error("paleontology-offset-invalid");
  const url = new URL(`${PBDB_ENDPOINT}/occs/list.json`);
  for (const [key, value] of [["base_name", taxonName], ["show", "class,coords,loc,strat,ref"], ["vocab", "pbdb"], ["order", "id.asc"], ["limit", String(limit)], ["offset", String(offset)]]) url.searchParams.set(key, value);
  url.searchParams.set("strict", ""); url.searchParams.set("datainfo", ""); url.searchParams.set("rowcount", "");
  return { input: { taxonName, limit, offset }, url: url.toString() };
}
function plainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(code);
  return value;
}
function exactKeys(value, allowed, code) {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) throw new Error(code);
}
function finite(value, minimum, maximum, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
function requiredText(value, maximum, code) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code);
  return value.trim();
}
function optionalText(value, maximum, code) {
  if (value === null) return null;
  return requiredText(value, maximum, code);
}
function exactSha(value, code) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(code);
  return value;
}
function rounded(value, digits = 6) {
  const factor = 10 ** digits;
  const result = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function publicationTableReceipt(table) {
  return { sha256: sha256(stableStringify(table)), mimeType: "application/vnd.agentlas.science-table+json" };
}
function figureReceipt(spec) {
  return { sha256: sha256(stableStringify(spec)), mimeType: "application/vnd.vega.v5+json" };
}

const DEEXTINCTION_OBJECTIVES = new Set(["actual-biological-revival", "comparative-proxy-research"]);
const DEEXTINCTION_EVIDENCE_STATUSES = new Set(["observed", "inferred", "hypothetical", "missing"]);
const DEEXTINCTION_FINDINGS = new Set(["supports", "contradicts", "inconclusive", "not-assessed"]);
const DEEXTINCTION_STATUS_COMPLETENESS = Object.freeze({ observed: 1, inferred: 0.6, hypothetical: 0.2, missing: 0 });
const DEEXTINCTION_CRITERIA = Object.freeze([
  { id: "authenticated-endogenous-dinosaur-dna", label: "Authenticated endogenous dinosaur DNA", group: "biological-gate", hardStop: true, passingStatuses: ["observed"] },
  { id: "species-level-nuclear-genome-and-karyotype", label: "Species-level nuclear genome and karyotype", group: "biological-gate", hardStop: true, passingStatuses: ["observed"] },
  { id: "viable-cell-or-nucleus", label: "Viable cell or nucleus", group: "biological-gate", hardStop: true, passingStatuses: ["observed"] },
  { id: "validated-avian-embryo-surrogate-platform", label: "Validated avian embryo and surrogate platform", group: "biological-gate", hardStop: true, passingStatuses: ["observed"] },
  { id: "target-taxonomy-and-specimen-identity", label: "Target taxonomy and specimen identity", group: "soft-researchability", hardStop: false, passingStatuses: [] },
  { id: "version-pinned-extant-relative-genomes", label: "Version-pinned extant-relative reference assembly manifests", group: "soft-researchability", hardStop: false, passingStatuses: [] },
  { id: "orthology-alignment-species-tree", label: "Orthology map, alignment, and species tree", group: "soft-researchability", hardStop: false, passingStatuses: [] },
  { id: "ancestral-state-uncertainty", label: "Ancestral-state uncertainty and robustness", group: "soft-researchability", hardStop: false, passingStatuses: [] },
  { id: "regulatory-chromosomal-research-model", label: "Regulatory and chromosomal research model", group: "soft-researchability", hardStop: false, passingStatuses: [] },
  { id: "pbdb-fossil-occurrence-coverage", label: "PBDB fossil-occurrence coverage", group: "soft-researchability", hardStop: false, passingStatuses: [] },
]);
const DEEXTINCTION_CRITERION_BY_ID = new Map(DEEXTINCTION_CRITERIA.map((criterion) => [criterion.id, criterion]));

function deextinctionEvidence(value) {
  const evidence = plainObject(value, "paleontology-feasibility-evidence-invalid");
  exactKeys(evidence, ["criterionId", "evidenceStatus", "finding", "sourceRunIds", "detail"], "paleontology-feasibility-evidence-unknown-field");
  const criterionId = requiredText(evidence.criterionId, 120, "paleontology-feasibility-criterion-invalid");
  if (!DEEXTINCTION_CRITERION_BY_ID.has(criterionId)) throw new Error("paleontology-feasibility-criterion-invalid");
  if (!DEEXTINCTION_EVIDENCE_STATUSES.has(evidence.evidenceStatus)) throw new Error("paleontology-feasibility-evidence-status-invalid");
  if (!DEEXTINCTION_FINDINGS.has(evidence.finding)) throw new Error("paleontology-feasibility-finding-invalid");
  if ((evidence.evidenceStatus === "missing") !== (evidence.finding === "not-assessed")) throw new Error("paleontology-feasibility-missing-state-invalid");
  if (!Array.isArray(evidence.sourceRunIds) || evidence.sourceRunIds.length > 20) throw new Error("paleontology-feasibility-source-runs-invalid");
  const sourceRunIds = evidence.sourceRunIds.map((runId) => requiredText(runId, 160, "paleontology-feasibility-source-runs-invalid"));
  if (new Set(sourceRunIds).size !== sourceRunIds.length) throw new Error("paleontology-feasibility-source-runs-duplicate");
  if (evidence.evidenceStatus === "missing" ? sourceRunIds.length !== 0 : sourceRunIds.length < 1) throw new Error("paleontology-feasibility-source-runs-invalid");
  return {
    criterionId,
    evidenceStatus: evidence.evidenceStatus,
    finding: evidence.finding,
    sourceRunIds: sourceRunIds.sort(),
    detail: requiredText(evidence.detail, 2_000, "paleontology-feasibility-detail-invalid"),
  };
}

/**
 * Audit multiple biological-resurrection candidates against a fixed evidence
 * gate.  This deliberately does not produce a resurrection probability or a
 * dinosaur genome.  PBDB coverage is excluded from gates, completeness, and
 * audit ordering, so it cannot increase apparent biological feasibility.
 */
function assessDeextinctionFeasibility(value) {
  const input = plainObject(value, "paleontology-feasibility-input-invalid");
  exactKeys(input, ["title", "targetObjective", "candidates"], "paleontology-feasibility-input-unknown-field");
  const title = requiredText(input.title, 240, "paleontology-feasibility-title-invalid");
  if (!DEEXTINCTION_OBJECTIVES.has(input.targetObjective)) throw new Error("paleontology-feasibility-target-objective-invalid");
  if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > 50) throw new Error("paleontology-feasibility-candidates-invalid");
  const objectiveCriteria = DEEXTINCTION_CRITERIA.filter((criterion) => input.targetObjective === "actual-biological-revival" || criterion.group === "soft-researchability");
  const softCriteria = DEEXTINCTION_CRITERIA.filter((criterion) => criterion.group === "soft-researchability" && criterion.id !== "pbdb-fossil-occurrence-coverage");

  const candidateIds = new Set();
  const candidates = input.candidates.map((rawCandidate) => {
    const candidate = plainObject(rawCandidate, "paleontology-feasibility-candidate-invalid");
    exactKeys(candidate, ["candidateId", "taxonName", "label", "evidence"], "paleontology-feasibility-candidate-unknown-field");
    const candidateId = requiredText(candidate.candidateId, 120, "paleontology-feasibility-candidate-id-invalid");
    if (candidateIds.has(candidateId)) throw new Error("paleontology-feasibility-candidate-id-duplicate");
    candidateIds.add(candidateId);
    const taxonName = exactTaxonName(candidate.taxonName);
    const label = requiredText(candidate.label, 240, "paleontology-feasibility-candidate-label-invalid");
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length !== objectiveCriteria.length) throw new Error("paleontology-feasibility-evidence-set-invalid");
    const evidenceByCriterion = new Map();
    for (const rawEvidence of candidate.evidence) {
      const evidence = deextinctionEvidence(rawEvidence);
      if (evidenceByCriterion.has(evidence.criterionId)) throw new Error("paleontology-feasibility-criterion-duplicate");
      evidenceByCriterion.set(evidence.criterionId, evidence);
    }
    if (objectiveCriteria.some((criterion) => !evidenceByCriterion.has(criterion.id))
      || [...evidenceByCriterion.keys()].some((criterionId) => !objectiveCriteria.some((criterion) => criterion.id === criterionId))) {
      throw new Error("paleontology-feasibility-evidence-set-invalid");
    }

    const evidenceRows = objectiveCriteria.map((criterion) => {
      const evidence = evidenceByCriterion.get(criterion.id);
      const gatePassed = !criterion.hardStop || (evidence.finding === "supports" && criterion.passingStatuses.includes(evidence.evidenceStatus));
      return {
        criterionId: criterion.id,
        label: criterion.label,
        group: criterion.group,
        evidenceStatus: evidence.evidenceStatus,
        finding: evidence.finding,
        sourceRunIds: evidence.sourceRunIds,
        detail: evidence.detail,
        hardStop: criterion.hardStop,
        gatePassed,
      };
    });
    const fossilCoverage = evidenceRows.find((row) => row.criterionId === "pbdb-fossil-occurrence-coverage");
    if (!fossilCoverage || fossilCoverage.group !== "soft-researchability" || fossilCoverage.hardStop !== false) throw new Error("paleontology-feasibility-fossil-coverage-invariant-failed");
    const hardStops = evidenceRows.filter((row) => row.hardStop && !row.gatePassed).map((row) => ({ criterionId: row.criterionId, evidenceStatus: row.evidenceStatus, finding: row.finding }));
    const softEvidenceRows = softCriteria.map((criterion) => evidenceByCriterion.get(criterion.id));
    const researchEvidenceCompletenessPercent = rounded(softEvidenceRows.reduce((sum, evidence) => sum + DEEXTINCTION_STATUS_COMPLETENESS[evidence.evidenceStatus], 0) / softEvidenceRows.length * 100, 2);
    const evidenceStatusCounts = Object.fromEntries(["observed", "inferred", "hypothetical", "missing"].map((status) => [status, softEvidenceRows.filter((evidence) => evidence.evidenceStatus === status).length]));
    const biologicalGateDecision = input.targetObjective === "comparative-proxy-research"
      ? "not-assessed-different-objective"
      : hardStops.length ? "stopped" : "evidence-gates-satisfied-pending-expert-review";
    return {
      candidateId,
      taxonName,
      label,
      biologicalGateDecision,
      hardStopCount: hardStops.length,
      hardStops,
      softResearchability: { researchEvidenceCompletenessPercent, evidenceStatusCounts, pbdbCoverageExcludedFromCompleteness: true },
      fossilCoverage: { evidenceStatus: fossilCoverage.evidenceStatus, finding: fossilCoverage.finding, biologicalFeasibilityContribution: 0 },
      evidenceRows,
    };
  });

  candidates.sort((left, right) => {
    const leftStopped = left.biologicalGateDecision === "stopped" ? 1 : 0;
    const rightStopped = right.biologicalGateDecision === "stopped" ? 1 : 0;
    return leftStopped - rightStopped
      || left.hardStopCount - right.hardStopCount
      || right.softResearchability.researchEvidenceCompletenessPercent - left.softResearchability.researchEvidenceCompletenessPercent
      || left.candidateId.localeCompare(right.candidateId);
  });
  const rankedCandidates = candidates.map((candidate, index) => ({ auditOrder: index + 1, ...candidate }));
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${title}: evidence-gate audit`,
    columns: [
      { id: "auditOrder", label: "Audit order", type: "integer", unit: null },
      { id: "candidateId", label: "Candidate ID", type: "string", unit: null },
      { id: "taxonName", label: "Taxon", type: "string", unit: null },
      { id: "biologicalGateDecision", label: "Biological gate decision", type: "string", unit: null },
      { id: "hardStopCount", label: "Hard stops", type: "integer", unit: null },
      { id: "hardStopCriteria", label: "Failed required stages", type: "string", unit: null },
      { id: "researchEvidenceCompletenessPercent", label: "Soft research-evidence completeness", type: "number", unit: "%" },
      { id: "fossilCoverageStatus", label: "PBDB coverage status", type: "string", unit: null },
      { id: "fossilCoverageContribution", label: "PBDB biological-feasibility contribution", type: "number", unit: "fixed zero" },
    ],
    rows: rankedCandidates.map((candidate) => [
      candidate.auditOrder,
      candidate.candidateId,
      candidate.taxonName,
      candidate.biologicalGateDecision,
      candidate.hardStopCount,
      candidate.hardStops.map((stop) => stop.criterionId).join("; ") || null,
      candidate.softResearchability.researchEvidenceCompletenessPercent,
      `${candidate.fossilCoverage.evidenceStatus}/${candidate.fossilCoverage.finding}`,
      0,
    ]),
    notes: [
      "For actual biological revival, audit order is determined by the four biological hard stops first, then soft research-evidence completeness; it is not a probability or viability ranking.",
      "Soft researchability is reported separately and never contributes to a biological-feasibility score; this method emits no biological-feasibility score.",
      "PBDB fossil-occurrence coverage is displayed for research provenance but is excluded from completeness, audit ordering, and biological feasibility.",
      "Evidence-gates-satisfied-pending-expert-review is not evidence that a dinosaur genome exists or that embryo development, hatching, or biological revival is feasible.",
    ],
  };
  const figureValues = rankedCandidates.map((candidate) => ({
    auditOrder: candidate.auditOrder,
    candidate: `${candidate.label} · ${candidate.candidateId}`,
    researchEvidenceCompletenessPercent: candidate.softResearchability.researchEvidenceCompletenessPercent,
    hardStopCount: candidate.hardStopCount,
    biologicalGateDecision: candidate.biologicalGateDecision,
    fossilCoverageContribution: 0,
    stopLabel: input.targetObjective === "actual-biological-revival" ? `${candidate.hardStopCount} stop(s)` : "biological gate not assessed",
    tooltip: `${candidate.label}: ${candidate.hardStopCount} hard stop(s); ${candidate.softResearchability.researchEvidenceCompletenessPercent}% soft research evidence; PBDB biological contribution 0`,
  }));
  const spec = {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: 700,
    height: Math.max(220, Math.min(1_000, figureValues.length * 44)),
    padding: { left: 180, right: 90, top: 62, bottom: 52 },
    title: { text: title, subtitle: "Soft research evidence only; no biological-feasibility score", anchor: "start", fontSize: 16, subtitleFontSize: 11 },
    data: [{ name: "candidates", values: figureValues }],
    scales: [
      { name: "x", type: "linear", domain: [0, 100], range: "width", nice: false, zero: true },
      { name: "y", type: "band", domain: { data: "candidates", field: "candidate", sort: { field: "auditOrder", order: "ascending" } }, range: "height", padding: 0.3 },
      { name: "decisionColor", type: "ordinal", domain: ["evidence-gates-satisfied-pending-expert-review", "stopped", "not-assessed-different-objective"], range: ["#39765A", "#A44B43", "#6B7180"] },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "Soft research-evidence completeness (%)", grid: true, tickCount: 6 },
      { orient: "left", scale: "y", title: null, labelLimit: 170, tickSize: 0 },
    ],
    marks: [
      { type: "rect", from: { data: "candidates" }, encode: { enter: { x: { scale: "x", value: 0 }, x2: { scale: "x", field: "researchEvidenceCompletenessPercent" }, y: { scale: "y", field: "candidate" }, height: { scale: "y", band: 1 }, fill: { scale: "decisionColor", field: "biologicalGateDecision" }, cornerRadius: { value: 3 }, tooltip: { field: "tooltip" } } } },
      { type: "text", from: { data: "candidates" }, encode: { enter: { x: { scale: "x", field: "researchEvidenceCompletenessPercent", offset: 8 }, y: { scale: "y", field: "candidate", band: 0.5 }, baseline: { value: "middle" }, text: { field: "stopLabel" }, fill: { value: "#5D5954" }, fontSize: { value: 11 } } } },
    ],
  };
  const contentReceipts = { publicationTable: publicationTableReceipt(publicationTable), figure: figureReceipt(spec) };
  const core = {
    schema: "agentlas.paleontology-deextinction-feasibility/v1",
    methodRevision: "fixed-evidence-gate-audit/v1",
    title,
    targetObjective: input.targetObjective,
    rankingSemantics: input.targetObjective === "actual-biological-revival" ? "four-hard-stops-first-then-soft-researchability-not-biological-feasibility" : "soft-researchability-only-biological-gate-not-assessed",
    criterionPolicy: DEEXTINCTION_CRITERIA.map((criterion) => ({ ...criterion })),
    candidates: rankedCandidates,
    publicationTable,
    spec,
    contentReceipts,
    evidenceBoundary: {
      evidenceStatuses: ["observed", "inferred", "hypothetical", "missing"],
      biologicalFeasibilityScoreEmitted: false,
      pbdbFossilCoverageBiologicalFeasibilityContribution: 0,
      prohibitedClaims: ["recovered-dinosaur-dna", "dinosaur-genome", "reconstructed-dinosaur-genome", "viable-dinosaur-embryo", "dinosaur-hatching", "biological-resurrection-achieved"],
    },
    assumptions: [
      "Input evidence classifications are accepted only when the host has verified their exact bindings to sealed source ResearchRuns; the Research Director must independently review those bindings.",
      "For actual biological revival, observed supporting evidence is required for each of exactly four biological hard stops: endogenous dinosaur DNA, species-level nuclear genome and karyotype, viable cell or nucleus, and a validated avian embryo-surrogate platform.",
    ],
    warnings: [
      "This deterministic audit does not retrieve dinosaur DNA, reconstruct a dinosaur genome, model an embryo, predict hatching, or establish that biological revival is feasible.",
      "Comparative proxy research is a different objective and its audit output cannot be compared with actual biological revival as if they shared a feasibility scale.",
      "No candidate is labelled viable. Passing all four evidence gates permits only expert review.",
    ],
  };
  return { ...core, deterministicHash: sha256(stableStringify(core)) };
}

/**
 * Derive stratigraphic support from an already sealed PBDB catalog.  This is an
 * interval analysis: maxMa/minMa are preserved as bounds and no midpoint is
 * treated as an observation or estimate.
 */
function analyzeStratigraphicEvidence(value) {
  const input = plainObject(value, "paleontology-analysis-input-invalid");
  exactKeys(input, ["catalog"], "paleontology-analysis-input-invalid");
  const catalog = plainObject(input.catalog, "paleontology-analysis-catalog-invalid");
  if (catalog.schema !== "agentlas.paleontology-catalog-result/v1" || catalog.provider !== "pbdb-data1.2") throw new Error("paleontology-analysis-catalog-schema-invalid");
  const runId = requiredText(catalog.runId, 80, "paleontology-analysis-parent-run-invalid");
  const taxon = plainObject(catalog.taxon, "paleontology-analysis-taxon-invalid");
  const taxonName = requiredText(taxon.acceptedName, 500, "paleontology-analysis-taxon-invalid");
  const acceptedTaxonId = requiredText(taxon.acceptedTaxonId, 80, "paleontology-analysis-taxon-invalid");
  const taxonRank = optionalText(taxon.rank, 80, "paleontology-analysis-taxon-invalid");
  const exactLeafTaxon = taxonRank === "species" || taxonRank === "subspecies";
  exactSha(taxon.providerRecordSha256, "paleontology-analysis-taxon-receipt-invalid");
  const evidenceBoundary = plainObject(catalog.evidenceBoundary, "paleontology-analysis-evidence-boundary-invalid");
  if (evidenceBoundary.observed !== "fossil-occurrence-and-taxonomic-metadata" || evidenceBoundary.molecularEvidence !== "none"
    || !Array.isArray(evidenceBoundary.prohibitedInference)
    || !["direct-dna", "genome-sequence", "reconstructed-genome"].every((entry) => evidenceBoundary.prohibitedInference.includes(entry))) {
    throw new Error("paleontology-analysis-evidence-boundary-invalid");
  }
  const pagination = plainObject(catalog.pagination, "paleontology-analysis-pagination-invalid");
  if (!Array.isArray(catalog.occurrences) || catalog.occurrences.length < 1 || catalog.occurrences.length > 2_000
    || integer(pagination.recordsReturned, 0, 2_000, "paleontology-analysis-pagination-invalid") !== catalog.occurrences.length) {
    throw new Error("paleontology-analysis-occurrences-invalid");
  }

  const seen = new Set();
  const rows = catalog.occurrences.map((raw, ordinal) => {
    const occurrence = plainObject(raw, "paleontology-analysis-occurrence-invalid");
    const occurrenceId = requiredText(occurrence.occurrenceId, 80, "paleontology-analysis-occurrence-invalid");
    if (seen.has(occurrenceId)) throw new Error("paleontology-analysis-occurrence-duplicate");
    seen.add(occurrenceId);
    const occurrenceAcceptedTaxonId = requiredText(occurrence.acceptedTaxonId, 80, "paleontology-analysis-occurrence-invalid");
    const occurrenceAcceptedName = requiredText(occurrence.acceptedName, 500, "paleontology-analysis-occurrence-invalid");
    if (exactLeafTaxon && (occurrenceAcceptedTaxonId !== acceptedTaxonId || occurrenceAcceptedName !== taxonName)) {
      throw new Error("paleontology-analysis-taxon-drift");
    }
    exactSha(occurrence.providerRecordSha256, "paleontology-analysis-occurrence-receipt-invalid");
    const age = plainObject(occurrence.age, "paleontology-analysis-age-invalid");
    const maxMa = finite(age.maxMa, 0, 5_000, "paleontology-analysis-age-invalid");
    const minMa = finite(age.minMa, 0, 5_000, "paleontology-analysis-age-invalid");
    if (maxMa < minMa || age.isPointEstimate !== false) throw new Error("paleontology-analysis-age-invalid");
    const widthMa = rounded(maxMa - minMa);
    if (Math.abs(finite(age.midpointMa, 0, 5_000, "paleontology-analysis-age-invalid") - ((maxMa + minMa) / 2)) > 1e-9
      || Math.abs(finite(age.halfRangeMa, 0, 2_500, "paleontology-analysis-age-invalid") - ((maxMa - minMa) / 2)) > 1e-9) {
      throw new Error("paleontology-analysis-age-summary-invalid");
    }
    const stratigraphy = plainObject(occurrence.stratigraphy, "paleontology-analysis-stratigraphy-invalid");
    const coordinates = occurrence.coordinates === null ? null : plainObject(occurrence.coordinates, "paleontology-analysis-coordinates-invalid");
    const longitude = coordinates === null ? null : finite(coordinates.longitude, -180, 180, "paleontology-analysis-coordinates-invalid");
    const latitude = coordinates === null ? null : finite(coordinates.latitude, -90, 90, "paleontology-analysis-coordinates-invalid");
    const formation = optionalText(stratigraphy.formation, 240, "paleontology-analysis-stratigraphy-invalid");
    const member = optionalText(stratigraphy.member, 240, "paleontology-analysis-stratigraphy-invalid");
    const group = optionalText(stratigraphy.group, 240, "paleontology-analysis-stratigraphy-invalid");
    const earlyInterval = optionalText(stratigraphy.earlyInterval, 240, "paleontology-analysis-stratigraphy-invalid");
    const lateInterval = optionalText(stratigraphy.lateInterval, 240, "paleontology-analysis-stratigraphy-invalid");
    const state = optionalText(occurrence.state, 240, "paleontology-analysis-location-invalid");
    const countryCode = optionalText(occurrence.countryCode, 8, "paleontology-analysis-location-invalid");
    return {
      ordinal: ordinal + 1,
      occurrenceId,
      collectionId: requiredText(occurrence.collectionId, 80, "paleontology-analysis-occurrence-invalid"),
      identifiedName: requiredText(occurrence.identifiedName, 500, "paleontology-analysis-occurrence-invalid"),
      acceptedTaxonId: occurrenceAcceptedTaxonId,
      acceptedName: occurrenceAcceptedName,
      maxMa,
      minMa,
      intervalWidthMa: widthMa,
      earlyInterval,
      lateInterval,
      group,
      formation,
      member,
      countryCode,
      state,
      longitude,
      latitude,
      evidenceClass: "stratigraphic-occurrence-support",
      molecularEvidence: "none",
      providerRecordSha256: occurrence.providerRecordSha256,
    };
  });

  rows.sort((left, right) => right.maxMa - left.maxMa || right.minMa - left.minMa || left.occurrenceId.localeCompare(right.occurrenceId));
  const formationMap = new Map();
  for (const row of rows) {
    const key = stableStringify([row.group, row.formation, row.member]);
    const current = formationMap.get(key) ?? { group: row.group, formation: row.formation, member: row.member, occurrenceCount: 0, oldestBoundMa: -Infinity, youngestBoundMa: Infinity, widths: [] };
    current.occurrenceCount += 1;
    current.oldestBoundMa = Math.max(current.oldestBoundMa, row.maxMa);
    current.youngestBoundMa = Math.min(current.youngestBoundMa, row.minMa);
    current.widths.push(row.intervalWidthMa);
    formationMap.set(key, current);
  }
  const formationSummary = [...formationMap.values()].map((entry) => ({
    group: entry.group,
    formation: entry.formation,
    member: entry.member,
    occurrenceCount: entry.occurrenceCount,
    oldestBoundMa: rounded(entry.oldestBoundMa),
    youngestBoundMa: rounded(entry.youngestBoundMa),
    medianOccurrenceIntervalWidthMa: rounded(median(entry.widths)),
  })).sort((left, right) => right.occurrenceCount - left.occurrenceCount || String(left.formation ?? "").localeCompare(String(right.formation ?? "")));

  const columns = [
    { id: "occurrenceId", label: "PBDB occurrence", type: "string", unit: null },
    { id: "collectionId", label: "PBDB collection", type: "string", unit: null },
    { id: "identifiedName", label: "Identified taxon", type: "string", unit: null },
    { id: "acceptedTaxonId", label: "Accepted PBDB taxon", type: "string", unit: null },
    { id: "acceptedName", label: "Accepted taxon name", type: "string", unit: null },
    { id: "maxMa", label: "Older bound", type: "number", unit: "Ma" },
    { id: "minMa", label: "Younger bound", type: "number", unit: "Ma" },
    { id: "intervalWidthMa", label: "Interval width", type: "number", unit: "Myr" },
    { id: "earlyInterval", label: "Early interval", type: "string", unit: null },
    { id: "lateInterval", label: "Late interval", type: "string", unit: null },
    { id: "group", label: "Group", type: "string", unit: null },
    { id: "formation", label: "Formation", type: "string", unit: null },
    { id: "member", label: "Member", type: "string", unit: null },
    { id: "region", label: "Country / state", type: "string", unit: null },
    { id: "coordinates", label: "Longitude / latitude", type: "string", unit: null },
    { id: "evidenceClass", label: "Evidence class", type: "string", unit: null },
    { id: "molecularEvidence", label: "Molecular evidence", type: "string", unit: null },
  ];
  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${taxonName}: interval-bounded PBDB occurrences`,
    columns,
    rows: rows.map((row) => [
      row.occurrenceId, row.collectionId, row.identifiedName, row.acceptedTaxonId, row.acceptedName,
      row.maxMa, row.minMa, row.intervalWidthMa,
      row.earlyInterval, row.lateInterval, row.group, row.formation, row.member,
      [row.countryCode, row.state].filter(Boolean).join(" / ") || null,
      row.longitude === null ? null : `${row.longitude}, ${row.latitude}`,
      row.evidenceClass, row.molecularEvidence,
    ]),
    notes: [
      "Older and younger bounds are preserved from PBDB; neither bound nor their midpoint is treated as a dated point observation.",
      "Rows provide stratigraphic fossil-occurrence support only. Molecular evidence is none.",
      ...(pagination.truncated === true ? ["The parent catalog was bounded and truncated; this table is not a complete census of PBDB occurrences."] : []),
    ],
  };

  const figureLimit = 200;
  const figureRows = rows.slice(0, figureLimit).map((row) => ({
    occurrence: row.occurrenceId,
    label: `${row.occurrenceId} · ${row.formation ?? row.earlyInterval ?? "formation unreported"}`,
    olderBoundMa: row.maxMa,
    youngerBoundMa: row.minMa,
    formation: row.formation ?? "Formation unreported",
    tooltip: `${row.occurrenceId}: ${row.maxMa}–${row.minMa} Ma`,
  }));
  const spec = {
    $schema: "https://vega.github.io/schema/vega/v5.json",
    width: 760,
    height: Math.max(260, Math.min(1_200, figureRows.length * 18)),
    padding: { left: 150, right: 24, top: 44, bottom: 54 },
    title: { text: `${taxonName} fossil-occurrence age intervals`, subtitle: "PBDB bounds in Ma; bars are uncertainty/support intervals, not point estimates", fontSize: 16, subtitleFontSize: 11, anchor: "start" },
    data: [{ name: "occurrences", values: figureRows }],
    scales: [
      { name: "x", type: "linear", domain: { data: "occurrences", fields: ["youngerBoundMa", "olderBoundMa"] }, range: "width", reverse: true, nice: true, zero: false },
      { name: "y", type: "band", domain: { data: "occurrences", field: "label" }, range: "height", padding: 0.28 },
      { name: "color", type: "ordinal", domain: { data: "occurrences", field: "formation" }, range: { scheme: "tableau10" } },
    ],
    axes: [
      { orient: "bottom", scale: "x", title: "Age before present (Ma; older to left)", grid: true, tickCount: 8 },
      { orient: "left", scale: "y", title: null, labelLimit: 145, tickSize: 0 },
    ],
    legends: [{ fill: "color", title: "Formation", orient: "right", labelLimit: 180 }],
    marks: [{
      type: "rect",
      from: { data: "occurrences" },
      encode: {
        enter: {
          x: { scale: "x", field: "olderBoundMa" },
          x2: { scale: "x", field: "youngerBoundMa" },
          y: { scale: "y", field: "label" },
          height: { scale: "y", band: 1 },
          fill: { scale: "color", field: "formation" },
          cornerRadius: { value: 2 },
          tooltip: { field: "tooltip" },
        },
      },
    }],
  };
  const estimates = {
    occurrenceCount: rows.length,
    georeferencedCount: rows.filter((row) => row.longitude !== null).length,
    formationCount: new Set(rows.map((row) => row.formation).filter(Boolean)).size,
    intervalNameCount: new Set(rows.flatMap((row) => [row.earlyInterval, row.lateInterval]).filter(Boolean)).size,
    oldestBoundMa: rounded(Math.max(...rows.map((row) => row.maxMa))),
    youngestBoundMa: rounded(Math.min(...rows.map((row) => row.minMa))),
    medianIntervalWidthMa: rounded(median(rows.map((row) => row.intervalWidthMa))),
    figureOccurrenceCount: figureRows.length,
    figureOmittedCount: rows.length - figureRows.length,
  };
  const contentReceipts = { publicationTable: publicationTableReceipt(publicationTable), figure: figureReceipt(spec) };
  const core = {
    schema: "agentlas.paleontology-stratigraphic-analysis/v1",
    methodRevision: "interval-preserving-stratigraphic-support/v1",
    source: { parentRunId: runId, provider: "pbdb-data1.2", taxonName, acceptedTaxonId, parentTruncated: pagination.truncated === true },
    estimates,
    formationSummary,
    publicationTable,
    spec,
    contentReceipts,
    evidenceBoundary: { evidenceClass: "stratigraphic-occurrence-support", molecularEvidence: "none", pointEstimateUsed: false },
    assumptions: ["PBDB occurrence ages are treated as reported stratigraphic bounds.", "Occurrences are not reweighted for sampling intensity, publication intensity, or collection effort."],
    warnings: [
      "This analysis supports fossil occurrence and stratigraphic statements only; it does not support DNA, genome reconstruction, embryo viability, hatching, or de-extinction claims.",
      ...(pagination.truncated === true ? ["The bounded parent catalog is truncated; counts and formation coverage are descriptive only."] : []),
      ...(rows.length > figureLimit ? [`The figure displays ${figureLimit} of ${rows.length} exact rows; the publication table retains every retrieved row.`] : []),
    ],
  };
  return { ...core, analysisSha256: sha256(stableStringify(core)) };
}

function assertExactComparisonCatalog(catalog) {
  exactKeys(catalog, ["schema", "provider", "title", "taxon", "occurrences", "pagination", "receipt", "sources", "warnings", "evidenceBoundary", "runId", "replayed"], "paleontology-candidate-comparison-catalog-unknown-field");
  const taxon = plainObject(catalog.taxon, "paleontology-candidate-comparison-taxon-invalid");
  exactKeys(taxon, ["taxonId", "acceptedTaxonId", "name", "acceptedName", "rank", "parentTaxonId", "parentName", "isExtant", "occurrenceCount", "firstAppearance", "lastAppearance", "classification", "providerRecordSha256"], "paleontology-candidate-comparison-taxon-unknown-field");
  for (const appearance of [taxon.firstAppearance, taxon.lastAppearance]) {
    exactKeys(plainObject(appearance, "paleontology-candidate-comparison-appearance-invalid"), ["maxMa", "minMa"], "paleontology-candidate-comparison-appearance-unknown-field");
  }
  exactKeys(plainObject(taxon.classification, "paleontology-candidate-comparison-classification-invalid"), ["phylum", "class", "order", "family", "genus"], "paleontology-candidate-comparison-classification-unknown-field");
  for (const rawOccurrence of catalog.occurrences ?? []) {
    const occurrence = plainObject(rawOccurrence, "paleontology-candidate-comparison-occurrence-invalid");
    exactKeys(occurrence, ["occurrenceId", "collectionId", "identifiedName", "acceptedName", "acceptedTaxonId", "classification", "age", "stratigraphy", "coordinates", "countryCode", "state", "primaryReference", "providerRecordSha256"], "paleontology-candidate-comparison-occurrence-unknown-field");
    exactKeys(plainObject(occurrence.classification, "paleontology-candidate-comparison-classification-invalid"), ["phylum", "class", "order", "family", "genus"], "paleontology-candidate-comparison-classification-unknown-field");
    exactKeys(plainObject(occurrence.age, "paleontology-candidate-comparison-age-invalid"), ["maxMa", "minMa", "midpointMa", "halfRangeMa", "isPointEstimate"], "paleontology-candidate-comparison-age-unknown-field");
    exactKeys(plainObject(occurrence.stratigraphy, "paleontology-candidate-comparison-stratigraphy-invalid"), ["earlyInterval", "lateInterval", "group", "formation", "member"], "paleontology-candidate-comparison-stratigraphy-unknown-field");
    if (occurrence.coordinates !== null) {
      exactKeys(plainObject(occurrence.coordinates, "paleontology-candidate-comparison-coordinates-invalid"), ["longitude", "latitude", "basis", "precision"], "paleontology-candidate-comparison-coordinates-unknown-field");
    }
  }
  exactKeys(plainObject(catalog.pagination, "paleontology-candidate-comparison-pagination-invalid"), ["pageSize", "maxPages", "maxRecords", "pagesFetched", "recordsAvailable", "recordsReturned", "truncated"], "paleontology-candidate-comparison-pagination-unknown-field");
  const receipt = plainObject(catalog.receipt, "paleontology-candidate-comparison-catalog-receipt-invalid");
  exactKeys(receipt, ["taxonResponseSha256", "occurrencePages"], "paleontology-candidate-comparison-catalog-receipt-unknown-field");
  exactSha(receipt.taxonResponseSha256, "paleontology-candidate-comparison-catalog-receipt-invalid");
  if (!Array.isArray(receipt.occurrencePages) || receipt.occurrencePages.length < 1 || receipt.occurrencePages.length > 20) {
    throw new Error("paleontology-candidate-comparison-catalog-receipt-invalid");
  }
  for (const rawPage of receipt.occurrencePages) {
    const page = plainObject(rawPage, "paleontology-candidate-comparison-catalog-receipt-invalid");
    exactKeys(page, ["offset", "responseSha256", "rowCount"], "paleontology-candidate-comparison-catalog-receipt-unknown-field");
    integer(page.offset, 0, 100_000, "paleontology-candidate-comparison-catalog-receipt-invalid");
    exactSha(page.responseSha256, "paleontology-candidate-comparison-catalog-receipt-invalid");
    integer(page.rowCount, 0, 100, "paleontology-candidate-comparison-catalog-receipt-invalid");
  }
  if (!Array.isArray(catalog.sources) || catalog.sources.length < 2 || catalog.sources.length > 21) {
    throw new Error("paleontology-candidate-comparison-catalog-sources-invalid");
  }
  for (const rawSource of catalog.sources) {
    const source = plainObject(rawSource, "paleontology-candidate-comparison-catalog-source-invalid");
    exactKeys(source, ["role", "pageIndex", "sourceId", "sourceVersionId", "responseSha256"], "paleontology-candidate-comparison-catalog-source-unknown-field");
    if (!["taxon-response", "occurrence-page"].includes(source.role)) throw new Error("paleontology-candidate-comparison-catalog-source-invalid");
    if (source.role === "occurrence-page") integer(source.pageIndex, 0, 19, "paleontology-candidate-comparison-catalog-source-invalid");
    else if (source.pageIndex !== undefined) throw new Error("paleontology-candidate-comparison-catalog-source-invalid");
    requiredText(source.sourceId, 160, "paleontology-candidate-comparison-catalog-source-invalid");
    requiredText(source.sourceVersionId, 160, "paleontology-candidate-comparison-catalog-source-invalid");
    exactSha(source.responseSha256, "paleontology-candidate-comparison-catalog-source-invalid");
  }
  exactKeys(plainObject(catalog.evidenceBoundary, "paleontology-candidate-comparison-evidence-boundary-invalid"), ["observed", "molecularEvidence", "prohibitedInference"], "paleontology-candidate-comparison-evidence-boundary-unknown-field");
}

/**
 * Compare exact PBDB catalog + deterministic stratigraphic-analysis pairs.
 * The comparator accepts no score or rank from the caller.  Every metric is
 * re-derived from the catalogs, and each supplied analysis must be byte-for-
 * byte equivalent under stable JSON serialization to a fresh deterministic
 * analysis of its paired catalog.
 */
function compareFossilCandidateEvidence(value) {
  const input = plainObject(value, "paleontology-candidate-comparison-input-invalid");
  exactKeys(input, ["title", "candidates"], "paleontology-candidate-comparison-input-unknown-field");
  const title = requiredText(input.title, 240, "paleontology-candidate-comparison-title-invalid");
  if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > 20) {
    throw new Error("paleontology-candidate-comparison-candidates-invalid");
  }
  const catalogRunIds = new Set();
  const stratigraphicRunIds = new Set();
  const analysisHashes = new Set();
  const acceptedTaxonIds = new Set();
  const coverage = (reported, total) => ({ reported, missing: total - reported, percent: rounded(reported / total * 100, 2) });
  const derivedCandidates = input.candidates.map((rawCandidate, index) => {
    const candidate = plainObject(rawCandidate, "paleontology-candidate-comparison-candidate-invalid");
    exactKeys(candidate, ["catalogRunId", "stratigraphicRunId", "catalog", "stratigraphicAnalysis"], "paleontology-candidate-comparison-candidate-unknown-field");
    const catalogRunId = requiredText(candidate.catalogRunId, 80, "paleontology-candidate-comparison-parent-run-invalid");
    const stratigraphicRunId = requiredText(candidate.stratigraphicRunId, 80, "paleontology-candidate-comparison-parent-run-invalid");
    if (catalogRunIds.has(catalogRunId) || stratigraphicRunIds.has(stratigraphicRunId)) {
      throw new Error("paleontology-candidate-comparison-parent-run-duplicate");
    }
    catalogRunIds.add(catalogRunId);
    stratigraphicRunIds.add(stratigraphicRunId);
    const catalog = plainObject(candidate.catalog, "paleontology-candidate-comparison-catalog-invalid");
    assertExactComparisonCatalog(catalog);
    const suppliedAnalysis = plainObject(candidate.stratigraphicAnalysis, "paleontology-candidate-comparison-analysis-invalid");
    const derivedAnalysis = analyzeStratigraphicEvidence({ catalog });
    if (stableStringify(suppliedAnalysis) !== stableStringify(derivedAnalysis)) {
      throw new Error("paleontology-candidate-comparison-analysis-mismatch");
    }
    if (catalog.runId !== catalogRunId || derivedAnalysis.source.parentRunId !== catalogRunId) {
      throw new Error("paleontology-candidate-comparison-parent-relation-invalid");
    }
    const analysisSha256 = exactSha(derivedAnalysis.analysisSha256, "paleontology-candidate-comparison-analysis-receipt-invalid");
    if (analysisHashes.has(analysisSha256)) throw new Error("paleontology-candidate-comparison-analysis-duplicate");
    analysisHashes.add(analysisSha256);
    const pagination = catalog.pagination;
    const recordsReturned = integer(pagination.recordsReturned, 1, 2_000, "paleontology-candidate-comparison-pagination-invalid");
    const recordsAvailable = integer(pagination.recordsAvailable, 0, Number.MAX_SAFE_INTEGER, "paleontology-candidate-comparison-pagination-invalid");
    if (recordsAvailable < recordsReturned
      || (pagination.truncated === true && recordsAvailable <= recordsReturned)
      || (pagination.truncated !== true && recordsAvailable !== recordsReturned)) {
      throw new Error("paleontology-candidate-comparison-pagination-invalid");
    }
    const taxon = catalog.taxon;
    const rank = optionalText(taxon.rank, 80, "paleontology-candidate-comparison-taxon-invalid");
    const leafTaxonResolved = rank === "species" || rank === "subspecies";
    const acceptedTaxonId = requiredText(taxon.acceptedTaxonId, 80, "paleontology-candidate-comparison-taxon-invalid");
    if (acceptedTaxonIds.has(acceptedTaxonId)) throw new Error("paleontology-candidate-comparison-taxon-duplicate");
    acceptedTaxonIds.add(acceptedTaxonId);
    const occurrenceWidths = catalog.occurrences.map((occurrence) => rounded(occurrence.age.maxMa - occurrence.age.minMa));
    const formationReported = catalog.occurrences.filter((occurrence) => occurrence.stratigraphy.formation !== null).length;
    const intervalReported = catalog.occurrences.filter((occurrence) => occurrence.stratigraphy.earlyInterval !== null || occurrence.stratigraphy.lateInterval !== null).length;
    const georeferenceReported = catalog.occurrences.filter((occurrence) => occurrence.coordinates !== null).length;
    const primaryReferenceReported = catalog.occurrences.filter((occurrence) => occurrence.primaryReference !== null).length;
    const formationCoverage = coverage(formationReported, recordsReturned);
    const intervalCoverage = coverage(intervalReported, recordsReturned);
    const georeferenceCoverage = coverage(georeferenceReported, recordsReturned);
    const primaryReferenceCoverage = coverage(primaryReferenceReported, recordsReturned);
    const missingCells = formationCoverage.missing + intervalCoverage.missing + georeferenceCoverage.missing + primaryReferenceCoverage.missing;
    const totalCells = recordsReturned * 4;
    const normalized = {
      candidateOrdinal: index + 1,
      acceptedTaxonId,
      acceptedName: requiredText(taxon.acceptedName, 500, "paleontology-candidate-comparison-taxon-invalid"),
      catalogRunId,
      stratigraphicRunId,
      occurrenceCount: derivedAnalysis.estimates.occurrenceCount,
      georeferencedCount: derivedAnalysis.estimates.georeferencedCount,
      formationCount: derivedAnalysis.estimates.formationCount,
      intervalNameCount: derivedAnalysis.estimates.intervalNameCount,
      oldestBoundMa: derivedAnalysis.estimates.oldestBoundMa,
      youngestBoundMa: derivedAnalysis.estimates.youngestBoundMa,
      medianIntervalWidthMa: derivedAnalysis.estimates.medianIntervalWidthMa,
      parentTruncated: pagination.truncated === true,
      evidenceClass: "stratigraphic-occurrence-support",
      molecularEvidence: "none",
    };
    const detail = {
      candidateOrdinal: index + 1,
      parent: {
        catalogRunId,
        stratigraphicRunId,
        catalogTaxonResponseSha256: exactSha(catalog.receipt.taxonResponseSha256, "paleontology-candidate-comparison-catalog-receipt-invalid"),
        stratigraphicAnalysisSha256: analysisSha256,
      },
      taxonomyResolution: {
        queriedName: requiredText(taxon.name, 500, "paleontology-candidate-comparison-taxon-invalid"),
        acceptedTaxonId,
        acceptedName: normalized.acceptedName,
        rank,
        queriedNameMatchesAcceptedName: taxon.name === taxon.acceptedName,
        leafTaxonResolved,
        qualifiedOccurrenceCount: catalog.occurrences.filter((occurrence) => /(?:^|\s)(?:cf|aff)\.|\?/iu.test(occurrence.identifiedName)).length,
      },
      occurrenceCoverage: { recordsReturned, recordsAvailable, truncated: pagination.truncated === true },
      fieldCoverage: { formation: formationCoverage, interval: intervalCoverage, georeference: georeferenceCoverage, primaryReference: primaryReferenceCoverage },
      temporalBounds: {
        oldestBoundMa: derivedAnalysis.estimates.oldestBoundMa,
        youngestBoundMa: derivedAnalysis.estimates.youngestBoundMa,
        intervalWidthMa: {
          minimum: rounded(Math.min(...occurrenceWidths)),
          median: rounded(median(occurrenceWidths)),
          maximum: rounded(Math.max(...occurrenceWidths)),
        },
        intervalsPreserved: true,
        pointEstimateUsed: false,
      },
      missingness: {
        fieldsAssessed: ["formation", "interval", "georeference", "primaryReference"],
        missingCells,
        totalCells,
        percent: rounded(missingCells / totalCells * 100, 2),
        nullsPreserved: true,
        imputedCells: 0,
      },
    };
    return { normalized, detail };
  });

  const normalizedMatrix = derivedCandidates.map((candidate) => candidate.normalized);
  const coverageDetails = derivedCandidates.map((candidate) => candidate.detail);
  const anyParentTruncated = normalizedMatrix.some((row) => row.parentTruncated);

  const publicationTable = {
    schema: "agentlas.science-table/v1",
    title: `${title}: fossil-candidate evidence matrix`,
    columns: [
      { id: "candidateOrdinal", label: "Candidate", type: "integer", unit: null },
      { id: "acceptedName", label: "Accepted taxon", type: "string", unit: null },
      { id: "rank", label: "Taxonomic rank", type: "string", unit: null },
      { id: "recordsReturned", label: "Occurrences returned", type: "integer", unit: null },
      { id: "recordsAvailable", label: "Occurrences available", type: "integer", unit: null },
      { id: "truncated", label: "Catalog truncated", type: "boolean", unit: null },
      { id: "formationCoverage", label: "Formation coverage", type: "number", unit: "%" },
      { id: "intervalCoverage", label: "Interval-name coverage", type: "number", unit: "%" },
      { id: "georeferenceCoverage", label: "Georeference coverage", type: "number", unit: "%" },
      { id: "primaryReferenceCoverage", label: "Primary-reference coverage", type: "number", unit: "%" },
      { id: "oldestBoundMa", label: "Oldest bound", type: "number", unit: "Ma" },
      { id: "youngestBoundMa", label: "Youngest bound", type: "number", unit: "Ma" },
      { id: "medianIntervalWidthMa", label: "Median occurrence interval width", type: "number", unit: "Myr" },
      { id: "missingness", label: "Selected-field missingness", type: "number", unit: "%" },
    ],
    rows: normalizedMatrix.map((row, index) => [
      row.candidateOrdinal, row.acceptedName, coverageDetails[index].taxonomyResolution.rank,
      coverageDetails[index].occurrenceCoverage.recordsReturned, coverageDetails[index].occurrenceCoverage.recordsAvailable,
      row.parentTruncated, coverageDetails[index].fieldCoverage.formation.percent,
      coverageDetails[index].fieldCoverage.interval.percent, coverageDetails[index].fieldCoverage.georeference.percent,
      coverageDetails[index].fieldCoverage.primaryReference.percent, row.oldestBoundMa, row.youngestBoundMa,
      row.medianIntervalWidthMa, coverageDetails[index].missingness.percent,
    ]),
    notes: [
      "This matrix compares fossil taxonomic, occurrence, stratigraphic, georeference, and cited-reference evidence only.",
      "Age bounds and null values are preserved; interval midpoints are not observations and missing cells are not imputed.",
      "The candidate ordinal preserves request order and is not a rank; this descriptive comparison produces no ranking.",
      ...(anyParentTruncated ? ["At least one bounded parent catalog is truncated; its counts and coverage are incomplete."] : []),
    ],
  };
  const contentReceipts = {
    normalizedMatrix: { sha256: sha256(stableStringify(normalizedMatrix)), mimeType: "application/json" },
    publicationTable: publicationTableReceipt(publicationTable),
  };
  const core = {
    schema: "agentlas.science.paleontology-candidate-comparison/v1",
    methodRevision: "exact-normalized-stratigraphic-matrix/v1",
    title,
    normalizedMatrix,
    coverageDetails,
    ranking: { status: "not-produced", reason: anyParentTruncated ? "truncated-parent-evidence" : "descriptive-comparison-only" },
    publicationTable,
    contentReceipts,
    evidenceBoundary: {
      claimScope: "fossil-taxonomic-occurrence-stratigraphic-evidence-only",
      biologicalFeasibilityAssessed: false,
      callerScoreAccepted: false,
      nullsImputed: false,
      pointEstimateUsed: false,
      excludedClaims: ["revival-probability", "biological-feasibility", "dna", "genome", "embryo", "hatching"],
    },
    assumptions: [
      "Each catalog and stratigraphic analysis is host-verified against exact sealed ResearchRun outputs before this plugin function is called.",
      "Coverage describes only the bounded provider result and does not correct for sampling, collection, or publication intensity.",
    ],
    warnings: [
      "This comparison cannot establish revival probability or biological feasibility and supplies no molecular, developmental, or hatching evidence.",
      ...(anyParentTruncated ? ["At least one catalog is truncated; this descriptive matrix does not treat incomplete counts as comparable ranks."] : []),
    ],
  };
  return { ...core, comparisonSha256: sha256(stableStringify(core)) };
}
function describeCapabilities(input = {}) {
  const request = plainObject(input, "paleontology-capabilities-input-invalid");
  exactKeys(request, [], "paleontology-capabilities-input-unknown-field");
  return require("../capabilities.json");
}
module.exports = { PLUGIN_VERSION, PBDB_ENDPOINT, USER_AGENT, sha256, stableStringify, buildTaxonUrl, buildOccurrencesUrl, analyzeStratigraphicEvidence, compareFossilCandidateEvidence, assessDeextinctionFeasibility, describeCapabilities };
