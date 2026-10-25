/**
 * Composer rules that decide what typing means. Pure, so the behavior can be tested without a browser.
 *
 * Owner report 2026-10-11 (recording, room "Yotube"): while typing Korean, characters were cut off and Enter did not
 * send. Two ways the old composer could do that:
 *  - A background update (an outbox refresh, a receipt, a restore-if-empty) wrote the textarea value in the middle of an
 *    IME composition. Writing a textarea's value ends the composition in Chromium and drops the syllable being built.
 *  - "Composing" was a flag that a timer cleared after compositionend. If compositionend never reached the handler (the
 *    textarea was re-mounted mid-composition, focus moved), the flag stayed set and every later Enter was swallowed.
 */

/** Chromium sends compositionend BEFORE the Enter keydown that committed the composition. */
export const COMPOSITION_COMMIT_ENTER_WINDOW_MS = 30;

/**
 * After a Hangul commit has sent, a plain Enter keydown that follows within this window is the same keypress's echo,
 * not a new send. macOS Chromium sends it right after compositionend; the Windows Korean IME can deliver it after the
 * scheduled send already ran (slower machines, x64 emulation), which made one Enter two sends — the second, empty one
 * pauses a running task (Windows audit 2026-10-24, ui.md #11).
 */
export const COMMIT_SEND_ECHO_WINDOW_MS = 250;

export type ComposerEnterDecision = "ignore" | "swallow" | "send" | "send-after-commit";

export function decideComposerEnter(input: {
  key: string;
  shiftKey: boolean;
  /** KeyboardEvent.isComposing: the IME still holds this key. */
  isComposing: boolean;
  keyCode: number;
  /** Time since the last compositionend, null when there was none. */
  msSinceCompositionEnd: number | null;
  /**
   * The composition that just ended (or is ending) produced Hangul. Korean IMEs build one syllable at a time, so the
   * Enter that commits it is also the owner's send (owner 2026-10-13: "엔터 눌러도 안보내짐, 꼭 보내기 버튼").
   * IMEs that convert on Enter (Japanese, Chinese) keep the old rule: that Enter only confirms the conversion.
   */
  committedHangul?: boolean;
  /** Time since a Hangul commit last sent, null when none did. */
  msSinceCommitSend?: number | null;
}): ComposerEnterDecision {
  if (input.key !== "Enter" && input.keyCode !== 229) return "ignore";
  if (input.shiftKey) return "ignore";
  // The IME still owns the key: it commits the composition and the browser inserts no newline. A Hangul commit
  // is sent once the composition has ended.
  if (input.isComposing || input.keyCode === 229) return input.key === "Enter" && input.committedHangul ? "send-after-commit" : "ignore";
  // The plain Enter echo of a keypress whose Hangul commit already sent.
  if (input.msSinceCommitSend != null && input.msSinceCommitSend >= 0
    && input.msSinceCommitSend <= COMMIT_SEND_ECHO_WINDOW_MS) return "swallow";
  // The committing Enter of a composition that ended an instant ago (Chromium sends compositionend first).
  if (input.msSinceCompositionEnd !== null && input.msSinceCompositionEnd >= 0
    && input.msSinceCompositionEnd <= COMPOSITION_COMMIT_ENTER_WINDOW_MS) return input.committedHangul ? "send" : "swallow";
  return "send";
}

/** Hangul syllables and jamo: a Korean composition. */
export function isHangulComposition(text: string | null | undefined): boolean {
  return typeof text === "string" && /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/u.test(text);
}

export type ComposerWriteDecision = "skip" | "apply";

/**
 * A program (not the owner) wants to set the composer's text. It must never touch what the owner is typing:
 * identical text is not written at all, and nothing is written while an IME composition is in progress.
 */
export function decideComposerWrite(input: { current: string; next: string; composing: boolean }): ComposerWriteDecision {
  if (input.next === input.current) return "skip";
  if (input.composing) return "skip";
  return "apply";
}
