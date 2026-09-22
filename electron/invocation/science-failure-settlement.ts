import { createHash } from "node:crypto";

/** Main capture of the native MCP envelope, never a UI argument preview. */
export interface ScienceToolCorrelation {
  invocationRunId: string; chatId: string; providerToolId: string;
  toolName: string; toolCallId: string; inputSha256: string;
}
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9._:/@-]{1,512}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  throw new Error("science-native-input-invalid");
}
export function parseScienceToolCorrelation(value: unknown): ScienceToolCorrelation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-native-correlation-invalid");
  const v = value as Record<string, unknown>;
  const keys = ["invocationRunId", "chatId", "providerToolId", "toolName", "toolCallId", "inputSha256"];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))
    || keys.slice(0, -1).some(key => !identity(v[key])) || !hash(v.inputSha256)) throw new Error("science-native-correlation-invalid");
  return v as unknown as ScienceToolCorrelation;
}
/** Caller must bind the run/chat from Main's dispatch context. The tool name is
 * only correlation, not authority to classify a failure or settle an effect. */
export function captureScienceToolCorrelation(runId: string, chatId: string, rawItem: unknown): ScienceToolCorrelation | null {
  try {
    if (!rawItem || typeof rawItem !== "object") return null;
    const item = rawItem as Record<string, unknown>;
    if (!["mcp_tool_call", "mcpToolCall"].includes(String(item.type)) || !identity(item.id) || !identity(item.server) || !identity(item.tool)) return null;
    // Strings can be truncated previews or ambiguous JSON (duplicate keys).
    // Only the provider's original structured object is admitted.
    const input = item.input ?? item.args ?? item.arguments;
    if (!input || typeof input !== "object" || Array.isArray(input) || !identity((input as Record<string, unknown>).tool_call_id)) return null;
    const serialized = canonical(input);
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) return null;
    return parseScienceToolCorrelation({ invocationRunId: runId, chatId, providerToolId: item.id,
      toolName: `${item.server}.${item.tool}`, toolCallId: (input as Record<string, unknown>).tool_call_id,
      inputSha256: createHash("sha256").update(serialized).digest("hex") });
  } catch { return null; }
}

/** This is a HOST producer contract, not a schema accepted from MCP output.
 * Implementation must read authenticated Science invocation receipts and
 * independently verify transaction closure and every output's actual bytes.
 * A generic catch, provider isError, model text, or an error-code whitelist
 * cannot implement this interface. No production producer is installed yet. */
export interface ScienceFailureSettlementProducer {
  readVerifiedReceipt(binding: ScienceToolCorrelation): {
    binding: ScienceToolCorrelation; receiptSha256: string; errorCode: string;
    terminal: "failed"; pendingEffects: string[];
    proof: { kind: "pre-mutation-rejected"; transaction: "not-started" | "rolled-back"; externalEffects: "not-started" }
      | { kind: "failed-effects-settled"; researchRunId: string; createRequestId: string; completeRequestId: string;
        outputManifestSha256: string; outputs: Array<{ sha256: string; sizeBytes: number }>;
        externalEffects: "read-only-completed" };
  } | null;
}
export type ScienceFailureSettlementDecision = { settled: false; code: string }
  | { settled: true; code: "science-failure-pre-mutation-rejected" | "science-failure-effects-settled"; receiptSha256: string };
export function verifyScienceFailureSettlement(binding: ScienceToolCorrelation, producer?: ScienceFailureSettlementProducer): ScienceFailureSettlementDecision {
  const deny = (code: string): ScienceFailureSettlementDecision => ({ settled: false, code });
  if (!producer) return deny("science-failure-producer-missing");
  try {
    parseScienceToolCorrelation(binding);
    const receipt = producer.readVerifiedReceipt(binding);
    if (!receipt) return deny("science-failure-receipt-missing");
    const exact = parseScienceToolCorrelation(receipt.binding);
    if (Object.keys(binding).some(key => binding[key as keyof ScienceToolCorrelation] !== exact[key as keyof ScienceToolCorrelation])) return deny("science-failure-binding-mismatch");
    if (receipt.terminal !== "failed" || !identity(receipt.errorCode) || !hash(receipt.receiptSha256)
      || !Array.isArray(receipt.pendingEffects) || receipt.pendingEffects.length) return deny("science-failure-effects-unconfirmed");
    const p = receipt.proof;
    if (p.kind === "pre-mutation-rejected" && ["not-started", "rolled-back"].includes(p.transaction) && p.externalEffects === "not-started")
      return { settled: true, code: "science-failure-pre-mutation-rejected", receiptSha256: receipt.receiptSha256 };
    if (p.kind === "failed-effects-settled" && identity(p.researchRunId) && identity(p.createRequestId) && identity(p.completeRequestId)
      && hash(p.outputManifestSha256) && p.externalEffects === "read-only-completed" && Array.isArray(p.outputs) && p.outputs.length > 0
      && p.outputs.every(output => hash(output.sha256) && Number.isSafeInteger(output.sizeBytes) && output.sizeBytes >= 0))
      return { settled: true, code: "science-failure-effects-settled", receiptSha256: receipt.receiptSha256 };
    return deny("science-failure-effects-unconfirmed");
  } catch { return deny("science-failure-verification-failed"); }
}
