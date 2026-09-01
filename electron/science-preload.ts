import { contextBridge, ipcRenderer } from "electron";

const extensionId = process.argv
  .find((argument) => argument.startsWith("--agentlas-extension-id="))
  ?.slice("--agentlas-extension-id=".length) ?? "";

contextBridge.exposeInMainWorld("agentlasScience", Object.freeze({
  extensionId,
  bootstrap: () => ipcRenderer.invoke("science:bootstrap", { extensionId }),
  shell: Object.freeze({
    backToWork: () => ipcRenderer.invoke("science:shell:backToWork", { extensionId }),
  }),
  rendererPacks: Object.freeze({
    list: () => ipcRenderer.invoke("science:rendererPacks:list", { extensionId }),
  }),
  renderers: Object.freeze({
    mount: (input: unknown) => ipcRenderer.invoke("science:renderers:mount", { extensionId, input }),
    bounds: (input: unknown) => ipcRenderer.invoke("science:renderers:bounds", { extensionId, input }),
    visibility: (visible: boolean) => ipcRenderer.invoke("science:renderers:visibility", { extensionId, visible }),
    dispose: () => ipcRenderer.invoke("science:renderers:dispose", { extensionId }),
    onStatus: (callback: (status: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on("science:rendererStatus", listener);
      return () => ipcRenderer.removeListener("science:rendererStatus", listener);
    },
  }),
  projects: Object.freeze({
    list: () => ipcRenderer.invoke("science:projects:list", { extensionId }),
    create: (input: unknown) => ipcRenderer.invoke("science:projects:create", { extensionId, input }),
    get: (projectId: string) => ipcRenderer.invoke("science:projects:get", { extensionId, projectId }),
    updateRelatedDomains: (input: unknown) => ipcRenderer.invoke("science:projects:updateRelatedDomains", { extensionId, input }),
  }),
  workspace: Object.freeze({
    get: (projectId: string) => ipcRenderer.invoke("science:workspace:get", { extensionId, projectId }),
    updateNavigation: (input: unknown) => ipcRenderer.invoke("science:workspace:updateNavigation", { extensionId, input }),
    replaceTabs: (input: unknown) => ipcRenderer.invoke("science:workspace:replaceTabs", { extensionId, input }),
  }),
  researchLifecycle: Object.freeze({
    get: (projectId: string) => ipcRenderer.invoke("science:researchLifecycle:get", { extensionId, projectId }),
    revisions: (projectId: string, studyId: string) => ipcRenderer.invoke("science:researchLifecycle:revisions", { extensionId, projectId, studyId }),
    onChanged: (callback: (change: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, change: unknown) => callback(change);
      ipcRenderer.on("science:researchLifecycleChanged", listener);
      return () => ipcRenderer.removeListener("science:researchLifecycleChanged", listener);
    },
  }),
  researchContracts: Object.freeze({
    get: (projectId: string) => ipcRenderer.invoke("science:researchContracts:get", { extensionId, projectId }),
    approve: (input: unknown) => ipcRenderer.invoke("science:researchContracts:approve", { extensionId, input }),
  }),
  researchLoops: Object.freeze({
    inspect: (projectId: string) => ipcRenderer.invoke("science:researchLoops:inspect", { extensionId, projectId }),
    start: (input: unknown) => ipcRenderer.invoke("science:researchLoops:start", { extensionId, input }),
    transition: (input: unknown) => ipcRenderer.invoke("science:researchLoops:transition", { extensionId, input }),
  }),
  conversations: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:conversations:list", { extensionId, projectId }),
    messages: (projectId: string, conversationId: string) => ipcRenderer.invoke("science:messages:list", { extensionId, projectId, conversationId }),
  }),
  composer: Object.freeze({
    start: (input: unknown) => ipcRenderer.invoke("science:composer:start", { extensionId, input }),
    cancel: (input: unknown) => ipcRenderer.invoke("science:composer:cancel", { extensionId, input }),
    attach: (input: unknown) => ipcRenderer.invoke("science:composer:attach", { extensionId, input }),
    receipt: (input: unknown) => ipcRenderer.invoke("science:composer:receipt", { extensionId, input }),
    onEvent: (callback: (event: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
      ipcRenderer.on("science:turnEvent", listener);
      return () => ipcRenderer.removeListener("science:turnEvent", listener);
    },
  }),
  messages: Object.freeze({
    blocks: (projectId: string, messageId: string) => ipcRenderer.invoke("science:messageBlocks:list", { extensionId, projectId, messageId }),
    citations: (projectId: string, messageId: string) => ipcRenderer.invoke("science:citations:listForMessage", { extensionId, projectId, messageId }),
  }),
  evidence: Object.freeze({
    get: (projectId: string, evidenceId: string) => ipcRenderer.invoke("science:evidence:get", { extensionId, projectId, evidenceId }),
  }),
  evidenceGraph: Object.freeze({
    get: (projectId: string) => ipcRenderer.invoke("science:evidenceGraph:get", { extensionId, projectId }),
    refresh: (input: unknown) => ipcRenderer.invoke("science:evidenceGraph:refresh", { extensionId, input }),
    bounded: (projectId: string, query: string, limit = 40) => ipcRenderer.invoke("science:evidenceGraph:bounded", { extensionId, projectId, query, limit }),
    propose: (input: unknown) => ipcRenderer.invoke("science:evidenceGraph:propose", { extensionId, input }),
    review: (input: unknown) => ipcRenderer.invoke("science:evidenceGraph:review", { extensionId, input }),
    materialize: (input: unknown) => ipcRenderer.invoke("science:evidenceGraph:materialize", { extensionId, input }),
    path: (projectId: string, fromNodeId: string, toNodeId: string) => ipcRenderer.invoke("science:evidenceGraph:path", { extensionId, projectId, fromNodeId, toNodeId }),
  }),
  sources: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:sources:list", { extensionId, projectId }),
    get: (projectId: string, sourceId: string) => ipcRenderer.invoke("science:sources:get", { extensionId, projectId, sourceId }),
  }),
  datasets: Object.freeze({
    importCsv: (input: unknown) => ipcRenderer.invoke("science:datasets:importCsv", { extensionId, input }),
  }),
  sourceFigures: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:sourceFigures:list", { extensionId, projectId }),
    get: (projectId: string, figureId: string) => ipcRenderer.invoke("science:sourceFigures:get", { extensionId, projectId, figureId }),
  }),
  runs: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:runs:list", { extensionId, projectId }),
    get: (projectId: string, runId: string) => ipcRenderer.invoke("science:runs:get", { extensionId, projectId, runId }),
  }),
  artifacts: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:artifacts:list", { extensionId, projectId }),
    get: (projectId: string, artifactId: string) => ipcRenderer.invoke("science:artifacts:get", { extensionId, projectId, artifactId }),
    context: (projectId: string, artifactId: string, artifactVersion?: number) => ipcRenderer.invoke("science:artifacts:context", { extensionId, projectId, artifactId, artifactVersion }),
    history: (projectId: string, artifactId: string) => ipcRenderer.invoke("science:artifacts:history", { extensionId, projectId, artifactId }),
    diff: (projectId: string, artifactId: string, fromVersion: number, toVersion: number) => ipcRenderer.invoke("science:artifacts:diff", { extensionId, projectId, artifactId, fromVersion, toVersion }),
    forMessage: (projectId: string, conversationId: string, messageId: string) => ipcRenderer.invoke("science:artifacts:listForMessage", { extensionId, projectId, conversationId, messageId }),
    eventsForMessage: (projectId: string, conversationId: string, messageId: string) => ipcRenderer.invoke("science:artifactEvents:listForMessage", { extensionId, projectId, conversationId, messageId }),
    resolveConversationRoute: (projectId: string, conversationId: string, messageId: string, artifactId: string, artifactVersion: number) => ipcRenderer.invoke("science:artifacts:resolveConversationRoute", { extensionId, projectId, conversationId, messageId, artifactId, artifactVersion }),
    forLab: (projectId: string, labId: string) => ipcRenderer.invoke("science:artifacts:listForLab", { extensionId, projectId, labId }),
    preview: (projectId: string, artifactId: string, artifactVersion: number) => ipcRenderer.invoke("science:artifacts:preview", { extensionId, projectId, artifactId, artifactVersion }),
    capture: (input: unknown) => ipcRenderer.invoke("science:artifacts:capture", { extensionId, input }),
    observation: (projectId: string, artifactId: string) => ipcRenderer.invoke("science:artifacts:observation", { extensionId, projectId, artifactId }),
    updateVega: (input: unknown) => ipcRenderer.invoke("science:artifacts:updateVega", { extensionId, input }),
    listStatisticsFigures: (projectId: string, statisticsArtifactId?: string) => ipcRenderer.invoke("science:artifacts:listStatisticsFigures", { extensionId, projectId, statisticsArtifactId }),
    materializeStatisticsFigure: (input: unknown) => ipcRenderer.invoke("science:artifacts:materializeStatisticsFigure", { extensionId, input }),
    materializeStatisticsNumericSurface: (input: unknown) => ipcRenderer.invoke("science:artifacts:materializeStatisticsNumericSurface", { extensionId, input }),
    getNumericSurfaceViewState: (projectId: string, artifactId: string, artifactVersion: number, artifactContentSha256: string) => ipcRenderer.invoke(
      "science:artifacts:getNumericSurfaceViewState", { extensionId, projectId, artifactId, artifactVersion, artifactContentSha256 },
    ),
    persistNumericSurfaceViewState: (input: unknown) => ipcRenderer.invoke("science:artifacts:persistNumericSurfaceViewState", { extensionId, input }),
    exportNumericSurfacePng: (input: unknown) => ipcRenderer.invoke("science:artifacts:exportNumericSurfacePng", { extensionId, input }),
    exportStatisticsFigureSvg: (input: unknown) => ipcRenderer.invoke("science:artifacts:exportStatisticsFigureSvg", { extensionId, input }),
    exportStatisticsFigurePng: (input: unknown) => ipcRenderer.invoke("science:artifacts:exportStatisticsFigurePng", { extensionId, input }),
    exportStatisticsFigurePdf: (input: unknown) => ipcRenderer.invoke("science:artifacts:exportStatisticsFigurePdf", { extensionId, input }),
    exportStatisticsFigureTiff: (input: unknown) => ipcRenderer.invoke("science:artifacts:exportStatisticsFigureTiff", { extensionId, input }),
    onChanged: (callback: (change: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, change: unknown) => callback(change);
      ipcRenderer.on("science:artifactChanged", listener);
      return () => ipcRenderer.removeListener("science:artifactChanged", listener);
    },
  }),
  labs: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:labs:list", { extensionId, projectId }),
    catalog: () => ipcRenderer.invoke("science:labs:catalog", { extensionId }),
    decisionProjections: (projectId: string) => ipcRenderer.invoke("science:labs:decisionProjections", { extensionId, projectId }),
    upsertBinding: (input: unknown) => ipcRenderer.invoke("science:labs:upsertBinding", { extensionId, input }),
  }),
  validations: Object.freeze({
    list: (projectId: string, artifactId: string, artifactVersion?: number) => ipcRenderer.invoke("science:artifactValidations:list", { extensionId, projectId, artifactId, artifactVersion }),
    validate: (input: unknown) => ipcRenderer.invoke("science:artifactValidations:validate", { extensionId, input }),
  }),
  manuscripts: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:manuscripts:list", { extensionId, projectId }),
    get: (projectId: string, manuscriptId: string) => ipcRenderer.invoke("science:manuscripts:get", { extensionId, projectId, manuscriptId }),
    create: (input: unknown) => ipcRenderer.invoke("science:manuscripts:create", { extensionId, input }),
    appendVersion: (input: unknown) => ipcRenderer.invoke("science:manuscripts:appendVersion", { extensionId, input }),
  }),
  claimLedgers: Object.freeze({
    getForManuscript: (projectId: string, manuscriptId: string) => ipcRenderer.invoke("science:claimLedgers:getForManuscript", { extensionId, projectId, manuscriptId }),
  }),
  journals: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:journals:list", { extensionId, projectId }),
    inspectOfficialGuidelines: (input: unknown) => ipcRenderer.invoke("science:journals:inspectOfficialGuidelines", { extensionId, input }),
    confirmIdentity: (input: unknown) => ipcRenderer.invoke("science:journals:confirmIdentity", { extensionId, input }),
    confirmHumanAttestation: (input: unknown) => ipcRenderer.invoke("science:journals:confirmHumanAttestation", { extensionId, input }),
    createProfile: (input: unknown) => ipcRenderer.invoke("science:journals:createProfile", { extensionId, input }),
    validate: (input: unknown) => ipcRenderer.invoke("science:journals:validate", { extensionId, input }),
  }),
  submissions: Object.freeze({
    createExport: (input: unknown) => ipcRenderer.invoke("science:submissions:createExport", { extensionId, input }),
    list: (projectId: string, manuscriptId: string) => ipcRenderer.invoke("science:submissions:list", { extensionId, projectId, manuscriptId }),
    read: (projectId: string, exportId: string) => ipcRenderer.invoke("science:submissions:read", { extensionId, projectId, exportId }),
  }),
  analysisSpecs: Object.freeze({
    list: (projectId: string) => ipcRenderer.invoke("science:analysisSpecs:list", { extensionId, projectId }),
    get: (projectId: string, analysisSpecId: string) => ipcRenderer.invoke("science:analysisSpecs:get", { extensionId, projectId, analysisSpecId }),
  }),
  decisions: Object.freeze({
    list: (projectId: string, analysisSpecId?: string, statuses?: string[]) => ipcRenderer.invoke("science:decisions:list", { extensionId, projectId, analysisSpecId, statuses }),
    get: (projectId: string, decisionId: string) => ipcRenderer.invoke("science:decisions:get", { extensionId, projectId, decisionId }),
    present: (input: unknown) => ipcRenderer.invoke("science:decisions:present", { extensionId, input }),
    defer: (input: unknown) => ipcRenderer.invoke("science:decisions:defer", { extensionId, input }),
    answer: (input: unknown) => ipcRenderer.invoke("science:decisions:answer", { extensionId, input }),
  }),
}));
