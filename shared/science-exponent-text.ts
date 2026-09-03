/**
 * Splitting a caret exponent out of a plain-text scientific string.
 *
 * Analyses emit units and quantities as plain text -- `angstrom^3`, `g/cm^3`, `10^-3` -- because
 * that is the unambiguous machine form, and it is the right thing to keep in a CSV export. It is
 * the wrong thing to PRINT. Every presentation surface has to turn it into a real superscript, and
 * they have to agree: a paper that sets `angstrom³` in a figure axis and `angstrom^3` in the table
 * beside it has told the reader those are two different quantities, or that one of them is a typo.
 *
 * That is exactly what happened here. LaTeX was taught to set the superscript and HTML and DOCX
 * were not, so the same unit appeared three ways across the product's own outputs. This is the one
 * place that decides where the exponent is, so a fourth surface cannot drift again.
 *
 * A caret followed by an optional sign and digits is the only exponent form these strings use.
 * Anything else -- a bare caret, a caret before a letter -- is left alone and escaped normally.
 */
export interface ScienceTextSegment {
  readonly text: string;
  readonly superscript: boolean;
}

const EXPONENT = /\^(-?\d+)/gu;

export function scienceTextSegments(value: string): ScienceTextSegment[] {
  const segments: ScienceTextSegment[] = [];
  let index = 0;
  for (const match of String(value ?? "").matchAll(EXPONENT)) {
    const at = match.index ?? 0;
    if (at > index) segments.push({ text: value.slice(index, at), superscript: false });
    segments.push({ text: match[1], superscript: true });
    index = at + match[0].length;
  }
  if (index < value.length) segments.push({ text: value.slice(index), superscript: false });
  return segments.length ? segments : [{ text: String(value ?? ""), superscript: false }];
}

/** True when the text carries an exponent a presentation surface has to raise. */
export function hasScienceExponent(value: string): boolean {
  return /\^-?\d/u.test(String(value ?? ""));
}
