// Stormbreaker Loop prompt contract.
//
// This is intentionally runtime-agnostic. The native Hephaestus supervisor emits
// visible scope/route/final-gate events. Host-enforced repair is bounded to
// verification failures Agentlas can actually detect, such as invalid structured
// surface manifests. Everything else must be reported as verified, unverified,
// or blocked instead of being presented as autonomous completion.

export const STORMBREAKER_MAX_REPAIR_PASSES = 2;
export const STORMBREAKER_MAX_EXECUTION_PASSES = 3;
export const STORMBREAKER_CONTINUE_MARKER = "<<stormbreaker-continue>>";
export const STORMBREAKER_LONG_RUN_MARKER = "<<stormbreaker-long-run>>";
export const STORMBREAKER_LONG_RUN_SCHEDULE = "every-30m";
// "계속 라이브로" 모드(chat.continuousMode)의 안전 상한 — 사실상 무제한이지만, 완전한 폭주
// (매번 continue 마커만 반복하는 등)로부터 사용자 컴퓨터를 지키는 최후 방어선일 뿐이다. 매 턴이
// 실제 CLI 호출로 실제 시간이 걸리므로, 정상적인 장시간(수십 시간) 작업에서 이 숫자에 실제로
// 도달하는 일은 없다.
export const CONTINUOUS_MODE_MAX_PASSES = 20_000;

export const STORMBREAKER_LOOP_PROTOCOL = [
  "Agentlas Desktop host extension. The canonical Goal + UltraCode execution protocol is loaded separately and verbatim from Agentlas Core; this extension only defines Desktop continuation behavior.",
  `If more safe work remains and you are not blocked by auth, payment, policy, missing secrets, or user approval, end the assistant output with ${STORMBREAKER_CONTINUE_MARKER} on its own line. Agentlas Desktop will strip this marker and immediately run the next continuation pass.`,
  "For recurring automations, write the prompt so each run resumes from the latest durable evidence, verifies the current state where tools allow it, acts conservatively, and records what changed. A scheduled prompt is not proof that an external account action succeeded.",
].join("\n");

export function stripStormbreakerContinueMarker(text: string): { text: string; shouldContinue: boolean } {
  const escaped = STORMBREAKER_CONTINUE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Detect the continuation marker as the last meaningful token, tolerating trailing
  // whitespace, punctuation, or a short sign-off on the closing lines. A missed marker
  // silently ends the loop with work still unfinished — a failure the loop must never
  // mask as success — so detection cannot hinge on the model ending its output with
  // byte-exact formatting (a trailing "." or "Hope this helps." used to break it).
  const trimmed = text.trimEnd();
  const tail = trimmed.split("\n").slice(-3).join("\n");
  const shouldContinue = new RegExp(escaped).test(tail);
  // Strip every occurrence of the marker (with surrounding inline spaces) and collapse
  // the blank lines it leaves behind, wherever in the text it appeared.
  const cleaned = trimmed
    .replace(new RegExp(`[ \\t]*${escaped}[ \\t]*`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, shouldContinue };
}

export function buildStormbreakerContinuationPrompt(previousOutput: string, pass: number): string {
  return [
    `Continue Stormbreaker execution pass ${pass}.`,
    "Resume from the previous assistant output. Do not restart.",
    "Pick the next unfinished work packet, act on it with available tools, verify the result, and update the visible goal ledger.",
    "If all requested work is verified, do not include the continuation marker.",
    `If more safe work remains after this pass, end with ${STORMBREAKER_CONTINUE_MARKER} on its own line.`,
    "",
    "Previous assistant output:",
    previousOutput,
  ].join("\n");
}

export function isStormbreakerLongRunPrompt(prompt: string): boolean {
  return prompt.includes(STORMBREAKER_LONG_RUN_MARKER);
}

export function buildStormbreakerLongRunPrompt(input: {
  sourceChatId: string;
  previousOutput: string;
  userPrompt: string;
  workingFolder?: string | null;
}): string {
  return [
    STORMBREAKER_LONG_RUN_MARKER,
    `Source chat: ${input.sourceChatId}`,
    input.workingFolder ? `Workspace: ${input.workingFolder}` : "",
    "",
    "Continue the unfinished Stormbreaker Loop goal from the source chat.",
    "Use this hidden automation session history plus durable workspace evidence. Do not restart from scratch.",
    "Maintain a visible goal ledger, pick the next unfinished safe work packet, act with available tools, verify the result, and record what changed.",
    "If the work is fully verified, do not include the continuation marker.",
    "If blocked by auth, payment, provider policy, missing secrets, unavailable tools, or user approval, report the blocker and do not include the continuation marker.",
    `If more safe work remains after this run, end with ${STORMBREAKER_CONTINUE_MARKER} on its own line.`,
    "",
    "Original user request:",
    input.userPrompt,
    "",
    "Previous visible Stormbreaker state:",
    input.previousOutput,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
