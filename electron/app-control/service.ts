import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";
import { APP_CONTROL_CATALOG, type AppControlCatalogEntry, type AppControlInvokeArg } from "./catalog.generated";
import { AppControlError, appControlDomainHandlerRegistered, appControlHandlerRegistered, appControlInteractionWindowAvailable, invokeAppControlIpc } from "./ipc-registry";
import { appControlEffectNeedsOwnerTurn, appControlPolicy, type AppControlEffect } from "./policy";
import { APP_CONTROL_ARGUMENT_SCHEMAS, APP_UI_PREFERENCE_VALUE_SCHEMAS } from "./argument-schemas.generated";
import { describeCatalogOperation, describeHostOperation, type OperationDescriptor } from "./operation-descriptors";
import type { AppControlRendererOperation, AppControlRendererReply } from "../../shared/app-control";
import { appUiPreferenceDefinitions, isAppUiPreferenceName, normalizeAppUiPreference } from "../../shared/app-ui-preferences";
import { decodeAppControlArguments } from "./argument-codec";
import { remoteAppControlCall, remoteAppControlOperations } from "./daemon-remote";

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

// Read-only descriptor facts (native-harness S1, notyet NH19). Added beside the existing fields; nothing here is consulted
// when a call is authorized. The output schema rides only on an exact lookup, like input_schema: a search result list
// stays small for the model.
// The canonical output schema describes handler data. app.call preserves that data only when JSON fits;
// its existing fulfilled reply may instead contain a clipped preview or the legacy serialization fallback.
// Keep the wire unchanged and describe it separately. Window operations already return their flat ACK.
function appCallReplySchema(operation: Operation, descriptor: OperationDescriptor): Record<string, unknown> {
  if (!operation.entry) return descriptor.outputSchema;
  const { $defs, ...handlerOutput } = descriptor.outputSchema;
  const properties = {
    ok: { type: "boolean" }, operation: { const: operation.path }, effect: { const: operation.effect },
    code: { type: "string" }, receipt_id: { type: "string" }, receipt_recorded: { type: "boolean" },
  };
  const reply = (result: Record<string, unknown>, truncated: boolean) => ({
    type: "object", properties: { ...properties, result, ...(truncated ? { truncated: { const: true } } : {}) },
    required: ["ok", "operation", "effect", "result", ...(truncated ? ["truncated"] : [])], additionalProperties: false,
  });
  return {
    ...($defs ? { $defs } : {}),
    anyOf: [
      reply({ anyOf: [handlerOutput, { type: "null" }] }, false),
      reply({ type: "string", maxLength: RESULT_LIMIT + 1 }, true),
      // clipResult's JSON serialization failure has always returned a string without a truncated flag.
      reply({ type: "string", maxLength: RESULT_LIMIT }, false),
    ],
  };
}

function operationDescriptorView(operation: Operation, detailed: boolean): Record<string, unknown> {
  const descriptor: OperationDescriptor = operation.entry ? describeCatalogOperation(operation.entry)
    : describeHostOperation({ path: operation.path, effect: operation.effect, inputSchema: HOST_ARGUMENT_SCHEMAS[operation.path] });
  return { semantics_version: descriptor.semanticsVersion, kind: descriptor.kind, kind_basis: descriptor.kindBasis,
    ...(descriptor.kindReason ? { kind_reason: descriptor.kindReason } : {}), policy_ref: descriptor.policyRef,
    idempotency: descriptor.idempotency, ...(descriptor.idempotencyField ? { idempotency_field: descriptor.idempotencyField } : {}),
    cancellation: descriptor.cancellation, ...(descriptor.job ? { job: descriptor.job } : {}), ...(descriptor.events.length ? { events: descriptor.events } : {}),
    required_host_ports: descriptor.requiredHostPorts, headless: descriptor.execution.headless, receipt: descriptor.receipt.kind,
    output_basis: descriptor.outputBasis, ...(descriptor.untypedReason ? { untyped_reason: descriptor.untypedReason } : {}),
    ...(descriptor.bridgeAgreement === "mismatch" ? { bridge_agreement: "mismatch" } : {}),
    ...(detailed ? { output_schema: descriptor.outputSchema,
      output_schema_scope: operation.entry ? "handler-result" : "call-reply",
      call_reply_scope: "app-control-service-fulfilled-reply",
      call_reply_schema: appCallReplySchema(operation, descriptor),
    } : {}),
    ...(descriptor.aliases.length ? { aliases: descriptor.aliases } : {}), ui_only: descriptor.flags.uiOnly };
}

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

