import { PROVIDER_REFUSAL_CODES, PROVIDER_UNAVAILABLE_CODES } from "./run-failure-notice";
import { TRANSIENT_HOST_ENDED_SILENCE_CODE, isTransientExternalFailure } from "./transient-provider-failure";
import type { InvocationRuntimeFailure } from "./types";

/**
 * One typed answer to "may the owner be told that this turn failed?" (owner rule, absolute).
 *
 * An owner turn that ends in failure is either
 *  - external: the cause is outside the app and the owner can act on it or only wait (network down, the model provider's outage,
 *    limit, quota or sign-in, the owner's own stop/pause, a site's own human check, an explicit wait for the owner's decision).
 *    The existing honest message (shared/run-failure-notice.ts) stays exactly as it is; or
 *  - internal: anything else. A host code (runtime_*, goal_*, team_*, task-force-*, store_busy, *_missing, *_changed ...), an untyped
 *    throw (TypeError, ReferenceError ...), an unsettled turn without provider evidence. The owner never reads such a failure: the
 *    host completes the request instead (invocation/host-recovery.ts) or, when it cannot, says in plain words what happened and what
 *    the app does about it. No code, no exception text.
 *
 * Machine facts only: a code is matched exactly (or by one documented pattern), prose is never read. An unknown code is internal.
 * The table below is the ONE list of external causes; adding a code here is the only way a code may reach the owner.
 */
export type OwnerFailureClass = "external" | "internal";

export type ExternalFailureCause =
  | "network" | "provider_outage" | "provider_limit" | "provider_auth" | "provider_refusal"
  | "provider_empty" | "owner_stop" | "owner_wait" | "site_refusal";

export interface ExternalFailureEntry {
  readonly match: "exact" | "pattern";
  /** Exact code, or the source of a regular expression that must match the whole code. */
  readonly code: string;
  readonly cause: ExternalFailureCause;
  readonly reason: string;
}

const entry = (cause: ExternalFailureCause, reason: string, codes: readonly string[]): ExternalFailureEntry[] =>
  codes.map((code) => ({ match: "exact" as const, code, cause, reason }));

export const EXTERNAL_FAILURE_TABLE: readonly ExternalFailureEntry[] = Object.freeze([
  ...entry("network", "The machine or the provider could not be reached (offline, DNS, reset, timeout).", [
    "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "ENETRESET",
    "EHOSTUNREACH", "EPIPE", "ERR_NETWORK", "ERR_INTERNET_DISCONNECTED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "network_offline", "network_unreachable",
    "codex_http_connection_failed", "codex_response_stream_connection_failed",
  ]),
  ...entry("provider_outage", "The model provider could not take the request (outage, overload, capacity).",
    [...PROVIDER_UNAVAILABLE_CODES, TRANSIENT_HOST_ENDED_SILENCE_CODE, "serving_unavailable", "http_502", "http_503", "http_504", "http_529"]),
  { match: "pattern", code: "http_5\\d\\d", cause: "provider_outage", reason: "Any other 5xx answer of the provider or of Agentlas serving." },
  ...entry("provider_limit", "A usage, rate, credit, context or retry-window limit of the provider (or one the owner set).", [
    "http_429", "rate_limit", "rate_limited", "quota", "quota_exceeded", "quota_exhausted", "insufficient_credits",
    "subscription_credits_disabled", "usage_limit_reached", "runtime_retry_not_before", "runtime_retry_budget_exhausted",
    "model_context_capacity_exceeded", "codex_context_window_exceeded", "budget_cost_exhausted", "budget_cost_unavailable",
  ]),
  ...entry("provider_auth", "The provider (or the signed-in browser) needs the owner to sign in.", [
    "http_401", "auth", "auth_expired", "auth_required", "auth-required", "login_required", "login-required", "not_signed_in",
    "provider-login-required", "agentlas-browser-host-unavailable", "runtime_not_signed_in", "sign_in_required", "goal_runtime_sign_in_required",
    "finance_sign_in_required", "workforce_account_sign_in_required", "agentlas_sign_in", "provider_key_missing", "provider_unauthenticated",
    "provider_auth_failed", "unauthenticated", "unauthorized", "browser_login_required", "login-or-oauth-required",
  ]),
  ...entry("provider_refusal", "The model provider itself declined or blocked the answer (safety or policy filter).", [...PROVIDER_REFUSAL_CODES]),
  ...entry("owner_stop", "The owner stopped, paused, steered or revoked: their own act, never a failure.", [
    "cancelled", "interrupted", "invoke_cancelled", "invoke_interrupted", "stopped_by_user", "browser_login_wait_cancelled",
    "goal_stop_in_progress", "native-browser-grant-revoked",
  ]),
  ...entry("owner_wait", "An explicit wait for the owner's decision, answer or sign-in.", [
    "waiting_input", "browser_login_waiting", "owner_decision_pending", "user_decision_required",
  ]),
  ...entry("site_refusal", "A site's own refusal: a human check, a captcha, a bot check.", [
    "human-check-required", "human-check-wait", "human_check_required", "human_check_timeout", "captcha-or-provider-bot-check",
    "captcha-or-human-verification", "captcha-solving", "cross-site-blocked", "login-wall", "login_wall",
  ]),
]);

