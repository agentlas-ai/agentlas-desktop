import { z } from 'zod';

export const FINANCE_ANALYST_BUILTIN_IDS = ['builtin:value', 'builtin:growth', 'builtin:income', 'builtin:etf'] as const;
export const FINANCE_ANALYST_LIMITS = { custom: 100, selected: 3 } as const;
const singleLine = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), 'Expected a nonempty single line');
export const FinanceAnalystDraftSchema = z.object({
  name: singleLine(80), description: singleLine(240),
  instructions: z.string().min(1).max(12000).refine(value => value.trim().length > 0 && !value.includes('\0'), 'Expected skill instructions'),
}).strict();
export const FinanceAnalystIdSchema = z.union([z.enum(FINANCE_ANALYST_BUILTIN_IDS), z.string().regex(/^custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)]);
export const FinanceAnalystRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const FinanceAnalystRefSchema = z.object({ id: FinanceAnalystIdSchema, revision: FinanceAnalystRevisionSchema }).strict();
export const FinanceAnalystRefsSchema = z.array(FinanceAnalystRefSchema).max(FINANCE_ANALYST_LIMITS.selected).refine(refs => new Set(refs.map(ref => ref.id)).size === refs.length, 'Duplicate analyst references');
export const FinanceAnalystSchema = FinanceAnalystDraftSchema.extend({ id: FinanceAnalystIdSchema, revision: FinanceAnalystRevisionSchema, origin: z.enum(['builtin', 'custom']) }).strict();
export const FinanceAnalystRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('save'), draft: FinanceAnalystDraftSchema, id: FinanceAnalystIdSchema.optional(), expectedRevision: FinanceAnalystRevisionSchema.optional() }).strict(),
  z.object({ action: z.literal('remove'), id: FinanceAnalystIdSchema, expectedRevision: FinanceAnalystRevisionSchema }).strict(),
]).superRefine((request, context) => {
  if (request.action === 'save' && (request.id === undefined) !== (request.expectedRevision === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Update requires id and expectedRevision; create requires neither' });
});
export type FinanceAnalystDraft = z.infer<typeof FinanceAnalystDraftSchema>;
export type FinanceAnalyst = z.infer<typeof FinanceAnalystSchema>;
export type FinanceAnalystRef = z.infer<typeof FinanceAnalystRefSchema>;
export type FinanceAnalystRequest = z.infer<typeof FinanceAnalystRequestSchema>;
export interface FinanceAnalystResult { items: FinanceAnalyst[] }
