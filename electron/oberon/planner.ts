import { app } from "electron";
import { promises as fs } from "fs";
import path from "path";
import type {
  JsonObject,
  OberonPlanRequest,
  OberonPlanResult,
  OberonPlanRuntime,
} from "../../shared/types";
import { runClaudeCode } from "../runtime/claude-code";
import { runCodex } from "../runtime/codex";
import { runGemini } from "../runtime/gemini";
import type { Runner } from "../runtime/runner";

const RUNTIMES: Record<OberonPlanRuntime, { label: string; runner: Runner }> = {
  "claude-code": { label: "Claude Code", runner: runClaudeCode },
  codex: { label: "Codex CLI", runner: runCodex },
  gemini: { label: "Antigravity CLI", runner: runGemini },
};

export async function planOberonWithCli(request: OberonPlanRequest): Promise<OberonPlanResult> {
  const ordered = runtimeOrder(request.runtime);
  const warnings: string[] = [];
  const startedAt = Date.now();

  for (const runtime of ordered) {
    const entry = RUNTIMES[runtime];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    let rawText = "";
    try {
      const cwd = path.join(app.getPath("userData"), "oberon", "planner");
      await fs.mkdir(cwd, { recursive: true });
      const result = await entry.runner(
        {
          systemPrompt: [
            "You are Oberon, an AI film studio showrunner and director.",
            "Return only valid JSON. No markdown fences, no prose.",
            "Your job is to improve the user's film brief, not to generate files.",
            "Think like a working DP + screenwriter: a sharp logline, a concrete visual direction (lighting, palette, lens feel, references), tone words that map to real cinematography, and named characters with lockable identity traits.",
            "Favour coverage-driven, multi-shot storytelling over single long takes; respect the format's pacing and runtime.",
            // 연속성 우선(continuity-first) 독트린 — 개별 샷 품질보다 "샷끼리 실제로 이어지는가"가 승부처다.
            "CONTINUITY FIRST: short-form AI video fails when the world drifts (wardrobe color changes, golden hour jumps to night, the location morphs). Write character descriptions as LOCKABLE specs — exact wardrobe colors/materials, hair, one signature visual detail — and pin the setting to one concrete time of day, weather and light direction.",
            "HOOK: structure the opening 1.5 seconds as stinger (0-0.5s, one arresting visual) → dissonance (0.5-1.5s, a single detail that feels off) → payoff begins. Bake this into the synopsis.",
            "For commercials, the final beat is always the product + slogan key visual. Audio for commercials defaults to NO BGM — dialogue plus ambient SFX only; put that in mustInclude/mustAvoid when relevant.",
            "Vary camera language across beats — no two adjacent beats share the same angle/composition.",
            "Where dialogue or narration helps, keep lines short, speakable, and in the brief's language so they can be lip-synced and captioned downstream.",
            // 시네마틱 이미지 생성 가이드(율파파) 독트린 — 아래 인용 문장은 가이드 원문 그대로다.
            // 전문 사본: docs/oberon-cinematic-guide/ch1~10.md, 빌더: shared/oberon-cinematic-guide.ts
            "CINEMATIC GUIDE WORKFLOW (follow verbatim): 흐름은 단일 컷으로 의도 확인 → 3x3 그리드로 커버리지 → 개별 추출 → 수정 → 영상화·편집입니다. 그리드는 한 번에 완벽하게 나오지 않습니다. 쓸 만한 패널만 셀렉트하거나, 행별 샷을 지정해 재생성하세요. 추출 후에는 180도 법칙 위반 같은 세부 수정을 거쳐 편집으로 넘어갑니다.",
            "CINEMATIC GUIDE SHOT ELEMENTS: 한 컷의 기본 요소는 네 가지 — 프레이밍(얼마나 가까이), 앵글(어디서), 조명(어떤 빛), 색감(어떤 톤). 프롬프트에 이 네 가지 정보가 들어가야 원하는 시네마틱 컷이 나옵니다. 장면의 감정은 네 개의 레버로 조절합니다 — 조명, 필름·질감, 구도·앵글, 색. 네 개를 전부 밀어붙이지 말고, 장면마다 한두 개만 확실히 밀어주세요.",
            "CINEMATIC GUIDE PROMPT RULES: 하나의 프롬프트에는 하나의 순간만 담습니다. 감정은 조명, 색감, 프레이밍으로 번역해야 합니다. 구체적인 시각 정보(샷 사이즈, 조명 방향, 렌즈 느낌)가 추상적 품질 키워드보다 훨씬 효과적입니다. 'cinematic, photorealistic, film grain' 정도면 충분합니다. 처음에는 6하원칙(누가·언제·어디서·어떻게·무엇을·왜)으로 시작하세요.",
            "Keep the output compact and safe for deterministic downstream planning.",
          ].join("\n"),
          history: [],
          userPrompt: buildPrompt(request),
          backendLabel: runtime === request.runtime ? request.runtimeLabel || entry.label : entry.label,
          permission: "read",
          cwd,
          signal: controller.signal,
          locale: "ko",
        },
        {
          onPartial: (chunk) => {
            rawText = chunk || rawText;
          },
          onStatus: () => {},
        },
      );
      rawText = result.text || rawText;
      const parsed = extractJsonObject(rawText);
      if (!parsed) throw new Error("CLI did not return a JSON object.");
      return {
        ok: true,
        runtime,
        runtimeLabel: runtime === request.runtime ? request.runtimeLabel || entry.label : entry.label,
        patch: parsed,
        rawText,
        warnings,
        createdAtMs: startedAt,
      };
    } catch (error: unknown) {
      warnings.push(`${entry.label}: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    runtime: request.runtime || ordered[0],
    runtimeLabel: request.runtimeLabel || RUNTIMES[ordered[0]].label,
    error: "No configured CLI planner returned usable JSON.",
    warnings,
    createdAtMs: startedAt,
  };
}

function buildPrompt(request: OberonPlanRequest): string {
  return JSON.stringify(
    {
      task: "Improve this Oberon film brief. Return JSON with only these optional fields: title, format, genre, aspect, durationSec, logline, synopsis, audience, tone, visualReferences, characters, setting, brandOrProduct, mustInclude, mustAvoid, language.",
      rules: [
        "Do not invent unavailable APIs or claim media was generated.",
        "tone, visualReferences, mustInclude, mustAvoid must be arrays of strings.",
        "characters must be an array of { name, role, description }.",
        "format must be one of commercial_30, commercial_60, trailer, short_drama, music_video, cinematic_short, social_short.",
        "genre must be one of commercial, drama, action, thriller, romance, scifi, documentary, fantasy, horror, comedy.",
        "aspect must be one of 16:9, 9:16, 1:1, 2.39:1, 4:5.",
        "language must be ko or en.",
      ],
      premium: request.premium === true,
      brief: request.brief,
    },
    null,
    2,
  );
}

function runtimeOrder(runtime?: string): OberonPlanRuntime[] {
  const requested = isPlanRuntime(runtime) ? runtime : "claude-code";
  return Array.from(new Set<OberonPlanRuntime>([requested, "codex", "claude-code", "gemini"]));
}

function isPlanRuntime(value?: string): value is OberonPlanRuntime {
  return value === "claude-code" || value === "codex" || value === "gemini";
}

function extractJsonObject(text: string): JsonObject | null {
  const trimmed = text.trim();
  const direct = parseObject(trimmed);
  if (direct) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = parseObject(fenced.trim());
    if (parsed) return parsed;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return parseObject(trimmed.slice(first, last + 1));
  return null;
}

function parseObject(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    return null;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
