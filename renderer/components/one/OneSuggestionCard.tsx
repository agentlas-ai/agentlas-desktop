"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import type {
  OneEcosystemSuggestion,
  OneSuggestionState,
} from "@/lib/types";
import styles from "./OneSuggestionCard.module.css";

function typeCopy(suggestion: OneEcosystemSuggestion, ko: boolean): {
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
} {
  const acceptedInternal = suggestion.evidence.every((item) => item.outcome === "accepted_internal_result");
  const basis = acceptedInternal
    ? (ko
      ? `비슷한 일을 ${suggestion.evidence.length}번 완료했고, 결과를 직접 수락했어요. 외부 성과까지 성공했다는 뜻은 아닙니다.`
      : `You completed and accepted ${suggestion.evidence.length} similar result(s). This does not prove an external outcome succeeded.`)
    : (ko
      ? `서로 다른 실행 ${suggestion.evidence.length}번에서 같은 패턴이 확인됐어요.`
      : `The same pattern was verified across ${suggestion.evidence.length} separate run(s).`);
  if (suggestion.type === "agent_build") return {
    eyebrow: ko ? "다음부터 더 빠르게" : "Faster next time",
    title: ko ? "이 역할을 내 전담 에이전트로 둘까요?" : "Keep this role as your own agent?",
    body: ko
      ? `${basis} 먼저 이름·역할·사용 범위를 확인할 초안만 준비해요.`
      : `${basis} One will prepare a draft so you can review its name, role, and access first.`,
    cta: ko ? "에이전트 초안 보기" : "See agent draft",
  };
  if (suggestion.type === "retain_team") return {
    eyebrow: ko ? "잘 맞았던 팀" : "A team that worked",
    title: ko ? "이 팀을 다음에도 바로 부를 수 있게 둘까요?" : "Keep this team ready for next time?",
    body: ko
      ? `${basis} 역할과 권한을 확인할 팀 초안만 준비하고, 아직 저장하거나 실행하지 않아요.`
      : `${basis} One will prepare a team draft for role and access review. Nothing is saved or run yet.`,
    cta: ko ? "팀 초안 보기" : "See team draft",
  };
  if (suggestion.type === "automation") return {
    eyebrow: ko ? "반복되는 일" : "Repeated work",
    title: ko ? "다음부터 One이 먼저 준비해둘까요?" : "Should One prepare this before you ask next time?",
    body: ko
      ? `${basis} 언제 준비하고 어떻게 멈출지만 확인할 초안을 만들어요. 아직 자동 실행되지는 않아요.`
      : `${basis} One will draft when to prepare it and how to stop it. It will not run automatically yet.`,
    cta: ko ? "자동화 초안 보기" : "See automation draft",
  };
  return {
    eyebrow: ko ? "Agent Hub" : "Agent Hub",
    title: ko ? "이 에이전트를 공개용으로 다듬어 크레딧을 벌어볼까요?" : "Turn this agent into a public version that can earn credits?",
    body: ko
      ? "내 기억과 비공개 자료는 빼고 공개용 초안만 따로 준비해요. 게시 전에는 포함 항목·권리·수수료를 직접 확인하며, 수익은 보장되지 않아요."
      : "One creates a separate public draft without your memory or private sources. You review included items, rights, and fees before publishing; earnings are not guaranteed.",
    cta: ko ? "공개용 초안 보기" : "See public draft",
  };
}

