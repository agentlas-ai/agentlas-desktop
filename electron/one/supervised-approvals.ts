import type Database from "better-sqlite3";
import { delegationFloor, type DelegationFloorCode } from "../../shared/delegated-approval-floor";
import { redactSecrets } from "../../shared/secret-patterns";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import type { ToolApprovalRequestEvent, ToolApprovalResolutionReceipt } from "../../shared/types";
import { supervisorError, type SupervisedRoom } from "../../shared/one-supervisor";
import { releasedPersonalAgentRoomIds } from "./personal-agent-rooms";

/*
 * The personal agent oversees the rooms it hands work to (owner 2026-10-27: "개인 에이전트는 총괄하면서 해줘야지.
 * 내부 MCP 로 연결되잖아."; design one-approval-inbox 2026-10-27 §4.2b). It reads the approvals waiting in those rooms
 * and passes on the owner's own answer, written in the personal conversation, to the original approval. Main decides
 * everything structural here; the model only picks which card the owner meant:
 *   - the card's room is one this personal agent supervises (its Work hand-offs, its messages into rooms, its teammate
 *     dispatches), never any other room;
 *   - a floor card (payment, credential, transaction facts, delete, unjudged) is never answered: owner_tap_required;
 *   - the basis is an owner message in the personal conversation, written after the card appeared, and the current
 *     reply run is the one answering exactly that message.
 * The generic one_app_call route to approval operations stays refused (app-control/policy.ts consent class).
 */

export type SupervisedApprovalKind = "tool" | "browser";
export type SupervisedApprovalDecision = "allow_once" | "deny";

export interface SupervisedApprovalItem {
  kind: SupervisedApprovalKind;
  id: string;
  chatId: string;
  roomTitle: string | null;
  title: string;
  detail: string;
  requestedAt: string;
  expiresAt: string | null;
  floor: DelegationFloorCode | null;
}

export type SupervisedApprovalStatus =
  | "resolved" | "replayed" | "conflict" | "expired" | "not_found"
  | "owner_tap_required" | "owner_message_mismatch" | "not_supervised" | "invalid";

export interface SupervisedApprovalAnswer {
  status: SupervisedApprovalStatus;
  kind?: SupervisedApprovalKind;
  id?: string;
  chatId?: string;
  roomTitle?: string | null;
  decision?: SupervisedApprovalDecision;
  floor?: DelegationFloorCode;
  reason?: string;
}

export interface SupervisedApprovalBinding {
  /** The personal conversation this capability belongs to (checked by the caller and again here). */
  oneChatId: string;
  /** Main's exact reply run for this capability; never a model argument. */
  replyRunId?: string;
}

interface BrowserPending {
  requestId: string;
  owner: { chatId: string | null } | null;
  site: string;
  actionType: string;
  summary: string;
  target: string | null;
  createdAt: number;
  expiresAt: number;
}

/** Host ports. Defaults are the Main stores and approval queues of this process; tests pass their own. */
export interface SupervisedApprovalSources {
  db(): Database.Database;
  tools(): ToolApprovalRequestEvent[];
  resolveTool(request: ToolApprovalRequestEvent, decision: SupervisedApprovalDecision): ToolApprovalResolutionReceipt | Promise<ToolApprovalResolutionReceipt>;
  toolResolution(id: string): ToolApprovalResolutionReceipt | null;
  browsers(): BrowserPending[];
  resolveBrowser(requestId: string, decision: "once" | "deny"): { ok: boolean };
  /** Audit only; failure never changes the answer. */
  record(input: { runId: string; chatId: string; payload: Record<string, unknown>; sourceEventId: string }): void;
}

/** A native (daemon-owned) card is resolved only with a context this module minted after its own checks. */
const nativeAuthorizations = new WeakMap<object, { requestId: string; chatId: string }>();
function authorizeSupervisedNativeApproval(context: object, request: ToolApprovalRequestEvent): void {
  const granted = nativeAuthorizations.get(context);
  if (!granted || granted.requestId !== request.id || granted.chatId !== request.chatId) throw new Error("supervised_approval_native_unauthorized");
}

