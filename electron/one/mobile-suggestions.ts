import { createHash } from "node:crypto";

import {
  isSafeOneSuggestionText,
  type OneEcosystemSuggestion,
} from "../../shared/one-suggestions";
import { ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED } from "../../shared/one-hub-derivative";
import {
  ONE_MOBILE_SUGGESTION_CONTRACT_VERSION,
  isOneMobileEcosystemSuggestionV1,
  isOneMobileSuggestionActionAcknowledgement,
  type OneMobileEcosystemSuggestionV1,
  type OneMobileSuggestionActionAcknowledgement,
  type OneMobileSuggestionActionInput,
  type OneMobileSuggestionMemberRef,
  type OneMobileSuggestionScope,
} from "../../shared/one-mobile-suggestion";
import { isOneValueClosureState, type OneValueClosureRecord } from "../../shared/one-value-closure";
import { listInstalledAgentsReadOnly } from "../mcp/registry";
import { getCanonicalTask } from "../store/tasks";
import {
  acceptOneSuggestionForReviewFromUser,
  dismissOneSuggestion,
  getOneSuggestionReviewHandoff,
  getOneSuggestionState,
  neverAskOneSuggestion,
  snoozeOneSuggestion,
} from "./suggestions";
import { getOneValueClosureState } from "./value-closure";
import { oneText } from "./one-copy";

const HOST_REF_RE = /^host_[a-f0-9]{32}$/;
const SUGGESTION_REF_RE = /^one_suggestion_[a-f0-9]{32}$/;
const CLOSURE_REF_RE = /^value_closure_[a-f0-9]{32}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

