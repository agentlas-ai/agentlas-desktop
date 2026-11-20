"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Markdown } from "@/components/Markdown";
import { HostContinuationNotice } from "@/components/HostContinuationNotice";
import { isHousekeepingHostNotice, normalizeChatHostNotice } from "@shared/chat-host-notice";
import type { ChatHostNotice, ChatMessagesCursor, OwnerInputItem } from "@shared/types";
import { readPaneDraft, writePaneDraft } from "@/lib/pane-drafts";
import { ipc } from "@/lib/ipc";
import { readOneChatHistoryPage, mergeOneChatHistory, oneChatHistoryCursor } from "@/lib/one-chat-history";
import { isInterruptedPartial } from "@shared/interrupted-partial";
import { parsePeerArrivals, peerArrivalLine } from "@shared/peer-envelope-marker";
import { oneHistoryWindowStart, revealOneHistoryPage } from "@/lib/one-history-window";
import { parseChatFileMessage } from "@/lib/chat-files";
import { useChatOutputs } from "@/lib/one-earlier-outputs";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { TaskSidePanel } from "../workspace/TaskSidePanel";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import { buildTranscript, bubblesOf, type TranscriptOwnerInput } from "@/lib/chat-transcript-model";
import { tFor } from "@/lib/i18n";
import { useComposerAgentPicker } from "../composer/ComposerAgentPicker";
import styles from "../one/OneShell.module.css";
import { useComposerEnter } from "@/lib/use-composer-enter";
import { useChatSelectionIntent } from "@/lib/chat-selection-intent";
import { isReceiptRowId } from "@shared/receipt-card";
import { ReceiptRowCard } from "@/components/ReceiptCard";
import { PendingPromisesStrip } from "@/components/PendingPromisesStrip";
import { chatSelectionSendBlocked, sendWhenChatSelectionSettles } from "@/lib/chat-selection-send-guard";

/**
 * One conversation as a pane (was OneSplitPane). It reads the history, sends from its own composer with its own chat id
 * (`invoke.run`, `oneMode: true`, the same run path the full One view takes), and has its own outputs rail. Two homes:
 *
 * It lives only in One's split view: its header names the session and closes the pane, and it draws no approvals or questions (the full view
 * does). A pane in Home's Space is drawn by the Space's own surfaces, never by this component.
 *
 * The list is ONE model (lib/chat-transcript-model.ts): the stored rows, plus the person's sends that have no stored row yet under their own intent
 * id. A bubble is a stored row or an intent, never a row of words; the rows are never cleared and re-added on a re-read.
 *
 * Reading follows the store, not a timer: a `store:changed` for this chat re-reads the newest page (coalesced), a finished
 * run reads once more, and only WHILE this chat runs a slow safety read covers a write that sends no signal. A quiet pane
 * holds no timer at all.
 */
export interface RoomPaneMessage {
  id: string;
  role: string;
  text: string;
  createdAt?: string | null;
  hostNotice?: ChatHostNotice;
  /** The id the composer made for this person's message (Main stores it on the row). */
  clientIntentId?: string;
  imageDataUrls?: string[];
  /** The member who wrote this line in a group room (absent on the owner's lines and the room's own). */
  speakerAgentId?: string | null;
}

