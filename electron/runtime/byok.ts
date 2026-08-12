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
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { workforceZeroToolsEnforcement, wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { compactHistory } from "./compact";
import {
  ANTHROPIC_1M_BETA,
  anthropicCompatProvider,
  type ByokBackend,
  defaultByokModel,
  effectiveContextWindow,
  needsLongContextToggle,
} from "../../shared/models";

function resolveModel(backend: ByokBackend, req: RunnerRequest): string {
  return req.model?.trim() || defaultByokModel(backend) || "";
}

/**
 * 모델 결정 + 히스토리 압축을 한 번에. 압축이 일어나면 사용자에게 status를 emit하고
 * 다이제스트를 system 프롬프트에 주입한다.
 * @returns model(API id), recent(보낼 최근 메시지), system(이미 wrap된 시스템 프롬프트)
 */
function prepareContext(
  backend: ByokBackend,
  req: RunnerRequest,
  events: RunnerEvents,
): { model: string; recent: RunnerRequest["history"]; system: string } {
  const model = resolveModel(backend, req);
  if (!model) {
    throw new Error(
      req.locale === "ko"
        ? "사용할 모델 ID가 없습니다. 설정에서 실시간 모델을 선택하거나 모델 ID를 직접 입력하세요."
        : "No model ID is selected. Choose a live model or enter a model ID in Settings.",
    );
  }
  const { recent, digest, droppedCount } = compactHistory(req.history, {
    contextWindow: effectiveContextWindow(backend, model, !!req.longContext),
    locale: req.locale,
  });
  if (digest) events.onStatus(tStatus(req.locale, "compacted", { n: droppedCount }));
  if (digest) {
    events.onNotice?.({
      level: "info",
      message: tStatus(req.locale, "compacted", { n: droppedCount }),
      i18n: {
        ko: tStatus("ko", "compacted", { n: droppedCount }),
        en: tStatus("en", "compacted", { n: droppedCount }),
      },
      code: "history-compacted",
      display: "divider",
    });
  }
  const baseSystem = digest ? `${req.systemPrompt}\n\n${digest}` : req.systemPrompt;
  return {
    model,
    recent,
    system: wrapSystemPrompt(
      baseSystem,
      req.locale,
      req.permission,
      req.userPrompt,
      req.forceSurface,
      req.restrictedReadBoundary,
      req.untrustedNoTools,
    ),
  };
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
type AnthropicContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

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
  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const { model, recent, system } = prepareContext(backend, req, events);

  const messages: Array<{ role: "user" | "assistant"; content: string | AnthropicContent[] }> = [];
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.text });
    }
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

  // Prompt caching: only real Anthropic honors `cache_control`. Marking the
  // (large, stable) system prompt as a cache breakpoint bills cached input
  // ~90% cheaper on hits and consumes far less of a subscription's usage
  // limit; below the per-model minimum (~1024 tokens) Anthropic silently skips
  // it, so it is a harmless no-op for short prompts. Third-party
  // Anthropic-compatible endpoints (GLM/Kimi/DeepSeek) keep the plain string
  // form — they cache automatically server-side and may reject the extra field.
  const systemField =
    backend === "anthropic"
      ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }]
      : system;

  const resp = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    signal: req.signal,
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      stream: true,
      system: systemField,
      messages,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const event = JSON.parse(payload) as {
        type: string;
        delta?: { type?: string; text?: string };
      };
      if (event.type === "content_block_delta" && event.delta?.text) {
        acc += event.delta.text;
        const now = Date.now();
        if (now - lastEmit > 80) {
          events.onPartial(acc);
          lastEmit = now;
        }
      }
    } catch {
      // 빈 줄 또는 ping — 무시
    }
  }
  return {
    text: acc.trim(),
    workforcePermissionEnforcement: workforceZeroToolsEnforcement(
      req,
      "byok",
      ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
    ),
  };
}

