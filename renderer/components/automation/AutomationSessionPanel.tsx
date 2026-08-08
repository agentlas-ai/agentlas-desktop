"use client";

// 자동화 세션 패널 — 읽기 전용 트랜스크립트가 아니라 실제 대화창이다. 자동화 실행이
// 남긴 요청/결과와 사용자가 지금 보내는 턴이 같은 세션 chat(실행 원장) 위에서 이어진다.
// 실행이 "확인 필요"로 멈췄을 때 사용자가 바로 여기서 원인을 묻고 이어서 해결할 수 있게
// 하는 것이 이 패널의 목적이다(RunHistoryPanel의 "대화에서 이어서 해결"이 여기로 들어온다).

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { extractQuestions } from "@/lib/ask-question";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import type {
  AutomationExecutionPermission,
  AutomationHubMode,
  AutomationToolMode,
  ChatHistoryEntry,
  McpInvocationEvent,
} from "@/lib/types";

/** RunHistoryPanel → 세션 대화 프리필/전송 요청. 창 이벤트로 느슨하게 연결한다. */
export const AUTOMATION_SESSION_PROMPT_EVENT = "agentlas:automation-session-prompt";

export interface AutomationSessionPromptDetail {
  automationId: string;
  text: string;
  /** true면 프리필만 하지 않고 바로 전송한다. */
  send?: boolean;
  /** 패널이 실제로 받았는지 — 호출자가 폴백(플로우 화면으로 이동)을 결정하는 근거. */
  handled?: boolean;
}

function pendingKey(automationId: string): string {
  return `agentlas.automation.pendingPrompt.${automationId}`;
}

/**
 * 세션 대화에 질문을 넘긴다. 패널이 이 화면에 없으면(예: 자동화 상세) false를 돌려주고,
 * 요청은 sessionStorage에 남겨 플로우 화면에서 패널이 뜨는 즉시 이어받는다.
 */
export function askAutomationSession(detail: AutomationSessionPromptDetail): boolean {
  const payload: AutomationSessionPromptDetail = { ...detail };
  window.dispatchEvent(new CustomEvent(AUTOMATION_SESSION_PROMPT_EVENT, { detail: payload }));
  if (payload.handled) return true;
  try {
    window.sessionStorage.setItem(
      pendingKey(detail.automationId),
      JSON.stringify({ text: detail.text, send: detail.send ?? false }),
    );
  } catch {
    // 저장이 막혀 있으면 넘겨받을 방법이 없다 — 호출자가 화면 이동만 수행한다.
  }
  return false;
}

interface AutomationSessionPanelProps {
  automationId: string;
  locale: "ko" | "en";
  /** 자동화가 저장한 실행 도구/Hub 선호도 — 수동 턴도 같은 조건으로 돌게 맞춘다. */
  toolMode?: AutomationToolMode;
  hubMode?: AutomationHubMode;
  /**
   * 이 자동화가 예약 실행에 쓰는 권한. 세션 대화에서 보낸 지시도 같은 권한으로 돈다.
   * 넘기지 않으면 read로 떨어져 "스크립트를 실행하려면 write/full 권한으로 실행하세요"
   * 같은 답만 돌아온다 — 사용자는 자기 자동화에 이어서 지시했을 뿐인데 아무것도 못 한다.
   */
  executionPermission?: AutomationExecutionPermission;
  onCollapse?: () => void;
  /**
   * 하단 통합 패널 임베드 모드(오너 지시 2026-08-08: 세션 대화를 별도 열이 아니라
   * 바텀시트 하나로). 헤더와 자체 입력줄을 숨기고 대화 스트림만 그린다 —
   * 입력은 바깥의 공용 입력 하나가 sendHandleRef로 이 패널의 send를 부른다.
   */
  embedded?: boolean;
  /** 바깥 공용 입력이 세션 전송을 부를 수 있는 손잡이. */
  sendHandleRef?: React.MutableRefObject<((text: string) => void) | null>;
}

