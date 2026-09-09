import { createHash } from "node:crypto";
import type {
  BrowserElementTarget,
  BrowserTabDescriptor,
  BrowserTabTarget,
  NativeAppDescriptor,
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

async function call(transport: ScopedToolTransport | undefined, tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!transport) throw new Error(`unified-cua-${tool.startsWith("browser_") ? "browser" : "native"}-transport-unavailable`);
  return unwrap(await transport.call(tool, args));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function snapshot(kind: "browser-tab" | "native-app", id: string, value: unknown, now: () => Date, browserId?: string): TargetSnapshot {
  return {
    target: { kind, id, ...(browserId ? { browserId } : {}) },
    capturedAt: now().toISOString(),
    revision: createHash("sha256").update(stable(value)).digest("hex"),
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
        ...(match[3] ? { url: match[3] } : {}), active: /\(current\)/.test(line), raw: line }];
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
      raw: row,
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
      ...(typeof row.active === "boolean" ? { active: row.active } : {}), raw: row }];
  });
}

function pointArgs(point: ScreenPoint): Record<string, unknown> {
  return { x: point.x, y: point.y, ...(point.sourceId ? { source_id: point.sourceId } : {}) };
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

  const getTab = (tabId: string, tabOptions?: { browser?: string }): BrowserTabTarget => {
    const id = assertText(tabId, "tab-id", 512);
    const requestedBrowser = tabOptions?.browser ?? browserId;
    if (!options.browser || !requestedBrowser || requestedBrowser !== browserId) throw new Error("unified-cua-browser-not-bound");
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 0) throw new Error("unified-cua-invalid-tab-id");
    const selected = () => ({ action: "select", index: numericId });
    return {
      kind: "browser-tab", id, browserId: requestedBrowser,
      async snapshot() {
        await call(options.browser, "browser_tabs", selected());
        const value = await call(options.browser, "browser_snapshot", {});
        return snapshot("browser-tab", id, value, now, requestedBrowser);
      },
      screenshot: (input = {}) => call(options.browser, "browser_take_screenshot", { ...input }),
      focus: () => call(options.browser, "browser_tabs", selected()),
      close: () => call(options.browser, "browser_tabs", { action: "close", index: numericId }),
      async navigate(url) { await call(options.browser, "browser_tabs", selected()); return call(options.browser, "browser_navigate", { url: assertText(url, "url", 8_192) }); },
      async back() { await call(options.browser, "browser_tabs", selected()); return call(options.browser, "browser_navigate_back", {}); },
      async click(target: BrowserElementTarget) { await call(options.browser, "browser_tabs", selected()); return call(options.browser, "browser_click", { ...target }); },
      async typeText(target, text, input = {}) { await call(options.browser, "browser_tabs", selected()); return call(options.browser, "browser_type", { ...target, text: assertText(text, "text"), ...input }); },
      async pressKey(key) { await call(options.browser, "browser_tabs", selected()); return call(options.browser, "browser_press_key", { key: assertText(key, "key", 64) }); },
    };
  };

  const getApp = (app: string): NativeAppTarget => {
    const name = assertText(app, "app", 160);
    return {
      kind: "native-app", id: name, app: name,
      async snapshot(input = {}) {
        const value = await call(options.native, "get_app_state", { app: name, ...(input.sourceId ? { source_id: input.sourceId } : {}) });
        return snapshot("native-app", name, value, now);
      },
      focus: () => call(options.native, "focus_app", { app: name }),
      click: (point, input = {}) => call(options.native, input.count === 2 ? "double_click" : "click", { app: name, ...pointArgs(point), ...(input.button ? { button: input.button } : {}) }),
      drag: (from, to, input = {}) => call(options.native, "drag", { app: name, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y,
        ...(from.sourceId ? { source_id: from.sourceId } : to.sourceId ? { source_id: to.sourceId } : {}),
        ...(input.durationMs ? { duration_ms: input.durationMs } : {}), ...(input.button ? { button: input.button } : {}) }),
      scroll: (deltaY, deltaX = 0) => call(options.native, "scroll", { app: name, delta_y: deltaY, delta_x: deltaX }),
      typeText: (text) => call(options.native, "type_text", { app: name, text: assertText(text, "text") }),
      pressKey: (key, input = {}) => call(options.native, "press_key", { app: name, key: assertText(key, "key", 32), ...input }),
      setValue: (text, point) => call(options.native, "set_value", { app: name, text: assertText(text, "text"), ...(point ? pointArgs(point) : {}) }),
    };
  };

  return {
    async getState(): Promise<UnifiedState> {
      const [tabsResult, appsResult] = await Promise.all([
        options.browser ? call(options.browser, "browser_tabs", { action: "list" }) : Promise.resolve(undefined),
        options.native ? call(options.native, "list_apps", {}) : Promise.resolve(undefined),
      ]);
      return {
        capturedAt: now().toISOString(),
        browsers: options.browser && browserId ? [{ id: browserId, tabs: normalizeTabs(tabsResult, browserId), raw: tabsResult }] : [],
        apps: normalizeApps(appsResult),
      };
    },
    getTab,
    async createBrowserTab(browser, url, input = {}) {
      if (!options.browser || browser !== browserId) throw new Error("unified-cua-browser-not-bound");
      const before = normalizeTabs(await call(options.browser, "browser_tabs", { action: "list" }), browser);
      const created = await call(options.browser, "browser_tabs", { action: "new" });
      const createdRows = normalizeTabs(created, browser);
      const after = normalizeTabs(await call(options.browser, "browser_tabs", { action: "list" }), browser);
      const tab = createdRows[0] ?? after.find((candidate) => !before.some((existing) => existing.id === candidate.id)) ?? after[0];
      if (!tab) throw new Error("unified-cua-created-tab-identity-missing");
      const target = getTab(tab.id, { browser });
      await target.navigate(assertText(url, "url", 8_192));
      if (input.visible !== false) await target.focus();
      return target;
    },
    getApp,
    diff(before, after): SnapshotDiff {
      const changes: SnapshotChange[] = [];
      const sameTarget = stable(before.target) === stable(after.target);
      if (sameTarget) diffValue(before.value, after.value, "", changes);
      return { sameTarget, changed: !sameTarget || before.revision !== after.revision, fromRevision: before.revision, toRevision: after.revision, changes };
    },
  };
}
