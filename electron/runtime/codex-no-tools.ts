import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import { openAiStrictSchemaOrNull, codexSystemPromptWithSchemaFallback } from "./strict-output-schema";
import type { RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";
import { aliveDecisionProfileForRequest, type AliveDecisionProfile } from "./alive-decision-context";
import { agentContextNoToolsPacketForRequest, agentContextSessionKey } from "./agent-context";
import { createCodexNoToolsProviderSession, CodexNoToolsSessionError,
  type CodexNoToolsProviderSession, type CodexNoToolsProviderSessionOptions } from "./codex-no-tools-session";

/** The subscription endpoint already used by Codex; never a caller-selected provider. */
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_WIRE_BYTES = 4 * 1024 * 1024;
const NO_TOOLS_TIMEOUT_MS = 180_000;
const DISABLED_FEATURES = ["apps", "browser_use", "browser_use_external", "computer_use", "image_generation",
  "goals", "in_app_browser", "chronicle", "multi_agent", "multi_agent_v2", "memories", "plugins", "skill_search",
  "tool_suggest", "sleep_tool", "workspace_dependencies", "worktrees", "view_image", "realtime_conversation",
  "mentions_v2", "hooks", "code_mode_host", "shell_tool", "unified_exec"] as const;
const FRAME_TYPES = new Set([
  "response.created", "response.in_progress", "response.output_item.added", "response.output_item.done",
  "response.content_part.added", "response.content_part.done", "response.output_text.delta", "response.output_text.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_text.delta", "response.reasoning_text.done", "response.reasoning_part.added", "response.reasoning_part.done",
  "response.completed", "response.failed", "response.incomplete", "error",
]);
function object(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}
function failure(code: string, kind: RunnerFailure["kind"] = "refused"): RunnerFailure {
  return { kind, runtime: "codex", source: "marker", providerCode: code, message: code };
}
class CodexNoToolsProviderError extends Error {
  constructor(readonly receipt: RunnerFailure) { super(receipt.providerCode); }
}
function providerStreamFailure(frame: Record<string, any>): RunnerFailure {
  const error = object(frame.error) ?? object(frame.response?.error);
  const marker = error?.code ?? error?.type;
  const code = typeof marker === "string" && /^[a-zA-Z0-9_.-]{1,96}$/.test(marker) ? marker : undefined;
  const kind: RunnerFailure["kind"] = code && ["rate_limit_exceeded", "usage_limit_reached", "insufficient_quota", "quota_exceeded"].includes(code)
    ? "quota" : code && ["invalid_api_key", "invalid_token", "token_expired", "authentication_error", "unauthorized"].includes(code)
      ? "auth" : code && ["request_timeout", "timeout"].includes(code) ? "timeout" : "unavailable";
  return failure(code ?? (frame.type === "response.incomplete" ? "codex_no_tools_provider_incomplete" : "codex_no_tools_provider_failed"), kind);
}
function validatePart(value: unknown): void {
  const part = object(value);
  if (!part || !["output_text", "summary_text", "reasoning_text", "text", "refusal"].includes(part.type)
    || (part.text !== undefined && typeof part.text !== "string")) throw new Error("codex_no_tools_content_denied");
}
function validateItem(value: unknown): void {
  const item = object(value);
  if (!item || !["message", "reasoning"].includes(item.type)) throw new Error("codex_no_tools_output_tool_denied");
  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) throw new Error("codex_no_tools_message_invalid");
    item.content.forEach(validatePart);
  } else {
    for (const key of ["summary", "content"] as const) {
      if (item[key] !== undefined && !Array.isArray(item[key])) throw new Error("codex_no_tools_reasoning_invalid");
      item[key]?.forEach(validatePart);
    }
  }
}
/** Complete buffering is essential: not one unvalidated frame reaches Codex's native dispatcher. */
export function validateCodexNoToolsResponse(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  if (!normalized.endsWith("\n\n")) throw new CodexNoToolsProviderError(failure("codex_no_tools_terminal_missing", "unavailable"));
  let terminal: Record<string, any> | null = null;
  for (const block of normalized.split("\n\n").filter(value => value.trim())) {
    if (block.split("\n").every(line => !line || line.startsWith(":"))) continue;
    const lines = block.split("\n");
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    const frame = object(JSON.parse(data));
    const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (!frame || !FRAME_TYPES.has(frame.type) || (event && event !== frame.type) || terminal) {
      throw new Error("codex_no_tools_frame_unknown");
    }
    if (frame.item !== undefined) validateItem(frame.item);
    if (frame.part !== undefined) validatePart(frame.part);
    if (frame.response?.output !== undefined) {
      if (!Array.isArray(frame.response.output)) throw new Error("codex_no_tools_output_invalid");
      frame.response.output.forEach(validateItem);
    }
    if (["response.failed", "response.incomplete", "error"].includes(frame.type)) throw new CodexNoToolsProviderError(providerStreamFailure(frame));
    if (frame.type === "response.completed") {
      if (!object(frame.response) || frame.response.status !== "completed" || !Array.isArray(frame.response.output)) {
        throw new Error("codex_no_tools_terminal_invalid");
      }
      terminal = frame.response;
    }
  }
  if (!terminal) throw new CodexNoToolsProviderError(failure("codex_no_tools_terminal_missing", "unavailable"));
  const text = terminal.output.filter((item: any) => item.type === "message")
    .flatMap((item: any) => item.content).filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("\n").trim();
  if (!text) throw new Error("codex_no_tools_output_empty");
  return text;
}
export function codexNoToolsArgs(req: RunnerRequest, baseUrl: string, instructions: string, schemaFile?: string, authStorage?: string, contextWindowTokens?: number): string[] {
  return ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
    "--sandbox", "read-only", "-c", "project_doc_max_bytes=0", "-c", 'approval_policy="never"',
    "-c", `model_instructions_file=${JSON.stringify(instructions)}`, "-c", 'model_provider="agentlas_judgment"',
    "-c", `model_providers.agentlas_judgment={name="OpenAI",base_url=${JSON.stringify(baseUrl)},wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
    "-c", "features.enable_request_compression=false", "-c", 'web_search="disabled"',
    ...DISABLED_FEATURES.flatMap(name => ["-c", `features.${name}=false`]),
    ...(authStorage ? ["-c", `cli_auth_credentials_store=${JSON.stringify(authStorage)}`] : []),
    ...(contextWindowTokens ? ["-c", `model_context_window=${contextWindowTokens}`] : []),
    ...(req.model ? ["--model", req.model] : []), ...(req.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(req.effort)}`] : []),
    ...(schemaFile ? ["--output-schema", schemaFile] : []), "-"];
}
/** Private fixture seam; production always forwards to the fixed Codex endpoint. */
export interface CodexNoToolsDependencies {
  forward?: (body: string, headers: Record<string, string>, signal: AbortSignal,
    endpoint: typeof CODEX_RESPONSES_URL | typeof OPENAI_RESPONSES_URL) => Promise<Response>;
  timeoutMs?: number;
  contextWindowTokens?: number;
  connectAuth?: () => net.Socket;
  /** Alive-only host-selected resident protocol, never a native/model flag. */
  resident?: (input: { args: string[]; request: RunnerRequest; nonce: string;
    onStarted(threadId: string, turnId: string): void; baseUrl: string; home: string; accountHome: string;
    authStorage?: string; contextWindowTokens?: number; systemPrompt: string; packet: AlivePacket }) => Promise<RunnerResult>;
  closeResident?: () => Promise<void>;
  verifyResidentResult?: (result: RunnerResult, nonce: string, expectedNativeHandle: string | null) => boolean;
  residentFingerprint?: string;
  connectProvider?: CodexNoToolsProviderSessionOptions["connect"];
}
async function readBounded(body: AsyncIterable<Uint8Array>): Promise<string> {
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_WIRE_BYTES) throw new Error("codex_no_tools_wire_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function runCodexNoTools(
  req: RunnerRequest,
  events: RunnerEvents,
  execute: (args: string[], request: RunnerRequest) => Promise<RunnerResult>,
  dependencies: CodexNoToolsDependencies = {},
): Promise<RunnerResult> {
  if (!req.untrustedNoTools || !req.judgmentOnly || req.mcpConfigPath || req.mcpCodexConfigArgs?.length
    || req.mcpAllowedTools?.length || req.untrustedAllowedMcpTools?.length || req.workforceRuntimeToolGrant) {
    return { text: "", failure: failure("codex_no_tools_request_invalid") };
  }
  if (!req.model?.trim()) return { text: "", failure: failure("codex_no_tools_model_required", "unsupported") };
  if (req.signal?.aborted) return { text: "", failure: failure("codex_no_tools_cancelled", "unavailable") };
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-codex-judgment-"));
  const controller = new AbortController();
  let gatewayFailure: RunnerFailure | undefined;
  let finalText: string | undefined;
  let admitted = false;
  let authRejectCount = 0;
  let pendingAuthFailure: RunnerFailure | undefined;
  const tunnelSockets = new Set<Duplex>();
  const fail = (receipt: RunnerFailure) => { gatewayFailure ??= receipt; };
  const abort = () => { fail(failure("codex_no_tools_cancelled", "unavailable")); controller.abort(); };
  req.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { fail(failure("codex_no_tools_timeout", "timeout")); controller.abort(); }, dependencies.timeoutMs ?? NO_TOOLS_TIMEOUT_MS);
  const route = `/${crypto.randomBytes(24).toString("hex")}`;
  const forward = dependencies.forward ?? ((body, headers, signal, endpoint) => fetch(endpoint,
    { method: "POST", headers, body, signal, redirect: "error" }));
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method !== "POST" || incoming.url !== `${route}/responses` || admitted || controller.signal.aborted) {
        outgoing.writeHead(403); outgoing.end(); return;
      }
      admitted = true;
      if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
        throw new Error("codex_no_tools_encoding_unknown");
      }
      const payload = object(JSON.parse(await readBounded(incoming)));
      if (!payload || !Array.isArray(payload.input) || payload.stream !== true || payload.model !== req.model) {
        throw new Error("codex_no_tools_request_shape_invalid");
      }
      // Codex retains its real account home for file/keyring sign-in. Discard
      // every native/global-rules/memory/tool-inventory input item; only Main's
      // exact instructions and evidence reach the model. ResponsesLite embeds
      // its native menu in additional_tools input frames as well as tools.
      payload.instructions = codexSystemPromptWithSchemaFallback(req);
      payload.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: req.userPrompt }] }];
      delete payload.previous_response_id;
      delete payload.access_programs;
      payload.tools = [];
      payload.tool_choice = "none";
      payload.parallel_tool_calls = false;
      const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
      for (const name of ["authorization", "chatgpt-account-id", "openai-beta", "originator", "user-agent",
        "x-codex-turn-metadata", "x-codex-session-id", "x-codex-turn-state", "x-openai-internal-codex-responses-lite"] as const) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      let response: Response;
      // Native OpenAI auth adds account-id only for ChatGPT sign-in. API-key
      // accounts retain the official API route without inspecting the bearer.
      const endpoint = headers["chatgpt-account-id"] ? CODEX_RESPONSES_URL : OPENAI_RESPONSES_URL;
      try { response = await forward(JSON.stringify(payload), headers, controller.signal, endpoint); }
      catch {
        fail(failure("codex_no_tools_provider_connection_failed", "unavailable"));
        throw new Error("codex_no_tools_provider_connection_failed");
      }
      if (response.status === 401 && authRejectCount < 2) {
        // A conclusive auth rejection has no model execution. Allow Codex's
        // own guarded reload then refresh-on-401; never retry after an accepted stream.
        authRejectCount += 1;
        admitted = false;
        pendingAuthFailure = failure("codex_no_tools_provider_http_401", "auth");
        outgoing.writeHead(401, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { message: "codex_no_tools_auth_refresh_required", type: "authentication_error" } }));
        return;
      }
      if (!response.ok) {
        fail(failure(`codex_no_tools_provider_http_${response.status}`, response.status === 429 ? "quota"
          : [401, 403].includes(response.status) ? "auth" : "unavailable"));
        throw new Error(gatewayFailure!.providerCode);
      }
      const contentType = response.headers.get("content-type");
      // The fixed provider may omit MIME on a valid SSE response. Admission still
      // requires the complete bounded stream to pass the validator below.
      if (contentType && !contentType.toLowerCase().startsWith("text/event-stream") || !response.body) {
        throw new Error("codex_no_tools_response_encoding_unknown");
      }
      const reader = response.body.getReader();
      async function* chunks(): AsyncGenerator<Uint8Array> {
        try { for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; } }
        finally { reader.releaseLock(); }
      }
      let body: string;
      try { body = await readBounded(chunks()); }
      catch (error) {
        if (!(error instanceof Error && error.message === "codex_no_tools_wire_too_large")) {
          fail(failure("codex_no_tools_provider_stream_unsettled", "unavailable"));
        }
        throw error;
      }
      finalText = validateCodexNoToolsResponse(body);
      pendingAuthFailure = undefined;
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.end(body);
    } catch (error) {
      if (error instanceof CodexNoToolsProviderError) fail(error.receipt);
      const code = error instanceof Error && /^codex_no_tools_[a-z0-9_]+$/.test(error.message)
        ? error.message : "codex_no_tools_transport_invalid";
      fail(failure(code));
      if (!outgoing.headersSent) outgoing.writeHead(422, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { message: code, type: "invalid_request_error", code } }));
    }
  });
  server.on("connect", (incoming, socket, head) => {
    if (incoming.url !== "auth.openai.com:443" || controller.signal.aborted) { socket.destroy(); return; }
    // CLI-owned OAuth refresh only; TLS remains opaque to the host. No model,
    // app, plugin or arbitrary network endpoint can bypass the Responses gate.
    const upstream = dependencies.connectAuth?.() ?? net.connect(443, "auth.openai.com");
    tunnelSockets.add(upstream);
    tunnelSockets.add(socket);
    const close = () => { upstream.destroy(); socket.destroy(); tunnelSockets.delete(upstream); tunnelSockets.delete(socket); };
    upstream.once("error", close);
    socket.once("error", close);
    upstream.once("close", close);
    socket.once("close", close);
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  server.on("upgrade", (_req, socket) => { fail(failure("codex_no_tools_websocket_denied")); socket.destroy(); });
  try {
    const env = req.env ?? process.env;
    // Keep the account home unchanged: keyring keys and auth refresh belong to
    // Codex, including on Windows hosts that cannot create symlinks.
    const accountHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
    let authStorage: string | undefined;
    try {
      const config = await fs.readFile(path.join(accountHome, "config.toml"), "utf8");
      const rootConfig = config.split(/^\s*\[/m)[0];
      authStorage = /^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto|secret|ephemeral)["']/m.exec(rootConfig)?.[1];
      if (/^\s*["']?profile["']?\s*=/m.test(rootConfig)) {
        // A selected profile may change provider/auth routing. Its complete
        // native contract is not inferred after --ignore-user-config.
        return { text: "", failure: failure("codex_no_tools_configured_profile_unavailable", "unavailable") };
      }
      const provider = /^\s*["']?model_provider["']?\s*=\s*["']([^"']+)["']/m.exec(rootConfig)?.[1];
      // Ignoring native user configuration must never reinterpret a custom
      // provider's credentials or send its evidence to an OpenAI account.
      if ((/^\s*["']?model_provider["']?\s*=/m.test(rootConfig) && provider !== "openai")
        || /^\s*\[\s*["']?model_providers["']?\s*\.\s*(?:openai|"openai"|'openai')\s*(?:\]|\.)/m.test(config)
        || /^\s*["']?model_providers["']?(?:\s*=|\s*\.\s*(?:openai|"openai"|'openai'))/m.test(rootConfig)
        || /^\s*\[\s*["']?model_providers["']?\s*\][^[]*^\s*(?:openai|"openai"|'openai')\s*=/m.test(config)) {
        return { text: "", failure: failure("codex_no_tools_custom_provider_unavailable", "unavailable") };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { text: "", failure: failure("codex_no_tools_account_config_unavailable", "unavailable") };
      }
      // No account config retains Codex's default OpenAI provider/auth store.
    }
    if (env.OPENAI_BASE_URL && env.OPENAI_BASE_URL.replace(/\/+$/, "") !== "https://api.openai.com/v1") {
      return { text: "", failure: failure("codex_no_tools_custom_provider_unavailable", "unavailable") };
    }
    const instructions = path.join(home, "instructions.md");
    await fs.writeFile(instructions, codexSystemPromptWithSchemaFallback(req), { mode: 0o600 });
    const schema = req.outputSchema ? openAiStrictSchemaOrNull(req.outputSchema.schema) : null;
    const schemaFile = schema ? path.join(home, "output-schema.json") : undefined;
    if (schemaFile) await fs.writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("codex_no_tools_gateway_unavailable");
    const baseUrl = `http://127.0.0.1:${address.port}${route}`;
    const contextWindow = dependencies.contextWindowTokens;
    const args = codexNoToolsArgs(req, baseUrl, instructions, schemaFile, authStorage,
      contextWindow && Number.isSafeInteger(contextWindow) && contextWindow > 0 && contextWindow <= 10_000_000 ? contextWindow : undefined);
    const request: RunnerRequest = { ...req, cwd: home, signal: controller.signal, history: [],
      env: { ...env, CODEX_HOME: accountHome, CODEX_REFRESH_TOKEN_URL_OVERRIDE: undefined, HTTP_PROXY: baseUrl, HTTPS_PROXY: baseUrl, ALL_PROXY: baseUrl, NO_PROXY: "127.0.0.1,localhost" } };
    if (req.signal?.aborted) abort();
    if (controller.signal.aborted) return { text: "", failure: gatewayFailure };
    events.onStatus("[runtime-session] judgment kind=codex enforcement=host_responses_no_tools");
    let result: RunnerResult;
    try { result = await execute(args, request); }
    catch (error) { if (!gatewayFailure) throw error; return { text: "", failure: gatewayFailure }; }
    if (gatewayFailure) return { ...result, text: "", failure: gatewayFailure };
    if (pendingAuthFailure) return { ...result, text: "", failure: pendingAuthFailure };
    if (result.failure) return result;
    if (!finalText || result.text.trim() !== finalText) return { ...result, text: "", failure: failure("codex_no_tools_result_unverified") };
    return result;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", abort);
    controller.abort();
    for (const socket of tunnelSockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  }
}


type AlivePacket = NonNullable<ReturnType<typeof agentContextNoToolsPacketForRequest>>;
interface AliveGatewayTurn {
  req: RunnerRequest;
  packet: AlivePacket;
  controller: AbortController;
  admitted: boolean;
  authRejectCount: number;
  pendingAuthFailure?: RunnerFailure;
  failure?: RunnerFailure;
  finalText?: string;
  nonce: string;
  nativeIds?: Readonly<{ threadId: string; turnId: string }>;
  nativeStarted: Promise<void>;
  resolveNativeStarted(): void;
}
interface AliveGateway {
  ownerKey: string;
  bindingKey: string;
  home: string;
  baseUrl: string;
  active: AliveGatewayTurn | null;
  closed: boolean;
  server: http.Server;
  server6: http.Server;
  route: string;
  provider: CodexNoToolsProviderSession;
  sockets: Set<Duplex>;
  ready: Promise<void>;
  close(): Promise<void>;
}
const aliveGateways = new Map<string, AliveGateway>();
// An accepted or uncertain dispatch never becomes retryable by releasing a
// gateway. The host must prepare a different exact authorized turn.
const consumedAliveCapabilities = new WeakSet<object>();
function failAliveTurn(turn: AliveGatewayTurn, receipt: RunnerFailure): void { turn.failure ??= receipt; }
function currentAliveTurn(resource: AliveGateway, profile: Readonly<AliveDecisionProfile>): AliveGatewayTurn | null {
  const turn = resource.active;
  if (!turn || resource.closed || turn.controller.signal.aborted || turn.req.signal?.aborted) return null;
  try {
    const current = aliveDecisionProfileForRequest(turn.req);
    if (!current || current.resourceOwnerKey !== profile.resourceOwnerKey || current.bindingKey !== profile.bindingKey) return null;
    current.assertCurrent();
    return turn;
  } catch { return null; }
}
function createAliveGateway(profile: Readonly<AliveDecisionProfile>, bindingKey: string,
  dependencies: CodexNoToolsDependencies): AliveGateway {
  const route = `/${crypto.randomBytes(24).toString("hex")}`;
  const sockets = new Set<Duplex>();
  const provider = createCodexNoToolsProviderSession({ bindingKey, validate: validateCodexNoToolsResponse,
    onInvalidated() { void resource.close(); },
    ...(dependencies.connectProvider ? { connect: dependencies.connectProvider } : {}) });
  let unregister: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const resource: AliveGateway = { ownerKey: profile.resourceOwnerKey, bindingKey, home: "", baseUrl: "", active: null,
    closed: false, sockets, route, provider, ready: Promise.resolve(), server: undefined as unknown as http.Server,
    server6: undefined as unknown as http.Server,
    close() {
      if (closing) return closing;
      resource.closed = true;
      const turn = resource.active;
      if (turn) { failAliveTurn(turn, failure("codex_no_tools_cancelled", "unavailable")); turn.controller.abort(); }
      if (aliveGateways.get(resource.ownerKey) === resource) aliveGateways.delete(resource.ownerKey);
      unregister?.();
      for (const socket of sockets) socket.destroy();
      closing = (async () => {
        // Native physical termination precedes listener/home retirement. The
        // resident pool continues charging its seat while this Promise waits.
        await dependencies.closeResident?.();
        await provider.close();
        await resource.ready.catch(() => {});
        resource.server.closeAllConnections();
        resource.server6.closeAllConnections();
        await Promise.all([resource.server, resource.server6].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
        if (resource.home) await fs.rm(resource.home, { recursive: true, force: true });
      })();
      return closing;
    } };
  const handler: http.RequestListener = async (incoming, outgoing) => {
    const turn = currentAliveTurn(resource, profile);
    try {
      const turnRoute = turn && !dependencies.resident ? `${route}/${turn.nonce}/responses` : `${route}/responses`;
      if (!turn || incoming.method !== "POST" || incoming.url !== turnRoute || turn.admitted) {
        outgoing.writeHead(403); outgoing.end(); return;
      }
      if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
        throw new Error("codex_no_tools_encoding_unknown");
      }
      const payload = object(JSON.parse(await readBounded(incoming)));
      if (!payload || !Array.isArray(payload.input) || payload.stream !== true || payload.model !== turn.req.model) {
        throw new Error("codex_no_tools_request_shape_invalid");
      }
      if (currentAliveTurn(resource, profile) !== turn) throw new Error("codex_no_tools_cancelled");
      if (dependencies.resident) {
        const metadata = payload.client_metadata?.["x-codex-turn-metadata"];
        let tagged: Record<string, unknown> | null = null;
        try { tagged = typeof metadata === "string" ? object(JSON.parse(metadata)) : null; } catch {}
        if (!tagged || tagged.agentlas_turn_nonce !== turn.nonce) { outgoing.writeHead(403); outgoing.end(); return; }
        // stdio ACK and HTTP are different channels. Wait only within the
        // current admitted turn; HTTP-provided IDs cannot establish authority.
        if (!turn.nativeIds) await Promise.race([turn.nativeStarted, new Promise<void>((_resolve, reject) => {
          if (turn.controller.signal.aborted) reject(new Error("codex_no_tools_cancelled"));
          else turn.controller.signal.addEventListener("abort", () => reject(new Error("codex_no_tools_cancelled")), { once: true });
        })]);
        if (!turn.nativeIds || tagged.thread_id !== turn.nativeIds.threadId || tagged.turn_id !== turn.nativeIds.turnId) {
          outgoing.writeHead(403); outgoing.end(); return;
        }
      }
      if (currentAliveTurn(resource, profile) !== turn || turn.admitted) { outgoing.writeHead(403); outgoing.end(); return; }
      turn.admitted = true;
      const headers: Record<string, string> = {};
      for (const name of ["authorization", "chatgpt-account-id", "openai-beta", "originator", "user-agent",
        "x-codex-session-id", "x-codex-turn-state", "x-openai-internal-codex-responses-lite"] as const) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      let response: Awaited<ReturnType<CodexNoToolsProviderSession["exchange"]>>;
      try { response = await provider.exchange({ request: turn.req, packet: turn.packet, headers,
        hostInstructions: codexSystemPromptWithSchemaFallback(turn.req), signal: turn.controller.signal,
        assertCurrent() { if (currentAliveTurn(resource, profile) !== turn) throw new Error("codex_no_tools_cancelled"); } }); }
      catch (error) {
      if (error instanceof CodexNoToolsSessionError && error.preDispatch && error.httpStatus === 401 && turn.authRejectCount < 2) {
        // A conclusive unauthorized response is the only retry admission.
        turn.authRejectCount += 1; turn.admitted = false;
        turn.pendingAuthFailure = failure("codex_no_tools_provider_http_401", "auth");
        outgoing.writeHead(401, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { message: "codex_no_tools_auth_refresh_required", type: "authentication_error" } }));
        return;
      }
        if (error instanceof CodexNoToolsSessionError && error.httpStatus) {
          failAliveTurn(turn, failure(`codex_no_tools_provider_http_${error.httpStatus}`, error.httpStatus === 429 ? "quota"
            : [401, 403].includes(error.httpStatus) ? "auth" : "unavailable"));
        }
        throw error;
      }
      if (currentAliveTurn(resource, profile) !== turn) throw new Error("codex_no_tools_cancelled");
      turn.finalText = response.text; turn.pendingAuthFailure = undefined;
      outgoing.writeHead(200, { "content-type": "text/event-stream" }); outgoing.end(response.sse);
    } catch (error) {
      if (turn && error instanceof CodexNoToolsProviderError) failAliveTurn(turn, error.receipt);
      const code = error instanceof Error && /^codex_no_tools_[a-z0-9_]+$/.test(error.message)
        ? error.message : "codex_no_tools_transport_invalid";
      if (turn) failAliveTurn(turn, failure(code));
      if (!outgoing.headersSent) outgoing.writeHead(422, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { message: code, type: "invalid_request_error", code } }));
    }
  };
  resource.server = http.createServer(handler);
  resource.server6 = http.createServer(handler);
  for (const server of [resource.server, resource.server6]) {
  server.on("connect", (incoming, socket, head) => {
    const turn = currentAliveTurn(resource, profile);
    if (!turn || incoming.url !== "auth.openai.com:443") { socket.destroy(); return; }
    const upstream = dependencies.connectAuth?.() ?? net.connect(443, "auth.openai.com");
    sockets.add(upstream); sockets.add(socket);
    const close = () => { upstream.destroy(); socket.destroy(); sockets.delete(upstream); sockets.delete(socket); };
    upstream.once("error", close); socket.once("error", close); upstream.once("close", close); socket.once("close", close);
    upstream.once("connect", () => {
      if (currentAliveTurn(resource, profile) !== turn) { close(); return; }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  server.on("upgrade", (_request, socket) => {
    const turn = currentAliveTurn(resource, profile);
    if (turn) failAliveTurn(turn, failure("codex_no_tools_websocket_denied"));
    socket.destroy();
  });
  }
  // Register before opening a socket or creating private files: a rejected
  // lifetime admission must not orphan a resource.
  unregister = profile.registerResource(`codex-no-tools:${bindingKey}`, () => resource.close());
  resource.ready = (async () => {
    resource.home = await fs.mkdtemp(path.join(os.tmpdir(), "agentlas-codex-alive-"));
    if (resource.closed) return;
    await new Promise<void>((resolve, reject) => {
      resource.server.once("error", reject); resource.server.listen(0, "127.0.0.1", resolve);
    });
    const address = resource.server.address();
    if (!address || typeof address === "string") throw new Error("codex_no_tools_gateway_unavailable");
    await new Promise<void>((resolve, reject) => { resource.server6.once("error", reject);
      resource.server6.listen({ port: address.port, host: "::1", ipv6Only: true }, resolve); });
    resource.baseUrl = `http://127.0.0.1:${address.port}${route}`;
  })();
  // Stop/disable/switch closes unconditionally even after the wake expires.
  return resource;
}
/** The gateway owns provider custody; admitted native pools own physical
 * residency when the host supplies the resident callback. Ordinary judgments
 * and JSON flags cannot enter this separate continuation lane. */
export async function runCodexAliveNoTools(
  req: RunnerRequest, events: RunnerEvents,
  execute: (args: string[], request: RunnerRequest) => Promise<RunnerResult>,
  dependencies: CodexNoToolsDependencies = {}, executionEnv: NodeJS.ProcessEnv = process.env,
): Promise<RunnerResult> {
  let profile: Readonly<AliveDecisionProfile> | null;
  let packet: AlivePacket | null;
  try {
    profile = aliveDecisionProfileForRequest(req);
    packet = profile ? agentContextNoToolsPacketForRequest(req) : null;
    if (!profile || !packet || !req.agentContext || agentContextSessionKey(req.agentContext) !== profile.resourceOwnerKey
      || packet.nativeHandle !== (req.runtimeSessionId ?? null) || consumedAliveCapabilities.has(req.agentContext)) {
      return { text: "", failure: failure("codex_no_tools_alive_admission_required"), ownerControlTerminal: "uncertain" };
    }
    profile.assertCurrent(); req.signal?.throwIfAborted();
    // Freeze host strings/schema before account/filesystem awaits. A later
    // caller mutation cannot change the already admitted instructions.
    req = { ...req, ...(req.outputSchema ? { outputSchema: JSON.parse(JSON.stringify(req.outputSchema)) } : {}) };
  } catch { return { text: "", failure: failure("codex_no_tools_alive_admission_required"), ownerControlTerminal: "uncertain" }; }
  consumedAliveCapabilities.add(req.agentContext!);
  // Match the ordinary no-tools account/provider fence without accessing auth
  // contents. The actual CLI still owns file/keyring sign-in and refresh.
  const accountHome = executionEnv.CODEX_HOME || path.join(os.homedir(), ".codex");
  let authStorage: string | undefined;
  try {
    const config = await fs.readFile(path.join(accountHome, "config.toml"), "utf8");
    const rootConfig = config.split(/^\s*\[/m)[0];
    authStorage = /^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto|secret|ephemeral)["']/m.exec(rootConfig)?.[1];
    if (/^\s*["']?profile["']?\s*=/m.test(rootConfig)) return { text: "", failure: failure("codex_no_tools_configured_profile_unavailable", "unavailable") };
    const provider = /^\s*["']?model_provider["']?\s*=\s*["']([^"']+)["']/m.exec(rootConfig)?.[1];
    if ((/^\s*["']?model_provider["']?\s*=/m.test(rootConfig) && provider !== "openai")
      || /^\s*\[\s*["']?model_providers["']?\s*\.\s*(?:openai|"openai"|'openai')\s*(?:\]|\.)/m.test(config)
      || /^\s*["']?model_providers["']?(?:\s*=|\s*\.\s*(?:openai|"openai"|'openai'))/m.test(rootConfig)
      || /^\s*\[\s*["']?model_providers["']?\s*\][^[]*^\s*(?:openai|"openai"|'openai')\s*=/m.test(config)) {
      return { text: "", failure: failure("codex_no_tools_custom_provider_unavailable", "unavailable") };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { text: "", failure: failure("codex_no_tools_account_config_unavailable", "unavailable") };
  }
  if (executionEnv.OPENAI_BASE_URL && executionEnv.OPENAI_BASE_URL.replace(/\/+$/, "") !== "https://api.openai.com/v1") {
    return { text: "", failure: failure("codex_no_tools_custom_provider_unavailable", "unavailable") };
  }
  const bindingKey = crypto.createHash("sha256").update(JSON.stringify([profile.bindingKey, accountHome, authStorage,
    req.model, req.effort, codexSystemPromptWithSchemaFallback(req), req.outputSchema,
    dependencies.residentFingerprint ?? (dependencies.resident ? "resident" : "exec")])).digest("hex");
  let resource = aliveGateways.get(profile.resourceOwnerKey);
  if (resource?.active) return { text: "", failure: failure("codex_no_tools_alive_busy", "unavailable"), ownerControlTerminal: "uncertain" };
  if (resource && (resource.bindingKey !== bindingKey || !profile.retainResource())) { await resource.close(); resource = undefined; }
  if (!profile.retainResource()) return { text: "", failure: failure("codex_no_tools_cancelled", "unavailable"), ownerControlTerminal: "uncertain" };
  if (!resource) { resource = createAliveGateway(profile, bindingKey, dependencies); aliveGateways.set(profile.resourceOwnerKey, resource); }
  const gateway = resource;
  const controller = new AbortController();
  let resolveNativeStarted!: () => void;
  const nativeStarted = new Promise<void>(resolve => { resolveNativeStarted = resolve; });
  const turn: AliveGatewayTurn = { req, packet, controller, admitted: false, authRejectCount: 0,
    nonce: crypto.randomBytes(24).toString("hex"), nativeStarted, resolveNativeStarted };
  gateway.active = turn;
  const abort = () => { failAliveTurn(turn, failure("codex_no_tools_cancelled", "unavailable")); controller.abort(); };
  req.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { failAliveTurn(turn, failure("codex_no_tools_timeout", "timeout")); controller.abort(); }, dependencies.timeoutMs ?? NO_TOOLS_TIMEOUT_MS);
  let terminalVerified = false;
  try {
    await gateway.ready;
    profile.assertCurrent(); if (req.signal?.aborted || gateway.closed) abort();
    if (controller.signal.aborted) return { text: "", failure: turn.failure, ownerControlTerminal: "uncertain" };
    const instructions = path.join(gateway.home, "instructions.md");
    await fs.writeFile(instructions, codexSystemPromptWithSchemaFallback(req), { mode: 0o600 });
    const schema = req.outputSchema ? openAiStrictSchemaOrNull(req.outputSchema.schema) : null;
    const schemaFile = schema ? path.join(gateway.home, "output-schema.json") : undefined;
    if (schemaFile) await fs.writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
    const window = dependencies.contextWindowTokens;
    const nativeBaseUrl = dependencies.resident ? gateway.baseUrl : `${gateway.baseUrl}/${turn.nonce}`;
    let args = codexNoToolsArgs(req, nativeBaseUrl, instructions, schemaFile, authStorage,
      window && Number.isSafeInteger(window) && window > 0 && window <= 10_000_000 ? window : undefined);
    args.splice(3, 1); // Remove only our fixed --ephemeral flag, never an argument value.
    if (packet.nativeHandle) {
      // exec resume has no --sandbox flag. Its config still stays read-only,
      // with no approval, tools, user config, web, retries or arbitrary endpoint.
      const sandbox = args.indexOf("--sandbox");
      args.splice(sandbox, 2);
      args.splice(1, 0, "resume");
      args.splice(args.length - 1, 0, "-c", 'sandbox_mode="read-only"', packet.nativeHandle);
    }
    const request: RunnerRequest = { ...req, userPrompt: packet.currentPrompt, history: [], cwd: gateway.home, signal: controller.signal,
      env: { ...executionEnv, CODEX_HOME: accountHome, CODEX_REFRESH_TOKEN_URL_OVERRIDE: undefined,
        HTTP_PROXY: gateway.baseUrl, HTTPS_PROXY: gateway.baseUrl, ALL_PROXY: gateway.baseUrl, NO_PROXY: "127.0.0.1,localhost" } };
    profile.assertCurrent(); if (req.signal?.aborted || gateway.closed) abort();
    if (controller.signal.aborted) return { text: "", failure: turn.failure, ownerControlTerminal: "uncertain" };
    events.onStatus(dependencies.resident
      ? "[runtime-session] judgment kind=codex enforcement=host_responses_no_tools continuity=native_resident provider=ws"
      : "[runtime-session] judgment kind=codex enforcement=host_responses_no_tools continuity=native_exec_resume process=one_shot provider=ws");
    let result: RunnerResult;
    try { result = dependencies.resident ? await dependencies.resident({ args, request, nonce: turn.nonce,
      onStarted(threadId, turnId) {
        profile.assertCurrent(); controller.signal.throwIfAborted();
        if (!threadId?.trim() || !turnId?.trim() || (turn.nativeIds
          && (turn.nativeIds.threadId !== threadId || turn.nativeIds.turnId !== turnId))) {
          failAliveTurn(turn, failure("codex_no_tools_native_turn_changed")); abort(); throw new Error("codex_no_tools_native_turn_changed");
        }
        turn.nativeIds = Object.freeze({ threadId, turnId }); turn.resolveNativeStarted();
      }, baseUrl: gateway.baseUrl, home: gateway.home, accountHome, authStorage,
      contextWindowTokens: window, systemPrompt: codexSystemPromptWithSchemaFallback(req), packet }) : await execute(args, request); }
    catch (error) { if (!turn.failure) throw error; return { text: "", failure: turn.failure, ownerControlTerminal: "uncertain" }; }
    // Only the production callback's measured thread.started plus completed
    // native terminal can persist a handle; input IDs never fabricate a receipt.
    const { sessionId, ...withoutHandle } = result;
    profile.assertCurrent();
    if (turn.failure || turn.pendingAuthFailure || result.failure) {
      return { ...withoutHandle, text: "", failure: turn.failure ?? turn.pendingAuthFailure ?? result.failure, ownerControlTerminal: "uncertain" };
    }
    if (!turn.finalText || result.text.trim() !== turn.finalText || result.ownerControlTerminal !== "completed"
      || typeof sessionId !== "string" || !sessionId.trim()
      || (dependencies.resident ? !turn.nativeIds || sessionId !== turn.nativeIds.threadId
        || dependencies.verifyResidentResult?.(result, turn.nonce, packet.nativeHandle) !== true
        : packet.nativeHandle && sessionId !== packet.nativeHandle)
      || req.signal?.aborted || controller.signal.aborted || gateway.closed) {
      return { ...withoutHandle, text: "", failure: failure("codex_no_tools_result_unverified"), ownerControlTerminal: "uncertain" };
    }
    gateway.provider.stageTerminal(turn.req, result);
    terminalVerified = true;
    return result; // Core ACK is bound to this exact native result object.
  } finally {
    clearTimeout(timer); req.signal?.removeEventListener("abort", abort); controller.abort();
    for (const socket of gateway.sockets) socket.destroy();
    gateway.server.closeAllConnections();
    gateway.server6.closeAllConnections();
    if (gateway.active === turn) gateway.active = null;
    if (!terminalVerified || !profile.retainResource()) await gateway.close();
  }
}
