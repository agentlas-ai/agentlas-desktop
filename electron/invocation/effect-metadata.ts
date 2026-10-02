import { parseScienceSchemaRejectionSettlement } from "./science-schema-rejection";
import type { AdapterEffectAdmission, AdapterEffectReport } from "./adapter-effect-context";
import type { RuntimeEffectBoundaryReceipt } from "./effect-boundary";
import type { McpInvocationEvent } from "../../shared/types";
import { parseScienceToolCorrelation } from "./science-failure-settlement";
import { parseScienceNativeFailureObservation } from "./science-native-failure";

export const EFFECT_METADATA_MAX_BYTES = 2 * 1024 * 1024;
/** Main owns this dispatch phase; provider output cannot supply this receipt. */
export const MAIN_TOOL_PREDISPATCH_PROTOCOL = "main-tool-predispatch.v1";
export interface MainHostControlObservation {
  controlId: string;
  auditEventId: string;
  auditKind: string;
  controlKind: "validation" | "selection-observation" | "authority-supersession" | "contract-refinement";
  projectionSha256: string;
  auditPayloadSha256: string;
  storedProjectionSha256?: string;
}
const mainHostControls = new WeakMap<McpInvocationEvent, MainHostControlObservation>();
/** This brand lives in Main memory; a provider's event fields cannot issue it. */
export function bindMainHostControlEvent(event: McpInvocationEvent, observation: MainHostControlObservation): void { mainHostControls.set(event, observation); }
export function mainHostControlForEvent(event: McpInvocationEvent): MainHostControlObservation | undefined { return mainHostControls.get(event); }
export function isMainLinkedAdapterScope(scope: AdapterEffectAdmission, runId: string, chatId: string, admissions: readonly AdapterEffectAdmission[] = []): boolean {
  const seen = new Set<string>();
  let current = scope;
  for (;;) {
    if (current.chatId !== chatId || current.purpose !== undefined || !current.parentScopeId || !current.dispatchId || seen.has(current.scopeId)) return false;
    seen.add(current.scopeId);
    if (current.parentScopeId === `${runId}:root`) return true;
    const parent = admissions.find(candidate => candidate.scopeId === current.parentScopeId);
    if (!parent) return false;
    if (parent.rootBound && parent.chatId === chatId && parent.purpose === undefined) return true;
    current = parent;
  }
}
/** Failed workflow is quiescent only under complete, exact Main-scoped dispatch coverage. */
export function hasClosedScopedEffects(scopes: NonNullable<RuntimeEffectBoundaryReceipt["adapterScopes"]>, operations: ReadonlyArray<Pick<RuntimeEffectBoundaryReceipt["operations"][number], "toolId" | "startObserved" | "resultObserved" | "outcome">>, runId: string, chatId: string): boolean {
  return scopes.length > 0 && scopes.every(scope => (scope.rootBound || isMainLinkedAdapterScope(scope, runId, chatId, scopes))
    && scope.chatId === chatId && scope.report?.protocol === "main-scoped-adapter.v1" && scope.report.complete
    && scope.report.quiesced === true && scope.report.reasons.length === 0)
    && scopes.every(scope => !scope.parentScopeId || scope.report!.operationIds.every(id => id.startsWith(`${scope.scopeId}:tool:`)))
    && operations.every(operation => operation.toolId && operation.startObserved && operation.resultObserved && operation.outcome === "succeeded"
      && scopes.filter(scope => scope.report!.operationIds.includes(operation.toolId!)).length === 1)
    && scopes.every(scope => scope.report!.operationIds.every(id => operations.filter(operation => operation.toolId === id).length === 1));
}
export function isMainToolPreDispatchRejectionReport(report: AdapterEffectReport): boolean {
  return report.protocol === MAIN_TOOL_PREDISPATCH_PROTOCOL && report.complete
    && report.terminal === "pre_dispatch_rejected" && report.operationIds.length === 1
    && report.settledFailureIds?.length === 1 && report.settledFailureIds[0] === report.operationIds[0]
    && report.frameKinds.length === 1 && report.frameKinds[0] === "main_dispatch_rejected" && report.reasons.length === 0;
}
const fail = (): never => { throw new Error("runtime-effect-metadata-invalid"); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  if (Object.keys(value).some(key => !keys.includes(key))) return fail();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  // Closed metadata identities only. No prompt, output, URL query or credential field.
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:/@-]{1,512}$/.test(value)) return fail();
  return value;
}
function nullableId(value: unknown): string | null { return value === null ? null : id(value); }
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : fail(); }
function count(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail(); }
function array<T>(value: unknown, parse: (item: unknown) => T, max = 4096): T[] {
  if (!Array.isArray(value)) return fail();
  if (value.length > max) throw new Error("runtime-effect-metadata-overflow");
  return value.map(parse);
}
function report(value: unknown): AdapterEffectReport {
  const v = object(value, ["schemaVersion", "protocol", "complete", "terminal", "operationIds", "frameKinds", "reasons", "settledFailureIds", "quiesced", "effectClass", "requestDigest", "responseDigest"]);
  if (v.schemaVersion !== "agentlas.adapter-effect-coverage.v1") return fail();
  const result: AdapterEffectReport = { schemaVersion: v.schemaVersion, protocol: id(v.protocol), complete: bool(v.complete), terminal: nullableId(v.terminal),
    operationIds: array(v.operationIds, id), frameKinds: array(v.frameKinds, id, 128), reasons: array(v.reasons, id, 128),
    ...(v.settledFailureIds === undefined ? {} : { settledFailureIds: array(v.settledFailureIds, id) }),
    ...(v.quiesced === undefined ? {} : { quiesced: bool(v.quiesced) }),
    ...(v.effectClass === undefined ? {} : { effectClass: v.effectClass === "remote-control-write" ? v.effectClass : fail() }) };
  for (const key of ["requestDigest", "responseDigest"] as const) if (v[key] !== undefined) {
    if (typeof v[key] !== "string" || !/^[a-f0-9]{64}$/.test(v[key])) return fail();
    result[key] = v[key] as string;
  }
  if (result.effectClass && (!result.requestDigest || !result.responseDigest) && result.complete) return fail();
  if (new Set(result.operationIds).size !== result.operationIds.length || (result.complete && result.reasons.length)) return fail();
  if (result.settledFailureIds && (new Set(result.settledFailureIds).size !== result.settledFailureIds.length || result.settledFailureIds.some(value => !result.operationIds.includes(value)))) return fail();
  return result;
}
function admission(value: unknown, runId: string, completed: boolean): AdapterEffectAdmission & { report?: AdapterEffectReport | null } {
  const v = object(value, ["scopeId", "adapterKind", "chatId", "agentId", "rootBound", "purpose", "parentScopeId", "dispatchId", ...(completed ? ["report"] : [])]);
  const scopeId = id(v.scopeId);
  if (!scopeId.startsWith(`${runId}:`)) return fail();
  if (v.purpose !== undefined && v.purpose !== "preparation") return fail();
  if (v.purpose === "preparation" && v.rootBound !== false) return fail();
  if ((v.parentScopeId === undefined) !== (v.dispatchId === undefined) || (v.parentScopeId !== undefined && (!id(v.parentScopeId).startsWith(`${runId}:`) || v.parentScopeId === scopeId)) || (v.purpose !== undefined && v.parentScopeId !== undefined)) return fail();
  return { scopeId, adapterKind: id(v.adapterKind), chatId: nullableId(v.chatId), agentId: nullableId(v.agentId), rootBound: bool(v.rootBound),
    ...(v.purpose === "preparation" ? { purpose: "preparation" as const } : {}),
    ...(v.parentScopeId === undefined ? {} : { parentScopeId: id(v.parentScopeId), dispatchId: id(v.dispatchId) }),
    ...(completed ? { report: v.report === null ? null : report(v.report) } : {}) };
}
function controlObservation(value: unknown, runId: string): MainHostControlObservation {
  const v = object(value, ["controlId", "auditEventId", "auditKind", "controlKind", "projectionSha256", "auditPayloadSha256", "storedProjectionSha256"]);
  const controlId = id(v.controlId);
  const allowedAuditKinds: Record<string, string[]> = { validation: ["workforce_schema_attempt"], "selection-observation": ["workforce_hub_tool_observation"],
    "authority-supersession": ["workforce_hub_tool_supersession", "workforce_leader_decision_supersession"], "contract-refinement": ["workforce_work_order_refinement"] };
  if (controlId !== `${runId}:control:${id(v.auditEventId)}` || !allowedAuditKinds[String(v.controlKind)]?.includes(String(v.auditKind))
    || typeof v.projectionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.projectionSha256)
    || typeof v.auditPayloadSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.auditPayloadSha256)
    || (v.storedProjectionSha256 !== undefined && (typeof v.storedProjectionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.storedProjectionSha256)))) return fail();
  return { controlId, auditEventId: id(v.auditEventId), auditKind: String(v.auditKind), controlKind: v.controlKind as MainHostControlObservation["controlKind"], projectionSha256: v.projectionSha256, auditPayloadSha256: v.auditPayloadSha256,
    ...(v.storedProjectionSha256 === undefined ? {} : { storedProjectionSha256: v.storedProjectionSha256 as string }) };
}
export function parseEffectMetadata(kind: string, value: unknown, runId: string): Record<string, unknown> | null {
  if (kind === "runtime_host_control_observed") return { ...controlObservation(value, runId) };
  if (kind === "runtime_science_schema_rejection_verified") {
    const proof = parseScienceSchemaRejectionSettlement(value);
    if (proof.binding.invocationRunId !== runId) return fail();
    return { ...proof };
  }
  if (kind === "runtime_science_native_failure_observed") {
    const v = object(value, ["observation", "conflictingObservation"]);
    const observation = parseScienceNativeFailureObservation(v.observation);
    if (observation.binding.invocationRunId !== runId) return fail();
    return { observation, conflictingObservation: bool(v.conflictingObservation) };
  }
  if (kind === "runtime_science_tool_correlation") {
    const binding = parseScienceToolCorrelation(value);
    if (binding.invocationRunId !== runId) return fail();
    return { ...binding };
  }
  if (!["runtime_effect_boundary", "runtime_adapter_effect_started", "runtime_adapter_effect_completed"].includes(kind)) return null;
  let result: Record<string, unknown>;
  if (kind !== "runtime_effect_boundary") result = { ...admission(value, runId, kind === "runtime_adapter_effect_completed") };
  else {
    const v = object(value, ["schemaVersion", "terminalEventId", "terminalSeq", "adapterKinds", "coverage", "effects", "ledgerComplete", "observedToolEventCount", "operations", "pendingEffectRefs", "adapterScopes", "scienceSchemaRejections", "hostControls", "runtimeQuiesced"]);
    if (v.schemaVersion !== "agentlas.runtime-effect-boundary.v1" || !["complete", "unknown"].includes(String(v.coverage)) || !["settled", "uncertain"].includes(String(v.effects))) return fail();
    const operations = array(v.operations, item => {
      const operation = object(item, ["key", "toolId", "startObserved", "resultObserved", "outcome"]);
      if (!["pending", "succeeded", "failed", "unknown"].includes(String(operation.outcome))) return fail();
      return { key: id(operation.key), toolId: nullableId(operation.toolId), startObserved: bool(operation.startObserved), resultObserved: bool(operation.resultObserved), outcome: operation.outcome };
    });
    result = { schemaVersion: v.schemaVersion, terminalEventId: id(v.terminalEventId), terminalSeq: count(v.terminalSeq), adapterKinds: array(v.adapterKinds, id, 128),
      coverage: v.coverage, effects: v.effects, ledgerComplete: bool(v.ledgerComplete), observedToolEventCount: count(v.observedToolEventCount),
      operations, pendingEffectRefs: array(v.pendingEffectRefs, id),
      ...(v.runtimeQuiesced === undefined ? {} : { runtimeQuiesced: bool(v.runtimeQuiesced) }),
      ...(v.hostControls === undefined ? {} : { hostControls: array(v.hostControls, item => controlObservation(item, runId), 512) }),
      ...(v.scienceSchemaRejections === undefined ? {} : { scienceSchemaRejections: array(v.scienceSchemaRejections, item => {
        const proof = parseScienceSchemaRejectionSettlement(item);
        if (proof.binding.invocationRunId !== runId) return fail();
        return proof;
      }) }), ...(v.adapterScopes === undefined ? {} : { adapterScopes: array(v.adapterScopes, item => admission(item, runId, true), 512) }) };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > EFFECT_METADATA_MAX_BYTES) throw new Error("runtime-effect-metadata-overflow");
  return result;
}
export function boundEffectBoundary(receipt: RuntimeEffectBoundaryReceipt, runId: string): RuntimeEffectBoundaryReceipt {
  try { return parseEffectMetadata("runtime_effect_boundary", receipt, runId) as unknown as RuntimeEffectBoundaryReceipt; }
  catch (error) {
    return { ...receipt, coverage: "unknown", effects: "uncertain", ledgerComplete: false, operations: [], adapterScopes: [],
      pendingEffectRefs: [error instanceof Error && error.message === "runtime-effect-metadata-overflow" ? "runtime-effect-metadata-overflow" : "runtime-effect-metadata-invalid"] };
  }
}
