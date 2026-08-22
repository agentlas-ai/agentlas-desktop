/**
 * Main-owned contract for the One Team organisation chart.
 *
 * One is the control plane; a row is a durable identity binding while the
 * actual Work/Automation run remains the canonical execution record.  The
 * renderer must never infer lease, unread, or execution state from timestamps.
 */

export type OneOrgSource = "local" | "cloud" | "hub";

export type OneOrgStatusKind =
  | "new"
  | "working"
  | "waiting"
  | "failed"
  | "unconfirmed"
  | "quiet"
  | "locked";

/**
 * A user-owned collaboration preference layered on top of the immutable
 * installed agent package. It changes how One briefs an explicitly selected
 * standing staff member; it never rewrites the agent's source prompt.
 */
export type OneOrgCollaborationStyle = "default" | "concise" | "warm" | "direct";

/**
 * A bounded, host-verified status summary for an org row. Labels are optional
 * presentation metadata; counts are only accepted when every item has a
 * corresponding external tool-event id. Pending work is always host-owned.
 */
export interface OneOrgCompletionSummary {
  produced: Array<{ label: string; count: number; evidence: string[] }>;
  pending: Array<{ kind: "approval" | "review" | "input"; count: number }>;
}

export interface OneOrgMember {
  id: string;
  agentSlug: string;
  installedAgentId: string;
  displayName: string;
  nameEn: string;
  icon: string;
  source: OneOrgSource;
  sortOrder: number;
  leaseExpiresAt: string | null;
  addedAt: string;
  updatedAt: string;
  archivedAt: string | null;
  statusKind: OneOrgStatusKind;
  /** Host-observed single line, already bounded for the chart row. */
  statusLine: string;
  /** Same host-observed line rendered from the English locale template. */
  statusLineEn: string;
  lastActivityAt: string | null;
  pendingCount: number;
  pendingKind: "approval" | "review" | "input";
  unreadCount: number;
  creditState: "ok" | "insufficient" | "unknown";
  completionSummary: OneOrgCompletionSummary;
  /** Whether this member participates in host-side automatic MCP selection. */
  autoSelectTools: boolean;
  /** User-owned briefing style applied when this standing member is selected. */
  collaborationStyle: OneOrgCollaborationStyle;
  revision: number;
}

export interface OneOrgSlots {
  used: number;
  capacity: number;
  available: number;
  /** One's own orchestrator slot is included in used. */
  includesOne: true;
  /** Machine-backed swarm budget shown beside the organisation footer. */
  recommended: number;
  hardMax: number;
  cores: number;
  totalMemGB: number;
  userSet: boolean;
}

export interface OneOrgState {
  schemaVersion: 1;
  revision: number;
  members: OneOrgMember[];
  slots: OneOrgSlots;
  generatedAt: string;
}

export interface AddOneOrgMemberInput {
  installedAgentId: string;
  displayName?: string;
  leaseExpiresAt?: string | null;
}

export type OneTeamAgentAvatarInput =
  | { kind: "preset"; characterId: string }
  | { kind: "image"; dataUrl: string };

/**
 * A lightweight, user-owned teammate created directly inside One Team.
 * This is intentionally distinct from Agent Build: it creates a runnable local
 * identity, seats it in the organisation, and opens its durable direct chat in
 * one atomic user flow.
 */
export interface CreateOneTeamAgentInput {
  name: string;
  title?: string;
  description?: string;
  avatar: OneTeamAgentAvatarInput;
  /**
   * Optional model chosen while creating the teammate. The binding is stored as
   * the agent-scoped worker preference; when it is unavailable the runtime
   * selector falls through to the configured worker pool and then another live
   * connected runtime.
   */
  runtimeSelection?: import("./types").RuntimeSelection;
}

export interface CreateOneTeamAgentResult {
  state: OneOrgState;
  installedAgentId: string;
  chatId: string;
}

export interface RenameOneOrgMemberInput {
  id: string;
  displayName: string;
  expectedRevision?: number;
}

export interface UpdateOneOrgMemberInput {
  id: string;
  displayName: string;
  collaborationStyle: OneOrgCollaborationStyle;
  expectedRevision?: number;
}

export interface ReplaceOneOrgMemberInput {
  id: string;
  installedAgentId: string;
  leaseExpiresAt?: string | null;
  handoverNote?: string | null;
  expectedRevision?: number;
}

export interface ArchiveOneOrgMemberInput {
  id: string;
  expectedRevision?: number;
}

export interface MarkOneOrgMemberReadInput {
  id: string;
  expectedRevision?: number;
}

export interface SetOneOrgMemberToolsInput {
  id: string;
  autoSelectTools: boolean;
  expectedRevision?: number;
}

/** Manual sidebar order. One itself is implicit and never appears here. */
export interface ReorderOneOrgMembersInput {
  orderedIds: string[];
  expectedRevision?: number;
}
