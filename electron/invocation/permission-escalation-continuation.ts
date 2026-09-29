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
export function permissionEscalationContinuationRequest(input: {
  runId: string;
  chatId: string;
  oneMode: boolean;
  locale: "ko" | "en";
}): McpInvocationRequest {
  const userPrompt = input.locale === "ko"
    ? "전체 액세스가 승인되었다. 방금 권한이 없어 멈춘 작업을 이어서 완료하라."
    : "Full access has been approved. Continue and finish the work that was blocked by the read-only permission.";
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
