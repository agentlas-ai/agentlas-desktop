import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessSession, sameBusinessSession, type BusinessSession } from '../../shared/business/context';
import { BUSINESS_DESKTOP_CONSOLE_SCHEMA, BUSINESS_DASHBOARD_VIEWS, businessReviewMatches, businessReviewReady,
  captureBusinessAccountPanelPort, captureBusinessConsoleMethod, captureBusinessLearningPanelPort, freezeBusinessConsoleMetadata,
  isBusinessAccountSnapshot, isBusinessConsoleMetadata, isBusinessLearningSnapshot, isBusinessRendererContext, isBusinessRendererSnapshot,
  type BusinessAccountPanelPort, type BusinessAccountSnapshot, type BusinessDashboardView, type BusinessLearningCandidateAction,
  type BusinessLearningCandidateView, type BusinessLearningPanelPort, type BusinessLearningReviewView, type BusinessLearningSnapshot,
  type BusinessRendererBridge, type BusinessRendererSnapshot } from '../../shared/business/console-contracts';
import { BUSINESS_HISTORY_DELETE_PROTOCOL, sameBusinessHistoryViewContext, type BusinessHistoryPanelPort,
  type BusinessHistoryViewBinding, type BusinessHistoryViewContext } from '../../shared/business/history-view';
import type { BusinessOrganizationExecutionPanelPort } from '../../shared/business/organization-execution';
import { businessNativeStartupMatchesShared, type BusinessNativeStartupBindings, type BusinessNativeStartupSharedPorts } from './native-startup';
import { createBusinessHistoryViewAdapter, isBusinessHistoryDeleteRequest, type BusinessHistoryViewAdapterPorts } from './history-view-adapter';
import { createBusinessOrganizationExecutionAdapter, type BusinessOrganizationExecutionOwner } from './organization-execution-adapter';

/** Existing Main lifetime/current-domain contract. It supplies no action grant.
 * For One's installed owner this consumes originalBusiness and its ready/current
 * lifetime; no duplicate startup, native registration or authentication is made. */
export interface BusinessConsoleLifetimeOwner {
  current(): boolean;
  subscribeInvalidation?(listener: () => void): () => void;
}
export interface BusinessConsoleOriginalLogout {
  readonly session: BusinessSession;
  readonly selector: Parameters<BusinessAccountPanelPort['logout']>[0];
}
export interface BusinessConsoleOriginalStop {
  readonly context: BusinessHistoryViewContext;
  readonly selector: Parameters<BusinessLearningPanelPort['stop']>[0];
}
export interface BusinessConsoleOriginalCollectionPause {
  readonly context: BusinessHistoryViewContext;
  readonly selector: Parameters<BusinessLearningPanelPort['pauseCollection']>[0];
}
export interface BusinessConsoleAccountOwner {
  readonly port: BusinessAccountPanelPort | null;
  authenticatedSession(): BusinessSession | null;
  /** Actual current account/provider metadata read authority, not dispatch permission. */
  currentSnapshot(session: BusinessSession | null, snapshot: Readonly<BusinessAccountSnapshot>): boolean;
  /** The original effect owner must bind this exact caller/selector to its current
   * logout authority in the SAME effect serialization. No metadata grant is made. */
  originalLogout(input: Readonly<BusinessConsoleOriginalLogout>): Promise<Awaited<ReturnType<BusinessAccountPanelPort['logout']>>>;
  /** Original logout receipt verification, separate from dispatch authority. */
  currentLogoutResult(input: Readonly<BusinessConsoleOriginalLogout>,
    result: Readonly<Awaited<ReturnType<BusinessAccountPanelPort['logout']>>>): boolean;
}
export interface BusinessConsoleLearningOwner {
  readonly port: BusinessLearningPanelPort | null;
  authenticatedSession(): BusinessSession | null;
  currentSnapshot(session: BusinessSession, snapshot: Readonly<BusinessLearningSnapshot>): boolean;
  /** Separate CURRENT exact-diff result read authority. Review DTO booleans are not proof. */
  currentReview(session: BusinessSession, input: Readonly<BusinessLearningCandidateAction>, review: Readonly<BusinessLearningReviewView>): boolean;
  /** These exact-original callbacks belong to the existing effect owner. It must
   * validate registered caller/scope/work and CURRENT terminal authority within
   * the effect serialization; the generic mutable-scope panel port is not used. */
  originalCollectionPause(input: Readonly<BusinessConsoleOriginalCollectionPause>): Promise<BusinessLearningSnapshot>;
  originalStop(input: Readonly<BusinessConsoleOriginalStop>): Promise<Awaited<ReturnType<BusinessLearningPanelPort['stop']>>>;
  currentStopResult(input: Readonly<BusinessConsoleOriginalStop>,
    result: Readonly<Awaited<ReturnType<BusinessLearningPanelPort['stop']>>>): boolean;
}
export interface BusinessConsoleCompositionInput {
  readonly shared: Readonly<BusinessNativeStartupSharedPorts>;
  readonly native: BusinessNativeStartupBindings | null;
  readonly lifetime: BusinessConsoleLifetimeOwner | null;
  readonly history: Omit<BusinessHistoryViewAdapterPorts, 'authority'> | null;
  readonly account: BusinessConsoleAccountOwner | null;
  readonly learning: BusinessConsoleLearningOwner | null;
  readonly organizationExecution: BusinessOrganizationExecutionOwner | null;
  readonly dashboard?: { openDashboard(input: { view: BusinessDashboardView }): Promise<void> } | null;
}
const emptyAccount = (): BusinessAccountSnapshot => ({ session: null, organizations: [], providers: [], adminViews: [], status: 'unknown' });
const emptyLearning = (): BusinessLearningSnapshot => ({ context: null, scopeLabel: '', status: 'unknown', sources: [], candidates: [] });
function field(owner: unknown, key: string): unknown {
  try { return owner && typeof owner === 'object' ? Object.getOwnPropertyDescriptor(owner, key)?.value : undefined; } catch { return undefined; }
}
function capture<T>(owner: unknown, required: readonly string[], optional: readonly string[] = []): T | null {
  const result: Record<string, unknown> = {};
  for (const name of required) { const method = captureBusinessConsoleMethod(owner, name); if (!method) return null; result[name] = method; }
  for (const name of optional) { const method = captureBusinessConsoleMethod(owner, name); if (method) result[name] = method; }
  return Object.freeze(result) as T;
}
function metadataKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? '[' + value.map(metadataKey).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + metadataKey((value as Record<string, unknown>)[key])).join(',') + '}';
}
function captureHistory(input: Omit<BusinessHistoryViewAdapterPorts, 'authority'> | null, authority: BusinessNativeStartupBindings['data'], shared: Readonly<BusinessNativeStartupSharedPorts>): BusinessHistoryViewAdapterPorts {
  const privacyOwner = field(input, 'privacyDelete');
  const privacyMethods = capture<NonNullable<BusinessHistoryViewAdapterPorts['privacyDelete']>>(privacyOwner,
    ['currentContext', 'prepare', 'stillCurrent', 'commit', 'receipt']);
  const privacyDelete = privacyMethods && field(privacyOwner, 'protocol') === BUSINESS_HISTORY_DELETE_PROTOCOL
    && field(privacyOwner, 'authority') === shared.authority && shared.authority
    ? Object.freeze({ ...privacyMethods, protocol: BUSINESS_HISTORY_DELETE_PROTOCOL, authority: shared.authority }) : null;
  return Object.freeze({ authority,
    owner: capture<BusinessHistoryViewAdapterPorts['owner']>(field(input, 'owner'), ['current', 'stillCurrent'], ['subscribeInvalidation']),
    personalHistory: capture<BusinessHistoryViewAdapterPorts['personalHistory']>(field(input, 'personalHistory'), ['get'], ['prepareDraft']),
    organizationHistory: capture<BusinessHistoryViewAdapterPorts['organizationHistory']>(field(input, 'organizationHistory'), ['read']),
    one: capture<BusinessHistoryViewAdapterPorts['one']>(field(input, 'one'), ['bootstrap', 'historySnapshot']),
    controls: capture<BusinessHistoryViewAdapterPorts['controls']>(field(input, 'controls'), ['pause']), privacyDelete,
    review: capture<BusinessHistoryViewAdapterPorts['review']>(field(input, 'review'), ['open']),
    navigation: capture<BusinessHistoryViewAdapterPorts['navigation']>(field(input, 'navigation'), [], ['openPage', 'openCandidate']),
  });
}
/** Callable production consumer composition only. The genuine sole Main owner
 * must supply and expose the namespace through its existing ingress/preload.
 * Construction performs ZERO port calls, subscriptions, network, DB or effects. */
