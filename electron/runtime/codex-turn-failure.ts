/*
 * Codex turn failures as typed RunnerFailures (audit 31 A1 C8.1/C3.5, A5 idea 6; plan R-058 AS, R-007, R-070).
 *
 * The app-server names why a turn failed in `turn.error.codexErrorInfo` (and in the `error` notification). Until
 * 1.3.53 only six literals were read and folded into quota/auth/refused/exit with no providerCode, so rate limits,
 * overload, stream disconnects and context overflow were all "exit" and nothing downstream could key a recovery on them.
 * Every value of the 0.163.0 schema (`codex app-server generate-json-schema`: 15 enum values + 5 structured variants)
 * now maps to a kind and a stable lower-case providerCode (`codex_<snake_case>`), from a table the compiler checks for
 * exhaustiveness. A value a newer CLI adds keeps its own code (`codex_<snake_case>`, kind exit), never a guessed one.
 *
 * Two causes have no codexErrorInfo of their own and are read from the protocol's fixed rendering of a typed error,
 * exact template only (never a prose search):
 *   - ResponseIncompleteError: codex-rs protocol/src/error.rs `#[error("Incomplete response returned, reason: {reason}")]`;
 *     `to_codex_protocol_error` maps it to `other`, and `codex exec --json` carries no code at all. Reason
 *     `max_output_tokens` is the output-token cap (production 1.3.49 run 5d37e4cc: a teammate cut at 128,000 output
 *     tokens after 62 minutes).
 *   - ContextWindowExceeded on `codex exec --json` (no codexErrorInfo on exec): its Display prefix is the one Codex's own
 *     input-limit classifier matches (error.rs comment "The iOS input-limit classifier matches this message's ASCII prefix").
 */
import type { RunnerFailure, RunnerFailureKind } from "./runner";

/** The output-token cap cut this reply. Matches team-step-settlement isOutputLimitCode (`…_output_limit_…`). */
export const CODEX_OUTPUT_LIMIT_CODE = "codex_output_limit_exceeded";
/** The model's context window ran out (codexErrorInfo contextWindowExceeded, or exec's typed rendering of it). */
export const CODEX_CONTEXT_WINDOW_CODE = "codex_context_window_exceeded";

/**
 * Request throttling (codexErrorInfo rateLimitExceeded, HTTP 429 variants): RunnerFailureKind "rate_limit" (docs 31 W1,
 * shared/turn-settlement.ts bounds its retries). Codex's turn error carries no Retry-After, so no retryAfterHint is set
 * (Codex already retried with the server's delay before it failed the turn).
 */
const RATE_LIMIT_KIND: RunnerFailureKind = "rate_limit";

/** The CodexErrorInfo names of codex-cli 0.163.0 (stable and --experimental schemas are identical here), plus two
 *  codex-rs main added after 0.163.0 (bioPolicy, invalidPrompt). */
export type CodexErrorInfoName =
  | "contextWindowExceeded" | "sessionBudgetExceeded" | "usageLimitExceeded" | "rateLimitExceeded" | "flexUnavailable"
  | "serverOverloaded" | "cyberPolicy" | "misalignmentPolicyViolation" | "tooManyDenials" | "internalServerError"
  | "unauthorized" | "badRequest" | "threadRollbackFailed" | "sandboxError" | "other"
  | "httpConnectionFailed" | "responseStreamConnectionFailed" | "responseStreamDisconnected"
  | "responseTooManyFailedAttempts" | "activeTurnNotSteerable"
  | "bioPolicy" | "invalidPrompt";

/** Kind per CodexErrorInfo. A `Record` over the union: a name added to the type without a row does not compile. */
export const CODEX_ERROR_INFO_KINDS: Readonly<Record<CodexErrorInfoName, RunnerFailureKind>> = Object.freeze({
  contextWindowExceeded: "refused",          // same kind as BYOK/serving model_context_capacity_exceeded
  sessionBudgetExceeded: "quota",
  usageLimitExceeded: "quota",
  rateLimitExceeded: RATE_LIMIT_KIND,
  flexUnavailable: "unavailable",
  serverOverloaded: "unavailable",           // "Selected model is at capacity": transient, Codex already retried it
  cyberPolicy: "refused",
  misalignmentPolicyViolation: "refused",
  tooManyDenials: "refused",                 // the turn stopped after repeated approval denials
  internalServerError: "unavailable",
  unauthorized: "auth",
  badRequest: "unsupported",                 // unsupported operation, thread not found, agent limit
  threadRollbackFailed: "exit",
  sandboxError: "exit",
  other: "exit",
  httpConnectionFailed: "unavailable",       // refined by httpStatusCode below
  responseStreamConnectionFailed: "unavailable",
  responseStreamDisconnected: "unavailable",
  responseTooManyFailedAttempts: "unavailable",
  activeTurnNotSteerable: "unavailable",     // another non-steerable turn (review, compact) holds the thread
  bioPolicy: "refused",
  invalidPrompt: "unsupported",
});

const NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** camelCase CodexErrorInfo name → `codex_snake_case` providerCode. */
export function codexErrorInfoCode(name: string): string {
  return `codex_${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`;
}

/** The CodexErrorInfo value's name and, for the structured variants, its upstream HTTP status. */
export function readCodexErrorInfo(info: unknown): { name: string; httpStatus: number | null } | null {
  if (typeof info === "string") return NAME_RE.test(info) ? { name: info, httpStatus: null } : null;
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const keys = Object.keys(info as Record<string, unknown>);
  if (keys.length !== 1 || !NAME_RE.test(keys[0])) return null;
  const body = (info as Record<string, unknown>)[keys[0]];
  const status = body && typeof body === "object" ? (body as { httpStatusCode?: unknown }).httpStatusCode : undefined;
  return { name: keys[0], httpStatus: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null };
}

/** An upstream HTTP status overrides the variant's default only where the status itself is the verdict. */
function kindForStatus(kind: RunnerFailureKind, status: number | null): RunnerFailureKind {
  if (status === 401) return "auth";
  if (status === 403) return "refused";
  if (status === 429) return RATE_LIMIT_KIND;
  return kind;
}

const INCOMPLETE_RE = /^(?:stream disconnected before completion: )?Incomplete response returned, reason: ([a-z_]{1,64})$/;
const EXEC_CONTEXT_WINDOW_PREFIX = "Codex ran out of room in the model's context window.";

/** The reason of Codex's ResponseIncompleteError rendering ("max_output_tokens", "content_filter", …), else null. */
export function codexIncompleteResponseReason(message: unknown): string | null {
  return typeof message === "string" ? INCOMPLETE_RE.exec(message.trim())?.[1] ?? null : null;
}

function incompleteFailure(reason: string, message: string): RunnerFailure {
  if (reason === "max_output_tokens") return { kind: "exit", message, runtime: "codex", source: "marker", providerCode: CODEX_OUTPUT_LIMIT_CODE };
  if (reason === "content_filter") return { kind: "refused", message, runtime: "codex", source: "marker", providerCode: "codex_content_filter" };
  return { kind: "exit", message, runtime: "codex", source: "marker", providerCode: "codex_response_incomplete" };
}

/**
 * app-server turn error (`turn.error` of turn/completed, or `error.error` of the `error` notification) → RunnerFailure.
 * Pure. The codexErrorInfo decides; the incomplete-response template refines `other` (and an absent code) only.
 */
export function codexTurnErrorFailure(error: { message?: unknown; additionalDetails?: unknown; codexErrorInfo?: unknown } | null | undefined): RunnerFailure {
  const raw = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : "codex turn failed";
  const detail = typeof error?.additionalDetails === "string" && error.additionalDetails.trim() ? ` — ${error.additionalDetails.trim()}` : "";
  const info = readCodexErrorInfo(error?.codexErrorInfo);
  const incomplete = codexIncompleteResponseReason(raw);
  const message = `${raw}${detail}${info?.httpStatus ? ` (HTTP ${info.httpStatus})` : ""}`.slice(0, 2000);
  if (incomplete && (!info || info.name === "other")) return incompleteFailure(incomplete, message);
  if (!info) return { kind: "exit", message, runtime: "codex", source: "marker", providerCode: "codex_turn_failed" };
  const known = Object.prototype.hasOwnProperty.call(CODEX_ERROR_INFO_KINDS, info.name)
    ? CODEX_ERROR_INFO_KINDS[info.name as CodexErrorInfoName] : null;
  return { kind: kindForStatus(known ?? "exit", info.httpStatus), message, runtime: "codex", source: "marker",
    providerCode: codexErrorInfoCode(info.name) };
}

