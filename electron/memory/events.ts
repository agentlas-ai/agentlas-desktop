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
  if (headingIdx < 0) return { events: [], cleanedText: text.trim() };

  const after = text.slice(headingIdx + MEMORY_EVENTS_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let events: RawMemoryEvent[] = [];
  if (fence) {
    try {
      const data = JSON.parse(fence[1].trim());
      if (Array.isArray(data)) {
        events = data.map(normalize).filter((e): e is RawMemoryEvent => e !== null);
      }
    } catch {
      events = [];
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
  return { events, cleanedText: cleaned };
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
  for (let index = 0; index < 32 && cleanedText.includes(MEMORY_EVENTS_HEADING); index += 1) {
    const previous = cleanedText;
    const parsed = parseMemoryEvents(previous);
    events.push(...parsed.events);
    cleanedText = parsed.cleanedText;
    if (cleanedText === previous) break;
  }
  const remaining = cleanedText.indexOf(MEMORY_EVENTS_HEADING);
  if (remaining >= 0) cleanedText = cleanedText.slice(0, remaining).trim();
  return { events, cleanedText };
}
