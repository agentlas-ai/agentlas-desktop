import type { Actuator, ToolOutcome } from "./actuator";
import type { MenuTarget } from "./menu-probe";

// macOS keeps an app's menu items disabled while it is behind another window, so anything that presses a menu has to bring the app forward
// first. This does that, runs the work, and puts the owner's previous front app back, whatever the work did.

export type Foreground<T> = { ok: true; value: T } | { ok: false; code: string };

// Brings the app forward through the window that carries its menus. The driver only accepts a window that is the front one of its app, and
// some apps keep untitled helper windows above the one with the menu bar (measured on Chess: three windows, the game window lowest, so the
// request for it was refused with front_in_process_on_display=false). The app is then brought forward through its front window instead:
// it is the same app, and the menus are still read from the window that has them.
export async function bringAppForward(actuator: Actuator, target: MenuTarget, signal?: AbortSignal): Promise<ToolOutcome> {
  const front = await actuator.call("bring_to_front", { pid: target.pid, window_id: target.windowId }, { signal });
  if (front.ok) return front;
  const windows = await actuator.listWindows({ pid: target.pid }, { signal }).catch(() => []);
  const stacked = windows.filter((window) => window.layer === 0 && window.onScreen && typeof window.zIndex === "number") as Array<(typeof windows)[number] & { zIndex: number }>;
  const top = stacked.length > 0 ? stacked.reduce((best, window) => (window.zIndex > best.zIndex ? window : best)) : undefined;
  const second = top && top.windowId !== target.windowId ? await actuator.call("bring_to_front", { pid: target.pid, window_id: top.windowId }, { signal }) : front;
  if (second.ok) return second;
  // Chess again: its helper windows cannot take the keyboard focus and its game window is not the front one, so the driver cannot confirm
  // either. What matters here is that the app itself is the active one (the structured app list says so), which is what its menus need.
  return (await isActive(actuator, target.pid, signal)) ? { ok: true, text: "the app is already the active one" } : second;
}

async function isActive(actuator: Actuator, pid: number, signal?: AbortSignal): Promise<boolean> {
  const listing = await actuator.call("list_apps", {}, { signal }).catch(() => undefined);
  const apps = Array.isArray(listing?.structured?.apps) ? (listing?.structured?.apps as Array<{ active?: boolean; pid?: number }>) : [];
  return apps.some((app) => app.pid === pid && app.active === true);
}

export async function withForeground<T>(actuator: Actuator, target: MenuTarget, work: () => Promise<T>, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<Foreground<T>> {
  const wait = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const activeApp = async (): Promise<{ pid?: number } | undefined> => {
    const listing = await actuator.call("list_apps", {}, { signal }).catch(() => undefined);
    const apps = Array.isArray(listing?.structured?.apps) ? (listing?.structured?.apps as Array<{ active?: boolean; pid?: number }>) : [];
    return apps.find((app) => app.active === true);
  };
  const previous = await activeApp();
  // The driver brings an app forward by its pid only when the app has a single top-level window; for the others it refuses
  // ("ambiguous_window_target", measured with Google Chrome). So the owner's front window is noted now and named when it is put back.
  let previousWindow: number | undefined;
  if (previous?.pid && previous.pid !== target.pid) {
    const windows = await actuator.listWindows({ pid: previous.pid }, { signal }).catch(() => []);
    const onScreen = windows.filter((window) => window.layer === 0 && window.onScreen);
    const stacked = onScreen.filter((window) => typeof window.zIndex === "number") as Array<(typeof onScreen)[number] & { zIndex: number }>;
    previousWindow = (stacked.length > 0 ? stacked.reduce((best, window) => (window.zIndex > best.zIndex ? window : best)) : onScreen[0])?.windowId;
  }
  const front = await bringAppForward(actuator, target, signal);
  if (!front.ok) return { ok: false, code: front.refusalCode ?? front.errorCode ?? "not_in_foreground" };
  try {
    // An app that has just been brought forward validates its menus a moment later: read right away and the items that depend on the
    // app's state are missing or switched off (measured on System Information: complete after ~500 ms, nothing at 0 ms).
    await wait(900);
    return { ok: true, value: await work() };
  } finally {
    // Put the owner's app back - and look again a moment later: the app being left can bring itself forward once a panel it had open
    // has finished closing (measured on System Information after a Save sheet, 2026-10-23: the first restore was undone).
    if (previous?.pid && previous.pid !== target.pid) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await actuator.call("bring_to_front", { pid: previous.pid, ...(previousWindow !== undefined ? { window_id: previousWindow } : {}) }).catch(() => undefined);
        await wait(400);
        const now = await activeApp();
        if (!now || now.pid === previous.pid) break;
      }
    }
  }
}
