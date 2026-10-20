"use client";

import { useContext, useEffect, useState } from "react";
import { IconChat, IconCheck, IconPlus, IconTrash } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { IntellectUiActions } from "@/lib/intellect-ui-actions";
import type { FinanceWorkspace } from "@shared/finance";
import { FinancePortfolioRequestSchema, financePortfolioHeldPosition, financePortfolioRowIssues, type FinancePortfolioDraft, type FinancePortfolioRowIssue, type FinancePortfolioRequest } from "@shared/finance-portfolio";
import { financePortfolioBlankRow, financePortfolioCanSave, financePortfolioFieldPatch, type FinancePortfolioField } from "./FinancePortfolioImport";
import styles from "./FinanceHoldingsReview.module.css";

type Row = FinancePortfolioDraft["rows"][number];
type Snapshot = Pick<FinanceWorkspace, "revision" | "watchlist" | "holdings">;
/** What the card tells its UI instance once the owner has saved: the instance leaves the awaiting-input state. */
export interface FinanceHoldingsSettlement { state: "ready"; fallbackText: string }
const FIELDS: readonly FinancePortfolioField[] = ["name", "symbol", "exchange", "currency", "quantity", "averageCost", "price", "asOf"];
const NUMERIC: ReadonlySet<FinancePortfolioField> = new Set<FinancePortfolioField>(["quantity", "averageCost", "price"]);
const ISSUE_FIELD: Record<FinancePortfolioRowIssue, FinancePortfolioField> = { symbol_required: "symbol", currency_required: "currency", quantity_required: "quantity", price_date_required: "asOf" };

/**
 * Holdings the assistant read from the owner's photo or text, to be edited and saved by the owner. The model never saves: this card's
 * Save is the same `finance:portfolio` save the Finance screen's import uses, with the same row checks and the same revision guard.
 */
