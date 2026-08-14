import { app } from "electron";
import { promises as fs } from "fs";
import path from "path";
import type {
  JsonObject,
  OberonPlanRequest,
  OberonPlanResult,
  OberonPlanRuntime,
  OpenCrabEnrichment,
} from "../../shared/types";
import { runClaudeCode } from "../runtime/claude-code";
import { runCodex } from "../runtime/codex";
import { runAntigravity } from "../runtime/antigravity";
import type { Runner } from "../runtime/runner";
import {
  deriveOpenCrabMatchSignal,
  queryOpenCrabContext,
  type OpenCrabMatchSignal,
} from "../opencrab/ontology";

const RUNTIMES: Record<OberonPlanRuntime, { label: string; runner: Runner }> = {
  "claude-code": { label: "Claude Code", runner: runClaudeCode },
  codex: { label: "Codex CLI", runner: runCodex },
  antigravity: { label: "Antigravity", runner: runAntigravity },
};

export async function planOberonWithCli(request: OberonPlanRequest): Promise<OberonPlanResult> {
  const ordered = runtimeOrder(request.runtime);
  const warnings: string[] = [];
  const startedAt = Date.now();
  let openCrab: OpenCrabEnrichment | undefined;
  let openCrabSignal: OpenCrabMatchSignal | undefined;
  if (request.useOpenCrab === true) {
    const openCrabQuery = buildOpenCrabQuery(request.brief);
    const enrichment = await queryOpenCrabContext(openCrabQuery, {
      limit: 6,
      timeoutMs: 12_000,
      maxContextChars: 6_000,
    });
    openCrabSignal = enrichment.used
      ? deriveOpenCrabMatchSignal(openCrabQuery, enrichment.context)
      : undefined;
    openCrab = {
      requested: true,
      used: Boolean(openCrabSignal?.evidenceCount),
      reason: enrichment.reason,
      ...(openCrabSignal ? openCrabSignal : {}),
    };
  }

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
            // 커버리지 워크플로우 독트린 — 표준 촬영 문법을 Oberon 자체 표현으로 정리한 것.
            // 빌더/스캐폴드: shared/oberon-cinematic.ts
            "COVERAGE WORKFLOW: 단일 컷으로 의도를 먼저 확인한 뒤 커버리지 그리드(또는 4단 스택)로 여러 샷을 한 번에 뽑고, 쓸 패널만 골라 개별 추출하고, 180도 법칙 같은 연속성 오류를 수정한 다음 영상화·편집으로 넘긴다. 그리드는 한 번에 완벽히 나오지 않으니 부분 셀렉트나 행별 샷 지정 재생성을 전제로 계획한다.",
            "SHOT ELEMENTS: 각 컷은 프레이밍(샷 사이즈), 앵글, 조명, 색감 네 요소로 규정한다. 감정은 조명·질감·구도·색의 레버로 조절하되 한 장면에서 한두 레버만 확실히 밀어 과장을 피한다.",
            "PROMPT RULES: 한 프롬프트에는 한 순간만 담는다. 감정은 조명·색감·프레이밍 같은 구체적 시각 정보로 번역하고, 추상적 품질 키워드 나열은 피한다. 장면은 6하원칙(누가·언제·어디서·어떻게·무엇을·왜)으로 분해해 시작한다.",
            "Keep the output compact and safe for deterministic downstream planning.",
          ].join("\n"),
          history: [],
          userPrompt: buildPrompt(request, openCrabSignal),
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
        ...(openCrab ? { openCrab } : {}),
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
    ...(openCrab ? { openCrab } : {}),
  };
}

function buildPrompt(request: OberonPlanRequest, openCrabSignal?: OpenCrabMatchSignal): string {
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
      ...(openCrabSignal?.evidenceCount
        ? {
            openCrabMatchSignal: openCrabSignal,
            openCrabMatchSignalPolicy:
              "Main-owned metadata only; no ontology text is included. Use only to prioritize verification of terms already present in the user's brief.",
          }
        : {}),
    },
    null,
    2,
  );
}

export function buildOpenCrabQuery(brief: JsonObject): string {
  const source = brief as Record<string, unknown>;
  const hasLocalPathShape = (value: string): boolean => {
    const localPathPatterns = [
      /\bfile:\/\//i,
      /(?:^|[^A-Za-z0-9_])~[\\/]/,
      /(?:^|[^A-Za-z0-9_])\.{1,2}[\\/]/,
      /(?:^|[\s"'(<\[{=])\/\/[^\/\s]+\/[^\/\s]+/,
      /(?:^|[\s"'(<\[{=:])\/(?![\/\s])[^\s,;)}\]]+/,
      /(?:^|[\s"'(<\[{:=])\/(?:Applications|Library\/Application Support|Library|Users|home|Volumes|private|tmp|var|opt|etc|usr|bin|sbin|System|mnt|media|srv)(?:[\\/]|$)/i,
      /\\\\[^\\/\s]+[\\/][^\\/\s]+/,
      /\b[A-Za-z]:(?:[\\/]|[^\s,;)}\]]+[\\/])/,
    ];
    return localPathPatterns.some((pattern) => pattern.test(value));
  };
  const safeString = (value: unknown, max = 280): string | undefined => {
    if (typeof value !== "string") return undefined;
    const clean = value.replace(/\s+/g, " ").trim();
    if (!clean) return undefined;
    if (hasLocalPathShape(clean)) return undefined;
    return clean.slice(0, max);
  };
  const safeList = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const items = value.map((item) => safeString(item, 120)).filter((item): item is string => Boolean(item)).slice(0, 8);
    return items.length ? items : undefined;
  };
  return JSON.stringify({
    title: safeString(source.title, 160),
    format: safeString(source.format, 80),
    genre: safeString(source.genre, 80),
    logline: safeString(source.logline, 320),
    synopsis: safeString(source.synopsis, 420),
    audience: safeString(source.audience, 180),
    tone: safeList(source.tone),
    setting: safeString(source.setting, 220),
    brandOrProduct: safeString(source.brandOrProduct, 160),
    mustInclude: safeList(source.mustInclude),
  });
}

function runtimeOrder(runtime?: string): OberonPlanRuntime[] {
  const requested = isPlanRuntime(runtime) ? runtime : "claude-code";
  return Array.from(new Set<OberonPlanRuntime>([requested, "codex", "claude-code", "antigravity"]));
}

function isPlanRuntime(value?: string): value is OberonPlanRuntime {
  return value === "claude-code" || value === "codex" || value === "antigravity";
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
