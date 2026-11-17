/**
 * The words and values of the hand-off cards a person sees. Pure and import-free: the renderer, Main, the background service and the phone bridge read this one file.
 *
 *   a card row     a 'view' row of the sending agent's conversation (`handoff-card:<row id>`) or of the receiving agent's (`handoff-recv:<row id>`): the marker + one small closed JSON value. The state changes, the same row changes (one card per work).
 *                  The model never reads a 'view' row. An older phone (172) is given one plain line instead of the value (handoffPlainLine); a phone that says `handoff.card.v1` gets the closed value (closedHandoffCard).
 *   the copy       every state's words, Korean and English, here and nowhere else. No code, no "완료" (an end does not claim a success), no internal word.
 *   a question     the words of the remote confirmation card (BP): header, title, the sending box and the numbered choices.
 */
export const HANDOFF_CARD_MARKER = "<<agentlas-handoff>>";
export const HANDOFF_SENT_ROW_PREFIX = "handoff-card:";
export const HANDOFF_RECV_ROW_PREFIX = "handoff-recv:";
/** The most of a result a card row keeps (the server's head of a result; the rest lives in the conversation of the agent that ran it). */
export const HANDOFF_RESULT_CHARS = 2000;

export type HandoffCardKind = "sent" | "recv";
/** The states a card can be in (the wire's SentCardState; a received card uses claimed / approval / done / failed / stopped). */
export type HandoffCardState =
  | "reserved" | "waiting_desktop_off" | "waiting_phone_app" | "claimed" | "claimed_desktop_off" | "approval"
  | "done" | "failed" | "stopped" | "expired" | "cancelled";

export interface HandoffCardValue {
  v: 1;
  k: HandoffCardKind;
  /** The row id (h_ + 64 hex). */
  id: string;
  /** Sent: the agent that received the work. Received: the agent that handed it over. */
  agent: string;
  /** The desktop's name; absent for a phone or when not known. */
  place?: string;
  phone?: true;
  brief: string;
  state: HandoffCardState;
  why?: string;
  started?: boolean;
  /** Questions waiting. */
  n?: number;
  result?: string;
  /** The result is not the whole: the rest is in the conversation of the agent that ran it. */
  more?: true;
  /** When it ended (ISO). */
  at?: string;
  /** It ended after the sender asked to cancel (state cancelled / stopped with a result). */
  late?: true;
  /** The desktop that drew the card ran the work (a sign-in button is offered only there). */
  here?: true;
  /** Sent: where the work went ("phone" or a desktop's host id) - a retry hands the same words to the same place. */
  to?: string;
  /** Sent: the confirmations waiting for this desktop's answer (a chip each; at most 8). */
  q?: HandoffQuestion[];
  /** Sent: what this desktop answered here, one quiet line each (at most 10). */
  log?: HandoffAnswerLine[];
}
export interface HandoffQuestion { qid: string; kind: "money" | "delete" | "send"; target: string; preview?: string }
export interface HandoffAnswerLine { kind: "money" | "delete" | "send"; target: string; result: "allowed" | "denied" | "cancelled"; at: string }
const QID = /^[A-Za-z0-9_.:@-]{1,128}$/;
const KIND_SET: ReadonlySet<string> = new Set(["money", "delete", "send"]);

const STATES: ReadonlySet<string> = new Set(["reserved", "waiting_desktop_off", "waiting_phone_app", "claimed", "claimed_desktop_off", "approval", "done", "failed", "stopped", "expired", "cancelled"]);
const cut = (value: unknown, max: number): string => (typeof value === "string" ? value : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);

/** The stored text of a card row. */
export function encodeHandoffCard(value: HandoffCardValue): string {
  return `${HANDOFF_CARD_MARKER}${JSON.stringify(value)}`;
}

