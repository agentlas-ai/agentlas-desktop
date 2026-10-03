import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  OwnerDecision,
  ToolchainAutomationView,
  ToolchainCrystallizationView,
  ToolchainOverview,
  ToolchainsApi,
} from "@shared/toolchain";
import styles from "./OneToolchains.module.css";

/** Wrap Toolchains + Computer History so they stack as one rail. */
export const toolchainStackClassName = styles.stack;

type Copy = ReturnType<typeof copyFor>;

function copyFor(locale: string) {
  const ko = locale === "ko";
  return {
    title: ko ? "툴체인" : "Toolchains",
    subtitle: ko ? "반복 실행에서 배운 것 — 확실하지 않으면 원래 방식으로 돕니다" : "What repeated runs taught — anything uncertain runs the original way",
    analyze: ko ? "다시 분석" : "Analyze now",
    analyzing: ko ? "분석 중…" : "Analyzing…",
    empty: ko ? "아직 배운 것이 없습니다. 자동화가 같은 일을 여러 번 하면 여기에 나타납니다." : "Nothing learned yet. Repeated automation work appears here.",
    unavailable: ko ? "이 화면에서는 툴체인을 불러올 수 없습니다." : "Toolchains are unavailable here.",
    stateFile: (target: string, lines: number | null) => ko ? `상태 파일 미리 읽기 · ${target} (마지막 ${lines ?? 10}줄)` : `Pre-read state file · ${target} (last ${lines ?? 10} lines)`,
    pageRead: (target: string) => ko ? `페이지 읽기 · ${target}` : `Page read · ${target}`,
    evidence: (share: number, runs: number, weak: boolean) => ko
      ? `성공한 실행 ${runs}회 중 ${Math.round(share * 100)}%에서 반복${weak ? " · 판정 없이 완료만 확인됨" : ""}`
      : `Repeated in ${Math.round(share * 100)}% of ${runs} successful runs${weak ? " · completion only, not judged" : ""}`,
    shadow: (matches: number, need: number, mismatches: number) => ko
      ? `실제 실행과 비교 중 ${matches}/${need} 일치${mismatches ? ` · 불일치 ${mismatches}` : ""}`
      : `Comparing with real runs ${matches}/${need} matched${mismatches ? ` · ${mismatches} mismatched` : ""}`,
    active: (runs: number, rereads: number, fallbacks: number) => ko
      ? `적용 ${runs}회 · 에이전트가 다시 읽음 ${rereads} · 원래 방식으로 돌아감 ${fallbacks}`
      : `Applied ${runs} · agent re-read ${rereads} · fell back ${fallbacks}`,
    outcomes: (b: { accepted: number; judged: number }, a: { accepted: number; judged: number }) => ko
      ? `수락률 적용 전 ${b.accepted}/${b.judged} → 후 ${a.accepted}/${a.judged}`
      : `Accepted before ${b.accepted}/${b.judged} → after ${a.accepted}/${a.judged}`,
    cost: (c: { measuredEpisodes: number; avgReadChars: number; avgNodeInputTokens: number; readCapped: boolean }) => ko
      ? `측정 ${c.measuredEpisodes}회 · 페이지 읽기 결과 평균 ${c.readCapped ? "≥" : ""}${c.avgReadChars.toLocaleString()}자 · 이 단계 입력 평균 ${c.avgNodeInputTokens.toLocaleString()}토큰`
      : `Measured ${c.measuredEpisodes} runs · page reads avg ${c.readCapped ? "≥" : ""}${c.avgReadChars.toLocaleString()} chars · step input avg ${c.avgNodeInputTokens.toLocaleString()} tokens`,
    notMeasured: ko ? "아직 측정된 실행이 없습니다" : "No measured runs yet",
    observed: (step: string, target: string, share: number, waitingForIdentity: boolean) => ko
      ? `관찰 중 · ${step} 단계 · ${target} ${Math.round(share * 100)}%${waitingForIdentity ? " — 기준(80%)은 넘었고, 단계 기록이 쌓이면 비교를 시작합니다" : " (기준 80%)"}`
      : `Observing · step ${step} · ${target} ${Math.round(share * 100)}%${waitingForIdentity ? " — above 80%; comparison starts once step records accumulate" : " (needs 80%)"}`,
    state: {
      candidate: ko ? "측정 대기" : "Needs measurement",
      shadow: ko ? "비교 중" : "Comparing",
      ready: ko ? "적용 승인 대기" : "Ready to apply",
      active: ko ? "적용 중" : "Active",
      demoted: ko ? "중단됨" : "Stopped",
      rejected: ko ? "무시함" : "Dismissed",
      blacklisted: ko ? "맞지 않음" : "Did not match",
      superseded: ko ? "단계가 바뀜" : "Step changed",
    } as Record<string, string>,
    reason: {
      needs_cost_measurement: ko ? "읽기 비용을 먼저 잰 뒤 결정합니다" : "Decided after its cost is measured",
      shadow_matched: ko ? "비교한 실행이 모두 일치했습니다" : "Every compared run matched",
      shadow_mismatch: ko ? "실제 실행과 내용이 달랐습니다" : "Differed from what real runs read",
      agent_still_reads: ko ? "에이전트가 계속 직접 읽어 절약이 없었습니다" : "The agent kept reading it itself — no saving",
      outcome_regressed: ko ? "적용 후 수락률이 떨어졌습니다" : "Acceptance dropped after applying",
      file_missing: ko ? "파일이 없어 원래 방식으로 돌았습니다" : "File missing — ran the original way",
      folder_changed: ko ? "작업 폴더가 바뀌어 원래 방식으로 돌았습니다" : "Working folder changed — ran the original way",
      folder_unknown: ko ? "작업 폴더를 아직 모릅니다" : "Working folder not known yet",
      node_definition_changed: ko ? "단계 지시가 바뀌어 새로 배웁니다" : "The step changed; learning again",
      owner_approved: ko ? "승인함" : "Approved",
      owner_dismissed: ko ? "무시함" : "Dismissed",
      owner_demoted: ko ? "직접 껐습니다" : "Turned off",
      owner_retry: ko ? "다시 비교합니다" : "Comparing again",
    } as Record<string, string>,
    approve: ko ? "적용" : "Apply",
    dismiss: ko ? "무시" : "Dismiss",
    demote: ko ? "끄기" : "Turn off",
    retry: ko ? "다시 비교" : "Compare again",
    callableTitle: ko ? "One이 부를 수 있게" : "Callable by One",
    expose: ko ? "호출 가능하게 만들기" : "Make callable",
    exposing: ko ? "새 세션으로 시험 중…" : "Testing in a fresh session…",
    withdraw: ko ? "호출 중단" : "Withdraw",
    callable: ko ? "호출 가능" : "Callable",
    draft: ko ? "시험 미통과" : "Did not pass",
    deprecated: ko ? "중단됨" : "Withdrawn",
    stale: ko ? "자동화가 바뀌어 다시 시험이 필요합니다" : "Automation changed — test again",
    coldStart: (c: { positives: number; positiveFound?: number; positiveSelected: number; positiveBound: number; negatives: number; negativeSelected: number }) => ko
      ? `새 세션 시험: 맞는 요청 ${c.positives}개 중 검색 ${c.positiveFound ?? "?"}·선택 ${c.positiveSelected}·입력 ${c.positiveBound}, 아닌 요청 ${c.negatives}개 중 잘못 선택 ${c.negativeSelected}`
      : `Fresh-session test: of ${c.positives} fitting requests, found ${c.positiveFound ?? "?"} · chosen ${c.positiveSelected} · bound ${c.positiveBound}; ${c.negativeSelected} wrong picks of ${c.negatives}`,
    casesTitle: ko ? "시험한 요청 보기" : "Show test requests",
    caseVerdict: (k: { kind: "positive" | "negative"; found: boolean; selected: boolean; bound: boolean }) => k.kind === "positive"
      ? (k.bound ? (ko ? "통과" : "Passed") : k.selected ? (ko ? "입력 틀림" : "Wrong input") : k.found ? (ko ? "고르지 않음" : "Not chosen") : (ko ? "검색에서 못 찾음" : "Not found"))
      : (k.selected ? (ko ? "잘못 고름" : "Wrongly chosen") : (ko ? "정상 거절" : "Correctly declined")),
    caseKind: (kind: "positive" | "negative") => kind === "positive" ? (ko ? "맞는 요청" : "Should use") : (ko ? "아닌 요청" : "Should not"),
    usage: (returned: number, runs: number) => ko ? `검색에 나옴 ${returned} · 실제 호출 ${runs}` : `Returned by search ${returned} · called ${runs}`,
    others: (count: number) => ko ? `다른 자동화 ${count}개` : `${count} other automations`,
    failed: ko ? "처리하지 못했습니다" : "Could not complete",
    errors: {
      no_isolated_runtime: ko
        ? "도구 없이 시험할 수 있는 모델이 연결돼 있지 않습니다. 시험 요청에 '게시해 줘' 같은 문장이 섞이므로 도구가 꺼진 모델(Claude 등)이 필요합니다."
        : "No model that can run with tools disabled is connected. Test requests include phrases like \"post this\", so a tool-free model (e.g. Claude) is required.",
      cold_start_unavailable: ko ? "시험용 모델 호출이 실패했습니다. 잠시 뒤 다시 시도하세요." : "The test model call failed. Try again shortly.",
      unreadable: ko ? "시험 모델의 답을 읽지 못했습니다. 다시 시도하세요." : "Could not read the test model's answer. Try again.",
      not_allowed: ko ? "지금 상태에서는 할 수 없는 동작입니다. 화면을 새로 고칩니다." : "That action is not allowed in the current state. Refreshing.",
    },
  };
}

