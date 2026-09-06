// agentlas.cloud 구글 로그인 — 데스크톱 패턴.
//
// 흐름:
//   1. signInWithGoogle()이 호출되면 별도 partition session의 BrowserWindow 띄움
//   2. 사용자가 그 안에서 구글 로그인 → 백엔드(POST /api/auth/google)가 agentlas_session cookie 설정
//   3. did-navigate-in-page / did-frame-finish-load 시점에 partition session.cookies에서 추출
//   4. cookie value를 Electron safeStorage 암호화 파일에 저장
//   5. BrowserWindow 닫고 사용자 메타데이터(userId/workspaceId/email)를 main 메모리에 캐시
//
// 보안:
//   - partition은 영구가 아닌 in-memory 형태 — 윈도우가 닫히면 사라짐 (재로그인 시 새 인증)
//   - 실제 인증값은 OS-backed safeStorage로 암호화해 앱 데이터 폴더에 저장.
//     앱 시작 때 macOS Keychain 허용 팝업이 반복되지 않게 keytar는 로그인 세션에 쓰지 않는다.
//   - signature 검증은 안 함 — 서버를 신뢰하고 cookie value를 그대로 보관/재첨부
//
// 백엔드 가정:
//   - 세션 cookie 이름: agentlas_session
//   - cookie value 포맷: base64url({ userId, workspaceId, exp }).<HMAC>
//   - 성공 redirect 형태: /account?auth=google (POST /api/auth/google 응답의 redirectTo)
//   - 사용자 메타(email, name) 조회 endpoint: /api/account/me (없으면 cookie payload만 표시)
 import { app, BrowserWindow, safeStorage, session as electronSession, shell } from "electron";
 import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AuthSession } from "../shared/types";
import { userDataPath } from "./runtime-paths";

type ElectronApi = typeof import("electron");

/** GUI-only auth surfaces are optional in the packaged headless daemon. */
function electronApi(): ElectronApi {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("electron") as ElectronApi;
}

const COOKIE_NAME = "agentlas_session";
const AUTH_PARTITION = "persist:agentlas-auth";
const USE_MEMORY_AUTH = process.env.AGENTLAS_E2E === "1" && process.env.AGENTLAS_E2E_KEYCHAIN !== "1";
const USE_E2E_SESSION = USE_MEMORY_AUTH && process.env.AGENTLAS_E2E_AUTH === "1";
let memoryAuthCookie: string | null = null;

function rendererAccountFingerprint(userId: string | undefined): string | undefined {
  if (!userId) return undefined;
  return createHash("sha256")
    .update("agentlas-renderer-account-v1\0")
    .update(userId)
    .digest("hex")
    .slice(0, 24);
}

export function webBaseUrl(): string {
  const fromEnv = process.env.AGENTLAS_WEB_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return "https://agentlas.cloud";
}

/** main 메모리에 보관하는 세션 — 디스크에는 암호화 cookie만, 메타데이터는 매 부팅 시 cookie payload + session endpoint로 재구성 */
interface SessionCache {
  cookieValue: string;
  email?: string;
  name?: string;
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
}

let _cache: SessionCache | null = null;
let _sessionGeneration = 0;
let _cookieMutationChain: Promise<void> = Promise.resolve();

export type AuthSessionInvalidationReason = "expired" | "server-invalid";

export interface AuthSessionInvalidationEvent {
  previousWorkspaceId?: string;
  reason: AuthSessionInvalidationReason;
}

const sessionInvalidationListeners = new Set<(event: AuthSessionInvalidationEvent) => void>();
const sessionRestorationListeners = new Set<(session: AuthSession) => void>();

function queueCookieMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const next = _cookieMutationChain.then(mutation, mutation);
  _cookieMutationChain = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Main-process boundary for silent session loss. Explicit sign-in/sign-out IPC
 * already owns its transition, but TTL expiry and server invalidation can happen
 * while every renderer stays mounted.
 */
export function onAuthSessionInvalidated(
  listener: (event: AuthSessionInvalidationEvent) => void,
): () => void {
  sessionInvalidationListeners.add(listener);
  return () => sessionInvalidationListeners.delete(listener);
}

/** Main observes explicit restoration/login success without receiving cookies. */
export function onAuthSessionRestored(listener: (session: AuthSession) => void): () => void {
  sessionRestorationListeners.add(listener);
  return () => sessionRestorationListeners.delete(listener);
}

function emitAuthSessionRestored(generation: number): void {
  if (generation !== _sessionGeneration) return;
  const snapshot = getAuthSession();
  if (!snapshot.signedIn) return;
  for (const listener of sessionRestorationListeners) {
    if (generation !== _sessionGeneration) break;
    try {
      listener({ ...snapshot });
    } catch {
      console.warn("[auth] session restoration listener failed");
    }
  }
}

