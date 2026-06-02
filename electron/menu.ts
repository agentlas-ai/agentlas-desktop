// macOS 메뉴바 — Agentlas 메뉴 + 표준 Edit/View/Window 메뉴.
//
// 데스크톱은 오픈소스 무료지만, 사용자가 Agentlas 웹과 연결하고 싶을 때 진입점.
// 메뉴는 OS-native라 사용자가 자연스럽게 찾아옴 (앱 안 별도 버튼 안 만들어도 됨).
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import { checkSafely as updaterCheck, getUpdaterState } from "./updater";

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

function send(win: BrowserWindow | null, route: string) {
  if (!win) return;
  // renderer dev: localhost:3100, prod: file:// — 둘 다 hash 경로로 라우팅 안 하고
  // postMessage IPC 패턴 대신 webContents.send로 메뉴 액션 전달
  win.webContents.send("menu:navigate", route);
}

export function buildAppMenu(getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS 첫 번째는 App 메뉴 (앱 이름 자동 표시)
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: "about" as const, label: "About Agentlas" },
              {
                label: "Check for Updates…",
                click: () => void checkUpdatesInteractive(getWindow()),
              },
              { type: "separator" as const },
              {
                label: "Sign in to Agentlas…",
                accelerator: "Shift+CmdOrCtrl+L",
                click: () => {
                  // V1: OAuth device flow. V0: 웹 사인인 페이지 열고 사용자 안내.
                  void shell.openExternal(`${WEB_BASE}/account?signin=1&redirectTo=/workspace`);
                },
              },
              {
                label: "Open Agentlas Web",
                click: () => void shell.openExternal(WEB_BASE),
              },
              { type: "separator" as const },
              {
                label: "Preferences…",
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
      label: "Agentlas",
      submenu: [
        {
          label: "New Chat",
          accelerator: "CmdOrCtrl+N",
          click: () => send(getWindow(), "/"),
        },
        { type: "separator" },
        {
          label: "Apps Store",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => send(getWindow(), "/marketplace"),
        },
        {
          label: "Installed Apps",
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => send(getWindow(), "/apps"),
        },
        {
          label: "Apps Vault",
          click: () => send(getWindow(), "/library/env"),
        },
        {
          label: "Apps Engines",
          click: () => send(getWindow(), "/library/mcps"),
        },
        {
          label: "Automations",
          click: () => send(getWindow(), "/automation"),
        },
        { type: "separator" },
        {
          label: "Sign in to Agentlas…",
          click: () => void shell.openExternal(`${WEB_BASE}/account?signin=1&redirectTo=/workspace`),
        },
        {
          label: "Open Agentlas Web",
          click: () => void shell.openExternal(WEB_BASE),
        },
        {
          label: "Build Agent on Web",
          click: () => void shell.openExternal(`${WEB_BASE}/build`),
        },
        {
          label: "My agents on Web",
          click: () => void shell.openExternal(`${WEB_BASE}/cargo`),
        },
      ],
    },

    // Edit
    {
      label: "Edit",
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
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+[",
          click: () => send(getWindow(), "__toggle_sidebar__"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    // Window
    {
      label: "Window",
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
        {
          label: "Check for Updates…",
          click: () => void checkUpdatesInteractive(getWindow()),
        },
        { type: "separator" },
        {
          label: "Agentlas Docs",
          click: () => void shell.openExternal(`${WEB_BASE}/docs`),
        },
        {
          label: "Report an Issue",
          click: () => void shell.openExternal("mailto:appbridge@appbridge.co.kr?subject=Agentlas%20Desktop%20Issue"),
        },
        {
          label: "Keyboard Shortcuts",
          accelerator: "CmdOrCtrl+/",
          click: () => send(getWindow(), "__show_shortcuts__"),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
