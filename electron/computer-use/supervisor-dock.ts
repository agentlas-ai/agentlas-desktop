import type { NativeInputAction, NativeInputResult } from "./native-driver";
import { planSupervisorRightDock, supervisorDockName, type DockRect } from "./supervisor-dock-layout";

/*
 * Supervisor right-dock controller (owner reference promo, 2026-10-16).
 *
 * When a SUPERVISOR-run computer-use execution (Hope operating another app) starts acting on an app, this
 *   1. docks the One window to the right edge of that app's display and fits the app into the area to its left,
 *   2. shows a click-through "<name> is working" badge on the app's top-right, which turns to "Done" and hides,
 *   3. labels the pointer the driver moves with the agent name.
 *
 * Hooks (Main process only; nothing here imports Electron or the native driver, so the background service can load this
 * file, see scripts/test-daemon-loads-without-electron.cjs; the real ports are installed by supervisor-dock-main.ts):
 *   start/step  electron/computer-use/control-server.ts   runAction (after the focus pre-step) and observeApp
 *   pointer     control-server.ts runAction, the same screen point the input driver is given
 *   end         electron/one/context-lease.ts dispose -> OneOsLeasePorts.executionEnded (electron/one/context-platform.ts)
 *
 * Windows stay where the layout put them when the work ends. Restoring would have to put a window back to a frame the
 * owner has since looked at, resized or moved themselves, and the work product (the sheet, the deck) is what the owner
 * reads next; a restore would yank it again. The layout is applied once per run and app, so a window the owner drags
 * during the run is not pulled back.
 */

export interface DockOneWindow { visible: boolean; fullScreen: boolean; bounds: DockRect; setBounds(bounds: DockRect): void }
export type DockBadgeState = "working" | "done";
export interface DockPorts {
  platform: NodeJS.Platform;
  selfPid: number;
  driver(request: NativeInputAction): Promise<NativeInputResult>;
  /** Work area of the display that holds (most of) this rectangle, DIP. */
  workAreaFor(rect: DockRect): DockRect | null;
  oneWindow(): DockOneWindow | null;
  agentName(): string;
  locale(): "ko" | "en";
  overlay: {
    badge(target: DockRect, state: DockBadgeState, name: string, locale: "ko" | "en"): void;
    cursor(point: { x: number; y: number }, name: string): void;
    hide(): void;
  };
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
export interface DockBeginInput { runId: string; app: string; hasContextGrant: boolean }
export interface DockBeginOutcome {
  /** True when the operated app was moved or resized: earlier screen captures no longer match the screen. */
  layoutChanged: boolean;
  docked: boolean;
  reason?: string;
}

/** A run that stops acting without its execution being disposed (crash, hung model) still ends the badge. */
export const DOCK_IDLE_DONE_MS = 15_000;
export const DOCK_DONE_VISIBLE_MS = 2_500;

function frameOf(result: NativeInputResult): (DockRect & { pid: number; fullScreen: boolean; minimized: boolean }) | null {
  const f = result.frame as DockRect | undefined;
  if (!result.ok || !f || ![f.x, f.y, f.width, f.height].every(Number.isFinite) || typeof result.pid !== "number") return null;
  return { x: f.x, y: f.y, width: f.width, height: f.height, pid: result.pid, fullScreen: result.fullScreen === true, minimized: result.minimized === true };
}

export class SupervisorDock {
  private docked = new Map<string, Set<number>>();
  private active: { runId: string; frame: DockRect; done: boolean } | null = null;
  private idleTimer: unknown = null;
  private hideTimer: unknown = null;
  constructor(private readonly ports: DockPorts) {}

  private clearTimers(): void {
    if (this.idleTimer !== null) { this.ports.clearTimer(this.idleTimer); this.idleTimer = null; }
    if (this.hideTimer !== null) { this.ports.clearTimer(this.hideTimer); this.hideTimer = null; }
  }
  private armIdle(): void {
    if (this.idleTimer !== null) this.ports.clearTimer(this.idleTimer);
    this.idleTimer = this.ports.setTimer(() => { this.idleTimer = null; this.finish(); }, DOCK_IDLE_DONE_MS);
  }
  private finish(): void {
    const active = this.active;
    if (!active || active.done) return;
    active.done = true;
    this.clearTimers();
    try { this.ports.overlay.badge(active.frame, "done", supervisorDockName(this.ports.agentName()), this.ports.locale()); } catch { /* cosmetic */ }
    this.hideTimer = this.ports.setTimer(() => { this.hideTimer = null; this.active = null; try { this.ports.overlay.hide(); } catch { /* cosmetic */ } }, DOCK_DONE_VISIBLE_MS);
  }

