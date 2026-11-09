/**
 * A teammate report is kept to a bound in Main. A report cut at a character can end in half a link or image, which the card showed as raw
 * markdown (a 12,000 character report ending in "[0.1초 검수 기록](</Users/...").
 */
const OPEN_LINK_AT_END = /!?\[[^\]\n]*(?:\]\([^)\n]*)?$/;

/** Drops a link or image the text ends in the middle of. A finished link stays. */
export function withoutCutLink(text: string): string {
  return text.replace(OPEN_LINK_AT_END, "").trimEnd();
}
