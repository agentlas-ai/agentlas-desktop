import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from "electron";
import type { IpcMainInvokeEvent, Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { OneWindowState } from "../shared/one-window";
import { configureAppControlInteractionValidator, isAppControlEvent, recordAppControlRendererEvent } from "./app-control/ipc-registry";

export const ONE_WINDOW_MIN_WIDTH = 380;
export const ONE_WINDOW_MIN_HEIGHT = 560;
const ROUTE = "/one?personal=1&companion=1";
const SHORTCUT = "CommandOrControl+Shift+Space";
interface SavedWindow { bounds: Rectangle; workArea?: Rectangle; displayId?: number; alwaysOnTop: boolean }
interface OneWindowHost { mainWindow(): BrowserWindow | null; showMain(route?: string): Promise<void>; quit(): void; locale(): "ko" | "en"; externalEffectsAllowed(): boolean }
let host: OneWindowHost | null = null;
let one: BrowserWindow | null = null;
let opening: Promise<BrowserWindow> | null = null;
let tray: Tray | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let shortcut: OneWindowState["shortcut"] = { registered: false };
let trayError: string | undefined;
let installed = false;
let lastSaved: SavedWindow | null = null;
export const oneOnlyLaunch = process.argv.includes("--one") || process.argv.includes("--one-only");
export function configureOneWindowHost(value: OneWindowHost): void {
  host = value;
  configureAppControlInteractionValidator(validateOneWindowSender);
}
export function getOneWindow(): BrowserWindow | null { return one && !one.isDestroyed() ? one : null; }
export function oneWindowRole(window: BrowserWindow): "main" | "one" | null {
  return window === getOneWindow() ? "one" : window === host?.mainWindow() ? "main" : null;
}
function stateFile(): string { return path.join(app.getPath("userData"), "one-window-v1.json"); }
function rectangle(value: unknown): value is Rectangle {
  const v = value as Rectangle | null;
  return !!v && [v.x, v.y, v.width, v.height].every(Number.isFinite) && v.width > 0 && v.height > 0;
}
function readSaved(): SavedWindow | null {
  try {
    const v = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as SavedWindow;
    if (!v || !rectangle(v.bounds) || typeof v.alwaysOnTop !== "boolean") return null;
    return { bounds: v.bounds, alwaysOnTop: v.alwaysOnTop,
      ...(rectangle(v.workArea) ? { workArea: v.workArea } : {}),
      ...(Number.isSafeInteger(v.displayId) ? { displayId: v.displayId } : {}) };
  } catch { return null; }
}
/** Electron bounds/workArea are DIP: never apply scaleFactor twice on mixed-DPI displays. */
export function clampOneWindowBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(workArea.width, Math.max(ONE_WINDOW_MIN_WIDTH, Math.round(bounds.width)));
  const height = Math.min(workArea.height, Math.max(ONE_WINDOW_MIN_HEIGHT, Math.round(bounds.height)));
  return { x: Math.max(workArea.x, Math.min(Math.round(bounds.x), workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(Math.round(bounds.y), workArea.y + workArea.height - height)), width, height };
}
function restoredBounds(saved: SavedWindow | null): Rectangle {
  const displays = screen.getAllDisplays();
  const display = displays.find(d => d.id === saved?.displayId)
    ?? (saved ? screen.getDisplayMatching(saved.bounds) : screen.getPrimaryDisplay());
  const area = display.workArea;
  let bounds = saved?.bounds ?? { x: area.x + area.width - 456 - 24, y: area.y + 24, width: 456, height: 760 };
  // Preserve the user's offset when a display moves in the virtual desktop layout.
  if (saved?.workArea && display.id === saved.displayId) bounds = { ...bounds,
    x: area.x + bounds.x - saved.workArea.x, y: area.y + bounds.y - saved.workArea.y };
  return clampOneWindowBounds(bounds, area);
}
function persist(): void {
  const window = getOneWindow();
  if (!window || window.isMinimized() || window.isMaximized()) return;
  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  lastSaved = { bounds, workArea: display.workArea, displayId: display.id, alwaysOnTop: window.isAlwaysOnTop() };
  try {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(lastSaved), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) { console.warn("[one-window] persistence failed", error); }
}
function queueSave(): void { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(persist, 200); }
function rendererUrl(taskId?: string): string {
  const base = !app.isPackaged && process.env.ELECTRON_START_URL || "agentlas://app";
  const url = new URL(ROUTE, base);
  if (taskId) url.searchParams.set("task", taskId);
  return url.href;
}
function trustedUrl(raw: string, role: "main" | "one"): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    const expected = new URL(!app.isPackaged && process.env.ELECTRON_START_URL || "agentlas://app");
    const originMatches = expected.protocol === "agentlas:"
      ? url.protocol === "agentlas:" && url.host === "app"
      : url.origin === expected.origin;
    return originMatches && (role === "main" || url.pathname.replace(/\/$/, "") === "/one"
      && url.searchParams.get("companion") === "1" && url.searchParams.get("personal") === "1");
  } catch { return false; }
}
function validateOneWindowSender(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  const role = window && oneWindowRole(window);
  if (!window || !role || window.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
    || !trustedUrl(event.senderFrame.url, role)) throw new Error("one-window-untrusted-sender");
  return window;
}
export function assertOneWindowSender(event: IpcMainInvokeEvent): BrowserWindow {
  const window = validateOneWindowSender(event);
  recordAppControlRendererEvent(event);
  return window;
}
// The companion can reach only its controllers. Each controller still validates
// its own arguments, grants, task ownership and user interaction requirements.
const ONE_CHANNEL_PREFIXES = ["oneWindow:", "oneContext:", "oneHarness:", "oneSupervisor:", "oneOrg:", "oneTaskforces:", "oneSearch:", "oneAttachments:", "oneArtifacts:",
  "oneProfile:", "oneFeatureIntro:", "oneActivation:", "oneMemory:", "oneSuggestions:", "oneHubDerivative:", "oneAutoRecovery:", "oneValueClosure:",
  "oneWeeklyReflection:", "oneExperienceReuse:", "oneImprovementProof:", "oneBriefing:", "oneRequestIntent:", "oneTeamPreflight:", "auth:", "config:", "runtime:", "usage:",
  "fs:", "chatFiles:", "chats:", "tasks:", "projects:", "invoke:", "confirm:", "attention:", "menu:", "media:",
  "browserUi:", "browser:", "browserScopes:", "browserAutofill:", "browserAnnotation:", "agentScreen:", "computerUse:",
  "mcpTools:", "mcp:supplyRunKeys", "vault:", "env:", "secrets:", "automations:", "schedule:", "agents:", "agentRuntime:", "skills:", "workStart:",
  "goalPanel:", "workLiveView:", "workspace:", "app:", "localModelHub:", "store:"];
