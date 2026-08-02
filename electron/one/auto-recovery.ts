// One's automatic recovery judgment. The closed-form half (run status, tool
// authority, attempt counters) lives in shared/one-auto-recovery.ts. This file
// owns the part that is meaning, not form: what a failure actually was, and
// whether One may go around it on its own.
//
// Deliberately no keyword table decides anything here. Failure wordings are
// unbounded — they come from every runtime, every tool, every provider, in any
// language — and this codebase already paid for keyword classification once:
// a labelled fallback hid a disconnected judge for weeks. Old wordlists are
// passed to the judge as `hints` (reference, never rules), and when no model is
// reachable the verdict remains unavailable so a run that might have
// already acted is never silently repeated.
import { judgeRequired } from "../system-agents/judgment";
import {
  ONE_RECOVERY_LABELS,
  ONE_RECOVERY_OUTCOME_LABELS,
  oneAutoRecoveryFormGate,
  oneAutoRecoveryFromLabel,
  oneRecoveryOutcomeFromLabel,
  oneRunFailureFingerprint,
  type OneAutoRecoveryDecision,
  type OneRecoveryLabel,
  type OneRecoveryOutcomeLabel,
  type OneRecoveryOutcomeDecision,
  type OneRunFailureFingerprint,
} from "../../shared/one-auto-recovery";
import type { InvocationRunReceipt } from "../../shared/types";
import type { RuntimeLocale } from "../runtime/status-i18n";

export interface OneAutoRecoveryInput {
  receipt: InvocationRunReceipt;
  /** What the person originally asked for, so the judge can weigh "worth another route". */
  goal: string;
  attemptsSpent: number;
  previousFingerprint?: OneRunFailureFingerprint | null;
  locale?: RuntimeLocale;
  signal?: AbortSignal;
}

export interface OneAutoRecoveryResult {
  decision: OneAutoRecoveryDecision;
  fingerprint: OneRunFailureFingerprint;
  /** Plain-language account of what blocked the run, for the next attempt and for the user. */
  diagnosis: string;
  decidedBy: "form" | "llm" | "unavailable";
}

export interface OneRecoveryOutcomeInput {
  originalReceipt: InvocationRunReceipt;
  recoveryReceipt: InvocationRunReceipt;
  goal: string;
  resultText: string;
  attemptsSpent: number;
  locale?: RuntimeLocale;
  signal?: AbortSignal;
}

export interface OneRecoveryOutcomeResult {
  decision: OneRecoveryOutcomeDecision;
  diagnosis: string;
  decidedBy: "llm" | "unavailable";
}

const GUIDANCE = [
  "You are deciding whether an assistant may retry a task by itself, or must hand it back to the person.",
  "",
  "Choose retry_different_approach when the wall is something a different route could get past: a tool erred, a page or file would not load, a step timed out, one path was blocked but others exist. This is the default for ordinary execution failures — the assistant is expected to find another way rather than report the obstacle.",
  "",
  "Choose needs_person only when the evidence proves that the next necessary action is outside the granted authority or requires a human decision.",
  "",
  "Choose unsafe_to_repeat when the failed run may already have caused an effect outside the app that repeating would duplicate — something sent, posted, published, paid, transferred, or deleted — including when a request was issued and only its confirmation was lost. Prefer this whenever an outward action's completion is genuinely uncertain; a duplicate send is worse than asking.",
  "",
  "Choose will_not_succeed when the same request fails the same way by nature: refused by policy, blocked by a security boundary, or exceeding a hard model/input limit. Retrying spends time without changing anything; the request itself has to change.",
  "",
  "Judge the evidence given, not what you imagine happened. If the evidence does not let you tell these apart, prefer needs_person.",
].join("\n");

function evidence(input: OneAutoRecoveryInput): string {
  const { receipt } = input;
  return [
    `What the person asked for: ${input.goal || "(not recorded)"}`,
    `Run outcome: ${receipt.status}`,
    `Failure code: ${receipt.errorCode ?? "(none recorded)"}`,
    `Failure message: ${receipt.errorMessage ?? "(none recorded)"}`,
    `Tool authority this run held: ${receipt.executionPermission ?? "(not recorded)"}`,
    `Steps recorded before it stopped: ${receipt.eventCount}`,
    `Automatic attempts already spent on this goal: ${input.attemptsSpent}`,
  ].join("\n");
}

