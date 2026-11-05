/** Figure reading and series lines for the result-card canvas (shared/canvas). Reads marks only, never the meaning of a label. */

const FIGURE_SCALES: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, tn: 1e12, trillion: 1e12, "만": 1e4, "억": 1e8, "조": 1e12 };
/** A figure the way models write it — "26%", "26.5x", "12.3배", "86.1조원", "1조 2,345억", "1,412원", "3.2bp", "~58%", "−18%", "$3,914/oz",
 *  "$1.90 (adj $2.28)" — read as a number and the unit its marks imply. Words that are not a figure ("N/A", "—") stay text for the
 *  schema to refuse. Reads marks only; never the meaning of a label. */
export function canvasFigure(raw: unknown): { value: unknown; unit?: string } {
  if (typeof raw !== "string") return { value: raw };
  let s = raw.trim().replace(/[−–]/g, "-").replace(/^(?:[~≈]|about\s+|approx\.?\s+|약\s*)/i, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*\/\s*[A-Za-z가-힣]+$/, "").trim();
  const unit = /%|pp$|퍼센트/i.test(s) ? "percent" : /bps?$/i.test(s) ? "bp" : /(?:x|배)$/i.test(s) ? "x" : /원|₩|krw/i.test(s) ? "krw" : /€|eur/i.test(s) ? "eur" : /£|gbp/i.test(s) ? "gbp" : /¥|jpy/i.test(s) ? "jpy" : undefined;
  s = s.replace(/%|pp$|퍼센트|bps?$|(?:x|배)$|원|₩|krw|eur|gbp|jpy|usd|us\$|[$€£¥]/gi, "").trim();
  const sign = /^[+-]/.test(s) && s[0] === "-" ? -1 : 1; s = s.replace(/^[+-]\s*/, "");
  const parts = [...s.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(조|억|만|thousand|million|billion|trillion|mm|mn|bn|tn|k|m|b|t)?/gi)];
  if (!parts.length || s.replace(/(\d[\d,]*(?:\.\d+)?)\s*(조|억|만|thousand|million|billion|trillion|mm|mn|bn|tn|k|m|b|t)?/gi, "").replace(/\s+/g, "") !== "") return { value: raw };
  // Several parts only as one Korean amount ("1조 2,345억"); otherwise the first figure alone is not a reading of the rest.
  if (parts.length > 1 && !parts.every(part => part[2] && /[조억만]/.test(part[2]))) return { value: raw };
  const total = parts.reduce((sum, part) => sum + Number(part[1].replace(/,/g, "")) * (part[2] ? FIGURE_SCALES[part[2].toLowerCase()] ?? FIGURE_SCALES[part[2]] ?? 1 : 1), 0);
  // 조·억·만 are Korean number words: without another currency mark the amount is in won.
  const read = unit ?? (parts.some(part => part[2] && /[조억만]/.test(part[2])) && !/[$€£¥]/.test(raw) ? "krw" : undefined);
  return Number.isFinite(total) ? { value: sign * Math.round(total * 1e6) / 1e6, ...(read ? { unit: read } : {}) } : { value: raw };
}

/** A chart block once the host has read its series. */
export type CanvasLine = { label: string; unit: string; points: { date: string; value: number }[] };

/** Daily observations of one finance.query result (price_history closes, a FRED or ECB series) as a dated line. */
export function canvasLine(result: { columns: readonly string[]; rows: readonly (string | number | null)[][] }, label: string): CanvasLine | null {
  const at = (name: string) => result.columns.indexOf(name);
  const d = at("Observation date") >= 0 ? at("Observation date") : at("Date");
  const candidates = ["Close (raw)", "Value", "Rate", "Close"];
  const v = candidates.map(at).find(i => i >= 0) ?? -1;
  if (d < 0 || v < 0) return null;
  const unitAt = ["Unit", "Currency"].map(at).find(i => i >= 0) ?? -1;
  const rows = result.rows.filter(row => typeof row[d] === "string" && typeof row[v] === "number" && Number.isFinite(row[v] as number))
    .map(row => ({ date: String(row[d]).slice(0, 10), value: row[v] as number })).sort((a, b) => a.date.localeCompare(b.date))
    .filter((row, i, all) => i === 0 || row.date !== all[i - 1].date);
  if (rows.length < 2) return null;
  return { label, unit: unitAt >= 0 ? String(result.rows[0]?.[unitAt] ?? "") : "", points: rows.slice(-600) };
}
