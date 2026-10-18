import { portableServingStrictSchemaOrNull } from "./serving-output-schema";
import { registerDeclaredPromptModule } from "./prompt-order";
import { OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS, outputLimitContinuationTurn, type OutputLimitCut } from "./output-limit-continuation";
/*
 * Agentlas 서빙 러너 — CLI 도 API 키도 없는 사람이 답을 받는 길.
 *
 * ── 왜 필요했나 ──
 * 지금까지 데스크탑에서 답을 받으려면 Claude Code·Codex 같은 CLI 를 이미 깔아 두었거나
 * 벤더 API 키가 있어야 했다. 둘 다 없는 사람에게 이 앱은 켜지기만 하는 껍데기였다.
 * 로그인만 되어 있으면 크레딧으로 바로 쓰게 한다(오너 지시 2026-08-23).
 *
 * ── 무엇을 모르나 ──
 * 이 파일은 세기(Light/Normal/Hard) 말고는 아무것도 모른다. 뒤에서 어떤 모델이 도는지는
 * 서버만 알고, 앱은 그 이름을 담지 않는다 — 설치본을 뜯어도 나오지 않아야 하기 때문이다.
 *
 * ── 크레딧 ──
 * 실행 1회가 크레딧을 쓴다. 잔액 판정·예약·정산은 전부 서버가 한다. 여기서 값을 지어내
 * 미리 보여 주지 않는다 — 앱이 계산한 값과 실제 청구가 어긋나면 그것이 곧 거짓말이 된다.
 */
import { reportModelPayload, reportCachePlan, reportModelEndpoint, reportModelEffort, ledgerFromApiBody } from "./model-call-ledger";
import { GENERATION_CONTEXT_RATIO } from "./session-generation";
import { foldRetainedToolResult } from "./tool-result-context";
import { cacheCapabilityFor, planCache, segmentOf, type CachePlan, type CacheSegment } from "./cache-planner";
import { assertCurrentHistoryRunnerResult } from "./observed-runner";
import { normalEndToolEvidence, settleNormalEnd } from "../../shared/turn-settlement";
import { currentHistoryRuntimeFence, withCurrentHistoryProvider } from "../one/history-runtime-fences";
import { getSessionCookieHeader, webBaseUrl } from "../auth";
import { managedOneHeaders, managedOneConfigured, managedOneAuthenticationEpoch } from "../managed-one/auth";
import { createHash } from "node:crypto";
import {
  AGENTLAS_SERVING_CONTEXT_WINDOW,
  AGENTLAS_SERVING_DEFAULT_MODEL,
  agentlasServingModel,
  isAgentlasServingModel,
} from "../../shared/agentlas-serving";
import { compactHistoryToBudget } from "./compact";
import { openStatelessGeneration, type StatelessGenerationSession, type StatelessWindow } from "./stateless-generation";
import { estimateAdmissionTokens } from "./token-estimate";

/**
 * Admission estimate for the serving tier: the calibrated token estimate (token-estimate.ts, within +-15% of
 * o200k_base on EN/KO/code/JSON, plus a 12% cross-tokenizer margin). It replaced UTF-8 bytes / 2.5, which
 * over-counted English ~1.5x and Korean ~1x; the server remains the final judge of its own window.
 */
