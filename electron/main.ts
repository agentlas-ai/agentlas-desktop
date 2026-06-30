// Electron 진입점.
// dev:  ELECTRON_START_URL = http://localhost:3100 (Next.js dev server)
// prod: file://dist/renderer/index.html (next export 결과)
//
// 보안 원칙 — PRD 6.2:
// - contextIsolation: true
// - nodeIntegration: false
// - sandbox: true (renderer는 sandboxed)
// - 모든 Node API는 preload → ipc 경로로만 노출
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, protocol, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerIpcHandlers } from "./ipc";
import { buildAppMenu } from "./menu";
import { initStore } from "./store/db";
import { startAutomationScheduler, stopAutomationScheduler } from "./automation-scheduler";
import { initAutoUpdater, disposeAutoUpdater } from "./updater";
import { disposeAppFactoryLaunches } from "./app-factory/operations";
import { bootAuthFromKeychain } from "./auth";
import { materializeAllAgents } from "./agents/files";
import { seedBuiltinAgents } from "./architecture/seed";
import { ensureDefaultMcpPluginsInstalled } from "./mcp-tools/defaults";

const isDev = process.env.NODE_ENV === "development";

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

// macOS dock 표시 이름 — productName이 "Agentlas"인 production 빌드와 일치시킴
app.setName("Agentlas");

const qaUserDataDir = process.env.AGENTLAS_QA_USER_DATA_DIR?.trim();
if (qaUserDataDir) {
  fs.mkdirSync(qaUserDataDir, { recursive: true });
  app.setPath("userData", qaUserDataDir);
}

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

const LOCAL_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".svg",
  ".avif",
  ".bmp",
]);

// 인-앱 비디오 재생용 — 오베론 렌더/모션 출력(mp4 등)을 agentlas:// 로 서빙한다.
const LOCAL_VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);

function registerRendererProtocol(): void {
  protocol.handle("agentlas", (request) => {
    // 로컬 이미지 인라인 서빙 — agentlas://localfile/?p=<encoded abs path>.
    // 채팅에 에이전트가 생성한 이미지를 띄우기 위함 (webSecurity로 file:// 직접 로드는 차단됨).
    // 안전: 이미지 확장자 + 절대경로 + 실제 파일만 서빙.
    try {
      const url = new URL(request.url);
      if (url.hostname === "localfile") {
        const p = url.searchParams.get("p");
        if (p) {
          const abs = path.normalize(decodeURIComponent(p));
          const ext = path.extname(abs).toLowerCase();
          if (
            (LOCAL_IMAGE_EXTS.has(ext) || LOCAL_VIDEO_EXTS.has(ext)) &&
            path.isAbsolute(abs) &&
            fs.existsSync(abs) &&
            fs.statSync(abs).isFile()
          ) {
            // 비디오 재생을 위해 Range 요청을 전달(seek 지원); 이미지엔 무해.
            const range = request.headers.get("range");
            return net.fetch(pathToFileURL(abs).toString(), range ? { headers: { range } } : undefined);
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
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

// 앱 종료 정리 — 백그라운드 타이머/자식 프로세스를 누수 없이 거둔다(중복 등록 방지 플래그).
let quitCleanupDone = false;
app.on("before-quit", () => {
  if (quitCleanupDone) return;
  quitCleanupDone = true;
  try { stopAutomationScheduler(); } catch {}
  try { disposeAutoUpdater(); } catch {}
  try { disposeAppFactoryLaunches(); } catch {}
});

app.whenReady().then(async () => {
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
  ensureDefaultMcpPluginsInstalled();
  // Agentlas 아키텍처 — PM 소울/메모리 큐레이터/태스크 편향 큐레이터를 설치에 항상 동봉.
  // 버전 게이팅이라 평상시엔 거의 no-op. ARCHITECTURE_VERSION이 오르면 프롬프트만 재동기화.
  try {
    seedBuiltinAgents();
  } catch (err) {
    console.error("[architecture] seedBuiltinAgents failed:", err);
  }
  // 설치된 에이전트 폴더의 파일을 보장 — 라이브러리 우측 패널이 즉시 보여줄 수 있게.
  materializeAllAgents();
  // 키체인에서 저장된 세션 복원 — 메인 윈도우가 뜨자마자 getSession()이 정상 값을 반환하도록 await
  await bootAuthFromKeychain();
  registerIpcHandlers();
  startAutomationScheduler(); // 자동화 스케줄러 — 60초마다 due 자동화를 백그라운드로 실행
  await createWindow();
  // 네이티브 메뉴바도 인앱 언어 설정을 따른다. 초기값은 OS 로케일(app.getLocale),
  // 이후 렌더러가 menu:setLocale로 사용자 override를 통지하면 다시 그린다.
  applyAppMenu(resolveMenuLocale());
  ipcMain.handle("menu:setLocale", (_e, locale: unknown) => {
    applyAppMenu(resolveMenuLocale(typeof locale === "string" ? locale : undefined));
  });
  // 자동 업데이트는 production에서만. updater.ts 안에서 NODE_ENV 체크.
  initAutoUpdater();
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
