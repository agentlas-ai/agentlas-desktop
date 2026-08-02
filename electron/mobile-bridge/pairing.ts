import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE,
  MOBILE_BRIDGE_PAIR_EXCHANGE_PATH,
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  type MobileBridgePairExchangeRequest,
  type MobileBridgePairingPayload,
} from "../../shared/mobile-bridge";
import {
  MobileBridgeAccountPairingError,
  type MobileBridgeConsumedPairingAssertion,
  type MobileBridgeDesktopAccountProof,
} from "./account-pairing";

const BRIDGE_DIR = "mobile-bridge";
const HOST_IDENTITY_FILE = "identity.json";
const DEV_BOOTSTRAP_FILE = "dev-bootstrap.json";
const DEVICE_FILE = "devices.json";
const ENDPOINT_FILE = "endpoint.json";
const DEFAULT_PAIRING_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_PAIRING_ATTEMPTS = 8;

/**
 * DESKTOP_MOBILE_BRIDGE: Plaintext long-lived bootstrap credentials are allowed
 * only for an explicit current-Mac/dev gate. Production pairing uses per-device
 * token hashes in devices.json and never stores the plaintext token.
 */
export interface MobileBridgeCredential {
  version: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  hostId: string;
  token: string;
  createdAt: string;
  devOnly: true;
}

/**
 * DESKTOP_MOBILE_BRIDGE: Stable production host identity. This document is
 * secret-free and independent from pairing challenges and device credentials.
 */
export interface MobileBridgeHostIdentity {
  version: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  hostId: string;
  createdAt: string;
}

export interface MobileBridgeEndpointManifest {
  version: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  hostId: string;
  displayName: string;
  path: string;
  pairExchangePath: typeof MOBILE_BRIDGE_PAIR_EXCHANGE_PATH;
  bindHost: string;
  port: number;
  secure: boolean;
  url: string;
  certificateFingerprint: string | null;
  certificateDer: string | null;
  updatedAt: string;
}

export interface MobileBridgePairingChallenge {
  code: string;
  expiresAt: string;
  hostId: string;
  pairingAttemptId: string;
  desktopAccountProof: string;
  accountAuthorityOrigin: string;
}

interface StoredMobileBridgeDevice {
  deviceId: string;
  tokenHash: string;
  name: string;
  platform: "ios" | "android";
  appVersion: string | null;
  issuedAt: string;
  revokedAt: string | null;
  accountSubject?: string;
  accountAuthorityOrigin?: string;
}

interface StoredMobileBridgeDevices {
  version: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  devices: StoredMobileBridgeDevice[];
}

export interface MobileBridgeDeviceMetadata {
  deviceId: string;
  name: string;
  platform: "ios" | "android";
  appVersion: string | null;
  issuedAt: string;
  revokedAt: string | null;
}

export interface MobileBridgeIssuedCredential {
  deviceId: string;
  token: string;
  issuedAt: string;
}

export type MobileBridgePairingErrorCode =
  | "pairing_denied"
  | "pairing_expired"
  | "pairing_unavailable"
  | "invalid_account_assertion"
  | "account_mismatch"
  | "binding_mismatch"
  | "assertion_replayed"
  | "account_authority_unavailable";

export class MobileBridgePairingError extends Error {
  constructor(readonly code: MobileBridgePairingErrorCode, message: string) {
    super(message);
    this.name = "MobileBridgePairingError";
  }
}

export interface MobileBridgePairingManagerOptions {
  ttlMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  consumePairingAssertion?: (input: {
    pairingAssertion: string;
    audience: typeof MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE;
    hostId: string;
    deviceNonce: string;
    pairingAttemptId: string;
  }) => Promise<MobileBridgeConsumedPairingAssertion>;
  validateAccountAuthority?: (input: {
    accountSubject: string;
    accountAuthorityOrigin: string;
  }) => Promise<boolean>;
  onChanged?: (reason: MobileBridgePairingChangeReason) => void;
}

export type MobileBridgePairingChangeReason =
  | "challenge-issued"
  | "challenge-expired"
  | "challenge-invalidated"
  | "device-paired"
  | "device-revoked";