/** The value of a card row's text, or null when the text is not a card row or does not have the exact shape (a value this build does not know is not drawn). */
export function decodeHandoffCard(text: string | null | undefined): HandoffCardValue | null {
  if (typeof text !== "string" || !text.startsWith(HANDOFF_CARD_MARKER)) return null;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(HANDOFF_CARD_MARKER.length)); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || (r.k !== "sent" && r.k !== "recv") || typeof r.id !== "string" || !/^h_[a-f0-9]{64}$/.test(r.id) || typeof r.state !== "string" || !STATES.has(r.state)) return null;
  const brief = cut(r.brief, 600).trim();
  if (!brief) return null;
  const n = typeof r.n === "number" && Number.isSafeInteger(r.n) && r.n > 0 && r.n < 1000 ? r.n : undefined;
  const at = typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) ? new Date(r.at).toISOString() : undefined;
  const why = cut(r.why, 40);
  const q = (Array.isArray(r.q) ? r.q : []).slice(0, 8).flatMap((x): HandoffQuestion[] => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    if (typeof o.qid !== "string" || !QID.test(o.qid) || typeof o.kind !== "string" || !KIND_SET.has(o.kind)) return [];
    const preview = cut(o.preview, 2000);
    return [{ qid: o.qid, kind: o.kind as HandoffQuestion["kind"], target: cut(o.target, 200), ...(preview ? { preview } : {}) }];
  });
  const log = (Array.isArray(r.log) ? r.log : []).slice(-10).flatMap((x): HandoffAnswerLine[] => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    if (typeof o.kind !== "string" || !KIND_SET.has(o.kind) || (o.result !== "allowed" && o.result !== "denied" && o.result !== "cancelled") || typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) return [];
    return [{ kind: o.kind as HandoffAnswerLine["kind"], target: cut(o.target, 200), result: o.result, at: new Date(o.at).toISOString() }];
  });
  const to = typeof r.to === "string" && /^(phone|host_[a-f0-9]{32})$/.test(r.to) ? r.to : undefined;
  return {
    v: 1, k: r.k, id: r.id, agent: cut(r.agent, 80).trim(), brief, state: r.state as HandoffCardState,
    ...(cut(r.place, 80).trim() ? { place: cut(r.place, 80).trim() } : {}),
    ...(r.phone === true ? { phone: true as const } : {}),
    ...(/^[a-z_]{1,40}$/.test(why) ? { why } : {}),
    ...(typeof r.started === "boolean" ? { started: r.started } : {}),
    ...(n !== undefined ? { n } : {}),
    ...(typeof r.result === "string" && r.result.trim() ? { result: cut(r.result, HANDOFF_RESULT_CHARS) } : {}),
    ...(r.more === true ? { more: true as const } : {}),
    ...(at ? { at } : {}),
    ...(r.late === true ? { late: true as const } : {}),
    ...(r.here === true ? { here: true as const } : {}),
    ...(to ? { to } : {}),
    ...(q.length ? { q } : {}),
    ...(log.length ? { log } : {}),
  };
}

export type HandoffAction = "cancel" | "retry" | "plan" | "login";
export type HandoffIcon = "send" | "clock" | "phoneOff" | "spinner" | "question" | "flag" | "alert" | "pause" | "blocked" | "cancel";
export interface HandoffCardView {
  header: string;
  brief: string;
  status: string;
  tone: "neutral" | "error";
  icon: HandoffIcon;
  actions: HandoffAction[];
  result?: string;
  /** The grey line under the result: the rest of it is elsewhere. */
  note?: string;
}
export interface HandoffCopyContext { ko: boolean; now: number }

const two = (n: number): string => String(n).padStart(2, "0");
/** Today: hour:minute. Another day: the date. */
export function handoffTimeWord(iso: string | undefined, ctx: HandoffCopyContext): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const now = new Date(ctx.now);
  if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return `${two(at.getHours())}:${two(at.getMinutes())}`;
  if (ctx.ko) return `${at.getFullYear() === now.getFullYear() ? "" : `${at.getFullYear()}년 `}${at.getMonth() + 1}월 ${at.getDate()}일`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getMonth()]!;
  return `${month} ${at.getDate()}`;
}

const placeOf = (card: HandoffCardValue, ko: boolean): string => card.phone ? (ko ? "폰" : "Phone") : card.place || (ko ? "데스크탑" : "desktop");

/** The reason words of a failure (WORK-1117.md A): before the work started, and after. */
function failureWords(card: HandoffCardValue, ko: boolean): { text: string; actions: HandoffAction[] } {
  const place = placeOf(card, ko);
  const before = card.started === false;
  const why = card.why ?? "error";
  if (before) {
    if (why === "desktop_update") return { text: ko ? `실패 · ${place} 업데이트 필요` : `Failed · ${place} needs an update`, actions: ["retry"] };
    if (why === "no_runner") return { text: ko ? "실패 · AI 모델 로그인 필요" : "Failed · sign in to the AI model", actions: ["retry"] };
    if (why === "limit") return { text: ko ? "실패 · 사용 한도 초과" : "Failed · usage limit reached", actions: ["retry"] };
    return { text: ko ? "실패 · 오류 발생" : "Failed · something went wrong", actions: ["retry"] };
  }
  if (why === "permission") return { text: ko ? "실패 · 위치 권한 없음" : "Failed · no location permission", actions: [] };
  if (why === "phone_app") return { text: ko ? "실패 · 폰 응답 없음" : "Failed · the phone did not answer", actions: [] };
  if (why === "limit") return { text: ko ? "실패 · 사용 한도 초과" : "Failed · usage limit reached", actions: ["plan"] };
  if (why === "approval_unavailable") return { text: ko ? "실패 · 읽기 전용 권한" : "Failed · read-only permission", actions: [] };
  if (why === "no_runner") return { text: ko ? "실패 · AI 모델 로그인 필요" : "Failed · sign in to the AI model", actions: card.here ? ["login"] : [] };
  return { text: ko ? "실패 · 오류 발생" : "Failed · something went wrong", actions: [] };
}

