/*
 * The receipt card: the one value behind every card or line that
 * tells a person "it was done / sent / saved / registered / remembered / handed over / written".
 *
 *   a receipt row   a 'view' row of the conversation (`view:receipt:<id>`): the marker + one small closed JSON value. The row holds REFERENCES and outcome codes only
 *                   (an automation id, a path, a conversation id, a memory id), never a copy of the object (about 200 bytes). The model never reads a 'view' row.
 *   the words       `receiptPlainLine(value, live, locale)`: written by the HOST from the value and from the object's state NOW (`live`), here and nowhere else.
 *                   A model's sentence never replaces the card; no receipt means no card (the absence is what the person sees).
 *   the phone       `receiptForPhone`: a phone that says `receipt.card.v1` gets the closed value (+ the same line); an older phone gets one plain line.
 *
 * Pure and import-light: Main, the background service (no Electron), the renderer and the phone bridge read this one file. No store, no clock, no model call, no timer.
 * Modelled on shared/plural-handoff-card.ts (the card that was already one file for desktop and phone).
 */
import { isRemedyAction, remedyShortWordsOf, remedyWordsOf, type RemedyAction } from "./owner-remedy";
import { humanizeScheduleLabel } from "./schedule-describe";

export const RECEIPT_CARD_MARKER = "<<agentlas-receipt>>";
/** A conversation row id is `view:receipt:<receipt id>`. */
export const RECEIPT_ROW_PREFIX = "view:receipt:";
/** The capability word a phone says to be given the closed value. */
export const RECEIPT_CARD_CAPABILITY = "receipt.card.v1";
/** The most a stored receipt value may weigh: the existing ledger's 64 KB line limit (capability-ports.ts RECEIPT_LIMIT_BYTES), reused, not a new cap. */
export const RECEIPT_ROW_LIMIT_BYTES = 64 * 1024;

export type ReceiptKind =
  | "schedule" | "file" | "message" | "handoff" | "memory" | "document" | "mail" | "wait"
  | "approval-outcome" | "ask-outcome" | "turn-outcome"
  /** A change the app sent and was cut off before it could confirm (a crash or a close mid-call; written at the next start, electron/harness/turn-receipts.ts reconcileEffectsLeftUncertain). */
  | "effect-outcome";
export type ReceiptOutcome = "done" | "refused" | "failed" | "uncertain" | "cancelled" | "expired";
/** What happened to a schedule / document / mail: the verb the card says. */
export type ReceiptVerb = "create" | "update" | "pause" | "resume" | "delete" | "save" | "send";
/** Why a turn did not finish (turn-outcome only). */
export type TurnOutcomeCause = "not_started" | "stopped" | "limit" | "login" | "restart" | "crash" | "failed";

export type ReceiptFileRoot = "project" | "chat-workspace" | "outside";
export type ReceiptRef =
  | { automationId: string }
  | { path: string; root: ReceiptFileRoot; wroteThisTurn: boolean; observed?: true }
  | { toChatId: string; intentId: string; chars: number }
  | { handoffRowId: string }
  | { memoryId: string }
  | { waitId: string }
  | { approvalId: string }
  | { runId: string };

/** The stamp: where the receipt was made. Same shape as shared/scope-stamp.ts ScopeStamp (kept structural so this file imports nothing of the gate). */
export interface ReceiptScope { account: string | null; project: string | null; chat: string | null; room?: string | null; run?: string }

export interface ReceiptCardValue {
  v: 1;
  /** "rc_<uuid>"; the conversation row id is `view:receipt:<id>`. */
  id: string;
  kind: ReceiptKind;
  outcome: ReceiptOutcome;
  /** A typed refusal / failure code (harness/plain-outcome.ts table, shared/owner-remedy.ts). Never shown as is. */
  code?: string;
  ref: ReceiptRef;
  runId: string;
  chatId: string;
  scope: ReceiptScope;
  /** ISO. */
  at: string;
  /** The verb of a schedule / document / mail / memory receipt. */
  verb?: ReceiptVerb;
  /** The buttons (closed list, from shared/owner-remedy.ts; absent = none). */
  actions?: RemedyAction[];
  /** turn-outcome: why the run did not finish. */
  cause?: TurnOutcomeCause;
  /** turn-outcome: the runtime's name (claude-code, codex, ...). */
  runner?: string;
  /** turn-outcome: how many receipts the run wrote, by kind. */
  counts?: Partial<Record<ReceiptKind, number>>;
}