export async function judgeOneAutoRecovery(
  input: OneAutoRecoveryInput,
): Promise<OneAutoRecoveryResult> {
  const fingerprint = oneRunFailureFingerprint(input.receipt);
  const gated = oneAutoRecoveryFormGate({
    receipt: input.receipt,
    attemptsSpent: input.attemptsSpent,
    previousFingerprint: input.previousFingerprint,
    currentFingerprint: fingerprint,
  });
  if (gated) {
    const presentation = await judgeRequired<"present">({
      kind: "one-run-recovery-presentation",
      question: "Write the one short thing the person needs to know or answer now, without exposing the failure machinery.",
      labels: ["present"] as const,
      input: evidence(input),
      guidance: [
        "The verdict must be present.",
        "The reason is the customer-facing line, maximum two short sentences.",
        "Do not mention error codes, runtimes, databases, receipts, attempts, stack traces, paths, or internal component names.",
        "If the person stopped the run, simply acknowledge that. If repeating could duplicate an external action, ask them to confirm the outside result before continuing.",
      ].join(" "),
      scanSecrets: true,
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      decision: gated,
      fingerprint,
      diagnosis: presentation.verdict ? presentation.reason : "",
      decidedBy: presentation.verdict ? "llm" : "unavailable",
    };
  }

  // The form gate has already rejected write-capable or unknown-authority runs.
  // Only explicitly read-only failures reach this meaning judgment.
  const verdict = await judgeRequired<OneRecoveryLabel>({
    kind: "one-run-recovery",
    question:
      "An assistant's run did not finish. May the assistant retry it by itself with a different approach, or must it stop and involve the person?",
    labels: ONE_RECOVERY_LABELS,
    input: evidence(input),
    guidance: GUIDANCE,
    scanSecrets: true,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (verdict.verdict === null) {
    return {
      decision: { retry: false, reason: "undecided" },
      fingerprint,
      diagnosis: "",
      decidedBy: "unavailable",
    };
  }
  return {
    decision: oneAutoRecoveryFromLabel(verdict.verdict, input.attemptsSpent),
    fingerprint,
    diagnosis: verdict.reason,
    decidedBy: verdict.source,
  };
}

/**
 * A process exit is not outcome proof. After an automatic retry reaches a
 * completed receipt, One asks the resident judge whether the original request
 * is actually satisfied. No keyword, default success, or canned failure copy
 * participates in this decision.
 */
export async function judgeOneRecoveryOutcome(
  input: OneRecoveryOutcomeInput,
): Promise<OneRecoveryOutcomeResult> {
  if (
    !["failed", "interrupted"].includes(input.originalReceipt.status)
    || input.recoveryReceipt.status !== "completed"
    || input.originalReceipt.chatId !== input.recoveryReceipt.chatId
    || !input.resultText.trim()
  ) {
    return {
      decision: { verified: false, retry: false, reason: "undecided" },
      diagnosis: "",
      decidedBy: "unavailable",
    };
  }

  const verdict = await judgeRequired<OneRecoveryOutcomeLabel>({
    kind: "one-run-recovery-outcome",
    question:
      "An automatic recovery run completed. Does its result actually satisfy the person's original request?",
    labels: ONE_RECOVERY_OUTCOME_LABELS,
    input: [
      `Original request: ${input.goal || "(not recorded)"}`,
      `Original run outcome: ${input.originalReceipt.status}`,
      `Recovery run outcome: ${input.recoveryReceipt.status}`,
      `Recovery attempts spent: ${input.attemptsSpent}`,
      "Recovery result:",
      input.resultText.slice(0, 12_000),
    ].join("\n"),
    guidance: [
      "Choose verified_original_outcome only when the recovery result contains concrete evidence that the original request was fulfilled.",
      "Choose retry_different_approach when the result is incomplete but another safe read-only route could still finish it.",
      "Choose needs_person only when a person must supply authority, information, or a decision.",
      "Choose will_not_succeed when the request cannot succeed without changing the request itself.",
      "The reason is a maximum of two short customer-facing sentences. Do not expose runtimes, receipts, error codes, paths, or internal components.",
      "If evidence is insufficient, choose needs_person. Never infer success from the completed process status alone.",
    ].join(" "),
    scanSecrets: true,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (verdict.verdict === null) {
    return {
      decision: { verified: false, retry: false, reason: "undecided" },
      diagnosis: "",
      decidedBy: "unavailable",
    };
  }
  return {
    decision: oneRecoveryOutcomeFromLabel(verdict.verdict, input.attemptsSpent),
    diagnosis: verdict.reason,
    decidedBy: verdict.source,
  };
}
