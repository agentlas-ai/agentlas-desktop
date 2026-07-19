"use client";

import { useState } from "react";
import type {
  OneWeeklyReflectionOutcomeV1,
  OneWeeklyReflectionSnapshotV1,
} from "@/lib/types";
import { ipc } from "@/lib/ipc";
import styles from "./OneWeeklyReflectionCard.module.css";

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

function preservationCopy(outcome: OneWeeklyReflectionOutcomeV1, ko: boolean): string {
  if (outcome.originalPreservation.status === "preserved") {
    return ko ? "원본을 바꾸지 않은 것으로 확인됐습니다." : "The original was confirmed unchanged.";
  }
  if (outcome.originalPreservation.status === "modified_with_approval") {
    return ko ? "내가 허용한 변경만 적용됐습니다." : "Only changes you approved were applied.";
  }
  return ko ? "이 결과에는 원본 변경이 필요하지 않았습니다." : "This result did not require an original-file change.";
}

function estimateValue(outcome: OneWeeklyReflectionOutcomeV1["estimates"][number]): string {
  if (outcome.value !== undefined) return `${outcome.value} ${outcome.unit}`;
  return `${outcome.lowerBound}–${outcome.upperBound} ${outcome.unit}`;
}

export function OneWeeklyReflectionCard({ snapshot, locale, onChange }: OneWeeklyReflectionCardProps) {
  const reflection = snapshot.reflection;
  const ko = locale === "ko";
  const [busy, setBusy] = useState<"acknowledge" | "hide_week" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!reflection || reflection.status !== "open") return null;

  const resolve = async (action: "acknowledge" | "hide_week") => {
    const api = ipc();
    if (!api?.oneWeeklyReflection || busy) return;
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
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const corrections = reflection.corrections.wrong + reflection.corrections.notImportant;
  return (
    <section className={styles.card} aria-labelledby={`weekly-reflection-${reflection.reflectionId}`} aria-busy={Boolean(busy)}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{ko ? "주간 확인" : "Weekly check-in"}</p>
          <h2 id={`weekly-reflection-${reflection.reflectionId}`}>
            {ko ? "이번 주 확인된 변화" : "A verified change this week"}
          </h2>
        </div>
        <span className={styles.period}>
          {formatDate(reflection.periodStart, reflection.timeZone, locale)}–{formatDate(new Date(Date.parse(reflection.periodEnd) - 1).toISOString(), reflection.timeZone, locale)}
        </span>
      </header>

      <p className={styles.lead}>{reflection.outcomes[0].facts[0].statement}</p>
      <p className={styles.basis}>
        {ko
          ? `내가 주간 요약에 넣은 결과 ${reflection.outcomes.length}개를 최근 순서로 정리했어요.`
          : `${reflection.outcomes.length} result${reflection.outcomes.length === 1 ? "" : "s"} you added to this summary, newest first.`}
      </p>

      <div className={styles.outcomes}>
        {reflection.outcomes.map((outcome, index) => (
          <article className={styles.outcome} key={outcome.valueClosureRef}>
            <div className={styles.outcomeHeader}>
              <strong>{ko ? `결과 ${index + 1}` : `Result ${index + 1}`}</strong>
              <time dateTime={outcome.generatedAt}>{formatDate(outcome.generatedAt, reflection.timeZone, locale)}</time>
            </div>
            <ul className={styles.facts} aria-label={ko ? "검증된 사실" : "Verified facts"}>
              {outcome.facts.map((fact) => <li key={fact.valueItemRef}>{fact.statement}</li>)}
            </ul>
            {outcome.estimates.map((estimate) => (
              <div className={styles.estimate} key={estimate.valueItemRef}>
                <span>{ko ? "추정" : "Estimate"}</span>
                <strong>{estimateValue(estimate)}</strong>
                <p>{estimate.statement}</p>
                <dl>
                  <div><dt>{ko ? "근거" : "Basis"}</dt><dd>{estimate.basis}</dd></div>
                  <div><dt>{ko ? "방법" : "Method"}</dt><dd>{estimate.method}</dd></div>
                </dl>
              </div>
            ))}
            <div className={styles.checks}>
              <div>
                <span>{ko ? "원본" : "Original"}</span>
                <p>{preservationCopy(outcome, ko)}</p>
              </div>
              <div>
                <span>{ko ? "다음 확인" : "Next check"}</span>
                {outcome.remainingWork.length > 0
                  ? <ul>{outcome.remainingWork.map((item) => <li key={item.itemRef}>{item.action}{item.status === "blocked" ? (ko ? " · 막힘" : " · blocked") : ""}</li>)}</ul>
                  : <p>{ko ? "기록된 남은 확인이 없습니다." : "No remaining check is recorded."}</p>}
              </div>
            </div>
            <details className={styles.evidence}>
              <summary>{ko ? "자세한 확인 기록" : "Detailed check records"}</summary>
              <div>
                {outcome.evidenceRefs.map((ref) => <code key={ref}>{ref}</code>)}
              </div>
            </details>
          </article>
        ))}
      </div>

      {corrections > 0 && (
        <p className={styles.corrections}>
          {ko
            ? `이번 주에 One의 알림을 ${corrections}번 고쳤어요${reflection.corrections.wrong > 0 ? ` · 틀림 ${reflection.corrections.wrong}` : ""}${reflection.corrections.notImportant > 0 ? ` · 덜 중요 ${reflection.corrections.notImportant}` : ""}. 대화 원문은 주간 요약에 넣지 않았습니다.`
            : `You corrected One ${corrections} time${corrections === 1 ? "" : "s"} this week${reflection.corrections.wrong > 0 ? ` · wrong ${reflection.corrections.wrong}` : ""}${reflection.corrections.notImportant > 0 ? ` · less important ${reflection.corrections.notImportant}` : ""}. Conversation text was not included.`}
        </p>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={() => void resolve("acknowledge")}>
          {busy === "acknowledge" ? (ko ? "확인 중…" : "Confirming…") : (ko ? "확인했어요" : "Got it")}
        </button>
        <button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => void resolve("hide_week")}>
          {busy === "hide_week" ? (ko ? "숨기는 중…" : "Hiding…") : (ko ? "이번 주는 숨기기" : "Hide for this week")}
        </button>
      </div>
    </section>
  );
}
