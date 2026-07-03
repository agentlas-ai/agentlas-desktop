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

interface TokenCandidate {
  token: string;
  /** epoch ms, 알 수 없으면 null */
  expiresAt: number | null;
  source: string;
}

// 후보 전부 수집(keychain 우선, 파일 폴백) — 첫 후보만 쓰면 파일에 남은 옛 만료 토큰이
// keychain의 새 토큰을 영원히 가리는 함정("재로그인해도 fetch failed")이 생긴다.
async function readClaudeTokens(): Promise<{ candidates: TokenCandidate[]; keychainBlocked: boolean }> {
  const items: Array<{ item: Record<string, unknown>; source: string }> = [];
  // "항목이 없다"(=진짜 미로그인)와 "GUI 프로세스가 키체인 접근을 거부당함/응답 못 받음"을 구분한다 —
  // 후자를 null(미연결)로 삼키면 대시보드가 영원히 "연결됨"만 보여주고 사용량 바가 안 뜬다.
  let keychainBlocked = false;
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileP(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        // GUI 앱 최초 접근은 macOS 키체인 허용 다이얼로그가 뜬다 — 5초 타임아웃이면 사용자가
        // "허용"을 누르기 전에 죽어 영구 실패처럼 보인다. 다이얼로그 응답 여유를 준다.
        { timeout: 20_000 },
      );
      items.push({ item: JSON.parse(stdout), source: "keychain" });
    } catch (err) {
      // exit 44("could not be found") = 항목 없음(정상 미로그인). 그 외(거부/타임아웃/잠김)는 접근 차단.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/could not be found/i.test(msg)) keychainBlocked = true;
    }
  }
  for (const name of [".credentials.json", "credentials.json"]) {
    try {
      const raw = await readFile(path.join(os.homedir(), ".claude", name), "utf8");
      items.push({ item: JSON.parse(raw), source: name });
    } catch {
      // 없음
    }
  }
  const out: TokenCandidate[] = [];
  const seen = new Set<string>();
  for (const { item, source } of items) {
    const oauth = (item?.claudeAiOauth ?? item?.claude_ai_oauth) as
      | Record<string, unknown>
      | undefined;
    const token =
      (oauth?.accessToken as string) ??
      (oauth?.access_token as string) ??
      (item?.accessToken as string) ??
      (item?.access_token as string);
    if (typeof token !== "string" || !token || seen.has(token)) continue;
    seen.add(token);
    const rawExp = oauth?.expiresAt ?? oauth?.expires_at ?? item?.expiresAt ?? item?.expires_at;
    const exp = Number(rawExp);
    out.push({ token, expiresAt: Number.isFinite(exp) && exp > 0 ? exp : null, source });
  }
  return { candidates: out, keychainBlocked };
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
  const { candidates, keychainBlocked } = await readClaudeTokens();

  const base = {
    provider: "claude-code",
    backend: "anthropic" as const,
    label: "Claude Code",
    fetchedAt: Date.now(),
  };
  // 토큰 후보 0 + 키체인 접근 차단 = 미연결이 아니라 "조회 불가" — 정직하게 표면화(재시도/재로그인 액션).
  if (!candidates.length && keychainBlocked) {
    return { ...base, status: "error", windows: [], error: "keychain_blocked" };
  }
  // 토큰 없음 = 미연결 → 스냅샷에서 제외 (연결 칩은 runtime.detect가 담당)
  if (!candidates.length) return null;

  // 만료 안 된 후보만 — 전부 만료면 재로그인 안내(auth_expired).
  const now = Date.now();
  const fresh = candidates.filter((c) => c.expiresAt == null || c.expiresAt > now + 30_000);
  if (!fresh.length) return { ...base, status: "error", windows: [], error: "auth_expired" };

  let lastErr = "";
  for (const cand of fresh) {
    try {
      return await fetchUsageWith(cand.token, base);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      // 401/403 = 이 토큰이 죽은 것 → 다음 후보. 그 외(네트워크 등)는 후보 무관 → 중단.
      if (!/HTTP 40[13]/.test(lastErr)) break;
    }
  }
  return {
    ...base,
    status: "error",
    windows: [],
    error: /HTTP 40[13]/.test(lastErr) ? "auth_expired" : lastErr,
  };
}

async function fetchUsageWith(
  token: string,
  base: Omit<ProviderUsage, "status" | "windows">,
): Promise<ProviderUsage> {
  {
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
  }
}
