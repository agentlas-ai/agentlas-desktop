"use client";

// One mailbox state for the rail list and the centre thread view. Every number
// (unread, allowance) and every membership decision (which thread a message is
// in, what is unread) comes from the server through Main. This hook only keeps
// what the screen is showing and re-reads it when Main says something changed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import {
  agentMailBareAddress,
  type AgentMailDraft,
  type AgentMailEntitlement,
  type AgentMailError,
  type AgentMailLimits,
  type AgentMailMailbox,
  type AgentMailMessage,
  type AgentMailMessageSummary,
  type AgentMailThreadDetail,
  type AgentMailThreadSummary,
  type AgentMailThreadView,
  type AgentMailUnread,
} from "@shared/agent-mail";

export type OneMailView = Exclude<AgentMailThreadView, "all"> | "drafts";
export const ONE_MAIL_VIEWS: readonly OneMailView[] = ["inbox", "waiting", "sent", "drafts", "archived"];

export interface OneMailComposeSeed {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  replyToMessageId: string | null;
  basedOnMessageId: string | null;
  threadId: string | null;
  draftId: string | null;
  draftVersion: number | null;
}

export type OneMailSelection = { kind: "thread"; id: string } | null;

export interface OneMailCompose {
  seed: OneMailComposeSeed;
  /** One compose session = one idempotency key (two clicks on Send = one email). */
  key: string;
}

export interface OneMailState {
  available: boolean;
  loaded: boolean;
  signedIn: boolean;
  mailbox: AgentMailMailbox | null;
  entitlement: AgentMailEntitlement | null;
  limits: AgentMailLimits | null;
  unread: AgentMailUnread | null;
  /** The server has no thread routes yet: flat message list, no read/archive/drafts. */
  legacy: boolean;
  view: OneMailView;
  setView: (view: OneMailView) => void;
  query: string;
  setQuery: (query: string) => void;
  threads: AgentMailThreadSummary[];
  drafts: AgentMailDraft[];
  listLoading: boolean;
  /** Machine refusal; screens turn it into their own words (mailErrorText). */
  listError: { code: string } | null;
  hasMore: boolean;
  /** Pager: 1-based index of the first row on this page and the page size the server used. */
  pageStart: number;
  hasPrev: boolean;
  nextPage: () => void;
  prevPage: () => void;
  /** Rows ticked in the list (bulk archive / delete / read). */
  checked: ReadonlySet<string>;
  toggleChecked: (id: string) => void;
  setAllChecked: (on: boolean) => void;
  bulk: (action: "archive" | "delete" | "read" | "unread") => Promise<AgentMailError | null>;
  draftCount: number | null;
  selection: OneMailSelection;
  select: (selection: OneMailSelection) => void;
  detail: AgentMailThreadDetail | null;
  detailLoading: boolean;
  detailError: { code: string } | null;
  refreshStatus: () => Promise<void>;
  refreshList: () => void;
  reloadDetail: () => void;
  markRead: (threadId: string, read: boolean) => Promise<AgentMailError | null>;
  archive: (threadId: string, archived: boolean) => Promise<AgentMailError | null>;
  removeThread: (threadId: string) => Promise<AgentMailError | null>;
  removeDraft: (draftId: string) => Promise<AgentMailError | null>;
  compose: OneMailCompose | null;
  openCompose: (seed?: Partial<OneMailComposeSeed>) => void;
  closeCompose: () => void;
  replySeed: (message: AgentMailMessage, mode: "reply" | "replyAll" | "forward", locale: "ko" | "en") => OneMailComposeSeed;
}

export function emptyComposeSeed(): OneMailComposeSeed {
  return { to: "", cc: "", bcc: "", subject: "", text: "", replyToMessageId: null, basedOnMessageId: null, threadId: null, draftId: null, draftVersion: null };
}

function composeKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const COMPOSE_KEY_STORE = "agentlas.oneMail.composeKeys.v1";