interface StoredAuthCookie {
  version: 1;
  encoding: "safeStorage/base64";
  value: string;
  updatedAt: string;
}

export type AuthRestoreResult =
  | { status: "restored"; signedIn: true }
  | { status: "missing" | "expired" | "invalid" | "native-unavailable" | "temporarily-unavailable"; signedIn: false };

type StoredSessionCookieReadResult =
  | { status: "restored"; value: string; durableIdentity: string }
  | { status: "missing" | "invalid" | "native-unavailable" | "temporarily-unavailable" };

const TEMPORARY_AUTH_FILE_ERROR_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "EINTR",
  "EMFILE",
  "ENFILE",
  "ETIMEDOUT",
]);

// A Keychain helper can be permanently parked while macOS/Windows is waking
// from an updater handoff. Each async safeStorage hop has its own deadline so
// startup can preserve the durable cookie and retry later instead of hanging
// the whole application. The late promise is observed but never receives a
// callback that could mutate auth state.
const SAFE_STORAGE_ASYNC_ATTEMPT_TIMEOUT_MS = 5_000;

// Electron's async safeStorage methods run through the shared libuv worker
// pool. On macOS a locked or slow Keychain can keep the native operation alive
// after our JavaScript deadline has elapsed. Starting a fresh retry each time
// then parks every worker, which in turn stalls unrelated startup filesystem
// work for minutes. Reuse the one native availability/decrypt operation until
// it settles; the caller can still time out and let the customer window load.
let safeStorageAvailabilityConfirmed = false;
let safeStorageAvailabilityInFlight: Promise<boolean> | null = null;
let safeStorageAvailabilitySuppressed = false;
let safeStorageRecoveryGeneration = 0;
const failedAuthCiphertexts = new Set<string>();
let userAuthRestoreInFlight: Promise<AuthRestoreResult> | null = null;

function authCiphertextFingerprint(durableIdentity: string): string {
  return createHash("sha256").update(durableIdentity).digest("hex");
}

interface SafeStorageDecryptAttempt {
  durableIdentity: string;
  recoveryGeneration: number;
  promise: ReturnType<ElectronApi["safeStorage"]["decryptStringAsync"]>;
  settled: boolean;
}

let safeStorageDecryptInFlight: SafeStorageDecryptAttempt | null = null;

function sharedSafeStorageAvailabilityAttempt(): Promise<boolean> {
  if (safeStorageAvailabilitySuppressed) return Promise.resolve(false);
  if (safeStorageAvailabilityConfirmed) return Promise.resolve(true);
  if (safeStorageAvailabilityInFlight) return safeStorageAvailabilityInFlight;
  const generation = safeStorageRecoveryGeneration;
  const started = Promise.resolve().then(() => electronApi().safeStorage.isAsyncEncryptionAvailable());
  safeStorageAvailabilityInFlight = started;
  void started.then(
    (available) => {
      if (generation !== safeStorageRecoveryGeneration) return;
      safeStorageAvailabilityConfirmed = available;
      // False can mean lazy initialization, not OS denial. Keep the outcome
      // unavailable until the user requests another potentially prompting hop.
      safeStorageAvailabilitySuppressed = !available;
    },
    () => {
      // A native rejection may be a denial or cancellation even when Electron
      // exposes no error code. Never classify it as transient from its prose.
      if (generation === safeStorageRecoveryGeneration) safeStorageAvailabilitySuppressed = true;
    },
  ).finally(() => {
    if (safeStorageAvailabilityInFlight === started) safeStorageAvailabilityInFlight = null;
  });
  return started;
}

function sharedSafeStorageDecryptAttempt(
  ciphertext: Buffer,
  durableIdentity: string,
): SafeStorageDecryptAttempt | null {
  if (failedAuthCiphertexts.has(authCiphertextFingerprint(durableIdentity))) return null;
  const current = safeStorageDecryptInFlight;
  if (current) {
    if (current.durableIdentity === durableIdentity && current.recoveryGeneration === safeStorageRecoveryGeneration) return current;
    // A newer login may replace the durable envelope while an old decrypt is
    // parked. Do not occupy another worker until the old native call settles.
    if (!current.settled) return null;
  }

  const entry: SafeStorageDecryptAttempt = {
    durableIdentity,
    recoveryGeneration: safeStorageRecoveryGeneration,
    // Synchronous native throws follow the same terminal path as rejections.
    promise: Promise.resolve().then(() => electronApi().safeStorage.decryptStringAsync(ciphertext)),
    settled: false,
  };
  safeStorageDecryptInFlight = entry;
  void entry.promise.then(
    (value) => {
      entry.settled = true;
      if (typeof value?.result !== "string") failedAuthCiphertexts.add(authCiphertextFingerprint(durableIdentity));
    },
    () => {
      entry.settled = true;
      // Remember late failures too: a timed-out caller may already have left.
      failedAuthCiphertexts.add(authCiphertextFingerprint(durableIdentity));
    },
  );
  return entry;
}

