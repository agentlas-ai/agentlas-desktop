"use client";

import { useContext, useEffect, useId, useRef, useState } from "react";
import { IconAlertTriangle, IconChat, IconCheck, IconRefresh } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { IntellectUiActions } from "@/lib/intellect-ui-actions";
import type { FinanceWorkspace } from "@shared/finance";
import { FinancePortfolioRequestSchema, financeHoldingsCanSave, financeHoldingsReviewMode, financePortfolioCleanRow, financePortfolioHeldPosition, financePortfolioProblems, financePortfolioRowIssues, financePortfolioSaveFailure, type FinancePortfolioDraft, type FinancePortfolioField, type FinancePortfolioRequest } from "@shared/finance-portfolio";
import { financePortfolioBlankRow, financePortfolioCanSave, financePortfolioFieldPatch } from "./FinancePortfolioImport";
import { FinanceHoldingsEditor, FinanceHoldingsProblems } from "./FinanceHoldingsEditor";
import styles from "./FinanceHoldingsReview.module.css";

type Row = FinancePortfolioDraft["rows"][number];
type Snapshot = Pick<FinanceWorkspace, "revision" | "watchlist" | "holdings">;
/** What the card tells its UI instance once the owner has saved: the instance leaves the awaiting-input state. */
export interface FinanceHoldingsSettlement { state: "ready"; fallbackText: string }
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
  const [rows, setRows] = useState<Row[]>(() => draft.rows.map(row => financePortfolioCleanRow({ ...row, notes: [...row.notes] })));
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<Snapshot | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reviewBase, setReviewBase] = useState<number | null>(null);
  const [saved, setSaved] = useState("");
  const [reload, setReload] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();

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
  }, [reload]);

  const mode = financeHoldingsReviewMode(instanceState, saved !== "");
  const edit = (id: string, patch: Partial<Row>) => { setRows(previous => previous.map(row => row.id === id ? { ...row, ...patch } : row)); setReviewed(false); };
  const changed = workspace !== null && reviewBase !== null && workspace.revision !== reviewBase;
  const canSave = financeHoldingsCanSave({ mode, pending, reviewed, rowsAccepted: financePortfolioCanSave(rows), workspaceLoaded: workspace !== null, changed, loadFailed });

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
      const summary = (ko ? `보유자산 ${rows.length}개를 저장했습니다: ${listed}` : `Saved ${rows.length} ${rows.length === 1 ? "holding" : "holdings"}: ${listed}`).slice(0, 600);
      setSaved(summary);
      await onSettle?.({ state: "ready", fallbackText: summary }).catch(() => undefined);
    } catch (cause) {
      const failure = financePortfolioSaveFailure(cause instanceof Error ? cause.message : "");
      setError(failure === "revision_conflict" ? l("보유자산이 바뀌었습니다. 입력 내용은 보존했습니다. 최신 상태를 확인한 뒤 다시 저장하세요.", "Holdings changed. Your draft is preserved. Review the latest state before saving again.")
        : failure === "duplicate_asset" ? l("같은 자산이 두 행 이상에 있습니다. 하나로 합치거나 한 행을 제거하세요.", "Two rows name the same asset. Merge them or remove one.")
        : failure === "identity_ambiguous" ? l("한 행이 저장된 자산 여러 개와 맞습니다. 거래소를 적어 구분하세요.", "A row matches more than one saved asset. State the exchange to tell them apart.")
        : failure === "position_ambiguous" ? l("저장된 같은 자산에 보유 항목이 여러 개라 교체할 수 없습니다. Finance 화면에서 정리한 뒤 다시 시도하세요.", "That asset has more than one saved holding, so it cannot be replaced. Clean it up on the Finance screen, then try again.")
        : l("저장하지 못했습니다. 종목·통화·수량과 중복 항목을 확인하세요.", "Could not save. Check symbols, currencies, quantities and duplicates."));
    } finally { setPending(false); }
  };

  const heldOf = (row: Row) => (workspace && row.symbol && row.currency ? financePortfolioHeldPosition(workspace, row)?.quantity ?? null : null);
  const count = rows.length;
  const holdings = (n: number) => l(`${n}개`, `${n} ${n === 1 ? "holding" : "holdings"}`);
  const badge = mode === "review" ? l("저장 전", "Not saved") : mode === "saved" ? l("저장됨", "Saved") : mode === "replaced" ? l("새 제안으로 대체됨", "Replaced") : l("닫힘", "Closed");
  const heading = <header className={styles.head}>
    <div className={styles.titles}><h3>{l("보유자산 확인", "Review holdings")}</h3>{mode === "review" && count > 0 && <p>{l(`사진·텍스트에서 읽은 보유자산 ${count}개`, `${holdings(count)} read from your photo or text`)}</p>}</div>
    <span className={`${styles.badge} ${mode === "saved" ? styles.done : ""}`} data-state={mode}><i aria-hidden="true"/>{badge}</span>
  </header>;

  if (mode === "saved") {
    // Only text this card (or a settled update) wrote may describe what was saved; the proposal's own placeholder never does.
    const listed = saved || (fallbackText.startsWith("Finance holdings review") ? l("이 제안은 처리되었습니다.", "This proposal has been handled.") : fallbackText);
    return <div className={styles.root}>{heading}
      <div className={styles.done_panel}><span className={styles.check} aria-hidden="true"><IconCheck size={16}/></span><div><p className={styles.text} role="status">{listed}</p>
        {workspace && <p className={styles.hint}>{l(`지금 Finance에 저장된 보유자산: ${workspace.holdings.length}개`, `Holdings now saved in Finance: ${workspace.holdings.length}`)}</p>}</div></div>
      {composer.prepareFollowup && <div className={styles.footer}><span/><button type="button" className={styles.primary} disabled={composer.disabled} onClick={() => void composer.prepareFollowup?.(l("저장한 보유자산으로 진단해 줘", "Diagnose the holdings I just saved"))}><IconChat size={16}/>{l("저장한 보유자산으로 진단", "Diagnose saved holdings")}</button></div>}
    </div>;
  }
  if (mode === "replaced" || mode === "closed") {
    return <div className={styles.root}>{heading}<p className={styles.muted} role="status">{mode === "replaced" ? l("더 새로운 제안이 이 자리를 대신합니다. 이 표로는 저장할 수 없습니다.", "A newer proposal replaces this one. This table can no longer be saved.") : l("이 제안은 닫혔습니다.", "This proposal is closed.")}</p></div>;
  }

  const notesByRow = rows.flatMap((row, index) => row.notes.length ? [{ index, label: row.symbol || row.name || String(index + 1), notes: row.notes }] : []);
  const problems = financePortfolioProblems(rows);
  const focusCell = (row: number, field: FinancePortfolioField) => rootRef.current?.querySelector<HTMLInputElement>(`input[aria-label="${row} ${field}"]`)?.focus();
  const replacing = rows.filter(row => heldOf(row) !== null);
  const rowsAccepted = financePortfolioCanSave(rows);
  const reason = canSave ? "" : pending ? "" : changed ? l("보유자산이 바뀌었습니다. 최신 상태로 다시 확인하세요.", "Holdings changed. Review against the latest state first.")
    : loadFailed ? l("저장된 보유자산을 불러오지 못했습니다.", "Saved holdings could not be loaded.")
    : workspace === null ? l("저장된 보유자산을 확인하는 중…", "Checking saved holdings…")
    : !rowsAccepted ? (rows.length === 0 ? l("행을 하나 이상 남기거나 추가하세요.", "Keep or add at least one row.") : problems.length === 0 ? l("비어 있는 행을 채우거나 제거하세요.", "Fill in the empty row or remove it.") : l("표시된 값을 먼저 고치세요.", "Fix the marked values first."))
    : !reviewed ? l("확인했다고 표시하면 저장할 수 있습니다.", "Tick the review box to enable Save.") : "";
  return <div className={styles.root} role="group" aria-label={l("보유자산 확인", "Review holdings")} ref={rootRef}>{heading}
    <FinanceHoldingsProblems rows={rows} ko={ko} onFocus={focusCell} />
    {(notesByRow.length > 0 || draft.warnings.length > 0) && <aside className={styles.callout} aria-label={l("어시스턴트 메모", "Assistant notes")}>
      <IconAlertTriangle size={14}/>
      <div><strong>{l("원본과 비교해 보세요", "Compare these with your original")}</strong>
        <ul>{notesByRow.map(item => <li key={`n${item.index}`}><b>{item.label}</b> {item.notes.join(" · ")}</li>)}{draft.warnings.map((warning, index) => <li key={`w${index}`}>{warning}</li>)}</ul></div>
    </aside>}
    <FinanceHoldingsEditor
      rows={rows} ko={ko} disabled={pending} canAdd={rows.length < 100} layout="cards"
      savedNow={row => heldOf(row)}
      onEdit={(id, field, value) => edit(id, financePortfolioFieldPatch(field, value))}
      onRemove={id => { setRows(current => current.filter(item => item.id !== id)); setReviewed(false); }}
      onAdd={() => { setRows(current => [...current, financePortfolioBlankRow()]); setReviewed(false); }}
    />
    <p className={styles.hint}>{replacing.length > 0
      ? l(`저장하면 ${replacing.map(row => row.symbol).join(", ")}의 저장된 수량을 이 값으로 바꿉니다. 합산하지 않습니다.`, `Saving replaces the saved quantity of ${replacing.map(row => row.symbol).join(", ")} with these values; it does not add to it.`)
      : l("저장하기 전에는 Finance에 아무것도 기록되지 않습니다. 같은 자산이 이미 있으면 수량을 바꾸며 합산하지 않습니다.", "Nothing is recorded in Finance until you save. If the same asset is already saved, its quantity is replaced, not added to.")}</p>
    {changed && <div className={styles.notice} data-tone="warn" role="alert"><IconAlertTriangle size={14}/><span>{l("보유자산이 변경되었습니다.", "Holdings have changed.")}</span><button type="button" disabled={pending} onClick={() => { setReviewBase(workspace?.revision ?? null); setReviewed(false); }}>{l("최신 상태로 다시 확인", "Review against latest state")}</button></div>}
    {loadFailed && <div className={styles.notice} data-tone="danger" role="alert"><IconAlertTriangle size={14}/><span>{l("Finance 보유자산을 불러오지 못해 저장할 수 없습니다.", "Finance holdings could not be loaded, so nothing can be saved.")}</span><button type="button" onClick={() => { setLoadFailed(false); setReload(value => value + 1); }}><IconRefresh size={14}/>{l("다시 시도", "Retry")}</button></div>}
    {error && <div className={styles.notice} data-tone="danger" role="alert"><IconAlertTriangle size={14}/><span>{error}</span></div>}
    <footer className={styles.footer}>
      <label className={styles.review}><input type="checkbox" checked={reviewed} disabled={pending} onChange={event => setReviewed(event.target.checked)}/><span>{l("종목·통화·수량과 단가를 확인했습니다", "I reviewed the symbols, currencies, quantities and costs")}</span></label>
      <div className={styles.save}>
        {reason && <p id={reasonId} className={styles.reason}>{reason}</p>}
        <button type="button" className={styles.primary} disabled={!canSave} aria-describedby={reason ? reasonId : undefined} onClick={() => void save()}><IconCheck size={16}/>{pending ? l("저장 중…", "Saving…") : count > 0 ? l(`보유자산 ${count}개 저장`, `Save ${holdings(count)}`) : l("보유자산 저장", "Save holdings")}</button>
      </div>
    </footer>
  </div>;
}
