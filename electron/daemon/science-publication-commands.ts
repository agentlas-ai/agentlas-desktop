type Science = typeof import("agentlas-science");
type Store = ReturnType<Science["scienceStore"]>;
type Jobs = ReturnType<Science["sciencePublicationJobService"]>;
type Journal = ReturnType<Science["scienceJournalPublicationService"]>;
type RenderOptions = Parameters<ReturnType<Science["scienceManuscriptRenderService"]>["render"]>[1];
type JobMethod = "getPublicationPreference" | "setPublicationPreference" | "prepareRenderJob"
  | "createRenderJob" | "getRenderJob" | "listRenderJobs" | "retryRenderJob" | "cancelRenderJob" | "readRenderOutput";
type JournalMethod = "inspectOfficialGuidelines" | "recordManualGuidelineText" | "ensureNeutralJournalProfile"
  | "inspectGuidelineMirror" | "createJournalProfile" | "confirmJournalIdentity" | "confirmHumanAttestation" | "createSubmissionExport";
type JournalCommand = {
  [Method in JournalMethod]: { op: `journal.${Method}`; input: Parameters<Journal[Method]>[0] }
}[JournalMethod]
  | { op: "journal.listJournalProfiles"; input: { projectId: string } }
  | { op: "journal.validate"; input: { projectId: string; manuscriptId: string; journalProfileId: string;
      metadata?: Parameters<Journal["validate"]>[2]; humanAttestationReceiptIds?: string[] } };

export type DaemonSciencePublicationCommand = {
  [Method in JobMethod]: { op: `publication.${Method}`; input: Parameters<Jobs[Method]>[0] }
}[JobMethod]
  | JournalCommand
  | { op: "publication.listTypesetProfiles"; input: Parameters<Jobs["getPublicationPreference"]>[0] }
  | { op: "manuscripts.editNode"; input: Parameters<Store["editManuscriptNode"]>[0] }
  | { op: "manuscripts.render"; input: Record<string, unknown> };

