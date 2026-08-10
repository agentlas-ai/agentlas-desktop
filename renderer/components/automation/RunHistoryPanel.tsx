"use client";
// 실행 기록 + "확인 필요" 처리. 이 패널의 계약: 확인이 필요하다고 말할 때는 반드시
// (1) 무엇이 멈췄는지 실제 사유와 (2) 사용자가 지금 누를 수 있는 행동을 함께 준다.
// 사유도 행동도 없는 "확인이 필요해요"는 사용자를 막다른 길에 세운다.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { askAutomationSession } from "@/components/automation/AutomationSessionPanel";
import type {
  Automation,
  AutomationFixOption,
  AutomationFixPlan,
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
  const [reconciling, setReconciling] = useState(false);
  const [eventActionId, setEventActionId] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [fixPlan, setFixPlan] = useState<AutomationFixPlan | null>(null);
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixMessage, setFixMessage] = useState("");

  /* ★"눌렀는데 아무 일도 안 일어남"을 구조적으로 금지한다.
     어떤 행동이든 (1) 실행하고 (2) 다시 읽는다. 조용히 그대로 두면 사용자는 같은
     버튼을 다시 누르고, 그게 "아무리 눌러도 안 된다"의 정체였다. */
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
      setAttentions(nextAttentions);
    } catch (err) {
      setMessage(ko ? "실행 기록을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요." : "Could not load run history. Try again shortly.");
    }
    if (!automation.graph || !snap || snap.status !== "error") {
      setReconciliation(null);
      return;
    }
    try {
      const nextReconciliation = await api.automations.getGraphReconciliation(automation.id);
      setReconciliation(nextReconciliation);
      setRecoveryError("");
    } catch (err) {
      setReconciliation(null);
      setRecoveryError(reconciliationErrorMessage(err, ko));
    }
  }, [automation.graph, automation.id, compact, ko]);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => void load(), POLL_MS);

  // 복구 계획은 모델 호출을 포함하므로 폴링하지 않는다. 확인이 필요한 상태가 됐을 때 한 번,
  // 그리고 조치를 실행한 뒤 다시 계산한다.
  const loadFixPlan = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      setFixPlan(await api.automations.planFix(automation.id));
    } catch {
      setFixPlan(null);
    }
  }, [automation.id]);

  useEffect(() => {
    const drafts: Record<string, NodeDecisionDraft> = {};
    for (const node of reconciliation?.nodes ?? []) drafts[node.nodeId] = { output: "" };
    setNodeDecisions(drafts);
  }, [reconciliation?.checkpointDigest, reconciliation?.runId]);

  const current = useMemo(() => summarizeSnapshot(latest, ko), [latest, ko]);
  // 가장 최근 성공 실행의 시각. 이보다 앞선 미확인 건은 "지금 확인이 필요한 상태"가
  // 아니다 — 그 뒤로 같은 자동화가 정상 완주했기 때문이다. 기록은 남기되 현재 상태로
  // 올리지 않는다.
  const lastOkAt = useMemo(() => {
    // ★"성공"은 끝까지 돌았고 **결과도 수용된** 실행이다.
    // 칸을 나눈 뒤 status==="ok" 만 보면, 판정이 "사람이 정해야 한다"고 본 실행까지
    // 성공으로 세어 확인 배지를 꺼버린다. outcome이 없는 옛 기록은 예전대로 센다.
    const oks = runs
      .filter((run) => run.status === "ok"
        && (run.outcome === null || run.outcome === "accepted" || run.outcome === "unjudged"))
      .map((run) => Date.parse(run.ranAt)).filter(Number.isFinite);
    return oks.length > 0 ? Math.max(...oks) : null;
  }, [runs]);
  const regularAttentions = useMemo(
    () => attentions.filter((attention) => {
      if (attention.id === reconciliation?.triggerEvent?.id) return false;
      if (lastOkAt === null) return true;
      const at = Date.parse(attention.updatedAt);
      // 파싱 불가한 시각은 숨기지 않는다: 판단 근거가 없으면 사용자에게 보여주는 쪽이 안전하다.
      return !Number.isFinite(at) || at > lastOkAt;
    }),
    [attentions, reconciliation?.triggerEvent?.id, lastOkAt],
  );
  // 밀려난 건을 여기서 따로 렌더하지 않는 이유: 아래 실행 기록 목록에 그 실행이
  // 그대로 남아 있어 사용자가 언제든 확인할 수 있다. 사라지는 것은 "지금 조치하라"는
  // 요구뿐이고, 기록은 사라지지 않는다.
  // 사용자가 화면에서 실제로 읽을 수 있는 마지막 미완료 실행 — "확인 필요"의 근거.
  // "확인 필요"는 자동화의 현재 상태여야 한다. 이전에는 이력 어디에든 실패가 하나라도
  // 있으면 find()가 그것을 집어 배지를 영구히 켰고, 그 뒤 몇 번을 성공해도 꺼지지
  // 않았다(오너 보고 2026-08-03: 세 번 연속 완주한 자동화가 09:35 부분완료 때문에
  // 계속 "확인 필요"로 표시됨). 마지막 성공 이후에 일어난 실패만 현재 상태다.
  const blockingRun = useMemo(
    () => runs.find((run) => {
      // 사용자가 이미 닫은 요구는 다시 올리지 않는다 — 기록은 아래 목록에 그대로 있다.
      // (오너 보고 2026-08-06: 옛 핀 시절 실행의 "클로드 재로그인" 카드가 해소 수단
      // 없이 눌러앉았다. 그 뒤 성공 실행이 없으면 lastOkAt 규칙만으로는 영원히 남는다.)
      if (run.acknowledgedAt) return false;
      // 실행 상태가 멀쩡해도 판정이 "사람이 정해야 한다"면 그것도 확인이 필요한 상태다.
      // 두 답이 한 칸에 있던 때는 자동으로 걸렸지만, 칸을 나눈 뒤로는 둘 다 봐야 한다.
      const needsAttention = run.status === "error" || run.status === "needs_input"
        || run.status === "blocked" || run.status === "partial"
        || run.outcome === "needs_input" || run.outcome === "blocked" || run.outcome === "rejected";
      if (!needsAttention) return false;
      if (lastOkAt === null) return true;
      const at = Date.parse(run.ranAt);
      return !Number.isFinite(at) || at > lastOkAt;
    }) ?? null,
    [runs, lastOkAt],
  );
  // 캔버스가 이미 "어느 단계에서, 왜, 무엇을 누르면 되는지"를 띄우고 있으면 이 패널은
  // 같은 실행을 다른 말로 또 설명하지 않는다. 예전에는 한 화면에서 캔버스는
  // "확인이 필요합니다 — 아직 실행하지 않았습니다"라고 하고, 이 패널은
  // "끝까지 완료되지 않았어요"라고 해서, 한 상황에 설명 두 개와 버튼 네 개가 동시에 떴다.
  // ★캔버스가 결정권을 갖는 것은 **사람의 결정이 필요한 실패**(채점표 수정·입력 요구)뿐이다.
  //   예전에는 노드 실패가 하나라도 있으면 이 패널이 통째로 꺼졌는데, 환경 오류(브라우저 안 뜸·
  //   로그인 풀림)는 **항상** 노드 실패를 만들므로 — 정확히 수리 버튼이 필요한 순간에만
  //   [로그인 창 열기]·[실행 환경 복구]가 절대 나타나지 않았다.
  //   (승인 게이트는 오너 이사회 결정 2026-08-10 으로 폐지 — APPROVAL_* 는 더 이상 나오지 않는다.
  //    EVAL_STUCK·NODE_INPUT_MISSING 은 승인이 아니라 진짜 입력/판정 요구라 남는다.)
  const DECISION_CODES = new Set(["EVAL_STUCK", "NODE_INPUT_MISSING"]);
  const failureCodes = Object.values(latest?.nodeFailures ?? {}).map((f) => f?.code).filter(Boolean);
  const canvasOwnsDecision = failureCodes.length > 0 && failureCodes.every((code) => DECISION_CODES.has(code));
  // 최신 스냅샷의 error도, 사용자가 그보다 뒤에 요구를 닫았다면 다시 올리지 않는다 —
  // 닫기가 blockingRun만 끄고 이 절이 카드를 되살리면 닫기 버튼은 거짓말이 된다.
  // (run_history의 id와 스냅샷 runId는 다른 체계라 id로는 이을 수 없다 — 시각으로 잇는다.
  //  닫기 이후 새로 시작해 실패한 실행은 startedAt이 닫은 시각보다 뒤라 다시 뜬다.)
  /* 닫기가 남긴 시각 이전에 시작된 실행의 요구는 종류와 무관하게 닫힌 것으로 본다.
     예전에는 run_history 행으로만 판단해서, 스냅샷의 error 로 떠 있는 카드는
     닫아도 그대로 남았다 — 끌 수 없는 카드가 곧 막다른 길이다. */
  const clearedAt = automation.attentionClearedAt
    ? Date.parse(automation.attentionClearedAt)
    : Number.NEGATIVE_INFINITY;
  const latestClearedByUser = Boolean(
    latest && Number.isFinite(clearedAt) && Date.parse(latest.startedAt) <= clearedAt,
  );
  const latestAcknowledged = latestClearedByUser || Boolean(
    latest && runs.some((run) => {
      const acked = run.acknowledgedAt ? Date.parse(run.acknowledgedAt) : NaN;
      const started = Date.parse(latest.startedAt);
      return Number.isFinite(acked) && Number.isFinite(started) && acked >= started;
    }),
  );
  /* ★두 가지 규칙이 여기서 카드를 끈다. 둘 다 케이스가 아니라 일반 규칙이다.

     ① **지금 돌고 있으면 옛 실행 이야기를 하지 않는다.**
        실측(오너 녹화 2026-08-09): 상태줄은 "실행 중 2/6", 로그는 정상 진행 중인데
        옆 카드는 3일 전 실행을 근거로 "확인이 필요해요"를 외치고 있었다. 지금 답이
        만들어지는 중인 질문을 사람에게 떠넘기는 것이다. 끝나면 그때 사실로 말한다.

     ② **커널의 사실이 판정의 서술을 이긴다.**
        실측: 커널은 `automation_runs` 에 전 단계 done · status=ok 를 적었는데,
        판정 모델은 같은 실행을 `run_history` 에 "권한 설정이 부족하여 …"로 적었다.
        화면이 후자를 헤드라인으로 쓰면 성공한 실행이 실패로 보인다. 마지막 실행이
        기계 기준으로 성공이면 그 실행에 대한 확인 요구는 올리지 않는다. */
  const liveRunning = latest?.status === "running"
    || Object.values(latest?.nodeStates ?? {}).some((state) => state === "running");
  const latestKernelOk = latest?.status === "ok"
    && Object.keys(latest?.nodeFailures ?? {}).length === 0;
  const blockingRunOpen = Boolean(blockingRun) && !(
    Number.isFinite(clearedAt) && blockingRun && Date.parse(blockingRun.ranAt) <= clearedAt
  );
  const needsHelp = !canvasOwnsDecision && !liveRunning && !latestKernelOk
    && Boolean(reconciliation || regularAttentions.length > 0
      || (latest?.status === "error" && !latestAcknowledged) || blockingRunOpen);
  // 기록 원문(판정 코드 접두사 제거). 평이한 설명 아래 "자세히"로만 노출한다.
  // 미확정 부작용이 남아 있으면 백엔드가 재실행을 즉시 거부한다(중복 게시 방지).
  // 눌리는 버튼을 두면 "눌러도 아무 일이 없다"가 된다.
  // 모델이 이미 제안한 동작은 우리 버튼과 중복이다 — actionId 로 판별한다.
  const fixOptionIds = new Set((fixPlan?.options ?? []).map((option) => option.actionId));
  const hasRetryOption = fixOptionIds.has("retry_run");
  const hasSessionOption = fixOptionIds.has("ask_in_session");
  /* 승인 게이트 폐지(오너 이사회 결정 2026-08-10) — 이 패널은 더 이상 승인을 묻지도,
     승인 대기를 감지하지도 않는다. 재실행을 막는 것은 부작용 미확정(reconciliation)뿐이다. */
  const rerunBlocked = Boolean(reconciliation);
  const rawReason = useMemo(
    () => stripReasonCode(blockingRun?.error ?? regularAttentions[0]?.lastError ?? ""),
    [blockingRun?.error, regularAttentions],
  );

  useEffect(() => {
    if (!needsHelp || fixPlan) return;
    void loadFixPlan();
  }, [fixPlan, loadFixPlan, needsHelp]);

  const graphDecisionReady = useMemo(() => {
    if (!reconciliation || reconciliation.nodes.length === 0) return false;
    return reconciliation.nodes.every((node) => {
      const draft = nodeDecisions[node.nodeId];
      if (!draft?.resolution) return false;
      return draft.resolution !== "completed" || !node.outputRequired || draft.output.trim().length > 0;
    });
  }, [nodeDecisions, reconciliation]);

  function chooseNodeResolution(nodeId: string, resolution: AutomationGraphReconciliationDecision["resolution"]) {
    setNodeDecisions((drafts) => ({ ...drafts, [nodeId]: { output: drafts[nodeId]?.output ?? "", resolution } }));
  }

  function setNodeOutput(nodeId: string, output: string) {
    setNodeDecisions((drafts) => ({ ...drafts, [nodeId]: { ...drafts[nodeId], output } }));
  }

  /** 멈춘 사유를 그대로 세션 대화에 넘겨 이어서 해결하게 한다(같은 화면 왼쪽 패널).
   *  세션 패널이 없는 화면(자동화 상세)에서는 플로우 화면으로 이동해 그대로 이어진다. */
  function continueInSession() {
    // 대화에 넘길 때도 내부 판정 코드는 뗀다 — 사용자가 자기 말로 읽을 수 있어야 한다.
    const reason = stripReasonCode(blockingRun?.error ?? regularAttentions[0]?.lastError ?? "");
    const prompt = ko
      ? `이 자동화의 마지막 실행이 끝까지 완료되지 않았어요.\n\n기록된 사유:\n${reason || "(사유 기록 없음)"}\n\n원인을 확인하고, 지금 할 수 있는 조치를 알려준 뒤 가능하면 이어서 해결해 주세요.`
      : `The last run of this automation did not complete.\n\nRecorded reason:\n${reason || "(no reason recorded)"}\n\nDiagnose it, tell me what I can do now, and continue from here if you can.`;
    const handled = askAutomationSession({ automationId: automation.id, text: prompt, send: true });
    if (!handled) navigate(`/automation/flow?id=${encodeURIComponent(automation.id)}`);
  }

  /** 실행 가능한 조치를 실제로 실행 — 로그인 창, macOS 설정, 실행 환경 복구 등. */
  async function applyFix(option: AutomationFixOption) {
    const api = ipc();
    if (!api || fixBusy) return;
    if (option.kind === "ask_in_session") {
      continueInSession();
      return;
    }
    setFixBusy(option.actionId);
    setFixMessage("");
    try {
      const result = await api.automations.applyFix(automation.id, option.actionId);
      setFixMessage(result.message);
      if (result.navigate) navigate(result.navigate);
      await load();
      await loadFixPlan();
    } catch (err) {
      setFixMessage(rerunFailureMessage(err, ko));
    } finally {
      setFixBusy(null);
    }
  }

  async function rerun() {
    const api = ipc();
    if (!api || rerunning) return;
    setRerunning(true);
    setMessage("");
    try {
      await api.automations.runNow(automation.id);
      setMessage(ko ? "다시 실행을 시작했습니다." : "Started another run.");
      await load();
    } catch (err) {
      setMessage(rerunFailureMessage(err, ko));
    } finally {
      setRerunning(false);
    }
  }

  async function submitGraphReconciliation() {
    const api = ipc();
    if (!api || !reconciliation || reconciling || !graphDecisionReady) return;
    const completedCount = reconciliation.nodes.filter((node) => nodeDecisions[node.nodeId]?.resolution === "completed").length;
    const retryCount = reconciliation.nodes.length - completedCount;
    const confirmed = window.confirm(
      ko
        ? `실제 외부 상태를 확인했습니까? 완료 ${completedCount}개, 재시도 ${retryCount}개로 확정합니다. 잘못 선택하면 중복 동작이 생길 수 있습니다.`
        : `Did you verify the real external state? This will confirm ${completedCount} completed and ${retryCount} to retry. A wrong choice can duplicate an external action.`,
    );
    if (!confirmed) return;
    setReconciling(true);
    setRecoveryError("");
    try {
      const decisions: AutomationGraphReconciliationDecision[] = reconciliation.nodes.map((node) => {
        const draft = nodeDecisions[node.nodeId];
        return {
          nodeId: node.nodeId,
          resolution: draft.resolution!,
          ...(draft.resolution === "completed" && draft.output.length > 0 ? { output: draft.output } : {}),
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
      setMessage(
        result.resumeRequired
          ? ko
            ? "확인 내용을 저장했습니다. 남은 노드를 안전하게 다시 시작합니다."
            : "Saved the confirmation. Safely resuming the remaining nodes."
          : ko
            ? "확인 내용을 저장했습니다. 이 발생은 완료 처리됐습니다."
            : "Saved the confirmation. This occurrence is complete.",
      );
    } catch (err) {
      setRecoveryError(reconciliationErrorMessage(err, ko));
    } finally {
      setReconciling(false);
    }
  }

  async function reconcileEvent(attention: AutomationTriggerEventAttention, resolution: "completed" | "retry") {
    const api = ipc();
    if (!api || eventActionId) return;
    const confirmed = window.confirm(
      resolution === "completed"
        ? ko
          ? "외부 동작이 실제로 완료된 것을 확인했습니까? 이 발생은 다시 실행하지 않습니다."
          : "Did you verify that the external action completed? This occurrence will not run again."
        : ko
          ? "외부 동작이 실행되지 않은 것을 확인했습니까? 이 발생을 다시 시도합니다."
          : "Did you verify that the external action did not run? This occurrence will be retried.",
    );
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
      setMessage(
        resolution === "completed"
          ? ko
            ? "발생을 완료 처리했습니다."
            : "Marked the occurrence complete."
          : ko
            ? "발생을 다시 대기열에 넣었습니다."
            : "Queued the occurrence for retry.",
      );
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
          <div className="automation-run-kicker">{ko ? "자동화" : "Automation"}</div>
          <strong>{current.title}</strong>
        </div>
        <span>{needsHelp ? (ko ? "확인 필요" : "Needs review") : ko ? "실행 기록" : "Run history"}</span>
      </div>

      {latest ? (
        <div className="automation-run-snapshot" data-status={latest.status}>
          <span>{formatDateTime(latest.startedAt, ko)}</span>
          <span>{current.detail}</span>
          {/* ★이 실행이 쓴 토큰. 커널은 처음부터 세고 있었는데 읽는 곳이 없어 화면이 몰랐다 —
              매일 도는 자동화가 얼마를 쓰는지 모른 채 켜 두게 된다. 금액은 모델마다 달라
              지어내지 않고, 세어 둔 숫자만 그대로 보여준다. */}
          {typeof latest.tokensUsed === "number" && latest.tokensUsed > 0 ? (
            <span data-testid="run-tokens">
              {ko ? `토큰 ${latest.tokensUsed.toLocaleString()}` : `${latest.tokensUsed.toLocaleString()} tokens`}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="automation-run-empty">{ko ? "아직 실행 기록이 없어요." : "No runs yet."}</div>
      )}

      {/* 확인 필요 — 무슨 일인지 평이한 말로 먼저, 기록 원문은 접어서. 사용자가 읽고
          바로 무엇을 할지 알 수 없는 문장을 카드 본문에 그대로 싣지 않는다. */}
      {needsHelp ? (
        <section className="automation-reconcile-card" role="status">
          <div className="automation-reconcile-head">
            <div>
              <span>{ko ? "확인이 필요해요" : "Needs attention"}</span>
              <strong>{blockingRun ? plainRun(blockingRun, ko).title : plainOutcome("error", ko).title}</strong>
            </div>
          </div>
          {/* 상황 설명은 제품이 실제 상태(브라우저 세션·권한·로그인·런타임)를 보고 만든 문장을
              우선한다. 계산이 아직/불가면 상태 기반 기본 문장으로 내려간다. */}
          <p>{fixPlan && !fixPlan.unavailable && fixPlan.summary
            ? fixPlan.summary
            : blockingRun ? plainRun(blockingRun, ko).body : plainOutcome("error", ko).body}</p>
          {fixPlan?.question ? <p className="automation-fix-question">{fixPlan.question}</p> : null}
          {/* 모델 제안과 우리 버튼이 같은 동작이면 하나만 남긴다(아래 주석 참조). */}
          <div className="automation-reconcile-actions">
            {/* 실행 가능한 조치 — 로그인 창 열기, macOS 설정 열기, 실행 환경 복구처럼
                누르면 진짜로 그 일이 일어나는 버튼만 나온다. */}
            {(fixPlan?.options ?? []).map((option) => (
              <button
                key={option.actionId}
                type="button"
                data-confirm={option.requiresConfirmation ? "true" : "false"}
                disabled={fixBusy !== null}
                onClick={() => void applyFix(option)}
              >
                {fixBusy === option.actionId ? (ko ? "진행 중…" : "Working…") : option.label}
              </button>
            ))}
            {/* ★모델이 같은 동작을 이미 제안했으면 우리 버튼은 빼야 한다.
                실측(2026-08-09 녹화): fixPlan 이 retry_run·ask_in_session 을 고르면
                이 카드에 버튼이 5개가 뜨는데 그중 4개가 2쌍의 중복이었다.
                힉의 법칙 — 선택지가 늘수록 결정 시간이 늘고, 같은 일을 하는 두 버튼은
                선택지가 아니라 의심거리다. 문맥에 맞는 라벨을 가진 모델 옵션을 남긴다. */}
            {!hasSessionOption ? (
              <button type="button" onClick={continueInSession}>
                {ko ? "대화에서 이어서 해결" : "Continue in the session"}
              </button>
            ) : null}
            {!hasRetryOption ? (
            <button
              type="button"
              onClick={() => void rerun()}
              disabled={rerunning || rerunBlocked}
              title={rerunBlocked
                ? (ko
                    ? "아래에서 각 단계가 실제로 실행됐는지 먼저 확정해 주세요. 그 전에 다시 실행하면 같은 동작이 두 번 일어날 수 있어 막아 둡니다."
                    : "Confirm below whether each step actually ran. Until then a rerun could repeat the same action, so it is blocked.")
                : undefined}
            >
              {rerunning ? (ko ? "시작하는 중…" : "Starting…") : ko ? "지금 다시 실행" : "Run again now"}
            </button>
            ) : null}
          </div>
          {rerunBlocked ? (
            <p className="automation-fix-result">
              {ko
                ? "아래에서 실제 실행 여부를 확정하기 전에는 다시 실행할 수 없어요 — 같은 동작이 두 번 일어나는 걸 막기 위해서예요."
                : "A rerun is held until you confirm below what actually ran — this prevents the same action from happening twice."}
            </p>
          ) : null}
          {fixMessage ? <p className="automation-fix-result" role="status">{fixMessage}</p> : null}
          {rawReason ? (
            <details className="automation-raw-record">
              <summary>{ko ? "기록 원문 보기" : "Show the raw record"}</summary>
              <p>{rawReason}</p>
            </details>
          ) : null}
        </section>
      ) : null}

      {/* 외부 동작의 완료 여부가 불확실한 실행 — 사람이 직접 확정해야 재개된다. */}
      {reconciliation ? (
        <section className="automation-reconcile-card" aria-labelledby={`reconcile-${reconciliation.runId}`}>
          <div className="automation-reconcile-head">
            <div>
              <span>{ko ? "확인이 필요해요" : "Needs attention"}</span>
              <strong id={`reconcile-${reconciliation.runId}`}>
                {ko ? "이 단계가 실제로 실행됐는지 알려주세요" : "Tell us whether this step actually happened"}
              </strong>
            </div>
          </div>
          <p>
            {ko
              ? "앱이 꺼지거나 응답이 끊겨서, 아래 단계가 끝났는지 확정하지 못했어요. 실제 결과(예: 올라간 글, 저장된 파일)를 먼저 확인한 뒤 골라 주세요. 잘못 고르면 같은 동작이 한 번 더 일어날 수 있어요."
              : "The app closed or the response was lost, so we could not confirm whether the step below finished. Check the real result first — a posted message, a saved file — then choose. A wrong choice can repeat the action."}
          </p>
          {reconciliation.triggerEvent ? (
            <div className="automation-reconcile-event-note">
              {ko
                ? "이 결정으로 대기 중이던 같은 건도 함께 정리됩니다."
                : "The pending occurrence bound to this run is settled by the same choice."}
            </div>
          ) : null}

          <div className="automation-reconcile-node-list">
            {reconciliation.nodes.map((node) => {
              const draft = nodeDecisions[node.nodeId] ?? { output: "" };
              return (
                <fieldset key={node.nodeId} className="automation-reconcile-node">
                  <legend>
                    <strong>{node.label}</strong>
                    <span>
                      {node.uncertainty === "ambiguous"
                        ? ko
                          ? "끝났는지 알 수 없어요"
                          : "we cannot tell if it finished"
                        : ko
                          ? "도중에 끊겼어요"
                          : "it was cut off mid-run"}
                    </span>
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
            {reconciling ? (ko ? "저장 중..." : "Saving...") : ko ? "확정하고 안전하게 계속" : "Confirm and continue safely"}
          </button>
        </section>
      ) : null}

      {regularAttentions.length > 0 ? (
        <section
          className="automation-event-attention-list"
          aria-label={ko ? "확인이 필요한 자동화 발생" : "Automation occurrences requiring review"}
        >
          {regularAttentions.map((attention) => (
            <article key={attention.id} className="automation-event-attention">
              <div>
                <strong>{ko ? "이 건이 실제로 처리됐는지 알려주세요" : "Tell us whether this one went through"}</strong>
                <span>{formatDateTime(attention.updatedAt, ko)}</span>
              </div>
              <p>
                {ko
                  ? "자동으로 다시 시도하면 같은 동작이 두 번 일어날 수 있어 멈춰 뒀어요. 실제 결과를 확인한 뒤 골라 주세요."
                  : "Retrying automatically could repeat the same action, so it is on hold. Check the real result, then choose."}
              </p>
              {attention.lastError?.trim() ? (
                <details className="automation-raw-record">
                  <summary>{ko ? "기록 원문 보기" : "Show the raw record"}</summary>
                  <p>{stripReasonCode(attention.lastError)}</p>
                </details>
              ) : null}
              <div className="automation-event-attention-actions">
                <button type="button" disabled={eventActionId !== null} onClick={() => void reconcileEvent(attention, "completed")}>
                  {ko ? "이미 완료됨 — 재실행 안 함" : "Already completed — do not rerun"}
                </button>
                <button type="button" disabled={eventActionId !== null} onClick={() => void reconcileEvent(attention, "retry")}>
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
            <article key={run.id} className="automation-run-row" data-status={run.status} data-outcome={run.outcome ?? undefined}>
              <div>
                {/* ★승인 대기로 멈춘 실행을 "실패"라고 부르지 않는다 — 아무것도 실패하지
                    않았고 사람을 기다렸을 뿐이다. 잘못된 이름은 사용자가 원인을 엉뚱한
                    곳에서 찾게 만든다(오너 실측: 승인 대기 실행이 목록에 "실패"로 떴다). */}
                {/* ★머리말은 **기계 칸**으로 정한다(문장 파싱 금지).
                    status 는 "기계가 끝까지 갔는가", outcome 은 "그 결과가 무엇인가"다.
                    사람이 정해야 끝나는 실행(outcome=needs_input)을 "실패"라고 부르면
                    사용자는 고장 난 줄 알고 원인을 엉뚱한 데서 찾는다 — 아무것도
                    실패하지 않았고 우리가 기다린 것뿐이다. */}
                <strong>{outcomeFirstLabel(run, ko)}</strong>
                {/* ★두 답을 한 칸에 뭉개지 않는다. 예전에는 판정 결과가 실행 상태를
                    덮어써서, 끝까지 잘 돈 실행이 목록에 "내 확인 필요"로만 보였다 —
                    사용자는 성공인지 실패인지 알 수 없었다. 이제 나란히 놓는다. */}
                {outcomeChip(run, ko) ? (
                  <span className="automation-run-outcome">{outcomeChip(run, ko)}</span>
                ) : null}
                <span>{formatDateTime(run.ranAt, ko)}</span>
              </div>
              {/* 목록은 평이한 한 줄만. 기록 원문은 접어서 따로 — 둘 다 남기되 순서를 지킨다. */}
              {run.error || run.outcomeReason ? (
                <>
                  <p>{plainRun(run, ko).body}</p>
                  <details className="automation-raw-record">
                    <summary>{ko ? "기록 원문 보기" : "Show the raw record"}</summary>
                    <p>{stripReasonCode(run.error ?? run.outcomeReason ?? "")}</p>
                  </details>
                </>
              ) : run.skippedCount > 0 ? (
                <p>{ko ? "놓친 예약을 한 번으로 합쳐 실행했어요." : "Missed schedules were combined into one run."}</p>
              ) : null}
            </article>
          ))
        )}
      </div>

      {recoveryError ? (
        <div className="automation-run-message" role="alert">
          {recoveryError}
        </div>
      ) : null}
      {message ? (
        <div className="automation-run-message" role="status">
          {message}
        </div>
      ) : null}
    </section>
  );
}

/** 재실행 실패를 사람 말로 — main이 던지는 코드 문자열을 그대로 노출하지 않는다. */
function rerunFailureMessage(error: unknown, ko: boolean): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/reconciliation_pending|ambiguous_side_effect|reconciliation required/i.test(raw)) {
    return ko
      ? "아래에서 실제 실행 여부를 먼저 확정해 주세요. 확정 전에는 같은 동작이 두 번 일어날 수 있어 다시 실행하지 않습니다."
      : "Confirm below what actually ran first. Until then a rerun could repeat the same action, so it is held.";
  }
  return ko ? "다시 실행하지 못했어요. 잠시 뒤 다시 시도해 주세요." : "The run could not start. Try again shortly.";
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
  if (!snap)
    return {
      title: ko ? "아직 실행 전이에요" : "Not run yet",
      detail: ko ? "실행하면 결과가 여기에 표시됩니다." : "The result will appear here after it runs.",
    };
  const states = Object.values(snap.nodeStates ?? {});
  const running = states.filter((state) => state === "running").length;
  const failed = states.filter((state) => state === "failed").length;
  const skipped = states.filter((state) => state === "skipped").length;
  if (snap.status === "running" || running > 0) {
    return {
      title: ko ? "작업하고 있어요" : "Working on it",
      detail: ko ? "필요한 단계를 순서대로 진행하고 있어요." : "The required steps are running in order.",
    };
  }
  if (snap.status === "error" || failed > 0) {
    return {
      title: ko ? "끝까지 완료되지 않았어요" : "Not fully completed",
      detail: ko ? "완료로 처리하지 않았어요." : "It was not marked complete.",
    };
  }
  return {
    title: ko ? "완료했어요" : "Completed",
    detail:
      skipped > 0
        ? ko
          ? "필요 없는 단계는 건너뛰고 결과를 만들었어요."
          : "Unneeded steps were skipped and the result is ready."
        : ko
          ? "요청한 작업을 마쳤어요."
          : "The requested work is complete.",
  };
}

/**
 * 실행 결과를 사람 말로. 기록에 남는 판정 문장은 영어 기술 문장인 경우가 많아
 * (예: "halted pending reconciliation of an ambiguous side effect at the verify node")
 * 그대로 띄우면 읽고도 뭘 해야 할지 모른다. 상태는 제품이 스스로 내린 판정이므로
 * 그것을 근거로 평이한 설명을 만들고, 원문은 "기록 원문 보기"에만 남긴다.
 */
function plainOutcome(status: AutomationRunRecord["status"], ko: boolean): { title: string; body: string } {
  if (status === "needs_input") {
    return {
      title: ko ? "내가 정해줘야 진행돼요" : "It needs a decision from you",
      body: ko
        ? "사람이 정해야 하는 부분이 있어 멈췄어요. 정해주면 이어서 진행합니다."
        : "It stopped because a person has to decide something. It will continue once you decide.",
    };
  }
  if (status === "blocked") {
    return {
      title: ko ? "바깥 문제로 막혔어요" : "Something outside blocked it",
      body: ko
        ? "로그인이 풀렸거나 상대 서비스가 막고 있어 더 못 갔어요. 자동화는 그대로 켜져 있어요."
        : "A sign-in expired or the other service refused, so it could not go further. The automation is still on.",
    };
  }
  if (status === "partial") {
    return {
      title: ko ? "일부만 됐어요" : "Only part of it got done",
      body: ko
        ? "일부는 처리했지만 목표까지 가지 못했어요. 남은 부분만 이어서 하면 됩니다."
        : "Some work landed but it did not reach the goal. Only the rest is left.",
    };
  }
  if (status === "skipped") {
    return {
      title: ko ? "할 일이 없었어요" : "There was nothing to do",
      body: ko ? "이번엔 처리할 대상이 없어 건너뛰었어요." : "Nothing was eligible this time, so it was skipped.",
    };
  }
  if (status === "ok") {
    return {
      title: ko ? "완료했어요" : "Completed",
      body: ko ? "요청한 작업을 마쳤어요." : "The requested work is complete.",
    };
  }
  return {
    title: ko ? "끝까지 완료되지 않았어요" : "It did not finish",
    body: ko
      ? "중간에 멈춰서 완료로 처리하지 않았어요. 아래 대화에서 원인을 확인하고 이어서 해결할 수 있어요."
      : "It stopped partway and was not marked complete. Diagnose and continue in the session.",
  };
}

/** `[controller_judged] …` 같은 내부 판정 코드 접두사 제거 — 사용자가 쓸 수 없는 정보다. */
function stripReasonCode(error: string): string {
  return error.replace(/^\s*\[[a-z0-9_.:-]+\]\s*/i, "").trim();
}

/**
 * 판정의 답을 짧은 꼬리표로. **실행 상태와 다른 질문의 답**이라 자리를 따로 준다.
 * `null`(옛 기록·판정 안 함)이면 아무 말도 하지 않는다 — 모르는 것을 "괜찮음"으로 메꾸면
 * 그게 바로 이 화면이 지금까지 사용자를 헷갈리게 한 방식이다.
 */
function outcomeChip(run: AutomationRunRecord, ko: boolean): string | null {
  switch (run.outcome) {
    case "accepted":
      return null;   // 잘 됐고 결과도 쓸 만하다 — 굳이 덧붙이지 않는다.
    case "needs_input":
      return ko ? "내 확인 필요" : "Needs your decision";
    case "blocked":
      return ko ? "바깥에서 막힘" : "Blocked outside";
    case "rejected":
      return ko ? "결과가 기준에 못 미침" : "Result fell short";
    case "unjudged":
      return ko ? "결과 판정 못 함" : "Result not judged";
    default:
      return null;
  }
}

/** 실행 상태와 판정 결과를 함께 읽어 사람 말로. 판정이 있으면 그쪽이 할 말이 더 많다. */
function plainRun(run: AutomationRunRecord, ko: boolean): { title: string; body: string } {
  if (run.status === "ok" && run.outcome && run.outcome !== "accepted") {
    if (run.outcome === "needs_input") {
      return {
        title: ko ? "끝까지 돌았고, 내가 정해줄 게 있어요" : "It ran through, and needs a decision from you",
        body: ko
          ? "자동화는 멈춘 데 없이 끝까지 돌았어요. 다만 결과에 사람이 정해야 하는 부분이 있어요."
          : "The automation ran all the way through. The result just needs a decision from you.",
      };
    }
    if (run.outcome === "blocked") {
      return {
        title: ko ? "끝까지 돌았지만 바깥에서 막혔어요" : "It ran through but something outside blocked it",
        body: ko
          ? "단계는 다 지나갔는데 상대 서비스가 막았어요."
          : "Every step ran, but the other service refused.",
      };
    }
    if (run.outcome === "unjudged") {
      return {
        title: ko ? "끝까지 돌았어요(결과는 확인 못 함)" : "It ran through (result not judged)",
        body: ko
          ? "자동화는 끝까지 돌았어요. 결과가 쓸 만한지는 이번엔 판정하지 못했어요 — 실패라는 뜻은 아닙니다."
          : "It ran to the end. Whether the result is good could not be judged this time — that is not a failure.",
      };
    }
    return {
      title: ko ? "끝까지 돌았는데 결과가 기준에 못 미쳤어요" : "It ran through but the result fell short",
      body: ko
        ? "단계는 다 지나갔어요. 나온 결과가 원하던 수준이 아니었어요."
        : "Every step ran. The result just was not what you asked for.",
    };
  }
  const plain = plainOutcome(run.status, ko);
  /*
   * ★기록된 사유가 **이미 사람 말이면 그것을 쓴다.**
   *
   * 평이한 설명은 영어 기술 문장을 덮으려고 만든 것인데, 덮는 김에 고칠 방법까지 덮었다.
   * 실측(2026-08-06): 진짜 사유는 "macOS 손쉬운 사용 권한이 꺼져 있어 … 시스템 설정에서
   * 켜세요"였는데 화면에는 "사람이 정해야 하는 부분이 있어 멈췄어요"만 떴다. 그 화면이
   * 권하는 [대화에서 이어서 해결]로는 OS 권한을 절대 못 켠다 — 아는 쪽은 제품인데
   * 모르는 쪽이 사람이 됐다. 판별은 모양이 아니라 **한글이 섞여 있고 길이가 사람 문장인가**로 한다.
   */
  const recorded = (run.error ?? "").trim();
  const readable = recorded.length > 0 && recorded.length <= 400 && (!ko || /[\uac00-\ud7a3]/.test(recorded));
  return readable ? { title: plain.title, body: recorded } : plain;
}

/**
 * 이 기록의 머리말. **기계 칸만 본다** — status(끝까지 갔는가)보다 outcome(무엇이었나)이
 * 사람에게 더 정확할 때는 outcome 을 앞세운다. 사유 문장은 절대 읽지 않는다.
 */
function outcomeFirstLabel(run: AutomationRunRecord, ko: boolean): string {
  if (run.outcome === "needs_input") return ko ? "내 확인 필요" : "Needs your decision";
  if (run.outcome === "blocked") return ko ? "바깥에서 막힘" : "Blocked outside";
  return statusLabel(run.status, ko);
}

function statusLabel(status: AutomationRunRecord["status"], ko: boolean): string {
  if (status === "error") return ko ? "실패" : "Failed";
  if (status === "partial") return ko ? "일부만 완료" : "Partly done";
  if (status === "blocked") return ko ? "막혀서 멈춤" : "Blocked";
  if (status === "needs_input") return ko ? "내 확인 필요" : "Needs your decision";
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
