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
  type AccountAuthorityStatus,
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
  /**
   * The Desktop workspace this credential was issued under. Revocation is
   * driven by a proven change of this value, never by the Desktop merely
   * failing to prove who it is (TTL expiry, signed-out boot, outage).
   */
  workspaceId?: string;
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
  }) => Promise<AccountAuthorityStatus>;
  /**
   * Whether this Desktop currently holds a signed-in account session. A
   * signed-out Desktop must not serve paired phones — but it must not delete
   * their credentials either, which is what wiped real pairings on every
   * signed-out boot.
   */
  desktopSessionActive?: () => boolean;
  /** Workspace of the currently signed-in Desktop account, when known. */
  desktopWorkspaceId?: () => string | null;
  onChanged?: (reason: MobileBridgePairingChangeReason) => void;
}

/**
 * Why a stored credential was refused. Only `account_inactive` revokes.
 *
 * ★실측 사고(2026-08-08): 릴레이 터널이 로컬 홉에서 401로 100초에 13번 끊겼는데
 * `main.log`에 단서가 **0줄**이었다. 이유는 이 열거형에 "토큰이 아예 없다 /
 * 형식이 틀렸다 / 그 토큰에 맞는 살아있는 기기가 없다" 세 경우가 없어서,
 * 그 세 경로가 사유도 로그도 없는 맨 401을 냈기 때문이다(그중 세 번째가 이번 건 —
 * devices.json 40대 전부 폐기, 활성 0). 맨 401은 이미 한 번 문제로 지목돼
 * `lastAuthenticationRefusal`이 생겼는데, 정작 가장 흔한 세 경로가 빠져 있었다.
 *
 * 규칙: **401을 내는 모든 경로는 여기 사유 하나를 갖는다.** 사유 없는 401 금지.
 */
export type MobileBridgeAuthenticationRefusal =
  | "device_repair_required"
  | "account_authority_unreachable"
  | "account_inactive"
  | "desktop_signed_out"
  /** Authorization 헤더가 없거나 Bearer 형식이 아니다(릴레이/앱 배선 문제). */
  | "token_missing"
  /** Bearer는 왔는데 토큰 문법이 우리 발급 형식이 아니다. */
  | "token_malformed"
  /** 문법은 맞지만 살아있는 기기와 안 맞는다 — 폐기됐거나 다른 데스크탑의 것. 재페어링만이 답이다. */
  | "device_unknown_or_revoked";

/** 재페어링 말고는 회복 경로가 없는 사유 — 릴레이가 재시도를 멈춰야 한다. */
export function isTerminalMobileBridgeRefusal(
  refusal: MobileBridgeAuthenticationRefusal | null | undefined,
): boolean {
  return refusal === "device_unknown_or_revoked" || refusal === "device_repair_required";
}

/**
 * 폐기(revoke)를 누가 왜 했는가. 폐기는 영구적이고 QR 재스캔을 강제하는 **파괴적**
 * 동작이므로 흔적 없는 폐기를 금지한다.
 *
 * 실측(2026-08-08): `devices.json` 40대 전부 폐기·활성 0인데 `main.log`에 revoke
 * 기록이 0줄이었다. 폐기 경로 5개 중 3개만 로그를 남기고, 하필 사용자 전체 삭제와
 * 발급 롤백이 조용했다.
 */
export type MobileBridgeRevocationCause =
  /** 계정 권위가 "비활성"이라고 명확히 답했다. */
  | "account_inactive"
  /** 자격의 워크스페이스가 현재 로그인 계정과 다르다(증명된 정체 변경). */
  | "account_changed"
  /** 사용자가 설정에서 이 기기를 지웠다. */
  | "owner_removed_device"
  /** 사용자가 설정에서 전부 지웠다. */
  | "owner_removed_all"
  /** 모바일이 스스로 연결 해제를 요청했다. */
  | "device_requested"
  /** 페어링 응답을 만들다 실패해 방금 발급한 자격을 되돌린다. */
  | "pairing_rollback"
  /** 호출부가 사유를 안 줬다 — 이 값이 로그에 보이면 그 호출부가 결함이다. */
  | "unspecified";

