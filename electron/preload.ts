// Renderer는 sandbox에 갇혀 있고, 노출하는 IPC만 사용 가능.
// shared/types.ts AgentlasIpc 모양과 1:1 일치해야 한다.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentlasIpc,
  Automation,
  McpInvocationEvent,
  McpInvocationRequest,
  MigrationOptions,
  Project,
  RuntimeBackend,
  RuntimeSelection,
  UpdaterState,
} from "../shared/types";

const api: AgentlasIpc = {
  app: {
    getLocale: () => ipcRenderer.invoke("app:getLocale"),
    getVersion: () => ipcRenderer.invoke("app:getVersion"),
  },
  trex: {
    generateImage: (payload: { model?: "codex" | "gemini"; prompt: string }) => ipcRenderer.invoke("trex:generateImage", payload),
    imageProviders: () => ipcRenderer.invoke("trex:imageProviders"),
    generateContent: (payload: { topic: string; count?: number; mode?: string }) => ipcRenderer.invoke("trex:generateContent", payload),
    contentAvailable: () => ipcRenderer.invoke("trex:contentAvailable"),
  },
  menu: {
    setLocale: (locale: "ko" | "en") => ipcRenderer.invoke("menu:setLocale", locale),
  },
  fs: {
    pickDirectory: () => ipcRenderer.invoke("fs:pickDirectory"),
    listDirectory: (absPath: string, showHidden?: boolean, rootPath?: string) =>
      ipcRenderer.invoke("fs:listDirectory", absPath, showHidden ?? false, rootPath),
    readTextFile: (absPath: string, rootPath?: string) => ipcRenderer.invoke("fs:readTextFile", absPath, rootPath),
    saveTextFile: (suggestedName: string, content: string) =>
      ipcRenderer.invoke("fs:saveTextFile", suggestedName, content),
  },
  workspace: {
    selectFolder: () => ipcRenderer.invoke("workspace:selectFolder"),
    get: (chatId: string) => ipcRenderer.invoke("workspace:get", chatId),
    set: (chatId: string, absPath: string | null) =>
      ipcRenderer.invoke("workspace:set", chatId, absPath),
  },
  auth: {
    getSession: () => ipcRenderer.invoke("auth:getSession"),
    signInWithGoogle: () => ipcRenderer.invoke("auth:signInWithGoogle"),
    signInWithBrowser: () => ipcRenderer.invoke("auth:signInWithBrowser"),
    signOut: () => ipcRenderer.invoke("auth:signOut"),
  },
  usage: {
    snapshot: (opts?: { force?: boolean }) => ipcRenderer.invoke("usage:snapshot", opts),
  },
  billing: {
    getCredits: () => ipcRenderer.invoke("billing:getCredits"),
    transferEarnings: (credits: number) => ipcRenderer.invoke("billing:transferEarnings", credits),
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
  },
  runtime: {
    detect: () => ipcRenderer.invoke("runtime:detect"),
    setActive: (selection: RuntimeSelection) =>
      ipcRenderer.invoke("runtime:setActive", selection),
    installCli: (kind: "claude-code" | "codex" | "gemini" | "grok") =>
      ipcRenderer.invoke("runtime:installCli", kind),
    openCliLogin: (kind: "claude-code" | "codex" | "gemini" | "grok") =>
      ipcRenderer.invoke("runtime:openCliLogin", kind),
    listCommands: () => ipcRenderer.invoke("runtime:listCommands"),
    listModels: (sel) => ipcRenderer.invoke("runtime:listModels", sel),
    installAgentlasCli: () => ipcRenderer.invoke("runtime:installAgentlasCli"),
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
    importLocalFolder: (absPath: string) =>
      ipcRenderer.invoke("team:importLocalFolder", absPath),
  },
  agentFiles: {
    list: (agentId: string) => ipcRenderer.invoke("agentFiles:list", agentId),
    read: (agentId: string, absPath: string) =>
      ipcRenderer.invoke("agentFiles:read", agentId, absPath),
    write: (agentId: string, absPath: string, content: string) =>
      ipcRenderer.invoke("agentFiles:write", agentId, absPath, content),
  },
  skills: {
    listCatalog: () => ipcRenderer.invoke("skills:listCatalog"),
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
  },
  marketplace: {
    listBundles: () => ipcRenderer.invoke("marketplace:listBundles"),
    search: (q: string) => ipcRenderer.invoke("marketplace:search", q),
    listFirms: () => ipcRenderer.invoke("marketplace:listFirms"),
    status: () => ipcRenderer.invoke("marketplace:status"),
    listMine: () => ipcRenderer.invoke("marketplace:listMine"),
  },
  cloudAgents: {
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
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    get: (id: string) => ipcRenderer.invoke("projects:get", id),
    create: (input) => ipcRenderer.invoke("projects:create", input),
    update: (id: string, patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId" | "folderPath">>) =>
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
  },
  automations: {
    list: () => ipcRenderer.invoke("automations:list"),
    create: (input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled" | "nextRunAt" | "createdBy">) =>
      ipcRenderer.invoke("automations:create", input),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("automations:toggle", id, enabled),
    remove: (id: string) => ipcRenderer.invoke("automations:remove", id),
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
  invoke: {
    run: (req: McpInvocationRequest) => ipcRenderer.invoke("invoke:run", req),
    eventChannel: (runId: string) => `invoke:event:${runId}`,
    cancel: (runId: string) => ipcRenderer.invoke("invoke:cancel", runId),
    history: (chatId: string) => ipcRenderer.invoke("invoke:history", chatId),
    clearHistory: (chatId: string) =>
      ipcRenderer.invoke("invoke:clearHistory", chatId),
    activeChats: () => ipcRenderer.invoke("invoke:activeChats"),
    attach: (chatId: string) => ipcRenderer.invoke("invoke:attach", chatId),
  },
  hephaestus: {
    status: () => ipcRenderer.invoke("hephaestus:status"),
    doctor: () => ipcRenderer.invoke("hephaestus:doctor"),
    stormbreaker: (input) => ipcRenderer.invoke("hephaestus:stormbreaker", input),
    getSupervisor: () => ipcRenderer.invoke("hephaestus:getSupervisor"),
    setSupervisor: (enabled: boolean) => ipcRenderer.invoke("hephaestus:setSupervisor", enabled),
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
    startStudio: () => ipcRenderer.invoke("hephaestus:startStudio"),
    stopStudio: () => ipcRenderer.invoke("hephaestus:stopStudio"),
  },
};

contextBridge.exposeInMainWorld("agentlas", api);

// 드래그&드롭으로 들어온 File/폴더의 실제 디스크 경로를 얻는다 (Electron 32+ webUtils).
// 샌드박스 렌더러는 fs 접근이 없으므로 경로만 얻어 IPC로 넘긴다.
contextBridge.exposeInMainWorld("agentlasFiles", {
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
contextBridge.exposeInMainWorld("agentlasEvents", {
  on: (channel: string, handler: (event: McpInvocationEvent) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, payload: McpInvocationEvent) =>
      handler(payload);
    // 화이트리스트: 호출 이벤트(invoke:event:*)와 Hephaestus 빌드 진행 채널(hephaestus:build:<runId>).
    // 빌드 채널이 빠져 있어 빌드 로그/단계 이벤트가 렌더러에 전혀 도달하지 못하던 버그를 수정.
    if (!channel.startsWith("invoke:event:") && !channel.startsWith("hephaestus:build:")) return () => {};
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  // 실행 중 chatId 목록 방송 — 사이드바 "실행 중" 인디케이터용.
  onActiveChats: (handler: (chatIds: string[]) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, chatIds: string[]) => handler(chatIds);
    ipcRenderer.on("invoke:activeChats", wrapped);
    return () => ipcRenderer.removeListener("invoke:activeChats", wrapped);
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
