"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor, type Locale } from "@/lib/i18n";
import type {
  OneSuggestionReviewHandoff,
  OneSuggestionReviewHandoffInput,
  OneSuggestionReviewSeed,
  OneSuggestionReviewSurface,
  OneHubDerivativeDraft,
} from "@/lib/types";
import { isOneSuggestionReviewSeed } from "@shared/one-review-seed";
import { isOneHubDerivativeDraft } from "@shared/one-hub-derivative";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import styles from "./OneSuggestionReviewHandoff.module.css";

type ReviewFallbackKey =
  | "one.rev.error.detail"
  | "one.rev.hub.not_published"
  | "one.rev.gate.needs_review"
  | "one.rev.hub.publish_lock";

const REVIEW_FALLBACKS: Record<ReviewFallbackKey, Record<Locale, string>> = {
  "one.rev.error.detail": {
    ko: "아무것도 저장하거나 시작하거나 공개하지 않았습니다. 일정도 프롬프트도 대상도 미리 채우지 않았고, 게시도 시작하지 않았어요.",
    en: "Nothing was saved, started, or published: no schedule, prompt, or target prefilled, and publishing not started.",
  },
  "one.rev.hub.not_published": { ko: "아직 게시 안 됨", en: "Not published" },
  "one.rev.gate.needs_review": { ko: "확인 필요", en: "Needs review" },
  "one.rev.hub.publish_lock": {
    ko: "위 네 가지와 최종 포함 내용을 모두 확인하고 다시 승인하기 전에는 게시할 수 없습니다. 수익은 보장되지 않습니다.",
    en: "Publishing stays unavailable until all four items and the final contents are reviewed and approved again. Earnings are not guaranteed.",
  },
};

function reviewCopy(locale: Locale, key: ReviewFallbackKey): string {
  const value = tFor(locale, key);
  return value === key ? REVIEW_FALLBACKS[key][locale] : value;
}

const SUGGESTION_ID_RE = /^one_suggestion_[a-f0-9]{32}$/;
const REVIEW_ID_RE = /^one_suggestion_review_[a-f0-9]{32}$/;
const DRAFT_ID_RE = /^one_(?:plugin|agent|team|automation|hub)_draft_[a-f0-9]{32}$/;
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

function reviewLabel(handoff: OneSuggestionReviewHandoff, locale: Locale): string {
  if (handoff.type === "plugin_build") return locale === "ko" ? "플러그인 빌더" : "Plugin builder";
  if (handoff.type === "agent_build") return tFor(locale, "one.rev.label.agent");
  if (handoff.type === "retain_team") return tFor(locale, "one.rev.label.team");
  if (handoff.type === "automation") return tFor(locale, "one.rev.label.automation");
  return tFor(locale, "one.rev.label.hub");
}

function permissionLabel(value: string, locale: Locale): string {
  if (value === "read_only" || value === "read") return tFor(locale, "one.rev.perm.view");
  if (value === "draft_only" || value === "write") return tFor(locale, "one.rev.perm.draft");
  return tFor(locale, "one.rev.perm.approval");
}

