// Renderer는 sandbox에 갇혀 있고, 노출하는 IPC만 사용 가능.
// shared/types.ts AgentlasIpc 모양과 1:1 일치해야 한다.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  ToolApprovalDecision,
  ToolApprovalRequestEvent,
  ToolApprovalResolutionReceipt,
  AgentlasIpc,
  RendererJudgmentSpec,
  RendererSubsetJudgmentSpec,
  AskUserRequestEvent,
  BrowserApprovalRequestEvent,
  BugReportInput,
  CloudAgentPublishProgressEvent,
  Automation,
  AutomationCreateInput,
  AutomationGraphReconcileInput,
  AutomationGraphTerminalCloseCandidate,
  AutomationGraphTerminalCloseInput,
  AutomationGraphTerminalCloseReceipt,
  AutomationTriggerEventReconcileInput,
  FsPathGrant,
  FsReadScope,
  McpInvocationEvent,
  McpInvocationRequest,
  MigrationOptions,
  Project,
  RuntimeBackend,
  RuntimeSelection,
  TerminalProfile,
  UsageRetryProviderId,
  UpdaterState,
  WorkflowGraph,
  AutomationUpdatePatch,
  ScheduleSpec,
} from "../shared/types";
import type { PluginBuilderProgressEvent } from "../shared/plugin-builder";
import type {
  SiteActivityEvent,
  SiteAgentAppPublishBackendRequest,
  SiteAgentAppTargetRef,
  SitePublishProvider,
  SitePublishProviderPage,
  SiteSurface,
} from "../shared/site-studio";

