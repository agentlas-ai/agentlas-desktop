import { businessOnlyKeys } from '../../shared/business/context';
import { BUSINESS_DASHBOARD_VIEWS, captureBusinessRendererBridge, type BusinessDashboardView, type BusinessRendererBridge } from '../../shared/business/console-contracts';
export { BUSINESS_DESKTOP_CONSOLE_SCHEMA, BUSINESS_DASHBOARD_VIEWS, captureBusinessRendererBridge, isBusinessRendererContext, isBusinessRendererSnapshot, type BusinessDashboardView, type BusinessRendererSnapshot, type BusinessRendererBridge } from '../../shared/business/console-contracts';

/** Explicit navigation uses the existing Desktop external-browser handler.
 * The browser authenticates itself; no Desktop actor, session or credential is copied. */
export async function openBusinessCloudDashboard(input: { view: BusinessDashboardView }): Promise<void> {
  if (!businessOnlyKeys(input, ['view']) || !BUSINESS_DASHBOARD_VIEWS.includes(input.view) || typeof window === 'undefined') throw Error('business_dashboard_navigation_unavailable');
  const view = input.view === 'history' || input.view === 'learning' ? 'personal' : 'organization';
  window.open(`https://agentlas.cloud/business?view=${view}&section=${encodeURIComponent(input.view)}`, '_blank', 'noopener,noreferrer');
}
export function currentBusinessRendererBridge(): BusinessRendererBridge | null {
  if (typeof window === 'undefined') return null;
  // Read the supplied namespace directly: metadata read caches cannot grant Business access.
  try { return captureBusinessRendererBridge(Object.getOwnPropertyDescriptor(window.agentlas, 'business')?.value); }
  catch { return null; }
}
