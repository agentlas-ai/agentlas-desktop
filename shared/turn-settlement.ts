/**






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

/**
 * A local SQLite store refused a read or write because another connection held its lock ("database is locked"): the
 * typed code of SQLITE_BUSY, SQLITE_LOCKED, their extended codes (SQLITE_BUSY_SNAPSHOT, which busy_timeout never waits
 * on) and SQLITE_PROTOCOL. Transient, and never a runtime's fault.
 */
export const STORE_BUSY_CODE = "store_busy";
const SQLITE_STORE_BUSY_RE = /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z]+)?$|^SQLITE_PROTOCOL$/;

/** The driver's own result code (better-sqlite3 SqliteError `code`) as its typed code: store_busy, else unchanged. */
function typedDriverCode(value: unknown): unknown {
  return typeof value === "string" && SQLITE_STORE_BUSY_RE.test(value) ? STORE_BUSY_CODE : value;
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
 * `{ error, … }` cause record) is the next level. Data properties only; messages are never read. A SQLite lock result
 * code ("SQLITE_BUSY", …) reads as STORE_BUSY_CODE.
 */
export function typedCodeChain(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < CHAIN_LIMIT && current && (typeof current === "object" || typeof current === "function"); depth += 1) {
    if (seen.has(current as object)) break;
    seen.add(current as object);
    const push = (raw: unknown): void => {
      const value = typedDriverCode(raw);
      if (isTypedCode(value) && codes[codes.length - 1] !== value) codes.push(value);
    };
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
  | "accepted_no_idempotency" | "effects_observed" | "provider_capability" | "no_fallback"
  | "store_busy" | "store_busy_exhausted" | "store_busy_after_dispatch";

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
/** At most this many same-runtime retries for a store lock refused before dispatch (STORE_BUSY_CODE), 250 ms then 500 ms. */
export const STORE_BUSY_MAX_RETRIES = 2;
const STORE_BUSY_BASE_MS = 250;
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
 *    provider's Retry-After, or for a store lock refused before dispatch, at most STORE_BUSY_MAX_RETRIES times;
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
  // The local store refused a read or write (another connection held its lock). Another runtime meets the same store, so
  // it is never a recovery. Before dispatch nothing ran: the same request again after a short bounded wait. After
  // dispatch (or when the runner could not tell) the turn may have acted: surfaced with its own code, never replayed.
  if (input.providerCode === STORE_BUSY_CODE) {
    if (!noModelWork) return { action: "surface", reason: "store_busy_after_dispatch" };
    return input.attempt < STORE_BUSY_MAX_RETRIES
      ? { action: "retry", delayMs: STORE_BUSY_BASE_MS * 2 ** Math.max(0, input.attempt), reason: "store_busy" }
      : { action: "surface", reason: "store_busy_exhausted" };
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

/**
 * A turn the runtime itself ended normally (its own terminal: codex turn/completed status completed, Claude's success
 * result, ACP end_turn, a provider's stop/end_turn, agy SUCCESS), told apart by what it left (plan R-065, docs 31 W1):
 *  - "completed" with a final text;
 *  - "completed" with no final text and at least one tool call: the work happened through its tools (a tool-only turn);
 *  - "empty": no final text and no tool call, a turn that produced nothing at all (a typed "empty" failure).
 * Whether an empty final text is acceptable belongs to the caller that reads it, never to the runner: a typed-output
 * caller (team worker handoff, planner, judgment, structured output, a graph step's result) fails with its own typed
 * reason, while a chat or automation turn whose effect is in its tools is complete. Before this rule each runner had its
 * own "non-empty text" check, so every tool-only turn was reported as failed or unsettled in rooms, graphs and 1:1.
 * Only a normal end reaches this rule: cancellation, output-limit cuts, Kimi's unattested end_turn and missing terminals
 * keep their own outcomes.
 */
export type NormalEndSettlement =
  | { outcome: "completed"; finalText: "present" | "empty"; toolCalls: number }
  | { outcome: "empty" };

/** The one rule for a normally ended turn (R-065). `toolCalls` counts this turn's tool calls only; never prose. */
export function settleNormalEnd(facts: { text: string; toolCalls: number }): NormalEndSettlement {
  const toolCalls = Number.isSafeInteger(facts.toolCalls) && facts.toolCalls > 0 ? facts.toolCalls : 0;
  if (facts.text.trim()) return { outcome: "completed", finalText: "present", toolCalls };
  return toolCalls > 0 ? { outcome: "completed", finalText: "empty", toolCalls } : { outcome: "empty" };
}

/** The `toolCalls` evidence a completed result carries when its final text is empty (RunnerResult.toolCalls). */
export function normalEndToolEvidence(settlement: NormalEndSettlement): { toolCalls?: number } {
  return settlement.outcome === "completed" && settlement.finalText === "empty" ? { toolCalls: settlement.toolCalls } : {};
}

/**
 * Counts the distinct tool calls a runner reports through `onTool` during one turn: the evidence settleNormalEnd reads.
 * A start and its completion share an id and count once; a report without an id counts once per report. Every argument
 * is forwarded unchanged.
 */
export function trackReportedToolCalls<E extends { onTool?: (...args: never[]) => void }>(events: E): { events: E; count: () => number } {
  const ids = new Set<string>();
  let anonymous = 0;
  const onTool = events.onTool as ((...args: unknown[]) => void) | undefined;
  const wrapped = {
    ...events,
    onTool: (...args: unknown[]): void => {
      const id = args[3];
      if (typeof id === "string" && id) ids.add(id); else anonymous += 1;
      onTool?.(...args);
    },
  } as unknown as E;
  return { events: wrapped, count: () => ids.size + anonymous };
}

/** A retry hint (ISO time) as milliseconds from `now`; undefined when absent or already past. */
export function retryAfterMs(hintIso: string | null | undefined, now = Date.now()): number | undefined {
  const at = typeof hintIso === "string" ? Date.parse(hintIso) : NaN;
  return Number.isFinite(at) && at > now ? at - now : undefined;
}
