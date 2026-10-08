import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import { openAiStrictSchemaOrNull, codexSystemPromptWithSchemaFallback } from "./strict-output-schema";
import type { RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";

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