const KINDS: ReadonlySet<string> = new Set(["schedule", "file", "message", "handoff", "memory", "document", "mail", "wait", "approval-outcome", "ask-outcome", "turn-outcome", "effect-outcome"]);
const OUTCOMES: ReadonlySet<string> = new Set(["done", "refused", "failed", "uncertain", "cancelled", "expired"]);
const VERBS: ReadonlySet<string> = new Set(["create", "update", "pause", "resume", "delete", "save", "send"]);
const CAUSES: ReadonlySet<string> = new Set(["not_started", "stopped", "limit", "login", "restart", "crash", "failed"]);
const ROOTS: ReadonlySet<string> = new Set(["project", "chat-workspace", "outside"]);
const RECEIPT_ID = /^rc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_ID = /^[A-Za-z0-9_.:@+=/-]{1,200}$/;
const cut = (value: unknown, max: number): string => (typeof value === "string" ? value : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);

export const isReceiptId = (value: unknown): value is string => typeof value === "string" && RECEIPT_ID.test(value);
export const receiptRowId = (id: string): string => `${RECEIPT_ROW_PREFIX}${id}`;
export const isReceiptRowId = (rowId: unknown): boolean => typeof rowId === "string" && rowId.startsWith(RECEIPT_ROW_PREFIX);

/** The stored text of a receipt row. */
export function encodeReceiptCard(value: ReceiptCardValue): string {
  return `${RECEIPT_CARD_MARKER}${JSON.stringify(value)}`;
}

function readRef(raw: unknown): ReceiptRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = (v: unknown): string | null => (typeof v === "string" && OBJECT_ID.test(v) ? v : null);
  if (typeof r.path === "string") {
    const p = cut(r.path, 4096);
    if (!p || typeof r.root !== "string" || !ROOTS.has(r.root) || typeof r.wroteThisTurn !== "boolean") return null;
    return { path: p, root: r.root as ReceiptFileRoot, wroteThisTurn: r.wroteThisTurn, ...(r.observed === true ? { observed: true as const } : {}) };
  }
  if (typeof r.toChatId === "string") {
    const to = id(r.toChatId), intent = typeof r.intentId === "string" ? cut(r.intentId, 200) : "";
    const chars = typeof r.chars === "number" && Number.isSafeInteger(r.chars) && r.chars >= 0 ? r.chars : null;
    return to && chars !== null ? { toChatId: to, intentId: intent, chars } : null;
  }
  for (const key of ["automationId", "handoffRowId", "memoryId", "waitId", "approvalId", "runId"] as const) {
    if (key in r) { const v = id(r[key]); return v ? ({ [key]: v } as ReceiptRef) : null; }
  }
  return null;
}

