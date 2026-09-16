"use client";

// One 이 대화에서 만든 자동화만 모아 보는 표.
// 캔버스에서 만든 그래프와 섞지 않는 기준은 monitor.originChatId 유무다 — 이 값이
// 있어야 "어느 대화에 붙어 있나"를 말할 수 있으므로, 탭 구분자와 표의 열이 같은
// 사실을 쓴다(둘이 어긋날 수 없다).
import { useEffect, useState } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { humanSchedule } from "@shared/graph-blueprint";
import type { Automation, AutomationRunRecord } from "@/lib/types";
import { IconTrash } from "@/components/Icon";

type LastRun = { ranAt: string; status: AutomationRunRecord["status"] } | null;

/** 저장된 job 의 "지금 상태" 한 줄. enabled 는 예약이 살아있다는 뜻일 뿐
 *  지금 돌고 있다는 뜻이 아니므로 "실행 중"이라고 쓰지 않는다. */
function lastRunLabel(run: LastRun, ko: boolean): string {
  if (!run) return ko ? "아직 실행 없음" : "no run yet";
  const when = new Date(run.ranAt).toLocaleString(ko ? "ko-KR" : "en-US", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const outcome = run.status === "ok"
    ? (ko ? "성공" : "ok")
    : run.status === "error"
      ? (ko ? "실패" : "failed")
      : run.status;
  return `${when} ${outcome}`;
}

function nextRunLabel(a: Automation, ko: boolean): string {
  if (!a.enabled) return ko ? "정지됨" : "paused";
  if (!a.nextRunAt) return "—";
  return new Date(a.nextRunAt).toLocaleString(ko ? "ko-KR" : "en-US", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    ...(a.timezone ? { timeZone: a.timezone } : {}),
  });
}

export function OneAutomationTable({
  items, locale, onToggle, onRemove,
}: {
  items: Automation[];
  locale: string;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const ko = locale !== "en";
  const [chatTitles, setChatTitles] = useState<Record<string, string>>({});
  const [lastRuns, setLastRuns] = useState<Record<string, LastRun>>({});

  const chatIds = items.map((a) => a.monitor?.originChatId).filter((id): id is string => !!id).join(",");
  const automationIds = items.map((a) => a.id).join(",");

  useEffect(() => {
    let disposed = false;
    const api = ipc();
    if (!api) return;
    const ids = chatIds ? chatIds.split(",") : [];
    void Promise.all(ids.map((id) => api.chats.get(id).catch(() => null)))
      .then((chats) => {
        if (disposed) return;
        const next: Record<string, string> = {};
        chats.forEach((chat, index) => { if (chat?.title) next[ids[index]] = chat.title; });
        setChatTitles(next);
      });
    return () => { disposed = true; };
  }, [chatIds]);

  useEffect(() => {
    let disposed = false;
    const api = ipc();
    if (!api) return;
    const ids = automationIds ? automationIds.split(",") : [];
    void Promise.all(ids.map((id) => api.automations.listRuns(id, 1).catch(() => [])))
      .then((runs) => {
        if (disposed) return;
        const next: Record<string, LastRun> = {};
        runs.forEach((rows, index) => {
          const row = rows?.[0];
          next[ids[index]] = row?.ranAt ? { ranAt: row.ranAt, status: row.status } : null;
        });
        setLastRuns(next);
      });
    return () => { disposed = true; };
  }, [automationIds]);

  if (items.length === 0) {
    return <div style={{ padding: 32, textAlign: "center", color: "var(--muted-deep)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)" }}>
      {ko ? "One 과의 대화에서 만들어진 자동화가 아직 없습니다." : "No automations have been created from a conversation with One yet."}
    </div>;
  }

  const cell: React.CSSProperties = { padding: "10px 12px", fontSize: 12, textAlign: "left", verticalAlign: "middle" };
  const head: React.CSSProperties = { ...cell, fontSize: 11, fontWeight: 650, color: "var(--muted-deep)", borderBottom: "1px solid var(--paper-edge)", whiteSpace: "nowrap" };

  return (
    <div style={{ border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper)", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }} data-one-automation-table>
        <thead>
          <tr>
            <th style={head}>{ko ? "이름" : "Name"}</th>
            <th style={head}>{ko ? "붙어있는 대화" : "Conversation"}</th>
            <th style={head}>{ko ? "주기" : "Cadence"}</th>
            <th style={head}>{ko ? "마지막 실행" : "Last run"}</th>
            <th style={head}>{ko ? "다음" : "Next"}</th>
            <th style={{ ...head, textAlign: "right" }} aria-label={ko ? "동작" : "Actions"} />
          </tr>
        </thead>
        <tbody>
          {items.map((a) => {
            const chatId = a.monitor?.originChatId ?? null;
            const run = lastRuns[a.id] ?? null;
            return (
              <tr key={a.id} data-automation-id={a.id} style={{ borderTop: "1px solid var(--paper-3)" }}>
                <td style={{ ...cell, fontWeight: 600, color: "var(--ink)", maxWidth: 260 }}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.name}>{a.name}</span>
                </td>
                <td style={cell}>
                  {chatId
                    ? <Link href={`/one?chat=${encodeURIComponent(chatId)}`} className="titlebar-nodrag" style={{ color: "var(--accent)", textDecoration: "none" }}>
                        {chatTitles[chatId] ?? (ko ? "대화 열기" : "Open chat")} ↗
                      </Link>
                    : "—"}
                </td>
                <td style={{ ...cell, color: "var(--muted-deep)" }}>{humanSchedule(a.scheduleHuman, ko ? "ko" : "en")}</td>
                <td style={{ ...cell, color: run?.status === "error" ? "#c0392b" : "var(--muted-deep)" }}>{lastRunLabel(run, ko)}</td>
                <td style={{ ...cell, color: "var(--muted-deep)" }}>{nextRunLabel(a, ko)}</td>
                <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    onClick={() => onToggle(a.id, !a.enabled)}
                    style={{ marginRight: 6, padding: "4px 10px", fontSize: 11, borderRadius: 7, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", cursor: "pointer" }}
                  >{a.enabled ? (ko ? "정지" : "Pause") : (ko ? "다시 켜기" : "Resume")}</button>
                  <button
                    type="button"
                    onClick={() => onRemove(a.id)}
                    aria-label={ko ? "삭제" : "Delete"}
                    style={{ padding: "4px 8px", borderRadius: 7, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink-soft)", cursor: "pointer" }}
                  ><IconTrash size={13} /></button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
