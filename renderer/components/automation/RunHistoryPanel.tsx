"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import type {
  Automation,
  AutomationGraphReconciliation,
  AutomationGraphReconciliationDecision,
  AutomationRunRecord,
  AutomationTriggerEventAttention,
  WorkflowRunSnapshot,
  WorkflowNodeRunState,
} from "@/lib/types";

interface RunHistoryPanelProps {
  automation: Automation;
  locale: "ko" | "en";
  compact?: boolean;
}

const POLL_MS = 5_000;

type NodeDecisionDraft = {
  resolution?: AutomationGraphReconciliationDecision["resolution"];
  output: string;
};

export function RunHistoryPanel({ automation, locale, compact = false }: RunHistoryPanelProps) {
  const ko = locale === "ko";
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [latest, setLatest] = useState<WorkflowRunSnapshot | null>(null);
  const [attentions, setAttentions] = useState<AutomationTriggerEventAttention[]>([]);
  const [reconciliation, setReconciliation] = useState<AutomationGraphReconciliation | null>(null);
  const [nodeDecisions, setNodeDecisions] = useState<Record<string, NodeDecisionDraft>>({});
  const [message, setMessage] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [opening, setOpening] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [eventActionId, setEventActionId] = useState<string | null>(null);

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
      setAttentions(nextAttentions);
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
      setRecoveryError(reconciliationErrorMessage(err, ko));
    }
  }, [automation.id, compact, ko]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => void load(), POLL_MS);

  useEffect(() => {
    const drafts: Record<string, NodeDecisionDraft> = {};
    for (const node of reconciliation?.nodes ?? []) drafts[node.nodeId] = { output: "" };
    setNodeDecisions(drafts);
  }, [reconciliation?.checkpointDigest, reconciliation?.runId]);

  const current = useMemo(() => summarizeSnapshot(latest, ko), [latest, ko]);
  const regularAttentions = useMemo(
    () => attentions.filter((attention) => attention.id !== reconciliation?.triggerEvent?.id),
    [attentions, reconciliation?.triggerEvent?.id],
  );
  const graphDecisionReady = useMemo(() => {
    if (!reconciliation || reconciliation.nodes.length === 0) return false;
    return reconciliation.nodes.every((node) => {
      const draft = nodeDecisions[node.nodeId];
      if (!draft?.resolution) return false;
      return draft.resolution !== "completed" || !node.outputRequired || draft.output.trim().length > 0;
    });
  }, [nodeDecisions, reconciliation]);

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

  function chooseNodeResolution(
    nodeId: string,
    resolution: AutomationGraphReconciliationDecision["resolution"],
  ) {
    setNodeDecisions((currentDrafts) => ({
      ...currentDrafts,
      [nodeId]: { output: currentDrafts[nodeId]?.output ?? "", resolution },
    }));
  }

  function setNodeOutput(nodeId: string, output: string) {
    setNodeDecisions((currentDrafts) => ({
      ...currentDrafts,
      [nodeId]: { ...currentDrafts[nodeId], output },
    }));
  }

  async function submitGraphReconciliation() {
    const api = ipc();
    if (!api || !reconciliation || reconciling || !graphDecisionReady) return;
    const completedCount = reconciliation.nodes.filter(
      (node) => nodeDecisions[node.nodeId]?.resolution === "completed",
    ).length;
    const retryCount = reconciliation.nodes.length - completedCount;
    const confirmed = window.confirm(ko
      ? `실제 외부 상태를 확인했습니까? 완료 ${completedCount}개, 재시도 ${retryCount}개로 확정합니다. 잘못 선택하면 중복 동작이 생길 수 있습니다.`
      : `Did you verify the real external state? This will confirm ${completedCount} completed and ${retryCount} to retry. A wrong choice can duplicate an external action.`);
    if (!confirmed) return;
    setReconciling(true);
    setRecoveryError("");
    try {
      const decisions: AutomationGraphReconciliationDecision[] = reconciliation.nodes.map((node) => {
        const draft = nodeDecisions[node.nodeId];
        return {
          nodeId: node.nodeId,
          resolution: draft.resolution!,
          ...(draft.resolution === "completed" && draft.output.length > 0
            ? { output: draft.output }
            : {}),
        };
      });
      const result = await api.automations.reconcileGraph({
        automationId: reconciliation.automationId,
        runId: reconciliation.runId,
        occurrenceId: reconciliation.occurrenceId,
        graphDigest: reconciliation.graphDigest,
        checkpointDigest: reconciliation.checkpointDigest,
        expectedUpdatedAt: reconciliation.updatedAt,
        eventId: reconciliation.triggerEvent?.id ?? null,
        expectedEventUpdatedAt: reconciliation.triggerEvent?.updatedAt ?? null,
        decisions,
      });
      await load();
      setMessage(result.resumeRequired
        ? (ko ? "확인 내용을 저장했습니다. 남은 노드를 안전하게 다시 시작합니다." : "Saved the confirmation. Safely resuming the remaining nodes.")
        : (ko ? "확인 내용을 저장했습니다. 이 발생은 완료 처리됐습니다." : "Saved the confirmation. This occurrence is complete."));
    } catch (err) {
      setRecoveryError(reconciliationErrorMessage(err, ko));
    } finally {
      setReconciling(false);
    }
  }

  async function reconcileEvent(
    attention: AutomationTriggerEventAttention,
    resolution: "completed" | "retry",
  ) {
    const api = ipc();
    if (!api || eventActionId) return;
    const confirmed = window.confirm(resolution === "completed"
      ? (ko
          ? "외부 동작이 실제로 완료된 것을 확인했습니까? 이 발생은 다시 실행하지 않습니다."
          : "Did you verify that the external action completed? This occurrence will not run again.")
      : (ko
          ? "외부 동작이 실행되지 않은 것을 확인했습니까? 이 발생을 다시 시도합니다."
          : "Did you verify that the external action did not run? This occurrence will be retried."));
    if (!confirmed) return;
    setEventActionId(attention.id);
    setRecoveryError("");
    try {
      await api.automations.reconcileTriggerEvent({
        eventId: attention.id,
        automationId: attention.automationId,
        expectedUpdatedAt: attention.updatedAt,
        resolution,
      });
      await load();
      setMessage(resolution === "completed"
        ? (ko ? "발생을 완료 처리했습니다." : "Marked the occurrence complete.")
        : (ko ? "발생을 다시 대기열에 넣었습니다." : "Queued the occurrence for retry."));
    } catch (err) {
      setRecoveryError(reconciliationErrorMessage(err, ko));
    } finally {
      setEventActionId(null);
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

      {reconciliation ? (
        <section className="automation-reconcile-card" aria-labelledby={`reconcile-${reconciliation.runId}`}>
          <div className="automation-reconcile-head">
            <div>
              <span>{ko ? "실제 상태 확인 필요" : "External state check required"}</span>
              <strong id={`reconcile-${reconciliation.runId}`}>
                {ko ? "외부 동작을 확인해 주세요" : "Confirm what happened externally"}
              </strong>
            </div>
            <code>{reconciliation.runId}</code>
          </div>
          <p>
            {ko
              ? "앱 종료나 응답 단절로 아래 동작의 완료 여부를 확정할 수 없습니다. 실제 서비스나 파일을 먼저 확인한 뒤 각 노드를 선택하세요."
              : "A shutdown or lost response left these actions uncertain. Check the real service or file first, then decide each node."}
          </p>
          {reconciliation.triggerEvent ? (
            <div className="automation-reconcile-event-note">
              {ko
                ? `${reconciliation.triggerEvent.triggerKind.toUpperCase()} 발생도 같은 저장 작업에서 함께 조정됩니다.`
                : `The bound ${reconciliation.triggerEvent.triggerKind.toUpperCase()} occurrence will be reconciled in the same database commit.`}
            </div>
          ) : null}

          <div className="automation-reconcile-node-list">
            {reconciliation.nodes.map((node) => {
              const draft = nodeDecisions[node.nodeId] ?? { output: "" };
              return (
                <fieldset key={node.nodeId} className="automation-reconcile-node">
                  <legend>
                    <strong>{node.label}</strong>
                    <span>{node.nodeType} · {node.uncertainty === "ambiguous"
                      ? (ko ? "완료 여부 불명" : "completion unknown")
                      : (ko ? "중단 시점 불명" : "interrupted in flight")}</span>
                  </legend>
                  <div className="automation-reconcile-choices">
                    <button
                      type="button"
                      aria-pressed={draft.resolution === "completed"}
                      data-selected={draft.resolution === "completed" ? "true" : "false"}
                      onClick={() => chooseNodeResolution(node.nodeId, "completed")}
                      disabled={reconciling}
                    >
                      {ko ? "완료됨" : "Completed"}
                      <small>{ko ? "다시 실행하지 않음" : "Do not run again"}</small>
                    </button>
                    <button
                      type="button"
                      aria-pressed={draft.resolution === "retry"}
                      data-selected={draft.resolution === "retry" ? "true" : "false"}
                      onClick={() => chooseNodeResolution(node.nodeId, "retry")}
                      disabled={reconciling}
                    >
                      {ko ? "실행되지 않음 — 재시도" : "Did not run — retry"}
                      <small>{ko ? "증거를 정리하고 다시 실행" : "Clear active evidence and retry"}</small>
                    </button>
                  </div>
                  {draft.resolution === "completed" && node.outputRequired ? (
                    <label className="automation-reconcile-output">
                      <span>
                        {ko ? `완료 결과 · {{${node.produces}}}` : `Completed output · {{${node.produces}}}`}
                        <em>{ko ? "필수" : "Required"}</em>
                      </span>
                      <textarea
                        value={draft.output}
                        onChange={(event) => setNodeOutput(node.nodeId, event.target.value)}
                        placeholder={ko ? "실제 완료 결과를 입력하세요" : "Enter the actual completed output"}
                        disabled={reconciling}
                        required
                        rows={3}
                      />
                    </label>
                  ) : null}
                </fieldset>
              );
            })}
          </div>
          <button
            type="button"
            className="automation-reconcile-submit"
            disabled={!graphDecisionReady || reconciling}
            onClick={() => void submitGraphReconciliation()}
          >
            {reconciling
              ? (ko ? "저장 중..." : "Saving...")
              : (ko ? "확정하고 안전하게 계속" : "Confirm and continue safely")}
          </button>
        </section>
      ) : null}

      {regularAttentions.length > 0 ? (
        <section className="automation-event-attention-list" aria-label={ko ? "확인이 필요한 자동화 발생" : "Automation occurrences requiring review"}>
          {regularAttentions.map((attention) => (
            <article key={attention.id} className="automation-event-attention">
              <div>
                <strong>{ko ? "발생 결과 확인 필요" : "Occurrence needs confirmation"}</strong>
                <span>{attention.triggerKind.toUpperCase()} · {formatDateTime(attention.updatedAt, ko)}</span>
              </div>
              <p>{attention.lastError}</p>
              <div className="automation-event-attention-actions">
                <button
                  type="button"
                  disabled={eventActionId !== null}
                  onClick={() => void reconcileEvent(attention, "completed")}
                >
                  {ko ? "이미 완료됨 — 재실행 안 함" : "Already completed — do not rerun"}
                </button>
                <button
                  type="button"
                  disabled={eventActionId !== null}
                  onClick={() => void reconcileEvent(attention, "retry")}
                >
                  {ko ? "실행 안 됨 — 다시 시도" : "Did not run — retry"}
                </button>
              </div>
            </article>
          ))}
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
              {run.error ? <p>{run.error}</p> : run.skippedCount > 0 ? <p>{ko ? `${run.skippedCount}회 놓친 실행 병합` : `${run.skippedCount} missed runs coalesced`}</p> : null}
            </article>
          ))
        )}
      </div>

      {recoveryError ? <div className="automation-run-message" role="alert">{recoveryError}</div> : null}
      {message ? <div className="automation-run-message" role="status">{message}</div> : null}
    </section>
  );
}