/** The value of a receipt row's text, or null when the text is not a receipt row or has not the exact shape (a value this build does not know is not drawn). */
export function decodeReceiptCard(text: string | null | undefined): ReceiptCardValue | null {
  if (typeof text !== "string" || !text.startsWith(RECEIPT_CARD_MARKER) || text.length > RECEIPT_ROW_LIMIT_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(RECEIPT_CARD_MARKER.length)); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isReceiptId(r.id) || typeof r.kind !== "string" || !KINDS.has(r.kind) || typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) return null;
  const ref = readRef(r.ref);
  const at = typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) ? new Date(r.at).toISOString() : null;
  const chatId = cut(r.chatId, 200), runId = cut(r.runId, 200);
  const sc = r.scope && typeof r.scope === "object" && !Array.isArray(r.scope) ? r.scope as Record<string, unknown> : null;
  if (!ref || !at || !chatId || !sc) return null;
  const nul = (v: unknown): string | null => (typeof v === "string" && v ? cut(v, 200) : null);
  const scope: ReceiptScope = { account: nul(sc.account), project: nul(sc.project), chat: nul(sc.chat),
    ...(sc.room !== undefined ? { room: nul(sc.room) } : {}), ...(typeof sc.run === "string" && sc.run ? { run: cut(sc.run, 200) } : {}) };
  const code = cut(r.code, 96);
  const actions = (Array.isArray(r.actions) ? r.actions : []).filter(isRemedyAction).slice(0, 4);
  const counts: Partial<Record<ReceiptKind, number>> = {};
  if (r.counts && typeof r.counts === "object" && !Array.isArray(r.counts)) {
    for (const [k, n] of Object.entries(r.counts as Record<string, unknown>)) if (KINDS.has(k) && typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n < 100000) counts[k as ReceiptKind] = n;
  }
  const runner = cut(r.runner, 60);
  return {
    v: 1, id: r.id, kind: r.kind as ReceiptKind, outcome: r.outcome as ReceiptOutcome,
    ...(/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(code) ? { code } : {}),
    ref, runId, chatId, scope, at,
    ...(typeof r.verb === "string" && VERBS.has(r.verb) ? { verb: r.verb as ReceiptVerb } : {}),
    ...(actions.length ? { actions } : {}),
    ...(typeof r.cause === "string" && CAUSES.has(r.cause) ? { cause: r.cause as TurnOutcomeCause } : {}),
    ...(runner ? { runner } : {}),
    ...(Object.keys(counts).length ? { counts } : {}),
  };
}

/* ------------------------------------------------------------------------------------------------------------ the words */

export type ReceiptLocale = "ko" | "en";

/**
 * The object's state NOW (read by the caller from the live row: the automation row, a stat, the delivery row, the memory line). A receipt line is drawn from the
 * value and this, so a schedule that was paused or deleted after the card was made says so. Every field is optional: an unknown stays unsaid, never guessed.
 */
export interface ReceiptLive {
  /** The object no longer exists (a deleted schedule, a file that is not there). */
  gone?: boolean;
  /** Schedule: the words of the STORED spec (describeSchedule), and the next run (ISO). */
  scheduleText?: string;
  nextRunAt?: string | null;
  /** Schedule: false = paused. */
  enabled?: boolean;
  /** Schedule: the end time (`until`) has passed. */
  ended?: boolean;
  /** Schedule: the host only runs it while the app is open (the scheduler's fact, not the model's). Default true. */
  onlyWhileAppOpen?: boolean;
  /** Message: the receiving conversation's title and its project's name (a name the person knows, never an id). */
  toTitle?: string;
  toProject?: string;
  /** File / document: the name shown. */
  name?: string;
  /** Memory: the saved line, verbatim. */
  memoryText?: string;
}

const two = (n: number): string => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "11월 23일 10:00" / "Nov 23, 10:00" in `timeZone` (the person's zone; UTC when none is given, so a fixed value reads the same everywhere). */
export function receiptTimeWord(iso: string | null | undefined, locale: ReceiptLocale, timeZone = "UTC"): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  let parts: Record<string, string> = {};
  try {
    for (const p of new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso))) parts[p.type] = p.value;
  } catch { return ""; }
  const month = Number(parts.month), day = Number(parts.day), hh = two(Number(parts.hour)), mm = two(Number(parts.minute));
  return locale === "ko" ? `${month}월 ${day}일 ${hh}:${mm}` : `${MONTHS[month - 1]} ${day}, ${hh}:${mm}`;
}

const brief = (text: string | undefined, max: number): string => [...(text ?? "").replace(/\s+/g, " ").trim()].slice(0, max).join("");

/** The fixed sentence of a run that did not finish: the cards above it are what happened; nothing else in the answer is going on. */
export const TURN_OUTCOME_FIXED: Readonly<Record<ReceiptLocale, string>> = {
  ko: "이 답은 끝나지 않았어요. 위 카드에 있는 것만 실제로 됐고, 답에 적힌 그 밖의 약속은 진행되지 않습니다.",
  en: "This answer did not finish. Only what the cards above show actually happened; any other promise in the answer is not going on.",
};

