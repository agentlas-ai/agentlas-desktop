import type { BrowserWindow } from "electron";
import { APP_CONTROL_CATALOG, type AppControlCatalogEntry, type AppControlInvokeArg } from "./catalog.generated";
import { AppControlError, appControlDomainHandlerRegistered, appControlHandlerRegistered, appControlInteractionWindowAvailable, invokeAppControlIpc } from "./ipc-registry";
import { appControlEffectNeedsOwnerTurn, appControlPolicy, type AppControlEffect } from "./policy";
import { APP_CONTROL_ARGUMENT_SCHEMAS, APP_UI_PREFERENCE_VALUE_SCHEMAS } from "./argument-schemas.generated";
import type { AppControlRendererOperation, AppControlRendererReply } from "../../shared/app-control";
import { appUiPreferenceDefinitions, isAppUiPreferenceName, normalizeAppUiPreference } from "../../shared/app-ui-preferences";
import { decodeAppControlArguments } from "./argument-codec";

// One's app-control route: find an operation, then call it as the owner's own screens would. The catalog is generated
// from the preload bridges; ./policy decides what One may call and on which turns.

export interface AppControlHost {
  mainWindow(): BrowserWindow | null;
  interactionWindow?(): BrowserWindow | null;
  showMain?(route: string): Promise<BrowserWindow | null>;
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
  keywords?: readonly string[];
  effect: AppControlEffect;
  inputSchema?: Record<string, unknown>;
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
  { path: "app.getState", surface: "app", params: [], signature: "()", effect: "read",
    doc: "Read the actual open screen, display language and theme, sidebar layout and image/video/audio display preferences." },
  { path: "app.navigate", surface: "app", params: ["route"], signature: "(route: string)", effect: "consent",
    doc: "Open a screen in the owner's Agentlas window, e.g. \"/settings\", \"/automation\", \"/library\", \"/marketplace\", \"/local-models\", \"/one\". Moves the owner's view, so only when they ask." },
  { path: "app.setLanguage", surface: "app", params: ["locale"], signature: "(locale: \"ko\" | \"en\" | \"system\")", effect: "write",
    doc: "Set the app's display language, the same setting as Settings > Language." },
  { path: "app.setTheme", surface: "app", params: ["theme"], signature: "(theme: \"light\" | \"dark\" | \"system\")", effect: "write",
    doc: "Set the display theme through its live provider. app.getState reports darkThemeAvailable; disabled dark mode is refused." },
  { path: "app.setSidebar", surface: "app", params: ["collapsed", "width"], signature: "(collapsed?: boolean, width?: number)", effect: "write",
    doc: "Collapse or expand the app navigation and resize the shared Work sidebar in pixels. Width is clamped to the window's supported range." },
  { path: "app.setMediaDisplay", surface: "app", params: ["kind", "visible"], signature: "(kind: \"image\" | \"video\" | \"audio\", visible: boolean)", effect: "write",
    doc: "Show or hide photos, videos or audio players in Work and One results, exactly like Settings > Result media." },
  { path: "app.getUiPreferences", surface: "app", params: [], signature: "()", effect: "read",
    doc: "Read supported persistent UI preferences with their descriptions and typed value schemas: One's next-message model, rails, Work outputs, project/firm panels, Graph panels and Document Studio citation style." },
  { path: "app.setUiPreference", surface: "app", params: ["name", "value"], signature: "(name: AppUiPreferenceName, value: AppUiPreferences[typeof name])", effect: "write",
    doc: "Set one supported UI preference through the same subscribed storage as its actual screen. First read app.getUiPreferences. oneRuntimeSelection affects the next personal One message; active chat and Goal models use chats.setRuntimeSelection or chats.requestGoalRuntimeSelection with native receipts." },
];

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false,
});
const uiPreferenceValueSchema = (name: string): Record<string, unknown> => {
  if (!isAppUiPreferenceName(name)) return {};
  const definition = appUiPreferenceDefinitions[name];
  return { ...APP_UI_PREFERENCE_VALUE_SCHEMAS[name],
    ...("minimum" in definition ? { minimum: definition.minimum, maximum: definition.maximum } : {}),
    ...("maxItems" in definition ? { maxItems: definition.maxItems } : {}),
  };
};
const HOST_ARGUMENT_SCHEMAS: Record<string, Record<string, unknown>> = {
  "app.getState": objectSchema({}),
  "app.getUiPreferences": objectSchema({}),
  "app.setUiPreference": { type: "object", required: ["name", "value"], additionalProperties: false,
    properties: { name: { type: "string", enum: Object.keys(appUiPreferenceDefinitions) }, value: {} },
    anyOf: Object.keys(appUiPreferenceDefinitions).map(name => ({ properties: {
      name: { const: name }, value: uiPreferenceValueSchema(name),
    } })),
  },
  "app.navigate": objectSchema({ route: { type: "string", pattern: "^/[A-Za-z0-9/_\\-?=&%.:~]*$", maxLength: 300 } }, ["route"]),
  "app.setLanguage": objectSchema({ locale: { type: "string", enum: ["ko", "en", "system"] } }, ["locale"]),
  "app.setTheme": objectSchema({ theme: { type: "string", enum: ["light", "dark", "system"] } }, ["theme"]),
  "app.setSidebar": { ...objectSchema({ collapsed: { type: "boolean" }, width: { type: "number" } }),
    anyOf: [{ required: ["collapsed"] }, { required: ["width"] }] },
  "app.setMediaDisplay": objectSchema({ kind: { type: "string", enum: ["image", "video", "audio"] }, visible: { type: "boolean" } }, ["kind", "visible"]),
};

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
    fromCatalog.push({ path: entry.path, surface: entry.surface, params: entry.params, signature: entry.signature, doc: entry.doc,
      ...(entry.keywords ? { keywords: entry.keywords } : {}), effect: policy.effect, entry });
  }
  return [...HOST_OPERATIONS, ...fromCatalog];
}

