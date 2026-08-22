"use client";

import type { OneOrgStatusKind } from "@shared/one-org";
import { oneCharacterForTone } from "@/lib/one-characters";
import styles from "./OneAgentPortrait.module.css";

export function OneAgentPortrait({
  status,
  label,
  size = "medium",
  tone = "green",
}: {
  status: OneOrgStatusKind;
  label: string;
  size?: "small" | "medium" | "large";
  tone?: string;
}) {
  const character = oneCharacterForTone(tone);
  const customAvatarId = tone.startsWith("one-avatar:") ? tone.slice("one-avatar:".length) : "";
  const src = customAvatarId
    ? `agentlas://one-avatar/${encodeURIComponent(customAvatarId)}`
    : character.src;

  return (
    <span className={`${styles.root} ${styles[size]}`} data-state={status} data-tone={customAvatarId ? "custom" : character.tone} aria-label={label}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className={styles.character} />
      <span className={styles.dot} aria-hidden="true" />
    </span>
  );
}
