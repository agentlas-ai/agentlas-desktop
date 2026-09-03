import { createHash } from "node:crypto";
import type {
  ScienceAnalysisSpec,
  ScienceEpisodeResultReviewSelectedAction,
  ScienceProject,
  ScienceResearchEpisode,
  ScienceResearchEpisodeArtifactBinding,
} from "./science-contract";
import {
  scienceResearchIntentCatalog,
  type ScienceLabResearchIntent,
  type ScienceResearchDestinationKind,
  type ScienceResearchNextAction,
} from "./science-research-intent";

export const SCIENCE_LAB_DECISION_PROJECTION_SCHEMA = "agentlas.science.lab-decision-projection/v1" as const;

export const SCIENCE_LAB_DECISION_PROJECTION_STATES = [
  "input-needed",
  "human-decision-needed",
  "ready",
  "review-needed",
] as const;
export type ScienceLabDecisionProjectionState = typeof SCIENCE_LAB_DECISION_PROJECTION_STATES[number];

export const SCIENCE_LAB_DECISION_PROJECTION_FRESHNESS = ["current", "stale", "superseded"] as const;
export type ScienceLabDecisionProjectionFreshness = typeof SCIENCE_LAB_DECISION_PROJECTION_FRESHNESS[number];

export const SCIENCE_LAB_DECISION_ACTION_KINDS = [
  "open-required-input",
  "answer-human-decision",
  "inspect-approved-plan",
  "review-result",
  "follow-intent-next-action",
  "refresh-stale-projection",
  "open-superseding-context",
] as const;
export type ScienceLabDecisionActionKind = typeof SCIENCE_LAB_DECISION_ACTION_KINDS[number];

export type ScienceLabDecisionProjectionStaleReason =
  | "project-version-changed"
  | "episode-version-changed"
  | "episode-state-changed"
  | "episode-plan-changed"
  | "episode-result-changed"
  | "analysis-plan-version-changed"
  | "analysis-plan-content-changed"
  | "analysis-plan-status-changed"
  | "artifact-version-changed"
  | "artifact-content-changed"
  | "artifact-missing";

export const SCIENCE_LAB_DECISION_STALE_CONDITIONS: readonly ScienceLabDecisionProjectionStaleReason[] = Object.freeze([
  "project-version-changed",
  "episode-version-changed",
  "episode-state-changed",
  "episode-plan-changed",
  "episode-result-changed",
  "analysis-plan-version-changed",
  "analysis-plan-content-changed",
  "analysis-plan-status-changed",
  "artifact-version-changed",
  "artifact-content-changed",
  "artifact-missing",
]);

export const SCIENCE_LAB_DECISION_SUPERSEDED_CONDITIONS = Object.freeze([
  "newer-project-bound-episode-for-lab",
] as const);

export interface ScienceLabDecisionProjectBinding {
  id: string;
  version: number;
  contentSha256: string;
}

export interface ScienceLabDecisionEpisodeBinding {
  id: string;
  version: number;
  stateSha256: string;
  planSha256: string;
  resultSha256: string | null;
  status: ScienceResearchEpisode["status"];
}

export interface ScienceLabDecisionPlanBinding {
  planKind: "episode-plan" | "analysis-spec";
  id: string;
  version: number;
  contentSha256: string;
  status: "bound" | ScienceAnalysisSpec["status"];
}

export interface ScienceLabDecisionArtifactBinding {
  artifactId: string;
  artifactVersion: number;
  contentSha256: string;
}

export interface ScienceLabDecisionBlockingDecisionBinding {
  id: string;
  contentSha256: string;
  status: "queued" | "presented" | "deferred";
}

export interface ScienceLabDecisionBlockingDecisionSource extends ScienceLabDecisionBlockingDecisionBinding {
  projectId: string;
  question: string;
}

