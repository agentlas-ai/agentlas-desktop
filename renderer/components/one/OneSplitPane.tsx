"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { ipc } from "@/lib/ipc";
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

  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (!api) return;
    const load = () => {
      void api.invoke
        .history(chatId)
        .then((rows: unknown) => {
          if (cancelled) return;
          // 칸은 좁다. 오래된 turn 까지 Markdown 으로 다시 그리면 칸 수만큼
          // 비용이 곱해진다 — 최근 것만 그린다.
          const list = Array.isArray(rows) ? (rows as OneSplitPaneMessage[]) : [];
          setMessages(list.length > 40 ? list.slice(-40) : list);
        })
        .catch(() => {
          if (!cancelled) setMessages([]);
        });
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

  // 이 칸이 만든 것들. 옆 칸이 자기 사이드바를 가지려면 자기 대화의 원장을
  // 스스로 읽어야 한다 — 지금 보고 있는 대화의 산출물을 빌려 쓰면 거짓이 된다.
  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    // 접혀 있는 사이드바 때문에 원장을 읽지 않는다. 열 때 처음 읽는다.
    if (!api || !railOpen) return;
    const load = () => {
      void api.runLedger
        .chatTimeline(chatId, { maxRuns: 4, eventsPerRun: 200 })
        .then((runs: unknown) => {
          if (cancelled || !Array.isArray(runs)) return;
          const events = runs.flatMap((run: { events?: unknown }) => (Array.isArray(run?.events) ? run.events : []));
          if (events.length === 0) { setArtifacts([]); return; }
          try {
            setArtifacts(projectOneActivityFromLedger(events as never).artifacts);
          } catch {
            setArtifacts([]);
          }
        })
        .catch(() => { if (!cancelled) setArtifacts([]); });
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
      setSending(false);
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
        {(messages ?? []).map((message) => {
          const text = typeof message.text === "string" ? message.text.trim() : "";
          if (!text) return null;
          if (message.role === "system") {
            return (
              <p key={message.id} className={styles.systemTurn} data-role="system">{text}</p>
            );
          }
          return (
            <article key={message.id} className={styles.message} data-role={message.role}>
              <div className={styles.messageBody}>
                <Markdown text={text} messageId={message.id} chatId={chatId} />
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
            onBrowserObserved={() => setRailOpen(true)}
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
