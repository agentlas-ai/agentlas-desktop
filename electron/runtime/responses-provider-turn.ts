import { agentContextDeliveryForRequest, agentContextTransportForRequest } from "./agent-context";
import type { AgentContextDelivery } from "../store/agent-context";
import type { ChatMessage, OpenAiToolDef } from "./local-tool-loop";
import type { ResponsesContextPolicy } from "./responses-context-policy";
import type { RunnerRequest } from "./runner";

type ToolCall = NonNullable<Extract<ChatMessage, { role: "assistant" }>["tool_calls"]>[number];
type ObjectValue = Record<string, unknown>;
export type ResponsesGuardPhase = "egress" | "partial" | "thinking" | "terminal" | "group" | "final-handle";
/** Structural counterpart of the canonical loop's private StreamTurnResult. */
export interface ResponsesStreamTurnResult {
  terminalObserved: boolean;
  finishReason?: string;
  text: string;
  toolCalls: ToolCall[];
  missingToolCallIds: boolean;
  incompleteToolCalls: boolean;
  terminalUsage?: { inputTokens: number; outputTokens: number };
}
export interface ResponsesLoopTurn {
  messages: readonly ChatMessage[];
  tools: readonly OpenAiToolDef[];
  model: string;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_schema"; json_schema: { name: string; schema: unknown; strict: true } };
}
export interface ResponsesLoopTransportDependencies {
  /** The canonical loop owns headers, cancellation, History/Science authority
   * and the actual HTTP call. This transport never calls fetch or dispatches. */
  send(endpoint: string, body: Readonly<ObjectValue>): Promise<Response>;
  assertCurrent(phase: ResponsesGuardPhase): void;
  onPartial?(text: string): void;
  onThinking?(text: string): void;
}
interface ParsedResponse {
  result: ResponsesStreamTurnResult;
  responseId: string;
  locations: Map<string, { responseIndex: number; partIndex: number }>;
  retainable: boolean;
}
interface PendingResponse {
  parsed: ParsedResponse;
  messages: ChatMessage[];
  result: ResponsesStreamTurnResult;
}
interface MissingProof { request: RunnerRequest; delivery: AgentContextDelivery; policy: Readonly<ResponsesContextPolicy> }
const missingProofs = new WeakMap<object, MissingProof>();
const httpStatuses = new WeakMap<object, number>();
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 512; }
function index(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function json(text: string): unknown { try { return JSON.parse(text); } catch { fail("responses_json_invalid"); } }
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, offset) => same(value, b[offset]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a), other = Object.keys(b);
  return keys.length === other.length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
/** Lets the canonical loop retain its existing HTTP classification without
 * trusting an arbitrary exception's status/code fields. No retry authority. */
export function responsesProviderHttpStatus(error: unknown): number | null {
  return object(error) ? httpStatuses.get(error) ?? null : null;
}

/** Only an exact first-step structured rejection can reset the next admitted
 * generation. Neither an HTTP status nor provider prose authorizes replay. */
export function consumeResponsesPreviousContextMissingProof(error: unknown, request: RunnerRequest): boolean {
  if (!object(error)) return false;
  const proof = missingProofs.get(error);
  if (!proof || proof.request.agentContext !== request.agentContext
    || agentContextDeliveryForRequest(request) !== proof.delivery
    || agentContextTransportForRequest(request)?.policy !== proof.policy) return false;
  missingProofs.delete(error);
  return true;
}