export type ScienceLabDecisionBasisRef =
  | ({ kind: "project" } & ScienceLabDecisionProjectBinding)
  | ({ kind: "episode" } & ScienceLabDecisionEpisodeBinding)
  | ({ kind: "analysis-plan" } & ScienceLabDecisionPlanBinding)
  | ({ kind: "artifact" } & ScienceLabDecisionArtifactBinding)
  | ({ kind: "human-decision" } & ScienceLabDecisionBlockingDecisionBinding);

export interface ScienceLabDecisionMustSee {
  requirement: string;
  basisRefs: ScienceLabDecisionBasisRef[];
}

export interface ScienceLabDecisionAction {
  kind: ScienceLabDecisionActionKind;
  trigger: string;
  action: string;
  reason: string;
  destination: {
    kind: ScienceResearchDestinationKind;
    id: string | null;
    exactVersion: number | null;
    exactContentSha256: string | null;
  };
  requiresHumanDecision: boolean;
  enabled: boolean;
  basisSha256: string;
}

export interface ScienceLabDecisionProjectionBasis {
  project: ScienceLabDecisionProjectBinding;
  episode: ScienceLabDecisionEpisodeBinding | null;
  plan: ScienceLabDecisionPlanBinding | null;
  artifacts: ScienceLabDecisionArtifactBinding[];
  blockingDecision: ScienceLabDecisionBlockingDecisionBinding | null;
  basisSha256: string;
}

export interface ScienceLabDecisionProjection {
  schema: typeof SCIENCE_LAB_DECISION_PROJECTION_SCHEMA;
  labId: string;
  researchIntent: {
    neededWhen: string;
    notWhen: string;
    userGoal: string;
    clarifyingQuestions: ScienceLabResearchIntent["clarifyingQuestions"];
    manuscript: ScienceLabResearchIntent["manuscript"];
  };
  currentDecision: string;
  mustSee: ScienceLabDecisionMustSee[];
  boundary: string;
  state: ScienceLabDecisionProjectionState;
  basis: ScienceLabDecisionProjectionBasis;
  freshness: {
    status: ScienceLabDecisionProjectionFreshness;
    reasons: ScienceLabDecisionProjectionStaleReason[];
    staleWhen: readonly ScienceLabDecisionProjectionStaleReason[];
    supersededWhen: typeof SCIENCE_LAB_DECISION_SUPERSEDED_CONDITIONS;
    supersededBy: ScienceLabDecisionEpisodeBinding | null;
  };
  action: ScienceLabDecisionAction;
  projectionSha256: string;
}

export interface CreateScienceLabDecisionProjectionInput {
  project: ScienceProject;
  labId: string;
  episode: ScienceResearchEpisode | null;
  analysisPlan: ScienceAnalysisSpec | null;
  artifacts?: ScienceLabDecisionArtifactBinding[];
  currentArtifacts: ScienceLabDecisionArtifactBinding[];
  blockingDecision: ScienceLabDecisionBlockingDecisionSource | null;
  matchedTrigger: string | null;
  matchedAction?: ScienceEpisodeResultReviewSelectedAction | null;
  supersededByEpisode?: ScienceResearchEpisode | null;
}

export interface ScienceLabDecisionCurrentBasis {
  project: ScienceLabDecisionProjectBinding;
  episode: ScienceLabDecisionEpisodeBinding | null;
  plan: ScienceLabDecisionPlanBinding | null;
  artifacts: ScienceLabDecisionArtifactBinding[];
}

export interface ScienceLabDecisionFreshnessAssessment {
  status: ScienceLabDecisionProjectionFreshness;
  reasons: ScienceLabDecisionProjectionStaleReason[];
  supersededBy: ScienceLabDecisionEpisodeBinding | null;
}

type JsonRecord = Record<string, unknown>;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return Object.is(value, -0) ? 0 : value;
  return Object.fromEntries(Object.keys(value as JsonRecord).sort().flatMap((key) => {
    const child = (value as JsonRecord)[key];
    return child === undefined ? [] : [[key, canonicalValue(child)]];
  }));
}

export function scienceLabDecisionProjectionSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

