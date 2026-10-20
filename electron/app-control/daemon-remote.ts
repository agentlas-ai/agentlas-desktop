import { DEVICE_BRIDGE_UNAVAILABLE_MESSAGE, DeviceBridgeError, daemonDeviceBridge, type DaemonDeviceBridge } from "../daemon/device-bridge";
import { AppControlError } from "./ipc-registry";






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

export async function remoteAppControlCall(caller: { ownerTurn: boolean }, input: { operation?: unknown; args?: unknown; scope?: { chatId?: unknown } }, bridge: AppBridge = daemonDeviceBridge()): Promise<Record<string, unknown>> {
  let answer;
  // An absent args stays absent: { args: undefined } is not a wire value.
  // A scope (the conversation a harness port checked) travels in the same input object; an absent one stays absent.
  const request = { operation: input.operation, ...(input.args !== undefined ? { args: input.args } : {}),
    ...(typeof input.scope?.chatId === "string" ? { scope: { chatId: input.scope.chatId } } : {}) };
  try { answer = await bridge.appControl({ kind: "call", ownerTurn: caller.ownerTurn === true, input: request }); }
  catch (error) { const { code, message } = unavailable(error); throw new AppControlError(code, message); }
  if (answer.outcome === "value") return answer.value as Record<string, unknown>;
  // Main's AppControlError text already leads with its code ("operation-not-allowed: ..."); keep it once.
  const prefix = `${answer.code}: `;
  throw new AppControlError(answer.code, answer.message.startsWith(prefix) ? answer.message.slice(prefix.length) : answer.message);
}