interface ActiveChallenge {
  codeHash: Buffer;
  expiresAtMs: number;
  attempts: number;
  hostId: string;
  pairingAttemptId: string;
  desktopAccountProof: string;
  expectedAccountSubject: string;
  accountAuthorityOrigin: string;
}

function bridgeDir(userDataPath: string): string {
  return path.join(userDataPath, BRIDGE_DIR);
}

export function mobileBridgeCredentialPath(userDataPath: string): string {
  return path.join(bridgeDir(userDataPath), DEV_BOOTSTRAP_FILE);
}

export function mobileBridgeHostIdentityPath(userDataPath: string): string {
  return path.join(bridgeDir(userDataPath), HOST_IDENTITY_FILE);
}

export function mobileBridgeDeviceStorePath(userDataPath: string): string {
  return path.join(bridgeDir(userDataPath), DEVICE_FILE);
}

export function mobileBridgeEndpointManifestPath(userDataPath: string): string {
  return path.join(bridgeDir(userDataPath), ENDPOINT_FILE);
}

function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function writePrivateJsonAtomic(target: string, value: unknown): void {
  const dir = path.dirname(target);
  ensurePrivateDirectory(dir);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort after an interrupted atomic write.
    }
  }
}

function readJson(target: string): unknown {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hashSecretHex(value: string): string {
  return hashSecret(value).toString("hex");
}

function safeHashEquals(expectedHex: string, actualToken: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHex)) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "hex"), hashSecret(actualToken));
}

function validHostId(value: unknown): value is string {
  return typeof value === "string" && /^host_[a-f0-9]{32}$/.test(value);
}

function validHostIdentity(value: unknown): value is MobileBridgeHostIdentity {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["version", "hostId", "createdAt"]) &&
    value.version === MOBILE_BRIDGE_PROTOCOL_VERSION &&
    validHostId(value.hostId) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function validPairingAttemptId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(value);
}

function validAccountSubject(value: unknown): value is string {
  return typeof value === "string" && /^mps_[A-Za-z0-9_-]{43}$/.test(value);
}

function validOpaqueProof(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value);
}

function validAccountAuthorityOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    return (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      (parsed.pathname === "" || parsed.pathname === "/") && parsed.origin === value;
  } catch {
    return false;
  }
}

function sameStableValue(left: string, right: string): boolean {
  return timingSafeEqual(hashSecret(left), hashSecret(right));
}

function accountPairingFailureCode(error: unknown): MobileBridgePairingErrorCode {
  if (!(error instanceof MobileBridgeAccountPairingError)) return "account_authority_unavailable";
  switch (error.code) {
    case "invalid_proof":
    case "invalid_request":
      return "invalid_account_assertion";
    case "account_mismatch":
      return "account_mismatch";
    case "binding_mismatch":
      return "binding_mismatch";
    case "replayed":
      return "assertion_replayed";
    default:
      return "account_authority_unavailable";
  }
}

