import type { InvocationCurrentTurnSteerReceipt, InvocationSteerResult, McpInvocationRequest } from "../../shared/types";
/** Signed owner input DTO. Authority stays with captured service-owned source, never these values. */
export interface NativeOwnerTextBinding { chatId: string; runId: string; inputDigest: string }
export type NativeOwnerTextKind = "current" | "queue" | "interrupt";
export interface NativeOwnerTextInput extends NativeOwnerTextBinding {
  intentId: string; text: string; deliveryKind: NativeOwnerTextKind;
}
export interface NativeOwnerTextReceipt extends NativeOwnerTextBinding {
  version: "agentlas.native-owner-text.v1"; intentId: string; deliveryKind: NativeOwnerTextKind;
  promptHash: string; messageId: string; sourceStatus: InvocationCurrentTurnSteerReceipt["status"]; code?: string;
  result: InvocationSteerResult;
}

/** Public execution choices only. Original once-used refs stay inherited on the
 * same invocation; this projection cannot carry a new claim or capability. */
export const NATIVE_OWNER_TEXT_CONTEXT_OMITTED = Object.freeze([
  "runId","userPrompt","steeringMode","images","fileGroupId","preflightSubmissionId",
  "oneTeamPreflightRef","oneMemoryUseOnceRef","oneBriefingActionRef","oneAttachmentRef",
  "agentAppMode","agentAppRuntimeToolGrant","oneProfileContext","oneTeamExecutionPolicy",
  "oneTeamRuntimeBinding","oneAttachmentContext","oneAttachmentRedactions","oneTeamReportTurn","forceBrowserCredentialRefresh",
]);
export function nativeOwnerTextChoices(request: McpInvocationRequest): Record<string,unknown> {
  return Object.fromEntries(Object.entries(request).filter(([key,value]) => value !== undefined && !NATIVE_OWNER_TEXT_CONTEXT_OMITTED.includes(key)));
}
