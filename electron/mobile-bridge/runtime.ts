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
export type MobileBridgeStateChangeReason =
  | MobileBridgePairingChangeReason
  | "runtime-started"
  | "runtime-stopped";
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

function configuredPort(): number {
  const raw = process.env.AGENTLAS_MOBILE_BRIDGE_PORT?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error("AGENTLAS_MOBILE_BRIDGE_PORT must be an integer from 0 to 65535");
  }
  return value;
}

function configuredHost(): string {
  const host = process.env.AGENTLAS_MOBILE_BRIDGE_HOST?.trim() || preferredMobileBridgeHost();
  if (!host || /[/?#@\s]/.test(host) || host === "0.0.0.0" || host === "::") {
    throw new Error("AGENTLAS_MOBILE_BRIDGE_HOST must be a concrete LAN address or hostname");
  }
  return host;
}

export async function startAgentlasMobileBridge(
  options: MobileBridgeRuntimeOptions,
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
      host: configuredHost(),
      port: configuredPort(),
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
  const state = running;
  running = null;
  if (!state) return;
  try {
    await state.server.close();
  } finally {
    state.pairing.dispose();
    state.authority.dispose();
    emitMobileBridgeStateChange("runtime-stopped");
  }
}
