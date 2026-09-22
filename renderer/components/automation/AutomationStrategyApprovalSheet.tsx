"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutomationStrategyProposalView } from "@shared/automation-strategy-review";
import { useT } from "@/lib/i18n";
import { ipc, ipcEvents } from "@/lib/ipc";
import { ComposerDecisionPortal } from "@/components/ComposerDecisionPortal";
import { requiresAutomationStrategyReview } from "./automation-strategy-review-surface";
import styles from "./AutomationStrategyApprovalSheet.module.css";

const DISMISSED_STORAGE_KEY = "agentlas.strategy-approval-sheet.dismissed.v1";

type GoalAmendmentDraft = {
  text: string;
  objective: string;
  acceptanceCriteria: Array<{ id: string; text: string }>;
};

type ProposalFingerprint = `${string}:${string}`;

function fingerprint(row: AutomationStrategyProposalView): ProposalFingerprint {
  return `${row.id}:${row.updatedAt}`;
}

function readDismissed(): Set<ProposalFingerprint> {
  if (typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISMISSED_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is ProposalFingerprint => typeof value === "string").slice(-200));
  } catch {
    return new Set();
  }
}

function writeDismissed(values: Set<ProposalFingerprint>): void {
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...values].slice(-200)));
  } catch {
    // A private window may deny storage. The durable proposal panel remains
    // available; this only affects whether the attention sheet repeats.
  }
}

function defaultAmendment(row: AutomationStrategyProposalView): GoalAmendmentDraft {
  return {
    text: "",
    objective: row.goalObjective ?? "",
    acceptanceCriteria: row.goalAcceptanceCriteria.map((criterion) => ({ ...criterion })),
  };
}

function changesGoalContract(row: AutomationStrategyProposalView, draft: GoalAmendmentDraft): boolean {
  if (row.goalObjective !== draft.objective.trim()) return true;
  const prior = new Map(row.goalAcceptanceCriteria.map((criterion) => [criterion.id, criterion.text]));
  const next = new Map(draft.acceptanceCriteria.map((criterion) => [criterion.id.trim(), criterion.text.trim()]));
  return prior.size !== next.size || [...prior].some(([id, text]) => next.get(id) !== text);
}

function unavailableReason(row: AutomationStrategyProposalView, ko: boolean): string | null {
  if (row.unavailableReason === "ownership_unverified") {
    return ko
      ? "이 자동화의 Goal 연결 증거가 없어, 재연결 확인 전에는 전략을 적용할 수 없습니다."
      : "The Goal binding is unverified, so this strategy cannot be applied until the origin is reconciled.";
  }
  if (row.unavailableReason === "no_executable_change") {
    return ko ? "적용할 수 있는 구체적인 변경이 없습니다." : "There is no concrete executable change to apply.";
  }
  if (row.unavailableReason === "stale") {
    return ko ? "현재 계획이 바뀌어 이 제안은 더 이상 적용할 수 없습니다." : "The current plan changed, so this proposal is no longer applicable.";
  }
  return null;
}

