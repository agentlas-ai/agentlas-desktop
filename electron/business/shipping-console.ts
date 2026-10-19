import type { BrowserWindow, Session } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  BUSINESS_DASHBOARD_VIEWS, BUSINESS_DESKTOP_CONSOLE_SCHEMA,
  freezeBusinessConsoleMetadata, isBusinessAccountSnapshot, isBusinessConsoleMetadata,
  type BusinessAccountPanelPort, type BusinessAccountSnapshot, type BusinessDashboardView,
  type BusinessRendererBridge, type BusinessRendererSnapshot,
} from '../../shared/business/console-contracts';
import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessSession, sameBusinessSession, type BusinessSession } from '../../shared/business/context';
import { isBusinessEligibility, type BusinessEligibility } from '../../shared/business/eligibility';
import { bindAgentMailOrganizationTransport } from '../agent-mail/client';
import type { OrganizationMailTransport } from '../../shared/agent-mail';
import { organizationMailBrowserRequest, organizationMailBrowserResponse, organizationMailBrowserScript } from './organization-mail-browser';
import { companyNativeEnrollmentResult, companyNativeEnrollmentScript, type CompanyNativeBrowserPort } from './company-native-browser';
import { isCompanyNativeEnrollment } from '../../shared/business/company-native';

const ACCOUNT_SCHEMA = 'agentlas.business.desktop-account.v1';
const AUTH_PARTITION = 'persist:agentlas-auth';
const ACCOUNT_PATH = '/api/business/desktop-account';
const ELIGIBILITY_PATH = '/api/business/eligibility';
const MAX_RESPONSE_BYTES = 256 * 1024;
const LOGIN_TIMEOUT_MS = 180_000;
type BrowserResponse = { status: number; body: unknown };
type OriginalMutation = Readonly<{ kind: 'select' | 'logout'; session: BusinessSession; organizationId: string; idempotencyKey: string }>;

function emptyAccount(): BusinessAccountSnapshot {
  return { session: null, organizations: [], providers: [], adminViews: [], status: 'unknown' };
}
function request<T>(raw: T, keys: readonly string[]): T {
  if (!isBusinessConsoleMetadata(raw) || !businessOnlyKeys(raw, keys)) throw Error('business_request_invalid');
  return freezeBusinessConsoleMetadata(raw);
}
function currentAccount(raw: unknown, now: number): BusinessAccountSnapshot | null {
  if (!isBusinessConsoleMetadata(raw) || !businessOnlyKeys(raw, ['schema', 'account']) || raw.schema !== ACCOUNT_SCHEMA
    || !isBusinessAccountSnapshot(raw.account)) return null;
  const account = raw.account;
  if (account.status !== 'current' || !account.session || Date.parse(account.session.expiresAt) <= now
    || !account.organizations.some(row => row.id === account.session!.organizationId && row.membership === 'active')
    || account.organizations.some(row => row.membership !== 'active')
    || account.providers.some(row => !['disabled', 'stored-unverified', 'unconfigured'].includes(row.state))) return null;
  return freezeBusinessConsoleMetadata(account);
}
function validResponse(raw: unknown): raw is BrowserResponse {
  return isBusinessConsoleMetadata(raw) && businessOnlyKeys(raw, ['status', 'body'])
    && typeof raw.status === 'number' && Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599;
}
function mutationReceipt(raw: unknown): raw is { ok: true; value: unknown; revision: number; receiptId: string; replayed: boolean } {
  return isBusinessConsoleMetadata(raw) && businessOnlyKeys(raw, ['ok', 'value', 'revision', 'receiptId', 'replayed'])
    && raw.ok === true && isBusinessRevision(raw.revision) && isBusinessId(raw.receiptId) && typeof raw.replayed === 'boolean';
}
function rejectedMutation(response: BrowserResponse | null): boolean {
  return !!response && response.status >= 400 && response.status < 500
    && isBusinessConsoleMetadata(response.body) && businessOnlyKeys(response.body, ['ok', 'reason'])
    && response.body.ok === false && isBusinessId(response.body.reason) && response.body.reason !== 'effect_unknown';
}
function sessionKey(session: BusinessSession): string {
  return JSON.stringify([session.deploymentId, session.identityAuthorityId, session.organizationId, session.principalId,
    session.hostId, session.sessionId, session.sessionRevision, session.authEpoch, session.expiresAt]);
}
function mutationKey(kind: OriginalMutation['kind'], session: BusinessSession, organizationId: string): string {
  return JSON.stringify([kind, session, organizationId]);
}

