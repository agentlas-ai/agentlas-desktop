import type { RuntimeSelection } from "./types";

export const ONE_TEAM_PREFLIGHT_CONTRACT_VERSION = "1.0.0" as const;

export type OneTeamPreflightPermission = "read" | "write";
export type OneTeamPreflightStatus =
  | "proposed"
  | "blocked"
  | "team_reserved"
  | "workforce_reserved"
  | "solo_reserved"
  | "deferred"
  | "cancelled"
  | "team_started"
  | "workforce_started"
  | "solo_started"
  | "expired"
  | "recovery_required";

export type OneTeamPreflightComplexityReason =
  | "explicit_team_request"
  | "parallel_work_requested"
  | "independent_verification_requested"
  | "multiple_distinct_deliverables"
  | "constrained_research_decision"
  // The resident judge concluded the request genuinely benefits from a team
  // even though none of the deterministic complexity wordlists fired.
  | "model_assessed_team_benefit";

export type OneTeamPreflightInputScope =
  | "current_user_request"
  | "approved_one_profile_memory"
  | "bound_project_workspace";

export type OneTeamPreflightPermissionScope =
  | "workspace.read"
  | "workspace.write"
  | "external.recruitment.denied"
  | "external.payment.denied";

export interface OneTeamPreflightRole {
  roleId: string;
  label: string;
  responsibility: "coordinate_and_synthesize" | "bounded_specialist_contribution";
  candidate: {
    candidateRef: string;
    displayName: string;
    slug: string;
    /**
     * `hub-borrow` 는 사람이 직접 앉힌 call-only Hub 좌석이다. 로컬 지시문이
     * 없으므로 실행은 Hub borrow 로 가고 크레딧이 든다 — 카드가 그렇게 말해야
     * 한다. 조용히 빼면 "왜 One 만 답하지" 로만 보인다(오너 지적 2026-08-24,
     * 실측 2026-08-25: 좌석 2명이 call_only 로 탈락해 solo_started).
     */
    source: "installed" | "firm-node" | "hub-borrow";
    /** 팀 패키지를 부르면 팀으로 기록한다 — 에이전트로 적으면 실행기가 팀 그래프를 잃는다. */
    entityKind: "agent" | "team";
    availability: "installed_present";
    releaseState: "exact_package_hash" | "installed_release_unversioned";
    releaseRef: string | null;
  };
  inputScopes: OneTeamPreflightInputScope[];
  permissionScopes: OneTeamPreflightPermissionScope[];
  expectedOutput: string;
  rationaleRef: string;
}

/** 부를 수 없는 사유 — 문장이 아니라 닫힌 목록이다(화면이 골라 번역한다). */
export type OneTeamMemberUnavailableReason =
  | "not_installed"
  | "source_missing"
  | "call_only"
  | "hidden"
  | "ineligible";

export const ONE_TEAM_MEMBER_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "not_installed", "source_missing", "call_only", "hidden", "ineligible",
]);

