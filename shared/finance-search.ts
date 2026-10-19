import { z } from 'zod';
const label = z.string().min(1).max(500);
const url = z.string().max(2000).url().refine(value => { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; });
export const FinanceSecurityIdentitySchema = z.object({
  assetId: z.string().min(1).max(200),
  issuer: z.object({ id: label, name: label, authority: label, sourceUrl: url }).strict().nullable(),
  securityType: label.nullable(), sourceUrls: z.array(url).max(10), warnings: z.array(z.string().max(20000)).max(20),
}).strict();
/** Transient source-backed identity. Never persisted in the legacy asset/workspace schema. */
export interface FinanceSecurityIdentity {
  assetId: string;
  issuer: { id: string; name: string; authority: string; sourceUrl: string } | null;
  securityType: string | null;
  sourceUrls: string[];
  warnings: string[];
}
