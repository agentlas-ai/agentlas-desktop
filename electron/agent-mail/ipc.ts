import path from "node:path";
import type { IpcMain } from "electron";
import { AGENT_MAIL_IPC_CHANNELS as CH, type AgentMailDraftInput, type AgentMailMailboxPatch, type AgentMailSendInput, type AgentMailThreadsInput } from "../../shared/agent-mail";
import {
  agentMailArchiveThread,
  agentMailCheckAddress,
  agentMailDrafts,
  agentMailGet,
  agentMailIssue,
  agentMailList,
  agentMailMarkThreadRead,
  agentMailRemove,
  agentMailRemoveDraft,
  agentMailRemoveThread,
  agentMailSaveDraft,
  agentMailSend,
  agentMailSendDraft,
  agentMailStatus,
  agentMailThread,
  agentMailThreads,
  agentMailUnread,
  agentMailUpdateMailbox,
} from "./client";
import { saveAgentMailAttachment } from "./attachments";
import { agentMailDelegate, agentMailSyncNow } from "./sync";

// Renderer → Main agent mail calls. Main holds the session; the renderer never
// sees the cookie. Everything sent from here is the owner's own action, so the
// origin is always "owner" (the renderer cannot claim another origin).
//
// The same functions are what the mobile bridge calls (see API.md "Desktop IPC"):
// import them from "./client" / "./sync" rather than going through ipcMain.

function obj<T>(input: unknown): T {
  return (input && typeof input === "object" ? input : {}) as T;
}

function afterChange<T extends { ok: boolean }>(result: T): T {
  if (result.ok) agentMailSyncNow();
  return result;
}

export function registerAgentMailIpc(ipc: Pick<IpcMain, "handle">): void {
  ipc.handle(CH.status, () => agentMailStatus());
  ipc.handle(CH.issue, async (_e, input: unknown) => afterChange(await agentMailIssue(obj<{ displayName?: string; localPart?: string }>(input))));
  ipc.handle(CH.updateMailbox, (_e, patch: unknown) => agentMailUpdateMailbox(obj<AgentMailMailboxPatch>(patch)));
  ipc.handle(CH.checkAddress, (_e, localPart: unknown) => agentMailCheckAddress(String(localPart ?? "")));
  ipc.handle(CH.list, (_e, input: unknown) => agentMailList(obj<Parameters<typeof agentMailList>[0]>(input)));
  ipc.handle(CH.get, (_e, id: unknown) => agentMailGet(String(id ?? "")));
  ipc.handle(CH.send, async (_e, input: unknown) => afterChange(await agentMailSend(obj<AgentMailSendInput>(input), { origin: "owner" })));
  ipc.handle(CH.remove, async (_e, id: unknown) => afterChange(await agentMailRemove(String(id ?? ""))));
  ipc.handle(CH.threads, (_e, input: unknown) => agentMailThreads(obj<AgentMailThreadsInput>(input)));
  ipc.handle(CH.thread, (_e, id: unknown) => agentMailThread(String(id ?? "")));
  ipc.handle(CH.markRead, async (_e, input: unknown) => {
    const { threadId, read } = obj<{ threadId?: string; read?: boolean }>(input);
    return afterChange(await agentMailMarkThreadRead(String(threadId ?? ""), read !== false));
  });
  ipc.handle(CH.archive, async (_e, input: unknown) => {
    const { threadId, archived } = obj<{ threadId?: string; archived?: boolean }>(input);
    return afterChange(await agentMailArchiveThread(String(threadId ?? ""), archived !== false));
  });
  ipc.handle(CH.removeThread, async (_e, id: unknown) => afterChange(await agentMailRemoveThread(String(id ?? ""))));
  ipc.handle(CH.unread, async () => {
    const res = await agentMailUnread();
    return res.ok ? { ok: true, unread: res.unread } : res;
  });
  ipc.handle(CH.drafts, (_e, input: unknown) => agentMailDrafts(obj<{ threadId?: string; cursor?: string | null }>(input)));
  ipc.handle(CH.saveDraft, (_e, input: unknown) => {
    const value = obj<{ id?: string | null; expectedVersion?: number; fields?: AgentMailDraftInput }>(input);
    return agentMailSaveDraft({ id: value.id ?? null, expectedVersion: value.expectedVersion, fields: obj<AgentMailDraftInput>(value.fields) }, { origin: "owner" });
  });
  ipc.handle(CH.removeDraft, (_e, id: unknown) => agentMailRemoveDraft(String(id ?? "")));
  ipc.handle(CH.sendDraft, async (_e, input: unknown) => afterChange(await agentMailSendDraft(obj<{ id: string; expectedVersion?: number }>(input))));
  ipc.handle(CH.downloadAttachment, async (_e, input: unknown) => {
    const { messageId, index } = obj<{ messageId?: string; index?: number }>(input);
    const { app, shell } = await import("electron");
    const saved = await saveAgentMailAttachment(String(messageId ?? ""), Number(index), path.join(app.getPath("downloads")));
    if (saved.ok) shell.showItemInFolder(saved.path);
    return saved.ok ? { ok: true, path: saved.path, bytes: saved.bytes } : saved;
  });
  ipc.handle(CH.delegate, (_e, input: unknown) => {
    const value = obj<{ threadId?: string; instruction?: string; locale?: "ko" | "en" }>(input);
    return agentMailDelegate({ threadId: String(value.threadId ?? ""), instruction: value.instruction, locale: value.locale });
  });
}
