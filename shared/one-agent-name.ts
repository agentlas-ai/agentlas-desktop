/**
 * The personal agent's name as the server counts it (web companion-prompt.mjs `readName`, COMPANION_PROMPT_LIMITS.nameMaxChars): the server cleans a name
 * (control and line characters become a space, format characters and lone surrogates go, runs of space collapse, the ends are trimmed) and takes 1..12
 * code points. A profile with a longer name is refused (`invalid`), so it never reaches the server and the server cannot answer for this desktop.
 * One place for the number and the counting: the store (a changed name), the inputs (a name being typed) and the mirror (what goes up) all read it here.
 * 12 is the server's own value, not a new one.
 */
export const ONE_NAME_SERVER_MAX = 12;

const LINE_BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const INVISIBLE = /[\p{Cf}\p{Cs}]/gu;

/** The name the way the server reads it. */
export function serverNameOf(name: string): string {
  return name.slice(0, 2000).replace(LINE_BREAKS, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

/** Does the server take this name (counted in code points after cleaning)? */
export function nameFitsServer(name: string): boolean {
  return Array.from(serverNameOf(name)).length <= ONE_NAME_SERVER_MAX;
}

/**
 * The name that goes UP. A name the server takes goes as it is; a longer one goes as its first 12 code points (a stand-in: it is sent, never written
 * back as the owner's name, home-mirror-real.ts `planPhoneProfile`).
 */
export function serverNameUp(name: string): string {
  if (nameFitsServer(name)) return name;
  return Array.from(serverNameOf(name)).slice(0, ONE_NAME_SERVER_MAX).join("").trim();
}

/**
 * What a name field holds after a keystroke. A name may shrink freely (an old name over the limit is shortened by deleting); it may not grow past the
 * limit: typed or pasted text is cut at 12 code points when the field was within the limit, and a field already over the limit takes no growth.
 */
export function nextNameInput(previous: string, typed: string): string {
  if (nameFitsServer(typed) || Array.from(typed).length <= Array.from(previous).length) return typed;
  if (!nameFitsServer(previous)) return previous;
  return Array.from(typed).slice(0, ONE_NAME_SERVER_MAX).join("");
}

/** A name being saved: unchanged is always allowed (an old long name stays until the owner edits it); a changed one must fit. */
export function nameSaveAllowed(next: string, current: string): boolean {
  return next === current || nameFitsServer(next);
}
