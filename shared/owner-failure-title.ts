import { HOST_FAILURE_CODE_CLASSES } from "./run-failure-notice";
import { isToolFailureCode, type ToolFailureCode } from "./tool-failure";

/**
 * The short heading an owner reads on a failure card, built from the run's machine code and never printing it.
 *
 * The cards (One's failure recovery card, a chat's recovery details) used to put `failure.code` in front of the owner as the
 * heading: `task-force-verification-failed`, `one-team-runtime-selection-changed`, `team_goal_context_changed`. Those are the
 * harness's own labels (rule no internal harness code reaches the owner). The sentence that says what
 * happened is the run's own message (the room's report, or shared/run-failure-notice.ts); this is only its heading.
 *
 * Closed tables of codes, never a word search. A code that is a plain one-word state ("cancelled") keeps its tool wording; a
 * code that has the shape of a machine identifier (an underscore, a dash, a dot, a colon, a digit) and is in no table gets the
 * neutral heading, so a code nobody has named yet cannot leak either. The code stays in the run ledger for whoever debugs it.
 *
 * Pure: no Electron, no store.
 */
export type OwnerFailureTitleLocale = "ko" | "en";

type Title = { ko: string; en: string };

const NEUTRAL: Title = { ko: "실행 오류", en: "Run error" };

/** Headings of the host-owned classes of the run-level notice (HOST_FAILURE_CODE_CLASSES). */
const HOST_CLASS_TITLE: Readonly<Record<string, Title>> = {
  capacity: { ko: "입력이 모델 한도를 넘음", en: "Input over the model limit" },
  unavailable: { ko: "모델 서비스를 쓸 수 없음", en: "Model service unavailable" },
  provider_unavailable: { ko: "모델 공급자가 요청을 받지 못함", en: "Provider could not take the request" },
  subscription_credits_off: { ko: "구독 한도 도달", en: "Subscription limit reached" },
  tool_missing: { ko: "필요한 도구가 연결되지 않음", en: "A needed tool is not connected" },
  tool_failed: { ko: "도구가 결과를 만들지 못함", en: "A tool produced no result" },
  tools_unprepared: { ko: "도구 연결이 준비되지 않음", en: "Tool connections not ready" },
  runtime_unavailable: { ko: "모델을 지금 쓸 수 없음", en: "Model not available right now" },
  runtime_changed: { ko: "확인한 모델과 달라 실행하지 않음", en: "Model differs from the one you confirmed" },
  goal_changed: { ko: "목표 상태가 바뀜", en: "The Goal changed" },
  store_busy: { ko: "저장소가 잠시 바쁨", en: "Storage was busy" },
  project_busy: { ko: "프로젝트의 다른 채팅이 실행 중", en: "Another chat in this project is running" },
  provider_connection: { ko: "모델 공급자에 연결하지 못함", en: "Could not reach the model provider" },
  browser_host_unavailable: { ko: "Agentlas Browser를 쓸 수 없음", en: "Agentlas Browser unavailable" },
  session_reopen: { ko: "이전 세션을 다시 열지 못함", en: "Could not reopen the previous session" },
  working_folder: { ko: "작업 폴더를 쓸 수 없음", en: "Working folder unavailable" },
};

/** Labels the harness gave a whole class of outcomes and that are not in the run-level notice table. */
const LABEL_TITLE: ReadonlyMap<string, Title> = new Map<string, Title>([
  // A team turn that did not verify: the room's report is the message; this is only the heading.
  ["task-force-verification-failed", { ko: "남은 작업이 있습니다", en: "Some work is left" }],
  ["runtime_turn_unsettled", { ko: "응답이 끝나기 전에 멈춤", en: "The reply stopped before it finished" }],
  ["runtime_error", NEUTRAL],
]);

const TOOL_TITLE: Readonly<Record<ToolFailureCode, Title>> = {
  approval_declined: { ko: "승인하지 않음", en: "Approval declined" },
  approval_required: { ko: "승인이 필요함", en: "Approval needed" },
  approval_expired: { ko: "승인 시간이 만료됨", en: "Approval expired" },
  cancelled: { ko: "중단됨", en: "Stopped" },
  tool_failed: { ko: "도구 오류", en: "Tool error" },
};

/** True for the shape of a machine identifier: nothing a person would write as a heading. */
function looksLikeMachineCode(value: string): boolean {
  return /[_.:\-\d]/.test(value) || /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(value);
}

export function ownerFailureTitle(code: unknown, locale: OwnerFailureTitleLocale): string {
  const pick = (title: Title): string => title[locale === "ko" ? "ko" : "en"];
  const text = typeof code === "string" ? code.trim() : "";
  if (!text) return pick(NEUTRAL);
  const label = LABEL_TITLE.get(text);
  if (label) return pick(label);
  const hostClass = HOST_FAILURE_CODE_CLASSES.get(text);
  if (hostClass && HOST_CLASS_TITLE[hostClass]) return pick(HOST_CLASS_TITLE[hostClass]);
  if (isToolFailureCode(text)) return pick(TOOL_TITLE[text as ToolFailureCode]);
  return looksLikeMachineCode(text) ? pick(NEUTRAL) : text;
}