function validCredential(value: unknown): value is MobileBridgeCredential {
  return (
    isRecord(value) &&
    value.version === MOBILE_BRIDGE_PROTOCOL_VERSION &&
    validHostId(value.hostId) &&
    validToken(value.token) &&
    value.devOnly === true &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function validStoredDevice(value: unknown): value is StoredMobileBridgeDevice {
  if (!isRecord(value)) return false;
  return (
    typeof value.deviceId === "string" &&
    /^device_[a-f0-9]{32}$/.test(value.deviceId) &&
    typeof value.tokenHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.tokenHash) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 120 &&
    (value.platform === "ios" || value.platform === "android") &&
    (value.appVersion === null || typeof value.appVersion === "string") &&
    typeof value.issuedAt === "string" &&
    Number.isFinite(Date.parse(value.issuedAt)) &&
    (value.revokedAt === null || (typeof value.revokedAt === "string" && Number.isFinite(Date.parse(value.revokedAt)))) &&
    (
      (value.accountSubject === undefined && value.accountAuthorityOrigin === undefined) ||
      (validAccountSubject(value.accountSubject) && validAccountAuthorityOrigin(value.accountAuthorityOrigin))
    )
  );
}

function readDevices(userDataPath: string): StoredMobileBridgeDevices {
  const target = mobileBridgeDeviceStorePath(userDataPath);
  if (!fs.existsSync(target)) return { version: MOBILE_BRIDGE_PROTOCOL_VERSION, devices: [] };
  const parsed = readJson(target);
  if (
    !isRecord(parsed) ||
    parsed.version !== MOBILE_BRIDGE_PROTOCOL_VERSION ||
    !Array.isArray(parsed.devices) ||
    !parsed.devices.every(validStoredDevice)
  ) {
    throw new Error("Agentlas Mobile Bridge device credential store is invalid");
  }
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  return parsed as unknown as StoredMobileBridgeDevices;
}

function writeDevices(userDataPath: string, store: StoredMobileBridgeDevices): void {
  writePrivateJsonAtomic(mobileBridgeDeviceStorePath(userDataPath), store);
}

/**
 * Revokes every durable phone credential when Desktop account authority is
 * lost or replaced. This also works while the bridge server is stopped, so a
 * failed bind cannot leave an old-account bearer token valid for the next
 * successful start.
 */
export function revokeAllStoredMobileBridgeDevices(
  userDataPath: string,
  now: Date = new Date(),
): string[] {
  const store = readDevices(userDataPath);
  const revokedAt = now.toISOString();
  const revoked: string[] = [];
  for (const device of store.devices) {
    if (device.revokedAt !== null) continue;
    device.revokedAt = revokedAt;
    revoked.push(device.deviceId);
  }
  if (revoked.length > 0) writeDevices(userDataPath, store);
  return revoked;
}

/**
 * DESKTOP_MOBILE_BRIDGE: This is the sole durable source for the Desktop host
 * id. Corrupt or shape-expanded files fail closed and are never regenerated in
 * place, so a damaged identity cannot silently fork the paired host.
 */
export function loadOrCreateMobileBridgeHostIdentity(
  userDataPath: string,
  now: Date = new Date(),
): MobileBridgeHostIdentity {
  const target = mobileBridgeHostIdentityPath(userDataPath);
  if (fs.existsSync(target)) {
    const parsed = readJson(target);
    if (!validHostIdentity(parsed)) {
      throw new Error("Agentlas Mobile Bridge host identity is invalid; explicit recovery is required");
    }
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
    return parsed;
  }
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid Mobile Bridge host identity timestamp");
  const identity: MobileBridgeHostIdentity = {
    version: MOBILE_BRIDGE_PROTOCOL_VERSION,
    hostId: `host_${randomBytes(16).toString("hex")}`,
    createdAt: now.toISOString(),
  };
  writePrivateJsonAtomic(target, identity);
  return identity;
}

/**
 * DESKTOP_MOBILE_BRIDGE: Current-Mac test bootstrap only. Production main.ts
 * must not call this unless AGENTLAS_MOBILE_BRIDGE_DEV_BOOTSTRAP=1 is explicit.
 */
export function loadOrCreateMobileBridgeCredential(
  userDataPath: string,
  now: Date = new Date(),
  allowDevBootstrap = process.env.AGENTLAS_MOBILE_BRIDGE_DEV_BOOTSTRAP === "1",
): MobileBridgeCredential {
  if (!allowDevBootstrap) throw new Error("Mobile Bridge plaintext bootstrap credential is disabled");
  const identity = loadOrCreateMobileBridgeHostIdentity(userDataPath, now);
  const target = mobileBridgeCredentialPath(userDataPath);
  if (fs.existsSync(target)) {
    const parsed = readJson(target);
    if (!validCredential(parsed)) {
      throw new Error("Agentlas Mobile Bridge bootstrap credential is invalid; explicit rotation is required");
    }
    if (parsed.hostId !== identity.hostId) {
      throw new Error("Agentlas Mobile Bridge bootstrap credential does not match the host identity");
    }
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
    return parsed;
  }
  const credential: MobileBridgeCredential = {
    version: MOBILE_BRIDGE_PROTOCOL_VERSION,
    hostId: identity.hostId,
    token: randomBytes(32).toString("base64url"),
    createdAt: now.toISOString(),
    devOnly: true,
  };
  writePrivateJsonAtomic(target, credential);
  return credential;
}

export function rotateMobileBridgeCredential(
  userDataPath: string,
  now: Date = new Date(),
  allowDevBootstrap = process.env.AGENTLAS_MOBILE_BRIDGE_DEV_BOOTSTRAP === "1",
): MobileBridgeCredential {
  if (!allowDevBootstrap) throw new Error("Mobile Bridge plaintext bootstrap credential is disabled");
  const identity = loadOrCreateMobileBridgeHostIdentity(userDataPath, now);
  const credential: MobileBridgeCredential = {
    version: MOBILE_BRIDGE_PROTOCOL_VERSION,
    hostId: identity.hostId,
    token: randomBytes(32).toString("base64url"),
    createdAt: now.toISOString(),
    devOnly: true,
  };
  writePrivateJsonAtomic(mobileBridgeCredentialPath(userDataPath), credential);
  return credential;
}

function validManifest(value: MobileBridgeEndpointManifest): void {
  if (value.version !== MOBILE_BRIDGE_PROTOCOL_VERSION) throw new Error("Invalid Mobile Bridge manifest version");
  if (!validHostId(value.hostId)) throw new Error("Invalid Mobile Bridge host id");
  if (!value.displayName.trim() || value.displayName.length > 160) throw new Error("Invalid Mobile Bridge display name");
  if (!value.path.startsWith("/") || value.path.includes("?") || value.path.includes("#")) {
    throw new Error("Invalid Mobile Bridge endpoint path");
  }
  if (value.pairExchangePath !== MOBILE_BRIDGE_PAIR_EXCHANGE_PATH) {
    throw new Error("Invalid Mobile Bridge pair-exchange path");
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error("Invalid Mobile Bridge endpoint port");
  }
  const endpoint = new URL(value.url);
  if ((value.secure && endpoint.protocol !== "wss:") || (!value.secure && endpoint.protocol !== "ws:")) {
    throw new Error("Mobile Bridge manifest security mode does not match its URL");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Mobile Bridge endpoint manifest must not contain credentials or query data");
  }
  if (endpoint.pathname !== value.path) {
    throw new Error("Mobile Bridge manifest URL does not match its endpoint path");
  }
  const endpointPort = endpoint.port
    ? Number(endpoint.port)
    : endpoint.protocol === "wss:"
      ? 443
      : 80;
  if (endpointPort !== value.port) {
    throw new Error("Mobile Bridge manifest URL does not match its endpoint port");
  }
  const loopback = (host: string) => {
    const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
  };
  if (!value.secure && (!loopback(value.bindHost) || !loopback(endpoint.hostname))) {
    throw new Error("Mobile Bridge requires TLS for non-loopback endpoints");
  }
  if (value.secure) {
    if (!value.certificateFingerprint || !/^[a-f0-9]{64}$/.test(value.certificateFingerprint)) {
      throw new Error("Secure Mobile Bridge manifest requires a SHA-256 certificate fingerprint");
    }
    if (!value.certificateDer || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.certificateDer)) {
      throw new Error("Secure Mobile Bridge manifest requires a public DER certificate");
    }
  } else if (value.certificateFingerprint !== null || value.certificateDer !== null) {
    throw new Error("Insecure loopback Mobile Bridge manifest cannot advertise TLS material");
  }
}

