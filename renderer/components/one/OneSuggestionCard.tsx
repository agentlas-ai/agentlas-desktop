"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { tFor, type Locale } from "@/lib/i18n";
import type {
  OneEcosystemSuggestion,
  OneSuggestionState,
} from "@/lib/types";
import styles from "./OneSuggestionCard.module.css";

type SuggestionFallbackKey =
  | "one.sug.prev.external_val"
  | "one.sug.auto.disclaimer"
  | "one.sug.hub.box_strong"
  | "one.sug.hub.box_span"
  | "one.sug.hub.box_small";

const SUGGESTION_FALLBACKS: Record<SuggestionFallbackKey, Record<Locale, string>> = {
  "one.sug.prev.external_val": { ko: "매번 명시적 승인 필요", en: "Explicit approval required every time" },
  "one.sug.auto.disclaimer": {
    ko: "이 제안을 검토하는 것만으로 일정이 저장되거나 자동화가 켜지거나 실행되지는 않습니다. 직접 승인하기 전에는 아무것도 시작되지 않습니다.",
    en: "Reviewing this proposal does not save a schedule, enable automation, or run it. Nothing starts until you approve it yourself.",
  },
  "one.sug.hub.box_strong": { ko: "내 파일과 기억은 공개 초안에 넣지 않아요", en: "Your files and memories stay out of the public draft" },
  "one.sug.hub.box_span": {
    ko: "공개 설명과 기본 구조만 새로 준비합니다. 고객 자료, 로그인 정보, 내부 문서, 대화 원문은 복사하지 않습니다.",
    en: "One creates only a new public description and basic structure. Customer data, sign-in information, internal documents, and conversations are not copied.",
  },
  "one.sug.hub.box_small": {
    ko: "게시 권한·내가 올릴 권리·크레딧 기능·수수료는 아직 확인이 필요합니다. 게시 직전에 포함 내용을 다시 보고 직접 승인하며, 수익은 보장되지 않습니다.",
    en: "Publishing access, your right to publish, credit availability, and fees still need review. You see the included items and approve again before publishing; earnings are not guaranteed.",
  },
};

function suggestionCopy(locale: Locale, key: SuggestionFallbackKey): string {
  const value = tFor(locale, key);
  return value === key ? SUGGESTION_FALLBACKS[key][locale] : value;
}

function typeCopy(suggestion: OneEcosystemSuggestion, locale: Locale): {
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
} {
  const acceptedInternal = suggestion.evidence.every((item) => item.outcome === "accepted_internal_result");
  const basis = acceptedInternal
    ? tFor(locale, "one.sug.basis.accepted", { n: suggestion.evidence.length })
    : tFor(locale, "one.sug.basis.pattern", { n: suggestion.evidence.length });
  if (suggestion.type === "agent_build") return {
    eyebrow: tFor(locale, "one.sug.agent.eyebrow"),
    title: tFor(locale, "one.sug.agent.title"),
    body: tFor(locale, "one.sug.agent.body", { basis }),
    cta: tFor(locale, "one.sug.agent.cta"),
  };
  if (suggestion.type === "retain_team") return {
    eyebrow: tFor(locale, "one.sug.team.eyebrow"),
    title: tFor(locale, "one.sug.team.title"),
    body: tFor(locale, "one.sug.team.body", { basis }),
    cta: tFor(locale, "one.sug.team.cta"),
  };
  if (suggestion.type === "automation") return {
    eyebrow: tFor(locale, "one.sug.auto.eyebrow"),
    title: tFor(locale, "one.sug.auto.title"),
    body: tFor(locale, "one.sug.auto.body", { basis }),
    cta: tFor(locale, "one.sug.auto.cta"),
  };
  return {
    eyebrow: tFor(locale, "one.sug.hub.eyebrow"),
    title: tFor(locale, "one.sug.hub.title"),
    body: tFor(locale, "one.sug.hub.body"),
    cta: tFor(locale, "one.sug.hub.cta"),
  };
}

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function permissionLabel(value: string, locale: Locale): string {
  if (value === "read_only" || value === "read") return tFor(locale, "one.sug.perm.view");
  if (value === "draft_only" || value === "write") return tFor(locale, "one.sug.perm.draft");
  if (value === "approval_before_external_change" || value === "full") {
    return tFor(locale, "one.sug.perm.approval");
  }
  return tFor(locale, "one.sug.perm.review");
}

