export const ONE_BRIEFING_CONTRACT_VERSION = "1.0.0" as const;
export const ONE_BRIEFING_ACTION_PACKET_CONTRACT_VERSION = "1.0.0" as const;

export type OneBriefingKind =
  | "risk"
  | "opportunity"
  | "anomaly"
  | "repetition"
  | "decision"
  | "completion";

export type OneBriefingCadence = "important_only" | "daily" | "weekdays" | "weekly";
export type OneBriefingChannel = "in_app" | "desktop_notification" | "mobile_push";
export type OneBriefingConfidence = "high" | "medium" | "low";
export type OneBriefingFreshness = "fresh" | "aging" | "stale";
export type OneBriefingFeedback = "later" | "not_important" | "wrong";
export type OneBriefingReasonCode =
  | "project_folder_missing"
  | "project_folder_unreadable"
  | "project_folder_not_directory"
  | "project_deadline_conflict"
  | "automation_error"
  | "automation_blocked"
  | "automation_needs_input"
  | "automation_partial"
  | "task_waiting_decision_stale"
  | "task_running_without_active_run"
  | "task_failed_repeated"
  | "task_failed_abandoned"
  | "task_partial_abandoned";

export interface OneBriefingEvidence {
  label: string;
  value: string;
  observedAt: string;
  freshness: OneBriefingFreshness;
}

export interface OneBriefingPreparedAction {
  kind: "open_project" | "open_automation" | "open_task";
  targetId: string;
  label: string;
  /** A prepared action is navigation only until the user explicitly continues. */
  executionStarted: false;
}

export interface OneProactiveBriefing {
  contractVersion: typeof ONE_BRIEFING_CONTRACT_VERSION;
  candidateId: string;
  dedupeKey: string;
  kind: OneBriefingKind;
  reasonCode: OneBriefingReasonCode;
  severity: 1 | 2 | 3 | 4;
  source: OneBriefingSource;
  detectedAt: string;
  expiresAt: string;
  confidence: {
    level: OneBriefingConfidence;
    basis: string;
  };
  discovery: string;
  impact: string;
  prepared: string;
  decision: {
    prompt: string;
    acceptLabel: string;
    dismissLabel: string;
  };
  evidence: OneBriefingEvidence[];
  preparedAction: OneBriefingPreparedAction;
}

export type OneBriefingSource =
  | {
    kind: "project_folder" | "automation_run";
    refId: string;
    label: string;
  }
  | {
    kind: "canonical_task";
    refId: string;
    label: string;
    taskVersion: number;
    taskStatus: "waiting-decision" | "running" | "failed" | "partial";
    originChatId: string;
    runReceiptRef: string | null;
    runReceiptStatus: "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted" | null;
    activeRunPresent: boolean;
  };

export interface OpenOneBriefingTaskInput {
  candidateId: string;
  expectedDetectedAt: string;
  expectedTaskId: string;
  expectedTaskVersion: number;
}

export interface OpenOneBriefingTaskResult {
  taskId: string;
  taskVersion: number;
}

export interface OneBriefingPreferences {
  cadence: OneBriefingCadence;
  channels: OneBriefingChannel[];
  quietHours: {
    enabled: boolean;
    startHour: number;
    endHour: number;
  };
  updatedAt: string;
}

export interface OneBriefingSnapshot {
  contractVersion: typeof ONE_BRIEFING_CONTRACT_VERSION;
  evaluatedAt: string;
  candidate: OneProactiveBriefing | null;
  preferences: OneBriefingPreferences;
}

export type OneBriefingActionPacketStatus =
  | "prepared"
  | "task_reserved"
  | "task_ready"
  | "start_reserved"
  | "started"
  | "start_failed"
  | "recovery_required";

export type OneBriefingActionFailureCategory =
  | "candidate_changed"
  | "source_mismatch"
  | "suppressed_or_resolved"
  | "expired"
  | "task_creation_failed"
  | "start_rejected"
  | "recovery_required";

/**
 * Closed, renderer-safe review receipt. It intentionally carries no local
 * path, automation prompt/error/transcript, secret, or executable prompt.
 */
