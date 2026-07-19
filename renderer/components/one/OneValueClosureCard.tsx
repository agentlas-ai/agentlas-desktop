"use client";

import { useState } from "react";
import { ipc } from "@/lib/ipc";
import type {
  OneValueClosureLifecycleClaim,
  OneValueClosureRecord,
  OneValueClosureState,
} from "@/lib/types";
import { redactSecrets } from "@shared/secret-patterns";
import styles from "./OneValueClosureCard.module.css";

function formatDate(value: string, locale: "ko" | "en"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function phaseLabel(phase: OneValueClosureLifecycleClaim["phase"], ko: boolean): string {
  const labels: Record<OneValueClosureLifecycleClaim["phase"], [string, string]> = {
    discovery: ["찾기", "Finding"],
    preparation: ["준비", "Preparation"],
    execution: ["작업", "Work"],
    verification: ["확인", "Checking"],
  };
  return labels[phase][ko ? 0 : 1];
}

function statusLabel(status: OneValueClosureLifecycleClaim["status"], ko: boolean): string {
  const labels: Record<OneValueClosureLifecycleClaim["status"], [string, string]> = {
    not_started: ["시작 안 함", "Not started"],
    prepared: ["준비됨", "Prepared"],
    in_progress: ["진행 중", "In progress"],
    completed: ["근거로 확인", "Evidence confirmed"],
    failed: ["확인 실패", "Failed"],
    not_applicable: ["해당 없음", "Not applicable"],
  };
  return labels[status][ko ? 0 : 1];
}

function ownerLabel(owner: "user" | "one" | "external", ko: boolean): string {
  if (owner === "user") return ko ? "나" : "You";
  if (owner === "one") return "One";
  return ko ? "외부" : "External";
}

function estimateValue(item: Extract<OneValueClosureRecord["closure"]["valueItems"][number], { kind: "estimate" }>): string {
  const estimate = item.estimate;
  if (typeof estimate.value === "number") return `${estimate.value} ${estimate.unit}`;
  return `${estimate.lowerBound}–${estimate.upperBound} ${estimate.unit}`;
}

export function OneValueClosureCard({
  record,
  state,
  locale,
  onStateChange,
}: {
  record: OneValueClosureRecord;
  state: OneValueClosureState;
  locale: "ko" | "en";
  onStateChange: (state: OneValueClosureState) => void;
}) {
  const ko = locale === "ko";
  const closure = record.closure;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setReflection = async (include: boolean) => {
    const api = ipc();
    if (!api) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await api.oneValueClosure.setReflection({
        expectedStoreVersion: state.version,
        valueClosureId: closure.valueClosureId,
        expectedClosureVersion: record.version,
        userOptedIn: include,
        included: include,
        confirmedByUser: true,
      });
      onStateChange(await api.oneValueClosure.getState());
      setMessage(include
        ? (ko ? "이번 결과를 주간 돌아보기에 넣었어요." : "Added this result to your weekly reflection.")
        : (ko ? "주간 회고에서 제외했습니다." : "Removed from the weekly reflection."));
    } catch (cause) {
      const latest = await api.oneValueClosure.getState().catch(() => null);
      if (latest) onStateChange(latest);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className={styles.card} aria-labelledby={`${closure.valueClosureId}-title`}>
      <summary className={styles.header}>
        <span className={styles.headerCheck} aria-hidden="true">✓</span>
        <div className={styles.headerCopy}>
          <h3 id={`${closure.valueClosureId}-title`}>{ko ? "이 일로 달라진 점" : "What changed"}</h3>
          <p>{ko ? "One이 실제로 확인한 내용이 있어요." : "One found a change it could confirm."}</p>
        </div>
        <span className={styles.status} data-status={closure.outcomeStatus}>
          {closure.outcomeStatus === "verified" ? (ko ? "확인함" : "Confirmed") : (ko ? "일부만 확인" : "Partly confirmed")}
        </span>
      </summary>

      <div className={styles.phaseGrid}>
        {closure.lifecycleClaims.map((claim) => <section key={claim.phase} className={styles.phase} data-status={claim.status}>
          <div><span>{phaseLabel(claim.phase, ko)}</span><strong>{statusLabel(claim.status, ko)}</strong></div>
          <p>{redactSecrets(claim.summary)}</p>
          <small>{ko ? `확인 기록 ${claim.evidenceRefs.length}개` : `${claim.evidenceRefs.length} check records`}</small>
        </section>)}
      </div>

      <section className={styles.section} aria-labelledby={`${closure.valueClosureId}-value`}>
        <h4 id={`${closure.valueClosureId}-value`}>{ko ? "얻은 가치" : "Value received"}</h4>
        <div className={styles.valueList}>
          {closure.valueItems.map((item) => <div key={item.valueItemId} className={styles.valueItem} data-kind={item.kind}>
            <span>{item.kind === "fact" ? (ko ? "확인된 사실" : "Verified fact") : (ko ? "추정" : "Estimate")}</span>
            <strong>{redactSecrets(item.statement)}</strong>
            {item.kind === "fact" ? (
              <small>{ko ? `확인 기록 ${item.evidenceRefs.length}개` : `${item.evidenceRefs.length} check records`}</small>
            ) : (
              <div className={styles.estimate}>
                <b>{estimateValue(item)}</b>
                <small>{ko ? "근거" : "Basis"}: {redactSecrets(item.estimate.basis)}</small>
                <small>{ko ? "계산 방법" : "Method"}: {redactSecrets(item.estimate.method)}</small>
              </div>
            )}
          </div>)}
        </div>
      </section>

      <div className={styles.closureGrid}>
        <section className={styles.section} aria-labelledby={`${closure.valueClosureId}-original`}>
          <h4 id={`${closure.valueClosureId}-original`}>{ko ? "원본 상태" : "Originals"}</h4>
          <p>{closure.originalPreservation.status === "preserved"
            ? (ko ? "원본을 바꾸지 않은 것으로 확인됐습니다." : "The original was confirmed unchanged.")
            : closure.originalPreservation.status === "modified_with_approval"
              ? (ko ? "내가 허용한 변경만 적용됐습니다." : "Only changes you approved were applied.")
              : (ko ? "이 결과에는 원본 변경 확인이 필요하지 않았습니다." : "This result did not require an original-file check.")}</p>
          {closure.originalPreservation.explanation && <small>{redactSecrets(closure.originalPreservation.explanation)}</small>}
          <small>{ko ? `결과 파일 ${closure.originalPreservation.artifactRefs.length} · 확인 기록 ${closure.originalPreservation.receiptRefs.length}` : `${closure.originalPreservation.artifactRefs.length} result files · ${closure.originalPreservation.receiptRefs.length} check records`}</small>
        </section>

        <section className={styles.section} aria-labelledby={`${closure.valueClosureId}-remaining`}>
          <h4 id={`${closure.valueClosureId}-remaining`}>{ko ? "남은 일" : "Remaining work"}</h4>
          {closure.remainingWork.length === 0 ? <p>{ko ? "확인된 남은 일이 없습니다." : "No confirmed work remains."}</p> : (
            <ul>{closure.remainingWork.map((item) => <li key={item.itemRef}>
              <strong>{redactSecrets(item.action)}</strong>
              <span>{ownerLabel(item.owner, ko)} · {item.status === "blocked" ? (ko ? "차단" : "Blocked") : item.status === "pending" ? (ko ? "대기" : "Pending") : (ko ? "불필요" : "Not required")}</span>
              {item.reason && <small>{redactSecrets(item.reason)}</small>}
            </li>)}</ul>
          )}
        </section>
      </div>

      <details className={styles.evidence}>
        <summary>{ko ? "무엇을 확인했나요?" : "What did One check?"}</summary>
        <span>{ko ? `결과 확인 ${closure.outcomeRefs.length}개` : `${closure.outcomeRefs.length} result checks`}</span>
        <span>{ko ? `작업 확인 ${closure.receiptRefs.length}개` : `${closure.receiptRefs.length} work checks`}</span>
        <span>{ko ? `앱 확인 ${record.trustedEvidenceRefs.length}개` : `${record.trustedEvidenceRefs.length} app checks`}</span>
        <span>{ko ? "생성 시각" : "Generated"} · {formatDate(closure.generatedAt, locale)}</span>
      </details>

      {closure.reflection.eligible && <section className={styles.reflection}>
        <div>
          <strong>{ko ? "이번 주 돌아보기" : "Weekly reflection"}</strong>
          <p>{ko ? "이번 결과를 주간 요약에 넣을까요?" : "Include this result in your weekly summary?"}</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void setReflection(!closure.reflection.included)}>
          {closure.reflection.included ? (ko ? "주간 요약에서 빼기" : "Remove from weekly summary") : (ko ? "주간 요약에 넣기" : "Include in weekly summary")}
        </button>
      </section>}
      {(message || error) && <p className={error ? styles.error : styles.message} role={error ? "alert" : "status"}>{error ?? message}</p>}
    </details>
  );
}
