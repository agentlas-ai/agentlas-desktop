import { getSessionCookieHeader, invalidateAuthSessionFromServer, webBaseUrl } from "../auth";
import { MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE } from "../../shared/mobile-bridge";

const DESKTOP_PROOF_PATH = "/api/mobile-pair/v1/desktop-proof";
const CONSUME_ASSERTION_PATH = "/api/mobile-pair/v1/assertions/consume";
const ACCOUNT_STATUS_PATH = "/api/mobile-pair/v1/account/status";
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const OFFICIAL_HOSTS = new Set([
  "agentlas.cloud",
  "www.agentlas.cloud",
  "api.agentlas.cloud",
  "staging.agentlas.cloud",
]);

const ACCOUNT_SUBJECT_RE = /^mps_[A-Za-z0-9_-]{43}$/;
const PAIRING_ATTEMPT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEVICE_NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const OPAQUE_PROOF_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const RECEIPT_RE = /^mpr_[A-Za-z0-9_-]{24}$/;

/**
 * "unreachable" exists so a transient outage can never be mistaken for a
 * definitive "this account is gone". Only "inactive" may revoke a credential.
 */
export type AccountAuthorityStatus = "active" | "inactive" | "unreachable";

export type MobileBridgeAccountPairingFailureCode =
  | "invalid_request"
  | "invalid_proof"
  | "account_mismatch"
  | "binding_mismatch"
  | "replayed"
  | "storage_unavailable"
  | "unauthenticated"
  | "origin_not_allowed"
  | "mobile_pair_not_configured"
  | "account_authority_unavailable";

const WEB_ERROR_CODES = new Set<MobileBridgeAccountPairingFailureCode>([
  "invalid_request",
  "invalid_proof",
  "account_mismatch",
  "binding_mismatch",
  "replayed",
  "storage_unavailable",
  "unauthenticated",
  "origin_not_allowed",
  "mobile_pair_not_configured",
]);

export class MobileBridgeAccountPairingError extends Error {
  constructor(readonly code: MobileBridgeAccountPairingFailureCode, message: string) {
    super(message);
    this.name = "MobileBridgeAccountPairingError";
  }
}

export interface MobileBridgeDesktopAccountProof {
  hostId: string;
  pairingAttemptId: string;
  desktopAccountProof: string;
  accountSubject: string;
  accountAuthorityOrigin: string;
  expiresIn: number;
}

export interface MobileBridgeConsumedPairingAssertion {
  accountSubject: string;
  receiptId: string;
}

export interface MobileBridgeAccountPairingClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  cookieProvider?: () => string | null;
  timeoutMs?: number;
  allowLoopback?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function approvedOrigin(raw: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MobileBridgeAccountPairingError("account_authority_unavailable", "Agentlas Web origin is invalid.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const approved = url.protocol === "https:" && OFFICIAL_HOSTS.has(hostname);
  if (
    (!approved && !(allowLoopback && loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    (Boolean(url.port) && !loopback)
  ) {
    throw new MobileBridgeAccountPairingError(
      "account_authority_unavailable",
      "Agentlas Web origin is not approved for account pairing.",
    );
  }
  return `${url.protocol}//${url.host}`;
}

function validCookie(value: string | null): value is string {
  return typeof value === "string" && /^agentlas_session=[^;\r\n]{8,4096}$/.test(value);
}

function validOpaqueProof(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && OPAQUE_PROOF_RE.test(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new MobileBridgeAccountPairingError(
      "account_authority_unavailable",
      "Agentlas Web returned a non-JSON account-pairing response.",
    );
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new MobileBridgeAccountPairingError("account_authority_unavailable", "Account-pairing response is too large.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new MobileBridgeAccountPairingError("account_authority_unavailable", "Account-pairing response is too large.");
      }
      chunks.push(next.value);
    }
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MobileBridgeAccountPairingError("account_authority_unavailable", "Account-pairing response is malformed.");
  }
}

function responseFailure(raw: unknown): MobileBridgeAccountPairingFailureCode | null {
  if (!isRecord(raw) || !exactKeys(raw, ["error"]) || typeof raw.error !== "string") return null;
  return WEB_ERROR_CODES.has(raw.error as MobileBridgeAccountPairingFailureCode)
    ? raw.error as MobileBridgeAccountPairingFailureCode
    : null;
}

export class MobileBridgeAccountPairingClient {
  readonly origin: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly cookieProvider: () => string | null;
  private readonly timeoutMs: number;

  constructor(options: MobileBridgeAccountPairingClientOptions = {}) {
    this.origin = approvedOrigin(
      options.baseUrl ?? webBaseUrl(),
      options.allowLoopback === true || process.env.NODE_ENV !== "production",
    );
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.cookieProvider = options.cookieProvider ?? (() => getSessionCookieHeader());
    this.timeoutMs = Math.max(500, Math.min(15_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  }

  async issueDesktopProof(input: {
    hostId: string;
    pairingAttemptId: string;
  }): Promise<MobileBridgeDesktopAccountProof> {
    if (!HOST_ID_RE.test(input.hostId) || !PAIRING_ATTEMPT_RE.test(input.pairingAttemptId)) {
      throw new MobileBridgeAccountPairingError("invalid_request", "Desktop pairing identity is invalid.");
    }
    const cookie = this.cookieProvider();
    if (!validCookie(cookie)) {
      throw new MobileBridgeAccountPairingError(
        "unauthenticated",
        "Sign in to Agentlas on this Desktop before pairing a mobile device.",
      );
    }
    const response = await this.post(DESKTOP_PROOF_PATH, {
      host_id: input.hostId,
      pairing_attempt_id: input.pairingAttemptId,
    }, cookie);
    let raw: unknown;
    try {
      raw = await boundedJson(response);
    } catch (error) {
      if (response.status === 401) invalidateAuthSessionFromServer(cookie);
      throw error;
    }
    if (!response.ok) {
      const code = responseFailure(raw) ?? "account_authority_unavailable";
      if (response.status === 401 || code === "unauthenticated") invalidateAuthSessionFromServer(cookie);
      throw new MobileBridgeAccountPairingError(
        code,
        code === "unauthenticated"
          ? "Your Agentlas Desktop sign-in expired. Sign in again before pairing."
          : "Agentlas Web could not issue a Desktop account proof.",
      );
    }
    if (
      !isRecord(raw) ||
      !exactKeys(raw, ["desktop_account_proof", "proof_type", "expires_in", "account_subject"]) ||
      !validOpaqueProof(raw.desktop_account_proof) ||
      raw.proof_type !== "mobile_pair_desktop" ||
      !Number.isInteger(raw.expires_in) ||
      (raw.expires_in as number) <= 0 ||
      (raw.expires_in as number) > 5 * 60 ||
      typeof raw.account_subject !== "string" ||
      !ACCOUNT_SUBJECT_RE.test(raw.account_subject)
    ) {
      throw new MobileBridgeAccountPairingError(
        "account_authority_unavailable",
        "Agentlas Web returned an invalid Desktop account proof.",
      );
    }
    return {
      hostId: input.hostId,
      pairingAttemptId: input.pairingAttemptId,
      desktopAccountProof: raw.desktop_account_proof,
      accountSubject: raw.account_subject,
      accountAuthorityOrigin: this.origin,
      expiresIn: raw.expires_in as number,
    };
  }

  /**
   * Tri-state on purpose. "We could not reach the account authority" is NOT
   * "this account is inactive", and collapsing the two destroyed real
   * pairings: the caller revoked the device on a network blip, a 503 from the
   * status route, or any non-JSON body. A revoke is permanent and forces the
   * user to re-scan a QR, so it may only follow a definitive server answer.
   */
  async accountAuthorityStatus(input: { accountSubject: string }): Promise<AccountAuthorityStatus> {
    if (!ACCOUNT_SUBJECT_RE.test(input.accountSubject)) return "inactive";
    let response: Response;
    try {
      response = await this.post(ACCOUNT_STATUS_PATH, { account_subject: input.accountSubject });
    } catch {
      return "unreachable";
    }
    // 5xx and 429 are the authority telling us it cannot answer right now.
    // 401/403/404 are definitive answers about this subject.
    if (response.status >= 500 || response.status === 408 || response.status === 429) return "unreachable";
    let raw: unknown;
    try {
      raw = await boundedJson(response);
    } catch {
      return "unreachable";
    }
    if (!response.ok) return "inactive";
    if (!isRecord(raw) || !exactKeys(raw, ["active"])) return "unreachable";
    return raw.active === true ? "active" : "inactive";
  }

  /** @deprecated Use accountAuthorityStatus — a boolean cannot express "unreachable". */
  async accountAuthorityActive(input: { accountSubject: string }): Promise<boolean> {
    return (await this.accountAuthorityStatus(input)) === "active";
  }

  async consumePairingAssertion(input: {
    pairingAssertion: string;
    audience: typeof MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE;
    hostId: string;
    deviceNonce: string;
    pairingAttemptId: string;
  }): Promise<MobileBridgeConsumedPairingAssertion> {
    if (
      !validOpaqueProof(input.pairingAssertion) ||
      input.audience !== MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE ||
      !HOST_ID_RE.test(input.hostId) ||
      !DEVICE_NONCE_RE.test(input.deviceNonce) ||
      !PAIRING_ATTEMPT_RE.test(input.pairingAttemptId)
    ) {
      throw new MobileBridgeAccountPairingError("invalid_request", "Mobile pairing assertion binding is invalid.");
    }
    const response = await this.post(CONSUME_ASSERTION_PATH, {
      pairing_assertion: input.pairingAssertion,
      audience: input.audience,
      host_id: input.hostId,
      device_nonce: input.deviceNonce,
      pairing_attempt_id: input.pairingAttemptId,
    });
    const raw = await boundedJson(response);
    if (!response.ok) {
      const code = responseFailure(raw) ?? "account_authority_unavailable";
      throw new MobileBridgeAccountPairingError(code, "Agentlas Web rejected the mobile pairing assertion.");
    }
    if (
      !isRecord(raw) ||
      !exactKeys(raw, ["status", "account_subject", "receipt_id"]) ||
      raw.status !== "consumed" ||
      typeof raw.account_subject !== "string" ||
      !ACCOUNT_SUBJECT_RE.test(raw.account_subject) ||
      typeof raw.receipt_id !== "string" ||
      !RECEIPT_RE.test(raw.receipt_id)
    ) {
      throw new MobileBridgeAccountPairingError(
        "account_authority_unavailable",
        "Agentlas Web returned an invalid assertion receipt.",
      );
    }
    return { accountSubject: raw.account_subject, receiptId: raw.receipt_id };
  }

  private async post(pathname: string, body: unknown, cookie?: string): Promise<Response> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, "utf8") > MAX_BODY_BYTES) {
      throw new MobileBridgeAccountPairingError("invalid_request", "Account-pairing request is too large.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      return await this.fetcher(`${this.origin}${pathname}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: this.origin,
          ...(cookie ? { cookie } : {}),
        },
        body: encoded,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
      });
    } catch (error) {
      if (error instanceof MobileBridgeAccountPairingError) throw error;
      throw new MobileBridgeAccountPairingError(
        "account_authority_unavailable",
        "Agentlas Web account-pairing service is unavailable.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export const mobileBridgeAccountPairingContract = {
  desktopProofPath: DESKTOP_PROOF_PATH,
  consumeAssertionPath: CONSUME_ASSERTION_PATH,
  accountStatusPath: ACCOUNT_STATUS_PATH,
  maxBodyBytes: MAX_BODY_BYTES,
  audience: MOBILE_BRIDGE_PAIR_ASSERTION_AUDIENCE,
} as const;
