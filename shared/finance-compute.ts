import { z } from 'zod';

const finite = z.number().finite();
const positive = finite.positive().max(1e12);
const id = z.string().min(1).max(200);
const assetIds = z.array(id).min(1).max(12).refine(ids => new Set(ids).size === ids.length, 'Duplicate asset IDs');
const currency = z.string().regex(/^[A-Z]{3}$/).refine(value => value !== 'XXX', 'Currency must be known');
export const FinanceComputeProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind:z.literal('observed'), sourceUrls:z.array(z.string().url().max(2000).refine(url=>/^https?:\/\//i.test(url))).min(1).max(100), retrievedAt:z.string().datetime({offset:true}) }).strict(),
  z.object({ kind:z.literal('scenario'), origin:z.enum(['user_input','model_assumption']), label:z.string().min(1).max(500), declaredAt:z.string().datetime({offset:true}) }).strict(),
]);
export type FinanceComputeProvenance = z.infer<typeof FinanceComputeProvenanceSchema>;
/** Observed prices and their provenance are supplied by the service, never by a model tool argument. */
export const FinanceComputeHistorySchema = z.object({
  assetId:id, symbol:z.string().min(1).max(80), currency,
  priceBasis:z.enum(['price','total_return']), adjustment:z.enum(['split_adjusted','unknown']),
  prices:z.array(z.object({date:z.string().date(),close:positive}).strict()).min(31).max(2600),
}).strict();
export type FinanceComputeHistory = z.infer<typeof FinanceComputeHistorySchema>;
export const FinanceComputeInputSchema = z.object({
  histories:z.array(FinanceComputeHistorySchema).max(12), provenance:FinanceComputeProvenanceSchema,
}).strict();
export type FinanceComputeInput = z.infer<typeof FinanceComputeInputSchema>;
export const FinanceComputeRequestSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('allocation'),method:z.enum(['min_variance','risk_parity']),assetIds,
    minWeight:finite.min(0).max(1).default(0),maxWeight:finite.min(0).max(1).default(1),
    shrinkage:finite.min(0.01).max(1).default(0.1),periodsPerYear:z.number().int().min(1).max(366).default(252),
  }).strict(),
  z.object({kind:z.literal('forecast'),assetIds:z.array(id).length(1),horizon:z.number().int().min(1).max(252).default(63),
    paths:z.number().int().min(200).max(2000).default(1000),seed:z.number().int().min(0).max(4294967295).default(20261018),
  }).strict(),
  z.object({kind:z.literal('option'),optionType:z.enum(['call','put']),symbol:z.string().min(1).max(80),currency,
    spot:positive,strike:positive,rate:finite.min(-0.5).max(1),dividendYield:finite.min(0).max(1).default(0),
    volatility:finite.min(0.0001).max(5),years:finite.min(1/36500).max(30),
  }).strict(),
]);
export type FinanceComputeRequest = z.infer<typeof FinanceComputeRequestSchema>;
export interface FinanceComputeMetric { id:string;label:string;value:number;unit:string }
export interface FinanceComputeSeries {
  id:string;label:string;chart:'line'|'bar'|'fan';xLabel:string;yLabel:string;
  points:Array<{x:number|string;y:number;p05?:number;p25?:number;p50?:number;p75?:number;p95?:number}>;
}
export interface FinanceComputeTable { id:string;title:string;columns:string[];rows:Array<Array<string|number|null>> }
export interface FinanceComputeArtifact {
  schemaVersion:1;engineVersion:'finance-compute-v1';kind:'allocation'|'forecast'|'option';method:string;title:string;
  provenance:FinanceComputeProvenance;
  input:{symbols:string[];assetIds:string[];currency:string;startDate:string|null;endDate:string|null;observations:number;inputSha256:string};
  metrics:FinanceComputeMetric[];series:FinanceComputeSeries[];tables:FinanceComputeTable[];
  assumptions:string[];warnings:string[];citations:Array<{title:string;url:string}>;
  diagnostics:{iterations:number;converged:true;residual:number;seed?:number;paths?:number};
}
