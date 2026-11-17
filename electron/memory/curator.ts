// Memory governance boundary — runs after EVERY completed turn. A no-tools
// semantic Curator may propose disposition/scope; deterministic policy remains
// the final privacy, owner isolation, deduplication, graph, and write authority.
import {
  type AgentNestExperienceItem,
  appendMemoryLog,
  appendSoulMemory,
} from "./project-files";
import { appendMemoryOrigins, findEquivalentMemoryId, insertMemoryEntry, MemoryStoreFullError, personalCeilingClassOf, type RequestContext } from "./store";
import { peekExplicitSupersedeTarget, supersedeExplicitMemory, supersedeRestatedMemories } from "./graph";
import { notifyMemoryWritten } from "./memory-written-signal";
import { releaseOldestOwnPreference } from "./share-ceiling";
import { SHARED_KIND_SQL, noteSaidAgain, sharedOpenHere } from "./shared-ids";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { isAutomationLedgerChat } from "./automation-surface";
import {
  beginMemoryProjectionWrite,
  commitMemoryProjectionWrites,
  MemoryRevokedError,
  type MemoryProjectionWriterLease,
} from "./revocations";
import {
  parseMemoryEvents,
  stripAllMemoryEventBlocks,
  type RawMemoryEvent,
} from "./events";
import { MEMORY_KINDS, type MemoryKind, type MemoryScope } from "../architecture/manifest";
import { tryRecordRunEvent } from "../store/run-events";
import { currentUiLocale } from "../ui-locale";
import { policyTurnSummary } from "./policy-turn-summary";
import { ORIGIN_INSTRUCTION, ORIGIN_OWNER_SPOKE, runEvidenceRef } from "./run-evidence";
import { deriveOrigin, type TurnFacts } from "./origin-class";
import { groundedInOwnerWords } from "../one/turn-memory-exclusion";

// Secret/credential detection — events matching these are dropped, never stored.
// Shared with every other write boundary; this file used to carry its own shorter list that
// missed github_pat_/gho_/AIza/glpat/hf_/npm_/JWT/sk_live_ while other boundaries caught them.
// looksSecret is the single chokepoint before memory writes, including the agent_repo nest
// mirroring that crosses projects — a miss here reaches the widest surface in the product.
import { looksSecret } from "../../shared/secret-patterns";
import { memoryActorKind, normalizeMemoryOwnership, residentAgentRepoBelongsToProject } from "../../shared/memory-ownership";
import { classifyStage1, classifyStage2, lowerConfidence, personalMinConfidence, tokenContainment, tokenOverlap, type ClassificationRules } from "../../shared/memory-classification";
import { currentHomeState, memoryClassificationRules, memoryStoreCeiling, workspaceRulesOn } from "./classification";
import { personalWriteRefusal } from "../one/write-gate";
import {
  beginMemoryTicket,
  completeMemoryTicket,
  memoryDecisionReport,
  readMemoryTicketReport,
  redactMemoryTicketEpisode,
  recordMemoryDecision,
  type MemoryCuratorMode,
  type MemoryEmitterStatus,
} from "./tickets";
import { appendCuratorDecision } from "./project-artifacts";

export interface CurationContext {
  /** Main-authored before the model call. Renderer/model input is never trusted here. */
  turnId?: string | null;
  /**
   * this turn was started by a message the OWNER wrote — a positive fact minted at the owner's own entry points (the composer, the paired phone, the paired
   * Telegram chat), never derived from a list of what a turn is not (invocation/owner-spoke.ts). Only a turn with this set can add a line to Personal memory.
   * Absent = false: an automation run, a ledger conversation, a synthesised answer, a mention chain, a cross-session message, a check-in, a restart resume, a hub call.
   */
  ownerSpoke?: boolean;
  /**
   * Agentlas 2.0 P2: this turn is the personal agent's own conversation (`isPersonalAgentConversation`, workspace-rules/scope.ts), set by the host that starts the turn (P3a). Only read with the
   * workspace-rules switch on, where a Personal line is written from such a turn only. Absent = false (a value nobody set is "not the personal agent's conversation").
   */
  personalConversation?: boolean;
  /**
   * what the host saw in this turn besides the owner's message (a tool call completed, a file/photo/room text came in, a verification receipt). Decides the two origin columns of a line
   * (origin-class.ts); never a reason to refuse one. Minted by the host at the turn's end; absent = nothing known. In memory and in the job's own payload only.
   */
  turnFacts?: TurnFacts;
  projectPath: string | null;
  projectId: string | null;
  agentId: string | null;
  chatId: string | null;
  /** Durable invocation identity for a content-free curation receipt. */
  runId?: string | null;
  /** Firm/task-force node identity. Never used as the installed-agent memory owner. */
  nodeId?: string | null;
  cwdAtRequest?: string | null;
  /** 이 실행에 관여한 빌린(고용한) 허브 에이전트 슬러그. agent_repo 스코프 배움을
   *  이 에이전트들의 전역 기억 둥지에도 미러링해, 다음 대여 때(다른 프로젝트여도) 실려온다. */
  borrowedAgentSlugs?: string[];
  /**
   * 런타임이 증명한 응답 출처. 태스크포스 종합문은 여러 에이전트의 혼합 산출물이므로
   * 어느 참여 에이전트의 agent_repo에도 귀속할 수 없다.
   */
  sourceProvenance?: "task-force-synthesis";
  /**
   * Host-known source surface. `automation-run` = an unattended automation
   * turn. When absent it is derived from `chatId` (an automation_sessions
   * ledger chat), never from the memory text.
   */
  sourceSurface?: "automation-run";
  /** Host-observed lifecycle only; model prose cannot grant an effect receipt. */
  hostOutcome?: "completed" | "failed" | "cancelled" | "partial" | "unknown";
  /** Trusted compatibility boundary; parsed/model JSON never sets these. */
  memoryChannel?: "default" | "legacy_one_overlay";
  memoryCompatibilityScope?: { scope: "personal" | "project" | "agent" | "team"; scopeRef: string | null };
  /** the owner's own words of the turn (null: the prompt was written by the host). The origin check reads them before the experience hint. */
  ownerWords?: string | null;
  /** Exact runtime/base context supplied only by real installed-agent runs. */
  experienceIntake?: {
    platform: string;
    arch: string;
    runtimeKind: string;
    basePackageHash: string | null;
    taskHint?: string | null;
  };
  /**
   * v75 · Team-run identities for deterministic 3-layer scope routing. Present
   * only when the run is a materialized team run. When set, durable agent_repo
   * learning is routed by kind (see classifyTeamLearningRoute): team
   * coordination → orchestrator, shared norms → the bound project, else the
   * orchestrator's own store (no new team_memory line; P-T, §5.7),
   * domain skill/taste → the member cell. Absent (single-agent run) → behavior is unchanged.
   */
  teamRun?: {
    orchestratorAgentId: string;
    /** The member cell that owns domain learning this turn (org node slug = id). */
    memberAgentId?: string | null;
  };
}

// Deterministic team routing + project-specifics guard now live in
// ./curator-rules (pure module) so the shared-fixture conformance gate can run
// them under plain node, and their values come from the canonical
// curator-ruleset.json instead of inline constants.
import {
  classifyTeamLearningRoute,
  loadCuratorRuleset,
  mentionsProjectSpecifics as rulesMentionsProjectSpecifics,
  type TeamLearningLayer,
  narrowAgentRepoScope,
  noWorkspaceFallbackScope,
} from "./curator-rules";

export { classifyTeamLearningRoute, type TeamLearningLayer };

