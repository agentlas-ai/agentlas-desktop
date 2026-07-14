import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getSessionCookieHeader } from "../auth";
import {
  operationalRuntimeOverlayIsRuntimeSafe,
} from "../ontology/operational-runtime-contract";
import {
  tasteRuntimeTokenEvidenceIsValid,
} from "../ontology/taste-runtime-contract";
import type {
  DesktopOntologyRuntimeSessionDto,
  DesktopOperationalRuntimeOverlayDto,
  MobileBridgeOntologyAttachReceiptDto,
  MobileBridgeOntologyAttachmentState,
  MobileBridgeOntologyChipDto,
  MobileBridgeOntologyChipKind,
  MobileBridgeOntologyLoadoutEntryDto,
  MobileBridgeOntologyLoadoutState,
  MobileBridgeOntologyProjectionDto,
  MobileBridgeOntologyProjectionState,
  MobileBridgeOntologyRecommendationDto,
  MobileBridgeOntologyScheduledLoadoutDto,
  MobileBridgeOntologyVerification,
  MobileBridgeTasteRuntimeOverlayDto,
} from "../../shared/mobile-bridge";

const PROJECTION_QUERY_PATH = "/api/ontology/v1/mobile/projections/query";
const ATTACH_RESOLVE_PATH = "/api/ontology/v1/mobile/attachments/resolve";
const DESKTOP_RUNTIME_SESSION_PATH = "/api/ontology/v1/desktop/runtime/session";
const MAX_BINDINGS = 64;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 256;
const QUERY_FRESH_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,159}$/;
const REVISION_RE = /^rev_[a-f0-9]{32}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const TASTE_RUNTIME_AXES = [
  "composition", "color", "typography", "motion", "pacing", "density",
  "imagery", "editing", "spatial-rhythm",
] as const;
const TASTE_RUNTIME_TASKS = [
  "agentlas.task.v1/design", "agentlas.task.v1/image-generation",
  "agentlas.task.v1/video-production", "agentlas.task.v1/presentation",
] as const;
const TASTE_RUNTIME_ATTRIBUTES: Record<typeof TASTE_RUNTIME_AXES[number], string> = {
  composition: "structure", color: "saturation", typography: "hierarchy",
  motion: "intensity", pacing: "tempo", density: "information",
  imagery: "treatment", editing: "rhythm", "spatial-rhythm": "spacing",
};
const TASTE_RUNTIME_VALUES: Record<typeof TASTE_RUNTIME_AXES[number], ReadonlySet<string>> = {
  composition: new Set(["single-dominant", "balanced", "uniform", "modular", "layered"]),
  color: new Set(["muted", "balanced", "vivid", "monochrome"]),
  typography: new Set(["subtle", "moderate", "strong"]),
  motion: new Set(["none", "subtle", "moderate", "dynamic"]),
  pacing: new Set(["slow", "moderate", "fast"]),
  density: new Set(["sparse", "balanced", "dense"]),
  imagery: new Set(["documentary", "editorial", "illustrative", "abstract", "product"]),
  editing: new Set(["continuity", "measured", "montage", "dynamic"]),
  "spatial-rhythm": new Set(["tight", "balanced", "generous"]),
};
const SECRET_RE = /(?:bearer\s+[A-Za-z0-9._~+/=\-]{12,}|sk-(?:proj-|ant-)?[A-Za-z0-9_\-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_\-]{20,}|npm_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|(?:api[_ -]?key|password|token|cookie|secret)\s*[:=]\s*\S+|data:(?:image|application)\/[^;,]+;base64,)/i;
const EMAIL_RE = /\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b/i;
const PHONE_RE = /(?<![A-Za-z0-9])\+?\d[\d .()\-]*\d(?![A-Za-z0-9])/g;
const ABSOLUTE_PATH_RE = /(?:^|[\s"'({:=<>\[])(?:\/(?!\/)|\/\/)|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|file:\/\//i;
const WEB_URL_RE = /https?:\/\/[^\s]+/gi;

export interface ExactAgentReleaseBinding {
  agentDefinitionId: string;
  agentReleaseId: string;
}

export type OntologyHubAvailability = "unknown" | "available" | "absent";

export interface OntologyHubProjectionResult {
  supported: boolean;
  status: "live" | "offline" | "stale" | "auth-unavailable" | "endpoint-absent";
  projections: MobileBridgeOntologyProjectionDto[];
}

export interface OntologyHubClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  cookieProvider?: () => string | null;
  timeoutMs?: number;
  allowLoopback?: boolean;
  cacheFile?: string;
  now?: () => Date;
}

export interface OntologyAttachResolveInput {
  schemaVersion: 1;
  approvalId: string;
  recommendationId: string;
  agentDefinitionId: string;
  agentReleaseId: string;
  expectedProjectionRevision: string;
  expectedLoadoutRevision: string;
  decision: "approve" | "deny";
  selectedChips: MobileBridgeOntologyLoadoutEntryDto[];
}

class ContractError extends Error {}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(`${label} must be an object.`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new ContractError(`${label} has an invalid prototype.`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allow.has(key));
  if (extra) throw new ContractError(`${label} contains unsupported field ${extra}.`);
}

function safeRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_REF_RE.test(value) || value.includes("..")) {
    throw new ContractError(`${label} is not a portable identifier.`);
  }
  safeText(value, label);
  return value;
}

function revision(value: unknown, label: string): string {
  if (typeof value !== "string" || !REVISION_RE.test(value)) {
    throw new ContractError(`${label} must be a canonical revision.`);
  }
  return value;
}