function readComposeKeys(): Record<string, string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COMPOSE_KEY_STORE) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/**
 * The send key of a compose sheet lives with its draft id, so sending the same
 * draft again after a restart (e.g. after "result unknown") replays on the
 * server instead of sending a second email (EDGE-CASES D3).
 */
export function rememberComposeKey(draftId: string, key: string): void {
  try {
    const keys = readComposeKeys();
    if (keys[draftId] === key) return;
    keys[draftId] = key;
    const trimmed = Object.fromEntries(Object.entries(keys).slice(-200));
    window.localStorage.setItem(COMPOSE_KEY_STORE, JSON.stringify(trimmed));
  } catch { /* storage unavailable: the in-memory key still covers this session */ }
}

export function forgetComposeKey(draftId: string | null): void {
  if (!draftId) return;
  try {
    const keys = readComposeKeys();
    if (!(draftId in keys)) return;
    delete keys[draftId];
    window.localStorage.setItem(COMPOSE_KEY_STORE, JSON.stringify(keys));
  } catch { /* best effort */ }
}

function composeKeyFor(draftId: string | null | undefined): string {
  if (draftId) {
    const saved = readComposeKeys()[draftId];
    if (saved) return saved;
  }
  return composeKey();
}

/** A flat legacy message shown as a one-message thread. */
function legacyThread(message: AgentMailMessageSummary): AgentMailThreadSummary {
  return {
    id: message.id,
    subject: message.subject,
    participants: message.direction === "inbound" ? [message.from] : message.to,
    lastMessageAt: message.receivedAt,
    lastMessageId: message.id,
    lastDirection: message.direction,
    lastFrom: message.from,
    lastOrigin: message.origin ?? null,
    messageCount: 1,
    unreadCount: 0,
    snippet: message.preview,
    hasAttachments: message.attachments.length > 0,
    archived: false,
  };
}

function isMissingRoute(error: AgentMailError): boolean {
  return error.code === "http_404" || error.code === "http_405";
}

