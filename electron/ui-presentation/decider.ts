import { createHash } from "node:crypto";
import {
  UI_PRESENTATION_INSTRUCTION, UI_PRESENTATION_MIN_CONFIDENCE, isUiPresentationChoice, presentationDecisionInput, resolveRenderer, surfaceRenderers,
  type UiPresentationChoice, type UiPresentationMessage, type UiPresentationRenderer, type UiPresentationSurface,
} from "./contract";

/*
 * Who decides how an answer is shown. Production registers nobody (the decider is null), so every turn is `model-self`: the main model
 * keeps choosing by reading read_ui_schema, byte for byte as before. A local decision model registers itself here
 * once one exists; a failure of any kind never fails the turn.
 */

export interface UiPresentationDeciderInput {
  messages: UiPresentationMessage[];
  surface: UiPresentationSurface;
  /** The renderers this surface can draw (contract `surfaces`). */
  renderers: UiPresentationRenderer[];
  /** The contract's one-question instruction. */
  instruction: string;
  signal?: AbortSignal;
}
/** `null` = the decider abstains (same as unsure): the turn is model-self. */
export type UiPresentationDeciderOutput = { choice: unknown; confidence?: unknown } | null | undefined;
export type UiPresentationDecider = (input: UiPresentationDeciderInput) => Promise<UiPresentationDeciderOutput> | UiPresentationDeciderOutput;

export type ModelSelfReason = "no-decider" | "no-messages" | "failure" | "timeout" | "aborted" | "invalid" | "low-confidence" | "abstained";
export type UiPresentationDecision =
  | { source: "model-self"; reason: ModelSelfReason }
  | { source: "decider"; choice: UiPresentationChoice; renderer: UiPresentationRenderer; confidence?: number };

/**
 * Wait budget for the decider before the main model starts. basis: not measured. The decision runs on the turn's critical path, in front
 * of a CLI/API start that itself takes seconds, so a stand-in must not hold the turn longer than a fraction of that; replace this with the
 * local decision model's measured p95 once it exists. A timeout is not an error: the turn is model-self.
 */
export const UI_PRESENTATION_DEFAULT_TIMEOUT_MS = 2_000;

let decider: UiPresentationDecider | null = null;
const cache = new Map<string, Promise<UiPresentationDecision>>();
/** basis: a turn needs only its own decision and a conversation's next turn replaces it; a few dozen live conversations bound the memory. */
const CACHE_MAX_ENTRIES = 64;

/** Register (or, with null, remove) the decider. A new decider never reuses a decision of the old one. */
export function setUiPresentationDecider(next: UiPresentationDecider | null): void {
  decider = next;
  cache.clear();
}
export function hasUiPresentationDecider(): boolean { return decider !== null; }

const modelSelf = (reason: ModelSelfReason): UiPresentationDecision => ({ source: "model-self", reason });

/** Validate a decider's answer against the contract; anything else is model-self. */
export function validatePresentationOutput(raw: unknown, surface: UiPresentationSurface): UiPresentationDecision {
  if (raw === null || raw === undefined) return modelSelf("abstained");
  if (typeof raw !== "object" || Array.isArray(raw)) return modelSelf("invalid");
  const { choice, confidence } = raw as { choice?: unknown; confidence?: unknown };
  if (!isUiPresentationChoice(choice)) return modelSelf("invalid");
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return modelSelf("invalid");
  if (UI_PRESENTATION_MIN_CONFIDENCE !== null && (confidence === undefined || confidence < UI_PRESENTATION_MIN_CONFIDENCE)) return modelSelf("low-confidence");
  return { source: "decider", choice, renderer: resolveRenderer(choice, surface), ...(confidence === undefined ? {} : { confidence }) };
}

export interface DecideUiPresentationOptions {
  history: ReadonlyArray<{ role?: unknown; text?: unknown }>;
  surface: UiPresentationSurface;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Ask the registered decider once. Never throws, never waits longer than the timeout. */
export async function decideUiPresentation(options: DecideUiPresentationOptions): Promise<UiPresentationDecision> {
  const active = decider;
  if (!active) return modelSelf("no-decider");
  try {
    const messages = presentationDecisionInput(options.history);
    if (!messages.length) return modelSelf("no-messages");
    if (options.signal?.aborted) return modelSelf("aborted");
    const timeoutMs = options.timeoutMs ?? UI_PRESENTATION_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race<{ kind: "answer"; raw: UiPresentationDeciderOutput } | { kind: "timeout" } | { kind: "aborted" }>([
        Promise.resolve().then(() => active({ messages, surface: options.surface, renderers: surfaceRenderers(options.surface),
          instruction: UI_PRESENTATION_INSTRUCTION, signal: controller.signal })).then((raw) => ({ kind: "answer" as const, raw })),
        new Promise<{ kind: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs); }),
        new Promise<{ kind: "aborted" }>((resolve) => { controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true }); }),
      ]);
      if (outcome.kind === "timeout") { controller.abort(); return modelSelf("timeout"); }
      if (outcome.kind === "aborted") return modelSelf("aborted");
      return validatePresentationOutput(outcome.raw, options.surface);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    return modelSelf("failure");
  }
}

/**
 * The cache key of one person message: the conversation, how many person messages it holds and the digest of the message being
 * answered. A turn's continuations (tool rounds, a resend of the same message) share it; the next person message gets a new key.
 */
export function presentationTurnKey(conversationId: string, history: ReadonlyArray<{ role?: unknown; text?: unknown }>): string {
  const messages = presentationDecisionInput(history);
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.text ?? "";
  const userCount = history.filter((row) => row.role === "user").length;
  return `${conversationId}:${userCount}:${createHash("sha256").update(lastUser).digest("hex").slice(0, 16)}`;
}

/** One decision per person message: the first call decides, later calls with the same key reuse it (also concurrently). */
export function decideUiPresentationOnce(key: string, options: DecideUiPresentationOptions): Promise<UiPresentationDecision> {
  if (!decider) return Promise.resolve(modelSelf("no-decider"));
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const pending = decideUiPresentation(options);
  cache.set(key, pending);
  while (cache.size > CACHE_MAX_ENTRIES) { const oldest = cache.keys().next().value; if (oldest === undefined) break; cache.delete(oldest); }
  // A decision cut short by the caller's abort says nothing about the message: do not keep it.
  void pending.then((decision) => { if (decision.source === "model-self" && decision.reason === "aborted" && cache.get(key) === pending) cache.delete(key); });
  return pending;
}
