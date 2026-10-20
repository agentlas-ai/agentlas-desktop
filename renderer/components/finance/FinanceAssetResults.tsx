"use client";

import { useId, useState } from "react";
import { IconCheck, IconChevronDown, IconChevronRight, IconClose, IconPlus, IconSearch } from "@/components/Icon";
import type { FinanceAsset, FinanceSearchResult, FinanceSecurityIdentity } from "@shared/finance";
import styles from "./FinanceAssetResults.module.css";

interface FinanceAssetResultsProps {
  result: FinanceSearchResult;
  ko: boolean;
  query?: string;
  selectedAssetId?: string;
  watchlistIds: ReadonlySet<string>;
  disabled?: boolean;
  onSelect?: (asset: FinanceAsset) => void;
  onWatchlist?: (asset: FinanceAsset) => void;
  onResearch?: (asset: FinanceAsset) => void;
}

function candidateLabel(asset: FinanceAsset, ko: boolean): string {
  return [asset.name, asset.symbol, asset.exchange || (ko ? "거래소 미확인" : "Exchange unknown"), asset.currency === "XXX" ? (ko ? "통화 미확인" : "Currency unknown") : asset.currency].join(" · ");
}

function AssetRow({ asset, identity, ko, selected, added, disabled, onSelect, onWatchlist, onResearch }: {
  asset: FinanceAsset; identity?: FinanceSecurityIdentity; ko: boolean; selected: boolean; added: boolean;
  disabled?: boolean; onSelect?: () => void; onWatchlist?: () => void; onResearch?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const l = (k: string, e: string) => ko ? k : e;
  const exchange = asset.exchange || l("거래소 미확인", "Exchange unknown");
  const currency = asset.currency === "XXX" ? l("통화 미확인", "Currency unknown") : asset.currency;
  const label = candidateLabel(asset, ko);
  const kinds: Record<FinanceAsset["kind"], string> = { stock:l("주식", "Stock"), etf:"ETF", fund:l("펀드", "Fund"), bond:l("채권", "Bond"), crypto:l("가상자산", "Crypto"), commodity:l("원자재", "Commodity"), other:l("기타", "Other") };
  const issuerUrl = identity?.issuer?.sourceUrl;
  const Identity = onSelect ? "button" : "div";
  return <li className={`${styles.item} ${selected ? styles.selected : ""}`}>
    <div className={styles.row}>
      <Identity type={onSelect ? "button" : undefined} className={styles.identity} aria-pressed={onSelect ? selected : undefined} disabled={onSelect ? disabled : undefined} onClick={onSelect}
        aria-label={onSelect ? `${l("자산 선택", "Select asset")}: ${label}` : label} title={label} style={onSelect ? undefined : {cursor:"default"}}>
        <span className={styles.primary}><strong title={asset.symbol}>{asset.symbol}</strong><span title={asset.name}>{asset.name}</span>{selected && <IconCheck size={14}/>}</span>
        <span className={styles.secondary} title={`${exchange} · ${currency}`}>{exchange} · {currency}</span>
      </Identity>
      <div className={styles.actions}>
        {onWatchlist && <button type="button" className={styles.action} onClick={onWatchlist} disabled={disabled || added}
          aria-label={`${added ? l("관심 자산에 추가됨", "Already in watchlist") : l("관심 자산 추가", "Add to watchlist")}: ${label}`} title={`${added ? l("추가됨", "Added") : l("관심 자산 추가", "Add to watchlist")}: ${label}`}>{added ? <IconCheck size={16}/> : <IconPlus size={16}/>}</button>}
        {onResearch && <button type="button" className={styles.action} onClick={onResearch} disabled={disabled}
          aria-label={`${l("이 자산으로 질문 작성", "Draft a question about this asset")}: ${label}`} title={`${l("이 자산으로 질문 작성", "Draft a question about this asset")}: ${label}`}><IconSearch size={16}/></button>}
        <button type="button" className={styles.action} aria-controls={detailId} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
          aria-label={`${expanded ? l("자산 상세 접기", "Collapse asset details") : l("자산 상세 펼치기", "Expand asset details")}: ${label}`} title={`${expanded ? l("상세 접기", "Collapse details") : l("상세 보기", "View details")}: ${label}`}>{expanded ? <IconChevronDown size={16}/> : <IconChevronRight size={16}/>}</button>
      </div>
    </div>
    {expanded && <div id={detailId} className={styles.details}>
      <p className={styles.fullName}>{asset.name}</p>
      <dl><div><dt>{l("종목", "Symbol")}</dt><dd>{asset.symbol}</dd></div><div><dt>{l("거래소", "Exchange")}</dt><dd>{exchange}</dd></div><div><dt>{l("통화", "Currency")}</dt><dd>{currency}</dd></div><div><dt>{l("자산 유형", "Asset type")}</dt><dd>{kinds[asset.kind]}</dd></div>
        {identity?.securityType && <div><dt>{l("증권 종류", "Security type")}</dt><dd>{identity.securityType}</dd></div>}
        {identity?.issuer && <div><dt>{l("발행 법인", "Legal issuer")}</dt><dd>{identity.issuer.name}{issuerUrl && /^https?:\/\//i.test(issuerUrl) && <a href={issuerUrl} target="_blank" rel="noopener noreferrer">{l("공식 정보", "Official information")}</a>}</dd></div>}
      </dl>
      {!identity?.issuer && <p className={styles.unknown}>{l("발행 법인은 확인되지 않았습니다.", "The legal issuer has not been verified.")}</p>}
    </div>}
  </li>;
}

/** Provider-returned candidates stay separate securities; selecting never mutates saved assets. */
export function FinanceAssetResults({ result, ko, query, selectedAssetId, watchlistIds, disabled, onSelect, onWatchlist, onResearch }: FinanceAssetResultsProps) {
  return <section className={styles.results} aria-label={query ? `${ko ? "자산 검색 결과" : "Asset search results"}: ${query}` : ko ? "자산 검색 결과" : "Asset search results"}>
    {query && <p className={styles.query}>{query}</p>}
    {result.assets.length ? <ul className={styles.list}>{result.assets.map(asset => <AssetRow key={asset.id} asset={asset} identity={result.identities?.find(identity => identity.assetId === asset.id)} ko={ko} selected={selectedAssetId === asset.id} added={watchlistIds.has(asset.id)} disabled={disabled} onSelect={onSelect ? () => onSelect(asset) : undefined} onWatchlist={onWatchlist ? () => onWatchlist(asset) : undefined} onResearch={onResearch ? () => onResearch(asset) : undefined}/>)}</ul> : <p className={styles.empty}>{ko ? "검색 결과가 없습니다. 회사명이나 티커를 바꿔보세요." : "No results. Try another company name or symbol."}</p>}
  </section>;
}

export function FinanceSelectedAsset({ asset, ko, onRemove }: { asset: FinanceAsset; ko: boolean; onRemove: () => void }) {
  const label = candidateLabel(asset, ko);
  return <div className={styles.selection} role="group" aria-label={ko ? "질문에 선택한 자산" : "Asset selected for your question"}><span title={label}><strong>{asset.symbol}</strong><span>{asset.name}</span></span><button type="button" className={styles.action} onClick={onRemove} aria-label={`${ko ? "선택 자산 해제" : "Clear selected asset"}: ${label}`} title={`${ko ? "선택 해제" : "Clear selection"}: ${label}`}><IconClose size={14}/></button></div>;
}
