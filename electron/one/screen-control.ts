/*
 * Is something operating Agentlas's own window right now? (Agentlas 2.0 O-M3a, contracts/one-home-desktop.md §5.2)
 *
 * The QR on the settings screen is the only proof that a phone was paired by the person at this computer. A program that can click
 * that window and read it back (computer use, a phone's visual session) could pair a phone of its own. So the pairing record notes
 * whether such a thing was alive when the QR was made or used (`pairedVia`, mobile-bridge/pairing.ts), and the owner's "trust this
 * phone" press is refused while one is alive.
 *
 * Memory only: two timestamps. Nothing is stored, nothing is sent. Read by pairing.ts (challenge issue + exchange) and one/home.ts
 * (trustPhone); gone with the process. After a restart it answers "not active": every request that could influence a challenge
 * is made after the challenge and therefore after the restart, so it is written here again (§5.2 "앱을 다시 켠 직후").
 * Known limits (reported, not closed): a shell of the same user on this computer drives the OS directly, and can also edit `devices.json`
 * (`pairedVia`) or read the key file without operating the screen at all; the Work live view / embedded browser only reach guest pages
 * (work-live-view.ts registeredGuest) and cannot reach the settings window.
 * Reads count too (F5): a capture of the screen or of Agentlas's own window cannot click, but it can read a QR the owner put up. Captures do not
 * make the 15-minute "active" window; a pairing record asks "was there a capture between the QR and its use" (screenCaptureSince).
 */

export type ScreenControlVia = "computer-use" | "window-scope" | "phone-visual";
/** What can be noted. "capture" is a READ of the screen or of Agentlas's own window (the personal agent's context capture, the renderer's self-capture). */
export type ScreenControlNote = "computer-use" | "phone-visual" | "capture";

/** Same value as COMPUTER_USE_SCOPE_MAX_MS (computer-use/window-scope.ts): the longest a window-scope grant lives. Not a new number. */
export const SCREEN_CONTROL_WINDOW_MS = 15 * 60_000;

let lastComputerUse = 0;
let lastPhoneVisual = 0;
let lastCapture = 0;

export function noteScreenControl(via: ScreenControlNote, now: number = Date.now()): void {
  if (via === "computer-use") lastComputerUse = now;
  else if (via === "phone-visual") lastPhoneVisual = now;
  else lastCapture = now;
}

/** Was the screen or Agentlas's window captured at or after `since` (ms)? Used by a pairing record between its QR and its exchange. */
export function screenCaptureSince(since: number): boolean { return lastCapture !== 0 && lastCapture >= since; }

export function screenControlActive(now: number = Date.now()): { active: boolean; via?: ScreenControlVia } {
  if (lastComputerUse && now - lastComputerUse < SCREEN_CONTROL_WINDOW_MS) return { active: true, via: "computer-use" };
  if (lastPhoneVisual && now - lastPhoneVisual < SCREEN_CONTROL_WINDOW_MS) return { active: true, via: "phone-visual" };
  try {
    // A process without the computer-use server (the background service) has no scope grants: the require simply finds none.
    const scope = (require("../computer-use/window-scope") as typeof import("../computer-use/window-scope")).activeComputerUseWindowScope(now);
    if (scope) return { active: true, via: "window-scope" };
  } catch { /* no window-scope module in this process: nothing to see */ }
  return { active: false };
}

/** Test hook: forget the notes (a fresh process). */
export function resetScreenControlForTests(): void { lastComputerUse = 0; lastPhoneVisual = 0; lastCapture = 0; }
