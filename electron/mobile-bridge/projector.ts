import { Buffer } from "node:buffer";
import path from "node:path";

import { listInstalledAgents } from "../mcp/registry";
import { detectRuntimes } from "../runtime/detect";
import {
  getAutomationLiveRunState,
  listAutomations,
  listRunHistory,
} from "../store/automations";
import {
  getChat,
  getChatWorkingFolder,
  listChatMessages,
  listRecentChats,
} from "../store/chats";
import {
  ensureCanonicalTaskForChat,
  findCanonicalTaskForChat,
  getCanonicalTask,
  listPairingVerificationTasks,
} from "../store/tasks";
import { listFirms } from "../store/firms";
import { listProjects } from "../store/projects";
import { isOneInvocationChat } from "../store/run-events";
import { listPendingConfirmations } from "../confirm";
import { listEnvKeys } from "../secrets/vault";
import { listInstalledAgentHubBindings } from "../ontology/hub-bindings";
import { getUsageSnapshot } from "../usage";
import { getOneBriefingSnapshot } from "../one/briefing";
import { getOneProfile } from "../store/one-profile";
import { getProjectTimelineSnapshot } from "../memory/project-timeline";
import {
  PROJECT_SITEMAP_MAX_BYTES,
  readActivatedProjectMemoryJson,
} from "../memory/safe-project-read";
import { SITEMAP_FILE } from "../architecture/manifest";
import { createOneTaskProjectionRuntime } from "../one/task-projection";
import type {
  Automation,
  CanonicalTask,
  Chat,
  ChatHistoryEntry,
  PendingConfirmation,
  RuntimeStatus,
  UsageSnapshot,
} from "../../shared/types";
import {
  isOneProactiveBriefing,
  type OneBriefingSnapshot,
} from "../../shared/one-briefing";
import {
  projectOneProfileForDevice,
  type OneProfile,
} from "../../shared/one-profile";
import {
  isOneDecisionViewV1,
  isPendingConfirmationSnoozed,
  normalizeOneDecision,
} from "../../shared/one-decision";
import { oneDecisionJudgedReaders, prejudgeOneDecisions } from "../one/judged-decision";
import {
  isOneValueClosureState,
  type OneValueClosureState,
} from "../../shared/one-value-closure";
import {
  isOneImprovementProofState,
  type OneImprovementProofState,
} from "../../shared/one-improvement-proof";
import { isOneExperienceReuseState } from "../../shared/one-experience-reuse";
import { getOneValueClosureState } from "../one/value-closure";
import { getOneImprovementProofState } from "../one/improvement-proof";
import { reconcileOneImprovementProofs } from "../one/improvement-proof-producer";
import { getOneExperienceReuseState } from "../one/experience-reuse";
import { projectOneMobileEcosystemSuggestions } from "../one/mobile-suggestions";

import type { MobileBridgeHostIdentity } from "./pairing";

import {
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  type MobileBridgeAgentDto,
  type MobileBridgeAutomationDto,
  type MobileBridgeBrowserApprovalDto,
  type MobileBridgeChatDto,
  type MobileBridgeChatMessageDto,
  type MobileBridgeFirmDto,
  type MobileBridgeHostDto,
  type MobileBridgePendingConfirmationDto,
  type MobileBridgeOntologyProjectionDto,
  type MobileBridgeOneBriefingDto,
  type MobileBridgeOneDecisionDto,
  type MobileBridgeOneImprovementMetricDto,
  type MobileBridgeOneImprovementProofDto,
  type MobileBridgeOneExperienceReuseDto,
  type MobileBridgeOneValueClosureDto,
  type MobileBridgeOneProfileDto,
  type MobileBridgeProjectDto,
  type MobileBridgeRuntimeDto,
  type MobileBridgeSnapshot,
  type MobileBridgeUsageProviderDto,
  isMobileBridgeOneImprovementProofDto,
  isMobileBridgeOneExperienceReuseDto,
  isMobileBridgeOneValueClosureDto,
} from "../../shared/mobile-bridge";
import {
  MOBILE_BRIDGE_DISPLAY_TEXT_BYTES,
  MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES,
  MOBILE_BRIDGE_TRANSCRIPT_TEXT_BYTES,
  mobileBridgeJsonBytes,
  sanitizeMobileBridgeText,
  stripMobileBridgeControlFences,
} from "./sanitize";

export interface MobileBridgeProjectionOptions {
  /** DESKTOP_MOBILE_BRIDGE: Loaded from userData/mobile-bridge/identity.json. */
  hostIdentity: MobileBridgeHostIdentity;
  displayName: string;
  appVersion: string;
  activeChatIds?: readonly string[];
  includeMessagesForChatIds?: readonly string[];
  maxMessagesPerChat?: number;
  pendingBrowserApprovals?: readonly MobileBridgeBrowserApprovalDto[];
  now?: Date;
  ontology?: {
    supported: boolean;
    projections: readonly MobileBridgeOntologyProjectionDto[];
  };
}

function displayText(value: string, maxBytes = MOBILE_BRIDGE_DISPLAY_TEXT_BYTES): string {
  return sanitizeMobileBridgeText(value, maxBytes);
}

function optionalDisplayText(
  value: string | null | undefined,
  maxBytes = MOBILE_BRIDGE_DISPLAY_TEXT_BYTES,
): string | null {
  return typeof value === "string" ? displayText(value, maxBytes) : null;
}

const MOBILE_BRIDGE_ONE_DECISION_LIMIT = 20;
const MOBILE_BRIDGE_ONE_DECISION_BYTES = 128 * 1024;
const MOBILE_BRIDGE_ONE_VALUE_CLOSURE_LIMIT = 20;
const MOBILE_BRIDGE_ONE_VALUE_CLOSURE_BYTES = 128 * 1024;
const MOBILE_BRIDGE_ONE_IMPROVEMENT_PROOF_LIMIT = 20;
const MOBILE_BRIDGE_ONE_IMPROVEMENT_PROOF_BYTES = 128 * 1024;
const MOBILE_BRIDGE_ONE_EXPERIENCE_REUSE_LIMIT = 20;
const MOBILE_BRIDGE_ONE_EXPERIENCE_REUSE_BYTES = 64 * 1024;

function exactRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Validate the complete host/Task/View binding, not only the nested Decision.
 * This stays exported so the wire-contract test can prove that additive fields
 * do not silently become executable authority.
 */
