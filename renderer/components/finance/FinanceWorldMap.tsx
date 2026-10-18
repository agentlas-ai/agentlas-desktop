"use client";

import { useState } from "react";
import type { FinanceWorldMarket, FinanceWorldMarketsResult } from "@shared/finance-experience";
import { IconRefresh } from "@/components/Icon";
import geometry from "./finance-world-map.json";
import styles from "./FinanceWorldMap.module.css";

/** A continuous, zero-centred scale. Unknown observations never inherit a market colour. */
export function financeMarketColor(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return "var(--map-unknown)";
  const strength = Math.min(Math.abs(change) / 3, 1);
  const neutral = [228, 232, 231], end = change < 0 ? [215, 57, 67] : [17, 150, 103];
  return `rgb(${neutral.map((channel, i) => Math.round(channel + (end[i] - channel) * strength)).join(", ")})`;
}
function number(value: number | null, locale: string): string {
  return value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}
function delta(value: number | null): string { return value === null || !Number.isFinite(value) ? "—" : `${new Intl.NumberFormat("en-US",{minimumFractionDigits:2,maximumFractionDigits:2,signDisplay:"exceptZero"}).format(Math.abs(value)<0.005?0:value)}%`; }

export function FinanceWorldMap({ result, loading, onRefresh, ko }: {
  result: FinanceWorldMarketsResult | null; loading: boolean; onRefresh: () => void; ko: boolean;
}) {
  const [active, setActive] = useState<{ code: string; x: number; y: number } | null>(null);
  const markets = new Map(result?.markets.map(market => [market.countryCode, market]) ?? []);
  const locale = ko ? "ko-KR" : "en-US";
  const countryName = (code: string) => { const country = geometry.countries.find(c => c.code === code); return ko ? country?.ko ?? code : country?.name ?? code; };
  const show = (market: FinanceWorldMarket, anchor: number[]) => setActive({ code:market.countryCode, x: Math.min(75, Math.max(2, anchor[0] / 10)), y: Math.min(65, Math.max(8, anchor[1] / 5.05)) });
  const leading = ["US", "GB", "DE", "JP", "KR", "CN"].map(code => markets.get(code)).filter((m): m is FinanceWorldMarket => Boolean(m));
  const activeMarket=active ? markets.get(active.code) : undefined;
  return <section onKeyDown={event=>{if(event.key==="Escape"){setActive(null);}}} className={styles.root} aria-label={ko ? "세계 시장" : "World markets"}>
    <header className={styles.header}><div><h2>{ko ? "세계 시장" : "World markets"}</h2><span>{ko ? "주요 지수 · 전일 대비" : "Major indices · daily change"}</span></div><button type="button" aria-label={ko ? "세계 시장 새로고침" : "Refresh world markets"} onClick={onRefresh} disabled={loading}><IconRefresh size={18}/></button></header>
    <div className={styles.map} onPointerLeave={event => { if(!event.currentTarget.contains(document.activeElement)) setActive(null); }}>
      <svg viewBox="0 0 1000 505" role="group" aria-label={ko ? "국가별 시장 등락 지도" : "Market performance by country"}>
        {geometry.countries.map(country => {
          const market = markets.get(country.code), change = market?.index.changePercent ?? null;
          return <path key={`${country.code}:${country.name}`} d={country.path ?? ""} fill={financeMarketColor(change)} className={`${styles.country} ${active?.code === country.code ? styles.active : ""}`} tabIndex={market ? 0 : undefined} role={market ? "button" : undefined} aria-label={`${ko ? country.ko : country.name}${market ? ` ${market.index.name} ${delta(change)}` : ""}`} onPointerEnter={() => { if (market) show(market, country.anchor); else setActive(null); }} onFocus={() => { if (market) show(market, country.anchor); }} onBlur={() => setActive(null)} onClick={() => { if (market) show(market, country.anchor); }} onKeyDown={event => { if (market && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); show(market, country.anchor); } }}/>;
        })}
        {Object.entries(geometry.centers).map(([code, anchor]) => {
          const market=markets.get(code); if(!market)return null;
          return <circle key={code} cx={anchor[0]} cy={anchor[1]} r={4} fill={financeMarketColor(market.index.changePercent)} stroke="var(--paper)" strokeWidth={1} role="button" tabIndex={0} aria-label={`${market.name} ${market.index.name} ${delta(market.index.changePercent)}`} onPointerEnter={()=>show(market,anchor)} onFocus={()=>show(market,anchor)} onBlur={()=>setActive(null)} onClick={()=>show(market,anchor)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();show(market,anchor);}}}/>;
        })}
      </svg>
      {active && activeMarket && <aside className={styles.floating} style={{ left: `clamp(8px, ${active.x}%, calc(100% - 246px))`, top: `clamp(8px, ${Math.min(active.y,45)}%, calc(100% - 190px))` }} role="status"><strong>{countryName(activeMarket.countryCode)}</strong><div className={styles.quote}><span>{activeMarket.index.name}</span><b>{number(activeMarket.index.value, locale)}</b><em className={(activeMarket.index.changePercent ?? 0) < 0 ? styles.down : styles.up}>{delta(activeMarket.index.changePercent)}</em></div>{activeMarket.rates.map(rate => <div className={styles.rate} key={rate.symbol}><span>{ko && rate.symbol === "US-TREASURY:BC_10YEAR" ? "미국 국채 10Y" : rate.name}</span><b>{number(rate.value, locale)}{rate.value !== null ? "%" : ""}</b>{rate.asOf&&rate.asOf!==activeMarket.index.asOf&&<time>{rate.asOf}</time>}</div>)}{activeMarket.index.asOf && <time>{activeMarket.index.asOf}</time>}</aside>}
      {loading && !result && <div className={styles.message} role="status">{ko ? "시장을 불러오는 중…" : "Loading markets…"}</div>}
      {!loading && (!result || result.status === "unavailable") && <div className={styles.message} role="status"><span>{ko ? "시장을 불러오지 못했습니다." : "Markets could not be loaded."}</span><button type="button" onClick={onRefresh}>{ko ? "다시 시도" : "Retry"}</button></div>}
    </div>
    <div className={styles.legend}><span>−3%</span><i/><span>+3%</span></div>
    {leading.length > 0 && <div className={styles.strip}>{leading.map(market => <button type="button" key={market.id} onFocus={() => { const country = geometry.countries.find(c => c.code === market.countryCode); if (country) show(market, country.anchor); }} onBlur={() => setActive(null)} onClick={() => { const country = geometry.countries.find(c => c.code === market.countryCode); if (country) show(market, country.anchor); }}><span>{market.index.name}</span><b>{number(market.index.value, locale)}</b><em className={(market.index.changePercent ?? 0) < 0 ? styles.down : styles.up}>{delta(market.index.changePercent)}</em></button>)}</div>}
  </section>;
}
