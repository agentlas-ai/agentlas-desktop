// One owns semantic presentation. Code must not infer meaning from words,
// classify model output, or replace it with a canned sentence.

export type OneSafeLocale = "ko" | "en";

/**
 * Runtime progress strings are untrusted operational evidence. One's visible
 * progress uses its structured stage projection, so every non-empty free-form
 * runtime status stays private without inspecting its vocabulary.
 */
export function isInternalProgressStatus(status: string | null | undefined): boolean {
  return Boolean(status?.trim());
}

/**
 * Free-form runtime status never becomes customer copy. The structured One
 * stage remains visible and no semantic fallback is manufactured here.
 */
export function customerSafeProgressDetail(_status: string | null | undefined): string {
  return "";
}

// This is deliberately narrow: it removes transport/runtime envelopes that
// leaked through a persisted provider reply. It does not classify an answer,
// invent a replacement sentence, or suppress ordinary technical prose.
const INTERNAL_RUNTIME_SIGNAL = /\b(?:runtimes?|dependencies)\/(?:codex|python|node|[a-z0-9_.-]+)|\boverride\s+binar(?:y|ies)\b|\bcommand-scoped\s+paths?\b|\b(?:runtime|provider)\s+(?:fallback|bootstrap|session)\b/i;
const ABSOLUTE_LOCAL_PATH = /(^|[\s("'`])(?:\/(?:Users|private|var|tmp|opt|Volumes|home|workspace|Library)(?:\/[\w.@+%=-]+)+|[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)+[^\s\\/:*?"<>|]+|\\\\[^\s\\/:*?"<>|]+\\[^\s\\/:*?"<>|]+)/g;
const HAS_ABSOLUTE_LOCAL_PATH = new RegExp(ABSOLUTE_LOCAL_PATH.source);

function isInternalRuntimeEnvelope(paragraph: string): boolean {
  const signals = paragraph.match(new RegExp(INTERNAL_RUNTIME_SIGNAL.source, "gi")) ?? [];
  return signals.length >= 2 || (signals.length >= 1 && HAS_ABSOLUTE_LOCAL_PATH.test(paragraph));
}

/**
 * The renderer owns the final customer-copy boundary for its own screen. Provider replies can be persisted verbatim, so remove only
 * standalone infrastructure envelopes. it does NOT mask local paths: the owner's own desktop view keeps the real paths of the owner's
 * own machine (a file the answer names must be findable; "[로컬 경로]" in place of the folder hid it). What leaves the machine is
 * masked once, at the channel's boundary, by shared/remote-projection.ts (the phone's bridge); the renderer never masks.
 */
export function withoutRuntimeEnvelopes(
  text: string | null | undefined,
  /** Kept for the callers' signature; nothing here depends on the language any more. */
  _locale: OneSafeLocale = "en",
  /** Retained for callers written before; a path is never masked here, with or without it. */
  _options: { keepLocalPaths?: boolean } = {},
): string {
  if (!text) return "";
  return text
    .split(/(\n\s*\n+)/)
    .filter((part) => !isInternalRuntimeEnvelope(part))
    .join("")
    .trim();
}

/** The name this function had while it also masked paths. Kept for callers and gates written before; the desktop renderer calls `withoutRuntimeEnvelopes`. */
export const toCustomerSafeText = withoutRuntimeEnvelopes;
