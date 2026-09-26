// Main-process client for /api/agent-mail/* with the owner's web session.
// Every call re-reads the entitlement on the server; the Desktop never decides
// eligibility, remaining allowance, unread counts or thread membership by
// itself. Wire shapes: docs/2026-09-26-agent-mailbox/API.md.
import { randomUUID } from "node:crypto";
import { fetchWithHubSession, getSessionCookieHeader, webBaseUrl } from "../auth";
import {
  isAgentMailId,
  type AgentMailDraft,
  type AgentMailDraftInput,
  type AgentMailEntitlement,
  type AgentMailError,
  type AgentMailLimits,
  type AgentMailMailbox,
  type AgentMailMailboxPatch,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMailOrigin,
  type AgentMailOriginRef,
  type AgentMailOutboundAttachment,
  type AgentMailResult,
  type AgentMailSendInput,
  type AgentMailSendResult,
  type AgentMailStatus,
  type AgentMailThreadDetail,
  type AgentMailThreadSummary,
  type AgentMailThreadsInput,
  type AgentMailUnread,
  AGENT_MAIL_THREAD_VIEWS,
  AGENT_MAIL_INBOUND_MODES,
} from "../../shared/agent-mail";

const TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 45_000;
const ATTACHMENT_TIMEOUT_MS = 120_000;

/** Last server answer, so built-in One tools are offered only to owners who have a mailbox. */
let lastKnown: { entitlement: AgentMailEntitlement | null; mailbox: AgentMailMailbox | null; limits: AgentMailLimits | null } = { entitlement: null, mailbox: null, limits: null };
/** When the server was last asked (0 = never in this process). */
let lastAskedAt = 0;
const KNOWN_TTL_MS = 5 * 60_000;

export function agentMailToolsOffered(): boolean {
  return Boolean(lastKnown.entitlement?.available && lastKnown.mailbox?.status === "active");
}

/** Last mailbox the server reported (may be stale by up to one status call). */
export function agentMailLastKnownMailbox(): AgentMailMailbox | null {
  return lastKnown.mailbox;
}

export function agentMailLastKnownLimits(): AgentMailLimits | null {
  return lastKnown.limits;
}

/**
 * The answer a run should use. lastKnown used to be filled only when the
 * renderer opened Settings or onboarding, so after every app restart One ran
 * without its mail tools until the owner happened to open Settings. Ask the
 * server here when this process has never asked (or the answer is old).
 */
export async function agentMailToolsOfferedForRun(): Promise<boolean> {
  if (Date.now() - lastAskedAt > KNOWN_TTL_MS && getSessionCookieHeader()) {
    await agentMailStatus().catch(() => undefined);
  }
  return agentMailToolsOffered();
}