function encodeMessages(messages: readonly ChatMessage[]): ObjectValue[] {
  const input: ObjectValue[] = [];
  for (let offset = 0; offset < messages.length; offset += 1) {
    const message = messages[offset];
    if (message.role === "tool") fail("responses_orphan_tool_result");
    if (message.role === "assistant") {
      if (message.content) input.push({ role: "assistant", content: message.content });
      const calls = message.tool_calls ?? [];
      const ids = new Set<string>();
      for (const call of calls) {
        if (!id(call.id) || ids.has(call.id) || call.type !== "function" || !id(call.function.name)
          || typeof call.function.arguments !== "string") fail("responses_input_tool_group_invalid");
        ids.add(call.id);
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
      for (const call of calls) {
        const result = messages[++offset];
        if (!result || result.role !== "tool" || result.tool_call_id !== call.id) fail("responses_input_tool_group_invalid");
        input.push({ type: "function_call_output", call_id: result.tool_call_id, output: result.content });
      }
    } else {
      const content = typeof message.content === "string" ? message.content : message.content.map(part => {
        if (part.type === "text") return { type: "input_text", text: part.text };
        if (part.type === "image_url" && typeof part.image_url?.url === "string")
          return { type: "input_image", image_url: part.image_url.url };
        return fail("responses_input_content_unsupported");
      });
      input.push({ role: message.role, content });
    }
  }
  return input;
}
function usage(value: unknown): ResponsesStreamTurnResult["terminalUsage"] {
  if (!object(value) || !index(value.input_tokens) || !index(value.output_tokens)) return undefined;
  return { inputTokens: value.input_tokens, outputTokens: value.output_tokens };
}
function parseCompleted(response: unknown, responseIndex: number, tools: readonly OpenAiToolDef[]): ParsedResponse {
  if (!object(response) || !id(response.id) || response.object !== "response" || !Array.isArray(response.output))
    fail("responses_terminal_invalid");
  const status = response.status;
  if (status !== "completed" && status !== "incomplete") fail("responses_terminal_failed");
  if (status === "completed" && response.store === false) fail("responses_context_not_retained");
  if (status === "completed" && (response.error != null || response.incomplete_details != null)) fail("responses_terminal_invalid");
  const names = new Set(tools.map(tool => tool.function.name));
  const itemIds = new Set<string>(), callIds = new Set<string>();
  const calls: ToolCall[] = [], locations = new Map<string, { responseIndex: number; partIndex: number }>();
  let text = "", refused = false;
  for (const [partIndex, item] of response.output.entries()) {
    if (!object(item) || !id(item.id) || itemIds.has(item.id)) fail("responses_item_identity_invalid");
    itemIds.add(item.id);
    if (status === "completed" && item.status !== undefined && item.status !== "completed") fail("responses_item_unfinished");
    if (item.type === "function_call" && status === "incomplete") {
      // A finalized incomplete response can account for measured usage, but
      // its unfinished function frame can never enter the Main dispatcher.
      continue;
    } else if (item.type === "function_call") {
      if (item.status !== "completed" || !id(item.call_id) || callIds.has(item.call_id)
        || !id(item.name) || !names.has(item.name) || typeof item.arguments !== "string") fail("responses_function_call_invalid");
      const args = json(item.arguments);
      if (!object(args)) fail("responses_function_arguments_invalid");
      callIds.add(item.call_id);
      calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
      locations.set(item.call_id, { responseIndex, partIndex });
    } else if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)
        || (status === "completed" && item.status !== "completed")) fail("responses_message_invalid");
      for (const part of item.content) {
        if (!object(part)) fail("responses_content_invalid");
        if (part.type === "output_text" && typeof part.text === "string") text += part.text;
        else if (part.type === "refusal" && typeof part.refusal === "string") { refused = true; text += part.refusal; }
        else fail("responses_content_unsupported");
      }
    } else if (item.type === "reasoning") {
      if (!Array.isArray(item.summary) || item.summary.some(part => !object(part)
        || part.type !== "summary_text" || typeof part.text !== "string")) fail("responses_reasoning_invalid");
    } else fail("responses_output_item_unsupported");
  }
  if (refused && calls.length) fail("responses_refusal_tool_group_invalid");
  let finishReason = calls.length ? "tool_calls" : "stop";
  if (refused) finishReason = "content_filter";
  if (status === "incomplete") {
    const reason = object(response.incomplete_details) ? response.incomplete_details.reason : null;
    if (reason === "max_output_tokens") finishReason = "length";
    else if (reason === "content_filter") finishReason = "content_filter";
    else fail("responses_incomplete_reason_unknown");
  }
  const retainable = status === "completed" && !refused;
  return { responseId: response.id, locations, retainable, result: {
    terminalObserved: true, finishReason, text, toolCalls: retainable ? calls : [],
    missingToolCallIds: false, incompleteToolCalls: status !== "completed",
    ...(usage(response.usage) ? { terminalUsage: usage(response.usage) } : {}),
  } };
}

