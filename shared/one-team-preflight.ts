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
    source: "installed" | "firm-node";
    entityKind: "agent";
    availability: "installed_present";
    releaseState: "exact_package_hash" | "installed_release_unversioned";
    releaseRef: string | null;
  };
  inputScopes: OneTeamPreflightInputScope[];
  permissionScopes: OneTeamPreflightPermissionScope[];
  expectedOutput: string;
  rationaleRef: string;
}

export interface OneTeamPreflightProposal {
  contractVersion: typeof ONE_TEAM_PREFLIGHT_CONTRACT_VERSION;
  proposalId: string;
  version: number;
  status: OneTeamPreflightStatus;
  goalSummary: string;
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
  if (!["installed", "firm-node"].includes(String(candidate.source)) || candidate.entityKind !== "agent") return false;
  if (candidate.availability !== "installed_present") return false;
  if (!["exact_package_hash", "installed_release_unversioned"].includes(String(candidate.releaseState))) return false;
  if (candidate.releaseRef !== null && (typeof candidate.releaseRef !== "string" || !PACKAGE_HASH_RE.test(candidate.releaseRef))) return false;
  return candidate.releaseState === (candidate.releaseRef ? "exact_package_hash" : "installed_release_unversioned");
}

export function isOneTeamPreflightProposal(value: unknown): value is OneTeamPreflightProposal {
  const proposal = objectValue(value);
  if (!proposal || !exactKeys(proposal, [
    "contractVersion", "proposalId", "version", "status", "goalSummary", "binding",
    "complexityReasons", "roles", "cost", "selectionBoundary", "limitation", "canConfirmTeam",
    "reservedRun", "startedRun", "createdAt", "updatedAt", "expiresAt",
  ])) return false;
  if (proposal.contractVersion !== ONE_TEAM_PREFLIGHT_CONTRACT_VERSION || !safeId(proposal.proposalId)) return false;
  if (!Number.isSafeInteger(proposal.version) || Number(proposal.version) < 1 || !STATUSES.has(proposal.status as OneTeamPreflightStatus)) return false;
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
