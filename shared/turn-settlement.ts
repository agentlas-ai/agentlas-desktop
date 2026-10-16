/**
 * Turn settlement (docs/2026-10-13-native-harness/31 W1; audit A7 §6): one typed answer to "what happened to this
 * turn". Pure, with no Electron, Node or renderer imports, so Main, the daemon and the renderer read the same rules.
 *
 * The outward code of a failure is the innermost machine code in its cause chain. A wrapper adds a layer; it never
 * replaces the code, and prose is never classified into one (production 2026-10-14..16: the same daemon start refusal
 * reached the owner as `runtime_turn_unsettled` while Main kept its real code).
 */

/** The same values as runtime/runner.ts RuntimeTurnDelivery. Absent means the runner could not tell. */
export type TurnDelivery = "not-dispatched" | "not-accepted" | "accepted";

const CODE_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
const CODE_MAX = 96;
const CHAIN_LIMIT = 8;

/** A machine code: lower-case identifier, `_` or `-` separated, at most 96 characters. Never prose. */
export function isTypedCode(value: unknown): value is string {
  return typeof value === "string" && value.length <= CODE_MAX && CODE_RE.test(value);
}

/** Read a data property only: a getter, proxy trap or serialization hook is never invoked. */
function dataProperty(value: unknown, name: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    let owner: object | null = value as object;
    for (let depth = 0; owner && depth < 3; depth += 1, owner = Object.getPrototypeOf(owner)) {
      const property = Object.getOwnPropertyDescriptor(owner, name);
      if (property) return Object.hasOwn(property, "value") ? property.value : undefined;
    }
  } catch { /* A revoked proxy supplies no trustworthy field. */ }
  return undefined;
}

/**
 * The machine codes of a failure's cause chain, outermost first. Each level contributes its own `code`, then the
 * `providerCode` of the typed failure it is or carries (`failure`), then its standard `cause` (or the `error` of a
 * `{ error, … }` cause record) is the next level. Data properties only; messages are never read.
 */
export function typedCodeChain(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < CHAIN_LIMIT && current && (typeof current === "object" || typeof current === "function"); depth += 1) {
    if (seen.has(current as object)) break;
    seen.add(current as object);
    const push = (value: unknown): void => { if (isTypedCode(value) && codes[codes.length - 1] !== value) codes.push(value); };
    push(dataProperty(current, "code"));
    push(dataProperty(current, "providerCode"));
    push(dataProperty(dataProperty(current, "failure"), "providerCode"));
    const cause = dataProperty(current, "cause");
    current = cause !== undefined ? cause : dataProperty(current, "error");
  }
  return codes;
}

/** The innermost machine code of a failure's cause chain (typedCodeChain), or undefined when it carries none. */
export function innermostTypedCode(error: unknown): string | undefined {
  const chain = typedCodeChain(error);
  return chain[chain.length - 1];
}

/** The same values as runtime/runner.ts RunnerFailureKind. */
export type TurnFailureKind = "quota" | "rate_limit" | "auth" | "refused" | "empty" | "exit" | "timeout" | "unavailable" | "unsupported";

/**
 * Delivery as the decider sees it: a RuntimeTurnDelivery, or "rejected" when the provider answered the request with a
 * closed refusal (HTTP 401/403/429 before any output). A rejected request did no model work, like "not-dispatched".
 */
export type TurnDeliveryFact = TurnDelivery | "rejected";

export interface TurnSettlementInput {
  /** "unsettled": dispatched, ended without its terminal receipt and without a typed cause. "cancelled": stopped. */
  outcome: "failed" | "unsettled" | "cancelled";
  /** Omitted when the runner could not tell. */
  delivery?: TurnDeliveryFact;
  kind?: TurnFailureKind;
  providerCode?: string;
  /** The provider's Retry-After, in ms from now (rate_limit). */
  retryAfterMs?: number;
  /** No owner is watching this turn (graph step, automation, background, judgment): a longer bounded wait is acceptable. */
  unattended: boolean;
  /** Retries of this same request this decider already spent (0 on the first failure). */
  attempt: number;
  /** Continuations or resends this request may still use. */
  resumeBudget: number;
  /** A session or journal handle resumes the same conversation. */
  resumable?: boolean;
  /** The runtime holds an idempotency receipt for this turn (an echoed client message id): a resend is deduplicated. */
  idempotencyReceipt?: boolean;
  /** The request could not act: no tool was offered (judgment, curator, the no-tools lane). Running it again duplicates
   *  nothing, which is the same guarantee an idempotency receipt gives. */
  effectFree?: boolean;
  /** Provider output or tool activity was observed in this attempt. */
  effectsObserved?: boolean;
  /** The caller has another eligible candidate (role pool, judgment pool, graph worker pool). */
  fallbackAvailable?: boolean;
}

export type TurnSettlementReason =
  | "owner_stopped" | "replay_blocked" | "rate_limited" | "rate_limit_exhausted" | "no_model_work"
  | "accepted_continue" | "unacknowledged_resend" | "not_resumable" | "continuation_budget_exhausted"
  | "accepted_no_idempotency" | "effects_observed" | "provider_capability" | "no_fallback";