/** Same native publication services and optimistic pins; no second job queue or rendering policy. */
export async function dispatchSciencePublicationCommand(
  api: Science, store: Store, command: DaemonSciencePublicationCommand, assertExecution: () => void,
): Promise<unknown> {
  assertExecution();
  switch (command.op) {
    case "journal.listJournalProfiles": return api.scienceJournalPublicationService().listJournalProfiles(command.input.projectId);
    case "journal.inspectOfficialGuidelines": return api.scienceJournalPublicationService().inspectOfficialGuidelines(command.input);
    case "journal.recordManualGuidelineText": return api.scienceJournalPublicationService().recordManualGuidelineText(command.input);
    case "journal.ensureNeutralJournalProfile": return api.scienceJournalPublicationService().ensureNeutralJournalProfile(command.input);
    case "journal.inspectGuidelineMirror": return api.scienceJournalPublicationService().inspectGuidelineMirror(command.input);
    case "journal.createJournalProfile": return api.scienceJournalPublicationService().createJournalProfile(command.input);
    case "journal.confirmJournalIdentity": return api.scienceJournalPublicationService().confirmJournalIdentity(command.input);
    case "journal.confirmHumanAttestation": return api.scienceJournalPublicationService().confirmHumanAttestation(command.input);
    case "journal.createSubmissionExport": return api.scienceJournalPublicationService().createSubmissionExport(command.input);
    case "journal.validate": {
      const input = command.input;
      const manuscript = store.getManuscriptForProject(input.projectId, input.manuscriptId);
      const profile = store.getJournalProfileForProject(input.projectId, input.journalProfileId);
      if (!manuscript || !profile) throw new Error("science-journal-validation-target-not-found");
      return api.scienceJournalPublicationService().validate(manuscript, profile, input.metadata,
        Array.isArray(input.humanAttestationReceiptIds) ? input.humanAttestationReceiptIds.map(String) : []);
    }
  }
  if (command.op === "manuscripts.editNode") return store.editManuscriptNode(command.input);
  if (command.op === "manuscripts.render") {
    const input = command.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-manuscript-render-input-invalid");
    const { validateSciencePdfSelection } = await import("agentlas-science/dist/contracts/science-typeset-profile");
    assertExecution();
    const pdfSelection = input.pdfEngine === undefined && input.pdfProfile === undefined ? null
      : validateSciencePdfSelection({ engine: input.pdfEngine, ...(input.pdfProfile === undefined ? {} : { profile: input.pdfProfile }) });
    if ((pdfSelection && input.pdfFallback !== "forbid") || (input.pdfFallback !== undefined && input.pdfFallback !== "forbid")) {
      throw new Error("publication_pdf_fallback_forbidden");
    }
    const options: RenderOptions & { previewReferencePdf?: boolean } = {
      ...(pdfSelection ? { pdfEngine: pdfSelection.engine, ...(pdfSelection.engine === "pdflatex" ? { pdfProfile: pdfSelection.profile } : {}) } : {}),
      ...(input.pdfFallback === "forbid" ? { pdfFallback: "forbid" as const } : {}),
      outputs: Array.isArray(input.outputs) && input.outputs.length ? input.outputs as NonNullable<RenderOptions>["outputs"] : ["html"],
      style: input.style as NonNullable<RenderOptions>["style"],
      lineNumbers: input.lineNumbers === true,
      doubleSpacing: input.doubleSpacing === true,
      journalProfileId: typeof input.journalProfileId === "string" ? input.journalProfileId : undefined,
      expectedJournalProfileVersion: typeof input.expectedJournalProfileVersion === "number" ? input.expectedJournalProfileVersion : undefined,
      expectedJournalProfileContentSha256: typeof input.expectedJournalProfileContentSha256 === "string" ? input.expectedJournalProfileContentSha256 : undefined,
      ...(input.columnCount === 1 || input.columnCount === 2 ? { columnCount: input.columnCount } : {}),
      ...(input.previewReferencePdf === true ? { previewReferencePdf: true } : {}),
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata as NonNullable<RenderOptions>["metadata"] : null,
    };
    const projectId = typeof input.projectId === "string" ? input.projectId : "";
    const service = api.scienceManuscriptRenderService();
    if (typeof input.manuscriptId === "string") return service.renderStored(projectId, input.manuscriptId, options);
    const draft = input.draft as Record<string, unknown> | undefined;
    if (!draft || typeof draft.markdown !== "string" || !Array.isArray(draft.bindings)) throw new Error("science-manuscript-render-input-invalid");
    return service.render(api.draftManuscript(projectId, typeof draft.title === "string" ? draft.title : "", draft.markdown,
      draft.bindings as Parameters<Science["draftManuscript"]>[3]), options);
  }
  const jobs = api.sciencePublicationJobService();
  switch (command.op) {
    case "publication.listTypesetProfiles": {
      jobs.getPublicationPreference(command.input);
      const { listScienceTypesetProfiles } = await import("agentlas-science/dist/host");
      assertExecution();
      return listScienceTypesetProfiles();
    }
    case "publication.getPublicationPreference": return jobs.getPublicationPreference(command.input);
    case "publication.setPublicationPreference": return jobs.setPublicationPreference(command.input);
    case "publication.prepareRenderJob": return jobs.prepareRenderJob(command.input);
    case "publication.createRenderJob": return jobs.createRenderJob(command.input);
    case "publication.getRenderJob": return jobs.getRenderJob(command.input);
    case "publication.listRenderJobs": return jobs.listRenderJobs(command.input);
    case "publication.retryRenderJob": return jobs.retryRenderJob(command.input);
    case "publication.cancelRenderJob": return jobs.cancelRenderJob(command.input);
    case "publication.readRenderOutput": return jobs.readRenderOutput(command.input);
  }
}
