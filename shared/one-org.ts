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
  /**
   * 지금 이 팀원의 한 줄 역할과 성격. **편집 창을 채우기 위한 값**이다.
   *
   * 만들기와 편집이 같은 창을 쓰려면(오너 지시 2026-08-23) 편집이 열릴 때 지금 값이
   * 이미 적혀 있어야 한다. 그 값을 조직도가 들고 있지 않으면 창은 빈칸으로 열리고,
   * 사용자는 "수정"이 아니라 "처음부터 다시 쓰기"를 하게 된다.
   */
  title: string;
  description: string;
  /**
   * 역할·성격까지 이 창에서 고쳐도 되는가.
   *
   * One Team 안에서 만든 팀원은 우리가 쓴 정의라 통째로 다시 쓸 수 있다. 밖에서 설치한
   * 에이전트는 남의 패키지이므로 이름·캐릭터·협업 방식까지만 바꾸고 정의는 건드리지 않는다.
   */
  identityEditable: boolean;
  /** 이 팀원에게 고정된 모델(에이전트 단위 선택). 고정이 없으면 null — 자동 배정이다. */
  runtimeSelection: import("./types").RuntimeSelection | null;
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
  /**
   * 좌석에 앉힐 때 고른 캐릭터/사진. 없으면 패키지가 들고 온 tone 을 그대로 쓴다.
   * (2026-08-23 오너 지적: 만들기 화면에는 캐릭터 선택이 있는데 좌석 배치에는 없어서
   *  붙이기만 하면 아이콘이 제멋대로 나왔다 — 두 입구가 같은 선택을 받아야 한다.)
   */
  avatar?: OneTeamAgentAvatarInput;
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
  /** 편집에서 캐릭터·사진을 바꾼다. 생략하면 지금 것을 그대로 둔다. */
  avatar?: OneTeamAgentAvatarInput;
  /**
   * 역할 한 줄과 성격. One Team 안에서 만든 팀원에만 적용된다 — 밖에서 설치한 패키지의
   * 정의는 이 창으로 바뀌지 않는다(호스트가 다시 판정한다. 클라이언트 말을 믿지 않는다).
   */
  title?: string;
  description?: string;
  /**
   * 이 팀원에게 고정할 모델. `null` 이면 고정을 풀고 자동 배정으로 되돌린다.
   * 생략하면 지금 설정을 그대로 둔다.
   */
  runtimeSelection?: import("./types").RuntimeSelection | null;
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
