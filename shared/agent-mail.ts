// Agent mail (One's own address) — Desktop ↔ web contract.
// The web server owns the address, the monthly recipient meter, threads,
// read state, drafts and the entitlement; Desktop only reads and asks.
// Nothing here is decided locally. Source of truth for the wire shapes:
// docs/2026-09-26-agent-mailbox/API.md (web). Optional fields are optional
// because an older server does not send them — the UI hides a setting the
// server does not report instead of pretending it exists.

export interface AgentMailEntitlement {
  available: boolean;
  mailbox: { read: boolean; send: boolean };
  addressLimit: number;
  monthlyRecipientLimit: number;
  usedThisMonth: number;
  remainingThisMonth: number;
  period: { key: string; start: string; end: string };
  address: string | null;
}

export type AgentMailInboundMode = "notify" | "draft" | "reply";
export const AGENT_MAIL_INBOUND_MODES: readonly AgentMailInboundMode[] = ["notify", "draft", "reply"];

export interface AgentMailSenderRule {
  address: string;
  mode: AgentMailInboundMode;
}

export interface AgentMailMailbox {
  id: string;
  address: string;
  status: "provisioning" | "active" | "deleted";
  provider: string;
  createdAt: string;
  /** From name. null = address only. Absent = server does not support it yet. */
  displayName?: string | null;
  signature?: string | null;
  inboundMode?: AgentMailInboundMode;
  senderRules?: AgentMailSenderRule[];
  /** Earlier addresses that still receive. */
  aliases?: string[];
  addressChosen?: boolean;
  addressChosenAt?: string | null;
  /** The server lets the owner pick the address now (once only). */
  canChooseAddress?: boolean;
  updatedAt?: string;
}

/** Server constants carried in responses — never hardcoded on Desktop. */
export interface AgentMailLimits {
  pollAfterMs?: number;
  pageSizeDefault?: number;
  pageSizeMax?: number;
  maxRecipientsPerMessage?: number;
  maxTextBytes?: number;
  maxHtmlBytes?: number;
  maxAttachmentBytesTotal?: number;
  localPart?: { minLength: number; maxLength: number; pattern: string };
  signatureMaxChars?: number;
  displayNameMaxChars?: number;
  threadMaxMessages?: number;
}

export type AgentMailOrigin = "one" | "owner" | "automation";

export interface AgentMailOriginRef {
  chatId?: string;
  runId?: string;
  automationId?: string;
}

export interface AgentMailAttachmentMeta {
  index?: number;
  filename: string | null;
  contentType: string | null;
  size: number;
  downloadable?: boolean;
}

export type AgentMailSendStatus = "accepted" | "uncertain" | "delivered" | "bounced" | "complained" | "rejected";

export interface AgentMailMessageSummary {
  id: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  preview: string;
  receivedAt: string;
  threadId: string | null;
  inReplyTo: string | null;
  providerMessageId: string;
  attachments: AgentMailAttachmentMeta[];
  rfcMessageId?: string | null;
  references?: string[];
  readAt?: string | null;
  unread?: boolean;
  archived?: boolean;
  origin?: AgentMailOrigin | null;
  originRef?: AgentMailOriginRef | null;
  sendId?: string | null;
  sendStatus?: AgentMailSendStatus | null;
  /** Auto-reply / bulk / list headers present (RFC 3834). Never auto-answered. */
  automated?: boolean;
  autoHeaders?: { autoSubmitted: string | null; precedence: string | null; listId: string | null };
}

export interface AgentMailMessage extends AgentMailMessageSummary {
  text: string;
  html: string;
}

export type AgentMailThreadView = "inbox" | "waiting" | "sent" | "archived" | "all";
export const AGENT_MAIL_THREAD_VIEWS: readonly AgentMailThreadView[] = ["inbox", "waiting", "sent", "archived", "all"];