export function assertOneWindowChannel(event: IpcMainInvokeEvent, channel: string): void {
  if (event.sender !== getOneWindow()?.webContents) return;
  assertOneWindowSender(event);
  // Host app-control has already decoded the selected operation and enforced its
  // policy. Only that live, real-event call can reach additional domain adapters.
  if (isAppControlEvent(event)) return;
  if (!ONE_CHANNEL_PREFIXES.some(prefix => channel.startsWith(prefix))) throw new Error("one-window-channel-denied");
}
export function getOneWindowState(role: "main" | "one" = "one"): OneWindowState {
  const window = getOneWindow();
  return { role, visible: !!window?.isVisible(), alwaysOnTop: window?.isAlwaysOnTop() ?? lastSaved?.alwaysOnTop ?? false,
    shortcut, tray: { visible: !!tray, ...(trayError ? { errorCode: trayError } : {}) },
    minWidth: ONE_WINDOW_MIN_WIDTH, minHeight: ONE_WINDOW_MIN_HEIGHT, bounds: window?.getBounds() ?? null };
}
function ensureTray(): void {
  if (tray) return;
  let icon = nativeImage.createFromPath(path.join(__dirname, "../../build-resources/icon-1024.png"));
  if (!icon.isEmpty()) icon = icon.resize({ width: process.platform === "win32" ? 16 : 18, height: process.platform === "win32" ? 16 : 18 });
  tray = new Tray(icon);
  tray.setToolTip("Agentlas One");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: host?.locale() === "ko" ? "One 열기" : "Open One", click: () => { void openOneWindow(); } },
    { label: host?.locale() === "ko" ? "Desktop 열기" : "Open Desktop", click: () => { void host?.showMain(); } },
    { type: "separator" },
    { label: host?.locale() === "ko" ? "완전히 종료" : "Quit completely", click: () => host?.quit() },
  ]));
  tray.on("click", () => { void openOneWindow(); });
}
function installShell(): void {
  if (installed) return;
  installed = true;
  try { shortcut = globalShortcut.register(SHORTCUT, () => { void openOneWindow(); })
    ? { registered: true } : { registered: false, errorCode: "shortcut-unavailable" }; }
  catch { shortcut = { registered: false, errorCode: "shortcut-registration-failed" }; }
  // A visible tray is also the recovery path after closing the only window.
  try { ensureTray(); } catch {
    trayError = "tray-unavailable";
    console.warn("[one-window] tray unavailable; use Dock or the window shortcut to reopen");
  }
  const clamp = () => {
    const window = getOneWindow();
    if (!window || window.isMaximized()) return;
    const bounds = window.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    window.setMinimumSize(Math.min(ONE_WINDOW_MIN_WIDTH, area.width), Math.min(ONE_WINDOW_MIN_HEIGHT, area.height));
    window.setBounds(clampOneWindowBounds(bounds, area));
    queueSave();
  };
  screen.on("display-removed", clamp);
  screen.on("display-metrics-changed", clamp);
  app.once("will-quit", () => { globalShortcut.unregister(SHORTCUT); tray?.destroy(); tray = null; if (saveTimer) clearTimeout(saveTimer); });
}
export async function openOneWindow(input: { taskId?: string; focus?: boolean } = {}): Promise<BrowserWindow> {
  await app.whenReady();
  installShell();
  if (opening) { await opening; return openOneWindow(input); }
  const current = getOneWindow();
  if (current) {
    if (input.taskId) current.webContents.send("menu:navigate", `${ROUTE}&task=${encodeURIComponent(input.taskId)}`);
    if (current.isMinimized()) current.restore();
    if (input.focus === false) current.showInactive(); else { current.show(); current.focus(); }
    return current;
  }
  opening = (async () => {
    const saved = readSaved();
    lastSaved = saved;
    const bounds = restoredBounds(saved);
    const window = new BrowserWindow({ ...bounds, minWidth: Math.min(ONE_WINDOW_MIN_WIDTH, bounds.width),
      minHeight: Math.min(ONE_WINDOW_MIN_HEIGHT, bounds.height), title: "Agentlas One", show: false,
      resizable: true, alwaysOnTop: saved?.alwaysOnTop ?? false, backgroundColor: "#ffffff", titleBarStyle: "hiddenInset",
      webPreferences: { preload: path.join(__dirname, "preload.js"), additionalArguments: ["--agentlas-window-role=one"],
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    one = window;
    window.on("page-title-updated", event => { event.preventDefault(); });
    window.on("move", queueSave);
    window.on("resize", queueSave);
    window.on("close", persist);
    window.on("closed", () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; if (one === window) one = null; });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (host?.externalEffectsAllowed() && /^https?:/.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => { if (!trustedUrl(url, "one")) event.preventDefault(); });
    window.webContents.on("context-menu", (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = params.isEditable
        ? [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }]
        : params.selectionText ? [{ role: "copy" }] : [];
      if (items.length) Menu.buildFromTemplate(items).popup({ window });
    });
    let crashes = 0;
    window.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit" && !window.isDestroyed() && ++crashes <= 2) window.webContents.reload();
    });
    try {
      await window.loadURL(rendererUrl(input.taskId));
      if (!window.isDestroyed()) { if (input.focus === false) window.showInactive(); else { window.show(); window.focus(); } }
      return window;
    } catch (error) { window.destroy(); throw error; }
  })();
  try { return await opening; } finally { opening = null; }
}
export function oneWindowShellActive(): boolean { return installed && (!!tray || shortcut.registered || process.platform === "darwin"); }
export function registerOneWindowIpc(): void {
  const register = (channel: string, action: (window: BrowserWindow, input: unknown) => unknown) =>
    ipcMain.handle(channel, (event, input) => action(assertOneWindowSender(event), input));
  const snapshot = (window: BrowserWindow) => getOneWindowState(oneWindowRole(window) ?? "main");
  const objectInput = (input: unknown, keys: string[]): Record<string, unknown> => {
    if (input === undefined) return {};
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !keys.includes(key))) throw new Error("one-window-invalid-input");
    return input as Record<string, unknown>;
  };
  register("oneWindow:getState", (window, input) => { objectInput(input, []); return snapshot(window); });
  register("oneWindow:open", async (window, input) => {
    const { taskId } = objectInput(input, ["taskId"]);
    if (taskId !== undefined && (typeof taskId !== "string" || !taskId.trim() || taskId.length > 200)) throw new Error("one-window-invalid-task");
    await openOneWindow({ taskId }); return snapshot(window);
  });
  register("oneWindow:hide", (window, input) => { objectInput(input, []); getOneWindow()?.hide(); return snapshot(window); });
  register("oneWindow:setAlwaysOnTop", (window, input) => {
    const { value } = objectInput(input, ["value"]);
    if (typeof value !== "boolean") throw new Error("one-window-invalid-pin");
    const companion = getOneWindow();
    if (!companion) throw new Error("one-window-closed");
    companion.setAlwaysOnTop(value); persist(); return snapshot(window);
  });
  register("oneWindow:showMain", async (window, input) => {
    const { route } = objectInput(input, ["route"]);
    if (route !== undefined && (typeof route !== "string" || !/^\/[A-Za-z0-9/_\-?=&%.:~]*$/.test(route) || route.length > 300)) throw new Error("one-window-invalid-route");
    if (!host) throw new Error("one-window-host-unavailable");
    await host.showMain(route as string | undefined); return snapshot(window);
  });
}
