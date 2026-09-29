"use client";

import { useMemo } from "react";
import { IconFileUp } from "./Icon";
import { localFileRefsFromText } from "@/lib/linked-local-file";
import styles from "./ChatFileExperience.module.css";

/**
 * 답이 가리킨 로컬 파일을 이름만 보이는 칩으로(경로는 One 고객 문구 경계가 가린다). 누르면 오른쪽 패널의
 * 파일 탭 — TaskSidePanel 이 Main 확인 길(agentlas://localfile · fs.readTextFile)로만 읽는다.
 */
export function LinkedLocalFiles({ text, chatId, locale }: { text: string; chatId: string | null; locale: "ko" | "en" }) {
  const refs = useMemo(() => localFileRefsFromText(text), [text]);
  if (!chatId || refs.length === 0) return null;
  return <div className={styles.cards} data-linked-local-files="true" aria-label={locale === "ko" ? "답에 나온 파일" : "Files in this answer"}>
    {refs.map((ref) => {
      const name = ref.split(/[\\/]/).pop() ?? ref;
      return <button key={ref} type="button" className={styles.card} data-linked-local-file={name}
        onClick={() => window.dispatchEvent(new CustomEvent("agentlas:in-app-linked-file", { detail: { name, path: ref, chatId } }))} title={name}>
        <span className={styles.cardIcon} aria-hidden="true"><IconFileUp size={15} /></span>
        <span className={styles.cardCopy}>
          <span className={styles.cardName}>{name}</span>
          <span className={styles.cardMeta}>{locale === "ko" ? "답에 나온 파일 · 패널에서 열기" : "File in this answer · open in panel"}</span>
        </span>
      </button>;
    })}
  </div>;
}
