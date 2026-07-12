import os from "node:os";

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
  writeMobileBridgeEndpointManifest,
  type MobileBridgeEndpointManifest,
  type MobileBridgePairingChangeReason,
} from "./pairing";
import { MobileBridgeRequestReplayStore } from "./replay";
import { AgentlasMobileBridgeServer } from "./server";
import { loadOrCreateMobileBridgeTls, preferredMobileBridgeHost } from "./tls";

interface MobileBridgeRuntimeOptions {
  userDataPath: string;
  appVersion: string;
  displayName?: string;
}

interface RunningBridge {
  authority: MobileBridgeAuthorityHandle;
  pairing: MobileBridgePairingManager;
  server: AgentlasMobileBridgeServer;
  manifest: MobileBridgeEndpointManifest;
}

let running: RunningBridge | null = null;
let lastError: string | null = null;
let runtimeOptions: MobileBridgeRuntimeOptions | null = null;
let networkWatchTimer: NodeJS.Timeout | null = null;
let lastObservedAutomaticHost: string | null = null;
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

function configuredHost(override?: string): string {
  const host = process.env.AGENTLAS_MOBILE_BRIDGE_HOST?.trim() || override || preferredMobileBridgeHost();
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
  lastObservedAutomaticHost = automaticHostOrNull();
  networkWatchTimer = setInterval(() => {
    const selected = automaticHostOrNull();
    if (selected === lastObservedAutomaticHost) return;
    lastObservedAutomaticHost = selected;
    if (!selected) {
      lastError = "No usable LAN address is currently available for Agentlas Mobile Bridge";
      emitMobileBridgeStateChange("runtime-retry-failed");
      return;
    }
    if (running?.manifest.bindHost === selected) {
      lastError = null;
      return;
    }
    void rebindAgentlasMobileBridge("network-rebound", selected).catch((error) => {
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
  const identity = loadOrCreateMobileBridgeHostIdentity(options.userDataPath);
  const pairing = new MobileBridgePairingManager(options.userDataPath, {
    onChanged: emitMobileBridgeStateChange,
  });
  const replayStore = new MobileBridgeRequestReplayStore(options.userDataPath);
  const displayName = (options.displayName?.trim() || os.hostname() || "Agentlas Desktop").slice(0, 160);
  const authority = createMobileBridgeAuthority({
    hostIdentity: identity,
    displayName,
    appVersion: options.appVersion,
    revokeDevice: (deviceId) => pairing.revokeDevice(deviceId),
    onError: (error) => console.error("[mobile-bridge-authority]", error.message),
  });
  let server: AgentlasMobileBridgeServer | null = null;
  try {
    const tls = await loadOrCreateMobileBridgeTls(options.userDataPath);
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
    running = { authority, pairing, server, manifest };
    if (!explicitHostConfigured()) lastObservedAutomaticHost = address.host;
    emitMobileBridgeStateChange("runtime-started");
    console.info(`[mobile-bridge] listening on ${address.url}`);
    return mobileBridgeRuntimeStatus();
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    if (server) await server.close().catch(() => {});
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
    await state.server.close();
  } finally {
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
  return serializeLifecycle(() => startBridgeInternal(options));
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
    error: lastError,
  };
}

export function issueMobileBridgePairing(): MobileBridgePairingPayload {
  if (!running) throw new Error("Agentlas Mobile Bridge is not running");
  const challenge = running.pairing.issueChallenge();
  return createMobileBridgePairingPayload(challenge, running.manifest);
}

export function listMobileBridgeDevices(): MobileBridgeDeviceSummary[] {
  return running?.pairing.listDevices() ?? [];
}

export function revokeMobileBridgeDevice(deviceId: string): { ok: boolean } {
  if (!running) return { ok: false };
  const ok = running.pairing.revokeDevice(deviceId);
  if (ok) running.server.disconnectDevice(deviceId);
  return { ok };
}

export async function stopAgentlasMobileBridge(): Promise<void> {
  runtimeOptions = null;
  lastObservedAutomaticHost = null;
  if (networkWatchTimer) clearInterval(networkWatchTimer);
  networkWatchTimer = null;
  await serializeLifecycle(() => stopRunningBridge(true));
}