export function logMobileBridgeRevocation(
  cause: MobileBridgeRevocationCause,
  count: number,
  deviceIds: readonly string[] = [],
): void {
  if (count <= 0) return;
  const sample = deviceIds.slice(0, 3).join(", ");
  console.warn(
    `[mobile-bridge] revoked ${count} device(s) — cause=${cause}` +
      (sample ? ` (${sample}${deviceIds.length > 3 ? ", …" : ""})` : "") +
      (cause === "unspecified" ? " ← 사유 없는 폐기: 호출부에 cause를 달아야 한다" : ""),
  );
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
    ) &&
    // The revoke decision is driven by this value, so a malformed one must
    // fail the store rather than silently look like "a different account".
    (value.workspaceId === undefined ||
      (typeof value.workspaceId === "string" && value.workspaceId.length > 0 && value.workspaceId.length <= 200))
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
/**
 * Revokes only credentials that provably belong to a different account.
 *
 * The blanket revoke this replaces fired on plain TTL expiry, on any
 * re-sign-in (including the same account), and on every signed-out boot. On a
 * real machine that left 39 of 39 paired devices revoked and zero usable — the
 * product was deleting its own pairings. Inability to prove identity is not
 * evidence of a changed identity; only a different, known workspace is.
 *
 * Records with no `workspaceId` predate account binding. They are left alone
 * here and refused at authenticate() with `device_repair_required`, so the
 * user is told to re-pair instead of silently losing the device.
 */
