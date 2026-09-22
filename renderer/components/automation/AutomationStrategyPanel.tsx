"use client";

import { useEffect, useRef, useState } from "react";
import type { AutomationStrategyProposalView } from "@shared/automation-strategy-review";
import { ipc, ipcEvents } from "@/lib/ipc";
import { requiresAutomationStrategyReview } from "./automation-strategy-review-surface";
import styles from "./AutomationStrategyPanel.module.css";

type GoalAmendmentDraft = {
  text: string;
  objective: string;
  acceptanceCriteria: Array<{ id: string; text: string }>;
};

export function AutomationStrategyPanel({ automationId, locale }: { automationId: string; locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [rows, setRows] = useState<AutomationStrategyProposalView[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [amendments, setAmendments] = useState<Record<string, GoalAmendmentDraft>>({});
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const identityRef = useRef(automationId);
  identityRef.current = automationId;

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    setRows([]); setError(""); setBusyId(null); setAmendments({});
    const load = async () => {
      const api = ipc();
      if (!api?.automations.listStrategyProposals) return;
      const current = ++generation;
      try {
        const next = await api.automations.listStrategyProposals(automationId, 12);
        if (disposed || current !== generation) return;
        if (next.some((row) => row.automationId !== automationId)) throw new Error("strategy_identity_changed");
        setRows(next); setError("");
      } catch {
        if (!disposed && current === generation) setError(ko ? "전략 변경 내역을 확인하지 못했습니다." : "Could not check strategy changes.");
      }
    };
    refreshRef.current = load;
    void load();
    const off = ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "automation" && (!change.id || change.id === automationId)) void load();
    });
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    const poll = window.setInterval(visible, 20_000);
    return () => {
      disposed = true; ++generation; off?.(); clearInterval(poll);
      document.removeEventListener("visibilitychange", visible);
      refreshRef.current = null;
    };
  }, [automationId, ko]);

  const visibleRows = rows.filter((row) => row.intent !== "keep");
  const pending = visibleRows.filter((row) => requiresAutomationStrategyReview(row));
  const latestApplied = visibleRows.find((row) => row.status === "applied");
  const latestDecision = rows.reduce<AutomationStrategyProposalView | null>((latest, row) =>
    !latest || row.createdAt > latest.createdAt ? row : latest, null);
  const latestKeep = latestDecision?.intent === "keep" && latestDecision.reviewState === "judged" ? latestDecision : null;
  const unconfirmedKeep = latestDecision?.intent === "keep" && latestDecision.reviewState !== "judged";
  if (rows.length === 0 && !error) return null;

  function defaultAmendment(row: AutomationStrategyProposalView): GoalAmendmentDraft {
    return {
      text: "",
      objective: row.goalObjective ?? "",
      acceptanceCriteria: row.goalAcceptanceCriteria.map((criterion) => ({ ...criterion })),
    };
  }

  function amendmentFor(row: AutomationStrategyProposalView): GoalAmendmentDraft {
    return amendments[row.id] ?? defaultAmendment(row);
  }

  function updateAmendment(row: AutomationStrategyProposalView, patch: Partial<GoalAmendmentDraft>) {
    setAmendments((current) => ({ ...current, [row.id]: { ...amendmentFor(row), ...patch } }));
  }

  function updateCriterion(row: AutomationStrategyProposalView, index: number, key: "id" | "text", value: string) {
    const draft = amendmentFor(row);
    const acceptanceCriteria = draft.acceptanceCriteria.map((criterion, criterionIndex) =>
      criterionIndex === index ? { ...criterion, [key]: value } : criterion,
    );
    updateAmendment(row, { acceptanceCriteria });
  }

  function addCriterion(row: AutomationStrategyProposalView) {
    const draft = amendmentFor(row);
    updateAmendment(row, {
      acceptanceCriteria: [...draft.acceptanceCriteria, { id: `amendment-criterion-${draft.acceptanceCriteria.length + 1}`, text: "" }],
    });
  }

  function removeCriterion(row: AutomationStrategyProposalView, index: number) {
    const draft = amendmentFor(row);
    updateAmendment(row, { acceptanceCriteria: draft.acceptanceCriteria.filter((_, criterionIndex) => criterionIndex !== index) });
  }

  function changesGoalContract(row: AutomationStrategyProposalView, draft: GoalAmendmentDraft): boolean {
    if (row.goalObjective !== draft.objective.trim()) return true;
    const prior = new Map(row.goalAcceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
    const next = new Map(draft.acceptanceCriteria.map((criterion) => [criterion.id.trim(), criterion.text.trim()]));
    return prior.size !== next.size || [...prior].some(([id, text]) => next.get(id) !== text);
  }

  async function review(row: AutomationStrategyProposalView, decision: "apply" | "reject", draft?: GoalAmendmentDraft) {
    const api = ipc();
    if (!api || busyId) return;
    if (decision === "apply" && row.goalAmendmentRequired) {
      if (!draft?.text.trim() || !draft.objective.trim() || !row.goalRevision || row.goalRunVersion === null
        || draft.acceptanceCriteria.length === 0 || draft.acceptanceCriteria.some((criterion) => !criterion.id.trim() || !criterion.text.trim())) {
        setError(ko ? "승인 문장과 적용할 Goal 목표·기준을 모두 입력해 주세요." : "Enter an approval statement and the complete Goal objective and criteria.");
        return;
      }
      if (!changesGoalContract(row, draft)) {
        setError(ko ? "충돌하는 Goal 조건을 수정해야 적용할 수 있습니다. 기존 목표·기준 그대로의 전략 적용은 허용되지 않습니다." : "Change the conflicting Goal objective or criteria before applying this proposal.");
        return;
      }
    }
    setBusyId(row.id); setError("");
    try {
      const result = await api.automations.reviewStrategyProposal({
        automationId, proposalId: row.id, decision,
        ...(decision === "apply" && row.goalAmendmentRequired && draft && row.goalRevision !== null && row.goalRunVersion !== null
          ? { goalAmendment: {
            text: draft.text,
            objective: draft.objective,
            acceptanceCriteria: draft.acceptanceCriteria,
            expectedGoalRevision: row.goalRevision,
            expectedRunVersion: row.goalRunVersion,
          } } : {}),
      });
      if (identityRef.current !== automationId) return;
      if (!result.ok) {
        setError(result.code === "stale"
          ? (ko ? "그동안 실행 계획이 바뀌었습니다. 최신 변경안을 확인해 주세요." : "The plan changed in the meantime. Review the latest proposal.")
          : result.code === "not_applicable"
            ? (ko ? "이 변경안은 아직 적용할 수 없습니다. 자동화 대화에서 변경 내용을 구체화해 주세요." : "This proposal cannot be applied yet. Refine it in the automation conversation.")
            : (ko ? "처리 결과를 확인하지 못했습니다. 내역을 새로고침해 주세요." : "Could not confirm the decision. Refresh the history."));
        return;
      }
      if (result.proposal.id !== row.id || result.proposal.automationId !== automationId) throw new Error("strategy_identity_changed");
      setRows((current) => current.map((item) => item.id === row.id ? result.proposal : item));
      await refreshRef.current?.();
    } catch {
      if (identityRef.current === automationId) setError(ko ? "처리 결과를 확인하지 못했습니다. 새로고침하면 저장된 상태를 확인할 수 있습니다." : "Could not confirm the result. Refresh to check the saved state.");
    } finally { if (identityRef.current === automationId) setBusyId(null); }
  }

  function status(row: AutomationStrategyProposalView): string {
    if (row.status === "applied") return row.consumedAt
      ? (ko ? "실행에 반영됨" : "Used by a run")
      : (ko ? "적용됨 · 실행 반영 확인 전" : "Applied · awaiting run confirmation");
    if (row.status === "rejected") return ko ? "적용하지 않음" : "Not applied";
    if (row.unavailableReason === "stale") return ko ? "이전 계획의 제안" : "Proposal for an older plan";
    if (!row.requiresPaymentApproval && row.goalAmendmentRequired) return ko ? "Goal 계약 변경 보류" : "Goal contract change held";
    if (!row.requiresPaymentApproval && (row.status === "pending" || row.status === "approved")) {
      return ko ? "AI가 자동 전략 적용 중" : "AI applying strategy autonomously";
    }
    if (row.conflict === "needs_user_approval" || (row.conflict === "uncertain" && row.canApply)) return ko ? "사용자 판단 필요" : "Your decision needed";
    return ko ? "검토 대기" : "Awaiting review";
  }

  function runtimeName(runtime: AutomationStrategyProposalView["executionRuntime"]): string {
    if (!runtime) return ko ? "확인되지 않음" : "Not recorded";
    const provider = runtime.backend ? `${runtime.kind} · ${runtime.backend}` : runtime.kind;
    return runtime.model ? `${provider} · ${runtime.model}` : provider;
  }

  return <details className={styles.panel} data-automation-strategy={automationId}>
    <summary>
      <strong>{ko ? "전략 변경" : "Strategy changes"}</strong>
      <span>{pending.length > 0
        ? (ko ? `검토할 제안 ${pending.length}개` : `${pending.length} to review`)
        : latestKeep ? (ko ? "최근 판단 · 전략 유지" : "Latest review · strategy unchanged")
          : unconfirmedKeep ? (ko ? "최근 판단 확인 필요" : "Latest review unconfirmed")
          : latestApplied ? status(latestApplied) : (ko ? "변경 내역" : "History")}</span>
    </summary>
    {rows[0]?.automationName && <p className={styles.name}>{rows[0].automationName}</p>}
    {error && <p className={styles.error} role="status">{error} <button type="button" onClick={() => void refreshRef.current?.()}>{ko ? "새로고침" : "Refresh"}</button></p>}
    {latestKeep && <article>
      <div className={styles.heading}><strong>{ko ? "현재 전략 유지" : "Keep the current strategy"}</strong>
        <span>{Number.isFinite(Date.parse(latestKeep.createdAt))
          ? new Date(latestKeep.createdAt).toLocaleString(ko ? "ko-KR" : "en-US") : ""}</span></div>
      <p>{latestKeep.rationale}</p>
    </article>}
    {unconfirmedKeep && <article><p>{ko
      ? "최근 전략 검토를 확정하지 못했습니다. 이 표시는 예약 실행이 중지됐다는 뜻은 아닙니다."
      : "The latest strategy review could not be confirmed. This does not mean scheduled execution has stopped."}</p></article>}
    {visibleRows.map((row) => <article key={row.id} data-proposal-status={row.status} data-human-review={requiresAutomationStrategyReview(row) ? "true" : undefined}>
      <div className={styles.heading}><strong>{row.summary}</strong><span>{status(row)}</span></div>
      {row.rationale !== row.summary && <p>{row.rationale}</p>}
      <p>{ko ? "실행 모델" : "Execution model"}: {runtimeName(row.executionRuntime)} · {ko ? "판단 모델" : "Judgment model"}: {runtimeName(row.judgmentRuntime)}</p>
      {row.reviewReason && <p>{row.reviewReason}</p>}
      {(row.status === "pending" || row.status === "approved") && <div className={styles.actions}>
        {row.goalOwnershipUnverified && row.canApply && <span>{ko
          ? (row.originAdoptionRecorded
            ? "이 자동화의 같은 범위 전략 개편을 AI가 자동 적용하도록 위임한 상태입니다. 이번 변경을 승인해도 Goal에는 재결속하지 않습니다."
            : "이 승인으로 이 자동화의 같은 범위 전략 개편을 AI가 향후 자동 적용하도록 위임합니다. Goal에는 재결속하지 않으며, prompt·cadence 같은 허용된 전략 surface만 대상입니다.")
          : (row.originAdoptionRecorded
            ? "This automation is delegated for AI-applied, same-scope strategy revisions. Approving this proposal will not rebind it to the Goal."
            : "This approval delegates future same-scope strategy revisions for this automation to AI-applied changes. It does not rebind the automation to the Goal; only allowlisted surfaces such as prompt and cadence are eligible.")}</span>}
        {requiresAutomationStrategyReview(row) && row.canApply && <button type="button" disabled={busyId !== null} onClick={() => void review(row, "apply")}>{busyId === row.id ? (ko ? "처리 중…" : "Working…") : (row.goalOwnershipUnverified && !row.originAdoptionRecorded ? (ko ? "위임 후 이 변경 적용" : "Delegate future revisions and apply") : (ko ? "이 변경 적용" : "Apply this change"))}</button>}
        {requiresAutomationStrategyReview(row) && <button type="button" disabled={busyId !== null} onClick={() => void review(row, "reject")}>{ko ? "적용하지 않기" : "Do not apply"}</button>}
        {!requiresAutomationStrategyReview(row) && row.goalAmendmentRequired && <span>{ko ? "전략만으로는 Goal 계약을 바꾸지 않습니다. Goal 변경은 이 기록에서 명시적으로 확인할 수 있습니다." : "The agent will not change the Goal contract as a strategy side effect. Goal amendments remain explicit in this history."}</span>}
        {row.unavailableReason === "no_executable_change" && <span>{ko ? "구체적인 변경 계획이 필요합니다." : "A concrete change plan is needed."}</span>}
        {row.unavailableReason === "ownership_unverified" && <span>{ko
          ? "이 자동화가 Goal에서 만들어졌을 가능성이 있지만 정확한 바인딩 증거가 없습니다. 재연결 확인 전에는 전략을 적용하지 않습니다."
          : "This automation may originate from a Goal, but its exact binding proof is missing. Strategy changes stay held until it is reconciled."}</span>}
      </div>}
      {row.goalAmendmentRequired && (row.status === "pending" || row.status === "approved") && row.goalObjective !== null && <div className={styles.amendment}>
        <strong>{ko ? "Goal 변경과 함께 승인" : "Approve with a Goal amendment"}</strong>
        <p>{ko
          ? "이 전략은 Goal 계약 변경 여부를 확인해야 합니다. 아래 승인 문장과 적용할 목표·기준을 직접 확인하고, 변경이 필요하면 충돌한 목표 또는 기준을 수정해야 합니다. 원문 요청은 그대로 보존됩니다."
          : "This strategy needs a Goal-contract decision. Confirm the approval statement and complete objective and criteria below; if the contract must change, edit the conflicting objective or criterion. The original request stays immutable."}</p>
        <details className={styles.currentGoal}>
          <summary>{ko ? "현재 Goal 조건" : "Current Goal conditions"}</summary>
          <strong>{row.goalObjective}</strong>
          <ul>{row.goalAcceptanceCriteria.map((criterion) => <li key={criterion.id}>{criterion.id}: {criterion.text}</li>)}</ul>
        </details>
        {(() => {
          const draft = amendmentFor(row);
          return <>
            <label>{ko ? "사용자 승인 문장" : "Your approval statement"}
              <textarea value={draft.text} onChange={(event) => updateAmendment(row, { text: event.target.value })}
                placeholder={ko ? "예: 이 전략 변경을 승인하고 아래 Goal 조건으로 계속 진행합니다." : "Example: I approve this strategy change and the Goal conditions below."}
                aria-label={ko ? "사용자 승인 문장" : "Your approval statement"} />
            </label>
            <label>{ko ? "적용할 Goal 목표" : "Goal objective to apply"}
              <textarea value={draft.objective} onChange={(event) => updateAmendment(row, { objective: event.target.value })}
                aria-label={ko ? "적용할 Goal 목표" : "Goal objective to apply"} />
            </label>
            <fieldset>
              <legend>{ko ? "적용할 Goal 기준" : "Goal criteria to apply"}</legend>
              {draft.acceptanceCriteria.map((criterion, index) => <div className={styles.criterion} key={`${row.id}:criterion:${index}`}>
                <input value={criterion.id} onChange={(event) => updateCriterion(row, index, "id", event.target.value)}
                  aria-label={`${ko ? "기준 ID" : "Criterion ID"} ${index + 1}`} placeholder="criterion-id" />
                <input value={criterion.text} onChange={(event) => updateCriterion(row, index, "text", event.target.value)}
                  aria-label={`${ko ? "기준" : "Criterion"} ${index + 1}`} placeholder={ko ? "기준 내용" : "Criterion text"} />
                <button type="button" onClick={() => removeCriterion(row, index)} disabled={busyId !== null || draft.acceptanceCriteria.length <= 1}>{ko ? "삭제" : "Remove"}</button>
              </div>)}
              <button type="button" onClick={() => addCriterion(row)} disabled={busyId !== null || draft.acceptanceCriteria.length >= 32}>{ko ? "기준 추가" : "Add criterion"}</button>
            </fieldset>
            <button type="button" disabled={busyId !== null || row.goalRevision === null || row.goalRunVersion === null}
              onClick={() => void review(row, "apply", draft)}>
              {busyId === row.id ? (ko ? "처리 중…" : "Working…") : (ko ? "Goal 변경과 전략을 함께 적용" : "Apply Goal amendment and strategy")}
            </button>
          </>;
        })()}
      </div>}
      {row.changes.length > 0 && <details className={styles.diff}>
        <summary>{ko ? "변경 내용 보기" : "Review changes"}</summary>
        {row.changes.map((change, index) => <div key={`${change.label}:${index}`}>
          <strong>{change.label}</strong>
          {change.before !== null && <><small>{ko ? "현재" : "Current"}</small><pre>{change.before}</pre></>}
          <small>{row.status === "applied" ? (ko ? "적용된 내용" : "Applied change") : (ko ? "제안" : "Proposed")}</small><pre>{change.after}</pre>
        </div>)}
      </details>}
    </article>)}
  </details>;
}
