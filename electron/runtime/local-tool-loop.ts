// OpenAI 호환 로컬/자체호스트 러너(Ollama, LM Studio, MLX) 공용 채팅+도구호출 루프.
//
// claude-code/codex는 CLI 서브프로세스가 자체 tool-calling 루프를 갖고 있어서 우리는
// --mcp-config 파일만 넘긴다. 이 런타임들은 그런 CLI가 없으므로(순수 HTTP 채팅 API),
// OpenAI Chat Completions의 tools/tool_calls 왕복을 여기서 직접 구현한다.
//
// mcpConfigPath는 buildMcpConfigFile()이 만든 { mcpServers: { [key]: {...} } } 형식의
// 파일이다(mcp-config.ts). key는 mcpConfigKey(server)와 동일하므로, 등록된
// InstalledMcpServer 목록에서 역으로 찾아 testServerConnection/callServerTool을 그대로
// 재사용한다 — Transport 생성 로직을 새로 만들지 않는다.
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";
import { workforceNativeToolEnforcement, workforceZeroToolsEnforcement } from "./runner";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import { listInstalledServers } from "../mcp-tools/registry";
import { mcpConfigKey } from "../mcp-tools/mcp-config";
import { testServerConnection, callServerToolContent } from "../mcp-tools/client";
import type { InstalledMcpServer } from "../../shared/types";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";

export type LocalChatContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAiToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string | LocalChatContent[] }
  | { role: "assistant"; content: string; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ResolvedTool {
  server: InstalledMcpServer;
  serverToolName: string;
}

const MAX_TOOL_LOOP_TURNS = 8;
const MAX_TOOL_RESULT_CHARS = 20_000;

/**
 * ★로컬 런타임의 실패 표식 — CLI 러너와 같은 계약(RunnerResult.failure).
 *
 * 실측 사고(2026-08-08, ollama): 로컬 모델이 도구 왕복에서 무너진 뒤
 * "The system encountered a timeout error while processing a request. ..."
 * 같은 기계 문장을 최종 답으로 뱉었고, 이 루프에는 실패 칸이 아예 없어서
 * 그 문장이 정상 답으로 저장됐다(chat_messages 실물 확인). CLI 러너들은
 * 2026-08-06에 이 계약으로 전환됐는데 로컬 4종(ollama/lmstudio/mlx/
 * local-openai)이 공유하는 이 파일만 빠져 있었다 — 특례가 아니라 누락이다.
 *
 * 여기서 표식을 다는 경우는 "텍스트가 답이 아닌데 성공처럼 보이는" 것들뿐이다:
 * 빈 답, 거절 고지문, 도구 루프 미수렴. 전송/HTTP 실패는 지금처럼 throw로
 * 크게 실패한다(표식을 안 읽는 소비자에게도 확실히 전달되어야 한다).
 */
function localFailure(
  kind: RunnerFailure["kind"],
  message: string,
  runtimeKind: string,
  source: RunnerFailure["source"] = "marker",
): RunnerFailure {
  return { kind, message: message.slice(0, 400), runtime: runtimeKind, source };
}

/**
 * 카탈로그의 filesystem류 서버는 허용 루트가 "~"(홈 전체)로 등록돼 있다. CLI 런타임은
 * 자식 CLI가 cwd를 따로 받아 실사용 경로가 실행 폴더로 잡히지만, 이 in-process 루프는
 * 서버 정의를 그대로 쓰므로 상대경로 쓰기가 전부 홈에 떨어진다(2026-07-16 Qwen 빌드
 * 실측: ~/.agentlas·~/docs 오염). 실행 폴더가 있으면 "~" 허용 루트를 그 폴더로 좁힌다 —
 * 폴더 밖 쓰기는 서버의 allowed-directories 검증이 거부하고, 그 에러가 tool 결과로
 * 모델에 돌아가 스스로 교정한다.
 */
function scopeServerToWorkspace(server: InstalledMcpServer, workspaceRoot: string | undefined): InstalledMcpServer {
  if (!workspaceRoot || server.transport !== "stdio" || !server.args?.includes("~")) return server;
  return { ...server, args: server.args.map((arg) => (arg === "~" ? workspaceRoot : arg)) };
}

async function loadOpenAiTools(
  mcpConfigPath: string | undefined,
  workspaceRoot: string | undefined,
): Promise<{ tools: OpenAiToolDef[]; byName: Map<string, ResolvedTool> }> {
  const empty = { tools: [] as OpenAiToolDef[], byName: new Map<string, ResolvedTool>() };
  if (!mcpConfigPath) return empty;
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
  } catch {
    return empty;
  }
  const keys = Object.keys(parsed.mcpServers ?? {});
  if (keys.length === 0) return empty;

  const serverByKey = new Map(
    listInstalledServers().map((s) => [mcpConfigKey(s), scopeServerToWorkspace(s, workspaceRoot)]),
  );
  const tools: OpenAiToolDef[] = [];
  const byName = new Map<string, ResolvedTool>();
  for (const key of keys) {
    const server = serverByKey.get(key);
    if (!server) continue; // config가 가리키는 서버가 레지스트리에서 사라진 경우 — 건너뜀
    let status;
    try {
      status = await testServerConnection(server, { timeoutMs: 8_000 });
    } catch {
      continue;
    }
    if (!status.connected) continue;
    for (const tool of status.tools) {
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
      const safeTool = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const name = `mcp__${safeKey}__${safeTool}`.slice(0, 128);
      if (byName.has(name)) continue;
      tools.push({
        type: "function",
        function: {
          name,
          description: tool.description?.slice(0, 1024),
          parameters:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? tool.inputSchema
              : { type: "object", properties: {} },
        },
      });
      byName.set(name, { server, serverToolName: tool.name });
    }
  }
  return { tools, byName };
}

