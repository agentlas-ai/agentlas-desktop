// IPC 핸들러 일괄 등록. main.ts 앱 ready 직후 호출.
// 각 도메인 모듈(runtime, secrets, team, marketplace, projects, chats, automations, invoke)을 thin wrapping.
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectRuntimes, setActiveRuntime } from "./runtime/detect";
import { listRuntimeModels } from "./runtime/providers";
import { installCli, openCliLogin, type InstallableCli } from "./runtime/install-cli";
import { listRuntimeCommands } from "./runtime/commands";
import { installAgentlasCli } from "./runtime/install-agentlas-cli";
import {
  getMultimodalSettings,
  getMultimodalStatus,
  listMultimodalProviders,
  saveMultimodalSettings,
} from "./multimodal/settings";
import {
  cancelOberonKeyframes,
  getOberonKeyframeJob,
  openOberonKeyframeOutput,
  startOberonKeyframes,
} from "./oberon/keyframes";
import { planOberonWithCli } from "./oberon/planner";
import {
  cancelOberonRenderJob,
  getOberonRenderJob,
  openOberonRenderOutput,
  startOberonRender,
} from "./oberon/render";
import {
  cancelOberonMotionAd,
  getOberonMotionAdJob,
  openOberonMotionAdOutput,
  startOberonMotionAd,
} from "./oberon/motion-graphics";
import {
  animateKeyStatus,
  cancelOberonAnimate,
  getOberonAnimateJob,
  openOberonAnimateOutput,
  startOberonAnimate,
} from "./oberon/animate";
import { runMigration, scanMigrationSources } from "./migrate";
import {
  deleteApiKey,
  deleteEnvVar,
  hasApiKey,
  hasEnvVar,
  listEnvKeys,
  previewEnvVar,
  saveApiKey,
  setEnvVar,
} from "./secrets/vault";
import {
  installAgent,
  installMyAgent,
  listInstalledAgents,
  uninstallAgent,
} from "./mcp/registry";
import { MCP_TOOL_CATALOG, getCatalogEntry } from "./mcp-tools/catalog";
import {
  installCustomServer,
  installFromCatalog,
  listInstalledServers,
  removeServer,
  setServerEnabled,
} from "./mcp-tools/registry";
import { statusAllServers, testServerById } from "./mcp-tools/client";
import {
  getSource as getMarketSource,
  getSourceStatus as getMarketSourceStatus,
  listMyAgentsCached,
} from "./marketplace";
import {
  getFirm,
  installFirm,
  listFirms,
  uninstallFirm,
} from "./store/firms";
import { listAgentFiles, readAgentFile, writeAgentFile } from "./agents/files";
import { importLocalFolder } from "./agents/import-local";
import { getDb } from "./store/db";
import { getResolvedOrg } from "./store/org-spec";
import { resolveTeamOrg } from "./agents/org-resolver";
import { runMcpInvocation } from "./mcp/client";
// ── Hephaestus 엔진 브리지 — 데스크탑↔엔진 연결은 전부 electron/hephaestus/* 에서만 일어난다. ──
import { hephaestusAvailable, hephaestusDoctor, hephaestusRoot } from "./hephaestus/engine";
import {
  aoGraph,
  hepNetwork,
  hepPackage,
  hepPublish,
  hepSearch,
  localGui,
  routeOnly,
  securityScan,
  stormbreakerJournal,
  stormbreakerRun,
} from "./hephaestus/commands";
import { normalizeRecommendation } from "./hephaestus/recommendation";
import { confirmUpload, PathGuardError, resolveFolderArg } from "./hephaestus/path-guard";
import { isSupervisorEnabled, setSupervisorEnabled } from "./hephaestus/supervisor";
import { runHephaestusBuild } from "./hephaestus/builder";
import { pickLocale } from "./runtime/status-i18n";
import { currentUiLocale } from "./main";
import { startStudio, stopStudio } from "./hephaestus/studio";
import type {
  AgentGroupCreateInput,
  AgentGroupUpdateInput,
  HephaestusBuildEvent,
  HephaestusBuildRequest,
  SkillCatalogEntry,
} from "../shared/types";
import { checkSafely as updaterCheck, getUpdaterState, quitAndInstall as updaterInstall } from "./updater";
import { listDirectory, pickDirectory, readTextFilePreview } from "./fs/workspace";
import { getAuthSession, signInWithBrowser, signInWithGoogle, signOut } from "./auth";
import { getBillingCredits, transferEarnings } from "./billing";
import {
  addHubPromptBookmark,
  getHubPrompt,
  listHubPromptBookmarks,
  listHubPrompts,
  listHubPromptTastes,
  removeHubPromptBookmark,
  tasteHubPrompt,
  unlockHubPrompt,
} from "./prompts-hub";
import { claimQuest, listQuests } from "./quests";
import { listMemoryEntriesForAgentUi } from "./memory/store";
import { getDreamingStatus, setDreamingEnabled } from "./memory/dreaming";
import { getUsageSnapshot } from "./usage";
import { listPendingConfirmations } from "./confirm";
import { addProjectOntologySource, getProjectOntologyStatus } from "./ontology/project-runtime";
import {
  createProject,
  getProject,
  listProjects,
  removeProject,
  updateProject,
} from "./store/projects";
import {
  archiveChat,
  clearChatMessages,
  createChat,
  getChat,
  getChatWorkingFolder,
  listArchivedChats,
  listChatMessages,
  listChatsByFirm,
  listChatsByProject,
  listRecentChats,
  removeChat,
  renameChat,
  setChatContinuousMode,
  setChatSwarmMode,
  setChatWorkingFolder,
  switchChatAgent,
  unarchiveChat,
} from "./store/chats";
import { getAgentConcurrencyInfo, setAgentConcurrency } from "./store/concurrency";
import { getInterviewMode, setInterviewMode, type InterviewMode } from "./store/interview-mode";
import {
  createAutomation,
  getAutomation,
  listAutomations,
  removeAutomation,
  toggleAutomation,
  updateAutomation,
  updateAutomationGraph,
  listRunHistory,
  getLatestGraphRun,
} from "./store/automations";
import {
  getAgentSurface,
  listAgentSurfaceEvents,
  listAgentSurfaces,
  patchAgentSurfaceState,
} from "./store/agent-surfaces";
import {
  approveAgentSurface,
  hasAgentSurfaceApproval,
  listAgentSurfaceApprovals,
  revokeAgentSurfaceApproval,
} from "./store/agent-surface-approvals";
import {
  getSurfaceJobSummary,
  listSurfaceJobs,
  updateSurfaceJob,
} from "./store/agent-surface-jobs";
import {
  getSurfaceAssetPack,
  getSurfaceAssetPackByRoot,
  getSurfaceAssetPackBySurface,
  listSurfaceAssetPackOperations,
  listSurfaceAssetPacks,
  recordMaterializedSurfaceAssetPack,
  recordSurfaceAssetPackOperation,
} from "./store/agent-surface-assets";
import {
  cloudAppRootPath,
  getAgentApp,
  getAgentAppByRoot,
  getAgentAppBySurface,
  isCloudAppRoot,
  listAgentAppOperations,
  listAgentApps,
  recordCloudAppManifest,
  recordAgentAppOperation,
  recordScaffoldedApp,
} from "./store/agent-apps";
import {
  getAgentTool,
  getAgentToolByRoot,
  getAgentToolBySurface,
  listAgentToolOperations,
  listAgentTools,
  recordAgentToolOperation,
  recordScaffoldedTool,
} from "./store/agent-tools";
import {
  getAgentRuntimeOverride,
  listAgentRuntimeOverrides,
  removeAgentRuntimeOverride,
  setAgentRuntimeOverride,
} from "./store/agent-runtime-overrides";
import {
  createAgentGroup,
  getResolvedAgentGroup,
  listAgentGroups,
  listResolvedAgentGroups,
  removeAgentGroup,
  removeAgentGroupMember,
  updateAgentGroup,
} from "./store/agent-groups";
import {
  archiveAppPackage,
  activateLocalCommerceStack,
  approveProviderPayment,
  captureProviderBrowserSessions,
  installMcpPlan,
  launchProviderBrowserSession,
  materializeCatalogAssets,
  prepareProviderBrowserOpen,
  preparePreviewDeploy,
  publishAppAsTool,
  resolveProviderCredentials,
  runAppFactoryAutopilot,
  restoreAppPackage,
  runAppFactorySmoke,
  runProviderTasks,
  syncProviderBrowserResults,
} from "./app-factory/operations";
import { scaffoldServiceApp } from "./app-factory/scaffold";
import { archiveSurfaceAssetPack, materializeSurfaceAssetPack, restoreSurfaceAssetPack } from "./surface-assets/materialize";
import { archiveToolPackage, installToolMcp, restoreToolPackage } from "./tool-factory/operations";
import { runToolFactorySmoke, scaffoldAgentTool } from "./tool-factory/scaffold";
import { createCommerceAgentTeam } from "./meta-agent/commerce-team";
import { packageAndReviewCloudAgent } from "./cloud-agents/package";
import { selectedMultimodalEnvRequirements } from "../shared/multimodal";
import type {
  AppFactoryAppRecord,
  AppFactoryAppStatus,
  AppFactoryAssetMaterializeRequest,
  AppFactoryAutopilotRequest,
  AppFactoryCloudAppManifestRequest,
  AppFactoryLocalCommerceActivationRequest,
  AppFactoryLaunchTargetResult,
  AppFactoryOperationKind,
  AppFactoryProviderCredentialResolveRequest,
  AppFactoryProviderBrowserLaunchRequest,
  AppFactoryProviderBrowserResultSyncRequest,
  AppFactoryProviderBrowserSessionRequest,
  AppFactoryProviderPaymentApproveRequest,
  AppFactoryRootRequest,
  AppFactoryScaffoldRequest,
  AppFactoryScaffoldSnapshot,
  AgentRuntimeOverrideScope,
  AgentRuntimeOverrideSetInput,
  Automation,
  CloudAgentPublishRequest,
  McpInvocationEvent,
  McpInvocationRequest,
  MetaAgentTeamFactoryRequest,
  McpTransport,
  MigrationOptions,
  MultimodalSettings,
  OberonKeyframeRequest,
  OberonPlanRequest,
  OberonRenderRequest,
  Project,
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
  SurfaceAssetPackRequest,
  SurfaceAssetPackRootRequest,
  SurfaceApprovalCheckRequest,
  SurfaceApprovalGrantRequest,
  SurfaceStatePatchRequest,
  SurfaceJobUpdateRequest,
  ToolFactoryOperationKind,
  ToolFactoryRootRequest,
  ToolFactoryScaffoldRequest,
  ToolFactoryToolStatus,
  WorkflowGraph,
  AutomationUpdatePatch,
  ScheduleSpec,
} from "../shared/types";

