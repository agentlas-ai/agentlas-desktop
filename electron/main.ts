// Electron 진입점.
// dev:  ELECTRON_START_URL = http://localhost:3100 (Next.js dev server)
// prod: file://dist/renderer/index.html (next export 결과)
//
// 보안 원칙 — PRD 6.2:
// - contextIsolation: true
// - nodeIntegration: false
// - sandbox: true (renderer는 sandboxed)
// - 모든 Node API는 preload → ipc 경로로만 노출
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  protocol,
  session,
  shell,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  configureInstallIdentity,
  resolveInstallIdentity,
  type InstallIdentity,
} from "./install-identity";
import { registerIpcHandlers } from "./ipc";
import { buildAppMenu } from "./menu";
import { initStore } from "./store/db";
import { startAutomationScheduler, stopAutomationScheduler } from "./automation-scheduler";
import { claimOneBriefingDesktopNotification, configureOneBriefingRuntime } from "./one/briefing";
import { invocationService } from "./invocation/service";
import {
  disposeAutoUpdater,
  getUpdaterState,
  handleUpdaterBootstrapFailure,
  initAutoUpdater,
  onUpdaterStateChange,
  preflightUpdaterStartup,
  quitAndInstall as installDownloadedUpdate,
} from "./updater";
import { createAutomaticQuitInstaller } from "./updater/automatic-quit-install";
import { scrubInactiveUpdaterRecoveryOpenCrabCredentialUrls } from "./updater/continuity";
import { disposeAppFactoryLaunches } from "./app-factory/operations";
import { disposeSiteAgentAppRuntimes } from "./site/agent-app-runtime";
import { bootAuthFromKeychain, getAuthSession, onAuthSessionInvalidated } from "./auth";
import {
  broadcastHubBookmarkSnapshot,
  failCloseActiveHubBookmarks,
  syncHubBookmarks,
} from "./hub-bookmark-sync";
import { materializeAllAgents } from "./agents/files";
import { backfillEntityKinds } from "./mcp/registry";
import { reconcileLocalRouteDefinitionHashes } from "./agents/routes";
import { reconcileExistingCuratedMemoryCandidates } from "./experience/store";
import { seedBuiltinAgents } from "./architecture/seed";
import { ensureDefaultMcpPluginsInstalled } from "./mcp-tools/defaults";
import { startHephaestusRuntimeAutoUpdate } from "./hephaestus/engine";
import { scrubLegacyOpenCrabMcpConfig } from "./mcp-tools/mcp-config";
import { scrubLegacyOpenCrabCredentialUrls } from "./mcp-tools/registry";
import { startBrowserApprovalServer, stopBrowserApprovalServer } from "./browser/approval-server";
import { startComputerUseControlServer, stopComputerUseControlServer } from "./computer-use/control-server";
import { authorizeLocalMediaPath } from "./fs/access";
import { serveOneArtifactProtocolRequest } from "./one/artifact-preview";
import { reconcileOneHubDerivativeDraftStorage } from "./one/hub-derivative";
import { initFileLogging, mainLogFilePath } from "./logging";
import { setCurrentUiLocale } from "./ui-locale";
import {
  issueMobileBridgePairing,
  listMobileBridgeDevices,
  mobileBridgeRuntimeStatus,
  onMobileBridgeStateChanged,
  revokeAllMobileBridgeDevicesForAuthChange,
  revokeMobileBridgeDevice,
  retryAgentlasMobileBridge,
  startAgentlasMobileBridge,
  stopAgentlasMobileBridge,
} from "./mobile-bridge/runtime";

export { currentUiLocale } from "./ui-locale";

const isDev = process.env.NODE_ENV === "development";
const AUTH_SESSION_CHANGED_CHANNEL = "auth:sessionChanged";
let disposeAuthSessionInvalidation: (() => void) | null = null;
let disposeMobileBridgeStateChange: (() => void) | null = null;

function broadcastSignedOutSession(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send(AUTH_SESSION_CHANGED_CHANNEL, { signedIn: false });
      } catch {
        // A renderer may disappear while the main-process auth boundary runs.
      }
    }
  }
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
      ?? (identity.channel === "local-candidate"
        ? path.join(app.getPath("appData"), identity.userDataNamespace)
        : null);
    if (userDataDir) {
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      app.setPath("userData", userDataDir);
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

/**
 * macOS dock 아이콘 — dev에서는 Electron 기본(원자 모양) 대신 우리 paw squircle.
 * production 빌드는 electron-builder가 .icns로 bundling하므로 이 경로는 dev 전용.
 * (whenReady 이후에 setIcon 호출 — 그 전에는 dock 핸들이 unstable)
 */
function applyDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) return;
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

