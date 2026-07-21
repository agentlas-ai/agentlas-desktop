"use client";

import { useState } from "react";
import { ipc } from "@/lib/ipc";
import { tFor, type Locale } from "@/lib/i18n";
import type {
  OneMemoryCandidate,
  OneMemoryState,
} from "@/lib/types";
import styles from "./OneMemoryCandidateCard.module.css";

function scopeLabel(candidate: OneMemoryCandidate, locale: Locale): string {
  if (candidate.scope === "project") return tFor(locale, "one.memc.scope.project");
  if (candidate.scope === "agent") return tFor(locale, "one.memc.scope.agent");
  if (candidate.scope === "team") return tFor(locale, "one.memc.scope.team");
  return tFor(locale, "one.memc.scope.personal");
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const api = ipc();
    if (!api) throw new Error(tFor(locale, "one.memc.err.store"));
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
        <p className={styles.eyebrow}>{tFor(locale, "one.memc.eyebrow")}</p>
        <h3 id={`${candidate.id}-title`}>{tFor(locale, "one.memc.title")}</h3>
        <blockquote>{candidate.normalizedPreview}</blockquote>
        <small>{scopeLabel(candidate, locale)} · {tFor(locale, "one.memc.not_reused")}</small>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void save()}>
          {busy ? tFor(locale, "one.memc.saving") : tFor(locale, "one.memc.remember")}
        </button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={onReview}>
          {tFor(locale, "one.memc.edit")}
        </button>
        <button type="button" className={styles.textButton} disabled={busy} onClick={() => void reject()}>
          {tFor(locale, "one.memc.no")}
        </button>
      </div>
    </article>
  );
}
