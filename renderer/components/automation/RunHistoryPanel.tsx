"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import type {
  Automation,
  AutomationGraphReconciliation,
  AutomationRunRecord,
  WorkflowRunSnapshot,
  WorkflowNodeRunState,
} from "@/lib/types";

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
  const [attentionCount, setAttentionCount] = useState(0);
  const [reconciliation, setReconciliation] = useState<AutomationGraphReconciliation | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    let snap: WorkflowRunSnapshot | null = null;
    try {
      const [history, nextSnap, nextAttentions] = await Promise.all([
        api.automations.listRuns(automation.id, compact ? 5 : 12),
        api.automations.latestRun(automation.id),
        api.automations.listTriggerAttention(automation.id),
      ]);
      snap = nextSnap;
      setRuns(history);
      setLatest(nextSnap);
      setAttentionCount(nextAttentions.length);
      setMessage("");
    } catch (err) {
      setMessage("");
    }
    if (!automation.graph || !snap || snap.status !== "error") {
      setReconciliation(null);
      return;
    }
    try {
      const nextReconciliation = await api.automations.getGraphReconciliation(automation.id);
      setReconciliation(nextReconciliation);
    } catch (err) {
      setReconciliation(null);
    }
  }, [automation.graph, automation.id, compact, ko]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => void load(), POLL_MS);

  const current = useMemo(() => summarizeSnapshot(latest, ko), [latest, ko]);
  const needsHelp = Boolean(reconciliation || attentionCount > 0 || latest?.status === "error");

  return (
    <section className="automation-run-panel titlebar-nodrag" data-compact={compact ? "true" : "false"}>
      <div className="automation-run-head">
        <div>
          <div className="automation-run-kicker">{ko ? "자동화" : "Automation"}</div>
          <strong>{current.title}</strong>
        </div>
        <span>{needsHelp ? (ko ? "확인 필요" : "Needs review") : (ko ? "실행 기록" : "Run history")}</span>
      </div>

      {latest ? (
        <div className="automation-run-snapshot" data-status={latest.status}>
          <span>{formatDateTime(latest.startedAt, ko)}</span>
          <span>{current.detail}</span>
        </div>
      ) : (
        <div className="automation-run-empty">{ko ? "아직 실행 기록이 없어요." : "No runs yet."}</div>
      )}

      {needsHelp ? (
        <section className="automation-reconcile-card" role="status">
          <div className="automation-reconcile-head">
            <div>
              <span>{ko ? "확인이 필요해요" : "Needs attention"}</span>
              <strong>{current.title}</strong>
            </div>
          </div>
        </section>
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
              {!run.error && run.skippedCount > 0 ? <p>{ko ? "놓친 예약을 한 번으로 합쳐 실행했어요." : "Missed schedules were combined into one run."}</p> : null}
            </article>
          ))
        )}
      </div>

      {message ? <div className="automation-run-message" role="status">{message}</div> : null}
    </section>
  );
}

function summarizeSnapshot(snap: WorkflowRunSnapshot | null, ko: boolean): { title: string; detail: string } {
  if (!snap) return { title: ko ? "아직 실행 전이에요" : "Not run yet", detail: ko ? "실행하면 결과가 여기에 표시됩니다." : "The result will appear here after it runs." };
  const states = Object.values(snap.nodeStates ?? {});
  const running = states.filter((state) => state === "running").length;
  const failed = states.filter((state) => state === "failed").length;
  const skipped = states.filter((state) => state === "skipped").length;
  if (snap.status === "running" || running > 0) {
    return { title: ko ? "작업하고 있어요" : "Working on it", detail: ko ? "필요한 단계를 순서대로 진행하고 있어요." : "The required steps are running in order." };
  }
  if (snap.status === "error" || failed > 0) {
    return { title: ko ? "끝까지 완료되지 않았어요" : "Not fully completed", detail: ko ? "완료로 처리하지 않았어요." : "It was not marked complete." };
  }
  return {
    title: ko ? "완료했어요" : "Completed",
    detail: skipped > 0 ? (ko ? "필요 없는 단계는 건너뛰고 결과를 만들었어요." : "Unneeded steps were skipped and the result is ready.") : (ko ? "요청한 작업을 마쳤어요." : "The requested work is complete."),
  };
}

function statusLabel(status: AutomationRunRecord["status"], ko: boolean): string {
  if (status === "error") return ko ? "실패" : "Failed";
  if (status === "partial") return ko ? "부분 완료" : "Partially completed";
  if (status === "blocked") return ko ? "차단됨 · 계속 켜짐" : "Blocked · still enabled";
  if (status === "needs_input") return ko ? "입력 필요 · 계속 켜짐" : "Needs input · still enabled";
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
