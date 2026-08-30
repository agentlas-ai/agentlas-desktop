import { isPrimarilyKorean, preferredLocaleFromText } from "../../shared/detect-language";
import { isCallOnlyHubAgent } from "../../shared/call-only-agent";
import { createHash, randomUUID } from "node:crypto";
import { detectRuntimes } from "../runtime/detect";
import { pickActive, selectExactRuntime } from "../runtime/selection";
import { selectAutoRoutedAgent, selectAutoRoutedAgentJudged } from "../agents/auto-router";
import { getAgentById, listInstalledAgents } from "../mcp/registry";
import { getDb } from "../store/db";
import { getChat, retitleAutoTitledChatForTask } from "../store/chats";
import {
  ensureCanonicalTaskForChat,
  findCanonicalTaskForChat,
  getCanonicalTask,
  setCanonicalTaskStatus,
} from "../store/tasks";
import { hasInvocationRunReceipt } from "../store/run-events";
import { tryRecordOneDomainEvent } from "./domain-events";
import { oneOrgExecutionGuidance } from "./org";
import type {
  CanonicalTask,
  Chat,
  InstalledAgent,
  OrchestrationTarget,
  RuntimeSelection,
  RuntimeStatus,
} from "../../shared/types";
import {
  ONE_TEAM_PREFLIGHT_CONTRACT_VERSION,
  ONE_TEAM_PREFLIGHT_EXPIRABLE_STATUSES,
  isOneTeamPreflightProposal,
  type AcknowledgeOneTeamPreflightInput,
  type AcknowledgeOneTeamPreflightResult,
  type AutoResolveOneTeamPreflightInput,
  type OneTeamPreflightComplexityReason,
  type OneTeamPreflightPermission,
  type OneTeamPreflightProposal,
  type OneTeamPreflightRef,
  type OneTeamPreflightRole,
  type OneTeamPreflightStatus,
  type PrepareOneTeamPreflightInput,
  type PrepareOneTeamPreflightResult,
  type ResolveOneTeamPreflightInput,
  type ResolveOneTeamPreflightResult,
} from "../../shared/one-team-preflight";

export const ONE_TEAM_PREFLIGHT_META_KEY = "one.team-preflight.v1";
export const ONE_TEAM_PREFLIGHT_REPAIR_META_KEY = "one.team-preflight.repair.v1";

const STORE_VERSION = 1 as const;
const MAX_PROPOSALS = 100;
const MAX_PROMPT_CHARS = 32_000;
const PROPOSAL_TTL_MS = 30 * 60 * 1_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROCESS_INSTANCE_ID = randomUUID();
const PROCESS_PROMPTS = new Map<string, { original: string; execution: string; requestedAgentIds: string[] }>();

export interface OneTeamRuntimeBinding {
  kind: RuntimeStatus["kind"];
  backend: RuntimeStatus["backend"];
  /** Value-free identity; an executable path or provider endpoint is never persisted. */
  sourceDigest: string;
  version: string | null;
  model: string | null;
  effort: string | null;
  longContextEnabled: boolean;
  digest: string;
}

interface CandidateSnapshot {
  candidateRef: string;
  installedAgentId: string;
  slug: string;
  installedAt: string;
  packageHash: string | null;
  source: "installed" | "firm-node" | "hub-borrow";
}

interface InternalOneTeamPreflight {
  proposal: OneTeamPreflightProposal;
  main: {
    preparedInstanceId: string;
    runtime: OneTeamRuntimeBinding;
    rosterDigest: string;
    candidates: CandidateSnapshot[];
    taskForceTargets: OrchestrationTarget[];
  };
  reservation: {
    ownerInstanceId: string;
    ownerPid: number;
    mode: "team" | "workforce" | "solo";
    runId: string;
    reservedAt: string;
  } | null;
}

interface OneTeamPreflightStoreV1 {
  schemaVersion: typeof STORE_VERSION;
  version: number;
  proposals: InternalOneTeamPreflight[];
}

export interface OneTeamPreflightDependencies {
  now?: Date;
  detectRuntimes?: typeof detectRuntimes;
  getChat?: typeof getChat;
  getAgentById?: typeof getAgentById;
  listInstalledAgents?: typeof listInstalledAgents;
  findTaskForChat?: typeof findCanonicalTaskForChat;
  ensureTaskForChat?: typeof ensureCanonicalTaskForChat;
  getTask?: typeof getCanonicalTask;
  setTaskStatus?: typeof setCanonicalTaskStatus;
  hasRunReceipt?: typeof hasInvocationRunReceipt;
  /** Test-only crash seam after the durable reservation CAS. */
  afterReservation?: (proposal: OneTeamPreflightProposal) => void;
  /** Injectable resident judge for "does this genuinely need a team?" (tests). */
  judgeTeamNeed?: OneTeamNeedJudge;
}

export interface PreparedOneTeamPreflightClaim {
  ref: OneTeamPreflightRef;
  proposalId: string;
  chatId: string;
  taskId: string;
  taskVersion: number;
  mode: "team" | "workforce" | "solo";
  userPrompt: string;
  permission: "read" | "write";
  runtime: OneTeamRuntimeBinding;
  taskForceTargets: OrchestrationTarget[];
}

export class OneTeamPreflightError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "stale_binding"
      | "expired"
      | "external_selection_unavailable"
      | "runtime_changed"
      | "candidate_changed"
      | "already_resolved"
      | "recovery_required",
    message: string,
  ) {
    super(message);
    this.name = "OneTeamPreflightError";
  }
}

