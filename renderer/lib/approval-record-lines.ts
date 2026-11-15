/*
 * The one quiet line a conversation keeps where an approval card was (Agentlas 2.0 AL; pictures desktop-impl-gaps-9 AL-1..AL-4).
 * Pure: the words, the order, the grouping and the slot of each line come from the stored record and closed values only. No model, no
 * timer, no stored value of its own.
 *
 * Where each value comes from (the durable ledger row `one_supervisor_tool_approvals`, read by `listSettledToolApprovals`):
 *   result      <- status + decision (resolved + deny = declined, resolved + allow_* = approved, expired = expired)
 *   kind        <- the request's `capability` when it is money | delete | send (the approval rule's three cards); any other value draws no kind word
 *   target      <- the redacted `detail` of the request (the tool's display name when there is none)
 *   time        <- `decided_at`
 *   asked by    <- the request's `agentId`, named by the caller (nothing when the caller cannot name it)
 *   choice      <- the decision (Yes / Yes, don't ask again during this task / Yes, always allow / No: the card's own words)
 *   device      <- `device` (desktop | phone), written on the ledger row by the path the answer came in through (BB-1a). Absent = not said: the line draws no device (an expired card, an answer
 *                  relayed through the personal agent, a row written before the ledger kept it)
 *   auto        <- `auto` (always_allow | full_access | unattended): a delete / send call that went through with no card, one settled row per call (BB-1a; `unattended` BB-1c). It reads as the "auto-approved" result, its right
 *                  side says the basis ("Always allow" / "Full access" / "Unattended run"), and it has no answer row
 * Still not in any record, so never drawn: the device of an answer that does not say it, and an auto-approval of any kind but delete and send (those are not recorded).
 */
import type { SettledToolApproval } from "@shared/types";

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

const RESULT_WORDS: Record<ApprovalLineOutcome, [string, string]> = {
  approved: ["승인됨", "Approved"],
  declined: ["거절됨", "Declined"],
  expired: ["만료됨", "Expired"],
  auto: ["자동 승인", "Auto-approved"],
};
const KIND_WORDS: Record<string, [string, string]> = {
  delete: ["삭제", "Delete"],
  send: ["외부 전송", "Send outside"],
  money: ["결제", "Payment"],
};
const CHOICE_WORDS: Record<string, [string, string]> = {
  allow_once: ["예", "Yes"],
  allow_session: ["예, 이 작업 동안 다시 묻지 않기", "Yes, and don't ask again during this task"],
  allow_always: ["예, 항상 허용", "Yes, always allow"],
  deny: ["아니오", "No"],
};
const DEVICE_WORDS: Record<ApprovalLineDevice | "always" | "full" | "unattended", [string, string]> = {
  desktop: ["이 데스크탑", "This desktop"],
  phone: ["폰", "Phone"],
  always: ["항상 허용", "Always allow"],
  full: ["전체 액세스", "Full access"],
  unattended: ["무인 실행", "Unattended run"],
};
/** The right-side word of an automatic approval, by its basis. */
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

/** The tool as a person reads it (an MCP call arrives as mcp__<server>__<tool>). Same rule as ToolApprovalInline.toolDisplayName. */
export function approvalToolName(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool.trim());
  const name = (mcp ? mcp[2]! : tool).replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return name || tool.trim();
}

/** What the card was about, on one line: the first non-empty line of the redacted target, else the tool's name. */
export function approvalTarget(record: Pick<SettledToolApproval, "detail" | "tool">): { short: string; full: string } {
  const full = (record.detail ?? "").trim();
  const first = full.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (first) return { short: first.length > 160 ? `${first.slice(0, 160)}…` : first, full };
  const tool = approvalToolName(record.tool);
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
  const target = approvalTarget(record);
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
    result: pick(RESULT_WORDS[outcome], ctx.lang),
    kind: approvalKindWord(record.capability, ctx.lang),
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
        title: ctx.lang === "ko" ? `자동 승인 ${count}건` : `${count} auto-approved`,
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
export function approvalMoreWord(count: number, lang: Lang): string { return lang === "ko" ? `${count}건 더 보기` : `${count} more`; }

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