/** DESKTOP_MOBILE_BRIDGE: Endpoint discovery is always secret-free. */
export function writeMobileBridgeEndpointManifest(
  userDataPath: string,
  manifest: MobileBridgeEndpointManifest,
): string {
  const identity = loadOrCreateMobileBridgeHostIdentity(userDataPath);
  if (manifest.hostId !== identity.hostId) {
    throw new Error("Mobile Bridge endpoint manifest does not match the host identity");
  }
  validManifest(manifest);
  const target = mobileBridgeEndpointManifestPath(userDataPath);
  writePrivateJsonAtomic(target, manifest);
  return target;
}

export function readMobileBridgeEndpointManifest(
  userDataPath: string,
): MobileBridgeEndpointManifest | null {
  const target = mobileBridgeEndpointManifestPath(userDataPath);
  if (!fs.existsSync(target)) return null;
  const parsed = readJson(target);
  if (!isRecord(parsed)) throw new Error("Invalid Mobile Bridge endpoint manifest");
  const manifest = parsed as unknown as MobileBridgeEndpointManifest;
  validManifest(manifest);
  const identity = loadOrCreateMobileBridgeHostIdentity(userDataPath);
  if (manifest.hostId !== identity.hostId) {
    throw new Error("Mobile Bridge endpoint manifest does not match the host identity");
  }
  return manifest;
}

