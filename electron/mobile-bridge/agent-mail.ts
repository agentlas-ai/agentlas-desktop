// One mailbox mirror for the Mobile Bridge (PLAN 2026-09-26 §5.3).
//
// The phone never talks to the web mail API (owner decision §10). Desktop Main
// already holds the owner's web session in electron/agent-mail/client.ts; this
// file is the thin, bounded projection between that client and the bridge.
//
// The client is looked up loosely on purpose: the mail client grows in a
// parallel change, and a function that is not there yet must make exactly that
// bridge method answer `mail_unavailable` — never crash the authority and never
// guess a result. Every server refusal is returned as data
// ({ ok:false, code, message }) so the phone can show the server's own reason.
import { Buffer } from "node:buffer";
import * as agentMailClientModule from "../agent-mail/client";
import * as agentMailSyncModule from "../agent-mail/sync";
import {
  MOBILE_BRIDGE_MAIL_LIMITS,
  type MobileBridgeMailAttachmentMetaDto,
  type MobileBridgeMailDelegateDto,
  type MobileBridgeMailDraftDto,
  type MobileBridgeMailInboundMode,
  type MobileBridgeMailMessageDto,
  type MobileBridgeMailOrigin,
  type MobileBridgeMailRefusalDto,
  type MobileBridgeMailStatusDto,
  type MobileBridgeMailThreadDto,
  type MobileBridgeMailThreadSummaryDto,
  type MobileBridgeMailThreadsDto,
  type MobileBridgeMailUpdatedEventDto,
  type MobileBridgeMailView,
} from "../../shared/mobile-bridge";
import { sanitizeMobileBridgeText } from "./sanitize";

type Loose = Record<string, unknown>;
type ClientResult = Loose & { ok?: unknown; code?: unknown; message?: unknown };
type ClientFn = (...args: unknown[]) => Promise<ClientResult>;

/**
 * Main-process mail surface this projection needs — the functions named in
 * API.md "## Desktop IPC" (electron/agent-mail/client.ts + sync.ts). The
 * bridge is the owner's own phone, so every write runs with the default
 * owner authority/actor (Main decides origin; the phone never claims one).
 */
export interface MobileBridgeAgentMailClient {
  agentMailStatus?: ClientFn;
  agentMailUnread?: ClientFn;
  agentMailThreads?: ClientFn;
  agentMailThread?: ClientFn;
  agentMailMarkThreadRead?: ClientFn;
  agentMailArchiveThread?: ClientFn;
  agentMailRemoveThread?: ClientFn;
  agentMailSend?: ClientFn;
  agentMailDrafts?: ClientFn;
  agentMailSaveDraft?: ClientFn;
  agentMailRemoveDraft?: ClientFn;
  agentMailUpdateMailbox?: ClientFn;
  agentMailDelegate?: ClientFn;
  onAgentMailChanged?: (listener: (event: unknown) => void) => () => void;
  onAgentMailMailboxKnown?: (listener: (mailbox: unknown) => void) => () => void;
  agentMailSyncSnapshot?: () => { unread?: { inbox?: number } | null; changeSeq?: number | null } | null;
  /** Ask Main's sync loop to poll now, so Desktop and phone see a phone write at once. */
  agentMailSyncNow?: () => void;
}

