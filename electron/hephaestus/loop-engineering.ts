// Stormbreaker Loop prompt contract.
//
// This is intentionally runtime-agnostic. The native Hephaestus supervisor emits
// visible scope/route/final-gate events. Host-enforced repair is bounded to
// verification failures Agentlas can actually detect, such as invalid structured
// surface manifests. Everything else must be reported as verified, unverified,
// or blocked instead of being presented as autonomous completion.

export const STORMBREAKER_MAX_REPAIR_PASSES = 2;
/*
 * How many continuation passes a plain request may take.
 *
 * Three was a stopwatch, not a budget. A request without an explicit Goal only continues while the
 * model itself asks to -- the marker is emitted only when more safe work remains and nothing is
 * blocking -- so the signal already stops on its own when the work is done. Capping it at three
 * meant an ordinary long request stopped in the middle and looked like the product had quit, on
 * every machine, whether or not a goal could be admitted.
 *
 * It is still a cap, because a model that emits the marker forever must not own the person's
 * computer. The runaway guard beside it is the real defence: identical output three passes running
 * ends the loop regardless of the marker.
 */
export const STORMBREAKER_MAX_EXECUTION_PASSES = 24;
/** Identical output this many passes running is a runaway, not progress. */
export const STORMBREAKER_MAX_IDENTICAL_PASSES = 3;
/**
 * A continuous Goal pass kept alive only by the Goal ledger ("not reached yet") that completes no tool call is
 * idle; this many in a row end the invocation. Paraphrased "nothing I can do" passes defeat the identical-output
 * guard, so the measure is the host's own count of completed tool calls (production 2026-10-06: 273 such passes).
 */
export const GOAL_IDLE_PASS_LIMIT = 2;

/**
 * One continuous-Goal pass boundary. `lastPassToolCalls` is the host's count of tool calls the previous pass
 * completed (null: not measured, e.g. the first pass or a failed one). `lastPassNovelObservations` is how many of
 * them observed something this invocation had not observed yet (same tool, same arguments, same result up to
 * numbers counts as seen). A pass with no tool call, or whose calls only reproduced earlier observations, found
 * nothing new. Only a pass the Goal ledger alone keeps alive (`goalDrivenPass`) counts as idle; a working pass or an
 * unmeasured one starts the count again.
 */
export function idleGoalPassStep(input: {
  continuousMode: boolean;
  goalDrivenPass: boolean;
  passShouldContinue: boolean;
  lastPassToolCalls: number | null;
  lastPassNovelObservations?: number | null;
  idlePasses: number;
  /**
   * The Goal's plan has every tactic done (goal-shaping goalPlanFinished): the pass that just ended had been told what is
   * left (verify the criteria and claim), so one idle answer is enough — the next typed step is the terminal verification,
   * not a second pass of the same words.
   */
  planFinished?: boolean;
}): { idlePasses: number; yieldNow: boolean } {
  const idle = input.lastPassToolCalls === 0 || (input.lastPassToolCalls !== null && input.lastPassNovelObservations === 0);
  if (input.continuousMode && input.goalDrivenPass && input.passShouldContinue && idle) {
    const idlePasses = input.idlePasses + 1;
    return { idlePasses, yieldNow: idlePasses >= (input.planFinished ? 1 : GOAL_IDLE_PASS_LIMIT) };
  }
  return { idlePasses: idle ? input.idlePasses : 0, yieldNow: false };
}
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

