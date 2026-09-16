"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { Automation } from "@/lib/types";
import { IconClose, IconTrash } from "@/components/Icon";
import styles from "./AutomationSchedulePanel.module.css";

/** 이 채팅에서 만들어진(monitor.originChatId) 자동화만 보여준다 — 다른 대화의 스케줄은 섞지 않는다.
 *  다른 방법으로 만든(그래프 빌더) 자동화는 monitor가 없어 여기 뜨지 않는다 — 그건 /automation 전체 목록의 몫이다. */
export function AutomationSchedulePanel({
  open, chatId, locale, onClose,
}: { open: boolean; chatId: string | null; locale: "ko" | "en"; onClose: () => void }) {
  const router = useRouter();
  const ko = locale === "ko";
  const [rows, setRows] = useState<Automation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api || !chatId) { setRows([]); return; }
    try {
      const list = await api.automations.list();
      setRows(list.filter((row) => row.monitor?.originChatId === chatId));
    } catch {
      setError(ko ? "자동화 목록을 불러오지 못했습니다." : "Could not load automations.");
    }
  }, [chatId, ko]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void refresh();
    const off = ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "automation") void refresh();
    });
    return () => { off?.(); };
  }, [open, refresh]);

  if (!open) return null;

  async function toggle(row: Automation) {
    const api = ipc();
    if (!api) return;
    setBusyId(row.id);
    try {
      await api.automations.toggle(row.id, !row.enabled);
      await refresh();
    } catch {
      setError(ko ? "변경하지 못했습니다. 다시 시도해 주세요." : "The change failed. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row: Automation) {
    const message = ko
      ? `'${row.name}' 자동화를 삭제할까요?\n\n이 자동화의 세션 대화도 같이 삭제됩니다.`
      : `Delete '${row.name}'?\n\nThis also deletes its session transcript.`;
    if (!confirm(message)) return;
    const api = ipc();
    if (!api) return;
    setBusyId(row.id);
    try {
      await api.automations.remove(row.id);
      await refresh();
    } catch {
      setError(ko ? "자동화를 삭제하지 못했습니다." : "Automation was not deleted.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside className={styles.panel} role="dialog" aria-label={ko ? "자동화 스케줄" : "Automation schedules"}>
      <div className={styles.header}>
        <strong>{ko ? "자동화 스케줄" : "Automation schedules"}</strong>
        <button type="button" onClick={onClose} aria-label={ko ? "닫기" : "Close"}><IconClose size={16} /></button>
      </div>
      <div className={styles.list}>
        {rows.length === 0 && !error && (
          <p className={styles.empty}>{ko ? "이 대화에서 만들어진 자동화가 없습니다." : "No automations were created from this conversation."}</p>
        )}
        {rows.map((row) => {
          const nextRun = row.enabled && row.nextRunAt
            ? new Date(row.nextRunAt).toLocaleString(ko ? "ko-KR" : "en-US", { timeZone: row.timezone || undefined })
            : null;
          return (
            <div key={row.id} className={styles.row} data-automation-id={row.id}>
              <div className={styles.rowTop}>
                <strong>{row.name}</strong>
                <span className={styles.status} data-enabled={row.enabled ? "true" : "false"}>
                  {row.enabled ? (ko ? "실행 중" : "Active") : (ko ? "중지됨" : "Stopped")}
                </span>
              </div>
              <p className={styles.meta}>{nextRun ? (ko ? `다음 실행: ${nextRun}` : `Next run: ${nextRun}`) : row.scheduleHuman}</p>
              <div className={styles.actions}>
                <button type="button" disabled={busyId === row.id} onClick={() => void toggle(row)}>
                  {row.enabled ? (ko ? "중지" : "Stop") : (ko ? "다시 켜기" : "Enable")}
                </button>
                <button type="button" disabled={busyId === row.id} onClick={() => router.push(`/automation/flow?id=${encodeURIComponent(row.id)}`)}>
                  {ko ? "편집" : "Edit"}
                </button>
                <button
                  type="button"
                  className={styles.danger}
                  disabled={busyId === row.id}
                  onClick={() => void remove(row)}
                  aria-label={ko ? "삭제" : "Delete"}
                ><IconTrash size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className={styles.error} role="status">{error}</p>}
    </aside>
  );
}
