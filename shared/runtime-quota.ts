/**
 * 사용량 한도로 모델을 건너뛰는 단 하나의 기준.
 *
 * 기준이 두 벌로 갈라져 있었다: 역할 풀 선택은 `detect.ts` 에서 90%, 실제 실행 선택은
 * `selection.ts` 에서 100% 였다. 그래서 주간 사용량 90% 인 Codex 가 화면에는
 * "Quota exceeded · skipped" 로 뜨는데 실행 판정은 멀쩡히 통과하는 상태가 됐다
 * (오너 신고 2026-09-14: "10% 남았는데 왜"). 화면과 동작이 갈린 것이고, 남은 10% 는
 * 매주 그대로 버려졌다.
 *
 * `detect.ts` 의 그 상수 바로 위 주석이 이미 이렇게 적고 있었다 — *"detect 본체와 UI
 * 조회가 같은 규칙을 쓰게 한 곳에 둔다. 두 벌로 두면 한쪽만 고쳐져 '설정 화면과 실제
 * 실행이 다른 모델'이 된다."* 그 경고가 맞았는데, 정작 두 번째 벌이 다른 파일에 있었다.
 *
 * 오너 결정 2026-09-14: **100 으로 통일한다.** 한도가 실제로 소진됐을 때만 건너뛴다.
 * 90% 에서 미리 손을 떼면 쓸 수 있는 몫을 버리는 것이고, "규제는 적게, 자율은 많이,
 * 막을 것은 자원 폭주뿐" 이라는 같은 날 결정과도 어긋난다. 한도가 진짜로 소진되면
 * 실행 실패 경로가 따로 받아 낸다.
 */
import type { ProviderUsage, UsageWindow } from "./types";

export const QUOTA_EXHAUSTED_PERCENT = 100;

/** 이 사용률이면 자동 선택에서 건너뛴다. 사용률을 모르면(null) 건너뛰지 않는다. */
export function quotaExhausted(usedPercent: number | null | undefined): boolean {
  return typeof usedPercent === "number" && Number.isFinite(usedPercent) && usedPercent >= QUOTA_EXHAUSTED_PERCENT;
}

/** Provider-owned paid allowance. A balance never overrides its spending cap. */
export function providerHasUsableCredits(usage: Pick<ProviderUsage, "credits" | "spendControlReached" | "stale">): boolean {
  const credits = usage.credits;
  return usage.stale !== true && usage.spendControlReached !== true && credits?.hasCredits === true
    && credits.spendAllowed !== false
    && credits.overageLimitReached !== true
    && (credits.unlimited === true || (typeof credits.balance === "number" && Number.isFinite(credits.balance) && credits.balance > 0));
}

/** Admission hint only: the provider still decides whether funded extra use is
 * available. Remaining monthly spend allowance is not a wallet balance. */
export function providerHasUsableExtraUsage(usage: Pick<ProviderUsage, "extraUsage" | "spendControlReached" | "stale">): boolean {
  const extra = usage.extraUsage;
  if (usage.stale === true || usage.spendControlReached === true || extra?.enabled !== true) return false;
  if (quotaExhausted(extra.utilization)) return false;
  if (extra.unlimited === true) return true;
  if (typeof extra.monthlyLimit !== "number" || !Number.isFinite(extra.monthlyLimit) || extra.monthlyLimit <= 0) return false;
  if (typeof extra.usedCredits === "number" && Number.isFinite(extra.usedCredits) && extra.usedCredits >= 0)
    return extra.usedCredits < extra.monthlyLimit;
  return typeof extra.utilization === "number" && Number.isFinite(extra.utilization) && extra.utilization >= 0;
}

/** Legacy saved Claude extra_usage windows also remain spending controls. */
export function isPaidOverageUsageWindow(window: Pick<UsageWindow, "id" | "quotaRole">, providerId?: string): boolean {
  return window.quotaRole === "paid-overage" || (providerId === "claude-code" && window.id === "extra_usage");
}

function usageWindowMatchesModel(window: Pick<UsageWindow, "model">, model: string | undefined, providerId: string | undefined): boolean {
  return !model || !window.model || window.model === model
    || (providerId === "claude-code" && ["opus", "sonnet", "haiku"].includes(window.model)
      && model.startsWith(`claude-${window.model}-`));
}

