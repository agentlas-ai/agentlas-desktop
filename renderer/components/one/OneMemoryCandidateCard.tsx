"use client";

import { useState } from "react";
import { ipc } from "@/lib/ipc";
import type {
  OneMemoryCandidate,
  OneMemoryState,
} from "@/lib/types";
import styles from "./OneMemoryCandidateCard.module.css";

function scopeLabel(candidate: OneMemoryCandidate, ko: boolean): string {
  if (candidate.scope === "project") return ko ? "이 프로젝트" : "This project";
  if (candidate.scope === "agent") return ko ? "이 에이전트" : "This agent";
  if (candidate.scope === "team") return ko ? "이 팀" : "This team";
  return ko ? "나에게만" : "Personal";
}

export function OneMemoryCandidateCard({
  candidate,
  state,
  locale,
  onStateChange,
  onReview,
}: {
  candidate: OneMemoryCandidate;
  state: OneMemoryState;
  locale: "ko" | "en";
  onStateChange: (state: OneMemoryState) => void;
  onReview: () => void;
}) {
  const ko = locale === "ko";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const api = ipc();
    if (!api) throw new Error(ko ? "Desktop Memory 저장소에 연결되지 않았습니다." : "Desktop Memory storage is unavailable.");
    const latest = await api.oneMemory.getState();
    onStateChange(latest);
    return latest;
  };

  const save = async () => {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.oneMemory.save({
        expectedStoreVersion: state.version,
        candidateId: candidate.id,
        expectedCandidateVersion: candidate.version,
        approvedByUser: true,
      });
      await refresh();
    } catch (cause) {
      await refresh().catch(() => undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    const api = ipc();
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.oneMemory.reject({
        expectedStoreVersion: state.version,
        candidateId: candidate.id,
        expectedCandidateVersion: candidate.version,
        rejectedByUser: true,
      });
      await refresh();
    } catch (cause) {
      await refresh().catch(() => undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={styles.card} aria-labelledby={`${candidate.id}-title`}>
      <div className={styles.copy}>
        <p className={styles.eyebrow}>{ko ? "다음에는 덜 설명하도록" : "Less explaining next time"}</p>
        <h3 id={`${candidate.id}-title`}>{ko ? "이 기준을 기억해둘까요?" : "Should One remember this?"}</h3>
        <blockquote>{candidate.normalizedPreview}</blockquote>
        <small>{scopeLabel(candidate, ko)} · {ko ? "확인 전에는 재사용하지 않아요" : "Not reused until you approve"}</small>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void save()}>
          {busy ? (ko ? "확인 중…" : "Saving…") : (ko ? "기억해두기" : "Remember this")}
        </button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={onReview}>
          {ko ? "내용·범위 수정" : "Edit content or scope"}
        </button>
        <button type="button" className={styles.textButton} disabled={busy} onClick={() => void reject()}>
          {ko ? "아니요" : "No"}
        </button>
      </div>
    </article>
  );
}
