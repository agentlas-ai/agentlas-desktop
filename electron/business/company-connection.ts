import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { userDataPath } from '../runtime-paths';
import { activeEnterpriseConnection } from '../enterprise-server/runtime';

const ROOTS = Object.freeze([{ root: 'ar_2026_10', publicKey: 'iLiPu2zKQImJak8pepq6VO_NR8ZcQxhwbWp5ucj1Id0' }]);
const SCHEMA = 'agentlas.company-business-connection.v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@%/-]{0,255}$/;
type Envelope = { format: string; kid: string; payload: string; sig: string; cert?: Envelope };
export type CompanyBusinessConnection = {
  schema: typeof SCHEMA; serverUrl: string; companyName: string; installationId: string; serverPublicKey: string;
  organizationId: string; deploymentId: string; identityAuthorityId: string;
};
const fail = (): never => { throw Error('company_connection_invalid'); };
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === keys.sort().join();
}
function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)))
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return fail();
}
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function origin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
    && u.origin === value ? u.origin : null; } catch { return null; }
}
const iso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function openEnvelope(raw: unknown, format: string, key: string): Record<string, unknown> {
  if (!exact(raw, ['format', 'kid', 'payload', 'sig', ...(raw && typeof raw === 'object' && 'cert' in raw ? ['cert'] : [])])
    || raw.format !== format || typeof raw.kid !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(raw.kid)
    || typeof raw.payload !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.payload) || raw.payload.length > 100000
    || typeof raw.sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(raw.sig) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return fail();
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
  if (!verify(null, Buffer.from(`${format}\n${raw.kid}\n${raw.payload}`), publicKey, Buffer.from(raw.sig, 'base64url'))) return fail();
  const text = Buffer.from(raw.payload, 'base64url').toString('utf8');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || canonical(value) !== text) return fail();
  return value as Record<string, unknown>;
}
function certified(raw: unknown, format: string, roots: readonly { root: string; publicKey: string }[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || !('cert' in raw)) return fail();
  const e = raw as Envelope, root = roots.find(r => r.root === e.cert?.kid); if (!root || !e.cert) return fail();
  const cert = openEnvelope(e.cert, 'agentlas.enterprise-signing-cert.v1', root.publicKey);
  if (cert.root !== root.root || cert.kid !== e.kid || typeof cert.publicKey !== 'string'
    || !Array.isArray(cert.purposes) || !cert.purposes.includes(format === 'agentlas.enterprise-lease.v1' ? 'lease' : 'license')
    || !iso(cert.notBefore) || !iso(cert.notAfter)) return fail();
  const payload = openEnvelope(e, format, cert.publicKey);
  if (!iso(payload.issuedAt) || Date.parse(payload.issuedAt) < Date.parse(cert.notBefore) || Date.parse(payload.issuedAt) > Date.parse(cert.notAfter)) return fail();
  return payload;
}
/** Public metadata is not login authority. Only shipped roots are used by production callers. */
export function verifyCompanyConnectionDescriptor(raw: unknown, serverUrl: string, now = Date.now(), roots = ROOTS): CompanyBusinessConnection {
  if (!origin(serverUrl) || !exact(raw, ['schema', 'installation', 'grant', 'license', 'lease', 'serverTime'])
    || raw.schema !== 'agentlas.company-connection.v1' || !iso(raw.serverTime) || Math.abs(Date.parse(raw.serverTime) - now) > 300000
    || !exact(raw.installation, ['installationId', 'publicKey'])) return fail();
  const grant = certified(raw.grant, 'agentlas.enterprise-installation-grant.v1', roots);
  const license = certified(raw.license, 'agentlas.enterprise-license.v1', roots);
  if (grant.purpose !== 'company.installation' || !exact(grant.company, ['origin', 'organizationId', 'deploymentId', 'identityAuthorityId'])
    || grant.company.origin !== serverUrl || ![grant.company.organizationId, grant.company.deploymentId, grant.company.identityAuthorityId].every(v => typeof v === 'string' && ID.test(v))
    || grant.installationId !== raw.installation.installationId || grant.installationPublicKey !== raw.installation.publicKey
    || typeof grant.installationId !== 'string' || !ID.test(grant.installationId) || typeof grant.installationPublicKey !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(grant.installationPublicKey) || typeof grant.customerName !== 'string' || !grant.customerName || grant.customerName.length > 160
    || !iso(grant.issuedAt) || Date.parse(grant.issuedAt) > now + 30000 || grant.licenseEnvelopeSha256 !== digest(raw.license)
    || !grant.source || typeof grant.source !== 'object' || license.organizationId !== (grant.source as Record<string, unknown>).organizationId
    || grant.licenseId !== license.licenseId || grant.licenseRevision !== license.revision
    || !iso(license.notBefore) || Date.parse(license.notBefore) > now || !iso(license.hardEndsAt) || Date.parse(license.hardEndsAt) <= now
    || !Number.isSafeInteger(license.seats) || Number(license.seats) < 1 || !Array.isArray(license.features) || !license.features.includes('business')) return fail();
  const binding = license.binding as { installationId?: unknown } | undefined;
  if (!binding || binding.installationId !== null && binding.installationId !== grant.installationId) return fail();
  if (license.leaseMode === 'online') {
    const lease = certified(raw.lease, 'agentlas.enterprise-lease.v1', roots);
    if (lease.licenseId !== grant.licenseId || lease.installationId !== grant.installationId
      || !Number.isSafeInteger(lease.revision) || Number(lease.revision) < Number(grant.licenseRevision)
      || !['active', 'term_grace'].includes(String(lease.state)) || !iso(lease.leaseUntil)
      || !iso(lease.hardEndsAt) || Date.parse(lease.hardEndsAt) <= now || !iso(lease.issuedAt) || Date.parse(lease.issuedAt) > now + 30000) return fail();
  } else if (license.leaseMode !== 'offline' || binding.installationId !== grant.installationId || raw.lease !== null) return fail();
  return { schema: SCHEMA, serverUrl, companyName: grant.customerName, installationId: grant.installationId, serverPublicKey: grant.installationPublicKey,
    organizationId: String(grant.company.organizationId), deploymentId: String(grant.company.deploymentId), identityAuthorityId: String(grant.company.identityAuthorityId) };
}
export function parseCompanyConnectionLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 800) return null;
  try { const u = new URL(value);
    if (u.protocol !== 'agentlas:' || u.hostname !== 'company' || u.port || u.username || u.password || u.pathname !== '/connect' || u.hash
      || [...u.searchParams.keys()].join() !== 'server') return null;
    return origin(u.searchParams.get('server'));
  } catch { return null; }
}
export async function inspectCompanyConnection(serverUrl: string, fetchImpl: typeof fetch): Promise<CompanyBusinessConnection> {
  if (!origin(serverUrl)) return fail();
  const response = await fetchImpl(`${serverUrl}/.well-known/agentlas-company.json`, { redirect: 'error', credentials: 'omit',
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (response.status !== 200 || !response.body) return fail();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const c = await reader.read(); if (c.done) break; size += c.value.byteLength;
    if (size > 131072) { await reader.cancel(); return fail(); } chunks.push(c.value); } } finally { reader.releaseLock(); }
  return verifyCompanyConnectionDescriptor(JSON.parse(Buffer.concat(chunks).toString('utf8')), serverUrl);
}
function file() { return userDataPath('company-business', 'connection.json'); }
function read(): CompanyBusinessConnection | null {
  try { const target = file(), s = fs.lstatSync(target); if (!s.isFile() || s.isSymbolicLink() || s.size > 4096) return fail();
    const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!exact(value, ['schema', 'serverUrl', 'companyName', 'installationId', 'serverPublicKey', 'organizationId', 'deploymentId', 'identityAuthorityId'])
      || value.schema !== SCHEMA || !origin(value.serverUrl) || typeof value.companyName !== 'string' || !value.companyName || value.companyName.length > 160
      || ![value.installationId, value.organizationId, value.deploymentId, value.identityAuthorityId].every(v => typeof v === 'string' && ID.test(v))
      || typeof value.serverPublicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.serverPublicKey)) return fail();
    return value as CompanyBusinessConnection;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return fail(); }
}
/** Called only after the person's native company/address review. No credentials or grants are stored here. */
export function saveCompanyBusinessConnection(value: CompanyBusinessConnection): void {
  const managed = activeEnterpriseConnection();
  if (managed && (managed.serverUrl !== value.serverUrl || managed.serverKeyFingerprint !== createHash('sha256').update(Buffer.from(value.serverPublicKey, 'base64url')).digest('hex')))
    throw Error('company_connection_managed');
  const target = file(), dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ds = fs.lstatSync(dir); if (!ds.isDirectory() || ds.isSymbolicLink()) return fail();
  try { const s = fs.lstatSync(target); if (!s.isFile() || s.isSymbolicLink()) return fail(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const tmp = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, target); }
  finally { try { fs.unlinkSync(tmp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
}
/** Personal native transports keep webBaseUrl(); only company-owned Business uses this resolver. */
export function companyBusinessOrigin(): string {
  const managed = activeEnterpriseConnection(), local = read();
  if (managed) return origin(managed.serverUrl) ?? fail();
  if (local) return local.serverUrl;
  const cloud = new URL((require('../auth') as { webBaseUrl(): string }).webBaseUrl());
  return origin(cloud.origin) && cloud.pathname === '/' && !cloud.username && !cloud.password && !cloud.search && !cloud.hash ? cloud.origin : fail();
}
export function companyBusinessUsesLocalServer(): boolean { return !!activeEnterpriseConnection() || !!read(); }
