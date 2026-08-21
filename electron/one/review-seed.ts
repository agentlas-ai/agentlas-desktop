import { createHash } from "node:crypto";
import type { CanonicalTask, InstalledAgent, RunEventUi } from "../../shared/types";
import type {
  OneEcosystemSuggestion,
  OneObservedAgentBuildSignal,
  OneObservedRetainTeamSignal,
  OneSuggestionProposal,
  OneSuggestionReviewHandoffInput,
  OneSuggestionTaskEvidence,
} from "../../shared/one-suggestions";
import {
  ONE_REVIEW_SEED_CONTRACT_VERSION,
  isOneSuggestionReviewSeed,
  type OneBlockedReviewSeed,
  type OneReviewInstalledAgentRef,
  type OneSuggestionReviewSeed,
} from "../../shared/one-review-seed";
import { isSafeOneSuggestionId, isSafeOneSuggestionText } from "../../shared/one-suggestions";
import { listInstalledAgentsReadOnly } from "../mcp/registry";
import { getInvocationRunReceipt, listRunEvents } from "../store/run-events";
import { getCanonicalTask } from "../store/tasks";
import { getOneSuggestionReviewHandoff, getOneSuggestionState } from "./suggestions";

const MAX_RUN_EVENTS = 500;

interface ExactObservedRun {
  participantIds: string[];
  participantSlugs: string[];
  participantRefs: string[];
  roleRefs: string[];
  toolRefs: string[];
  taskKindRef: string;
  contributionReceiptRefs: string[];
}