function err(code: string, message: string, status: number | null = null, detail?: Record<string, unknown>): AgentMailError {
  return { ok: false, code, message, status, ...(detail ? { detail } : {}) };
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function send(
  method: Method,
  path: string,
  body: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> },
): Promise<Response | AgentMailError> {
  const cookie = getSessionCookieHeader();
  if (!cookie) return err("sign_in_required", "Sign in to Agentlas to use agent mail.");
  try {
    return await fetchWithHubSession(
      cookie,
      `${webBaseUrl()}${path}`,
      {
        method,
        headers: {
          Accept: "application/json",
          // Cookie-authenticated mutations must carry an allowed Origin (web CSRF gate).
          ...(method === "GET" ? {} : { "Content-Type": "application/json", Origin: webBaseUrl() }),
          ...(opts.headers ?? {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      opts.timeoutMs ?? TIMEOUT_MS,
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return err(aborted ? "timeout" : "network", aborted ? "Agentlas did not answer in time." : "Could not reach Agentlas.");
  }
}

async function call<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ ok: true; status: number; json: T } | AgentMailError> {
  const res = await send(method, path, body, opts);
  if (!(res instanceof Response)) return res;
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (res.status === 401) return err("sign_in_required", "Sign in to Agentlas to use agent mail.", 401);
  if (!res.ok) {
    const { error: message, code, ...detail } = json as { error?: unknown; code?: unknown };
    return err(
      typeof code === "string" ? code : `http_${res.status}`,
      typeof message === "string" ? message : `Agentlas answered ${res.status}.`,
      res.status,
      detail,
    );
  }
  return { ok: true, status: res.status, json: json as T };
}

function rememberMailbox(mailbox: AgentMailMailbox | null | undefined, entitlement?: AgentMailEntitlement | null, limits?: AgentMailLimits | null): void {
  lastKnown = {
    entitlement: entitlement === undefined ? lastKnown.entitlement : entitlement,
    mailbox: mailbox === undefined ? lastKnown.mailbox : mailbox,
    limits: limits === undefined ? lastKnown.limits : limits,
  };
  for (const listener of mailboxListeners) {
    try { listener(lastKnown.mailbox); } catch { /* listener errors never break a call */ }
  }
}

const mailboxListeners = new Set<(mailbox: AgentMailMailbox | null) => void>();
/** Main-only: notified whenever a server answer changed what we know about the mailbox. */
export function onAgentMailMailboxKnown(listener: (mailbox: AgentMailMailbox | null) => void): () => void {
  mailboxListeners.add(listener);
  return () => mailboxListeners.delete(listener);
}

export async function agentMailStatus(): Promise<AgentMailStatus> {
  if (!getSessionCookieHeader()) {
    rememberMailbox(null, null, null);
    return { ok: true, signedIn: false, entitlement: null, mailbox: null, limits: null };
  }
  lastAskedAt = Date.now();
  const res = await call<{ mailbox: AgentMailMailbox | null; agentMail: AgentMailEntitlement; limits?: AgentMailLimits }>("GET", "/api/agent-mail/mailboxes");
  if (!res.ok) {
    if (res.code === "agent_mail_not_available") {
      rememberMailbox(null, null, null);
      return { ok: true, signedIn: true, entitlement: null, mailbox: null, limits: null };
    }
    if (res.code === "sign_in_required") return { ok: true, signedIn: false, entitlement: null, mailbox: null, limits: null };
    return res;
  }
  rememberMailbox(res.json.mailbox ?? null, res.json.agentMail ?? null, res.json.limits ?? null);
  return { ok: true, signedIn: true, entitlement: lastKnown.entitlement, mailbox: lastKnown.mailbox, limits: lastKnown.limits };
}

function cleanLocalPart(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase().slice(0, 64) : undefined;
}

export async function agentMailIssue(input: { displayName?: string; localPart?: string } = {}): Promise<AgentMailResult<{ mailbox: AgentMailMailbox; created: boolean; entitlement: AgentMailEntitlement | null }>> {
  const localPart = cleanLocalPart(input.localPart);
  const res = await call<{ mailbox: AgentMailMailbox; created: boolean; agentMail: AgentMailEntitlement; limits?: AgentMailLimits }>(
    "POST",
    "/api/agent-mail/mailboxes",
    {
      displayName: typeof input.displayName === "string" ? input.displayName.slice(0, 64) : undefined,
      ...(localPart ? { localPart } : {}),
    },
    { timeoutMs: 30_000 },
  );
  if (!res.ok) return res;
  rememberMailbox(res.json.mailbox, res.json.agentMail ?? null, res.json.limits);
  return { ok: true, mailbox: res.json.mailbox, created: res.json.created === true, entitlement: res.json.agentMail ?? null };
}

/** Only the fields the caller gave are sent; the server validates everything. */
export async function agentMailUpdateMailbox(patch: AgentMailMailboxPatch): Promise<AgentMailResult<{ mailbox: AgentMailMailbox; entitlement: AgentMailEntitlement | null }>> {
  const body: Record<string, unknown> = {};
  if (patch && "displayName" in patch) body.displayName = patch.displayName === null ? null : String(patch.displayName ?? "").slice(0, 200);
  if (patch && "signature" in patch) body.signature = patch.signature === null ? null : String(patch.signature ?? "").slice(0, 20_000);
  if (patch && patch.inboundMode !== undefined) {
    if (!AGENT_MAIL_INBOUND_MODES.includes(patch.inboundMode)) return err("agent_mail_invalid_request", "Unknown inbound mode.", null, { field: "inboundMode" });
    body.inboundMode = patch.inboundMode;
  }
  if (patch && Array.isArray(patch.senderRules)) {
    body.senderRules = patch.senderRules
      .filter((rule) => rule && typeof rule.address === "string" && AGENT_MAIL_INBOUND_MODES.includes(rule.mode))
      .slice(0, 200)
      .map((rule) => ({ address: rule.address.trim().toLowerCase().slice(0, 320), mode: rule.mode }));
  }
  const localPart = cleanLocalPart(patch?.localPart);
  if (localPart) body.localPart = localPart;
  if (Object.keys(body).length === 0) return err("agent_mail_invalid_request", "Nothing to change.");
  const res = await call<{ mailbox: AgentMailMailbox; agentMail?: AgentMailEntitlement; limits?: AgentMailLimits }>("PATCH", "/api/agent-mail/mailboxes", body);
  if (!res.ok) return res;
  rememberMailbox(res.json.mailbox, res.json.agentMail ?? undefined, res.json.limits);
  return { ok: true, mailbox: res.json.mailbox, entitlement: res.json.agentMail ?? lastKnown.entitlement };
}

export async function agentMailCheckAddress(localPart: string): Promise<AgentMailResult<{ localPart: string; address: string; available: boolean; code: string | null }>> {
  const clean = cleanLocalPart(localPart);
  if (!clean) return err("agent_mail_invalid_request", "Enter an address.", null, { field: "localPart" });
  const res = await call<{ localPart: string; address: string; available: boolean; code: string | null }>(
    "GET",
    `/api/agent-mail/addresses/check?localPart=${encodeURIComponent(clean)}`,
  );
  if (!res.ok) return res;
  return { ok: true, localPart: res.json.localPart, address: res.json.address, available: res.json.available === true, code: res.json.code ?? null };
}

export async function agentMailList(input: { cursor?: string | null; limit?: number; direction?: "inbound" | "outbound" } = {}): Promise<AgentMailResult<{ messages: AgentMailMessageSummary[]; nextCursor: string | null }>> {
  const query = new URLSearchParams();
  if (input.cursor) query.set("cursor", String(input.cursor).slice(0, 512));
  query.set("limit", String(Math.min(Math.max(Number(input.limit) || 25, 1), 100)));
  if (input.direction === "inbound" || input.direction === "outbound") query.set("direction", input.direction);
  const res = await call<{ messages: AgentMailMessageSummary[]; nextCursor: string | null }>("GET", `/api/agent-mail/messages?${query.toString()}`);
  if (!res.ok) return res;
  return { ok: true, messages: Array.isArray(res.json.messages) ? res.json.messages : [], nextCursor: res.json.nextCursor ?? null };
}

export async function agentMailGet(id: string): Promise<AgentMailResult<{ message: AgentMailMessage }>> {
  if (!isAgentMailId(id)) return err("invalid_message_id", "Invalid message id.");
  const res = await call<{ message: AgentMailMessage }>("GET", `/api/agent-mail/messages/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  return { ok: true, message: res.json.message };
}

export async function agentMailRemove(id: string, actor: AgentMailActor = "owner"): Promise<AgentMailResult<{ deleted: true }>> {
  if (!isAgentMailId(id)) return err("invalid_message_id", "Invalid message id.");
  const res = await call<{ deleted: true }>("DELETE", `/api/agent-mail/messages/${encodeURIComponent(id)}?actor=${actor}`);
  if (!res.ok) return res;
  return { ok: true, deleted: true };
}

export async function agentMailMarkMessageRead(id: string, read: boolean, actor: AgentMailActor = "owner"): Promise<AgentMailResult<{ unread: AgentMailUnread | null }>> {
  if (!isAgentMailId(id)) return err("invalid_message_id", "Invalid message id.");
  const res = await call<{ unread?: AgentMailUnread }>("POST", `/api/agent-mail/messages/${encodeURIComponent(id)}/read`, { read: read === true, actor });
  if (!res.ok) return res;
  return { ok: true, unread: res.json.unread ?? null };
}

/** Who changed it — recorded in the server's change feed only (API.md §0.2). Main decides. */
export type AgentMailActor = "owner" | "one" | "automation";

function stringList(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[,;]/).map((v) => v.trim()).filter(Boolean);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
}

/**
 * Who is sending. Decided by Main only (IPC → owner, MCP control server → one +
 * the run's chat). A renderer or a model can never claim an origin.
 */
export interface AgentMailSendAuthority {
  origin: AgentMailOrigin;
  originRef?: AgentMailOriginRef | null;
  /** Auto-reply from inbound handling: Auto-Submitted: auto-replied (RFC 3834). */
  autoSubmitted?: boolean;
}

const OWNER_AUTHORITY: AgentMailSendAuthority = { origin: "owner" };

function originBody(authority: AgentMailSendAuthority): Record<string, unknown> {
  const ref = authority.originRef ?? null;
  const cleanRef = ref
    ? Object.fromEntries(Object.entries(ref).filter(([, v]) => typeof v === "string" && v.length > 0 && v.length <= 128))
    : null;
  return {
    origin: authority.origin,
    ...(cleanRef && Object.keys(cleanRef).length ? { originRef: cleanRef } : {}),
    ...(authority.autoSubmitted ? { autoSubmitted: true } : {}),
  };
}

function sendOutcome(res: { ok: true; status: number; json: AgentMailSendResult } | AgentMailError, idempotencyKey: string | null): AgentMailResult<AgentMailSendResult> {
  if (!res.ok) {
    // A timeout after the request left is not a refusal: the server may have sent it.
    if (res.code === "timeout" || res.code === "network") {
      return err("send_outcome_unknown", "The send result is unknown. Check Sent before sending again.", null, idempotencyKey ? { idempotencyKey } : undefined);
    }
    return res;
  }
  return {
    ok: true,
    send: res.json.send,
    replay: res.json.replay === true,
    remainingThisMonth: res.json.remainingThisMonth,
    message: res.json.message ?? null,
  };
}

/**
 * Send once. The idempotency key is minted here when the caller has none, so a
 * transport retry of the SAME call can never send twice. There is no automatic
 * retry: an uncertain result is returned as-is.
 */
/**
 * Owner-attached files for one send. The server is the judge of size (its
 * limits travel in `limits`); this only refuses what it would refuse anyway,
 * before tens of megabytes cross the wire.
 */
function outboundAttachments(input: unknown): { ok: true; list: AgentMailOutboundAttachment[] } | AgentMailError {
  if (input === undefined || input === null) return { ok: true, list: [] };
  if (!Array.isArray(input)) return err("agent_mail_invalid_request", "Attachments must be a list.", null, { field: "attachments" });
  const list: AgentMailOutboundAttachment[] = [];
  let bytes = 0;
  for (const item of input) {
    const value = item && typeof item === "object" ? item as Partial<AgentMailOutboundAttachment> : null;
    const filename = typeof value?.filename === "string" ? value.filename.replace(/[\r\n\\/]+/g, " ").trim().slice(0, 255) : "";
    const contentBase64 = typeof value?.contentBase64 === "string" ? value.contentBase64.replace(/\s+/g, "") : "";
    if (!filename || !contentBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
      return err("agent_mail_invalid_request", "An attachment is missing its name or bytes.", null, { field: "attachments" });
    }
    const contentType = typeof value?.contentType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(value.contentType) ? value.contentType : "application/octet-stream";
    bytes += Math.floor((contentBase64.length * 3) / 4) - (contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0);
    list.push({ filename, contentType, contentBase64 });
  }
  const maxCount = lastKnown.limits?.maxAttachmentsPerMessage ?? null;
  const maxBytes = lastKnown.limits?.maxAttachmentBytesTotal ?? null;
  if ((maxCount !== null && list.length > maxCount) || (maxBytes !== null && bytes > maxBytes)) {
    return err("agent_mail_attachments_too_large", "The attachments are larger than this mailbox can send.", 413, { maxAttachmentBytesTotal: maxBytes, maxAttachmentsPerMessage: maxCount, requestedBytes: bytes });
  }
  return { ok: true, list };
}

export async function agentMailSend(
  input: AgentMailSendInput,
  authority: AgentMailSendAuthority = OWNER_AUTHORITY,
): Promise<AgentMailResult<AgentMailSendResult>> {
  const idempotencyKey = typeof input?.idempotencyKey === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(input.idempotencyKey)
    ? input.idempotencyKey
    : `desk-${randomUUID()}`;
  const replyTo = isAgentMailId(input?.replyToMessageId) ? input.replyToMessageId : undefined;
  const basedOn = isAgentMailId(input?.basedOnMessageId) ? input.basedOnMessageId : undefined;
  const attachments = outboundAttachments(input?.attachments);
  if (!attachments.ok) return attachments;
  const res = await call<AgentMailSendResult>(
    "POST",
    "/api/agent-mail/messages",
    {
      to: stringList(input?.to),
      cc: stringList(input?.cc),
      bcc: stringList(input?.bcc),
      subject: typeof input?.subject === "string" ? input.subject : "",
      text: typeof input?.text === "string" ? input.text : "",
      ...(replyTo ? { replyToMessageId: replyTo } : typeof input?.inReplyTo === "string" ? { inReplyTo: input.inReplyTo } : {}),
      ...(basedOn ? { basedOnMessageId: basedOn } : {}),
      ...(attachments.list.length ? { attachments: attachments.list } : {}),
      ...originBody(authority),
    },
    { timeoutMs: attachments.list.length ? ATTACHMENT_TIMEOUT_MS : SEND_TIMEOUT_MS, headers: { "Idempotency-Key": idempotencyKey } },
  );
  return sendOutcome(res, idempotencyKey);
}

// ── Threads ────────────────────────────────────────────────────────────────

export async function agentMailThreads(input: AgentMailThreadsInput = {}): Promise<AgentMailResult<{ threads: AgentMailThreadSummary[]; nextCursor: string | null; unread: AgentMailUnread | null }>> {
  const query = new URLSearchParams();
  const view = input.view && AGENT_MAIL_THREAD_VIEWS.includes(input.view) ? input.view : "inbox";
  query.set("view", view);
  if (typeof input.q === "string" && input.q.trim()) query.set("q", input.q.trim().slice(0, 500));
  if (input.cursor) query.set("cursor", String(input.cursor).slice(0, 512));
  const max = lastKnown.limits?.pageSizeMax ?? 100;
  if (input.limit !== undefined) query.set("limit", String(Math.min(Math.max(Number(input.limit) || 1, 1), max)));
  const res = await call<{ threads: AgentMailThreadSummary[]; nextCursor: string | null; unread?: AgentMailUnread }>("GET", `/api/agent-mail/threads?${query.toString()}`);
  if (!res.ok) return res;
  return {
    ok: true,
    threads: Array.isArray(res.json.threads) ? res.json.threads : [],
    nextCursor: res.json.nextCursor ?? null,
    unread: res.json.unread ?? null,
  };
}

export async function agentMailThread(id: string): Promise<AgentMailResult<AgentMailThreadDetail>> {
  if (!isAgentMailId(id)) return err("invalid_thread_id", "Invalid thread id.");
  const res = await call<AgentMailThreadDetail>("GET", `/api/agent-mail/threads/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  return {
    ok: true,
    thread: res.json.thread,
    messages: Array.isArray(res.json.messages) ? res.json.messages : [],
    drafts: Array.isArray(res.json.drafts) ? res.json.drafts : [],
  };
}

export async function agentMailMarkThreadRead(threadId: string, read: boolean, actor: AgentMailActor = "owner"): Promise<AgentMailResult<{ thread: AgentMailThreadSummary; unread: AgentMailUnread | null }>> {
  if (!isAgentMailId(threadId)) return err("invalid_thread_id", "Invalid thread id.");
  const res = await call<{ thread: AgentMailThreadSummary; unread?: AgentMailUnread }>("POST", `/api/agent-mail/threads/${encodeURIComponent(threadId)}/read`, { read: read === true, actor });
  if (!res.ok) return res;
  return { ok: true, thread: res.json.thread, unread: res.json.unread ?? null };
}

export async function agentMailArchiveThread(threadId: string, archived: boolean, actor: AgentMailActor = "owner"): Promise<AgentMailResult<{ thread: AgentMailThreadSummary; unread: AgentMailUnread | null }>> {
  if (!isAgentMailId(threadId)) return err("invalid_thread_id", "Invalid thread id.");
  const res = await call<{ thread: AgentMailThreadSummary; unread?: AgentMailUnread }>("POST", `/api/agent-mail/threads/${encodeURIComponent(threadId)}/archive`, { archived: archived === true, actor });
  if (!res.ok) return res;
  return { ok: true, thread: res.json.thread, unread: res.json.unread ?? null };
}

export async function agentMailRemoveThread(threadId: string, actor: AgentMailActor = "owner"): Promise<AgentMailResult<{ deleted: true }>> {
  if (!isAgentMailId(threadId)) return err("invalid_thread_id", "Invalid thread id.");
  const res = await call<{ deleted: true }>("DELETE", `/api/agent-mail/threads/${encodeURIComponent(threadId)}?actor=${actor}`);
  if (!res.ok) return res;
  return { ok: true, deleted: true };
}

export async function agentMailUnread(): Promise<AgentMailResult<{ unread: AgentMailUnread; changeSeq: number | null }>> {
  const res = await call<{ unread: AgentMailUnread; changeSeq?: number }>("GET", "/api/agent-mail/unread");
  if (!res.ok) return res;
  return { ok: true, unread: res.json.unread ?? { inbox: 0 }, changeSeq: typeof res.json.changeSeq === "number" ? res.json.changeSeq : null };
}

export interface AgentMailChangesPage {
  changeSeq: number;
  threads: AgentMailThreadSummary[];
  deletedThreadIds: string[];
  drafts: AgentMailDraft[];
  deletedDraftIds: string[];
  mailbox: AgentMailMailbox | null;
  unread: AgentMailUnread | null;
  pollAfterMs: number | null;
  hasMore: boolean;
  events: Array<{ seq: number; kind: string; threadId: string | null; messageId: string | null; actor: string; at: string }>;
}

/** `since` null → baseline only. 409 resync_required is returned as the error code. */
export async function agentMailChanges(since: number | null): Promise<AgentMailResult<AgentMailChangesPage>> {
  const query = since === null ? "" : `?since=${encodeURIComponent(String(Math.max(0, Math.floor(since))))}`;
  const res = await call<Partial<AgentMailChangesPage>>("GET", `/api/agent-mail/changes${query}`);
  if (!res.ok) return res;
  const json = res.json;
  if (json.mailbox) rememberMailbox(json.mailbox);
  return {
    ok: true,
    changeSeq: typeof json.changeSeq === "number" ? json.changeSeq : 0,
    threads: Array.isArray(json.threads) ? json.threads : [],
    deletedThreadIds: Array.isArray(json.deletedThreadIds) ? json.deletedThreadIds.filter(isAgentMailId) : [],
    drafts: Array.isArray(json.drafts) ? json.drafts : [],
    deletedDraftIds: Array.isArray(json.deletedDraftIds) ? json.deletedDraftIds.filter(isAgentMailId) : [],
    mailbox: json.mailbox ?? null,
    unread: json.unread ?? null,
    pollAfterMs: typeof json.pollAfterMs === "number" && json.pollAfterMs > 0 ? json.pollAfterMs : null,
    hasMore: json.hasMore === true,
    events: Array.isArray(json.events) ? json.events : [],
  };
}

// ── Drafts ─────────────────────────────────────────────────────────────────

function draftBody(fields: AgentMailDraftInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.to !== undefined) body.to = stringList(fields.to);
  if (fields.cc !== undefined) body.cc = stringList(fields.cc);
  if (fields.bcc !== undefined) body.bcc = stringList(fields.bcc);
  if (typeof fields.subject === "string") body.subject = fields.subject;
  if (typeof fields.text === "string") body.text = fields.text;
  if (isAgentMailId(fields.replyToMessageId)) body.replyToMessageId = fields.replyToMessageId;
  if (isAgentMailId(fields.basedOnMessageId)) body.basedOnMessageId = fields.basedOnMessageId;
  if (isAgentMailId(fields.threadId)) body.threadId = fields.threadId;
  return body;
}

export async function agentMailDrafts(input: { threadId?: string; cursor?: string | null } = {}): Promise<AgentMailResult<{ drafts: AgentMailDraft[]; nextCursor: string | null }>> {
  const query = new URLSearchParams();
  if (isAgentMailId(input.threadId)) query.set("threadId", input.threadId);
  if (input.cursor) query.set("cursor", String(input.cursor).slice(0, 512));
  const res = await call<{ drafts: AgentMailDraft[]; nextCursor: string | null }>("GET", `/api/agent-mail/drafts${query.size ? `?${query.toString()}` : ""}`);
  if (!res.ok) return res;
  return { ok: true, drafts: Array.isArray(res.json.drafts) ? res.json.drafts : [], nextCursor: res.json.nextCursor ?? null };
}

export async function agentMailSaveDraft(
  input: { id?: string | null; expectedVersion?: number; fields: AgentMailDraftInput },
  authority: AgentMailSendAuthority = OWNER_AUTHORITY,
): Promise<AgentMailResult<{ draft: AgentMailDraft }>> {
  const fields = input?.fields && typeof input.fields === "object" ? input.fields : {};
  if (input?.id) {
    if (!isAgentMailId(input.id)) return err("invalid_draft_id", "Invalid draft id.");
    const res = await call<{ draft: AgentMailDraft }>("PATCH", `/api/agent-mail/drafts/${encodeURIComponent(input.id)}`, {
      ...draftBody(fields),
      actor: authority.origin,
      ...(Number.isSafeInteger(input.expectedVersion) ? { expectedVersion: input.expectedVersion } : {}),
    });
    if (!res.ok) return res;
    return { ok: true, draft: res.json.draft };
  }
  const res = await call<{ draft: AgentMailDraft }>("POST", "/api/agent-mail/drafts", { ...draftBody(fields), ...originBody(authority) });
  if (!res.ok) return res;
  return { ok: true, draft: res.json.draft };
}

export async function agentMailRemoveDraft(id: string, actor: AgentMailActor = "owner"): Promise<AgentMailResult<{ deleted: true }>> {
  if (!isAgentMailId(id)) return err("invalid_draft_id", "Invalid draft id.");
  const res = await call<{ deleted: true }>("DELETE", `/api/agent-mail/drafts/${encodeURIComponent(id)}?actor=${actor}`);
  if (!res.ok) return res;
  return { ok: true, deleted: true };
}

export async function agentMailSendDraft(
  input: { id: string; expectedVersion?: number },
  authority: AgentMailSendAuthority = OWNER_AUTHORITY,
): Promise<AgentMailResult<AgentMailSendResult>> {
  if (!isAgentMailId(input?.id)) return err("invalid_draft_id", "Invalid draft id.");
  const res = await call<AgentMailSendResult>(
    "POST",
    `/api/agent-mail/drafts/${encodeURIComponent(input.id)}/send`,
    {
      ...(Number.isSafeInteger(input.expectedVersion) ? { expectedVersion: input.expectedVersion } : {}),
      ...originBody(authority),
    },
    { timeoutMs: SEND_TIMEOUT_MS },
  );
  // The server derives the key from draft id + version: a retry is the same send.
  return sendOutcome(res, null);
}

// ── Attachments ────────────────────────────────────────────────────────────

/** Bytes of one attachment. The caller decides where they are written. */
export async function agentMailFetchAttachment(messageId: string, index: number): Promise<AgentMailResult<{ bytes: Buffer; filename: string | null; contentType: string | null }>> {
  if (!isAgentMailId(messageId)) return err("invalid_message_id", "Invalid message id.");
  if (!Number.isSafeInteger(index) || index < 0 || index > 999) return err("invalid_attachment_index", "Invalid attachment index.");
  const res = await send("GET", `/api/agent-mail/messages/${encodeURIComponent(messageId)}/attachments/${index}`, undefined, {
    timeoutMs: ATTACHMENT_TIMEOUT_MS,
    headers: { Accept: "*/*" },
  });
  if (!(res instanceof Response)) return res;
  if (!res.ok) {
    let json: Record<string, unknown> = {};
    try { json = (await res.json()) as Record<string, unknown>; } catch { json = {}; }
    if (res.status === 401) return err("sign_in_required", "Sign in to Agentlas to use agent mail.", 401);
    return err(typeof json.code === "string" ? json.code : `http_${res.status}`, typeof json.error === "string" ? json.error : `Agentlas answered ${res.status}.`, res.status);
  }
  const cap = lastKnown.limits?.maxAttachmentBytesTotal ?? null;
  const declared = Number(res.headers.get("content-length") ?? "");
  if (cap && Number.isFinite(declared) && declared > cap * 2) return err("agent_mail_attachment_too_large", "The attachment is larger than this mailbox allows.");
  const bytes = Buffer.from(await res.arrayBuffer());
  const disposition = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  let filename: string | null = null;
  try { filename = star ? decodeURIComponent(star[1]) : plain ? plain[1] : null; } catch { filename = plain ? plain[1] : null; }
  return { ok: true, bytes, filename, contentType: res.headers.get("content-type") };
}