export interface OneTeamPreflightProposal {
  contractVersion: typeof ONE_TEAM_PREFLIGHT_CONTRACT_VERSION;
  proposalId: string;
  version: number;
  status: OneTeamPreflightStatus;
  goalSummary: string;
  /**
   * 사람이 부른 팀원 중 이번에 올 수 없는 사람과 그 사유. 조용히 빠지면
   * "왜 One 만 답하지" 로만 보인다(오너 지적 2026-08-24).
   */
  unavailableMembers?: Array<{ agentId: string; displayName: string; reason: OneTeamMemberUnavailableReason }>;
  binding: {
    chatId: string;
    taskId: string;
    taskVersion: number;
    promptDigest: string;
    runtimeDigest: string;
    permission: OneTeamPreflightPermission;
  };
  complexityReasons: OneTeamPreflightComplexityReason[];
  roles: OneTeamPreflightRole[];
  cost: {
    hubBorrowing: "none" | "unknown";
    runtimeUsage: "unknown";
    currency: null;
    authoritativeQuoteRef: null;
  };
  selectionBoundary:
    | "existing_exact_installed_roster_only"
    | "external_selection_requires_work_review";
  limitation: "none" | "external_candidates_not_prepared_before_execution";
  canConfirmTeam: boolean;
  /*
   * One is meant to operate Agentlas for a non-expert: ask in plain language,
   * then run it. External staffing was the one capability with no door — Main
   * implements `confirm_workforce` end to end, but nothing could ever produce
   * that resolution, so asking for a workforce dead-ended in `continue_solo`.
   * This flag is that door. It is a separate decision from `canConfirmTeam`:
   * a local roster of two is not a precondition for recruiting externally, and
   * needing external help is exactly the case where the local roster is short.
   */
  canConfirmWorkforce: boolean;
  reservedRun: {
    mode: "team" | "workforce" | "solo";
    runId: string;
    reservedAt: string;
  } | null;
  startedRun: {
    mode: "team" | "workforce" | "solo";
    runId: string;
    startedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface PrepareOneTeamPreflightInput {
  chatId: string;
  userPrompt: string;
  expectedTaskId: string | null;
  expectedTaskVersion: number | null;
  /** Exact authority for this turn; omission preserves the Desktop default. */
  permission?: OneTeamPreflightPermission;
  /** Explicit turn-only local sub-agents selected with @. */
  requestedAgentIds?: string[];
  /** Explicit optional override; omission leaves team need to One's judgment. */
  dynamicTeamRequested?: true;
  /**
   * Exact model/runtime selected in One for this turn. The preflight must bind
   * the same runtime that execution will use; otherwise choosing a model after
   * opening One produces a valid-looking proposal that is guaranteed to fail
   * with `one-team-runtime-selection-changed` at start.
   */
  runtimeSelection?: RuntimeSelection;
}

export type PrepareOneTeamPreflightResult =
  | { kind: "not_required" }
  | { kind: "proposal"; proposal: OneTeamPreflightProposal };

export type OneTeamPreflightResolution =
  | "confirm_team"
  | "confirm_workforce"
  | "continue_solo"
  | "later"
  | "cancel";

export interface ResolveOneTeamPreflightInput {
  proposalId: string;
  expectedProposalVersion: number;
  resolution: OneTeamPreflightResolution;
  requestedRunId: string | null;
  confirmedByUser: true;
}

/**
 * Main-owned safe default. The renderer cannot choose a mode: Main uses the
 * exact installed roster when it is already verified and free, otherwise it
 * continues with One alone. External search, borrowing, payment, or broader
 * access is never authorized by this capability.
 */
export interface AutoResolveOneTeamPreflightInput {
  proposalId: string;
  expectedProposalVersion: number;
  requestedRunId: string;
}

/**
 * Opaque Main capability. It binds an already reserved run to one exact
 * proposal. It contains no candidate list, cost, permission, or prompt.
 */
export interface OneTeamPreflightRef {
  contractVersion: typeof ONE_TEAM_PREFLIGHT_CONTRACT_VERSION;
  proposalId: string;
  reservedRunId: string;
  expectedTaskId: string;
  expectedTaskVersion: number;
  mode: "team" | "workforce" | "solo";
}

export type ResolveOneTeamPreflightResult =
  | { kind: "reserved"; proposal: OneTeamPreflightProposal; ref: OneTeamPreflightRef }
  | { kind: "resolved"; proposal: OneTeamPreflightProposal };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const PACKAGE_HASH_RE = /^(?:sha256:)?[0-9a-f]{64}$/;
const SAFE_TEXT_RE = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]{1,600}$/;

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(record).length === expected.size && Object.keys(record).every((key) => expected.has(key));
}

/**
 * 필수 키는 모두 있고, 나머지는 선택 목록 안에서만 허용한다.
 *
 * 계약에 필드를 필수로 더하면 이미 저장된 제안이 전부 "손상" 으로 판정돼
 * 편성 자체가 막힌다(실측 2026-08-25: unavailableMembers 를 필수로 넣자
 * "One team preflight store is corrupt" 로 prepare 가 죽었다). 새 필드는
 * 만들 때는 항상 채우되, 읽을 때는 없어도 받는다.
 */
