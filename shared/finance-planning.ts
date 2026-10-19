import { z } from 'zod';
/** Transport money is decimal text; no inference from a missing amount or currency. */
export const FinancePlanningMoneySchema = z.string().max(20).regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/);
const money=FinancePlanningMoneySchema, fraction=z.number().finite().min(0).max(1), id=z.string().min(1).max(200);
const common={currency:z.string().regex(/^[A-Z]{3}$/).refine(v=>v!=='XXX'),precision:z.number().int().min(0).max(6),asOf:z.string().date(),assumptionOrigin:z.enum(['user_input','model_assumption']),assumptionNotes:z.array(z.string().max(500)).max(20).default([])};
export const FinancePlanningInstrumentSchema=z.object({id,label:z.string().min(1).max(200),riskClass:z.enum(['risk','nonrisk','unknown']),buyAllowed:z.boolean(),sellAllowed:z.boolean()}).strict();
export const FinancePlanningRequestSchema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('cashflow'),initialCapital:money,months:z.number().int().min(1).max(1200),annualReturn:z.number().finite().min(-.99).max(5),annualInflation:z.number().finite().min(-.5).max(1),annualFeeRate:fraction,monthlyContribution:money,monthlyIncome:money,monthlyWithdrawal:money,withdrawalInflationAdjusted:z.boolean(),targetEndBalance:money.optional()}).strict(),
 z.object({...common,kind:z.literal('income_goal'),capital:money,monthlyIncomeTarget:money,otherMonthlyIncome:money,annualCashYield:fraction,annualFeeRate:fraction,withholdingRate:fraction}).strict(),
 z.object({...common,kind:z.literal('rebalance'),planType:z.enum(['brokerage','kr_dc','kr_irp','us_401k']),menuConfirmed:z.boolean(),planMenu:z.array(FinancePlanningInstrumentSchema).max(100),positions:z.array(z.object({instrumentId:id,currentValue:money}).strict()).max(100),cash:money,contribution:money,reserve:money,feeReserve:money,fees:z.object({fixedPerTrade:money,proportionalRate:fraction}).strict(),targetWeights:z.array(z.object({instrumentId:id,weight:fraction}).strict()).min(1).max(100),constraints:z.object({lockedIds:z.array(id).max(100).default([]),excludedIds:z.array(id).max(100).default([]),bounds:z.array(z.object({instrumentId:id,minWeight:fraction,maxWeight:fraction}).strict()).max(100).default([]),maxRiskWeight:fraction.optional()}).strict()}).strict(),
]);
export type FinancePlanningRequest=z.infer<typeof FinancePlanningRequestSchema>;
export interface FinancePlanningError {code:string;field?:string;detail?:string}
export interface FinancePlanningMetric {id:string;label:string;value:string|number|null;unit:'money'|'fraction'|'month'}
export interface FinancePlanningPoint {month:number;balance:string;realBalance:string;contribution:string;income:string;withdrawalRequested:string;withdrawalPaid:string;fees:string;shortfall:string}
export interface FinancePlanningTrade {instrumentId:string;label:string;side:'buy'|'sell'|'hold';currentValue:string;targetValue:string;amount:string;estimatedFee:string;targetWeight:number}
export interface FinancePlanningChart {id:string;label:string;type:'line'|'bar';points:Array<{x:number|string;y:number}>}
export interface FinancePlanningResult {
 schemaVersion:1;engineVersion:'finance-planning-v1';kind:FinancePlanningRequest['kind'];status:'ok'|'infeasible';currency:string;precision:number;asOf:string;inputSha256:string;
 summary:string;metrics:FinancePlanningMetric[];monthlyProjection:FinancePlanningPoint[];annualProjection:FinancePlanningPoint[];trades:FinancePlanningTrade[];charts:FinancePlanningChart[];
 assumptions:string[];warnings:string[];errors:FinancePlanningError[];request:FinancePlanningRequest;
}
