import { createHash } from "node:crypto";
import type {
  BrowserElementTarget,
  BrowserTabDescriptor,
  BrowserTabTarget,
  NativeAppDescriptor,
  NativeAppObservation,
  NativeAppTarget,
  ScreenPoint,
  ScopedToolTransport,
  SnapshotChange,
  SnapshotDiff,
  TargetSnapshot,
  ToolCallResult,
  UnifiedComputerUse,
  UnifiedComputerUseOptions,
  UnifiedState,
} from "./types";

function assertText(value: string, label: string, max = 16_384): string {
  const trimmed = value.trim();
  if (!trimmed || value.length > max) throw new Error(`unified-cua-invalid-${label}`);
  return value;
}

function assertValue(value: string, label: string, max = 16_384): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`unified-cua-invalid-${label}`);
  return value;
}

function unwrap(result: ToolCallResult | unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const envelope = result as ToolCallResult;
  if (envelope.isError) {
    const message = envelope.content?.find((item) => item.type === "text")?.text;
    throw new Error(message || "unified-cua-tool-failed");
  }
  if (envelope.structuredContent !== undefined) return envelope.structuredContent;
  const texts = envelope.content?.filter((item) => item.type === "text" && typeof item.text === "string") ?? [];
  if (texts.length === 1) {
    try { return JSON.parse(texts[0].text!); } catch { return texts[0].text; }
  }
  return result;
}

async function call(transport: ScopedToolTransport | undefined, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!transport) throw new Error(`unified-cua-${tool.startsWith("browser_") ? "browser" : "native"}-transport-unavailable`);
  signal?.throwIfAborted();
  return unwrap(await transport.call(tool, args, signal));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function semanticSnapshotValue(kind: "browser-tab" | "native-app", value: unknown): unknown {
  return kind === "native-app" && value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "observationId" && key !== "capturedAt" && key !== "raw"))
    : value;
}

function snapshot(kind: "browser-tab" | "native-app", id: string, value: unknown, now: () => Date, browserId?: string): TargetSnapshot {
  const semanticValue = semanticSnapshotValue(kind, value);
  return {
    target: { kind, id, ...(browserId ? { browserId } : {}) },
    capturedAt: now().toISOString(),
    revision: createHash("sha256").update(stable(semanticValue)).digest("hex"),
    value,
  };
}

function objectRows(value: unknown, keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(record[key])) return objectRows(record[key], []);
  return [];
}

function normalizeTabs(value: unknown, browserId: string): BrowserTabDescriptor[] {
  if (typeof value === "string") {
    return value.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*-\s*(\d+)\s*:\s*(?:\(current\)\s*)?(?:\[([^\]]*)\]\(([^)]*)\)|(.*))\s*$/.exec(line);
      if (!match) return [];
      return [{ id: match[1], browserId, ...(match[2] ? { title: match[2] } : {}),
        ...(match[3] ? { url: match[3] } : {}), active: /\(current\)/.test(line) }];
    });
  }
  return objectRows(value, ["tabs", "pages"]).flatMap((row, index) => {
    const id = row.id ?? row.tabId ?? row.targetId ?? row.pageId;
    if (typeof id !== "string" && typeof id !== "number") return [];
    return [{
      id: String(id), browserId,
      ...(typeof row.title === "string" ? { title: row.title } : {}),
      ...(typeof row.url === "string" ? { url: row.url } : {}),
      ...(typeof row.active === "boolean" ? { active: row.active } : index === 0 ? { active: true } : {}),
    }];
  });
}

function normalizeApps(value: unknown): NativeAppDescriptor[] {
  return objectRows(value, ["apps", "applications"]).flatMap((row) => {
    const name = row.name ?? row.appName ?? row.localizedName;
    const pid = typeof row.pid === "number" && Number.isInteger(row.pid) ? row.pid : undefined;
    if (typeof name !== "string" || !name.trim()) return [];
    const bundleId = typeof row.bundleId === "string" ? row.bundleId : typeof row.bundleIdentifier === "string" ? row.bundleIdentifier : undefined;
    return [{ id: bundleId || (pid ? `pid:${pid}` : name), name, ...(bundleId ? { bundleId } : {}), ...(pid ? { pid } : {}),
      ...(typeof row.active === "boolean" ? { active: row.active } : {}) }];
  });
}

function pointArgs(point: ScreenPoint): Record<string, unknown> {
  return { x: point.x, y: point.y, ...(point.sourceId ? { source_id: point.sourceId } : {}) };
}

function elementArgs(target: { observationId: string; elementIndex: number }): Record<string, unknown> {
  const observationId = assertText(target.observationId, "observation-id", 64);
  if (!Number.isInteger(target.elementIndex) || target.elementIndex < 0 || target.elementIndex > 299) {
    throw new Error("unified-cua-invalid-element-index");
  }
  return { observation_id: observationId, element_index: target.elementIndex };
}

function browserElementArgs(target: BrowserElementTarget): Record<string, unknown> {
  const exactTarget = target.target ?? target.ref;
  if (!exactTarget) throw new Error("unified-cua-browser-target-required");
  return { element: assertText(target.element, "element", 500), target: assertText(exactTarget, "target", 1_000) };
}