/**
 * Apply the team layer routing to a resolved durable learning. Only rewrites
 * agent_repo learning (the scope the 3 layers live on); every other scope is
 * returned unchanged. Deterministic and side-effect free.
 *
 * P-T (Agentlas 2.0 §5.7, principles P2/P3): the old company run no longer writes a `team_memory` line. The shared layer goes to the project the
 * chat is bound to; without a project it goes to the team's orchestrator agent (its own store). Existing `team_memory` lines are only read.
 */
function routeTeamLearning(
  scope: MemoryScope,
  kind: MemoryKind,
  ownerAgentId: string | null,
  teamRun: NonNullable<CurationContext["teamRun"]>,
  hasProject: boolean,
): { scope: MemoryScope; agentId: string | null } {
  if (scope !== "agent_repo") return { scope, agentId: ownerAgentId };
  const layer = classifyTeamLearningRoute(kind);
  if (layer === "shared") {
    return hasProject
      ? { scope: "project", agentId: ownerAgentId }
      : { scope: "agent_repo", agentId: teamRun.orchestratorAgentId };
  }
  if (layer === "coordination") return { scope: "agent_repo", agentId: teamRun.orchestratorAgentId };
  return {
    scope: "agent_repo",
    agentId: teamRun.memberAgentId || teamRun.orchestratorAgentId,
  };
}

export interface CurationReport {
  written: number;
  deduped: number;
  redacted: number;
  sessionOnly: number;
  discarded: number;
  /** K2b': the store ids of the lines this batch wrote and of the existing lines a duplicate was merged into, in event order (absent when none). In memory only: never stored, never sent. */
  writtenIds?: string[];
  dedupedIds?: string[];
  /** the ids of own `preference` lines a full personal place let go of to make room for a new line (absent when none). */
  releasedForRoom?: string[];
}

export interface CurateReplyOptions {
  automaticOwnerNamespace?: string;
  /** Explicit compatibility export, never a second automatic memory authority. */
  writeProjections?: boolean;
  /**
   * Memory events taken out of this turn's earlier continuous passes, each committed as its own message before the
   * final answer. Appended after the final answer's events.
   */
  carriedEvents?: RawMemoryEvent[];
  /**
   * K2b': what the model's memory_ticket calls of this turn already did (the lines were written at the call; the answers said so). The turn's own record counts them
   * (candidates, outcome, the report) and links each written line to the turn's ticket; they are never written a second time.
   */
  toolWrites?: { candidates: number; report: CurationReport; writtenIds: string[] };
}

export interface CuratedReply {
  cleanedText: string;
  report: CurationReport;
  ticketId: string;
  emitterStatus: MemoryEmitterStatus;
  curatorMode: MemoryCuratorMode;
}

function emptyReport(): CurationReport {
  return { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 };
}

export type TerminalMemoryTurnStatus = "failed" | "cancelled" | "curation_failed";

/**
 * A runner that terminates without a final reply still crossed the model-turn
 * boundary. Record one content-free central ticket/episode; never infer a
 * durable candidate and never touch project-local files from an error path.
 */
export function recordTerminalMemoryTurn(
  ctx: CurationContext,
  status: TerminalMemoryTurnStatus,
): { ticketId: string; created: boolean } {
  const report = emptyReport();
  const ticket = beginMemoryTicket({
    context: ctx,
    emitterStatus: "missing",
    candidateCount: 0,
    // 사람이 읽는 "프로젝트 기억" 줄이다 — 화면 언어로 적고, 읽을 때도 다시 맞춘다(policy-turn-summary.ts).
    turnSummary: policyTurnSummary(
      status === "cancelled" ? "turn-cancelled" : status === "curation_failed" ? "curation-failed" : "turn-failed",
      currentUiLocale(),
    ),
  });
  if (ticket.created) {
    completeMemoryTicket(ticket.ticketId, report, "policy", {
      failureCode: status === "cancelled"
        ? "turn-cancelled"
        : status === "curation_failed"
          ? "curation-failed"
          : "turn-failed",
      outcome: "no_candidates",
    });
    recordCurationReceipt(ctx, report);
  }
  return { ticketId: ticket.ticketId, created: ticket.created };
}

function recordCurationReceipt(ctx: CurationContext, report: CurationReport): void {
  const runId = String(ctx.runId ?? "").trim();
  if (!runId) return;
  const memoryEventCount =
    report.written + report.deduped + report.redacted + report.sessionOnly + report.discarded;
  // Counts only: prompt, reply, memory content, paths, and evidence never enter the run ledger.
  tryRecordRunEvent({
    runId,
    kind: "memory_curation",
    chatId: ctx.chatId,
    nodeId: ctx.nodeId,
    agentId: ctx.agentId,
    payload: {
      memoryEventCount,
      written: report.written,
      deduped: report.deduped,
      redacted: report.redacted,
      sessionOnly: report.sessionOnly,
      discarded: report.discarded,
    },
  });
}

const SOUL_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  "decision",
  "preference",
  "risk",
  "procedure",
]);

// Values from the canonical ruleset (kinds.userIdentityAllowed); the literal
// fallback mirrors it for a broken install.
const USER_IDENTITY_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>(
  ((loadCuratorRuleset().ruleset.kinds?.userIdentityAllowed as MemoryKind[] | undefined)
    ?? ["fact", "decision", "preference", "procedure"]),
);


/**
 * Does this learning name the project it came from?
 *
 * `agent_repo` is the one scope that deliberately crosses project boundaries: it mirrors into a
 * borrowed agent's global nest, so a fact learned in project A is re-injected in project B. The
 * code claimed "not project-specific, so isolation holds" but enforced nothing — the scope label
 * comes from the model, and a mislabelled event carries A's specifics to B (and into a
 * third-party agent's nest on the way).
 *
 * Conservative by construction: a hit only narrows the scope (still stored, just not shared), so a
 * false positive costs reach, while a false negative leaks. Prefer the cheap check.
 */
function mentionsProjectSpecifics(content: string, ctx: CurationContext): boolean {
  // Implementation and its values live in ./curator-rules (shared ruleset).
  return rulesMentionsProjectSpecifics(content, ctx.projectPath);
}

function resolveScope(ev: RawMemoryEvent, ctx: CurationContext): MemoryScope {
  // (§11.6, engine F2 always-part): a resident actor (One family, host:*) that worked inside a project did not learn a portable agent skill —
  // it learned something about that project. An agent_repo proposal that is not a preference becomes a project line; a preference stays for Personal
  // (resolved by the write-time classification). No project this turn, or an agent with its own folder: unchanged. This is the one sink every executor reaches.
  if (ev.suggested_scope === "agent_repo" && residentAgentRepoBelongsToProject(ctx.agentId, Boolean(ctx.projectPath), ev.memory_kind)) return "project";
  if (ev.suggested_scope === "agent_repo" && mentionsProjectSpecifics(ev.content, ctx)) {
    // The model labelled this a portable agent skill, but it names this project or this machine.
    // Keep it — just not somewhere it can surface in an unrelated project or a borrowed nest.
    // Both the narrowed scope and the no-folder fallback come from the ruleset.
    return (ctx.projectPath ? narrowAgentRepoScope() : noWorkspaceFallbackScope()) as MemoryScope;
  }
  if (ev.suggested_scope === "agent_repo" && ctx.sourceProvenance === "task-force-synthesis") {
    // 합성 응답에는 단일 소유 에이전트가 없다. 프로젝트 경계가 있으면 그 안에만 남기고,
    // 폴더 없는 합성은 session으로 강등해 글로벌 DB/borrowed-agent 둥지 오염을 막는다.
    return ctx.projectPath ? "project" : "session";
  }
  if (
    ev.suggested_scope === "project" &&
    !ctx.projectPath &&
    ctx.sourceProvenance === "task-force-synthesis"
  ) {
    // 일반 채팅의 기존 fallback(team_memory)은 유지하되, 합성 응답이 가리킬 실제 폴더가
    // 없을 때는 project 제안을 글로벌 팀 기억으로 승격하지 않는다.
    return "session";
  }
  if (ev.suggested_scope === "agent_team") {
    return "team_memory";
  }
  if (ev.suggested_scope === "user_identity") {
    // no confidence condition. How sure the model was lowers the line's origin class (origin-class.ts), it does not keep the line out of Personal; the kinds Personal takes are unchanged.
    if (!USER_IDENTITY_KINDS.has(ev.memory_kind)) {
      return "session";
    }
    return "user_identity";
  }
  if (ev.suggested_scope === "project" && !ctx.projectPath) {
    // No folder is bound to this chat. The ruleset declares the fallback
    // (`session`); returning "team_memory" here promoted one person's project
    // fragment into shared team memory, so the declaration now decides.
    return noWorkspaceFallbackScope() as MemoryScope;
  }
  return ev.suggested_scope;
}