function servingAdmissionTokens(text: string): number {
  return estimateAdmissionTokens(text);
}
import type { Runner, RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";
import { schemaFallbackPromptPart, observationSystemWithSchema } from "../../shared/runtime-capabilities";
import { cumulativeSurfaceGateText, httpRetryAfterHint, markRefusedBeforeDispatch, wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { createToolLoopProgress, createToolLoopUsage, prepareMainToolLoop, runMainToolDispatch } from "./local-tool-loop";
import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";

const TOOL_PROTOCOL = "agentlas-serving-tools-v1";

/**
 * 세기별 답 길이 상한. 서버도 같은 상한을 다시 건다 — 여기 값은 요청이지 보장이 아니다.
 * 서버는 maxTokens 를 256..8000 으로 자른다(AgentsAtlas /api/one/serving/chat/route.ts). 세 세기 모두 그 최댓값을 요청한다:
 * 상한은 단계당 길이일 뿐 청구는 실제 출력 토큰이고, 낮은 상한은 한 단계에서 긴 파일·답을 못 쓰게 만들었다
 * (Light 1,600). 코드에 더 낮은 상한을 두어야 할 비용·계약 근거는 없다. 상한에 닿으면 이어 쓴다(아래 연속 라운드).
 */
const SERVING_MAX_OUTPUT_TOKENS = 8_000;
const MAX_TOKENS: Record<string, number> = {
  "agentlas-hard": SERVING_MAX_OUTPUT_TOKENS,
  "agentlas-normal": SERVING_MAX_OUTPUT_TOKENS,
  "agentlas-light": SERVING_MAX_OUTPUT_TOKENS,
};

/**
 * 대화를 접는 기준 창.
 *
 * 서버가 실제 모델의 창 크기를 알지만 앱은 모른다(그것이 곧 모델을 아는 것이다).
 * 그래서 요즘 모델이 공통으로 가진 보수적인 값을 쓴다 — 넘겨서 거절당하는 것보다
 * 조금 일찍 접는 쪽이 낫다.
 */
function servingModelId(req: RunnerRequest): string {
  return isAgentlasServingModel(req.model) ? String(req.model).trim() : AGENTLAS_SERVING_DEFAULT_MODEL;
}

function signInRequired(locale: RunnerRequest["locale"]): Error {
  return new Error(
    locale === "ko"
      ? "Agentlas 모델을 쓰려면 로그인해야 합니다. 설정에서 Agentlas 계정으로 로그인해 주세요."
      : "Sign in to use Agentlas models. Connect your Agentlas account in Settings.",
  );
}

type ServingTurn = { role: "user" | "assistant"; text: string };

/** Vision models bill a high-detail image at roughly 1–2k input tokens; count the upper end. */
const IMAGE_TOKEN_ESTIMATE = 2_000;
function imageTokenEstimate(req: RunnerRequest, toolImageCount = 0): number {
  return ((req.images?.length ?? 0) + toolImageCount) * IMAGE_TOKEN_ESTIMATE;
}

/** The serving tier's transport ceiling is the window this endpoint admits; 80% of it is the rotation point. */
const SERVING_GENERATION_WINDOW: StatelessWindow = { tokens: AGENTLAS_SERVING_CONTEXT_WINDOW, source: "host-ceiling", known: true };

/** `base`: the conversation's generation (handoff + rows after its frontier) in place of req.history. */
function turnsFor(req: RunnerRequest, events: RunnerEvents, outputReserve: number,
  base?: { digest: string; rows: RunnerRequest["history"] } | null): { turns: ServingTurn[]; system: string } | null {
  // A Main-issued effect observation carries its own complete prompt (no Agentlas header/skills).
  const system = req.minimalObservation ? observationSystemWithSchema(req.systemPrompt, req.outputSchema?.schema) : wrapSystemPrompt(
      req.systemPrompt,
      req.locale,
      req.permission,
      // The gate reads what the person typed, never the host context now framed into userPrompt
      // (a recalled memory must not switch the 16 KB Surface protocol on and move the cached prefix).
      cumulativeSurfaceGateText(req.history, req.surfaceUserPrompt ?? req.userPrompt),
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
      req.outputSchema ? [schemaFallbackPromptPart(req.outputSchema.schema)] : undefined,
      req.systemPromptComposition,
      req.unattendedNoAsk,
    );
  // The server enforces req.outputSchema by constrained decoding when it can; the
  // instruction is the honest floor for a server that cannot (status line says which).
  // Images are counted as a bounded per-image estimate, not as their base64 length:
  // one ordinary screenshot's base64 alone is larger than the whole 128k window,
  // so counting it as text refused every image turn before it was sent.
  let budget = AGENTLAS_SERVING_CONTEXT_WINDOW
    - servingAdmissionTokens(JSON.stringify({ system, current: req.userPrompt }))
    - imageTokenEstimate(req)
    - outputReserve - 256;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const history = base ? [{ id: "agentlas:stateless-handoff", role: "user" as const, text: base.digest, createdAt: new Date(0).toISOString() },
      ...base.rows] : req.history;
    const compacted = compactHistoryToBudget(history, { historyBudgetTokens: budget, locale: req.locale });
    if (!compacted.fits) return null;
    const turns: ServingTurn[] = compacted.recent
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .map((entry) => ({ role: entry.role as ServingTurn["role"], text: entry.text }));
    if (compacted.digest) {
      if (turns[0]?.role === "user") turns[0].text = `${compacted.digest}\n\n${turns[0].text}`;
      else turns.unshift({ role: "user", text: compacted.digest });
    }
    turns.push({ role: "user", text: req.userPrompt });
    const estimated = servingAdmissionTokens(JSON.stringify({ system, messages: turns, maxTokens: outputReserve }))
      + imageTokenEstimate(req);
    if (estimated + outputReserve <= AGENTLAS_SERVING_CONTEXT_WINDOW) {
      // History trimming is background work: nothing about it is shown to the user (owner 2026-10-13).
      return { turns, system };
    }
    budget = Math.max(0, budget - (estimated + outputReserve - AGENTLAS_SERVING_CONTEXT_WINDOW) - 256);
  }
  return null;
}

/** Local scratch contract only; does not contact the serving endpoint. */
export const __testTurnsFor = turnsFor;

/** SSE 프레임(`event:` + `data:`)을 한 개씩 돌려준다. */
async function* iterServingEvents(response: Response): AsyncGenerator<{ event: string; data: unknown }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      try {
        yield { event, data: JSON.parse(dataLines.join("\n")) };
      } catch {
        // 깨진 프레임 하나가 실행 전체를 죽이지 않는다.
      }
    }
  }
}

type ServingToolCall = { id: string; name: string; input: Record<string, unknown> };
type ServingImage = { mediaType: string; data: string };
type ServingToolExchange = { text: string; calls: ServingToolCall[]; results: Array<{ id: string; text: string; isError: boolean }>; images?: ServingImage[] };

/** Host-dispatched visual content only; never interpret a model's text as an image. */
function servingToolImages(message: { content: unknown } | null): ServingImage[] {
  if (!message) return [];
  if (!Array.isArray(message.content)) throw new Error("serving_tool_image_invalid");
  const images: ServingImage[] = [];
  for (const part of message.content) {
    if (part?.type === "text") continue;
    const match = part?.type === "image_url" && typeof part.image_url?.url === "string"
      ? /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url.url) : null;
    if (!match || match[2].length > 8_000_000) throw new Error("serving_tool_image_invalid");
    images.push({ mediaType: match[1], data: match[2] });
    if (images.length > 8) throw new Error("serving_tool_image_capacity_exceeded");
  }
  return images;
}
type ServingDone = {
  text?: unknown; stopReason?: unknown; toolUses?: unknown;
  /** Token counts the server measured for this call (not the model name). Absent on older servers. */
  usage?: { inputTokens?: unknown; outputTokens?: unknown; cacheReadInputTokens?: unknown };
  /** How many attached images the server forwarded. Absent = the server did not accept images. */
  imagesAccepted?: unknown;
  /** "json_schema" when the server enforced req.outputSchema by constrained decoding. */
  outputFormat?: unknown;
};

