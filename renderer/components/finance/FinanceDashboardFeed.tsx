"use client";
import { useEffect, useState } from "react";
import type { FinanceDashboardFeedItem, FinanceDashboardFeedsResult, FinanceFeedId } from "@shared/finance-feeds";
import { IconRefresh, IconSettings } from "@/components/Icon";
import styles from "./FinanceDashboardFeed.module.css";
const labels:Record<FinanceFeedId,[string,string]>={"finance-news":["최신 뉴스","Latest news"],"finance-sec":["공시","Filings"],"finance-economy":["경제 일정","Economic calendar"],"finance-earnings":["실적 발표","Earnings"]};
export function financeFeedLink(value:string):string|null{try{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password?url.href:null;}catch{return null;}}
export function financeFeedDate(value:string|null,precision:string|undefined,ko:boolean):string{if(!value)return "";if(precision==="day"||/^\d{4}-\d{2}-\d{2}$/.test(value))return /^\d{4}-\d{2}-\d{2}/.test(value)?value.slice(0,10):"";const stamp=new Date(value);return Number.isFinite(stamp.getTime())?new Intl.DateTimeFormat(ko?"ko-KR":"en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(stamp):"";}
// A display projection only: retain every watchlist association in the feed store.
export function financeNewsDisplayItems(items:FinanceDashboardFeedItem[]):FinanceDashboardFeedItem[]{
 const seen=new Set<string>();
 return items.filter(item=>{
  const href=financeFeedLink(item.url);
  if(!href)return true;
  const url=new URL(href);url.hash="";
  const key=url.href;
  if(seen.has(key))return false;
  seen.add(key);return true;
 });
}
const feedPageSize=(id:FinanceFeedId)=>id==="finance-news"?3:4;
const displayItems=(id:FinanceFeedId,items:FinanceDashboardFeedItem[])=>id==="finance-news"?financeNewsDisplayItems(items):items;
export function FinanceDashboardFeed({result,loading,ko,onRefresh,onSettings}:{result:FinanceDashboardFeedsResult|null;loading:boolean;ko:boolean;onRefresh:()=>void;onSettings:(id:FinanceFeedId)=>void}){
 const [pages,setPages]=useState<Partial<Record<FinanceFeedId,number>>>({});
 useEffect(()=>{
  setPages(current=>{
   const next:Partial<Record<FinanceFeedId,number>>={};
   for(const section of result?.sections??[]){
    const last=Math.max(0,Math.ceil(displayItems(section.id,section.items).length/feedPageSize(section.id))-1);
    next[section.id]=Math.min(current[section.id]??0,last);
   }
   return next;
  });
 },[result]);
 return <div className={styles.root} aria-label={ko?"시장 소식과 일정":"Market news and calendar"}>{!result&&<div className={styles.loading} role="status">{loading?(ko?"소식을 불러오는 중…":"Loading updates…"):(ko?"소식을 불러오지 못했습니다":"Updates unavailable")}<button type="button" disabled={loading} onClick={onRefresh} aria-label={ko?"다시 시도":"Retry"} title={ko?"다시 시도":"Retry"}><IconRefresh size={16}/></button></div>}{result?.sections.map(section=>{const noEarnings=section.id==="finance-earnings"&&!section.items.length&&section.errorCode==="finance_earnings_confirmed_source_unavailable",news=section.id==="finance-news",allItems=displayItems(section.id,section.items),size=feedPageSize(section.id),pageCount=Math.max(1,Math.ceil(allItems.length/size)),page=Math.min(pages[section.id]??0,pageCount-1),items=allItems.slice(page*size,(page+1)*size),label=labels[section.id]?.[ko?0:1]??section.id;return <section key={section.id} className={styles.section}><header><h2>{labels[section.id]?.[ko?0:1]??section.id}</h2>{!noEarnings&&<button type="button" disabled={loading} onClick={onRefresh} title={`${labels[section.id]?.[ko?0:1]??section.id} ${ko?"새로고침":"refresh"}`} aria-label={`${labels[section.id]?.[ko?0:1]??section.id} ${ko?"새로고침":"refresh"}`}><IconRefresh size={16}/></button>}</header>{noEarnings?<div className={styles.empty}>{ko?"연결된 실적 일정이 없습니다":"No earnings calendar connected"}<button type="button" onClick={()=>onSettings(section.id)} aria-label={ko?"설정":"Settings"} title={ko?"설정":"Settings"}><IconSettings size={16}/></button></div>:section.status==="disabled"?<button type="button" className={styles.connect} onClick={()=>onSettings(section.id)}>{ko?"설정에서 연결":"Connect in settings"}</button>:items.length?<div className={news?styles.articles:styles.events}>{items.map(item=>{const href=financeFeedLink(item.url),date=financeFeedDate(item.startsAt??item.publishedAt,item.datePrecision,ko),session=item.session&&item.session!=="unknown"?({"before-market":ko?"장전":"Before market","after-market":ko?"장후":"After market","during-market":ko?"장중":"During market"}[item.session]):"";return <article key={item.id} className={news?styles.article:styles.event}><div className={styles.itemMeta}>{date&&<time dateTime={item.startsAt??item.publishedAt??undefined}>{date}</time>}{item.assetSymbol&&<span>{item.assetSymbol}</span>}{section.id==="finance-earnings"&&item.scheduleStatus==="estimated"&&<span>{ko?"예정·추정":"Estimated"}</span>}{session&&<span>{session}</span>}{news&&item.publisher&&<span className={styles.publisher} title={item.publisher}>{item.publisher}</span>}</div>{href?<a href={href} target="_blank" rel="noopener noreferrer" title={item.title} aria-label={item.title}>{item.title}</a>:<span className={styles.title} title={item.title}>{item.title}</span>}</article>})}</div>:section.errorCode==="finance_feed_watchlist_required"?<p className={styles.empty} data-feed-reason={section.errorCode}>{ko?"관심 종목을 추가하면 공시와 실적 일정이 표시됩니다":"Add assets to your watchlist to see their filings and earnings dates"}</p>:<p className={styles.empty}>{section.status==="error"||section.status==="unavailable"?(ko?"불러오지 못했습니다":"Could not load updates"):(ko?"표시할 항목이 없습니다":"No items to display")}{(section.status==="error"||section.status==="unavailable")&&<button type="button" onClick={onRefresh} disabled={loading} aria-label={ko?"다시 시도":"Retry"} title={ko?"다시 시도":"Retry"}><IconRefresh size={16}/></button>}</p>}{pageCount>1&&<nav className={styles.pagination} aria-label={`${label} ${ko?"페이지":"pagination"}`}><button type="button" disabled={page===0} aria-label={`${label} ${ko?"이전 페이지":"previous page"}`} onClick={()=>setPages(current=>({...current,[section.id]:Math.max(0,page-1)}))}>{ko?"이전":"Previous"}</button><span role="status" aria-live="polite" aria-atomic="true">{ko?`${page+1} / ${pageCount} 페이지`:`Page ${page+1} of ${pageCount}`}</span><button type="button" disabled={page===pageCount-1} aria-label={`${label} ${ko?"다음 페이지":"next page"}`} onClick={()=>setPages(current=>({...current,[section.id]:Math.min(pageCount-1,page+1)}))}>{ko?"다음":"Next"}</button></nav>}</section>})}</div>;
}
