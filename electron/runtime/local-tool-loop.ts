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
import { saveBrowserCaptureArtifact } from "../media/capture-artifacts";
import type { InstalledMcpServer } from "../../shared/types";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import {
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  type RuntimeToolPermissionAsk,
} from "./tool-approval";
import {
  builtinToolByName,
  builtinToolsAsOpenAi,
  runBuiltinTool,
  type ToolPermission,
} from "../../shared/builtin-tools";
import { askUser } from "../confirm/ask-user";
import { multimodalImageSlot, multimodalImageSlotDiagnosis } from "../multimodal/slot";
import { generateImage } from "../multimodal/image";

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

/**
 * 이 루프가 부를 수 있는 도구는 두 출처다.
 * - `mcp`: 사용자가 붙인 MCP 서버의 도구.
 * - `builtin`: 우리가 쥐여 주는 파일·셸 도구(shared/builtin-tools.ts).
 *
 * ★내장 도구가 없던 동안, MCP 서버를 붙이지 않은 BYOK·로컬 실행은 도구가 0개였다 —
 * 모델은 코드를 답변에 적어 줄 뿐 파일 하나 못 만들었다. 벤더 CLI 가 없는 런타임은
 * 도구를 빌려올 곳이 없으므로 우리가 줘야 한다. 승인 관문·이벤트·결과 처리는
 * 두 출처가 **같은 경로**를 탄다 — 갈래를 나누면 한쪽만 관문을 빠뜨린다.
 */
type ResolvedTool =
  | { kind: "mcp"; server: InstalledMcpServer; serverToolName: string }
  | { kind: "builtin"; builtinName: string };

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
  permission: ToolPermission,
  /** 이 실행이 사람에게 물을 수 있는가 — 무인 실행이면 묻는 도구를 아예 안 준다. */
  canAskUser: boolean,
  /** 멀티모달 슬롯이 그림을 그릴 수 있는가 — 없으면 generate_image 는 목록에 안 뜬다. */
  canGenerateImage: boolean,
): Promise<{ tools: OpenAiToolDef[]; byName: Map<string, ResolvedTool> }> {
  const tools: OpenAiToolDef[] = [];
  const byName = new Map<string, ResolvedTool>();

  // ★내장 도구 먼저. MCP 설정이 없어도(그게 흔한 경우다) 이 런타임은 일할 수 있어야
  // 한다. 권한 칩보다 위의 도구는 목록에 **아예 없다** — "있는데 거절"이 아니라 "없다".
  if (workspaceRoot) {
    for (const def of builtinToolsAsOpenAi(permission, { canAskUser, canGenerateImage })) {
      tools.push(def);
      byName.set(def.function.name, { kind: "builtin", builtinName: def.function.name });
    }
  }

  if (!mcpConfigPath) return { tools, byName };
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
  } catch {
    return { tools, byName };
  }
  const keys = Object.keys(parsed.mcpServers ?? {});
  if (keys.length === 0) return { tools, byName };

  const serverByKey = new Map(
    listInstalledServers().map((s) => [mcpConfigKey(s), scopeServerToWorkspace(s, workspaceRoot)]),
  );
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
      byName.set(name, { kind: "mcp", server, serverToolName: tool.name });
    }
  }
  return { tools, byName };
}

/**
 * ★실행 전 승인 — 이 루프에는 오랫동안 관문이 아예 없었다.
 *
 * tool-approval.ts 는 `local-tool-loop` 을 "live 승인이 있는 경로"로 적어 두었는데,
 * `runOneToolCall` 은 승인 함수를 한 번도 부르지 않았다. 결과적으로 ollama·lmstudio·mlx
 * 는 MCP 도구를 **무조건** 실행했다(파일 쓰기·셸·브라우저 포함). 문서가 있는 관문은
 * 관문이 아니다.
 *
 * 판단 정책은 ACP 경로와 **같은 중재자 한 벌**이 내린다(electron/ipc.ts 등록).
 * 다만 여기서는 도구의 성격을 알 방법이 없다 — ACP 는 에이전트가 `toolCall.kind`
 * (read/edit/execute/…)를 실어 주지만, MCP 도구 정의에는 그런 칸이 없다. 그래서
 * **전부 변이로 본다**: 이 루프의 도구는 정의상 프로세스 바깥(파일·셸·네트워크·브라우저)에
 * 닿는 것들이고, 증명할 수 없는 무해함을 허용의 근거로 쓸 수는 없다.
 *
 * 중재자가 던지면 거부다. 실패가 허용으로 바뀌는 순간 이 관문은 없느니만 못하다
 * (acp.ts answerPermission 과 같은 규칙).
 */
