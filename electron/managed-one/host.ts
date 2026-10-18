/** A host bootstrap for the existing One domain and prepared invocation service.
 * No provider loop, prompt, queue or Mobile protocol is reimplemented here. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { ManagedOneBootstrap, ManagedOneHealth } from "../../shared/managed-one";
import { configureManagedOneAuthentication, managedOneAuthentication, managedOneHeaders, managedOneAuthenticationEpoch } from "./auth";

export interface ManagedOneHostOptions { port?: number; fetch?: typeof globalThis.fetch; onDrained?(): void }
export async function startManagedOneHost(raw: unknown, options: ManagedOneHostOptions = {}) {
  const config = configureManagedOneAuthentication(raw);
  const root = config.userDataDir;
  const port = options.port ?? 43127;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("managed_one_control_port_invalid");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw new Error("managed_one_data_directory_not_canonical");
  if (process.platform !== "win32" && (fs.statSync(root).mode & 0o077) !== 0) throw new Error("managed_one_data_directory_not_private");
  const ownerFile = path.join(root, "managed-one-owner.json"), lockFile = path.join(root, ".managed-one-process.lock");
  const binding = { hostId: config.hostId, userId: config.userId, workspaceId: config.workspaceId };
  const files = fs.readdirSync(root);
  if (!fs.existsSync(ownerFile) && files.some(name => name !== ".managed-one-process.lock")) throw new Error("managed_one_existing_unowned_data");
  if (fs.existsSync(ownerFile)) {
    const prior = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    if (JSON.stringify(prior.binding) !== JSON.stringify(binding) || !Number.isSafeInteger(prior.generation) || prior.generation > config.generation) throw new Error("managed_one_store_authority_changed");
  }
  const acquire = () => fs.openSync(lockFile, "wx", 0o600);
  let lock: number;
  try { lock = acquire(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const priorFile = fs.lstatSync(lockFile);
    const prior = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) throw new Error("managed_one_process_owner_unknown");
    try { process.kill(prior.pid, 0); throw new Error("managed_one_process_owner_live"); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
    const currentFile = fs.lstatSync(lockFile);
    if (currentFile.dev !== priorFile.dev || currentFile.ino !== priorFile.ino) throw new Error("managed_one_process_owner_changed");
    fs.unlinkSync(lockFile); lock = acquire();
  }
  const stat = fs.fstatSync(lock);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostId: config.hostId, generation: config.generation }));
  const ownerTemporary = `${ownerFile}.${process.pid}.tmp`;
  fs.writeFileSync(ownerTemporary, JSON.stringify({ binding, generation: config.generation }), { mode: 0o600, flag: "wx" });
  fs.renameSync(ownerTemporary, ownerFile);
  let accepting = true, stopped = false, supervisorReady = false;
  const assertOwner = () => {
    if (!accepting || !managedOneAuthentication()) throw new Error("managed_one_host_admission_closed");
    const actual = fs.lstatSync(lockFile);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error("managed_one_process_fenced");
  };
  // Bootstrap credentials never enter process.env or a model-visible file.
  for (const key of Object.keys(process.env)) if (/^AGENTLAS_MANAGED_ONE_.*(?:TOKEN|SECRET|BOOTSTRAP|CREDENTIAL|BEARER)/.test(key)) delete process.env[key];
  process.env.AGENTLAS_USER_DATA = root;
  process.env.AGENTLAS_MOBILE_BRIDGE_HOST = "127.0.0.1";
  process.env.AGENTLAS_STORE_PATH = path.join(root, "agentlas.sqlite");
  const packageRoot = [path.resolve(__dirname,"../../.."),path.resolve(__dirname,"../..")].find(candidate => {
    try { return JSON.parse(fs.readFileSync(path.join(candidate,"package.json"),"utf8")).name === "agentlas-desktop"; } catch { return false; }
  });
  if (!packageRoot) throw new Error("managed_one_runtime_package_missing");
  const appVersion = JSON.parse(fs.readFileSync(path.join(packageRoot,"package.json"),"utf8")).version as string;
  process.env.AGENTLAS_RUNTIME_APP_METADATA = JSON.stringify({version:appVersion,isPackaged:true,appPath:packageRoot,resourcesPath:packageRoot});
  const [{ setUserDataDir }, identity, store, owners, policy, auth, proxy] = await Promise.all([
    import("../runtime-paths"), import("../install-identity"), import("../store/db"), import("../store/invocation-run-owners"),
    import("../runtime/host-tool-permission-policy"), import("../auth"), import("../mcp-tools/proxy-server"),
  ]);
  setUserDataDir(root);
  identity.configureInstallIdentity(identity.managedCloudInstallIdentity(root));
  (await import("../runtime/selection")).configureServingOnlyHostPolicy(()=>!!managedOneAuthentication());
  (await import("../one/supervisor-os-execution")).configureSupervisorScreenPolicy(Object.freeze({computerUse:false,reason:"managed_one_computer_use_unavailable"}));
  // Explicit writer authority is restricted to this fenced, isolated service store.
  store.initStore({ migrationRole: "owner" });
  owners.configureInvocationProcessOwner("daemon", `managed-one:${config.hostId}:${config.generation}:${randomUUID()}`);
  owners.invocationRunOwners.releaseAbandoned("daemon", owners.invocationProcessOwner().ownerId);
  (await import("../architecture/seed")).seedBuiltinAgents();
  const { CONVERSATIONAL_ROLES } = await import("../../shared/runtime-roles");
  const { setModelRoleMembers } = await import("../store/model-roles");
  const { AGENTLAS_SERVING_DEFAULT_MODEL } = await import("../../shared/agentlas-serving");
  for (const role of CONVERSATIONAL_ROLES) setModelRoleMembers(role, [{ kind: "agentlas", backend: "agentlas", source: "agentlas:serving", model: AGENTLAS_SERVING_DEFAULT_MODEL, role, inherit: false }]);
  policy.installHostToolPermissionPolicy({ hostKind: "daemon", getAuthenticatedActorIds: auth.getAuthenticatedActorIds });
  if (await proxy.startMcpProxyApprovalServer() <= 0) throw new Error("managed_one_mcp_proxy_unavailable");
  (await import("../runtime/model-catalog")).installModelCatalogResolver();
  const supervisor = await import("../one/supervisor");
  supervisor.configureOneSupervisorDaemonHost({ ownerKind: "work-daemon", ownerEpoch: owners.invocationProcessOwner().ownerId, executor: "agentlas-cloud", assertAuthority: assertOwner });
  const domain = supervisor.oneSupervisor();
  await domain.snapshot();
  supervisorReady = true;
  const bridge = await import("../mobile-bridge/runtime");
  const pairing = await import("../mobile-bridge/pairing");
  const { MOBILE_BRIDGE_PROTOCOL_VERSION } = await import("../../shared/mobile-bridge");
  const identityFile = pairing.mobileBridgeHostIdentityPath(root);
  fs.mkdirSync(path.dirname(identityFile), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(identityFile)) fs.writeFileSync(identityFile, JSON.stringify({ version: MOBILE_BRIDGE_PROTOCOL_VERSION, hostId: config.hostId, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  if (pairing.loadOrCreateMobileBridgeHostIdentity(root).hostId !== config.hostId) throw new Error("managed_one_mobile_host_identity_changed");
  await bridge.startAgentlasMobileBridge({ userDataPath: root, appVersion, displayName: "Agentlas One Cloud",
    hostAuthority:Object.freeze({
      sessionActive:()=>!!managedOneAuthentication(),
      workspaceId:()=>managedOneAuthentication()?.workspaceId ?? null,
      goalControl:false as const,
      relayEndpoint:config.relayUrl,
      relayAuthentication:Object.freeze({current(){
        const epoch=managedOneAuthenticationEpoch("relay"),headers=managedOneHeaders("relay");
        return epoch && headers ? {epoch,headers} : null;
      }}),
    }),
  });
  const { invocationService } = await import("../invocation/service");
  const { drainInvocationService } = await import("../runtime/invocation-lifecycle");
  const { drainRunChildrenForHostShutdown, liveRunChildCount } = await import("../runtime/exec");
  let drainPromise: Promise<boolean> | undefined;
  const drain = (): Promise<boolean> => drainPromise ??= (async () => {
    accepting = false; supervisorReady = false;
    supervisor.closeOneSupervisorHostAdmission();
    clearInterval(renewTimer);
    await bridge.stopAgentlasMobileBridge();
    const settled = drainInvocationService(invocationService);
    const children = await drainRunChildrenForHostShutdown([], 10_000);
    const complete = await Promise.race([settled.then(() => true), new Promise<false>(resolve => { const timer=setTimeout(()=>resolve(false),20_000);timer.unref(); })]);
    if (!complete || children.timedOut || children.remaining || children.pendingEscalations || invocationService.activeRunIds().length || liveRunChildCount()) return false;
    await proxy.stopMcpProxyApprovalServer();
    store.closeStore();
    fs.closeSync(lock); fs.unlinkSync(lockFile);
    stopped = true; return true;
  })().catch(() => false).then(confirmed => { if (!confirmed) drainPromise = undefined; return confirmed; });
  let renewalBusy = false;
  const renew = async () => {
    if (!accepting || renewalBusy) return;
    const active = managedOneAuthentication();
    if (!active) { void drain(); return; }
    if (active.expiresAt - Date.now() > 2 * 60_000) return;
    renewalBusy = true;
    try {
      const response = await (options.fetch ?? globalThis.fetch)(`${config.webBaseUrl}/api/managed-one/host/renew`, {
        method: "POST", headers: { ...managedOneHeaders("control"), "content-type": "application/json" },
        body: JSON.stringify({ hostId: config.hostId, generation: config.generation }), signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (response.status === 401 || response.status === 403 || response.status === 409 || response.status === 410) { void drain(); return; }
      if (!response.ok) return;
      const value = await response.json() as { credentials: ManagedOneBootstrap["credentials"]; expiresAt: number };
      configureManagedOneAuthentication({ ...config, credentials: value.credentials, expiresAt: value.expiresAt });
      bridge.refreshMobileBridgeRelayAuthentication();
    } catch { /* A transient failure never invents a new generation; expiry closes admission. */ }
    finally { renewalBusy = false; }
  };
  const renewTimer = setInterval(() => { void renew(); }, 30_000); renewTimer.unref();
  const health = (): ManagedOneHealth => {
    const ready = accepting && supervisorReady && !!managedOneAuthentication();
    return { hostId: config.hostId, generation: config.generation, supervisorSchema: "agentlas.one-supervisor.v1", executor: "agentlas-cloud", supervisorReady: ready,
      relayReady: ready && bridge.mobileBridgeRelayReady(), capabilities: { one: ready, work: ready, goal: false, computerUse: false } };
  };
  const expected = Buffer.from(`Bearer ${config.controlBearer}`);
  const server = http.createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    response.setHeader("cache-control", "no-store"); response.setHeader("content-type", "application/json");
    const send = (status: number, value: unknown) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(401, { error: "managed_one_control_unauthenticated" }); return; }
    const run = async () => {
      if (request.method === "GET" && request.url === "/health") return send(200, health());
      if (request.method === "POST" && ["/drain","/pair"].includes(request.url ?? "")) {
        let body = "";
        for await (const chunk of request) { body += chunk.toString(); if (Buffer.byteLength(body) > 2048) return send(400, { error: "managed_one_control_body_invalid" }); }
        let input: unknown; try { input = body ? JSON.parse(body) : {}; } catch { return send(400, { error: "managed_one_control_body_invalid" }); }
        const keys = request.url === "/drain" ? ["hostId","generation","exit"] : ["hostId","generation","requestId"];
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) return send(400, { error: "managed_one_control_body_invalid" });
        const command=input as {hostId?:unknown;generation?:unknown;exit?:unknown;requestId?:unknown};
        if (command.hostId !== config.hostId || command.generation !== config.generation) return send(409, { error: "managed_one_control_generation_changed" });
        if (request.url === "/drain") {
          if (Object.hasOwn(command,"exit") && command.exit !== true) return send(400, { error: "managed_one_control_body_invalid" });
          const confirmed = stopped || await drain();
          if (confirmed && command.exit) response.once("finish", () => options.onDrained?.());
          send(confirmed ? 200 : 503, { stopped: confirmed }); return;
        }
        if (typeof command.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(command.requestId)) return send(400, { error: "managed_one_control_body_invalid" });
        if (!health().supervisorReady || !health().relayReady) return send(503, { error: "managed_one_host_not_ready" });
        assertOwner(); const payload = await bridge.issueMobileBridgePairing(); assertOwner();
        return send(200, { pairingUri: JSON.stringify(payload) });
      }
      send(404, { error: "managed_one_control_method_unknown" });
    };
    void run().catch(() => send(503, { error: "managed_one_control_unavailable" }));
  });
  server.requestTimeout = 25_000; server.headersTimeout = 10_000; server.maxHeadersCount = 24;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, health, drain, renew, close: async () => { await drain(); await new Promise<void>(resolve=>server.close(()=>resolve())); } };
}
