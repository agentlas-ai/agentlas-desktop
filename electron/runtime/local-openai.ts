import { assertScienceRecoveryRequest } from "../science-host/recovery-authority";
// OpenAI 호환 로컬 서버(LM Studio / MLX 등) 공용 감지 + 실호출.
// Ollama(runtime/ollama.ts)와 달리 이들은 "표준 OpenAI" 엔드포인트를 쓴다:
//   - 모델 목록: GET  {host}/v1/models           → { data: [{ id }] }
//   - 채팅 SSE:  POST {host}/v1/chat/completions  (OpenAI Chat Completions 호환)
// API 키 불필요, 클라우드 미경유 — 완전 로컬. (PRD §3.1 BYOC의 로컬 변형)
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { cumulativeSurfaceGateText, wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { resolveEffectiveContextWindow } from "../../shared/models";
import { runLocalOpenAiChat, type ChatMessage, type LocalChatContent } from "./local-tool-loop";

/** "localhost:1234"처럼 스킴이 없으면 http:// 보정하고 끝 슬래시를 제거한다. */
export function normalizeLocalHost(raw: string | undefined, fallback: string): string {
  const v = raw?.trim();
  if (!v) return fallback;
  return /^https?:\/\//.test(v) ? v.replace(/\/$/, "") : `http://${v.replace(/\/$/, "")}`;
}

export interface LocalModelProbe {
  /** 서버가 노출한 모델 id들 (예: ["qwen3-30b-a3b", "gemma-3-12b"]) */
  models: string[];
}

/** OpenAI 호환 로컬 서버 감지. 서버가 안 떠 있거나 응답이 이상하면 null. */
export async function probeOpenAiLocal(
  host: string,
  timeoutMs = 1500,
): Promise<LocalModelProbe | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}/v1/models`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (json.data ?? [])
      .map((m) => m.id)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    return { models };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * host를 바인딩해 OpenAI 호환 로컬 서버 채팅 Runner를 만든다.
 * hostFn은 호출 시점에 평가한다(env 재정의를 매 실행 반영).
 */
export function makeLocalOpenAiRunner(
  hostFn: () => string,
  runtimeKind: string = "lmstudio",
  options: {
    chatTemplateKwargs?: Record<string, boolean | number | string>;
    headersFn?: () => Record<string, string>;
    /** Exact resident Main receipt; generic OpenAI-compatible providers do not opt in. */
    contextWindowFn?: () => number | Promise<number>;
    /** See RunLocalOpenAiChatOptions.acceptsImageResults. Default true (Ollama/LM Studio vision models). */
    acceptsImageResults?: boolean;
    temperature?: number;
  } = {},
): Runner {
  return async (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> => {
    assertScienceRecoveryRequest(req, runtimeKind);
    const host = hostFn();
    const model = req.model?.trim();
    if (!model) {
      throw new Error(req.locale === "ko" ? "모델이 선택되지 않았습니다." : "No model selected.");
    }

    events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

    // A managed resident reports its exact n_ctx. Generic compatible servers
    // may only have catalog metadata; unknown is explicitly an estimate.
    const contextWindow = await options.contextWindowFn?.();
    assertScienceRecoveryRequest(req, runtimeKind);
    const capacity = contextWindow === undefined ? resolveEffectiveContextWindow(runtimeKind, model, false) : null;
    const recent = req.history;
    const systemText = req.systemPrompt;

    const surfaceGateText = cumulativeSurfaceGateText(recent, contextWindow !== undefined ? req.surfaceUserPrompt ?? req.userPrompt : req.userPrompt);
    const wrapped = (surfaceGate?: "exclude") => wrapSystemPrompt(
      systemText,
      req.locale,
      req.permission,
      surfaceGateText,
      req.forceSurface,
      req.restrictedReadBoundary,
      req.untrustedNoTools,
      undefined,
      undefined,
      contextWindow !== undefined ? "managed-local" : undefined,
      req.surfaceGate === "exclude" ? "exclude" : surfaceGate,
    );
    const systemContent = wrapped();
    // Managed local only: when the keyword-gated Surface protocol is what pushes the
    // request over the measured context, the loop may retry once with the same prompt
    // minus that optional host documentation. User text, history, agent instructions
    // and tool schemas are never trimmed; a forced Surface pass has no fallback.
    const systemPromptFallback = contextWindow !== undefined && req.forceSurface !== true
      ? (() => { const compact = wrapped("exclude"); return compact !== systemContent ? compact : undefined; })()
      : undefined;
    const messages: ChatMessage[] = [{ role: "system", content: systemContent }];
    for (const m of recent) {
      if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.text });
      }
    }

    // Preserve every attachment on the wire. Managed runners must reject
    // unsupported image input before calling this transport.
    if (req.images && req.images.length > 0) {
      const content: LocalChatContent[] = req.images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: `data:${img.mediaType};base64,${img.data}` },
      }));
      content.push({ type: "text", text: req.userPrompt });
      messages.push({ role: "user", content });
    } else {
      messages.push({ role: "user", content: req.userPrompt });
    }

    return runLocalOpenAiChat(
      {
        req,
        events,
        runtimeKind,
        host,
        model,
        unreachableMessage:
          req.locale === "ko"
            ? `로컬 서버에 연결할 수 없습니다: ${host}`
            : `Cannot reach local server: ${host}`,
        chatTemplateKwargs: options.chatTemplateKwargs,
        headers: options.headersFn?.(),
        contextWindow,
        ...(contextWindow !== undefined ? { dynamicHistoryCompaction: true as const } : {}),
        ...(capacity ? {
          estimatedContextWindow: capacity.contextWindow ?? 16_000,
          estimatedOutputReserve: req.maxOutputTokens ?? Math.min(8_192, Math.floor((capacity.contextWindow ?? 16_000) / 4)),
          capacitySource: capacity.source,
        } : {}),
        ...(options.acceptsImageResults === false ? { acceptsImageResults: false } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(systemPromptFallback ? { systemPromptFallback } : {}),
      },
      messages,
    );
  };
}