const api: AgentlasIpc = {
  app: {
    getLocale: () => ipcRenderer.invoke("app:getLocale"),
    getVersion: () => ipcRenderer.invoke("app:getVersion"),
  },
  media: {
    copyImage: (payload) => ipcRenderer.invoke("media:copyImage", payload),
    saveImage: (payload) => ipcRenderer.invoke("media:saveImage", payload),
  },
  mobileBridge: {
    status: () => ipcRenderer.invoke("mobileBridge:status"),
    issuePairing: () => ipcRenderer.invoke("mobileBridge:issuePairing"),
    listDevices: () => ipcRenderer.invoke("mobileBridge:listDevices"),
    retry: () => ipcRenderer.invoke("mobileBridge:retry"),
    revokeDevice: (deviceId: string) => ipcRenderer.invoke("mobileBridge:revokeDevice", deviceId),
    revealLog: () => ipcRenderer.invoke("mobileBridge:revealLog"),
  },
  productExtensions: {
    scienceStatus: () => ipcRenderer.invoke("productExtensions:scienceStatus"),
    scienceSuiteStatus: () => ipcRenderer.invoke("productExtensions:scienceSuiteStatus"),
    installScience: () => ipcRenderer.invoke("productExtensions:installScience"),
    installScienceSuite: () => ipcRenderer.invoke("productExtensions:installScienceSuite"),
    setScienceEnabled: (enabled: boolean) => ipcRenderer.invoke("productExtensions:setScienceEnabled", enabled),
    uninstallScience: () => ipcRenderer.invoke("productExtensions:uninstallScience"),
    openScienceView: (bounds, leaseId) => ipcRenderer.invoke("productExtensions:openScienceView", bounds, leaseId),
    setScienceViewBounds: (bounds, leaseId) => ipcRenderer.invoke("productExtensions:setScienceViewBounds", bounds, leaseId),
    closeScienceView: (leaseId) => ipcRenderer.invoke("productExtensions:closeScienceView", leaseId),
  },
  judgment: {
    judge: (spec: RendererJudgmentSpec) => ipcRenderer.invoke("judgment:judge", spec),
    judgeSubset: (spec: RendererSubsetJudgmentSpec) => ipcRenderer.invoke("judgment:judgeSubset", spec),
  },
  site: {
    listProjects: () => ipcRenderer.invoke("site:listProjects"),
    operationStatus: (payload: { projectId: string }) => ipcRenderer.invoke("site:operationStatus", payload),
    listConversation: (payload: { projectId: string }) => ipcRenderer.invoke("site:listConversation", payload),
    createProject: (payload: { name: string; surface?: SiteSurface; agentAppTarget?: SiteAgentAppTargetRef }) =>
      ipcRenderer.invoke("site:createProject", payload),
    deleteProject: (payload: { projectId: string }) => ipcRenderer.invoke("site:deleteProject", payload),
    launchAgentApp: (payload: { projectId: string }) => ipcRenderer.invoke("site:launchAgentApp", payload),
    stopAgentApp: (payload: { projectId: string }) => ipcRenderer.invoke("site:stopAgentApp", payload),
    agentAppRuntimeStatus: (payload: { projectId: string }) => ipcRenderer.invoke("site:agentAppRuntimeStatus", payload),
    agentAppMcpRecommendation: (payload: { projectId: string }) => ipcRenderer.invoke("site:agentAppMcpRecommendation", payload),
    reviewAgentAppMcp: (payload: { projectId: string }) => ipcRenderer.invoke("site:reviewAgentAppMcp", payload),
    prebuildReviewAgentAppMcp: (payload: { projectId: string }) => ipcRenderer.invoke("site:prebuildReviewAgentAppMcp", payload),
    agentAppThumbnail: (payload: { projectId: string }) => ipcRenderer.invoke("site:agentAppThumbnail", payload),
    listPublishProviderStatuses: () => ipcRenderer.invoke("site:listPublishProviderStatuses"),
    savePublishProviderToken: (payload: { provider: SitePublishProvider; token: string }) =>
      ipcRenderer.invoke("site:savePublishProviderToken", payload),
    removePublishProviderToken: (payload: { provider: SitePublishProvider }) =>
      ipcRenderer.invoke("site:removePublishProviderToken", payload),
    openPublishProviderPage: (payload: { provider: SitePublishProvider; page: SitePublishProviderPage }) =>
      ipcRenderer.invoke("site:openPublishProviderPage", payload),
    connectPublishProvider: (payload: { provider: SitePublishProvider }) =>
      ipcRenderer.invoke("site:connectPublishProvider", payload),
    publishAgentApp: (payload: SiteAgentAppPublishBackendRequest) =>
      ipcRenderer.invoke("site:publishAgentApp", payload),
    generateScreen: (payload: { projectId: string; brief: string; variants?: number; styleHint?: string; baseScreenId?: string; locale?: "ko" | "en" }) =>
      ipcRenderer.invoke("site:generateScreen", payload),
    editScreen: (payload: { projectId: string; screenId: string; instruction: string; selectionId?: string; selectionContext?: string; locale?: "ko" | "en" }) =>
      ipcRenderer.invoke("site:editScreen", payload),
    readScreen: (payload: { projectId: string; screenId: string }) => ipcRenderer.invoke("site:readScreen", payload),
    prepareRender: (payload: { projectId: string; screenId: string }) => ipcRenderer.invoke("site:prepareRender", payload),
    renameScreen: (payload: { projectId: string; screenId: string; name: string }) => ipcRenderer.invoke("site:renameScreen", payload),
    deleteScreen: (payload: { projectId: string; screenId: string }) => ipcRenderer.invoke("site:deleteScreen", payload),
    captureRect: (payload: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke("site:captureRect", payload),
    exportScreen: (payload: { projectId: string; screenId: string }) => ipcRenderer.invoke("site:exportScreen", payload),
  // 디자인 → 코드: 웹은 react|html, 앱은 flutter|react-native|html|react.
  exportTargets: (payload: { projectId: string }) => ipcRenderer.invoke("site:exportTargets", payload),
  exportScreenCode: (payload: { projectId: string; screenId: string; target: string }) =>
    ipcRenderer.invoke("site:exportScreenCode", payload),
    exportProjectZip: (payload: { projectId: string }) => ipcRenderer.invoke("site:exportProjectZip", payload),
    handoffToWorkspace: (payload: { projectId: string; workspaceGrant: import("../shared/types").FsPathGrant; locale?: "ko" | "en" }) =>
      ipcRenderer.invoke("site:handoffToWorkspace", payload),
    contentAvailable: () => ipcRenderer.invoke("site:contentAvailable"),
  },
  document: {
    exportPdf: (payload) => ipcRenderer.invoke("document:exportPdf", payload),
    pdfCapability: () => ipcRenderer.invoke("document:pdfCapability"),
    generate: (payload: {
      goal: string;
      mode?: "report" | "paper" | "brief";
      locale?: "ko" | "en";
      sources?: { authors?: string; title: string; year?: string; container?: string }[];
    }) => ipcRenderer.invoke("document:generate", payload),
    revise: (payload: { text: string; action: "expand" | "rewrite" | "shorten" | "improve" | "formal" | "casual"; locale?: "ko" | "en" }) =>
      ipcRenderer.invoke("document:revise", payload),
    available: () => ipcRenderer.invoke("document:available"),
  },
  support: {
    submitBugReport: (payload: BugReportInput) => ipcRenderer.invoke("support:submitBugReport", payload),
  },
  menu: {
    setLocale: (locale: "ko" | "en") => ipcRenderer.invoke("menu:setLocale", locale),
  },
  fs: {
    pickDirectory: () => ipcRenderer.invoke("fs:pickDirectory"),
    listDirectory: (absPath: string, scope: FsReadScope, showHidden?: boolean) =>
      ipcRenderer.invoke("fs:listDirectory", absPath, scope, showHidden ?? false),
    readTextFile: (absPath: string, scope: FsReadScope) => ipcRenderer.invoke("fs:readTextFile", absPath, scope),
    watchFile: (absPath: string, scope: FsReadScope) => ipcRenderer.invoke("fs:watchFile", absPath, scope),
    unwatchFile: (watchId: string) => ipcRenderer.invoke("fs:unwatchFile", watchId),
    onFileChanged: (handler) => {
      const wrapped = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof handler>[0]) => handler(snapshot);
      ipcRenderer.on("fs:fileChanged", wrapped);
      return () => ipcRenderer.removeListener("fs:fileChanged", wrapped);
    },
    openPath: (target: string) => ipcRenderer.invoke("fs:openPath", target),
    showItemInFolder: (target: string) => ipcRenderer.invoke("fs:showItemInFolder", target),
    saveTextFile: (suggestedName: string, content: string) =>
      ipcRenderer.invoke("fs:saveTextFile", suggestedName, content),
  },
  workspace: {
    selectFolder: () => ipcRenderer.invoke("workspace:selectFolder"),
    get: (chatId: string) => ipcRenderer.invoke("workspace:get", chatId),
    set: (chatId: string, grant: FsPathGrant | null) =>
      ipcRenderer.invoke("workspace:set", chatId, grant),
    setFromProject: (chatId: string, projectId: string) =>
      ipcRenderer.invoke("workspace:setFromProject", chatId, projectId),
    defaultRunFolder: () => ipcRenderer.invoke("workspace:defaultRunFolder"),
  },
  auth: {
    getSession: () => ipcRenderer.invoke("auth:getSession"),
    signInWithGoogle: () => ipcRenderer.invoke("auth:signInWithGoogle"),
    signInWithBrowser: () => ipcRenderer.invoke("auth:signInWithBrowser"),
    signOut: () => ipcRenderer.invoke("auth:signOut"),
    onSessionChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, session: Parameters<typeof callback>[0]) => callback(session);
      ipcRenderer.on("auth:sessionChanged", listener);
      return () => ipcRenderer.removeListener("auth:sessionChanged", listener);
    },
  },
  usage: {
    snapshot: (opts?: { force?: boolean }) => ipcRenderer.invoke("usage:snapshot", opts),
    retry: (providerId: UsageRetryProviderId) => ipcRenderer.invoke("usage:retry", providerId),
  },
  billing: {
    getCredits: () => ipcRenderer.invoke("billing:getCredits"),
    transferEarnings: (credits: number) => ipcRenderer.invoke("billing:transferEarnings", credits),
  },
  promptHub: {
    list: (params?: { q?: string; category?: string }) => ipcRenderer.invoke("promptHub:list", params),
    get: (slug: string) => ipcRenderer.invoke("promptHub:get", slug),
    unlock: (input: { slug: string; unlockIntentId: string }) => ipcRenderer.invoke("promptHub:unlock", input),
    unlockStatus: (input: { slug: string; unlockIntentId: string }) => ipcRenderer.invoke("promptHub:unlockStatus", input),
    taste: (input: { slug: string; tasteIntentId: string }) => ipcRenderer.invoke("promptHub:taste", input),
    tasteStatus: (input: { slug: string; tasteIntentId: string }) => ipcRenderer.invoke("promptHub:tasteStatus", input),
    startChat: (input: { intentId: string; body: string; seedOnly?: boolean }) => ipcRenderer.invoke("promptHub:startChat", input),
    tastes: () => ipcRenderer.invoke("promptHub:tastes"),
    bookmarks: () => ipcRenderer.invoke("promptHub:bookmarks"),
    bookmarkAdd: (slug: string) => ipcRenderer.invoke("promptHub:bookmarkAdd", slug),
    bookmarkRemove: (slug: string) => ipcRenderer.invoke("promptHub:bookmarkRemove", slug),
  },
  quests: {
    list: () => ipcRenderer.invoke("quests:list"),
    claim: (input: { questId: string; claimIntentId: string }) => ipcRenderer.invoke("quests:claim", input),
    claimStatus: (input: { questId: string; claimIntentId: string }) => ipcRenderer.invoke("quests:claimStatus", input),
  },
  agentMemory: {
    entries: (agentId: string, limit?: number) => ipcRenderer.invoke("agentMemory:entries", agentId, limit),
    importPreview: (agentId: string, sourcePath?: string) =>
      ipcRenderer.invoke("memory:import-preview", agentId, sourcePath),
    importApply: (agentId: string, sourcePath: string) =>
      ipcRenderer.invoke("memory:import-apply", agentId, sourcePath),
  },
  agentLearning: {
    summary: (agentId: string) => ipcRenderer.invoke("agentLearning:summary", agentId),
  },
  agents: {
    usageSummary: () => ipcRenderer.invoke("agents:usage-summary"),
    exactBindings: () => ipcRenderer.invoke("agents:exact-bindings"),
    borrowedProfiles: () => ipcRenderer.invoke("agents:borrowed-profiles"),
    borrowedOntologyGraph: (profileId: string) =>
      ipcRenderer.invoke("agents:borrowed-ontology-graph", profileId),
    setBookmark: (agentId: string, bookmarked: boolean) =>
      ipcRenderer.invoke("agents:set-bookmark", agentId, bookmarked),
  },
  experience: {
    hubCatalog: () => ipcRenderer.invoke("experience:hubCatalog"),
    createPack: (input) => ipcRenderer.invoke("experience:createPack", input),
    listPacks: (input) => ipcRenderer.invoke("experience:listPacks", input),
    ontologySummary: (agentId: string) => ipcRenderer.invoke("experience:ontologySummary", agentId),
    ontologyGraph: (agentId: string) => ipcRenderer.invoke("experience:ontologyGraph", agentId),
    hubProjection: (agentId: string, force?: boolean) =>
      ipcRenderer.invoke("experience:hubProjection", agentId, force === true),
    hubResolveAttach: (agentId, approvalId, decision) =>
      ipcRenderer.invoke("experience:hubResolveAttach", agentId, approvalId, decision),
    captureFromMemory: (input) => ipcRenderer.invoke("experience:captureFromMemory", input),
    listCandidates: (packId: string) => ipcRenderer.invoke("experience:listCandidates", packId),
    listOperationalPublicProjections: (packId: string) =>
      ipcRenderer.invoke("experience:listOperationalPublicProjections", packId),
    saveOperationalPublicProjection: (input) =>
      ipcRenderer.invoke("experience:saveOperationalPublicProjection", input),
    confirmOperationalPublicProjection: (input) =>
      ipcRenderer.invoke("experience:confirmOperationalPublicProjection", input),
    listTasteDrafts: (agentId: string) => ipcRenderer.invoke("experience:listTasteDrafts", agentId),
    listTasteWorkflows: (agentId: string) => ipcRenderer.invoke("experience:listTasteWorkflows", agentId),
    saveTasteGeneralization: (input) => ipcRenderer.invoke("experience:saveTasteGeneralization", input),
    confirmTasteGeneralization: (input) => ipcRenderer.invoke("experience:confirmTasteGeneralization", input),
    pickTastePreviews: () => ipcRenderer.invoke("experience:pickTastePreviews"),
    prepareTastePreviews: (input) => ipcRenderer.invoke("experience:prepareTastePreviews", input),
    uploadTasteDraft: (input) => ipcRenderer.invoke("experience:uploadTasteDraft", input),
    promote: (input) => ipcRenderer.invoke("experience:promote", input),
    unsealPublic: (input) => ipcRenderer.invoke("experience:unsealPublic", input),
    intakeDiagnostics: (agentId: string) => ipcRenderer.invoke("experience:intake-diagnostics", agentId),
    listPromotionReceipts: (packId: string) => ipcRenderer.invoke("experience:listPromotionReceipts", packId),
    createExportIntent: (input) => ipcRenderer.invoke("experience:createExportIntent", input),
    listExportIntents: (packId: string) => ipcRenderer.invoke("experience:listExportIntents", packId),
    cloudSave: (input) => ipcRenderer.invoke("experience:cloudSave", input),
    cloudList: (packId: string) => ipcRenderer.invoke("experience:cloudList", packId),
    cloudReconcile: (input) => ipcRenderer.invoke("experience:cloudReconcile", input),
    cloudExport: (input) => ipcRenderer.invoke("experience:cloudExport", input),
    cloudWithdraw: (input) => ipcRenderer.invoke("experience:cloudWithdraw", input),
  },
  memoryDreaming: {
    status: () => ipcRenderer.invoke("memoryDreaming:status"),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke("memoryDreaming:setEnabled", enabled),
  },
  confirm: {
    listPending: () => ipcRenderer.invoke("confirm:listPending"),
    commitAnswer: (input: {
      chatId: string;
      reply: string;
      sourceMessageId?: string;
      continuation?: {
        locale?: "ko" | "en";
        permissions?: "read" | "write" | "full";
        sessionRouting?: boolean;
        runtimeSelection?: unknown;
      };
    }) =>
      ipcRenderer.invoke("confirm:commitAnswer", input),
    continueAnswer: (input: { chatId: string; sourceMessageId: string; reply: string }) =>
      ipcRenderer.invoke("confirm:continueAnswer", input),
    snooze: (input: { chatId: string; sourceMessageId: string; resumeAt: string }) =>
      ipcRenderer.invoke("confirm:snooze", input),
    committedAnswers: (chatId: string) => ipcRenderer.invoke("confirm:committedAnswers", chatId),
    // 동기 질문의 답. `null` 은 "답하지 않음"이며, 지어낸 답으로 채우지 않는다.
    submitAskUserAnswer: (requestId: string, answer: string | null) =>
      ipcRenderer.invoke("confirm:submitAskUserAnswer", requestId, answer),
  },
  attention: {
    setPendingConfirmations: (count: number) =>
      ipcRenderer.invoke("attention:setPendingConfirmations", count),
  },
  updater: {
    getState: () => ipcRenderer.invoke("updater:getState"),
    check: () => ipcRenderer.invoke("updater:check"),
    install: () => ipcRenderer.invoke("updater:install"),
    openManualDownload: () => ipcRenderer.invoke("updater:openManualDownload"),
    openReleaseNotes: (version?: string) => ipcRenderer.invoke("updater:openReleaseNotes", version),
    revealRecoveryBackup: () => ipcRenderer.invoke("updater:revealRecoveryBackup"),
  },
  runtime: {
    detect: (force?: boolean) => ipcRenderer.invoke("runtime:detect", force === true),
    setActive: (selection: RuntimeSelection) =>
      ipcRenderer.invoke("runtime:setActive", selection),
    installCli: (kind: "claude-code" | "codex" | "kimi" | "grok") =>
      ipcRenderer.invoke("runtime:installCli", kind),
    openCliLogin: (kind: "claude-code" | "codex" | "antigravity" | "kimi" | "grok") =>
      ipcRenderer.invoke("runtime:openCliLogin", kind),
    updateCli: (kind: "claude-code" | "codex" | "antigravity" | "kimi" | "grok") =>
      ipcRenderer.invoke("runtime:updateCli", kind),
    listCommands: () => ipcRenderer.invoke("runtime:listCommands"),
    listModels: (sel) => ipcRenderer.invoke("runtime:listModels", sel),
    listRoleMembers: () => ipcRenderer.invoke("runtime:listRoleMembers"),
    setRoleMembers: (role, selections) =>
      ipcRenderer.invoke("runtime:setRoleMembers", role, selections),
  },
  agentRuntime: {
    list: () => ipcRenderer.invoke("agentRuntime:list"),
    get: (scope, targetId) => ipcRenderer.invoke("agentRuntime:get", scope, targetId),
    set: (input) => ipcRenderer.invoke("agentRuntime:set", input),
    remove: (scope, targetId) => ipcRenderer.invoke("agentRuntime:remove", scope, targetId),
  },
  config: {
    getCustomBaseUrl: () => ipcRenderer.invoke("config:getCustomBaseUrl"),
    setCustomBaseUrl: (url: string) => ipcRenderer.invoke("config:setCustomBaseUrl", url),
    getTerminalProfiles: () => ipcRenderer.invoke("config:getTerminalProfiles"),
    setTerminalProfiles: (profiles: TerminalProfile[]) =>
      ipcRenderer.invoke("config:setTerminalProfiles", profiles),
  },
  secrets: {
    saveApiKey: (backend: RuntimeBackend, key: string) =>
      ipcRenderer.invoke("secrets:saveApiKey", backend, key),
    hasApiKey: (backend: RuntimeBackend) =>
      ipcRenderer.invoke("secrets:hasApiKey", backend),
    deleteApiKey: (backend: RuntimeBackend) =>
      ipcRenderer.invoke("secrets:deleteApiKey", backend),
  },
  env: {
    list: () => ipcRenderer.invoke("env:list"),
    set: (key: string, value: string) => ipcRenderer.invoke("env:set", key, value),
    has: (key: string) => ipcRenderer.invoke("env:has", key),
    preview: (key: string) => ipcRenderer.invoke("env:preview", key),
    remove: (key: string) => ipcRenderer.invoke("env:remove", key),
  },
  credentialRecovery: {
    list: () => ipcRenderer.invoke("credentialRecovery:list"),
    retry: (retryToken: string) => ipcRenderer.invoke("credentialRecovery:retry", retryToken),
  },
  runAlerts: {
    get: () => ipcRenderer.invoke("runAlerts:get"),
    set: (patch: unknown) => ipcRenderer.invoke("runAlerts:set", patch),
    preview: () => ipcRenderer.invoke("runAlerts:preview"),
  },
  multimodal: {
    listProviders: () => ipcRenderer.invoke("multimodal:listProviders"),
    getSettings: () => ipcRenderer.invoke("multimodal:getSettings"),
    saveSettings: (settings) => ipcRenderer.invoke("multimodal:saveSettings", settings),
    status: () => ipcRenderer.invoke("multimodal:status"),
    // 생성 — Oberon/T-rex 스튜디오에서 적출한 실행 엔진(2026-08-21).
    generateImage: (payload: { model?: "codex" | "gemini" | "auto"; prompt: string }) =>
      ipcRenderer.invoke("multimodal:generateImage", payload),
    imageProviders: () => ipcRenderer.invoke("multimodal:imageProviders"),
    startVideo: (request) => ipcRenderer.invoke("multimodal:startVideo", request),
    getVideoJob: (id: string) => ipcRenderer.invoke("multimodal:getVideoJob", id),
    cancelVideo: (id: string) => ipcRenderer.invoke("multimodal:cancelVideo", id),
    openVideoOutput: (id: string) => ipcRenderer.invoke("multimodal:openVideoOutput", id),
    videoKeyStatus: () => ipcRenderer.invoke("multimodal:videoKeyStatus"),
  },
  team: {
    list: () => ipcRenderer.invoke("team:list"),
    install: (slug: string) => ipcRenderer.invoke("team:install", slug),
    installMine: (id: string) => ipcRenderer.invoke("team:installMine", id),
    uninstall: (id: string, options?: { removeSource?: boolean }) =>
      ipcRenderer.invoke("team:uninstall", id, options),
    uninstallPreview: (id: string) => ipcRenderer.invoke("team:uninstallPreview", id),
    setLocalDisplayName: (id: string, value: string) =>
      ipcRenderer.invoke("team:setLocalDisplayName", id, value),
    importLocalFolder: (input) =>
      ipcRenderer.invoke("team:importLocalFolder", input),
    resolveSubAgents: (agentId: string) => ipcRenderer.invoke("team:resolveSubAgents", agentId),
  },
  oneOrg: {
    get: () => ipcRenderer.invoke("oneOrg:get"),
    createAgent: (input) => ipcRenderer.invoke("oneOrg:createAgent", input),
    add: (input) => ipcRenderer.invoke("oneOrg:add", input),
    rename: (input) => ipcRenderer.invoke("oneOrg:rename", input),
    update: (input) => ipcRenderer.invoke("oneOrg:update", input),
    replace: (input) => ipcRenderer.invoke("oneOrg:replace", input),
    archive: (input) => ipcRenderer.invoke("oneOrg:archive", input),
    restore: (input) => ipcRenderer.invoke("oneOrg:restore", input),
    markRead: (input) => ipcRenderer.invoke("oneOrg:markRead", input),
    reorder: (input) => ipcRenderer.invoke("oneOrg:reorder", input),
    setTools: (input) => ipcRenderer.invoke("oneOrg:setTools", input),
  },
  oneTaskforces: {
    list: () => ipcRenderer.invoke("oneTaskforces:list"),
    create: (input) => ipcRenderer.invoke("oneTaskforces:create", input),
    update: (input) => ipcRenderer.invoke("oneTaskforces:update", input),
    remove: (input) => ipcRenderer.invoke("oneTaskforces:remove", input),
    removePreview: (input) => ipcRenderer.invoke("oneTaskforces:removePreview", input),
  },
  seats: {
    forChat: (chatId: string) => ipcRenderer.invoke("seats:forChat", chatId),
    historyForChat: (chatId: string) => ipcRenderer.invoke("seats:historyForChat", chatId),
    assign: (input) => ipcRenderer.invoke("seats:assign", input),
  },
  computerHistory: {
    get: () => ipcRenderer.invoke("computerHistory:get"),
    setConsent: (enabled: boolean) => ipcRenderer.invoke("computerHistory:setConsent", enabled),
    clear: () => ipcRenderer.invoke("computerHistory:clear"),
    prepareDraft: (recommendationId: string, locale: "ko" | "en") =>
      ipcRenderer.invoke("computerHistory:prepareDraft", recommendationId, locale),
  },
  agentFiles: {
    list: (agentId: string) => ipcRenderer.invoke("agentFiles:list", agentId),
    read: (agentId: string, absPath: string) =>
      ipcRenderer.invoke("agentFiles:read", agentId, absPath),
    write: (agentId: string, absPath: string, content: string) =>
      ipcRenderer.invoke("agentFiles:write", agentId, absPath, content),
    promptSource: (agentId: string) => ipcRenderer.invoke("agentFiles:promptSource", agentId),
  },
  runLedger: {
    events: (runId: string, limit?: number) => ipcRenderer.invoke("runLedger:events", runId, limit),
    chatTimeline: (chatId: string, input?: { maxRuns?: number; eventsPerRun?: number }) =>
      ipcRenderer.invoke("runLedger:chatTimeline", chatId, input),
    failures: (input?: { runId?: string; automationId?: string; chatId?: string; agentId?: string; limit?: number }) =>
      ipcRenderer.invoke("runLedger:failures", input),
  },
  agentEvolution: {
    list: (agentId: string, limit?: number) =>
      ipcRenderer.invoke("agentEvolution:list", agentId, limit),
    createProposal: (input) =>
      ipcRenderer.invoke("agentEvolution:createProposal", input),
    approveAndApply: (proposalId: string, note?: string) =>
      ipcRenderer.invoke("agentEvolution:approveAndApply", proposalId, note),
    reject: (proposalId: string, note?: string) =>
      ipcRenderer.invoke("agentEvolution:reject", proposalId, note),
    markMeasured: (proposalId: string, note?: string) =>
      ipcRenderer.invoke("agentEvolution:markMeasured", proposalId, note),
    rollback: (proposalId: string) =>
      ipcRenderer.invoke("agentEvolution:rollback", proposalId),
    listGrowth: (limit?: number) =>
      ipcRenderer.invoke("agentEvolution:listGrowth", limit),
    deleteGrowthSession: (proposalId: string) =>
      ipcRenderer.invoke("agentEvolution:deleteGrowthSession", proposalId),
  },
  // 엔진 텍스트 자산(스킬·훅·어댑터 매니페스트) 직접 편집.
  runtimeFiles: {
    list: () => ipcRenderer.invoke("runtimeFiles:list"),
    read: (relPath: string) => ipcRenderer.invoke("runtimeFiles:read", relPath),
    write: (relPath: string, content: string) => ipcRenderer.invoke("runtimeFiles:write", relPath, content),
  },
  skills: {
    listCatalog: () => ipcRenderer.invoke("skills:listCatalog"),
    readCatalog: (slug: string) => ipcRenderer.invoke("skills:readCatalog", slug),
  },
  mcpTools: {
    listCatalog: () => ipcRenderer.invoke("mcpTools:listCatalog"),
    brandMap: () => ipcRenderer.invoke("mcpTools:brandMap"),
    listInstalled: () => ipcRenderer.invoke("mcpTools:listInstalled"),
    install: (catalogId: string) => ipcRenderer.invoke("mcpTools:install", catalogId),
    installCustom: (def) => ipcRenderer.invoke("mcpTools:installCustom", def),
    remove: (id: string) => ipcRenderer.invoke("mcpTools:remove", id),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("mcpTools:setEnabled", id, enabled),
    // Hub 플러그인 — 미리보기로 "무엇이 실행되는가"를 먼저 보여주고, 설치는 사람이
    // 그 화면에서 누른 승인(approveLocalExecution)이 있을 때만 로컬 실행을 켠다.
    previewHubPlugin: (manifestUrl: string) =>
      ipcRenderer.invoke("mcpTools:previewHubPlugin", manifestUrl),
    installHubPlugin: (input: { slug: string; manifestUrl: string; approveLocalExecution?: boolean }) =>
      ipcRenderer.invoke("mcpTools:installHubPlugin", input),
    pendingHubApprovals: () => ipcRenderer.invoke("mcpTools:pendingHubApprovals"),
    oauthStatus: (serverId: string) => ipcRenderer.invoke("mcpTools:oauthStatus", serverId),
    oauthConnect: (serverId: string) => ipcRenderer.invoke("mcpTools:oauthConnect", serverId),
    oauthDisconnect: (serverId: string) => ipcRenderer.invoke("mcpTools:oauthDisconnect", serverId),
    test: (id: string) => ipcRenderer.invoke("mcpTools:test", id),
    status: () => ipcRenderer.invoke("mcpTools:status"),
    recommendForBuild: (input) => ipcRenderer.invoke("mcpTools:recommendForBuild", input),
    // 실행 전 키 요청 시트 완료 신호 — outcome만 전달, 비밀 값은 env.set 경유(vault).
    supplyRunKeys: (runId: string, outcome: "provided" | "declined") =>
      ipcRenderer.invoke("mcp:supplyRunKeys", runId, outcome),
  },
  openCrab: {
    readiness: () => ipcRenderer.invoke("openCrab:readiness"),
  },
  marketplace: {
    listBundles: () => ipcRenderer.invoke("marketplace:listBundles"),
    search: (q: string) => ipcRenderer.invoke("marketplace:search", q),
    listFirms: () => ipcRenderer.invoke("marketplace:listFirms"),
    status: (force?: boolean) => ipcRenderer.invoke("marketplace:status", force === true),
    listMine: () => ipcRenderer.invoke("marketplace:listMine"),
    deleteMine: (slug: string) => ipcRenderer.invoke("marketplace:deleteMine", slug),
    bookmarks: () => ipcRenderer.invoke("marketplace:bookmarks"),
    // 허브 소개 페이지 임베드 — 렌더러는 "어디에 놓을지"만 정하고, 페이지 자체는 main이 띄운다.
    openProfileView: (input) => ipcRenderer.invoke("marketplace:openProfileView", input),
    setProfileViewBounds: (bounds) => ipcRenderer.invoke("marketplace:setProfileViewBounds", bounds),
    closeProfileView: () => ipcRenderer.invoke("marketplace:closeProfileView"),
    // 임베드 안에서 웹의 다른 화면으로 나가려 했다는 신호 — 데스크탑 허브로 되돌린다.
    onProfileViewExit: (handler) => {
      const wrapped = () => handler();
      ipcRenderer.on("marketplace:profileViewExit", wrapped);
      return () => ipcRenderer.removeListener("marketplace:profileViewExit", wrapped);
    },
    syncBookmarks: () => ipcRenderer.invoke("marketplace:bookmarksSync"),
    onBookmarksSnapshot: (handler) => {
      const wrapped = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof handler>[0]) =>
        handler(snapshot);
      ipcRenderer.on("marketplace:bookmarksSnapshot", wrapped);
      return () => ipcRenderer.removeListener("marketplace:bookmarksSnapshot", wrapped);
    },
    bookmarkAdd: (listing) => ipcRenderer.invoke("marketplace:bookmarkAdd", listing),
    bookmarkRemove: (slug: string, entityKind?: string) =>
      ipcRenderer.invoke("marketplace:bookmarkRemove", slug, entityKind),
  },
  cloudAgents: {
    listRegisteredUploadOptions: () => ipcRenderer.invoke("cloudAgents:listRegisteredUploadOptions"),
    saveRegisteredPrivate: (input) => ipcRenderer.invoke("cloudAgents:saveRegisteredPrivate", input),
    publishRegisteredPublic: (input) => ipcRenderer.invoke("cloudAgents:publishRegisteredPublic", input),
    savePrivate: (input) => ipcRenderer.invoke("cloudAgents:savePrivate", input),
    saveBuiltPrivate: (input) => ipcRenderer.invoke("cloudAgents:saveBuiltPrivate", input),
    publishPublic: (input) => ipcRenderer.invoke("cloudAgents:publishPublic", input),
    publish: (input) => ipcRenderer.invoke("cloudAgents:publish", input),
    readPrices: (slug: string) => ipcRenderer.invoke("cloudAgents:readPrices", slug),
    setPrices: (input) => ipcRenderer.invoke("cloudAgents:setPrices", input),
    onProgress: (handler) => {
      const listener = (_event: unknown, payload: CloudAgentPublishProgressEvent) => handler(payload);
      ipcRenderer.on("cloudAgents:progress", listener);
      return () => ipcRenderer.removeListener("cloudAgents:progress", listener);
    },
  },
  firms: {
    list: () => ipcRenderer.invoke("firms:list"),
    get: (id: string) => ipcRenderer.invoke("firms:get", id),
    install: (slug: string) => ipcRenderer.invoke("firms:install", slug),
    uninstall: (id: string, options?: { removeMembers?: boolean; removeSource?: boolean }) =>
      ipcRenderer.invoke("firms:uninstall", id, options),
    getResolvedOrg: (id: string) => ipcRenderer.invoke("firms:getResolvedOrg", id),
    resolveOrg: (id: string) => ipcRenderer.invoke("firms:resolveOrg", id),
  },
  telegram: {
    listBindings: () => ipcRenderer.invoke("telegram:listBindings"),
    connectOne: (input) => ipcRenderer.invoke("telegram:connectOne", input),
    removeLegacy: (input) => ipcRenderer.invoke("telegram:removeLegacy", input),
    autoConnect: (input) => ipcRenderer.invoke("telegram:autoConnect", input),
    start: (input) => ipcRenderer.invoke("telegram:start", input),
    clone: (input) => ipcRenderer.invoke("telegram:clone", input),
    importTerminal: (id: string) => ipcRenderer.invoke("telegram:importTerminal", id),
    resume: (id: string) => ipcRenderer.invoke("telegram:resume", id),
    stop: (id: string) => ipcRenderer.invoke("telegram:stop", id),
    remove: (id: string, deleteBot?: boolean) => ipcRenderer.invoke("telegram:remove", id, deleteBot),
    resetConversation: (id: string) => ipcRenderer.invoke("telegram:resetConversation", id),
    sendTest: (id: string) => ipcRenderer.invoke("telegram:sendTest", id),
    openBot: (id: string) => ipcRenderer.invoke("telegram:openBot", id),
    configureBotSettings: (id: string) => ipcRenderer.invoke("telegram:configureBotSettings", id),
    pruneOrphans: () => ipcRenderer.invoke("telegram:pruneOrphans"),
  },
  // 도구 승인 결정 — live 요청은 이 호출이 대기 중인 실행을 풀고,
  // post-denial 은 다음 실행의 허용 범위에만 반영된다.
  resolveToolApproval: (id: string, decision: ToolApprovalDecision, actionId: string) =>
    ipcRenderer.invoke("runtime:resolveToolApproval", id, decision, actionId),
  getToolApprovalResolution: (id: string) =>
    ipcRenderer.invoke("runtime:getToolApprovalResolution", id),
  listToolApprovals: () => ipcRenderer.invoke("runtime:listToolApprovals"),
  // 데몬 자동 시작(로그인 기동) — 기본 off. 값 변경 시 main 이 부팅 항목까지 정합시킨다.
  getDaemonAutostart: () => ipcRenderer.invoke("daemon:getAutostart"),
  setDaemonAutostart: (enabled: boolean) => ipcRenderer.invoke("daemon:setAutostart", enabled),
  // 능력 규칙(capability grants) — "항상 허용"의 영구 원장 + 대화 단위 "항상 승인" 이관처.
  listCapabilityGrants: (scope?: string) => ipcRenderer.invoke("capability:listGrants", scope),
  revokeCapabilityGrant: (id: number) => ipcRenderer.invoke("capability:revokeGrant", id),
  listAlwaysApprovedChats: () => ipcRenderer.invoke("capability:listAlwaysApprovedChats"),
  grantChatAlwaysApproval: (chatId: string) => ipcRenderer.invoke("capability:grantChatAlwaysApproval", chatId),
  revokeChatAlwaysApproval: (chatId: string) => ipcRenderer.invoke("capability:revokeChatAlwaysApproval", chatId),
  browser: {
    status: () => ipcRenderer.invoke("browser:status"),
    listSites: () => ipcRenderer.invoke("browser:listSites"),
    saveSite: (input) => ipcRenderer.invoke("browser:saveSite", input),
    deleteSite: (site: string) => ipcRenderer.invoke("browser:deleteSite", site),
    openLogin: (site: string) => ipcRenderer.invoke("browser:openLogin", site),
    markSession: (site: string, status) => ipcRenderer.invoke("browser:markSession", site, status),
    scanCredentials: (profileId?: string | null) => ipcRenderer.invoke("browser:scanCredentials", profileId ?? null),
    importCredentials: (profileId: string, domains: string[]) =>
      ipcRenderer.invoke("browser:importCredentials", profileId, domains),
    credentialConsent: () => ipcRenderer.invoke("browser:credentialConsent"),
    revokeCredentialConsent: () => ipcRenderer.invoke("browser:revokeCredentialConsent"),
    refreshCredentials: () => ipcRenderer.invoke("browser:refreshCredentials"),
    listPermissions: () => ipcRenderer.invoke("browser:listPermissions"),
    revokePermission: (site: string, actionType: string) =>
      ipcRenderer.invoke("browser:revokePermission", site, actionType),
    resolveApproval: (requestId: string, decision) =>
      ipcRenderer.invoke("browser:resolveApproval", requestId, decision),
    listLogs: (limit?: number) => ipcRenderer.invoke("browser:listLogs", limit),
    captureLiveFrame: (preferredUrl?: string, viewport?: "desktop" | "phone") =>
      ipcRenderer.invoke("browser:captureLiveFrame", preferredUrl, viewport),
    captureTaskFrame: (chatId: string) => ipcRenderer.invoke("browser:captureTaskFrame", chatId),
    startLiveView: (preferredUrl: string, viewport?: "desktop" | "phone") =>
      ipcRenderer.invoke("browser:startLiveView", preferredUrl, viewport),
    stopLiveView: (sessionId: string) => ipcRenderer.invoke("browser:stopLiveView", sessionId),
    dispatchLiveInput: (input) => ipcRenderer.invoke("browser:dispatchLiveInput", input),
    onLiveFrame: (handler) => {
      const wrapped = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof handler>[0]) => handler(frame);
      ipcRenderer.on("browser:liveFrame", wrapped);
      return () => ipcRenderer.removeListener("browser:liveFrame", wrapped);
    },
    focusLiveTarget: (targetId?: string) => ipcRenderer.invoke("browser:focusLiveTarget", targetId),
  },
  computerUse: {
    capturePreview: (sourceId?: string, options?: { mode?: "screen" | "window" }) =>
      ipcRenderer.invoke("computerUse:capturePreview", sourceId, options),
    revealPreview: () => ipcRenderer.invoke("computerUse:revealPreview"),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    createFromWorkspace: (input) => ipcRenderer.invoke("projects:createFromWorkspace", input),
    get: (id: string) => ipcRenderer.invoke("projects:get", id),
    timeline: (id: string, limit?: number) => ipcRenderer.invoke("projects:timeline", id, limit),
    create: (input) => ipcRenderer.invoke("projects:create", input),
    update: (id: string, patch: Partial<Pick<Project, "name" | "systemPrompt" | "agentPool" | "sourceType" | "sourceRef">> & { folderGrant?: FsPathGrant | null }) =>
      ipcRenderer.invoke("projects:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("projects:remove", id),
    connectGithub: (repositoryUrl: string) => ipcRenderer.invoke("projects:connectGithub", repositoryUrl),
    listRentAllowed: (projectId: string) => ipcRenderer.invoke("projects:listRentAllowed", projectId),
    setRentAllowed: (input) => ipcRenderer.invoke("projects:setRentAllowed", input),
  },
  agentLeases: {
    quote: (slug: string) => ipcRenderer.invoke("agentLeases:quote", slug),
    purchase: (input) => ipcRenderer.invoke("agentLeases:purchase", input),
    list: () => ipcRenderer.invoke("agentLeases:list"),
  },
  ontology: {
    getProject: (projectId: string) => ipcRenderer.invoke("ontology:getProject", projectId),
    provision: (projectId: string) => ipcRenderer.invoke("ontology:provision", projectId),
    sync: (projectId: string) => ipcRenderer.invoke("ontology:sync", projectId),
    addSource: (projectId, absPath, scope, kind) =>
      ipcRenderer.invoke("ontology:addSource", projectId, absPath, scope, kind),
    openInbox: (projectId: string) => ipcRenderer.invoke("ontology:openInbox", projectId),
  },
  chats: {
    listRecent: (limit?: number) => ipcRenderer.invoke("chats:listRecent", limit),
    /** One 홈 전용 목록 — Work 대화가 One 대화를 밀어내지 않게 DB 에서 거른다. */
    listRecentOne: (limit?: number) => ipcRenderer.invoke("chats:listRecentOne", limit),
    listArchived: () => ipcRenderer.invoke("chats:listArchived"),
    listByProject: (projectId: string) =>
      ipcRenderer.invoke("chats:listByProject", projectId),
    listByFirm: (firmId: string) => ipcRenderer.invoke("chats:listByFirm", firmId),
    get: (id: string) => ipcRenderer.invoke("chats:get", id),
    create: (input) => ipcRenderer.invoke("chats:create", input),
    appendOneUserMessage: (id: string, text: string) =>
      ipcRenderer.invoke("chats:appendOneUserMessage", id, text),
    openOneMember: (input) => ipcRenderer.invoke("chats:openOneMember", input),
    rename: (id: string, title: string) => ipcRenderer.invoke("chats:rename", id, title),
    archive: (id: string) => ipcRenderer.invoke("chats:archive", id),
    unarchive: (id: string) => ipcRenderer.invoke("chats:unarchive", id),
    remove: (id: string) => ipcRenderer.invoke("chats:remove", id),
    setContinuousMode: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("chats:setContinuousMode", id, enabled),
    setGoalMode: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("chats:setGoalMode", id, enabled),
    getGoalContext: (id: string) => ipcRenderer.invoke("chats:getGoalContext", id),
    defineGoal: (id: string, objective: string, locale?: "ko" | "en") =>
      ipcRenderer.invoke("chats:defineGoal", id, objective, locale),
    pauseGoal: (id: string, goalId: string) => ipcRenderer.invoke("chats:pauseGoal", id, goalId),
    deleteGoal: (id: string, goalId: string) => ipcRenderer.invoke("chats:deleteGoal", id, goalId),
    resumeGoal: (id: string, expectedVersion: number, expectedGoalId: string) =>
      ipcRenderer.invoke("chats:resumeGoal", id, expectedVersion, expectedGoalId),
    setSwarmMode: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("chats:setSwarmMode", id, enabled),
    setRuntimeSelection: (id: string, selection: RuntimeSelection | null) =>
      ipcRenderer.invoke("chats:setRuntimeSelection", id, selection),
    recap: (id: string) => ipcRenderer.invoke("chats:recap", id),
    markViewed: (id: string) => ipcRenderer.invoke("chats:markViewed", id),
  },
  externalCliSessions: {
    list: (input) => ipcRenderer.invoke("externalCliSessions:list", input),
    importToProject: (input) => ipcRenderer.invoke("externalCliSessions:importToProject", input),
  },
  tasks: {
    createProject: (input) => ipcRenderer.invoke("tasks:createProject", input),
    list: (input) => ipcRenderer.invoke("tasks:list", input),
    get: (id: string) => ipcRenderer.invoke("tasks:get", id),
    listProjections: (input) => ipcRenderer.invoke("tasks:listProjections", input),
    getProjection: (id: string, input) => ipcRenderer.invoke("tasks:getProjection", id, input),
    findForChat: (chatId: string) => ipcRenderer.invoke("tasks:findForChat", chatId),
    forChat: (chatId: string) => ipcRenderer.invoke("tasks:forChat", chatId),
    acceptResult: (input) => ipcRenderer.invoke("tasks:acceptResult", input),
    continueFromResult: (input) => ipcRenderer.invoke("tasks:continueFromResult", input),
    openInWork: (taskId: string) => ipcRenderer.invoke("tasks:openInWork", taskId),
  },
  oneSearch: {
    search: (input) => ipcRenderer.invoke("oneSearch:search", input),
    mutateArchive: (input) => ipcRenderer.invoke("oneSearch:mutateArchive", input),
  },
  oneAttachments: {
    prepare: (input) => ipcRenderer.invoke("oneAttachments:prepare", input),
    bindToTeam: (input) => ipcRenderer.invoke("oneAttachments:bindToTeam", input),
    forTeam: (proposalId) => ipcRenderer.invoke("oneAttachments:forTeam", proposalId),
    discard: (input) => ipcRenderer.invoke("oneAttachments:discard", input),
  },
  oneArtifacts: {
    issuePreview: (input) => ipcRenderer.invoke("oneArtifacts:issuePreview", input),
    revokePreview: (input) => ipcRenderer.invoke("oneArtifacts:revokePreview", input),
  },
  oneProfile: {
    get: () => ipcRenderer.invoke("oneProfile:get"),
    update: (input) => ipcRenderer.invoke("oneProfile:update", input),
    setAvatarImage: (input) => ipcRenderer.invoke("oneProfile:setAvatarImage", input),
    addPrinciple: (input) => ipcRenderer.invoke("oneProfile:addPrinciple", input),
    updatePrinciple: (input) => ipcRenderer.invoke("oneProfile:updatePrinciple", input),
    setPrincipleEnabled: (input) => ipcRenderer.invoke("oneProfile:setPrincipleEnabled", input),
    deletePrinciple: (input) => ipcRenderer.invoke("oneProfile:deletePrinciple", input),
  },
  oneFeatureIntro: {
    getState: () => ipcRenderer.invoke("oneFeatureIntro:getState"),
    acknowledge: (input) => ipcRenderer.invoke("oneFeatureIntro:acknowledge", input),
    defer: (input) => ipcRenderer.invoke("oneFeatureIntro:defer", input),
  },
  oneActivation: {
    getState: (input) => ipcRenderer.invoke("oneActivation:getState", input),
    resolveConcern: (input) => ipcRenderer.invoke("oneActivation:resolveConcern", input),
    resolveWork: (input) => ipcRenderer.invoke("oneActivation:resolveWork", input),
    skip: (input) => ipcRenderer.invoke("oneActivation:skip", input),
    resolveMobile: (input) => ipcRenderer.invoke("oneActivation:resolveMobile", input),
  },
  oneMemory: {
    getState: () => ipcRenderer.invoke("oneMemory:getState"),
    getMap: () => ipcRenderer.invoke("oneMemory:getMap"),
    listEntries: (input?: { limit?: number }) => ipcRenderer.invoke("oneMemory:listEntries", input),
    forgetEntry: (input: { memoryId: string }) => ipcRenderer.invoke("oneMemory:forgetEntry", input),
    propose: (input) => ipcRenderer.invoke("oneMemory:propose", input),
    save: (input) => ipcRenderer.invoke("oneMemory:save", input),
    editAndSave: (input) => ipcRenderer.invoke("oneMemory:editAndSave", input),
    useOnce: (input) => ipcRenderer.invoke("oneMemory:useOnce", input),
    reject: (input) => ipcRenderer.invoke("oneMemory:reject", input),
    deleteCandidate: (input) => ipcRenderer.invoke("oneMemory:deleteCandidate", input),
    updateAsset: (input) => ipcRenderer.invoke("oneMemory:updateAsset", input),
    setAssetEnabled: (input) => ipcRenderer.invoke("oneMemory:setAssetEnabled", input),
    deleteAsset: (input) => ipcRenderer.invoke("oneMemory:deleteAsset", input),
  },
  oneSuggestions: {
    getState: () => ipcRenderer.invoke("oneSuggestions:getState"),
    acceptForReview: (input) => ipcRenderer.invoke("oneSuggestions:acceptForReview", input),
    getReviewHandoff: (input) => ipcRenderer.invoke("oneSuggestions:getReviewHandoff", input),
    getReviewSeed: (input) => ipcRenderer.invoke("oneSuggestions:getReviewSeed", input),
    snooze: (input) => ipcRenderer.invoke("oneSuggestions:snooze", input),
    dismiss: (input) => ipcRenderer.invoke("oneSuggestions:dismiss", input),
    neverAsk: (input) => ipcRenderer.invoke("oneSuggestions:neverAsk", input),
  },
  oneHubDerivative: {
    getDraft: (input) => ipcRenderer.invoke("oneHubDerivative:getDraft", input),
  },
  oneAutoRecovery: {
    judge: (input) => ipcRenderer.invoke("oneAutoRecovery:judge", input),
    verify: (input) => ipcRenderer.invoke("oneAutoRecovery:verify", input),
  },
  oneValueClosure: {
    getState: () => ipcRenderer.invoke("oneValueClosure:getState"),
    latestForTask: (taskId) => ipcRenderer.invoke("oneValueClosure:latestForTask", taskId),
    setReflection: (input) => ipcRenderer.invoke("oneValueClosure:setReflection", input),
  },
  oneWeeklyReflection: {
    get: () => ipcRenderer.invoke("oneWeeklyReflection:get"),
    resolve: (input) => ipcRenderer.invoke("oneWeeklyReflection:resolve", input),
  },
  oneExperienceReuse: {
    getState: () => ipcRenderer.invoke("oneExperienceReuse:getState"),
    latestForTask: (taskId) => ipcRenderer.invoke("oneExperienceReuse:latestForTask", taskId),
  },
  oneImprovementProof: {
    getState: () => ipcRenderer.invoke("oneImprovementProof:getState"),
    list: (input) => ipcRenderer.invoke("oneImprovementProof:list", input),
    latestForTask: (taskId) => ipcRenderer.invoke("oneImprovementProof:latestForTask", taskId),
  },
  oneBriefing: {
    get: () => ipcRenderer.invoke("oneBriefing:get"),
    openTask: (input) => ipcRenderer.invoke("oneBriefing:openTask", input),
    prepareAction: (input) => ipcRenderer.invoke("oneBriefing:prepareAction", input),
    getAction: (input) => ipcRenderer.invoke("oneBriefing:getAction", input),
    startAction: (input) => ipcRenderer.invoke("oneBriefing:startAction", input),
    setPreferences: (input) => ipcRenderer.invoke("oneBriefing:setPreferences", input),
    feedback: (input) => ipcRenderer.invoke("oneBriefing:feedback", input),
  },
  oneRequestIntent: {
    resolve: (prompt) => ipcRenderer.invoke("oneRequestIntent:resolve", prompt),
  },
  oneTeamPreflight: {
    prepare: (input) => ipcRenderer.invoke("oneTeamPreflight:prepare", input),
    getForChat: (chatId) => ipcRenderer.invoke("oneTeamPreflight:getForChat", chatId),
    autoResolve: (input) => ipcRenderer.invoke("oneTeamPreflight:autoResolve", input),
    resolve: (input) => ipcRenderer.invoke("oneTeamPreflight:resolve", input),
    acknowledge: (input) => ipcRenderer.invoke("oneTeamPreflight:acknowledge", input),
    failStart: (ref) => ipcRenderer.invoke("oneTeamPreflight:failStart", ref),
  },
  system: {
    concurrencyInfo: () => ipcRenderer.invoke("system:concurrencyInfo"),
    setConcurrency: (value: number) => ipcRenderer.invoke("system:setConcurrency", value),
  },
  automations: {
    list: () => ipcRenderer.invoke("automations:list"),
    get: (id: string) => ipcRenderer.invoke("automations:get", id),
    create: (input: AutomationCreateInput) =>
      ipcRenderer.invoke("automations:create", input),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("automations:toggle", id, enabled),
    remove: (id: string) => ipcRenderer.invoke("automations:remove", id),
    update: (id: string, patch: AutomationUpdatePatch) =>
      ipcRenderer.invoke("automations:update", id, patch),
    updateGraph: (id: string, graph: WorkflowGraph | null) =>
      ipcRenderer.invoke("automations:updateGraph", id, graph),
    /*
     * ★그래프를 Hub에 올리고 받는 길. 메인 프로세스에는 처음부터 있었는데 preload에
     * 실리지 않아 **앱에서는 손이 닿지 않았다** — 만든 기능에 문이 없던 자리다.
     */
    computerUsePermissions: () =>
      ipcRenderer.invoke("system:computerUsePermissions") as Promise<{ ok: boolean; missing: string[] }>,
    openAccessibilitySettings: () => ipcRenderer.invoke("system:openAccessibilitySettings") as Promise<void>,
    publishGraph: (id: string, opts?: { version?: string }) =>
      ipcRenderer.invoke("automations:publishGraph", id, opts) as Promise<
        { ok: true; slug: string; version: string; url?: string } | { ok: false; reason: string }
      >,
    installGraphFromHub: (slug: string, opts?: { name?: string }) =>
      ipcRenderer.invoke("automations:installGraphFromHub", slug, opts) as Promise<
        { ok: true; id: string; name: string } | { ok: false; reason: string }
      >,
    listGraphVersions: (id: string) =>
      ipcRenderer.invoke("automations:listGraphVersions", id) as Promise<
        Array<{ id: string; savedAt: string; note?: string; nodeCount: number }>
      >,
    restoreGraphVersion: (id: string, versionId: string) =>
      ipcRenderer.invoke("automations:restoreGraphVersion", id, versionId) as Promise<
        | { ok: true; automationId: string; versionId: string; automation: Automation }
        | { ok: false; reason: string }
      >,
    runNow: (id: string, opts?: { dryRun?: boolean; fresh?: boolean; input?: Record<string, unknown> }) =>
      ipcRenderer.invoke("automations:runNow", id, opts) as Promise<import("../shared/types").AutomationRunNowResult>,
    inputRequirement: (id: string) => ipcRenderer.invoke("automations:inputRequirement", id),
    connectionReport: (id: string) => ipcRenderer.invoke("automations:connectionReport", id),
    swapProvider: (id: string, input: { capability: string; fromProvider: string | null; toProvider: string }) =>
      ipcRenderer.invoke("automations:swapProvider", id, input),
    swapAgent: (
      id: string,
      input: { nodeId: string; ref: string; targetType: "agent" | "firm" | "hub"; targetVersion?: string | null; label?: string },
    ) => ipcRenderer.invoke("automations:swapAgent", id, input),
    interviewGraph: (state: unknown) => ipcRenderer.invoke("automations:interviewGraph", state),
    createFromBlueprint: (payload: unknown) => ipcRenderer.invoke("automations:createFromBlueprint", payload),
    /** 그래프를 고친 뒤 이전 실패를 잊고 처음부터 — 그래프가 실제로 바뀐 경우에만 응한다. */
    forgetFailedRun: (id: string) => ipcRenderer.invoke("automations:forgetFailedRun", id),
    /**
     * 저장 전에 한 번 돌려 보고, 막히면 **이어갈 길**을 함께 받는다.
     * 저장하지 않는다 — 무엇을 할지는 사람이 고른다.
     */
    checkBlueprintBeforeSave: (payload: unknown) =>
      ipcRenderer.invoke("automations:checkBlueprintBeforeSave", payload),
    /** 짓는 중 복구 칩을 실제로 실행한다. */
    applyBuildRecovery: (payload: unknown) =>
      ipcRenderer.invoke("automations:applyBuildRecovery", payload),
    stopRun: (id: string) => ipcRenderer.invoke("automations:stopRun", id),
    requestGraphPatch: (id: string, request: string) =>
      ipcRenderer.invoke("automations:requestGraphPatch", id, request),
    proposeGraphPatch: (id: string, patch: { ops: unknown[]; rationale?: string }) =>
      ipcRenderer.invoke("automations:proposeGraphPatch", id, patch),
    applyGraphPatch: (id: string, patch: { ops: unknown[]; rationale?: string }) =>
      ipcRenderer.invoke("automations:applyGraphPatch", id, patch),
    proposeChecklistFromExample: (id: string, example: string) =>
      ipcRenderer.invoke("automations:proposeChecklistFromExample", id, example),
    recordEvalCorrection: (id: string, nodeId: string, correctedVerdict: "pass" | "fail", note?: string) =>
      ipcRenderer.invoke("automations:recordEvalCorrection", id, nodeId, correctedVerdict, note),
    decideNodeApproval: (id: string, nodeId: string, decision: "approved" | "rejected" | "always") =>
      ipcRenderer.invoke("automations:decideNodeApproval", id, nodeId, decision),
    listRuns: (id: string, limit?: number) => ipcRenderer.invoke("automations:listRuns", id, limit),
    runCaptures: (ranAtIso: string, limit?: number) =>
      ipcRenderer.invoke("automations:runCaptures", ranAtIso, limit) as Promise<
        { name: string; at: string; dataUrl: string }[]
      >,
    acknowledgeRun: (id: string, runId: string) =>
      ipcRenderer.invoke("automations:acknowledgeRun", id, runId) as Promise<boolean>,
    // 실행 id 없이 지금까지의 확인 요구를 전부 닫는다 — 어떤 카드든 끝낼 수 있는 행동.
    acknowledgeAttention: (id: string) =>
      ipcRenderer.invoke("automations:acknowledgeAttention", id) as Promise<number>,
    listTriggerAttention: (automationId: string) =>
      ipcRenderer.invoke("automations:listTriggerAttention", automationId),
    reconcileTriggerEvent: (input: AutomationTriggerEventReconcileInput) =>
      ipcRenderer.invoke("automations:reconcileTriggerEvent", input),
    terminalCloseCandidate: (automationId: string) =>
      ipcRenderer.invoke("automations:terminalCloseCandidate", automationId) as Promise<AutomationGraphTerminalCloseCandidate | null>,
    terminalClose: (input: AutomationGraphTerminalCloseInput) =>
      ipcRenderer.invoke("automations:terminalClose", input) as Promise<AutomationGraphTerminalCloseReceipt>,
    getGraphReconciliation: (automationId: string) =>
      ipcRenderer.invoke("automations:getGraphReconciliation", automationId),
    reconcileGraph: (input: AutomationGraphReconcileInput) =>
      ipcRenderer.invoke("automations:reconcileGraph", input),
    liveRunChannel: (automationId: string) => `automations:liveRun:${automationId}`,
    latestRun: (automationId: string) => ipcRenderer.invoke("automations:latestRun", automationId),
    getSession: (automationId: string) => ipcRenderer.invoke("automations:getSession", automationId),
    planFix: (automationId: string) => ipcRenderer.invoke("automations:planFix", automationId),
    applyFix: (automationId: string, actionId: string) =>
      ipcRenderer.invoke("automations:applyFix", automationId, actionId),
  },
  launchd: {
    status: () => ipcRenderer.invoke("launchd:status"),
    enable: () => ipcRenderer.invoke("launchd:enable"),
    disable: () => ipcRenderer.invoke("launchd:disable"),
  },
  schedule: {
    validateCron: (expr: string) => ipcRenderer.invoke("schedule:validateCron", expr),
    describe: (spec: ScheduleSpec, locale?: "ko" | "en") =>
      ipcRenderer.invoke("schedule:describe", spec, locale),
    nextRun: (spec: ScheduleSpec) => ipcRenderer.invoke("schedule:nextRun", spec),
    defaultTz: () => ipcRenderer.invoke("schedule:defaultTz"),
  },
  surfaces: {
    listSurfaces: (chatId) => ipcRenderer.invoke("surfaces:list", chatId),
    getSurface: (id) => ipcRenderer.invoke("surfaces:get", id),
    listJobs: (surfaceId) => ipcRenderer.invoke("surfaces:listJobs", surfaceId),
    getJobSummary: (surfaceId) => ipcRenderer.invoke("surfaces:getJobSummary", surfaceId),
    updateJob: (input) => ipcRenderer.invoke("surfaces:updateJob", input),
    updateState: (input) => ipcRenderer.invoke("surfaces:updateState", input),
    listEvents: (surfaceId) => ipcRenderer.invoke("surfaces:listEvents", surfaceId),
    approve: (input) => ipcRenderer.invoke("surfaces:approve", input),
    hasApproval: (input) => ipcRenderer.invoke("surfaces:hasApproval", input),
    listApprovals: (surfaceId) => ipcRenderer.invoke("surfaces:listApprovals", surfaceId),
    revokeApproval: (id) => ipcRenderer.invoke("surfaces:revokeApproval", id),
  },
  surfaceAssets: {
    materialize: (input) => ipcRenderer.invoke("surfaceAssets:materialize", input),
    archive: (input) => ipcRenderer.invoke("surfaceAssets:archive", input),
    restore: (input) => ipcRenderer.invoke("surfaceAssets:restore", input),
    listPacks: (chatId) => ipcRenderer.invoke("surfaceAssets:listPacks", chatId),
    getPack: (id) => ipcRenderer.invoke("surfaceAssets:getPack", id),
    getPackBySurface: (chatId, surfaceId) =>
      ipcRenderer.invoke("surfaceAssets:getPackBySurface", chatId, surfaceId),
    listOperations: (packId) => ipcRenderer.invoke("surfaceAssets:listOperations", packId),
  },
  appFactory: {
    scaffold: (input) => ipcRenderer.invoke("appFactory:scaffold", input),
    syncCloudManifest: (input) => ipcRenderer.invoke("appFactory:syncCloudManifest", input),
    runAutopilot: (input) => ipcRenderer.invoke("appFactory:runAutopilot", input),
    installMcpPlan: (input) => ipcRenderer.invoke("appFactory:installMcpPlan", input),
    runProviderTasks: (input) => ipcRenderer.invoke("appFactory:runProviderTasks", input),
    materializeAssets: (input) => ipcRenderer.invoke("appFactory:materializeAssets", input),
    activateLocalCommerceStack: (input) => ipcRenderer.invoke("appFactory:activateLocalCommerceStack", input),
    openProviderBrowser: (input) => ipcRenderer.invoke("appFactory:openProviderBrowser", input),
    captureProviderBrowserSessions: (input) => ipcRenderer.invoke("appFactory:captureProviderBrowserSessions", input),
    launchProviderBrowserSession: (input) => ipcRenderer.invoke("appFactory:launchProviderBrowserSession", input),
    syncProviderBrowserResults: (input) => ipcRenderer.invoke("appFactory:syncProviderBrowserResults", input),
    resolveProviderCredentials: (input) => ipcRenderer.invoke("appFactory:resolveProviderCredentials", input),
    approveProviderPayment: (input) => ipcRenderer.invoke("appFactory:approveProviderPayment", input),
    runSmoke: (input) => ipcRenderer.invoke("appFactory:runSmoke", input),
    preparePreview: (input) => ipcRenderer.invoke("appFactory:preparePreview", input),
    startLivePreview: (input) => ipcRenderer.invoke("appFactory:startLivePreview", input),
    stopLivePreview: (input) => ipcRenderer.invoke("appFactory:stopLivePreview", input),
    openLaunchTarget: (input) => ipcRenderer.invoke("appFactory:openLaunchTarget", input),
    publishAsTool: (input) => ipcRenderer.invoke("appFactory:publishAsTool", input),
    archive: (input) => ipcRenderer.invoke("appFactory:archive", input),
    restore: (input) => ipcRenderer.invoke("appFactory:restore", input),
    listApps: (chatId) => ipcRenderer.invoke("appFactory:listApps", chatId),
    getApp: (id) => ipcRenderer.invoke("appFactory:getApp", id),
    getAppBySurface: (chatId, surfaceId) =>
      ipcRenderer.invoke("appFactory:getAppBySurface", chatId, surfaceId),
    listOperations: (appId) => ipcRenderer.invoke("appFactory:listOperations", appId),
  },
  workLiveView: {
    importBrowserCookies: () => ipcRenderer.invoke("workLiveView:importBrowserCookies"),
    listTabs: (input) => ipcRenderer.invoke("workLiveView:listTabs", input),
    createTab: (input) => ipcRenderer.invoke("workLiveView:createTab", input),
    open: (input) => ipcRenderer.invoke("workLiveView:open", input),
    setBounds: (input) => ipcRenderer.invoke("workLiveView:setBounds", input),
    reload: (viewId, taskScopeId) => ipcRenderer.invoke("workLiveView:reload", viewId, taskScopeId),
    navigate: (input) => ipcRenderer.invoke("workLiveView:navigate", input),
    goBack: (viewId, taskScopeId) => ipcRenderer.invoke("workLiveView:goBack", viewId, taskScopeId),
    goForward: (viewId, taskScopeId) => ipcRenderer.invoke("workLiveView:goForward", viewId, taskScopeId),
    close: (viewId, taskScopeId) => ipcRenderer.invoke("workLiveView:close", viewId, taskScopeId),
    capture: (viewId, taskScopeId) => ipcRenderer.invoke("workLiveView:capture", viewId, taskScopeId),
    dispatchInput: (input) => ipcRenderer.invoke("workLiveView:dispatchInput", input),
    onStatus: (handler) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: Parameters<typeof handler>[0]) => handler(status);
      ipcRenderer.on("workLiveView:status", wrapped);
      return () => ipcRenderer.removeListener("workLiveView:status", wrapped);
    },
  },
  metaAgent: {
    createCommerceTeam: (input) => ipcRenderer.invoke("metaAgent:createCommerceTeam", input),
  },
  toolFactory: {
    scaffold: (input) => ipcRenderer.invoke("toolFactory:scaffold", input),
    runSmoke: (input) => ipcRenderer.invoke("toolFactory:runSmoke", input),
    installMcp: (input) => ipcRenderer.invoke("toolFactory:installMcp", input),
    archive: (input) => ipcRenderer.invoke("toolFactory:archive", input),
    restore: (input) => ipcRenderer.invoke("toolFactory:restore", input),
    listTools: (chatId) => ipcRenderer.invoke("toolFactory:listTools", chatId),
    getTool: (id) => ipcRenderer.invoke("toolFactory:getTool", id),
    getToolBySurface: (chatId, surfaceId, requestedToolId) =>
      ipcRenderer.invoke("toolFactory:getToolBySurface", chatId, surfaceId, requestedToolId),
    listOperations: (toolRecordId) =>
      ipcRenderer.invoke("toolFactory:listOperations", toolRecordId),
  },
  pluginBuilder: {
    start: (input) => ipcRenderer.invoke("pluginBuilder:start", input),
    draft: (input) => ipcRenderer.invoke("pluginBuilder:draft", input),
    verify: (input) => ipcRenderer.invoke("pluginBuilder:verify", input),
    install: (input) => ipcRenderer.invoke("pluginBuilder:install", input),
    prove: (input) => ipcRenderer.invoke("pluginBuilder:prove", input),
    discard: (input) => ipcRenderer.invoke("pluginBuilder:discard", input),
    listDrafts: (chatId) => ipcRenderer.invoke("pluginBuilder:listDrafts", chatId),
    onProgress: (listener: (event: PluginBuilderProgressEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: PluginBuilderProgressEvent) => listener(event);
      ipcRenderer.on("pluginBuilder:progress", handler);
      return () => ipcRenderer.removeListener("pluginBuilder:progress", handler);
    },
  },
  migration: {
    scan: () => ipcRenderer.invoke("migration:scan"),
    import: (opts: MigrationOptions) => ipcRenderer.invoke("migration:import", opts),
  },
  interview: {
    getMode: () => ipcRenderer.invoke("interview:getMode"),
    setMode: (mode: "smart" | "build-only" | "off") => ipcRenderer.invoke("interview:setMode", mode),
  },
  invoke: {
    run: (req: McpInvocationRequest) => ipcRenderer.invoke("invoke:run", req),
    steer: (req: McpInvocationRequest) => ipcRenderer.invoke("invoke:steer", req),
    eventChannel: (runId: string) => `invoke:event:${runId}`,
    cancel: (runId: string) => ipcRenderer.invoke("invoke:cancel", runId),
    unsteer: (req: { chatId: string; position: number; text: string }) => ipcRenderer.invoke("invoke:unsteer", req),
    history: (chatId: string) => ipcRenderer.invoke("invoke:history", chatId),
    clearHistory: (chatId: string) =>
      ipcRenderer.invoke("invoke:clearHistory", chatId),
    activeChats: () => ipcRenderer.invoke("invoke:activeChats"),
    attach: (chatId: string, options?: { includeEvents?: boolean }) => ipcRenderer.invoke("invoke:attach", chatId, options),
    receipt: (runId: string) => ipcRenderer.invoke("invoke:receipt", runId),
    workerReport: (scope) => ipcRenderer.invoke("invoke:workerReport", scope),
    latestReceipt: (chatId: string) => ipcRenderer.invoke("invoke:latestReceipt", chatId),
    latestOneSurface: (input) => ipcRenderer.invoke("invoke:latestOneSurface", input),
  },
  hephaestus: {
    status: (locale) => ipcRenderer.invoke("hephaestus:status", locale),
    recover: (input) => ipcRenderer.invoke("hephaestus:recover", input),
    updateJournal: () => ipcRenderer.invoke("hephaestus:updateJournal"),
    runUpdate: () => ipcRenderer.invoke("hephaestus:runUpdate"),
    doctor: () => ipcRenderer.invoke("hephaestus:doctor"),
    coreAuthStatus: () => ipcRenderer.invoke("hephaestus:coreAuthStatus"),
    coreAuthLogin: () => ipcRenderer.invoke("hephaestus:coreAuthLogin"),
    /**
     * Core CLI 진행 스트림. publish·securityScan 처럼 수 분이 걸리는 호출이 끝날 때까지
     * 침묵하던 문제(호출부 0곳)를 메운다. `progressId` 는 권한이 아니라 라우팅 키다 —
     * 그 실행을 시작한 창으로 줄을 되돌려 보내는 용도뿐이다.
     */
    onProgress: (listener: (event: { progressId: string; stream: "stdout" | "stderr"; line: string; elapsedMs: number }) => void) => {
      const handler = (_e: unknown, payload: { progressId: string; stream: "stdout" | "stderr"; line: string; elapsedMs: number }) => listener(payload);
      ipcRenderer.on("hephaestus:progress", handler);
      return () => ipcRenderer.removeListener("hephaestus:progress", handler);
    },
    stormbreaker: (input) => ipcRenderer.invoke("hephaestus:stormbreaker", input),
    getSupervisor: () => ipcRenderer.invoke("hephaestus:getSupervisor"),
    setSupervisor: (enabled: boolean) => ipcRenderer.invoke("hephaestus:setSupervisor", enabled),
    getEngineToggles: () => ipcRenderer.invoke("hephaestus:getEngineToggles"),
    setEngineToggle: (input) => ipcRenderer.invoke("hephaestus:setEngineToggle", input),
    journal: (input) => ipcRenderer.invoke("hephaestus:journal", input),
    search: (input) => ipcRenderer.invoke("hephaestus:search", input),
    network: (input) => ipcRenderer.invoke("hephaestus:network", input),
    routePreview: (input) => ipcRenderer.invoke("hephaestus:routePreview", input),
    localGui: (input) => ipcRenderer.invoke("hephaestus:localGui", input),
    publish: (input) => ipcRenderer.invoke("hephaestus:publish", input),
    package: (input) => ipcRenderer.invoke("hephaestus:package", input),
    securityScan: (input) => ipcRenderer.invoke("hephaestus:securityScan", input),
    aoGraph: (input) => ipcRenderer.invoke("hephaestus:aoGraph", input),
    previewAllocation: (input) => ipcRenderer.invoke("hephaestus:previewAllocation", input),
    build: (input) => ipcRenderer.invoke("hephaestus:build", input),
    buildEventChannel: (runId: string) => `hephaestus:build:${runId}`,
    buildReady: (runId: string) => ipcRenderer.invoke("hephaestus:buildReady", runId),
    contractVerify: (input) => ipcRenderer.invoke("hephaestus:contractVerify", input),
    activeBuild: () => ipcRenderer.invoke("hephaestus:activeBuild"),
    cancelBuild: (runId: string) => ipcRenderer.invoke("hephaestus:cancelBuild", runId),
    startStudio: (input) => ipcRenderer.invoke("hephaestus:startStudio", input),
    stopStudio: () => ipcRenderer.invoke("hephaestus:stopStudio"),
  },
};

