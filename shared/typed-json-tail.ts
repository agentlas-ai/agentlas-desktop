/**
 * A worker's typed result is its final message. Runners return the whole turn's text, so a worker that writes one line
 * before its JSON (Codex "I'll prepare only the requested copy." then the handoff) reached the strict parser as
 * "preamble + JSON" and the whole packet was thrown away as invalid (A/B T1, 2026-10-16: every room task failed).
 *
 * Accept exactly one shape besides a pure JSON document: a complete JSON object that ENDS the text (only whitespace or a
 * closing code fence after it) and carries the expected schemaVersion at its top level. Nothing is salvaged from the
 * middle of prose or from malformed JSON, and the caller still applies its full schema validation to the object.
 */
export function trailingTypedJsonObject(text: string, schemaVersion: string): Record<string, unknown> | null {
  let body = text.trimEnd();
  if (body.endsWith("```")) body = body.slice(0, -3).trimEnd();
  if (!body.endsWith("}")) return null;
  const marker = JSON.stringify(schemaVersion);
  let attempts = 0;
  for (let start = body.lastIndexOf("{"); start >= 0 && attempts < 256; start = body.lastIndexOf("{", start - 1)) {
    attempts += 1;
    const candidate = body.slice(start);
    if (!candidate.includes(marker)) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)
        && (value as Record<string, unknown>).schemaVersion === schemaVersion) return value as Record<string, unknown>;
    } catch { /* an inner brace; keep widening */ }
  }
  return null;
}

/** JSON.parse(source), or the trailing typed object when only narration precedes it; otherwise the original error. */
export function parseWholeOrTrailingTypedJson(source: string, schemaVersion: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const tail = trailingTypedJsonObject(source, schemaVersion);
    if (tail) return tail;
    throw error;
  }
}
