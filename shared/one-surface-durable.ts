import { redactSecrets } from "./secret-patterns";
import {
  ONE_SURFACE_BLOCK_TYPES,
  type OneSurfaceBlockType,
  type OneSurfaceManifestV1,
  type OneSurfaceSemanticActionIntent,
} from "./one-surface";

export const MAX_DURABLE_ONE_SURFACE_BYTES = 512 * 1024;

export interface DurableOneSurfaceResult {
  runId: string;
  chatId: string;
  taskId: string;
  recordedAt: string;
  manifest: OneSurfaceManifestV1;
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const LAYOUTS = new Set(["briefing", "comparison", "report", "itinerary", "media", "operations"]);
const STATES = new Set(["loading", "partial", "ready", "error", "stale", "offline"]);
const ACTION_INTENTS = new Set<OneSurfaceSemanticActionIntent>([
  "open_work", "approve_decision", "reject_decision", "modify_decision", "snooze_decision",
  "open_artifact", "open_sources", "open_receipt", "retry_failed_step", "cancel_task",
  "resume_task", "save_result", "change_conditions", "view_details", "edit_asset",
  "disable_asset", "use_once", "delete_asset", "reopen_intro", "connect_desktop",
  "try_result", "open_asset", "refine_result", "reuse_result", "prepare_share",
  "run_automation", "open_automation", "open_build", "toggle_mcp_server",
]);
const EXECUTABLE_OR_TRANSPORT_RE = /(?:<|javascript\s*:|data\s*:|\b(?:https?|file):\/\/|dangerouslySetInnerHTML|\bon(?:error|load|click)\s*=)/i;
const POSIX_ABSOLUTE_PATH_RE = /(^|[\s("'=:\[{])\/[^\s,;:"'`<>|}\]]+/m;
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\(?:[^\\,\r\n"'`<>|}\]]+\\)*[^\s\\,\r\n"'`<>|}\]]+/;
const UNC_PATH_RE = /\\\\[^\\\s,;:"'`<>|}\]]+(?:\\[^\\\s,;:"'`<>|}\]]+)+/;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_RE.test(value);
}

function isStringArray(value: unknown, limit = 256): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCell(value: unknown): boolean {
  return value == null || typeof value === "string" || typeof value === "boolean" || isFiniteNumber(value);
}

function isArtifact(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["artifactRef", "type", "label", "verificationStatus", "sizeBytes"])) return false;
  return isSafeId(value.artifactRef)
    && ["document", "spreadsheet", "image", "video", "audio", "archive", "data", "other"].includes(String(value.type))
    && typeof value.label === "string"
    && ["verified", "partially_verified", "unverified"].includes(String(value.verificationStatus))
    && (value.sizeBytes == null || (Number.isSafeInteger(value.sizeBytes) && Number(value.sizeBytes) >= 0));
}

function isAction(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "actionId", "intent", "label", "description", "instruction", "targetRef", "enabled", "blockedReason",
  ])) return false;
  return isSafeId(value.actionId)
    && typeof value.intent === "string"
    && ACTION_INTENTS.has(value.intent as OneSurfaceSemanticActionIntent)
    && typeof value.label === "string"
    && (value.description == null || (typeof value.description === "string" && value.description.length <= 220))
    && (value.instruction == null || (typeof value.instruction === "string" && value.instruction.length <= 800))
    && (value.targetRef == null || isSafeId(value.targetRef))
    && typeof value.enabled === "boolean"
    && (value.blockedReason == null || typeof value.blockedReason === "string");
}

function isBlock(value: unknown): value is Record<string, unknown> & { blockId: string; type: OneSurfaceBlockType } {
  if (!isRecord(value) || !isSafeId(value.blockId) || typeof value.type !== "string" || typeof value.title !== "string") return false;
  if (!ONE_SURFACE_BLOCK_TYPES.includes(value.type as OneSurfaceBlockType)) return false;
  const items = value.items;
  switch (value.type as OneSurfaceBlockType) {
    case "Narrative":
      return hasOnlyKeys(value, ["blockId", "type", "title", "paragraphs"]) && isStringArray(value.paragraphs, 256);
    case "Metric":
      return hasOnlyKeys(value, ["blockId", "type", "title", "items"])
        && Array.isArray(items) && items.length <= 256 && items.every((item) => isRecord(item)
          && hasOnlyKeys(item, ["metricId", "label", "value", "unit", "verificationStatus", "evidenceRefs"])
          && isSafeId(item.metricId) && typeof item.label === "string" && (typeof item.value === "string" || isFiniteNumber(item.value))
          && (item.unit == null || typeof item.unit === "string")
          && ["verified", "estimated", "unverified"].includes(String(item.verificationStatus))
          && (item.evidenceRefs == null || isStringArray(item.evidenceRefs)));
    case "Table":
      return hasOnlyKeys(value, ["blockId", "type", "title", "columns", "featuredColumnIds", "rows"])
        && Array.isArray(value.columns) && value.columns.length <= 64 && value.columns.every((column) => isRecord(column)
          && hasOnlyKeys(column, ["columnId", "label"]) && isSafeId(column.columnId) && typeof column.label === "string")
        && isStringArray(value.featuredColumnIds, 64)
        && Array.isArray(value.rows) && value.rows.length <= 2_000 && value.rows.every((row) => isRecord(row)
          && hasOnlyKeys(row, ["rowId", "cells"]) && isSafeId(row.rowId) && Array.isArray(row.cells) && row.cells.length <= 64
          && row.cells.every((cell) => isRecord(cell) && hasOnlyKeys(cell, ["columnId", "value"]) && isSafeId(cell.columnId) && isCell(cell.value)));
    case "Comparison":
      return hasOnlyKeys(value, ["blockId", "type", "title", "recommendedOptionRef", "options"])
        && isSafeId(value.recommendedOptionRef) && Array.isArray(value.options) && value.options.length <= 64
        && value.options.every((option) => isRecord(option)
          && hasOnlyKeys(option, ["optionRef", "title", "subtitle", "artifactRef", "strengths", "limitations"])
          && isSafeId(option.optionRef) && typeof option.title === "string"
          && (option.subtitle == null || typeof option.subtitle === "string")
          && (option.artifactRef == null || isSafeId(option.artifactRef))
          && isStringArray(option.strengths, 64) && isStringArray(option.limitations, 64));
    case "Timeline":
      return hasOnlyKeys(value, ["blockId", "type", "title", "items"])
        && Array.isArray(items) && items.length <= 512 && items.every((item) => isRecord(item)
          && hasOnlyKeys(item, ["itemId", "at", "title", "detail", "status"])
          && isSafeId(item.itemId) && (item.at == null || typeof item.at === "string") && typeof item.title === "string"
          && (item.detail == null || typeof item.detail === "string")
          && ["upcoming", "in_progress", "completed", "failed", "cancelled"].includes(String(item.status)));
    case "Map":
      return hasOnlyKeys(value, ["blockId", "type", "title", "locations"])
        && Array.isArray(value.locations) && value.locations.length <= 512 && value.locations.every((location) => isRecord(location)
          && hasOnlyKeys(location, ["locationRef", "label", "latitude", "longitude", "sequence"])
          && isSafeId(location.locationRef) && typeof location.label === "string"
          && isFiniteNumber(location.latitude) && Number(location.latitude) >= -90 && Number(location.latitude) <= 90
          && isFiniteNumber(location.longitude) && Number(location.longitude) >= -180 && Number(location.longitude) <= 180
          && (location.sequence == null || Number.isSafeInteger(location.sequence)));
    case "Gallery":
      return hasOnlyKeys(value, ["blockId", "type", "title", "items"])
        && Array.isArray(items) && items.length <= 512 && items.every((item) => isRecord(item)
          && hasOnlyKeys(item, ["artifactRef", "label", "altText", "provenance"])
          && isSafeId(item.artifactRef) && typeof item.label === "string" && typeof item.altText === "string"
          && ["user_original", "generated", "edited", "licensed_source", "unknown_source"].includes(String(item.provenance)));
    case "Media":
      return hasOnlyKeys(value, ["blockId", "type", "title", "primaryArtifactRef", "mediaType", "caption", "durationSeconds", "outputs"])
        && isSafeId(value.primaryArtifactRef) && ["video", "audio", "image"].includes(String(value.mediaType))
        && (value.caption == null || typeof value.caption === "string")
        && (value.durationSeconds == null || (isFiniteNumber(value.durationSeconds) && Number(value.durationSeconds) >= 0))
        && Array.isArray(value.outputs) && value.outputs.length <= 512 && value.outputs.every(isArtifact);
    case "Document":
      return hasOnlyKeys(value, ["blockId", "type", "title", "artifactRef", "excerpt", "pageCount"])
        && isSafeId(value.artifactRef) && typeof value.excerpt === "string"
        && (value.pageCount == null || (Number.isSafeInteger(value.pageCount) && Number(value.pageCount) >= 0));
    case "ArtifactList":
      return hasOnlyKeys(value, ["blockId", "type", "title", "items"])
        && Array.isArray(items) && items.length <= 512 && items.every(isArtifact);
    case "SourceList":
      return hasOnlyKeys(value, ["blockId", "type", "title", "sources"])
        && Array.isArray(value.sources) && value.sources.length <= 512 && value.sources.every((source) => isRecord(source)
          && hasOnlyKeys(source, ["sourceRef", "title", "publisher", "verificationStatus", "claimRefs"])
          && isSafeId(source.sourceRef) && typeof source.title === "string"
          && (source.publisher == null || typeof source.publisher === "string")
          && ["verified", "partially_verified", "unverified"].includes(String(source.verificationStatus))
          && (source.claimRefs == null || isStringArray(source.claimRefs)));
    case "Decision":
      return hasOnlyKeys(value, ["blockId", "type", "title", "decisionId", "prompt", "risk", "options", "deadline"])
        && isSafeId(value.decisionId) && typeof value.prompt === "string"
        && ["low", "moderate", "high", "critical"].includes(String(value.risk))
        && Array.isArray(value.options) && value.options.length <= 64 && value.options.every((option) => isRecord(option)
          && hasOnlyKeys(option, ["optionRef", "label", "consequence"])
          && isSafeId(option.optionRef) && typeof option.label === "string" && typeof option.consequence === "string")
        && (value.deadline == null || typeof value.deadline === "string");
    case "Status":
      return hasOnlyKeys(value, ["blockId", "type", "title", "taskState", "steps"])
        && ["waiting", "working", "decision_required", "completed", "failed", "stopped"].includes(String(value.taskState))
        && Array.isArray(value.steps) && value.steps.length <= 512 && value.steps.every((step) => isRecord(step)
          && hasOnlyKeys(step, ["stepRef", "label", "status", "receiptRef"])
          && isSafeId(step.stepRef) && typeof step.label === "string"
          && ["waiting", "working", "decision_required", "completed", "failed", "stopped"].includes(String(step.status))
          && (step.receiptRef == null || isSafeId(step.receiptRef)));
    case "Budget":
      return hasOnlyKeys(value, ["blockId", "type", "title", "currency", "total", "limit", "lines"])
        && typeof value.currency === "string" && isFiniteNumber(value.total) && isFiniteNumber(value.limit)
        && Array.isArray(value.lines) && value.lines.length <= 512 && value.lines.every((line) => isRecord(line)
          && hasOnlyKeys(line, ["lineRef", "label", "amount", "verificationStatus"])
          && isSafeId(line.lineRef) && typeof line.label === "string" && isFiniteNumber(line.amount)
          && ["verified", "estimated", "unverified"].includes(String(line.verificationStatus)));
    case "Checklist":
      return hasOnlyKeys(value, ["blockId", "type", "title", "items"])
        && Array.isArray(items) && items.length <= 512 && items.every((item) => isRecord(item)
          && hasOnlyKeys(item, ["itemRef", "label", "status", "evidenceRef"])
          && isSafeId(item.itemRef) && typeof item.label === "string"
          && ["not_started", "in_progress", "completed", "failed", "not_applicable"].includes(String(item.status))
          && (item.evidenceRef == null || isSafeId(item.evidenceRef)));
    case "ValueClosure":
      return hasOnlyKeys(value, ["blockId", "type", "title", "valueClosureRef"]) && isSafeId(value.valueClosureRef);
    case "ImprovementProof":
      return hasOnlyKeys(value, ["blockId", "type", "title", "improvementProofRef", "collapsedByDefault"])
        && isSafeId(value.improvementProofRef) && value.collapsedByDefault === true;
    case "Automation":
      return hasOnlyKeys(value, ["blockId", "type", "title", "automationId", "status", "schedule", "nodes", "lastRun"])
        && isSafeId(value.automationId)
        && ["registered", "running", "failed"].includes(String(value.status))
        && (value.schedule == null || typeof value.schedule === "string")
        && Array.isArray(value.nodes) && value.nodes.length <= 64 && value.nodes.every((node) => isRecord(node)
          && hasOnlyKeys(node, ["nodeRef", "label"]) && isSafeId(node.nodeRef) && typeof node.label === "string")
        && (value.lastRun == null || (isRecord(value.lastRun)
          && hasOnlyKeys(value.lastRun, ["at", "status", "summary"])
          && (value.lastRun.at == null || typeof value.lastRun.at === "string")
          && ["completed", "failed", "cancelled", "running"].includes(String(value.lastRun.status))
          && (value.lastRun.summary == null || typeof value.lastRun.summary === "string")));
    case "AgentBuild":
      return hasOnlyKeys(value, ["blockId", "type", "title", "buildSessionId", "agentName", "agentSlug", "stages", "request"])
        && isSafeId(value.buildSessionId)
        && typeof value.agentName === "string"
        && (value.request == null || (typeof value.request === "string" && value.request.length <= 4000))
        && (value.agentSlug == null || isSafeId(value.agentSlug))
        && Array.isArray(value.stages) && value.stages.length <= 64 && value.stages.every((stage) => isRecord(stage)
          && hasOnlyKeys(stage, ["stageRef", "label", "status"]) && isSafeId(stage.stageRef)
          && typeof stage.label === "string"
          && ["waiting", "working", "completed", "failed"].includes(String(stage.status)));
    case "McpSetup":
      return hasOnlyKeys(value, ["blockId", "type", "title", "servers"])
        && Array.isArray(value.servers) && value.servers.length > 0 && value.servers.length <= 64
        && value.servers.every((server) => isRecord(server)
          && hasOnlyKeys(server, ["catalogId", "name", "enabled", "keyState"])
          && isSafeId(server.catalogId) && typeof server.name === "string"
          && typeof server.enabled === "boolean"
          && ["not_required", "missing", "configured"].includes(String(server.keyState)));
  }
}

function containsUnsafeTransportValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") {
    return redactSecrets(value) !== value
      || EXECUTABLE_OR_TRANSPORT_RE.test(value)
      || POSIX_ABSOLUTE_PATH_RE.test(value)
      || WINDOWS_ABSOLUTE_PATH_RE.test(value)
      || UNC_PATH_RE.test(value);
  }
  if (!value || typeof value !== "object") return false;
  // Shared immutable arrays (for example Desktop/Mobile blockOrder) are valid;
  // JSON.stringify above already rejects actual cycles before this traversal.
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsUnsafeTransportValue(item, seen));
  return Object.entries(value).some(([key, item]) =>
    containsUnsafeTransportValue(key, seen) || containsUnsafeTransportValue(item, seen));
}

