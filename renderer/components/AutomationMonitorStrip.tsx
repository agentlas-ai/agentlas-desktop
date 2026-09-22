"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { Automation, ChatGoalContext } from "@/lib/types";
import { enabledScheduleWithoutNextRun } from "@/lib/automation-schedule-state";
import styles from "./AutomationMonitorStrip.module.css";

/** A projection of existing durable automations. Opening this UI never runs one. */
export function AutomationMonitorStrip({ chatId, locale }: { chatId: string | null; locale: "ko" | "en" }) {
  return <><GoalWaitMonitor chatId={chatId} locale={locale} /><AutomationMonitorRows chatId={chatId} locale={locale} /></>;
}

function GoalWaitMonitor({ chatId, locale }: { chatId: string | null; locale: "ko" | "en" }) {
  const [context,setContext]=useState<ChatGoalContext|null>(null);
  const [error,setError]=useState<string|null>(null);
  const ko=locale==="ko";
  useEffect(()=>{
    let disposed=false,version=0;
    setContext(null);setError(null);
    const read=async()=>{
      const next=++version;
      const api=ipc();
      if(chatId && !api)throw new Error("Desktop bridge unavailable");
      const value=chatId ? await api?.chats.getGoalContext(chatId) : null;
      if(!disposed && next===version){setContext(value??null);setError(null);}
    };
    void read().catch(()=>{if(!disposed)setError(ko?"작업 대기 상태를 불러오지 못했습니다.":"Wait status is unavailable.");});
    const off=ipcEvents()?.onStoreChanged?.(change=>{if(change.entity==="long-run" || (change.entity==="chat" && change.id===chatId))void read().catch(()=>undefined);});
    return()=>{disposed=true;off?.();};
  },[chatId,ko]);
  const wait=context?.wait;
  if(!wait || wait.state==="cancelled" || wait.state==="dispatched")return error
    ? <p className={styles.error} role="status">{error}</p> : null;
  const active=context.runStatus==="waiting_tool" && wait.state==="pending";
  const status=active?(wait.subjectKind==="timer"?(ko?"다음 목표 주기 예약됨":"Next goal cycle scheduled"):(ko?"결과 기다리는 중":"Waiting for a result"))
    :context.runStatus==="paused"?(ko?"대기 일시정지":"Wait paused")
    :wait.state==="expired"?(ko?"대기 시간 종료":"Wait deadline reached"):(ko?"작업 확인 필요":"Work needs attention");
  return <details className={styles.root} data-goal-wait={wait.waitId}>
    <summary><span className={styles.dot} data-active={active}/>{status}</summary>
    <div className={styles.list}>
      <p>{ko?"앱 실행 중 변화를 확인하고, 결과가 도착하면 같은 작업을 이어갑니다.":"Checks while the app is running and continues the same task when the result arrives."}</p>
      <div className={styles.row}><div><strong>{wait.subjectKind==="timer"?(ko?"다음 목표 주기":"Next goal cycle"):wait.subjectKind==="artifact"?(ko?"산출물 변경":"Artifact change"):(ko?"진행 중인 작업 결과":"Running task result")}</strong>
        {active && wait.nextCheckAt && <span>{ko?"다음 확인: ":"Next check: "}{new Date(wait.nextCheckAt).toLocaleTimeString(locale)}</span>}
        {wait.deadline && <span>{ko?"기다리는 기한: ":"Deadline: "}{new Date(wait.deadline).toLocaleString(locale)}</span>}
      </div>{active && <button type="button" onClick={()=>{
        if(!chatId || !context)return;
        void ipc()?.chats.pauseGoal(chatId,context.goalId).then(value=>setContext(value)).catch(()=>setError(ko?"중지하지 못했습니다. 다시 시도해 주세요.":"Could not stop. Try again."));
      }}>{ko?"중지":"Stop"}</button>}</div>
      {error && <p role="status">{error}</p>}
    </div>
  </details>;
}

