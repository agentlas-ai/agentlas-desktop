import { isBusinessId } from './context';
import { looksSecret } from '../secret-patterns';

export const BUSINESS_ELIGIBILITY_SCHEMA = 'agentlas.business.eligibility.v1' as const;
export const BUSINESS_ELIGIBILITY_TTL_MS = 30_000;
export const BUSINESS_ORGANIZATION_PLANS = ['business_beta', 'business_team', 'business_enterprise'] as const;
/** Authenticated server display metadata only. Never a session, native identity,
 * execution grant or substitute for an operation's current authorization. */
export interface BusinessEligibility {
  readonly schema: typeof BUSINESS_ELIGIBILITY_SCHEMA;
  readonly principalId: string | null;
  readonly eligible: boolean;
  readonly organizations: readonly { readonly organizationId: string; readonly name: string;
    readonly plan: typeof BUSINESS_ORGANIZATION_PLANS[number]; readonly expiresAt: string }[];
  readonly activeOrganizationId: string | null;
  readonly checkedAt: string;
  readonly expiresAt: string;
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => descriptors[key]?.enumerable && 'value' in descriptors[key]);
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
/** Mirrors the actual Web organization-plan boundary. Accessors, foreign plans,
 * sparse arrays, expired/oversized display windows and ambiguous orgs are closed. */
export function isBusinessEligibility(value: unknown, now = Date.now()): value is BusinessEligibility {
  try {
    if (!Number.isSafeInteger(now) || now < 0 || now >= 8640000000000000 - BUSINESS_ELIGIBILITY_TTL_MS
      || !record(value, ['schema', 'principalId', 'eligible', 'organizations', 'activeOrganizationId', 'checkedAt', 'expiresAt'])
      || value.schema !== BUSINESS_ELIGIBILITY_SCHEMA || value.principalId !== null && !isBusinessId(value.principalId)
      || typeof value.eligible !== 'boolean' || value.activeOrganizationId !== null && !isBusinessId(value.activeOrganizationId)
      || !timestamp(value.checkedAt) || !timestamp(value.expiresAt)) return false;
    const checked = Date.parse(value.checkedAt), expires = Date.parse(value.expiresAt);
    if (checked > now + 5000 || expires <= now || expires <= checked || expires - checked > BUSINESS_ELIGIBILITY_TTL_MS
      || expires > now + BUSINESS_ELIGIBILITY_TTL_MS) return false;
    const rows = value.organizations;
    if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > 256
      || Reflect.ownKeys(rows).length !== rows.length + 1
      || !Array.from({ length: rows.length }, (_, i) => Object.getOwnPropertyDescriptor(rows, String(i))).every(d => d?.enumerable && 'value' in d)) return false;
    const ids = new Set<string>();
    for (const row of rows) {
      if (!record(row, ['organizationId', 'name', 'plan', 'expiresAt']) || !isBusinessId(row.organizationId)
        || ids.has(row.organizationId) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 160
        || /[\u0000-\u001f\u007f]/.test(row.name) || looksSecret(row.name)
        || !(BUSINESS_ORGANIZATION_PLANS as readonly unknown[]).includes(row.plan)
        || !timestamp(row.expiresAt) || Date.parse(row.expiresAt) < expires) return false;
      ids.add(row.organizationId);
    }
    return value.eligible === (rows.length > 0) && (value.principalId !== null || rows.length === 0)
      && (value.activeOrganizationId === null || ids.has(value.activeOrganizationId));
  } catch { return false; }
}
