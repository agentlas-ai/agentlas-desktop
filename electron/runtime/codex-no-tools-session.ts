import crypto from "node:crypto";
import type { EventEmitter } from "node:events";
import type { RunnerRequest, RunnerResult } from "./runner";
import { aliveDecisionProfileForRequest } from "./alive-decision-context";
import { openAiStrictSchemaOrNull } from "./strict-output-schema";
import { agentContextNoToolsPacketForRequest, registerAliveAgentContextTerminalAck,
  consumeAliveAgentContextTerminalAck, type AgentContextNoToolsPacket } from "./agent-context";

const MAX_BYTES = 4 * 1024 * 1024;
const ENDPOINTS = { api: "wss://api.openai.com/v1/responses", subscription: "wss://chatgpt.com/backend-api/codex/responses" } as const;
type Row = Readonly<{ role: "user" | "assistant"; text: string }>;
type SocketData = Buffer | ArrayBuffer | Buffer[];
interface ProviderSocket extends EventEmitter {
  readyState: number;
  send(data: string, callback: (error?: Error) => void): void;
  terminate(): void;
}
// ws is an existing product dependency. Keep its small transport ABI local;
// this checkout deliberately has no @types/ws dependency to add or install.
const WebSocket = require("ws") as { new(endpoint: string, options: Record<string, unknown>): ProviderSocket; CLOSED: number };
type Lineage = { contextKey: string; bindingKey: string; generation: number; observedThroughSeq: number; responseId: string };
type Pending = { request: RunnerRequest; packet: Readonly<AgentContextNoToolsPacket>; responseId: string;
  sse: string; text: string; unregister?: () => void };