export const runAnthropicByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const key = await readApiKey("anthropic");
  if (!key) throw new Error(tStatus(req.locale, "errKeyMissingAnthropic"));
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
    const preset = anthropicCompatProvider(backend);
    if (!preset) throw new Error(`Unknown Anthropic-compatible backend: ${backend}`);
    const key = await readApiKey(backend);
    if (!key) {
      throw new Error(
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
type OpenAIContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

async function runOpenAICompatible(
  backend: ByokBackend,
  baseUrl: string,
  providerLabel: string,
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> {
  const key = await readApiKey(backend);
  if (!key) {
    throw new Error(
      req.locale === "ko"
        ? `${providerLabel} API 키가 없습니다. 설정에서 키를 저장하세요.`
        : `Missing ${providerLabel} API key. Save it in Settings.`,
    );
  }

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  const { model, recent, system } = prepareContext(backend, req, events);
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string | OpenAIContent[];
  }> = [{ role: "system", content: system }];
  for (const message of recent) {
    if (message.role === "user" || message.role === "assistant") {
      messages.push({ role: message.role, content: message.text });
    }
  }
  if (req.images && req.images.length > 0) {
    const content: OpenAIContent[] = req.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    }));
    content.push({ type: "text", text: req.userPrompt });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: req.userPrompt });
  }

  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    signal: req.signal,
    body: JSON.stringify({ model, stream: true, messages }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`${providerLabel} API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const event = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
      const delta = event.choices?.[0]?.delta?.content;
      if (!delta) continue;
      acc += delta;
      const now = Date.now();
      if (now - lastEmit > 80) {
        events.onPartial(acc);
        lastEmit = now;
      }
    } catch {
      // Provider ping or non-content event.
    }
  }
  return {
    text: acc.trim(),
    workforcePermissionEnforcement: workforceZeroToolsEnforcement(
      req,
      "byok",
      ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
    ),
  };
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
  const key = await readApiKey("openai");
  if (!key) throw new Error(tStatus(req.locale, "errKeyMissingOpenAI"));

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const { model, recent, system } = prepareContext("openai", req, events);

  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string | OpenAIContent[];
  }> = [{ role: "system", content: system }];
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.text });
    }
  }

  if (req.images && req.images.length > 0) {
    const content: OpenAIContent[] = req.images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    }));
    content.push({ type: "text", text: req.userPrompt });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: req.userPrompt });
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    signal: req.signal,
    body: JSON.stringify({
      model,
      stream: true,
      messages,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const event = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = event.choices?.[0]?.delta?.content;
      if (delta) {
        acc += delta;
        const now = Date.now();
        if (now - lastEmit > 80) {
          events.onPartial(acc);
          lastEmit = now;
        }
      }
    } catch {
      // 무시
    }
  }
  return {
    text: acc.trim(),
    workforcePermissionEnforcement: workforceZeroToolsEnforcement(
      req,
      "byok",
      ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
    ),
  };
};

// ── Upstage Solar (OpenAI-compatible; Korean sovereign LLM) ──────
export const runUpstageByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const key = await readApiKey("upstage");
  if (!key) throw new Error("Upstage Solar API key missing (Settings → BYOK)");

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const { model, recent, system } = prepareContext("upstage", req, events);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
  ];
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: m.text });
  }
  messages.push({ role: "user", content: req.userPrompt });

  const resp = await fetch("https://api.upstage.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    signal: req.signal,
    body: JSON.stringify({ model, stream: true, messages }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Upstage API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const event = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
      const delta = event.choices?.[0]?.delta?.content;
      if (delta) {
        acc += delta;
        const now = Date.now();
        if (now - lastEmit > 80) {
          events.onPartial(acc);
          lastEmit = now;
        }
      }
    } catch {
      // ignore
    }
  }
  return {
    text: acc.trim(),
    workforcePermissionEnforcement: workforceZeroToolsEnforcement(
      req,
      "byok",
      ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
    ),
  };
};

import { getDb } from "../store/db";

// ── Custom OpenAI-compatible ─────────────────────────────
export const runCustomByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const key = await readApiKey("custom");
  if (!key) throw new Error("Custom API key missing (Settings → BYOK)");

  let baseUrl = "https://api.openai.com/v1";
  try {
    const row = getDb().prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get() as { value: string } | undefined;
    if (row?.value) {
      baseUrl = row.value.trim().replace(/\/$/, "");
    }
  } catch {}

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const { model, recent, system } = prepareContext("custom", req, events);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string | OpenAIContent[] }> = [
    { role: "system", content: system },
  ];
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.text });
    }
  }

  if (req.images && req.images.length > 0) {
    const content: OpenAIContent[] = req.images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    }));
    content.push({ type: "text", text: req.userPrompt });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: req.userPrompt });
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    signal: req.signal,
    body: JSON.stringify({ model, stream: true, messages }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Custom API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const event = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
      const delta = event.choices?.[0]?.delta?.content;
      if (delta) {
        acc += delta;
        const now = Date.now();
        if (now - lastEmit > 80) {
          events.onPartial(acc);
          lastEmit = now;
        }
      }
    } catch {
      // ignore
    }
  }
  return {
    text: acc.trim(),
    workforcePermissionEnforcement: workforceZeroToolsEnforcement(
      req,
      "byok",
      ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
    ),
  };
};

// ── Google Generative (Gemini) ───────────────────────────
// SSE는 :streamGenerateContent?alt=sse 엔드포인트.
export const runGoogleByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const key = await readApiKey("google");
  if (!key) throw new Error(tStatus(req.locale, "errKeyMissingGoogle"));

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const { model, recent, system } = prepareContext("google", req, events);

  type GooglePart =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } };
  const contents: Array<{ role: "user" | "model"; parts: GooglePart[] }> = [];
  for (const m of recent) {
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.text }] });
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

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: req.signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Google API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const event = JSON.parse(payload) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = event.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        acc += text;
        const now = Date.now();
        if (now - lastEmit > 80) {
          events.onPartial(acc);
          lastEmit = now;
        }
      }
    } catch {
      // 무시
    }
  }
  return {
    text: acc.trim(),
    workforcePermissionEnforcement: workforceZeroToolsEnforcement(
      req,
      "byok",
      ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
    ),
  };
};
