// Judged One Decision risk + option disposition. The resident model alone makes
// semantic decisions; a missing verdict makes the shared normalizer fail closed.
//
// normalizeOneDecision runs in synchronous code (mobile projection, authority
// validation, a renderer render pass), so the async electron paths that precede it
// warm the judgment cache here and the sync sites peek via oneDecisionJudgedReaders.
// Closed-form fields (SAFE_ID_RE, COST_RE, DEADLINE_RE) stay deterministic.

import {
  ONE_DECISION_AUTHORITY_READINESS_JUDGMENT_KIND,
  ONE_DECISION_DISPOSITION_JUDGMENT_KIND,
  ONE_DECISION_RISK_JUDGMENT_KIND,
  oneDecisionJudgmentTexts,
  type OneDecisionAuthorityReadiness,
  type OneDecisionJudgedReaders,
  type OneDecisionOptionDisposition,
  type OneDecisionRiskLevel,
} from "../../shared/one-decision";
import type { PendingConfirmation } from "../../shared/types";
import { judgeRequired, peekJudgment, runtimeSelectionCacheScope } from "../system-agents/judgment";

const RISK_LABELS = ["R0", "R1", "R2", "R3", "R4"] as const;
const DISPOSITION_LABELS = ["choice", "approve", "reject", "modify"] as const;
const AUTHORITY_READINESS_LABELS = ["ready", "needs_details"] as const;

const RISK_QUESTION =
  "How risky is the action this assistant decision request asks the user to authorize? " +
  "R0 read-only; R1 preparation/draft only; R2 limited reversible change (save, upload, install); " +
  "R3 external effect (send, publish, book, pay, delete); R4 critical/irreversible effect " +
  "(legal filing, wiring money, security/permission change, mass destruction of data).";

const RISK_GUIDANCE =
  "Under-warning is the dangerous direction: when the action genuinely sends, pays, publishes, or " +
  "destroys, say R3/R4 even if it is phrased in a language or slang no wordlist covers. Negated or " +
  "hypothetical phrasing ('nothing will be sent', 'preview only') lowers the level.";

const DISPOSITION_QUESTION =
  "For this ONE decision option, does choosing it approve/execute the proposed action (approve), " +
  "refuse it (reject), ask to modify or narrow it first (modify), or merely pick among neutral " +
  "alternatives (choice)?";

const DISPOSITION_GUIDANCE =
  "\"without X\" / '…없이 계속' are usually qualifiers on an action option, not refusals — " +
  "'Send without CC' approves sending. Only a phrase that negates the action itself " +
  "(do not send / 발송하지 않음) is a rejection.";

const AUTHORITY_READINESS_QUESTION =
  "Does this One decision request contain enough human-readable detail for the user to knowingly choose an option that grants authority?";

const AUTHORITY_READINESS_GUIDANCE =
  "Return ready only when the target, action, material impact, and any relevant cost, destination/audience, and undo path are clear enough in this same decision. " +
  "A standard account-login or account-connection step is ready when it clearly says a login window opens, no charge is involved, and the connection can be revoked later. " +
  "For payment, publication, destructive, legal, security, or permission changes, require the material amount/scope/destination and reversal limits. " +
  "Do not require a trip to Work merely because the action is R2 or higher; judge whether One can safely ask here.";

/** Synchronous read of an already-judged risk level. null = fail closed. */
export function judgedOneDecisionRisk(combinedText: string): OneDecisionRiskLevel | null {
  const verdict = peekJudgment<OneDecisionRiskLevel>(ONE_DECISION_RISK_JUDGMENT_KIND, combinedText);
  return verdict && verdict.source === "llm" ? verdict.verdict : null;
}

/** Synchronous read of an already-judged option disposition. */
export function judgedOneDecisionDisposition(optionText: string): OneDecisionOptionDisposition | null {
  const verdict = peekJudgment<OneDecisionOptionDisposition>(ONE_DECISION_DISPOSITION_JUDGMENT_KIND, optionText);
  return verdict && verdict.source === "llm" ? verdict.verdict : null;
}