let mainWindow: BrowserWindow | null = null;
let shellReadyForWindows = false;
let oneBriefingLaunchTimer: NodeJS.Timeout | null = null;
let oneBriefingInterval: NodeJS.Timeout | null = null;

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
    const notification = new Notification({
      title: "Agentlas One",
      body: "One found something that may need your attention. Open Agentlas to review it.",
      silent: true,
    });
    notification.on("click", () => { void openOneFromNotification(); });
    notification.show();
  } catch (error) {
    console.warn("[one-briefing] desktop notification check failed", error);
  }
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
const singleInstanceLock = allowMultiInstance || app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.exit(0);
}

app.on("second-instance", () => {
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
  const staticAssetIndex = segments.findIndex((segment) => segment === "_next" || segment === "brand");
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
    return (
      Boolean(relative) &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    );
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

async function createWindow(): Promise<void> {
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

  mainWindow.once("ready-to-show", () => mainWindow?.show());

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
    const allowed = url.startsWith("agentlas://") || (isDev && startUrl ? url.startsWith(startUrl) : false);
    if (allowed) return;
    event.preventDefault();
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
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

  if (isDev && startUrl) {
    await mainWindow.loadURL(startUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadURL("agentlas://app/index.html");
  }
}

app.on("window-all-closed", () => {
  // macOS first — 마지막 윈도우가 닫혀도 dock에 남아있는 게 표준
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (!shellReadyForWindows) return;
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

// 앱 종료 정리 — 백그라운드 타이머/자식 프로세스를 누수 없이 거둔다.
// 자동 업데이트는 renderer 창이 모두 닫힌 will-quit에서만 연기하므로, continuity
// 캡처 뒤 renderer IPC write가 새로 들어올 수 없다.
let quitCleanupDone = false;
let quitServicesStopPromise: Promise<void> | null = null;
let systemShutdownInProgress = false;
let systemShutdownResetTimer: NodeJS.Timeout | null = null;

function stopQuitServices(): Promise<void> {
  if (quitServicesStopPromise) return quitServicesStopPromise;
  shellReadyForWindows = false;
  try { stopAutomationScheduler(); } catch {}
  try { stopOneBriefingScheduler(); } catch {}
  try { stopBrowserApprovalServer(); } catch {}
  try { stopComputerUseControlServer(); } catch {}
  try { disposeAppFactoryLaunches(); } catch {}
  try { disposeSiteAgentAppRuntimes(); } catch {}
  try { disposeAuthSessionInvalidation?.(); } catch {}
  disposeAuthSessionInvalidation = null;
  try { disposeMobileBridgeStateChange?.(); } catch {}
  disposeMobileBridgeStateChange = null;

  quitServicesStopPromise = Promise.all([
    import("./triggers/manager").then((module) => { module.stopTriggerManager(); }).catch(() => {}),
    import("./telegram/connect").then((module) => { module.stopTelegramWorkers(); }).catch(() => {}),
    import("./agents/hephaestus-sync").then((module) => { module.stopHephaestusSync(); }).catch(() => {}),
    stopAgentlasMobileBridge().catch((error) => {
      console.error("[mobile-bridge] shutdown failed", error);
    }),
  ]).then(() => undefined);
  return quitServicesStopPromise;
}

async function prepareAutomaticUpdateQuit(): Promise<void> {
  await stopQuitServices();
  // An active invocation can still write its terminal receipt after renderer
  // windows close. In that case preserve normal quit semantics and defer the
  // update until a later idle quit instead of snapshotting a moving database.
  if (invocationService.activeChatIds().length > 0) {
    throw new Error("Active invocation prevented update continuity capture");
  }
}

function finishQuitCleanup(): void {
  if (quitCleanupDone) return;
  quitCleanupDone = true;
  void stopQuitServices().catch(() => {});
  try { disposeAutoUpdater(); } catch {}
}

const automaticQuitInstaller = createAutomaticQuitInstaller({
  getState: getUpdaterState,
  prepare: prepareAutomaticUpdateQuit,
  install: installDownloadedUpdate,
  quit: () => app.quit(),
  subscribe: onUpdaterStateChange,
  shouldInstallOnQuit: () => !systemShutdownInProgress && invocationService.activeChatIds().length === 0,
  logger: console,
});
electronAutoUpdater.on("before-quit-for-update", () => {
  automaticQuitInstaller.authorizeNativeQuit();
});
app.on("will-quit", (event) => {
  // electron-updater's raw auto-install-on-quit path is intentionally disabled:
  // it cannot capture Agentlas continuity first. Defer this first quit, run the
  // controller's full verified transaction, then allow the native updater's
  // second quit through after state advances to `installing`.
  if (automaticQuitInstaller.handle(event)) return;
  finishQuitCleanup();
});

app.whenReady().then(async () => {
  // Before any other stage: a packaged app discards console output, so start
  // mirroring it to the platform log directory first. Updater and mobile-bridge
  // diagnostics are worthless if the only copy dies with the process.
  initFileLogging();
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
  // ── 헤드리스 자동화 러너 진입점(설계 §2.6) ─────────────────────
  // launchd LaunchAgent가 `--headless-automations` 플래그로 이 바이너리를 coarse 인터벌마다
  // poke한다. 창을 만들지 않고 due 자동화를 1회 실행한 뒤 종료한다. 러너는 이미 렌더러를
  // 안 건드리므로(sink no-op) 엔진 전체를 그대로 재사용한다. (full launchd 설치는 P1.)
  if (process.argv.includes("--headless-automations")) {
    if (updatePreflight.pendingInstall) {
      // The GUI launch owns post-migration continuity review. Never let a
      // background runner mutate a just-updated store first.
      app.quit();
      return;
    }
    try {
      initStore();
      ensureDefaultMcpPluginsInstalled();
      await startHephaestusRuntimeAutoUpdate();
      const openCrabScrub = scrubLegacyOpenCrabCredentialUrls();
      if (openCrabScrub.scrubbed > 0) {
        console.warn(`[opencrab] disabled and scrubbed ${openCrabScrub.scrubbed} legacy credential URL row(s)`);
      }
      const { runDueAutomationsNow, runAutomationFromTrigger } = await import("./automation-scheduler");
      await runDueAutomationsNow();
      // Events accepted by a previous GUI session live in the SQLite outbox.
      // A headless wake drains a bounded batch too; atomic event + automation
      // leases make this safe if the GUI is concurrently active.
      const { drainTriggerOutboxOnce } = await import("./triggers/outbox");
      await drainTriggerOutboxOnce((id, ctx, hooks) => runAutomationFromTrigger(id, ctx, hooks));
    } catch (err) {
      console.error("[headless-automations] failed:", err);
    } finally {
      app.quit();
    }
    return;
  }

  registerRendererProtocol();
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
  initStore();
  try {
    reconcileOneHubDerivativeDraftStorage();
  } catch (error) {
    // Corrupt state or unsafe ancestry stays untouched and disables this
    // review-only path; application startup must not overwrite or delete it.
    console.error("[one-hub-derivative] startup reconciliation blocked:", error);
  }
  // Restore/decrypt the account before the post-migration continuity check.
  await bootAuthFromKeychain();
  // Stage 2 (post-migration, pre-bootstrap-writers): compare the live DB and
  // managed assets against the recovery copies. Recovery-required stops here.
  if (installIdentity.updatesEnabled) {
    await initAutoUpdater();
  }
  if (getUpdaterState().status !== "recovery-required") {
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
        userDataPath: app.getPath("userData"),
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
  disposeMobileBridgeStateChange = onMobileBridgeStateChanged((reason) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send("mobileBridge:changed", { reason });
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
  if (getUpdaterState().status === "recovery-required") {
    await createWindow();
    return;
  }
  // Agentlas OS is independently releaseable. Desktop immediately runs from
  // the newer of its immutable bundle and managed runtime, then starts the
  // digest-verified updater in the background. Offline machines keep the
  // bundle; successful updates atomically switch ~/.agentlas/runtime/current.
  try {
    await startHephaestusRuntimeAutoUpdate();
  } catch (err) {
    console.error("[hephaestus] Agentlas OS auto-update bootstrap failed:", err);
  }
  // A session can expire by TTL or be rejected by the server while every
  // renderer remains mounted. Switch the bookmark authority boundary and
  // account UI immediately instead of waiting for a future focus event.
  disposeAuthSessionInvalidation = onAuthSessionInvalidated(() => {
    revokeAllMobileBridgeDevicesForAuthChange(app.getPath("userData"));
    failCloseActiveHubBookmarks();
    broadcastHubBookmarkSnapshot();
    broadcastSignedOutSession();
    void syncHubBookmarks({ rerunIfBusy: true });
  });
  // Continuity verification is complete. Persisted cards are display cache,
  // not fresh invocation authority, so revoke callable bits before any normal
  // renderer is created; live startup sync may promote exact records again.
  failCloseActiveHubBookmarks();
  // Agentlas 아키텍처 — PM 소울/메모리 큐레이터/태스크 편향 큐레이터를 설치에 항상 동봉.
  // 버전 게이팅이라 평상시엔 거의 no-op. ARCHITECTURE_VERSION이 오르면 프롬프트만 재동기화.
  try {
    seedBuiltinAgents();
  } catch (err) {
    console.error("[architecture] seedBuiltinAgents failed:", err);
  }
  // single/team 종류 backfill — entity_kind가 빈 기존 설치 행을 route.kind/이름 표식으로 한 번 채운다.
  // 이래야 Hub로 설치된 팀이 "개별 에이전트"로 오분류되지 않는다.
  try {
    backfillEntityKinds();
  } catch (err) {
    console.error("[architecture] backfillEntityKinds failed:", err);
  }
  // 설치된 에이전트 폴더의 파일을 보장 — 라이브러리 우측 패널이 즉시 보여줄 수 있게.
  if (process.env.AGENTLAS_QA_SKIP_AGENT_MATERIALIZATION !== "1") {
    materializeAllAgents();
  }
  try {
    const definitions = reconcileLocalRouteDefinitionHashes();
    const experience = reconcileExistingCuratedMemoryCandidates();
    if (definitions.updated > 0 || experience.candidateCreated > 0 || experience.blocked > 0) {
      console.log("[experience] reconciled legacy local learning", {
        definitionHashesUpdated: definitions.updated,
        definitionHashFailures: definitions.failed,
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
  ensureDefaultMcpPluginsInstalled();
  // Start only after update continuity and store bootstrap have passed. A
  // bridge failure must not make Desktop unusable; Settings exposes the exact
  // failure and can retry on the next launch.
  try {
    await startAgentlasMobileBridge({
      userDataPath: app.getPath("userData"),
      appVersion: app.getVersion(),
    });
  } catch (err) {
    console.error("[mobile-bridge] start failed:", err);
  }
  // Browser 승인 서버 — continuity gate가 닫힌 뒤에만 로컬 작업 서버를 연다.
  void startBrowserApprovalServer().catch((err) =>
    console.error("[browser] approval server failed:", err),
  );
  void startComputerUseControlServer().catch((err) =>
    console.error("[computer-use] control server failed:", err),
  );
  startAutomationScheduler(); // 자동화 스케줄러 — 60초마다 due 자동화를 백그라운드로 실행
  try {
    const { reconcileTelegramWorkers } = await import("./telegram/connect");
    await reconcileTelegramWorkers();
  } catch (err) {
    console.error("[telegram] worker restore failed:", err);
  }
  // 유휴 드리밍 큐레이션 — 옵트인(기본 OFF). 5분마다 조건만 확인(유휴/슬롯/쿨다운), 발화는 드묾.
  try {
    const { startDreamingScheduler } = await import("./memory/dreaming");
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
  await createWindow();
  startOneBriefingScheduler();
  // Warm the account-isolated Hub bookmark cache after auth restore. This is
  // intentionally non-blocking; AppShell also triggers/subscribes on mount so
  // a renderer that was not ready for this first broadcast still reconciles.
  void syncHubBookmarks();
}).catch(async (error) => {
  let handled = false;
  try {
    handled = await handleUpdaterBootstrapFailure(error);
  } catch (recoveryError) {
    console.error("[updater] native recovery fallback failed", recoveryError);
  }
  if (!handled) console.error("[main] startup failed", error);
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
