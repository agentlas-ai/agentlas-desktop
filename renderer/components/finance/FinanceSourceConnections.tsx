"use client";
import type { FinanceExperienceRequest, FinanceExperienceState } from '@shared/finance-experience';
import type { FinanceFeedId } from '@shared/finance-feeds';
import { FINANCE_DATA_CATEGORIES, type FinanceDataCategory } from '@shared/finance-data-routing';
import styles from './FinanceSettingsDialog.module.css';

const feeds: {id:FinanceFeedId;name:string;ko:string;en:string}[]=[
 {id:'finance-news',name:'News',ko:'뉴스',en:'News'},
 {id:'finance-sec',name:'Filings and financials',ko:'공시·재무',en:'Filings and financials'},
 {id:'finance-economy',name:'Economic calendar',ko:'경제 일정',en:'Economic calendar'},
 {id:'finance-earnings',name:'Earnings calendar',ko:'실적 발표',en:'Earnings calendar'},
];
const categoryLabels:Record<FinanceDataCategory,[string,string]>={
 market:['주가·종목 검색','Prices and search'],news:['뉴스','News'],filings:['공시·재무','Filings and financials'],
 social:['SNS','Social'],funds:['ETF·펀드','ETFs and funds'],macro:['금리·경제','Rates and macro'],calendar:['경제·실적 일정','Economic and earnings calendar'],
};
export function FinanceSourceConnections({ko,state,pending,onChange}:{ko:boolean;state:FinanceExperienceState|null;pending:boolean;onChange:(request:FinanceExperienceRequest)=>Promise<void>}){
 const enabled=state?.enabledFeedIds??feeds.map(feed=>feed.id);
 return <div className={styles.connections}>
  <h3>{ko?'뉴스와 일정':'News and calendar'}</h3>
  {feeds.map(feed=><label className={styles.row} key={feed.id}><span className={styles.connectionLabel}><strong>{ko?feed.ko:feed.en}</strong></span><input type="checkbox" role="switch" aria-label={`${ko?feed.ko:feed.en} ${ko?'사용':'enabled'}`} checked={enabled.includes(feed.id)} disabled={pending||!state} onChange={event=>{void onChange({action:'feed',feedId:feed.id,enabled:event.target.checked});}}/></label>)}
  <details className={styles.details}><summary>{ko?'종류별 연결':'Sources by category'}</summary>
   <p className={styles.muted}>{ko?'대화·대시보드·브리핑에 함께 적용됩니다.':'Applies to conversations, dashboards and briefings.'}</p>
   {FINANCE_DATA_CATEGORIES.map(category=>{
    const selected=state?.sourceBindings?.[category]??'';
    const missing=!!selected&&!state?.sources.some(source=>source.id===selected);
    return <label className={styles.field} key={category}>{categoryLabels[category][ko?0:1]}<select value={selected} disabled={pending||!state||state.sourceRoutingStatus==='unavailable'} onChange={event=>{void onChange({action:'source.binding',category,sourceId:event.target.value||null});}}>
     <option value="">{ko?'기본 연결':'Default source'}</option>
     {missing&&<option value={selected} disabled>{ko?'선택한 도구 · 사용 불가':'Selected source · Unavailable'}</option>}
     {state?.sources.map(source=><option key={source.id} value={source.id} disabled={!source.available}>{source.id==='finance-yfinance'?(ko?'무료 시장 데이터':'Free market data'):source.name}{source.version?` · ${source.version}`:''}{!source.available?` · ${ko?'사용 불가':'Unavailable'}`:''}</option>)}
    </select></label>;
   })}
  </details>
  <a className={styles.manage} href="/library/mcps">{ko?'커넥터와 플러그인':'Connectors and plugins'}</a>
 </div>;
}