function defaultSources(): SupervisedApprovalSources {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const approvals = require("../runtime/tool-approval") as typeof import("../runtime/tool-approval");
  // Only the desktop Main configures the daemon's GUI approval channel; anywhere else there is none.
  const native = () => { try { return (require("../invocation/native-gui-controls") as typeof import("../invocation/native-gui-controls")).configuredNativeGuiControls(); } catch { return null; } };
  return {
    db: () => (require("../store/db") as typeof import("../store/db")).getDb(),
    tools: () => {
      const local = approvals.listPendingToolApprovals();
      let remote: ToolApprovalRequestEvent[] = [];
      try { remote = native()?.listAvailableApprovals() ?? []; } catch { remote = []; }
      // Same merge rule as runtime:listToolApprovals (ipc.ts): one card per request id.
      return [...new Map([...local, ...remote].map(request => [request.id, request])).values()];
    },
    resolveTool: (request, decision) => {
      const actionId = toolApprovalActionId(request.id, decision);
      const controls = native();
      if (controls?.hasApproval(request.id)) {
        const selection = controls.mobileApprovalPort(authorizeSupervisedNativeApproval).select(request.id);
        if (!selection) return approvals.getToolApprovalResolution(request.id);
        const context = Object.freeze({});
        nativeAuthorizations.set(context, { requestId: request.id, chatId: request.chatId ?? "" });
        return selection.resolve(context, decision, actionId);
      }
      return approvals.resolveToolApproval(request.id, decision, actionId);
    },
    toolResolution: (id) => approvals.getToolApprovalResolution(id),
    browsers: () => (require("../browser/connect") as typeof import("../browser/connect")).listPendingBrowserApprovals(),
    resolveBrowser: (requestId, decision) => (require("../browser/connect") as typeof import("../browser/connect")).browserResolveApproval(requestId, decision),
    record: (input) => (require("../store/run-events") as typeof import("../store/run-events")).tryRecordRunEvent({
      runId: input.runId, chatId: input.chatId, kind: "approval_delegated", sourceEventId: input.sourceEventId, payload: input.payload,
    }),
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

const tableExists = (db: Database.Database, name: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function personalOneId(db: Database.Database, oneChatId: string): string | null {
  if (!oneChatId || !tableExists(db, "one_supervisor_conversations")) return null;
  const row = db.prepare("SELECT one_id FROM one_supervisor_conversations WHERE chat_id=? LIMIT 2").all(oneChatId) as Array<{ one_id: string }>;
  return row.length === 1 ? row[0].one_id : null;
}

/** Rooms this personal agent supervises: its Work hand-offs, its messages into rooms, its teammate dispatches. */
export function supervisedRoomIds(db: Database.Database, oneId: string, oneChatId: string): Set<string> {
  const rooms = new Set<string>();
  if (tableExists(db, "one_supervisor_requests")) {
    const rows = db.prepare(`SELECT CASE kind WHEN 'work' THEN json_extract(payload_json,'$.workerChatId') ELSE json_extract(payload_json,'$.chatId') END AS chat_id
      FROM one_supervisor_requests WHERE one_id=? AND kind IN ('work','chat-send') AND json_valid(payload_json)`).all(oneId) as Array<{ chat_id: unknown }>;
    for (const row of rows) if (typeof row.chat_id === "string" && row.chat_id) rooms.add(row.chat_id);
  }
  if (tableExists(db, "one_team_dispatches")) {
    const rows = db.prepare("SELECT child_chat_id FROM one_team_dispatches WHERE parent_chat_id=?").all(oneChatId) as Array<{ child_chat_id: string }>;
    for (const row of rows) if (row.child_chat_id) rooms.add(row.child_chat_id);
  }
  rooms.delete(oneChatId); // The personal conversation's own cards are already in front of the owner.
  // A room the owner took back ("내가 직접 이어가기", personal-agent-rooms.ts) is no longer overseen.
  for (const released of releasedPersonalAgentRoomIds(db)) rooms.delete(released);
  return rooms;
}

const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max)}…` : value;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Recipient/amount facts of the call as the card shows it (the arguments themselves never reach the card). */
function cardTransactionFacts(detail: string | undefined): boolean {
  if (!detail) return false;
  const { consentTransactionFacts } = require("../runtime/tool-consent") as typeof import("../runtime/tool-consent"); // eslint-disable-line @typescript-eslint/no-require-imports
  const candidates: unknown[] = [];
  for (const text of [detail, detail.slice(detail.indexOf("{"), detail.lastIndexOf("}") + 1)]) {
    if (!text.startsWith("{")) continue;
    try { candidates.push(JSON.parse(text)); } catch { /* not JSON: key=value pairs below */ }
  }
  // key=value / key: value / "key": value pairs, the shapes a command line or a summarized call carries.
  const pairs: Record<string, string> = {};
  for (const match of detail.matchAll(/["']?([A-Za-z_][A-Za-z0-9_]{0,40})["']?\s*[:=]\s*["']?([^\s,"'}]{1,200})/g)) pairs[match[1]] = match[2];
  for (const match of detail.matchAll(/--([A-Za-z][A-Za-z0-9_-]{0,40})[=\s]+["']?([^\s"']{1,200})/g)) pairs[match[1].replace(/-/g, "_")] = match[2];
  candidates.push(pairs);
  return candidates.some(value => consentTransactionFacts(value) !== undefined);
}

function toolFloor(request: ToolApprovalRequestEvent): DelegationFloorCode | null {
  return delegationFloor({ kind: "tool", tool: request.tool, capability: request.capability ?? null, detail: request.detail ?? null,
    transactionFacts: cardTransactionFacts(request.detail) });
}
function browserFloor(request: BrowserPending): DelegationFloorCode | null {
  return delegationFloor({ kind: "browser", actionType: request.actionType, summary: request.summary, target: request.target });
}

function roomTitle(db: Database.Database, chatId: string): string | null {
  try {
    const row = db.prepare("SELECT title FROM chats WHERE id=?").get(chatId) as { title?: string | null } | undefined;
    return typeof row?.title === "string" && row.title.trim() ? clip(row.title.trim(), 120) : null;
  } catch { return null; }
}

function toolItem(db: Database.Database, request: ToolApprovalRequestEvent): SupervisedApprovalItem {
  return { kind: "tool", id: request.id, chatId: request.chatId!, roomTitle: roomTitle(db, request.chatId!),
    title: clip(request.tool, 120), detail: clip(redactSecrets(request.detail ?? ""), 400),
    requestedAt: request.requestedAt, expiresAt: request.expiresAt ?? null, floor: toolFloor(request) };
}
function browserItem(db: Database.Database, request: BrowserPending): SupervisedApprovalItem {
  const chatId = request.owner!.chatId!;
  return { kind: "browser", id: request.requestId, chatId, roomTitle: roomTitle(db, chatId),
    title: clip(`${request.actionType} on ${request.site}`, 120),
    detail: clip(redactSecrets([request.summary, request.target].filter(Boolean).join("\n")), 400),
    requestedAt: iso(request.createdAt), expiresAt: iso(request.expiresAt), floor: browserFloor(request) };
}

function requirePersonal(db: Database.Database, binding: SupervisedApprovalBinding): string {
  const oneId = personalOneId(db, binding.oneChatId);
  if (!oneId) throw new Error("supervisor_personal_conversation_required");
  return oneId;
}

/**
 * Of the rooms the renderer holds approval cards for, the ones this personal agent supervises, with their titles. The
 * personal conversation draws those cards (owner 2026-10-27: "개인 에이전트 UI/UX 에 뜨게"); each card still answers
 * its own room through the usual approval path, so this only reads. The conversation must be a personal one.
 */
export function supervisedRoomsAmong(input: unknown, db: Database.Database = defaultSources().db()): SupervisedRoom[] {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const conversationChatId = typeof value?.conversationChatId === "string" ? value.conversationChatId.trim() : "";
  const chatIds = Array.isArray(value?.chatIds) ? value.chatIds : null;
  if (!conversationChatId || conversationChatId.length > 256 || !chatIds || chatIds.length > 200
    || chatIds.some(id => typeof id !== "string" || !id || id.length > 256)) throw supervisorError("supervisor_input_invalid", true);
  const oneId = requirePersonal(db, { oneChatId: conversationChatId });
  const rooms = supervisedRoomIds(db, oneId, conversationChatId);
  return [...new Set(chatIds as string[])].filter(chatId => rooms.has(chatId)).map(chatId => ({ chatId, title: roomTitle(db, chatId) }));
}

/** Live approvals waiting in the rooms this personal agent supervises, oldest first. */
export function listSupervisedApprovals(binding: SupervisedApprovalBinding, sources: SupervisedApprovalSources = defaultSources()): SupervisedApprovalItem[] {
  const db = sources.db(), oneId = requirePersonal(db, binding), rooms = supervisedRoomIds(db, oneId, binding.oneChatId);
  const items: SupervisedApprovalItem[] = [];
  for (const request of sources.tools()) {
    if (request.mode === "live" && request.chatId && rooms.has(request.chatId)) items.push(toolItem(db, request));
  }
  const now = Date.now();
  for (const request of sources.browsers()) {
    if (request.expiresAt > now && request.owner?.chatId && rooms.has(request.owner.chatId)) items.push(browserItem(db, request));
  }
  return items.sort((a, b) => a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0);
}

/**
 * The owner message the current reply run answers, or null (a review, check-in or any host-started turn has none).
 * The personal agent cites it back as owner_message_id; Main re-checks it on answer.
 */
export function ownerMessageForTurn(binding: SupervisedApprovalBinding, sources: SupervisedApprovalSources = defaultSources()): string | null {
  const db = sources.db(), oneId = requirePersonal(db, binding);
  if (!binding.replyRunId || !tableExists(db, "one_supervisor_requests")) return null;
  const reply = db.prepare(`SELECT user_message_id FROM one_supervisor_requests
    WHERE one_id=? AND origin_chat_id=? AND run_id=? AND kind='reply' LIMIT 2`).all(oneId, binding.oneChatId, binding.replyRunId) as Array<{ user_message_id: string | null }>;
  return reply.length === 1 ? reply[0].user_message_id : null;
}

/** Answers this process passed on (kind:id -> decision), so a repeat reads as replayed or conflict. */
const answered = new Map<string, SupervisedApprovalDecision>();
function remember(key: string, decision: SupervisedApprovalDecision): void {
  answered.delete(key); answered.set(key, decision);
  while (answered.size > 500) answered.delete(answered.keys().next().value!);
}

/**
 * Structural basis (never the model's reading of it): an owner-written message in this personal conversation, written
 * after the card appeared, and the current reply run is the one answering exactly that message.
 */
function basisMismatch(db: Database.Database, oneId: string, binding: SupervisedApprovalBinding, messageId: string, requestedAt: string): string | null {
  if (!tableExists(db, "chat_messages")) return "owner_message_not_found";
  const message = db.prepare("SELECT chat_id,role,created_at FROM chat_messages WHERE id=?").get(messageId) as
    { chat_id: string; role: string; created_at: string } | undefined;
  if (!message) return "owner_message_not_found";
  if (message.chat_id !== binding.oneChatId) return "owner_message_not_in_personal_conversation";
  if (message.role !== "user") return "owner_message_not_owner";
  const written = Date.parse(message.created_at), asked = Date.parse(requestedAt);
  if (!Number.isFinite(written) || !Number.isFinite(asked) || written <= asked) return "owner_message_before_request";
  if (!binding.replyRunId || !tableExists(db, "one_supervisor_requests")) return "reply_turn_not_for_owner_message";
  const reply = db.prepare(`SELECT user_message_id FROM one_supervisor_requests
    WHERE one_id=? AND origin_chat_id=? AND run_id=? AND kind='reply' LIMIT 2`).all(oneId, binding.oneChatId, binding.replyRunId) as Array<{ user_message_id: string | null }>;
  if (reply.length !== 1 || reply[0].user_message_id !== messageId) return "reply_turn_not_for_owner_message";
  return null;
}

const receiptStatus = (status: ToolApprovalResolutionReceipt["status"]): SupervisedApprovalStatus =>
  status === "resolved" || status === "replayed" || status === "conflict" || status === "expired" ? status
    : status === "invalid_action" ? "invalid" : "not_found";

/**
 * Passes the owner's answer to one approval in a supervised room. Floors are never answered (owner_tap_required);
 * nothing is applied unless every structural check passes. Decisions are once-only: "always" stays the owner's tap.
 */
export async function answerSupervisedApproval(
  input: { id: unknown; kind: unknown; decision: unknown; basis: { kind: unknown; messageId: unknown } | null | undefined },
  binding: SupervisedApprovalBinding,
  sources: SupervisedApprovalSources = defaultSources(),
): Promise<SupervisedApprovalAnswer> {
  const id = typeof input.id === "string" ? input.id.trim().slice(0, 256) : "";
  const kind = input.kind === "tool" || input.kind === "browser" ? input.kind : null;
  const decision: SupervisedApprovalDecision | null = input.decision === "allow_once" || (kind === "browser" && input.decision === "once") ? "allow_once"
    : input.decision === "deny" ? "deny" : null;
  const messageId = input.basis?.kind === "owner_message" && typeof input.basis.messageId === "string" ? input.basis.messageId.trim().slice(0, 256) : "";
  if (!id || !kind || !decision || !messageId) return { status: "invalid", reason: "approval_answer_input_invalid" };
  const db = sources.db(), oneId = requirePersonal(db, binding);
  const key = `${kind}:${id}`, prior = answered.get(key);
  if (prior) return { status: prior === decision ? "replayed" : "conflict", kind, id, decision: prior };

  let chatId: string, requestedAt: string, floor: DelegationFloorCode | null;
  let apply: () => Promise<{ status: SupervisedApprovalStatus; decision?: SupervisedApprovalDecision }>;
  if (kind === "tool") {
    const request = sources.tools().find(item => item.id === id && item.mode === "live");
    if (!request) {
      // Not waiting any more: report what happened to it; nothing is applied.
      const receipt = sources.toolResolution(id);
      if (!receipt || receipt.status === "not_found" || receipt.status === "pending") return { status: "not_found", kind, id };
      if (receipt.status === "expired") return { status: "expired", kind, id };
      return { status: receipt.resolvedDecision === decision ? "replayed" : "conflict", kind, id };
    }
    if (!request.chatId) return { status: "not_supervised", kind, id };
    chatId = request.chatId; requestedAt = request.requestedAt; floor = toolFloor(request);
    apply = async () => {
      const receipt = await sources.resolveTool(request, decision);
      const resolved = receipt.resolvedDecision === "allow_once" || receipt.resolvedDecision === "deny" ? receipt.resolvedDecision : undefined;
      return { status: receiptStatus(receipt.status), ...(resolved ? { decision: resolved } : {}) };
    };
  } else {
    const request = sources.browsers().find(item => item.requestId === id && item.expiresAt > Date.now());
    if (!request) return { status: "not_found", kind, id };
    if (!request.owner?.chatId) return { status: "not_supervised", kind, id };
    chatId = request.owner.chatId; requestedAt = iso(request.createdAt); floor = browserFloor(request);
    apply = async () => sources.resolveBrowser(id, decision === "allow_once" ? "once" : "deny").ok
      ? { status: "resolved", decision } : { status: "not_found" };
  }
  const where: { kind: SupervisedApprovalKind; id: string; chatId: string; roomTitle: string | null } = { kind, id, chatId, roomTitle: roomTitle(db, chatId) };
  if (!supervisedRoomIds(db, oneId, binding.oneChatId).has(chatId)) return { status: "not_supervised", ...where };
  if (floor) return { status: "owner_tap_required", floor, ...where };
  const mismatch = basisMismatch(db, oneId, binding, messageId, requestedAt);
  if (mismatch) return { status: "owner_message_mismatch", reason: mismatch, ...where };
  const outcome = await apply();
  if (outcome.status === "resolved") {
    remember(key, decision);
    try {
      sources.record({ runId: binding.replyRunId!, chatId: binding.oneChatId, sourceEventId: `approval-delegated:${key}`,
        payload: { approvalKind: kind, approvalId: id, roomChatId: chatId, decision, actor: "personal-agent", basis: "owner_message", ownerMessageId: messageId } });
    } catch { /* The answer is already applied; the audit row is best effort. */ }
  }
  return { ...outcome, ...where };
}
