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
// reachable the verdict falls back to "needs_person" so a run that might have
// already acted is never silently repeated.
import { judge } from "../system-agents/judgment";
import {
  ONE_RECOVERY_FALLBACK,
  ONE_RECOVERY_LABELS,
  oneAutoRecoveryFormGate,
  oneAutoRecoveryFromLabel,
  oneRunFailureFingerprint,
  type OneAutoRecoveryDecision,
  type OneRecoveryLabel,
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
  decidedBy: "form" | "llm" | "fallback";
}

const GUIDANCE = [
  "You are deciding whether an assistant may retry a task by itself, or must hand it back to the person.",
  "",
  "Choose retry_different_approach when the wall is something a different route could get past: a tool erred, a page or file would not load, a step timed out, one path was blocked but others exist. This is the default for ordinary execution failures — the assistant is expected to find another way rather than report the obstacle.",
  "",
  "Choose needs_person when no retry can change the outcome because a human must act or decide first: signed-out or expired credentials, no model/runtime connected, a pending approval or confirmation, a required choice the assistant is not allowed to make, or an explicit request for user intervention.",
  "",
  "Choose unsafe_to_repeat when the failed run may already have caused an effect outside the app that repeating would duplicate — something sent, posted, published, paid, transferred, or deleted — including when a request was issued and only its confirmation was lost. Prefer this whenever an outward action's completion is genuinely uncertain; a duplicate send is worse than asking.",
  "",
  "Choose will_not_succeed when the same request fails the same way by nature: refused by policy, blocked by a security boundary, or exceeding a hard model/input limit. Retrying spends time without changing anything; the request itself has to change.",
  "",
  "Judge the evidence given, not what you imagine happened. If the evidence does not let you tell these apart, prefer needs_person.",
].join("\n");

/**
 * Old classification wordlists, kept only as reference for the judge.
 * A hint matching is not evidence, and a hint missing is not a pass.
 */
const HINTS: { label: OneRecoveryLabel; words: string[] }[] = [
  {
    label: "retry_different_approach",
    words: ["returned an error", "tool_error", "node_failed", "timed out", "navigation failed", "not found"],
  },
  {
    label: "needs_person",
    words: [
      "requires user intervention",
      "사용자 개입",
      "stopped from the stop button",
      "정지 버튼",
      "signed out",
      "not authenticated",
      "approval",
      "승인",
    ],
  },
  { label: "unsafe_to_repeat", words: ["sent", "posted", "published", "transferred", "전송", "게시", "결제"] },
  {
    label: "will_not_succeed",
    words: ["content policy", "network security blocked", "context length exceeded", "invalid api key"],
  },
];

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
    return {
      decision: gated,
      fingerprint,
      // The renderer already owns a separately scrubbed customer summary. A
      // form-only gate must never send a raw runtime error back as diagnosis.
      diagnosis: "",
      decidedBy: "form",
    };
  }

  // The form gate has already rejected write-capable or unknown-authority runs.
  // Only explicitly read-only failures reach this meaning judgment.
  const verdict = await judge<OneRecoveryLabel>({
    kind: "one-run-recovery",
    question:
      "An assistant's run did not finish. May the assistant retry it by itself with a different approach, or must it stop and involve the person?",
    labels: ONE_RECOVERY_LABELS,
    input: evidence(input),
    hints: HINTS,
    guidance: GUIDANCE,
    fallback: ONE_RECOVERY_FALLBACK,
    scanSecrets: true,
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return {
    decision: oneAutoRecoveryFromLabel(verdict.verdict, input.attemptsSpent),
    fingerprint,
    diagnosis: verdict.reason || input.receipt.errorMessage || "",
    decidedBy: verdict.source,
  };
}