function consumeSafeStorageDecryptAttempt(entry: SafeStorageDecryptAttempt): void {
  if (safeStorageDecryptInFlight === entry) safeStorageDecryptInFlight = null;
}

export type AuthRestoreAttemptResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timed-out" };

export async function settleAuthRestoreAttempt<T>(
  attempt: () => Promise<T> | T,
  timeoutMs = SAFE_STORAGE_ASYNC_ATTEMPT_TIMEOUT_MS,
): Promise<AuthRestoreAttemptResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const settled = Promise.resolve()
    .then(attempt)
    .then(
      (value): AuthRestoreAttemptResult<T> => ({ status: "fulfilled", value }),
      (error): AuthRestoreAttemptResult<T> => ({ status: "rejected", error }),
    );
  const deadline = new Promise<AuthRestoreAttemptResult<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timed-out" }), Math.max(0, timeoutMs));
    timeout.unref?.();
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function authCookiePath(): string {
  return userDataPath("auth", "session-cookie.v1.json");
}

function parseStoredAuthCookie(raw: string): { ciphertext: Buffer; durableIdentity: string } | null {
  let parsed: Partial<StoredAuthCookie>;
  try {
    parsed = JSON.parse(raw) as Partial<StoredAuthCookie>;
  } catch {
    return null;
  }
  if (parsed.version !== 1 || parsed.encoding !== "safeStorage/base64" || typeof parsed.value !== "string") {
    return null;
  }
  const ciphertext = Buffer.from(parsed.value, "base64");
  if (!parsed.value || ciphertext.length === 0 || ciphertext.toString("base64") !== parsed.value) {
    return null;
  }
  return { ciphertext, durableIdentity: parsed.value };
}

async function readStoredSessionCookie(restoreGeneration: number): Promise<StoredSessionCookieReadResult> {
  if (USE_MEMORY_AUTH) {
    return memoryAuthCookie
      ? { status: "restored", value: memoryAuthCookie, durableIdentity: memoryAuthCookie }
      : { status: "missing" };
  }
  let raw: string;
  try {
    raw = await fs.readFile(authCookiePath(), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "missing" };
    if (typeof code === "string" && TEMPORARY_AUTH_FILE_ERROR_CODES.has(code)) {
      console.warn("[auth] local session read temporarily unavailable", err);
      return { status: "temporarily-unavailable" };
    }
    console.warn("[auth] local session file is invalid or inaccessible", err);
    return { status: "invalid" };
  }
  const envelope = parseStoredAuthCookie(raw);
  if (!envelope) return { status: "invalid" };
  // A newer login/logout owns restoration. Do not start a native hop for an
  // obsolete file read; boot will return the current generation's state.
  if (restoreGeneration !== _sessionGeneration) return { status: "missing" };
  if (safeStorageAvailabilitySuppressed || failedAuthCiphertexts.has(authCiphertextFingerprint(envelope.durableIdentity))) {
    return { status: "native-unavailable" };
  }
  // Electron 43 initializes its asynchronous safeStorage backend lazily.
  // The synchronous availability/decrypt pair can report a signed-in user's
  // Keychain as unavailable during Squirrel's background relaunch. Async
  // decrypt reads the exact same v1/base64 ciphertext and waits for that
  // initialization without changing the durable file.
  const availability = await settleAuthRestoreAttempt(sharedSafeStorageAvailabilityAttempt);
  if (restoreGeneration !== _sessionGeneration) return { status: "missing" };
  if (safeStorageAvailabilitySuppressed) return { status: "native-unavailable" };
  if (availability.status === "timed-out") {
    console.warn("[auth] async local session encryption availability timed out");
    return { status: "temporarily-unavailable" };
  }
  if (availability.status === "rejected") {
    console.warn("[auth] native session storage rejected restoration; automatic retries suppressed", availability.error);
    return { status: "native-unavailable" };
  }
  if (!availability.value) return { status: "native-unavailable" };
  const decryptAttempt = sharedSafeStorageDecryptAttempt(envelope.ciphertext, envelope.durableIdentity);
  if (!decryptAttempt) {
    if (failedAuthCiphertexts.has(authCiphertextFingerprint(envelope.durableIdentity))) {
      return { status: "native-unavailable" };
    }
    console.warn("[auth] a previous local session decryption is still pending");
    return { status: "temporarily-unavailable" };
  }
  const decrypted = await settleAuthRestoreAttempt(() => decryptAttempt.promise);
  if (decrypted.status === "timed-out") {
    console.warn("[auth] async local session decryption timed out");
    return { status: "temporarily-unavailable" };
  }
  consumeSafeStorageDecryptAttempt(decryptAttempt);
  if (decrypted.status === "rejected" || typeof decrypted.value?.result !== "string") {
    failedAuthCiphertexts.add(authCiphertextFingerprint(envelope.durableIdentity));
    console.warn("[auth] native session decryption unavailable; automatic retries suppressed", decrypted.status === "rejected" ? decrypted.error : undefined);
    return { status: "native-unavailable" };
  }
  return { status: "restored", value: decrypted.value.result, durableIdentity: envelope.durableIdentity };
}

