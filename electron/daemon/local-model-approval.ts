import { AsyncLocalStorage } from "node:async_hooks";
import { mainToolConsentResource } from "../runtime/tool-consent";
import { setRuntimeToolPermissionArbiter, type RuntimeToolPermissionAsk,
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
const currentScope = new AsyncLocalStorage<Scope>();
const sessions = new Map<string, { owner: Scope; proxy: PreparedMcpProxyScope }>();
let installed = false;

/** Only native run admission registers a scope. JSON asks cannot select a run
 * or recover authority after cancellation, detach or a service epoch change. */
export function installLocalModelPermissionRelay(): void {
  if (installed) return;
  installed = true;
  setRuntimeToolPermissionArbiter(async ask => {
    try {
      const proxy = preparedMcpProxyAskScope(ask);
      const registered = proxy ? sessions.get(proxy.sessionKey) : undefined;
      // ALS may belong to an overlapping direct run. Only Main's exact ask
      // provenance can select the independently sealed proxy owner.
      const scope = proxy ? (registered?.proxy === proxy ? registered.owner : undefined) : currentScope.getStore();
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
      if (proxy && (preparedMcpProxyAskScope(ask) !== proxy || sessions.get(proxy.sessionKey) !== registered)) return "deny";
      return decision;
    } catch { return "deny"; }
  });
}

export async function withLocalModelPermissionRelay<T>(scope: Scope,
  proxy: PreparedMcpProxyScope | undefined, operation: () => Promise<T>): Promise<T> {
  installLocalModelPermissionRelay();
  const proxySession = proxy?.sessionKey;
  if (proxySession && sessions.has(proxySession)) throw Object.assign(new Error("local_model_remote_mcp_admission_session_conflict"),
    { code: "local_model_remote_mcp_admission_session_conflict" });
  const registered = proxy ? { owner: scope, proxy } : undefined;
  if (proxySession && registered) sessions.set(proxySession, registered);
  try { return await currentScope.run(scope, operation); }
  finally { if (proxySession && sessions.get(proxySession) === registered) sessions.delete(proxySession); }
}
