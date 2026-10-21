import { z } from 'zod';
import type { FinanceAsset, FinanceQuote, FinanceSource, FinanceWorkspace } from './finance';

const value = z.number().finite().min(0).max(1e12).nullable();
/** The saved asset keeps a symbol and an exchange of at most 80 characters, so a row that says more can never be saved. */
const short = z.string().trim().max(80).nullable();
export const FinancePortfolioRowSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().trim().max(300),
  symbol: short, exchange: short, currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  quantity: value, averageCost: value, price: value,
  asOf: z.union([z.string().date(), z.string().datetime({ offset: true })]).nullable(),
  notes: z.array(z.string().max(300)).max(8),
}).strict();
export type FinancePortfolioRow = z.infer<typeof FinancePortfolioRowSchema>;
export const FinancePortfolioDraftSchema = z.object({rows:z.array(FinancePortfolioRowSchema).max(100),warnings:z.array(z.string().max(500)).max(20)}).strict();
export type FinancePortfolioDraft = z.infer<typeof FinancePortfolioDraftSchema>;
export const FinancePortfolioImageSchema = z.object({
  mediaType: z.enum(['image/png','image/jpeg','image/webp']), name:z.string().max(200).optional(),
  data:z.string().min(4).max(7 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export const FinancePortfolioRequestSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('extract'),requestId:z.string().min(1).max(200),images:z.array(FinancePortfolioImageSchema).max(4).optional(),text:z.string().trim().max(20000).optional(),locale:z.string().max(80).optional()}).strict(),
  z.object({action:z.literal('save'),expectedRevision:z.number().int().nonnegative(),rows:z.array(FinancePortfolioRowSchema).min(1).max(100),label:z.string().trim().min(1).max(100).optional()}).strict(),
]);
export type FinancePortfolioRequest = z.infer<typeof FinancePortfolioRequestSchema>;
export interface FinancePortfolioResult {
  draft?:FinancePortfolioDraft; workspace?:FinanceWorkspace; message:string; warnings?:string[];
  runtime?:{kind:string;model?:string;execution:string};
}

/** Why a reviewed row cannot be saved yet. The screen import, the chat review card and the host pre-check share this one predicate. */
export type FinancePortfolioRowIssue = 'symbol_required' | 'currency_required' | 'quantity_required' | 'price_date_required';
export function financePortfolioRowIssues(row: Pick<FinancePortfolioRow, 'symbol' | 'currency' | 'quantity' | 'price' | 'asOf'>): FinancePortfolioRowIssue[] {
  const issues: FinancePortfolioRowIssue[] = [];
  if (!row.symbol?.trim()) issues.push('symbol_required');
  if (!row.currency || row.currency === 'XXX') issues.push('currency_required');
  if (row.quantity === null) issues.push('quantity_required');
  if (row.price !== null && !row.asOf) issues.push('price_date_required');
  return issues;
}
/** The saved assets a row names: same symbol and currency, and the same exchange when the row states one. */
export function financePortfolioMatchingAssets(watchlist: readonly FinanceAsset[], row: Pick<FinancePortfolioRow, 'symbol' | 'exchange' | 'currency'>): FinanceAsset[] {
  const symbol = row.symbol?.trim() ?? '', exchange = row.exchange?.trim() ?? '';
  return watchlist.filter(asset => asset.symbol === symbol && asset.currency === row.currency && (!exchange || asset.exchange === exchange));
}
/** The single saved position a save would replace, or null when the row names none (or an ambiguous one). */
export function financePortfolioHeldPosition(workspace: Pick<FinanceWorkspace, 'watchlist' | 'holdings'>, row: Pick<FinancePortfolioRow, 'symbol' | 'exchange' | 'currency'>): { quantity: number; averageCost: number | null } | null {
  const matches = financePortfolioMatchingAssets(workspace.watchlist, row);
  if (matches.length !== 1) return null;
  const held = workspace.holdings.filter(holding => holding.assetId === matches[0].id);
  return held.length === 1 ? { quantity: held[0].quantity, averageCost: held[0].averageCost } : null;
}

// ── text a person reads on one line ───────────────────────────────────────────────────────────────────────────────────────────────────
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const LINE_BREAKS_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const INVISIBLE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]|[\u{E0000}-\u{E007F}]/gu;
/** The string with every half of a surrogate pair that lost its partner replaced by U+FFFD, so it can be written as UTF-8 and drawn by any text engine. */
export function financePortfolioWellFormed(value: string): string { return value.replace(LONE_SURROGATE, '\uFFFD'); }
/**
 * One line as the owner sees it in a cell: line breaks and other control characters become a space, characters that draw nothing (zero-width,
 * direction marks, tag characters) are dropped, runs of spaces collapse. What the owner reviews is then exactly what is saved and matched.
 */