function stoppedWords(card: HandoffCardValue, ko: boolean): string {
  const place = placeOf(card, ko);
  switch (card.why) {
    case "cancelled": return ko ? "중단 · 사용자 취소" : "Stopped · cancelled by you";
    case "stopped_here": return ko ? `중단 · ${place}에서 중지` : `Stopped · stopped on ${place}`;
    case "released": return ko ? "중단 · 연결 해제" : "Stopped · disconnected";
    default: return ko ? "중단 · 비정상 종료" : "Stopped · ended abnormally";
  }
}

export function handoffCardView(card: HandoffCardValue, ctx: HandoffCopyContext): HandoffCardView {
  const { ko } = ctx;
  const place = placeOf(card, ko);
  const header = card.k === "recv"
    ? (ko ? `전달 업무 · ${card.agent}` : `Handed-over work · ${card.agent}`)
    : card.agent
      ? (ko ? `${card.agent}에게 전달${card.phone || card.place ? ` · ${place}` : ""}` : `Handed to ${card.agent}${card.phone || card.place ? ` · ${place}` : ""}`)
      // written at hand-off time, before the server's list said which agent got it (the next answer fills the name in)
      : (ko ? "다른 에이전트에게 전달" : "Handed to another agent");
  const time = handoffTimeWord(card.at, ctx);
  const sent = card.k === "sent";
  const base = { header, brief: card.brief };
  const note = card.more ? (ko ? `나머지 결과 · ${place}의 ${card.agent} 대화` : `Rest of the result · in ${card.agent}'s conversation on ${place}`) : undefined;
  const withResult = { ...(card.result ? { result: card.result } : {}), ...(card.result && note ? { note } : {}) };
  switch (card.state) {
    case "reserved": return { ...base, status: ko ? "전달됨" : "Sent", tone: "neutral", icon: "send", actions: ["cancel"] };
    case "waiting_desktop_off": return { ...base, status: ko ? `대기 · ${place} 꺼짐` : `Waiting · ${place} is off`, tone: "neutral", icon: "clock", actions: ["cancel"] };
    case "waiting_phone_app": return { ...base, status: ko ? "대기 · 폰에서 Agentlas 실행 필요" : "Waiting · open Agentlas on the phone", tone: "neutral", icon: "phoneOff", actions: ["cancel"] };
    case "claimed": return { ...base, status: ko ? "진행 중" : "In progress", tone: "neutral", icon: "spinner", actions: sent ? ["cancel"] : [] };
    case "claimed_desktop_off": return { ...base, status: ko ? `진행 중 · ${place} 꺼짐` : `In progress · ${place} is off`, tone: "neutral", icon: "spinner", actions: ["cancel"] };
    case "approval": return { ...base, status: ko ? `확인 대기 ${card.n ?? 1}건` : `${card.n ?? 1} waiting for your answer`, tone: "neutral", icon: "question", actions: [] };
    case "done": return { ...base, status: ko ? `종료${time ? ` ${time}` : ""}` : `Ended${time ? ` ${time}` : ""}`, tone: "neutral", icon: "flag", actions: [], ...withResult };
    case "failed": { const f = failureWords(card, ko); return { ...base, status: f.text, tone: "error", icon: "alert", actions: sent ? f.actions.filter((a) => a !== "retry" || card.to) : [], ...withResult }; }
    case "stopped": return { ...base, status: stoppedWords(card, ko), tone: "neutral", icon: "pause", actions: [], ...withResult };
    case "expired": return { ...base, status: ko ? "실행 불가 · 시작 기한 경과" : "Cannot run · start deadline passed", tone: "error", icon: "blocked", actions: sent && card.to ? ["retry"] : [] };
    case "cancelled": return card.late
      ? { ...base, status: ko ? `취소 전 종료${time ? ` ${time}` : ""}` : `Ended before the cancel${time ? ` ${time}` : ""}`, tone: "neutral", icon: "flag", actions: [], ...withResult }
      : { ...base, status: ko ? "취소됨" : "Cancelled", tone: "neutral", icon: "cancel", actions: [] };
  }
}