export class MobileBridgePairingManager {
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => Date;
  private readonly consumePairingAssertion?: MobileBridgePairingManagerOptions["consumePairingAssertion"];
  private readonly validateAccountAuthority?: MobileBridgePairingManagerOptions["validateAccountAuthority"];
  private readonly onChanged: (reason: MobileBridgePairingChangeReason) => void;
  private activeChallenge: ActiveChallenge | null = null;
  private activeChallengeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly userDataPath: string,
    options: MobileBridgePairingManagerOptions = {},
  ) {
    this.ttlMs = Math.max(10_000, Math.min(DEFAULT_PAIRING_TTL_MS, options.ttlMs ?? DEFAULT_PAIRING_TTL_MS));
    this.maxAttempts = Math.max(
      1,
      Math.min(DEFAULT_MAX_PAIRING_ATTEMPTS, options.maxAttempts ?? DEFAULT_MAX_PAIRING_ATTEMPTS),
    );
    this.now = options.now ?? (() => new Date());
    this.consumePairingAssertion = options.consumePairingAssertion;
    this.validateAccountAuthority = options.validateAccountAuthority;
    this.onChanged = options.onChanged ?? (() => {});
  }

  /**
   * DESKTOP_MOBILE_BRIDGE: Returns the raw 128-bit nonce exactly once to an
   * explicit pairing UI. Only its SHA-256 hash remains in memory.
   */
  issueChallenge(accountProof: MobileBridgeDesktopAccountProof): MobileBridgePairingChallenge {
    if (!this.consumePairingAssertion) {
      throw new MobileBridgePairingError(
        "account_authority_unavailable",
        "Same-account pairing authority is unavailable",
      );
    }
    if (
      !validHostId(accountProof.hostId) ||
      !validPairingAttemptId(accountProof.pairingAttemptId) ||
      !validOpaqueProof(accountProof.desktopAccountProof) ||
      !validAccountSubject(accountProof.accountSubject) ||
      !validAccountAuthorityOrigin(accountProof.accountAuthorityOrigin) ||
      !Number.isInteger(accountProof.expiresIn) ||
      accountProof.expiresIn < 10 ||
      accountProof.expiresIn > 5 * 60
    ) {
      throw new MobileBridgePairingError("account_authority_unavailable", "Desktop account proof is invalid");
    }
    this.clearChallengeTimer();
    const raw = randomBytes(16).toString("base64url");
    const nowMs = this.now().getTime();
    const expiresAtMs = Math.min(nowMs + this.ttlMs, nowMs + accountProof.expiresIn * 1_000);
    const challenge: ActiveChallenge = {
      codeHash: hashSecret(raw),
      expiresAtMs,
      attempts: 0,
      hostId: accountProof.hostId,
      pairingAttemptId: accountProof.pairingAttemptId,
      desktopAccountProof: accountProof.desktopAccountProof,
      expectedAccountSubject: accountProof.accountSubject,
      accountAuthorityOrigin: accountProof.accountAuthorityOrigin,
    };
    this.activeChallenge = challenge;
    this.activeChallengeTimer = setTimeout(() => {
      if (this.activeChallenge !== challenge) return;
      this.activeChallenge = null;
      this.activeChallengeTimer = null;
      this.emitChanged("challenge-expired");
    }, this.ttlMs);
    this.activeChallengeTimer.unref?.();
    this.emitChanged("challenge-issued");
    return {
      code: raw,
      expiresAt: new Date(expiresAtMs).toISOString(),
      hostId: accountProof.hostId,
      pairingAttemptId: accountProof.pairingAttemptId,
      desktopAccountProof: accountProof.desktopAccountProof,
      accountAuthorityOrigin: accountProof.accountAuthorityOrigin,
    };
  }

  /**
   * DESKTOP_MOBILE_BRIDGE: A challenge expires after two minutes, is consumed
   * before disk writes, and is invalidated after bounded wrong attempts. The
   * plaintext device token is returned once and only its hash is persisted.
   */
  async exchange(request: MobileBridgePairExchangeRequest): Promise<MobileBridgeIssuedCredential> {
    const challenge = this.activeChallenge;
    if (!challenge) {
      throw new MobileBridgePairingError("pairing_unavailable", "Pairing is not currently available");
    }
    const now = this.now();
    if (now.getTime() >= challenge.expiresAtMs) {
      this.activeChallenge = null;
      this.clearChallengeTimer();
      this.emitChanged("challenge-expired");
      throw new MobileBridgePairingError("pairing_expired", "Pairing code has expired");
    }
    const matches = timingSafeEqual(challenge.codeHash, hashSecret(request.code));
    if (!matches) {
      challenge.attempts += 1;
      if (challenge.attempts >= this.maxAttempts) {
        this.activeChallenge = null;
        this.clearChallengeTimer();
        this.emitChanged("challenge-invalidated");
      }
      throw new MobileBridgePairingError("pairing_denied", "Pairing code was not accepted");
    }
    if (!sameStableValue(challenge.pairingAttemptId, request.pairingAttemptId)) {
      challenge.attempts += 1;
      if (challenge.attempts >= this.maxAttempts) {
        this.activeChallenge = null;
        this.clearChallengeTimer();
        this.emitChanged("challenge-invalidated");
      }
      throw new MobileBridgePairingError("binding_mismatch", "Pairing attempt binding was not accepted");
    }
    // Consume first: a write failure must not make the nonce reusable.
    this.activeChallenge = null;
    this.clearChallengeTimer();

    let consumed: MobileBridgeConsumedPairingAssertion;
    try {
      consumed = await this.consumePairingAssertion!({
        pairingAssertion: request.pairingAssertion,
        audience: request.audience,
        hostId: challenge.hostId,
        deviceNonce: request.deviceNonce,
        pairingAttemptId: request.pairingAttemptId,
      });
    } catch (error) {
      this.emitChanged("challenge-invalidated");
      const code = accountPairingFailureCode(error);
      throw new MobileBridgePairingError(code, "Mobile account assertion was not accepted");
    }
    if (
      !validAccountSubject(consumed.accountSubject) ||
      !/^mpr_[A-Za-z0-9_-]{24}$/.test(consumed.receiptId) ||
      !sameStableValue(challenge.expectedAccountSubject, consumed.accountSubject)
    ) {
      this.emitChanged("challenge-invalidated");
      throw new MobileBridgePairingError("account_mismatch", "Desktop and Mobile Agentlas accounts do not match");
    }

    const token = randomBytes(32).toString("base64url");
    const issuedAt = now.toISOString();
    const record: StoredMobileBridgeDevice = {
      deviceId: `device_${randomBytes(16).toString("hex")}`,
      tokenHash: hashSecretHex(token),
      name: request.device.name,
      platform: request.device.platform,
      appVersion: request.device.appVersion ?? null,
      issuedAt,
      revokedAt: null,
      accountSubject: consumed.accountSubject,
      accountAuthorityOrigin: challenge.accountAuthorityOrigin,
    };
    const store = readDevices(this.userDataPath);
    store.devices.push(record);
    try {
      writeDevices(this.userDataPath, store);
    } catch (error) {
      this.emitChanged("challenge-invalidated");
      throw error;
    }
    this.emitChanged("device-paired");
    return { deviceId: record.deviceId, token, issuedAt };
  }

  async authenticate(token: string): Promise<MobileBridgeDeviceMetadata | null> {
    if (!validToken(token)) return null;
    // DESKTOP_MOBILE_BRIDGE: Compare every stored digest before selecting the
    // match so the credential check does not reveal an early-match position.
    let record: StoredMobileBridgeDevice | null = null;
    for (const device of readDevices(this.userDataPath).devices) {
      const matches = safeHashEquals(device.tokenHash, token);
      if (matches && device.revokedAt === null) record = device;
    }
    if (!record || !record.accountSubject || !record.accountAuthorityOrigin || !this.validateAccountAuthority) return null;
    let active = false;
    try {
      active = await this.validateAccountAuthority({
        accountSubject: record.accountSubject,
        accountAuthorityOrigin: record.accountAuthorityOrigin,
      });
    } catch {
      active = false;
    }
    if (!active) {
      this.revokeDevice(record.deviceId);
      return null;
    }
    return this.publicMetadata(record);
  }

  listDevices(): MobileBridgeDeviceMetadata[] {
    return readDevices(this.userDataPath).devices.map((record) => this.publicMetadata(record));
  }

  revokeDevice(deviceId: string): boolean {
    const store = readDevices(this.userDataPath);
    const record = store.devices.find((device) => device.deviceId === deviceId && device.revokedAt === null);
    if (!record) return false;
    record.revokedAt = this.now().toISOString();
    writeDevices(this.userDataPath, store);
    this.emitChanged("device-revoked");
    return true;
  }

  dispose(): void {
    this.activeChallenge = null;
    this.clearChallengeTimer();
  }

  private clearChallengeTimer(): void {
    if (this.activeChallengeTimer) clearTimeout(this.activeChallengeTimer);
    this.activeChallengeTimer = null;
  }

  private emitChanged(reason: MobileBridgePairingChangeReason): void {
    try {
      this.onChanged(reason);
    } catch {
      // A renderer notification must never change pairing authority behavior.
    }
  }

  private publicMetadata(record: StoredMobileBridgeDevice): MobileBridgeDeviceMetadata {
    return {
      deviceId: record.deviceId,
      name: record.name,
      platform: record.platform,
      appVersion: record.appVersion,
      issuedAt: record.issuedAt,
      revokedAt: record.revokedAt,
    };
  }
}

