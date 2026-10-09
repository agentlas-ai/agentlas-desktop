import { AsyncLocalStorage } from "node:async_hooks";
import { mainToolConsentResource } from "../runtime/tool-consent";
import { registerRuntimeToolPermissionRelay, type RuntimeToolPermissionAsk,
  type RuntimeToolPermissionDecision } from "../runtime/tool-approval";
import type { RemoteLocalModelPermissionRequest } from "../local-model-hub/remote-contract";
import { preparedMcpProxyAskScope, preparedMcpProxyScopeMatchesAsk, type PreparedMcpProxyScope } from "../mcp-tools/prepared-transport";

interface Scope {
  signal: AbortSignal;
  assertCurrent(): void;
  permission: RuntimeToolPermissionAsk["permission"];
  runtime: string;
  sessionKey: string;
  planMode?: boolean;
  unattended?: boolean;
  cwd?: string;
  chatId?: string;
  request(ask: RemoteLocalModelPermissionRequest["ask"], resourceDigest: string,
    family: RemoteLocalModelPermissionRequest["family"]): Promise<RuntimeToolPermissionDecision>;
}
const currentScope = new AsyncLocalStorage<{ owner: Scope; active: boolean }>();
const sessions = new Map<string, { owner: Scope; proxy: PreparedMcpProxyScope }>();
// Retired proxy objects still belong to this relay. A late native ask must
// never inherit an unrelated base policy after its active registry is removed.
const ownedProxies = new WeakSet<PreparedMcpProxyScope>();
const ownedSignals = new WeakSet<AbortSignal>();
let installed = false;

/** Only native run admission registers a scope. JSON asks cannot select a run
 * or recover authority after cancellation, detach or a service epoch change. */
export function installLocalModelPermissionRelay(): void {
  if (installed) return;
  installed = true;
  registerRuntimeToolPermissionRelay(ask => {
    const proxy = preparedMcpProxyAskScope(ask);
    const direct = currentScope.getStore();
    const registered = proxy ? sessions.get(proxy.sessionKey) : undefined;
    if (registered && registered.proxy !== proxy) return async () => "deny";
    // A native local request may lose ALS. Its retained lifetime is a denial
    // fence, never permission to borrow the base policy or create a new scope.
    if (!direct && ask.signal && ownedSignals.has(ask.signal)
      && (!proxy || !ownedProxies.has(proxy))) return async () => "deny";
    // A proven foreign proxy keeps its own native policy, even if a direct
    // local operation happens to overlap in ALS. Strings cannot select us.
    if (proxy ? !ownedProxies.has(proxy) : !direct) return undefined;
    return async ask => {
      try {
        // ALS may belong to an overlapping direct run. Only Main's exact ask
        // provenance can select the independently sealed proxy owner.
        const scope = proxy ? (registered?.proxy === proxy ? registered.owner : undefined)
          : direct?.active ? direct.owner : undefined;
        if (!scope) return "deny";
        scope.assertCurrent(); scope.signal.throwIfAborted(); ask.signal?.throwIfAborted();
        if (proxy ? !preparedMcpProxyScopeMatchesAsk(proxy, ask) : (ask.runtime !== scope.runtime
          || ask.sessionKey !== scope.sessionKey || ask.permission !== scope.permission || ask.cwd !== scope.cwd
          || ask.chatId !== scope.chatId || Boolean(ask.planMode) !== Boolean(scope.planMode)
          || Boolean(ask.unattended) !== Boolean(scope.unattended))) return "deny";
        const resourceDigest = mainToolConsentResource(ask);
        if (!resourceDigest || !/^[0-9a-f]{64}$/.test(resourceDigest)) return "deny";
        const { signal: _signal, consentBinding: _binding, ...wire } = ask;
        const decision = await scope.request(wire, resourceDigest, proxy ? "prepared-mcp-proxy" : "direct");
        scope.assertCurrent(); scope.signal.throwIfAborted(); ask.signal?.throwIfAborted();
        if (!proxy && (!direct?.active || currentScope.getStore() !== direct)) return "deny";
        if (proxy && (preparedMcpProxyAskScope(ask) !== proxy || sessions.get(proxy.sessionKey) !== registered)) return "deny";
        return decision;
      } catch { return "deny"; }
    };
  });
}

export async function withLocalModelPermissionRelay<T>(scope: Scope,
  proxy: PreparedMcpProxyScope | undefined, operation: () => Promise<T>): Promise<T> {
  installLocalModelPermissionRelay();
  const proxySession = proxy?.sessionKey;
  if (proxySession && sessions.has(proxySession)) throw Object.assign(new Error("local_model_remote_mcp_admission_session_conflict"),
    { code: "local_model_remote_mcp_admission_session_conflict" });
  const registered = proxy ? { owner: scope, proxy } : undefined;
  ownedSignals.add(scope.signal);
  if (proxy) ownedProxies.add(proxy);
  if (proxySession && registered) sessions.set(proxySession, registered);
  const direct = { owner: scope, active: true };
  try { return await currentScope.run(direct, operation); }
  finally {
    direct.active = false;
    if (proxySession && sessions.get(proxySession) === registered) sessions.delete(proxySession);
  }
}
