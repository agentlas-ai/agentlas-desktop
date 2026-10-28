import { assertCurrentHistoryRunnerResult } from "./observed-runner";
import { openStatelessGeneration, statelessHistoryTokens, type StatelessWindowSource } from "./stateless-generation";
import { reportModelPayload, reportCachePlan, reportModelEndpoint, reportModelEffort, ledgerFromApiBody, type ModelEffortApplication } from "./model-call-ledger";
import { GENERATION_CONTEXT_RATIO } from "./session-generation";
import { foldRetainedToolResult } from "./tool-result-context";
import { createHash } from "node:crypto";
import { prepareCompressedJsonRequest } from "../../shared/http-request-compression";
import { requestCompressionNetworkState } from "../net/system-network-core";
import { currentHistoryRuntimeFence, withCurrentHistoryProvider } from "../one/history-runtime-fences";
import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
// BYOK 직접 API 러너 — Anthropic Messages / OpenAI Chat Completions / Google Generative API.
// Node 20+ 글로벌 fetch + ReadableStream으로 SSE 파싱. 외부 SDK 의존성 없음.
//
// 보안 (PRD §6.2): API 키는 메인 프로세스만 접근. renderer로 노출 안 됨.
// Agentlas 서버 미경유 — 사용자 머신에서 vendor에 직접 호출.
//
// 컨텍스트 정책: BYOK는 Agentlas-managed (CONTEXT_MANAGED_BY === "agentlas").
//  - 모델 선택: req.model (없으면 카탈로그 기본값)
//  - 1M 컨텍스트: Anthropic은 beta 헤더(opt-in), OpenAI/Google은 모델 내장(자동)
//  - 압축: 모델 컨텍스트 윈도우 초과 시 compactHistory로 과거 대화를 다이제스트로 접음
import { readApiKey } from "../secrets/vault";
import type { Runner, RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";
import { cumulativeSurfaceGateText, markRefusedBeforeDispatch, RuntimeTurnUnsettledError, runtimeHttpFailure, workforceZeroToolsEnforcement, wrapSystemPrompt } from "./runner";
import { applyPlannedMessageBreakpoints, cachedTokensFromGeminiUsage } from "./prompt-cache";
import { cacheCapabilityFor, planCache, segmentOf, type CachePlan, type CacheSegment } from "./cache-planner";
import { readByokWire } from "./byok-wire";
import {
  ensureGeminiCachedContent, forgetGeminiCachedContent, geminiBodyWithCache, isGeminiCacheMissing, readGeminiCacheSetting,
  GEMINI_CACHE_DEFAULT, type EnsureOutcome,
} from "./gemini-explicit-cache";
import { createOwnerControlBoundary, ownerControlHistoryImages } from "./owner-control-pump";
import { abortReasonError } from "./abort-reason";
import {
  prepareMainToolLoop,
  runLocalOpenAiChat,
  runMainToolDispatch,
  runOneToolCall,
  createToolLoopProgress,
  createToolLoopUsage,
  noModelSelectedResult,
  refusedBeforeDispatch,
  type ChatMessage,
  type LocalChatContent,
  type MainToolDispatchResult,
} from "./local-tool-loop";
import { tStatus } from "./status-i18n";
import { OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS, outputLimitContinuationTurn } from "./output-limit-continuation";
import { schemaFallbackInstruction, schemaFallbackPromptPart, observationSystemWithSchema } from "../../shared/runtime-capabilities";
import { compactHistoryToBudget, estimateTransportTokens } from "./compact";
import { detectRuntimeRefusal } from "./runtime-refusal";
import { EMPTY_NO_TOOL_RAN_CODE, normalEndToolEvidence, settleNormalEnd } from "../../shared/turn-settlement";
import {
  serverFailure, serverFailureCodeForStatus, serverFailureResendable, serverFailureResendDelayMs, SERVER_FAILURE_RESENDS,
  waitForServerResend,
} from "./provider-overload";
import {
  ANTHROPIC_1M_BETA,
  anthropicCompatProvider,
  type ByokBackend,
  defaultByokModel,
  resolveEffectiveContextWindow,
  UNKNOWN_CONTEXT_WINDOW,
  needsLongContextToggle,
} from "../../shared/models";

/**
 * 도구 왕복 상한은 **일의 크기를 재는 숫자가 아니라** 폭주를 세우는 마지막 방벽이다.
 * 8 이었을 때는 사용자 키로 도는 정상적인 긴 작업이 여기에 먼저 닿아 통째로 버려졌다.
 * 진짜 막힘은 완료된 호출과 결과가 그대로 반복되는지 local-tool-loop 과 같은 판정으로 잡는다.
 */
const MAX_BYOK_TOOL_TURNS = 200;

function byokFailure(
  kind: RunnerFailure["kind"],
  message: string,
): RunnerFailure {
  return { kind, message: message.slice(0, 400), runtime: "byok", source: "marker" };
}

function byokContextFailure(req: RunnerRequest): RunnerFailure {
  return { kind: "refused", runtime: "byok", source: "marker", providerCode: "model_context_capacity_exceeded",
    message: req.locale === "ko"
      ? "현재 모델의 추정 문맥 용량을 넘었습니다. 요청·지시·도구 내용은 잘라내지 않았습니다."
      : "The request exceeds this model's estimated context capacity. Current request, instructions, and tools were not clipped." };
}

function resolveModel(backend: ByokBackend, req: RunnerRequest): string {
  return req.model?.trim() || defaultByokModel(backend) || "";
}

/** No model id and no pinned default (DEFAULT_BYOK_MODEL is empty): a typed refusal before any request (A4 C6.2). */
function byokNoModel(backend: ByokBackend, req: RunnerRequest): RunnerResult | null {
  if (resolveModel(backend, req)) return null;
  return noModelSelectedResult("byok", req.locale === "ko"
    ? "사용할 모델 ID가 없습니다. 설정에서 실시간 모델을 선택하거나 모델 ID를 직접 입력하세요."
    : "No model ID is selected. Choose a live model or enter a model ID in Settings.");
}

/**
 * The key is read from the OS keychain before any request exists. A read that fails (a locked keychain, a native lookup that
 * timed out, a company policy refusal) sent nothing, so it is a refusal before dispatch that keeps its own typed code, not
 * a dispatched turn without a receipt that the host must never replay.
 */
function readKeyBeforeDispatch(backend: Parameters<typeof readApiKey>[0]): Promise<string | null> {
  return readApiKey(backend).catch((error: unknown) => { throw markRefusedBeforeDispatch(error); });
}

/** A missing provider key: refused before any request leaves Main, with a typed code instead of a thrown sentence. */
function byokCredentialMissing(message: string): RunnerResult {
  return refusedBeforeDispatch({ kind: "auth", runtime: "byok", source: "marker", providerCode: "credential_missing", message: message.slice(0, 400) });
}

/**
 * Images a host tool returned (visionMessage of the shared dispatcher, OpenAI image_url data URLs) as base64 parts for a
 * provider's own content format (A4 C7.3). Only well-formed data URLs of the four image types every provider accepts.
 */
function toolResultImages(outcome: Pick<MainToolDispatchResult, "visionMessage" | "isError">): Array<{ mediaType: string; data: string }> {
  const content = outcome.isError ? null : outcome.visionMessage?.content;
  if (!Array.isArray(content)) return [];
  const images: Array<{ mediaType: string; data: string }> = [];
  for (const part of content) {
    if (part?.type !== "image_url") continue;
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url?.url ?? "");
    if (match) images.push({ mediaType: match[1], data: match[2] });
  }
  return images.slice(0, 8);
}

/**
 * In-turn compaction for the BYOK wire loops (A4 C3.3), same rule as local-tool-loop.ts: at a settled tool-step boundary,
 * when the request reaches 80% of a known window or would fail admission, earlier tool results of this turn become durable
 * read_tool_result references, oldest first; the latest tool group stays verbatim and every call/result pair stays.
 */
function foldByokToolResults(slots: Array<{ get(): string; set(value: string): void }>, fits: () => boolean,
  byName: Parameters<typeof foldRetainedToolResult>[0], scope: Parameters<typeof foldRetainedToolResult>[1]): number {
  let folded = 0;
  for (const slot of slots) {
    if (fits()) break;
    const reference = foldRetainedToolResult(byName, scope, slot.get());
    if (reference) { slot.set(reference); folded += 1; }
  }
  return folded;
}

const ANTHROPIC_EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const anthropicEffortCapabilities = new Map<string, Promise<ReadonlySet<string> | null>>();

/**
 * The effort levels Anthropic's own Models API says this model accepts (GET /v1/models/{id} -> capabilities.effort, each
 * level with `supported`). Typed capability, never a model-name rule; cached per endpoint, key and model for the process.
 * null = the capability could not be read (no effort is sent, and the ledger says why).
 */
