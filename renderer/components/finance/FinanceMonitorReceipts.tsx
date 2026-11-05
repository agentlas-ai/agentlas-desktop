"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FinanceMonitor, FinanceMonitorRun, FinanceMonitorRunsResult } from "@shared/finance";
import { FinanceMessage, financeStatus, financeMessage, financeNote, financeStoredText } from "./FinanceMessage";
import styles from "./FinanceWorkspace.module.css";
import local from "./FinanceMonitorReceipts.module.css";

export interface FinanceMonitorReceiptsProps {
  monitor: FinanceMonitor;
  ko: boolean;
  onRun?: (monitor: FinanceMonitor) => Promise<FinanceMonitorRun>;
  onLoad?: (monitorId: string, page?: {cursor?:string;limit?:number}) => Promise<FinanceMonitorRunsResult>;
  onOpenReport: (reportId: string) => void;
  /** The monitor names no asset and the watchlist is empty: a monitor checks assets, so there is nothing to run on yet. */
  needsAsset?: boolean;
  /** The newest finished run's time, so the card's "Last checked" agrees with the run history under it. */
  onLatestRun?: (finishedAt: string | null) => void;
  onFindAssets?: () => void;
}
/** Readable text only: React escapes every value; HTML, embeds and code never execute. */
export function FinanceBriefText({value,ko=true}:{value:string;ko?:boolean}) {
  const plain=(line:string)=>line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,"$1 ($2)").replace(/\*\*([^*]+)\*\*/g,"$1").replace(/__([^_]+)__/g,"$1").replace(/`([^`]+)`/g,"$1");
  const lines=value.split(/\r?\n/),evidenceStart=lines.findIndex(line=>/^\[row \d+\] \{/.test(line));
  const narrative=evidenceStart<0?lines:lines.slice(0,evidenceStart);
  return <div className={styles.narrative}>{narrative.map((line,index)=>{
    const heading=/^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    if(heading)return <h4 key={index} className={local.briefHeading}>{plain(heading[1])}</h4>;
    if(/^\s*```/.test(line))return null;
    const text=plain(line).replace(/^\s*[-*]\s+/,"• ").replace(/^\s*>\s?/,"");
    return <div key={index} className={line.trim()?undefined:local.briefGap}>{text}</div>;
  })}{evidenceStart>=0&&<details><summary>{ko?"근거 자료 보기":"Show source data"}</summary><pre className={local.evidence}>{lines.slice(evidenceStart).join("\n")}</pre></details>}</div>;
}
/** Ledger reads never start provider work. Only an explicit Run now triggers a check. */
export function FinanceMonitorReceipts({ monitor, ko, onRun, onLoad, onOpenReport, needsAsset, onFindAssets, onLatestRun }: FinanceMonitorReceiptsProps) {
  const [runs, setRuns] = useState<FinanceMonitorRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [nextCursor,setNextCursor]=useState<string|undefined>();
  const [indexStatus,setIndexStatus]=useState<string>();
  const [loadingMore,setLoadingMore]=useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const generation = useRef(0);
  const snapshotSequence=useRef<number|undefined>();
  const t = (a: string, b: string) => ko ? a : b;
  const when = (date: string | null) => date ? new Date(date).toLocaleString(ko ? "ko-KR" : "en-US") : t("미확인", "Unknown");
  const refresh = useCallback(async () => {
    if (!onLoad) return;
    const epoch = ++generation.current;
    setLoading(true);setLoadingMore(false);
    try {
      const page = await onLoad(monitor.id);
      if (alive.current && generation.current === epoch) { snapshotSequence.current=page.snapshotSequence; setRuns(page.runs); setNextCursor(page.nextCursor??undefined); setIndexStatus(page.indexStatus); setLoadingMore(false); setError(""); }
    } catch { if (alive.current && generation.current === epoch) setError(ko ? "실행 기록을 불러올 수 없습니다. 잠시 뒤 새로 고침해 보세요." : "Run history isn't available right now. Try refreshing in a moment."); }
    finally { if (alive.current && generation.current === epoch) setLoading(false); }
  }, [onLoad, monitor.id, ko]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const tick = () => { if(document.visibilityState === "visible" && monitor.status === "active") void refresh(); };
    const timer = window.setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    return () => { alive.current = false; generation.current++; window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [refresh,monitor.status]);
  const loadMore = async () => {
    if(!onLoad || !nextCursor || loading || loadingMore)return;
    const epoch=generation.current;const cursor=nextCursor;setLoadingMore(true);
    try {const page=await onLoad(monitor.id,{cursor,limit:10});
      if(alive.current&&generation.current===epoch){if(snapshotSequence.current!==undefined&&page.snapshotSequence!==snapshotSequence.current)throw new Error("finance_ledger_snapshot_changed");setRuns(previous=>[...previous,...page.runs.filter(run=>!previous.some(existing=>existing.id===run.id))]);setNextCursor(page.nextCursor??undefined);setIndexStatus(page.indexStatus);}
    }catch{if(alive.current&&generation.current===epoch)setError(t("이전 실행 기록을 불러오지 못했습니다. 지금 보이는 기록은 그대로 유지됩니다.","Older runs couldn't be loaded. What you see now is kept."));}
    finally{if(alive.current&&generation.current===epoch)setLoadingMore(false);}
  };
  const runNow = async () => {
    if(!onRun || running) return;
    setRunning(true); setError("");
    try {
      const result = await onRun(monitor);
      if(alive.current) setRuns(previous => [result,...previous.filter(item=>item.id!==result.id)]);
      await refresh();
    } catch { if(alive.current) setError(t("지금 확인을 끝내지 못했습니다. 이전 결과와 실행 기록을 확인하세요.","The check didn't finish. Review the previous result and run history.")); }
    finally { if(alive.current) setRunning(false); }
  };
  const ordered = [...runs].sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  const latest = ordered[0];
  const lastBriefing = ordered.find(run=>run.reportId);
  const success = ordered.find(run=>run.status==="succeeded" || run.status==="partial");
  const latestFinished = latest?.finishedAt ?? null;
  useEffect(()=>{ onLatestRun?.(latestFinished); },[latestFinished,onLatestRun]);
  return <section className={styles.runPanel} aria-label={t("실행과 브리핑","Runs and briefings")}>
    <div className={styles.actions}>
      <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!onRun || running || !monitor.query.trim() || !!needsAsset} title={needsAsset?t("확인할 자산이 없습니다. 먼저 자산을 추가하세요.","There is no asset to check yet. Add one first."):!monitor.query.trim()?t("확인할 질문이 비어 있습니다. 모니터에 질문을 입력하세요.","This monitor has no question yet. Add one first."):!onRun?t("지금은 실행할 수 없습니다.","Can't run right now."):undefined} onClick={()=>{void runNow();}}>{running?t("확인 중…","Checking…"):t("지금 확인","Run now")}</button>
      {lastBriefing?.reportId && <button type="button" className={styles.button} onClick={()=>onOpenReport(lastBriefing.reportId!)}>{t("최신 브리핑","Latest briefing")}</button>}
    </div>
    {!monitor.query.trim() && <p className={styles.muted}>{t("확인할 질문이 비어 있어 실행할 수 없습니다.","Add a question to this monitor to run it.")}</p>}
    {needsAsset && <p className={styles.muted}>{t("모니터는 자산을 확인합니다. 관심 자산을 하나 이상 추가하면 실행할 수 있습니다.","A monitor checks assets. Add at least one asset to your watchlist to run it.")} {onFindAssets&&<button type="button" className={styles.button} onClick={onFindAssets}>{t("자산 찾기","Find assets")}</button>}</p>}
    <p className={styles.muted}>{latest?<><strong>{financeStatus(latest.status,ko)}</strong> · {when(latest.finishedAt)}</>:t("실행 전","Not run yet")}</p>
    {monitor.nextCheckAt && new Date(monitor.nextCheckAt).getTime()<Date.now() && monitor.status==="active" && <p className={styles.muted}>{t("예정된 확인 시간이 지났습니다. 지금 확인을 눌러 최신 결과를 받으세요.","A scheduled check is overdue. Press Run now for a fresh result.")}</p>}
    {error && <div className={`${styles.notice} ${styles.error}`} role="alert"><FinanceMessage value={error} ko={ko} error/>{onLoad&&<button type="button" className={styles.button} disabled={loading} onClick={()=>{void refresh();}}>{t("새로 고침","Refresh")}</button>}</div>}
    {latest?.summary && <FinanceBriefText value={financeStoredText(latest.summary,ko)} ko={ko}/>}
    {latest?.error && <div className={`${styles.notice} ${styles.error}`} role="alert"><p>{financeMessage(latest.error,ko)!==latest.error?financeMessage(latest.error,ko):t("확인 중 문제가 생겼습니다. 다시 확인해 보세요.","Something went wrong during the check. Try running it again.")}</p></div>}
    {!!latest?.warnings.length&&<p className={styles.muted}>{t("자료 한계","Coverage limits")} {latest.warnings.length} · {t("실행 기록에서 확인","See run history")}</p>}
    <details><summary className={styles.muted}>{t("실행 기록","Run history")}{ordered.length>0?` · ${ordered.length}`:""}</summary>
      <div className={styles.actions}><button type="button" className={styles.button} disabled={!onLoad || loading} onClick={()=>{void refresh();}}>{loading?t("불러오는 중…","Loading…"):t("새로 고침","Refresh")}</button></div>
      <dl className={styles.metaGrid}>
        <div><dt>{t("마지막으로 성공한 시각","Last successful check")}</dt><dd>{when(success?.finishedAt??null)}</dd></div>
        <div><dt>{t("실행 시점","When it runs")}</dt><dd>{monitor.executionAvailability==="app-running"?t("Agentlas 앱이 켜져 있을 때","While Agentlas is open"):t("앱이 켜져 있을 때 실행됩니다","Runs while the app is open")}</dd></div>
      </dl>
      {!!latest?.warnings.length&&<details><summary className={styles.muted}>{t("자료 범위와 한계","Coverage and limitations")} · {latest.warnings.length}</summary><ol>{latest.warnings.map((warning,index)=><li key={index} className={styles.muted}><p>{financeNote(warning,ko)}</p></li>)}</ol></details>}
      {ordered.length>0&&<><div className={styles.list}>{ordered.map(run=><div key={run.id} className={styles.runRow}><div><strong>{financeStatus(run.status,ko)}</strong><div className={styles.muted}>{when(run.startedAt)}</div></div>{run.reportId&&<button type="button" className={styles.button} onClick={()=>onOpenReport(run.reportId!)}>{t("브리핑","Briefing")}</button>}</div>)}</div>{nextCursor&&<button type="button" className={styles.button} disabled={loading||loadingMore} onClick={()=>{void loadMore();}}>{loadingMore?t("불러오는 중…","Loading…"):t("이전 실행 더 보기","Show older runs")}</button>}</>}
    </details>
    {indexStatus&&indexStatus!=="ready"&&<p role="status" className={styles.muted}>{indexStatus==="building"?t("기록을 정리하는 중입니다. 잠시 뒤 새로 고침하세요.","Preparing history. Refresh in a moment."):t("예전 기록은 아직 정리되지 않아 일부만 보일 수 있습니다.","Older history isn't ready yet, so only part of it may show.")}</p>}
    {!onLoad && <p className={styles.muted}>{t("실행 기록을 불러올 수 없습니다.","Run history isn't available right now.")}</p>}
  </section>;
}
