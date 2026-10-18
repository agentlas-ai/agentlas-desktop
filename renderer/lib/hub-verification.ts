import type { Locale } from "@/lib/i18n";
import type { MarketplaceListing } from "@/lib/types";

export function isCallableHubListing(listing: MarketplaceListing): boolean {
  return listing.callable === true
    && listing.kind === "cloud-callable"
    && listing.routingReady !== false;
}

export function hubSecurityGradeLabel(listing: Pick<MarketplaceListing, "trustGrade">, locale: Locale): string {
  const ko = locale === "ko";
  if (listing.trustGrade === "A") return ko ? "보안 검사 A · 통과" : "Security scan A · passed";
  if (listing.trustGrade === "B") return ko ? "보안 검사 B · 경고 확인" : "Security scan B · review warnings";
  if (listing.trustGrade === "C") return ko ? "보안 검사 C · 차단" : "Security scan C · blocked";
  return ko ? "보안 검사 결과 없음" : "Security scan unverified";
}

export function hubSecurityGradeExplanation(locale: Locale): string {
  return locale === "ko"
    ? "제작자 평판이나 사용자 별점이 아니라, 현재 공개 패키지의 정적 보안 검사 결과입니다."
    : "This is the current public package's static security scan result, not a creator reputation or user rating.";
}

function shortDate(value: string, locale: Locale): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** 카드 한 줄에 들어갈 짧은 날짜 — 연도는 툴팁의 전체 문구가 말한다. */
function compactDate(value: string, locale: Locale): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

/** Only server-measured facts. No inferred stars, creator score, or popularity rank. */
export function hubVerificationFacts(
  listing: MarketplaceListing,
  locale: Locale,
  options?: { compact?: boolean },
): string[] {
  const ko = locale === "ko";
  const compact = options?.compact === true;
  const facts: string[] = [];
  const verified = Math.max(0, Math.floor(Number(listing.verifiedInvocations) || 0));
  if (verified > 0) {
    facts.push(compact
      ? (ko ? `검증 ${verified}` : `${verified} verified`)
      : (ko ? `검증 성공 ${verified}회` : `${verified} verified success${verified === 1 ? "" : "es"}`));
  }
  const lastSuccess = listing.lastRoutingSuccessAt
    ? (compact ? compactDate(listing.lastRoutingSuccessAt, locale) : shortDate(listing.lastRoutingSuccessAt, locale))
    : null;
  if (lastSuccess) {
    facts.push(compact
      ? (ko ? `최근 ${lastSuccess}` : `last ${lastSuccess}`)
      : (ko ? `최근 성공 ${lastSuccess}` : `Last success ${lastSuccess}`));
  }
  if (Number.isFinite(listing.recentFailureRate) && (verified > 0 || Number(listing.recentFailureRate) > 0)) {
    const percent = Math.round(Math.max(0, Math.min(1, Number(listing.recentFailureRate))) * 100);
    /*
     * 짧은 형태에서는 **실패가 있을 때만** 적는다. "0% 실패"는 좁은 카드 줄에서
     * 뒤의 다른 사실을 밀어낼 만큼 자리를 먹는데(실측 ~55px), 나쁜 소식이 없다는 뜻이라
     * 굳이 그 자리를 살 이유가 없다. 전체 문구(툴팁)에는 그대로 남는다.
     */
    if (!compact || percent > 0) {
      facts.push(compact
        ? (ko ? `실패 ${percent}%` : `${percent}% fail`)
        : (ko ? `최근 실패율 ${percent}%` : `Recent failure rate ${percent}%`));
    }
  }
  return facts;
}
