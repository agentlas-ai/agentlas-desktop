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

/** What the owner has to do, from the recovery's typed card reason (electron/browser/login-recovery.ts OwnerLoginCard). */
export type BrowserSignInStep = "sign-in" | "approve" | "code" | "password-rejected";

export interface BrowserSignInNeeded extends Error { readonly code: typeof BROWSER_SIGN_IN_NEEDED; readonly site: string; readonly step: BrowserSignInStep }

export function browserSignInNeeded(site: string, cardReason?: string): BrowserSignInNeeded {
  const step: BrowserSignInStep = cardReason === "sign-in-approval-required" ? "approve" : cardReason === "second-factor-required" ? "code"
    : cardReason === "vault-sign-in-rejected" ? "password-rejected" : "sign-in";
  return Object.assign(new Error(BROWSER_SIGN_IN_NEEDED), { code: BROWSER_SIGN_IN_NEEDED, site, step }) as BrowserSignInNeeded;
}

const SIGN_IN_STEPS: readonly BrowserSignInStep[] = ["sign-in", "approve", "code", "password-rejected"];

/** The same fact carried across a process boundary (the local-model relay, daemon/local-model-rpc.ts): the site and the step only. */
export function browserSignInNeededFrom(value: unknown): BrowserSignInNeeded | null {
  const fact = value && typeof value === "object" ? value as { site?: unknown; step?: unknown } : null;
  if (!fact || typeof fact.site !== "string" || !fact.site || fact.site.length > 253 || /[\r\n\x00]/.test(fact.site)
    || !SIGN_IN_STEPS.includes(fact.step as BrowserSignInStep)) return null;
  return Object.assign(new Error(BROWSER_SIGN_IN_NEEDED), { code: BROWSER_SIGN_IN_NEEDED, site: fact.site, step: fact.step as BrowserSignInStep }) as BrowserSignInNeeded;
}

export function isBrowserSignInNeeded(error: unknown): error is BrowserSignInNeeded {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === BROWSER_SIGN_IN_NEEDED
    && typeof (error as { site?: unknown }).site === "string";
}

/** The tool result the model reads instead of the page. Typed facts only: the site and the step come from the browser's recovery. */
export function browserSignInNeededResult(site: string, step: BrowserSignInStep = "sign-in"): string {
  const fact = step === "approve"
    ? `SIGN_IN_NEEDED: the saved login for ${site} went in, and ${site} now waits for the owner to approve the sign-in (an approval on their phone or another device, or one more step).`
    : step === "code"
      ? `SIGN_IN_NEEDED: ${site} asks for a one-time sign-in code that only the owner has.`
      : step === "password-rejected"
        ? `SIGN_IN_NEEDED: the saved password for ${site} was not accepted, and only the owner can sign in.`
        : `SIGN_IN_NEEDED: ${site} is not signed in, and only the owner can sign in.`;
  const done = step === "approve" ? "I approved it" : step === "code" ? "I entered the code" : `I signed in to ${site} on the computer`;
  return `${fact} The owner was notified on the computer.`
    + ` Do not stop here and do not end with only a status: in this answer, tell the owner what is needed and ask how to go on, with choices,`
    + ` the way this turn asks the owner a question — for example "${done}" (then you continue) or "go on without ${site}".`
    + ` Do not open ${site} again in this turn; once the owner says it is done, try again.`;
}

/** The facts of one turn that decide who answers a sign-in only the owner can do. */
export interface SignInTurn {
  oneMode?: boolean;
  promptOrigin?: "user" | "system";
  unattended: boolean;
  hostNotice: boolean;
  /** The owner's message this run answers, as the supervisor recorded it (supervisorIngressMessage). Read only when a wall was met. */
  ownerMessageId: () => string | null;
}

/**
 * True when this turn answers the owner's own One message: the sign-in becomes the call's result and the turn goes on. Every other
 * run waits for the sign-in and resumes by itself: a Work, an automation or unattended pass, a host-started One turn (Goal resume,
 * wait follow-up, team brief or report, a review). Every runtime carries the result: the MCP proxy (CLIs), Main's own tool loop (BYOK,
 * serving, local models) and the local-model relay to the background service (agentlas-local, run.result signIn).
 * A message typed in the Desktop composer arrives as promptOrigin "user". A message sent from the phone or the personal window is
 * written into the conversation by the supervisor first and started as a "system" prompt, so the supervisor's record of that message
 * is what says it is the owner's (without it, every phone message still ended at the sign-in as an interrupted answer).
 */
export function ownerAnswersSignIn(turn: SignInTurn): boolean {
  if (turn.oneMode !== true || turn.unattended || turn.hostNotice) return false;
  return turn.promptOrigin !== "system" || turn.ownerMessageId() !== null;
}
