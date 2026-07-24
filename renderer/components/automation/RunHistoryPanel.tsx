"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
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
  const [recoveryError, setRecoveryError] = useState("");
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const [history, snap, nextAttentions] = await Promise.all([
        api.automations.listRuns(automation.id, compact ? 5 : 12),
        api.automations.latestRun(automation.id),
        api.automations.listTriggerAttention(automation.id),
      ]);
      setRuns(history);
      setLatest(snap);
      setAttentionCount(nextAttentions.length);
      setMessage("");
    } catch (err) {
      setMessage(ko ? `실행 기록을 불러오지 못했습니다. ${String(err)}` : `Could not load run history. ${String(err)}`);
    }
    try {
      const nextReconciliation = await api.automations.getGraphReconciliation(automation.id);
      setReconciliation(nextReconciliation);
      setRecoveryError("");
    } catch (err) {
      setReconciliation(null);
      setRecoveryError(ko ? "현재 상태를 다시 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요." : "Could not refresh the current state. Please try again shortly.");
    }
  }, [automation.id, compact, ko]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => void load(), POLL_MS);

  const current = useMemo(() => summarizeSnapshot(latest, ko), [latest, ko]);
  const needsHelp = Boolean(reconciliation || attentionCount > 0 || latest?.status === "error");

  async function openResultChat() {
    const api = ipc();
    if (!api || opening) return;
    setOpening(true);
    try {
      const chat = await api.automations.getSession(automation.id);
      // Automation run sessions live on the Work surface. Open the transcript
      // in Work, never inside One — One and Work are separate surfaces, so a
      // Work automation history must not be routed into One's home.
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
          <div className="automation-run-kicker">{ko ? "자동화" : "Automation"}</div>
          <strong>{current.title}</strong>
        </div>
        <button type="button" onClick={() => void openResultChat()} disabled={opening}>
          {opening ? (ko ? "여는 중..." : "Opening...") : needsHelp ? (ko ? "결과 확인" : "Review result") : (ko ? "결과 보기" : "View result")}
        </button>
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
              <strong>{ko ? "One이 이어서 해결할 수 있어요" : "One can continue from here"}</strong>
            </div>
          </div>
          <p>{ko
            ? "중간에 멈춘 작업이 있어 완료로 처리하지 않았어요. 위 버튼을 누르면 같은 대화에서 원인을 확인하고 다시 시도합니다."
            : "A step stopped, so this was not marked complete. Use the button above to diagnose it and retry in the same conversation."}</p>
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
              {run.error ? <p>{friendlyAutomationError(run.error, ko)}</p> : run.skippedCount > 0 ? <p>{ko ? "놓친 예약을 한 번으로 합쳐 실행했어요." : "Missed schedules were combined into one run."}</p> : null}
            </article>
          ))
        )}
      </div>

      {recoveryError ? <div className="automation-run-message" role="alert">{recoveryError}</div> : null}
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
    return { title: ko ? "끝까지 완료되지 않았어요" : "Not fully completed", detail: ko ? "완료로 처리하지 않았어요. One이 이어서 확인할 수 있습니다." : "It was not marked complete. One can continue checking it." };
  }
  return {
    title: ko ? "완료했어요" : "Completed",
    detail: skipped > 0 ? (ko ? "필요 없는 단계는 건너뛰고 결과를 만들었어요." : "Unneeded steps were skipped and the result is ready.") : (ko ? "요청한 작업을 마쳤어요." : "The requested work is complete."),
  };
}

function friendlyAutomationError(error: string, ko: boolean): string {
  const message = error.toLowerCase();
  if (/auth|token|login|unauthori[sz]ed|forbidden/.test(message)) {
    return ko ? "연결이 만료되어 멈췄어요. One에서 다시 연결하고 이어갈 수 있습니다." : "The connection expired. Reconnect and continue with One.";
  }
  if (/timeout|timed out|network|fetch|http/.test(message)) {
    return ko ? "외부 서비스 응답이 없어 멈췄어요. One에서 다시 시도할 수 있습니다." : "The external service did not respond. Retry with One.";
  }
  return ko ? "중간 단계가 멈춰 완료로 처리하지 않았어요." : "A step stopped, so the run was not marked complete.";
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
