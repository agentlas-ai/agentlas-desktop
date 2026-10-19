





















import type { RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { registerNativeApprovalChildSignal } from "./native-approval-provenance";

export const WORKER_OUTPUT_DEGENERATE_CODE = "worker_output_degenerate";

/** Thresholds (see the header for the calibration). */
export const DEGENERATE_OUTPUT_POLICY = Object.freeze({
  /** Last N prose sentences examined. */
  window: 60,
  /** Share of the window that this output already said earlier. */
  minRepeatShare: 0.9,
  /** Mean earlier occurrences per window sentence (capped per sentence at `priorCap`): loops say each line many times. */
  minMeanPrior: 3,
  priorCap: 8,
  /** Nothing is judged before the reply is this long (a whole ordinary handoff is shorter). */
  minChars: 4_000,
  /** A sentence needs this many letters/digits to count (list markers, numbers, "ok" do not). */
  minSentenceAlnum: 4,
  /** Bounded memory: distinct sentences remembered, unterminated tail kept, text re-read after a reset. */
  maxDistinct: 50_000,
  maxCarry: 4_000,
  maxResetScan: 200_000,
});

export interface DegenerateOutputVerdict {
  readonly code: "repeated_sentences";
  readonly window: number;
  readonly repeated: number;
  readonly meanPrior: number;
  readonly sentences: number;
  readonly distinct: number;
  readonly chars: number;
}

/** The typed failure of a step whose output became a loop. Counts only; never the model's text. */
export class WorkerOutputDegenerateError extends Error {
  readonly code = WORKER_OUTPUT_DEGENERATE_CODE;
  /** The model was generating: the session acknowledged the turn, so it is never re-sent (shared/turn-settlement.ts). */
  readonly turnDelivery = "accepted" as const;
  constructor(readonly verdict: DegenerateOutputVerdict) {
    super(WORKER_OUTPUT_DEGENERATE_CODE);
    this.name = "WorkerOutputDegenerateError";
  }
}

const TERMINATORS = ".!?。！？";
const STRIP = " \t\"'`,;:-*•#>[](){}|";

function normalizeSentence(raw: string): string | null {
  let s = raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  let start = 0, end = s.length;
  while (start < end && STRIP.includes(s[start]!)) start += 1;
  while (end > start && STRIP.includes(s[end - 1]!)) end -= 1;
  s = s.slice(start, end).replace(/[.!?。！？…]+$/u, "").trim();
  let alnum = 0;
  for (const ch of s) if (/[\p{L}\p{N}]/u.test(ch) && ++alnum >= DEGENERATE_OUTPUT_POLICY.minSentenceAlnum) return s;
  return null;
}

export interface DegenerateOutputDetector {
  /** Feed the reply so far; returns a verdict the first time it reads as a loop. */
  observe(snapshot: string): DegenerateOutputVerdict | null;
}

export function createDegenerateOutputDetector(): DegenerateOutputDetector {
  const P = DEGENERATE_OUTPUT_POLICY;
  let seen = new Map<string, number>();
  let ring: Array<{ repeat: 0 | 1; prior: number }> = [];
  let repeatSum = 0, priorSum = 0, sentences = 0;
  let consumed = 0, anchor = "", carry = "", length = 0;
  let flagged = false;
  const reset = (): void => {
    seen = new Map(); ring = []; repeatSum = 0; priorSum = 0; sentences = 0; consumed = 0; anchor = ""; carry = "";
  };
  const add = (sentence: string): DegenerateOutputVerdict | null => {
    const prior = seen.get(sentence) ?? 0;
    if (prior > 0 || seen.size < P.maxDistinct) seen.set(sentence, prior + 1);
    const entry = { repeat: (prior > 0 ? 1 : 0) as 0 | 1, prior: Math.min(prior, P.priorCap) };
    ring.push(entry); repeatSum += entry.repeat; priorSum += entry.prior; sentences += 1;
    if (ring.length > P.window) { const old = ring.shift()!; repeatSum -= old.repeat; priorSum -= old.prior; }
    if (ring.length < P.window || length < P.minChars) return null;
    if (repeatSum / P.window < P.minRepeatShare || priorSum / P.window < P.minMeanPrior) return null;
    return { code: "repeated_sentences", window: P.window, repeated: repeatSum, meanPrior: Math.round((priorSum / P.window) * 100) / 100,
      sentences, distinct: seen.size, chars: length };
  };
  /**
   * Complete sentences of `text`; the open tail stays in carry. A line break (also the JSON escapes \n and \t, and a
   * JSON list boundary ",") ends a segment; a terminator ends a sentence only once a whitespace, quote or backslash
   * follows it, so a sentence split across two partials is read once, whole. \" reads as the quote it stands for.
   */
  const feed = (text: string): DegenerateOutputVerdict | null => {
    const buffer = (carry + text).replace(/\\"/g, "\"");
    const boundary = new RegExp(`\\n|\\\\[nt]|","|[${TERMINATORS}]+(?=[\\s"\\\\])`, "gu");
    let from = 0;
    for (let match = boundary.exec(buffer); match; match = boundary.exec(buffer)) {
      const terminator = TERMINATORS.includes(match[0][0]!);
      const sentence = normalizeSentence(buffer.slice(from, terminator ? match.index + match[0].length : match.index));
      from = match.index + match[0].length;
      if (sentence) {
        const verdict = add(sentence);
        if (verdict) { carry = ""; return verdict; }
      }
    }
    carry = buffer.slice(from);
    if (carry.length > P.maxCarry) carry = ""; // unterminated text is not counted
    return null;
  };
  return {
    observe(snapshot: string): DegenerateOutputVerdict | null {
      if (flagged || typeof snapshot !== "string") return null;
      const extends_ = snapshot.length >= consumed && (anchor === "" || snapshot.startsWith(anchor, consumed - anchor.length));
      if (!extends_) reset();
      const start = extends_ ? consumed : Math.max(0, snapshot.length - P.maxResetScan);
      length = snapshot.length;
      const verdict = start < snapshot.length ? feed(snapshot.slice(start)) : null;
      consumed = snapshot.length;
      anchor = snapshot.slice(Math.max(0, consumed - 32), consumed);
      if (verdict) flagged = true;
      return verdict;
    },
  };
}

/** The run_event payload of a detection: the verdict's counts, nothing the model wrote. */
export function degenerateOutputReceipt(verdict: DegenerateOutputVerdict): Record<string, unknown> {
  return { schemaVersion: "agentlas.worker-output-degenerate.v1", net: true, ...verdict };
}

export interface GuardedTeamStepPort {
  request: RunnerRequest;
  events: RunnerEvents;
  /** One dispatch with the caller's runner and accounting (runObservedRunner). */
  dispatch(request: RunnerRequest, events: RunnerEvents): Promise<RunnerResult>;
  /** Counts-only receipt of a detection. */
  record?(verdict: DegenerateOutputVerdict): void;
}

/**
 * One team-step dispatch with the net. The step's turn runs under a child of its own signal (registered for native
 * approval lineage, linked-abort.ts): on a verdict that child aborts with WorkerOutputDegenerateError, which every runner
 * turns into its own typed stop (codex turn/interrupt, Claude control interrupt, ACP session/cancel, API/local fetch
 * abort; each rejects with the signal's reason, abort-reason.ts). A runner that does not stream is judged on its final
 * text. Either way the step ends with that typed error; an owner stop or any other outcome passes through unchanged.
 */
export async function runGuardedTeamStep(port: GuardedTeamStepPort): Promise<RunnerResult> {
  const parent = port.request.signal;
  const controller = new AbortController();
  registerNativeApprovalChildSignal(parent, controller.signal);
  const onParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParent, { once: true });
  const detector = createDegenerateOutputDetector();
  let stopped: WorkerOutputDegenerateError | null = null;
  const judge = (text: string): void => {
    if (stopped) return;
    const verdict = detector.observe(text);
    if (!verdict) return;
    stopped = new WorkerOutputDegenerateError(verdict);
    try { port.record?.(verdict); } catch { /* telemetry never decides */ }
    controller.abort(stopped);
  };
  const events: RunnerEvents = {
    ...port.events,
    onPartial: (text) => {
      port.events.onPartial(text);
      judge(text);
    },
  };
  try {
    const result = await port.dispatch({ ...port.request, signal: controller.signal }, events);
    if (!stopped && typeof result.text === "string") judge(result.text);
    if (stopped) throw stopped;
    return result;
  } catch (error) {
    if (stopped && !parent?.aborted) throw stopped;
    throw error;
  } finally {
    parent?.removeEventListener("abort", onParent);
  }
}