class ReviewSeedBlocked extends Error {
  constructor(readonly reason: OneBlockedReviewSeed["reason"]) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isObservedAgentProposal(
  proposal: OneSuggestionProposal,
): proposal is OneObservedAgentBuildSignal & { type: "agent_build" } {
  return proposal.type === "agent_build"
    && "signalSource" in proposal
    && proposal.signalSource === "accepted_result_pattern";
}

function isObservedTeamProposal(
  proposal: OneSuggestionProposal,
): proposal is OneObservedRetainTeamSignal & { type: "retain_team" } {
  return proposal.type === "retain_team"
    && "signalSource" in proposal
    && proposal.signalSource === "accepted_result_pattern";
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && isSafeOneSuggestionId(value);
}

function eventPayload(event: RunEventUi): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function boundedLedgerText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length >= 1
    && value.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function stableRef(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}:${digest}`;
}

function isSuccessfulToolReceiptEvent(event: RunEventUi): boolean {
  const payload = eventPayload(event);
  return event.kind === "mcp_tool-use"
    && safeId(event.id)
    && boundedLedgerText(payload.toolName)
    && boundedLedgerText(payload.toolId)
    && payload.toolIsError === false;
}

function exactSourceLedger(evidence: OneSuggestionTaskEvidence): {
  task: CanonicalTask;
  events: RunEventUi[];
  start: RunEventUi;
} {
  const task = getCanonicalTask(evidence.taskId);
  if (
    !task
    || task.version !== evidence.taskVersion
    || task.status !== "completed"
    || !task.originChatId
    || task.updatedAt !== evidence.completedAt
  ) throw new ReviewSeedBlocked("source_evidence_changed");
  const receipt = getInvocationRunReceipt(evidence.runId);
  if (
    !receipt
    || receipt.status !== "completed"
    || receipt.chatId !== task.originChatId
    || receipt.eventCount > MAX_RUN_EVENTS
  ) throw new ReviewSeedBlocked("source_evidence_changed");
  const events = listRunEvents(receipt.runId, MAX_RUN_EVENTS);
  if (events.length !== receipt.eventCount) throw new ReviewSeedBlocked("source_evidence_changed");
  const start = events.find((event) => event.kind === "invoke_started");
  if (!start) throw new ReviewSeedBlocked("source_evidence_changed");
  return { task, events, start };
}

function exactObservedRun(evidence: OneSuggestionTaskEvidence): ExactObservedRun {
  const { task, events, start } = exactSourceLedger(evidence);
  if (!start || eventPayload(start).oneMode !== true) {
    throw new ReviewSeedBlocked("source_evidence_changed");
  }
  const participantIds = [...new Set(events
    .map((event) => event.agentId?.trim() ?? "")
    .filter(Boolean))].sort();
  if (participantIds.length === 0) throw new ReviewSeedBlocked("source_evidence_changed");
  const installedById = new Map(listInstalledAgentsReadOnly().map((agent) => [agent.id, agent] as const));
  const participantSlugs = participantIds.map((agentId) => {
    const installed = installedById.get(agentId);
    if (!installed || !safeId(installed.slug)) throw new ReviewSeedBlocked("installed_agent_unavailable");
    const taskParticipant = task.participants.find((item) => item.agentId === agentId);
    if (taskParticipant && taskParticipant.agentSlug !== installed.slug) {
      throw new ReviewSeedBlocked("source_evidence_changed");
    }
    return installed.slug;
  });
  const participantRefs = participantIds.map((agentId, index) => {
    const installed = installedById.get(agentId);
    if (
      !installed
      || installed.slug !== participantSlugs[index]
      || installed.kind === "team"
      || installed.visibility === "background"
      || installed.visibility === "private"
      || installed.sourceMissingSince
      || !Number.isFinite(Date.parse(installed.installedAt))
      || (installed.packageHash !== undefined && !/^[a-f0-9]{64}$/.test(installed.packageHash))
    ) throw new ReviewSeedBlocked("installed_agent_unavailable");
    return stableRef(
      "participant",
      evidence.hostId,
      installed.id,
      installed.slug,
      installed.installedAt,
      installed.packageHash ?? "unversioned",
    );
  });
  const roleRefs = [...new Set(participantIds.map((agentId) => {
    const observedRole = events.find((event) =>
      event.agentId === agentId && typeof eventPayload(event).role === "string");
    const canonicalRole = task.participants.find((item) => item.agentId === agentId)?.role ?? "unspecified";
    const role = typeof eventPayload(observedRole ?? start).role === "string"
      ? String(eventPayload(observedRole ?? start).role)
      : canonicalRole;
    return stableRef("role", evidence.hostId, agentId, role);
  }))].sort();
  const toolRefs = [...new Set(events.flatMap((event) => {
    if (!isSuccessfulToolReceiptEvent(event)) return [];
    return [stableRef("tool", evidence.hostId, String(eventPayload(event).toolName).trim())];
  }))].sort();
  const contributionReceiptRefs = participantIds.flatMap((participantId) => {
    const durableToolEvent = events.find((event) =>
      event.agentId === participantId && isSuccessfulToolReceiptEvent(event));
    return durableToolEvent ? [durableToolEvent.id] : [];
  });
  const startPayload = eventPayload(start);
  const taskKindRef = stableRef("task-kind", evidence.hostId, JSON.stringify({
    oneMode: true,
    planMode: startPayload.planMode === true,
    goalMode: startPayload.goalMode === true,
    appsGenerateMode: startPayload.appsGenerateMode === true,
    toolMode: typeof startPayload.toolMode === "string" ? startPayload.toolMode : "unset",
    hubMode: typeof startPayload.hubMode === "string" ? startPayload.hubMode : "unset",
    toolRefs,
  }));
  return {
    participantIds,
    participantSlugs,
    participantRefs,
    roleRefs,
    toolRefs,
    taskKindRef,
    contributionReceiptRefs,
  };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function safeDisplay(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "").normalize("NFC").trim();
  return isSafeOneSuggestionText(normalized) ? normalized : fallback;
}

function agentRef(agent: InstalledAgent): OneReviewInstalledAgentRef {
  if (
    agent.visibility === "background"
    || agent.visibility === "private"
    || agent.sourceMissingSince
    || !safeId(agent.id)
    || !safeId(agent.slug)
  ) throw new ReviewSeedBlocked("installed_agent_unavailable");
  const fallbackName = safeId(agent.slug) ? agent.slug : "Installed agent";
  const name = safeDisplay(agent.localDisplayName || agent.name, fallbackName);
  const nameEn = safeDisplay(agent.nameEn, name);
  const tagline = safeDisplay(agent.tagline, "Installed agent");
  const taglineEn = safeDisplay(agent.taglineEn, tagline);
  const ref: OneReviewInstalledAgentRef = {
    agentId: agent.id,
    slug: agent.slug,
    installedAt: agent.installedAt,
    packageHash: agent.packageHash ?? null,
    name,
    nameEn,
    tagline,
    taglineEn,
    trustGrade: agent.trustGrade,
  };
  return ref;
}

function exactSuggestion(input: OneSuggestionReviewHandoffInput): OneEcosystemSuggestion {
  const state = getOneSuggestionState();
  const suggestion = state.suggestions.find((item) => item.id === input.suggestionId);
  if (
    !suggestion
    || suggestion.version !== input.expectedSuggestionVersion
    || suggestion.reviewRequestId !== input.reviewRequestId
    || suggestion.originTaskId !== input.originTaskId
    || suggestion.status !== "accepted_for_review"
  ) throw new Error("One review seed no longer matches its canonical suggestion");
  return suggestion;
}

function observedRuns(suggestion: OneEcosystemSuggestion): ExactObservedRun[] {
  try {
    return suggestion.evidence.map(exactObservedRun);
  } catch (error) {
    if (error instanceof ReviewSeedBlocked) throw error;
    throw new ReviewSeedBlocked("source_evidence_changed");
  }
}

function candidateRefs(runs: ExactObservedRun[]): OneReviewInstalledAgentRef[] {
  const first = runs[0];
  if (!first || runs.some((run) =>
    !sameList(run.participantIds, first.participantIds)
    || !sameList(run.participantSlugs, first.participantSlugs))) {
    throw new ReviewSeedBlocked("source_evidence_changed");
  }
  const installedById = new Map(listInstalledAgentsReadOnly().map((agent) => [agent.id, agent] as const));
  return first.participantIds.map((agentId, index) => {
    const agent = installedById.get(agentId);
    if (!agent || agent.slug !== first.participantSlugs[index]) {
      throw new ReviewSeedBlocked("installed_agent_unavailable");
    }
    return agentRef(agent);
  });
}

function blockedSeed(
  base: Omit<OneBlockedReviewSeed, "kind" | "materialization" | "reason">,
  reason: OneBlockedReviewSeed["reason"],
): OneBlockedReviewSeed {
  return { ...base, kind: "blocked", materialization: "blocked", reason };
}

export function getOneSuggestionReviewSeed(input: OneSuggestionReviewHandoffInput): OneSuggestionReviewSeed {
  const handoff = getOneSuggestionReviewHandoff(input);
  const suggestion = exactSuggestion(input);
  const acceptedResultCount = suggestion.evidence.filter((item) => item.outcome === "accepted_internal_result").length;
  const base = {
    contractVersion: ONE_REVIEW_SEED_CONTRACT_VERSION,
    suggestionId: handoff.suggestionId,
    suggestionVersion: handoff.suggestionVersion,
    reviewRequestId: handoff.reviewRequestId,
    draftId: handoff.draftId,
    originTaskId: handoff.originTaskId,
    reviewOnly: true as const,
    actionState: "not_started" as const,
    sourceTaskCount: handoff.sourceTaskCount,
    acceptedResultCount,
    targetSurface: handoff.targetSurface,
  };

  let seed: OneSuggestionReviewSeed;
  try {
    if (suggestion.proposal.type === "plugin_build") {
      const proposal = suggestion.proposal;
      if (!("signalSource" in proposal) || proposal.signalSource !== "accepted_result_pattern") {
        seed = blockedSeed(base, "proposal_not_materializable");
      } else {
        const runs = observedRuns(suggestion);
        const first = runs[0];
        if (
          !first
          || runs.some((run) =>
            run.taskKindRef !== proposal.taskKindRef
            || !sameList(run.toolRefs, proposal.toolRefs))
          || proposal.acceptedResultCount !== suggestion.evidence.length
          || proposal.observationRefs.length !== suggestion.evidence.length
        ) throw new ReviewSeedBlocked("source_evidence_changed");
        seed = {
          ...base,
          kind: "plugin_build",
          materialization: "plugin_builder",
          targetSurface: "plugin",
          signal: proposal,
          taskKindRef: proposal.taskKindRef,
          observedToolCount: proposal.toolRefs.length,
        };
      }
    } else if (suggestion.proposal.type === "agent_build") {
      if (!isObservedAgentProposal(suggestion.proposal)) {
        seed = blockedSeed(base, "proposal_not_materializable");
      } else {
        const proposal = suggestion.proposal;
        const runs = observedRuns(suggestion);
        const first = runs[0];
        if (
          !first
          || runs.some((run) =>
            run.participantIds.length !== 1
            || run.roleRefs[0] !== proposal.roleRef
            || run.taskKindRef !== proposal.taskKindRef
            || !sameList(run.toolRefs, proposal.toolRefs))
        ) throw new ReviewSeedBlocked("source_evidence_changed");
        if (runs.some((run) => run.participantRefs[0] !== proposal.participantRef)) {
          throw new ReviewSeedBlocked("installed_agent_unavailable");
        }
        const candidates = candidateRefs(runs);
        seed = {
          ...base,
          kind: "agent_build",
          materialization: "editor_prefill",
          targetSurface: "build",
          buildMode: "single",
          candidate: candidates[0],
          observedToolCount: first.toolRefs.length,
        };
      }
    } else if (suggestion.proposal.type === "retain_team") {
      if (!isObservedTeamProposal(suggestion.proposal)) {
        seed = blockedSeed(base, "proposal_not_materializable");
      } else {
        const proposal = suggestion.proposal;
        const runs = observedRuns(suggestion);
        const first = runs[0];
        const expectedContributions = [...new Set(runs.flatMap((run) => run.contributionReceiptRefs))].sort();
        const proposalContributions = [...proposal.contributionReceiptRefs].sort();
        if (
          !first
          || first.participantIds.length < 2
          || runs.some((run) =>
            !sameList(run.roleRefs, proposal.roleRefs)
            || !sameList(run.toolRefs, proposal.toolRefs)
            || run.contributionReceiptRefs.length !== run.participantIds.length)
          || !sameList(expectedContributions, proposalContributions)
        ) throw new ReviewSeedBlocked("source_evidence_changed");
        if (runs.some((run) => !sameList(run.participantRefs, proposal.participantRefs))) {
          throw new ReviewSeedBlocked("installed_agent_unavailable");
        }
        seed = {
          ...base,
          kind: "retain_team",
          materialization: "editor_prefill",
          targetSurface: "work",
          candidates: candidateRefs(runs),
        };
      }
    } else if (suggestion.proposal.type === "automation") {
      suggestion.evidence.forEach(exactSourceLedger);
      seed = {
        ...base,
        kind: "automation",
        materialization: "editor_prefill",
        targetSurface: "automation",
        name: "One suggested automation",
        triggerPreview: suggestion.proposal.preview.trigger,
        permission: suggestion.proposal.preview.permission,
        approvalPolicy: suggestion.proposal.preview.approvalPolicy,
        stopControl: suggestion.proposal.preview.stopControl,
        executableScheduleIncluded: false,
      };
    } else if (suggestion.proposal.type === "hub_derivative") {
      suggestion.evidence.forEach(exactSourceLedger);
      seed = {
        ...base,
        kind: "hub_derivative",
        materialization: "scope_review",
        targetSurface: "work",
        excludedPrivateCategories: [...suggestion.proposal.excludedPrivateCategories],
        publishingStarted: false,
      };
    } else {
      seed = blockedSeed(base, "unsupported_review_surface");
    }
  } catch (error) {
    if (!(error instanceof ReviewSeedBlocked)) throw error;
    seed = blockedSeed(base, error.reason);
  }
  if (!isOneSuggestionReviewSeed(seed)) {
    throw new Error("One review seed violated its closed safe contract");
  }
  return seed;
}
