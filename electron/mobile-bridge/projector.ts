import { listInstalledAgents } from "../mcp/registry";
import { detectRuntimes } from "../runtime/detect";
import { listAgentGroups, listResolvedAgentGroups } from "../store/agent-groups";
import { listAutomations } from "../store/automations";
import { listChatMessages, listRecentChats } from "../store/chats";
import { listFirms } from "../store/firms";
import { listProjects } from "../store/projects";
import { listPendingConfirmations } from "../confirm";
import { getUsageSnapshot } from "../usage";
import type {
  Automation,
  Chat,
  ChatHistoryEntry,
  PendingConfirmation,
  RuntimeStatus,
  UsageSnapshot,
} from "../../shared/types";

import type { MobileBridgeHostIdentity } from "./pairing";

import {
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  type MobileBridgeAgentDto,
  type MobileBridgeAgentGroupDto,
  type MobileBridgeAutomationDto,
  type MobileBridgeChatDto,
  type MobileBridgeChatMessageDto,
  type MobileBridgeFirmDto,
  type MobileBridgeHostDto,
  type MobileBridgePendingConfirmationDto,
  type MobileBridgeProjectDto,
  type MobileBridgeRuntimeDto,
  type MobileBridgeSnapshot,
  type MobileBridgeUsageProviderDto,
} from "../../shared/mobile-bridge";
import {
  MOBILE_BRIDGE_DISPLAY_TEXT_BYTES,
  MOBILE_BRIDGE_SAFE_PAYLOAD_BYTES,
  MOBILE_BRIDGE_TRANSCRIPT_TEXT_BYTES,
  mobileBridgeJsonBytes,
  sanitizeMobileBridgeText,
} from "./sanitize";

export interface MobileBridgeProjectionOptions {
  /** DESKTOP_MOBILE_BRIDGE: Loaded from userData/mobile-bridge/identity.json. */
  hostIdentity: MobileBridgeHostIdentity;
  displayName: string;
  appVersion: string;
  activeChatIds?: readonly string[];
  includeMessagesForChatIds?: readonly string[];
  maxMessagesPerChat?: number;
  now?: Date;
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
      "groups",
      "projects",
      "chats",
      "chat-stream",
      "steering",
      "confirmations",
      "browser-approvals",
      "automations",
      "usage",
    ],
  };
}

function agentsDto(): MobileBridgeAgentDto[] {
  return listInstalledAgents().map((agent) => ({
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
    kind: agent.kind === "team" ? "team" : "agent",
    visibility: agent.visibility ?? "visible",
    // DESKTOP_MOBILE_BRIDGE: Only a boolean crosses the bridge. env key names,
    // hints, values, MCP config, prompts, package hashes, and local paths do not.
    requiresSetup: agent.envRequirements.some((requirement) => requirement.required),
  }));
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

async function groupsDto(): Promise<MobileBridgeAgentGroupDto[]> {
  // `listResolvedAgentGroups` may consult live Hub metadata. If that lookup
  // fails, preserve the real durable local rows but mark them missing rather
  // than inventing group members.
  let groups: Awaited<ReturnType<typeof listResolvedAgentGroups>>;
  try {
    groups = await listResolvedAgentGroups();
  } catch {
    groups = listAgentGroups().map((group) => ({
      ...group,
      warningCount: group.members.length,
      members: group.members.map((member) => ({
        ...member,
        status: "missing" as const,
        warnings: ["route_missing" as const],
      })),
    }));
  }
  return groups.map((group) => ({
    id: group.id,
    name: displayText(group.name, 512),
    description: displayText(group.description, 2_048),
    orchestratorName: displayText(group.orchestratorName, 512),
    warningCount: group.warningCount,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    members: group.members.map((member) => {
      const display = member.current ?? member.snapshot;
      return {
        id: member.id,
        source: member.source,
        agentId: member.agentId ?? null,
        agentSlug: member.agentSlug ?? null,
        hubSlug: member.hubSlug ?? null,
        firmId: member.firmId ?? null,
        nodeId: member.nodeId ?? null,
        role: optionalDisplayText(member.role, 512),
        name: displayText(display.name, 512),
        nameEn: displayText(display.nameEn, 512),
        routeLabel: displayText(display.routeLabel, 1_024),
        status: member.status,
        warnings: [...member.warnings],
      };
    }),
  }));
}

function projectsDto(): MobileBridgeProjectDto[] {
  return listProjects().map((project) => ({
    id: project.id,
    name: displayText(project.name, 512),
    description: optionalDisplayText(project.description, 2_048),
    defaultAgentId: project.defaultAgentId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    // DESKTOP_MOBILE_BRIDGE: contextNote and folderPath intentionally omitted.
  }));
}

/** DESKTOP_MOBILE_BRIDGE: One canonical secret-free chat DTO for snapshots and RPC replies. */
export function projectMobileBridgeChat(
  chat: Chat,
  active = false,
): MobileBridgeChatDto {
  return {
    id: chat.id,
    projectId: chat.projectId,
    firmId: chat.firmId,
    agentGroupId: chat.agentGroupId,
    agentId: chat.agentId,
    title: displayText(chat.title, 1_024),
    archivedAt: chat.archivedAt,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    continuousMode: chat.continuousMode,
    swarmMode: chat.swarmMode,
    active,
    hiredAgents: chat.hiredAgents.map((agent) => ({
      slug: agent.slug,
      name: optionalDisplayText(agent.name, 512),
      source: agent.source ?? null,
      routeLabel: optionalDisplayText(agent.routeLabel, 1_024),
      hiredAt: agent.hiredAt,
    })),
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
        message.text,
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
  return confirmations.map((confirmation) => ({
    chatId: confirmation.chatId,
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
  }));
}

/** DESKTOP_MOBILE_BRIDGE: Automation prompts, graphs, triggers, and credentials stay on Desktop. */
export function projectMobileBridgeAutomation(
  automation: Automation,
): MobileBridgeAutomationDto {
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
  const [groups, runtimes, usage] = await Promise.all([
    groupsDto(),
    detectRuntimes(),
    getUsageSnapshot(),
  ]);
  const snapshot: MobileBridgeSnapshot = {
    schemaVersion: MOBILE_BRIDGE_PROTOCOL_VERSION,
    generatedAt: (options.now ?? new Date()).toISOString(),
    host: hostDto(options),
    runtimes: projectMobileBridgeRuntimes(runtimes),
    agents: agentsDto(),
    firms: firmsDto(),
    groups,
    projects: projectsDto(),
    chats: chatsDto(activeSet),
    messages: {},
    pendingConfirmations: projectMobileBridgeConfirmations(),
    automations: automationsDto(),
    usage: projectMobileBridgeUsage(usage),
    activeChatIds,
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