function safeText(value: unknown, label: string, max = 600): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new ContractError(`${label} must be 1-${max} characters.`);
  }
  const withoutWebUrls = value.replace(WEB_URL_RE, "");
  const phone = [...value.matchAll(PHONE_RE)].some((match) => {
    const count = (match[0].match(/\d/g) ?? []).length;
    return count >= 10 && count <= 15;
  });
  if (
    /[\u0000-\u001f]/.test(value) ||
    SECRET_RE.test(value) ||
    EMAIL_RE.test(value) ||
    phone ||
    ABSOLUTE_PATH_RE.test(withoutWebUrls)
  ) {
    throw new ContractError(`${label} contains private or host-local material.`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    throw new ContractError(`${label} must be an ISO-8601 UTC timestamp.`);
  }
  return value;
}

function integer(value: unknown, label: string, max = 1_000_000): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new ContractError(`${label} must be a bounded non-negative integer.`);
  }
  return Number(value);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ContractError(`${label} is unsupported.`);
  }
  return value as T;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ContractError(`${label} exceeds its item bound.`);
  return value;
}

function textArray(value: unknown, label: string, max: number): string[] {
  return array(value, label, max).map((item, index) => safeText(item, `${label}[${index}]`, 180));
}

function decodeEntry(value: unknown): MobileBridgeOntologyLoadoutEntryDto {
  const row = record(value, "loadout entry");
  onlyKeys(row, ["chipId", "releaseId", "kind", "state", "availableReleaseId"], "loadout entry");
  const entry: MobileBridgeOntologyLoadoutEntryDto = {
    chipId: safeRef(row.chipId, "chipId"),
    releaseId: safeRef(row.releaseId, "releaseId"),
    kind: enumValue(row.kind, ["operational", "taste"] as const, "kind"),
    state: enumValue(
      row.state,
      ["attached", "update-available", "pending-approval", "scheduled-next-session", "applying", "conflict", "revoked"] as const,
      "state",
    ),
  };
  if (row.availableReleaseId !== undefined) {
    entry.availableReleaseId = safeRef(row.availableReleaseId, "availableReleaseId");
  }
  return entry;
}

function uniqueEntries(values: MobileBridgeOntologyLoadoutEntryDto[], label: string): void {
  const seen = new Set<string>();
  const kinds = new Set<MobileBridgeOntologyChipKind>();
  for (const value of values) {
    if (seen.has(value.chipId)) throw new ContractError(`${label} repeats a chip id.`);
    if (kinds.has(value.kind)) throw new ContractError(`${label} repeats a chip kind.`);
    seen.add(value.chipId);
    kinds.add(value.kind);
  }
}

function decodeScheduledLoadout(value: unknown): MobileBridgeOntologyScheduledLoadoutDto {
  const row = record(value, "scheduled next-session loadout");
  onlyKeys(row, ["revision", "state", "entries", "changedAt"], "scheduled next-session loadout");
  if (row.state !== "pending-next-session") {
    throw new ContractError("scheduledNextSession.state must be pending-next-session.");
  }
  const entries = array(row.entries, "scheduledNextSession.entries", 2).map(decodeEntry);
  if (entries.length === 0 || entries.some((entry) => entry.state !== "scheduled-next-session")) {
    throw new ContractError("scheduledNextSession requires exact scheduled-next-session entries.");
  }
  uniqueEntries(entries, "scheduled next-session loadout");
  return {
    revision: revision(row.revision, "scheduledNextSession.revision"),
    state: "pending-next-session",
    entries,
    ...(row.changedAt === undefined ? {} : { changedAt: iso(row.changedAt, "scheduledNextSession.changedAt") }),
  };
}

function decodeChip(value: unknown, expectedKind: MobileBridgeOntologyChipKind): MobileBridgeOntologyChipDto {
  const row = record(value, "ontology chip");
  onlyKeys(
    row,
    ["chipId", "releaseId", "kind", "displayName", "summary", "version", "verification", "labels", "evidenceLabel", "evidenceCount", "runtimeOverlay"],
    "ontology chip",
  );
  const kind = enumValue(row.kind, ["operational", "taste"] as const, "kind");
  if (kind !== expectedKind) throw new ContractError("Ontology chip is in the wrong kind list.");
  const verification = enumValue(
    row.verification,
    ["verified", "requested", "unverified", "rejected"] as const,
    "verification",
  ) as MobileBridgeOntologyVerification;
  const evidenceCount = integer(row.evidenceCount, "evidenceCount");
  if (verification === "verified" && evidenceCount === 0) {
    throw new ContractError("A verified chip requires non-zero evidence.");
  }
  const chipId = safeRef(row.chipId, "chipId");
  const releaseId = safeRef(row.releaseId, "releaseId");
  const runtimeOverlay = row.runtimeOverlay === undefined
    ? undefined
    : decodeTasteRuntimeOverlay(row.runtimeOverlay, { chipId, releaseId });
  if (kind === "operational" && runtimeOverlay) {
    throw new ContractError("Operational chips cannot carry a Taste runtime overlay.");
  }
  return {
    chipId,
    releaseId,
    kind,
    displayName: safeText(row.displayName, "displayName", 120),
    summary: safeText(row.summary, "summary", 600),
    version: safeText(row.version, "version", 40),
    verification,
    labels: textArray(row.labels, "labels", 16),
    evidenceLabel: safeText(row.evidenceLabel, "evidenceLabel", 160),
    evidenceCount,
    ...(runtimeOverlay ? { runtimeOverlay } : {}),
  };
}

