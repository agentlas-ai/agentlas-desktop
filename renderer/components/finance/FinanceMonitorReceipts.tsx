"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FinanceMonitor, FinanceMonitorRun, FinanceMonitorRunsResult } from "@shared/finance";
import { FinanceMessage, financeStatus, financeMessage } from "./FinanceMessage";
import styles from "./FinanceWorkspace.module.css";

export interface FinanceMonitorReceiptsProps {
  monitor: FinanceMonitor;
  ko: boolean;
  onRun?: (monitor: FinanceMonitor) => Promise<FinanceMonitorRun>;
  onLoad?: (monitorId: string, page?: {cursor?:string;limit?:number}) => Promise<FinanceMonitorRunsResult>;
  onOpenReport: (reportId: string) => void;
}
/** Readable text only: React escapes every value; HTML, embeds and code never execute. */
export function FinanceBriefText({value,ko=true}:{value:string;ko?:boolean}) {
  const plain=(line:string)=>line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,"$1 ($2)").replace(/\*\*([^*]+)\*\*/g,"$1").replace(/__([^_]+)__/g,"$1").replace(/`([^`]+)`/g,"$1");
  const lines=value.split(/\r?\n/),evidenceStart=lines.findIndex(line=>/^\[row \d+\] \{/.test(line));
  const narrative=evidenceStart<0?lines:lines.slice(0,evidenceStart);
  return <div className={styles.narrative}>{narrative.map((line,index)=>{
    const heading=/^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    if(heading)return <h4 key={index} style={{fontSize:13,fontWeight:650,margin:"12px 0 6px"}}>{plain(heading[1])}</h4>;
    if(/^\s*```/.test(line))return null;
    const text=plain(line).replace(/^\s*[-*]\s+/,"• ").replace(/^\s*>\s?/,"");
    return <div key={index} style={{minHeight:line.trim()?undefined:8}}>{text}</div>;
  })}{evidenceStart>=0&&<details><summary>{ko?"인용 근거 행과 원자료":"Cited evidence rows and source data"}</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontSize:11}}>{lines.slice(evidenceStart).join("\n")}</pre></details>}</div>;
}
/** Ledger reads never start provider work. Only an explicit Run now triggers a check. */
export function FinanceMonitorReceipts({ monitor, ko, onRun, onLoad, onOpenReport }: FinanceMonitorReceiptsProps) {
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
    } catch { if (alive.current && generation.current === epoch) setError(ko ? "실행 이력을 불러오지 못했습니다. 실행 성공을 확인할 수 없습니다." : "Could not load the run ledger. Execution success is unconfirmed."); }
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
    }catch{if(alive.current&&generation.current===epoch)setError(t("이전 실행 이력을 불러오지 못했습니다. 현재 페이지는 유지됩니다.","Could not load older runs. The current page is preserved."));}
    finally{if(alive.current&&generation.current===epoch)setLoadingMore(false);}
  };
  const runNow = async () => {
    if(!onRun || running) return;
    setRunning(true); setError("");
    try {
      const result = await onRun(monitor);
      if(alive.current) setRuns(previous => [result,...previous.filter(item=>item.id!==result.id)]);
      await refresh();
    } catch { if(alive.current) setError(t("지금 확인을 완료하지 못했습니다. 마지막 결과와 실행 이력을 확인하세요.","The check did not complete. Review the previous results and ledger.")); }
    finally { if(alive.current) setRunning(false); }
  };
  const ordered = [...runs].sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
  const latest = ordered[0];
  const lastBriefing = ordered.find(run=>run.reportId);
  const success = ordered.find(run=>run.status==="succeeded" || run.status==="partial");
  return <section className={styles.runPanel} aria-label={t("실제 실행과 브리핑","Actual runs and briefings")}>
    <div className={styles.actions}>
      <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!onRun || running || !monitor.query.trim()} onClick={()=>{void runNow();}}>{running?t("확인 중…","Checking…"):t("지금 확인","Run now")}</button>
      {lastBriefing?.reportId && <button type="button" className={styles.button} onClick={()=>onOpenReport(lastBriefing.reportId!)}>{t("최신 브리핑 열기","Open latest briefing")}</button>}
      <button type="button" className={styles.button} disabled={!onLoad || loading} onClick={()=>{void refresh();}}>{loading?t("이력 확인 중…","Loading ledger…"):t("이력 새로고침","Refresh ledger")}</button>
    </div>
    <dl className={styles.metaGrid}>
      <div><dt>{t("마지막 성공·부분 성공","Last successful / partial check")}</dt><dd>{when(success?.finishedAt??null)}</dd></div>
      <div><dt>{t("최근 실행 결과","Latest run result")}</dt><dd>{latest?financeStatus(latest.status,ko):t("아직 실행 기록 없음","No run recorded")}</dd></div>
      <div><dt>{t("실행 가능 범위","Execution availability")}</dt><dd>{monitor.executionAvailability==="app-running"?t("Agentlas 앱이 실행 중일 때","While Agentlas is running"):t("실행 주체 미확인","Executor unconfirmed")}</dd></div>
    </dl>
    {monitor.nextCheckAt && new Date(monitor.nextCheckAt).getTime()<Date.now() && monitor.status==="active" && <p className={styles.muted}>{t("예정 시간이 지났습니다. 다음 실행 영수증이 도착하기 전에는 최신 확인으로 보지 않습니다.","The scheduled time has passed. A fresh check is unconfirmed until a run receipt arrives.")}</p>}
    {error && <div className={`${styles.notice} ${styles.error}`} role="alert"><FinanceMessage value={error} ko={ko} error/></div>}
    {latest?.summary && <FinanceBriefText value={latest.summary} ko={ko}/>}
    {latest?.error && <div className={`${styles.notice} ${styles.error}`} role="alert"><FinanceMessage value={latest.error} ko={ko} error/></div>}
    {!!latest?.warnings.length&&<details><summary className={styles.muted}>{t("자료 범위와 한계","Coverage and limitations")} · {latest.warnings.length}</summary><ol>{latest.warnings.map((warning,index)=><li key={index} className={styles.muted}><p>{financeMessage(warning,ko)}</p>{financeMessage(warning,ko)!==warning&&<p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}} lang="en">{warning}</p>}</li>)}</ol></details>}
    {ordered.length>0 && <details><summary className={styles.muted}>{t("실행 이력과 이전 브리핑","Run history and previous briefings")} · {ordered.length}</summary><div className={styles.list}>{ordered.map(run=><div key={run.id} className={styles.runRow}><div><strong>{financeStatus(run.status,ko)}</strong><div className={styles.muted}>{when(run.startedAt)} · {t("자료 판본","Revision")} {run.sourceRevision}</div></div>{run.reportId&&<button type="button" className={styles.button} onClick={()=>onOpenReport(run.reportId!)}>{t("브리핑","Briefing")}</button>}</div>)}</div>{nextCursor&&<button type="button" className={styles.button} disabled={loading||loadingMore} onClick={()=>{void loadMore();}}>{loadingMore?t("이전 이력 확인 중…","Loading older runs…"):t("이전 실행 더 보기","Load older runs")}</button>}<p className={styles.muted}>{t("새로고침하면 최신 첫 페이지부터 다시 표시합니다.","Refreshing starts again from the latest first page.")}</p></details>}
    {indexStatus&&indexStatus!=="ready"&&<p role="status" className={styles.muted}>{indexStatus==="building"?t("이력 색인을 준비 중입니다. 잠시 후 새로고침하세요.","The history index is building. Refresh shortly."):t("이전 이력 색인 전환이 필요합니다. 현재 표시 범위만 확인할 수 있습니다.","The history index requires migration. Only the current coverage is confirmed.")}</p>}
    {!onLoad && <p className={styles.muted}>{t("실행 이력 API가 연결되지 않아 결과를 확인할 수 없습니다.","Run ledger API is not connected; results are unconfirmed.")}</p>}
  </section>;
}
