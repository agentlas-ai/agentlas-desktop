/**
 * Company server (Agentlas Enterprise Server) connection as the Settings card sees it
 * (docs/enterprise-server/05-MIGRATION-AND-DESKTOP-SPLIT.md §4, API-CONTRACT.md §4.1–4.2).
 *
 * What crosses to the renderer is status only: where the connection came from, the server address and the pinned key
 * fingerprint, the seat token's mode and expiry, the license state the server reports, and the last update-feed check.
 * The device private key, the seat token itself and a managed file's enrollment code never leave Main.
 * Pure types and functions — no Electron, no DOM — so Main, the renderer and the gates read the same rules.
 */

export const ENTERPRISE_SERVER_STATUS_SCHEMA = "agentlas.enterprise-server-desktop-status.v1" as const;

/** License states the server reports (02-LICENSE-PROTOCOL.md §5). */
export const ENTERPRISE_LICENSE_STATES = [
  "unlicensed", "invalid", "not_yet_valid", "activation_required", "active", "lease_expired", "term_grace", "payment_grace",
  "clock_untrusted", "suspended", "revoked", "expired",
] as const;
export type EnterpriseLicenseState = (typeof ENTERPRISE_LICENSE_STATES)[number];
export type EnterpriseLicenseMode = "setup" | "full" | "readonly" | "stopped";

/** Error codes that may reach the renderer. Anything else a server says is folded into "server_error" in Main. */
export const ENTERPRISE_ERROR_CODES = [
  // input checked in Main
  "enrollment_code_format", "server_url_invalid", "fingerprint_invalid", "managed_connection_locked", "already_enrolled",
  "not_connected", "not_enrolled", "confirm_required", "busy",
  // company server answers (API-CONTRACT.md §5)
  "enrollment_code_invalid", "seat_limit_reached", "device_limit_reached", "device_exists", "device_revoked", "device_unknown",
  "license_mode_blocks:enroll", "license_mode_blocks:token", "rate_limited", "invalid_request", "clock_skew", "replay", "signature_invalid",
  // this Desktop's own checks
  "seat_token_untrusted", "seat_response_invalid", "server_key_mismatch", "server_status_invalid", "server_unreachable", "server_error",
] as const;
export type EnterpriseErrorCode = (typeof ENTERPRISE_ERROR_CODES)[number];
export function isEnterpriseErrorCode(value: unknown): value is EnterpriseErrorCode {
  return typeof value === "string" && (ENTERPRISE_ERROR_CODES as readonly string[]).includes(value);
}

/** The one-time code a company admin gives an employee (API-CONTRACT.md §4.2). */
export const ENROLLMENT_CODE_RE = /^ENR-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const SERVER_KEY_FINGERPRINT_RE = /^[a-f0-9]{64}$/;

export interface EnterpriseServerStatus {
  readonly schema: typeof ENTERPRISE_SERVER_STATUS_SCHEMA;
  /** A connection exists: a managed (MDM/GPO) file, or one this person entered on this device. */
  readonly connected: boolean;
  readonly source: "managed" | "user" | null;
  /** The managed file that supplied the connection (shown so IT and the employee can see where it comes from). */
  readonly managedFile: string | null;
  /** A managed file exists at one of the machine locations but is unreadable or invalid (so it was ignored). */
  readonly managedFileIgnored: string | null;
  readonly serverUrl: string | null;
  readonly serverKeyFingerprint: string | null;
  /** "company" only with a managed file that says so; a user-entered connection never moves the update feed. */
  readonly updates: "company" | "agentlas";
  /** The managed file carries an enrollment code (the code itself stays in Main). */
  readonly managedEnrollmentCode: boolean;
  /** This device enrolled with the server at some point (it holds a device identity the server knows). */
  readonly enrolled: boolean;
  /** Identifies this device on the server's admin screen (not a secret). Null before enrollment. */
  readonly deviceId: string | null;
  readonly seat: {
    readonly valid: boolean;
    readonly mode: "full" | "readonly" | null;
    readonly expiresAt: string | null;
  };
  /** What the server last said about its license (GET /api/v1/status), null until read. */
  readonly license: {
    readonly state: EnterpriseLicenseState;
    readonly mode: EnterpriseLicenseMode;
    readonly termEndsAt: string | null;
    readonly leaseUntil: string | null;
  } | null;
  readonly lastCheckAt: string | null;
  readonly lastError: { readonly code: EnterpriseErrorCode; readonly at: string } | null;
  readonly updateFeed: {
    readonly source: "company" | "agentlas";
    readonly lastCheckAt: string | null;
    readonly ok: boolean | null;
    readonly version: string | null;
  };
}

export interface EnterpriseServerActionResult {
  readonly ok: boolean;
  readonly error: EnterpriseErrorCode | null;
  readonly status: EnterpriseServerStatus;
}

export interface EnterpriseEnrollInput {
  readonly enrollmentCode: string;
  /** Only without a managed file: the address and fingerprint the company admin gave. */
  readonly serverUrl?: string;
  readonly serverKeyFingerprint?: string;
}

export interface EnterpriseServerAPI {
  status(): Promise<EnterpriseServerStatus>;
  /** Enroll this device with a one-time code from the company admin. */
  enroll(input: EnterpriseEnrollInput): Promise<EnterpriseServerActionResult>;
  /** Refresh the seat token and read the server's license state now. */
  recheck(): Promise<EnterpriseServerActionResult>;
  /** Forget this device's company enrollment (device key, seat token, a user-entered connection). Needs `{ confirm: true }`. */
  disconnect(input: { confirm: true }): Promise<EnterpriseServerActionResult>;
}

export type EnterpriseServerPhase =
  | "not_connected" | "needs_enrollment" | "active" | "grace" | "suspended" | "revoked" | "expired" | "unverified";

const GRACE_STATES: ReadonlySet<string> = new Set(["term_grace", "payment_grace", "lease_expired", "clock_untrusted"]);

/**
 * One reading of the card. Stopped license states win over a still-unexpired token (a token issued before a suspension
 * lives up to 12 hours); a revoked device wins over everything; grace means the license or the token is read-only.
 */
export function enterpriseServerPhase(status: EnterpriseServerStatus): EnterpriseServerPhase {
  if (!status.connected) return "not_connected";
  if (status.lastError?.code === "device_revoked") return "revoked";
  const state = status.license?.state ?? null;
  if (state === "revoked") return "revoked";
  if (state === "suspended") return "suspended";
  if (state === "expired") return "expired";
  if (!status.enrolled) return "needs_enrollment";
  if ((state !== null && GRACE_STATES.has(state)) || (status.seat.valid && status.seat.mode === "readonly")) return "grace";
  if (status.seat.valid && status.seat.mode === "full") return "active";
  return "unverified";
}

/** Phases in which the enrollment-code form is offered. */
export function enterpriseCanEnroll(status: EnterpriseServerStatus): boolean {
  const phase = enterpriseServerPhase(status);
  return phase === "not_connected" || phase === "needs_enrollment" || (phase === "revoked" && status.lastError?.code === "device_revoked");
}