function decodeTasteRuntimeOverlay(
  value: unknown,
  exact: { chipId: string; releaseId: string },
): MobileBridgeTasteRuntimeOverlayDto {
  const row = record(value, "Taste runtime overlay");
  onlyKeys(row, [
    "schemaVersion", "chipId", "releaseId", "sourceContentHash",
    "baseAgentDefinitionId", "baseAgentReleaseId", "taskSignatures",
    "rules", "estimatedTokens", "budgetTokens",
  ], "Taste runtime overlay");
  if (row.schemaVersion !== 2 || row.budgetTokens !== 240) {
    throw new ContractError("Taste runtime overlay contract is unsupported.");
  }
  const chipId = safeRef(row.chipId, "Taste runtime chipId");
  const releaseId = safeRef(row.releaseId, "Taste runtime releaseId");
  if (chipId !== exact.chipId || releaseId !== exact.releaseId) {
    throw new ContractError("Taste runtime overlay exact release changed.");
  }
  if (typeof row.sourceContentHash !== "string" || !SHA256_RE.test(row.sourceContentHash)) {
    throw new ContractError("Taste runtime content hash is invalid.");
  }
  const taskSignatures = array(row.taskSignatures, "Taste runtime task signatures", TASTE_RUNTIME_TASKS.length)
    .map((item, index) => enumValue(item, TASTE_RUNTIME_TASKS, `Taste runtime taskSignatures[${index}]`));
  if (taskSignatures.length === 0 || new Set(taskSignatures).size !== taskSignatures.length) {
    throw new ContractError("Taste runtime task signatures are missing or duplicated.");
  }
  const ruleIds = new Set<string>();
  const rules = array(row.rules, "Taste runtime rules", 6).map((item, index) => {
    const rule = record(item, `Taste runtime rules[${index}]`);
    onlyKeys(rule, ["ruleId", "axis", "polarity", "attribute", "value", "strength"], `Taste runtime rules[${index}]`);
    const ruleId = safeRef(rule.ruleId, `Taste runtime rules[${index}].ruleId`);
    const ruleAxis = enumValue(rule.axis, TASTE_RUNTIME_AXES, `Taste runtime rules[${index}].axis`);
    if (ruleIds.has(ruleId)) throw new ContractError("Taste runtime rule identity is duplicated.");
    ruleIds.add(ruleId);
    if (
      rule.attribute !== TASTE_RUNTIME_ATTRIBUTES[ruleAxis] ||
      typeof rule.value !== "string" || !TASTE_RUNTIME_VALUES[ruleAxis].has(rule.value) ||
      !Number.isInteger(rule.strength) || Number(rule.strength) < 1 || Number(rule.strength) > 3
    ) {
      throw new ContractError("Taste runtime aesthetic attribute is invalid.");
    }
    return {
      ruleId,
      axis: ruleAxis,
      polarity: enumValue(rule.polarity, ["prefer", "avoid"] as const, `Taste runtime rules[${index}].polarity`),
      attribute: rule.attribute as MobileBridgeTasteRuntimeOverlayDto["rules"][number]["attribute"],
      value: rule.value,
      strength: rule.strength as 1 | 2 | 3,
    };
  });
  if (rules.length === 0) throw new ContractError("Taste runtime rules are empty.");
  const estimatedTokens = integer(row.estimatedTokens, "Taste runtime estimatedTokens", 240);
  if (estimatedTokens < 1) throw new ContractError("Taste runtime token estimate is invalid.");
  const overlay: MobileBridgeTasteRuntimeOverlayDto = {
    schemaVersion: 2,
    chipId,
    releaseId,
    sourceContentHash: row.sourceContentHash,
    baseAgentDefinitionId: safeRef(row.baseAgentDefinitionId, "Taste runtime baseAgentDefinitionId"),
    baseAgentReleaseId: safeRef(row.baseAgentReleaseId, "Taste runtime baseAgentReleaseId"),
    taskSignatures,
    rules,
    estimatedTokens,
    budgetTokens: 240,
  };
  if (!tasteRuntimeTokenEvidenceIsValid(overlay)) {
    throw new ContractError("Taste runtime directive exceeds or falsifies its token budget.");
  }
  return overlay;
}

function decodeDesktopOperationalRuntimeOverlay(value: unknown): DesktopOperationalRuntimeOverlayDto {
  const row = record(value, "Desktop Operational runtime overlay");
  onlyKeys(row, [
    "schemaVersion", "chipId", "releaseId", "sourceContentHash",
    "baseAgentDefinitionId", "baseAgentReleaseId", "taskSignatures",
    "instructions", "estimatedTokens", "budgetTokens",
  ], "Desktop Operational runtime overlay");
  if (row.schemaVersion !== 1 || row.budgetTokens !== 560) {
    throw new ContractError("Desktop Operational runtime overlay contract is unsupported.");
  }
  if (typeof row.sourceContentHash !== "string" || !SHA256_RE.test(row.sourceContentHash)) {
    throw new ContractError("Desktop Operational runtime content hash is invalid.");
  }
  const taskSignatures = array(row.taskSignatures, "Desktop Operational task signatures", 16)
    .map((item, index) => safeRef(item, `Desktop Operational taskSignatures[${index}]`));
  const instructions = array(row.instructions, "Desktop Operational instructions", 8)
    .map((item, index) => safeText(item, `Desktop Operational instructions[${index}]`, 600));
  if (
    taskSignatures.length === 0 || new Set(taskSignatures).size !== taskSignatures.length ||
    instructions.length === 0 || new Set(instructions).size !== instructions.length
  ) throw new ContractError("Desktop Operational runtime content is missing or duplicated.");
  const overlay: DesktopOperationalRuntimeOverlayDto = {
    schemaVersion: 1,
    chipId: safeRef(row.chipId, "Desktop Operational chipId"),
    releaseId: safeRef(row.releaseId, "Desktop Operational releaseId"),
    sourceContentHash: row.sourceContentHash,
    baseAgentDefinitionId: safeRef(row.baseAgentDefinitionId, "Desktop Operational baseAgentDefinitionId"),
    baseAgentReleaseId: safeRef(row.baseAgentReleaseId, "Desktop Operational baseAgentReleaseId"),
    taskSignatures,
    instructions,
    estimatedTokens: integer(row.estimatedTokens, "Desktop Operational estimatedTokens", 560),
    budgetTokens: 560,
  };
  if (!operationalRuntimeOverlayIsRuntimeSafe(overlay)) {
    throw new ContractError("Desktop Operational runtime overlay is not safe to execute.");
  }
  return overlay;
}

