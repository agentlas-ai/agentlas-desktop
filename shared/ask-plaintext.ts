/** Plain channels retain free-text questions independently of sheet option rules. */
export function renderPlainAskBody(body: string, locale: "ko" | "en"): string | null {
  const stripped = body.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let value: unknown;
  try { value = JSON.parse(stripped); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.question !== "string" || !raw.question.trim()) return null;
  const lines = [raw.question.trim()];
  let count = 0;
  for (const option of Array.isArray(raw.options) ? raw.options : []) {
    if (!option || typeof option !== "object" || Array.isArray(option)) continue;
    const item = option as Record<string, unknown>;
    if (typeof item.label !== "string" || !item.label.trim()) continue;
    const description = typeof item.description === "string" && item.description.trim()
      ? ` — ${item.description.trim()}` : "";
    lines.push(`${++count}. ${item.label.trim()}${description}`);
  }
  if (count) lines.push(locale === "en"
    ? "\nReply with the number (or the option) you want."
    : "\n원하는 번호(또는 항목)를 답장으로 보내주세요.");
  return lines.join("\n");
}