function nowFor(deps: OneTeamPreflightDependencies): Date {
  return deps.now ?? new Date();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
    "utf8",
  ).digest("hex")}`;
}

function shortRef(prefix: string, value: unknown): string {
  return `${prefix}:${sha256(value).slice("sha256:".length, "sha256:".length + 24)}`;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function normalizePackageHash(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (/^[0-9a-f]{64}$/.test(normalized)) return `sha256:${normalized}`;
  if (/^sha256:[0-9a-f]{64}$/.test(normalized)) return normalized;
  return null;
}

export function oneTeamRuntimeBinding(runtime: RuntimeStatus): OneTeamRuntimeBinding {
  const binding = {
    kind: runtime.kind,
    backend: runtime.backend,
    sourceDigest: sha256(runtime.source),
    version: runtime.version,
    model: runtime.model ?? null,
    effort: runtime.effort ?? null,
    longContextEnabled: runtime.longContextEnabled === true,
  };
  return { ...binding, digest: sha256(binding) };
}

export function oneTeamRuntimeBindingMatches(
  binding: OneTeamRuntimeBinding,
  runtimes: RuntimeStatus[],
): boolean {
  // A One team proposal is bound to the runtime explicitly selected in the
  // composer, not to whichever runtime happens to be globally active later.
  // Revalidation therefore succeeds while that exact immutable runtime is
  // still present in the live inventory, even if another model is active.
  return runtimes.some((runtime) => {
    const live = oneTeamRuntimeBinding(runtime);
    if (
      live.kind !== binding.kind
      || live.backend !== binding.backend
      || live.sourceDigest !== binding.sourceDigest
      || live.version !== binding.version
    ) return false;

    const model = binding.model;
    if (model) {
      const advertised = new Set([
        runtime.model,
        ...(runtime.availableModels ?? []),
        ...(runtime.allocationModels ?? []),
        ...Object.keys(runtime.allocationModelProfiles ?? {}),
      ].filter((value): value is string => typeof value === "string" && value.length > 0));
      if (!advertised.has(model)) return false;
      const supportedEfforts = runtime.allocationModelProfiles?.[model]?.efforts;
      if (binding.effort && supportedEfforts && !supportedEfforts.includes(binding.effort)) return false;
    } else if (live.model !== null) {
      return false;
    }
    return true;
  });
}

function goalSummary(reasons: OneTeamPreflightComplexityReason[]): string {
  const labels: Record<OneTeamPreflightComplexityReason, string> = {
    explicit_team_request: "explicit team request",
    parallel_work_requested: "parallel work",
    independent_verification_requested: "independent verification",
    multiple_distinct_deliverables: "multiple deliverables",
    constrained_research_decision: "research with decision constraints",
    model_assessed_team_benefit: "model-assessed team benefit",
  };
  return `Adaptive team review: ${reasons.map((reason) => labels[reason]).join(", ")}.`;
}

export interface OneTeamNeedResolution {
  needed: boolean;
  reasons: OneTeamPreflightComplexityReason[];
  source: "llm" | "explicit" | "unavailable";
}

export type OneTeamNeedJudge = (input: {
  prompt: string;
}) => Promise<{ needed: boolean; source: "llm" | "unavailable"; reason: string }>;

async function defaultJudgeTeamNeed(input: {
  prompt: string;
}): Promise<{ needed: boolean; source: "llm" | "unavailable"; reason: string }> {
  const { judgeRequired } = await import("../system-agents/judgment");
  const verdict = await judgeRequired<"yes" | "no">({
    kind: "one-team-preflight-need",
    question:
      "Would completing this request genuinely benefit from a small team of multiple specialist agents (parallel work, independent verification, or multiple distinct deliverables) instead of one agent?",
    labels: ["yes", "no"] as const,
    input: input.prompt.slice(0, 4_000),
    guidance:
      "Judge the actual work in any language. Say yes only when multiple specialist agents add real value through independent contributions, parallel execution, or verification. Do not infer from keywords or phrasing templates.",
  });
  return {
    needed: verdict.verdict === "yes",
    source: verdict.source,
    reason: verdict.reason,
  };
}

/**
 * Explicit structured UI choices are authoritative for this turn. Otherwise
 * the resident judge alone decides whether a team adds value. If judgment is
 * unavailable, the function returns unavailable and never invents a team.
 */
async function resolveOneTeamNeed(
  prompt: string,
  deps: OneTeamPreflightDependencies,
  explicit: boolean,
): Promise<OneTeamNeedResolution> {
  if (explicit) {
    return {
      needed: true,
      reasons: ["explicit_team_request"],
      source: "explicit",
    };
  }
  const judgeTeamNeed = deps.judgeTeamNeed ?? defaultJudgeTeamNeed;
  let judged: Awaited<ReturnType<OneTeamNeedJudge>>;
  try {
    judged = await judgeTeamNeed({ prompt });
  } catch {
    return { needed: false, reasons: [], source: "unavailable" };
  }
  if (judged.source !== "llm") {
    return { needed: false, reasons: [], source: "unavailable" };
  }
  if (!judged.needed) return { needed: false, reasons: [], source: "llm" };
  return {
    needed: true,
    reasons: ["model_assessed_team_benefit"],
    source: "llm",
  };
}

function inputScopes(chat: Chat): OneTeamPreflightRole["inputScopes"] {
  return chat.projectId
    ? ["current_user_request", "approved_one_profile_memory", "bound_project_workspace"]
    : ["current_user_request", "approved_one_profile_memory"];
}

function permissionScopes(
  permission: OneTeamPreflightPermission,
  /* Hub borrow 는 크레딧을 쓴다 — 그 역할에 "결제 없음"을 적으면 거짓말이다.
   * 모집(recruitment)은 여전히 없다: 사람이 이미 앉힌 좌석만 부른다. */
  hubBorrow = false,
): OneTeamPreflightRole["permissionScopes"] {
  return [
    "workspace.read",
    ...(permission === "write" ? ["workspace.write" as const] : []),
    "external.recruitment.denied",
    ...(hubBorrow ? [] : ["external.payment.denied" as const]),
  ];
}

function candidateSnapshot(
  agent: InstalledAgent,
  source: CandidateSnapshot["source"],
): CandidateSnapshot {
  return {
    candidateRef: shortRef("candidate", [agent.id, agent.slug, agent.installedAt]),
    installedAgentId: agent.id,
    slug: agent.slug,
    installedAt: agent.installedAt,
    packageHash: normalizePackageHash(agent.packageHash),
    source,
  };
}

function roleFromCandidate(
  agent: InstalledAgent,
  candidate: CandidateSnapshot,
  chat: Chat,
  coordinator: boolean,
  permission: OneTeamPreflightPermission,
  rationaleBasis = "existing-session-roster",
): OneTeamPreflightRole {
  return {
    roleId: shortRef(coordinator ? "role-coordinator" : "role-specialist", candidate.candidateRef),
    label: agent.localDisplayName || agent.nameEn || agent.name || agent.slug,
    responsibility: coordinator ? "coordinate_and_synthesize" : "bounded_specialist_contribution",
    candidate: {
      candidateRef: candidate.candidateRef,
      displayName: agent.localDisplayName || agent.nameEn || agent.name || agent.slug,
      slug: agent.slug,
      source: candidate.source,
      // 팀 패키지는 팀으로 적는다. 에이전트로 적으면 기록과 실행이 어긋난다.
      entityKind: agent.kind === "team" ? "team" : "agent",
      availability: "installed_present",
      releaseState: candidate.packageHash ? "exact_package_hash" : "installed_release_unversioned",
      releaseRef: candidate.packageHash,
    },
    inputScopes: inputScopes(chat),
    permissionScopes: permissionScopes(permission, candidate.source === "hub-borrow"),
    expectedOutput: coordinator
      ? "One integrated result with each specialist contribution and unresolved items identified."
      : `One bounded contribution within ${agent.taglineEn || agent.tagline || "the installed specialist's declared scope"}; return it to the coordinator for synthesis.`,
    rationaleRef: shortRef("rationale", [candidate.candidateRef, rationaleBasis]),
  };
}

/**
 * 사람이 이름을 대서 부른 팀원의 자격.
 *
 * 자동 후보 목록(eligibleRosterSpecialists)은 팀을 뺀다 — 아무도 지목하지
 * 않았는데 팀 하나를 통째로 부르면 범위와 비용이 사람 모르게 커진다.
 * 그러나 사람이 단톡방에 앉히거나 이번 턴에 지목한 팀은 다르다. 그것을 같은
 * 규칙으로 걸렀기 때문에, 3명짜리 방에서 팀원이 한 번도 불리지 않고 One 만
 * 답했다(오너 지적 2026-08-24 "팀은 당연히 부르는 거고").
 *
 * 소스가 사라진 패키지는 여전히 부를 수 없다 — 실행할 파일이 없다.
 *
 * ★call-only Hub 좌석은 부를 수 있다(수리 2026-08-25). 예전에는 여기서
 * `!isCallOnlyHubAgent` 로 걸러 냈는데, 그 좌석은 "실행할 수 없는 것"이 아니라
 * "로컬 프롬프트로 실행하면 안 되는 것"이다 — 실행 경로가 Hub borrow 로 다를
 * 뿐이다. 걸러 내니 사람이 직접 앉힌 팀원 둘이 통째로 사라지고 One 혼자
 * 답했다(실측: 좌석 2명 모두 `call_only`, 제안 `solo_started`, 대상 0개).
 * 아래 exactInstalledRoster 가 이 좌석을 로컬 대상이 아니라 hub 대상으로
 * 만든다. 자동 선발(eligibleRosterSpecialists)에서는 여전히 제외한다 —
 * 아무도 지목하지 않았는데 유료 Hub 호출을 켜면 비용이 사람 모르게 커진다.
 */
function eligibleExplicitMember(installed: InstalledAgent, coordinatorId: string): boolean {
  return installed.id !== coordinatorId
    && !installed.sourceMissingSince
    && installed.visibility !== "background"
    && installed.visibility !== "private";
}

function eligibleRosterSpecialists(all: InstalledAgent[], coordinatorId: string): InstalledAgent[] {
  return all.filter((installed) =>
    installed.id !== coordinatorId
    && installed.kind !== "team"
    && !installed.sourceMissingSince
    // Call-only Hub seats have no local instructions; a local-roster slot would
    // execute an empty prompt. They stay reachable through the external
    // workforce door (unresolvedExternal → confirmed_external_workforce) and
    // through non-preflight hub targets, never through the local-only roster.
    && !isCallOnlyHubAgent(installed)
    && installed.visibility !== "background"
    && installed.visibility !== "private");
}

/**
 * Async warm pass for the roster auto-route judgment. The roster itself is
 * assembled synchronously (and re-assembled at claim time for the digest check),
 * so the async prepare path warms the judged verdict here and both sync passes
 * peek the same cached decision.
 */
async function prejudgeRosterAutoRoute(
  chat: Chat,
  prompt: string,
  deps: OneTeamPreflightDependencies,
): Promise<void> {
  try {
    const byId = deps.getAgentById ?? getAgentById;
    const all = deps.listInstalledAgents ?? listInstalledAgents;
    const coordinator = byId(chat.agentId);
    if (!coordinator) return;
    const eligible = eligibleRosterSpecialists(all(), coordinator.id);
    if (eligible.length === 0) return;
    await selectAutoRoutedAgentJudged(prompt, eligible, preferredLocaleFromText(prompt), {
      allowFallback: false,
      timeoutMs: 8_000,
    });
  } catch {
    // Best-effort warm; a missing model verdict leaves the roster unchanged.
  }
}

function exactInstalledRoster(
  chat: Chat,
  deps: OneTeamPreflightDependencies,
  prompt?: string,
  allowDeterministicLocalSelection = true,
  requestedAgentIds: string[] = [],
  permission: OneTeamPreflightPermission = "write",
): {
  roles: OneTeamPreflightRole[];
  candidates: CandidateSnapshot[];
  targets: OrchestrationTarget[];
  unresolvedExternal: boolean;
  /** 요청했지만 이번에 부를 수 없는 팀원과 그 사유. */
  unresolvedMembers: Array<{ agentId: string; displayName: string; reason: string }>;
} {
  const byId = deps.getAgentById ?? getAgentById;
  const all = deps.listInstalledAgents ?? listInstalledAgents;
  const coordinator = byId(chat.agentId);
  if (!coordinator) throw new OneTeamPreflightError("candidate_changed", "The One coordinator is no longer installed");
  const candidates: CandidateSnapshot[] = [candidateSnapshot(coordinator, "installed")];
  const roles: OneTeamPreflightRole[] = [roleFromCandidate(coordinator, candidates[0], chat, true, permission)];
  const targets: OrchestrationTarget[] = [];
  let unresolvedExternal = false;
  const unresolved: Array<{ agentId: string; displayName: string; reason: string }> = [];
  const seen = new Set([coordinator.id]);
  for (const agentId of requestedAgentIds) {
    const matches = all().filter((agent) => agent.id === agentId);
    const installed = matches.length === 1 ? matches[0] : null;
    if (!installed || seen.has(installed.id) || !eligibleExplicitMember(installed, coordinator.id)) {
      // 왜 못 왔는지는 사람에게도 보여야 한다 — 조용히 빠지면 "왜 One 만
      // 답하지" 로만 보인다(오너 지적 2026-08-24).
      unresolved.push({
        agentId,
        displayName: installed?.name ?? agentId,
        reason: !installed
          ? "not_installed"
          : installed.sourceMissingSince
            ? "source_missing"
            : isCallOnlyHubAgent(installed)
              ? "call_only"
              : installed.visibility === "private" || installed.visibility === "background"
                ? "hidden"
                : "ineligible",
      });
      unresolvedExternal = true;
      continue;
    }
    seen.add(installed.id);
    // call-only Hub 좌석은 로컬 지시문이 비어 있다 — 로컬 대상으로 실으면 빈
    // 지시문 실행이 되어 항상 오답이다. 실행 경로는 Hub borrow 다.
    const hubBorrow = isCallOnlyHubAgent(installed);
    const snapshot = candidateSnapshot(installed, hubBorrow ? "hub-borrow" : "installed");
    candidates.push(snapshot);
    roles.push(roleFromCandidate(installed, snapshot, chat, false, permission, "explicit-turn-agent"));
    // 팀을 에이전트로 실으면 실행기가 팀 그래프를 잃는다. 로컬 팀의 대상
    // 식별자는 firmId 이고, 이 저장소는 설치 행의 id 를 그대로 쓴다
    // (electron/hephaestus/recommendation.ts localTarget 과 같은 규칙).
    // Hub 좌석의 대상 식별자는 slug 다 — borrowed-task-force 가 그걸로 빌린다.
    targets.push(hubBorrow
      ? { source: "hub", entityKind: installed.kind === "team" ? "team" : "agent", slug: installed.slug }
      : installed.kind === "team"
        ? { source: "local", entityKind: "team", firmId: installed.id }
        : { source: "local", entityKind: "agent", agentId: installed.id });
  }
  if (
    allowDeterministicLocalSelection
    && prompt
    && roles.length === 1
    && !unresolvedExternal
    && requestedAgentIds.length === 0
  ) {
    const eligible = eligibleRosterSpecialists(all(), coordinator.id);
    const locale = preferredLocaleFromText(prompt);
    // Synchronous site reads only the model verdict warmed by the async pass.
    // A cache miss cannot become a wordlist or embedding decision.
    const selected = selectAutoRoutedAgent(prompt, eligible, locale, { allowFallback: false, judgedOnly: true });
    if (selected) {
      const snapshot = candidateSnapshot(selected.agent, "installed");
      candidates.push(snapshot);
      roles.push(roleFromCandidate(
        selected.agent,
        snapshot,
        chat,
        false,
        permission,
        "model-selected-local-specialist",
      ));
      targets.push({ source: "local", entityKind: "agent", agentId: selected.agent.id });
    }
  }
  return { roles, candidates, targets, unresolvedExternal, unresolvedMembers: unresolved };
}

function isCandidateSnapshot(value: unknown): value is CandidateSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(",") === "candidateRef,installedAgentId,installedAt,packageHash,slug,source"
    && typeof item.candidateRef === "string" && ID_RE.test(item.candidateRef)
    && typeof item.installedAgentId === "string" && item.installedAgentId.length > 0 && item.installedAgentId.length <= 256
    && typeof item.slug === "string" && item.slug.length > 0 && item.slug.length <= 256
    && typeof item.installedAt === "string" && Number.isFinite(Date.parse(item.installedAt))
    && (item.packageHash === null || (typeof item.packageHash === "string" && /^sha256:[0-9a-f]{64}$/.test(item.packageHash)))
    && ["installed", "firm-node", "hub-borrow"].includes(String(item.source));
}

function isRuntimeBinding(value: unknown): value is OneTeamRuntimeBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const { digest, ...binding } = item;
  return Object.keys(item).sort().join(",") === "backend,digest,effort,kind,longContextEnabled,model,sourceDigest,version"
    && typeof item.kind === "string" && typeof item.backend === "string"
    && typeof item.sourceDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(item.sourceDigest)
    && (item.version === null || typeof item.version === "string")
    && (item.model === null || typeof item.model === "string")
    && (item.effort === null || typeof item.effort === "string")
    && typeof item.longContextEnabled === "boolean"
    && typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest)
    && sha256(binding) === digest;
}

/**
 * 저장된 실행 대상이 읽을 수 있는 모양인가.
 *
 * 역할 쪽만 팀을 받게 고치고 이쪽을 두었더니, 팀을 지목하면 카드는 완벽하게
 * 뜨는데(만든 직후 돌려주는 값이라 검사를 안 거친다) "팀으로 확정" 을 누르는
 * 순간 저장소에서 이미 걸러진 뒤라 "제안이 없다" 며 죽었다. 앱을 껐다 켜면
 * 카드 자체가 사라진다. 감사 2026-08-25 가 검증기를 직접 돌려 잡았다.
 *
 * 로컬 팀의 대상 식별자는 agentId 가 아니라 firmId 다.
 */
function isLocalAgentTarget(value: unknown): value is OrchestrationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  /*
   * ★사람이 직접 앉힌 call-only Hub 좌석은 hub 대상으로 실린다(수리 2026-08-25).
   * 이 목록을 local 로만 좁혔던 것이 좌석을 실행에서 지우던 마지막 관문이었다.
   * 렌더러가 임의 slug 를 밀어 넣을 수는 없다 — 이 대상은 Main 이 설치 원장의
   * 행에서만 만들고, 렌더러는 agentId 목록만 보낸다.
   */
  if (item.source === "hub") {
    return Object.keys(item).sort().join(",") === "entityKind,slug,source"
      && (item.entityKind === "agent" || item.entityKind === "team")
      && typeof item.slug === "string" && item.slug.length > 0 && item.slug.length <= 256;
  }
  if (item.source !== "local") return false;
  const shape = Object.keys(item).sort().join(",");
  if (shape === "agentId,entityKind,source") {
    return item.entityKind === "agent"
      && typeof item.agentId === "string" && item.agentId.length > 0 && item.agentId.length <= 256;
  }
  if (shape === "entityKind,firmId,source") {
    return item.entityKind === "team"
      && typeof item.firmId === "string" && item.firmId.length > 0 && item.firmId.length <= 256;
  }
  return false;
}

/** 버린 제안이 어디서 걸렸는지 한 줄로. 사람이 읽고 고칠 자리를 찾을 수 있게. */
function describeUnreadableProposal(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not-an-object";
  const item = value as Record<string, unknown>;
  const shape = Object.keys(item).sort().join(",");
  if (shape !== "main,proposal,reservation") return `unexpected-shape:${shape}`;
  if (!isOneTeamPreflightProposal(item.proposal)) return "proposal-contract";
  const main = item.main as Record<string, unknown> | null;
  if (!main || typeof main !== "object" || Array.isArray(main)) return "main-missing";
  const targets = main.taskForceTargets;
  if (Array.isArray(targets) && !targets.every(isLocalAgentTarget)) {
    const kinds = targets
      .map((target) => (target && typeof target === "object" ? String((target as Record<string, unknown>).entityKind ?? "?") : "?"))
      .join("/");
    return `target-contract:${kinds}`;
  }
  return "main-contract";
}

function isInternalProposal(value: unknown): value is InternalOneTeamPreflight {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "main,proposal,reservation" || !isOneTeamPreflightProposal(item.proposal)) return false;
  if (!item.main || typeof item.main !== "object" || Array.isArray(item.main)) return false;
  const main = item.main as Record<string, unknown>;
  if (Object.keys(main).sort().join(",") !== "candidates,preparedInstanceId,rosterDigest,runtime,taskForceTargets") return false;
  if (typeof main.preparedInstanceId !== "string" || !ID_RE.test(main.preparedInstanceId)) return false;
  if (!isRuntimeBinding(main.runtime)) return false;
  if (typeof main.rosterDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(main.rosterDigest)) return false;
  if (!Array.isArray(main.candidates) || main.candidates.length < 1 || main.candidates.length > 16 || !main.candidates.every(isCandidateSnapshot)) return false;
  if (!Array.isArray(main.taskForceTargets) || main.taskForceTargets.length > 15 || !main.taskForceTargets.every(isLocalAgentTarget)) return false;
  if (item.reservation === null) return true;
  if (!item.reservation || typeof item.reservation !== "object" || Array.isArray(item.reservation)) return false;
  const reservation = item.reservation as Record<string, unknown>;
  return Object.keys(reservation).sort().join(",") === "mode,ownerInstanceId,ownerPid,reservedAt,runId"
    && typeof reservation.ownerInstanceId === "string" && ID_RE.test(reservation.ownerInstanceId)
    && Number.isSafeInteger(reservation.ownerPid) && Number(reservation.ownerPid) > 0
    && ["team", "workforce", "solo"].includes(String(reservation.mode))
    && typeof reservation.runId === "string" && ID_RE.test(reservation.runId)
    && typeof reservation.reservedAt === "string" && Number.isFinite(Date.parse(reservation.reservedAt));
}

const LEGACY_PROPOSAL_KEYS_WITHOUT_WORKFORCE_CONFIRMATION = [
  "binding",
  "canConfirmTeam",
  "complexityReasons",
  "contractVersion",
  "cost",
  "createdAt",
  "expiresAt",
  "goalSummary",
  "limitation",
  "proposalId",
  "reservedRun",
  "roles",
  "selectionBoundary",
  "startedRun",
  "status",
  "updatedAt",
  "version",
].join(",");

function migrateKnownLegacyProposal(value: unknown): { proposal: unknown; migrated: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { proposal: value, migrated: false };
  const proposal = value as Record<string, unknown>;
  if (Object.keys(proposal).sort().join(",") !== LEGACY_PROPOSAL_KEYS_WITHOUT_WORKFORCE_CONFIRMATION) {
    return { proposal: value, migrated: false };
  }
  if (!["existing_exact_installed_roster_only", "external_selection_requires_work_review"].includes(String(proposal.selectionBoundary))) {
    return { proposal: value, migrated: false };
  }
  const migrated = {
    ...proposal,
    canConfirmWorkforce: proposal.selectionBoundary === "external_selection_requires_work_review",
  };
  return isOneTeamPreflightProposal(migrated)
    ? { proposal: migrated, migrated: true }
    : { proposal: value, migrated: false };
}

function parseStore(raw: string): { state: OneTeamPreflightStoreV1; migratedProposalCount: number } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("One team preflight store is corrupt; it was not overwritten");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("One team preflight store is corrupt; it was not overwritten");
  const item = value as Record<string, unknown>;
  if (
    item.schemaVersion !== STORE_VERSION
    || !Number.isSafeInteger(item.version)
    || Number(item.version) < 1
    || !Array.isArray(item.proposals)
    || item.proposals.length > MAX_PROPOSALS
  ) throw new Error("One team preflight store is corrupt; it was not overwritten");

  let migratedProposalCount = 0;
  const proposals = item.proposals.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return record;
    const internal = record as Record<string, unknown>;
    if (Object.keys(internal).sort().join(",") !== "main,proposal,reservation") return record;
    const migration = migrateKnownLegacyProposal(internal.proposal);
    if (!migration.migrated) return record;
    migratedProposalCount += 1;
    return { ...internal, proposal: migration.proposal };
  });
  /*
   * 읽을 수 없는 제안 하나가 편성 기능 전체를 죽이던 자리.
   *
   * 실측 2026-08-25: 제안 계약에 필드를 하나 더했더니 이미 저장돼 있던 제안이
   * 검증에 걸렸고, 그 순간부터 prepare 도 getForChat 도 "store is corrupt" 로
   * 죽었다. 팀을 부르는 길이 통째로 막히고 푸는 방법도 없다.
   *
   * 파일이 JSON 이 아니거나 저장소 모양 자체가 다르면 그건 손상이 맞다(위에서
   * 이미 막았다). 그러나 제안 하나가 낡았다는 것은 그 제안을 버릴 이유이지
   * 나머지를 버릴 이유가 아니다. 버린 사실은 조용히 넘기지 않는다.
   */
  const usable: unknown[] = [];
  const dropped: string[] = [];
  for (const record of proposals) {
    if (isInternalProposal(record)) { usable.push(record); continue; }
    // 왜 버렸는지까지 남긴다. 개수만 세던 동안, 팀 대상을 못 읽는 결함이
    // 조용한 삭제 뒤에 숨어 있었다(감사 2026-08-25).
    dropped.push(describeUnreadableProposal(record));
  }
  const droppedProposalCount = dropped.length;
  if (droppedProposalCount > 0) {
    console.warn(`[one-team-preflight] dropped ${droppedProposalCount} unreadable proposal(s); ${usable.length} kept — ${dropped.join(" | ")}`);
  }
  return {
    state: { ...item, proposals: usable } as unknown as OneTeamPreflightStoreV1,
    migratedProposalCount: migratedProposalCount + droppedProposalCount,
  };
}

function readStore(db = getDb()): { state: OneTeamPreflightStoreV1; raw: string | null } {
  const row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_TEAM_PREFLIGHT_META_KEY) as { value: string } | undefined;
  if (!row) return { state: { schemaVersion: STORE_VERSION, version: 1, proposals: [] }, raw: null };
  const parsed = parseStore(row.value);
  if (parsed.migratedProposalCount < 1) return { state: parsed.state, raw: row.value };

  const migratedRaw = JSON.stringify(parsed.state);
  const persistKnownMigration = () => {
    const result = db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
      .run(migratedRaw, ONE_TEAM_PREFLIGHT_META_KEY, row.value);
    if (result.changes !== 1) throw new Error("One team preflight store changed concurrently");
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(ONE_TEAM_PREFLIGHT_REPAIR_META_KEY, JSON.stringify({
      repair: "add-derived-can-confirm-workforce",
      repairedAt: new Date().toISOString(),
      migratedProposalCount: parsed.migratedProposalCount,
      schemaVersion: STORE_VERSION,
    }));
  };
  if (db.inTransaction) persistKnownMigration();
  else db.transaction(persistKnownMigration).immediate();
  return { state: parsed.state, raw: migratedRaw };
}

function persistStore(state: OneTeamPreflightStoreV1, raw: string | null, db = getDb()): void {
  const next = JSON.stringify(state);
  if (raw === null) {
    const result = db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(ONE_TEAM_PREFLIGHT_META_KEY, next);
    if (result.changes !== 1) throw new Error("One team preflight store changed concurrently");
    return;
  }
  const result = db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").run(next, ONE_TEAM_PREFLIGHT_META_KEY, raw);
  if (result.changes !== 1) throw new Error("One team preflight store changed concurrently");
}

function mutateProposal(
  proposal: OneTeamPreflightProposal,
  status: OneTeamPreflightStatus,
  now: Date,
  patch: Partial<OneTeamPreflightProposal> = {},
): OneTeamPreflightProposal {
  const next: OneTeamPreflightProposal = {
    ...proposal,
    ...patch,
    status,
    version: proposal.version + 1,
    updatedAt: now.toISOString(),
  };
  if (!isOneTeamPreflightProposal(next)) throw new Error("One team preflight mutation violated the closed contract");
  return next;
}

function recoverReservations(deps: OneTeamPreflightDependencies): void {
  const db = getDb();
  const recover = db.transaction(() => {
    const { state, raw } = readStore(db);
    const now = nowFor(deps);
    let changed = false;
    state.proposals = state.proposals.map((record) => {
      const promptUnavailable = ["proposed", "blocked", "deferred"].includes(record.proposal.status)
        && record.main.preparedInstanceId !== PROCESS_INSTANCE_ID;
      const abandonedReservation = Boolean(
        record.reservation
        && record.reservation.ownerInstanceId !== PROCESS_INSTANCE_ID
        && !processAlive(record.reservation.ownerPid),
      );
      if (!promptUnavailable && !abandonedReservation) return record;
      changed = true;
      // PRD §4.30 — 여기서 지속 원장을 확인해 놓고 **결과를 버리고 있었다.** 그래서 실제로
      // 시작해 이미 비용을 쓴 실행까지 "복구 필요"로 표시됐고, 사용자가 복구를 누르면 같은
      // 일을 유료로 한 번 더 했다. 시작된 실행은 복구가 아니라 **이어보기**다.
      const startedRunId = record.reservation?.runId ?? null;
      const alreadyStarted = Boolean(
        startedRunId && (deps.hasRunReceipt ?? hasInvocationRunReceipt)(startedRunId),
      );
      PROCESS_PROMPTS.delete(record.proposal.proposalId);
      if (alreadyStarted && record.reservation) {
        const startedStatus = record.reservation.mode === "team"
          ? "team_started"
          : record.reservation.mode === "workforce" ? "workforce_started" : "solo_started";
        return {
          ...record,
          proposal: mutateProposal(record.proposal, startedStatus, now, {
            reservedRun: null,
            startedRun: {
              mode: record.reservation.mode,
              runId: record.reservation.runId,
              startedAt: record.proposal.startedRun?.startedAt ?? record.reservation.reservedAt,
            },
          }),
          reservation: null,
        };
      }
      return {
        ...record,
        proposal: mutateProposal(record.proposal, "recovery_required", now, {
          reservedRun: null,
          startedRun: null,
        }),
        reservation: null,
      };
    });
    if (!changed) return;
    state.version += 1;
    persistStore(state, raw, db);
  });
  recover.immediate();
}

function currentRecord(proposalId: string): InternalOneTeamPreflight | null {
  return readStore().state.proposals.find((item) => item.proposal.proposalId === proposalId) ?? null;
}

function expireIfNeeded(record: InternalOneTeamPreflight, deps: OneTeamPreflightDependencies): InternalOneTeamPreflight {
  if (!(ONE_TEAM_PREFLIGHT_EXPIRABLE_STATUSES as readonly string[]).includes(record.proposal.status)) return record;
  const now = nowFor(deps);
  if (Date.parse(record.proposal.expiresAt) > now.getTime()) return record;
  const db = getDb();
  const expire = db.transaction(() => {
    const { state, raw } = readStore(db);
    const index = state.proposals.findIndex((item) => item.proposal.proposalId === record.proposal.proposalId);
    if (index < 0) return record;
    const live = state.proposals[index];
    if (!(ONE_TEAM_PREFLIGHT_EXPIRABLE_STATUSES as readonly string[]).includes(live.proposal.status)) return live;
    const next = { ...live, proposal: mutateProposal(live.proposal, "expired", now), reservation: null };
    PROCESS_PROMPTS.delete(live.proposal.proposalId);
    state.version += 1;
    state.proposals[index] = next;
    persistStore(state, raw, db);
    return next;
  });
  return expire.immediate();
}

function validRuntimeSelection(value: unknown): value is RuntimeSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["kind", "backend", "source", "role", "inherit", "model", "longContext", "effort"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  if (typeof record.kind !== "string" || record.kind.length < 1 || record.kind.length > 64) return false;
  for (const key of ["backend", "source", "role", "model", "effort"] as const) {
    if (record[key] !== undefined && (typeof record[key] !== "string" || record[key].length > 512)) return false;
  }
  for (const key of ["inherit", "longContext"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") return false;
  }
  return true;
}

async function liveRuntime(
  deps: OneTeamPreflightDependencies,
  selection?: RuntimeSelection,
): Promise<OneTeamRuntimeBinding> {
  const runtimes = await (deps.detectRuntimes ?? detectRuntimes)();
  const active = selection
    ? selectExactRuntime(runtimes, selection)?.active ?? null
    : pickActive(runtimes);
  if (!active) {
    throw new OneTeamPreflightError(
      "runtime_changed",
      selection
        ? "The runtime selected in One is no longer available for this team"
        : "No active runtime is available for this team",
    );
  }
  return oneTeamRuntimeBinding(active);
}

function validateTaskInput(input: PrepareOneTeamPreflightInput, task: CanonicalTask | null): void {
  if (input.expectedTaskId === null) {
    if (input.expectedTaskVersion !== null || task) throw new OneTeamPreflightError("stale_binding", "The conversation became a Task before preflight");
    return;
  }
  if (
    !task
    || task.id !== input.expectedTaskId
    || input.expectedTaskVersion !== task.version
  ) throw new OneTeamPreflightError("stale_binding", "The Task changed before team preflight");
}

function taskVisibility(task: CanonicalTask): "personal" | "project" {
  return task.projectId ? "project" : "personal";
}

export async function prepareOneTeamPreflight(
  input: PrepareOneTeamPreflightInput,
  deps: OneTeamPreflightDependencies = {},
): Promise<PrepareOneTeamPreflightResult> {
  const inputKeys = Object.keys((input ?? {}) as unknown as Record<string, unknown>);
  const allowedInputKeys = new Set(["chatId", "expectedTaskId", "expectedTaskVersion", "userPrompt", "requestedAgentIds", "dynamicTeamRequested", "permission", "runtimeSelection"]);
  if (
    !input || typeof input !== "object"
    || inputKeys.some((key) => !allowedInputKeys.has(key))
    || !ID_RE.test(input.chatId)
    || typeof input.userPrompt !== "string"
    || input.userPrompt.trim().length < 1
    || input.userPrompt.length > MAX_PROMPT_CHARS
    || (input.expectedTaskId !== null && !ID_RE.test(input.expectedTaskId))
    || (input.expectedTaskVersion !== null && (!Number.isSafeInteger(input.expectedTaskVersion) || input.expectedTaskVersion < 1))
    || (input.requestedAgentIds !== undefined && (
      !Array.isArray(input.requestedAgentIds)
      || input.requestedAgentIds.length > 16
      || input.requestedAgentIds.some((agentId) => typeof agentId !== "string" || !ID_RE.test(agentId))
      || new Set(input.requestedAgentIds).size !== input.requestedAgentIds.length
    ))
    || (input.dynamicTeamRequested !== undefined && input.dynamicTeamRequested !== true)
    || (input.permission !== undefined && input.permission !== "read" && input.permission !== "write")
    || (input.runtimeSelection !== undefined && !validRuntimeSelection(input.runtimeSelection))
  ) throw new OneTeamPreflightError("invalid_request", "Invalid One team preflight request");
  const requestedAgentIds = input.requestedAgentIds ?? [];
  const teamNeed = await resolveOneTeamNeed(
    input.userPrompt,
    deps,
    requestedAgentIds.length > 0 || input.dynamicTeamRequested === true,
  );
  if (!teamNeed.needed) return { kind: "not_required" };
  const reasons = teamNeed.reasons;
  recoverReservations(deps);
  const readChat = deps.getChat ?? getChat;
  const chat = readChat(input.chatId);
  if (!chat) throw new OneTeamPreflightError("stale_binding", "The One conversation no longer exists");
  const findTask = deps.findTaskForChat ?? findCanonicalTaskForChat;
  const existingTask = findTask(chat.id);
  validateTaskInput(input, existingTask);
  const promptDigest = sha256(input.userPrompt);
  const existing = readStore().state.proposals.find((record) =>
    record.proposal.binding.chatId === chat.id
    && record.proposal.binding.promptDigest === promptDigest
    && ["proposed", "blocked", "deferred", "team_reserved", "workforce_reserved", "solo_reserved"].includes(record.proposal.status),
  );
  if (existing) {
    const current = expireIfNeeded(existing, deps);
    if (current.proposal.status !== "expired") return { kind: "proposal", proposal: current.proposal };
  }

  const runtime = await liveRuntime(deps, input.runtimeSelection);
  if (requestedAgentIds.length === 0) await prejudgeRosterAutoRoute(chat, input.userPrompt, deps);
  const permission = input.permission ?? "write";
  const roster = exactInstalledRoster(chat, deps, input.userPrompt, true, requestedAgentIds, permission);
  /*
   * 한 명이 못 오면 나머지도 버리던 자리(오너 지적 2026-08-24 "one만 일하냐?").
   * 실측: 방 팀원 둘 중 하나는 원본 폴더가 사라져 부를 수 없었는데, 그 한 명
   * 때문에 멀쩡한 팀원까지 편성이 막히고 One 혼자 답했다. 올 수 있는 사람이
   * 있으면 그들로 간다. 못 온 사람은 사유와 함께 제안에 실어 보여 준다.
   */
  const canConfirmTeam = roster.roles.length >= 2;
  // 사람이 앉힌 좌석 중 Hub borrow 가 하나라도 있으면 이 실행은 크레딧을 쓴다.
  // 카드가 "비용 없음"이라고 말하면 안 된다.
  const rosterBorrowsFromHub = roster.targets.some((target) => target.source === "hub");
  // When the installed roster cannot cover the work, external staffing is the
  // remaining route — not a dead end. Main already implements that run end to
  // end (`confirmed_external_workforce` + `hub-first`); this is the door that
  // lets One offer it in plain language instead of silently continuing solo.
  const canConfirmWorkforce = !canConfirmTeam;
  const ensureTask = deps.ensureTaskForChat ?? ensureCanonicalTaskForChat;
  if (!existingTask && !deps.ensureTaskForChat) retitleAutoTitledChatForTask(chat.id, input.userPrompt);
  const task = existingTask ?? ensureTask(chat.id);
  if (!task) throw new OneTeamPreflightError("stale_binding", "One could not materialize the canonical Task");
  const taskWasCreated = existingTask === null;
  const setTask = deps.setTaskStatus ?? setCanonicalTaskStatus;
  const waitingTask = task.status === "waiting-decision" ? task : setTask(task.id, "waiting-decision");
  const now = nowFor(deps);
  const proposal: OneTeamPreflightProposal = {
    contractVersion: ONE_TEAM_PREFLIGHT_CONTRACT_VERSION,
    proposalId: `team-proposal:${randomUUID()}`,
    version: 1,
    status: canConfirmTeam ? "proposed" : "blocked",
    goalSummary: goalSummary(reasons),
    unavailableMembers: roster.unresolvedMembers as OneTeamPreflightProposal["unavailableMembers"],
    binding: {
      chatId: chat.id,
      taskId: waitingTask.id,
      taskVersion: waitingTask.version,
      promptDigest,
      runtimeDigest: runtime.digest,
      permission,
    },
    complexityReasons: reasons,
    roles: canConfirmTeam ? roster.roles : roster.roles.slice(0, 1),
    cost: {
      hubBorrowing: canConfirmTeam && !rosterBorrowsFromHub ? "none" : "unknown",
      runtimeUsage: "unknown",
      currency: null,
      authoritativeQuoteRef: null,
    },
    selectionBoundary: canConfirmTeam
      ? "existing_exact_installed_roster_only"
      : "external_selection_requires_work_review",
    limitation: canConfirmTeam ? "none" : "external_candidates_not_prepared_before_execution",
    canConfirmTeam,
    canConfirmWorkforce,
    reservedRun: null,
    startedRun: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
  };
  if (!isOneTeamPreflightProposal(proposal)) throw new Error("One team preflight proposal violated the closed contract");
  const record: InternalOneTeamPreflight = {
    proposal,
    main: {
      preparedInstanceId: PROCESS_INSTANCE_ID,
      runtime,
      rosterDigest: sha256({
        candidates: roster.candidates,
        targets: roster.targets,
        unresolvedExternal: roster.unresolvedExternal,
      }),
      candidates: roster.candidates,
      taskForceTargets: canConfirmTeam ? roster.targets : [],
    },
    reservation: null,
  };
  const db = getDb();
  const persist = db.transaction(() => {
    const { state, raw } = readStore(db);
    const duplicate = state.proposals.find((item) =>
      item.proposal.binding.chatId === chat.id
      && item.proposal.binding.promptDigest === promptDigest
      && ["proposed", "blocked", "deferred", "team_reserved", "workforce_reserved", "solo_reserved"].includes(item.proposal.status),
    );
    if (duplicate) return duplicate.proposal;
    state.version += 1;
    // PRD §4.31 — 예전에는 들어온 순서로만 잘라내서, **예약이 잡혀 실행 중인 제안**도
    // 새 제안에 밀려 사라질 수 있었다. 그러면 그 예약은 청구도 해제도 못 한다.
    // 종결된 것부터 버리고, 살아 있는 예약은 절대 밀어내지 않는다.
    const appended = [...state.proposals, record];
    if (appended.length > MAX_PROPOSALS) {
      const live = (item: InternalOneTeamPreflight): boolean =>
        Boolean(item.reservation)
        || ["team_reserved", "workforce_reserved", "solo_reserved", "team_started", "workforce_started", "solo_started"].includes(item.proposal.status);
      const settled = appended.filter((item) => !live(item));
      const alive = appended.filter(live);
      const dropCount = appended.length - MAX_PROPOSALS;
      // 종결된 것부터, 오래된 순으로 버린다. 그래도 넘치면(살아 있는 예약만 남은 경우)
      // 더 버리지 않는다 — 축출로 청구를 잃는 것보다 상한을 넘기는 편이 낫다.
      const keptSettled = settled.slice(Math.min(dropCount, settled.length));
      for (const dropped of settled.slice(0, Math.min(dropCount, settled.length))) {
        PROCESS_PROMPTS.delete(dropped.proposal.proposalId);
      }
      state.proposals = appended.filter((item) => alive.includes(item) || keptSettled.includes(item));
    } else {
      state.proposals = appended;
    }
    persistStore(state, raw, db);
    return proposal;
  });
  const persisted = persist.immediate();
  if (persisted.proposalId !== proposal.proposalId) return { kind: "proposal", proposal: persisted };
  const standingStaffGuidance = oneOrgExecutionGuidance(requestedAgentIds);
  PROCESS_PROMPTS.set(proposal.proposalId, {
    original: input.userPrompt,
    execution: standingStaffGuidance ? `${input.userPrompt}\n\n${standingStaffGuidance}` : input.userPrompt,
    requestedAgentIds,
  });

  if (taskWasCreated) {
    tryRecordOneDomainEvent({
      eventId: `event:team-preflight-task-created:${proposal.proposalId.slice(-36)}`,
      eventType: "task.created",
      occurredAt: waitingTask.createdAt,
      actor: "one",
      entityId: waitingTask.id,
      ...(waitingTask.projectId ? { projectId: waitingTask.projectId } : {}),
      taskId: waitingTask.id,
      version: 1,
      visibility: taskVisibility(waitingTask),
      entries: [
        { name: "goalSummary", value: "Task created for an explicit adaptive-team review" },
        { name: "origin", value: "one_team_preflight" },
        ...(waitingTask.projectId ? [{ name: "projectId", value: waitingTask.projectId } as const] : []),
      ],
    });
  }
  if (task.status !== "waiting-decision") {
    tryRecordOneDomainEvent({
      eventId: `event:team-preflight-task-waiting:${proposal.proposalId.slice(-36)}`,
      eventType: "task.state_changed",
      occurredAt: waitingTask.updatedAt,
      actor: "one",
      entityId: waitingTask.id,
      ...(waitingTask.projectId ? { projectId: waitingTask.projectId } : {}),
      taskId: waitingTask.id,
      version: waitingTask.version,
      visibility: taskVisibility(waitingTask),
      entries: [
        { name: "from", value: task.status },
        { name: "to", value: "waiting-decision" },
        { name: "reason", value: "adaptive_team_preflight_auto_resolution" },
      ],
    });
  }
  if (canConfirmTeam) {
    tryRecordOneDomainEvent({
      eventId: `event:team-proposed:${proposal.proposalId.slice(-36)}`,
      eventType: "team.proposed",
      occurredAt: proposal.createdAt,
      actor: "one",
      entityId: proposal.proposalId,
      ...(waitingTask.projectId ? { projectId: waitingTask.projectId } : {}),
      taskId: waitingTask.id,
      version: proposal.version,
      visibility: taskVisibility(waitingTask),
      entries: [
        { name: "roleIds", value: proposal.roles.map((role) => role.roleId) },
        { name: "candidateReleaseRefs", value: proposal.roles.map((role) => role.candidate.releaseRef ?? `unversioned:${role.candidate.candidateRef}`) },
        { name: "rationaleRefs", value: proposal.roles.map((role) => role.rationaleRef) },
      ],
    });
  }
  return { kind: "proposal", proposal };
}

function exactCandidateSnapshots(
  record: InternalOneTeamPreflight,
  deps: OneTeamPreflightDependencies,
): boolean {
  const byId = deps.getAgentById ?? getAgentById;
  return record.main.candidates.every((expected) => {
    const current = byId(expected.installedAgentId);
    if (!current) return false;
    const actual = candidateSnapshot(current, expected.source);
    return canonicalJson(actual) === canonicalJson(expected);
  });
}

function exactRosterBinding(
  record: InternalOneTeamPreflight,
  chat: Chat,
  deps: OneTeamPreflightDependencies,
): boolean {
  const prompt = PROCESS_PROMPTS.get(record.proposal.proposalId);
  if (!prompt) return false;
  const current = exactInstalledRoster(chat, deps, prompt.original, true, prompt.requestedAgentIds, record.proposal.binding.permission);
  return sha256({
    candidates: current.candidates,
    targets: current.targets,
    unresolvedExternal: current.unresolvedExternal,
  }) === record.main.rosterDigest;
}

function exactTaskAndChat(
  record: InternalOneTeamPreflight,
  deps: OneTeamPreflightDependencies,
): { chat: Chat; task: CanonicalTask } | null {
  const chat = (deps.getChat ?? getChat)(record.proposal.binding.chatId);
  const task = (deps.getTask ?? getCanonicalTask)(record.proposal.binding.taskId);
  if (
    !chat || !task || task.originChatId !== chat.id
    || task.version !== record.proposal.binding.taskVersion
    || task.status !== "waiting-decision"
  ) return null;
  const prompt = PROCESS_PROMPTS.get(record.proposal.proposalId);
  if (!prompt || sha256(prompt.original) !== record.proposal.binding.promptDigest) return null;
  return { chat, task };
}

async function exactRevalidation(
  record: InternalOneTeamPreflight,
  deps: OneTeamPreflightDependencies,
): Promise<{ chat: Chat; task: CanonicalTask }> {
  const bound = exactTaskAndChat(record, deps);
  if (!bound) throw new OneTeamPreflightError("stale_binding", "The Task or conversation changed before team confirmation");
  if (!exactCandidateSnapshots(record, deps)) throw new OneTeamPreflightError("candidate_changed", "An installed team candidate changed before confirmation");
  if (!exactRosterBinding(record, bound.chat, deps)) throw new OneTeamPreflightError("candidate_changed", "The bound session roster changed before confirmation");
  const runtimes = await (deps.detectRuntimes ?? detectRuntimes)();
  if (
    record.main.runtime.digest !== record.proposal.binding.runtimeDigest
    || !oneTeamRuntimeBindingMatches(record.main.runtime, runtimes)
  ) {
    throw new OneTeamPreflightError("runtime_changed", "The selected runtime is no longer available; review the team again");
  }
  return bound;
}

function resolutionEvent(
  proposal: OneTeamPreflightProposal,
  task: CanonicalTask,
  selectedOption: string,
  actor: "user" | "one",
): void {
  if (actor !== "user") return;
  tryRecordOneDomainEvent({
    eventId: `event:team-approval-resolved:${proposal.proposalId.slice(-28)}:${proposal.version}`,
    eventType: "approval.resolved",
    occurredAt: proposal.updatedAt,
    actor: "user",
    entityId: proposal.proposalId,
    ...(task.projectId ? { projectId: task.projectId } : {}),
    taskId: task.id,
    version: proposal.version,
    visibility: taskVisibility(task),
    entries: [
      { name: "decisionId", value: proposal.proposalId },
      { name: "selectedOption", value: selectedOption },
      { name: "actor", value: "user" },
    ],
  });
}

export async function resolveOneTeamPreflight(
  input: ResolveOneTeamPreflightInput,
  deps: OneTeamPreflightDependencies = {},
  actor: "user" | "one" = "user",
): Promise<ResolveOneTeamPreflightResult> {
  if (
    !input || typeof input !== "object"
    || Object.keys(input as unknown as Record<string, unknown>).sort().join(",") !== "confirmedByUser,expectedProposalVersion,proposalId,requestedRunId,resolution"
    || !ID_RE.test(input.proposalId)
    || !Number.isSafeInteger(input.expectedProposalVersion) || input.expectedProposalVersion < 1
    || !["confirm_team", "confirm_workforce", "continue_solo", "later", "cancel"].includes(input.resolution)
    || input.confirmedByUser !== true
    || (input.requestedRunId !== null && !ID_RE.test(input.requestedRunId))
    || (["confirm_team", "confirm_workforce", "continue_solo"].includes(input.resolution) !== (input.requestedRunId !== null))
  ) throw new OneTeamPreflightError("invalid_request", "Invalid One team preflight resolution");
  recoverReservations(deps);
  let record = currentRecord(input.proposalId);
  if (!record) throw new OneTeamPreflightError("stale_binding", "The team proposal no longer exists");
  record = expireIfNeeded(record, deps);
  if (record.proposal.status === "expired") throw new OneTeamPreflightError("expired", "The team proposal expired; prepare it again");
  if (record.proposal.status === "recovery_required") throw new OneTeamPreflightError("recovery_required", "The reserved team run requires recovery review");
  const requestedMode = input.resolution === "confirm_team"
    ? "team"
    : input.resolution === "confirm_workforce"
      ? "workforce"
      : input.resolution === "continue_solo"
        ? "solo"
        : null;
  if (requestedMode && record.reservation) {
    if (record.reservation.mode === requestedMode && record.reservation.runId === input.requestedRunId) {
      const proposal = record.proposal;
      return {
        kind: "reserved",
        proposal,
        ref: {
          contractVersion: ONE_TEAM_PREFLIGHT_CONTRACT_VERSION,
          proposalId: proposal.proposalId,
          reservedRunId: record.reservation.runId,
          expectedTaskId: proposal.binding.taskId,
          expectedTaskVersion: proposal.binding.taskVersion,
          mode: requestedMode,
        },
      };
    }
    throw new OneTeamPreflightError("already_resolved", "This team proposal already owns a different run reservation");
  }
  if (record.proposal.version !== input.expectedProposalVersion) {
    throw new OneTeamPreflightError("stale_binding", "The team proposal changed; review the current version");
  }
  if (!["proposed", "blocked", "deferred"].includes(record.proposal.status)) {
    throw new OneTeamPreflightError("already_resolved", "This team proposal has already been resolved");
  }
  const bound = await exactRevalidation(record, deps);
  if (input.resolution === "confirm_team" && !record.proposal.canConfirmTeam) {
    throw new OneTeamPreflightError(
      "external_selection_unavailable",
      "External candidates, releases, and prices are not authoritative before Workforce execution; review them in Work",
    );
  }
  if (
    input.resolution === "confirm_workforce"
    && record.proposal.selectionBoundary !== "external_selection_requires_work_review"
  ) {
    throw new OneTeamPreflightError(
      "external_selection_unavailable",
      "This proposal already has an exact installed roster; confirm that roster instead",
    );
  }
  const now = nowFor(deps);
  if (input.resolution === "later" || input.resolution === "cancel") {
    const db = getDb();
    const resolve = db.transaction(() => {
      const { state, raw } = readStore(db);
      const index = state.proposals.findIndex((item) => item.proposal.proposalId === record!.proposal.proposalId);
      if (index < 0) throw new OneTeamPreflightError("stale_binding", "The team proposal no longer exists");
      const live = state.proposals[index];
      if (live.proposal.version !== input.expectedProposalVersion || live.reservation) {
        throw new OneTeamPreflightError("stale_binding", "The team proposal changed before resolution");
      }
      const proposal = mutateProposal(live.proposal, input.resolution === "later" ? "deferred" : "cancelled", now);
      state.version += 1;
      state.proposals[index] = { ...live, proposal, reservation: null };
      persistStore(state, raw, db);
      return proposal;
    });
    const proposal = resolve.immediate();
    if (input.resolution === "cancel") {
      (deps.setTaskStatus ?? setCanonicalTaskStatus)(bound.task.id, "open");
      PROCESS_PROMPTS.delete(proposal.proposalId);
    }
    resolutionEvent(proposal, bound.task, input.resolution, actor);
    return { kind: "resolved", proposal };
  }

  const runId = input.requestedRunId as string;
  const db = getDb();
  const reserve = db.transaction(() => {
    const { state, raw } = readStore(db);
    const index = state.proposals.findIndex((item) => item.proposal.proposalId === record!.proposal.proposalId);
    if (index < 0) throw new OneTeamPreflightError("stale_binding", "The team proposal no longer exists");
    const live = state.proposals[index];
    if (live.proposal.version !== input.expectedProposalVersion || live.reservation) {
      throw new OneTeamPreflightError("stale_binding", "The team proposal changed before reservation");
    }
    const reservedAt = now.toISOString();
    const reservedStatus = requestedMode === "team"
      ? "team_reserved"
      : requestedMode === "workforce"
        ? "workforce_reserved"
        : "solo_reserved";
    const proposal = mutateProposal(live.proposal, reservedStatus, now, {
      reservedRun: { mode: requestedMode as "team" | "workforce" | "solo", runId, reservedAt },
      startedRun: null,
    });
    const next: InternalOneTeamPreflight = {
      ...live,
      proposal,
      reservation: {
        ownerInstanceId: PROCESS_INSTANCE_ID,
        ownerPid: process.pid,
        mode: requestedMode as "team" | "workforce" | "solo",
        runId,
        reservedAt,
      },
    };
    state.version += 1;
    state.proposals[index] = next;
    persistStore(state, raw, db);
    return next;
  });
  const reserved = reserve.immediate();
  deps.afterReservation?.(reserved.proposal);
  resolutionEvent(reserved.proposal, bound.task, input.resolution, actor);
  return {
    kind: "reserved",
    proposal: reserved.proposal,
    ref: {
      contractVersion: ONE_TEAM_PREFLIGHT_CONTRACT_VERSION,
      proposalId: reserved.proposal.proposalId,
      reservedRunId: runId,
      expectedTaskId: reserved.proposal.binding.taskId,
      expectedTaskVersion: reserved.proposal.binding.taskVersion,
      mode: requestedMode as "team" | "workforce" | "solo",
    },
  };
}

/**
 * Resolve adaptive staffing without exposing an operational choice to the
 * user. Only a verified installed roster may be selected automatically. When
 * that proof is absent, One runs alone; this capability can never authorize
 * Hub discovery, borrowing, payment, or broader access.
 */
export async function autoResolveOneTeamPreflight(
  input: AutoResolveOneTeamPreflightInput,
  deps: OneTeamPreflightDependencies = {},
): Promise<ResolveOneTeamPreflightResult> {
  if (
    !input || typeof input !== "object"
    || Object.keys(input as unknown as Record<string, unknown>).sort().join(",") !== "expectedProposalVersion,proposalId,requestedRunId"
    || !ID_RE.test(input.proposalId)
    || !Number.isSafeInteger(input.expectedProposalVersion) || input.expectedProposalVersion < 1
    || !ID_RE.test(input.requestedRunId)
  ) throw new OneTeamPreflightError("invalid_request", "Invalid automatic One team resolution");

  recoverReservations(deps);
  let record = currentRecord(input.proposalId);
  if (!record) throw new OneTeamPreflightError("stale_binding", "The team proposal no longer exists");
  record = expireIfNeeded(record, deps);
  if (record.proposal.status === "expired") {
    throw new OneTeamPreflightError("expired", "The team proposal expired; prepare it again");
  }
  if (record.proposal.status === "recovery_required") {
    throw new OneTeamPreflightError("recovery_required", "The reserved team run requires recovery review");
  }

  // A workforce reservation is as real as a team or solo one; omitting it here
  // made an already-reserved external run look unresolved on the next turn.
  if (record.reservation && ["team_reserved", "workforce_reserved", "solo_reserved"].includes(record.proposal.status)) {
    const proposal = record.proposal;
    return {
      kind: "reserved",
      proposal,
      ref: {
        contractVersion: ONE_TEAM_PREFLIGHT_CONTRACT_VERSION,
        proposalId: proposal.proposalId,
        reservedRunId: record.reservation.runId,
        expectedTaskId: proposal.binding.taskId,
        expectedTaskVersion: proposal.binding.taskVersion,
        mode: record.reservation.mode,
      },
    };
  }

  // autoResolve is the no-user-approval path. External staffing can borrow paid
  // Hub agents, so it must never be entered automatically — One asks in plain
  // language first and the answer arrives through resolveOneTeamPreflight.
  const resolution: ResolveOneTeamPreflightInput["resolution"] = record.proposal.canConfirmTeam
    ? "confirm_team"
    : "continue_solo";
  return resolveOneTeamPreflight({
    proposalId: input.proposalId,
    expectedProposalVersion: input.expectedProposalVersion,
    resolution,
    requestedRunId: input.requestedRunId,
    confirmedByUser: true,
  }, deps, "one");
}

export function getOneTeamPreflightForChat(
  chatId: string,
  deps: OneTeamPreflightDependencies = {},
): OneTeamPreflightProposal | null {
  if (!ID_RE.test(chatId)) return null;
  recoverReservations(deps);
  const records = readStore().state.proposals
    .filter((item) => item.proposal.binding.chatId === chatId)
    .sort((left, right) => Date.parse(right.proposal.updatedAt) - Date.parse(left.proposal.updatedAt));
  return records[0] ? expireIfNeeded(records[0], deps).proposal : null;
}

export function acknowledgeOneTeamPreflight(
  input: AcknowledgeOneTeamPreflightInput,
  deps: OneTeamPreflightDependencies = {},
): AcknowledgeOneTeamPreflightResult {
  if (
    !input || typeof input !== "object"
    || Object.keys(input as unknown as Record<string, unknown>).sort().join(",") !== "confirmedByUser,expectedProposalVersion,proposalId"
    || !ID_RE.test(input.proposalId)
    || !Number.isSafeInteger(input.expectedProposalVersion) || input.expectedProposalVersion < 1
    || input.confirmedByUser !== true
  ) throw new OneTeamPreflightError("invalid_request", "Invalid One team preflight acknowledgement");

  recoverReservations(deps);
  const record = currentRecord(input.proposalId);
  if (!record) throw new OneTeamPreflightError("stale_binding", "The team proposal no longer exists");
  const terminal = expireIfNeeded(record, deps);
  if (terminal.proposal.version !== input.expectedProposalVersion) {
    throw new OneTeamPreflightError("stale_binding", "The team proposal changed before acknowledgement");
  }
  if (!['expired', 'cancelled'].includes(terminal.proposal.status)) {
    throw new OneTeamPreflightError("already_resolved", "Only a terminal team proposal can be acknowledged");
  }

  const db = getDb();
  const acknowledged = db.transaction(() => {
    const { state, raw } = readStore(db);
    const index = state.proposals.findIndex((item) => item.proposal.proposalId === terminal.proposal.proposalId);
    if (index < 0) throw new OneTeamPreflightError("stale_binding", "The team proposal no longer exists");
    const live = state.proposals[index];
    if (live.proposal.version !== terminal.proposal.version || live.proposal.status !== terminal.proposal.status) {
      throw new OneTeamPreflightError("stale_binding", "The team proposal changed before acknowledgement");
    }
    state.version += 1;
    state.proposals.splice(index, 1);
    persistStore(state, raw, db);
    return {
      acknowledged: true as const,
      proposalId: live.proposal.proposalId,
      chatId: live.proposal.binding.chatId,
      acknowledgedProposalVersion: live.proposal.version,
    };
  }).immediate();
  PROCESS_PROMPTS.delete(input.proposalId);
  return acknowledged;
}

export function prepareOneTeamPreflightClaim(
  ref: OneTeamPreflightRef,
  chatId: string,
  deps: OneTeamPreflightDependencies = {},
): PreparedOneTeamPreflightClaim {
  if (
    !ref || typeof ref !== "object"
    || Object.keys(ref as unknown as Record<string, unknown>).sort().join(",") !== "contractVersion,expectedTaskId,expectedTaskVersion,mode,proposalId,reservedRunId"
    || ref.contractVersion !== ONE_TEAM_PREFLIGHT_CONTRACT_VERSION
    || !ID_RE.test(ref.proposalId) || !ID_RE.test(ref.reservedRunId)
    || !ID_RE.test(ref.expectedTaskId) || !Number.isSafeInteger(ref.expectedTaskVersion)
    || !["team", "workforce", "solo"].includes(ref.mode) || ref.expectedTaskVersion < 1
  ) throw new Error("Invalid One team preflight capability");
  recoverReservations(deps);
  const record = currentRecord(ref.proposalId);
  if (!record || !record.reservation) throw new Error("One team preflight capability is unavailable");
  if (
    record.reservation.ownerInstanceId !== PROCESS_INSTANCE_ID
    || record.reservation.mode !== ref.mode
    || record.reservation.runId !== ref.reservedRunId
    || record.proposal.binding.chatId !== chatId
    || record.proposal.binding.taskId !== ref.expectedTaskId
    || record.proposal.binding.taskVersion !== ref.expectedTaskVersion
    || record.proposal.status !== (
      ref.mode === "team" ? "team_reserved" : ref.mode === "workforce" ? "workforce_reserved" : "solo_reserved"
    )
  ) throw new Error("One team preflight reservation changed");
  if (!exactTaskAndChat(record, deps)) throw new Error("One team preflight Task binding changed");
  if (!exactCandidateSnapshots(record, deps)) throw new Error("One team preflight candidate binding changed");
  const boundChat = (deps.getChat ?? getChat)(chatId);
  if (!boundChat || !exactRosterBinding(record, boundChat, deps)) throw new Error("One team preflight roster binding changed");
  const prompt = PROCESS_PROMPTS.get(record.proposal.proposalId);
  if (!prompt || sha256(prompt.original) !== record.proposal.binding.promptDigest) {
    throw new Error("One team preflight prompt capability is unavailable");
  }
  return {
    ref,
    proposalId: record.proposal.proposalId,
    chatId,
    taskId: ref.expectedTaskId,
    taskVersion: ref.expectedTaskVersion,
    mode: ref.mode,
    // The exact user text is process-bound and digest-verified above. Execution
    // mode travels separately in the closed ref; prompt text never carries it.
    userPrompt: prompt.execution,
    permission: record.proposal.binding.permission,
    runtime: record.main.runtime,
    taskForceTargets: ref.mode === "team" ? record.main.taskForceTargets.map((target) => ({ ...target })) : [],
  };
}

export function claimPreparedOneTeamPreflight(
  prepared: PreparedOneTeamPreflightClaim,
  now = new Date(),
): OneTeamPreflightProposal {
  const db = getDb();
  const claim = db.transaction(() => {
    const { state, raw } = readStore(db);
    const index = state.proposals.findIndex((item) => item.proposal.proposalId === prepared.proposalId);
    if (index < 0) throw new Error("One team preflight capability is unavailable");
    const record = state.proposals[index];
    if (
      !record.reservation
      || record.reservation.ownerInstanceId !== PROCESS_INSTANCE_ID
      || record.reservation.mode !== prepared.mode
      || record.reservation.runId !== prepared.ref.reservedRunId
      || record.proposal.binding.taskId !== prepared.taskId
      || record.proposal.binding.taskVersion !== prepared.taskVersion
    ) throw new Error("One team preflight capability changed before claim");
    const startedStatus = prepared.mode === "team"
      ? "team_started"
      : prepared.mode === "workforce"
        ? "workforce_started"
        : "solo_started";
    const proposal = mutateProposal(record.proposal, startedStatus, now, {
      reservedRun: null,
      startedRun: { mode: prepared.mode, runId: prepared.ref.reservedRunId, startedAt: now.toISOString() },
    });
    state.version += 1;
    state.proposals[index] = { ...record, proposal, reservation: null };
    persistStore(state, raw, db);
    return proposal;
  });
  const proposal = claim.immediate();
  PROCESS_PROMPTS.delete(prepared.proposalId);
  if (prepared.mode === "team") {
    const task = getCanonicalTask(prepared.taskId);
    if (task) {
      tryRecordOneDomainEvent({
        eventId: `event:team-assigned:${proposal.proposalId.slice(-28)}:${proposal.version}`,
        eventType: "team.assigned",
        occurredAt: proposal.startedRun?.startedAt ?? now.toISOString(),
        actor: "one",
        entityId: proposal.proposalId,
        ...(task.projectId ? { projectId: task.projectId } : {}),
        taskId: task.id,
        version: proposal.version,
        visibility: taskVisibility(task),
        entries: [
          { name: "roleToReleaseMap", value: proposal.roles.map((role) => `${role.roleId}=${role.candidate.releaseRef ?? `installed-unversioned:${role.candidate.candidateRef}`}`) },
          { name: "permissionScopes", value: [...new Set(proposal.roles.flatMap((role) => role.permissionScopes))] },
        ],
      });
    }
  }
  return proposal;
}

export function failOneTeamPreflightStart(
  ref: OneTeamPreflightRef,
  now = new Date(),
): OneTeamPreflightProposal | null {
  const db = getDb();
  const fail = db.transaction(() => {
    const { state, raw } = readStore(db);
    const index = state.proposals.findIndex((item) => item.proposal.proposalId === ref.proposalId);
    if (index < 0) return null;
    const record = state.proposals[index];
    if (
      !record.reservation
      || record.reservation.ownerInstanceId !== PROCESS_INSTANCE_ID
      || record.reservation.mode !== ref.mode
      || record.reservation.runId !== ref.reservedRunId
    ) return record.proposal;
    const proposal = mutateProposal(record.proposal, "recovery_required", now, {
      reservedRun: null,
      startedRun: null,
    });
    state.version += 1;
    state.proposals[index] = { ...record, proposal, reservation: null };
    PROCESS_PROMPTS.delete(record.proposal.proposalId);
    persistStore(state, raw, db);
    return proposal;
  });
  return fail.immediate();
}
