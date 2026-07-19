"use client";

import type { OneExperienceReuseRecord } from "@/lib/types";
import styles from "./OneExperienceReuseCard.module.css";

export function OneExperienceReuseCard({
  record,
  locale,
  onManage,
}: {
  record: OneExperienceReuseRecord;
  locale: "ko" | "en";
  onManage: () => void;
}) {
  const ko = locale === "ko";
  const assets = record.receipt.assetBindings.length;
  const sourceTasks = new Set(record.receipt.assetBindings.map((item) => item.sourceTaskId)).size;
  return (
    <aside className={styles.card} aria-label={ko ? "이번 일에 적용한 기억" : "Memory applied to this work"}>
      <span className={styles.mark} aria-hidden="true">↻</span>
      <div>
        <strong>{ko ? "지난번에 잘 맞았던 기준을 적용했어요" : "One applied what worked well last time"}</strong>
        <p>
          {ko
            ? `직접 승인한 이전 결과 ${sourceTasks}개에서 관련 기준 ${assets}개만 가져왔어요. 이번 결과가 실제로 더 좋아졌는지는 별도로 확인합니다.`
            : `One used ${assets} relevant item(s) from ${sourceTasks} earlier result(s) you approved. Whether this result improved is verified separately.`}
        </p>
        <button type="button" className={styles.manage} onClick={onManage}>
          {ko ? "적용한 기준 보기" : "See what was applied"}
        </button>
      </div>
    </aside>
  );
}
