/*
 * Desktop first-run paywall — the rules that do not need a screen.
 *
 * Owner the Desktop onboarding shows a paywall right after sign-in, the same shape as the
 * phone's (docs: output/one-finance-handoff-20261102/DESIGN-REVIEW-20261103.md 2-5): Pro is preselected
 * and marked, "Continue with Free" is always there and the same size, a trial is named only when the
 * server says this account can have it, and nothing looks paid until the server says so.
 *
 * Everything here is pure so Main, the renderer and the tests read one rule:
 *   - what the server's plan answer means (paid / free / cannot tell),
 *   - what the server's trial answer means (a real offer, or no trial wording at all),
 *   - the once-per-account record,
 *   - the bounded, cancellable wait for the server to confirm a subscription after the browser checkout.
 */

/** A 7-day style trial the server says this very account can start. Never inferred on the client. */
export interface PaywallTrialOffer {
  days: number;
  requiresPaymentMethod: boolean;
}

const TRIAL_DAYS_MAX = 90;

/**
 * `/api/billing/config` → `automaticPromotion`. The field is absent for a request the server cannot
 * attribute to an account, `null` when there is no trial, and an object when this account can start one.
 * Anything else — an older web without the field, a changed shape, a nonsense length — means "say
 * nothing about a trial", never a guessed one.
 */
export function parseAutomaticPromotion(raw: unknown): PaywallTrialOffer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.provider !== "paddle") return null;
  const days = value.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > TRIAL_DAYS_MAX) return null;
  if (typeof value.requiresPaymentMethod !== "boolean") return null;
  return { days, requiresPaymentMethod: value.requiresPaymentMethod };
}

/** What Main hands the renderer under `trial` (already parsed). The renderer re-checks it with the same rule. */
export function readTrialField(raw: unknown): PaywallTrialOffer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const days = value.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > TRIAL_DAYS_MAX) return null;
  if (typeof value.requiresPaymentMethod !== "boolean") return null;
  return { days, requiresPaymentMethod: value.requiresPaymentMethod };
}

export type AccountPlanState =
  | { kind: "paid"; plan: string }
  | { kind: "free" }
  | { kind: "signed-out" }
  | { kind: "unknown" };

/**
 * The server's own answer to "which plan is this account on" (`billing.getCredits`). Only a clean,
 * authenticated answer is believed. A failed read is `unknown` — never "free" (the web design review:
 * "if the account check fails, do not conclude Free") and never "paid".
 */
export function classifyAccountPlan(balance: unknown): AccountPlanState {
  if (!balance || typeof balance !== "object") return { kind: "unknown" };
  const value = balance as Record<string, unknown>;
  if (value.authenticated === false) return { kind: "signed-out" };
  if (value.authenticated !== true) return { kind: "unknown" };
  if (typeof value.error === "string" && value.error) return { kind: "unknown" };
  const plan = typeof value.plan === "string" ? value.plan.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(plan)) return { kind: "unknown" };
  return plan === "free" ? { kind: "free" } : { kind: "paid", plan };
}

/* ── once per account ───────────────────────────── */

export const PAYWALL_RECORD_SCHEMA = 1 as const;
const KEY_PREFIX = "agentlas.desktop.firstRunPaywall.v1";

/**
 * free        = the person chose Free (button, close, Escape)
 * subscribed  = the server confirmed a subscription started from this screen
 * already-paid = the server said the account was already on a paid plan, so the screen was skipped
 */
export type PaywallOutcome = "free" | "subscribed" | "already-paid";

export interface PaywallRecord {
  schema: typeof PAYWALL_RECORD_SCHEMA;
  outcome: PaywallOutcome;
  at: string;
}

export function paywallStorageKey(accountFingerprint: string | undefined): string {
  const scope = accountFingerprint && /^[A-Za-z0-9_-]{4,128}$/.test(accountFingerprint) ? accountFingerprint : "anonymous";
  return `${KEY_PREFIX}:${scope}`;
}

export function parsePaywallRecord(raw: string | null): PaywallRecord | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== PAYWALL_RECORD_SCHEMA) return null;
  if (record.outcome !== "free" && record.outcome !== "subscribed" && record.outcome !== "already-paid") return null;
  if (typeof record.at !== "string") return null;
  return { schema: PAYWALL_RECORD_SCHEMA, outcome: record.outcome, at: record.at };
}

export function readPaywallRecord(storage: Pick<Storage, "getItem">, accountFingerprint: string | undefined): PaywallRecord | null {
  try { return parsePaywallRecord(storage.getItem(paywallStorageKey(accountFingerprint))); } catch { return null; }
}

export function writePaywallRecord(
  storage: Pick<Storage, "setItem">,
  accountFingerprint: string | undefined,
  outcome: PaywallOutcome,
  now = new Date(),
): boolean {
  const record: PaywallRecord = { schema: PAYWALL_RECORD_SCHEMA, outcome, at: now.toISOString() };
  try { storage.setItem(paywallStorageKey(accountFingerprint), JSON.stringify(record)); return true; } catch { return false; }
}

/* ── waiting for the server to confirm ───────────────────────────── */

export const CHECKOUT_POLL_INTERVAL_MS = 3_000;
export const CHECKOUT_POLL_MAX_MS = 5 * 60_000;

export type CheckoutPollResult =
  | { kind: "paid"; plan: string }
  | { kind: "timeout"; unreachable: boolean }
  | { kind: "cancelled" };

export interface CheckoutPollDeps {
  /** A fresh server read of the account's plan. A throw counts as "cannot tell". */
  read: () => Promise<AccountPlanState>;
  /** Resolves after `ms`, or immediately when the signal aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
  intervalMs?: number;
  maxMs?: number;
}

/**
 * After the browser checkout opens, ask the server until it says the account is on a paid plan.
 * Bounded (the cap) and cancellable (the signal); the first read is immediate so a person who comes back
 * and presses "check now" gets an answer, not a wait. Only a server answer of `paid` ends it as success.
 */
export async function pollForSubscription(deps: CheckoutPollDeps): Promise<CheckoutPollResult> {
  const interval = deps.intervalMs ?? CHECKOUT_POLL_INTERVAL_MS;
  const max = deps.maxMs ?? CHECKOUT_POLL_MAX_MS;
  const start = deps.now();
  let unreachable = false;
  for (;;) {
    if (deps.signal.aborted) return { kind: "cancelled" };
    let state: AccountPlanState;
    try { state = await deps.read(); } catch { state = { kind: "unknown" }; }
    if (deps.signal.aborted) return { kind: "cancelled" };
    if (state.kind === "paid") return { kind: "paid", plan: state.plan };
    unreachable = state.kind === "unknown";
    if (deps.now() - start + interval > max) return { kind: "timeout", unreachable };
    await deps.wait(interval, deps.signal);
  }
}