/** The one plain line an older phone (172) is given for a card: it draws a line, never a state it cannot update. */
export function handoffPlainLine(card: HandoffCardValue, ctx: HandoffCopyContext): string {
  const view = handoffCardView(card, ctx);
  const brief = [...view.brief.replace(/\s+/g, " ")].slice(0, 80).join("");
  return `${ctx.ko ? "[전달]" : "[Hand-off]"} ${brief} · ${view.status}`;
}

/** The value a phone that says `handoff.card.v1` receives: the same closed shape, the result cut to what a message may carry. */
export function closedHandoffCard(card: HandoffCardValue, resultChars = 1200): HandoffCardValue {
  return { ...card, ...(card.result ? { result: [...card.result].slice(0, resultChars).join("") } : {}) };
}

/* -------------------------------------------------------------------------------------------- the confirmation card (BP) */
export type RemoteAskKind = "money" | "delete" | "send";
export type RemoteAskChoice = "allow_once" | "allow_session" | "deny";
export interface RemoteAskCopy {
  header: string;
  title: string;
  /** The line under the title: the path / the payee. */
  target: string;
  /** The sending box: to / subject / the beginning of the body. Absent for money and delete. */
  rows: Array<{ label: string; value: string }>;
  choices: Array<{ id: RemoteAskChoice; label: string; role?: "primary" | "deny" }>;
}

/** What a sending preview holds, as far as it can be read: a JSON object with the usual names, else the whole text as the body. */
export function parseSendPreview(preview: string | undefined): { to?: string; subject?: string; body?: string } {
  const text = typeof preview === "string" ? preview.trim() : "";
  if (!text) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      const pick = (...names: string[]): string | undefined => { for (const n of names) { const v = o[n]; if (typeof v === "string" && v.trim()) return v.trim(); if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return (v as string[]).join(", "); } return undefined; };
      const to = pick("to", "recipient", "recipients", "email", "channel");
      const subject = pick("subject", "title");
      const body = pick("body", "text", "message", "content");
      if (to || subject || body) return { ...(to ? { to } : {}), ...(subject ? { subject } : {}), ...(body ? { body } : {}) };
    }
  } catch { /* plain text */ }
  return { body: text };
}

export function remoteAskCopy(input: { kind: RemoteAskKind; tool: string; target: string; preview?: string; fromName: string; placeName: string }, ko: boolean): RemoteAskCopy {
  const header = ko ? `확인 · ${input.fromName} · ${input.placeName}` : `Confirm · ${input.fromName} · ${input.placeName}`;
  const allow = { id: "allow_once" as const, label: ko ? "허용" : "Allow", role: "primary" as const };
  const deny = { id: "deny" as const, label: ko ? "거절" : "Deny", role: "deny" as const };
  if (input.kind === "money") return { header, title: ko ? "결제" : "Payment", target: input.target ? (ko ? `받는 곳 · ${input.target}` : `Payee · ${input.target}`) : "", rows: [], choices: [allow, deny] };
  const task = { id: "allow_session" as const, label: ko ? "이 업무 동안 허용" : "Allow for this task" };
  if (input.kind === "delete") return { header, title: ko ? "삭제" : "Delete", target: input.target, rows: [], choices: [allow, task, deny] };
  const tool = input.tool;
  const p = parseSendPreview(input.preview);
  const mail = /mail/i.test(tool) || (!tool && (Boolean(p.subject) || /@/.test(p.to ?? input.target)));
  const title = mail ? (ko ? "메일 전송" : "Send email") : /message|slack|sms|chat|telegram|discord|kakao/i.test(tool) || (!tool && Boolean(p.body)) ? (ko ? "메시지 전송" : "Send message") : (ko ? "전송" : "Send");
  const rows: RemoteAskCopy["rows"] = [];
  const to = p.to ?? input.target;
  if (to) rows.push({ label: ko ? "받는 사람" : "To", value: to });
  if (p.subject) rows.push({ label: ko ? "제목" : "Subject", value: p.subject });
  if (p.body) rows.push({ label: ko ? "본문" : "Body", value: p.body });
  return { header, title, target: "", rows, choices: [allow, task, deny] };
}
