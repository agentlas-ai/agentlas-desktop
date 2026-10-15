/*
 * MCP Apps host bridge, pure logic (docs/2026-10-13-native-harness/16 §5).
 *
 * The view lives in a sandboxed iframe (sandbox="allow-scripts", no allow-same-origin, srcdoc). It talks JSON-RPC 2.0
 * over postMessage. This module only decides: which messages are admitted, what to reply, and which host effects follow.
 * It has no DOM, no IPC and no credentials; the React component performs the effects.
 *
 * Rules enforced here:
 *  - a message is admitted only when it comes from the iframe's own window and a sandboxed-srcdoc origin ("null");
 *  - nothing but ui/initialize is accepted before the handshake, and ui/notifications/initialized completes it;
 *  - a view-originated tools/call is never dispatched directly: it can only resolve to a host-issued action of the
 *    instance (actionId === requested tool name, host-action intent) and then goes through ui.action with that actionRef;
 *  - ui/message and ui/update-model-context never create an instruction or an authority (acknowledged, no effect).
 */

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_MAX_MESSAGE_BYTES = 256 * 1024;
export const MCP_APP_MAX_HEIGHT = 720;

export interface McpAppViewRef { connectorId: string; uri: string }

/** `mcp-app:<connectorId>:<ui://...>` */
export function parseMcpAppViewId(viewId: string): McpAppViewRef | null {
  if (typeof viewId !== "string" || !viewId.startsWith("mcp-app:")) return null;
  const rest = viewId.slice("mcp-app:".length);
  const cut = rest.indexOf(":");
  if (cut <= 0) return null;
  const connectorId = rest.slice(0, cut);
  const uri = rest.slice(cut + 1);
  if (!uri.startsWith("ui://") || uri.length <= "ui://".length) return null;
  return { connectorId, uri };
}

export interface BridgeAction { actionId: string; actionRef: string; intent: string }

export interface BridgeState {
  phase: "uninitialized" | "initializing" | "ready";
}

export interface BridgeContext {
  actions: readonly BridgeAction[];
  theme?: "light" | "dark";
  locale?: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

export type BridgeEffect =
  | { type: "reply"; message: Record<string, unknown> }
  | { type: "notify"; message: Record<string, unknown> }
  | { type: "ui-action"; requestId: string | number; actionRef: string; actionId: string; input: Record<string, unknown> }
  | { type: "resize"; height: number }
  | { type: "ignored"; method: string };

export function createBridgeState(): BridgeState { return { phase: "uninitialized" }; }

export interface RawMessage { source: unknown; origin: string; data: unknown }

/** True only for a message from the expected iframe window with the opaque origin a sandboxed srcdoc produces. */
export function admitMessage(message: RawMessage, expectedSource: unknown): boolean {
  if (expectedSource === null || expectedSource === undefined) return false;
  if (message.source !== expectedSource) return false;
  return message.origin === "null";
}

interface Envelope { id?: string | number; method?: string; params?: Record<string, unknown>; isResponse: boolean }

export function parseEnvelope(data: unknown): Envelope | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.jsonrpc !== "2.0") return null;
  let size = 0;
  try { size = JSON.stringify(data).length; } catch { return null; }
  if (size > MCP_APP_MAX_MESSAGE_BYTES) return null;
  const idOk = value.id === undefined || typeof value.id === "string" || typeof value.id === "number";
  if (!idOk) return null;
  if (typeof value.method !== "string") {
    // A response from the view to a host request; the host sends none that need answers.
    return value.id !== undefined && ("result" in value || "error" in value) ? { id: value.id as string | number, isResponse: true } : null;
  }
  const params = value.params === undefined ? {} : value.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  return { id: value.id as string | number | undefined, method: value.method, params: params as Record<string, unknown>, isResponse: false };
}

const rpcError = (id: string | number, code: number, message: string): BridgeEffect => ({ type: "reply", message: { jsonrpc: "2.0", id, error: { code, message } } });
const rpcResult = (id: string | number, result: unknown): BridgeEffect => ({ type: "reply", message: { jsonrpc: "2.0", id, result } });

