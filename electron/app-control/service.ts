import type { BrowserWindow } from "electron";
import { APP_CONTROL_CATALOG, type AppControlCatalogEntry, type AppControlInvokeArg } from "./catalog.generated";
import { AppControlError, appControlHandlerRegistered, invokeAppControlIpc } from "./ipc-registry";
import { appControlEffectNeedsOwnerTurn, appControlPolicy, type AppControlEffect } from "./policy";

// One's app-control route: find an operation, then call it as the owner's own screens would. The catalog is generated
// from the preload bridges; ./policy decides what One may call and on which turns.

export interface AppControlHost {
  mainWindow(): BrowserWindow | null;
  scienceInstalled(): boolean;
}

export interface AppControlCaller {
  /** A turn the owner wrote (not a review or check-in the host started). */
  ownerTurn: boolean;
}

interface Operation {
  path: string;
  surface: "desktop" | "science" | "app";
  params: string[];
  signature: string;
  doc: string;
  effect: AppControlEffect;
  entry?: AppControlCatalogEntry;
}

const RESULT_LIMIT = 24_000;
const SCIENCE_EXTENSION_ID = "agentlas-science";

let host: AppControlHost | null = null;
export function configureAppControlHost(next: AppControlHost): void {
  host = next;
}

// Operations that are not one IPC call: they act on the window itself.
const HOST_OPERATIONS: Operation[] = [
  { path: "app.navigate", surface: "app", params: ["route"], signature: "(route: string)", effect: "consent",
    doc: "Open a screen in the owner's Agentlas window, e.g. \"/settings\", \"/automation\", \"/library\", \"/marketplace\", \"/local-models\", \"/one\". Moves the owner's view, so only when they ask." },
  { path: "app.setLanguage", surface: "app", params: ["locale"], signature: "(locale: \"ko\" | \"en\" | \"system\")", effect: "write",
    doc: "Set the app's display language, the same setting as Settings > Language." },
];

function scienceInstalled(): boolean {
  try { return host?.scienceInstalled() ?? false; } catch { return false; }
}

function operations(): Operation[] {
  const science = scienceInstalled();
  const fromCatalog: Operation[] = [];
  for (const entry of APP_CONTROL_CATALOG) {
    if (entry.surface === "science" && !science) continue;
    const policy = appControlPolicy(entry);
    if (!policy.allowed) continue;
    fromCatalog.push({ path: entry.path, surface: entry.surface, params: entry.params, signature: entry.signature, doc: entry.doc, effect: policy.effect, entry });
  }
  return [...HOST_OPERATIONS, ...fromCatalog];
}

const words = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);

export function appControlOperations(input: { query?: unknown; area?: unknown; limit?: unknown }): {
  science_installed: boolean; areas?: Array<{ area: string; operations: number }>; operations?: Array<Record<string, unknown>>; total: number;
} {
  const all = operations();
  const science = scienceInstalled();
  const area = typeof input.area === "string" ? input.area.trim() : "";
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 200) : "";
  if (!area && !query) {
    const counts = new Map<string, number>();
    for (const operation of all) {
      const key = operation.surface === "science" ? operation.path.split(".").slice(0, 2).join(".") : operation.path.split(".")[0];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return { science_installed: science, total: all.length,
      areas: [...counts].map(([key, count]) => ({ area: key, operations: count })).sort((a, b) => a.area.localeCompare(b.area)) };
  }
  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 80) : 40;
  let matched = area ? all.filter((operation) => operation.path === area || operation.path.startsWith(`${area}.`)) : all;
  if (query) {
    const terms = words(query);
    const scored = matched.map((operation) => {
      const haystack = new Set([...words(operation.path), ...words(operation.doc), ...words(operation.signature)]);
      const pathText = operation.path.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (pathText.includes(term)) score += 3;
        else if ([...haystack].some((word) => word.startsWith(term) || term.startsWith(word) && word.length >= 4)) score += 1;
      }
      return { operation, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.operation.path.localeCompare(b.operation.path));
    matched = scored.map((item) => item.operation);
  }
  return { science_installed: science, total: matched.length,
    operations: matched.slice(0, limit).map((operation) => ({
      operation: operation.path, args: operation.params, signature: operation.signature, effect: operation.effect,
      ...(appControlEffectNeedsOwnerTurn(operation.effect) ? { owner_turn_only: true } : {}),
      ...(operation.doc ? { doc: operation.doc } : {}),
    })) };
}

