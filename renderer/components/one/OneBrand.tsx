"use client";

import styles from "./OneBrand.module.css";

export function OneBrandMark({
  size = "small",
  thinking = false,
  className = "",
}: {
  size?: "small" | "medium" | "thinking";
  thinking?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`${styles.mark} ${styles[size]} ${thinking ? styles.isThinking : ""} ${className}`.trim()}
      aria-hidden="true"
    >
      <img src="/brand/agentlas-one-mark.png" alt="" draggable={false} />
      {thinking && <i className={styles.sweepingLight} />}
    </span>
  );
}

export function OneBrandLockup({ className = "" }: { className?: string }) {
  return (
    <span className={`${styles.lockup} ${className}`.trim()} aria-hidden="true">
      <img src="/brand/agentlas-one-mark.png" alt="" draggable={false} />
    </span>
  );
}
