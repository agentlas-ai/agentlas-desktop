import type { FinanceDataConnectionRequest, FinanceDataConnectionResult } from '../../shared/finance';
import { financeProviderKey, financeProviderPresence } from './provider-credentials';
import { fetchFinanceJson } from './providers/http';

interface ConnectionPorts {
  assertCurrent(): void;
  readKey(): Promise<string | null>;
  readPresence(): Promise<'present' | 'missing' | 'unknown'>;
  fetchJson(url: URL): Promise<unknown>;
  now(): string;
}
const defaults = { readKey: financeProviderKey, readPresence: financeProviderPresence, fetchJson: fetchFinanceJson, now: () => new Date().toISOString() };
function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return /^finance_(?:source_(?:http_\d{3}|rate_limited|busy|too_large|empty|shape|url_rejected)|provider_credentials_unavailable)$/.test(value) ? value : 'finance_connection_failed';
}
/** Explicit one-request probe only. No model, workspace write, secret echo, background polling or demo key. */
export async function financeDataConnection(request: FinanceDataConnectionRequest, options: Pick<ConnectionPorts, 'assertCurrent'> & Partial<ConnectionPorts>): Promise<FinanceDataConnectionResult> {
  const ports = { ...defaults, ...options };
  ports.assertCurrent();
  const result: FinanceDataConnectionResult = { providerId: 'alpha-vantage', credential: 'unknown', access: 'not-tested', checkedAt: null, probe: null };
  if (request.action === 'status') {
    result.credential = await ports.readPresence(); ports.assertCurrent(); return result;
  }
  let key: string | null;
  try { key = await ports.readKey(); }
  catch (error) {
    ports.assertCurrent(); return { ...result, access: 'error', checkedAt: ports.now(), errorCode: errorCode(error) };
  }
  ports.assertCurrent();
  if (!key) return { ...result, credential: 'missing', access: 'unavailable', checkedAt: ports.now(), errorCode: 'finance_provider_not_configured' };
  result.credential = 'present';
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'GLOBAL_QUOTE'); url.searchParams.set('symbol', 'IBM'); url.searchParams.set('apikey', key);
  let raw: unknown;
  try { raw = await ports.fetchJson(url); }
  catch (error) {
    ports.assertCurrent(); return { ...result, access: 'error', checkedAt: ports.now(), errorCode: errorCode(error) };
  }
  ports.assertCurrent();
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (body.Note || body.Information || body['Error Message']) return { ...result, access: 'unavailable', checkedAt: ports.now(), errorCode: body['Error Message'] ? 'finance_provider_rejected' : 'finance_provider_limit_or_entitlement' };
  const candidate = body['Global Quote'];
  const quote = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {};
  const price = typeof quote['05. price'] === 'string' && quote['05. price'].trim() ? Number(quote['05. price']) : NaN;
  const day = typeof quote['07. latest trading day'] === 'string' ? quote['07. latest trading day'] : '';
  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
  if (quote['01. symbol'] !== 'IBM' || !Number.isFinite(price) || price < 0 || !validDay) return { ...result, access: 'error', checkedAt: ports.now(), errorCode: 'finance_source_shape' };
  return { ...result, access: 'available', checkedAt: ports.now(), probe: { symbol: 'IBM', metric: 'price', asOf: day } };
}
