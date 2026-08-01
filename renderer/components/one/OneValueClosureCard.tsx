"use client";

import { useState } from "react";
import { ipc } from "@/lib/ipc";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor, type Locale } from "@/lib/i18n";
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

function phaseLabel(phase: OneValueClosureLifecycleClaim["phase"], locale: Locale): string {
  const keys = {
    discovery: "one.val.phase.discovery",
    preparation: "one.val.phase.preparation",
    execution: "one.val.phase.execution",
    verification: "one.val.phase.verification",
  } as const;
  return tFor(locale, keys[phase]);
}

function statusLabel(status: OneValueClosureLifecycleClaim["status"], locale: Locale): string {
  const keys = {
    not_started: "one.val.status.not_started",
    prepared: "one.val.status.prepared",
    in_progress: "one.val.status.in_progress",
    completed: "one.val.status.completed",
    failed: "one.val.status.failed",
    not_applicable: "one.val.status.not_applicable",
  } as const;
  return tFor(locale, keys[status]);
}

function ownerLabel(owner: "user" | "one" | "external", locale: Locale): string {
  if (owner === "user") return tFor(locale, "one.val.owner.user");
  if (owner === "one") return "One";
  return tFor(locale, "one.val.owner.external");
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
  const closure = record.closure;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setReflection = async (include: boolean) => {
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-value-closure", new Error("Desktop bridge unavailable"));
      return;
    }
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
        ? tFor(locale, "one.val.msg.reflection_added")
        : tFor(locale, "one.val.msg.reflection_removed"));
    } catch (cause) {
      const latest = await api.oneValueClosure.getState().catch(() => null);
      if (latest) onStateChange(latest);
      requestOneOperationalRecovery("one-value-closure", cause);
      setError(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className={styles.card} aria-labelledby={`${closure.valueClosureId}-title`}>
      <summary className={styles.header}>
        <span className={styles.headerCheck} aria-hidden="true">✓</span>
        <div className={styles.headerCopy}>
          <h3 id={`${closure.valueClosureId}-title`}>{tFor(locale, "one.val.title")}</h3>
          <p>{tFor(locale, "one.val.subtitle")}</p>
        </div>
        <span className={styles.status} data-status={closure.outcomeStatus}>
          {closure.outcomeStatus === "verified" ? tFor(locale, "one.val.status_badge.verified") : tFor(locale, "one.val.status_badge.partial")}
        </span>
      </summary>

      <div className={styles.phaseGrid}>
        {closure.lifecycleClaims.map((claim) => <section key={claim.phase} className={styles.phase} data-status={claim.status}>
          <div><span>{phaseLabel(claim.phase, locale)}</span><strong>{statusLabel(claim.status, locale)}</strong></div>
          <p>{redactSecrets(claim.summary)}</p>
          <small>{tFor(locale, "one.val.check_records", { n: claim.evidenceRefs.length })}</small>
        </section>)}
      </div>

      <section className={styles.section} aria-labelledby={`${closure.valueClosureId}-value`}>
        <h4 id={`${closure.valueClosureId}-value`}>{tFor(locale, "one.val.value_received")}</h4>
        <div className={styles.valueList}>
          {closure.valueItems.map((item) => <div key={item.valueItemId} className={styles.valueItem} data-kind={item.kind}>
            <span>{item.kind === "fact" ? tFor(locale, "one.val.kind.fact") : tFor(locale, "one.val.kind.estimate")}</span>
            <strong>{redactSecrets(item.statement)}</strong>
            {item.kind === "fact" ? (
              <small>{tFor(locale, "one.val.check_records", { n: item.evidenceRefs.length })}</small>
            ) : (
              <div className={styles.estimate}>
                <b>{estimateValue(item)}</b>
                <small>{tFor(locale, "one.val.basis")}: {redactSecrets(item.estimate.basis)}</small>
                <small>{tFor(locale, "one.val.method")}: {redactSecrets(item.estimate.method)}</small>
              </div>
            )}
          </div>)}
        </div>
      </section>

      <div className={styles.closureGrid}>
        <section className={styles.section} aria-labelledby={`${closure.valueClosureId}-original`}>
          <h4 id={`${closure.valueClosureId}-original`}>{tFor(locale, "one.val.originals")}</h4>
          <p>{closure.originalPreservation.status === "preserved"
            ? tFor(locale, "one.val.orig.preserved")
            : closure.originalPreservation.status === "modified_with_approval"
              ? tFor(locale, "one.val.orig.modified")
              : tFor(locale, "one.val.orig.not_required")}</p>
          {closure.originalPreservation.explanation && <small>{redactSecrets(closure.originalPreservation.explanation)}</small>}
          <small>{tFor(locale, "one.val.orig.counts", { artifacts: closure.originalPreservation.artifactRefs.length, receipts: closure.originalPreservation.receiptRefs.length })}</small>
        </section>

        <section className={styles.section} aria-labelledby={`${closure.valueClosureId}-remaining`}>
          <h4 id={`${closure.valueClosureId}-remaining`}>{tFor(locale, "one.val.remaining")}</h4>
          {closure.remainingWork.length === 0 ? <p>{tFor(locale, "one.val.no_remaining")}</p> : (
            <ul>{closure.remainingWork.map((item) => <li key={item.itemRef}>
              <strong>{redactSecrets(item.action)}</strong>
              <span>{ownerLabel(item.owner, locale)} · {item.status === "blocked" ? tFor(locale, "one.val.remaining.blocked") : item.status === "pending" ? tFor(locale, "one.val.remaining.pending") : tFor(locale, "one.val.remaining.not_required")}</span>
              {item.reason && <small>{redactSecrets(item.reason)}</small>}
            </li>)}</ul>
          )}
        </section>
      </div>

      <details className={styles.evidence}>
        <summary>{tFor(locale, "one.val.evidence.summary")}</summary>
        <span>{tFor(locale, "one.val.evidence.outcome", { n: closure.outcomeRefs.length })}</span>
        <span>{tFor(locale, "one.val.evidence.receipt", { n: closure.receiptRefs.length })}</span>
        <span>{tFor(locale, "one.val.evidence.app", { n: record.trustedEvidenceRefs.length })}</span>
        <span>{tFor(locale, "one.val.generated")} · {formatDate(closure.generatedAt, locale)}</span>
      </details>

      {closure.reflection.eligible && <section className={styles.reflection}>
        <div>
          <strong>{tFor(locale, "one.val.reflection.title")}</strong>
          <p>{tFor(locale, "one.val.reflection.prompt")}</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void setReflection(!closure.reflection.included)}>
          {closure.reflection.included ? tFor(locale, "one.val.reflection.remove") : tFor(locale, "one.val.reflection.include")}
        </button>
      </section>}
      {(message || error) && <p className={error ? styles.error : styles.message} role={error ? "alert" : "status"}>{error ?? message}</p>}
    </details>
  );
}
