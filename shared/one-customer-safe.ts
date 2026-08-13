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

const LOCAL_PATH = "[local path]";
const LOCAL_PATH_KO = "[로컬 경로]";

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

function redactLocalPaths(text: string, locale: OneSafeLocale): string {
  const replacement = locale === "ko" ? LOCAL_PATH_KO : LOCAL_PATH;
  return text.replace(ABSOLUTE_LOCAL_PATH, (match, prefix: string) => `${prefix}${replacement}${match.endsWith(".") ? "." : ""}`);
}

/**
 * The renderer owns the final customer-copy boundary. Provider replies can be
 * persisted verbatim, so remove only standalone infrastructure envelopes and
 * redact machine-local absolute paths before the text reaches One's surface.
 */
export function toCustomerSafeText(
  text: string | null | undefined,
  locale: OneSafeLocale = "en",
): string {
  if (!text) return "";
  return text
    .split(/(\n\s*\n+)/)
    .filter((part) => !isInternalRuntimeEnvelope(part))
    .map((part) => redactLocalPaths(part, locale))
    .join("")
    .trim();
}
