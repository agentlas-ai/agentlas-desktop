import type { OneArtifactBindingRequestV1 } from "@shared/one-artifacts";

/**
 * All One artifact actions stay in the current app surface. The event is
 * deliberately renderer-only: the receiving Outputs rail mints the short-
 * lived Main capability and renders the file beside the conversation.
 */
export const ONE_ARTIFACT_OPEN_EVENT = "agentlas:one-open-artifact";

export type OneArtifactOpenRequest = {
  binding: OneArtifactBindingRequestV1;
  label: string;
};

export function requestOneArtifactOpen(request: OneArtifactOpenRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OneArtifactOpenRequest>(ONE_ARTIFACT_OPEN_EVENT, { detail: request }));
}

export function isOneArtifactOpenRequest(value: unknown): value is OneArtifactOpenRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OneArtifactOpenRequest>;
  const binding = candidate.binding;
  if (!binding || typeof binding !== "object") return false;
  return typeof candidate.label === "string"
    && typeof binding.taskId === "string"
    && Number.isSafeInteger(binding.taskVersion)
    && typeof binding.chatId === "string"
    && typeof binding.runId === "string"
    && typeof binding.manifestId === "string"
    && typeof binding.artifactRef === "string";
}
