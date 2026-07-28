import { isPrimarilyKorean, preferredLocaleFromText } from "../../shared/detect-language";
import { createHash, randomUUID } from "node:crypto";
import { detectRuntimes } from "../runtime/detect";
import { pickActive } from "../runtime/selection";
import { isPlainConversationalPrompt, selectAutoRoutedAgent, selectAutoRoutedAgentJudged } from "../agents/auto-router";
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
import { isCompletedOneOnboardingStarterGroup } from "./onboarding";
import type {
  CanonicalTask,
  Chat,
  InstalledAgent,
  OrchestrationTarget,
  RuntimeStatus,
} from "../../shared/types";
import {
  ONE_TEAM_PREFLIGHT_CONTRACT_VERSION,
  isOneTeamPreflightProposal,
  type AutoResolveOneTeamPreflightInput,
  type OneTeamPreflightComplexityReason,
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

const STORE_VERSION = 1 as const;
const MAX_PROPOSALS = 100;
const MAX_PROMPT_CHARS = 32_000;
const PROPOSAL_TTL_MS = 30 * 60 * 1_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROCESS_INSTANCE_ID = randomUUID();
const PROCESS_PROMPTS = new Map<string, { original: string; execution: string }>();

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
  source: "installed" | "firm-node";
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
  const active = pickActive(runtimes);
  return Boolean(active && oneTeamRuntimeBinding(active).digest === binding.digest);
}

/** Structured multi-agent commands are format signals — closed-form, never judged away. */
const EXPLICIT_TEAM_COMMAND_RE = /^\s*(?:\/?workforce\b|\/?hep-network\b)/i;

function complexityReasons(prompt: string): OneTeamPreflightComplexityReason[] {
  if (isPlainConversationalPrompt(prompt)) return [];
  const reasons: OneTeamPreflightComplexityReason[] = [];
  if (/^\s*(?:\/?workforce\b|\/?hep-network\b)|(?:팀으로|여러\s*(?:에이전트|전문가)|역할\s*분담|task\s*force|agent\s*team|as\s+a\s+team)/i.test(prompt)) {
    reasons.push("explicit_team_request");
  }
  if (/(?:병렬|동시에|나눠서|각자|parallel|in\s+parallel|split\s+(?:the\s+)?work|divide\s+(?:the\s+)?work)/i.test(prompt)) {
    reasons.push("parallel_work_requested");
  }
  if (/(?:교차\s*검증|독립\s*검증|팩트\s*체크|출처\s*검증|double[- ]?check|cross[- ]?check|independent\s+verif|fact[- ]?check)/i.test(prompt)) {
    reasons.push("independent_verification_requested");
  }
  const deliverableMatches = prompt.match(
    /(?:보고서|표|스프레드시트|프레젠테이션|영상|이미지|문서|코드|테스트|report|table|spreadsheet|deck|presentation|video|image|document|code|tests?)/gi,
  ) ?? [];
  if (new Set(deliverableMatches.map((item) => item.toLowerCase())).size >= 2) {
    reasons.push("multiple_distinct_deliverables");
  }
  const asksForResearchDecision =
    /(?:비교|조사|리서치|추천|찾아|골라|선택|시장|경쟁사|후보|compare|research|recommend|find|choose|select|market|competitor|candidate)/i.test(prompt);
  const hasMeaningfulConstraints =
    /(?:\d[\d,.]*\s*(?:원|만원|달러|usd|krw|%|평|명|개|일|주|개월|년)|예산|가격|이하|이상|미만|초과|사이|조건|기준|장단점|우리\s*(?:집|회사|팀)|budget|price|under|over|at\s+(?:least|most)|between|criteria|trade[- ]?offs?|for\s+(?:our|my)\s+(?:home|company|team))/i.test(prompt);
  if (asksForResearchDecision && hasMeaningfulConstraints) {
    reasons.push("constrained_research_decision");
  }
  return [...new Set(reasons)];
}

/**
 * 표시용 목표 문장. 명령어와 그 플래그를 걷어낸다.
 *
 * `--stormbreaker` 가 목록에서 빠져 있어서, 그 플래그가 목표 문장에 눌러앉은 채
 * 복원 단계를 지나면 **목표가 리터럴 `"--stormbreaker X"` 가 되어 그대로 검색에
 * 전달됐다**(2026-07-28 확인). 이건 표시용 문자열이므로 알려진 플래그는 전부 걷는다.
 */
