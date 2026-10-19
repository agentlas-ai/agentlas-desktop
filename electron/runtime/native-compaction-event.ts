/*
 * G17: one structured run event per NATIVE compaction a subscription CLI performs on its own session.
 *
 * Why separate from ThreadHealth: rotation reads an aggregate count (session-rotation.ts) and an aggregate cannot say
 * which compaction happened when, why, or against what window. This event is the per-occurrence record; the running
 * count rides along as `compactionsThisTurn` and is NEVER the same number as the lifetime aggregate.
 *
 * Observability only: no rotation or prompt behaviour depends on it. Ids, enums and counts only, no text. A field the
 * provider did not give is absent (never 0), and the event does not claim that the next call's fresh input was
 * caused by the compaction.
 */
import { resolveEffectiveContextWindow } from "../../shared/models";
import { tryRecordRunEvent } from "../store/run-events";
import { currentModelCallScope, modelCallRunIdentity } from "./model-call-ledger";
import { observedContextWindow } from "./session-generation";

export const NATIVE_COMPACTION_SCHEMA = "agentlas.native-compaction.v1";
export const NATIVE_COMPACTION_EVENT_KIND = "native_compaction";

export type WindowProvenance = "verified" | "assumed" | "unknown";

/** Backend names the model catalog knows each subscription runtime by (mirrors session-generation.ts). */
const RUNTIME_PROVIDER: Readonly<Record<string, string>> = { "claude-code": "anthropic", codex: "openai" };

/**




 */
export function windowWithProvenance(runtime: string, model: string | null | undefined, configuredLimit?: number | null):
  { tokens?: number; provenance: WindowProvenance; source: string } {
  try {
    const observed = observedContextWindow(runtime, model);
    if (observed) return { tokens: observed, provenance: "verified", source: "observed" };
  } catch { /* the catalog below */ }
  for (const backend of [runtime, RUNTIME_PROVIDER[runtime]].filter((value): value is string => Boolean(value))) {
    try {
      const found = resolveEffectiveContextWindow(backend, model, false);
      if (found.contextWindow) return { tokens: found.contextWindow, provenance: "verified", source: found.source };
    } catch { /* next candidate */ }
  }
  if (typeof configuredLimit === "number" && Number.isSafeInteger(configuredLimit) && configuredLimit > 0) {
    return { tokens: configuredLimit, provenance: "assumed", source: "host-configured-limit" };
  }
  return { provenance: "unknown", source: "unknown" };
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const token = (value: unknown, max = 120): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

export interface NativeCompactionInput {
  runtime: "codex" | "claude-code";
  chatId?: string | null;
  model?: string | null;
  /** The provider's own id for this compaction (item id, event uuid) when it gives one. */
  nativeRef?: string | null;
  /** The provider session/thread the compaction happened in. */
  sessionRef?: string | null;
  /** The provider turn it happened in. Codex may emit two signals (item + notice) for one occurrence: dedupe by turnRef. */
  turnRef?: string | null;
  /** Where we saw it: "thread/compacted" | "item/completed" | "compact_boundary" | ... */
  signal: string;
  /** The provider's reason/trigger string ("auto", "manual") when given; absent otherwise. */
  reason?: string | null;
  tokensBefore?: number | null;
  tokensBeforeSource?: "provider" | "last_observed_input";
  tokensAfter?: number | null;
  configuredWindowLimit?: number | null;
  /** Compactions seen in this turn so far, including this one. Not the lifetime aggregate. */
  compactionsThisTurn?: number;
}

export function nativeCompactionPayload(input: NativeCompactionInput): Record<string, unknown> {
  const window = windowWithProvenance(input.runtime, input.model, input.configuredWindowLimit);
  const before = count(input.tokensBefore); const after = count(input.tokensAfter);
  return {
    schemaVersion: NATIVE_COMPACTION_SCHEMA, runtime: input.runtime, signal: input.signal,
    ...(token(input.nativeRef) ? { nativeRef: token(input.nativeRef) } : {}),
    ...(token(input.sessionRef) ? { sessionRef: token(input.sessionRef) } : {}),
    ...(token(input.turnRef) ? { turnRef: token(input.turnRef) } : {}),
    ...(token(input.model) ? { model: token(input.model) } : {}),
    ...(token(input.reason, 40) ? { reason: token(input.reason, 40) } : {}),
    ...(before !== undefined ? { tokensBefore: before, tokensBeforeSource: input.tokensBeforeSource ?? "provider" } : {}),
    ...(after !== undefined ? { tokensAfter: after } : {}),
    ...(window.tokens !== undefined ? { windowTokens: window.tokens } : {}),
    windowProvenance: window.provenance, windowSource: window.source,
    ...(count(input.compactionsThisTurn) !== undefined ? { compactionsThisTurn: count(input.compactionsThisTurn) } : {}),
  };
}

/** Record one native compaction. Swallows every failure; safe to call from a CLI event handler. */
export function recordNativeCompaction(input: NativeCompactionInput): void {
  try {
    const scope = currentModelCallScope();
    // The same run the call's ledger row names (ID-5): the model-call scope, else the accounted run.
    const { runId, chatId, nodeId, automationId } = modelCallRunIdentity(scope, input.chatId);
    const ref = token(input.nativeRef);
    tryRecordRunEvent({
      runId, ...(chatId ? { chatId } : {}), ...(nodeId ? { nodeId } : {}), ...(automationId ? { automationId } : {}),
      ...(scope?.agentId ? { agentId: scope.agentId } : {}),
      kind: NATIVE_COMPACTION_EVENT_KIND,
      ...(ref ? { sourceEventId: `${NATIVE_COMPACTION_EVENT_KIND}:${input.runtime}:${ref}` } : {}),
      payload: nativeCompactionPayload(input),
    });
  } catch { /* observability must not break a run */ }
}
