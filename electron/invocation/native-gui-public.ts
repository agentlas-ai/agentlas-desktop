import { BrowserWindow } from "electron";
import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import { createNativeInvocationPublicReceiver, nativePublicAckOperation, nativePublicReadOperation } from "./native-public-events";
import { configuredNativeGuiOwner } from "./native-gui-startup";
import { dispatchOnePreflightSteers } from "./preflight-steer-admission";

type Channel = object & { dispatch(method: string, params: unknown): Promise<unknown>; onClose(listener: () => void): () => void };
let legacyChatIds: string[] = [], nativeChatIds: string[] = [], recoveredChatIds: string[] = [];
function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) {
    try { window.webContents.send(channel, value); } catch { /* UI viewer loss is not daemon Stop. */ }
  }
}
export function nativeGuiObservedActiveChatIds(): string[] { return [...nativeChatIds]; }
export function combinedInvocationActiveChatIds(): string[] { return [...new Set([...legacyChatIds, ...nativeChatIds, ...recoveredChatIds])]; }
function publishActiveChats(): void { broadcast("invoke:activeChats", combinedInvocationActiveChatIds()); }
export function publishNativeRecoveryActiveChats(chatIds: string[]): void { recoveredChatIds = [...chatIds]; publishActiveChats(); }
/** Original Main service remains an independent source; never overwrite the
 * daemon's last observed active snapshot with a local empty array. */
export function publishLegacyInvocationActiveChats(chatIds: string[]): void { legacyChatIds = [...chatIds]; publishActiveChats(); }
/** Main-only live projection. This supplies neither durable replay/recovery nor
 * approval readiness, and public settlement cannot mint cleanup authority. */
export function createNativeGuiPublicBridge(policy: Readonly<{ maxRetainedBytes: number }>, onUnavailable?: (channel: Channel, identity: NativeAuthenticatedIdentity) => void) {
  let channel: Channel | undefined, identity: NativeAuthenticatedIdentity | undefined;
  let receiver: ReturnType<typeof createNativeInvocationPublicReceiver> | undefined;
  function bind(actualChannel: Channel, actualIdentity: NativeAuthenticatedIdentity): void {
    if (channel || nativeGuiChannelIdentity(actualChannel) !== actualIdentity) throw new Error("native_gui_public_original_channel_required");
    channel = actualChannel; identity = actualIdentity;
    receiver = createNativeInvocationPublicReceiver({ identity: actualIdentity,
      getIdentity: () => channel === actualChannel ? nativeGuiChannelIdentity(actualChannel) ?? null : null,
      maxRetainedBytes: policy.maxRetainedBytes,
      read: input => actualChannel.dispatch("native.attach", nativePublicReadOperation(input)),
      ack: input => actualChannel.dispatch("native.attach", nativePublicAckOperation(input)),
      onEvent: ({ runId, event }) => broadcast(`invoke:event:${runId}`, event),
      onActiveChats(chatIds) { nativeChatIds = [...chatIds]; recoveredChatIds = []; publishActiveChats(); },
      onSettled({ runId, chatId }) {
        // Root sends the authentic final private finish callback before this
        // event. Retire tests that already-released state; no second finish RPC.
        const owner = configuredNativeGuiOwner();
        if (owner?.inspect(runId).retained) {
          try { owner.observeSettlement(runId); }
          catch (error) { console.warn("[native-invocation] original custody retained", error); }
        }
        setImmediate(() => { try { dispatchOnePreflightSteers(undefined, chatId); } catch { /* Durable uncertain claims remain. */ } });
      },
      onFault: error => { console.warn("[native-invocation] public stream unavailable", error);
        if (nativeGuiChannelIdentity(actualChannel) === actualIdentity) onUnavailable?.(actualChannel, actualIdentity); },
    });
    actualChannel.onClose(() => { receiver?.dispose(); /* Keep last-known IDs; disconnect proves no quiescence. */ });
  }
  return Object.freeze({ bind, accept(method: string, params: unknown) { receiver?.accept(method, params); },
    async quiesce() { await receiver?.quiesce(); },
    activeChatIds() { return receiver?.activeChatIds() ?? []; },
    get available() { return !!receiver?.available && !!channel && nativeGuiChannelIdentity(channel) === identity; } });
}
