/**
 * 이번 턴을 얼마나 올릴 것인가 — 관측으로만 정한다.
 *
 * ## 왜 요청 문장을 읽지 않는가
 *
 * 실사용 로그 558턴(대화 78개, 6주)으로 측정했다. 요청 문장의 단어 신호로 무거운 턴을
 * 맞힌 비율은 **21.7%**였고, 가벼운 턴 130건 중 **115건을 잘못 올렸다**. 없느니만
 * 못한 성능이다. 놓친 것들이 왜 놓쳐졌는지도 분명했다:
 *
 *     "여기서 안보여 좀 띄워줘"        → 실제로 도구 9개, 64초
 *     "아니 지금 너가 눕혔잖아"         → 도구 13개, 153초
 *
 * 이 문장들이 무거운 이유는 문장에 없다. 그때 무거운 작업 중이었기 때문이다. 난이도는
 * 요청에 적혀 오는 것이 아니라 **작업이 처한 상태**다. 첫 턴은 길이로도 갈리지 않았다
 * (무거운 첫턴 중앙값 68자 < 가벼운 첫턴 81자 — 오히려 역방향).
 *
 * ## 무엇으로 정하는가
 *
 * 같은 코퍼스에서 "직전 턴이 무거웠으면 이번 턴도 무겁다"는 **재현율 88.5% 정밀도
 * 87.2%**였고, 반대쪽("가벼웠으면 가볍다")은 91.3%였다. 전체 턴의 86%가 후속 턴이므로
 * 이 신호 하나가 거의 전부를 덮는다. 라벨은 이번 턴, 근거는 직전 턴이라 서로 다른
 * 관측이다 — 같은 턴의 같은 변수로 자기를 맞히면 그것은 성능이 아니라 산수다.
 *
 * 첫 턴은 **예측하지 않는다.** 근거가 없을 때 지어내는 대신 혼자 시작하고, 실행이
 * 무거워지면 그때 올린다.
 *
 * ## 남은 숫자에 대하여
 *
 * 아래 임계는 이 저장소의 실측 분포에서 나온 기본값이지 진리가 아니다. "팀을 붙였으면
 * 결과가 더 좋았을까"는 반사실이라 지나간 로그로는 풀 수 없다 — 로그에는 실제로 고른
 * 선택의 결과만 남는다. 그래서 이 값들은 나중에 탐색과 보상(취소·재시도·에러)으로
 * 갱신되는 학습된 상태로 옮겨갈 자리다. 그때까지는 근거를 밝힌 기본값으로 둔다.
 */

export type TurnEscalation = "solo" | "team";

/** 직전 턴에서 실제로 관측된 값. 해석이 아니라 계측치다. */
export interface ObservedTurn {
  toolCalls: number;
  seconds: number;
  hadTrouble: boolean;
  ranAsTeam: boolean;
}

export interface TurnEscalationInput {
  /** 직전 턴의 관측. 첫 턴이면 null. */
  previousTurn: ObservedTurn | null;
  /** 사용자가 이번 턴에 직접 팀/Stormbreaker를 요청했다. 추정보다 언제나 위다. */
  explicitTeamRequest?: boolean;
  /** 사용자가 이번 턴에 혼자 하라고 지시했다. */
  explicitSoloRequest?: boolean;
}

export interface TurnEscalationVerdict {
  level: TurnEscalation;
  /** 기계 코드. 사람 문장으로 바꾸지 않는다 — 영수증과 학습 신호가 같은 값을 본다. */
  reasonCode: string;
  /** 판정 근거가 된 관측치. 없으면 null(첫 턴). */
  basis: ObservedTurn | null;
}

export type ProjectRosterTaskForceReason =
  | "explicit-user-solo"
  | "turn-escalated"
  | "active-goal"
  | "no-runnable-roster"
  | "solo-without-goal";

export interface ProjectRosterTaskForceDecision {
  run: boolean;
  reasonCode: ProjectRosterTaskForceReason;
}

