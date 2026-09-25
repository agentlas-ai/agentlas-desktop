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
import { getSessionCookieHeader, webBaseUrl } from "../auth";
import { createHash } from "node:crypto";
import {
  AGENTLAS_SERVING_CONTEXT_WINDOW,
  AGENTLAS_SERVING_DEFAULT_MODEL,
  agentlasServingModel,
  isAgentlasServingModel,
} from "../../shared/agentlas-serving";
import { compactHistoryToBudget, estimateTransportTokens } from "./compact";
import type { Runner, RunnerEvents, RunnerFailure, RunnerRequest, RunnerResult } from "./runner";
import { schemaFallbackInstruction } from "../../shared/runtime-capabilities";
import { cumulativeSurfaceGateText, wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { prepareMainToolLoop, runMainToolDispatch } from "./local-tool-loop";

const TOOL_PROTOCOL = "agentlas-serving-tools-v1";
const MAX_TOOL_RESULT_CHARS = 20_000;

/** 세기별 답 길이 상한. 서버도 같은 상한을 다시 건다 — 여기 값은 요청이지 보장이 아니다. */
const MAX_TOKENS: Record<string, number> = {
  "agentlas-hard": 4_800,
  "agentlas-normal": 2_600,
  "agentlas-light": 1_600,
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
function imageTokenEstimate(req: RunnerRequest): number {
  return (req.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE;
}

function turnsFor(req: RunnerRequest, events: RunnerEvents, outputReserve: number): { turns: ServingTurn[]; system: string } | null {
  const wrapped = wrapSystemPrompt(
      req.systemPrompt,
      req.locale,
      req.permission,
      cumulativeSurfaceGateText(req.history, req.userPrompt),
      req.forceSurface,
      req.restrictedReadBoundary,
      req.untrustedNoTools,
      undefined,
      undefined,
      undefined,
      req.surfaceGate,
    );
  // The server enforces req.outputSchema by constrained decoding when it can; the
  // instruction is the honest floor for a server that cannot (status line says which).
  const system = req.outputSchema ? `${wrapped}\n${schemaFallbackInstruction(req.outputSchema.schema)}` : wrapped;
  // Images are counted as a bounded per-image estimate, not as their base64 length:
  // one ordinary screenshot's base64 alone is larger than the whole 128k window,
  // so counting it as text refused every image turn before it was sent.
  let budget = AGENTLAS_SERVING_CONTEXT_WINDOW
    - estimateTransportTokens(JSON.stringify({ system, current: req.userPrompt }))
    - imageTokenEstimate(req)
    - outputReserve - 256;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const compacted = compactHistoryToBudget(req.history, { historyBudgetTokens: budget, locale: req.locale });
    if (!compacted.fits) return null;
    const turns: ServingTurn[] = compacted.recent
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .map((entry) => ({ role: entry.role as ServingTurn["role"], text: entry.text }));
    if (compacted.digest) {
      if (turns[0]?.role === "user") turns[0].text = `${compacted.digest}\n\n${turns[0].text}`;
      else turns.unshift({ role: "user", text: compacted.digest });
    }
    turns.push({ role: "user", text: req.userPrompt });
    const estimated = estimateTransportTokens(JSON.stringify({ system, messages: turns, maxTokens: outputReserve }))
      + imageTokenEstimate(req);
    if (estimated + outputReserve <= AGENTLAS_SERVING_CONTEXT_WINDOW) {
      if (compacted.digest) {
        events.onNotice?.({ level: "info", code: "history-compacted", display: "divider",
          message: req.locale === "ko"
            ? `이전 대화 ${compacted.droppedCount}개를 비신뢰 발췌로 보냈습니다. 현재 요청과 지시는 그대로입니다.`
            : `Sent untrusted excerpts of ${compacted.droppedCount} earlier messages. Current request and instructions are unchanged.` });
      }
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
type ServingToolExchange = { text: string; calls: ServingToolCall[]; results: Array<{ id: string; text: string; isError: boolean }> };
type ServingDone = {
  text?: unknown; stopReason?: unknown; toolUses?: unknown;
  /** Token counts the server measured for this call (not the model name). Absent on older servers. */
  usage?: { inputTokens?: unknown; outputTokens?: unknown };
  /** How many attached images the server forwarded. Absent = the server did not accept images. */
  imagesAccepted?: unknown;
  /** "json_schema" when the server enforced req.outputSchema by constrained decoding. */
  outputFormat?: unknown;
};

function servingToolCalls(value: unknown, admitted: ReadonlySet<string>): ServingToolCall[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("invalid_serving_tool_frame");
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_serving_tool_frame");
    const call = raw as Partial<ServingToolCall>;
    if (typeof call.id !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(call.id) || ids.has(call.id)
      || typeof call.name !== "string" || !admitted.has(call.name)
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
  if (response.status === 401) {
    return { kind: "auth", runtime: "agentlas", source: "marker", providerCode: "sign_in_required",
      message: signInRequired(locale).message };
  }
  if (code === "insufficient_credits" || response.status === 402) {
    return { kind: "quota", runtime: "agentlas", source: "marker", providerCode: "insufficient_credits",
      message: locale === "ko" ? "크레딧이 부족합니다. 크레딧을 보충한 뒤 다시 시도해 주세요."
        : "You are out of credits. Top up and try again." };
  }
  if (response.status === 429) {
    return { kind: "quota", runtime: "agentlas", source: "marker", providerCode,
      message: locale === "ko" ? "Agentlas 모델 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
        : "The Agentlas model service is rate limited. Try again shortly." };
  }
  return { kind: "exit", runtime: "agentlas", source: "marker", providerCode,
    message: locale === "ko" ? "Agentlas 모델에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요."
      : "Could not reach the Agentlas model service. Try again shortly." };
}

function streamFailure(data: unknown, locale: RunnerRequest["locale"]): RunnerFailure {
  const record = data && typeof data === "object" ? data as { code?: unknown; message?: unknown } : {};
  const code = typeof record.code === "string" && /^[a-z0-9_]{1,64}$/.test(record.code) ? record.code : "serving_failed";
  const message = typeof record.message === "string" && record.message ? record.message
    : locale === "ko" ? "답을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요." : "The Agentlas model could not answer. Try again shortly.";
  return { kind: code === "insufficient_credits" ? "quota" : "exit", runtime: "agentlas", source: "marker",
    providerCode: code, message: message.slice(0, 400) };
}

/** 요청 본문의 공통 칸. 사진·출력 계약은 매 왕복 같이 간다(서버는 상태를 들지 않는다). */
function servingRequestFields(req: RunnerRequest): Record<string, unknown> {
  return {
    ...(req.images?.length ? { images: req.images.map((image) => ({ mediaType: image.mediaType, data: image.data })) } : {}),
    ...(req.outputSchema ? { outputSchema: { name: req.outputSchema.name, schema: req.outputSchema.schema } } : {}),
  };
}

/** 서버가 잰 토큰을 왕복마다 더한다. 한 번이라도 빠지면 합계는 없는 것이다(0 으로 채우지 않는다). */
class ServingUsage {
  private input = 0;
  private output = 0;
  private complete = true;
  add(done: ServingDone): void {
    const usage = done.usage;
    const input = usage && typeof usage.inputTokens === "number" ? usage.inputTokens : null;
    const output = usage && typeof usage.outputTokens === "number" ? usage.outputTokens : null;
    if (input === null || output === null || !Number.isFinite(input) || !Number.isFinite(output)) {
      this.complete = false;
      return;
    }
    this.input += Math.max(0, input);
    this.output += Math.max(0, output);
  }
  settle(events: RunnerEvents): { observedUsage?: { inputTokens: number; outputTokens: number } } {
    if (!this.complete) return {};
    const observedUsage = { inputTokens: this.input, outputTokens: this.output };
    events.onTerminalObservedUsage?.(observedUsage);
    return { observedUsage };
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
  return fetch(`${webBaseUrl()}/api/one/serving/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      // 브라우저는 이 헤더를 preflight 없이 붙일 수 없다. 서버의 교차출처 관문이
      // 이 헤더 하나로 "앱이 보낸 요청"과 "남의 사이트가 시킨 요청"을 가른다.
      "x-agentlas-client": "desktop",
      "accept-language": req.locale === "ko" ? "ko" : "en",
    },
    body,
    ...(req.signal ? { signal: req.signal } : {}),
  });
}

async function runAgentlasServingWithTools(
  req: RunnerRequest,
  events: RunnerEvents,
  model: string,
  context: { turns: ServingTurn[]; system: string },
  outputReserve: number,
  cookie: string,
): Promise<RunnerResult | null> {
  const { tools, byName, broker, approval } = await prepareMainToolLoop(req, "agentlas");
  if (tools.length < 1) {
    // A granted MCP config that yields nothing is a broken grant, not a chat turn.
    if (req.mcpConfigPath) throw new Error("science_tool_inventory_unavailable");
    return null;
  }
  const originalByAlias = new Map<string, string>();
  const definitions = tools.map((tool) => {
    const original = tool.function.name;
    const name = original.length <= 64 && /^[A-Za-z0-9_-]+$/.test(original)
      ? original
      : `tool_${createHash("sha256").update(original).digest("hex").slice(0, 32)}`;
    if (originalByAlias.has(name)) throw new Error("serving_tool_name_collision");
    originalByAlias.set(name, original);
    return { name, description: (tool.function.description ?? original).slice(0, 4_096),
      inputSchema: tool.function.parameters };
  });
  const admitted = new Set(originalByAlias.keys());
  const toolExchanges: ServingToolExchange[] = [];
  const seenCallIds = new Set<string>();
  const usage = new ServingUsage();
  let previousToolOutcomeDigest = "";
  let identicalToolOutcomes = 0;
  let accumulatedText = "";
  let firstRound = true;
  for (;;) {
    req.signal?.throwIfAborted();
    const textPayload = { model, system: context.system, messages: context.turns, maxTokens: outputReserve,
      toolProtocol: TOOL_PROTOCOL, tools: definitions, toolExchanges };
    const requestBody = JSON.stringify({ ...textPayload, ...servingRequestFields(req) });
    // The serving tier exposes a conservative 128k window. Count the full
    // growing tool transcript and schemas before another charged model call.
    if (estimateTransportTokens(JSON.stringify(textPayload)) + imageTokenEstimate(req) + outputReserve + 256
      > AGENTLAS_SERVING_CONTEXT_WINDOW) {
      return { text: accumulatedText, failure: { kind: "refused", runtime: "agentlas", source: "marker",
        providerCode: "model_context_capacity_exceeded",
        message: "The Agentlas serving tool transcript exceeds the conservative context budget." } };
    }
    const response = await postServing(requestBody, cookie, req);
    if (!response.ok) return { text: accumulatedText, failure: await servingHttpFailure(response, req.locale), ...usage.settle(events) };
    let text = "";
    let done: ServingDone | null = null;
    for await (const frame of iterServingEvents(response)) {
      if (frame.event === "delta") {
        const delta = (frame.data as { text?: unknown })?.text;
        if (typeof delta === "string") {
          text += delta;
          events.onPartial(accumulatedText + text);
        }
      } else if (frame.event === "done") {
        done = frame.data && typeof frame.data === "object" ? frame.data as ServingDone : null;
      } else if (frame.event === "error") {
        return { text: accumulatedText, failure: streamFailure(frame.data, req.locale), ...usage.settle(events) };
      }
    }
    if (!done) throw new Error("agentlas_serving_tool_stream_incomplete");
    usage.add(done);
    if (firstRound) { reportDeliveredCapabilities(req, events, done); firstRound = false; }
    if (typeof done.text === "string" && done.text.length >= text.length) text = done.text;
    if (done.stopReason !== "tool_use") {
      if (done.stopReason !== "end_turn" && done.stopReason !== "stop_sequence")
        throw new Error("invalid_serving_stop_reason");
      if (Array.isArray(done.toolUses) && done.toolUses.length > 0) throw new Error("invalid_serving_tool_frame");
      accumulatedText += text;
      if (!accumulatedText.trim()) throw new Error("agentlas_serving_empty_answer");
      events.onPartial(accumulatedText);
      return { text: accumulatedText, ...usage.settle(events) };
    }
    const calls = servingToolCalls(done.toolUses, admitted);
    for (const call of calls) {
      if (seenCallIds.has(call.id)) throw new Error("invalid_serving_tool_frame");
      seenCallIds.add(call.id);
    }
    const results: ServingToolExchange["results"] = [];
    for (const call of calls) {
      const result = await runMainToolDispatch(byName,
        { providerCallId: call.id, toolName: originalByAlias.get(call.name)!, arguments: JSON.stringify(call.input) },
        events, approval, broker);
      results.push({ id: call.id, text: result.content.slice(0, MAX_TOOL_RESULT_CHARS), isError: result.isError });
    }
    // Call IDs change on every provider round and cannot prove progress. An
    // identical structured call set with identical observable results can.
    const outcomeDigest = createHash("sha256").update(JSON.stringify({
      calls: calls.map((call) => ({ name: call.name, input: call.input })),
      results: results.map((result) => ({ text: result.text, isError: result.isError })),
    })).digest("hex");
    identicalToolOutcomes = outcomeDigest === previousToolOutcomeDigest ? identicalToolOutcomes + 1 : 0;
    previousToolOutcomeDigest = outcomeDigest;
    if (identicalToolOutcomes >= 3) throw new Error("agentlas_serving_tool_loop_stalled");
    toolExchanges.push({ text, calls, results });
    accumulatedText += text;
  }
}

export const runAgentlasServing: Runner = async (req, events): Promise<RunnerResult> => {
  const cookie = getSessionCookieHeader();
  if (!cookie) return { text: "", failure: { kind: "auth", runtime: "agentlas", source: "marker",
    providerCode: "sign_in_required", message: signInRequired(req.locale).message } };

  const model = servingModelId(req);
  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  events.onNotice?.({ level: "info", code: "model-context-capacity-estimated",
    message: req.locale === "ko"
      ? "서버의 실제 모델 용량은 공개되지 않아 보수적 문맥 예산으로 전송합니다."
      : "The server's exact model capacity is undisclosed; using a conservative transport budget." });

  const outputReserve = Math.min(MAX_TOKENS[model] ?? 2_600, req.maxOutputTokens ?? Number.POSITIVE_INFINITY);
  const context = turnsFor(req, events, outputReserve);
  if (!context) return { text: "", failure: { kind: "refused", runtime: "agentlas", source: "marker",
    providerCode: "model_context_capacity_exceeded",
    message: req.locale === "ko"
      ? "Agentlas 모델의 보수적 문맥 예산을 넘었습니다. 현재 요청과 지시는 잘라내지 않았습니다."
      : "The request exceeds the conservative Agentlas context budget. Current request and instructions were not clipped." } };
  const { turns, system } = context;
  // Same admission as every host-loop runtime: tools whenever the run is not a
  // Main-authored no-tools boundary and has either an MCP config or a workspace.
  if (!req.untrustedNoTools && (req.mcpConfigPath || req.cwd)) {
    const withTools = await runAgentlasServingWithTools(req, events, model, { turns, system }, outputReserve, cookie);
    if (withTools) return withTools;
  }
  const response = await postServing(JSON.stringify({
    model,
    system,
    messages: turns,
    maxTokens: outputReserve,
    ...servingRequestFields(req),
  }), cookie, req);
  if (!response.ok) return { text: "", failure: await servingHttpFailure(response, req.locale) };

  const usage = new ServingUsage();
  let text = "";
  let done: ServingDone | null = null;
  for await (const frame of iterServingEvents(response)) {
    if (frame.event === "delta") {
      const delta = (frame.data as { text?: unknown }).text;
      if (typeof delta === "string" && delta) {
        text += delta;
        events.onPartial(text);
      }
    } else if (frame.event === "done") {
      done = frame.data && typeof frame.data === "object" ? frame.data as ServingDone : {};
      const final = done.text;
      if (typeof final === "string" && final.length > text.length) text = final;
    } else if (frame.event === "error") {
      return { text: "", failure: streamFailure(frame.data, req.locale) };
    }
  }
  if (done) {
    usage.add(done);
    reportDeliveredCapabilities(req, events, done);
  }
  if (!text.trim()) {
    return { text: "", failure: { kind: "exit", runtime: "agentlas", source: "marker", providerCode: "empty_answer",
      message: req.locale === "ko"
        ? "Agentlas 모델이 빈 답을 돌려주었습니다. 다시 시도해 주세요."
        : "The Agentlas model returned an empty answer. Try again." } };
  }
  return { text, ...(done ? usage.settle(events) : {}) };
};

/** 화면에 그릴 러너 이름. 세기까지 붙여 무엇으로 돌았는지 알 수 있게 한다. */
export function agentlasServingRunnerLabel(model: string | null | undefined): string {
  const chosen = agentlasServingModel(model ?? AGENTLAS_SERVING_DEFAULT_MODEL);
  return chosen ? chosen.label : "Agentlas";
}