/** Has shared memory had its first merge in this store? */
function sharedIsOpen(): boolean { try { return sharedOpenHere(getMemoryDb()); } catch { return false; } }
/** Is the event a line of a shared kind? fact (the column), identity, or a boundary that carries its structure. A `preference` is this place's own. */
function eventIsSharedKind(ev: RawMemoryEvent): boolean {
  if (ev.ticket_kind === "identity") return true;
  if (ev.ticket_kind === "boundary") return ev.boundary !== undefined || ev.memory_kind === "fact";
  return ev.memory_kind === "fact";
}
/** Is the stored Personal line a shared kind (the table of `shared-ids.ts`, in SQL)? */
function isSharedKindLine(memoryId: string): boolean {
  try { return Boolean(getMemoryDb().prepare(`SELECT 1 FROM memory_entries WHERE id=? AND scope='user_identity' AND content<>'' AND ${SHARED_KIND_SQL}`).get(memoryId)); } catch { return false; }
}

/** Is there a conversation to put the "oldest memory deleted" card in? (a chat the desktop knows). */
function canShowRoomCard(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  try { return Boolean((require("../store/chats") as typeof import("../store/chats")).getChat(chatId)); } catch { return false; }
}
/** The card for an own preference let go (scope "own": it applies to this agent only). Never throws: the new line is already written. */
function showRoomCard(newLineId: string, text: string, agentId: string | null | undefined): void {
  try {
    let agentName: string | undefined;
    try { agentName = agentId ? (require("../mcp/registry") as typeof import("../mcp/registry")).getAgentById(agentId)?.name : undefined; } catch { agentName = undefined; }
    (require("../one/memory-room-notice") as typeof import("../one/memory-room-notice")).recordMemoryRoomNotice({ lineId: newLineId, scope: "own", count: 1, text, saidAt: null, ...(agentName ? { agentName } : {}) });
  } catch { /* the card is a display row; the memory is already settled */ }
}

function compactContext(ctx: RequestContext): RequestContext | null {
  const next: RequestContext = {};
  if (ctx.userIntent) next.userIntent = ctx.userIntent.slice(0, 240);
  if (ctx.triggerTerms && ctx.triggerTerms.length > 0) {
    next.triggerTerms = [...new Set(ctx.triggerTerms.map((t) => t.trim()).filter(Boolean))]
      .slice(0, 12)
      .map((t) => t.slice(0, 40));
  }
  if (ctx.cwdAtRequest !== undefined) next.cwdAtRequest = ctx.cwdAtRequest;
  if (ctx.targetProject !== undefined) next.targetProject = ctx.targetProject;
  if (ctx.targetPath !== undefined) next.targetPath = ctx.targetPath;
  if (ctx.crossContext !== undefined) next.crossContext = ctx.crossContext;
  if (ctx.outcome !== undefined) next.outcome = ctx.outcome ? ctx.outcome.slice(0, 240) : ctx.outcome;
  if (ctx.ticket_kind === "identity" || ctx.ticket_kind === "boundary") next.ticket_kind = ctx.ticket_kind;
  if (ctx.boundary) next.boundary = ctx.boundary;
  if (typeof ctx.grounded === "boolean") next.grounded = ctx.grounded;
  if (looksSecret(JSON.stringify(next))) return null;
  return Object.keys(next).length > 0 ? next : null;
}

function buildRequestContext(
  ev: RawMemoryEvent,
  ctx: CurationContext,
  projectPath: string | null,
  grounded?: boolean,
  withBoundary = false,
): RequestContext | null {
  const provided = ev.request_context ?? {};
  const targetProject = provided.targetProject ?? ctx.projectId ?? null;
  const targetPath = provided.targetPath ?? projectPath;
  const cwdAtRequest = provided.cwdAtRequest ?? ctx.cwdAtRequest ?? ctx.projectPath ?? null;
  const crossContext =
    provided.crossContext ??
    Boolean(cwdAtRequest && targetPath && cwdAtRequest !== targetPath);
  return compactContext({
    ...provided,
    cwdAtRequest,
    targetProject,
    targetPath,
    crossContext,
    // K2b': the kind a Personal ticket was given before the computer folded it (host-set on the event; a model cannot send it).
    ...(ev.ticket_kind ? { ticket_kind: ev.ticket_kind } : {}),
    // the structure of a boundary line travels with it, the same way the kind does.
    ...(withBoundary && ev.ticket_kind === "boundary" && ev.boundary ? { boundary: ev.boundary } : {}),
    ...(grounded !== undefined ? { grounded } : {}),
  });
}

function requestContextForLog(ctx: RequestContext | null): Record<string, unknown> | null {
  if (!ctx) return null;
  return {
    user_intent: ctx.userIntent,
    trigger_terms: ctx.triggerTerms,
    cwd_at_request: ctx.cwdAtRequest,
    target_project: ctx.targetProject,
    target_path: ctx.targetPath,
    cross_context: ctx.crossContext,
    outcome: ctx.outcome,
  };
}

function evidenceWithSourceProvenance(ev: RawMemoryEvent, ctx: CurationContext, marks: { instruction: boolean } = { instruction: false }): string[] {
  // Runtime callers normally pass parsed events, but direct deterministic tests and
  // legacy integrations may omit evidence_refs; preserve the former empty-list behavior.
  const evidence = (ev.evidence_refs ?? []).slice();
  if (ctx.sourceProvenance) evidence.push(`source:${ctx.sourceProvenance}`);
  // The run this came from, so the lesson's recurrence can be counted (run-evidence.ts); never model text.
  evidence.push(...runEvidenceRef(ctx.runId));
  // Agentlas 2.0 P2 (workspace-rules switch on only): the line came from a proposal that was an instruction (the original scope was Personal or the original kind a preference, before the host
  // corrected it). The marks are read by the skill-candidate list (never counted towards a skill) and by the "my rules" pick list; they are not shown to a model (`entryLines` renders no evidence).
  if (marks.instruction) {
    evidence.push(ORIGIN_INSTRUCTION);
    if (ctx.ownerSpoke === true) evidence.push(ORIGIN_OWNER_SPOKE);
  }
  return [...new Set(evidence)];
}