/** Selection authority shared by Main and display: subscription exhaustion can
 * continue on the same provider's usable credits; monthly/spending caps cannot.
 * The caller owns snapshot freshness and measured runtime failures/cooldowns. */
export function providerQuotaExhausted(
  usage: Pick<ProviderUsage, "credits" | "extraUsage" | "spendControlReached" | "limits" | "windows" | "stale">,
  now = Date.now(), model?: string, providerId?: string,
): boolean {
  const limits = (usage.limits ?? []).filter(limit => usageWindowMatchesModel(limit, model, providerId));
  const applicable = usage.windows.filter(window => usageWindowMatchesModel(window, model, providerId)
    && !(typeof window.resetAt === "number" && Number.isFinite(window.resetAt) && window.resetAt <= now));
  if (usage.spendControlReached === true || limits.some(limit => limit.spendControlReached === true)) return true;
  for (const window of applicable) {
    // An exhausted paid allowance cannot consume the still-available included
    // subscription. It only prevents bypassing an exhausted subscription below.
    if (isPaidOverageUsageWindow(window, providerId)) continue;
    if (!quotaExhausted(window.usedPercent)) continue;
    if (window.kind === "monthly") return true;
    const limit = limits.find(item => item.limitId === (window.limitId ?? null));
    const creditUsage = limit ? { credits: limit.credits, spendControlReached: limit.spendControlReached === true, stale: usage.stale } : usage;
    if (!providerHasUsableCredits(creditUsage) && !providerHasUsableExtraUsage(usage)) return true;
  }
  // A machine limit flag can report exhaustion without a percentage window.
  for (const limit of limits) {
    if (limit.limitReached !== true) continue;
    const windows = usage.windows.filter(window => (window.limitId ?? null) === limit.limitId);
    if (windows.length && !applicable.some(window => (window.limitId ?? null) === limit.limitId)) continue;
    if (!providerHasUsableCredits({ credits: limit.credits, spendControlReached: limit.spendControlReached === true, stale: usage.stale })
      && !providerHasUsableExtraUsage(usage)) return true;
  }
  return false;
}

/** Accept only the normalized timestamp carried by Main's typed failure. No
 * provider prose or elapsed-time guess may establish a reset time. */
export function quotaRetryAfterAt(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : null;
}

/** Display-only provider observation. It never changes cooldowns, schedules,
 * or permission to resume an action whose outside effect is unresolved. */
export function formatRuntimeQuotaReset(
  retryAfterAt: unknown, locale: "ko" | "en", timeZone?: string, now = Date.now(),
): string | null {
  const at = quotaRetryAfterAt(retryAfterAt);
  if (!at) return null;
  let zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let formatted: string;
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  try { formatted = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { ...options, timeZone: zone }).format(new Date(at)); }
  catch { zone = "UTC"; formatted = new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { ...options, timeZone: zone }).format(new Date(at)); }
  const elapsed = Date.parse(at) <= now;
  return locale === "ko"
    ? `제공자가 안내한 한도 재개 시각: ${formatted} (${zone}).${elapsed ? " 이 시각은 지났으며 현재 사용 가능 여부는 확인되지 않았습니다." : ""}`
    : `Provider-reported quota reset: ${formatted} (${zone}).${elapsed ? " That time has passed; current availability has not been verified." : ""}`;
}

export function runtimeQuotaFailureMessage(input: {
  runtime: string; locale: "ko" | "en"; retryAfterAt?: unknown; unattended: boolean; timeZone?: string; now?: number;
}): string {
  const ko = input.locale === "ko";
  const reset = formatRuntimeQuotaReset(input.retryAfterAt, input.locale, input.timeZone, input.now);
  const message = input.unattended
    ? ko ? `${input.runtime} 사용 한도로 백그라운드 실행이 멈췄습니다. 이번 실행의 결과와 실행 모델 상태를 확인하세요.`
      : `This background run stopped at ${input.runtime}'s usage limit. Review this run's recorded results and runtime status.`
    : ko ? `${input.runtime} 사용 한도가 찼습니다. 다른 모델을 선택하거나 한도 상태를 확인하세요.`
      : `${input.runtime} has hit its usage limit. Choose another model or check its quota status.`;
  return [message, reset].filter(Boolean).join(" ");
}