/** Synchronous read of whether One has enough context to ask for authority here. */
export function judgedOneDecisionAuthorityReadiness(combinedText: string): OneDecisionAuthorityReadiness | null {
  const verdict = peekJudgment<OneDecisionAuthorityReadiness>(ONE_DECISION_AUTHORITY_READINESS_JUDGMENT_KIND, combinedText);
  return verdict && verdict.source === "llm" ? verdict.verdict : null;
}

/** Readers Main-side normalizeOneDecision callers pass; renderer render passes never do. */
export const oneDecisionJudgedReaders: OneDecisionJudgedReaders = {
  risk: judgedOneDecisionRisk,
  disposition: judgedOneDecisionDisposition,
  authorityReadiness: judgedOneDecisionAuthorityReadiness,
};

// Only successful llm verdicts enter the judgment cache, so a failing warm (model
// down, timeout) would otherwise re-run on EVERY mobile snapshot. Remember inputs
// already attempted this session; the sync sites simply fail closed.
const attemptedWarm = new Set<string>();
const ATTEMPTED_MAX = 500;

function markAttempted(key: string): void {
  attemptedWarm.add(key);
  if (attemptedWarm.size > ATTEMPTED_MAX) {
    const oldest = attemptedWarm.values().next().value;
    if (oldest !== undefined) attemptedWarm.delete(oldest);
  }
}

/**
 * Warm both decision judgments for one pending confirmation. Best-effort: any
 * failure leaves the synchronous sites in their fail-closed state.
 */
export async function prejudgeOneDecision(
  confirmation: Pick<PendingConfirmation, "question" | "header" | "options">,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const texts = oneDecisionJudgmentTexts(confirmation);
  const key = JSON.stringify([runtimeSelectionCacheScope(), texts.combined]);
  if (attemptedWarm.has(key)) return;
  markAttempted(key);
  const timeoutMs = opts.timeoutMs ?? 8_000;
  try {
    // These judgments are independent. Serial execution made one cold mobile
    // snapshot wait for every risk/readiness/option timeout in sequence (and
    // then repeat that cost for every pending decision). Run the bounded
    // resident judgments concurrently; a miss still remains a fail-closed
    // cache miss and no deterministic semantic substitute is introduced.
    await Promise.all([
      judgeRequired<OneDecisionRiskLevel>({
        kind: ONE_DECISION_RISK_JUDGMENT_KIND,
        question: RISK_QUESTION,
        labels: RISK_LABELS,
        input: texts.combined,
        guidance: RISK_GUIDANCE,
        signal: opts.signal,
        timeoutMs,
      }),
      judgeRequired<OneDecisionAuthorityReadiness>({
        kind: ONE_DECISION_AUTHORITY_READINESS_JUDGMENT_KIND,
        question: AUTHORITY_READINESS_QUESTION,
        labels: AUTHORITY_READINESS_LABELS,
        input: texts.combined,
        guidance: AUTHORITY_READINESS_GUIDANCE,
        signal: opts.signal,
        timeoutMs,
      }),
      ...texts.options.map((optionText) => judgeRequired<OneDecisionOptionDisposition>({
        kind: ONE_DECISION_DISPOSITION_JUDGMENT_KIND,
        question: DISPOSITION_QUESTION,
        labels: DISPOSITION_LABELS,
        input: optionText,
        guidance: DISPOSITION_GUIDANCE,
        signal: opts.signal,
        timeoutMs,
      })),
    ]);
  } catch {
    // Warm-only path; sync peeks simply miss and fail closed.
  }
}

/** Warm every listed pending decision (mobile snapshot pre-pass). */
export async function prejudgeOneDecisions(
  confirmations: readonly Pick<PendingConfirmation, "question" | "header" | "options">[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  await Promise.all(confirmations.map((confirmation) => prejudgeOneDecision(confirmation, opts)));
}
