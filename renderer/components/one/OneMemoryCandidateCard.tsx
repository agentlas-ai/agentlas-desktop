"use client";

import { useState } from "react";
import { ipc } from "@/lib/ipc";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
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

/** Compatibility display for an older renderer; no per-memory approval action. */
export function OneMemoryCandidateCard({locale,onReview}: {candidate:OneMemoryCandidate;state:OneMemoryState;
  locale:"ko"|"en";onStateChange:(state:OneMemoryState)=>void;onReview:()=>void}) {
  return <article className={styles.card}><p>{locale==="ko"?"기억은 자동으로 정리됩니다.":"Memory is curated automatically."}</p>
    <button type="button" className={styles.secondary} onClick={onReview}>
      {locale==="ko"?"기억 관리":"Manage memory"}</button></article>;
}
