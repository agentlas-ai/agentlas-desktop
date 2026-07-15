import { randomUUID } from "node:crypto";
import type {
  McpInvocationEvent,
  RuntimeStatus,
} from "../../shared/types";
import { callServerTool } from "../mcp-tools/client";
import { listInstalledServers } from "../mcp-tools/registry";
import type { BorrowedAgentSpec } from "./borrowed-task-force";

const WORK_ORDER_SCHEMA = "agentlas.workforce-work-order.v1";
const CANDIDATE_SET_SCHEMA = "agentlas.workforce-candidate-set.v1";
const SELECTION_SCHEMA = "agentlas.workforce-selection.v1";
const VALIDATION_SCHEMA = "agentlas.workforce-selection-validation.v1";
const PREPARATION_SCHEMA = "agentlas.workforce-execution-plan.v1";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{1,255}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RELATIONS = new Set(["reportsTo", "handsOffTo", "reviews", "coordinatesWith"]);
const ENTITY_KINDS = new Set(["agent", "team", "group"]);
const EVIDENCE_LEVELS = new Set(["declared", "checked", "demonstrated", "attested"]);
const WORK_ORDER_HEADING = "## Workforce Work Order";
const SELECTION_HEADING = "## Workforce Selection";
const FORBIDDEN_FIT_FIELDS = new Set([
  "history",
  "performanceHistory",
  "popularity",
  "rating",
  "ratings",
  "revenue",
  "verifiedInvocations",
  "invocationCount",
  "recentFailure",
]);

type EventSink = (event: McpInvocationEvent) => void;
type JsonObject = Record<string, unknown>;

export interface WorkforceHubMcp {
  call(toolName: WorkforceToolName, args: JsonObject, signal?: AbortSignal): Promise<unknown>;
}

export type WorkforceToolName =
  | "workforce.search_candidates"
  | "workforce.validate_selection"
  | "workforce.prepare_execution";

export interface WorkforceLeaderTurn {
  systemPrompt: string;
  userPrompt: string;
  phase: "work-order" | "selection";
  invocationId: string;
}

export interface WorkforceExecutionBundle {
  slotId: string;
  agentDefinitionId: string;
  agentReleaseId: string;
  packageHash: string;
  contentDigest: string;
  releaseVersion: string;
  bundleDigest: string;
  slug: string;
  name: string;
  entityKind: "agent" | "team" | "group";
  directive: string;
  executionGraph?: BorrowedAgentSpec["executionGraph"];
}

export interface WorkforceSelectionReceipt {
  schemaVersion: "agentlas.desktop-workforce-selection-receipt.v1";
  receiptId: string;
  workOrderId: string;
  selectionSessionId: string;
  selectionReceiptId: string;
  preparationReceiptId: string;
  candidateSetDigest: string;
  ontologyVersion: string;
  decisionOwner: "host_llm";
  decisionModel: string;
  decisionRuntime: string | null;
  historyInfluence: "none";
  idealTeam: JsonObject[];
  executableTeam: JsonObject[];
  unfilledPosts: JsonObject[];
  substitutions: JsonObject[];
  preparedReleases: Array<{
    slotId: string;
    agentDefinitionId: string;
    agentReleaseId: string;
    packageHash: string;
    contentDigest: string;
    releaseVersion: string;
    bundleDigest: string;
  }>;
  mcpCalls: Array<{
    tool: WorkforceToolName;
    invocationId: string;
    status: "ok";
  }>;
  leaderInvocations: Array<{
    phase: "work-order" | "selection";
    invocationId: string;
    modelId: string;
    runtimeId: string;
    status: "completed";
  }>;
}

export interface WorkforceSelectionResult {
  workOrder: JsonObject;
  candidateSet: JsonObject;
  selection: JsonObject;
  validation: JsonObject;
  preparation: JsonObject;
  specs: BorrowedAgentSpec[];
  receipt: WorkforceSelectionReceipt;
}

export interface RunWorkforceSelectionParams {
  goal: string;
  active: RuntimeStatus;
  leader: (turn: WorkforceLeaderTurn) => Promise<string>;
  sink: EventSink;
  hubMcp?: WorkforceHubMcp;
  signal?: AbortSignal;
  benchmarkMode?: boolean;
}

export type WorkforceCommand =
  | { kind: "none" }
  | { kind: "legacy-network"; goal: string }
  | { kind: "workforce"; goal: string; benchmarkMode: boolean };

/** Keep command compatibility explicit and make ordinary hep-network ontology-first. */
export function parseWorkforceCommand(prompt: string, agentAppMode = false): WorkforceCommand {
  if (agentAppMode) return { kind: "none" };
  const legacy = prompt.match(/^\s*\/?hep-network\s+--legacy\b\s*/i);
  if (legacy) return { kind: "legacy-network", goal: prompt.slice(legacy[0].length).trim() };
  if (/^\s*\/?hep-network\s+--stormbreaker\b/i.test(prompt)) return { kind: "none" };
  const workforce = prompt.match(/^\s*(?:\/?workforce\b|\/?hep-network\b)\s*/i);
  if (!workforce) return { kind: "none" };
  const rawGoal = prompt.slice(workforce[0].length).trim();
  const benchmarkMode = /^--benchmark\b/i.test(rawGoal);
  return {
    kind: "workforce",
    goal: rawGoal.replace(/^--benchmark\b\s*/i, "").trim(),
    benchmarkMode,
  };
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requireArray(value: unknown, label: string, max = 256, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} must contain ${min}-${max} items.`);
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireId(value: unknown, label: string): string {
  const text = stringValue(value);
  if (!ID_RE.test(text)) throw new Error(`${label} is missing or invalid.`);
  return text;
}

function requireSha256(value: unknown, label: string): string {
  const text = stringValue(value);
  if (!SHA256_RE.test(text)) throw new Error(`${label} is missing or invalid.`);
  return text;
}

function requireIds(value: unknown, label: string, max = 256): string[] {
  const ids = requireArray(value, label, max).map((item, index) => requireId(item, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate IDs.`);
  return ids;
}

