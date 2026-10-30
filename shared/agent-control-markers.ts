/**
 * Two plain-text markers the host asks a model to emit, and how they are read.
 *
 * - `[quiet]`: a host-started One review or check-in with nothing for the owner (shared/one-supervisor.ts).
 * - `NEEDS-INPUT:`: an unattended run that needs a person (runtime/runner.ts UNATTENDED_NO_ASK_DIRECTIVE).
 *
 * Codex-family models put a one-line progress preamble ("기존 실행과 Studio의 영상 상태를 확인하겠습니다.") in front
 * of their final text. Observed in 1.3.105: 95 of 96 quiet One reviews ended "preamble\n\n[quiet]" and
 * 38 unattended answers read "preamble NEEDS-INPUT: …". Exact-whole-text and must-lead matching missed both, so the
 * owner saw the raw markers every 15 minutes and the automation was judged "completed" instead of "needs input".
 * A marker is read where the model actually puts it; it is never shown.
 */

const PERSONA = String.raw`(?:(?:\*\*)?\[Hope\](?:\*\*)?\s*)?`;
// At a line start, or right after the sentence that ends a preamble on the same line ("…확인하겠습니다. NEEDS-INPUT: …").
const MARKER_START = String.raw`(?:^|(?<=[.!?。…])[ \t]+)`;
const NEEDS_INPUT_LINE = new RegExp(String.raw`${MARKER_START}[ \t]*${PERSONA}NEEDS-INPUT:[ \t]*`, "mu");
const NEEDS_INPUT_LINES = new RegExp(String.raw`${MARKER_START}([ \t]*)${PERSONA}NEEDS-INPUT:[ \t]*`, "gmu");
const QUIET_TAIL = /(?:^|\s)\[quiet\][ \t]*\.?\s*$/iu;
const QUIET_TOKEN = /[ \t]*\[quiet\][ \t]*\.?/giu;

/** The model chose to stay quiet: its reply ends with the marker, whatever preamble came before it. */
export function endsWithQuietMarker(text: string): boolean {
  return QUIET_TAIL.test(text);
}

/** The unattended question after `NEEDS-INPUT:` when the marker starts a line or follows a finished sentence, else null. */
export function needsInputQuestion(text: string): string | null {
  const match = NEEDS_INPUT_LINE.exec(text);
  if (!match) return null;
  return text.slice(match.index + match[0].length).trim();
}

/** Owner-facing text: the markers removed, the words around them kept. Idempotent. */
export function stripAgentControlMarkers(text: string): string {
  if (!/\[quiet\]/iu.test(text) && !text.includes("NEEDS-INPUT:")) return text;
  return text
    .replace(NEEDS_INPUT_LINES, (_match, indent: string, offset: number, whole: string) =>
      offset === 0 || whole[offset - 1] === "\n" ? indent : " ")
    .replace(QUIET_TOKEN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