/** Executes only in the owned, unprivileged /business browser context. Cookie,
 * Origin and Sec-Fetch headers are produced by that browser, never supplied by
 * Main or the renderer. The returned value contains bounded metadata only. */
function browserRequestScript(origin: string, path: string, body: { expectedSessionId: string; expectedSessionRevision: number; idempotencyKey: string } | null): string {
  const input = JSON.stringify({ origin, path, body, cap: MAX_RESPONSE_BYTES });
  return `(async () => {
    const input = ${input};
    const exactPage = () => location.origin === input.origin && location.pathname === '/business';
    if (!exactPage()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const init = { method: input.body === null ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal };
      if (input.body !== null) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(input.body); }
      const response = await fetch(input.path, init);
      if (!response.body || !exactPage()) return null;
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > input.cap) { await reader.cancel(); return null; }
        chunks.push(chunk.value);
      }
      if (!exactPage()) return null;
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
    } catch { return null; } finally { clearTimeout(timer); }
  })()`;
}

export interface BusinessShippingConsole extends BusinessRendererBridge {
  readonly account: BusinessAccountPanelPort;
  /** Main-only enrollment port. This property is never exposed by renderer IPC. */
  readonly companyNativeIdentity: CompanyNativeBrowserPort;
  /** Closes display generations and pending login; never retries an uncertain mutation. */
  invalidate(): void;
  dispose(): void;
}

/** Production metadata supplier. Construction/import creates no browser, session,
 * account, native command, authority, network request or background collection.
 * Server-issued browser identity is never rewritten into a native host identity. */
