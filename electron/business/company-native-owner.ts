import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { OneVaultSqlite } from '../secrets/one-vault-journal';
import BetterSqlite3 from 'better-sqlite3';
import { userDataPath } from '../runtime-paths';
import { webBaseUrl } from '../auth';
import { companyBusinessOrigin } from './company-connection';
import { enterpriseServerFetch } from '../enterprise-server/os-trust-fetch';
import { businessNativeSigningText, isBusinessNativeIdentity, type BusinessNativeAssociation, type BusinessNativeIdentity, type BusinessNativeRequestProof } from '../../shared/business/native-sharing-wire';
import { businessOnlyKeys, isBusinessSession, type BusinessSession } from '../../shared/business/context';
import { COMPANY_NATIVE_BASE, COMPANY_NATIVE_SCHEMA, companyNativeEnrollmentSigningText, type CompanyNativeEnrollment, type CompanyNativeStatus } from '../../shared/business/company-native';
import type { CompanyNativeBrowserPort } from './company-native-browser';
import { businessEmployeeAgentNativeDigest as digest } from './employee-agent-report-adapter';
import { isAppControlEvent } from '../app-control/ipc-registry';

import { companyDeviceSheet } from './native-approval-sheets';
function fail(code = 'company_native_owner_required'): never { throw Error(code); }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Stored = { schema: 'agentlas.company-native-private.v1'; credential: string; privateKey: string; origin: string; association: BusinessNativeAssociation; installationId: string };
type Held = { value: Stored; path: string; generation: number; db: OneVaultSqlite; root: string; serverPreflight: boolean };
const allowed = new Set(['association', 'revoke', 'transfers/inbox', 'transfers/snapshot', 'transfers/snapshot-receipt', 'transfers/prepare', 'transfers/commit', 'transfers/receipt', 'transfers/package', 'transfers/install-ack', 'transfers/installation-receipt', 'transfers/source-register', 'transfers/source-receipt', 'company-work/admit', 'company-work/claim', 'company-work/refresh', 'company-work/settle', 'company-work/receipt', 'company-work/cancel', 'company-work/review', 'company-work/policies']);
function validAssociation(value: unknown): value is BusinessNativeAssociation {
  if (!businessOnlyKeys(value, ['associationId', 'associationRevision', 'orgSession', 'native', 'nativeAccountAuthEpoch', 'purpose', 'audiencePrincipalIds', 'sourceAuthorityId', 'commandAuthorityId', 'consentRevision', 'sourceRevision', 'state', 'expiresAt'])) return false;
  const a = value as unknown as BusinessNativeAssociation;
  return typeof a.associationId === 'string' && /^company-native:[a-f0-9-]{36}$/.test(a.associationId) && isBusinessSession(a.orgSession) && isBusinessNativeIdentity(a.native)
    && a.native.nativeAccountId === a.orgSession.principalId && a.nativeAccountAuthEpoch === a.orgSession.authEpoch
    && a.native.oneId.startsWith('company-agent-owner:') && a.native.nativeWorkspaceId.startsWith('company-workspace:') && a.native.nativeSessionId.startsWith('company-session-')
    && a.native.nativeHostId.startsWith('company-device:') && a.native.hostKeyId.startsWith('company-key:') && a.state === 'active' && a.expiresAt === a.orgSession.expiresAt
    && Date.parse(a.expiresAt) > Date.now() && [a.associationRevision, a.sourceRevision, a.consentRevision].every(v => Number.isSafeInteger(v) && v >= 0)
    && a.purpose === 'organization.employee-agent-report' && Array.isArray(a.audiencePrincipalIds) && a.audiencePrincipalIds.length === 1 && a.audiencePrincipalIds[0] === a.orgSession.principalId;
}
export function registerCompanyNativeOwnerMain(input: {
  ipc: Pick<IpcMain, 'handle'>; browser: CompanyNativeBrowserPort;
  assertTrustedSender(event: IpcMainInvokeEvent): BrowserWindow; isOwnerWindow(window: BrowserWindow): boolean;
  locale(): 'ko' | 'en'; signal: AbortSignal;
}) {
  let held: Held | null = null, closed = false, generation = 0, connecting = false, attemptGeneration = 0;
  let timer: NodeJS.Timeout | null = null;
  let db: OneVaultSqlite | null = null;
  const opened = new Set<BetterSqlite3.Database>();
  const references = [input.ipc, input.browser, input.browser.currentSession, input.browser.retainsOriginalSession, input.browser.approve, input.assertTrustedSender, input.isOwnerWindow, input.locale, input.signal];
  const callbacks = new Set<() => void>();
  function refs() { if (closed || input.signal.aborted || [input.ipc, input.browser, input.browser.currentSession, input.browser.retainsOriginalSession, input.browser.approve, input.assertTrustedSender, input.isOwnerWindow, input.locale, input.signal].some((v, i) => v !== references[i])) fail(); }
  function localDb() { refs(); if (!db) fail(); return db; }
  async function openDb(session: BusinessSession) { refs(); const root = userDataPath('company-identities', hash([session.deploymentId, session.identityAuthorityId, session.organizationId, session.principalId].join('\n')));
    await fs.mkdir(root, { recursive: true, mode: 0o700 }); refs();
    const info = await fs.lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) fail('company_native_storage_invalid');
    const file = path.join(root, 'owner.sqlite'); try { const s = await fs.lstat(file); if (!s.isFile() || s.isSymbolicLink()) fail('company_native_storage_invalid'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const ownerDb = new BetterSqlite3(file); ownerDb.pragma('journal_mode = WAL'); opened.add(ownerDb);
    ownerDb.exec(`CREATE TABLE IF NOT EXISTS company_native_identity_owners(
    association_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, principal_id TEXT NOT NULL, state TEXT NOT NULL,
    public_json TEXT NOT NULL, encrypted_path TEXT NOT NULL, generation INTEGER NOT NULL, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS company_installed_agents(agent_id TEXT PRIMARY KEY,display_name TEXT NOT NULL,definition TEXT NOT NULL,root_path TEXT NOT NULL);`);
    return { db: ownerDb as OneVaultSqlite, root };
  }
  function current(): BusinessNativeAssociation | null {
    try { refs(); const h = held; if (!h || h.value.origin !== companyBusinessOrigin() || !validAssociation(h.value.association) || h.generation !== generation || !db || h.db !== db
      || h.serverPreflight && !input.browser.retainsOriginalSession(h.value.association.orgSession)) return null;
      const row = db.prepare("SELECT public_json,encrypted_path,generation FROM company_native_identity_owners WHERE association_id=? AND state='active'").get(h.value.association.associationId) as { public_json: string; encrypted_path: string; generation: number } | undefined;
      return row?.public_json === JSON.stringify(h.value.association) && row.encrypted_path === h.path && row.generation === h.generation ? structuredClone(h.value.association) : null;
    } catch { return null; }
  }
  function assertCurrent() { if (!current()) fail(); }
  function native(): BusinessNativeIdentity { return current()?.native ?? fail(); }
  function currentNativeOwner() { const n = current()?.native; return n ? { principalId: n.nativeAccountId, sessionId: n.nativeSessionId, workspaceId: n.nativeWorkspaceId, hostId: n.nativeHostId, custodyGeneration: n.custodyGeneration } : null; }
  function status(): CompanyNativeStatus | null { const a = current(); return a ? { connected: true, organizationId: a.orgSession.organizationId, principalId: a.orgSession.principalId, expiresAt: a.expiresAt } : null; }
  function deactivate(revoke: boolean) { const previous = held; held = null; generation++;
    if (revoke && previous) previous.db.prepare("UPDATE company_native_identity_owners SET state='revoked' WHERE association_id=?").run(previous.value.association.associationId);
    for (const callback of callbacks) { try { callback(); } catch { /* Independent lifetime cleanup cannot prevent the rest. */ } }
  }
  function invalidate() { attemptGeneration++; deactivate(true); }
  function base() { const configured = companyBusinessOrigin(); if (held && held.value.origin !== configured) { invalidate(); fail('company_native_session_changed'); } const u = new URL(configured); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) fail(); return u; }
  async function jsonRequest(target: URL, method: string, body: string, headers: Record<string, string>) {
    const response = await enterpriseServerFetch(target, { method, credentials: 'omit', headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body }), redirect: 'error', signal: AbortSignal.any([input.signal, AbortSignal.timeout(45000)]) });
    const reader = response.body?.getReader(); if (!reader) fail('company_native_response_invalid'); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const c = await reader.read(); if (c.done) break; size += c.value.byteLength; if (size > 1048576) { await reader.cancel(); fail('company_native_response_invalid'); } chunks.push(c.value); } } finally { reader.releaseLock(); }
    let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('company_native_response_invalid'); }
    if (!response.ok) { const code = value && typeof value === 'object' && 'error' in value ? (value as { error: unknown }).error : null;
      const machineCode = typeof code === 'string' && /^[a-z0-9_]{1,100}$/.test(code) ? code : 'company_native_root_denied';
      throw Object.assign(Error(machineCode), { status: response.status, code: machineCode }); }
    return value;
  }
  async function sameBrowser(a: BusinessNativeAssociation) { const currentSession = await input.browser.currentSession(); refs(); if (!currentSession || digest(currentSession) !== digest(a.orgSession)) { invalidate(); fail('company_native_session_changed'); } }
  /** Capability changes transport freshness only; the signed original remains the server's authority. */
  async function serverNativePreflight(configuredOrigin: string): Promise<boolean> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(5000)]);
    const abort = () => { void reader?.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const target = new URL('/api/company/auth/status', configuredOrigin);
      if (target.origin !== base().origin || configuredOrigin !== target.origin) return false;
      const response = await enterpriseServerFetch(target, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal });
      if (!response.ok || response.redirected || response.url && response.url !== target.href
        || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel(); return false;
      }
      reader = response.body?.getReader(); if (!reader || signal.aborted) return false;
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await reader.read(); if (signal.aborted) return false; if (part.done) break;
        size += part.value.byteLength; if (size > 4096) { await reader.cancel(); return false; } chunks.push(part.value); }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      return companyBusinessOrigin() === configuredOrigin && businessOnlyKeys(value, ['schema', 'protocol', 'ready', 'reason', 'companyName', 'setupPhase', 'workerVersion', 'nativePreflight'])
        && value.schema === 'agentlas.company-browser-auth.v1' && value.protocol === 'company_cloud_v1'
        && value.ready === true && value.reason === 'ready' && value.setupPhase === 'ready'
        && (value.companyName === null || typeof value.companyName === 'string' && value.companyName.length <= 256)
        && typeof value.workerVersion === 'string' && value.workerVersion.length <= 64
        && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.workerVersion)
        && value.nativePreflight === 'server_native_preflight_v1';
    } catch { return false; }
    finally { signal.removeEventListener('abort', abort); if (reader) { try { await reader.cancel(); } catch { /* Read-only capability fallback. */ } reader.releaseLock(); } }
  }
  async function requestIdentity(h: Held, a: BusinessNativeAssociation, terminal: boolean) {
    if (h.serverPreflight || terminal) {
      refs(); if (!input.browser.retainsOriginalSession(a.orgSession)) fail('company_native_session_changed');
    } else await sameBrowser(a);
  }
  let requestTail: Promise<unknown> = Promise.resolve();
  function request(operation: string, value: unknown = null, query?: Record<string, string>): Promise<unknown> {
    const expected = held;
    const result = requestTail.then(() => { if (!expected || held !== expected) fail('company_native_session_changed'); return performRequest(operation, value, query); });
    requestTail = result.catch(() => {}); return result;
  }
  async function performRequest(operation: string, value: unknown = null, query?: Record<string, string>): Promise<unknown> {
    refs(); if (!allowed.has(operation) || query && Object.keys(query).length) fail('company_native_operation_denied');
    const a = current(); if (!a || !held) fail(); const h = held; await requestIdentity(h, a, operation === 'revoke'); if (held !== h || digest(current()) !== digest(a)) fail();
    const method = operation === 'association' ? 'GET' : 'POST';
    const route = operation === 'association' || operation === 'revoke' ? COMPANY_NATIVE_BASE + operation : '/api/business/native/employee-agents/' + operation;
    const target = new URL(route, base()), body = method === 'GET' ? '' : JSON.stringify(value); if (Buffer.byteLength(body) > 524288) fail('company_native_request_too_large');
    const sequence = localDb().transaction(() => { assertCurrent(); const row = localDb().prepare("SELECT sequence FROM company_native_identity_owners WHERE association_id=? AND state='active'").get(a.associationId) as { sequence: number };
      if (!Number.isSafeInteger(row?.sequence) || row.sequence >= Number.MAX_SAFE_INTEGER) fail();
      if (Number(localDb().prepare("UPDATE company_native_identity_owners SET sequence=sequence+1 WHERE association_id=? AND state='active' AND sequence=?").run(a.associationId, row.sequence).changes) !== 1) fail(); return row.sequence + 1;
    }).immediate();
    const issuedAt = Date.now(), payload = { associationId: a.associationId, associationRevision: a.associationRevision, native: a.native, nativeAccountAuthEpoch: a.nativeAccountAuthEpoch,
      method, url: target.toString(), bodyDigest: hash(body), nonce: randomUUID(), sequence, issuedAt, expiresAt: issuedAt + 30000 };
    const proof: BusinessNativeRequestProof = { payload, signature: sign('sha256', Buffer.from(businessNativeSigningText('request', payload)), { key: createPrivateKey(h.value.privateKey), dsaEncoding: 'ieee-p1363' }).toString('base64url') };
    try { const result = await jsonRequest(target, method, body, { Authorization: 'Bearer ' + h.value.credential, 'x-agentlas-business-native-proof': Buffer.from(JSON.stringify(proof)).toString('base64url') });
      await requestIdentity(h, a, operation === 'revoke'); if (held !== h || digest(current()) !== digest(a)) fail('company_native_session_changed'); return result;
    } catch (error) {
      const denied = error as { status?: number; code?: string };
      const recipientReadGrantMissing = denied.status === 403 && denied.code === 'grant_missing'
        && (operation === 'transfers/receipt' || operation === 'transfers/package');
      if (denied.status === 401 || denied.status === 403 && !recipientReadGrantMissing) invalidate();
      throw error;
    }
  }
  async function refresh() { const a = current(); if (!a) fail(); const result = await request('association'); if (!validAssociation(result) || digest(result) !== digest(a)) { invalidate(); fail('company_native_identity_changed'); } return current() ?? fail(); }
  function startMonitor() { if (!timer) { timer = setInterval(() => { if (current()) void refresh().catch(() => invalidate()); else if (held) invalidate(); }, 60000); timer.unref(); } }
  const connection = Object.freeze({ current, native, request, refresh, assertCurrent, invalidate, onInvalidated(callback: () => void) { callbacks.add(callback); return () => callbacks.delete(callback); } });
  function focused(event: IpcMainInvokeEvent) { refs(); const window = input.assertTrustedSender(event), id = event.sender.id, frame = event.senderFrame, frameUrl = frame?.url;
    const check = () => { refs(); if (isAppControlEvent(event) || !input.isOwnerWindow(window) || window.isDestroyed() || !window.isFocused() || event.sender.isDestroyed() || event.sender.id !== id || window.webContents !== event.sender || input.assertTrustedSender(event) !== window
      || event.senderFrame !== frame || frame !== event.sender.mainFrame || frame?.url !== frameUrl || (require('electron') as typeof import('electron')).BrowserWindow.fromWebContents(event.sender) !== window) fail('company_native_focused_review_required'); }; check(); return { window, check };
  }
  async function connect(event: IpcMainInvokeEvent) {
    const review = focused(event), attempt = attemptGeneration, configuredOrigin = companyBusinessOrigin();
    const f = { window: review.window, check() { review.check(); if (attempt !== attemptGeneration || companyBusinessOrigin() !== configuredOrigin) fail('company_native_connection_cancelled'); } };
    if (connecting) fail('company_native_connection_pending'); connecting = true;
    try { const session = await input.browser.currentSession(); f.check(); if (!session || !isBusinessSession(session)) fail('company_native_sso_required');
      const ko = input.locale() === 'ko', electron = require('electron') as typeof import('electron');
      const answer = await electron.dialog.showMessageBox(f.window, companyDeviceSheet(ko, session));
      f.check(); if (answer.response !== 1) fail('company_native_review_declined');
      if (digest(await input.browser.currentSession()) !== digest(session)) fail('company_native_session_changed'); f.check();
      const serverPreflight = await serverNativePreflight(configuredOrigin); f.check();
      const storage = electron.safeStorage;
      if (typeof storage.encryptStringAsync !== 'function' || typeof storage.isAsyncEncryptionAvailable !== 'function' || !await storage.isAsyncEncryptionAvailable()
        || process.platform === 'linux' && storage.getSelectedStorageBackend() === 'basic_text') fail('company_native_secure_storage_unavailable'); f.check();
      const local = await openDb(session); f.check();
      const candidates = local.db.prepare("SELECT public_json,encrypted_path FROM company_native_identity_owners WHERE state='active' AND organization_id=? AND principal_id=? LIMIT 65")
        .all(session.organizationId, session.principalId) as Array<{ public_json: string; encrypted_path: string }>;
      if (candidates.length > 64) fail('company_native_storage_invalid');
      for (const row of candidates) {
        let association: unknown; try { association = JSON.parse(row.public_json); } catch { fail('company_native_storage_invalid'); }
        if (!validAssociation(association) || digest(association.orgSession) !== digest(session)) continue;
        if (path.dirname(row.encrypted_path) !== local.root || path.basename(row.encrypted_path) !== association.associationId.replace(':', '-') + '.enc'
          || typeof storage.decryptStringAsync !== 'function') fail('company_native_storage_invalid');
        const info = await fs.lstat(row.encrypted_path); if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) fail('company_native_storage_invalid');
        const text = await storage.decryptStringAsync(await fs.readFile(row.encrypted_path)); f.check();
        let restored: Stored; try { restored = JSON.parse(text.result) as Stored; } catch { fail('company_native_storage_invalid'); }
        if (restored.origin === undefined && configuredOrigin === new URL(webBaseUrl()).origin) restored.origin = configuredOrigin;
        if (restored.origin !== configuredOrigin) fail('company_native_session_changed');
        if (restored.schema !== 'agentlas.company-native-private.v1' || digest(restored.association) !== digest(association)
          || !/^agcni_v1_[A-Za-z0-9_-]{43}$/.test(restored.credential) || typeof restored.privateKey !== 'string') fail('company_native_storage_invalid');
        const publicJwk = createPrivateKey(restored.privateKey).export({ format: 'jwk' });
        if (!publicJwk.x || !publicJwk.y || Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, 'base64url'), Buffer.from(publicJwk.y, 'base64url')]).toString('base64url') !== association.native.hostPublicKey) fail('company_native_storage_invalid');
        await sameBrowser(association); f.check();
        deactivate(true); db = local.db;
        if (Number(db.prepare("UPDATE company_native_identity_owners SET generation=? WHERE association_id=? AND state='active' AND public_json=?").run(generation, association.associationId, row.public_json).changes) !== 1) fail('company_native_storage_invalid');
        held = { value: restored, path: row.encrypted_path, generation, db, root: local.root, serverPreflight }; activeOriginal = buildOriginal(held); startMonitor();
        await refresh(); f.check(); return status() ?? fail();
      }
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = pair.publicKey.export({ format: 'jwk' });
      if (!jwk.x || !jwk.y) fail(); const publicPoint = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
      const installationId = `company-installation:${randomUUID()}`, verifier = randomBytes(32).toString('base64url');
      const enrollment: CompanyNativeEnrollment = { schema: COMPANY_NATIVE_SCHEMA, installationId, devicePublicKey: publicPoint, deviceKeyId: `company-key:${hash(publicPoint)}`,
        pkceChallenge: createHash('sha256').update(verifier).digest('base64url'), nonce: randomBytes(32).toString('base64url') };
      const challenge = await input.browser.approve(enrollment, session); f.check(); if (!challenge || challenge.expiresAt <= Date.now()) fail('company_native_approval_unavailable');
      const signature = sign('sha256', Buffer.from(companyNativeEnrollmentSigningText(challenge.challengeId, enrollment)), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      const result = await jsonRequest(new URL(COMPANY_NATIVE_BASE + 'consume', base()), 'POST', JSON.stringify({ challengeId: challenge.challengeId, verifier, signature }), {}); f.check();
      if (!businessOnlyKeys(result, ['credential', 'association']) || typeof result.credential !== 'string' || !/^agcni_v1_[A-Za-z0-9_-]{43}$/.test(result.credential)
        || !validAssociation(result.association) || digest(result.association.orgSession) !== digest(session) || result.association.native.hostPublicKey !== publicPoint || result.association.native.hostKeyId !== enrollment.deviceKeyId) fail('company_native_response_invalid');
      const value: Stored = { schema: 'agentlas.company-native-private.v1', credential: result.credential, origin: configuredOrigin, privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), association: result.association, installationId };
      const ciphertext = await storage.encryptStringAsync(JSON.stringify(value)); f.check(); if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) fail('company_native_secure_storage_unavailable');
      const encryptedPath = path.join(local.root, result.association.associationId.replace(':', '-') + '.enc');
      await fs.mkdir(path.dirname(encryptedPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(encryptedPath, ciphertext, { flag: 'wx', mode: 0o600 }); f.check();
      if (digest(await input.browser.currentSession()) !== digest(session)) fail('company_native_session_changed'); f.check();
      deactivate(true); db = local.db; db.prepare("INSERT INTO company_native_identity_owners VALUES(?,?,?,'active',?,?,?,0)")
        .run(value.association.associationId, session.organizationId, session.principalId, JSON.stringify(value.association), encryptedPath, generation);
      held = { value, path: encryptedPath, generation, db, root: local.root, serverPreflight }; activeOriginal = buildOriginal(held); startMonitor(); return status() ?? fail();
    } finally { connecting = false; }
  }
  input.ipc.handle('companyNative:status', async (event: IpcMainInvokeEvent) => { input.assertTrustedSender(event); refs(); if (!current()) return null; try { await refresh(); return status(); } catch { invalidate(); return null; } });
  input.ipc.handle('companyNative:connect', (event: IpcMainInvokeEvent) => connect(event));
  input.ipc.handle('companyNative:disconnect', async (event: IpcMainInvokeEvent) => { const f = focused(event); attemptGeneration++; try { if (current()) { await request('revoke', {}); f.check(); } } finally { invalidate(); } });
  let activeOriginal: ReturnType<typeof buildOriginal> | null = null;
  function buildOriginal(h: Held) {
    const identityOwner = Object.freeze({});
    const check = () => { refs(); if (held !== h || db !== h.db || !current()) fail('company_native_session_changed'); };
    const scopedPath = (...segments: string[]) => { check(); const p = path.resolve(h.root, ...segments); if (p !== h.root && !p.startsWith(h.root + path.sep)) fail('company_native_storage_invalid'); return p; };
    const pinnedConnection = Object.freeze({ current() { try { check(); return current(); } catch { return null; } }, native() { check(); return native(); },
      async request(operation: string, value: unknown = null, query?: Record<string, string>) { check(); const r = await connection.request(operation, value, query); check(); return r; },
      async refresh() { check(); const r = await connection.refresh(); check(); return r; }, assertCurrent: check,
      invalidate() { if (held === h) invalidate(); }, onInvalidated: connection.onInvalidated });
    const installation = Object.freeze({
      installed(v: { agentId: string; displayName: string; definition: string }, root: string) { check(); const row = h.db.prepare('SELECT display_name,definition,root_path FROM company_installed_agents WHERE agent_id=?').get(v.agentId) as { display_name: string; definition: string; root_path: string } | undefined;
        return row?.display_name === v.displayName && row.definition === v.definition && row.root_path === root; },
      async install(v: { agentId: string; displayName: string; definition: string }, root: string) { check(); if (!root.startsWith(h.root + path.sep) || !v.agentId || !v.definition || Buffer.byteLength(v.definition) > 196608) fail('company_native_install_invalid');
        h.db.prepare('INSERT INTO company_installed_agents VALUES(?,?,?,?)').run(v.agentId, v.displayName, v.definition, root); check(); },
    });
    return Object.freeze({ identityOwner, db: h.db, userDataPath: scopedPath, assertCurrent: check, currentNativeOwner() { try { check(); return currentNativeOwner(); } catch { return null; } }, connection: pinnedConnection, installation });
  }
  function close() { if (closed) return; if (timer) clearInterval(timer); timer = null; deactivate(false); closed = true; callbacks.clear(); for (const database of opened) { try { database.close(); } catch { /* All captures were already invalidated. */ } } opened.clear(); }
  input.signal.addEventListener('abort', close, { once: true });
  if (input.signal.aborted) close();
  return Object.freeze({ original() { return current() ? activeOriginal : null; }, invalidate, close });
}
export type CompanyNativeOriginal = NonNullable<ReturnType<ReturnType<typeof registerCompanyNativeOwnerMain>['original']>>;