export function createBusinessConsoleComposition(input: BusinessConsoleCompositionInput, now: () => number = Date.now) {
  const suppliedShared = field(input, 'shared');
  const shared = Object.freeze({ sessions: field(suppliedShared, 'sessions') as BusinessNativeStartupSharedPorts['sessions'],
    identity: field(suppliedShared, 'identity') as BusinessNativeStartupSharedPorts['identity'],
    authority: field(suppliedShared, 'authority') as BusinessNativeStartupSharedPorts['authority'],
    registry: field(suppliedShared, 'registry') as BusinessNativeStartupSharedPorts['registry'] });
  const native = field(input, 'native') as BusinessNativeStartupBindings | null;
  const lifetimeOwner = field(input, 'lifetime'), accountOwner = field(input, 'account'), learningOwner = field(input, 'learning');
  const provenance = !!native && businessNativeStartupMatchesShared(native, shared);
  const identity = captureBusinessConsoleMethod<NonNullable<typeof shared.identity>['current']>(shared.identity, 'current');
  const sessionCurrent = captureBusinessConsoleMethod<typeof shared.sessions.current>(shared.sessions, 'current');
  const lifetimeCurrent = captureBusinessConsoleMethod<BusinessConsoleLifetimeOwner['current']>(lifetimeOwner, 'current');
  const lifetimeSubscribe = captureBusinessConsoleMethod<NonNullable<BusinessConsoleLifetimeOwner['subscribeInvalidation']>>(lifetimeOwner, 'subscribeInvalidation');
  const nativeInvalidate = provenance ? captureBusinessConsoleMethod<BusinessNativeStartupBindings['invalidate']>(native, 'invalidate') : null;
  const accountPort = captureBusinessAccountPanelPort(field(accountOwner, 'port'));
  const accountIngress = captureBusinessConsoleMethod<BusinessConsoleAccountOwner['authenticatedSession']>(accountOwner, 'authenticatedSession');
  const accountResult = captureBusinessConsoleMethod<BusinessConsoleAccountOwner['currentSnapshot']>(accountOwner, 'currentSnapshot');
  const originalLogout = captureBusinessConsoleMethod<BusinessConsoleAccountOwner['originalLogout']>(accountOwner, 'originalLogout');
  const logoutResult = captureBusinessConsoleMethod<BusinessConsoleAccountOwner['currentLogoutResult']>(accountOwner, 'currentLogoutResult');
  const learningPort = captureBusinessLearningPanelPort(field(learningOwner, 'port'));
  const learningIngress = captureBusinessConsoleMethod<BusinessConsoleLearningOwner['authenticatedSession']>(learningOwner, 'authenticatedSession');
  const learningResult = captureBusinessConsoleMethod<BusinessConsoleLearningOwner['currentSnapshot']>(learningOwner, 'currentSnapshot');
  const reviewResult = captureBusinessConsoleMethod<BusinessConsoleLearningOwner['currentReview']>(learningOwner, 'currentReview');
  const originalCollectionPause = captureBusinessConsoleMethod<BusinessConsoleLearningOwner['originalCollectionPause']>(learningOwner, 'originalCollectionPause');
  const originalStop = captureBusinessConsoleMethod<BusinessConsoleLearningOwner['originalStop']>(learningOwner, 'originalStop');
  const stopResult = captureBusinessConsoleMethod<BusinessConsoleLearningOwner['currentStopResult']>(learningOwner, 'currentStopResult');
  const dashboard = captureBusinessConsoleMethod<NonNullable<BusinessConsoleCompositionInput['dashboard']>['openDashboard']>(field(input, 'dashboard'), 'openDashboard');
  const historyPorts = provenance ? captureHistory(field(input, 'history') as BusinessConsoleCompositionInput['history'], native!.data, shared) : null;
  const historyAdapter = historyPorts ? createBusinessHistoryViewAdapter(historyPorts, now) : null;
  const organizationAdapter = createBusinessOrganizationExecutionAdapter({ identity: shared.identity, owner: provenance ? field(input, 'organizationExecution') as BusinessOrganizationExecutionOwner : null }, now);
  const listeners = new Set<() => void>();
  const closedContexts = new Set<string>(), closedAccounts = new Set<string>(), loggedOut = new Set<string>();
  const observedSessions = new Set<string>();
  const contexts = new Map<string, BusinessHistoryViewContext>(), logoutTargets = new Map<string, BusinessSession | null>();
  const collectionTargets = new Map<string, Readonly<BusinessConsoleOriginalCollectionPause> | null>();
  const stopTargets = new Map<string, Readonly<BusinessConsoleOriginalStop> | null>();
  const attemptedLearning = new Set<string>();
  let generation = 0, cleanupUnknown = false, invalidating = false, lastContext: BusinessHistoryViewContext | null = null;
  let lastSession: BusinessSession | null = null;
  let lastInvalidatedSessionKey: string | null = null;
  let learningSnapshot: BusinessLearningSnapshot | null = null, review: BusinessLearningReviewView | null = null;
  let subscriptions: Array<() => void> | null = null;
  // Expiry extensions are not new identity/context generations and cannot reopen
  // an invalidated positive display. Current reads still check the exact expiry.
  const sessionKey = (session: BusinessSession | null) => session === null ? 'null' : metadataKey({
    principalId: session.principalId, sessionId: session.sessionId, sessionRevision: session.sessionRevision,
    authEpoch: session.authEpoch, deploymentId: session.deploymentId, organizationId: session.organizationId,
    identityAuthorityId: session.identityAuthorityId, hostId: session.hostId });
  const authKey = (session: BusinessSession) => JSON.stringify([session.deploymentId, session.identityAuthorityId, session.principalId, session.hostId, session.sessionId, session.authEpoch]);
  const contextKey = (context: BusinessHistoryViewContext) => metadataKey({ session: sessionKey(context.session), scope: context.scope,
    target: context.target, bindingKey: context.bindingKey, revision: context.revision,
    policyRevision: context.policyRevision, nativePolicyRevision: context.nativePolicyRevision });
  const selectorKey = (input: unknown) => metadataKey(input);
  const baseBlocker = () => !provenance ? 'business_console_original_startup_required'
    : !identity || !sessionCurrent || !lifetimeCurrent || !shared.authority || !shared.registry ? 'business_console_owner_unbound'
      : cleanupUnknown ? 'business_console_cleanup_unconfirmed' : null;
  function domainCurrent(): boolean { try { return !baseBlocker() && lifetimeCurrent!() === true; } catch { return false; } }
  function exactCurrent(session: BusinessSession | null, stamp: number): boolean {
    try {
      if (!domainCurrent() || stamp !== generation) return false;
      const value = identity!();
      return session === null ? value === null : isBusinessConsoleMetadata(value) && isBusinessSession(value) && sameBusinessSession(value, session)
        && Date.parse(session.expiresAt) > now() && !loggedOut.has(authKey(session));
    } catch { return false; }
  }
  async function actor(stamp: number): Promise<BusinessSession | null> {
    if (!domainCurrent()) throw Error('business_console_current_required');
    const raw = await sessionCurrent!();
    if (!isBusinessConsoleMetadata(raw) || !(raw === null || isBusinessSession(raw))) throw Error('business_console_current_required');
    const session = freezeBusinessConsoleMetadata(raw);
    if (!exactCurrent(session, stamp)) throw Error('business_console_current_required');
    return session;
  }
  async function stillActor(session: BusinessSession | null, stamp: number): Promise<boolean> {
    try { const value = await actor(stamp); return value === null || session === null ? value === session : sameBusinessSession(value, session); } catch { return false; }
  }
  function ingressCurrent(ingress: (() => BusinessSession | null) | null, session: BusinessSession | null): boolean {
    try { const current = ingress?.(); return session === null ? current === null : isBusinessConsoleMetadata(current) && isBusinessSession(current) && sameBusinessSession(current, session); } catch { return false; }
  }
  function rememberLogout(session: BusinessSession): void {
    const observedKey = sessionKey(session);
    if (observedSessions.size >= 256 && !observedSessions.has(observedKey)) throw Error('business_console_metadata_limit');
    observedSessions.add(observedKey);
    lastSession = session;
    const key = selectorKey({ sessionId: session.sessionId, expectedSessionRevision: session.sessionRevision });
    const original = logoutTargets.get(key);
    if (logoutTargets.size >= 256 && !logoutTargets.has(key)) throw Error('business_console_metadata_limit');
    if (!logoutTargets.has(key)) logoutTargets.set(key, session);
    else if (original && sessionKey(original) !== sessionKey(session)) logoutTargets.set(key, null);
  }
  function rememberTerminal<T extends { readonly context: BusinessHistoryViewContext; readonly selector: unknown }>(targets: Map<string, Readonly<T> | null>, value: T): void {
    const key = selectorKey(value.selector), original = targets.get(key);
    if (targets.size >= 256 && !targets.has(key)) throw Error('business_console_metadata_limit');
    if (!targets.has(key)) targets.set(key, freezeBusinessConsoleMetadata(value));
    // A selector-only renderer contract cannot distinguish two original scopes.
    // Preserve the read view, but permanently close that ambiguous control key.
    else if (original && contextKey(original.context) !== contextKey(value.context)) targets.set(key, null);
  }
  function terminalIdentityConflict(original: BusinessSession): boolean {
    // This is a negative cross-identity check only, never terminal permission.
    // If the identity service is unavailable, the exact original effect-owner
    // callback still decides current authority in its own serialization.
    try { const value = identity?.(); return value !== null && value !== undefined
      && (!isBusinessConsoleMetadata(value) || !isBusinessSession(value) || sessionKey(value) !== sessionKey(original)); } catch { return false; }
  }
  function rememberContext(context: BusinessHistoryViewContext): void {
    const key = contextKey(context);
    if (contexts.size >= 256 && !contexts.has(key)) throw Error('business_console_metadata_limit');
    contexts.set(key, context); lastContext = context;
    rememberLogout(context.session);
  }
  async function contextCurrent(session: BusinessSession, stamp: number): Promise<BusinessHistoryViewContext | null> {
    if (!historyPorts || !exactCurrent(session, stamp)) return null;
    // A previously observed older session generation cannot be reopened by a
    // different History revision. Only the last current generation may obtain
    // a freshly current context; a genuine new session has an unseen exact key.
    const currentSessionKey = sessionKey(session);
    if (closedAccounts.has(currentSessionKey) && currentSessionKey !== lastInvalidatedSessionKey) return null;
    let context: BusinessHistoryViewContext | null = null;
    try {
      const raw = await historyPorts.owner?.current();
      if (raw && isBusinessConsoleMetadata(raw) && isBusinessRendererContext(raw.context, now())) {
        const binding = freezeBusinessConsoleMetadata(raw) as BusinessHistoryViewBinding;
        if (await historyPorts.owner!.stillCurrent(binding) === true) context = binding.context;
      }
      // Privacy deletion has a genuine independent current context. A revoked
      // source-read grant must not be converted into permission to collect, nor
      // prevent the privacy owner's separate history.delete path.
      if (!context && historyPorts.privacyDelete) {
        const raw = await historyPorts.privacyDelete.currentContext();
        if (isBusinessRendererContext(raw, now()) && isBusinessConsoleMetadata(raw)) context = freezeBusinessConsoleMetadata(raw);
      }
      if (!context || !sameBusinessSession(context.session, session) || closedContexts.has(contextKey(context))
        || !await stillActor(session, stamp) || !exactCurrent(session, stamp)) return null;
      return context;
    } catch { return null; }
  }
  async function requireContext(expected?: BusinessHistoryViewContext): Promise<{ session: BusinessSession; context: BusinessHistoryViewContext; stamp: number }> {
    const stamp = generation, session = await actor(stamp);
    if (!session) throw Error('business_console_current_required');
    const context = await contextCurrent(session, stamp);
    if (!context || expected && !sameBusinessHistoryViewContext(context, expected)) throw Error('business_console_context_changed');
    rememberContext(context); return { session, context, stamp };
  }
  async function stillContext(before: Awaited<ReturnType<typeof requireContext>>): Promise<boolean> {
    const current = await contextCurrent(before.session, before.stamp);
    return !!current && sameBusinessHistoryViewContext(current, before.context) && exactCurrent(before.session, before.stamp);
  }
  const configuredAccount = () => !!accountPort && !!accountIngress && !!accountResult && !!originalLogout && !!logoutResult;
  const configuredLearning = () => !!learningPort && !!learningIngress && !!learningResult && !!reviewResult
    && !!originalCollectionPause && !!originalStop && !!stopResult;
  function invalidate(): void {
    generation++;
    for (const observed of contexts.keys()) closedContexts.add(observed);
    for (const observed of observedSessions) closedAccounts.add(observed);
    lastInvalidatedSessionKey = lastSession ? sessionKey(lastSession) : null;
    learningSnapshot = null; review = null;
    if (invalidating) return;
    invalidating = true;
    try {
      // Always close BOTH native families and org displays, even when authority,
      // session or another cleanup is unavailable. Original receipt metadata stays.
      for (const close of [nativeInvalidate, organizationAdapter.invalidate]) try { close?.(); } catch { cleanupUnknown = true; }
      for (const listener of [...listeners]) try { listener(); } catch { /* Close each display independently. */ }
    } finally { invalidating = false; }
    if (cleanupUnknown) throw Error('business_console_cleanup_unconfirmed');
  }
  function displayInvalidate(): void { try { invalidate(); } catch { /* Sticky blocker remains observable. */ } }
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!subscriptions) {
      subscriptions = [];
      for (const fn of [lifetimeSubscribe, historyAdapter?.subscribeInvalidation, accountPort?.subscribeInvalidation,
        learningPort?.subscribeInvalidation, organizationAdapter.subscribeInvalidation]) if (fn) {
        try { const off = fn(displayInvalidate); if (typeof off === 'function') subscriptions.push(off); else displayInvalidate(); }
        catch { displayInvalidate(); }
      }
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size && subscriptions) { const off = subscriptions; subscriptions = null; for (const close of off) try { close(); } catch { /* No grant or effect. */ } }
    };
  }
  async function snapshot(): Promise<BusinessRendererSnapshot> {
    const closed = (): BusinessRendererSnapshot => freezeBusinessConsoleMetadata({ schema: BUSINESS_DESKTOP_CONSOLE_SCHEMA, context: null,
      organizationSession: null, availability: { account: false, history: false, learning: false, organizationExecution: false } });
    try {
      const stamp = generation, session = await actor(stamp);
      const context = session ? await contextCurrent(session, stamp) : null;
      if (!await stillActor(session, stamp)) throw Error('business_console_current_required');
      // A failed/closed refresh of a known current display must reject, so the
      // existing renderer retains only its original terminal/receipt metadata.
      // Publishing a fresh neutral binding would replace those original ports.
      if (session && (!context && lastContext && sessionKey(lastContext.session) === sessionKey(session)
        || !context && closedAccounts.has(sessionKey(session)))) throw Error('business_console_context_changed');
      if (context) { rememberContext(context); closedAccounts.delete(sessionKey(session)); }
      if (session) rememberLogout(session);
      const value = freezeBusinessConsoleMetadata({ schema: BUSINESS_DESKTOP_CONSOLE_SCHEMA, context,
        organizationSession: session, availability: {
          account: configuredAccount() && ingressCurrent(accountIngress, session) && !closedAccounts.has(sessionKey(session)),
          history: !!context && !!historyAdapter,
          learning: !!context && configuredLearning() && ingressCurrent(learningIngress, session),
          organizationExecution: !!session && organizationAdapter.blocker() === null,
        } });
      if (!isBusinessRendererSnapshot(value, now()) || !exactCurrent(session, stamp)) throw Error('business_console_current_required');
      return value;
    } catch {
      if (lastSession) throw Error('business_console_current_required');
      return closed();
    }
  }
  async function accountRead(): Promise<BusinessAccountSnapshot> {
    const stamp = generation, session = await actor(stamp);
    if (!configuredAccount() || !ingressCurrent(accountIngress, session) || closedAccounts.has(sessionKey(session))) throw Error('business_console_account_unavailable');
    const raw = await accountPort!.read();
    if (!isBusinessConsoleMetadata(raw) || !isBusinessAccountSnapshot(raw)) throw Error('business_console_account_unavailable');
    const result = freezeBusinessConsoleMetadata(raw);
    if (result.session === null ? session !== null || result.organizations.length !== 0 || result.providers.length !== 0 || result.adminViews.length !== 0
      : session === null || !sameBusinessSession(result.session, session)) throw Error('business_console_account_unavailable');
    if (!await stillActor(session, stamp) || !ingressCurrent(accountIngress, session) || accountResult!(session, result) !== true
      || !exactCurrent(session, stamp)) throw Error('business_console_account_unavailable');
    if (session) rememberLogout(session);
    return result;
  }
  async function transition(kind: 'signIn' | 'joinOrganization' | 'selectOrganization' | 'selectPersonal', raw?: unknown): Promise<BusinessAccountSnapshot | void> {
    if (raw !== undefined && !isBusinessConsoleMetadata(raw)) throw Error('business_console_account_invalid_request');
    const exact = raw === undefined ? undefined : freezeBusinessConsoleMetadata(raw);
    const stamp = generation, session = await actor(stamp);
    if (!configuredAccount() || !ingressCurrent(accountIngress, session) || closedAccounts.has(sessionKey(session))) throw Error('business_console_account_unavailable');
    if (kind !== 'signIn' && kind !== 'selectPersonal') {
      const keys = kind === 'joinOrganization' ? ['organizationId', 'expectedSessionId', 'expectedSessionRevision'] : ['organizationId', 'expectedSessionId', 'expectedSessionRevision', 'expectedAuthEpoch'];
      if (!session || !businessOnlyKeys(exact, keys) || !isBusinessId(exact.organizationId) || exact.expectedSessionRevision !== session.sessionRevision
        || exact.expectedSessionId !== session.sessionId
        || kind === 'selectOrganization' && exact.expectedAuthEpoch !== session.authEpoch) throw Error('business_console_account_invalid_request');
    }
    closedAccounts.add(sessionKey(session)); displayInvalidate();
    const started = generation;
    // The genuine original account port performs actual auth/org CAS. No new
    // session/actor/transport or request headers are created by this composition.
    const result = kind === 'signIn' ? await accountPort!.signIn() : kind === 'selectPersonal' ? await accountPort!.selectPersonal()
      : kind === 'joinOrganization' ? await accountPort!.joinOrganization(exact as Parameters<BusinessAccountPanelPort['joinOrganization']>[0])
        : await accountPort!.selectOrganization(exact as Parameters<BusinessAccountPanelPort['selectOrganization']>[0]);
    if (kind === 'selectPersonal') return;
    if (!isBusinessConsoleMetadata(result) || !isBusinessAccountSnapshot(result)) throw Error('business_console_account_unknown');
    const value = freezeBusinessConsoleMetadata(result), current = await actor(started);
    if (value.session === null || current === null || !sameBusinessSession(value.session, current)
      || session && kind !== 'signIn' && (current.principalId !== session.principalId || current.identityAuthorityId !== session.identityAuthorityId
        || current.deploymentId !== session.deploymentId || current.hostId !== session.hostId)
      || kind !== 'signIn' && current.organizationId !== (exact as { organizationId: string }).organizationId
      || closedAccounts.has(sessionKey(current)) || !ingressCurrent(accountIngress, current) || accountResult!(current, value) !== true
      || !exactCurrent(current, started)) throw Error('business_console_account_unknown');
    return value;
  }
  const account: BusinessAccountPanelPort | null = configuredAccount() && provenance ? Object.freeze({
    read: accountRead, subscribeInvalidation: subscribe, signIn: () => transition('signIn') as Promise<BusinessAccountSnapshot>,
    joinOrganization: (value: Parameters<BusinessAccountPanelPort['joinOrganization']>[0]) => transition('joinOrganization', value) as Promise<BusinessAccountSnapshot>,
    selectOrganization: (value: Parameters<BusinessAccountPanelPort['selectOrganization']>[0]) => transition('selectOrganization', value) as Promise<BusinessAccountSnapshot>,
    selectPersonal: () => transition('selectPersonal') as Promise<void>,
    async logout(raw: Parameters<BusinessAccountPanelPort['logout']>[0]) {
      if (!isBusinessConsoleMetadata(raw) || !businessOnlyKeys(raw, ['sessionId', 'expectedSessionRevision']) || !isBusinessId(raw.sessionId) || !isBusinessRevision(raw.expectedSessionRevision))
        return { snapshot: emptyAccount(), remote: 'unknown' as const };
      const exact = freezeBusinessConsoleMetadata(raw), original = logoutTargets.get(selectorKey(exact));
      if (!original || terminalIdentityConflict(original)) return { snapshot: emptyAccount(), remote: 'unknown' as const };
      const frame = freezeBusinessConsoleMetadata({ session: original, selector: exact });
      loggedOut.add(authKey(original)); closedAccounts.add(sessionKey(original)); displayInvalidate();
      try {
        const rawResult = await originalLogout!(frame);
        if (!isBusinessConsoleMetadata(rawResult) || !businessOnlyKeys(rawResult, ['snapshot', 'remote']) || !['confirmed', 'unknown'].includes(rawResult.remote as string)
          || !isBusinessAccountSnapshot(rawResult.snapshot)) return { snapshot: emptyAccount(), remote: 'unknown' as const };
        const result = freezeBusinessConsoleMetadata(rawResult);
        if (logoutResult!(frame, result) !== true) return { snapshot: emptyAccount(), remote: 'unknown' as const };
        // Only receipt metadata is retained. An old account/provider body is never
        // published after logout, even if the native owner had a settled effect.
        return freezeBusinessConsoleMetadata({ snapshot: emptyAccount(), remote: result.remote });
      } catch { return { snapshot: emptyAccount(), remote: 'unknown' as const }; }
    },
    async openAdmin(raw: Parameters<BusinessAccountPanelPort['openAdmin']>[0]) {
      if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_account_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw);
      const stamp = generation, session = await actor(stamp);
      if (!session || closedAccounts.has(sessionKey(session)) || !ingressCurrent(accountIngress, session)
        || !businessOnlyKeys(exact, ['organizationId', 'view', 'expectedSessionId', 'expectedSessionRevision']) || exact.organizationId !== session.organizationId
        || exact.expectedSessionId !== session.sessionId
        || exact.expectedSessionRevision !== session.sessionRevision || !['members', 'providers', 'tools', 'audit'].includes(exact.view)) throw Error('business_console_account_invalid_request');
      if (!await stillActor(session, stamp)) throw Error('business_console_current_required');
      await accountPort!.openAdmin(exact); if (!await stillActor(session, stamp)) throw Error('business_console_account_unknown');
    },
  }) : null;
  async function learningRead(): Promise<BusinessLearningSnapshot> {
    const before = await requireContext();
    if (!configuredLearning() || !ingressCurrent(learningIngress, before.session)) throw Error('business_console_learning_unavailable');
    const raw = await learningPort!.read();
    if (!isBusinessConsoleMetadata(raw) || !isBusinessLearningSnapshot(raw) || !isBusinessRendererContext(raw.context, now())) throw Error('business_console_learning_unavailable');
    const value = freezeBusinessConsoleMetadata(raw);
    if (!sameBusinessHistoryViewContext(value.context!, before.context) || value.status !== 'current' || !await stillContext(before)
      || !ingressCurrent(learningIngress, before.session) || learningResult!(before.session, value) !== true || !exactCurrent(before.session, before.stamp)) throw Error('business_console_learning_unavailable');
    learningSnapshot = value;
    for (const source of value.sources) {
      const target = { sourceId: source.id, expectedPolicyRevision: source.policyRevision };
      rememberTerminal(collectionTargets, { context: before.context, selector: target });
    }
    for (const candidate of value.candidates) if (candidate.stopTarget && candidate.stopTarget.hostId === before.session.hostId) {
      const target = { candidateId: candidate.id, expectedRevision: candidate.revision, expectedControlRevision: candidate.controlRevision, target: candidate.stopTarget };
      rememberTerminal(stopTargets, { context: before.context, selector: target });
    }
    return value;
  }
  function candidate(input: BusinessLearningCandidateAction, before: Awaited<ReturnType<typeof requireContext>>): BusinessLearningCandidateView {
    if (!businessOnlyKeys(input, ['candidateId', 'expectedRevision', 'expectedControlRevision']) || !isBusinessId(input.candidateId)
      || ![input.expectedRevision, input.expectedControlRevision].every(isBusinessRevision) || !learningSnapshot?.context
      || !sameBusinessHistoryViewContext(learningSnapshot.context, before.context)) throw Error('business_console_learning_invalid_request');
    const value = learningSnapshot.candidates.find(value => value.id === input.candidateId && value.revision === input.expectedRevision && value.controlRevision === input.expectedControlRevision);
    if (!value) throw Error('business_console_learning_invalid_request');
    return value;
  }
  const actionPart = (value: BusinessLearningCandidateAction) => ({ candidateId: value.candidateId, expectedRevision: value.expectedRevision, expectedControlRevision: value.expectedControlRevision });
  async function mutateLearning(kind: 'approve' | 'pause' | 'revoke' | 'restoreProposal', raw: Parameters<BusinessLearningPanelPort['approve']>[0] | Parameters<BusinessLearningPanelPort['restoreProposal']>[0] | BusinessLearningCandidateAction): Promise<BusinessLearningSnapshot> {
    if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_learning_invalid_request');
    const exact = freezeBusinessConsoleMetadata(raw), before = await requireContext();
    if (!ingressCurrent(learningIngress, before.session)) throw Error('business_console_learning_unavailable');
    const currentCandidate = candidate(actionPart(exact), before);
    const keys = ['candidateId', 'expectedRevision', 'expectedControlRevision', ...(kind === 'approve' ? ['baseRevision', 'proposalDigest', 'reviewReceiptId', 'reviewedHash'] : kind === 'restoreProposal' ? ['version', 'expectedBaseRevision'] : [])];
    if (!businessOnlyKeys(exact, keys)) throw Error('business_console_learning_invalid_request');
    if (kind === 'approve') {
      const value = exact as Parameters<BusinessLearningPanelPort['approve']>[0];
      if (!businessReviewReady(currentCandidate, review, now()) || !review || value.baseRevision !== review.baseRevision || value.proposalDigest !== review.proposalDigest
        || value.reviewReceiptId !== review.reviewReceiptId || value.reviewedHash !== review.reviewedHash
        || reviewResult!(before.session, actionPart(value), review) !== true) throw Error('business_console_learning_review_required');
    }
    if (kind === 'restoreProposal') {
      const value = exact as Parameters<BusinessLearningPanelPort['restoreProposal']>[0];
      if (value.version !== currentCandidate.restoreVersion || !isBusinessId(value.version) || value.expectedBaseRevision !== currentCandidate.baseRevision) throw Error('business_console_learning_invalid_request');
    }
    if (!await stillContext(before)) throw Error('business_console_context_changed');
    const key = selectorKey([sessionKey(before.session), kind, exact]);
    if (attemptedLearning.has(key) || attemptedLearning.size >= 256) throw Error('business_console_learning_original_result_required');
    attemptedLearning.add(key); review = null;
    const rawResult = kind === 'approve' ? await learningPort!.approve(exact as Parameters<BusinessLearningPanelPort['approve']>[0])
      : kind === 'restoreProposal' ? await learningPort!.restoreProposal(exact as Parameters<BusinessLearningPanelPort['restoreProposal']>[0])
        : await learningPort![kind](exact as BusinessLearningCandidateAction);
    if (!isBusinessConsoleMetadata(rawResult) || !isBusinessLearningSnapshot(rawResult) || !isBusinessRendererContext(rawResult.context, now())) throw Error('business_console_learning_unknown');
    const result = freezeBusinessConsoleMetadata(rawResult);
    // Dispatch authority is never reused to read a settled/changed result. The
    // genuine result owner validates its new revision/current read authority.
    const current = await requireContext();
    if (!sameBusinessSession(current.session, before.session) || current.context.bindingKey !== before.context.bindingKey
      || metadataKey(current.context.scope) !== metadataKey(before.context.scope) || metadataKey(current.context.target) !== metadataKey(before.context.target)
      || !sameBusinessHistoryViewContext(result.context!, current.context)
      || !ingressCurrent(learningIngress, current.session) || learningResult!(current.session, result) !== true || !exactCurrent(current.session, current.stamp)) throw Error('business_console_learning_unknown');
    learningSnapshot = result; return result;
  }
  const learning: BusinessLearningPanelPort | null = configuredLearning() && provenance ? Object.freeze({ read: learningRead, subscribeInvalidation: subscribe,
    async compare(raw: BusinessLearningCandidateAction) {
      if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_learning_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw), before = await requireContext(), value = candidate(exact, before);
      if (!ingressCurrent(learningIngress, before.session)) throw Error('business_console_learning_unavailable');
      const rawResult = await learningPort!.compare(exact); review = null;
      if (rawResult === null) return null;
      if (!isBusinessConsoleMetadata(rawResult) || !businessReviewMatches(value, rawResult, now())) throw Error('business_console_learning_review_unavailable');
      const result = freezeBusinessConsoleMetadata(rawResult);
      if (!await stillContext(before) || !ingressCurrent(learningIngress, before.session) || reviewResult!(before.session, exact, result) !== true
        || !exactCurrent(before.session, before.stamp)) throw Error('business_console_learning_review_unavailable');
      review = result; return result;
    },
    approve: (value: Parameters<BusinessLearningPanelPort['approve']>[0]) => mutateLearning('approve', value),
    pause: (value: BusinessLearningCandidateAction) => mutateLearning('pause', value), revoke: (value: BusinessLearningCandidateAction) => mutateLearning('revoke', value),
    restoreProposal: (value: Parameters<BusinessLearningPanelPort['restoreProposal']>[0]) => mutateLearning('restoreProposal', value),
    async pauseCollection(raw: Parameters<BusinessLearningPanelPort['pauseCollection']>[0]) {
      if (!isBusinessConsoleMetadata(raw) || !businessOnlyKeys(raw, ['sourceId', 'expectedPolicyRevision'])) return emptyLearning();
      const exact = freezeBusinessConsoleMetadata(raw), original = collectionTargets.get(selectorKey(exact));
      if (!original || terminalIdentityConflict(original.context.session)) return emptyLearning();
      try {
        const rawResult = await originalCollectionPause!(original);
        if (!isBusinessConsoleMetadata(rawResult) || !isBusinessLearningSnapshot(rawResult) || !isBusinessRendererContext(rawResult.context, now())) return emptyLearning();
        const result = freezeBusinessConsoleMetadata(rawResult), current = await requireContext();
        if (sessionKey(current.session) !== sessionKey(original.context.session) || current.context.bindingKey !== original.context.bindingKey
          || metadataKey(current.context.scope) !== metadataKey(original.context.scope) || metadataKey(current.context.target) !== metadataKey(original.context.target)
          || !sameBusinessHistoryViewContext(result.context!, current.context) || !ingressCurrent(learningIngress, current.session)
          || learningResult!(current.session, result) !== true || !exactCurrent(current.session, current.stamp)) return emptyLearning();
        learningSnapshot = result; return result;
      } catch { /* Actual original effect status remains with its owner. */ }
      // A terminal effect never manufactures a fresh display/read grant. Without
      // a separately current result view, the existing panel shows unknown.
      return freezeBusinessConsoleMetadata(emptyLearning());
    },
    async stop(raw: Parameters<BusinessLearningPanelPort['stop']>[0]) {
      if (!isBusinessConsoleMetadata(raw)) return { state: 'unknown' as const };
      const exact = freezeBusinessConsoleMetadata(raw), original = stopTargets.get(selectorKey(exact));
      if (!original || terminalIdentityConflict(original.context.session)) return { state: 'unknown' as const };
      try {
        const rawResult = await originalStop!(original);
        if (!isBusinessConsoleMetadata(rawResult) || !businessOnlyKeys(rawResult, ['state']) || !['accepted', 'settled', 'unknown', 'failed'].includes(rawResult.state)) return { state: 'unknown' as const };
        const result = freezeBusinessConsoleMetadata(rawResult);
        return stopResult!(original, result) === true ? result : { state: 'unknown' as const };
      } catch { return { state: 'unknown' as const }; }
    },
    async openAudit(raw: { candidateId: string }) {
      if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_learning_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw);
      const before = await requireContext();
      if (!businessOnlyKeys(exact, ['candidateId']) || !isBusinessId(exact.candidateId) || !ingressCurrent(learningIngress, before.session)) throw Error('business_console_learning_invalid_request');
      await learningPort!.openAudit(exact); if (!await stillContext(before)) throw Error('business_console_context_changed');
    },
  }) : null;
  const history: BusinessHistoryPanelPort | null = historyAdapter && provenance ? Object.freeze({
    subscribeInvalidation: subscribe,
    async read() {
      const before = await requireContext(), result = await historyAdapter.read();
      if (!isBusinessConsoleMetadata(result) || !result.context || !sameBusinessHistoryViewContext(result.context, before.context) || !await stillContext(before)) throw Error('business_console_history_unavailable');
      return freezeBusinessConsoleMetadata(result);
    },
    search: historyAdapter.search ? async (raw: Parameters<NonNullable<BusinessHistoryPanelPort['search']>>[0]) => {
      if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_history_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw), before = await requireContext(exact.context), result = await historyAdapter.search!(exact);
      if (!isBusinessConsoleMetadata(result) || !await stillContext(before)) throw Error('business_console_history_unavailable');
      return freezeBusinessConsoleMetadata(result);
    } : undefined,
    reviewRecommendation: historyAdapter.reviewRecommendation ? async (raw: Parameters<NonNullable<BusinessHistoryPanelPort['reviewRecommendation']>>[0]) => {
      if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_history_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw), before = await requireContext(exact.context); await historyAdapter.reviewRecommendation!(exact);
      if (!await stillContext(before)) throw Error('business_console_history_unknown');
    } : undefined,
    pauseCollection: historyAdapter.pauseCollection ? async (raw: Parameters<NonNullable<BusinessHistoryPanelPort['pauseCollection']>>[0]) => {
      if (!isBusinessConsoleMetadata(raw) || !raw.context) throw Error('business_console_original_control_required');
      const original = contexts.get(contextKey(raw.context));
      if (!original || !sameBusinessHistoryViewContext(raw.context, original) || terminalIdentityConflict(original.session)) throw Error('business_console_original_control_required');
      return historyAdapter.pauseCollection!(freezeBusinessConsoleMetadata(raw));
    } : undefined,
    deleteHistory: historyAdapter.deleteHistory ? async (raw: Parameters<NonNullable<BusinessHistoryPanelPort['deleteHistory']>>[0]) => {
      if (!isBusinessConsoleMetadata(raw) || !isBusinessHistoryDeleteRequest(raw, now())) throw Error('business_console_history_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw), stamp = generation, session = await actor(stamp);
      if (!session || !sameBusinessSession(session, exact.context.session) || closedContexts.has(contextKey(exact.context))) throw Error('business_console_context_changed');
      // The adapter's privacy owner performs the independent current context and
      // SAME-serialization history.delete CAS. Source read permission is not reused.
      return historyAdapter.deleteHistory!(exact);
    } : undefined,
    reconcileDelete: historyAdapter.reconcileDelete ? async (raw: Parameters<NonNullable<BusinessHistoryPanelPort['reconcileDelete']>>[0]) => {
      if (!isBusinessConsoleMetadata(raw) || !businessOnlyKeys(raw, ['request', 'originalIntent']) || !isBusinessHistoryDeleteRequest(raw.request, 0)) throw Error('business_console_original_receipt_required');
      return historyAdapter.reconcileDelete!(freezeBusinessConsoleMetadata(raw));
    } : undefined,
    openPage: historyAdapter.openPage ? async (raw: Parameters<NonNullable<BusinessHistoryPanelPort['openPage']>>[0]) => {
      if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_history_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw), before = await requireContext(exact.context); await historyAdapter.openPage!(exact);
      if (!await stillContext(before)) throw Error('business_console_context_changed');
    } : undefined,
    openCandidate: historyAdapter.openCandidate ? async (raw: Parameters<NonNullable<BusinessHistoryPanelPort['openCandidate']>>[0]) => {
      if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_history_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw), before = await requireContext(exact.context); await historyAdapter.openCandidate!(exact);
      if (!await stillContext(before)) throw Error('business_console_context_changed');
    } : undefined,
  }) : null;
  const organizationExecution: BusinessOrganizationExecutionPanelPort | null = provenance && organizationAdapter.blocker() === null ? Object.freeze({
    subscribeInvalidation: subscribe,
    async read() {
      const stamp = generation, session = await actor(stamp); if (!session) throw Error('business_console_current_required');
      const result = await organizationAdapter.read(); if (!await stillActor(session, stamp)) throw Error('business_console_context_changed'); return result;
    },
    async control(raw: Parameters<BusinessOrganizationExecutionPanelPort['control']>[0]) {
      if (!isBusinessConsoleMetadata(raw)) throw Error('business_console_organization_invalid_request');
      const exact = freezeBusinessConsoleMetadata(raw);
      // Preserve the original adapter's current actor/metadata/target gates. Its
      // genuine owner has not supplied an expiry/read-revoke independent stop
      // protocol, so this wrapper cannot claim or create that missing guarantee.
      if (exact.action === 'stop') return organizationAdapter.control(exact);
      const stamp = generation, session = await actor(stamp); if (!session) throw Error('business_console_current_required');
      const result = await organizationAdapter.control(exact);
      if (!await stillActor(session, stamp)) throw Error('business_console_organization_result_unknown'); return result;
    },
    receipt: (raw: Parameters<BusinessOrganizationExecutionPanelPort['receipt']>[0]) => organizationAdapter.receipt(raw),
  }) : null;
  const namespace: BusinessRendererBridge = Object.freeze({ snapshot, account, history, learning, organizationExecution, onInvalidated: subscribe,
    openDashboard: dashboard ? async (raw: { view: BusinessDashboardView }) => {
      if (!isBusinessConsoleMetadata(raw) || !businessOnlyKeys(raw, ['view']) || !BUSINESS_DASHBOARD_VIEWS.includes(raw.view)) throw Error('business_console_navigation_invalid');
      const exact = freezeBusinessConsoleMetadata(raw);
      const stamp = generation, session = await actor(stamp);
      await dashboard(exact); if (!await stillActor(session, stamp)) throw Error('business_console_context_changed');
    } : undefined,
  });
  return Object.freeze({ namespace, originalBusiness: provenance ? native : null, invalidate,
    blockers(): readonly string[] {
      const result: string[] = []; const base = baseBlocker(); if (base) result.push(base);
      if (!configuredAccount()) result.push('business_console_account_owner_unbound');
      if (!historyPorts?.owner && !historyPorts?.privacyDelete) result.push('business_console_history_context_unbound');
      if (!configuredLearning()) result.push('business_console_learning_owner_unbound');
      if (organizationAdapter.blocker()) result.push('organization_execution_owner_unbound');
      return Object.freeze(result);
    },
  });
}
export type BusinessConsoleComposition = ReturnType<typeof createBusinessConsoleComposition>;
