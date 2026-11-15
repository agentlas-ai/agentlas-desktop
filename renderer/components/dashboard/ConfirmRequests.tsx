// 대시보드 "승인 인박스" 모듈 — 에이전트가 챗에서 사용자 결정을 기다리는 항목(메일함 메타포).
// 목록은 attention.ts 가 이미 읽는 것을 함께 쓴다(질문이 열려 있으면 3초, 없으면 신호·33초 안전망) — 이 모듈은 따로 읽지 않는다. 가장 오래 기다린(가장 멈춰 있는) 항목을 위로 정렬해 통제의 대가(stall)를
// 긴급성으로 드러낸다. "답하기"로 해당 채팅에 가서 응답하면 자동 해소된다 — 인라인 응답은 챗에서 이뤄진다
// (단일 상태: 워크스페이스 인라인 게이트와 같은 confirm 소스를 공유).
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { attentionLabel, openAttentionEntry, useAttention, usePendingConfirmationList } from "@/lib/attention";
import { useT } from "@/lib/i18n";
import { openPendingConfirmation } from "@/lib/open-pending-confirmation";
import { loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import type { PendingConfirmation } from "@/lib/types";
import { COPY, pick } from "./dashboard-copy";
import s from "./Dashboard.module.css";

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

  // 목록은 attention.ts 의 읽기를 함께 쓴다: 새 질문은 chat 변경 신호, 답은 `agentlas:attention-refresh`·열린 질문 3초 읽기·
  // 화면 복귀로 그쪽이 다시 읽는다. 여기서 따로 읽는 것은 attention 이 아직 답하지 않았을 때의 첫 한 번과 "다시 시도"뿐이다.
  const shared = usePendingConfirmationList();
  const sharedAtMount = useRef(shared);
  useEffect(() => { if (sharedAtMount.current === null) void load(); }, [load]);
  useEffect(() => {
    if (!shared) return;
    const list = [...shared].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    writeViewData("dashboard.confirm.pending", list);
    setItems(list);
    setError(null);
  }, [shared]);

  // 행마다 그 질문이 있는 정확한 대화로 — 상단 배너와 같은 단일 경로(open-pending-confirmation).
  const openConfirmation = useCallback((item: PendingConfirmation) => openPendingConfirmation(item), []);

  // Everything else that waits for the owner (a tool approval, a runner question, a browser approval) is already held by attention.ts:
  // one row per chat or place, the same entries the old product switcher listed. A chat whose question is shown above is not listed twice.
  const attention = useAttention("/dashboard");
  const questionChats = new Set((items ?? []).map((item) => item.chatId));
  const extra = attention.entries.filter((entry) => entry.approvals > 0 && !(entry.chatId && questionChats.has(entry.chatId)));
  const count = (items?.length ?? 0) + extra.length;

  // Nothing waits (or nothing was read yet): there is no inbox. A read that failed is not "nothing": it says so and offers a retry.
  if (!error && (items === null || count === 0)) return null;

  return (
    <section id="approval-inbox" className={s.card} data-alert={count > 0 ? "true" : "false"} data-tour-id="dashboard.approvals" aria-labelledby="dashboard-inbox-title">
      <div className={s.inboxHead} role="status" aria-live="polite">
        <h2 className={s.h} id="dashboard-inbox-title" style={{ flex: 1 }}>{pick(ko, COPY.approvalInbox)}</h2>
        {count > 0 && <span className={s.count}>{count}</span>}
      </div>
      {error && (
        <div className={s.inboxRow} role="alert">
          <span className={s.inboxCopy}>{pick(ko, COPY.inboxFailed)}</span>
          <button type="button" onClick={() => void load()} className={s.open}>{pick(ko, COPY.retry)}</button>
        </div>
      )}
      {(items ?? []).map((it) => (
        <div key={it.chatId} className={s.inboxRow} data-pending-chat-id={it.chatId}>
          <div className={s.inboxCopy}>
            <div>{it.question}</div>
            <small>
              {confirmationKindLabel(it.question, ko)}
              {it.chatTitle || pick(ko, COPY.chat)}
              {it.optionCount > 0 ? ` · ${it.optionCount}${ko ? "개 선택지" : " options"}` : ""}
              {it.createdAt ? ` · ${stallLabel(it.createdAt, ko)}` : ""}
            </small>
            <span className={s.detail}>
              <span>{pick(ko, COPY.requester)}: {it.requesterLabel} · {pick(ko, COPY.notAuthorized)}</span>
              <span>{pick(ko, COPY.intended)}: {it.header || it.question}</span>
              <span>{pick(ko, COPY.scopeUndeclared)}</span>
              {it.createdAt && (
                <time dateTime={it.createdAt}>
                  {pick(ko, COPY.requested)}: {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(it.createdAt))}
                </time>
              )}
            </span>
          </div>
          <button type="button" onClick={() => void openConfirmation(it)} className={s.open}>{ko ? "답하기" : "Respond"}</button>
        </div>
      ))}
      {extra.map((entry, index) => (
        <div key={`${entry.chatId ?? entry.href ?? "orphan"}:${index}`} className={s.inboxRow} data-pending-entry="true">
          <div className={s.inboxCopy}>
            <div>{entry.label || pick(ko, COPY.chat)}</div>
            <small>{attentionLabel({ approvals: entry.approvals, results: 0 }, ko ? "ko" : "en")}</small>
          </div>
          <button type="button" onClick={() => void openAttentionEntry(entry)} className={s.open}>{pick(ko, COPY.open)}</button>
        </div>
      ))}
    </section>
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
