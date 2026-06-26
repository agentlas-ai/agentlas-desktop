// Claude Code 구독 사용량 — Claude Code OAuth usage 엔드포인트.
// 토큰: macOS Keychain "Claude Code-credentials" → claudeAiOauth.accessToken
//       (폴백 ~/.claude/.credentials.json · credentials.json)
// 응답: { five_hour, seven_day, seven_day_opus, seven_day_sonnet, extra_usage }
//       각 창 used_percentage·resets_at·is_enabled / extra_usage는 월 크레딧.
// (방식 출처: oss agentcat-connectors)
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderUsage, UsageWindow } from "../../shared/types";
import { getJson, toPercent, toResetMs } from "./util";

const execFileP = promisify(execFile);
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

async function readClaudeToken(): Promise<string | null> {
  const candidates: Array<Record<string, unknown>> = [];
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileP(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5000 },
      );
      candidates.push(JSON.parse(stdout));
    } catch {
      // 키체인 항목 없음 — 파일 폴백
    }
  }
  for (const name of [".credentials.json", "credentials.json"]) {
    try {
      const raw = await readFile(path.join(os.homedir(), ".claude", name), "utf8");
      candidates.push(JSON.parse(raw));
    } catch {
      // 없음
    }
  }
  for (const item of candidates) {
    const oauth = (item?.claudeAiOauth ?? item?.claude_ai_oauth) as
      | Record<string, unknown>
      | undefined;
    const token =
      (oauth?.accessToken as string) ??
      (oauth?.access_token as string) ??
      (item?.accessToken as string) ??
      (item?.access_token as string);
    if (typeof token === "string" && token) return token;
  }
  return null;
}

// 안정 id → 영문 기본 라벨. 표시 로컬라이즈는 렌더러가 kind/model로 재계산.
const LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly (7d)",
  seven_day_opus: "Opus 7d",
  seven_day_sonnet: "Sonnet 7d",
  extra_usage: "Extra credits",
};

export async function getClaudeUsage(): Promise<ProviderUsage | null> {
  const token = await readClaudeToken();
  // 토큰 없음 = 미연결 → 스냅샷에서 제외 (연결 칩은 runtime.detect가 담당)
  if (!token) return null;

  const base = {
    provider: "claude-code",
    backend: "anthropic" as const,
    label: "Claude Code",
    fetchedAt: Date.now(),
  };
  try {
    const payload = (await getJson(CLAUDE_USAGE_URL, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.69",
    })) as Record<string, unknown>;

    const windows: UsageWindow[] = [];
    for (const [key, raw] of Object.entries(payload ?? {})) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      if (e.is_enabled === false) continue;

      if (key === "extra_usage" || e.monthly_limit != null) {
        const limit = Number(e.monthly_limit);
        const used = Number(e.used_credits ?? 0);
        if (Number.isFinite(limit) && limit > 0) {
          windows.push({
            id: key,
            label: LABELS[key] ?? "Extra credits",
            kind: "monthly",
            usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)),
            used,
            limit,
            unit: String(e.currency ?? "credits"),
          });
        }
        continue;
      }

      const pct = toPercent(e.utilization ?? e.used_percentage);
      if (pct == null) continue;
      windows.push({
        id: key,
        label: LABELS[key] ?? key,
        kind: key === "five_hour" ? "5h" : "7d",
        usedPercent: pct,
        resetAt: toResetMs(e.resets_at),
        model: key.includes("opus") ? "opus" : key.includes("sonnet") ? "sonnet" : null,
      });
    }

    // 5시간 → 주간 → 모델별 7일 → 월 크레딧
    const rank = (w: UsageWindow) =>
      w.id === "five_hour" ? 0 : w.id === "seven_day" ? 1 : w.kind === "monthly" ? 9 : 5;
    windows.sort((a, b) => rank(a) - rank(b));

    return { ...base, status: windows.length ? "ok" : "no_quota", windows };
  } catch (err) {
    return {
      ...base,
      status: "error",
      windows: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
