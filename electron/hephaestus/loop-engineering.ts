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
/*
 * 완료 선언 마커. continue 마커의 반대쪽 절반이다.
 *
 * 이게 없던 동안 goal은 구조적으로 완료될 수 없었다(실측): 원장은 새 goal마다
 * `task:bootstrap`을 심는데 그 task를 닫는 코드가 어디에도 없어 openTaskCount가
 * 영원히 1이었고, 따라서 판정 사유 `no_open_tasks`가 도달 불가였고, 그 사유를
 * 요구하는 automation-scheduler의 verifiedComplete도 영원히 거짓이었다. 남은
 * 종료 경로는 사용자 취소와 무진전 정지(blocked)뿐 — 끝까지 해낸 goal조차
 * 실패처럼 끝났다.
 *
 * buildGoalDrivenContinuationPrompt는 이미 "the host will close the goal only on
 * verified completion"이라고 모델에게 약속하고 있었다. 그 약속을 받을 채널이
 * 이 마커다. 선언은 자동 완료가 아니다 — 호스트는 이 선언으로 원장의 미완
 * task만 닫고, 실제 완료 판정은 기존 신호 일치 규칙이 그대로 내린다.
 */
export const GOAL_COMPLETE_MARKER = "<<agentlas-goal-complete>>";
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

/**
 * 활성 goal 채팅의 턴 컨텍스트에 붙는 완료 규약.
 *
 * 연속 프롬프트에만 적으면 모델은 2패스째에야 마커를 알게 된다. 첫 패스에
 * 끝나는 작업이 바로 그 이유로 못 끝나면 안 되므로 착수 시점에 같이 준다.
 */
export function goalCompletionProtocol(locale: "ko" | "en"): string {
  return locale === "ko"
    ? [
        "## Goal 종료 규약 (호스트 소유)",
        `모든 성공 기준을 증거로 확인했으면 마지막 줄에 ${GOAL_COMPLETE_MARKER} 를 적어라.`,
        `근거를 같이 남기려면 ${GOAL_COMPLETE_MARKER.replace(">>", ": 무엇을 어디서 확인했는지>>")} 형태로 적는다.`,
        "이 마커가 없으면 호스트는 목표를 끝내지 않는다. 지속 판단은 네 산문이 아니라 원장이 내리기 때문이다.",
        "아직 남은 일이 있으면 절대 적지 마라 — 이 마커는 원장의 미완 항목을 닫는다.",
      ].join("\n")
    : [
        "## Goal termination protocol (host-owned)",
        `When every acceptance criterion is verified with evidence, end your output with ${GOAL_COMPLETE_MARKER} on its own line.`,
        `To attach the evidence inline, write ${GOAL_COMPLETE_MARKER.replace(">>", ": what you verified and where>>")}.`,
        "Without that marker the host never ends the goal, because continuation is decided by the ledger rather than by your prose.",
        "Never emit it while work remains — it closes the open ledger tasks.",
      ].join("\n");
}

export interface GoalCompleteClaim {
  /** 마커를 제거한 사용자에게 보일 본문. */
  text: string;
  /** 모델이 이 턴에서 goal 전체 완료를 선언했는가. */
  claimed: boolean;
  /** `<<agentlas-goal-complete: …>>` 형태로 같이 적은 근거. 없으면 null. */
  evidence: string | null;
}

/**
 * 완료 선언 마커를 떼어내고 근거를 회수한다.
 *
 * continue 마커와 달리 **위치를 보지 않는다.** continue는 "여기서 끝이 아니다"라
 * 꼬리에 있어야 의미가 있지만, 완료 선언은 근거 문단 뒤 어디에 적히든 같은 뜻이고,
 * 놓치면 goal이 다시 영원히 안 닫힌다. 놓치는 쪽이 훨씬 비싸므로 전체를 훑는다.
 *
 * 근거는 선택이다. 비워 두면 호출자가 진행 키 같은 감사 가능한 대체값을 넣는다 —
 * 근거를 필수로 하면 모델이 맨 마커를 적었을 때 완료가 조용히 사라져, 고치려던
 * 결함이 형태만 바꿔 되돌아온다.
 */
export function stripGoalCompleteMarker(text: string): GoalCompleteClaim {
  const source = text ?? "";
  // `<<agentlas-goal-complete>>` 와 `<<agentlas-goal-complete: 근거>>` 를 모두 받는다.
  const pattern = /[ \t]*<<agentlas-goal-complete(?::([^>]*))?>>[ \t]*/gi;
  let claimed = false;
  let evidence: string | null = null;
  const cleaned = source.replace(pattern, (_match, payload?: string) => {
    claimed = true;
    const trimmed = (payload ?? "").trim();
    // 여러 번 적혔으면 근거가 있는 첫 선언을 남긴다.
    if (trimmed && !evidence) evidence = trimmed.slice(0, 240);
    return "";
  });
  if (!claimed) return { text: source, claimed: false, evidence: null };
  return {
    text: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
    claimed: true,
    evidence,
  };
}

/**
 * goal을 completed로 닫아도 되는가 — 세 신호가 모두 같은 말을 할 때만 참이다.
 *
 * 순수 함수로 뽑아 둔 이유는 게이트가 이 규칙을 **실행해서** 잴 수 있게 하기
 * 위해서다. 조건문을 소스에서 문자열로 대조하는 게이트는 옳은 수리까지 막는다.
 *
 *  claimed            모델이 근거와 함께 완료를 선언했다
 *  continueRequested  아직 할 일이 남았다고 했다(하나라도 참이면 완료 아님)
 *  ledgerReason       호스트 원장이 독립적으로 되읽은 판정 사유
 *
 * `no_open_tasks` 만 통과시킨다. 예산 소진·무진전 정지는 사유가 다르므로,
 * 모델이 그 상태에서 완료를 선언해도 완료로 바뀌지 않는다.
 */
export function goalCompletionVerdict(input: {
  claimed: boolean;
  continueRequested: boolean;
  ledgerReason: string | null | undefined;
}): boolean {
  if (!input.claimed) return false;
  if (input.continueRequested) return false;
  return input.ledgerReason === "no_open_tasks";
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
    `If you verify the whole goal is complete, state the evidence and end with ${GOAL_COMPLETE_MARKER} on its own line. Without that marker the host keeps this goal open forever, because continuation is decided by the ledger and not by your prose.`,
    `Optional evidence form: ${GOAL_COMPLETE_MARKER.replace(">>", ": what you verified and where>>")}`,
    "Never emit that marker for a partially finished goal — it closes the remaining ledger tasks.",
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
    `If the work is fully verified, do not include the continuation marker, and end with ${GOAL_COMPLETE_MARKER} on its own line so the host can close the goal. Omitting it leaves the goal running on a schedule with nothing left to do.`,
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
