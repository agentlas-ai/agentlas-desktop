import { randomUUID } from "node:crypto";
import {
  ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION,
  isOneImprovementProofState,
  isOneImprovementProofV1,
  isOneTrustedImprovementEvidence,
  isSafeOneImprovementId,
  unsafeOneImprovementTextReason,
  type CreateOneImprovementProofInput,
  type OneImprovementAssetBinding,
  type OneImprovementAssetControl,
  type OneImprovementAssetVersionRef,
  type OneImprovementChangeV1,
  type OneImprovementComparisonDirection,
  type OneImprovementComparisonRecord,
  type OneImprovementEvidenceType,
  type OneImprovementProofMutationResult,
  type OneImprovementProofRecord,
  type OneImprovementProofState,
  type OneImprovementResult,
  type OneImprovementReusedAssetV1,
  type OneImprovementRuntimeAssetKind,
  type OneTrustedImprovementAssetReuseEvidence,
  type OneTrustedImprovementComparisonEvidence,
  type OneTrustedImprovementEvidence,
  type OneTrustedImprovementMeasurementEvidence,
  type OneTrustedImprovementRubricEvidence,
  type OneTrustedImprovementTaskEvidence,
} from "../../shared/one-improvement-proof";
import { ONE_DOMAIN_EVENT_RULES } from "../../shared/one-domain-events";
import type { CanonicalTask } from "../../shared/types";
import { getDb } from "../store/db";
import { getCanonicalTask } from "../store/tasks";
import { recordOneDomainEvent } from "./domain-events";

export const ONE_IMPROVEMENT_PROOF_META_KEY = "agentlas.one.improvement-proofs.v1";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const CHANGE_KINDS = new Set([
  "instruction_reduction", "time_reduction", "revision_reduction", "quality_improvement", "risk_avoidance",
]);
const CONTROLS = new Set<OneImprovementAssetControl>(["edit", "use_once", "disable", "delete"]);
const RUNTIME_ASSET_KINDS = new Set<OneImprovementRuntimeAssetKind>(["memory", "agent", "team", "automation"]);
const EVIDENCE_TYPES = new Set<OneImprovementEvidenceType>(["measured", "qualitative", "estimate"]);
const RESULTS = new Set<OneImprovementResult>(["improved", "no_change", "regression"]);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new TypeError(`${label} contains unsupported fields`);
}

function assertVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${label} must be a positive safe integer`);
}

function assertSafeId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value) || !isSafeOneImprovementId(value)) {
    throw new TypeError(`${label} must be an opaque safe id`);
  }
}

function safeIds(value: unknown, label: string, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new TypeError(`${label} must contain ${min}-${max} opaque ids`);
  }
  const result = value.map((item, index) => {
    assertSafeId(item, `${label}[${index}]`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must contain unique ids`);
  return result;
}

function cleanText(value: unknown, label: string, maxLength = 4_000): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) throw new TypeError(`${label} contains unsupported control characters`);
  const unsafe = unsafeOneImprovementTextReason(value);
  if (unsafe) throw new TypeError(`${label} rejected unsafe ${unsafe}`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length < 1 || normalized.length > maxLength) throw new RangeError(`${label} must contain 1-${maxLength} normalized characters`);
  return normalized;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date-time`);
  }
  if (Date.parse(value) > Date.now() + MAX_CLOCK_SKEW_MS) throw new TypeError(`${label} cannot be in the future`);
  return new Date(Date.parse(value)).toISOString();
}

function sameSet<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function sameAssetVersions(left: readonly OneImprovementAssetVersionRef[], right: readonly OneImprovementAssetVersionRef[]): boolean {
  const encode = (value: OneImprovementAssetVersionRef) => `${value.assetId}:${value.assetVersion}`;
  return sameSet(left.map(encode), right.map(encode));
}

function initialState(): OneImprovementProofState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION,
    version,
    evidence: [],
    proofs: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): OneImprovementProofState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored One Improvement Proof state is corrupt; it was not overwritten");
  }
  if (!isOneImprovementProofState(parsed)) {
    throw new Error("Stored One Improvement Proof state violates its closed contract; it was not overwritten");
  }
  return parsed;
}

function readOrCreateState(): { raw: string; state: OneImprovementProofState } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_IMPROVEMENT_PROOF_META_KEY) as
    | { value: string }
    | undefined;
  if (!row) {
    const candidate = JSON.stringify(initialState());
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_IMPROVEMENT_PROOF_META_KEY, candidate);
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_IMPROVEMENT_PROOF_META_KEY) as
      | { value: string }
      | undefined;
  }
  if (!row) throw new Error("Could not initialize One Improvement Proof state");
  return { raw: row.value, state: parseState(row.value) };
}

function nextTimestamp(previousVersion: number): { version: number; iso: string } {
  const version = Math.max(Date.now(), previousVersion + 1);
  return { version, iso: new Date(version).toISOString() };
}

function taskAtVersion(taskId: string, expectedVersion: number, label: string): CanonicalTask {
  assertSafeId(taskId, `${label}.taskId`);
  assertVersion(expectedVersion, `${label}.taskVersion`);
  const task = getCanonicalTask(taskId);
  if (!task) throw new Error(`${label} canonical Task is unavailable; no Improvement Proof was created`);
  if (task.version !== expectedVersion) {
    throw new Error(`${label} canonical Task changed (expected ${expectedVersion}, current ${task.version})`);
  }
  return task;
}

function normalizeControls(value: unknown, label: string): OneImprovementAssetControl[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new TypeError(`${label} must contain 1-4 controls`);
  const result = value.map((item) => {
    if (typeof item !== "string" || !CONTROLS.has(item as OneImprovementAssetControl)) throw new TypeError(`${label} contains an unsupported control`);
    return item as OneImprovementAssetControl;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must contain unique controls`);
  return result;
}

