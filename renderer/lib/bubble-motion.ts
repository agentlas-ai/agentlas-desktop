// The one motion a new message bubble makes: the whole list rises into place, ending slow (easeOutCubic, 400 ms).
// The bubble itself is only inserted; moving the list instead of scrolling it step by step keeps one direction, never
// fights the browser's own scroll, and works the same when the list is shorter than the window.

/** Same value as the CSS fade on a new bubble (PersonalOneWorkspace.module.css). */
export const BUBBLE_MOTION_MS = 400;
/** easeOutCubic. */
export const BUBBLE_EASING = "cubic-bezier(.215,.61,.355,1)";

/** How far an element is moved down by a transform right now (0 when it has none). */
export function currentOffsetY(element: Element): number {
  try {
    const value = getComputedStyle(element).transform;
    if (!value || value === "none") return 0;
    return new DOMMatrixReadOnly(value).m42;
  } catch {
    return 0;
  }
}

/** Smaller shifts are a bubble taking the place of the dots (about the same height): it only fades in, the list does not move. */
export const BUBBLE_MIN_RISE_PX = 8;

/**
 * Start `element` fromPx lower than it is and bring it to where it is. Returns the animation (so it can be cancelled), or
 * null when there is nothing to move (a shift under BUBBLE_MIN_RISE_PX, or one that would move the list down: the list only
 * ever moves one way) or the browser cannot animate.
 */
export function riseInto(element: HTMLElement, fromPx: number, durationMs: number = BUBBLE_MOTION_MS): Animation | null {
  if (!(fromPx >= BUBBLE_MIN_RISE_PX) || typeof element.animate !== "function") return null;
  return element.animate([{ transform: `translateY(${fromPx}px)` }, { transform: "translateY(0)" }],
    { duration: durationMs, easing: BUBBLE_EASING, fill: "none" });
}
