import { cachedTokensFromOpenAiUsage } from "./prompt-cache";
import { cacheCapabilityFor, planCache, planRequestFields, segmentOf, type CachePlan, type CacheSegment } from "./cache-planner";
import { reportModelPayload, reportCachePlan, reportModelEffort, ledgerFromApiBody, type ModelEffortApplication } from "./model-call-ledger";
import { openAiChatWireFamily, openAiReasoningEffort, outputLimitField, rejectsOptionalParameter, requestOutputLimit } from "./openai-wire-family";
import { GENERATION_CONTEXT_RATIO } from "./session-generation";
import { assertCurrentHistoryRunnerResult } from "./observed-runner";
import { withCurrentHistoryTool, withCurrentHistoryProducer, withCurrentHistoryApplication, currentHistoryRuntimeFence, withCurrentHistoryProvider } from "../one/history-runtime-fences";
import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
import { boundedLocalOutputTokens, localContextFailure, localHttpFailureClass, measureLocalContext } from "./local-context";
import { compactHistoryToBudget, estimateTransportTokens } from "./compact";
import { openStatelessGeneration, statelessHistoryTokens, type StatelessWindow } from "./stateless-generation";
import { ownerControlHistoryImages } from "./owner-control-pump";
import { estimateRequestPromptTokens, ollamaNativeFetch, planOllamaContext, probeOllamaContextLimits, remeasureOllamaWindow } from "./ollama-native";
import { browserDownloadAvailable, beginBrowserDownloadProof } from "../long-run/download-proof";
import { beginBuiltinFileProof, beginNativeFileProof, mcpFileProofCandidate } from "../long-run/file-proof";
import { assertScienceCollectionCapability, assertScienceCollectionTool, SCIENCE_COLLECTION_TOOLS } from "./science-collection-boundary";
// OpenAI 호환 로컬/자체호스트 러너(Ollama, LM Studio, MLX) 공용 채팅+도구호출 루프.
//
// claude-code/codex는 CLI 서브프로세스가 자체 tool-calling 루프를 갖고 있어서 우리는
// --mcp-config 파일만 넘긴다. 이 런타임들은 그런 CLI가 없으므로(순수 HTTP 채팅 API),
// OpenAI Chat Completions의 tools/tool_calls 왕복을 여기서 직접 구현한다.
//
// mcpConfigPath는 buildMcpConfigFile()이 만든 { mcpServers: { [key]: {...} } } 형식의
// 파일이다(mcp-config.ts). Main이 작성할 때 봉인한 실제 transport를 사용한다.
// key만으로 레지스트리 원본에 되돌아가면 실행별 브라우저·승인 경계를 잃는다.
import { preparedMcpBindings, preparedMcpTransport, preparedMcpConsentResource, type PreparedMcpBinding } from "../mcp-tools/prepared-transport";
import { bindMainToolConsentResource } from "./tool-consent";
import { mcpToolIsMutating, planMcpToolIsMutating } from "../mcp-tools/proxy-server";
import { oneGraphToolTimeoutMs } from "../../shared/one-graph-tool-permission";
import { readOnlyBrowserToolIsMutating } from "../../shared/read-only-browser-tools";
import { mcpToolSchemaDigest } from "../mcp-tools/tool-schema";
import { mcpToolSurfaceHides } from "../mcp-tools/hephaestus-tool-surface";
import { installLazyToolMenu, invalidateToolMenu, resolveToolMenu } from "./tool-menu";
import { CODE_MODE_TOOL, installMainCodeMode, runMainCodeMode } from "./code-mode";
import { TOOL_RESULT_READ, foldRetainedToolResult, hasToolResultContext, installToolResultContext, projectToolResult, readToolResult, toolResultReadRequest } from "./tool-result-context";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRuntimeUsageCollector, type ObservedTokenUsage } from "../../shared/observed-usage";
import { createNoProgressGuard, noteNoProgressEvent } from "../automation-progress-guard";
import type { RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";
import { RuntimeNoProgressError, RuntimeTurnUnsettledError, runtimeHttpFailure, workforceNativeToolEnforcement, workforceZeroToolsEnforcement } from "./runner";
import {
  MainWorkforceBroker,
  workforceBrokerDigest,
  type WorkforceBrokerInventoryEntry,
  type WorkforceBrokerProviderCallLocation,
} from "./workforce-broker";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { tStatus } from "./status-i18n";
import { openAiStrictSchemaOrNull } from "./strict-output-schema";
import { abortReasonError } from "./abort-reason";
import { builtinShellEnv } from "./builtin-shell-env";
import { attestMainToolPreDispatchRejection, withDurableMainToolStart } from "../invocation/adapter-effect-context";
import { assertMainWorkRecoveryContext, mainWorkToolSchema, type MainWorkRecoveryContext, type MainWorkReference } from "../invocation/main-work-recovery";
import type { InstalledMcpServer } from "../../shared/types";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import { OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS, outputLimitContinuationTurn } from "./output-limit-continuation";
import { resolveToolNameAlias, unknownToolMessage } from "./tool-name-alias";
import {
  LOCAL_MODEL_UNLOADED_CODE, localModelResident, refineServerFailureCode, RUNTIME_SERVER_ERROR_CODE, serverFailure,
  serverFailureCodeForStatus, serverFailureResendable, serverFailureResendDelayMs, SERVER_FAILURE_RESENDS, waitForServerResend,
} from "./provider-overload";
import {
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  toolApprovalFaultCode,
  type RuntimeToolPermissionAsk,
  type RuntimeToolPermissionDecision,
} from "./tool-approval";
import type { ToolPermission } from "../../shared/builtin-tools";
import type { ToolInvocationOrigin } from "../../shared/tool-invocation-origin";
import type { ToolResultTrust } from "../../shared/types";
import { normalEndToolEvidence, settleNormalEnd } from "../../shared/turn-settlement";

function agentlasDispatchedOrigin(toolName: string): ToolInvocationOrigin {
  return { kind: "agentlas", providerName: "Agentlas", toolName };
}

/** The typed code of a runner asked to run with no model id (A4 C6.2): refused before any request, never unsettled. */
export const NO_MODEL_SELECTED_CODE = "no_model_selected";

/**
 * A refusal raised before any HTTP request left Main (RuntimeTurnDelivery "not-dispatched", runner.ts): the host keeps the
 * provider code (observed-runner.ts, mcp/client.ts runnerResultRefusedBeforeDispatch) and never reports "may have acted".
 * ownerControlTerminal stays "uncertain" so no follow-up episode is dispatched on top of a refusal.
 */
export function refusedBeforeDispatch(failure: RunnerFailure): RunnerResult {
  return assertCurrentHistoryRunnerResult({ text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure });
}

/** Typed no-model refusal shared by Ollama, LM Studio, MLX, agentlas-local and every BYOK backend. */
export function noModelSelectedResult(runtimeKind: string, message: string): RunnerResult {
  return refusedBeforeDispatch({ kind: "unsupported", runtime: runtimeKind, source: "marker", providerCode: NO_MODEL_SELECTED_CODE, message });
}

/** Socket-level codes that prove the request never reached the server (no TCP connection, no name). Typed, not prose. */
const NOT_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
export function fetchNeverConnected(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NOT_CONNECTED_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export type LocalChatContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAiToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Provider-neutral tool invocation data. No caller may synthesize a provider
 * correlation ID: protocols without one carry their measured response part
 * location into the Main broker instead. */
export interface MainToolDispatchCall {
  providerCallId: string | null;
  providerCallLocation?: WorkforceBrokerProviderCallLocation | null;
  toolName: string;
  arguments: string;
}

export interface MainToolDispatchResult {
  /** Host canonical reference, independent of provider transport correlation. */
  canonicalWorkAction?: { action_id:string; step_id:string };
  /** Main-owned Science result preservation; never a new dispatch authority. */
  rawMcpResult?: Record<string, unknown>;
  artifactPaths?: readonly string[];
  content: string;
  visionMessage: ChatMessage | null;
  isError: boolean;
  /** Provenance of `content` (docs native-harness 07 G02): tool output is data and never drives grants, goals or consent. */
  trust?: ToolResultTrust;
  /** The effect already ran before a crash; this is its recorded result, not a new execution (effect ledger G12). */
  replayed?: true;
}

/**
 * Cache plan for an OpenAI-style /chat/completions request. Segments (render order): tools (S0) and the leading system
 * messages (S1) are the stable prefix; everything between is append-only history (S4); a final user message is this
 * turn's input (S5, volatile). Placement is by role/position only, never by reading the text.
 */
function openAiStyleCachePlan(input: { runtimeKind: string; host: string; chatId?: string | null; ownerId?: string | null;
  model: string; tools: unknown[]; messages: ChatMessage[] }): CachePlan {
  const { messages } = input;
  const segments: CacheSegment[] = [];
  if (input.tools.length > 0) segments.push(segmentOf("tools", "S0", "stable-prefix", JSON.stringify(input.tools)));
  let systemEnd = 0;
  while (systemEnd < messages.length && messages[systemEnd].role === "system") systemEnd += 1;
  segments.push(segmentOf("system", "S1", "stable-prefix", JSON.stringify(messages.slice(0, systemEnd))));
  const last = messages.length - 1;
  const tailIsOwnerInput = last >= systemEnd && messages[last].role === "user";
  const historyEnd = tailIsOwnerInput ? last : messages.length;
  if (historyEnd > systemEnd) segments.push({ id: "history", layer: "S4", cacheClass: "append-only", bytes: JSON.stringify(messages.slice(systemEnd, historyEnd)).length });
  if (tailIsOwnerInput) segments.push({ id: "owner-input", layer: "S5", cacheClass: "volatile-tail", bytes: JSON.stringify(messages[last]).length });
  const capability = input.runtimeKind === "byok"
    ? cacheCapabilityFor({ family: "openai-style", baseUrl: input.host, model: input.model })
    : cacheCapabilityFor({ family: "local", model: input.model });
  return planCache({ capability, segments, model: input.model, scope: { chatId: input.chatId, ownerId: input.ownerId } });
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
export type ResolvedTool =
  | {
      kind: "mcp";
      server: InstalledMcpServer;
      serverToolName: string;
      serverConfigKey: string;
      /** Digest of the resolved Main dispatch record; its contents never leave Main. */
      serverConfigDigest: string;
      schemaDigest: string;
      prepared: PreparedMcpBinding;
      /** Canonical Main inventory ID; provider function names may be sanitized. */
      brokerToolId: string;
    }
  | { kind: "builtin"; builtinName: string; brokerToolId: string };

/**
 * 도구 왕복 상한은 **일의 크기를 재는 숫자가 아니라** 폭주를 세우는 마지막 방벽이다.
 * 8 이었을 때는 정상적인 긴 작업이 여기에 먼저 닿아 "답에 도달하지 못했습니다"로 버려졌다
 * (읽고·고치고·확인만 해도 서너 번이다). 진짜 막힘은 횟수가 아니라 **진전이 없는 것**이라
 * 완료된 호출·결과의 반복으로 잡고, 이 숫자는 그것도 못 잡는 경우를 위한 방벽으로만 남긴다.
 * 사용자는 언제든 중지할 수 있고(req.signal), 각 왕복은 사용자가 보는 중에 일어난다.
 */
const MAX_TOOL_LOOP_TURNS = 200;
/** Shared host-loop progress consumes completed outcomes, never a request alone. */
export function createToolLoopProgress(runtimeKind: string, req: RunnerRequest, target: RunnerEvents): {
  events: RunnerEvents;
  assertProgress(): void;
} {
  const guard = createNoProgressGuard({ observationMode: "completed" });
  return {
    events: { ...target, onTool: (name, args, result, id, isError, artifactPaths, imageDataUrl, origin) => {
      const observedResult = imageDataUrl || artifactPaths?.length
        ? JSON.stringify({ result, artifactPaths,
            imageDigest: imageDataUrl ? createHash("sha256").update(imageDataUrl).digest("hex") : undefined })
        : result;
      noteNoProgressEvent(guard, { kind: "tool-use", tool: { name, args, result: observedResult, id, isError } });
      (currentHistoryRuntimeFence()?.assertCurrent(), target.onTool?.(name, args, result, id, isError, artifactPaths, imageDataUrl, origin));
    } },
    assertProgress(): void {
      if (guard.tripped) throw new RuntimeNoProgressError(runtimeKind, req.locale);
    },
  };
}

/** Every actual HTTP model dispatch is a distinct measured scope. Missing
 * terminals stay unknown, including failed retries before a later success. */
export function createToolLoopUsage(events: RunnerEvents) {
  const usage = createRuntimeUsageCollector();
  return {
    start(): string {
      const id = randomUUID();
      usage.start(id);
      events.onRuntimeAttemptStarted?.(id);
      return id;
    },
    complete(id: string, receipt: ObservedTokenUsage | undefined): void {
      usage.recordTerminal(receipt, id);
      if (receipt) events.onTerminalObservedUsage?.(receipt, id);
    },
    total(): ObservedTokenUsage | undefined { return usage.total(); },
  };
}

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

export async function loadMainToolInventory(
  mcpConfigPath: string | undefined,
  workspaceRoot: string | undefined,
  permission: ToolPermission,
  /** 이 실행이 사람에게 물을 수 있는가 — 무인 실행이면 묻는 도구를 아예 안 준다. */
  canAskUser: boolean,
  /** 멀티모달 슬롯이 그림을 그릴 수 있는가 — 없으면 generate_image 는 목록에 안 뜬다. */
  canGenerateImage: boolean,
  signal?: AbortSignal,
  browserOnly = false,
  canBrowserDownload = false,
  scienceCollectionCapability?: object,
): Promise<{ tools: OpenAiToolDef[]; byName: Map<string, ResolvedTool> }> {
  const collectionBinding = scienceCollectionCapability ? assertScienceCollectionCapability(scienceCollectionCapability, mcpConfigPath) : undefined;
  const tools: OpenAiToolDef[] = [];
  const byName = new Map<string, ResolvedTool>();
  // These imports deliberately live inside the tool-admission path. An
  // untrusted no-tools run must not initialize the MCP registry/catalog or
  // builtin tool implementations merely by importing this runner module.
  const [{ builtinToolsAsOpenAi }, { testServerConnection }] = await Promise.all([
    import("../../shared/builtin-tools"),
    import("../mcp-tools/client"),
  ]);

  // ★내장 도구 먼저. MCP 설정이 없어도(그게 흔한 경우다) 이 런타임은 일할 수 있어야
  // 한다. 권한 칩보다 위의 도구는 목록에 **아예 없다** — "있는데 거절"이 아니라 "없다".
  const historyWorkTools=currentHistoryRuntimeFence()?(await import("../one/personal-integrations-runtime")).currentOneHistoryWorkTools():[];
  if (!collectionBinding && ((workspaceRoot && !browserOnly) || canBrowserDownload || historyWorkTools.length)) {
    // A write run gets `bash` only inside the working-folder sandbox (confined-shell.ts); where none exists it has no shell.
    const canConfineShell = permission === "write" && !!workspaceRoot && !browserOnly
      && (await (await import("./confined-shell")).writeConfinedShell(workspaceRoot)) !== null;
    for (const def of builtinToolsAsOpenAi(permission, { canAskUser, canGenerateImage, canBrowserDownload, historyWorkTools, canConfineShell })) {
      if(historyWorkTools.length&&!historyWorkTools.includes(def.function.name))continue;
      if ((browserOnly || !workspaceRoot) && def.function.name !== "browser_download"&&!historyWorkTools.includes(def.function.name)) continue;
      tools.push(def);
      byName.set(def.function.name, {
        kind: "builtin",
        builtinName: def.function.name,
        brokerToolId: def.function.name,
      });
    }
  }

  if (historyWorkTools.length || !mcpConfigPath) return { tools, byName };
  const admitted = preparedMcpBindings(mcpConfigPath);
  for (const prepared of admitted) {
    if (collectionBinding && prepared !== collectionBinding) throw new Error("science_collection_server_identity_changed");
    signal?.throwIfAborted();
    const key = prepared.configKey;
    const server = prepared.server;
    // The identity comes from the Main-sealed binding, never a model tool name.
    // A browser-only run connects exactly the servers Main sealed for it — the same
    // set claude-code/codex receive in their MCP config. Main owns that decision; a
    // second, stricter filter here left host-loop runtimes with the browser alone. Measured
    // (parity QA 2026-09-25, a browser-mode automation asking for the Seoul time):
    // codex and claude called agentlas-time.get_current_time; serving had 28 browser
    // tools, answered "NEEDS-INPUT: get_current_time is not provided", three runs of
    // three. Builtin file/shell tools stay off in browser-only runs (above), as for claude.
    let status;
    try {
      status = await testServerConnection(server, { timeoutMs: 8_000, signal, prepared });
    } catch {
      signal?.throwIfAborted();
      preparedMcpTransport(prepared, server);
      continue;
    }
    signal?.throwIfAborted();
    preparedMcpTransport(prepared, server);
    if (!status.connected) continue;
    if (new Set(status.tools.map(tool => tool.name)).size !== status.tools.length) throw new Error("mcp_tool_inventory_duplicate_name");
    for (const tool of status.tools) {
      if (collectionBinding && !SCIENCE_COLLECTION_TOOLS.includes(tool.name)) continue;
      // The same ordinary-Work surface Codex, Claude Code and the proxied runtimes carry (hephaestus-tool-surface.ts):
      // this loop connects to the server itself, so it narrows the inventory instead of a proxy list.
      if (mcpToolSurfaceHides(mcpConfigPath, key, tool.name)) continue;
      const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
      const safeTool = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      let name = `mcp__${safeKey}__${safeTool}`.slice(0, 128);
      if (byName.has(name)) name = `${name.slice(0, 110)}__${mcpToolSchemaDigest([key, tool.name]).slice(0, 16)}`;
      if (byName.has(name)) throw new Error("mcp_tool_inventory_name_collision");
      tools.push({
        type: "function",
        function: {
          name,
          description: tool.description,
          parameters:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? tool.inputSchema
              : { type: "object", properties: {} },
        },
      });
      byName.set(name, {
        kind: "mcp",
        server,
        serverToolName: tool.name,
        serverConfigKey: key,
        serverConfigDigest: workforceBrokerDigest(server),
        schemaDigest: mcpToolSchemaDigest(tool),
        prepared,
        brokerToolId: `mcp__${key}__${tool.name}`,
      });
    }
  }
  return { tools, byName };
}

export function mainToolBrokerInventory(
  tools: readonly OpenAiToolDef[],
  byName: ReadonlyMap<string, ResolvedTool>,
): WorkforceBrokerInventoryEntry[] {
  return tools.map((tool) => {
    const resolved = byName.get(tool.function.name);
    if (!resolved) throw new Error("workforce_broker_tool_inventory_missing");
    if (resolved.kind === "builtin") {
      return {
        toolId: resolved.brokerToolId,
        kind: "builtin",
        descriptorDigest: workforceBrokerDigest(tool),
        serverConfigKey: null,
        serverConfigDigest: null,
      };
    }
    return {
      toolId: resolved.brokerToolId,
      kind: "mcp",
      descriptorDigest: workforceBrokerDigest(tool),
      serverConfigKey: resolved.serverConfigKey,
      serverConfigDigest: resolved.serverConfigDigest,
    };
  });
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
export interface LocalToolApprovalContext {
  canonicalWorkRecovery?: MainWorkRecoveryContext;
  /** Science bridge only: project the exact response envelope after this approved dispatch. */
  retainMcpToolResult?: true;
  beforeMcpToolResult?: RunnerRequest["beforeMcpToolResult"];
  /** Shared by nested code-mode approval clones; a delivery rejection is terminal. */
  mcpResultDeliveryState?: { blocked: boolean; reason?: unknown; pending: Set<Promise<void>> };
  scienceCollectionCapability?: object;
  /** Main-owned dynamic authority checked again after an asynchronous approval. */
  assertCurrent?: () => void;
  planMode?: true;
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
  /** Agentlas-resolved environment (saved tool keys, agent .env) — what a CLI runtime's shell already gets. */
  env?: NodeJS.ProcessEnv;
  /** Main-owned broker ledger hook. It records the exact approval decision. */
  onApprovalDecision?: (decision: RuntimeToolPermissionDecision) => void;
  /** A refusal that came from a fault in the approval path rather than a policy decision (machine token, see tool-approval.ts). */
  onApprovalFault?: (code: string) => void;
}

/**
 * One Main-owned admission and approval context for every in-process provider
 * protocol. Anthropic and Gemini use different wire envelopes, but they must
 * not get a different MCP discovery, approval, dispatch, or broker ledger.
 */
export interface MainToolLoopContext {
  tools: OpenAiToolDef[];
  byName: Map<string, ResolvedTool>;
  broker?: MainWorkforceBroker;
  approval: LocalToolApprovalContext;
}

/** Run-scoped MCP connections, keyed by the run's own tool map (never shared across runs). */
const mcpToolCallSessions = new WeakMap<Map<string, ResolvedTool>, import("../mcp-tools/client").McpToolCallSession>();

export async function prepareMainToolLoop(
  req: RunnerRequest,
  runtimeKind: string,
): Promise<MainToolLoopContext> {
  const collection = req.scienceCollectionCapability;
  // Under a Science / Alive-Science grant the server-side model must see that
  // grant's catalog only (it already bridges the Desktop tools it admits). An
  // ordinary One/Work run gets the same builtins as every host-loop runtime —
  // before 2026-09-24 serving in Work had no file/shell tools at all.
  // BYOK adapters use this same Main loop. A signed Science catalog is the
  // complete grant there too; API delivery must not add file/shell/download tools.
  const catalogMcpOnly = Boolean(req.mcpConfigPath) && req.mcpGrantCatalogOnly === true;
  if (collection) {
    assertScienceCollectionCapability(collection, req.mcpConfigPath);
    if (!["byok", "ollama", "lmstudio", "mlx", "agentlas-local", "agentlas"].includes(runtimeKind)) {
      throw new Error("science_collection_transport_unsupported");
    }
    if (req.history.length || req.planMode || req.workforceRuntimeToolGrant || req.untrustedNoTools) {
      throw new Error("science_collection_isolated_request_required");
    }
  }
  const { tools: eagerTools, byName } = req.untrustedNoTools
    ? { tools: [] as OpenAiToolDef[], byName: new Map<string, ResolvedTool>() }
    : collection ? await loadMainToolInventory(req.mcpConfigPath, undefined, "read", false, false, req.signal, false, false, collection)
    : await (async () => {
        // Tool-surface discovery lives inside this branch so the Main-authored
        // untrusted boundary cannot initialize tool implementations or MCP.
        const { multimodalImageSlotDiagnosis } = await import("../multimodal/slot");
        const imageSlotDiagnosis = await multimodalImageSlotDiagnosis();
        return loadMainToolInventory(
          req.mcpConfigPath,
          catalogMcpOnly ? undefined : req.cwd,
          (req.permission ?? "read") as ToolPermission,
          // Nobody answers an unattended run, Mobile answers later, and a team worker's questions belong to its
          // orchestrator (RunnerRequest.unattendedNoAsk): none of them lists the synchronous ask_user tool.
          req.unattended !== true && req.noSynchronousAsk !== true && req.unattendedNoAsk !== true,
          imageSlotDiagnosis.state === "ready",
          req.signal,
          req.browserOnly === true,
          catalogMcpOnly ? false : await browserDownloadAvailable(req.approvalChatId ?? req.chatId, req.agentId),
        );
      })();
  // ★ 로컬 소형 모델(agentlas-local)에는 도구를 그대로 준다. 코드 모드(agentlas_code)와 지연 메뉴

  //   agentlas_code 만 5번 부르다 브라우저에 닿지 못하고 사용자에게 되물었다. 같은 모델에 도구를
  //   직접 주면 브라우저·파일·셸 4/4 정확(엔진 직결 실측).
  // A Main-issued effect observation looks only: read built-ins and Main's browser server, offered directly (no code
  // mode or lazy menu). Every other server's schemas are context the look does not need (routed 2026-09-25).
  if (req.minimalObservation && !collection) {
    for (let index = eagerTools.length - 1; index >= 0; index -= 1) {
      const resolved = byName.get(eagerTools[index].function.name);
      if (resolved?.kind === "mcp" && resolved.serverConfigKey !== "agentlas-browser") {
        byName.delete(eagerTools[index].function.name);
        eagerTools.splice(index, 1);
      }
    }
  }
  // Small local models (managed Local, Ollama, LM Studio, MLX) get their tools directly: behind agentlas_code they
  // reached for it first and then flailed (gpt-oss on Ollama, 2026-10-11, measured in the captured requests).
  const smallLocalModel = runtimeKind === "agentlas-local" || runtimeKind === "ollama" || runtimeKind === "lmstudio" || runtimeKind === "mlx";
  const indirectToolSurface = !collection && !catalogMcpOnly && !req.workforceRuntimeToolGrant && !req.untrustedNoTools && !smallLocalModel
    && !req.minimalObservation;
  // Small managed local models keep their ordinary Browser/file/shell tools
  // direct. A single large MCP contract still needs on-demand schema discovery:
  // the statistics server alone has 180 alternatives (>300 KB).
  const menuAllowed = !collection && !catalogMcpOnly && !req.workforceRuntimeToolGrant && !req.untrustedNoTools && !req.minimalObservation;
  const sessionKey = `${runtimeKind}:${req.sessionFingerprintSeed ?? req.cwd ?? "default"}`;
  const tools = installToolResultContext(
    installLazyToolMenu(installMainCodeMode(eagerTools, byName, indirectToolSurface), byName, menuAllowed, runtimeKind === "agentlas-local", runtimeKind === "byok" || runtimeKind === "agentlas"),
    byName, { runtimeKind, sessionKey, cwd: req.cwd || undefined,
      chatId: (req.approvalChatId ?? req.chatId) || undefined, agentId: req.agentId || undefined },
    !collection && !req.mcpGrantCatalogOnly && !req.workforceRuntimeToolGrant && !req.untrustedNoTools && !req.minimalObservation,
  );
  if (collection) {
    const admitted = [...byName.values()].filter((tool) => tool.kind === "mcp")
      .map((tool) => tool.serverToolName);
    if (admitted.length !== SCIENCE_COLLECTION_TOOLS.length
      || SCIENCE_COLLECTION_TOOLS.some((name) => !admitted.includes(name))) {
      throw new Error("science_collection_tool_inventory_incomplete");
    }
  }
  // One MCP connection per server for this run (see createMcpToolCallSession):
  // a stateful server — the Agentlas browser's page above all — keeps its state
  // between this loop's tool calls exactly as it does under a CLI runtime.
  if ([...byName.values()].some((tool) => tool.kind === "mcp")) {
    const { createMcpToolCallSession } = await import("../mcp-tools/client");
    mcpToolCallSessions.set(byName, createMcpToolCallSession({ signal: req.signal }));
  }
  return {
    tools: req.canonicalWorkRecovery ? tools.map(tool=>({...tool,function:{...tool.function,parameters:mainWorkToolSchema(tool.function.parameters)}})) : tools,
    byName,
    ...(req.workforceRuntimeToolGrant && !req.untrustedNoTools
      ? { broker: new MainWorkforceBroker(req, runtimeKind, mainToolBrokerInventory(tools, byName)) }
      : {}),
    approval: {
      ...(req.canonicalWorkRecovery ? {canonicalWorkRecovery:req.canonicalWorkRecovery} : {}),
      ...(req.beforeMcpToolResult ? { beforeMcpToolResult: req.beforeMcpToolResult } : {}),
      ...(collection ? { scienceCollectionCapability: collection } : {}),
      ...(req.planMode ? { planMode: true as const } : {}),
      runtimeKind,
      sessionKey,
      permission: req.permission,
      ...(req.cwd ? { cwd: req.cwd } : {}),
      ...(req.approvalChatId ?? req.chatId ? { chatId: req.approvalChatId ?? req.chatId } : {}),
      ...(req.agentId ? { agentId: req.agentId } : {}),
      unattended: req.unattended === true,
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.env ? { env: req.env } : {}),
    },
  };
}

async function approveLocalToolCall(
  ctx: LocalToolApprovalContext,
  toolName: string,
  consentMaterial: unknown,
  detail?: string,
  admittedReadPermission = false,
): Promise<RuntimeToolPermissionDecision> {
  // 내장 도구는 우리가 만든 것이라 성격을 안다 — 지어내는 게 아니라 아는 것을 싣는다.
  // MCP reads require Main's exact catalog/argument admission below; a remote
  // tool's claimed annotations never grant read permission.
  const { builtinToolByName } = await import("../../shared/builtin-tools");
  const builtin = builtinToolByName(toolName);
  const builtinKind = admittedReadPermission ? "read" as const : builtin
    ? builtin.minPerm === "read"
      ? ("read" as const)
      : builtin.name === "browser_download"
        ? ("fetch" as const)
        : builtin.name === "bash"
        ? ("execute" as const)
        : ("edit" as const)
    : null;
  ctx.signal?.throwIfAborted();
  const ask: RuntimeToolPermissionAsk = {
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.planMode ? { planMode: true as const } : {}),
    runtime: ctx.runtimeKind,
    sessionKey: ctx.sessionKey,
    tool: toolName,
    kind: builtinKind ?? "other",
    ...(detail ? {detail} : {}),
    // Display detail is separate from the exact Main-owned consent scope.
    // Credentials and raw arguments must not be copied into an approval card.
    cwd: ctx.cwd,
    permission: ctx.permission,
    // 내장 read_file·list_dir 은 변이가 아니라는 것을 **증명할 수 있다**(우리 코드다).
    // Unknown MCP calls remain mutating; only Main-admitted reads are exempt.
    mutating: builtinKind ? builtinKind !== "read" : true,
    ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.unattended ? { unattended: true as const } : {}),
  };
  bindMainToolConsentResource(ask, consentMaterial);
  const arbiter = getRuntimeToolPermissionArbiter();
  let decision: RuntimeToolPermissionDecision;
  if (!arbiter) {
    decision = defaultRuntimeToolPermission(ask);
  } else {
    try {
      decision = await arbiter(ask);
    } catch {
      decision = "deny";
    }
  }
  const fault = decision === "deny" ? toolApprovalFaultCode(ask) : undefined;
  if (fault) ctx.onApprovalFault?.(fault);
  ctx.signal?.throwIfAborted();
  ctx.onApprovalDecision?.(decision);
  return decision;
}

/** Protocol-neutral Main dispatch. Provider wire adapters own only their
 * request/response envelopes; admission, approval, execution and ledger
 * outcomes are all recorded here. */
export async function runMainToolDispatch(
  byName: Map<string, ResolvedTool>,
  call: MainToolDispatchCall,
  events: RunnerEvents,
  approval: LocalToolApprovalContext,
  broker?: MainWorkforceBroker,
): Promise<MainToolDispatchResult> {
  const acks: string[] = [];
  const result = await effectAckScope.run(acks, () => dispatchMainToolRaw(byName, call, events, approval, broker));
  if(result.canonicalWorkAction) result.content += `\nHost work reference: ${JSON.stringify(result.canonicalWorkAction)}`;
  // Pages already have their own bounded, exact range protocol. Do not replace
  // a page with another reference or duplicate the screenshot channel.
  const handedBack: MainToolDispatchResult = call.toolName === TOOL_RESULT_READ || approval.retainMcpToolResult ? result : {
    ...result, content: projectToolResult(byName, approval, result.content, call.providerCallId, result.isError),
  };
  // The result is now being handed back to the model: settled effects stored for crash replay are acknowledged (G12).
  await acknowledgeMainEffects(acks);
  return handedBack;
}

/** Refs of effects settled during one model-visible dispatch (a code-mode call nests several). Acknowledged when that dispatch returns. */
const effectAckScope = new AsyncLocalStorage<string[]>();
async function acknowledgeMainEffects(refs: readonly string[]): Promise<void> {
  if (!refs.length) return;
  try { const ledger = await import("../harness/effect-ledger"); for (const ref of refs) await ledger.acknowledgeEffect(ref); } catch { /* never fails a tool result */ }
}

/** Nested code-mode calls consume actual values, not provider projections. */
async function dispatchMainToolRaw(
  byName: Map<string, ResolvedTool>, call: MainToolDispatchCall, events: RunnerEvents,
  approval: LocalToolApprovalContext, broker?: MainWorkforceBroker,
): Promise<MainToolDispatchResult> {
  if (approval.beforeMcpToolResult) approval.mcpResultDeliveryState ??= { blocked: false, pending: new Set() };
  assertMcpResultDelivery(approval);
  // A name copied from another runtime's history ("codex_apps.google_calendar.search_events") resolves to the one
  // registered tool it denotes (tool-name-alias.ts); the resolved name then goes through the same menu and approval.
  if (!byName.has(call.toolName)) {
    const alias = resolveToolNameAlias(byName.keys(), call.toolName);
    if (alias) call = { ...call, toolName: alias };
  }
  let result:MainToolDispatchResult;
  // Pre-effect checkpoint (harness/effect-ledger.ts): the unchecked dispatcher begins it right before the effect leaves
  // Main; the outcome is settled here, an exception after dispatch counting as uncertain.
  const effectSlot: MainEffectSlot = {};
  try {
    if(currentHistoryRuntimeFence()){const resolved=byName.get(call.toolName);const input={kind:resolved?.kind??"builtin" as const,serverId:resolved?.kind==="mcp"?resolved.server.id:null,catalogId:resolved?.kind==="mcp"?resolved.server.catalogId??null:null,toolName:resolved?.kind==="mcp"?resolved.serverToolName:resolved?.kind==="builtin"?resolved.builtinName:call.toolName,args:JSON.parse(call.arguments),schemaDigest:resolved?.kind==="mcp"?resolved.schemaDigest:null};result=await withCurrentHistoryTool(input,()=>dispatchMainToolRawUnchecked(byName, call, events, approval, broker, effectSlot));}
    else result=await dispatchMainToolRawUnchecked(byName, call, events, approval, broker, effectSlot);
    result = { ...result, trust: result.trust ?? "tool-result" };
  } catch (error) {
    if (effectSlot.ref) await settleMainEffect(effectSlot.ref, "uncertain");
    throw error;
  }
  if (effectSlot.ref) {
    await settleMainEffect(effectSlot.ref, result.isError ? "failed" : "settled", result.content);
    const acks = effectAckScope.getStore();
    if (acks) acks.push(effectSlot.ref); else await acknowledgeMainEffects([effectSlot.ref]);
  }
  if (effectSlot.replayedRef) {
    const acks = effectAckScope.getStore();
    if (acks) acks.push(effectSlot.replayedRef); else await acknowledgeMainEffects([effectSlot.replayedRef]);
  }
  // A timed-out code guest can return while its detached host calls are still
  // awaiting Main. Its bounded cleanup must not release a provider response.
  while (approval.mcpResultDeliveryState?.pending.size) {
    await Promise.all([...approval.mcpResultDeliveryState.pending]);
  }
  // Code mode may catch a nested rejection as guest data. It cannot turn that
  // host decision into a provider-visible error or dispatch another host tool.
  assertMcpResultDelivery(approval);
  approval.signal?.throwIfAborted();
  approval.assertCurrent?.();
  return result;
}

function assertMcpResultDelivery(approval: LocalToolApprovalContext): void {
  if (approval.mcpResultDeliveryState?.blocked) throw approval.mcpResultDeliveryState.reason;
}

async function awaitMcpResultDelivery(
  approval: LocalToolApprovalContext,
  input: Parameters<NonNullable<RunnerRequest["beforeMcpToolResult"]>>[0],
): Promise<void> {
  const state = approval.mcpResultDeliveryState;
  let delivery: Promise<void> | undefined;
  try {
    delivery = approval.beforeMcpToolResult?.(input);
    if (delivery) state?.pending.add(delivery);
    await delivery;
  } catch (reason) {
    const blocked = approval.mcpResultDeliveryState ??= { blocked: false, pending: new Set() };
    blocked.blocked = true; blocked.reason = reason;
    throw reason;
  } finally {
    if (delivery) state?.pending.delete(delivery);
  }
  assertMcpResultDelivery(approval);
  approval.signal?.throwIfAborted();
  approval.assertCurrent?.();
}

interface MainEffectSlot { ref?: string; replayedRef?: string }

async function settleMainEffect(ref: string, state: "settled" | "failed" | "uncertain", resultText?: string): Promise<void> {
  try { await (await import("../harness/effect-ledger")).settleEffect(ref, state, state === "settled" && resultText !== undefined ? { result: resultText } : undefined); } catch { /* the ledger never fails a tool result */ }
}

async function dispatchMainToolRawUnchecked(
  byName: Map<string, ResolvedTool>, call: MainToolDispatchCall, events: RunnerEvents,
  approval: LocalToolApprovalContext, broker?: MainWorkforceBroker, effectSlot?: MainEffectSlot,
): Promise<MainToolDispatchResult> {
  approval.signal?.throwIfAborted();
  try {
    if (call.toolName === TOOL_RESULT_READ && hasToolResultContext(byName)) {
      if (broker || approval.scienceCollectionCapability) throw new Error("tool_result_read_not_admitted");
      const request = toolResultReadRequest(byName, approval, call.arguments);
      const decision = await approveLocalToolCall(approval, call.toolName,
        { kind: "tool-result-range", ...request }, call.toolName, true);
      if (decision === "deny") throw new Error("tool_result_read_permission_denied");
      approval.signal?.throwIfAborted(); approval.assertCurrent?.();
      const content = readToolResult(byName, approval, request);
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, undefined, call.providerCallId ?? undefined, false, undefined, undefined, agentlasDispatchedOrigin(call.toolName)));
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, content, call.providerCallId ?? undefined, false, undefined, undefined, agentlasDispatchedOrigin(call.toolName)));
      return { content, visionMessage: null, isError: false };
    }
    if (approval.scienceCollectionCapability) assertScienceCollectionTool(approval.scienceCollectionCapability, byName.get(call.toolName));
    if (call.toolName === CODE_MODE_TOOL) {
      if (broker) throw new Error("code_mode_broker_not_supported");
      // Start receipt for the host-owned wrapper operation (see the dispatch start below).
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, undefined, call.providerCallId ?? undefined, false, undefined, undefined, agentlasDispatchedOrigin(call.toolName)));
      const result = await runMainCodeMode(byName, call.arguments, events, approval, dispatchMainToolRaw);
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, result.content, call.providerCallId ?? undefined, result.isError, undefined, undefined, agentlasDispatchedOrigin(call.toolName)));
      return result;
    }
    const menu = resolveToolMenu(byName, call.toolName, call.arguments);
    if (menu?.kind === "result") {
      // Menu listing/preparation is a host operation too; the effect reader needs start + result
      // (live 2026-09-25, run 3834da2a: three agentlas_tools_* results alone kept the boundary pending).
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, undefined, call.providerCallId ?? undefined, false, undefined, undefined, agentlasDispatchedOrigin(call.toolName)));
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, menu.content, call.providerCallId ?? undefined, false, undefined, undefined, agentlasDispatchedOrigin(call.toolName)));
      return { content: menu.content, visionMessage: null, isError: false };
    }
    if (menu?.kind === "call") {
      if (broker) throw new Error("tool_menu_broker_not_supported");
      // Keep the provider's correlation ID, but record the exact prepared tool
      // that Main approved and executed. Recording only agentlas_tools_call
      // makes a successful ledger row unable to identify its actual effect.
      const providerCall = call;
      const providerEvents = events;
      events = {
        ...events,
        onTool: (name, args, result, _providerId, ...rest) =>
          (currentHistoryRuntimeFence()?.assertCurrent(), providerEvents.onTool?.(name, args, result, providerCall.providerCallId ?? undefined, ...rest)),
      };
      call = { ...call, toolName: menu.toolName, arguments: menu.arguments };
    }
  } catch (error) {
    const content = `Error: ${error instanceof Error ? error.message : String(error)}`;
    (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, content, call.providerCallId ?? undefined, true));
    return { content, visionMessage: null, isError: true };
  }
  const eventCallId = call.providerCallId ?? undefined;
  const resolved = byName.get(call.toolName);
  // Main assigns this opaque action ID before parsing/approval/dispatch. The
  // provider call ID stays only as an input correlation value in the ledger.
  const brokerToolId = resolved?.brokerToolId ?? call.toolName;
  if (broker && !/^[A-Za-z0-9][A-Za-z0-9_.$:/@+~-]{0,127}$/.test(brokerToolId)) {
    // Do not mint a replacement ID for malformed provider protocol. The run
    // fails before dispatch and therefore cannot carry a success receipt.
    throw new Error("workforce_broker_provider_tool_id_invalid");
  }
  const actionId = broker
    ? broker.beginAction(call.providerCallId, brokerToolId, call.providerCallLocation ?? null)
    : undefined;
  if (!resolved) {
    if (actionId) broker?.finishAction(actionId, "not_dispatched");
    (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, "unknown tool", eventCallId, true));
    return {
      content: unknownToolMessage(call.toolName, byName.keys()),
      visionMessage: null,
      isError: true,
    };
  }
  let args: Record<string, unknown> = {};
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    if (actionId) broker?.finishAction(actionId, "not_dispatched");
    (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, "invalid JSON arguments", eventCallId, true));
    return {
      content: "Error: invalid JSON arguments",
      visionMessage: null,
      isError: true,
    };
  }
  let workReference: MainWorkReference | undefined;
  if (approval.canonicalWorkRecovery) {
    assertMainWorkRecoveryContext(approval.canonicalWorkRecovery);
    const reference=args._agentlas_work;
    if(reference!==undefined) {
      if(!reference || typeof reference!=="object" || Array.isArray(reference)
        || Object.entries(reference).some(([key,value])=>key==="regenerate_read" ? value!==true : !["action_id","step_id"].includes(key) || typeof value!=="string"))throw new Error("main_work_reference_invalid");
      workReference=reference as MainWorkReference;
      delete args._agentlas_work;
      call={...call,arguments:JSON.stringify(args)};
    }
  }
  approval.signal?.throwIfAborted();
  const planTransport = resolved.kind === "mcp" ? preparedMcpTransport(resolved.prepared, resolved.server) : null;
  let planReadAuthority: unknown;
  if (approval.planMode && planTransport?.kind === "stdio") {
    try { planReadAuthority = JSON.parse(planTransport.env.AGENTLAS_MCP_PROXY_SESSION ?? "{}").planReadAuthority; } catch { /* unknown authority is denied */ }
  }
  // Resolve against Main's dispatcher identity, never a tool's name or claimed
  // annotations. Plan cannot borrow an existing mutation approval.
  // minPerm is an approval profile, not an effect declaration (image generation
  // currently has minPerm=read). Only these host implementations are observational.
  // judgment-exempt: 관측된 런타임 도구 이름을 분류하는 게 아니다 — Main 이 직접 구현한
  // 로컬 루프 내장 도구(resolved.kind === "builtin")의 닫힌 집합에서 계획 모드 승인 대상을 고른다.
  const planMutation = resolved.kind === "builtin"
    ? !["list_dir", "read_file", "read_image", "ask_user"].includes(resolved.builtinName)
    : planMcpToolIsMutating({ authority: planReadAuthority, toolName: resolved.serverToolName, args });
  if (approval.planMode && planMutation) {
    const content = "Error: plan_mode_mutation_denied";
    if (actionId) broker?.finishAction(actionId, "denied");
    (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, content, eventCallId, true));
    return { content, visionMessage: null, isError: true };
  }
  // 승인은 **호출 직전**이다. 인자를 파싱한 뒤, 서버에 닿기 전.
  let approvalDecision: RuntimeToolPermissionDecision | null = null;
  let approvalFault: string | undefined;
  const actionApproval: LocalToolApprovalContext = {
    ...approval,
    ...(actionId ? {
      onApprovalDecision: (decision: RuntimeToolPermissionDecision) => {
        approval.onApprovalDecision?.(decision);
        approvalDecision = decision;
        broker?.recordDecision(actionId, decision);
      },
    } : {}),
    onApprovalFault: (code) => { approval.onApprovalFault?.(code); approvalFault = code; },
  };
  let downloadOrigin: string | undefined;
  if (resolved.kind === "builtin" && resolved.builtinName === "browser_download" && typeof args.url === "string") {
    try { downloadOrigin = new URL(args.url).origin; } catch { /* The builtin rejects invalid URLs before dispatch. */ }
  }
  const consentMaterial = resolved.kind === "mcp"
    ? { tool: call.toolName, target: preparedMcpConsentResource(resolved.prepared, resolved.server),
        schema: resolved.schemaDigest, arguments: args }
    : { tool: call.toolName, builtin: resolved.builtinName, arguments: args };
  // The Main-issued collection grant is already exact, unattended consent for
  // these three Science actions, including the bounded source-record write.
  const collectionDecision = approval.scienceCollectionCapability ? "allow_once" as const : null;
  if (collectionDecision) actionApproval.onApprovalDecision?.(collectionDecision);
  const admittedMcpRead = resolved.kind === "mcp" && !mcpToolIsMutating({
    catalogId: resolved.server.catalogId, toolName: resolved.serverToolName, args,
  }) && (resolved.server.catalogId !== "agentlas-browser"
    || !readOnlyBrowserToolIsMutating({ toolName: resolved.serverToolName, args }));
  if ((collectionDecision ?? await approveLocalToolCall(actionApproval, call.toolName, consentMaterial, downloadOrigin, admittedMcpRead)) === "deny") {
    if (actionId) broker?.finishAction(actionId, "denied");
    // A refusal caused by a fault in the approval path says so, in machine form (the classification above still reads it as declined).
    const denied = `Error: tool call denied — "${call.toolName}" was not approved for this run.${approvalFault ? ` [approval_fault:${approvalFault}]` : ""}`;
    (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, denied, eventCallId, true));
    return {
      content: denied,
      visionMessage: null,
      isError: true,
    };
  }
  approval.signal?.throwIfAborted();
  approval.assertCurrent?.();
  if (approval.scienceCollectionCapability) assertScienceCollectionTool(approval.scienceCollectionCapability, resolved);
  if (resolved.kind === "mcp") preparedMcpTransport(resolved.prepared, resolved.server);
  // Start receipt: the call passed admission and approval and is about to leave Main.
  // The effect-boundary reader requires start+result per operation (codex emits
  // item.started the same way). Without it every host-loop Goal turn (serving,
  // agentlas-local, BYOK) read "outcome-pending" and verification stayed inconclusive
  // (isolated live run 2026-09-25, run_80dc1968: 12 inconclusive receipts).
  let work:ReturnType<MainWorkRecoveryContext["admit"]>|undefined;
  try {
    work=approval.canonicalWorkRecovery?.admit({reference:workReference,methodId:brokerToolId,arguments:args,observational:!planMutation});
  } catch(error) {
    const code=error instanceof Error ? error.message : String(error);
    if(!/^main_work_(?:read_original_outcome|action_not_in_task|action_input_conflict|checkpoint_step_invalid|worker_liveness_unknown|outcome_unconfirmed|result_read_unavailable|read_regeneration_required|same_method_limit|same_method_limit_or_claim_changed)/.test(code))throw error;
    if(actionId)broker?.finishAction(actionId,"not_dispatched");
    return {content:JSON.stringify({code,recovery:approval.canonicalWorkRecovery!.packet({always:true})}),visionMessage:null,isError:true};
  }
  if(work && "reused" in work) {
    // Original custody avoids another effect; delivery still belongs to this run.
    if (resolved.kind === "mcp") await awaitMcpResultDelivery(approval, {
      catalogId: resolved.server.catalogId ?? null,
      toolName: resolved.serverToolName, isError: work.reused.isError,
    });
    if(actionId)broker?.finishAction(actionId,work.reused.isError ? "failed" : "succeeded");
    return {...work.reused,canonicalWorkAction:{action_id:work.action.actionId,step_id:work.action.stepId}} as MainToolDispatchResult;
  }
  // Mutating calls (the same closed classification approval used above) checkpoint before the effect; canonical work
  // recovery already owns its own original-outcome custody, so it is not checkpointed twice.
  const mutatingEffect = resolved.kind === "builtin" ? planMutation : !admittedMcpRead;
  if (mutatingEffect && !work && effectSlot) {
    const ledger = await import("../harness/effect-ledger");
    const effectTool = resolved.kind === "mcp" ? `mcp:${resolved.server.catalogId ?? resolved.server.id}:${resolved.serverToolName}` : `builtin:${resolved.builtinName}`;
    const begun = await ledger.beginEffect({ surface: "main-loop", chatId: approval.chatId ?? null, run: ledger.effectRunId(approval), tool: effectTool, args });
    if (begun.status === "uncertain_prior") {
      if (actionId) broker?.finishAction(actionId, "not_dispatched");
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, begun.content, eventCallId, true));
      return { content: `Error: ${begun.content}`, visionMessage: null, isError: true };
    }
    if (begun.status === "replayed") {
      // The identical effect already ran and settled but its result never reached the model (crash before ACK): hand the
      // stored, redacted result back instead of executing again. The caller acknowledges it once it is handed back.
      if (actionId) broker?.finishAction(actionId, "succeeded");
      const content = `[replayed: true - the host recorded this result when the identical call ran at ${begun.priorAt}; the call was not executed again]\n${begun.content}`;
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, content, eventCallId, false));
      effectSlot.replayedRef = begun.priorRef;
      return { content, visionMessage: null, isError: false, replayed: true };
    }
    effectSlot.ref = begun.ref;
  }
  withDurableMainToolStart(() => (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, undefined, eventCallId, false, undefined, undefined, agentlasDispatchedOrigin(call.toolName))));
  if (resolved.kind === "builtin") {
    const [{ runBuiltinTool }, { askUser }, { multimodalImageSlot }, { generateImage }] = await Promise.all([
      import("../../shared/builtin-tools"),
      import("../confirm/ask-user"),
      import("../multimodal/slot"),
      import("../multimodal/image"),
    ]);
    approval.signal?.throwIfAborted();
    approval.assertCurrent?.();
    const downloadProof = resolved.builtinName === "browser_download"
      ? beginBrowserDownloadProof({...approval,toolId:eventCallId,toolName:call.toolName}) : null;
    const fileProof = beginBuiltinFileProof({ ...approval, toolId: eventCallId, toolName: call.toolName, builtinName: resolved.builtinName });
    let shellEnv: NodeJS.ProcessEnv | undefined;
    if (resolved.builtinName === "bash") {
      try {
        shellEnv = builtinShellEnv(approval.env ?? process.env);
      } catch (error) {
        const marker = error instanceof Error ? error.message : "";
        const code = /^builtin_python_[a-z_]+$/.test(marker) ? marker : "builtin_shell_runtime_unavailable";
        const content = JSON.stringify({ error: { code } });
        attestMainToolPreDispatchRejection({ adapterKind: approval.runtimeKind, chatId: approval.chatId,
          agentId: approval.agentId, toolId: eventCallId });
        (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, content, eventCallId, true,
          undefined, undefined, agentlasDispatchedOrigin(call.toolName)));
        if (actionId) {
          if (approvalDecision === null) throw new Error("workforce_broker_approval_missing");
          broker?.finishAction(actionId, "failed");
        }
        return { content: `Error: ${content}`, visionMessage: null, isError: true };
      }
    }
    const builtinCwd = approval.cwd ?? process.cwd();
    const confineShell = resolved.builtinName === "bash" && approval.permission === "write"
      ? await (await import("./confined-shell")).writeConfinedShell(builtinCwd) : null;
    const outcome = await runBuiltinTool(resolved.builtinName, args, {
      cwd: builtinCwd,
      permission: (approval.permission ?? "read") as ToolPermission,
      signal: approval.signal,
      ...(shellEnv ? { env: shellEnv } : {}),
      ...(confineShell ? { confineShell } : {}),
      ...(downloadProof ? {browserDownload:downloadProof.download} : {}),
      ...(currentHistoryRuntimeFence()?{historyWork:async(name:string,value:Record<string,unknown>)=>{
        if(name==="history_work_draft")return withCurrentHistoryProducer("agent",p=>p.agent.draftFinite(value),()=>{throw new Error("history_work_original_scope_required")});
        if(name==="history_work_apply"&&Reflect.ownKeys(value).length===0)return withCurrentHistoryApplication();
        throw new Error("history_work_original_scope_required");
      }}:{}),
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
    (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(
      call.toolName,
      call.arguments,
      outcome.content,
      eventCallId,
      !outcome.ok,
      outcome.artifactPaths,
      outcome.imageDataUrl,
      agentlasDispatchedOrigin(call.toolName),
    ));
    if (outcome.ok && outcome.downloadId) {
      try { await downloadProof?.complete(outcome.downloadId); } catch { /* Missing durable proof is never completion evidence. */ }
    }
    if (outcome.ok && outcome.fileObservation) {
      try { fileProof?.complete(outcome.fileObservation); } catch { /* Missing durable proof never permits a verification pass. */ }
    }
    if (actionId) {
      if (approvalDecision === null) throw new Error("workforce_broker_approval_missing");
      broker?.finishAction(actionId, outcome.ok ? "succeeded" : "failed");
    }
    const dispatched:MainToolDispatchResult = {
      content: outcome.ok ? outcome.content : `Error: ${outcome.content}`,
      ...(outcome.artifactPaths ? { artifactPaths: outcome.artifactPaths } : {}),
      visionMessage: outcome.ok && outcome.imageDataUrl
        ? {
            role: "user",
            content: [
              { type: "text", text: "The preceding host tool produced this verified image." },
              { type: "image_url", image_url: { url: outcome.imageDataUrl } },
            ],
          }
        : null,
      isError: !outcome.ok,
    };
    if(work && "unit" in work) {
      approval.canonicalWorkRecovery!.finish(work,dispatched);
      dispatched.canonicalWorkAction={action_id:work.action.actionId,step_id:work.action.stepId};
    }
    return dispatched;
  }
  let mcpOutcome: MainToolDispatchResult;
  try {
    const [{ callServerToolContent }, { saveBrowserCaptureArtifact }] = await Promise.all([
      import("../mcp-tools/client"),
      import("../media/capture-artifacts"),
    ]);
    approval.signal?.throwIfAborted();
    approval.assertCurrent?.();
    // Same host file proof as builtin writes, for MCP file tools Main can identify by catalog.
    const mcpFileCandidate = mcpFileProofCandidate({ toolId: eventCallId, toolName: call.toolName,
      serverToolName: resolved.serverToolName, args, catalogId: resolved.server.catalogId,
      chatId: approval.chatId, cwd: approval.cwd, permission: approval.permission });
    const mcpFileProof = mcpFileCandidate ? beginNativeFileProof(mcpFileCandidate) : null;
    const result = await callServerToolContent(resolved.server, resolved.serverToolName, args, {
      timeoutMs: oneGraphToolTimeoutMs({ catalogId: resolved.server.catalogId, toolName: resolved.serverToolName, args }),
      signal: approval.signal, prepared: resolved.prepared,
      ...(approval.retainMcpToolResult ? { retainFullResult: true as const } : {}),
      expectedToolSchemaDigest: resolved.schemaDigest, onToolSchemaInvalidated: () => invalidateToolMenu(byName),
      session: mcpToolCallSessions.get(byName),
    });
    if (!result) throw new Error("mcp_tool_result_unavailable");
    const text = result?.text ?? "";
    const images = result.isError || approval.scienceCollectionCapability ? [] : result.images;
    // ★도구가 돌려준 이미지는 모델만 보고 끝나면 안 된다 — 디스크에 정본을 남기고
    // 산출물 경로로 알려야 사용자의 결과 레일과 채팅에 실물로 뜬다.
    // (2026-09-03 실측: 저장하는 곳이 없어 스크린샷 요청이 산출물 0건으로 끝났다.)
    const capturePaths = images
      .map((image) => saveBrowserCaptureArtifact(image.mediaType, image.data))
      .filter((filePath): filePath is string => filePath !== null);
    (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(
      call.toolName,
      call.arguments,
      result.presentationResult ?? text,
      eventCallId,
      result.isError,
      capturePaths.length > 0 ? capturePaths : undefined,
    ));
    if (!result.isError) mcpFileProof?.complete();
    if (actionId) {
      if (approvalDecision === null) throw new Error("workforce_broker_approval_missing");
      broker?.finishAction(actionId, result.isError ? "failed" : "succeeded");
    }
    mcpOutcome = {
      content: text,
      ...(result.rawResult ? { rawMcpResult: result.rawResult } : {}),
      ...(capturePaths.length ? { artifactPaths: capturePaths } : {}),
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
      isError: result.isError,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (currentHistoryRuntimeFence()?.assertCurrent(), events.onTool?.(call.toolName, call.arguments, message, eventCallId, true));
    if (actionId) {
      if (approvalDecision === null) throw new Error("workforce_broker_approval_missing");
      broker?.finishAction(actionId, "failed");
    }
    mcpOutcome = {
      content: `Error: ${message}`,
      visionMessage: null,
      isError: true,
    };
  }
  // Outside the ordinary tool-error catch: rejection belongs to the host run
  // lifecycle, while the completed tool receipt above remains intact.
  await awaitMcpResultDelivery(approval, { catalogId: resolved.server.catalogId ?? null,
    toolName: resolved.serverToolName, isError: mcpOutcome.isError });
  if(work && "unit" in work) {
    approval.canonicalWorkRecovery!.finish(work,mcpOutcome);
    mcpOutcome.canonicalWorkAction={action_id:work.action.actionId,step_id:work.action.stepId};
  }
  return mcpOutcome;
}

/** OpenAI Chat Completions still needs the actual provider tool-call ID in its
 * `role: tool` message. It is a wire wrapper over the neutral Main dispatch. */
export async function runOneToolCall(
  byName: Map<string, ResolvedTool>,
  call: OpenAiToolCall,
  events: RunnerEvents,
  approval: LocalToolApprovalContext,
  broker?: MainWorkforceBroker,
  /** Set when the host synthesized `call.id` for a local server that sent none: the broker gets the measured location,
   * never a made-up provider correlation id (MainToolDispatchCall contract). The wire message still pairs by `call.id`. */
  synthesizedLocation?: WorkforceBrokerProviderCallLocation,
): Promise<{ toolMessage: Extract<ChatMessage, { role: "tool" }>; visionMessage: ChatMessage | null; isError: boolean }> {
  const outcome = await runMainToolDispatch(
    byName,
    synthesizedLocation
      ? { providerCallId: null, providerCallLocation: synthesizedLocation, toolName: call.function.name, arguments: call.function.arguments }
      : { providerCallId: call.id, toolName: call.function.name, arguments: call.function.arguments },
    events,
    approval,
    broker,
  );
  return {
    toolMessage: { role: "tool", tool_call_id: call.id, content: outcome.content },
    visionMessage: outcome.visionMessage,
    isError: outcome.isError,
  };
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
  terminalObserved: boolean;
  finishReason?: string;
  text: string;
  /** The reply as streamed, untrimmed: pieces of an answer cut by the output cap join without losing the space at the seam. */
  rawText?: string;
  toolCalls: OpenAiToolCall[];
  missingToolCallIds: boolean;
  incompleteToolCalls: boolean;
  terminalUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** The model's reasoning text for this turn (empty when the server sends none). */
  thinking: string;
  /** Tool-call ids the host synthesized for a local server that sent none (local compatible normalization only). */
  synthesizedCallIds?: ReadonlySet<string>;
  /** Machine codes of the local-server non-conformances normalized on this reply (never shown; diagnostics only). */
  compatNormalized?: readonly string[];
}

/**
 * Local OpenAI-compatible servers (LM Studio, mlx_lm.server, managed llama.cpp, Ollama's /v1 route) are looser than the
 * OpenAI platform wire, the same way Ollama's native route is (ollama-native.ts ollamaNdjsonToOpenAiSse): mlx_lm.server
 * documents finish_reason "stop" | "length" only, so a tool-calling reply ends "stop"; some servers omit tool-call ids or
 * the finish_reason chunk. The strict check below stays for cloud providers. Typed by runtime kind, never by prose.
 */
const LOCAL_COMPATIBLE_RUNTIMES = new Set(["ollama", "lmstudio", "mlx", "agentlas-local"]);
const STOP_EQUIVALENT_FINISH = new Set(["stop", "eos", "end_turn", "stop_sequence"]);

function rejectsStreamUsageOption(status: number, text: string): boolean {
  if (status !== 400 && status !== 422) return false;
  try {
    const value = JSON.parse(text) as { error?: { type?: unknown; code?: unknown; param?: unknown } };
    return value?.error?.type === "invalid_request_error"
      && value.error.code === "unsupported_parameter"
      && (value.error.param === "stream_options" || value.error.param === "stream_options.include_usage");
  } catch { return false; }
}

async function streamChatTurn(
  resp: Response,
  onPartial: (acc: string) => void,
  onThinking?: RunnerEvents["onThinking"],
  localCompatible?: { turn: number },
): Promise<StreamTurnResult> {
  let acc = "";
  let finishReason: string | undefined;
  let conflictingFinishReason = false;
  const rawFinishReasons = new Set<string>();
  let sawDone = false;
  let terminalUsage: StreamTurnResult["terminalUsage"];
  let terminalUsageChunks = 0;
  let lastChunkWasUsage = false;
  let lastEmit = 0;
  // OpenAI-호환 로컬 서버(ollama·LM Studio·MLX)는 생각을 delta.reasoning_content(또는
  // ollama의 delta.reasoning / delta.thinking)로 따로 준다. 자기 행으로 흘린다.
  let thinkingOpen = false;
  let thinkingStartedAt = 0;
  let thinkingText = "";
  const pending = new Map<number, { id?: string; name: string; args: string }>();
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { sawDone = true; break; }
    lastChunkWasUsage = false;
    try {
      const event = JSON.parse(payload) as {
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; [key: string]: unknown } | null;
        choices?: Array<{
          finish_reason?: string;
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
      if (event.usage && Array.isArray(event.choices) && event.choices.length === 0) {
        terminalUsageChunks += 1;
        const input = event.usage.prompt_tokens;
        const output = event.usage.completion_tokens;
        if (Number.isSafeInteger(input) && Number(input) >= 0
          && Number.isSafeInteger(output) && Number(output) >= 0
          && Number(input) + Number(output) <= Number.MAX_SAFE_INTEGER) {
          const cachedInputTokens = cachedTokensFromOpenAiUsage(event.usage);
          terminalUsage = { inputTokens: Number(input), outputTokens: Number(output),
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}) };
          lastChunkWasUsage = true;
        }
      }
      const nextFinishReason = event.choices?.[0]?.finish_reason;
      if (typeof nextFinishReason === "string") {
        rawFinishReasons.add(nextFinishReason);
        if (finishReason !== undefined && finishReason !== nextFinishReason) conflictingFinishReason = true;
        finishReason = nextFinishReason;
      }
      const delta = event.choices?.[0]?.delta;
      const thought = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
      if (typeof thought === "string" && thought) {
        thinkingText += thought;
        if (!thinkingOpen) {
          thinkingOpen = true;
          thinkingStartedAt = Date.now();
          (currentHistoryRuntimeFence()?.assertCurrent(), onThinking?.("start"));
        }
        (currentHistoryRuntimeFence()?.assertCurrent(), onThinking?.("delta", undefined, thought));
      }
      if (delta?.content) {
        if (thinkingOpen) {
          thinkingOpen = false;
          (onThinking?.("end", Date.now() - thinkingStartedAt));
        }
        acc += delta.content;
        const now = Date.now();
        if (now - lastEmit > 80) {
          (currentHistoryRuntimeFence()?.assertCurrent(), onPartial(acc));
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
  if (thinkingOpen) (onThinking?.("end", Date.now() - thinkingStartedAt));
  if (localCompatible) return normalizeLocalCompatibleTurn({ acc, thinkingText, pending: [...pending.values()], rawFinishReasons,
    sawDone, terminalUsage, terminalUsageChunks, lastChunkWasUsage, turn: localCompatible.turn });
  const pendingCalls = [...pending.values()];
  const toolCalls: OpenAiToolCall[] = pendingCalls
    .filter((entry) => entry.name)
    .map((entry, i) => ({
      id: entry.id ?? `call_${i}`,
      type: "function" as const,
      function: { name: entry.name, arguments: entry.args },
    }));
  return { text: acc.trim(), rawText: acc, toolCalls, finishReason, thinking: thinkingText,
    terminalObserved: sawDone && Boolean(finishReason) && !conflictingFinishReason,
    ...(sawDone && finishReason && terminalUsageChunks === 1 && lastChunkWasUsage && terminalUsage
      ? { terminalUsage } : {}),
    missingToolCallIds: pendingCalls.some((entry) => !entry.id),
    incompleteToolCalls: pendingCalls.some((entry) => {
      if (!entry.name) return true;
      try {
        const args: unknown = JSON.parse(entry.args || "{}");
        return !args || typeof args !== "object" || Array.isArray(args);
      } catch { return true; }
    }) || new Set(pendingCalls.map((entry) => entry.id)).size !== pendingCalls.length,
  };
}

/**
 * The same terminal facts as the strict path, after the local-server normalization: a missing or duplicate tool-call id gets
 * a host id (reported as synthesized, so the broker never sees it as a provider id); "function_call" and stop-equivalent
 * reasons with complete tool calls read as "tool_calls"; a missing finish_reason after [DONE] or a clean close reads from
 * what arrived. A reply with no terminal sentinel and no finish reason, or with a cut/invalid tool call, stays unsettled.
 */
export function normalizeLocalCompatibleTurn(input: {
  acc: string; thinkingText: string; pending: Array<{ id?: string; name: string; args: string }>;
  rawFinishReasons: ReadonlySet<string>; sawDone: boolean; terminalUsage?: StreamTurnResult["terminalUsage"];
  terminalUsageChunks: number; lastChunkWasUsage: boolean; turn: number;
}): StreamTurnResult {
  const codes: string[] = [];
  const argsValid = (args: string): boolean => {
    try { const value: unknown = JSON.parse(args || "{}"); return !!value && typeof value === "object" && !Array.isArray(value); } catch { return false; }
  };
  const seen = new Set<string>();
  const synthesizedCallIds = new Set<string>();
  const named = input.pending.filter((entry) => entry.name);
  const toolCalls: OpenAiToolCall[] = named.map((entry, index) => {
    let id = entry.id;
    if (!id || seen.has(id)) {
      codes.push(id ? "tool_call_id_duplicate" : "tool_call_id_missing");
      id = `agentlas_local_call_${input.turn}_${index}`;
      synthesizedCallIds.add(id);
    }
    seen.add(id);
    return { id, type: "function" as const, function: { name: entry.name, arguments: entry.args } };
  });
  const incompleteToolCalls = input.pending.some((entry) => !entry.name || !argsValid(entry.args));
  const normalizedReasons = new Set([...input.rawFinishReasons].map((reason) => {
    if (reason === "function_call") { codes.push("finish_reason_function_call"); return "tool_calls"; }
    if (reason === "length" || reason === "content_filter") return reason;
    if (toolCalls.length > 0 && !incompleteToolCalls && (reason === "tool_calls" || STOP_EQUIVALENT_FINISH.has(reason))) {
      if (reason !== "tool_calls") codes.push("finish_reason_stop_with_tool_calls");
      return "tool_calls";
    }
    if (STOP_EQUIVALENT_FINISH.has(reason)) { if (reason !== "stop") codes.push(`finish_reason_${reason}`); return "stop"; }
    return reason;
  }));
  let finishReason: string | undefined = normalizedReasons.size === 1 ? [...normalizedReasons][0] : undefined;
  const conflicting = normalizedReasons.size > 1;
  if (input.rawFinishReasons.size === 0 && input.sawDone && !incompleteToolCalls) {
    // [DONE] is the stream's terminal sentinel; the finish reason chunk alone was missing.
    codes.push("finish_reason_missing");
    finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  }
  // A local server is reached directly (no proxy): a clean close after a finish reason is the end of the reply.
  const closedAfterReason = !input.sawDone && input.rawFinishReasons.size > 0;
  if (closedAfterReason) codes.push("done_sentinel_missing");
  const terminalObserved = (input.sawDone || closedAfterReason) && Boolean(finishReason) && !conflicting;
  return {
    text: input.acc.trim(), rawText: input.acc, toolCalls, finishReason, thinking: input.thinkingText,
    terminalObserved,
    ...(terminalObserved && input.terminalUsageChunks === 1 && input.lastChunkWasUsage && input.terminalUsage
      ? { terminalUsage: input.terminalUsage } : {}),
    missingToolCallIds: false,
    incompleteToolCalls,
    ...(synthesizedCallIds.size ? { synthesizedCallIds } : {}),
    ...(codes.length ? { compatNormalized: [...new Set(codes)] } : {}),
  };
}

export interface RunLocalOpenAiChatOptions {





  acceptsImageResults?: boolean;
  /** Sampling temperature for the chat request. Small local tool agents need a low value (server default is 0.8). */
  temperature?: number;
  req: RunnerRequest;
  events: RunnerEvents;
  runtimeKind: string;
  /** Exact adapter identity for Main-owned BYOK recovery; never a display label. */
  recoveryBackend?: string;
  /** 예: "http://localhost:1234" — chatEndpoint는 항상 "/v1/chat/completions" */
  host: string;
  model: string;
  /** 연결 실패 시 메시지(로케일 이미 반영된 문자열) */
  unreachableMessage: string;
  /** Provider-owned authentication and compatibility headers for the same Chat Completions wire loop. */
  headers?: Record<string, string>;
  /** Exact provider Chat Completions endpoint when it is not `${host}/v1/chat/completions`. */
  chatEndpoint?: string;
  /** Provider display name for truthful HTTP error attribution. */
  providerLabel?: string;
  /** Ollama accepts this on its native API; OpenAI-compatible servers may ignore it. */
  keepAlive?: string;
  /** Owner-chosen DeepSeek Responses wire (byok-wire.ts): same loop, the request/stream converted by deepseek-responses.ts. */
  responsesWire?: "deepseek";
  /** Ollama only: serve each request from the native /api/chat with a context window sized to the prompt
   * (ollama-native.ts). The OpenAI-compatible route cannot request a window. */
  ollamaContext?: true;
  /** Publisher/model-specific chat-template controls applied by a managed adapter. */
  chatTemplateKwargs?: Record<string, boolean | number | string>;
  /** Main resident receipt, present only for managed llama.cpp. */
  contextWindow?: number;
  /** Non-tokenizer API estimate from the selected model catalog (or a labelled
   * conservative fallback). Exact managed-local measurement uses contextWindow. */
  estimatedContextWindow?: number;
  estimatedOutputReserve?: number;
  /**
   * G32: re-read the window the server really has loaded right now (LM Studio loaded-instance config). Called at most once
   * per run, after a context failure, never for managed llama.cpp (exact n_ctx). undefined = the server reports none.
   */
  remeasureContextWindow?: () => Promise<number | undefined>;
  capacitySource?: "built-in" | "catalog" | "unknown";
  /**
   * BYOK cloud providers only: the estimated window is a default, not evidence, and the
   * provider refuses an oversized request explicitly. Compact history but never
   * pre-refuse. (Local servers may silently truncate, so they keep the pre-check.)
   */
  unknownCapacityProviderEnforced?: true;
  /** Managed local only: exact-tokenizer overflow may excerpt historical turns
   * and retry. The current request, instructions, tools and results stay intact. */
  dynamicHistoryCompaction?: true;
  /**
   * Same system prompt without the optional keyword-gated Surface protocol. Used once,
   * only when the measured request does not fit; the swap is reported as a notice.
   */
  systemPromptFallback?: string;
  /** Trusted caller re-renders declared contracts before the final boundary, preserving history offsets. */
  renderOutputSchemaSystem?: () => { system: string; fallback?: string };
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
  // The size of the turn's LAST model request is what the generation rule (session-generation.ts) reads.
  const contextInput: { value?: number } = {};
  const result = await runLocalOpenAiChatInner({ ...opts, contextInputSink: contextInput }, messages);
  return contextInput.value && result.contextInputTokens === undefined ? { ...result, contextInputTokens: contextInput.value } : result;
}

async function runLocalOpenAiChatInner(
  opts: RunLocalOpenAiChatOptions & { contextInputSink?: { value?: number } },
  messages: ChatMessage[],
): Promise<RunnerResult> {
  const { req, events, runtimeKind, host, model } = opts;
  const nativeOutputSchema = req.outputSchema ? openAiStrictSchemaOrNull(req.outputSchema.schema) : null;
  if (req.outputSchema && !nativeOutputSchema) {
    const first = messages[0];
    if (first?.role !== "system" || typeof first.content !== "string") throw new Error("output_schema_system_message_required");
    if (!opts.renderOutputSchemaSystem) throw new Error("output_schema_declared_system_required");
    const declared = opts.renderOutputSchemaSystem();
    messages[0] = { ...first, content: declared.system };
    if (opts.systemPromptFallback) {
      if (!declared.fallback) throw new Error("output_schema_declared_fallback_required");
      opts = { ...opts, systemPromptFallback: declared.fallback };
    }
    events.onStatus(tStatus(req.locale, "schemaInPromptOnly"));
  }
  const recovery = assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
  const chatEndpoint = opts.chatEndpoint ?? `${host}/v1/chat/completions`;
  const providerLabel = opts.providerLabel ?? host;
  // Typed dialect of this endpoint (openai-wire-family.ts): OpenAI's platform takes max_completion_tokens and
  // reasoning_effort; every compatible server keeps max_tokens and gets no effort field.
  const wireFamily = opts.responsesWire ? "openai-compatible" as const
    : openAiChatWireFamily({ runtimeKind, backend: opts.recoveryBackend, endpoint: chatEndpoint });
  const outputField = outputLimitField(wireFamily);
  const effortPlan = openAiReasoningEffort(wireFamily, req.effort);
  /** Set after OpenAI's structured refusal of reasoning_effort for this model; the rest of the run sends none. */
  let effortRejected = false;
  const effortApplication = (): ModelEffortApplication => "send" in effortPlan && !effortRejected
    ? { status: "applied", applied: effortPlan.send, requested: req.effort ?? null, wire: "reasoning_effort" }
    : req.effort ? { status: "unsupported", requested: req.effort,
      reason: effortRejected ? "provider_rejected_reasoning_effort" : "skip" in effortPlan ? effortPlan.skip : "not_requested" }
      : { status: "not_requested" };
  const localCompatibleTerminal = LOCAL_COMPATIBLE_RUNTIMES.has(runtimeKind);
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
  if (!recovery && req.chatId && sessionFingerprint) {
    // OpenAI-compatible local servers have no provider conversation ID. The
    // durable Agentlas chat history is the source of truth, while this
    // logical session record makes continuity visible and detects model/host
    // changes without pretending the server supports native resume.
    saveRuntimeSession(req.chatId, runtimeKind, req.chatId, sessionFingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
  }
  // `untrustedNoTools` is a Main-authored hard boundary. Do not even inspect
  // the image slot, parse MCP config, probe servers, or construct builtin
  // descriptors: those are all tool-surface admission work. An empty request
  // payload alone is insufficient because it still leaves host-side tool
  // discovery and a later tool-call dispatch path alive.
  const prepared = await prepareMainToolLoop(req, runtimeKind);
  const { byName, broker, approval: approvalContext } = prepared;
  let tools = prepared.tools;
  if (opts.acceptsImageResults === false) {
    // 화면을 볼 수 없는 모델에게 컴퓨터 유즈를 주면 스크린샷 JSON 을 해석 못 해 같은 호출만 반복한다

    // 브라우저 스크린샷도 같은 이유로 뺀다 — 3회 반복 실측(2026-09-13)에서 비전 없는 모델이
    // browser_take_screenshot 을 8번 부르고 screen_capture_unavailable 로 실패했다.
    const isBlindTool = (name: string) => name === "read_image" || name.startsWith("mcp__cua-driver__") || /^mcp__agentlas-browser__browser_(?:take_)?screenshot$/.test(name);
    const blind = tools.filter((tool) => isBlindTool(tool.function.name));
    if (blind.length > 0) {
      tools = tools.filter((tool) => !isBlindTool(tool.function.name));
      for (const tool of blind) byName.delete(tool.function.name);
      events.onNotice?.({
        level: "info",
        code: "computer-use-needs-vision-model",
        message: req.locale === "ko" ? "이 로컬 모델은 이미지를 볼 수 없어 이미지 읽기·컴퓨터 유즈 도구를 이번 실행에서 뺐습니다." : "This local model cannot see images, so image-reading and Computer Use tools were left out of this run.",
        i18n: {
          ko: "이 로컬 모델은 이미지를 볼 수 없어 이미지 읽기·컴퓨터 유즈 도구를 이번 실행에서 뺐습니다.",
          en: "This local model cannot see images, so image-reading and Computer Use tools were left out of this run.",
        },
      });
    }
  }
  if (tools.length > 0) {
    events.onStatus(tStatus(req.locale, "mcpToolsAttached", { count: tools.length }));
    if (req.cwd) {
      // 파일 도구의 허용 루트를 실행 폴더로 좁혔음을 모델에게도 알려, 처음부터 이
      // 실제 파일 도구 계약에 맞춰 작업 폴더 상대경로를 안내한다.
      messages.splice(1, 0, {
        role: "system",
        content: `file tools root: ${req.cwd}; relative paths only (others rejected).`,
      });
    }
  }
  const historicalEntries = req.history.filter((entry) => entry.role === "user" || entry.role === "assistant");
  const historyStartIndex = 1 + (tools.length > 0 && req.cwd ? 1 : 0);
  // Only splice the slice we can prove came from req.history. A future
  // adapter may insert another protected message here; fail closed instead
  // of treating that message (or the current turn) as disposable history.
  const canCompactInitialHistory = historicalEntries.every((entry, index) => {
    const row = messages[historyStartIndex + index];
    return row?.role === entry.role && row.content === entry.text;
  });
  let transmittedHistoryCount = historicalEntries.length;
  let historyBudgetTokens = historicalEntries.reduce((sum, entry) => sum + estimateTransportTokens(entry.text) + 12, 0);
  let historyCompactionReported = false;
  const applyHistoricalBudget = (budget: number): number | null => {
    if (!canCompactInitialHistory) return null;
    const compacted = compactHistoryToBudget(historicalEntries, { historyBudgetTokens: budget, locale: req.locale });
    if (!compacted.fits || !compacted.digest) return null;
    messages.splice(historyStartIndex, transmittedHistoryCount,
      { role: "user", content: compacted.digest },
      ...compacted.recent.map((entry) => ({ role: entry.role, content: entry.text } as ChatMessage)));
    transmittedHistoryCount = compacted.recent.length + 1;
    return compacted.droppedCount;
  };
  // Host-side history trimming is background work: nothing about it is shown to the user (owner 2026-10-13).
  const reportHistoryCompaction = (_droppedCount: number): void => { historyCompactionReported = true; };
  // The conversation's "session" for a runtime with no provider session (stateless-generation.ts, native-harness NH10):
  // the handoff it installed, a new one at a settled boundary when a request's input reaches 80% of the window that admits
  // it, acknowledged by the next complete response. Only the slice proven to come from req.history is ever replaced.
  const generations = canCompactInitialHistory ? openStatelessGeneration({ runtime: runtimeKind, chatId: req.chatId,
    ownerId: runtimeSessionOwnerId ?? null, model, history: historicalEntries, locale: req.locale, agentId: req.agentId ?? null }) : null;
  const installGeneration = (digest: string, rows: RunnerRequest["history"]): void => {
    messages.splice(historyStartIndex, transmittedHistoryCount,
      { role: "user", content: digest },
      ...rows.filter((entry) => entry.role === "user" || entry.role === "assistant").map((entry) => {
        const images = entry.role === "user" ? ownerControlHistoryImages(entry) : [];
        return { role: entry.role, content: images.length ? [
          ...images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
          { type: "text" as const, text: entry.text },
        ] : entry.text } as ChatMessage;
      }));
    transmittedHistoryCount = rows.length + 1;
    historyBudgetTokens = statelessHistoryTokens(digest, rows);
  };
  if (generations?.seed) installGeneration(generations.seed.digest, generations.seed.rows);
  /** The window the rotation rule reads: measured/loaded/requested or a catalog number; a labelled default never moves it.
   * Ollama: the num_ctx this very request is sent with (the window that admits it), not the ceiling it may grow to. */
  const generationWindow = (window: number | undefined, ollamaPlan: { numCtx: number } | null): StatelessWindow | null => {
    if (opts.contextWindow !== undefined) return { tokens: opts.contextWindow, source: "measured", known: true };
    if (ollamaPlan) return { tokens: ollamaPlan.numCtx, source: "requested", known: true };
    if (window === undefined) return null;
    if (remeasuredWindow !== undefined) return { tokens: window, source: "loaded", known: true };
    const known = !opts.unknownCapacityProviderEnforced && opts.capacitySource !== "unknown";
    return { tokens: window, source: opts.capacitySource ?? "loaded", known };
  };
  let generationStep = 0, lastRequestTokens: number | null = null, lastObservedInput: number | null = null;
  // The window the last request was actually admitted into (measured, loaded, or the num_ctx sent) — reported on the
  // result so the context detail shows the real local window instead of a catalog figure (native-harness notyet NH18).
  let admittedWindow: number | null = null;
  let stepExactInput: number | null = null, sentRequestTokens: number | null = null;
  let finalText = "";
  let sawAnyToolCall = false;
  let summaryTurnRequested = false;
  let sawUnsupportedToolCallAttempt = false;
  /** 루프가 답에 도달해서 끝났는가. false로 빠져나오면 도구 왕복만 하다 멈춘 것. */
  let reachedAnswer = false;
  /** 실제로 돈 도구 왕복 횟수 — 실패 문구에는 상한이 아니라 이 사실이 실린다. */
  let toolTurnsTaken = 0;
  /** Tool calls the host ran in this turn: settleNormalEnd evidence (R-065). */
  let toolCallsRun = 0;
  const progress = createToolLoopProgress(runtimeKind, req, events);
  const usage = createToolLoopUsage(events);
  /** The optional Surface fallback is a one-time swap, never a per-turn oscillation. */
  let surfaceFallbackApplied = false;
  let streamUsageUnsupported = false;
  let ollamaWindowReported = 0;
  // G32: a context failure earns exactly one re-measure; a window that did not shrink (or is unknown) fails typed at once.
  let contextRemeasures = 0;
  let remeasuredWindow: number | undefined;
  /** Raised when a reply is cut by the output cap before it produced a tool call or any text. */
  let outputTokenFloor: number | undefined;
  let outputGrowths = 0;
  /**
   * Replies cut by the output cap and continued on the same conversation (never a failed turn): consecutive cuts so far,
   * and the text of a cut answer so far, joined with the pieces that follow it.
   */
  let outputCuts = 0;
  let continuedText = "";
  let toolParseRetries = 0;
  /** G24: resends spent on a server that answered 5xx before anything streamed or ran in this invocation. */
  let serverResends = 0;
  /** Reasoning behind each tool call, replayed to Ollama's native route (gpt-oss loses its plan between calls without it). */
  const thinkingByCallId = new Map<string, string>();
  /** Screenshot messages this loop appended after tool results (structural identity, never their wording). */
  const toolVisionMessages = new WeakSet<ChatMessage>();
  /**
   * In-turn compaction (A4 C3.3), at a settled tool-step boundary only. The 80% rotation folds history; this folds the
   * current turn's EARLIER tool output so a long tool loop does not refuse mid-run: old screenshots first (serving already
   * sends each tool image once), then old tool results become durable read_tool_result references
   * (foldRetainedToolResult). The latest tool group, every assistant tool_calls message and every tool message stay in
   * place, so pairs remain protocol-valid; nothing is folded without a byte-exact read path.
   */
  let inTurnFolds = 0;
  const foldEarlierToolOutput = (fits: () => boolean): number => {
    if (fits()) return 0;
    let lastGroup = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const row = messages[index];
      if (row.role === "assistant" && row.tool_calls?.length) { lastGroup = index; break; }
    }
    if (lastGroup <= 0) return 0;
    let folded = 0;
    for (let index = 0; index < lastGroup && !fits(); index += 1) {
      const row = messages[index];
      if (row.role === "user" && toolVisionMessages.has(row)) {
        // Machine-keyed data, no prose (the folded projection is tool-result data, not a prompt module).
        const replacement: ChatMessage = { role: "user", content: JSON.stringify({ schema: "agentlas.tool-image-folded.v1", newestImageKept: true }) };
        toolVisionMessages.delete(row);
        messages[index] = replacement;
        folded += 1;
      }
    }
    for (let index = 0; index < lastGroup && !fits(); index += 1) {
      const row = messages[index];
      if (row.role !== "tool") continue;
      const reference = foldRetainedToolResult(byName, approvalContext, row.content);
      if (reference) { messages[index] = { ...row, content: reference }; folded += 1; }
    }
    inTurnFolds += folded;
    if (folded && process.env.AGENTLAS_LOCAL_TOOL_DEBUG === "1") console.log("[local-tool-loop] in-turn folds:", folded, "total:", inTurnFolds);
    return folded;
  };
  let ownerControlPending: string[] | null = null;
  let ownerControlDispatched = false;
  let ownerControlTerminal: "completed" | "uncertain" = "uncertain";
  const ownerControlSeen = new Set<string>();
  const observeOwnerControlResponse = (result: StreamTurnResult): void => {
    const validTerminal = result.terminalObserved && !result.missingToolCallIds && !result.incompleteToolCalls
      && ((result.finishReason === "stop" && result.toolCalls.length === 0)
        || (result.finishReason === "tool_calls" && result.toolCalls.length > 0));
    if (!validTerminal) {
      ownerControlTerminal = "uncertain";
      // Unknown reasons and truncated responses cannot authorize tools or a
      // new brain request, even when this invocation has no live mailbox.
      throw new RuntimeTurnUnsettledError(runtimeKind, req.locale);
    }
    if (req.signal?.aborted) throw abortReasonError(req);
    ownerControlTerminal = "completed";
    const observedInput = result.terminalUsage && result.terminalUsage.inputTokens > 0 ? result.terminalUsage.inputTokens : stepExactInput;
    generations?.completed(generationStep, observedInput);
    lastObservedInput = observedInput;
    lastRequestTokens = sentRequestTokens;
    if (ownerControlPending) {
      req.ownerControlInbox!.settle(ownerControlPending, "applied");
      ownerControlPending = null;
      ownerControlDispatched = false;
    }
  };
  const terminalFailure = (result: StreamTurnResult): RunnerResult | null => {
    if (result.finishReason === "length" && opts.contextWindow !== undefined) {
      return assertCurrentHistoryRunnerResult({ text: "", ownerControlTerminal: "uncertain",
        failure: localContextFailure("local_output_limit_exceeded", runtimeKind, req.locale) });
    }
    if (result.terminalObserved && result.finishReason === "content_filter") {
      return assertCurrentHistoryRunnerResult({ text: result.text, ownerControlTerminal: "uncertain",
        failure: { kind: "refused", runtime: runtimeKind, source: "marker", providerCode: "content_filter",
          message: req.locale === "ko" ? "모델이 콘텐츠 필터로 응답을 중단했습니다." : "The model stopped the response due to its content filter." },
        workforcePermissionEnforcement: broker?.finish(false) });
    }
    return null;
  };
  const httpFailureResult = (status: number): RunnerResult | null => {
    const failure = runtimeHttpFailure(status, runtimeKind, providerLabel);
    if (!failure) return null;
    const observedUsage = usage.total();
    return assertCurrentHistoryRunnerResult({ text: finalText.trim(), failure, ...(observedUsage ? { observedUsage } : {}),
      workforcePermissionEnforcement: broker?.finish(false) });
  };
  /**
   * G24: a 5xx is a typed failure (provider-overload.ts). Overloaded, or a local server that no longer has the model loaded,
   * earns one resend after a short wait, but only while nothing streamed and no tool ran in this invocation.
   */
  const serverFailureOutcome = async (response: Response, body: string, allowResend: boolean): Promise<"resend" | RunnerResult | null> => {
    const plain = serverFailureCodeForStatus(response.status);
    if (!plain) return null;
    const resident = plain === RUNTIME_SERVER_ERROR_CODE ? await localModelResident({ runtimeKind, host, model, signal: req.signal }) : null;
    const code = refineServerFailureCode(plain, resident);
    const retryAfter = response.headers.get("retry-after");
    if (allowResend && serverFailureResendable(code) && serverResends < SERVER_FAILURE_RESENDS && !sawAnyToolCall
      && !finalText.trim() && !continuedText && !ownerControlPending && !req.signal?.aborted) {
      serverResends += 1;
      events.onStatus(code === LOCAL_MODEL_UNLOADED_CODE
        ? req.locale === "ko" ? "모델 서버가 오류 뒤 모델을 내렸습니다. 잠시 뒤 같은 요청을 한 번 더 보냅니다…" : "The model server dropped the model after an error; sending the same request once more shortly…"
        : req.locale === "ko" ? "모델 서버가 바빠 잠시 뒤 같은 요청을 한 번 더 보냅니다…" : "The model server is busy; sending the same request once more shortly…");
      await waitForServerResend(serverFailureResendDelayMs(retryAfter), req.signal);
      if (req.signal?.aborted) throw abortReasonError(req);
      return "resend";
    }
    const observedUsage = usage.total();
    return assertCurrentHistoryRunnerResult({ text: finalText.trim(),
      failure: serverFailure({ code, status: response.status, runtime: runtimeKind, providerLabel, locale: req.locale, body, retryAfter }),
      ...(observedUsage ? { observedUsage } : {}), workforcePermissionEnforcement: broker?.finish(false) });
  };

  try {
  for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn += 1) {
    if (req.signal?.aborted) throw abortReasonError(req);
    if (turn > 0 && req.ownerControlInbox) {
      const batch = req.ownerControlInbox.take("current-boundary").filter((entry) => {
        if (ownerControlSeen.has(entry.intentId)) return false;
        ownerControlSeen.add(entry.intentId);
        return true;
      });
      if (batch.length) {
        ownerControlPending = batch.map((entry) => entry.intentId);
        // Previous assistant/tool responses and screenshots are already
        // complete. Owner text stays user input, after that whole group.
        for (const entry of batch) messages.push({ role: "user", content: entry.text });
      }
    }
    // After a re-measure shrank the window, the output reserve follows it (an explicit req.maxOutputTokens never shrinks).
    const turnReserve = remeasuredWindow !== undefined && opts.estimatedContextWindow !== undefined && req.maxOutputTokens === undefined
      ? Math.min(opts.estimatedOutputReserve ?? 8_192, Math.max(1, Math.floor(Math.min(remeasuredWindow, opts.estimatedContextWindow) / 4)))
      : opts.estimatedOutputReserve;
    // One planner decides the provider cache fields (OpenAI prompt_cache_key / OpenRouter session_id only on endpoints
    // whose capability supports them; compatible and local servers get nothing extra).
    const cachePlan = openAiStyleCachePlan({ runtimeKind, host, chatId: req.chatId, ownerId: runtimeSessionOwnerId, model, tools, messages });
    const requestBody: Record<string, unknown> = {
            model,
            stream: true,
            ...(!streamUsageUnsupported && (runtimeKind === "byok" || runtimeKind === "lmstudio")
              ? { stream_options: { include_usage: true } } : {}),
            messages,
            ...planRequestFields(cachePlan),
            ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}),
            ...(opts.chatTemplateKwargs ? { chat_template_kwargs: opts.chatTemplateKwargs } : {}),
            // A malformed tool call repeated identically 3 of 3 times (measured); a fresh seed makes the retry a new sample.
            ...(toolParseRetries > 0 ? { seed: Math.floor(Math.random() * 2_147_483_647) } : {}),
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.estimatedContextWindow !== undefined
              ? { [outputField]: Math.max(outputTokenFloor ?? 0, turnReserve ?? Math.min(8_192, Math.floor(opts.estimatedContextWindow / 4))) }
              : {}),
            ...("send" in effortPlan && !effortRejected ? { reasoning_effort: effortPlan.send } : {}),
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
            ...(req.outputSchema && nativeOutputSchema
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: req.outputSchema.name,
                      schema: nativeOutputSchema,
                      strict: true,
                    },
                  },
                }
              : {}),
        };
    // Ollama: size the window to this request and ask for it on the native route; otherwise the
    // catalog estimate stands. The window is reported, never silently left at the server default.
    let turnFetch: typeof fetch = fetch;
    let turnWindow = remeasuredWindow !== undefined
      ? Math.min(remeasuredWindow, opts.estimatedContextWindow ?? remeasuredWindow) : opts.estimatedContextWindow;
    let turnCeiling = turnWindow;
    let ollamaPlan: { numCtx: number } | null = null;
    if (opts.ollamaContext && !req.untrustedNoTools) {
      // The first request of a run reads the server fresh: a model swapped since the last run must not reuse a cached window.
      const limits = await probeOllamaContextLimits(host, model, req.signal, undefined, { fresh: turn === 0 && contextRemeasures === 0 });
      const reserve = requestOutputLimit(requestBody) ?? 4_096;
      const plan = planOllamaContext({ host, model, promptTokens: estimateRequestPromptTokens(requestBody), outputReserve: reserve, limits });
      turnWindow = plan.numCtx;
      turnCeiling = plan.ceiling;
      ollamaPlan = plan;
      turnFetch = ollamaNativeFetch(host, plan.numCtx, { thinkingByCallId });
      if (ollamaWindowReported !== plan.numCtx) {
        ollamaWindowReported = plan.numCtx;
        events.onNotice?.({ level: "info", code: "ollama-context-window",
          message: `Requested a ${plan.numCtx}-token context window from Ollama (model maximum ${plan.modelMax ?? "unknown"}, loaded ${plan.loaded ?? "none"}, prompt about ${plan.needTokens - reserve} tokens).` });
      }
    }
    // Rotation at this settled boundary (turn start, or after a tool step whose results are all in): the request's INPUT
    // against 80% of the window that admits it. Input + output reserve is admission, below, and never records a generation.
    generationStep = turn; stepExactInput = null;
    const rotationWindow = generations ? generationWindow(turnWindow, ollamaPlan) : null;
    const observedWindow = rotationWindow ?? generationWindow(turnWindow, ollamaPlan);
    if (observedWindow?.known && ["measured", "loaded", "requested"].includes(observedWindow.source)) admittedWindow = observedWindow.tokens;
    if (generations && rotationWindow) {
      const rotation = await generations.boundary({ boundary: turn === 0 ? "turn-start" : "tool-step", step: turn, window: rotationWindow,
        requestTokens: estimateTransportTokens(JSON.stringify(requestBody)), historyTokens: historyBudgetTokens,
        observedLastInput: lastObservedInput, lastRequestTokens });
      if (rotation.action === "rotated") installGeneration(rotation.digest, rotation.rows);
    }
    if (opts.responsesWire === "deepseek") {
      const { deepseekResponsesFetch } = await import("./deepseek-responses");
      turnFetch = deepseekResponsesFetch(host, { thinkingByCallId });
    }
    if (turnWindow !== undefined) {
      const window = turnWindow;
      const reserve = turnReserve ?? Math.min(8_192, Math.floor(window / 4));
      let inputEstimate = estimateTransportTokens(JSON.stringify(requestBody));
      for (let attempt = 0; attempt < 8 && inputEstimate + reserve > window
        && historicalEntries.length > 0; attempt += 1) {
        historyBudgetTokens = Math.max(0, historyBudgetTokens - (inputEstimate + reserve - window) - Math.ceil(window * 0.02));
        const droppedCount = applyHistoricalBudget(historyBudgetTokens);
        if (droppedCount === null) break;
        inputEstimate = estimateTransportTokens(JSON.stringify(requestBody));
        if (inputEstimate + reserve <= window) reportHistoryCompaction(droppedCount);
      }
      // The same 80% point as rotation, on the window that admits this request (Ollama: the ceiling num_ctx may grow to),
      // and never past admission. A labelled default never moves the 80% point; admission still applies to it.
      const foldWindow = ollamaPlan && turnCeiling !== undefined ? turnCeiling : window;
      const foldKnown = observedWindow?.known === true;
      const foldTarget = Math.min(foldKnown ? Math.floor(foldWindow * GENERATION_CONTEXT_RATIO) : Number.POSITIVE_INFINITY, foldWindow - reserve);
      if (turn > 0 && inputEstimate > foldTarget && (foldKnown || !opts.unknownCapacityProviderEnforced)) {
        foldEarlierToolOutput(() => estimateTransportTokens(JSON.stringify(requestBody)) <= foldTarget);
        inputEstimate = estimateTransportTokens(JSON.stringify(requestBody));
      }
      if (inputEstimate + reserve > window && !opts.unknownCapacityProviderEnforced) {
        return assertCurrentHistoryRunnerResult({ text: "", ...(turn === 0 ? { turnDelivery: "not-dispatched" as const } : {}),
          failure: { kind: "refused", runtime: runtimeKind, source: "marker",
          providerCode: "model_context_capacity_exceeded",
          message: req.locale === "ko"
            ? "현재 모델의 추정 문맥 용량을 넘었습니다. 요청·지시·도구 내용은 잘라내지 않았습니다."
            : "The request exceeds this model's estimated context capacity. Current request, instructions, and tools were not clipped." } });
      }
    }
    if (opts.contextWindow !== undefined) {
      try {
        let measured = await measureLocalContext({host,headers:opts.headers,signal:req.signal,contextWindow:opts.contextWindow,body:requestBody});
        if (!measured.fits && opts.systemPromptFallback && !surfaceFallbackApplied
          && messages[0]?.role === "system" && messages[0].content !== opts.systemPromptFallback) {
          // Drop only the optional host Surface documentation, then measure again with
          // the same template and tokenizer. Nothing the user or agent wrote changes.
          messages[0] = { role: "system", content: opts.systemPromptFallback };
          surfaceFallbackApplied = true;
          measured = await measureLocalContext({host,headers:opts.headers,signal:req.signal,contextWindow:opts.contextWindow,body:requestBody});
          if (measured.fits) {
            events.onNotice?.({
              level: "info",
              code: "surface-protocol-dropped-for-capacity",
              message: req.locale === "ko"
                ? "이 모델의 용량에 맞추기 위해 화면 제작 안내(Surface)를 이번 턴에서 뺐습니다. 요청·대화·지시는 그대로입니다."
                : "The Surface builder guide was left out of this turn to fit the model context. Your request, history and instructions are unchanged.",
              i18n: {
                ko: "이 모델의 용량에 맞추기 위해 화면 제작 안내(Surface)를 이번 턴에서 뺐습니다. 요청·대화·지시는 그대로입니다.",
                en: "The Surface builder guide was left out of this turn to fit the model context. Your request, history and instructions are unchanged.",
              },
            });
          }
        }
        // The actual template includes this turn's tool schemas, response schema,
        // prior tool-call/result pairs and protected prompt. Shrink only the
        // original historical slice, then measure the entire body again.
        for (let attempt = 0; attempt < 16 && opts.dynamicHistoryCompaction
          && historicalEntries.length > 0
          && ( !measured.fits || (req.maxOutputTokens ?? 0) > measured.maxOutputTokens ); attempt += 1) {
          const requiredOutput = Math.max(measured.reserveTokens, req.maxOutputTokens ?? 0);
          const overage = Math.max(1, requiredOutput - measured.maxOutputTokens);
          // A token may span several UTF-8 bytes. Shrink the byte envelope
          // aggressively, then let the exact tokenizer decide; never loop
          // indefinitely on a small positive token overage.
          historyBudgetTokens = Math.max(0, historyBudgetTokens - overage * 8 - Math.ceil(opts.contextWindow * 0.02));
          const droppedCount = applyHistoricalBudget(historyBudgetTokens);
          if (droppedCount === null) break;
          measured = await measureLocalContext({host,headers:opts.headers,signal:req.signal,contextWindow:opts.contextWindow,body:requestBody});
          if (!historyCompactionReported && measured.fits && (req.maxOutputTokens ?? 0) <= measured.maxOutputTokens) {
            reportHistoryCompaction(droppedCount);
          }
        }
        // Exact tokenizer, same in-turn compaction: fold earlier tool output of this turn and measure the body again.
        for (let attempt = 0; attempt < 4 && turn > 0 && (!measured.fits || (req.maxOutputTokens ?? 0) > measured.maxOutputTokens); attempt += 1) {
          const shrinkTo = estimateTransportTokens(JSON.stringify(requestBody)) - Math.max(1, measured.reserveTokens - measured.maxOutputTokens) * 8
            - Math.ceil(opts.contextWindow * 0.02);
          if (!foldEarlierToolOutput(() => estimateTransportTokens(JSON.stringify(requestBody)) <= shrinkTo)) break;
          measured = await measureLocalContext({host,headers:opts.headers,signal:req.signal,contextWindow:opts.contextWindow,body:requestBody});
        }
        if (!measured.fits) return assertCurrentHistoryRunnerResult({text:"",...(turn === 0 ? { turnDelivery: "not-dispatched" as const } : {}),
          failure:localContextFailure("local_context_limit_exceeded",runtimeKind,req.locale)});
        const admittedOutputTokens = boundedLocalOutputTokens(measured.maxOutputTokens, req.maxOutputTokens);
        if (req.maxOutputTokens && admittedOutputTokens < req.maxOutputTokens) {
          return assertCurrentHistoryRunnerResult({text:"",failure:localContextFailure("local_context_limit_exceeded",runtimeKind,req.locale)});
        }
        requestBody[outputField] = admittedOutputTokens;
        if (opts.contextInputSink) opts.contextInputSink.value = measured.inputTokens;
        stepExactInput = measured.inputTokens > 0 ? measured.inputTokens : null;
      } catch {
        if (req.signal?.aborted) throw abortReasonError(req);
        return assertCurrentHistoryRunnerResult({text:"",failure:localContextFailure("local_context_measurement_unavailable",runtimeKind,req.locale)});
      }
    }
    assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
    let resp: Response;
    reportModelPayload(() => ledgerFromApiBody(requestBody, { ledgerHints: req.ledgerHints, imageCount: req.images?.length ?? 0 }));
    reportModelEffort(effortApplication());
    sentRequestTokens = estimateTransportTokens(JSON.stringify(requestBody));
    reportCachePlan(cachePlan);
    let usageAttempt = usage.start();
    try {
      if (req.signal?.aborted) throw abortReasonError(req);
      ownerControlDispatched = ownerControlPending !== null;
      resp = await withCurrentHistoryProvider(()=>turnFetch(chatEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        signal: req.signal,
          body: JSON.stringify(requestBody),
      }));
    } catch (err) {
      // The first request of the turn never reached the server (connection refused, no such host): nothing was sent, so this
      // is a typed pre-dispatch refusal, not an unsettled turn. A later request follows dispatched tool work and stays a throw.
      if (!req.signal?.aborted && turn === 0 && !sawAnyToolCall && fetchNeverConnected(err)) {
        return refusedBeforeDispatch({ kind: "unavailable", runtime: runtimeKind, source: "marker",
          providerCode: "endpoint_unreachable", message: opts.unreachableMessage.slice(0, 400) });
      }
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
      const terminal = httpFailureResult(resp.status);
      if (terminal) return terminal;
      let errText = await resp.text().catch(() => "");
      // A structured validation refusal of one OPTIONAL field precedes generation: resend the identical request once
      // without it. stream_options: the retry cannot promise a terminal usage pair, so the whole invocation's observed
      // usage stays unknown. reasoning_effort (OpenAI's platform, openai-wire-family.ts): the model takes no effort, so
      // the ledger records "unsupported" with the provider's refusal as the reason, never the requested value as applied.
      for (let optionalRetry = 0; optionalRetry < 2 && !resp.ok && !ownerControlPending && !req.signal?.aborted; optionalRetry += 1) {
        const rejected = Object.hasOwn(requestBody, "stream_options") && rejectsStreamUsageOption(resp.status, errText) ? "stream_options"
          : Object.hasOwn(requestBody, "reasoning_effort") ? rejectsOptionalParameter(resp.status, errText, ["reasoning_effort"]) : null;
        if (!rejected) break;
        if (rejected === "stream_options") streamUsageUnsupported = true;
        else effortRejected = true;
        delete requestBody[rejected];
        assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
        reportModelPayload(() => ledgerFromApiBody(requestBody, { ledgerHints: req.ledgerHints, imageCount: req.images?.length ?? 0 }));
        reportModelEffort(effortApplication());
        usageAttempt = usage.start();
        try {
          resp = await withCurrentHistoryProvider(()=>turnFetch(chatEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...opts.headers },
            signal: req.signal,
            body: JSON.stringify(requestBody),
          }));
        } catch {
          if (req.signal?.aborted) throw abortReasonError(req);
          throw new Error(opts.unreachableMessage);
        }
        if (!resp.ok) {
          const terminal = httpFailureResult(resp.status);
          if (terminal) return terminal;
          errText = await resp.text().catch(() => "");
        }
      }
      if (!resp.ok) {
        // The server could not parse the model's own tool-call text (gpt-oss on Ollama, measured 2026-10-11:
        // HTTP 500 "error parsing tool call"). Nothing was executed, and sampling differs on the next
        // request, so repeat the identical request a bounded number of times before failing.
        if (resp.status >= 500 && /error parsing tool call/i.test(errText) && toolParseRetries < 2 && !ownerControlPending && !req.signal?.aborted) {
          toolParseRetries += 1;
          events.onStatus(req.locale === "ko" ? "모델의 도구 호출 형식이 깨져 같은 요청을 다시 보냅니다…" : "The model's tool call was malformed; sending the same request again…");
          continue;
        }
        const failureClass = localHttpFailureClass(errText, resp.status);
        if (failureClass === "context") {
          // G32: the window we sized for may belong to a model that was swapped for a smaller one. Re-measure once; retry
          // only if the server now reports a window below the one this request was sized for. Same or unknown -> typed failure.
          if (contextRemeasures < 1 && opts.contextWindow === undefined && !ownerControlPending && !req.signal?.aborted) {
            contextRemeasures += 1;
            const failedWindow = turnWindow;
            let now: number | undefined;
            try {
              now = opts.ollamaContext ? (await remeasureOllamaWindow(host, model, req.signal)).window
                : await opts.remeasureContextWindow?.();
            } catch { now = undefined; }
            if (now !== undefined && failedWindow !== undefined && now < failedWindow) {
              remeasuredWindow = now;
              events.onNotice?.({ level: "info", code: "local-context-window-remeasured",
                message: `The model's context window is now ${now} tokens (was sized for ${failedWindow}); retrying once.` });
              continue;
            }
          }
          return assertCurrentHistoryRunnerResult({text:"",failure:localContextFailure("local_context_limit_exceeded",runtimeKind,req.locale)});
        }
        // Only explicit structured unsupported-tools markers permit the legacy downgrade.
        if (!ownerControlPending && failureClass === "tools" && tools.length > 0 && !sawAnyToolCall && resp.status >= 400 && resp.status < 500) {
          // A host-broker receipt must describe the inventory admitted to the
          // provider invocation. Retrying this Workforce turn without that
          // inventory would make a later success receipt false.
          if (approvalContext.scienceCollectionCapability) throw new Error("science_collection_tool_protocol_unsupported");
          if (broker) throw new Error("workforce_broker_tool_protocol_unsupported");
          sawUnsupportedToolCallAttempt = true;
          events.onStatus(tStatus(req.locale, "mcpToolCallUnsupported"));
          assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
          reportModelPayload(() => ledgerFromApiBody(Object.fromEntries(Object.entries(requestBody).filter(([key]) => key !== "tools")),
            { ledgerHints: req.ledgerHints, imageCount: req.images?.length ?? 0 }));
          usageAttempt = usage.start();
          const fallback = await withCurrentHistoryProvider(()=>turnFetch(chatEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...opts.headers },
            signal: req.signal,
              body: JSON.stringify(Object.fromEntries(Object.entries(requestBody).filter(([key])=>key!=="tools"))),
          }));
          if (!fallback.ok) {
            const terminal = httpFailureResult(fallback.status);
            if (terminal) return terminal;
            const fallbackErrText = await fallback.text().catch(() => "");
            const server = await serverFailureOutcome(fallback, fallbackErrText, false);
            if (server && server !== "resend") return server;
            throw new Error(`${providerLabel} API ${fallback.status}: ${fallbackErrText.slice(0, 300)}`);
          }
          const result = await streamChatTurn(fallback, events.onPartial, events.onThinking, localCompatibleTerminal ? { turn } : undefined);
          (usage.complete(usageAttempt, result.terminalUsage), result.terminalUsage && opts.contextInputSink && (opts.contextInputSink.value = result.terminalUsage.inputTokens), currentHistoryRuntimeFence()?.assertCurrent());
          const failure = terminalFailure(result);
          if (failure) return failure;
          observeOwnerControlResponse(result);
          if (opts.contextWindow !== undefined && result.finishReason === "length") return assertCurrentHistoryRunnerResult({text:"",failure:localContextFailure("local_output_limit_exceeded",runtimeKind,req.locale)});
          finalText = result.text;
          reachedAnswer = true;
          break;
        }
        const server = await serverFailureOutcome(resp, errText, true);
        if (server === "resend") {
          // The same request again, not a new tool-loop turn: the for-loop step brings `turn` back to this value.
          turn -= 1;
          continue;
        }
        if (server) return server;
        throw new Error(`${providerLabel} API ${resp.status}: ${errText.slice(0, 300)}`);
      }
    }

    const result = await streamChatTurn(resp, (partial) => events.onPartial(continuedText + partial), events.onThinking,
      localCompatibleTerminal ? { turn } : undefined);
    if (result.compatNormalized && process.env.AGENTLAS_LOCAL_TOOL_DEBUG === "1") console.log("[local-tool-loop] compat normalized:", result.compatNormalized.join(","));
    (usage.complete(usageAttempt, result.terminalUsage), result.terminalUsage && opts.contextInputSink && (opts.contextInputSink.value = result.terminalUsage.inputTokens), currentHistoryRuntimeFence()?.assertCurrent());
    const cutAtCap = result.finishReason === "length" && result.terminalObserved;
    // A text answer cut at the cap is kept and continued below; only an empty / tool-call cut may first earn a larger budget.
    const cutTextAnswer = cutAtCap && result.text.trim() !== "" && result.toolCalls.length === 0 && !result.incompleteToolCalls;
    // A reply cut at the output cap carries no usable tool call. A reasoning model (qwen3 spent all 2000
    // tokens thinking before its first call, measured 2026-10-11) used to surface here as "did not return
    // a terminal receipt ... the request may have acted", which is false: nothing was dispatched. Give the
    // model a larger budget once or twice when the caller did not pin one; otherwise say what happened.
    if (result.finishReason === "length" && result.terminalObserved && opts.contextWindow === undefined
      // Only a reply with nothing at all (a reasoning model spent the whole cap thinking) earns a larger budget; a cut
      // text answer or a cut tool call is continued below instead.
      && !cutTextAnswer && result.toolCalls.length === 0 && !result.incompleteToolCalls && !req.untrustedNoTools && !ownerControlPending) {
      const spent = requestOutputLimit(requestBody);
      const room = (turnCeiling ?? 32_768) - estimateRequestPromptTokens(requestBody) - 512;
      if (req.maxOutputTokens === undefined && spent !== undefined && outputGrowths < 2 && spent * 2 <= room) {
        outputGrowths += 1;
        outputTokenFloor = spent * 2;
        events.onStatus(req.locale === "ko" ? "모델이 답을 끝내기 전에 출력 한도에 닿아 한도를 늘려 다시 요청합니다…" : "The model reached its output limit before answering; retrying with a larger limit…");
        continue;
      }
      if (outputCuts >= OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS) {
        return assertCurrentHistoryRunnerResult({ text: continuedText, ownerControlTerminal: "uncertain",
          failure: localContextFailure("local_output_limit_exceeded", runtimeKind, req.locale),
          workforcePermissionEnforcement: broker?.finish(false) });
      }
    }
    if (cutAtCap && !req.signal?.aborted && outputCuts < OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS) {
      // Cut by the output cap: a partial reply, not a failed turn. A tool call cut mid-arguments (or any call in a cut
      // reply) is never run; the text so far is kept and one host turn continues the same conversation.
      outputCuts += 1;
      const toolCut = !req.untrustedNoTools && (result.toolCalls.length > 0 || result.incompleteToolCalls);
      if (result.text.trim()) messages.push({ role: "assistant", content: result.text });
      messages.push({ role: "user", content: outputLimitContinuationTurn(toolCut ? "tool-call" : "text") });
      if (!toolCut) continuedText += result.rawText ?? result.text;
      continue;
    }
    outputCuts = 0;
    const failure = terminalFailure(result);
    if (failure) return failure;
    observeOwnerControlResponse(result);
    if (opts.contextWindow !== undefined && result.finishReason === "length") return assertCurrentHistoryRunnerResult({text:"",failure:localContextFailure("local_output_limit_exceeded",runtimeKind,req.locale)});
    if (approvalContext.scienceCollectionCapability && (result.missingToolCallIds || result.incompleteToolCalls
      || result.finishReason === "tool_calls" && result.toolCalls.length === 0)) {
      throw new Error("science_collection_tool_frame_invalid");
    }
    if (approvalContext.scienceCollectionCapability && result.toolCalls.length > 0) {
      const ids = new Set<string>();
      for (const call of result.toolCalls) {
        if (ids.has(call.id)) throw new Error("science_collection_tool_frame_invalid");
        ids.add(call.id);
        try {
          const args: unknown = JSON.parse(call.function.arguments);
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            throw new Error("science_collection_tool_frame_invalid");
          }
        } catch {
          throw new Error("science_collection_tool_frame_invalid");
        }
      }
    }
    // A provider is allowed to hallucinate a tool_calls block even though it
    // received no tools. In the untrusted boundary, treat that response as a
    // terminal text response; never hand it to the local dispatcher.
    if (result.toolCalls.length === 0 || req.untrustedNoTools) {

      // 화면엔 아무 말도 없음). CLI 래핑은 늘 말로 끝난다 — 한 번만 "사람에게 결과를 말하라" 고 다시 묻는다.
      // 소형 모델은 답 대신 시스템 프롬프트의 "## Memory Events" 봉투만 따라 쓰기도 한다(같은 실측). 그것도 빈 답이다.
      const envelopeOnly = /^\s*#{1,6}\s*Memory Events/i.test(result.text) || /^\s*\{\s*"?schema_version"?\s*:\s*"?agentlas\.memory-ticket/i.test(result.text);
      if ((!(continuedText + result.text).trim() || envelopeOnly) && sawAnyToolCall && !req.untrustedNoTools && !summaryTurnRequested) {
        summaryTurnRequested = true;
        messages.push({ role: "assistant", content: result.text });
        messages.push({ role: "user", content: "tools: done. Answer the user: what was done + result, brief prose. No tools, no Memory Events, no JSON." });
        continue;
      }
      finalText = continuedText ? continuedText + (result.rawText ?? result.text) : result.text;
      reachedAnswer = true;
      if (process.env.AGENTLAS_LOCAL_TOOL_DEBUG === "1") console.log("[local-tool-loop] final text:", JSON.stringify(result.text.slice(0, 400)), "summaryTurn:", summaryTurnRequested);
      break;
    }
    sawAnyToolCall = true;
    continuedText = "";
    toolTurnsTaken += 1;
    toolCallsRun += result.toolCalls.length;
    if (result.thinking && result.toolCalls[0]) thinkingByCallId.set(result.toolCalls[0].id, result.thinking);
    messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });
    const visionMessages: ChatMessage[] = [];
    for (const [partIndex, call] of result.toolCalls.entries()) {
      assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
      const outcome = await runOneToolCall(byName, call, progress.events, approvalContext, broker,
        result.synthesizedCallIds?.has(call.id) ? { responseIndex: turn, partIndex } : undefined);
      progress.assertProgress();
      messages.push(outcome.toolMessage);
      if (outcome.visionMessage && opts.acceptsImageResults !== false) {
        toolVisionMessages.add(outcome.visionMessage);
        visionMessages.push(outcome.visionMessage);
      }
    }
    // Keep every protocol-required tool response directly after the assistant
    // tool_calls message, then provide screenshots as normal vision input.
    messages.push(...visionMessages);
    finalText = result.text;
    // 다음 루프에서 도구 결과를 포함해 다시 요청한다.
  }

  // ★여기서부터가 실패 판정 — 텍스트 "모양"이 아니라 이 런의 사실로만 판단한다.
  const answer = finalText.trim();
  let failure: RunnerFailure | null = null;
  // The model's own stop is a normal end, settled by the shared rule (R-065): a tool-only turn completed.
  const normalEnd = reachedAnswer ? settleNormalEnd({ text: answer, toolCalls: toolCallsRun }) : null;
  if (!reachedAnswer) {
    // 도구만 왕복하다 상한에 닿았다. 마지막 중간 텍스트는 답이 아니다.
    failure = localFailure(
      "exit",
      tStatus(req.locale, "errLocalToolLoopStuck", { model, turns: toolTurnsTaken }),
      runtimeKind,
    );
  } else if (normalEnd?.outcome === "empty") {
    failure = localFailure("empty", tStatus(req.locale, "errLocalEmptyAnswer", { model }), runtimeKind);
  } else if (answer) {
    // 표식 없이 완주했는데 산출물이 거절/한도 고지문인 경우 — 판별 규칙은
    // runtime-refusal.ts 한 곳에만 살고, 출처는 heuristic으로 남긴다.
    const refusal = detectRuntimeRefusal(answer);
    if (refusal) failure = localFailure(refusal.kind, refusal.message, runtimeKind, "heuristic");
  }

  // A permission receipt is a completion claim. Do not mint it until this
  // invocation has passed the final empty/stuck/refusal classification, and
  // never attach it to an aborted or failed result. If a tool-bearing
  // enforcement cannot be proven, propagate that failure; downgrading it to
  // a zero-tools receipt would describe the opposite of the exposed surface.
  const grantedToolIds = sawAnyToolCall && !sawUnsupportedToolCallAttempt ? [...byName.keys()] : [];
  const zeroToolsCapabilities = ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"];
  const enforcement = failure
    ? broker?.finish(false)
    : broker
      ? broker.finish(true)
      : grantedToolIds.length > 0
        ? workforceNativeToolEnforcement(req, runtimeKind, [])
        : workforceZeroToolsEnforcement(req, runtimeKind, zeroToolsCapabilities);

  const observedUsage = usage.total();
  return assertCurrentHistoryRunnerResult({
    // 실패일 때도 원문은 지우지 않는다 — 표식을 안 읽는 소비자에게 빈 말풍선을
    // 주지 않기 위해서다. 판정은 어디까지나 failure 칸이 한다.
    text: answer || (failure ? failure.message : ""),
    ownerControlTerminal: failure ? "uncertain" : ownerControlTerminal,
    ...(failure ? { failure } : {}),
    ...(!failure && normalEnd ? normalEndToolEvidence(normalEnd) : {}),
    ...(observedUsage ? { observedUsage } : {}),
    ...(admittedWindow ? { contextWindowTokens: admittedWindow } : {}),
    workforcePermissionEnforcement: enforcement,
  });
  } finally {
    if (ownerControlPending) req.ownerControlInbox!.settle(ownerControlPending,
      ownerControlDispatched ? "uncertain" : "rejected",
      ownerControlDispatched ? "owner_control_brain_reply_lost" : "owner_control_not_dispatched");
  }
}
