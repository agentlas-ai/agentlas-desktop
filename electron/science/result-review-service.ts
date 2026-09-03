import { randomUUID } from "node:crypto";
import type {
  InspectScienceEpisodeResultReviewInput,
  RecordScienceEpisodeResultReviewInput,
  RecordScienceEpisodeResultReviewResult,
  ScienceEpisodeResultReviewInspection,
  ScienceEpisodeResultReviewReceipt,
  ScienceEpisodeResultReviewSelectedAction,
} from "../../shared/science-contract";
import type { ScienceLabCapabilityCatalog } from "../../shared/science-lab-capability";
import { scienceResearchIntentCatalog, type ScienceResearchNextAction } from "../../shared/science-research-intent";
import {
  scienceLabDecisionProjectSha256,
} from "../../shared/science-lab-decision-projection";
import {
  SCIENCE_EPISODE_RESULT_REVIEW_SCHEMA,
  scienceEpisodeResultReviewActionSha256,
  scienceEpisodeResultReviewReceiptSha256,
  scienceEpisodeResultReviewSha256,
} from "../../shared/science-result-review";
import { scienceLabDecisionProjectionsForProject } from "./lab-decision-projection-service";
import type { ScienceStore } from "./store";

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const LAB_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;

function resolvedAction(
  store: ScienceStore,
  projectId: string,
  projection: ReturnType<typeof scienceLabDecisionProjectionsForProject>[number],
  action: ScienceResearchNextAction,
): ScienceEpisodeResultReviewSelectedAction | null {
  let destinationId: string | null = action.destinationId;
  if (action.destinationKind === "artifact") {
    const selected = action.destinationId === null
      ? projection.basis.artifacts.length === 1 ? projection.basis.artifacts[0] : null
      : projection.basis.artifacts.find((binding) => binding.artifactId === action.destinationId) ?? null;
    if (!selected) return null;
    destinationId = selected.artifactId;
  } else if (action.destinationKind === "analysis-plan") {
    if (!projection.basis.plan || projection.basis.plan.planKind !== "analysis-spec"
      || action.destinationId !== null && action.destinationId !== projection.basis.plan.id) return null;
    destinationId = projection.basis.plan.id;
  } else if (action.destinationKind === "human-decision") {
    if (!projection.basis.blockingDecision
      || action.destinationId !== null && action.destinationId !== projection.basis.blockingDecision.id) return null;
    destinationId = projection.basis.blockingDecision.id;
  } else if (action.destinationKind === "lab") {
    destinationId = action.destinationId ?? projection.labId;
  } else if (action.destinationKind === "manuscript") {
    const manuscripts = store.listManuscripts(projectId);
    const manuscript = action.destinationId === null
      ? manuscripts.length === 1 ? manuscripts[0] : null
      : manuscripts.find((candidate) => candidate.id === action.destinationId) ?? null;
    if (!manuscript) return null;
    destinationId = manuscript.id;
  }
  return {
    trigger: action.trigger,
    action: action.action,
    reason: action.reason,
    destinationKind: action.destinationKind,
    destinationId,
    requiresHumanDecision: action.requiresHumanDecision,
  };
}