function anthropicEffortLevels(baseUrl: string, headers: Record<string, string>, model: string, signal?: AbortSignal): Promise<ReadonlySet<string> | null> {
  const keyDigest = createHash("sha256").update(headers["x-api-key"] ?? headers.authorization ?? "").digest("hex").slice(0, 16);
  const cacheKey = `${baseUrl}\0${keyDigest}\0${model}`;
  const cached = anthropicEffortCapabilities.get(cacheKey);
  if (cached) return cached;
  const lookup = (async () => {
    try {
      const response = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(model)}`, { headers, ...(signal ? { signal } : {}) });
      if (!response.ok) return null;
      const body = await response.json() as { capabilities?: { effort?: Record<string, unknown> } };
      const effort = body?.capabilities?.effort;
      if (!effort || typeof effort !== "object" || (effort as { supported?: unknown }).supported !== true) return new Set<string>();
      return new Set(ANTHROPIC_EFFORT_ORDER.filter((level) => (effort[level] as { supported?: unknown } | undefined)?.supported === true));
    } catch { return null; }
  })();
  anthropicEffortCapabilities.set(cacheKey, lookup);
  void lookup.then((levels) => { if (levels === null) anthropicEffortCapabilities.delete(cacheKey); });
  return lookup;
}

/** The requested level when the model takes it, else the highest supported level below it, else its lowest level. */
function pickSupportedEffort(requested: string, supported: ReadonlySet<string>): string | null {
  if (supported.has(requested)) return requested;
  const rank = ANTHROPIC_EFFORT_ORDER.indexOf(requested);
  if (rank < 0) return null;
  const below = ANTHROPIC_EFFORT_ORDER.filter((level, index) => index <= rank && supported.has(level));
  return below.at(-1) ?? ANTHROPIC_EFFORT_ORDER.find((level) => supported.has(level)) ?? null;
}

/** Gemini generateContent thinkingConfig.thinkingLevel (API reference ThinkingLevel: MINIMAL | LOW | MEDIUM | HIGH). */
function geminiThinkingLevel(requested: string | undefined): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | null {
  switch (requested) {
    case "none": case "minimal": return "MINIMAL";
    case "low": return "LOW";
    case "medium": return "MEDIUM";
    case "high": case "xhigh": case "max": return "HIGH";
    default: return null;
  }
}

/**
 * Gemini's structured BadRequest for the thinking level ("Use with earlier models results in an error", API reference):
 * a field violation whose path names the thinking config. Nothing else permits dropping the field.
 */
export function geminiThinkingConfigRejected(body: string): boolean {
  try {
    const details = (JSON.parse(body) as { error?: { details?: Array<{ fieldViolations?: Array<{ field?: unknown }> }> } })?.error?.details;
    return Array.isArray(details) && details.some((detail) => Array.isArray(detail?.fieldViolations)
      && detail.fieldViolations.some((violation) => typeof violation?.field === "string"
        && /(?:^|\.)(?:generation_config|generationConfig)\.(?:thinking_config|thinkingConfig)(?:\.|$)/.test(violation.field)));
  } catch {
    return false;
  }
}

/** Google's machine status for a request the API rejected as malformed (error.status "INVALID_ARGUMENT"). */
function geminiInvalidArgument(body: string): boolean {
  try { return (JSON.parse(body) as { error?: { status?: unknown } })?.error?.status === "INVALID_ARGUMENT"; } catch { return false; }
}

/** Gemini's structured BadRequest naming a function response's media parts (models before Gemini 3 take text only). */
export function geminiFunctionResponsePartsRejected(body: string): boolean {
  try {
    const details = (JSON.parse(body) as { error?: { details?: Array<{ fieldViolations?: Array<{ field?: unknown }> }> } })?.error?.details;
    return Array.isArray(details) && details.some((detail) => Array.isArray(detail?.fieldViolations)
      && detail.fieldViolations.some((violation) => typeof violation?.field === "string"
        && /(?:function_response|functionResponse)\.parts/.test(violation.field)));
  } catch {
    return false;
  }
}

/**
 * Resolve the model and preserve the complete authoritative prompt. Historical
 * excerpts are selected only after each provider has built its actual tools.
 */
function prepareContext(
  backend: ByokBackend,
  req: RunnerRequest,
  events: RunnerEvents,
  schemaInPrompt = false,
): { model: string; recent: RunnerRequest["history"]; system: string } {
  assertScienceRecoveryRequest(req, "byok", backend);
  const model = resolveModel(backend, req);
  if (!model) {
    throw new Error(
      req.locale === "ko"
        ? "사용할 모델 ID가 없습니다. 설정에서 실시간 모델을 선택하거나 모델 ID를 직접 입력하세요."
        : "No model ID is selected. Choose a live model or enter a model ID in Settings.",
    );
  }
  const recent = req.history;
  // 서피스 게이트는 러너 공통 규칙(runner.ts cumulativeSurfaceGateText)을 따른다.
  const surfaceGateText = cumulativeSurfaceGateText(recent, req.surfaceUserPrompt ?? req.userPrompt);
  // The Anthropic Messages and Gemini paths build no response schema; the shape goes in the prompt and the status says so
  // (RunnerRequest.outputSchema contract). The OpenAI-compatible path enforces it with response_format instead.
  const schemaFallback = schemaInPrompt && req.outputSchema ? schemaFallbackInstruction(req.outputSchema.schema) : "";
  if (schemaFallback) events.onStatus(tStatus(req.locale, "schemaInPromptOnly"));
  return {
    model,
    recent,
    system: req.minimalObservation ? observationSystemWithSchema(req.systemPrompt, schemaInPrompt ? req.outputSchema?.schema : undefined) : wrapSystemPrompt(
      req.systemPrompt,
      req.locale,
      req.permission,
      surfaceGateText,
      req.forceSurface,
      req.restrictedReadBoundary,
      req.untrustedNoTools,
      undefined,
      undefined,
      undefined,
      req.surfaceGate,
      undefined,
      req.sciencePromptProfile,
      req.judgmentOnly === true ? "host-judgment" : undefined,
      schemaInPrompt && req.outputSchema ? [schemaFallbackPromptPart(req.outputSchema.schema)] : undefined,
      req.systemPromptComposition,
      req.unattendedNoAsk,
    ),
  };
}

/*
 * ★2026-09-23 — 모르는 모델(사용자 지정·OpenRouter·새 id)의 용량을 16k 로 두고, UTF-8 바이트를
 *   토큰으로 세고(1바이트=1토큰), 출력 예약 8192 를 빼니 ~17.5KB 시스템 프롬프트만으로 넘쳤다.
 *   요청을 한 번도 보내지 않고 model_context_capacity_exceeded 로 거절했다. 용량을 모른다는 건
 *   넘친다는 증거가 아니다. 모르면 카탈로그 기본값(UNKNOWN_CONTEXT_WINDOW)으로 이전 대화만
 *   접고, 미리 거절하지 않는다 — 클라우드 제공자는 넘치면 명시적으로 거절하므로 그 답을 전한다.
 */
export function byokContextCapacity(backend: ByokBackend, model: string, req: RunnerRequest, events: RunnerEvents) {
  const resolved = resolveEffectiveContextWindow(backend, model, !!req.longContext);
  // An unknown window is background knowledge (the catalog default applies); nothing is shown to the user.
  void events;
  return {
    window: resolved.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
    source: resolved.source,
    known: resolved.source !== "unknown",
  };
}

/** Re-evaluate the complete outgoing provider body on every tool turn. The
 * callback replaces only the initial chat-history segment; later tool
 * call/result pairs, current request, system and schemas remain untouched. */
export function byokHistoryAdmission(input: {
  req: RunnerRequest;
  events: RunnerEvents;
  window: number;
  /** false: the window is a default, not evidence. Compact history, but never pre-refuse. */
  capacityKnown: boolean;
  outputReserve: number;
  budgetState: { value: number };
  outgoingBody: () => unknown;
  replaceHistory: (recent: RunnerRequest["history"], digest: string) => void;
}): boolean {
  let estimate = estimateTransportTokens(JSON.stringify(input.outgoingBody()));
  let historyBudget = input.budgetState.value;
  for (let attempt = 0; attempt < 8 && estimate + input.outputReserve > input.window && input.req.history.length > 0; attempt += 1) {
    historyBudget = Math.max(0, historyBudget - (estimate + input.outputReserve - input.window) - Math.ceil(input.window * 0.02));
    input.budgetState.value = historyBudget;
    const compacted = compactHistoryToBudget(input.req.history, { historyBudgetTokens: historyBudget, locale: input.req.locale });
    if (!compacted.fits || !compacted.digest) break;
    input.replaceHistory(compacted.recent, compacted.digest);
    estimate = estimateTransportTokens(JSON.stringify(input.outgoingBody()));
  }
  return estimate + input.outputReserve <= input.window || !input.capacityKnown;
}

// ── SSE 라인 파서 (3개 API 공통) ──────────────────────────
async function* iterSseLines(
  resp: Response,
): AsyncGenerator<string, void, unknown> {
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

// ── Anthropic Messages ────────────────────────────────────
type CacheControl = { cache_control?: { type: "ephemeral" } };
type AnthropicContent =
  | ({ type: "text"; text: string } & CacheControl)
  | ({
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    } & CacheControl)
  // 도구 왕복 — 어시스턴트가 tool_use 를 내면 우리가 실행하고 tool_result 로 답한다.
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; is_error?: boolean;
      // Anthropic tool_result content: a string, or text + image blocks (a host screenshot the model must see).
      content: string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }> }
  // Opaque continuation blocks: the provider requires them back unchanged (signature included) before the tool_use they precede.
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContent[] };

/**
 * Gemini generateContent caches implicitly (2.5+). Explicit cachedContents is the owner's opt-in (gemini-explicit-cache.ts);
 * the plan records the stable-prefix digest (systemInstruction + tools) and, when used, whether the cache was created or
 * reused — otherwise why not.
 */
function geminiCachePlan(body: { systemInstruction?: unknown; tools?: unknown; contents: unknown[] }, explicit?: EnsureOutcome): CachePlan {
  const segments: CacheSegment[] = [];
  if (body.tools) segments.push(segmentOf("tools", "S0", "stable-prefix", JSON.stringify(body.tools)));
  segments.push(segmentOf("system", "S1", "stable-prefix", JSON.stringify(body.systemInstruction ?? "")));
  const last = body.contents.length - 1;
  if (last >= 1) segments.push({ id: "history", layer: "S4", cacheClass: "append-only", bytes: JSON.stringify(body.contents.slice(0, last)).length });
  if (last >= 0) segments.push({ id: "owner-input", layer: "S5", cacheClass: "volatile-tail", bytes: JSON.stringify(body.contents[last]).length });
  const plan = planCache({ capability: cacheCapabilityFor({ family: "gemini" }), segments });
  if (!explicit) return plan;
  if (explicit.status === "skipped") return explicit.reason === "gemini_explicit_off" ? plan : { ...plan, lossReasons: [...plan.lossReasons, explicit.reason] };
  return { ...plan, lossReasons: plan.lossReasons.filter((reason) => reason !== "gemini_implicit_only"), geminiExplicit: explicit.status };
}

/**
 * Anthropic wire body parts with the cache plan applied (cache-planner.ts is the only place that decides placement).
 *
 * Segments in render order (tools -> system -> messages):
 *   tools (S0) + system (S1)  stable-prefix  -> one breakpoint at the end of the run (the system block)
 *   history (S4)              append-only    -> the turn boundary: messages[0..n-2], marker on message n-2's last block
 *   tool-result (S4)          append-only    -> mid tool loop the newest tool_result (next step reads it from cache)
 *   owner-input (S5)          volatile-tail  -> the final message when it is this turn's user input: never cached
 * Compatible third-party endpoints get no markers (they cache server-side and may reject the field).
 */
function anthropicCachePlan(input: { native: boolean; model: string; system: string; tools: unknown[]; messages: AnthropicMessage[] }): {
  plan: CachePlan; messageIndexBySegment: Record<string, number>;
} {
  const { messages } = input;
  const segments: CacheSegment[] = [];
  const messageIndexBySegment: Record<string, number> = {};
  if (input.tools.length > 0) segments.push(segmentOf("tools", "S0", "stable-prefix", JSON.stringify(input.tools)));
  segments.push(segmentOf("system", "S1", "stable-prefix", input.system));
  const lastIndex = messages.length - 1;
  if (lastIndex >= 1) {
    messageIndexBySegment.history = lastIndex - 1;
    segments.push({ id: "history", layer: "S4", cacheClass: "append-only", bytes: JSON.stringify(messages.slice(0, lastIndex)).length });
  }
  if (lastIndex >= 0) {
    const last = messages[lastIndex];
    const carriesToolResult = Array.isArray(last.content) && last.content.some((block) => block.type === "tool_result");
    messageIndexBySegment[carriesToolResult ? "tool-result" : "owner-input"] = lastIndex;
    segments.push({ id: carriesToolResult ? "tool-result" : "owner-input", layer: carriesToolResult ? "S4" : "S5",
      cacheClass: carriesToolResult ? "append-only" : "volatile-tail", bytes: JSON.stringify(last).length });
  }
  const plan = planCache({ capability: cacheCapabilityFor({ family: "anthropic", model: input.model, native: input.native }), segments, model: input.model });
  return { plan, messageIndexBySegment };
}

function anthropicWire(input: { native: boolean; model: string; system: string; tools: unknown[]; messages: AnthropicMessage[] }): {
  system: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>; messages: AnthropicMessage[]; plan: CachePlan;
} {
  const { plan, messageIndexBySegment } = anthropicCachePlan(input);
  if (!input.native) return { system: input.system, messages: input.messages, plan };
  // Prompt caching: only real Anthropic honors `cache_control`; below the per-model minimum Anthropic silently skips it.
  const marked = plan.anthropicBreakpoints.some((point) => point.segmentId === "system");
  return {
    system: [{ type: "text", text: input.system, ...(marked ? { cache_control: { type: "ephemeral" as const } } : {}) }],
    messages: applyPlannedMessageBreakpoints(input.messages as never, plan, messageIndexBySegment) as AnthropicMessage[],
    plan,
  };
}

/**
 * Anthropic Messages API(및 그 호환 서드파티 엔드포인트) 공통 호출.
 * base URL과 인증 헤더만 프로바이더마다 다르고 나머지 와이어 포맷은 동일하다.
 */
async function runAnthropicMessages(
  backend: ByokBackend,
  baseUrl: string,
  authHeaders: Record<string, string>,
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> {
  // The size of the turn's LAST model request feeds the generation rule (session-generation.ts).
  const sink: { value?: number } = {};
  const result = await runAnthropicMessagesInner(backend, baseUrl, authHeaders, req, events, sink);
  return sink.value !== undefined && result.contextInputTokens === undefined ? { ...result, contextInputTokens: sink.value } : result;
}

/** Gemini BadRequest: true only when a structured field violation points at the tools / function declarations. */
export function geminiToolDeclarationRejected(body: string): boolean {
  try {
    const details = (JSON.parse(body) as { error?: { details?: Array<{ fieldViolations?: Array<{ field?: unknown }> }> } })?.error?.details;
    return Array.isArray(details) && details.some((detail) => Array.isArray(detail?.fieldViolations)
      && detail.fieldViolations.some((violation) => typeof violation?.field === "string" && /^tools(\[|\.|$)/.test(violation.field)));
  } catch {
    return false;
  }
}

/** The conversation's generation for a BYOK loop (stateless-generation.ts, native-harness notyet NH10). */
function byokGenerations(req: RunnerRequest, model: string) {
  return openStatelessGeneration({ runtime: "byok", chatId: req.chatId, ownerId: req.runtimeSessionOwnerId ?? req.agentId ?? null,
    model, history: req.history, locale: req.locale, agentId: req.agentId ?? null });
}

/** The window the rotation rule may read: a catalog/built-in number is evidence, the unknown default is not. */
function byokGenerationWindow(capacity: { window: number; source: "built-in" | "catalog" | "unknown"; known: boolean }) {
  return { tokens: capacity.window, source: capacity.source as StatelessWindowSource, known: capacity.known };
}

async function runAnthropicMessagesInner(
  backend: ByokBackend,
  baseUrl: string,
  authHeaders: Record<string, string>,
  req: RunnerRequest,
  events: RunnerEvents,
  sink: { value?: number },
): Promise<RunnerResult> {
  const noModel = byokNoModel(backend, req);
  if (noModel) return noModel;
  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const { model, recent, system } = prepareContext(backend, req, events, true);

  const messages: AnthropicMessage[] = [];
  const historyMessage = (m: RunnerRequest["history"][number]): AnthropicMessage => {
    const images = ownerControlHistoryImages(m);
    return { role: m.role as "user" | "assistant", content: images.length ? [
      ...images.map((image): AnthropicContent => ({ type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.data } })),
      { type: "text", text: m.text },
    ] : m.text };
  };
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") messages.push(historyMessage(m));
  }

  // 마지막 user 메시지는 image가 있으면 content array
  if (req.images && req.images.length > 0) {
    const content: AnthropicContent[] = req.images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
    }));
    content.push({ type: "text", text: req.userPrompt });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: req.userPrompt });
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...authHeaders,
  };
  // 1M 컨텍스트: beta-header 모델 + 사용자 토글 ON일 때만 베타 헤더 전송 (default OFF라 안전).
  if (req.longContext && needsLongContextToggle(backend, model)) {
    headers["anthropic-beta"] = ANTHROPIC_1M_BETA;
  }

  /*
   * ★도구 — 이 러너에는 도구 루프가 아예 없었다(파일 전체에 "tool" 문자열 0회).
   *
   * BYOK 는 벤더 CLI 가 없으므로 도구를 빌려올 곳이 없다. 그래서 사용자가 쓰기 권한을
   * 주고 작업 폴더를 골라도 모델은 코드를 답변에 적어 줄 뿐 파일 하나 만들지 못했다 —
   * `workforceZeroToolsEnforcement(… ["filesystem","shell",…])` 가 그 사실을 정확히
   * 선언하고 있었지만, 선언은 능력이 아니다. 내장 도구(shared/builtin-tools.ts)를
   * 쥐여 주고, 승인·실행은 로컬 루프와 **같은 관문 한 벌**을 쓴다.
   *
   * 무도구 격리 실행(Agent App)은 도구를 받지 않는다 — 그 계약이 이 런타임의 존재 이유다.
   */
  // Tool inventory preparation precedes every provider request: its refusal is a refusal before dispatch (docs 31 W1).
  const { tools, byName, broker, approval } = await prepareMainToolLoop(req, "byok").catch((error: unknown) => { throw markRefusedBeforeDispatch(error); });
  const toolsEnabled = tools.length > 0;
  const anthropicTools = tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters,
  }));
  const capacity = byokContextCapacity(backend, model, req, events);
  const outputLimit = req.maxOutputTokens ?? Math.min(8_192, Math.floor(capacity.window / 4));
  // Effort (A4 C6.3): Anthropic's output_config.effort, only at a level the model's own Models API capability lists.
  // Anthropic-compatible third parties document no effort field, so they get none and the ledger says so.
  let outputEffort: string | null = null;
  let effortApplication: ModelEffortApplication = req.effort
    ? { status: "unsupported", requested: req.effort, reason: backend === "anthropic" ? "model_capability_unavailable" : "endpoint_family_has_no_effort_control" }
    : { status: "not_requested" };
  if (req.effort && backend === "anthropic") {
    const levels = await anthropicEffortLevels(baseUrl, headers, model, req.signal);
    const picked = levels && levels.size > 0 ? pickSupportedEffort(req.effort, levels) : null;
    if (picked) {
      outputEffort = picked;
      effortApplication = { status: "applied", applied: picked, requested: req.effort, wire: "output_config.effort" };
    } else if (levels) effortApplication = { status: "unsupported", requested: req.effort, reason: levels.size === 0 ? "model_has_no_effort_control" : "effort_value_not_supported" };
  }
  let transmittedHistoryCount = req.history.filter((row) => row.role === "user" || row.role === "assistant").length;
  const historyBudgetState = { value: req.history.reduce((sum, row) => sum + estimateTransportTokens(row.text) + 12, 0) };
  // The conversation's "session" (stateless-generation.ts): the handoff it installed, a new one at a settled boundary when
  // a request's input reaches 80% of the window, acknowledged by the next complete response. Silent.
  const generations = byokGenerations(req, model);
  const installGeneration = (digest: string, rows: RunnerRequest["history"]): void => {
    const next = rows.filter((row) => row.role === "user" || row.role === "assistant").map(historyMessage);
    if (next[0]?.role === "user" && typeof next[0].content === "string") next[0] = { role: "user", content: `${digest}\n\n${next[0].content}` };
    else next.unshift({ role: "user", content: digest });
    messages.splice(0, transmittedHistoryCount, ...next);
    transmittedHistoryCount = next.length;
    historyBudgetState.value = statelessHistoryTokens(digest, rows);
  };
  if (generations.seed) installGeneration(generations.seed.digest, generations.seed.rows);
  let lastRequestTokens: number | null = null, lastObservedInput: number | null = null;

  let acc = "";
  let lastEmit = 0;
  /** Consecutive replies cut by the output cap (continued on the same conversation, never a failed turn). */
  let outputCuts = 0;
  // 계측(2026-08-18): 이 러너는 cache_control을 보내면서도 응답 usage를 한 번도 읽지
  // 않았다 — 캐시가 먹는지 제품 안에서 확인할 방법이 없어 회귀가 보이지 않았다.
  // message_start가 입력/캐시 계열을, message_delta가 누적 출력을 싣는다.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const measuredUsage = createToolLoopUsage(events);
  const progress = createToolLoopProgress("byok", req, events);
  let reachedAnswer = false;

  // ★도구 왕복. 모델이 tool_use 로 멈추면 실행하고 tool_result 로 답한 뒤 다시 부른다.
  // 상한을 두는 이유는 로컬/저가 모델이 같은 도구를 무한 반복하는 실측 때문이다.
  let toolTurnsTaken = 0;
  /** Tool calls the host ran in this turn: settleNormalEnd evidence (R-065). */
  let toolCallsRun = 0;
  /** G24: resends spent on an overloaded endpoint before anything streamed or ran in this invocation (provider-overload.ts). */
  let serverResends = 0;
  const ownerControl = createOwnerControlBoundary(req);
  try {
  for (let turn = 0; turn < MAX_BYOK_TOOL_TURNS; turn += 1) {
    if (req.signal?.aborted) throw abortReasonError(req);
    if (turn > 0) {
      const batch = ownerControl.take();
      // Keep tool_result blocks together before appending ordinary user text.
      for (const entry of batch) messages.push({ role: "user", content: entry.text });
    }
    const outgoingWire = () => anthropicWire({ native: backend === "anthropic", model, system, tools: anthropicTools, messages });
    const outgoingBody = () => { const wire = outgoingWire(); return { model, max_tokens: outputLimit, stream: true, system: wire.system,
      messages: wire.messages, ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...(outputEffort ? { output_config: { effort: outputEffort } } : {}) }; };
    // Rotation at this settled boundary (turn start, or after a tool step whose results are all in): the request's INPUT
    // against 80% of the window. Input + output reserve is admission, checked next, and never records a generation.
    const rotation = await generations.boundary({ boundary: turn === 0 ? "turn-start" : "tool-step", step: turn,
      window: byokGenerationWindow(capacity), requestTokens: estimateTransportTokens(JSON.stringify(outgoingBody())),
      historyTokens: historyBudgetState.value, observedLastInput: lastObservedInput, lastRequestTokens });
    if (rotation.action === "rotated") installGeneration(rotation.digest, rotation.rows);
    // In-turn compaction of earlier tool results (foldByokToolResults). Never when this turn carries thinking blocks:
    // Anthropic invalidates thinking after an edited earlier block (preserved thinking), so the transcript stays append-only
    // there and a full window remains the typed capacity refusal below.
    const turnHasThinking = messages.some((message) => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking"));
    if (turn > 0 && !turnHasThinking && capacity.known) {
      const target = Math.min(Math.floor(capacity.window * GENERATION_CONTEXT_RATIO), capacity.window - outputLimit);
      const resultMessages = messages.filter((message) => message.role === "user" && Array.isArray(message.content)
        && message.content.some((block) => block.type === "tool_result"));
      const slots = resultMessages.slice(0, -1).flatMap((message) => (message.content as AnthropicContent[])
        .filter((block): block is Extract<AnthropicContent, { type: "tool_result" }> & { content: string } => block.type === "tool_result" && typeof block.content === "string")
        .map((block) => ({ get: () => block.content, set: (value: string) => { block.content = value; } })));
      if (slots.length) {
        foldByokToolResults(slots, () => estimateTransportTokens(JSON.stringify(outgoingBody())) <= target, byName, approval);
      }
    }
    if (!byokHistoryAdmission({ req, events, window: capacity.window, capacityKnown: capacity.known, outputReserve: outputLimit,
      budgetState: historyBudgetState,
      outgoingBody,
      replaceHistory: (recent, digest) => {
        const next = recent.filter((row) => row.role === "user" || row.role === "assistant")
          .map((row) => ({ role: row.role, content: row.text } as AnthropicMessage));
        if (next[0]?.role === "user" && typeof next[0].content === "string") {
          next[0] = { role: "user", content: `${digest}\n\n${next[0].content}` };
        } else {
          next.unshift({ role: "user", content: digest });
        }
        messages.splice(0, transmittedHistoryCount, ...next);
        transmittedHistoryCount = next.length;
      },
    })) return assertCurrentHistoryRunnerResult({ text: "", failure: byokContextFailure(req), ...(turn === 0 ? { turnDelivery: "not-dispatched" as const } : {}) });
    assertScienceRecoveryRequest(req, "byok", backend);
    reportModelPayload(() => ledgerFromApiBody(outgoingBody(), { ledgerHints: req.ledgerHints, imageCount: req.images?.length ?? 0 }));
    reportModelEffort(effortApplication);
    const sentRequestTokens = estimateTransportTokens(JSON.stringify(outgoingBody()));
    reportCachePlan(() => outgoingWire().plan);
    reportModelEndpoint({ url: baseUrl });
    const usageAttempt = measuredUsage.start();
    if (req.signal?.aborted) throw abortReasonError(req);
    const endpoint = `${baseUrl}/v1/messages`;
    const originalRequest: RequestInit = {
      method: "POST",
      headers,
      signal: req.signal,
      body: JSON.stringify(outgoingBody()),
    };
    const preparedRequest = await prepareCompressedJsonRequest(endpoint, originalRequest, { network: requestCompressionNetworkState() });
    if (req.signal?.aborted) throw abortReasonError(req);
    const resp = await withCurrentHistoryProvider(() => {
      // Compression yields: refresh the same durable authority at the actual provider boundary.
      if (req.signal?.aborted) throw abortReasonError(req);
      assertScienceRecoveryRequest(req, "byok", backend);
      const networkNow = requestCompressionNetworkState();
      const dispatchRequest = networkNow.ready && !networkNow.proxyConfigured && !networkNow.additionalCaCertificates ? preparedRequest : originalRequest;
      ownerControl.dispatched();
      return fetch(endpoint, dispatchRequest);
    });

    if (!resp.ok) {
      // HTTP 413 is a machine status: the request is over the endpoint's size limit. Typed capacity refusal, never replayed.
      if (resp.status === 413) {
        const observedUsage = measuredUsage.total();
        return assertCurrentHistoryRunnerResult({ text: acc.trim(), failure: byokContextFailure(req), ...(observedUsage ? { observedUsage } : {}),
          workforcePermissionEnforcement: broker?.finish(false) });
      }
      const failure = runtimeHttpFailure(resp.status, "byok", "Anthropic", resp.headers.get("retry-after"));
      if (failure) {
        const observedUsage = measuredUsage.total();
        return assertCurrentHistoryRunnerResult({ text: acc.trim(), failure, ...(observedUsage ? { observedUsage } : {}),
          ...(outputTokens > 0 ? { tokens: outputTokens } : {}), workforcePermissionEnforcement: broker?.finish(false) });
      }
      const errText = await resp.text().catch(() => "");
      // G24: 5xx / 529 is a typed failure; overloaded earns one resend while nothing streamed and no tool ran.
      const serverCode = serverFailureCodeForStatus(resp.status);
      if (serverCode) {
        if (serverFailureResendable(serverCode) && serverResends < SERVER_FAILURE_RESENDS && turn === 0 && toolTurnsTaken === 0
          && !acc && !ownerControl.hasPending() && !req.signal?.aborted) {
          serverResends += 1;
          events.onStatus(req.locale === "ko" ? "모델 서버가 바빠 잠시 뒤 같은 요청을 한 번 더 보냅니다…" : "The model server is busy; sending the same request once more shortly…");
          await waitForServerResend(serverFailureResendDelayMs(resp.headers.get("retry-after")), req.signal);
          if (req.signal?.aborted) throw abortReasonError(req);
          turn -= 1; // the same request again, not a new tool turn
          continue;
        }
        const observedUsage = measuredUsage.total();
        return assertCurrentHistoryRunnerResult({ text: acc.trim(),
          failure: serverFailure({ code: serverCode, status: resp.status, runtime: "byok", providerLabel: "Anthropic", locale: req.locale,
            body: errText, retryAfter: resp.headers.get("retry-after") }),
          ...(observedUsage ? { observedUsage } : {}), workforcePermissionEnforcement: broker?.finish(false) });
      }
      throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 300)}`);
    }

    // 이번 턴에 모인 tool_use 블록. index 로 들어와 조각조각 쌓인다.
    const pendingToolUse = new Map<number, { id: string; name: string; json: string }>();
    /** Where this response's text starts in `acc` (a text-cut reply keeps the earlier pieces in `acc`). */
    const responseStart = acc.length;
    /** Thinking blocks of this response, verbatim (text + signature, or the redacted payload), by content index. */
    const opaqueThinking = new Map<number, { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string }>();
    let stopReason: string | null = null;
    let conflictingStopReason = false;
    let turnInputObserved = false;
    let turnRawInput: number | undefined, turnCacheRead: number | undefined, turnCacheWrite: number | undefined;
    let turnCacheReadObserved = false;
    let turnOutputObserved = false;
    let turnOutputTokens = 0;
    let messageStopped = false;

    for await (const line of iterSseLines(resp)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const event = JSON.parse(payload) as {
          type: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string; thinking?: string; signature?: string; data?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string };
          message?: { usage?: Record<string, number | null | undefined> };
          usage?: Record<string, number | null | undefined>;
        };
        if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          opaqueThinking.set(event.index ?? 0, { type: "thinking", thinking: event.content_block.thinking ?? "", signature: event.content_block.signature ?? "" });
        } else if (event.type === "content_block_start" && event.content_block?.type === "redacted_thinking") {
          opaqueThinking.set(event.index ?? 0, { type: "redacted_thinking", data: event.content_block.data ?? "" });
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
          const block = opaqueThinking.get(event.index ?? 0);
          if (block?.type === "thinking") block.thinking += event.delta.thinking ?? "";
        } else if (event.type === "content_block_delta" && event.delta?.type === "signature_delta") {
          const block = opaqueThinking.get(event.index ?? 0);
          if (block?.type === "thinking") block.signature += event.delta.signature ?? "";
        } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          pendingToolUse.set(event.index ?? 0, {
            id: event.content_block.id ?? "",
            name: event.content_block.name ?? "",
            json: "",
          });
        } else if (event.type === "content_block_delta" && event.delta?.partial_json != null) {
          const entry = pendingToolUse.get(event.index ?? 0);
          if (entry) entry.json += event.delta.partial_json;
        } else if (event.type === "content_block_delta" && event.delta?.text) {
          acc += event.delta.text;
          const now = Date.now();
          if (now - lastEmit > 80) {
            (currentHistoryRuntimeFence()?.assertCurrent(), events.onPartial(acc));
            lastEmit = now;
          }
        } else if (event.type === "message_start" && event.message?.usage) {
          const usage = event.message.usage;
          reportModelEndpoint({ reportedModel: (event.message as { model?: string }).model });
          const count = (value: unknown): number | undefined =>
            typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
          turnRawInput = count(usage.input_tokens);
          turnCacheRead = count(usage.cache_read_input_tokens);
          turnCacheWrite = count(usage.cache_creation_input_tokens);
          turnInputObserved = turnRawInput !== undefined && turnCacheRead !== undefined && turnCacheWrite !== undefined
            && Number.isSafeInteger(turnRawInput + turnCacheRead + turnCacheWrite);
          // ★누적한다. 왕복이 여러 번이면 각 턴의 입력이 전부 실제 비용이다 —
          // 마지막 턴만 싣던 방식은 도구를 쓸수록 영수증이 작아진다.
          turnCacheReadObserved = Number.isSafeInteger(usage.cache_read_input_tokens) && Number(usage.cache_read_input_tokens) >= 0;
          inputTokens += usage.input_tokens ?? 0;
          cacheRead += usage.cache_read_input_tokens ?? 0;
          cacheWrite += usage.cache_creation_input_tokens ?? 0;
        } else if (event.type === "message_delta") {
          // Anthropic reports a cumulative count within each streamed message.
          if (Number.isSafeInteger(event.usage?.output_tokens) && event.usage!.output_tokens! >= 0) {
            turnOutputTokens = event.usage!.output_tokens!;
            turnOutputObserved = true;
          }
          if (typeof event.delta?.stop_reason === "string") {
            if (stopReason !== null && stopReason !== event.delta.stop_reason) conflictingStopReason = true;
            stopReason = event.delta.stop_reason;
          }
        } else if (event.type === "message_stop") {
          messageStopped = true;
        }
      } catch {
        // 빈 줄 또는 ping — 무시
      }
    }
    outputTokens += turnOutputTokens;
    const turnInput = turnInputObserved ? turnRawInput! + turnCacheRead! + turnCacheWrite! : null;
    if (sink) sink.value = turnInput ?? undefined;
    // Anthropic bills raw input, cache reads and cache creation separately; the receipt carries only the total.
    if (turnInputObserved) events.onModelUsageDetail?.(usageAttempt, { cacheCreationInputTokens: turnCacheWrite, rawInputTokens: turnRawInput });
    (measuredUsage.complete(usageAttempt, turnInputObserved && turnOutputObserved && messageStopped
      ? { inputTokens: turnInput!, outputTokens: turnOutputTokens,
          ...(turnCacheReadObserved ? { cachedInputTokens: turnCacheRead } : {}) }
      : undefined), currentHistoryRuntimeFence()?.assertCurrent());

    // Only complete client-tool groups or final answers admit further work.
    // pause_turn and token/context limits are partial responses, not ACKs.
    const toolIds = new Set<string>();
    const completeTools = [...pendingToolUse.values()].every((entry) => {
      if (!entry.id || !entry.name || toolIds.has(entry.id)) return false;
      toolIds.add(entry.id);
      try {
        const args: unknown = entry.json ? JSON.parse(entry.json) : {};
        return !!args && typeof args === "object" && !Array.isArray(args);
      } catch { return false; }
    });
    const completeBoundary = messageStopped && completeTools && !conflictingStopReason
      && ((["end_turn", "stop_sequence"].includes(stopReason ?? "") && pendingToolUse.size === 0)
        || (stopReason === "tool_use" && pendingToolUse.size > 0));
    if (!completeBoundary && stopReason === "max_tokens" && messageStopped && !conflictingStopReason && !req.signal?.aborted
      && outputCuts < OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS) {
      // Cut by the output cap: a partial reply, not a failed turn. A tool_use block cut mid-arguments is never run.
      // Keep the text, put it back as an assistant turn and add one host turn; the next reply continues it.
      outputCuts += 1;
      const piece = acc.slice(responseStart);
      const toolCut = pendingToolUse.size > 0;
      if (piece.trim()) messages.push({ role: "assistant", content: [{ type: "text", text: piece }] });
      messages.push({ role: "user", content: outputLimitContinuationTurn(toolCut ? "tool-call" : "text") });
      // A cut tool step's preface is not the answer; a cut text answer stays in `acc` and the next pieces append to it.
      if (toolCut) acc = acc.slice(0, responseStart);
      continue;
    }
    if (!completeBoundary) {
      const error = new RuntimeTurnUnsettledError("byok", req.locale);
      // The provider's own structured stop reason: the context window ran out. Same typed refusal as a pre-send overflow.
      if (stopReason === "model_context_window_exceeded" && messageStopped) {
        return assertCurrentHistoryRunnerResult({ text: acc.trim(), ownerControlTerminal: "uncertain", failure: byokContextFailure(req),
          workforcePermissionEnforcement: broker?.finish(false) });
      }
      return assertCurrentHistoryRunnerResult({ text: acc.trim() || error.message, ownerControlTerminal: "uncertain",
        failure: stopReason === "refusal"
          ? { ...byokFailure("refused", acc.trim() || "Anthropic refused the request."), providerCode: "refusal" }
          : { ...byokFailure("exit", error.message), providerCode: error.code },
        workforcePermissionEnforcement: broker?.finish(false) });
    }
    if (req.signal?.aborted) throw abortReasonError(req);
    ownerControl.applied();
    generations.completed(turn, turnInput !== null && turnInput > 0 ? turnInput : null);
    lastObservedInput = turnInput !== null && turnInput > 0 ? turnInput : null;
    lastRequestTokens = sentRequestTokens;

    if (req.scienceCollectionCapability && stopReason === "tool_use" && pendingToolUse.size === 0) {
      throw new Error("science_collection_tool_frame_invalid");
    }
    outputCuts = 0;
    if (stopReason !== "tool_use" || pendingToolUse.size === 0) {
      reachedAnswer = true;
      break;
    }

    const orderedToolUse = [...pendingToolUse.entries()].sort((a, b) => a[0] - b[0]);
    if (req.scienceCollectionCapability && orderedToolUse.some(([, entry]) => !entry.id || !entry.name)) {
      throw new Error("science_collection_tool_frame_invalid");
    }
    if (req.scienceCollectionCapability) {
      const ids = new Set<string>();
      for (const [, entry] of orderedToolUse) {
        if (ids.has(entry.id)) throw new Error("science_collection_tool_frame_invalid");
        ids.add(entry.id);
        try {
          const args: unknown = entry.json ? JSON.parse(entry.json) : {};
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            throw new Error("science_collection_tool_frame_invalid");
          }
        } catch {
          throw new Error("science_collection_tool_frame_invalid");
        }
      }
    }
    toolTurnsTaken += 1;
    toolCallsRun += orderedToolUse.length;
    // 어시스턴트 턴을 그대로 되돌려 넣는다(텍스트 + tool_use). 그래야 다음 호출에서
    // tool_result 가 짝을 찾는다.
    const assistantContent: AnthropicContent[] = [];
    // Thinking blocks first, byte-for-byte as received: a tool_use turn is rejected when its thinking/signature is altered or dropped.
    for (const [, block] of [...opaqueThinking.entries()].sort((a, b) => a[0] - b[0])) assistantContent.push({ ...block });
    if (acc.slice(responseStart).trim()) assistantContent.push({ type: "text", text: acc.slice(responseStart) });
    const resultContent: AnthropicContent[] = [];
    for (const [, entry] of orderedToolUse) {
      let input: Record<string, unknown> = {};
      try {
        input = entry.json ? (JSON.parse(entry.json) as Record<string, unknown>) : {};
      } catch {
        if (req.scienceCollectionCapability) throw new Error("science_collection_tool_frame_invalid");
        input = {};
      }
      assistantContent.push({ type: "tool_use", id: entry.id, name: entry.name, input });
      assertScienceRecoveryRequest(req, "byok", backend);
      const outcome = await runOneToolCall(
        byName,
        { id: entry.id, type: "function", function: { name: entry.name, arguments: entry.json } },
        progress.events,
        approval,
        broker,
      );
      progress.assertProgress();
      // A host screenshot goes back inside its own tool_result as Anthropic image blocks (A4 C7.3); compatible
      // third-party endpoints keep the text form they document.
      const images = backend === "anthropic" ? toolResultImages(outcome) : [];
      resultContent.push({
        type: "tool_result",
        tool_use_id: entry.id,
        content: images.length
          ? [{ type: "text", text: outcome.toolMessage.content },
            ...images.map((image) => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.data } }))]
          : outcome.toolMessage.content,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "assistant", content: assistantContent });
    messages.push({ role: "user", content: resultContent });
    // 다음 턴의 본문은 새로 쌓는다 — 이전 턴 텍스트는 이미 히스토리에 들어갔다.
    acc = "";
  }
  // 캐시 읽기/쓰기는 단가가 다르지만 영수증 칸은 입력 하나뿐이다. 모델이 실제로 본
  // 문맥 크기를 싣는다(claude-code 러너와 같은 규칙). 히트율 자체는 아래 status로 남긴다.
  const totalInput = inputTokens + cacheRead + cacheWrite;
  if (totalInput > 0) {
    const hitRate = Math.round((cacheRead / totalInput) * 100);
    events.onStatus(
      `[cache] read=${cacheRead} write=${cacheWrite} fresh=${inputTokens} hit=${hitRate}%`,
    );
  }
  const answer = acc.trim();
  let failure: RunnerFailure | null = null;
  // The model's own final stop is a normal end, settled by the shared rule (R-065): a tool-only turn completed.
  const normalEnd = reachedAnswer ? settleNormalEnd({ text: answer, toolCalls: toolCallsRun }) : null;
  if (!reachedAnswer) {
    failure = byokFailure("exit", `BYOK tool loop did not reach a final answer after ${toolTurnsTaken} tool turns.`);
  } else if (normalEnd?.outcome === "empty") {
    failure = { ...byokFailure("empty", `BYOK returned an empty answer for ${model}.`), providerCode: EMPTY_NO_TOOL_RAN_CODE };
  } else if (answer) {
    const refusal = detectRuntimeRefusal(answer);
    if (refusal) failure = { ...refusal, runtime: "byok", source: "heuristic" };
  }
  const observedUsage = measuredUsage.total();
  return assertCurrentHistoryRunnerResult({
    text: answer || (failure ? failure.message : ""),
    ownerControlTerminal: failure ? "uncertain" : "completed",
    ...(failure ? { failure } : {}),
    ...(!failure && normalEnd ? normalEndToolEvidence(normalEnd) : {}),
    ...(observedUsage ? { observedUsage } : {}),
    ...(outputTokens > 0 ? { tokens: outputTokens } : {}),
    /*
     * ★"이 실행에서 무엇이 꺼져 있는가"는 실제 능력을 따라야 한다.
     *
     * 예전엔 무조건 filesystem·shell 까지 꺼진 것으로 선언했다 — 그때는 참이었다
     * (도구가 0개였으니까). 내장 도구가 붙은 지금 그 선언을 그대로 두면 영수증이
     * 거짓말을 한다. 붙지 않은 것(browser·mcp·apps·세션 지속)만 남기고, 파일은
     * 항상, 셸은 full 권한에서만 살아 있다고 말한다.
     */
    workforcePermissionEnforcement: failure
      ? broker?.finish(false)
      : broker
        ? broker.finish(true)
        : workforceZeroToolsEnforcement(
            req,
            "byok",
            toolsEnabled
              ? [
                  ...((req.permission ?? "read") === "full" ? [] : ["shell"]),
                  ...((req.permission ?? "read") === "read" ? ["filesystem_write"] : []),
                  "browser",
                  "mcp",
                  "apps",
                  "session_persistence",
                ]
              : ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
          ),
  });
  } finally { ownerControl.finish(); }
}

