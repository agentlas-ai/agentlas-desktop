// 대시보드 "확인 요청" 모듈 — 에이전트가 챗에서 사용자 결정을 기다리는 항목.
// confirm.listPending() 폴링. "열기"로 해당 채팅으로 점프해 답하면(후속 user 메시지) 자동 해소.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { PendingConfirmation } from "@/lib/types";

const POLL_MS = 10_000;

export function ConfirmRequests() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [items, setItems] = useState<PendingConfirmation[] | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setItems([]);
      return;
    }
    try {
      setItems(await api.confirm.listPending());
    } catch {
      // 다음 폴링 재시도
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  const count = items?.length ?? 0;

  return (
    <div style={{ background: "var(--paper-2)", border: "1px solid var(--paper-edge)", borderRadius: 12, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "9px 13px",
          background: count > 0 ? "var(--amber-soft, var(--fill-1))" : "var(--fill-1)",
          borderBottom: "1px solid var(--paper-edge)",
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)", flex: 1 }}>
          {ko ? "확인 요청" : "Confirmations"}
        </span>
        {count > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--amber-deep, var(--accent))", background: "var(--paper-2)", padding: "1px 8px", borderRadius: 8 }}>
            {count}
          </span>
        )}
      </div>

      {items === null ? (
        <div style={{ padding: "14px 13px", fontSize: 12, color: "var(--muted-deep)" }}>{ko ? "불러오는 중…" : "Loading…"}</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "14px 13px", fontSize: 12, color: "var(--muted-deep)" }}>
          {ko ? "기다리는 확인이 없어요." : "Nothing waiting on you."}
        </div>
      ) : (
        items.map((it) => (
          <div key={it.chatId} style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "9px 13px", borderTop: "1px solid var(--paper-edge)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {it.question}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--muted-deep)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {it.chatTitle || (ko ? "채팅" : "Chat")}
                {it.optionCount > 0 ? ` · ${it.optionCount}${ko ? "개 선택지" : " options"}` : ""}
              </div>
            </div>
            <button
              onClick={() => navigate(`/chat?id=${it.chatId}`)}
              className="titlebar-nodrag"
              style={{ fontSize: 11.5, padding: "4px 11px", borderRadius: 8, border: "1px solid var(--accent)", color: "var(--accent)", background: "transparent", cursor: "pointer", flexShrink: 0 }}
            >
              {ko ? "열기" : "Open"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
