export const ONE_DOMAIN_EVENT_CONTRACT_VERSION = "1.0.0" as const;

type Rule = Readonly<{
  taskScoped: boolean;
  required: readonly string[];
  optional: readonly string[];
}>;

export const ONE_DOMAIN_EVENT_RULES = {
  "one.profile.updated": { taskScoped: false, required: ["changedFields", "scope"], optional: [] },
  "briefing.detected": { taskScoped: false, required: ["category", "sourceRefs", "confidence", "expiry"], optional: [] },
  "briefing.published": { taskScoped: false, required: ["briefingId", "priority", "preparedActionRef"], optional: [] },
  "briefing.dismissed": { taskScoped: false, required: ["reasonCategory", "suppressionScope"], optional: [] },
  "briefing.expired": { taskScoped: false, required: ["expiryReason"], optional: [] },
  "onboarding.route_selected": { taskScoped: false, required: ["route", "platform", "locale"], optional: [] },
  "onboarding.step_resolved": { taskScoped: false, required: ["stepId", "resolution"], optional: ["errorCategory"] },
  "feature_intro.deferred": { taskScoped: false, required: ["introVersion", "blockingStateCategory"], optional: [] },
  "feature_intro.acknowledged": { taskScoped: false, required: ["introVersion", "resolution"], optional: ["acknowledgementRef"] },
  "task.created": { taskScoped: true, required: ["goalSummary", "origin"], optional: ["projectId"] },
  "task.state_changed": { taskScoped: true, required: ["from", "to", "reason"], optional: [] },
  "task.projection_opened": { taskScoped: true, required: ["surface", "projectionMode"], optional: [] },
  "task.synced": { taskScoped: true, required: ["sourceVersion", "targetVersion"], optional: [] },
  "message.added": { taskScoped: false, required: ["threadId", "messageRef"], optional: ["attachmentRefs"] },
  "team.proposed": { taskScoped: true, required: ["roleIds", "candidateReleaseRefs", "rationaleRefs"], optional: [] },
  "team.assigned": { taskScoped: true, required: ["roleToReleaseMap", "permissionScopes"], optional: [] },
  "run.started": { taskScoped: true, required: ["runId", "policyVersion"], optional: [] },
  "run.step_changed": { taskScoped: true, required: ["stepId", "status", "publicSafeSummary"], optional: [] },
  "run.failed": { taskScoped: true, required: ["stepId", "errorClass", "recoverability"], optional: [] },
  "approval.requested": { taskScoped: true, required: ["decisionId", "risk", "optionRefs"], optional: ["deadline"] },
  "approval.resolved": { taskScoped: true, required: ["decisionId", "selectedOption", "actor"], optional: [] },
  "approval.revoked": { taskScoped: true, required: ["decisionId", "reason"], optional: [] },
  "artifact.created": { taskScoped: true, required: ["artifactId", "type", "artifactVersion", "storageRef"], optional: [] },
  "artifact.verified": { taskScoped: true, required: ["artifactId", "checks", "status"], optional: [] },
  "result.manifest_ready": { taskScoped: true, required: ["manifestId", "contractVersion", "artifactRefs"], optional: [] },
  "receipt.recorded": { taskScoped: true, required: ["receiptId", "kind", "sourceOrRunRefs"], optional: [] },
  "outcome.verified": { taskScoped: true, required: ["outcomeId", "status", "evidenceRefs", "remainingWork"], optional: [] },
  "value_closure.ready": { taskScoped: true, required: ["valueClosureRef", "outcomeRefs", "artifactRefs"], optional: ["estimateRefs"] },
  "improvement.proof_ready": { taskScoped: true, required: ["improvementProofRef", "reusedAssetRefs", "baselineRefs", "evidenceType"], optional: [] },
  "memory.candidate_created": { taskScoped: true, required: ["candidateId", "normalizedPreview", "scope", "sourceRef"], optional: [] },
  "memory.resolved": { taskScoped: true, required: ["candidateId", "resolution"], optional: ["memoryId"] },
  "memory.updated": { taskScoped: false, required: ["memoryId", "changedFields"], optional: [] },
  "memory.deleted": { taskScoped: false, required: ["memoryId", "effectiveTime"], optional: [] },
  "ecosystem.suggestion_created": { taskScoped: true, required: ["suggestionId", "type", "evidenceRefs", "cooldown"], optional: [] },
  "suggestion.snoozed": { taskScoped: true, required: ["suggestionId", "resumeAfter"], optional: [] },
  "suggestion.dismissed": { taskScoped: true, required: ["suggestionId", "suppressionScope"], optional: [] },
  "agent.build_requested": { taskScoped: true, required: ["sourceTaskRefs", "agentDraftId"], optional: [] },
  "team.retention_requested": { taskScoped: true, required: ["assignmentRefs", "teamDraftId"], optional: [] },
  "automation.proposed": { taskScoped: true, required: ["triggerPreview", "approvalPolicy"], optional: [] },
  "automation.enabled": { taskScoped: true, required: ["automationId", "policy", "pauseControl"], optional: [] },
  "hub.derivative_requested": { taskScoped: true, required: ["privateSourceId", "publicDraftId"], optional: [] },
  "hub.release_published": { taskScoped: true, required: ["publicReleaseId", "allowlistManifestRef", "receiptId"], optional: [] },
  "host.connection_changed": { taskScoped: false, required: ["hostId", "state", "lastSeen"], optional: [] },
  "host.offline": { taskScoped: false, required: ["hostId", "lastSyncedVersion"], optional: [] },
  "sync.queued": { taskScoped: true, required: ["operationId", "targetEntity", "baseVersion"], optional: [] },
  "sync.resolved": { taskScoped: true, required: ["operationId", "result", "finalVersion"], optional: [] },
  "device.pairing_verified": { taskScoped: true, required: ["hostId", "deviceId", "verificationRefs", "pairingVerificationRef"], optional: [] },
  "accessibility.preference_updated": { taskScoped: false, required: ["changedFields", "scope"], optional: [] },
} as const satisfies Record<string, Rule>;