/** 테스트 전용 진입점 — 와이어 형상(캐시 브레이크포인트·usage 계측) 검증에만 쓴다. */
export const __testRunAnthropicMessages = runAnthropicMessages;

export const runAnthropicByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  assertScienceRecoveryRequest(req, "byok", "anthropic");
  const key = await readKeyBeforeDispatch("anthropic");
  if (!key) return byokCredentialMissing(tStatus(req.locale, "errKeyMissingAnthropic"));
  return runAnthropicMessages("anthropic", "https://api.anthropic.com", { "x-api-key": key }, req, events);
};

/**
 * Anthropic 호환 서드파티(GLM/Kimi/DeepSeek) 러너 팩토리.
 * 프리셋 base URL로 Messages API를 그대로 호출한다 — 사용자는 키만 저장하면 base URL은 자동.
 * 인증 헤더는 프로바이더마다 x-api-key 또는 Authorization: Bearer 를 쓰므로 둘 다 보낸다
 * (대개 한쪽만 인식하고 나머지는 무시하므로 안전).
 */
function makeAnthropicCompatByok(backend: ByokBackend): Runner {
  return async (req, events) => {
    assertScienceRecoveryRequest(req, "byok", backend);
    const preset = anthropicCompatProvider(backend);
    if (!preset) throw markRefusedBeforeDispatch(new Error(`Unknown Anthropic-compatible backend: ${backend}`));
    const key = await readKeyBeforeDispatch(backend);
    if (!key) {
      return byokCredentialMissing(
        req.locale === "ko"
          ? `${preset.label} API 키가 없습니다. 설정에서 키를 저장하세요.`
          : `Missing ${preset.label} API key. Save it in Settings.`,
      );
    }
    return runAnthropicMessages(
      backend,
      preset.baseUrl,
      { "x-api-key": key, authorization: `Bearer ${key}` },
      req,
      events,
    );
  };
}

