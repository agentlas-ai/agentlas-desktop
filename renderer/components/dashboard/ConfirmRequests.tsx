// 대시보드 "승인 인박스" 모듈 — 에이전트가 챗에서 사용자 결정을 기다리는 항목(메일함 메타포).
// confirm.listPending() 폴링. 가장 오래 기다린(가장 멈춰 있는) 항목을 위로 정렬해 통제의 대가(stall)를
// 긴급성으로 드러낸다. "답하기"로 해당 채팅에 가서 응답하면 자동 해소된다 — 인라인 응답은 챗에서 이뤄진다
// (단일 상태: 워크스페이스 인라인 게이트와 같은 confirm 소스를 공유).
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { PendingConfirmation } from "@/lib/types";

const POLL_MS = 10_000;

function stallLabel(iso: string, ko: boolean): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = (Date.now() - t) / 60_000;
  if (mins < 1) return ko ? "방금" : "just now";
  if (mins < 60) return ko ? `${Math.round(mins)}분째 대기` : `waiting ${Math.round(mins)}m`;
  const hrs = mins / 60;
  if (hrs < 24) return ko ? `${hrs.toFixed(1)}시간째 멈춤` : `stalled ${hrs.toFixed(1)}h`;
  return ko ? `${Math.round(hrs / 24)}일째 멈춤` : `stalled ${Math.round(hrs / 24)}d`;
}

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
      const list = await api.confirm.listPending();
      // 가장 오래 기다린 항목(가장 멈춰 있는 것)이 위로 — 긴급성 정렬.
      list.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      setItems(list);
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
    <div id="approval-inbox" className="dashboard-module" data-alert={count > 0 ? "true" : "false"}>
      <div
        className="dashboard-module-head"
        data-alert={count > 0 ? "true" : "false"}
        role="status"
        aria-live="polite"
      >
        <span>{ko ? "승인 인박스" : "Approval inbox"}</span>
        {count > 0 && <span className="dashboard-count-pill">{count}</span>}
      </div>

      {items === null ? (
        <div className="dashboard-module-empty">{ko ? "불러오는 중…" : "Loading…"}</div>
      ) : items.length === 0 ? (
        <div className="dashboard-module-empty">
          {ko ? "기다리는 승인이 없어요 — 멈춰 있는 에이전트 없음." : "Nothing waiting — no stalled workers."}
        </div>
      ) : (
        items.map((it) => (
          <div key={it.chatId} className="dashboard-module-row">
            <div className="dashboard-row-copy">
              <div>{it.question}</div>
              <div>
                {it.chatTitle || (ko ? "채팅" : "Chat")}
                {it.optionCount > 0 ? ` · ${it.optionCount}${ko ? "개 선택지" : " options"}` : ""}
                {it.createdAt ? ` · ${stallLabel(it.createdAt, ko)}` : ""}
              </div>
            </div>
            <button
              onClick={() => navigate(`/chat?id=${it.chatId}`)}
              className="titlebar-nodrag"
              data-dashboard-action="true"
            >
              {ko ? "답하기" : "Respond"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
