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
// persistent goal 연속실행 케이던스 — 고정 30분 대신 goal 상태에 따라 가변.
// 진행 중이면 짧게 붙어서 돌고, 사람/외부 제약에 막혔으면 백오프한다.
// 토큰은 schedule.ts parseLegacyToken("every-Nm/Nh")이 해석하는 형태만 쓴다.
export const GOAL_RUN_SCHEDULE_ACTIVE = "every-10m";
export const GOAL_RUN_SCHEDULE_BACKOFF = "every-2h";
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

/**
 * persistent goal 연속실행의 스케줄 토큰 — goal 원장의 continue 판정으로 정한다.
 * 진행 중(open_tasks_remain)이면 짧게, 그 외(blocked/예산/판정불가)는 백오프.
 * 반환 토큰은 반드시 schedule.ts가 해석 가능한 형태여야 한다(게이트가 실측한다).
 */
export function goalContinuationSchedule(decision: { continue: boolean; reason: string } | null): string {
  if (decision?.continue) return GOAL_RUN_SCHEDULE_ACTIVE;
  return GOAL_RUN_SCHEDULE_BACKOFF;
}

/**
 * 모델이 마커를 안 붙였는데 goal 원장이 "미달"이라고 판정했을 때의 연속 프롬프트.
 * Codex의 "Goal != achieved → 계속"과 동형 — 계속의 근거가 모델 산문이 아니라
 * 호스트 상태임을 모델에게도 명시한다.
 */
export function buildGoalDrivenContinuationPrompt(input: {
  pass: number;
  objective: string | null;
  openTaskCount: number;
  previousOutput: string;
}): string {
  return [
    `Continue persistent-goal execution pass ${input.pass}.`,
    "The host goal ledger reports this goal is NOT yet achieved, so execution continues even though the previous pass did not request continuation.",
    input.objective ? `Goal objective: ${input.objective}` : "",
    `Open ledger tasks remaining: ${input.openTaskCount}.`,
    "Resume from the previous output. Do not restart. Pick the next unfinished work packet, act with available tools, verify the result, and update the visible goal ledger.",
    "If you verify the whole goal is complete, say so explicitly with the evidence; the host will close the goal only on verified completion.",
    `If more safe work remains after this pass, end with ${STORMBREAKER_CONTINUE_MARKER} on its own line.`,
    "",
    "Previous assistant output:",
    input.previousOutput,
  ]
    .filter((line) => line !== "")
    .join("\n");
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
