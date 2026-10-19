
























/** Bump whenever the coefficients below change; recorded in every model-call ledger event (G15). */
export const TOKEN_ESTIMATE_REVISION = "o200k-linear-2026-10-11";

const W = 1.0, LX = 0.19, D = 0.45, P = 0.46, N = 2.0, H = 0.87, C = 0.75, K = 0.8, OL = 0.3, OS = 0.55, E = 2.5;

/** Best estimate of o200k_base tokens (unbiased; see the calibration record). */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let words = 0, longExtra = 0, digits = 0, punct = 0, newlines = 0;
  let hangul = 0, cjk = 0, kana = 0, otherLetters = 0, otherSymbols = 0, astral = 0;
  let inWord = false, wordLength = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      const isDigit = code >= 48 && code <= 57;
      const isWordChar = isDigit || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
      if (isWordChar) {
        if (isDigit) digits += 1;
        if (!inWord) { words += 1; inWord = true; wordLength = 0; }
        wordLength += 1;
        if (wordLength > 8) longExtra += 1;
        continue;
      }
      inWord = false;
      if (code === 10) newlines += 1;
      else if (code !== 32 && code !== 9 && code !== 13) punct += 1;
      continue;
    }
    inWord = false;
    if (code >= 0xac00 && code <= 0xd7a3) hangul += 1;
    else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk += 1;
    else if (code >= 0x3040 && code <= 0x30ff) kana += 1;
    else if (code >= 0xd800 && code <= 0xdbff) { astral += 1; i += 1; }
    else if (isBmpLetter(code)) otherLetters += 1;
    else otherSymbols += 1;
  }
  return Math.ceil(
    words * W + longExtra * LX + digits * D + punct * P + newlines * N
      + hangul * H + cjk * C + kana * K + otherLetters * OL + otherSymbols * OS + astral * E,
  );
}

/** Latin-1 supplement / extended Latin, Greek, Cyrillic, Hebrew, Arabic, Indic, Thai letters. */
function isBmpLetter(code: number): boolean {
  if (code >= 0x00c0 && code <= 0x024f) return code !== 0x00d7 && code !== 0x00f7;
  return (code >= 0x0370 && code <= 0x03ff) || (code >= 0x0400 && code <= 0x052f)
    || (code >= 0x0590 && code <= 0x06ff) || (code >= 0x0900 && code <= 0x0dff) || (code >= 0x0e00 && code <= 0x0e7f)
    || (code >= 0x1e00 && code <= 0x1fff);
}

/** Admission margin: the model's own tokenizer (Claude, Llama, Qwen, gpt-oss) differs from o200k_base by
 * roughly +-10-15% on code and prose, and refusing a turn that fits costs more than a 12% over-count. */
export const ADMISSION_TOKEN_MARGIN = 1.12;

/** Conservative estimate for admission checks: the best estimate plus the cross-tokenizer margin. */
export function estimateAdmissionTokens(text: string): number {
  return Math.ceil(estimateTextTokens(text) * ADMISSION_TOKEN_MARGIN);
}