function reconciliationErrorMessage(error: unknown, ko: boolean): string {
  const raw = String(error);
  if (/graph_drift/.test(raw)) {
    return ko
      ? "워크플로우가 실패 후 변경되어 이 기록을 자동 조정할 수 없습니다. 변경 전 그래프를 복원하거나 새 자동화로 분리해 주세요."
      : "The workflow changed after this failure. Restore the prior graph or separate it into a new automation before reconciling.";
  }
  if (/output_required/.test(raw)) {
    return ko ? "완료된 노드의 실제 결과를 입력해 주세요." : "Enter the actual output for every completed node.";
  }
  if (/conflict|stale/.test(raw)) {
    return ko ? "상태가 다른 실행에서 변경되었습니다. 최신 상태를 다시 불러왔습니다." : "Another runner changed this state. Reloaded the latest state.";
  }
  if (/bound_event_active/.test(raw)) {
    return ko ? "다른 실행기가 이 발생을 처리 중입니다. 잠시 후 다시 확인해 주세요." : "Another runner is processing this occurrence. Try again shortly.";
  }
  if (/checkpoint_(?:malformed|not_v3)|node_states_malformed/.test(raw)) {
    return ko
      ? "복구 기록이 손상됐거나 구버전이라 안전하게 판단할 수 없습니다. 자동 재실행은 차단된 상태입니다."
      : "The recovery record is malformed or from an older schema. Automatic replay remains blocked.";
  }
  return ko ? `복구 작업을 완료하지 못했습니다. ${raw}` : `Could not complete reconciliation. ${raw}`;
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
