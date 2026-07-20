"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import type {
  OneSuggestionReviewHandoff,
  OneSuggestionReviewHandoffInput,
  OneSuggestionReviewSeed,
  OneSuggestionReviewSurface,
  OneHubDerivativeDraft,
} from "@/lib/types";
import { isOneSuggestionReviewSeed } from "@shared/one-review-seed";
import { isOneHubDerivativeDraft } from "@shared/one-hub-derivative";
import styles from "./OneSuggestionReviewHandoff.module.css";

const SUGGESTION_ID_RE = /^one_suggestion_[a-f0-9]{32}$/;
const REVIEW_ID_RE = /^one_suggestion_review_[a-f0-9]{32}$/;
const DRAFT_ID_RE = /^one_(?:agent|team|automation|hub)_draft_[a-f0-9]{32}$/;
const SAFE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

type ParsedHandoff =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; input: OneSuggestionReviewHandoffInput };

export type OneReviewSeedApplyResult = "applied" | "defer" | "blocked";

function parseHandoffQuery(query: string): ParsedHandoff {
  const params = new URLSearchParams(query);
  const fields = ["suggestionId", "suggestionVersion", "reviewRequestId", "draftId", "originTaskId"] as const;
  const requested = params.get("oneReview") !== null || fields.some((field) => params.get(field) !== null);
  if (!requested) return { kind: "absent" };
  if (["oneReview", ...fields].some((field) => params.getAll(field).length !== 1)) {
    return { kind: "invalid", reason: "duplicate or missing binding" };
  }
  if (params.get("oneReview") !== "1") return { kind: "invalid", reason: "review marker" };
  const suggestionId = params.get("suggestionId") ?? "";
  const versionRaw = params.get("suggestionVersion") ?? "";
  const reviewRequestId = params.get("reviewRequestId") ?? "";
  const draftId = params.get("draftId") ?? "";
  const originTaskId = params.get("originTaskId") ?? "";
  const expectedSuggestionVersion = /^\d+$/.test(versionRaw) ? Number(versionRaw) : Number.NaN;
  if (!SUGGESTION_ID_RE.test(suggestionId)) return { kind: "invalid", reason: "suggestion id" };
  if (!Number.isSafeInteger(expectedSuggestionVersion) || expectedSuggestionVersion <= 0) {
    return { kind: "invalid", reason: "suggestion version" };
  }
  if (!REVIEW_ID_RE.test(reviewRequestId)) return { kind: "invalid", reason: "review request id" };
  if (!DRAFT_ID_RE.test(draftId)) return { kind: "invalid", reason: "draft id" };
  if (!SAFE_TASK_ID_RE.test(originTaskId)) return { kind: "invalid", reason: "origin Task id" };
  return {
    kind: "valid",
    input: { suggestionId, expectedSuggestionVersion, reviewRequestId, draftId, originTaskId },
  };
}

function reviewLabel(handoff: OneSuggestionReviewHandoff, ko: boolean): string {
  if (handoff.type === "agent_build") return ko ? "내 전담 도우미 초안" : "personal helper draft";
  if (handoff.type === "retain_team") return ko ? "내 팀 초안" : "saved team draft";
  if (handoff.type === "automation") return ko ? "미리 해둘 일 초안" : "prepared routine draft";
  return ko ? "공개용 초안" : "public draft";
}

function permissionLabel(value: string, ko: boolean): string {
  if (value === "read_only" || value === "read") return ko ? "보기만" : "View only";
  if (value === "draft_only" || value === "write") return ko ? "초안 만들기" : "Create drafts";
  return ko ? "밖으로 보내기 전에 꼭 묻기" : "Ask before anything leaves the app";
}

