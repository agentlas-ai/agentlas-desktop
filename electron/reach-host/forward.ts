import type { DaemonDeviceBridge } from "../daemon/device-bridge";

/*
 * Reach in a host that has no driver (the background service) hands the work to the host that has one (the desktop's Main process).
 *
 * The background service runs One/Hope turns while the app window may be open, and it cannot drive an app's screen: the actuator manager
 * (the screen driver and its lease) lives in Main only. It used to answer `no_driver_in_this_host` with "run this from the desktop
 * app", a dead end for a run that already is the owner's request (production: every reach.invoke of a stored screen capability from a
 * daemon-served turn). The device bridge already carries an app call from the service to Main and joins a long one by repeating it
 * (app-control/pending-calls.ts), so reach.invoke travels the same way as one more kind of call; Main runs the very same handler with its
 * own runtime (driver, service, registry) and the service passes the typed answer on unchanged.
 *
 * Only reach.invoke is handed over. reach.explore and reach.verify can hold the screen for up to two minutes and must stop with the run's
 * Stop (the abort signal does not cross the bridge), so they stay in the window process. No electron import: the service loads this.
 */
export const REACH_FORWARDED_TOOLS: ReadonlySet<string> = new Set(["reach.invoke"]);

type ReachOutcome = { status: "ok"; data: unknown } | { status: "refused" | "unavailable"; reason: string; next?: string; data?: unknown };
export interface ForwardCtx { chatId: string; permission?: "read" | "write" | "full" }

/** The window process is attached right now: a handover can be answered (the sync check the capability listing uses). */
export function desktopDriverReachable(bridge?: Pick<DaemonDeviceBridge, "attached">): boolean {
  try {
    const b = bridge ?? (require("../daemon/device-bridge") as typeof import("../daemon/device-bridge")).daemonDeviceBridge();
    return b.attached === true;
  } catch { return false; }
}

export const NO_DRIVER_NEXT = "Agentlas drives an app's screen only through its app window, and that window is not connected to this run right now (the app is closed, restarting or updating). Nothing was changed. Do not call it again in this run: continue with the other tools, or tell the owner to open Agentlas and send the request again.";
export const WINDOW_ONLY_NEXT = "Exploring and re-checking an app's screen run only in the Agentlas app window, where the owner's Stop can interrupt them. Nothing was changed. reach.invoke does run from here for a capability that is already ready (reach.app with usable:true lists them); otherwise tell the owner to use Settings > Explore this desktop's apps.";

function isOutcome(value: unknown): value is ReachOutcome {
  const v = value as { status?: unknown; reason?: unknown } | null;
  return Boolean(v) && typeof v === "object" && (v!.status === "ok" || ((v!.status === "refused" || v!.status === "unavailable") && typeof v!.reason === "string"));
}

/** Service side: ask Main to run the call. Returns the typed answer, or null when this host cannot hand over (the caller then refuses plainly). */
export async function forwardReachToDesktop(tool: string, args: Record<string, unknown>, ctx: ForwardCtx, bridge?: DaemonDeviceBridge): Promise<ReachOutcome | null> {
  if (!REACH_FORWARDED_TOOLS.has(tool)) return null;
  const { daemonDeviceBridge } = await import("../daemon/device-bridge");
  const { remoteAppControlCall } = await import("../app-control/daemon-remote");
  try {
    const answer = await remoteAppControlCall({ ownerTurn: false, permission: ctx.permission ?? "read" },
      { operation: tool, args, scope: { chatId: ctx.chatId } }, bridge ?? daemonDeviceBridge());
    if ((answer as { pending?: unknown }).pending === true) {
      return { status: "unavailable", reason: "still_running", next: "Agentlas is still carrying this out in its app window. Call reach.invoke again with the same arguments to get its result; it is not started a second time." };
    }
    return isOutcome(answer) ? answer : null;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // The window answered but could not run it (Main's typed refusal or failure): say what it said, in the call's own vocabulary.
    if (typeof code === "string" && code !== "app-window-unavailable") {
      return { status: "refused", reason: "desktop_refused", next: String((error as Error).message).slice(0, 300) };
    }
    return null;
  }
}

export interface ForwardedReachInput { operation?: unknown; args?: unknown; scope?: { chatId?: unknown } }

/** Window side: run a handed-over call with this process's own runtime. null = not a handed-over reach call (the caller falls through). */
export async function runForwardedReach(input: { ownerTurn: boolean; permission?: "read" | "write" | "full"; input: ForwardedReachInput }): Promise<ReachOutcome | null> {
  const tool = typeof input.input.operation === "string" ? input.input.operation : "";
  if (!REACH_FORWARDED_TOOLS.has(tool)) return null;
  const args = input.input.args && typeof input.input.args === "object" && !Array.isArray(input.input.args) ? input.input.args as Record<string, unknown> : {};
  const chatId = typeof input.input.scope?.chatId === "string" ? input.input.scope.chatId : "";
  const { REACH_HANDLERS } = await import("./ports");
  const handler = (REACH_HANDLERS as Record<string, (a: Record<string, unknown>, c: { chatId: string; runId: string; permission?: "read" | "write" | "full" }) => Promise<ReachOutcome>>)[tool];
  return handler(args, { chatId, runId: "desktop-handover", ...(input.permission ? { permission: input.permission } : {}) });
}
