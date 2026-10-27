"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconClose, IconPlus } from "@/components/Icon";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import popup from "@/components/PanelPopover.module.css";
import type { FinanceAsset, FinanceQuote, FinanceSource } from "@shared/finance";
import { financeQuoteBasis } from "@shared/finance-portfolio";
import type { FinanceWorldMarketsResult } from "@shared/finance-experience";
import styles from "./FinanceMarketOverview.module.css";
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
const value=(amount:number|null|undefined,ko:boolean)=>finite(amount)?amount.toLocaleString(ko?"ko-KR":"en-US",{maximumFractionDigits:2}):"—";
const change=(amount:number|null|undefined,ko:boolean)=>finite(amount)?`${new Intl.NumberFormat(ko?"ko-KR":"en-US",{minimumFractionDigits:2,maximumFractionDigits:2,signDisplay:"exceptZero"}).format(Math.abs(amount)<.005?0:amount)}%`:"—";
export function FinanceMarketOverview({result,loading,ko,watchlist,quotes,sources,onFind,onAsset,worldMap,composer,children,feeds}:{result:FinanceWorldMarketsResult|null;loading:boolean;ko:boolean;watchlist:FinanceAsset[];quotes:FinanceQuote[];sources:FinanceSource[];onFind:()=>void;onAsset:(asset:FinanceAsset)=>void;worldMap:ReactNode;composer:ReactNode;children?:ReactNode;feeds?:ReactNode}){
 const markets=result?.markets??[],top=["US","GB","DE","JP"].map(code=>markets.find(market=>market.countryCode===code)).filter(market=>!!market);
 const [watchlistOpen,setWatchlistOpen]=useState(false);
 const watchlistId=useId(),watchlistRoot=useRef<HTMLDivElement>(null),watchlistTrigger=useRef<HTMLButtonElement>(null),addTrigger=useRef<HTMLButtonElement>(null);
 const closeWatchlist=()=>{setWatchlistOpen(false);watchlistTrigger.current?.focus();};
 const findAsset=()=>{closeWatchlist();onFind();};
 useDismissibleLayer({open:watchlistOpen,roots:[watchlistTrigger,watchlistRoot],restoreFocusRef:watchlistTrigger,onDismiss:()=>setWatchlistOpen(false)});
 useEffect(()=>{if(watchlistOpen)addTrigger.current?.focus();},[watchlistOpen]);
 return <div className={styles.layout}><div className={styles.main}><section>
  <div className={styles.overviewHead} onBlur={event=>{if(event.relatedTarget instanceof Node&&!event.currentTarget.contains(event.relatedTarget))setWatchlistOpen(false);}}>
   <h2>{ko?"상위 자산":"Top assets"}</h2>
   <button ref={watchlistTrigger} type="button" className={styles.iconButton} aria-label={ko?"관심목록":"Watchlist"} title={ko?"관심목록":"Watchlist"} aria-expanded={watchlistOpen} aria-controls={watchlistOpen?watchlistId:undefined} aria-haspopup="dialog" onClick={()=>setWatchlistOpen(open=>!open)}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L2.9 9.6l6.3-.9Z"/></svg>
   </button>
   {watchlistOpen&&<div ref={watchlistRoot} id={watchlistId} className={`${popup.panelPopover} ${styles.watchlist}`} role="dialog" aria-label={ko?"관심목록":"Watchlist"}>
    <div className={styles.watchHead}><h2>{ko?"관심목록":"Watchlist"}</h2><div className={styles.watchActions}><button ref={addTrigger} type="button" className={styles.iconButton} onClick={findAsset} aria-label={ko?"관심 자산 추가":"Add watchlist asset"} title={ko?"관심 자산 추가":"Add watchlist asset"}><IconPlus size={18}/></button><button type="button" className={styles.iconButton} onClick={closeWatchlist} aria-label={ko?"관심목록 닫기":"Close watchlist"} title={ko?"관심목록 닫기":"Close watchlist"}><IconClose size={18}/></button></div></div>
    <div className={styles.watchBody}>{watchlist.length?watchlist.slice(0,30).map(asset=>{const quote=quotes.filter(item=>item.assetId===asset.id&&item.priceBasis==="price"&&item.currency===asset.currency).sort((a,b)=>b.asOf.localeCompare(a.asOf))[0];// The price a row shows says whose it is and from when: a price the owner entered is not a current market quote.
const basis=quote?financeQuoteBasis(sources,quote):null;return <button type="button" className={styles.watchRow} key={asset.id} onClick={()=>{closeWatchlist();onAsset(asset);}} title={quote&&basis?`${basis==="entered"?(ko?"입력한 가격":"Entered price"):(ko?"시세":"Market price")} · ${quote.asOf.slice(0,10)}${basis==="entered"?(ko?" — 현재 시세가 아닙니다":" — not a current market quote"):""}`:undefined}><span className={styles.identity}><strong>{asset.symbol}</strong><span title={asset.name}>{asset.name}</span></span><span className={styles.watchPrice}>{value(quote?.price,ko)}<small>{quote?.currency??(asset.currency!=="XXX"?asset.currency:"")}{quote&&basis?` · ${basis==="entered"?(ko?"입력가":"entered"):(ko?"시세":"market")} ${quote.asOf.slice(5,10)}`:""}</small></span></button>}):<button type="button" className={styles.addAsset} onClick={findAsset}>{ko?"종목 추가":"Add an asset"}</button>}</div>
   </div>}
  </div>
  <div className={styles.topAssets}>{top.length?top.map(market=><article key={market.id} className={styles.assetCard}><h3>{market.index.name}</h3><div className={styles.assetValue}>{value(market.index.value,ko)}</div><span className={finite(market.index.changePercent)&&market.index.changePercent<0?styles.down:styles.up}>{change(market.index.changePercent,ko)}</span></article>):<p className={styles.unavailable} role="status">{loading?(ko?"불러오는 중…":"Loading…"):(ko?"표시할 시세가 없습니다":"No market observations")}</p>}</div>
 </section>{worldMap}{children}{feeds}{composer&&<div className={styles.composer}>{composer}</div>}</div></div>;
}