function normalizeReusedAssets(value: unknown): OneImprovementReusedAssetV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError("reusedAssets must contain 1-16 assets");
  const assets = value.map((item, index): OneImprovementReusedAssetV1 => {
    if (!isRecord(item)) throw new TypeError(`reusedAssets[${index}] must be an object`);
    assertOnlyKeys(item, ["assetRef", "assetType", "label", "sourceTaskRef", "receiptRefs", "controls"], `reusedAssets[${index}]`);
    assertSafeId(item.assetRef, `reusedAssets[${index}].assetRef`);
    if (typeof item.assetType !== "string" || !RUNTIME_ASSET_KINDS.has(item.assetType as OneImprovementRuntimeAssetKind)) {
      throw new TypeError(`reusedAssets[${index}].assetType must be memory, agent, team, or automation`);
    }
    assertSafeId(item.sourceTaskRef, `reusedAssets[${index}].sourceTaskRef`);
    return {
      assetRef: item.assetRef,
      assetType: item.assetType as OneImprovementRuntimeAssetKind,
      label: cleanText(item.label, `reusedAssets[${index}].label`, 160),
      sourceTaskRef: item.sourceTaskRef,
      receiptRefs: safeIds(item.receiptRefs, `reusedAssets[${index}].receiptRefs`, 1, 32),
      controls: normalizeControls(item.controls, `reusedAssets[${index}].controls`),
    };
  });
  if (new Set(assets.map((item) => item.assetRef)).size !== assets.length) throw new TypeError("reusedAssets must have unique asset refs");
  return assets;
}

function normalizeChanges(value: unknown): OneImprovementChangeV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError("changes must contain 1-16 comparisons");
  const changes = value.map((item, index): OneImprovementChangeV1 => {
    if (!isRecord(item)) throw new TypeError(`changes[${index}] must be an object`);
    assertSafeId(item.changeRef, `changes[${index}].changeRef`);
    if (typeof item.kind !== "string" || !CHANGE_KINDS.has(item.kind)) throw new TypeError(`changes[${index}].kind is unsupported`);
    const common = {
      changeRef: item.changeRef,
      kind: item.kind as OneImprovementChangeV1["kind"],
      statement: cleanText(item.statement, `changes[${index}].statement`),
    };
    if (item.evidenceType === "measured") {
      assertOnlyKeys(item, ["changeRef", "kind", "evidenceType", "statement", "baseline", "current", "unit", "comparisonDirection", "evidenceRefs"], `changes[${index}]`);
      if (!["lower_is_better", "higher_is_better"].includes(String(item.comparisonDirection))) throw new TypeError("Measured comparisonDirection is invalid");
      return {
        ...common,
        evidenceType: "measured",
        baseline: finiteNumber(item.baseline, "measured baseline"),
        current: finiteNumber(item.current, "measured current"),
        unit: cleanText(item.unit, "measured unit", 160),
        comparisonDirection: item.comparisonDirection as OneImprovementComparisonDirection,
        evidenceRefs: safeIds(item.evidenceRefs, "measured evidenceRefs", 2, 32),
      };
    }
    if (item.evidenceType === "qualitative") {
      assertOnlyKeys(item, ["changeRef", "kind", "evidenceType", "statement", "baselineRefs", "currentRefs", "evidenceRefs"], `changes[${index}]`);
      return {
        ...common,
        evidenceType: "qualitative",
        baselineRefs: safeIds(item.baselineRefs, "qualitative baselineRefs", 1, 32),
        currentRefs: safeIds(item.currentRefs, "qualitative currentRefs", 1, 32),
        evidenceRefs: safeIds(item.evidenceRefs, "qualitative evidenceRefs", 1, 32),
      };
    }
    if (item.evidenceType !== "estimate") throw new TypeError(`changes[${index}].evidenceType is unsupported`);
    assertOnlyKeys(item, ["changeRef", "kind", "evidenceType", "statement", "estimate"], `changes[${index}]`);
    if (!isRecord(item.estimate)) throw new TypeError("estimate must be an object");
    assertOnlyKeys(item.estimate, ["value", "unit", "basis", "method", "evidenceRefs"], "estimate");
    return {
      ...common,
      evidenceType: "estimate",
      estimate: {
        value: finiteNumber(item.estimate.value, "estimate.value"),
        unit: cleanText(item.estimate.unit, "estimate.unit", 160),
        basis: cleanText(item.estimate.basis, "estimate.basis"),
        method: cleanText(item.estimate.method, "estimate.method"),
        evidenceRefs: safeIds(item.estimate.evidenceRefs, "estimate.evidenceRefs", 1, 32),
      },
    };
  });
  if (new Set(changes.map((item) => item.changeRef)).size !== changes.length) throw new TypeError("changes must have unique refs");
  return changes;
}

function normalizeAssetVersions(value: unknown, label: string): OneImprovementAssetVersionRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError(`${label} must contain 1-16 exact asset versions`);
  const refs = value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`${label}[${index}] must be an object`);
    assertOnlyKeys(item, ["assetId", "assetVersion"], `${label}[${index}]`);
    assertSafeId(item.assetId, `${label}[${index}].assetId`);
    assertVersion(item.assetVersion, `${label}[${index}].assetVersion`);
    return { assetId: item.assetId, assetVersion: item.assetVersion };
  });
  if (new Set(refs.map((item) => `${item.assetId}:${item.assetVersion}`)).size !== refs.length) throw new TypeError(`${label} must be unique`);
  return refs;
}

