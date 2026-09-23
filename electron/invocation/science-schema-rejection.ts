import { digestScienceNativeJson, parseScienceNativeFailureObservation, type ScienceNativeFailureObservation } from "./science-native-failure";
import { parseScienceToolCorrelation, verifyScienceFailureSettlement, type ScienceToolCorrelation } from "./science-failure-settlement";

export interface ScienceSchemaRejectionSettlement {
  schemaVersion: "agentlas.science-schema-rejection-settlement.v1";
  binding: ScienceToolCorrelation; attemptId: string; receiptSha256: string; responseSha256: string; inputSchemaSha256: string;
}
type ReceiptReader = (invocationRunId: string, attemptId: string) => unknown;
let readReceipt: ReceiptReader | undefined;
/** Main installs a direct Science store reader, never an MCP-supplied producer. */
export function installScienceSchemaRejectionReader(reader: ReceiptReader): void { readReceipt = reader; }
const fail = (): never => { throw new Error("science-schema-rejection-settlement-invalid"); };
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function parseScienceSchemaRejectionSettlement(value: unknown): ScienceSchemaRejectionSettlement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "attemptId,binding,inputSchemaSha256,receiptSha256,responseSha256,schemaVersion"
    || v.schemaVersion !== "agentlas.science-schema-rejection-settlement.v1"
    || typeof v.attemptId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v.attemptId)
    || ![v.inputSchemaSha256, v.receiptSha256, v.responseSha256].every(sha)) return fail();
  const binding = parseScienceToolCorrelation(v.binding);
  if (binding.toolName !== "agentlas-science.append_research_lifecycle_revision") return fail();
  return { ...v, binding } as unknown as ScienceSchemaRejectionSettlement;
}
/** Independently bind the authenticated immutable Science receipt to the exact
 * native input AND structured response. A failure preview or declared call ID
 * alone can never attest pre-dispatch rejection. Old receipts have no authority. */
export function verifyScienceSchemaRejection(value: ScienceNativeFailureObservation): ScienceSchemaRejectionSettlement | null {
  try {
    const observation = parseScienceNativeFailureObservation(value), binding = observation.binding, ref = observation.schemaRejection;
    if (!readReceipt || !ref || observation.resultSha256 === null || observation.errorSha256 !== null
      || binding.toolName !== "agentlas-science.append_research_lifecycle_revision") return null;
    const receipt = readReceipt(binding.invocationRunId, ref.attemptId) as Record<string, any> | null;
    if (!receipt || Object.keys(receipt).sort().join() !== "core,receiptSha256,response,responseSha256") return null;
    const core = receipt.core, response = receipt.response;
    const keys = ["schemaVersion", "attemptId", "projectId", "conversationId", "runtimeChatId", "turnId", "invocationRunId",
      "toolName", "toolCallId", "inputSha256", "inputSchemaSha256", "boundary", "errorCode", "transaction", "externalEffects"];
    if (!core || typeof core !== "object" || Object.keys(core).length !== keys.length || Object.keys(core).some(k => !keys.includes(k))
      || core.schemaVersion !== "agentlas.science-schema-rejection.v1" || core.attemptId !== ref.attemptId
      || ![core.projectId, core.conversationId, core.turnId, core.runtimeChatId, core.invocationRunId].every(v => typeof v === "string"
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v))
      || core.invocationRunId !== binding.invocationRunId || core.runtimeChatId !== binding.chatId
      || core.toolName !== "append_research_lifecycle_revision" || core.toolCallId !== binding.toolCallId || core.inputSha256 !== binding.inputSha256
      || !sha(core.inputSchemaSha256) || core.boundary !== "lifecycle-input-schema-before-dispatch"
      || core.errorCode !== "science-tool-input-schema-invalid" || core.transaction !== "not-started" || core.externalEffects !== "not-started"
      || digestScienceNativeJson(core).sha256 !== ref.receiptSha256 || receipt.receiptSha256 !== ref.receiptSha256
      || digestScienceNativeJson(response).sha256 !== ref.responseSha256 || receipt.responseSha256 !== ref.responseSha256
      || response?.ok !== false || response?.code !== core.errorCode
      || response?.scienceSchemaRejection?.attemptId !== ref.attemptId || response?.scienceSchemaRejection?.receiptSha256 !== ref.receiptSha256
      || response?.scienceSchemaRejection?.schemaVersion !== "agentlas.science-schema-rejection-reference.v1") return null;
    const decision = verifyScienceFailureSettlement(binding, { readVerifiedReceipt: () => ({ binding,
      receiptSha256: ref.receiptSha256, errorCode: core.errorCode, terminal: "failed", pendingEffects: [],
      proof: { kind: "pre-mutation-rejected", transaction: "not-started", externalEffects: "not-started" } }) });
    if (!decision.settled) return null;
    return parseScienceSchemaRejectionSettlement({ schemaVersion: "agentlas.science-schema-rejection-settlement.v1", binding,
      attemptId: ref.attemptId, receiptSha256: ref.receiptSha256, responseSha256: ref.responseSha256, inputSchemaSha256: core.inputSchemaSha256 });
  } catch { return null; }
}