function servingToolCalls(value: unknown): ServingToolCall[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("invalid_serving_tool_frame");
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_serving_tool_frame");
    const call = raw as Partial<ServingToolCall>;
    // A name this request did not offer (copied from the conversation history: another runtime's tool name, or a tool the
    // menu listed earlier) is not a broken frame. The dispatcher resolves it to the one tool it denotes or answers the
    // model with the exact names, and never runs an unknown tool (tool-name-alias.ts). Refusing the reply ended the turn
    // as "no completion receipt" (production 2026-10-16, Hope on Agentlas Light).
    if (typeof call.id !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(call.id) || ids.has(call.id)
      || typeof call.name !== "string" || !call.name || call.name.length > 256
      || !call.input || typeof call.input !== "object" || Array.isArray(call.input))
      throw new Error("invalid_serving_tool_frame");
    ids.add(call.id);
    return { id: call.id, name: call.name, input: call.input };
  });
}

/*
 * 실패 원인은 기계 표식으로 넘긴다(RunnerFailure.kind/providerCode). 예전엔 한국어 문장을
 * throw 해서 runnerFailureFromError 의 영어 정규식(credits?|sign in)에 걸리지 않았고,
 * 크레딧 부족·로그아웃이 "exit" 로 분류돼 한도 폴백·재로그인 안내가 돌지 않았다.
 */
async function servingHttpFailure(response: Response, locale: RunnerRequest["locale"]): Promise<RunnerFailure> {
  let code = "";
  try { code = String(((await response.json()) as { code?: unknown }).code ?? ""); } catch { /* empty body */ }
  const providerCode = /^[a-z0-9_]{1,64}$/.test(code) ? code : `http_${response.status}`;
  if (providerCode === "serving_reconciliation_required") return servingReconciliationFailure(locale);
  if (providerCode === "serving_input_too_large" || response.status === 413) return servingInputTooLargeFailure(locale);
  if (response.status === 401) {
    return { kind: "auth", runtime: "agentlas", source: "marker", providerCode: "sign_in_required",
      message: signInRequired(locale).message };
  }
  // Preserve the service's typed refusal. A proxy or reconciliation gate can
  // return 402 without declaring an exhausted credit balance.
  if (code === "insufficient_credits") {
    return { kind: "quota", runtime: "agentlas", source: "marker", providerCode: "insufficient_credits",
      message: locale === "ko" ? "크레딧이 부족합니다. 크레딧을 보충한 뒤 다시 시도해 주세요."
        : "You are out of credits. Top up and try again." };
  }
  // Throttling, not an exhausted balance (that is insufficient_credits above): retried after the service's Retry-After.
  if (response.status === 429) {
    const retryAfterHint = httpRetryAfterHint(response.headers.get("retry-after"));
    return { kind: "rate_limit", runtime: "agentlas", source: "marker", providerCode,
      message: locale === "ko" ? "Agentlas 모델 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
        : "The Agentlas model service is rate limited. Try again shortly.",
      ...(retryAfterHint ? { retryAfterHint } : {}) };
  }
  return { kind: "exit", runtime: "agentlas", source: "marker", providerCode,
    message: locale === "ko" ? "Agentlas 모델에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요."
      : "Could not reach the Agentlas model service. Try again shortly." };
}

function streamFailure(data: unknown, locale: RunnerRequest["locale"]): RunnerFailure {
  const record = data && typeof data === "object" ? data as { code?: unknown; message?: unknown } : {};
  const code = typeof record.code === "string" && /^[a-z0-9_]{1,64}$/.test(record.code) ? record.code : "serving_failed";
  if (code === "serving_reconciliation_required") return servingReconciliationFailure(locale);
  if (code === "serving_input_too_large") return servingInputTooLargeFailure(locale);
  const message = typeof record.message === "string" && record.message ? record.message
    : locale === "ko" ? "답을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요." : "The Agentlas model could not answer. Try again shortly.";
  return { kind: code === "insufficient_credits" ? "quota" : "exit", runtime: "agentlas", source: "marker",
    providerCode: code, message: message.slice(0, 400) };
}

/** The server's own typed 413 (nothing dispatched to a provider): the same capacity refusal as the local pre-send check. */
function servingInputTooLargeFailure(locale: RunnerRequest["locale"]): RunnerFailure {
  return { kind: "refused", runtime: "agentlas", source: "marker", providerCode: "model_context_capacity_exceeded",
    message: locale === "ko"
      ? "Agentlas 모델의 입력 한도를 넘었습니다. 현재 요청과 지시는 잘라내지 않았습니다."
      : "The request exceeds the Agentlas serving input limit. Current request and instructions were not clipped." };
}