function stableRef(prefix: "member" | "role", ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("|"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function safeDisplay(value: string | null | undefined, fallback: string): string {
  const normalized = String(value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  return isSafeOneSuggestionText(normalized) ? normalized : fallback;
}

function copy(type: OneEcosystemSuggestion["type"]): OneMobileEcosystemSuggestionV1["copy"] {
  if (type === "plugin_build") {
    return {
      titleKo: "반복 절차를 플러그인으로 만들까요?",
      titleEn: "Turn this repeated procedure into a plugin?",
      bodyKo: "같은 도구 순서를 세 번 이상 반복한 기록을 바탕으로 검토용 로컬 플러그인을 준비합니다.",
      bodyEn: "Prepare a review-only local plugin from a repeated tool sequence observed at least three times.",
      reviewOnly: true,
      executionStarted: false,
    };
  }
  if (type === "agent_build") {
    return {
      titleKo: oneText("ko", "one.mob.agentBuildTitle"),
      titleEn: oneText("en", "one.mob.agentBuildTitle"),
      bodyKo: oneText("ko", "one.mob.agentBuildBody"),
      bodyEn: oneText("en", "one.mob.agentBuildBody"),
      reviewOnly: true,
      executionStarted: false,
    };
  }
  if (type === "retain_team") {
    return {
      titleKo: oneText("ko", "one.mob.retainTeamTitle"),
      titleEn: oneText("en", "one.mob.retainTeamTitle"),
      bodyKo: oneText("ko", "one.mob.retainTeamBody"),
      bodyEn: oneText("en", "one.mob.retainTeamBody"),
      reviewOnly: true,
      executionStarted: false,
    };
  }
  if (type === "automation") {
    return {
      titleKo: oneText("ko", "one.mob.automationTitle"),
      titleEn: oneText("en", "one.mob.automationTitle"),
      bodyKo: oneText("ko", "one.mob.automationBody"),
      bodyEn: oneText("en", "one.mob.automationBody"),
      reviewOnly: true,
      executionStarted: false,
    };
  }
  return {
    titleKo: oneText("ko", "one.mob.hubDerivativeTitle"),
    titleEn: oneText("en", "one.mob.hubDerivativeTitle"),
    bodyKo: oneText("ko", "one.mob.hubDerivativeBody"),
    bodyEn: oneText("en", "one.mob.hubDerivativeBody"),
    reviewOnly: true,
    executionStarted: false,
  };
}

function teamMembers(suggestion: OneEcosystemSuggestion): OneMobileSuggestionMemberRef[] {
  const task = getCanonicalTask(suggestion.originTaskId);
  const installed = new Map(listInstalledAgentsReadOnly().map((agent) => [agent.id, agent] as const));
  const proposal = suggestion.proposal.type === "retain_team" ? suggestion.proposal : null;
  const expectedCount = proposal
    ? ("signalSource" in proposal ? proposal.participantRefs.length : proposal.assignmentRefs.length)
    : 2;
  const participants = [...(task?.participants ?? [])].slice(0, 16);
  const count = Math.max(2, Math.min(16, Math.max(expectedCount, participants.length)));
  return Array.from({ length: count }, (_, index): OneMobileSuggestionMemberRef => {
    const participant = participants[index];
    const agent = participant?.agentId ? installed.get(participant.agentId) : undefined;
    const sourceStatus: OneMobileSuggestionMemberRef["sourceStatus"] = agent
      ? "installed"
      : participant?.agentId
        ? "unavailable"
        : "external";
    const memberKey = sourceStatus === "external"
      ? "one.mob.memberExternal"
      : sourceStatus === "unavailable"
        ? "one.mob.memberUnavailable"
        : "one.mob.memberInstalled";
    const fallbackKo = oneText("ko", memberKey);
    const fallbackEn = oneText("en", memberKey);
    const identity = participant?.agentId ?? participant?.agentSlug ?? `slot-${index + 1}`;
    const roleIdentity = participant?.role ?? `role-${index + 1}`;
    return {
      memberRef: stableRef("member", suggestion.id, identity, String(index)),
      roleRef: stableRef("role", suggestion.id, roleIdentity, String(index)),
      displayNameKo: safeDisplay(agent?.localDisplayName || agent?.name, fallbackKo),
      displayNameEn: safeDisplay(agent?.nameEn || agent?.localDisplayName || agent?.name, fallbackEn),
      sourceStatus,
    };
  });
}

function proposalScope(suggestion: OneEcosystemSuggestion): OneMobileSuggestionScope {
  const proposal = suggestion.proposal;
  if (proposal.type === "plugin_build") {
    return {
      type: "plugin_build",
      reviewMode: "plugin_builder",
      observedToolCount: "signalSource" in proposal ? proposal.toolRefs.length : 0,
      sourceTaskCount: suggestion.evidence.length,
      saved: false,
    };
  }
  if (proposal.type === "agent_build") {
    const observedToolCount = "signalSource" in proposal ? proposal.toolRefs.length : 0;
    return {
      type: "agent_build",
      reviewMode: "definition_draft",
      participantCount: Math.max(1, Math.min(16, getCanonicalTask(suggestion.originTaskId)?.participants.length ?? 1)),
      observedToolCount,
      sourceTaskCount: suggestion.evidence.length,
      saved: false,
    };
  }
  if (proposal.type === "retain_team") {
    return {
      type: "retain_team",
      reviewMode: "team_draft",
      members: teamMembers(suggestion),
      sourceTaskCount: suggestion.evidence.length,
      temporaryUseAvailable: true,
      saved: false,
    };
  }
  if (proposal.type === "automation") {
    return {
      type: "automation",
      reviewMode: "automation_proposal",
      trigger: proposal.preview.trigger,
      nextRunAt: proposal.preview.nextRunAt,
      permission: proposal.preview.permission,
      stopControl: proposal.preview.stopControl,
      approvalPolicy: proposal.preview.approvalPolicy,
      scheduled: false,
      enabled: false,
    };
  }
  return {
    type: "hub_derivative",
    reviewMode: "public_derivative_scope",
    includedCategories: ["generated_review_scaffold"],
    alwaysExcludedCategories: [...ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED],
    gates: {
      entitlement: "unknown",
      rights: "unknown",
      economy: "unknown",
      fee: "unknown",
    },
    privateSourceIncluded: false,
    publishingStarted: false,
    publishAllowed: false,
    revenueGuaranteed: false,
  };
}

function exactClosure(
  suggestion: OneEcosystemSuggestion,
  closures: readonly OneValueClosureRecord[],
): OneValueClosureRecord | null {
  const origin = suggestion.evidence.find((item) => item.taskId === suggestion.originTaskId);
  if (!origin) return null;
  const matches = closures.filter((record) =>
    record.closure.taskId === suggestion.originTaskId
    && record.taskVersion === origin.taskVersion
    && record.closure.status === "ready");
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

/** Main-owned selection. Mobile receives zero or one closed projection. */
export function projectOneMobileEcosystemSuggestions(
  authoritativeHostRef: string,
  now = new Date(),
): OneMobileEcosystemSuggestionV1[] {
  if (!HOST_REF_RE.test(authoritativeHostRef) || !Number.isFinite(now.getTime())) return [];
  try {
    const state = getOneSuggestionState();
    const closureState = getOneValueClosureState();
    if (!isOneValueClosureState(closureState)) return [];
    const candidates = state.suggestions
      .filter((suggestion) => {
        const visible = suggestion.status === "open"
          || (suggestion.status === "snoozed"
            && suggestion.resumeAfter !== null
            && Date.parse(suggestion.resumeAfter) <= now.getTime());
        if (!visible) return false;
        if (!suggestion.evidence.every((item) => item.hostId === authoritativeHostRef)) return false;
        const origin = suggestion.evidence.find((item) => item.taskId === suggestion.originTaskId);
        const task = getCanonicalTask(suggestion.originTaskId);
        return Boolean(
          origin
          && task
          && task.status === "completed"
          && task.archivedAt === null
          && task.version === origin.taskVersion
          && exactClosure(suggestion, closureState.closures),
        );
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const suggestion = candidates[0];
    if (!suggestion) return [];
    const origin = suggestion.evidence.find((item) => item.taskId === suggestion.originTaskId);
    const closure = exactClosure(suggestion, closureState.closures);
    if (!origin || !closure) return [];
    const acceptedInternalResultCount = suggestion.evidence.filter(
      (item) => item.outcome === "accepted_internal_result",
    ).length;
    const row: OneMobileEcosystemSuggestionV1 = {
      contractVersion: ONE_MOBILE_SUGGESTION_CONTRACT_VERSION,
      authoritativeHostRef,
      storeVersion: state.version,
      suggestionId: suggestion.id,
      suggestionVersion: suggestion.version,
      type: suggestion.type,
      status: suggestion.status as "open" | "snoozed",
      originTask: {
        taskId: suggestion.originTaskId,
        taskVersion: origin.taskVersion,
        status: "completed",
        valueClosureId: closure.closure.valueClosureId,
        valueClosureVersion: closure.version,
      },
      copy: copy(suggestion.type),
      evidence: {
        count: suggestion.evidence.length,
        basis: acceptedInternalResultCount === suggestion.evidence.length
          ? "accepted_internal_results"
          : "verified_outcomes",
        acceptedInternalResultCount,
        verifiedOutcomeCount: suggestion.evidence.length - acceptedInternalResultCount,
      },
      scope: proposalScope(suggestion),
      createdAt: suggestion.createdAt,
      updatedAt: suggestion.updatedAt,
    };
    return isOneMobileEcosystemSuggestionV1(row) ? [row] : [];
  } catch {
    return [];
  }
}

function assertPositiveVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError(`${label} must be a positive version`);
}

function assertActionInput(value: unknown): asserts value is OneMobileSuggestionActionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid One Mobile suggestion action");
  const input = value as Record<string, unknown>;
  const expected = new Set([
    "schemaVersion", "action", "expectedStoreVersion", "suggestionId", "expectedSuggestionVersion",
    "originTaskId", "expectedTaskVersion", "valueClosureId", "expectedValueClosureVersion",
    "confirmedByUser", "reviewOnly",
  ]);
  if (Object.keys(input).length !== expected.size || Object.keys(input).some((key) => !expected.has(key))) {
    throw new TypeError("One Mobile suggestion action contains unsupported fields");
  }
  if (input.schemaVersion !== 1
    || !["review", "snooze", "dismiss", "never_ask_again"].includes(String(input.action))
    || typeof input.suggestionId !== "string" || !SUGGESTION_REF_RE.test(input.suggestionId)
    || typeof input.originTaskId !== "string" || !ID_RE.test(input.originTaskId)
    || typeof input.valueClosureId !== "string" || !CLOSURE_REF_RE.test(input.valueClosureId)
    || input.confirmedByUser !== true
    || input.reviewOnly !== true) throw new TypeError("Invalid One Mobile suggestion action fields");
  assertPositiveVersion(input.expectedStoreVersion, "expectedStoreVersion");
  assertPositiveVersion(input.expectedSuggestionVersion, "expectedSuggestionVersion");
  assertPositiveVersion(input.expectedTaskVersion, "expectedTaskVersion");
  assertPositiveVersion(input.expectedValueClosureVersion, "expectedValueClosureVersion");
}

function exactActionBinding(input: OneMobileSuggestionActionInput, authoritativeHostRef: string): OneEcosystemSuggestion {
  if (!HOST_REF_RE.test(authoritativeHostRef)) throw new Error("Invalid authenticated Desktop host");
  const state = getOneSuggestionState();
  if (state.version !== input.expectedStoreVersion) throw new Error("One suggestion state changed; refresh and retry");
  const suggestion = state.suggestions.find((item) => item.id === input.suggestionId);
  if (!suggestion
    || suggestion.version !== input.expectedSuggestionVersion
    || suggestion.originTaskId !== input.originTaskId
    || !(suggestion.status === "open"
      || (suggestion.status === "snoozed" && suggestion.resumeAfter !== null && Date.parse(suggestion.resumeAfter) <= Date.now()))) {
    throw new Error("One suggestion changed; refresh and retry");
  }
  const origin = suggestion.evidence.find((item) => item.taskId === input.originTaskId);
  const task = getCanonicalTask(input.originTaskId);
  if (!origin
    || origin.taskVersion !== input.expectedTaskVersion
    || origin.hostId !== authoritativeHostRef
    || !suggestion.evidence.every((item) => item.hostId === authoritativeHostRef)
    || !task
    || task.status !== "completed"
    || task.archivedAt !== null
    || task.version !== input.expectedTaskVersion) {
    throw new Error("The originating Task changed; refresh and retry");
  }
  const closureState = getOneValueClosureState();
  if (!isOneValueClosureState(closureState)) throw new Error("Value Closure state is unavailable");
  const closure = exactClosure(suggestion, closureState.closures);
  if (!closure
    || closure.closure.valueClosureId !== input.valueClosureId
    || closure.version !== input.expectedValueClosureVersion) {
    throw new Error("The exact Value Closure changed; refresh and retry");
  }
  return suggestion;
}

/** Review/dismiss mutations remain Desktop Main CAS operations. */
export function performOneMobileSuggestionAction(
  rawInput: unknown,
  authoritativeHostRef: string,
): OneMobileSuggestionActionAcknowledgement {
  assertActionInput(rawInput);
  const input = rawInput;
  const suggestion = exactActionBinding(input, authoritativeHostRef);
  let storeVersion: number;
  let currentSuggestionVersion: number;
  let status: OneMobileSuggestionActionAcknowledgement["status"];
  let reviewRequestId: string | null = null;
  let targetSurface: OneMobileSuggestionActionAcknowledgement["targetSurface"] = null;

  if (input.action === "review") {
    const result = acceptOneSuggestionForReviewFromUser({
      expectedStoreVersion: input.expectedStoreVersion,
      suggestionId: input.suggestionId,
      expectedSuggestionVersion: input.expectedSuggestionVersion,
      confirmedByUser: true,
      reviewOnly: true,
      ...(suggestion.type === "hub_derivative" ? { publicDerivativeReview: true as const } : {}),
    });
    storeVersion = result.storeVersion;
    currentSuggestionVersion = result.storeVersion;
    status = "accepted_for_review";
    reviewRequestId = result.value.id;
    const handoff = getOneSuggestionReviewHandoff({
      suggestionId: input.suggestionId,
      expectedSuggestionVersion: result.storeVersion,
      reviewRequestId: result.value.id,
      draftId: result.value.draftId,
      originTaskId: input.originTaskId,
    });
    targetSurface = handoff.targetSurface;
  } else if (input.action === "snooze") {
    const result = snoozeOneSuggestion({
      expectedStoreVersion: input.expectedStoreVersion,
      suggestionId: input.suggestionId,
      expectedSuggestionVersion: input.expectedSuggestionVersion,
      confirmedByUser: true,
    });
    storeVersion = result.storeVersion;
    currentSuggestionVersion = result.value.version;
    status = result.value.status as "snoozed";
  } else if (input.action === "dismiss") {
    const result = dismissOneSuggestion({
      expectedStoreVersion: input.expectedStoreVersion,
      suggestionId: input.suggestionId,
      expectedSuggestionVersion: input.expectedSuggestionVersion,
      confirmedByUser: true,
    });
    storeVersion = result.storeVersion;
    currentSuggestionVersion = result.value.version;
    status = result.value.status as "dismissed";
  } else {
    const result = neverAskOneSuggestion({
      expectedStoreVersion: input.expectedStoreVersion,
      suggestionId: input.suggestionId,
      expectedSuggestionVersion: input.expectedSuggestionVersion,
      confirmedByUser: true,
    });
    storeVersion = result.storeVersion;
    currentSuggestionVersion = result.value.version;
    status = result.value.status as "never_ask_again";
  }

  const acknowledgement: OneMobileSuggestionActionAcknowledgement = {
    contractVersion: ONE_MOBILE_SUGGESTION_CONTRACT_VERSION,
    action: input.action,
    suggestionId: suggestion.id,
    previousSuggestionVersion: input.expectedSuggestionVersion,
    currentSuggestionVersion,
    storeVersion,
    originTaskId: input.originTaskId,
    taskVersion: input.expectedTaskVersion,
    status,
    reviewOnly: true,
    executionStarted: false,
    reviewRequestId,
    targetSurface,
  };
  if (!isOneMobileSuggestionActionAcknowledgement(acknowledgement)) {
    throw new Error("Refused invalid One Mobile suggestion acknowledgement");
  }
  return acknowledgement;
}