export function revokeMobileBridgeDevicesForOtherAccounts(
  userDataPath: string,
  activeWorkspaceId: string | null,
  now: Date = new Date(),
): string[] {
  if (!activeWorkspaceId) return [];
  const store = readDevices(userDataPath);
  const revokedAt = now.toISOString();
  const revoked: string[] = [];
  for (const device of store.devices) {
    if (device.revokedAt !== null) continue;
    if (!device.workspaceId) continue;
    if (device.workspaceId === activeWorkspaceId) continue;
    device.revokedAt = revokedAt;
    revoked.push(device.deviceId);
  }
  if (revoked.length > 0) writeDevices(userDataPath, store);
  logMobileBridgeRevocation("account_changed", revoked.length, revoked);
  return revoked;
}

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
  // 사용자 지시로 전부 지우는 경로. 예전에는 이 자리가 완전히 조용했다.
  logMobileBridgeRevocation("owner_removed_all", revoked.length, revoked);
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
  private readonly desktopSessionActive?: MobileBridgePairingManagerOptions["desktopSessionActive"];
  private readonly desktopWorkspaceId?: MobileBridgePairingManagerOptions["desktopWorkspaceId"];
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
    this.desktopSessionActive = options.desktopSessionActive;
    this.desktopWorkspaceId = options.desktopWorkspaceId;
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
      ...(this.desktopWorkspaceId?.() ? { workspaceId: this.desktopWorkspaceId()! } : {}),
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
    if (!validToken(token)) {
      this.lastAuthenticationRefusal = "token_malformed";
      console.warn("[mobile-bridge] refusing device: presented token is not a bridge credential");
      return null;
    }
    // DESKTOP_MOBILE_BRIDGE: Compare every stored digest before selecting the
    // match so the credential check does not reveal an early-match position.
    let record: StoredMobileBridgeDevice | null = null;
    let revokedMatch: StoredMobileBridgeDevice | null = null;
    for (const device of readDevices(this.userDataPath).devices) {
      const matches = safeHashEquals(device.tokenHash, token);
      if (!matches) continue;
      if (device.revokedAt === null) record = device;
      else revokedMatch = device;
    }
    if (!record) {
      // ★이번 사고의 실제 경로. 예전에는 조용히 null이라 로그가 0줄이었다.
      // 폐기된 기기와 아예 모르는 토큰을 구분해 적는다 — 전자는 "언제 폐기됐나"가
      // 곧 원인 추적의 시작점이다(실측: 40대 전부 폐기, 활성 0).
      this.lastAuthenticationRefusal = "device_unknown_or_revoked";
      console.warn(
        revokedMatch
          ? `[mobile-bridge] refusing device ${revokedMatch.deviceId}: credential was revoked at ${revokedMatch.revokedAt} — re-pairing is required`
          : "[mobile-bridge] refusing device: credential matches no paired device on this Desktop — re-pairing is required",
      );
      return null;
    }
    if (this.desktopSessionActive && !this.desktopSessionActive()) {
      this.lastAuthenticationRefusal = "desktop_signed_out";
      console.warn("[mobile-bridge] refusing device: this Desktop is signed out (credentials kept)");
      return null;
    }
    // A credential minted before account binding shipped cannot be validated,
    // but it is not evidence of a revoked account. Refuse the connection with
    // a distinct reason so the phone can say "re-pair this Desktop" instead of
    // retrying a bare 401 forever, and never silently revoke it.
    if (!record.accountSubject || !record.accountAuthorityOrigin || !this.validateAccountAuthority) {
      this.lastAuthenticationRefusal = "device_repair_required";
      console.warn(
        `[mobile-bridge] device ${record.deviceId} has no account binding; re-pairing is required (credential kept)`,
      );
      return null;
    }
    let status: AccountAuthorityStatus;
    try {
      status = await this.validateAccountAuthority({
        accountSubject: record.accountSubject,
        accountAuthorityOrigin: record.accountAuthorityOrigin,
      });
    } catch {
      status = "unreachable";
    }
    if (status === "unreachable") {
      // Refuse this attempt, keep the credential. Revoking here is what wiped
      // real pairings on a single relay hiccup or a 503 from the status route:
      // a revoke is permanent and forces a QR re-scan, so it may only follow a
      // definitive answer.
      this.lastAuthenticationRefusal = "account_authority_unreachable";
      console.warn(
        `[mobile-bridge] device ${record.deviceId} refused: account authority unreachable (credential kept)`,
      );
      return null;
    }
    if (status === "inactive") {
      this.lastAuthenticationRefusal = "account_inactive";
      console.warn(`[mobile-bridge] device ${record.deviceId} revoked: account authority reported inactive`);
      this.revokeDevice(record.deviceId, "account_inactive");
      return null;
    }
    // Fail closed on anything that is not an explicit "active" — a stale caller
    // returning a boolean must not be read as permission. Refusing without
    // revoking is the safe answer for an unrecognised status.
    if (status !== "active") {
      this.lastAuthenticationRefusal = "account_authority_unreachable";
      console.warn(
        `[mobile-bridge] device ${record.deviceId} refused: account authority returned an unrecognised status (credential kept)`,
      );
      return null;
    }
    this.lastAuthenticationRefusal = null;
    return this.publicMetadata(record);
  }

  /**
   * Why the most recent authenticate() refused. The socket layer turns this
   * into a distinct close reason; without it every refusal was an identical
   * bare 401 and neither the user nor the log could tell "re-pair required"
   * from "cloud is down" from "your account was closed".
   */
  lastAuthenticationRefusal: MobileBridgeAuthenticationRefusal | null = null;

  listDevices(): MobileBridgeDeviceMetadata[] {
    return readDevices(this.userDataPath).devices.map((record) => this.publicMetadata(record));
  }

  /**
   * @param cause 왜 폐기하는가. 폐기는 **영구적이고 QR 재스캔을 강제**하므로
   *   반드시 기록된다 — 실측(2026-08-08): 40대가 전부 폐기됐는데 `main.log`에
   *   revoke 한 줄이 없어서 "누가 지웠는지"를 코드 독해로 추적해야 했다.
   */
  revokeDevice(deviceId: string, cause: MobileBridgeRevocationCause = "unspecified"): boolean {
    const store = readDevices(this.userDataPath);
    const record = store.devices.find((device) => device.deviceId === deviceId && device.revokedAt === null);
    if (!record) return false;
    record.revokedAt = this.now().toISOString();
    writeDevices(this.userDataPath, store);
    logMobileBridgeRevocation(cause, 1, [deviceId]);
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
