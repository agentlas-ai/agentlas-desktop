import type { FinanceDataCategory, FinanceDataSelection } from './finance-data-routing';
export type { FinanceDataCategory, FinanceDataSelection } from './finance-data-routing';
export const FINANCE_NOTICE_VERSION = '2026-10-19';
export interface FinanceDataSourceOption { id:string; name:string; kind:'builtin'|'toolchain'|'plugin'; available:boolean; version?:string }
export interface FinanceExperienceState {
  consent:{version:string;acceptedAt:string}|null;
  builtins?:{ready:boolean;phase:'ready'|'missing'|'error';items:Array<{id:string;name:string;ready:boolean}>;errorCode?:string};
  sourceId:string;
  sourceBindings?:FinanceDataSelection['sourceBindings'];
  sourceRoutingStatus?:'ready'|'unavailable';
  dashboardCustomized:boolean;
  sources:FinanceDataSourceOption[];
  enabledFeedIds?:import('./finance-feeds').FinanceFeedId[];
  monitoring:{enabled:boolean;localTime:string;timezone:string;lastSentAt:string|null;nextRunAt:string|null};
  access:{plan:string|null;monitoringAllowed:boolean;status:'verified'|'unavailable'|'signed-out'};
}
export type FinanceExperienceRequest = {action:'read'}
  | {action:'plugins.prepare'}
  | {action:'accept';version:string;dataNotice:true;aiNotice:true}
  | {action:'source';sourceId:string}
  | {action:'source.binding';category:FinanceDataCategory;sourceId:string|null}
  | {action:'customize';customized:boolean}
  | {action:'feed';feedId:import('./finance-feeds').FinanceFeedId;enabled:boolean}
  | {action:'monitoring';enabled:boolean;localTime?:string};
export interface FinanceWorldMarket {
  id:string;name:string;countryCode:string;latitude:number;longitude:number;
  index:{symbol:string;name:string;value:number|null;changePercent:number|null;currency:string|null;asOf:string|null};
  rates:Array<{symbol:string;name:string;value:number|null;unit:string;asOf:string|null}>;
  status:'ok'|'unavailable';
}
export interface FinanceWorldMarketsResult {
  status:'ok'|'partial'|'unavailable';sourceId:string;fetchedAt:string;expiresAt:string;
  markets:FinanceWorldMarket[];errorCode?:string;engine?:'yfinance'|'yahoo-chart';
}