function normalizeControlRefs(value: unknown, label: string): OneImprovementAssetBinding["controlRefs"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new TypeError(`${label} must contain 1-4 controls`);
  const refs = value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`${label}[${index}] must be an object`);
    assertOnlyKeys(item, ["control", "controlRef"], `${label}[${index}]`);
    if (typeof item.control !== "string" || !CONTROLS.has(item.control as OneImprovementAssetControl)) throw new TypeError(`${label}[${index}] has an unsupported control`);
    assertSafeId(item.controlRef, `${label}[${index}].controlRef`);
    return { control: item.control as OneImprovementAssetControl, controlRef: item.controlRef };
  });
  if (new Set(refs.map((item) => item.control)).size !== refs.length || new Set(refs.map((item) => item.controlRef)).size !== refs.length) {
    throw new TypeError(`${label} must be unique`);
  }
  return refs;
}

function normalizeAssetBindings(value: unknown): OneImprovementAssetBinding[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError("assetBindings must contain 1-16 bindings");
  const bindings = value.map((item, index): OneImprovementAssetBinding => {
    if (!isRecord(item)) throw new TypeError(`assetBindings[${index}] must be an object`);
    assertOnlyKeys(item, [
      "assetId", "assetVersion", "assetKind", "sourceTaskId", "sourceTaskVersion", "currentTaskId",
      "currentTaskVersion", "taskKind", "reuseEvidenceRef", "reuseReceiptRef", "sourceControlRef",
      "controlRefs", "rollbackRef", "removeRef",
    ], `assetBindings[${index}]`);
    assertSafeId(item.assetId, `assetBindings[${index}].assetId`);
    assertVersion(item.assetVersion, `assetBindings[${index}].assetVersion`);
    if (typeof item.assetKind !== "string" || !RUNTIME_ASSET_KINDS.has(item.assetKind as OneImprovementRuntimeAssetKind)) throw new TypeError("assetBinding kind is unsupported");
    for (const [field, raw] of Object.entries({
      sourceTaskId: item.sourceTaskId, currentTaskId: item.currentTaskId, taskKind: item.taskKind,
      reuseEvidenceRef: item.reuseEvidenceRef, reuseReceiptRef: item.reuseReceiptRef,
      sourceControlRef: item.sourceControlRef, rollbackRef: item.rollbackRef, removeRef: item.removeRef,
    })) assertSafeId(raw, `assetBindings[${index}].${field}`);
    assertVersion(item.sourceTaskVersion, `assetBindings[${index}].sourceTaskVersion`);
    assertVersion(item.currentTaskVersion, `assetBindings[${index}].currentTaskVersion`);
    return {
      assetId: item.assetId,
      assetVersion: item.assetVersion,
      assetKind: item.assetKind as OneImprovementRuntimeAssetKind,
      sourceTaskId: item.sourceTaskId as string,
      sourceTaskVersion: item.sourceTaskVersion,
      currentTaskId: item.currentTaskId as string,
      currentTaskVersion: item.currentTaskVersion,
      taskKind: item.taskKind as string,
      reuseEvidenceRef: item.reuseEvidenceRef as string,
      reuseReceiptRef: item.reuseReceiptRef as string,
      sourceControlRef: item.sourceControlRef as string,
      controlRefs: normalizeControlRefs(item.controlRefs, `assetBindings[${index}].controlRefs`),
      rollbackRef: item.rollbackRef as string,
      removeRef: item.removeRef as string,
    };
  });
  if (new Set(bindings.map((item) => `${item.assetId}:${item.assetVersion}`)).size !== bindings.length) throw new TypeError("assetBindings must have unique exact asset versions");
  return bindings;
}

function normalizeComparisons(value: unknown): OneImprovementComparisonRecord[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError("comparisons must contain 1-16 records");
  const records = value.map((item, index): OneImprovementComparisonRecord => {
    if (!isRecord(item)) throw new TypeError(`comparisons[${index}] must be an object`);
    assertOnlyKeys(item, [
      "comparisonRef", "changeRef", "taskKind", "baselineTaskId", "baselineTaskVersion", "currentTaskId",
      "currentTaskVersion", "evidenceType", "result", "baselineOutputVerificationRef",
      "baselineOutcomeVerificationRef", "currentOutputVerificationRef", "currentOutcomeVerificationRef",
      "reusedAssetVersions", "comparisonEvidenceRef", "measurementEvidenceRefs", "rubricEvidenceRefs",
      "evidenceRefs", "receiptRefs",
    ], `comparisons[${index}]`);
    for (const [field, raw] of Object.entries({
      comparisonRef: item.comparisonRef, changeRef: item.changeRef, taskKind: item.taskKind,
      baselineTaskId: item.baselineTaskId, currentTaskId: item.currentTaskId,
      baselineOutputVerificationRef: item.baselineOutputVerificationRef,
      baselineOutcomeVerificationRef: item.baselineOutcomeVerificationRef,
      currentOutputVerificationRef: item.currentOutputVerificationRef,
      currentOutcomeVerificationRef: item.currentOutcomeVerificationRef,
      comparisonEvidenceRef: item.comparisonEvidenceRef,
    })) assertSafeId(raw, `comparisons[${index}].${field}`);
    assertVersion(item.baselineTaskVersion, `comparisons[${index}].baselineTaskVersion`);
    assertVersion(item.currentTaskVersion, `comparisons[${index}].currentTaskVersion`);
    if (typeof item.evidenceType !== "string" || !EVIDENCE_TYPES.has(item.evidenceType as OneImprovementEvidenceType)) throw new TypeError("comparison evidenceType is unsupported");
    if (typeof item.result !== "string" || !RESULTS.has(item.result as OneImprovementResult)) throw new TypeError("comparison result is unsupported");
    const measurementEvidenceRefs = item.measurementEvidenceRefs === undefined ? undefined : safeIds(item.measurementEvidenceRefs, "measurementEvidenceRefs", 2, 2);
    const rubricEvidenceRefs = item.rubricEvidenceRefs === undefined ? undefined : safeIds(item.rubricEvidenceRefs, "rubricEvidenceRefs", 2, 2);
    if (item.evidenceType === "qualitative" ? !rubricEvidenceRefs || measurementEvidenceRefs : !measurementEvidenceRefs || rubricEvidenceRefs) {
      throw new TypeError("comparison must provide exactly two evidence refs for its declared evidence type");
    }
    return {
      comparisonRef: item.comparisonRef as string,
      changeRef: item.changeRef as string,
      taskKind: item.taskKind as string,
      baselineTaskId: item.baselineTaskId as string,
      baselineTaskVersion: item.baselineTaskVersion,
      currentTaskId: item.currentTaskId as string,
      currentTaskVersion: item.currentTaskVersion,
      evidenceType: item.evidenceType as OneImprovementEvidenceType,
      result: item.result as OneImprovementResult,
      baselineOutputVerificationRef: item.baselineOutputVerificationRef as string,
      baselineOutcomeVerificationRef: item.baselineOutcomeVerificationRef as string,
      currentOutputVerificationRef: item.currentOutputVerificationRef as string,
      currentOutcomeVerificationRef: item.currentOutcomeVerificationRef as string,
      reusedAssetVersions: normalizeAssetVersions(item.reusedAssetVersions, `comparisons[${index}].reusedAssetVersions`),
      comparisonEvidenceRef: item.comparisonEvidenceRef as string,
      ...(measurementEvidenceRefs ? { measurementEvidenceRefs } : {}),
      ...(rubricEvidenceRefs ? { rubricEvidenceRefs } : {}),
      evidenceRefs: safeIds(item.evidenceRefs, `comparisons[${index}].evidenceRefs`, 1, 64),
      receiptRefs: safeIds(item.receiptRefs, `comparisons[${index}].receiptRefs`, 1, 64),
    };
  });
  if (new Set(records.map((item) => item.comparisonRef)).size !== records.length) throw new TypeError("comparisons must have unique refs");
  if (new Set(records.map((item) => item.changeRef)).size !== records.length) throw new TypeError("comparisons must target unique changes");
  return records;
}

