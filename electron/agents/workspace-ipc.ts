import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { AgentWorkspaceIpc } from "../../shared/agent-workspace";
import { AgentWorkspaceError } from "./workspace-snapshot";
import { getAgentWorkspace, getAgentWorkspaceMemoryCounts, listAgentWorkspaceFiles, readAgentWorkspaceFile, prepareAgentWorkspaceFromMemory,
  prepareAgentWorkspaceFileChange, prepareAgentWorkspaceRollback, prepareAgentWorkspaceFileOperation, getAgentWorkspaceDiff, issueAgentWorkspaceApprovalReceipt,
  applyAgentWorkspaceProposal, rejectAgentWorkspaceProposal, getAgentWorkspaceRecoveryDiff, acknowledgeAgentWorkspaceRecovery } from "./workspace-service";
import { prepareAgentWorkspaceComparison, receiveAgentWorkspace, sendAgentWorkspace, type AgentWorkspaceRemoteReview } from "./workspace-remote";

type Input<K extends keyof AgentWorkspaceIpc> = Parameters<AgentWorkspaceIpc[K]>[0];
interface ReviewGrant { senderId: number; frameUrl: string; expiresAt: number; kind: "apply" | "sync" | "recovery"; id: string; hash: string; remote?: AgentWorkspaceRemoteReview; }
/** No Main automation, MCP, or Terminal wrapper exposes the owner review grant issuer. */
export function registerAgentWorkspaceIpc(input: { ipc: Pick<IpcMain, "handle">; assertTrustedSender: (event: IpcMainInvokeEvent) => unknown }): void {
  const grants = new Map<string, ReviewGrant>();
  const issue = (event: IpcMainInvokeEvent, grant: Omit<ReviewGrant, "senderId" | "frameUrl" | "expiresAt">) => {
    for (const [token, value] of grants) if (value.expiresAt < Date.now()) grants.delete(token);
    const token = randomUUID(); grants.set(token, { ...grant, senderId: event.sender.id, frameUrl: event.senderFrame!.url, expiresAt: Date.now() + 300_000 }); return token;
  };
  const consume = (event: IpcMainInvokeEvent, token: string, kind: ReviewGrant["kind"], id: string, hash: string) => {
    const grant = grants.get(token); grants.delete(token);
    if (!grant || grant.kind !== kind || grant.id !== id || grant.hash !== hash || grant.senderId !== event.sender.id
      || grant.frameUrl !== event.senderFrame?.url || grant.expiresAt < Date.now()) throw new AgentWorkspaceError("review_required", "Review the current diff in this window before approving it.");
    return grant;
  };
  const handle = (name: string, action: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => input.ipc.handle(name, async (event, ...args) => {
    input.assertTrustedSender(event);
    try { return await action(event, ...args); }
    catch (error) { if (error instanceof AgentWorkspaceError) throw new Error(`[${error.code}] ${error.message}`); throw error; }
  });
  handle("agentWorkspace:get", (_event, id: string) => getAgentWorkspace(id));
  handle("agentWorkspace:memoryCounts", (_event, ids: string[]) => getAgentWorkspaceMemoryCounts(ids));
  handle("agentWorkspace:listFiles", (_event, id: string, dir?: string) => listAgentWorkspaceFiles(id, dir));
  handle("agentWorkspace:readFile", (_event, id: string, file: string) => readAgentWorkspaceFile(id, file));
  handle("agentWorkspace:prepareFromMemory", (_event, value: Input<"prepareFromMemory">) => prepareAgentWorkspaceFromMemory(value));
  handle("agentWorkspace:prepareFileChange", (_event, value: Input<"prepareFileChange">) => prepareAgentWorkspaceFileChange(value));
  handle("agentWorkspace:prepareRollback", (_event, value: Input<"prepareRollback">) => prepareAgentWorkspaceRollback(value));
  handle("agentWorkspace:prepareFileOperation", (_event, value: Input<"prepareFileOperation">) => prepareAgentWorkspaceFileOperation(value));
  handle("agentWorkspace:getDiff", (event, id: string) => {
    const diff = getAgentWorkspaceDiff(id);
    return { ...diff, ...(diff.status === "review_ready" ? { reviewToken: issue(event, { kind: "apply", id, hash: diff.reviewedHash }) } : {}) };
  });
  handle("agentWorkspace:approveAndApply", (event, value: Input<"approveAndApply">) => {
    consume(event, value.reviewToken, "apply", value.proposalId, value.reviewedHash);
    const approvalReceiptId = issueAgentWorkspaceApprovalReceipt(value.proposalId, value.reviewedHash);
    return applyAgentWorkspaceProposal({ proposalId: value.proposalId, reviewedHash: value.reviewedHash, approvalReceiptId });
  });
  handle("agentWorkspace:reject", (_event, value: Input<"reject">) => rejectAgentWorkspaceProposal(value.proposalId));
  handle("agentWorkspace:getRecoveryDiff", (event, id: string) => {
    const diff = getAgentWorkspaceRecoveryDiff(id); return { ...diff, reviewToken: issue(event, { kind: "recovery", id, hash: diff.reviewedHash }) };
  });
  handle("agentWorkspace:acknowledgeRecovery", (event, value: Input<"acknowledgeRecovery">) => {
    consume(event, value.reviewToken, "recovery", value.agentId, value.reviewedHash); return acknowledgeAgentWorkspaceRecovery(value.agentId, value.reviewedHash);
  });
  handle("agentWorkspace:compare", async (event, value: Input<"compare">) => {
    if (!["cloud", "hub"].includes(value.target)) throw new AgentWorkspaceError("invalid_target", "Choose Cloud or Hub.");
    const direction = value.direction ?? "receive";
    if (!["send", "receive"].includes(direction)) throw new AgentWorkspaceError("invalid_direction", "Choose a sync direction.");
    const prepared = await prepareAgentWorkspaceComparison(value.agentId, value.target, direction);
    return { ...prepared.comparison, ...(prepared.review ? { reviewToken: issue(event, { kind: "sync", id: `${value.agentId}:${value.target}:${direction}`, hash: prepared.review.reviewedHash, remote: prepared.review }) } : {}) };
  });
  handle("agentWorkspace:sync", async (event, value: Input<"sync">) => {
    const grant = consume(event, value.reviewToken, "sync", `${value.agentId}:${value.target}:${value.direction}`, value.reviewedHash);
    if (!grant.remote || grant.remote.direction !== value.direction || !["send", "receive"].includes(value.direction)) throw new AgentWorkspaceError("invalid_direction", "Choose a sync direction.");
    return value.direction === "receive" ? receiveAgentWorkspace(grant.remote) : sendAgentWorkspace(grant.remote);
  });
}
