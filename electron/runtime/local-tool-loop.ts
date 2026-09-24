import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
import { boundedLocalOutputTokens, localContextFailure, localHttpFailureClass, measureLocalContext } from "./local-context";
import { compactHistoryToBudget, estimateTransportTokens } from "./compact";
import { browserDownloadAvailable, beginBrowserDownloadProof } from "../long-run/download-proof";
import { beginBuiltinFileProof } from "../long-run/file-proof";
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
import { planMcpToolIsMutating } from "../mcp-tools/proxy-server";
import { mcpToolSchemaDigest } from "../mcp-tools/tool-schema";
import { installLazyToolMenu, invalidateToolMenu, resolveToolMenu } from "./tool-menu";
import { CODE_MODE_TOOL, installMainCodeMode, runMainCodeMode } from "./code-mode";
import { createHash } from "node:crypto";
import type { RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";
import { workforceNativeToolEnforcement, workforceZeroToolsEnforcement } from "./runner";
import {
  MainWorkforceBroker,
  workforceBrokerDigest,
  type WorkforceBrokerInventoryEntry,
  type WorkforceBrokerProviderCallLocation,
} from "./workforce-broker";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { tStatus } from "./status-i18n";
import { abortReasonError } from "./abort-reason";
import type { InstalledMcpServer } from "../../shared/types";
import { getRuntimeSession, saveRuntimeSession } from "../store/runtime-sessions";
import {
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  type RuntimeToolPermissionAsk,
  type RuntimeToolPermissionDecision,
} from "./tool-approval";
import type { ToolPermission } from "../../shared/builtin-tools";
import type { ToolInvocationOrigin } from "../../shared/tool-invocation-origin";

function agentlasDispatchedOrigin(toolName: string): ToolInvocationOrigin {
  return { kind: "agentlas", providerName: "Agentlas", toolName };
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
  content: string;
  visionMessage: ChatMessage | null;
  isError: boolean;
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
 * 아래 동일 호출 반복으로 잡고, 이 숫자는 그것도 못 잡는 경우를 위한 방벽으로만 남긴다.
 * 사용자는 언제든 중지할 수 있고(req.signal), 각 왕복은 사용자가 보는 중에 일어난다.
 */
const MAX_TOOL_LOOP_TURNS = 200;
/** 같은 도구를 같은 인자로 이만큼 연속 부르면 진전이 없는 것으로 본다. */
const MAX_IDENTICAL_TOOL_TURNS = 3;

/** 이번 턴이 요청한 도구 호출의 지문 — 이름과 인자가 같으면 같은 지문이다.
 * 프로바이더 형식(OpenAI function_call / Anthropic tool_use)과 무관하게 이름·인자만 본다. */
export function toolTurnSignature(calls: { name: string; arguments: string }[]): string {
  return JSON.stringify(calls.map((call) => [call.name, call.arguments]));
}

export type ToolTurnProgress = { signature: string; identicalTurns: number; stalled: boolean };

/**
 * 이번 도구 턴이 '진전 없음'인지 판정한다 — 루프는 이 함수 하나만 부른다.
 * 진전의 정의: 부르는 도구나 인자가 달라지는 것. 같은 호출을 같은 인자로 반복하면
 * 더 돌아도 새 사실이 오지 않는다. 횟수가 아니라 이것이 '막힘'이다.
 */
export function trackToolTurnProgress(
  previous: { signature: string; identicalTurns: number },
  calls: { name: string; arguments: string }[],
): ToolTurnProgress {
  const signature = toolTurnSignature(calls);
  const identicalTurns = signature === previous.signature ? previous.identicalTurns + 1 : 1;
  return { signature, identicalTurns, stalled: identicalTurns >= MAX_IDENTICAL_TOOL_TURNS };
}
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
  if (!collectionBinding && ((workspaceRoot && !browserOnly) || canBrowserDownload)) {
    for (const def of builtinToolsAsOpenAi(permission, { canAskUser, canGenerateImage, canBrowserDownload })) {
      if ((browserOnly || !workspaceRoot) && def.function.name !== "browser_download") continue;
      tools.push(def);
      byName.set(def.function.name, {
        kind: "builtin",
        builtinName: def.function.name,
        brokerToolId: def.function.name,
      });
    }
  }

  if (!mcpConfigPath) return { tools, byName };
  const admitted = preparedMcpBindings(mcpConfigPath);
  for (const prepared of admitted) {
    if (collectionBinding && prepared !== collectionBinding) throw new Error("science_collection_server_identity_changed");
    signal?.throwIfAborted();
    const key = prepared.configKey;
    const server = prepared.server;
    // The identity comes from the Main-sealed binding, never a model tool name.
    // Do not connect unrelated MCP servers in an explicit browser-only run.
    if (browserOnly && server.catalogId !== "agentlas-browser") continue;
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
  /** Main-owned broker ledger hook. It records the exact approval decision. */
  onApprovalDecision?: (decision: RuntimeToolPermissionDecision) => void;
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

export async function prepareMainToolLoop(
  req: RunnerRequest,
  runtimeKind: string,
): Promise<MainToolLoopContext> {
  const collection = req.scienceCollectionCapability;
  // Under a Science / Alive-Science grant the server-side model must see that
  // grant's catalog only (it already bridges the Desktop tools it admits). An
  // ordinary One/Work run gets the same builtins as every host-loop runtime —
  // before 2026-09-24 serving in Work had no file/shell tools at all.
  const servingMcpOnly = runtimeKind === "agentlas" && Boolean(req.mcpConfigPath) && req.mcpGrantCatalogOnly === true;
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
          servingMcpOnly ? undefined : req.cwd,
          (req.permission ?? "read") as ToolPermission,
          req.unattended !== true && req.noSynchronousAsk !== true,
          imageSlotDiagnosis.state === "ready",
          req.signal,
          req.browserOnly === true,
          servingMcpOnly ? false : await browserDownloadAvailable(req.approvalChatId ?? req.chatId, req.agentId),
        );
      })();
  // ★ 로컬 소형 모델(agentlas-local)에는 도구를 그대로 준다. 코드 모드(agentlas_code)와 지연 메뉴
  //   (list→prepare→call 세 홉)는 큰 모델용 간접층인데, 격리 앱 실측(Qwen3-4B, 2026-09-13)에서 모델이
  //   agentlas_code 만 5번 부르다 브라우저에 닿지 못하고 사용자에게 되물었다. 같은 모델에 도구를
  //   직접 주면 브라우저·파일·셸 4/4 정확(엔진 직결 실측).
  const indirectToolSurface = !collection && !req.workforceRuntimeToolGrant && !req.untrustedNoTools && runtimeKind !== "agentlas-local";
  const tools = installLazyToolMenu(installMainCodeMode(eagerTools, byName, indirectToolSurface), byName, indirectToolSurface);
  if (collection) {
    const admitted = [...byName.values()].filter((tool) => tool.kind === "mcp")
      .map((tool) => tool.serverToolName);
    if (admitted.length !== SCIENCE_COLLECTION_TOOLS.length
      || SCIENCE_COLLECTION_TOOLS.some((name) => !admitted.includes(name))) {
      throw new Error("science_collection_tool_inventory_incomplete");
    }
  }
  return {
    tools,
    byName,
    ...(req.workforceRuntimeToolGrant && !req.untrustedNoTools
      ? { broker: new MainWorkforceBroker(req, runtimeKind, mainToolBrokerInventory(tools, byName)) }
      : {}),
    approval: {
      ...(collection ? { scienceCollectionCapability: collection } : {}),
      ...(req.planMode ? { planMode: true as const } : {}),
      runtimeKind,
      sessionKey: `${runtimeKind}:${req.sessionFingerprintSeed ?? req.cwd ?? "default"}`,
      permission: req.permission,
      ...(req.cwd ? { cwd: req.cwd } : {}),
      ...(req.approvalChatId ?? req.chatId ? { chatId: req.approvalChatId ?? req.chatId } : {}),
      ...(req.agentId ? { agentId: req.agentId } : {}),
      unattended: req.unattended === true,
      ...(req.signal ? { signal: req.signal } : {}),
    },
  };
}