function normalizeTrustedEvidence(value: unknown): OneTrustedImprovementEvidence[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) throw new TypeError("trustedHostEvidence must contain 1-256 attestations");
  const normalized = value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`trustedHostEvidence[${index}] must be an object`);
    if (!isOneTrustedImprovementEvidence(item)) throw new TypeError(`trustedHostEvidence[${index}] violates the closed evidence contract`);
    return { ...item, observedAt: timestamp(item.observedAt, `trustedHostEvidence[${index}].observedAt`) } as OneTrustedImprovementEvidence;
  });
  if (new Set(normalized.map((item) => item.evidenceRef)).size !== normalized.length) throw new TypeError("trusted evidence references must be unique");
  if (new Set(normalized.map((item) => item.receiptRef)).size !== normalized.length) throw new TypeError("trusted receipt references must be unique");
  return normalized;
}

function evidenceByRef(evidence: OneTrustedImprovementEvidence[]): Map<string, OneTrustedImprovementEvidence> {
  return new Map(evidence.map((item) => [item.evidenceRef, item]));
}

function taskEvidenceFor(
  evidence: OneTrustedImprovementEvidence[],
  kind: OneTrustedImprovementTaskEvidence["kind"],
  verificationRef: string,
  taskId: string,
  taskVersion: number,
  taskKind: string,
): OneTrustedImprovementTaskEvidence {
  const matches = evidence.filter((item): item is OneTrustedImprovementTaskEvidence =>
    item.kind === kind && item.verificationRef === verificationRef && item.taskId === taskId
      && item.taskVersion === taskVersion && item.taskKind === taskKind,
  );
  if (matches.length !== 1) throw new Error(`${kind} ${verificationRef} is not uniquely bound to exact Task ${taskId}@${taskVersion}`);
  return matches[0];
}

function resultForNumbers(
  baseline: number,
  current: number,
  direction: OneImprovementComparisonDirection,
): OneImprovementResult {
  if (current === baseline) return "no_change";
  if (direction === "lower_is_better") return current < baseline ? "improved" : "regression";
  return current > baseline ? "improved" : "regression";
}

function evidenceRefsForChange(change: OneImprovementChangeV1): string[] {
  return change.evidenceType === "estimate" ? change.estimate.evidenceRefs : change.evidenceRefs;
}

