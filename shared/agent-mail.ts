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
  /** Legacy pick-once flag. PLAN-2 servers always send false. */
  canChooseAddress?: boolean;
  updatedAt?: string;
  /** PLAN-2: native Agentlas address (permanent) or the owner's verified domain. */
  identityKind?: AgentMailIdentityKind;
  /** Native addresses are permanent (true). */
  addressLocked?: boolean;
  /** custom_domain: the Domain id the address lives on. */
  domainId?: string | null;
  /** Only a verified custom domain lets the address change (domains/:id/address). */
  canChangeAddress?: boolean;
  /** Save people this mailbox sends to as contacts (server default true). */
  autoSaveContacts?: boolean;
}

export type AgentMailIdentityKind = "agentlas_native" | "custom_domain";

/** Server constants carried in responses — never hardcoded on Desktop. */
export interface AgentMailLimits {
  pollAfterMs?: number;
  pageSizeDefault?: number;
  pageSizeMax?: number;
  maxRecipientsPerMessage?: number;
  maxTextBytes?: number;
  maxHtmlBytes?: number;
  maxAttachmentBytesTotal?: number;
  maxAttachmentsPerMessage?: number;
  localPart?: { minLength: number; maxLength: number; pattern: string };
  signatureMaxChars?: number;
  displayNameMaxChars?: number;
  threadMaxMessages?: number;
  suggestionsMax?: number;
  a2aMaxAutonomousTurns?: number;
  externalAutoSendsPerThreadPerHour?: number;
  contactNoteMaxChars?: number;
  contactOneNoteMaxChars?: number;
  contactTagsMax?: number;
  directoryPageMax?: number;
  directoryQueryMinChars?: number;
  card?: {
    nameMaxChars?: number;
    descriptionMaxChars?: number;
    skillsMax?: number;
    skillNameMaxChars?: number;
    skillDescriptionMaxChars?: number;
    skillTagsMax?: number;
    languagesMax?: number;
  };
  domainsPerWorkspaceMax?: number;
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
  automatedReason?: string | null;
  /** PLAN-2: "internal" = delivered inside Agentlas (agent to agent). */
  transport?: "ses" | "internal" | string;
  /** Server-signed agent-to-agent envelope. Never present on mail that came over SMTP. */
  a2a?: AgentMailA2AEnvelope | null;
  /**
   * Why the server would refuse an automatic answer to this inbound mail
   * (null = allowed so far; the send is checked again).
   */
  autoReplyBlockedReason?: string | null;
}

/** P2.3 — filled by the server, never by a client or a model. */
export interface AgentMailA2AEnvelope {
  verified: boolean;
  fromAddress: string;
  conversationId: string;
  turn: number;
  autonomousTurns: number;
  intent: "request" | "reply" | "final";
  expectsReply: boolean;
  cardVersion: number | null;
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
  /** Files the owner attached in the compose sheet (bytes as base64; limits come from the server). */
  attachments?: AgentMailOutboundAttachment[];
  /** A2A: the other agent should answer (server default: true for hand-written, false for auto replies). */
  expectsReply?: boolean;
  /** A2A: this closes the exchange (forces expectsReply false). */
  final?: boolean;
}

export interface AgentMailOutboundAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export interface AgentMailSendReceipt {
  id: string;
  status: "reserved" | "accepted" | "rejected" | "uncertain" | "delivered" | "bounced" | "complained";
  recipientCount: number;
  providerMessageId: string | null;
  errorCode: string | null;
  createdAt: string;
  transport?: "ses" | "internal" | "mixed";
  internalDeliveries?: Array<{ address: string; status: "delivered" | "rejected" }>;
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
  autoSaveContacts?: boolean;
}

// ── PLAN-2: address, contacts, directory, custom domain (API.md "PLAN-2 API") ──

export interface AgentMailAddressCheck {
  localPart: string;
  address: string;
  available: boolean;
  code: string | null;
  reason?: string | null;
  /** Deleted mailbox of this workspace: the only address that can come back. */
  currentAddress?: string | null;
}

export interface AgentMailAddressSuggestion {
  localPart: string;
  address: string;
}

export type AgentMailContactKind = "person" | "agentlas_agent";