const EXACT = new Map<string, ExternalFailureEntry>();
const PATTERNS: Array<{ re: RegExp; entry: ExternalFailureEntry }> = [];
for (const item of EXTERNAL_FAILURE_TABLE) {
  if (item.match === "exact") EXACT.set(item.code, item);
  else PATTERNS.push({ re: new RegExp(`^(?:${item.code})$`), entry: item });
}

const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;

/** The table row a code belongs to, or null (= internal). */
export function externalFailureEntry(code: unknown): ExternalFailureEntry | null {
  if (typeof code !== "string" || !CODE_RE.test(code)) return null;
  return EXACT.get(code) ?? PATTERNS.find((item) => item.re.test(code))?.entry ?? null;
}

export interface OwnerFailureFacts {
  /** The run's terminal machine code (event.error.code, receipt.errorCode, a thrown error's own .code). */
  code?: string | null;
  /** The host-observed provider failure (event.error.runtimeFailure, receipt.runtimeFailure). */
  runtimeFailure?: Pick<InvocationRuntimeFailure, "kind" | "source" | "providerCode" | "retryAfterAt"> & { cause?: unknown } | null;
  /** Main's own stop marker (app quit, update restart, Goal paused or deleted). */
  hostStopCause?: string | null;
  /** The owner pressed Stop / a steering message replaced this turn. */
  ownerStopped?: boolean;
  /** The turn ended waiting for the owner (a question card, a sign-in), which is the owner's move, not a failure. */
  ownerWait?: boolean;
}

export interface OwnerFailureVerdict {
  klass: OwnerFailureClass;
  cause?: ExternalFailureCause;
  /** Which fact decided: "code" | "runtimeFailure" | "owner-stop" | "owner-wait" | "default-internal". */
  decidedBy: "code" | "runtimeFailure" | "owner-stop" | "owner-wait" | "default-internal";
}

const PROVIDER_KINDS: Readonly<Record<string, ExternalFailureCause>> = {
  quota: "provider_limit", rate_limit: "provider_limit", auth: "provider_auth",
};

function causeOfRuntimeFailure(failure: NonNullable<OwnerFailureFacts["runtimeFailure"]>): ExternalFailureCause | null {
  const typed = PROVIDER_KINDS[failure.kind as string];
  if (typed) return typed;
  // The model itself ended with no answer (every runner types it `empty`); the app did nothing wrong and the existing sentence says so.
  if (failure.kind === "empty") return "provider_empty";
  const byCode = externalFailureEntry(failure.providerCode);
  if (byCode) return byCode.cause;
  // A bare `refused` (the provider gave no code) is the provider's refusal; a host-owned code beside it is the host's own limit.
  if (failure.kind === "refused" && !failure.providerCode) return "provider_refusal";
  return null;
}

