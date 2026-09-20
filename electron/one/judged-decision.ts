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
import { onHostShutdown } from "../host-lifecycle";
import { emitDesktopStoreChange } from "../store/change-bus";

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

type OneDecisionJudgmentConfirmation = Pick<
  PendingConfirmation,
  "chatId" | "sourceMessageId" | "question" | "header" | "options"
>;

type OneDecisionJudgeRequired = typeof judgeRequired;

interface OneDecisionPrejudgeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Private verifier seam. Production always uses the resident judge. */
  judgeRequiredFn?: OneDecisionJudgeRequired;
  /** Private verifier seam. Production emits the existing content-free store event. */
  onComplete?: () => void;
  /** Private verifier seam. Production retries at 0, 2, and 8 seconds. */
  retryDelaysMs?: readonly number[];
}

interface DeferredDecisionJudgment {
  key: string;
  confirmation: OneDecisionJudgmentConfirmation;
  attempt: number;
  controller: AbortController | null;
  timer: ReturnType<typeof setTimeout> | null;
  options: OneDecisionPrejudgeOptions;
}

interface ReadyDecisionJudgment {
  combined: string;
  optionInputs: string[];
  risk: OneDecisionRiskLevel;
  authorityReadiness: OneDecisionAuthorityReadiness;
  dispositions: OneDecisionOptionDisposition[];
}

// A live packaged Codex/Sol judge takes about 18–21 seconds on this host even
// for compact classification prompts. The runtime pool reserves half of this
// total for fallback candidates, so 60 seconds gives the first configured
// runtime a 30-second cold-start window. The old 8-second ceiling guaranteed a
// fail-closed R4 projection before the resident model could answer. The normal
// projection path is deferred and does not block snapshot delivery.
export const ONE_DECISION_JUDGE_TIMEOUT_MS = 60_000;
export const ONE_DECISION_JUDGE_RETRY_DELAYS_MS = [0, 2_000, 8_000] as const;

const JUDGMENT_STATE_MAX = 500;
const readyDecisionJudgments = new Map<string, ReadyDecisionJudgment>();
const deferredDecisionJudgments = new Map<string, DeferredDecisionJudgment>();
let activeDeferredDecisionKeys = new Set<string>();

function decisionJudgmentKey(confirmation: OneDecisionJudgmentConfirmation): string {
  const texts = oneDecisionJudgmentTexts(confirmation);
  return JSON.stringify([
    runtimeSelectionCacheScope(),
    confirmation.chatId,
    confirmation.sourceMessageId,
    texts.combined,
    texts.options,
  ]);
}

function rememberReadyDecision(key: string, judgment: ReadyDecisionJudgment): void {
  readyDecisionJudgments.delete(key);
  readyDecisionJudgments.set(key, judgment);
  if (readyDecisionJudgments.size > JUDGMENT_STATE_MAX) {
    const oldest = readyDecisionJudgments.keys().next().value;
    if (oldest !== undefined) readyDecisionJudgments.delete(oldest);
  }
}

function clearDeferredJob(job: DeferredDecisionJudgment): void {
  if (job.timer) clearTimeout(job.timer);
  job.timer = null;
  job.controller?.abort(new Error("One Decision judgment is no longer current"));
  job.controller = null;
  if (deferredDecisionJudgments.get(job.key) === job) {
    deferredDecisionJudgments.delete(job.key);
  }
}

function completeDecisionJudgment(
  confirmation: OneDecisionJudgmentConfirmation,
  key: string,
  judgment: ReadyDecisionJudgment,
  onComplete?: () => void,
): boolean {
  const texts = oneDecisionJudgmentTexts(confirmation);
  if (
    decisionJudgmentKey(confirmation) !== key
    || judgment.combined !== texts.combined
    || judgment.optionInputs.length !== texts.options.length
    || judgment.optionInputs.some((value, index) => value !== texts.options[index])
    || judgment.dispositions.length !== texts.options.length
  ) return false;
  if (readyDecisionJudgments.has(key)) return true;
  rememberReadyDecision(key, judgment);
  const job = deferredDecisionJudgments.get(key);
  if (job) clearDeferredJob(job);
  (onComplete ?? (() => emitDesktopStoreChange({ entity: "runtime" })))();
  return true;
}

