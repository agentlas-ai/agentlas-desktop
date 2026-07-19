// Parses the "## Memory Events" block an agent appends to its reply (see
// MEMORY_EMITTER_BLOCK). Returns normalized events + the reply with the block stripped,
// so the chat stays clean while the curator still receives the structured data.
import {
  MEMORY_EVENTS_HEADING,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryScope,
} from "../architecture/manifest";
import type { RequestContext } from "./store";
import type { MemoryEmitterStatus } from "./tickets";

export interface RawMemoryEvent {
  memory_kind: MemoryKind;
  content: string;
  suggested_scope: MemoryScope;
  confidence: "high" | "medium" | "low";
  sensitivity: "public" | "internal" | "private" | "confidential" | "secret";
  evidence_refs: string[];
  request_context?: RequestContext;
}

export interface ParsedMemory {
  events: RawMemoryEvent[];
  /** Number of raw candidate slots in the envelope, including invalid ones. */
  candidateCount: number;
  /** Compact model-authored turn observation; never a raw prompt/transcript. */
  turnSummary: string | null;
  emitterStatus: Exclude<MemoryEmitterStatus, "read_only">;
  /** Reply text with the Memory Events block removed (trimmed). */
  cleanedText: string;
}

function coerceKind(v: unknown): MemoryKind {
  return MEMORY_KINDS.includes(v as MemoryKind) ? (v as MemoryKind) : "fact";
}

function coerceScope(v: unknown): MemoryScope {
  if (v === "agent_team") return "team_memory";
  return MEMORY_SCOPES.includes(v as MemoryScope) ? (v as MemoryScope) : "session";
}

function coerceConfidence(v: unknown): RawMemoryEvent["confidence"] {
  return v === "high" || v === "low" ? v : "medium";
}

function coerceSensitivity(v: unknown): RawMemoryEvent["sensitivity"] {
  return v === "public" || v === "private" || v === "confidential" || v === "secret"
    ? v
    : "internal";
}

function coerceString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function coerceStringOrNull(v: unknown, max: number): string | null | undefined {
  if (v === null) return null;
  return coerceString(v, max);
}

function coerceRequestContext(v: unknown): RequestContext | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const triggerTerms = Array.isArray(o.trigger_terms)
    ? o.trigger_terms
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 12)
    : undefined;
  const ctx: RequestContext = {};
  const userIntent = coerceString(o.user_intent, 240);
  const cwdAtRequest = coerceStringOrNull(o.cwd_at_request, 500);
  const targetProject = coerceStringOrNull(o.target_project, 120);
  const targetPath = coerceStringOrNull(o.target_path, 500);
  const outcome = coerceStringOrNull(o.outcome, 240);
  if (userIntent) ctx.userIntent = userIntent;
  if (triggerTerms && triggerTerms.length > 0) ctx.triggerTerms = triggerTerms;
  if (cwdAtRequest !== undefined) ctx.cwdAtRequest = cwdAtRequest;
  if (targetProject !== undefined) ctx.targetProject = targetProject;
  if (targetPath !== undefined) ctx.targetPath = targetPath;
  if (typeof o.cross_context === "boolean") ctx.crossContext = o.cross_context;
  if (outcome !== undefined) ctx.outcome = outcome;
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

function normalize(raw: unknown): RawMemoryEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const content = typeof o.content === "string" ? o.content.trim() : "";
  if (!content) return null;
  const evidence = Array.isArray(o.evidence_refs)
    ? o.evidence_refs.filter((x): x is string => typeof x === "string")
    : [];
  const event: RawMemoryEvent = {
    memory_kind: coerceKind(o.memory_kind),
    content,
    suggested_scope: coerceScope(o.suggested_scope),
    confidence: coerceConfidence(o.confidence),
    sensitivity: coerceSensitivity(o.sensitivity),
    evidence_refs: evidence,
  };
  const requestContext = coerceRequestContext(o.request_context);
  if (requestContext) event.request_context = requestContext;
  return event;
}

/**
 * Find the Memory Events heading, then the first JSON fence after it. Tolerant of
 * ```json or bare ``` fences and trailing prose.
 */