/**
 * `codex exec --json` turn.failed / error item → the two typed causes exec can prove (it carries no codexErrorInfo).
 * Anything else stays the generic exec marker the caller already builds.
 */
export function codexExecTypedFailure(message: unknown): RunnerFailure | null {
  if (typeof message !== "string") return null;
  const text = message.trim().slice(0, 2000);
  const incomplete = codexIncompleteResponseReason(text);
  if (incomplete) return incompleteFailure(incomplete, text);
  if (text.startsWith(EXEC_CONTEXT_WINDOW_PREFIX)) {
    return { kind: "refused", message: text, runtime: "codex", source: "marker", providerCode: CODEX_CONTEXT_WINDOW_CODE };
  }
  return null;
}

/**
 * The app-server answered turn/start with a JSON-RPC error: no turn began (nothing was dispatched). The refusal's own
 * codexErrorInfo (data.codexErrorInfo) decides the kind and code; without one it is `codex_turn_start_refused`,
 * "unavailable" (nothing ran, so the caller may run it again or elsewhere). Never a downgrade to exec (audit A1 C2.2).
 */
export function codexTurnStartRefusalFailure(refusal: { code?: unknown; message?: unknown; data?: unknown }): RunnerFailure {
  const data = refusal.data && typeof refusal.data === "object" ? refusal.data as { codexErrorInfo?: unknown } : null;
  const message = `${typeof refusal.message === "string" && refusal.message.trim() ? refusal.message.trim() : "turn/start refused"}`
    + `${Number.isInteger(refusal.code) ? ` (JSON-RPC ${refusal.code})` : ""}`;
  if (data?.codexErrorInfo != null && readCodexErrorInfo(data.codexErrorInfo)) {
    return codexTurnErrorFailure({ message, codexErrorInfo: data.codexErrorInfo });
  }
  return { kind: "unavailable", message: message.slice(0, 2000), runtime: "codex", source: "marker", providerCode: "codex_turn_start_refused" };
}

/** A refusal because another non-steerable turn (review, compact) holds the thread: worth one bounded retry. */
export function codexTurnStartRefusalIsBusy(refusal: { data?: unknown }): boolean {
  const data = refusal.data && typeof refusal.data === "object" ? refusal.data as { codexErrorInfo?: unknown } : null;
  return readCodexErrorInfo(data?.codexErrorInfo)?.name === "activeTurnNotSteerable";
}

export function isCodexOutputLimitFailure(failure: RunnerFailure | null | undefined): boolean {
  return failure?.providerCode === CODEX_OUTPUT_LIMIT_CODE;
}
export function isCodexContextOverflowFailure(failure: RunnerFailure | null | undefined): boolean {
  return failure?.providerCode === CODEX_CONTEXT_WINDOW_CODE;
}

/**
 * Why a Codex turn ran on `codex exec` although the app-server path was eligible (plan R-070). A typed receipt
 * (status line + model-call ledger `transportFallback`), so the downgrade (no live approvals, no steering) is never
 * silent and a refusal it follows stays visible.
 */
export type CodexExecFallbackReason =
  | "app_server_start_failed"        // spawn/initialize of the app-server failed before any thread
  | "app_server_pre_dispatch_failed" // thread start/resume/bind failed before turn/start was sent
  | "resume_refused";                // thread/resume refused (writer busy, lost rollout): a fresh exec session

export interface CodexExecFallback {
  reason: CodexExecFallbackReason;
  /** JSON-RPC error code of the refusal, when there was one. */
  rpcCode?: number;
  /** A typed sub-reason (the resume refusal class, the refusal's codexErrorInfo code). */
  detail?: string;
}

const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** The receipt line. Machine values only. */
export function codexExecFallbackStatus(fallback: CodexExecFallback): string {
  const detail = fallback.detail && DETAIL_RE.test(fallback.detail) ? ` detail=${fallback.detail}` : "";
  const rpc = Number.isInteger(fallback.rpcCode) ? ` rpc=${fallback.rpcCode}` : "";
  return `[runtime-fallback] kind=codex from=app-server to=exec reason=${fallback.reason}${rpc}${detail}`;
}

/** The ledger value: `reason` or `reason:detail`. */
export function codexExecFallbackLedgerValue(fallback: CodexExecFallback): string {
  return fallback.detail && DETAIL_RE.test(fallback.detail) ? `${fallback.reason}:${fallback.detail}` : fallback.reason;
}