export const runGlmByok: Runner = makeAnthropicCompatByok("glm");

// ── OpenAI Chat Completions ──────────────────────────────
function openAiMessages(
  recent: RunnerRequest["history"],
  system: string,
  req: RunnerRequest,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const message of recent) {
    if (message.role === "user") {
      const images = ownerControlHistoryImages(message);
      messages.push({ role: "user", content: images.length ? [
        ...images.map((image): LocalChatContent => ({ type: "image_url",
          image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
        { type: "text", text: message.text },
      ] : message.text });
    } else if (message.role === "assistant") messages.push({ role: "assistant", content: message.text });
  }
  if (req.images && req.images.length > 0) {
    const content: LocalChatContent[] = req.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    }));
    content.push({ type: "text", text: req.userPrompt });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: req.userPrompt });
  }
  return messages;
}

/**
 * The provider owns its endpoint and authentication header. Main owns the
 * admitted inventory, approval gate, actual dispatch, and broker receipt in
 * runLocalOpenAiChat; every OpenAI-compatible BYOK provider uses that loop.
 */
async function runOpenAiCompletionWithMainToolLoop(
  backend: ByokBackend,
  baseUrl: string,
  providerLabel: string,
  key: string,
  req: RunnerRequest,
  events: RunnerEvents,
  beforeProviderCall?: () => Promise<void>,
): Promise<RunnerResult> {
  const noModel = byokNoModel(backend, req);
  if (noModel) return noModel;
  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  const { model, recent, system } = prepareContext(backend, req, events);
  const capacity = byokContextCapacity(backend, model, req, events);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  reportModelEndpoint({ url: endpoint });
  // DeepSeek may speak its stateless Responses wire when the owner chose it (byok-wire.ts); Chat Completions otherwise.
  const wire = backend === "deepseek" ? await readByokWire("deepseek").catch(() => "chat" as const) : "chat";
  return runLocalOpenAiChat(
    {
      req,
      events,
      runtimeKind: "byok",
      renderOutputSchemaSystem: () => ({ system: prepareContext(backend, req, events, true).system }),
      recoveryBackend: backend,
      // OpenAI's chat models read images; the other OpenAI-compatible providers may serve a text-only model.
      ...(backend === "openai" ? { acceptsImageResults: true } : {}),
      ...(wire === "responses" ? { responsesWire: "deepseek" as const } : {}),
      host: baseUrl.replace(/\/$/, ""),
      chatEndpoint: endpoint,
      headers: { authorization: `Bearer ${key}` },
      providerLabel,
      model,
      estimatedContextWindow: capacity.window,
      capacitySource: capacity.source,
      estimatedOutputReserve: req.maxOutputTokens ?? Math.min(8_192, Math.floor(capacity.window / 4)),
      // A cloud provider refuses an oversized request explicitly; an unknown window is not a reason to refuse first.
      ...(capacity.known ? {} : { unknownCapacityProviderEnforced: true as const }),
      unreachableMessage: `${providerLabel} API unreachable`,
      ...(beforeProviderCall ? { beforeProviderCall } : {}),
    },
    openAiMessages(recent, system, req),
  );
}

