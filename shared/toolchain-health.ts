// Health of a callable Toolchain: when real uses start failing, it is pulled back and repaired.
//
// Scheme: a Toolchain for an app or page is built on the assumption that the app's or page's structure stays
// the same. Later the structure changes, errors become frequent, and the Toolchain is changed. This file decides, from the
// outcomes of real calls only, when "errors become frequent". Common circuit-breaker practice gives the
// shape: classify failures so that a lost login or a timeout does not trip the breaker, count only what points at the tool,
// and keep the repair bounded.
//
// Pure: nothing here reads a store.

import type { ToolchainCallReceipt } from "./toolchain-asset";

export const TOOLCHAIN_HEALTH_POLICY = Object.freeze({
  /** Counted outcomes (successes and tool-pointing failures) looked at. */
  window: 12,
  /** The tool fails this many times in a row at the end of the window: it is broken, whatever came before. */
  consecutiveFailures: 3,
  /** Or, with at least this many counted outcomes, this share of the window failed. */
  minCounted: 6,
  failureShare: 0.5,
  /** Outcomes kept per version. */
  keep: 24,
  /** Repairs the detector asks for per asset before it stops and retires the asset instead. */
  maxRepairs: 2,
});

export type FailureKind = "environment" | "tool";

/**
 * A failure that says nothing about the tool: the owner is signed out, the network or the runtime is down, the call was
 * cancelled or rate limited. Everything else points at the tool — the page changed, the output no longer fits its contract, the
 * command failed — and unknown errors are counted, because a quiet failure is worse than a repair that was not needed.
 */
const ENVIRONMENT = /(?:log(?:ged)?[ _-]?in|sign(?:ed)?[ _-]?(?:in|out)|auth(?:entication|orization)?|credential|permission|denied|forbidden|unauthori[sz]ed|\b40[13]\b|\b429\b|rate[ _-]?limit|quota|timeout|timed[ _-]?out|network|offline|unreachable|ECONN|ENOTFOUND|EAI_AGAIN|dns|runtime[ _-]?(?:unavailable|not)|no[ _-]?(?:model|runtime)|aborted|cancel|custody_changed|in_progress_or_interrupted|owner[ _-]?(?:input|action))/i;

export function classifyFailure(error: string | null | undefined): FailureKind {
  return error && ENVIRONMENT.test(error) ? "environment" : "tool";
}

export interface HealthOutcome {
  callId: string;
  at: string;
  status: "succeeded" | "failed" | "uncertain";
  error: string | null;
  /** Null for a success. */
  kind: FailureKind | null;
  chatId: string | null;
}

export interface HealthLedger {
  schema: "agentlas.toolchain-health.v1";
  toolchainId: string;
  version: number;
  contentHash: string;
  outcomes: HealthOutcome[];
  updatedAt: string;
}

/** Terminal real-use receipts only; dry runs and validation runs are not use. */
export function healthOutcomeFrom(receipt: Readonly<ToolchainCallReceipt>): HealthOutcome | null {
  if (receipt.status === "running" || receipt.dryRun) return null;
  const failed = receipt.status !== "succeeded";
  return { callId: receipt.id, at: receipt.completedAt ?? receipt.startedAt, status: receipt.status as HealthOutcome["status"],
    error: failed ? (receipt.error ?? receipt.status).slice(0, 300) : null, kind: failed ? classifyFailure(receipt.error ?? receipt.status) : null, chatId: receipt.callerChatId };
}

export interface HealthVerdict {
  state: "healthy" | "degraded";
  reason: "consecutive_failures" | "failure_share" | null;
  counted: number;
  failures: number;
  /** Failures the verdict ignored because they pointed at the environment. */
  ignored: number;
}

/** Uncertain counts as a failure: an effect that cannot be confirmed is not a success. */
export function healthVerdict(outcomes: readonly HealthOutcome[], policy = TOOLCHAIN_HEALTH_POLICY): HealthVerdict {
  const counted = outcomes.filter(outcome => outcome.kind !== "environment").slice(-policy.window);
  const failed = (outcome: HealthOutcome) => outcome.status !== "succeeded";
  const failures = counted.filter(failed).length;
  const ignored = outcomes.length - outcomes.filter(outcome => outcome.kind !== "environment").length;
  let trailing = 0;
  for (let i = counted.length - 1; i >= 0 && failed(counted[i]); i--) trailing++;
  if (trailing >= policy.consecutiveFailures) return { state: "degraded", reason: "consecutive_failures", counted: counted.length, failures, ignored };
  if (counted.length >= policy.minCounted && failures / counted.length >= policy.failureShare) return { state: "degraded", reason: "failure_share", counted: counted.length, failures, ignored };
  return { state: "healthy", reason: null, counted: counted.length, failures, ignored };
}