function assertMeasurementSemantics(
  comparison: OneImprovementComparisonRecord,
  change: OneImprovementChangeV1,
  evidence: OneTrustedImprovementEvidence[],
): void {
  const refs = comparison.measurementEvidenceRefs ?? [];
  const measurements = refs.map((ref) => evidence.find((item): item is OneTrustedImprovementMeasurementEvidence =>
    item.kind === "measurement" && item.evidenceRef === ref,
  ));
  if (measurements.some((item) => !item)) throw new Error(`Comparison ${comparison.comparisonRef} lacks exact measurement evidence`);
  const baseline = measurements.find((item) => item?.role === "baseline")!;
  const current = measurements.find((item) => item?.role === "current")!;
  if (!baseline || !current || baseline === current) throw new Error(`Comparison ${comparison.comparisonRef} requires one baseline and one current measurement`);
  for (const item of [baseline, current]) {
    if (item.comparisonRef !== comparison.comparisonRef || item.taskKind !== comparison.taskKind) throw new Error("Measurement is bound to a different comparison kind");
    if (item.baselineTaskId !== comparison.baselineTaskId || item.baselineTaskVersion !== comparison.baselineTaskVersion
      || item.currentTaskId !== comparison.currentTaskId || item.currentTaskVersion !== comparison.currentTaskVersion) {
      throw new Error("Measurement is not bound to exact baseline/current Task versions");
    }
    if (!item.comparable) throw new Error("Numeric Improvement Proof requires explicitly comparable samples");
  }
  if (baseline.unit !== current.unit || baseline.method !== current.method || baseline.comparabilityBasis !== current.comparabilityBasis
    || baseline.comparisonDirection !== current.comparisonDirection) {
    throw new Error("Numeric baseline and current measurements are not comparable by unit, method, basis, and direction");
  }
  if (baseline.sampleSize < 1 || current.sampleSize < 1) throw new Error("Numeric comparison requires explicit positive sample sizes");
  const expectedValueType = comparison.evidenceType === "measured" ? "fact" : "estimate";
  if (baseline.valueType !== expectedValueType || current.valueType !== expectedValueType) {
    throw new Error(`${comparison.evidenceType} comparison must declare ${expectedValueType} measurements`);
  }
  if (change.evidenceType === "measured") {
    if (change.baseline !== baseline.value || change.current !== current.value || change.unit !== baseline.unit) {
      throw new Error("Measured public values do not match trusted measurements");
    }
    const derived = resultForNumbers(baseline.value, current.value, change.comparisonDirection);
    if (derived !== comparison.result) throw new Error(`Measured result must be ${derived}`);
  } else if (change.evidenceType === "estimate") {
    if (change.estimate.unit !== baseline.unit || change.estimate.method !== baseline.method
      || change.estimate.basis !== baseline.comparabilityBasis) {
      throw new Error("Estimate unit, method, and basis do not match trusted estimated measurements");
    }
    if (change.estimate.value !== Math.abs(current.value - baseline.value)) {
      throw new Error("Estimate value must equal the absolute baseline/current delta");
    }
    const derived = resultForNumbers(baseline.value, current.value, baseline.comparisonDirection);
    if (derived !== comparison.result) throw new Error(`Estimated result must be ${derived}`);
  } else {
    throw new Error("Numeric evidence cannot support a qualitative change");
  }
  if (!sameSet(evidenceRefsForChange(change), comparison.evidenceRefs)
    || !refs.every((ref) => comparison.evidenceRefs.includes(ref))
    || !comparison.evidenceRefs.includes(comparison.comparisonEvidenceRef)) {
    throw new Error("Public numeric evidence refs must exactly match and include the comparison and both measurements");
  }
}

function assertRubricSemantics(
  comparison: OneImprovementComparisonRecord,
  change: OneImprovementChangeV1,
  evidence: OneTrustedImprovementEvidence[],
): void {
  if (change.evidenceType !== "qualitative") throw new Error("Rubric evidence can support only a qualitative change");
  const refs = comparison.rubricEvidenceRefs ?? [];
  const assessments = refs.map((ref) => evidence.find((item): item is OneTrustedImprovementRubricEvidence =>
    item.kind === "rubric_assessment" && item.evidenceRef === ref,
  ));
  if (assessments.some((item) => !item)) throw new Error(`Comparison ${comparison.comparisonRef} lacks exact rubric evidence`);
  const baseline = assessments.find((item) => item?.role === "baseline")!;
  const current = assessments.find((item) => item?.role === "current")!;
  if (!baseline || !current || baseline === current) throw new Error("Qualitative comparison requires one baseline and one current rubric assessment");
  if (baseline.taskId !== comparison.baselineTaskId || baseline.taskVersion !== comparison.baselineTaskVersion
    || current.taskId !== comparison.currentTaskId || current.taskVersion !== comparison.currentTaskVersion) {
    throw new Error("Rubric assessments are not bound to exact baseline/current Task versions");
  }
  if (baseline.comparisonRef !== comparison.comparisonRef || current.comparisonRef !== comparison.comparisonRef
    || baseline.taskKind !== comparison.taskKind || current.taskKind !== comparison.taskKind) {
    throw new Error("Rubric assessments are bound to a different comparison kind");
  }
  if (baseline.rubricRef !== current.rubricRef || !sameSet(baseline.criterionRefs, current.criterionRefs)
    || baseline.comparisonDirection !== current.comparisonDirection) {
    throw new Error("Qualitative comparison must use the same explicit rubric, criteria, and direction");
  }
  if (!sameSet(change.baselineRefs, [baseline.assessmentRef]) || !sameSet(change.currentRefs, [current.assessmentRef])) {
    throw new Error("Qualitative public assessment refs do not match trusted rubric assessments");
  }
  const derived = resultForNumbers(baseline.ordinalRank, current.ordinalRank, baseline.comparisonDirection);
  if (derived !== comparison.result) throw new Error(`Qualitative rubric result must be ${derived}`);
  if (!sameSet(change.evidenceRefs, comparison.evidenceRefs)
    || !refs.every((ref) => comparison.evidenceRefs.includes(ref))
    || !comparison.evidenceRefs.includes(comparison.comparisonEvidenceRef)) {
    throw new Error("Public qualitative evidence refs must exactly match and include the comparison and both rubric assessments");
  }
}

