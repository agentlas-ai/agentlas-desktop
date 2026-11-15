"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { Markdown } from "@/components/Markdown";
import { HostContinuationNotice } from "@/components/HostContinuationNotice";
import { isHousekeepingHostNotice, normalizeChatHostNotice } from "@shared/chat-host-notice";
import type { ChatHostNotice, ChatMessagesCursor } from "@shared/types";
import { ipc } from "@/lib/ipc";
import { readOneChatHistoryPage, mergeOneChatHistory, oneChatHistoryCursor } from "@/lib/one-chat-history";
import { isInterruptedPartial } from "@shared/interrupted-partial";
import { oneHistoryWindowStart, revealOneHistoryPage } from "@/lib/one-history-window";
import { parseChatFileMessage } from "@/lib/chat-files";
import { useChatOutputs } from "@/lib/one-earlier-outputs";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { TaskSidePanel } from "../workspace/TaskSidePanel";
import { ToolApprovalInline } from "../ToolApprovalInline";
import { RoomPaneMemberAsks, RoomPaneWorking } from "./RoomLeadStatus";
import { ComposerDecisionSlot } from "../ComposerDecisionPortal";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import { useChatConfirmations } from "@/lib/attention";
import { AskCard } from "../AskCard";
import { readPaneDraft, writePaneDraft } from "@/lib/pane-drafts";
import { useRoomChildren } from "@/lib/room-children";
import { homeBridge } from "@/lib/home-tree";
import styles from "../one/OneShell.module.css";
import { useComposerEnter } from "@/lib/use-composer-enter";
import { useChatSelectionIntent } from "@/lib/chat-selection-intent";
import { chatSelectionSendBlocked, sendWhenChatSelectionSettles } from "@/lib/chat-selection-send-guard";

