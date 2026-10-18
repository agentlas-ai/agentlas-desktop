import {currentOneMobileSecureAdapter} from "../secrets/one-mobile-secure";
import { MobilePushService } from "./push";
import { cancelInvocationOwnerRun, invocationCurrentTurnControl } from "../runtime/invocation-owner-control";
import { desktopGoalControlServices } from "./goal-control";
import os from "node:os";
import { randomBytes } from "node:crypto";

import type {
  MobileBridgeDeviceSummary,
  MobileBridgeRuntimeStatus,
} from "../../shared/types";
import {
  MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  type MobileBridgePairingPayload,
} from "../../shared/mobile-bridge";
import { createMobileBridgeAuthority, observeMobilePushNotices, type MobileBridgeAuthorityHandle } from "./authority";
import {
  MobileBridgePairingManager,
  createMobileBridgePairingPayload,
  loadOrCreateMobileBridgeCredential,
  loadOrCreateMobileBridgeHostIdentity,
  readMobileBridgeEndpointManifest,
  revokeAllStoredMobileBridgeDevices,
  revokeMobileBridgeDevicesForOtherAccounts,
  writeMobileBridgeEndpointManifest,
  type MobileBridgeEndpointManifest,
  type MobileBridgePairingChangeReason,
} from "./pairing";
import { MobileBridgeRequestReplayStore } from "./replay";
import { AgentlasMobileBridgeServer } from "./server";
import { MobileBridgeAccountPairingClient } from "./account-pairing";
import { MobileBridgeCloudRelay, type MobileBridgeRelayAuthentication } from "./relay";
import { loadOrCreateMobileBridgeTls, preferredMobileBridgeHost } from "./tls";
import { getAuthSession, getSessionCookieHeader, getAuthenticatedSessionBinding } from "../auth";
import { toolApprovalConsentActorBinding } from "../runtime/host-tool-permission-policy";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import type { ToolApprovalRequestEvent } from "../../shared/types";
import type { NativeMobileApprovalAuthorizer, NativeMobileApprovalSource, NativeMobileApprovalSelection } from "../invocation/native-gui-controls";
import type { MobileNativeToolApprovalPort } from "./authority";
import type { MobileBridgeConnectionContext, MobileBridgeConnectionLease } from "./server";
import {
  createDesktopMobileTerminalControl,
  type DesktopMobileTerminalControl,
} from "./terminal-control";
import type { MobileVisualSessionControl } from "./visual-session";

export interface MobileBridgeRuntimeOptions {
  /** Native host authority; omitted by Desktop, exclusive when supplied by a service. */
  hostAuthority?: Readonly<{
    sessionActive(): boolean;
    workspaceId(): string | null;
    relayAuthentication: MobileBridgeRelayAuthentication;
    relayEndpoint?: string;
    goalControl: false;
  }>;
  userDataPath: string;
  appVersion: string;
  displayName?: string;
  visualSessionControl?: MobileVisualSessionControl;
  nativeToolApprovals?: (authorize: NativeMobileApprovalAuthorizer) => NativeMobileApprovalSource | null;
}

