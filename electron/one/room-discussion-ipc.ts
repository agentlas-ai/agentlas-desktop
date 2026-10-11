/**
 * IPC for the group-room discussion (A4/A5). Registered once from Main; the engine itself is host-agnostic
 * (room-discussion.ts). These channels are deliberately plain ipcMain handlers, not app-control domain handlers:
 * One must not be able to open a discussion on the owner's behalf, only the owner's own screen does.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { OneDiscussionPostInput, OneDiscussionPostResult, OneDiscussionState } from "../../shared/one-discussion";

export interface RoomDiscussionIpcRuntime {
  post(input: OneDiscussionPostInput): OneDiscussionPostResult;
  stop(chatId: string): { stopped: boolean };
  state(chatId: string): OneDiscussionState;
  setEnabled(chatId: string, enabled: boolean | null): OneDiscussionState;
}

const CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_POST_CHARS = 12_000;

function chatIdOf(value: unknown): string {
  if (typeof value !== "string" || !CHAT_ID.test(value)) throw new Error("one_discussion_chat_invalid");
  return value;
}

export function registerRoomDiscussionIpc(input: {
  ipc: Pick<IpcMain, "handle">;
  assertTrustedSender(event: IpcMainInvokeEvent): void;
  isOwnerWindow(window: BrowserWindow): boolean;
  runtime?: () => RoomDiscussionIpcRuntime;
  /** The window that sent the event; Electron's by default (replaced in gates that run without Electron). */
  windowOf?: (event: IpcMainInvokeEvent) => BrowserWindow | null;
}): void {
  const runtime = input.runtime ?? (() => (require("./room-discussion") as typeof import("./room-discussion")).roomDiscussion());
  const guard = (event: IpcMainInvokeEvent) => {
    input.assertTrustedSender(event);
    const window = input.windowOf
      ? input.windowOf(event)
      : (require("electron") as typeof import("electron")).BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || !input.isOwnerWindow(window) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("one_discussion_owner_window_required");
    }
  };
  input.ipc.handle("oneDiscussion:state", (event, chatId: unknown) => { guard(event); return runtime().state(chatIdOf(chatId)); });
  input.ipc.handle("oneDiscussion:post", (event, raw: unknown) => {
    guard(event);
    const value = raw as Partial<OneDiscussionPostInput> | null;
    const text = typeof value?.text === "string" ? value.text.trim() : "";
    if (text.length > MAX_POST_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error("one_discussion_post_invalid");
    return runtime().post({ chatId: chatIdOf(value?.chatId), text, interrupt: value?.interrupt === true });
  });
  input.ipc.handle("oneDiscussion:stop", (event, chatId: unknown) => { guard(event); return runtime().stop(chatIdOf(chatId)); });
  input.ipc.handle("oneDiscussion:setEnabled", (event, raw: unknown) => {
    guard(event);
    const value = raw as { chatId?: unknown; enabled?: unknown } | null;
    if (value?.enabled !== null && typeof value?.enabled !== "boolean") throw new Error("one_discussion_setting_invalid");
    return runtime().setEnabled(chatIdOf(value?.chatId), value.enabled as boolean | null);
  });
}