export function scienceLabDecisionProjectSha256(project: ScienceProject): string {
  return scienceLabDecisionProjectionSha256({
    id: project.id,
    title: project.title,
    question: project.question,
    domain: project.domain,
    relatedDomains: [...project.relatedDomains],
    status: project.status,
    version: project.version,
  });
}

function assertId(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(code);
}

function assertSha256(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) throw new Error(code);
}

function artifactKey(binding: ScienceLabDecisionArtifactBinding): string {
  return `${binding.artifactId}:v${binding.artifactVersion}`;
}

function normalizeArtifacts(bindings: ScienceLabDecisionArtifactBinding[], code: string): ScienceLabDecisionArtifactBinding[] {
  if (!Array.isArray(bindings) || bindings.length > 200) throw new Error(code);
  const normalized = bindings.map((binding) => {
    if (!binding || typeof binding !== "object") throw new Error(code);
    assertId(binding.artifactId, code);
    if (!Number.isSafeInteger(binding.artifactVersion) || binding.artifactVersion < 1) throw new Error(code);
    assertSha256(binding.contentSha256, code);
    return { artifactId: binding.artifactId, artifactVersion: binding.artifactVersion, contentSha256: binding.contentSha256 };
  }).sort((left, right) => artifactKey(left).localeCompare(artifactKey(right)));
  if (new Set(normalized.map(artifactKey)).size !== normalized.length) throw new Error(code);
  return normalized;
}

function projectBinding(project: ScienceProject): ScienceLabDecisionProjectBinding {
  assertId(project.id, "science-lab-decision-project-invalid");
  if (!Number.isSafeInteger(project.version) || project.version < 1) throw new Error("science-lab-decision-project-invalid");
  return { id: project.id, version: project.version, contentSha256: scienceLabDecisionProjectSha256(project) };
}

function episodeBinding(episode: ScienceResearchEpisode): ScienceLabDecisionEpisodeBinding {
  assertId(episode.id, "science-lab-decision-episode-invalid");
  if (!Number.isSafeInteger(episode.version) || episode.version < 1) throw new Error("science-lab-decision-episode-invalid");
  assertSha256(episode.stateSha256, "science-lab-decision-episode-invalid");
  assertSha256(episode.planSha256, "science-lab-decision-episode-invalid");
  if (episode.result) assertSha256(episode.result.resultSha256, "science-lab-decision-episode-invalid");
  return {
    id: episode.id,
    version: episode.version,
    stateSha256: episode.stateSha256,
    planSha256: episode.planSha256,
    resultSha256: episode.result?.resultSha256 ?? null,
    status: episode.status,
  };
}

function planBinding(episode: ScienceResearchEpisode | null, analysisPlan: ScienceAnalysisSpec | null): ScienceLabDecisionPlanBinding | null {
  if (analysisPlan) {
    assertId(analysisPlan.id, "science-lab-decision-plan-invalid");
    if (!Number.isSafeInteger(analysisPlan.currentVersion) || analysisPlan.currentVersion < 1) throw new Error("science-lab-decision-plan-invalid");
    assertSha256(analysisPlan.currentDocumentSha256, "science-lab-decision-plan-invalid");
    return {
      planKind: "analysis-spec",
      id: analysisPlan.id,
      version: analysisPlan.currentVersion,
      contentSha256: analysisPlan.currentDocumentSha256,
      status: analysisPlan.status,
    };
  }
  if (!episode) return null;
  return {
    planKind: "episode-plan",
    id: episode.id,
    version: episode.version,
    contentSha256: episode.planSha256,
    status: "bound",
  };
}

function blockingDecisionBinding(decision: ScienceLabDecisionBlockingDecisionSource | null): ScienceLabDecisionBlockingDecisionBinding | null {
  if (!decision) return null;
  if (!["queued", "presented", "deferred"].includes(decision.status)) throw new Error("science-lab-decision-blocking-decision-invalid");
  assertId(decision.id, "science-lab-decision-blocking-decision-invalid");
  assertSha256(decision.contentSha256, "science-lab-decision-blocking-decision-invalid");
  if (!decision.question.trim()) throw new Error("science-lab-decision-blocking-decision-invalid");
  return { id: decision.id, contentSha256: decision.contentSha256, status: decision.status };
}

