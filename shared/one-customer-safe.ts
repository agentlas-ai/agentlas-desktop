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

/**
 * Final text and diagnoses reaching this boundary are already One-authored.
 * Preserve them byte-for-byte; safety and capability validation belong to the
 * structured authority boundary, not a regex, keyword list, or dictionary.
 */
export function toCustomerSafeText(
  text: string | null | undefined,
  _locale: OneSafeLocale = "en",
): string {
  return text ?? "";
}