/** 원문이 워크포스 명령으로 시작하는가. 복원과 외부선택 판정이 같은 기준을 써야 한다. */
const WORKFORCE_COMMAND_RE = /^\s*(?:\/?workforce\b|\/?hep-network\b)/i;

/**
 * 실행 단계로 넘길 프롬프트를 되돌린다. **순수 함수로 내보내는 이유**: 이 규칙이 깨지면
 * 플래그가 사라지거나 목표 문자열로 새어 들어가는데, 소스 문자열 검사로는 그걸 못 잡는다.
 * 테스트가 진짜 이 함수를 불러야 규칙 복제본이 아니라 실제 동작을 검사하게 된다.
 */
export function restoreWorkforcePrompt(
  // `solo` 도 온다. 워크포스가 아닌 모드는 전부 표시용 문장을 그대로 쓴다.
  mode: "workforce" | "team" | "solo",
  original: string,
  execution: string,
): string {
  if (mode !== "workforce") return execution;
  // 원문을 그대로 돌려준다. 재조립(`/workforce ${execution}`)은 두 가지를 잃었다:
  //   · `--benchmark` / `--legacy` 가 사라져 One 경로에서는 도달 불가였고,
  //   · `/hep-network --stormbreaker` 가 `/workforce --stormbreaker` 로 바뀌어
  //     파서의 escape 를 비껴가 목표가 리터럴 `"--stormbreaker …"` 가 됐다.
  // 원문은 호출부에서 `promptDigest` 로 검증된다. 명령어가 없는 원문(One 이 스스로
  // 워크포스를 고른 경우)만 접두어를 붙인다 — 그때는 재조립이 아니라 유일한 표현이다.
  return WORKFORCE_COMMAND_RE.test(original) ? original.trim() : `/workforce ${execution}`;
}

/** 테스트 전용 별칭. 표시용 정규화 규칙을 테스트가 복제하지 않게 한다. */
export function stripWorkforceCommandForTest(prompt: string): string {
  return stripWorkforceCommand(prompt);
}

function stripWorkforceCommand(prompt: string): string {
  const stripped = prompt
    .replace(/^\s*(?:\/?workforce\b|\/?hep-network\b)(?:\s+--(?:benchmark|legacy|stormbreaker)\b)*\s*/i, "")
    .trim();
  return stripped || prompt.trim();
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
  /** "llm" = the resident judge decided; "fallback" = today's wordlist verdict, labeled. */
  source: "llm" | "fallback";
}

export type OneTeamNeedJudge = (input: {
  prompt: string;
  lexicalReasons: OneTeamPreflightComplexityReason[];
}) => Promise<{ needed: boolean; source: "llm" | "fallback"; reason: string }>;

async function defaultJudgeTeamNeed(input: {
  prompt: string;
  lexicalReasons: OneTeamPreflightComplexityReason[];
}): Promise<{ needed: boolean; source: "llm" | "fallback"; reason: string }> {
  const { judgeBoolean } = await import("../system-agents/judgment");
  const { value, verdict } = await judgeBoolean({
    kind: "one-team-preflight-need",
    question:
      "Would completing this request genuinely benefit from a small team of multiple specialist agents (parallel work, independent verification, or multiple distinct deliverables) instead of one agent?",
    input: input.prompt.slice(0, 4_000),
    guidance:
      `A deterministic pre-pass found ${input.lexicalReasons.length} complexity signal(s)` +
      `${input.lexicalReasons.length ? ` (${input.lexicalReasons.join(", ")})` : ""}. Treat that as a prior, not a fact. ` +
      "Judge the actual work, in any language: a short single-deliverable request is not team work even when it " +
      "mentions comparison words, and a genuinely parallel/multi-deliverable request needs a team even when no " +
      "reference word appears. Say yes only when a team adds real value.",
    hints: [
      { label: "yes", words: ["팀으로", "여러 에이전트", "역할 분담", "병렬", "동시에", "교차 검증", "as a team", "in parallel", "split the work", "cross-check", "fact-check"] },
    ],
    fallback: input.lexicalReasons.length > 0,
  });
  return { needed: value, source: verdict.source, reason: verdict.reason };
}