function exactEpisodeArtifacts(
  episode: ScienceResearchEpisode | null,
  selected: ScienceLabDecisionArtifactBinding[] | undefined,
): ScienceLabDecisionArtifactBinding[] {
  const all = normalizeArtifacts(episode?.result?.artifacts ?? [], "science-lab-decision-artifact-invalid");
  if (selected === undefined) return all;
  const normalized = normalizeArtifacts(selected, "science-lab-decision-artifact-invalid");
  const allByKey = new Map(all.map((binding) => [artifactKey(binding), binding]));
  if (normalized.some((binding) => allByKey.get(artifactKey(binding))?.contentSha256 !== binding.contentSha256)) {
    throw new Error("science-lab-decision-artifact-episode-mismatch");
  }
  return normalized;
}

function staleReasons(
  basisArtifacts: ScienceLabDecisionArtifactBinding[],
  currentArtifacts: ScienceLabDecisionArtifactBinding[],
): ScienceLabDecisionProjectionStaleReason[] {
  const currentById = new Map(currentArtifacts.map((binding) => [binding.artifactId, binding]));
  const reasons = new Set<ScienceLabDecisionProjectionStaleReason>();
  for (const basis of basisArtifacts) {
    const current = currentById.get(basis.artifactId);
    if (!current) reasons.add("artifact-missing");
    else {
      if (current.artifactVersion !== basis.artifactVersion) reasons.add("artifact-version-changed");
      if (current.contentSha256 !== basis.contentSha256) reasons.add("artifact-content-changed");
    }
  }
  return SCIENCE_LAB_DECISION_STALE_CONDITIONS.filter((reason) => reasons.has(reason));
}

export function assessScienceLabDecisionProjectionFreshness(
  projection: ScienceLabDecisionProjection,
  current: ScienceLabDecisionCurrentBasis,
  supersededBy: ScienceLabDecisionEpisodeBinding | null = null,
): ScienceLabDecisionFreshnessAssessment {
  assertScienceLabDecisionProjection(projection);
  const reasons = new Set<ScienceLabDecisionProjectionStaleReason>();
  if (current.project.id !== projection.basis.project.id
    || current.project.version !== projection.basis.project.version
    || current.project.contentSha256 !== projection.basis.project.contentSha256) reasons.add("project-version-changed");
  if (projection.basis.episode) {
    if (!current.episode || current.episode.id !== projection.basis.episode.id
      || current.episode.version !== projection.basis.episode.version) reasons.add("episode-version-changed");
    if (!current.episode || current.episode.stateSha256 !== projection.basis.episode.stateSha256) reasons.add("episode-state-changed");
    if (!current.episode || current.episode.planSha256 !== projection.basis.episode.planSha256) reasons.add("episode-plan-changed");
    if (!current.episode || current.episode.resultSha256 !== projection.basis.episode.resultSha256) reasons.add("episode-result-changed");
  } else if (current.episode) reasons.add("episode-version-changed");
  if (projection.basis.plan) {
    if (!current.plan || current.plan.id !== projection.basis.plan.id
      || current.plan.version !== projection.basis.plan.version) reasons.add("analysis-plan-version-changed");
    if (!current.plan || current.plan.contentSha256 !== projection.basis.plan.contentSha256) reasons.add("analysis-plan-content-changed");
    if (!current.plan || current.plan.status !== projection.basis.plan.status || current.plan.planKind !== projection.basis.plan.planKind) reasons.add("analysis-plan-status-changed");
  } else if (current.plan) reasons.add("analysis-plan-version-changed");
  for (const reason of staleReasons(projection.basis.artifacts, normalizeArtifacts(current.artifacts, "science-lab-decision-current-artifact-invalid"))) reasons.add(reason);
  return {
    status: supersededBy ? "superseded" : reasons.size ? "stale" : "current",
    reasons: SCIENCE_LAB_DECISION_STALE_CONDITIONS.filter((reason) => reasons.has(reason)),
    supersededBy,
  };
}

