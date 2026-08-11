// Memory governance boundary — runs after EVERY completed turn. A no-tools
// semantic Curator may propose disposition/scope; deterministic policy remains
// the final privacy, owner isolation, deduplication, graph, and write authority.
import {
  appendAgentNestExperienceMemory,
  type AgentNestExperienceItem,
  appendMemoryLog,
  appendSoulMemory,
} from "./project-files";
import { hasEquivalentMemory, insertMemoryEntry, type RequestContext } from "./store";
import { autoIntakeCuratedMemory } from "../experience/store";
import {
  parseMemoryEvents,
  stripAllMemoryEventBlocks,
  type RawMemoryEvent,
} from "./events";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import { tryRecordRunEvent } from "../store/run-events";

// Secret/credential detection — events matching these are dropped, never stored.
// Shared with every other write boundary; this file used to carry its own shorter list that
// missed github_pat_/gho_/AIza/glpat/hf_/npm_/JWT/sk_live_ while other boundaries caught them.
// looksSecret is the single chokepoint before memory writes, including the agent_repo nest
// mirroring that crosses projects — a miss here reaches the widest surface in the product.
import { looksSecret } from "../../shared/secret-patterns";
import type { SemanticMemoryDecision } from "./semantic-curator";
import {
  beginMemoryTicket,
  completeMemoryTicket,
  memoryDecisionReport,
  readMemoryTicketReport,
  recordMemoryDecision,
  type MemoryCuratorMode,
  type MemoryEmitterStatus,
} from "./tickets";
import { appendCuratorDecision } from "./project-artifacts";

export interface CurationContext {
  /** Main-authored before the model call. Renderer/model input is never trusted here. */
  turnId?: string | null;
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
   * coordination → orchestrator, shared norms → team_memory, domain skill/taste
   * → the member cell. Absent (single-agent run) → behavior is unchanged.
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
  hasWellShapedEvidence,
  loadCuratorRuleset,
  mentionsProjectSpecifics as rulesMentionsProjectSpecifics,
  widensCapability,
  type TeamLearningLayer,
  narrowAgentRepoScope,
  noWorkspaceFallbackScope,
} from "./curator-rules";

// R21 W2a — kinds whose evidence must be machine-checkable in shape before a
// durable claim is written. Matches the OS ruleset kinds.evidenceRequired: a
// preference/hypothesis is not held to this bar.
const EVIDENCE_SHAPE_REQUIRED: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  "fact",
  "decision",
  "procedure",
]);

export { classifyTeamLearningRoute, type TeamLearningLayer };

/**
 * Apply the team layer routing to a resolved durable learning. Only rewrites
 * agent_repo learning (the scope the 3 layers live on); every other scope is
 * returned unchanged. Deterministic and side-effect free.
 */
function routeTeamLearning(
  scope: MemoryScope,
  kind: MemoryKind,
  ownerAgentId: string | null,
  teamRun: NonNullable<CurationContext["teamRun"]>,
): { scope: MemoryScope; agentId: string | null } {
  if (scope !== "agent_repo") return { scope, agentId: ownerAgentId };
  const layer = classifyTeamLearningRoute(kind);
  if (layer === "shared") return { scope: "team_memory", agentId: null };
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
}

export interface CurateReplyOptions {
  semanticDecisions?: SemanticMemoryDecision[];
  semanticAttempted?: boolean;
  semanticFailed?: boolean;
}

export interface CuratedReply {
  cleanedText: string;
  report: CurationReport;
  ticketId: string;
  emitterStatus: MemoryEmitterStatus;
  curatorMode: MemoryCuratorMode;
}

// Kinds that assert something about the world. A low-confidence claim of one
// of these is quarantined to the session log instead of being promoted —
// the AMGB governed reference's trust gate.
const QUARANTINE_ON_LOW_CONFIDENCE: ReadonlySet<MemoryKind> = new Set([
  "fact",
  "decision",
  "procedure",
]);

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
    turnSummary: status === "cancelled"
      ? "The model turn was cancelled before a final response."
      : status === "curation_failed"
        ? "The model turn completed but its semantic memory review was unavailable."
        : "The model turn ended without a final response.",
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
    if (ev.confidence !== "high" || !USER_IDENTITY_KINDS.has(ev.memory_kind)) {
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
  if (looksSecret(JSON.stringify(next))) return null;
  return Object.keys(next).length > 0 ? next : null;
}

