import { businessOnlyKeys, isBusinessId } from './context';
import { businessNativeCanonical } from './native-sharing-wire';

export const COMPANY_NATIVE_SCHEMA = 'agentlas.business.company-native-enrollment.v1' as const;
export const COMPANY_NATIVE_BASE = '/api/business/native/company-identity/' as const;
export interface CompanyNativeEnrollment {
  readonly schema: typeof COMPANY_NATIVE_SCHEMA;
  readonly installationId: string;
  readonly devicePublicKey: string;
  readonly deviceKeyId: string;
  readonly pkceChallenge: string;
  readonly nonce: string;
}
/** Public enrollment selectors only; never a credential or an authorization. */
export function isCompanyNativeEnrollment(v: unknown): v is CompanyNativeEnrollment {
  return businessOnlyKeys(v, ['schema', 'installationId', 'devicePublicKey', 'deviceKeyId', 'pkceChallenge', 'nonce'])
    && v.schema === COMPANY_NATIVE_SCHEMA && [v.installationId, v.deviceKeyId].every(isBusinessId)
    && typeof v.devicePublicKey === 'string' && /^B[A-Za-z0-9_-]{86}$/.test(v.devicePublicKey)
    && typeof v.pkceChallenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v.pkceChallenge)
    && typeof v.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v.nonce);
}
export const companyNativeEnrollmentSigningText = (challengeId: string, enrollment: CompanyNativeEnrollment): string =>
  businessNativeCanonical([COMPANY_NATIVE_SCHEMA, 'consume', challengeId, enrollment]);

export interface CompanyNativeStatus {
  readonly connected: true;
  readonly organizationId: string;
  readonly principalId: string;
  readonly expiresAt: string;
}
export interface CompanyNativeAPI {
  status(): Promise<CompanyNativeStatus | null>;
  connect(): Promise<CompanyNativeStatus>;
  disconnect(): Promise<void>;
}