function assertEvidenceSemantics(input: {
  currentTask: CanonicalTask;
  taskKind: string;
  reusedAssets: OneImprovementReusedAssetV1[];
  changes: OneImprovementChangeV1[];
  assetBindings: OneImprovementAssetBinding[];
  comparisons: OneImprovementComparisonRecord[];
  receiptRefs: string[];
  evidence: OneTrustedImprovementEvidence[];
}): void {
  const evidenceMap = evidenceByRef(input.evidence);
  if (input.assetBindings.length !== input.reusedAssets.length || input.comparisons.length !== input.changes.length) {
    throw new Error("Every public asset and change requires exactly one trusted binding");
  }
  const taskCache = new Map<string, CanonicalTask>();
  const assertTask = (taskId: string, taskVersion: number, label: string) => {
    const key = `${taskId}:${taskVersion}`;
    let task = taskCache.get(key);
    if (!task) {
      task = taskAtVersion(taskId, taskVersion, label);
      taskCache.set(key, task);
    }
    return task;
  };
  assertTask(input.currentTask.id, input.currentTask.version, "current");

  const usedEvidence = new Set<string>();
  const use = (ref: string): OneTrustedImprovementEvidence => {
    const item = evidenceMap.get(ref);
    if (!item) throw new Error(`Evidence ${ref} is not present at the trusted host boundary`);
    usedEvidence.add(ref);
    return item;
  };

  for (const binding of input.assetBindings) {
    if (binding.currentTaskId !== input.currentTask.id || binding.currentTaskVersion !== input.currentTask.version || binding.taskKind !== input.taskKind) {
      throw new Error(`Asset ${binding.assetId}@${binding.assetVersion} is not bound to the exact current Task kind/version`);
    }
    if (binding.sourceTaskId === binding.currentTaskId) throw new Error("A reused asset must originate from an earlier distinct Task");
    assertTask(binding.sourceTaskId, binding.sourceTaskVersion, "asset source");
    const publicAsset = input.reusedAssets.find((item) => item.assetRef === binding.assetId);
    if (!publicAsset || publicAsset.assetType !== binding.assetKind || publicAsset.sourceTaskRef !== binding.sourceTaskId) {
      throw new Error(`Public reused asset ${binding.assetId} does not match its exact binding`);
    }
    if (!sameSet(publicAsset.controls, binding.controlRefs.map((item) => item.control))) {
      throw new Error(`Asset ${binding.assetId} controls do not match their content-free refs`);
    }
    if (!sameSet(publicAsset.receiptRefs, [binding.reuseReceiptRef])) {
      throw new Error(`Asset ${binding.assetId} must expose exactly its trusted reuse receipt`);
    }
    const attestation = use(binding.reuseEvidenceRef);
    if (attestation.kind !== "asset_reuse") throw new Error(`Asset ${binding.assetId} lacks an asset_reuse attestation`);
    const expected: OneTrustedImprovementAssetReuseEvidence = attestation;
    if (expected.receiptRef !== binding.reuseReceiptRef || expected.taskKind !== binding.taskKind
      || expected.taskId !== binding.currentTaskId || expected.taskVersion !== binding.currentTaskVersion
      || expected.sourceTaskId !== binding.sourceTaskId || expected.sourceTaskVersion !== binding.sourceTaskVersion
      || expected.assetId !== binding.assetId || expected.assetVersion !== binding.assetVersion || expected.assetKind !== binding.assetKind
      || expected.sourceControlRef !== binding.sourceControlRef || !sameSet(expected.controlRefs.map((item) => `${item.control}:${item.controlRef}`), binding.controlRefs.map((item) => `${item.control}:${item.controlRef}`))
      || expected.rollbackRef !== binding.rollbackRef || expected.removeRef !== binding.removeRef) {
      throw new Error(`Asset ${binding.assetId}@${binding.assetVersion} attestation does not match its binding and controls`);
    }
  }

  for (const comparison of input.comparisons) {
    if (comparison.currentTaskId !== input.currentTask.id || comparison.currentTaskVersion !== input.currentTask.version || comparison.taskKind !== input.taskKind) {
      throw new Error(`Comparison ${comparison.comparisonRef} is not bound to the exact current Task kind/version`);
    }
    if (comparison.baselineTaskId === comparison.currentTaskId) throw new Error("Improvement baseline must be a distinct earlier Task");
    assertTask(comparison.baselineTaskId, comparison.baselineTaskVersion, "baseline");
    const change = input.changes.find((item) => item.changeRef === comparison.changeRef);
    if (!change || change.evidenceType !== comparison.evidenceType) throw new Error(`Comparison ${comparison.comparisonRef} does not match one public change`);
    const boundAssetVersions = comparison.reusedAssetVersions.map((ref) => input.assetBindings.find((item) => item.assetId === ref.assetId && item.assetVersion === ref.assetVersion));
    if (boundAssetVersions.some((item) => !item)) throw new Error(`Comparison ${comparison.comparisonRef} cites an unbound asset version`);

    const baselineOutput = taskEvidenceFor(input.evidence, "output_verification", comparison.baselineOutputVerificationRef, comparison.baselineTaskId, comparison.baselineTaskVersion, input.taskKind);
    const baselineOutcome = taskEvidenceFor(input.evidence, "outcome_verification", comparison.baselineOutcomeVerificationRef, comparison.baselineTaskId, comparison.baselineTaskVersion, input.taskKind);
    const currentOutput = taskEvidenceFor(input.evidence, "output_verification", comparison.currentOutputVerificationRef, comparison.currentTaskId, comparison.currentTaskVersion, input.taskKind);
    const currentOutcome = taskEvidenceFor(input.evidence, "outcome_verification", comparison.currentOutcomeVerificationRef, comparison.currentTaskId, comparison.currentTaskVersion, input.taskKind);
    [baselineOutput, baselineOutcome, currentOutput, currentOutcome].forEach((item) => usedEvidence.add(item.evidenceRef));

    const attestation = use(comparison.comparisonEvidenceRef);
    if (attestation.kind !== "comparison_verification") throw new Error(`Comparison ${comparison.comparisonRef} lacks comparison verification`);
    const expected: OneTrustedImprovementComparisonEvidence = attestation;
    if (expected.taskKind !== comparison.taskKind || expected.baselineTaskId !== comparison.baselineTaskId
      || expected.baselineTaskVersion !== comparison.baselineTaskVersion || expected.currentTaskId !== comparison.currentTaskId
      || expected.currentTaskVersion !== comparison.currentTaskVersion || expected.comparisonRef !== comparison.comparisonRef
      || expected.evidenceType !== comparison.evidenceType || expected.result !== comparison.result
      || expected.baselineOutputVerificationRef !== comparison.baselineOutputVerificationRef
      || expected.baselineOutcomeVerificationRef !== comparison.baselineOutcomeVerificationRef
      || expected.currentOutputVerificationRef !== comparison.currentOutputVerificationRef
      || expected.currentOutcomeVerificationRef !== comparison.currentOutcomeVerificationRef
      || !sameAssetVersions(expected.reusedAssetVersions, comparison.reusedAssetVersions)) {
      throw new Error(`Comparison ${comparison.comparisonRef} attestation does not cross-bind exact Tasks, verification refs, and asset versions`);
    }

    if (comparison.evidenceType === "qualitative") {
      assertRubricSemantics(comparison, change, input.evidence);
      comparison.rubricEvidenceRefs?.forEach((ref) => usedEvidence.add(ref));
    } else {
      assertMeasurementSemantics(comparison, change, input.evidence);
      comparison.measurementEvidenceRefs?.forEach((ref) => usedEvidence.add(ref));
    }
    if (!comparison.evidenceRefs.every((ref) => evidenceMap.has(ref))) throw new Error("Comparison evidenceRefs must resolve to trusted evidence");
    comparison.evidenceRefs.forEach((ref) => usedEvidence.add(ref));
    const comparisonEvidenceReceipts = comparison.evidenceRefs.map((ref) => evidenceMap.get(ref)!.receiptRef);
    if (!sameSet(comparison.receiptRefs, comparisonEvidenceReceipts)) throw new Error("Comparison receiptRefs must exactly match its trusted evidence");
  }

  for (const binding of input.assetBindings) {
    if (!input.comparisons.some((item) => item.reusedAssetVersions.some((ref) => ref.assetId === binding.assetId && ref.assetVersion === binding.assetVersion))) {
      throw new Error(`Asset ${binding.assetId}@${binding.assetVersion} is not used by any comparison`);
    }
  }
  if (usedEvidence.size !== input.evidence.length) {
    const unused = input.evidence.filter((item) => !usedEvidence.has(item.evidenceRef)).map((item) => item.evidenceRef);
    throw new Error(`Trusted evidence is not used by this proof: ${unused.join(",")}`);
  }
  const expectedReceipts = input.evidence.map((item) => item.receiptRef);
  if (!sameSet(input.receiptRefs, expectedReceipts)) throw new Error("receiptRefs must exactly match all trusted host evidence receipts");
}