export function RoomPane({
  chatId,
  title,
  seatLabel,
  locale,
  running,
  onActivate,
  onClose,
  permissionMode,
  appLocale,
}: {
  chatId: string;
  title: string;
  seatLabel: string;
  locale: "ko" | "en";
  running: boolean;
  onActivate: () => void;
  onClose: () => void;
  permissionMode: string;
  appLocale: "ko" | "en";
}) {
  const [messages, setMessages] = useState<RoomPaneMessage[] | null>(null);
  // The person's sends that have no stored row yet, each under the id the composer made (it is also the run id of the send). A send leaves this
  // list when its stored row arrives (the row carries the same id) or when the send fails; nothing is cleared by a re-read.
  const [pendingSends, setPendingSends] = useState<Array<{ intentId: string; text: string; createdAt: string }>>([]);
  // Main's read model of the sends of this chat that wait or are held (waiting, starting, held, uncertain): it gives a stored row its state line.
  const [ownerInputs, setOwnerInputs] = useState<OwnerInputItem[]>([]);
  const [stopNote, setStopNote] = useState(false);
  // A pane's unsent text outlives the tab switch and the chat switch (Space mounts only the active tab): it is kept per chat in memory
  // (lib/pane-drafts, 16 chats). An earlier integration dropped this with the old Space-only branch.
  const [draft, setDraftState] = useState(() => readPaneDraft(chatId));
  const chatIdForDraftRef = useRef(chatId);
  chatIdForDraftRef.current = chatId;
  const setDraft = useCallback((value: SetStateAction<string>) => {
    setDraftState((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      if (next !== previous) writePaneDraft(chatIdForDraftRef.current, next);
      return next;
    });
  }, []);
  const [sending, setSending] = useState(false);
  useChatSelectionIntent(chatId); // keeps this view registered as the owner of the conversation's pending pick
  // A send pressed while the model pick is still on its way to Main waits for it (a moment) and then sends by itself.
  const [sendWaiting, setSendWaiting] = useState(false);
  const settleWaitRef = useRef<(() => void) | null>(null);
  const sendRef = useRef<((selectionSettled?: boolean, answer?: string) => Promise<void>) | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  // The panel reports an open state with nothing to draw (no view, file or worker); the column is then not reserved
  // (the same rule as the full One view's outputRailTakesSpace).
  const [railEmpty, setRailEmpty] = useState(false);
  // Counts the person's presses that open the panel; a panel with nothing to show answers with its activity view
  // (TaskSidePanel openRequest), the same as the full One view's Outputs button.
  const [railOpenRequest, setRailOpenRequest] = useState(0);
  const { artifacts, earlierOutputs } = useChatOutputs({
    chatId, historyEnabled: railOpen, poll: railOpen, pollIntervalMs: running ? 8000 : 60000,
  });
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const loadedChatRef = useRef<string | null>(null);
  const historyRequestRef = useRef(0);
  const chatEpochRef = useRef(0);
  const [oldestVisibleId, setOldestVisibleId] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<ChatMessagesCursor | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const messageIds = useMemo(() => (messages ?? []).map(message => message.id), [messages]);
  const historyStart = oneHistoryWindowStart(messageIds, oldestVisibleId, 24);
  const visibleMessages = useMemo(() => (messages ?? []).slice(historyStart), [messages, historyStart]);
  const scrollAnchorRef = useRef<{ id: string; top: number } | null>(null);
  const rememberScrollAnchor = () => {
    const element = bodyRef.current?.querySelector<HTMLElement>("[data-split-message-id]");
    if (element) scrollAnchorRef.current = { id: element.dataset.splitMessageId!, top: element.getBoundingClientRect().top };
  };
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    scrollAnchorRef.current = null;
    if (!anchor || !bodyRef.current) return;
    const element = [...bodyRef.current.querySelectorAll<HTMLElement>("[data-split-message-id]")]
      .find(row => row.dataset.splitMessageId === anchor.id);
    if (element) bodyRef.current.scrollTop += element.getBoundingClientRect().top - anchor.top;
  }, [historyStart]);
  useLayoutEffect(() => {
    historyRequestRef.current += 1;
    chatEpochRef.current += 1;
    loadedChatRef.current = null;
    scrollAnchorRef.current = null;
    setMessages(null); setOldestVisibleId(null); setOlderCursor(null); setHasOlder(false);
    setLoadingOlder(false); setHistoryError(false); setDraftState(readPaneDraft(chatId)); setSending(false);
    setPendingSends([]); setOwnerInputs([]); setStopNote(false);
    setRailOpen(false); setRailEmpty(false);
  }, [chatId]);

  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (!api) return;
    let loading = false;
    const load = () => {
      if (cancelled || loading) return;
      loading = true;
      void readOneChatHistoryPage(api, chatId)
        .then((page) => {
          if (cancelled || chatIdRef.current !== chatId) return;
          if (loadedChatRef.current !== chatId || page.messages.length === 0) {
            loadedChatRef.current = page.messages.length ? chatId : null;
            setOlderCursor(oneChatHistoryCursor(page.messages)); setHasOlder(page.hasOlder);
            if (page.messages.length === 0) {
              historyRequestRef.current += 1;
              setLoadingOlder(false); setHistoryError(false); setOldestVisibleId(null);
            }
          }
          // Refresh only newer data. Explicitly loaded earlier pages stay cached,
          // and this read never expands their DOM window.
          setMessages(current => mergeOneChatHistory(current ?? [], page.messages, "newest"));
          // A send whose stored row is in the page is no longer pending (matched by its id).
          const stored = new Set(page.messages.map((row) => (row as RoomPaneMessage).clientIntentId).filter((id): id is string => typeof id === "string"));
          if (stored.size) setPendingSends((current) => (current.some((item) => stored.has(item.intentId)) ? current.filter((item) => !stored.has(item.intentId)) : current));
        })
        .catch(() => {
          if (!cancelled && chatIdRef.current === chatId) setMessages(current => current ?? []);
        }).finally(() => { loading = false; });
      // The states of the sends that are not delivered yet; an older window without the channel has none.
      void Promise.resolve(api.chat?.ownerInputs?.(chatId)).then((items) => {
        if (!cancelled && chatIdRef.current === chatId && Array.isArray(items)) setOwnerInputs((current) => (current.length === 0 && items.length === 0 ? current : items));
      }).catch(() => undefined);
    };
    load();
    // A store change for THIS chat (or one without an id) re-reads the newest page, at most once per 250 ms burst.
    let burst: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeStoreChanges((change) => {
      if (change.entity !== "chat" || (change.id && change.id !== chatId) || burst) return;
      burst = setTimeout(() => { burst = null; load(); }, 250);
    });
    // While this chat runs, a write that sends no signal is still caught (a minute at worst: every chat write announces itself
    // above, the other process's rows through external-chat-changes.ts); a quiet chat has no timer.
    const safety = running ? window.setInterval(() => { if (document.visibilityState !== "hidden") load(); }, SAFETY_READ_MS) : null;
    return () => {
      cancelled = true;
      off();
      if (burst) clearTimeout(burst);
      if (safety !== null) window.clearInterval(safety);
    };
  }, [chatId, running]);

  const revealEarlier = useCallback(async () => {
    if (loadingOlder) return;
    if (historyStart > 0) {
      rememberScrollAnchor();
      setOldestVisibleId(revealOneHistoryPage(messageIds, historyStart, 40));
      return;
    }
    const api = ipc();
    if (!api || !hasOlder || !olderCursor) return;
    const request = ++historyRequestRef.current;
    setLoadingOlder(true); setHistoryError(false);
    try {
      const page = await readOneChatHistoryPage(api, chatId, olderCursor);
      if (chatIdRef.current !== chatId || request !== historyRequestRef.current) return;
      const nextCursor = oneChatHistoryCursor(page.messages);
      if (page.hasOlder && (!nextCursor || (nextCursor.id === olderCursor.id && nextCursor.createdAt === olderCursor.createdAt))) {
        throw new Error("history_page_did_not_advance");
      }
      rememberScrollAnchor();
      setMessages(current => mergeOneChatHistory(current ?? [], page.messages, "older"));
      // The explicit request reveals only this page's most recent 40 rows.
      // Any remaining fetched rows stay cached and unmounted.
      if (page.messages.length) setOldestVisibleId(page.messages[Math.max(0, page.messages.length - 40)].id);
      setOlderCursor(nextCursor); setHasOlder(page.hasOlder);
    } catch {
      if (chatIdRef.current === chatId && request === historyRequestRef.current) setHistoryError(true);
    } finally {
      if (chatIdRef.current === chatId && request === historyRequestRef.current) setLoadingOlder(false);
    }
  }, [chatId, hasOlder, historyStart, loadingOlder, messageIds, olderCursor]);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const picker = useComposerAgentPicker({ text: draft, setText: setDraft, inputRef: composerRef, locale });
  const send = useCallback(async (selectionSettled?: boolean, answer?: string) => {
    // `answer` is a reply to a question card in this pane: it goes as the owner's next line, and the composer's own draft stays.
    const text = (answer ?? draft).trim();
    if (!text || sending || chatIdRef.current !== chatId) return;
    // The live target-chat intent can change before this render catches up. Wait before optimistic rows, draft clearing or
    // request identity creation; the wait ends by sending the draft as it is then (not a refusal, Send stays pressable).
    if (!selectionSettled && chatSelectionSendBlocked(chatId)) {
      settleWaitRef.current?.();
      setSendWaiting(true);
      settleWaitRef.current = sendWhenChatSelectionSettles(chatId, () => undefined, () => {
        settleWaitRef.current = null;
        setSendWaiting(false);
        void sendRef.current?.(true, answer);
      });
      return;
    }
    const api = ipc();
    if (!api) return;
    const chatEpoch = chatEpochRef.current;
    setSending(true);
    // The bubble is drawn at once under this send's own id; the stored row (same id) replaces it, a failed send removes it.
    // The invocation service accepts only a UUID as a run id (a colon-joined id was refused as "Invalid invocation runId").
    const intentId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16).padStart(8, "0").slice(-8)}-0000-4000-8000-${Math.floor(Math.random() * 1e12).toString(16).padStart(12, "0").slice(-12)}`;
    const pickedTargets = picker.targets();
    setPendingSends((current) => [...current, { intentId, text, createdAt: new Date().toISOString() }]);
    setStopNote(false);
    if (answer === undefined) { setDraft(""); picker.reset(); }
    try {
      await api.invoke.run({
        runId: intentId,
        clientIntentId: intentId,
        chatId,
        userPrompt: text,
        ...(pickedTargets.length ? { taskForceTargets: pickedTargets } : {}),
        taskIntent: "conversation",
        oneMode: true,
        locale: appLocale,
        onePermissionMode: permissionMode,
        permissions: permissionMode === "auto" ? "read" : permissionMode,
      } as never);
    } catch (cause) {
      if (chatIdRef.current !== chatId || chatEpochRef.current !== chatEpoch) return;
      setPendingSends((current) => current.filter((item) => item.intentId !== intentId));
      // The request may fail after the composer has already accepted more input.
      // Restore the failed payload without overwriting that newer draft.
      if (answer === undefined) setDraft((current) => (
        !current.trim()
          ? text
          : current === text
            ? current
            : `${text}\n${current}`
      ));
      requestOneOperationalRecovery("one-split-pane-send", cause, {
        chatId,
        userMessage: locale === "ko"
          ? "이 세션에 메시지를 보내지 못했습니다. 입력은 그대로 두었습니다. 다시 시도해 주세요."
          : "The message was not sent to this session. Your draft was restored; please try again.",
      });
    } finally {
      if (chatIdRef.current === chatId && chatEpochRef.current === chatEpoch) setSending(false);
    }
  }, [appLocale, chatId, draft, locale, permissionMode, picker.reset, picker.targets, sending]);
  sendRef.current = send;
  useEffect(() => () => { settleWaitRef.current?.(); settleWaitRef.current = null; }, []);
  useEffect(() => { settleWaitRef.current?.(); settleWaitRef.current = null; setSendWaiting(false); }, [chatId]);
  // The one Stop of the chat (Main `chat.stop`): the live run, every send that has not started. The words of the sends that were NOT sent come
  // back into the input box, with one line saying so.
  const [stopping, setStopping] = useState(false);
  const stop = useCallback(async () => {
    const api = ipc();
    if (!api?.chat?.stop || stopping) return;
    setStopping(true);
    try {
      const receipt = await api.chat.stop(chatId);
      if (chatIdRef.current !== chatId) return;
      const back = (receipt?.withdrawn ?? []).map((item) => item.text).filter((words) => words.trim());
      const intents = new Set((receipt?.withdrawn ?? []).map((item) => item.intentId).filter((id): id is string => typeof id === "string"));
      if (intents.size) setPendingSends((current) => current.filter((item) => !intents.has(item.intentId)));
      if (back.length) { setDraft((current) => [...back, current].filter((words) => words.trim()).join("\n")); setStopNote(true); }
    } catch { /* the Stop that did not arrive leaves the chat as it was; the person can press it again */ }
    finally { if (chatIdRef.current === chatId) setStopping(false); }
  }, [chatId, stopping]);
  const enter = useComposerEnter(() => { void send(); });
  const ownerInputById = useMemo<TranscriptOwnerInput[]>(() => ownerInputs.map((item) => ({ key: item.key, state: item.state, text: item.text, intentId: item.intentId, reason: item.reason, runId: item.runId, createdAt: item.createdAt })), [ownerInputs]);
  const transcript = useMemo(() => bubblesOf(buildTranscript({
    stored: visibleMessages,
    ownerInputs: [...ownerInputById, ...pendingSends.map((item): TranscriptOwnerInput => ({ key: `intent:${item.intentId}`, state: "accepted", text: item.text, intentId: item.intentId, createdAt: item.createdAt }))],
  })), [ownerInputById, pendingSends, visibleMessages]);
  const waitingSends = ownerInputs.some((item) => item.state === "waiting" || item.state === "starting");

  return (
    <section className={styles.splitPane} data-one-split-pane={chatId}>
      <header className={styles.splitPaneHeader}>
        <button type="button" className={styles.splitPaneTitle} onClick={onActivate} title={title}>
          <span className={styles.splitPaneSeat}>{seatLabel}</span>
          <span className={styles.splitPaneName}>{title}</span>
        </button>
        {running && <span className={styles.sessionRunningDot} aria-hidden="true" />}
        <button
          type="button"
          className={styles.splitPaneRailToggle}
          data-on={railOpen ? "true" : "false"}
          aria-pressed={railOpen}
          aria-label={locale === "ko" ? "이 칸의 산출물" : "Outputs of this pane"}
          onClick={() => {
            if (!railOpen) setRailOpenRequest((request) => request + 1);
            setRailOpen((value) => !value);
          }}
        >
          {locale === "ko" ? "결과" : "Outputs"}
          {artifacts.length > 0 && <span className={styles.splitPaneRailCount}>{artifacts.length}</span>}
        </button>
        <button
          type="button"
          className={styles.splitPaneClose}
          aria-label={locale === "ko" ? "이 칸 닫기" : "Close this pane"}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className={styles.splitPaneStage}>
      <div ref={bodyRef} className={styles.splitPaneBody} onClick={onActivate}>
        {messages === null && <p className={styles.splitPaneNote}>{locale === "ko" ? "불러오는 중" : "Loading"}</p>}
        {messages !== null && messages.length === 0 && (
          <p className={styles.splitPaneNote}>{locale === "ko" ? "아직 오간 말이 없습니다." : "No messages yet."}</p>
        )}
        {(historyStart > 0 || hasOlder) && <button type="button" className={styles.splitPaneRailToggle} data-one-split-history="earlier"
          disabled={loadingOlder || historyError} onClick={event => { event.stopPropagation(); void revealEarlier(); }}>
          {loadingOlder ? (locale === "ko" ? "이전 대화 불러오는 중" : "Loading earlier messages")
            : historyStart > 0 ? (locale === "ko" ? `이전 대화 ${historyStart}개 · ${Math.min(40, historyStart)}개 더 보기` : `${historyStart} earlier messages · Show ${Math.min(40, historyStart)} more`)
              : (locale === "ko" ? "이전 대화 불러오기" : "Load earlier messages")}
        </button>}
        {oldestVisibleId !== null && <button type="button" className={styles.splitPaneRailToggle} data-one-split-history="collapse"
          onClick={event => { event.stopPropagation(); historyRequestRef.current += 1; setLoadingOlder(false); scrollAnchorRef.current = null; setOldestVisibleId(null); }}>
          {locale === "ko" ? "이전 대화 접기" : "Hide earlier messages"}
        </button>}
        {historyError && <p role="status" className={styles.splitPaneNote}>
          {locale === "ko" ? "이전 대화를 불러오지 못했습니다. 이 칸을 닫고 다시 열어 기록을 새로 불러와 주세요." : "Earlier messages could not be loaded. Close and reopen this pane to refresh the history."}
        </p>}
        {transcript.map((item) => {
          // A bubble is a stored row or a send under its own intent (lib/chat-transcript-model.ts). Never a row of words.
          const message: RoomPaneMessage = item.row ?? { id: item.key, role: item.role, text: item.text, createdAt: item.createdAt };
          // Attachment markers are transport, never words (the files show in the full view).
          const text = typeof message.text === "string" ? parseChatFileMessage(message.text).visibleText.trim() : "";
          const images = Array.isArray(message.imageDataUrls) ? message.imageDataUrls.filter(Boolean) : [];
          if (!text && images.length === 0) return null;
          // Housekeeping host rows (check, continue, wait, resume; NH26) are drawn on no surface.
          if (isHousekeepingHostNotice(normalizeChatHostNotice(message.role, message.hostNotice))) return null;
          if (message.role === "system") {
            // A host receipt: the one receipt card (the same as Work, the One window and the personal window).
            if (isReceiptRowId(message.id)) return <ReceiptRowCard key={item.key} row={message} chatId={chatId} />;
            const notice = normalizeChatHostNotice(message.role, message.hostNotice);
            // A system row without a typed notice is a host-written harness request (Goal resume, continuation): it is
            // not drawn, like in the full One view. Interrupted answers below are internal states too.
            if (notice) return <HostContinuationNotice key={item.key} text={text} locale={locale === "ko" ? "ko" : "en"} notice={notice} chatId={chatId} />;
            // A message another conversation of the project sent here is stored as a system row; the person sees that it arrived.
            const arrivals = parsePeerArrivals(text);
            return arrivals ? <p key={item.key} role="status" data-peer-arrival="true" className={styles.splitPaneNote}>{peerArrivalLine(arrivals, locale === "ko")}</p> : null;
          }
          if (message.role === "assistant" && isInterruptedPartial(message.text ?? "")) return null;
          // The state of a send that has not started: one line under the bubble, from Main's state (never guessed from the words).
          const state = item.ownerInput?.state;
          const stateLine = state === "waiting" || state === "starting" ? tFor(locale, "room.send.waiting")
            : state === "held" ? tFor(locale, "room.send.held") : state === "uncertain" ? tFor(locale, "room.send.uncertain") : null;
          return (
            <article key={item.key} data-split-message-id={message.id} data-transcript-key={item.key} className={styles.message} data-role={message.role}>
              <div className={styles.messageBody}>
                {images.length > 0 && <div className={styles.messageImages} data-one-message-media="true">
                  {images.map((src, index) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={`${message.id}-img-${index}`} src={src} alt="" className={styles.messageImage} />
                  ))}
                </div>}
                {text && <Markdown text={text} messageId={message.id} chatId={chatId} />}
                {stateLine && <p role="status" data-owner-input-state={state} className={styles.splitPaneNote}>{stateLine}</p>}
              </div>
            </article>
          );
        })}
      </div>
        <div className={railOpen && !railEmpty ? styles.splitPaneRail : undefined}>
          <TaskSidePanel
            items={artifacts}
            earlierOutputs={earlierOutputs}
            locale={locale}
            visible={railOpen}
            onClose={() => setRailOpen(false)}
            onRequestOpen={() => setRailOpen(true)}
            onEmptyChange={setRailEmpty}
            openRequest={railOpenRequest}
            screenChatId={chatId}
            browserScopeKey={chatId}
          />
        </div>
      </div>
      {stopNote && <p role="status" data-room-pane-stop-note="true" className={styles.splitPaneNote}>{tFor(locale, "room.stop.putBack")}</p>}
      {sendWaiting && <p role="status" className={styles.splitPaneNote}>
        {locale === "ko" ? "모델 선택을 확인하는 중이에요. 확인되면 바로 보냅니다." : "Checking the model selection. It sends as soon as that is confirmed."}
      </p>}
      <PendingPromisesStrip chatId={chatId} />
      <form
        className={styles.splitPaneComposer}
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        {picker.node}
        <textarea
          ref={composerRef}
          value={draft}
          rows={1}
          data-room-pane-composer={chatId}
          placeholder={locale === "ko" ? "이 세션에 말하기 (@로 에이전트 고르기)" : "Message this session (@ to pick an agent)"}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionUpdate={enter.onCompositionUpdate}
          onCompositionEnd={enter.onCompositionEnd}
          onKeyDown={(event) => { if (picker.handleKey(event)) return; enter.handleEnter(event); }}
        />
        {(running || waitingSends) && <button type="button" data-room-pane-stop={chatId} disabled={stopping} onClick={() => { void stop(); }}>{tFor(locale, "room.stop")}</button>}
        <button type="submit" disabled={!draft.trim() || sending}>
          {sending ? (locale === "ko" ? "보내는 중" : "Sending") : (locale === "ko" ? "보내기" : "Send")}
        </button>
      </form>
    </section>
  );
}

/** Net under the store:changed signal while this chat runs. */
const SAFETY_READ_MS = 60_000;
