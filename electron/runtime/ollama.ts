// Ollama 로컬 LLM — 감지 + 실호출.
// 사용자 머신에서 도는 오픈 모델(gemma / deepseek / llama 등)을 호출한다.
// API 키 불필요, 클라우드 미경유 — 완전 로컬. (PRD §3.1 BYOC의 로컬 변형)
//
// Ollama는 OpenAI 호환 엔드포인트를 제공한다:
//   - 모델 목록: GET  {host}/api/tags        → { models: [{ name }] }
//   - 서버 버전: GET  {host}/api/version      → { version }
//   - 채팅 SSE:  POST {host}/v1/chat/completions  (OpenAI Chat Completions 호환)
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { compactHistory } from "./compact";

/** 기본 로컬 호스트. env OLLAMA_HOST로 재정의 가능(원격 Ollama도 지원). */
export function ollamaHost(): string {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return "http://localhost:11434";
  // "localhost:11434"처럼 스킴이 없으면 http:// 보정
  return /^https?:\/\//.test(raw) ? raw.replace(/\/$/, "") : `http://${raw.replace(/\/$/, "")}`;
}

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

// ── OpenAI 호환 SSE 라인 파서 (byok.ts와 동일 포맷) ──────────
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

type OllamaContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export const runOllama: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const host = ollamaHost();
  const model = req.model?.trim();
  if (!model) {
    throw new Error(tStatus(req.locale, "errOllamaNoModel"));
  }

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  // 로컬 모델은 컨텍스트 윈도우가 천차만별 — 보수적 기본값으로 무한 성장/거부 방지.
  const { recent, digest, droppedCount } = compactHistory(req.history, {
    contextWindow: 32_000,
    locale: req.locale,
  });
  if (digest) events.onStatus(tStatus(req.locale, "compacted", { n: droppedCount }));
  const systemText = digest ? `${req.systemPrompt}\n\n${digest}` : req.systemPrompt;

  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string | OllamaContent[];
  }> = [{ role: "system", content: wrapSystemPrompt(systemText, req.locale, req.permission, req.userPrompt) }];
  for (const m of recent) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.text });
    }
  }

  // 비전 모델이면 image_url(OpenAI 호환)로 첨부. 텍스트 모델은 조용히 무시한다.
  if (req.images && req.images.length > 0) {
    const content: OllamaContent[] = req.images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    }));
    content.push({ type: "text", text: req.userPrompt });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: req.userPrompt });
  }

  let resp: Response;
  try {
    resp = await fetch(`${host}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({ model, stream: true, messages }),
    });
  } catch {
    throw new Error(tStatus(req.locale, "errOllamaUnreachable", { host }));
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Ollama ${resp.status}: ${errText.slice(0, 300)}`);
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
      // 빈 줄 / keep-alive — 무시
    }
  }
  return { text: acc.trim() };
};