/**
 * One conversation as a pane (was OneSplitPane). It reads the history, sends from its own composer with its own chat id
 * (`invoke.run`, `oneMode: true`, the same run path the full One view takes), and has its own outputs rail. Two homes:
 *
 *  - "split": One's split view. Its header names the session and closes the pane; it draws no approvals (the full view does).
 *  - "space": a pane in Home's Space. The tab strip is the header, and the pane draws its own tool approvals and shows the
 *    questions the chat waits on, because a chat that is on screen is not counted by the sidebar dots.
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
  variant = "split",
  focused = false,
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
  variant?: "split" | "space";
  /** Space only: this pane holds the focus, so the app's shared question card is drawn here. */
  focused?: boolean;
}) {
  const inSpace = variant === "space";
  // The members working in this room (child sessions): their questions and approvals are drawn here too.
  const childIds = useRoomChildren(chatId, variant === "space");
  const [messages, setMessages] = useState<RoomPaneMessage[] | null>(null);
  // Who spoke: names of the room's members, read once per room (the left tree reads the same list). A speaker that is gone has no name.
  const [memberNames, setMemberNames] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  useEffect(() => {
    if (!inSpace) return;
    const bridge = homeBridge();
    if (!bridge) return;
    let cancelled = false;
    void bridge.participants(chatId).then((list) => { if (!cancelled) setMemberNames(new Map(list.map((item) => [item.agentId, item.name]))); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [chatId, inSpace]);
  // A pane's unsent text outlives the tab switch (Space mounts only the active tab): it is kept per chat in memory.
  const [draft, setDraftState] = useState(() => (inSpace ? readPaneDraft(chatId) : ""));
  const chatIdForDraftRef = useRef(chatId);
  chatIdForDraftRef.current = chatId;
  const setDraft = useCallback((value: SetStateAction<string>) => {
    setDraftState((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      if (inSpace && next !== previous) writePaneDraft(chatIdForDraftRef.current, next);
      return next;
    });
  }, [inSpace]);
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
    setLoadingOlder(false); setHistoryError(false); setDraftState(inSpace ? readPaneDraft(chatId) : ""); setSending(false);
    setRailOpen(false); setRailEmpty(false);
  }, [chatId]); // `inSpace` never changes for a mounted pane

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
          setMessages(current => mergeOneChatHistory((current ?? []).filter(row => !row.id.startsWith("local:")), page.messages, "newest"));
        })
        .catch(() => {
          if (!cancelled && chatIdRef.current === chatId) setMessages(current => current ?? []);
        }).finally(() => { loading = false; });
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
    // 낙관적으로 먼저 그린다. 폴링이 다음 바퀴에 진짜 기록으로 바꾼다.
    const optimisticId = `local:${Date.now()}`;
    setMessages((current) => [...(current ?? []), { id: optimisticId, role: "user", text }]);
    if (answer === undefined) setDraft("");
    try {
      await api.invoke.run({
        // The invocation service accepts only a UUID here (a colon-joined id was refused as "Invalid invocation runId").
        runId: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16).padStart(8, "0").slice(-8)}-0000-4000-8000-${Math.floor(Math.random() * 1e12).toString(16).padStart(12, "0").slice(-12)}`,
        chatId,
        userPrompt: text,
        taskIntent: "conversation",
        oneMode: true,
        locale: appLocale,
        onePermissionMode: permissionMode,
        permissions: permissionMode === "auto" ? "read" : permissionMode,
      } as never);
    } catch (cause) {
      if (chatIdRef.current !== chatId || chatEpochRef.current !== chatEpoch) return;
      setMessages((current) => (current ?? []).filter((message) => message.id !== optimisticId));
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
  }, [appLocale, chatId, draft, locale, permissionMode, sending]);
  sendRef.current = send;
  useEffect(() => () => { settleWaitRef.current?.(); settleWaitRef.current = null; }, []);
  useEffect(() => { settleWaitRef.current?.(); settleWaitRef.current = null; setSendWaiting(false); }, [chatId]);
  const enter = useComposerEnter(() => { void send(); });

  return (
    <section className={styles.splitPane} data-one-split-pane={chatId} data-room-pane-variant={variant} data-room-pane-focused={focused ? "true" : undefined}>
      <header className={styles.splitPaneHeader}>
        {inSpace ? <span className={styles.splitPaneSeat} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{seatLabel}</span> : <button type="button" className={styles.splitPaneTitle} onClick={onActivate} title={title}>
          <span className={styles.splitPaneSeat}>{seatLabel}</span>
          <span className={styles.splitPaneName}>{title}</span>
        </button>}
        {running && !inSpace && <span className={styles.sessionRunningDot} aria-hidden="true" />}
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
        {!inSpace && <button
          type="button"
          className={styles.splitPaneClose}
          aria-label={locale === "ko" ? "이 칸 닫기" : "Close this pane"}
          onClick={onClose}
        >
          ×
        </button>}
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
        {visibleMessages.map((message) => {
          // Attachment markers are transport, never words (the files show in the full view).
          const text = typeof message.text === "string" ? parseChatFileMessage(message.text).visibleText.trim() : "";
          const images = Array.isArray(message.imageDataUrls) ? message.imageDataUrls.filter(Boolean) : [];
          if (!text && images.length === 0) return null;
          // Housekeeping host rows (check, continue, wait, resume; NH26) are drawn on no surface.
          if (isHousekeepingHostNotice(normalizeChatHostNotice(message.role, message.hostNotice))) return null;
          if (message.role === "system") {
            const notice = normalizeChatHostNotice(message.role, message.hostNotice);
            // A system row without a typed notice is a host-written harness request (Goal resume, continuation): it is
            // not drawn, like in the full One view. Interrupted answers below are internal states too.
            return notice ? <HostContinuationNotice key={message.id} text={text} locale={locale === "ko" ? "ko" : "en"} notice={notice} chatId={chatId} /> : null;
          }
          if (message.role === "assistant" && isInterruptedPartial(message.text ?? "")) return null;
          return (
            <article key={message.id} data-split-message-id={message.id} className={styles.message} data-role={message.role}>
              <div className={styles.messageBody}>
                {inSpace && message.role === "assistant" && message.speakerAgentId ? (
                  <strong data-room-speaker={message.speakerAgentId} style={{ display: "block", fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
                    {memberNames.get(message.speakerAgentId) ?? (locale === "ko" ? "삭제된 에이전트" : "Removed agent")}
                  </strong>
                ) : null}
                {images.length > 0 && <div className={styles.messageImages} data-one-message-media="true">
                  {images.map((src, index) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={`${message.id}-img-${index}`} src={src} alt="" className={styles.messageImage} />
                  ))}
                </div>}
                {text && <Markdown text={text} messageId={message.id} chatId={chatId} />}
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
      {inSpace && <RoomPaneWorking roomChatId={chatId} locale={locale} childIds={childIds} />}
      {inSpace && <RoomPaneWaiting chatId={chatId} locale={locale} sending={sending} onAnswer={(text) => { void send(false, text); }} />}
      {inSpace && <ToolApprovalInline permission={toolApprovalPermission(permissionMode)} chatId={chatId} compact chip />}
      {inSpace && <RoomPaneMemberAsks childIds={childIds} permission={toolApprovalPermission(permissionMode)} />}
      {inSpace && <ComposerDecisionSlot surface="one" />}
      {sendWaiting && <p role="status" className={styles.splitPaneNote}>
        {locale === "ko" ? "모델 선택을 확인하는 중이에요. 확인되면 바로 보냅니다." : "Checking the model selection. It sends as soon as that is confirmed."}
      </p>}
      <form
        className={styles.splitPaneComposer}
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        <textarea
          value={draft}
          rows={1}
          data-room-pane-composer={chatId}
          onFocus={inSpace ? onActivate : undefined}
          placeholder={locale === "ko" ? "이 세션에 말하기" : "Message this session"}
          onChange={(event) => setDraft(event.target.value)}
          onCompositionUpdate={enter.onCompositionUpdate}
          onCompositionEnd={enter.onCompositionEnd}
          onKeyDown={(event) => { enter.handleEnter(event); }}
        />
        <button type="submit" disabled={!draft.trim() || sending}>
          {sending ? (locale === "ko" ? "보내는 중" : "Sending") : (locale === "ko" ? "보내기" : "Send")}
        </button>
      </form>
    </section>
  );
}

/** Net under the store:changed signal while this chat runs. */
const SAFETY_READ_MS = 60_000;
const toolApprovalPermission = (mode: string): "auto" | "read" | "write" | "full" => (mode === "read" || mode === "write" || mode === "full" ? mode : "auto");

/**
 * Questions this room waits on ("pending confirmations"): drawn in the pane as the shared question card. A choice (or typed answer)
 * goes to the room as the owner's next line - the same thing the full view's "answer as a new message" does - so a question is
 * never swallowed or sent to another screen because the room happens to be in a pane.
 */
function RoomPaneWaiting({ chatId, locale, sending, onAnswer }: { chatId: string; locale: "ko" | "en"; sending: boolean; onAnswer: (text: string) => void }) {
  const waiting = useChatConfirmations(chatId);
  const [typed, setTyped] = useState("");
  const current = waiting[0];
  useEffect(() => { setTyped(""); }, [current?.sourceMessageId]);
  if (!current) return null;
  const ko = locale === "ko";
  const extra = waiting.length > 1 ? (ko ? ` (${waiting.length}건 중 1)` : ` (1 of ${waiting.length})`) : "";
  const typedAnswer = typed.trim();
  return (
    <div data-room-pane-waiting={chatId} data-room-pane-question={current.sourceMessageId} className={styles.splitPaneNote} style={{ textAlign: "left" }}>
      <AskCard
        key={current.sourceMessageId}
        title={`${current.header || current.requesterLabel || (ko ? "질문" : "Question")}${extra}`}
        subtitle={current.question}
        locale={ko ? "ko" : "en"}
        options={current.options.map((option, index) => ({ id: option.label, title: option.label, note: option.description, active: !typedAnswer && index === 0, disabled: sending }))}
        freeText={typed}
        onFreeTextChange={setTyped}
        onChoose={(id) => onAnswer(id)}
        footer={{
          placeholder: ko ? "직접 답하기" : "Answer in your own words",
          skipLabel: ko ? "나중에" : "Later",
          submitLabel: ko ? "보내기" : "Send",
          hasSelection: false,
          hideButton: false,
          onSkip: (text) => { if (text.trim()) onAnswer(text.trim()); },
        }}
        statusLabel={ko ? "입력이 필요합니다" : "Input needed"}
      />
    </div>
  );
}
