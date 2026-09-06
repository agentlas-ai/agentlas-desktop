// Electron 진입점.
// dev:  ELECTRON_START_URL = http://localhost:3100 (Next.js dev server)
// prod: file://dist/renderer/index.html (next export 결과)
//
// 보안 원칙 — PRD 6.2:
// - contextIsolation: true
// - nodeIntegration: false
// - sandbox: true (renderer는 sandboxed)
// - 모든 Node API는 preload → ipc 경로로만 노출
import { startInstallBeacon } from "./install-beacon";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  protocol,
  session,
  shell,
  webContents,
} from "electron";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { installModelCatalogResolver, refreshRemoteCatalog } from "./runtime/model-catalog";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  configureInstallIdentity,
  resolveInstallIdentity,
  type InstallIdentity,
} from "./install-identity";
import { registerIpcHandlers } from "./ipc";
import { ScienceProjectFolderSelections, validateScienceProjectFolderPath } from "./science/project-folder-selection";
import { listPendingAskUserRequests, submitAskUserAnswer } from "./confirm/ask-user";
import { buildAppMenu } from "./menu";
import { closeStore, initStore, runPostContinuityStoreRepairs } from "./store/db";
import { onDesktopStoreChange } from "./store/change-bus";
import { repairPlaceholderTaskTitles } from "./store/chats";
import { settleInterruptedTasksOnBoot } from "./store/tasks";
import { scrubLegacyRunEventSecrets, tryRecordRunEvent } from "./store/run-events";
import { startAutomationScheduler, stopAutomationScheduler } from "./automation-scheduler";
import { claimOneBriefingDesktopNotification, configureOneBriefingRuntime } from "./one/briefing";
import { invocationService } from "./invocation/service";
import {
  disposeAutoUpdater,
  getUpdaterState,
  handleUpdaterBootstrapFailure,
  hasUpdaterInstallRecoveryState,
  initAutoUpdater,
  noteHealthyStartup,
  onUpdaterStateChange,
  preflightUpdaterStartup,
  quitAndInstall as installDownloadedUpdate,
} from "./updater";
import { createAutomaticQuitInstaller } from "./updater/automatic-quit-install";
import { scrubInactiveUpdaterRecoveryOpenCrabCredentialUrls } from "./updater/continuity";
import { resolveMacAppBundle } from "./updater/controller";
import { disposeAppFactoryLaunches } from "./app-factory/operations";
import { disposeAppFactoryLivePreviews } from "./app-factory/live-preview";
import { disposeSiteAgentAppRuntimes } from "./site/agent-app-runtime";
import {
  bootAuthFromKeychain,
  getAuthenticatedActorIds,
  getAuthSession,
  onAuthSessionInvalidated,
  onAuthSessionRestored,
  retryTemporaryAuthRestore,
  type AuthRestoreResult,
} from "./auth";
import {
  broadcastHubBookmarkSnapshot,
  failCloseActiveHubBookmarks,
  syncHubBookmarks,
} from "./hub-bookmark-sync";
import { materializeAllAgents } from "./agents/files";
import { backfillEntityKinds } from "./mcp/registry";
import { backfillLegacyLocalRouteDefinitionHashes } from "./agents/routes";
import { dedupeLocalInstalledAgents } from "./store/agent-dedupe";
import { reconcileExistingCuratedMemoryCandidates } from "./experience/store";
import { migrateRegisteredAgents } from "./architecture/agent-migrations";
import { seedBuiltinAgents } from "./architecture/seed";
import { repairAllRootChatSurfaceControllers } from "./store/chats";
import { ensureDefaultMcpPluginsInstalled } from "./mcp-tools/defaults";
import { materializeBuiltinPlugins } from "./plugins/materialize";
import { startHephaestusRuntimeAutoUpdate } from "./hephaestus/engine";
import { startCliRuntimeAutoUpdate, stopCliRuntimeAutoUpdate } from "./runtime/auto-update";
import { scrubLegacyOpenCrabMcpConfig } from "./mcp-tools/mcp-config";
import { scrubLegacyOpenCrabCredentialUrls } from "./mcp-tools/registry";
import { startBrowserApprovalServer, stopBrowserApprovalServer } from "./browser/approval-server";
import { startMcpProxyApprovalServer, stopMcpProxyApprovalServer } from "./mcp-tools/proxy-server";
import { startComputerUseControlServer, stopComputerUseControlServer } from "./computer-use/control-server";
import { authorizeLocalMediaPath } from "./fs/access";
import { readChatMessageAttachment } from "./store/chat-message-attachments";
import { serveOneArtifactProtocolRequest } from "./one/artifact-preview";
import { resolveOneTeamAvatarProtocolPath } from "./one/avatar";
import { servePluginIconRequest } from "./mcp-tools/plugin-brand";
import { reconcileOneHubDerivativeDraftStorage } from "./one/hub-derivative";
import { recoverDesktopStartup, type StartupRecoveryPresentation } from "./one/startup-recovery";
import { initFileLogging, mainLogFilePath } from "./logging";
import { currentUiLocale, setCurrentUiLocale } from "./ui-locale";
import { prepareMacRuntimeResourcesForExecution } from "./runtime/mac-resource-seal";
import {
  issueMobileBridgePairing,
  listMobileBridgeDevices,
  mobileBridgeRuntimeStatus,
  onMobileBridgeStateChanged,
  reconcileMobileBridgeDevicesForAccount,
  revokeMobileBridgeDevice,
  retryAgentlasMobileBridge,
  startAgentlasMobileBridge,
  stopAgentlasMobileBridge,
} from "./mobile-bridge/runtime";
import { userDataDir } from "./runtime-paths";
import { runHostShutdownHooks } from "./host-lifecycle";
import {
  initializeAppRuntimeCoordinator,
  registerAppRuntimeParticipant,
  shutdownAppRuntimeCoordinator,
} from "./long-run/app-runtime-coordinator";
import {
  closeLongRunVerifierAdmission,
  interruptLongRunVerifiers,
  longRunVerifiersSettled,
  openLongRunVerifierAdmission,
} from "./long-run/verifier";
import { classifyStartupNavigationFailure } from "./startup-navigation";
import {
  recoverAgentlasBrowserRuntimeAtStartup,
  sweepAgentlasBrowserOrphans,
  withBrowserCdpMaintenance,
} from "./mcp-tools/browser-cdp-launcher";
import {
  installScienceExtension,
  installScienceSuite,
  scienceExtensionStatus,
  activeScienceExtension,
  scienceSuiteStatus,
  scienceRendererPackStatuses,
  resolveVerifiedScienceRenderer,
  setScienceExtensionEnabled,
  uninstallScienceExtension,
} from "./extensions/science";
import {
  closeAllScienceExtensionViews,
  closeScienceExtensionView,
  captureScienceExtensionViewRegion,
  assertScienceExtensionViewPermission,
  isScienceExtensionViewSender,
  openScienceExtensionView,
  setScienceExtensionViewBounds,
  mountScienceRendererView,
  updateScienceRendererViewBounds,
  setScienceRendererViewVisibility,
  disposeScienceRendererView,
  scienceRendererHandshake,
  scienceRendererReport,
  captureStableScienceRenderer,
  markScienceRendererCaptured,
  failScienceRendererCapture,
  authorizeScienceChemistryCommit,
  authorizeScienceMolstarCommit,
  notifyScienceChemistryCommitted,
  notifyScienceArtifactChanged,
  sendScienceTurnEventToView,
} from "./extensions/view-host";
import {
  closeScienceStore,
  recoverScienceRuntimeAtStartup,
  scienceArtifactPublicationValidator,
  scienceChemistryValidator,
  scienceConversationService,
  scienceEvidenceGraphService,
  scienceJournalPublicationService, scienceManuscriptRenderService,
  scienceStore,
  scienceToolGateway,
  shutdownScienceRuntimeForAppClose,
  configureScienceServiceAvailability, retryFailedScienceServiceLoad,
  scienceStatisticsMethodCatalogue, createScienceDatasetIngestionService, scienceSchemaVersion,
} from "./science/lazy-services";
import type {
  MaterializeScienceEvidenceGraphInferenceInput,
  ProposeScienceEvidenceGraphInferenceInput,
  RefreshScienceEvidenceGraphInput,
  ReviewScienceEvidenceGraphInferenceInput,
} from "../shared/science-evidence-graph";
import { scienceLabDecisionProjectionsForProject } from "./science/lazy-services";
import { inspectScienceEpisodeResultReview, recordScienceEpisodeResultReview } from "./science/lazy-services";
import { commitScienceVegaEdit, parseScienceVegaEditInput } from "./science/lazy-services";
import {
  renderScienceStatisticsFigurePdf,
  renderScienceStatisticsFigurePng,
  renderScienceStatisticsFigureSvg,
  renderScienceStatisticsFigureSvgPreviewPng,
  renderScienceStatisticsFigureTiff,
} from "./science/lazy-services";
import { validateScienceNumericSurfacePngBytes } from "./science/lazy-services";
import { validateScienceResidueInteraction } from "./science/lazy-services";
import { draftManuscript } from "./science/lazy-services";
import { inspectScienceManuscriptDepth } from "./science/lazy-services";
import type {
  ReviseScienceHypothesisInput,
  ScienceManuscriptBinding,
  ScienceSubmissionMetadata,
  ApplyScienceManuscriptTransactionInput,
  RevertScienceManuscriptTransactionInput,
  CreateScienceManuscriptSelectionContextInput,
  CreateScienceManuscriptEditProposalInput,
  ApplyScienceManuscriptEditProposalInput,
  RejectScienceManuscriptEditProposalInput,
  AppendScienceManuscriptVersionInput,
  InspectScienceEpisodeResultReviewInput,
  RecordScienceEpisodeResultReviewInput,
  CaptureScienceArtifactInput,
  RecordScienceManuscriptBlueprintAssessmentInput,
  CreateScienceJournalProfileInput,
  CreateScienceSubmissionExportInput,
  ConfirmScienceJournalIdentityInput,
  ConfirmScienceJournalHumanAttestationInput,
  CreateScienceProjectInput,
  ReplaceScienceProjectWorkspaceTabsInput,
  UpdateScienceProjectNavigationInput,
  UpdateScienceProjectRelatedDomainsInput,
  UpsertScienceProjectLabBindingInput,
  ApproveScienceResearchContractInput,
  SetScienceApprovalPolicyInput,
  StartScienceLoopSessionInput,
  TransitionScienceLoopSessionInput,
  AnswerScienceDecisionInput,
  DeferScienceDecisionInput,
  PresentScienceDecisionInput,
  ReviewScienceAnalysisPlanInput,
  ScienceDecisionRequest,
} from "../shared/science-contract";
import type { ProductExtensionPermission } from "../shared/product-extension";
import type { ScienceComposerStartInput } from "./science/conversation-service";

const activeScienceChemistryCommits = new Set<string>();
configureScienceServiceAvailability(() => {
  const status = scienceExtensionStatus();
  return status.phase === "installed" && status.enabled;
});
import {
  SCIENCE_RENDERER_REQUEST_SCHEMA,
  SCIENCE_RESIDUE_INTERACTION_SCHEMA,
  isScienceChemistryCommitInput,
  isScienceMolstarCommitInput,
  isMountScienceRendererInput,
  scienceRendererBindingsEqual,
  type MountScienceRendererInput,
  type ScienceChemistryCommitInput,
  type ScienceMolstarCommitInput,
} from "../shared/science-renderer-runtime";

export { currentUiLocale } from "./ui-locale";

const isDev = process.env.NODE_ENV === "development";
const AUTH_SESSION_CHANGED_CHANNEL = "auth:sessionChanged";
let disposeAuthSessionInvalidation: (() => void) | null = null;
let disposeAuthSessionRestoration: (() => void) | null = null;
let disposeMobileBridgeStateChange: (() => void) | null = null;
let disposeOneTeamNotificationBridge: (() => void) | null = null;
let deferredAuthRestorePromise: Promise<AuthRestoreResult> | null = null;
const oneTeamNotificationKeys = new Set<string>();

/**
 * The native updater E2E launches the replacement process without a terminal,
 * so a failure before `app.whenReady()` used to leave only a live PID and a
 * stale journal. Keep a synchronous trace behind an E2E-only path supplied by
 * the verifier; ordinary packaged launches never create this file.
 */
const UPDATER_E2E_TRACE_PATH_ENV = "AGENTLAS_UPDATER_E2E_TRACE_PATH";
function traceUpdaterStartup(stage: string): void {
  const tracePath = process.env[UPDATER_E2E_TRACE_PATH_ENV]?.trim();
  if (!tracePath || !path.isAbsolute(tracePath)) return;
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      tracePath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        stage,
        pid: process.pid,
        platform: process.platform,
        packaged: app.isPackaged,
        updatedArg: process.argv.includes("--updated"),
        appImage: Boolean(process.env.APPIMAGE),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostics must never change the startup outcome.
  }
}

// AppImage's extract-and-run runtime can preserve the launching process's
// APPIMAGE value while executing a renamed replacement. The replacement's
// absolute AppImage argument is still authoritative; repair the environment
// before updater initialization so future checks and installs address the live
// payload instead of the deleted baseline file.
function repairLinuxAppImageEnvironment(): void {
  if (process.platform !== "linux" || !app.isPackaged) return;
  const candidates = [...process.argv];
  try {
    candidates.push(...fs.readFileSync("/proc/self/cmdline", "utf8").split("\0"));
  } catch {
    // Some Linux environments hide procfs; process.argv remains sufficient.
  }
  const launchedAppImage = candidates.find((value) => (
    path.isAbsolute(value)
    && /\.AppImage$/i.test(value)
    && fs.existsSync(value)
  ));
  if (!launchedAppImage) return;
  const resolved = path.resolve(launchedAppImage);
  if (process.env.APPIMAGE !== resolved) process.env.APPIMAGE = resolved;
}

repairLinuxAppImageEnvironment();

traceUpdaterStartup("module-loaded");

function broadcastAuthSession(sessionSnapshot: ReturnType<typeof getAuthSession>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send(AUTH_SESSION_CHANGED_CHANNEL, sessionSnapshot);
      } catch {
        // A renderer may disappear while the main-process auth boundary runs.
      }
    }
  }
}

function broadcastSignedOutSession(): void {
  broadcastAuthSession({ signedIn: false });
}

function scheduleDeferredAuthRestore(): void {
  if (deferredAuthRestorePromise) return;
  deferredAuthRestorePromise = retryTemporaryAuthRestore()
    .then((result): AuthRestoreResult => {
      if (result.status !== "restored") {
        console.warn(`[auth] deferred startup restore stopped (${result.status})`);
        return result;
      }
      const sessionSnapshot = getAuthSession();
      if (!sessionSnapshot.signedIn) {
        return { status: "temporarily-unavailable", signedIn: false };
      }
      // Startup may already have mounted the signed-out/device bookmark slice.
      // Switch authority before notifying renderers, then reconcile the exact
      // restored workspace in the background.
      failCloseActiveHubBookmarks();
      broadcastAuthSession(sessionSnapshot);
      broadcastHubBookmarkSnapshot();
      void syncHubBookmarks({ rerunIfBusy: true });
      return result;
    })
    .catch((error): AuthRestoreResult => {
      console.warn("[auth] deferred startup restore failed", error);
      return { status: "temporarily-unavailable", signedIn: false };
    });
}

// 앱이 이미 ready면 스킵 — electron 스토어 테스트(scripts/test-*.cjs)가 whenReady 후에
// store/chats.js → main.js를 require하는데, ready 이후 호출은 electron이 throw한다.
// 프로덕션 부팅에선 main.js가 항상 ready 전에 로드되므로 동작 변화 없음.
if (!app.isReady()) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "agentlas",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

function readPackagedInstallMetadata(): unknown {
  try {
    // electron-builder injects the marker into this immutable app.asar copy,
    // rather than relying on a mutable environment variable at launch.
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
  } catch {
    throw new Error("Packaged install identity metadata could not be read");
  }
}

function initializeInstallIdentity(): InstallIdentity {
  try {
    const qaUserDataDir = process.env.AGENTLAS_QA_USER_DATA_DIR?.trim() || null;
    if (qaUserDataDir && !path.isAbsolute(qaUserDataDir)) {
      throw new Error("QA userData override must be an absolute path");
    }
    const identity = resolveInstallIdentity({
      packaged: app.isPackaged,
      packageMetadata: app.isPackaged ? readPackagedInstallMetadata() : undefined,
      qaUserDataDir,
      // Source-driven Playwright/QA runs deliberately remain possible, but a
      // packaged app can never switch identity through its launch environment.
      allowQaOverride: !app.isPackaged,
    });
    configureInstallIdentity(identity);

    // Official releases intentionally preserve their historical values:
    // name Agentlas, Electron's default userData path, and its Keychain
    // service. Only non-official identities receive an explicit namespace.
    app.setName(identity.appName);
    const userDataDir = identity.userDataOverride
      ?? (identity.channel === "local-candidate" || identity.channel === "dev"
        ? path.join(app.getPath("appData"), identity.userDataNamespace)
        : null);
    if (userDataDir) {
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      app.setPath("userData", userDataDir);
    }
    if (identity.channel === "dev") {
      console.info("[Agentlas-Dev] 별도의 개발 프로필을 사용합니다. 공식 Agentlas의 로그인과 데이터는 기존 프로필에 그대로 보존됩니다. 개발 프로필은 처음에는 비어 있을 수 있습니다.");
    }
    return identity;
  } catch (error) {
    // Fail before any protected storage, store migration, or updater access.
    // Do not print a path or package payload from an untrusted bundle.
    console.error("[install-identity] startup refused", error instanceof Error ? error.message : "unknown error");
    app.exit(78);
    throw error;
  }
}

const installIdentity = initializeInstallIdentity();
traceUpdaterStartup("install-identity-ready");

/**
 * macOS dock 아이콘 — dev에서는 Electron 기본(원자 모양) 대신 우리 paw squircle.
 * production 빌드는 electron-builder가 .icns로 bundling하므로 이 경로는 dev 전용.
 * (whenReady 이후에 setIcon 호출 — 그 전에는 dock 핸들이 unstable)
 */
function applyDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) return;
  // The comment above already says this path is dev-only, but the guard was
  // missing, so every packaged launch ran it and logged
  // "[dock] icon not found or empty at .../app.asar/build-resources/icon-1024.png".
  // That lookup can never succeed in a packaged build: electron-builder's
  // `files:` list packages dist/electron, dist/shared, dist/renderer and
  // package.json only, so build-resources/ is never inside app.asar. The real
  // Dock and Finder icon comes from Contents/Resources/icon.icns via
  // CFBundleIconFile, which is why nobody noticed a wrong icon — only a
  // permanent false warning in the shipped log, which teaches everyone to
  // ignore startup warnings.
  if (app.isPackaged) return;
  // dist/electron/main.js → ../../build-resources/icon-1024.png
  const iconPath = path.join(__dirname, "../../build-resources/icon-1024.png");
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) {
      // 파일이 없거나 손상된 경우 — empty image면 nativeImage가 throw 안 함
      console.warn(`[dock] icon not found or empty at ${iconPath} — using Electron default`);
      return;
    }
    app.dock.setIcon(img);
    const size = img.getSize();
    console.log(`[dock] icon set ${size.width}x${size.height} from ${iconPath}`);
  } catch (err) {
    console.warn(`[dock] failed to set icon from ${iconPath}:`, err);
  }
}