async function runOpenAICompatible(
  backend: ByokBackend,
  baseUrl: string,
  providerLabel: string,
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> {
  assertScienceRecoveryRequest(req, "byok", backend);
  const key = await readKeyBeforeDispatch(backend);
  if (!key) {
    return byokCredentialMissing(
      req.locale === "ko"
        ? `${providerLabel} API 키가 없습니다. 설정에서 키를 저장하세요.`
        : `Missing ${providerLabel} API key. Save it in Settings.`,
    );
  }

  return runOpenAiCompletionWithMainToolLoop(backend, baseUrl, providerLabel, key, req, events);
}

function makeOpenAICompatibleByok(
  backend: ByokBackend,
  baseUrl: string,
  providerLabel: string,
): Runner {
  return (req, events) => runOpenAICompatible(backend, baseUrl, providerLabel, req, events);
}

export const runKimiByok: Runner = makeOpenAICompatibleByok(
  "kimi",
  "https://api.moonshot.ai/v1",
  "Kimi",
);
export const runDeepseekByok: Runner = makeOpenAICompatibleByok(
  "deepseek",
  "https://api.deepseek.com",
  "DeepSeek",
);
export const runMinimaxByok: Runner = makeOpenAICompatibleByok(
  "minimax",
  "https://api.minimax.io/v1",
  "MiniMax",
);
export const runXaiByok: Runner = makeOpenAICompatibleByok(
  "xai",
  "https://api.x.ai/v1",
  "xAI",
);
export const runOpenRouterByok: Runner = makeOpenAICompatibleByok(
  "openrouter",
  "https://openrouter.ai/api/v1",
  "OpenRouter",
);

export const runOpenAIByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  assertScienceRecoveryRequest(req, "byok", "openai");
  const key = await readKeyBeforeDispatch("openai");
  if (!key) return byokCredentialMissing(tStatus(req.locale, "errKeyMissingOpenAI"));
  return runOpenAiCompletionWithMainToolLoop(
    "openai", "https://api.openai.com/v1", "OpenAI", key, req, events,
  );
};