function closedDecisionReaders(): OneDecisionJudgedReaders {
  return {
    risk: () => null,
    disposition: () => null,
    authorityReadiness: () => null,
  };
}

/**
 * Expose a decision's cached verdicts atomically. A partial raw judgment cache
 * (for example risk succeeded while one option timed out) remains fail-closed.
 */
export function oneDecisionJudgedReadersFor(
  confirmation: OneDecisionJudgmentConfirmation,
): OneDecisionJudgedReaders {
  const key = decisionJudgmentKey(confirmation);
  const judgment = readyDecisionJudgments.get(key);
  if (!judgment) return closedDecisionReaders();
  const texts = oneDecisionJudgmentTexts(confirmation);
  return {
    risk: (text) => text === texts.combined ? judgment.risk : null,
    authorityReadiness: (text) => text === texts.combined ? judgment.authorityReadiness : null,
    disposition: (text) => {
      const index = judgment.optionInputs.indexOf(text);
      return index >= 0 ? judgment.dispositions[index] ?? null : null;
    },
  };
}

async function runOneDecisionJudgments(
  confirmation: OneDecisionJudgmentConfirmation,
  options: OneDecisionPrejudgeOptions,
  signal: AbortSignal | undefined,
): Promise<ReadyDecisionJudgment | null> {
  const texts = oneDecisionJudgmentTexts(confirmation);
  const run = options.judgeRequiredFn ?? judgeRequired;
  const timeoutMs = options.timeoutMs ?? ONE_DECISION_JUDGE_TIMEOUT_MS;
  try {
    const risk = run<OneDecisionRiskLevel>({
      kind: ONE_DECISION_RISK_JUDGMENT_KIND,
      question: RISK_QUESTION,
      labels: RISK_LABELS,
      input: texts.combined,
      guidance: RISK_GUIDANCE,
      signal,
      timeoutMs,
    });
    const authorityReadiness = run<OneDecisionAuthorityReadiness>({
      kind: ONE_DECISION_AUTHORITY_READINESS_JUDGMENT_KIND,
      question: AUTHORITY_READINESS_QUESTION,
      labels: AUTHORITY_READINESS_LABELS,
      input: texts.combined,
      guidance: AUTHORITY_READINESS_GUIDANCE,
      signal,
      timeoutMs,
    });
    const dispositions = texts.options.map((optionText) => run<OneDecisionOptionDisposition>({
      kind: ONE_DECISION_DISPOSITION_JUDGMENT_KIND,
      question: DISPOSITION_QUESTION,
      labels: DISPOSITION_LABELS,
      input: optionText,
      guidance: DISPOSITION_GUIDANCE,
      signal,
      timeoutMs,
    }));
    const [riskResult, readinessResult, dispositionResults] = await Promise.all([
      risk,
      authorityReadiness,
      Promise.all(dispositions),
    ]);
    if (
      riskResult.source !== "llm"
      || riskResult.verdict === null
      || readinessResult.source !== "llm"
      || readinessResult.verdict === null
      || dispositionResults.some((value) => value.source !== "llm" || value.verdict === null)
    ) return null;
    return {
      combined: texts.combined,
      optionInputs: [...texts.options],
      risk: riskResult.verdict,
      authorityReadiness: readinessResult.verdict,
      dispositions: dispositionResults.map((value) => value.verdict as OneDecisionOptionDisposition),
    };
  } catch {
    return null;
  }
}

/**
 * Warm both decision judgments for one pending confirmation. Best-effort: any
 * failure leaves the synchronous sites in their fail-closed state.
 */
