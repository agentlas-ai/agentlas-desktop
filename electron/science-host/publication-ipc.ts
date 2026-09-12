import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { sciencePublicationJobService, scienceStore } from "agentlas-science";
import type { ProductExtensionPermission } from "../../shared/product-extension";
import { listScienceTypesetProfiles } from "agentlas-science/dist/host";

type Jobs = ReturnType<typeof sciencePublicationJobService>;
/** Science owns canonical revisions and receipts; Desktop admits its trusted frame. */
export function registerSciencePublicationIpc({ ipc, assertScienceSender }: {
  ipc: Pick<IpcMain, "handle">;
  assertScienceSender: (event: IpcMainInvokeEvent, envelope: unknown, permission?: ProductExtensionPermission) => unknown;
}) {
  const input = (event: IpcMainInvokeEvent, envelope: unknown, permission: ProductExtensionPermission = "science:projects") => {
    assertScienceSender(event, envelope, permission);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-publication-subframe-denied");
    const payload = envelope && typeof envelope === "object" ? (envelope as { input?: unknown }).input : null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("science-publication-input-invalid");
    return payload;
  };
  ipc.handle("science:manuscripts:editNode", (event, envelope) => {
    const payload = input(event, envelope);
    return scienceStore().editManuscriptNode(payload as Parameters<ReturnType<typeof scienceStore>["editManuscriptNode"]>[0]);
  });
  ipc.handle("science:manuscripts:listTypesetProfiles", async (event, envelope) => {
    const payload = input(event, envelope);
    sciencePublicationJobService().getPublicationPreference(payload as Parameters<Jobs["getPublicationPreference"]>[0]);
    return listScienceTypesetProfiles();
  });
  ipc.handle("science:manuscripts:getPublicationPreference", (event, envelope) => {
    return sciencePublicationJobService().getPublicationPreference(input(event, envelope) as Parameters<Jobs["getPublicationPreference"]>[0]);
  });
  ipc.handle("science:manuscripts:setPublicationPreference", (event, envelope) => {
    // Saving an exact identity never certifies availability. The render executor
    // rechecks the complete profile and sandbox immediately before execution.
    return sciencePublicationJobService().setPublicationPreference(input(event, envelope, "science:artifacts") as Parameters<Jobs["setPublicationPreference"]>[0]);
  });
  ipc.handle("science:manuscripts:prepareRenderJob", (event, envelope) => {
    const payload = input(event, envelope);
    return sciencePublicationJobService().prepareRenderJob(payload as Parameters<Jobs["prepareRenderJob"]>[0]);
  });
  ipc.handle("science:manuscripts:createRenderJob", (event, envelope) => {
    const payload = input(event, envelope, "science:artifacts");
    return sciencePublicationJobService().createRenderJob(payload as Parameters<Jobs["createRenderJob"]>[0]);
  });
  ipc.handle("science:manuscripts:getRenderJob", (event, envelope) => {
    const payload = input(event, envelope);
    return sciencePublicationJobService().getRenderJob(payload as Parameters<Jobs["getRenderJob"]>[0]);
  });
  ipc.handle("science:manuscripts:listRenderJobs", (event, envelope) => {
    const payload = input(event, envelope);
    return sciencePublicationJobService().listRenderJobs(payload as Parameters<Jobs["listRenderJobs"]>[0]);
  });
  ipc.handle("science:manuscripts:retryRenderJob", (event, envelope) => {
    const payload = input(event, envelope, "science:artifacts");
    return sciencePublicationJobService().retryRenderJob(payload as Parameters<Jobs["retryRenderJob"]>[0]);
  });
  ipc.handle("science:manuscripts:cancelRenderJob", (event, envelope) => {
    const payload = input(event, envelope);
    return sciencePublicationJobService().cancelRenderJob(payload as Parameters<Jobs["cancelRenderJob"]>[0]);
  });
  ipc.handle("science:manuscripts:readRenderOutput", (event, envelope) => {
    const payload = input(event, envelope);
    return sciencePublicationJobService().readRenderOutput(payload as Parameters<Jobs["readRenderOutput"]>[0]);
  });
}