function seedPreview(seed: Exclude<OneSuggestionReviewSeed, { kind: "blocked" }>, locale: Locale): string {
  if (seed.kind === "plugin_build") {
    return locale === "ko"
      ? `반복 절차 플러그인 · 도구 ${seed.observedToolCount}개 · 작업 종류 ${seed.taskKindRef}`
      : `Repeated procedure plugin · ${seed.observedToolCount} tools · task kind ${seed.taskKindRef}`;
  }
  if (seed.kind === "agent_build") {
    return tFor(locale, "one.rev.seed.agent", { name: seed.candidate.name });
  }
  if (seed.kind === "retain_team") {
    const names = seed.candidates.map((candidate) => locale === "ko" ? candidate.name : candidate.nameEn).join(", ");
    return tFor(locale, "one.rev.seed.team", { names, count: seed.candidates.length });
  }
  if (seed.kind === "automation") {
    return tFor(locale, "one.rev.seed.automation", { trigger: seed.triggerPreview, perm: permissionLabel(seed.permission, locale) });
  }
  return tFor(locale, "one.rev.seed.hub");
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

  useEffect(() => {
    setHandoff(null);
    setSeed(null);
    setHubDraft(null);
    setError(null);
    if (parsed.kind === "absent") return;
    if (parsed.kind === "invalid") {
      setError(tFor(locale, "one.rev.err.unsafe"));
      return;
    }
    const currentParams = new URLSearchParams(query);
    if (
      surface === "work"
      && (currentParams.getAll("task").length !== 1 || currentParams.get("task") !== parsed.input.originTaskId)
    ) {
      setError(tFor(locale, "one.rev.err.diff_work"));
      return;
    }
    const api = ipc();
    if (!api) {
      requestOneOperationalRecovery("one-suggestion-handoff", new Error("Desktop bridge unavailable"));
      setError(null);
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
        setError(tFor(locale, "one.rev.err.mismatch"));
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
        setError(tFor(locale, "one.rev.err.seed_stale"));
        return;
      }
      if (resolvedSeed.kind === "blocked") {
        setError(tFor(locale, "one.rev.err.blocked"));
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
          setError(tFor(locale, "one.rev.err.hub_stale"));
          return;
        }
        setHubDraft(resolvedDraft);
      }
      setHandoff(resolved);
      setSeed(resolvedSeed);
    }).catch((cause) => {
      if (!cancelled) {
        requestOneOperationalRecovery("one-suggestion-handoff", cause);
        setError(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [locale, parsed, query, surface]);

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
      setError(tFor(locale, "one.rev.err.editor_busy"));
      return;
    }
    materializedDraftRef.current = seed.draftId;
  }, [locale, onReviewSeed, seed]);

  if (parsed.kind === "absent") return null;
  if (error) {
    return <section className={styles.error} role="alert" data-one-review-state="blocked">
      <strong>{tFor(locale, "one.rev.error.title")}</strong>
      <span>{error}</span>
      <small>{reviewCopy(locale, "one.rev.error.detail")}</small>
    </section>;
  }
  if (!handoff) {
    return <section className={styles.loading} role="status" data-one-review-state="loading">
      <span>{tFor(locale, "one.rev.loading")}</span>
      <LoadingEstimate locale={locale} operationKey="one-suggestion-review" expectedSeconds={[1, 15]} />
    </section>;
  }

  return <section className={styles.banner} role="status" data-one-review-state="verified">
    <div className={styles.copy}>
      <span className={styles.eyebrow}>{tFor(locale, "one.rev.banner.eyebrow")}</span>
      <strong>{tFor(locale, "one.rev.review_cta", { label: reviewLabel(handoff, locale) })}</strong>
      <p>{hubDraft
        ? tFor(locale, "one.rev.body.hub")
        : handoff.fallbackToOriginTaskWork
          ? tFor(locale, "one.rev.body.fallback")
          : tFor(locale, "one.rev.body.starting_point")}</p>
      {seed ? <p data-one-review-seed-kind={seed.kind}>{seedPreview(seed, locale)}</p> : null}
      {hubDraft ? <div className={styles.hubDraft} data-one-hub-derivative-state="local-review">
        <div className={styles.hubDraftHeading}>
          <strong>{tFor(locale, "one.rev.hub.review_heading")}</strong>
          <span>{reviewCopy(locale, "one.rev.hub.not_published")}</span>
        </div>
        <dl className={styles.gates} aria-label={tFor(locale, "one.rev.hub.gates_aria")}>
          {(["entitlement", "rights", "economy", "fee"] as const).map((gate) => <div key={gate}>
            <dt>{gate === "entitlement" ? tFor(locale, "one.rev.gate.entitlement")
              : gate === "rights" ? tFor(locale, "one.rev.gate.rights")
                : gate === "economy" ? tFor(locale, "one.rev.gate.economy")
                  : tFor(locale, "one.rev.gate.fee")}</dt>
            <dd>{reviewCopy(locale, "one.rev.gate.needs_review")}</dd>
          </div>)}
        </dl>
        <div className={styles.diffGrid}>
          <section aria-label={tFor(locale, "one.rev.hub.included_aria")}>
            <strong>{tFor(locale, "one.rev.hub.included_count", { n: hubDraft.includedFiles.length })}</strong>
            <ul>{hubDraft.includedFiles.map((file) => <li key={file.path}>
              <code>{file.path}</code><span>{file.bytes.toLocaleString()} B · {file.source === "generated" ? tFor(locale, "one.rev.hub.source_generated") : tFor(locale, "one.rev.hub.source_allowlisted")}</span>
            </li>)}</ul>
          </section>
          <section aria-label={tFor(locale, "one.rev.hub.excluded_aria")}>
            <strong>{tFor(locale, "one.rev.hub.always_excluded")}</strong>
            <p>{hubDraft.alwaysExcludedCategories.join(" · ")}</p>
            {hubDraft.excluded.length > 0 ? <ul>{hubDraft.excluded.map((item) => <li key={item.category}>
              <code>{item.category}</code><span>{item.count} {tFor(locale, "one.rev.hub.items")}</span>
            </li>)}</ul> : null}
          </section>
        </div>
        <p className={styles.publishLock} role="note">
          {reviewCopy(locale, "one.rev.hub.publish_lock")}
        </p>
      </div> : null}
    </div>
    <details className={styles.refs}>
      <summary>{tFor(locale, "one.rev.refs.summary")}</summary>
      <dl>
        <div><dt>{tFor(locale, "one.rev.refs.draft_number")}</dt><dd>{handoff.draftId.slice(-8)}</dd></div>
        <div><dt>{tFor(locale, "one.rev.refs.source_work")}</dt><dd>{handoff.originTaskId.slice(-8)}</dd></div>
        <div>
          <dt>{handoff.evidenceBasis === "accepted_internal_results"
            ? tFor(locale, "one.rev.refs.accepted")
            : tFor(locale, "one.rev.refs.verified")}</dt>
          <dd>{handoff.sourceTaskCount}</dd>
        </div>
        {hubDraft ? <div><dt>{tFor(locale, "one.rev.refs.draft_location")}</dt><dd>{hubDraft.draftPathRef}</dd></div> : null}
      </dl>
    </details>
  </section>;
}