export function parseMemoryEvents(text: string): ParsedMemory {
  const headingIdx = text.lastIndexOf(MEMORY_EVENTS_HEADING);
  if (headingIdx < 0) {
    // Host models occasionally omit only the heading while still returning the
    // exact private memory-ticket envelope at the end of an otherwise normal
    // reply. Recognize that closed schema instead of leaking its JSON into the
    // user conversation. Ordinary visible JSON is untouched.
    const tailFence = text.match(/(?:^|\n)```json\s*([\s\S]*?)```\s*$/i);
    if (tailFence && tailFence.index != null) {
      try {
        const data = JSON.parse(tailFence[1].trim()) as Record<string, unknown>;
        if (data?.schema_version === "agentlas.memory-ticket.v1" && Array.isArray(data.candidates)) {
          const candidates = data.candidates;
          const events = candidates.map(normalize).filter((event): event is RawMemoryEvent => event !== null);
          const turnSummary = coerceString(data.turn_summary, 360) ?? null;
          return {
            events,
            candidateCount: candidates.length,
            turnSummary,
            emitterStatus: candidates.length === 0 ? "empty" : events.length > 0 ? "valid" : "malformed",
            cleanedText: text.slice(0, tailFence.index).trim(),
          };
        }
      } catch {
        // Not the exact memory-ticket envelope. Preserve it as visible content.
      }
    }
    return { events: [], candidateCount: 0, turnSummary: null, emitterStatus: "missing", cleanedText: text.trim() };
  }

  const after = text.slice(headingIdx + MEMORY_EVENTS_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let events: RawMemoryEvent[] = [];
  let candidateCount = 0;
  let turnSummary: string | null = null;
  let emitterStatus: ParsedMemory["emitterStatus"] = "malformed";
  if (fence) {
    try {
      const data = JSON.parse(fence[1].trim());
      if (Array.isArray(data)) {
        candidateCount = data.length;
        events = data.map(normalize).filter((e): e is RawMemoryEvent => e !== null);
        emitterStatus = data.length === 0 ? "empty" : events.length > 0 ? "valid" : "malformed";
      } else if (data && typeof data === "object") {
        const envelope = data as Record<string, unknown>;
        const candidates = Array.isArray(envelope.candidates) ? envelope.candidates : null;
        if (candidates) {
          candidateCount = candidates.length;
          events = candidates.map(normalize).filter((e): e is RawMemoryEvent => e !== null);
          const summary = coerceString(envelope.turn_summary, 360);
          turnSummary = summary ?? null;
          emitterStatus = candidates.length === 0
            ? "empty"
            : events.length > 0
              ? "valid"
              : "malformed";
        }
      }
    } catch {
      events = [];
      emitterStatus = "malformed";
    }
  }

  // Strip from the heading to the end of the fenced block (or end of string).
  let cut = text.length;
  if (fence && fence.index != null) {
    cut = headingIdx + MEMORY_EVENTS_HEADING.length + fence.index + fence[0].length;
  } else {
    cut = text.length; // no fence found — drop the dangling heading and tail too
  }
  const cleaned = (text.slice(0, headingIdx) + text.slice(cut)).trim();
  return { events, candidateCount, turnSummary, emitterStatus, cleanedText: cleaned };
}

/**
 * Restricted-boundary sanitizer. Models can emit more than one control block;
 * remove every occurrence, including dangling headings, before text crosses a
 * pass, wire, or persistence boundary. The bounded fallback drops everything
 * after the first remaining heading instead of failing open on adversarial spam.
 */
export function stripAllMemoryEventBlocks(text: string): ParsedMemory {
  let cleanedText = text.trim();
  const events: RawMemoryEvent[] = [];
  let candidateCount = 0;
  let turnSummary: string | null = null;
  let emitterStatus: ParsedMemory["emitterStatus"] = "missing";
  for (let index = 0; index < 32 && cleanedText.includes(MEMORY_EVENTS_HEADING); index += 1) {
    const previous = cleanedText;
    const parsed = parseMemoryEvents(previous);
    events.push(...parsed.events);
    candidateCount += parsed.candidateCount;
    if (parsed.turnSummary) turnSummary = parsed.turnSummary;
    if (parsed.emitterStatus === "malformed") emitterStatus = "malformed";
    else if (emitterStatus !== "malformed" && parsed.emitterStatus === "valid") emitterStatus = "valid";
    else if (emitterStatus === "missing") emitterStatus = parsed.emitterStatus;
    cleanedText = parsed.cleanedText;
    if (cleanedText === previous) break;
  }
  const remaining = cleanedText.indexOf(MEMORY_EVENTS_HEADING);
  if (remaining >= 0) cleanedText = cleanedText.slice(0, remaining).trim();
  return { events, candidateCount, turnSummary, emitterStatus, cleanedText };
}