export interface OneBriefingActionPacket {
  contractVersion: typeof ONE_BRIEFING_ACTION_PACKET_CONTRACT_VERSION;
  packetId: string;
  version: number;
  candidateId: string;
  expectedDetectedAt: string;
  source: {
    kind: "project_folder" | "automation_run";
    refId: string;
    receiptRef: string;
  };
  evidenceDigest: string;
  evidenceRefs: string[];
  expiresAt: string;
  permission: "read";
  executionStarted: boolean;
  status: OneBriefingActionPacketStatus;
  task: {
    chatId: string;
    taskId: string;
    taskVersion: number;
    projectId: string | null;
  } | null;
  run: {
    runId: string;
    startedAt: string;
  } | null;
  failure: {
    category: OneBriefingActionFailureCategory;
    occurredAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrepareOneBriefingActionInput {
  candidateId: string;
  expectedDetectedAt: string;
}

export interface StartOneBriefingActionInput {
  packetId: string;
  expectedPacketVersion: number;
  candidateId: string;
  expectedDetectedAt: string;
  confirmedByUser: true;
}

/** Main-only capability. Renderer IPC always strips this field. */
export interface OneBriefingActionRef {
  contractVersion: typeof ONE_BRIEFING_ACTION_PACKET_CONTRACT_VERSION;
  packetId: string;
  reservedRunId: string;
  expectedTaskId: string;
  expectedTaskVersion: number;
}

export interface OneBriefingActionStartResult {
  ok: boolean;
  packet: OneBriefingActionPacket;
  runId: string | null;
  errorCategory: OneBriefingActionFailureCategory | null;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function safeText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
}

function safeIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isOneProactiveBriefing(value: unknown): value is OneProactiveBriefing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, [
    "contractVersion", "candidateId", "dedupeKey", "kind", "reasonCode", "severity", "source",
    "detectedAt", "expiresAt", "confidence", "discovery", "impact", "prepared",
    "decision", "evidence", "preparedAction",
  ])) return false;
  if (item.contractVersion !== ONE_BRIEFING_CONTRACT_VERSION) return false;
  if (typeof item.candidateId !== "string" || !ID_RE.test(item.candidateId)) return false;
  if (typeof item.dedupeKey !== "string" || !ID_RE.test(item.dedupeKey)) return false;
  if (!["risk", "opportunity", "anomaly", "repetition", "decision", "completion"].includes(String(item.kind))) return false;
  if (![
    "project_folder_missing", "project_folder_unreadable", "project_folder_not_directory",
    "project_deadline_conflict",
    "automation_error", "automation_blocked", "automation_needs_input", "automation_partial",
    "task_waiting_decision_stale", "task_running_without_active_run", "task_failed_repeated",
    "task_failed_abandoned", "task_partial_abandoned",
  ].includes(String(item.reasonCode))) return false;
  if (![1, 2, 3, 4].includes(Number(item.severity))) return false;
  if (!safeIso(item.detectedAt) || !safeIso(item.expiresAt) || Date.parse(item.expiresAt) <= Date.parse(item.detectedAt)) return false;
  if (!safeText(item.discovery, 600) || !safeText(item.impact, 600) || !safeText(item.prepared, 600)) return false;

  const source = item.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.kind === "canonical_task") {
    if (!exactKeys(sourceRecord, [
      "kind", "refId", "label", "taskVersion", "taskStatus", "originChatId",
      "runReceiptRef", "runReceiptStatus", "activeRunPresent",
    ])) return false;
    if (typeof sourceRecord.refId !== "string" || !ID_RE.test(sourceRecord.refId) || !safeText(sourceRecord.label, 160)) return false;
    if (!Number.isSafeInteger(sourceRecord.taskVersion) || Number(sourceRecord.taskVersion) < 1) return false;
    if (!["waiting-decision", "running", "failed", "partial"].includes(String(sourceRecord.taskStatus))) return false;
    if (typeof sourceRecord.originChatId !== "string" || !ID_RE.test(sourceRecord.originChatId)) return false;
    if (sourceRecord.runReceiptRef !== null && (typeof sourceRecord.runReceiptRef !== "string" || !ID_RE.test(sourceRecord.runReceiptRef))) return false;
    if (sourceRecord.runReceiptStatus !== null && !["running", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(String(sourceRecord.runReceiptStatus))) return false;
    if (typeof sourceRecord.activeRunPresent !== "boolean") return false;
  } else {
    if (!exactKeys(sourceRecord, ["kind", "refId", "label"])) return false;
    if (!["project_folder", "automation_run"].includes(String(sourceRecord.kind))) return false;
    if (typeof sourceRecord.refId !== "string" || !ID_RE.test(sourceRecord.refId) || !safeText(sourceRecord.label, 160)) return false;
  }

  const confidence = item.confidence;
  if (!confidence || typeof confidence !== "object" || Array.isArray(confidence)) return false;
  const confidenceRecord = confidence as Record<string, unknown>;
  if (!exactKeys(confidenceRecord, ["level", "basis"])) return false;
  if (!["high", "medium", "low"].includes(String(confidenceRecord.level)) || !safeText(confidenceRecord.basis, 320)) return false;

  const decision = item.decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return false;
  const decisionRecord = decision as Record<string, unknown>;
  if (!exactKeys(decisionRecord, ["prompt", "acceptLabel", "dismissLabel"])) return false;
  if (!safeText(decisionRecord.prompt, 320) || !safeText(decisionRecord.acceptLabel, 96) || !safeText(decisionRecord.dismissLabel, 96)) return false;

  if (!Array.isArray(item.evidence) || item.evidence.length < 1 || item.evidence.length > 8) return false;
  for (const evidence of item.evidence) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
    const record = evidence as Record<string, unknown>;
    if (!exactKeys(record, ["label", "value", "observedAt", "freshness"])) return false;
    if (!safeText(record.label, 96) || !safeText(record.value, 240) || !safeIso(record.observedAt)) return false;
    if (!["fresh", "aging", "stale"].includes(String(record.freshness))) return false;
  }

  const action = item.preparedAction;
  if (!action || typeof action !== "object" || Array.isArray(action)) return false;
  const actionRecord = action as Record<string, unknown>;
  if (!exactKeys(actionRecord, ["kind", "targetId", "label", "executionStarted"])) return false;
  if (!["open_project", "open_automation", "open_task"].includes(String(actionRecord.kind))) return false;
  if (typeof actionRecord.targetId !== "string" || !ID_RE.test(actionRecord.targetId) || !safeText(actionRecord.label, 96)) return false;
  return actionRecord.executionStarted === false;
}