function mergeEvidence(
  current: OneImprovementProofState,
  incoming: OneTrustedImprovementEvidence[],
): OneTrustedImprovementEvidence[] {
  const byRef = new Map(current.evidence.map((item) => [item.evidenceRef, item]));
  const byReceipt = new Map(current.evidence.map((item) => [item.receiptRef, item]));
  const appended: OneTrustedImprovementEvidence[] = [];
  for (const candidate of incoming) {
    const existingRef = byRef.get(candidate.evidenceRef);
    const existingReceipt = byReceipt.get(candidate.receiptRef);
    if (existingRef || existingReceipt) {
      if (!existingRef || existingRef !== existingReceipt || JSON.stringify(existingRef) !== JSON.stringify(candidate)) {
        throw new Error(`Trusted improvement evidence collision: ${candidate.evidenceRef}`);
      }
      continue;
    }
    byRef.set(candidate.evidenceRef, candidate);
    byReceipt.set(candidate.receiptRef, candidate);
    appended.push(candidate);
  }
  return [...current.evidence, ...appended];
}

function baselineTasksFor(comparisons: OneImprovementComparisonRecord[]) {
  return [...new Map(comparisons.map((item) => [
    `${item.baselineTaskId}:${item.baselineTaskVersion}`,
    { taskId: item.baselineTaskId, taskVersion: item.baselineTaskVersion },
  ])).values()];
}

function visibilityFor(task: CanonicalTask): "personal" | "project" {
  return task.projectId ? "project" : "personal";
}

function evidenceSourceRefs(item: OneTrustedImprovementEvidence): string[] {
  switch (item.kind) {
    case "output_verification":
    case "outcome_verification":
      return [item.sourceRef, item.verificationRef];
    case "asset_reuse":
      return [item.sourceRef, item.assetId, item.sourceControlRef, item.rollbackRef, item.removeRef];
    case "measurement":
      return [item.sourceRef, item.comparisonRef];
    case "rubric_assessment":
      return [item.sourceRef, item.comparisonRef, item.rubricRef, item.assessmentRef];
    case "comparison_verification":
      return [item.sourceRef, item.comparisonRef, ...item.reusedAssetVersions.map((ref) => ref.assetId)];
  }
}

function evidenceTaskId(item: OneTrustedImprovementEvidence): string {
  switch (item.kind) {
    case "output_verification":
    case "outcome_verification":
    case "asset_reuse":
    case "rubric_assessment":
      return item.taskId;
    case "measurement":
    case "comparison_verification":
      return item.currentTaskId;
  }
}

