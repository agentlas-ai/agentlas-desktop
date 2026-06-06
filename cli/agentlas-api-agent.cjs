"use strict";
/*
 * agentlas-api-agent: BYOK(Anthropic/OpenAI/Google) + Ollama 위에서 도는 agentlas 자체 에이전트 루프.
 * openclaw가 pi-agent-core로 하는 일을 CJS로: SSE 스트리밍 + provider별 tool-use 프로토콜 + 로컬 툴 실행.
 * byok.ts(electron)의 SSE 패턴을 이식했다. 외부 SDK 의존성 없음 (Node 20 fetch/ReadableStream).
 *
 *   anthropic / openai / ollama → 스트리밍 + 툴 루프 (read/write/full 권한 게이트)
 *   google                      → 스트리밍 채팅 (툴은 후속 — 우아하게 chat-only)
 */
const tools = require("./agentlas-tools.cjs");

const MAX_ITERS = 12;
const IDLE_MS = Number(process.env.AGENTLAS_IDLE_TIMEOUT_MS) || 180000;

// 스트림이 IDLE_MS 동안 한 바이트도 안 오면 중단(provider가 SSE를 열고 멈추는 hang 방지).
// 부모 signal(사용자 Ctrl-C)과 결합한다. timer는 unref이라 프로세스 종료를 막지 않는다.
function idleAbort(parentSignal, ms) {
  const ctrl = new AbortController();
  let timer = null;
  const onParent = () => ctrl.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener("abort", onParent, { once: true });
  }
  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), ms);
    if (timer.unref) timer.unref();
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    if (parentSignal && parentSignal.removeEventListener) parentSignal.removeEventListener("abort", onParent);
  };
  bump();
  return { signal: ctrl.signal, bump, clear };
}