/**
 * 전송 실패를 사람 말로. main이 던지는 문자열은 내부 코드라 그대로 보여주면
 * "Error invoking remote method 'invoke:run'..." 같은 문장이 사용자 화면에 그대로 뜬다.
 */
function sendFailureMessage(error: unknown, ko: boolean): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/active invocation/i.test(raw)) {
    return ko
      ? "이 자동화가 지금 실행 중이라 바로 보낼 수 없어요. 끝나면 이어서 보내드릴게요."
      : "This automation is running right now, so it could not be sent yet. It will go out when the run ends.";
  }
  if (/auth|token|login|unauthori[sz]ed|forbidden/i.test(raw)) {
    return ko ? "연결이 만료돼 보내지 못했어요. 다시 연결한 뒤 시도해 주세요." : "The connection expired. Reconnect and try again.";
  }
  return ko ? "보내지 못했어요. 잠시 뒤 다시 시도해 주세요." : "It could not be sent. Try again shortly.";
}

function isImeSubmit(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export function AutomationSessionPanel({
  automationId,
  locale,
  toolMode,
  hubMode,
  executionPermission,
  onCollapse,
  embedded = false,
  sendHandleRef,
}: AutomationSessionPanelProps) {
  const ko = locale === "ko";
  const [messages, setMessages] = useState<ChatHistoryEntry[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState("");

  // 폴링이 스트리밍 중 화면을 덮어쓰지 않도록 busy를 ref로도 들고 있는다.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const runIdRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const session = await api.automations.getSession(automationId);
      setMessages(session.messages.filter((message) => message.role !== "system"));
      setChatId(session.chatId ?? null);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, [automationId]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => {
    if (busyRef.current) return;
    void load();
  }, 5_000);

  // 새 메시지/스트리밍 델타마다 하단 고정.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamText, status]);

  useEffect(() => () => unsubRef.current?.(), []);

  // 자동화 실행과 이 대화는 **같은 chat**을 공유한다. 예약 실행이 도는 중에 사용자가 말을
  // 걸면 새 실행을 던질 수 없다(같은 chat 중복 실행 금지). 진행 중이면 그 실행에 재접속해
  // 라이브로 보여주고, 입력은 아래 send()가 이어쓰기(steer)로 큐에 넣는다.
  useEffect(() => {
    if (!chatId) return;
    const api = ipc();
    const events = ipcEvents();
    if (!api || !events) return;
    let cancelled = false;
    void api.invoke.attach(chatId).then((attached) => {
      if (cancelled || !attached || busyRef.current) return;
      runIdRef.current = attached.runId;
      setBusy(true);
      busyRef.current = true;
      setStatus(ko ? "자동화가 실행 중이에요…" : "The automation is running…");
      let accumulated = "";
      unsubRef.current?.();
      unsubRef.current = events.on(api.invoke.eventChannel(attached.runId), (ev: McpInvocationEvent) => {
        if (ev.kind === "partial") {
          accumulated = typeof ev.delta === "string" ? accumulated + ev.delta : ev.text ?? accumulated;
          setStreamText(accumulated);
          return;
        }
        if ((ev.kind === "thinking" || ev.kind === "tool-use") && ev.status) {
          setStatus(ev.status);
          return;
        }
        if (ev.kind === "final" || ev.kind === "error") {
          unsubRef.current?.();
          unsubRef.current = null;
          runIdRef.current = null;
          setBusy(false);
          busyRef.current = false;
          setStatus("");
          setStreamText("");
          void load();
        }
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [chatId, ko, load]);

  const send = useCallback(
    async (text: string) => {
      const api = ipc();
      const events = ipcEvents();
      const prompt = text.trim();
      const targetChatId = chatIdRef.current;
      if (!api || !prompt) return;
      if (!targetChatId) {
        setError(ko ? "세션을 아직 열지 못했습니다. 잠시 뒤 다시 시도해 주세요." : "The session is not open yet. Try again shortly.");
        return;
      }
      const alreadyRunning = busyRef.current;
      setError("");
      setDraft("");
      setBusy(true);
      busyRef.current = true;
      if (!alreadyRunning) setStreamText("");
      setStatus(ko ? "보내는 중…" : "Sending…");
      // 낙관적 사용자 버블 — 실제 기록은 턴 종료 후 load()가 정본으로 덮어쓴다.
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, role: "user", text: prompt, createdAt: new Date().toISOString() },
      ]);

      const runId = crypto.randomUUID();
      runIdRef.current = runId;
      let accumulated = "";

      function finish(nextError?: string) {
        unsubRef.current?.();
        unsubRef.current = null;
        runIdRef.current = null;
        setBusy(false);
        busyRef.current = false;
        setStatus("");
        setStreamText("");
        if (nextError) setError(nextError);
        void load();
      }

      if (events && !alreadyRunning) {
        // subscribe-before-trigger — 런타임이 즉시 내보내는 초기 이벤트도 놓치지 않는다.
        unsubRef.current = events.on(api.invoke.eventChannel(runId), (ev: McpInvocationEvent) => {
          if (ev.kind === "partial") {
            accumulated = typeof ev.delta === "string" ? accumulated + ev.delta : ev.text ?? accumulated;
            setStreamText(accumulated);
            return;
          }
          if (ev.kind === "thinking" || ev.kind === "tool-use") {
            if (ev.status) setStatus(ev.status);
            return;
          }
          if (ev.kind === "final") {
            finish();
            return;
          }
          if (ev.kind === "error") {
            finish(ev.error?.message || (ko ? "응답을 받지 못했습니다." : "No response was returned."));
          }
        });
      }

      const request = {
        runId,
        chatId: targetChatId,
        userPrompt: prompt,
        locale,
        // 예약 실행과 같은 권한으로 — read로 떨어지면 자기 자동화의 스크립트조차 못 돌린다.
        permissions: (executionPermission === "read" ? "read" : "write") as "read" | "write",
        ...(toolMode ? { toolMode } : {}),
        ...(hubMode ? { hubMode } : {}),
      };
      try {
        if (alreadyRunning) {
          // 이미 도는 턴이 있으면 취소하지 않고 뒤에 세운다. 사용자의 말은 버려지지 않는다.
          const steered = await api.invoke.steer(request);
          setStatus(
            steered.queued
              ? ko ? "지금 실행이 끝나면 이어서 보낼게요." : "It will be sent right after the current run."
              : ko ? "이어서 진행 중이에요…" : "Continuing…",
          );
          if (steered.runId) runIdRef.current = steered.runId;
          return;
        }
        await api.invoke.run(request);
      } catch (err) {
        finish(sendFailureMessage(err, ko));
      }
    },
    [executionPermission, hubMode, ko, load, locale, toolMode],
  );

  // RunHistoryPanel의 "대화에서 이어서 해결" 등 외부 요청 수신.
  useEffect(() => {
    function onPrompt(event: Event) {
      const detail = (event as CustomEvent<AutomationSessionPromptDetail>).detail;
      if (!detail || detail.automationId !== automationId) return;
      detail.handled = true;
      if (detail.send) void send(detail.text);
      else setDraft(detail.text);
    }
    window.addEventListener(AUTOMATION_SESSION_PROMPT_EVENT, onPrompt);
    return () => window.removeEventListener(AUTOMATION_SESSION_PROMPT_EVENT, onPrompt);
  }, [automationId, send]);

  // 임베드 모드 — 바깥의 공용 입력이 이 세션의 send를 그대로 쓴다(입력은 화면에 하나).
  useEffect(() => {
    if (!sendHandleRef) return;
    sendHandleRef.current = (text: string) => void send(text);
    return () => { sendHandleRef.current = null; };
  }, [send, sendHandleRef]);

  // 다른 화면(자동화 상세)에서 넘어온 요청을 세션이 열리는 즉시 한 번만 이어받는다.
  useEffect(() => {
    if (!chatId) return;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(pendingKey(automationId));
      if (raw) window.sessionStorage.removeItem(pendingKey(automationId));
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const pending = JSON.parse(raw) as { text?: string; send?: boolean };
      if (!pending.text) return;
      if (pending.send) void send(pending.text);
      else setDraft(pending.text);
    } catch {
      // 깨진 값은 조용히 버린다 — 이미 제거했으므로 반복되지 않는다.
    }
  }, [automationId, chatId, send]);

  function stop() {
    const api = ipc();
    const runId = runIdRef.current;
    if (!api || !runId) return;
    void api.invoke.cancel(runId).catch(() => undefined);
  }

  return (
    <section className="automation-session-panel titlebar-nodrag" data-embedded={embedded ? "true" : undefined}>
      {!embedded ? (
      <header>
        <span>{ko ? "세션 대화" : "Session"}</span>
        <div className="automation-session-head-actions">
          <button type="button" onClick={() => void load()}>
            {ko ? "새로고침" : "Refresh"}
          </button>
          {onCollapse ? (
            <button
              type="button"
              onClick={onCollapse}
              aria-label={ko ? "세션 대화 접기" : "Collapse session"}
              title={ko ? "세션 대화 접기" : "Collapse session"}
            >
              ⟨
            </button>
          ) : null}
        </div>
      </header>
      ) : null}

      <div className="automation-session-stream" ref={scrollRef}>
        {messages.map((message) => {
          // ★내부 질문 프로토콜(<<agentlas-ask>> JSON)이 원문 그대로 보였다(실측 항목 17).
          //   사용자는 시스템 프롬프트가 새는 것으로 읽는다 — 질문은 카드로, 본문은 본문만.
          const parsed = message.role === "assistant"
            ? extractQuestions(message.text, message.id)
            : { text: message.text, questions: [] };
          return (
            <article key={message.id} data-role={message.role}>
              <small>{message.role === "user" ? (ko ? "요청" : "Request") : "Agentlas"}</small>
              {parsed.text.trim() ? <p>{parsed.text}</p> : null}
              {parsed.questions.map((q) => (
                <div key={q.id} className="automation-session-ask">
                  <div>{q.question}</div>
                  <div className="automation-session-ask-options">
                    {q.options.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        title={opt.description}
                        disabled={busy}
                        onClick={() => void send(opt.label)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </article>
          );
        })}
        {busy ? (
          <article data-role="assistant" data-live="true">
            <small>Agentlas</small>
            <p>{(streamText ? extractQuestions(streamText, "live").text : "") || status || (ko ? "생각하는 중…" : "Thinking…")}</p>
          </article>
        ) : null}
        {messages.length === 0 && !busy && !unavailable ? (
          <div className="automation-session-empty">
            {ko
              ? "자동화 실행 기록과 지금 나누는 대화가 이곳에 함께 이어집니다. 무엇이든 물어보세요."
              : "Automation runs and your own turns continue here in one thread. Ask anything."}
          </div>
        ) : null}
        {unavailable ? <div className="automation-session-empty" data-one-content-slot /> : null}
      </div>

      {error ? (
        <div className="automation-session-error" role="alert">
          {error}
        </div>
      ) : null}

      {!embedded ? (
      <div className="automation-session-composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            if (isImeSubmit(e)) return;
            e.preventDefault();
            void send(draft);
          }}
          rows={3}
          disabled={unavailable}
          placeholder={
            ko
              ? "이 자동화에 대해 묻거나, 다음에 할 일을 지시하세요"
              : "Ask about this automation, or tell it what to do next"
          }
        />
        <div className="automation-session-composer-actions">
          <span>{ko ? "Enter 전송 · Shift+Enter 줄바꿈" : "Enter to send · Shift+Enter for a new line"}</span>
          {busy ? (
            <button type="button" onClick={stop} data-variant="stop">
              {ko ? "정지" : "Stop"}
            </button>
          ) : (
            <button type="button" onClick={() => void send(draft)} disabled={!draft.trim() || unavailable}>
              {ko ? "보내기" : "Send"}
            </button>
          )}
        </div>
      </div>
      ) : null}
    </section>
  );
}
