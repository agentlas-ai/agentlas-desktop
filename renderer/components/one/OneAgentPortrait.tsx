"use client";

import { useState } from "react";
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
  const customSrc = customAvatarId
    ? `agentlas://one-avatar/${encodeURIComponent(customAvatarId)}`
    : storedAvatarUrl;
  /*
   * 직접 넣은 얼굴 파일이 없거나(다른 사본·삭제·권한) 주소가 안 열리면 브라우저의 깨진 그림
   * 아이콘이 그대로 보인다(Motiondirector 2026-10-10). 로드에 실패한 주소는 기억해 두고
   * 기본 캐릭터로 되돌린다. 주소가 바뀌면 다시 시도한다.
   */
  const [failedSrc, setFailedSrc] = useState("");
  const useCustom = Boolean(customSrc) && failedSrc !== customSrc;
  const src = useCustom ? customSrc : character.src;

  return (
    <span className={`${styles.root} ${styles[size]}`} data-state={status} data-tone={custom && useCustom ? "custom" : character.tone} aria-label={label}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className={styles.character} onError={() => { if (useCustom) setFailedSrc(customSrc); }} />
      <span className={styles.dot} aria-hidden="true" />
    </span>
  );
}