export async function prejudgeOneDecision(
  confirmation: OneDecisionJudgmentConfirmation,
  opts: OneDecisionPrejudgeOptions = {},
): Promise<void> {
  const key = decisionJudgmentKey(confirmation);
  if (readyDecisionJudgments.has(key)) return;
  const judgment = await runOneDecisionJudgments(confirmation, opts, opts.signal);
  if (judgment) completeDecisionJudgment(confirmation, key, judgment, opts.onComplete);
}

function scheduleDeferredAttempt(job: DeferredDecisionJudgment): void {
  const delays = job.options.retryDelaysMs ?? ONE_DECISION_JUDGE_RETRY_DELAYS_MS;
  if (job.attempt >= delays.length || !activeDeferredDecisionKeys.has(job.key)) {
    clearDeferredJob(job);
    return;
  }
  const delay = Math.max(0, Math.floor(delays[job.attempt] ?? 0));
  job.timer = setTimeout(() => {
    job.timer = null;
    if (
      deferredDecisionJudgments.get(job.key) !== job
      || !activeDeferredDecisionKeys.has(job.key)
      || decisionJudgmentKey(job.confirmation) !== job.key
    ) {
      clearDeferredJob(job);
      return;
    }
    job.attempt += 1;
    const controller = new AbortController();
    job.controller = controller;
    const signal = job.options.signal
      ? AbortSignal.any([controller.signal, job.options.signal])
      : controller.signal;
    void runOneDecisionJudgments(job.confirmation, job.options, signal).then((judgment) => {
      if (
        deferredDecisionJudgments.get(job.key) !== job
        || !activeDeferredDecisionKeys.has(job.key)
        || signal.aborted
      ) return;
      job.controller = null;
      if (judgment && completeDecisionJudgment(job.confirmation, job.key, judgment, job.options.onComplete)) return;
      scheduleDeferredAttempt(job);
    });
  }, delay);
}

/**
 * Reconcile background judgment work for the exact pending Decision generation.
 * This function never awaits a model and therefore never blocks a snapshot.
 */
export function deferPrejudgeOneDecisions(
  confirmations: readonly OneDecisionJudgmentConfirmation[],
  opts: OneDecisionPrejudgeOptions = {},
): void {
  const current = new Map(confirmations.map((confirmation) => [decisionJudgmentKey(confirmation), confirmation]));
  activeDeferredDecisionKeys = new Set(current.keys());
  for (const job of deferredDecisionJudgments.values()) {
    if (!activeDeferredDecisionKeys.has(job.key)) clearDeferredJob(job);
  }
  for (const [key, confirmation] of current) {
    if (readyDecisionJudgments.has(key)) continue;
    const existing = deferredDecisionJudgments.get(key);
    if (existing) continue;
    const job: DeferredDecisionJudgment = {
      key,
      confirmation,
      attempt: 0,
      controller: null,
      timer: null,
      options: opts,
    };
    deferredDecisionJudgments.set(key, job);
    scheduleDeferredAttempt(job);
  }
}

/** Warm every listed pending decision when an explicit caller chooses to wait. */
export async function prejudgeOneDecisions(
  confirmations: readonly OneDecisionJudgmentConfirmation[],
  opts: OneDecisionPrejudgeOptions = {},
): Promise<void> {
  await Promise.all(confirmations.map((confirmation) => prejudgeOneDecision(confirmation, opts)));
}

export function cancelDeferredOneDecisionJudgments(): void {
  activeDeferredDecisionKeys.clear();
  for (const job of [...deferredDecisionJudgments.values()]) clearDeferredJob(job);
}

/** Private verifier reset; production lifecycle uses host shutdown instead. */
export function resetOneDecisionJudgmentStateForTests(): void {
  cancelDeferredOneDecisionJudgments();
  readyDecisionJudgments.clear();
}

onHostShutdown(cancelDeferredOneDecisionJudgments);
