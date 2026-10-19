import {
  FinanceReportLanguageSchema, createFinanceWidget, financeId, validateFinanceOperation, validateFinanceWorkspace,
  type FinanceAIResult, type FinanceOperation, type FinanceQuote, type FinanceReport, type FinanceReportSection,
  type FinanceSource, type FinanceWorkspace,
} from '../../shared/finance';
import type { FinanceArtifactDraft } from './artifacts';

const VALUE_LIMIT = 1e15;
export interface FinancePortfolioValuationItem {
  holdingId: string; assetId: string; symbol: string; quantity: number;
  price: number | null; marketValue: number | null; weight: number | null;
  asOf: string | null; sourceId: string | null;
}
export interface FinancePortfolioValuationGroup {
  currency: string; complete: boolean; totalValue: number | null; knownSubtotal: number;
  items: FinancePortfolioValuationItem[]; missingAssetIds: string[];
}
export interface FinancePortfolioValuation {
  status: 'ok' | 'partial' | 'unavailable'; baseRevision: number; asOf: string | null; retrievedAt: string | null;
  groups: FinancePortfolioValuationGroup[]; sources: FinanceSource[]; warnings: string[]; providerMessage: string;
  coverage: { positions: number; pricedPositions: number; missingPositions: number };
}
export interface FinancePortfolioValuationPresentation {
  title?: string; language?: string; narrative?: string;
  chartTitles?: Record<string, string>; chartLabels?: Record<string, string>;
}
const common = (values: (string | null)[]): string | null => values.length && values[0] && values.every(v => v === values[0]) ? values[0] : null;
const bounded = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= VALUE_LIMIT;

/** A read-only observed snapshot. Existing workspace quotes and cost bases are deliberately never consulted. */
export function financePortfolioValuation(workspace: FinanceWorkspace, refreshResult: FinanceAIResult): FinancePortfolioValuation {
  const ws = validateFinanceWorkspace(workspace);
  if (refreshResult.baseRevision !== ws.revision) throw new Error('finance_portfolio_refresh_revision_conflict');
  if (!['ok', 'unavailable', undefined].includes(refreshResult.status)) throw new Error('finance_portfolio_refresh_failed');
  if (!Array.isArray(refreshResult.operations ?? []) || (refreshResult.operations?.length ?? 0) > 20000) throw new Error('finance_portfolio_refresh_invalid');
  const sourceMap = new Map<string, FinanceSource>(), quoteMap = new Map<string, FinanceQuote[]>();
  for (const raw of refreshResult.operations ?? []) {
    const op = validateFinanceOperation(raw);
    if (op.type === 'source.upsert') {
      const previous = sourceMap.get(op.source.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(op.source)) throw new Error('finance_portfolio_source_conflict');
      sourceMap.set(op.source.id, op.source);
    } else if (op.type === 'quotes.import') {
      for (const quote of op.quotes) quoteMap.set(quote.assetId, [...(quoteMap.get(quote.assetId) ?? []), quote]);
    } else throw new Error('finance_portfolio_refresh_operation_invalid');
  }
  if (refreshResult.status === 'unavailable' && quoteMap.size) throw new Error('finance_portfolio_refresh_invalid');
  const warnings = new Set<string>(), usedSources = new Map<string, FinanceSource>(), assets = new Map(ws.watchlist.map(asset => [asset.id, asset]));
  const groups = new Map<string, FinancePortfolioValuationGroup>();
  for (const holding of ws.holdings) {
    const asset = assets.get(holding.assetId)!;
    let group = groups.get(holding.currency);
    if (!group) { group = { currency: holding.currency, complete: false, totalValue: null, knownSubtotal: 0, items: [], missingAssetIds: [] }; groups.set(holding.currency, group); }
    const item: FinancePortfolioValuationItem = { holdingId: holding.id, assetId: asset.id, symbol: asset.symbol, quantity: holding.quantity, price: null, marketValue: null, weight: null, asOf: null, sourceId: null };
    const candidates = quoteMap.get(asset.id) ?? [];
    const quote = candidates[0];
    // Conflicting concurrent observations are not resolved by arbitrary array order.
    const conflict = candidates.some(candidate => JSON.stringify(candidate) !== JSON.stringify(quote));
    const source = quote && sourceMap.get(quote.sourceId);
    let sourceURLValid = false;
    if (source?.url) { const url = new URL(source.url); sourceURLValid = !url.username && !url.password; }
    if (conflict) warnings.add('finance_portfolio_quote_conflict');
    if (!conflict && quote && source && source.kind === 'provider' && source.status === 'connected' && sourceURLValid &&
        quote.priceBasis === 'price' && asset.currency !== 'XXX' && quote.currency === asset.currency && source.asOf === quote.asOf) {
      const value = holding.quantity * quote.price;
      if (bounded(value)) {
        item.price = quote.price; item.marketValue = value; item.asOf = quote.asOf; item.sourceId = source.id;
        usedSources.set(source.id, source);
      } else warnings.add('finance_portfolio_value_out_of_range');
    } else if (quote && !conflict) warnings.add('finance_portfolio_quote_incompatible');
    group.items.push(item);
  }
  for (const group of groups.values()) {
    group.missingAssetIds = [...new Set(group.items.filter(item => item.marketValue === null).map(item => item.assetId))];
    // Compensation limits summation error; no conversion or monetary rounding changes the literal prices.
    let subtotal = 0, correction = 0;
    for (const item of group.items) if (item.marketValue !== null) {
      const adjusted = item.marketValue - correction, next = subtotal + adjusted;
      correction = (next - subtotal) - adjusted; subtotal = next;
    }
    if (!bounded(subtotal)) throw new Error('finance_portfolio_total_out_of_range');
    group.knownSubtotal = subtotal;
    group.complete = !group.missingAssetIds.length;
    group.totalValue = group.complete ? subtotal : null;
    if (group.complete && subtotal > 0) for (const item of group.items) item.weight = item.marketValue! / subtotal;
    if (!group.complete) warnings.add('finance_portfolio_incomplete_currency_group');
    if (group.complete && subtotal === 0) warnings.add('finance_portfolio_zero_total_weights_undefined');
    if (new Set(group.items.filter(item => item.asOf).map(item => item.asOf)).size > 1) warnings.add('finance_portfolio_mixed_observation_dates');
  }
  const items = [...groups.values()].flatMap(group => group.items), pricedPositions = items.filter(item => item.marketValue !== null).length;
  if (groups.size > 1) warnings.add('finance_portfolio_currencies_not_aggregated');
  if (pricedPositions < items.length) warnings.add('finance_portfolio_refresh_coverage_partial');
  const sources = [...usedSources.values()];
  return { status: !pricedPositions ? 'unavailable' : pricedPositions === items.length ? 'ok' : 'partial', baseRevision: ws.revision,
    asOf: common(items.map(item => item.asOf)), retrievedAt: sources.length ? sources.map(source => source.retrievedAt).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)! : null,
    groups: [...groups.values()], sources, warnings: [...warnings], providerMessage: refreshResult.message,
    coverage: { positions: items.length, pricedPositions, missingPositions: items.length - pricedPositions } };
}

