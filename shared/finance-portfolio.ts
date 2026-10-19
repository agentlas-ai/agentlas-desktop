import { z } from 'zod';
import type { FinanceWorkspace } from './finance';

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
