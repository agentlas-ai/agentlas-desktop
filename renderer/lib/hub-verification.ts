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
  return ko ? "보안 검사 미확인" : "Security scan unverified";
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

/** Only server-measured facts. No inferred stars, creator score, or popularity rank. */
export function hubVerificationFacts(listing: MarketplaceListing, locale: Locale): string[] {
  const ko = locale === "ko";
  const facts: string[] = [];
  const verified = Math.max(0, Math.floor(Number(listing.verifiedInvocations) || 0));
  if (verified > 0) facts.push(ko ? `검증 성공 ${verified}회` : `${verified} verified success${verified === 1 ? "" : "es"}`);
  const lastSuccess = listing.lastRoutingSuccessAt ? shortDate(listing.lastRoutingSuccessAt, locale) : null;
  if (lastSuccess) facts.push(ko ? `최근 성공 ${lastSuccess}` : `Last success ${lastSuccess}`);
  if (Number.isFinite(listing.recentFailureRate) && (verified > 0 || Number(listing.recentFailureRate) > 0)) {
    const percent = Math.round(Math.max(0, Math.min(1, Number(listing.recentFailureRate))) * 100);
    facts.push(ko ? `최근 실패율 ${percent}%` : `Recent failure rate ${percent}%`);
  }
  return facts;
}