/**
 * The classifier. Order: the owner's own act, the owner's wait, the provider's typed failure, the terminal code, then internal.
 * `runtime_turn_unsettled` is external only when the runner typed a provider cause behind it; bare, it is internal (the turn ended
 * without a receipt and nothing outside the app is to blame).
 */
export function classifyOwnerFailureDetailed(failure: OwnerFailureFacts): OwnerFailureVerdict {
  if (failure.ownerStopped || failure.hostStopCause) return { klass: "external", cause: "owner_stop", decidedBy: "owner-stop" };
  if (failure.ownerWait) return { klass: "external", cause: "owner_wait", decidedBy: "owner-wait" };
  const code = typeof failure.code === "string" ? failure.code : null;
  const runtimeFailure = failure.runtimeFailure ?? null;
  if (runtimeFailure) {
    // The one list of transient causes outside the app (the provider at capacity, a lost stream, a silent stream the host ended).
    if (isTransientExternalFailure(runtimeFailure)) return { klass: "external", cause: "provider_outage", decidedBy: "runtimeFailure" };
    const own = causeOfRuntimeFailure(runtimeFailure);
    if (own) return { klass: "external", cause: own, decidedBy: "runtimeFailure" };
    const behind = runtimeFailure.cause && typeof runtimeFailure.cause === "object"
      ? causeOfRuntimeFailure(runtimeFailure.cause as NonNullable<OwnerFailureFacts["runtimeFailure"]>) : null;
    if (behind) return { klass: "external", cause: behind, decidedBy: "runtimeFailure" };
  }
  const row = externalFailureEntry(code);
  if (row) return { klass: "external", cause: row.cause, decidedBy: "code" };
  return { klass: "internal", decidedBy: "default-internal" };
}

export function classifyOwnerFailure(failure: OwnerFailureFacts): OwnerFailureClass {
  return classifyOwnerFailureDetailed(failure).klass;
}

/**
 * The only text an internal failure may show the owner: plain words, no code, no exception name, no path. `plan` is what the app
 * does about it (the caller knows; this file only words it).
 *  - recovering: the app starts the same request once more by itself (nothing had acted).
 *  - recovered: the retry finished the request (a quiet line under the answer).
 *  - uncertain: something may already have run, so the app did not run it again.
 *  - exhausted: the one automatic retry also failed inside the app.
 *  - newer: the owner has already written something newer; nothing is re-run on their behalf.
 *  - goal: the owner's Goal carries the request on by itself.
 *  - checking: something may have run, and the send queue sends the message once more by itself after telling the model so.
 *  - manual: nothing ran, but the request cannot be replayed by the host (a one-use attachment); it is saved.
 *  - background: a turn the host started itself (not the owner's words); the problem is logged.
 */
export type InternalFailurePlan = "recovering" | "recovered" | "uncertain" | "checking" | "exhausted" | "newer" | "goal" | "manual" | "background";

