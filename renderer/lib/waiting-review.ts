/**
 * The review window for what waits (pictures desktop-impl-gaps-6 AI-3 · AI-4) and the line on the personal agent screen (AI-1 · AI-2): the words, the row of an item, the selection arithmetic and the line's state.
 * Pure functions: the pages only draw what these return. A text of an item is the OTHER side's words: it is plain text for the Main-owned review window only; the owner window's line is made of numbers and one closed word
 * and never receives or draws a text (see `planWaitingLine`).
 * The rules (contracts/mirror-trust.md section 3 and 11-12, home-mirror.ts `planAccept`) are Main's; this file only mirrors them so the buttons agree: a text the server cut (`cut: true`, over 200 characters) is
 * left out of an [Accept N] count (it is accepted alone, from its full view, after reading to the end), and a decline needs no reading.
 */
import type { OneHomeWaitingItem, OneHomeWaitingSelection } from "@shared/one-home-confirm";

export type Lang = "ko" | "en";
const pick = (lang: Lang, ko: string, en: string): string => (lang === "ko" ? ko : en);
const nf = (n: number, lang: Lang): string => n.toLocaleString(lang === "ko" ? "ko-KR" : "en-US");
/** "4 items" / "1 item" / "4건". */

export type ItemKind = "message" | "memory" | "memoryDeletion" | "rename";
export const itemKey = (i: OneHomeWaitingItem): string => (i.t === "fact" ? `f:${i.id}` : i.t === "forget" ? `g:${i.id}` : i.t === "words" ? `t:${i.turnId}` : "p");
export const itemKindOf = (i: OneHomeWaitingItem): ItemKind => (i.t === "words" ? "message" : i.t === "fact" ? "memory" : i.t === "forget" ? "memoryDeletion" : "rename");
export const isCut = (i: OneHomeWaitingItem): boolean => (i.t === "words" || i.t === "forget") && i.cut === true;
/** The list a long text is read from (`oneHome:confirmWaitingItem`): the turn's words or a held deletion. */
export const fullListOf = (i: OneHomeWaitingItem): "turns" | "gone" | null => (i.t === "words" && i.cut === true ? "turns" : i.t === "forget" && i.cut === true ? "gone" : null);
export const fullIdOf = (i: OneHomeWaitingItem): string | null => (i.t === "words" ? i.turnId : i.t === "forget" ? i.id : null);

/** A text the list shows cut: the sentence marks at its end are dropped and one "…" is put there ("10시야...." never becomes "10시야....…"). */
export const ellipsize = (t: string): string => { const body = t.replace(/[\s.,;:!?·…。、，！？]+$/u, ""); return body ? `${body}…` : t; };

