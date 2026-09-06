// macOS 메뉴바 — Agentlas 메뉴 + 표준 Edit/View/Window 메뉴.
//
// 데스크톱은 오픈소스 무료지만, 사용자가 Agentlas 웹과 연결하고 싶을 때 진입점.
// 메뉴는 OS-native라 사용자가 자연스럽게 찾아옴 (앱 안 별도 버튼 안 만들어도 됨).
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { checkSafely as updaterCheck, getUpdaterState } from "./updater";
import { credentialRecoveryMenuItems } from "./secrets/recovery-menu";

const WEB_BASE = "https://agentlas.cloud";

/** "Check for Updates Now…" — 사용자가 강제 발화. 현재 버전, 상태, 결과를 다이얼로그로 보고.
 *  electron-updater는 NODE_ENV=production일 때만 의미 있음 (dev/QA는 skip). */
async function checkUpdatesInteractive(parent: BrowserWindow | null): Promise<void> {
  const currentVersion = app.getVersion();
  if (process.env.NODE_ENV === "development") {
    await dialog.showMessageBox(parent ?? undefined!, {
      type: "info",
      title: "Updates",
      message: `Agentlas v${currentVersion} (dev build)`,
      detail: "Auto-update is disabled in development mode. Run a packaged build to test updates.",
    });
    return;
  }
  await updaterCheck();
  // 상태가 broadcast로 갱신되니 잠깐 대기 후 스냅샷
  await new Promise((r) => setTimeout(r, 800));
  const state = getUpdaterState();
  let message: string;
  let detail: string;
  switch (state.status) {
    case "available":
      message = "Update available";
      detail = `New version v${state.version} is downloading. You'll see a "Restart to update" badge when it's ready.`;
      break;
    case "downloading":
      message = "Downloading update…";
      detail = `v${state.version ?? "?"} — ${state.progress ?? 0}%`;
      break;
    case "downloaded":
      message = "Update ready";
      detail = `v${state.version} is ready. Click the badge in the top-right to restart and install.`;
      break;
    case "not-available":
      message = `You're up to date`;
      detail = `Agentlas v${currentVersion} is the latest published version.`;
      break;
    case "error":
      message = "Couldn't check for updates";
      detail = state.error || "Unknown error. Check Console.app for [updater] logs.";
      break;
    case "checking":
      message = "Still checking…";
      detail = `Try again in a few seconds. Current: v${currentVersion}.`;
      break;
    default:
      message = `Agentlas v${currentVersion}`;
      detail = "Auto-update hasn't completed its first check yet (15s after launch). Try again shortly.";
  }
  await dialog.showMessageBox(parent ?? undefined!, {
    type: state.status === "error" ? "warning" : "info",
    title: "Updates",
    message,
    detail,
  });
}

/**
 * Zoom is a property of the window as the person sees it, not of one web contents inside it.
 *
 * Product extensions (Science, the Hub profile, the Work live view) are child views of the same
 * window, each with its own zoom. Electron's built-in zoom roles act on the *focused* contents,
 * so zooming while the pointer sat over Science and then reaching for "Actual Size" reset the
 * shell and left Science enlarged -- and Chromium persists that factor per origin, so it came
 * back on the next launch with no way to undo it. Measured: shell 1.5 -> 1, Science stuck at 1.5.
 *
 * Applying every zoom command to the window and all of its child views keeps them in step, which
 * is what "the screen is too big" means to the person holding the mouse.
 */
function everyContents(win: BrowserWindow | null) {
  if (!win) return [];
  const all = [win.webContents];
  const walk = (view: { children?: unknown[]; webContents?: Electron.WebContents }) => {
    for (const child of (view.children ?? []) as { children?: unknown[]; webContents?: Electron.WebContents }[]) {
      if (child.webContents && !child.webContents.isDestroyed()) all.push(child.webContents);
      walk(child);
    }
  };
  walk(win.contentView as unknown as { children?: unknown[] });
  return all;
}

function applyZoom(win: BrowserWindow | null, next: (current: number) => number) {
  const contents = everyContents(win);
  if (!contents.length) return;
  // One level for all of them, taken from the window, so a view that drifted is pulled back into
  // line rather than stepped from wherever it happened to be.
  const base = contents[0].getZoomLevel();
  const level = Math.max(-5, Math.min(5, next(base)));
  for (const target of contents) {
    try { target.setZoomLevel(level); } catch { /* view went away mid-command */ }
  }
}

function send(win: BrowserWindow | null, route: string) {
  if (!win) return;
  // renderer dev: localhost:3100, prod: file:// — 둘 다 hash 경로로 라우팅 안 하고
  // postMessage IPC 패턴 대신 webContents.send로 메뉴 액션 전달
  win.webContents.send("menu:navigate", route);
}

type MenuLocale = "ko" | "en";

/** 네이티브 메뉴 라벨 — 쉬운 한국어 우선. role 항목(undo/copy/minimize 등)은
 *  macOS가 OS 언어로 자동 번역하므로 여기서 다루지 않는다. */
