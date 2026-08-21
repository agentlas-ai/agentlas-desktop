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
import { createMobileBridgeAuthority, type MobileBridgeAuthorityHandle } from "./authority";
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
import { MobileBridgeCloudRelay } from "./relay";
import { loadOrCreateMobileBridgeTls, preferredMobileBridgeHost } from "./tls";
import { getDefaultOntologyHubClient } from "./ontology-hub-client";
import { getAuthSession, getSessionCookieHeader } from "../auth";
import { listInstalledAgentHubBindings } from "../ontology/hub-bindings";
import {
  TerminalOntologyLoadoutFeedWriter,
  terminalOntologyLoadoutFeedPath,
} from "../ontology/terminal-loadout-feed";
import {
  createDesktopMobileTerminalControl,
  type DesktopMobileTerminalControl,
} from "./terminal-control";

interface MobileBridgeRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  displayName?: string;
}

interface RunningBridge {
  authority: MobileBridgeAuthorityHandle;
  pairing: MobileBridgePairingManager;
  accountPairing: MobileBridgeAccountPairingClient;
  server: AgentlasMobileBridgeServer;
  relay: MobileBridgeCloudRelay;
  manifest: MobileBridgeEndpointManifest;
  terminalLoadoutFeedWriter: TerminalOntologyLoadoutFeedWriter;
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
  const pairing = new MobileBridgePairingManager(options.userDataPath, {
    consumePairingAssertion: (input) => accountPairing.consumePairingAssertion(input),
    desktopSessionActive: () => Boolean(getSessionCookieHeader()),
    desktopWorkspaceId: () => getAuthSession().workspaceId ?? null,
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
      emitMobileBridgeStateChange(reason);
    },
  });
  const replayStore = new MobileBridgeRequestReplayStore(options.userDataPath);
  const displayName = (options.displayName?.trim() || os.hostname() || "Agentlas Desktop").slice(0, 160);
  const ontologyHubClient = getDefaultOntologyHubClient(options.userDataPath);
  const terminalLoadoutFeedFile = terminalOntologyLoadoutFeedPath(options.userDataPath);
  const terminalLoadoutFeedWriter = new TerminalOntologyLoadoutFeedWriter(terminalLoadoutFeedFile);
  const terminalControl = createDesktopMobileTerminalControl();
  const authority = createMobileBridgeAuthority({
    hostIdentity: identity,
    displayName,
    appVersion: options.appVersion,
    revokeDevice: (deviceId, cause) => pairing.revokeDevice(deviceId, cause ?? "device_requested"),
    ontologyHubClient,
    terminalOntologyLoadoutFeedWriter: terminalLoadoutFeedWriter,
    terminalControl,
    onError: (error) => console.error("[mobile-bridge-authority]", error.message),
  });
  let server: AgentlasMobileBridgeServer | null = null;
  let relay: MobileBridgeCloudRelay | null = null;
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
      userDataPath: options.userDataPath,
      hostId: identity.hostId,
      localEndpoint: manifest.url,
      certificateDer: tls.certificateDer,
      onStatusChanged: () => emitMobileBridgeStateChange("runtime-started"),
    });
    running = { authority, pairing, accountPairing, server, relay, manifest, terminalLoadoutFeedWriter, terminalControl };
    relay.start();
    // Refresh once at Desktop startup even when no phone is connected. This is
    // a read-only Hub query; the independent Terminal still has to opt in with
    // an explicit CLI flag and revalidates the exact local DB binding.
    const exactBindings = listInstalledAgentHubBindings(64);
    if (exactBindings.length > 0) {
      void ontologyHubClient.query(exactBindings.map((binding) => ({
        agentDefinitionId: binding.agentDefinitionId,
        agentReleaseId: binding.agentReleaseId,
      })), true).then((result) => {
        terminalLoadoutFeedWriter.write({
          bindings: exactBindings,
          result,
        });
      }).catch((error) => {
        try {
          terminalLoadoutFeedWriter.write({
            bindings: exactBindings,
            result: { supported: false, status: "endpoint-absent", projections: [] },
          });
        } catch {}
        console.error(
          "[terminal-loadout] startup projection failed",
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    emitMobileBridgeStateChange("runtime-started");
    console.info(`[mobile-bridge] listening on ${address.url}`);
    return mobileBridgeRuntimeStatus();
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    relay?.stop();
    if (server) await server.close().catch(() => {});
    terminalLoadoutFeedWriter.dispose();
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
    state.relay.stop();
    await state.server.close();
  } finally {
    state.terminalLoadoutFeedWriter.dispose();
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
  if (!userDataPath) return { revoked: 0 };
  const revoked = revokeMobileBridgeDevicesForOtherAccounts(userDataPath, activeWorkspaceId);
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