function AutomationMonitorRows({ chatId, locale }: { chatId: string | null; locale: "ko" | "en" }) {
  const [records, setRecords] = useState<Automation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastObservedAt, setLastObservedAt] = useState<string | null>(null);
  const ko = locale === "ko";
  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api || !chatId) return;
    const rows = await api.automations.list();
    setRecords(rows.filter((row) => row.monitor?.originChatId === chatId));
    setLastObservedAt(new Date().toISOString());
    setError(null);
  }, [chatId]);
  useEffect(() => {
    let disposed = false;
    setRecords([]); setError(null); setLastObservedAt(null);
    const read = async () => {
      const api = ipc();
      if (chatId && !api) throw new Error("Desktop bridge unavailable");
      const rows = await api?.automations.list();
      if (!disposed) {
        // Notification policy controls alerts, not whether a registered job
        // is visible. In particular, every_run jobs can continue while the
        // Goal in the same chat is blocked and must not disappear from One.
        setRecords((rows ?? []).filter((row) => row.monitor?.originChatId === chatId));
        setLastObservedAt(new Date().toISOString());
        setError(null);
      }
    };
    void read().catch(() => { if (!disposed) setError(ko ? "확인 상태를 불러오지 못했습니다." : "Monitor status is unavailable."); });
    const off = ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "automation") void read().catch(() => {
        if (!disposed) setError(ko ? "예약 상태를 다시 확인하지 못했습니다." : "Could not refresh schedule status.");
      });
    });
    return () => { disposed = true; off?.(); };
  }, [chatId, ko]);
  const scoped = records.filter((row) => row.monitor?.originChatId === chatId);
  if (!scoped.length) return error ? <p className={styles.error} role="status">{error}</p> : null;
  const active = scoped.filter((row) => {
    const status = row.trigger?.kind === "poll" ? row.trigger.pollState?.status : undefined;
    return row.enabled && !enabledScheduleWithoutNextRun(row) && (!status || status === "pending");
  }).length;
  const noNextRun = scoped.filter(enabledScheduleWithoutNextRun).length;
  const upcoming = scoped.filter((row) => row.enabled && row.nextRunAt && Number.isFinite(Date.parse(row.nextRunAt)))
    .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0];
  const independent = scoped.every((row) => !row.goalId);
  return <details className={styles.root} data-automation-monitor="true" data-no-next-run={noNextRun}>
    <summary><span className={styles.dot} data-active={active > 0} />
      {error ? (ko ? "예약 상태 다시 확인 중" : "Rechecking schedule")
        : ko ? `${independent ? "목표와 별도 예약" : "예약 자동화"} ${active}개` : `${active} ${independent ? "separate schedules" : "scheduled automations"}`}
      {noNextRun > 0 && !error && <span className={styles.nextTime}>{ko ? `다음 예약 없음 ${noNextRun}개` : `${noNextRun} without a next run`}</span>}
      {upcoming && !error && <span className={styles.nextTime}>{ko ? "다음 예정 " : "Next expected "}{new Date(upcoming.nextRunAt!).toLocaleString(ko ? "ko-KR" : "en-US", { timeZone: upcoming.timezone || undefined, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
    </summary>
    <div className={styles.list}>
      <p>{ko ? "이 예약은 위 Goal의 실행 상태와 별도로 표시됩니다. 앱 실행 중 예정 시각을 확인합니다." : "These schedules are shown separately from the Goal above. Due times are checked while the app is running."}</p>
      {scoped.map((row) => {
        const poll = row.trigger?.kind === "poll" ? row.trigger.pollState : undefined;
        const missingNextRun = enabledScheduleWithoutNextRun(row);
        const status = !row.enabled ? (ko ? "중지됨" : "Stopped") : missingNextRun ? (ko ? "다음 예약 없음 · 실행 내역 확인" : "No next run · check history") : poll?.status === "timed_out" ? (ko ? "확인 기간 종료" : "Deadline reached")
          : poll?.status === "satisfied" ? (ko ? "확인 완료" : "Check completed")
          : poll?.status === "blocked" ? (ko ? "확인 필요" : "Needs attention") : (ko ? "확인 대기" : "Waiting");
        return <div key={row.id} className={styles.row} data-automation-id={row.id} data-goal-link={row.goalId ? "goal-linked" : "independent"}>
          <div><strong>{row.name}</strong>
            <span>{row.goalId ? (ko ? "Goal ID 지정 · 연결 검증 전" : "Goal ID declared · link unverified") : (ko ? "이 Goal과 별도 예약" : "Separate from this Goal")}</span>
            <span>{status}{row.enabled && (!poll || poll.status === "pending") && row.nextRunAt && ` · ${ko ? "다음 예정" : "Next expected"} ${new Date(row.nextRunAt).toLocaleString(ko ? "ko-KR" : "en-US", { timeZone: row.timezone || undefined })}`}</span>
            {row.lastRunAt && <span>{ko ? "최근 시작" : "Last started"} · {new Date(row.lastRunAt).toLocaleString(ko ? "ko-KR" : "en-US", { timeZone: row.timezone || undefined })}</span>}
            {row.runtimeSelection?.model && <span>{ko ? "이 예약의 모델" : "Schedule model"} · {row.runtimeSelection.model}</span>}
            {missingNextRun && <Link href={`/automation/flow?id=${encodeURIComponent(row.id)}`}>{ko ? "실행 내역 열기" : "Open run history"}</Link>}
          </div>
          <button type="button" onClick={() => {
            const api = ipc(); if (!api) return;
            void api.automations.toggle(row.id, !row.enabled).then(refresh).catch(() => setError(ko ? "변경하지 못했습니다. 다시 시도해 주세요." : "The change failed. Try again."));
          }}>{row.enabled ? (ko ? "중지" : "Stop") : (ko ? "다시 켜기" : "Enable")}</button>
        </div>;
      })}
      {error && <p role="status">{error}{lastObservedAt && ` · ${ko ? "마지막 확인" : "Last confirmed"} ${new Date(lastObservedAt).toLocaleTimeString(ko ? "ko-KR" : "en-US")}`}</p>}
    </div>
  </details>;
}
