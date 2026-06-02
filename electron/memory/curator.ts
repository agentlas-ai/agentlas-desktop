// Deterministic Memory Curator — runs after EVERY turn (no extra LLM call, no latency).
// It applies the curator contract in code: safety redaction, scope resolution, dedup,
// and durable persistence. The Memory Curator *agent* (LLM) remains available for explicit
// deep curation; this is the always-on substrate that keeps memory flowing for every chat.
import { createHash, randomUUID } from "node:crypto";
import {
  appendMemoryLog,
  appendMemoryTicket,
  appendSoulMemory,
} from "./project-files";
import { hasEquivalentMemory, insertMemoryEntry, type RequestContext } from "./store";
import { parseMemoryEvents, type RawMemoryEvent } from "./events";
import {
  MEMORY_LOG_FILE,
  MEMORY_MAP_FILE,
  type MemoryKind,
  type MemoryScope,
} from "../architecture/manifest";

// Secret/credential patterns — events matching these are dropped, never stored.
const SECRET_PATTERNS: RegExp[] = [
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
  cwdAtRequest?: string | null;
}

export interface CurationReport {
  written: number;
  deduped: number;
  redacted: number;
  sessionOnly: number;
  discarded: number;
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

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function ticketId(): string {
  return `memtkt_${randomUUID().replace(/-/g, "")}`;
}

function projectIdForTicket(ctx: CurationContext): string {
  if (ctx.projectId) return ctx.projectId;
  if (ctx.projectPath) return ctx.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? "local-project";
  return "global";
}

function sourceAgentForTicket(ctx: CurationContext): string {
  return ctx.agentId || "agentlas-runtime";
}

function appendTicketAudit(
  events: RawMemoryEvent[],
  ctx: CurationContext,
  report: CurationReport,
): void {
  if (!ctx.projectPath || events.length === 0) return;
  const now = new Date().toISOString();
  const sourceAgent = sourceAgentForTicket(ctx);
  const taskId = ctx.chatId || `turn_${shortHash(`${sourceAgent}:${now}`)}`;
  const projectId = projectIdForTicket(ctx);

  for (let start = 0; start < events.length; start += 20) {
    const chunk = events.slice(start, start + 20);
    const chunkHash = shortHash(JSON.stringify(chunk.map((ev) => ({
      k: ev.memory_kind,
      s: ev.suggested_scope,
      c: ev.content,
      e: ev.evidence_refs,
    }))));
    appendMemoryTicket(ctx.projectPath, {
      ticket_id: ticketId(),
      created_at: now,
      source_agent: sourceAgent,
      task_id: taskId,
      project_id: projectId,
      project_root: ctx.projectPath,
      source_map_ref: `.agentlas/${MEMORY_MAP_FILE}`,
      target_agent: "memory-curator",
      return_channel: {
        kind: "file_inbox",
        ref: `.agentlas/${MEMORY_LOG_FILE}`,
      },
      status: "acked",
      idempotency_key: `${sourceAgent}:${taskId}:${chunkHash}`,
      priority: "normal",
      queue_policy: {
        ack_required: true,
        max_batch_size: 20,
        overflow_action: "split_ticket",
        retry_after_seconds: 300,
      },
      candidates: chunk.map((ev, index) => {
        const candidate: Record<string, unknown> = {
          event_id: `memevt_${shortHash(`${sourceAgent}:${taskId}:${start + index}:${ev.content}`)}`,
          timestamp: now,
          source_agent: sourceAgent,
          task_id: taskId,
          project_id: projectId,
          memory_kind: ev.memory_kind,
          content: ev.content,
          suggested_scope: ev.suggested_scope,
          sensitivity: ev.sensitivity,
          confidence: ev.confidence,
          retrieval_policy: "balanced",
          evidence_refs: ev.evidence_refs,
          ttl: ev.suggested_scope === "session" || ev.suggested_scope === "discard" ? "session" : "durable",
        };
        const requestContext = requestContextForLog(
          buildRequestContext(
            ev,
            ctx,
            ev.suggested_scope === "project" ? ctx.projectPath : null,
          ),
        );
        if (requestContext) candidate.request_context = requestContext;
        return candidate;
      }),
      diagnostics: {
        legacy_shape_detected: false,
        normalization_notes: [
          `ack written=${report.written}`,
          `deduped=${report.deduped}`,
          `session=${report.sessionOnly}`,
          `redacted=${report.redacted}`,
          `discarded=${report.discarded}`,
        ],
        failure_mode: report.redacted > 0 ? "secret_detected" : null,
      },
    });
  }
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
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    const projectPath = scope === "project" ? ctx.projectPath : null;
    const requestContext = buildRequestContext(ev, ctx, projectPath);
    if (hasEquivalentMemory(scope, ev.memory_kind, ev.content, projectPath)) {
      report.deduped += 1;
      continue;
    }

    insertMemoryEntry({
      scope,
      kind: ev.memory_kind,
      content: ev.content,
      projectId: ctx.projectId,
      projectPath,
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      confidence: ev.confidence,
      sensitivity: ev.sensitivity,
      evidence: ev.evidence_refs,
      requestContext,
    });
    report.written += 1;

    if (ctx.projectPath) {
      appendMemoryLog(ctx.projectPath, {
        action: "written",
        scope,
        kind: ev.memory_kind,
        content: ev.content,
        request_context: requestContextForLog(requestContext),
        at: new Date().toISOString(),
      });
      if (SOUL_KINDS.has(ev.memory_kind) && scope === "project") {
        soulLines.push(`(${ev.memory_kind}) ${ev.content}`);
      }
    }
  }

  if (ctx.projectPath && soulLines.length > 0) {
    appendSoulMemory(ctx.projectPath, soulLines);
  }

  appendTicketAudit(events, ctx, report);

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
  return { cleanedText, report };
}