function menuLabels(locale: MenuLocale) {
  const en = {
    aboutApp: "About Agentlas",
    checkUpdates: "Check for Updates…",
    signIn: "Sign in to Agentlas…",
    openWeb: "Open Agentlas Web",
    preferences: "Preferences…",
    appMenu: "Agentlas",
    newChat: "New Project",
    marketplace: "Marketplace",
    installedApps: "Installed Apps",
    globalEnv: "Global Env",
    plugins: "Plugins",
    automations: "Automations",
    buildOnWeb: "Build Agent on Web",
    myAgentsWeb: "My agents on Web",
    edit: "Edit",
    view: "View",
    toggleSidebar: "Toggle Sidebar",
    actualSize: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    window: "Window",
    docs: "Agentlas Docs",
    reportIssue: "Report an Issue",
    shortcuts: "Keyboard Shortcuts",
  };
  const ko: typeof en = {
    aboutApp: "Agentlas 정보",
    checkUpdates: "업데이트 확인…",
    signIn: "Agentlas 로그인…",
    openWeb: "Agentlas 웹 열기",
    preferences: "설정…",
    appMenu: "Agentlas",
    newChat: "새 프로젝트",
    marketplace: "마켓",
    installedApps: "설치된 앱",
    globalEnv: "연결 키",
    plugins: "외부 도구",
    automations: "자동화",
    buildOnWeb: "웹에서 에이전트 만들기",
    myAgentsWeb: "웹에서 내 에이전트 보기",
    edit: "편집",
    view: "보기",
    toggleSidebar: "사이드바 보이기/숨기기",
    actualSize: "원래 크기로",
    zoomIn: "크게",
    zoomOut: "작게",
    window: "창",
    docs: "Agentlas 사용 설명서",
    reportIssue: "문제 신고하기",
    shortcuts: "키보드 단축키",
  };
  return locale === "ko" ? ko : en;
}

export function buildAppMenu(
  getWindow: () => BrowserWindow | null,
  locale: MenuLocale = "en",
): Menu {
  const isMac = process.platform === "darwin";
  const L = menuLabels(locale);

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS 첫 번째는 App 메뉴 (앱 이름 자동 표시)
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: "about" as const, label: L.aboutApp },
              {
                label: L.checkUpdates,
                click: () => void checkUpdatesInteractive(getWindow()),
              },
              { type: "separator" as const },
              {
                label: L.signIn,
                accelerator: "Shift+CmdOrCtrl+L",
                click: () => {
                  // V1: OAuth device flow. V0: 웹 사인인 페이지 열고 사용자 안내.
                  void shell.openExternal(`${WEB_BASE}/account?signin=1&redirectTo=/workspace`);
                },
              },
              {
                label: L.openWeb,
                click: () => void shell.openExternal(WEB_BASE),
              },
              { type: "separator" as const },
              {
                label: L.preferences,
                accelerator: "CmdOrCtrl+,",
                click: () => send(getWindow(), "/settings"),
              },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),

    // Agentlas 도메인 메뉴 — 어디서나 접근 가능
    {
      label: L.appMenu,
      submenu: [
        {
          label: L.newChat,
          accelerator: "CmdOrCtrl+N",
          click: () => send(getWindow(), "/project/new"),
        },
        { type: "separator" },
        {
          label: L.marketplace,
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => send(getWindow(), "/marketplace"),
        },
        {
          label: L.installedApps,
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => send(getWindow(), "/apps"),
        },
        {
          label: L.globalEnv,
          click: () => send(getWindow(), "/library/env"),
        },
        {
          label: L.plugins,
          click: () => send(getWindow(), "/library/mcps"),
        },
        {
          label: L.automations,
          click: () => send(getWindow(), "/automation"),
        },
        { type: "separator" },
        {
          label: L.signIn,
          click: () => void shell.openExternal(`${WEB_BASE}/account?signin=1&redirectTo=/workspace`),
        },
        {
          label: L.openWeb,
          click: () => void shell.openExternal(WEB_BASE),
        },
        {
          label: L.buildOnWeb,
          click: () => void shell.openExternal(`${WEB_BASE}/build`),
        },
        {
          label: L.myAgentsWeb,
          click: () => void shell.openExternal(`${WEB_BASE}/cargo`),
        },
      ],
    },

    // Edit
    {
      label: L.edit,
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },

    // View
    {
      label: L.view,
      submenu: [
        {
          label: L.toggleSidebar,
          accelerator: "CmdOrCtrl+[",
          click: () => send(getWindow(), "__toggle_sidebar__"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: L.actualSize,
          accelerator: "CmdOrCtrl+0",
          click: () => applyZoom(getWindow(), () => 0),
        },
        {
          label: L.zoomIn,
          accelerator: "CmdOrCtrl+Plus",
          click: () => applyZoom(getWindow(), (current) => current + 0.5),
        },
        {
          label: L.zoomOut,
          accelerator: "CmdOrCtrl+-",
          click: () => applyZoom(getWindow(), (current) => current - 0.5),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    // Window
    {
      label: L.window,
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? ([{ type: "separator" }, { role: "front" }] as const)
          : ([{ role: "close" }] as const)),
      ],
    },

    // Help
    {
      role: "help",
      submenu: [
        ...credentialRecoveryMenuItems(getWindow, locale),
        { type: "separator" },
        {
          label: L.checkUpdates,
          click: () => void checkUpdatesInteractive(getWindow()),
        },
        { type: "separator" },
        {
          label: L.docs,
          click: () => void shell.openExternal(`${WEB_BASE}/docs`),
        },
        {
          label: L.reportIssue,
          click: () => void shell.openExternal("mailto:appbridge@appbridge.co.kr?subject=Agentlas%20Desktop%20Issue"),
        },
        {
          label: L.shortcuts,
          accelerator: "CmdOrCtrl+/",
          click: () => send(getWindow(), "__show_shortcuts__"),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