function requireStrings(value: unknown, label: string, max = 256, itemMax = 500): string[] {
  const strings = requireArray(value, label, max).map((item, index) => {
    const text = stringValue(item);
    if (!text || text.length > itemMax) throw new Error(`${label}[${index}] is missing or invalid.`);
    return text;
  });
  if (new Set(strings).size !== strings.length) throw new Error(`${label} contains duplicates.`);
  return strings;
}

function requireDateTime(value: unknown, label: string): { text: string; epochMs: number } {
  const text = stringValue(value);
  const epochMs = Date.parse(text);
  if (!RFC3339_RE.test(text) || !Number.isFinite(epochMs)) throw new Error(`${label} is missing or invalid.`);
  return { text, epochMs };
}

function requireLeveledConcepts(value: unknown, label: string): void {
  const seen = new Set<string>();
  for (const [index, raw] of requireArray(value, label).entries()) {
    const row = objectValue(raw, `${label}[${index}]`);
    const concept = requireId(row.concept, `${label}[${index}].concept`);
    if (seen.has(concept)) throw new Error(`${label} contains duplicate concept ${concept}.`);
    seen.add(concept);
    if (!EVIDENCE_LEVELS.has(stringValue(row.level))) throw new Error(`${label}[${index}].level is invalid.`);
  }
}

function canonicalRuntimeId(active: RuntimeStatus): string {
  const raw = [active.kind, active.backend, active.source].filter(Boolean).join(":");
  return raw.replace(/[^A-Za-z0-9._:/@-]/g, "-").slice(0, 255) || "runtime:unknown";
}

function canonicalModelId(active: RuntimeStatus): string {
  const raw = active.model || active.backend || active.kind || "host-model";
  const model = raw.replace(/[^A-Za-z0-9._:/@-]/g, "-").slice(0, 255);
  return ID_RE.test(model) ? model : "host-model";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Workforce orchestration was aborted.");
}

function assertNoForbiddenFitSignals(value: unknown, path = "candidateSet"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFitSignals(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if (FORBIDDEN_FIT_FIELDS.has(key)) throw new Error(`Hub candidate set exposed forbidden fit signal ${path}.${key}.`);
    assertNoForbiddenFitSignals(child, `${path}.${key}`);
  }
}

function extractBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** Parse the leader's structured decision without inventing or repairing fields. */
export function parseLeaderJson(text: string, heading: string): JsonObject {
  const headingIndex = text.lastIndexOf(heading);
  const scope = headingIndex >= 0 ? text.slice(headingIndex + heading.length) : text;
  const fence = scope.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fence?.[1]?.trim() || (() => {
    const start = scope.indexOf("{");
    return start >= 0 ? extractBalancedObject(scope, start) : null;
  })();
  if (!source) throw new Error(`Host LLM did not return ${heading}.`);
  try {
    return objectValue(JSON.parse(source), heading);
  } catch {
    throw new Error(`Host LLM returned invalid JSON for ${heading}.`);
  }
}

export function validateWorkOrder(value: unknown): JsonObject {
  const order = objectValue(value, "work order");
  if (order.schemaVersion !== WORK_ORDER_SCHEMA) throw new Error("Host LLM returned an unsupported work-order schema.");
  requireId(order.workOrderId, "workOrderId");
  if (!stringValue(order.taskBrief)) throw new Error("Host LLM work order is missing taskBrief.");
  if (order.redacted !== true) throw new Error("Hub workforce work orders must be explicitly redacted.");
  const serialized = JSON.stringify(order);
  if (
    /\/(?:Users|Volumes|private\/tmp|tmp)\//i.test(serialized) ||
    /[A-Za-z]:\\(?:Users|Documents and Settings)\\/i.test(serialized) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(serialized) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(serialized) ||
    /\b(?:sk|rk|xox[baprs]|gh[pousr])-[A-Za-z0-9_=-]{12,}\b/.test(serialized) ||
    /\b(?:api[_-]?key|token|secret|password|cookie|authorization)\b\s*[:=]\s*[^,}\s]{8,}/i.test(serialized)
  ) {
    throw new Error("Host LLM work order failed the local redaction gate.");
  }
  const slots = requireArray(order.roleSlots, "roleSlots", 32, 1);
  if (slots.length < 1 || slots.length > 32) throw new Error("Host LLM work order must contain 1-32 role slots.");
  const slotIds = new Set<string>();
  for (const raw of slots) {
    const slot = objectValue(raw, "role slot");
    const slotId = requireId(slot.slotId, "slotId");
    if (slotIds.has(slotId)) throw new Error(`Duplicate work-order slot: ${slotId}`);
    slotIds.add(slotId);
    if (!stringValue(slot.title) || !stringValue(slot.task)) throw new Error(`Role slot ${slotId} is incomplete.`);
    const cardinality = Number(slot.cardinality);
    if (!Number.isInteger(cardinality) || cardinality < 1 || cardinality > 16) {
      throw new Error(`Role slot ${slotId} has invalid cardinality.`);
    }
    for (const key of [
      "requiredCommunities", "requiredRoles", "requiredSkills", "requiredKnowledge",
      "requiredToolCapabilities", "consumes", "produces", "requiredAuthorities",
      "forbiddenAuthorities", "runtimes", "languages", "modalities",
    ]) requireIds(slot[key], `role slot ${slotId}.${key}`);
    for (const key of ["optionalCommunities", "excludedCommunities", "optionalSkills"]) {
      if (slot[key] != null) requireIds(slot[key], `role slot ${slotId}.${key}`);
    }
    if (slot.criticality != null && !["required", "optional"].includes(stringValue(slot.criticality))) {
      throw new Error(`Role slot ${slotId} has invalid criticality.`);
    }
    if (slot.minimumEvidenceLevel != null && !EVIDENCE_LEVELS.has(stringValue(slot.minimumEvidenceLevel))) {
      throw new Error(`Role slot ${slotId} has invalid minimumEvidenceLevel.`);
    }
    const allowedKinds = requireArray(slot.allowedEntityKinds, `role slot ${slotId}.allowedEntityKinds`, 3, 1);
    if (new Set(allowedKinds).size !== allowedKinds.length || allowedKinds.some((kind) => !ENTITY_KINDS.has(String(kind)))) {
      throw new Error(`Role slot ${slotId} has invalid allowedEntityKinds.`);
    }
  }
  for (const [index, raw] of (order.edges == null ? [] : requireArray(order.edges, "work-order edges", 128)).entries()) {
    const edge = objectValue(raw, `work-order edge[${index}]`);
    const from = requireId(edge.from, `work-order edge[${index}].from`);
    const to = requireId(edge.to, `work-order edge[${index}].to`);
    if (!slotIds.has(from) || !slotIds.has(to)) throw new Error("Work-order edge references an unknown role slot.");
    if (!RELATIONS.has(stringValue(edge.relation))) throw new Error("Work-order edge relation is invalid.");
    if (edge.artifactKinds != null) requireIds(edge.artifactKinds, `work-order edge[${index}].artifactKinds`);
  }
  if (order.forbiddenCommunities != null) requireIds(order.forbiddenCommunities, "forbiddenCommunities");
  if (order.selectionPolicy != null) {
    const policy = objectValue(order.selectionPolicy, "selectionPolicy");
    if (policy.allowHistoryEvidence != null && policy.allowHistoryEvidence !== false) {
      throw new Error("Workforce selection policy cannot enable history evidence.");
    }
    const minimum = policy.minimumCandidatesPerSlot;
    const maximum = policy.maximumCandidatesPerSlot;
    if (minimum != null && (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 2 || minimum > 30)) {
      throw new Error("selectionPolicy.minimumCandidatesPerSlot is invalid.");
    }
    if (maximum != null && (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 2 || maximum > 100)) {
      throw new Error("selectionPolicy.maximumCandidatesPerSlot is invalid.");
    }
    if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
      throw new Error("Workforce candidate window minimum exceeds maximum.");
    }
  }
  return order;
}

