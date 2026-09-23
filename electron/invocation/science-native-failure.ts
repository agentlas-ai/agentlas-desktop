import { createHash } from "node:crypto";
import { captureScienceToolCorrelation, parseScienceToolCorrelation, type ScienceToolCorrelation } from "./science-failure-settlement";

export interface ScienceNativeFailureObservation {
  schemaVersion: "agentlas.science-native-failure-observation.v1";
  binding: ScienceToolCorrelation;
  completionKind: "item.completed" | "item/completed";
  failureSignal: "provider-status-failed" | "provider-error" | "mcp-is-error";
  resultSha256: string | null; resultBytes: number;
  errorSha256: string | null; errorBytes: number;
}
const MAX_BYTES = 2 * 1024 * 1024;
const invalid = (): never => { throw new Error("science-native-failure-observation-invalid"); };

/** Hash the original JSON object, never a UI preview or parsed error prose.
 * Bounds also prevent a malformed provider object from exhausting the observer. */
function digest(value: unknown): { sha256: string | null; bytes: number } {
  if (value === undefined || value === null) return { sha256: null, bytes: 0 };
  let budget = MAX_BYTES;
  const canonical = (item: unknown, depth: number): string => {
    if (depth > 64) return invalid();
    let text: string;
    if (item === null || typeof item === "boolean" || typeof item === "string"
      || (typeof item === "number" && Number.isFinite(item))) {
      text = JSON.stringify(item);
      budget -= Buffer.byteLength(text);
    } else if (Array.isArray(item)) {
      budget -= item.length + 2;
      text = `[${item.map(child => canonical(child, depth + 1)).join(",")}]`;
    } else if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      const object = item as Record<string, unknown>;
      budget -= Object.keys(object).length * 2 + 2;
      text = `{${Object.keys(object).sort().map(key => `${canonical(key, depth + 1)}:${canonical(object[key], depth + 1)}`).join(",")}}`;
    } else return invalid();
    if (budget < 0) return invalid();
    return text;
  };
  const text = canonical(value, 0);
  return { sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) };
}

export function parseScienceNativeFailureObservation(value: unknown): ScienceNativeFailureObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  const keys = ["schemaVersion", "binding", "completionKind", "failureSignal", "resultSha256", "resultBytes", "errorSha256", "errorBytes"];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))
    || v.schemaVersion !== "agentlas.science-native-failure-observation.v1"
    || !["item.completed", "item/completed"].includes(String(v.completionKind))
    || !["provider-status-failed", "provider-error", "mcp-is-error"].includes(String(v.failureSignal))) return invalid();
  const binding = parseScienceToolCorrelation(v.binding);
  if (!binding.toolName.startsWith("agentlas-science.")) return invalid();
  for (const prefix of ["result", "error"]) {
    const sha = v[`${prefix}Sha256`], bytes = v[`${prefix}Bytes`];
    if (!Number.isSafeInteger(bytes) || Number(bytes) < 0 || Number(bytes) > MAX_BYTES
      || (sha === null ? bytes !== 0 : typeof sha !== "string" || !/^[a-f0-9]{64}$/.test(sha) || bytes === 0)) return invalid();
  }
  if ((v.failureSignal === "provider-error" && v.errorSha256 === null)
    || (v.failureSignal === "mcp-is-error" && v.resultSha256 === null)) return invalid();
  return { ...v, binding } as unknown as ScienceNativeFailureObservation;
}

/** A native failed completion is an observation only. It never attests that a
 * transaction rolled back, a dispatch did not start, or an external effect ended. */
export function captureScienceNativeFailureObservation(runId: string, chatId: string, rawItem: unknown,
  completionKind: ScienceNativeFailureObservation["completionKind"]): ScienceNativeFailureObservation | null {
  try {
    const binding = captureScienceToolCorrelation(runId, chatId, rawItem);
    if (!binding || !rawItem || typeof rawItem !== "object") return null;
    const item = rawItem as Record<string, unknown>;
    if (item.server !== "agentlas-science" || (completionKind === "item.completed" ? item.type !== "mcp_tool_call"
      : completionKind === "item/completed" ? item.type !== "mcpToolCall" : true)) return null;
    const result = item.result && typeof item.result === "object" && !Array.isArray(item.result)
      ? item.result as Record<string, unknown> : null;
    const failureSignal = item.status === "failed" ? "provider-status-failed" : item.error != null ? "provider-error"
      : result?.isError === true || result?.is_error === true ? "mcp-is-error" : null;
    if (!failureSignal) return null;
    const resultDigest = digest(item.result), errorDigest = digest(item.error);
    return parseScienceNativeFailureObservation({ schemaVersion: "agentlas.science-native-failure-observation.v1", binding,
      completionKind, failureSignal, resultSha256: resultDigest.sha256, resultBytes: resultDigest.bytes,
      errorSha256: errorDigest.sha256, errorBytes: errorDigest.bytes });
  } catch { return null; }
}
