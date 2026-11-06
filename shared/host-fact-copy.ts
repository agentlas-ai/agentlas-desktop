/*
 * One sentence shape for what the host tells the owner when it could not finish something by itself:
 *   "{what} {times} - {one-line cause}. {what the host does next}"
 * The host never hands work back with a request ("send it again", "press run"): a request is only for a boundary
 * only the owner can cross, and then `next` names that exact action and `ownerBoundary` says so. Pure, no Electron.
 */
export type HostFactLocale = "ko" | "en";
export type HostFactPart = string | { ko: string; en: string };

export interface HostFactInput {
  what: HostFactPart;
  /** How many times the host already tried. Omitted when the count is not part of the fact. */
  times?: number;
  cause: HostFactPart;
  /** What the host itself does next (or, with ownerBoundary, the exact action only the owner can take). */
  next: HostFactPart;
  /** True only when `next` is an action no host can take (sign-in, payment, consent). */
  ownerBoundary?: boolean;
}

/** Phrases that hand a retry back to the owner. A non-boundary sentence may not contain them. */
export const HOST_HAND_BACK_RE = /다시\s*(?:보내|실행해|눌러|시도해\s*주|시도해\s*보세요)|실행해\s*주세요|눌러\s*주세요|send (?:it|this) again|try again|please (?:re-?send|re-?run|press)/i;

const L = (locale: HostFactLocale, part: HostFactPart): string => (typeof part === "string" ? part : part[locale]).trim().replace(/[.。]+$/, "");

export function hostFactLine(input: HostFactInput, locale: HostFactLocale): string {
  const loc: HostFactLocale = locale === "ko" ? "ko" : "en";
  const times = Number.isSafeInteger(input.times) && input.times! > 0
    ? (loc === "ko" ? ` ${input.times}번` : ` ${input.times} time${input.times === 1 ? "" : "s"}`) : "";
  const next = L(loc, input.next);
  // A hand-back is only legal at an owner boundary; otherwise the clause is dropped rather than shown.
  const showNext = input.ownerBoundary === true || !HOST_HAND_BACK_RE.test(next);
  const head = `${L(loc, input.what)}${times} - ${L(loc, input.cause)}.`;
  return showNext && next ? `${head} ${next}.` : head;
}
