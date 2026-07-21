"use client";

import { tFor } from "@/lib/i18n";
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
  const assets = record.receipt.assetBindings.length;
  const sourceTasks = new Set(record.receipt.assetBindings.map((item) => item.sourceTaskId)).size;
  return (
    <aside className={styles.card} aria-label={tFor(locale, "one.reuse.aria")}>
      <span className={styles.mark} aria-hidden="true">↻</span>
      <div>
        <strong>{tFor(locale, "one.reuse.title")}</strong>
        <p>
          {tFor(locale, "one.reuse.body", { sourceTasks, assets })}
        </p>
        <button type="button" className={styles.manage} onClick={onManage}>
          {tFor(locale, "one.reuse.manage")}
        </button>
      </div>
    </aside>
  );
}