const KIND_COUNT_WORD: Readonly<Record<ReceiptKind, { ko: string; en: string }>> = {
  schedule: { ko: "예약", en: "schedules" }, file: { ko: "파일", en: "files" }, message: { ko: "전달", en: "messages" }, handoff: { ko: "넘기기", en: "hand-offs" },
  memory: { ko: "기억", en: "memories" }, document: { ko: "문서", en: "documents" }, mail: { ko: "메일", en: "mails" }, wait: { ko: "기다림", en: "waits" },
  "approval-outcome": { ko: "승인", en: "approvals" }, "ask-outcome": { ko: "질문", en: "questions" }, "turn-outcome": { ko: "끝 줄", en: "end lines" },
  "effect-outcome": { ko: "확인하지 못한 변경", en: "unconfirmed changes" },
};

function countsWord(counts: ReceiptCardValue["counts"], locale: ReceiptLocale): string {
  const parts = Object.entries(counts ?? {}).filter(([k]) => k !== "turn-outcome").map(([k, n]) => `${KIND_COUNT_WORD[k as ReceiptKind][locale]} ${n}`);
  return parts.join(locale === "ko" ? ", " : ", ");
}

function turnOutcomeLine(v: ReceiptCardValue, locale: ReceiptLocale): string {
  const ko = locale === "ko";
  const why = remedyWordsOf(v.code, locale);
  const runner = v.runner ? (ko ? ` (${v.runner})` : ` (${v.runner})`) : "";
  if (v.cause === "not_started") {
    return ko ? `시작하지 못했어요${runner}${why ? ` · ${why}` : ""}` : `Did not start${runner}${why ? ` · ${why}` : ""}`;
  }
  const lead: Record<Exclude<TurnOutcomeCause, "not_started">, { ko: string; en: string }> = {
    stopped: { ko: "멈췄어요", en: "Stopped" }, limit: { ko: "사용량 한도에 닿아 멈췄어요", en: "Stopped at the usage limit" }, login: { ko: "로그인이 필요해 멈췄어요", en: "Stopped: sign-in needed" },
    restart: { ko: "앱이 다시 시작되며 끊겼어요", en: "Cut off when the app restarted" }, crash: { ko: "예기치 않게 끊겼어요", en: "Cut off unexpectedly" }, failed: { ko: "실패로 끝났어요", en: "Ended in a failure" },
  };
  const word = lead[(v.cause ?? "failed") as Exclude<TurnOutcomeCause, "not_started">] ?? lead.failed;
  const counted = countsWord(v.counts, locale);
  return `${word[locale]}${runner}${counted ? (ko ? ` · 이번 실행에서 기록된 일: ${counted}` : ` · recorded in this run: ${counted}`) : ""} · ${TURN_OUTCOME_FIXED[locale]}`;
}

const GENERIC: Readonly<Record<Exclude<ReceiptOutcome, "done">, { ko: string; en: string }>> = {
  refused: { ko: "하지 않았어요", en: "Not done" },
  failed: { ko: "하지 못했어요", en: "Not done: it failed" },
  uncertain: { ko: "됐는지 확인하지 못했어요. 다시 하기 전에 확인하세요", en: "Could not confirm it happened. Check before doing it again" },
  cancelled: { ko: "취소됐어요", en: "Cancelled" },
  expired: { ko: "기한이 지나 끝났어요", en: "Ended: the time ran out" },
};

/** Words that go after the noun: the reason of a refusal/failure when a table has one. */
const because = (v: ReceiptCardValue, locale: ReceiptLocale): string => {
  const why = remedyWordsOf(v.code, locale);
  return why ? ` · ${why}` : "";
};

/**
 * The one plain line of a receipt, Korean or English. `live` is the object's state now (schedule paused / deleted, memory line, names). Never shows a code or an id.
 * "done" claims only what the host recorded; whether the CONTENT is right is for the person to check against the facts the card carries (rule 6).
 */