interface LocalToolApprovalContext {
  runtimeKind: string;
  sessionKey: string;
  permission: RunnerRequest["permission"];
  cwd?: string;
  chatId?: string;
  /** 실행 중인 에이전트 — 에이전트 스코프 능력 규칙의 대상. */
  agentId?: string;
  unattended: boolean;
  /** 내장 bash 도구가 취소를 따르도록 — 실행 중단이 도구까지 닿아야 한다. */
  signal?: AbortSignal;
}

async function approveLocalToolCall(
  ctx: LocalToolApprovalContext,
  toolName: string,
): Promise<boolean> {
  // 내장 도구는 우리가 만든 것이라 성격을 안다 — 지어내는 게 아니라 아는 것을 싣는다.
  // MCP 도구는 정의에 종류 칸이 없으므로 "other"에 머문다.
  const builtin = builtinToolByName(toolName);
  const builtinKind = builtin
    ? builtin.minPerm === "read"
      ? ("read" as const)
      : builtin.name === "bash"
        ? ("execute" as const)
        : ("edit" as const)
    : null;
  const ask: RuntimeToolPermissionAsk = {
    runtime: ctx.runtimeKind,
    sessionKey: ctx.sessionKey,
    tool: toolName,
    kind: builtinKind ?? "other",
    // detail 을 비워 두는 것은 의도적이다 — 세션 허용 키가 `tool::detail` 이라
    // 인자를 실으면 인자 한 글자만 달라져도 다시 묻는다. 도구 이름
    // (`mcp__<서버>__<도구>`) 자체가 사용자에게 무엇을 허용하는지 말해 준다.
    cwd: ctx.cwd,
    permission: ctx.permission,
    // 내장 read_file·list_dir 은 변이가 아니라는 것을 **증명할 수 있다**(우리 코드다).
    // MCP 도구는 여전히 전부 변이로 본다 — 증명할 수 없는 무해함은 허용 근거가 못 된다.
    mutating: builtinKind ? builtinKind !== "read" : true,
    ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.unattended ? { unattended: true as const } : {}),
  };
  const arbiter = getRuntimeToolPermissionArbiter();
  if (!arbiter) return defaultRuntimeToolPermission(ask) !== "deny";
  try {
    return (await arbiter(ask)) !== "deny";
  } catch {
    return false;
  }
}

