/*
 * DeepSeek Responses wire for the BYOK tool loop (docs/2026-10-13-native-harness/13 §7, "DeepSeek Responses").
 *
 * A separate transport, not a capability upgrade: the official compatibility page (api-docs.deepseek.com/guides/
 * responses_api, checked 2026-10-14) is stateless — no previous_response_id, conversation, store, background,
 * prompt_cache_key/retention or context_management; unsupported fields are silently ignored; only `function` tools.
 * So Agentlas keeps owning history, jobs and tool dispatch: this module only converts one Chat Completions request into
 * a Responses request and the Responses SSE back into Chat Completions chunks, the same way ollama-native.ts does for
 * Ollama. The Main tool loop (approval, broker, receipts, usage) is unchanged. Owner opt-in per backend
 * (byok-wire.ts); Chat Completions stays the default.
 */

type ChatContentPart = { type?: string; text?: string; image_url?: { url?: string } | string };
type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | ChatContentPart[] | null;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
};

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && (part.type === "text" || typeof part.text === "string")).map((part) => part.text ?? "").join("");
}

function inputParts(content: ChatMessage["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string" || !Array.isArray(content)) return [{ type: "input_text", text: textOf(content) }];
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: "input_image", image_url: url });
    } else if (typeof part.text === "string") parts.push({ type: "input_text", text: part.text });
  }
  return parts.length ? parts : [{ type: "input_text", text: "" }];
}

/** One Chat Completions body → one stateless Responses body. Never sends a field the endpoint documents as unsupported. */
export function chatToResponsesBody(body: Record<string, unknown>, thinkingByCallId?: ReadonlyMap<string, string>): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[]) {
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id ?? "", output: textOf(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const thinking = message.tool_calls?.[0]?.id ? thinkingByCallId?.get(message.tool_calls[0].id) : undefined;
      if (thinking) input.push({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: thinking }] });
      const text = textOf(message.content);
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: call.id ?? "", name: call.function?.name ?? "", arguments: call.function?.arguments ?? "{}" });
      }
      continue;
    }
    // DeepSeek treats `developer` as user input; Agentlas instructions stay `system`.
    input.push({ type: "message", role: message.role === "developer" ? "system" : message.role, content: inputParts(message.content) });
  }
  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>)
      .filter((tool) => tool?.type === "function" && tool.function?.name)
      .map((tool) => ({ type: "function", name: tool.function!.name, ...(tool.function!.description ? { description: tool.function!.description } : {}),
        parameters: tool.function!.parameters ?? { type: "object", properties: {} } }))
    : [];
  const toolChoice = body.tool_choice as string | { type?: string; function?: { name?: string } } | undefined;
  const responseFormat = body.response_format as { type?: string; json_schema?: { name?: string; schema?: unknown; strict?: boolean } } | undefined;
  return {
    model: body.model,
    input,
    stream: true,
    ...(tools.length ? { tools } : {}),
    ...(typeof toolChoice === "string" ? { tool_choice: toolChoice }
      : toolChoice?.function?.name ? { tool_choice: { type: "function", name: toolChoice.function.name } } : {}),
    ...(typeof body.max_tokens === "number" ? { max_output_tokens: body.max_tokens } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(responseFormat?.type === "json_schema" && responseFormat.json_schema?.schema
      ? { text: { format: { type: "json_schema", name: responseFormat.json_schema.name ?? "result", schema: responseFormat.json_schema.schema,
        ...(responseFormat.json_schema.strict !== undefined ? { strict: responseFormat.json_schema.strict } : {}) } } }
      : {}),
  };
}

/** Responses SSE → Chat Completions SSE (content/reasoning/tool_calls deltas, one finish chunk, one usage chunk, [DONE]). */
export function responsesSseToChatSse(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const calls = new Map<string, { index: number; streamed: boolean }>();
  const sse = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    sse({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
  const finish = (out: ReadableStreamDefaultController<Uint8Array>, response: { status?: string; incomplete_details?: { reason?: string }; usage?: Record<string, unknown> } | undefined) => {
    if (finished) return;
    finished = true;
    const reason = calls.size > 0 ? "tool_calls" : response?.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop";
    out.enqueue(chunk({}, reason));
    const usage = response?.usage as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } } | undefined;
    if (usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)) {
      const cached = usage.input_tokens_details?.cached_tokens;
      out.enqueue(sse({ object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
        ...(Number.isSafeInteger(cached) ? { prompt_tokens_details: { cached_tokens: cached } } : {}) } }));
    }
    out.enqueue(encoder.encode("data: [DONE]\n\n"));
  };
  const handle = (line: string, out: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event: { type?: string; delta?: string; item_id?: string; output_index?: number; item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string };
      response?: { status?: string; incomplete_details?: { reason?: string }; usage?: Record<string, unknown>; error?: { message?: string } } };
    try { event = JSON.parse(payload); } catch { return; }
    switch (event.type) {
      case "response.output_text.delta": if (event.delta) out.enqueue(chunk({ content: event.delta }, null)); return;
      case "response.reasoning_text.delta": if (event.delta) out.enqueue(chunk({ reasoning: event.delta }, null)); return;
      case "response.output_item.added": {
        const item = event.item;
        if (item?.type !== "function_call") return;
        const key = item.id ?? String(event.output_index ?? calls.size);
        const index = calls.size;
        calls.set(key, { index, streamed: false });
        out.enqueue(chunk({ tool_calls: [{ index, id: item.call_id ?? `call_${index}`, type: "function", function: { name: item.name ?? "", arguments: "" } }] }, null));
        return;
      }
      case "response.function_call_arguments.delta": {
        const call = calls.get(event.item_id ?? "");
        if (!call || !event.delta) return;
        call.streamed = true;
        out.enqueue(chunk({ tool_calls: [{ index: call.index, function: { arguments: event.delta } }] }, null));
        return;
      }
      case "response.output_item.done": {
        const item = event.item;
        if (item?.type !== "function_call") return;
        const call = calls.get(item.id ?? String(event.output_index ?? ""));
        if (call && !call.streamed && item.arguments) out.enqueue(chunk({ tool_calls: [{ index: call.index, function: { arguments: item.arguments } }] }, null));
        return;
      }
      case "response.completed":
      case "response.incomplete":
        finish(out, event.response);
        return;
      case "response.failed":
        out.error(new Error(`DeepSeek Responses failed: ${event.response?.error?.message ?? "unknown"}`));
        return;
      default:
        return;
    }
  };
  const reader = upstream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer) handle(buffer.trim(), controller);
          buffer = "";
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          handle(buffer.slice(0, newline).trim(), controller);
          buffer = buffer.slice(newline + 1);
        }
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

/** A fetch for runLocalOpenAiChat: same Chat Completions body in, Chat Completions SSE out, Responses on the wire. */
export function deepseekResponsesFetch(host: string, options: {
  fetchImpl?: typeof fetch;
  thinkingByCallId?: ReadonlyMap<string, string>;
  onRequest?: (responsesBody: Record<string, unknown>) => void;
} = {}): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const responsesBody = chatToResponsesBody(body, options.thinkingByCallId);
    options.onRequest?.(responsesBody);
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    const response = await fetchImpl(`${host.replace(/\/$/, "")}/responses`, { ...init, method: "POST", headers, body: JSON.stringify(responsesBody) });
    if (!response.ok || !response.body) return response;
    return new Response(responsesSseToChatSse(response.body), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}