function build(arg: AppControlInvokeArg, named: Record<string, unknown>): unknown {
  if ("param" in arg) {
    const value = named[arg.param];
    if (arg.isTrue) return value === true;
    if (value === undefined && arg.fallback) return build(arg.fallback, named);
    return value;
  }
  if ("literal" in arg) return Array.isArray(arg.literal) ? [] : arg.literal;
  if ("extensionId" in arg) return SCIENCE_EXTENSION_ID;
  const object: Record<string, unknown> = {};
  for (const [key, field] of arg.object) {
    const value = build(field, named);
    if (value !== undefined) object[key] = value;
  }
  return object;
}

function clipResult(value: unknown): { result: unknown; truncated?: true } {
  if (value === undefined) return { result: null };
  let text: string;
  try { text = JSON.stringify(value) ?? "null"; } catch { return { result: String(value).slice(0, RESULT_LIMIT) }; }
  if (text.length <= RESULT_LIMIT) return { result: JSON.parse(text) };
  return { result: `${text.slice(0, RESULT_LIMIT)}…`, truncated: true };
}

export async function appControlCall(caller: AppControlCaller, input: { operation?: unknown; args?: unknown }): Promise<Record<string, unknown>> {
  const path = typeof input.operation === "string" ? input.operation.trim() : "";
  const named = input.args === undefined || input.args === null ? {}
    : typeof input.args === "object" && !Array.isArray(input.args) ? input.args as Record<string, unknown> : null;
  if (!named) throw new AppControlError("invalid-arguments", "args must be an object of named arguments.");
  const catalogEntry = APP_CONTROL_CATALOG.find((entry) => entry.path === path);
  if (catalogEntry) {
    const policy = appControlPolicy(catalogEntry);
    if (!policy.allowed) throw new AppControlError("operation-not-allowed", `${path} is not available to One: ${policy.reason}.`);
  }
  const operation = operations().find((candidate) => candidate.path === path);
  if (!operation) {
    if (catalogEntry?.surface === "science") throw new AppControlError("science-not-installed", "Agentlas Science is not installed or not active.");
    throw new AppControlError("operation-unknown", `Unknown operation ${path || "(empty)"}; find one with one_app_operations.`);
  }
  if (appControlEffectNeedsOwnerTurn(operation.effect) && !caller.ownerTurn) {
    throw new AppControlError("owner-turn-required", `${path} ${operation.effect === "destructive" ? "deletes or stops something" : "needs the owner's say-so"}; only a message the owner wrote can ask for it. Tell the owner what you would do.`);
  }
  const unknown = Object.keys(named).filter((key) => !operation.params.includes(key));
  if (unknown.length) throw new AppControlError("invalid-arguments", `Unknown argument ${unknown.join(", ")}; ${path} takes ${operation.params.length ? operation.params.join(", ") : "no arguments"}.`);
  const window = host?.mainWindow() ?? null;
  if (!window || window.isDestroyed()) throw new AppControlError("app-window-closed", "The Agentlas window is closed.");

  if (operation.surface === "app") {
    if (path === "app.navigate") {
      const route = typeof named.route === "string" ? named.route.trim() : "";
      if (!/^\/[A-Za-z0-9/_\-?=&%.:~]*$/.test(route) || route.length > 300) throw new AppControlError("invalid-arguments", "route must be an app path such as /settings.");
      if (window.isMinimized()) window.restore();
      window.show();
      window.webContents.send("menu:navigate", route);
      return { ok: true, operation: path, effect: operation.effect, result: { route } };
    }
    const locale = named.locale;
    if (locale !== "ko" && locale !== "en" && locale !== "system") throw new AppControlError("invalid-arguments", "locale must be ko, en or system.");
    window.webContents.send("menu:navigate", `__locale__:${locale}`);
    return { ok: true, operation: path, effect: operation.effect, result: { locale } };
  }

  const entry = operation.entry!;
  if (!appControlHandlerRegistered(entry.channel)) throw new AppControlError("operation-unavailable", `${path} is not available in this app session.`);
  const args = entry.invokeArgs.map((arg) => build(arg, named));
  const value = await invokeAppControlIpc({ window, channel: entry.channel, args, operation: path });
  return { ok: true, operation: path, effect: operation.effect, ...clipResult(value) };
}