export interface MobileBridgeAgentMailService {
  status(): Promise<MobileBridgeMailStatusDto | MobileBridgeMailRefusalDto>;
  threads(input: { view: MobileBridgeMailView; q?: string; cursor?: string; limit?: number }): Promise<MobileBridgeMailThreadsDto | MobileBridgeMailRefusalDto>;
  thread(threadId: string): Promise<MobileBridgeMailThreadDto | MobileBridgeMailRefusalDto>;
  markRead(input: { threadId: string; read: boolean }): Promise<Loose>;
  archive(input: { threadId: string; archived: boolean }): Promise<Loose>;
  removeThread(threadId: string): Promise<Loose>;
  send(input: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text: string;
    replyToMessageId?: string;
    draftId?: string;
    basedOnMessageId?: string;
    idempotencyKey: string;
  }): Promise<Loose>;
  saveDraft(input: {
    draftId?: string;
    expectedVersion?: number;
    threadId?: string;
    replyToMessageId?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
  }): Promise<Loose>;
  removeDraft(draftId: string): Promise<Loose>;
  updateSettings(input: {
    displayName?: string;
    signature?: string;
    inboundMode?: MobileBridgeMailInboundMode;
    localPart?: string;
  }): Promise<MobileBridgeMailStatusDto | MobileBridgeMailRefusalDto>;
  delegate(input: { threadId: string; instruction?: string; locale?: "ko" | "en" }): Promise<MobileBridgeMailDelegateDto | MobileBridgeMailRefusalDto>;
  /** Live change notices, content-free. Returns an unsubscribe. */
  subscribe(listener: (event: MobileBridgeMailUpdatedEventDto) => void): () => void;
}

function isRecord(value: unknown): value is Loose {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refusal(code: string, message: string): MobileBridgeMailRefusalDto {
  return { ok: false, code: text(code, 120) || "mail_error", message: text(message, 1_000) };
}

function unavailable(what: string): MobileBridgeMailRefusalDto {
  return refusal("mail_unavailable", `This Desktop cannot ${what} yet. Update Agentlas Desktop.`);
}

function text(value: unknown, maxBytes: number): string {
  return typeof value === "string" ? sanitizeMobileBridgeText(value, maxBytes) : "";
}

function nullableText(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" && value.length > 0 ? sanitizeMobileBridgeText(value, maxBytes) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function addressList(value: unknown, max: number = MOBILE_BRIDGE_MAIL_LIMITS.recipients): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, max).map((item) => text(item, 400));
}

function origin(value: unknown, direction?: unknown): MobileBridgeMailOrigin | null {
  if (value === "one" || value === "owner" || value === "automation") return value;
  return direction === "inbound" ? "external" : null;
}

function failureOf(result: ClientResult | undefined): MobileBridgeMailRefusalDto | null {
  if (!isRecord(result)) return refusal("mail_error", "Desktop mail answered without a result.");
  if (result.ok === true) return null;
  return refusal(typeof result.code === "string" ? result.code : "mail_error", typeof result.message === "string" ? result.message : "Mail request failed.");
}

function sendIssue(value: unknown): "bounced" | "unknown" | null {
  if (value === "bounced" || value === "complained" || value === "rejected") return "bounced";
  if (value === "uncertain" || value === "unknown") return "unknown";
  return null;
}

export function projectMobileBridgeMailThreadSummary(value: unknown): MobileBridgeMailThreadSummaryDto | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > MOBILE_BRIDGE_MAIL_LIMITS.id) return null;
  return {
    id: value.id,
    subject: text(value.subject, 2_000),
    participants: addressList(value.participants, 20),
    snippet: text(value.snippet ?? value.preview, 600),
    lastMessageAt: nullableText(value.lastMessageAt, 64),
    messageCount: count(value.messageCount),
    unreadCount: count(value.unreadCount),
    hasAttachments: value.hasAttachments === true,
    archived: value.archived === true,
    lastOrigin: origin(value.lastOrigin, value.lastDirection),
    status: nullableText(value.status, 32),
    sendIssue: sendIssue(value.sendProblem ?? value.sendIssue ?? value.lastSendStatus),
  };
}

function projectAttachments(value: unknown): MobileBridgeMailAttachmentMetaDto[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item, position) => {
    if (!isRecord(item)) return [];
    return [{
      index: typeof item.index === "number" && Number.isInteger(item.index) && item.index >= 0 ? item.index : position,
      filename: nullableText(item.filename, 400),
      contentType: nullableText(item.contentType, 200),
      size: count(item.size),
    }];
  });
}