export interface AgentMailThreadSummary {
  id: string;
  subject: string;
  participants: string[];
  lastMessageAt: string;
  lastMessageId: string;
  lastDirection: "inbound" | "outbound";
  lastFrom: string;
  lastOrigin: AgentMailOrigin | null;
  messageCount: number;
  unreadCount: number;
  snippet: string;
  hasAttachments: boolean;
  hasInbound?: boolean;
  hasOutbound?: boolean;
  archived: boolean;
  status?: "new" | "waiting_reply" | "done";
  handledBy?: "one" | "owner" | null;
  waitUntil?: string | null;
  sendProblem?: "bounced" | "complained" | "rejected" | "uncertain" | null;
  changeSeq?: number;
}

export interface AgentMailUnread {
  inbox: number;
  inboxThreads?: number;
}

export interface AgentMailDraft {
  id: string;
  threadId: string | null;
  replyToMessageId: string | null;
  basedOnMessageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  origin: AgentMailOrigin | null;
  originRef: AgentMailOriginRef | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMailDraftInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  replyToMessageId?: string | null;
  basedOnMessageId?: string | null;
  threadId?: string | null;
}

export interface AgentMailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  /** Legacy: raw RFC header. Prefer replyToMessageId. */
  inReplyTo?: string;
  /** Our message id — the server fills In-Reply-To, References and the thread. */
  replyToMessageId?: string;
  /** The last message of the thread when this reply was written (409 thread_moved if it changed). */
  basedOnMessageId?: string;
  /** Same key → same send (no second email). Desktop mints one per compose. */
  idempotencyKey?: string;
}