async function writeStoredSessionCookie(value: string): Promise<void> {
  if (USE_MEMORY_AUTH) {
    memoryAuthCookie = value;
    return;
  }
  const { safeStorage } = electronApi();
  let encrypted: string;
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage encryption is not available");
    }
    encrypted = safeStorage.encryptString(value).toString("base64");
  } catch (error) {
    // An explicit save can be denied too. Keep the old ciphertext and stop
    // automatic restoration from immediately opening another native prompt.
    safeStorageRecoveryGeneration += 1;
    safeStorageAvailabilityConfirmed = false;
    safeStorageAvailabilitySuppressed = true;
    throw error;
  }
  const file = authCookiePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload: StoredAuthCookie = {
    version: 1,
    encoding: "safeStorage/base64",
    value: encrypted,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  // Only a successfully persisted explicit login reopens native restoration.
  // Preserve every other failed ciphertext and never rewrite it on failure.
  safeStorageRecoveryGeneration += 1;
  safeStorageAvailabilityConfirmed = true;
  safeStorageAvailabilitySuppressed = false;
  failedAuthCiphertexts.delete(authCiphertextFingerprint(encrypted));
}

async function deleteStoredSessionCookie(): Promise<void> {
  if (USE_MEMORY_AUTH) {
    memoryAuthCookie = null;
    return;
  }
  try {
    await fs.rm(authCookiePath(), { force: true });
  } catch (err) {
    console.warn("[auth] local session delete failed", err);
  }
}

async function deleteStoredSessionCookieIfUnchanged(
  durableIdentity: string,
  restoreGeneration: number,
): Promise<boolean> {
  return queueCookieMutation(async () => {
    // A login/logout begun after this boot attempt owns both in-memory and
    // durable state. Never let an old expiry cleanup remove its cookie.
    if (restoreGeneration !== _sessionGeneration) return false;
    if (USE_MEMORY_AUTH) {
      if (memoryAuthCookie !== durableIdentity) return false;
      memoryAuthCookie = null;
      return true;
    }
    let raw: string;
    try {
      raw = await fs.readFile(authCookiePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[auth] local session conditional delete read failed", err);
      }
      return false;
    }
    const current = parseStoredAuthCookie(raw);
    if (!current || current.durableIdentity !== durableIdentity || restoreGeneration !== _sessionGeneration) {
      return false;
    }
    try {
      await fs.rm(authCookiePath(), { force: true });
      return true;
    } catch (err) {
      console.warn("[auth] local session conditional delete failed", err);
      return false;
    }
  });
}

interface DecodedSessionCookie {
  userId: string;
  workspaceId: string;
  expiresAt: number;
}

type DecodedSessionCookieResult =
  | { status: "valid"; value: DecodedSessionCookie }
  | { status: "expired" }
  | { status: "invalid" };

/** Parse only the signed-cookie shape. Signature verification belongs to the server. */
function decodeSessionCookie(value: string): DecodedSessionCookieResult {
  const parts = value.split(".");
  if (
    parts.length !== 2
    || !/^[A-Za-z0-9_-]+$/.test(parts[0])
    || !/^[A-Za-z0-9_-]+$/.test(parts[1])
  ) {
    return { status: "invalid" };
  }
  const [body] = parts;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== body) return { status: "invalid" };
    const obj = JSON.parse(json) as { userId?: unknown; workspaceId?: unknown; exp?: unknown };
    if (
      !obj
      || typeof obj !== "object"
      || Array.isArray(obj)
      || typeof obj.userId !== "string"
      || !obj.userId.trim()
      || obj.userId.trim() !== obj.userId
      || typeof obj.workspaceId !== "string"
      || !obj.workspaceId.trim()
      || obj.workspaceId.trim() !== obj.workspaceId
      || typeof obj.exp !== "number"
      || !Number.isFinite(obj.exp)
    ) {
      return { status: "invalid" };
    }
    const expiresAt = obj.exp * 1_000;
    if (!Number.isFinite(expiresAt)) return { status: "invalid" };
    if (expiresAt <= Date.now()) return { status: "expired" };
    return { status: "valid", value: { userId: obj.userId, workspaceId: obj.workspaceId, expiresAt } };
  } catch {
    return { status: "invalid" };
  }
}

