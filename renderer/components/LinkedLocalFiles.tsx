"use client";

import { useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { IconFileUp } from "./Icon";
import { localFileRefsFromText } from "@/lib/linked-local-file";
import styles from "./ChatFileExperience.module.css";

/**
 * 답이 가리킨 로컬 파일을 이름만 보이는 칩으로(경로는 One 고객 문구 경계가 가린다). 누르면 오른쪽 패널의
 * 파일 탭 — TaskSidePanel 이 Main 확인 길(agentlas://localfile · fs.readTextFile)로만 읽는다.
 */
export function LinkedLocalFiles({ text, chatId, locale, shownElsewhere }: { text: string; chatId: string | null; locale: "ko" | "en"; shownElsewhere?: ReadonlySet<string> }) {
  const named = useMemo(() => localFileRefsFromText(text).filter((ref) => !shownElsewhere?.has(ref)), [text, shownElsewhere]);
  // A card is drawn only for a file Main confirms is there (the same read route the panel opens it through): the answer's own words may name a place
  // that has no file. Nothing shows before the answer comes, and a refused or failed read confirms nothing.
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const api = ipc();
    if (!api?.fs?.readTextFile || !chatId || named.length === 0) return;
    let cancelled = false;
    void Promise.all(named.map(async (ref) => {
      try {
        const r = await api.fs.readTextFile(ref, { kind: "chat-workspace", chatId });
        return !r?.reason || r.reason === "binary" || r.reason === "too-large" || r.reason === "not-text-ext" ? ref : null;
      } catch { return null; }
    })).then((found) => { if (!cancelled) setConfirmed(new Set(found.filter((ref): ref is string => ref !== null))); });
    return () => { cancelled = true; };
  }, [named, chatId]);
  const refs = useMemo(() => named.filter((ref) => confirmed.has(ref)), [named, confirmed]);
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
