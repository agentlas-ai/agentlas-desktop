"use client";

import { useCallback, useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { Automation } from "@/lib/types";
import styles from "./AutomationMonitorStrip.module.css";

/** A projection of existing durable automations. Opening this UI never runs one. */
export function AutomationMonitorStrip({ chatId, locale }: { chatId: string | null; locale: "ko" | "en" }) {
  const [records, setRecords] = useState<Automation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ko = locale === "ko";
  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api || !chatId) return;
    const rows = await api.automations.list();
    setRecords(rows.filter((row) => row.monitor?.originChatId === chatId
      && row.monitor.notificationPolicy === "meaningful_changes"));
  }, [chatId]);
  useEffect(() => {
    let disposed = false;
    setRecords([]); setError(null);
    const read = async () => {
      const rows = await ipc()?.automations.list();
      if (!disposed) setRecords((rows ?? []).filter((row) => row.monitor?.originChatId === chatId
        && row.monitor.notificationPolicy === "meaningful_changes"));
    };
    void read().catch(() => { if (!disposed) setError(ko ? "확인 상태를 불러오지 못했습니다." : "Monitor status is unavailable."); });
    const off = ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "automation") void read().catch(() => undefined);
    });
    return () => { disposed = true; off?.(); };
  }, [chatId, ko]);
  const scoped = records.filter((row) => row.monitor?.originChatId === chatId);
  if (!scoped.length) return error ? <p className={styles.error} role="status">{error}</p> : null;
  const active = scoped.filter((row) => {
    const status = row.trigger?.kind === "poll" ? row.trigger.pollState?.status : undefined;
    return row.enabled && (!status || status === "pending");
  }).length;
  return <details className={styles.root} data-automation-monitor="true">
    <summary><span className={styles.dot} data-active={active > 0} />{ko ? `자동 확인 ${active}개` : `${active} monitors active`}</summary>
    <div className={styles.list}>
      <p>{ko ? "앱 실행 중 확인하며, 결과가 바뀌거나 확인이 필요할 때 알려드립니다." : "Checks while the app is running. Notifications appear for changes or required attention."}</p>
      {scoped.map((row) => {
        const poll = row.trigger?.kind === "poll" ? row.trigger.pollState : undefined;
        const status = !row.enabled ? (ko ? "중지됨" : "Stopped") : poll?.status === "timed_out" ? (ko ? "확인 기간 종료" : "Deadline reached")
          : poll?.status === "satisfied" ? (ko ? "확인 완료" : "Check completed")
          : poll?.status === "blocked" ? (ko ? "확인 필요" : "Needs attention") : (ko ? "확인 대기" : "Waiting");
        return <div key={row.id} className={styles.row} data-automation-id={row.id}>
          <div><strong>{row.name}</strong><span>{status}{row.enabled && (!poll || poll.status === "pending") && row.nextRunAt && ` · ${new Date(row.nextRunAt).toLocaleString(ko ? "ko-KR" : "en-US", { timeZone: row.timezone || undefined })}`}</span></div>
          <button type="button" onClick={() => {
            const api = ipc(); if (!api) return;
            void api.automations.toggle(row.id, !row.enabled).then(refresh).catch(() => setError(ko ? "변경하지 못했습니다. 다시 시도해 주세요." : "The change failed. Try again."));
          }}>{row.enabled ? (ko ? "중지" : "Stop") : (ko ? "다시 켜기" : "Enable")}</button>
        </div>;
      })}
      {error && <p role="status">{error}</p>}
    </div>
  </details>;
}