export interface EventCurationOptions {
  /** The owner's own words of the turn(s) these events came from; the default is the context's own task hint. Only read for a turn that took in something besides them. */
  ownerText?: string;
  ticketId?: string;
  curatorMode?: MemoryCuratorMode;
  projectPath?: string | null;
  decisionIndexOffset?: number;
  writeProjections?: boolean;
  originTicketIds?: string[];
  policyVersion?: string;
  /** K2b': the reason code of every candidate that was not written is also pushed here (in memory only), so a caller that answers per candidate can tell why. */
  reasonSink?: string[];
}

function safeDecisionReasonCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return normalized || "policy-decision";
}

function recordCandidateDecision(input: {
  options: EventCurationOptions;
  index: number;
  event: RawMemoryEvent;
  scope: MemoryScope;
  action: "written" | "deduped" | "redacted" | "session" | "discarded" | "deferred";
  reason: string;
  targetMemoryId?: string | null;
}): void {
  input.options.reasonSink?.push(input.reason);
  if (!input.options.ticketId) return;
  recordMemoryDecision({
    ticketId: input.options.ticketId,
    candidateIndex: input.index + (input.options.decisionIndexOffset ?? 0),
    content: input.event.content,
    memoryKind: input.event.memory_kind,
    proposedScope: input.event.suggested_scope,
    resolvedScope: input.scope,
    action: input.action,
    reasonCode: input.reason,
    targetMemoryId: input.targetMemoryId,
    confidence: input.event.confidence,
    sensitivity: input.event.sensitivity,
    curatorMode: input.options.curatorMode ?? "policy",
  });
  if (input.options.writeProjections === true && input.options.projectPath) {
    try {
      appendCuratorDecision(input.options.projectPath, {
        content: input.event.content,
        action: input.action,
        reasonCode: safeDecisionReasonCode(input.reason),
        ticketId: input.options.ticketId,
        targetMemoryId: input.targetMemoryId,
        candidateIndex: input.index,
        memoryKind: input.event.memory_kind,
        proposedScope: input.event.suggested_scope,
        resolvedScope: input.scope,
        confidence: input.event.confidence,
        sensitivity: input.event.sensitivity,
        curatorMode: input.options.curatorMode ?? "policy",
        rulesetSha256: loadCuratorRuleset().sha,
      });
    } catch (error) {
      console.warn(`[memory] project curator projection deferred: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
}

function appendTurnOutcomeDecision(input: {
  projectPath: string | null;
  ticketId: string;
  outcome: "decided" | "no_candidates" | "malformed_output" | "curator_failed" | "read_only";
  report: CurationReport;
  curatorMode: MemoryCuratorMode;
}): void {
  if (!input.projectPath) return;
  const action = input.outcome === "curator_failed"
    ? "deferred"
    : input.outcome === "decided"
      ? input.report.written > 0
        ? "written"
        : input.report.deduped > 0
          ? "deduped"
          : input.report.redacted > 0
            ? "redacted"
            : input.report.sessionOnly > 0
              ? "session"
              : "discarded"
      : "discarded";
  try {
    appendCuratorDecision(input.projectPath, {
      content: `memory-ticket:${input.ticketId}`,
      action,
      reasonCode: `episode-${input.outcome.replaceAll("_", "-")}`,
      ticketId: input.ticketId,
      curatorMode: input.curatorMode,
      rulesetSha256: loadCuratorRuleset().sha,
    });
  } catch (error) {
    console.warn(`[memory] project curator outcome projection deferred: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

interface CandidateScope { scope: MemoryScope; kind: MemoryKind; reason: string; deferred: boolean; hub?: boolean; instruction?: boolean }

/**
 * stage 1 (§12-2/§12-3, the engine's memory_classify.stage1): the proposal's scope and kind are corrected by CODE before anything else
 * reads them — the kind corrections of the ruleset, the Personal admission (high confidence, no secret or host path, 200 characters, a home that is not
 * away/sealed, and the owner having spoken), a project line needing a bound project, a resident actor's agent_repo line inside a project becoming a project line.
 * Rules off (an older or damaged ruleset copy) or a scope outside the three stores: the proposal passes unchanged.
 */
function classifyProposal(
  rules: ClassificationRules | null,
  scope: MemoryScope | "agent_team",
  kind: MemoryKind,
  confidence: string | undefined,
  event: RawMemoryEvent,
  ctx: CurationContext,
  rulesOn: () => boolean,
): { pass: { scope: MemoryScope; kind: MemoryKind; instruction?: boolean } } | { stop: CandidateScope } {
  // The team's shared scope (#5). A hub-called agent keeps no memory of the owner's anywhere. Outside a team run nobody is writing for a team: the line is an
  // agent_repo proposal and meets the same thresholds as every other (the owner having spoken for a preference, a bound project for a project line, the hub, the ceilings).
  // A team run is no exception (P-T): its team_memory proposal is an agent_repo proposal too and meets the same thresholds; routeTeamLearning below then picks the layer
  // (project, orchestrator or member). Only the rules off (an older ruleset copy) outside a team run leave a team_memory proposal as before.
  if (scope === "team_memory" || scope === "agent_team") {
    if (memoryActorKind(ctx.agentId) === "hub") return { stop: { scope: "discard", kind, reason: "policy-hub-agent-no-memory", deferred: false, hub: true } };
    if (!rules && !ctx.teamRun) return { pass: { scope: "team_memory", kind } };
    scope = "agent_repo";
  }
  if (!rules || (scope !== "user_identity" && scope !== "agent_repo" && scope !== "project")) return { pass: { scope, kind } };
  // A team run's agent_repo lines are ROUTED by the kind the model gave (coordination / shared / domain, classifyTeamLearningRoute; curateEvents), but they are WRITTEN, de-duplicated and
  // checked against the forget stamp with the corrected kind, like the same line outside a team run (#4: the team run filed a decision under `decision`, the same words outside it under `procedure`).
  const project = Boolean(ctx.projectPath);
  // the Personal admission no longer asks the model's confidence to be high. The ruleset's own value is passed through, so the rest of the admission (kinds, owner spoke, home state, path, length) is unchanged
  // and the ruleset copy the engine mirrors stays as it is; the confidence itself is read when the line's origin class is decided.
  const outcome = classifyStage1(rules, { scope, kind, confidence: personalMinConfidence(rules) ?? confidence, text: event.content, surface: "desktop", project, inProject: project,
    actorKind: memoryActorKind(ctx.agentId), ownerSpoke: ctx.ownerSpoke === true, homeState: currentHomeState,
    rulesOn, personalConversation: ctx.personalConversation === true });
  if ("write" in outcome) return { stop: { scope: "discard", kind, reason: "policy-hub-agent-no-memory", deferred: false, hub: true } };
  if ("discard" in outcome) return { stop: { scope: "discard", kind, reason: "policy-secret", deferred: false } };
  // The desktop cannot ask the agent a second time once its turn is over, and no format reason may kill a turn: a Personal line over its length
  // is kept out of Personal and nothing is written; the decision ledger says why.
  if ("askAgain" in outcome) return { stop: { scope: "session", kind, reason: "policy-personal-too-long", deferred: false } };
  if (outcome.scope === "session") {
    const personal = scope === "user_identity" || (scope === "agent_repo" && memoryActorKind(ctx.agentId) === "resident" && kind === "preference");
    return { stop: { scope: "session", kind, reason: personal ? "policy-personal-not-admitted" : "policy-classification-session", deferred: false } };
  }
  return { pass: { scope: outcome.scope as MemoryScope, kind: ("kind" in outcome ? outcome.kind : kind) as MemoryKind, ...("instruction" in outcome && outcome.instruction === true ? { instruction: true } : {}) } };
}

function scopeForCandidate(
  event: RawMemoryEvent,
  index: number,
  ctx: CurationContext,
  options: EventCurationOptions,
  rulesOn: () => boolean,
): CandidateScope {
  const rules = memoryClassificationRules();
  // The proposal the code then corrects (K3': no reviewing model any more - the emitter's own proposal, corrected by the host's rules).
  const proposedScope = event.suggested_scope;
  const proposedKind = event.memory_kind;
  const confidence = event.confidence;
  const classified = classifyProposal(rules, proposedScope === "agent_team" ? "team_memory" : proposedScope, proposedKind, confidence, event, ctx, rulesOn);
  if ("stop" in classified) return classified.stop;
  const { scope: classifiedScope, kind, instruction } = classified.pass;
  // The same deterministic narrowing gates are re-applied on the corrected proposal. The model may propose scope, but cannot create a
  // project/agent owner or widen synthesis.
  const resolvedScope = resolveScope({ ...event, memory_kind: kind, suggested_scope: classifiedScope }, ctx);
  return { scope: resolvedScope, kind, reason: "policy-scope", deferred: false, ...(instruction ? { instruction: true } : {}) };
}

/** Curate a batch of raw events into durable memory. Pure side effects + a report. */
export function curateEvents(
  events: RawMemoryEvent[],
  ctx: CurationContext,
  options: EventCurationOptions = {},
): CurationReport {
  const report = emptyReport();
  const writeProjections = options.writeProjections === true;
  const projectProjections: Array<{
    lease: MemoryProjectionWriterLease;
    logRecord: Record<string, unknown>;
    soulLine: string | null;
  }> = [];
  // agent_repo 스코프(에이전트 기술·경험) 배움 — 빌린 에이전트의 전역 둥지로 미러링할 후보.
  const nestExperienceItems: AgentNestExperienceItem[] = [];

  const rules = memoryClassificationRules();
  // The workspace-rules switch is read at most once per batch, and only when a proposal reaches a store (a batch that never gets there never asks).
  let switchOn: boolean | null = null;
  const rulesOn = (): boolean => (switchOn ??= workspaceRulesOn());
  for (const [index, proposed] of events.entries()) {
    // `ev` is the line as the code corrected it (kind corrections happen once, below, before the duplicate check and the forget stamp).
    let ev: RawMemoryEvent = proposed;
    if (ev.sensitivity === "secret" || looksSecret(ev.content)
      || looksSecret(ev.content_native ?? "")) {
      report.redacted += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope: "discard",
        action: "redacted",
        reason: "policy-secret",
      });
      if (writeProjections && ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "redacted",
          reason: "secret",
          kind: ev.memory_kind,
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    // the low-confidence quarantine that stood here is gone. A line the model was unsure of is written with the origin class `inferred` (origin-class.ts), not held back.

    // Capability-widening content screening was REMOVED 2026-08-12 (owner
    // decision) — a content wordlist cannot separate a widening assertion from a
    // safety lesson across languages. Misevolution defence is delegated to recall
    // framing + the PreToolUse broker; see one_workspace._classify and the
    // ruleset _capabilityWideningNote.

    // the evidence-shape door that stood here (a fact/decision/procedure whose evidence was all ill-shaped went to the session log) is gone: the source of a line is attached by the host
    // (evidenceWithSourceProvenance, the two origin columns), never a condition of writing it.

    // Unattended automation runs (2026-09-24). Nobody reviews these turns, and
    // measured on the owner's store their decisions/procedures were the run's
    // own tactical choices (hold, pause, quota met, keep a gate) written as
    // portable agent_repo rules with empty evidence - the next run recalled and
    // obeyed them. A run's own decision/procedure, or any unevidenced claim,
    // stays in that run's session log; nothing from it crosses into agent_repo
    // or user_identity. The surface is a host fact, not a reading of the text.
    const unattended = ctx.sourceSurface === "automation-run" || isAutomationLedgerChat(ctx.chatId);
    const hostObserved = (ev as RawMemoryEvent & { source?: string }).source === "host-observed";
    if (unattended && !hostObserved && (ev.memory_kind === "decision" || ev.memory_kind === "procedure")) {
      // only the run's own choice stays out (an rule of WHO decides, not of evidence). The "unevidenced claim" half of this door is gone: such a line is written, narrowed below to
      // the project or the session like every unattended line, with the origin class `inferred`.
      report.sessionOnly += 1;
      const reason = "policy-automation-run-own-choice";
      recordCandidateDecision({ options, index, event: ev, scope: "session", action: "session", reason });
      if (writeProjections && ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "session",
          reason,
          kind: ev.memory_kind,
          content: ev.content,
          source_provenance: "automation-run",
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    const resolvedByPolicy = scopeForCandidate(ev, index, ctx, options, rulesOn);
    const resolved = unattended && !hostObserved
      && (resolvedByPolicy.scope === "agent_repo" || resolvedByPolicy.scope === "user_identity")
      ? { ...resolvedByPolicy, scope: (ctx.projectPath ? "project" : "session") as MemoryScope,
        reason: "policy-automation-run-narrowed" }
      : resolvedByPolicy;
    const scope = resolved.scope;
    // from here on every step — the duplicate check, the forget stamp, the write, the decision ledger — sees the corrected kind.
    if (resolved.kind !== ev.memory_kind) ev = { ...proposed, memory_kind: resolved.kind };
    if (resolved.hub) {
      report.discarded += 1;
      recordCandidateDecision({ options, index, event: ev, scope: "discard", action: "discarded", reason: resolved.reason });
      continue;
    }
    if (scope === "discard") {
      report.discarded += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope,
        action: "discarded",
        reason: resolved.reason,
      });
      continue;
    }
    if (scope === "session") {
      // Temporary — log only, never durable.
      report.sessionOnly += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope,
        action: resolved.deferred ? "deferred" : "session",
        reason: resolved.reason,
      });
      if (writeProjections && ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "session",
          kind: ev.memory_kind,
          content: ev.content,
          source_provenance: ctx.sourceProvenance ?? "assistant-turn",
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    // v75: deterministic 3-layer team routing (member cell / orchestrator /
    // shared). Inert for single-agent runs (teamRun absent). Only agent_repo
    // learning is rewritten; the owner/scope decided here drive dedup, insert,
    // and Experience intake so a member's domain skill accrues to its own cell.
    const routed = ctx.teamRun
      ? routeTeamLearning(scope, proposed.memory_kind, ctx.agentId, ctx.teamRun, Boolean(ctx.projectPath))
      : { scope, agentId: ctx.agentId };
    // 마지막 관문: 개인 칸을 못 가지는 주인(팀 낙인 `agt_team_`, 또는 설치 에이전트가 없는
    // 조직 노드)에게 향한 agent_repo 학습을 팀 공유로 되돌린다. 주인 판정은 여기 한 곳에서만
    // 한다 — 이 함수가 모든 표면(One·조직·빌린 팀)의 공통 sink 이므로, 위쪽 라우터가 몇 개든
    // 고아 행이 표에 들어가지 못한다. 실측: 그렇게 들어간 행은 정리기가 주인을 못 찾아
    // 조용히 건너뛰어 영원히 쌓였다.
    const owned = normalizeMemoryOwnership<MemoryScope>(
      routed.scope,
      routed.agentId,
      "agent_repo",
      "team_memory",
    );
    const effectiveScope = owned.scope;
    const effectiveAgentId = owned.agentId;
    // P-T: a team run keeps nothing in `team_memory` any more. When the last gate above finds no personal store for the owner (a team brand, no installed agent, even the orchestrator),
    // there is no place for the line: it stays in the run's session log (principle P3, nothing is kept) and the decision ledger says why. The turn goes on.
    if (ctx.teamRun && effectiveScope === "team_memory") {
      report.sessionOnly += 1;
      recordCandidateDecision({ options, index, event: ev, scope: "session", action: "session", reason: "policy-team-run-no-store" });
      continue;
    }

    // the two origin columns, decided from host facts (origin-class.ts). `personTurn` = the owner typed this turn and nobody else's words stand in for it. A turn that took in a tool result,
    // a file, a photo or room text (`turnFacts`) writes a line as the owner's own only when it rests on the owner's own words; otherwise it is `observed`.
    const personTurn = ctx.ownerSpoke === true && !unattended && !ctx.sourceProvenance;
    const mixedTurn = ctx.turnFacts?.toolsRan === true || ctx.turnFacts?.inputsRead === true;
    // for a Personal line the owner's own typing is checked against the words every time (not only on a mixed turn). The answer rides on the line (`grounded`, sent up as its mark) and lets
    // words the owner forgot be written again only when they said them again (a model writing the same words alone is not that).
    // (Only once shared memory is open here: before the first merge the stamp holds as it always did and no new key is stored on the line.)
    const groundedNow = effectiveScope === "user_identity" && personTurn && sharedIsOpen()
      ? groundedInOwnerWords(ev, options.ownerText ?? ctx.ownerWords ?? ctx.experienceIntake?.taskHint ?? "", "") : false;
    // K2b': a memory_ticket line comes with the two columns the ticket receiver already decided from the same host facts (ticket-receiver.ts); that verdict stands (one authority), nothing is derived a second time.
    const origin = ev.ticket_origin ?? deriveOrigin({
      ownerSpoke: ctx.ownerSpoke === true, notAPersonTurn: !personTurn, hostMinted: hostObserved, kind: ev.memory_kind,
      // How sure the proposer was.
      confidence: ev.confidence,
      modelClaim: ev.origin_class, facts: ctx.turnFacts,
      ...(mixedTurn && personTurn ? { groundedInOwnerWords: groundedInOwnerWords(ev, options.ownerText ?? ctx.ownerWords ?? ctx.experienceIntake?.taskHint ?? "", "") } : {}),
    });
    // The injection door that stays (keeps it): a Personal PREFERENCE, an instruction about the owner, may not come from words a tool, file or page brought into the turn. Such a line is not the owner's
    // (origin `observed`) and is kept out of Personal; a Personal FACT read from a photo or file is written as `observed` and never loaded on every turn.
    if (effectiveScope === "user_identity" && mixedTurn && origin.originClass !== "user" && ev.memory_kind === "preference") {
      report.sessionOnly += 1;
      recordCandidateDecision({ options, index, event: ev, scope: "session", action: "session", reason: "policy-personal-not-owner-words" });
      continue;
    }

    const projectPath = effectiveScope === "project" ? ctx.projectPath : null;
    const requestContext = buildRequestContext(ev, ctx, projectPath, effectiveScope === "user_identity" && sharedIsOpen() ? groundedNow : undefined, effectiveScope === "user_identity" && sharedIsOpen());
    // stage 2 (the engine's classify stage2): a model that points at an older line replaces it only when the two are similar enough (the ruleset's
    // `limits.mergeTokenOverlapMin`) and the older line is in the same scope and reads as the same corrected kind; otherwise the text is a NEW line and the old one
    // stays (never a guess). At a store's ceiling only a replacing line is written. Rules off: the explicit link is followed as before.
    let supersedes = ev.supersedes;
    let replaces = false;
    if (supersedes && ev.explicit_replace === true) {
      // K2b': a memory_ticket rewrite or condense NAMES its line itself and the receiver has already checked its scope and kind line; the target is found again here under this write's own owner,
      // and no similarity test stands in front of it (a new city is not "similar" to the old one). A line that is gone by now (forgotten or replaced a moment ago) is not written as a near copy.
      const target = peekExplicitSupersedeTarget({ scope: effectiveScope, projectId: ctx.projectId, projectPath, agentId: effectiveAgentId, chatId: ctx.chatId }, supersedes);
      if (!target) {
        report.discarded += 1;
        recordCandidateDecision({ options, index, event: ev, scope: effectiveScope, action: "discarded", reason: "policy-ticket-target-gone" });
        continue;
      }
      replaces = true;
      // a line that is shared (fact, identity, boundary) is not turned into a place-only `preference` by a rewrite: the shared line stays, the new line is added. Both stay until a person removes one.
      if (effectiveScope === "user_identity" && sharedIsOpen() && !eventIsSharedKind(ev) && isSharedKindLine(target.id)) { replaces = false; supersedes = undefined; }
    } else if (rules && supersedes) {
      const target = peekExplicitSupersedeTarget({ scope: effectiveScope, projectId: ctx.projectId, projectPath, agentId: effectiveAgentId, chatId: ctx.chatId }, supersedes);
      if (target) {
        const verdict = classifyStage2(rules, { scope: effectiveScope, kind: ev.memory_kind, similarity: tokenOverlap(rules, ev.content, target.content),
          named: true, containment: tokenContainment(rules, ev.content, target.content), target: { scope: target.scope, kind: target.kind }, storeRows: 0 });
        replaces = "replace" in verdict && verdict.replace === true;
        if (replaces && effectiveScope === "user_identity" && sharedIsOpen() && !eventIsSharedKind(ev) && isSharedKindLine(target.id)) replaces = false;   // see above
        if (!replaces) supersedes = undefined;
      }
    }
    const personalClassOf = personalCeilingClassOf(ev.memory_kind, ev.ticket_kind, ev.boundary !== undefined && sharedIsOpen());
    const ceiling = rules && (effectiveScope === "user_identity" || effectiveScope === "agent_repo" || effectiveScope === "project") ? memoryStoreCeiling(effectiveScope, memoryActorKind(effectiveAgentId)) : null;
    const equivalentMemoryId = findEquivalentMemoryId(
      effectiveScope,
      ev.memory_kind,
      ev.content,
      projectPath,
      effectiveAgentId,
      { projectId: ctx.projectId, chatId: ctx.chatId, recallChannel: ctx.memoryChannel,
        compatibilityScope: ctx.memoryCompatibilityScope },
    );
    if (equivalentMemoryId) {
      // Audit 62 (memory B7): adding a source to a line that already exists is bookkeeping. With the layout switch on that line may sit in a store that is locked or catching up on a forget; the
      // candidate is still a duplicate and the other candidates of the turn are still written. The source is not added this time (a later restatement adds it).
      try {
        appendMemoryOrigins(equivalentMemoryId, [
          ...(options.originTicketIds ?? (options.ticketId ? [options.ticketId] : [])).map(id => ({ kind: "ticket" as const, id })),
          ...(ctx.runId ? [{ kind: "run" as const, id: ctx.runId }] : []),
          ...(ctx.projectId ? [{ kind: "project" as const, id: ctx.projectId }] : []),
        ], ctx.projectId);
      } catch (error) {
        console.warn(`[memory] duplicate source not added: ${typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : error instanceof Error ? error.message.slice(0, 80) : "unknown"}`);
      }
      // the person said the same words again in a turn of their own: a line the shared set holds gets its "said at" moved up (the next run tells the server).
      if (effectiveScope === "user_identity" && personTurn && origin.originClass === "user") { try { noteSaidAgain(getMemoryDb(), equivalentMemoryId); } catch { /* the words are still there; the next saying marks it */ } }
      report.deduped += 1;
      (report.dedupedIds ??= []).push(equivalentMemoryId);
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope: effectiveScope,
        action: "deduped",
        reason: "policy-exact-duplicate",
        targetMemoryId: equivalentMemoryId,
      });
      // A repeated admitted successor can repair an interrupted explicit relation.
      // Resolve its identity from storage, never from this model's scope fields.
      if (supersedes) {
        try { supersedeExplicitMemory({ id: equivalentMemoryId }, supersedes); }
        catch { console.warn("[memory] explicit replacement retry deferred"); }
      }
      continue;
    }

    // Audit 59 desktop C item 4 (F-6 sibling): the last door to a Personal line of this write path asks the personal agent's write gate too (the stage-1 admission reads the home mirror; this reads the home record). A turn never dies for it:
    // the line is not written, the ledger says why (the reason the stage-1 admission already uses), and the next candidate goes on. `home` and `legacy` computers: null, nothing changes.
    if (effectiveScope === "user_identity" && personalWriteRefusal()) {
      report.discarded += 1;
      recordCandidateDecision({ options, index, event: ev, scope: effectiveScope, action: "discarded", reason: "policy-personal-not-admitted" });
      continue;
    }
    let entry: ReturnType<typeof insertMemoryEntry>;
    try {
      const entryInput: Parameters<typeof insertMemoryEntry>[0] = {
        scope: effectiveScope,
        kind: ev.memory_kind,
        content: ev.content,
        ...(ev.content_native ? { contentNative: ev.content_native } : {}),
        projectId: ctx.projectId,
        projectPath,
        agentId: effectiveAgentId,
        chatId: ctx.chatId,
        confidence: ev.confidence,
        sensitivity: ev.sensitivity,
        originClass: origin.originClass,
        certainty: origin.certainty,
        // The marks of an instruction go on a line an agent or a project keeps; a Personal line is not a skill candidate and carries none.
        evidence: evidenceWithSourceProvenance(ev, ctx, { instruction: resolved.instruction === true && effectiveScope !== "user_identity" }),
        requestContext,
        intakeRunId: ctx.runId,
        ...(effectiveScope === "user_identity" && groundedNow ? { restatedByOwner: true } : {}),
        curationActor: options.curatorMode === "semantic" ? "model_curated" : "host_admitted",
        policyVersion: options.policyVersion ?? "agentlas.memory-admission.v1",
        recallChannel: ctx.memoryChannel,
        compatibilityScope: ctx.memoryCompatibilityScope,
        // Personal: the ceiling is counted per class: this place's own `preference` lines against the ceiling, the shared set's lines on their own (the server keeps that ceiling)
        ...(ceiling ? { ceiling: { rows: ceiling.rows, reason: ceiling.reason, replace: replaces, countsFrom: ceiling.countsFrom, ...(effectiveScope === "user_identity" ? { klass: personalClassOf } : {}) } } : {}),
        originRefs: [
          ...(options.originTicketIds ?? (options.ticketId ? [options.ticketId] : [])).map(id => ({ kind: "ticket" as const, id })),
          ...(ctx.runId ? [{ kind: "run" as const, id: ctx.runId }] : []),
          ...(ctx.projectId ? [{ kind: "project" as const, id: ctx.projectId }] : []),
        ],
      };
      try { entry = insertMemoryEntry(entryInput); }
      catch (full) {
        // a full PERSONAL place lets go of its oldest OWN `preference` (never shared) and writes the new line. A shared line is never let go of by the desktop (the server does that, as a tombstone); no tombstone, nothing is told to the server
        // or to another desktop. The screen's wording needs a mock-up: until then one log line and the id in the report. No such line = the old behaviour below (the new line is not written).
        // a place full of its own preferences lets go of its oldest one WITH a card in the conversation the new line was said in. No conversation to put the card in = the old behaviour
        // (the new line is not written, nothing is let go): a line must never disappear without the person being told.
        const released = full instanceof MemoryStoreFullError && effectiveScope === "user_identity" && personalClassOf === "own" && canShowRoomCard(ctx.chatId) ? releaseOldestOwnPreference() : null;
        if (released === null) throw full;
        console.info("[memory] the personal place was full: its oldest own preference was let go for the new line");
        (report.releasedForRoom ??= []).push(released.id);
        entry = insertMemoryEntry(entryInput);
        showRoomCard(entry.id, released.text, effectiveAgentId);
      }
    } catch (error) {
      if (error instanceof MemoryStoreFullError) {
        // The store holds its ceiling of lines and this one replaces none: not written, not tried again, one line in the decision ledger. Code never retires an older line.
        report.discarded += 1;
        recordCandidateDecision({ options, index, event: ev, scope: effectiveScope, action: "discarded", reason: error.reason });
        continue;
      }
      if (!(error instanceof MemoryRevokedError)) throw error;
      if (options.ticketId) redactMemoryTicketEpisode(options.ticketId);
      report.discarded += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope: effectiveScope,
        action: "discarded",
        reason: error.reason === "stale-intake-epoch"
          ? "policy-forgotten-stale-intake"
          : "policy-forgotten-content",
      });
      if (writeProjections && ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "discarded",
          reason: "owner-forgotten",
          kind: ev.memory_kind,
          at: new Date().toISOString(),
        });
      }
      continue;
    }
    if (entry.id.startsWith("unwritten:")) {
      // A hub-called agent keeps no memory anywhere: the store hands back a marked stand-in, nothing was written. Not "written" (#8).
      report.discarded += 1;
      recordCandidateDecision({ options, index, event: ev, scope: effectiveScope, action: "discarded", reason: "policy-hub-agent-no-memory" });
      continue;
    }
    report.written += 1;
    (report.writtenIds ??= []).push(entry.id);
    recordCandidateDecision({
      options,
      index,
      event: ev,
      scope: effectiveScope,
      action: "written",
      reason: resolved.reason,
      targetMemoryId: entry.id,
    });
    // Latest wins for a restated rule under the same owner boundary. The old
    // row is superseded (recoverable) with a `supersedes` edge as provenance.
    try {
      if (supersedes) supersedeExplicitMemory(entry, supersedes);
      else supersedeRestatedMemories(entry);
    } catch (error) {
      console.warn(`[memory] restatement supersede deferred: ${error instanceof Error ? error.message : "unknown"}`);
    }
    // similar_to graph edges are now projected inside insertMemoryEntry on every
    // insert path (curated turns, imports, terminal, mobile), so the curator no
    // longer links a second time — the projection is idempotent regardless.
    if (writeProjections && ctx.projectPath) {
      const projectionLease = beginMemoryProjectionWrite({
        sourceMemoryId: entry.id,
        targetKind: "project-files",
        targetRef: ctx.projectPath,
      });
      if (!projectionLease) continue;
      projectProjections.push({
        lease: projectionLease,
        logRecord: {
          action: "written",
          memory_id: entry.id,
          scope: effectiveScope,
          kind: ev.memory_kind,
          content: ev.content,
          source_provenance: ctx.sourceProvenance ?? "assistant-turn",
          request_context: requestContextForLog(requestContext),
          at: new Date().toISOString(),
        },
        soulLine: SOUL_KINDS.has(ev.memory_kind) && effectiveScope === "project"
          ? `(${ev.memory_kind}) ${ev.content}\n<!-- agentlas-memory:${entry.id} -->`
          : null,
      });
    }
    // 에이전트 기술·경험(agent_repo) — 프로젝트 폴더 유무와 무관하게 빌린 에이전트의
    // 전역 experience.sqlite로 미러링한다(크로스 프로젝트 축적). project 스코프와 달리 프로젝트 고유
    // 정보가 아니므로 격리를 깨지 않는다.
    if (effectiveScope === "agent_repo" && SOUL_KINDS.has(ev.memory_kind)) {
      nestExperienceItems.push({
        id: entry.id,
        kind: ev.memory_kind,
        content: ev.content,
        confidence: entry.confidence,
        sensitivity: entry.sensitivity,
        tags: requestContext?.triggerTerms,
        updatedAt: entry.createdAt,
      });
    }
  }

  if (writeProjections && ctx.projectPath && projectProjections.length > 0) {
    commitMemoryProjectionWrites(
      projectProjections.map((projection) => ({
        lease: projection.lease,
        value: projection,
      })),
      (validProjections) => {
        for (const projection of validProjections) {
          appendMemoryLog(ctx.projectPath!, projection.logRecord);
        }
        const validSoulLines = validProjections.flatMap((projection) => (
          projection.soulLine ? [projection.soulLine] : []
        ));
        if (validSoulLines.length > 0) appendSoulMemory(ctx.projectPath!, validSoulLines);
      },
    );
  }

  // agent_repo 배움을 이 실행에 관여한 빌린 에이전트들의 private ontology cache에 미러링.
  // 데스크탑 DB(agentId 기반 agent_repo)와 Hephaestus vector query(slug 기반)를 잇는다.
  // 호출 전용 허브 에이전트는 기억을 남기지 않는다: 서랍(experience.sqlite)에 더는 쓰지 않는다.
  void nestExperienceItems;

  // The lessons the learning proposer reads, and the memory dreaming and the English migration work on, are made here.
  if (report.written + report.deduped > 0) notifyMemoryWritten();
  return report;
}