function seedPreview(seed: Exclude<OneSuggestionReviewSeed, { kind: "blocked" }>, ko: boolean): string {
  if (seed.kind === "agent_build") {
    return ko
      ? `${seed.candidate.name}의 이름과 맡을 일만 채워두었습니다. 아직 저장하지 않았어요.`
      : `Only ${seed.candidate.name}'s name and job are filled in. It has not been saved.`;
  }
  if (seed.kind === "retain_team") {
    const names = seed.candidates.map((candidate) => ko ? candidate.name : candidate.nameEn).join(", ");
    return ko ? `${names} ${seed.candidates.length}명이 함께할 팀 초안입니다. 아직 저장하지 않았어요.` : `This draft team has ${seed.candidates.length} member(s): ${names}. It has not been saved.`;
  }
  if (seed.kind === "automation") {
    return ko
      ? `${seed.triggerPreview}일 때 준비합니다. 할 수 있는 일: ${permissionLabel(seed.permission, ko)}. 시간과 세부 내용은 아직 비어 있어요.`
      : `Prepares when ${seed.triggerPreview}. What it can do: ${permissionLabel(seed.permission, ko)}. Timing and details are still empty.`;
  }
  return ko
    ? "공개 설명과 기본 구조만 새로 만들었습니다. 내 파일은 복사하지 않았고 게시도 시작하지 않았어요."
    : "Only a new public description and basic structure were created. Your files were not copied and publishing has not started.";
}