/** 테스트 이음새 — 승인 관문이 **호출 직전에** 실제로 걸리는지 재기 위해 열어 둔다. */
export async function runOneToolCall(
  byName: Map<string, ResolvedTool>,
  call: OpenAiToolCall,
  events: RunnerEvents,
  approval: LocalToolApprovalContext,
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
  // 승인은 **호출 직전**이다. 인자를 파싱한 뒤, 서버에 닿기 전.
  if (!(await approveLocalToolCall(approval, call.function.name))) {
    const denied = `Error: tool call denied — "${call.function.name}" was not approved for this run.`;
    events.onTool?.(call.function.name, call.function.arguments, denied, call.id, true);
    return {
      toolMessage: { role: "tool", tool_call_id: call.id, content: denied },
      visionMessage: null,
    };
  }
  if (resolved.kind === "builtin") {
    const outcome = await runBuiltinTool(resolved.builtinName, args, {
      cwd: approval.cwd ?? process.cwd(),
      permission: (approval.permission ?? "read") as ToolPermission,
      signal: approval.signal,
      askUser: (input) =>
        askUser(
          { ...input, askedBy: approval.runtimeKind, ...(approval.chatId ? { chatId: approval.chatId } : {}) },
          { unattended: approval.unattended, ...(approval.signal ? { signal: approval.signal } : {}) },
        ),
      // 그리는 것은 대화 런타임이 아니라 멀티모달 슬롯이다. 슬롯이 비면 주입도 없고,
      // 주입이 없으면 도구도 목록에 없다(위 canGenerateImage).
      ...(multimodalImageSlot()
        ? {
            generateImage: async ({ prompt }: { prompt: string }) => {
              const slot = multimodalImageSlot();
              if (!slot) return { ok: false, message: "The multimodal slot became empty mid-run." };
              return generateImage(slot.model, prompt);
            },
          }
        : {}),
    });
    events.onTool?.(
      call.function.name,
      call.function.arguments,
      outcome.content,
      call.id,
      !outcome.ok,
      outcome.artifactPaths,
      outcome.imageDataUrl,
    );
    return {
      toolMessage: {
        role: "tool",
        tool_call_id: call.id,
        content: (outcome.ok ? outcome.content : `Error: ${outcome.content}`).slice(0, MAX_TOOL_RESULT_CHARS),
      },
      visionMessage: outcome.ok && outcome.imageDataUrl
        ? {
            role: "user",
            content: [
              { type: "text", text: "The preceding host tool produced this verified image." },
              { type: "image_url", image_url: { url: outcome.imageDataUrl } },
            ],
          }
        : null,
    };
  }
  try {
    const result = await callServerToolContent(resolved.server, resolved.serverToolName, args, { timeoutMs: 30_000 });
    const text = result?.text ?? "";
    const images = result?.images ?? [];
    // ★도구가 돌려준 이미지는 모델만 보고 끝나면 안 된다 — 디스크에 정본을 남기고
    // 산출물 경로로 알려야 사용자의 결과 레일과 채팅에 실물로 뜬다.
    // (2026-09-03 실측: 저장하는 곳이 없어 스크린샷 요청이 산출물 0건으로 끝났다.)
    const capturePaths = images
      .map((image) => saveBrowserCaptureArtifact(image.mediaType, image.data))
      .filter((filePath): filePath is string => filePath !== null);
    events.onTool?.(
      call.function.name,
      call.function.arguments,
      text,
      call.id,
      false,
      capturePaths.length > 0 ? capturePaths : undefined,
    );
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
  const runtimeSessionOwnerId = req.runtimeSessionOwnerId ?? req.agentId;
  const isolateRuntimeSessionOwner = req.runtimeSessionOwnerId != null;
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
  const previousSession = req.chatId
    ? getRuntimeSession(req.chatId, runtimeKind, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
    : null;
  if (req.chatId && sessionFingerprint) {
    // OpenAI-compatible local servers have no provider conversation ID. The
    // durable Agentlas chat history is the source of truth, while this
    // logical session record makes continuity visible and detects model/host
    // changes without pretending the server supports native resume.
    saveRuntimeSession(req.chatId, runtimeKind, req.chatId, sessionFingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
    if (previousSession && previousSession.fingerprint === sessionFingerprint) {
      events.onStatus(req.locale === "ko" ? "로컬 모델 대화 기록 이어가는 중..." : "Continuing local model conversation history...");
    }
  }
  // 승인 세션 키 — ACP 러너와 같은 규칙(런타임 + 세션 정체성). 같은 대화의 후속 턴이
  // "이 세션 동안 허용"을 물려받게 하는 유일한 값이다.
  const approvalContext: LocalToolApprovalContext = {
    runtimeKind,
    sessionKey: `${runtimeKind}:${req.sessionFingerprintSeed ?? req.cwd ?? "default"}`,
    permission: req.permission,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    ...(req.approvalChatId ?? req.chatId ? { chatId: req.approvalChatId ?? req.chatId } : {}),
    ...(req.agentId ? { agentId: req.agentId } : {}),
    unattended: req.unattended === true,
    ...(req.signal ? { signal: req.signal } : {}),
  };
  // A stored assignment is not enough: after its CLI is removed, advertising
  // generate_image leaves the model a tool that can only fail. Diagnosis uses
  // the same detected-runtime authority as the dashboard and is cached there.
  const imageSlotDiagnosis = await multimodalImageSlotDiagnosis();
  const { tools, byName } = await loadOpenAiTools(
    req.mcpConfigPath,
    req.cwd,
    (req.permission ?? "read") as ToolPermission,
    req.unattended !== true && req.noSynchronousAsk !== true,
    imageSlotDiagnosis.state === "ready",
  );
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
            /*
             * ★제약 디코딩 — 형식 붕괴를 배선으로 없앤다.
             *
             * 판정·화면생성·진화제안은 답에서 구조를 파싱하는데, 자유 서술이면 작은
             * 모델은 형식을 깨뜨리고 그 결과가 조용히 사라졌다("완료라는데 결과물이
             * 없음", 실측 2026-08-08). json_schema 응답 형식은 모델이 문법상 틀린
             * 토큰을 뱉을 수 없게 만든다 — 남는 것은 판단력 문제뿐이고, 그건 배선으로
             * 고칠 수 없다는 것이 정직한 경계다.
             */
            ...(req.outputSchema
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: req.outputSchema.name,
                      schema: req.outputSchema.schema,
                      strict: true,
                    },
                  },
                }
              : {}),
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
      const outcome = await runOneToolCall(byName, call, events, approvalContext);
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