export type OneDomainEventType = keyof typeof ONE_DOMAIN_EVENT_RULES;
export type OneDomainEventActor = "user" | "one" | "agent" | "team" | "system";
export type OneDomainEventVisibility = "personal" | "project" | "team" | "public";
export type OneDomainEventScalar = string | number | boolean;

export interface OneDomainEventPayloadEntry {
  name: string;
  value: OneDomainEventScalar | OneDomainEventScalar[];
}

export interface OneDomainEventV1 {
  contractVersion: typeof ONE_DOMAIN_EVENT_CONTRACT_VERSION;
  eventId: string;
  eventType: OneDomainEventType;
  occurredAt: string;
  actor: OneDomainEventActor;
  entityId: string;
  projectId?: string;
  taskId?: string;
  version: number;
  visibility: OneDomainEventVisibility;
  payload: { entries: OneDomainEventPayloadEntry[] };
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const ENTRY_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const UNSAFE_TEXT_RE = /<|https?:\/\/|file:|javascript:|\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\|\\\\[^\\]+\\|(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|secret|password|token)\s*[:=]/i;

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function safeScalar(value: unknown): value is OneDomainEventScalar {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return typeof value === "string" && value.length > 0 && value.length <= 4_000 && !UNSAFE_TEXT_RE.test(value);
}

export function isOneDomainEventV1(value: unknown): value is OneDomainEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!exactKeys(event, [
    "contractVersion", "eventId", "eventType", "occurredAt", "actor", "entityId",
    "projectId", "taskId", "version", "visibility", "payload",
  ])) return false;
  if (event.contractVersion !== ONE_DOMAIN_EVENT_CONTRACT_VERSION || !safeId(event.eventId) || !safeId(event.entityId)) return false;
  if (typeof event.eventType !== "string" || !(event.eventType in ONE_DOMAIN_EVENT_RULES)) return false;
  if (typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt))) return false;
  if (!["user", "one", "agent", "team", "system"].includes(String(event.actor))) return false;
  if (!["personal", "project", "team", "public"].includes(String(event.visibility))) return false;
  if (!Number.isSafeInteger(event.version) || Number(event.version) < 1) return false;
  if (event.projectId !== undefined && !safeId(event.projectId)) return false;
  if (event.taskId !== undefined && !safeId(event.taskId)) return false;

  const rule = ONE_DOMAIN_EVENT_RULES[event.eventType as OneDomainEventType];
  if (rule.taskScoped && !safeId(event.taskId)) return false;
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return false;
  const payload = event.payload as Record<string, unknown>;
  if (!exactKeys(payload, ["entries"]) || !Array.isArray(payload.entries) || payload.entries.length < 1 || payload.entries.length > 32) return false;

  const names = new Set<string>();
  for (const item of payload.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    if (!exactKeys(entry, ["name", "value"]) || typeof entry.name !== "string" || !ENTRY_NAME_RE.test(entry.name) || names.has(entry.name)) return false;
    names.add(entry.name);
    if (Array.isArray(entry.value)) {
      if (entry.value.length > 64 || !entry.value.every(safeScalar)) return false;
    } else if (!safeScalar(entry.value)) return false;
  }
  const allowed = new Set<string>([...rule.required, ...rule.optional]);
  return rule.required.every((name) => names.has(name)) && [...names].every((name) => allowed.has(name));
}

export function parseOneDomainEventJson(raw: string): OneDomainEventV1 | null {
  const byteLength = typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(raw).byteLength
    : raw.length * 3;
  if (byteLength > 128 * 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isOneDomainEventV1(value) ? value : null;
  } catch {
    return null;
  }
}