export function projectMobileBridgeMailMessage(value: unknown): MobileBridgeMailMessageDto | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > MOBILE_BRIDGE_MAIL_LIMITS.id) return null;
  const direction = value.direction === "outbound" ? "outbound" : "inbound";
  const rawText = typeof value.text === "string" ? value.text : typeof value.preview === "string" ? value.preview : "";
  // Byte budget per message: long bodies are cut and marked, never silently.
  const bodyBudget = 256 * 1024;
  const body = sanitizeMobileBridgeText(rawText, bodyBudget);
  const originRef = isRecord(value.originRef) ? value.originRef : null;
  return {
    id: value.id,
    threadId: nullableText(value.threadId, MOBILE_BRIDGE_MAIL_LIMITS.id),
    direction,
    from: text(value.from, 400),
    to: addressList(value.to),
    cc: addressList(value.cc),
    subject: text(value.subject, 2_000),
    text: body,
    textTruncated: Buffer.byteLength(rawText, "utf8") > bodyBudget,
    receivedAt: nullableText(value.receivedAt, 64),
    readAt: nullableText(value.readAt, 64),
    origin: origin(value.origin, direction),
    originChatId: originRef && typeof originRef.chatId === "string" ? text(originRef.chatId, 200) : null,
    sendStatus: nullableText(value.sendStatus, 32),
    attachments: projectAttachments(value.attachments),
  };
}

export function projectMobileBridgeMailDraft(value: unknown): MobileBridgeMailDraftDto | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || value.id.length > MOBILE_BRIDGE_MAIL_LIMITS.id) return null;
  return {
    id: value.id,
    version: nullableCount(value.version),
    threadId: nullableText(value.threadId, MOBILE_BRIDGE_MAIL_LIMITS.id),
    replyToMessageId: nullableText(value.replyToMessageId, MOBILE_BRIDGE_MAIL_LIMITS.id),
    to: addressList(value.to),
    cc: addressList(value.cc),
    bcc: addressList(value.bcc),
    subject: text(value.subject, 2_000),
    text: sanitizeMobileBridgeText(typeof value.text === "string" ? value.text : "", 256 * 1024),
    updatedAt: nullableText(value.updatedAt, 64),
  };
}

function draftAsThreadSummary(draft: MobileBridgeMailDraftDto): MobileBridgeMailThreadSummaryDto {
  return {
    id: draft.threadId ?? `draft:${draft.id}`,
    subject: draft.subject,
    participants: draft.to,
    snippet: draft.text.slice(0, 200),
    lastMessageAt: draft.updatedAt,
    messageCount: 0,
    unreadCount: 0,
    hasAttachments: false,
    archived: false,
    lastOrigin: "owner",
    status: "draft",
    sendIssue: null,
  };
}

export function projectMobileBridgeMailStatus(value: unknown, unreadOverride?: number | null): MobileBridgeMailStatusDto | MobileBridgeMailRefusalDto {
  const failure = failureOf(value as ClientResult);
  if (failure) return failure;
  const result = value as Loose;
  const entitlement = isRecord(result.entitlement) ? result.entitlement : null;
  const mailbox = isRecord(result.mailbox) ? result.mailbox : null;
  const unread = isRecord(result.unread) ? result.unread : null;
  const mailboxStatus = mailbox?.status === "provisioning" || mailbox?.status === "active" || mailbox?.status === "deleted"
    ? mailbox.status
    : "none";
  const inbound = mailbox?.inboundMode;
  const addressChosen = mailbox?.addressChosen === true || (typeof mailbox?.addressChosenAt === "string" && mailbox.addressChosenAt.length > 0);
  const period = isRecord(entitlement?.period) ? entitlement.period : null;
  return {
    schemaVersion: 1,
    ok: true,
    signedIn: result.signedIn === true,
    available: entitlement?.available === true,
    canSend: isRecord(entitlement?.mailbox) && entitlement.mailbox.send === true,
    address: nullableText(mailbox?.address, 400),
    aliases: addressList(mailbox?.aliases, 20),
    mailboxStatus,
    addressChosen,
    canChooseAddress: !addressChosen && mailbox?.canChooseAddress === true,
    displayName: nullableText(mailbox?.displayName, 400),
    signature: nullableText(mailbox?.signature, 8_000),
    inboundMode: inbound === "notify" || inbound === "draft" || inbound === "reply" ? inbound : null,
    usage: entitlement
      ? {
        used: count(entitlement.usedThisMonth),
        limit: count(entitlement.monthlyRecipientLimit),
        remaining: count(entitlement.remainingThisMonth),
        periodEnd: nullableText(period?.end, 64),
      }
      : null,
    unreadInbox: unreadOverride !== undefined ? unreadOverride : nullableCount(unread?.inbox ?? result.unreadInbox),
    changeSeq: nullableCount(result.changeSeq),
  };
}