export interface AgentMailSendReceipt {
  id: string;
  status: "reserved" | "accepted" | "rejected" | "uncertain" | "delivered" | "bounced" | "complained";
  recipientCount: number;
  providerMessageId: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface AgentMailSendResult {
  send: AgentMailSendReceipt;
  replay: boolean;
  remainingThisMonth: number;
  message?: AgentMailMessage | null;
}

/** Machine-readable refusal. `code` comes from the server (e.g. agent_mail_monthly_limit_reached). */
export interface AgentMailError {
  ok: false;
  code: string;
  message: string;
  status: number | null;
  detail?: Record<string, unknown>;
}

export type AgentMailResult<T> = ({ ok: true } & T) | AgentMailError;

export type AgentMailStatus = AgentMailResult<{
  signedIn: boolean;
  entitlement: AgentMailEntitlement | null;
  mailbox: AgentMailMailbox | null;
  limits?: AgentMailLimits | null;
}>;

export interface AgentMailMailboxPatch {
  displayName?: string | null;
  signature?: string | null;
  inboundMode?: AgentMailInboundMode;
  senderRules?: AgentMailSenderRule[];
  /** Pick-once address choice. */
  localPart?: string;
}

export interface AgentMailThreadsInput {
  view?: AgentMailThreadView;
  q?: string;
  cursor?: string | null;
  limit?: number;
}

export interface AgentMailThreadDetail {
  thread: AgentMailThreadSummary;
  messages: AgentMailMessage[];
  drafts: AgentMailDraft[];
}

/**
 * Main → renderer (and mobile bridge) change notice. Ids and counts only —
 * listeners re-read what they show.
 */
export interface AgentMailChangedEvent {
  reason: "changes" | "resync" | "mailbox" | "status" | "signed-out";
  threadIds: string[];
  deletedThreadIds: string[];
  unread: AgentMailUnread | null;
  changeSeq: number | null;
  /** Ids of newly received inbound messages in this batch (for notifications). */
  receivedMessageIds: string[];
}

/** "One에게 맡기기" — Main creates the One conversation and returns it. */
export interface AgentMailDelegateInput {
  threadId: string;
  /** Owner's extra instruction (optional). */
  instruction?: string;
  locale?: "ko" | "en";
}

export interface AgentMailIpc {
  status: () => Promise<AgentMailStatus>;
  issue: (input?: { displayName?: string; localPart?: string }) => Promise<AgentMailResult<{ mailbox: AgentMailMailbox; created: boolean; entitlement: AgentMailEntitlement | null }>>;
  updateMailbox: (patch: AgentMailMailboxPatch) => Promise<AgentMailResult<{ mailbox: AgentMailMailbox; entitlement: AgentMailEntitlement | null }>>;
  checkAddress: (localPart: string) => Promise<AgentMailResult<{ localPart: string; address: string; available: boolean; code: string | null }>>;
  list: (input?: { cursor?: string | null; limit?: number; direction?: "inbound" | "outbound" }) => Promise<AgentMailResult<{ messages: AgentMailMessageSummary[]; nextCursor: string | null }>>;
  get: (id: string) => Promise<AgentMailResult<{ message: AgentMailMessage }>>;
  send: (input: AgentMailSendInput) => Promise<AgentMailResult<AgentMailSendResult>>;
  remove: (id: string) => Promise<AgentMailResult<{ deleted: true }>>;
  threads: (input?: AgentMailThreadsInput) => Promise<AgentMailResult<{ threads: AgentMailThreadSummary[]; nextCursor: string | null; unread: AgentMailUnread | null }>>;
  thread: (id: string) => Promise<AgentMailResult<AgentMailThreadDetail>>;
  markRead: (input: { threadId: string; read: boolean }) => Promise<AgentMailResult<{ thread: AgentMailThreadSummary; unread: AgentMailUnread | null }>>;
  archive: (input: { threadId: string; archived: boolean }) => Promise<AgentMailResult<{ thread: AgentMailThreadSummary; unread: AgentMailUnread | null }>>;
  removeThread: (id: string) => Promise<AgentMailResult<{ deleted: true }>>;
  unread: () => Promise<AgentMailResult<{ unread: AgentMailUnread }>>;
  drafts: (input?: { threadId?: string; cursor?: string | null }) => Promise<AgentMailResult<{ drafts: AgentMailDraft[]; nextCursor: string | null }>>;
  saveDraft: (input: { id?: string | null; expectedVersion?: number; fields: AgentMailDraftInput }) => Promise<AgentMailResult<{ draft: AgentMailDraft }>>;
  removeDraft: (id: string) => Promise<AgentMailResult<{ deleted: true }>>;
  sendDraft: (input: { id: string; expectedVersion?: number }) => Promise<AgentMailResult<AgentMailSendResult>>;
  /** Saves to the Downloads folder (owner surface). */
  downloadAttachment: (input: { messageId: string; index: number }) => Promise<AgentMailResult<{ path: string; bytes: number }>>;
  delegate: (input: AgentMailDelegateInput) => Promise<AgentMailResult<{ chatId: string; runId: string | null }>>;
}

export const AGENT_MAIL_IPC_CHANNELS = {
  status: "agentMail:status",
  issue: "agentMail:issue",
  updateMailbox: "agentMail:updateMailbox",
  checkAddress: "agentMail:checkAddress",
  list: "agentMail:list",
  get: "agentMail:get",
  send: "agentMail:send",
  remove: "agentMail:remove",
  threads: "agentMail:threads",
  thread: "agentMail:thread",
  markRead: "agentMail:markRead",
  archive: "agentMail:archive",
  removeThread: "agentMail:removeThread",
  unread: "agentMail:unread",
  drafts: "agentMail:drafts",
  saveDraft: "agentMail:saveDraft",
  removeDraft: "agentMail:removeDraft",
  sendDraft: "agentMail:sendDraft",
  downloadAttachment: "agentMail:downloadAttachment",
  delegate: "agentMail:delegate",
} as const;

/** Main → renderer broadcast channel. */
export const AGENT_MAIL_CHANGED_EVENT = "agentMail:changed" as const;

/** Server id shape (hex / uuid-ish). Shared by Main validation and the renderer. */
export function isAgentMailId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Bare address from "Name <a@b>" or "a@b". Lowercased. */
export function agentMailBareAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim().toLowerCase();
}

/** Display part of "Name <a@b>", or the address when there is no name. */
export function agentMailDisplayName(value: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(value);
  const name = match?.[1]?.trim();
  return name || agentMailBareAddress(value);
}
