"use client";
import { useId, useState } from "react";
import type { FinanceAIResult, FinanceConversationDataResult, FinanceDataResult } from "@shared/finance";
import { financeQueryScope } from "@shared/finance-query-scope";
import { IconChevronDown, IconChevronRight, IconChevronLeft } from "@/components/Icon";
import { FinanceDataResultView, financeDataVisual } from "./FinanceDataResultView";
import { financeFeedLink } from "./FinanceDashboardFeed";
import { financeCell, financeColumn } from "./FinanceMessage";
import type { FinanceInlineSnapshot } from "./FinanceInlineArtifact";
import styles from "./FinanceInlineQueryResult.module.css";

export interface FinanceInlineQuerySnapshot { entry: FinanceConversationDataResult; ownerScope: string | null; revision: number }
/** Real returned datasets remain visible even when the model cannot finish its explanation. */
export function financeInlineQuerySnapshots(response: FinanceAIResult, ownerScope: string | null, revision: number, artifacts: readonly FinanceInlineSnapshot[]): FinanceInlineQuerySnapshot[] {
  if (response.status === "cancelled" || response.status === "conflict" || response.status === "invalid_output") return [];
  const reports = new Set(artifacts.filter(item => item.ownerScope === ownerScope).map(item => item.report.id));
  // A saved report may keep these rows as supporting evidence without displaying them.
  return (response.dataResults ?? []).filter(entry => entry.presentation !== undefined || !entry.reportIds?.some(id => reports.has(id))).map(entry => ({ entry: structuredClone(entry), ownerScope, revision }));
}
/** Resolve only original row references. An explicit empty selection never means all rows. */
export function financeQuerySelection(entry: FinanceConversationDataResult): { status: "all" | "selected" | "invalid"; result: FinanceDataResult; rowIndices: number[] } {
  const indices = entry.presentation?.rowIndices;
  if (entry.presentation === undefined) return { status: "all", result: entry.result, rowIndices: entry.result.rows.map((_, index) => index) };
  if (!Array.isArray(indices) || indices.some(index => !Number.isInteger(index) || index < 0 || index >= entry.result.rows.length) || new Set(indices).size !== indices.length) return { status: "invalid", result: { ...entry.result, rows: [] }, rowIndices: [] };
  return { status: "selected", result: { ...entry.result, rows: indices.map(index => entry.result.rows[index]) }, rowIndices: indices };
}
interface QueryItem { title: string; meta: { column: string; value: string }[]; href: string | null; row: (string | number | null)[]; value?: number | null; currency?: string | null; titleColumn?: number }
export interface FinanceQueryPresentation { kind: "news" | "filings" | "social" | "feeds" | "quote" | "visual" | "records"; items: QueryItem[]; metric?: string; tooManyPoints?: boolean }
const ADMIN_FIELDS = new Set(["URL", "Source", "Source ID", "Source URL", "Retrieved at", "Accession", "Document", "Original filing"]);
/** In a row's details the value that is the row's own typed link is that link. Every other value stays text: only the typed item link can navigate. */
export function financeQueryFieldLink(href: string | null, value: string | number | null): string | null { return href && typeof value === "string" && financeFeedLink(value) === href ? href : null; }
/** Exact tool metric and provider column contracts choose a view; prose never chooses behavior. */
export function financeQueryPresentation(entry: FinanceConversationDataResult): FinanceQueryPresentation {
  const { result } = entry, metric = entry.request?.metrics.length === 1 ? entry.request.metrics[0] : undefined;
  const at = (name: string) => result.columns.indexOf(name), has = (names: string[]) => names.every(name => at(name) >= 0);
  const text = (row: QueryItem["row"], name: string) => typeof row[at(name)] === "string" ? row[at(name)] as string : "";
  const metadata = (row: QueryItem["row"], names: string[]) => names.map(column => ({ column, value: text(row, column) })).filter(item => item.value && !(item.column === "Symbol" && entry.assets.length === 1 && item.value === entry.assets[0].symbol));
  const records = (): FinanceQueryPresentation => { const titleColumn = result.columns.findIndex(name => !ADMIN_FIELDS.has(name)); return { kind: "records", items: result.rows.map(row => ({ title: titleColumn < 0 || row[titleColumn] === null ? "—" : String(row[titleColumn] ?? ""), titleColumn, meta: [], href: null, row })) }; };
  if (new Set(result.columns).size !== result.columns.length) return records();
  if (entry.kind !== "discovery" && ["price_history", "treasury_yields", "nav"].includes(metric ?? "")) {
    const visual = financeDataVisual(result, metric);
    if (visual.kind !== "table" && result.rows.length <= 2000) return { kind: "visual", items: [], metric };
    if (result.rows.length > 2000) return { ...records(), tooManyPoints: true };
  }
  let kind: FinanceQueryPresentation["kind"] = "records", title = "", meta: string[] = [], url = "";
  if (entry.kind === "feeds" && has(["Title", "Published", "Event date", "Symbol", "URL", "Source"])) { kind = "feeds"; title = "Title"; meta = ["Published", "Event date", "Symbol"]; url = "URL"; }
  else if (["news", "macro_news"].includes(metric ?? "")) {
    if (has(["Title", "Publisher", "Published", "URL"])) { kind = "news"; title = "Title"; meta = ["Publisher", "Published", "Symbol"]; url = "URL"; }
    else if (has(["Headline", "Publisher", "URL", "Published at"])) { kind = "news"; title = "Headline"; meta = ["Publisher", "Published at"]; url = "URL"; }
  } else if (metric === "filings" && has(["Form", "Filed", "Accession", "Document"])) { kind = "filings"; title = "Form"; meta = ["Filed"]; url = "Document"; }
  else if (["social", "social_search"].includes(metric ?? "")) {
    if (has(["Author handle", "Post text (claim)", "Author created at", "Original post"])) { kind = "social"; title = "Post text (claim)"; meta = ["Author handle", "Author created at"]; url = "Original post"; }
    else if (has(["Provider", "Author", "Post time", "Short claim", "Original post"])) { kind = "social"; title = "Short claim"; meta = ["Author", "Post time"]; url = "Original post"; }
  } else if (metric === "price" && (has(["Symbol", "Price", "Currency", "Observed at"]) || has(["Symbol", "Price", "Latest trading day", "Volume"]))) {
    return { kind: "quote", items: result.rows.map(row => { const value = row[at("Price")], currency = text(row, "Currency"); return { title: text(row, "Symbol"), meta: [], href: null, row, value: typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null, currency: /^[A-Z]{3}$/.test(currency) && currency !== "XXX" ? currency : null }; }) };
  }
  return kind === "records" ? records() : { kind, items: result.rows.map(row => ({ title: text(row, title) || "—", meta: metadata(row, meta), href: financeFeedLink(text(row, url)), row })) };
}
const metricLabels: Record<string, [string, string]> = { price: ["가격", "Price"], price_history: ["가격 이력", "Price history"], treasury_yields: ["국채 수익률", "Treasury yields"], nav: ["펀드 NAV", "Fund NAV"], news: ["뉴스", "News"], macro_news: ["거시 뉴스", "Macro news"], filings: ["공시", "Filings"], social: ["계정 글", "Author posts"], social_search: ["SNS 검색", "Social search"], company_facts: ["기업 재무", "Company facts"], etf_holdings: ["ETF 편입", "ETF holdings"] };
export function financeQueryNumber(value: number, ko: boolean): string {
  if (!Number.isFinite(value)) return "—";
  const tiny = value !== 0 && Math.abs(value) < .01;
  return new Intl.NumberFormat(ko ? "ko-KR" : "en-US", tiny ? { maximumSignificantDigits: 3, ...(Math.abs(value) < .0001 ? { notation: "scientific" as const } : {}) } : { maximumFractionDigits: 2 }).format(value);
}
const DATE_FIELDS = new Set(["Published", "Published at", "Event date", "Filed", "Author created at", "Post time", "Observed at", "Latest trading day"]);
/** Format only explicit calendar days or zoned instants; never infer a missing timezone. */
export function financeQueryDate(value: string, ko: boolean, now = new Date(), timeZone?: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!parts) return "";
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return "";
  const instant = parts[4] !== undefined;
  if (instant && (Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59 || parts[7] !== "Z" && (Number(parts[7].slice(1, 3)) > 23 || Number(parts[7].slice(4)) > 59))) return "";
  try {
    const date = instant ? new Date(value) : day;
    if (!Number.isFinite(date.getTime())) return "";
    const currentYear = new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(now);
    const year = instant ? new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(date) : parts[1];
    return new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", { ...(year !== currentYear ? { year: "numeric" as const } : {}), month: "short", day: "numeric", ...(instant ? { hour: "2-digit" as const, minute: "2-digit" as const } : {}), timeZone: instant ? timeZone : "UTC" }).format(date);
  } catch { return ""; }
}
function Row({ item, result, kind, ko }: { item: QueryItem; result: FinanceDataResult; kind: FinanceQueryPresentation["kind"]; ko: boolean }) {
  const [expanded, setExpanded] = useState(false), id = useId();
  const money = item.value === undefined || item.value === null ? null : financeQueryNumber(item.value, ko);
  const meta = item.meta.map(item => DATE_FIELDS.has(item.column) ? financeQueryDate(item.value, ko) : item.value).filter(Boolean);
  const fields = result.columns.map((name, index) => ({ name, index, value: item.row[index] ?? null })).filter(field => expanded || !ADMIN_FIELDS.has(field.name));
  return <li className={styles.item}><div className={styles.itemHead}><div className={styles.identity}>
    {item.href ? <a className={styles.title} href={item.href} target="_blank" rel="noopener noreferrer" title={item.title}>{item.title}</a> : <strong className={styles.title} title={item.title}>{item.title}</strong>}
    {!!meta.length && <span className={styles.secondary} title={item.meta.map(item => item.value).join(" · ")}>{meta.join(" · ")}</span>}
    {kind === "quote" && <p className={styles.price}>{money ?? (ko ? "미확인" : "Unknown")} <small>{item.currency ?? (ko ? "통화 미확인" : "Currency unknown")}</small></p>}
  </div><button type="button" className={styles.expand} aria-expanded={expanded} aria-controls={id} aria-label={`${ko ? "조회 상세" : "Result details"} · ${item.title}`} title={ko ? "상세 보기" : "View details"} onClick={() => setExpanded(value => !value)}>{expanded ? <IconChevronDown size={16}/> : <IconChevronRight size={16}/>}</button></div>
    {kind === "records" && !expanded && <dl className={styles.values}>{fields.filter(field => field.index !== item.titleColumn).slice(0, 4).map((field, index) => <div key={index}><dt title={financeColumn(field.name, ko)}>{financeColumn(field.name, ko)}</dt><dd title={String(field.value ?? "")}>{typeof field.value === "number" ? financeQueryNumber(field.value, ko) : financeCell(field.value, field.name, ko)}</dd></div>)}</dl>}
    {expanded && <div className={styles.rowDetail} id={id}><p>{item.title}</p><dl className={styles.values}>{fields.map((field, index) => { const cell = typeof field.value === "number" ? financeQueryNumber(field.value, ko) : financeCell(field.value, field.name, ko), link = financeQueryFieldLink(item.href, field.value); return <div key={index}><dt>{financeColumn(field.name, ko)}</dt><dd>{link ? <a href={link} target="_blank" rel="noopener noreferrer">{cell}</a> : cell}</dd></div>; })}</dl></div>}
  </li>;
}
/** Raw rows are explicit, paged text. Only the typed item link above can navigate. */
function RawData({ result, ko }: { result: FinanceDataResult; ko: boolean }) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(result.rows.length / 50)), current = Math.min(page, pages - 1);
  const display = (value: string | number | null | undefined) => value === null || value === undefined ? "—" : typeof value === "number" ? financeQueryNumber(value, ko) : value;
  return <><div className={styles.raw} role="region" tabIndex={0} aria-label={ko ? "조회 원자료" : "Original query data"}><table><caption className={styles.srOnly}>{ko ? "조회 원자료" : "Original query data"}</caption><thead><tr>{result.columns.map((name, index) => <th key={index} scope="col">{financeColumn(name, ko)}</th>)}</tr></thead><tbody>{result.rows.slice(current * 50, (current + 1) * 50).map((row, index) => <tr key={index}>{result.columns.map((name, column) => <td key={column} title={typeof row[column] === "number" ? String(row[column]) : undefined}>{display(row[column])}</td>)}</tr>)}</tbody></table></div>{pages > 1 && <nav className={styles.paging} aria-label={ko ? "원자료 페이지" : "Original data pages"}><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label={ko ? "이전" : "Previous"} title={ko ? "이전" : "Previous"}><IconChevronLeft size={16}/></button><span>{current + 1}/{pages}</span><button type="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)} aria-label={ko ? "다음" : "Next"} title={ko ? "다음" : "Next"}><IconChevronRight size={16}/></button></nav>}</>;
}
export function FinanceInlineQueryResult({ snapshot, messageId, locale }: { snapshot: FinanceInlineQuerySnapshot; messageId: string; locale: string }) {
  const { entry } = snapshot, { result } = entry, ko = locale === "ko", metric = entry.request?.metrics.length === 1 ? entry.request.metrics[0] : "";
  const [visible, setVisible] = useState(4), [showAll, setShowAll] = useState(false), selection = financeQuerySelection(entry);
  const displayed = showAll ? result : selection.result, presentation = financeQueryPresentation({ ...entry, result: displayed });
  const defaultTitle = entry.kind === "feeds" ? (ko ? "소식과 일정" : "Updates and calendar") : entry.kind === "discovery" ? (ko ? "종목 지표" : "Candidate metrics") : metricLabels[metric]?.[ko ? 0 : 1] ?? (ko ? "조회 결과" : "Query results");
  const title = !showAll && selection.status === "selected" && entry.presentation?.title?.trim() ? entry.presentation.title : defaultTitle;
  const scope = financeQueryScope(entry.request, entry.assets);
  const unavailable = result.status === "error" || result.status === "unconnected", invalid = !showAll && selection.status === "invalid", empty = !displayed.rows.length;
  const list = <ul className={styles.list}>{presentation.items.slice(0, visible).map((item, index) => <Row key={showAll ? index : selection.rowIndices[index]} item={item} result={displayed} kind={presentation.kind} ko={ko}/>)}</ul>;
  const more = presentation.kind !== "visual" && presentation.items.length > visible && <button type="button" className={styles.more} onClick={() => setVisible(count => count + 8)}>{ko ? "더 보기" : "Show more"} · {visible}/{presentation.items.length}</button>;
  return <section className={styles.card} data-query-result-id={`${messageId}:${entry.datasetId}`} aria-label={`${title}${scope ? ` · ${scope}` : ""}`}>
    <header className={styles.header}><h3 title={title}>{title}</h3>{scope && <p title={scope}>{scope}</p>}</header>
    {selection.status !== "all" && <div className={styles.viewControls} role="group" aria-label={ko ? "표시할 자료" : "Displayed data"}><button type="button" aria-pressed={!showAll} onClick={() => { setShowAll(false); setVisible(4); }}>{ko ? "선택 결과" : "Selected"} · {selection.rowIndices.length}</button><button type="button" aria-pressed={showAll} title={ko ? "선택되지 않은 행을 포함한 전체 원자료 보기" : "View all original rows, including unselected rows"} onClick={() => { setShowAll(true); setVisible(4); }}>{ko ? "전체" : "All"} · {result.rows.length}</button></div>}
    {unavailable || invalid || empty ? <p className={styles.status} role={result.status === "error" || invalid ? "alert" : "status"}>{unavailable ? (ko ? "자료를 가져오지 못했습니다." : "Data could not be retrieved.") : invalid ? (ko ? "선택한 행을 확인할 수 없습니다. 전체 원자료를 확인하세요." : "The selected rows could not be verified. View the original data.") : selection.status === "selected" && !showAll && result.rows.length ? (ko ? "선택된 결과가 없습니다." : "No rows were selected.") : (ko ? "반환된 결과가 없습니다." : "No results were returned.")}</p> : <>
      {presentation.kind === "social" && <p className={styles.note} title={ko ? "게시자 주장 · 미확인" : "Author claim · unverified"}>{ko ? "게시자 주장 · 미확인" : "Author claim · unverified"}</p>}
      {presentation.kind === "news" && entry.assets.length > 0 && <p className={styles.note} title={ko ? "조회 대상 기준 · 관련성 미확인" : "Asset query · relevance unverified"}>{ko ? "조회 대상 기준 · 관련성 미확인" : "Asset query · relevance unverified"}</p>}
      {presentation.kind === "visual" ? <FinanceDataResultView result={displayed} metric={presentation.metric} locale={ko ? "ko" : "en"} compact chartType="line"/> : entry.kind === "discovery" ? <details className={styles.details}><summary>{ko ? "추가 지표" : "Additional metrics"} · {displayed.rows.length}</summary>{list}{more}</details> : list}
      {presentation.tooManyPoints && <p className={styles.note}>{ko ? "관측이 2,000개를 넘어 전체 자료는 상세에서 확인할 수 있습니다. 차트 일부만 표시하지 않았습니다." : "More than 2,000 observations. Open the full data below; a truncated chart is not shown."}</p>}
      {entry.kind !== "discovery" && more}
    </>}
    <details className={styles.details}><summary>{ko ? "자료 상세" : "Data details"}</summary>{result.warnings.length > 0 && <ul className={styles.warnings}>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<RawData result={result} ko={ko}/></details>
  </section>;
}
