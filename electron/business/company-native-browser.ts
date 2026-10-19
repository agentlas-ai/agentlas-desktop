import { businessOnlyKeys, isBusinessId, isBusinessSession, type BusinessSession } from '../../shared/business/context';
import { COMPANY_NATIVE_BASE, isCompanyNativeEnrollment, type CompanyNativeEnrollment } from '../../shared/business/company-native';

export interface CompanyNativeBrowserPort {
  currentSession(): Promise<BusinessSession | null>;
  approve(input: CompanyNativeEnrollment, expected: BusinessSession): Promise<{ challengeId: string; expiresAt: number } | null>;
}
/** This fixed route returns a public challenge. PKCE consumption and delivery of
 * the company-only credential happen directly to Main, outside this browser. */
export function companyNativeEnrollmentScript(origin: string, enrollment: CompanyNativeEnrollment, expected: BusinessSession): string {
  if (!isCompanyNativeEnrollment(enrollment) || !isBusinessSession(expected)) throw Error('company_native_enrollment_invalid');
  const input = JSON.stringify({ origin, path: `${COMPANY_NATIVE_BASE}challenge`, enrollment, expected });
  return `(async () => {
    const input = ${input};
    const exactPage = () => location.origin === input.origin && location.pathname === '/business';
    if (!exactPage()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(input.path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-agentlas-company-native-context': JSON.stringify(input.expected) }, body: JSON.stringify(input.enrollment) });
      if (response.status !== 200 && response.status !== 201 || !response.body || !exactPage()) return null;
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
        if (size > 4096) { await reader.cancel(); return null; } chunks.push(chunk.value); }
      if (!exactPage()) return null;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['challengeId','expiresAt'].includes(key))) return null;
      return { challengeId: value.challengeId, expiresAt: value.expiresAt };
    } catch { return null; } finally { clearTimeout(timer); }
  })()`;
}
export function companyNativeEnrollmentResult(value: unknown): value is { challengeId: string; expiresAt: number } {
  return businessOnlyKeys(value, ['challengeId', 'expiresAt']) && isBusinessId(value.challengeId)
    && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now()
    && value.expiresAt <= Date.now() + 600_000;
}