/**
 * The resident judge decides whether a team preflight is worth proposing; the
 * complexity regexes above are demoted to hints/prior and remain only the
 * labeled fallback when no model answers. Structured `/workforce`·`/hep-network`
 * commands are closed-form and are never vetoed by the judge.
 */
async function resolveOneTeamNeed(
  prompt: string,
  deps: OneTeamPreflightDependencies,
): Promise<OneTeamNeedResolution> {
  const lexicalReasons = complexityReasons(prompt);
  if (EXPLICIT_TEAM_COMMAND_RE.test(prompt)) {
    return {
      needed: true,
      reasons: lexicalReasons.length > 0 ? lexicalReasons : ["explicit_team_request"],
      source: "fallback",
    };
  }
  if (isPlainConversationalPrompt(prompt)) {
    return { needed: false, reasons: [], source: "fallback" };
  }
  const judgeTeamNeed = deps.judgeTeamNeed ?? defaultJudgeTeamNeed;
  let judged: Awaited<ReturnType<OneTeamNeedJudge>>;
  try {
    judged = await judgeTeamNeed({ prompt, lexicalReasons });
  } catch {
    judged = { needed: false, source: "fallback", reason: "judge failed" };
  }
  if (judged.source !== "llm") {
    // No connected model → do NOT auto-propose a team from the complexity
    // wordlists. Only an explicit /workforce·/hep-network command (closed-form,
    // handled above) staffs a team without a model verdict.
    return { needed: false, reasons: [], source: "fallback" };
  }
  if (!judged.needed) return { needed: false, reasons: [], source: "llm" };
  return {
    needed: true,
    reasons: lexicalReasons.length > 0 ? lexicalReasons : ["model_assessed_team_benefit"],
    source: "llm",
  };
}

function inputScopes(chat: Chat): OneTeamPreflightRole["inputScopes"] {
  return chat.projectId
    ? ["current_user_request", "approved_one_profile_memory", "bound_project_workspace"]
    : ["current_user_request", "approved_one_profile_memory"];
}

function permissionScopes(): OneTeamPreflightRole["permissionScopes"] {
  return ["workspace.read", "workspace.write", "external.recruitment.denied", "external.payment.denied"];
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
      entityKind: "agent",
      availability: "installed_present",
      releaseState: candidate.packageHash ? "exact_package_hash" : "installed_release_unversioned",
      releaseRef: candidate.packageHash,
    },
    inputScopes: inputScopes(chat),
    permissionScopes: permissionScopes(),
    expectedOutput: coordinator
      ? "One integrated result with each specialist contribution and unresolved items identified."
      : `One bounded contribution within ${agent.taglineEn || agent.tagline || "the installed specialist's declared scope"}; return it to the coordinator for synthesis.`,
    rationaleRef: shortRef("rationale", [candidate.candidateRef, rationaleBasis]),
  };
}

function eligibleRosterSpecialists(all: InstalledAgent[], coordinatorId: string): InstalledAgent[] {
  return all.filter((installed) =>
    installed.id !== coordinatorId
    && installed.kind !== "team"
    && !installed.sourceMissingSince
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
    // Best-effort warm; the sync roster path keeps the labeled lexical fallback.
  }
}