// Search is deterministic over the operation's own words (path, doc, signature, keywords). No translation table:
// the model writes the query in English (owner rule 2026-10-13: the host does not judge meaning by word lists).
function queryTerms(query: string): string[] {
  return [...new Set(words(query))];
}

type OperationsInput = { query?: unknown; area?: unknown; operation?: unknown; limit?: unknown; offset?: unknown; include_restricted?: unknown };
export type AppControlOperationsResult = {
  science_installed: boolean; areas?: Array<{ area: string; operations: number; available: number }>; operations?: Array<Record<string, unknown>>;
  total: number; offset?: number; next_offset?: number | null; restricted?: Array<Record<string, unknown>>;
  /** A query that matched nothing and was not English. */
  hint?: string;
  /** Present only when this process has no window and the window process could not be reached. */
  app_window?: { available: false; code: string; message: string };
};

/** Main owns the IPC handlers and the windows. A process without a configured host (the background service that runs
 * One/Hope turns) cannot run an operation itself: it asks Main over the device bridge and gets Main's own answer. */
export function appControlOperations(input: OperationsInput): AppControlOperationsResult | Promise<AppControlOperationsResult> {
  return host ? appControlOperationsLocal(input) : remoteAppControlOperations(input, appControlOperationsLocal);
}
export async function appControlCall(caller: AppControlCaller, input: { operation?: unknown; args?: unknown }): Promise<Record<string, unknown>> {
  return host ? appControlCallLocal(caller, input) : remoteAppControlCall(caller, input);
}