export function receiptPlainLine(value: ReceiptCardValue, live: ReceiptLive | null | undefined, locale: ReceiptLocale, timeZone?: string): string {
  const ko = locale === "ko";
  const l = live ?? {};
  const g = GENERIC;
  switch (value.kind) {
    case "turn-outcome": return turnOutcomeLine(value, locale);
    case "schedule": {
      if (value.outcome !== "done") return `${ko ? "예약하지 않았어요" : "Schedule not saved"}${value.outcome === "refused" || value.outcome === "failed" ? because(value, locale) : ` · ${g[value.outcome][locale]}`}`;
      if (l.gone || value.verb === "delete") return ko ? "지워진 예약이에요" : "This schedule was deleted";
      //-a: the stored token of a one-time schedule (`once:<instant>`) is read as the moment, in the person's language, never printed raw.
      const text = l.scheduleText ? ` · ${humanizeScheduleLabel(l.scheduleText, ko ? "ko" : "en")}` : "";
      const next = l.nextRunAt ? ` · ${ko ? "다음" : "next"} ${receiptTimeWord(l.nextRunAt, locale, timeZone)}` : "";
      const open = l.onlyWhileAppOpen === false ? "" : ` · ${ko ? "앱이 켜져 있을 때 실행돼요" : "runs while the app is open"}`;
      if (l.ended) return `${ko ? "기한이 지나 끝난 예약" : "Schedule ended"}${text}`;
      if (l.enabled === false) return `${ko ? "멈춘 예약" : "Paused schedule"}${text}`;
      const verb = value.verb === "update" ? (ko ? "예약을 바꿨어요" : "Schedule changed") : value.verb === "pause" ? (ko ? "예약을 멈췄어요" : "Schedule paused")
        : value.verb === "resume" ? (ko ? "예약을 다시 켰어요" : "Schedule resumed") : (ko ? "예약을 등록했어요" : "Schedule saved");
      return `${verb}${text}${next}${open}`;
    }
    case "file": {
      const ref = value.ref as { path?: string; wroteThisTurn?: boolean; observed?: true };
      const name = l.name || (ref.path ? ref.path.split(/[\\/]/).pop() ?? "" : "");
      // A file that landed in a project's folder names the project (the personal agent wrote into another project and the card said nothing of where).
      const tail = name ? ` · ${l.toProject ? `${l.toProject} · ` : ""}${name}` : "";
      if (value.outcome !== "done") return `${ko ? "파일을 쓰지 못했어요" : "File not written"}${because(value, locale)}${tail}`;
      if (ref.wroteThisTurn !== true) return `${ko ? "참조한 파일이에요(이번 턴에 쓰지 않음)" : "Referenced file (not written this turn)"}${tail}`;
      if (l.gone) return `${ko ? "이번 턴에 썼지만 지금은 없는 파일이에요" : "Written this turn, but the file is gone now"}${tail}`;
      return `${ref.observed ? (ko ? "이번 턴에 파일이 바뀐 것을 확인했어요(도구 기록 아님)" : "A file was seen changed this turn (not a tool record)") : (ko ? "파일을 썼어요" : "File written")}${tail}`;
    }
    case "message": {
      const ref = value.ref as { chars?: number };
      const where = l.toTitle ? (l.toProject ? `${l.toProject} · ${l.toTitle}` : l.toTitle) : (ko ? "다른 대화" : "another conversation");
      if (value.outcome === "done") return ko ? `${where}에 ${ref.chars ?? 0}자를 보냈어요` : `Sent ${ref.chars ?? 0} characters to ${where}`;
      return `${ko ? "보내지 않았어요" : "Not sent"}${value.outcome === "refused" || value.outcome === "failed" ? because(value, locale) : ` · ${g[value.outcome][locale]}`}`;
    }
    case "handoff":
      return value.outcome === "done" ? (ko ? "다른 에이전트에게 일을 넘겼어요" : "Work handed to another agent")
        : `${ko ? "일을 넘기지 않았어요" : "Work not handed over"}${because(value, locale)}`;
    case "memory": {
      const line = brief(l.memoryText, 160);
      if (value.outcome !== "done") return `${ko ? "기억하지 못했어요" : "Not remembered"}${because(value, locale)}`;
      return line ? (ko ? `기억했어요 · “${line}”` : `Remembered · “${line}”`) : (ko ? "기억했어요" : "Remembered");
    }
    case "document": {
      const tail = l.name ? ` · ${l.name}` : "";
      return value.outcome === "done" ? `${ko ? "문서를 저장했어요" : "Document saved"}${tail}` : `${ko ? "문서를 저장하지 못했어요" : "Document not saved"}${because(value, locale)}`;
    }
    case "mail":
      return value.outcome === "done" ? (ko ? "메일을 보냈어요" : "Mail sent") : `${ko ? "메일을 보내지 않았어요" : "Mail not sent"}${because(value, locale)}`;
    case "wait":
      if (value.outcome === "done") {
        // The same row is rewritten as the wait moves on (peer-reply-wait.ts): the words follow its code. No code (an older row) = still waiting.
        if (value.code === "answered" || value.code === "answered_by_message") return ko ? "답이 왔어요" : "The answer came";
        if (value.code === "interrupted") return ko ? "상대 쪽 일이 중간에 멈춰서 답이 끝까지 오지 않았어요" : "The other side was interrupted, so the answer did not fully arrive";
        return ko ? "답을 기다리는 중이에요. 답이 오면 이 대화로 알려 드려요" : "Waiting for the answer. It will come back to this conversation";
      }
      if (value.outcome === "expired") return ko ? "기한이 지나 기다림이 끝났어요" : "The wait ended: the time ran out";
      if (value.outcome === "cancelled") return ko ? "기다림을 취소했어요" : "The wait was cancelled";
      return `${ko ? "기다림을 걸지 못했어요" : "Could not wait for the answer"}${because(value, locale)}`;
    case "approval-outcome":
      return value.outcome === "done" ? (ko ? "허용했어요" : "Allowed") : value.outcome === "refused" ? (ko ? "거절했어요. 이 일은 하지 않았어요" : "Denied. This was not done")
        : value.outcome === "expired" ? (ko ? "시간이 지나 닫혔어요. 이 일은 하지 않았어요" : "Closed: the time ran out. This was not done") : (ko ? "닫았어요. 이 일은 하지 않았어요" : "Closed. This was not done");
    case "effect-outcome":
      return value.outcome === "done" ? (ko ? "끊겼던 변경이 이루어진 것을 확인했어요" : "A change that was cut off was confirmed")
        : value.outcome === "uncertain" ? (ko ? "앱이 닫히기 전에 보낸 변경이 있는데, 됐는지 확인하지 못했어요. 다시 하기 전에 확인하세요" : "A change was sent before the app closed and could not be confirmed. Check before doing it again")
        : `${ko ? "끊겼던 변경은 하지 않았어요" : "A change that was cut off was not done"}${because(value, locale)}`;
    case "ask-outcome":
      return value.outcome === "done" ? (ko ? "질문에 답했어요" : "Question answered") : value.outcome === "expired" ? (ko ? "답이 없어 질문이 닫혔어요" : "The question closed: no answer")
        : (ko ? "질문 카드를 닫았어요. 다시 열 수 있어요" : "The question card was closed. It can be opened again");
  }
}

