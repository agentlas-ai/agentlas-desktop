import path from "node:path";
import { promises as fs } from "node:fs";
import { app, dialog, session } from "electron";
import type { FoundInPageResult, WebContents } from "electron";
import { listBrowserSites } from "../store/browser-vault";
import {
  NATIVE_BROWSER_PARTITION,
  listWorkBrowserTabs,
  nativeBrowserGuest,
  nativeBrowserGuestDocument,
  nativeBrowserTaskOwner,
} from "../work-live-view";
import {
  browserDownloadAction,
  clearBrowserDownloadHistory,
  listBrowserDownloads,
} from "./download-registry";
import { clearBrowserHistory, listBrowserHistory } from "./history-registry";
import {
  BROWSER_UI_SCHEMA_VERSION,
  type BrowserClearDataResult,
  type BrowserDeviceEmulationResult,
  type BrowserDevicePreset,
  type BrowserFindResult,
  type BrowserHistoryEntry,
  type BrowserNativeSessionReadiness,
  type BrowserUiResult,
  type BrowserUiTarget,
  type BrowserZoomResult,
} from "../../shared/browser-ui";

const FIND_TIMEOUT_MS = 2_000;
const PRINT_TIMEOUT_MS = 60_000;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const findRequests = new Map<string, number>();
const DEVICE_PRESETS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 3 },
  tablet: { width: 820, height: 1_180, deviceScaleFactor: 2 },
} as const;
const deviceStates = new Map<string, {
  webContentsId: number;
  preset: BrowserDevicePreset;
}>();

function targetKey(ownerId: number, target: BrowserUiTarget): string {
  return `${ownerId}:${target.taskScopeId}:${target.viewId}`;
}

function guest(ownerId: number, target: BrowserUiTarget): WebContents | null {
  return nativeBrowserGuest(ownerId, target.taskScopeId, target.viewId);
}

function invalidTarget(target: BrowserUiTarget): boolean {
  return !target || !/^[A-Za-z0-9_-]{8,80}$/u.test(String(target.viewId ?? ""))
    || !/^[A-Za-z0-9_:.-]{8,200}$/u.test(String(target.taskScopeId ?? ""));
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, max);
}

export async function browserNativeSessionReadiness(): Promise<BrowserNativeSessionReadiness> {
  const checkedAt = new Date().toISOString();
  let connectSessionCount: number | null = null;
  let nativeCookieCount: number | null = null;
  try { connectSessionCount = listBrowserSites().filter((site) => site.session.status === "valid").length; }
  catch {
    return { schemaVersion: BROWSER_UI_SCHEMA_VERSION, state: "unknown", connectSessionCount, nativeCookieCount, checkedAt, reason: "store-unavailable" };
  }
  try {
    // Values stay inside Main and are immediately discarded. The renderer receives counts only.
    nativeCookieCount = (await session.fromPartition(NATIVE_BROWSER_PARTITION).cookies.get({})).length;
  } catch {
    return { schemaVersion: BROWSER_UI_SCHEMA_VERSION, state: "unknown", connectSessionCount, nativeCookieCount, checkedAt, reason: "session-unavailable" };
  }
  return {
    schemaVersion: BROWSER_UI_SCHEMA_VERSION,
    state: connectSessionCount === 0 && nativeCookieCount === 0 ? "confirmed-empty" : "ready",
    connectSessionCount,
    nativeCookieCount,
    checkedAt,
  };
}