export function financePortfolioLineText(value: string): string {
  return financePortfolioWellFormed(value).replace(LINE_BREAKS_AND_CONTROLS, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim();
}
/** A row whose free text the owner will read, as one clean line each; numbers, currency and date are untouched. */
export function financePortfolioCleanRow<T extends Pick<FinancePortfolioRow, 'name' | 'symbol' | 'exchange' | 'notes'>>(row: T): T {
  const text = (value: string | null) => value === null ? null : financePortfolioLineText(value) || null;
  return { ...row, name: financePortfolioLineText(row.name), symbol: text(row.symbol), exchange: text(row.exchange), notes: row.notes.map(financePortfolioLineText).filter(Boolean) };
}

// ── what keeps a row from being saved, and what a refused save means ─────────────────────────────────────────────────────────────────
export type FinancePortfolioField = 'name' | 'symbol' | 'exchange' | 'currency' | 'quantity' | 'averageCost' | 'price' | 'asOf';
const CELL_FIELDS: ReadonlySet<string> = new Set<FinancePortfolioField>(['name', 'symbol', 'exchange', 'currency', 'quantity', 'averageCost', 'price', 'asOf']);
const ROW_ISSUE_FIELD: Record<FinancePortfolioRowIssue, FinancePortfolioField> = { symbol_required: 'symbol', currency_required: 'currency', quantity_required: 'quantity', price_date_required: 'asOf' };
/** The cells of one row that keep Save closed: the required-field issues and every value the row schema refuses (range, date, currency form, length). */
export function financePortfolioInvalidFields(row: FinancePortfolioRow): FinancePortfolioField[] {
  const fields = new Set<FinancePortfolioField>(financePortfolioRowIssues(row).map(issue => ROW_ISSUE_FIELD[issue]));
  const parsed = FinancePortfolioRowSchema.safeParse(row);
  if (!parsed.success) for (const issue of parsed.error.issues) { const field = issue.path[0]; if (typeof field === 'string' && CELL_FIELDS.has(field)) fields.add(field as FinancePortfolioField); }
  return [...fields];
}
/** A row the owner has just added and not touched yet is not an error; Save stays closed until it is filled in or removed. */
export function financePortfolioRowUntouched(row: FinancePortfolioRow): boolean {
  return !row.name && !row.symbol && !row.exchange && !row.currency && row.quantity === null && row.averageCost === null && row.price === null && !row.asOf;
}
/** The rows with a value Save refuses and the cells to fix in each. An untouched new row is not listed, so what a summary says and what the cells show agree. */
export function financePortfolioProblems(rows: readonly FinancePortfolioRow[]): { index: number; fields: FinancePortfolioField[] }[] {
  return rows.flatMap((row, index) => { const fields = financePortfolioRowUntouched(row) ? [] : financePortfolioInvalidFields(row); return fields.length ? [{ index, fields }] : []; });
}
// ── whose price a value multiplies ─────────────────────────────────────────────────────────────────────────────────────────────────
/** A price the owner typed or read from a photo is "entered"; only a connected provider's quote is "market" — the rule the observed valuation (finance.portfolio.value) applies. */
export type FinancePriceBasis = 'entered' | 'market';
export function financeQuoteBasis(sources: readonly Pick<FinanceSource, 'id' | 'kind' | 'status'>[], quote: Pick<FinanceQuote, 'sourceId'>): FinancePriceBasis {
  const source = sources.find(item => item.id === quote.sourceId);
  return source && source.kind === 'provider' && source.status === 'connected' ? 'market' : 'entered';
}
export interface FinancePortfolioPriceNote { basis: FinancePriceBasis | 'mixed'; from: string; to: string; entered: number; market: number }
/** What the note under one currency's allocation says: whose prices the values multiply and from which dates. Positions without a price are not passed in. */
export function financePortfolioPriceNote(rows: readonly { basis: FinancePriceBasis; asOf: string }[]): FinancePortfolioPriceNote | null {
  if (!rows.length) return null;
  const dates = rows.map(row => row.asOf.slice(0, 10)).sort();
  const entered = rows.filter(row => row.basis === 'entered').length, market = rows.length - entered;
  return { basis: entered && market ? 'mixed' : entered ? 'entered' : 'market', from: dates[0], to: dates[dates.length - 1], entered, market };
}
export type FinancePortfolioSaveFailure = 'revision_conflict' | 'duplicate_asset' | 'identity_ambiguous' | 'position_ambiguous' | 'other';
/** The typed refusal inside an IPC error message, so the card can say what the host already knows. */
export function financePortfolioSaveFailure(message: string): FinancePortfolioSaveFailure {
  return /finance_revision_conflict|revision_conflict/.test(message) ? 'revision_conflict'
    : /finance_portfolio_duplicate_asset/.test(message) ? 'duplicate_asset'
    : /finance_portfolio_identity_ambiguous/.test(message) ? 'identity_ambiguous'
    : /finance_portfolio_position_ambiguous/.test(message) ? 'position_ambiguous' : 'other';
}

// ── when the chat review card can be saved ──────────────────────────────────────────────────────────────────────────────────────────────
export type FinanceHoldingsReviewMode = 'review' | 'saved' | 'replaced' | 'closed';
/** What the card is for the state of its instance: only an open proposal is reviewed and saved; a settled, replaced or closed one never is. */
export function financeHoldingsReviewMode(instanceState: string, savedHere: boolean): FinanceHoldingsReviewMode {
  return savedHere || instanceState === 'ready' ? 'saved' : instanceState === 'cancelled' ? 'replaced' : instanceState === 'awaiting-input' ? 'review' : 'closed';
}
/** Save is open for an open proposal the owner ticked as reviewed, with rows the save accepts, against the revision the card loaded and still sees. */
export function financeHoldingsCanSave(state: { mode: FinanceHoldingsReviewMode; pending: boolean; reviewed: boolean; rowsAccepted: boolean; workspaceLoaded: boolean; changed: boolean; loadFailed: boolean }): boolean {
  return state.mode === 'review' && !state.pending && state.reviewed && state.rowsAccepted && state.workspaceLoaded && !state.changed && !state.loadFailed;
}
