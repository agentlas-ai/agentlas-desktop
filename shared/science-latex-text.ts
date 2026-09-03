import { scienceTextSegments } from "./science-exponent-text";
// The single definition of "this text, set in LaTeX".
//
// There were two: the manuscript renderer's, and a shorter one inside the standalone table
// exporter. The short one did not escape `<` or `>`, so a cell reading "<verified>" was typeset
// as inverted punctuation, and it dropped every mathematical symbol -- the same defect the
// manuscript renderer had until symbols were mapped. A submission bundle carries output from
// both, so the two disagreeing was visible inside one delivered package.
//
// Anything that writes LaTeX must import from here rather than grow a third copy.

const LATEX_SYMBOLS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/≥/gu, "$\\geq$"], [/≤/gu, "$\\leq$"], [/≠/gu, "$\\neq$"], [/≈/gu, "$\\approx$"],
  [/±/gu, "$\\pm$"], [/×/gu, "$\\times$"], [/÷/gu, "$\\div$"], [/·/gu, "$\\cdot$"],
  [/∞/gu, "$\\infty$"], [/√/gu, "$\\sqrt{}$"], [/∑/gu, "$\\sum$"], [/∏/gu, "$\\prod$"],
  [/∫/gu, "$\\int$"], [/∂/gu, "$\\partial$"], [/∈/gu, "$\\in$"], [/→/gu, "$\\rightarrow$"],
  [/[α-ωΑ-Ω]/gu, ""],
  [/−/gu, "$-$"], [/⁻/gu, "$^{-}$"], [/⁺/gu, "$^{+}$"], [/–/gu, "--"], [/—/gu, "---"], [/‰/gu, "\\textperthousand{}"], [/°/gu, "\\textdegree{}"],
  [/[""]/gu, "''"], [/['']/gu, "'"], [/…/gu, "\\ldots{}"],
]);

const GREEK_TO_LATEX: Readonly<Record<string, string>> = Object.freeze({
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "varepsilon", ζ: "zeta", η: "eta", θ: "theta",
  ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", π: "pi", ρ: "rho", σ: "sigma",
  τ: "tau", υ: "upsilon", φ: "varphi", χ: "chi", ψ: "psi", ω: "omega",
  Γ: "Gamma", Δ: "Delta", Θ: "Theta", Λ: "Lambda", Ξ: "Xi", Π: "Pi", Σ: "Sigma", Υ: "Upsilon",
  Φ: "Phi", Ψ: "Psi", Ω: "Omega",
});

export function escapeLatex(value: string): string {
  let text = value;
  for (const [pattern, replacement] of LATEX_SYMBOLS) {
    if (replacement === "") continue;
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/[α-ωΑ-Ω]/gu, (letter) => {
    const name = GREEK_TO_LATEX[letter];
    return name ? `$\\${name}$` : letter;
  });
  // The escapes below must run last: the replacements above deliberately emit backslashes and
  // dollar signs, and escaping those would print the macro instead of applying it.
  const MATH = "\u0000MATH\u0000";
  const segments: string[] = [];
  // An exponent written with a caret is an exponent, not a literal caret.
  //
  // Unit and quantity strings arrive from the analyses as plain text -- `angstrom^3`, `g/cm^3`,
  // `10^-3` -- and escaping the caret printed them in the paper as `angstrom\textasciicircum{}3`,
  // which sets as `angstrom^3` on the page. The charts already rendered these as superscripts, so
  // the table and the figure beside it disagreed about the same unit. A caret followed by an
  // optional sign and digits is the only form these strings use, and it means one thing.
  text = scienceTextSegments(text).map((segment) => (segment.superscript ? `$^{${segment.text}}$` : segment.text)).join("");
  text = text.replace(/\$[^$]*\$|\\[A-Za-z]+\{\}/gu, (macro) => { segments.push(macro); return MATH; });
  const escaped = text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/</g, "\\textless{}")
    .replace(/>/g, "\\textgreater{}")
    .replace(/"/g, "''");
  let index = 0;
  return escaped.replace(new RegExp(MATH, "gu"), () => segments[index++] ?? "");
}