/** cookie value로 세션 조회 — 실제 엔드포인트는 GET /api/auth/session.
 *  (예전의 /api/account/me 는 웹에 존재하지 않아 404 → 이메일이 영영 안 채워지고
 *   계정 칩이 "?"로 표시되는 버그가 있었다.)
 *  반환: meta | "invalid"(서버가 미인증이라고 답함 — 세션 폐기 대상) | null(네트워크/기타 실패). */
async function fetchAccountMeta(cookieValue: string): Promise<{ email?: string; name?: string } | "invalid" | null> {
  try {
    const url = `${webBaseUrl()}/api/auth/session`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        headers: { cookie: `${COOKIE_NAME}=${cookieValue}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return null; // 429/5xx 등은 판단 보류 — 다음 시도에서 재확인
      const json = (await res.json()) as {
        authenticated?: boolean;
        user?: { email?: string };
        workspace?: { name?: string };
      };
      if (json.authenticated === false) return "invalid";
      return { email: json.user?.email, name: json.workspace?.name };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** 세션은 있는데 이메일이 아직 비어 있으면 백그라운드로 다시 채운다(30초 스로틀).
 *  서버가 "미인증"이라고 답하면 세션을 폐기해 크레딧 위젯/계정 칩 상태가 어긋나지 않게 한다. */
let _metaRefreshAt = 0;

function invalidateCachedSession(reason: AuthSessionInvalidationReason): void {
  const previous = _cache;
  if (!previous) return;
  _sessionGeneration += 1;
  _cache = null;
  _metaRefreshAt = 0;
  void queueCookieMutation(deleteStoredSessionCookie);
  const event: AuthSessionInvalidationEvent = {
    previousWorkspaceId: previous.workspaceId,
    reason,
  };
  for (const listener of sessionInvalidationListeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn("[auth] session invalidation listener failed", error);
    }
  }
}

/** Exact-current authenticated APIs may use this after a definitive 401. */
export function invalidateAuthSessionFromServer(expectedCookieHeader?: string): boolean {
  if (!_cache) return false;
  if (expectedCookieHeader && `${COOKIE_NAME}=${_cache.cookieValue}` !== expectedCookieHeader) return false;
  invalidateCachedSession("server-invalid");
  return true;
}

/** 세션 쿠키로 Hub를 호출하는 표준 경로 — 쿠키 첨부·타임아웃·확정 401 처리를 한 곳에 묶는다.
 *  호출부가 401을 "자기 화면에서만 미인증"으로 강등하고 auth 캐시는 그대로 두면,
 *  크레딧/퀘스트는 사라졌는데 계정 칩은 계속 로그인(이메일·로그아웃) 상태로 남는 불일치가 생긴다.
 *  강등 판단과 세션 폐기를 분리하지 말 것. 폐기는 항상 그 응답을 부른 쿠키 기준(exact-current)이라
 *  이미 교체된 옛 쿠키의 늦은 401은 새 계정을 건드리지 않는다.
 *  401만 폐기한다 — 403은 same-origin 변형 가드처럼 세션과 무관한 거절일 수 있다. */
export async function fetchWithHubSession(
  cookieHeader: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), cookie: cookieHeader },
      signal: ctrl.signal,
    });
    if (res.status === 401) invalidateAuthSessionFromServer(cookieHeader);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function scheduleMetaRefresh(): void {
  const cache = _cache;
  if (!cache || cache.email) return;
  const now = Date.now();
  if (now - _metaRefreshAt < 30_000) return;
  _metaRefreshAt = now;
  void fetchAccountMeta(cache.cookieValue).then((meta) => {
    if (!_cache || _cache.cookieValue !== cache.cookieValue) return;
    if (meta === "invalid") {
      invalidateCachedSession("server-invalid");
      return;
    }
    if (meta) _cache = { ..._cache, email: meta.email, name: meta.name };
  });
}

/** 부팅 시 로컬 암호화 저장소에서 cookie를 복원하고 결과를 구조적으로 반환한다.
 *  함수명은 기존 호출부 호환을 위해 유지한다. */
export async function bootAuthFromKeychain(): Promise<AuthRestoreResult> {
  // This read/decrypt crosses asynchronous OS storage. A sign-in/sign-out can
  // legitimately happen while it is pending; that newer intent must win over
  // this boot snapshot in both memory and the durable cookie file.
  const restoreGeneration = _sessionGeneration;
  const currentGenerationResult = (): AuthRestoreResult => (
    getAuthSession().signedIn
      ? { status: "restored", signedIn: true }
      : { status: "missing", signedIn: false }
  );
  try {
    const stored = await readStoredSessionCookie(restoreGeneration);
    if (restoreGeneration !== _sessionGeneration) return currentGenerationResult();
    if (stored.status !== "restored") return { status: stored.status, signedIn: false };
    const decoded = decodeSessionCookie(stored.value);
    if (decoded.status === "invalid") return { status: "invalid", signedIn: false };
    if (decoded.status === "expired") {
      // Expiry cleanup is conditional on the exact ciphertext observed by this
      // generation, so it cannot erase a cookie saved by a new login.
      await deleteStoredSessionCookieIfUnchanged(stored.durableIdentity, restoreGeneration);
      if (restoreGeneration !== _sessionGeneration) return currentGenerationResult();
      return { status: "expired", signedIn: false };
    }
    if (restoreGeneration !== _sessionGeneration) return currentGenerationResult();
    _cache = {
      cookieValue: stored.value,
      userId: decoded.value.userId,
      workspaceId: decoded.value.workspaceId,
      expiresAt: decoded.value.expiresAt,
    };
    // 이메일/이름은 백그라운드로 fetch (실패해도 무방; 실패 시 getAuthSession 폴링이 재시도)
    scheduleMetaRefresh();
    return { status: "restored", signedIn: true };
  } catch (err) {
    console.warn("[auth] boot from keychain failed", err);
    // Only the file-read allowlist or an existing native operation in flight
    // may request recovery. An unclassified failure must not re-prompt users.
    return { status: "invalid", signedIn: false };
  }
}

const DEFERRED_AUTH_RESTORE_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000, 20_000, 40_000, 80_000] as const;

/** Explicit user action only; never call from polling or startup retry loops. */
export function retryAuthRestoreFromUser(): Promise<AuthRestoreResult> {
  if (userAuthRestoreInFlight) return userAuthRestoreInFlight;
  const started = (async (): Promise<AuthRestoreResult> => {
    const generation = _sessionGeneration;
    if (USE_MEMORY_AUTH) {
      const result = await bootAuthFromKeychain();
      if (result.status === "restored") emitAuthSessionRestored(generation);
      return result;
    }
    let raw: string;
    try {
      raw = await fs.readFile(authCookiePath(), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { status: "missing", signedIn: false };
      return {
        status: typeof code === "string" && TEMPORARY_AUTH_FILE_ERROR_CODES.has(code)
          ? "temporarily-unavailable" : "invalid",
        signedIn: false,
      };
    }
    if (generation !== _sessionGeneration) {
      return getAuthSession().signedIn
        ? { status: "restored", signedIn: true }
        : { status: "missing", signedIn: false };
    }
    const envelope = parseStoredAuthCookie(raw);
    if (!envelope) return { status: "invalid", signedIn: false };
    failedAuthCiphertexts.delete(authCiphertextFingerprint(envelope.durableIdentity));
    if (safeStorageAvailabilitySuppressed) {
      safeStorageAvailabilitySuppressed = false;
      safeStorageAvailabilityConfirmed = false;
    }
    const prior = safeStorageDecryptInFlight;
    if (prior?.settled && prior.durableIdentity === envelope.durableIdentity) {
      consumeSafeStorageDecryptAttempt(prior);
    }
    // Pending native calls remain shared. This is one attempt, with no backoff
    // or automatic retry; a late refusal will suppress this ciphertext again.
    const result = await bootAuthFromKeychain();
    if (result.status === "restored") emitAuthSessionRestored(generation);
    return result;
  })();
  userAuthRestoreInFlight = started;
  void started.then(
    () => { if (userAuthRestoreInFlight === started) userAuthRestoreInFlight = null; },
    () => { if (userAuthRestoreInFlight === started) userAuthRestoreInFlight = null; },
  );
  return started;
}

/**
 * Bounded, non-blocking caller-owned recovery for a temporary startup miss.
 * Permanent states stop immediately; a temporary result is never converted
 * into a signed-out mutation and the encrypted file is left untouched.
 */
export async function retryTemporaryAuthRestore(options: {
  restore?: () => Promise<AuthRestoreResult>;
  wait?: (delayMs: number) => Promise<void>;
  delaysMs?: readonly number[];
} = {}): Promise<AuthRestoreResult> {
  const restore = options.restore ?? bootAuthFromKeychain;
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  }));
  const delays = options.delaysMs ?? DEFERRED_AUTH_RESTORE_DELAYS_MS;
  let result: AuthRestoreResult = { status: "temporarily-unavailable", signedIn: false };
  for (const delayMs of delays) {
    if (delayMs > 0) await wait(delayMs);
    result = await restore();
    if (result.status !== "temporarily-unavailable") return result;
  }
  return result;
}

export function getAuthSession(): AuthSession {
  if (USE_E2E_SESSION && !_cache) {
    return {
      signedIn: true,
      accountFingerprint: rendererAccountFingerprint("agentlas-e2e"),
      email: "e2e@agentlas.local",
      name: "Agentlas E2E",
      workspaceId: "e2e",
    };
  }
  if (!_cache) return { signedIn: false };
  if (_cache.expiresAt && _cache.expiresAt < Date.now()) {
    invalidateCachedSession("expired");
    return { signedIn: false };
  }
  scheduleMetaRefresh();
  return {
    signedIn: true,
    accountFingerprint: rendererAccountFingerprint(_cache.userId),
    email: _cache.email,
    name: _cache.name,
    workspaceId: _cache.workspaceId,
    expiresAt: _cache.expiresAt,
  };
}

/** cookie value를 로컬 암호화 저장소 + 메모리 캐시에 영구화하고 메타를 채운다. 두 로그인 경로(창/브라우저)가 공유. */
async function persistSession(value: string): Promise<AuthSession> {
  const decoded = decodeSessionCookie(value);
  if (decoded.status !== "valid") {
    // A browser callback never gets to overwrite a known-good local session
    // unless it carries the minimally valid signed cookie shape.
    console.warn("[auth] rejected malformed or expired sign-in cookie");
    return getAuthSession();
  }
  const generation = ++_sessionGeneration;
  try {
    await queueCookieMutation(() => writeStoredSessionCookie(value));
  } catch (err) {
    console.warn("[auth] local session save failed — keeping session in memory only", err);
  }
  // A newer login or logout owns both memory and durable state. Because cookie
  // writes are serialized, its queued mutation will also be the final disk one.
  if (generation !== _sessionGeneration) return getAuthSession();
  _cache = {
    cookieValue: value,
    userId: decoded.value.userId,
    workspaceId: decoded.value.workspaceId,
    expiresAt: decoded.value.expiresAt,
  };
  const meta = await fetchAccountMeta(value);
  if (generation !== _sessionGeneration || !_cache || _cache.cookieValue !== value) {
    return getAuthSession();
  }
  if (meta === "invalid") {
    invalidateAuthSessionFromServer(`${COOKIE_NAME}=${value}`);
    return { signedIn: false };
  }
  if (meta) {
    _cache = { ..._cache, email: meta.email, name: meta.name };
  }
  emitAuthSessionRestored(generation);
  return getAuthSession();
}

/** 마켓플레이스 fetch에 첨부할 cookie 헤더 값 — 미로그인이면 null. */
export function getSessionCookieHeader(): string | null {
  if (!_cache) return null;
  if (_cache.expiresAt && _cache.expiresAt < Date.now()) {
    invalidateCachedSession("expired");
    return null;
  }
  return `${COOKIE_NAME}=${_cache.cookieValue}`;
}

/** Main-only authority for signed Hub mutations. Never expose userId to renderer IPC. */
export function getAuthenticatedActorIds(): { workspaceId: string; userId: string } | null {
  if (USE_E2E_SESSION && !_cache) return { workspaceId: "e2e", userId: "e2e-user" };
  if (!getSessionCookieHeader() || !_cache?.workspaceId || !_cache.userId) return null;
  return { workspaceId: _cache.workspaceId, userId: _cache.userId };
}

export async function signInWithGoogle(parent: BrowserWindow | null): Promise<AuthSession> {
  const { BrowserWindow, session: electronSession } = electronApi();
  const ses = electronSession.fromPartition(AUTH_PARTITION);
  // 로그인 창은 시스템 BrowserWindow — 별도 partition으로 격리해 메인 앱의 쿠키와 섞이지 않음
  const win = new BrowserWindow({
    width: 480,
    height: 720,
    parent: parent ?? undefined,
    // 비모달 — 메인 앱을 막지 않아 "닫기 못 함" 상황을 방지. 표준 프레임(좌상단 닫기) 유지.
    modal: false,
    closable: true,
    minimizable: true,
    title: "Agentlas — 로그인 (Esc 또는 ⌘W로 닫기)",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 어떤 페이지 상태에서도 확실히 닫을 수 있게: Esc / ⌘W → 창 닫기.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const isEsc = input.key === "Escape";
    const isCmdW = (input.meta || input.control) && input.key.toLowerCase() === "w";
    if (isEsc || isCmdW) {
      try {
        win.close();
      } catch {
        // ignore
      }
    }
  });

  const loginUrl = `${webBaseUrl()}/account?desktop=1`;

  return new Promise<AuthSession>((resolve, reject) => {
    let settled = false;

    async function maybeFinish() {
      if (settled) return;
      // cookie를 partition session에서 추출
      const cookies = await ses.cookies.get({ name: COOKIE_NAME });
      if (cookies.length === 0) return;
      // 가장 fresh한 cookie 선택 — expirationDate가 큰 것
      cookies.sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0));
      const cookie = cookies[0];
      const value = cookie.value;
      settled = true;
      const session = await persistSession(value);
      try {
        win.close();
      } catch {
        // ignore
      }
      resolve(session);
    }

    // 사용자가 그냥 창을 닫으면 reject
    win.on("closed", () => {
      if (!settled) {
        settled = true;
        resolve({ signedIn: false });
      }
    });

    win.webContents.on("did-finish-load", () => {
      void maybeFinish();
    });
    win.webContents.on("did-navigate", () => {
      void maybeFinish();
    });
    win.webContents.on("did-navigate-in-page", () => {
      void maybeFinish();
    });

    win.loadURL(loginUrl).catch((err) => {
      if (settled) return;
      settled = true;
      try {
        win.close();
      } catch {
        // ignore
      }
      reject(err);
    });
  });
}

/**
 * 시스템 기본 브라우저(이미 로그인된 크롬 등)로 로그인 — 그 브라우저의 기존 세션을 재사용해
 * 가능하면 클릭 한 번으로 끝낸다. loopback(127.0.0.1) 콜백으로 세션 값을 돌려받는다.
 *
 * 흐름:
 *   1. 127.0.0.1의 임의 포트로 임시 http 서버를 띄운다.
 *   2. shell.openExternal로 agentlas.cloud 로그인 페이지를 기본 브라우저에서 연다.
 *      (callback=http://127.0.0.1:<port>/callback 을 쿼리로 전달)
 *   3. 웹앱이 로그인 완료 후 callback?session=<cookie> 로 리다이렉트하면 값을 받아 저장.
 *   4. 180초 내 콜백이 없으면 {signedIn:false} 로 resolve (호출측이 창 로그인으로 폴백).
 *
 * 주의: 끝까지 매끄러우려면 웹앱(agentlas.cloud)이 desktop callback 쿼리를 존중해야 한다.
 *       그렇지 않으면 타임아웃 후 폴백된다 — 안전(기존 동작 비파괴).
 */
export async function signInWithBrowser(): Promise<AuthSession> {
  return new Promise<AuthSession>((resolve) => {
    let settled = false;
    let acceptingCallback = true;
    const finish = (session: AuthSession, server?: http.Server) => {
      if (settled) return;
      settled = true;
      try {
        server?.close();
      } catch {
        // ignore
      }
      resolve(session);
    };

    const server = http.createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      if (!url.pathname.startsWith("/callback")) {
        res.writeHead(404).end("not found");
        return;
      }
      const value = url.searchParams.get("session") ?? url.searchParams.get("token") ?? "";
      if (value && !acceptingCallback) {
        res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
        res.end("sign-in callback already accepted");
        return;
      }
      if (value) acceptingCallback = false;
      res.writeHead(value ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackHtml(!!value));
      if (!value) return;
      void persistSession(value).then((session) => finish(session, server));
    });

    server.on("error", () => finish({ signedIn: false }));

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (!port) {
        finish({ signedIn: false }, server);
        return;
      }
      const callback = `http://127.0.0.1:${port}/callback`;
      const loginUrl = `${webBaseUrl()}/account?desktop=1&callback=${encodeURIComponent(callback)}`;
      void electronApi().shell.openExternal(loginUrl);
      setTimeout(() => finish({ signedIn: false }, server), 180000);
    });
  });
}

function callbackHtml(ok: boolean): string {
  const msg = ok
    ? "Signed in. You can close this tab and return to Agentlas."
    : "Sign-in could not be completed. Please return to Agentlas and try again.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agentlas</title></head><body style="font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#1a1a1a"><div style="text-align:center"><h2 style="font-weight:700">Agentlas</h2><p>${msg}</p></div></body></html>`;
}

export async function signOut(): Promise<void> {
  _sessionGeneration += 1;
  _cache = null;
  try {
    await queueCookieMutation(deleteStoredSessionCookie);
  } catch (err) {
    console.warn("[auth] local session delete failed", err);
  }
  // 로그인 partition의 쿠키도 모두 비움 — 다음 signIn 시 깨끗한 상태에서 시작
  try {
    const ses = electronApi().session.fromPartition(AUTH_PARTITION);
    await ses.clearStorageData({ storages: ["cookies", "localstorage"] });
  } catch (err) {
    console.warn("[auth] clearStorageData failed", err);
  }
}
