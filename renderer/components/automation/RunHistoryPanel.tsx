"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import type { Automation, AutomationRunRecord, WorkflowRunSnapshot, WorkflowNodeRunState } from "@/lib/types";

interface RunHistoryPanelProps {
  automation: Automation;
  locale: "ko" | "en";
  compact?: boolean;
}

const POLL_MS = 5_000;

export function RunHistoryPanel({ automation, locale, compact = false }: RunHistoryPanelProps) {
  const ko = locale === "ko";
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [latest, setLatest] = useState<WorkflowRunSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const [history, snap] = await Promise.all([
        api.automations.listRuns(automation.id, compact ? 5 : 12),
        api.automations.latestRun(automation.id),
      ]);
      setRuns(history);
      setLatest(snap);
      setMessage("");
    } catch (err) {
      setMessage(ko ? `실행 기록을 불러오지 못했습니다. ${String(err)}` : `Could not load run history. ${String(err)}`);
    }
  }, [automation.id, compact, ko]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => void load(), POLL_MS);

  const current = useMemo(() => summarizeSnapshot(latest, ko), [latest, ko]);

  async function openResultChat() {
    const api = ipc();
    if (!api || opening) return;
    setOpening(true);
    try {
      const chat = await api.automations.getSession(automation.id);
      navigate(`/chat?id=${encodeURIComponent(chat.id)}`);
    } catch (err) {
      setMessage(ko ? `결과 대화를 열지 못했습니다. ${String(err)}` : `Could not open the result chat. ${String(err)}`);
    } finally {
      setOpening(false);
    }
  }

  return (
    <section className="automation-run-panel titlebar-nodrag" data-compact={compact ? "true" : "false"}>
      <div className="automation-run-head">
        <div>
          <div className="automation-run-kicker">{ko ? "실행 상태" : "Run status"}</div>
          <strong>{current.title}</strong>
        </div>
        <button type="button" onClick={() => void openResultChat()} disabled={opening}>
          {opening ? (ko ? "여는 중..." : "Opening...") : ko ? "결과 대화" : "Result chat"}
        </button>
      </div>

      {latest ? (
        <div className="automation-run-snapshot" data-status={latest.status}>
          <span>{formatDateTime(latest.startedAt, ko)}</span>
          <span>{current.detail}</span>
        </div>
      ) : (
        <div className="automation-run-empty">{ko ? "아직 노드 실행 스냅샷이 없습니다." : "No node snapshot yet."}</div>
      )}

      {latest?.nodeStates && Object.keys(latest.nodeStates).length > 0 ? (
        <div className="automation-node-state-list">
          {Object.entries(latest.nodeStates).map(([nodeId, state]) => (
            <span key={nodeId} data-state={state}>
              <i aria-hidden="true" />
              {nodeId}
            </span>
          ))}
        </div>
      ) : null}

      <div className="automation-run-list">
        {runs.length === 0 ? (
          <div className="automation-run-empty">{ko ? "실행 기록이 없습니다." : "No runs yet."}</div>
        ) : (
          runs.map((run) => (
            <article key={run.id} className="automation-run-row" data-status={run.status}>
              <div>
                <strong>{statusLabel(run.status, ko)}</strong>
                <span>{formatDateTime(run.ranAt, ko)}</span>
              </div>
              {run.error ? <p>{run.error}</p> : run.skippedCount > 0 ? <p>{ko ? `${run.skippedCount}회 놓친 실행 병합` : `${run.skippedCount} missed runs coalesced`}</p> : null}
            </article>
          ))
        )}
      </div>

      {message ? <div className="automation-run-message">{message}</div> : null}
    </section>
  );
}

function summarizeSnapshot(snap: WorkflowRunSnapshot | null, ko: boolean): { title: string; detail: string } {
  if (!snap) return { title: ko ? "대기 중" : "Idle", detail: ko ? "아직 실행 정보 없음" : "No run data yet" };
  const states = Object.values(snap.nodeStates ?? {});
  const running = states.filter((state) => state === "running").length;
  const failed = states.filter((state) => state === "failed").length;
  const done = states.filter((state) => state === "done").length;
  const skipped = states.filter((state) => state === "skipped").length;
  if (snap.status === "running" || running > 0) {
    return { title: ko ? "실행 중" : "Running", detail: ko ? `${running}개 노드 실행 중` : `${running} nodes running` };
  }
  if (snap.status === "error" || failed > 0) {
    return { title: ko ? "실패" : "Failed", detail: ko ? `${failed}개 실패 · ${done}개 완료` : `${failed} failed · ${done} done` };
  }
  return {
    title: ko ? "완료" : "Complete",
    detail: ko ? `${done}개 완료 · ${skipped}개 건너뜀` : `${done} done · ${skipped} skipped`,
  };
}

function statusLabel(status: AutomationRunRecord["status"], ko: boolean): string {
  if (status === "error") return ko ? "실패" : "Failed";
  if (status === "skipped") return ko ? "건너뜀" : "Skipped";
  return ko ? "완료" : "Complete";
}

function formatDateTime(iso: string | null | undefined, ko: boolean): string {
  if (!iso) return ko ? "시간 없음" : "No time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function statusTone(state: WorkflowNodeRunState): CSSProperties {
  if (state === "running") return { color: "var(--accent)" };
  if (state === "done") return { color: "var(--green-deep)" };
  if (state === "failed") return { color: "var(--red-deep)" };
  return { color: "var(--muted-deep)" };
}
