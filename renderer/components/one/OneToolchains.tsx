import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  OwnerDecision,
  ToolchainCrystallizationView,
  ToolchainOverview,
  ToolchainsApi,
} from "@shared/toolchain";
import { IconToolchain } from "@/components/Icon";
import { navigate } from "@/lib/navigation";
import {
  crystallizationLabel,
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

export function OneToolchains({ api, locale }: { api: ToolchainsApi | null | undefined; locale: string }) {
  const copy = useMemo(() => toolchainCopy(locale), [locale]);
  const ko = locale === "ko";
  const [overview, setOverview] = useState<ToolchainOverview | null>(null);
  const [assets, setAssets] = useState<Awaited<ReturnType<ToolchainsApi["listAssets"]>>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!api) return;
    const [list, learning] = await Promise.allSettled([api.listAssets(), api.overview()]);
    if (list.status === "fulfilled") { setAssets(list.value); setError(null); } else setError(toolchainErrorText(list.reason, copy));
    if (learning.status === "fulfilled") setOverview(learning.value);
  }, [api, copy]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 60_000); return () => clearInterval(timer); }, [load]);
  const run = async (action: () => Promise<ToolchainOverview>) => {
    setBusy(true); setError(null);
    try { setOverview(await action()); }
    catch (cause) { setError(toolchainErrorText(cause, copy)); }
    finally { setBusy(false); }
  };
  if (!api) return <section className={styles.root}><p className={styles.empty}>{copy.unavailable}</p></section>;
  const learning = (overview?.automations ?? []).filter((view) => view.crystallizations.some((item) => item.state !== "superseded"));
  return <section className={styles.root} aria-label={copy.title}>
    <header className={styles.header}><div><h2>{copy.title}</h2><p>{ko ? "독립된 재사용 도구 · 버전별 호출" : "Independent reusable tools · versioned calls"}</p></div><button onClick={() => navigate("/library/toolchains")}>{copy.viewAll}</button></header>
    {error && <p className={styles.error} role="status">{error}</p>}
    {assets.length === 0 && <p className={styles.empty}>{ko ? "등록된 툴체인이 없습니다." : "No registered toolchains."}</p>}
    {assets.slice(0, 6).map((asset) => <button key={asset.id} className={styles.asset} data-toolchain-asset={asset.id} onClick={() => navigate(`/library/toolchains?asset=${encodeURIComponent(asset.id)}`)}><IconToolchain size={14}/><span>{asset.name}</span><small>{asset.stableVersion ? `v${asset.stableVersion}` : (ko ? "초안" : "Draft")} · {asset.status}</small></button>)}
    <details className={styles.others}><summary>{ko ? "그래프 실행 학습" : "Graph execution learning"} ({learning.length})</summary><p className={styles.empty}>{ko ? "자동화 단계의 읽기 최적화입니다. 툴체인 자산과 별도로 관리합니다." : "Read optimizations for automation steps, managed separately from toolchain assets."}</p><button disabled={busy} onClick={() => void run(() => api.refresh())}>{copy.analyze}</button>{learning.map((view) => <article key={view.automationId} className={styles.automation}><h3>{view.automationName}</h3><ul className={styles.list}>{view.crystallizations.filter((item) => item.state !== "superseded").map((item) => <CrystallizationRow key={item.id} item={item} copy={copy} busy={busy} onDecide={(target, decision) => void run(() => api.decide({ automationId: view.automationId, crystallizationId: target.id, decision }))}/>)}</ul><button onClick={() => navigate(`/automation/flow?id=${encodeURIComponent(view.automationId)}`)}>{ko ? "그래프 열기" : "Open graph"}</button></article>)}</details>
  </section>;
}