export function inspectScienceEpisodeResultReview(
  store: ScienceStore,
  catalog: ScienceLabCapabilityCatalog,
  input: InspectScienceEpisodeResultReviewInput,
): ScienceEpisodeResultReviewInspection {
  if (!input || !UUID_RE.test(String(input.projectId ?? "")) || !UUID_RE.test(String(input.episodeId ?? ""))
    || !LAB_ID_RE.test(String(input.labId ?? "")) || !SHA256_RE.test(String(input.expectedProjectionSha256 ?? ""))) {
    throw new Error("science-episode-result-review-inspect-input-invalid");
  }
  if (!catalog.labs.some((lab) => lab.id === input.labId)) throw new Error("science-episode-result-review-lab-invalid");
  const project = store.getProject(input.projectId);
  const episode = store.getResearchEpisodeForProject(input.projectId, input.episodeId);
  if (!project || !episode || episode.status !== "succeeded" || !episode.result
    || !episode.toolIntents.some((intent) => intent.labId === input.labId)) {
    throw new Error("science-episode-result-review-target-invalid");
  }
  const session = store.getLoopSessionForProject(input.projectId, episode.loopSessionId);
  if (!session) throw new Error("science-episode-result-review-loop-invalid");
  const projection = scienceLabDecisionProjectionsForProject(store, input.projectId, catalog, { applyReviewReceipts: false })
    .find((candidate) => candidate.labId === input.labId);
  if (!projection || projection.basis.episode?.id !== episode.id || projection.projectionSha256 !== input.expectedProjectionSha256
    || projection.freshness.status !== "current" || projection.state !== "review-needed") {
    throw new Error("science-episode-result-review-refresh-required");
  }
  const intent = scienceResearchIntentCatalog([input.labId]).intents[0];
  if (!intent) throw new Error("science-episode-result-review-intent-missing");
  const availableActions = intent.nextActions.flatMap((action) => {
    const resolved = resolvedAction(store, input.projectId, projection, action);
    return resolved ? [resolved] : [];
  });
  return {
    project,
    projectContentSha256: projection.basis.project.contentSha256,
    session,
    episode,
    labId: input.labId,
    basisSha256: projection.basis.basisSha256,
    projectionSha256: projection.projectionSha256,
    boundary: projection.boundary,
    availableActions,
    latestReceipt: store.getLatestEpisodeResultReviewReceipt(input.projectId, episode.id, input.labId),
  };
}

function canonicalRecordInput(input: RecordScienceEpisodeResultReviewInput): RecordScienceEpisodeResultReviewInput {
  if (!input || !UUID_RE.test(String(input.requestId ?? "")) || !UUID_RE.test(String(input.projectId ?? ""))
    || !UUID_RE.test(String(input.loopSessionId ?? "")) || !UUID_RE.test(String(input.episodeId ?? ""))
    || !LAB_ID_RE.test(String(input.labId ?? "")) || !["accepted", "rejected"].includes(input.verdict)
    || !Number.isSafeInteger(input.expectedProjectVersion) || input.expectedProjectVersion < 1
    || !Number.isSafeInteger(input.expectedLoopVersion) || input.expectedLoopVersion < 1
    || !Number.isSafeInteger(input.expectedEpisodeVersion) || input.expectedEpisodeVersion < 1
    || !Number.isSafeInteger(input.expectedReviewRevision) || input.expectedReviewRevision < 0
    || !SHA256_RE.test(String(input.expectedProjectContentSha256 ?? ""))
    || !SHA256_RE.test(String(input.expectedLoopStateSha256 ?? ""))
    || !SHA256_RE.test(String(input.expectedEpisodeStateSha256 ?? ""))
    || !SHA256_RE.test(String(input.expectedResultSha256 ?? ""))
    || !SHA256_RE.test(String(input.expectedBasisSha256 ?? ""))
    || !SHA256_RE.test(String(input.expectedProjectionSha256 ?? ""))
    || input.expectedReviewSha256 !== null && !SHA256_RE.test(String(input.expectedReviewSha256 ?? ""))
    || typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.trim().length > 20_000
    || typeof input.selectedNextTrigger !== "string" || !input.selectedNextTrigger.trim()) {
    throw new Error("science-episode-result-review-record-input-invalid");
  }
  return { ...input, rationale: input.rationale.trim(), selectedNextTrigger: input.selectedNextTrigger.trim() };
}

