import { BrowserWindow } from "electron";
import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
import { createNativeInvocationPublicReceiver, nativePublicAckOperation, nativePublicReadOperation } from "./native-public-events";
import { configuredNativeGuiOwner } from "./native-gui-startup";
import { dispatchOnePreflightSteers } from "./preflight-steer-admission";
import { notifyDaemonRunSettled } from "./daemon-run-alerts";
import { publishNativeGuiActiveChats, publishNativeGuiInvocationEvent, publishNativeGuiSettled } from "./native-gui-events";

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
  // Active chats the previous generation last reported. Disconnect proves no
  // quiescence, so they stay visible (start fence) until the new generation's
  // authoritative snapshot arrives or the chat settles.
  let staleChatIds = new Set<string>(), generation = 0;
  /** Rebindable: a new generation replaces a CLOSED one; a live channel is never replaced. */
  function bind(actualChannel: Channel, actualIdentity: NativeAuthenticatedIdentity, expectedStream?: string): void {
    if (nativeGuiChannelIdentity(actualChannel) !== actualIdentity) throw new Error("native_gui_public_original_channel_required");
    if (channel && channel !== actualChannel && nativeGuiChannelIdentity(channel) !== undefined) throw new Error("native_gui_public_original_channel_required");
    if (channel === actualChannel && expectedStream === undefined) throw new Error("native_gui_public_original_channel_required");
    if (expectedStream !== undefined && !/^[a-f0-9]{64}$/.test(expectedStream)) throw new Error("native_gui_public_stream_required");
    if (receiver) { for (const chatId of receiver.activeChatIds()) staleChatIds.add(chatId); receiver.dispose(); }
    const mine = ++generation;
    const live = () => mine === generation;
    channel = actualChannel; identity = actualIdentity;
    receiver = createNativeInvocationPublicReceiver({ expectedStream, identity: actualIdentity,
      getIdentity: () => channel === actualChannel ? nativeGuiChannelIdentity(actualChannel) ?? null : null,
      maxRetainedBytes: policy.maxRetainedBytes,
      read: input => actualChannel.dispatch("native.attach", nativePublicReadOperation(input)),
      ack: input => actualChannel.dispatch("native.attach", nativePublicAckOperation(input)),
      onEvent: ({ runId, chatId, event }) => {
        if (!live()) return;
        broadcast(`invoke:event:${runId}`, event);
        // The phone bridge, too: it listens to Main's own service, which never sees daemon-hosted runs.
        publishNativeGuiInvocationEvent({ runId, chatId, event });
      },
      onActiveChats(chatIds) { if (!live()) return; staleChatIds = new Set(); nativeChatIds = [...chatIds]; recoveredChatIds = []; publishActiveChats(); publishNativeGuiActiveChats(nativeChatIds); },
      onSettled(settlement) {
        const { runId, chatId } = settlement;
        if (!live()) return;
        staleChatIds.delete(chatId);
        // A run hosted by the background service never settles in Main's own invocation service, so the OS notification
        // Main shows for its own runs is raised here from the service's settlement (same settings, same foreground rule).
        notifyDaemonRunSettled(settlement);
        // The phone bridge's failure push, too (it listens to Main's own service, which never settles this run).
        publishNativeGuiSettled(settlement);
        // Root sends the authentic final private finish callback before this
        // event. Retire tests that already-released state; no second finish RPC.
        const owner = configuredNativeGuiOwner();
        if (owner?.inspect(runId).retained) {
          try { owner.observeSettlement(runId); }
          catch (error) { console.warn("[native-invocation] original custody retained", error); }
        }
        setImmediate(() => { try { dispatchOnePreflightSteers(undefined, chatId); } catch { /* Durable uncertain claims remain. */ } });
      },
      onFault: error => { if (!live()) return; console.warn("[native-invocation] public stream unavailable", error);
        if (nativeGuiChannelIdentity(actualChannel) === actualIdentity) onUnavailable?.(actualChannel, actualIdentity); },
    });
    const mineReceiver = receiver;
    actualChannel.onClose(() => { mineReceiver.dispose(); /* Keep last-known IDs; disconnect proves no quiescence. */ });
  }
  /** The new generation's authoritative active-chat snapshot (recovery refresh) resolves stale chats it no longer lists. */
  function reconcileStale(activeChatIds: readonly string[]): void { for (const chatId of [...staleChatIds]) if (!activeChatIds.includes(chatId)) staleChatIds.delete(chatId); }
  return Object.freeze({ bind, resetObservation: (actualChannel: Channel, actualIdentity: NativeAuthenticatedIdentity, stream: string) => bind(actualChannel, actualIdentity, stream), reconcileStale, accept(method: string, params: unknown, fromIdentity?: NativeAuthenticatedIdentity) {
      if (fromIdentity !== undefined && fromIdentity !== identity) return; // event from a previous generation
      receiver?.accept(method, params); },
    async quiesce() { await receiver?.quiesce(); },
    activeChatIds() { return [...new Set([...(receiver?.activeChatIds() ?? []), ...staleChatIds])]; },
    get available() { return !!receiver?.available && !!channel && nativeGuiChannelIdentity(channel) === identity; } });
}