export function appControlOperationsLocal(input: OperationsInput): AppControlOperationsResult {
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
    // Nothing matched: hand back the map rather than an empty answer (and say the catalog is English).
    if (!matched.length) return { science_installed: science, total: 0, areas: areaList(),
      ...(/[^\x00-\x7f]/.test(query) ? { hint: "operation names and docs are English: search with English words" } : {}) };
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
      descriptor: operationDescriptorView(operation, !!(exact || query === operation.path)),
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

const OWNER_LOCAL_MAP_OPERATIONS: ReadonlySet<string> = new Set(["experience.ontologyGraph", "agents.borrowedOntologyGraph"]);

function clipResult(value: unknown): { result: unknown; truncated?: true } {
  if (value === undefined) return { result: null };
  let text: string;
  try { text = JSON.stringify(value) ?? "null"; } catch { return { result: String(value).slice(0, RESULT_LIMIT) }; }
  if (text.length <= RESULT_LIMIT) return { result: JSON.parse(text) };
  return { result: `${text.slice(0, RESULT_LIMIT)}…`, truncated: true };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// One receipt per dispatched non-read call, whichever caller reached it (One's tools, the harness app.call port, the
// background service through the device bridge): the operation itself, not just "app.call" (descriptor receipt
// contract, NH19). The ledger is evidence, not a gate: when it cannot be written the call result says so.
async function recordAppCallReceipt(entry: { operation: string; effect: AppControlEffect; named: Record<string, unknown>; status: "ok" | "refused" | "failed"; code?: string; ownerTurn: boolean }): Promise<Record<string, unknown>> {
  if (entry.effect === "read") return {};
  try {
    const { appendReceiptOutcome } = require("../harness/capability-ports") as typeof import("../harness/capability-ports");
    const outcome = await appendReceiptOutcome({ operationId: entry.operation, via: "app.call", effect: entry.effect,
      inputDigest: createHash("sha256").update(canonicalJson(entry.named)).digest("hex"), status: entry.status,
      ...(entry.code ? { code: entry.code } : {}), ownerTurn: entry.ownerTurn });
    return { receipt_id: outcome.receiptId, receipt_recorded: outcome.recorded };
  } catch {
    return { receipt_recorded: false };
  }
}

function errorCode(error: unknown): string {
  return error instanceof AppControlError ? error.code : error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "operation-failed";
}

export async function appControlCallLocal(caller: AppControlCaller, input: { operation?: unknown; args?: unknown }): Promise<Record<string, unknown>> {
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
  // A required argument that is missing is refused, never sent as undefined: automations.listRuns without its id answered
  // 0 runs as if that were the history (dev 2026-10-17 run8), and the agent reported "no runs last week".
  const requiredKeys = APP_CONTROL_ARGUMENT_SCHEMAS[path]?.required;
  const missing = Array.isArray(requiredKeys) ? requiredKeys.filter((key) => typeof key === "string" && named[key] === undefined) : [];
  if (missing.length) throw new AppControlError("invalid-arguments", `${path} needs ${missing.join(", ")}; pass them in args.`);
  const window = host?.interactionWindow?.() ?? host?.mainWindow() ?? null;

  if (operation.surface === "app") {
    if (path === "app.navigate") {
      const route = typeof named.route === "string" ? named.route.trim() : "";
      if (!/^\/[A-Za-z0-9/_\-?=&%.:~]*$/.test(route) || route.length > 300) throw new AppControlError("invalid-arguments", "route must be an app path such as /settings.");
      const presentation = await host?.showMain?.(route) ?? host?.mainWindow() ?? null;
      if (!presentation || presentation.isDestroyed()) throw new AppControlError("app-window-closed", "The Agentlas presentation window is closed.");
      if (presentation.isMinimized()) presentation.restore();
      presentation.show();
      let result: AppControlRendererReply;
      try { result = await rendererCall(presentation, "app.navigate", { route }); }
      catch (error) { await recordAppCallReceipt({ operation: path, effect: operation.effect, named: { route }, status: "failed", code: errorCode(error), ownerTurn: caller.ownerTurn }); throw error; }
      return { ...result, effect: operation.effect, ...await recordAppCallReceipt({ operation: path, effect: operation.effect, named: { route },
        status: result.ok ? "ok" : "refused", ...(result.ok ? {} : { code: result.code }), ownerTurn: caller.ownerTurn }) };
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
    let result: AppControlRendererReply;
    try { result = await rendererCall(window, path as AppControlRendererOperation, named); }
    catch (error) { await recordAppCallReceipt({ operation: path, effect: operation.effect, named, status: "failed", code: errorCode(error), ownerTurn: caller.ownerTurn }); throw error; }
    const receipt = await recordAppCallReceipt({ operation: path, effect: operation.effect, named, status: result.ok ? "ok" : "refused",
      ...(result.ok ? {} : { code: result.code }), ownerTurn: caller.ownerTurn });
    return { ...result, effect: operation.effect, ...receipt, ...(path === "app.getUiPreferences" && result.ok ? {
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
  let value: unknown;
  try { value = await invokeAppControlIpc({ window, channel: entry.channel, args, operation: path, ownerInteraction: caller.ownerTurn }); }
  catch (error) { await recordAppCallReceipt({ operation: path, effect: operation.effect, named: decoded, status: "failed", code: errorCode(error), ownerTurn: caller.ownerTurn }); throw error; }
  // The experience maps carry owner-local titles for the owner's renderer; an agent's copy drops them (safeLabel stays).
  if (OWNER_LOCAL_MAP_OPERATIONS.has(path)) value = (await import("../experience/relation-index")).withoutOwnerLocalLabels(value);
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const refused = record?.ok === false || record?.success === false || record?.accepted === false
    || operation.effect !== "read" && (record?.state === "failed" || record?.status === "rejected");
  const code = refused ? typeof record?.code === "string" ? record.code : typeof record?.reasonCode === "string" ? record.reasonCode : "operation-refused" : undefined;
  return { ok: !refused, operation: path, effect: operation.effect, ...clipResult(value), ...(code ? { code } : {}),
    ...await recordAppCallReceipt({ operation: path, effect: operation.effect, named: decoded, status: refused ? "refused" : "ok", ...(code ? { code } : {}), ownerTurn: caller.ownerTurn }) };
}
