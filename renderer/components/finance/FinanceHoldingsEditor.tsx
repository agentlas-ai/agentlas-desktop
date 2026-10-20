"use client";

import { IconAlertTriangle, IconPlus, IconTrash } from "@/components/Icon";
import { financePortfolioInvalidFields, financePortfolioProblems, financePortfolioRowUntouched, type FinancePortfolioDraft, type FinancePortfolioField } from "@shared/finance-portfolio";
import styles from "./FinanceHoldingsEditor.module.css";

type Row = FinancePortfolioDraft["rows"][number];

const FIELDS: readonly FinancePortfolioField[] = ["name", "symbol", "exchange", "currency", "quantity", "averageCost", "price", "asOf"];
const NUMERIC: ReadonlySet<FinancePortfolioField> = new Set<FinancePortfolioField>(["quantity", "averageCost", "price"]);

function fieldLabels(ko: boolean): Record<FinancePortfolioField, string> {
  const l = (k: string, e: string) => (ko ? k : e);
  return {
    name: l("이름", "Name"), symbol: l("종목", "Symbol"), exchange: l("거래소", "Exchange"), currency: l("통화", "Currency"),
    quantity: l("수량", "Quantity"), averageCost: l("평균단가", "Average cost"), price: l("가격", "Price"), asOf: l("기준일", "As of"),
  };
}

/** One banner above the rows that says how many values need a fix and jumps to the first one of each row; the same in the chat card and the dialog. */
export function FinanceHoldingsProblems({ rows, ko, onFocus }: { rows: readonly Row[]; ko: boolean; onFocus: (row: number, field: FinancePortfolioField) => void }) {
  const problems = financePortfolioProblems(rows);
  if (problems.length === 0) return null;
  const label = fieldLabels(ko);
  const count = problems.reduce((total, item) => total + item.fields.length, 0);
  return (
    <div className={styles.summary} role="status">
      <IconAlertTriangle size={16} />
      <div>
        <strong>{ko ? `고쳐야 할 값 ${count}개` : `${count} ${count === 1 ? "value needs" : "values need"} attention`}</strong>
        <ul>{problems.map(item => <li key={item.index}><button type="button" onClick={() => onFocus(item.index + 1, item.fields[0])}>{ko ? `${item.index + 1}행` : `Row ${item.index + 1}`} · {item.fields.map(field => label[field]).join(", ")}</button></li>)}</ul>
      </div>
    </div>
  );
}

/**
 * The editable rows of a holdings review, shared by the chat card and the Add-holdings dialog. One markup, two layouts: in a narrow column every holding is a
 * small card with labelled fields (the symbol and name first, then the numbers), and where there is room (layout "auto") the same rows become a table. The cell names
 * (`<row> <field>`) and the row remove button are the same in both, so keyboard users and tests reach the same controls.
 */
export function FinanceHoldingsEditor({ rows, ko, disabled, canAdd, layout = "auto", savedNow, onEdit, onRemove, onAdd }: {
  rows: readonly Row[];
  ko: boolean;
  disabled: boolean;
  canAdd: boolean;
  /** "auto" turns the row cards into a table when the editor is wide enough; "cards" keeps every holding a card (the chat, where the saved-now column would not fit). */
  layout?: "auto" | "cards";
  /** The quantity the owner already has saved for the asset a row names; the card shows it so "replaces" is visible per row. */
  savedNow?: (row: Row) => number | null;
  onEdit: (id: string, field: FinancePortfolioField, value: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  const l = (k: string, e: string) => (ko ? k : e);
  const label = fieldLabels(ko);
  const heldLabel = l("지금 저장된 수량", "Saved now");
  return (
    <div className={styles.editor} data-layout={layout}>
      <table className={styles.table}>
        <thead>
          <tr>
            {FIELDS.map(field => <th key={field} scope="col" data-field={field}>{label[field]}</th>)}
            {savedNow && <th scope="col" data-field="held">{heldLabel}</th>}
            <th scope="col" data-field="remove"><span className={styles.sr}>{l("행 제거", "Remove row")}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const invalid = new Set<string>(financePortfolioRowUntouched(row) ? [] : financePortfolioInvalidFields(row));
            const held = savedNow ? savedNow(row) : null;
            return (
              <tr key={row.id} data-invalid={invalid.size ? "true" : undefined}>
                {FIELDS.map(field => (
                  <td key={field} data-field={field} data-label={label[field]}>
                    <input
                      disabled={disabled}
                      aria-label={`${index + 1} ${field}`}
                      aria-invalid={invalid.has(field) || undefined}
                      value={row[field] ?? ""}
                      type={NUMERIC.has(field) ? "number" : "text"}
                      min={NUMERIC.has(field) ? 0 : undefined}
                      step="any"
                      inputMode={NUMERIC.has(field) ? "decimal" : undefined}
                      placeholder={NUMERIC.has(field) ? "—" : field === "asOf" ? "YYYY-MM-DD" : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={event => onEdit(row.id, field, event.target.value)}
                    />
                  </td>
                ))}
                {savedNow && (
                  <td data-field="held" data-label={heldLabel}>
                    {held !== null ? <span className={styles.held}>{held}<small>{l("이 값으로 교체됩니다", "will be replaced")}</small></span> : <span className={styles.none}>—</span>}
                  </td>
                )}
                <td data-field="remove">
                  <button type="button" className={styles.remove} disabled={disabled} aria-label={l("행 제거", "Remove row")} title={l("행 제거", "Remove row")} onClick={() => onRemove(row.id)}><IconTrash size={16} /></button>
                </td>
                {invalid.size > 0 && (
                  <td data-field="issues" className={styles.issues} role="status">
                    <IconAlertTriangle size={14} />
                    <span>{l("고칠 값: ", "Needs a fix: ")}{[...invalid].map(field => label[field as FinancePortfolioField]).join(" · ")}</span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className={styles.empty}>{l("남은 행이 없습니다. 행을 추가하거나 어시스턴트에게 다시 제안해 달라고 하세요.", "No rows left. Add a row, or ask the assistant to propose again.")}</p>}
      <button type="button" className={styles.add} disabled={disabled || !canAdd} onClick={onAdd}><IconPlus size={16} />{l("행 추가", "Add row")}</button>
    </div>
  );
}