const OWNER_LINES: Record<"ko" | "en", Record<InternalFailurePlan, string>> = {
  ko: {
    recovering: "앱 안쪽 문제로 이번 시도가 끝나지 못했습니다. 아무것도 실행되지 않았고, 앱이 같은 요청을 한 번 더 자동으로 처리합니다.",
    recovered: "앱 안쪽 문제로 한 번 막혔지만 자동으로 다시 시도해 완료했습니다.",
    uncertain: "앱 안쪽 문제로 이번 시도가 중간에 멈췄습니다. 일부 작업이 이미 실행됐을 수 있어 자동으로 다시 실행하지 않았습니다. 이어서 하려면 말씀해 주세요. 앱이 먼저 어디까지 됐는지 확인하고 이어갑니다.",
    exhausted: "앱 안쪽 문제로 이 요청을 끝내지 못했고, 자동 재시도도 같은 문제로 멈췄습니다. 문제는 기록으로 남겼습니다. 요청은 저장되어 있어 같은 내용을 다시 보내시면 이어서 처리합니다.",
    newer: "앱 안쪽 문제로 이전 요청이 끝나지 못했습니다. 더 최근 메시지를 보내셨으므로 이전 요청은 자동으로 다시 실행하지 않았습니다.",
    goal: "앱 안쪽 문제로 이번 시도가 끝나지 못했습니다. 이 방의 목표가 다음 차례에 이어서 처리합니다.",
    checking: "앱 안쪽 문제로 이번 시도가 중간에 멈췄습니다. 일부 작업이 이미 실행됐을 수 있어, 앱이 먼저 어디까지 됐는지 확인한 뒤 한 번 이어서 처리합니다.",
    manual: "앱 안쪽 문제로 이 요청을 시작하지 못했습니다. 아무것도 실행되지 않았고 요청은 저장되어 있습니다. 문제는 기록으로 남겼으니 같은 내용을 다시 보내 주세요.",
    background: "앱 안쪽 문제로 이번 자동 실행이 끝나지 못했습니다. 문제는 기록으로 남겼습니다.",
  },
  en: {
    recovering: "An app-side problem stopped this attempt. Nothing had run, and the app is handling the same request once more by itself.",
    recovered: "An app-side problem stopped it once, and the app retried by itself and finished the request.",
    uncertain: "An app-side problem stopped this attempt midway. Some work may already have run, so the app did not run it again. Tell me to continue and the app first checks how far it got.",
    exhausted: "An app-side problem stopped this request, and the automatic retry stopped the same way. The problem is logged. Your request is saved; send the same words again to continue.",
    newer: "An app-side problem stopped the earlier request. You have written something newer since, so the earlier request was not re-run for you.",
    goal: "An app-side problem stopped this attempt. This room's Goal carries the work on at its next turn.",
    checking: "An app-side problem stopped this attempt midway. Some work may already have run, so the app first checks how far it got and then continues once.",
    manual: "An app-side problem kept this request from starting. Nothing ran and your request is saved. The problem is logged; please send the same words again.",
    background: "An app-side problem stopped this automatic run. The problem is logged.",
  },
};

export function internalFailureOwnerLine(locale: "ko" | "en", plan: InternalFailurePlan): string {
  return OWNER_LINES[locale === "ko" ? "ko" : "en"][plan];
}

/**
 * Raw exception text never leaves the host: `TypeError: x is not a function`, `Cannot read properties of undefined`, a stack, an
 * absolute path. The owner-facing channels (the transcript line, the error event, the phone projection) take the verdict, not
 * the message. A machine-looking or exception-looking message is replaced; a plain provider sentence stays only for an external
 * failure (the caller decides by the verdict above).
 */
const EXCEPTION_TEXT_RE = /(?:^|\n|\s)(?:[A-Z][A-Za-z]*Error|AggregateError|DOMException)\b[:\s]|\bat\s+(?:[\w$.<>]+\s+)?\(?(?:file:\/\/|\/|[A-Za-z]:\\)[^\s)]*:\d+(?::\d+)?\)?|\bCannot read propert(?:y|ies) of\b|\bis not a function\b|\bis not defined\b|\bis not iterable\b|\bundefined is not\b|\bSQLITE_[A-Z_]+\b|\bERR_[A-Z_]+\b/;
/** The classes of the app's own bugs. Told by class, never by words (as invocation/host-internal-failure.ts does). */
const HOST_EXCEPTION_CLASSES: ReadonlySet<string> = new Set(["TypeError", "ReferenceError", "RangeError", "SyntaxError", "EvalError", "URIError"]);
export function isHostExceptionClass(error: unknown): boolean {
  return error instanceof Error && HOST_EXCEPTION_CLASSES.has(error.name);
}

/** The one line a window may show for the app's own exception that crossed the IPC boundary (both languages: this boundary has no locale). */
export const HOST_EXCEPTION_OWNER_LINE = "앱 안쪽 문제로 이 작업을 처리하지 못했습니다. 문제는 기록으로 남겼습니다. (The app hit an internal problem and could not process this; it is logged.)";
export const HOST_EXCEPTION_IPC_CODE = "app_internal";

export function looksLikeRawExceptionText(text: unknown): boolean {
  return typeof text === "string" && EXCEPTION_TEXT_RE.test(text);
}