function isTransportSafe(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  return utf8Bytes(serialized) <= MAX_DURABLE_ONE_SURFACE_BYTES
    && !containsUnsafeTransportValue(value);
}

/**
 * Storage boundary for Main-projected One results. It validates without
 * rewriting so a JSON round trip restores the exact semantic manifest.
 */
export function isDurableOneSurfaceManifestV1(
  value: unknown,
  expectedTaskId?: string,
): value is OneSurfaceManifestV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "contractVersion", "manifestId", "taskId", "title", "summary", "layoutProfile", "surfaceState",
    "blocks", "primaryAction", "secondaryActions", "evidence", "fallback", "recomposition",
  ])) return false;
  if (value.contractVersion !== "1.0.0" || !isSafeId(value.manifestId) || !isSafeId(value.taskId)) return false;
  if (expectedTaskId && value.taskId !== expectedTaskId) return false;
  if (typeof value.title !== "string" || typeof value.summary !== "string" || !LAYOUTS.has(String(value.layoutProfile))) return false;
  if (!isRecord(value.surfaceState) || !hasOnlyKeys(value.surfaceState, [
    "value", "summary", "readOnly", "lastSyncedAt", "incompleteBlockIds", "failedStepRefs",
  ])) return false;
  if (!STATES.has(String(value.surfaceState.value)) || typeof value.surfaceState.summary !== "string" || typeof value.surfaceState.readOnly !== "boolean") return false;
  if (value.surfaceState.lastSyncedAt != null && typeof value.surfaceState.lastSyncedAt !== "string") return false;
  if (value.surfaceState.incompleteBlockIds != null && !isStringArray(value.surfaceState.incompleteBlockIds)) return false;
  if (value.surfaceState.failedStepRefs != null && !isStringArray(value.surfaceState.failedStepRefs)) return false;

  if (!Array.isArray(value.blocks) || value.blocks.length === 0 || value.blocks.length > 256 || !value.blocks.every(isBlock)) return false;
  const blockIds = value.blocks.map((block) => block.blockId);
  if (new Set(blockIds).size !== blockIds.length) return false;
  if (value.primaryAction !== null && !isAction(value.primaryAction)) return false;
  if (!Array.isArray(value.secondaryActions) || value.secondaryActions.length > 2 || !value.secondaryActions.every(isAction)) return false;

  if (!Array.isArray(value.evidence) || value.evidence.length > 512 || !value.evidence.every((entry) => isRecord(entry)
    && hasOnlyKeys(entry, ["evidenceRef", "kind", "verificationStatus", "claimRefs", "label"])
    && isSafeId(entry.evidenceRef)
    && ["source", "receipt", "artifact_verification", "outcome", "baseline"].includes(String(entry.kind))
    && ["verified", "partially_verified", "unverified", "estimated"].includes(String(entry.verificationStatus))
    && (entry.claimRefs == null || isStringArray(entry.claimRefs))
    && (entry.label == null || typeof entry.label === "string"))) return false;

  if (!isRecord(value.fallback) || !hasOnlyKeys(value.fallback, ["markdown", "artifacts"])
    || typeof value.fallback.markdown !== "string" || !Array.isArray(value.fallback.artifacts)
    || value.fallback.artifacts.length > 512 || !value.fallback.artifacts.every(isArtifact)) return false;

  if (!isRecord(value.recomposition) || !hasOnlyKeys(value.recomposition, ["desktop", "mobile"])
    || !isRecord(value.recomposition.desktop) || !isRecord(value.recomposition.mobile)) return false;
  const desktop = value.recomposition.desktop;
  const mobile = value.recomposition.mobile;
  if (!hasOnlyKeys(desktop, ["blockOrder", "tableStrategy", "comparisonStrategy", "timelineStrategy"])
    || !hasOnlyKeys(mobile, ["blockOrder", "tableStrategy", "comparisonStrategy", "timelineStrategy"])) return false;
  const desktopOrder = desktop.blockOrder;
  const mobileOrder = mobile.blockOrder;
  if (!isStringArray(desktopOrder) || !isStringArray(mobileOrder)) return false;
  if (desktopOrder.length !== blockIds.length || mobileOrder.length !== blockIds.length) return false;
  if (new Set(desktopOrder).size !== blockIds.length || new Set(mobileOrder).size !== blockIds.length) return false;
  if (blockIds.some((id) => !desktopOrder.includes(id) || !mobileOrder.includes(id))) return false;
  if (!["full_table", "compact_table"].includes(String(desktop.tableStrategy))
    || !["matrix", "split_view"].includes(String(desktop.comparisonStrategy))
    || !["adaptive", "horizontal", "vertical"].includes(String(desktop.timelineStrategy))
    || !["featured_cards_then_sheet", "stacked_rows"].includes(String(mobile.tableStrategy))
    || mobile.comparisonStrategy !== "recommended_then_alternatives" || mobile.timelineStrategy !== "vertical") return false;

  return isTransportSafe(value);
}

export function parseDurableOneSurfaceJson(
  json: string,
  expectedTaskId?: string,
): OneSurfaceManifestV1 | null {
  if (!json || utf8Bytes(json) > MAX_DURABLE_ONE_SURFACE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isDurableOneSurfaceManifestV1(value, expectedTaskId) ? value : null;
  } catch {
    return null;
  }
}
