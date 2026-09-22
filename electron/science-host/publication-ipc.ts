import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ProductExtensionPermission } from "../../shared/product-extension";
import type { DaemonScienceCommand } from "../daemon/science-service";
import type { ScienceDaemonClient } from "./daemon-client";

export const SCIENCE_PUBLICATION_IPC_CHANNELS = [
  "science:manuscripts:editNode", "science:manuscripts:listTypesetProfiles",
  "science:manuscripts:getPublicationPreference", "science:manuscripts:setPublicationPreference",
  "science:manuscripts:prepareRenderJob", "science:manuscripts:createRenderJob",
  "science:manuscripts:getRenderJob", "science:manuscripts:listRenderJobs",
  "science:manuscripts:retryRenderJob", "science:manuscripts:cancelRenderJob",
  "science:manuscripts:readRenderOutput", "science:manuscripts:render",
  "science:journals:list", "science:journals:inspectOfficialGuidelines", "science:journals:recordGuidelineText",
  "science:journals:useNeutralProfile", "science:journals:inspectGuidelinesMirror", "science:journals:createProfile",
  "science:journals:confirmIdentity", "science:journals:confirmHumanAttestation", "science:journals:validate",
  "science:submissions:createExport",
] as const;

/** Restore only documented binary output fields, never arbitrary nested records. */
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("science-publication-bytes-invalid");
  const row = value as Record<string, unknown>;
  let values: unknown[];
  if (row.type === "Buffer" && Array.isArray(row.data) && Object.keys(row).length === 2) values = row.data;
  else {
    const keys = Object.keys(row);
    if (keys.some((key, index) => key !== String(index))) throw new Error("science-publication-bytes-invalid");
    values = keys.map(key => row[key]);
  }
  if (values.length > 32 * 1024 * 1024 || values.some(value => !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255)) {
    throw new Error("science-publication-bytes-invalid");
  }
  return Uint8Array.from(values as number[]);
}

function restoreOutput(op: string, result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const row = result as Record<string, unknown>;
  if (op === "publication.readRenderOutput") return { ...row, bytes: bytes(row.bytes) };
  if (op !== "manuscripts.render") return result;
  const pdf = row.pdf;
  return { ...row, docx: row.docx == null ? null : bytes(row.docx), hwpx: row.hwpx == null ? null : bytes(row.hwpx),
    pdf: pdf && typeof pdf === "object" && !Array.isArray(pdf)
      ? { ...pdf, bytes: bytes((pdf as Record<string, unknown>).bytes) } : pdf };
}

/** Science owns the publication executor; Main only admits its signed native frame. */
export function registerSciencePublicationIpc({ ipc, assertScienceSender, client }: {
  ipc: Pick<IpcMain, "handle">;
  assertScienceSender(event: IpcMainInvokeEvent, envelope: unknown, permission?: ProductExtensionPermission): unknown;
  client: Pick<ScienceDaemonClient, "command" | "commandObserved">;
}): void {
  const methods = ["listTypesetProfiles", "getPublicationPreference", "setPublicationPreference", "prepareRenderJob",
    "createRenderJob", "getRenderJob", "listRenderJobs", "retryRenderJob", "cancelRenderJob", "readRenderOutput"] as const;
  const register = (channel: string, op: DaemonScienceCommand["op"], permission: ProductExtensionPermission = "science:projects") => {
    ipc.handle(channel, async (event, envelope: unknown) => {
      assertScienceSender(event, envelope, permission);
      if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-publication-subframe-denied");
      const payload = envelope && typeof envelope === "object" ? (envelope as { input?: unknown }).input : null;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("science-publication-input-invalid");
      // The operation comes from this fixed registry, never from renderer data.
      const command = { op, input: payload } as DaemonScienceCommand;
      const createsWork = ["publication.setPublicationPreference", "publication.createRenderJob", "publication.retryRenderJob",
        "manuscripts.editNode", "manuscripts.render"].includes(op);
      const result = createsWork ? await client.command(command) : await client.commandObserved(command);
      return restoreOutput(op, result);
    });
  };
  register("science:manuscripts:editNode", "manuscripts.editNode");
  for (const method of methods) register(`science:manuscripts:${method}`, `publication.${method}`,
    ["setPublicationPreference", "createRenderJob", "retryRenderJob"].includes(method) ? "science:artifacts" : "science:projects");
  register("science:manuscripts:render", "manuscripts.render");
  ipc.handle("science:journals:list", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-publication-subframe-denied");
    const projectId = envelope && typeof envelope === "object" ? String((envelope as { projectId?: unknown }).projectId ?? "") : "";
    return client.commandObserved({ op: "journal.listJournalProfiles", input: { projectId } });
  });
  const journalMethods = [
    ["science:journals:inspectOfficialGuidelines", "journal.inspectOfficialGuidelines", "science:network", "guideline"],
    ["science:journals:recordGuidelineText", "journal.recordManualGuidelineText", "science:projects", "guideline"],
    ["science:journals:useNeutralProfile", "journal.ensureNeutralJournalProfile", "science:projects", "neutral-profile"],
    ["science:journals:inspectGuidelinesMirror", "journal.inspectGuidelineMirror", "science:network", "guideline"],
    ["science:journals:createProfile", "journal.createJournalProfile", "science:projects", "profile"],
    ["science:journals:confirmIdentity", "journal.confirmJournalIdentity", "science:projects", "identity"],
    ["science:journals:confirmHumanAttestation", "journal.confirmHumanAttestation", "science:projects", "attestation"],
    ["science:journals:validate", "journal.validate", "science:projects", "validation"],
    ["science:submissions:createExport", "journal.createSubmissionExport", "science:projects", "submission-export"],
  ] as const;
  for (const [channel, op, permission, kind] of journalMethods) ipc.handle(channel, (event, envelope: unknown) => {
    assertScienceSender(event, envelope, permission);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-publication-subframe-denied");
    const raw = envelope && typeof envelope === "object" ? (envelope as { input?: unknown }).input : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(kind === "submission-export" ? "science-submission-export-input-invalid" : `science-journal-${kind}-input-invalid`);
    }
    const value = raw as Record<string, unknown>;
    let payload = value;
    const projectId = String(value.projectId ?? "");
    if (op === "journal.inspectOfficialGuidelines") payload = { projectId, sourceUrl: String(value.sourceUrl ?? "") };
    else if (op === "journal.recordManualGuidelineText") payload = { projectId, officialHost: String(value.officialHost ?? ""),
      pageTitle: String(value.pageTitle ?? ""), text: String(value.text ?? "") };
    else if (op === "journal.ensureNeutralJournalProfile") payload = { projectId, variant: String(value.variant ?? ""),
      articleType: typeof value.articleType === "string" ? value.articleType : undefined };
    else if (op === "journal.inspectGuidelineMirror") payload = { projectId, sourceUrl: String(value.sourceUrl ?? ""), officialHost: String(value.officialHost ?? "") };
    else if (op === "journal.validate") payload = { projectId, manuscriptId: String(value.manuscriptId ?? ""),
      journalProfileId: String(value.journalProfileId ?? ""), metadata: value.metadata,
      humanAttestationReceiptIds: Array.isArray(value.humanAttestationReceiptIds) ? value.humanAttestationReceiptIds.map(String) : [] };
    // Project ownership, profile pins, and manuscript lookup stay in the one
    // daemon service. Native input normalization preserves the existing API.
    return client.commandObserved({ op, input: payload } as DaemonScienceCommand);
  });
}