function stateFor(
  episode: ScienceResearchEpisode | null,
  plan: ScienceLabDecisionPlanBinding | null,
  decision: ScienceLabDecisionBlockingDecisionBinding | null,
): ScienceLabDecisionProjectionState {
  if (decision || episode?.status === "waiting-for-decision") return "human-decision-needed";
  if (!plan || episode?.status === "failed" || episode?.status === "cancelled") return "input-needed";
  if (episode?.status === "succeeded") return "review-needed";
  return "ready";
}

function basisRefs(basis: Omit<ScienceLabDecisionProjectionBasis, "basisSha256">): ScienceLabDecisionBasisRef[] {
  const refs: ScienceLabDecisionBasisRef[] = [{ kind: "project", ...basis.project }];
  if (basis.episode) refs.push({ kind: "episode", ...basis.episode });
  if (basis.plan) refs.push({ kind: "analysis-plan", ...basis.plan });
  refs.push(...basis.artifacts.map((artifact) => ({ kind: "artifact" as const, ...artifact })));
  if (basis.blockingDecision) refs.push({ kind: "human-decision", ...basis.blockingDecision });
  return refs;
}

function destinationForIntentAction(
  intentAction: ScienceResearchNextAction,
  labId: string,
  basis: ScienceLabDecisionProjectionBasis,
): ScienceLabDecisionAction["destination"] | null {
  if (intentAction.destinationKind === "artifact") {
    const artifact = intentAction.destinationId === null
      ? basis.artifacts.length === 1 ? basis.artifacts[0] : null
      : basis.artifacts.find((candidate) => candidate.artifactId === intentAction.destinationId) ?? null;
    return artifact ? { kind: "artifact", id: artifact.artifactId, exactVersion: artifact.artifactVersion, exactContentSha256: artifact.contentSha256 } : null;
  }
  if (intentAction.destinationKind === "analysis-plan") {
    return basis.plan?.planKind === "analysis-spec" && (intentAction.destinationId === null || intentAction.destinationId === basis.plan.id)
      ? { kind: "analysis-plan", id: basis.plan.id, exactVersion: basis.plan.version, exactContentSha256: basis.plan.contentSha256 } : null;
  }
  if (intentAction.destinationKind === "human-decision") {
    return basis.blockingDecision && (intentAction.destinationId === null || intentAction.destinationId === basis.blockingDecision.id)
      ? { kind: "human-decision", id: basis.blockingDecision.id, exactVersion: null, exactContentSha256: basis.blockingDecision.contentSha256 } : null;
  }
  if (intentAction.destinationKind === "lab") {
    return { kind: "lab", id: intentAction.destinationId ?? labId, exactVersion: null, exactContentSha256: null };
  }
  return intentAction.destinationId === null
    ? null
    : { kind: "manuscript", id: intentAction.destinationId, exactVersion: null, exactContentSha256: null };
}