/**
 * Decide whether a saved project roster may become a real task force this turn.
 *
 * A goal is a durable execution commitment, so an admitted automatic goal and an
 * explicit Goal turn may use the roster even when there is no previous-turn
 * observation yet. A direct request to stay solo always wins. The caller must
 * pass the runnable roster count after resolving local agent/team identities;
 * saved labels alone never authorize a task-force receipt.
 */
export function decideProjectRosterTaskForce(input: {
  turnEscalation: TurnEscalationVerdict;
  activeGoal: boolean;
  runnableRosterCount: number;
}): ProjectRosterTaskForceDecision {
  if (input.runnableRosterCount <= 0) {
    return { run: false, reasonCode: "no-runnable-roster" };
  }
  if (input.turnEscalation.reasonCode === "explicit-user-solo") {
    return { run: false, reasonCode: "explicit-user-solo" };
  }
  if (input.turnEscalation.level === "team") {
    return { run: true, reasonCode: "turn-escalated" };
  }
  if (input.activeGoal) {
    return { run: true, reasonCode: "active-goal" };
  }
  return { run: false, reasonCode: "solo-without-goal" };
}

/**
 * 직전 턴을 무겁다고 볼 기준.
 *
 * 실측 분포에서 도구 수 p75는 5, 소요 시간 p75는 334초였다. 이 값을 그대로 쓴다.
 * 손으로 고른 예쁜 숫자가 아니라 이 제품의 실제 분포에서 읽은 값이라는 뜻이다.
 */
export const HEAVY_TOOL_CALLS = 5;
export const HEAVY_SECONDS = 334;

/** 실행 중 승급을 검토할 지점. 직전 턴이 없을 때 쓰는 유일한 근거다. */
export const MIDRUN_TOOL_CALLS = 3;
export const MIDRUN_SECONDS = 60;

export function observedTurnWasHeavy(turn: ObservedTurn): boolean {
  return turn.ranAsTeam || turn.toolCalls >= HEAVY_TOOL_CALLS || turn.seconds >= HEAVY_SECONDS;
}

export function classifyTurnEscalation(input: TurnEscalationInput): TurnEscalationVerdict {
  if (input.explicitSoloRequest) {
    return { level: "solo", reasonCode: "explicit-user-solo", basis: null };
  }
  if (input.explicitTeamRequest) {
    return { level: "team", reasonCode: "explicit-user-team", basis: null };
  }
  const previous = input.previousTurn;
  if (!previous) {
    // 첫 턴 — 근거가 없다. 지어내지 않고 혼자 시작한다.
    return { level: "solo", reasonCode: "no-observation-first-turn", basis: null };
  }
  if (observedTurnWasHeavy(previous)) {
    return { level: "team", reasonCode: "previous-turn-heavy", basis: previous };
  }
  return { level: "solo", reasonCode: "previous-turn-light", basis: previous };
}

/**
 * 실행 도중 올릴 것인가. 첫 턴에는 이것이 유일한 근거다.
 *
 * 늦게 아는 것은 결함이 아니다 — 일은 이미 진행 중이고, 커진 뒤에 사람을 더 붙이는
 * 것이 시작 전에 못 맞히는 것보다 낫다.
 */
export function shouldEscalateMidRun(live: { toolCalls: number; seconds: number; hadTrouble: boolean }): boolean {
  return live.hadTrouble || live.toolCalls >= MIDRUN_TOOL_CALLS || live.seconds >= MIDRUN_SECONDS;
}

export function describeTurnEscalation(verdict: TurnEscalationVerdict): string {
  const basis = verdict.basis
    ? ` prev=${verdict.basis.toolCalls}tools/${verdict.basis.seconds}s${verdict.basis.ranAsTeam ? "/team" : ""}${verdict.basis.hadTrouble ? "/trouble" : ""}`
    : "";
  return `${verdict.level} ${verdict.reasonCode}${basis}`;
}