function decodeDesktopOntologyRuntimeSession(value: unknown): DesktopOntologyRuntimeSessionDto {
  const row = record(value, "Desktop ontology runtime session");
  onlyKeys(row, [
    "schemaVersion", "agentDefinitionId", "agentReleaseId", "state",
    "projectionRevision", "loadoutRevision", "operational", "taste", "generatedAt",
  ], "Desktop ontology runtime session");
  if (row.schemaVersion !== 1) throw new ContractError("Desktop ontology runtime session schema is unsupported.");
  const agentDefinitionId = safeRef(row.agentDefinitionId, "Desktop runtime agentDefinitionId");
  const agentReleaseId = safeRef(row.agentReleaseId, "Desktop runtime agentReleaseId");
  const operational = row.operational === null ? null : decodeDesktopOperationalRuntimeOverlay(row.operational);
  const taste = row.taste === null
    ? null
    : decodeTasteRuntimeOverlay(row.taste, {
        chipId: safeRef(record(row.taste, "Desktop Taste runtime").chipId, "Desktop Taste chipId"),
        releaseId: safeRef(record(row.taste, "Desktop Taste runtime").releaseId, "Desktop Taste releaseId"),
      });
  const state = enumValue(row.state, ["ready", "empty", "revoked"] as const, "Desktop runtime state");
  if (
    (state === "ready" && !operational && !taste) ||
    (state !== "ready" && Boolean(operational || taste)) ||
    [operational, taste].some((overlay) => overlay && (
      overlay.baseAgentDefinitionId !== agentDefinitionId || overlay.baseAgentReleaseId !== agentReleaseId
    ))
  ) throw new ContractError("Desktop runtime state or exact base binding is inconsistent.");
  return {
    schemaVersion: 1,
    agentDefinitionId,
    agentReleaseId,
    state,
    projectionRevision: revision(row.projectionRevision, "Desktop runtime projectionRevision"),
    loadoutRevision: revision(row.loadoutRevision, "Desktop runtime loadoutRevision"),
    operational,
    taste,
    generatedAt: iso(row.generatedAt, "Desktop runtime generatedAt"),
  };
}

function decodeRecommendation(value: unknown): MobileBridgeOntologyRecommendationDto {
  const row = record(value, "recommendation");
  onlyKeys(
    row,
    ["recommendationId", "source", "summary", "reasons", "tradeoffs", "proposedChips", "requiresApproval", "createdAt", "expiresAt"],
    "recommendation",
  );
  const proposedChips = array(row.proposedChips, "proposedChips", 2).map(decodeEntry);
  if (proposedChips.length === 0) throw new ContractError("Recommendation must propose an exact release.");
  uniqueEntries(proposedChips, "recommendation");
  if (proposedChips.some((entry) => entry.state !== "pending-approval")) {
    throw new ContractError("Recommendation entries must be pending-approval.");
  }
  const createdAt = iso(row.createdAt, "createdAt");
  const expiresAt = iso(row.expiresAt, "expiresAt");
  if (row.requiresApproval !== true || Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new ContractError("Recommendation must require approval and have a valid expiry.");
  }
  return {
    recommendationId: safeRef(row.recommendationId, "recommendationId"),
    source: safeText(row.source, "source", 80),
    summary: safeText(row.summary, "summary", 600),
    reasons: textArray(row.reasons, "reasons", 12),
    tradeoffs: textArray(row.tradeoffs, "tradeoffs", 12),
    proposedChips,
    requiresApproval: true,
    createdAt,
    expiresAt,
  };
}