async function* iterSse(resp, idle) {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (idle) idle.bump();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

function sseData(line) {
  if (!line.startsWith("data:")) return null;
  const p = line.slice(5).trim();
  return p === "[DONE]" ? "[DONE]" : p;
}

// ── Anthropic ────────────────────────────────────────────
async function streamAnthropic({ apiKey, model, system, messages, permission, ui, signal }) {
  const body = {
    model,
    max_tokens: 8192,
    stream: true,
    system,
    messages,
  };
  const toolDefs = tools.anthropicTools(permission);
  if (toolDefs.length) body.tools = toolDefs;

  const idle = idleAbort(signal, IDLE_MS);
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    signal: idle.signal,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    idle.clear();
    throw new Error(`Anthropic ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  }

  const blocks = {}; // index → {type, text, name, id, inputJson}
  let stopReason = null;
  let usage = null;
  for await (const line of iterSse(resp, idle)) {
    const data = sseData(line);
    if (!data || data === "[DONE]") continue;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === "content_block_start") {
      const cb = ev.content_block || {};
      blocks[ev.index] = { type: cb.type, text: "", name: cb.name, id: cb.id, inputJson: "" };
      if (cb.type === "tool_use") ui.tool(cb.name, "");
      else ui.streamStart();
    } else if (ev.type === "content_block_delta") {
      const b = blocks[ev.index] || (blocks[ev.index] = { type: "text", text: "", inputJson: "" });
      if (ev.delta.type === "text_delta") {
        b.text += ev.delta.text;
        ui.streamDelta(ev.delta.text);
      } else if (ev.delta.type === "input_json_delta") {
        b.inputJson += ev.delta.partial_json || "";
      }
    } else if (ev.type === "content_block_stop") {
      const b = blocks[ev.index];
      if (b && b.type === "tool_use") {
        const arg = safeArg(b.inputJson);
        if (arg) ui.info(ui.c.dim("  " + arg));
      }
      // 텍스트 블록 stop에서는 streamEnd를 호출하지 않는다 — 메모리 가드 중간 flush 방지(턴 끝에서만 flush).
    } else if (ev.type === "message_start") {
      const u = ev.message && ev.message.usage;
      if (u) usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 };
    } else if (ev.type === "message_delta") {
      if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage) usage = { input_tokens: (usage && usage.input_tokens) || 0, output_tokens: ev.usage.output_tokens };
    }
  }
  ui.streamEnd();
  idle.clear();

  // 어셈블
  const ordered = Object.keys(blocks)
    .sort((a, b) => a - b)
    .map((k) => blocks[k]);
  const assistantContent = [];
  const toolUses = [];
  let text = "";
  for (const b of ordered) {
    if (b.type === "text" && b.text) {
      assistantContent.push({ type: "text", text: b.text });
      text += b.text;
    } else if (b.type === "tool_use") {
      let input = {};
      try {
        input = JSON.parse(b.inputJson || "{}");
      } catch {
        input = {};
      }
      assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input });
      toolUses.push({ id: b.id, name: b.name, input });
    }
  }
  return { text, assistantContent, toolUses, stopReason, usage };
}

async function runAnthropicLoop(req) {
  const { ctx, ui } = req;
  const messages = req.messages.slice();
  let finalText = "";
  let inTok = 0, outTok = 0;
  for (let i = 0; i < MAX_ITERS; i++) {
    if (req.signal && req.signal.aborted) break;
    const r = await streamAnthropic({
      apiKey: req.apiKey,
      model: req.model,
      system: req.system,
      messages,
      permission: ctx.permission,
      ui,
      signal: req.signal,
    });
    finalText = r.text || finalText;
    if (r.usage) { inTok += r.usage.input_tokens || 0; outTok += r.usage.output_tokens || 0; }
    if (!r.toolUses.length) break;
    messages.push({ role: "assistant", content: r.assistantContent });
    const results = [];
    for (const tu of r.toolUses) {
      const out = tools.runTool(tu.name, tu.input, ctx);
      ui.toolResult(out.content, out.ok);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: out.content, is_error: !out.ok });
    }
    messages.push({ role: "user", content: results });
  }
  if (inTok || outTok) ui.cost({ input_tokens: inTok, output_tokens: outTok });
  return { text: finalText };
}

// ── OpenAI ───────────────────────────────────────────────
async function streamOpenAI({ apiKey, model, messages, permission, ui, signal, baseUrl }) {
  const body = { model, stream: true, stream_options: { include_usage: true }, messages };
  const toolDefs = tools.openaiTools(permission);
  if (toolDefs.length) body.tools = toolDefs;

  const idle = idleAbort(signal, IDLE_MS);
  const resp = await fetch(`${baseUrl || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    signal: idle.signal,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    idle.clear();
    throw new Error(`OpenAI ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  }

  let text = "";
  let started = false;
  const toolCalls = {}; // index → {id, name, args}
  let finish = null;
  let usage = null;
  for await (const line of iterSse(resp, idle)) {
    const data = sseData(line);
    if (!data || data === "[DONE]") continue;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.usage) usage = { input_tokens: ev.usage.prompt_tokens || 0, output_tokens: ev.usage.completion_tokens || 0 };
    const choice = ev.choices && ev.choices[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) {
      if (!started) {
        ui.streamStart();
        started = true;
      }
      text += delta.content;
      ui.streamDelta(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = toolCalls[idx] || (toolCalls[idx] = { id: "", name: "", args: "" });
        if (tc.id) cur.id = tc.id;
        if (tc.function && tc.function.name) {
          if (!cur.name) ui.tool(tc.function.name, "");
          cur.name = tc.function.name;
        }
        if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (started) ui.streamEnd();
  idle.clear();

  const calls = Object.keys(toolCalls)
    .sort((a, b) => a - b)
    .map((k) => toolCalls[k])
    .filter((c) => c.name);
  return { text, toolCalls: calls, finish, usage };
}

async function runOpenAILoop(req) {
  const { ctx, ui } = req;
  const messages = req.messages.slice();
  // OpenAI는 system을 messages[0]로.
  if (!messages.length || messages[0].role !== "system") messages.unshift({ role: "system", content: req.system });
  let finalText = "";
  let inTok = 0, outTok = 0;
  for (let i = 0; i < MAX_ITERS; i++) {
    if (req.signal && req.signal.aborted) break;
    const r = await streamOpenAI({
      apiKey: req.apiKey,
      model: req.model,
      messages,
      permission: ctx.permission,
      ui,
      signal: req.signal,
      baseUrl: req.baseUrl,
    });
    finalText = r.text || finalText;
    if (r.usage) { inTok += r.usage.input_tokens || 0; outTok += r.usage.output_tokens || 0; }
    if (!r.toolCalls.length) break;
    messages.push({
      role: "assistant",
      content: r.text || null,
      tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
    });
    for (const c of r.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(c.args || "{}");
      } catch {
        args = {};
      }
      const arg = safeArgObj(args);
      if (arg) ui.info(ui.c.dim("  " + arg));
      const out = tools.runTool(c.name, args, ctx);
      ui.toolResult(out.content, out.ok);
      messages.push({ role: "tool", tool_call_id: c.id, content: out.content });
    }
  }
  if (inTok || outTok) ui.cost({ input_tokens: inTok, output_tokens: outTok });
  return { text: finalText };
}

// ── Ollama (openai 스타일 tools, /api/chat) ──────────────
async function runOllamaLoop(req) {
  const { ctx, ui } = req;
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const messages = req.messages.slice();
  if (!messages.length || messages[0].role !== "system") messages.unshift({ role: "system", content: req.system });
  const toolDefs = tools.openaiTools(ctx.permission);
  let finalText = "";
  for (let i = 0; i < MAX_ITERS; i++) {
    if (req.signal && req.signal.aborted) break;
    const idle = idleAbort(req.signal, IDLE_MS);
    let resp;
    try {
      resp = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: idle.signal,
        body: JSON.stringify({ model: req.model, stream: true, messages, tools: toolDefs.length ? toolDefs : undefined }),
      });
    } catch (e) {
      idle.clear();
      throw new Error(`Ollama connection failed (${host}) — is 'ollama serve' running? ${e.message}`);
    }
    if (!resp.ok) {
      idle.clear();
      throw new Error(`Ollama ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    }
    let text = "";
    let started = false;
    let toolCalls = [];
    for await (const line of iterSse(resp, idle)) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = ev.message || {};
      if (msg.content) {
        if (!started) {
          ui.streamStart();
          started = true;
        }
        text += msg.content;
        ui.streamDelta(msg.content);
      }
      if (Array.isArray(msg.tool_calls)) toolCalls = toolCalls.concat(msg.tool_calls);
    }
    if (started) ui.streamEnd();
    idle.clear();
    finalText = text || finalText;
    if (!toolCalls.length) break;
    messages.push({ role: "assistant", content: text, tool_calls: toolCalls });
    for (const c of toolCalls) {
      const fn = c.function || {};
      const args = typeof fn.arguments === "string" ? safeParse(fn.arguments) : fn.arguments || {};
      ui.tool(fn.name || "tool", safeArgObj(args));
      const out = tools.runTool(fn.name, args, ctx);
      ui.toolResult(out.content, out.ok);
      // Ollama tool 결과는 tool_call_id가 없으므로 tool_name으로 상관관계를 보존 (병렬 호출 시 중요)
      messages.push({ role: "tool", tool_name: fn.name, content: out.content });
    }
  }
  return { text: finalText };
}

// ── Google (chat-only 스트리밍) ──────────────────────────
async function runGoogleChat(req) {
  const { ui } = req;
  const contents = [];
  for (const m of req.messages) {
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: textOf(m.content) }] });
    else if (m.role === "assistant") contents.push({ role: "model", parts: [{ text: textOf(m.content) }] });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.apiKey)}`;
  const idle = idleAbort(req.signal, IDLE_MS);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: idle.signal,
    body: JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents }),
  });
  if (!resp.ok) {
    idle.clear();
    throw new Error(`Google ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  }
  let text = "";
  let started = false;
  for await (const line of iterSse(resp, idle)) {
    const data = sseData(line);
    if (!data || data === "[DONE]") continue;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    const t = ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts && ev.candidates[0].content.parts[0] && ev.candidates[0].content.parts[0].text;
    if (t) {
      if (!started) {
        ui.streamStart();
        started = true;
      }
      text += t;
      ui.streamDelta(t);
    }
  }
  if (started) ui.streamEnd();
  idle.clear();
  return { text };
}

// ── 엔트리 ───────────────────────────────────────────────
// req = { backend, model, apiKey, system, messages([{role,content}]), ctx({cwd,permission}), ui, signal }
async function runApiTurn(req) {
  switch (req.backend) {
    case "anthropic":
      return runAnthropicLoop(req);
    case "openai":
      return runOpenAILoop(req);
    case "upstage":
      return runOpenAILoop({ ...req, baseUrl: "https://api.upstage.ai/v1" });
    case "ollama":
      return runOllamaLoop(req);
    case "google":
      return runGoogleChat(req);
    default:
      throw new Error(`unsupported backend: ${req.backend}`);
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
function safeArg(json) {
  return safeArgObj(safeParse(json || "{}"));
}
function safeArgObj(o) {
  if (!o || typeof o !== "object") return "";
  return o.file_path || o.path || o.command || o.pattern || o.query || "";
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return "";
}

module.exports = { runApiTurn, MAX_ITERS };