interface StreamItem { initial: ObjectValue; done?: ObjectValue; args: string; argsDone?: string; parts: Map<number, { type: string; text: string; done?: ObjectValue; textDone?: string }> }
async function parseStream(response: Response, responseIndex: number, tools: readonly OpenAiToolDef[],
  check: (phase: ResponsesGuardPhase) => void, dependencies: ResponsesLoopTransportDependencies): Promise<ParsedResponse> {
  if (!response.body) fail("responses_body_missing");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const items = new Map<number, StreamItem>();
  let responseId: string | null = null, sequence = -1, terminal: ObjectValue | null = null, buffer = "", bytes = 0;
  const terminalResponse = (): ObjectValue | null => terminal;
  const requireItem = (event: ObjectValue): StreamItem => {
    if (!index(event.output_index)) fail("responses_item_index_invalid");
    const item = items.get(event.output_index);
    if (!item || item.initial.id !== event.item_id || item.done) fail("responses_item_correlation_invalid");
    return item;
  };
  const process = (frame: string): void => {
    const lines = frame.split("\n"), data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { if (!terminal) fail("responses_terminal_missing"); return; }
    if (terminal) fail("responses_event_after_terminal");
    const event = json(data);
    if (!object(event) || typeof event.type !== "string" || !index(event.sequence_number)
      || event.sequence_number <= sequence) fail("responses_event_sequence_invalid");
    const named = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (named && named !== event.type) fail("responses_event_name_mismatch");
    sequence = event.sequence_number;
    if (event.type === "response.created" || event.type === "response.in_progress") {
      if (!object(event.response) || !id(event.response.id) || (responseId && responseId !== event.response.id)) fail("responses_response_identity_invalid");
      responseId = event.response.id; return;
    }
    if (!responseId) fail("responses_response_identity_missing");
    if (event.type === "response.completed" || event.type === "response.incomplete") {
      if (!object(event.response) || event.response.id !== responseId
        || event.response.status !== event.type.slice("response.".length)) fail("responses_terminal_identity_invalid");
      terminal = event.response; return;
    }
    if (event.type === "response.failed" || event.type === "error") fail("responses_terminal_failed");
    if (event.type === "response.output_item.added") {
      if (!index(event.output_index) || items.has(event.output_index) || !object(event.item) || !id(event.item.id)
        || [...items.values()].some(item => item.initial.id === (event.item as ObjectValue).id)) fail("responses_item_identity_invalid");
      if (!["message", "function_call", "reasoning"].includes(String(event.item.type))) fail("responses_output_item_unsupported");
      items.set(event.output_index, { initial: event.item, args: "", parts: new Map() }); return;
    }
    if (event.type === "response.output_item.done") {
      if (!object(event.item)) fail("responses_item_invalid");
      const item = requireItem({ ...event, item_id: event.item.id });
      if (event.item.type !== item.initial.type) fail("responses_item_type_changed");
      if (item.initial.type === "function_call" && (event.item.call_id !== item.initial.call_id
        || event.item.name !== item.initial.name || item.argsDone === undefined
        || event.item.arguments !== item.argsDone)) fail("responses_function_correlation_invalid");
      item.done = event.item; return;
    }
    const item = requireItem(event);
    if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") {
      if (item.initial.type !== "function_call" || item.argsDone !== undefined) fail("responses_function_correlation_invalid");
      if (event.type.endsWith(".delta")) {
        if (typeof event.delta !== "string") fail("responses_function_arguments_invalid"); item.args += event.delta;
      } else {
        if (typeof event.arguments !== "string" || event.arguments !== item.args) fail("responses_function_arguments_mismatch"); item.argsDone = event.arguments;
      }
      return;
    }
    const summary = event.type.startsWith("response.reasoning_summary_");
    const partIndex = summary ? event.summary_index : event.content_index;
    if (!index(partIndex)) fail("responses_content_index_invalid");
    if (event.type === "response.content_part.added" || event.type === "response.reasoning_summary_part.added") {
      if (item.parts.has(partIndex) || !object(event.part) || typeof event.part.type !== "string") fail("responses_part_identity_invalid");
      const expected = summary ? "summary_text" : "output_text";
      if (event.part.type !== expected && !(expected === "output_text" && event.part.type === "refusal")) fail("responses_content_unsupported");
      if (item.initial.type !== (summary ? "reasoning" : "message")) fail("responses_part_type_mismatch");
      item.parts.set(partIndex, { type: event.part.type, text: "" }); return;
    }
    const part = item.parts.get(partIndex);
    if (!part || part.done) fail("responses_part_correlation_invalid");
    if (event.type === "response.content_part.done" || event.type === "response.reasoning_summary_part.done") {
      if (!object(event.part) || event.part.type !== part.type || part.textDone === undefined
        || (part.type === "refusal" ? event.part.refusal : event.part.text) !== part.textDone) fail("responses_part_terminal_mismatch");
      part.done = event.part; return;
    }
    const prefix = summary ? "response.reasoning_summary_text" : part.type === "refusal" ? "response.refusal" : "response.output_text";
    if (event.type === `${prefix}.delta`) {
      if (part.textDone !== undefined || typeof event.delta !== "string") fail("responses_part_delta_invalid");
      part.text += event.delta;
      check(summary ? "thinking" : "partial");
      if (summary) dependencies.onThinking?.(event.delta); else dependencies.onPartial?.(event.delta);
    } else if (event.type === `${prefix}.done`) {
      const text = part.type === "refusal" ? event.refusal : event.text;
      if (part.textDone !== undefined || typeof text !== "string" || text !== part.text) fail("responses_part_text_mismatch");
      part.textDone = text;
    } else if (event.type === "response.output_text.annotation.added" && part.type === "output_text") {
      // Annotations confer no host capability. Their containing part is still
      // checked against the finalized item/response before terminal acceptance.
    } else fail("responses_stream_event_unsupported");
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      check("partial");
      if (chunk.done) { buffer += decoder.decode(); break; }
      bytes += chunk.value.byteLength;
      if (bytes > 32 * 1024 * 1024) fail("responses_stream_envelope_limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) { process(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
    }
    if (buffer.trim()) process(buffer);
    const final = terminalResponse();
    if (!final) fail("responses_terminal_missing");
    const parsed = parseCompleted(final, responseIndex, tools);
    if (final.status === "completed") {
      const output = final.output as ObjectValue[];
      if (items.size !== output.length) fail("responses_item_group_incomplete");
      for (const [offset, finalItem] of output.entries()) {
        const item = items.get(offset);
        if (!item?.done || !same(item.done, finalItem)) fail("responses_item_terminal_mismatch");
        const parts = finalItem.type === "reasoning" ? finalItem.summary : finalItem.type === "message" ? finalItem.content : [];
        if (!Array.isArray(parts) || item.parts.size !== parts.length) fail("responses_part_group_incomplete");
        for (const [partOffset, finalPart] of parts.entries()) {
          if (!same(item.parts.get(partOffset)?.done, finalPart)) fail("responses_part_terminal_mismatch");
        }
      }
    }
    check("terminal"); return parsed;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** One invocation's retained provider chain; the existing canonical loop alone
 * confirms steps and dispatches tools. Cross-invocation retention remains the
 * opaque core delivery's responsibility, after its canonical journal ACK. */
export function createResponsesProviderTurn(request: RunnerRequest, dependencies: ResponsesLoopTransportDependencies) {
  const transport = agentContextTransportForRequest(request), delivery = agentContextDeliveryForRequest(request);
  if (!transport || !delivery || typeof dependencies.assertCurrent !== "function" || typeof dependencies.send !== "function")
    fail("responses_active_host_transport_required");
  let previousId = delivery.nativeHandle, steps = 0, closed = false, busy = false;
  let confirmedMessages: ChatMessage[] | null = null, nextInputOffset = 0;
  let pending: PendingResponse | null = null;
  let confirmed: PendingResponse | null = null;
  const check = (phase: ResponsesGuardPhase): void => {
    request.signal?.throwIfAborted();
    if (closed || agentContextDeliveryForRequest(request) !== delivery || agentContextTransportForRequest(request) !== transport)
      fail("responses_active_delivery_changed");
    dependencies.assertCurrent(phase);
  };
  return {
    async exchange(turn: ResponsesLoopTurn): Promise<ResponsesStreamTurnResult> {
      check("egress");
      if (busy || pending) fail("responses_step_confirmation_required");
      busy = true;
      try {
        // Bind the complete protected input/inventory before the first await.
        // A caller mutating its message array during streaming cannot bless
        // an unsent prefix or add an unoffered tool to the terminal group.
        turn = copy(turn);
        if (turn.model !== request.model || !id(turn.model)) fail("responses_model_binding_changed");
        if (turn.messages[0]?.role !== "system" || turn.messages[0].content !== transport.packet.systemPrompt)
          fail("responses_stable_prefix_changed");
        let inputMessages = turn.messages;
        if (confirmedMessages) {
          if (!same(turn.messages.slice(0, confirmedMessages.length), confirmedMessages)) fail("responses_canonical_prefix_changed");
          inputMessages = turn.messages.slice(nextInputOffset);
        } else if (previousId) {
          let start = 0; while (turn.messages[start]?.role === "system") start += 1;
          inputMessages = turn.messages.slice(start);
        }
        if (previousId && inputMessages.some(row => row.role === "system")) fail("responses_warm_contract_changed");
        const names = new Set<string>();
        const tools = turn.tools.map(tool => {
          if (tool.type !== "function" || !id(tool.function.name) || names.has(tool.function.name)
            || !object(tool.function.parameters)) fail("responses_tool_inventory_invalid");
          names.add(tool.function.name);
          // Chat's canonical inventory is non-strict; Responses otherwise
          // normalizes optional fields into required parameters by default.
          return { type: "function", name: tool.function.name, strict: false,
            ...(tool.function.description !== undefined ? { description: tool.function.description } : {}), parameters: tool.function.parameters };
        });
        const input = confirmedMessages ? inputMessages.map(row => {
          if (row.role === "tool") return { type: "function_call_output", call_id: row.tool_call_id, output: row.content };
          return null;
        }) : null;
        // The confirmed whole tool-result group starts this incremental slice.
        let encoded: ObjectValue[];
        if (input) {
          let toolsEnd = 0; while (input[toolsEnd] !== null && toolsEnd < input.length) toolsEnd += 1;
          encoded = [...input.slice(0, toolsEnd) as ObjectValue[], ...encodeMessages(inputMessages.slice(toolsEnd))];
        } else encoded = encodeMessages(inputMessages);
        if (!encoded.length) fail("responses_new_input_required");
        const body: ObjectValue = { model: turn.model, stream: true, store: true, truncation: "disabled", input: encoded,
          ...(previousId ? { previous_response_id: previousId } : {}), ...(tools.length ? { tools } : {}) };
        if (turn.temperature !== undefined) body.temperature = turn.temperature;
        if (turn.max_tokens !== undefined) body.max_output_tokens = turn.max_tokens;
        if (turn.response_format) {
          if (turn.response_format.type !== "json_schema" || turn.response_format.json_schema.strict !== true) fail("responses_output_schema_unsupported");
          body.text = { format: { type: "json_schema", ...turn.response_format.json_schema } };
        }
        check("egress");
        const response = await dependencies.send(transport.policy.endpoint, body);
        check("terminal");
        if (!response.ok) {
          const error = Object.assign(new Error("responses_http_rejected"), { code: "responses_http_rejected", status: response.status });
          httpStatuses.set(error, response.status);
          if (steps === 0 && previousId && [400, 404].includes(response.status)) {
            const text = await response.text();
            let rejection: unknown;
            try { rejection = JSON.parse(text); } catch { /* Only JSON syntax; guards remain outside this catch. */ }
            check("terminal");
            if (object(rejection) && object(rejection.error) && rejection.error.code === "previous_response_not_found"
              && rejection.error.param === "previous_response_id") missingProofs.set(error, { request, delivery, policy: transport.policy });
          }
          throw error;
        }
        const streamed = response.headers.get("content-type")?.split(";")[0].trim() === "text/event-stream";
        const parsed = streamed
          ? await parseStream(response, steps, turn.tools, check, dependencies)
          : parseCompleted(json(await response.text()), steps, turn.tools);
        check("terminal");
        if (!streamed && parsed.result.text) { check("partial"); dependencies.onPartial?.(parsed.result.text); }
        for (const call of parsed.result.toolCalls) { Object.freeze(call.function); Object.freeze(call); }
        Object.freeze(parsed.result.toolCalls);
        if (parsed.result.terminalUsage) Object.freeze(parsed.result.terminalUsage);
        Object.freeze(parsed.result);
        pending = { parsed, messages: copy([...turn.messages]), result: parsed.result };
        return parsed.result;
      } catch (error) { closed = true; throw error; }
      finally { busy = false; }
    },
    confirmStep(result: ResponsesStreamTurnResult, messages: readonly ChatMessage[]): void {
      check("group");
      if (!pending || result !== pending.result || !pending.parsed.retainable) fail("responses_confirmed_terminal_required");
      if (!same(messages.slice(0, pending.messages.length), pending.messages)) fail("responses_canonical_prefix_changed");
      const suffix = messages.slice(pending.messages.length);
      const own: ChatMessage = { role: "assistant", content: result.text,
        ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) };
      if (result.toolCalls.length || suffix.length) {
        if (!same(suffix[0], own)) fail("responses_own_assistant_mismatch");
        for (const [offset, call] of result.toolCalls.entries()) {
          const row = suffix[offset + 1];
          if (!row || row.role !== "tool" || row.tool_call_id !== call.id) fail("responses_result_group_incomplete");
        }
        if (suffix.slice(result.toolCalls.length + 1).some(row => row.role === "tool" || row.role === "assistant")) fail("responses_result_group_invalid");
      }
      previousId = pending.parsed.responseId;
      nextInputOffset = pending.messages.length + (suffix.length ? 1 : 0);
      confirmedMessages = copy([...messages]); confirmed = pending; pending = null; steps += 1;
    },
    callLocation(result: ResponsesStreamTurnResult, callId: string): Readonly<{ responseIndex: number; partIndex: number }> | null {
      check("group");
      const held = pending?.result === result ? pending : confirmed?.result === result ? confirmed : null;
      const location = held?.parsed.locations.get(callId);
      return location ? Object.freeze({ ...location }) : null;
    },
    finalHandle(result: ResponsesStreamTurnResult): string {
      check("final-handle");
      if (!confirmed || confirmed.result !== result || pending || busy || result.toolCalls.length
        || result.finishReason !== "stop" || !confirmed.parsed.retainable) fail("responses_final_terminal_required");
      return confirmed.parsed.responseId;
    },
    abandon(): void { closed = true; pending = null; confirmed = null; previousId = null; },
  };
}
