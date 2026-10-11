import { DEVICE_BRIDGE_UNAVAILABLE_MESSAGE, DeviceBridgeError, daemonDeviceBridge, type DaemonDeviceBridge } from "../daemon/device-bridge";
import { AppControlError } from "./ipc-registry";

// The background service runs One/Hope turns but owns no window and no IPC handler, so it cannot run an app-control
// operation (production 1.3.3, 2026-10-12: every operation "available": false, and Hope fell back to osascript on the
// owner's screen). It asks Main over the device bridge instead; Main runs the very same service with its own policy,
// owner-turn rule and handlers. No electron import: the service loads this without Electron.

type AppBridge = Pick<DaemonDeviceBridge, "appControl">;

function unavailable(error: unknown): { code: string; message: string } {
  const code = error instanceof DeviceBridgeError ? error.code : "device_bridge_unavailable";
  if (code === "device_bridge_timeout") return { code: "app-call-timeout", message: "Agentlas did not answer in time; the operation may or may not have run, so read its state before repeating it." };
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

export async function remoteAppControlCall(caller: { ownerTurn: boolean }, input: { operation?: unknown; args?: unknown }, bridge: AppBridge = daemonDeviceBridge()): Promise<Record<string, unknown>> {
  let answer;
  try { answer = await bridge.appControl({ kind: "call", ownerTurn: caller.ownerTurn === true, input: { operation: input.operation, args: input.args } }); }
  catch (error) { const { code, message } = unavailable(error); throw new AppControlError(code, message); }
  if (answer.outcome === "value") return answer.value as Record<string, unknown>;
  // Main's AppControlError text already leads with its code ("operation-not-allowed: ..."); keep it once.
  const prefix = `${answer.code}: `;
  throw new AppControlError(answer.code, answer.message.startsWith(prefix) ? answer.message.slice(prefix.length) : answer.message);
}