function actionFor(input: {
  intent: ScienceLabResearchIntent;
  state: ScienceLabDecisionProjectionState;
  basis: ScienceLabDecisionProjectionBasis;
  freshness: ScienceLabDecisionProjectionFreshness;
  supersededBy: ScienceLabDecisionEpisodeBinding | null;
  matchedTrigger: string | null;
  matchedAction?: ScienceEpisodeResultReviewSelectedAction | null;
}): ScienceLabDecisionAction {
  const { intent, state, basis, freshness, supersededBy } = input;
  let action: Omit<ScienceLabDecisionAction, "basisSha256">;
  if (freshness === "superseded") {
    action = {
      kind: "open-superseding-context",
      trigger: "projection-superseded",
      action: "open-superseding-episode",
      reason: "A newer project-bound episode for this Lab replaced the episode used by this projection.",
      destination: { kind: "analysis-plan", id: supersededBy?.id ?? null, exactVersion: supersededBy?.version ?? null, exactContentSha256: supersededBy?.planSha256 ?? null },
      requiresHumanDecision: false,
      enabled: supersededBy !== null,
    };
  } else if (freshness === "stale") {
    action = {
      kind: "refresh-stale-projection",
      trigger: "projection-stale",
      action: "refresh-project-bound-lab-projection",
      reason: "One or more exact artifact bindings changed after this projection was created.",
      destination: { kind: "lab", id: intent.labId, exactVersion: null, exactContentSha256: null },
      requiresHumanDecision: false,
      enabled: true,
    };
  } else if (state === "human-decision-needed") {
    action = {
      kind: "answer-human-decision",
      trigger: "blocking-decision-open",
      action: "open-blocking-decision",
      reason: "The Lab cannot advance until the exact project decision is answered by a human.",
      destination: { kind: "human-decision", id: basis.blockingDecision?.id ?? null, exactVersion: null, exactContentSha256: basis.blockingDecision?.contentSha256 ?? null },
      requiresHumanDecision: true,
      enabled: basis.blockingDecision !== null,
    };
  } else if (state === "input-needed") {
    action = {
      kind: "open-required-input",
      trigger: "required-input-missing",
      action: "open-lab-input-context",
      reason: intent.requiredInputs[0],
      destination: { kind: "lab", id: intent.labId, exactVersion: null, exactContentSha256: null },
      requiresHumanDecision: false,
      enabled: true,
    };
  } else if (state === "ready") {
    action = {
      kind: "inspect-approved-plan",
      trigger: "project-bound-plan-ready",
      action: "open-exact-approved-plan",
      reason: "The exact project and plan bindings are current and ready for the next governed Lab operation.",
      destination: basis.plan
        ? { kind: "analysis-plan", id: basis.plan.id, exactVersion: basis.plan.version, exactContentSha256: basis.plan.contentSha256 }
        : { kind: "lab", id: intent.labId, exactVersion: null, exactContentSha256: null },
      requiresHumanDecision: false,
      enabled: basis.plan !== null,
    };
  } else {
    const intentAction = input.matchedTrigger === null
      ? null
      : input.matchedAction ?? intent.nextActions.find((candidate) => candidate.trigger === input.matchedTrigger) ?? null;
    const intentDestination = intentAction ? destinationForIntentAction(intentAction, intent.labId, basis) : null;
    if (intentAction && intentDestination) {
      action = {
        kind: "follow-intent-next-action",
        trigger: intentAction.trigger,
        action: intentAction.action,
        reason: intentAction.reason,
        destination: intentDestination,
        requiresHumanDecision: intentAction.requiresHumanDecision,
        enabled: true,
      };
    } else {
      const artifact = basis.artifacts[0];
      action = {
        kind: "review-result",
        trigger: "episode-result-review-needed",
        action: "open-exact-result-for-review",
        reason: "The project-bound episode result must be reviewed before a downstream intent trigger is accepted.",
        destination: artifact
          ? { kind: "artifact", id: artifact.artifactId, exactVersion: artifact.artifactVersion, exactContentSha256: artifact.contentSha256 }
          : { kind: "lab", id: intent.labId, exactVersion: null, exactContentSha256: null },
        requiresHumanDecision: true,
        enabled: true,
      };
    }
  }
  return { ...action, basisSha256: basis.basisSha256 };
}

function currentDecisionFor(input: CreateScienceLabDecisionProjectionInput, intent: ScienceLabResearchIntent): string {
  const decisionQuestion = input.blockingDecision?.question;
  if (typeof decisionQuestion === "string" && decisionQuestion.trim()) return decisionQuestion.trim();
  if (input.episode?.objective.trim()) return input.episode.objective.trim();
  if (input.project.question.trim()) return input.project.question.trim();
  return intent.liveDecision;
}