const words = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);

// The owner asks in Korean; operation names and most docs are English. Common product words map across.
const KOREAN_TERMS: Array<[RegExp, string[]]> = [
  [/알림|알람/, ["alert", "notification"]], [/소리|사운드/, ["sound"]], [/설정|환경/, ["settings", "config", "set"]],
  [/자동화|워크플로/, ["automation", "automations"]], [/프로젝트/, ["project", "projects"]], [/언어|한국어|영어/, ["language", "locale"]],
  [/기억|메모리/, ["memory"]], [/모델/, ["model", "models"]], [/에이전트|직원|팀원/, ["agent", "agents"]], [/팀/, ["team"]],
  [/메일|이메일/, ["mail"]], [/업데이트/, ["updater", "update"]], [/사이언스|연구/, ["science", "research"]], [/대화|채팅/, ["chat", "chats"]],
  [/목표|골/, ["goal"]], [/동시|병렬/, ["concurrency"]], [/텔레그램/, ["telegram"]], [/모바일|폰|휴대폰/, ["mobile"]],
  [/브라우저/, ["browser"]], [/일정|스케줄|예약/, ["schedule"]], [/토큰|한도/, ["token", "limit"]], [/사용량|요금|비용/, ["usage"]],
  [/인터뷰|질문/, ["interview"]], [/드리밍|꿈/, ["dreaming"]], [/도구|툴/, ["tool", "tools", "mcp"]], [/플러그인/, ["plugin"]],
  [/사이트|웹사이트/, ["site"]], [/문서|pdf/i, ["document"]], [/이미지|그림/, ["image"]], [/동영상|비디오|영상/, ["video"]],
  [/로컬/, ["local"]], [/화면|이동|열어/, ["navigate"]], [/켜|끄|꺼|활성|비활성/, ["enabled", "toggle", "set"]],
  [/패널|사이드바|폭|너비|접기|펼치|표시/, ["sidebar", "layout", "preference", "display", "width"]],
  [/원고|논문/, ["manuscript"]], [/데이터/, ["data", "datasets"]], [/런타임|엔진/, ["runtime"]], [/키체인|백그라운드|데몬/, ["daemon"]],
  // Verbs.
  [/삭제|지워|지우|제거/, ["remove", "delete"]], [/만들|생성|추가/, ["create", "add"]], [/목록|개수|몇/, ["list"]],
  [/바꿔|바꾸|변경|수정/, ["set", "update"]], [/실행|돌려/, ["run"]], [/멈춰|중지|정지/, ["stop", "pause"]], [/확인|조회|상태/, ["get", "status"]],
];
function queryTerms(query: string): string[] {
  const terms = new Set(words(query));
  for (const [pattern, english] of KOREAN_TERMS) if (pattern.test(query)) for (const term of english) terms.add(term);
  return [...terms];
}