function keysWithin(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const present = new Set(Object.keys(record));
  for (const key of required) if (!present.has(key)) return false;
  for (const key of present) if (!allowed.has(key)) return false;
  return true;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function safeIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeText(value: unknown, limit = 600): value is string {
  return typeof value === "string" && value.length <= limit && SAFE_TEXT_RE.test(value);
}

function stringEnumArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  max: number,
): value is T[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= max
    && new Set(value).size === value.length
    && value.every((item) => typeof item === "string" && allowed.has(item));
}

const STATUSES = new Set<OneTeamPreflightStatus>([
  "proposed", "blocked", "team_reserved", "workforce_reserved", "solo_reserved", "deferred", "cancelled",
  "team_started", "workforce_started", "solo_started", "recovery_required",
  "expired",
]);
const COMPLEXITY_REASONS = new Set<OneTeamPreflightComplexityReason>([
  "explicit_team_request", "parallel_work_requested", "independent_verification_requested",
  "multiple_distinct_deliverables", "constrained_research_decision", "model_assessed_team_benefit",
]);
const INPUT_SCOPES = new Set<OneTeamPreflightInputScope>([
  "current_user_request", "approved_one_profile_memory", "bound_project_workspace",
]);
const PERMISSION_SCOPES = new Set<OneTeamPreflightPermissionScope>([
  "workspace.read", "workspace.write", "external.recruitment.denied", "external.payment.denied",
]);

export function isOneTeamPreflightRole(value: unknown): value is OneTeamPreflightRole {
  const role = objectValue(value);
  if (!role || !exactKeys(role, [
    "roleId", "label", "responsibility", "candidate", "inputScopes", "permissionScopes",
    "expectedOutput", "rationaleRef",
  ])) return false;
  if (!safeId(role.roleId) || !safeText(role.label, 120) || !safeText(role.expectedOutput, 360)) return false;
  if (!["coordinate_and_synthesize", "bounded_specialist_contribution"].includes(String(role.responsibility))) return false;
  if (!safeId(role.rationaleRef)) return false;
  if (!stringEnumArray<OneTeamPreflightInputScope>(role.inputScopes, INPUT_SCOPES, 3)) return false;
  if (!stringEnumArray<OneTeamPreflightPermissionScope>(role.permissionScopes, PERMISSION_SCOPES, 4)) return false;
  const candidate = objectValue(role.candidate);
  if (!candidate || !exactKeys(candidate, [
    "candidateRef", "displayName", "slug", "source", "entityKind", "availability",
    "releaseState", "releaseRef",
  ])) return false;
  if (!safeId(candidate.candidateRef) || !safeText(candidate.displayName, 120) || !safeText(candidate.slug, 160)) return false;
  if (!["installed", "firm-node", "hub-borrow"].includes(String(candidate.source))) return false;
  if (candidate.entityKind !== "agent" && candidate.entityKind !== "team") return false;
  if (candidate.availability !== "installed_present") return false;
  if (!["exact_package_hash", "installed_release_unversioned"].includes(String(candidate.releaseState))) return false;
  if (candidate.releaseRef !== null && (typeof candidate.releaseRef !== "string" || !PACKAGE_HASH_RE.test(candidate.releaseRef))) return false;
  return candidate.releaseState === (candidate.releaseRef ? "exact_package_hash" : "installed_release_unversioned");
}