async function runOneToolCall(
  byName: Map<string, ResolvedTool>,
  call: OpenAiToolCall,
  events: RunnerEvents,
): Promise<{ toolMessage: ChatMessage; visionMessage: ChatMessage | null }> {
  const resolved = byName.get(call.function.name);
  if (!resolved) {
    events.onTool?.(call.function.name, call.function.arguments, "unknown tool", call.id, true);
    return {
      toolMessage: { role: "tool", tool_call_id: call.id, content: `Error: unknown tool "${call.function.name}"` },
      visionMessage: null,
    };
  }
  let args: Record<string, unknown> = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    events.onTool?.(call.function.name, call.function.arguments, "invalid JSON arguments", call.id, true);
    return {
      toolMessage: { role: "tool", tool_call_id: call.id, content: "Error: invalid JSON arguments" },
      visionMessage: null,
    };
  }
  try {
    const result = await callServerToolContent(resolved.server, resolved.serverToolName, args, { timeoutMs: 30_000 });
    const text = result?.text ?? "";
    events.onTool?.(call.function.name, call.function.arguments, text, call.id, false);
    const images = result?.images ?? [];
    return {
      toolMessage: { role: "tool", tool_call_id: call.id, content: text.slice(0, MAX_TOOL_RESULT_CHARS) },
      visionMessage: images.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text: "Current Agentlas Computer Use screenshot returned by the preceding tool call." },
              ...images.map((image) => ({
                type: "image_url" as const,
                image_url: { url: `data:${image.mediaType};base64,${image.data}` },
              })),
            ],
          }
        : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    events.onTool?.(call.function.name, call.function.arguments, message, call.id, true);
    return {
      toolMessage: { role: "tool", tool_call_id: call.id, content: `Error: ${message}` },
      visionMessage: null,
    };
  }
}

async function* iterSseLines(resp: Response): AsyncGenerator<string, void, unknown> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

interface StreamTurnResult {
  text: string;
  toolCalls: OpenAiToolCall[];
}

async function streamChatTurn(
  resp: Response,
  onPartial: (acc: string) => void,
  onThinking?: RunnerEvents["onThinking"],
): Promise<StreamTurnResult> {
  let acc = "";
  let lastEmit = 0;
  // OpenAI-호환 로컬 서버(ollama·LM Studio·MLX)는 생각을 delta.reasoning_content(또는
  // ollama의 delta.reasoning / delta.thinking)로 따로 준다. 자기 행으로 흘린다.
  let thinkingOpen = false;
  let thinkingStartedAt = 0;
  const pending = new Map<number, { id?: string; name: string; args: string }>();
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const event = JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning_content?: string;
            reasoning?: string;
            thinking?: string;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      const delta = event.choices?.[0]?.delta;
      const thought = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
      if (typeof thought === "string" && thought) {
        if (!thinkingOpen) {
          thinkingOpen = true;
          thinkingStartedAt = Date.now();
          onThinking?.("start");
        }
        onThinking?.("delta", undefined, thought);
      }
      if (delta?.content) {
        if (thinkingOpen) {
          thinkingOpen = false;
          onThinking?.("end", Date.now() - thinkingStartedAt);
        }
        acc += delta.content;
        const now = Date.now();
        if (now - lastEmit > 80) {
          onPartial(acc);
          lastEmit = now;
        }
      }
      for (const tc of delta?.tool_calls ?? []) {
        const entry = pending.get(tc.index) ?? { name: "", args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        pending.set(tc.index, entry);
      }
    } catch {
      // 빈 줄 / keep-alive — 무시
    }
  }
  if (thinkingOpen) onThinking?.("end", Date.now() - thinkingStartedAt);
  const toolCalls: OpenAiToolCall[] = [...pending.values()]
    .filter((entry) => entry.name)
    .map((entry, i) => ({
      id: entry.id ?? `call_${i}`,
      type: "function" as const,
      function: { name: entry.name, arguments: entry.args },
    }));
  return { text: acc.trim(), toolCalls };
}

