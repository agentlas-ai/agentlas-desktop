"use client";
import type { FinanceExperienceRequest, FinanceExperienceState } from '@shared/finance-experience';
import type { FinanceFeedId } from '@shared/finance-feeds';
import styles from './FinanceSettingsDialog.module.css';

const feeds: {id:FinanceFeedId;name:string;ko:string;en:string}[]=[
 {id:'finance-news',name:'Yahoo Finance / Fed · RSS',ko:'시장·관심 종목 뉴스',en:'Market and watchlist headlines'},
 {id:'finance-sec',name:'SEC EDGAR',ko:'미국 기업 실적·공시',en:'US company filings and earnings reports'},
 {id:'finance-economy',name:'Fed · BLS · BEA',ko:'공식 경제 일정',en:'Official economic releases'},
 {id:'finance-earnings',name:'Earnings calendar',ko:'발표 예정일 · 지원되는 종목',en:'Upcoming earnings · supported symbols'},
];
export function FinanceSourceConnections({ko,state,pending,onChange}:{ko:boolean;state:FinanceExperienceState|null;pending:boolean;onChange:(request:FinanceExperienceRequest)=>Promise<void>}){
 const enabled=state?.enabledFeedIds??feeds.map(feed=>feed.id);
 return <div className={styles.connections}>
  <h3>{ko?'뉴스와 일정':'News and calendar'}</h3>
  {feeds.map(feed=><label className={styles.row} key={feed.id}><span className={styles.connectionLabel}><strong>{feed.name}</strong><small>{ko?feed.ko:feed.en}</small></span><input type="checkbox" role="switch" aria-label={`${feed.name} ${ko?'사용':'enabled'}`} checked={enabled.includes(feed.id)} disabled={pending||!state} onChange={event=>{void onChange({action:'feed',feedId:feed.id,enabled:event.target.checked});}}/></label>)}
  <p className={styles.muted}>{ko?'켜진 소스에서 조회합니다. 응답이 없거나 지원되지 않는 자료는 해당 항목에 표시됩니다.':'Enabled sources are queried. Missing responses and unsupported coverage appear in each section.'}</p>
  <a className={styles.manage} href="/library/mcps">{ko?'커넥터와 플러그인':'Connectors and plugins'}</a>
 </div>;
}
