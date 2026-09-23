import { parseScienceSchemaRejectionSettlement } from "./science-schema-rejection";
import type { AdapterEffectAdmission, AdapterEffectReport } from "./adapter-effect-context";
import type { RuntimeEffectBoundaryReceipt } from "./effect-boundary";
import { parseScienceToolCorrelation } from "./science-failure-settlement";
import { parseScienceNativeFailureObservation } from "./science-native-failure";

export const EFFECT_METADATA_MAX_BYTES = 2 * 1024 * 1024;
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
  const v = object(value, ["schemaVersion", "protocol", "complete", "terminal", "operationIds", "frameKinds", "reasons", "settledFailureIds"]);
  if (v.schemaVersion !== "agentlas.adapter-effect-coverage.v1") return fail();
  const result: AdapterEffectReport = { schemaVersion: v.schemaVersion, protocol: id(v.protocol), complete: bool(v.complete), terminal: nullableId(v.terminal),
    operationIds: array(v.operationIds, id), frameKinds: array(v.frameKinds, id, 128), reasons: array(v.reasons, id, 128),
    ...(v.settledFailureIds === undefined ? {} : { settledFailureIds: array(v.settledFailureIds, id) }) };
  if (new Set(result.operationIds).size !== result.operationIds.length || (result.complete && result.reasons.length)) return fail();
  if (result.settledFailureIds && (new Set(result.settledFailureIds).size !== result.settledFailureIds.length || result.settledFailureIds.some(value => !result.operationIds.includes(value)))) return fail();
  return result;
}
function admission(value: unknown, runId: string, completed: boolean): AdapterEffectAdmission & { report?: AdapterEffectReport | null } {
  const v = object(value, ["scopeId", "adapterKind", "chatId", "agentId", "rootBound", "purpose", ...(completed ? ["report"] : [])]);
  const scopeId = id(v.scopeId);
  if (!scopeId.startsWith(`${runId}:`)) return fail();
  if (v.purpose !== undefined && v.purpose !== "preparation") return fail();
  if (v.purpose === "preparation" && v.rootBound !== false) return fail();
  return { scopeId, adapterKind: id(v.adapterKind), chatId: nullableId(v.chatId), agentId: nullableId(v.agentId), rootBound: bool(v.rootBound),
    ...(v.purpose === "preparation" ? { purpose: "preparation" as const } : {}),
    ...(completed ? { report: v.report === null ? null : report(v.report) } : {}) };
}
export function parseEffectMetadata(kind: string, value: unknown, runId: string): Record<string, unknown> | null {
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
    const v = object(value, ["schemaVersion", "terminalEventId", "terminalSeq", "adapterKinds", "coverage", "effects", "ledgerComplete", "observedToolEventCount", "operations", "pendingEffectRefs", "adapterScopes", "scienceSchemaRejections"]);
    if (v.schemaVersion !== "agentlas.runtime-effect-boundary.v1" || !["complete", "unknown"].includes(String(v.coverage)) || !["settled", "uncertain"].includes(String(v.effects))) return fail();
    const operations = array(v.operations, item => {
      const operation = object(item, ["key", "toolId", "startObserved", "resultObserved", "outcome"]);
      if (!["pending", "succeeded", "failed", "unknown"].includes(String(operation.outcome))) return fail();
      return { key: id(operation.key), toolId: nullableId(operation.toolId), startObserved: bool(operation.startObserved), resultObserved: bool(operation.resultObserved), outcome: operation.outcome };
    });
    result = { schemaVersion: v.schemaVersion, terminalEventId: id(v.terminalEventId), terminalSeq: count(v.terminalSeq), adapterKinds: array(v.adapterKinds, id, 128),
      coverage: v.coverage, effects: v.effects, ledgerComplete: bool(v.ledgerComplete), observedToolEventCount: count(v.observedToolEventCount),
      operations, pendingEffectRefs: array(v.pendingEffectRefs, id),
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
