/**
 * The one line at the top of the Dashboard for the first run after the 1.x -> 2.0 update (pictures desktop-impl-gaps-7 AJ-1 · AJ-2 · AJ-3).
 * A pure function of `FirstRunStatus` (shared/first-run-status.ts) and one remembered mark: the state is chosen from the CLOSED values (`applicable`, `done`,
 * `openCodes`, `finalCodes`) and never from any text; a code is never written on the screen. A code this file does not know reads as "paused, continues by
 * itself shortly" and draws no button. Words live here (one place); the component draws a plan and nothing else.
 *
 * Values the picture draws only "when the value exists" (the step "4/9" and its bar, the counts of the window) are optional inputs: Main's status carries them when it has them
 * (shared/first-run-status.ts `step`, `counts`); without them the plan draws the words alone, and a status with no `counts` at all (an older Main, a move that finished before the totals were
 * kept) names the rows with no number. A status WITH `counts` draws only the rows that have a number above 0 (a row it has no number for is not claimed). Nothing here makes up a number.
 * [Retry] (disk space, failed) is drawn only when the caller says the call exists (`canRetry`: the preload has `firstRun.retry`).
 */
import type { FirstRunStatus } from "@shared/first-run-status";

export type Lang = "ko" | "en";
export type FirstRunLineKind = "hidden" | "moving" | "paused" | "done" | "partial" | "stopped";
/** What Main may give later (see RESULT "blank values"); absent today. */
export interface FirstRunLineInput extends Omit<FirstRunStatus, "counts"> {
  counts?: { agents?: number; chats?: number; memory?: number; removed?: number; notMoved?: number };
}
/** The one remembered value: "seen" = this renderer saw the move not finished (so a later "done" is this move's end); "closed" = the owner closed its finished line. Absent = never seen. */
export type FirstRunMark = "seen" | "closed" | null;

export interface FirstRunLinePlan {
  kind: FirstRunLineKind;
  icon: "spinner" | "pause" | "check" | "warning";
  title: string;
  sub: string;
  /** "n/total" and the bar fraction, only when the input carries a step. */
  step: { n: number; total: number } | null;
  /** [See what moved] and the closing x: the finished lines only. */
  canOpen: boolean;
  canClose: boolean;
  /** [Retry]: the disk-space pause and the failed line, when the retry call exists. */
  canRetry: boolean;
}
export interface FirstRunWindowRow { id: "agents" | "chats" | "memory" | "removed" | "notMoved"; icon: "agents" | "chats" | "memory" | "removed" | "notMoved"; label: string; count: number | null; soft: string | null; faint: boolean }
export interface FirstRunWindowPlan { title: string; rows: FirstRunWindowRow[]; close: string }

const KNOWN_PAUSE = ["first_run:disk_low", "first_run:host_plugin_restart", "first_run:host_plugin_manual"] as const;
const pick = (lang: Lang, ko: string, en: string): string => (lang === "ko" ? ko : en);
const HIDDEN: FirstRunLinePlan = { kind: "hidden", icon: "pause", title: "", sub: "", step: null, canOpen: false, canClose: false, canRetry: false };

/** Whether this status means the move is still open (the mark "seen" is written for it). */
export function isFirstRunOpen(input: FirstRunLineInput | null | undefined): boolean {
  return !!input && input.applicable === true && input.done === false;
}

