// One quiet line where an approval card was: words, order, grouping and slot come from the stored record and closed values only (no model, no timer, no stored value of its own).
import type { SettledToolApproval } from "@shared/types";
import { toolLabel } from "@/lib/tool-labels";

export type ApprovalLineOutcome = SettledToolApproval["outcome"] | "auto";
export type ApprovalLineDevice = "desktop" | "phone";

/** A stored record as the lines read it: the ledger's fields (`device` and `auto` included), with the result word open to "auto" for a caller that builds one by hand. */
export interface ApprovalLineRecord extends Omit<SettledToolApproval, "outcome"> {
  outcome: ApprovalLineOutcome;
  device?: ApprovalLineDevice;
}
/** What a record reads as: an automatic approval is its own result whatever the ledger's `outcome` says (the ledger writes it as an approval). */
const outcomeOf = (record: ApprovalLineRecord): ApprovalLineOutcome => (record.auto ? "auto" : record.outcome);
type ApprovalBasis = "always_allow" | "full_access" | "unattended";
const basisOf = (record: ApprovalLineRecord): ApprovalBasis => (record.auto === "full_access" ? "full_access" : record.auto === "unattended" ? "unattended" : "always_allow");

export type ApprovalLineIcon = "approved" | "declined" | "expired" | "auto";
export interface ApprovalLineDetail { label: string; value: string }

export interface ApprovalLine {
  id: string;
  icon: ApprovalLineIcon;
  result: string;
  kind: string | null;
  target: string;
  /** "이 데스크탑" / "폰" / "항상 허용"; null when the record does not say (an expired card has no device). */
  side: string | null;
  device: ApprovalLineDevice | "always" | null;
  time: string;
  /** What opens under the line: only the rows that have a value. */
  details: ApprovalLineDetail[];
}

export interface ApprovalAutoGroup {
  id: string;
  title: string;
  kind: string | null;
  side: string;
  time: string;
  lines: ApprovalLine[];
}

export type ApprovalLineItem = { type: "line"; line: ApprovalLine } | { type: "group"; group: ApprovalAutoGroup };

type Lang = "ko" | "en";
export interface ApprovalLineContext {
  lang: Lang;
  /** Epoch ms of "now": a time of today is drawn as hour:minute, any other as a date. */
  now: number;
  /** The words of an agent id; undefined when the caller cannot name it (the row is then left out). */
  agentName?: (agentId: string) => string | undefined;
}

const REMOTE_RESULT_WORDS: Record<ApprovalLineOutcome, [string, string]> = {
  approved: ["허용됨", "Allowed"],
  declined: ["거절됨", "Denied"],
  expired: ["취소됨", "Cancelled"],
  auto: ["자동 승인", "Auto-approved"],
};
const REMOTE_KIND_WORDS: Record<string, [string, string]> = { send: ["전송", "Send"] };
const RESULT_WORDS: Record<ApprovalLineOutcome, [string, string]> = {
  approved: ["승인됨", "Approved"],
  declined: ["거절됨", "Declined"],
  expired: ["만료됨", "Expired"],
  auto: ["자동 승인", "Auto-approved"],
};
const CLOSE_REASON_WORDS: Record<"cancelled" | "restarted", [string, string]> = {
  cancelled: ["멈춰서 닫힘", "Closed: stopped"],
  restarted: ["재시작으로 닫힘", "Closed: restart"],
};
const KIND_WORDS: Record<string, [string, string]> = {
  delete: ["삭제", "Delete"],
  send: ["외부 전송", "Send outside"],
  money: ["결제", "Payment"],
};
const CHOICE_WORDS: Record<string, [string, string]> = {
  allow_once: ["예", "Yes"],
  allow_session: ["예 · 이번 작업 내내", "Yes · for this task"],
  allow_always: ["예 · 항상", "Yes · always"],
  deny: ["아니오", "No"],
};
const DEVICE_WORDS: Record<ApprovalLineDevice | "always" | "full" | "unattended", [string, string]> = {
  desktop: ["데스크탑", "Desktop"],
  phone: ["폰", "Phone"],
  always: ["항상 허용", "Always allow"],
  full: ["전체 액세스", "Full access"],
  unattended: ["무인", "Unattended"],
};
const BASIS_KEY: Record<ApprovalBasis, "always" | "full" | "unattended"> = { always_allow: "always", full_access: "full", unattended: "unattended" };
const DETAIL_LABELS: Record<"by" | "target" | "answer", [string, string]> = {
  by: ["요청", "Asked by"],
  target: ["대상", "Target"],
  answer: ["선택", "Answer"],
};

