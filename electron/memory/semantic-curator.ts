// Model-facing half of Memory governance. This module never writes memory.
// It builds a content-bounded request and parses a proposed disposition; the
// deterministic Curator remains the final privacy/scope/write authority.
import { looksSecret } from "../../shared/secret-patterns";
import { MEMORY_SCOPES, type MemoryScope } from "../architecture/manifest";
import { randomUUID } from "node:crypto";
import type { Runner } from "../runtime/runner";
import type { RawMemoryEvent } from "./events";
import { parseMemoryEvents } from "./events";

export type SemanticDisposition = "accept" | "session" | "discard" | "defer";

export interface SemanticMemoryDecision {
  candidateIndex: number;
  disposition: SemanticDisposition;
  resolvedScope: MemoryScope;
  reasonCode: string;
}

export interface SemanticReviewContext {
  hasProject: boolean;
  hasAgent: boolean;
  sourceProvenance?: "task-force-synthesis";
}

export interface SemanticCurationOptions {
  semanticDecisions?: SemanticMemoryDecision[];
  semanticAttempted?: boolean;
  semanticFailed?: boolean;
}

export const SEMANTIC_MEMORY_CURATOR_PROMPT = `# Agentlas Semantic Memory Curator

You review proposed memory candidates after a completed model turn. You do not solve
the original task and you never write storage. Judge meaning and future usefulness;
the host applies deterministic privacy, ownership, deduplication, and write gates.

Return JSON only: {"schema_version":"agentlas.semantic-curation.v1","decisions":[...]}
Each decision must contain candidate_index, disposition (accept|session|discard|defer),
resolved_scope (user_identity|team_memory|project|agent_repo|session|discard), and a
short stable reason_code. Use user_identity only for a high-confidence stable operator
fact/preference/decision/procedure. Use project for project-specific state. Use
agent_repo only for portable agent-specific learning. Do not invent candidates, quote
transcripts, or include paths, credentials, IDs, or explanations outside JSON.`;

function safeReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = reason.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || "semantic-judgment").slice(0, 80);
}

function disposition(value: unknown): SemanticDisposition | null {
  return value === "accept" || value === "session" || value === "discard" || value === "defer"
    ? value
    : null;
}

function scope(value: unknown): MemoryScope | null {
  if (value === "agent_team") return "team_memory";
  return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : null;
}

/** Secret-looking candidates are deliberately withheld from the second model call. */
export function buildSemanticCurationRequest(
  events: readonly RawMemoryEvent[],
  context: SemanticReviewContext,
): { prompt: string; reviewableIndices: number[] } {
  const candidates = events.flatMap((event, candidateIndex) => {
    if (event.sensitivity === "secret" || looksSecret(event.content)) return [];
    return [{
      candidate_index: candidateIndex,
      memory_kind: event.memory_kind,
      content: event.content.replace(/\s+/g, " ").trim().slice(0, 600),
      suggested_scope: event.suggested_scope,
      confidence: event.confidence,
      sensitivity: event.sensitivity,
      evidence_count: Math.min(20, event.evidence_refs.length),
    }];
  }).slice(0, 32);
  return {
    prompt: JSON.stringify({
      schema_version: "agentlas.semantic-curation-request.v1",
      boundary: {
        project_bound: context.hasProject,
        agent_bound: context.hasAgent,
        source_provenance: context.sourceProvenance ?? "single-agent-turn",
      },
      candidates,
    }),
    reviewableIndices: candidates.map((candidate) => candidate.candidate_index),
  };
}

function jsonPayload(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try {
    return JSON.parse((fenced?.[1] ?? trimmed).trim());
  } catch {
    return null;
  }
}

export function parseSemanticCurationResponse(
  text: string,
  reviewableIndices: readonly number[],
): SemanticMemoryDecision[] {
  const payload = jsonPayload(text);
  if (!payload || typeof payload !== "object") return [];
  const rows = (payload as { decisions?: unknown }).decisions;
  if (!Array.isArray(rows)) return [];
  const allowed = new Set(reviewableIndices);
  const seen = new Set<number>();
  const decisions: SemanticMemoryDecision[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    const candidateIndex = Number(value.candidate_index);
    const nextDisposition = disposition(value.disposition);
    const nextScope = scope(value.resolved_scope);
    if (
      !Number.isInteger(candidateIndex) ||
      !allowed.has(candidateIndex) ||
      seen.has(candidateIndex) ||
      !nextDisposition ||
      !nextScope
    ) continue;
    seen.add(candidateIndex);
    decisions.push({
      candidateIndex,
      disposition: nextDisposition,
      resolvedScope: nextDisposition === "session"
        ? "session"
        : nextDisposition === "discard"
          ? "discard"
          : nextScope,
      reasonCode: safeReason(value.reason_code),
    });
  }
  return decisions;
}

/** Executes the distinct ephemeral/no-tools Curator model pass. */
export async function runSemanticMemoryReview(input: {
  replyText: string;
  runner: Runner;
  backendLabel: string;
  model?: string;
  effort?: string;
  env?: NodeJS.ProcessEnv;
  locale: "ko" | "en";
  signal?: AbortSignal;
  hasProject: boolean;
  hasAgent: boolean;
  sourceProvenance?: "task-force-synthesis";
}): Promise<SemanticCurationOptions> {
  const parsed = parseMemoryEvents(input.replyText);
  const request = buildSemanticCurationRequest(parsed.events, {
    hasProject: input.hasProject,
    hasAgent: input.hasAgent,
    sourceProvenance: input.sourceProvenance,
  });
  if (request.reviewableIndices.length === 0) return {};
  try {
    const result = await input.runner({
      systemPrompt: SEMANTIC_MEMORY_CURATOR_PROMPT,
      history: [],
      userPrompt: request.prompt,
      backendLabel: input.backendLabel,
      model: input.model,
      effort: input.effort,
      signal: input.signal,
      permission: "read",
      env: input.env,
      untrustedNoTools: true,
      chatId: `memory-curator:${randomUUID()}`,
      locale: input.locale,
    }, {
      onStatus: () => undefined,
      onPartial: () => undefined,
      onTool: () => undefined,
    });
    const decisions = parseSemanticCurationResponse(result.text, request.reviewableIndices);
    if (decisions.length !== request.reviewableIndices.length) {
      return { semanticAttempted: true, semanticFailed: true };
    }
    return { semanticDecisions: decisions, semanticAttempted: true, semanticFailed: false };
  } catch (error) {
    console.warn(`[memory] semantic curator fell back to policy: ${error instanceof Error ? error.message : "unknown"}`);
    return { semanticAttempted: true, semanticFailed: true };
  }
}