// A hidden window must never outlive its reveal path. If the display is asleep
// the first-paint event never arrives, so this bounds the wait before showing
// the window anyway.
const MAIN_WINDOW_REVEAL_FALLBACK_MS = 8_000;
const STARTUP_PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agentlas</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f7f4; color: #20221f; }
    main { width: min(420px, calc(100vw - 48px)); padding: 32px; border: 1px solid #dedfd8; border-radius: 18px; background: #ffffff; box-shadow: 0 18px 55px rgba(31, 34, 29, 0.09); }
    h1 { margin: 0 0 10px; font-size: 25px; letter-spacing: -0.02em; }
    p { margin: 0 0 20px; color: #656960; font-size: 14px; line-height: 1.5; }
    progress { width: 100%; height: 6px; accent-color: #6c705b; }
  </style>
</head>
<body>
  <main role="status" aria-live="polite">
    <h1>Agentlas</h1>
    <p id="startup-summary">Opening your workspace securely.</p>
    <section id="startup-question" hidden>
      <p id="startup-question-copy"></p>
      <div id="startup-options"></div>
    </section>
    <progress aria-label="Opening Agentlas"></progress>
  </main>
</body>
</html>`;
const STARTUP_PLACEHOLDER_URL = `data:text/html;charset=utf-8,${encodeURIComponent(STARTUP_PLACEHOLDER_HTML)}`;

let mainWindow: BrowserWindow | null = null;
let lastStartupNavigationFailure: {
  kind: ReturnType<typeof classifyStartupNavigationFailure>;
  target: string;
} | null = null;
let shellReadyForWindows = false;
let oneBriefingLaunchTimer: NodeJS.Timeout | null = null;
let oneBriefingInterval: NodeJS.Timeout | null = null;

async function presentStartupRecovery(presentation: StartupRecoveryPresentation): Promise<string | null> {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null;
  const payload = JSON.stringify(presentation);
  return mainWindow.webContents.executeJavaScript(`(() => {
    const value = ${payload};
    const summary = document.getElementById("startup-summary");
    if (summary) summary.textContent = value.summary || "";
    const sheet = document.getElementById("startup-question");
    const question = document.getElementById("startup-question-copy");
    const options = document.getElementById("startup-options");
    if (sheet && question && options) {
      sheet.hidden = !value.question;
      question.textContent = value.question || "";
      options.replaceChildren(...(value.options || []).map((option) => {
        const node = document.createElement("button");
        node.type = "button";
        node.textContent = option.label;
        node.dataset.actionId = option.actionId;
        return node;
      }));
    }
    if (!value.question || !value.options?.length) return null;
    return new Promise((resolve) => {
      options.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target.closest("button[data-action-id]") : null;
        resolve(target instanceof HTMLButtonElement ? target.dataset.actionId || null : null);
      }, { once: true });
    });
  })()`);
}

async function openOneFromNotification(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send("menu:navigate", "/one");
}

function checkOneBriefingDesktopNotification(): void {
  if (!getAuthSession().signedIn) return;
  if (!Notification.isSupported()) return;
  try {
    const candidate = claimOneBriefingDesktopNotification();
    if (!candidate) return;
    // Privacy boundary: OS surfaces never receive a project, Task, customer,
    // automation title, or evidence. Details remain inside authenticated One.
    // PRD §4.33 — OS 알림만 영어 하드코딩이라 한국어 사용자는 화면 안 문구는 한국어로,
    // 알림만 영어로 봤다. 로케일 표를 지나게 한다.
    const notification = new Notification({
      title: "Agentlas One",
      body: currentUiLocale() === "ko"
        ? "확인이 필요한 일이 있어요. Agentlas 를 열어 살펴보세요."
        : "One found something that may need your attention. Open Agentlas to review it.",
      silent: true,
    });
    notification.on("click", () => { void openOneFromNotification(); });
    notification.show();
  } catch (error) {
    console.warn("[one-briefing] desktop notification check failed", error);
  }
}

/**
 * One Team notifications are deliberately sparse: approvals, failures, and
 * completions that took longer than five minutes.  The renderer remains the
 * source of detail; the OS surface only says that One needs attention.  A
 * durable settlement is the event boundary, so no polling or duplicate timer
 * can emit the same notification twice in this process.
 */
function startOneTeamNotificationBridge(): void {
  if (disposeOneTeamNotificationBridge) return;
  disposeOneTeamNotificationBridge = invocationService.onSettled((envelope) => {
    const receipt = envelope.receipt;
    const reason = envelope.pendingQuestion
      ? "approval"
      : receipt.status === "failed"
        ? "failure"
        : receipt.status === "completed" && Date.parse(receipt.finishedAt || receipt.updatedAt) - Date.parse(receipt.startedAt) >= 5 * 60 * 1_000
          ? "long-complete"
          : null;
    if (!reason || !getAuthSession().signedIn || !Notification.isSupported()) return;
    // Focused Desktop is the foreground host and owns the in-app indication;
    // avoid the duplicate OS toast. A hidden/minimized host gets one toast.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;
    const key = `${receipt.runId}:${reason}`;
    if (oneTeamNotificationKeys.has(key)) return;
    oneTeamNotificationKeys.add(key);
    if (oneTeamNotificationKeys.size > 512) oneTeamNotificationKeys.delete(oneTeamNotificationKeys.values().next().value as string);
    const notificationLocale = currentUiLocale();
    const body = reason === "approval"
      ? (notificationLocale === "ko" ? "이어가려면 확인이 필요해요." : "One needs your input to continue.")
      : reason === "failure"
        ? (notificationLocale === "ko" ? "확인이 필요한 실패한 작업이 있어요." : "One had a failed run to review.")
        : (notificationLocale === "ko" ? "오래 걸린 작업을 끝냈어요." : "One finished a long-running task.")
    const notification = new Notification({ title: "Agentlas One", body, silent: true });
    notification.on("click", () => { void openOneFromNotification(); });
    notification.show();
  });
}

function startOneBriefingScheduler(): void {
  if (oneBriefingLaunchTimer || oneBriefingInterval) return;
  configureOneBriefingRuntime({ activeChatIds: () => invocationService.activeChatIds() });
  oneBriefingLaunchTimer = setTimeout(() => {
    oneBriefingLaunchTimer = null;
    checkOneBriefingDesktopNotification();
  }, 8_000);
  oneBriefingLaunchTimer.unref();
  oneBriefingInterval = setInterval(checkOneBriefingDesktopNotification, 15 * 60 * 1_000);
  oneBriefingInterval.unref();
}

function stopOneBriefingScheduler(): void {
  if (oneBriefingLaunchTimer) clearTimeout(oneBriefingLaunchTimer);
  if (oneBriefingInterval) clearInterval(oneBriefingInterval);
  oneBriefingLaunchTimer = null;
  oneBriefingInterval = null;
}

const allowMultiInstance = process.env.AGENTLAS_ALLOW_MULTI_INSTANCE === "1";
// AppImageUpdater relaunches the replacement with no `--updated` argument.
// Use our durable install state as the cross-platform authority, otherwise the
// replacement mistakes itself for an ordinary second launch, exits before
// reconciliation, and leaves only the AppImage wrapper plus a permanent journal.
const isPackagedUpdateRelaunch = app.isPackaged && (
  process.argv.includes("--updated")
  || process.env.AGENTLAS_UPDATE_RELAUNCH === "1"
  || process.env.APPIMAGE_SILENT_INSTALL === "true"
  || hasUpdaterInstallRecoveryState()
);
const UPDATE_RELAUNCH_LOCK_RETRY_MS = 250;
const UPDATE_RELAUNCH_LOCK_TIMEOUT_MS = 60_000;
traceUpdaterStartup("before-single-instance-lock");
// Native update installers already serialize replacement and start the target
// after the previous executable exits. Re-requesting Electron's old singleton
// lock in that path can strand the replacement with its journal still present.
const initialSingleInstanceLock = allowMultiInstance
  || isPackagedUpdateRelaunch
  || app.requestSingleInstanceLock();
const singleInstanceLockPromise = initialSingleInstanceLock
  ? Promise.resolve(true)
  : new Promise<boolean>((resolve) => {
      const deadline = Date.now() + UPDATE_RELAUNCH_LOCK_TIMEOUT_MS;
      traceUpdaterStartup("single-instance-lock-waiting");
      const retry = (): void => {
        if (app.requestSingleInstanceLock()) {
          traceUpdaterStartup("single-instance-lock-acquired-after-retry");
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          traceUpdaterStartup("single-instance-lock-retry-exhausted");
          resolve(false);
          return;
        }
        // Keep the bounded retry alive. An unref'ed timer can leave the
        // replacement suspended before app.whenReady() while the old native
        // process releases its lock, so reconciliation never starts.
        setTimeout(retry, UPDATE_RELAUNCH_LOCK_RETRY_MS);
      };
      setTimeout(retry, UPDATE_RELAUNCH_LOCK_RETRY_MS);
    });
if (initialSingleInstanceLock) traceUpdaterStartup("single-instance-lock-acquired");

/*
 * ── agentlas:// 딥링크 ────────────────────────────────────────────────────────
 * 허브(웹)의 "설치" 버튼이 여는 주소다: agentlas://plugin/<family>/<slug>.
 * 등록하지 않으면 OS 가 이 스킴을 아무 앱에도 넘기지 않아 버튼이 조용히 죽는다
 * (2026-08-20 감사: 허브 상세가 설치 안내문만 띄우던 이유).
 *
 * 이 스킴은 렌더러가 내부적으로도 쓰지만(agentlas://app/index.html), 그건
 * protocol.handle 이 앱 안에서 처리하는 것이고 여기 등록은 **OS → 앱** 전달용이라
 * 서로 간섭하지 않는다. 링크는 항해가 아니라 라우팅 신호로만 소비한다 —
 * 바깥에서 온 URL 로 창을 항해시키지 않는다.
 */
const PLUGIN_DEEP_LINK_RE = /^agentlas:\/\/plugin\/([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,79})\/?$/i;

function routeAgentlasDeepLink(rawUrl: string): void {
  const match = PLUGIN_DEEP_LINK_RE.exec(rawUrl.trim());
  if (!match) return; // 모르는 모양은 무시한다 — 바깥 입력이 임의 경로를 열 수 없다.
  const route = `/marketplace?install=${encodeURIComponent(match[2])}&family=${encodeURIComponent(match[1])}`;
  const deliver = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("menu:navigate", route);
  };
  if (mainWindow && !mainWindow.isDestroyed()) deliver();
  else void app.whenReady().then(() => setTimeout(deliver, 1_500));
}

function registerAgentlasProtocolClient(): void {
  try {
    // dev 실행은 electron 바이너리 + 스크립트 경로를 함께 등록해야 OS 가 되돌려준다.
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("agentlas", process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient("agentlas");
    }
  } catch {
    // 등록 실패는 앱 기동을 막지 않는다 — 딥링크만 동작하지 않는다.
  }
}

// macOS 는 전용 이벤트로 준다.
app.on("open-url", (event, url) => {
  event.preventDefault();
  routeAgentlasDeepLink(url);
});

app.on("second-instance", (_event, argv) => {
  // Windows/Linux 는 두 번째 인스턴스의 argv 에 URL 을 실어 보낸다.
  const link = argv.find((arg) => typeof arg === "string" && arg.startsWith("agentlas://"));
  if (link) routeAgentlasDeepLink(link);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function resolveRendererFile(url: string): string {
  const rendererRoot = path.resolve(__dirname, "../renderer");
  const parsed = new URL(url);
  const pathname = decodeURIComponent(parsed.pathname || "/");
  let routePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const segments = routePath.split("/");
  // CSS-relative asset URLs can arrive as
  // `_next/static/css/_next/static/media/...` under the custom scheme. Keep the
  // last `_next` root so fonts and other emitted assets resolve to the exported
  // static tree instead of the 404 document.
  const nextAssetIndex = segments.lastIndexOf("_next");
  const brandAssetIndex = segments.findIndex((segment) => segment === "brand");
  const staticAssetIndex = nextAssetIndex > 0 ? nextAssetIndex : brandAssetIndex;
  if (staticAssetIndex > 0) {
    routePath = segments.slice(staticAssetIndex).join("/");
  }

  const direct = path.resolve(rendererRoot, routePath);
  const candidates = [
    direct,
    path.extname(direct) ? direct : `${direct}.html`,
    path.extname(direct) ? direct : path.join(direct, "index.html"),
  ];

  const resolved = candidates.find((candidate) => {
    const relative = path.relative(rendererRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    try {
      // The packaged renderer lives in app.asar. Electron implements statSync
      // there by constructing a synthetic fs.Stats, which emits DEP0180 on
      // every launch. ASAR-backed Dirent values carry the file type without
      // that deprecated constructor; real development files behave the same.
      const parent = path.dirname(candidate);
      const basename = path.basename(candidate);
      return fs.readdirSync(parent, { withFileTypes: true })
        .some((entry) => entry.name === basename && entry.isFile());
    } catch {
      return false;
    }
  });

  if (resolved) return resolved;
  return path.join(rendererRoot, "404.html");
}

function registerRendererProtocol(): void {
  protocol.handle("agentlas", (request) => {
    // 로컬 이미지 인라인 서빙 — agentlas://localfile/?p=<encoded abs path>.
    // 채팅에 에이전트가 생성한 이미지를 띄우기 위함 (webSecurity로 file:// 직접 로드는 차단됨).
    // 안전: main-authoritative root + media type + final realpath. Direct
    // symlinks and ancestor symlink escapes are rejected by the shared policy.
    try {
      const url = new URL(request.url);
      if (url.hostname === "one-artifact") {
        return serveOneArtifactProtocolRequest(request.url, request.headers.get("range"));
      }
      if (url.hostname === "one-avatar") {
        const avatarPath = resolveOneTeamAvatarProtocolPath(request.url);
        if (!avatarPath) return new Response("not found", { status: 404 });
        return net.fetch(pathToFileURL(avatarPath).toString());
      }
      // 허브 플러그인 로고 — 원격에서 한 번 받아 디스크에 두고 그 뒤로는 로컬에서 답한다.
      // 카드가 매번 외부로 나가지 않고, 한 번 본 로고는 오프라인에서도 뜬다.
      if (url.hostname === "plugin-icon") {
        return servePluginIconRequest(request.url);
      }
      if (url.hostname === "chat-attachment") {
        const id = url.pathname.replace(/^\//, "");
        const attachment = readChatMessageAttachment(id);
        if (!attachment) return new Response("not found", { status: 404 });
        const body = Uint8Array.from(attachment.bytes);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": attachment.mediaType,
            "Content-Length": String(attachment.size),
            "Cache-Control": "private, max-age=31536000, immutable",
            "ETag": `\"sha256-${attachment.sha256}\"`,
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (url.hostname === "localfile") {
        const p = url.searchParams.get("p");
        if (p) {
          const approved = authorizeLocalMediaPath(p);
          if (approved) {
            // 비디오 재생을 위해 Range 요청을 전달(seek 지원); 이미지엔 무해.
            const range = request.headers.get("range");
            return net.fetch(pathToFileURL(approved).toString(), range ? { headers: { range } } : undefined);
          }
        }
        return new Response("not found", { status: 404 });
      }
    } catch {
      // fall through to renderer resolution
    }
    const filePath = resolveRendererFile(request.url);
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

async function loadMainRendererIntoWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const startUrl = process.env.ELECTRON_START_URL;
  if (isDev && startUrl) {
    await loadMainUrl(startUrl);
    // Keep normal local QA launches to one visible Agentlas window. Detached
    // DevTools are opt-in so restarting the renderer does not accumulate extra
    // Electron windows beside the product under test.
    if (process.env.AGENTLAS_OPEN_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    await loadMainUrl("agentlas://app/index.html");
  }
}

function navigationErrorDescription(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

async function loadMainUrl(target: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  lastStartupNavigationFailure = null;
  try {
    await mainWindow.loadURL(target);
  } catch (error) {
    const description = navigationErrorDescription(error);
    const kind = classifyStartupNavigationFailure({
      url: target,
      errorCode: description,
      errorDescription: description,
      isPackaged: app.isPackaged,
      devStartUrl: process.env.ELECTRON_START_URL,
    });
    lastStartupNavigationFailure = { kind, target };
    if (kind !== "unexpected") {
      // Expected transition failures are still observable, but belong to a
      // startup/dev channel rather than the production incident stream.
      console.info(`[startup][navigation:${kind}] renderer load did not complete`);
    }
    throw error;
  }
}

async function createWindow(options: { startupPlaceholder?: boolean } = {}): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "Agentlas",
    titleBarStyle: "hiddenInset", // macOS first — 윈도우 컨트롤은 좌상단에 흡수
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Renderer가 외부 https만 띄울 수 있게
      webSecurity: true,
    },
  });

  // The window is created hidden and revealed on first paint. When Agentlas
  // starts while the display is asleep — a login item, an update relaunch, a
  // machine that locked mid-install — no frame is ever painted, "ready-to-show"
  // never fires, and the app stays running with no window at all. Waking the
  // screen afterwards does not recover it because the one-shot event is gone.
  // So: reveal on first paint, on a finished load, and finally on a timeout.
  // show() is idempotent, and an early reveal is strictly better than a
  // headless app the user cannot reach.
  const revealMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    mainWindow.show();
  };
  mainWindow.once("ready-to-show", revealMainWindow);
  mainWindow.webContents.once("did-finish-load", revealMainWindow);
  const revealFallback = setTimeout(revealMainWindow, MAIN_WINDOW_REVEAL_FALLBACK_MS);
  mainWindow.once("closed", () => clearTimeout(revealFallback));

  // 우클릭 컨텍스트 메뉴 — 잘라내기/복사/붙여넣기/전체선택. Electron은 기본 제공하지 않아
  // 입력창에서 우클릭 복붙이 안 되던 문제를 해결한다(키보드 단축키는 앱 메뉴 role로 이미 동작).
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const { editFlags, isEditable, selectionText } = params;
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (isEditable) {
      items.push(
        { role: "undo", enabled: editFlags.canUndo },
        { role: "redo", enabled: editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: editFlags.canCut },
        { role: "copy", enabled: editFlags.canCopy },
        { role: "paste", enabled: editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else if (selectionText && selectionText.trim().length > 0) {
      items.push({ role: "copy", enabled: editFlags.canCopy }, { type: "separator" }, { role: "selectAll" });
    }
    if (items.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
      Menu.buildFromTemplate(items).popup({ window: mainWindow });
    }
  });

  // 외부 링크는 기본 브라우저로 — 데스크톱 안에서 임의 URL 열지 않는다 (PRD 6.2)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  const startUrl = process.env.ELECTRON_START_URL;

  // [보안] top-level navigation 가드 — 앱 내부(prod=agentlas://, dev=dev 서버)만 허용. 그 외 항해는
  // 차단하고 외부 http(s)는 기본 브라우저로. SPA 클라이언트 라우팅(pushState)은 will-navigate를 안 띄운다.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed =
      url.startsWith("agentlas://")
      || url === STARTUP_PLACEHOLDER_URL
      || (isDev && startUrl ? url.startsWith(startUrl) : false);
    if (allowed) return;
    event.preventDefault();
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const kind = classifyStartupNavigationFailure({
      url: validatedURL || mainWindow?.webContents.getURL() || "",
      errorCode,
      errorDescription,
      isPackaged: app.isPackaged,
      devStartUrl: process.env.ELECTRON_START_URL,
    });
    if (kind !== "unexpected") return;
    console.error(`[main][renderer-navigation] code=${errorCode} description=${errorDescription} url=${validatedURL || "unknown"}`);
  });

  // [회복] 렌더러 크래시(OOM 등) 시 자동 reload — 60초 롤링 윈도우에서 최대 3회로 reload→crash 루프 차단.
  const rendererReloadTimes: number[] = [];
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    const now = Date.now();
    while (rendererReloadTimes.length && now - rendererReloadTimes[0] > 60_000) rendererReloadTimes.shift();
    if (rendererReloadTimes.length >= 3) {
      console.error("[main] renderer crash budget exhausted, not reloading:", details.reason);
      return;
    }
    rendererReloadTimes.push(now);
    // null만이 아니라 destroyed 윈도우도 가드 — 닫기와 비-clean teardown이 겹쳐도 예외 없음.
    if (mainWindow && !mainWindow.isDestroyed()) {
      console.error("[main] renderer process gone, reloading:", details.reason);
      mainWindow.webContents.reload();
    }
  });

  if (options.startupPlaceholder) await loadMainUrl(STARTUP_PLACEHOLDER_URL);
  else await loadMainRendererIntoWindow();
}