export function projectMobileBridgeMailChangedEvent(value: unknown): MobileBridgeMailUpdatedEventDto | null {
  if (!isRecord(value)) return null;
  const reason = value.reason === "resync" || value.reason === "mailbox" || value.reason === "status" || value.reason === "signed-out"
    ? value.reason
    : "changes";
  const ids = (key: string) => Array.isArray(value[key])
    ? (value[key] as unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= MOBILE_BRIDGE_MAIL_LIMITS.id).slice(0, 200)
    : [];
  const unread = isRecord(value.unread) ? value.unread : null;
  return {
    schemaVersion: 1,
    changeSeq: nullableCount(value.changeSeq),
    reason,
    threadIds: ids("threadIds"),
    deletedThreadIds: ids("deletedThreadIds"),
    unreadInbox: nullableCount(unread?.inbox ?? value.unreadInbox),
  };
}

function mailboxFingerprint(mailbox: unknown): string {
  if (!isRecord(mailbox)) return "none";
  return JSON.stringify([
    mailbox.address, mailbox.status, mailbox.displayName, mailbox.signature, mailbox.inboundMode,
    mailbox.aliases, mailbox.addressChosen, mailbox.canChooseAddress,
  ]);
}

export function createMobileBridgeAgentMailService(
  client: MobileBridgeAgentMailClient = {
    ...(agentMailClientModule as unknown as MobileBridgeAgentMailClient),
    ...(agentMailSyncModule as unknown as MobileBridgeAgentMailClient),
  },
): MobileBridgeAgentMailService {
  const fn = (name: keyof MobileBridgeAgentMailClient): ClientFn | null => {
    const value = client[name];
    return typeof value === "function" ? (value as ClientFn) : null;
  };
  const syncNow = () => {
    try {
      client.agentMailSyncNow?.();
    } catch {
      // The write already succeeded; a missed nudge only delays the next poll.
    }
  };

  const readStatus = async (): Promise<MobileBridgeMailStatusDto | MobileBridgeMailRefusalDto> => {
    const status = fn("agentMailStatus");
    if (!status) return unavailable("read mail status");
    const result = await status();
    if (!isRecord(result) || result.ok !== true) return projectMobileBridgeMailStatus(result);
    // The mailbox read carries no counters; Main's sync loop holds the last
    // server unread count and change cursor. Ask the server when it has none.
    const snapshot = typeof client.agentMailSyncSnapshot === "function" ? client.agentMailSyncSnapshot() : null;
    let unread = nullableCount(snapshot?.unread?.inbox);
    const unreadFn = fn("agentMailUnread");
    if (unread === null && unreadFn && isRecord(result.mailbox) && result.mailbox.status === "active") {
      const fresh = await unreadFn().catch(() => null);
      if (fresh && fresh.ok === true && isRecord(fresh.unread)) unread = nullableCount(fresh.unread.inbox);
    }
    return projectMobileBridgeMailStatus({
      ...result,
      unreadInbox: unread,
      changeSeq: result.changeSeq ?? snapshot?.changeSeq ?? null,
    });
  };

  const writeResult = (result: ClientResult, extra: (result: Loose) => Loose = () => ({})): Loose => {
    const failure = failureOf(result);
    if (failure) return { ...failure };
    syncNow();
    const thread = projectMobileBridgeMailThreadSummary(result.thread);
    const unread = isRecord(result.unread) ? nullableCount(result.unread.inbox) : null;
    return { schemaVersion: 1, ok: true, ...(thread ? { thread } : {}), unreadInbox: unread, ...extra(result) };
  };

  return {
    status: readStatus,

    async threads(input) {
      if (input.view === "drafts") {
        const drafts = fn("agentMailDrafts");
        if (!drafts) return unavailable("list drafts");
        const result = await drafts({ cursor: input.cursor ?? null });
        const failure = failureOf(result);
        if (failure) return failure;
        const items = Array.isArray(result.drafts) ? result.drafts : [];
        return {
          schemaVersion: 1,
          ok: true,
          view: "drafts",
          threads: items.flatMap((item) => {
            const draft = projectMobileBridgeMailDraft(item);
            return draft ? [draftAsThreadSummary(draft)] : [];
          }),
          nextCursor: nullableText(result.nextCursor, 512),
        };
      }
      const threads = fn("agentMailThreads");
      if (!threads) return unavailable("list mail");
      const result = await threads({
        view: input.view,
        ...(input.q ? { q: input.q } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit ?? 25,
      });
      const failure = failureOf(result);
      if (failure) return failure;
      const items = Array.isArray(result.threads) ? result.threads : [];
      return {
        schemaVersion: 1,
        ok: true,
        view: input.view,
        threads: items.slice(0, MOBILE_BRIDGE_MAIL_LIMITS.page).flatMap((item) => {
          const summary = projectMobileBridgeMailThreadSummary(item);
          return summary ? [summary] : [];
        }),
        nextCursor: nullableText(result.nextCursor, 512),
      };
    },

    async thread(threadId) {
      const read = fn("agentMailThread");
      if (!read) return unavailable("open a mail conversation");
      const result = await read(threadId);
      const failure = failureOf(result);
      if (failure) return failure;
      const summary = projectMobileBridgeMailThreadSummary(result.thread);
      if (!summary) return refusal("mail_error", "Desktop returned a conversation without an id.");
      const messages = Array.isArray(result.messages) ? result.messages : [];
      const drafts = Array.isArray(result.drafts) ? result.drafts : [];
      return {
        schemaVersion: 1,
        ok: true,
        thread: summary,
        // Newest messages matter most when a long conversation must be cut.
        messages: messages.slice(-100).flatMap((item) => {
          const message = projectMobileBridgeMailMessage(item);
          return message ? [message] : [];
        }),
        drafts: drafts.slice(0, 10).flatMap((item) => {
          const draft = projectMobileBridgeMailDraft(item);
          return draft ? [draft] : [];
        }),
      };
    },

    async markRead(input) {
      const call = fn("agentMailMarkThreadRead");
      if (!call) return { ...unavailable("change read state") };
      return writeResult(await call(input.threadId, input.read));
    },

    async archive(input) {
      const call = fn("agentMailArchiveThread");
      if (!call) return { ...unavailable("archive mail") };
      return writeResult(await call(input.threadId, input.archived));
    },

    async removeThread(threadId) {
      const call = fn("agentMailRemoveThread");
      if (!call) return { ...unavailable("delete mail") };
      return writeResult(await call(threadId), () => ({ deleted: true, threadId }));
    },

    async send(input) {
      const call = fn("agentMailSend");
      if (!call) return { ...unavailable("send mail") };
      const result = await call({
        to: input.to,
        cc: input.cc ?? [],
        bcc: input.bcc ?? [],
        subject: input.subject,
        text: input.text,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        ...(input.basedOnMessageId ? { basedOnMessageId: input.basedOnMessageId } : {}),
        // The bridge's durable idempotency key becomes the web idempotency key,
        // so a lost response can never turn into a second email at either layer.
        idempotencyKey: input.idempotencyKey,
      });
      const failure = failureOf(result);
      if (failure) return { ...failure };
      syncNow();
      // The draft this compose came from is done once the send is accepted.
      const removeDraft = fn("agentMailRemoveDraft");
      if (input.draftId && removeDraft && result.replay !== true) {
        await removeDraft(input.draftId).catch(() => undefined);
      }
      const send = isRecord(result.send) ? result.send : {};
      return {
        schemaVersion: 1,
        ok: true,
        sendId: nullableText(send.id, 128),
        status: nullableText(send.status, 32) ?? "unknown",
        recipientCount: count(send.recipientCount),
        replay: result.replay === true,
        remainingThisMonth: nullableCount(result.remainingThisMonth),
      };
    },

    async saveDraft(input) {
      const call = fn("agentMailSaveDraft");
      if (!call) return { ...unavailable("save drafts") };
      const fields: Loose = {};
      for (const key of ["to", "cc", "bcc", "subject", "text", "threadId", "replyToMessageId"] as const) {
        if (input[key] !== undefined) fields[key] = input[key];
      }
      const result = await call({
        id: input.draftId ?? null,
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        fields,
      });
      const failure = failureOf(result);
      if (failure) return { ...failure };
      const draft = projectMobileBridgeMailDraft(result.draft);
      return { schemaVersion: 1, ok: true, draft };
    },

    async removeDraft(draftId) {
      const call = fn("agentMailRemoveDraft");
      if (!call) return { ...unavailable("delete drafts") };
      return writeResult(await call(draftId), () => ({ deleted: true, draftId }));
    },

    async updateSettings(input) {
      const call = fn("agentMailUpdateMailbox");
      if (!call) return unavailable("change mail settings");
      const result = await call(input);
      const failure = failureOf(result);
      if (failure) return failure;
      syncNow();
      // Re-read the whole status so the phone shows the server's value, not the request.
      return readStatus();
    },

    async delegate(input) {
      const call = fn("agentMailDelegate");
      if (!call) return unavailable("hand mail to One");
      const result = await call(input);
      const failure = failureOf(result);
      if (failure) return failure;
      if (typeof result.chatId !== "string" || result.chatId.length === 0) {
        return refusal("mail_error", "Desktop did not return the One conversation.");
      }
      return {
        schemaVersion: 1,
        ok: true,
        chatId: text(result.chatId, 200),
        runId: nullableText(result.runId, 200),
      };
    },

    subscribe(listener) {
      const disposers: Array<() => void> = [];
      const on = client.onAgentMailChanged;
      if (typeof on === "function") {
        disposers.push(on((event) => {
          const projected = projectMobileBridgeMailChangedEvent(event);
          if (projected) listener(projected);
        }));
      }
      // Settings changes (sender name followed One's rename on Desktop, a
      // picked address, inbound mode) do not go through the change feed.
      // Tell the phone only when the mailbox really changed — every status
      // read re-announces the same mailbox, and echoing those would loop.
      const known = client.onAgentMailMailboxKnown;
      if (typeof known === "function") {
        let last: string | null = null;
        disposers.push(known((mailbox) => {
          const next = mailboxFingerprint(mailbox);
          const previous = last;
          last = next;
          if (previous === null || previous === next) return;
          listener({ schemaVersion: 1, changeSeq: null, reason: "mailbox", threadIds: [], deletedThreadIds: [], unreadInbox: null });
        }));
      }
      return () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose(); } catch { /* best effort */ }
        }
      };
    },
  };
}
