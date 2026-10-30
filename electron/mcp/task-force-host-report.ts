/*
 * The room's report when the model that was to write the final synthesis could not answer and no other permitted model is left.
 *
 * The finished teammates' results exist, are shown in the room, and are what the owner asked for. Throwing here ended the whole
 * turn as a failed run ("synthesis_runtime_pool_exhausted", observed in use) and the owner never got them in one
 * place. The host assembles the report itself: no model is called (so no runtime pin and no permission boundary is crossed),
 * nothing is invented, each teammate's own words are quoted as delivered. It is a report of results, not a verified synthesis:
 * the caller keeps the run unverified (a "synthesis_runtime_unavailable" verifier issue) so a Goal is never satisfied by it.
 *
 * Pure: no Electron, no store. The reason is the typed provider class (shared/run-failure-notice.ts), never prose.
 */
import { runFailureNoticeCause, type RunFailureNoticeCause } from "../../shared/run-failure-notice";

export const TASK_FORCE_SYNTHESIS_UNAVAILABLE_ISSUE = "synthesis_runtime_unavailable";

export interface TaskForceHostReportRow { name: string; ok: boolean; text: string }

const REASON: Partial<Record<RunFailureNoticeCause, { ko: string; en: string }>> = {
  quota: { ko: "사용 한도 소진", en: "its usage limit is used up" },
  rate_limit: { ko: "요청 속도 제한", en: "the provider is rate-limiting requests" },
  auth: { ko: "로그인 필요 또는 만료", en: "its sign-in is needed or expired" },
  refused: { ko: "공급자의 응답 거절", en: "the provider declined" },
  unavailable: { ko: "모델 서비스 사용 불가", en: "the model service is unavailable" },
  provider_connection: { ko: "모델 공급자에 연결하지 못함", en: "the provider could not be reached" },
  runtime_unavailable: { ko: "모델을 지금 쓸 수 없음", en: "the model is not available right now" },
  subscription_credits_off: { ko: "구독 한도 도달", en: "the subscription limit is reached" },
  capacity: { ko: "입력이 모델 한도를 넘음", en: "the input is larger than the model's limit" },
};
const FALLBACK_REASON = { ko: "모델이 답하지 못함", en: "the model did not answer" } as const;
const ROW_MAX_CHARS = 6_000;
const TOTAL_MAX_CHARS = 40_000;

function bounded(text: string, limit: number): string {
  const chars = Array.from(text.trim());
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : chars.join("");
}

/** The report text, or "" when no teammate delivered anything to quote (the caller then keeps its previous failure). */
export function taskForceHostAssembledReport(input: {
  locale: "ko" | "en";
  /** The typed provider failure of the synthesis runtime that could not answer. */
  failure: { kind: string; source: "marker" | "exit" | "heuristic"; providerCode?: string } | null;
  rows: readonly TaskForceHostReportRow[];
}): string {
  const ko = input.locale === "ko";
  const rows = input.rows.filter((row) => row.text.trim().length > 0);
  if (rows.length === 0) return "";
  const cause = input.failure
    ? runFailureNoticeCause({ errorCode: input.failure.providerCode ?? null,
      runtimeFailure: { kind: input.failure.kind as "quota" | "rate_limit" | "auth" | "refused" | "empty", source: input.failure.source,
        ...(input.failure.providerCode ? { providerCode: input.failure.providerCode } : {}) } })
    : null;
  const reason = (cause ? REASON[cause] : undefined) ?? FALLBACK_REASON;
  const intro = ko
    ? `최종 종합을 맡은 모델이 답하지 못해(${reason.ko}) 종합 보고서는 쓰지 못했습니다. 대신 각 팀원이 낸 결과를 그대로 전해 드립니다.`
    : `The model assigned to write the final summary could not answer (${reason.en}), so no summary was written. Here is what each teammate delivered instead.`;
  const sections: string[] = [];
  let used = intro.length;
  for (const row of rows) {
    const heading = `## ${row.name}${row.ok ? "" : ko ? " (끝내지 못함)" : " (not finished)"}`;
    const body = bounded(row.text, Math.min(ROW_MAX_CHARS, Math.max(0, TOTAL_MAX_CHARS - used - heading.length - 4)));
    if (!body) break;
    sections.push(`${heading}\n${body}`);
    used += heading.length + body.length + 4;
  }
  return [intro, ...sections].join("\n\n");
}

/** Goal changes that arrive while a team is working (a revision, a replacement, the Goal paused or finished). team-goal-context.ts owns the codes. */
export const MID_RUN_GOAL_CHANGE_CODES: ReadonlySet<string> = new Set(["team_goal_context_changed", "team_goal_revision_mismatch", "team_goal_checkpoint_mismatch"]);
/** The verifier issue of a team that stopped because the Goal changed under it: unverified work left, read by the Goal follower. */
export const TASK_FORCE_GOAL_CHANGED_ISSUE = "goal_changed_mid_run";

/**
 * The reply of a team whose Goal changed or ended while it was working. The fence in team-goal-context.ts stands: the plan was made
 * for the earlier Goal, so no further step is started. But the owner changed the Goal on purpose, so this is a calm stop, not
 * "The run failed": what the finished teammates delivered is kept, and the Goal continues from here under its new state.
 */
export function taskForceGoalChangedReport(input: { locale: "ko" | "en"; rows: readonly TaskForceHostReportRow[] }): string {
  const ko = input.locale === "ko";
  const rows = input.rows.filter((row) => row.ok && row.text.trim().length > 0);
  const intro = ko
    ? "작업하는 동안 목표가 바뀌거나 끝나서, 새 단계는 더 시작하지 않고 여기서 멈췄습니다."
    : "The Goal changed or ended while the team was working, so no further step was started and it stopped here.";
  // No "say continue" promise: after a Goal change nothing guarantees that a bare "continue" resumes anything (the gate
  // test-team-room-auto-goal-follows-run lists the only files allowed to make that promise).
  const outro = ko ? "바뀐 목표에 맞춰 이어가려면 메시지를 보내 주세요." : "Send a message when you want it to carry on under the updated Goal.";
  const sections: string[] = [];
  let used = intro.length + outro.length;
  for (const row of rows) {
    const heading = `## ${row.name}`;
    const body = bounded(row.text, Math.min(ROW_MAX_CHARS, Math.max(0, TOTAL_MAX_CHARS - used - heading.length - 4)));
    if (!body) break;
    sections.push(`${heading}\n${body}`);
    used += heading.length + body.length + 4;
  }
  return [intro, ...(sections.length ? [ko ? "이미 끝낸 팀원의 결과입니다." : "What the teammates had already finished:", ...sections] : []), outro].join("\n\n");
}