export function createBusinessShippingConsole(): BusinessShippingConsole {
  let browser: BrowserWindow | null = null;
  let browserSession: Session | null = null;
  let loading: Promise<BrowserWindow | null> | null = null;
  let origin: string | null = null;
  let generation = 0;
  let disposed = false;
  let lastAccount: BusinessAccountSnapshot | null = null;
  let lastEligibility: BusinessEligibility | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let eligibilityTimer: ReturnType<typeof setTimeout> | null = null;
  let removeCookieListener: (() => void) | null = null;
  let finishLogin: ((account: BusinessAccountSnapshot) => void) | null = null;
  let login: Promise<BusinessAccountSnapshot> | null = null;
  let organizationMailSelected = false;
  const listeners = new Set<() => void>();
  const closedSessions = new Set<string>();
  const heldMutations = new Map<string, OriginalMutation>();
  // Terminal metadata outlives display invalidation. It never supplies a grant.
  const originalSessions = new Map<string, BusinessSession>();
  const heldSession = (session: BusinessSession): boolean => [...heldMutations.values()].some(value => sameBusinessSession(value.session, session));

  const notify = (): void => { for (const listener of listeners) { try { listener(); } catch { /* Metadata observer only. */ } } };
  const invalidate = (): void => {
    const displayed = lastAccount !== null || lastEligibility !== null;
    generation++;
    organizationMailSelected = false;
    lastAccount = null;
    lastEligibility = null;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    if (eligibilityTimer) clearTimeout(eligibilityTimer);
    eligibilityTimer = null;
    // First hidden navigation has issued no display to revoke. Its internal
    // generation still cancels old reads without invalidating the initial caller.
    if (displayed) notify();
  };
  const exactPage = (window: BrowserWindow): boolean => {
    try {
      if (disposed || window !== browser || window.isDestroyed() || window.webContents.isDestroyed() || !origin) return false;
      const url = new URL(window.webContents.getURL());
      return url.origin === origin && url.pathname === '/business';
    } catch { return false; }
  };
  const installAccount = (value: BusinessAccountSnapshot): BusinessAccountSnapshot => {
    if (!value.session || Date.parse(value.session.expiresAt) <= Date.now() || closedSessions.has(sessionKey(value.session))) return emptyAccount();
    const key = JSON.stringify([value.session.sessionId, value.session.sessionRevision]);
    if (!originalSessions.has(key) && originalSessions.size >= 256) return emptyAccount();
    const original = originalSessions.get(key);
    if (original && !sameBusinessSession(original, value.session)) return emptyAccount();
    originalSessions.set(key, value.session);
    lastAccount = value;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(invalidate, Math.min(2_147_483_647, Math.max(1, Date.parse(value.session.expiresAt) - Date.now())));
    expiryTimer.unref?.();
    return value;
  };
  const ensureBrowser = async (): Promise<BrowserWindow | null> => {
    if (disposed) return null;
    if (browser && !browser.isDestroyed()) return exactPage(browser) ? browser : null;
    if (loading) return loading;
    loading = (async () => {
      try {
        const configured = (require('../auth') as { webBaseUrl(): string }).webBaseUrl();
        const url = new URL(configured);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
        origin = url.origin;
        const electron = require('electron') as typeof import('electron');
        browserSession = electron.session.fromPartition(AUTH_PARTITION);
        const cookieChanged = (_event: unknown, cookie: Pick<Electron.Cookie, 'name' | 'domain'>): void => {
          if (!['agentlas_business_browser', 'agentlas_business_org', 'agentlas_session'].includes(cookie.name)
            || typeof cookie.domain !== 'string' || cookie.domain.replace(/^\./, '') !== url.hostname) return;
          invalidate();
          if (finishLogin && browser && exactPage(browser)) void readAccount().then(value => { if (value.session) finishLogin?.(value); });
        };
        browserSession.cookies.on('changed', cookieChanged);
        removeCookieListener = () => browserSession?.cookies.removeListener('changed', cookieChanged);
        const window = new electron.BrowserWindow({ width: 1080, height: 760, show: false, title: 'Agentlas Business',
          webPreferences: { session: browserSession, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
        browser = window;
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const navigation = (event: Electron.Event, destination: string): void => {
          try { const next = new URL(destination); if (next.protocol !== 'https:' || next.username || next.password) event.preventDefault(); }
          catch { event.preventDefault(); }
          invalidate();
        };
        window.webContents.on('will-navigate', navigation);
        window.webContents.on('will-redirect', navigation);
        window.webContents.on('did-start-navigation', () => invalidate());
        window.webContents.on('did-finish-load', () => {
          invalidate();
          if (finishLogin && exactPage(window)) void readAccount().then(value => { if (value.session) finishLogin?.(value); });
        });
        window.on('closed', () => {
          if (browser === window) browser = null;
          removeCookieListener?.(); removeCookieListener = null;
          invalidate(); finishLogin?.(emptyAccount());
        });
        await window.loadURL(`${origin}/business`);
        return exactPage(window) ? window : null;
      } catch { return null; }
    })();
    try { return await loading; } finally { loading = null; }
  };
  const send = async (path: string, body: { expectedSessionId: string; expectedSessionRevision: number; idempotencyKey: string } | null): Promise<BrowserResponse | null> => {
    const window = await ensureBrowser();
    if (!window || !origin || !exactPage(window) || body === null && path !== ACCOUNT_PATH && path !== ELIGIBILITY_PATH
      || body !== null && !/^\/api\/business\/organizations\/[A-Za-z0-9._:%-]+\/(select|logout)$/.test(path)) return null;
    try {
      const raw: unknown = await window.webContents.executeJavaScript(browserRequestScript(origin, path, body), false);
      return exactPage(window) && validResponse(raw) ? freezeBusinessConsoleMetadata(raw) : null;
    } catch { return null; }
  };
  async function readAccount(): Promise<BusinessAccountSnapshot> {
    const window = await ensureBrowser();
    if (!window) { invalidate(); return emptyAccount(); }
    const before = generation;
    const response = await send(ACCOUNT_PATH, null);
    const value = response?.status === 200 ? currentAccount(response.body, Date.now()) : null;
    if (!value || before !== generation || !exactPage(window)) return emptyAccount();
    return installAccount(value);
  }
  const currentFor = async (sessionId: string, revision: number, authEpoch?: number): Promise<BusinessAccountSnapshot> => {
    const current = await readAccount();
    if (!current.session || current.session.sessionId !== sessionId || current.session.sessionRevision !== revision
      || authEpoch !== undefined && current.session.authEpoch !== authEpoch)
      throw Error('business_current_session_unavailable');
    return current;
  };
  const mailSession = (): BusinessSession | null => {
    const session = lastAccount?.session;
    return organizationMailSelected && !disposed && session && Date.parse(session.expiresAt) > Date.now()
      && !closedSessions.has(sessionKey(session)) && !heldSession(session) ? session : null;
  };
  const organizationMailTransport: OrganizationMailTransport = Object.freeze({
    current() {
      const session = mailSession();
      return session ? { key: sessionKey(session), organizationId: session.organizationId,
        principalId: session.principalId, expiresAt: session.expiresAt } : null;
    },
    async request(raw: Parameters<OrganizationMailTransport['request']>[0]) {
      const input = organizationMailBrowserRequest(raw), original = mailSession();
      if (!input || !original) return null;
      const stamp = generation, current = await readAccount(), window = browser;
      if (stamp !== generation || !window || !origin || !current.session || !sameBusinessSession(original, current.session)
        || !mailSession() || !exactPage(window)) return null;
      try {
        const value: unknown = await window.webContents.executeJavaScript(organizationMailBrowserScript(origin, original, input), false);
        const fresh = mailSession();
        return stamp === generation && fresh && sameBusinessSession(original, fresh) && exactPage(window)
          && organizationMailBrowserResponse(value) ? value : null;
      } catch { return null; }
    },
  });
  const selectOrganizationMail = (): void => {
    organizationMailSelected = true;
    bindAgentMailOrganizationTransport(organizationMailTransport);
  };
  const companyNativeIdentity: CompanyNativeBrowserPort = Object.freeze({
    async currentSession() { return (await readAccount()).session; },
    async approve(raw: Parameters<CompanyNativeBrowserPort['approve']>[0], expected: BusinessSession) {
      if (!isCompanyNativeEnrollment(raw) || !isBusinessSession(expected)) return null;
      const input = structuredClone(raw), original = structuredClone(expected), stamp = generation;
      const current = await readAccount(), window = browser;
      if (stamp !== generation || !current.session || !sameBusinessSession(original, current.session) || !window || !origin || !exactPage(window)) return null;
      try {
        const value: unknown = await window.webContents.executeJavaScript(companyNativeEnrollmentScript(origin, input, original), false);
        return stamp === generation && lastAccount?.session && sameBusinessSession(original, lastAccount.session)
          && exactPage(window) && companyNativeEnrollmentResult(value) ? Object.freeze({ ...value }) : null;
      } catch { return null; }
    },
  });
  const showDashboard = async (view: BusinessDashboardView): Promise<void> => {
    const window = await ensureBrowser();
    if (!window || !origin) throw Error('business_browser_unavailable');
    const url = new URL(window.webContents.getURL());
    const dashboardView = view === 'history' || view === 'learning' ? 'personal' : 'organization';
    if (url.searchParams.get('section') !== view || url.searchParams.get('view') !== dashboardView)
      await window.loadURL(`${origin}/business?view=${dashboardView}&section=${encodeURIComponent(view)}`);
    if (!exactPage(window)) throw Error('business_browser_unavailable');
    window.show(); window.focus();
  };
  const signIn = async (): Promise<BusinessAccountSnapshot> => {
    if (disposed) return emptyAccount();
    if (login) return login;
    login = (async () => {
      await showDashboard('overview');
      const current = await readAccount();
      if (current.session) { selectOrganizationMail(); return current; }
      if (disposed || !browser || browser.isDestroyed()) return emptyAccount();
      return await new Promise<BusinessAccountSnapshot>(resolve => {
        let settled = false;
        const timer = setTimeout(() => finish(emptyAccount()), LOGIN_TIMEOUT_MS);
        timer.unref?.();
        const finish = (value: BusinessAccountSnapshot): void => {
          if (settled) return; settled = true; clearTimeout(timer); finishLogin = null;
          if (value.session && Date.parse(value.session.expiresAt) > Date.now()) { selectOrganizationMail(); resolve(value); }
          else resolve(emptyAccount());
        };
        finishLogin = finish;
      });
    })();
    try { return await login; } catch { return emptyAccount(); } finally { login = null; }
  };
  const subscribe = (listener: () => void): (() => void) => { if (typeof listener !== 'function') throw Error('business_listener_invalid'); listeners.add(listener); return () => { listeners.delete(listener); }; };
  const account: BusinessAccountPanelPort = Object.freeze<BusinessAccountPanelPort>({
    read: readAccount,
    subscribeInvalidation: subscribe,
    signIn,
    async joinOrganization(raw) {
      const input = request(raw, ['organizationId', 'expectedSessionId', 'expectedSessionRevision']);
      if (!isBusinessId(input.organizationId) || !isBusinessId(input.expectedSessionId) || !isBusinessRevision(input.expectedSessionRevision)) throw Error('business_request_invalid');
      const current = await currentFor(input.expectedSessionId, input.expectedSessionRevision);
      // This metadata endpoint lists active memberships only. Joining is handled
      // by the existing SSO form; no invitation or membership is invented here.
      if (!current.organizations.some(row => row.id === input.organizationId && row.membership === 'invited')) throw Error('business_join_requires_sso');
      return signIn();
    },
    async selectOrganization(raw) {
      const input = request(raw, ['organizationId', 'expectedSessionId', 'expectedSessionRevision', 'expectedAuthEpoch']);
      if (!isBusinessId(input.organizationId) || !isBusinessId(input.expectedSessionId) || ![input.expectedSessionRevision, input.expectedAuthEpoch].every(isBusinessRevision)) throw Error('business_request_invalid');
      const current = await currentFor(input.expectedSessionId, input.expectedSessionRevision, input.expectedAuthEpoch), originalSession = current.session!;
      if (!current.organizations.some(row => row.id === input.organizationId && row.membership === 'active')) throw Error('business_organization_unavailable');
      if (input.organizationId === originalSession.organizationId) { selectOrganizationMail(); return current; }
      const key = mutationKey('select', originalSession, input.organizationId);
      if (heldMutations.has(key) || heldSession(originalSession) || heldMutations.size >= 256
        || !lastAccount?.session || !sameBusinessSession(lastAccount.session, originalSession)) throw Error('business_original_mutation_unknown');
      const original = freezeBusinessConsoleMetadata({ kind: 'select' as const, session: originalSession, organizationId: input.organizationId, idempotencyKey: randomUUID() });
      heldMutations.set(key, original); invalidate();
      const response = await send(`/api/business/organizations/${encodeURIComponent(original.organizationId)}/select`, {
        expectedSessionId: original.session.sessionId, expectedSessionRevision: original.session.sessionRevision, idempotencyKey: original.idempotencyKey });
      if (response?.status !== 200 || !mutationReceipt(response.body) || !isBusinessSession(response.body.value)) {
        if (rejectedMutation(response)) { heldMutations.delete(key); throw Error('business_original_mutation_rejected'); }
        throw Error('business_original_mutation_unknown');
      }
      const selected = response.body.value;
      if (selected.organizationId !== original.organizationId || selected.principalId !== original.session.principalId
        || selected.deploymentId !== original.session.deploymentId || selected.hostId !== original.session.hostId
        || selected.authEpoch !== original.session.authEpoch || selected.sessionRevision <= original.session.sessionRevision
        || response.body.revision !== selected.sessionRevision || Date.parse(selected.expiresAt) <= Date.now()) throw Error('business_original_mutation_unknown');
      const fresh = await readAccount();
      if (!fresh.session || !sameBusinessSession(fresh.session, selected) || Date.parse(fresh.session.expiresAt) <= Date.now()) throw Error('business_original_mutation_unknown');
      closedSessions.add(sessionKey(original.session)); heldMutations.delete(key);
      selectOrganizationMail();
      return fresh;
    },
    async logout(raw) {
      const input = request(raw, ['sessionId', 'expectedSessionRevision']);
      if (!isBusinessId(input.sessionId) || !isBusinessRevision(input.expectedSessionRevision)) throw Error('business_request_invalid');
      // Keep the exact last authenticated original for terminal logout even when
      // the display expires. The server still validates its current signed session.
      const originalSession = originalSessions.get(JSON.stringify([input.sessionId, input.expectedSessionRevision]));
      if (!originalSession || originalSession.sessionId !== input.sessionId || originalSession.sessionRevision !== input.expectedSessionRevision)
        return { snapshot: emptyAccount(), remote: 'unknown' as const };
      const key = mutationKey('logout', originalSession, originalSession.organizationId);
      // An unrelated pending selection cannot prevent exact terminal logout.
      // Its original request remains held; the server fences this original
      // session/revision independently and never replays the uncertain selection.
      if (heldMutations.has(key)) return { snapshot: emptyAccount(), remote: 'unknown' as const };
      const original = freezeBusinessConsoleMetadata({ kind: 'logout' as const, session: originalSession,
        organizationId: originalSession.organizationId, idempotencyKey: randomUUID() });
      heldMutations.set(key, original); closedSessions.add(sessionKey(original.session)); invalidate();
      const response = await send(`/api/business/organizations/${encodeURIComponent(original.organizationId)}/logout`, {
        expectedSessionId: original.session.sessionId, expectedSessionRevision: original.session.sessionRevision, idempotencyKey: original.idempotencyKey });
      if (response?.status === 200 && mutationReceipt(response.body)
        && businessOnlyKeys(response.body.value, ['revokedSessionId']) && response.body.value.revokedSessionId === original.session.sessionId
        && response.body.revision === original.session.sessionRevision + 1) {
        heldMutations.delete(key); return { snapshot: emptyAccount(), remote: 'confirmed' as const };
      }
      return { snapshot: emptyAccount(), remote: 'unknown' as const };
    },
    async openAdmin(raw) {
      const input = request(raw, ['organizationId', 'view', 'expectedSessionId', 'expectedSessionRevision']);
      if (!isBusinessId(input.organizationId) || !isBusinessId(input.expectedSessionId) || !isBusinessRevision(input.expectedSessionRevision)
        || !['members', 'providers', 'tools', 'audit'].includes(input.view)) throw Error('business_request_invalid');
      const current = await currentFor(input.expectedSessionId, input.expectedSessionRevision);
      if (current.session!.organizationId !== input.organizationId || !current.adminViews.includes(input.view)) throw Error('business_admin_unavailable');
      await showDashboard(input.view === 'tools' ? 'catalog' : input.view);
    },
    async selectPersonal() { organizationMailSelected = false; bindAgentMailOrganizationTransport(null); invalidate(); browser?.hide(); },
  });
  return Object.freeze({
    account, companyNativeIdentity, history: null, learning: null, organizationExecution: null,
    async readEligibility(): Promise<BusinessEligibility | null> {
      const window = await ensureBrowser();
      if (!window) { invalidate(); return null; }
      const before = generation;
      const response = await send(ELIGIBILITY_PATH, null);
      if (before !== generation || !exactPage(window)) return null;
      if (response?.status !== 200 || !isBusinessEligibility(response.body)) { invalidate(); return null; }
      const exact = freezeBusinessConsoleMetadata(response.body);
      if (!isBusinessEligibility(exact) || before !== generation) return null;
      lastEligibility = exact;
      if (eligibilityTimer) clearTimeout(eligibilityTimer);
      eligibilityTimer = setTimeout(invalidate, Math.max(1, Date.parse(exact.expiresAt) - Date.now()));
      eligibilityTimer.unref?.();
      return exact;
    },
    async snapshot(): Promise<BusinessRendererSnapshot> {
      const current = await readAccount();
      return freezeBusinessConsoleMetadata({ schema: BUSINESS_DESKTOP_CONSOLE_SCHEMA, context: null,
        organizationSession: current.session && Date.parse(current.session.expiresAt) > Date.now() ? current.session : null,
        availability: { account: true, history: false, learning: false, organizationExecution: false } });
    },
    async openDashboard(raw: { view: BusinessDashboardView }) {
      const input = request(raw, ['view']);
      if (!BUSINESS_DASHBOARD_VIEWS.includes(input.view)) throw Error('business_request_invalid');
      await showDashboard(input.view);
    },
    onInvalidated: subscribe,
    invalidate,
    dispose() {
      if (disposed) return; disposed = true; invalidate(); finishLogin?.(emptyAccount());
      removeCookieListener?.(); removeCookieListener = null;
      browser?.destroy(); browser = null; listeners.clear();
    },
  });
}
