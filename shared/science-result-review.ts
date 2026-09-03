import { createHash } from "node:crypto";
import type {
  ScienceEpisodeResultReviewReceipt,
  ScienceEpisodeResultReviewSelectedAction,
} from "./science-contract";

export const SCIENCE_EPISODE_RESULT_REVIEW_SCHEMA = "agentlas.science.episode-result-review/v1" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().flatMap((key) => {
    const child = (value as Record<string, unknown>)[key];
    return child === undefined ? [] : [[key, canonicalValue(child)]];
  }));
}

export function scienceEpisodeResultReviewSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

export function scienceEpisodeResultReviewActionSha256(action: ScienceEpisodeResultReviewSelectedAction): string {
  return scienceEpisodeResultReviewSha256({
    schema: "agentlas.science.episode-result-review-action/v1",
    ...action,
  });
}

export function scienceEpisodeResultReviewReceiptSha256(
  receipt: Omit<ScienceEpisodeResultReviewReceipt, "reviewSha256">,
): string {
  return scienceEpisodeResultReviewSha256(receipt);
}

export function assertScienceEpisodeResultReviewReceipt(receipt: ScienceEpisodeResultReviewReceipt): void {
  if (!receipt || receipt.schema !== SCIENCE_EPISODE_RESULT_REVIEW_SCHEMA
    || !UUID_RE.test(receipt.id) || !UUID_RE.test(receipt.requestId)
    || !UUID_RE.test(receipt.projectId) || !UUID_RE.test(receipt.loopSessionId) || !UUID_RE.test(receipt.episodeId)
    || !ID_RE.test(receipt.labId) || !["accepted", "rejected"].includes(receipt.verdict)
    || !Number.isSafeInteger(receipt.projectVersion) || receipt.projectVersion < 1
    || !Number.isSafeInteger(receipt.loopVersion) || receipt.loopVersion < 1
    || !Number.isSafeInteger(receipt.episodeVersion) || receipt.episodeVersion < 1
    || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1
    || !SHA256_RE.test(receipt.projectContentSha256) || !SHA256_RE.test(receipt.loopStateSha256)
    || !SHA256_RE.test(receipt.episodeStateSha256) || !SHA256_RE.test(receipt.resultSha256)
    || !SHA256_RE.test(receipt.basisSha256) || !SHA256_RE.test(receipt.projectionSha256)
    || !SHA256_RE.test(receipt.selectedNextActionSha256) || !SHA256_RE.test(receipt.reviewSha256)
    || receipt.previousReviewSha256 !== null && !SHA256_RE.test(receipt.previousReviewSha256)
    || typeof receipt.rationale !== "string" || !receipt.rationale.trim() || receipt.rationale.length > 20_000
    || typeof receipt.reviewerRef !== "string" || !/^account-sha256:[a-f0-9]{64}$/.test(receipt.reviewerRef)
    || typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt))
    || !receipt.selectedNextAction || receipt.selectedNextAction.trigger !== receipt.selectedNextTrigger
    || scienceEpisodeResultReviewActionSha256(receipt.selectedNextAction) !== receipt.selectedNextActionSha256
    || !Array.isArray(receipt.artifacts) || receipt.artifacts.length > 100) {
    throw new Error("science-episode-result-review-integrity-failed");
  }
  const sorted = [...receipt.artifacts].sort((left, right) => left.artifactId.localeCompare(right.artifactId)
    || left.artifactVersion - right.artifactVersion);
  if (sorted.some((item, index) => item !== receipt.artifacts[index]
    || !UUID_RE.test(item.artifactId) || !Number.isSafeInteger(item.artifactVersion) || item.artifactVersion < 1
    || !SHA256_RE.test(item.contentSha256))
    || new Set(sorted.map((item) => `${item.artifactId}:v${item.artifactVersion}`)).size !== sorted.length) {
    throw new Error("science-episode-result-review-artifacts-invalid");
  }
  const { reviewSha256, ...unsigned } = receipt;
  if (scienceEpisodeResultReviewReceiptSha256(unsigned) !== reviewSha256) {
    throw new Error("science-episode-result-review-integrity-failed");
  }
}
