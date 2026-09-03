/**
 * How a number is written in a results table.
 *
 * The manuscript renderer already decided this: six significant figures, exponent notation outside
 * [1e-4, 1e6), integers left alone, a null written as an em dash. The screen did not use that rule
 * -- it printed `String(value)` -- so the same coefficient read 0.002705739645437749 in the app and
 * 0.00270574 in the paper made from it. A researcher comparing the two sees two different numbers.
 *
 * This is the screen's copy of that rule, kept honest by `science-results-number-format-contract`,
 * which runs BOTH this function and the renderer's `formatCell` over the same values and fails if
 * they ever disagree. The displayed value is a rounding for reading; the exact value stays in the
 * cell's title and in the run receipt, so nothing here is the only record of a number.
 */
export function formatScienceCell(value, type) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    if (type === "integer" || Number.isInteger(value)) return String(value);
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e6)) return value.toExponential(3);
    return String(Number(value.toPrecision(6)));
  }
  return String(value);
}