export function OneSuggestionCard({
  suggestion,
  state,
  locale,
  onStateChange,
}: {
  suggestion: OneEcosystemSuggestion;
  state: OneSuggestionState;
  locale: Locale;
  onStateChange: (state: OneSuggestionState) => void;
}) {
  const router = useRouter();
  const copy = typeCopy(suggestion, locale);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const review = state.reviewRequests.find((item) => item.suggestionId === suggestion.id) ?? null;

  const continueReview = async () => {
    const api = ipc();
    if (!api || !review || busy) {
      if (!api) setError(tFor(locale, "one.sug.err.store"));
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const handoff = await api.oneSuggestions.getReviewHandoff({
        suggestionId: suggestion.id,
        expectedSuggestionVersion: suggestion.version,
        reviewRequestId: review.id,
        draftId: review.draftId,
        originTaskId: suggestion.originTaskId,
      });
      if (
        handoff.suggestionId !== suggestion.id
        || handoff.suggestionVersion !== suggestion.version
        || handoff.reviewRequestId !== review.id
        || handoff.draftId !== review.draftId
        || handoff.originTaskId !== suggestion.originTaskId
        || handoff.reviewOnly !== true
        || handoff.actionState !== "not_started"
      ) throw new Error(tFor(locale, "one.sug.err.stale"));
      router.push(handoff.targetRoute);
    } catch (cause) {
      const latest = await api.oneSuggestions.getState().catch(() => null);
      if (latest) onStateChange(latest);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    const api = ipc();
    if (!api) {
      setError(tFor(locale, "one.sug.err.store"));
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await operation();
      onStateChange(await api.oneSuggestions.getState());
      setMessage(success);
    } catch (cause) {
      const latest = await api.oneSuggestions.getState().catch(() => null);
      if (latest) onStateChange(latest);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (suggestion.status === "accepted_for_review") {
    return (
      <article className={styles.receipt} aria-label={tFor(locale, "one.sug.receipt.aria")}>
        <div>
          <p className={styles.eyebrow}>{tFor(locale, "one.sug.receipt.eyebrow")}</p>
          <h3>{tFor(locale, "one.sug.receipt.title")}</h3>
          <p>{review
            ? tFor(locale, "one.sug.receipt.prepared_at", { date: formatDate(review.createdAt, locale) })
            : tFor(locale, "one.sug.receipt.reloading")}</p>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy || !review} onClick={() => void continueReview()}>
            {busy ? tFor(locale, "one.sug.receipt.checking") : tFor(locale, "one.sug.receipt.continue")}
          </button>
        </div>
      </article>
    );
  }

  const automation = suggestion.proposal.type === "automation" ? suggestion.proposal : null;
  const hub = suggestion.proposal.type === "hub_derivative" ? suggestion.proposal : null;
  return (
    <article className={styles.card} aria-labelledby={`${suggestion.id}-title`}>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>{copy.eyebrow}</p>
          <h3 id={`${suggestion.id}-title`}>{copy.title}</h3>
        </div>
        <span className={styles.evidenceBadge}>{suggestion.evidence.every((item) => item.outcome === "accepted_internal_result")
          ? tFor(locale, "one.sug.badge.similar", { n: suggestion.evidence.length })
          : tFor(locale, "one.sug.badge.verified", { n: suggestion.evidence.length })}</span>
      </div>
      <p className={styles.body}>{copy.body}</p>

      {automation && <dl className={styles.previewGrid}>
        <div><dt>{tFor(locale, "one.sug.prev.trigger")}</dt><dd>{automation.preview.trigger}</dd></div>
        <div><dt>{tFor(locale, "one.sug.prev.next_run")}</dt><dd>{formatDate(automation.preview.nextRunAt, locale)}</dd></div>
        <div><dt>{tFor(locale, "one.sug.prev.can_do")}</dt><dd>{permissionLabel(automation.preview.permission, locale)}</dd></div>
        <div><dt>{tFor(locale, "one.sug.prev.stop")}</dt><dd>{automation.preview.stopControl}</dd></div>
        <div><dt>{tFor(locale, "one.sug.prev.external")}</dt><dd>{suggestionCopy(locale, "one.sug.prev.external_val")}</dd></div>
      </dl>}
      {automation && <p className={styles.body}>
        {suggestionCopy(locale, "one.sug.auto.disclaimer")}
      </p>}
      {hub && <div className={styles.boundaryBox}>
        <strong>{suggestionCopy(locale, "one.sug.hub.box_strong")}</strong>
        <span>{suggestionCopy(locale, "one.sug.hub.box_span")}</span>
        <small>{suggestionCopy(locale, "one.sug.hub.box_small")}</small>
      </div>}

      <details className={styles.evidence}>
        <summary>{tFor(locale, "one.sug.why.summary")}</summary>
        {suggestion.evidence.map((item) => <span key={item.taskId}>
          {tFor(locale, "one.sug.why.completed")} {formatDate(item.completedAt, locale)} · {tFor(locale, "one.sug.why.checked", { n: item.evidenceRefs.length, s: item.evidenceRefs.length === 1 ? "" : "s" })}
        </span>)}
      </details>
      {(message || error) && <p className={error ? styles.error : styles.message} role={error ? "alert" : "status"}>{error ?? message}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void mutate(() => ipc()!.oneSuggestions.acceptForReview({
          expectedStoreVersion: state.version,
          suggestionId: suggestion.id,
          expectedSuggestionVersion: suggestion.version,
          confirmedByUser: true,
          reviewOnly: true,
          ...(suggestion.type === "hub_derivative" ? { publicDerivativeReview: true as const } : {}),
        }), tFor(locale, "one.sug.msg.review_prepared"))}>{copy.cta}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void mutate(() => ipc()!.oneSuggestions.snooze({
          expectedStoreVersion: state.version,
          suggestionId: suggestion.id,
          expectedSuggestionVersion: suggestion.version,
          confirmedByUser: true,
        }), tFor(locale, "one.sug.msg.snoozed"))}>{tFor(locale, "one.sug.action.later")}</button>
      </div>
      <details className={styles.suggestionControls}>
        <summary>{tFor(locale, "one.sug.settings.summary")}</summary>
        <div>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => void mutate(() => ipc()!.oneSuggestions.dismiss({
            expectedStoreVersion: state.version,
            suggestionId: suggestion.id,
            expectedSuggestionVersion: suggestion.version,
            confirmedByUser: true,
          }), tFor(locale, "one.sug.msg.dismissed"))}>{tFor(locale, "one.sug.action.not_interested")}</button>
          <button type="button" className={styles.danger} disabled={busy} onClick={() => void mutate(() => ipc()!.oneSuggestions.neverAsk({
            expectedStoreVersion: state.version,
            suggestionId: suggestion.id,
            expectedSuggestionVersion: suggestion.version,
            confirmedByUser: true,
          }), tFor(locale, "one.sug.msg.never"))}>{tFor(locale, "one.sug.action.never_ask")}</button>
        </div>
      </details>
    </article>
  );
}