export function planFirstRunLine(input: FirstRunLineInput | null | undefined, mark: FirstRunMark, lang: Lang, options: { canRetry?: boolean } = {}): FirstRunLinePlan {
  const retry = options.canRetry === true;
  if (!input || input.applicable !== true) return HIDDEN;   // no cleanup on this build, or no answer: no line
  const open = Array.isArray(input.openCodes) ? input.openCodes : [];
  const finals = Array.isArray(input.finalCodes) ? input.finalCodes : [];
  const step = input.step && Number.isFinite(input.step.n) && Number.isFinite(input.step.total) && input.step.total > 0 && input.step.n >= 0 && input.step.n <= input.step.total ? { n: input.step.n, total: input.step.total } : null;
  if (!input.done) {
    if (finals.length > 0) return { kind: "stopped", icon: "warning", title: pick(lang, "이전 실패", "Move failed"), sub: pick(lang, "기존 데이터는 유지돼요", "Your existing data is kept"), step: null, canOpen: false, canClose: false, canRetry: retry };
    if (open.length === 0) return { kind: "moving", icon: "spinner", title: pick(lang, "Agentlas 2.0 데이터 이전 중", "Moving your data to Agentlas 2.0"), sub: pick(lang, "앱은 계속 사용할 수 있어요", "You can keep using the app"), step, canOpen: false, canClose: false, canRetry: false };
    const code = KNOWN_PAUSE.find((c) => open.includes(c));
    const title = pick(lang, "이전 일시 중지", "Move paused");
    const sub = code === "first_run:disk_low" ? pick(lang, "디스크 공간 부족", "Not enough disk space")
      : code === "first_run:host_plugin_restart" ? pick(lang, "Claude Code·Codex 종료 후 자동 재개", "Resumes when Claude Code and Codex are closed")
      : code === "first_run:host_plugin_manual" ? pick(lang, "Claude Code·Codex의 Agentlas 플러그인 업데이트 필요", "Update the Agentlas plugin in Claude Code and Codex")
      : "";   // a reason this file does not know: the title alone
    return { kind: "paused", icon: "pause", title, sub, step: null, canOpen: false, canClose: false, canRetry: retry && code === "first_run:disk_low" };   // only the disk-space pause is cleared by asking again; the other two wait for the person
  }
  // Finished. Only a move this renderer saw open (mark "seen") has a finished line; "closed" (or never seen) draws nothing, so an install that never had a move to show says nothing.
  if (mark !== "seen") return HIDDEN;
  const title = pick(lang, "Agentlas 2.0 이전 완료", "Move to Agentlas 2.0 complete");
  // [See what moved] only when the window would have a row to show (a finished move with nothing counted opens nothing).
  const canOpen = planFirstRunWindow(input, lang).rows.length > 0;
  if (open.length > 0) return { kind: "partial", icon: "check", title, sub: pick(lang, "일부 항목 제외", "Some items left out"), step: null, canOpen, canClose: true, canRetry: false };
  return { kind: "done", icon: "check", title, sub: "", step: null, canOpen, canClose: true, canRetry: false };
}

/** The window of [See what moved]: a row only when it has a value; with no number the row shows its name alone; 0 leaves the row out; the last two rows only when they apply. */
export function planFirstRunWindow(input: FirstRunLineInput | null | undefined, lang: Lang): FirstRunWindowPlan {
  const c = input?.counts;
  const known = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const rows: FirstRunWindowRow[] = [];
  const counted = !!c && typeof c === "object";   // Main kept totals for this move: a row it has no number for is not claimed
  const moved = (id: "agents" | "chats" | "memory", label: string, v: number | undefined): void => {
    if (counted && !known(v)) return;
    if (known(v) && v === 0) return;
    rows.push({ id, icon: id, label, count: known(v) ? v : null, soft: null, faint: false });
  };
  moved("agents", pick(lang, "에이전트", "Agents"), c?.agents);
  moved("chats", pick(lang, "대화", "Chats"), c?.chats);
  moved("memory", pick(lang, "기억", "Memories"), c?.memory);
  if (known(c?.removed) && (c?.removed as number) > 0) rows.push({ id: "removed", icon: "removed", label: pick(lang, "미사용 기억 삭제", "Unused memories deleted"), count: c?.removed as number, soft: null, faint: true });
  const partial = (input?.openCodes?.length ?? 0) > 0;
  if (known(c?.notMoved) ? (c?.notMoved as number) > 0 : partial) rows.push({ id: "notMoved", icon: "notMoved", label: pick(lang, "미이전 기억", "Memories not moved"), count: known(c?.notMoved) ? (c?.notMoved as number) : null, soft: null, faint: true });
  return { title: pick(lang, "이전 내용", "What moved"), rows, close: pick(lang, "닫기", "Close") };
}
export const formatFirstRunCount = (n: number, lang: Lang): string => (lang === "ko" ? `${n.toLocaleString("ko-KR")}개` : n.toLocaleString("en-US"));
export const FIRST_RUN_MARK_KEY = "agentlas.desktop.firstRunLine.v1";
export function parseFirstRunMark(raw: string | null | undefined): FirstRunMark { return raw === "seen" || raw === "closed" ? raw : null; }