const pick = (pair: [string, string], lang: Lang): string => pair[lang === "ko" ? 0 : 1];

export function approvalKindWord(capability: string | undefined, lang: Lang): string | null {
  const pair = capability ? KIND_WORDS[capability] : undefined;
  return pair ? pick(pair, lang) : null;
}

/** The tool as a person reads it: the one table (lib/tool-labels.ts) — an MCP call's own name, else a named row, else "permission request"; never the raw id. */
export function approvalToolName(tool: string, lang: Lang = "ko"): string {
  return toolLabel(tool, lang);
}

/** The area of an app operation as a person names it. An area not listed is "the app" (never the operation's own id). */
const APP_AREA_WORDS: Record<string, [string, string]> = {
  automations: ["예약", "schedule"], chats: ["대화", "conversation"], projects: ["프로젝트", "project"], agent: ["에이전트", "agent"], agents: ["에이전트", "agent"],
  team: ["팀", "team"], oneMemory: ["기억", "memory"], memory: ["기억", "memory"], mail: ["메일", "mail"], files: ["파일", "file"],
};
/** An app operation's id ("automations.remove") is the app's wiring, not words for a person: it reads as the thing it acts on. */
const OPERATION_ID = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;
export function approvalTarget(record: Pick<SettledToolApproval, "detail" | "tool">, lang: Lang = "ko"): { short: string; full: string } {
  const rawDetail = (record.detail ?? "").trim();
  const detail = rawDetail === record.tool.trim() && toolLabel(rawDetail, lang) !== rawDetail && !OPERATION_ID.test(rawDetail) ? "" : rawDetail;
  if (OPERATION_ID.test(detail) && (record.tool.startsWith("app_call.") || record.tool === detail || !detail.includes(" "))) {
    const area = APP_AREA_WORDS[detail.split(".")[0]!];
    const word = area ? pick(area, lang) : lang === "ko" ? "앱 설정" : "App setting";
    return { short: word, full: "" };
  }
  const full = detail;
  const first = full.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (first) return { short: first.length > 160 ? `${first.slice(0, 160)}…` : first, full };
  const tool = approvalToolName(record.tool, lang);
  return { short: tool, full: "" };
}

const two = (n: number): string => String(n).padStart(2, "0");

/** Today: hour:minute. Another day: the date (no year inside this year). */
export function approvalTimeWord(iso: string, ctx: Pick<ApprovalLineContext, "lang" | "now">): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "";
  const now = new Date(ctx.now);
  if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return `${two(at.getHours())}:${two(at.getMinutes())}`;
  const sameYear = at.getFullYear() === now.getFullYear();
  if (ctx.lang === "ko") return `${sameYear ? "" : `${at.getFullYear()}년 `}${at.getMonth() + 1}월 ${at.getDate()}일`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getMonth()]!;
  return `${month} ${at.getDate()}${sameYear ? "" : `, ${at.getFullYear()}`}`;
}

export function approvalLineOf(record: ApprovalLineRecord, ctx: ApprovalLineContext): ApprovalLine {
  const target = approvalTarget(record, ctx.lang);
  const outcome = outcomeOf(record);
  const device: ApprovalLine["device"] = outcome === "auto" ? "always" : outcome === "expired" ? null : record.device ?? null;
  const details: ApprovalLineDetail[] = [];
  const asker = record.agentId ? ctx.agentName?.(record.agentId)?.trim() : "";
  if (asker) details.push({ label: pick(DETAIL_LABELS.by, ctx.lang), value: asker });
  if (target.full || target.short) details.push({ label: pick(DETAIL_LABELS.target, ctx.lang), value: target.full || target.short });
  const choice = record.choice ? CHOICE_WORDS[record.choice] : undefined;
  if (choice && outcome !== "expired" && outcome !== "auto") details.push({ label: pick(DETAIL_LABELS.answer, ctx.lang), value: pick(choice, ctx.lang) });
  return {
    id: record.id,
    icon: outcome,
    result: pick(!record.remote && outcome === "expired" && (record.closeReason === "cancelled" || record.closeReason === "restarted") ? CLOSE_REASON_WORDS[record.closeReason] : (record.remote ? REMOTE_RESULT_WORDS : RESULT_WORDS)[outcome], ctx.lang),
    kind: record.remote && record.capability && REMOTE_KIND_WORDS[record.capability] ? pick(REMOTE_KIND_WORDS[record.capability]!, ctx.lang) : approvalKindWord(record.capability, ctx.lang),
    target: target.short,
    side: outcome === "auto" ? pick(DEVICE_WORDS[BASIS_KEY[basisOf(record)]], ctx.lang) : device ? pick(DEVICE_WORDS[device], ctx.lang) : null,
    device,
    time: approvalTimeWord(record.decidedAt, ctx),
    details,
  };
}