/** Pure transition: (state, already admitted data) -> next state + effects. */
export function reduceViewMessage(state: BridgeState, data: unknown, context: BridgeContext): { state: BridgeState; effects: BridgeEffect[] } {
  const envelope = parseEnvelope(data);
  if (!envelope || envelope.isResponse) return { state, effects: [] };
  const { id, method = "", params = {} } = envelope;
  const hasId = id !== undefined;

  if (method === "ui/initialize") {
    if (!hasId) return { state, effects: [] };
    if (state.phase !== "uninitialized") return { state, effects: [rpcError(id, -32600, "already initialized")] };
    return {
      state: { phase: "initializing" },
      effects: [rpcResult(id, {
        protocolVersion: MCP_APP_PROTOCOL_VERSION,
        hostInfo: { name: "Agentlas", version: "1" },
        hostCapabilities: { serverTools: {}, message: {} },
        hostContext: { theme: context.theme ?? "light", locale: context.locale ?? "en", displayMode: "inline", availableDisplayModes: ["inline"] },
      })],
    };
  }

  if (state.phase === "uninitialized") {
    return { state, effects: hasId ? [rpcError(id, -32002, "ui/initialize required first")] : [] };
  }

  if (method === "ui/notifications/initialized") {
    if (state.phase !== "initializing") return { state, effects: [] };
    const effects: BridgeEffect[] = [];
    if (context.toolInput !== undefined) effects.push({ type: "notify", message: { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: context.toolInput } } });
    if (context.toolResult !== undefined) effects.push({ type: "notify", message: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: context.toolResult } });
    return { state: { phase: "ready" }, effects };
  }

  if (state.phase !== "ready") {
    return { state, effects: hasId ? [rpcError(id, -32002, "initialization not complete")] : [] };
  }

  if (method === "tools/call") {
    if (!hasId) return { state, effects: [] };
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments;
    if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) return { state, effects: [rpcError(id, -32602, "arguments must be an object")] };
    // The view names a tool; the host only honors a host-issued action with that id. Never a direct tool call.
    const action = context.actions.find((item) => item.actionId === name && item.intent === "host-action");
    if (!action) return { state, effects: [rpcError(id, -32601, "no host-issued action for this tool")] };
    return { state, effects: [{ type: "ui-action", requestId: id, actionRef: action.actionRef, actionId: action.actionId, input: (args ?? {}) as Record<string, unknown> }] };
  }

  if (method === "ui/notifications/size-changed") {
    const height = typeof params.height === "number" && Number.isFinite(params.height) ? Math.max(0, Math.min(MCP_APP_MAX_HEIGHT, Math.ceil(params.height))) : null;
    return { state, effects: height === null ? [] : [{ type: "resize", height }] };
  }

  if (method === "ui/message" || method === "ui/update-model-context") {
    // Not an owner instruction and not an authority: acknowledge, do nothing.
    return { state, effects: [{ type: "ignored", method }, ...(hasId ? [rpcResult(id, {})] : [])] };
  }

  if (method === "ui/open-link") {
    return { state, effects: hasId ? [rpcError(id, -32601, "not supported by this host")] : [] };
  }

  return { state, effects: hasId ? [rpcError(id, -32601, `method not found: ${method}`)] : [] };
}

/** Reply to a view's tools/call once ui.action answered. */
export function actionReply(requestId: string | number, outcome: { status: string; data?: unknown; reason?: string }): Record<string, unknown> {
  if (outcome.status === "ok") {
    return { jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: "ok" }], structuredContent: outcome.data ?? {}, isError: false } };
  }
  return { jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: outcome.reason ?? outcome.status }], isError: true } };
}

/** Teardown request to the view before the iframe is removed. */
export function teardownMessage(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} };
}

/** Sandbox attribute value: scripts only. Never allow-same-origin, allow-top-navigation, allow-forms or allow-popups. */
export const MCP_APP_SANDBOX = "allow-scripts";

/** Pull the HTML text out of whatever the mcp.app.resource.read port returned (string, {html}, {text} or MCP contents[]). */
export function extractAppHtml(data: unknown): string | null {
  if (typeof data === "string") return data.trim() ? data : null;
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  for (const key of ["html", "text"]) if (typeof value[key] === "string" && (value[key] as string).trim()) return value[key] as string;
  const contents = value.contents;
  if (Array.isArray(contents)) {
    for (const item of contents) {
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" && (item as { text: string }).text.trim()) return (item as { text: string }).text;
    }
  }
  return null;
}

const APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** srcdoc: a restrictive CSP first (no network, no frames, no forms), then the resource HTML. */
export function wrapAppHtml(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${APP_CSP}">${html}`;
}