function exactInstalledRoster(
  chat: Chat,
  deps: OneTeamPreflightDependencies,
  prompt?: string,
  allowDeterministicLocalSelection = true,
): {
  roles: OneTeamPreflightRole[];
  candidates: CandidateSnapshot[];
  targets: OrchestrationTarget[];
  unresolvedExternal: boolean;
} {
  const byId = deps.getAgentById ?? getAgentById;
  const all = deps.listInstalledAgents ?? listInstalledAgents;
  const coordinator = byId(chat.agentId);
  if (!coordinator) throw new OneTeamPreflightError("candidate_changed", "The One coordinator is no longer installed");
  const candidates: CandidateSnapshot[] = [candidateSnapshot(coordinator, "installed")];
  const roles: OneTeamPreflightRole[] = [roleFromCandidate(coordinator, candidates[0], chat, true)];
  const targets: OrchestrationTarget[] = [];
  let unresolvedExternal = false;
  const seen = new Set([coordinator.id]);
  for (const card of chat.hiredAgents.slice(0, 15)) {
    if (card.source !== "installed" && card.source !== "firm-node") {
      unresolvedExternal = true;
      continue;
    }
    const matches = all().filter((agent) => agent.id === card.slug || agent.slug === card.slug);
    const installed = matches.length === 1 ? matches[0] : null;
    if (!installed || installed.kind === "team" || seen.has(installed.id)) {
      unresolvedExternal = true;
      continue;
    }
    seen.add(installed.id);
    const snapshot = candidateSnapshot(installed, card.source);
    candidates.push(snapshot);
    roles.push(roleFromCandidate(installed, snapshot, chat, false));
    targets.push({ source: "local", entityKind: "agent", agentId: installed.id });
  }
  if (
    allowDeterministicLocalSelection
    && prompt
    && roles.length === 1
    && !unresolvedExternal
  ) {
    const eligible = eligibleRosterSpecialists(all(), coordinator.id);
    const locale = preferredLocaleFromText(prompt);
    // Synchronous site: reads the judged routing verdict warmed by the async
    // prepare path (prejudgeRosterAutoRoute); a cache miss keeps the labeled
    // lexical fallback, and propose/revalidate stay digest-consistent because
    // both read the same session cache.
    const selected = selectAutoRoutedAgent(prompt, eligible, locale, { allowFallback: false });
    if (selected) {
      const snapshot = candidateSnapshot(selected.agent, "installed");
      candidates.push(snapshot);
      roles.push(roleFromCandidate(
        selected.agent,
        snapshot,
        chat,
        false,
        `deterministic-local-route:${selected.matchedTerms.slice().sort().join("|") || "curated-hint"}`,
      ));
      targets.push({ source: "local", entityKind: "agent", agentId: selected.agent.id });
    }
  }
  return { roles, candidates, targets, unresolvedExternal };
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
    && ["installed", "firm-node"].includes(String(item.source));
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

function isLocalAgentTarget(value: unknown): value is OrchestrationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(",") === "agentId,entityKind,source"
    && item.source === "local" && item.entityKind === "agent"
    && typeof item.agentId === "string" && item.agentId.length > 0 && item.agentId.length <= 256;
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

function parseStore(raw: string): OneTeamPreflightStoreV1 {
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
    || !item.proposals.every(isInternalProposal)
  ) throw new Error("One team preflight store is corrupt; it was not overwritten");
  return value as OneTeamPreflightStoreV1;
}

function readStore(db = getDb()): { state: OneTeamPreflightStoreV1; raw: string | null } {
  const row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1").get(ONE_TEAM_PREFLIGHT_META_KEY) as { value: string } | undefined;
  return row
    ? { state: parseStore(row.value), raw: row.value }
    : { state: { schemaVersion: STORE_VERSION, version: 1, proposals: [] }, raw: null };
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
      if (record.reservation) {
        // Probe the durable start ledger before clearing the process-local
        // capability. Both outcomes remain recovery-only; neither auto-retries.
        void (deps.hasRunReceipt ?? hasInvocationRunReceipt)(record.reservation.runId);
      }
      PROCESS_PROMPTS.delete(record.proposal.proposalId);
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
  if (!["proposed", "blocked", "deferred"].includes(record.proposal.status)) return record;
  const now = nowFor(deps);
  if (Date.parse(record.proposal.expiresAt) > now.getTime()) return record;
  const db = getDb();
  const expire = db.transaction(() => {
    const { state, raw } = readStore(db);
    const index = state.proposals.findIndex((item) => item.proposal.proposalId === record.proposal.proposalId);
    if (index < 0) return record;
    const live = state.proposals[index];
    if (!["proposed", "blocked", "deferred"].includes(live.proposal.status)) return live;
    const next = { ...live, proposal: mutateProposal(live.proposal, "expired", now), reservation: null };
    PROCESS_PROMPTS.delete(live.proposal.proposalId);
    state.version += 1;
    state.proposals[index] = next;
    persistStore(state, raw, db);
    return next;
  });
  return expire.immediate();
}