export function isOneTeamPreflightProposal(value: unknown): value is OneTeamPreflightProposal {
  const proposal = objectValue(value);
  if (!proposal || !keysWithin(proposal, [
    "contractVersion", "proposalId", "version", "status", "goalSummary", "binding",
    "complexityReasons", "roles", "cost", "selectionBoundary", "limitation", "canConfirmTeam",
    "canConfirmWorkforce", "reservedRun", "startedRun", "createdAt", "updatedAt", "expiresAt",
  ], ["unavailableMembers"])) return false;
  if (proposal.contractVersion !== ONE_TEAM_PREFLIGHT_CONTRACT_VERSION || !safeId(proposal.proposalId)) return false;
  if (!Number.isSafeInteger(proposal.version) || Number(proposal.version) < 1 || !STATUSES.has(proposal.status as OneTeamPreflightStatus)) return false;
  const unavailableMembers = proposal.unavailableMembers ?? [];
  if (!Array.isArray(unavailableMembers) || unavailableMembers.length > 16) return false;
  for (const raw of unavailableMembers) {
    const member = objectValue(raw);
    if (!member || !exactKeys(member, ["agentId", "displayName", "reason"])) return false;
    if (!safeId(member.agentId) || !safeText(member.displayName, 120)) return false;
    if (!ONE_TEAM_MEMBER_UNAVAILABLE_REASONS.has(String(member.reason))) return false;
  }
  if (!safeText(proposal.goalSummary, 240) || !safeIso(proposal.createdAt) || !safeIso(proposal.updatedAt) || !safeIso(proposal.expiresAt)) return false;
  if (Date.parse(proposal.expiresAt as string) <= Date.parse(proposal.createdAt as string)) return false;
  if (!stringEnumArray<OneTeamPreflightComplexityReason>(proposal.complexityReasons, COMPLEXITY_REASONS, 6)) return false;
  if (!Array.isArray(proposal.roles) || proposal.roles.length > 16 || !proposal.roles.every(isOneTeamPreflightRole)) return false;
  const roleIds = (proposal.roles as OneTeamPreflightRole[]).map((role) => role.roleId);
  if (new Set(roleIds).size !== roleIds.length) return false;

  const binding = objectValue(proposal.binding);
  if (!binding || !exactKeys(binding, [
    "chatId", "taskId", "taskVersion", "promptDigest", "runtimeDigest", "permission",
  ])) return false;
  if (!safeId(binding.chatId) || !safeId(binding.taskId) || !Number.isSafeInteger(binding.taskVersion) || Number(binding.taskVersion) < 1) return false;
  if (typeof binding.promptDigest !== "string" || !HASH_RE.test(binding.promptDigest)) return false;
  if (typeof binding.runtimeDigest !== "string" || !HASH_RE.test(binding.runtimeDigest)) return false;
  if (!["read", "write"].includes(String(binding.permission))) return false;

  const cost = objectValue(proposal.cost);
  if (!cost || !exactKeys(cost, ["hubBorrowing", "runtimeUsage", "currency", "authoritativeQuoteRef"])) return false;
  if (!["none", "unknown"].includes(String(cost.hubBorrowing)) || cost.runtimeUsage !== "unknown") return false;
  if (cost.currency !== null || cost.authoritativeQuoteRef !== null) return false;
  if (!["existing_exact_installed_roster_only", "external_selection_requires_work_review"].includes(String(proposal.selectionBoundary))) return false;
  if (!["none", "external_candidates_not_prepared_before_execution"].includes(String(proposal.limitation))) return false;
  if (typeof proposal.canConfirmTeam !== "boolean") return false;
  if (proposal.canConfirmTeam !== (
    proposal.selectionBoundary === "existing_exact_installed_roster_only"
    && proposal.limitation === "none"
    && proposal.roles.length >= 2
  )) return false;
  if (typeof proposal.canConfirmWorkforce !== "boolean") return false;
  // The two doors are mutually exclusive by construction: either the installed
  // roster already covers the work, or it does not and external staffing is the
  // remaining route. `resolveOneTeamPreflight` enforces the same boundary, so a
  // proposal that disagrees with it would advertise a door that cannot open.
  if (proposal.canConfirmWorkforce !== (
    proposal.selectionBoundary === "external_selection_requires_work_review"
  )) return false;

  const validateRun = (valueToCheck: unknown, expectedMode?: "team" | "workforce" | "solo"): boolean => {
    if (valueToCheck === null) return true;
    const run = objectValue(valueToCheck);
    if (!run || !exactKeys(run, expectedMode ? ["mode", "runId", "reservedAt"] : ["mode", "runId", "startedAt"])) return false;
    return ["team", "workforce", "solo"].includes(String(run.mode))
      && (!expectedMode || run.mode === expectedMode)
      && safeId(run.runId)
      && safeIso(expectedMode ? run.reservedAt : run.startedAt);
  };
  if (!validateRun(
    proposal.reservedRun,
    proposal.status === "team_reserved"
      ? "team"
      : proposal.status === "workforce_reserved"
        ? "workforce"
        : proposal.status === "solo_reserved"
          ? "solo"
          : undefined,
  )) return false;
  if (!validateRun(proposal.startedRun)) return false;
  if (["team_reserved", "workforce_reserved", "solo_reserved"].includes(String(proposal.status)) !== (proposal.reservedRun !== null)) return false;
  if (["team_started", "workforce_started", "solo_started"].includes(String(proposal.status)) !== (proposal.startedRun !== null)) return false;
  return true;
}