// ── Upstage Solar (OpenAI-compatible; Korean sovereign LLM) ──────
export const runUpstageByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  assertScienceRecoveryRequest(req, "byok", "upstage");
  const key = await readKeyBeforeDispatch("upstage");
  if (!key) return byokCredentialMissing("Upstage Solar API key missing (Settings → BYOK)");
  return runOpenAiCompletionWithMainToolLoop(
    "upstage", "https://api.upstage.ai/v1", "Upstage", key, req, events,
  );
};

import { getDb } from "../store/db";

// ── Custom OpenAI-compatible ─────────────────────────────
export const runCustomByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  assertScienceRecoveryRequest(req, "byok", "custom");
  let baseUrl = "https://api.openai.com/v1";
  try {
    const row = getDb().prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get() as { value: string } | undefined;
    if (row?.value) {
      baseUrl = row.value.trim().replace(/\/$/, "");
    }
  } catch {}
  const key = await readKeyBeforeDispatch("custom");
  if (!key) return byokCredentialMissing("Custom API key missing (Settings → BYOK)");
  return runOpenAiCompletionWithMainToolLoop("custom", baseUrl, "Custom", key, req, events);
};

// ── Google Generative (Gemini) ───────────────────────────
// SSE는 :streamGenerateContent?alt=sse 엔드포인트.
export const runGoogleByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  assertScienceRecoveryRequest(req, "byok", "google");
  const key = await readKeyBeforeDispatch("google");
  if (!key) return byokCredentialMissing(tStatus(req.locale, "errKeyMissingGoogle"));

  const noModel = byokNoModel("google", req);
  if (noModel) return noModel;
  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const { model, recent, system } = prepareContext("google", req, events, true);

  type GoogleFunctionCall = { id?: unknown; name?: unknown; args?: unknown };
  /** Keep provider Parts verbatim in model history. Gemini thought signatures
   * and other continuation metadata are opaque protocol values, not text to
   * normalize or discard in an adapter. */
  type GooglePart = {
    text?: string;
    inlineData?: { mimeType: string; data: string };
    functionCall?: GoogleFunctionCall;
    functionResponse?: { id?: string; name: string; response: Record<string, unknown>;
      /** FunctionResponse.parts (API reference): media the function returned, e.g. a host screenshot. */
      parts?: Array<{ inlineData: { mimeType: string; data: string } }> };
    thought?: boolean;
    thoughtSignature?: string;
    partMetadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const contents: Array<{ role: "user" | "model"; parts: GooglePart[] }> = [];
  for (const m of recent) {
    if (m.role === "user") contents.push({ role: "user", parts: [
      ...ownerControlHistoryImages(m).map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data } })),
      { text: m.text },
    ] });
    else if (m.role === "assistant")
      contents.push({ role: "model", parts: [{ text: m.text }] });
  }
  const lastParts: GooglePart[] = [];
  if (req.images && req.images.length > 0) {
    for (const img of req.images) {
      lastParts.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
    }
  }
  lastParts.push({ text: req.userPrompt });
  contents.push({ role: "user", parts: lastParts });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const { tools, byName, broker, approval } = await prepareMainToolLoop(req, "byok").catch((error: unknown) => { throw markRefusedBeforeDispatch(error); });
  const functionDeclarations = tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    // MCP and builtin descriptors are JSON Schema. Gemini's SDK provides this
    // field explicitly; sending it as OpenAPI `parameters` loses schema forms
    // outside its narrowed Schema representation.
    parametersJsonSchema: tool.function.parameters,
  }));
  const capacity = byokContextCapacity("google", model, req, events);
  const outputLimit = req.maxOutputTokens ?? Math.min(8_192, Math.floor(capacity.window / 4));
  let transmittedHistoryCount = req.history.filter((row) => row.role === "user" || row.role === "assistant").length;
  const historyBudgetState = { value: req.history.reduce((sum, row) => sum + estimateTransportTokens(row.text) + 12, 0) };
  // Same generation rule as the Anthropic/OpenAI paths (stateless-generation.ts); Google message/tool-result shapes kept.
  const generations = byokGenerations(req, model);
  const installGeneration = (digest: string, rows: RunnerRequest["history"]): void => {
    const next = rows.filter((row) => row.role === "user" || row.role === "assistant").map((row) => ({
      role: row.role === "user" ? "user" as const : "model" as const,
      parts: [
        ...(row.role === "user" ? ownerControlHistoryImages(row).map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data } })) : []),
        { text: row.text },
      ] as GooglePart[] }));
    const firstText = next[0]?.role === "user" ? next[0].parts.find((part) => typeof part.text === "string") : undefined;
    if (firstText) firstText.text = `${digest}\n\n${firstText.text}`;
    else next.unshift({ role: "user", parts: [{ text: digest }] });
    contents.splice(0, transmittedHistoryCount, ...next);
    transmittedHistoryCount = next.length;
    historyBudgetState.value = statelessHistoryTokens(digest, rows);
  };
  if (generations.seed) installGeneration(generations.seed.digest, generations.seed.rows);
  let lastRequestTokens: number | null = null, lastObservedInput: number | null = null;
  let acc = "";
  let lastEmit = 0;
  /** Consecutive replies cut by the output cap (continued on the same conversation, never a failed turn). */
  let outputCuts = 0;
  let reachedAnswer = false;
  /** Function calls the host ran in this turn: settleNormalEnd evidence (R-065). */
  let googleToolCallsRun = 0;
  let includeTools = functionDeclarations.length > 0;
  // Effort (A4 C6.3): generationConfig.thinkingConfig.thinkingLevel. The API reference says it is for Gemini 3 or later and
  // "use with earlier models results in an error": a structured field violation on the thinking config drops it for the
  // rest of the run and the ledger records "unsupported" with that reason.
  const thinkingLevel = geminiThinkingLevel(req.effort);
  let thinkingRejected = false;
  const geminiEffort = (): ModelEffortApplication => thinkingLevel && !thinkingRejected
    ? { status: "applied", applied: thinkingLevel.toLowerCase(), requested: req.effort ?? null, wire: "generationConfig.thinkingConfig.thinkingLevel" }
    : req.effort ? { status: "unsupported", requested: req.effort, reason: thinkingRejected ? "provider_rejected_thinking_level" : "effort_value_not_in_provider_enum" }
      : { status: "not_requested" };
  /** Set after a structured refusal of function-response media parts: later screenshots go back as text only. */
  let functionResponsePartsRejected = false;
  const measuredUsage = createToolLoopUsage(events);
  const progress = createToolLoopProgress("byok", req, events);
  /** Monotonic across every SSE event in this provider invocation. */
  let responseIndex = 0;
  const httpFailureResult = (status: number, retryAfter?: string | null): RunnerResult | null => {
    const failure = runtimeHttpFailure(status, "byok", "Google", retryAfter);
    if (!failure) return null;
    const observedUsage = measuredUsage.total();
    return assertCurrentHistoryRunnerResult({ text: acc.trim(), failure, ...(observedUsage ? { observedUsage } : {}),
      workforcePermissionEnforcement: broker?.finish(false) });
  };

  const ownerControl = createOwnerControlBoundary(req);
  // Explicit cachedContents only when the owner turned it on (doc 13 §7); off, nothing below changes the request.
  const geminiCacheSetting = await readGeminiCacheSetting().catch(() => ({ ...GEMINI_CACHE_DEFAULT }));
  /** G24: resends spent on an overloaded endpoint before anything streamed or ran in this invocation (provider-overload.ts). */
  let serverResends = 0;
  try {
  for (let turn = 0; turn < MAX_BYOK_TOOL_TURNS; turn += 1) {
    if (req.signal?.aborted) throw abortReasonError(req);
    if (turn > 0) {
      for (const entry of ownerControl.take()) contents.push({ role: "user", parts: [{ text: entry.text }] });
    }
    const outgoingBody = () => ({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: outputLimit,
        ...(thinkingLevel && !thinkingRejected ? { thinkingConfig: { thinkingLevel } } : {}) },
      ...(includeTools ? { tools: [{ functionDeclarations }] } : {}),
    });
    // Rotation at this settled boundary: input against 80% of the window (admission, next, is a separate check).
    const rotation = await generations.boundary({ boundary: turn === 0 ? "turn-start" : "tool-step", step: turn,
      window: byokGenerationWindow(capacity), requestTokens: estimateTransportTokens(JSON.stringify(outgoingBody())),
      historyTokens: historyBudgetState.value, observedLastInput: lastObservedInput, lastRequestTokens });
    if (rotation.action === "rotated") installGeneration(rotation.digest, rotation.rows);
    // In-turn compaction of earlier function responses (same rule as the other host loops, foldByokToolResults).
    if (turn > 0 && capacity.known) {
      const target = Math.min(Math.floor(capacity.window * GENERATION_CONTEXT_RATIO), capacity.window - outputLimit);
      const responseTurns = contents.filter((content) => content.role === "user" && content.parts.some((part) => part.functionResponse));
      const slots = responseTurns.slice(0, -1).flatMap((content) => content.parts
        .filter((part) => typeof part.functionResponse?.response?.output === "string" || typeof part.functionResponse?.response?.error === "string")
        .map((part) => {
          const key = typeof part.functionResponse!.response.output === "string" ? "output" : "error";
          return { get: () => String(part.functionResponse!.response[key]), set: (value: string) => {
            part.functionResponse = { ...part.functionResponse!, response: { [key]: value } };
            delete part.functionResponse.parts;
          } };
        }));
      if (slots.length) foldByokToolResults(slots, () => estimateTransportTokens(JSON.stringify(outgoingBody())) <= target, byName, approval);
    }
    if (!byokHistoryAdmission({ req, events, window: capacity.window, capacityKnown: capacity.known, outputReserve: outputLimit,
      budgetState: historyBudgetState,
      outgoingBody,
      replaceHistory: (recent, digest) => {
        const next = recent.filter((row) => row.role === "user" || row.role === "assistant")
          .map((row) => ({ role: row.role === "user" ? "user" as const : "model" as const,
            parts: [{ text: row.text }] }));
        if (next[0]?.role === "user") next[0].parts[0].text = `${digest}\n\n${next[0].parts[0].text}`;
        else next.unshift({ role: "user", parts: [{ text: digest }] });
        contents.splice(0, transmittedHistoryCount, ...next);
        transmittedHistoryCount = next.length;
      },
    })) return assertCurrentHistoryRunnerResult({ text: "", failure: byokContextFailure(req), ...(turn === 0 ? { turnDelivery: "not-dispatched" as const } : {}) });
    const requestBody = outgoingBody();
    const sentRequestTokens = estimateTransportTokens(JSON.stringify(requestBody));
    reportModelEndpoint({ url });
    assertScienceRecoveryRequest(req, "byok", "google");
    reportModelPayload(() => ledgerFromApiBody(requestBody, { ledgerHints: req.ledgerHints, imageCount: req.images?.length ?? 0 }));
    reportModelEffort(geminiEffort());
    const explicitCache = geminiCacheSetting.enabled
      ? await ensureGeminiCachedContent({
        apiKey: key, model, systemInstruction: requestBody.systemInstruction, tools: requestBody.tools,
        prefixTokensEst: estimateTransportTokens(JSON.stringify(requestBody.systemInstruction))
          + (requestBody.tools ? estimateTransportTokens(JSON.stringify(requestBody.tools)) : 0),
        setting: geminiCacheSetting, signal: req.signal,
      })
      : undefined;
    const cachedContentName = explicitCache && explicitCache.status !== "skipped" ? explicitCache.name : null;
    reportCachePlan(() => geminiCachePlan(requestBody, explicitCache));
    let usageAttempt = measuredUsage.start();
    if (req.signal?.aborted) throw abortReasonError(req);
    ownerControl.dispatched();
    let resp = await withCurrentHistoryProvider(()=>fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: req.signal,
      body: JSON.stringify(cachedContentName ? geminiBodyWithCache(requestBody, cachedContentName) : requestBody),
    }));
    if (!resp.ok && cachedContentName && isGeminiCacheMissing(resp.status, await resp.clone().text().catch(() => ""))) {
      // The cache expired or vanished between creation and use: drop it and send this request once without it.
      forgetGeminiCachedContent(cachedContentName);
      reportCachePlan(() => geminiCachePlan(requestBody, { status: "skipped", reason: "gemini_cache_missing_resent_plain" }));
      usageAttempt = measuredUsage.start();
      resp = await withCurrentHistoryProvider(()=>fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: req.signal,
        body: JSON.stringify(requestBody),
      }));
    }
    if (!resp.ok) {
      const terminal = httpFailureResult(resp.status, resp.headers.get("retry-after"));
      if (terminal) return terminal;
      // HTTP 413: the request is over the endpoint's size limit. A typed capacity refusal, not a tools problem to retry around.
      if (resp.status === 413) {
        const observedUsage = measuredUsage.total();
        return assertCurrentHistoryRunnerResult({ text: acc.trim(), failure: byokContextFailure(req), ...(observedUsage ? { observedUsage } : {}),
          workforcePermissionEnforcement: broker?.finish(false) });
      }
    }
    // A structured field violation on an OPTIONAL field this host added (the thinking level on a model before Gemini 3, or
    // function-response media parts on a model that takes text only) precedes generation: drop that field and resend once.
    for (let optionalRetry = 0; optionalRetry < 2 && !resp.ok && resp.status === 400 && !ownerControl.hasPending() && !req.signal?.aborted; optionalRetry += 1) {
      const errBody = await resp.clone().text().catch(() => "");
      // The field path when Gemini names it; on the run's first request also a bare INVALID_ARGUMENT (Google's status enum),
      // because the reference documents the error without its shape. The resend without the field decides: a second 400 is
      // reported as before.
      if (thinkingLevel && !thinkingRejected && (geminiThinkingConfigRejected(errBody) || (turn === 0 && geminiInvalidArgument(errBody)))) thinkingRejected = true;
      else if (!functionResponsePartsRejected && geminiFunctionResponsePartsRejected(errBody)) {
        functionResponsePartsRejected = true;
        for (const content of contents) for (const part of content.parts) if (part.functionResponse?.parts) delete part.functionResponse.parts;
      } else break;
      assertScienceRecoveryRequest(req, "byok", "google");
      reportModelPayload(() => ledgerFromApiBody(outgoingBody(), { ledgerHints: req.ledgerHints, imageCount: req.images?.length ?? 0 }));
      reportModelEffort(geminiEffort());
      reportCachePlan(() => geminiCachePlan(outgoingBody()));
      usageAttempt = measuredUsage.start();
      resp = await withCurrentHistoryProvider(()=>fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: req.signal,
        body: JSON.stringify(outgoingBody()),
      }));
    }
    // Retry without tools only when Gemini says, in its structured BadRequest field paths, that a tool declaration is
    // what it rejected (docs native-harness 07 G23). Any other 4xx (prose-only, quota, bad image) stays a loud failure:
    // a blind tools-free retry dropped capability and announced "tools unsupported" for unrelated errors.
    if (!ownerControl.hasPending() && !resp.ok && includeTools && resp.status >= 400 && resp.status < 500
      && geminiToolDeclarationRejected(await resp.clone().text().catch(() => ""))) {
      // A Workforce grant is for this advertised inventory. A tools-free retry
      // would make any later success evidence describe a different invocation.
      if (req.scienceCollectionCapability) throw new Error("science_collection_tool_protocol_unsupported");
      if (broker) throw new Error("workforce_broker_tool_protocol_unsupported");
      includeTools = false;
      events.onStatus(tStatus(req.locale, "mcpToolCallUnsupported"));
      assertScienceRecoveryRequest(req, "byok", "google");
      reportModelPayload(() => ledgerFromApiBody(outgoingBody(), { ledgerHints: req.ledgerHints, imageCount: req.images?.length ?? 0 }));
      reportCachePlan(() => geminiCachePlan(outgoingBody()));
      usageAttempt = measuredUsage.start();
      resp = await withCurrentHistoryProvider(()=>fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: req.signal,
        body: JSON.stringify(outgoingBody()),
      }));
    }
    if (!resp.ok) {
      const terminal = httpFailureResult(resp.status, resp.headers.get("retry-after"));
      if (terminal) return terminal;
      const errText = await resp.text().catch(() => "");
      // G24: 5xx / 529 is a typed failure; overloaded earns one resend while nothing streamed and no tool ran.
      const serverCode = serverFailureCodeForStatus(resp.status);
      if (serverCode) {
        if (serverFailureResendable(serverCode) && serverResends < SERVER_FAILURE_RESENDS && turn === 0
          && !acc && !ownerControl.hasPending() && !req.signal?.aborted) {
          serverResends += 1;
          events.onStatus(req.locale === "ko" ? "모델 서버가 바빠 잠시 뒤 같은 요청을 한 번 더 보냅니다…" : "The model server is busy; sending the same request once more shortly…");
          await waitForServerResend(serverFailureResendDelayMs(resp.headers.get("retry-after")), req.signal);
          if (req.signal?.aborted) throw abortReasonError(req);
          turn -= 1; // the same request again, not a new tool turn
          continue;
        }
        const observedUsage = measuredUsage.total();
        return assertCurrentHistoryRunnerResult({ text: acc.trim(),
          failure: serverFailure({ code: serverCode, status: resp.status, runtime: "byok", providerLabel: "Google", locale: req.locale,
            body: errText, retryAfter: resp.headers.get("retry-after") }),
          ...(observedUsage ? { observedUsage } : {}), workforcePermissionEnforcement: broker?.finish(false) });
      }
      throw new Error(`Google API ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const modelParts: GooglePart[] = [];
    /** Where this response's text starts in `acc` (a text-cut reply keeps the earlier pieces in `acc`). */
    const responseStart = acc.length;
    const functionCalls: Array<{
      providerCallId: string | null;
      providerCallLocation: { responseIndex: number; partIndex: number };
      name: string;
      args: Record<string, unknown>;
    }> = [];
    let terminalUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined;
    let finishReason: string | undefined;
    let conflictingFinishReason = false;
    for await (const line of iterSseLines(resp)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === "[DONE]") break;
      // Usage on an intermediate chunk may be a subtotal. Only the last
      // response frame of a finished stream can account for this request.
      terminalUsage = undefined;
      try {
        const event = JSON.parse(payload) as {
          candidates?: Array<{ content?: { parts?: GooglePart[] }; finishReason?: string }>;
          usageMetadata?: { promptTokenCount?: unknown; totalTokenCount?: unknown; cachedContentTokenCount?: unknown };
        };
        const candidateFinishReason = event.candidates?.[0]?.finishReason;
        if (typeof candidateFinishReason === "string") {
          if (finishReason !== undefined && finishReason !== candidateFinishReason) conflictingFinishReason = true;
          finishReason = candidateFinishReason;
        }
        const input = event.usageMetadata?.promptTokenCount;
        const total = event.usageMetadata?.totalTokenCount;
        if (Number.isSafeInteger(input) && Number(input) >= 0
          && Number.isSafeInteger(total) && Number(total) >= Number(input)) {
          const cachedInputTokens = cachedTokensFromGeminiUsage(event.usageMetadata);
          terminalUsage = { inputTokens: Number(input), outputTokens: Number(total) - Number(input),
            ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}) };
        }
        const currentResponseIndex = responseIndex;
        responseIndex += 1;
        const parts = event.candidates?.[0]?.content?.parts ?? [];
        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
          const part = parts[partIndex];
          // Preserve the exact provider Part, including thoughtSignature and
          // future continuation fields, before interpreting the callable bit.
          modelParts.push(part);
          if (typeof part.text === "string" && part.thought !== true) {
            acc += part.text;
            const now = Date.now();
            if (now - lastEmit > 80) {
              (currentHistoryRuntimeFence()?.assertCurrent(), events.onPartial(acc));
              lastEmit = now;
            }
            continue;
          }
          if (!part.functionCall) continue;
          const call = part.functionCall;
          if ((call.id !== undefined && (typeof call.id !== "string" || !call.id)) ||
            typeof call.name !== "string" || !call.name) {
            throw new Error("workforce_broker_provider_tool_call_invalid");
          }
          const args = call.args === undefined ? {} : call.args;
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            throw new Error("workforce_broker_provider_tool_arguments_invalid");
          }
          const exactArgs = args as Record<string, unknown>;
          const providerCallId = typeof call.id === "string" ? call.id : null;
          functionCalls.push({
            providerCallId,
            providerCallLocation: { responseIndex: currentResponseIndex, partIndex },
            name: call.name,
            args: exactArgs,
          });
        }
      } catch (err) {
        if (req.scienceCollectionCapability) throw err;
        if (err instanceof Error && err.message.startsWith("workforce_broker_")) throw err;
        // Provider keep-alives and malformed non-tool chunks carry no dispatch
        // authority, so ignore them just as the previous text-only adapter did.
      }
    }
    // A MAX_TOKENS reply is billed like any other: its terminal usage is real and counts toward the turn.
    (measuredUsage.complete(usageAttempt, finishReason === "STOP" || finishReason === "MAX_TOKENS" ? terminalUsage : undefined), currentHistoryRuntimeFence()?.assertCurrent());
    if (finishReason === "MAX_TOKENS" && !conflictingFinishReason && !req.signal?.aborted
      && outputCuts < OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS) {
      // Cut by the output cap: keep the text, never run a call from a cut reply, continue on the same conversation.
      outputCuts += 1;
      const piece = acc.slice(responseStart);
      if (piece.trim()) contents.push({ role: "model", parts: [{ text: piece }] });
      contents.push({ role: "user", parts: [{ text: outputLimitContinuationTurn(functionCalls.length > 0 ? "tool-call" : "text") }] });
      if (functionCalls.length > 0) acc = acc.slice(0, responseStart);
      continue;
    }
    if (finishReason !== "STOP" || conflictingFinishReason) {
      const error = new RuntimeTurnUnsettledError("byok", req.locale);
      const refused = ["SAFETY", "RECITATION", "LANGUAGE", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
        "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "ESCALATION", "PUP_LIMITED_DISABLED"]
        .includes(finishReason ?? "");
      return assertCurrentHistoryRunnerResult({ text: acc.trim() || error.message, ownerControlTerminal: "uncertain",
        failure: refused
          ? { ...byokFailure("refused", acc.trim() || `Google stopped the response: ${finishReason}.`), providerCode: finishReason }
          : { ...byokFailure("exit", error.message), providerCode: error.code },
        workforcePermissionEnforcement: broker?.finish(false) });
    }
    if (req.signal?.aborted) throw abortReasonError(req);
    ownerControl.applied();
    const observedInput = terminalUsage && terminalUsage.inputTokens > 0 ? terminalUsage.inputTokens : null;
    generations.completed(turn, observedInput);
    lastObservedInput = observedInput;
    lastRequestTokens = sentRequestTokens;
    outputCuts = 0;
    if (functionCalls.length === 0 || req.untrustedNoTools) {
      reachedAnswer = true;
      break;
    }
    contents.push({ role: "model", parts: modelParts });
    const resultParts: GooglePart[] = [];
    googleToolCallsRun += functionCalls.length;
    for (const call of functionCalls) {
      assertScienceRecoveryRequest(req, "byok", "google");
      const outcome = await runMainToolDispatch(
        byName,
        {
          providerCallId: call.providerCallId,
          providerCallLocation: call.providerCallLocation,
          toolName: call.name,
          arguments: JSON.stringify(call.args),
        },
        progress.events,
        approval,
        broker,
      );
      progress.assertProgress();
      // A host screenshot rides in FunctionResponse.parts as inlineData (API reference; multimodal function responses).
      const images = functionResponsePartsRejected ? [] : toolResultImages(outcome);
      resultParts.push({
        functionResponse: {
          ...(call.providerCallId ? { id: call.providerCallId } : {}),
          name: call.name,
          response: outcome.isError
            ? { error: outcome.content }
            : { output: outcome.content },
          ...(images.length ? { parts: images.map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data } })) } : {}),
        },
      });
    }
    contents.push({ role: "user", parts: resultParts });
    acc = "";
  }
  const answer = acc.trim();
  let failure: RunnerFailure | null = null;
  // Google's own STOP is a normal end, settled by the shared rule (R-065): a tool-only turn completed.
  const normalEnd = reachedAnswer ? settleNormalEnd({ text: answer, toolCalls: googleToolCallsRun }) : null;
  if (!reachedAnswer) {
    failure = byokFailure("exit", `Google BYOK tool loop did not reach a final answer after ${MAX_BYOK_TOOL_TURNS} turns.`);
  } else if (normalEnd?.outcome === "empty") {
    failure = { ...byokFailure("empty", `Google returned an empty answer for ${model}.`), providerCode: EMPTY_NO_TOOL_RAN_CODE };
  } else if (answer) {
    const refusal = detectRuntimeRefusal(answer);
    if (refusal) failure = { ...refusal, runtime: "byok", source: "heuristic" };
  }
  const observedUsage = measuredUsage.total();
  return assertCurrentHistoryRunnerResult({
    text: answer || (failure ? failure.message : ""),
    ownerControlTerminal: failure ? "uncertain" : "completed",
    ...(failure ? { failure } : {}),
    ...(!failure && normalEnd ? normalEndToolEvidence(normalEnd) : {}),
    ...(observedUsage ? { observedUsage } : {}),
    workforcePermissionEnforcement: failure
      ? broker?.finish(false)
      : broker
        ? broker.finish(true)
        : workforceZeroToolsEnforcement(
            req,
            "byok",
            includeTools
              ? ["browser", "mcp", "apps", "session_persistence"]
              : ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
          ),
  });
  } finally { ownerControl.finish(); }
};