export function FinanceHoldingsReview({ draft, instanceState, fallbackText, locale, onSettle }: {
  draft: FinancePortfolioDraft; instanceState: string; fallbackText: string; locale: "ko" | "en";
  onSettle?: (settlement: FinanceHoldingsSettlement) => Promise<unknown>;
}) {
  const ko = locale === "ko", l = (k: string, e: string) => ko ? k : e;
  const composer = useContext(IntellectUiActions);
  const [rows, setRows] = useState<Row[]>(() => draft.rows.map(row => ({ ...row, notes: [...row.notes] })));
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<Snapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reviewBase, setReviewBase] = useState<number | null>(null);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    const api = ipc()?.finance;
    if (!api?.load) { setLoadFailed(true); return; }
    let alive = true;
    const read = () => api.load().then(value => {
      if (!alive) return;
      setWorkspace({ revision: value.revision, watchlist: value.watchlist, holdings: value.holdings });
      setLoadFailed(false);
      setReviewBase(current => current ?? value.revision);
    }).catch(() => { if (alive) setLoadFailed(true); });
    void read();
    const off = api.onChanged?.(() => { void read(); });
    return () => { alive = false; off?.(); };
  }, []);

  const mode = saved || instanceState === "ready" ? "saved" : instanceState === "cancelled" ? "replaced" : instanceState === "awaiting-input" ? "review" : "closed";
  const edit = (id: string, patch: Partial<Row>) => { setRows(previous => previous.map(row => row.id === id ? { ...row, ...patch } : row)); setReviewed(false); };
  const changed = workspace !== null && reviewBase !== null && workspace.revision !== reviewBase;
  const canSave = mode === "review" && !pending && reviewed && financePortfolioCanSave(rows) && workspace !== null && !changed && !loadFailed;

  const save = async () => {
    const api = ipc()?.finance;
    if (!canSave || !api?.portfolio || reviewBase === null) return;
    const request: FinancePortfolioRequest = { action: "save", expectedRevision: reviewBase, rows };
    if (!FinancePortfolioRequestSchema.safeParse(request).success) return;
    setPending(true); setError("");
    try {
      const result = await api.portfolio(request);
      if (!result.workspace) throw new Error("missing_workspace");
      const listed = rows.map(row => `${row.symbol} ${row.quantity}`).join(" · ");
      const summary = (ko ? `보유자산 ${rows.length}개를 저장했습니다: ${listed}` : `Saved ${rows.length} holdings: ${listed}`).slice(0, 600);
      setSaved(summary);
      await onSettle?.({ state: "ready", fallbackText: summary }).catch(() => undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setError(/revision_conflict/.test(message)
        ? l("보유자산이 바뀌었습니다. 입력 내용은 보존했습니다. 최신 상태를 확인한 뒤 다시 저장하세요.", "Holdings changed. Your draft is preserved. Review the latest state before saving again.")
        : l("저장하지 못했습니다. 종목·통화·수량과 중복 항목을 확인하세요.", "Could not save. Check symbols, currencies, quantities and duplicates."));
    } finally { setPending(false); }
  };

  const labels = [l("이름", "Name"), l("종목", "Symbol"), l("거래소", "Exchange"), l("통화", "Currency"), l("수량", "Quantity"), l("평균단가", "Average cost"), l("가격", "Price"), l("기준일", "As of"), l("지금 저장된 수량", "Saved now"), ""];
  const heading = <header className={styles.head}><h3>{l("보유자산 확인", "Review holdings")}</h3><span className={`${styles.badge} ${mode === "saved" ? styles.done : ""}`}>{mode === "review" ? l("저장 전", "Not saved") : mode === "saved" ? l("저장됨", "Saved") : mode === "replaced" ? l("새 제안으로 대체됨", "Replaced") : l("닫힘", "Closed")}</span></header>;

  if (mode === "saved") {
    // Only text this card (or a settled update) wrote may describe what was saved; the proposal's own placeholder never does.
    const listed = saved || (fallbackText.startsWith("Finance holdings review") ? l("이 제안은 처리되었습니다.", "This proposal has been handled.") : fallbackText);
    return <div className={styles.root}>{heading}
      <p className={styles.text} role="status">{listed}</p>
      {workspace && <p className={styles.hint}>{l(`지금 Finance에 저장된 보유자산: ${workspace.holdings.length}개`, `Holdings now saved in Finance: ${workspace.holdings.length}`)}</p>}
      {composer.prepareFollowup && <div className={styles.footer}><button type="button" disabled={composer.disabled} onClick={() => void composer.prepareFollowup?.(l("저장한 보유자산으로 진단해 줘", "Diagnose the holdings I just saved"))}><IconChat size={16}/>{l("저장한 보유자산으로 진단", "Diagnose saved holdings")}</button></div>}
    </div>;
  }
  if (mode === "replaced" || mode === "closed") {
    return <div className={styles.root}>{heading}<p className={styles.hint} role="status">{mode === "replaced" ? l("더 새로운 제안이 이 자리를 대신합니다. 이 표로는 저장할 수 없습니다.", "A newer proposal replaces this one. This table can no longer be saved.") : l("이 제안은 닫혔습니다.", "This proposal is closed.")}</p></div>;
  }

  const notesByRow = rows.flatMap((row, index) => row.notes.length ? [{ index, label: row.symbol || row.name || String(index + 1), notes: row.notes }] : []);
  return <div className={styles.root} role="group" aria-label={l("보유자산 확인", "Review holdings")}>{heading}
    <p className={styles.hint}>{l("어시스턴트가 사진·텍스트에서 읽은 값입니다. 원본과 비교해 고친 뒤 저장하세요. 저장하기 전에는 Finance에 아무것도 기록되지 않습니다.", "These are the values the assistant read from your photo or text. Compare them with the original, edit what is wrong, then save. Nothing is recorded in Finance until you save.")}</p>
    <div className={styles.scroll} role="region" tabIndex={0} aria-label={l("확인·편집할 보유자산", "Holdings to review and edit")}>
      <table><thead><tr>{labels.map((label, index) => <th key={index} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => {
          const invalid = new Set(financePortfolioRowIssues(row).map(issue => ISSUE_FIELD[issue]));
          const held = workspace && row.symbol && row.currency ? financePortfolioHeldPosition(workspace, row) : null;
          return <tr key={row.id}>
            {FIELDS.map(field => <td key={field}><input disabled={pending} aria-label={`${index + 1} ${field}`} aria-invalid={invalid.has(field) || undefined}
              value={row[field] ?? ""} type={NUMERIC.has(field) ? "number" : "text"} min={NUMERIC.has(field) ? 0 : undefined} step="any" inputMode={NUMERIC.has(field) ? "decimal" : undefined}
              onChange={event => edit(row.id, financePortfolioFieldPatch(field, event.target.value))}/></td>)}
            <td className={styles.held}>{held ? held.quantity : "—"}</td>
            <td><button type="button" disabled={pending} aria-label={l("행 제거", "Remove row")} title={l("행 제거", "Remove row")} onClick={() => { setRows(current => current.filter(item => item.id !== row.id)); setReviewed(false); }}><IconTrash size={16}/></button></td>
          </tr>;
        })}</tbody></table>
    </div>
    <div className={styles.row}><button type="button" disabled={pending || rows.length >= 100} onClick={() => { setRows(current => [...current, financePortfolioBlankRow()]); setReviewed(false); }}><IconPlus size={16}/>{l("행 추가", "Add row")}</button></div>
    {notesByRow.length > 0 && <ul className={styles.notes}>{notesByRow.map(item => <li key={item.index}><strong>{item.label}</strong> {item.notes.join(" · ")}</li>)}</ul>}
    {draft.warnings.length > 0 && <ul className={styles.notes}>{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {!financePortfolioCanSave(rows) && <p className={styles.hint}>{l("종목·통화·수량이 비어 있거나 가격에 기준일이 없는 행이 있습니다. 채우거나 행을 제거하세요.", "Some rows lack a symbol, currency or quantity, or have a price without a date. Fill them in or remove the row.")}</p>}
    {changed && <p className={styles.error}>{l("보유자산이 변경되었습니다.", "Holdings have changed.")} <button type="button" disabled={pending} onClick={() => { setReviewBase(workspace?.revision ?? null); setReviewed(false); }}>{l("최신 상태로 다시 확인", "Review against latest state")}</button></p>}
    {loadFailed && <p className={styles.error} role="alert">{l("Finance 보유자산을 불러오지 못해 저장할 수 없습니다.", "Finance holdings could not be loaded, so nothing can be saved.")}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <footer className={styles.footer}>
      <p className={styles.hint}>{l("같은 자산의 보유 수량을 이 값으로 바꿉니다. 합산하지 않습니다.", "For the same asset, this replaces the held quantity; it does not add to it.")}</p>
      <label><input type="checkbox" checked={reviewed} disabled={pending} onChange={event => setReviewed(event.target.checked)}/>{l("종목·통화·수량과 단가를 확인했습니다", "I reviewed the symbols, currencies, quantities and costs")}</label>
      <button type="button" className={styles.primary} disabled={!canSave} onClick={() => void save()}><IconCheck size={16}/>{pending ? l("저장 중…", "Saving…") : l("보유자산 저장", "Save holdings")}</button>
    </footer>
  </div>;
}
