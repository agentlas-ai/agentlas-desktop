/**







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