function formatDate(value: string, locale: "ko" | "en"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function permissionLabel(value: string, ko: boolean): string {
  if (value === "read_only" || value === "read") return ko ? "보기만" : "View only";
  if (value === "draft_only" || value === "write") return ko ? "초안 만들기" : "Create drafts";
  if (value === "approval_before_external_change" || value === "full") {
    return ko ? "밖으로 보내기 전에 꼭 묻기" : "Ask before anything leaves the app";
  }
  return ko ? "시작 전에 다시 확인" : "Review before starting";
}

export function OneSuggestionCard({
  suggestion,
  state,
  locale,
  onStateChange,
}: {
  suggestion: OneEcosystemSuggestion;
  state: OneSuggestionState;
  locale: "ko" | "en";
  onStateChange: (state: OneSuggestionState) => void;
}) {
  const ko = locale === "ko";
  const router = useRouter();
  const copy = typeCopy(suggestion, ko);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const review = state.reviewRequests.find((item) => item.suggestionId === suggestion.id) ?? null;

  const continueReview = async () => {
    const api = ipc();
    if (!api || !review || busy) {
      if (!api) setError(ko ? "Desktop 제안 저장소에 연결되지 않았습니다." : "Desktop suggestion storage is unavailable.");
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
      ) throw new Error(ko ? "준비한 초안이 최신 상태와 달라 다시 불러와야 합니다." : "This draft is no longer current and needs to be reloaded.");
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
      setError(ko ? "Desktop 제안 저장소에 연결되지 않았습니다." : "Desktop suggestion storage is unavailable.");
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
      <article className={styles.receipt} aria-label={ko ? "다음 작업을 위한 초안" : "Draft for future work"}>
        <div>
          <p className={styles.eyebrow}>{ko ? "초안 준비됨" : "Draft ready"}</p>
          <h3>{ko ? "아직 저장하거나 시작하지 않았어요." : "Nothing has been saved or started yet."}</h3>
          <p>{review
            ? (ko ? `${formatDate(review.createdAt, locale)}에 준비한 초안입니다.` : `Draft prepared ${formatDate(review.createdAt, locale)}.`)
            : (ko ? "준비한 초안을 다시 불러오고 있어요." : "Reloading your draft.")}</p>
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.primary} disabled={busy || !review} onClick={() => void continueReview()}>
            {busy ? (ko ? "확인 중…" : "Checking…") : (ko ? "초안 계속 보기" : "Continue with draft")}
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
          ? (ko ? `비슷한 완료 ${suggestion.evidence.length}회` : `${suggestion.evidence.length} similar completions`)
          : (ko ? `확인된 성공 ${suggestion.evidence.length}회` : `${suggestion.evidence.length} verified successes`)}</span>
      </div>
      <p className={styles.body}>{copy.body}</p>

      {automation && <dl className={styles.previewGrid}>
        <div><dt>{ko ? "시작 조건" : "Trigger"}</dt><dd>{automation.preview.trigger}</dd></div>
        <div><dt>{ko ? "다음 예상 실행" : "Next proposed run"}</dt><dd>{formatDate(automation.preview.nextRunAt, locale)}</dd></div>
        <div><dt>{ko ? "할 수 있는 일" : "What it can do"}</dt><dd>{permissionLabel(automation.preview.permission, ko)}</dd></div>
        <div><dt>{ko ? "중지 방법" : "Stop control"}</dt><dd>{automation.preview.stopControl}</dd></div>
        <div><dt>{ko ? "외부 변경" : "External changes"}</dt><dd>{ko ? "매번 명시적 승인 필요" : "Explicit approval required every time"}</dd></div>
      </dl>}
      {automation && <p className={styles.body}>
        {ko
          ? "이 제안을 보는 것만으로는 일정을 저장하거나 자동화를 켜거나 실행하지 않아요. 내가 직접 승인해야 시작됩니다."
          : "Reviewing this proposal does not save a schedule, enable automation, or run it. Nothing starts until you approve it yourself."}
      </p>}
      {hub && <div className={styles.boundaryBox}>
        <strong>{ko ? "내 파일과 기억은 공개 초안에 넣지 않아요" : "Your files and memories stay out of the public draft"}</strong>
        <span>{ko ? "공개 설명과 기본 구조만 새로 준비합니다. 고객 자료, 로그인 정보, 내부 문서, 대화 원문은 복사하지 않습니다." : "One creates only a new public description and basic structure. Customer data, sign-in information, internal documents, and conversations are not copied."}</span>
        <small>{ko ? "게시 권한·내가 올릴 권리·크레딧 기능·수수료는 아직 확인이 필요합니다. 게시 직전에 포함 내용을 다시 보고 직접 승인하며, 수익은 보장되지 않습니다." : "Publishing access, your right to publish, credit availability, and fees still need review. You see the included items and approve again before publishing; earnings are not guaranteed."}</small>
      </div>}

      <details className={styles.evidence}>
        <summary>{ko ? "왜 이 제안이 나왔나요?" : "Why did this suggestion appear?"}</summary>
        {suggestion.evidence.map((item) => <span key={item.taskId}>
          {ko ? "완료한 시각" : "Completed"} {formatDate(item.completedAt, locale)} · {ko ? `확인한 자료 ${item.evidenceRefs.length}개` : `${item.evidenceRefs.length} checked item${item.evidenceRefs.length === 1 ? "" : "s"}`}
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
        }), ko ? "검토 요청만 준비했습니다. 실제 작업은 시작하지 않았습니다." : "Prepared a review request only. No action was started.")}>{copy.cta}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void mutate(() => ipc()!.oneSuggestions.snooze({
          expectedStoreVersion: state.version,
          suggestionId: suggestion.id,
          expectedSuggestionVersion: suggestion.version,
          confirmedByUser: true,
        }), ko ? "7일 뒤에 다시 제안할 수 있게 미뤘습니다." : "Snoozed for at least seven days.")}>{ko ? "나중에" : "Later"}</button>
      </div>
      <details className={styles.suggestionControls}>
        <summary>{ko ? "이 제안 설정" : "Suggestion settings"}</summary>
        <div>
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => void mutate(() => ipc()!.oneSuggestions.dismiss({
            expectedStoreVersion: state.version,
            suggestionId: suggestion.id,
            expectedSuggestionVersion: suggestion.version,
            confirmedByUser: true,
          }), ko ? "이 패턴의 제안을 당분간 줄입니다." : "Suggestions for this pattern will be reduced for a while.")}>{ko ? "관심 없음" : "Not interested"}</button>
          <button type="button" className={styles.danger} disabled={busy} onClick={() => void mutate(() => ipc()!.oneSuggestions.neverAsk({
            expectedStoreVersion: state.version,
            suggestionId: suggestion.id,
            expectedSuggestionVersion: suggestion.version,
            confirmedByUser: true,
          }), ko ? "이 유형은 다시 제안하지 않습니다." : "This suggestion type will not be shown again.")}>{ko ? "다시 묻지 않기" : "Never ask again"}</button>
        </div>
      </details>
    </article>
  );
}
