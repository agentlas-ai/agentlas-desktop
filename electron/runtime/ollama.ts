import { schemaFallbackPromptPart, observationSystemWithSchema } from "../../shared/runtime-capabilities";
// Ollama 로컬 LLM — 감지 + 실호출.
// 사용자 머신에서 도는 오픈 모델(gemma / deepseek / llama 등)을 호출한다.
// API 키 불필요, 클라우드 미경유 — 완전 로컬. (PRD §3.1 BYOC의 로컬 변형)
//
// Ollama는 OpenAI 호환 엔드포인트를 제공한다:
//   - 모델 목록: GET  {host}/api/tags        → { models: [{ name }] }
//   - 서버 버전: GET  {host}/api/version      → { version }
//   - 채팅 SSE:  POST {host}/v1/chat/completions  (OpenAI Chat Completions 호환)
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { cumulativeSurfaceGateText, wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { resolveEffectiveContextWindow } from "../../shared/models";
import { runLocalOpenAiChat, type ChatMessage, type LocalChatContent, noModelSelectedResult } from "./local-tool-loop";
import { ownerControlHistoryImages } from "./owner-control-pump";

import { ollamaHost } from "./local-host";
// 호스트 해석(OLLAMA_HOST=0.0.0.0·포트 없음·":11434")은 local-host.ts 한 곳에서 정한다.
export { ollamaHost };

export interface OllamaProbe {
  version: string;
  /** 로컬에 받아둔 모델 이름들 (예: ["gemma3:latest", "deepseek-r1:8b"]) */
  models: string[];
}

/** 로컬 Ollama 서버 감지. 서버가 안 떠 있으면 null. */
export async function probeOllama(timeoutMs = 1500): Promise<OllamaProbe | null> {
  const host = ollamaHost();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const tagsRes = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
    if (!tagsRes.ok) return null;
    const tagsJson = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
    const models = (tagsJson.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);

    let version = "unknown";
    try {
      const verRes = await fetch(`${host}/api/version`, { signal: ctrl.signal });
      if (verRes.ok) {
        const verJson = (await verRes.json()) as { version?: string };
        version = verJson.version ?? "unknown";
      }
    } catch {
      // 버전 조회 실패는 비치명적 — 서버는 살아있음
    }
    return { version, models };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const runOllama: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const host = ollamaHost();
  const model = req.model?.trim();
  // No model id: a typed refusal before any request (A4 C6.2), never a throw the host reads as "may have acted".
  if (!model) return noModelSelectedResult("ollama", tStatus(req.locale, "errOllamaNoModel"));

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const capacity = resolveEffectiveContextWindow("ollama", model, false);
  const recent = req.history;
  const systemText = req.systemPrompt;

  const renderSystem = (withSchema = false) => req.minimalObservation
    ? observationSystemWithSchema(systemText, withSchema ? req.outputSchema?.schema : undefined)
    : wrapSystemPrompt(
      systemText, req.locale, req.permission, cumulativeSurfaceGateText(recent, req.surfaceUserPrompt ?? req.userPrompt),
      req.forceSurface, req.restrictedReadBoundary, req.untrustedNoTools, undefined, undefined, undefined,
      req.surfaceGate, undefined, req.sciencePromptProfile, req.judgmentOnly === true ? "host-judgment" : undefined,
      withSchema && req.outputSchema ? [schemaFallbackPromptPart(req.outputSchema.schema)] : undefined,
      req.systemPromptComposition,
      req.unattendedNoAsk,
    );
  const messages: ChatMessage[] = [{
    role: "system",
    content: renderSystem(),
  }];
  for (const m of recent) {
    if (m.role === "user") {
      const images = ownerControlHistoryImages(m);
      messages.push({ role: m.role, content: images.length ? [
        ...images.map(image => ({ type: "image_url" as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } })),
        { type: "text" as const, text: m.text },
      ] : m.text });
    } else if (m.role === "assistant") {
      messages.push({ role: "assistant", content: m.text });
    }
  }

  // 비전 모델이면 image_url(OpenAI 호환)로 첨부. 텍스트 모델은 조용히 무시한다.
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
      runtimeKind: "ollama",
      renderOutputSchemaSystem: () => ({ system: renderSystem(true) }),
      host,
      model,
      estimatedContextWindow: capacity.contextWindow ?? 16_000,
      // A thinking model spends part of this on reasoning before the first tool call or word of the answer.
      estimatedOutputReserve: req.maxOutputTokens ?? 8_192,
      ollamaContext: true,
      keepAlive: process.env.OLLAMA_KEEP_ALIVE?.trim() || "10m",
      unreachableMessage: tStatus(req.locale, "errOllamaUnreachable", { host }),
    },
    messages,
  );
};