export async function findBrowserText(ownerId: number, input: BrowserUiTarget & {
  query: string;
  forward?: boolean;
  findNext?: boolean;
}): Promise<BrowserFindResult> {
  if (invalidTarget(input)) return { ok: false, reason: "invalid-request" };
  const contents = guest(ownerId, input);
  if (!contents) return { ok: false, reason: "guest-unavailable" };
  const query = boundedText(input.query, 512).trim();
  if (!query) {
    contents.stopFindInPage("clearSelection");
    findRequests.delete(targetKey(ownerId, input));
    return { ok: true, matches: 0, activeMatch: 0, finalUpdate: true };
  }
  const key = targetKey(ownerId, input);
  const prior = findRequests.get(key);
  const document = nativeBrowserGuestDocument(ownerId, input.taskScopeId, input.viewId);
  if (!document || document.state !== "ready") return { ok: false, reason: "guest-unavailable" };
  return new Promise((resolve) => {
    let settled = false;
    let requestId = 0;
    const finish = (result: BrowserFindResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.removeListener("found-in-page", onFound);
      resolve(result);
    };
    const onFound = (_event: Electron.Event, result: FoundInPageResult) => {
      if (result.requestId !== requestId || findRequests.get(key) !== requestId) return;
      if (result.finalUpdate) finish({
        ok: true,
        requestId,
        matches: Math.max(0, result.matches),
        activeMatch: Math.max(0, result.activeMatchOrdinal),
        finalUpdate: true,
        measurement: "native",
      });
    };
    const timer = setTimeout(() => {
      const current = nativeBrowserGuestDocument(ownerId, input.taskScopeId, input.viewId);
      if (!current || current.webContentsId !== document.webContentsId
        || current.navigationEpoch !== document.navigationEpoch || current.state !== "ready") {
        finish({ ok: false, reason: "guest-unavailable" });
        return;
      }
      const encodedQuery = JSON.stringify(query.toLocaleLowerCase());
      void contents.executeJavaScript(`(() => {
        const limit = 1000000;
        const source = String(document.body?.innerText ?? "").toLocaleLowerCase();
        const text = source.slice(0, limit);
        const query = ${encodedQuery};
        let matches = 0;
        let offset = 0;
        while (query && (offset = text.indexOf(query, offset)) >= 0) {
          matches += 1;
          offset += query.length;
        }
        return { matches, truncated: source.length > limit };
      })()`, true).then((count: { matches?: unknown; truncated?: unknown }) => {
        const latest = nativeBrowserGuestDocument(ownerId, input.taskScopeId, input.viewId);
        if (!latest || latest.webContentsId !== document.webContentsId
          || latest.navigationEpoch !== document.navigationEpoch || latest.state !== "ready") {
          finish({ ok: false, reason: "guest-unavailable" });
          return;
        }
        const matches = Number.isSafeInteger(count?.matches) && Number(count.matches) >= 0 ? Number(count.matches) : 0;
        finish({ ok: true, requestId, matches, activeMatch: matches > 0 ? 1 : 0,
          finalUpdate: false, measurement: "bounded-dom-count", countTruncated: count?.truncated === true });
      }).catch(() => finish({ ok: false, reason: "operation-failed" }));
    }, FIND_TIMEOUT_MS);
    contents.on("found-in-page", onFound);
    try {
      requestId = contents.findInPage(query, {
        forward: input.forward !== false,
        findNext: input.findNext === true && prior !== undefined,
      });
      findRequests.set(key, requestId);
    } catch {
      finish({ ok: false, reason: "operation-failed" });
    }
  });
}

export function stopBrowserFind(ownerId: number, input: BrowserUiTarget & {
  action?: "clearSelection" | "keepSelection" | "activateSelection";
}): BrowserUiResult {
  if (invalidTarget(input)) return { ok: false, reason: "invalid-request" };
  const contents = guest(ownerId, input);
  if (!contents) return { ok: false, reason: "guest-unavailable" };
  const action = input.action ?? "clearSelection";
  if (!["clearSelection", "keepSelection", "activateSelection"].includes(action)) return { ok: false, reason: "invalid-request" };
  try {
    contents.stopFindInPage(action);
    findRequests.delete(targetKey(ownerId, input));
    return { ok: true };
  } catch { return { ok: false, reason: "operation-failed" }; }
}

export function changeBrowserZoom(ownerId: number, input: BrowserUiTarget & {
  action: "get" | "in" | "out" | "reset";
}): BrowserZoomResult {
  if (invalidTarget(input) || !["get", "in", "out", "reset"].includes(input.action)) return { ok: false, reason: "invalid-request" };
  const contents = guest(ownerId, input);
  if (!contents) return { ok: false, reason: "guest-unavailable" };
  try {
    const current = contents.getZoomFactor();
    if (input.action === "get") return { ok: true, factor: current, percent: Math.round(current * 100) };
    let factor = 1;
    if (input.action === "in") factor = ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS.at(-1)!;
    else if (input.action === "out") factor = [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0];
    contents.setZoomFactor(factor);
    return { ok: true, factor, percent: Math.round(factor * 100) };
  } catch { return { ok: false, reason: "operation-failed" }; }
}