export interface RunLocalOpenAiChatOptions {
  req: RunnerRequest;
  events: RunnerEvents;
  runtimeKind: string;
  /** 예: "http://localhost:1234" — chatEndpoint는 항상 "/v1/chat/completions" */
  host: string;
  model: string;
  /** 연결 실패 시 메시지(로케일 이미 반영된 문자열) */
  unreachableMessage: string;
  /** Ollama accepts this on its native API; OpenAI-compatible servers may ignore it. */
  keepAlive?: string;
}

/**
 * OpenAI 호환 /v1/chat/completions에 대고 tools를 실어 보내고, tool_calls가 오면
 * 실제 MCP 서버를 호출해 결과를 이어붙인 뒤 최종 텍스트가 나올 때까지 반복한다.
 * 도구가 하나도 없거나(mcpConfigPath 미설정) 모델이 tool_calls를 전혀 emit하지 않으면
 * 기존과 동일하게 1턴 텍스트 응답으로 끝난다.
 */
export async function runLocalOpenAiChat(
  opts: RunLocalOpenAiChatOptions,
  messages: ChatMessage[],
): Promise<RunnerResult> {
  const { req, events, runtimeKind, host, model } = opts;
  const sessionFingerprint = req.chatId
    ? createHash("sha256")
        .update("local-chat-session-v1\0")
        .update(host)
        .update("\0")
        .update(model)
        .update("\0")
        .update(req.sessionFingerprintSeed ?? req.systemPrompt ?? "")
        .digest("hex")
    : null;
  const previousSession = req.chatId ? getRuntimeSession(req.chatId, runtimeKind) : null;
  if (req.chatId && sessionFingerprint) {
    // OpenAI-compatible local servers have no provider conversation ID. The
    // durable Agentlas chat history is the source of truth, while this
    // logical session record makes continuity visible and detects model/host
    // changes without pretending the server supports native resume.
    saveRuntimeSession(req.chatId, runtimeKind, req.chatId, sessionFingerprint);
    if (previousSession && previousSession.fingerprint === sessionFingerprint) {
      events.onStatus(req.locale === "ko" ? "로컬 모델 대화 기록 이어가는 중..." : "Continuing local model conversation history...");
    }
  }
  const { tools, byName } = await loadOpenAiTools(req.mcpConfigPath, req.cwd);
  if (tools.length > 0) {
    events.onStatus(tStatus(req.locale, "mcpToolsAttached", { count: tools.length }));
    if (req.cwd) {
      // 파일 도구의 허용 루트를 실행 폴더로 좁혔음을 모델에게도 알려, 처음부터 이
      // 폴더 안 절대경로로 쓰게 한다(밖은 서버가 거부하지만 왕복 낭비를 줄인다).
      messages.splice(1, 0, {
        role: "system",
        content: `File tools are sandboxed to this run's workspace folder: ${req.cwd}. Always pass absolute paths inside that folder; paths outside it will be rejected.`,
      });
    }
  }

  let finalText = "";
  let sawAnyToolCall = false;
  let sawUnsupportedToolCallAttempt = false;
  /** 루프가 답에 도달해서 끝났는가. false로 빠져나오면 도구 왕복만 하다 상한에 닿은 것. */
  let reachedAnswer = false;

  for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn += 1) {
    let resp: Response;
    try {
      resp = await fetch(`${host}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: req.signal,
          body: JSON.stringify({
            model,
            stream: true,
            messages,
            ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}),
            ...(tools.length > 0 ? { tools } : {}),
        }),
      });
    } catch (err) {
      // 사용자가 멈춘 것을 "서버에 연결 못 함"이라고 말하면 거짓말이 된다 —
      // 취소는 취소로 올려보낸다. 다만 **원 에러를 그대로 던지면 안 된다**:
      // AbortController 의 DOMException 문구("This operation was aborted")가 그대로
      // 화면에 흘러 한국어 UI에 영어 기계 문장이 박혔다(실측 2026-08-09 녹화).
      // 그렇다고 "사용자가 중지했습니다"로 덮어도 안 된다 — 워치독·시간 초과가
      // 끊은 것까지 사람이 누른 것으로 만든다. 끊은 쪽이 실은 이유를 먼저 읽는다.
      if (req.signal?.aborted) throw abortReasonError(req);
      throw new Error(opts.unreachableMessage);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      // 도구 스키마를 이해 못 하는 서버/모델은 종종 400을 낸다 — tools 없이 한 번 더 시도.
      if (tools.length > 0 && !sawAnyToolCall && resp.status >= 400 && resp.status < 500) {
        sawUnsupportedToolCallAttempt = true;
        events.onStatus(tStatus(req.locale, "mcpToolCallUnsupported"));
        const fallback = await fetch(`${host}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: req.signal,
            body: JSON.stringify({ model, stream: true, messages, ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}) }),
        });
        if (!fallback.ok) {
          const fallbackErrText = await fallback.text().catch(() => "");
          throw new Error(`${host} ${fallback.status}: ${fallbackErrText.slice(0, 300)}`);
        }
        const result = await streamChatTurn(fallback, events.onPartial, events.onThinking);
        finalText = result.text;
        reachedAnswer = true;
        break;
      }
      throw new Error(`${host} ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const result = await streamChatTurn(resp, events.onPartial, events.onThinking);
    if (result.toolCalls.length === 0) {
      finalText = result.text;
      reachedAnswer = true;
      break;
    }
    sawAnyToolCall = true;
    messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });
    const visionMessages: ChatMessage[] = [];
    for (const call of result.toolCalls) {
      const outcome = await runOneToolCall(byName, call, events);
      messages.push(outcome.toolMessage);
      if (outcome.visionMessage) visionMessages.push(outcome.visionMessage);
    }
    // Keep every protocol-required tool response directly after the assistant
    // tool_calls message, then provide screenshots as normal vision input.
    messages.push(...visionMessages);
    finalText = result.text;
    // 다음 루프에서 도구 결과를 포함해 다시 요청한다.
  }

  const grantedToolIds = sawAnyToolCall && !sawUnsupportedToolCallAttempt ? [...byName.keys()] : [];
  const zeroToolsCapabilities = ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"];
  // 이 런의 실제 도구 사용 여부와 Main이 발급한 workforceRuntimeToolGrant는 서로 다른
  // 출처다 — 흔치 않은 Workforce 경로에서 grant.grantedToolIds가 비어 있는데 이 런이
  // 실제로 도구를 썼다면(예: 사용자 승인 MCP), workforceNativeToolEnforcement가
  // 계약 위반으로 throw할 수 있다. 그 경우 zero-tools 영수증으로 안전하게 낮춘다.
  const enforcement =
    grantedToolIds.length > 0
      ? (() => {
          try {
            return workforceNativeToolEnforcement(req, runtimeKind, []);
          } catch {
            return workforceZeroToolsEnforcement(req, runtimeKind, zeroToolsCapabilities);
          }
        })()
      : workforceZeroToolsEnforcement(req, runtimeKind, zeroToolsCapabilities);

  // ★여기서부터가 실패 판정 — 텍스트 "모양"이 아니라 이 런의 사실로만 판단한다.
  const answer = finalText.trim();
  let failure: RunnerFailure | null = null;
  if (!reachedAnswer) {
    // 도구만 왕복하다 상한에 닿았다. 마지막 중간 텍스트는 답이 아니다.
    failure = localFailure(
      "exit",
      tStatus(req.locale, "errLocalToolLoopStuck", { model, turns: MAX_TOOL_LOOP_TURNS }),
      runtimeKind,
    );
  } else if (!answer) {
    failure = localFailure("empty", tStatus(req.locale, "errLocalEmptyAnswer", { model }), runtimeKind);
  } else {
    // 표식 없이 완주했는데 산출물이 거절/한도 고지문인 경우 — 판별 규칙은
    // runtime-refusal.ts 한 곳에만 살고, 출처는 heuristic으로 남긴다.
    const refusal = detectRuntimeRefusal(answer);
    if (refusal) failure = localFailure(refusal.kind, refusal.message, runtimeKind, "heuristic");
  }

  return {
    // 실패일 때도 원문은 지우지 않는다 — 표식을 안 읽는 소비자에게 빈 말풍선을
    // 주지 않기 위해서다. 판정은 어디까지나 failure 칸이 한다.
    text: answer || (failure ? failure.message : ""),
    ...(failure ? { failure } : {}),
    workforcePermissionEnforcement: enforcement,
  };
}