function servingReconciliationFailure(locale: RunnerRequest["locale"]): RunnerFailure {
  return { kind: "refused", runtime: "agentlas", source: "marker",
    providerCode: "serving_reconciliation_required",
    message: locale === "ko"
      ? "응답과 크레딧 정산 상태를 확인해야 합니다. 이 요청을 자동 재실행하지 않습니다."
      : "The response and credit settlement need reconciliation. This request will not be retried automatically." };
}

/** 요청 본문의 공통 칸. 사진·출력 계약은 매 왕복 같이 간다(서버는 상태를 들지 않는다). */
function servingRequestFields(req: RunnerRequest): Record<string, unknown> {
  const nativeSchema = req.outputSchema ? portableServingStrictSchemaOrNull(req.outputSchema.schema) : null;
  if (nativeSchema) registerDeclaredPromptModule({ id: "transport.output-schema.native", revision: 1, stability: "task-context", changeTriggers: ["release", "task", "plan-revision"] });
  return {
    ...(req.images?.length ? { images: req.images.map((image) => ({ mediaType: image.mediaType, data: image.data })) } : {}),
    ...(req.outputSchema && nativeSchema ? { outputSchema: { name: req.outputSchema.name, schema: nativeSchema } } : {}),
  };
}

/** Missing or invalid dispatch receipts never become measured zero. */
/**
 * The serving server (/api/one/serving/chat) places the Anthropic markers itself; the desktop sends none. The plan
 * therefore carries no breakpoints, only the stable-prefix digest (tools + system) and the expected-prefix size that
 * the ledger compares with the cacheReadInputTokens the server reports back.
 */
function servingCachePlan(input: { system: string; tools: unknown[]; turns: unknown[] }): CachePlan {
  const segments: CacheSegment[] = [];
  if (input.tools.length > 0) segments.push(segmentOf("tools", "S0", "stable-prefix", JSON.stringify(input.tools)));
  segments.push(segmentOf("system", "S1", "stable-prefix", input.system));
  const last = input.turns.length - 1;
  if (last >= 1) segments.push({ id: "history", layer: "S4", cacheClass: "provider-owned", bytes: JSON.stringify(input.turns.slice(0, last)).length });
  if (last >= 0) segments.push({ id: "owner-input", layer: "S5", cacheClass: "volatile-tail", bytes: JSON.stringify(input.turns[last]).length });
  return planCache({ capability: cacheCapabilityFor({ family: "agentlas-serving" }), segments });
}

class ServingUsage {
  private readonly usage;
  constructor(events: RunnerEvents) { this.usage = createToolLoopUsage(events); }
  start(): string { return this.usage.start(); }
  add(id: string, done: ServingDone): void {
    const input = done.usage?.inputTokens;
    const output = done.usage?.outputTokens;
    // The server's inputTokens already include cache reads and writes; cacheReadInputTokens is the measured subset.
    // Dropping it made every serving turn read as uncached (production 1.3.5: 27.6k/41.8k/45.2k input, cached blank).
    const cached = done.usage?.cacheReadInputTokens;
    const cachedInputTokens = typeof cached === "number" && Number.isSafeInteger(cached) && cached >= 0
      && typeof input === "number" && cached <= input ? cached : undefined;
    this.usage.complete(id, typeof input === "number" && typeof output === "number"
      ? { inputTokens: input, outputTokens: output, ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}) } : undefined);
  }
  settle(): { observedUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } } {
    const observedUsage = this.usage.total();
    return observedUsage ? { observedUsage } : {};
  }
}

/** 첫 응답에서 한 번: 사진·출력 계약이 실제로 서버에서 지켜졌는지 사실대로 알린다. */
function reportDeliveredCapabilities(req: RunnerRequest, events: RunnerEvents, done: ServingDone): void {
  const sentImages = req.images?.length ?? 0;
  if (sentImages > 0 && done.imagesAccepted !== sentImages) {
    events.onNotice?.({ level: "warning", code: "images-not-delivered",
      message: req.locale === "ko"
        ? "이 Agentlas 서버는 첨부한 사진을 모델에 전달하지 않았습니다. 사진 없이 답했습니다."
        : "This Agentlas server did not forward the attached images to the model; it answered without them." });
  }
  if (req.outputSchema && done.outputFormat !== "json_schema") {
    events.onStatus(req.locale === "ko" ? "출력 형식은 지시문으로만 요청했습니다(서버 강제 없음)."
      : "Output format requested by instruction only (not server-enforced).");
  }
}