export function isMobileBridgeOneDecisionDto(
  value: unknown,
): value is MobileBridgeOneDecisionDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactRecordKeys(row, ["authoritativeHostRef", "canonicalTaskVersion", "view"])) return false;
  if (typeof row.authoritativeHostRef !== "string" || !/^host_[a-f0-9]{32}$/.test(row.authoritativeHostRef)) {
    return false;
  }
  if (!Number.isSafeInteger(row.canonicalTaskVersion) || Number(row.canonicalTaskVersion) < 1) return false;
  if (!isOneDecisionViewV1(row.view) || row.view.taskId === null) return false;
  const expectedEvidence = new Map([
    ["source_message", row.view.decisionId],
    ["task", row.view.taskId],
    ["requested_at", row.view.createdAt],
  ]);
  if (row.view.evidence.length !== expectedEvidence.size) return false;
  return row.view.evidence.every((item) => expectedEvidence.get(item.kind) === item.ref)
    && new Set(row.view.evidence.map((item) => item.kind)).size === expectedEvidence.size;
}

function deviceSafeOneDecision(value: MobileBridgeOneDecisionDto): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      // Rewriting a field would no longer be the exact Main Decision. Omit the
      // entire row instead of sending a sanitized-but-semantically-different approval.
      if (sanitizeMobileBridgeText(current, Buffer.byteLength(current, "utf8") + 64) !== current) return false;
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current && typeof current === "object") stack.push(...Object.values(current));
  }
  return true;
}

/**
 * Project the explicit-user-approved subset only. A second sanitizer is kept
 * at the bridge boundary even though the profile projection already rejects
 * paths and secrets. Approved principle text that changes at this boundary is
 * omitted rather than rewritten into a different approved instruction.
 */
export function projectMobileBridgeOneProfile(profile: OneProfile): MobileBridgeOneProfileDto {
  const source = projectOneProfileForDevice(profile);
  let additionallyOmitted = 0;
  const operatingPrinciples = source.operatingPrinciples.flatMap((principle) => {
    const content = displayText(principle.content, 2 * 1024);
    if (content !== principle.content) {
      additionallyOmitted += 1;
      return [];
    }
    return [{
      id: principle.id,
      content,
      scope: principle.scope,
      approvalSource: principle.approvalSource,
      approvedAt: principle.approvedAt,
      updatedAt: principle.updatedAt,
    }];
  });
  return {
    contractVersion: source.contractVersion,
    oneId: source.oneId,
    version: source.version,
    displayName: displayText(source.displayName, 512),
    role: displayText(source.role, 512),
    preferredLocale: source.preferredLocale,
    timeZone: source.timeZone === null ? null : displayText(source.timeZone, 512),
    updatedAt: source.updatedAt,
    operatingPrinciples,
    omittedOperatingPrincipleCount:
      source.omittedOperatingPrincipleCount + additionallyOmitted,
  };
}

/**
 * Mobile receives Main's already-selected candidate, not detector inputs. The
 * projection deliberately omits discovery prose, impact prose, raw evidence,
 * scheduler errors, and every channel except the implemented in-app surface.
 */
export function projectMobileBridgeOneBriefing(
  source: OneBriefingSnapshot,
): MobileBridgeOneBriefingDto {
  const candidate = source.candidate;
  if (
    source.contractVersion !== "1.0.0" ||
    !Number.isFinite(Date.parse(source.evaluatedAt)) ||
    !Number.isFinite(Date.parse(source.preferences.updatedAt)) ||
    !["important_only", "daily", "weekdays", "weekly"].includes(source.preferences.cadence) ||
    typeof source.preferences.quietHours.enabled !== "boolean" ||
    !Number.isInteger(source.preferences.quietHours.startHour) ||
    !Number.isInteger(source.preferences.quietHours.endHour) ||
    source.preferences.quietHours.startHour < 0 ||
    source.preferences.quietHours.startHour > 23 ||
    source.preferences.quietHours.endHour < 0 ||
    source.preferences.quietHours.endHour > 23 ||
    (candidate !== null && (
      !isOneProactiveBriefing(candidate) ||
      candidate.source.refId !== candidate.preparedAction.targetId ||
      (candidate.source.kind === "project_folder" && candidate.preparedAction.kind !== "open_project") ||
      (candidate.source.kind === "automation_run" && candidate.preparedAction.kind !== "open_automation") ||
      (candidate.source.kind === "canonical_task" && candidate.preparedAction.kind !== "open_task") ||
      (candidate.reasonCode.startsWith("project_folder_") && candidate.source.kind !== "project_folder") ||
      (candidate.reasonCode === "project_deadline_conflict" && candidate.source.kind !== "project_folder") ||
      (candidate.reasonCode.startsWith("automation_") && candidate.source.kind !== "automation_run") ||
      (candidate.reasonCode.startsWith("task_") && candidate.source.kind !== "canonical_task")
    ))
  ) {
    throw new TypeError("Invalid One Briefing snapshot");
  }
  return {
    contractVersion: source.contractVersion,
    evaluatedAt: source.evaluatedAt,
    preferences: {
      cadence: source.preferences.cadence,
      channels: ["in_app"],
      quietHours: {
        enabled: source.preferences.quietHours.enabled,
        startHour: source.preferences.quietHours.startHour,
        endHour: source.preferences.quietHours.endHour,
      },
      updatedAt: source.preferences.updatedAt,
    },
    candidate: candidate === null ? null : {
      contractVersion: candidate.contractVersion,
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      reasonCode: candidate.reasonCode,
      severity: candidate.severity,
      source: {
        kind: candidate.source.kind,
        refId: candidate.source.refId,
        label: displayText(candidate.source.label, 512),
      },
      detectedAt: candidate.detectedAt,
      expiresAt: candidate.expiresAt,
      confidence: candidate.confidence.level,
      preparedAction: {
        kind: candidate.preparedAction.kind,
        targetId: candidate.preparedAction.targetId,
        label: displayText(candidate.preparedAction.label, 512),
        executionStarted: false,
      },
    },
  };
}

function workingFolderName(chatId: string): string | null {
  const folder = getChatWorkingFolder(chatId);
  if (!folder) return null;
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1);
  return name ? displayText(name, 512) : null;
}

