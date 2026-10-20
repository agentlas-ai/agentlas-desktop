import { z } from 'zod';
import type { FinanceAsset, FinanceWorkspace } from './finance';

const value = z.number().finite().min(0).max(1e12).nullable();
const short = z.string().trim().max(160).nullable();
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
