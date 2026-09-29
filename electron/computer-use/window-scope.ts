/*
 * Computer-use window scope — "our Chrome window only", enforced in Main, not in prose.
 *
 * The browser fallback ladder's rung 5 (electron/browser/fallback-ladder.ts) may hand a failing browser task to
 * computer use, but only on the dedicated Agentlas Chrome (owner rule: never the owner's personal Chrome, never
 * OS dialogs or password prompts). While such a grant is live, the computer-use control server checks every
 * request BEFORE anything is dispatched to the input driver:
 *   - app-targeted requests must name the app as "pid:<pid>" with a granted pid (no name aliasing, so a
 *     "Google Chrome" or "System Settings" target cannot slip through);
 *   - every screen point (click/move/drag ends) must lie inside a window of the granted browser, measured from
 *     that browser itself (CDP Browser.getWindowForTarget), so a click cannot land on another app's window;
 *   - point-less input (keys, typing, scroll) requires the granted app so the driver focuses it first.
 * Read-only requests (status, list apps, screen capture) are unaffected. Grants expire (bounded) and are released
 * when the ladder's run ends. The lock is global for its short life: while a grant is live, no computer-use
 * request may target anything else.
 */

export interface ScreenRect { x: number; y: number; width: number; height: number }

interface ScopeGrant { id: string; pids: ReadonlySet<number>; windows: () => Promise<ScreenRect[]>; until: number; reason: string }

const grants = new Map<string, ScopeGrant>();
let nextId = 0;

export const COMPUTER_USE_SCOPE_MAX_MS = 15 * 60_000;

export function grantComputerUseWindowScope(input: { pid: number; windows: () => Promise<ScreenRect[]>; ttlMs?: number; reason: string; now?: number }): () => void {
  if (!Number.isInteger(input.pid) || input.pid <= 1) throw new Error("computer-use-scope-pid-invalid");
  const id = `scope-${++nextId}`;
  const ttl = Math.min(Math.max(1_000, input.ttlMs ?? COMPUTER_USE_SCOPE_MAX_MS), COMPUTER_USE_SCOPE_MAX_MS);
  grants.set(id, { id, pids: new Set([input.pid]), windows: input.windows, until: (input.now ?? Date.now()) + ttl, reason: input.reason });
  return () => { grants.delete(id); };
}

export function activeComputerUseWindowScope(now = Date.now()): { pids: Set<number>; windows: () => Promise<ScreenRect[]> } | null {
  for (const [id, grant] of grants) if (grant.until <= now) grants.delete(id);
  if (!grants.size) return null;
  const pids = new Set<number>();
  const providers: Array<() => Promise<ScreenRect[]>> = [];
  for (const grant of grants.values()) { for (const pid of grant.pids) pids.add(pid); providers.push(grant.windows); }
  return { pids, windows: async () => (await Promise.all(providers.map((p) => p().catch(() => [] as ScreenRect[])))).flat() };
}

export type ScopeDenial = { ok: false; error: string; message: string };

const READ_ONLY_ACTIONS = new Set(["status", "listApps"]);
const POINT_ACTIONS = new Set(["move", "click", "drag"]);

function scopedPid(app: unknown): number | null {
  if (typeof app !== "string") return null;
  const match = /^pid:(\d{1,9})$/.exec(app.trim());
  return match ? Number(match[1]) : null;
}

function inside(point: { x: number; y: number }, rects: readonly ScreenRect[]): boolean {
  return rects.some((r) => point.x >= r.x && point.y >= r.y && point.x < r.x + r.width && point.y < r.y + r.height);
}

/**
 * null = allowed. `points` are the request's screen points AFTER frame→screen mapping (the same points the driver
 * would press). Called before any dispatch, including the control server's own focusApp pre-step.
 */
export async function checkComputerUseWindowScope(input: { route: "observe" | "action"; action?: string | null; app?: unknown; points?: ReadonlyArray<{ x: number; y: number }> }, now = Date.now()): Promise<ScopeDenial | null> {
  const scope = activeComputerUseWindowScope(now);
  if (!scope) return null;
  if (input.route === "action" && input.action && READ_ONLY_ACTIONS.has(input.action)) return null;
  const pid = scopedPid(input.app);
  if (pid === null || !scope.pids.has(pid)) {
    return { ok: false, error: "computer-use-scope-denied",
      message: `Computer use is limited to the dedicated Agentlas browser right now. Target it as app "pid:${[...scope.pids][0]}"; other apps, the owner's own Chrome, OS dialogs and password prompts are off limits.` };
  }
  if (input.route === "action" && input.action && POINT_ACTIONS.has(input.action)) {
    const points = input.points ?? [];
    const windows = await scope.windows();
    if (!points.length || !windows.length || !points.every((point) => inside(point, windows))) {
      return { ok: false, error: "computer-use-scope-outside-window",
        message: "That point is outside the dedicated Agentlas browser window. Capture the screen again and target a point inside that window." };
    }
  }
  return null;
}

/** Test seam. */
export function resetComputerUseWindowScopes(): void { grants.clear(); }