/**
 * Convenience: parse an agent reply, curate its events, return the cleaned text + report.
 * Called from the run path after each assistant turn.
 */
function fallbackTurnObservation(cleanedText: string): string | null {
  const plain = cleanedText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain ? plain.slice(0, 360) : null;
}

export function curateReply(
  replyText: string,
  ctx: CurationContext,
  options: CurateReplyOptions = {},
): CuratedReply {
  const parsed = parseMemoryEvents(replyText);
  if (options.automaticOwnerNamespace && options.automaticOwnerNamespace !== getMemoryStoreInfo().ownerNamespace) {
    throw new Error("memory_owner_changed");
  }
  const carried = options.carriedEvents ?? [];
  const modelEvents = carried.length ? [...parsed.events, ...carried] : parsed.events;
  const toolCandidates = Math.max(0, options.toolWrites?.candidates ?? 0);
  const emitterStatus = parsed.events.length === 0 && (carried.length > 0 || toolCandidates > 0) ? "valid" : parsed.emitterStatus;
  const ticket = beginMemoryTicket({
    context: ctx,
    emitterStatus,
    candidateCount: parsed.candidateCount + carried.length + toolCandidates,
    turnSummary: parsed.turnSummary ?? fallbackTurnObservation(parsed.cleanedText),
    reviveFailedTurn: true,
  });
  if (!ticket.created) {
    return {
      cleanedText: parsed.cleanedText,
      report: readMemoryTicketReport(ticket.ticketId),
      ticketId: ticket.ticketId,
      emitterStatus: ticket.emitterStatus,
      curatorMode: "policy",
    };
  }
  const curatorMode: MemoryCuratorMode = "policy";
  // K3': a turn whose model wrote nothing leaves its turn record (above) and nothing else: no "request received" line is made for it any more. What a turn taught is read from its record by the
  // resting-time gathering (gathering.ts), once, together with the turns around it.
  const effectiveEvents = modelEvents;
  const attemptedReport = effectiveEvents.length > 0
    ? curateEvents(effectiveEvents, ctx, {
        ticketId: ticket.ticketId,
        curatorMode,
        projectPath: ctx.projectPath,
        writeProjections: options.writeProjections,
      })
    : emptyReport();
  const decided = memoryDecisionReport(ticket.ticketId, attemptedReport);
  const toolReport = options.toolWrites?.report;
  const report: CurationReport = toolReport ? {
    written: decided.written + toolReport.written, deduped: decided.deduped + toolReport.deduped, redacted: decided.redacted + toolReport.redacted,
    sessionOnly: decided.sessionOnly + toolReport.sessionOnly, discarded: decided.discarded + toolReport.discarded } : decided;
  // The lines the tool wrote at the call belong to this turn's ticket now (the same link a line written here gets).
  for (const id of options.toolWrites?.writtenIds ?? []) {
    try { appendMemoryOrigins(id, [{ kind: "ticket", id: ticket.ticketId }], ctx.projectId); } catch { /* the line is stored; its link to the turn is information, not a condition */ }
  }
  const outcome = parsed.emitterStatus === "malformed" && carried.length === 0 && toolCandidates === 0
    ? "malformed_output"
    : modelEvents.length === 0 && toolCandidates === 0
      ? "no_candidates"
      : "decided";
  appendTurnOutcomeDecision({
    projectPath: options.writeProjections === true ? ctx.projectPath : null,
    ticketId: ticket.ticketId,
    outcome,
    report,
    curatorMode,
  });
  completeMemoryTicket(ticket.ticketId, report, curatorMode, { outcome });
  recordCurationReceipt(ctx, report);
  return {
    cleanedText: parsed.cleanedText,
    report,
    ticketId: ticket.ticketId,
    emitterStatus,
    curatorMode,
  };
}