export function changeBrowserDeviceEmulation(ownerId: number, input: BrowserUiTarget & {
  preset: BrowserDevicePreset | "get";
}): BrowserDeviceEmulationResult {
  if (invalidTarget(input) || !["get", "off", "phone", "tablet"].includes(input.preset)) {
    return { ok: false, reason: "invalid-request" };
  }
  const contents = guest(ownerId, input);
  const document = nativeBrowserGuestDocument(ownerId, input.taskScopeId, input.viewId);
  if (!contents || !document || contents.id !== document.webContentsId) return { ok: false, reason: "guest-unavailable" };
  const key = targetKey(ownerId, input);
  const recorded = deviceStates.get(key);
  const currentPreset = recorded?.webContentsId === contents.id ? recorded.preset : "off";
  if (recorded && recorded.webContentsId !== contents.id) deviceStates.delete(key);
  if (input.preset === "get") {
    const dimensions = currentPreset === "phone" || currentPreset === "tablet" ? DEVICE_PRESETS[currentPreset] : null;
    return { ok: true, preset: currentPreset, width: dimensions?.width ?? null,
      height: dimensions?.height ?? null, deviceScaleFactor: dimensions?.deviceScaleFactor ?? null };
  }
  try {
    if (input.preset === "off") {
      contents.disableDeviceEmulation();
      deviceStates.set(key, { webContentsId: contents.id, preset: "off" });
      return { ok: true, preset: "off", width: null, height: null, deviceScaleFactor: null };
    }
    const dimensions = DEVICE_PRESETS[input.preset];
    contents.enableDeviceEmulation({
      screenPosition: "mobile",
      screenSize: { width: dimensions.width, height: dimensions.height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: dimensions.deviceScaleFactor,
      viewSize: { width: dimensions.width, height: dimensions.height },
      scale: 1,
    });
    deviceStates.set(key, { webContentsId: contents.id, preset: input.preset });
    return { ok: true, preset: input.preset, ...dimensions };
  } catch { return { ok: false, reason: "operation-failed" }; }
}

export function setBrowserDevTools(ownerId: number, input: BrowserUiTarget & { open: boolean }): BrowserUiResult {
  if (invalidTarget(input) || typeof input.open !== "boolean") return { ok: false, reason: "invalid-request" };
  const contents = guest(ownerId, input);
  if (!contents) return { ok: false, reason: "guest-unavailable" };
  try {
    if (input.open) contents.openDevTools({ mode: "detach", activate: true });
    else contents.closeDevTools();
    return { ok: true };
  } catch { return { ok: false, reason: "operation-failed" }; }
}

export function printBrowserPage(ownerId: number, input: BrowserUiTarget): Promise<BrowserUiResult> {
  if (invalidTarget(input)) return Promise.resolve({ ok: false, reason: "invalid-request" });
  const contents = guest(ownerId, input);
  if (!contents) return Promise.resolve({ ok: false, reason: "guest-unavailable" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BrowserUiResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "operation-failed" }), PRINT_TIMEOUT_MS);
    try { contents.print({ silent: false, printBackground: true }, (success) => finish(success ? { ok: true } : { ok: false, reason: "operation-failed" })); }
    catch { finish({ ok: false, reason: "operation-failed" }); }
  });
}