function nativeObservation(value: unknown): NativeAppObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unified-cua-native-observation-invalid");
  const row = value as Record<string, unknown>;
  if (typeof row.observationId !== "string" || !Array.isArray(row.elements)) throw new Error("unified-cua-native-observation-invalid");
  const elements = row.elements.filter((item): item is Record<string, unknown> & { element_index: number } =>
    Boolean(item) && typeof item === "object" && Number.isInteger((item as Record<string, unknown>).element_index));
  return { observationId: row.observationId, elements,
    ...(typeof row.capturedAt === "string" ? { capturedAt: row.capturedAt } : {}),
    ...(row.app !== undefined ? { app: row.app } : {}),
    ...(typeof row.truncated === "boolean" ? { truncated: row.truncated } : {}) };
}

function diffValue(before: unknown, after: unknown, path: string, changes: SnapshotChange[]): void {
  if (stable(before) === stable(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) diffValue(before[index], after[index], `${path}/${index}`, changes);
    return;
  }
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
    for (const key of [...keys].sort()) diffValue((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, changes);
    return;
  }
  changes.push({ path: path || "/", ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
}

export function createUnifiedComputerUse(options: UnifiedComputerUseOptions): UnifiedComputerUse {
  const now = options.now ?? (() => new Date());
  const browserId = options.browser?.browserId;
  const scopedCall = (transport: ScopedToolTransport | undefined, tool: string, args: Record<string, unknown>) =>
    call(transport, tool, args, typeof options.signal === "function" ? options.signal() : options.signal);
  let browserQueue: Promise<unknown> = Promise.resolve();
  let topologyGeneration = 0;
  const knownTabs = new Map<string, BrowserTabDescriptor>();
  const serializedBrowser = <T>(operation: () => Promise<T>): Promise<T> => {
    const execution = browserQueue.then(operation, operation);
    browserQueue = execution.then(() => undefined, () => undefined);
    return execution;
  };
  const refreshTabs = async (): Promise<BrowserTabDescriptor[]> => {
    if (!options.browser || !browserId) return [];
    const tabs = normalizeTabs(await scopedCall(options.browser, "browser_tabs", { action: "list" }), browserId);
    knownTabs.clear();
    for (const tab of tabs) knownTabs.set(tab.id, tab);
    return tabs;
  };

  const getTab = (tabId: string, tabOptions?: { browser?: string }): BrowserTabTarget => {
    const id = assertText(tabId, "tab-id", 512);
    const requestedBrowser = tabOptions?.browser ?? browserId;
    if (!options.browser || !requestedBrowser || requestedBrowser !== browserId) throw new Error("unified-cua-browser-not-bound");
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 0) throw new Error("unified-cua-invalid-tab-id");
    const identity = knownTabs.get(id);
    if (!identity) throw new Error("unified-cua-tab-not-observed");
    const generation = topologyGeneration;
    const selected = () => ({ action: "select", index: numericId });
    const updateIdentity = async (): Promise<void> => {
      const current = (await refreshTabs()).find((tab) => tab.id === id);
      if (!current) throw new Error("unified-cua-stale-tab-target");
      Object.assign(identity, current);
    };
    const run = <T>(operation: () => Promise<T>): Promise<T> => serializedBrowser(async () => {
      if (generation !== topologyGeneration) throw new Error("unified-cua-stale-tab-target");
      const current = (await refreshTabs()).find((tab) => tab.id === id);
      if (!current || (identity.url && current.url && identity.url !== current.url) || (identity.title && current.title && identity.title !== current.title)) {
        throw new Error("unified-cua-stale-tab-target");
      }
      return operation();
    });
    return {
      kind: "browser-tab", id, browserId: requestedBrowser,
      async snapshot() {
        const value = await run(async () => { await scopedCall(options.browser, "browser_tabs", selected()); return scopedCall(options.browser, "browser_snapshot", {}); });
        return snapshot("browser-tab", id, value, now, requestedBrowser);
      },
      screenshot: (input = {}) => run(async () => { await scopedCall(options.browser, "browser_tabs", selected()); return scopedCall(options.browser, "browser_take_screenshot", { ...input }); }),
      focus: () => run(() => scopedCall(options.browser, "browser_tabs", selected())),
      close: () => run(async () => { const result = await scopedCall(options.browser, "browser_tabs", { action: "close", index: numericId }); topologyGeneration += 1; knownTabs.clear(); return result; }),
      navigate: (url) => run(async () => { await scopedCall(options.browser, "browser_tabs", selected()); const result = await scopedCall(options.browser, "browser_navigate", { url: assertText(url, "url", 8_192) }); await updateIdentity(); return result; }),
      back: () => run(async () => { await scopedCall(options.browser, "browser_tabs", selected()); const result = await scopedCall(options.browser, "browser_navigate_back", {}); await updateIdentity(); return result; }),
      click: (target: BrowserElementTarget) => run(async () => {
        await scopedCall(options.browser, "browser_tabs", selected());
        const result = await scopedCall(options.browser, "browser_click", browserElementArgs(target));
        await updateIdentity();
        return result;
      }),
      typeText: (target, text, input = {}) => run(async () => {
        await scopedCall(options.browser, "browser_tabs", selected());
        const result = await scopedCall(options.browser, "browser_type", { ...browserElementArgs(target), text: assertText(text, "text"), ...input });
        await updateIdentity();
        return result;
      }),
      pressKey: (key) => run(async () => {
        await scopedCall(options.browser, "browser_tabs", selected());
        const result = await scopedCall(options.browser, "browser_press_key", { key: assertText(key, "key", 64) });
        await updateIdentity();
        return result;
      }),
    };
  };

  const getApp = (app: string): NativeAppTarget => {
    const name = assertText(app, "app", 160);
    const observe = async (input: { maxDepth?: number; maxNodes?: number } = {}): Promise<NativeAppObservation> => {
      const value = await scopedCall(options.native, "get_app_state", { app: name,
        ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
        ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}) });
      return nativeObservation(value);
    };
    return {
      kind: "native-app", id: name, app: name,
      async snapshot(input = {}) {
        const value = await observe(input);
        return snapshot("native-app", name, value, now);
      },
      observe,
      async screenshot(input = {}) { await scopedCall(options.native, "focus_app", { app: name }); return scopedCall(options.native, "get_screen", input.sourceId ? { source_id: input.sourceId } : {}); },
      focus: () => scopedCall(options.native, "focus_app", { app: name }),
      click: (point, input = {}) => scopedCall(options.native, input.count === 2 ? "double_click" : "click", { app: name, ...pointArgs(point), ...(input.button ? { button: input.button } : {}) }),
      drag: (from, to, input = {}) => scopedCall(options.native, "drag", { app: name, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y,
        ...(from.sourceId ? { source_id: from.sourceId } : to.sourceId ? { source_id: to.sourceId } : {}),
        ...(input.durationMs ? { duration_ms: input.durationMs } : {}), ...(input.button ? { button: input.button } : {}) }),
      scroll: (deltaY, deltaX = 0) => scopedCall(options.native, "scroll", { app: name, delta_y: deltaY, delta_x: deltaX }),
      typeText: (text) => scopedCall(options.native, "type_text", { app: name, text: assertText(text, "text") }),
      pressKey: (key, input = {}) => scopedCall(options.native, "press_key", { app: name, key: assertText(key, "key", 32), ...input }),
      setValue: (text, point) => scopedCall(options.native, "set_value", { app: name, text: assertValue(text, "text"), ...(point ? pointArgs(point) : {}) }),
      clickElement: (target) => scopedCall(options.native, "click", { app: name, ...elementArgs(target) }),
      performElementAction: (target, action) => scopedCall(options.native, "perform_secondary_action", { app: name, ...elementArgs(target), action: assertText(action, "action", 120) }),
      setElementValue: (target, text) => scopedCall(options.native, "set_value", { app: name, ...elementArgs(target), text: assertValue(text, "text") }),
      selectElementText: (target, text, input = {}) => scopedCall(options.native, "select_text", { app: name, ...elementArgs(target), text: assertText(text, "text"),
        ...(input.prefix ? { prefix: input.prefix } : {}), ...(input.suffix ? { suffix: input.suffix } : {}),
        ...(input.selectionType ? { selection_type: input.selectionType } : {}) }),
    };
  };

  return {
    async getState(): Promise<UnifiedState> {
      const [tabs, appsResult] = await Promise.all([
        options.browser ? serializedBrowser(refreshTabs) : Promise.resolve([]),
        options.native ? scopedCall(options.native, "list_apps", {}) : Promise.resolve(undefined),
      ]);
      return {
        capturedAt: now().toISOString(),
        browsers: options.browser && browserId ? [{ id: browserId, tabs }] : [],
        apps: normalizeApps(appsResult),
      };
    },
    getTab,
    async createBrowserTab(browser, url, input = {}) {
      if (!options.browser || browser !== browserId) throw new Error("unified-cua-browser-not-bound");
      const { tab } = await serializedBrowser(async () => {
      const before = await refreshTabs();
      const created = await scopedCall(options.browser, "browser_tabs", { action: "new" });
      topologyGeneration += 1;
      const createdRows = normalizeTabs(created, browser);
      const after = await refreshTabs();
      const tab = createdRows[0] ?? after.find((candidate) => !before.some((existing) => existing.id === candidate.id)) ?? after[0];
      if (!tab) throw new Error("unified-cua-created-tab-identity-missing");
      return { tab };
      });
      const target = getTab(tab.id, { browser });
      await target.navigate(assertText(url, "url", 8_192));
      if (input.visible !== false) await target.focus();
      return target;
    },
    getApp,
    diff(before, after): SnapshotDiff {
      const changes: SnapshotChange[] = [];
      const sameTarget = stable(before.target) === stable(after.target);
      if (sameTarget) diffValue(semanticSnapshotValue(before.target.kind, before.value), semanticSnapshotValue(after.target.kind, after.value), "", changes);
      return { sameTarget, changed: !sameTarget || before.revision !== after.revision, fromRevision: before.revision, toRevision: after.revision, changes };
    },
  };
}
