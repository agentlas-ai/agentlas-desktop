import { z } from "zod";
import { validateFinanceOperation, type FinanceAsset, type FinanceReport, type FinanceSearchResult } from "./finance";
import { FinanceSecurityIdentitySchema } from "./finance-search";
import { FinancePortfolioDraftSchema } from "./finance-portfolio";

export const FINANCE_NATIVE_VIEW = "finance.result.v1";
const asset = z.unknown().transform((value, ctx): FinanceAsset => {
  try { const op = validateFinanceOperation({ type: "watchlist.add", asset: value }); if (op.type === "watchlist.add") return op.asset; } catch { /* Invalid retained data is never promoted to a card. */ }
  ctx.addIssue({ code: "custom", message: "Invalid Finance asset" }); return z.NEVER;
});
const report = z.unknown().transform((value, ctx): FinanceReport => {
  try { const op = validateFinanceOperation({ type: "report.add", report: value }); if (op.type === "report.add") return op.report; } catch { /* Same canonical report validator as the service. */ }
  ctx.addIssue({ code: "custom", message: "Invalid Finance report" }); return z.NEVER;
});
/** The provider records a report card points at, in the compact form the "sources and as-of dates" block reads. A card has no workspace to look them up in. */
const reportSource = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(300), asOf: z.string().max(40).nullable(), retrievedAt: z.string().max(40), note: z.string().max(400) }).strict();
const request = z.object({ query: z.string().max(2000), assetIds: z.array(z.string().min(1).max(200)).max(10), metrics: z.array(z.string().min(1).max(80)).min(1).max(10), period: z.string().min(1).max(80) }).strict();
const dataResult = z.object({
  status: z.enum(["ok", "partial", "unconnected", "error"]), sourceUrls: z.array(z.string()), asOf: z.string().nullable(), retrievedAt: z.string(),
  columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number().finite(), z.null()]))), warnings: z.array(z.string()),
  providers: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(["ok", "partial", "unavailable", "error"]), coverage: z.string(), rights: z.string(), sourceUrls: z.array(z.string()) }).strict()).optional(),
});
const searchResult: z.ZodType<FinanceSearchResult, z.ZodTypeDef, unknown> = z.object({ assets: z.array(asset), provider: z.string(), asOf: z.string().nullable(), warnings: z.array(z.string()), identities: z.array(FinanceSecurityIdentitySchema).optional() }).strict();
export const FinanceNativeResultSchema = z.object({
  schemaVersion: z.literal("finance.native-result.v1"), ownerScope: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.string().regex(/^finance\.[a-z.]+$/),
  view: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("search"), query: z.string(), result: searchResult }).strict(),
    z.object({ kind: z.literal("query"), request, result: dataResult }).strict(),
    z.object({ kind: z.literal("portfolio"), status: z.enum(["ok", "partial", "unavailable"]), coverage: z.object({ positions: z.number().int().nonnegative(), pricedPositions: z.number().int().nonnegative(), missingPositions: z.number().int().nonnegative() }).strict() }).strict(),
    /** Holdings the assistant read for the owner to edit and save. Nothing here is saved; the owner's Save in the card is the only write. */
    z.object({ kind: z.literal("holdings"), draft: FinancePortfolioDraftSchema, baseRevision: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal("report"), report, workspaceRevision: z.number().int().nonnegative(), coverage: z.object({ positions: z.number().int().nonnegative(), pricedPositions: z.number().int().nonnegative(), missingPositions: z.number().int().nonnegative() }).strict().optional(), sources: z.array(reportSource).max(50).optional() }).strict(),
  ]),
  /** Exact service outcome, retained for inspection; never used as renderer authority. */
  operationResult: z.unknown(),
}).strict();
export type FinanceNativeResult = z.infer<typeof FinanceNativeResultSchema>;
export type FinanceNativePresentation = { status: "presented"; callId: string; resultRef: string; instanceId: string } | { status: "unavailable"; reason: "finance_ui_not_presented" };