function buildRequestContext(
  ev: RawMemoryEvent,
  ctx: CurationContext,
  projectPath: string | null,
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

function evidenceWithSourceProvenance(ev: RawMemoryEvent, ctx: CurationContext): string[] {
  // Runtime callers normally pass parsed events, but direct deterministic tests and
  // legacy integrations may omit evidence_refs; preserve the former empty-list behavior.
  const evidence = (ev.evidence_refs ?? []).slice();
  if (ctx.sourceProvenance) evidence.push(`source:${ctx.sourceProvenance}`);
  return [...new Set(evidence)];
}

interface EventCurationOptions {
  ticketId?: string;
  curatorMode?: MemoryCuratorMode;
  semanticDecisions?: SemanticMemoryDecision[];
  projectPath?: string | null;
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
  if (!input.options.ticketId) return;
  recordMemoryDecision({
    ticketId: input.options.ticketId,
    candidateIndex: input.index,
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
  if (input.options.projectPath) {
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

function scopeForCandidate(
  event: RawMemoryEvent,
  index: number,
  ctx: CurationContext,
  options: EventCurationOptions,
): { scope: MemoryScope; reason: string; deferred: boolean } {
  const semantic = options.semanticDecisions?.find((decision) => decision.candidateIndex === index);
  if (!semantic) return { scope: resolveScope(event, ctx), reason: "policy-scope", deferred: false };
  if (semantic.disposition === "discard") {
    return { scope: "discard", reason: semantic.reasonCode, deferred: false };
  }
  if (semantic.disposition === "session" || semantic.disposition === "defer") {
    return {
      scope: "session",
      reason: semantic.reasonCode,
      deferred: semantic.disposition === "defer",
    };
  }
  // The model may propose scope, but the same deterministic narrowing gates are
  // re-applied here. It cannot create a project/agent owner or widen synthesis.
  return {
    scope: resolveScope({ ...event, suggested_scope: semantic.resolvedScope }, ctx),
    reason: semantic.reasonCode,
    deferred: false,
  };
}

/** Curate a batch of raw events into durable memory. Pure side effects + a report. */
export function curateEvents(
  events: RawMemoryEvent[],
  ctx: CurationContext,
  options: EventCurationOptions = {},
): CurationReport {
  const report = emptyReport();
  const soulLines: string[] = [];
  // agent_repo 스코프(에이전트 기술·경험) 배움 — 빌린 에이전트의 전역 둥지로 미러링할 후보.
  const nestExperienceItems: AgentNestExperienceItem[] = [];

  for (const [index, ev] of events.entries()) {
    if (ev.sensitivity === "secret" || looksSecret(ev.content)) {
      report.redacted += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope: "discard",
        action: "redacted",
        reason: "policy-secret",
      });
      if (ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "redacted",
          reason: "secret",
          kind: ev.memory_kind,
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    // Trust gate — the one AMGB governed rule this curator was missing. The
    // benchmark reference (governance 1.000) quarantines a low-trust claim
    // before promotion: it may sit in the session log, it never becomes a
    // durable fact. Here the emitter's own confidence is the trust signal, and
    // the gate is deliberately narrow: only kinds that assert something about
    // the world (fact/decision/procedure) are held back — a low-confidence
    // "hypothesis" is already labelled as conjecture and a "preference" is the
    // user's to state at any confidence. Without this, a low-confidence fact
    // was written durable exactly like a high-confidence one, which is the
    // measured difference between governance 1.000 and 0.617.
    if (ev.confidence === "low" && QUARANTINE_ON_LOW_CONFIDENCE.has(ev.memory_kind)) {
      report.sessionOnly += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope: "session",
        action: "session",
        reason: "policy-low-trust-quarantine",
      });
      if (ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "session",
          reason: "low-trust-quarantine",
          kind: ev.memory_kind,
          content: ev.content,
          source_provenance: ctx.sourceProvenance ?? "assistant-turn",
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    // R21 W2b — a memory may never widen tool permissions (n=1 invariant, R20).
    // Discarded like a policy violation; an approval OBSERVATION is not matched.
    if (widensCapability(ev.content)) {
      report.discarded += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope: "discard",
        action: "discarded",
        reason: "capability-widening",
      });
      if (ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "discarded",
          reason: "capability-widening",
          kind: ev.memory_kind,
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    // R21 W2a — an evidence-required claim whose evidence is present but all
    // ill-shaped (self-reported ratings/feelings only) is held to the session
    // log, never durable. Empty evidence keeps its existing path; ANY one
    // well-shaped entry passes, so real evidence is never starved.
    if (
      EVIDENCE_SHAPE_REQUIRED.has(ev.memory_kind) &&
      ev.evidence_refs.length > 0 &&
      !hasWellShapedEvidence(ev.evidence_refs)
    ) {
      report.sessionOnly += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope: "session",
        action: "deferred",
        reason: "evidence-shape-insufficient",
      });
      if (ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "session",
          reason: "evidence-shape-insufficient",
          kind: ev.memory_kind,
          content: ev.content,
          source_provenance: ctx.sourceProvenance ?? "assistant-turn",
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    const resolved = scopeForCandidate(ev, index, ctx, options);
    const scope = resolved.scope;
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
      if (ctx.projectPath) {
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
      ? routeTeamLearning(scope, ev.memory_kind, ctx.agentId, ctx.teamRun)
      : { scope, agentId: ctx.agentId };
    const effectiveScope = routed.scope;
    const effectiveAgentId = routed.agentId;

    const projectPath = effectiveScope === "project" ? ctx.projectPath : null;
    const requestContext = buildRequestContext(ev, ctx, projectPath);
    if (hasEquivalentMemory(effectiveScope, ev.memory_kind, ev.content, projectPath, effectiveAgentId)) {
      report.deduped += 1;
      recordCandidateDecision({
        options,
        index,
        event: ev,
        scope: effectiveScope,
        action: "deduped",
        reason: "policy-exact-duplicate",
      });
      continue;
    }

    const entry = insertMemoryEntry({
      scope: effectiveScope,
      kind: ev.memory_kind,
      content: ev.content,
      projectId: ctx.projectId,
      projectPath,
      agentId: effectiveAgentId,
      chatId: ctx.chatId,
      confidence: ev.confidence,
      sensitivity: ev.sensitivity,
      evidence: evidenceWithSourceProvenance(ev, ctx),
      requestContext,
    });
    report.written += 1;
    recordCandidateDecision({
      options,
      index,
      event: ev,
      scope: effectiveScope,
      action: "written",
      reason: resolved.reason,
      targetMemoryId: entry.id,
    });
    // similar_to graph edges are now projected inside insertMemoryEntry on every
    // insert path (curated turns, imports, terminal, mobile), so the curator no
    // longer links a second time — the projection is idempotent regardless.
    if (effectiveAgentId && ctx.experienceIntake) {
      try {
        autoIntakeCuratedMemory({
          memory: entry,
          agentId: effectiveAgentId,
          projectId: ctx.projectId,
          projectPath: ctx.projectPath,
          environment: {
            platform: ctx.experienceIntake.platform,
            arch: ctx.experienceIntake.arch,
            runtimeKind: ctx.experienceIntake.runtimeKind,
          },
          basePackageHash: ctx.experienceIntake.basePackageHash,
          taskHint: ctx.experienceIntake.taskHint,
          // 인터랙티브 런의 durable 식별자 — 성공 턴 완료 시 이 런이 만든 후보를
          // run-receipt 기반으로 자동 승격할 수 있게 영수증에 남긴다.
          runId: ctx.runId ?? null,
        });
      } catch (error) {
        console.warn(`[experience] automatic intake deferred: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }

    if (ctx.projectPath) {
      appendMemoryLog(ctx.projectPath, {
        action: "written",
        scope: effectiveScope,
        kind: ev.memory_kind,
        content: ev.content,
        source_provenance: ctx.sourceProvenance ?? "assistant-turn",
        request_context: requestContextForLog(requestContext),
        at: new Date().toISOString(),
      });
      if (SOUL_KINDS.has(ev.memory_kind) && effectiveScope === "project") {
        soulLines.push(`(${ev.memory_kind}) ${ev.content}`);
      }
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

  if (ctx.projectPath && soulLines.length > 0) {
    appendSoulMemory(ctx.projectPath, soulLines);
  }

  // agent_repo 배움을 이 실행에 관여한 빌린 에이전트들의 private ontology cache에 미러링.
  // 데스크탑 DB(agentId 기반 agent_repo)와 Hephaestus vector query(slug 기반)를 잇는다.
  const nestSlugs = [...new Set((ctx.borrowedAgentSlugs ?? []).map((s) => s.trim()).filter(Boolean))];
  if (nestExperienceItems.length > 0 && nestSlugs.length > 0) {
    for (const slug of nestSlugs) {
      appendAgentNestExperienceMemory(slug, nestExperienceItems);
    }
  }

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
  const ticket = beginMemoryTicket({
    context: ctx,
    emitterStatus: parsed.emitterStatus,
    candidateCount: parsed.candidateCount,
    turnSummary: parsed.turnSummary ?? fallbackTurnObservation(parsed.cleanedText),
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
  const curatorMode: MemoryCuratorMode = options.semanticAttempted
    ? options.semanticFailed
      ? "policy_fallback"
      : "semantic"
    : "policy";
  const attemptedReport = parsed.events.length > 0
    ? curateEvents(parsed.events, ctx, {
        ticketId: ticket.ticketId,
        curatorMode,
        semanticDecisions: options.semanticDecisions,
        projectPath: ctx.projectPath,
      })
    : emptyReport();
  const report = memoryDecisionReport(ticket.ticketId, attemptedReport);
  const outcome = parsed.emitterStatus === "malformed"
    ? "malformed_output"
    : options.semanticFailed
      ? "curator_failed"
      : parsed.events.length === 0
        ? "no_candidates"
        : "decided";
  appendTurnOutcomeDecision({
    projectPath: ctx.projectPath,
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
    emitterStatus: parsed.emitterStatus,
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