// 진행 중인 실행 레지스트리 — runId → { 취소 컨트롤러, 대상 chatId, 방출 이벤트 버퍼 }.
// 병렬 세션을 각각 독립 추적/취소하고, 채팅을 떠났다 돌아와도 진행 중 실행에 재접속할 수 있게
// 이벤트를 버퍼링한다. 텍스트 partial은 누적 전체 텍스트라 마지막 것만 유지하지만
// tool/thinking/agentId 이벤트는 누적되므로 MAX_BUFFERED_EVENTS로 상한을 둔다(오래된 것부터 폐기).
interface RunRecord {
  controller: AbortController;
  chatId: string;
  events: McpInvocationEvent[];
  /** 메인 스트림(무-agentId) partial의 마지막 누적 전문 — 델타 계산 기준. */
  partialText: string;
}
const activeRuns = new Map<string, RunRecord>();
// Hephaestus 빌더(hep-build) 진행 중 실행 — 취소용 AbortController 레지스트리.
const activeBuilds = new Map<string, AbortController>();
// runId → "렌더러 구독 완료" 신호. 구독 전 발생한 이벤트를 버퍼링하다 이 신호로 flush 한다.
const buildReadySignals = new Map<string, () => void>();
// tool 폭주하는 긴 실행/대형 firm 실행의 버퍼 무한증가 방지 상한 (재접속 리플레이는 최근 위주).
const MAX_BUFFERED_EVENTS = 4000;
// 단일 partial 텍스트 상한 — 런어웨이 출력(끝없이 스트리밍되는 GUI/서버 로그 등)이
// 매 60ms 누적 전체를 렌더러로 보내 렌더러를 OOM(수십 GB)시키는 걸 모든 런타임 공통으로 막는다.
const MAX_PARTIAL_CHARS = 2 * 1024 * 1024;
let pendingConfirmationCount = 0;
let pendingConfirmationBounceId: number | null = null;
let lastPendingConfirmationNoticeAt = 0;

/**
 * custom_base_url 검증 — byok.ts가 이 값으로 BYOK 키를 Bearer 전송하므로 임의 origin 재지정을 막는다.
 * 허용: 빈 값(기본값 복귀), 공개/사설 https, localhost/LAN 사설 IP의 http(로컬 LLM).
 * 거부: 그 외 스킴(file/data/javascript…)·공개 http·잘못된 URL → throw(렌더러에 거부 전달).
 * 순수 함수 — 부수효과 없음(단위테스트 가능).
 */
function validateCustomBaseUrl(raw: string): string {
  const url = (raw ?? "").trim();
  if (!url) return ""; // 빈 값 = 기본 OpenAI baseUrl로 복귀(허용)
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid base URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const isPrivateLan =
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (parsed.protocol === "https:") return url;
  if (parsed.protocol === "http:" && (isLoopback || isPrivateLan)) return url;
  throw new Error("Custom base URL must be https, or http on localhost/LAN");
}

function applyPendingConfirmationAttention(win: BrowserWindow | null, rawCount: number): void {
  const count = Math.max(0, Math.min(99, Math.floor(Number(rawCount) || 0)));
  const previous = pendingConfirmationCount;
  pendingConfirmationCount = count;

  try {
    app.setBadgeCount(count);
  } catch {
    // Badge support varies by platform/window manager.
  }

  if (count <= 0) {
    try {
      win?.flashFrame(false);
      if (process.platform === "darwin" && app.dock && pendingConfirmationBounceId !== null) {
        app.dock.cancelBounce(pendingConfirmationBounceId);
      }
    } catch {
      // ignore platform-specific attention failures
    }
    pendingConfirmationBounceId = null;
    return;
  }

  const focused = win?.isFocused() ?? false;
  if (focused || count <= previous) return;

  try {
    if (process.platform === "darwin" && app.dock) {
      if (pendingConfirmationBounceId !== null) app.dock.cancelBounce(pendingConfirmationBounceId);
      pendingConfirmationBounceId = app.dock.bounce("informational");
    } else {
      win?.flashFrame(true);
    }
  } catch {
    // ignore platform-specific attention failures
  }

  const now = Date.now();
  if (now - lastPendingConfirmationNoticeAt < 30_000) return;
  lastPendingConfirmationNoticeAt = now;

  try {
    if (Notification.isSupported()) {
      const ko = currentUiLocale() === "ko";
      new Notification({
        title: ko ? "Agentlas 승인 대기" : "Agentlas approval pending",
        body: ko
          ? (count === 1 ? "에이전트가 결정을 기다리고 있습니다." : `${count}개의 에이전트 승인 요청이 대기 중입니다.`)
          : (count === 1 ? "An agent is waiting on a decision." : `${count} agent approval requests are pending.`),
        silent: false,
      }).show();
    }
  } catch {
    // Native notifications can be disabled by the OS.
  }
}

/** 현재 실행 중인 chatId 목록(중복 제거). */
function activeChatIds(): string[] {
  return [...new Set([...activeRuns.values()].map((r) => r.chatId))];
}

function recordAppFactoryOperation(
  rootPath: string,
  operation: AppFactoryOperationKind,
  ok: boolean,
  result: unknown,
  status: AppFactoryAppStatus,
): void {
  const appRecord = getAgentAppByRoot(rootPath);
  if (!appRecord) return;
  const preservedStatus =
    appRecord.status === "tool-published" && status === "operations-ready"
      ? "tool-published"
      : appRecord.status === "preview-ready" && status === "operations-ready"
        ? "preview-ready"
        : status;
  recordAgentAppOperation(appRecord.id, operation, ok, result, preservedStatus);
}

function recordToolFactoryOperation(
  rootPath: string,
  operation: ToolFactoryOperationKind,
  ok: boolean,
  result: unknown,
  status: ToolFactoryToolStatus,
  installedServerId?: string | null,
): void {
  const toolRecord = getAgentToolByRoot(rootPath);
  if (!toolRecord) return;
  recordAgentToolOperation(toolRecord.id, operation, ok, result, status, installedServerId);
}

/** 사이드바 "실행 중" 인디케이터용 — 실행 시작/종료/취소 때마다 모든 창에 방송. */
function broadcastActiveChats(): void {
  const chatIds = activeChatIds();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("invoke:activeChats", chatIds);
  }
}

async function openAppLaunchTarget(appRecord: AppFactoryAppRecord): Promise<AppFactoryLaunchTargetResult> {
  const target = appLaunchTarget(appRecord);
  if (!target) {
    throw new Error(`No launch target is available for generated app: ${appRecord.appName}`);
  }
  if (target.mode === "external-url") {
    await shell.openExternal(target.target);
  } else if (target.mode === "local-file") {
    const localPath = target.target.startsWith("file://") ? fileURLToPath(target.target) : target.target;
    await shell.openPath(localPath);
  } else {
    shell.showItemInFolder(target.target);
  }
  return {
    rootPath: appRecord.rootPath,
    target: target.target,
    mode: target.mode,
    opened: true,
    summary: target.mode === "external-url"
      ? `Opened generated app at ${target.target}.`
      : `Opened generated app package at ${target.target}.`,
  };
}

function appLaunchTarget(appRecord: AppFactoryAppRecord): Pick<AppFactoryLaunchTargetResult, "target" | "mode"> | null {
  const scaffold = appRecord.scaffold as AppFactoryScaffoldSnapshot & { sourceUrl?: string };
  const candidates = [
    scaffold.launchUrl,
    appRecord.previewPath,
    scaffold.sourceUrl,
    appRecord.setupPath,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  for (const candidate of candidates) {
    const target = normalizeLaunchTarget(candidate);
    if (target) return target;
  }
  if (!isCloudAppRoot(appRecord.rootPath)) {
    return { target: appRecord.rootPath, mode: "local-folder" };
  }
  return null;
}

function normalizeLaunchTarget(value: string): Pick<AppFactoryLaunchTargetResult, "target" | "mode"> | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { target: url.toString(), mode: "external-url" };
    }
    if (url.protocol === "file:") {
      return { target: url.toString(), mode: "local-file" };
    }
    return null;
  } catch {
    if (path.isAbsolute(raw)) {
      return { target: pathToFileURL(raw).toString(), mode: "local-file" };
    }
    return null;
  }
}