contextBridge.exposeInMainWorld("agentlas", api);

// 드래그&드롭으로 들어온 File/폴더의 실제 경로는 preload 안에서만 얻는다.
// renderer에는 raw-path grant API 대신 main이 발급한 제한된 capability만 돌려준다.
contextBridge.exposeInMainWorld("agentlasFiles", {
  chatFiles: {
    snapshot: (input: unknown) => ipcRenderer.invoke("chatFiles:snapshot", input),
    listGroup: (input: unknown) => ipcRenderer.invoke("chatFiles:listGroup", input),
    openExternal: (input: unknown) => ipcRenderer.invoke("chatFiles:openExternal", input),
    appendMessage: (input: unknown) => ipcRenderer.invoke("chatFiles:appendMessage", input),
  },
  grantForFile: async (file: File): Promise<FsPathGrant | null> => {
    try {
      const droppedPath = webUtils.getPathForFile(file);
      if (!droppedPath) return null;
      return await ipcRenderer.invoke("fs:grantDroppedPath", droppedPath);
    } catch {
      return null;
    }
  },
  grantForPastedAttachment: async (file: File): Promise<FsPathGrant | null> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return await ipcRenderer.invoke("fs:grantPastedAttachment", { mediaType: file.type, bytes });
    } catch {
      return null;
    }
  },
  // 붙여넣기·스크린샷 이미지는 디스크에 없다. 경로 대신 내용을 넘기고, main이 비공개
  // 파일로 고정한 뒤 드롭과 같은 등급의 capability를 발급한다.
  grantForPastedImage: async (file: File): Promise<FsPathGrant | null> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return await ipcRenderer.invoke("fs:grantPastedImage", { mediaType: file.type, bytes });
    } catch {
      return null;
    }
  },
});
contextBridge.exposeInMainWorld("agentlasEvents", {
  on: (channel: string, handler: (event: McpInvocationEvent) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, payload: McpInvocationEvent) =>
      handler(payload);
    // 화이트리스트: 호출 이벤트(invoke:event:*)와 Hephaestus 빌드 진행 채널(hephaestus:build:<runId>).
    // 빌드 채널이 빠져 있어 빌드 로그/단계 이벤트가 렌더러에 전혀 도달하지 못하던 버그를 수정.
    // 화이트리스트에 자동화 그래프 라이브 실행 채널(automations:liveRun:<id>) 추가 — 플로우
    // 캔버스가 per-node 상태를 실시간 구독한다(설계 §5 P2).
    if (
      !channel.startsWith("invoke:event:") &&
      !channel.startsWith("hephaestus:build:") &&
      !channel.startsWith("automations:liveRun:") &&
      // 그래프 인터뷰가 답을 써 내려가는 동안 부분 청사진을 흘려보내는 채널.
      // 없으면 사람은 몇 십 초를 빈 화면으로 기다린다(런타임은 이미 조각을 준다).
      !channel.startsWith("automations:interview:")
    )
      return () => {};
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  // 실행 중 chatId 목록 방송 — 사이드바 "실행 중" 인디케이터용.
  onActiveChats: (handler: (chatIds: string[]) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, chatIds: string[]) => handler(chatIds);
    ipcRenderer.on("invoke:activeChats", wrapped);
    return () => ipcRenderer.removeListener("invoke:activeChats", wrapped);
  },
  // Mobile pairing lifecycle carries only a reason enum; QR nonces/tokens stay in main.
  onMobileBridgeChanged: (handler: (event: { reason: string }) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, event: { reason: string }) => handler(event);
    ipcRenderer.on("mobileBridge:changed", wrapped);
    return () => ipcRenderer.removeListener("mobileBridge:changed", wrapped);
  },
  onProductExtensionChanged: (handler: (status: import("../shared/product-extension").ProductExtensionStatus) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, status: import("../shared/product-extension").ProductExtensionStatus) => handler(status);
    ipcRenderer.on("productExtensions:changed", wrapped);
    return () => ipcRenderer.removeListener("productExtensions:changed", wrapped);
  },
  onScienceSuiteProgress: (handler: (progress: import("../shared/product-extension").ScienceSuiteInstallProgress) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, progress: import("../shared/product-extension").ScienceSuiteInstallProgress) => handler(progress);
    ipcRenderer.on("productExtensions:scienceSuiteProgress", wrapped);
    return () => ipcRenderer.removeListener("productExtensions:scienceSuiteProgress", wrapped);
  },
  onProductExtensionViewStatus: (handler: (status: import("../shared/product-extension").ProductExtensionViewStatus) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, status: import("../shared/product-extension").ProductExtensionViewStatus) => handler(status);
    ipcRenderer.on("productExtensions:viewStatus", wrapped);
    return () => ipcRenderer.removeListener("productExtensions:viewStatus", wrapped);
  },
  // 도구 승인 — 런타임이 승인을 기다리거나(live) 이미 자동 거부한(post-denial) 사실.
  onToolApproval: (handler: (req: ToolApprovalRequestEvent) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, req: ToolApprovalRequestEvent) => handler(req);
    ipcRenderer.on("runtime:toolApprovalRequest", wrapped);
    return () => ipcRenderer.removeListener("runtime:toolApprovalRequest", wrapped);
  },
  onToolApprovalResolution: (handler: (receipt: ToolApprovalResolutionReceipt) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, receipt: ToolApprovalResolutionReceipt) => handler(receipt);
    ipcRenderer.on("runtime:toolApprovalResolution", wrapped);
    return () => ipcRenderer.removeListener("runtime:toolApprovalResolution", wrapped);
  },
  // Browser 승인 요청 — 되돌릴 수 없는 브라우저 행동 전 경량 바텀시트를 띄운다.
  onBrowserApproval: (handler: (req: BrowserApprovalRequestEvent) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, req: BrowserApprovalRequestEvent) =>
      handler(req);
    ipcRenderer.on("browser:approvalRequest", wrapped);
    return () => ipcRenderer.removeListener("browser:approvalRequest", wrapped);
  },
  /*
   * 에이전트의 **동기 질문** — 도구가 답을 기다리는 질문이다(confirm/ask-user.ts).
   * 기존 `<<agentlas-ask>>` 펜스는 비동기라 도구로 쓸 수 없었다: 답이 다음 채팅
   * 메시지로 오므로 도구는 결과를 못 받는다. 이 채널은 답이 올 때까지 실행이 기다린다.
   */
  onAskUser: (handler: (req: AskUserRequestEvent) => void) => {
    let active = true;
    let snapshotPending = true;
    const observed = new Set<string>();
    const wrapped = (_evt: Electron.IpcRendererEvent, req: AskUserRequestEvent) => {
      if (!active) return;
      // Both active events and expiry tombstones supersede an older snapshot.
      if (snapshotPending) observed.add(req.requestId);
      handler(req);
    };
    ipcRenderer.on("agentlas:ask-user", wrapped);
    // Subscribe first: a reply arriving during this read must not resurrect a
    // finished card. Replay through the same event contract, not a new answer.
    void ipcRenderer.invoke("confirm:listPendingAskUser").then((rows: AskUserRequestEvent[]) => {
      if (!active) return;
      for (const req of rows) {
        if (!active) break;
        if (observed.has(req.requestId) || req.expiresAt <= Date.now()) continue;
        observed.add(req.requestId);
        handler(req);
      }
    }).catch(() => {
      // Older/unavailable Main: keep the live subscription usable.
    }).finally(() => {
      snapshotPending = false;
      observed.clear();
    });
    return () => {
      active = false;
      ipcRenderer.removeListener("agentlas:ask-user", wrapped);
    };
  },
  // Site Copilot의 사용자용 상태/피드백 스트림. 내부 모델 추론이나 원문 HTML은 보내지 않는다.
  onSiteActivity: (handler: (event: SiteActivityEvent) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, event: SiteActivityEvent) => handler(event);
    ipcRenderer.on("site:activity", wrapped);
    return () => ipcRenderer.removeListener("site:activity", wrapped);
  },
  // 스토어 변경 방송 — {entity, id}뿐, 행 내용은 절대 싣지 않는다(change-bus 계약).
  // 렌더러 읽기 캐시 무효화용: 폴링 TTL보다 빠르게, 정확한 시점에 비운다.
  onStoreChanged: (handler: (change: { entity: string; id?: string }) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, change: { entity: string; id?: string }) =>
      handler(change);
    ipcRenderer.on("store:changed", wrapped);
    return () => ipcRenderer.removeListener("store:changed", wrapped);
  },
});

// 자동 업데이트 상태 broadcast — updater.ts의 broadcast()에서 webContents.send("updater:state", state)
contextBridge.exposeInMainWorld("agentlasUpdater", {
  onState: (handler: (state: UpdaterState) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, state: UpdaterState) => handler(state);
    ipcRenderer.on("updater:state", wrapped);
    return () => ipcRenderer.removeListener("updater:state", wrapped);
  },
});

// 메뉴 → renderer 라우팅. 단순한 string payload만 화이트리스트.
contextBridge.exposeInMainWorld("agentlasMenu", {
  onNavigate: (handler: (route: string) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, route: string) => handler(route);
    ipcRenderer.on("menu:navigate", wrapped);
    return () => ipcRenderer.removeListener("menu:navigate", wrapped);
  },
});