export function OneSuggestionReviewHandoffBanner({
  surface,
  locale,
  onReviewSeed,
}: {
  surface: OneSuggestionReviewSurface;
  locale: "ko" | "en";
  onReviewSeed?: (seed: Exclude<OneSuggestionReviewSeed, { kind: "blocked" }>) => OneReviewSeedApplyResult;
}) {
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const parsed = useMemo(() => parseHandoffQuery(query), [query]);
  const [handoff, setHandoff] = useState<OneSuggestionReviewHandoff | null>(null);
  const [seed, setSeed] = useState<Exclude<OneSuggestionReviewSeed, { kind: "blocked" }> | null>(null);
  const [hubDraft, setHubDraft] = useState<OneHubDerivativeDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const materializedDraftRef = useRef<string | null>(null);
  const ko = locale === "ko";

  useEffect(() => {
    setHandoff(null);
    setSeed(null);
    setHubDraft(null);
    setError(null);
    if (parsed.kind === "absent") return;
    if (parsed.kind === "invalid") {
      setError(ko
        ? "이 초안은 더 이상 안전하게 열 수 없습니다. One으로 돌아가 최신 제안을 다시 열어주세요."
        : "This draft can no longer be opened safely. Return to One and open the latest suggestion.");
      return;
    }
    const currentParams = new URLSearchParams(query);
    if (
      surface === "work"
      && (currentParams.getAll("task").length !== 1 || currentParams.get("task") !== parsed.input.originTaskId)
    ) {
      setError(ko
        ? "지금 연 일이 이 초안을 만든 일과 달라 열지 않았습니다. One으로 돌아가 다시 열어주세요."
        : "This draft belongs to different work, so it was not opened. Return to One and try again.");
      return;
    }
    const api = ipc();
    if (!api) {
      setError(ko ? "Desktop에서 준비한 초안을 불러올 수 없습니다." : "The draft prepared on Desktop is unavailable.");
      return;
    }
    let cancelled = false;
    void Promise.all([
      api.oneSuggestions.getReviewHandoff(parsed.input),
      api.oneSuggestions.getReviewSeed(parsed.input),
    ]).then(async ([resolved, resolvedSeed]) => {
      if (cancelled) return;
      if (
        resolved.targetSurface !== surface
        || resolved.suggestionId !== parsed.input.suggestionId
        || resolved.suggestionVersion !== parsed.input.expectedSuggestionVersion
        || resolved.reviewRequestId !== parsed.input.reviewRequestId
        || resolved.draftId !== parsed.input.draftId
        || resolved.originTaskId !== parsed.input.originTaskId
        || resolved.reviewOnly !== true
        || resolved.actionState !== "not_started"
        || !["accepted_internal_results", "verified_outcomes"].includes(resolved.evidenceBasis)
        || resolved.externalOutcomeVerified !== (resolved.evidenceBasis === "verified_outcomes")
      ) {
        setError(ko
          ? "이 초안은 현재 화면이나 최신 상태와 달라 열지 않았습니다."
          : "This draft no longer matches the current screen or latest state.");
        return;
      }
      if (
        !isOneSuggestionReviewSeed(resolvedSeed)
        || resolvedSeed.targetSurface !== surface
        || resolvedSeed.suggestionId !== parsed.input.suggestionId
        || resolvedSeed.suggestionVersion !== parsed.input.expectedSuggestionVersion
        || resolvedSeed.reviewRequestId !== parsed.input.reviewRequestId
        || resolvedSeed.draftId !== parsed.input.draftId
        || resolvedSeed.originTaskId !== parsed.input.originTaskId
        || resolvedSeed.reviewOnly !== true
        || resolvedSeed.actionState !== "not_started"
      ) {
        setError(ko
          ? "초안 내용이 최신 상태와 달라 자동으로 채우지 않았습니다."
          : "The draft content is no longer current, so it was not filled in.");
        return;
      }
      if (resolvedSeed.kind === "blocked") {
        setError(ko
          ? "안전하게 준비할 수 없는 내용이 있어 초안을 만들지 않았습니다."
          : "The draft was not created because some content could not be prepared safely.");
        return;
      }
      if (resolvedSeed.kind === "hub_derivative") {
        const resolvedDraft = await api.oneHubDerivative.getDraft(parsed.input);
        if (cancelled) return;
        if (
          resolved.type !== "hub_derivative"
          || !isOneHubDerivativeDraft(resolvedDraft)
          || resolvedDraft.suggestionId !== parsed.input.suggestionId
          || resolvedDraft.reviewRequestId !== parsed.input.reviewRequestId
          || resolvedDraft.draftId !== parsed.input.draftId
          || resolvedDraft.originTaskId !== parsed.input.originTaskId
          || resolvedDraft.status !== "local_review"
          || resolvedDraft.gates.publishAllowed !== false
          || resolvedDraft.gates.publishingStarted !== false
          || resolvedDraft.gates.revenueGuaranteed !== false
        ) {
          setError(ko
            ? "공개용 초안이 최신 상태와 달라 열지 않았습니다."
            : "The public draft is no longer current, so it was not opened.");
          return;
        }
        setHubDraft(resolvedDraft);
      }
      setHandoff(resolved);
      setSeed(resolvedSeed);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [ko, parsed, query, surface]);

  useEffect(() => {
    if (!seed || !onReviewSeed || materializedDraftRef.current === seed.draftId) return;
    let result: OneReviewSeedApplyResult;
    try {
      result = onReviewSeed(seed);
    } catch {
      result = "blocked";
    }
    if (result === "defer") return;
    if (result === "blocked") {
      setError(ko
        ? "이미 작성 중인 내용이 있어 초안을 덮어쓰지 않았습니다."
        : "The editor already contains work, so the draft did not overwrite it.");
      return;
    }
    materializedDraftRef.current = seed.draftId;
  }, [ko, onReviewSeed, seed]);

  if (parsed.kind === "absent") return null;
  if (error) {
    return <section className={styles.error} role="alert" data-one-review-state="blocked">
      <strong>{ko ? "초안을 열지 않았어요" : "Draft not opened"}</strong>
      <span>{error}</span>
      <small>{ko
        ? "아무것도 저장하거나 시작하거나 공개하지 않았습니다. 일정도 프롬프트도 대상도 미리 채우지 않았고, 게시도 시작하지 않았어요."
        : "Nothing was saved, started, or published: no schedule, prompt, or target prefilled, and publishing not started."}</small>
    </section>;
  }
  if (!handoff) {
    return <section className={styles.loading} role="status" data-one-review-state="loading">
      {ko ? "One이 준비한 초안을 확인하고 있어요…" : "Checking the draft One prepared…"}
    </section>;
  }

  return <section className={styles.banner} role="status" data-one-review-state="verified">
    <div className={styles.copy}>
      <span className={styles.eyebrow}>{ko ? "ONE이 준비한 초안" : "DRAFT PREPARED BY ONE"}</span>
      <strong>{ko ? `${reviewLabel(handoff, ko)}을 확인해보세요.` : `Review your ${reviewLabel(handoff, ko)}.`}</strong>
      <p>{hubDraft
        ? (ko
          ? "내 원본과 완전히 분리된 공개용 초안을 만들었습니다. 아직 게시하거나 가격을 정하지 않았고 원본도 바꾸지 않았어요."
          : "One created a public draft completely separate from your original. It has not been published or priced, and your original is unchanged.")
        : handoff.fallbackToOriginTaskWork
          ? (ko
            ? "이 초안을 만든 일로 돌아왔습니다. 직접 저장하기 전에는 아무것도 바뀌지 않아요."
            : "You are back in the work that created this draft. Nothing changes until you save it.")
          : (ko
            ? "One이 시작점만 채워두었습니다. 아래에서 직접 저장하거나 시작하기 전에는 아무것도 바뀌지 않아요."
            : "One filled in only the starting point. Nothing changes until you save or start it below.")}</p>
      {seed ? <p data-one-review-seed-kind={seed.kind}>{seedPreview(seed, ko)}</p> : null}
      {hubDraft ? <div className={styles.hubDraft} data-one-hub-derivative-state="local-review">
        <div className={styles.hubDraftHeading}>
          <strong>{ko ? "공개용 초안 확인" : "Review public draft"}</strong>
          <span>{ko ? "아직 게시 안 됨" : "Not published"}</span>
        </div>
        <dl className={styles.gates} aria-label={ko ? "Hub 공개 선행 조건" : "Hub publish prerequisites"}>
          {(["entitlement", "rights", "economy", "fee"] as const).map((gate) => <div key={gate}>
            <dt>{gate === "entitlement" ? (ko ? "게시 권한" : "Publishing access")
              : gate === "rights" ? (ko ? "내가 올릴 권리" : "Your right to publish")
                : gate === "economy" ? (ko ? "크레딧 기능" : "Credit availability")
                  : (ko ? "수수료 안내" : "Fee information")}</dt>
            <dd>{ko ? "확인 필요" : "Needs review"}</dd>
          </div>)}
        </dl>
        <div className={styles.diffGrid}>
          <section aria-label={ko ? "공개 초안 포함 파일" : "Included public draft files"}>
            <strong>{ko ? `포함 ${hubDraft.includedFiles.length}` : `Included ${hubDraft.includedFiles.length}`}</strong>
            <ul>{hubDraft.includedFiles.map((file) => <li key={file.path}>
              <code>{file.path}</code><span>{file.bytes.toLocaleString()} B · {file.source === "generated" ? (ko ? "생성" : "generated") : (ko ? "허용 원본" : "allowlisted source")}</span>
            </li>)}</ul>
          </section>
          <section aria-label={ko ? "공개 초안 제외 범위" : "Excluded private scope"}>
            <strong>{ko ? "항상 제외" : "Always excluded"}</strong>
            <p>{hubDraft.alwaysExcludedCategories.join(" · ")}</p>
            {hubDraft.excluded.length > 0 ? <ul>{hubDraft.excluded.map((item) => <li key={item.category}>
              <code>{item.category}</code><span>{item.count} {ko ? "항목" : "item(s)"}</span>
            </li>)}</ul> : null}
          </section>
        </div>
        <p className={styles.publishLock} role="note">
          {ko
            ? "위 네 가지와 최종 포함 내용을 모두 확인하고 다시 승인하기 전에는 게시할 수 없습니다. 수익은 보장되지 않습니다."
            : "Publishing stays unavailable until all four items and the final contents are reviewed and approved again. Earnings are not guaranteed."}
        </p>
      </div> : null}
    </div>
    <details className={styles.refs}>
      <summary>{ko ? "확인 기록" : "Check record"}</summary>
      <dl>
        <div><dt>{ko ? "초안 번호" : "Draft number"}</dt><dd>{handoff.draftId.slice(-8)}</dd></div>
        <div><dt>{ko ? "시작한 일" : "Source work"}</dt><dd>{handoff.originTaskId.slice(-8)}</dd></div>
        <div>
          <dt>{handoff.evidenceBasis === "accepted_internal_results"
            ? (ko ? "직접 확인한 완료" : "Completions you accepted")
            : (ko ? "결과까지 확인한 완료" : "Verified outcomes")}</dt>
          <dd>{handoff.sourceTaskCount}</dd>
        </div>
        {hubDraft ? <div><dt>{ko ? "초안 위치" : "Draft location"}</dt><dd>{hubDraft.draftPathRef}</dd></div> : null}
      </dl>
    </details>
  </section>;
}