function decodeProjection(value: unknown): MobileBridgeOntologyProjectionDto {
  const row = record(value, "ontology projection");
  onlyKeys(
    row,
    ["schemaVersion", "agentDefinitionId", "agentReleaseId", "state", "generatedAt", "revision", "operationalChips", "tasteChips", "loadout", "scheduledNextSession", "recommendations", "pendingAttachApprovals"],
    "ontology projection",
  );
  if (row.schemaVersion !== 1) throw new ContractError("Unsupported ontology projection schema.");
  const operationalChips = array(row.operationalChips, "operationalChips", 64)
    .map((item) => decodeChip(item, "operational"));
  const tasteChips = array(row.tasteChips, "tasteChips", 64)
    .map((item) => decodeChip(item, "taste"));
  const chipIds = new Set<string>();
  for (const chip of [...operationalChips, ...tasteChips]) {
    if (chipIds.has(chip.chipId)) throw new ContractError("Ontology chip id is duplicated.");
    chipIds.add(chip.chipId);
  }
  const loadoutRaw = record(row.loadout, "loadout");
  onlyKeys(loadoutRaw, ["revision", "state", "entries", "changedAt"], "loadout");
  const loadoutEntries = array(loadoutRaw.entries, "loadout.entries", 2).map(decodeEntry);
  uniqueEntries(loadoutEntries, "loadout");
  const pendingAttachApprovals = array(row.pendingAttachApprovals, "pendingAttachApprovals", 16)
    .map((item) => {
      const pending = record(item, "pending approval");
      onlyKeys(pending, ["approvalId", "recommendationId", "expectedLoadoutRevision", "selectedChips", "createdAt", "expiresAt"], "pending approval");
      const selectedChips = array(pending.selectedChips, "selectedChips", 2).map(decodeEntry);
      if (selectedChips.length === 0) throw new ContractError("Pending approval must select an exact release.");
      uniqueEntries(selectedChips, "pending approval");
      if (selectedChips.some((entry) => entry.state !== "pending-approval")) {
        throw new ContractError("Pending approval entries must be pending-approval.");
      }
      const createdAt = iso(pending.createdAt, "createdAt");
      const expiresAt = iso(pending.expiresAt, "expiresAt");
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new ContractError("Approval expiry is invalid.");
      return {
        approvalId: safeRef(pending.approvalId, "approvalId"),
        recommendationId: safeRef(pending.recommendationId, "recommendationId"),
        expectedLoadoutRevision: revision(pending.expectedLoadoutRevision, "expectedLoadoutRevision"),
        selectedChips,
        createdAt,
        expiresAt,
      };
    });
  return {
    schemaVersion: 1,
    agentDefinitionId: safeRef(row.agentDefinitionId, "agentDefinitionId"),
    agentReleaseId: safeRef(row.agentReleaseId, "agentReleaseId"),
    state: enumValue(
      row.state,
      ["live", "offline", "stale", "conflict", "revoked"] as const,
      "state",
    ) as MobileBridgeOntologyProjectionState,
    generatedAt: iso(row.generatedAt, "generatedAt"),
    revision: revision(row.revision, "revision"),
    operationalChips,
    tasteChips,
    loadout: {
      revision: revision(loadoutRaw.revision, "loadout.revision"),
      state: enumValue(
        loadoutRaw.state,
        ["empty", "ready", "pending-approval", "applying", "offline", "stale", "conflict", "revoked"] as const,
        "loadout.state",
      ) as MobileBridgeOntologyLoadoutState,
      entries: loadoutEntries,
      ...(loadoutRaw.changedAt === undefined ? {} : { changedAt: iso(loadoutRaw.changedAt, "changedAt") }),
    },
    ...(row.scheduledNextSession === undefined
      ? {}
      : { scheduledNextSession: decodeScheduledLoadout(row.scheduledNextSession) }),
    recommendations: array(row.recommendations, "recommendations", 16).map(decodeRecommendation),
    pendingAttachApprovals,
  };
}

function decodeReceipt(value: unknown): MobileBridgeOntologyAttachReceiptDto {
  const row = record(value, "attach receipt");
  onlyKeys(row, ["schemaVersion", "approvalId", "outcome", "loadoutState", "loadoutRevision", "acknowledgedAt", "message"], "attach receipt");
  if (row.schemaVersion !== 1) throw new ContractError("Unsupported attach receipt schema.");
  return {
    schemaVersion: 1,
    approvalId: safeRef(row.approvalId, "approvalId"),
    outcome: enumValue(
      row.outcome,
      ["accepted", "denied", "already-resolved", "offline", "stale", "conflict", "revoked", "outcome-unknown"] as const,
      "outcome",
    ),
    loadoutState: enumValue(
      row.loadoutState,
      ["empty", "ready", "pending-approval", "applying", "offline", "stale", "conflict", "revoked"] as const,
      "loadoutState",
    ),
    ...(row.loadoutRevision === undefined ? {} : { loadoutRevision: revision(row.loadoutRevision, "loadoutRevision") }),
    acknowledgedAt: iso(row.acknowledgedAt, "acknowledgedAt"),
    message: safeText(row.message, "message", 512),
  };
}

function bindingKey(binding: ExactAgentReleaseBinding): string {
  return `${binding.agentDefinitionId}\u0000${binding.agentReleaseId}`;
}

function normalizeBindings(bindings: readonly ExactAgentReleaseBinding[]): ExactAgentReleaseBinding[] {
  if (bindings.length > MAX_BINDINGS) throw new Error(`Ontology projection is limited to ${MAX_BINDINGS} exact bindings.`);
  const unique = new Map<string, ExactAgentReleaseBinding>();
  for (const binding of bindings) {
    const normalized = {
      agentDefinitionId: safeRef(binding.agentDefinitionId, "agentDefinitionId"),
      agentReleaseId: safeRef(binding.agentReleaseId, "agentReleaseId"),
    };
    unique.set(bindingKey(normalized), normalized);
  }
  return [...unique.values()];
}