/**
 * DESKTOP_MOBILE_BRIDGE: The QR contains a two-minute one-time nonce plus the
 * short-lived Web-signed Desktop account proof. It never contains the session
 * cookie, stable account subject, per-device bearer credential, or dev token.
 */
export function createMobileBridgePairingPayload(
  challenge: MobileBridgePairingChallenge,
  manifest: MobileBridgeEndpointManifest,
): MobileBridgePairingPayload {
  validManifest(manifest);
  if (!/^[A-Za-z0-9_-]{22}$/.test(challenge.code)) throw new Error("Invalid Mobile Bridge pairing challenge");
  if (!Number.isFinite(Date.parse(challenge.expiresAt))) throw new Error("Invalid Mobile Bridge pairing expiry");
  if (challenge.hostId !== manifest.hostId) throw new Error("Mobile Bridge account proof does not match the host identity");
  if (!validPairingAttemptId(challenge.pairingAttemptId)) throw new Error("Invalid Mobile Bridge pairing attempt");
  if (!validOpaqueProof(challenge.desktopAccountProof)) throw new Error("Invalid Mobile Bridge Desktop account proof");
  if (!validAccountAuthorityOrigin(challenge.accountAuthorityOrigin)) throw new Error("Invalid Mobile Bridge account authority origin");
  const endpoint = new URL(manifest.url);
  endpoint.protocol = manifest.secure ? "https:" : "http:";
  endpoint.pathname = MOBILE_BRIDGE_PAIR_EXCHANGE_PATH;
  // The certificate itself is deliberately NOT in the QR. The fingerprint is a
  // complete pin — Mobile compares the SHA-256 of the certificate the TLS
  // handshake presents — so shipping the whole DER proved nothing extra while
  // costing 796 of 1228 characters on a real host. That pushed the code to a
  // density that failed to scan on a slightly blurry camera. Keeping the
  // payload small is what makes pairing work in practice.
  return {
    version: MOBILE_BRIDGE_PROTOCOL_VERSION,
    hostId: manifest.hostId,
    displayName: manifest.displayName,
    endpoint: manifest.url,
    pairExchangeEndpoint: endpoint.toString(),
    code: challenge.code,
    expiresAt: challenge.expiresAt,
    desktopAccountProof: challenge.desktopAccountProof,
    pairingAttemptId: challenge.pairingAttemptId,
    accountAuthorityOrigin: challenge.accountAuthorityOrigin,
    certificateFingerprint: manifest.certificateFingerprint,
    certificateDer: null,
  };
}
