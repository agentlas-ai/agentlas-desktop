import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FinanceWorkspace } from '../../shared/finance';
import {
  FinancePortfolioDraftSchema, FinancePortfolioRowSchema, financePortfolioHeldPosition, financePortfolioLineText, financePortfolioRowIssues,
  type FinancePortfolioDraft, type FinancePortfolioRow, type FinancePortfolioRowIssue,
} from '../../shared/finance-portfolio';
import { financePortfolioOperations } from './portfolio';

/** Free text the model read is one clean line before anyone reviews it: no line breaks, invisible characters or half surrogate pairs. */
const optionalText = (max: number) => z.string().max(max).nullish().transform(value => financePortfolioLineText(value ?? '') || null);
const optionalAmount = z.number().finite().min(0).max(1e12).nullish().transform(value => value ?? null);
/** A position as the model reads it from a photo or pasted text. Unknown fields stay null; unrecognized keys are refused, never dropped. */
const ProposalRowSchema = z.object({
  name: z.string().max(300).nullish().transform(value => financePortfolioLineText(value ?? '')),
  // The bound here is on what the model wrote; the row schema's 80 (what the saved asset holds) applies to the cleaned text.
  symbol: optionalText(160), exchange: optionalText(160),
  currency: z.string().max(10).nullish().transform(value => financePortfolioLineText(value ?? '').toUpperCase() || null),
  quantity: optionalAmount, averageCost: optionalAmount, price: optionalAmount,
  asOf: optionalText(40),
  notes: z.array(z.string().max(300)).max(8).optional().transform(value => (value ?? []).map(financePortfolioLineText).filter(Boolean)),
}).strict();
export const FinancePortfolioProposalInputSchema = z.object({
  rows: z.array(z.unknown()).min(1).max(100),
  warnings: z.array(z.string().max(500)).max(20).optional(),
}).strict();
export type FinancePortfolioProposalInput = z.infer<typeof FinancePortfolioProposalInputSchema>;

export interface FinancePortfolioProposalIssue { path: string; code: string }
/** Field paths and issue codes only: no value from a photo or text is repeated in an error. */
export class FinancePortfolioProposalError extends Error {
  constructor(readonly issues: readonly FinancePortfolioProposalIssue[]) { super('finance_portfolio_rows_invalid'); }
}

export interface FinancePortfolioProposal {
  state: 'awaiting_owner_review';
  /** The workspace revision the host read when it checked the rows. */
  baseRevision: number;
  draft: FinancePortfolioDraft;
  /** True when the owner could save these rows as they are. The save itself is always the owner's. */
  readyToSave: boolean;
  needsAttention: { row: number; symbol: string | null; issues: FinancePortfolioRowIssue[] }[];
  /** The save's own refusal for the row set as a whole (ambiguous identity, duplicate asset, ambiguous position). */
  conflict: string | null;
  /** Saved quantities a save would replace, not add to. */
  replaces: { row: number; symbol: string; currentQuantity: number }[];
}

const issuePath = (index: number, path: readonly (string | number)[]): string => `rows.${index}${path.length ? `.${path.join('.')}` : ''}`;

/**
 * Validates and normalizes a model-proposed set of holdings for the owner's review. Writes nothing. The checks are the ones
 * the save applies (`financePortfolioRowIssues`, then `financePortfolioOperations` on the whole set), so a row marked ready here
 * is a row the owner's Save will accept at this revision.
 */
export function financePortfolioProposal(workspace: FinanceWorkspace, raw: unknown): FinancePortfolioProposal {
  const input = FinancePortfolioProposalInputSchema.parse(raw);
  const problems: FinancePortfolioProposalIssue[] = [];
  const rows: FinancePortfolioRow[] = [];
  input.rows.forEach((value, index) => {
    const lenient = ProposalRowSchema.safeParse(value);
    if (!lenient.success) {
      for (const issue of lenient.error.issues.slice(0, 4)) {
        const keys = issue.code === 'unrecognized_keys' ? `:${issue.keys.map(key => key.slice(0, 40)).join(',')}` : '';
        problems.push({ path: issuePath(index, issue.path), code: `${issue.code}${keys}` });
      }
      return;
    }
    const strict = FinancePortfolioRowSchema.safeParse({ ...lenient.data, id: randomUUID() });
    if (!strict.success) {
      for (const issue of strict.error.issues.slice(0, 4)) problems.push({ path: issuePath(index, issue.path), code: issue.code });
      return;
    }
    rows.push(strict.data);
  });
  if (problems.length) throw new FinancePortfolioProposalError(problems.slice(0, 8));
  const warnings = [...new Set((input.warnings ?? []).map(financePortfolioLineText).filter(Boolean))].slice(0, 20);
  const draft = FinancePortfolioDraftSchema.parse({ rows, warnings });
  const needsAttention = rows.flatMap((row, index) => {
    const issues = financePortfolioRowIssues(row);
    return issues.length ? [{ row: index + 1, symbol: row.symbol, issues }] : [];
  });
  let conflict: string | null = null;
  if (!needsAttention.length) {
    try { financePortfolioOperations(workspace, { action: 'save', expectedRevision: workspace.revision, rows }); }
    catch (error) { conflict = error instanceof Error && /^finance_[a-z0-9_]+$/.test(error.message) ? error.message : 'finance_portfolio_not_saveable'; }
  }
  const replaces = rows.flatMap((row, index) => {
    if (!row.symbol || !row.currency) return [];
    const held = financePortfolioHeldPosition(workspace, row);
    return held ? [{ row: index + 1, symbol: row.symbol, currentQuantity: held.quantity }] : [];
  });
  return { state: 'awaiting_owner_review', baseRevision: workspace.revision, draft, readyToSave: !needsAttention.length && conflict === null, needsAttention, conflict, replaces };
}