export function AutomationStrategyApprovalSheet({ chatId = null }: { chatId?: string | null } = {}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [candidate, setCandidate] = useState<AutomationStrategyProposalView | null>(null);
  const [allRows, setAllRows] = useState<AutomationStrategyProposalView[]>([]);
  const [amendments, setAmendments] = useState<Record<string, GoalAmendmentDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const observedRef = useRef(new Map<string, string>());
  const dismissedRef = useRef<Set<ProposalFingerprint>>(new Set());
  const candidateRef = useRef<AutomationStrategyProposalView | null>(null);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    candidateRef.current = candidate;
  }, [candidate]);

  const pendingRows = useMemo(
    () => allRows.filter(requiresAutomationStrategyReview).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [allRows],
  );

  const load = useCallback(async () => {
    const api = ipc();
    if (!api?.automations) return;
    const generation = ++loadGenerationRef.current;
    try {
      const automations = await api.automations.list();
      let scopedAutomations = automations;
      if (chatId !== null) {
        const continuity = await api.chats.getContinuitySnapshot(chatId).catch(() => null);
        const scopedIds = continuity?.automations?.map((row) => row.automationId) ?? [];
        const fallbackIds = automations
          .filter((automation) => automation.monitor?.originChatId === chatId)
          .map((automation) => automation.id);
        const ids = new Set(scopedIds.length > 0 ? scopedIds : fallbackIds);
        scopedAutomations = automations.filter((automation) => ids.has(automation.id));
      } else {
        scopedAutomations = [];
      }
      const batches = await Promise.allSettled(
        scopedAutomations.map(async (automation) => api.automations.listStrategyProposals(automation.id, 12)),
      );
      if (generation !== loadGenerationRef.current) return;
      const next = batches.flatMap((batch) => batch.status === "fulfilled" ? batch.value : []);
      setAllRows(next);

      const humanRows = next.filter(requiresAutomationStrategyReview).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (candidateRef.current) {
        const refreshed = next.find((row) => row.id === candidateRef.current?.id) ?? null;
        if (refreshed && requiresAutomationStrategyReview(refreshed)) {
          candidateRef.current = refreshed;
          setCandidate(refreshed);
        } else {
          candidateRef.current = null;
          setCandidate(null);
        }
      }

      const dismissed = dismissedRef.current;
      const newlyActionable = humanRows.filter((row) => {
        const currentFingerprint = fingerprint(row);
        const previous = observedRef.current.get(row.id);
        observedRef.current.set(row.id, currentFingerprint);
        return previous !== currentFingerprint && !dismissed.has(currentFingerprint);
      });
      if (!candidateRef.current && newlyActionable[0]) {
        setError("");
        candidateRef.current = newlyActionable[0];
        setCandidate(newlyActionable[0]);
      }
    } catch {
      // The durable panel owns the detailed read error. The global attention
      // surface stays quiet rather than presenting a false approval prompt.
    }
  }, [chatId]);

  useEffect(() => {
    candidateRef.current = null;
    setCandidate(null);
    setAllRows([]);
    observedRef.current.clear();
    dismissedRef.current = readDismissed();
    void load();
    const events = ipcEvents();
    const off = events?.onStoreChanged?.((change) => {
      if (change.entity === "automation") void load();
    });
    const timer = window.setInterval(() => void load(), 20_000);
    return () => {
      off?.();
      window.clearInterval(timer);
      ++loadGenerationRef.current;
    };
  }, [load]);

  function dismiss(row = candidate) {
    if (!row) return;
    const key = fingerprint(row);
    dismissedRef.current.add(key);
    writeDismissed(dismissedRef.current);
    candidateRef.current = null;
    setCandidate(null);
    setError("");
  }

  function amendmentFor(row: AutomationStrategyProposalView): GoalAmendmentDraft {
    return amendments[row.id] ?? defaultAmendment(row);
  }

  function updateAmendment(row: AutomationStrategyProposalView, patch: Partial<GoalAmendmentDraft>) {
    setAmendments((current) => ({ ...current, [row.id]: { ...amendmentFor(row), ...patch } }));
  }

  function updateCriterion(row: AutomationStrategyProposalView, index: number, key: "id" | "text", value: string) {
    const draft = amendmentFor(row);
    updateAmendment(row, {
      acceptanceCriteria: draft.acceptanceCriteria.map((criterion, criterionIndex) =>
        criterionIndex === index ? { ...criterion, [key]: value } : criterion,
      ),
    });
  }

  async function review(row: AutomationStrategyProposalView, decision: "apply" | "reject", draft?: GoalAmendmentDraft) {
    const api = ipc();
    if (!api || busy) return;
    if (decision === "apply" && !row.canApply && !row.goalAmendmentRequired) {
      setError(unavailableReason(row, ko) ?? (ko ? "현재는 적용할 수 없는 제안입니다." : "This proposal is not currently applicable."));
      return;
    }
    if (decision === "apply" && row.goalAmendmentRequired) {
      if (!draft?.text.trim() || !draft.objective.trim() || !row.goalRevision || row.goalRunVersion === null
        || draft.acceptanceCriteria.length === 0 || draft.acceptanceCriteria.some((criterion) => !criterion.id.trim() || !criterion.text.trim())) {
        setError(ko ? "승인 문장과 적용할 Goal 목표·기준을 모두 입력해 주세요." : "Enter the approval statement and complete Goal objective and criteria.");
        return;
      }
      if (!changesGoalContract(row, draft)) {
        setError(ko ? "충돌하는 Goal 조건을 수정해야 적용할 수 있습니다." : "Change the conflicting Goal objective or criteria before applying.");
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.automations.reviewStrategyProposal({
        automationId: row.automationId,
        proposalId: row.id,
        decision,
        ...(decision === "apply" && row.goalAmendmentRequired && draft && row.goalRevision !== null && row.goalRunVersion !== null
          ? { goalAmendment: {
            text: draft.text,
            objective: draft.objective,
            acceptanceCriteria: draft.acceptanceCriteria,
            expectedGoalRevision: row.goalRevision,
            expectedRunVersion: row.goalRunVersion,
          } } : {}),
      });
      if (!result.ok) {
        setError(result.code === "stale"
          ? (ko ? "그동안 실행 계획이 바뀌었습니다. 최신 변경안을 다시 확인해 주세요." : "The plan changed in the meantime. Review the latest proposal.")
          : result.code === "not_applicable"
            ? (ko ? "이 변경안은 현재 적용할 수 없습니다." : "This proposal cannot be applied right now.")
            : (ko ? "처리 결과를 확인하지 못했습니다. 내역을 새로고침해 주세요." : "Could not confirm the decision. Refresh the history."));
        return;
      }
      dismissedRef.current.add(fingerprint(result.proposal));
      writeDismissed(dismissedRef.current);
      candidateRef.current = null;
      setCandidate(null);
      setAmendments((current) => { const next = { ...current }; delete next[row.id]; return next; });
      void load();
    } catch {
      setError(ko ? "처리 결과를 확인하지 못했습니다. 저장된 상태를 다시 확인해 주세요." : "Could not confirm the result. Check the saved state again.");
    } finally {
      setBusy(false);
    }
  }

  if (!candidate) return null;
  const draft = amendmentFor(candidate);
  const reason = unavailableReason(candidate, ko);
  const hasNext = pendingRows.some((row) => row.id !== candidate.id);

  return (
    <ComposerDecisionPortal enabled>
      <div className={styles.wrap} data-testid="automation-strategy-approval-sheet" role="alertdialog" aria-live="assertive" aria-label={ko ? "전략 변경 승인 필요" : "Strategy change approval needed"}>
        <section className={styles.sheet}>
          <div className={styles.head}>
            <div className={styles.headCopy}>
              <span className={styles.kicker}>{ko ? "결제 승인 필요" : "Payment approval needed"}</span>
              <h2>{ko ? "결제가 필요한 전략 변경" : "A strategy change needs payment approval"}</h2>
              <p>{candidate.automationName || (ko ? "자동화" : "Automation")}{hasNext && ` · ${ko ? `대기 ${pendingRows.length}건` : `${pendingRows.length} waiting`}`}</p>
            </div>
            <button type="button" className={styles.close} onClick={() => dismiss()} aria-label={ko ? "나중에 확인" : "Review later"}>×</button>
          </div>

          <div className={styles.summary}>
            <strong>{candidate.summary}</strong>
            {candidate.rationale !== candidate.summary && <p>{candidate.rationale}</p>}
            {candidate.reviewReason && <p className={styles.reason}>{candidate.reviewReason}</p>}
          </div>

          {candidate.changes.length > 0 && (
            <details className={styles.diff} open>
              <summary>{ko ? "변경 내용" : "What changes"}</summary>
              {candidate.changes.map((change, index) => <div key={`${change.label}:${index}`} className={styles.change}>
                <strong>{change.label}</strong>
                {change.before !== null && <><small>{ko ? "현재" : "Current"}</small><pre>{change.before}</pre></>}
                <small>{ko ? "제안" : "Proposed"}</small><pre>{change.after}</pre>
              </div>)}
            </details>
          )}

          {candidate.goalAmendmentRequired && (
            <div className={styles.amendment}>
              <strong>{ko ? "Goal 조건도 함께 확인해야 합니다" : "The Goal contract also needs your decision"}</strong>
              <p>{ko ? "원문 요청은 보존됩니다. 아래 승인 문장과 새 목표·기준을 직접 확인해 주세요." : "The original request stays immutable. Confirm the approval statement and the revised objective and criteria below."}</p>
              <details className={styles.currentGoal}>
                <summary>{ko ? "현재 Goal 조건" : "Current Goal conditions"}</summary>
                <strong>{candidate.goalObjective}</strong>
                <ul>{candidate.goalAcceptanceCriteria.map((criterion) => <li key={criterion.id}>{criterion.id}: {criterion.text}</li>)}</ul>
              </details>
              <label>{ko ? "사용자 승인 문장" : "Your approval statement"}
                <textarea value={draft.text} onChange={(event) => updateAmendment(candidate, { text: event.target.value })}
                  placeholder={ko ? "예: 이 전략 변경을 승인하고 아래 Goal 조건으로 계속 진행합니다." : "Example: I approve this strategy change and the Goal conditions below."} />
              </label>
              <label>{ko ? "적용할 Goal 목표" : "Goal objective to apply"}
                <textarea value={draft.objective} onChange={(event) => updateAmendment(candidate, { objective: event.target.value })} />
              </label>
              <fieldset>
                <legend>{ko ? "적용할 Goal 기준" : "Goal criteria to apply"}</legend>
                {draft.acceptanceCriteria.map((criterion, index) => <div className={styles.criterion} key={`${candidate.id}:criterion:${index}`}>
                  <input value={criterion.id} onChange={(event) => updateCriterion(candidate, index, "id", event.target.value)} aria-label={`${ko ? "기준 ID" : "Criterion ID"} ${index + 1}`} />
                  <input value={criterion.text} onChange={(event) => updateCriterion(candidate, index, "text", event.target.value)} aria-label={`${ko ? "기준" : "Criterion"} ${index + 1}`} />
                </div>)}
              </fieldset>
            </div>
          )}

          {reason && <p className={styles.unavailable}>{reason}</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => dismiss()}>{ko ? "나중에 확인" : "Review later"}</button>
            <button type="button" className={styles.reject} disabled={busy} onClick={() => void review(candidate, "reject")}>{ko ? "적용하지 않기" : "Do not apply"}</button>
            <button type="button" className={styles.primary} disabled={busy || (!candidate.canApply && !candidate.goalAmendmentRequired)} onClick={() => void review(candidate, "apply", candidate.goalAmendmentRequired ? draft : undefined)}>
              {busy ? (ko ? "처리 중…" : "Working…") : candidate.goalAmendmentRequired ? (ko ? "Goal 변경과 함께 적용" : "Apply with Goal change") : (ko ? "이 변경 적용" : "Apply this change")}
            </button>
          </div>
        </section>
      </div>
    </ComposerDecisionPortal>
  );
}
