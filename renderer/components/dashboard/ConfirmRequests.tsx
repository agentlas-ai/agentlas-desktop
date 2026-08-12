// 대시보드 "승인 인박스" 모듈 — 에이전트가 챗에서 사용자 결정을 기다리는 항목(메일함 메타포).
// confirm.listPending() 폴링. 가장 오래 기다린(가장 멈춰 있는) 항목을 위로 정렬해 통제의 대가(stall)를
// 긴급성으로 드러낸다. "답하기"로 해당 채팅에 가서 응답하면 자동 해소된다 — 인라인 응답은 챗에서 이뤄진다
// (단일 상태: 워크스페이스 인라인 게이트와 같은 confirm 소스를 공유).
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { loadViewData, readViewData } from "@/lib/view-data-cache";
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
  const [items, setItems] = useState<PendingConfirmation[] | null>(() => (
    readViewData<PendingConfirmation[]>("dashboard.confirm.pending")?.value ?? null
  ));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    const api = ipc();
    if (!api) {
      setItems([]);
      return;
    }
    try {
      const list = await loadViewData(
        "dashboard.confirm.pending",
        () => api.confirm.listPending(),
        { maxAgeMs: 10_000, force },
      );
      // 가장 오래 기다린 항목(가장 멈춰 있는 것)이 위로 — 긴급성 정렬.
      list.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
      setItems(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setItems((cur) => cur ?? []);
    }
  }, []);

  // 초기 1회 load는 유지, 주기 폴링(10s)은 탭 보일 때만 — useVisibleInterval이 hidden 시 정지.
  // 답변 확정 직후에는 폴링을 기다리지 않고 즉시 목록을 갱신한다(AppShell 배지와 동일 신호).
  useEffect(() => {
    void load();
    const refresh = () => void load(true);
    window.addEventListener("agentlas:attention-refresh", refresh);
    return () => window.removeEventListener("agentlas:attention-refresh", refresh);
  }, [load]);
  useVisibleInterval(() => void load(true), POLL_MS);

  const openConfirmation = useCallback(async (item: PendingConfirmation) => {
    const api = ipc();
    if (!api) return;
    const chat = await api.chats.get(item.chatId).catch(() => null);
    if (chat?.originSurface === "one") {
      const task = await api.tasks.findForChat(item.chatId).catch(() => null);
      navigate(task
        ? `/one?task=${encodeURIComponent(task.id)}`
        : `/one?chat=${encodeURIComponent(item.chatId)}`);
      return;
    }
    navigate(`/workspace/task?id=${encodeURIComponent(item.chatId)}`);
  }, []);

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
      ) : error ? (
        <div className="dashboard-module-empty" style={{ display: "grid", gap: 8 }}>
          <span>
            {ko ? "승인 목록을 불러오지 못했습니다." : "Could not load approval requests."}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="titlebar-nodrag"
            data-dashboard-action="true"
            style={{ justifySelf: "start" }}
          >
            {ko ? "다시 시도" : "Retry"}
          </button>
        </div>
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
                {confirmationKindLabel(it.question, ko)}
                {it.chatTitle || (ko ? "채팅" : "Chat")}
                {it.optionCount > 0 ? ` · ${it.optionCount}${ko ? "개 선택지" : " options"}` : ""}
                {it.createdAt ? ` · ${stallLabel(it.createdAt, ko)}` : ""}
              </div>
              <div style={{ display: "grid", gap: 2, marginTop: 6, fontSize: 11 }}>
                <span>
                  {ko ? "요청자" : "Requester"}: {it.requesterLabel}
                  {" · "}
                  {ko ? "권한 상태: 아직 승인되지 않음" : "Authority: not authorized yet"}
                </span>
                <span>
                  {ko ? "예정 작업" : "Intended action"}: {it.header || it.question}
                </span>
                <span>
                  {ko
                    ? "데이터 범위와 크레딧 영향은 요청에 명시되지 않았습니다. 선택 전에 채팅에서 확인하세요."
                    : "Data scope and credit impact were not declared. Review the chat before choosing."}
                </span>
                {it.createdAt && (
                  <time dateTime={it.createdAt}>
                    {ko ? "요청 시각" : "Requested"}: {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(it.createdAt))}
                  </time>
                )}
              </div>
            </div>
            <button
              onClick={() => void openConfirmation(it)}
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

function confirmationKindLabel(question: string, ko: boolean): string {
  const q = question.toLowerCase();
  if (/\bfull\b|전체 권한|permission/.test(q)) return ko ? "전체 권한 확인 · " : "Full permission · ";
  if (/payment|checkout|결제|카드|구독/.test(q)) return ko ? "결제 확인 · " : "Payment · ";
  if (/credential|api key|token|비밀|키|토큰/.test(q)) return ko ? "키/계정 확인 · " : "Credential · ";
  if (/browser|oauth|login|로그인|브라우저/.test(q)) return ko ? "브라우저/로그인 · " : "Browser/login · ";
  if (/file|write|폴더|파일|쓰기|저장/.test(q)) return ko ? "파일 작업 · " : "File action · ";
  return ko ? "선택 대기 · " : "Waiting · ";
}