export interface AgentMailAgentCardSkill {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface AgentMailContact {
  id: string;
  address: string;
  displayName: string | null;
  kind: AgentMailContactKind;
  /** Server-verified "Agentlas agent" badge. Never decided on Desktop. */
  agentlasAgent: boolean;
  source: "owner" | "one" | "interaction" | "directory" | string;
  agent: null | {
    listed: boolean;
    cardVersion: number | null;
    /** Written by the other party — plain text only. */
    card: { name: string; description: string; skills: AgentMailAgentCardSkill[]; languages: string[] } | null;
  };
  ownerNote: string | null;
  oneNote: string | null;
  tags: string[];
  lastInteractionAt: string | null;
  interactionCount: number;
  receivedCount?: number;
  createdBy: "owner" | "one" | "system" | string;
  updatedBy: "owner" | "one" | "system" | string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMailContactsInput {
  q?: string;
  kind?: AgentMailContactKind;
  cursor?: string | null;
  limit?: number;
}

export interface AgentMailContactSaveInput {
  /** Patch this contact (PATCH /contacts/:id). Without it: save by address (POST). */
  id?: string | null;
  address?: string;
  displayName?: string | null;
  ownerNote?: string | null;
  tags?: string[];
  expectedVersion?: number;
  source?: "directory";
}

export interface AgentMailAgentCard {
  address: string;
  schema?: string;
  name: string;
  description: string;
  skills: AgentMailAgentCardSkill[];
  languages: string[];
  acceptsUnsolicited: boolean;
  version: number;
  updatedAt: string;
}

export interface AgentMailAgentCardInput {
  name: string;
  description?: string;
  skills?: AgentMailAgentCardSkill[];
  languages?: string[];
  acceptsUnsolicited?: boolean;
}

export interface AgentMailDirectoryEntry {
  listed: boolean;
  listedAt: string | null;
  card: AgentMailAgentCard | null;
}

export interface AgentMailDirectoryLookup {
  address: string;
  verified: true;
  listed: boolean;
  card: AgentMailAgentCard | null;
}

export type AgentMailDomainStatus = "pending" | "verified" | "failed" | "unverified";

export interface AgentMailDomainRecord {
  type: "CNAME" | "MX" | "TXT" | string;
  host: string;
  value: string;
  required: boolean;
  purpose: "dkim" | "receive" | "mail_from" | "dmarc" | string;
}

export interface AgentMailDomain {
  id: string;
  domain: string;
  status: AgentMailDomainStatus;
  dkimStatus: string | null;
  verifiedForSending: boolean;
  mx: { expected: string; found: string[]; ok: boolean; checkedAt: string | null };
  dmarcFound: boolean;
  mailFrom: { domain: string | null; status: string | null };
  records: AgentMailDomainRecord[];
  warnings: string[];
  createdAt: string;
  verifiedAt: string | null;
  nextCheckAt: string | null;
  dkimDeadline: string | null;
  /** Ask again after this long (null = nothing pending). */
  pollAfterMs: number | null;
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
  /** PLAN-2: contacts were saved/removed in this batch (contacts view re-reads). */
  contactsChanged?: boolean;
  /** PLAN-2: a custom domain or the mail identity changed (settings re-read). */
  identityChanged?: boolean;
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
  /** New mailbox: localPart is required (native addresses are permanent). A deleted one comes back without it. */
  issue: (input?: { displayName?: string; localPart?: string }) => Promise<AgentMailResult<{ mailbox: AgentMailMailbox; created: boolean; revived: boolean; entitlement: AgentMailEntitlement | null }>>;
  updateMailbox: (patch: AgentMailMailboxPatch) => Promise<AgentMailResult<{ mailbox: AgentMailMailbox; entitlement: AgentMailEntitlement | null }>>;
  checkAddress: (localPart: string) => Promise<AgentMailResult<AgentMailAddressCheck>>;
  suggestAddresses: (name: string) => Promise<AgentMailResult<{ base: string | null; suggestions: AgentMailAddressSuggestion[] }>>;
  contacts: (input?: AgentMailContactsInput) => Promise<AgentMailResult<{ contacts: AgentMailContact[]; nextCursor: string | null }>>;
  contact: (id: string) => Promise<AgentMailResult<{ contact: AgentMailContact }>>;
  /** Owner saves by address (create / update / bring back) or patches by id. */
  saveContact: (input: AgentMailContactSaveInput) => Promise<AgentMailResult<{ contact: AgentMailContact; created: boolean }>>;
  removeContact: (id: string) => Promise<AgentMailResult<{ deleted: true }>>;
  directoryMe: () => Promise<AgentMailResult<AgentMailDirectoryEntry>>;
  saveDirectoryMe: (input: { listed?: boolean; card?: AgentMailAgentCardInput }) => Promise<AgentMailResult<AgentMailDirectoryEntry>>;
  directorySearch: (input: { q?: string; skill?: string; lang?: string; cursor?: string | null }) => Promise<AgentMailResult<{ results: AgentMailAgentCard[]; nextCursor: string | null }>>;
  directoryLookup: (address: string) => Promise<AgentMailResult<{ agentlas: AgentMailDirectoryLookup | null }>>;
  domains: () => Promise<AgentMailResult<{ domains: AgentMailDomain[] }>>;
  addDomain: (domain: string) => Promise<AgentMailResult<{ domain: AgentMailDomain; created: boolean }>>;
  domain: (input: { id: string; check?: boolean }) => Promise<AgentMailResult<{ domain: AgentMailDomain }>>;
  restartDomain: (id: string) => Promise<AgentMailResult<{ domain: AgentMailDomain }>>;
  setDomainAddress: (input: { id: string; localPart: string; displayName?: string }) => Promise<AgentMailResult<{ mailbox: AgentMailMailbox; created: boolean; entitlement: AgentMailEntitlement | null }>>;
  removeDomain: (id: string) => Promise<AgentMailResult<{ deleted: true }>>;
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
  suggestAddresses: "agentMail:suggestAddresses",
  contacts: "agentMail:contacts",
  contact: "agentMail:contact",
  saveContact: "agentMail:saveContact",
  removeContact: "agentMail:removeContact",
  directoryMe: "agentMail:directoryMe",
  saveDirectoryMe: "agentMail:saveDirectoryMe",
  directorySearch: "agentMail:directorySearch",
  directoryLookup: "agentMail:directoryLookup",
  domains: "agentMail:domains",
  addDomain: "agentMail:addDomain",
  domain: "agentMail:domain",
  restartDomain: "agentMail:restartDomain",
  setDomainAddress: "agentMail:setDomainAddress",
  removeDomain: "agentMail:removeDomain",
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