export interface ItemRow { key: string; kind: ItemKind; label: string; text: string; when: string; cut: boolean; chars: number | null }
export function rowOf(i: OneHomeWaitingItem, lang: Lang, now: Date): ItemRow {
  const label = { message: pick(lang, "메시지", "Message"), memory: pick(lang, "기억", "Memory"), memoryDeletion: pick(lang, "기억 삭제", "Memory deletion"), rename: pick(lang, "이름 변경", "Name change") }[itemKindOf(i)];
  const whole = i.t === "profile" ? i.name : (i.t === "forget" ? (i.text ?? "") : i.text);
  const text = isCut(i) ? ellipsize(whole) : whole;
  const chars = (i.t === "words" || i.t === "forget") && typeof i.chars === "number" ? i.chars : null;
  return { key: itemKey(i), kind: itemKindOf(i), label, text, when: formatWhen(i.at, lang, now), cut: isCut(i), chars };
}
/** "Today 14:02" / "Yesterday 21:15" / "11/12 21:15"; an unreadable time draws nothing. */
export function formatWhen(at: string, lang: Lang, now: Date): string {
  const d = new Date(at); if (Number.isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `${pick(lang, "오늘", "Today")} ${hm}`;
  if (diff === 1) return `${pick(lang, "어제", "Yesterday")} ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** The selection of an answer: [Decline] takes every selected item (no reading needed); [Accept N] takes the selected items that are not cut. At most 100 per list (the server's own limit). */
export function selectionOf(items: OneHomeWaitingItem[], selected: ReadonlySet<string>, decision: "accept" | "reject"): OneHomeWaitingSelection | null {
  const out: { facts: string[]; gone: string[]; turns: string[]; profile: boolean } = { facts: [], gone: [], turns: [], profile: false };
  for (const i of items) {
    if (!selected.has(itemKey(i))) continue;
    if (decision === "accept" && isCut(i)) continue;
    if (i.t === "fact") out.facts.push(i.id); else if (i.t === "forget") out.gone.push(i.id); else if (i.t === "words") out.turns.push(i.turnId); else out.profile = true;
  }
  const sel: OneHomeWaitingSelection = {};
  if (out.facts.length) sel.facts = [...new Set(out.facts)].slice(0, 100);
  if (out.gone.length) sel.gone = [...new Set(out.gone)].slice(0, 100);
  if (out.turns.length) sel.turns = [...new Set(out.turns)].slice(0, 100);
  if (out.profile) sel.profile = true;
  return sel.facts || sel.gone || sel.turns || sel.profile ? sel : null;
}
export const selectedCount = (items: OneHomeWaitingItem[], selected: ReadonlySet<string>): number => items.filter((i) => selected.has(itemKey(i))).length;
/** The N of [Accept N]: the selected items that are not cut (a long text is accepted from its full view). */
export const acceptableCount = (items: OneHomeWaitingItem[], selected: ReadonlySet<string>): number => items.filter((i) => selected.has(itemKey(i)) && !isCut(i)).length;
export const cutCount = (items: OneHomeWaitingItem[]): number => items.filter(isCut).length;

export const doneTotal = (d: { facts: number; gone: number; turns: number; profile: number }): number => d.facts + d.gone + d.turns + d.profile;

export const W = {
  title: (n: number, lang: Lang) => pick(lang, `확인 대기 ${nf(n, lang)}건`, `${nf(n, lang)} to review`),
  untrusted: (lang: Lang) => pick(lang, "신뢰하지 않는 기기에서 작성", "Written on an untrusted device"),
  screenSub: (lang: Lang) => pick(lang, "화면 조작 종료 후 확인 가능", "Available when screen control ends"),
  unreachableSub: (lang: Lang) => pick(lang, "서버 연결 후 확인 가능", "Available when the server is reachable"),
  longPartial: (lang: Lang) => pick(lang, "장문 메시지는 전체 보기에서 수락", "A long message is accepted from its full view"),
  screenBusy: (lang: Lang) => pick(lang, "화면 조작 중에는 수락·거절할 수 없어요.", "Accept and Decline are unavailable during screen control."),
  acceptOnlyYours: (lang: Lang) => pick(lang, "본인이 작성한 항목만 수락해 주세요.", "Accept only what you wrote."),
  selectAll: (lang: Lang) => pick(lang, "전체 선택", "Select all"),
  selected: (n: number, lang: Lang) => pick(lang, `${nf(n, lang)}건 선택`, `${nf(n, lang)} selected`),
  readAll: (lang: Lang) => pick(lang, "전체 보기", "Read all"),
  longChars: (n: number, lang: Lang) => pick(lang, `${nf(n, lang)}자`, `${nf(n, lang)} characters`),
  longNote: (n: number, lang: Lang) => (lang === "ko" ? `장문 메시지 ${nf(n, lang)}건은 전체 보기에서 수락` : n === 1 ? "1 long message is accepted from its full view" : `${nf(n, lang)} long messages are accepted from their full view`),
  readToEnd: (lang: Lang) => pick(lang, "끝까지 읽으면 수락할 수 있어요", "Read to the end to accept"),
  back: (lang: Lang) => pick(lang, "목록", "List"),
  cancel: (lang: Lang) => pick(lang, "취소", "Cancel"),
  close: (lang: Lang) => pick(lang, "닫기", "Close"),
  decline: (lang: Lang) => pick(lang, "거절", "Decline"),
  accept: (n: number | null, lang: Lang) => (n === null || n === 0 ? pick(lang, "수락", "Accept") : pick(lang, `${nf(n, lang)}건 수락`, `Accept ${nf(n, lang)}`)),
  reading: (lang: Lang) => pick(lang, "불러오는 중", "Loading"),
  unreadable: (lang: Lang) => pick(lang, "목록을 불러오지 못했어요", "The list could not be read"),
  retry: (lang: Lang) => pick(lang, "재시도", "Retry"),
  nothing: (lang: Lang) => pick(lang, "확인 대기 항목이 없어요", "Nothing is waiting"),
  noText: (lang: Lang) => pick(lang, "내용을 볼 수 없어요", "The text cannot be shown"),
  accepted: (n: number, lang: Lang) => ({ head: pick(lang, `${nf(n, lang)}건 수락 완료`, `${nf(n, lang)} accepted`), tail: "" }),
  declined: (n: number, lang: Lang) => ({ head: pick(lang, `${nf(n, lang)}건 거절 완료`, `${nf(n, lang)} declined`), tail: "" }),
  newer: (n: number, lang: Lang) => pick(lang, `삭제 요청 ${nf(n, lang)}건은 유지`, `${nf(n, lang)} deletion ${n === 1 ? "request" : "requests"} kept`),
  allDone: (n: number, lang: Lang) => pick(lang, `${nf(n, lang)}건 처리 완료`, `${nf(n, lang)} done`),
  tally: (a: number, d: number, lang: Lang) => [a > 0 ? pick(lang, `수락 ${nf(a, lang)}건`, `${nf(a, lang)} accepted`) : "", d > 0 ? pick(lang, `거절 ${nf(d, lang)}건`, `${nf(d, lang)} declined`) : ""].filter(Boolean).join(" · "),
};

// ───────────────────────── the line on the personal agent screen (AI-1 · AI-2) ─────────────────────────
/** What the line is told: numbers and closed words from `oneHome.status()` (mirror.waiting, screenControl.active, waitingReview). Never a word of an item. */
export interface WaitingLineInput {
  waiting: number;
  screenActive: boolean;
  failed: "server_unreachable" | null;
  result: { at: number; accepted: number; declined: number; cut: number; newer?: number } | null;
  /** The time (ms) this screen opened: a finished result older than that is gone ("gone the next time this screen opens"). */
  mountedAt: number;
  /** The `at` of the result the owner closed with the x. */
  closedAt: number | null;
}
export type WaitingLineKind = "hidden" | "waiting" | "screen" | "unreachable" | "accepted" | "declined" | "done";
export interface WaitingLinePlan {
  kind: WaitingLineKind;
  title: string;
  sub: string;
  /** "review" = [Review] (on), "review-off" = [Review] greyed (screen control), "retry" = [Try again], null = none. */
  button: "review" | "review-off" | "retry" | null;
  canClose: boolean;
  icon: "shield" | "check" | "cross";
}
const HIDDEN_LINE: WaitingLinePlan = { kind: "hidden", title: "", sub: "", button: null, canClose: false, icon: "shield" };
export function planWaitingLine(input: WaitingLineInput | null, lang: Lang): WaitingLinePlan {
  if (!input) return HIDDEN_LINE;
  const n = Math.max(0, Math.floor(input.waiting));
  const r = input.result && input.result.at >= input.mountedAt && input.result.at !== input.closedAt ? input.result : null;
  if (n > 0) {
    const title = W.title(n, lang);
    if (input.screenActive) return { kind: "screen", title, sub: W.screenSub(lang), button: "review-off", canClose: false, icon: "shield" };
    if (input.failed) return { kind: "unreachable", title, sub: W.unreachableSub(lang), button: "retry", canClose: false, icon: "shield" };
    return { kind: "waiting", title, sub: r && r.cut > 0 ? W.longPartial(lang) : W.untrusted(lang), button: "review", canClose: false, icon: "shield" };
  }
  if (r && r.accepted + r.declined > 0) {
    const newerTail = r.newer && r.newer > 0 ? W.newer(r.newer, lang) : null;
    if (r.declined === 0) { const w = W.accepted(r.accepted, lang); return { kind: "accepted", title: w.head, sub: "", button: null, canClose: true, icon: "check" }; }
    if (r.accepted === 0) { const w = W.declined(r.declined, lang); return { kind: "declined", title: w.head, sub: newerTail ?? "", button: null, canClose: true, icon: "cross" }; }
    return { kind: "done", title: W.allDone(r.accepted + r.declined, lang), sub: W.tally(r.accepted, r.declined, lang) + (newerTail ? ` · ${newerTail}` : ""), button: null, canClose: true, icon: "check" };
  }
  return HIDDEN_LINE;
}