export function registerIpcHandlers(): void {
  // ── app ─────────────────────────────────────────────────
  // macOS "시스템 설정 > 언어 및 지역"의 1순위 언어. Electron이 BCP47 형태로 반환.
  // ex) "ko-KR", "en-US", "ja-JP". 첫 실행 시 i18n 자동 감지에 사용.
  ipcMain.handle("app:getLocale", () => app.getLocale());
  /** package.json의 version — 사이드바 푸터 표기/디버그 용 */
  ipcMain.handle("app:getVersion", () => app.getVersion());

  // ── T-rex 슬라이드 스튜디오 이미지 생성(키리스 CLI: codex image_gen / gemini) ──
  ipcMain.handle("trex:generateImage", async (_e, payload: { model?: "codex" | "gemini" | "auto"; prompt?: string }) => {
    const { generateTrexImage } = await import("./trex/imagegen");
    const model = payload?.model === "gemini" ? "gemini" : payload?.model === "codex" ? "codex" : "auto";
    return generateTrexImage(model, String(payload?.prompt ?? ""));
  });
  ipcMain.handle("trex:imageProviders", async () => {
    const { trexImageProviders } = await import("./trex/imagegen");
    return trexImageProviders();
  });
  // T-rex 슬라이드 "내용" 생성 — 연결된 LLM(agy/codex)이 슬라이드별 실제 카피·수치를 JSON으로 작성.
  ipcMain.handle("trex:generateContent", async (_e, payload: { topic?: string; count?: number; mode?: string }) => {
    const { generateDeckContent } = await import("./trex/content");
    return generateDeckContent(String(payload?.topic ?? ""), Number(payload?.count ?? 7), payload?.mode);
  });
  ipcMain.handle("trex:contentAvailable", async () => {
    const { trexContentAvailable } = await import("./trex/content");
    return trexContentAvailable();
  });

  // ── updater (electron-updater) ──────────────────────────
  // renderer가 마운트되자마자 현재 상태를 동기 조회. broadcast 이전에 새 창이 열려도 onState로 캐치.
  ipcMain.handle("updater:getState", () => getUpdaterState());
  ipcMain.handle("updater:check", () => updaterCheck());
  ipcMain.handle("updater:install", () => updaterInstall());

  // ── fs (워킹 폴더 패널 read-only) ───────────────────────
  ipcMain.handle("fs:pickDirectory", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return pickDirectory(win);
  });
  ipcMain.handle("fs:listDirectory", (_e, absPath: string, showHidden?: boolean, rootPath?: string) =>
    listDirectory(absPath, showHidden ?? false, rootPath),
  );
  ipcMain.handle("fs:readTextFile", (_e, absPath: string, rootPath?: string) => readTextFilePreview(absPath, rootPath));
  // 산출물 내보내기 — 네이티브 저장 다이얼로그로 사용자가 고른 위치에 텍스트를 쓴다(lock-in 없음).
  ipcMain.handle(
    "fs:saveTextFile",
    async (e, suggestedName: string, content: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
      const win = BrowserWindow.fromWebContents(e.sender);
      try {
        const res = await dialog.showSaveDialog(win ?? undefined!, {
          defaultPath: suggestedName || "export.txt",
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        fs.writeFileSync(res.filePath, content, "utf8");
        return { ok: true, path: res.filePath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  // ── workspace (채팅별 working_folder) ───────────────────
  ipcMain.handle("workspace:selectFolder", async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });
  ipcMain.handle("workspace:get", (_e, chatId: string) => getChatWorkingFolder(chatId));
  ipcMain.handle("workspace:set", (_e, chatId: string, absPath: string | null) =>
    setChatWorkingFolder(chatId, absPath),
  );

  // ── auth (agentlas.cloud 구글 로그인) ───────────────────
  ipcMain.handle("auth:getSession", () => getAuthSession());
  ipcMain.handle("auth:signInWithGoogle", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return signInWithGoogle(win);
  });
  ipcMain.handle("auth:signInWithBrowser", () => signInWithBrowser());
  ipcMain.handle("auth:signOut", () => signOut());

  // ── usage (LLM 엔진 사용량 — 프로바이더 OAuth usage) ─────
  ipcMain.handle("usage:snapshot", (_e, opts?: { force?: boolean }) => getUsageSnapshot(opts));

  // ── billing (Agentlas Hub 크레딧 — 구독/렌트수익 2계좌 + 일방 전송) ─────
  ipcMain.handle("billing:getCredits", () => getBillingCredits());
  ipcMain.handle("billing:transferEarnings", (_e, credits: number) => transferEarnings(credits));

  // ── 프롬프트 저장소 — 웹 /api/prompts 프록시(쿠키+Origin, billing 패턴) ──────
  ipcMain.handle("promptHub:list", (_e, params?: { q?: string; category?: string }) => listHubPrompts(params));
  ipcMain.handle("promptHub:get", (_e, slug: string) => getHubPrompt(slug));
  ipcMain.handle("promptHub:unlock", (_e, slug: string) => unlockHubPrompt(slug));
  ipcMain.handle("promptHub:taste", (_e, slug: string) => tasteHubPrompt(slug));
  ipcMain.handle("promptHub:tastes", () => listHubPromptTastes());
  ipcMain.handle("promptHub:bookmarks", () => listHubPromptBookmarks());
  ipcMain.handle("promptHub:bookmarkAdd", (_e, slug: string) => addHubPromptBookmark(slug));
  ipcMain.handle("promptHub:bookmarkRemove", (_e, slug: string) => removeHubPromptBookmark(slug));

  // ── 퀘스트 — 대시보드 신규 유저 튜토리얼(온보딩 대체) ──────────────────────
  ipcMain.handle("quests:list", () => listQuests());
  ipcMain.handle("quests:claim", (_e, questId: string) => claimQuest(questId));

  // ── 에이전트 durable 메모리 — 런타임 큐레이터 DB를 자가진화/타임라인 UI로 ────
  ipcMain.handle("agentMemory:entries", (_e, agentId: string, limit?: number) =>
    listMemoryEntriesForAgentUi(agentId, Math.min(Math.max(Number(limit) || 100, 1), 300)),
  );

  // ── 유휴 드리밍 큐레이션 — 옵트인 설정(기본 OFF) + 상태 ─────────────────────
  ipcMain.handle("memoryDreaming:status", () => getDreamingStatus());
  ipcMain.handle("memoryDreaming:setEnabled", (_e, enabled: unknown) => {
    setDreamingEnabled(enabled === true);
    return getDreamingStatus();
  });

  // ── confirm (확인 요청 — 챗에서 사용자 결정 대기) ────────
  ipcMain.handle("confirm:listPending", () => listPendingConfirmations());

  // ── attention (Dock/taskbar/app badge — 놓치면 에이전트가 멈추는 승인 요청) ─────
  ipcMain.handle("attention:setPendingConfirmations", (e, count: number) => {
    applyPendingConfirmationAttention(BrowserWindow.fromWebContents(e.sender), count);
  });

  // ── runtime ─────────────────────────────────────────────
  ipcMain.handle("runtime:detect", () => detectRuntimes());
  ipcMain.handle("runtime:setActive", (_e, selection: RuntimeSelection) =>
    setActiveRuntime(selection),
  );
  ipcMain.handle("runtime:installCli", (_e, kind: InstallableCli) => installCli(kind));
  ipcMain.handle("runtime:openCliLogin", (_e, kind: InstallableCli) => openCliLogin(kind));
  ipcMain.handle("runtime:listCommands", () => listRuntimeCommands());
  ipcMain.handle(
    "runtime:listModels",
    (_e, sel: { kind: RuntimeKind; backend?: RuntimeBackend | null; availableModels?: string[] | null }) =>
      listRuntimeModels(sel.kind, sel.backend ?? null, sel.availableModels ?? null, Date.now()),
  );
  ipcMain.handle("runtime:installAgentlasCli", () => installAgentlasCli());

  ipcMain.handle("agentRuntime:list", () => listAgentRuntimeOverrides());
  ipcMain.handle(
    "agentRuntime:get",
    (_e, scope: AgentRuntimeOverrideScope, targetId: string) =>
      getAgentRuntimeOverride(scope, targetId),
  );
  ipcMain.handle(
    "agentRuntime:set",
    (_e, input: AgentRuntimeOverrideSetInput) => setAgentRuntimeOverride(input),
  );
  ipcMain.handle(
    "agentRuntime:remove",
    (_e, scope: AgentRuntimeOverrideScope, targetId: string) =>
      removeAgentRuntimeOverride(scope, targetId),
  );

  // ── secrets (macOS Keychain) ────────────────────────────
  ipcMain.handle("secrets:saveApiKey", (_e, backend: RuntimeBackend, key: string) =>
    saveApiKey(backend, key),
  );
  ipcMain.handle("secrets:hasApiKey", (_e, backend: RuntimeBackend) => hasApiKey(backend));
  ipcMain.handle("secrets:deleteApiKey", (_e, backend: RuntimeBackend) =>
    deleteApiKey(backend),
  );
  
  // ── custom backend config ───────────────────────────────
  ipcMain.handle("config:getCustomBaseUrl", () => {
    try {
      const row = getDb().prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get() as { value: string } | undefined;
      return row?.value ?? "";
    } catch { return ""; }
  });
  // 보안: 이 값은 byok.ts가 BYOK API 키를 Bearer로 보내는 baseUrl이 된다. 손상된 렌더러가
  // 임의 origin으로 재지정해 키를 탈취하지 못하게, 저장 전에 스킴/호스트를 검증한다.
  // 정상 사용(공개 https API, 로컬/LAN http LLM)은 그대로 허용 — 부작용 없음.
  ipcMain.handle("config:setCustomBaseUrl", (_e, url: unknown) => {
    const safe = validateCustomBaseUrl(typeof url === "string" ? url : "");
    getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('custom_base_url', ?)").run(safe);
  });

  // ── 에이전트 동시성(스웜 크기) — 사양 기반 추천 + 사용자 슬라이더 ─────────
  ipcMain.handle("system:concurrencyInfo", () => getAgentConcurrencyInfo());
  // 브리핑 인터뷰 모드 (smart / build-only / off)
  ipcMain.handle("interview:getMode", () => getInterviewMode());
  ipcMain.handle("interview:setMode", (_e, mode: InterviewMode) => setInterviewMode(mode));
  ipcMain.handle("system:setConcurrency", (_e, value: unknown) => {
    setAgentConcurrency(Number(value));
    return getAgentConcurrencyInfo();
  });

  // ── env vault (글로벌 외부 API 키) ──────────────────────
  ipcMain.handle("env:list", async () => {
    // 1) keychain에 저장된 env keys
    const stored = await listEnvKeys();
    // 2) 설치된 에이전트들의 envRequirements
    const agents = listInstalledAgents();
    type Aggregated = {
      hasValue: boolean;
      requiredBy: Array<{
        agentId: string;
        agentName: string;
        agentNameEn: string;
        label?: string;
        labelEn?: string;
        hint?: string;
        hintEn?: string;
      }>;
    };
    const map = new Map<string, Aggregated>();
    for (const a of agents) {
      for (const req of a.envRequirements) {
        const entry = map.get(req.key) ?? { hasValue: false, requiredBy: [] };
        entry.requiredBy.push({
          agentId: a.id,
          agentName: a.name,
          agentNameEn: a.nameEn,
          label: req.label,
          labelEn: req.labelEn,
          hint: req.hint,
          hintEn: req.hintEn,
        });
        map.set(req.key, entry);
      }
    }
    // 설치된 외부 MCP 서버가 요구하는 env도 합친다 — "어느 도구가 이 키를 쓰는지" 표시.
    for (const server of listInstalledServers()) {
      const catalog = server.catalogId ? getCatalogEntry(server.catalogId) : null;
      for (const key of server.envKeys) {
        const req = catalog?.envRequirements.find((r) => r.key === key);
        const entry = map.get(key) ?? { hasValue: false, requiredBy: [] };
        entry.requiredBy.push({
          agentId: `mcp:${server.id}`,
          agentName: `${server.name} (MCP)`,
          agentNameEn: `${server.nameEn || server.name} (MCP)`,
          label: req?.label,
          labelEn: req?.labelEn,
          hint: req?.hint,
          hintEn: req?.hintEn,
        });
        map.set(key, entry);
      }
    }
    // 멀티모달 전역 fallback provider가 요구하는 키도 환경변수 화면에 노출.
    for (const req of selectedMultimodalEnvRequirements(getMultimodalSettings())) {
      const entry = map.get(req.key) ?? { hasValue: false, requiredBy: [] };
      entry.requiredBy.push({
        agentId: `multimodal:${req.key}`,
        agentName: "Agentlas Multimodal Fallback",
        agentNameEn: "Agentlas Multimodal Fallback",
        label: req.label,
        labelEn: req.labelEn,
        hint: req.hint,
        hintEn: req.hintEn,
      });
      map.set(req.key, entry);
    }
    // 사용자가 직접 추가한 키도 포함 (요구하는 에이전트 없음)
    for (const k of stored) {
      if (!map.has(k)) map.set(k, { hasValue: true, requiredBy: [] });
    }
    // hasValue + 마스킹 미리보기를 한 번에 체크 (병렬). 미리보기는 메인에서 생성 — 전체 값 X.
    const keys = [...map.keys()];
    const values = await Promise.all(keys.map((k) => hasEnvVar(k)));
    const previews = await Promise.all(
      keys.map((k, i) => (values[i] ? previewEnvVar(k) : Promise.resolve(null))),
    );
    return keys.map((key, i) => ({
      key,
      hasValue: values[i],
      preview: previews[i] ?? null,
      requiredBy: map.get(key)!.requiredBy,
    }));
  });
  ipcMain.handle("env:set", (_e, key: string, value: string) => setEnvVar(key, value));
  ipcMain.handle("env:has", (_e, key: string) => hasEnvVar(key));
  ipcMain.handle("env:preview", (_e, key: string) => previewEnvVar(key));
  ipcMain.handle("env:remove", (_e, key: string) => deleteEnvVar(key));

  // ── multimodal global fallback ─────────────────────────
  ipcMain.handle("multimodal:listProviders", () => listMultimodalProviders());
  ipcMain.handle("multimodal:getSettings", () => getMultimodalSettings());
  ipcMain.handle("multimodal:saveSettings", (_e, settings: Partial<MultimodalSettings>) =>
    saveMultimodalSettings(settings),
  );
  ipcMain.handle("multimodal:status", () => getMultimodalStatus());

  // ── Oberon real generation bridges ─────────────────────────
  ipcMain.handle("oberon:planWithCli", (_e, request: OberonPlanRequest) =>
    planOberonWithCli(request),
  );
  ipcMain.handle("oberon:startKeyframes", (_e, request: OberonKeyframeRequest) =>
    startOberonKeyframes(request),
  );
  ipcMain.handle("oberon:getKeyframeJob", (_e, id: string) => getOberonKeyframeJob(id));
  ipcMain.handle("oberon:cancelKeyframes", (_e, id: string) => cancelOberonKeyframes(id));
  ipcMain.handle("oberon:openKeyframeOutput", (_e, id: string) => openOberonKeyframeOutput(id));
  ipcMain.handle("oberon:startRender", (_e, request: OberonRenderRequest) =>
    startOberonRender(request),
  );
  ipcMain.handle("oberon:getRenderJob", (_e, id: string) => getOberonRenderJob(id));
  ipcMain.handle("oberon:cancelRender", (_e, id: string) => cancelOberonRenderJob(id));
  ipcMain.handle("oberon:openRenderOutput", (_e, id: string) => openOberonRenderOutput(id));
  ipcMain.handle("oberon:startMotionAd", (_e, request) => startOberonMotionAd(request));
  ipcMain.handle("oberon:getMotionAdJob", (_e, id: string) => getOberonMotionAdJob(id));
  ipcMain.handle("oberon:cancelMotionAd", (_e, id: string) => cancelOberonMotionAd(id));
  ipcMain.handle("oberon:openMotionAdOutput", (_e, id: string) => openOberonMotionAdOutput(id));
  ipcMain.handle("oberon:startAnimate", (_e, request) => startOberonAnimate(request));
  ipcMain.handle("oberon:getAnimateJob", (_e, id: string) => getOberonAnimateJob(id));
  ipcMain.handle("oberon:cancelAnimate", (_e, id: string) => cancelOberonAnimate(id));
  ipcMain.handle("oberon:openAnimateOutput", (_e, id: string) => openOberonAnimateOutput(id));
  ipcMain.handle("oberon:animateKeyStatus", () => animateKeyStatus());

  // ── team (설치된 에이전트) ─────────────────────────────
  ipcMain.handle("team:list", () => listInstalledAgents());
  ipcMain.handle("team:install", (_e, slug: string) => installAgent(slug));
  ipcMain.handle("team:installMine", (_e, id: string) => installMyAgent(id));
  ipcMain.handle("team:uninstall", (_e, id: string) => uninstallAgent(id));
  // 로컬 폴더 임포트 — 런타임 감지 + 라우팅 저장 후 설치된 에이전트로 반환
  ipcMain.handle("team:importLocalFolder", async (_e, absPath: string) => (await importLocalFolder(absPath)).agent);

  // ── agentFiles (에이전트 폴더 파일 — 우측 패널 에디터) ──
  ipcMain.handle("agentFiles:list", (_e, agentId: string) => listAgentFiles(agentId));
  ipcMain.handle("agentFiles:read", (_e, agentId: string, absPath: string) =>
    readAgentFile(agentId, absPath),
  );
  ipcMain.handle("agentFiles:write", (_e, agentId: string, absPath: string, content: string) =>
    writeAgentFile(agentId, absPath, content),
  );

  // ── skills (주입 가능한 스킬 카탈로그 — 엔진 skills/ 디렉토리 실측) ──
  // 하드코딩 목록이 아니라 디스크의 SKILL.md 프론트매터에서 name/description 을 읽는다.
  // SKILL.md 가 없는 디렉토리는 카탈로그에서 제외(추측 금지, 실측 원칙).
  ipcMain.handle("skills:listCatalog", (): SkillCatalogEntry[] => {
    const root = hephaestusRoot();
    if (!root) return [];
    const skillsDir = path.join(root, "skills");
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const out: SkillCatalogEntry[] = [];
    for (const slug of dirs) {
      const md = path.join(skillsDir, slug, "SKILL.md");
      let name = slug;
      let description = "";
      try {
        const txt = fs.readFileSync(md, "utf8");
        const fm = txt.match(/^---\s*([\s\S]*?)\s*---/);
        const block = fm ? fm[1] : txt.slice(0, 600);
        const nameM = block.match(/^name:\s*["']?(.+?)["']?\s*$/m);
        const descM = block.match(/^description:\s*["']?([\s\S]+?)["']?\s*$/m);
        if (nameM) name = nameM[1].trim();
        if (descM) description = descM[1].trim().replace(/\s+/g, " ");
      } catch {
        continue;
      }
      out.push({ slug, name, description });
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug));
    return out;
  });

  // ── mcpTools (외부 MCP 툴 플러그인 — Slack/Discord/GitHub 등) ─
  ipcMain.handle("mcpTools:listCatalog", () => MCP_TOOL_CATALOG);
  ipcMain.handle("mcpTools:listInstalled", () => listInstalledServers());
  ipcMain.handle("mcpTools:install", (_e, catalogId: string) => installFromCatalog(catalogId));
  ipcMain.handle(
    "mcpTools:installCustom",
    (
      _e,
      def: {
        name: string;
        transport: McpTransport;
        command?: string;
        args?: string[];
        url?: string;
        envKeys?: string[];
      },
    ) => installCustomServer(def),
  );
  ipcMain.handle("mcpTools:remove", (_e, id: string) => removeServer(id));
  ipcMain.handle("mcpTools:setEnabled", (_e, id: string, enabled: boolean) =>
    setServerEnabled(id, enabled),
  );
  ipcMain.handle("mcpTools:test", (_e, id: string) => testServerById(id));
  ipcMain.handle("mcpTools:status", () => statusAllServers());

  // ── marketplace (agentlas.cloud Hub-only; no in-memory fallback catalog) ─
  ipcMain.handle("marketplace:listBundles", () => getMarketSource().listBundles());
  ipcMain.handle("marketplace:search", (_e, q: string) => getMarketSource().searchAgents(q));
  ipcMain.handle("marketplace:listFirms", () => getMarketSource().listFirms());
  ipcMain.handle("marketplace:status", () => getMarketSourceStatus());
  // 내 에이전트(cargo) — 미로그인/오프라인/실패면 빈 배열(팝업이 안내 처리).
  ipcMain.handle("marketplace:listMine", async () => {
    try {
      return await listMyAgentsCached();
    } catch {
      return [];
    }
  });

  // ── cloud agents (local package/review, then cloud registration) ─
  ipcMain.handle("cloudAgents:publish", async (_e, input: CloudAgentPublishRequest) =>
    packageAndReviewCloudAgent(input),
  );

  // ── firms (설치된 회사) ────────────────────────────────
  ipcMain.handle("firms:list", () => listFirms());
  ipcMain.handle("firms:get", (_e, id: string) => getFirm(id));
  ipcMain.handle("firms:install", (_e, slug: string) => installFirm(slug));
  ipcMain.handle("firms:uninstall", (_e, id: string) => uninstallFirm(id));
  // 정규화된 3-tier 조직 스펙 조회 (저장된 리졸버 결과 또는 orgChart 파생)
  ipcMain.handle("firms:getResolvedOrg", (_e, id: string) => {
    const firm = getFirm(id);
    return firm ? getResolvedOrg(firm) : null;
  });
  // LLM으로 팀 폴더를 분석해 3-tier 조직 스펙 생성 (임포트 팀용)
  ipcMain.handle("firms:resolveOrg", (_e, id: string) => resolveTeamOrg(id));

  // ── agent groups (자주 쓰는 조합 / 상위 오케스트레이터) ──────
  ipcMain.handle("agentGroups:list", () => listAgentGroups());
  ipcMain.handle("agentGroups:listResolved", () => listResolvedAgentGroups());
  ipcMain.handle("agentGroups:getResolved", (_e, id: string) => getResolvedAgentGroup(id));
  ipcMain.handle("agentGroups:create", (_e, input: AgentGroupCreateInput) =>
    createAgentGroup(input),
  );
  ipcMain.handle("agentGroups:update", (_e, id: string, patch: AgentGroupUpdateInput) =>
    updateAgentGroup(id, patch),
  );
  ipcMain.handle("agentGroups:removeMember", (_e, groupId: string, memberId: string) =>
    removeAgentGroupMember(groupId, memberId),
  );
  ipcMain.handle("agentGroups:remove", (_e, id: string) => removeAgentGroup(id));

  // ── projects ───────────────────────────────────────────
  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("projects:get", (_e, id: string) => getProject(id));
  ipcMain.handle(
    "projects:create",
    (_e, input: { name: string; defaultAgentId?: string | null; contextNote?: string | null; folderPath?: string | null }) =>
      createProject(input),
  );
  ipcMain.handle(
    "projects:update",
    (
      _e,
      id: string,
      patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId" | "folderPath">>,
    ) => updateProject(id, patch),
  );
  ipcMain.handle("projects:remove", (_e, id: string) => removeProject(id));

  // ── ontology activation (project-local, inbox + explicit sources only) ──
  ipcMain.handle("ontology:getProject", (_e, projectId: string) =>
    getProjectOntologyStatus(projectId),
  );
  ipcMain.handle(
    "ontology:addSource",
    (
      _e,
      projectId: string,
      absPath: string,
      scope: "public" | "internal" | "private",
      kind: "project" | "company" | "personal",
    ) => addProjectOntologySource(projectId, absPath, scope, kind),
  );
  ipcMain.handle("ontology:openInbox", async (_e, projectId: string) => {
    const status = getProjectOntologyStatus(projectId);
    if (status.state !== "active" || !status.inboxPath) {
      return { ok: false, path: null, message: status.error || "Project folder is not set." };
    }
    const message = await shell.openPath(status.inboxPath);
    return { ok: !message, path: status.inboxPath, message: message || "opened" };
  });

  // ── chats ──────────────────────────────────────────────
  ipcMain.handle("chats:listRecent", (_e, limit?: number) => listRecentChats(limit));
  ipcMain.handle("chats:listArchived", () => listArchivedChats());
  ipcMain.handle("chats:archive", (_e, id: string) => archiveChat(id));
  ipcMain.handle("chats:unarchive", (_e, id: string) => unarchiveChat(id));
  ipcMain.handle("chats:listByProject", (_e, projectId: string) =>
    listChatsByProject(projectId),
  );
  ipcMain.handle("chats:listByFirm", (_e, firmId: string) => listChatsByFirm(firmId));
  ipcMain.handle("chats:get", (_e, id: string) => getChat(id));
  ipcMain.handle(
    "chats:create",
    (
      _e,
      input: {
        agentId?: string;
        firmId?: string | null;
        agentGroupId?: string | null;
        projectId?: string | null;
        title?: string;
      },
    ) => createChat(input),
  );
  ipcMain.handle("chats:rename", (_e, id: string, title: string) => renameChat(id, title));
  ipcMain.handle("chats:switchAgent", (_e, id: string, agentId: string) =>
    switchChatAgent(id, agentId),
  );
  ipcMain.handle("chats:remove", (_e, id: string) => removeChat(id));
  ipcMain.handle("chats:setContinuousMode", (_e, id: string, enabled: boolean) => {
    setChatContinuousMode(id, enabled);
    return getChat(id);
  });
  ipcMain.handle("chats:setSwarmMode", (_e, id: string, enabled: boolean) => {
    setChatSwarmMode(id, enabled);
    return getChat(id);
  });

  // ── automations (SQLite + scheduler) ───────────────────
  // 이벤트 트리거(fs/chain)를 가진 자동화가 바뀌면 트리거 매니저를 재동기화한다(리스너 갱신).
  const resyncTriggers = async (): Promise<void> => {
    try {
      const { syncTriggers } = await import("./triggers/manager");
      syncTriggers();
    } catch {
      /* 매니저 미기동(헤드리스 등)이면 무시 */
    }
  };
  ipcMain.handle("automations:list", () => listAutomations());
  ipcMain.handle(
    "automations:create",
    async (_e, input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled" | "nextRunAt" | "createdBy">) => {
      const created = createAutomation(input);
      await resyncTriggers();
      return created;
    },
  );
  ipcMain.handle("automations:toggle", async (_e, id: string, enabled: boolean) => {
    const next = toggleAutomation(id, enabled);
    await resyncTriggers();
    return next;
  });
  ipcMain.handle("automations:update", async (_e, id: string, patch: AutomationUpdatePatch) => {
    const next = updateAutomation(id, patch);
    await resyncTriggers();
    return next;
  });
  ipcMain.handle("automations:remove", async (_e, id: string) => {
    removeAutomation(id);
    await resyncTriggers();
  });
  ipcMain.handle("automations:get", (_e, id: string) => getAutomation(id));
  ipcMain.handle("automations:listRuns", (_e, id: string, limit?: number) => listRunHistory(id, limit ?? 50));
  ipcMain.handle("automations:updateGraph", (_e, id: string, graph: WorkflowGraph | null) =>
    updateAutomationGraph(id, graph),
  );
  ipcMain.handle("automations:runNow", async (_e, id: string) => {
    const { runAutomationNow } = await import("./automation-scheduler");
    await runAutomationNow(id);
  });
  ipcMain.handle("automations:latestRun", (_e, id: string) => getLatestGraphRun(id));

  // ── schedule 문법 헬퍼(렌더러 스케줄 빌더용 — croner는 메인에서만) ──
  ipcMain.handle("schedule:validateCron", async (_e, expr: string) => {
    const { validateCron } = await import("./store/schedule");
    return validateCron(expr);
  });
  ipcMain.handle("schedule:describe", async (_e, spec: ScheduleSpec, loc?: "ko" | "en") => {
    const { describeSchedule } = await import("./store/schedule");
    try {
      return describeSchedule(spec, loc ?? "en");
    } catch {
      return "";
    }
  });
  ipcMain.handle("schedule:nextRun", async (_e, spec: ScheduleSpec) => {
    const { nextRun } = await import("./store/schedule");
    try {
      return nextRun(spec);
    } catch {
      return null;
    }
  });
  ipcMain.handle("schedule:defaultTz", async () => {
    const { defaultTz } = await import("./store/schedule");
    return defaultTz();
  });

  // ── launchd LaunchAgent (opt-in 앱 꺼져도 실행, macOS) ───
  ipcMain.handle("launchd:status", async () => {
    const { launchdStatus } = await import("./launchd/agent");
    return launchdStatus();
  });
  ipcMain.handle("launchd:enable", async () => {
    const { enableLaunchd } = await import("./launchd/agent");
    return enableLaunchd();
  });
  ipcMain.handle("launchd:disable", async () => {
    const { disableLaunchd } = await import("./launchd/agent");
    return disableLaunchd();
  });

  // ── Surfaces (agent-made Workbench outputs) ─────────────
  ipcMain.handle("surfaces:list", (_e, chatId?: string) => listAgentSurfaces(chatId));
  ipcMain.handle("surfaces:get", (_e, id: string) => getAgentSurface(id));
  ipcMain.handle("surfaces:listJobs", (_e, surfaceId: string) => listSurfaceJobs(surfaceId));
  ipcMain.handle("surfaces:getJobSummary", (_e, surfaceId: string) => {
    const surface = getAgentSurface(surfaceId);
    if (!surface) return null;
    return getSurfaceJobSummary(surfaceId, surface.manifest.budget);
  });
  ipcMain.handle("surfaces:updateJob", (_e, input: SurfaceJobUpdateRequest) =>
    updateSurfaceJob(input),
  );
  ipcMain.handle("surfaces:updateState", (_e, input: SurfaceStatePatchRequest) =>
    patchAgentSurfaceState(input),
  );
  ipcMain.handle("surfaces:listEvents", (_e, surfaceId: string) =>
    listAgentSurfaceEvents(surfaceId),
  );
  ipcMain.handle("surfaces:approve", (_e, input: SurfaceApprovalGrantRequest) =>
    approveAgentSurface(input),
  );
  ipcMain.handle("surfaces:hasApproval", (_e, input: SurfaceApprovalCheckRequest) =>
    hasAgentSurfaceApproval(input),
  );
  ipcMain.handle("surfaces:listApprovals", (_e, surfaceId: string) =>
    listAgentSurfaceApprovals(surfaceId),
  );
  ipcMain.handle("surfaces:revokeApproval", (_e, id: string) => revokeAgentSurfaceApproval(id));

  // ── Surface Assets (reusable packs from declarative manifests) ─
  ipcMain.handle("surfaceAssets:materialize", async (_e, input: SurfaceAssetPackRequest) => {
    const chat = getChat(input.chatId);
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
    const project = chat.projectId ? getProject(chat.projectId) : null;
    const baseDir =
      getChatWorkingFolder(chat.id) ??
      project?.folderPath ??
      path.join(app.getPath("userData"), "generated-assets");
    const result = await materializeSurfaceAssetPack(input, { baseDir, downloadRemoteAssets: true });
    const record = recordMaterializedSurfaceAssetPack({
      chatId: chat.id,
      projectId: chat.projectId,
      agentId: chat.agentId,
      surfaceId: input.surfaceId,
      actionId: input.actionId,
      manifest: input.manifest,
      snapshot: result,
    });
    return { ...result, record };
  });
  ipcMain.handle("surfaceAssets:archive", async (_e, input: SurfaceAssetPackRootRequest) => {
    const pack = getSurfaceAssetPackByRoot(path.resolve(input.rootPath));
    if (!pack) throw new Error(`Surface asset pack not found: ${input.rootPath}`);
    const result = await archiveSurfaceAssetPack(input);
    return recordSurfaceAssetPackOperation(pack.id, "archive", true, result, "archived");
  });
  ipcMain.handle("surfaceAssets:restore", async (_e, input: SurfaceAssetPackRootRequest) => {
    const pack = getSurfaceAssetPackByRoot(path.resolve(input.rootPath));
    if (!pack) throw new Error(`Surface asset pack not found: ${input.rootPath}`);
    const result = await restoreSurfaceAssetPack(input);
    return recordSurfaceAssetPackOperation(pack.id, "restore", true, result, "restored");
  });
  ipcMain.handle("surfaceAssets:listPacks", (_e, chatId?: string) => listSurfaceAssetPacks(chatId));
  ipcMain.handle("surfaceAssets:getPack", (_e, id: string) => getSurfaceAssetPack(id));
  ipcMain.handle("surfaceAssets:getPackBySurface", (_e, chatId: string, surfaceId: string) =>
    getSurfaceAssetPackBySurface(chatId, surfaceId),
  );
  ipcMain.handle("surfaceAssets:listOperations", (_e, packId: string) =>
    listSurfaceAssetPackOperations(packId),
  );

  // ── App Factory (agent-made service apps) ───────────────
  ipcMain.handle("appFactory:scaffold", async (_e, input: AppFactoryScaffoldRequest) => {
    const chat = getChat(input.chatId);
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
    const project = chat.projectId ? getProject(chat.projectId) : null;
    const baseDir =
      getChatWorkingFolder(chat.id) ??
      project?.folderPath ??
      path.join(app.getPath("userData"), "generated-apps");
    const result = await scaffoldServiceApp(input, { baseDir });
    const record = recordScaffoldedApp({
      chatId: chat.id,
      projectId: chat.projectId,
      agentId: chat.agentId,
      surfaceId: input.surfaceId,
      actionId: input.actionId,
      manifest: input.manifest,
      scaffold: result,
    });
    return { ...result, record };
  });
  ipcMain.handle("appFactory:syncCloudManifest", async (_e, input: AppFactoryCloudAppManifestRequest) => {
    const existingCloudApp = input.chatId
      ? null
      : getAgentAppByRoot(cloudAppRootPath(input.slug || input.cloudId));
    const chat = input.chatId
      ? getChat(input.chatId)
      : existingCloudApp
        ? getChat(existingCloudApp.chatId)
      : createChat({
          agentId: input.agentId,
          projectId: input.projectId ?? null,
          title: "Cloud Apps",
          kind: "division",
        });
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
    return recordCloudAppManifest({
      ...input,
      chatId: chat.id,
      projectId: input.projectId ?? chat.projectId,
      agentId: input.agentId ?? chat.agentId,
    });
  });
  ipcMain.handle("appFactory:runAutopilot", async (_e, input: AppFactoryAutopilotRequest) => {
    const result = await runAppFactoryAutopilot(input);
    recordAppFactoryOperation(
      result.rootPath,
      "run-autopilot",
      result.status === "operated",
      result,
      result.status === "operated" ? "tool-published" : result.smoke?.ok === false ? "smoke-failed" : "operations-ready",
    );
    return result;
  });
  ipcMain.handle("appFactory:installMcpPlan", async (_e, input: AppFactoryRootRequest) => {
    const result = await installMcpPlan(input);
    recordAppFactoryOperation(result.rootPath, "install-mcp", true, result, "mcp-ready");
    return result;
  });
  ipcMain.handle("appFactory:runProviderTasks", async (_e, input: AppFactoryRootRequest) => {
    const result = await runProviderTasks(input);
    recordAppFactoryOperation(result.rootPath, "run-provider-tasks", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:materializeAssets", async (_e, input: AppFactoryAssetMaterializeRequest) => {
    const result = await materializeCatalogAssets(input);
    recordAppFactoryOperation(result.rootPath, "materialize-assets", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:activateLocalCommerceStack", async (_e, input: AppFactoryLocalCommerceActivationRequest) => {
    const result = await activateLocalCommerceStack(input);
    recordAppFactoryOperation(result.rootPath, "activate-local-commerce-stack", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:openProviderBrowser", async (_e, input: AppFactoryRootRequest) => {
    const result = await prepareProviderBrowserOpen(input);
    for (const plan of result.opened) {
      await shell.openExternal(plan.startUrl);
    }
    recordAppFactoryOperation(result.rootPath, "open-provider-browser", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:captureProviderBrowserSessions", async (_e, input: AppFactoryProviderBrowserSessionRequest) => {
    const result = await captureProviderBrowserSessions(input);
    recordAppFactoryOperation(result.rootPath, "capture-provider-browser-sessions", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:launchProviderBrowserSession", async (_e, input: AppFactoryProviderBrowserLaunchRequest) => {
    const result = await launchProviderBrowserSession(input);
    recordAppFactoryOperation(result.rootPath, "launch-provider-session", result.ok, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:syncProviderBrowserResults", async (_e, input: AppFactoryProviderBrowserResultSyncRequest) => {
    const result = await syncProviderBrowserResults(input);
    recordAppFactoryOperation(result.rootPath, "sync-provider-browser-results", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:resolveProviderCredentials", async (_e, input: AppFactoryProviderCredentialResolveRequest) => {
    const result = await resolveProviderCredentials(input);
    recordAppFactoryOperation(result.rootPath, "resolve-provider-credentials", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:approveProviderPayment", async (_e, input: AppFactoryProviderPaymentApproveRequest) => {
    const result = await approveProviderPayment(input);
    recordAppFactoryOperation(result.rootPath, "approve-provider-payment", true, result, "operations-ready");
    return result;
  });
  ipcMain.handle("appFactory:runSmoke", async (_e, input: AppFactoryRootRequest) => {
    const result = await runAppFactorySmoke(input);
    recordAppFactoryOperation(
      result.rootPath,
      "run-smoke-test",
      result.ok,
      result,
      result.ok ? "smoke-passed" : "smoke-failed",
    );
    return result;
  });
  ipcMain.handle("appFactory:preparePreview", async (_e, input: AppFactoryRootRequest) => {
    const result = await preparePreviewDeploy(input);
    recordAppFactoryOperation(result.rootPath, "deploy-preview", true, result, "preview-ready");
    return result;
  });
  ipcMain.handle("appFactory:openLaunchTarget", async (_e, input: AppFactoryRootRequest) => {
    const rootPath = isCloudAppRoot(input.rootPath) ? input.rootPath : path.resolve(input.rootPath);
    const appRecord = getAgentAppByRoot(rootPath);
    if (!appRecord) throw new Error(`Generated app not found: ${input.rootPath}`);
    const result = await openAppLaunchTarget(appRecord);
    recordAgentAppOperation(appRecord.id, "open-launch-target", result.opened, result);
    return result;
  });
  ipcMain.handle("appFactory:publishAsTool", async (_e, input: AppFactoryRootRequest) => {
    const result = await publishAppAsTool(input);
    recordAppFactoryOperation(result.rootPath, "publish-as-tool", true, result, "tool-published");
    return result;
  });
  ipcMain.handle("appFactory:archive", async (_e, input: AppFactoryRootRequest) => {
    const rootPath = isCloudAppRoot(input.rootPath) ? input.rootPath : path.resolve(input.rootPath);
    const appRecord = getAgentAppByRoot(rootPath);
    if (!appRecord) throw new Error(`Generated app not found: ${input.rootPath}`);
    if (isCloudAppRoot(rootPath)) {
      return recordAgentAppOperation(
        appRecord.id,
        "archive",
        true,
        {
          rootPath,
          archived: true,
          reversible: true,
          storage: "cloud-manifest",
          summary: "Cloud App hidden from local Apps list; manifest can be synced again from Agentlas Cloud.",
        },
        "archived",
      );
    }
    const result = await archiveAppPackage(input);
    return recordAgentAppOperation(appRecord.id, "archive", true, result, "archived");
  });
  ipcMain.handle("appFactory:restore", async (_e, input: AppFactoryRootRequest) => {
    const rootPath = isCloudAppRoot(input.rootPath) ? input.rootPath : path.resolve(input.rootPath);
    const appRecord = getAgentAppByRoot(rootPath);
    if (!appRecord) throw new Error(`Generated app not found: ${input.rootPath}`);
    if (isCloudAppRoot(rootPath)) {
      return recordAgentAppOperation(
        appRecord.id,
        "restore",
        true,
        {
          rootPath,
          restored: true,
          storage: "cloud-manifest",
          summary: "Cloud App restored locally from the cached manifest registry.",
        },
        "restored",
      );
    }
    const result = await restoreAppPackage(input);
    return recordAgentAppOperation(appRecord.id, "restore", true, result, "restored");
  });
  ipcMain.handle("appFactory:listApps", (_e, chatId?: string) => listAgentApps(chatId));
  ipcMain.handle("appFactory:getApp", (_e, id: string) => getAgentApp(id));
  ipcMain.handle("appFactory:getAppBySurface", (_e, chatId: string, surfaceId: string) =>
    getAgentAppBySurface(chatId, surfaceId),
  );
  ipcMain.handle("appFactory:listOperations", (_e, appId: string) =>
    listAgentAppOperations(appId),
  );

  // ── Meta Agent Factory (local team materialization) ─────
  ipcMain.handle("metaAgent:createCommerceTeam", (_e, input: MetaAgentTeamFactoryRequest) =>
    createCommerceAgentTeam(input),
  );

  // ── Tool Factory (agent-made local tools) ───────────────
  ipcMain.handle("toolFactory:scaffold", async (_e, input: ToolFactoryScaffoldRequest) => {
    const chat = getChat(input.chatId);
    if (!chat) throw new Error(`Chat not found: ${input.chatId}`);
    const project = chat.projectId ? getProject(chat.projectId) : null;
    const baseDir =
      getChatWorkingFolder(chat.id) ??
      project?.folderPath ??
      path.join(app.getPath("userData"), "generated-tools");
    const result = await scaffoldAgentTool(input, { baseDir });
    const record = recordScaffoldedTool({
      chatId: chat.id,
      projectId: chat.projectId,
      agentId: chat.agentId,
      surfaceId: input.surfaceId,
      actionId: input.actionId,
      scaffold: result,
    });
    return { ...result, record };
  });
  ipcMain.handle("toolFactory:runSmoke", async (_e, input: ToolFactoryRootRequest) => {
    const result = await runToolFactorySmoke(input);
    recordToolFactoryOperation(
      result.rootPath,
      "run-smoke-test",
      result.ok,
      result,
      result.ok ? "smoke-passed" : "smoke-failed",
    );
    // 자동등록(REQ2): smoke가 통과하면 생성된 툴의 MCP 어댑터를 즉시 등록한다 → 에이전트가
    // 다음 턴부터 사용자 추가 클릭 없이 바로 호출 가능(buildMcpConfigFile이 .mcp.json으로 직렬화).
    // installToolMcp는 멱등(이미 설치돼 있으면 재사용)이라 중복 호출도 안전.
    if (result.ok) {
      try {
        const installed = await installToolMcp({ rootPath: result.rootPath });
        recordToolFactoryOperation(
          result.rootPath,
          "install-mcp",
          true,
          installed,
          "mcp-installed",
          installed.server.id,
        );
      } catch (err) {
        console.error("[tool-factory] auto-install after smoke failed:", err);
      }
    }
    return result;
  });
  ipcMain.handle("toolFactory:installMcp", async (_e, input: ToolFactoryRootRequest) => {
    const result = await installToolMcp(input);
    recordToolFactoryOperation(
      result.rootPath,
      "install-mcp",
      true,
      result,
      "mcp-installed",
      result.server.id,
    );
    return result;
  });
  ipcMain.handle("toolFactory:archive", async (_e, input: ToolFactoryRootRequest) => {
    const toolRecord = getAgentToolByRoot(path.resolve(input.rootPath));
    if (!toolRecord) throw new Error(`Generated tool not found: ${input.rootPath}`);
    const result = await archiveToolPackage(input);
    return recordAgentToolOperation(toolRecord.id, "archive", true, result, "archived", null);
  });
  ipcMain.handle("toolFactory:restore", async (_e, input: ToolFactoryRootRequest) => {
    const toolRecord = getAgentToolByRoot(path.resolve(input.rootPath));
    if (!toolRecord) throw new Error(`Generated tool not found: ${input.rootPath}`);
    const result = await restoreToolPackage(input);
    return recordAgentToolOperation(
      toolRecord.id,
      "restore",
      true,
      result,
      "restored",
      result.restoredServerId,
    );
  });
  ipcMain.handle("toolFactory:listTools", (_e, chatId?: string) => listAgentTools(chatId));
  ipcMain.handle("toolFactory:getTool", (_e, id: string) => getAgentTool(id));
  ipcMain.handle(
    "toolFactory:getToolBySurface",
    (_e, chatId: string, surfaceId: string, requestedToolId?: string) =>
      getAgentToolBySurface(chatId, surfaceId, requestedToolId),
  );
  ipcMain.handle("toolFactory:listOperations", (_e, toolRecordId: string) =>
    listAgentToolOperations(toolRecordId),
  );

  // ── migration (OpenClaw / Hermes → Agentlas) ────────────
  ipcMain.handle("migration:scan", () => scanMigrationSources());
  ipcMain.handle("migration:import", (_e, opts: MigrationOptions) => runMigration(opts));

  // ── invoke (백엔드 라우터 — 스트리밍 실행) ─────────────
  ipcMain.handle("invoke:run", async (event, req: McpInvocationRequest) => {
    // 렌더러가 runId를 미리 넘기면 그대로 사용 — 렌더러가 invoke 왕복 전에 이 채널을 이미
    // 구독하고 있으므로 런타임이 즉시 emit하는 초기 이벤트도 놓치지 않는다(subscribe-before-trigger).
    // 안 넘겼으면(자동화/구버전 호출) 기존처럼 main이 생성(하위호환).
    const runId = req.runId ?? randomUUID();
    const channel = `invoke:event:${runId}`;
    const win = BrowserWindow.fromWebContents(event.sender);

    // 실행마다 AbortController를 등록 — 병렬 실행이 서로 독립적으로 취소 가능.
    const controller = new AbortController();
    const record: RunRecord = { controller, chatId: req.chatId, events: [], partialText: "" };
    activeRuns.set(runId, record);
    broadcastActiveChats();

    void runMcpInvocation(
      req,
      (rawEv) => {
        // 런어웨이 출력 보호 — partial 텍스트가 과도하면 잘라 렌더러/버퍼 메모리를 바운드한다
        // (모든 런타임 공통). 정상 응답엔 영향 없고 2MB 초과분만 절단.
        const ev: McpInvocationEvent =
          rawEv.kind === "partial" && typeof rawEv.text === "string" && rawEv.text.length > MAX_PARTIAL_CHARS
            ? {
                ...rawEv,
                text:
                  rawEv.text.slice(0, MAX_PARTIAL_CHARS) +
                  (pickLocale(req) === "ko"
                    ? "\n\n[출력이 너무 길어 잘렸습니다 — 런어웨이 출력 메모리 보호]"
                    : "\n\n[Output truncated — runaway output memory guard]"),
              }
            : rawEv;
        // 메인 스트림 partial은 델타로 전송 — 런타임이 60ms마다 누적 전문을 주므로 그대로 보내면
        // IPC 페이로드가 O(전체)로 커져 긴 답변일수록 끊긴다. 여기서 증분만 잘라 보낸다.
        // 버퍼(attach 리플레이)에는 항상 전문 스냅샷을 유지해 재접속 복원은 기존과 동일.
        let wireEv = ev;
        if (ev.kind === "partial" && !ev.agentId && typeof ev.text === "string") {
          const full = ev.text;
          const prev = record.partialText;
          const probe = Math.min(32, prev.length);
          const appended =
            full.length >= prev.length &&
            (probe === 0 || full.slice(prev.length - probe, prev.length) === prev.slice(-probe));
          if (appended) {
            const delta = full.slice(prev.length);
            if (!delta) return; // 변화 없음(절단 안정 상태 등) — 전송/버퍼 갱신 불필요
            wireEv = { ...ev, text: undefined, delta, textLen: full.length };
          } else {
            // append 불변식이 깨짐(절단 전환 등) — 전문 폴백, 렌더러는 text로 재동기화
            wireEv = { ...ev, textLen: full.length };
          }
          record.partialText = full;
        }
        // 재접속용 버퍼링 — partial은 매번 누적 전체 텍스트라, 직전이 partial이면 교체해
        // 메모리를 바운드한다(tool/thinking/agentId 이벤트는 누적 단계라 보존하되 상한 적용).
        const last = record.events[record.events.length - 1];
        if (ev.kind === "partial" && !ev.agentId && last && last.kind === "partial" && !last.agentId) {
          record.events[record.events.length - 1] = ev;
        } else {
          record.events.push(ev);
        }
        if (record.events.length > MAX_BUFFERED_EVENTS) {
          record.events.splice(0, record.events.length - MAX_BUFFERED_EVENTS);
        }
        // 창이 닫힌 뒤(닫기와 스트림 종료가 겹치는 경우) send는 throw하므로 destroyed 가드.
        if (win && !win.isDestroyed()) {
          try { win.webContents.send(channel, wireEv); } catch {}
        }
        // 종료 이벤트는 즉시 레지스트리에서 제거 — 답변은 final emit 직전에 이미 영속화되므로(client.ts),
        // 재접속(attach)이 '끝난 실행'을 반환해 히스토리 행과 답변이 중복 렌더되는 창을 닫는다.
        if (ev.kind === "final" || ev.kind === "error") {
          if (activeRuns.delete(runId)) broadcastActiveChats();
        }
      },
      controller.signal,
    ).finally(() => {
      // 위 sink에서 이미 지워졌으면(정상 종료) no-op — abort/throw로 종료 이벤트가 없던 경우만 정리.
      if (activeRuns.delete(runId)) broadcastActiveChats();
    });

    return { runId };
  });

  // 진행 중인 실행 취소 — CLI 자식 프로세스 kill / API fetch abort.
  ipcMain.handle("invoke:cancel", (_e, runId: string) => {
    activeRuns.get(runId)?.controller.abort();
    if (activeRuns.delete(runId)) broadcastActiveChats();
  });

  // 현재 실행 중인 chatId 목록 — 사이드바 인디케이터 초기 시드용.
  ipcMain.handle("invoke:activeChats", () => activeChatIds());

  // 채팅 진입 시 진행 중 실행에 재접속 — 그 chat의 최신 실행 runId + 버퍼된 이벤트를 돌려준다.
  // 렌더러는 events를 리플레이해 진행 중 버블을 복원하고, runId 채널을 구독해 이후 스트림을 받는다.
  ipcMain.handle("invoke:attach", (_e, chatId: string) => {
    let found: { runId: string; events: McpInvocationEvent[] } | null = null;
    for (const [runId, rec] of activeRuns) {
      if (rec.chatId === chatId) found = { runId, events: rec.events.slice() };
    }
    return found;
  });

  ipcMain.handle("invoke:history", (_e, chatId: string) => listChatMessages(chatId));
  ipcMain.handle("invoke:clearHistory", (_e, chatId: string) => {
    clearChatMessages(chatId);
  });

  // ── Hephaestus 엔진 브리지 ──────────────────────────────────────────────
  // 임베딩된 오픈소스 엔진(Hephaestus)을 범용 CLI/JSON 으로 호출한다. 엔진 측에는 데스크탑
  // 흔적이 없고, 모든 연결 코드는 electron/hephaestus/* + 아래 핸들러에만 존재한다.
  ipcMain.handle("hephaestus:status", (_e, locale?: "ko" | "en") => hephaestusAvailable(locale));
  ipcMain.handle("hephaestus:doctor", () => hephaestusDoctor());
  ipcMain.handle(
    "hephaestus:stormbreaker",
    (_e, input: { query: string; project?: string; background?: boolean; researchEvidence?: boolean }) =>
      stormbreakerRun(input.query, {
        project: input.project,
        background: input.background,
        researchEvidence: input.researchEvidence,
      }),
  );
  ipcMain.handle("hephaestus:getSupervisor", () => ({ enabled: isSupervisorEnabled() }));
  ipcMain.handle("hephaestus:setSupervisor", (_e, enabled: boolean) => setSupervisorEnabled(enabled));
  ipcMain.handle(
    "hephaestus:journal",
    (_e, input: { action: "status" | "verify" | "repair" | "gate"; runId?: string; project?: string }) =>
      stormbreakerJournal(input.action, { runId: input.runId, project: input.project }),
  );
  ipcMain.handle("hephaestus:search", (_e, input: { query: string; limit?: number }) =>
    hepSearch(input.query, { limit: input.limit }),
  );
  ipcMain.handle("hephaestus:network", (_e, input: { query: string; autoRun?: boolean; noOpen?: boolean }) =>
    hepNetwork(input.query, { autoRun: input.autoRun, noOpen: input.noOpen }),
  );
  // 추천 미리보기 — routeOnly(실행 없음)을 정규화해 추천 바텀시트에 넘긴다. 인터랙티브해야 하므로
  // 기본 120s 대신 짧은 timeout. 실패/비가용 시에도 절대 throw 하지 않고 mode:"none" 으로 강등한다.
  ipcMain.handle(
    "hephaestus:routePreview",
    async (
      _e,
      input: { query: string; project?: string; scope?: "network" | "cloud"; allowLocal?: boolean; offline?: boolean },
    ) => {
      try {
        const res = await routeOnly(input.query, {
          project: input.project,
          scope: input.scope,
          allowLocal: input.allowLocal ?? true,
          noHub: input.offline, // 오프라인-안전: 로컬 라우팅만
          timeoutMs: 30_000,
        });
        return normalizeRecommendation(res.json, input.query);
      } catch {
        return normalizeRecommendation(null, input.query);
      }
    },
  );
  ipcMain.handle("hephaestus:localGui", (_e, input: { shortcut: string; detach?: boolean; noOpen?: boolean }) =>
    localGui(input.shortcut, { detach: input.detach, noOpen: input.noOpen }),
  );
  ipcMain.handle(
    "hephaestus:publish",
    async (
      event,
      input: { folder: string; visibility: "private-link" | "marketplace"; dryRun?: boolean; locale?: "ko" | "en" },
    ) => {
      const locale = input.locale ?? "ko";
      let folder: string;
      try {
        folder = resolveFolderArg(input.folder, locale);
      } catch (e) {
        return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
      }
      // off-device 업로드 — 사용자 확인 강제(dry-run 은 업로드 없음이므로 제외).
      if (!input.dryRun) {
        const win = BrowserWindow.fromWebContents(event.sender);
        const ok = await confirmUpload(folder, input.visibility, win, locale);
        if (!ok) {
          return {
            ok: false,
            exitCode: null,
            json: null,
            stdout: "",
            stderr: "",
            error: locale === "ko" ? "사용자가 업로드를 취소했습니다." : "Upload cancelled by user.",
          };
        }
      }
      return hepPublish(folder, input.visibility, { dryRun: input.dryRun });
    },
  );
  ipcMain.handle(
    "hephaestus:package",
    async (event, input: { folder: string; visibility?: "private-link" | "marketplace"; locale?: "ko" | "en" }) => {
      const locale = input.locale ?? "ko";
      let folder: string;
      try {
        folder = resolveFolderArg(input.folder, locale);
      } catch (e) {
        return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
      }
      // package 는 폴더 텍스트 내용을 읽어 번들을 만들므로(off-device 후속 가능) 확인을 받는다.
      const win = BrowserWindow.fromWebContents(event.sender);
      const ok = await confirmUpload(folder, input.visibility ?? "marketplace", win, locale);
      if (!ok) {
        return {
          ok: false,
          exitCode: null,
          json: null,
          stdout: "",
          stderr: "",
          error: locale === "ko" ? "사용자가 패키징을 취소했습니다." : "Packaging cancelled by user.",
        };
      }
      return hepPackage(folder, { visibility: input.visibility });
    },
  );
  ipcMain.handle("hephaestus:securityScan", (_e, input: { folder: string; strict?: boolean; locale?: "ko" | "en" }) => {
    let folder: string;
    try {
      folder = resolveFolderArg(input.folder, input.locale ?? "ko");
    } catch (e) {
      return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
    }
    return securityScan(folder, { strict: input.strict });
  });
  ipcMain.handle("hephaestus:aoGraph", (_e, input?: { agent?: string; dir?: string; locale?: "ko" | "en" }) => {
    const inp = input ?? {};
    let dir: string | undefined;
    if (inp.dir != null && String(inp.dir).trim()) {
      try {
        dir = resolveFolderArg(inp.dir, inp.locale ?? "ko");
      } catch (e) {
        return { ok: false, exitCode: null, json: null, stdout: "", stderr: "", error: (e as PathGuardError).message };
      }
    }
    return aoGraph({ agent: inp.agent, dir });
  });

  // 빌더(hep-build) — 활성 런타임으로 Hephaestus 빌더 에이전트를 구동, 이벤트 스트리밍.
  ipcMain.handle("hephaestus:build", (event, req: HephaestusBuildRequest) => {
    const runId = randomUUID();
    const channel = `hephaestus:build:${runId}`;
    const win = BrowserWindow.fromWebContents(event.sender);
    const controller = new AbortController();
    activeBuilds.set(runId, controller);
    // 렌더러는 build() 응답을 await 한 뒤에야 채널을 구독하므로, 그 사이에 발생한 첫 이벤트
    // (예: 'build' stage 틱)가 유실될 수 있다. 렌더러가 buildReady 로 구독 완료를 알릴 때까지
    // 이벤트를 버퍼링했다가 한 번에 flush 한다(첫 stage 틱 손실 방지).
    const pending: HephaestusBuildEvent[] = [];
    let ready = false;
    // 창이 닫힌 뒤 send는 throw하므로 destroyed 가드(빌드 종료와 닫기가 겹치는 경우).
    const sendToWin = (ev: HephaestusBuildEvent) => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send(channel, ev); } catch {}
      }
    };
    const emit = (ev: HephaestusBuildEvent) => {
      if (ready) {
        sendToWin(ev);
      } else {
        pending.push(ev);
      }
    };
    buildReadySignals.set(runId, () => {
      if (ready) return;
      ready = true;
      for (const ev of pending) sendToWin(ev);
      pending.length = 0;
    });
    void runHephaestusBuild(runId, req, emit, controller.signal, pickLocale(req)).finally(() => {
      activeBuilds.delete(runId);
      buildReadySignals.delete(runId);
    });
    return { runId };
  });
  ipcMain.handle("hephaestus:buildReady", (_e, runId: string) => {
    buildReadySignals.get(runId)?.();
  });
  ipcMain.handle("hephaestus:cancelBuild", (_e, runId: string) => {
    activeBuilds.get(runId)?.abort();
    activeBuilds.delete(runId);
  });

  // Startup Founder Studio — 패키지 자체 런처를 spawn 해 실제 SPA 를 로컬 서빙, iframe URL 반환.
  ipcMain.handle("hephaestus:startStudio", () => startStudio());
  ipcMain.handle("hephaestus:stopStudio", () => {
    stopStudio();
  });
}