export function recordScienceEpisodeResultReview(
  store: ScienceStore,
  catalog: ScienceLabCapabilityCatalog,
  rawInput: RecordScienceEpisodeResultReviewInput,
  reviewerRef: string,
): RecordScienceEpisodeResultReviewResult {
  if (!/^account-sha256:[a-f0-9]{64}$/.test(reviewerRef)) throw new Error("science-episode-result-review-actor-required");
  const input = canonicalRecordInput(rawInput);
  const inputSha256 = scienceEpisodeResultReviewSha256({ schema: "agentlas.science.episode-result-review-request/v1", ...input });
  const replay = store.replayEpisodeResultReviewRecord(input.requestId, inputSha256);
  if (replay) return replay;
  let inspection: ScienceEpisodeResultReviewInspection;
  try {
    inspection = inspectScienceEpisodeResultReview(store, catalog, {
      projectId: input.projectId,
      labId: input.labId,
      episodeId: input.episodeId,
      expectedProjectionSha256: input.expectedProjectionSha256,
    });
  } catch (error) {
    return { outcome: "refresh-required", reason: error instanceof Error ? error.message : "science-episode-result-review-refresh-required", inspection: null, replayed: false };
  }
  const prior = inspection.latestReceipt;
  const exact = inspection.project.version === input.expectedProjectVersion
    && inspection.projectContentSha256 === input.expectedProjectContentSha256
    && inspection.basisSha256 === input.expectedBasisSha256
    && inspection.session.id === input.loopSessionId && inspection.session.version === input.expectedLoopVersion
    && inspection.session.stateSha256 === input.expectedLoopStateSha256
    && inspection.episode.version === input.expectedEpisodeVersion
    && inspection.episode.stateSha256 === input.expectedEpisodeStateSha256
    && inspection.episode.result?.resultSha256 === input.expectedResultSha256
    && scienceLabDecisionProjectSha256(inspection.project) === input.expectedProjectContentSha256
    && (prior?.revision ?? 0) === input.expectedReviewRevision
    && (prior?.reviewSha256 ?? null) === input.expectedReviewSha256;
  if (!exact) return { outcome: "refresh-required", reason: "science-episode-result-review-head-changed", inspection, replayed: false };
  const selectedNextAction = inspection.availableActions.find((action) => action.trigger === input.selectedNextTrigger) ?? null;
  if (!selectedNextAction) return { outcome: "refresh-required", reason: "science-episode-result-review-action-unavailable", inspection, replayed: false };
  const selectedNextActionSha256 = scienceEpisodeResultReviewActionSha256(selectedNextAction);
  const now = new Date().toISOString();
  const unsigned: Omit<ScienceEpisodeResultReviewReceipt, "reviewSha256"> = {
    schema: SCIENCE_EPISODE_RESULT_REVIEW_SCHEMA,
    id: randomUUID(),
    requestId: input.requestId,
    projectId: input.projectId,
    projectVersion: inspection.project.version,
    projectContentSha256: input.expectedProjectContentSha256,
    loopSessionId: inspection.session.id,
    loopVersion: inspection.session.version,
    loopStateSha256: inspection.session.stateSha256,
    episodeId: inspection.episode.id,
    episodeVersion: inspection.episode.version,
    episodeStateSha256: inspection.episode.stateSha256,
    resultSha256: inspection.episode.result!.resultSha256,
    labId: input.labId,
    basisSha256: inspection.basisSha256,
    projectionSha256: inspection.projectionSha256,
    artifacts: inspection.episode.result!.artifacts.flatMap((binding) => {
      const context = store.getArtifactContextForProject(input.projectId, binding.artifactId, binding.artifactVersion);
      return context?.linkage.labId === input.labId ? [binding] : [];
    }).sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.artifactVersion - right.artifactVersion),
    revision: (prior?.revision ?? 0) + 1,
    previousReviewSha256: prior?.reviewSha256 ?? null,
    verdict: input.verdict,
    rationale: input.rationale,
    selectedNextTrigger: selectedNextAction.trigger,
    selectedNextAction,
    selectedNextActionSha256,
    reviewerRef,
    createdAt: now,
  };
  const receipt: ScienceEpisodeResultReviewReceipt = {
    ...unsigned,
    reviewSha256: scienceEpisodeResultReviewReceiptSha256(unsigned),
  };
  return store.appendEpisodeResultReviewReceipt(receipt, inputSha256);
}