export function validateCandidateSet(value: unknown, order: JsonObject): JsonObject {
  const set = objectValue(value, "candidate set");
  assertNoForbiddenFitSignals(set);
  if (set.schemaVersion !== CANDIDATE_SET_SCHEMA) throw new Error("Hub returned an unsupported candidate-set schema.");
  if (set.workOrderId !== order.workOrderId) throw new Error("Hub candidate set does not match the work order.");
  requireId(set.selectionSessionId, "selectionSessionId");
  requireId(set.ontologyVersion, "ontologyVersion");
  requireSha256(set.candidateSetDigest, "candidateSetDigest");
  if (set.decisionOwner !== "host_llm" || set.historyInfluence !== "none") {
    throw new Error("Hub candidate set violated the host-LLM/content-only decision boundary.");
  }
  const issuedAt = requireDateTime(set.issuedAt, "candidate set issuedAt");
  const expiresAt = requireDateTime(set.expiresAt, "candidate set expiresAt");
  if (issuedAt.epochMs >= expiresAt.epochMs) throw new Error("Hub candidate set has an invalid issuance window.");
  if (expiresAt.epochMs <= Date.now()) throw new Error("Hub candidate set is expired or has invalid expiry.");
  const orderSlots = new Set(arrayValue(order.roleSlots).map((slot) => requireId(objectValue(slot, "role slot").slotId, "slotId")));
  const candidateSlots = requireArray(set.slots, "candidate set slots", 32, 1);
  if (candidateSlots.length !== orderSlots.size) throw new Error("Hub candidate set has incomplete slot coverage.");
  for (const raw of candidateSlots) {
    const slot = objectValue(raw, "candidate slot");
    const slotId = requireId(slot.slotId, "candidate slotId");
    if (!orderSlots.delete(slotId)) throw new Error(`Hub candidate set contains an unknown or duplicate slot: ${slotId}`);
    const releases = new Set<string>();
    for (const candidateRaw of requireArray(slot.candidates, `candidate slot ${slotId}.candidates`, 100)) {
      const candidate = objectValue(candidateRaw, "candidate");
      requireId(candidate.agentDefinitionId, "candidate agentDefinitionId");
      const releaseId = requireId(candidate.agentReleaseId, "candidate agentReleaseId");
      if (releases.has(releaseId)) throw new Error(`Hub candidate set duplicated release ${releaseId} in ${slotId}.`);
      releases.add(releaseId);
      requireSha256(candidate.packageHash, "candidate packageHash");
      requireSha256(candidate.contentDigest, "candidate contentDigest");
      if (!stringValue(candidate.releaseVersion)) throw new Error("Candidate releaseVersion is missing.");
      if (!ENTITY_KINDS.has(stringValue(candidate.entityKind))) {
        throw new Error("Candidate entityKind is invalid.");
      }
      if (!stringValue(candidate.name)) throw new Error("Candidate name is missing.");
      requireIds(candidate.communities, "candidate communities");
      requireIds(candidate.fitEvidence, "candidate fitEvidence");
      requireIds(candidate.qualificationEvidence, "candidate qualificationEvidence");
      requireIds(candidate.optionalGaps, "candidate optionalGaps");
      const semantic = objectValue(candidate.semanticSnapshot, "candidate semanticSnapshot");
      requireStrings(semantic.summaries, "candidate semanticSnapshot.summaries");
      requireIds(semantic.roles, "candidate semanticSnapshot.roles");
      requireLeveledConcepts(semantic.skills, "candidate semanticSnapshot.skills");
      requireLeveledConcepts(semantic.toolCapabilities, "candidate semanticSnapshot.toolCapabilities");
      requireIds(semantic.consumes, "candidate semanticSnapshot.consumes");
      requireIds(semantic.produces, "candidate semanticSnapshot.produces");
      requireIds(semantic.authorities, "candidate semanticSnapshot.authorities");
      requireStrings(semantic.runtimes, "candidate semanticSnapshot.runtimes");
      requireStrings(semantic.languages, "candidate semanticSnapshot.languages");
      const operational = objectValue(candidate.operational, "candidate operational");
      if (typeof operational.callable !== "boolean" || typeof operational.installable !== "boolean") {
        throw new Error("Candidate operational flags are missing or invalid.");
      }
      if (operational.unavailableReasons != null) requireIds(operational.unavailableReasons, "candidate operational.unavailableReasons");
    }
    requireIds(slot.coverageGaps, `candidate slot ${slotId}.coverageGaps`);
  }
  return set;
}