/* ------------------------------------------------------------------------------------------------------------ the desktop card's one short line */

const TURN_SHORT: Readonly<Record<TurnOutcomeCause, readonly [string, string]>> = {
  not_started: ["시작 못 함", "Not started"], stopped: ["멈춤", "Stopped"], limit: ["한도 도달", "Limit reached"], login: ["로그인 필요", "Sign-in needed"],
  restart: ["재시작으로 끊김", "Cut by restart"], crash: ["끊김", "Cut off"], failed: ["실패", "Failed"],
};
const SCHEDULE_SHORT: Readonly<Record<ReceiptVerb, readonly [string, string]>> = {
  create: ["예약됨", "Scheduled"], update: ["예약 바꿈", "Schedule changed"], pause: ["예약 멈춤", "Schedule paused"], resume: ["예약 켬", "Schedule on"],
  delete: ["예약 지움", "Schedule deleted"], save: ["예약됨", "Scheduled"], send: ["예약됨", "Scheduled"],
};

const UNCERTAIN_NOUN: Readonly<Record<ReceiptKind, readonly [string, string]>> = {
  schedule: ["예약", "Schedule"], file: ["파일", "File"], message: ["전달", "Message"], handoff: ["넘김", "Hand-off"], memory: ["기억", "Memory"], document: ["문서", "Document"],
  mail: ["메일", "Mail"], wait: ["기다림", "Wait"], "approval-outcome": ["승인", "Approval"], "ask-outcome": ["질문", "Question"], "turn-outcome": ["실행", "Run"], "effect-outcome": ["변경", "Change"],
};