export function createScienceLabDecisionProjection(input: CreateScienceLabDecisionProjectionInput): ScienceLabDecisionProjection {
  if (!input || typeof input !== "object") throw new Error("science-lab-decision-projection-input-invalid");
  assertId(input.labId, "science-lab-decision-lab-invalid");
  const intent = scienceResearchIntentCatalog([input.labId]).intents[0];
  if (!intent) throw new Error("science-lab-decision-lab-invalid");
  if (input.episode && input.episode.projectId !== input.project.id) throw new Error("science-lab-decision-episode-project-mismatch");
  if (input.analysisPlan && input.analysisPlan.projectId !== input.project.id) throw new Error("science-lab-decision-plan-project-mismatch");
  if (input.blockingDecision && input.blockingDecision.projectId !== input.project.id) throw new Error("science-lab-decision-decision-project-mismatch");
  if (input.episode && !input.episode.toolIntents.some((toolIntent) => toolIntent.labId === input.labId)) throw new Error("science-lab-decision-episode-lab-mismatch");
  if (input.episode?.status === "waiting-for-decision" && !input.blockingDecision) throw new Error("science-lab-decision-blocking-decision-required");
  if (input.matchedTrigger !== null && !intent.nextActions.some((action) => action.trigger === input.matchedTrigger)) throw new Error("science-lab-decision-trigger-invalid");
  if (input.matchedTrigger !== null && (!input.episode?.result || input.episode.status !== "succeeded")) throw new Error("science-lab-decision-trigger-result-required");
  if (input.matchedAction) {
    const catalogAction = intent.nextActions.find((action) => action.trigger === input.matchedAction?.trigger);
    if (!catalogAction || input.matchedTrigger !== input.matchedAction.trigger
      || catalogAction.action !== input.matchedAction.action || catalogAction.reason !== input.matchedAction.reason
      || catalogAction.destinationKind !== input.matchedAction.destinationKind
      || catalogAction.requiresHumanDecision !== input.matchedAction.requiresHumanDecision
      || catalogAction.destinationId !== null && catalogAction.destinationId !== input.matchedAction.destinationId) {
      throw new Error("science-lab-decision-matched-action-invalid");
    }
  }

  const project = projectBinding(input.project);
  const episode = input.episode ? episodeBinding(input.episode) : null;
  const plan = planBinding(input.episode, input.analysisPlan);
  const artifacts = exactEpisodeArtifacts(input.episode, input.artifacts);
  const currentArtifacts = normalizeArtifacts(input.currentArtifacts, "science-lab-decision-current-artifact-invalid");
  const blockingDecision = blockingDecisionBinding(input.blockingDecision);
  const basisWithoutHash = { project, episode, plan, artifacts, blockingDecision };
  const basis: ScienceLabDecisionProjectionBasis = {
    ...basisWithoutHash,
    basisSha256: scienceLabDecisionProjectionSha256(basisWithoutHash),
  };
  const supersededBy = input.supersededByEpisode ? episodeBinding(input.supersededByEpisode) : null;
  if (input.supersededByEpisode && (input.supersededByEpisode.projectId !== input.project.id
    || !input.supersededByEpisode.toolIntents.some((toolIntent) => toolIntent.labId === input.labId)
    || input.episode === null || input.supersededByEpisode.ordinal <= input.episode.ordinal)) {
    throw new Error("science-lab-decision-superseding-episode-invalid");
  }
  const reasons = staleReasons(artifacts, currentArtifacts);
  const freshness: ScienceLabDecisionProjectionFreshness = supersededBy ? "superseded" : reasons.length ? "stale" : "current";
  const state = stateFor(input.episode, plan, blockingDecision);
  const refs = basisRefs(basisWithoutHash);
  const mustSee = intent.rendering.mustShow.slice(0, 3).map((requirement, index) => ({
    requirement,
    basisRefs: index === 0 && artifacts.length
      ? artifacts.map((artifact) => ({ kind: "artifact" as const, ...artifact }))
      : index === 1 && episode
        ? [{ kind: "episode" as const, ...episode }]
        : index === 2 && plan
          ? [{ kind: "analysis-plan" as const, ...plan }]
          : refs.slice(0, 1),
  }));
  const core = {
    schema: SCIENCE_LAB_DECISION_PROJECTION_SCHEMA,
    labId: input.labId,
    researchIntent: {
      neededWhen: intent.neededWhen,
      notWhen: intent.notWhen,
      userGoal: intent.userGoal,
      clarifyingQuestions: intent.clarifyingQuestions.map((question) => ({ ...question })),
      manuscript: { roles: [...intent.manuscript.roles], requirements: [...intent.manuscript.requirements] },
    },
    currentDecision: currentDecisionFor(input, intent),
    mustSee,
    boundary: intent.rendering.claimBoundaries[0],
    state,
    basis,
    freshness: {
      status: freshness,
      reasons,
      staleWhen: SCIENCE_LAB_DECISION_STALE_CONDITIONS,
      supersededWhen: SCIENCE_LAB_DECISION_SUPERSEDED_CONDITIONS,
      supersededBy,
    },
    action: actionFor({ intent, state, basis, freshness, supersededBy, matchedTrigger: input.matchedTrigger, matchedAction: input.matchedAction }),
  };
  const projection = { ...core, projectionSha256: scienceLabDecisionProjectionSha256(core) };
  assertScienceLabDecisionProjection(projection);
  return projection;
}