/** Freeze observed monetary values and their original provenance without importing quotes into the workspace. */
export function financePortfolioValuationArtifact(result: FinancePortfolioValuation, workspace: FinanceWorkspace, presentation: FinancePortfolioValuationPresentation = {}): FinanceArtifactDraft {
  const ws = validateFinanceWorkspace(workspace);
  if (result.baseRevision !== ws.revision) throw new Error('finance_portfolio_refresh_revision_conflict');
  const groups = result.groups.filter(group => group.complete && group.totalValue !== null && group.totalValue > 0);
  if (!groups.length) throw new Error('finance_portfolio_no_verified_values');
  const title = (presentation.title ?? 'Portfolio value').slice(0,300), language = presentation.language ? FinanceReportLanguageSchema.parse(presentation.language) : undefined;
  const now = new Date().toISOString(), reportId = financeId('report'), operations: FinanceOperation[] = [], sections: FinanceReportSection[] = [];
  const ids = new Map<string,string>();
  for (const source of result.sources) {
    const sourceId = financeId('source'); ids.set(source.id, sourceId);
    operations.push({type:'source.upsert',source:{...source,id:sourceId}});
  }
  if (presentation.narrative?.trim()) sections.push({id:financeId('section'),title,kind:'summary',presentation:'narrative',narrative:presentation.narrative.slice(0,20000),widget:null,projection:null});
  for (const group of groups) {
    const amounts = new Map<string,{symbol:string;value:number}>();
    for (const item of group.items) {
      if (item.marketValue === null || !bounded(item.marketValue) || !item.sourceId || !ids.has(item.sourceId)) throw new Error('finance_portfolio_artifact_invalid');
      const previous = amounts.get(item.assetId);
      const value = (previous?.value ?? 0) + item.marketValue;
      if (!bounded(value)) throw new Error('finance_portfolio_total_out_of_range');
      amounts.set(item.assetId,{symbol:item.symbol,value});
    }
    if (amounts.size > 500) throw new Error('finance_portfolio_chart_capacity_reached');
    const rows = [...amounts].map(([assetId,item]) => [presentation.chartLabels && Object.hasOwn(presentation.chartLabels,assetId) ? presentation.chartLabels[assetId] : item.symbol,item.value] as [string,number]);
    if (rows.some(row=>!row[0].trim()||row[0].length>200) || new Set(rows.map(row=>row[0])).size !== rows.length) throw new Error('finance_portfolio_display_labels_ambiguous');
    const chartTitle = (presentation.chartTitles?.[group.currency] ?? title).slice(0,300), widget = createFinanceWidget('chart',chartTitle);
    widget.chartType='bar'; widget.width='full'; widget.metric='portfolio:values'; widget.notes=group.currency;
    sections.push({id:financeId('section'),title:chartTitle,kind:'widget',presentation:'chart',narrative:'',widget,projection:{columns:['period','value'],rows,status:'ready',warnings:[...result.warnings],asOf:common(group.items.map(item=>item.asOf)),sourceIds:[...new Set(group.items.map(item=>ids.get(item.sourceId!)!))]}});
  }
  const frozen = JSON.stringify(result);
  sections.push({id:financeId('section'),title:'Observed portfolio snapshot',kind:'sources',presentation:'supporting',narrative:'',widget:null,projection:{columns:['Part','Observed record'],rows:Array.from({length:Math.ceil(frozen.length/16000)},(_,index)=>[index+1,frozen.slice(index*16000,(index+1)*16000)]),status:result.status==='ok'?'ready':'partial',warnings:[...result.warnings],asOf:result.asOf,sourceIds:[...ids.values()]}});
  const report: FinanceReport = {id:reportId,...(language?{language}:{}),title,createdAt:now,sourceRevision:ws.revision,reviewPending:true,sections,dashboardSnapshot:null,parentReportId:null};
  operations.push({type:'report.add',report});
  return {operations:operations.map(validateFinanceOperation),reportId,title,kind:'chart'};
}
