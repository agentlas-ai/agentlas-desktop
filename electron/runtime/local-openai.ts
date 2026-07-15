// OpenAI 호환 로컬 서버(LM Studio / MLX 등) 공용 감지 + 실호출.
// Ollama(runtime/ollama.ts)와 달리 이들은 "표준 OpenAI" 엔드포인트를 쓴다:
//   - 모델 목록: GET  {host}/v1/models           → { data: [{ id }] }
//   - 채팅 SSE:  POST {host}/v1/chat/completions  (OpenAI Chat Completions 호환)
// API 키 불필요, 클라우드 미경유 — 완전 로컬. (PRD §3.1 BYOC의 로컬 변형)
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { workforceZeroToolsEnforcement, wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";
import { compactHistory } from "./compact";

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

// ── OpenAI 호환 SSE 라인 파서 (ollama.ts / byok.ts와 동일 포맷) ──────────
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

type LocalContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * host를 바인딩해 OpenAI 호환 로컬 서버 채팅 Runner를 만든다.
 * hostFn은 호출 시점에 평가한다(env 재정의를 매 실행 반영).
 */
export function makeLocalOpenAiRunner(
  hostFn: () => string,
  runtimeKind: "lmstudio" | "mlx" = "lmstudio",
): Runner {
  return async (req: RunnerRequest, events: RunnerEvents): Promise<RunnerResult> => {
    const host = hostFn();
    const model = req.model?.trim();
    if (!model) {
      throw new Error(req.locale === "ko" ? "모델이 선택되지 않았습니다." : "No model selected.");
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
      content: string | LocalContent[];
    }> = [{
      role: "system",
      content: wrapSystemPrompt(
        systemText,
        req.locale,
        req.permission,
        req.userPrompt,
        req.forceSurface,
        req.restrictedReadBoundary,
        req.untrustedNoTools,
      ),
    }];
    for (const m of recent) {
      if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.text });
      }
    }

    // 비전 모델이면 image_url(OpenAI 호환)로 첨부. 텍스트 모델은 조용히 무시한다.
    if (req.images && req.images.length > 0) {
      const content: LocalContent[] = req.images.map((img) => ({
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
      throw new Error(
        req.locale === "ko"
          ? `로컬 서버에 연결할 수 없습니다: ${host}`
          : `Cannot reach local server: ${host}`,
      );
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`${host} ${resp.status}: ${errText.slice(0, 300)}`);
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
    return {
      text: acc.trim(),
      workforcePermissionEnforcement: workforceZeroToolsEnforcement(
        req,
        runtimeKind,
        ["filesystem", "shell", "browser", "mcp", "apps", "session_persistence"],
      ),
    };
  };
}
