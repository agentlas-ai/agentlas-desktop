"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { HostContinuationNotice } from "@/components/HostContinuationNotice";
import { normalizeChatHostNotice } from "@shared/chat-host-notice";
import type { ChatHostNotice, ChatMessagesCursor } from "@shared/types";
import { ipc } from "@/lib/ipc";
import { readOneChatHistoryPage, mergeOneChatHistory, oneChatHistoryCursor } from "@/lib/one-chat-history";
import { oneHistoryWindowStart, revealOneHistoryPage } from "@/lib/one-history-window";
import { parseChatFileMessage } from "@/lib/chat-files";
import { projectOneActivityFromLedger } from "@/lib/one-activity";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import type { OneActivityArtifact } from "@/lib/one-activity";
import { TaskSidePanel } from "../workspace/TaskSidePanel";
import styles from "./OneShell.module.css";

/**
 * 분할 보기의 "보고만 있는" 칸.
 *
 * 지금 쓰고 있는 대화 한 칸만 입력창을 가진다. 나머지 칸은 그 대화가 어디까지
 * 왔는지 보여주고, 누르면 그 칸이 입력창을 가져간다. 칸마다 입력·실행 배선을
 * 따로 만들면 실행 상태가 칸 수만큼 갈라지고, 한 대화가 두 칸에 동시에 떠 있을 때
 * 어느 쪽이 진짜인지 알 수 없게 된다.
 */
export interface OneSplitPaneMessage {
  id: string;
  role: string;
  text: string;
  createdAt?: string | null;
  hostNotice?: ChatHostNotice;
  imageDataUrls?: string[];
}

export function OneSplitPane({
  chatId,
  title,
  seatLabel,
  locale,
  running,
  onActivate,
  onClose,
  permissionMode,
  runtimeSelection,
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
  runtimeSelection?: unknown;
  appLocale: "ko" | "en";
}) {
  const [messages, setMessages] = useState<OneSplitPaneMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [artifacts, setArtifacts] = useState<OneActivityArtifact[]>([]);
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
    setLoadingOlder(false); setHistoryError(false); setDraft(""); setSending(false);
    setRailOpen(false); setArtifacts([]);
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
          setMessages(current => mergeOneChatHistory((current ?? []).filter(row => !row.id.startsWith("local:")), page.messages, "newest"));
        })
        .catch(() => {
          if (!cancelled && chatIdRef.current === chatId) setMessages(current => current ?? []);
        }).finally(() => { loading = false; });
    };
    load();
    /*
     * 옆 칸에서 답이 자라는 동안에만 자주 본다. 칸 셋이 1.5초마다 기록 전체를
     * 다시 읽어 화면이 눈에 띄게 굼떴다(오너 지적 2026-08-24). 조용한 칸은
     * 거의 묻지 않고, 창이 뒤로 가 있으면 아예 묻지 않는다.
     */
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      load();
    };
    const timer = window.setInterval(tick, running ? 3000 : 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
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

  // 이 칸이 만든 것들. 옆 칸이 자기 사이드바를 가지려면 자기 대화의 원장을
  // 스스로 읽어야 한다 — 지금 보고 있는 대화의 산출물을 빌려 쓰면 거짓이 된다.
  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    // 접혀 있는 사이드바 때문에 원장을 읽지 않는다. 열 때 처음 읽는다.
    if (!api || !railOpen) return;
    let loading = false;
    const load = () => {
      if (cancelled || loading) return;
      loading = true;
      void api.runLedger
        .chatTimeline(chatId, { maxRuns: 4, eventsPerRun: 200 })
        .then((runs: unknown) => {
          if (cancelled || chatIdRef.current !== chatId || !Array.isArray(runs)) return;
          const events = runs.flatMap((run: { events?: unknown }) => (Array.isArray(run?.events) ? run.events : []));
          if (events.length === 0) { setArtifacts([]); return; }
          try {
            setArtifacts(projectOneActivityFromLedger(events as never).artifacts);
          } catch {
            setArtifacts([]);
          }
        })
        .catch(() => { if (!cancelled) setArtifacts([]); })
        .finally(() => { loading = false; });
    };
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, running ? 8000 : 60000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [chatId, running, railOpen]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const api = ipc();
    if (!api) return;
    const chatEpoch = chatEpochRef.current;
    setSending(true);
    // 낙관적으로 먼저 그린다. 폴링이 다음 바퀴에 진짜 기록으로 바꾼다.
    const optimisticId = `local:${Date.now()}`;
    setMessages((current) => [...(current ?? []), { id: optimisticId, role: "user", text }]);
    setDraft("");
    try {
      await api.invoke.run({
        runId: `${chatId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        chatId,
        userPrompt: text,
        taskIntent: "conversation",
        oneMode: true,
        locale: appLocale,
        onePermissionMode: permissionMode,
        permissions: permissionMode === "auto" ? "read" : permissionMode,
        ...(runtimeSelection ? { runtimeSelection } : {}),
      } as never);
    } catch (cause) {
      if (chatIdRef.current !== chatId || chatEpochRef.current !== chatEpoch) return;
      setMessages((current) => (current ?? []).filter((message) => message.id !== optimisticId));
      // The request may fail after the composer has already accepted more input.
      // Restore the failed payload without overwriting that newer draft.
      setDraft((current) => (
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
  }, [appLocale, chatId, draft, locale, permissionMode, runtimeSelection, sending]);

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
          onClick={() => setRailOpen((value) => !value)}
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
        {visibleMessages.map((message) => {
          // Attachment markers are transport, never words (the files show in the full view).
          const text = typeof message.text === "string" ? parseChatFileMessage(message.text).visibleText.trim() : "";
          const images = Array.isArray(message.imageDataUrls) ? message.imageDataUrls.filter(Boolean) : [];
          if (!text && images.length === 0) return null;
          if (message.role === "system") {
            const notice = normalizeChatHostNotice(message.role, message.hostNotice);
            if (notice) return <HostContinuationNotice key={message.id} text={text} locale={locale === "ko" ? "ko" : "en"} notice={notice} />;
            return (
              <p key={message.id} data-split-message-id={message.id} className={styles.systemTurn} data-role="system">{text}</p>
            );
          }
          return (
            <article key={message.id} data-split-message-id={message.id} className={styles.message} data-role={message.role}>
              <div className={styles.messageBody}>
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
        <div className={railOpen ? styles.splitPaneRail : undefined}>
          <TaskSidePanel
            items={artifacts}
            locale={locale}
            visible={railOpen}
            onClose={() => setRailOpen(false)}
            onRequestOpen={() => setRailOpen(true)}
            screenChatId={chatId}
            browserScopeKey={chatId}
          />
        </div>
      </div>
      <form
        className={styles.splitPaneComposer}
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        <textarea
          value={draft}
          rows={1}
          placeholder={locale === "ko" ? "이 세션에 말하기" : "Message this session"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim() || sending}>
          {sending ? (locale === "ko" ? "보내는 중" : "Sending") : (locale === "ko" ? "보내기" : "Send")}
        </button>
      </form>
    </section>
  );
}