const timeRange = (records: readonly ApprovalLineRecord[], ctx: ApprovalLineContext): string => {
  const first = approvalTimeWord(records[0]!.decidedAt, ctx);
  const last = approvalTimeWord(records[records.length - 1]!.decidedAt, ctx);
  return first === last ? first : `${first}–${last}`;
};

/**
 * One slot of the conversation (the records that sit between the same two words): lines in time order. Auto-approvals of the same kind
 * that follow each other with nothing else between them are one group ("auto-approved N"); an answer a person gave is never grouped.
 */
export function planApprovalLines(records: readonly ApprovalLineRecord[], ctx: ApprovalLineContext): ApprovalLineItem[] {
  const items: ApprovalLineItem[] = [];
  let run: ApprovalLineRecord[] = [];
  const flush = (): void => {
    if (!run.length) return;
    if (run.length === 1) items.push({ type: "line", line: approvalLineOf(run[0]!, ctx) });
    else {
      const kind = approvalKindWord(run[0]!.capability, ctx.lang);
      const lines = run.map((record) => approvalLineOf(record, ctx));
      const count = run.length;
      items.push({ type: "group", group: {
        id: `group:${run[0]!.id}`,
        title: ctx.lang === "ko" ? `자동 승인 ${count}` : `${count} auto-approved`,
        kind, side: pick(DEVICE_WORDS[BASIS_KEY[basisOf(run[0]!)]], ctx.lang), time: timeRange(run, ctx), lines,
      } });
    }
    run = [];
  };
  for (const record of records) {
    // The same kind AND the same basis: a group's right side names one basis.
    if (outcomeOf(record) === "auto" && (run.length === 0 || ((run[0]!.capability ?? "") === (record.capability ?? "") && basisOf(run[0]!) === basisOf(record)))) { run.push(record); continue; }
    flush();
    if (outcomeOf(record) === "auto") run.push(record);
    else items.push({ type: "line", line: approvalLineOf(record, ctx) });
  }
  flush();
  return items;
}

/** "N more": the rows a group keeps behind its button after the first three. */
export const APPROVAL_GROUP_PREVIEW = 3;
export function approvalMoreWord(count: number, lang: Lang): string { return lang === "ko" ? `+${count}` : `+${count}`; }

/**
 * Where each record sits among the conversation's messages: after the last message made at or before the card was asked (the card
 * stood where the work stood). A record older than every message waits before the first. Order inside a slot is the order asked.
 * `before` is the slot above the first message. A message with no readable time is skipped as an anchor.
 */
export function placeApprovalRecords<M extends { id: string; createdAt?: string | null }>(
  messages: readonly M[],
  records: readonly SettledToolApproval[],
): { before: SettledToolApproval[]; after: Map<string, SettledToolApproval[]> } {
  const anchors = messages
    .map((message) => ({ id: message.id, at: Date.parse(message.createdAt ?? "") }))
    .filter((anchor) => Number.isFinite(anchor.at));
  const before: SettledToolApproval[] = [];
  const after = new Map<string, SettledToolApproval[]>();
  const sorted = [...records].sort((a, b) => (Date.parse(a.requestedAt) || 0) - (Date.parse(b.requestedAt) || 0) || a.id.localeCompare(b.id));
  for (const record of sorted) {
    const asked = Date.parse(record.requestedAt);
    let anchorId: string | null = null;
    if (Number.isFinite(asked)) for (const anchor of anchors) if (anchor.at <= asked) anchorId = anchor.id;
    if (anchorId === null) {
      // No message earlier than the card: it waits at the top; with no message at all it is also the top.
      before.push(record);
      continue;
    }
    const bucket = after.get(anchorId);
    if (bucket) bucket.push(record); else after.set(anchorId, [record]);
  }
  return { before, after };
}

/**
 * The stored one-line notice a closed request already leaves in the conversation (`approval-closed:<request id>`, electron/store/chats.ts) says the same
 * thing as its line here. A conversation that draws the line hides that notice (the phone keeps drawing it). Ids only.
 */
export const APPROVAL_CLOSED_ROW_PREFIX = "approval-closed:";
export function approvalClosedRowIds(records: readonly Pick<SettledToolApproval, "id">[]): Set<string> {
  return new Set(records.map((record) => `${APPROVAL_CLOSED_ROW_PREFIX}${record.id}`));
}