function candidatePairs(candidateSet: JsonObject): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const raw of arrayValue(candidateSet.slots)) {
    const slot = objectValue(raw, "candidate slot");
    const slotId = requireId(slot.slotId, "candidate slotId");
    result.set(slotId, new Set(arrayValue(slot.candidates).map((candidate) => (
      requireId(objectValue(candidate, "candidate").agentReleaseId, "agentReleaseId")
    ))));
  }
  return result;
}

export function validateLeaderSelection(
  value: unknown,
  candidateSet: JsonObject,
  active: RuntimeStatus,
): JsonObject {
  const selection = objectValue(value, "selection");
  if (selection.schemaVersion !== SELECTION_SCHEMA) throw new Error("Host LLM returned an unsupported selection schema.");
  if (selection.selectionSessionId !== candidateSet.selectionSessionId) throw new Error("Host LLM selection session mismatch.");
  if (selection.candidateSetDigest !== candidateSet.candidateSetDigest) throw new Error("Host LLM candidate digest mismatch.");
  const author = objectValue(selection.decisionAuthor, "decisionAuthor");
  if (author.kind !== "host_llm") throw new Error("Workforce selection must be authored by the host LLM.");
  if (author.modelId !== canonicalModelId(active)) throw new Error("Host LLM selection declared the wrong model identity.");
  if (author.runtimeId != null && author.runtimeId !== canonicalRuntimeId(active)) {
    throw new Error("Host LLM selection declared the wrong runtime identity.");
  }
  const pairs = candidatePairs(candidateSet);
  const assignments = requireArray(selection.assignments, "selection assignments", 64, 1);
  if (assignments.length < 1) throw new Error("Host LLM selected no workforce assignments.");
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const raw of assignments) {
    const assignment = objectValue(raw, "assignment");
    const slotId = requireId(assignment.slotId, "assignment slotId");
    const releaseId = requireId(assignment.agentReleaseId, "assignment agentReleaseId");
    if (!pairs.get(slotId)?.has(releaseId)) throw new Error(`Host LLM selected a release outside the candidate set: ${releaseId}`);
    const key = `${slotId}\u0000${releaseId}`;
    if (seen.has(key)) throw new Error(`Host LLM duplicated an assignment: ${slotId}/${releaseId}`);
    seen.add(key);
    counts.set(slotId, (counts.get(slotId) ?? 0) + 1);
    if (requireIds(assignment.reasonCodes, `assignment ${slotId}/${releaseId}.reasonCodes`).length < 1) {
      throw new Error(`Assignment ${slotId}/${releaseId} is missing reason codes.`);
    }
  }
  const selectedSlots = new Set([...counts.keys()]);
  for (const [index, raw] of requireArray(selection.edges, "selection edges", 128).entries()) {
    const edge = objectValue(raw, `selection edge[${index}]`);
    const fromSlot = requireId(edge.fromSlot, `selection edge[${index}].fromSlot`);
    const toSlot = requireId(edge.toSlot, `selection edge[${index}].toSlot`);
    if (!selectedSlots.has(fromSlot) || !selectedSlots.has(toSlot)) throw new Error("Selection edge references an unfilled slot.");
    if (!RELATIONS.has(stringValue(edge.relation))) throw new Error("Selection edge relation is invalid.");
    if (edge.artifactKinds != null) requireIds(edge.artifactKinds, `selection edge[${index}].artifactKinds`);
  }
  const allCandidateReleases = new Set([...pairs.values()].flatMap((releases) => [...releases]));
  for (const releaseId of requireIds(selection.alternativesConsidered, "selection alternativesConsidered")) {
    if (!allCandidateReleases.has(releaseId)) throw new Error(`Selection alternative was outside the candidate set: ${releaseId}`);
  }
  if (selection.requestExpansionForSlots != null && requireIds(selection.requestExpansionForSlots, "selection requestExpansionForSlots").length > 0) {
    throw new Error("Host LLM requested candidate expansion; selection cannot continue with the current set.");
  }
  return selection;
}

function candidateRows(candidateSet: JsonObject): Map<string, JsonObject> {
  const rows = new Map<string, JsonObject>();
  for (const slotRaw of requireArray(candidateSet.slots, "candidate set slots", 32, 1)) {
    const slot = objectValue(slotRaw, "candidate slot");
    const slotId = requireId(slot.slotId, "candidate slotId");
    for (const raw of requireArray(slot.candidates, `candidate slot ${slotId}.candidates`, 100)) {
      const candidate = objectValue(raw, "candidate");
      const releaseId = requireId(candidate.agentReleaseId, "candidate agentReleaseId");
      rows.set(`${slotId}\u0000${releaseId}`, candidate);
    }
  }
  return rows;
}

