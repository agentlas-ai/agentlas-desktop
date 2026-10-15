export type UiResultCaller = (operation: string, args: Record<string, unknown>) => Promise<{ status: string; data?: unknown; reason?: string }>;

/** Retained results are paged originals, not the page envelope itself. Never render a truncated page as a widget. */
export async function readUiResult(call: UiResultCaller, resultRef: string, active: () => boolean = () => true): Promise<unknown> {
  let cursor = "";
  let text = "";
  let total: number | undefined;
  const limit = 256_000;
  const maxChars = 2 * 1024 * 1024;
  for (let page = 0; page < 16 && active(); page += 1) {
    const outcome = await call("result.read", { resultRef, part: "original", cursor, limit });
    if (!active()) return null;
    if (outcome.status !== "ok") throw new Error(outcome.reason ?? "ui_result_unavailable");
    const data = outcome.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("ui_result_invalid_page");
    const value = data as Record<string, unknown>;
    if (value.part !== "original" || typeof value.content !== "string" || !Number.isSafeInteger(value.totalChars)
      || Number(value.totalChars) < 0 || Number(value.totalChars) > maxChars) throw new Error("ui_result_invalid_page");
    if (total !== undefined && total !== value.totalChars) throw new Error("ui_result_changed");
    total = Number(value.totalChars);
    text += value.content;
    if (text.length > total || text.length > maxChars) throw new Error("ui_result_too_large");
    if (value.nextCursor === null) {
      if (text.length !== total) throw new Error("ui_result_incomplete");
      return JSON.parse(text);
    }
    if (typeof value.nextCursor !== "string" || !/^\d+$/.test(value.nextCursor)
      || Number(value.nextCursor) !== text.length || Number(value.nextCursor) <= Number(cursor || 0)) throw new Error("ui_result_invalid_cursor");
    cursor = value.nextCursor;
  }
  if (!active()) return null;
  throw new Error("ui_result_incomplete");
}