// Only what stripStormbreakerContinueMarker needs: when the marker is sent and who removes it. The Core harness is
// loaded beside it; cadence/evidence advice for automations lives in the automation prompt builders.
export const STORMBREAKER_LOOP_PROTOCOL = `safe work remains, no blocker: last line ${STORMBREAKER_CONTINUE_MARKER}`;

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
export function goalCompletionProtocol(locale: "ko" | "en", lifecycle: "finite" | "ongoing" = "finite"): string {
  if (lifecycle === "ongoing") return [
    "## Ongoing Goal",
    "mandate: continuing, open until the user stops it; work in bounded episodes",
    "each episode: read state + receipts first; never repeat a done or uncertain external effect",
    `episode met with evidence: ${GOAL_COMPLETE_MARKER} (host verifies the episode only, then waits 30 min quietly)`,
    "nothing due: timer wait; unchanged state: stop",
    "precedence: auth, approval, uncertain effects, Stop",
  ].join("\n");
  return locale === "ko"
    ? [
        "## Goal 종료",
        `모든 기준을 증거로 확인: 마지막 줄 ${GOAL_COMPLETE_MARKER} (근거: ${GOAL_COMPLETE_MARKER.replace(">>", ": 확인한 것>>")})`,
        "마커 없으면 목표는 열린 채. 남은 일이 있으면 금지.",
      ].join("\n")
    : [
        "## Goal end",
        `all criteria verified with evidence: last line ${GOAL_COMPLETE_MARKER} (evidence: ${GOAL_COMPLETE_MARKER.replace(">>", ": what you verified>>")})`,
        "no marker: goal stays open. Work remaining: never emit.",
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

/**
 * `previousOutput` is null when the run's session or agent-context journal already holds the previous pass (the
 * host replays it; a9c13e88). Pass the text only for runtimes that would otherwise start this pass blind.
 */
export function buildStormbreakerContinuationPrompt(previousOutput: string | null, pass: number): string {
  return [
    `Continue Stormbreaker execution pass ${pass}.`,
    `next: unfinished packet, act, verify, update ledger; more safe work: last line ${STORMBREAKER_CONTINUE_MARKER}; all verified: no marker`,
    ...(previousOutput === null ? [] : ["", "Previous assistant output:", previousOutput]),
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
  /** null: the turn context already carries the Goal contract, so it is not restated. */
  objective: string | null;
  openTaskCount: number;
  /** null: the session / agent-context journal already holds the previous pass. */
  previousOutput: string | null;
  /** The typed goal_complete / goal_wait tools are offered on this run: their schemas carry the marker grammar. */
  typedGoalTools?: boolean;
}): string {
  const lines = [
    `Continue persistent-goal execution pass ${input.pass}.`,
    `ledger: not achieved, open tasks ${input.openTaskCount}`,
    ...(input.objective ? [`Goal objective: ${input.objective}`] : []),
    "next: unfinished packet, act, verify, update ledger",
    ...(input.typedGoalTools ? [] : [`whole goal verified: last line ${GOAL_COMPLETE_MARKER} (evidence: ${GOAL_COMPLETE_MARKER.replace(">>", ": what you verified>>")})`]),
    `more safe work: last line ${STORMBREAKER_CONTINUE_MARKER}`,
    "blocked: question card or name the blocker once, no marker; repeat of last result = no progress (host stops after 3)",
  ];
  if (input.previousOutput !== null) lines.push("", "Previous assistant output:", input.previousOutput);
  return lines.join("\n");
}

export function buildStormbreakerLongRunPrompt(input: {
  sourceChatId: string;
  previousOutput: string;
  userPrompt: string;
  workingFolder?: string | null;
}): string {
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.hephaestus.stormbreaker.long-run).
  return [
    STORMBREAKER_LONG_RUN_MARKER,
    "Continue the unfinished Stormbreaker Loop goal from the source chat.",
    "next: unfinished safe packet, act, verify, record; history + workspace evidence, no restart",
    `fully verified: no continue marker, last line ${GOAL_COMPLETE_MARKER}`,
    "blocked (auth, payment, policy, secrets, tools, approval): report it, no marker",
    `more safe work: last line ${STORMBREAKER_CONTINUE_MARKER}`,
    "",
    `Source chat: ${input.sourceChatId}`,
    input.workingFolder ? `Workspace: ${input.workingFolder}` : "",
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

/** An unfinished finite Goal retains its mandate while Main owns a wait or
 * blocker. That state alone cannot authorize another pass of the same live
 * invocation. A newly admitted owner/event turn still executes its first pass.
 * This check happens only after a pass settles; it never aborts in-flight tools.
 */
export function finiteGoalContinuationIsParked(input: {
  lifecycle?: string; status: string | null;
}): boolean {
  return input.lifecycle === "finite"
    && (input.status === "waiting_tool" || input.status === "waiting_user" || input.status === "blocked");
}