/** Main refusals carry a machine code; say what it means, never the code. */
function errorText(error: unknown, copy: Copy): string {
  const message = String(error instanceof Error ? error.message : error ?? "");
  if (/no_isolated_runtime/.test(message)) return copy.errors.no_isolated_runtime;
  if (/toolchain_cold_start_unavailable/.test(message)) return copy.errors.cold_start_unavailable;
  if (/toolchain_cold_start_(?:generation|selection)_unreadable/.test(message)) return copy.errors.unreadable;
  if (/toolchain_decision_not_allowed/.test(message)) return copy.errors.not_allowed;
  return copy.failed;
}

function itemLabel(item: ToolchainCrystallizationView, copy: Copy): string {
  return item.kind === "state_file_read" ? copy.stateFile(item.target, item.lines) : copy.pageRead(item.target);
}

function CrystallizationRow({ item, copy, busy, onDecide }: {
  item: ToolchainCrystallizationView;
  copy: Copy;
  busy: boolean;
  onDecide: (item: ToolchainCrystallizationView, decision: OwnerDecision) => void;
}) {
  const reason = item.reasonCode ? copy.reason[item.reasonCode] ?? item.reasonCode : null;
  return (
    <li className={styles.item} data-state={item.state}>
      <div className={styles.itemHead}>
        <strong>{itemLabel(item, copy)}</strong>
        <span className={styles.badge} data-state={item.state}>{copy.state[item.state] ?? item.state}</span>
      </div>
      <span className={styles.metric}>{copy.evidence(item.evidence.share, item.evidence.eligibleEpisodes, item.evidence.quality === "kernel_completed_only")}</span>
      {item.kind === "page_read" && item.state === "candidate"
        && <span className={styles.metric}>{item.cost ? copy.cost(item.cost) : copy.notMeasured}</span>}
      {item.state === "shadow" && <span className={styles.metric}>{copy.shadow(item.shadow.consecutiveMatches, 5, item.shadow.mismatches)}</span>}
      {(item.state === "active" || item.state === "demoted") && item.active.appliedAt && <>
        <span className={styles.metric}>{copy.active(item.active.runs, item.active.rereads, item.active.fallbacks)}</span>
        {item.outcomes.after.judged > 0 && <span className={styles.metric}>{copy.outcomes(item.outcomes.before, item.outcomes.after)}</span>}
      </>}
      {reason && <span className={styles.reason}>{reason}</span>}
      <div className={styles.actions}>
        {item.state === "ready" && <>
          <button type="button" data-primary="true" disabled={busy} onClick={() => onDecide(item, "approve")}>{copy.approve}</button>
          <button type="button" disabled={busy} onClick={() => onDecide(item, "dismiss")}>{copy.dismiss}</button>
        </>}
        {item.state === "active" && <button type="button" disabled={busy} onClick={() => onDecide(item, "demote")}>{copy.demote}</button>}
        {(item.state === "demoted" || item.state === "blacklisted") && item.kind === "state_file_read"
          && <button type="button" disabled={busy} onClick={() => onDecide(item, "retry")}>{copy.retry}</button>}
        {item.state === "demoted" && <button type="button" disabled={busy} onClick={() => onDecide(item, "dismiss")}>{copy.dismiss}</button>}
      </div>
    </li>
  );
}