export class CodexNoToolsSessionError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly preDispatch = false) { super(code); }
}
export interface CodexNoToolsProviderExchange {
  request: RunnerRequest;
  packet: Readonly<AgentContextNoToolsPacket>;
  headers: Readonly<Record<string, string>>;
  hostInstructions: string;
  signal: AbortSignal;
  assertCurrent(): void;
}
export interface CodexNoToolsProviderSession {
  exchange(input: CodexNoToolsProviderExchange): Promise<{ sse: string; text: string; providerResponseId: string }>;
  stageTerminal(request: RunnerRequest, result: RunnerResult): void;
  close(): Promise<void>;
}
/** Private test transport, never a renderer/model-selected URL or socket. */
export interface CodexNoToolsProviderSessionOptions {
  bindingKey: string;
  validate(sse: string): string;
  onInvalidated?(): void | Promise<void>;
  connect?: (endpoint: typeof ENDPOINTS[keyof typeof ENDPOINTS], headers: Record<string, string>) => ProviderSocket;
}
function frameRow(row: Row) {
  return { type: "message", role: row.role, content: [{ type: row.role === "assistant" ? "output_text" : "input_text", text: row.text }] };
}
function fail(code: string): never { throw new CodexNoToolsSessionError(code); }
/** Host-owned provider state. The native thread handle never occupies responseId. */
export function createCodexNoToolsProviderSession(options: CodexNoToolsProviderSessionOptions): CodexNoToolsProviderSession {
  let socket: ProviderSocket | undefined, headerFence: string | undefined, lineage: Lineage | undefined;
  let pending: Pending | undefined, exchanging = false, closed = false, closePromise: Promise<void> | undefined;
  let idleMessage: (() => void) | undefined;
  const detach = () => { pending?.unregister?.(); pending = undefined; lineage = undefined; };
  const retireSocket = async () => {
    const held = socket; socket = undefined; headerFence = undefined; lineage = undefined;
    if (held && idleMessage) held.off("message", idleMessage); idleMessage = undefined;
    if (!held || held.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { held.once("close", () => resolve()); held.terminate(); });
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true; detach(); closePromise = retireSocket(); return closePromise;
  };
  const invalidate = () => { void close(); try { void Promise.resolve(options.onInvalidated?.()).catch(() => {}); } catch {} };
  return {
    close,
    async exchange(input) {
      if (closed || exchanging || pending) fail("codex_no_tools_provider_custody_pending");
      const profile = aliveDecisionProfileForRequest(input.request);
      if (!profile) fail("codex_no_tools_alive_admission_required");
      profile.assertCurrent(); input.assertCurrent(); input.signal.throwIfAborted();
      const packet = agentContextNoToolsPacketForRequest(input.request);
      if (!packet || ["contextKey", "bindingKey", "generation", "fromSeq", "throughSeq", "turnId"].some(key =>
        packet[key as keyof AgentContextNoToolsPacket] !== input.packet[key as keyof AgentContextNoToolsPacket])) fail("codex_no_tools_provider_delivery_changed");
      // Never accept authority or current/prior input from the native HTTP body.
      const headers: Record<string, string> = {};
      for (const key of ["authorization", "chatgpt-account-id", "openai-beta", "originator", "user-agent"] as const) {
        if (typeof input.headers[key] === "string") headers[key] = input.headers[key];
      }
      const endpoint = headers["chatgpt-account-id"] ? ENDPOINTS.subscription : ENDPOINTS.api;
      const identity = crypto.createHash("sha256").update(JSON.stringify([options.bindingKey, endpoint,
        headers.authorization ?? null, headers["chatgpt-account-id"] ?? null])).digest("hex");
      const warm = !!lineage && lineage.contextKey === packet.contextKey && lineage.bindingKey === packet.bindingKey
        && lineage.generation === packet.generation && lineage.observedThroughSeq === packet.fromSeq && headerFence === identity;
      if (socket && !warm) await retireSocket();
      if (closed) fail("codex_no_tools_cancelled");
      const current = frameRow({ role: "user", text: packet.currentPrompt });
      const seed = !warm ? [{ type: "message", role: "developer", content: [{ type: "input_text", text: input.hostInstructions }] }] : [];
      const rows = (warm ? packet.deltaRows : packet.priorRows).map(frameRow);
      if (!warm) while (rows.length && (Buffer.byteLength(JSON.stringify(rows)) > 8192
        || Buffer.byteLength(JSON.stringify([...seed, ...rows, current])) > 16 * 1024)) rows.shift();
      if (Buffer.byteLength(JSON.stringify(rows)) > 8192 || Buffer.byteLength(JSON.stringify([...seed, ...rows, current])) > 16 * 1024) fail("codex_no_tools_context_budget_exceeded");
      const create: Record<string, unknown> = { type: "response.create", model: input.request.model, store: false, instructions: "",
        input: [...seed, ...rows, current],
        tools: [], tool_choice: "none", parallel_tool_calls: false,
        ...(warm ? { previous_response_id: lineage!.responseId } : {}),
        ...(input.request.effort ? { reasoning: { effort: input.request.effort } } : {}),
        max_output_tokens: input.request.maxOutputTokens };
      const schema = input.request.outputSchema && openAiStrictSchemaOrNull(input.request.outputSchema.schema);
      if (schema) create.text = { format: { type: "json_schema", name: input.request.outputSchema!.name, strict: true, schema } };
      exchanging = true;
      let sent = false;
      try {
        if (!socket) {
          const held = options.connect?.(endpoint, headers) ?? new WebSocket(endpoint, { headers, maxPayload: MAX_BYTES,
            perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10_000 });
          socket = held; headerFence = identity;
          held.on("error", () => { /* The current exchange owns its typed failure. */ });
          held.on("close", () => { if (socket === held) { socket = undefined; headerFence = undefined; lineage = undefined;
            pending?.unregister?.(); pending = undefined; } });
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { held.off("open", open); held.off("error", error); held.off("close", lost);
              held.off("unexpected-response", unexpected); input.signal.removeEventListener("abort", abort); };
            const open = () => { cleanup(); resolve(); };
            const error = () => { cleanup(); reject(new CodexNoToolsSessionError("codex_no_tools_provider_connection_failed", undefined, true)); };
            const lost = () => { cleanup(); reject(new CodexNoToolsSessionError("codex_no_tools_provider_connection_failed", undefined, true)); };
            const abort = () => { cleanup(); held.terminate(); reject(new CodexNoToolsSessionError("codex_no_tools_cancelled")); };
            const unexpected = (_request: unknown, response: { statusCode?: number }) => {
              cleanup(); response && held.terminate(); reject(new CodexNoToolsSessionError("codex_no_tools_provider_handshake_failed", response.statusCode, true)); };
            held.once("open", open); held.once("error", error); held.once("close", lost); held.once("unexpected-response", unexpected);
            input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
          });
        }
        const held = socket!;
        profile.assertCurrent(); input.assertCurrent(); input.signal.throwIfAborted();
        if (idleMessage) held.off("message", idleMessage); idleMessage = undefined;
        const result = await new Promise<{ sse: string; text: string; providerResponseId: string }>((resolve, reject) => {
          const frames: string[] = []; let bytes = 0, createdId: string | undefined, done = false;
          const cleanup = () => { held.off("message", message); held.off("close", lost); held.off("error", lost); input.signal.removeEventListener("abort", abort); };
          const deny = (error: unknown) => { if (done) return; done = true; cleanup(); reject(error); };
          const lost = () => deny(new CodexNoToolsSessionError("codex_no_tools_provider_stream_unsettled"));
          const abort = () => deny(new CodexNoToolsSessionError("codex_no_tools_cancelled"));
          const message = (raw: SocketData, binary: boolean) => {
            try {
              profile.assertCurrent(); input.assertCurrent(); input.signal.throwIfAborted();
              if (binary) fail("codex_no_tools_response_encoding_unknown");
              const buffer = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
              bytes += buffer.length; if (bytes > MAX_BYTES) fail("codex_no_tools_wire_too_large");
              const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
              const frame = JSON.parse(text);
              if (!frame || typeof frame !== "object" || typeof frame.type !== "string" || /[\r\n]/.test(frame.type)) fail("codex_no_tools_frame_unknown");
              frames.push(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
              if (frame.type === "response.created") {
                if (createdId || typeof frame.response?.id !== "string" || !frame.response.id.trim()) fail("codex_no_tools_provider_identity_invalid");
                createdId = frame.response.id;
              }
              if (["response.completed", "response.failed", "response.incomplete", "error"].includes(frame.type)) {
                const sse = frames.join(""), output = options.validate(sse);
                if (!createdId || frame.type !== "response.completed" || frame.response?.id !== createdId) fail("codex_no_tools_provider_identity_invalid");
                done = true; cleanup(); resolve({ sse, text: output, providerResponseId: createdId });
              }
            } catch (error) { deny(error); }
          };
          held.on("message", message); held.once("close", lost); held.once("error", lost); input.signal.addEventListener("abort", abort, { once: true });
          sent = true; held.send(JSON.stringify(create), error => { if (error) lost(); });
        });
        profile.assertCurrent(); input.assertCurrent(); input.signal.throwIfAborted();
        pending = { request: input.request, packet, responseId: result.providerResponseId, sse: result.sse, text: result.text };
        // Any additional native background response cannot belong to a new wake.
        idleMessage = invalidate;
        socket!.once("message", idleMessage);
        return result;
      } catch (error) {
        // A conclusively rejected handshake has not dispatched input and may
        // retain the CLI's existing 401 refresh admission. Nothing else retries.
        await retireSocket();
        if (sent || !(error instanceof CodexNoToolsSessionError && error.preDispatch && error.httpStatus === 401)) invalidate();
        throw error;
      } finally { exchanging = false; }
    },
    stageTerminal(request, result) {
      const held = pending;
      if (!held || held.request !== request || result.ownerControlTerminal !== "completed" || result.failure
        || result.text.trim() !== held.text || typeof result.sessionId !== "string" || !result.sessionId.trim()) fail("codex_no_tools_provider_terminal_unverified");
      held.unregister = registerAliveAgentContextTerminalAck(request, result, {
        onAck(receipt) {
          if (pending !== held || closed || !socket || !consumeAliveAgentContextTerminalAck(receipt, request, result)) { invalidate(); return; }
          lineage = { contextKey: receipt.contextKey, bindingKey: receipt.bindingKey, generation: receipt.generation,
            observedThroughSeq: receipt.observedThroughSeq, responseId: held.responseId };
          pending = undefined;
        },
        onAbandon() { invalidate(); },
      });
    },
  };
}
