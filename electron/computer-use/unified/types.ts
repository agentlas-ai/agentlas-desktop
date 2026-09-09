export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ToolCallResult {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}

/**
 * A caller-owned transport. The runtime must bind this callback to the already
 * scoped MCP server for the current run; this module never opens a new browser,
 * obtains a broader grant, or bypasses an approval decision.
 */
export interface ScopedToolTransport {
  call(tool: string, args: Readonly<Record<string, unknown>>): Promise<ToolCallResult | unknown>;
}

export interface BrowserTransport extends ScopedToolTransport {
  readonly browserId: string;
}

export interface NativeTransport extends ScopedToolTransport {
  readonly platform?: string;
}

export interface UnifiedComputerUseOptions {
  browser?: BrowserTransport;
  native?: NativeTransport;
  now?: () => Date;
}

export interface BrowserTabDescriptor {
  id: string;
  browserId: string;
  title?: string;
  url?: string;
  active?: boolean;
  raw?: unknown;
}

export interface NativeAppDescriptor {
  id: string;
  name: string;
  bundleId?: string;
  pid?: number;
  active?: boolean;
  raw?: unknown;
}

export interface UnifiedState {
  capturedAt: string;
  browsers: Array<{ id: string; tabs: BrowserTabDescriptor[]; raw?: unknown }>;
  apps: NativeAppDescriptor[];
}

export type TargetKind = "browser-tab" | "native-app";

export interface TargetSnapshot {
  target: { kind: TargetKind; id: string; browserId?: string };
  capturedAt: string;
  revision: string;
  value: unknown;
}

export interface SnapshotChange {
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface SnapshotDiff {
  sameTarget: boolean;
  changed: boolean;
  fromRevision: string;
  toRevision: string;
  changes: SnapshotChange[];
}

export interface ScreenPoint {
  x: number;
  y: number;
  sourceId?: string;
}

export interface BrowserElementTarget {
  element: string;
  ref: string;
}

export interface BrowserTabTarget {
  readonly kind: "browser-tab";
  readonly id: string;
  readonly browserId: string;
  snapshot(): Promise<TargetSnapshot>;
  screenshot(options?: { filename?: string; fullPage?: boolean }): Promise<unknown>;
  focus(): Promise<unknown>;
  close(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  back(): Promise<unknown>;
  click(target: BrowserElementTarget): Promise<unknown>;
  typeText(target: BrowserElementTarget, text: string, options?: { submit?: boolean; slowly?: boolean }): Promise<unknown>;
  pressKey(key: string): Promise<unknown>;
}

export interface NativeAppTarget {
  readonly kind: "native-app";
  readonly id: string;
  readonly app: string;
  snapshot(options?: { sourceId?: string }): Promise<TargetSnapshot>;
  focus(): Promise<unknown>;
  click(point: ScreenPoint, options?: { button?: "left" | "right" | "middle"; count?: 1 | 2 }): Promise<unknown>;
  drag(from: ScreenPoint, to: ScreenPoint, options?: { durationMs?: number; button?: "left" | "right" | "middle" }): Promise<unknown>;
  scroll(deltaY: number, deltaX?: number): Promise<unknown>;
  typeText(text: string): Promise<unknown>;
  pressKey(key: string, options?: { modifiers?: Array<"command" | "shift" | "option" | "control" | "fn">; repeat?: number }): Promise<unknown>;
  setValue(text: string, point?: ScreenPoint): Promise<unknown>;
}

export interface UnifiedComputerUse {
  getState(): Promise<UnifiedState>;
  getTab(tabId: string, options?: { browser?: string }): BrowserTabTarget;
  createBrowserTab(browser: string, url: string, options?: { visible?: boolean }): Promise<BrowserTabTarget>;
  getApp(app: string): NativeAppTarget;
  diff(before: TargetSnapshot, after: TargetSnapshot): SnapshotDiff;
}