function platform(): MobileBridgeHostDto["platform"] {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function hostDto(options: MobileBridgeProjectionOptions): MobileBridgeHostDto {
  return {
    id: options.hostIdentity.hostId,
    displayName: displayText(options.displayName, 512),
    platform: platform(),
    appVersion: options.appVersion,
    protocolVersion: MOBILE_BRIDGE_PROTOCOL_VERSION,
    online: true,
    capabilities: [
      "agents",
      "firms",
      "projects",
      "chats",
      "chat-stream",
      "steering",
      "composer-modes",
      "attachments",
      "chat-runtime-selection",
      "hub-borrow",
      "route-preview",
      "confirmations",
      "one-invocation-v1",
      "one-decisions-v1",
      "one-value-closures-v1",
      "one-experience-reuse-v1",
      "one-improvement-proofs-v1",
      "one-ecosystem-suggestions-v1",
      "browser-approvals",
      "automations",
      "usage",
      // v1 cloud-actions extension: registered upload preview/save,
      // server-side cloud delete, and remote Hephaestus builds.
      "cloud-agent-actions",
      "remote-build",
      ...(options.ontology?.supported ? ["ontology-chips"] : []),
    ],
  };
}

function agentsDto(presentEnvKeys: ReadonlySet<string>): MobileBridgeAgentDto[] {
  const bindingByAgentId = new Map(
    listInstalledAgentHubBindings(64).map((binding) => [binding.installedAgentId, binding] as const),
  );
  return listInstalledAgents().map((agent) => {
    const binding = bindingByAgentId.get(agent.id);
    return {
      id: agent.id,
      slug: agent.slug,
      name: displayText(agent.name, 512),
      nameEn: displayText(agent.nameEn, 512),
      tagline: displayText(agent.tagline, 2_048),
      taglineEn: displayText(agent.taglineEn, 2_048),
      trustGrade: agent.trustGrade,
      installedAt: agent.installedAt,
      tone: displayText(agent.tone, 256),
      runtimeLabel: optionalDisplayText(agent.runtimeLabel, 512),
      assetSource: optionalDisplayText(agent.assetSource, 1_024),
      source: binding?.source === "hub-install" || agent.assetSource === "hub"
        ? "hub"
        : binding?.source === "agent-cloud-restore" || agent.assetSource === "agent-cloud"
          ? "agent-cloud"
          : "local",
      toolLabels: [...new Set(agent.mcpServers.map((item) => displayText(item, 120)).filter(Boolean))].slice(0, 16),
      kind: agent.kind === "team" ? "team" : "agent",
      visibility: agent.visibility ?? "visible",
      // DESKTOP_MOBILE_BRIDGE: Only a boolean crosses the bridge. env key names,
      // hints, values, MCP config, prompts, package hashes, and local paths do not.
      requiresSetup: agent.envRequirements.some(
        (requirement) => requirement.required && !presentEnvKeys.has(requirement.key),
      ),
      ...(binding
        ? {
            agentDefinitionId: binding.agentDefinitionId,
            agentReleaseId: binding.agentReleaseId,
          }
        : {}),
    };
  });
}

function firmsDto(): MobileBridgeFirmDto[] {
  return listFirms().map((firm) => ({
    id: firm.id,
    slug: firm.slug,
    name: displayText(firm.name, 512),
    nameEn: displayText(firm.nameEn, 512),
    tagline: displayText(firm.tagline, 2_048),
    taglineEn: displayText(firm.taglineEn, 2_048),
    ceoAgentId: firm.ceoAgentId,
    orgChart: firm.orgChart.map((node) => ({
      agentId: node.agentId,
      agentSlug: node.agentSlug,
      role: displayText(node.role, 512),
      reportsTo: node.reportsTo,
    })),
    installedAt: firm.installedAt,
  }));
}

function projectSourceLabel(project: ReturnType<typeof listProjects>[number]): string | null {
  if (project.sourceType === "local") {
    return project.folderPath ? displayText(path.basename(project.folderPath), 512) : null;
  }
  if (!project.sourceRef?.trim()) return null;
  if (project.sourceType === "sample") return displayText(project.sourceRef, 512);
  try {
    const repository = new URL(project.sourceRef);
    return displayText(`${repository.host}${repository.pathname}`.replace(/\/$/, ""), 1_024);
  } catch {
    return null;
  }
}

function projectFilesDto(project: ReturnType<typeof listProjects>[number]): MobileBridgeProjectDto["files"] {
  if (!project.folderPath) return [];
  const sitemap = readActivatedProjectMemoryJson<{ nodes?: unknown[] }>(
    project.folderPath,
    SITEMAP_FILE,
    PROJECT_SITEMAP_MAX_BYTES,
  );
  if (!Array.isArray(sitemap?.nodes)) return [];
  const files: MobileBridgeProjectDto["files"] = [];
  for (const candidate of sitemap.nodes) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const node = candidate as Record<string, unknown>;
    if (node.kind !== "file" && node.kind !== "directory") continue;
    if (typeof node.relative_path !== "string") continue;
    const relativePath = node.relative_path.trim().replaceAll("\\", "/");
    if (!relativePath || relativePath === ".agentlas" || relativePath.startsWith(".agentlas/")) continue;
    files.push({
      path: displayText(relativePath, 1_024),
      kind: node.kind,
      updatedAt: typeof node.last_modified === "string" && Number.isFinite(Date.parse(node.last_modified))
        ? node.last_modified
        : null,
    });
    if (files.length >= 160) break;
  }
  return files;
}