  /** The run is about to act on `app`: lay the windows out (once per run and app) and show the working badge. Never throws. */
  async begin(input: DockBeginInput): Promise<DockBeginOutcome> {
    const none = (reason: string): DockBeginOutcome => ({ layoutChanged: false, docked: false, reason });
    try {
      const { ports } = this;
      if (ports.platform !== "darwin") return none("platform-unsupported");
      const read = await ports.driver({ action: "windowFrame", app: input.app });
      const frame = frameOf(read);
      if (!frame) return none("window-unavailable");
      if (frame.pid === ports.selfPid) return none("own-window");
      const name = supervisorDockName(ports.agentName());
      const shown = (target: DockRect) => {
        // A new run, or a new app, takes the badge over from the previous one.
        if (this.active && this.active.runId !== input.runId) this.clearTimers();
        this.active = { runId: input.runId, frame: target, done: false };
        if (this.hideTimer !== null) { ports.clearTimer(this.hideTimer); this.hideTimer = null; }
        ports.overlay.badge(target, "working", name, ports.locale());
        this.armIdle();
      };
      const done = this.docked.get(input.runId) ?? new Set<number>();
      const one = ports.oneWindow();
      const workArea = ports.workAreaFor(frame);
      // The owner picked the exact window (context grant) or has already seen this layout, or there is no panel to
      // dock beside, or the app is full screen or minimized: leave every window alone, still show the badge.
      if (input.hasContextGrant || done.has(frame.pid) || !one || !one.visible || one.fullScreen || !workArea || frame.fullScreen || frame.minimized) {
        shown(frame);
        return none(input.hasContextGrant ? "context-grant" : done.has(frame.pid) ? "already-docked" : "not-dockable");
      }
      const plan = planSupervisorRightDock({ workArea, target: frame, currentOne: one.bounds });
      if (!plan.ok) { shown(frame); return none(plan.reason); }
      done.add(frame.pid); this.docked.set(input.runId, done);
      if (plan.oneChanged) {
        one.setBounds(plan.one);
        // Electron applies the first setBounds across displays at the old scale factor; the second one settles it.
        if (!(Math.abs(one.bounds.x - plan.one.x) <= 2)) one.setBounds(plan.one);
      }
      let finalFrame: DockRect = frame, changed = false;
      if (plan.targetChanged) {
        const set = await ports.driver({ action: "setWindowFrame", app: `pid:${frame.pid}`, ...plan.target });
        const applied = frameOf(set);
        if (applied) {
          finalFrame = applied;
          changed = Math.abs(applied.x - frame.x) > 2 || Math.abs(applied.y - frame.y) > 2 || Math.abs(applied.width - frame.width) > 2 || Math.abs(applied.height - frame.height) > 2;
        }
      }
      shown(finalFrame);
      return { layoutChanged: changed, docked: true };
    } catch (error) {
      return none(error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "dock-failed");
    }
  }

  /** The screen point the driver is about to press or move to (frame already mapped to screen coordinates). */
  pointer(point: { x: number; y: number }): void {
    try {
      if (!this.active || this.active.done) return;
      this.ports.overlay.cursor(point, supervisorDockName(this.ports.agentName()));
      this.armIdle();
    } catch { /* cosmetic */ }
  }
  /** An action of the run completed: the run is still working, push the idle fallback back. */
  step(): void { try { if (this.active && !this.active.done) this.armIdle(); } catch { /* cosmetic */ } }
  /** The run's execution was disposed (finished, cancelled or revoked). */
  executionEnded(runId: string): void {
    this.docked.delete(runId);
    if (this.active?.runId === runId) this.finish();
  }
  /** App quit or test teardown. */
  dispose(): void { this.clearTimers(); this.active = null; this.docked.clear(); try { this.ports.overlay.hide(); } catch { /* cosmetic */ } }
}

let dock: SupervisorDock | null = null;
/** Installed once from main.ts. Without it (background service, tests) every hook is a no-op. */
export function configureSupervisorDock(value: SupervisorDock | null): void { dock?.dispose(); dock = value; }
export function supervisorDock(): SupervisorDock | null { return dock; }

// Overlay windows (badge, pointer label) are Agentlas windows the owner never opened. The context picker lists visible
// BrowserWindows as "owned" targets, so it asks here which ones to skip.
const overlayWindowIds = new Set<number>();
export function registerSupervisorDockOverlayWindow(id: number): () => void { overlayWindowIds.add(id); return () => { overlayWindowIds.delete(id); }; }
export function isSupervisorDockOverlayWindow(id: number): boolean { return overlayWindowIds.has(id); }