/**
 * The desktop card's line: a few words, same facts as receiptPlainLine (which stays whole for the hover and for the phone). A cause that
 * receiptPlainLine words as "not done" / "could not confirm" is never worded here as done.
 */
export function receiptShortLine(value: ReceiptCardValue, live: ReceiptLive | null | undefined, locale: ReceiptLocale, timeZone?: string): string {
  const ko = locale === "ko", i = ko ? 0 : 1;
  const l = live ?? {};
  const why = (): string => { const w = remedyShortWordsOf(value.code, locale); return w ? ` · ${w}` : ""; };
  const tail = (name: string | undefined): string => (name ? ` · ${name}` : "");
  const off = (): string => (value.outcome === "uncertain" ? (ko ? " · 확인 못 함" : " · unconfirmed") : value.outcome === "cancelled" ? (ko ? " · 취소" : " · cancelled")
    : value.outcome === "expired" ? (ko ? " · 기한 지남" : " · timed out") : why());
  if (value.outcome === "uncertain" && value.kind !== "message" && value.kind !== "effect-outcome" && value.kind !== "turn-outcome") {
    return `${UNCERTAIN_NOUN[value.kind][i]} ${ko ? "확인 못 함" : "unconfirmed"}`;
  }
  switch (value.kind) {
    case "turn-outcome": return TURN_SHORT[(value.cause ?? "failed") as TurnOutcomeCause]?.[i] ?? TURN_SHORT.failed[i]!;
    case "schedule": {
      if (value.outcome !== "done") return `${ko ? "예약 안 됨" : "Not scheduled"}${off()}`;
      if (l.gone || value.verb === "delete") return ko ? "지워진 예약" : "Schedule deleted";
      const text = l.scheduleText ? ` · ${l.scheduleText}` : "";
      if (l.ended) return `${ko ? "끝난 예약" : "Schedule ended"}${text}`;
      if (l.enabled === false) return `${ko ? "멈춘 예약" : "Paused"}${text}`;
      const next = l.nextRunAt ? ` · ${receiptTimeWord(l.nextRunAt, locale, timeZone)}` : "";
      return `${SCHEDULE_SHORT[value.verb ?? "create"][i]}${text}${next}${l.onlyWhileAppOpen === false ? "" : ko ? " · 앱 켜둔 때만" : " · app open only"}`;
    }
    case "file": {
      const ref = value.ref as { path?: string; wroteThisTurn?: boolean; observed?: true };
      const name = l.name || (ref.path ? ref.path.split(/[\\/]/).pop() ?? "" : "");
      if (value.outcome !== "done") return `${ko ? "파일 못 씀" : "Not written"}${why()}${tail(name)}`;
      if (ref.wroteThisTurn !== true) return `${ko ? "참조만 함" : "Read only"}${tail(name)}`;
      if (l.gone) return `${ko ? "썼지만 없어짐" : "Written, now gone"}${tail(name)}`;
      return `${ref.observed ? (ko ? "바뀐 것 봄" : "Seen changed") : (ko ? "파일 씀" : "File written")}${l.toProject && name ? ` · ${l.toProject}` : ""}${tail(name)}`;
    }
    case "message": {
      const where = l.toTitle ? (l.toProject ? `${l.toProject} · ${l.toTitle}` : l.toTitle) : (ko ? "다른 대화" : "another chat");
      return value.outcome === "done" ? (ko ? `${where}에 보냄` : `Sent to ${where}`) : `${ko ? "안 보냄" : "Not sent"}${off()}`;
    }
    case "handoff": return value.outcome === "done" ? (ko ? "넘김" : "Handed over") : `${ko ? "안 넘김" : "Not handed over"}${off()}`;
    case "memory": {
      if (value.outcome !== "done") return `${ko ? "기억 못 함" : "Not remembered"}${off()}`;
      const line = brief(l.memoryText, 60);
      return `${ko ? "기억함" : "Remembered"}${line ? ` · “${line}”` : ""}`;
    }
    case "document": return value.outcome === "done" ? `${ko ? "문서 저장됨" : "Saved"}${tail(l.name)}` : `${ko ? "문서 저장 못 함" : "Not saved"}${off()}`;
    case "mail": return value.outcome === "done" ? (ko ? "메일 보냄" : "Mail sent") : `${ko ? "메일 안 보냄" : "Mail not sent"}${off()}`;
    case "wait":
      if (value.outcome === "done") {
        if (value.code === "answered" || value.code === "answered_by_message") return ko ? "답 옴" : "Answer came";
        if (value.code === "interrupted") return ko ? "중단돼 답 못 받음" : "Interrupted, no answer";
        return ko ? "답 기다리는 중" : "Waiting for answer";
      }
      if (value.outcome === "expired") return ko ? "기다림 끝 · 기한 지남" : "Wait over · timed out";
      if (value.outcome === "cancelled") return ko ? "기다림 취소" : "Wait cancelled";
      return `${ko ? "기다림 못 걺" : "Could not wait"}${why()}`;
    case "approval-outcome":
      return value.outcome === "done" ? (ko ? "허용" : "Allowed") : value.outcome === "refused" ? (ko ? "거절 · 안 함" : "Denied · not done")
        : value.outcome === "expired" ? (ko ? "시간 지남 · 안 함" : "Timed out · not done") : (ko ? "닫음 · 안 함" : "Closed · not done");
    case "effect-outcome":
      return value.outcome === "done" ? (ko ? "끊긴 변경 확인됨" : "Cut-off change confirmed")
        : value.outcome === "uncertain" ? (ko ? "변경 확인 못 함" : "Change unconfirmed") : `${ko ? "끊긴 변경 안 함" : "Change not done"}${why()}`;
    case "ask-outcome":
      return value.outcome === "done" ? (ko ? "답함" : "Answered") : value.outcome === "expired" ? (ko ? "답 없이 닫힘" : "Closed, no answer") : (ko ? "질문 닫음" : "Question closed");
  }
}

/* ------------------------------------------------------------------------------------------------------------ the phone */

export type PhoneReceipt =
  | { kind: "card"; value: ReceiptCardValue; line: string }
  | { kind: "line"; text: string };

/**
 * What a paired phone is given for a receipt. A phone that says `receipt.card.v1` gets the closed value with the same line beside it (so both draw the same words);
 * an older phone (172~) gets one plain line it can draw as a quiet row. The value is the stored one with nothing added: no object copy.
 */
export function receiptForPhone(value: ReceiptCardValue, live: ReceiptLive | null | undefined, opts: { capabilities?: readonly string[]; locale: ReceiptLocale; timeZone?: string }): PhoneReceipt {
  const line = receiptPlainLine(value, live, opts.locale, opts.timeZone);
  return (opts.capabilities ?? []).includes(RECEIPT_CARD_CAPABILITY) ? { kind: "card", value, line } : { kind: "line", text: opts.locale === "ko" ? `[기록] ${line}` : `[Record] ${line}` };
}