async function approveLocalToolCall(
  ctx: LocalToolApprovalContext,
  toolName: string,
  consentMaterial: unknown,
  detail?: string,
): Promise<RuntimeToolPermissionDecision> {
  // 내장 도구는 우리가 만든 것이라 성격을 안다 — 지어내는 게 아니라 아는 것을 싣는다.
  // MCP 도구는 정의에 종류 칸이 없으므로 "other"에 머문다.
  const { builtinToolByName } = await import("../../shared/builtin-tools");
  const builtin = builtinToolByName(toolName);
  const builtinKind = builtin
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
    // MCP 도구는 여전히 전부 변이로 본다 — 증명할 수 없는 무해함은 허용 근거가 못 된다.
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
  approval.signal?.throwIfAborted();
  try {
    if (approval.scienceCollectionCapability) assertScienceCollectionTool(approval.scienceCollectionCapability, byName.get(call.toolName));
    if (call.toolName === CODE_MODE_TOOL) {
      if (broker) throw new Error("code_mode_broker_not_supported");
      const result = await runMainCodeMode(byName, call.arguments, events, approval, runMainToolDispatch);
      events.onTool?.(call.toolName, call.arguments, result.content, call.providerCallId ?? undefined, result.isError, undefined, undefined, agentlasDispatchedOrigin(call.toolName));
      return result;
    }
    const menu = resolveToolMenu(byName, call.toolName, call.arguments);
    if (menu?.kind === "result") {
      events.onTool?.(call.toolName, call.arguments, menu.content, call.providerCallId ?? undefined, false, undefined, undefined, agentlasDispatchedOrigin(call.toolName));
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
          providerEvents.onTool?.(name, args, result, providerCall.providerCallId ?? undefined, ...rest),
      };
      call = { ...call, toolName: menu.toolName, arguments: menu.arguments };
    }
  } catch (error) {
    const content = `Error: ${error instanceof Error ? error.message : String(error)}`;
    events.onTool?.(call.toolName, call.arguments, content, call.providerCallId ?? undefined, true);
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
    events.onTool?.(call.toolName, call.arguments, "unknown tool", eventCallId, true);
    return {
      content: `Error: unknown tool "${call.toolName}"`,
      visionMessage: null,
      isError: true,
    };
  }
  let args: Record<string, unknown> = {};
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    if (actionId) broker?.finishAction(actionId, "not_dispatched");
    events.onTool?.(call.toolName, call.arguments, "invalid JSON arguments", eventCallId, true);
    return {
      content: "Error: invalid JSON arguments",
      visionMessage: null,
      isError: true,
    };
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
    ? !["list_dir", "read_file", "ask_user"].includes(resolved.builtinName)
    : planMcpToolIsMutating({ authority: planReadAuthority, toolName: resolved.serverToolName, args });
  if (approval.planMode && planMutation) {
    const content = "Error: plan_mode_mutation_denied";
    if (actionId) broker?.finishAction(actionId, "denied");
    events.onTool?.(call.toolName, call.arguments, content, eventCallId, true);
    return { content, visionMessage: null, isError: true };
  }
  // 승인은 **호출 직전**이다. 인자를 파싱한 뒤, 서버에 닿기 전.
  let approvalDecision: RuntimeToolPermissionDecision | null = null;
  const actionApproval: LocalToolApprovalContext = actionId
    ? {
        ...approval,
        onApprovalDecision: (decision) => {
          approval.onApprovalDecision?.(decision);
          approvalDecision = decision;
          broker?.recordDecision(actionId, decision);
        },
      }
    : approval;
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
  if ((collectionDecision ?? await approveLocalToolCall(actionApproval, call.toolName, consentMaterial, downloadOrigin)) === "deny") {
    if (actionId) broker?.finishAction(actionId, "denied");
    const denied = `Error: tool call denied — "${call.toolName}" was not approved for this run.`;
    events.onTool?.(call.toolName, call.arguments, denied, eventCallId, true);
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
  events.onTool?.(call.toolName, call.arguments, undefined, eventCallId, false, undefined, undefined, agentlasDispatchedOrigin(call.toolName));
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
    const outcome = await runBuiltinTool(resolved.builtinName, args, {
      cwd: approval.cwd ?? process.cwd(),
      permission: (approval.permission ?? "read") as ToolPermission,
      signal: approval.signal,
      ...(downloadProof ? {browserDownload:downloadProof.download} : {}),
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
      call.toolName,
      call.arguments,
      outcome.content,
      eventCallId,
      !outcome.ok,
      outcome.artifactPaths,
      outcome.imageDataUrl,
      agentlasDispatchedOrigin(call.toolName),
    );
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
    return {
      content: (outcome.ok ? outcome.content : `Error: ${outcome.content}`).slice(0, MAX_TOOL_RESULT_CHARS),
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
  }
  try {
    const [{ callServerToolContent }, { saveBrowserCaptureArtifact }] = await Promise.all([
      import("../mcp-tools/client"),
      import("../media/capture-artifacts"),
    ]);
    approval.signal?.throwIfAborted();
    approval.assertCurrent?.();
    const result = await callServerToolContent(resolved.server, resolved.serverToolName, args, {
      timeoutMs: 30_000, signal: approval.signal, prepared: resolved.prepared,
      expectedToolSchemaDigest: resolved.schemaDigest, onToolSchemaInvalidated: () => invalidateToolMenu(byName),
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
    events.onTool?.(
      call.toolName,
      call.arguments,
      text,
      eventCallId,
      result.isError,
      capturePaths.length > 0 ? capturePaths : undefined,
    );
    if (actionId) {
      if (approvalDecision === null) throw new Error("workforce_broker_approval_missing");
      broker?.finishAction(actionId, result.isError ? "failed" : "succeeded");
    }
    return {
      content: text.slice(0, MAX_TOOL_RESULT_CHARS),
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
    events.onTool?.(call.toolName, call.arguments, message, eventCallId, true);
    if (actionId) {
      if (approvalDecision === null) throw new Error("workforce_broker_approval_missing");
      broker?.finishAction(actionId, "failed");
    }
    return {
      content: `Error: ${message}`,
      visionMessage: null,
      isError: true,
    };
  }
}

/** OpenAI Chat Completions still needs the actual provider tool-call ID in its
 * `role: tool` message. It is a wire wrapper over the neutral Main dispatch. */
export async function runOneToolCall(
  byName: Map<string, ResolvedTool>,
  call: OpenAiToolCall,
  events: RunnerEvents,
  approval: LocalToolApprovalContext,
  broker?: MainWorkforceBroker,
): Promise<{ toolMessage: Extract<ChatMessage, { role: "tool" }>; visionMessage: ChatMessage | null; isError: boolean }> {
  const outcome = await runMainToolDispatch(
    byName,
    { providerCallId: call.id, toolName: call.function.name, arguments: call.function.arguments },
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
  finishReason?: string;
  text: string;
  toolCalls: OpenAiToolCall[];
  missingToolCallIds: boolean;
  incompleteToolCalls: boolean;
  terminalUsage?: { inputTokens: number; outputTokens: number };
}

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
): Promise<StreamTurnResult> {
  let acc = "";
  let finishReason: string | undefined;
  let sawDone = false;
  let terminalUsage: StreamTurnResult["terminalUsage"];
  let terminalUsageChunks = 0;
  let lastChunkWasUsage = false;
  let lastEmit = 0;
  // OpenAI-호환 로컬 서버(ollama·LM Studio·MLX)는 생각을 delta.reasoning_content(또는
  // ollama의 delta.reasoning / delta.thinking)로 따로 준다. 자기 행으로 흘린다.
  let thinkingOpen = false;
  let thinkingStartedAt = 0;
  const pending = new Map<number, { id?: string; name: string; args: string }>();
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { sawDone = true; break; }
    lastChunkWasUsage = false;
    try {
      const event = JSON.parse(payload) as {
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
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
          terminalUsage = { inputTokens: Number(input), outputTokens: Number(output) };
          lastChunkWasUsage = true;
        }
      }
      if (typeof event.choices?.[0]?.finish_reason === "string") finishReason = event.choices[0].finish_reason;
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
  const pendingCalls = [...pending.values()];
  const toolCalls: OpenAiToolCall[] = pendingCalls
    .filter((entry) => entry.name)
    .map((entry, i) => ({
      id: entry.id ?? `call_${i}`,
      type: "function" as const,
      function: { name: entry.name, arguments: entry.args },
    }));
  return { text: acc.trim(), toolCalls, finishReason,
    ...(sawDone && finishReason && terminalUsageChunks === 1 && lastChunkWasUsage && terminalUsage
      ? { terminalUsage } : {}),
    missingToolCallIds: pendingCalls.some((entry) => !entry.id),
    incompleteToolCalls: pendingCalls.some((entry) => !entry.name),
  };
}

export interface RunLocalOpenAiChatOptions {
  /**
   * false = 이 런타임은 이미지를 입력으로 못 받는다(agentlas-local: 비전 프로젝터 없음). 스크린샷 도구 결과의
   * 이미지를 대화에 넣지 않는다 — 넣으면 문맥 측정(/apply-template)이 깨져 local_context_measurement_unavailable
   * 로 실행이 죽었다(격리 앱 실측 2026-09-13, cua-driver get_screen). 텍스트 결과(저장 경로·좌표)는 그대로 간다.
   */
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
  /** Publisher/model-specific chat-template controls applied by a managed adapter. */
  chatTemplateKwargs?: Record<string, boolean | number | string>;
  /** Main resident receipt, present only for managed llama.cpp. */
  contextWindow?: number;
  /** Non-tokenizer API estimate from the selected model catalog (or a labelled
   * conservative fallback). Exact managed-local measurement uses contextWindow. */
  estimatedContextWindow?: number;
  estimatedOutputReserve?: number;
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
  const recovery = assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
  const chatEndpoint = opts.chatEndpoint ?? `${host}/v1/chat/completions`;
  const providerLabel = opts.providerLabel ?? host;
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
  const previousSession = !recovery && req.chatId
    ? getRuntimeSession(req.chatId, runtimeKind, runtimeSessionOwnerId, { isolateOwner: isolateRuntimeSessionOwner })
    : null;
  if (!recovery && req.chatId && sessionFingerprint) {
    // OpenAI-compatible local servers have no provider conversation ID. The
    // durable Agentlas chat history is the source of truth, while this
    // logical session record makes continuity visible and detects model/host
    // changes without pretending the server supports native resume.
    saveRuntimeSession(req.chatId, runtimeKind, req.chatId, sessionFingerprint, { agentId: runtimeSessionOwnerId, isolateOwner: isolateRuntimeSessionOwner });
    if (previousSession && previousSession.fingerprint === sessionFingerprint) {
      events.onStatus(req.locale === "ko" ? "로컬 모델 대화 기록 이어가는 중..." : "Continuing local model conversation history...");
    }
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
    // (격리 앱 실측 2026-09-13: get_screen 21회, 4분 타임아웃). 도구를 빼고 사람에게 이유를 말한다.
    // 브라우저 스크린샷도 같은 이유로 뺀다 — 3회 반복 실측(2026-09-13)에서 비전 없는 모델이
    // browser_take_screenshot 을 8번 부르고 screen_capture_unavailable 로 실패했다.
    const isBlindTool = (name: string) => name.startsWith("mcp__cua-driver__") || /^mcp__agentlas-browser__browser_(?:take_)?screenshot$/.test(name);
    const blind = tools.filter((tool) => isBlindTool(tool.function.name));
    if (blind.length > 0) {
      tools = tools.filter((tool) => !isBlindTool(tool.function.name));
      for (const tool of blind) byName.delete(tool.function.name);
      events.onNotice?.({
        level: "info",
        code: "computer-use-needs-vision-model",
        message: req.locale === "ko" ? "이 로컬 모델은 화면을 볼 수 없어 컴퓨터 유즈 도구를 이번 실행에서 뺐습니다. 브라우저·파일·셸 도구는 그대로입니다." : "This local model cannot see the screen, so Computer Use tools were left out of this run. Browser, file and shell tools are unchanged.",
        i18n: {
          ko: "이 로컬 모델은 화면을 볼 수 없어 컴퓨터 유즈 도구를 이번 실행에서 뺐습니다. 브라우저·파일·셸 도구는 그대로입니다.",
          en: "This local model cannot see the screen, so Computer Use tools were left out of this run. Browser, file and shell tools are unchanged.",
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
        content: `File tools are sandboxed to this run's workspace folder: ${req.cwd}. Pass workspace-relative paths (for example, src/index.ts); absolute paths and paths escaping this folder will be rejected.`,
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
  const reportHistoryCompaction = (droppedCount: number): void => {
    if (historyCompactionReported) return;
    historyCompactionReported = true;
    events.onNotice?.({ level: "info", code: "history-compacted", display: "divider",
      message: req.locale === "ko"
        ? `이 모델의 용량에 맞춰 이전 대화 ${droppedCount}개를 비신뢰 발췌로 보냈습니다. 현재 요청과 지시는 그대로입니다.`
        : `Sent untrusted excerpts of ${droppedCount} earlier messages to fit this model's context. Current request and instructions are unchanged.` });
  };
  if (opts.capacitySource === "unknown") {
    events.onNotice?.({ level: "warning", code: "model-context-capacity-estimated",
      message: req.locale === "ko"
        ? "이 모델의 실제 문맥 용량을 확인하지 못해 보수적 추정치를 적용합니다."
        : "This model's actual context capacity is unknown; using a conservative estimate." });
  }
  let finalText = "";
  let sawAnyToolCall = false;
  let summaryTurnRequested = false;
  let sawUnsupportedToolCallAttempt = false;
  /** 루프가 답에 도달해서 끝났는가. false로 빠져나오면 도구 왕복만 하다 멈춘 것. */
  let reachedAnswer = false;
  /** 실제로 돈 도구 왕복 횟수 — 실패 문구에는 상한이 아니라 이 사실이 실린다. */
  let toolTurnsTaken = 0;
  let lastToolSignature = "";
  let identicalToolTurns = 0;
  /** The optional Surface fallback is a one-time swap, never a per-turn oscillation. */
  let surfaceFallbackApplied = false;
  let observedInputTokens = 0;
  let observedOutputTokens = 0;
  let usageComplete = true;
  let streamUsageUnsupported = false;
  const observeTurnUsage = (result: StreamTurnResult): void => {
    const usage = result.terminalUsage;
    if (!usage || !usageComplete
      || observedInputTokens + usage.inputTokens > Number.MAX_SAFE_INTEGER
      || observedOutputTokens + usage.outputTokens > Number.MAX_SAFE_INTEGER
      || observedInputTokens + observedOutputTokens + usage.inputTokens + usage.outputTokens > Number.MAX_SAFE_INTEGER) {
      usageComplete = false;
      return;
    }
    observedInputTokens += usage.inputTokens;
    observedOutputTokens += usage.outputTokens;
  };

  for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn += 1) {
    const requestBody: Record<string, unknown> = {
            model,
            stream: true,
            ...(!streamUsageUnsupported && (runtimeKind === "byok" || runtimeKind === "lmstudio")
              ? { stream_options: { include_usage: true } } : {}),
            messages,
            ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}),
            ...(opts.chatTemplateKwargs ? { chat_template_kwargs: opts.chatTemplateKwargs } : {}),
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.estimatedContextWindow !== undefined
              ? { max_tokens: opts.estimatedOutputReserve ?? Math.min(8_192, Math.floor(opts.estimatedContextWindow / 4)) }
              : {}),
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
        };
    if (opts.estimatedContextWindow !== undefined) {
      const window = opts.estimatedContextWindow;
      const reserve = opts.estimatedOutputReserve ?? Math.min(8_192, Math.floor(window / 4));
      let inputEstimate = estimateTransportTokens(JSON.stringify(requestBody));
      for (let attempt = 0; attempt < 8 && inputEstimate + reserve > window
        && historicalEntries.length > 0; attempt += 1) {
        historyBudgetTokens = Math.max(0, historyBudgetTokens - (inputEstimate + reserve - window) - Math.ceil(window * 0.02));
        const droppedCount = applyHistoricalBudget(historyBudgetTokens);
        if (droppedCount === null) break;
        inputEstimate = estimateTransportTokens(JSON.stringify(requestBody));
        if (inputEstimate + reserve <= window) reportHistoryCompaction(droppedCount);
      }
      if (inputEstimate + reserve > window && !opts.unknownCapacityProviderEnforced) {
        return { text: "", failure: { kind: "refused", runtime: runtimeKind, source: "marker",
          providerCode: "model_context_capacity_exceeded",
          message: req.locale === "ko"
            ? "현재 모델의 추정 문맥 용량을 넘었습니다. 요청·지시·도구 내용은 잘라내지 않았습니다."
            : "The request exceeds this model's estimated context capacity. Current request, instructions, and tools were not clipped." } };
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
        if (!measured.fits) return {text:"",failure:localContextFailure("local_context_limit_exceeded",runtimeKind,req.locale)};
        const admittedOutputTokens = boundedLocalOutputTokens(measured.maxOutputTokens, req.maxOutputTokens);
        if (req.maxOutputTokens && admittedOutputTokens < req.maxOutputTokens) {
          return {text:"",failure:localContextFailure("local_context_limit_exceeded",runtimeKind,req.locale)};
        }
        requestBody.max_tokens = admittedOutputTokens;
      } catch {
        if (req.signal?.aborted) throw abortReasonError(req);
        return {text:"",failure:localContextFailure("local_context_measurement_unavailable",runtimeKind,req.locale)};
      }
    }
    assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
    let resp: Response;
    try {
      resp = await fetch(chatEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...opts.headers },
        signal: req.signal,
          body: JSON.stringify(requestBody),
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
      if (!req.signal?.aborted && Object.hasOwn(requestBody, "stream_options")
        && rejectsStreamUsageOption(resp.status, errText)) {
        // This structured validation refusal precedes generation. Retry the
        // identical request once without the unsupported usage option. Since
        // the retry cannot promise a terminal usage pair, keep the whole
        // invocation's observed usage unknown, including earlier tool turns.
        usageComplete = false;
        streamUsageUnsupported = true;
        const retryBody = { ...requestBody };
        delete retryBody.stream_options;
        assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
        try {
          resp = await fetch(chatEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...opts.headers },
            signal: req.signal,
            body: JSON.stringify(retryBody),
          });
        } catch {
          if (req.signal?.aborted) throw abortReasonError(req);
          throw new Error(opts.unreachableMessage);
        }
        if (!resp.ok) {
          const retryError = await resp.text().catch(() => "");
          throw new Error(`${providerLabel} API ${resp.status}: ${retryError.slice(0, 300)}`);
        }
      } else {
        const failureClass = localHttpFailureClass(errText);
        if (failureClass === "context") return {text:"",failure:localContextFailure("local_context_limit_exceeded",runtimeKind,req.locale)};
        // Only explicit structured unsupported-tools markers permit the legacy downgrade.
        if (failureClass === "tools" && tools.length > 0 && !sawAnyToolCall && resp.status >= 400 && resp.status < 500) {
          // A host-broker receipt must describe the inventory admitted to the
          // provider invocation. Retrying this Workforce turn without that
          // inventory would make a later success receipt false.
          if (approvalContext.scienceCollectionCapability) throw new Error("science_collection_tool_protocol_unsupported");
          if (broker) throw new Error("workforce_broker_tool_protocol_unsupported");
          sawUnsupportedToolCallAttempt = true;
          events.onStatus(tStatus(req.locale, "mcpToolCallUnsupported"));
          assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
          const fallback = await fetch(chatEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...opts.headers },
            signal: req.signal,
              body: JSON.stringify(Object.fromEntries(Object.entries(requestBody).filter(([key])=>key!=="tools"))),
          });
          if (!fallback.ok) {
            const fallbackErrText = await fallback.text().catch(() => "");
            throw new Error(`${providerLabel} API ${fallback.status}: ${fallbackErrText.slice(0, 300)}`);
          }
          const result = await streamChatTurn(fallback, events.onPartial, events.onThinking);
          observeTurnUsage(result);
          if (opts.contextWindow !== undefined && result.finishReason === "length") return {text:"",failure:localContextFailure("local_output_limit_exceeded",runtimeKind,req.locale)};
          finalText = result.text;
          reachedAnswer = true;
          break;
        }
        throw new Error(`${providerLabel} API ${resp.status}: ${errText.slice(0, 300)}`);
      }
    }

    const result = await streamChatTurn(resp, events.onPartial, events.onThinking);
    observeTurnUsage(result);
    if (opts.contextWindow !== undefined && result.finishReason === "length") return {text:"",failure:localContextFailure("local_output_limit_exceeded",runtimeKind,req.locale)};
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
      // 소형 로컬 모델은 도구를 다 쓴 뒤 빈 답으로 끝내기도 한다(격리 앱 실측 2026-09-13: 파일은 만들었는데
      // 화면엔 아무 말도 없음). CLI 래핑은 늘 말로 끝난다 — 한 번만 "사람에게 결과를 말하라" 고 다시 묻는다.
      // 소형 모델은 답 대신 시스템 프롬프트의 "## Memory Events" 봉투만 따라 쓰기도 한다(같은 실측). 그것도 빈 답이다.
      const envelopeOnly = /^\s*#{1,6}\s*Memory Events/i.test(result.text) || /^\s*\{\s*"?schema_version"?\s*:\s*"?agentlas\.memory-ticket/i.test(result.text);
      if ((!result.text.trim() || envelopeOnly) && sawAnyToolCall && !req.untrustedNoTools && !summaryTurnRequested) {
        summaryTurnRequested = true;
        messages.push({ role: "assistant", content: result.text });
        messages.push({ role: "user", content: req.locale === "ko"
          ? "도구 실행은 끝났습니다. 이제 사용자에게 무엇을 했고 결과가 무엇인지 한국어 평문으로 짧게 답하세요. 도구를 더 부르지 말고, Memory Events 블록이나 JSON 은 쓰지 마세요."
          : "Tool execution is finished. Now tell the user in plain prose, briefly, what was done and the result. Do not call more tools and do not write a Memory Events block or JSON." });
        continue;
      }
      finalText = result.text;
      reachedAnswer = true;
      if (process.env.AGENTLAS_LOCAL_TOOL_DEBUG === "1") console.log("[local-tool-loop] final text:", JSON.stringify(result.text.slice(0, 400)), "summaryTurn:", summaryTurnRequested);
      break;
    }
    sawAnyToolCall = true;
    toolTurnsTaken += 1;
    const progress = trackToolTurnProgress(
      { signature: lastToolSignature, identicalTurns: identicalToolTurns },
      result.toolCalls.map((call) => call.function),
    );
    lastToolSignature = progress.signature;
    identicalToolTurns = progress.identicalTurns;
    if (progress.stalled) {
      // 같은 호출을 같은 인자로 반복하고 있다 — 더 돌아도 새 사실이 오지 않는다.
      finalText = result.text;
      break;
    }
    messages.push({ role: "assistant", content: result.text, tool_calls: result.toolCalls });
    const visionMessages: ChatMessage[] = [];
    for (const call of result.toolCalls) {
      assertScienceRecoveryRequest(req, runtimeKind, opts.recoveryBackend);
      const outcome = await runOneToolCall(byName, call, events, approvalContext, broker);
      messages.push(outcome.toolMessage);
      if (outcome.visionMessage && opts.acceptsImageResults !== false) visionMessages.push(outcome.visionMessage);
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
  if (!reachedAnswer) {
    // 도구만 왕복하다 상한에 닿았다. 마지막 중간 텍스트는 답이 아니다.
    failure = localFailure(
      "exit",
      tStatus(req.locale, "errLocalToolLoopStuck", { model, turns: toolTurnsTaken }),
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

  const observedUsage = usageComplete
    ? { inputTokens: observedInputTokens, outputTokens: observedOutputTokens } : undefined;
  if (observedUsage) events.onTerminalObservedUsage?.(observedUsage);
  return {
    // 실패일 때도 원문은 지우지 않는다 — 표식을 안 읽는 소비자에게 빈 말풍선을
    // 주지 않기 위해서다. 판정은 어디까지나 failure 칸이 한다.
    text: answer || (failure ? failure.message : ""),
    ...(failure ? { failure } : {}),
    ...(observedUsage ? { observedUsage } : {}),
    workforcePermissionEnforcement: enforcement,
  };
}