function safeBaseUrl(raw: string, allowLoopback: boolean): string {
  const url = new URL(raw);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  const official = url.protocol === "https:" && url.hostname.toLowerCase() === "agentlas.cloud";
  if (
    (!official && !(allowLoopback && loopback && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    (Boolean(url.port) && !loopback)
  ) {
    throw new Error("Ontology Hub origin is not approved.");
  }
  return `${url.protocol}//${url.host}`;
}

async function responseJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new ContractError("Ontology response is too large.");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new ContractError("Ontology response is too large.");
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { throw new ContractError("Ontology response is malformed JSON."); }
}

function fallbackReceipt(
  input: OntologyAttachResolveInput,
  outcome: MobileBridgeOntologyAttachReceiptDto["outcome"],
  loadoutState: MobileBridgeOntologyLoadoutState,
  message: string,
  now: Date,
): MobileBridgeOntologyAttachReceiptDto {
  return {
    schemaVersion: 1,
    approvalId: input.approvalId,
    outcome,
    loadoutState,
    acknowledgedAt: now.toISOString(),
    message,
  };
}

export class OntologyHubClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly cookieProvider: () => string | null;
  private readonly timeoutMs: number;
  private readonly cacheFile?: string;
  private readonly now: () => Date;
  private readonly cache = new Map<string, MobileBridgeOntologyProjectionDto>();
  private availabilityValue: OntologyHubAvailability = "unknown";
  private lastFingerprint = "";
  private lastQueryAt = 0;
  private lastResult: OntologyHubProjectionResult | null = null;
  private readonly inFlight = new Map<string, Promise<OntologyHubProjectionResult>>();

  constructor(options: OntologyHubClientOptions = {}) {
    this.baseUrl = safeBaseUrl(
      options.baseUrl ?? process.env.AGENTLAS_WEB_BASE_URL ?? "https://agentlas.cloud",
      options.allowLoopback === true || Boolean(options.fetch),
    );
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.cookieProvider = options.cookieProvider ?? (() => getSessionCookieHeader());
    this.timeoutMs = Math.max(500, Math.min(15_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    this.cacheFile = options.cacheFile;
    this.now = options.now ?? (() => new Date());
    this.loadCache();
  }

  get availability(): OntologyHubAvailability { return this.availabilityValue; }

  async query(bindingsInput: readonly ExactAgentReleaseBinding[], force = false): Promise<OntologyHubProjectionResult> {
    const bindings = normalizeBindings(bindingsInput);
    if (bindings.length === 0) {
      return { supported: false, status: "endpoint-absent", projections: [] };
    }
    const fingerprint = JSON.stringify(bindings);
    const nowMs = this.now().getTime();
    if (!force && this.lastResult && this.lastFingerprint === fingerprint && nowMs - this.lastQueryAt < QUERY_FRESH_MS) {
      return this.lastResult;
    }
    const existing = this.inFlight.get(fingerprint);
    if (existing) return existing;
    const flight = this.performQuery(bindings);
    this.inFlight.set(fingerprint, flight);
    try {
      const result = await flight;
      this.lastFingerprint = fingerprint;
      this.lastQueryAt = nowMs;
      this.lastResult = result;
      return result;
    } finally {
      if (this.inFlight.get(fingerprint) === flight) this.inFlight.delete(fingerprint);
    }
  }

  async resolveAttach(
    input: OntologyAttachResolveInput,
    idempotencyKey: string,
  ): Promise<MobileBridgeOntologyAttachReceiptDto> {
    const now = this.now();
    validateAttachInput(input);
    if (!SAFE_REF_RE.test(idempotencyKey) || idempotencyKey.length > 160) {
      return fallbackReceipt(input, "conflict", "conflict", "The idempotency key is invalid.", now);
    }
    const key = bindingKey(input);
    const current = this.cache.get(key);
    if (!current) return fallbackReceipt(input, "stale", "stale", "Refresh the exact agent release before resolving this request.", now);
    if (current.state !== "live") {
      const outcome = current.state === "revoked" ? "revoked" : current.state === "offline" ? "offline" : current.state;
      return fallbackReceipt(input, outcome, current.state, "This projection is not live.", now);
    }
    const pending = current.pendingAttachApprovals.find((item) => item.approvalId === input.approvalId);
    if (!pending) return fallbackReceipt(input, "already-resolved", current.loadout.state, "This approval is no longer pending.", now);
    if (
      current.revision !== input.expectedProjectionRevision ||
      current.loadout.revision !== input.expectedLoadoutRevision ||
      pending.expectedLoadoutRevision !== input.expectedLoadoutRevision ||
      pending.recommendationId !== input.recommendationId ||
      !sameEntries(input.decision === "approve" ? pending.selectedChips : [], input.selectedChips)
    ) {
      return fallbackReceipt(input, "conflict", "conflict", "Projection, loadout, or exact chip releases changed.", now);
    }
    const cookie = this.cookieProvider();
    if (!cookie || !/^agentlas_session=[^;\r\n]{8,}$/.test(cookie)) {
      return fallbackReceipt(input, "offline", "offline", "Agentlas Hub sign-in is unavailable.", now);
    }
    let response: Response;
    try {
      response = await this.post(ATTACH_RESOLVE_PATH, input, cookie, { "idempotency-key": idempotencyKey });
    } catch {
      return fallbackReceipt(input, "outcome-unknown", "conflict", "The acknowledgement was lost. Refresh before retrying.", now);
    }
    if ([404, 405, 501].includes(response.status)) {
      this.availabilityValue = "absent";
      return fallbackReceipt(input, "offline", "offline", "Ontology attachment is not available on this Hub version.", now);
    }
    if (response.status === 401 || response.status === 403) {
      this.availabilityValue = "available";
      return fallbackReceipt(input, "offline", "offline", "Agentlas Hub authentication is unavailable.", now);
    }
    let raw: unknown;
    try { raw = await responseJson(response); } catch {
      return fallbackReceipt(input, "outcome-unknown", "conflict", "Hub returned an invalid acknowledgement. Refresh before retrying.", now);
    }
    if (!response.ok) {
      try {
        const receipt = decodeReceipt(raw);
        return receipt.approvalId === input.approvalId
          ? receipt
          : fallbackReceipt(input, "outcome-unknown", "conflict", "Hub acknowledgement identity changed.", now);
      } catch {
        return fallbackReceipt(
          input,
          response.status === 409 || response.status === 412 ? "conflict" : "outcome-unknown",
          "conflict",
          "Hub did not return an authenticated attachment receipt.",
          now,
        );
      }
    }
    try {
      const receipt = decodeReceipt(raw);
      if (receipt.approvalId !== input.approvalId) throw new ContractError("Approval receipt identity mismatch.");
      this.availabilityValue = "available";
      this.lastQueryAt = 0;
      return receipt;
    } catch {
      return fallbackReceipt(input, "outcome-unknown", "conflict", "Hub acknowledgement could not be verified.", now);
    }
  }

  async resolveRuntimeSession(input: {
    agentDefinitionId: string;
    agentReleaseId: string;
    sessionRef: string;
  }): Promise<DesktopOntologyRuntimeSessionDto> {
    const binding = normalizeBindings([input])[0];
    if (!binding || !/^desktop-session-[a-f0-9]{48}$/.test(input.sessionRef)) {
      throw new ContractError("Desktop runtime session request is invalid.");
    }
    const cookie = this.cookieProvider();
    if (!cookie || !/^agentlas_session=[^;\r\n]{8,}$/.test(cookie)) {
      throw new ContractError("Agentlas Hub sign-in is unavailable.");
    }
    const response = await this.post(DESKTOP_RUNTIME_SESSION_PATH, {
      schemaVersion: 1,
      ...binding,
      sessionRef: input.sessionRef,
    }, cookie);
    if (!response.ok) throw new ContractError("Desktop runtime session is unavailable.");
    const decoded = decodeDesktopOntologyRuntimeSession(await responseJson(response));
    if (decoded.agentDefinitionId !== binding.agentDefinitionId || decoded.agentReleaseId !== binding.agentReleaseId) {
      throw new ContractError("Desktop runtime session exact binding changed.");
    }
    this.availabilityValue = "available";
    this.lastQueryAt = 0;
    return decoded;
  }

  private async performQuery(bindings: ExactAgentReleaseBinding[]): Promise<OntologyHubProjectionResult> {
    const keys = new Set(bindings.map(bindingKey));
    const cached = (state: "offline" | "stale") => bindings.flatMap((binding) => {
      const projection = this.cache.get(bindingKey(binding));
      return projection ? [{ ...projection, state }] : [];
    });
    const cookie = this.cookieProvider();
    if (!cookie || !/^agentlas_session=[^;\r\n]{8,}$/.test(cookie)) {
      const projections = cached("offline");
      return {
        supported: this.availabilityValue === "available" || projections.length > 0,
        status: "auth-unavailable",
        projections,
      };
    }
    let response: Response;
    try {
      response = await this.post(PROJECTION_QUERY_PATH, { schemaVersion: 1, bindings }, cookie);
    } catch {
      const projections = cached("offline");
      return {
        supported: this.availabilityValue === "available" || projections.length > 0,
        status: "offline",
        projections,
      };
    }
    if ([404, 405, 501].includes(response.status)) {
      this.availabilityValue = "absent";
      return { supported: false, status: "endpoint-absent", projections: [] };
    }
    if (response.status === 401 || response.status === 403) {
      this.availabilityValue = "available";
      return { supported: true, status: "auth-unavailable", projections: cached("offline") };
    }
    if (!response.ok) {
      const projections = cached("offline");
      return {
        supported: this.availabilityValue === "available" || projections.length > 0,
        status: "offline",
        projections,
      };
    }
    let raw: unknown;
    try { raw = await responseJson(response); } catch {
      const projections = cached("stale");
      return {
        supported: this.availabilityValue === "available" || projections.length > 0,
        status: "stale",
        projections,
      };
    }
    let rows: unknown[];
    try {
      const root = record(raw, "projection response");
      onlyKeys(root, ["schemaVersion", "projections"], "projection response");
      if (root.schemaVersion !== 1) throw new ContractError("Unsupported projection response schema.");
      rows = array(root.projections, "projections", MAX_BINDINGS);
    } catch {
      const projections = cached("stale");
      return {
        supported: this.availabilityValue === "available" || projections.length > 0,
        status: "stale",
        projections,
      };
    }
    const decoded = new Map<string, MobileBridgeOntologyProjectionDto>();
    const invalidKeys = new Set<string>();
    for (const row of rows) {
      const hint = projectionIdentityHint(row);
      try {
        const projection = decodeProjection(row);
        const key = bindingKey(projection);
        if (!keys.has(key) || decoded.has(key)) throw new ContractError("Projection identity was not requested or was duplicated.");
        decoded.set(key, projection);
      } catch {
        if (hint && keys.has(hint)) invalidKeys.add(hint);
      }
    }
    const projections: MobileBridgeOntologyProjectionDto[] = [];
    for (const binding of bindings) {
      const key = bindingKey(binding);
      const valid = decoded.get(key);
      if (valid) {
        this.cache.set(key, valid);
        projections.push(valid);
      } else {
        const prior = this.cache.get(key);
        if (prior) projections.push({ ...prior, state: "stale" });
        // A successful response is required to contain one complete node per
        // binding. Missing and malformed nodes are partial, never an implicit
        // delete. Hub can represent an empty chip set with a valid empty node.
        invalidKeys.add(key);
      }
    }
    this.availabilityValue = "available";
    this.trimAndSaveCache();
    return {
      supported: true,
      status: invalidKeys.size > 0 ? "stale" : "live",
      projections,
    };
  }

  private async post(
    pathname: string,
    body: unknown,
    cookie: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetcher(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          cookie,
          origin: new URL(this.baseUrl).origin,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private loadCache(): void {
    if (!this.cacheFile) return;
    try {
      const raw = fs.readFileSync(this.cacheFile, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) return;
      const root = record(JSON.parse(raw) as unknown, "ontology cache");
      onlyKeys(root, ["schemaVersion", "projections"], "ontology cache");
      if (root.schemaVersion !== 1) return;
      for (const item of array(root.projections, "cache projections", MAX_CACHE_ENTRIES)) {
        try {
          const projection = decodeProjection(item);
          this.cache.set(bindingKey(projection), projection);
        } catch {}
      }
      if (this.cache.size > 0) this.availabilityValue = "available";
    } catch {}
  }

  private trimAndSaveCache(): void {
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    if (!this.cacheFile) return;
    const parent = path.dirname(this.cacheFile);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temp = path.join(parent, `.${path.basename(this.cacheFile)}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(
        temp,
        JSON.stringify({ schemaVersion: 1, projections: [...this.cache.values()] }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      fs.renameSync(temp, this.cacheFile);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

function projectionIdentityHint(value: unknown): string | null {
  try {
    const row = record(value, "projection");
    return bindingKey({
      agentDefinitionId: safeRef(row.agentDefinitionId, "agentDefinitionId"),
      agentReleaseId: safeRef(row.agentReleaseId, "agentReleaseId"),
    });
  } catch { return null; }
}

function validateAttachInput(input: OntologyAttachResolveInput): void {
  if (input.schemaVersion !== 1) throw new ContractError("Unsupported attach schema.");
  for (const [label, value] of Object.entries({
    approvalId: input.approvalId,
    recommendationId: input.recommendationId,
    agentDefinitionId: input.agentDefinitionId,
    agentReleaseId: input.agentReleaseId,
  })) safeRef(value, label);
  revision(input.expectedProjectionRevision, "expectedProjectionRevision");
  revision(input.expectedLoadoutRevision, "expectedLoadoutRevision");
  if (input.decision !== "approve" && input.decision !== "deny") throw new ContractError("Unsupported attach decision.");
  if (!Array.isArray(input.selectedChips) || input.selectedChips.length > 2) throw new ContractError("selectedChips is invalid.");
  const decoded = input.selectedChips.map(decodeEntry);
  uniqueEntries(decoded, "selectedChips");
  if (decoded.some((entry) => entry.state !== "pending-approval")) {
    throw new ContractError("Attach decisions require pending-approval entries.");
  }
  if (input.decision === "approve" && decoded.length === 0) throw new ContractError("Approve requires exact releases.");
  if (input.decision === "deny" && decoded.length !== 0) throw new ContractError("Deny cannot select releases.");
}

export function parseOntologyAttachResolveInput(value: unknown): OntologyAttachResolveInput {
  const row = record(value, "attach request");
  onlyKeys(
    row,
    [
      "schemaVersion",
      "approvalId",
      "recommendationId",
      "agentDefinitionId",
      "agentReleaseId",
      "expectedProjectionRevision",
      "expectedLoadoutRevision",
      "decision",
      "selectedChips",
    ],
    "attach request",
  );
  const parsed: OntologyAttachResolveInput = {
    schemaVersion: row.schemaVersion === 1 ? 1 : (() => { throw new ContractError("Unsupported attach schema."); })(),
    approvalId: safeRef(row.approvalId, "approvalId"),
    recommendationId: safeRef(row.recommendationId, "recommendationId"),
    agentDefinitionId: safeRef(row.agentDefinitionId, "agentDefinitionId"),
    agentReleaseId: safeRef(row.agentReleaseId, "agentReleaseId"),
    expectedProjectionRevision: revision(row.expectedProjectionRevision, "expectedProjectionRevision"),
    expectedLoadoutRevision: revision(row.expectedLoadoutRevision, "expectedLoadoutRevision"),
    decision: enumValue(row.decision, ["approve", "deny"] as const, "decision"),
    selectedChips: array(row.selectedChips, "selectedChips", 2).map(decodeEntry),
  };
  validateAttachInput(parsed);
  return parsed;
}

function sameEntries(left: readonly MobileBridgeOntologyLoadoutEntryDto[], right: readonly MobileBridgeOntologyLoadoutEntryDto[]): boolean {
  const key = (entry: MobileBridgeOntologyLoadoutEntryDto) => `${entry.kind}:${entry.chipId}:${entry.releaseId}`;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function createDefaultOntologyHubClient(userDataPath: string): OntologyHubClient {
  return new OntologyHubClient({
    cacheFile: path.join(userDataPath, "mobile-bridge", "ontology-projections-v1.json"),
  });
}

const defaultOntologyHubClients = new Map<string, OntologyHubClient>();

/**
 * One authenticated, contract-validating Hub projection client per Desktop
 * userData root. Mobile, My Agents, and the Terminal receipt writer must share
 * one cache owner instead of racing separate writers against the same 0600
 * projection file.
 */
export function getDefaultOntologyHubClient(userDataPath: string): OntologyHubClient {
  const key = path.resolve(userDataPath);
  const existing = defaultOntologyHubClients.get(key);
  if (existing) return existing;
  const client = createDefaultOntologyHubClient(key);
  defaultOntologyHubClients.set(key, client);
  return client;
}

export const ONTOLOGY_MOBILE_HUB_CONTRACT = {
  projectionQueryPath: PROJECTION_QUERY_PATH,
  attachResolvePath: ATTACH_RESOLVE_PATH,
  maxBindings: MAX_BINDINGS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
} as const;
