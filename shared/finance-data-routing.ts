import type { FinanceFeedId } from './finance-feeds';

export const FINANCE_DATA_CATEGORIES = ['market', 'news', 'filings', 'social', 'funds', 'macro', 'calendar'] as const;
export type FinanceDataCategory = typeof FINANCE_DATA_CATEGORIES[number];
export interface FinanceDataSelection {
  sourceId: string;
  sourceBindings?: Partial<Record<FinanceDataCategory, string>>;
  enabledFeedIds?: FinanceFeedId[];
}
const categories: Readonly<Record<string, FinanceDataCategory>> = Object.freeze({
  search:'market',price:'market',price_history:'market',news:'news',filings:'filings',company_facts:'filings',
  social:'social',social_search:'social',nav:'funds',etf_holdings:'funds',macro_news:'macro',treasury_yields:'macro',
  earnings:'calendar',economic_calendar:'calendar',
});
export function financeDataCategory(metric:string):FinanceDataCategory|undefined {
  return FINANCE_DATA_CATEGORIES.includes(metric as FinanceDataCategory) ? metric as FinanceDataCategory : Object.prototype.hasOwnProperty.call(categories,metric) ? categories[metric] : undefined;
}
/** Selection is host-owned. Unknown toolchain metrics retain the legacy base route. */
export function resolveFinanceDataSource(selection:FinanceDataSelection,metricsOrCategory:string|readonly string[]):string {
  const metrics=typeof metricsOrCategory==='string'?[metricsOrCategory]:metricsOrCategory;
  const sources=metrics.map(metric=>{const category=financeDataCategory(metric);return category?selection.sourceBindings?.[category]??selection.sourceId:selection.sourceId;});
  if(new Set(sources).size>1)throw Object.assign(new Error('finance_data_route_mixed_sources'),{code:'finance_data_route_mixed_sources'});
  return sources[0]??selection.sourceId;
}