export function useOneMail(): OneMailState {
  const api = ipc()?.agentMail;
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [mailbox, setMailbox] = useState<AgentMailMailbox | null>(null);
  const [entitlement, setEntitlement] = useState<AgentMailEntitlement | null>(null);
  const [limits, setLimits] = useState<AgentMailLimits | null>(null);
  const [unread, setUnread] = useState<AgentMailUnread | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [view, setViewState] = useState<OneMailView>("inbox");
  const [query, setQueryState] = useState("");
  const [threads, setThreads] = useState<AgentMailThreadSummary[]>([]);
  const [drafts, setDrafts] = useState<AgentMailDraft[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [pageStart, setPageStart] = useState(1);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [draftCount, setDraftCount] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<{ code: string } | null>(null);
  const [selection, setSelection] = useState<OneMailSelection>(null);
  const [compose, setCompose] = useState<OneMailCompose | null>(null);
  const selectionRef = useRef<OneMailSelection>(null);
  selectionRef.current = selection;
  const [detail, setDetail] = useState<AgentMailThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<{ code: string } | null>(null);
  const listToken = useRef(0);
  const detailToken = useRef(0);
  const [listNonce, setListNonce] = useState(0);
  const [detailNonce, setDetailNonce] = useState(0);

  const available = Boolean(entitlement?.available && mailbox?.status === "active");

  const refreshStatus = useCallback(async () => {
    if (!api) { setLoaded(true); return; }
    const status = await api.status().catch(() => null);
    setLoaded(true);
    if (!status || !status.ok) return;
    setSignedIn(status.signedIn);
    setMailbox(status.mailbox);
    setEntitlement(status.entitlement);
    setLimits(status.limits ?? null);
  }, [api]);

  const refreshUnread = useCallback(async () => {
    if (!api?.unread) return;
    const res = await api.unread().catch(() => null);
    if (res && res.ok) setUnread(res.unread);
  }, [api]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => { if (available) void refreshUnread(); }, [available, refreshUnread]);

  // Main's change feed: counts only, then re-read what is on screen.
  useEffect(() => {
    const events = ipcEvents();
    if (!events?.onAgentMailChanged) return;
    return events.onAgentMailChanged((event) => {
      if (event.reason === "signed-out") {
        // Another account may sign in next: nothing of this mailbox stays on screen.
        setUnread(null);
        setThreads([]);
        setDrafts([]);
        setDraftCount(null);
        setSelection(null);
        setDetail(null);
        setCompose(null);
        setChecked(new Set());
        void refreshStatus();
        return;
      }
      if (event.unread) setUnread(event.unread);
      if (event.reason === "mailbox") void refreshStatus();
      setListNonce((n) => n + 1);
      const current = selectionRef.current;
      if (current?.kind === "thread" && (event.threadIds.includes(current.id) || event.deletedThreadIds.includes(current.id))) {
        setDetailNonce((n) => n + 1);
      }
    });
  }, [refreshStatus]);

  // List (threads or drafts) for the current view/search.
  useEffect(() => {
    if (!api || !available) return;
    const token = ++listToken.current;
    setListLoading(true);
    setListError(null);
    void (async () => {
      if (view === "drafts") {
        const res = await api.drafts({ cursor: pageCursor }).catch(() => null);
        if (token !== listToken.current) return;
        setListLoading(false);
        if (!res) return;
        if (!res.ok) {
          if (isMissingRoute(res)) setLegacy(true);
          else setListError(res);
          setDrafts([]);
          return;
        }
        setDrafts(res.drafts);
        if (!pageCursor) setDraftCount(res.nextCursor ? null : res.drafts.length);
        setNextCursor(res.nextCursor);
        return;
      }
      const res = await api.threads({ view, q: query.trim() || undefined, cursor: pageCursor }).catch(() => null);
      if (token !== listToken.current) return;
      if (res && res.ok) {
        setLegacy(false);
        setListLoading(false);
        setThreads(res.threads);
        setNextCursor(res.nextCursor);
        if (res.unread) setUnread(res.unread);
        return;
      }
      if (res && !isMissingRoute(res)) {
        setListLoading(false);
        setListError(res);
        return;
      }
      // Older server: one message per row, inbox/sent only.
      setLegacy(true);
      if (view !== "inbox" && view !== "sent") {
        setListLoading(false);
        setThreads([]);
        setNextCursor(null);
        return;
      }
      const flat = await api.list({ direction: view === "sent" ? "outbound" : "inbound", cursor: pageCursor, limit: 25 }).catch(() => null);
      if (token !== listToken.current) return;
      setListLoading(false);
      if (!flat || !flat.ok) { setListError(flat ?? { code: "network" }); return; }
      const needle = query.trim().toLocaleLowerCase();
      setThreads(flat.messages
        .filter((m) => !needle || `${m.subject} ${m.from} ${m.to.join(" ")} ${m.preview}`.toLocaleLowerCase().includes(needle))
        .map(legacyThread));
      setNextCursor(flat.nextCursor);
    })();
  }, [api, available, view, query, listNonce, pageCursor]);

  // Drafts count for the nav (first page only; unknown when there are more pages).
  useEffect(() => {
    if (!api || !available || legacy) return;
    let alive = true;
    void api.drafts({}).then((res) => {
      if (alive && res.ok) setDraftCount(res.nextCursor ? null : res.drafts.length);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, available, legacy, listNonce]);

  const pageLength = view === "drafts" ? drafts.length : threads.length;
  const nextPage = useCallback(() => {
    if (!nextCursor || listLoading) return;
    setCursorStack((stack) => [...stack, pageCursor]);
    setPageStart((start) => start + pageLength);
    setPageCursor(nextCursor);
    setChecked(new Set());
  }, [nextCursor, listLoading, pageCursor, pageLength]);
  const prevPage = useCallback(() => {
    if (!cursorStack.length || listLoading) return;
    const previous = cursorStack[cursorStack.length - 1];
    setCursorStack((stack) => stack.slice(0, -1));
    setPageStart((start) => Math.max(1, start - (limits?.pageSizeDefault ?? pageLength)));
    setPageCursor(previous);
    setChecked(new Set());
  }, [cursorStack, listLoading, limits?.pageSizeDefault, pageLength]);

  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const setAllChecked = useCallback((on: boolean) => {
    setChecked(on ? new Set((view === "drafts" ? drafts : threads).map((item) => item.id)) : new Set());
  }, [view, drafts, threads]);

  // Thread detail for the centre view. Opening marks it read (server-side).
  const selectedThreadId = selection?.kind === "thread" ? selection.id : null;
  useEffect(() => {
    if (!api || !selectedThreadId) { setDetail(null); setDetailError(null); return; }
    const token = ++detailToken.current;
    setDetailLoading(true);
    setDetailError(null);
    void (async () => {
      const res = await api.thread(selectedThreadId).catch(() => null);
      if (token !== detailToken.current) return;
      if (res && res.ok) {
        setDetailLoading(false);
        setDetail({ thread: res.thread, messages: res.messages, drafts: res.drafts });
        if (res.thread.unreadCount > 0) {
          const marked = await api.markRead({ threadId: res.thread.id, read: true }).catch(() => null);
          if (marked && marked.ok) {
            if (marked.unread) setUnread(marked.unread);
            setThreads((prev) => prev.map((t) => (t.id === marked.thread.id ? marked.thread : t)));
          }
        }
        return;
      }
      if (res && !isMissingRoute(res)) {
        setDetailLoading(false);
        setDetailError(res);
        return;
      }
      // Legacy: the "thread" is one message.
      const one = await api.get(selectedThreadId).catch(() => null);
      if (token !== detailToken.current) return;
      setDetailLoading(false);
      if (!one || !one.ok) { setDetailError(one ?? { code: "network" }); return; }
      setLegacy(true);
      setDetail({ thread: legacyThread(one.message), messages: [one.message], drafts: [] });
    })();
  }, [api, selectedThreadId, detailNonce]);

  const applyThread = useCallback((thread: AgentMailThreadSummary, nextUnread: AgentMailUnread | null) => {
    if (nextUnread) setUnread(nextUnread);
    setThreads((prev) => prev.map((t) => (t.id === thread.id ? thread : t)));
    setDetail((prev) => (prev && prev.thread.id === thread.id ? { ...prev, thread } : prev));
  }, []);

  const markRead = useCallback(async (threadId: string, read: boolean) => {
    if (!api) return null;
    const res = await api.markRead({ threadId, read });
    if (!res.ok) return res;
    applyThread(res.thread, res.unread);
    return null;
  }, [api, applyThread]);

  const archive = useCallback(async (threadId: string, archived: boolean) => {
    if (!api) return null;
    const res = await api.archive({ threadId, archived });
    if (!res.ok) return res;
    applyThread(res.thread, res.unread);
    setThreads((prev) => prev.filter((t) => t.id !== threadId || (view === "archived") === archived));
    return null;
  }, [api, applyThread, view]);

  const removeThread = useCallback(async (threadId: string) => {
    if (!api) return null;
    const res = legacy ? await api.remove(threadId) : await api.removeThread(threadId);
    if (!res.ok) return res;
    setThreads((prev) => prev.filter((t) => t.id !== threadId));
    setSelection((current) => (current?.kind === "thread" && current.id === threadId ? null : current));
    void refreshUnread();
    return null;
  }, [api, legacy, refreshUnread]);

  const removeDraft = useCallback(async (draftId: string) => {
    if (!api) return null;
    const res = await api.removeDraft(draftId);
    if (!res.ok) return res;
    setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    return null;
  }, [api]);

  const bulk = useCallback(async (action: "archive" | "delete" | "read" | "unread") => {
    if (!api) return null;
    const ids = [...checked];
    let failure: AgentMailError | null = null;
    for (const id of ids) {
      const res = view === "drafts"
        ? (action === "delete" ? await api.removeDraft(id) : null)
        : action === "archive" ? await api.archive({ threadId: id, archived: view !== "archived" })
          : action === "delete" ? (legacy ? await api.remove(id) : await api.removeThread(id))
            : await api.markRead({ threadId: id, read: action === "read" });
      if (res && !res.ok) failure = res;
    }
    setChecked(new Set());
    setListNonce((n) => n + 1);
    void refreshUnread();
    return failure;
  }, [api, checked, view, legacy, refreshUnread]);

  const openCompose = useCallback((seed?: Partial<OneMailComposeSeed>) => {
    setCompose({ seed: { ...emptyComposeSeed(), ...(seed ?? {}) }, key: composeKeyFor(seed?.draftId) });
  }, []);

  const ownAddresses = useMemo(
    () => new Set([mailbox?.address, ...(mailbox?.aliases ?? [])].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase())),
    [mailbox],
  );

  const replySeed = useCallback((message: AgentMailMessage, mode: "reply" | "replyAll" | "forward", locale: "ko" | "en"): OneMailComposeSeed => {
    const notOwn = (value: string) => !ownAddresses.has(agentMailBareAddress(value));
    if (mode === "forward") {
      const header = locale === "ko" ? "---------- 전달된 메일 ----------" : "---------- Forwarded message ----------";
      const meta = [
        `${locale === "ko" ? "보낸 사람" : "From"}: ${message.from}`,
        `${locale === "ko" ? "날짜" : "Date"}: ${new Date(message.receivedAt).toLocaleString(locale === "ko" ? "ko-KR" : "en-US")}`,
        `${locale === "ko" ? "제목" : "Subject"}: ${message.subject}`,
        `${locale === "ko" ? "받는 사람" : "To"}: ${message.to.join(", ")}`,
      ].join("\n");
      return {
        ...emptyComposeSeed(),
        subject: /^fwd?:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`,
        text: `\n\n${header}\n${meta}\n\n${message.text || ""}`,
      };
    }
    const to = message.direction === "inbound" ? [message.from] : message.to;
    const cc = mode === "replyAll"
      ? [...(message.direction === "inbound" ? message.to : []), ...message.cc]
      : [];
    const seen = new Set<string>();
    const keep = (values: string[]) => values.filter((value) => {
      const key = agentMailBareAddress(value);
      if (!key || seen.has(key) || !notOwn(value)) return false;
      seen.add(key);
      return true;
    });
    return {
      ...emptyComposeSeed(),
      to: keep(to).join(", "),
      cc: keep(cc).join(", "),
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
      replyToMessageId: message.id,
      basedOnMessageId: detail?.thread.lastMessageId ?? message.id,
      threadId: message.threadId,
    };
  }, [ownAddresses, detail?.thread.lastMessageId]);

  const resetPages = useCallback(() => {
    setNextCursor(null);
    setPageCursor(null);
    setCursorStack([]);
    setPageStart(1);
    setChecked(new Set());
  }, []);
  const setView = useCallback((next: OneMailView) => {
    setThreads([]);
    setDrafts([]);
    resetPages();
    setSelection(null);
    setViewState(next);
  }, [resetPages]);
  const setQuery = useCallback((next: string) => {
    resetPages();
    setQueryState(next);
  }, [resetPages]);

  return {
    available,
    loaded,
    signedIn,
    mailbox,
    entitlement,
    limits,
    unread,
    legacy,
    view,
    setView,
    query,
    setQuery,
    threads,
    drafts,
    listLoading,
    listError,
    hasMore: Boolean(nextCursor),
    pageStart,
    hasPrev: cursorStack.length > 0,
    nextPage,
    prevPage,
    checked,
    toggleChecked,
    setAllChecked,
    bulk,
    draftCount,
    selection,
    select: setSelection,
    detail,
    detailLoading,
    detailError,
    refreshStatus,
    refreshList: () => setListNonce((n) => n + 1),
    reloadDetail: () => setDetailNonce((n) => n + 1),
    markRead,
    archive,
    removeThread,
    removeDraft,
    compose,
    openCompose,
    closeCompose: () => setCompose(null),
    replySeed,
  };
}