function validateTeamRows(value: unknown, label: string, candidates: Map<string, JsonObject>): Set<string> {
  const pairs = new Set<string>();
  for (const [index, raw] of requireArray(value, label, 64).entries()) {
    const row = objectValue(raw, `${label}[${index}]`);
    const slotId = requireId(row.slotId, `${label}[${index}].slotId`);
    const agentDefinitionId = requireId(row.agentDefinitionId, `${label}[${index}].agentDefinitionId`);
    const agentReleaseId = requireId(row.agentReleaseId, `${label}[${index}].agentReleaseId`);
    const releaseVersion = stringValue(row.releaseVersion);
    if (!releaseVersion) throw new Error(`${label}[${index}].releaseVersion is missing.`);
    const packageHash = requireSha256(row.packageHash, `${label}[${index}].packageHash`);
    const contentDigest = requireSha256(row.contentDigest, `${label}[${index}].contentDigest`);
    const entityKind = stringValue(row.entityKind);
    if (!ENTITY_KINDS.has(entityKind)) throw new Error(`${label}[${index}].entityKind is invalid.`);
    requireStrings(row.reasonCodes, `${label}[${index}].reasonCodes`);
    const pair = `${slotId}\u0000${agentReleaseId}`;
    if (pairs.has(pair)) throw new Error(`${label} contains duplicate roster row ${slotId}/${agentReleaseId}.`);
    pairs.add(pair);
    const candidate = candidates.get(pair);
    if (!candidate || candidate.agentDefinitionId !== agentDefinitionId || candidate.releaseVersion !== releaseVersion ||
        candidate.packageHash !== packageHash || candidate.contentDigest !== contentDigest || candidate.entityKind !== entityKind) {
      throw new Error(`${label}[${index}] does not match the frozen candidate release.`);
    }
  }
  return pairs;
}

export function validateSelectionReceipt(
  value: unknown,
  selection: JsonObject,
  candidateSet: JsonObject,
): JsonObject {
  const validation = objectValue(value, "selection validation");
  if (validation.schemaVersion !== VALIDATION_SCHEMA || validation.status !== "accepted") {
    const issues = arrayValue(validation.issues).map(String).join(", ");
    throw new Error(`Hub rejected the host-LLM workforce selection${issues ? `: ${issues}` : "."}`);
  }
  if (validation.candidateSetDigest !== candidateSet.candidateSetDigest) {
    throw new Error("Hub validation receipt candidate digest mismatch.");
  }
  if (validation.ontologyVersion !== candidateSet.ontologyVersion) {
    throw new Error("Hub validation receipt ontology version mismatch.");
  }
  requireId(validation.selectionReceiptId, "selectionReceiptId");
  requireStrings(validation.issues, "selection validation issues");
  if (validation.decisionOwner !== "host_llm" || validation.historyInfluence !== "none") {
    throw new Error("Hub validation receipt changed the decision owner or history boundary.");
  }
  const candidates = candidateRows(candidateSet);
  const unfilled = requireArray(validation.unfilledPosts, "selection validation unfilledPosts", 64);
  unfilled.forEach((row, index) => objectValue(row, `selection validation unfilledPosts[${index}]`));
  const substitutions = requireArray(validation.substitutions, "selection validation substitutions", 64);
  requireArray(validation.edges, "selection validation edges", 128)
    .forEach((edge, index) => objectValue(edge, `selection validation edges[${index}]`));
  objectValue(validation.receipt, "selection validation receipt");
  if (unfilled.length > 0) throw new Error("Selected ideal workforce is not executable; silent replacement is forbidden.");
  if (substitutions.length > 0) throw new Error("Hub attempted a workforce substitution without a new host-LLM decision.");
  const assigned = new Set(arrayValue(selection.assignments).map((raw) => {
    const assignment = objectValue(raw, "assignment");
    return `${requireId(assignment.slotId, "slotId")}\u0000${requireId(assignment.agentReleaseId, "agentReleaseId")}`;
  }));
  const idealPairs = validateTeamRows(validation.idealTeam, "ideal team", candidates);
  const executablePairs = validateTeamRows(validation.executableTeam, "executable team", candidates);
  if (assigned.size !== idealPairs.size || assigned.size !== executablePairs.size ||
      [...assigned].some((pair) => !idealPairs.has(pair) || !executablePairs.has(pair))) {
    throw new Error("Hub validation receipt changed the host-LLM roster.");
  }
  return validation;
}

function normalizeExecutionGraph(value: unknown): BorrowedAgentSpec["executionGraph"] | undefined {
  if (value == null) return undefined;
  const graph = objectValue(value, "execution graph");
  const manager = objectValue(graph.manager, "execution graph manager");
  const workers = arrayValue(graph.workers).map((raw) => {
    const worker = objectValue(raw, "execution graph worker");
    return {
      id: requireId(worker.id, "worker id"),
      path: stringValue(worker.path),
      content: stringValue(worker.content),
    };
  });
  const managerPath = stringValue(manager.path);
  const managerContent = stringValue(manager.content);
  if (!managerPath || !managerContent || workers.length < 1 || workers.some((worker) => !worker.path || !worker.content)) {
    throw new Error("Prepared team execution graph is incomplete.");
  }
  return {
    schemaVersion: "1.0",
    manager: { path: managerPath, content: managerContent },
    workers,
  };
}

