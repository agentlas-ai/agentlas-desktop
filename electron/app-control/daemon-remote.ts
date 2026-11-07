import type { AppControlCaller } from "./service";
import { DeviceBridgeError, daemonDeviceBridge, type DaemonDeviceBridge } from "../daemon/device-bridge";
import { AppControlError } from "./ipc-registry";
import { APP_CALL_ANSWER_WINDOW_MS, appCallPendingNotice, isAppCallPending } from "./pending-calls";

// The background service runs One/Hope turns but owns no window and no IPC handler, so it cannot run an app-control
// operation (production 1.3.3, 2026-10-12: every operation "available": false, and Hope fell back to osascript on the
// owner's screen). It asks Main over the device bridge instead; Main runs the very same service with its own policy,
// owner-turn rule and handlers. No electron import: the service loads this without Electron.

type AppBridge = Pick<DaemonDeviceBridge, "appControl"> & Partial<Pick<DaemonDeviceBridge, "attached" | "whenAttached">>;

// The window process is not attached for a few seconds at app start and while its channel re-attaches (main.log "re-attach
// scheduled"); a call made in that gap used to be refused at once with app-window-unavailable (observed in use: 35 refusals in two
// chats). Nothing has been sent while Main is not attached, so the call may wait for it. A window that is really closed stays closed:
// the first call to find none waits this long, and the next ones within the memo are refused at once, as before.
const MAIN_ATTACH_WAIT_MS = 6_000;
const MAIN_ABSENT_MEMO_MS = 30_000;
/** A window process this service just started (gui-background-launch.ts) gets this long: a cold start measured 8-21 s. */
const MAIN_START_WAIT_MS = 30_000;
const mainAbsentAt = new WeakMap<object, number>();

/** Set only by the background service (daemon/main.ts): it may start the app when no window process is attached. */
export interface MainProcessLauncher { launch(): boolean; starting(): boolean; attached?(): void }
let mainLauncher: MainProcessLauncher | null = null;
export function configureMainProcessLauncher(next: MainProcessLauncher | null): void { mainLauncher = next; }
function mainStarting(): boolean {
  try { return mainLauncher?.starting() === true; } catch { return false; }
}

function noteAttached(bridge: AppBridge): void {
  mainAbsentAt.delete(bridge);
  try { mainLauncher?.attached?.(); } catch { /* the launcher's state is advisory */ }
}

async function waitForMain(bridge: AppBridge, withinMs: number, mayStart: boolean): Promise<void> {
  if (bridge.attached !== false) { noteAttached(bridge); return; }
  if (!bridge.whenAttached || !(withinMs > 0)) return;
  // After a login only this service runs: an operation One calls starts the app in the background (its tray, no window) and waits for
  // it, instead of answering "tell the owner to open Agentlas" to an owner who is on the phone. A catalog listing never starts it.
  let starting = false;
  try { starting = (mayStart && mainLauncher?.launch() === true) || mainStarting(); } catch { starting = false; }
  const gaveUpAt = mainAbsentAt.get(bridge);
  if (!starting && gaveUpAt !== undefined && Date.now() - gaveUpAt < MAIN_ABSENT_MEMO_MS) return;
  const fullWait = starting ? MAIN_START_WAIT_MS : MAIN_ATTACH_WAIT_MS;
  const waitMs = Math.min(fullWait, withinMs);
  if (await bridge.whenAttached(waitMs)) noteAttached(bridge);
  else if (!starting && waitMs >= MAIN_ATTACH_WAIT_MS) mainAbsentAt.set(bridge, Date.now()); // only a full wait proves the window is not coming
}

/**
 * What the model reads (and may repeat to the owner) when the window process could not be asked. Plain words only: the machine code
 * travels in `code`, never inside the sentence. The sentence also has to be true: "the window is not open" is said only when no window
 * process is attached; a window that IS attached but did not answer is "did not answer" (observed in use: the same screen-control
 * sentence, with the bridge's internal code in brackets, answered every failure, including a call that came from a run while the app
 * window was open).
 */
export const APP_WINDOW_ABSENT_MESSAGE = "The Agentlas app window is not connected right now (the app is closed, restarting or updating), and this action can only run through it. Nothing was changed. Do not repeat the call in this run: continue with the other tools, or tell the owner to open Agentlas and send the request again.";
export const APP_WINDOW_NO_ANSWER_MESSAGE = "The Agentlas app window is open but did not answer this request, so it may or may not have run. Read the state before repeating it.";
export const APP_WINDOW_STARTING_MESSAGE = "Agentlas is starting in the background to run this (only its background service was running). Nothing was changed yet. Make the same call again in a moment.";
export const APP_WINDOW_SCREEN_LOCKED_MESSAGE = "The screen is locked or asleep, so this action cannot run right now. Try again after the owner unlocks it.";