export function projectMobileBridgeProject(
  project: ReturnType<typeof listProjects>[number],
  options: { includeDetails?: boolean } = {},
): MobileBridgeProjectDto {
  const includeDetails = options.includeDetails === true;
  const timeline = includeDetails ? getProjectTimelineSnapshot(project.id, 24) : null;
  const latest = timeline?.entries[0] ?? null;
  return {
    id: project.id,
    name: displayText(project.name, 512),
    description: optionalDisplayText(project.description, 2_048),
    sourceType: project.sourceType,
    sourceLabel: projectSourceLabel(project),
    systemPrompt: optionalDisplayText(project.systemPrompt, 12_000),
    agentPool: project.agentPool.map((member, order) => ({
      agentId: member.agentId,
      name: displayText(member.nameSnapshot, 512),
      source: member.source,
      releaseId: member.releaseId,
      order,
    })),
    controllerAgentId: project.agentPool[0]?.agentId ?? null,
    controllerName: optionalDisplayText(project.agentPool[0]?.nameSnapshot ?? null, 512),
    agentCount: project.agentPool.length,
    hasWorkingFolder: Boolean(project.folderPath),
    files: includeDetails ? projectFilesDto(project) : [],
    latestResult: latest
      ? {
          summary: displayText(latest.summary, 4_000),
          updatedAt: latest.occurredAt,
          taskId: latest.taskId,
        }
      : null,
    memory: {
      sources: timeline?.sources.map((source) => ({ kind: source.kind, status: source.status })) ?? [],
      entries: timeline?.entries.map((entry) => ({
        id: entry.id,
        summary: displayText(entry.summary, 4_000),
        occurredAt: entry.occurredAt,
        taskId: entry.taskId,
      })) ?? [],
      truncated: timeline?.truncated ?? false,
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    // DESKTOP_MOBILE_BRIDGE: absolute folder paths and raw project-memory bytes never cross the bridge.
  };
}

function projectsDto(): MobileBridgeProjectDto[] {
  return listProjects().map((project) => projectMobileBridgeProject(project));
}

/** DESKTOP_MOBILE_BRIDGE: One canonical secret-free chat DTO for snapshots and RPC replies. */
export function projectMobileBridgeChat(
  chat: Chat,
  active = false,
): MobileBridgeChatDto {
  let task: CanonicalTask | null = null;
  try {
    task = findCanonicalTaskForChat(chat.id);
  } catch {
    // Keep the chat visible during an additive upgrade or transient store read.
  }
  return {
    id: chat.id,
    oneOrigin: isOneInvocationChat(chat.id),
    taskId: task?.id ?? chat.taskId ?? null,
    taskVersion: task?.version ?? null,
    taskStatus: task?.status ?? null,
    taskUpdatedAt: task?.updatedAt ?? null,
    projectId: chat.projectId,
    workingFolderName: workingFolderName(chat.id),
    firmId: chat.firmId,
    agentId: chat.agentId,
    title: displayText(chat.title, 1_024),
    archivedAt: chat.archivedAt,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    continuousMode: chat.continuousMode,
    swarmMode: chat.swarmMode,
    active,
  };
}

function chatsDto(activeChatIds: ReadonlySet<string>): MobileBridgeChatDto[] {
  return listRecentChats(100).map((chat) =>
    projectMobileBridgeChat(chat, activeChatIds.has(chat.id)),
  );
}

export function projectMobileBridgeHistory(
  history: readonly ChatHistoryEntry[],
  limit: number,
  budgetBytes = MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES,
): MobileBridgeChatMessageDto[] {
  const budget = Math.max(1_024, Math.min(MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES, Math.floor(budgetBytes)));
  const out: MobileBridgeChatMessageDto[] = [];
  const selected = history.slice(-Math.max(1, Math.min(200, Math.floor(limit))));
  // Newest messages are authoritative when a byte budget forces a shorter page.
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const message = selected[index];
    const shell: MobileBridgeChatMessageDto = {
      id: message.id,
      role: message.role,
      text: "",
      createdAt: message.createdAt,
    };
    const remaining = budget - mobileBridgeJsonBytes(out) - mobileBridgeJsonBytes(shell) - 16;
    if (remaining <= 0) break;
    const candidate: MobileBridgeChatMessageDto = {
      ...shell,
      text: sanitizeMobileBridgeText(
        stripMobileBridgeControlFences(message.text),
        Math.min(MOBILE_BRIDGE_TRANSCRIPT_TEXT_BYTES, remaining),
      ),
    };
    const next = [candidate, ...out];
    if (mobileBridgeJsonBytes(next) > budget) break;
    out.unshift(candidate);
  }
  return out;
}

function messagesDto(
  chatIds: readonly string[],
  maxMessagesPerChat: number,
  budgetBytes: number,
): Record<string, MobileBridgeChatMessageDto[]> {
  const messages = Object.create(null) as Record<string, MobileBridgeChatMessageDto[]>;
  const ids = [...new Set(chatIds.filter((id) => id && id.length <= 256).slice(0, 20))];
  const totalBudget = Math.max(0, Math.floor(budgetBytes));
  if (ids.length === 0 || totalBudget < 1_024) return messages;
  const perChatBudget = Math.max(1_024, Math.floor(totalBudget / ids.length) - 256);
  for (const chatId of ids) {
    const projected = projectMobileBridgeHistory(
      listChatMessages(chatId, maxMessagesPerChat),
      maxMessagesPerChat,
      perChatBudget,
    );
    const candidate = { ...messages, [chatId]: projected };
    if (mobileBridgeJsonBytes(candidate) > totalBudget) break;
    messages[chatId] = projected;
  }
  return messages;
}

/** DESKTOP_MOBILE_BRIDGE: Chat questions expose display metadata, never the raw fence body. */
export function projectMobileBridgeConfirmations(
  confirmations: readonly PendingConfirmation[] = listPendingConfirmations(),
): MobileBridgePendingConfirmationDto[] {
  return confirmations.map((confirmation) => {
    let taskId = `task_${confirmation.chatId}`;
    try {
      // Division chats resolve to their root Task here. The deterministic
      // fallback is the same canonical formula and only covers isolated
      // projector tests or an additive-upgrade window before store readiness.
      taskId = ensureCanonicalTaskForChat(confirmation.chatId)?.id ?? taskId;
    } catch {
      // Keep the pending Decision visible with its deterministic Task binding;
      // never drop an approval because an optional projection read failed.
    }
    return {
      taskId,
      decisionId: confirmation.sourceMessageId,
      chatId: confirmation.chatId,
      sourceMessageId: confirmation.sourceMessageId,
      chatTitle: displayText(confirmation.chatTitle, 1_024),
      question: displayText(confirmation.question, 4_096),
      header: optionalDisplayText(confirmation.header, 512),
      optionCount: confirmation.options.length,
      multiSelect: confirmation.multiSelect,
      options: confirmation.options.slice(0, 8).map((option) => ({
        label: displayText(option.label, 512),
        description: optionalDisplayText(option.description, 2_048),
      })),
      agentId: confirmation.agentId,
      firmId: confirmation.firmId,
      createdAt: confirmation.createdAt,
    };
  });
}

interface MobileBridgeOneDecisionProjectionOptions {
  now?: Date;
  /** Test-only budget override. Production uses the closed 128 KiB aggregate cap. */
  maxBytes?: number;
}

/**
 * Main-internal atomic-snapshot helper. `confirmations` must be the result of
 * the immediately preceding `listPendingConfirmations()` read; every durable
 * chat/Task binding is revalidated below before authority can cross the wire.
 */