function InterfaceBlock({ view, copy, busy, exposing, onExpose, onWithdraw }: {
  view: ToolchainAutomationView;
  copy: Copy;
  busy: boolean;
  exposing: boolean;
  onExpose: () => void;
  onWithdraw: () => void;
}) {
  const contract = view.interface;
  const callable = contract?.state === "callable" && !view.interfaceStale;
  return (
    <div className={styles.contract}>
      <div className={styles.itemHead}>
        <strong>{copy.callableTitle}</strong>
        {contract && <span className={styles.badge} data-state={callable ? "active" : "demoted"}>
          {view.interfaceStale ? copy.stale : contract.state === "callable" ? copy.callable : contract.state === "draft" ? copy.draft : copy.deprecated}
        </span>}
      </div>
      {contract?.coldStart && <span className={styles.metric}>{copy.coldStart(contract.coldStart)}</span>}
      {contract?.coldStart?.cases && contract.coldStart.cases.length > 0 && <details className={styles.cases}>
        <summary>{copy.casesTitle}</summary>
        <ul>
          {contract.coldStart.cases.map((probe, index) => (
            <li key={index} data-kind={probe.kind} data-ok={probe.kind === "positive" ? String(probe.bound) : String(!probe.selected)}>
              <span className={styles.caseVerdict}>{copy.caseKind(probe.kind)} · {copy.caseVerdict(probe)}</span>
              <span className={styles.caseTask}>{probe.task}</span>
            </li>
          ))}
        </ul>
      </details>}
      {contract && <span className={styles.metric}>{copy.usage(contract.usage?.returned ?? 0, contract.usage?.runs ?? 0)}</span>}
      <div className={styles.actions}>
        {callable
          ? <button type="button" disabled={busy} onClick={onWithdraw}>{copy.withdraw}</button>
          : <button type="button" data-primary="true" disabled={busy || exposing} onClick={onExpose}>{exposing ? copy.exposing : copy.expose}</button>}
      </div>
    </div>
  );
}

