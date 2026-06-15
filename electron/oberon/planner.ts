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
  gemini: { label: "Gemini CLI", runner: runGemini },
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
            "You are Oberon, an AI film studio showrunner.",
            "Return only valid JSON. No markdown fences, no prose.",
            "Your job is to improve the user's film brief, not to generate files.",
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
