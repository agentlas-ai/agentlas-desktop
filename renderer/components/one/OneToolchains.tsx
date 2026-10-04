import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  OwnerDecision,
  ToolchainAutomationView,
  ToolchainCrystallizationView,
  ToolchainOverview,
  ToolchainsApi,
} from "@shared/toolchain";
import { IconToolchain } from "@/components/Icon";
import { navigate } from "@/lib/navigation";
import {
  crystallizationLabel,
  interfaceStateLabel,
  toolchainCopy,
  toolchainErrorText,
  type ToolchainCopy,
} from "@/components/toolchains/toolchain-copy";
import styles from "./OneToolchains.module.css";

/** Wrap Toolchains + Computer History so they stack as one rail. */
export const toolchainStackClassName = styles.stack;

type Copy = ToolchainCopy;

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
        <strong>{crystallizationLabel(item, copy)}</strong>
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
          {interfaceStateLabel(view, copy)}
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
  const copy = useMemo(() => toolchainCopy(locale), [locale]);
  const [overview, setOverview] = useState<ToolchainOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [exposingId, setExposingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<ToolchainOverview>) => {
    setBusy(true);
    setError(null);
    try { setOverview(await action()); }
    catch (cause) {
      setError(toolchainErrorText(cause, copy));
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
        <div className={styles.headerActions}>
          <button type="button" disabled={busy} onClick={() => void run(() => api.refresh())}>{busy ? copy.analyzing : copy.analyze}</button>
          {/* The rail is a glance; managing every toolchain lives in Work › Environment › Toolchains. */}
          <button type="button" data-view-all="true" onClick={() => navigate("/library/toolchains")}>
            <IconToolchain size={11} /> {copy.viewAll}
          </button>
        </div>
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
