/*
 * What a slow keystroke looked like, with times only. A report never carries the typed text, the field's value, a selector or
 * any page content: the renderer measures, Main validates the numbers again and writes them to
 * <userData>/diagnostics/input-latency.jsonl.
 *
 * Why it exists: typing in the chat composer lagged by about a second while Main's log recorded 21 stalls of 5-38 s
 * with the app at 0% CPU. A browser's Event Timing splits one slow key into three waits that point at different owners:
 *   inputDelayMs   - key press -> the page's handlers start. The renderer's thread was busy, or the browser process (Electron's
 *                    Main) was blocked before it handed the key over. Korean IME input goes through that process.
 *   processingMs   - the handlers' own time: React renders and effects of the composer.
 *   presentationMs - handlers done -> next paint: style, layout, paint.
 */

export const INPUT_LATENCY_THRESHOLD_MS = 100;
export const INPUT_LATENCY_LONG_TASK_WINDOW_MS = 2_000;
export const INPUT_LATENCY_MAX_REPORTS = 40;
export const INPUT_LATENCY_MIN_GAP_MS = 3_000;

export const INPUT_LATENCY_EVENTS = [
  "keydown", "keypress", "keyup", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend",
] as const;
export type InputLatencyEvent = (typeof INPUT_LATENCY_EVENTS)[number];
export type InputLatencyTarget = "chat-composer" | "text-field" | "other";
export type InputLatencyCause = "waiting-before-handler" | "handler" | "after-handler";

export interface InputLatencyReport {
  at: number;
  event: InputLatencyEvent;
  target: InputLatencyTarget;
  durationMs: number;
  inputDelayMs: number;
  processingMs: number;
  presentationMs: number;
  longTasks: number;
  longTaskMs: number;
  hidden: boolean;
  cause: InputLatencyCause;
}

/** The fields of a PerformanceEventTiming entry this module reads (all milliseconds on the page's clock). */
export interface InputTimingEntry {
  name: string;
  startTime: number;
  processingStart: number;
  processingEnd: number;
  duration: number;
}

const MAX_MS = 600_000;
const clampMs = (value: unknown): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.round(Math.min(MAX_MS, Math.max(0, n)));
};
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/** The largest of the three waits names the owner to look at; ties go to the earlier one in the order below. */
export function classifyInputLatency(inputDelayMs: number, processingMs: number, presentationMs: number): InputLatencyCause {
  if (inputDelayMs >= processingMs && inputDelayMs >= presentationMs) return "waiting-before-handler";
  return processingMs >= presentationMs ? "handler" : "after-handler";
}

export function makeInputLatencyReport(input: {
  entry: InputTimingEntry;
  target: InputLatencyTarget;
  longTasks: number;
  longTaskMs: number;
  hidden: boolean;
  at: number;
}): InputLatencyReport | null {
  const { entry } = input;
  if (!isOneOf(INPUT_LATENCY_EVENTS, entry.name)) return null;
  const inputDelayMs = clampMs(entry.processingStart - entry.startTime);
  const processingMs = clampMs(entry.processingEnd - entry.processingStart);
  const durationMs = clampMs(entry.duration);
  const presentationMs = clampMs(entry.startTime + entry.duration - entry.processingEnd);
  if (durationMs < INPUT_LATENCY_THRESHOLD_MS) return null;
  return {
    at: Math.round(input.at),
    event: entry.name,
    target: input.target,
    durationMs,
    inputDelayMs,
    processingMs,
    presentationMs,
    longTasks: clampMs(input.longTasks),
    longTaskMs: clampMs(input.longTaskMs),
    hidden: input.hidden === true,
    cause: classifyInputLatency(inputDelayMs, processingMs, presentationMs),
  };
}

/** Main re-validates what the renderer sent: only these keys, only numbers and the allowed words, nothing else survives. */
export function sanitizeInputLatencyReport(value: unknown): InputLatencyReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isOneOf(INPUT_LATENCY_EVENTS, v.event)) return null;
  const target: InputLatencyTarget = isOneOf(["chat-composer", "text-field", "other"] as const, v.target) ? v.target : "other";
  const inputDelayMs = clampMs(v.inputDelayMs);
  const processingMs = clampMs(v.processingMs);
  const presentationMs = clampMs(v.presentationMs);
  const durationMs = clampMs(v.durationMs);
  if (durationMs < INPUT_LATENCY_THRESHOLD_MS) return null;
  return {
    at: clampMs(v.at),
    event: v.event,
    target,
    durationMs,
    inputDelayMs,
    processingMs,
    presentationMs,
    longTasks: clampMs(v.longTasks),
    longTaskMs: clampMs(v.longTaskMs),
    hidden: v.hidden === true,
    cause: classifyInputLatency(inputDelayMs, processingMs, presentationMs),
  };
}

/** At most `max` reports per page life, and none closer than `minGapMs` to the previous one: a lag that lasts a minute is one line, not hundreds. */
export function createInputLatencyLimiter(max = INPUT_LATENCY_MAX_REPORTS, minGapMs = INPUT_LATENCY_MIN_GAP_MS): (now: number) => boolean {
  let sent = 0;
  let last = -Infinity;
  return (now: number): boolean => {
    if (sent >= max || now - last < minGapMs) return false;
    sent += 1;
    last = now;
    return true;
  };
}