export function projectMobileBridgeOneDecisionsFromCurrent(
  hostIdentity: MobileBridgeHostIdentity,
  confirmations: readonly PendingConfirmation[],
  options: MobileBridgeOneDecisionProjectionOptions = {},
): MobileBridgeOneDecisionDto[] {
  if (
    hostIdentity.version !== MOBILE_BRIDGE_PROTOCOL_VERSION
    || !/^host_[a-f0-9]{32}$/.test(hostIdentity.hostId)
    || !Number.isFinite(Date.parse(hostIdentity.createdAt))
  ) {
    throw new TypeError("Invalid Mobile Bridge Decision host identity");
  }
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) throw new TypeError("Invalid Mobile Bridge Decision projection time");
  const requestedBudget = options.maxBytes ?? MOBILE_BRIDGE_ONE_DECISION_BYTES;
  const budget = Number.isFinite(requestedBudget)
    ? Math.max(0, Math.min(MOBILE_BRIDGE_ONE_DECISION_BYTES, Math.floor(requestedBudget)))
    : 0;
  const out: MobileBridgeOneDecisionDto[] = [];
  const seen = new Set<string>();

  for (const confirmation of confirmations.slice(0, MOBILE_BRIDGE_ONE_DECISION_LIMIT)) {
    const identity = `${confirmation.chatId}\0${confirmation.sourceMessageId}`;
    if (seen.has(identity) || isPendingConfirmationSnoozed(confirmation, now)) continue;
    seen.add(identity);

    // listPendingConfirmations already proves this is the current last
    // assistant question. Re-read only durable bindings here: projection must
    // never create a Task or rescue a stale/wrong Task association.
    const task = findCanonicalTaskForChat(confirmation.chatId);
    if (
      !task
      || task.status !== "waiting-decision"
      || task.archivedAt !== null
      || !task.originChatId
    ) {
      continue;
    }
    const chat = getChat(confirmation.chatId);
    if (!chat || chat.archivedAt !== null) continue;
    const currentTask = getCanonicalTask(task.id);
    const originTask = findCanonicalTaskForChat(task.originChatId);
    if (
      !currentTask
      || currentTask.id !== task.id
      || currentTask.version !== task.version
      || currentTask.originChatId !== task.originChatId
      || currentTask.status !== "waiting-decision"
      || originTask?.id !== task.id
    ) {
      continue;
    }

    // Main-side projection reads the resident judge's verdicts (warmed on the
    // async snapshot path); a cache miss keeps the deterministic fallback.
    const view = normalizeOneDecision(confirmation, task.id, oneDecisionJudgedReaders);
    const row: MobileBridgeOneDecisionDto = {
      authoritativeHostRef: hostIdentity.hostId,
      canonicalTaskVersion: task.version,
      view,
    };
    if (
      !isMobileBridgeOneDecisionDto(row)
      || row.view.chatId !== confirmation.chatId
      || row.view.decisionId !== confirmation.sourceMessageId
      || row.view.createdAt !== confirmation.createdAt
      || !deviceSafeOneDecision(row)
    ) {
      continue;
    }
    const candidate = [...out, row];
    if (mobileBridgeJsonBytes(candidate) > budget) continue;
    out.push(row);
  }
  return out;
}

/**
 * Project only Main's current pending confirmations. Callers cannot supply a
 * pre-normalized or cached view, so Mobile receives no second Decision truth.
 */
export function projectMobileBridgeOneDecisions(
  hostIdentity: MobileBridgeHostIdentity,
  options: MobileBridgeOneDecisionProjectionOptions = {},
): MobileBridgeOneDecisionDto[] {
  return projectMobileBridgeOneDecisionsFromCurrent(
    hostIdentity,
    listPendingConfirmations(),
    options,
  );
}

interface MobileBridgeOneEvidenceProjectionOptions {
  /** Test-only aggregate budget override. Production uses the closed cap. */
  maxBytes?: number;
}

function assertOneEvidenceHostIdentity(hostIdentity: MobileBridgeHostIdentity): void {
  if (
    hostIdentity.version !== MOBILE_BRIDGE_PROTOCOL_VERSION
    || !/^host_[a-f0-9]{32}$/.test(hostIdentity.hostId)
    || !Number.isFinite(Date.parse(hostIdentity.createdAt))
  ) {
    throw new TypeError("Invalid Mobile Bridge One evidence host identity");
  }
}

function oneEvidenceBudget(requested: number | undefined, cap: number): number {
  const value = requested ?? cap;
  return Number.isFinite(value) ? Math.max(0, Math.min(cap, Math.floor(value))) : 0;
}

function exactCurrentProjectionTask(taskId: string, taskVersion: number): CanonicalTask | null {
  try {
    const task = getCanonicalTask(taskId);
    if (
      !task
      || task.id !== taskId
      || task.version !== taskVersion
      || task.status === "archived"
      || task.archivedAt !== null
    ) return null;
    return task;
  } catch {
    return null;
  }
}