export function OneToolchains({ api, locale }: { api: ToolchainsApi | null | undefined; locale: string }) {
  const copy = useMemo(() => copyFor(locale), [locale]);
  const [overview, setOverview] = useState<ToolchainOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [exposingId, setExposingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<ToolchainOverview>) => {
    setBusy(true);
    setError(null);
    try { setOverview(await action()); }
    catch (cause) {
      setError(errorText(cause, copy));
      // A refused action may mean the state moved underneath; show the current truth.
      void api?.overview().then(setOverview).catch(() => undefined);
    }
    finally { setBusy(false); }
  }, [api, copy]);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const load = () => { void api.overview().then((next) => { if (alive) setOverview(next); }).catch(() => undefined); };
    load();
    const timer = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, [api]);

  if (!api) return <section className={styles.root} aria-label={copy.title}><p className={styles.empty}>{copy.unavailable}</p></section>;

  const learned = (overview?.automations ?? []).filter((view) => view.crystallizations.some((item) => item.state !== "superseded")
    || view.interface || view.observations.some((observation) => observation.eligibleEpisodes > 0 && observation.topTargets.length > 0));
  const others = (overview?.automations ?? []).filter((view) => !learned.includes(view));

  const automationBlock = (view: ToolchainAutomationView) => {
    const visible = view.crystallizations.filter((item) => item.state !== "superseded");
    // Strongest signals first, each tied to its step. A share above the threshold on
    // legacy runs (no step identity recorded yet) is said plainly instead of hidden.
    const observed = visible.length === 0
      ? view.observations
        .flatMap((observation) => observation.topTargets.slice(0, 1).map((target) => ({
          ...target, nodeId: observation.nodeId, waitingForIdentity: !observation.nodeDigest && target.share >= 0.8,
        })))
        .filter((target) => target.share > 0)
        .sort((left, right) => right.share - left.share)
        .slice(0, 3)
      : [];
    return (
      <article key={view.automationId} className={styles.automation}>
        <h3>{view.automationName}</h3>
        {visible.length > 0 && <ul className={styles.list}>
          {visible.map((item) => <CrystallizationRow key={item.id} item={item} copy={copy} busy={busy}
            onDecide={(target, decision) => void run(() => api.decide({ automationId: view.automationId, crystallizationId: target.id, decision }))} />)}
        </ul>}
        {observed.map((target) => <span key={`${target.nodeId}:${target.kind}:${target.target}`} className={styles.observed}>
          {copy.observed(target.nodeId, target.target, target.share, target.waitingForIdentity)}</span>)}
        <InterfaceBlock view={view} copy={copy} busy={busy} exposing={exposingId === view.automationId}
          onExpose={() => {
            setExposingId(view.automationId);
            void run(() => api.expose(view.automationId)).finally(() => setExposingId(null));
          }}
          onWithdraw={() => void run(() => api.withdraw(view.automationId))} />
      </article>
    );
  };

  return (
    <section className={styles.root} aria-label={copy.title}>
      <header className={styles.header}>
        <div><h2>{copy.title}</h2><p>{copy.subtitle}</p></div>
        <button type="button" disabled={busy} onClick={() => void run(() => api.refresh())}>{busy ? copy.analyzing : copy.analyze}</button>
      </header>
      {error && <p className={styles.error} role="status">{error}</p>}
      {overview && learned.length === 0 && <p className={styles.empty}>{copy.empty}</p>}
      {learned.map(automationBlock)}
      {others.length > 0 && <details className={styles.others}>
        <summary>{copy.others(others.length)}</summary>
        {others.map(automationBlock)}
      </details>}
    </section>
  );
}
