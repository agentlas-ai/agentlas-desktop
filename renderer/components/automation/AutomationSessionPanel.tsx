"use client";

import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import type { ChatHistoryEntry } from "@/lib/types";

export function AutomationSessionPanel({ automationId, locale }: { automationId: string; locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [messages, setMessages] = useState<ChatHistoryEntry[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const load = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const session = await api.automations.getSession(automationId);
      setMessages(session.messages.filter((message) => message.role !== "system"));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, [automationId]);
  useEffect(() => { void load(); }, [load]);
  useVisibleInterval(() => void load(), 5_000);
  return <section className="automation-session-panel titlebar-nodrag">
    <header><span>{ko ? "세션 대화" : "Session"}</span><button type="button" onClick={() => void load()}>{ko ? "새로고침" : "Refresh"}</button></header>
    <div className="automation-session-stream">
      {messages.map((message) => <article key={message.id} data-role={message.role}><small>{message.role === "user" ? (ko ? "요청" : "Request") : "Agentlas"}</small><p>{message.text}</p></article>)}
      {messages.length === 0 && !unavailable ? <div className="automation-session-empty">{ko ? "자동화를 실행하면 요청과 결과가 이곳에 이어집니다." : "Requests and results will appear here when the automation runs."}</div> : null}
      {unavailable ? <div className="automation-session-empty" data-one-content-slot /> : null}
    </div>
  </section>;
}
