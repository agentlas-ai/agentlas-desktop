"use client";

import { useState } from "react";
import type {
  OneWeeklyReflectionOutcomeV1,
  OneWeeklyReflectionSnapshotV1,
} from "@/lib/types";
import { ipc } from "@/lib/ipc";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor } from "@/lib/i18n";
import styles from "./OneWeeklyReflectionCard.module.css";

type WeeklyFallbackKey =
  | "one.week.title"
  | "one.week.evidence_summary"
  | "one.week.action.got_it"
  | "one.week.action.hide";

const WEEKLY_FALLBACKS: Record<WeeklyFallbackKey, Record<"ko" | "en", string>> = {
  "one.week.title": { ko: "이번 주 확인된 변화", en: "A verified change this week" },
  "one.week.evidence_summary": { ko: "자세한 확인 기록", en: "Detailed check records" },
  "one.week.action.got_it": { ko: "확인했어요", en: "Got it" },
  "one.week.action.hide": { ko: "이번 주는 숨기기", en: "Hide for this week" },
};

function weeklyCopy(locale: "ko" | "en", key: WeeklyFallbackKey): string {
  const value = tFor(locale, key);
  return value === key ? WEEKLY_FALLBACKS[key][locale] : value;
}

function weeklySummary(locale: "ko" | "en", count: number): string {
  const key = "one.week.summary_line" as const;
  const value = tFor(locale, key, { count, s: count === 1 ? "" : "s" });
  if (value !== key) return value;
  return locale === "ko"
    ? `내가 주간 요약에 넣은 결과 ${count}개를 최근 순서로 정리했어요.`
    : `${count} result${count === 1 ? "" : "s"} you added to this summary, newest first.`;
}

interface OneWeeklyReflectionCardProps {
  snapshot: OneWeeklyReflectionSnapshotV1;
  locale: "ko" | "en";
  onChange: (snapshot: OneWeeklyReflectionSnapshotV1) => void;
}

