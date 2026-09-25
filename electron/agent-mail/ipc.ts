import type { IpcMain } from "electron";
import { AGENT_MAIL_IPC_CHANNELS as CH } from "../../shared/agent-mail";
import { agentMailGet, agentMailIssue, agentMailList, agentMailRemove, agentMailSend, agentMailStatus } from "./client";

/** Renderer → Main agent mail calls. Main holds the session; renderer never sees the cookie. */
export function registerAgentMailIpc(ipc: Pick<IpcMain, "handle">): void {
  ipc.handle(CH.status, () => agentMailStatus());
  ipc.handle(CH.issue, (_e, input: unknown) => agentMailIssue((input && typeof input === "object" ? input : {}) as { displayName?: string }));
  ipc.handle(CH.list, (_e, input: unknown) => agentMailList((input && typeof input === "object" ? input : {}) as Parameters<typeof agentMailList>[0]));
  ipc.handle(CH.get, (_e, id: unknown) => agentMailGet(String(id ?? "")));
  ipc.handle(CH.send, (_e, input: unknown) => agentMailSend((input && typeof input === "object" ? input : {}) as Parameters<typeof agentMailSend>[0]));
  ipc.handle(CH.remove, (_e, id: unknown) => agentMailRemove(String(id ?? "")));
}