export function validateExecutionPreparation(
  value: unknown,
  validation: JsonObject,
  candidateSet: JsonObject,
): { preparation: JsonObject; bundles: WorkforceExecutionBundle[] } {
  const preparation = objectValue(value, "execution preparation");
  if (preparation.schemaVersion !== PREPARATION_SCHEMA || preparation.status !== "prepared") {
    throw new Error("Hub did not prepare the exact selected workforce.");
  }
  if (preparation.selectionReceiptId !== validation.selectionReceiptId) {
    throw new Error("Prepared workforce does not match the accepted selection receipt.");
  }
  if (preparation.candidateSetDigest !== candidateSet.candidateSetDigest) {
    throw new Error("Prepared workforce candidate digest mismatch.");
  }
  if (preparation.decisionOwner !== "host_llm") {
    throw new Error("Prepared workforce changed the decision owner.");
  }
  requireId(preparation.preparationReceiptId, "preparationReceiptId");
  requireStrings(preparation.issues, "execution preparation issues");
  if (requireArray(preparation.substitutions, "execution preparation substitutions", 64).length > 0) {
    throw new Error("Prepared workforce contains an unapproved substitution.");
  }
  const candidateByPair = new Map<string, JsonObject>();
  for (const slotRaw of arrayValue(candidateSet.slots)) {
    const slot = objectValue(slotRaw, "candidate slot");
    const slotId = requireId(slot.slotId, "candidate slotId");
    for (const candidateRaw of arrayValue(slot.candidates)) {
      const candidate = objectValue(candidateRaw, "candidate");
      const releaseId = requireId(candidate.agentReleaseId, "candidate agentReleaseId");
      candidateByPair.set(`${slotId}\u0000${releaseId}`, candidate);
    }
  }
  const expected = new Set(arrayValue(validation.executableTeam).map((raw) => {
    const row = objectValue(raw, "executable team row");
    return `${requireId(row.slotId, "slotId")}\u0000${requireId(row.agentReleaseId, "agentReleaseId")}`;
  }));
  const bundles: WorkforceExecutionBundle[] = [];
  for (const raw of requireArray(preparation.executionRoster, "execution roster", 64, 1)) {
    const bundle = objectValue(raw, "execution bundle");
    const slotId = requireId(bundle.slotId, "bundle slotId");
    const agentReleaseId = requireId(bundle.agentReleaseId, "bundle agentReleaseId");
    const pair = `${slotId}\u0000${agentReleaseId}`;
    if (!expected.delete(pair)) throw new Error(`Prepared workforce contains an unknown or duplicate release: ${agentReleaseId}`);
    const candidate = candidateByPair.get(pair);
    if (!candidate) throw new Error(`Prepared workforce release was absent from its frozen candidate set: ${agentReleaseId}`);
    const entityKind = stringValue(bundle.entityKind);
    if (!(["agent", "team", "group"] as string[]).includes(entityKind)) throw new Error("Prepared entityKind is invalid.");
    const directiveBundle = objectValue(bundle.directiveBundle, "directiveBundle");
    const directiveParts = [
      ["System prompt", directiveBundle.systemPrompt],
      ["Instructions", directiveBundle.instructions],
      ["AGENT.md", directiveBundle.agentMd],
    ].flatMap(([label, value]) => stringValue(value) ? [`### ${label}\n${stringValue(value)}`] : []);
    if (directiveParts.length < 1) throw new Error(`Prepared release has no authoritative directive bundle: ${agentReleaseId}`);
    const directive = directiveParts.join("\n\n");
    const agentDefinitionId = requireId(bundle.agentDefinitionId, "bundle agentDefinitionId");
    const packageHash = requireSha256(bundle.packageHash, "bundle packageHash");
    const contentDigest = requireSha256(bundle.contentDigest, "bundle contentDigest");
    const releaseVersion = stringValue(bundle.releaseVersion);
    if (
      agentDefinitionId !== candidate.agentDefinitionId ||
      packageHash !== candidate.packageHash ||
      contentDigest !== candidate.contentDigest ||
      releaseVersion !== candidate.releaseVersion ||
      entityKind !== candidate.entityKind
    ) {
      throw new Error(`Prepared release identity or digest mismatch: ${agentReleaseId}`);
    }
    bundles.push({
      slotId,
      agentDefinitionId,
      agentReleaseId,
      packageHash,
      contentDigest,
      releaseVersion,
      bundleDigest: requireSha256(bundle.bundleDigest, "bundle bundleDigest"),
      slug: requireId(directiveBundle.slug || candidate.agentDefinitionId, "bundle slug"),
      name: stringValue(directiveBundle.name) || stringValue(candidate.name) || agentReleaseId,
      entityKind: entityKind as WorkforceExecutionBundle["entityKind"],
      directive,
      executionGraph: normalizeExecutionGraph(directiveBundle.executionGraph),
    });
    if (!bundles[bundles.length - 1].releaseVersion) throw new Error(`Prepared releaseVersion is missing: ${agentReleaseId}`);
    if (entityKind === "team" && !bundles[bundles.length - 1].executionGraph) {
      throw new Error(`Prepared team has no authoritative execution graph: ${agentReleaseId}`);
    }
  }
  if (expected.size > 0) throw new Error("Hub failed to prepare every selected executable release.");
  return { preparation, bundles };
}

