// Deterministic Memory Curator — runs after EVERY turn (no extra LLM call, no latency).
// It applies the curator contract in code: safety redaction, scope resolution, dedup,
// and durable persistence. The Memory Curator *agent* (LLM) remains available for explicit
// deep curation; this is the always-on substrate that keeps memory flowing for every chat.
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

// Secret/credential patterns — events matching these are dropped, never stored.
const SECRET_PATTERNS: RegExp[] = [
  // Current OpenAI/Anthropic keys add a provider segment and use base64url
  // characters in the payload. Keep this vendor-specific so ordinary dashed
  // prose is not swept up by the broader legacy-key rule below.
  /(?:^|[^A-Za-z0-9_-])sk-(?:ant|proj)-[A-Za-z0-9_-]{16,}(?=$|[^A-Za-z0-9_-])/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*\S+/i,
];

function looksSecret(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

export interface CurationContext {
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
}

export interface CurationReport {
  written: number;
  deduped: number;
  redacted: number;
  sessionOnly: number;
  discarded: number;
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

const USER_IDENTITY_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  "fact",
  "decision",
  "preference",
  "procedure",
]);

function resolveScope(ev: RawMemoryEvent, ctx: CurationContext): MemoryScope {
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
    // No folder bound to this chat → keep it durable but shared.
    return "team_memory";
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

/** Curate a batch of raw events into durable memory. Pure side effects + a report. */
export function curateEvents(
  events: RawMemoryEvent[],
  ctx: CurationContext,
): CurationReport {
  const report: CurationReport = {
    written: 0,
    deduped: 0,
    redacted: 0,
    sessionOnly: 0,
    discarded: 0,
  };
  const soulLines: string[] = [];
  // agent_repo 스코프(에이전트 기술·경험) 배움 — 빌린 에이전트의 전역 둥지로 미러링할 후보.
  const nestExperienceItems: AgentNestExperienceItem[] = [];

  for (const ev of events) {
    if (ev.sensitivity === "secret" || looksSecret(ev.content)) {
      report.redacted += 1;
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

    const scope = resolveScope(ev, ctx);
    if (scope === "discard") {
      report.discarded += 1;
      continue;
    }
    if (scope === "session") {
      // Temporary — log only, never durable.
      report.sessionOnly += 1;
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

    const projectPath = scope === "project" ? ctx.projectPath : null;
    const requestContext = buildRequestContext(ev, ctx, projectPath);
    if (hasEquivalentMemory(scope, ev.memory_kind, ev.content, projectPath, ctx.agentId)) {
      report.deduped += 1;
      continue;
    }

    const entry = insertMemoryEntry({
      scope,
      kind: ev.memory_kind,
      content: ev.content,
      projectId: ctx.projectId,
      projectPath,
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      confidence: ev.confidence,
      sensitivity: ev.sensitivity,
      evidence: evidenceWithSourceProvenance(ev, ctx),
      requestContext,
    });
    report.written += 1;
    if (ctx.agentId && ctx.experienceIntake) {
      try {
        autoIntakeCuratedMemory({
          memory: entry,
          agentId: ctx.agentId,
          projectId: ctx.projectId,
          projectPath: ctx.projectPath,
          environment: {
            platform: ctx.experienceIntake.platform,
            arch: ctx.experienceIntake.arch,
            runtimeKind: ctx.experienceIntake.runtimeKind,
          },
          basePackageHash: ctx.experienceIntake.basePackageHash,
          taskHint: ctx.experienceIntake.taskHint,
        });
      } catch (error) {
        console.warn(`[experience] automatic intake deferred: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }

    if (ctx.projectPath) {
      appendMemoryLog(ctx.projectPath, {
        action: "written",
        scope,
        kind: ev.memory_kind,
        content: ev.content,
        source_provenance: ctx.sourceProvenance ?? "assistant-turn",
        request_context: requestContextForLog(requestContext),
        at: new Date().toISOString(),
      });
      if (SOUL_KINDS.has(ev.memory_kind) && scope === "project") {
        soulLines.push(`(${ev.memory_kind}) ${ev.content}`);
      }
    }
    // 에이전트 기술·경험(agent_repo) — 프로젝트 폴더 유무와 무관하게 빌린 에이전트의
    // 전역 experience.sqlite로 미러링한다(크로스 프로젝트 축적). project 스코프와 달리 프로젝트 고유
    // 정보가 아니므로 격리를 깨지 않는다.
    if (scope === "agent_repo" && SOUL_KINDS.has(ev.memory_kind)) {
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
export function curateReply(
  replyText: string,
  ctx: CurationContext,
): { cleanedText: string; report: CurationReport } {
  const { events, cleanedText } = parseMemoryEvents(replyText);
  const report =
    events.length > 0
      ? curateEvents(events, ctx)
      : { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 };
  recordCurationReceipt(ctx, report);
  return { cleanedText, report };
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
): { cleanedText: string; report: CurationReport } {
  const { events, cleanedText } = stripAllMemoryEventBlocks(replyText);
  const report: CurationReport = {
    written: 0,
    deduped: 0,
    redacted: 0,
    sessionOnly: 0,
    discarded: Math.max(0, previouslyDiscarded) + events.length,
  };
  recordCurationReceipt(ctx, report);
  return { cleanedText, report };
}
