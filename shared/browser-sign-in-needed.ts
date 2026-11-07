/**
 * A sign-in only the owner can do, met inside the owner's own One conversation turn.
 *
 * A Work, an automation or a Goal pass waits for the sign-in and continues by itself (electron/browser/login-prerequisite.ts).
 * A One conversation turn is the owner's answer: since the One has a browser in conversation, that same wait
 * ended every reply that touched a site needing sign-in as an "interrupted answer", and each next message did it again — from
 * the phone the One looked dead. Here the turn goes on: the browser call's result tells the model which site needs the owner and
 * where, and the model answers. The sign-in window the recovery opened stays open; nothing waits on it.
 */
export const BROWSER_SIGN_IN_NEEDED = "browser_sign_in_needed";

export interface BrowserSignInNeeded extends Error { readonly code: typeof BROWSER_SIGN_IN_NEEDED; readonly site: string }

export function browserSignInNeeded(site: string): BrowserSignInNeeded {
  return Object.assign(new Error(BROWSER_SIGN_IN_NEEDED), { code: BROWSER_SIGN_IN_NEEDED, site }) as BrowserSignInNeeded;
}

export function isBrowserSignInNeeded(error: unknown): error is BrowserSignInNeeded {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === BROWSER_SIGN_IN_NEEDED
    && typeof (error as { site?: unknown }).site === "string";
}

/** The tool result the model reads instead of the page. Typed facts only: the site comes from the browser's recovery, not text. */
export function browserSignInNeededResult(site: string): string {
  return `SIGN_IN_NEEDED: ${site} is not signed in, and only the owner can sign in. The owner was notified on the computer that ${site} needs a sign-in.`
    + ` Do not stop here and do not end with only a status: in this answer, ask the owner how to go on, with choices, the way this turn asks the`
    + ` owner a question — for example "I signed in to ${site} on the computer" (then you continue) or "go on without ${site}".`
    + ` Do not open ${site} again in this turn; once the owner says they signed in, try again.`;
}
