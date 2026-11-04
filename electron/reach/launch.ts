// Opening an app that is not open yet, for the callers whose job is "use this app" (the computer tool focus_app, Reach's invoke / explore / verify).
// observed in use/04: "open Calculator and enter 7+8" ended in "No running application matched" and "Reach only drives an app that is already
// running" because nothing in the tool set could open an app. This is that one missing step: argv only (no shell), no electron import (the daemon loads it).
import type { ExecFn } from "./types";

export interface LaunchTarget { key?: string; name?: string; bundleId?: string; path?: string }
export interface LaunchPlan { file: string; args: string[] }

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/;
const SAFE_NAME = /^[^\u0000-\u001f/\\-][^\u0000-\u001f/\\]{0,159}$/u;

/** How to open the app on this platform, or null when it cannot be opened from what is known (no id, no name). */
export function launchPlan(target: LaunchTarget, platform: NodeJS.Platform = process.platform): LaunchPlan | null {
  if (platform === "darwin") {
    const bundle = target.bundleId ?? (target.key?.startsWith("bundle:") ? target.key.slice("bundle:".length).split("@")[0] : undefined);
    // -g: do not take the screen from the owner; the caller brings the app forward itself when it must.
    if (bundle && BUNDLE_ID.test(bundle)) return { file: "/usr/bin/open", args: ["-g", "-b", bundle] };
    if (target.path && /^\/.+\.app\/?$/.test(target.path) && !/[\u0000-\u001f]/.test(target.path)) return { file: "/usr/bin/open", args: ["-g", target.path] };
    if (target.name && SAFE_NAME.test(target.name) && !/^pid:/i.test(target.name)) return { file: "/usr/bin/open", args: ["-g", "-a", target.name] };
    return null;
  }
  if (platform === "win32") {
    const aumid = target.key?.startsWith("aumid:") ? target.key.slice("aumid:".length) : undefined;
    return aumid && /^[A-Za-z0-9][A-Za-z0-9._!-]{0,255}$/.test(aumid) ? { file: "explorer.exe", args: [`shell:AppsFolder\\${aumid}`] } : null;
  }
  if (platform === "linux") {
    const id = target.key?.startsWith("desktop:") ? target.key.slice("desktop:".length).replace(/\.desktop$/, "") : undefined;
    return id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(id) ? { file: "gtk-launch", args: [id] } : null;
  }
  return null;
}

/** Asks the OS to open the app. True when the OS accepted the request (the app may still be starting: the caller waits for it). */
export async function launchApp(exec: ExecFn, target: LaunchTarget, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const plan = launchPlan(target, platform);
  if (!plan) return false;
  try {
    const result = await exec(plan.file, plan.args, { timeoutMs: 8_000, maxBytes: 64 * 1024 });
    // explorer.exe answers 1 for a successful shell: launch; a timeout is the only failure it reports.
    return platform === "win32" ? !result.timedOut : result.code === 0 && !result.timedOut;
  } catch { return false; }
}

/** Polls until `check` holds or the time is spent; `sleep` is injectable so a gate runs instantly. */
export async function waitUntil(check: () => Promise<boolean>, options: { withinMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {}): Promise<boolean> {
  const within = options.withinMs ?? 6_000, every = options.everyMs ?? 300;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; ; waited += every) {
    if (options.signal?.aborted) return false;
    if (await check()) return true;
    if (waited >= within) return false;
    await sleep(every);
  }
}