async function postServing(body: string, cookie: string, req: RunnerRequest): Promise<Response> {
  const managed = managedOneHeaders("serving");
  if (managedOneConfigured() && !managed) throw new Error("managed_one_credential_expired");
  return withCurrentHistoryProvider(()=>fetch(`${webBaseUrl()}/api/one/serving/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(managed ?? { cookie }),
      // 브라우저는 이 헤더를 preflight 없이 붙일 수 없다. 서버의 교차출처 관문이
      // 이 헤더 하나로 "앱이 보낸 요청"과 "남의 사이트가 시킨 요청"을 가른다.
      "x-agentlas-client": "desktop",
      "accept-language": req.locale === "ko" ? "ko" : "en",
    },
    body,
    ...(req.signal ? { signal: req.signal } : {}),
  }));
}

async function runAgentlasServingWithTools(
  req: RunnerRequest,
  events: RunnerEvents,
  model: string,
  context: { turns: ServingTurn[]; system: string },
  outputReserve: number,
  cookie: string,
  generations?: StatelessGenerationSession,
): Promise<RunnerResult | null> {
  // Tool inventory preparation precedes every request to the service: its refusals are refusals before dispatch.
  const { tools, byName, broker, approval } = await prepareMainToolLoop(req, "agentlas").catch((error: unknown) => { throw markRefusedBeforeDispatch(error); });
  if (tools.length < 1) {
    // A granted MCP config that yields nothing is a broken grant, not a chat turn.
    if (req.mcpConfigPath) throw markRefusedBeforeDispatch(new Error("science_tool_inventory_unavailable"));
    return null;
  }
  const originalByAlias = new Map<string, string>();
  const definitions = tools.map((tool) => {
    const original = tool.function.name;
    const name = original.length <= 64 && /^[A-Za-z0-9_-]+$/.test(original)
      ? original
      : `tool_${createHash("sha256").update(original).digest("hex").slice(0, 32)}`;
    if (originalByAlias.has(name)) throw markRefusedBeforeDispatch(new Error("serving_tool_name_collision"));
    originalByAlias.set(name, original);
    return { name, description: (tool.function.description ?? original).slice(0, 4_096),
      inputSchema: tool.function.parameters };
  });
  const toolExchanges: ServingToolExchange[] = [];
  const seenCallIds = new Set<string>();
  const usage = new ServingUsage(events);
  const progress = createToolLoopProgress("agentlas", req, events);
  let accumulatedText = "";
  /** A reply cut by the output cap: its text so far, kept and continued on the same conversation (never a failed turn). */
  let cutPartial = "";
  let cutKind: OutputLimitCut | null = null;
  let cutRounds = 0;
  let firstRound = true;
  let round = 0, lastRequestTokens: number | null = null, lastObservedInput: number | null = null;
  for (;; round += 1) {
    req.signal?.throwIfAborted();
    if (generations && round > 0) {
      // After a tool round whose results are all in: the next request's input against 80% of the serving window.
      const pending = { model, system: context.system, messages: context.turns, maxTokens: outputReserve,
        toolProtocol: TOOL_PROTOCOL, tools: definitions, toolExchanges: toolExchanges.map(({ images: _images, ...exchange }) => exchange) };
      const rotation = await generations.boundary({ boundary: "tool-step", step: round, window: SERVING_GENERATION_WINDOW,
        requestTokens: servingAdmissionTokens(JSON.stringify(pending)), historyTokens: servingAdmissionTokens(JSON.stringify(context.turns.slice(0, -1))),
        observedLastInput: lastObservedInput, lastRequestTokens });
      if (rotation.action === "rotated") {
        const rebuilt = turnsFor(req, events, outputReserve, rotation);
        if (rebuilt) context = { turns: rebuilt.turns, system: context.system };
      }
    }
    // The continuation is part of the conversation the server rebuilds each round (it holds no state). With no tool
    // exchange yet it is an assistant turn plus a host user turn; the server places `messages` before `toolExchanges`, so
    // once exchanges exist the host turn rides on the last tool result instead (quoting the partial tail).
    const continuing = cutKind !== null;
    const wireTurns: ServingTurn[] = continuing && toolExchanges.length === 0
      ? [...context.turns, ...(cutPartial.trim() ? [{ role: "assistant" as const, text: cutPartial }] : []),
        { role: "user" as const, text: outputLimitContinuationTurn(cutKind!) }]
      : context.turns;
    const wireExchanges: ServingToolExchange[] = continuing && toolExchanges.length > 0
      ? toolExchanges.map((exchange, index) => index < toolExchanges.length - 1 ? exchange : { ...exchange,
        results: exchange.results.map((result, at) => at < exchange.results.length - 1 ? result : { ...result,
          text: [result.text, outputLimitContinuationTurn(cutKind!, cutPartial)].filter(Boolean).join("\n\n") }) })
      : toolExchanges;
    const toolImageCount = wireExchanges.reduce((count, exchange) => count + (exchange.images?.length ?? 0), 0);
    // In-turn compaction (A4 C3.3; same rule as local-tool-loop.ts): at this settled tool-step boundary, results of EARLIER
    // exchanges become durable read_tool_result references, oldest first, until the request is back under 80% of the
    // serving window and inside admission. The newest exchange and every call/result pair stay; images already go once.
    if (toolExchanges.length > 1) {
      const target = Math.min(Math.floor(AGENTLAS_SERVING_CONTEXT_WINDOW * GENERATION_CONTEXT_RATIO),
        AGENTLAS_SERVING_CONTEXT_WINDOW - outputReserve - 256 - imageTokenEstimate(req, toolImageCount));
      const size = () => servingAdmissionTokens(JSON.stringify({ model, system: context.system, messages: wireTurns, maxTokens: outputReserve,
        toolProtocol: TOOL_PROTOCOL, tools: definitions, toolExchanges: wireExchanges.map(({ images: _images, ...exchange }) => exchange) }));
      for (const exchange of toolExchanges.slice(0, -1)) {
        for (const result of exchange.results) {
          if (size() <= target) break;
          const reference = foldRetainedToolResult(byName, approval, result.text);
          if (reference) result.text = reference;
        }
      }
    }
    const textPayload = { model, system: context.system, messages: wireTurns, maxTokens: outputReserve,
      toolProtocol: TOOL_PROTOCOL, tools: definitions, toolExchanges: wireExchanges };
    const sentImageCount = (req.images?.length ?? 0) + toolImageCount;
    if (sentImageCount > 8) throw new Error("serving_tool_image_capacity_exceeded");
    const requestBody = JSON.stringify({ ...textPayload, ...servingRequestFields(req) });
    // Image bytes have a visual admission estimate, not a text-token estimate.
    const admissionPayload = { ...textPayload, toolExchanges: wireExchanges.map(({ images: _images, ...exchange }) => exchange) };
    lastRequestTokens = servingAdmissionTokens(JSON.stringify(admissionPayload));
    // The serving tier exposes a conservative 128k window. Count the full
    // growing tool transcript and schemas before another charged model call.
    if (servingAdmissionTokens(JSON.stringify(admissionPayload)) + imageTokenEstimate(req, toolImageCount) + outputReserve + 256
      > AGENTLAS_SERVING_CONTEXT_WINDOW) {
      return assertCurrentHistoryRunnerResult({ text: accumulatedText, ownerControlTerminal: "uncertain", failure: { kind: "refused", runtime: "agentlas", source: "marker",
        providerCode: "model_context_capacity_exceeded",
        message: "The Agentlas serving tool transcript exceeds the conservative context budget." } });
    }
    // Context-reduction C01: the exact round about to be sent (system, tools, history, tool exchanges), sizes only.
    reportModelPayload(() => ledgerFromApiBody(textPayload, { ledgerHints: req.ledgerHints, imageCount: sentImageCount }));
    // The serving protocol carries no effort field (servingRequestFields): the tier decides. Recorded as such, never as applied.
    reportModelEffort(req.effort ? { status: "unsupported", requested: req.effort, reason: "serving_protocol_has_no_effort_field" } : { status: "not_requested" });
    reportCachePlan(() => servingCachePlan({ system: context.system, tools: definitions, turns: wireTurns }));
    reportModelEndpoint({ url: webBaseUrl() });
    const usageAttempt = usage.start();
    const response = await postServing(requestBody, cookie, req);
    if (!response.ok) return assertCurrentHistoryRunnerResult({ text: accumulatedText, ownerControlTerminal: "uncertain", failure: await servingHttpFailure(response, req.locale), ...usage.settle() });
    let text = "";
    let done: ServingDone | null = null;
    try {
      for await (const frame of iterServingEvents(response)) {
        if (frame.event === "delta") {
          const delta = (frame.data as { text?: unknown })?.text;
          if (typeof delta === "string") {
            text += delta;
            (currentHistoryRuntimeFence()?.assertCurrent(), events.onPartial(accumulatedText + cutPartial + text));
          }
        } else if (frame.event === "done") {
          done = frame.data && typeof frame.data === "object" ? frame.data as ServingDone : null;
        } else if (frame.event === "error") {
          return assertCurrentHistoryRunnerResult({ text: accumulatedText, ownerControlTerminal: "uncertain", failure: streamFailure(frame.data, req.locale), ...usage.settle() });
        }
      }
    } catch {
      return assertCurrentHistoryRunnerResult({ text: accumulatedText, ownerControlTerminal: "uncertain", failure: servingReconciliationFailure(req.locale), ...usage.settle() });
    }
    if (!done) return assertCurrentHistoryRunnerResult({ text: accumulatedText, ownerControlTerminal: "uncertain", failure: servingReconciliationFailure(req.locale), ...usage.settle() });
    (usage.add(usageAttempt, done), currentHistoryRuntimeFence()?.assertCurrent());
    // The server's inputTokens include cache reads and writes: the whole input of this request.
    const observedInput = Number.isSafeInteger(done.usage?.inputTokens) && Number(done.usage?.inputTokens) > 0 ? Number(done.usage?.inputTokens) : null;
    // A stateless round gets new tool images once. Preserve the textual exchanges,
    // but do not carry base64 screenshots through every later charged call.
    for (const exchange of toolExchanges) delete exchange.images;
    if (toolImageCount > 0 && done.imagesAccepted !== sentImageCount) {
      return assertCurrentHistoryRunnerResult({ text: accumulatedText, ownerControlTerminal: "uncertain", failure: { kind: "unsupported", runtime: "agentlas", source: "marker",
        providerCode: "serving_tool_images_not_delivered",
        message: req.locale === "ko" ? "Agentlas 서버가 도구 이미지를 모델에 전달하지 않았습니다."
          : "The Agentlas server did not forward tool images to the model." }, ...usage.settle() });
    }
    if (firstRound) { reportDeliveredCapabilities(req, events, done); firstRound = false; }
    if (typeof done.text === "string" && done.text.length >= text.length) text = done.text;
    if (done.stopReason === "max_tokens" && !req.signal?.aborted) {
      // Cut by the output cap. A tool_use frame cut mid-arguments is never run (it may be half a write_file); a cut
      // text answer is kept. Either way one host turn continues the same conversation, a bounded number of times.
      const partial = cutPartial + text;
      if (cutRounds >= OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS) {
        return assertCurrentHistoryRunnerResult({ text: accumulatedText + partial, ownerControlTerminal: "uncertain", ...usage.settle() });
      }
      cutRounds += 1;
      cutKind = Array.isArray(done.toolUses) && done.toolUses.length > 0 ? "tool-call" : "text";
      cutPartial = partial;
      continue;
    }
    // A response that did not stop at the cap: the pending continuation (if any) is part of this answer or tool step.
    text = cutPartial + text;
    cutPartial = ""; cutKind = null; cutRounds = 0;
    if (done.stopReason !== "tool_use") {
      if (done.stopReason !== "end_turn" && done.stopReason !== "stop_sequence")
        throw new Error("invalid_serving_stop_reason");
      if (Array.isArray(done.toolUses) && done.toolUses.length > 0) throw new Error("invalid_serving_tool_frame");
      accumulatedText += text;
      // The model's own end_turn is a normal end, settled by the shared rule (R-065): a tool-only turn completed with an
      // empty text; one with neither text nor a tool call is the typed "empty" failure (it used to throw after dispatch,
      // which every host then reported as "may have acted").
      const normalEnd = settleNormalEnd({ text: accumulatedText, toolCalls: seenCallIds.size });
      if (normalEnd.outcome === "empty") {
        return assertCurrentHistoryRunnerResult({ text: "", ownerControlTerminal: "uncertain", ...usage.settle(),
          failure: { kind: "empty", runtime: "agentlas", source: "marker", providerCode: "agentlas_serving_empty_answer",
            message: req.locale === "ko" ? "Agentlas 서버의 모델이 빈 답을 반환했습니다." : "The Agentlas serving model returned an empty answer." } });
      }
      // Only a complete, valid final response acknowledges the generation it used (never max_tokens or a broken frame).
      if (!req.signal?.aborted) generations?.completed(round, observedInput);
      (currentHistoryRuntimeFence()?.assertCurrent(), events.onPartial(accumulatedText));
      return assertCurrentHistoryRunnerResult({ text: accumulatedText, ...usage.settle(), ...normalEndToolEvidence(normalEnd),
        ownerControlTerminal: !req.signal?.aborted && (done.toolUses === undefined || (Array.isArray(done.toolUses) && done.toolUses.length === 0))
          ? "completed" : "uncertain" });
    }
    const calls = servingToolCalls(done.toolUses);
    for (const call of calls) {
      if (seenCallIds.has(call.id)) throw new Error("invalid_serving_tool_frame");
      seenCallIds.add(call.id);
    }
    // A complete tool_use frame whose calls all validated: the request used the generation; its input is the next measure.
    generations?.completed(round, observedInput);
    lastObservedInput = observedInput;
    const results: ServingToolExchange["results"] = [];
    const images: ServingImage[] = [];
    for (const call of calls) {
      const result = await runMainToolDispatch(byName,
        { providerCallId: call.id, toolName: originalByAlias.get(call.name) ?? call.name, arguments: JSON.stringify(call.input) },
        progress.events, approval, broker);
      progress.assertProgress();
      results.push({ id: call.id, text: result.content, isError: result.isError });
      if (!result.isError) images.push(...servingToolImages(result.visionMessage));
      if (images.length + (req.images?.length ?? 0) > 8) throw new Error("serving_tool_image_capacity_exceeded");
    }
    toolExchanges.push({ text, calls, results, ...(images.length ? { images } : {}) });
    accumulatedText += text;
  }
}

export const runAgentlasServing: Runner = async (req, events): Promise<RunnerResult> => {
  // A recovery grant must still match the exact fresh request at the provider
  // boundary, before authentication, prompt construction or a charged call.
  assertScienceRecoveryRequest(req, "agentlas");
  const cookie = getSessionCookieHeader() ?? managedOneAuthenticationEpoch("serving");
  if (!cookie) return assertCurrentHistoryRunnerResult({ text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: { kind: "auth", runtime: "agentlas", source: "marker",
    providerCode: "sign_in_required", message: signInRequired(req.locale).message } });

  const model = servingModelId(req);
  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  events.onNotice?.({ level: "info", code: "model-context-capacity-estimated",
    message: req.locale === "ko"
      ? "서버의 실제 모델 용량은 공개되지 않아 보수적 문맥 예산으로 전송합니다."
      : "The server's exact model capacity is undisclosed; using a conservative transport budget." });

  const outputReserve = Math.min(MAX_TOKENS[model] ?? SERVING_MAX_OUTPUT_TOKENS, req.maxOutputTokens ?? Number.POSITIVE_INFINITY);
  // The conversation's "session" (stateless-generation.ts, native-harness NH10): the handoff it installed, a new one when a
  // request's input reaches 80% of the serving window, acknowledged by the next complete response. Silent.
  const generations = openStatelessGeneration({ runtime: "agentlas", chatId: req.chatId, ownerId: req.runtimeSessionOwnerId ?? req.agentId ?? null,
    model, history: req.history, locale: req.locale, agentId: req.agentId ?? null });
  let context = turnsFor(req, events, outputReserve, generations.seed);
  if (context) {
    const rotation = await generations.boundary({ boundary: "turn-start", step: 0, window: SERVING_GENERATION_WINDOW,
      requestTokens: servingAdmissionTokens(JSON.stringify({ system: context.system, messages: context.turns })) + imageTokenEstimate(req),
      historyTokens: servingAdmissionTokens(JSON.stringify(context.turns.slice(0, -1))) });
    if (rotation.action === "rotated") context = turnsFor(req, events, outputReserve, rotation) ?? context;
  }
  if (!context) return assertCurrentHistoryRunnerResult({ text: "", ownerControlTerminal: "uncertain", turnDelivery: "not-dispatched", failure: { kind: "refused", runtime: "agentlas", source: "marker",
    providerCode: "model_context_capacity_exceeded",
    message: req.locale === "ko"
      ? "Agentlas 모델의 보수적 문맥 예산을 넘었습니다. 현재 요청과 지시는 잘라내지 않았습니다."
      : "The request exceeds the conservative Agentlas context budget. Current request and instructions were not clipped." } });
  const { turns, system } = context;
  // Same admission as every host-loop runtime: tools whenever the run is not a
  // Main-authored no-tools boundary and has either an MCP config or a workspace.
  if (!req.untrustedNoTools && (req.mcpConfigPath || req.cwd)) {
    const withTools = await runAgentlasServingWithTools(req, events, model, { turns, system }, outputReserve, cookie, generations);
    if (withTools) return withTools;
  }
  const usage = new ServingUsage(events);
  // A reply cut by the output cap is continued on the same conversation (assistant partial + one host turn), a bounded
  // number of times; the pieces are joined into one answer and every round's usage is added.
  let joined = "";
  let cutRounds = 0;
  let text = "";
  let done: ServingDone | null = null;
  for (;;) {
    const roundTurns: ServingTurn[] = joined
      ? [...turns, ...(joined.trim() ? [{ role: "assistant" as const, text: joined }] : []),
        { role: "user" as const, text: outputLimitContinuationTurn("text") }]
      : turns;
    reportModelPayload(() => ledgerFromApiBody({ model, system, messages: roundTurns, maxTokens: outputReserve },
      { ledgerHints: req.ledgerHints, imageCount: req.images?.length ?? 0 }));
    reportCachePlan(() => servingCachePlan({ system, tools: [], turns: roundTurns }));
    reportModelEffort(req.effort ? { status: "unsupported", requested: req.effort, reason: "serving_protocol_has_no_effort_field" } : { status: "not_requested" });
    reportModelEndpoint({ url: webBaseUrl() });
    const usageAttempt = usage.start();
    const response = await postServing(JSON.stringify({
      model,
      system,
      messages: roundTurns,
      maxTokens: outputReserve,
      ...servingRequestFields(req),
    }), cookie, req);
    if (!response.ok) return assertCurrentHistoryRunnerResult({ text: joined, ownerControlTerminal: "uncertain", failure: await servingHttpFailure(response, req.locale), ...(joined ? usage.settle() : {}) });

    text = "";
    done = null;
    try {
      for await (const frame of iterServingEvents(response)) {
        if (frame.event === "delta") {
          const delta = (frame.data as { text?: unknown })?.text;
          if (typeof delta === "string" && delta) {
            text += delta;
            (currentHistoryRuntimeFence()?.assertCurrent(), events.onPartial(joined + text));
          }
        } else if (frame.event === "done") {
          done = frame.data && typeof frame.data === "object" ? frame.data as ServingDone : null;
          const final = done?.text;
          if (typeof final === "string" && final.length > text.length) text = final;
        } else if (frame.event === "error") {
          return assertCurrentHistoryRunnerResult({ text: joined, ownerControlTerminal: "uncertain", failure: streamFailure(frame.data, req.locale), ...(joined ? usage.settle() : {}) });
        }
      }
    } catch {
      return assertCurrentHistoryRunnerResult({ text: joined, ownerControlTerminal: "uncertain", failure: servingReconciliationFailure(req.locale), ...(joined ? usage.settle() : {}) });
    }
    if (!done) return assertCurrentHistoryRunnerResult({ text: joined, ownerControlTerminal: "uncertain", failure: servingReconciliationFailure(req.locale), ...(joined ? usage.settle() : {}) });
    (usage.add(usageAttempt, done), currentHistoryRuntimeFence()?.assertCurrent());
    if (cutRounds === 0) reportDeliveredCapabilities(req, events, done);
    if (done.stopReason === "max_tokens" && !req.signal?.aborted && cutRounds < OUTPUT_LIMIT_CONTINUATION_MAX_ROUNDS) {
      joined += text;
      cutRounds += 1;
      continue;
    }
    break;
  }
  text = joined + text;
  // No tool was offered on this path: a reply with no text is the shared rule's typed "empty" (R-065), never completed.
  if (settleNormalEnd({ text, toolCalls: 0 }).outcome === "empty") {
    return assertCurrentHistoryRunnerResult({ text: "", ownerControlTerminal: "uncertain", failure: { kind: "empty", runtime: "agentlas", source: "marker", providerCode: "empty_answer",
      message: req.locale === "ko"
        ? "Agentlas 모델이 빈 답을 돌려주었습니다. 다시 시도해 주세요."
        : "The Agentlas model returned an empty answer. Try again." } });
  }
  const completedTerminal = !req.signal?.aborted && (done.stopReason === "end_turn" || done.stopReason === "stop_sequence")
    && (done.toolUses === undefined || Array.isArray(done.toolUses) && done.toolUses.length === 0);
  // Only the complete final response acknowledges the generation it used; a still-cut (continuation bound spent) or invalid one does not.
  if (completedTerminal) generations.completed(0, Number.isSafeInteger(done.usage?.inputTokens) && Number(done.usage?.inputTokens) > 0 ? Number(done.usage?.inputTokens) : null);
  return assertCurrentHistoryRunnerResult({ text, ...usage.settle(),
    ownerControlTerminal: completedTerminal ? "completed" : "uncertain" });
};

/** 화면에 그릴 러너 이름. 세기까지 붙여 무엇으로 돌았는지 알 수 있게 한다. */
export function agentlasServingRunnerLabel(model: string | null | undefined): string {
  const chosen = agentlasServingModel(model ?? AGENTLAS_SERVING_DEFAULT_MODEL);
  return chosen ? chosen.label : "Agentlas";
}
