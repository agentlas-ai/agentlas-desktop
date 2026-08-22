"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import styles from "./LoadingEstimate.module.css";

const STORAGE_KEY = "agentlas.loading-estimates.v1";
const MAX_SAMPLES = 8;

type Locale = "ko" | "en";
type ExpectedSeconds = readonly [number, number];
type StoredSamples = Record<string, number[]>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeProgress(progress: number | null | undefined): number | null {
  if (progress == null || !Number.isFinite(progress)) return null;
  const normalized = progress > 1 ? progress / 100 : progress;
  return clamp(normalized, 0, 1);
}

function readSamples(operationKey: string | undefined): number[] {
  if (!operationKey || typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as StoredSamples;
    const samples = parsed[operationKey];
    return Array.isArray(samples)
      ? samples.filter((value) => Number.isFinite(value) && value >= 2 && value <= 60 * 60).slice(-MAX_SAMPLES)
      : [];
  } catch {
    return [];
  }
}

function storeSample(operationKey: string, elapsedSeconds: number): void {
  if (typeof window === "undefined" || elapsedSeconds < 2 || elapsedSeconds > 60 * 60) return;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as StoredSamples;
    const samples = Array.isArray(parsed[operationKey]) ? parsed[operationKey] : [];
    parsed[operationKey] = [...samples, Math.round(elapsedSeconds)].slice(-MAX_SAMPLES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Private storage or a full quota must never break the loading surface.
  }
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1);
  return sorted[index];
}

function learnedRange(samples: number[]): ExpectedSeconds | null {
  if (samples.length < 3) return null;
  const low = Math.max(2, percentile(samples, 0.25) * 0.9);
  const high = Math.max(low + 2, percentile(samples, 0.75) * 1.15);
  return [low, high];
}

function roundedSeconds(seconds: number): number {
  if (seconds < 15) return Math.max(1, Math.ceil(seconds));
  if (seconds < 60) return Math.ceil(seconds / 5) * 5;
  return Math.ceil(seconds / 10) * 10;
}

function formatDuration(seconds: number, locale: Locale): string {
  const value = roundedSeconds(Math.max(0, seconds));
  if (value < 60) return locale === "ko" ? `${value}초` : `${value}s`;
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  if (!remainder) return locale === "ko" ? `${minutes}분` : `${minutes}m`;
  return locale === "ko" ? `${minutes}분 ${remainder}초` : `${minutes}m ${remainder}s`;
}

function formatRemainingRange(low: number, high: number, locale: Locale): string {
  const safeLow = Math.max(0, low);
  const safeHigh = Math.max(safeLow, high);
  if (safeHigh <= 8) return locale === "ko" ? "곧 완료" : "Finishing soon";
  if (safeLow <= 2) {
    return locale === "ko"
      ? `최대 약 ${formatDuration(safeHigh, locale)} 남음`
      : `Up to about ${formatDuration(safeHigh, locale)} left`;
  }
  return locale === "ko"
    ? `약 ${formatDuration(safeLow, locale)}–${formatDuration(safeHigh, locale)} 남음`
    : `About ${formatDuration(safeLow, locale)}–${formatDuration(safeHigh, locale)} left`;
}

export const LoadingEstimate = memo(function LoadingEstimate({
  locale,
  operationKey,
  startedAt,
  expectedSeconds,
  progress,
  compact = false,
  inverse = false,
  className,
  recordOnUnmount = true,
}: {
  locale: Locale;
  /** Stable, non-sensitive identifier used only for recent local duration samples. */
  operationKey?: string;
  /** Epoch milliseconds. Omit when this component mounts with the operation. */
  startedAt?: number | null;
  /** Honest cold-start range used until three local completions have been observed. */
  expectedSeconds?: ExpectedSeconds;
  /** 0..1 or 0..100. When present, remaining time is derived from actual progress. */
  progress?: number | null;
  compact?: boolean;
  inverse?: boolean;
  className?: string;
  recordOnUnmount?: boolean;
}) {
  const mountedAt = useRef(Date.now());
  const anchor = startedAt ?? mountedAt.current;
  const anchorRef = useRef(anchor);
  const [now, setNow] = useState(() => Date.now());
  const [samples] = useState(() => readSamples(operationKey));

  useEffect(() => {
    anchorRef.current = anchor;
    setNow(Date.now());
  }, [anchor]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => () => {
    if (!recordOnUnmount || !operationKey) return;
    storeSample(operationKey, (Date.now() - anchorRef.current) / 1_000);
  }, [operationKey, recordOnUnmount]);

  const elapsed = Math.max(0, (now - anchor) / 1_000);
  const normalizedProgress = normalizeProgress(progress);
  const observedRange = useMemo(() => learnedRange(samples), [samples]);

  let remainingLabel: string;
  let basis: "progress" | "history" | "range" | "unknown" = "unknown";
  if (normalizedProgress !== null && normalizedProgress >= 0.04 && elapsed >= 4) {
    const remaining = normalizedProgress >= 0.995
      ? 0
      : clamp((elapsed / normalizedProgress) * (1 - normalizedProgress), 0, 60 * 60);
    remainingLabel = remaining <= 8
      ? (locale === "ko" ? "곧 완료" : "Finishing soon")
      : (locale === "ko"
          ? `약 ${formatDuration(remaining, locale)} 남음`
          : `About ${formatDuration(remaining, locale)} left`);
    basis = "progress";
  } else {
    const range = observedRange ?? expectedSeconds ?? null;
    if (!range) {
      remainingLabel = locale === "ko" ? "남은 시간 계산 중" : "Calculating time left";
    } else if (elapsed > range[1]) {
      remainingLabel = locale === "ko" ? "예상보다 오래 걸리는 중" : "Taking longer than expected";
      basis = observedRange ? "history" : "range";
    } else {
      remainingLabel = formatRemainingRange(range[0] - elapsed, range[1] - elapsed, locale);
      basis = observedRange ? "history" : "range";
    }
  }

  const elapsedLabel = locale === "ko"
    ? `${formatDuration(elapsed, locale)} 경과`
    : `${formatDuration(elapsed, locale)} elapsed`;
  const title = basis === "progress"
    ? (locale === "ko" ? "실제 진행률로 계산한 예상입니다." : "Estimated from actual progress.")
    : basis === "history"
      ? (locale === "ko" ? "이 기기에서 최근 완료된 시간을 기준으로 계산했습니다." : "Estimated from recent completions on this device.")
      : basis === "range"
        ? (locale === "ko" ? "이 작업의 일반적인 소요 범위입니다." : "Based on the usual range for this operation.")
        : (locale === "ko" ? "진행 데이터가 쌓이면 남은 시간을 표시합니다." : "Time left appears when progress data is available.");

  return (
    <span
      className={[styles.estimate, className].filter(Boolean).join(" ")}
      data-compact={compact ? "true" : "false"}
      data-inverse={inverse ? "true" : "false"}
      data-estimate-basis={basis}
      role="status"
      aria-live="off"
      title={title}
    >
      {remainingLabel} · {elapsedLabel}
    </span>
  );
});
