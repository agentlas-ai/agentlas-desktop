import fs from "node:fs";
import { BrowserWindow, dialog, shell, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { LIVE_DOCUMENT_FORMATS } from "../../shared/live-document";
import {
  applyLiveDocument, closeLiveDocument, listLiveDocuments, liveDocumentDelta, liveDocumentRoot, liveDocumentSnapshot,
  LiveDocumentError, openLiveDocument, saveLiveDocument,
} from "./store";
import { renderLiveDocument } from "./render";
import { registerAppControlDomainIpc } from "../app-control/ipc-registry";

/*
 * Main-side bridge for the Document rail tab. The renderer never names a path: a file reaches a session only through
 * the native open dialog (owner action) or the harness document.open port (the run). Journal changes made by any
 * process (the daemon runs harness ports) are pushed as `liveDocument:changed` by watching the sessions directory.
 */

const MAX_ID = 64;
const id = (value: unknown): string => (typeof value === "string" ? value.slice(0, MAX_ID) : "");

function broadcast(event: { sessionId: string; chatId: string }): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("liveDocument:changed", event);
  }
}

let watcher: fs.FSWatcher | null = null;
const chatBySession = new Map<string, string>();
const pending = new Map<string, NodeJS.Timeout>();

async function startWatching(): Promise<void> {
  if (watcher) return;
  const root = await liveDocumentRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    watcher = fs.watch(root, { recursive: true }, (_type, file) => {
      const sessionId = String(file ?? "").split(/[\\/]/)[0];
      if (!/^ld_[0-9a-f-]{36}$/.test(sessionId) || pending.has(sessionId)) return;
      // Coalesce bursts (journal append + meta rewrite) into one push.
      pending.set(sessionId, setTimeout(() => {
        pending.delete(sessionId);
        let chatId = chatBySession.get(sessionId);
        if (!chatId) {
          try { chatId = (JSON.parse(fs.readFileSync(`${root}/${sessionId}/meta.json`, "utf8")) as { chatId: string }).chatId; } catch { return; }
          chatBySession.set(sessionId, chatId);
        }
        broadcast({ sessionId, chatId });
      }, 40));
    });
    watcher.on("error", () => { watcher?.close(); watcher = null; });
  } catch {
    watcher = null; // The renderer also polls while the tab is open.
  }
}

/**
 * liveDocument:render is a read that has to work without an owner window: a background or unattended review (window closed,
 * hidden, or never loaded) still needs the pictures, and only Main can take them. It is registered as an app-control domain
 * handler, so app.call (and the daemon's request over the device bridge) reaches it without a live interaction window, while
 * the renderer's own invoke keeps the trusted-sender check. Production registers it here and the gate uses this same function.
 */
export function registerLiveDocumentRenderIpc(input: { ipc: Pick<IpcMain, "handle">; assertTrustedSender(event: IpcMainInvokeEvent): void }): void {
  const { ipc, assertTrustedSender } = input;
  const trusted: Pick<IpcMain, "handle"> = { handle: (channel, listener) => ipc.handle(channel, (event, ...args) => { assertTrustedSender(event); return listener(event, ...args); }) };
  registerAppControlDomainIpc(trusted, "liveDocument:render", (sessionId: unknown, from?: unknown, count?: unknown) =>
    renderLiveDocument(id(sessionId), { from: Number.isSafeInteger(from) ? from : undefined, count: Number.isSafeInteger(count) ? count : undefined }));
}

export function registerLiveDocumentIpc(input: { ipc: Pick<IpcMain, "handle">; assertTrustedSender(event: IpcMainInvokeEvent): void }): void {
  const { ipc, assertTrustedSender } = input;
  void startWatching();
  ipc.handle("liveDocument:list", async (event, chatId: unknown) => {
    assertTrustedSender(event);
    return listLiveDocuments(id(chatId));
  });
  ipc.handle("liveDocument:pickAndOpen", async (event, chatId: unknown) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = { properties: ["openFile" as const], filters: [{ name: "Office", extensions: [...LIVE_DOCUMENT_FORMATS] }] };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, reason: "cancelled" };
    try {
      const meta = await openLiveDocument({ chatId: id(chatId), path: picked.filePaths[0] });
      chatBySession.set(meta.sessionId, meta.chatId);
      broadcast({ sessionId: meta.sessionId, chatId: meta.chatId });
      return { ok: true, sessionId: meta.sessionId };
    } catch (error) {
      if (error instanceof LiveDocumentError) return { ok: false, reason: error.reason };
      throw error;
    }
  });
  registerLiveDocumentRenderIpc({ ipc, assertTrustedSender });
  ipc.handle("liveDocument:snapshot", async (event, sessionId: unknown) => {
    assertTrustedSender(event);
    try { return await liveDocumentSnapshot(id(sessionId)); } catch (error) { if (error instanceof LiveDocumentError) return null; throw error; }
  });
  ipc.handle("liveDocument:entries", async (event, sessionId: unknown, since: unknown) => {
    assertTrustedSender(event);
    try { return await liveDocumentDelta(id(sessionId), Number(since)); } catch (error) { if (error instanceof LiveDocumentError) return null; throw error; }
  });
  ipc.handle("liveDocument:apply", async (event, value: unknown) => {
    assertTrustedSender(event);
    const request = (value && typeof value === "object" ? value : {}) as { sessionId?: unknown; baseRevision?: unknown; ops?: unknown };
    return applyLiveDocument({
      sessionId: id(request.sessionId),
      ...(Number.isSafeInteger(request.baseRevision) ? { baseRevision: Number(request.baseRevision) } : {}),
      ops: request.ops, actor: { kind: "user" },
    });
  });
  ipc.handle("liveDocument:save", async (event, sessionId: unknown) => {
    assertTrustedSender(event);
    return saveLiveDocument({ sessionId: id(sessionId) });
  });
  ipc.handle("liveDocument:close", async (event, sessionId: unknown) => {
    assertTrustedSender(event);
    return closeLiveDocument(id(sessionId));
  });
  ipc.handle("liveDocument:reveal", async (event, sessionId: unknown) => {
    assertTrustedSender(event);
    try {
      const snapshot = await liveDocumentSnapshot(id(sessionId));
      shell.showItemInFolder(snapshot.meta.path);
      return true;
    } catch { return false; }
  });
}
