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
  <details className={styles.details}><summary>{ko?'분류별로 다르게':'Per category'}</summary>
   <p className={styles.muted}>{ko?'분류별로 고른 소스는 위의 기본 소스보다 우선합니다. 고르지 않은 분류는 기본 소스를 씁니다. 대화·대시보드·브리핑에 모두 적용됩니다.':'A source chosen for a category overrides the default source above. Categories left on the default use the default source. Applies to chats, dashboards and briefings.'}</p>
   {FINANCE_DATA_CATEGORIES.map(category=>{
    const selected=state?.sourceBindings?.[category]??'';
    const missing=!!selected&&!state?.sources.some(source=>source.id===selected);
    return <label className={styles.field} key={category}>{categoryLabels[category][ko?0:1]}<select value={selected} disabled={pending||!state||state.sourceRoutingStatus==='unavailable'} onChange={event=>{void onChange({action:'source.binding',category,sourceId:event.target.value||null});}}>
     <option value="">{ko?'기본 소스 사용':'Use default source'}</option>
     {missing&&<option value={selected} disabled>{ko?'선택한 도구 · 사용 불가':'Selected source · Unavailable'}</option>}
     {state?.sources.map(source=><option key={source.id} value={source.id} disabled={!source.available}>{source.id==='finance-yfinance'?(ko?'무료 시장 데이터':'Free market data'):source.name}{source.version?` · ${source.version}`:''}{!source.available?` · ${ko?'사용 불가':'Unavailable'}`:''}</option>)}
    </select></label>;
   })}
  </details>
  <h3>{ko?'뉴스·일정 피드':'News and calendar feeds'}</h3>
  <p className={styles.muted}>{ko?'끄면 대시보드에서 해당 피드를 표시하지 않습니다.':'Turn a feed off to hide it from the dashboard.'}</p>
  {feeds.map(feed=><label className={styles.row} key={feed.id}><span className={styles.connectionLabel}><strong>{ko?feed.ko:feed.en}</strong></span><input type="checkbox" role="switch" aria-label={`${ko?feed.ko:feed.en} ${ko?'피드 표시':'feed shown'}`} checked={enabled.includes(feed.id)} disabled={pending||!state} title={!state?(ko?'설정을 불러오는 중입니다':'Settings are loading'):undefined} onChange={event=>{void onChange({action:'feed',feedId:feed.id,enabled:event.target.checked});}}/></label>)}
 </div>;
}