/** Host-only session enrollment and original-account validation; no model or network call. */
export function createMobileNativeToolApprovalPort(ports: {
  source(authorize: NativeMobileApprovalAuthorizer): NativeMobileApprovalSource | null;
  actor(): { userId: string; workspaceId: string; sessionId: string } | null;
  pairedWorkspace(deviceId: string): string | null;
  actorBinding?: typeof toolApprovalConsentActorBinding;
}): MobileNativeToolApprovalPort {
  const sessions = new WeakMap<object, { digest: string; lease: MobileBridgeConnectionLease; actor: string }>();
  // Source identity tombstones are not an admission quota. Unknown old approvals
  // select only their native route and never gate fresh independent turns.
  const known = new Map<string, { key: string; selection: WeakRef<NativeMobileApprovalSelection> }>();
  let disposed = false;
  const actorNow = () => { const actor = ports.actor(); if (!actor || !actor.userId || !actor.workspaceId || !actor.sessionId) throw new Error("native_mobile_approval_account_unavailable"); return { workspaceId: actor.workspaceId, userId: actor.userId, sessionId: actor.sessionId }; };
  const assertContext = (context: object, request: ToolApprovalRequestEvent): void => {
    const state = sessions.get(context), actor = actorNow();
    if (disposed || !state || state.digest !== JSON.stringify(context) || !state.lease.current() || state.actor !== JSON.stringify(actor)) throw new Error("native_mobile_approval_connection_changed");
    const mobile = context as MobileBridgeConnectionContext;
    if (mobile.devBootstrap || ports.pairedWorkspace(mobile.deviceId) !== actor.workspaceId) throw new Error("native_mobile_approval_pair_changed");
    const expected = (ports.actorBinding ?? toolApprovalConsentActorBinding)(request, actor);
    if (!request.consentBinding || request.consentBinding.userIdentity !== expected.userIdentity || request.consentBinding.workspaceIdentity !== expected.workspaceIdentity) throw new Error("native_mobile_approval_original_account_required");
  };
  let source: NativeMobileApprovalSource | null = null;
  const currentSource = () => source ??= ports.source(assertContext);
  function capture(id: string): NativeMobileApprovalSelection | undefined {
    const actual = currentSource()?.select(id), prior = known.get(id);
    if (actual) {
      if (prior && prior.key !== actual.sourceKey) throw new Error("native_mobile_approval_source_conflict");
      known.set(id, { key: actual.sourceKey, selection: new WeakRef(actual) }); return actual;
    }
    return prior?.selection.deref();
  }
  return {
    connectionOpened(context, lease) {
      // Older callers without the actual server lease retain their local path;
      // they cannot mint native Mobile authority by copying a context.
      if (disposed || !lease || typeof lease.current !== "function" || !lease.current() || context.devBootstrap) return;
      const actor = actorNow();
      if (ports.pairedWorkspace(context.deviceId) !== actor.workspaceId) throw new Error("native_mobile_approval_pair_changed");
      if (sessions.has(context)) throw new Error("native_mobile_approval_context_rebound");
      sessions.set(context, { digest: JSON.stringify(context), lease, actor: JSON.stringify(actor) });
    },
    connectionClosed(context) { sessions.delete(context); },
    list() {
      if (disposed) return [];
      let actor: ReturnType<typeof actorNow>; try { actor = actorNow(); } catch { return []; }
      return (currentSource()?.list() ?? []).filter(request => {
        if (request.mode !== "live") return false;
        try {
          capture(request.id);
          const expected = (ports.actorBinding ?? toolApprovalConsentActorBinding)(request, actor);
          return !!request.consentBinding && request.consentBinding.userIdentity === expected.userIdentity && request.consentBinding.workspaceIdentity === expected.workspaceIdentity;
        } catch { return false; } // A bad native card cannot block local queues or a fresh independent turn.
      });
    },
    has(id) { if (disposed) return known.has(id); return !!capture(id) || currentSource()?.owns(id) === true || known.has(id); },
    async resolve(context, id, decision) {
      const selection = capture(id); if (!selection || disposed) throw new Error("native_mobile_approval_unavailable");
      return selection.resolve(context, decision, toolApprovalActionId(id, decision));
    },
    subscribe(listener) { return currentSource()?.subscribe(listener) ?? (() => {}); },
    dispose() { disposed = true; source = null; known.clear(); },
  };
}

interface RunningBridge {
  authority: MobileBridgeAuthorityHandle;
  pairing: MobileBridgePairingManager;
  accountPairing: MobileBridgeAccountPairingClient;
  server: AgentlasMobileBridgeServer;
  relay: MobileBridgeCloudRelay;
  push: MobilePushService | null;
  stopPushObserver: () => void;
  manifest: MobileBridgeEndpointManifest;
  terminalControl: DesktopMobileTerminalControl;
}

let running: RunningBridge | null = null;
let lastError: string | null = null;
let runtimeOptions: MobileBridgeRuntimeOptions | null = null;
let networkWatchTimer: NodeJS.Timeout | null = null;
let lifecycleTail: Promise<void> = Promise.resolve();
export type MobileBridgeStateChangeReason =
  | MobileBridgePairingChangeReason
  | "runtime-started"
  | "runtime-stopped"
  | "runtime-rebinding"
  | "runtime-retried"
  | "network-rebound"
  | "runtime-retry-failed";
const stateChangeListeners = new Set<(reason: MobileBridgeStateChangeReason) => void>();

