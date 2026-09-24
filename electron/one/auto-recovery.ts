// One's automatic recovery judgment. The closed-form half (run status, tool
// authority, attempt counters) lives in shared/one-auto-recovery.ts. This file
// owns the part that is meaning, not form: what a failure actually was, and
// whether One may go around it on its own.
//
// Deliberately no keyword table decides anything here. Failure wordings are
// unbounded — they come from every runtime, every tool, every provider, in any
// language — and this codebase already paid for keyword classification once:
// a labelled fallback hid a disconnected judge for weeks. Old wordlists are
// passed to the judge as `hints` (reference, never rules). When no model is
// reachable, or the judge asks for a person without naming a boundary, host
// facts decide (2026-09-24): only read-only runs get this far (form gate), so
// another bounded attempt cannot act twice. A person is involved only for a
// named boundary — payment, credential, security consent, or purpose.
import { judgeRequired } from "../system-agents/judgment";
import {
  ONE_AUTO_RECOVERY_MAX_ATTEMPTS,
  ONE_RECOVERY_LABELS,
  ONE_RECOVERY_OUTCOME_LABELS,
  oneRecoveryHostFactDecision,
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
import { automationRunToolCounts } from "../automation-progress-facts";

/** Host receipts: tool calls of this run that could have acted outside. Null when the ledger is unreadable. */
export interface OneRecoveryHostFacts {
  actingCalls: number;
}

function readHostFacts(runId: string): OneRecoveryHostFacts | null {
  try {
    return { actingCalls: automationRunToolCounts(runId).actionCalls };
  } catch {
    return null;
  }
}

export interface OneAutoRecoveryInput {
  receipt: InvocationRunReceipt;
  /** What the person originally asked for, so the judge can weigh "worth another route". */
  goal: string;
  attemptsSpent: number;
  previousFingerprint?: OneRunFailureFingerprint | null;
  locale?: RuntimeLocale;
  signal?: AbortSignal;
  /** Injected by contracts; Main reads the run's own host receipts. */
  hostFacts?: OneRecoveryHostFacts | null;
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
  hostFacts?: OneRecoveryHostFacts | null;
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
  "Choose a needs_person_* label only when the evidence proves the very next necessary action is one of these boundaries, and name it: needs_person_payment (a payment or checkout), needs_person_credential (a sign-in or secret only the person has), needs_person_security_consent (granting a permission, an OS privilege, or installing something), needs_person_purpose (changing what the person asked for). Anything else — a tool error, a missing page, a slow site, an unclear next step — is not a reason to hand the run back.",
  "",
  "Choose unsafe_to_repeat when the failed run may already have caused an effect outside the app that repeating would duplicate — something sent, posted, published, paid, transferred, or deleted — including when a request was issued and only its confirmation was lost. Prefer this whenever an outward action's completion is genuinely uncertain; a duplicate send is worse than asking.",
  "",
  "Choose will_not_succeed when the same request fails the same way by nature: refused by policy, blocked by a security boundary, or exceeding a hard model/input limit. Retrying spends time without changing anything; the request itself has to change.",
  "",
  "Judge the evidence given, not what you imagine happened. This run held read-only authority, so another attempt cannot duplicate an outside effect. If the evidence does not let you tell these apart, prefer retry_different_approach.",
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
    `Host-recorded tool calls that could have acted outside the app: ${input.hostFacts ? input.hostFacts.actingCalls : "(not measured)"}`,
    `Automatic attempts already spent on this goal: ${input.attemptsSpent}`,
  ].join("\n");
}

export async function judgeOneAutoRecovery(
  input: OneAutoRecoveryInput,
): Promise<OneAutoRecoveryResult> {
  const fingerprint = oneRunFailureFingerprint(input.receipt);
  if (input.receipt.interruptionCause === "steering") {
    return {
      decision: { retry: false, reason: "settled" },
      fingerprint,
      diagnosis: "",
      decidedBy: "form",
    };
  }
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
  const hostFacts = input.hostFacts !== undefined ? input.hostFacts : readHostFacts(input.receipt.runId);
  input = { ...input, hostFacts };
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

  /*
   * No semantic verdict, or a "needs a person" that names no boundary: host facts decide (P0-6, owner
   * 2026-09-24 — a person only at a true boundary). This used to stop and hand every judge outage to the
   * person. The run was read-only (form gate), so another attempt cannot act twice; the attempt budget
   * still bounds it. Only an unreadable ledger leaves the decision undecided.
   */
  const label = verdict.verdict as string | null;
  if (label === null || label === "needs_person") {
    if (!hostFacts) {
      return {
        decision: { retry: false, reason: "undecided" },
        fingerprint,
        diagnosis: "",
        decidedBy: "unavailable",
      };
    }
    const hostDecision = oneRecoveryHostFactDecision({ actingCalls: hostFacts.actingCalls, attemptsSpent: input.attemptsSpent });
    return {
      decision: hostDecision.decision,
      fingerprint,
      diagnosis: hostDecision.approach === "observe_first"
        ? "Check what actually happened first, without changing anything, then continue from what is still missing."
        : label === null ? "" : verdict.reason,
      decidedBy: "form",
    };
  }
  return {
    decision: oneAutoRecoveryFromLabel(verdict.verdict!, input.attemptsSpent),
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
      "Choose a needs_person_* label only when the next step needs the person for exactly that boundary: needs_person_payment, needs_person_credential (a sign-in or secret only they have), needs_person_security_consent (a permission or installation), needs_person_purpose (changing the request itself).",
      "Choose will_not_succeed when the request cannot succeed without changing the request itself.",
      "The reason is a maximum of two short customer-facing sentences. Do not expose runtimes, receipts, error codes, paths, or internal components.",
      "If evidence is insufficient, choose retry_different_approach while a safe read-only route remains. Never infer success from the completed process status alone.",
    ].join(" "),
    scanSecrets: true,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const outcomeLabel = verdict.verdict as string | null;
  if (outcomeLabel === null || outcomeLabel === "needs_person") {
    // No verdict, or no named boundary: never claim success, and never hand back without a boundary —
    // try another read-only route while the budget lasts (the same host-fact rule as above).
    const hostFacts = input.hostFacts !== undefined ? input.hostFacts : readHostFacts(input.recoveryReceipt.runId);
    const hostDecision = oneRecoveryHostFactDecision({ actingCalls: hostFacts?.actingCalls ?? 0,
      attemptsSpent: input.attemptsSpent, maxAttempts: ONE_AUTO_RECOVERY_MAX_ATTEMPTS });
    return {
      decision: hostDecision.decision.retry
        ? { verified: false, retry: true, attempt: hostDecision.decision.attempt }
        : { verified: false, retry: false, reason: hostDecision.decision.reason },
      diagnosis: outcomeLabel === null ? "" : verdict.reason,
      decidedBy: "unavailable",
    };
  }
  return {
    decision: oneRecoveryOutcomeFromLabel(verdict.verdict!, input.attemptsSpent),
    diagnosis: verdict.reason,
    decidedBy: verdict.source,
  };
}
