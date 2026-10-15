/*
 * Supervisor right-dock layout: the pure geometry. No Electron, no driver, so the background service can load it and
 * scripts/test-supervisor-right-dock.cjs can run it on any machine.
 *
 * Owner reference (promo, 2026-10-16): while Hope works in another app, Hope's chat is a narrow panel docked to the
 * RIGHT edge of the screen at full height and the operated app fills the area to its left. All values are DIP, the unit
 * of Electron's screen.getDisplayMatching().workArea and BrowserWindow bounds (never multiply by scaleFactor, see
 * clampOneWindowBounds in electron/one-window-manager.ts). On macOS the Accessibility frame of another app's window is
 * in the same top-left-origin point space, so one rectangle serves both sides.
 */
export interface DockRect { x: number; y: number; width: number; height: number }

/** Mirrors ONE_WINDOW_MIN_WIDTH / ONE_WINDOW_MIN_HEIGHT; scripts/test-supervisor-right-dock.cjs asserts they are equal. */
export const SUPERVISOR_DOCK_ONE_MIN_WIDTH = 380;
export const SUPERVISOR_DOCK_ONE_MIN_HEIGHT = 560;
export const SUPERVISOR_DOCK_ONE_MAX_WIDTH = 440;
/** Below this the operated app would be unusable beside the panel; the layout is skipped and the windows stay put. */
export const SUPERVISOR_DOCK_TARGET_MIN_WIDTH = 360;
export const SUPERVISOR_DOCK_MIN_HEIGHT = 360;
/** Panel share of a wide display before the 380-440 clamp. */
const PANEL_SHARE = 0.27;

export type SupervisorDockPlan =
  | { ok: true; one: DockRect; target: DockRect; oneWidth: number; oneChanged: boolean; targetChanged: boolean }
  | { ok: false; reason: "invalid-input" | "display-too-small" };

function validRect(value: unknown): value is DockRect {
  const v = value as DockRect | null;
  return !!v && [v.x, v.y, v.width, v.height].every(Number.isFinite) && v.width > 0 && v.height > 0;
}
function sameRect(a: DockRect | undefined, b: DockRect): boolean {
  return !!a && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
}

/**
 * workArea: the work area (menu bar and Dock already excluded) of the display that holds the target window.
 * target: the operated window's current frame. It is validated and compared, never used to shrink the plan: the
 * operated app always gets the whole left area, which is what the reference shows.
 * currentOne: the One window's current bounds, used only to report whether anything has to move.
 */
export function planSupervisorRightDock(input: { workArea: DockRect; target: DockRect; currentOne?: DockRect }): SupervisorDockPlan {
  const { workArea, target, currentOne } = input;
  if (!validRect(workArea) || !validRect(target)) return { ok: false, reason: "invalid-input" };
  if (workArea.height < SUPERVISOR_DOCK_MIN_HEIGHT) return { ok: false, reason: "display-too-small" };
  const share = Math.round(workArea.width * PANEL_SHARE);
  let oneWidth = Math.min(SUPERVISOR_DOCK_ONE_MAX_WIDTH, Math.max(SUPERVISOR_DOCK_ONE_MIN_WIDTH, share));
  if (workArea.width - oneWidth < SUPERVISOR_DOCK_TARGET_MIN_WIDTH) oneWidth = SUPERVISOR_DOCK_ONE_MIN_WIDTH;
  if (workArea.width - oneWidth < SUPERVISOR_DOCK_TARGET_MIN_WIDTH) return { ok: false, reason: "display-too-small" };
  const left = Math.round(workArea.x), top = Math.round(workArea.y);
  const width = Math.round(workArea.width), height = Math.round(workArea.height);
  const one: DockRect = { x: left + width - oneWidth, y: top, width: oneWidth, height };
  const next: DockRect = { x: left, y: top, width: width - oneWidth, height };
  return { ok: true, one, target: next, oneWidth, oneChanged: !sameRect(currentOne, one), targetChanged: !sameRect(target, next) };
}

/** Anchor of the "working" badge: inside the target window's top-right corner, clear of the traffic lights on the left. */
export function supervisorBadgeBounds(target: DockRect, badge: { width: number; height: number }, workArea?: DockRect): DockRect {
  const width = Math.round(badge.width), height = Math.round(badge.height);
  let x = Math.round(target.x + target.width - width - 12);
  let y = Math.round(target.y + 8);
  if (workArea) {
    x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
    y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));
  }
  return { x, y, width, height };
}

/** Pill width for a label: a fixed icon area plus an estimated glyph advance (CJK glyphs are wider). */
export function supervisorBadgeWidth(label: string): number {
  let advance = 0;
  for (const ch of label) advance += /[ᄀ-ᇿ㄰-㆏가-힯぀-ヿ一-鿿]/u.test(ch) ? 12 : 7;
  return Math.max(84, Math.min(240, Math.round(36 + advance)));
}

/** Cursor label offset: below-right of the pointer tip so it never covers the target of the click. */
export function supervisorCursorLabelBounds(point: { x: number; y: number }, size: { width: number; height: number }, workArea?: DockRect): DockRect {
  let x = Math.round(point.x + 14), y = Math.round(point.y + 18);
  if (workArea) {
    if (x + size.width > workArea.x + workArea.width) x = Math.round(point.x - 6 - size.width);
    if (y + size.height > workArea.y + workArea.height) y = Math.round(point.y - 8 - size.height);
    x = Math.max(workArea.x, x); y = Math.max(workArea.y, y);
  }
  return { x, y, width: Math.round(size.width), height: Math.round(size.height) };
}

/** Agent name in a badge or label: one short line, no markup, never empty. */
export function supervisorDockName(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return (text || "Hope").slice(0, 24);
}
export function supervisorBadgeText(name: string, state: "working" | "done", locale: "ko" | "en"): string {
  if (state === "done") return locale === "ko" ? "완료" : "Done";
  return locale === "ko" ? `${name} 작업 중` : `${name} is working`;
}