app.on("window-all-closed", () => {
  // macOS first — 마지막 윈도우가 닫혀도 dock에 남아있는 게 표준
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!shellReadyForWindows) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  // A hidden main window (or an unrelated auxiliary window) still makes
  // getAllWindows() non-empty. Dock activation must restore the product window
  // itself, not merely prove that some BrowserWindow object exists.
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// 앱 종료 정리 — 백그라운드 타이머/자식 프로세스를 누수 없이 거둔다.
// 자동 업데이트는 renderer 창이 모두 닫힌 will-quit에서만 연기하므로, continuity
// 캡처 뒤 renderer IPC write가 새로 들어올 수 없다.
let quitCleanupDone = false;
let quitCleanupPromise: Promise<void> | null = null;
let quitServicesStopPromise: Promise<void> | null = null;
let systemShutdownInProgress = false;
let systemShutdownResetTimer: NodeJS.Timeout | null = null;
let daemonMobileBridgeClaimed = false;
let browserOrphanSweepTimer: NodeJS.Timeout | null = null;
let browserOrphanSweepRunning = false;

function startBrowserOrphanSweep(): void {
  if (browserOrphanSweepTimer) return;
  browserOrphanSweepTimer = setInterval(() => {
    if (browserOrphanSweepRunning || quitCleanupPromise) return;
    browserOrphanSweepRunning = true;
    void sweepAgentlasBrowserOrphans()
      .then((result) => {
        if (result.action === "cleaned") {
          console.warn("[agentlas-browser] cleaned lease-less automation browser", result);
        }
      })
      .catch((error) => console.error("[agentlas-browser] orphan sweep failed", error))
      .finally(() => { browserOrphanSweepRunning = false; });
  }, 30_000);
  browserOrphanSweepTimer.unref?.();
}

function stopBrowserOrphanSweep(): void {
  if (browserOrphanSweepTimer) clearInterval(browserOrphanSweepTimer);
  browserOrphanSweepTimer = null;
}

async function stopDesktopOwnedMobileBridge(): Promise<void> {
  try {
    await stopAgentlasMobileBridge();
  } catch (error) {
    console.error("[mobile-bridge] shutdown failed", error);
  } finally {
    daemonMobileBridgeClaimed = false;
  }
}

function stopQuitServices(): Promise<void> {
  if (quitServicesStopPromise) return quitServicesStopPromise;
  shellReadyForWindows = false;
  try { stopAutomationScheduler(); } catch {}
  try { stopOneBriefingScheduler(); } catch {}
  try { stopBrowserOrphanSweep(); } catch {}
  try { stopBrowserApprovalServer(); } catch {}
  try { stopMcpProxyApprovalServer(); } catch {}
  try { stopComputerUseControlServer(); } catch {}
  try { disposeAppFactoryLaunches(); } catch {}
  try { disposeAppFactoryLivePreviews(); } catch {}
  try { disposeSiteAgentAppRuntimes(); } catch {}
  try { disposeAuthSessionInvalidation?.(); } catch {}
  disposeAuthSessionInvalidation = null;
  try { disposeAuthSessionRestoration?.(); } catch {}
  disposeAuthSessionRestoration = null;
  try { disposeMobileBridgeStateChange?.(); } catch {}
  disposeMobileBridgeStateChange = null;

  quitServicesStopPromise = Promise.all([
    import("./triggers/manager").then((module) => { module.stopTriggerManager(); }).catch(() => {}),
    import("./telegram/connect").then((module) => { module.stopTelegramWorkers(); }).catch(() => {}),
    import("./agents/hephaestus-sync").then((module) => { module.stopHephaestusSync(); }).catch(() => {}),
    stopDesktopOwnedMobileBridge(),
    import("./daemon/app-launcher")
      .then((module) => module.shutdownDaemon(userDataDir(), process.pid))
      .then((result) => {
        if (!result.stopped) console.error(`[daemon] helper pid ${result.pid ?? "?"} did not stop`);
      })
      .catch((error) => console.error("[daemon] helper shutdown failed", error)),
  ]).then(() => undefined);
  return quitServicesStopPromise;
}

async function prepareAutomaticUpdateQuit(): Promise<void> {
  // The native updater must not capture its install journal while Science can
  // still accept or persist work. This is a no-op for users who never opened
  // Science because the runtime has no active store in that case.
  const scienceShutdown = await shutdownScienceRuntimeForAppClose();
  if (scienceShutdown.timedOut) {
    throw new Error("science-runtime-update-shutdown-timed-out");
  }
  const report = await shutdownAppRuntimeCoordinator(15_000);
  if (report.failedParticipantNames.length > 0) {
    throw new Error(`App runtime shutdown failed: ${report.failedParticipantNames.join(", ")}`);
  }
  if (report.timedOut) {
    throw new Error(`App runtime did not settle: ${report.unsettledParticipantNames.join(", ")}`);
  }
  await stopQuitServices();
}

function finishQuitCleanup(): Promise<void> {
  if (quitCleanupPromise) return quitCleanupPromise;
  quitCleanupPromise = (async () => {
    try {
      const report = await shutdownAppRuntimeCoordinator(15_000);
      if (report.pausedRunIds.length > 0) {
        console.info(`[long-run] paused ${report.pausedRunIds.length} local run(s) for app close`);
      }
      if (report.timedOut) {
        console.error("[long-run] app runtime shutdown timed out", report.unsettledParticipantNames);
      }
      if (report.failedParticipantNames.length > 0) {
        console.error("[long-run] app runtime participant shutdown failed", {
          participants: report.failedParticipantNames,
          errorCodes: report.participantErrorCodes,
        });
      }
    } catch (error) {
      console.error("[long-run] app runtime shutdown failed", error);
    }
    try {
      const scienceShutdown = await shutdownScienceRuntimeForAppClose();
      if (scienceShutdown.pausedLoops || scienceShutdown.interruptedTurns || scienceShutdown.cancellationRequests
        || scienceShutdown.interruptedToolRequests || scienceShutdown.timedOut) {
        console.info(`[science-runtime] app-close pausedLoops=${scienceShutdown.pausedLoops} interruptedTurns=${scienceShutdown.interruptedTurns} cancellationRequests=${scienceShutdown.cancellationRequests} interruptedTools=${scienceShutdown.interruptedToolRequests} timedOut=${scienceShutdown.timedOut}`);
      }
    } catch (error) {
      console.error("[science-runtime] app-close shutdown failed", error);
    }
    // ★호스트 공통 정리 — 실행 중인 CLI 자식 트리 킬이 여기 등록돼 있다.
    //   데몬(agentlasd)은 같은 함수를 SIGTERM/SIGINT 에서 부른다(host-lifecycle.ts).
    try { runHostShutdownHooks(); } catch {}
    try { stopCliRuntimeAutoUpdate(); } catch {}
    await stopQuitServices().catch(() => {});
    await withBrowserCdpMaintenance(() => undefined).catch((error) => {
      console.error("[agentlas-browser] quit cleanup failed", error);
    });
    // Child termination resolves through the invocation lifecycle. Do not
    // close SQLite underneath a terminal receipt that is still settling.
    const settleDeadline = Date.now() + 15_000;
    while (invocationService.activeChatIds().length > 0 && Date.now() < settleDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    try { closeScienceStore(); } catch (error) { console.error("[science-store] close failed", error); }
    try { closeStore(); } catch (error) { console.error("[store] close failed", error); }
    try { disposeAutoUpdater(); } catch {}
    quitCleanupDone = true;
  })();
  return quitCleanupPromise;
}

const automaticQuitInstaller = createAutomaticQuitInstaller({
  getState: getUpdaterState,
  prepare: prepareAutomaticUpdateQuit,
  install: installDownloadedUpdate,
  relaunch: () => app.relaunch(),
  quit: () => app.quit(),
  subscribe: onUpdaterStateChange,
  shouldInstallOnQuit: () => !systemShutdownInProgress && invocationService.activeChatIds().length === 0,
  logger: console,
});
electronAutoUpdater.on("before-quit-for-update", () => {
  automaticQuitInstaller.authorizeNativeQuit();
  // The replacement can be launched by NSIS/AppImageUpdater before this
  // process has fully exited. Hand over the lock only after the native updater
  // has committed to quitting, so the replacement can enter startup and clear
  // the durable journal instead of waiting behind a dying process.
  if (!allowMultiInstance && app.hasSingleInstanceLock()) app.releaseSingleInstanceLock();
});
app.on("will-quit", (event) => {
  // electron-updater's raw auto-install-on-quit path is intentionally disabled:
  // it cannot capture Agentlas continuity first. Defer this first quit, run the
  // controller's full verified transaction, then allow the native updater's
  // second quit through after state advances to `installing`.
  if (automaticQuitInstaller.handle(event)) return;
  if (quitCleanupDone) return;
  event.preventDefault();
  void finishQuitCleanup().finally(() => app.quit());
});

let startupStage = "before-ready";

app.whenReady().then(async () => {
  // Native installers can launch the replacement before the old process has
  // released Electron's single-instance lock. Do not run migrations, updater
  // reconciliation, or window startup until the replacement owns that lock.
  // A failed handoff exits explicitly after the bounded retry instead of
  // leaving a live target PID with an install journal that can never clear.
  if (!await singleInstanceLockPromise) {
    console.error("[agentlas] packaged update relaunch could not acquire the single-instance lock");
    app.exit(0);
    return;
  }
  if (!initialSingleInstanceLock) traceUpdaterStartup("single-instance-lock-ready");
  traceUpdaterStartup("ready-callback-entered");
  // Before any other stage: a packaged app discards console output, so start
  // mirroring it to the platform log directory first. Updater and mobile-bridge
  // diagnostics are worthless if the only copy dies with the process.
  initFileLogging();
  traceUpdaterStartup("file-logging-initialized");
  const startupStartedAt = Date.now();
  const traceStartup = (stage: string): void => {
    console.info(`[startup] ${stage} +${Date.now() - startupStartedAt}ms`);
  };
  // 4-tier model catalog (PRD 2026-08-15 D-4): wire the context-window resolver
  // so BYOK compaction stops assuming 128k, and refresh models.dev in the
  // background (TTL 24h; failure keeps the stale copy, never blocks startup).
  try {
    installModelCatalogResolver();
    void refreshRemoteCatalog().then((r) => {
      if (r.status !== "fresh") console.info(`[model-catalog] remote ${r.status} (${r.rows} rows)${r.reason ? `: ${r.reason}` : ""}`);
    });
  } catch (err) {
    console.warn("[model-catalog] resolver not installed:", err instanceof Error ? err.message : String(err));
  }
  if (app.isPackaged && process.platform === "darwin" && installIdentity.channel === "official") {
    try {
      const bundlePath = resolveMacAppBundle(process.execPath);
      if (!bundlePath) throw new Error("Official macOS application bundle could not be resolved");
      const sealed = await prepareMacRuntimeResourcesForExecution({
        bundlePath,
        resourcesPath: process.resourcesPath,
        policyPath: path.join(process.resourcesPath, "macos-release-signing-policy.json"),
      });
      console.info(
        `[runtime-seal] packaged Python/runtime resources ready `
          + `(${sealed.directories} directories, ${sealed.files} files, `
          + `${sealed.alreadySealed ? "already sealed" : `${sealed.changedEntries} sealed`}, `
          + `${sealed.repairedGeneratedCaches ? "generated caches repaired" : "clean seal"})`,
      );
    } catch (error) {
      console.error(
        "[runtime-seal] official packaged runtime boundary failed; refusing to start",
        error instanceof Error ? error.message : "unknown error",
      );
      app.exit(78);
      return;
    }
  }
  if (process.platform !== "win32") {
    powerMonitor.on("shutdown", () => {
      // Never turn an operating-system shutdown into an application relaunch.
      systemShutdownInProgress = true;
      if (systemShutdownResetTimer) clearTimeout(systemShutdownResetTimer);
      // macOS can cancel shutdown because another app refuses it. If Agentlas
      // remains alive, do not permanently disable later normal-quit installs.
      systemShutdownResetTimer = setTimeout(() => {
        systemShutdownInProgress = false;
        systemShutdownResetTimer = null;
      }, 120_000);
      systemShutdownResetTimer.unref();
    });
  }
  // Stage 1 (pre-mutation): a pending install must already have a valid,
  // contained SQLite/agent/route recovery set before initStore can migrate.
  const updatePreflight = installIdentity.updatesEnabled
    ? preflightUpdaterStartup()
    : { pendingInstall: false, recoveryBackupAvailable: false };
  traceUpdaterStartup(`updater-preflight-complete:${updatePreflight.pendingInstall ? "pending" : "clean"}`);
  if (!installIdentity.updatesEnabled) {
    console.info(`[updater] ${installIdentity.channel} install identity has no update feed`);
  }
  // This file is derived runtime material, never recovery authority. Remove
  // legacy credential copies before either GUI or headless pending-install exits.
  try {
    if (scrubLegacyOpenCrabMcpConfig()) {
      console.warn("[opencrab] removed a legacy generated MCP config containing a credential URL");
    }
  } catch {
    console.error("[opencrab] legacy generated MCP config scrub failed");
  }
  // Older releases could be launched by a persisted LaunchAgent. Local work is
  // now app-scoped, so this legacy entry may clean up the launcher but may not
  // open the store, claim work, or execute an automation.
  // ── 그래프 표면(커넥터 C47·C48) ───────────────────────────────
  // 코드(SDK)와 다른 에이전트(MCP)가 그래프를 부르는 입구. **stdio 전용**이라
  // 이 프로세스를 직접 띄운 쪽에만 닿고, 네트워크에서 도달할 방법이 없다.
  // 창을 만들지 않고, 스케줄러도 켜지 않는다 — 요청을 대기열에 적을 뿐이다.
  if (process.argv.includes("--graph-surface")) {
    try {
      initStore();
      const { serveGraphSurfaceOverStdio } = await import("./graph-surface/server");
      serveGraphSurfaceOverStdio();
    } catch (err) {
      console.error("[graph-surface] failed:", err);
      app.quit();
    }
    return;
  }

  if (process.argv.includes("--headless-automations")) {
    try {
      const { disableLaunchd } = await import("./launchd/agent");
      const status = disableLaunchd();
      if (status.error) console.error("[headless-automations] legacy launcher cleanup failed:", status.error);
    } catch (err) {
      console.error("[headless-automations] legacy launcher cleanup failed:", err);
    } finally {
      app.quit();
    }
    return;
  }

  registerRendererProtocol();
  // OS 에 agentlas:// 를 이 앱으로 등록한다(허브 웹의 설치 버튼이 여는 스킴).
  registerAgentlasProtocolClient();
  // 앱이 딥링크로 **처음** 켜진 경우(Windows/Linux 는 첫 argv 에 실려 온다).
  {
    const initialLink = process.argv.find((arg) => typeof arg === "string" && arg.startsWith("agentlas://plugin/"));
    if (initialLink) routeAgentlasDeepLink(initialLink);
  }
  // [보안] 권한 deny — 우리 렌더러가 실제로 쓰는 건 clipboard(복사 버튼)뿐. device/sensor 류
  // (geolocation/media/usb/serial/hid/midi/display-capture 등)는 main-side에서 거부하고,
  // clipboard·notifications 등 무해한 권한은 허용한다(부작용 없이 공격면만 닫음).
  const DENIED_PERMISSIONS = new Set([
    "geolocation", "media", "midi", "midiSysex", "hid", "serial", "usb",
    "idle-detection", "speaker-selection", "display-capture", "window-management",
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => !DENIED_PERMISSIONS.has(permission));
  applyDockIcon();
  // safeStorage can wait inside the native Keychain implementation before a
  // JavaScript timeout gets a chance to run. Put a real, read-only window on
  // screen first so a locked or slow Keychain never makes Agentlas look dead.
  // The application renderer and IPC surface still load only after migration,
  // continuity, authentication, and bootstrap gates have completed.
  await createWindow({ startupPlaceholder: true });
  traceUpdaterStartup("startup-window-visible");
  traceStartup("startup-window-visible");
  startupStage = "store-opening";
  initStore({ deferPostContinuityRepairs: updatePreflight.pendingInstall });
  try {
    const scrubbed = scrubLegacyRunEventSecrets();
    if (scrubbed > 0) console.warn(`[security] scrubbed ${scrubbed} legacy run-event payload(s)`);
  } catch (error) {
    console.error("[security] legacy run-event scrub failed:", error);
  }
  const longRunStartup = initializeAppRuntimeCoordinator();
  invocationService.openAppAdmission();
  openLongRunVerifierAdmission();
  registerAppRuntimeParticipant("invocation-service", {
    closeAdmission: () => { invocationService.beginAppShutdown(); },
    interrupt: () => { invocationService.beginAppShutdown(); },
    isSettled: () => invocationService.activeRunIds().length === 0,
  });
  registerAppRuntimeParticipant("long-run-verifier", {
    closeAdmission: closeLongRunVerifierAdmission,
    interrupt: interruptLongRunVerifiers,
    isSettled: longRunVerifiersSettled,
  });
  if (longRunStartup.recoveredRunIds.length > 0) {
    console.warn(
      `[long-run] recovered ${longRunStartup.recoveredRunIds.length} interrupted local run(s) as paused; manual resume required`,
    );
  }
  traceUpdaterStartup("store-ready");
  repairPlaceholderTaskTitles();
  /*
   * ★부팅 시점의 running Task는 전부 고아다 — 실행 권위인 activeRuns 맵이 방금 비어서
   * 시작했다. 정산하지 않으면 화면이 영원히 "진행 중"을 말한다(실측: 나흘째 running).
   * 조용히 completed로 덮지 않고 failed로 적어, 이어서 할지 다시 할지는 사용자가 정한다.
   */
  try {
    const interrupted = settleInterruptedTasksOnBoot();
    if (interrupted.settled > 0) {
      console.log("[tasks] settled interrupted runs on boot", { count: interrupted.settled });
      for (const taskId of interrupted.taskIds) {
        tryRecordRunEvent({
          runId: `boot-settle:${taskId}`,
          kind: "invoke_failed",
          payload: { errorCode: "host-restarted-mid-run", taskId },
        });
      }
    }
  } catch (error) {
    console.error("[tasks] boot settlement failed:", error);
  }
  startupStage = "store-ready";
  traceStartup("store-ready");
  // A native update target must reconcile its durable install journal before
  // optional keychain/session restoration. On a locked or headless machine
  // that restoration can be slow, while the update handoff is already
  // complete and is waiting only for this cleanup. Ordinary launches keep
  // the existing ordering and still restore auth before updater checks.
  if (installIdentity.updatesEnabled && isPackagedUpdateRelaunch) {
    traceUpdaterStartup("early-updater-reconcile-started");
    await initAutoUpdater();
    traceUpdaterStartup("early-updater-reconcile-complete");
  }
  try {
    reconcileOneHubDerivativeDraftStorage();
  } catch (error) {
    // Corrupt state or unsafe ancestry stays untouched and disables this
    // review-only path; application startup must not overwrite or delete it.
    console.error("[one-hub-derivative] startup reconciliation blocked:", error);
  }
  // Restore/decrypt the account before the post-migration continuity check.
  const initialAuthRestore = await bootAuthFromKeychain();
  traceUpdaterStartup(`auth-restore-complete:${initialAuthRestore.status}`);
  traceStartup(`auth-${initialAuthRestore.status}`);
  const initialAuthRestoreWasTemporary = initialAuthRestore.status === "temporarily-unavailable";
  const initialAuthRestoreWasUnavailable = initialAuthRestoreWasTemporary || initialAuthRestore.status === "native-unavailable";
  // Stage 2 (post-migration, pre-bootstrap-writers): compare the live DB and
  // managed assets against the recovery copies before deferred repairs resume.
  if (installIdentity.updatesEnabled) {
    traceUpdaterStartup("updater-init-started");
    await initAutoUpdater({
      initialAuthRestore,
      onDeferredAuthRestore: scheduleDeferredAuthRestore,
    });
    traceUpdaterStartup("updater-init-complete");
  } else if (initialAuthRestoreWasTemporary) {
    scheduleDeferredAuthRestore();
  }
  if (updatePreflight.pendingInstall) {
    // The update transaction now owns the startup boundary. Only after the
    // pre-update snapshot has passed continuity verification may ordinary boot
    // repair projections mutate protected local rows.
    runPostContinuityStoreRepairs();
  }
  {
    try {
      const openCrabScrub = scrubLegacyOpenCrabCredentialUrls();
      if (openCrabScrub.scrubbed > 0) {
        console.warn(`[opencrab] disabled and scrubbed ${openCrabScrub.scrubbed} legacy credential URL row(s)`);
      }
    } catch {
      console.error("[opencrab] live database credential URL scrub failed");
    }
    try {
      // initAutoUpdater has either completed continuity verification and cleared
      // its journal, or the helper below will observe the remaining journal and
      // leave every recovery copy untouched. Never run this from the headless
      // path, which deliberately does not own post-update verification.
      const recoveryScrub = scrubInactiveUpdaterRecoveryOpenCrabCredentialUrls({
        userDataPath: userDataDir(),
      });
      if (recoveryScrub.scrubbedDatabases > 0) {
        console.warn(
          `[opencrab] scrubbed ${recoveryScrub.scrubbedRows} legacy credential URL row(s) from ${recoveryScrub.scrubbedDatabases} inactive updater recovery database(s)`,
        );
      }
      if (recoveryScrub.skippedUnsafe > 0) {
        console.error("[opencrab] one or more inactive updater recovery databases could not be scrubbed safely");
      }
    } catch {
      console.error("[opencrab] inactive updater recovery credential URL scrub failed");
    }
  }
  registerIpcHandlers();
  // DESKTOP_MOBILE_BRIDGE: Desktop main is the sole authority. Renderer IPC
  // can issue/revoke pairing, but never receives a persisted bearer token.
  ipcMain.handle("mobileBridge:status", () => mobileBridgeRuntimeStatus());
  ipcMain.handle("mobileBridge:issuePairing", () => issueMobileBridgePairing());
  ipcMain.handle("mobileBridge:listDevices", () => listMobileBridgeDevices());
  ipcMain.handle("mobileBridge:retry", () => retryAgentlasMobileBridge());
  ipcMain.handle("mobileBridge:revokeDevice", (_event, deviceId: unknown) => {
    if (typeof deviceId !== "string" || !/^device_[a-f0-9]{32}$/.test(deviceId)) {
      return { ok: false };
    }
    return revokeMobileBridgeDevice(deviceId);
  });
  // Reveals the main-process log. Renderer never receives log contents, only a
  // request to open the file manager at a main-owned path.
  ipcMain.handle("mobileBridge:revealLog", () => {
    const file = mainLogFilePath();
    if (!file || !fs.existsSync(file)) return { ok: false };
    shell.showItemInFolder(file);
    return { ok: true };
  });
  const broadcastScienceExtension = () => {
    const status = scienceExtensionStatus();
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("productExtensions:changed", status);
      } catch (error) {
        console.warn("[science-extension] status broadcast failed", error);
      }
    }
    return status;
  };
  const refreshScienceExtensionViews = (changed: boolean) => {
    if (changed) {
      try { closeAllScienceExtensionViews(); }
      catch (error) { console.warn("[science-extension] closing stale views failed", error); }
    }
    try { broadcastScienceExtension(); }
    catch (error) { console.warn("[science-extension] status refresh failed", error); }
  };
  ipcMain.handle("productExtensions:scienceStatus", () => scienceExtensionStatus());
  ipcMain.handle("productExtensions:scienceSuiteStatus", () => scienceSuiteStatus());
  ipcMain.handle("productExtensions:installScience", async () => {
    try {
      const receipt = await installScienceExtension();
      refreshScienceExtensionViews(receipt.ok && receipt.action !== "unchanged");
      return receipt;
    } catch (error) {
      refreshScienceExtensionViews(false);
      console.error("[science-extension] install failed outside the receipt boundary", error);
      return {
        ok: false,
        id: "agentlas-science",
        action: "failed",
        version: null,
        code: "science-extension-install-unexpected",
        message: "Agentlas Science could not be installed.",
      };
    }
  });
  ipcMain.handle("productExtensions:installScienceSuite", async (event) => {
    try {
      const receipt = await installScienceSuite((progress) => {
        if (event.sender.isDestroyed()) return;
        try { event.sender.send("productExtensions:scienceSuiteProgress", progress); }
        catch (error) { console.warn("[science-extension] progress delivery failed", error); }
      });
      refreshScienceExtensionViews(receipt.ok && receipt.action !== "unchanged");
      return receipt;
    } catch (error) {
      refreshScienceExtensionViews(false);
      console.error("[science-extension] suite install failed outside the receipt boundary", error);
      return {
        ok: false,
        id: "agentlas-science-suite",
        action: "failed",
        components: [],
        code: "science-suite-install-unexpected",
        message: "The Agentlas Science suite could not be installed.",
      };
    }
  });
  ipcMain.handle("productExtensions:setScienceEnabled", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") return scienceExtensionStatus();
    if (!enabled) closeAllScienceExtensionViews();
    const status = setScienceExtensionEnabled(enabled);
    broadcastScienceExtension();
    return status;
  });
  ipcMain.handle("productExtensions:uninstallScience", () => {
    closeAllScienceExtensionViews();
    const receipt = uninstallScienceExtension();
    broadcastScienceExtension();
    return receipt;
  });
  const scienceViewLeaseId = (value: unknown): string => {
    if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{16,128}$/.test(value)) throw new Error("science-view-lease-invalid");
    return value;
  };
  ipcMain.handle("productExtensions:openScienceView", async (event, bounds, rawLeaseId) => {
    const leaseId = scienceViewLeaseId(rawLeaseId);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return { id: "agentlas-science", leaseId, state: "error", errorCode: "owner-window-missing", errorMessage: "The Desktop window is unavailable." };
    retryFailedScienceServiceLoad();
    return openScienceExtensionView({
      ownerId: event.sender.id,
      leaseId,
      window,
      bounds,
      send: (status) => {
        if (!event.sender.isDestroyed()) event.sender.send("productExtensions:viewStatus", status);
      },
    });
  });
  ipcMain.handle("productExtensions:setScienceViewBounds", (event, bounds, rawLeaseId) => setScienceExtensionViewBounds(event.sender.id, scienceViewLeaseId(rawLeaseId), bounds));
  ipcMain.handle("productExtensions:closeScienceView", (event, rawLeaseId) => closeScienceExtensionView(event.sender.id, scienceViewLeaseId(rawLeaseId)));
  const assertScienceSender = (event: Electron.IpcMainInvokeEvent, input: unknown, permission: ProductExtensionPermission = "science:projects") => {
    const extensionId = input && typeof input === "object" && "extensionId" in input ? String((input as { extensionId?: unknown }).extensionId ?? "") : "";
    if (extensionId !== "agentlas-science" || !isScienceExtensionViewSender(event.sender.id)) throw new Error("science-extension-sender-not-authorized");
    const status = scienceExtensionStatus();
    if (status.phase !== "installed") throw new Error("science-extension-not-active");
    if (permission === "science:agent-runtime" && event.senderFrame !== event.sender.mainFrame) throw new Error("science-extension-subframe-denied");
    assertScienceExtensionViewPermission(event.sender.id, permission);
    return status;
  };
  ipcMain.handle("science:askUser:list", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    return listPendingAskUserRequests().filter((request) => request.askedBy === "agentlas-science");
  });
  ipcMain.handle("science:askUser:answer", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" ? envelope as { requestId?: unknown; answer?: unknown } : {};
    const requestId = typeof input.requestId === "string" ? input.requestId : "";
    const pending = listPendingAskUserRequests().find((request) => request.requestId === requestId && request.askedBy === "agentlas-science");
    if (!pending) return false;
    return submitAskUserAnswer(requestId, typeof input.answer === "string" ? input.answer : null);
  });
  const scienceTurnSubscribers = new Map<number, { projectId: string; conversationId: string }>();
  const scienceLifecycleSubscribers = new Map<number, string>();
  let scienceLifecycleProjectionStarted = false;
  const ensureScienceLifecycleProjection = () => {
    if (scienceLifecycleProjectionStarted) return;
    scienceStore().onResearchLifecycleChanged((change) => {
      for (const [senderId, projectId] of scienceLifecycleSubscribers) {
        if (projectId !== change.projectId) continue;
        const sender = webContents.fromId(senderId);
        if (!sender || sender.isDestroyed()) {
          scienceLifecycleSubscribers.delete(senderId);
          continue;
        }
        sender.send("science:researchLifecycleChanged", change);
      }
    });
    scienceLifecycleProjectionStarted = true;
  };
  ipcMain.handle("science:shell:backToWork", (event, input: unknown) => {
    assertScienceSender(event, input);
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) throw new Error("science-owner-window-missing");
    mainWindow.webContents.send("menu:navigate", "/dashboard");
    mainWindow.show();
    mainWindow.focus();
    return { ok: true, route: "/dashboard" };
  });
  let scienceTurnProjectionStarted = false;
  const ensureScienceTurnProjection = () => {
    if (scienceTurnProjectionStarted) return;
    ensureScienceLifecycleProjection();
    scienceConversationService().onEvent((turnEvent) => {
      for (const [senderId, subscription] of scienceTurnSubscribers) {
        if (subscription.projectId !== turnEvent.projectId || subscription.conversationId !== turnEvent.conversationId) continue;
        if (!sendScienceTurnEventToView(senderId, turnEvent)) scienceTurnSubscribers.delete(senderId);
      }
    });
    scienceTurnProjectionStarted = true;
  };
  ipcMain.handle("science:bootstrap", (event, input: unknown) => {
    const status = assertScienceSender(event, input);
    ensureScienceLifecycleProjection();
    return {
      extensionId: status.id,
      extensionVersion: status.version ?? "0.0.0",
      schemaVersion: scienceSchemaVersion(),
      locale: currentUiLocale(),
      projects: scienceStore().listProjects(),
      rendererPacks: scienceRendererPackStatuses(),
    };
  });
  ipcMain.handle("science:rendererPacks:list", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    return scienceRendererPackStatuses();
  });
  ipcMain.handle("science:projects:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    return scienceStore().listProjects();
  });
  ipcMain.handle("science:projects:library", (event, input: unknown) => {
    assertScienceSender(event, input);
    return scienceStore().listProjectLibrarySummaries();
  });
  const scienceProjectFolders = new ScienceProjectFolderSelections();
  const scienceFolderPickers = new Set<number>();
  const scienceFolderDocuments = new Map<number, number>();
  const trackScienceFolderDocument = (sender: Electron.WebContents) => {
    if (scienceFolderDocuments.has(sender.id)) return;
    scienceFolderDocuments.set(sender.id, 0);
    sender.once("destroyed", () => { scienceProjectFolders.clear(sender.id); scienceFolderDocuments.delete(sender.id); });
    sender.on("did-start-navigation", (_navigationEvent, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        scienceProjectFolders.clear(sender.id);
        scienceFolderDocuments.set(sender.id, (scienceFolderDocuments.get(sender.id) ?? 0) + 1);
      }
    });
  };
  const assertScienceProjectDocument = (event: Electron.IpcMainInvokeEvent, envelope: unknown): string => {
    assertScienceSender(event, envelope);
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error("science-extension-subframe-denied");
    const release = activeScienceExtension();
    const actualUrl = new URL(event.senderFrame.url);
    actualUrl.hash = "";
    if (!release || actualUrl.href !== pathToFileURL(release.entryPath).href) throw new Error("science-project-folder-origin-denied");
    trackScienceFolderDocument(event.sender);
    return `${event.senderFrame.processId}:${event.senderFrame.routingId}:${scienceFolderDocuments.get(event.sender.id)}:${actualUrl.href}`;
  };
  ipcMain.handle("science:projects:pickFolder", async (event, envelope: unknown) => {
    const documentId = assertScienceProjectDocument(event, envelope);
    const senderId = event.sender.id;
    if (scienceFolderPickers.has(senderId)) throw new Error("science-project-folder-picker-busy");
    scienceFolderPickers.add(senderId);
    try {
      // Read activation in an isolated world without manufacturing a user gesture.
      const active = await event.sender.executeJavaScriptInIsolatedWorld(1007, [{ code: "navigator.userActivation.isActive === true" }]);
      if (active !== true) throw new Error("science-project-folder-user-gesture-required");
      if (assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-folder-document-changed");
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
      if (!owner || owner.isDestroyed()) throw new Error("science-owner-window-missing");
      const selected = await dialog.showOpenDialog(owner, { title: "Choose project folder", properties: ["openDirectory"] });
      if (assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-folder-document-changed");
      if (selected.canceled) return { canceled: true };
      if (selected.filePaths.length !== 1) throw new Error("science-project-folder-selection-invalid");
      return { canceled: false, ...scienceProjectFolders.select(senderId, documentId, selected.filePaths[0]) };
    } finally {
      scienceFolderPickers.delete(senderId);
    }
  });
  ipcMain.handle("science:projects:create", (event, envelope: unknown) => {
    const documentId = assertScienceProjectDocument(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-project-input-invalid");
    if ("folderPath" in input) throw new Error("science-project-folder-raw-path-forbidden");
    const request = input as CreateScienceProjectInput;
    const selectedPath = request.folderSelectionId === undefined ? undefined
      : scienceProjectFolders.resolve(request.folderSelectionId, event.sender.id, documentId, request.requestId);
    const result = scienceStore().createProject(request, selectedPath);
    if (request.folderSelectionId) scienceProjectFolders.commit(request.folderSelectionId, request.requestId);
    return result;
  });
  ipcMain.handle("science:projects:openFolder", async (event, envelope: unknown) => {
    const documentId = assertScienceProjectDocument(event, envelope);
    const active = await event.sender.executeJavaScriptInIsolatedWorld(1007, [{ code: "navigator.userActivation.isActive === true" }]);
    if (active !== true) throw new Error("science-project-folder-user-gesture-required");
    if (assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-folder-document-changed");
    const projectId = envelope && typeof envelope === "object" && "projectId" in envelope
      ? (envelope as { projectId?: unknown }).projectId : null;
    if (typeof projectId !== "string") throw new Error("science-project-id-invalid");
    const project = scienceStore().getProject(projectId);
    if (!project) throw new Error("science-project-not-found");
    if (!project.folderPath) throw new Error("science-project-folder-not-selected");
    const canonical = validateScienceProjectFolderPath(project.folderPath);
    if (canonical !== project.folderPath) throw new Error("science-project-folder-selection-changed");
    const error = await shell.openPath(canonical);
    if (error) throw new Error("science-project-folder-open-failed");
    return { opened: true };
  });
  ipcMain.handle("science:projects:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().getProject(projectId);
  });
  ipcMain.handle("science:projects:updateRelatedDomains", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceStore().updateProjectRelatedDomains(input as UpdateScienceProjectRelatedDomainsInput);
  });
  ipcMain.handle("science:workspace:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().getProjectWorkspaceState(projectId);
  });
  ipcMain.handle("science:workspace:updateNavigation", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceStore().updateProjectNavigation(input as UpdateScienceProjectNavigationInput);
  });
  ipcMain.handle("science:workspace:replaceTabs", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceStore().replaceProjectWorkspaceTabs(input as ReplaceScienceProjectWorkspaceTabsInput);
  });
  ipcMain.handle("science:researchLifecycle:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const lifecycle = scienceStore().getResearchLifecycleForProject(projectId);
    if (!lifecycle) throw new Error("science-research-lifecycle-canonical-missing");
    scienceLifecycleSubscribers.set(event.sender.id, projectId);
    return lifecycle;
  });
  ipcMain.handle("science:researchLifecycle:revisions", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const studyId = input && typeof input === "object" && "studyId" in input ? String((input as { studyId?: unknown }).studyId ?? "") : "";
    const lifecycle = scienceStore().getResearchLifecycleForProject(projectId);
    if (!lifecycle || lifecycle.studyId !== studyId) throw new Error("science-research-lifecycle-noncanonical-study");
    scienceLifecycleSubscribers.set(event.sender.id, projectId);
    return scienceStore().listResearchLifecycleRevisions(projectId, studyId);
  });
  ipcMain.handle("science:researchContracts:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().latestResearchContract(projectId);
  });
  ipcMain.handle("science:researchContracts:approve", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceStore().approveResearchContract(input as ApproveScienceResearchContractInput);
  });
  // How this project wants to be asked. Reading is free; changing it is a decision the researcher
  // makes, so it goes through Main like every other authorization rather than the agent's tools.
  ipcMain.handle("science:approvalPolicy:get", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const record = envelope && typeof envelope === "object" ? envelope as { projectId?: unknown } : null;
    return scienceStore().approvalPolicy(String(record?.projectId ?? ""));
  });
  ipcMain.handle("science:approvalPolicy:set", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceStore().setApprovalPolicy(input as SetScienceApprovalPolicyInput);
  });
  ipcMain.handle("science:researchLoops:inspect", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const sessions = scienceStore().listLoopSessions(projectId);
    const session = scienceStore().getActiveLoopSession(projectId) ?? sessions[0] ?? null;
    return {
      schema: "agentlas.science.research-loop-inspection/v1",
      active: session !== null && ["queued", "running", "pausing", "paused"].includes(session.status),
      session,
      episodes: session ? scienceStore().listResearchEpisodes(projectId, session.id) : [],
      events: session ? scienceStore().listLoopEvents(session.id, 0, 1_000) : [],
    };
  });
  ipcMain.handle("science:researchLoops:start", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-loop-input-invalid");
    const record = input as StartScienceLoopSessionInput;
    const { scienceRuntimePreference } = await import("./science/runtime-preferences");
    assertScienceSender(event, envelope, "science:agent-runtime");
    const runtimeSelection = scienceRuntimePreference(scienceStore(), record);
    if (!runtimeSelection?.model) throw new Error("science-runtime-selection-required");
    return scienceStore().startLoopSession({ ...record, runtimeSelection });
  });
  ipcMain.handle("science:researchLoops:transition", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-loop-input-invalid");
    const record = input as TransitionScienceLoopSessionInput;
    const store = scienceStore();
    const prior = store.getLoopSessionForProject(record.projectId, record.loopSessionId);
    const result = store.transitionLoopSession(record);

    // A pause/cancel is durable before adapter cancellation is requested. Use
    // the exact active run captured before the transition because terminal
    // cancel clears activeRunId, and keep this cleanup unconditional for the
    // cancel action so a stale stop cannot deadlock on provider state.
    if ((record.action === "pause" || record.action === "cancel") && prior?.activeRunId) {
      const turn = store.getTurnByInvocationRunId(prior.activeRunId);
      if (turn && turn.projectId === record.projectId) {
        try {
          scienceConversationService().cancel({
            projectId: turn.projectId,
            conversationId: turn.conversationId,
            turnId: turn.id,
          });
        } catch (error) {
          console.error("[science-runtime] loop transition cancellation failed", error);
        }
      }
    }

    if (record.action === "resume" && result.session.status === "queued") {
      try {
        if (!result.session.runtimeSelection?.model) throw new Error("science-runtime-selection-required");
        const conversation = store.listConversations(record.projectId)
          .find((candidate) => store.getConversationRuntimeBinding(record.projectId, candidate.id)?.runtimeChatId === result.session.runtimeChatId);
        if (!conversation) throw new Error("science-loop-resume-conversation-missing");
        scienceConversationService().resumeLoop({
          requestId: record.requestId,
          projectId: record.projectId,
          conversationId: conversation.id,
          loopSessionId: result.session.id,
          expectedLoopVersion: result.session.version,
          expectedLoopStateSha256: result.session.stateSha256,
        });
        const current = store.getLoopSessionForProject(record.projectId, result.session.id);
        return { ...result, session: current ?? result.session };
      } catch (error) {
        const current = store.getLoopSessionForProject(record.projectId, result.session.id);
        if (current && current.status === "queued"
          && current.version === result.session.version && current.stateSha256 === result.session.stateSha256) {
          try {
            store.failLoopResumeDispatch({
              projectId: current.projectId,
              loopSessionId: current.id,
              expectedLoopVersion: current.version,
              expectedLoopStateSha256: current.stateSha256,
              errorCode: (error instanceof Error ? error.message : String(error)).slice(0, 240) || "science-loop-resume-failed",
            });
          } catch { /* a concurrent canonical transition wins */ }
        }
        throw error;
      }
    }
    return result;
  });
  ipcMain.handle("science:conversations:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().listConversations(projectId);
  });
  ipcMain.handle("science:messages:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const conversationId = input && typeof input === "object" && "conversationId" in input ? String((input as { conversationId?: unknown }).conversationId ?? "") : "";
    return scienceStore().listMessagesForProject(projectId, conversationId);
  });
  const scienceRuntimeInput = (envelope: unknown) => {
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-runtime-input-invalid");
    const record = input as Record<string, unknown>;
    if (typeof record.projectId !== "string" || typeof record.conversationId !== "string") throw new Error("science-runtime-input-invalid");
    return { projectId: record.projectId, conversationId: record.conversationId, selection: record.selection };
  };
  ipcMain.handle("science:runtime:inspect", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = scienceRuntimeInput(envelope);
    const { inspectScienceRuntime } = await import("./science/runtime-preferences");
    assertScienceSender(event, envelope, "science:agent-runtime");
    return inspectScienceRuntime(scienceStore(), input);
  });
  ipcMain.handle("science:runtime:select", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = scienceRuntimeInput(envelope);
    const { selectScienceRuntime } = await import("./science/runtime-preferences");
    assertScienceSender(event, envelope, "science:agent-runtime");
    return selectScienceRuntime(scienceStore(), input);
  });
  ipcMain.handle("science:composer:start", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-composer-input-invalid");
    const record = input as Record<string, unknown>;
    const projectId = String(record.projectId ?? "");
    const conversationId = String(record.conversationId ?? "");
    const { normalizeScienceRuntimeSelection } = await import("./science/runtime-selection");
    const { scienceRuntimePreference } = await import("./science/runtime-preferences");
    assertScienceSender(event, envelope, "science:agent-runtime");
    const runtimeSelection = normalizeScienceRuntimeSelection(record.runtimeSelection ?? scienceRuntimePreference(scienceStore(), { projectId, conversationId }));
    if (!runtimeSelection?.model) throw new Error("science-runtime-selection-required");
    ensureScienceTurnProjection();
    scienceTurnSubscribers.set(event.sender.id, { projectId, conversationId });
    return scienceConversationService().start({ ...input, runtimeSelection } as ScienceComposerStartInput);
  });
  ipcMain.handle("science:composer:cancel", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-composer-input-invalid");
    const record = input as Record<string, unknown>;
    return scienceConversationService().cancel({
      projectId: String(record.projectId ?? ""),
      conversationId: String(record.conversationId ?? ""),
      turnId: String(record.turnId ?? ""),
    });
  });
  ipcMain.handle("science:composer:attach", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-composer-input-invalid");
    const record = input as Record<string, unknown>;
    const projectId = String(record.projectId ?? "");
    const conversationId = String(record.conversationId ?? "");
    ensureScienceTurnProjection();
    scienceTurnSubscribers.set(event.sender.id, { projectId, conversationId });
    return scienceConversationService().attach({ projectId, conversationId });
  });
  ipcMain.handle("science:composer:receipt", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-composer-input-invalid");
    const record = input as Record<string, unknown>;
    return scienceConversationService().receipt({
      projectId: String(record.projectId ?? ""),
      conversationId: String(record.conversationId ?? ""),
      turnId: String(record.turnId ?? ""),
    });
  });
  ipcMain.handle("science:messageBlocks:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const messageId = input && typeof input === "object" && "messageId" in input ? String((input as { messageId?: unknown }).messageId ?? "") : "";
    return scienceStore().listMessageBlocksForProject(projectId, messageId);
  });
  ipcMain.handle("science:citations:listForMessage", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const messageId = input && typeof input === "object" && "messageId" in input ? String((input as { messageId?: unknown }).messageId ?? "") : "";
    return scienceStore().listCitationsForMessageForProject(projectId, messageId);
  });
  ipcMain.handle("science:evidence:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const evidenceId = input && typeof input === "object" && "evidenceId" in input ? String((input as { evidenceId?: unknown }).evidenceId ?? "") : "";
    return scienceStore().getEvidenceSpanForProject(projectId, evidenceId);
  });
  ipcMain.handle("science:evidenceGraph:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceEvidenceGraphService().get(projectId);
  });
  ipcMain.handle("science:evidenceGraph:refresh", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceEvidenceGraphService().refresh(input as RefreshScienceEvidenceGraphInput);
  });
  ipcMain.handle("science:evidenceGraph:bounded", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const query = input && typeof input === "object" && "query" in input ? String((input as { query?: unknown }).query ?? "") : "";
    const limit = input && typeof input === "object" && "limit" in input ? Number((input as { limit?: unknown }).limit ?? 40) : 40;
    return scienceEvidenceGraphService().boundedContext(projectId, query, limit);
  });
  ipcMain.handle("science:evidenceGraph:propose", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceEvidenceGraphService().proposeInference(input as ProposeScienceEvidenceGraphInferenceInput);
  });
  ipcMain.handle("science:evidenceGraph:review", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceEvidenceGraphService().reviewInference(input as ReviewScienceEvidenceGraphInferenceInput);
  });
  ipcMain.handle("science:evidenceGraph:materialize", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceEvidenceGraphService().materializeInferenceAsHypothesis(input as MaterializeScienceEvidenceGraphInferenceInput);
  });
  ipcMain.handle("science:evidenceGraph:path", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const fromNodeId = input && typeof input === "object" && "fromNodeId" in input ? String((input as { fromNodeId?: unknown }).fromNodeId ?? "") : "";
    const toNodeId = input && typeof input === "object" && "toNodeId" in input ? String((input as { toNodeId?: unknown }).toNodeId ?? "") : "";
    return scienceEvidenceGraphService().explainPath(projectId, fromNodeId, toNodeId);
  });
  ipcMain.handle("science:sources:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().listSources(projectId);
  });
  ipcMain.handle("science:sources:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const sourceId = input && typeof input === "object" && "sourceId" in input ? String((input as { sourceId?: unknown }).sourceId ?? "") : "";
    return scienceStore().getSourceForProject(projectId, sourceId);
  });
  ipcMain.handle("science:datasets:importCsv", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-dataset-input-invalid");
    const record = input as Record<string, unknown>;
    const options: Electron.OpenDialogOptions = {
      title: "Import CSV dataset",
      properties: ["openFile"],
      filters: [{ name: "CSV datasets", extensions: ["csv"] }],
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const selected = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (selected.canceled || selected.filePaths.length !== 1) return { canceled: true };
    const store = scienceStore();
    const imported = await createScienceDatasetIngestionService(store).importFile(selected.filePaths[0], {
      requestId: String(record.requestId ?? ""),
      projectId: String(record.projectId ?? ""),
      conversationId: String(record.conversationId ?? ""),
      originMessageId: String(record.originMessageId ?? ""),
      title: typeof record.title === "string" ? record.title : undefined,
    });
    const materialized = store.materializeDatasetTable({
      requestId: String(record.artifactRequestId ?? ""),
      projectId: String(record.projectId ?? ""),
      runId: imported.run.id,
      title: typeof record.title === "string" ? record.title : undefined,
    });
    return { ...imported, artifact: materialized.artifact, artifactReplayed: materialized.replayed };
  });
  ipcMain.handle("science:sourceFigures:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().listSourceFigures(projectId);
  });
  ipcMain.handle("science:sourceFigures:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getSourceFigureForProject(String(record.projectId ?? ""), String(record.figureId ?? ""));
  });
  ipcMain.handle("science:runs:list", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().listResearchRuns(projectId);
  });
  ipcMain.handle("science:runs:get", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getResearchRunForProject(String(record.projectId ?? ""), String(record.runId ?? ""));
  });
  ipcMain.handle("science:artifacts:list", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().listArtifacts(projectId);
  });
  // The method catalogue the launch screen offers. Read from the same loader the Research Director
  // uses, so the screen and the agent cannot end up offering different sets of methods.
  ipcMain.handle("science:statistics:methods", (event, input: unknown) => {
    assertScienceSender(event, input, "science:compute");
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    if (Object.keys(record).some((key) => key !== "extensionId")) throw new Error("science-statistics-method-catalogue-input-invalid");
    return scienceStatisticsMethodCatalogue();
  });
  ipcMain.handle("science:artifacts:listStatisticsFigures", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const allowed = new Set(["extensionId", "projectId", "statisticsArtifactId"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("science-statistics-figure-list-input-invalid");
    return scienceStore().listStatisticsFigures(
      String(record.projectId ?? ""),
      record.statisticsArtifactId === undefined ? undefined : String(record.statisticsArtifactId),
    );
  });
  ipcMain.handle("science:artifacts:materializeStatisticsFigure", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-statistics-figure-frame-denied");
    const raw = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const allowed = new Set(["requestId", "projectId", "statisticsArtifactId", "statisticsArtifactVersion", "statisticsArtifactContentSha256", "visualizationIndex", "title"]);
    if (!record || Object.keys(record).some((key) => !allowed.has(key))) throw new Error("science-statistics-figure-input-invalid");
    const result = scienceStore().materializeStatisticsFigure(record as unknown as import("../shared/science-contract").MaterializeScienceStatisticsFigureInput);
    notifyScienceArtifactChanged(String(record.projectId ?? ""), result.artifact);
    return result;
  });
  ipcMain.handle("science:artifacts:materializeStatisticsNumericSurface", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-statistics-numeric-surface-frame-denied");
    const raw = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const allowed = new Set(["requestId", "projectId", "statisticsArtifactId", "statisticsArtifactVersion", "statisticsArtifactContentSha256", "sourceArtifactIndex"]);
    if (!record || Object.keys(record).some((key) => !allowed.has(key))) throw new Error("science-statistics-numeric-surface-input-invalid");
    const result = scienceStore().materializeStatisticsNumericSurface(
      record as unknown as import("../shared/science-contract").MaterializeScienceStatisticsNumericSurfaceInput,
    );
    notifyScienceArtifactChanged(String(record.projectId ?? ""), result.artifact);
    return result;
  });
  ipcMain.handle("science:artifacts:getNumericSurfaceViewState", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-numeric-surface-view-state-frame-denied");
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
    const allowed = new Set(["extensionId", "projectId", "artifactId", "artifactVersion", "artifactContentSha256"]);
    if (!record || Object.keys(record).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(record.artifactVersion) || Number(record.artifactVersion) < 1) {
      throw new Error("science-numeric-surface-view-state-input-invalid");
    }
    return scienceStore().getNumericSurfaceViewState(
      String(record.projectId ?? ""), String(record.artifactId ?? ""), Number(record.artifactVersion), String(record.artifactContentSha256 ?? ""),
    );
  });
  ipcMain.handle("science:artifacts:persistNumericSurfaceViewState", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-numeric-surface-view-state-frame-denied");
    const raw = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const allowed = new Set(["projectId", "artifactId", "artifactVersion", "artifactContentSha256", "viewState"]);
    if (!record || Object.keys(record).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(record.artifactVersion) || Number(record.artifactVersion) < 1) {
      throw new Error("science-numeric-surface-view-state-input-invalid");
    }
    return scienceStore().persistNumericSurfaceViewState(
      record as unknown as import("../shared/science-numeric-3d").PersistScienceNumericSurfaceViewStateInput,
    );
  });
  ipcMain.handle("science:artifacts:exportNumericSurfacePng", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-numeric-surface-raster-frame-denied");
    const raw = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const allowed = new Set(["projectId", "artifactId", "artifactVersion", "contentSha256", "rendered", "png", "readbackRgba"]);
    if (!record || Object.keys(record).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(record.artifactVersion) || Number(record.artifactVersion) < 1
      || !(record.png instanceof Uint8Array) || !(record.readbackRgba instanceof Uint8Array)) {
      throw new Error("science-numeric-surface-png-export-input-invalid");
    }
    const projectId = String(record.projectId ?? "");
    const artifactId = String(record.artifactId ?? "");
    const artifactVersion = Number(record.artifactVersion);
    const contentSha256 = String(record.contentSha256 ?? "");
    const store = scienceStore();
    const artifact = store.getArtifactForProject(projectId, artifactId);
    if (!artifact || artifact.kind !== "chart.numeric-3d" || artifact.version.rendererId !== "agentlas.three-numeric"
      || artifact.currentVersion !== artifactVersion || artifact.version.contentSha256 !== contentSha256
      || artifact.version.payload.schema !== "agentlas.science.numeric-surface-artifact/v2") {
      throw new Error("science-numeric-surface-raster-parent-invalid");
    }
    const validated = await validateScienceNumericSurfacePngBytes(record.rendered, record.png, record.readbackRgba);
    const current = store.getArtifactForProject(projectId, artifactId);
    if (!current || current.currentVersion !== artifactVersion || current.version.contentSha256 !== contentSha256) {
      throw new Error("science-artifact-version-conflict");
    }
    const requestSeed = JSON.stringify({
      schema: "agentlas.science.numeric-surface-raster-ipc/v1",
      projectId,
      artifactId,
      artifactVersion,
      contentSha256,
      viewStateReceiptSha256: validated.rendered.viewStateReceiptSha256,
      dpi: validated.rendered.dpi,
      width: validated.rendered.width,
      height: validated.rendered.height,
      rgbaSha256: validated.rendered.readback.rgbaSha256,
      pngSha256: validated.rendered.sha256,
    });
    const digest = createHash("sha256").update(requestSeed, "utf8").digest("hex");
    const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const persisted = store.persistNumericSurfacePng({
      requestId,
      projectId,
      artifactId,
      artifactVersion,
      contentSha256,
      rendered: validated.rendered,
      png: validated.png,
    });
    notifyScienceArtifactChanged(projectId, persisted.artifact);
    return {
      artifactId,
      artifactVersion,
      contentSha256,
      ...validated.rendered,
      exportArtifact: {
        id: persisted.artifact.id,
        version: persisted.artifact.currentVersion,
        kind: persisted.artifact.kind,
        contentSha256: persisted.artifact.version.contentSha256,
        captureId: persisted.visualCapture.id,
        captureSha256: persisted.visualCapture.sha256,
        exportSha256: persisted.payload.export.sha256,
        exportReceiptSha256: persisted.payload.exportSha256,
      },
      replayed: persisted.replayed,
    };
  });
  ipcMain.handle("science:artifacts:exportStatisticsFigureSvg", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-statistics-figure-frame-denied");
    const raw = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const allowed = new Set(["projectId", "artifactId", "artifactVersion", "contentSha256"]);
    if (!record || Object.keys(record).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(record.artifactVersion) || Number(record.artifactVersion) < 1) {
      throw new Error("science-statistics-figure-svg-export-input-invalid");
    }
    const projectId = String(record.projectId ?? "");
    const artifactId = String(record.artifactId ?? "");
    const artifact = scienceStore().getArtifactForProject(projectId, artifactId);
    if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega") {
      throw new Error("science-statistics-figure-not-found");
    }
    const artifactVersion = Number(record.artifactVersion);
    const contentSha256 = String(record.contentSha256 ?? "");
    if (artifact.currentVersion !== artifactVersion || artifact.version.contentSha256 !== contentSha256) {
      throw new Error("science-artifact-version-conflict");
    }
    const rendered = await renderScienceStatisticsFigureSvg(artifact.version.payload);
    const preview = await renderScienceStatisticsFigureSvgPreviewPng(rendered);
    const requestSeed = JSON.stringify({
      schema: "agentlas.science.statistics-figure-vector-ipc/v1",
      projectId,
      artifactId,
      artifactVersion,
      contentSha256,
      exportSha256: rendered.sha256,
      previewSha256: preview.sha256,
    });
    const digest = createHash("sha256").update(requestSeed, "utf8").digest("hex");
    const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const persisted = scienceStore().persistStatisticsFigureSvg({
      requestId,
      projectId,
      artifactId,
      artifactVersion,
      contentSha256,
      rendered,
      svg: Buffer.from(rendered.svg, "utf8"),
      preview,
      previewPng: Buffer.from(preview.dataBase64, "base64"),
    });
    notifyScienceArtifactChanged(projectId, persisted.artifact);
    return {
      artifactId,
      artifactVersion,
      contentSha256,
      ...rendered,
      exportArtifact: {
        id: persisted.artifact.id,
        version: persisted.artifact.currentVersion,
        kind: persisted.artifact.kind,
        contentSha256: persisted.artifact.version.contentSha256,
        captureId: persisted.visualCapture.id,
        captureSha256: persisted.visualCapture.sha256,
        exportSha256: persisted.payload.export.sha256,
        exportReceiptSha256: persisted.payload.exportSha256,
      },
      replayed: persisted.replayed,
    };
  });
  ipcMain.handle("science:artifacts:exportStatisticsFigurePng", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-statistics-figure-frame-denied");
    const raw = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const allowed = new Set(["projectId", "artifactId", "artifactVersion", "contentSha256", "dpi", "widthMm"]);
    if (!record || Object.keys(record).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(record.artifactVersion) || Number(record.artifactVersion) < 1
      || ![300, 600].includes(Number(record.dpi))
      || record.widthMm !== undefined && (!Number.isFinite(Number(record.widthMm)) || Number(record.widthMm) < 20 || Number(record.widthMm) > 200)) {
      throw new Error("science-statistics-figure-png-export-input-invalid");
    }
    const projectId = String(record.projectId ?? "");
    const artifactId = String(record.artifactId ?? "");
    const store = scienceStore();
    const artifact = store.getArtifactForProject(projectId, artifactId);
    if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega") {
      throw new Error("science-statistics-figure-not-found");
    }
    const artifactVersion = Number(record.artifactVersion);
    const contentSha256 = String(record.contentSha256 ?? "");
    if (artifact.currentVersion !== artifactVersion || artifact.version.contentSha256 !== contentSha256) {
      throw new Error("science-artifact-version-conflict");
    }
    const rendered = await renderScienceStatisticsFigurePng(artifact.version.payload, {
      dpi: Number(record.dpi) as 300 | 600,
      ...(record.widthMm === undefined ? {} : { widthMm: Number(record.widthMm) }),
    });
    const requestSeed = JSON.stringify({
      schema: "agentlas.science.statistics-figure-raster-ipc/v1",
      projectId,
      artifactId,
      artifactVersion,
      contentSha256,
      dpi: rendered.dpi,
      widthMm: rendered.widthMm,
      exportSha256: rendered.sha256,
    });
    const digest = createHash("sha256").update(requestSeed, "utf8").digest("hex");
    const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const persisted = store.persistStatisticsFigurePng({
      requestId,
      projectId,
      artifactId,
      artifactVersion,
      contentSha256,
      rendered,
      png: Buffer.from(rendered.dataBase64, "base64"),
    });
    notifyScienceArtifactChanged(projectId, persisted.artifact);
    return {
      artifactId,
      artifactVersion,
      contentSha256,
      ...rendered,
      exportArtifact: {
        id: persisted.artifact.id,
        version: persisted.artifact.currentVersion,
        kind: persisted.artifact.kind,
        contentSha256: persisted.artifact.version.contentSha256,
        captureId: persisted.visualCapture.id,
        captureSha256: persisted.visualCapture.sha256,
        exportSha256: persisted.payload.export.sha256,
        exportReceiptSha256: persisted.payload.exportSha256,
      },
      replayed: persisted.replayed,
    };
  });
  const exportScienceStatisticsFigurePublicationBinary = async (
    event: Electron.IpcMainInvokeEvent,
    envelope: unknown,
    format: "pdf" | "tiff",
  ) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-statistics-figure-frame-denied");
    const raw = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const allowed = new Set(["projectId", "artifactId", "artifactVersion", "contentSha256", "dpi", "widthMm", "colorSpace"]);
    if (!record || Object.keys(record).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(record.artifactVersion) || Number(record.artifactVersion) < 1
      || ![300, 600].includes(Number(record.dpi))
      || record.widthMm !== undefined && (!Number.isFinite(Number(record.widthMm)) || Number(record.widthMm) < 20 || Number(record.widthMm) > 200)
      || record.colorSpace !== undefined && record.colorSpace !== "srgb") {
      throw new Error(`science-statistics-figure-${format}-export-input-invalid`);
    }
    const projectId = String(record.projectId ?? "");
    const artifactId = String(record.artifactId ?? "");
    const artifact = scienceStore().getArtifactForProject(projectId, artifactId);
    if (!artifact || artifact.kind !== "chart.vega" || artifact.version.rendererId !== "agentlas.vega") {
      throw new Error("science-statistics-figure-not-found");
    }
    const artifactVersion = Number(record.artifactVersion);
    const contentSha256 = String(record.contentSha256 ?? "");
    if (artifact.currentVersion !== artifactVersion || artifact.version.contentSha256 !== contentSha256) {
      throw new Error("science-artifact-version-conflict");
    }
    const options = {
      dpi: Number(record.dpi) as 300 | 600,
      ...(record.widthMm === undefined ? {} : { widthMm: Number(record.widthMm) }),
      ...(record.colorSpace === undefined ? {} : { colorSpace: "srgb" as const }),
    };
    const rendered = format === "pdf"
      ? await renderScienceStatisticsFigurePdf(artifact.version.payload, options)
      : await renderScienceStatisticsFigureTiff(artifact.version.payload, options);
    return { artifactId, artifactVersion, contentSha256, ...rendered };
  };
  ipcMain.handle("science:artifacts:exportStatisticsFigurePdf", (event, envelope: unknown) => (
    exportScienceStatisticsFigurePublicationBinary(event, envelope, "pdf")
  ));
  ipcMain.handle("science:artifacts:exportStatisticsFigureTiff", (event, envelope: unknown) => (
    exportScienceStatisticsFigurePublicationBinary(event, envelope, "tiff")
  ));
  ipcMain.handle("science:artifacts:get", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const artifactId = input && typeof input === "object" && "artifactId" in input ? String((input as { artifactId?: unknown }).artifactId ?? "") : "";
    return scienceStore().getArtifactForProject(projectId, artifactId);
  });
  ipcMain.handle("science:artifacts:context", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const artifactVersion = record.artifactVersion === undefined ? undefined : Number(record.artifactVersion);
    return scienceStore().getArtifactContextForProject(String(record.projectId ?? ""), String(record.artifactId ?? ""), artifactVersion);
  });
  ipcMain.handle("science:artifacts:history", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getArtifactVersionHistoryForProject(String(record.projectId ?? ""), String(record.artifactId ?? ""));
  });
  ipcMain.handle("science:artifacts:diff", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const allowed = new Set(["extensionId", "projectId", "artifactId", "fromVersion", "toVersion"]);
    if (Object.keys(record).some((key) => !allowed.has(key)) || typeof record.fromVersion !== "number" || typeof record.toVersion !== "number") {
      throw new Error("science-artifact-diff-input-invalid");
    }
    return scienceStore().getArtifactVersionDiffForProject(
      String(record.projectId ?? ""), String(record.artifactId ?? ""), record.fromVersion, record.toVersion,
    );
  });
  ipcMain.handle("science:artifacts:listForMessage", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().listArtifactContextsForMessage(
      String(record.projectId ?? ""), String(record.conversationId ?? ""), String(record.messageId ?? ""),
    );
  });
  ipcMain.handle("science:artifactEvents:listForMessage", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const allowed = new Set(["extensionId", "projectId", "conversationId", "messageId"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("science-conversation-artifact-event-input-invalid");
    return scienceStore().listConversationArtifactEventsForMessage(
      String(record.projectId ?? ""), String(record.conversationId ?? ""), String(record.messageId ?? ""),
    );
  });
  ipcMain.handle("science:artifacts:resolveConversationRoute", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const allowed = new Set(["extensionId", "projectId", "conversationId", "messageId", "artifactId", "artifactVersion"]);
    if (Object.keys(record).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(record.artifactVersion)
      || Number(record.artifactVersion) < 1) {
      throw new Error("science-conversation-artifact-route-input-invalid");
    }
    return scienceStore().resolveConversationArtifactRoute(
      String(record.projectId ?? ""),
      String(record.conversationId ?? ""),
      String(record.messageId ?? ""),
      String(record.artifactId ?? ""),
      Number(record.artifactVersion),
    );
  });
  ipcMain.handle("science:artifacts:listForLab", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().listArtifactContextsForLab(String(record.projectId ?? ""), String(record.labId ?? ""));
  });
  ipcMain.handle("science:artifacts:preview", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().artifactVisualPreviewForProject(
      String(record.projectId ?? ""), String(record.artifactId ?? ""), Number(record.artifactVersion),
    );
  });
  ipcMain.handle("science:artifacts:updateVega", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-vega-edit-frame-denied");
    const raw = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const input = parseScienceVegaEditInput(raw);
    const result = commitScienceVegaEdit(scienceStore(), input);
    notifyScienceArtifactChanged(input.projectId, result.artifact);
    return result;
  });
  ipcMain.handle("science:labs:list", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().listLabs(projectId);
  });
  ipcMain.handle("science:labs:catalog", async (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const { activeScienceLabCapabilityCatalog } = await import("./science/tool-control-server");
    return activeScienceLabCapabilityCatalog();
  });
  ipcMain.handle("science:labs:decisionProjections", async (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const projectId = input && typeof input === "object" && "projectId" in input
      ? String((input as { projectId?: unknown }).projectId ?? "")
      : "";
    const { activeScienceLabCapabilityCatalog } = await import("./science/tool-control-server");
    const catalog = await activeScienceLabCapabilityCatalog();
    return scienceLabDecisionProjectionsForProject(scienceStore(), projectId, catalog);
  });
  ipcMain.handle("science:resultReviews:inspect", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-episode-result-review-frame-denied");
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    const { activeScienceLabCapabilityCatalog } = await import("./science/tool-control-server");
    return inspectScienceEpisodeResultReview(
      scienceStore(),
      await activeScienceLabCapabilityCatalog(),
      input as InspectScienceEpisodeResultReviewInput,
    );
  });
  ipcMain.handle("science:resultReviews:record", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-episode-result-review-frame-denied");
    const actor = getAuthenticatedActorIds();
    if (!actor) throw new Error("science-episode-result-review-actor-required");
    const reviewerRef = `account-sha256:${createHash("sha256").update(`${actor.workspaceId}\0${actor.userId}`, "utf8").digest("hex")}`;
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    const { activeScienceLabCapabilityCatalog } = await import("./science/tool-control-server");
    return recordScienceEpisodeResultReview(
      scienceStore(),
      await activeScienceLabCapabilityCatalog(),
      input as RecordScienceEpisodeResultReviewInput,
      reviewerRef,
    );
  });
  ipcMain.handle("science:labs:upsertBinding", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
    if (!record) throw new Error("science-project-lab-binding-input-invalid");
    const { activeScienceLabCapabilityCatalog } = await import("./science/tool-control-server");
    const catalog = await activeScienceLabCapabilityCatalog();
    if (!catalog.labs.some((lab) => lab.id === String(record.labId ?? ""))) throw new Error("science-project-lab-definition-not-found");
    return scienceStore().upsertProjectLabBinding(input as UpsertScienceProjectLabBindingInput);
  });
  ipcMain.handle("science:renderers:mount", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    const value = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!isMountScienceRendererInput(value)) throw new Error("science-renderer-mount-input-invalid");
    const input: MountScienceRendererInput = value;
    const artifact = scienceStore().getArtifactForProject(input.projectId, input.artifactId);
    if (!artifact || artifact.currentVersion !== input.artifactVersion || artifact.version.contentSha256 !== input.contentSha256) throw new Error("science-artifact-version-conflict");
    const resolved = resolveVerifiedScienceRenderer(artifact.version.rendererId, artifact.kind);
    if (!resolved || !artifact.version.rendererBinding || !scienceRendererBindingsEqual(resolved.binding, artifact.version.rendererBinding)) throw new Error("science-renderer-binding-unavailable");
    const rendererInput = scienceStore().artifactRendererInputForProject(input.projectId, input.artifactId);
    const payloadBytes = rendererInput.kind === "protein-structure"
      ? rendererInput.bytes.byteLength
      : Buffer.byteLength(rendererInput.ket, "utf8") + Buffer.byteLength(rendererInput.canonicalSmiles, "utf8");
    if (payloadBytes < 1 || payloadBytes > resolved.renderer.maxPayloadBytes) throw new Error("science-renderer-payload-invalid");
    const instanceId = randomUUID();
    const renderRequestId = randomUUID();
    return mountScienceRendererView(event.sender.id, {
      projectId: input.projectId,
      releaseDir: resolved.releaseDir,
      entryPath: path.resolve(resolved.releaseDir, resolved.pack.entry),
      bounds: input.bounds,
      request: {
        schema: SCIENCE_RENDERER_REQUEST_SCHEMA,
        instanceId,
        renderRequestId,
        artifactId: artifact.id,
        artifactVersion: artifact.currentVersion,
        artifactKind: artifact.kind,
        artifactContentSha256: artifact.version.contentSha256,
        binding: resolved.binding,
        input: rendererInput,
      },
    });
  });
  ipcMain.handle("science:renderers:bounds", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    const value = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!isMountScienceRendererInput(value)) throw new Error("science-renderer-bounds-input-invalid");
    return updateScienceRendererViewBounds(event.sender.id, value);
  });
  ipcMain.handle("science:renderers:visibility", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const allowed = new Set(["extensionId", "visible"]);
    if (Object.keys(record).some((key) => !allowed.has(key)) || typeof record.visible !== "boolean") {
      throw new Error("science-renderer-visibility-input-invalid");
    }
    return setScienceRendererViewVisibility(event.sender.id, record.visible);
  });
  ipcMain.handle("science:renderers:dispose", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    return disposeScienceRendererView(event.sender.id);
  });
  ipcMain.handle("scienceRenderer:handshake", (event, input: unknown) => {
    const instanceId = input && typeof input === "object" && "instanceId" in input ? String((input as { instanceId?: unknown }).instanceId ?? "") : "";
    return scienceRendererHandshake(event.sender.id, instanceId);
  });
  ipcMain.handle("scienceRenderer:report", (event, input: unknown) => {
    const instanceId = input && typeof input === "object" && "instanceId" in input ? String((input as { instanceId?: unknown }).instanceId ?? "") : "";
    const report = input && typeof input === "object" && "report" in input ? (input as { report?: unknown }).report : null;
    const status = scienceRendererReport(event.sender.id, instanceId, report);
    if (status.phase !== "capturing") return status;
    // A guest must receive its stable-report acknowledgement before Main asks
    // that same WebContents to paint into capturePage. Awaiting capture inside
    // ipcRenderer.invoke can deadlock the renderer paint needed by capture.
    setImmediate(() => {
      void captureStableScienceRenderer(instanceId).then((result) => {
        scienceStore().recordArtifactVisualCapture({
          projectId: result.identity.projectId,
          artifactId: result.identity.artifactId,
          artifactVersion: result.identity.artifactVersion,
          contentSha256: result.identity.contentSha256,
          png: result.png,
          renderContext: result.renderContext,
          renderRequestId: result.renderRequestId,
          rendererBinding: result.rendererBinding,
          sceneRevision: result.sceneRevision,
        });
        try {
          scienceArtifactPublicationValidator().validate({
            projectId: result.identity.projectId,
            artifactId: result.identity.artifactId,
            artifactVersion: result.identity.artifactVersion,
          });
        } catch (error) {
          // Rendering and immutable capture are useful even when an older or
          // imported artifact cannot yet pass the stricter manuscript gate.
          // The explicit validation API returns the same machine error later.
          console.warn("[science-publication] capture not eligible", error instanceof Error ? error.message : String(error));
        }
        markScienceRendererCaptured(instanceId);
      }).catch((error) => {
        const summary = error instanceof Error ? error.message : String(error);
        try { failScienceRendererCapture(instanceId, "science-renderer-capture-store-failed", summary); }
        catch { console.warn("[science-renderer] capture failed after renderer disposal", summary); }
      });
    });
    return status;
  });
  ipcMain.handle("scienceRenderer:chemistryCommit", async (event, input: unknown) => {
    if (!isScienceChemistryCommitInput(input)) throw new Error("science-chemistry-commit-input-invalid");
    const commit: ScienceChemistryCommitInput = input;
    const authorized = authorizeScienceChemistryCommit(event.sender.id, commit);
    const commitKey = `${event.sender.id}:${authorized.artifactId}`;
    if (activeScienceChemistryCommits.has(commitKey)) throw new Error("science-chemistry-commit-in-flight");
    activeScienceChemistryCommits.add(commitKey);
    try {
    const artifactContext = scienceStore().getArtifactContextForProject(authorized.projectId, authorized.artifactId, authorized.artifactVersion);
    if (!artifactContext || artifactContext.selectedVersion.rendererId !== "agentlas.ketcher" || artifactContext.artifact.kind !== "chemistry.document") throw new Error("science-chemistry-artifact-not-found");
    const artifact = artifactContext.artifact;
    const baseVersion = artifactContext.selectedVersion;
    if (!baseVersion.rendererBinding || !scienceRendererBindingsEqual(baseVersion.rendererBinding, authorized.rendererBinding)) throw new Error("science-renderer-binding-conflict");
    const authoritative = await scienceChemistryValidator().validateKet({
      title: baseVersion.semantic.title,
      ket: commit.document.ket,
      binding: authorized.rendererBinding,
    });
    const document = authoritative.payload.document;
    const validation = authoritative.payload.validation;
    const renewed = authorizeScienceChemistryCommit(event.sender.id, commit);
    if (renewed.projectId !== authorized.projectId || renewed.artifactId !== authorized.artifactId
      || renewed.artifactVersion !== authorized.artifactVersion || renewed.contentSha256 !== authorized.contentSha256
      || !scienceRendererBindingsEqual(renewed.rendererBinding, authorized.rendererBinding)) {
      throw new Error("science-chemistry-commit-identity-conflict");
    }
    const priorWarnings = baseVersion.semantic.warnings.filter((warning) => !warning.startsWith("Indigo validation:"));
    const result = scienceStore().appendArtifactVersion({
      requestId: commit.requestId,
      projectId: authorized.projectId,
      artifactId: authorized.artifactId,
      expectedArtifactVersion: authorized.artifactVersion,
      expectedContentSha256: authorized.contentSha256,
      payload: { document, validation },
      semantic: {
        ...baseVersion.semantic,
        observations: [
          ...baseVersion.semantic.observations.filter((observation) => !["Atoms", "Bonds", "Canonical SMILES"].includes(observation.label)),
          { label: "Atoms", value: validation.atomCount, unit: null },
          { label: "Bonds", value: validation.bondCount, unit: null },
          { label: "Canonical SMILES", value: document.canonicalSmiles, unit: null },
        ],
        warnings: [...new Set([...priorWarnings, ...validation.warnings.map((warning) => `Indigo validation: ${warning}`)])],
      },
      provenance: baseVersion.provenance,
    });
    notifyScienceChemistryCommitted(commit.instanceId, authorized.projectId, result.artifact);
    return result;
    } finally {
      activeScienceChemistryCommits.delete(commitKey);
    }
  });
  ipcMain.handle("scienceRenderer:molstarCommit", async (event, input: unknown) => {
    if (!isScienceMolstarCommitInput(input)) throw new Error("science-molstar-commit-input-invalid");
    const commit: ScienceMolstarCommitInput = input;
    const authorized = authorizeScienceMolstarCommit(event.sender.id, commit);
    const artifact = scienceStore().getArtifactForProject(authorized.projectId, authorized.artifactId);
    if (!artifact || artifact.version.rendererId !== "agentlas.molstar" || artifact.kind !== "protein.structure") throw new Error("science-molstar-artifact-not-found");
    if (!artifact.version.rendererBinding || !scienceRendererBindingsEqual(artifact.version.rendererBinding, authorized.rendererBinding)) throw new Error("science-renderer-binding-conflict");
    const rendererInput = scienceStore().artifactRendererInputForProject(authorized.projectId, authorized.artifactId);
    if (rendererInput.kind !== "protein-structure") throw new Error("science-molstar-source-conflict");
    const interactionInput = commit.viewState.interaction ?? {
      schema: SCIENCE_RESIDUE_INTERACTION_SCHEMA,
      granularity: "residue" as const,
      residues: [],
      focus: null,
    };
    const residue = await validateScienceResidueInteraction({
      bytes: rendererInput.bytes,
      format: rendererInput.format,
      structureContentSha256: rendererInput.assetSha256,
      interaction: interactionInput,
    });
    const priorObservations = artifact.version.semantic.observations.filter((observation) => !["Representation", "Color theme", "Pinned residues", "Focused residue"].includes(observation.label));
    const result = scienceStore().appendArtifactVersion({
      requestId: commit.requestId,
      projectId: authorized.projectId,
      artifactId: authorized.artifactId,
      expectedArtifactVersion: authorized.artifactVersion,
      expectedContentSha256: authorized.contentSha256,
      payload: {
        ...artifact.version.payload,
        representation: commit.viewState.representation,
        colorTheme: commit.viewState.colorTheme,
        interaction: residue.interaction,
        interactionValidation: residue.validation,
      },
      semantic: {
        ...artifact.version.semantic,
        observations: [
          ...priorObservations,
          { label: "Representation", value: commit.viewState.representation, unit: null },
          { label: "Color theme", value: commit.viewState.colorTheme, unit: null },
          { label: "Pinned residues", value: residue.interaction.residues.length, unit: "residues" },
          { label: "Focused residue", value: residue.interaction.focus ? `${residue.interaction.focus.authAsymId}:${residue.interaction.focus.compId}${residue.interaction.focus.authSeqId}${residue.interaction.focus.insertionCode}` : "None", unit: null },
        ],
      },
      provenance: artifact.version.provenance,
    });
    notifyScienceArtifactChanged(authorized.projectId, result.artifact);
    return result;
  });
  ipcMain.handle("science:artifacts:capture", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-capture-input-invalid");
    const capture = input as CaptureScienceArtifactInput;
    const artifact = scienceStore().getArtifactForProject(String(capture.projectId ?? ""), String(capture.artifactId ?? ""));
    if (!artifact) throw new Error("science-artifact-not-found");
    if (artifact.currentVersion !== capture.artifactVersion || artifact.version.contentSha256 !== capture.contentSha256) throw new Error("science-artifact-version-conflict");
    const captured = await captureScienceExtensionViewRegion(event.sender.id, {
      artifactId: artifact.id,
      artifactVersion: artifact.currentVersion,
      contentSha256: artifact.version.contentSha256,
    });
    const observation = scienceStore().recordArtifactVisualCapture({ ...capture, png: captured.png, renderContext: captured.renderContext });
    try {
      const publicationValidation = scienceArtifactPublicationValidator().validate({
        projectId: artifact.projectId,
        artifactId: artifact.id,
        artifactVersion: artifact.currentVersion,
      });
      return { ...observation, publicationValidation };
    } catch (error) {
      return { ...observation, publicationValidationError: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("science:artifacts:observation", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    const artifactId = input && typeof input === "object" && "artifactId" in input ? String((input as { artifactId?: unknown }).artifactId ?? "") : "";
    return scienceStore().artifactObservationBundleForProject(projectId, artifactId);
  });
  ipcMain.handle("science:artifactValidations:list", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const artifactVersion = record.artifactVersion === undefined ? undefined : Number(record.artifactVersion);
    return scienceStore().listArtifactValidationReceipts(String(record.projectId ?? ""), String(record.artifactId ?? ""), artifactVersion);
  });
  ipcMain.handle("science:artifactValidations:closure", (event, input: unknown) => {
    assertScienceSender(event, input, "science:artifacts");
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getArtifactValidationRunArtifactBindingForProject(String(record.projectId ?? ""), String(record.receiptId ?? ""));
  });
  ipcMain.handle("science:artifactValidations:validate", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:artifacts");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-publication-validation-input-invalid");
    const record = input as Record<string, unknown>;
    return scienceArtifactPublicationValidator().validate({
      requestId: record.requestId === undefined ? undefined : String(record.requestId),
      projectId: String(record.projectId ?? ""),
      artifactId: String(record.artifactId ?? ""),
      artifactVersion: Number(record.artifactVersion),
    });
  });
  ipcMain.handle("science:manuscripts:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceStore().listManuscripts(projectId);
  });
  ipcMain.handle("science:manuscripts:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getManuscriptForProject(String(record.projectId ?? ""), String(record.manuscriptId ?? ""));
  });
  ipcMain.handle("science:manuscripts:editorModel", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const editorModel = scienceStore().getManuscriptEditorModelForProject(String(record.projectId ?? ""), String(record.manuscriptId ?? ""));
    return editorModel ? {
      ...editorModel,
      depthPreflight: inspectScienceManuscriptDepth(editorModel.manuscript.version.markdown),
      blueprint: editorModel.manuscript.version.blueprintBinding
        ? scienceStore().getManuscriptBlueprintForProject(String(record.projectId ?? ""), editorModel.manuscript.version.blueprintBinding.blueprintId)
        : null,
      blueprintAssessment: scienceStore().getManuscriptBlueprintAssessmentForManuscript(String(record.projectId ?? ""), String(record.manuscriptId ?? "")),
      scholarlyAssessment: scienceStore().getManuscriptScholarlyAssessmentForManuscript(String(record.projectId ?? ""), String(record.manuscriptId ?? "")),
      coherenceAssessment: scienceStore().getManuscriptCoherenceAssessmentForManuscript(String(record.projectId ?? ""), String(record.manuscriptId ?? "")),
    } : null;
  });
  ipcMain.handle("science:manuscripts:blueprintAssessment", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getManuscriptBlueprintAssessmentForManuscript(String(record.projectId ?? ""), String(record.manuscriptId ?? ""));
  });
  ipcMain.handle("science:manuscripts:scholarlyAssessment", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getManuscriptScholarlyAssessmentForManuscript(String(record.projectId ?? ""), String(record.manuscriptId ?? ""));
  });
  ipcMain.handle("science:manuscripts:coherenceAssessment", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getManuscriptCoherenceAssessmentForManuscript(String(record.projectId ?? ""), String(record.manuscriptId ?? ""));
  });
  ipcMain.handle("science:manuscripts:recordBlueprintAssessment", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-manuscript-blueprint-assessment-input-invalid");
    return scienceStore().recordManuscriptBlueprintAssessment(input as RecordScienceManuscriptBlueprintAssessmentInput);
  });
  ipcMain.handle("science:manuscripts:history", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const limit = Number(record.limit ?? 100);
    return scienceStore().listManuscriptTransactions(
      String(record.projectId ?? ""),
      String(record.manuscriptId ?? ""),
      Number.isFinite(limit) ? limit : 100,
    );
  });
  ipcMain.handle("science:manuscripts:selectionContexts", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const limit = Number(record.limit ?? 100);
    return scienceStore().listManuscriptSelectionContexts(
      String(record.projectId ?? ""),
      String(record.manuscriptId ?? ""),
      Number.isFinite(limit) ? limit : 100,
    );
  });
  ipcMain.handle("science:manuscripts:selectionContext", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getManuscriptSelectionContextForProject(
      String(record.projectId ?? ""),
      String(record.manuscriptId ?? ""),
      String(record.selectionContextId ?? ""),
    );
  });
  ipcMain.handle("science:manuscripts:editProposals", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const limit = Number(record.limit ?? 100);
    return scienceStore().listManuscriptEditProposals(
      String(record.projectId ?? ""),
      String(record.manuscriptId ?? ""),
      Number.isFinite(limit) ? limit : 100,
    );
  });
  ipcMain.handle("science:manuscripts:editProposal", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getManuscriptEditProposalForProject(
      String(record.projectId ?? ""),
      String(record.manuscriptId ?? ""),
      String(record.proposalId ?? ""),
    );
  });
  ipcMain.handle("science:claimLedgers:getForManuscript", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getClaimLedgerForManuscript(String(record.projectId ?? ""), String(record.manuscriptId ?? ""));
  });
  ipcMain.handle("science:manuscripts:appendVersion", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-manuscript-input-invalid");
    return scienceStore().appendManuscriptVersion(input as AppendScienceManuscriptVersionInput);
  });
  ipcMain.handle("science:manuscripts:applyTransaction", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-manuscript-transaction-input-invalid");
    return scienceStore().applyManuscriptTransaction(input as ApplyScienceManuscriptTransactionInput);
  });
  ipcMain.handle("science:manuscripts:revertTransaction", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-manuscript-transaction-input-invalid");
    return scienceStore().revertManuscriptTransaction(input as RevertScienceManuscriptTransactionInput);
  });
  ipcMain.handle("science:manuscripts:createSelectionContext", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-manuscript-selection-input-invalid");
    return scienceStore().createManuscriptSelectionContext(input as CreateScienceManuscriptSelectionContextInput);
  });
  ipcMain.handle("science:manuscripts:createEditProposal", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-manuscript-proposal-input-invalid");
    return scienceStore().createManuscriptEditProposal(input as CreateScienceManuscriptEditProposalInput);
  });
  ipcMain.handle("science:manuscripts:applyEditProposal", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-manuscript-proposal-input-invalid");
    return scienceStore().applyManuscriptEditProposal(input as ApplyScienceManuscriptEditProposalInput);
  });
  ipcMain.handle("science:manuscripts:rejectEditProposal", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-manuscript-proposal-input-invalid");
    return scienceStore().rejectManuscriptEditProposal(input as RejectScienceManuscriptEditProposalInput);
  });
  ipcMain.handle("science:manuscripts:render", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: Record<string, unknown> }).input
      : null;
    if (!input || typeof input !== "object" || typeof input.projectId !== "string") throw new Error("science-manuscript-render-input-invalid");
    const service = scienceManuscriptRenderService();
    const options = {
      outputs: Array.isArray(input.outputs) && input.outputs.length ? input.outputs as Array<"html" | "latex" | "docx" | "pdf" | "package"> : ["html" as const],
      style: (input.style as "numeric" | "apa" | "nature" | undefined) ?? "numeric",
      lineNumbers: input.lineNumbers === true, doubleSpacing: input.doubleSpacing === true,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata as ScienceSubmissionMetadata : null,
    };
    if (typeof input.manuscriptId === "string") return service.renderStored(input.projectId, input.manuscriptId, options);
    const draft = input.draft as { title?: unknown; markdown?: unknown; bindings?: unknown } | undefined;
    if (!draft || typeof draft.markdown !== "string" || !Array.isArray(draft.bindings)) throw new Error("science-manuscript-render-input-invalid");
    return service.render(draftManuscript(input.projectId, typeof draft.title === "string" ? draft.title : "", draft.markdown, draft.bindings as ScienceManuscriptBinding[]), options);
  });
  ipcMain.handle("science:journals:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const projectId = input && typeof input === "object" && "projectId" in input ? String((input as { projectId?: unknown }).projectId ?? "") : "";
    return scienceJournalPublicationService().listJournalProfiles(projectId);
  });
  ipcMain.handle("science:journals:inspectOfficialGuidelines", async (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:network");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-journal-guideline-input-invalid");
    const record = input as Record<string, unknown>;
    return scienceJournalPublicationService().inspectOfficialGuidelines({ projectId: String(record.projectId ?? ""), sourceUrl: String(record.sourceUrl ?? "") });
  });
  ipcMain.handle("science:journals:createProfile", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-journal-profile-input-invalid");
    return scienceJournalPublicationService().createJournalProfile(input as CreateScienceJournalProfileInput);
  });
  ipcMain.handle("science:journals:confirmIdentity", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-journal-identity-input-invalid");
    return scienceJournalPublicationService().confirmJournalIdentity(input as ConfirmScienceJournalIdentityInput);
  });
  ipcMain.handle("science:journals:confirmHumanAttestation", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-journal-attestation-input-invalid");
    return scienceJournalPublicationService().confirmHumanAttestation(input as ConfirmScienceJournalHumanAttestationInput);
  });
  ipcMain.handle("science:journals:validate", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-journal-validation-input-invalid");
    const record = input as Record<string, unknown>;
    const manuscript = scienceStore().getManuscriptForProject(String(record.projectId ?? ""), String(record.manuscriptId ?? ""));
    const profile = scienceStore().getJournalProfileForProject(String(record.projectId ?? ""), String(record.journalProfileId ?? ""));
    if (!manuscript || !profile) throw new Error("science-journal-validation-target-not-found");
    return scienceJournalPublicationService().validate(manuscript, profile, record.metadata as CreateScienceSubmissionExportInput["metadata"] | undefined,
      Array.isArray(record.humanAttestationReceiptIds) ? record.humanAttestationReceiptIds.map(String) : []);
  });
  ipcMain.handle("science:submissions:createExport", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-submission-export-input-invalid");
    return scienceJournalPublicationService().createSubmissionExport(input as CreateScienceSubmissionExportInput);
  });
  ipcMain.handle("science:submissions:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().listSubmissionExports(String(record.projectId ?? ""), String(record.manuscriptId ?? ""));
  });
  ipcMain.handle("science:submissions:read", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().submissionExportBytesForProject(String(record.projectId ?? ""), String(record.exportId ?? ""));
  });
  ipcMain.handle("science:analysisSpecs:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().listAnalysisSpecs(String(record.projectId ?? ""));
  });
  ipcMain.handle("science:analysisSpecs:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getAnalysisSpecForProject(String(record.projectId ?? ""), String(record.analysisSpecId ?? ""));
  });
  // Analysis-plan approval is a human authorization boundary. The MCP-visible freeze route can
  // only verify an already approved/frozen exact version; it cannot manufacture this receipt.
  ipcMain.handle("science:analysisSpecs:review", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: unknown }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-analysis-plan-review-input-invalid");
    return scienceStore().reviewAnalysisPlan(input as ReviewScienceAnalysisPlanInput);
  });
  ipcMain.handle("science:decisions:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const statuses = Array.isArray(record.statuses) ? record.statuses.map(String) as ScienceDecisionRequest["status"][] : undefined;
    const analysisSpecId = record.analysisSpecId === undefined || record.analysisSpecId === null || record.analysisSpecId === "" ? undefined : String(record.analysisSpecId);
    return scienceStore().listDecisionRequests(String(record.projectId ?? ""), analysisSpecId, statuses);
  });
  ipcMain.handle("science:decisions:get", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return scienceStore().getDecisionRequestForProject(String(record.projectId ?? ""), String(record.decisionId ?? ""));
  });
  ipcMain.handle("science:decisions:present", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceStore().presentDecision(input as PresentScienceDecisionInput);
  });
  ipcMain.handle("science:decisions:defer", (event, envelope: unknown) => {
    assertScienceSender(event, envelope, "science:agent-runtime");
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    return scienceStore().deferDecision(input as DeferScienceDecisionInput);
  });
  // Hypothesis authorization is the human half of the research loop. The AI-visible MCP route
  // records only evidence-derived states (proposed / supported / contradicted); `approved` and
  // `rejected` may be written solely here, from the verified Science view, so an agent cannot
  // authorize its own hypothesis. The successor revision stays immutable and version-fenced.
  ipcMain.handle("science:hypotheses:list", (event, input: unknown) => {
    assertScienceSender(event, input);
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const currentOnly = record.currentOnly === undefined ? true : record.currentOnly === true;
    return scienceStore().listHypotheses(String(record.projectId ?? ""), currentOnly);
  });
  ipcMain.handle("science:hypotheses:decide", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope
      ? (envelope as { input?: Record<string, unknown> }).input
      : null;
    if (!input || typeof input !== "object") throw new Error("science-hypothesis-decision-input-invalid");
    const decision = input.decision;
    if (decision !== "approved" && decision !== "rejected") throw new Error("science-hypothesis-decision-invalid");
    const parent = scienceStore().getHypothesisForProject(String(input.projectId ?? ""), String(input.hypothesisId ?? ""));
    if (!parent) throw new Error("science-hypothesis-not-found");
    // The decision succeeds the exact reviewed revision; the statement and falsification criteria
    // are carried over verbatim so a decision can never silently restate the hypothesis.
    return scienceStore().reviseHypothesis({
      requestId: String(input.requestId ?? ""),
      projectId: String(input.projectId ?? ""),
      parentHypothesisId: parent.id,
      expectedParentVersion: Number(input.expectedVersion),
      expectedParentContentSha256: String(input.expectedContentSha256 ?? ""),
      role: parent.role,
      status: decision,
      statement: parent.statement,
      rationale: typeof input.rationale === "string" && input.rationale.trim()
        ? input.rationale
        : parent.rationale,
      falsificationCriteria: parent.falsificationCriteria,
      evidenceSpanIds: parent.evidenceSpanIds,
      episodeResultIds: parent.episodeResultIds,
    } as ReviseScienceHypothesisInput);
  });
  ipcMain.handle("science:decisions:answer", (event, envelope: unknown) => {
    assertScienceSender(event, envelope);
    const input = envelope && typeof envelope === "object" && "input" in envelope ? (envelope as { input?: unknown }).input : null;
    if (!input || typeof input !== "object") throw new Error("science-decision-answer-input-invalid");
    return scienceStore().answerDecision(input as AnswerScienceDecisionInput);
  });
  disposeMobileBridgeStateChange = onMobileBridgeStateChanged((reason) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send("mobileBridge:changed", { reason });
    }
  });
  // 스토어 변경을 렌더러에 방송한다 — 폴링을 못 없애는 이유였던 "메인이 안 쏨"을
  // 여기서 해소한다. 페이로드는 change-bus 계약 그대로 {entity, id}뿐이다.
  onDesktopStoreChange((change) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send("store:changed", change);
    }
  });
  setCurrentUiLocale(resolveMenuLocale());
  applyAppMenu(resolveMenuLocale());
  ipcMain.handle("menu:setLocale", (_e, locale: unknown) => {
    const nextLocale = resolveMenuLocale(typeof locale === "string" ? locale : undefined);
    setCurrentUiLocale(nextLocale);
    applyAppMenu(nextLocale);
  });
  shellReadyForWindows = true;
  // Agentlas OS is independently releaseable. Desktop immediately runs from
  // the newer of its immutable bundle and managed runtime, then starts the
  // digest-verified updater in the background. Offline machines keep the
  // bundle; successful updates atomically switch ~/.agentlas/runtime/current.
  try {
    await startHephaestusRuntimeAutoUpdate();
  } catch (err) {
    console.error("[hephaestus] Agentlas OS auto-update bootstrap failed:", err);
  }
  traceStartup("os-updater-started");
  // A session can expire by TTL or be rejected by the server while every
  // renderer remains mounted. Switch the bookmark authority boundary and
  // account UI immediately instead of waiting for a future focus event.
  disposeAuthSessionInvalidation = onAuthSessionInvalidated(() => {
    // Losing a session is not evidence the account changed. Reconciling here
    // revokes nothing while signed out; the bridge simply stops serving until
    // the user signs back in. Wiping on plain TTL expiry is what left this
    // machine with 39 of 39 paired devices revoked and zero usable.
    reconcileMobileBridgeDevicesForAccount(userDataDir());
    failCloseActiveHubBookmarks();
    broadcastHubBookmarkSnapshot();
    broadcastSignedOutSession();
    void syncHubBookmarks({ rerunIfBusy: true });
  });
  // Continuity verification is complete. Persisted cards are display cache,
  // not fresh invocation authority, so revoke callable bits before any normal
  // renderer is created; live startup sync may promote exact records again.
  failCloseActiveHubBookmarks();
  traceStartup("hub-cache-closed");
  // Agentlas 아키텍처 — PM 소울/메모리 큐레이터/태스크 편향 큐레이터를 설치에 항상 동봉.
  // 버전 게이팅이라 평상시엔 거의 no-op. ARCHITECTURE_VERSION이 오르면 프롬프트만 재동기화.
  try {
    seedBuiltinAgents();
  } catch (err) {
    console.error("[architecture] seedBuiltinAgents failed:", err);
  }
  try {
    repairAllRootChatSurfaceControllers();
  } catch (err) {
    console.error("[architecture] surface controller repair failed:", err);
  }
  traceStartup("builtins-ready");
  // single/team 종류 backfill — entity_kind가 빈 기존 설치 행을 route.kind/이름 표식으로 한 번 채운다.
  // 이래야 Hub로 설치된 팀이 "개별 에이전트"로 오분류되지 않는다.
  try {
    backfillEntityKinds();
  } catch (err) {
    console.error("[architecture] backfillEntityKinds failed:", err);
  }
  traceStartup("entity-kinds-ready");
  // 설치된 에이전트 폴더의 파일을 보장 — 라이브러리 우측 패널이 즉시 보여줄 수 있게.
  if (process.env.AGENTLAS_QA_SKIP_AGENT_MATERIALIZATION !== "1") {
    materializeAllAgents();
  }
  traceStartup("agent-files-ready");
  // 레거시 학습 정합(정의 해시 backfill·중복 병합·큐레이션 후보 최대 2,000행
  // 스캔·에이전트 아키텍처 마이그레이션)은 첫 화면이 필요로 하지 않는 일회성
  // 유지보수다. 창 생성 앞에서 콜드 스타트를 수 초 늘리고 있었으므로 창이 뜬 뒤로
  // 미룬다(runDeferredLegacyLearningReconciliation). 멱등이라 이번 실행에서
  // 못 돌면 다음 실행이 이어받는다.
  const runDeferredLegacyLearningReconciliation = () => {
    // ★ 단계마다 따로 감싼다. 예전에는 전부 한 try 안이었고 catch 가 삼켰다 — 앞 단계
    //   하나가 던지면 그 뒤가 통째로 안 돌았다. 특히 `migrateRegisteredAgents` 는 업데이트가
    //   등록된 모든 에이전트에 도달하는 유일한 통로라, 조용히 죽으면 새 아키텍처가 영영
    //   닿지 않는다(실측 2026-08-26). 한 단계의 실패가 나머지를 막지 않아야 한다.
    const step = <T,>(name: string, run: () => T): T | null => {
      try {
        return run();
      } catch (err) {
        console.error(`[experience] ${name} 단계 실패 (나머지는 계속 진행):`, err);
        return null;
      }
    };
    try {
      const definitions = step("route-definition-backfill", backfillLegacyLocalRouteDefinitionHashes)
        ?? { updated: 0, failed: 0 };
      const duplicates = step("dedupe-local-agents", dedupeLocalInstalledAgents)
        ?? { groups: 0, merged: 0 };
      const experience = step("experience-reconcile", () => reconcileExistingCuratedMemoryCandidates())
        ?? { scanned: 0, candidateCreated: 0, blocked: 0, skipped: 0, deferred: 0 };
      /*
       * 등록된 모든 에이전트를 현재 아키텍처로 올린다.
       *
       * 업데이트는 새 아키텍처를 가져오지만 이미 등록된 에이전트는 옛 상태로 남는다 — 그래서
       * 오래 쓴 에이전트일수록 새 기능이 비어 있었다(실측: 913회 실행에 경험 칩 0). 원장이
       * (에이전트 × 단계)라 새 단계는 설치 시점과 무관하게 전원에게 한 번씩 돈다.
       */
      const migrated = step("architecture-migrations", migrateRegisteredAgents) ?? { stepsRun: 0 };
      if (migrated.stepsRun > 0) {
        console.log("[architecture] migrated registered agents", migrated);
      }
      if (definitions.updated > 0 || duplicates.merged > 0 || experience.candidateCreated > 0 || experience.blocked > 0) {
        console.log("[experience] reconciled legacy local learning", {
          definitionHashesUpdated: definitions.updated,
          definitionHashFailures: definitions.failed,
          localDuplicateGroups: duplicates.groups,
          localDuplicatesMerged: duplicates.merged,
          memoriesScanned: experience.scanned,
          candidatesCreated: experience.candidateCreated,
          privacyBlocked: experience.blocked,
          skipped: experience.skipped,
          deferred: experience.deferred,
        });
      }
    } catch (err) {
      console.error("[experience] legacy learning reconciliation failed:", err);
    }
  };
  try {
    const browserRecovery = await recoverAgentlasBrowserRuntimeAtStartup();
    if (browserRecovery.rootsClosed > 0 || browserRecovery.staleLocksRemoved > 0) {
      console.warn("[agentlas-browser] recovered stale automation browser at startup", browserRecovery);
    }
  } catch (error) {
    console.error("[agentlas-browser] startup recovery failed", error);
  }
  startBrowserOrphanSweep();
  materializeBuiltinPlugins();
  ensureDefaultMcpPluginsInstalled();
  // 승인된 브라우저 로그인은 앱이 뜰 때 한 번 스스로 최신이 된다(주기 미도래면 즉시 반환).
  // 창을 띄우기 전에 붙들지 않는다 — 자격증명 갱신 때문에 앱이 늦게 뜨면 안 된다.
  void import("./browser/credential-sync")
    .then(({ refreshBrowserCredentialsIfDue }) => refreshBrowserCredentialsIfDue())
    .catch(() => { /* 갱신 실패는 시작을 막지 않는다 */ });
  traceStartup("local-data-ready");
  // Provider CLI updates are main-owned and independent of the Dashboard
  // renderer. This starts after the store/bootstrap gates so the maintenance
  // slot can safely defer while a chat or automation is active.
  startCliRuntimeAutoUpdate();
  // The customer window is the startup boundary. Optional network-backed
  // services below (Mobile Bridge, Telegram workers, browser helpers) restore
  // independently and must never keep a healthy local Desktop invisible.
  if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
  else await loadMainRendererIntoWindow();
  traceStartup("window-loaded");
  // 누가 어떤 버전을 쓰는지 서버가 알게 한다(1.0.31·32 크래시 때 영향 범위를 셀 수 없었다).
  startInstallBeacon(installIdentity.channel);
  // 창이 뜨고 초기 렌더러 IPC가 가라앉은 뒤에 레거시 정합을 돌린다.
  setTimeout(runDeferredLegacyLearningReconciliation, 3_000);
  startOneBriefingScheduler();
  startOneTeamNotificationBridge();
  /*
   * Establish the daemon before choosing the physical Mobile Bridge owner.
   * Previously Desktop opened its listener first and `ensureDaemonRunning`
   * happened later on an unrelated promise. agentlasd then opened a second
   * listener for the same user-data and whichever process wrote endpoint.json
   * last silently redirected newly paired phones away from the other one.
   */
  const daemonStartupPromise = import("./daemon/app-launcher")
    .then(async (module) => {
      const outcome = await module.ensureDaemonRunning({
        userDataDir: userDataDir(),
        appVersion: app.getVersion(),
        parentPid: process.pid,
        installIdentity,
      });
      if (outcome.status === "failed") console.error("[daemon] ensure failed:", outcome.reason);
      else console.info(`[daemon] ${outcome.status}`);
      try {
        const { setDaemonAutostartEnabled } = await import("./store/daemon-autostart");
        setDaemonAutostartEnabled(false);
        const reconciled = module.reconcileDaemonAutostart(false, {
          executable: process.execPath,
          entry: path.join(__dirname, "daemon", "main.js"),
        });
        if (reconciled.changed) {
          console.info(`[daemon] autostart ${reconciled.installed ? "installed" : "removed"}`);
        }
        const { disableLaunchd } = await import("./launchd/agent");
        const legacyAutomationLauncher = disableLaunchd();
        if (legacyAutomationLauncher.error) {
          console.error("[automation] legacy background launcher cleanup failed:", legacyAutomationLauncher.error);
        }
      } catch (err) {
        console.error("[daemon] autostart reconcile failed:", err);
      }
      return { module, outcome };
    })
    .catch((error) => {
      console.error("[daemon] launcher wiring failed:", error);
      return null;
    });
  // Start only after update continuity and store bootstrap have passed. A
  // bridge failure must not make Desktop unusable; Settings exposes the exact
  // failure and can retry on the next launch.
  const startMobileBridgeAfterAuth = async (requireSignedIn = false) => {
    if (!shellReadyForWindows || (requireSignedIn && !getAuthSession().signedIn)) return;
    const daemon = await daemonStartupPromise;
    let claimed = false;
    try {
      if (!shellReadyForWindows || (requireSignedIn && !getAuthSession().signedIn)) return;
      if (daemon && daemon.outcome.status !== "disabled" && daemon.outcome.status !== "failed") {
        claimed = await daemon.module.claimDaemonMobileBridge(userDataDir(), process.pid);
        if (!claimed) {
          // The daemon still owns a healthy listener. Opening a fallback here
          // would recreate the two-authority split; leave Mobile service on the
          // daemon and expose the failed handoff instead.
          throw new Error("Agentlas daemon did not grant Mobile Bridge ownership");
        }
        daemonMobileBridgeClaimed = true;
      }
      if (!shellReadyForWindows || (requireSignedIn && !getAuthSession().signedIn)) {
        if (claimed && daemon) {
          daemonMobileBridgeClaimed = false;
          await daemon.module.releaseDaemonMobileBridge(userDataDir(), process.pid);
        }
        return;
      }
      await startAgentlasMobileBridge({
        userDataPath: userDataDir(),
        appVersion: app.getVersion(),
      });
    } catch (err) {
      if (claimed && daemon) {
        daemonMobileBridgeClaimed = false;
        await daemon.module.releaseDaemonMobileBridge(userDataDir(), process.pid).catch(() => false);
      }
      console.error("[mobile-bridge] start failed:", err);
    }
  };
  let explicitBridgeRestore: Promise<void> | null = null;
  disposeAuthSessionRestoration = onAuthSessionRestored((sessionSnapshot) => {
    if (!shellReadyForWindows || !sessionSnapshot.signedIn || !getAuthSession().signedIn) return;
    reconcileMobileBridgeDevicesForAccount(userDataDir());
    failCloseActiveHubBookmarks();
    broadcastAuthSession(sessionSnapshot);
    broadcastHubBookmarkSnapshot();
    void syncHubBookmarks({ rerunIfBusy: true });
    if (mobileBridgeRuntimeStatus().running || explicitBridgeRestore) return;
    const started = startMobileBridgeAfterAuth(true);
    explicitBridgeRestore = started;
    void started.then(() => { if (explicitBridgeRestore === started) explicitBridgeRestore = null; },
      () => { if (explicitBridgeRestore === started) explicitBridgeRestore = null; });
  });
  if (initialAuthRestoreWasUnavailable && !deferredAuthRestorePromise) {
    // Temporary authentication recovery intentionally owns the next action.
    // Never let an unknown initial Keychain state start the bridge, which would treat it
    // as a logout and revoke every stored device pairing.
    console.warn("[mobile-bridge] start skipped; initial account restore is unavailable");
  } else if (deferredAuthRestorePromise) {
    void deferredAuthRestorePromise.then((result) => {
      if (result.status === "temporarily-unavailable" || result.status === "native-unavailable") {
        // Starting while auth is unknown would make Mobile Bridge interpret a
        // temporary Keychain miss as logout and revoke every paired device.
        console.warn("[mobile-bridge] start deferred; account restore is still temporarily unavailable");
        return;
      }
      return startMobileBridgeAfterAuth();
    });
  } else {
    void startMobileBridgeAfterAuth();
  }
  // Browser 승인 서버 — continuity gate가 닫힌 뒤에만 로컬 작업 서버를 연다.
  void startBrowserApprovalServer().catch((err) =>
    console.error("[browser] approval server failed:", err),
  );
  void startComputerUseControlServer().catch((err) =>
    console.error("[computer-use] control server failed:", err),
  );
  // MCP 프록시 승인 서버 — 벤더 훅이 없거나 발화하지 않는 런타임에서 도구 관문이 된다.
  // 이게 떠 있을 때만 설정 생성기가 서버를 프록시로 감싼다(mcp-config.ts mcpProxySpec).
  void startMcpProxyApprovalServer().catch((err) =>
    console.error("[mcp] proxy approval server failed:", err),
  );
  // Accepted directions are resumed only after runtime/bootstrap gates are
  // ready. Recovering immediately after SQLite open would convert a healthy
  // queued turn into a permanent failed row merely because auth/plugins had
  // not finished restoring yet.
  try {
    const recoveredSteers = invocationService.recoverQueuedSteers();
    if (recoveredSteers > 0) console.info(`[invocation] recovered ${recoveredSteers} queued steer(s)`);
  } catch (error) {
    console.error("[invocation] queued steer recovery failed", error);
  }
  try {
    const scienceStatus = scienceExtensionStatus();
    if (scienceStatus.phase === "installed" && scienceStatus.enabled) {
      ensureScienceTurnProjection();
      const recovered = await recoverScienceRuntimeAtStartup();
      const recoveredTools = recovered.tools;
      if (recoveredTools.interrupted || recoveredTools.finalized || recoveredTools.alreadyCommitted || recoveredTools.quarantined) {
        console.info(`[science-tools] recovered interrupted=${recoveredTools.interrupted} finalized=${recoveredTools.finalized} committed=${recoveredTools.alreadyCommitted} quarantined=${recoveredTools.quarantined}`);
      }
      const recoveredScience = recovered.conversations;
      if (recovered.pausedLoops > 0) console.info(`[science-runtime] paused ${recovered.pausedLoops} loop(s) for explicit crash recovery`);
      if (recoveredScience.delivered || recoveredScience.dispatched || recoveredScience.settled || recoveredScience.interrupted) {
        console.info(`[science-runtime] recovered delivered=${recoveredScience.delivered} dispatched=${recoveredScience.dispatched} settled=${recoveredScience.settled} interrupted=${recoveredScience.interrupted}`);
      }
    }
  } catch (error) {
    console.error("[science-runtime] recovery failed", error);
  }
  startAutomationScheduler(); // 자동화 스케줄러 — 60초마다 due 자동화를 백그라운드로 실행
  void import("./telegram/connect")
    .then(({ reconcileTelegramWorkers }) => {
      if (!shellReadyForWindows) return;
      return reconcileTelegramWorkers();
    })
    .catch((err) => console.error("[telegram] worker restore failed:", err));
  // 유휴 드리밍 큐레이션 — 옵트인(기본 OFF). 5분마다 조건만 확인(유휴/슬롯/쿨다운), 발화는 드묾.
  try {
    const { startDreamingScheduler, ensureDreamingDefault } = await import("./memory/dreaming");
    // Measured 2026-08-11: default-OFF opt-in meant decay never ran anywhere.
    // Recover installs that never chose; an explicit user choice is untouched.
    ensureDreamingDefault();
    startDreamingScheduler();
  } catch (err) {
    console.error("[dreaming] scheduler start failed:", err);
  }
  // 조건 트리거 매니저(설계 §3) — fs 변경/체인 완료 이벤트를 리스너에 등록(유휴 0).
  // 헤드리스 러너에서는 등록하지 않는다(위 early-return 분기). 스케줄러의 실행 함수를 주입.
  try {
    const { startTriggerManager } = await import("./triggers/manager");
    const { runAutomationFromTrigger } = await import("./automation-scheduler");
    startTriggerManager((id, ctx, hooks) => runAutomationFromTrigger(id, ctx, hooks));
  } catch (err) {
    console.error("[triggers] startTriggerManager failed:", err);
  }
  // Hephaestus 로컬 등록 자동 반영 — 어느 런타임에서 빌드했든 trusted local 카드의
  // 패키지를 라이브러리로 (시작 시 소급 드레인 + desktop-sync/pending 감시).
  try {
    const { startHephaestusSync } = await import("./agents/hephaestus-sync");
    startHephaestusSync();
  } catch (err) {
    console.error("[hephaestus-sync] start failed:", err);
  }
  // One 은 Desktop 밖(Claude Code·터미널 등)에서도 돌기 때문에 기억의 권위가 파일 계층에 있다.
  // 부팅 때 그 서랍의 durable 을 memory_entries 로 반입한다. 멱등이며 실패해도 부팅을 막지 않는다.
  try {
    const { importOneDurableMemory, startOneImportScheduler } = await import("./memory/one-import");
    const outcome = importOneDurableMemory();
    if (outcome.imported > 0 || outcome.failed > 0) {
      console.log(
        `[one-import] scanned=${outcome.scanned} imported=${outcome.imported} ` +
        `skipped=${outcome.skipped} failed=${outcome.failed}`,
      );
    }
    // Boot-only import measured a 73-block backlog while the app stayed open —
    // re-import when the soul file actually changes (cheap mtime watch).
    startOneImportScheduler();
  } catch (err) {
    console.error("[one-import] failed:", err);
  }
  // Warm the account-isolated Hub bookmark cache after auth restore. This is
  // intentionally non-blocking; AppShell also triggers/subscribes on mount so
  // a renderer that was not ready for this first broadcast still reconciles.
  void syncHubBookmarks();
  // Startup got all the way here, so the one-shot post-update repair is spent
  // and must be re-armed. Without this the auto-repair would fire exactly once
  // in the app's lifetime and then stay disabled by its own leftover marker.
  noteHealthyStartup();
  traceUpdaterStartup("healthy-startup");
}).catch(async (error) => {
  traceUpdaterStartup("startup-promise-rejected");
  let handled = false;
  try {
    handled = await handleUpdaterBootstrapFailure(error);
  } catch (recoveryError) {
    console.error("[updater] native recovery fallback failed", recoveryError);
  }
  if (handled) return;
  if (lastStartupNavigationFailure && lastStartupNavigationFailure.kind !== "unexpected") {
    console.warn(`[startup][${lastStartupNavigationFailure.kind}] renderer startup boundary stopped`);
    app.exit(1);
    return;
  }
  console.error("[main] startup failed", error);
  if (startupStage === "store-opening") {
    const recoveryStarted = await recoverDesktopStartup({
      error,
      locale: resolveMenuLocale(),
      present: presentStartupRecovery,
      retry: async () => {
        initStore();
        app.relaunch();
        app.exit(0);
      },
    });
    if (recoveryStarted) return;
    // No connected One runtime reached a judgment. Keep the recovery layout
    // alive instead of turning an operational-store failure into a dead app.
    return;
  }
  app.exit(1);
});

/** OS 로케일 또는 렌더러가 통지한 표시 언어를 ko/en으로 정규화. */
function resolveMenuLocale(pref?: string): "ko" | "en" {
  const v = (pref ?? app.getLocale() ?? "en").toLowerCase();
  return v.startsWith("ko") ? "ko" : "en";
}


/** 주어진 언어로 네이티브 메뉴를 다시 빌드해 적용. */
function applyAppMenu(locale: "ko" | "en"): void {
  Menu.setApplicationMenu(buildAppMenu(() => mainWindow, locale));
}