function recordProofEvents(task: CanonicalTask, record: OneImprovementProofRecord, evidence: OneTrustedImprovementEvidence[]): void {
  const visibility = visibilityFor(task);
  for (const item of evidence) {
    recordOneDomainEvent({
      eventType: "receipt.recorded",
      occurredAt: item.observedAt,
      actor: "system",
      entityId: item.evidenceRef,
      ...(task.projectId ? { projectId: task.projectId } : {}),
      taskId: evidenceTaskId(item),
      version: 1,
      visibility,
      entries: [
        { name: "receiptId", value: item.receiptRef },
        { name: "kind", value: `trusted_improvement_${item.kind}` },
        { name: "sourceOrRunRefs", value: [...new Set(evidenceSourceRefs(item))] },
      ],
    });
  }
  // Use only the exact authoritative catalog name. Never invent a substitute.
  if ("improvement.proof_ready" in ONE_DOMAIN_EVENT_RULES) {
    recordOneDomainEvent({
      eventType: "improvement.proof_ready",
      occurredAt: record.proof.generatedAt,
      actor: "system",
      entityId: record.proof.improvementProofId,
      ...(task.projectId ? { projectId: task.projectId } : {}),
      taskId: task.id,
      version: record.version,
      visibility,
      entries: [
        { name: "improvementProofRef", value: record.proof.improvementProofId },
        { name: "reusedAssetRefs", value: record.assetBindings.map((item) => `${item.assetId}:v${item.assetVersion}`) },
        { name: "baselineRefs", value: record.baselineTasks.map((item) => `${item.taskId}:v${item.taskVersion}`) },
        { name: "evidenceType", value: [...new Set(record.comparisons.map((item) => item.evidenceType))] },
      ],
    });
  }
}

export function getOneImprovementProofState(): OneImprovementProofState {
  return readOrCreateState().state;
}

export function listOneImprovementProofs(taskId?: string): OneImprovementProofRecord[] {
  if (taskId !== undefined) assertSafeId(taskId, "taskId");
  return getOneImprovementProofState().proofs.filter((item) => taskId === undefined || item.proof.taskId === taskId);
}

export function getLatestOneImprovementProof(taskId: string): OneImprovementProofRecord | null {
  const records = listOneImprovementProofs(taskId);
  return records.length > 0 ? records[records.length - 1] : null;
}

/**
 * Trusted Electron Main producer only. A completed Task, accepted result, or
 * model-authored claim is intentionally insufficient without the exact host
 * attestations validated below. This function must never be exposed to IPC.
 */
export function createOneImprovementProof(
  input: CreateOneImprovementProofInput,
): OneImprovementProofMutationResult<OneImprovementProofRecord> {
  if (!isRecord(input)) throw new TypeError("Improvement Proof input must be an object");
  assertOnlyKeys(input, [
    "expectedStoreVersion", "trustedHostAttested", "currentTaskId", "currentTaskVersion", "taskKind",
    "attributionStatus", "reusedAssets", "changes", "assetBindings", "comparisons", "receiptRefs", "trustedHostEvidence",
  ], "Improvement Proof input");
  assertVersion(input.expectedStoreVersion, "expectedStoreVersion");
  if (input.trustedHostAttested !== true) throw new Error("Improvement Proof requires a trusted Main host attestation boundary");
  assertSafeId(input.taskKind, "taskKind");
  if (input.attributionStatus !== "established" && input.attributionStatus !== "not_established") {
    throw new TypeError("attributionStatus must be established or not_established");
  }

  const db = getDb();
  const create = db.transaction(() => {
    const current = readOrCreateState();
    if (current.state.version !== input.expectedStoreVersion) {
      throw new Error(`One Improvement Proof state changed (expected ${input.expectedStoreVersion}, current ${current.state.version})`);
    }
    const currentTask = taskAtVersion(input.currentTaskId, input.currentTaskVersion, "current");
    const reusedAssets = normalizeReusedAssets(input.reusedAssets);
    const changes = normalizeChanges(input.changes);
    const assetBindings = normalizeAssetBindings(input.assetBindings);
    const comparisons = normalizeComparisons(input.comparisons);
    const receiptRefs = safeIds(input.receiptRefs, "receiptRefs", 1, 128);
    const evidence = normalizeTrustedEvidence(input.trustedHostEvidence);

    if (current.state.proofs.some((item) => item.proof.taskId === currentTask.id && item.currentTaskVersion === currentTask.version)) {
      throw new Error("An Improvement Proof already exists for this exact canonical Task version");
    }
    assertEvidenceSemantics({ currentTask, taskKind: input.taskKind, reusedAssets, changes, assetBindings, comparisons, receiptRefs, evidence });

    const tick = nextTimestamp(current.state.version);
    const hasImprovement = comparisons.some((item) => item.result === "improved");
    const proof = {
      contractVersion: ONE_IMPROVEMENT_PROOF_CONTRACT_VERSION,
      improvementProofId: `improvement_proof_${randomUUID().replaceAll("-", "")}`,
      taskId: currentTask.id,
      status: "verified",
      generatedAt: tick.iso,
      placement: "after_value_closure",
      collapsedByDefault: true,
      compoundingStep: hasImprovement && input.attributionStatus === "established" ? "improved_result" : "reused",
      attributionStatus: input.attributionStatus,
      reusedAssets,
      changes,
      receiptRefs,
      convertedToEngagementScore: false,
    } as const;
    if (!isOneImprovementProofV1(proof)) throw new Error("Improvement Proof violated its closed public contract");
    const record: OneImprovementProofRecord = {
      proof,
      version: 1,
      taskKind: input.taskKind,
      currentTaskVersion: currentTask.version,
      baselineTasks: baselineTasksFor(comparisons),
      assetBindings,
      comparisons,
      trustedEvidenceRefs: evidence.map((item) => item.evidenceRef),
      createdAt: tick.iso,
      updatedAt: tick.iso,
    };
    const next: OneImprovementProofState = {
      ...current.state,
      version: tick.version,
      evidence: mergeEvidence(current.state, evidence),
      proofs: [...current.state.proofs, record],
      updatedAt: tick.iso,
    };
    if (!isOneImprovementProofState(next)) throw new Error("Improvement Proof mutation violated the closed storage contract");
    const result = db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(next), ONE_IMPROVEMENT_PROOF_META_KEY, current.raw);
    if (result.changes !== 1) throw new Error("One Improvement Proof state changed concurrently; reload and try again");
    recordProofEvents(currentTask, record, evidence);
    return { storeVersion: next.version, updatedAt: next.updatedAt, value: record };
  });
  return create.immediate();
}