export async function saveBrowserScreenshot(ownerId: number, input: BrowserUiTarget): Promise<BrowserUiResult & { fileName?: string }> {
  if (invalidTarget(input)) return { ok: false, reason: "invalid-request" };
  const contents = guest(ownerId, input);
  if (!contents) return { ok: false, reason: "guest-unavailable" };
  try {
    const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) return { ok: false, reason: "operation-failed" };
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const chosen = await dialog.showSaveDialog({
      title: "Save browser screenshot",
      defaultPath: path.join(app.getPath("pictures"), `Agentlas-Browser-${stamp}.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (chosen.canceled || !chosen.filePath) return { ok: false, reason: "dialog-cancelled" };
    const filePath = chosen.filePath.toLowerCase().endsWith(".png") ? chosen.filePath : `${chosen.filePath}.png`;
    await fs.writeFile(filePath, image.toPNG(), { mode: 0o600 });
    return { ok: true, fileName: path.basename(filePath) };
  } catch { return { ok: false, reason: "operation-failed" }; }
}

export function browserTabHistory(ownerId: number, input: BrowserUiTarget & { limit?: number }): BrowserUiResult & { entries: BrowserHistoryEntry[] } {
  if (invalidTarget(input)) return { ok: false, reason: "invalid-request", entries: [] };
  const contents = guest(ownerId, input);
  if (!contents) return { ok: false, reason: "guest-unavailable", entries: [] };
  try {
    const history = contents.navigationHistory;
    const all = history.getAllEntries();
    const current = history.getActiveIndex();
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
    const start = Math.max(0, all.length - limit);
    const entries = all.slice(start).flatMap((entry, offset) => {
      let url: URL;
      try { url = new URL(entry.url); } catch { return []; }
      if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "about:")) return [];
      return [{ index: start + offset, url: url.toString(), title: boundedText(entry.title, 512), current: start + offset === current }];
    });
    return { ok: true, entries };
  } catch { return { ok: false, reason: "operation-failed", entries: [] }; }
}

export function browserAllTabHistory(ownerId: number, input: { taskScopeId: string; query?: string; limit?: number }): BrowserUiResult & { entries: import("../../shared/browser-ui").BrowserDurableHistoryEntry[] } {
  if (!/^[A-Za-z0-9_:.-]{8,200}$/u.test(String(input?.taskScopeId ?? ""))) return { ok: false, reason: "invalid-request", entries: [] };
  if (nativeBrowserTaskOwner(input.taskScopeId)?.ownerId !== ownerId) return { ok: false, reason: "guest-unavailable", entries: [] };
  const entries = listBrowserHistory(input.taskScopeId, input.query, input.limit);
  return entries ? { ok: true, entries } : { ok: false, reason: "history-unavailable", entries: [] };
}

export function browserDownloads(ownerId: number, input: { taskScopeId: string; limit?: number }) {
  if (!/^[A-Za-z0-9_:.-]{8,200}$/u.test(String(input?.taskScopeId ?? ""))) return { ok: false as const, reason: "invalid-request" as const, items: [] };
  if (nativeBrowserTaskOwner(input.taskScopeId)?.ownerId !== ownerId) {
    return { ok: false as const, reason: "guest-unavailable" as const, items: [] };
  }
  return { ok: true as const, items: listBrowserDownloads(ownerId, input.taskScopeId, input.limit) };
}

export function actOnBrowserDownload(ownerId: number, input: {
  taskScopeId: string;
  id: string;
  action: "cancel" | "open" | "show-in-folder" | "remove";
}) {
  if (!/^[A-Za-z0-9_:.-]{8,200}$/u.test(String(input?.taskScopeId ?? ""))
    || !/^download_[a-f0-9]{32}$/u.test(String(input?.id ?? ""))
    || !["cancel", "open", "show-in-folder", "remove"].includes(input.action)) {
    return Promise.resolve({ ok: false as const, reason: "invalid-request" as const });
  }
  if (nativeBrowserTaskOwner(input.taskScopeId)?.ownerId !== ownerId) {
    return Promise.resolve({ ok: false as const, reason: "guest-unavailable" as const });
  }
  return browserDownloadAction(ownerId, input.taskScopeId, input.id, input.action);
}

export async function clearBrowserData(ownerId: number, input: BrowserUiTarget & {
  categories: Array<"history" | "downloads" | "cache" | "cookies">;
}): Promise<BrowserClearDataResult> {
  if (invalidTarget(input) || !Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 4) {
    return { ok: false, reason: "invalid-request" };
  }
  const categories = [...new Set(input.categories)];
  if (categories.some((category) => !["history", "downloads", "cache", "cookies"].includes(category))) {
    return { ok: false, reason: "invalid-request" };
  }
  const contents = guest(ownerId, input);
  if (!contents) return { ok: false, reason: "guest-unavailable" };
  try {
    if (categories.includes("history")) {
      // The chooser promises task-wide history clearing, including native
      // back/forward entries in background tabs owned by this same window.
      for (const tab of listWorkBrowserTabs(ownerId, input.taskScopeId)) {
        const tabContents = nativeBrowserGuest(ownerId, input.taskScopeId, tab.viewId);
        if (tabContents && !tabContents.isDestroyed()) tabContents.navigationHistory.clear();
      }
      if (clearBrowserHistory(input.taskScopeId) === null) return { ok: false, reason: "history-unavailable" };
    }
    if (categories.includes("downloads")) clearBrowserDownloadHistory(ownerId, input.taskScopeId);
    if (categories.includes("cache")) await contents.session.clearCache();
    if (categories.includes("cookies")) await contents.session.clearStorageData({ storages: ["cookies"] });
    return { ok: true, cleared: categories };
  } catch { return { ok: false, reason: "operation-failed" }; }
}
