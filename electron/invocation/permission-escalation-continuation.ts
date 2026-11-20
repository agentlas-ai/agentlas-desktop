import type { McpInvocationRequest } from "../../shared/types";

/**
 * The run that resumes a turn after the owner approved full access.
 *
 * It is a new Main-issued (system) turn in the same chat, so it inherits
 * nothing from the blocked turn unless it is written here. It used to omit
 * `locale`, and pickLocale() falls back to "en": the owner's Korean Youtube
 * launch room (2026-09-28 12:19Z, run 88ec3cdb) got a 37-minute run whose
 * every progress line and final report were English, right after a Korean
 * approval sentence. The owner's language is part of the turn, not of the
 * permission, so the continuation carries it.
 */
/** The model's instruction of the continuation turn. Unchanged text (changes no model input); exported so the human view can tell the turn apart. */
export const PERMISSION_ESCALATION_CONTINUATION_PROMPT = "full access: approved. Finish the work the read-only permission blocked.";

/**
 * the person never reads the model's instruction as if they had written it. The line a person sees for this turn is the host's own, in the app's
 * language (a host line, not a message of the owner).
 */
export function permissionEscalationHumanLine(locale: "ko" | "en"): string {
  return locale === "ko" ? "전체 액세스를 허용했어요. 막혔던 작업을 이어서 해요." : "Full access allowed. Continuing the work that was blocked.";
}

/** True for the host-issued turn that resumes a blocked run after the owner allowed full access (such a turn's full access is for that one run). */
export function isPermissionEscalationContinuation(request: { promptOrigin?: string; userPrompt?: string } | null | undefined): boolean {
  return request?.promptOrigin === "system" && request.userPrompt === PERMISSION_ESCALATION_CONTINUATION_PROMPT;
}

export function permissionEscalationContinuationRequest(input: {
  runId: string;
  chatId: string;
  oneMode: boolean;
  locale: "ko" | "en";
}): McpInvocationRequest {
  const userPrompt = PERMISSION_ESCALATION_CONTINUATION_PROMPT;
  return {
    runId: input.runId,
    chatId: input.chatId,
    userPrompt,
    promptOrigin: "system",
    taskIntent: "task",
    permissions: "full",
    locale: input.locale,
    ...(input.oneMode ? { oneMode: true, onePermissionMode: "full" } : {}),
  } as McpInvocationRequest;
}