export function isOneBriefingActionPacket(value: unknown): value is OneBriefingActionPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const packet = value as Record<string, unknown>;
  if (!exactKeys(packet, [
    "contractVersion", "packetId", "version", "candidateId", "expectedDetectedAt",
    "source", "evidenceDigest", "evidenceRefs", "expiresAt", "permission",
    "executionStarted", "status", "task", "run", "failure", "createdAt", "updatedAt",
  ])) return false;
  if (packet.contractVersion !== ONE_BRIEFING_ACTION_PACKET_CONTRACT_VERSION) return false;
  if (typeof packet.packetId !== "string" || !ID_RE.test(packet.packetId)) return false;
  if (typeof packet.candidateId !== "string" || !ID_RE.test(packet.candidateId)) return false;
  if (!Number.isSafeInteger(packet.version) || Number(packet.version) < 1) return false;
  if (!safeIso(packet.expectedDetectedAt) || !safeIso(packet.expiresAt) || !safeIso(packet.createdAt) || !safeIso(packet.updatedAt)) return false;
  if (packet.permission !== "read" || typeof packet.executionStarted !== "boolean") return false;
  if (![
    "prepared", "task_reserved", "task_ready", "start_reserved", "started",
    "start_failed", "recovery_required",
  ].includes(String(packet.status))) return false;
  if (packet.executionStarted !== (packet.status === "started")) return false;
  if (typeof packet.evidenceDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(packet.evidenceDigest)) return false;
  if (!Array.isArray(packet.evidenceRefs) || packet.evidenceRefs.length < 1 || packet.evidenceRefs.length > 8) return false;
  if (packet.evidenceRefs.some((item) => typeof item !== "string" || !ID_RE.test(item))) return false;

  const source = packet.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  const sourceRecord = source as Record<string, unknown>;
  if (!exactKeys(sourceRecord, ["kind", "refId", "receiptRef"])) return false;
  if (!["project_folder", "automation_run"].includes(String(sourceRecord.kind))) return false;
  if (typeof sourceRecord.refId !== "string" || !ID_RE.test(sourceRecord.refId)) return false;
  if (typeof sourceRecord.receiptRef !== "string" || !ID_RE.test(sourceRecord.receiptRef)) return false;

  if (packet.task !== null) {
    if (!packet.task || typeof packet.task !== "object" || Array.isArray(packet.task)) return false;
    const task = packet.task as Record<string, unknown>;
    if (!exactKeys(task, ["chatId", "taskId", "taskVersion", "projectId"])) return false;
    if (typeof task.chatId !== "string" || !ID_RE.test(task.chatId)) return false;
    if (typeof task.taskId !== "string" || !ID_RE.test(task.taskId)) return false;
    if (!Number.isSafeInteger(task.taskVersion) || Number(task.taskVersion) < 1) return false;
    if (task.projectId !== null && (typeof task.projectId !== "string" || !ID_RE.test(task.projectId))) return false;
  }
  if (["task_ready", "start_reserved", "started"].includes(String(packet.status)) && packet.task === null) return false;
  if (["prepared", "task_reserved"].includes(String(packet.status)) && packet.task !== null) return false;

  if (packet.run !== null) {
    if (!packet.run || typeof packet.run !== "object" || Array.isArray(packet.run)) return false;
    const run = packet.run as Record<string, unknown>;
    if (!exactKeys(run, ["runId", "startedAt"])) return false;
    if (typeof run.runId !== "string" || !ID_RE.test(run.runId) || !safeIso(run.startedAt)) return false;
  }
  if (packet.status === "started" && packet.run === null) return false;
  if (packet.status !== "started" && packet.run !== null) return false;

  if (packet.failure !== null) {
    if (!packet.failure || typeof packet.failure !== "object" || Array.isArray(packet.failure)) return false;
    const failure = packet.failure as Record<string, unknown>;
    if (!exactKeys(failure, ["category", "occurredAt"]) || !safeIso(failure.occurredAt)) return false;
    if (![
      "candidate_changed", "source_mismatch", "suppressed_or_resolved", "expired",
      "task_creation_failed", "start_rejected", "recovery_required",
    ].includes(String(failure.category))) return false;
  }
  return true;
}