export function appControlOperations(input: { query?: unknown; area?: unknown; operation?: unknown; limit?: unknown; offset?: unknown; include_restricted?: unknown }): {
  science_installed: boolean; areas?: Array<{ area: string; operations: number; available: number }>; operations?: Array<Record<string, unknown>>;
  total: number; offset?: number; next_offset?: number | null; restricted?: Array<Record<string, unknown>>;
} {
  const all = operations();
  const science = scienceInstalled();
  let area = typeof input.area === "string" ? input.area.trim() : "";
  let query = typeof input.query === "string" ? input.query.trim().slice(0, 200) : "";
  const exact = typeof input.operation === "string" ? input.operation.trim() : "";
  const available = (operation: Operation) => operation.surface === "app"
    ? !!(host?.interactionWindow?.() ?? host?.mainWindow()) && !(host?.interactionWindow?.() ?? host?.mainWindow())!.isDestroyed()
    : !!operation.entry && appControlHandlerRegistered(operation.entry.channel)
      && (appControlDomainHandlerRegistered(operation.entry.channel) || appControlInteractionWindowAvailable(host?.interactionWindow?.() ?? host?.mainWindow() ?? null));
  const restricted = () => APP_CONTROL_CATALOG.flatMap((entry) => {
    const policy = appControlPolicy(entry);
    return !policy.allowed && (!exact || entry.path === exact)
      ? [{ operation: entry.path, reason: policy.reason, args: entry.params, signature: entry.signature }] : [];
  });
  const areaList = () => {
    const counts = new Map<string, number>();
    for (const operation of all) {
      const key = operation.surface === "science" ? operation.path.split(".").slice(0, 2).join(".") : operation.path.split(".")[0];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].map(([key, count]) => ({ area: key, operations: count,
      available: all.filter(operation => (operation.surface === "science" ? operation.path.split(".").slice(0, 2).join(".") : operation.path.split(".")[0]) === key && available(operation)).length,
    })).sort((a, b) => a.area.localeCompare(b.area));
  };
  if (!area && !query && !exact) return { science_installed: science, total: all.length, areas: areaList(),
    ...(input.include_restricted === true ? { restricted: restricted() } : {}) };
  // An area that is not one ("settings") is read as words to search for.
  if (area && !all.some((operation) => operation.path === area || operation.path.startsWith(`${area}.`))) {
    query = `${area} ${query}`.trim();
    area = "";
  }
  const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 80) : 40;
  let matched = exact ? all.filter(operation => operation.path === exact)
    : area ? all.filter((operation) => operation.path === area || operation.path.startsWith(`${area}.`)) : all;
  if (query && !exact) {
    const terms = queryTerms(query);
    const scored = matched.map((operation) => {
      const haystack = new Set([...words(operation.path), ...words(operation.doc), ...words(operation.signature), ...(operation.keywords ?? []).flatMap(words)]);
      const pathText = operation.path.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (pathText.includes(term)) score += 3;
        else if ([...haystack].some((word) => word.startsWith(term) || term.startsWith(word) && word.length >= 4)) score += 1;
      }
      return { operation, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.operation.path.localeCompare(b.operation.path));
    matched = scored.map((item) => item.operation);
    // Nothing matched: hand back the map rather than an empty answer.
    if (!matched.length) return { science_installed: science, total: 0, areas: areaList() };
  }
  const offset = typeof input.offset === "number" && Number.isInteger(input.offset) ? Math.min(Math.max(input.offset, 0), 10_000) : 0;
  return { science_installed: science, total: matched.length, offset, next_offset: offset + limit < matched.length ? offset + limit : null,
    ...(input.include_restricted === true || exact && !matched.length ? { restricted: restricted() } : {}),
    operations: matched.slice(offset, offset + limit).map((operation) => ({
      operation: operation.path, args: operation.params, signature: operation.signature, effect: operation.effect,
      available: available(operation),
      execution_surface: operation.surface === "app" ? operation.path === "app.navigate" ? "main-presentation" : "existing-renderer"
        : operation.entry && appControlDomainHandlerRegistered(operation.entry.channel) ? "domain-service" : "owner-interaction",
      ...(exact || query === operation.path ? { input_schema: operation.inputSchema ?? HOST_ARGUMENT_SCHEMAS[operation.path] ?? APP_CONTROL_ARGUMENT_SCHEMAS[operation.path] }
        : { argument_schema_available: !!(operation.inputSchema ?? HOST_ARGUMENT_SCHEMAS[operation.path] ?? APP_CONTROL_ARGUMENT_SCHEMAS[operation.path]) }),
      ...(appControlEffectNeedsOwnerTurn(operation.effect) ? { owner_turn_only: true } : {}),
      ...(operation.keywords?.length ? { fields: operation.keywords } : {}),
      ...(operation.doc ? { doc: operation.doc } : {}),
    })) };
}

