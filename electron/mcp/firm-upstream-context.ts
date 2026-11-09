/**
 * What an independent verification (or integration) stage is given of the work it checks.
 *
 * Measured (a real installation + product Codex rollouts, one Goal's team): every independent verification stage received the
 * producer's report cut at 8,242 characters ("…" and nothing else), the report being 9.7k-13.4k. 12 of 12 verifications answered
 * FAIL and 10 of them named the cut itself ("the report is cut off in the middle of the roadmap") as the reason. Each FAIL started
 * a repair pass and a second verification of the same cut, so the Goal paid four worker turns (about 100-180 s and 350-470k input
 * tokens each) per cycle for a defect that the host made. A cut is allowed (a bounded prompt is the point of the bound), a SILENT
 * cut is not: an over-bound text follows its declared overflow (docs/-harness-rework/PLAN.md, A: "reference", never
 * silent truncation), the cut is stated with both lengths, and the full text is named by path when the host could write it.
 */
export const FIRM_UPSTREAM_RESULT_INLINE_MAX_CHARS = 16_000;
export const FIRM_UPSTREAM_TOTAL_MAX_CHARS = 32_000;

/** `raw` within `allowed` characters, or its head plus one plain line saying how much was cut and where the whole text is. */
export function declaredCut(raw: string, allowed: number, fullTextPath?: string | null): string {
  if (raw.length <= allowed) return raw;
  const head = raw.slice(0, Math.max(0, allowed));
  return `${head}\n[cut: first ${head.length} of ${raw.length} characters${fullTextPath ? `; full text: ${fullTextPath}` : "; the rest was not carried, so do not judge the missing end"}]`;
}

export interface UpstreamResultLike { name: string; ok: boolean; evidenceSummary: string; text: string }

/** The upstream deliverables of a stage, each within its bound, the total within its budget; every cut declared. */
export function composeUpstreamResults(
  results: readonly UpstreamResultLike[],
  overflowPath?: (text: string) => string | null,
  limits: { perResult: number; total: number } = { perResult: FIRM_UPSTREAM_RESULT_INLINE_MAX_CHARS, total: FIRM_UPSTREAM_TOTAL_MAX_CHARS },
): string {
  let remaining = limits.total;
  return results.map((result) => {
    const raw = result.text.trim();
    const allowed = Math.max(0, Math.min(limits.perResult, remaining));
    const bounded = raw.length > allowed ? declaredCut(raw, allowed, overflowPath?.(raw) ?? null) : raw;
    remaining -= Math.min(raw.length, allowed);
    return [
      `## ${result.name}`,
      `status: ${result.ok ? "completed" : "failed"}`,
      result.evidenceSummary,
      bounded || "(no deliverable returned)",
    ].join("\n");
  }).join("\n\n");
}
