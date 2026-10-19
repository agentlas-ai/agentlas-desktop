import type { FinanceAsset, FinanceDataResult } from '../../shared/finance';
import { resolveFinanceDataSource } from '../../shared/finance-data-routing';
import type { FinanceDataRoute } from './data';
import { screenYahooFinanceAssets, YAHOO_DISCOVERY_PRESETS, type YahooDiscoveryPreset } from './providers/yahoo-market';
export { YAHOO_DISCOVERY_PRESETS as FINANCE_DISCOVERY_PRESETS } from './providers/yahoo-market';
export interface FinanceDiscoveryResult {assets:FinanceAsset[];data:FinanceDataResult;coverage:{returned:number;total:number|null}}
/** Caller supplies only a preset; the host supplies account-bound source selection and cancellation. */
export async function discoverFinanceAssets(preset:string,route:FinanceDataRoute):Promise<FinanceDiscoveryResult>{
 route.assertCurrent?.();route.signal?.throwIfAborted();
 if(!YAHOO_DISCOVERY_PRESETS.includes(preset as YahooDiscoveryPreset))throw new Error('finance_discovery_preset_invalid');
 if(resolveFinanceDataSource(route,'market')!=='finance-yfinance')throw new Error('finance_discovery_source_unsupported');
 const result=await screenYahooFinanceAssets(preset as YahooDiscoveryPreset,{signal:route.signal});route.assertCurrent?.();route.signal?.throwIfAborted();return result;
}