function mcpJson(value: string | null, toolName: string): unknown {
  if (!value) throw new Error(`${toolName} returned no MCP content.`);
  if (value.startsWith("hephaestus tool failed:")) throw new Error(value.slice(0, 500));
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${toolName} returned invalid MCP JSON.`);
  }
}

export function installedWorkforceHubMcp(): WorkforceHubMcp {
  return {
    async call(toolName, args, signal) {
      throwIfAborted(signal);
      const server = listInstalledServers().find((item) => item.enabled && item.catalogId === "hephaestus-network");
      if (!server) throw new Error("Hephaestus Network MCP is not installed or enabled.");
      const result = await callServerTool(server, toolName, args, { timeoutMs: 45_000 });
      throwIfAborted(signal);
      return mcpJson(result, toolName);
    },
  };
}

function workOrderSystemPrompt(modelId: string, runtimeId: string, benchmarkMode: boolean, workOrderId: string): string {
  return [
    "You are the top Agentlas workforce leader.",
    "Decompose the user's goal into a small professional task force before any agent search.",
    "This is a semantic HR/job-analysis decision: express roles, skills, knowledge, tool capabilities, artifacts, authority and handoffs.",
    "Do not name or select agents. Do not use popularity, ratings, invocation history, revenue or prior success as fit evidence.",
    "Use only ontology-style identifiers such as community:software-engineering, role:backend-engineer, skill:api-design, tool:postgresql, artifact:test-report.",
    "The Hub receives this object, so taskBrief and role tasks must be redacted of local paths, secrets, account data and private memory.",
    benchmarkMode ? "Benchmark mode: create at least two genuinely distinct required role slots so delegation and synthesis are observable." : "",
    `Decision model identity for later selection: ${modelId}`,
    `Decision runtime identity for later selection: ${runtimeId}`,
    `workOrderId must be exactly ${workOrderId}`,
    "Return JSON only after the required heading. Do not add fields outside the contract.",
    `${WORK_ORDER_HEADING}\n\`\`\`json\n{"schemaVersion":"${WORK_ORDER_SCHEMA}","workOrderId":"${workOrderId}","taskBrief":"<redacted goal>","redacted":true,"roleSlots":[{"slotId":"slot:<id>","title":"<job title>","task":"<bounded responsibility>","cardinality":1,"criticality":"required","requiredCommunities":[],"optionalCommunities":[],"excludedCommunities":[],"requiredRoles":[],"requiredSkills":[],"optionalSkills":[],"requiredKnowledge":[],"requiredToolCapabilities":[],"consumes":[],"produces":[],"requiredAuthorities":[],"forbiddenAuthorities":[],"runtimes":[],"languages":[],"modalities":[],"allowedEntityKinds":["agent","team"]}],"edges":[],"forbiddenCommunities":[],"selectionPolicy":{"minimumCandidatesPerSlot":5,"maximumCandidatesPerSlot":20,"allowHistoryEvidence":false}}\n\`\`\``,
  ].join("\n\n");
}

function selectionSystemPrompt(modelId: string, runtimeId: string): string {
  return [
    "You are the top Agentlas workforce leader and the only soft-fit decision maker.",
    "Select exact immutable AgentRelease IDs from the Hub candidate set for every required slot.",
    "The Hub has already applied hard eligibility. Judge semantic fit, complementary coverage, handoffs and task-specific evidence.",
    "Never use popularity, rating, invocation count, revenue, chronology or prior success as a fit signal.",
    "Never select a release outside the supplied candidate set. Never silently substitute an available agent for a better but unavailable ideal agent.",
    "Use candidate fitEvidence, qualificationEvidence, semanticSnapshot and optionalGaps. Consider at least one non-selected exact release when available.",
    `decisionAuthor.modelId must be exactly ${modelId}`,
    `decisionAuthor.runtimeId must be exactly ${runtimeId}`,
    "Return JSON only after the required heading. Do not add fields outside the contract.",
    `${SELECTION_HEADING}\n\`\`\`json\n{"schemaVersion":"${SELECTION_SCHEMA}","selectionSessionId":"<copy>","candidateSetDigest":"<copy>","decisionAuthor":{"kind":"host_llm","modelId":"${modelId}","runtimeId":"${runtimeId}"},"assignments":[{"slotId":"<exact slot>","agentReleaseId":"<exact candidate release>","reasonCodes":["fit:task-specific"]}],"edges":[],"alternativesConsidered":["<exact non-selected candidate release>"],"requestExpansionForSlots":[]}\n\`\`\``,
  ].join("\n\n");
}

function emitMcpStatus(sink: EventSink, tool: WorkforceToolName, invocationId: string, done: boolean): void {
  sink({
    kind: "tool-use",
    done,
    status: done ? `${tool} completed` : `${tool} in progress`,
    tool: { name: tool, id: invocationId, result: done ? "ok" : undefined },
    agentId: "workforce:leader",
    agentName: "Agentlas Workforce Leader",
    role: "workforce-leader",
    tier: 1,
    phase: "plan",
  });
}

