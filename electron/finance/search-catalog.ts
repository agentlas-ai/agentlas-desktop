import { validateFinanceOperation, type FinanceAsset, type FinanceSecurityIdentity, type FinanceSearchResult } from '../../shared/finance';
import { FINANCE_DATA_CATEGORIES, resolveFinanceDataSource, type FinanceDataSelection } from '../../shared/finance-data-routing';
import type { FinanceScope } from './store';
import { FinanceSecurityIdentitySchema } from '../../shared/finance-search';

export function financeSearchRouteKey(selection: FinanceDataSelection): string {
  return JSON.stringify(FINANCE_DATA_CATEGORIES.map(category => [category, resolveFinanceDataSource(selection, category)]));
}
/** Bound provider payloads before either model context or renderer receives them. */
export function financeSearchResult(result: FinanceSearchResult): FinanceSearchResult {
  const assets = new Map<string, FinanceAsset>();
  for (const raw of result.assets.slice(0, 60)) {
    const op = validateFinanceOperation({ type: 'watchlist.add', asset: raw });
    if (op.type === 'watchlist.add' && !assets.has(op.asset.id) && assets.size < 30) assets.set(op.asset.id, op.asset);
  }
  // SEC-owned IDs are constructed from the fetched directory's actual CIK and ticker columns.
  // Neither names nor ticker shapes establish that two securities have the same issuer.
  const identities: FinanceSecurityIdentity[] = [...assets.values()].flatMap(asset => {
    const match = /^sec:(\d{10}):/.exec(asset.id);
    if (!match || !result.provider.includes('SEC EDGAR')) return [];
    const sourceUrl = 'https://www.sec.gov/files/company_tickers_exchange.json';
    return [{ assetId: asset.id, issuer: { id: `sec:cik:${match[1]}`, name: asset.name, authority: 'SEC EDGAR issuer directory', sourceUrl }, securityType: null,
      sourceUrls: [sourceUrl], warnings: ['SEC directory identifies the issuer; security class and legal instrument type are unknown.'] }];
  });
  for (const raw of (result.identities ?? []).slice(0, 30)) {
    const parsed = FinanceSecurityIdentitySchema.safeParse(raw);
    if (parsed.success && assets.has(parsed.data.assetId) && !identities.some(item => item.assetId === parsed.data.assetId)) identities.push(parsed.data);
  }
  const explicitIdentities = [...assets.values()].map(asset => {
    const identity = identities.find(item => item.assetId === asset.id) ?? { assetId: asset.id, issuer: null, securityType: null, sourceUrls: [], warnings: [] };
    const unknown = [...(!identity.issuer ? ['finance_issuer_identity_unknown'] : []), ...(!identity.securityType ? ['finance_security_type_unknown'] : [])];
    return { ...identity, warnings: [...new Set([...identity.warnings.slice(0, 18), ...unknown])] };
  });
  return { assets: [...assets.values()], provider: result.provider.slice(0, 500), asOf: result.asOf, warnings: result.warnings.slice(0, 100).map(value => value.slice(0, 20000)), identities: explicitIdentities };
}
interface Entry { asset: FinanceAsset; identity: FinanceSecurityIdentity; expiresAt: number }
interface Bucket { route: string; generation: number; assets: Map<string, Entry> }
export interface FinanceSearchLease { owner: string; route: string; generation: number }
/** Host memory only: no DB, renderer metadata, symbol matching or cross-owner lookup. */
export class FinanceSearchCatalog {
  private readonly owners = new Map<string, Bucket>();
  private generation = 0;
  constructor(private readonly now = Date.now, private readonly ttlMs = 15 * 60 * 1000) {}
  begin(scope: FinanceScope, selection: FinanceDataSelection): FinanceSearchLease {
    scope.assertCurrent();
    const owner = JSON.stringify([scope.workspaceId, scope.userId]), route = financeSearchRouteKey(selection);
    let bucket = this.owners.get(owner);
    if (!bucket || bucket.route !== route) bucket = { route, generation: ++this.generation, assets: new Map() };
    this.owners.delete(owner); this.owners.set(owner, bucket);
    while (this.owners.size > 32) this.owners.delete(this.owners.keys().next().value!);
    for (const [id, entry] of bucket.assets) if (entry.expiresAt <= this.now()) bucket.assets.delete(id);
    return { owner, route, generation: bucket.generation };
  }
  private bucket(scope: FinanceScope, lease: FinanceSearchLease, signal?: AbortSignal): Bucket {
    signal?.throwIfAborted(); scope.assertCurrent();
    const bucket = this.owners.get(lease.owner);
    if (lease.owner !== JSON.stringify([scope.workspaceId, scope.userId]) || !bucket || bucket.generation !== lease.generation || bucket.route !== lease.route) throw new Error('finance_search_selection_stale');
    return bucket;
  }
  register(scope: FinanceScope, lease: FinanceSearchLease, result: FinanceSearchResult, signal?: AbortSignal): void {
    const bucket = this.bucket(scope, lease, signal);
    const normalized = financeSearchResult(result);
    for (const asset of normalized.assets) {
      const identity = FinanceSecurityIdentitySchema.parse(normalized.identities!.find(item => item.assetId === asset.id));
      bucket.assets.delete(asset.id); bucket.assets.set(asset.id, { asset: { ...asset }, identity, expiresAt: this.now() + this.ttlMs });
      while (bucket.assets.size > 240) bucket.assets.delete(bucket.assets.keys().next().value!);
    }
  }
  resolve(scope: FinanceScope, lease: FinanceSearchLease, ids: readonly string[], watchlist: readonly FinanceAsset[], signal?: AbortSignal): FinanceAsset[] {
    return this.resolveSelection(scope, lease, ids, watchlist, signal).assets;
  }
  resolveSelection(scope: FinanceScope, lease: FinanceSearchLease, ids: readonly string[], watchlist: readonly FinanceAsset[], signal?: AbortSignal): { assets: FinanceAsset[]; identities: FinanceSecurityIdentity[] } {
    const bucket = this.bucket(scope, lease, signal);
    const selected = ids.map(id => {
      const saved = watchlist.find(asset => asset.id === id), cached = bucket.assets.get(id);
      const live = cached && cached.expiresAt > this.now() ? cached : undefined;
      const asset = saved ?? live?.asset;
      if (!asset) throw new Error('finance_search_selection_stale');
      const identity = live?.identity ?? financeSearchResult({ assets: [asset], provider: 'Saved watchlist', asOf: null, warnings: [] }).identities![0];
      return { asset: { ...asset }, identity: FinanceSecurityIdentitySchema.parse(identity) };
    });
    return { assets: selected.map(item => item.asset), identities: selected.map(item => item.identity) };
  }
}
