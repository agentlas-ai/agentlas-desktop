"use client";

import { useRouter } from "next/navigation";
import { attentionLabel, openAttentionEntry, useAttention } from "@/lib/attention";
import styles from "./AttentionDot.module.css";

/**
 * 파란 점 하나 — 승인·질문 대기나 아직 안 본 결과가 **화면 밖에** 있다는 표시.
 * 읽는 이름은 "승인 대기 2건" / "2 pending approvals". onClick 이 있으면 단추다.
 */
export function AttentionDot({
  counts,
  locale,
  onClick,
  className,
  testId,
}: {
  counts: { approvals: number; results: number } | null | undefined;
  locale: "ko" | "en";
  onClick?: () => void;
  className?: string;
  testId?: string;
}) {
  if (!counts || counts.approvals + counts.results <= 0) return null;
  const label = attentionLabel(counts, locale);
  const kind = counts.approvals > 0 ? "approval" : "result";
  if (onClick) {
    return (
      <button
        type="button"
        className={`${styles.dot} ${styles.button} ${className ?? ""}`}
        aria-label={label}
        title={label}
        data-attention-dot={kind}
        data-testid={testId}
        onClick={(event) => { event.stopPropagation(); onClick(); }}
      />
    );
  }
  return (
    <span
      className={`${styles.dot} ${className ?? ""}`}
      role="img"
      aria-label={label}
      title={label}
      data-attention-dot={kind}
      data-testid={testId}
    />
  );
}

/**
 * 전환기가 가려진 동안만 보이는 대리 점 — 첫 실행 안내(WorkFirstRunOnboarding)는 창 전체를
 * 덮는 화면이라 좌측 위 전환기와 그 점이 보이지 않는다. 그 사이 온 승인을 오너가 알 길이
 * 없어지므로, 덮는 화면이 떠 있을 때만(CSS :has) 같은 점을 이름과 함께 그 위에 띄운다.
 * 전환기가 보이는 화면에서는 display:none 이다(scripts/qa-one-approval-onboarding-electron.cjs 가 잰다).
 */
export function AttentionCoveredSwitcherDot({ pathname, locale }: { pathname: string; locale: "ko" | "en" }) {
  const router = useRouter();
  const attention = useAttention(pathname);
  const first = attention.entries.find((entry) => entry.approvals > 0) ?? attention.entries[0] ?? null;
  if (!first) return null;
  const counts = { approvals: attention.approvals, results: attention.results };
  return (
    <button
      type="button"
      className={styles.covered}
      data-testid="attention-covered-switcher-dot"
      aria-label={attentionLabel(counts, locale)}
      onClick={() => { void openAttentionEntry(first, (href) => router.push(href)); }}
    >
      <span className={styles.dot} aria-hidden="true" />
      <span>{attentionLabel(counts, locale)}</span>
    </button>
  );
}