async function liveRuntime(deps: OneTeamPreflightDependencies): Promise<OneTeamRuntimeBinding> {
  const runtimes = await (deps.detectRuntimes ?? detectRuntimes)();
  const active = pickActive(runtimes);
  if (!active) throw new OneTeamPreflightError("runtime_changed", "No active runtime is available for this team");
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
  if (
    !input || typeof input !== "object"
    || Object.keys(input as unknown as Record<string, unknown>).sort().join(",") !== "chatId,expectedTaskId,expectedTaskVersion,userPrompt"
    || !ID_RE.test(input.chatId)
    || typeof input.userPrompt !== "string"
    || input.userPrompt.trim().length < 1
    || input.userPrompt.length > MAX_PROMPT_CHARS
    || (input.expectedTaskId !== null && !ID_RE.test(input.expectedTaskId))
    || (input.expectedTaskVersion !== null && (!Number.isSafeInteger(input.expectedTaskVersion) || input.expectedTaskVersion < 1))
  ) throw new OneTeamPreflightError("invalid_request", "Invalid One team preflight request");
  // The resident judge decides whether multi-agent preflight is genuinely needed;
  // the complexity regexes are hints, and without a model the wordlist verdict is
  // only the labeled fallback (today's behavior).
  const teamNeed = await resolveOneTeamNeed(input.userPrompt, deps);
  if (!teamNeed.needed) return { kind: "not_required" };
  const reasons = teamNeed.reasons;
  recoverReservations(deps);
  const readChat = deps.getChat ?? getChat;
  const chat = readChat(input.chatId);
  if (!chat) throw new OneTeamPreflightError("stale_binding", "The One conversation no longer exists");
  const findTask = deps.findTaskForChat ?? findCanonicalTaskForChat;
  const existingTask = findTask(chat.id);
  validateTaskInput(input, existingTask);
  // The user already assembled and explicitly confirmed this exact immutable
  // Hub roster during onboarding. Do not replace that saved team with an
  // unrelated automatic local-roster proposal; the invocation layer will
  // re-resolve every pinned release and fail closed before execution.
  if (chat.agentGroupId && isCompletedOneOnboardingStarterGroup(chat.agentGroupId)) {
    return { kind: "not_required" };
  }

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

  const explicitExternalSelection = /^\s*(?:\/?workforce\b|\/?hep-network\b)/i.test(input.userPrompt);
  const runtime = await liveRuntime(deps);
  if (!explicitExternalSelection) await prejudgeRosterAutoRoute(chat, input.userPrompt, deps);
  const roster = exactInstalledRoster(chat, deps, input.userPrompt, !explicitExternalSelection);
  const canConfirmTeam = roster.roles.length >= 2 && !roster.unresolvedExternal && !explicitExternalSelection;
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
    binding: {
      chatId: chat.id,
      taskId: waitingTask.id,
      taskVersion: waitingTask.version,
      promptDigest,
      runtimeDigest: runtime.digest,
      permission: "write",
    },
    complexityReasons: reasons,
    roles: canConfirmTeam ? roster.roles : roster.roles.slice(0, 1),
    cost: {
      hubBorrowing: canConfirmTeam ? "none" : "unknown",
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
    state.proposals = [...state.proposals, record].slice(-MAX_PROPOSALS);
    persistStore(state, raw, db);
    return proposal;
  });
  const persisted = persist.immediate();
  if (persisted.proposalId !== proposal.proposalId) return { kind: "proposal", proposal: persisted };
  PROCESS_PROMPTS.set(proposal.proposalId, {
    original: input.userPrompt,
    execution: stripWorkforceCommand(input.userPrompt),
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
  const explicitExternalSelection = WORKFORCE_COMMAND_RE.test(prompt.original);
  const current = exactInstalledRoster(chat, deps, prompt.original, !explicitExternalSelection);
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
  const runtime = await liveRuntime(deps);
  if (runtime.digest !== record.main.runtime.digest || runtime.digest !== record.proposal.binding.runtimeDigest) {
    throw new OneTeamPreflightError("runtime_changed", "The active runtime changed; review the team again");
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
    // 원문을 그대로 돌려준다. 재조립(`/workforce ${execution}`)은 두 가지를 잃었다:
    //   · `--benchmark` / `--legacy` 가 사라져 One 경로에서는 도달 불가였고,
    //   · `/hep-network --stormbreaker` 가 `/workforce --stormbreaker` 로 바뀌어
    //     파서의 escape 를 비껴가 목표가 리터럴 `"--stormbreaker …"` 가 됐다.
    // 원문은 바로 위에서 `promptDigest` 로 검증되므로 신뢰할 수 있다. 명령어가 없는
    // 원문(One 이 스스로 워크포스를 고른 경우)만 접두어를 붙인다 — 그때는 재조립이
    // 아니라 유일한 표현이다.
    userPrompt: restoreWorkforcePrompt(ref.mode, prompt.original, prompt.execution),
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