async function rendererCall(window: BrowserWindow, operation: AppControlRendererOperation, args: Record<string, unknown>): Promise<AppControlRendererReply> {
  // Arguments are JSON data in a fixed script, never executable source supplied by the model.
  const request = JSON.stringify([operation, args]);
  const value: unknown = await window.webContents.executeJavaScript(`(async () => {
    // A newly created presentation can finish navigation before React mounts
    // MenuBridge. Wait for that real bridge, without starting a second action.
    const until = Date.now() + 5000;
    while ((!window.agentlasAppControl || typeof window.agentlasAppControl.request !== "function") && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 50));
    const bridge = window.agentlasAppControl;
    if (!bridge || typeof bridge.request !== "function") return { ok: false, operation: ${JSON.stringify(operation)}, code: "renderer-unavailable" };
    return bridge.request(...${request});
  })()`);
  const reply = value as AppControlRendererReply | null;
  const state = reply?.state;
  const validState = !!state && typeof state.route === "string"
    && ["ko", "en", "system"].includes(state.localePreference) && ["ko", "en"].includes(state.locale)
    && ["light", "dark", "system"].includes(state.themePreference) && ["light", "dark"].includes(state.theme)
    && typeof state.darkThemeAvailable === "boolean" && typeof state.sidebarCollapsed === "boolean"
    && Number.isFinite(state.sidebarWidth) && !!state.media
    && ["image", "video", "audio"].every(kind => typeof state.media[kind as keyof typeof state.media] === "boolean")
    && !!state.uiPreferences && typeof state.uiPreferences === "object"
    && Object.keys(appUiPreferenceDefinitions).every(name => {
      if (!isAppUiPreferenceName(name) || !Object.hasOwn(state.uiPreferences, name)) return false;
      try { normalizeAppUiPreference(name, state.uiPreferences[name]); return true; } catch { return false; }
    });
  if (!reply || typeof reply !== "object" || reply.operation !== operation || typeof reply.ok !== "boolean" || reply.ok && !validState) {
    throw new AppControlError("renderer-reply-invalid", "The app did not return a matching UI acknowledgement.");
  }
  return value as AppControlRendererReply;
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
  const window = host?.interactionWindow?.() ?? host?.mainWindow() ?? null;

  if (operation.surface === "app") {
    if (path === "app.navigate") {
      const route = typeof named.route === "string" ? named.route.trim() : "";
      if (!/^\/[A-Za-z0-9/_\-?=&%.:~]*$/.test(route) || route.length > 300) throw new AppControlError("invalid-arguments", "route must be an app path such as /settings.");
      const presentation = await host?.showMain?.(route) ?? host?.mainWindow() ?? null;
      if (!presentation || presentation.isDestroyed()) throw new AppControlError("app-window-closed", "The Agentlas presentation window is closed.");
      if (presentation.isMinimized()) presentation.restore();
      presentation.show();
      const result = await rendererCall(presentation, "app.navigate", { route });
      return { ...result, effect: operation.effect };
    }
    if (!window || window.isDestroyed()) throw new AppControlError("app-window-closed", "The Agentlas interaction window is closed.");
    if (path === "app.setLanguage" && (typeof named.locale !== "string" || !["ko", "en", "system"].includes(named.locale))) throw new AppControlError("invalid-arguments", "locale must be ko, en or system.");
    if (path === "app.setTheme" && (typeof named.theme !== "string" || !["light", "dark", "system"].includes(named.theme))) throw new AppControlError("invalid-arguments", "theme must be light, dark or system.");
    if (path === "app.setSidebar" && (named.collapsed === undefined && named.width === undefined
      || named.collapsed !== undefined && typeof named.collapsed !== "boolean"
      || named.width !== undefined && (typeof named.width !== "number" || !Number.isFinite(named.width)))) throw new AppControlError("invalid-arguments", "Provide collapsed (boolean) or width (number).");
    if (path === "app.setMediaDisplay" && (typeof named.kind !== "string" || !["image", "video", "audio"].includes(named.kind) || typeof named.visible !== "boolean")) throw new AppControlError("invalid-arguments", "Provide kind (image, video, audio) and visible (boolean).");
    if (path === "app.setUiPreference") {
      if (!isAppUiPreferenceName(named.name)) throw new AppControlError("invalid-arguments", "Unknown UI preference; read app.getUiPreferences.");
      try { named.value = normalizeAppUiPreference(named.name, named.value); }
      catch (error) { throw new AppControlError("invalid-arguments", error instanceof Error ? error.message : "Invalid UI preference."); }
    }
    const result = await rendererCall(window, path as AppControlRendererOperation, named);
    return { ...result, effect: operation.effect, ...(path === "app.getUiPreferences" && result.ok ? {
      preferences: result.state!.uiPreferences,
      definitions: Object.fromEntries(Object.entries(appUiPreferenceDefinitions).map(([name, definition]) => [name, {
        description: definition.description, value_schema: uiPreferenceValueSchema(name),
      }])),
    } : {}) };
  }

  const entry = operation.entry!;
  if (!appControlHandlerRegistered(entry.channel)) throw new AppControlError("operation-unavailable", `${path} is not available in this app session.`);
  const decoded = decodeAppControlArguments(named, APP_CONTROL_ARGUMENT_SCHEMAS[path]) as Record<string, unknown>;
  const args = entry.invokeArgs.map((arg) => build(arg, decoded));
  const value = await invokeAppControlIpc({ window, channel: entry.channel, args, operation: path, ownerInteraction: caller.ownerTurn });
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const refused = record?.ok === false || record?.success === false || record?.accepted === false
    || operation.effect !== "read" && (record?.state === "failed" || record?.status === "rejected");
  return { ok: !refused, operation: path, effect: operation.effect, ...clipResult(value),
    ...(refused ? { code: typeof record?.code === "string" ? record.code : typeof record?.reasonCode === "string" ? record.reasonCode : "operation-refused" } : {}) };
}
