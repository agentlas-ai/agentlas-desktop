/*
 * IPC for the conversation's automation view (chat live row, report summary, right-panel "자동화" tab).
 * Reads only; every answer is re-read from the store. The renderer refreshes on store:changed
 * {entity:"automation"} and on automations:liveRun:<id> tool events — no polling.
 *
 * Site icons: the renderer never contacts a site. Main fetches /favicon.ico from the public host the
 * automation itself already visited (no third-party icon service), bounded in size and time, and caches it.
 */
import { net, type IpcMain } from "electron";
import { isPublicHostname } from "../shared/automation-activity";
import { automationChatActivity, automationRunDigest, automationRunPage } from "./store/automation-chat-activity";

const ICON_MAX_BYTES = 64 * 1024;
const ICON_TIMEOUT_MS = 4_000;
const iconCache = new Map<string, string | null>();
const iconInFlight = new Map<string, Promise<string | null>>();

async function fetchSiteIcon(host: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICON_TIMEOUT_MS);
  try {
    const response = await net.fetch(`https://${host}/favicon.ico`, { signal: controller.signal, redirect: "follow", credentials: "omit" } as RequestInit);
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type && !type.startsWith("image/") && type !== "application/octet-stream") return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > ICON_MAX_BYTES) return null;
    const mime = type.startsWith("image/") ? type : "image/x-icon";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function siteIconDataUrl(rawHost: unknown): Promise<string | null> {
  const host = typeof rawHost === "string" ? rawHost.trim().toLowerCase().replace(/^www\./, "") : "";
  if (!isPublicHostname(host)) return Promise.resolve(null);
  if (iconCache.has(host)) return Promise.resolve(iconCache.get(host) ?? null);
  const pending = iconInFlight.get(host);
  if (pending) return pending;
  const next = fetchSiteIcon(host).then((value) => {
    iconCache.set(host, value);
    iconInFlight.delete(host);
    return value;
  });
  iconInFlight.set(host, next);
  return next;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

/** `ipc` is Main's IPC boundary (electron/development-effect-policy), the one every handler registers through. */
export function registerAutomationChatActivityIpc(ipcMain: Pick<IpcMain, "handle">): void {
  ipcMain.handle("automations:chatActivity", (_event, scope: unknown) => {
    const input = scope && typeof scope === "object" ? scope as Record<string, unknown> : {};
    return automationChatActivity({
      chatId: text(input.chatId),
      projectId: text(input.projectId),
      ...(typeof input.includeProject === "boolean" ? { includeProject: input.includeProject } : {}),
    });
  });
  ipcMain.handle("automations:runDigest", (_event, runId: unknown) => {
    const id = text(runId);
    return id ? automationRunDigest(id) : null;
  });
  ipcMain.handle("automations:runPage", (_event, automationId: unknown, options: unknown) => {
    const id = text(automationId);
    if (!id) return { automationId: "", runs: [], nextCursor: null };
    const input = options && typeof options === "object" ? options as Record<string, unknown> : {};
    return automationRunPage(id, { before: text(input.before), limit: typeof input.limit === "number" ? input.limit : undefined });
  });
  ipcMain.handle("automations:siteIcon", (_event, host: unknown) => siteIconDataUrl(host));
}