function hasDuplicateBindings(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Pure Main projector used by the production state reader and contract tests.
 * An invalid state or ambiguous Task-version identity clears the aggregate.
 */
export function projectMobileBridgeOneValueClosuresFromState(
  hostIdentity: MobileBridgeHostIdentity,
  state: unknown,
  options: MobileBridgeOneEvidenceProjectionOptions = {},
): MobileBridgeOneValueClosureDto[] {
  assertOneEvidenceHostIdentity(hostIdentity);
  if (!isOneValueClosureState(state)) return [];
  if (hasDuplicateBindings(state.closures.map((record) =>
    `${record.closure.taskId}:${record.taskVersion}`,
  ))) return [];
  const budget = oneEvidenceBudget(options.maxBytes, MOBILE_BRIDGE_ONE_VALUE_CLOSURE_BYTES);
  const records = [...state.closures]
    .sort((left, right) => Date.parse(right.closure.generatedAt) - Date.parse(left.closure.generatedAt))
    .slice(0, MOBILE_BRIDGE_ONE_VALUE_CLOSURE_LIMIT);
  const out: MobileBridgeOneValueClosureDto[] = [];
  for (const record of records) {
    if (!exactCurrentProjectionTask(record.closure.taskId, record.taskVersion)) continue;
    const remaining = record.closure.remainingWork;
    const row: MobileBridgeOneValueClosureDto = {
      authoritativeHostRef: hostIdentity.hostId,
      taskId: record.closure.taskId,
      canonicalTaskVersion: record.taskVersion,
      valueClosureId: record.closure.valueClosureId,
      valueClosureVersion: record.version,
      generatedAt: record.closure.generatedAt,
      status: "ready",
      verification: {
        outcomeStatus: record.closure.outcomeStatus,
        phases: record.closure.lifecycleClaims.map((claim) => ({
          phase: claim.phase,
          status: claim.status,
          evidenceCount: claim.evidenceRefs.length,
        })),
        receiptCount: record.closure.receiptRefs.length,
        trustedEvidenceCount: record.trustedEvidenceRefs.length,
      },
      remainingWork: {
        total: remaining.length,
        pending: remaining.filter((item) => item.status === "pending").length,
        blocked: remaining.filter((item) => item.status === "blocked").length,
        notRequired: remaining.filter((item) => item.status === "not_required").length,
        userOwned: remaining.filter((item) => item.owner === "user").length,
        oneOwned: remaining.filter((item) => item.owner === "one").length,
        externalOwned: remaining.filter((item) => item.owner === "external").length,
      },
    };
    if (!isMobileBridgeOneValueClosureDto(row)) continue;
    const candidate = [...out, row];
    if (mobileBridgeJsonBytes(candidate) > budget) return [];
    out.push(row);
  }
  return out;
}

export function projectMobileBridgeOneValueClosures(
  hostIdentity: MobileBridgeHostIdentity,
  options: MobileBridgeOneEvidenceProjectionOptions = {},
): MobileBridgeOneValueClosureDto[] {
  try {
    return projectMobileBridgeOneValueClosuresFromState(
      hostIdentity,
      getOneValueClosureState(),
      options,
    );
  } catch {
    return [];
  }
}

export function projectMobileBridgeOneExperienceReuseFromState(
  hostIdentity: MobileBridgeHostIdentity,
  state: unknown,
  options: MobileBridgeOneEvidenceProjectionOptions = {},
): MobileBridgeOneExperienceReuseDto[] {
  assertOneEvidenceHostIdentity(hostIdentity);
  if (!isOneExperienceReuseState(state)) return [];
  if (hasDuplicateBindings(state.receipts.map((record) =>
    `${record.receipt.taskId}:${record.receipt.taskVersion}:${record.receipt.runId}`,
  ))) return [];
  const budget = oneEvidenceBudget(options.maxBytes, MOBILE_BRIDGE_ONE_EXPERIENCE_REUSE_BYTES);
  const records = [...state.receipts]
    .sort((left, right) => Date.parse(right.receipt.createdAt) - Date.parse(left.receipt.createdAt))
    .slice(0, MOBILE_BRIDGE_ONE_EXPERIENCE_REUSE_LIMIT);
  const out: MobileBridgeOneExperienceReuseDto[] = [];
  for (const record of records) {
    if (!exactCurrentProjectionTask(record.receipt.taskId, record.receipt.taskVersion)) continue;
    const row: MobileBridgeOneExperienceReuseDto = {
      authoritativeHostRef: hostIdentity.hostId,
      taskId: record.receipt.taskId,
      canonicalTaskVersion: record.receipt.taskVersion,
      reuseReceiptId: record.receipt.reuseReceiptId,
      reuseReceiptVersion: record.version,
      valueClosureId: record.receipt.valueClosureId,
      valueClosureVersion: record.receipt.valueClosureVersion,
      createdAt: record.receipt.createdAt,
      reuseStatus: "approved_experience_reused",
      comparisonStatus: "not_yet_measured",
      improvementClaimed: false,
      reusedAssetCount: record.receipt.assetBindings.length,
      sourceTaskCount: new Set(record.receipt.assetBindings.map((binding) => binding.sourceTaskId)).size,
      scopes: [...new Set(record.receipt.assetBindings.map((binding) => binding.scope))].sort(),
    };
    if (!isMobileBridgeOneExperienceReuseDto(row)) continue;
    const candidate = [...out, row];
    if (mobileBridgeJsonBytes(candidate) > budget) return [];
    out.push(row);
  }
  return out;
}

export function projectMobileBridgeOneExperienceReuse(
  hostIdentity: MobileBridgeHostIdentity,
  options: MobileBridgeOneEvidenceProjectionOptions = {},
): MobileBridgeOneExperienceReuseDto[] {
  try {
    return projectMobileBridgeOneExperienceReuseFromState(
      hostIdentity,
      getOneExperienceReuseState(),
      options,
    );
  } catch {
    return [];
  }
}

function improvementMetric(
  state: OneImprovementProofState,
  proofId: string,
  changeRef: string,
): MobileBridgeOneImprovementMetricDto | null {
  const record = state.proofs.find((item) => item.proof.improvementProofId === proofId);
  const change = record?.proof.changes.find((item) => item.changeRef === changeRef);
  if (!change) return null;
  if (change.evidenceType === "measured") {
    return {
      type: "measured",
      changeKind: change.kind,
      baseline: change.baseline,
      current: change.current,
      unit: change.unit,
      comparisonDirection: change.comparisonDirection,
    };
  }
  if (change.evidenceType === "estimate") {
    return {
      type: "estimate",
      changeKind: change.kind,
      value: change.estimate.value,
      unit: change.estimate.unit,
    };
  }
  return {
    type: "qualitative",
    changeKind: change.kind,
    baselineRefCount: change.baselineRefs.length,
    currentRefCount: change.currentRefs.length,
  };
}

function deviceSafeImprovementMetric(metric: MobileBridgeOneImprovementMetricDto): boolean {
  if (metric.type === "qualitative") return true;
  return sanitizeMobileBridgeText(metric.unit, Buffer.byteLength(metric.unit, "utf8") + 64) === metric.unit;
}

/**
 * Project verified proof records only. Current, baseline, and reused-asset
 * source Tasks must still match the exact persisted versions and be unarchived.
 */
export function projectMobileBridgeOneImprovementProofsFromState(
  hostIdentity: MobileBridgeHostIdentity,
  state: unknown,
  options: MobileBridgeOneEvidenceProjectionOptions = {},
): MobileBridgeOneImprovementProofDto[] {
  assertOneEvidenceHostIdentity(hostIdentity);
  if (!isOneImprovementProofState(state)) return [];
  if (hasDuplicateBindings(state.proofs.map((record) =>
    `${record.proof.taskId}:${record.currentTaskVersion}`,
  ))) return [];
  const budget = oneEvidenceBudget(options.maxBytes, MOBILE_BRIDGE_ONE_IMPROVEMENT_PROOF_BYTES);
  const records = [...state.proofs]
    .sort((left, right) => Date.parse(right.proof.generatedAt) - Date.parse(left.proof.generatedAt))
    .slice(0, MOBILE_BRIDGE_ONE_IMPROVEMENT_PROOF_LIMIT);
  const out: MobileBridgeOneImprovementProofDto[] = [];
  for (const record of records) {
    if (!exactCurrentProjectionTask(record.proof.taskId, record.currentTaskVersion)) continue;
    if (record.baselineTasks.some((item) => !exactCurrentProjectionTask(item.taskId, item.taskVersion))) continue;
    if (record.assetBindings.some((item) =>
      !exactCurrentProjectionTask(item.sourceTaskId, item.sourceTaskVersion)
      || item.currentTaskId !== record.proof.taskId
      || item.currentTaskVersion !== record.currentTaskVersion,
    )) continue;
    const comparisons: MobileBridgeOneImprovementProofDto["comparisons"] = [];
    let invalid = false;
    for (const comparison of record.comparisons) {
      const metric = improvementMetric(state, record.proof.improvementProofId, comparison.changeRef);
      if (
        !metric
        || !deviceSafeImprovementMetric(metric)
        || comparison.currentTaskId !== record.proof.taskId
        || comparison.currentTaskVersion !== record.currentTaskVersion
        || comparison.receiptRefs.length > 32
        || comparison.evidenceRefs.length > 32
      ) {
        invalid = true;
        break;
      }
      comparisons.push({
        comparisonRef: comparison.comparisonRef,
        baselineTaskId: comparison.baselineTaskId,
        baselineTaskVersion: comparison.baselineTaskVersion,
        currentTaskVersion: comparison.currentTaskVersion,
        evidenceType: comparison.evidenceType,
        result: comparison.result,
        receiptRefs: [...comparison.receiptRefs],
        evidenceCount: comparison.evidenceRefs.length,
        metric,
      });
    }
    if (invalid) continue;
    const row: MobileBridgeOneImprovementProofDto = {
      authoritativeHostRef: hostIdentity.hostId,
      taskId: record.proof.taskId,
      canonicalTaskVersion: record.currentTaskVersion,
      improvementProofId: record.proof.improvementProofId,
      improvementProofVersion: record.version,
      generatedAt: record.proof.generatedAt,
      status: "verified",
      compoundingStep: record.proof.compoundingStep,
      attributionStatus: record.proof.attributionStatus,
      reusedAssets: record.assetBindings.map((binding) => ({
        assetId: binding.assetId,
        assetVersion: binding.assetVersion,
        assetKind: binding.assetKind,
        sourceTaskId: binding.sourceTaskId,
        sourceTaskVersion: binding.sourceTaskVersion,
      })),
      comparisons,
    };
    if (!isMobileBridgeOneImprovementProofDto(row)) continue;
    const candidate = [...out, row];
    if (mobileBridgeJsonBytes(candidate) > budget) return [];
    out.push(row);
  }
  return out;
}

export function projectMobileBridgeOneImprovementProofs(
  hostIdentity: MobileBridgeHostIdentity,
  options: MobileBridgeOneEvidenceProjectionOptions = {},
): MobileBridgeOneImprovementProofDto[] {
  try {
    reconcileOneImprovementProofs();
    return projectMobileBridgeOneImprovementProofsFromState(
      hostIdentity,
      getOneImprovementProofState(),
      options,
    );
  } catch {
    return [];
  }
}

/** DESKTOP_MOBILE_BRIDGE: Automation prompts, graphs, triggers, and credentials stay on Desktop. */
export function projectMobileBridgeAutomation(
  automation: Automation,
): MobileBridgeAutomationDto {
  const latestRun = listRunHistory(automation.id, 1)[0];
  const liveRunState = getAutomationLiveRunState(automation.id);
  const latestNeedsAttention = latestRun != null && (
    latestRun.status === "error" ||
    latestRun.status === "partial" ||
    latestRun.status === "blocked" ||
    latestRun.status === "needs_input"
  );
  return {
    id: automation.id,
    name: displayText(automation.name, 1_024),
    scheduleHuman: displayText(automation.scheduleHuman, 1_024),
    targetType: automation.targetType,
    targetId: automation.targetId,
    enabled: automation.enabled,
    createdBy: automation.createdBy,
    createdAt: automation.createdAt,
    lastRunAt: automation.lastRunAt,
    nextRunAt: automation.nextRunAt,
    timezone: automation.timezone ?? null,
    triggerType: automation.triggerType ?? "schedule",
    toolMode: automation.toolMode ?? "auto",
    hubMode: automation.hubMode ?? "hub-allowed",
    runState: liveRunState ?? (latestRun == null
      ? "unknown"
      : latestNeedsAttention
        ? "failed"
        : latestRun.status === "ok"
          ? "completed"
          : "idle"),
    lastError: liveRunState != null || !latestNeedsAttention
      ? null
      : latestRun?.status === "partial"
        ? "automation_partial"
        : latestRun?.status === "blocked"
          ? "automation_blocked"
          : latestRun?.status === "needs_input"
            ? "automation_needs_input"
            : "automation_failed",
    // DESKTOP_MOBILE_BRIDGE: promptTemplate, graph, webhook token, fs path,
    // and poll-source configuration remain on the Desktop.
  };
}

function automationsDto(): MobileBridgeAutomationDto[] {
  return listAutomations().map(projectMobileBridgeAutomation);
}

/** DESKTOP_MOBILE_BRIDGE: Runtime source paths and credential locators are intentionally omitted. */
export function projectMobileBridgeRuntimes(
  runtimes: readonly RuntimeStatus[],
): MobileBridgeRuntimeDto[] {
  return runtimes.map((runtime) => ({
    kind: runtime.kind,
    backend: runtime.backend,
    version: runtime.version,
    active: runtime.active,
    model: runtime.model ?? null,
    effort: runtime.effort ?? null,
    efforts: (runtime.efforts ?? []).slice(0, 20).map((effort) => ({
      id: displayText(effort.id, 160),
      label: displayText(effort.label, 256),
    })),
    availableModels: (runtime.availableModels ?? [])
      .filter((model): model is string => typeof model === "string")
      .slice(0, 100)
      .map((model) => displayText(model, 512)),
    longContextEnabled: runtime.longContextEnabled === true,
    // DESKTOP_MOBILE_BRIDGE: source may be an absolute CLI path or provider
    // locator and is intentionally omitted.
  }));
}

/** DESKTOP_MOBILE_BRIDGE: Usage projection carries quota state, never provider credentials. */
export function projectMobileBridgeUsage(
  usage: UsageSnapshot,
): MobileBridgeUsageProviderDto[] {
  return usage.providers.map((provider) => ({
    provider: provider.provider,
    backend: provider.backend ?? null,
    label: provider.label,
    status: provider.status,
    fetchedAt: provider.fetchedAt,
    error:
      provider.error === "local_estimate"
        ? "local_estimate"
        : provider.status === "error"
          ? "unavailable"
          : null,
    accountFingerprint:
      typeof provider.accountFingerprint === "string" && /^[a-f0-9]{16}$/.test(provider.accountFingerprint)
        ? provider.accountFingerprint
        : null,
    windows: provider.windows.map((window) => ({
      id: window.id,
      label: window.label,
      kind: window.kind,
      usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
      resetAt: window.resetAt ?? null,
      model: window.model ?? null,
      used: window.used ?? null,
      limit: window.limit ?? null,
      unit: window.unit ?? null,
    })),
  }));
}

/**
 * Build a secret-free projection from the currently initialized Desktop stores.
 *
 * DESKTOP_MOBILE_BRIDGE: This is an adapter, not a second source of truth. It
 * never seeds, catches an empty store with sample rows, or reads SQLite directly.
 * Active run ids must be supplied by the shared InvocationService authority.
 */
export async function projectMobileBridgeSnapshot(
  options: MobileBridgeProjectionOptions,
): Promise<MobileBridgeSnapshot> {
  if (
    options.hostIdentity.version !== MOBILE_BRIDGE_PROTOCOL_VERSION ||
    !/^host_[a-f0-9]{32}$/.test(options.hostIdentity.hostId) ||
    !Number.isFinite(Date.parse(options.hostIdentity.createdAt))
  ) {
    throw new Error("Invalid Mobile Bridge host identity");
  }
  if (!options.displayName.trim()) throw new Error("Mobile Bridge display name is required");
  const activeChatIds = [...new Set(options.activeChatIds ?? [])];
  const activeSet = new Set(activeChatIds);
  const maxMessages = Math.max(1, Math.min(200, Math.floor(options.maxMessagesPerChat ?? 200)));
  const [runtimes, usage, presentEnvKeys] = await Promise.all([
    detectRuntimes(),
    getUsageSnapshot(),
    listEnvKeys().catch(() => [] as string[]),
  ]);
  const taskProjectionRuntime = createOneTaskProjectionRuntime({
    getAuthoritySnapshot: ({ taskId }) => {
      const task = getCanonicalTask(taskId);
      if (!task) return null;
      const executionAuthorityAvailable = Boolean(task.originChatId && getChat(task.originChatId));
      return {
        connection: "online" as const,
        lastSyncedAt: task.updatedAt,
        authoritativeHostRef: options.hostIdentity.hostId,
        executionAuthorityAvailable,
        mutationMode: executionAuthorityAvailable ? "direct" as const : "read_only" as const,
      };
    },
  });
  const projectedTasks = taskProjectionRuntime.listProjections({
    surface: "mobile",
    mode: "summary",
    limit: 20,
  });
  const taskProjections = projectedTasks.reduce<typeof projectedTasks>((accepted, projection) => {
    const candidate = [...accepted, projection];
    return mobileBridgeJsonBytes(candidate) <= Math.floor(MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES / 2)
      ? candidate
      : accepted;
  }, []);
  // Read once so the legacy DTO and Main-normalized Decision projection cannot
  // describe different pending-message generations inside one snapshot.
  const pendingConfirmations = listPendingConfirmations();
  // Async pre-pass: warm the resident judge's risk/disposition verdicts so the
  // synchronous projection below can peek them (miss = deterministic fallback).
  await prejudgeOneDecisions(pendingConfirmations.slice(0, MOBILE_BRIDGE_ONE_DECISION_LIMIT)).catch(() => undefined);
  const oneDecisions = projectMobileBridgeOneDecisionsFromCurrent(
    options.hostIdentity,
    pendingConfirmations,
    { now: options.now },
  );
  const oneValueClosures = projectMobileBridgeOneValueClosures(options.hostIdentity);
  const oneExperienceReuseReceipts = projectMobileBridgeOneExperienceReuse(options.hostIdentity);
  const oneImprovementProofs = projectMobileBridgeOneImprovementProofs(options.hostIdentity);
  const oneEcosystemSuggestions = projectOneMobileEcosystemSuggestions(
    options.hostIdentity.hostId,
    options.now ?? new Date(),
  );
  const snapshot: MobileBridgeSnapshot = {
    schemaVersion: MOBILE_BRIDGE_PROTOCOL_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    host: hostDto(options),
    runtimes: projectMobileBridgeRuntimes(runtimes),
    agents: agentsDto(new Set(presentEnvKeys)),
    firms: firmsDto(),
    projects: projectsDto(),
    chats: chatsDto(activeSet),
    messages: {},
    pendingConfirmations: projectMobileBridgeConfirmations(pendingConfirmations),
    pendingBrowserApprovals: [...(options.pendingBrowserApprovals ?? [])],
    automations: automationsDto(),
    usage: projectMobileBridgeUsage(usage),
    activeChatIds,
    taskProjections,
    oneDecisions,
    oneValueClosures,
    oneExperienceReuseReceipts,
    oneImprovementProofs,
    oneEcosystemSuggestions,
    oneProfile: projectMobileBridgeOneProfile(getOneProfile()),
    oneBriefing: projectMobileBridgeOneBriefing(getOneBriefingSnapshot({ now: options.now })),
    pairingVerificationTasks: listPairingVerificationTasks(options.hostIdentity.hostId).map((task) => ({
      hostId: options.hostIdentity.hostId,
      taskId: task.id,
      taskVersion: task.version,
      updatedAt: task.updatedAt,
    })),
    ...(options.ontology?.supported
      ? { ontologyChipProjections: [...options.ontology.projections] }
      : {}),
  };
  const baseBytes = mobileBridgeJsonBytes(snapshot);
  if (baseBytes > MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES) {
    throw new Error("Mobile Bridge snapshot metadata exceeds the safe wire budget");
  }
  snapshot.messages = messagesDto(
    options.includeMessagesForChatIds ?? [],
    maxMessages,
    MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES - baseBytes,
  );
  if (mobileBridgeJsonBytes(snapshot) > MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES) {
    throw new Error("Mobile Bridge snapshot exceeds the safe wire budget");
  }
  return snapshot;
}
