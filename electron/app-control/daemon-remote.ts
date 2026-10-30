import type { AppControlCaller } from "./service";
import { DEVICE_BRIDGE_UNAVAILABLE_MESSAGE, DeviceBridgeError, daemonDeviceBridge, type DaemonDeviceBridge } from "../daemon/device-bridge";
import { AppControlError } from "./ipc-registry";
import { APP_CALL_ANSWER_WINDOW_MS, appCallPendingNotice, isAppCallPending } from "./pending-calls";

// The background service runs One/Hope turns but owns no window and no IPC handler, so it cannot run an app-control
// operation (production 1.3.3, 2026-10-12: every operation "available": false, and Hope fell back to osascript on the
// owner's screen). It asks Main over the device bridge instead; Main runs the very same service with its own policy,
// owner-turn rule and handlers. No electron import: the service loads this without Electron.

type AppBridge = Pick<DaemonDeviceBridge, "appControl">;

function unavailable(error: unknown): { code: string; message: string } {
  const code = error instanceof DeviceBridgeError ? error.code : "device_bridge_unavailable";
  if (code === "device_bridge_timeout") return { code: "app-call-timeout", message: "Agentlas did not answer in time; the operation may or may not have run, so read its state before repeating it." };
  // The request itself could not be carried (not plain JSON, or over the channel's size limit): the window is fine.
  if (code === "device_bridge_refused" && /^native_auth_(value|frame)_/.test((error as Error).message)) return { code: "invalid-arguments", message: `The arguments could not be sent to the app: plain JSON values within the size limit only (${(error as Error).message}).` };
  return { code: "app-window-unavailable", message: `${DEVICE_BRIDGE_UNAVAILABLE_MESSAGE} (${code}).` };
}

export async function remoteAppControlOperations<T extends object>(input: Record<string, unknown>, listLocally: (input: any) => T, bridge: AppBridge = daemonDeviceBridge()): Promise<T & { app_window?: { available: false; code: string; message: string } }> {
  try {
    const answer = await bridge.appControl({ kind: "operations", ownerTurn: false, input });
    if (answer.outcome === "value") return answer.value as T;
    // Main refused or failed: say so, with the catalog this process can describe (nothing in it is runnable here).
    return { ...listLocally(input), app_window: { available: false, code: answer.code, message: answer.message } };
  } catch (error) {
    return { ...listLocally(input), app_window: { available: false, ...unavailable(error) } };
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
  for (;;) {
    try { answer = await bridge.appControl({ kind: "call", ownerTurn: caller.ownerTurn === true, permission: caller.permission ?? "read", input: request }); }
    catch (error) {
      if (error instanceof DeviceBridgeError && error.code === "device_bridge_timeout") {
        if (deadline - Date.now() < 1500) return appCallPendingNotice(operation) as unknown as Record<string, unknown>;
        continue;
      }
      const { code, message } = unavailable(error); throw new AppControlError(code, message);
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