export async function runWorkforceSelection(p: RunWorkforceSelectionParams): Promise<WorkforceSelectionResult> {
  const goal = p.goal.trim();
  if (!goal) throw new Error("Workforce goal is required.");
  const hub = p.hubMcp ?? installedWorkforceHubMcp();
  const modelId = canonicalModelId(p.active);
  const runtimeId = canonicalRuntimeId(p.active);
  const mcpCalls: WorkforceSelectionReceipt["mcpCalls"] = [];
  const leaderInvocations: WorkforceSelectionReceipt["leaderInvocations"] = [];
  const requiredWorkOrderId = `work-order:${randomUUID()}`;

  p.sink({
    kind: "thinking",
    status: "Host LLM is drafting the workforce work order",
    model: modelId,
    agentId: "workforce:leader",
    agentName: "Agentlas Workforce Leader",
    role: "workforce-leader",
    tier: 1,
    phase: "plan",
  });
  const orderInvocationId = `workforce-leader:${randomUUID()}`;
  const orderText = await p.leader({
    phase: "work-order",
    invocationId: orderInvocationId,
    systemPrompt: workOrderSystemPrompt(modelId, runtimeId, p.benchmarkMode === true, requiredWorkOrderId),
    userPrompt: `User goal:\n${goal}`,
  });
  leaderInvocations.push({ phase: "work-order", invocationId: orderInvocationId, modelId, runtimeId, status: "completed" });
  throwIfAborted(p.signal);
  const workOrder = validateWorkOrder(parseLeaderJson(orderText, WORK_ORDER_HEADING));
  if (workOrder.workOrderId !== requiredWorkOrderId) throw new Error("Host LLM changed the assigned workOrderId.");

  const searchInvocationId = `mcp:${randomUUID()}`;
  emitMcpStatus(p.sink, "workforce.search_candidates", searchInvocationId, false);
  const candidateSet = validateCandidateSet(await hub.call(
    "workforce.search_candidates",
    { workOrder },
    p.signal,
  ), workOrder);
  mcpCalls.push({ tool: "workforce.search_candidates", invocationId: searchInvocationId, status: "ok" });
  emitMcpStatus(p.sink, "workforce.search_candidates", searchInvocationId, true);

  p.sink({
    kind: "thinking",
    status: "Host LLM is selecting the exact AgentRelease roster",
    model: modelId,
    agentId: "workforce:leader",
    agentName: "Agentlas Workforce Leader",
    role: "workforce-leader",
    tier: 1,
    phase: "plan",
  });
  const selectionInvocationId = `workforce-leader:${randomUUID()}`;
  const selectionText = await p.leader({
    phase: "selection",
    invocationId: selectionInvocationId,
    systemPrompt: selectionSystemPrompt(modelId, runtimeId),
    userPrompt: [
      "Work order:",
      JSON.stringify(workOrder),
      "Candidate set (content-only; historyInfluence=none):",
      JSON.stringify(candidateSet),
    ].join("\n\n"),
  });
  leaderInvocations.push({ phase: "selection", invocationId: selectionInvocationId, modelId, runtimeId, status: "completed" });
  throwIfAborted(p.signal);
  const selection = validateLeaderSelection(parseLeaderJson(selectionText, SELECTION_HEADING), candidateSet, p.active);

  const validateInvocationId = `mcp:${randomUUID()}`;
  emitMcpStatus(p.sink, "workforce.validate_selection", validateInvocationId, false);
  const validation = validateSelectionReceipt(await hub.call(
    "workforce.validate_selection",
    { workOrder, candidateSet, selection },
    p.signal,
  ), selection, candidateSet);
  mcpCalls.push({ tool: "workforce.validate_selection", invocationId: validateInvocationId, status: "ok" });
  emitMcpStatus(p.sink, "workforce.validate_selection", validateInvocationId, true);

  const prepareInvocationId = `mcp:${randomUUID()}`;
  emitMcpStatus(p.sink, "workforce.prepare_execution", prepareInvocationId, false);
  const prepared = validateExecutionPreparation(await hub.call(
    "workforce.prepare_execution",
    {
      workOrder,
      candidateSet,
      selection,
      validationReceipt: validation,
    },
    p.signal,
  ), validation, candidateSet);
  mcpCalls.push({ tool: "workforce.prepare_execution", invocationId: prepareInvocationId, status: "ok" });
  emitMcpStatus(p.sink, "workforce.prepare_execution", prepareInvocationId, true);

  const slugCounts = new Map<string, number>();
  for (const bundle of prepared.bundles) slugCounts.set(bundle.slug, (slugCounts.get(bundle.slug) ?? 0) + 1);
  const specs: BorrowedAgentSpec[] = prepared.bundles.map((bundle, index) => ({
    slug: (slugCounts.get(bundle.slug) ?? 0) > 1
      ? `${bundle.slug.slice(0, 220)}--post-${index + 1}`
      : bundle.slug,
    name: bundle.name,
    directive: bundle.directive,
    entityKind: bundle.entityKind,
    source: "hub",
    routeLabel: `workforce:${bundle.slotId}`,
    agentDefinitionId: bundle.agentDefinitionId,
    agentReleaseId: bundle.agentReleaseId,
    packageHash: bundle.packageHash,
    contentDigest: bundle.contentDigest,
    releaseVersion: bundle.releaseVersion,
    bundleDigest: bundle.bundleDigest,
    executionGraph: bundle.executionGraph,
  }));
  const receipt: WorkforceSelectionReceipt = {
    schemaVersion: "agentlas.desktop-workforce-selection-receipt.v1",
    receiptId: `desktop-workforce:${randomUUID()}`,
    workOrderId: requireId(workOrder.workOrderId, "workOrderId"),
    selectionSessionId: requireId(candidateSet.selectionSessionId, "selectionSessionId"),
    selectionReceiptId: requireId(validation.selectionReceiptId, "selectionReceiptId"),
    preparationReceiptId: requireId(prepared.preparation.preparationReceiptId, "preparationReceiptId"),
    candidateSetDigest: requireSha256(candidateSet.candidateSetDigest, "candidateSetDigest"),
    ontologyVersion: requireId(candidateSet.ontologyVersion, "ontologyVersion"),
    decisionOwner: "host_llm",
    decisionModel: modelId,
    decisionRuntime: runtimeId,
    historyInfluence: "none",
    idealTeam: arrayValue(validation.idealTeam).map((row) => objectValue(row, "ideal team row")),
    executableTeam: arrayValue(validation.executableTeam).map((row) => objectValue(row, "executable team row")),
    unfilledPosts: arrayValue(validation.unfilledPosts).map((row) => objectValue(row, "unfilled post")),
    substitutions: arrayValue(validation.substitutions).map((row) => objectValue(row, "substitution")),
    preparedReleases: prepared.bundles.map((bundle) => ({
      slotId: bundle.slotId,
      agentDefinitionId: bundle.agentDefinitionId,
      agentReleaseId: bundle.agentReleaseId,
      packageHash: bundle.packageHash,
      contentDigest: bundle.contentDigest,
      releaseVersion: bundle.releaseVersion,
      bundleDigest: bundle.bundleDigest,
    })),
    mcpCalls,
    leaderInvocations,
  };
  return {
    workOrder,
    candidateSet,
    selection,
    validation,
    preparation: prepared.preparation,
    specs,
    receipt,
  };
}
