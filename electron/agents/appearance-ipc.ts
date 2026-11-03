import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { getAuthSession, onAuthSessionOwnershipChanged } from "../auth";
import { getDb } from "../store/db";
import { emitDesktopStoreChange } from "../store/change-bus";
import type { AgentAppearanceUpdate } from "../../shared/agent-appearance";
import { getAgentAppearance, setAgentAppearance } from "./appearance-store";

// Presentation writes are owner actions in a trusted Desktop renderer only.
export function registerAgentAppearanceIpc(input: { ipc: Pick<IpcMain, "handle">; assertTrustedSender: (event: IpcMainInvokeEvent) => unknown }): void {
  let epoch = 0;
  const grants = new Map<string, { sender: number; frame: string; principal: string; epoch: number; agentId: string; installation: string; revision: number; expires: number }>();
  onAuthSessionOwnershipChanged(() => { epoch++; grants.clear(); emitDesktopStoreChange({ entity: "agent" }); });
  function principal(): string {
    const session = getAuthSession();
    if (session.signedIn && !session.accountFingerprint) throw Error("appearance_owner_unknown");
    return JSON.stringify(session.signedIn ? ["account", session.accountFingerprint, session.workspaceId ?? null] : ["local"]);
  }
  function issue(event: IpcMainInvokeEvent, id: string) {
    input.assertTrustedSender(event);
    const owner = principal(), currentEpoch = epoch, frame = event.senderFrame?.url;
    if (!frame || event.sender.isDestroyed()) throw Error("appearance_owner_changed");
    const current = getAgentAppearance(getDb(), owner, id);
    if (owner !== principal() || currentEpoch !== epoch) throw Error("appearance_owner_changed");
    for (const [key, value] of grants) if (value.expires < Date.now()) grants.delete(key);
    if (grants.size >= 512) throw Error("appearance_edit_capacity");
    const editToken = randomUUID(); grants.set(editToken, { sender: event.sender.id, frame, principal: owner, epoch: currentEpoch, agentId: id, installation: current.installation, revision: current.revision, expires: Date.now() + 300_000 });
    return { ...current, editToken };
  }
  input.ipc.handle("agentWorkspace:readAppearance", (event, id: string) => {
    input.assertTrustedSender(event); const owner = principal(), capturedEpoch = epoch;
    const view = getAgentAppearance(getDb(), owner, id);
    if (capturedEpoch !== epoch || owner !== principal() || event.sender.isDestroyed()) throw Error("appearance_owner_changed");
    return view;
  });
  input.ipc.handle("agentWorkspace:getAppearance", (event, id: string) => issue(event, id));
  input.ipc.handle("agentWorkspace:setAppearance", (event, value: AgentAppearanceUpdate) => {
    input.assertTrustedSender(event);
    if (!value || typeof value !== "object" || typeof value.editToken !== "string") throw Error("appearance_review_required");
    const grant = grants.get(value.editToken); grants.delete(value.editToken);
    if (!grant || grant.expires < Date.now() || grant.sender !== event.sender.id || grant.frame !== event.senderFrame?.url || grant.agentId !== value.agentId || grant.installation !== value.installation || grant.revision !== value.revision) throw Error("appearance_review_required");
    const check = () => { input.assertTrustedSender(event); if (event.sender.isDestroyed() || event.senderFrame?.url !== grant.frame || epoch !== grant.epoch || principal() !== grant.principal) throw Error("appearance_owner_changed"); };
    check(); setAgentAppearance(getDb(), grant.principal, grant.agentId, grant.installation, grant.revision, value.appearance, check);
    emitDesktopStoreChange({ entity: "agent", id: grant.agentId });
    return issue(event, grant.agentId);
  });
}
