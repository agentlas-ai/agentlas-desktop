"use client";

import type { OneOrgStatusKind } from "@shared/one-org";
import { oneCharacterForTone } from "@/lib/one-characters";
import styles from "./OneAgentPortrait.module.css";

export function OneAgentPortrait({
  status,
  label,
  size = "medium",
  tone = "character:orange-dino",
}: {
  status: OneOrgStatusKind;
  label: string;
  size?: "small" | "medium" | "large";
  tone?: string;
}) {
  const character = oneCharacterForTone(tone);
  const customAvatarId = tone.startsWith("one-avatar:") ? tone.slice("one-avatar:".length) : "";
  /*
   * 직접 넣은 얼굴이 사는 곳은 제품마다 다르다. 데스크탑은 사용자 폴더의 파일이고(앱 전용
   * 주소로 읽는다), 웹은 자산 저장소에 올라간 주소다. 웹 쪽을 여기서 안 받으면 웹에서
   * 업로드·생성한 얼굴이 조용히 기본 캐릭터로 되돌아간다 — 저장은 됐는데 안 보이는 상태다.
   */
  const storedAvatarUrl = /^(https?:\/\/|\/)/.test(tone) ? tone : "";
  const custom = Boolean(customAvatarId || storedAvatarUrl);
  const src = customAvatarId
    ? `agentlas://one-avatar/${encodeURIComponent(customAvatarId)}`
    : storedAvatarUrl || character.src;

  return (
    <span className={`${styles.root} ${styles[size]}`} data-state={status} data-tone={custom ? "custom" : character.tone} aria-label={label}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className={styles.character} />
      <span className={styles.dot} aria-hidden="true" />
    </span>
  );
}
