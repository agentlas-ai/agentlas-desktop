"use client";

import { tFor } from "@/lib/i18n";
import type { OneExperienceReuseRecord } from "@/lib/types";
import styles from "./OneExperienceReuseCard.module.css";

type ReuseFallbackKey = "one.reuse.title" | "one.reuse.manage";

const REUSE_FALLBACKS: Record<ReuseFallbackKey, Record<"ko" | "en", string>> = {
  "one.reuse.title": { ko: "지난번에 잘 맞았던 기준을 적용했어요", en: "One applied what worked well last time" },
  "one.reuse.manage": { ko: "적용한 기준 보기", en: "See what was applied" },
};

function reuseCopy(locale: "ko" | "en", key: ReuseFallbackKey): string {
  const value = tFor(locale, key);
  return value === key ? REUSE_FALLBACKS[key][locale] : value;
}

function reuseBody(locale: "ko" | "en", sourceTasks: number, assets: number): string {
  const key = "one.reuse.body" as const;
  const value = tFor(locale, key, { sourceTasks, assets });
  if (value !== key) return value;
  return locale === "ko"
    ? `직접 승인한 이전 결과 ${sourceTasks}개에서 관련 기준 ${assets}개만 가져왔어요. 이번 결과가 실제로 더 좋아졌는지는 별도로 확인합니다.`
    : `One used ${assets} relevant item(s) from ${sourceTasks} earlier result(s) you approved. Whether this result improved is verified separately.`;
}

export function OneExperienceReuseCard({
  record,
  locale,
  onManage,
}: {
  record: OneExperienceReuseRecord;
  locale: "ko" | "en";
  onManage: () => void;
}) {
  const assets = record.receipt.assetBindings.length;
  const sourceTasks = new Set(record.receipt.assetBindings.map((item) => item.sourceTaskId)).size;
  return (
    <aside className={styles.card} aria-label={tFor(locale, "one.reuse.aria")}>
      <span className={styles.mark} aria-hidden="true">↻</span>
      <div>
        <strong>{reuseCopy(locale, "one.reuse.title")}</strong>
        <p>
          {reuseBody(locale, sourceTasks, assets)}
        </p>
        <button type="button" className={styles.manage} onClick={onManage}>
          {reuseCopy(locale, "one.reuse.manage")}
        </button>
      </div>
    </aside>
  );
}