export type TurnSettlementDecision =
  /** Run the same request on the same runtime again after `delayMs`. Only for work that provably did not run. */
  | { action: "retry"; delayMs: number; reason: TurnSettlementReason }
  /** One host-authored turn into the same session; `resendOriginal` carries the request when the session may lack it. */
  | { action: "continue-same-session"; resendOriginal: boolean; reason: TurnSettlementReason }
  /** A new session with the original request: only when the runtime would deduplicate an already placed turn. */
  | { action: "fresh-session"; resendOriginal: true; reason: TurnSettlementReason }
  /** Hand the request to the caller's next candidate (another runtime or model). */
  | { action: "recover"; reason: TurnSettlementReason }
  /** Stop and report this failure with its own code. */
  | { action: "surface"; reason: TurnSettlementReason };

/** At most this many same-runtime retries for request throttling. */
export const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 2_000;
/** Longest wait before a retry: an owner is not kept waiting more than a minute; unattended work may wait 15 minutes. */
const RATE_LIMIT_MAX_WAIT_MS = { attended: 60_000, unattended: 15 * 60_000 } as const;
/** Codes whose turn must never be replayed by anyone (the host already knows it may have acted or is looping). */
const REPLAY_BLOCKING_CODES: ReadonlySet<string> = new Set(["runtime_turn_unsettled", "serving_reconciliation_required", "automation_no_progress_loop"]);

/**
 * The single retry / continue / fresh-session / recover / surface decision for a turn that did not complete, from typed
 * facts only (docs 31 W1; audit A7 §6.2 rule 3 counted about eleven deciders with conflicting rules). Callers execute
 * the decision; they do not re-derive it. Invariants:
 *  - work whose delivery was "accepted" is never re-run (retry, resend, recover) unless the runtime holds an
 *    idempotency receipt for that turn; an accepted unsettled turn only continues in its own session without its request;
 *  - a retry happens only for request throttling that did no work (not dispatched, a closed provider rejection, or the
 *    provider's own throttling refusal before any output), at most RATE_LIMIT_MAX_RETRIES times, waiting at least the
 *    provider's Retry-After;
 *  - prose is never an input.
 */
export function decideTurnSettlement(input: TurnSettlementInput): TurnSettlementDecision {
  if (input.outcome === "cancelled") return { action: "surface", reason: "owner_stopped" };
  const idempotent = input.idempotencyReceipt === true || input.effectFree === true;
  if (input.providerCode && REPLAY_BLOCKING_CODES.has(input.providerCode)) return { action: "surface", reason: "replay_blocked" };
  const noModelWork = input.delivery === "not-dispatched" || input.delivery === "rejected";
  if (input.outcome === "unsettled") {
    // An unsettled turn was dispatched by definition; a "not dispatched" label on it is a contradiction, never a reason to resend.
    if (noModelWork) return { action: "surface", reason: "no_model_work" };
    if (input.resumeBudget <= 0) return { action: "surface", reason: "continuation_budget_exhausted" };
    if (input.resumable) {
      return input.delivery === "accepted"
        ? { action: "continue-same-session", resendOriginal: false, reason: "accepted_continue" }
        : { action: "continue-same-session", resendOriginal: true, reason: "unacknowledged_resend" };
    }
    return idempotent
      ? { action: "fresh-session", resendOriginal: true, reason: "unacknowledged_resend" }
      : { action: "surface", reason: input.delivery === "accepted" ? "accepted_no_idempotency" : "not_resumable" };
  }
  // A typed failure. Output or tool activity after dispatch means the work may have acted: never replayed elsewhere.
  if (!noModelWork && input.effectsObserved && input.effectFree !== true) return { action: "surface", reason: "effects_observed" };
  const accepted = input.delivery === "accepted";
  if (input.kind === "rate_limit" && (noModelWork || !accepted || idempotent) && (!input.effectsObserved || input.effectFree === true)) {
    const cap = input.unattended ? RATE_LIMIT_MAX_WAIT_MS.unattended : RATE_LIMIT_MAX_WAIT_MS.attended;
    const backoff = RATE_LIMIT_BASE_MS * 2 ** Math.max(0, Math.min(10, input.attempt));
    const wait = Math.max(backoff, Number.isFinite(input.retryAfterMs) ? Math.max(0, input.retryAfterMs as number) : 0);
    if (input.attempt < RATE_LIMIT_MAX_RETRIES && wait <= cap) return { action: "retry", delayMs: Math.min(wait, cap), reason: "rate_limited" };
    return input.fallbackAvailable ? { action: "recover", reason: "rate_limit_exhausted" } : { action: "surface", reason: "rate_limit_exhausted" };
  }
  // The session holds this turn: running it anywhere again could repeat what it did.
  if (accepted && !idempotent) return { action: "surface", reason: "accepted_no_idempotency" };
  if (!input.fallbackAvailable) return { action: "surface", reason: "no_fallback" };
  return { action: "recover", reason: noModelWork ? "no_model_work" : "provider_capability" };
}

/** A retry hint (ISO time) as milliseconds from `now`; undefined when absent or already past. */
export function retryAfterMs(hintIso: string | null | undefined, now = Date.now()): number | undefined {
  const at = typeof hintIso === "string" ? Date.parse(hintIso) : NaN;
  return Number.isFinite(at) && at > now ? at - now : undefined;
}