/**
 * 이 실행 대상이 **로컬 설치본 버전 못박기 명단**에 오르는가.
 *
 * 못박기 명단은 "이 실행에 참여하는 설치본 하나하나의 버전을 고정한다". 그래서
 * 설치본이 아닌 대상은 여기 올라갈 수 없다 — 팀은 구성원을 가진 그래프이고,
 * call-only Hub 좌석은 slug 로 빌려 부르는 대상이라 못박을 로컬 버전이 없다.
 *
 * 이 판정이 인라인 조건문으로만 존재하던 동안, 편성은 Hub 좌석을 싣도록 고쳐졌는데
 * 실행 시작 관문은 그대로여서 **허브 좌석이 든 단톡은 실행이 아예 시작되지 않았다**
 * (인수 실측 2026-08-26: 3방 5회 시작 0건). 문장 대조 게이트는 전부 초록이었다.
 * 그래서 판정을 밖으로 꺼내 동작으로 검사한다.
 *
 * "제외"는 실행에서 빠진다는 뜻이 아니다: 팀과 Hub 좌석은 taskForceTargets /
 * borrowAgents 로 실행기에 따로 실린다.
 */
export function onePinsInstalledVersion(
  target: { source?: unknown; entityKind?: unknown },
): boolean {
  if (target.entityKind === "team") return false;
  if (target.source === "hub") return false;
  return target.source === "local";
}

/** One 참여자 식별자의 모양. 실행 명단에 오르는 값은 이 모양이어야 한다. */
export const ONE_PARTICIPANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * 버전을 못박을 **로컬 설치본 참여자 목록**을 만든다. 만들 수 없으면 null.
 *
 * 이 판단이 실행 시작 함수 안에 인라인으로만 살아 있는 동안, 편성은 Hub 좌석을
 * 싣도록 고쳐졌는데 이쪽은 "local 이 아니면 명단 전체 무효"인 채로 남았다. 그래서
 * 수리 이후 오히려 **허브 좌석이 든 단톡은 실행이 아예 시작되지 않았다**
 * (인수 실측 2026-08-26: 3방 5회 시작 0건 / 로컬 전용 방 7건 정상). 그때 관련
 * 게이트는 전부 초록이었다 — 전부 문장 대조였기 때문이다.
 *
 * 그래서 판단을 밖으로 꺼냈다. 이 함수는 부수효과가 없어 게이트가 실제로 불러
 * 볼 수 있다: Hub 좌석이 섞여도 null 이 아니어야 한다는 것이 그 계약이다.
 *
 * 명단에서 빠지는 것은 실행에서 빠지는 것이 아니다 — 팀과 Hub 좌석은
 * taskForceTargets / borrowAgents 로 실행기에 따로 실린다.
 */
export function oneVersionPinRosterIds(
  ownerAgentId: string,
  mode: "solo" | "team" | "workforce" | null,
  targets: ReadonlyArray<{ source?: unknown; entityKind?: unknown; agentId?: unknown }> | null,
): string[] | null {
  if (!ONE_PARTICIPANT_ID_RE.test(ownerAgentId)) return null;
  const ids = [ownerAgentId];
  const seen = new Set(ids);
  if (targets) {
    if ((mode === "solo" && targets.length !== 0) || (mode === "team" && targets.length < 1)) return null;
    for (const target of targets) {
      if (!onePinsInstalledVersion(target)) continue;
      if (
        target.entityKind !== "agent"
        || typeof target.agentId !== "string"
        || !ONE_PARTICIPANT_ID_RE.test(target.agentId)
        || seen.has(target.agentId)
      ) return null;
      seen.add(target.agentId);
      ids.push(target.agentId);
    }
  }
  return ids;
}