/**
 * Read-boundary counterpart: remove model-emitted memory control blocks but
 * never persist, dedupe, intake Experience, or touch agent/project memory.
 * The run ledger receives counts only so operators can audit attempted events
 * without storing their content.
 */
export function stripReplyMemoryEventsReadOnly(
  replyText: string,
  ctx: CurationContext,
  previouslyDiscarded = 0,
): CuratedReply {
  const parsed = stripAllMemoryEventBlocks(replyText);
  const report: CurationReport = {
    written: 0,
    deduped: 0,
    redacted: 0,
    sessionOnly: 0,
    discarded: Math.max(0, previouslyDiscarded) + parsed.events.length,
  };
  let finalReport = report;
  const ticket = beginMemoryTicket({
    context: ctx,
    emitterStatus: "read_only",
    candidateCount: parsed.candidateCount + Math.max(0, previouslyDiscarded),
    turnSummary: parsed.turnSummary ?? fallbackTurnObservation(parsed.cleanedText),
    reviveFailedTurn: true,
  });
  if (ticket.created) {
    for (const [index, event] of parsed.events.entries()) {
      recordCandidateDecision({
        options: {
          ticketId: ticket.ticketId,
          curatorMode: "read_only",
          // The DB receipt may retain a one-way project-path hash, but a
          // read-only run must never append to project-local files.
          projectPath: null,
        },
        index,
        event,
        scope: "discard",
        action: "discarded",
        reason: "read-only-boundary",
      });
    }
    appendTurnOutcomeDecision({
      projectPath: null,
      ticketId: ticket.ticketId,
      outcome: "read_only",
      report,
      curatorMode: "read_only",
    });
    const stableReport = memoryDecisionReport(ticket.ticketId, report);
    stableReport.discarded = Math.max(stableReport.discarded, report.discarded);
    finalReport = stableReport;
    completeMemoryTicket(ticket.ticketId, stableReport, "read_only", { readOnly: true, outcome: "read_only" });
  }
  recordCurationReceipt(ctx, report);
  return {
    cleanedText: parsed.cleanedText,
    report: ticket.created ? finalReport : readMemoryTicketReport(ticket.ticketId),
    ticketId: ticket.ticketId,
    emitterStatus: "read_only",
    curatorMode: "read_only",
  };
}