function unavailable(error: unknown, bridge?: AppBridge): { code: string; message: string } {
  const code = error instanceof DeviceBridgeError ? error.code : "device_bridge_unavailable";
  if (code === "device_bridge_timeout") return { code: "app-call-timeout", message: "Agentlas did not answer in time; the operation may or may not have run, so read its state before repeating it." };
  // The request itself could not be carried (not plain JSON, or over the channel's size limit): the window is fine.
  if (code === "device_bridge_refused" && /^native_auth_(value|frame)_/.test((error as Error).message)) return { code: "invalid-arguments", message: `The arguments could not be sent to the app: plain JSON values within the size limit only (${(error as Error).message}).` };
  if (code === "device_session_locked") return { code: "app-window-unavailable", message: APP_WINDOW_SCREEN_LOCKED_MESSAGE };
  // A window process that is attached right now but failed this request (the channel dropped under it, or it could not answer, or it refused)
  // is not "closed". A bridge that cannot say (a legacy fake) or has no window process attached is the absent case.
  const windowAttached = bridge?.attached === true;
  if (!windowAttached && mainStarting()) return { code: "app-window-starting", message: APP_WINDOW_STARTING_MESSAGE };
  return { code: "app-window-unavailable", message: windowAttached ? APP_WINDOW_NO_ANSWER_MESSAGE : APP_WINDOW_ABSENT_MESSAGE };
}

/** A failure of the transport that proves nothing was sent or that a read can simply be asked again (the listing is a pure catalog read). */
function listingRetryable(error: unknown): boolean {
  return error instanceof DeviceBridgeError && (error.code === "device_bridge_disconnected" || error.code === "device_bridge_unavailable");
}

export async function remoteAppControlOperations<T extends object>(input: Record<string, unknown>, listLocally: (input: any) => T, bridge: AppBridge = daemonDeviceBridge()): Promise<T & { app_window?: { available: false; code: string; message: string } }> {
  // The listing only reads the catalog, so one more ask is always safe: a channel that dropped under the first ask (the window process
  // re-attaching) is given the attach wait again and asked once more, instead of answering "unavailable" for a window that is coming back.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await waitForMain(bridge, MAIN_ATTACH_WAIT_MS, false);
      const answer = await bridge.appControl({ kind: "operations", ownerTurn: false, input });
      if (answer.outcome === "value") return answer.value as T;
      // Main refused or failed: say so, with the catalog this process can describe (nothing in it is runnable here).
      return { ...listLocally(input), app_window: { available: false, code: answer.code, message: answer.message } };
    } catch (error) {
      if (attempt === 0 && listingRetryable(error) && bridge.whenAttached && await bridge.whenAttached(MAIN_ATTACH_WAIT_MS).catch(() => false)) continue;
      return { ...listLocally(input), app_window: { available: false, ...unavailable(error, bridge) } };
    }
  }
}

export async function remoteAppControlCall(caller: AppControlCaller, input: { operation?: unknown; args?: unknown; scope?: { chatId?: unknown } }, bridge: AppBridge = daemonDeviceBridge(), windowMs: number = APP_CALL_ANSWER_WINDOW_MS): Promise<Record<string, unknown>> {
  let answer;
  // An absent args stays absent: { args: undefined } is not a wire value (dev 2026-10-18 run9, app.call automations.list).
  // A scope (the conversation a harness port checked) travels in the same input object; an absent one stays absent.
  const request = { operation: input.operation, ...(input.args !== undefined ? { args: input.args } : {}),
    ...(typeof input.scope?.chatId === "string" ? { scope: { chatId: input.scope.chatId } } : {}) };
  // Main answers a call that is still running with a notice, and the same request asked again joins it (pending-calls.ts); so does a
  // request this side gave up on at its own deadline while Main was busy. Ask again until the model-facing window is spent, then say
  // "running": the operation was neither refused nor lost, and the model's repeat of the call reaches the same run.
  const operation = typeof input.operation === "string" ? input.operation.trim() : "";
  const deadline = Date.now() + windowMs;
  // Only the owner's own turn starts the app: a check-in, a review or any other host turn waits for a running app and never opens one
  // behind the owner's back (deploy review ; the window policy already asked for ownerTurn).
  await waitForMain(bridge, deadline - Date.now() - 1500, caller.ownerTurn === true);
  for (;;) {
    try { answer = await bridge.appControl({ kind: "call", ownerTurn: caller.ownerTurn === true, permission: caller.permission ?? "read", input: request }); }
    catch (error) {
      if (error instanceof DeviceBridgeError && error.code === "device_bridge_timeout") {
        if (deadline - Date.now() < 1500) return appCallPendingNotice(operation) as unknown as Record<string, unknown>;
        continue;
      }
      const { code, message } = unavailable(error, bridge); throw new AppControlError(code, message);
    }
    if (answer.outcome === "value" && isAppCallPending(answer.value)) {
      // Another ask would outlive the window (Main holds one up to its own budget): say "running" now.
      if (deadline - Date.now() < 1500) return answer.value as unknown as Record<string, unknown>;
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 100); t.unref?.(); });
      continue;
    }
    break;
  }
  if (answer.outcome === "value") return answer.value as Record<string, unknown>;
  // Main's AppControlError text already leads with its code ("operation-not-allowed: ..."); keep it once.
  const prefix = `${answer.code}: `;
  throw new AppControlError(answer.code, answer.message.startsWith(prefix) ? answer.message.slice(prefix.length) : answer.message);
}