export function assertScienceLabDecisionProjection(value: ScienceLabDecisionProjection): void {
  if (!value || value.schema !== SCIENCE_LAB_DECISION_PROJECTION_SCHEMA) throw new Error("science-lab-decision-projection-invalid");
  if (!SCIENCE_LAB_DECISION_PROJECTION_STATES.includes(value.state) || !SCIENCE_LAB_DECISION_PROJECTION_FRESHNESS.includes(value.freshness.status)) throw new Error("science-lab-decision-projection-invalid");
  if (!SCIENCE_LAB_DECISION_ACTION_KINDS.includes(value.action.kind)) throw new Error("science-lab-decision-projection-invalid");
  assertSha256(value.basis.project.contentSha256, "science-lab-decision-projection-invalid");
  assertSha256(value.basis.basisSha256, "science-lab-decision-projection-invalid");
  const { basisSha256, ...basisCore } = value.basis;
  if (scienceLabDecisionProjectionSha256(basisCore) !== basisSha256) throw new Error("science-lab-decision-basis-integrity-failed");
  if (!value.researchIntent?.neededWhen.trim() || !value.researchIntent.notWhen.trim() || !value.researchIntent.userGoal.trim()
    || value.researchIntent.clarifyingQuestions.length < 1 || value.researchIntent.clarifyingQuestions.length > 10
    || value.researchIntent.manuscript.roles.length < 1 || value.researchIntent.manuscript.requirements.length < 1
    || !value.currentDecision.trim() || !value.boundary.trim() || value.action.basisSha256 !== value.basis.basisSha256
    || value.mustSee.length < 1 || value.mustSee.length > 3 || value.mustSee.some((item) => !item.requirement.trim() || item.basisRefs.length < 1)) {
    throw new Error("science-lab-decision-projection-invalid");
  }
  const { projectionSha256, ...core } = value;
  assertSha256(projectionSha256, "science-lab-decision-projection-invalid");
  if (scienceLabDecisionProjectionSha256(core) !== projectionSha256) throw new Error("science-lab-decision-projection-integrity-failed");
}

export function scienceLabDecisionArtifactBindingsFromCurrent(
  artifacts: Array<{ id: string; currentVersion: number; version: { contentSha256: string } }>,
): ScienceLabDecisionArtifactBinding[] {
  return normalizeArtifacts(artifacts.map((artifact) => ({
    artifactId: artifact.id,
    artifactVersion: artifact.currentVersion,
    contentSha256: artifact.version.contentSha256,
  })), "science-lab-decision-current-artifact-invalid");
}

export function scienceLabDecisionEpisodeArtifactBindings(
  artifacts: ScienceResearchEpisodeArtifactBinding[],
): ScienceLabDecisionArtifactBinding[] {
  return normalizeArtifacts(artifacts.map((artifact) => ({ ...artifact })), "science-lab-decision-artifact-invalid");
}
