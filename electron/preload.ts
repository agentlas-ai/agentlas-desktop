// Renderer는 sandbox에 갇혀 있고, 노출하는 IPC만 사용 가능.
// shared/types.ts AgentlasIpc 모양과 1:1 일치해야 한다.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentlasIpc,
  BrowserApprovalRequestEvent,
  BugReportInput,
  Automation,
  FsPathGrant,
  FsReadScope,
  McpInvocationEvent,
  McpInvocationRequest,
  MigrationOptions,
  Project,
  RuntimeBackend,
  RuntimeSelection,
  UpdaterState,
  WorkflowGraph,
  AutomationUpdatePatch,
  ScheduleSpec,
} from "../shared/types";
import type { SiteActivityEvent } from "../shared/site-studio";

const api: AgentlasIpc = {
  app: {
    getLocale: () => ipcRenderer.invoke("app:getLocale"),
    getVersion: () => ipcRenderer.invoke("app:getVersion"),
  },
  mobileBridge: {
    status: () => ipcRenderer.invoke("mobileBridge:status"),
    issuePairing: () => ipcRenderer.invoke("mobileBridge:issuePairing"),
    listDevices: () => ipcRenderer.invoke("mobileBridge:listDevices"),
    retry: () => ipcRenderer.invoke("mobileBridge:retry"),
    revokeDevice: (deviceId: string) => ipcRenderer.invoke("mobileBridge:revokeDevice", deviceId),
  },
  trex: {
    generateImage: (payload: { model?: "codex" | "gemini" | "auto"; prompt: string }) => ipcRenderer.invoke("trex:generateImage", payload),
    imageProviders: () => ipcRenderer.invoke("trex:imageProviders"),
    generateContent: (payload: { topic: string; count?: number; mode?: string; sources?: string; locale?: "ko" | "en"; useOpenCrab?: boolean }) => ipcRenderer.invoke("trex:generateContent", payload),
    contentAvailable: () => ipcRenderer.invoke("trex:contentAvailable"),
    refineText: (payload: { current: string; instruction: string; context?: string }) => ipcRenderer.invoke("trex:refineText", payload),
  },
  site: {
    listProjects: () => ipcRenderer.invoke("site:listProjects"),
    operationStatus: (payload: { projectId: string }) => ipcRenderer.invoke("site:operationStatus", payload),
    listConversation: (payload: { projectId: string }) => ipcRenderer.invoke("site:listConversation", payload),
    createProject: (payload: { name: string }) => ipcRenderer.invoke("site:createProject", payload),
    deleteProject: (payload: { projectId: string }) => ipcRenderer.invoke("site:deleteProject", payload),
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
    exportProjectZip: (payload: { projectId: string }) => ipcRenderer.invoke("site:exportProjectZip", payload),
    handoffToWorkspace: (payload: { projectId: string; workspaceGrant: import("../shared/types").FsPathGrant; locale?: "ko" | "en" }) =>
      ipcRenderer.invoke("site:handoffToWorkspace", payload),
    contentAvailable: () => ipcRenderer.invoke("site:contentAvailable"),
  },
  document: {
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
    invalidate: (providerId?: string) => ipcRenderer.invoke("usage:invalidate", providerId),
  },
  billing: {
    getCredits: () => ipcRenderer.invoke("billing:getCredits"),
    transferEarnings: (credits: number) => ipcRenderer.invoke("billing:transferEarnings", credits),
  },
  promptHub: {
    list: (params?: { q?: string; category?: string }) => ipcRenderer.invoke("promptHub:list", params),
    get: (slug: string) => ipcRenderer.invoke("promptHub:get", slug),
    unlock: (slug: string) => ipcRenderer.invoke("promptHub:unlock", slug),
    taste: (slug: string) => ipcRenderer.invoke("promptHub:taste", slug),
    tastes: () => ipcRenderer.invoke("promptHub:tastes"),
    bookmarks: () => ipcRenderer.invoke("promptHub:bookmarks"),
    bookmarkAdd: (slug: string) => ipcRenderer.invoke("promptHub:bookmarkAdd", slug),
    bookmarkRemove: (slug: string) => ipcRenderer.invoke("promptHub:bookmarkRemove", slug),
  },
  quests: {
    list: () => ipcRenderer.invoke("quests:list"),
    claim: (questId: string) => ipcRenderer.invoke("quests:claim", questId),
  },
  agentMemory: {
    entries: (agentId: string, limit?: number) => ipcRenderer.invoke("agentMemory:entries", agentId, limit),
  },
  agentLearning: {
    summary: (agentId: string) => ipcRenderer.invoke("agentLearning:summary", agentId),
  },
  experience: {
    createPack: (input) => ipcRenderer.invoke("experience:createPack", input),
    listPacks: (input) => ipcRenderer.invoke("experience:listPacks", input),
    ontologySummary: (agentId: string) => ipcRenderer.invoke("experience:ontologySummary", agentId),
    ontologyGraph: (agentId: string) => ipcRenderer.invoke("experience:ontologyGraph", agentId),
    hubProjection: (agentId: string, force?: boolean) =>
      ipcRenderer.invoke("experience:hubProjection", agentId, force === true),
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
    revealRecoveryBackup: () => ipcRenderer.invoke("updater:revealRecoveryBackup"),
  },
  runtime: {
    detect: (force?: boolean) => ipcRenderer.invoke("runtime:detect", force === true),
    setActive: (selection: RuntimeSelection) =>
      ipcRenderer.invoke("runtime:setActive", selection),
    installCli: (kind: "claude-code" | "codex" | "gemini" | "grok") =>
      ipcRenderer.invoke("runtime:installCli", kind),
    openCliLogin: (kind: "claude-code" | "codex" | "gemini" | "grok") =>
      ipcRenderer.invoke("runtime:openCliLogin", kind),
    updateCli: (kind: "claude-code" | "codex" | "gemini" | "grok") =>
      ipcRenderer.invoke("runtime:updateCli", kind),
    listCommands: () => ipcRenderer.invoke("runtime:listCommands"),
    listModels: (sel) => ipcRenderer.invoke("runtime:listModels", sel),
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
  multimodal: {
    listProviders: () => ipcRenderer.invoke("multimodal:listProviders"),
    getSettings: () => ipcRenderer.invoke("multimodal:getSettings"),
    saveSettings: (settings) => ipcRenderer.invoke("multimodal:saveSettings", settings),
    status: () => ipcRenderer.invoke("multimodal:status"),
  },
  oberon: {
    planWithCli: (request) => ipcRenderer.invoke("oberon:planWithCli", request),
    startKeyframes: (request) => ipcRenderer.invoke("oberon:startKeyframes", request),
    startSheets: (request) => ipcRenderer.invoke("oberon:startSheets", request),
    getKeyframeJob: (id: string) => ipcRenderer.invoke("oberon:getKeyframeJob", id),
    cancelKeyframes: (id: string) => ipcRenderer.invoke("oberon:cancelKeyframes", id),
    openKeyframeOutput: (id: string) => ipcRenderer.invoke("oberon:openKeyframeOutput", id),
    startRender: (request) => ipcRenderer.invoke("oberon:startRender", request),
    getRenderJob: (id: string) => ipcRenderer.invoke("oberon:getRenderJob", id),
    cancelRender: (id: string) => ipcRenderer.invoke("oberon:cancelRender", id),
    openRenderOutput: (id: string) => ipcRenderer.invoke("oberon:openRenderOutput", id),
    startMotionAd: (request) => ipcRenderer.invoke("oberon:startMotionAd", request),
    getMotionAdJob: (id: string) => ipcRenderer.invoke("oberon:getMotionAdJob", id),
    cancelMotionAd: (id: string) => ipcRenderer.invoke("oberon:cancelMotionAd", id),
    openMotionAdOutput: (id: string) => ipcRenderer.invoke("oberon:openMotionAdOutput", id),
    startAnimate: (request) => ipcRenderer.invoke("oberon:startAnimate", request),
    getAnimateJob: (id: string) => ipcRenderer.invoke("oberon:getAnimateJob", id),
    cancelAnimate: (id: string) => ipcRenderer.invoke("oberon:cancelAnimate", id),
    openAnimateOutput: (id: string) => ipcRenderer.invoke("oberon:openAnimateOutput", id),
    animateKeyStatus: () => ipcRenderer.invoke("oberon:animateKeyStatus"),
  },
  team: {
    list: () => ipcRenderer.invoke("team:list"),
    install: (slug: string) => ipcRenderer.invoke("team:install", slug),
    installMine: (id: string) => ipcRenderer.invoke("team:installMine", id),
    uninstall: (id: string) => ipcRenderer.invoke("team:uninstall", id),
    setLocalDisplayName: (id: string, value: string) =>
      ipcRenderer.invoke("team:setLocalDisplayName", id, value),
    importLocalFolder: (input) =>
      ipcRenderer.invoke("team:importLocalFolder", input),
    resolveSubAgents: (agentId: string) => ipcRenderer.invoke("team:resolveSubAgents", agentId),
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
    failures: (input?: { runId?: string; automationId?: string; chatId?: string; limit?: number }) =>
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
  },
  skills: {
    listCatalog: () => ipcRenderer.invoke("skills:listCatalog"),
    readCatalog: (slug: string) => ipcRenderer.invoke("skills:readCatalog", slug),
  },
  mcpTools: {
    listCatalog: () => ipcRenderer.invoke("mcpTools:listCatalog"),
    listInstalled: () => ipcRenderer.invoke("mcpTools:listInstalled"),
    install: (catalogId: string) => ipcRenderer.invoke("mcpTools:install", catalogId),
    installCustom: (def) => ipcRenderer.invoke("mcpTools:installCustom", def),
    remove: (id: string) => ipcRenderer.invoke("mcpTools:remove", id),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("mcpTools:setEnabled", id, enabled),
    test: (id: string) => ipcRenderer.invoke("mcpTools:test", id),
    status: () => ipcRenderer.invoke("mcpTools:status"),
    recommendForBuild: (input) => ipcRenderer.invoke("mcpTools:recommendForBuild", input),
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
    bookmarks: () => ipcRenderer.invoke("marketplace:bookmarks"),
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
    savePrivate: (input) => ipcRenderer.invoke("cloudAgents:savePrivate", input),
    publishPublic: (input) => ipcRenderer.invoke("cloudAgents:publishPublic", input),
    publish: (input) => ipcRenderer.invoke("cloudAgents:publish", input),
  },
  firms: {
    list: () => ipcRenderer.invoke("firms:list"),
    get: (id: string) => ipcRenderer.invoke("firms:get", id),
    install: (slug: string) => ipcRenderer.invoke("firms:install", slug),
    uninstall: (id: string) => ipcRenderer.invoke("firms:uninstall", id),
    getResolvedOrg: (id: string) => ipcRenderer.invoke("firms:getResolvedOrg", id),
    resolveOrg: (id: string) => ipcRenderer.invoke("firms:resolveOrg", id),
  },
  agentGroups: {
    list: () => ipcRenderer.invoke("agentGroups:list"),
    listResolved: () => ipcRenderer.invoke("agentGroups:listResolved"),
    getResolved: (id: string) => ipcRenderer.invoke("agentGroups:getResolved", id),
    create: (input) => ipcRenderer.invoke("agentGroups:create", input),
    update: (id, patch) => ipcRenderer.invoke("agentGroups:update", id, patch),
    removeMember: (groupId, memberId) =>
      ipcRenderer.invoke("agentGroups:removeMember", groupId, memberId),
    remove: (id) => ipcRenderer.invoke("agentGroups:remove", id),
  },
  telegram: {
    listBindings: () => ipcRenderer.invoke("telegram:listBindings"),
    autoConnect: (input) => ipcRenderer.invoke("telegram:autoConnect", input),
    start: (input) => ipcRenderer.invoke("telegram:start", input),
    clone: (input) => ipcRenderer.invoke("telegram:clone", input),
    resume: (id: string) => ipcRenderer.invoke("telegram:resume", id),
    stop: (id: string) => ipcRenderer.invoke("telegram:stop", id),
    remove: (id: string, deleteBot?: boolean) => ipcRenderer.invoke("telegram:remove", id, deleteBot),
    resetConversation: (id: string) => ipcRenderer.invoke("telegram:resetConversation", id),
    sendTest: (id: string) => ipcRenderer.invoke("telegram:sendTest", id),
    openBot: (id: string) => ipcRenderer.invoke("telegram:openBot", id),
    configureBotSettings: (id: string) => ipcRenderer.invoke("telegram:configureBotSettings", id),
    pruneOrphans: () => ipcRenderer.invoke("telegram:pruneOrphans"),
  },
  browser: {
    status: () => ipcRenderer.invoke("browser:status"),
    listSites: () => ipcRenderer.invoke("browser:listSites"),
    saveSite: (input) => ipcRenderer.invoke("browser:saveSite", input),
    deleteSite: (site: string) => ipcRenderer.invoke("browser:deleteSite", site),
    openLogin: (site: string) => ipcRenderer.invoke("browser:openLogin", site),
    markSession: (site: string, status) => ipcRenderer.invoke("browser:markSession", site, status),
    listPermissions: () => ipcRenderer.invoke("browser:listPermissions"),
    revokePermission: (site: string, actionType: string) =>
      ipcRenderer.invoke("browser:revokePermission", site, actionType),
    resolveApproval: (requestId: string, decision) =>
      ipcRenderer.invoke("browser:resolveApproval", requestId, decision),
    listLogs: (limit?: number) => ipcRenderer.invoke("browser:listLogs", limit),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    get: (id: string) => ipcRenderer.invoke("projects:get", id),
    create: (input) => ipcRenderer.invoke("projects:create", input),
    update: (id: string, patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId">> & { folderGrant?: FsPathGrant | null }) =>
      ipcRenderer.invoke("projects:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("projects:remove", id),
  },
  ontology: {
    getProject: (projectId: string) => ipcRenderer.invoke("ontology:getProject", projectId),
    addSource: (projectId, absPath, scope, kind) =>
      ipcRenderer.invoke("ontology:addSource", projectId, absPath, scope, kind),
    openInbox: (projectId: string) => ipcRenderer.invoke("ontology:openInbox", projectId),
  },
  chats: {
    listRecent: (limit?: number) => ipcRenderer.invoke("chats:listRecent", limit),
    listArchived: () => ipcRenderer.invoke("chats:listArchived"),
    listByProject: (projectId: string) =>
      ipcRenderer.invoke("chats:listByProject", projectId),
    listByFirm: (firmId: string) => ipcRenderer.invoke("chats:listByFirm", firmId),
    get: (id: string) => ipcRenderer.invoke("chats:get", id),
    create: (input) => ipcRenderer.invoke("chats:create", input),
    rename: (id: string, title: string) => ipcRenderer.invoke("chats:rename", id, title),
    switchAgent: (id: string, agentId: string) =>
      ipcRenderer.invoke("chats:switchAgent", id, agentId),
    archive: (id: string) => ipcRenderer.invoke("chats:archive", id),
    unarchive: (id: string) => ipcRenderer.invoke("chats:unarchive", id),
    remove: (id: string) => ipcRenderer.invoke("chats:remove", id),
    setContinuousMode: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("chats:setContinuousMode", id, enabled),
    setSwarmMode: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("chats:setSwarmMode", id, enabled),
    setHiredAgents: (id: string, cards: unknown[]) =>
      ipcRenderer.invoke("chats:setHiredAgents", id, cards),
    recap: (id: string) => ipcRenderer.invoke("chats:recap", id),
    markViewed: (id: string) => ipcRenderer.invoke("chats:markViewed", id),
  },
  hired: {
    list: () => ipcRenderer.invoke("hired:list"),
  },
  system: {
    concurrencyInfo: () => ipcRenderer.invoke("system:concurrencyInfo"),
    setConcurrency: (value: number) => ipcRenderer.invoke("system:setConcurrency", value),
  },
  automations: {
    list: () => ipcRenderer.invoke("automations:list"),
    get: (id: string) => ipcRenderer.invoke("automations:get", id),
    create: (input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled" | "nextRunAt" | "createdBy">) =>
      ipcRenderer.invoke("automations:create", input),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("automations:toggle", id, enabled),
    remove: (id: string) => ipcRenderer.invoke("automations:remove", id),
    update: (id: string, patch: AutomationUpdatePatch) =>
      ipcRenderer.invoke("automations:update", id, patch),
    updateGraph: (id: string, graph: WorkflowGraph | null) =>
      ipcRenderer.invoke("automations:updateGraph", id, graph),
    runNow: (id: string) => ipcRenderer.invoke("automations:runNow", id),
    listRuns: (id: string, limit?: number) => ipcRenderer.invoke("automations:listRuns", id, limit),
    liveRunChannel: (automationId: string) => `automations:liveRun:${automationId}`,
    latestRun: (automationId: string) => ipcRenderer.invoke("automations:latestRun", automationId),
    getSession: (automationId: string) => ipcRenderer.invoke("automations:getSession", automationId),
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
    history: (chatId: string) => ipcRenderer.invoke("invoke:history", chatId),
    clearHistory: (chatId: string) =>
      ipcRenderer.invoke("invoke:clearHistory", chatId),
    activeChats: () => ipcRenderer.invoke("invoke:activeChats"),
    attach: (chatId: string) => ipcRenderer.invoke("invoke:attach", chatId),
    receipt: (runId: string) => ipcRenderer.invoke("invoke:receipt", runId),
    latestReceipt: (chatId: string) => ipcRenderer.invoke("invoke:latestReceipt", chatId),
  },
  hephaestus: {
    status: (locale) => ipcRenderer.invoke("hephaestus:status", locale),
    doctor: () => ipcRenderer.invoke("hephaestus:doctor"),
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
    build: (input) => ipcRenderer.invoke("hephaestus:build", input),
    buildEventChannel: (runId: string) => `hephaestus:build:${runId}`,
    buildReady: (runId: string) => ipcRenderer.invoke("hephaestus:buildReady", runId),
    cancelBuild: (runId: string) => ipcRenderer.invoke("hephaestus:cancelBuild", runId),
    startStudio: (input) => ipcRenderer.invoke("hephaestus:startStudio", input),
    stopStudio: () => ipcRenderer.invoke("hephaestus:stopStudio"),
  },
};

contextBridge.exposeInMainWorld("agentlas", api);

// 드래그&드롭으로 들어온 File/폴더의 실제 경로는 preload 안에서만 얻는다.
// renderer에는 raw-path grant API 대신 main이 발급한 제한된 capability만 돌려준다.
contextBridge.exposeInMainWorld("agentlasFiles", {
  grantForFile: async (file: File): Promise<FsPathGrant | null> => {
    try {
      const droppedPath = webUtils.getPathForFile(file);
      if (!droppedPath) return null;
      return await ipcRenderer.invoke("fs:grantDroppedPath", droppedPath);
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
      !channel.startsWith("automations:liveRun:")
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
  // Browser 승인 요청 — 되돌릴 수 없는 브라우저 행동 전 경량 바텀시트를 띄운다.
  onBrowserApproval: (handler: (req: BrowserApprovalRequestEvent) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, req: BrowserApprovalRequestEvent) =>
      handler(req);
    ipcRenderer.on("browser:approvalRequest", wrapped);
    return () => ipcRenderer.removeListener("browser:approvalRequest", wrapped);
  },
  // Site Copilot의 사용자용 상태/피드백 스트림. 내부 모델 추론이나 원문 HTML은 보내지 않는다.
  onSiteActivity: (handler: (event: SiteActivityEvent) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, event: SiteActivityEvent) => handler(event);
    ipcRenderer.on("site:activity", wrapped);
    return () => ipcRenderer.removeListener("site:activity", wrapped);
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