function emitMobileBridgeStateChange(reason: MobileBridgeStateChangeReason): void {
  for (const listener of stateChangeListeners) {
    try { listener(reason); } catch {}
  }
}

export function onMobileBridgeStateChanged(
  listener: (reason: MobileBridgeStateChangeReason) => void,
): () => void {
  stateChangeListeners.add(listener);
  return () => stateChangeListeners.delete(listener);
}

function configuredPort(fallback?: number): number {
  const raw = process.env.AGENTLAS_MOBILE_BRIDGE_PORT?.trim();
  if (!raw) return fallback ?? 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error("AGENTLAS_MOBILE_BRIDGE_PORT must be an integer from 0 to 65535");
  }
  return value;
}

function retainedEndpointPort(options: MobileBridgeRuntimeOptions): number | undefined {
  if (process.env.AGENTLAS_MOBILE_BRIDGE_PORT?.trim()) return undefined;
  try {
    const port = readMobileBridgeEndpointManifest(options.userDataPath)?.port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
      ? port
      : undefined;
  } catch {
    return undefined;
  }
}

function addressAlreadyInUse(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code?: unknown }).code === "EADDRINUSE";
  }
  return /EADDRINUSE|address already in use/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

const LOOPBACK_HOST = "127.0.0.1";

function configuredHost(override?: string): string {
  const explicit = process.env.AGENTLAS_MOBILE_BRIDGE_HOST?.trim();
  // A missing LAN address is NOT fatal. Binding loopback still starts the local
  // server and its Cloud Relay tunnel, so remote access keeps working through
  // the relay exactly like Codex/Claude do on Windows — the previous behavior
  // (throw when no LAN address) killed the relay too, which is why the bridge
  // appeared completely dead on machines whose real address sits on a
  // vEthernet/WSL adapter or behind a firewall. The network watcher promotes
  // the bind to a concrete LAN address the moment one becomes routable.
  const host = explicit || override || automaticHostOrNull() || LOOPBACK_HOST;
  if (!host || /[/?#@\s]/.test(host) || host === "0.0.0.0" || host === "::") {
    throw new Error("AGENTLAS_MOBILE_BRIDGE_HOST must be a concrete LAN address or hostname");
  }
  return host;
}

function explicitHostConfigured(): boolean {
  return Boolean(process.env.AGENTLAS_MOBILE_BRIDGE_HOST?.trim());
}

function automaticHostOrNull(): string | null {
  try {
    return preferredMobileBridgeHost();
  } catch {
    return null;
  }
}

function serializeLifecycle<T>(work: () => Promise<T>): Promise<T> {
  const run = lifecycleTail.then(work, work);
  lifecycleTail = run.then(() => undefined, () => undefined);
  return run;
}

function networkWatchIntervalMs(): number {
  const configured = Number(process.env.AGENTLAS_MOBILE_BRIDGE_NETWORK_WATCH_MS);
  return Number.isFinite(configured)
    ? Math.max(1_000, Math.min(60_000, Math.floor(configured)))
    : 5_000;
}

function ensureNetworkWatcher(): void {
  if (networkWatchTimer || explicitHostConfigured()) return;
  networkWatchTimer = setInterval(() => {
    if (!running) return;
    // The desired bind is the best automatic LAN address, or loopback when none
    // is routable. Rebinding loopback<->LAN keeps direct pairing available
    // whenever the network allows it, and never tears the bridge (or its relay)
    // down just because a LAN address came or went.
    const desired = automaticHostOrNull() ?? LOOPBACK_HOST;
    if (running.manifest.bindHost === desired) {
      lastError = null;
      return;
    }
    void rebindAgentlasMobileBridge("network-rebound", desired).catch((error) => {
      console.error("[mobile-bridge] automatic network rebind failed", error instanceof Error ? error.message : String(error));
    });
  }, networkWatchIntervalMs());
  networkWatchTimer.unref?.();
}

async function startBridgeInternal(
  options: MobileBridgeRuntimeOptions,
  overrides: { host?: string; port?: number } = {},
): Promise<MobileBridgeRuntimeStatus> {
  if (running) return mobileBridgeRuntimeStatus();
  lastError = null;
  // A credential issued under an earlier account must never become USABLE on a
  // signed-out boot — but it must not be deleted either. Wiping here (plus on
  // TTL expiry and on every re-sign-in) is what left 39 of 39 paired devices
  // revoked on a real machine. Serving is gated by desktopSessionActive below;
  // the credential survives so signing back in restores the pairing.
  const identity = loadOrCreateMobileBridgeHostIdentity(options.userDataPath);
  const accountPairing = new MobileBridgeAccountPairingClient();
  let push: MobilePushService | null = null;
  let relay: MobileBridgeCloudRelay | null = null;
  let stopPushObserver = () => {};
  const pairing = new MobileBridgePairingManager(options.userDataPath, {
    consumePairingAssertion: (input) => accountPairing.consumePairingAssertion(input),
    desktopSessionActive: () => Boolean(getSessionCookieHeader()),
    desktopWorkspaceId: () => getAuthSession().workspaceId ?? null,
    ...(options.hostAuthority ? { desktopSessionActive:options.hostAuthority.sessionActive, desktopWorkspaceId:options.hostAuthority.workspaceId } : {}),
    validateAccountAuthority: async (input) => {
      // A credential bound to a different authority origin is a definitive
      // mismatch. Everything else defers to the authority's own tri-state, so
      // an outage can never be read as "this account is gone".
      if (input.accountAuthorityOrigin !== accountPairing.origin) return "inactive";
      return accountPairing.accountAuthorityStatus({ accountSubject: input.accountSubject });
    },
    onChanged: (reason) => {
      // 새 기기가 붙으면 릴레이의 "재페어링 필요" 래치를 푼다 — 그 래치는
      // 폐기된 자격으로 무한 재시도하던 것을 막는 것이지, 새 페어링을 막는 게 아니다.
      if (reason === "device-paired") relay?.clearRepairRequiredLatch();
      try { push?.prune(); } catch { console.warn("[mobile-push] registration store unavailable"); }
      emitMobileBridgeStateChange(reason);
    },
  });
  const replayStore = new MobileBridgeRequestReplayStore(options.userDataPath);
  const displayName = (options.displayName?.trim() || os.hostname() || "Agentlas Desktop").slice(0, 160);
  const terminalControl = createDesktopMobileTerminalControl();
  try {
    push = new MobilePushService({ userDataPath: options.userDataPath, hostId: identity.hostId,
      currentWorkspaceId: () => options.hostAuthority ? (options.hostAuthority.sessionActive() ? options.hostAuthority.workspaceId() : null) : getSessionCookieHeader() ? getAuthSession().workspaceId ?? null : null,
      deviceWorkspaceId: (deviceId) => pairing.deviceWorkspaceId(deviceId),
      supportsPlatform: (platform) => relay?.supportsPush(platform) ?? false,
      publish: (payload) => relay?.publishPush(payload) ?? Promise.resolve("unavailable"),
    });
  } catch { console.warn("[mobile-push] registration store unavailable; push capability disabled"); }
  const nativeToolApprovals = options.nativeToolApprovals ? createMobileNativeToolApprovalPort({
    source: options.nativeToolApprovals,
    actor: getAuthenticatedSessionBinding,
    pairedWorkspace: deviceId => pairing.deviceWorkspaceId(deviceId),
  }) : undefined;
  const authority = createMobileBridgeAuthority({
    ...(nativeToolApprovals ? { nativeToolApprovals } : {}),
    oneSecure: currentOneMobileSecureAdapter,
    currentTurnControl: invocationCurrentTurnControl,
    cancelInvocationRun: cancelInvocationOwnerRun,
    ...(push ? { mobilePush: push } : {}),
    goalControl: options.hostAuthority?.goalControl === false ? undefined : desktopGoalControlServices(),
    hostIdentity: identity,
    displayName,
    appVersion: options.appVersion,
    revokeDevice: (deviceId, cause) => pairing.revokeDevice(deviceId, cause ?? "device_requested"),
    // Mail/profile reads and writes are for the account the phone was paired
    // under only (EDGE-CASES S8/M6).
    mailAccountGuard: (deviceId) => {
      if (options.hostAuthority ? !options.hostAuthority.sessionActive() : !getSessionCookieHeader()) return "signed-out";
      const active = options.hostAuthority ? options.hostAuthority.workspaceId() : getAuthSession().workspaceId ?? null;
      const paired = pairing.deviceWorkspaceId(deviceId);
      if (!active || !paired) return "unknown";
      return active === paired ? "ok" : "mismatch";
    },
    terminalControl,
    visualSessionControl: options.visualSessionControl,
    onError: (error) => console.error("[mobile-bridge-authority]", error.message),
  });
  let server: AgentlasMobileBridgeServer | null = null;
  try {
    const tls = await loadOrCreateMobileBridgeTls(options.userDataPath);
    if (tls.rotated && pairing.listDevices().length > 0) {
      // A new certificate fingerprint means the pins on already-paired phones
      // no longer match. Surface it instead of letting them fail silently — the
      // user needs to re-scan a pairing QR. With the century-long lifetime this
      // is only reachable on genuine key loss, never on routine near-expiry.
      lastError =
        "The Mobile Bridge security certificate changed. Paired phones must scan a new pairing QR code to reconnect.";
      console.warn("[mobile-bridge] certificate rotated while devices are paired; phones must re-pair");
    }
    const devBootstrap =
      process.env.NODE_ENV === "development" &&
      process.env.AGENTLAS_MOBILE_BRIDGE_DEV_BOOTSTRAP === "1"
        ? loadOrCreateMobileBridgeCredential(options.userDataPath).token
        : undefined;
    server = new AgentlasMobileBridgeServer({
      authority,
      pairing,
      replayStore,
      devBootstrapToken: devBootstrap,
      host: configuredHost(overrides.host),
      port: configuredPort(overrides.port),
      tls: tls.serverOptions,
      relayPairingInfo: () => relay?.pairingInfo() ?? null,
      onError: (error) => console.error("[mobile-bridge]", error.message),
    });
    const address = await server.start();
    const manifest: MobileBridgeEndpointManifest = {
      version: MOBILE_BRIDGE_PROTOCOL_VERSION,
      hostId: identity.hostId,
      displayName,
      path: address.path,
      pairExchangePath: MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
      bindHost: address.host,
      port: address.port,
      secure: address.secure,
      url: address.url,
      certificateFingerprint: tls.certificateFingerprint,
      certificateDer: tls.certificateDer,
      updatedAt: new Date().toISOString(),
    };
    writeMobileBridgeEndpointManifest(options.userDataPath, manifest);
    relay = new MobileBridgeCloudRelay({
      ...(options.hostAuthority ? { authentication:options.hostAuthority.relayAuthentication, relayEndpoint:options.hostAuthority.relayEndpoint } : {}),
      userDataPath: options.userDataPath,
      hostId: identity.hostId,
      localEndpoint: manifest.url,
      certificateDer: tls.certificateDer,
      onStatusChanged: () => emitMobileBridgeStateChange("runtime-started"),
      onPairFrame: (frameText) => server!.handleRelayPairFrame(frameText),
    });
    if (push) {
      const service = push;
      stopPushObserver = observeMobilePushNotices(identity.hostId, (notice, stillCurrent) => {
        void service.dispatch(notice, stillCurrent).catch(() => console.warn("[mobile-push] dispatch unavailable"));
      });
    }
    running = { authority, pairing, accountPairing, server, relay, push, stopPushObserver, manifest, terminalControl };
    relay.start();
    emitMobileBridgeStateChange("runtime-started");
    console.info(`[mobile-bridge] listening on ${address.url}`);
    return mobileBridgeRuntimeStatus();
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    stopPushObserver();
    push?.dispose();
    relay?.stop();
    if (server) await server.close().catch(() => {});
    await terminalControl.dispose();
    pairing.dispose();
    authority.dispose();
    throw error;
  }
}

async function stopRunningBridge(emitStopped: boolean): Promise<void> {
  const state = running;
  running = null;
  if (!state) return;
  try {
    state.stopPushObserver();
    state.push?.dispose();
    state.relay.stop();
    await state.server.close();
  } finally {
    await state.terminalControl.dispose();
    state.pairing.dispose();
    state.authority.dispose();
    if (emitStopped) emitMobileBridgeStateChange("runtime-stopped");
  }
}

export async function startAgentlasMobileBridge(
  options: MobileBridgeRuntimeOptions,
): Promise<MobileBridgeRuntimeStatus> {
  runtimeOptions = { ...options };
  ensureNetworkWatcher();
  return serializeLifecycle(async () => {
    // A paired phone stores this endpoint. Reusing the last port means closing
    // and reopening Desktop restores the same secure WebSocket automatically.
    const retainedPort = retainedEndpointPort(options);
    const retryDelaysMs = [1_000, 2_000, 3_000, 4_000, 5_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await startBridgeInternal(options, {
          ...(retainedPort ? { port: retainedPort } : {}),
        });
      } catch (error) {
        if (!retainedPort || !addressAlreadyInUse(error)) throw error;
        // During an app update/restart the outgoing instance (or its socket in
        // TIME_WAIT) can still hold the retained port for a few seconds. Losing
        // the port silently invalidates every paired phone's stored endpoint,
        // so wait the port out before surrendering it.
        const delayMs = retryDelaysMs[attempt];
        if (delayMs === undefined) {
          // Another process genuinely owns the old port. Keep Desktop usable
          // with a new port; the user repairs that exceptional case by pairing
          // again instead of losing the entire mobile bridge.
          console.warn(
            `[mobile-bridge] retained port ${retainedPort} stayed busy; falling back to an ephemeral port (paired phones need a new QR)`,
          );
          return startBridgeInternal(options, { port: 0 });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
      }
    }
  });
}

async function rebindAgentlasMobileBridge(
  reason: "runtime-retried" | "network-rebound",
  hostOverride?: string,
): Promise<MobileBridgeRuntimeStatus> {
  const options = runtimeOptions;
  if (!options) throw new Error("Agentlas Mobile Bridge has not been configured");
  return serializeLifecycle(async () => {
    emitMobileBridgeStateChange("runtime-rebinding");
    const currentManifest = running?.manifest ?? (() => {
      try { return readMobileBridgeEndpointManifest(options.userDataPath); } catch { return null; }
    })();
    const retainedPort = process.env.AGENTLAS_MOBILE_BRIDGE_PORT?.trim()
      ? undefined
      : currentManifest?.port;
    await stopRunningBridge(false);
    try {
      const status = await startBridgeInternal(options, {
        ...(hostOverride ? { host: hostOverride } : {}),
        ...(retainedPort ? { port: retainedPort } : {}),
      });
      emitMobileBridgeStateChange(reason);
      return status;
    } catch (error) {
      emitMobileBridgeStateChange("runtime-retry-failed");
      throw error;
    }
  });
}

/** Settings recovery action; preserves host identity, device records, TLS pin, and port. */
export function retryAgentlasMobileBridge(): Promise<MobileBridgeRuntimeStatus> {
  return rebindAgentlasMobileBridge("runtime-retried");
}

export function mobileBridgeRelayReady(): boolean { return running?.relay.ready() ?? false; }
export function refreshMobileBridgeRelayAuthentication(): void { running?.relay.refreshAuthentication(); }

export function mobileBridgeRuntimeStatus(): MobileBridgeRuntimeStatus {
  const state = running;
  return {
    running: state !== null,
    endpoint: state?.manifest.url ?? null,
    secure: state?.manifest.secure ?? false,
    hostId: state?.manifest.hostId ?? null,
    devices: state ? state.pairing.listDevices() : [],
    connectedDeviceIds: state ? state.server.connectedDeviceIds() : [],
    error: lastError,
  };
}

export async function issueMobileBridgePairing(): Promise<MobileBridgePairingPayload> {
  const state = running;
  if (!state) throw new Error("Agentlas Mobile Bridge is not running");
  const pairingAttemptId = `pair_${randomBytes(24).toString("base64url")}`;
  const accountProof = await state.accountPairing.issueDesktopProof({
    hostId: state.manifest.hostId,
    pairingAttemptId,
  });
  // A network rebind replaces the server/manifest. Never attach a proof minted
  // for the outgoing host instance to the replacement pairing endpoint.
  if (running !== state) throw new Error("Agentlas Mobile Bridge changed while preparing the pairing proof");
  const challenge = state.pairing.issueChallenge(accountProof);
  return createMobileBridgePairingPayload(challenge, state.manifest);
}

export function listMobileBridgeDevices(): MobileBridgeDeviceSummary[] {
  return running?.pairing.listDevices() ?? [];
}

export function revokeMobileBridgeDevice(deviceId: string): { ok: boolean } {
  if (!running) return { ok: false };
  const ok = running.pairing.revokeDevice(deviceId, "owner_removed_device");
  if (ok) running.server.disconnectDevice(deviceId);
  return { ok };
}

/**
 * Reconciles pairing credentials against the account now signed in.
 *
 * Only a PROVEN identity change revokes: a credential whose recorded workspace
 * differs from the active one. Failing to prove identity — TTL expiry, a
 * signed-out boot, an offline account-status check, the same account signing
 * in again — never revokes, because that blanket behaviour deleted every real
 * pairing on this machine (39 of 39 revoked, 0 active).
 *
 * Any outstanding QR challenge is still invalidated, and sockets belonging to
 * revoked devices are still disconnected immediately.
 */
export function reconcileMobileBridgeDevicesForAccount(
  fallbackUserDataPath?: string,
): { revoked: number } {
  const userDataPath = runtimeOptions?.userDataPath ?? fallbackUserDataPath;
  const activeWorkspaceId = getAuthSession().workspaceId ?? null;
  const state = running;
  if (!state) {
    if (!userDataPath) return { revoked: 0 };
    return { revoked: revokeMobileBridgeDevicesForOtherAccounts(userDataPath, activeWorkspaceId).length };
  }
  // A challenge minted for the previous account can never be completed.
  state.pairing.dispose();
  /*
   * 로그아웃(활성 워크스페이스 없음)이면 **지금 붙어 있는 전화를 끊는다.**
   *
   * ★ 2026-08-24 실측: 전화는 연결을 맺을 때 한 번만 인증한다. 그리고 아래 폐기 목록은
   *   로그아웃일 때 언제나 비어 있다(폐기 판정에 활성 워크스페이스가 필요하다). 그래서
   *   로그아웃해도 이미 붙어 있는 연결은 그대로 살아 계속 명령을 보낼 수 있었다 —
   *   "로그아웃하면 서빙이 멈춘다" 는 새로 연결하는 경우에만 참이었다.
   *
   *   자격은 그대로 둔다. 지우면 다시 로그인해도 되살아나지 않는다(예전에 그렇게 짝지은
   *   39대를 전부 끊은 적이 있다). 끊기만 하면 다시 붙으려면 로그인해야 하고, 로그인하면
   *   페어링이 그대로 복구된다.
   */
  if (!activeWorkspaceId) {
    const dropped = state.server.disconnectAllDevices();
    if (dropped > 0) {
      console.warn(`[mobile-bridge] disconnected ${dropped} phone(s): this Desktop is signed out (credentials kept)`);
    }
  }
  if (!userDataPath) return { revoked: 0 };
  const revoked = revokeMobileBridgeDevicesForOtherAccounts(userDataPath, activeWorkspaceId);
  try { state.push?.prune(); } catch { console.warn("[mobile-push] registration store unavailable"); }
  for (const deviceId of revoked) state.server.disconnectDevice(deviceId);
  if (revoked.length > 0) {
    console.warn(`[mobile-bridge] revoked ${revoked.length} device(s) bound to a different account`);
  }
  return { revoked: revoked.length };
}

/**
 * Explicit, user-initiated wipe (Settings → remove every paired phone). This
 * is the ONLY path that may revoke credentials without proof of an account
 * change, because the user asked for it.
 */
export function revokeAllMobileBridgeDevicesByOwner(
  fallbackUserDataPath?: string,
): { revoked: number } {
  const state = running;
  if (!state) {
    const userDataPath = runtimeOptions?.userDataPath ?? fallbackUserDataPath;
    if (!userDataPath) return { revoked: 0 };
    return { revoked: revokeAllStoredMobileBridgeDevices(userDataPath).length };
  }
  state.pairing.dispose();
  let revoked = 0;
  for (const device of state.pairing.listDevices()) {
    if (device.revokedAt !== null) continue;
    if (!state.pairing.revokeDevice(device.deviceId, "owner_removed_all")) continue;
    revoked += 1;
    state.server.disconnectDevice(device.deviceId);
  }
  return { revoked };
}

export async function stopAgentlasMobileBridge(): Promise<void> {
  runtimeOptions = null;
  if (networkWatchTimer) clearInterval(networkWatchTimer);
  networkWatchTimer = null;
  await serializeLifecycle(() => stopRunningBridge(true));
}