function formatDate(value: string, timeZone: string, locale: "ko" | "en"): string {
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function preservationCopy(outcome: OneWeeklyReflectionOutcomeV1, locale: "ko" | "en"): string {
  if (outcome.originalPreservation.status === "preserved") {
    return tFor(locale, "one.week.preservation.preserved");
  }
  if (outcome.originalPreservation.status === "modified_with_approval") {
    return tFor(locale, "one.week.preservation.modified");
  }
  return tFor(locale, "one.week.preservation.not_needed");
}

function estimateValue(outcome: OneWeeklyReflectionOutcomeV1["estimates"][number]): string {
  if (outcome.value !== undefined) return `${outcome.value} ${outcome.unit}`;
  return `${outcome.lowerBound}–${outcome.upperBound} ${outcome.unit}`;
}

export function OneWeeklyReflectionCard({ snapshot, locale, onChange }: OneWeeklyReflectionCardProps) {
  const reflection = snapshot.reflection;
  const [busy, setBusy] = useState<"acknowledge" | "hide_week" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!reflection || reflection.status !== "open") return null;

  const resolve = async (action: "acknowledge" | "hide_week") => {
    const api = ipc();
    if (busy) return;
    if (!api?.oneWeeklyReflection) {
      requestOneOperationalRecovery("one-weekly-reflection", new Error("Desktop bridge unavailable"));
      return;
    }
    setBusy(action);
    setError(null);
    try {
      const next = await api.oneWeeklyReflection.resolve({
        expectedStateVersion: snapshot.stateVersion,
        reflectionId: reflection.reflectionId,
        weekKey: reflection.weekKey,
        expectedContentDigest: reflection.contentDigest,
        action,
        confirmedByUser: true,
      });
      onChange(next);
    } catch (cause) {
      const latest = await api.oneWeeklyReflection.get().catch(() => null);
      if (latest) onChange(latest);
      requestOneOperationalRecovery("one-weekly-reflection", cause);
      setError(null);
    } finally {
      setBusy(null);
    }
  };

  const corrections = reflection.corrections.wrong + reflection.corrections.notImportant;
  return (
    <section className={styles.card} aria-labelledby={`weekly-reflection-${reflection.reflectionId}`} aria-busy={Boolean(busy)}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{tFor(locale, "one.week.eyebrow")}</p>
          <h2 id={`weekly-reflection-${reflection.reflectionId}`}>
            {weeklyCopy(locale, "one.week.title")}
          </h2>
        </div>
        <span className={styles.period}>
          {formatDate(reflection.periodStart, reflection.timeZone, locale)}–{formatDate(new Date(Date.parse(reflection.periodEnd) - 1).toISOString(), reflection.timeZone, locale)}
        </span>
      </header>

      <p className={styles.lead}>{reflection.outcomes[0].facts[0].statement}</p>
      <p className={styles.basis}>
        {weeklySummary(locale, reflection.outcomes.length)}
      </p>

      <div className={styles.outcomes}>
        {reflection.outcomes.map((outcome, index) => (
          <article className={styles.outcome} key={outcome.valueClosureRef}>
            <div className={styles.outcomeHeader}>
              <strong>{tFor(locale, "one.week.result_n", { n: index + 1 })}</strong>
              <time dateTime={outcome.generatedAt}>{formatDate(outcome.generatedAt, reflection.timeZone, locale)}</time>
            </div>
            <ul className={styles.facts} aria-label={tFor(locale, "one.week.facts_aria")}>
              {outcome.facts.map((fact) => <li key={fact.valueItemRef}>{fact.statement}</li>)}
            </ul>
            {outcome.estimates.map((estimate) => (
              <div className={styles.estimate} key={estimate.valueItemRef}>
                <span>{tFor(locale, "one.week.estimate")}</span>
                <strong>{estimateValue(estimate)}</strong>
                <p>{estimate.statement}</p>
                <dl>
                  <div><dt>{tFor(locale, "one.week.estimate.basis")}</dt><dd>{estimate.basis}</dd></div>
                  <div><dt>{tFor(locale, "one.week.estimate.method")}</dt><dd>{estimate.method}</dd></div>
                </dl>
              </div>
            ))}
            <div className={styles.checks}>
              <div>
                <span>{tFor(locale, "one.week.original")}</span>
                <p>{preservationCopy(outcome, locale)}</p>
              </div>
              <div>
                <span>{tFor(locale, "one.week.next_check")}</span>
                {outcome.remainingWork.length > 0
                  ? <ul>{outcome.remainingWork.map((item) => <li key={item.itemRef}>{item.action}{item.status === "blocked" ? tFor(locale, "one.week.blocked_suffix") : ""}</li>)}</ul>
                  : <p>{tFor(locale, "one.week.no_remaining")}</p>}
              </div>
            </div>
            <details className={styles.evidence}>
              <summary>{weeklyCopy(locale, "one.week.evidence_summary")}</summary>
              <div>
                {outcome.evidenceRefs.map((ref) => <code key={ref}>{ref}</code>)}
              </div>
            </details>
          </article>
        ))}
      </div>

      {corrections > 0 && (
        <p className={styles.corrections}>
          {`${tFor(locale, "one.week.corrections.base", { count: corrections, s: corrections === 1 ? "" : "s" })}${reflection.corrections.wrong > 0 ? tFor(locale, "one.week.corrections.wrong", { n: reflection.corrections.wrong }) : ""}${reflection.corrections.notImportant > 0 ? tFor(locale, "one.week.corrections.not_important", { n: reflection.corrections.notImportant }) : ""}${tFor(locale, "one.week.corrections.tail")}`}
        </p>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={() => void resolve("acknowledge")}>
          {busy === "acknowledge" ? tFor(locale, "one.week.action.confirming") : weeklyCopy(locale, "one.week.action.got_it")}
        </button>
        <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => void resolve("hide_week")}>
          {busy === "hide_week" ? tFor(locale, "one.week.action.hiding") : weeklyCopy(locale, "one.week.action.hide")}
        </button>
      </div>
    </section>
  );
}
