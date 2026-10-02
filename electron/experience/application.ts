import { createHash } from "node:crypto";
import type { ExperienceApplicationSnapshot, ExperienceOntologySummary } from "../../shared/experience";
import { invocationHostStopCause, isOwnerGoalStopCause } from "../../shared/invocation-host-stop";
import { getDb } from "../store/db";
import { recordRunEvent } from "../store/run-events";
import { memoryRunPredatesAnyForget } from "../memory/revocations";
import { currentExperienceBaseHash, experienceCandidateSourceIsLive, type PromotedExperienceProjection } from "./store";

const SCHEMA = "agentlas.experience-application.v1" as const;
export const EXPERIENCE_APPLICATION_EVENT_KIND = "experience_application";
const MAX_ITEMS = 8;
const HEX = /^[a-f0-9]{64}$/;
const safeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Content version only; time stamps and success counters cannot manufacture a new version. */
export function experienceApplicationContentHash(item: Pick<PromotedExperienceProjection, "summary" | "taskTerms" | "confidence">): string {
  return digest(["experience-content-v1", item.summary, [...item.taskTerms].sort(), item.confidence]);
}

function readSnapshot(value: unknown): ExperienceApplicationSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== SCHEMA || !safeId(row.agentId)
    || typeof row.scopeHash !== "string" || !HEX.test(row.scopeHash)
    || typeof row.currentBaseHash !== "string" || !HEX.test(row.currentBaseHash)
    || typeof row.taskKey !== "string" || !HEX.test(row.taskKey)
    || !safeId(row.environmentKey)) return null;
  const arrays = [row.candidateIds, row.candidateContentHashes, row.measuredBaseHashes, row.measuredEnvironmentKeys, row.packIds];
  if (arrays.some((values) => !Array.isArray(values))) return null;
  const [candidateIds, candidateContentHashes, measuredBaseHashes, measuredEnvironmentKeys, packIds] = arrays as string[][];
  if (candidateIds.length < 1 || candidateIds.length > MAX_ITEMS
    || arrays.some((values) => (values as unknown[]).length !== candidateIds.length)
    || new Set(candidateIds).size !== candidateIds.length
    || candidateIds.some((value) => !safeId(value)) || packIds.some((value) => !safeId(value))
    || [...candidateContentHashes, ...measuredBaseHashes].some((value) => typeof value !== "string" || !HEX.test(value))
    || measuredEnvironmentKeys.some((value) => !safeId(value))) return null;
  return {
    schemaVersion: SCHEMA, agentId: row.agentId, scopeHash: row.scopeHash as string,
    currentBaseHash: row.currentBaseHash as string, environmentKey: row.environmentKey,
    taskKey: row.taskKey as string, candidateIds: [...candidateIds],
    candidateContentHashes: [...candidateContentHashes], measuredBaseHashes: [...measuredBaseHashes],
    measuredEnvironmentKeys: [...measuredEnvironmentKeys], packIds: [...packIds],
  };
}

/** Pure selection snapshot. Building a preview neither writes a receipt nor changes ranking. */
export function createExperienceApplicationSnapshot(input: {
  agentId: string;
  projectScopeKey: string;
  currentBaseHash: string;
  environmentKey: string;
  taskIds: string[];
}, items: PromotedExperienceProjection[]): ExperienceApplicationSnapshot | undefined {
  return readSnapshot({
    schemaVersion: SCHEMA, agentId: input.agentId,
    scopeHash: digest([input.agentId, input.projectScopeKey, input.environmentKey]),
    currentBaseHash: input.currentBaseHash, environmentKey: input.environmentKey,
    taskKey: digest(["canonical-task-v1", [...input.taskIds].sort()]),
    candidateIds: items.map((item) => item.id),
    candidateContentHashes: items.map(experienceApplicationContentHash),
    measuredBaseHashes: items.map((item) => item.measuredBaseHash),
    measuredEnvironmentKeys: items.map((item) => item.measuredEnvironmentKey),
    packIds: items.map((item) => item.packId),
  }) ?? undefined;
}

/**
 * Read-only admissibility guard shared by the runner request and its receipt.
 * The existing snapshot fingerprints canonical candidate content; it does not
 * fingerprint native prompt wording or prove the provider used the context.
 */
export function experienceApplicationSourcesAreLive(value: unknown): boolean {
  try {
    const snapshot = readSnapshot(value);
    if (!snapshot || currentExperienceBaseHash(snapshot.agentId) !== snapshot.currentBaseHash) return false;
    const keys = new Set(["schemaVersion", "agentId", "scopeHash", "currentBaseHash", "environmentKey", "taskKey",
      "candidateIds", "candidateContentHashes", "measuredBaseHashes", "measuredEnvironmentKeys", "packIds"]);
    if (Object.keys(value as object).some((key) => !keys.has(key))) return false;
    const placeholders = snapshot.candidateIds.map(() => "?").join(",");
    const rows = getDb().prepare(`SELECT c.id, c.pack_id, c.source_memory_id, c.auto_managed, c.summary, c.confidence, c.task_terms_json,
        c.project_scope_key, c.environment_key, p.base_package_hash
      FROM experience_candidates c JOIN experience_packs p ON p.id = c.pack_id AND p.agent_id = c.agent_id
      WHERE c.agent_id = ? AND c.id IN (${placeholders})
        AND p.project_scope_key = c.project_scope_key AND p.environment_key = c.environment_key
        AND p.status = 'active' AND c.status = 'promoted' AND c.outcome_status IN ('attested','verified')
        AND NOT EXISTS (SELECT 1 FROM experience_governance_relations g
          JOIN experience_candidates replacement ON replacement.id = g.from_candidate_id
            AND replacement.pack_id = g.pack_id AND replacement.agent_id = g.agent_id
          WHERE g.to_candidate_id = c.id AND g.pack_id = c.pack_id AND g.agent_id = c.agent_id
            AND g.relation_type = 'supersedes' AND replacement.status = 'promoted'
            AND replacement.outcome_status IN ('attested','verified'))`)
      .all(snapshot.agentId, ...snapshot.candidateIds) as Array<{
        id: string; pack_id: string; source_memory_id: string | null; auto_managed: number; summary: string; confidence: PromotedExperienceProjection["confidence"];
        task_terms_json: string; project_scope_key: string; environment_key: string; base_package_hash: string;
      }>;
    if (rows.length !== snapshot.candidateIds.length) return false;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (let index = 0; index < snapshot.candidateIds.length; index += 1) {
      const row = byId.get(snapshot.candidateIds[index])!;
      const terms: unknown = JSON.parse(row.task_terms_json);
      if (!experienceCandidateSourceIsLive({ sourceMemoryId: row.source_memory_id, candidateId: row.id,
          agentId: snapshot.agentId, projectScopeKey: row.project_scope_key, autoManaged: row.auto_managed === 1 })
        || !Array.isArray(terms) || terms.some((term) => typeof term !== "string")
        || row.pack_id !== snapshot.packIds[index]
        || row.base_package_hash !== snapshot.measuredBaseHashes[index]
        || row.environment_key !== snapshot.measuredEnvironmentKeys[index]
        || digest([snapshot.agentId, row.project_scope_key, snapshot.environmentKey]) !== snapshot.scopeHash
        || experienceApplicationContentHash({ summary: row.summary, confidence: row.confidence, taskTerms: terms })
          !== snapshot.candidateContentHashes[index]) return false;
    }
    return true;
  } catch { return false; }
}

/** Remove only the host-owned Experience part before passing a request to a runner. */
export function prepareExperienceDispatch<T extends {
  systemPrompt: string;
  turnContext?: string;
  turnContextStable?: readonly string[];
}>(input: {
  request: T;
  snapshot: ExperienceApplicationSnapshot | undefined;
  contextParts: readonly string[];
  partIndex: number;
  stablePartIndex: number;
  baseSystemPrompt: string;
  runId?: string;
}): { request: T; application?: ExperienceApplicationSnapshot } {
  const join = (parts: readonly string[]): string => parts.filter((part) => part && part.trim()).join("\n\n");
  const fullContext = join(input.contextParts);
  const part = input.contextParts[input.partIndex];
  if (!part || !fullContext) return { request: input.request };
  const systemPrefix = `${input.baseSystemPrompt}\n\n${fullContext}`;
  const inTurnContext = input.request.turnContext?.startsWith(fullContext) === true;
  const inSystemPrompt = input.request.systemPrompt.startsWith(systemPrefix);
  // Minimal observation requests have no Experience context to attest.
  if (!inTurnContext && !inSystemPrompt) return { request: input.request };
  if (input.snapshot && experienceApplicationSourcesAreLive(input.snapshot)
    && (!input.runId || !memoryRunPredatesAnyForget(input.runId))) {
    return { request: input.request, application: input.snapshot };
  }
  const remaining = join(input.contextParts.filter((_, index) => index !== input.partIndex));
  const nextContext = (context: string): string => `${remaining}${context.slice(fullContext.length)}`.trim();
  const turnContext = inTurnContext ? nextContext(input.request.turnContext!) : input.request.turnContext;
  const systemContext = inSystemPrompt
    ? nextContext(input.request.systemPrompt.slice(input.baseSystemPrompt.length + 2)) : null;
  return {
    request: {
      ...input.request,
      ...(inTurnContext ? { turnContext: turnContext || undefined } : {}),
      ...(inSystemPrompt ? { systemPrompt: systemContext
        ? `${input.baseSystemPrompt}\n\n${systemContext}` : input.baseSystemPrompt } : {}),
      ...(input.request.turnContextStable ? { turnContextStable: input.request.turnContextStable
        .filter((_, index) => index !== input.stablePartIndex) } : {}),
    },
  };
}

/**
 * Called only at host dispatch with the exact prompt selection. The existing
 * unconstrained run ledger keeps schema/old readers unchanged. This proves a
 * dispatch request with context, not provider use or item usefulness.
 */
export function recordExperienceApplication(input: {
  runId: string;
  chatId: string;
  executionAgentId: string;
  snapshot: ExperienceApplicationSnapshot;
  runtime: { kind: string; backend?: string | null; model?: string | null; effort?: string | null };
}): string | null {
  try {
    const snapshot = readSnapshot(input.snapshot);
    if (!snapshot || !safeId(input.runId) || !safeId(input.chatId) || !safeId(input.executionAgentId)
      || currentExperienceBaseHash(snapshot.agentId) !== snapshot.currentBaseHash
      || memoryRunPredatesAnyForget(input.runId)) return null;
    const db = getDb();
    return db.transaction(() => {
      const started = db.prepare(`SELECT agent_id FROM run_events
        WHERE run_id = ? AND chat_id = ? AND kind = 'invoke_started' ORDER BY seq ASC LIMIT 1`)
        .get(input.runId, input.chatId) as { agent_id: string | null } | undefined;
      if (!started || started.agent_id !== input.executionAgentId) return null;
      if (!experienceApplicationSourcesAreLive(input.snapshot)) return null;
      const runtimeKey = digest([input.runtime.kind, input.runtime.backend ?? null, input.runtime.model ?? null, input.runtime.effort ?? null]);
      const applicationKey = digest([snapshot, input.executionAgentId, runtimeKey]);
      const existing = db.prepare(`SELECT id FROM run_events WHERE run_id = ? AND chat_id = ? AND agent_id = ?
        AND kind = ? AND json_valid(payload_json) AND json_extract(payload_json, '$.applicationKey') = ?`)
        .get(input.runId, input.chatId, snapshot.agentId, EXPERIENCE_APPLICATION_EVENT_KIND, applicationKey) as { id: string } | undefined;
      if (existing) return getExperienceApplicationOutcome(existing.id) ? existing.id : null;
      if (db.prepare(`SELECT 1 FROM run_events WHERE run_id = ?
        AND kind IN ('invoke_completed','invoke_failed','invoke_cancelled','invoke_interrupted','invoke_threw') LIMIT 1`)
        .get(input.runId)) return null;
      return recordRunEvent({
        runId: input.runId, chatId: input.chatId, agentId: snapshot.agentId,
        kind: EXPERIENCE_APPLICATION_EVENT_KIND,
        sourceEventId: `experience-application-v1:${applicationKey}`,
        evidencePhase: "requested",
        payload: { ...snapshot, executionAgentId: input.executionAgentId, runtimeKey, applicationKey,
          phase: "dispatch_with_context", rankingPolicy: "relevance-confidence-relation-v1", itemAttribution: "unknown" },
      }).id;
    })();
  } catch {
    // Missing legacy ledger, concurrent forget or optional projection damage
    // can remove evidence, never interrupt a base-agent dispatch.
    return null;
  }
}

export type ExperienceObservedOutcome = "completed" | "failed" | "cancelled" | "interrupted" | "unknown";

export function getExperienceApplicationOutcome(applicationId: string): {
  applicationId: string;
  snapshot: ExperienceApplicationSnapshot;
  outcome: ExperienceObservedOutcome;
  terminalEventId: string | null;
  itemAttribution: "unknown";
} | null {
  try {
    const db = getDb();
    const row = db.prepare(`SELECT run_id, seq, chat_id, agent_id, payload_json FROM run_events WHERE id = ? AND kind = ?`)
      .get(applicationId, EXPERIENCE_APPLICATION_EVENT_KIND) as
      { run_id: string; seq: number; chat_id: string | null; agent_id: string | null; payload_json: string } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload_json);
    const snapshot = readSnapshot(payload);
    if (!snapshot || snapshot.agentId !== row.agent_id || !safeId(payload.executionAgentId)
      || payload.phase !== "dispatch_with_context" || payload.itemAttribution !== "unknown"
      || payload.rankingPolicy !== "relevance-confidence-relation-v1"
      || typeof payload.runtimeKey !== "string" || !HEX.test(payload.runtimeKey)
      || payload.applicationKey !== digest([snapshot, payload.executionAgentId, payload.runtimeKey])) return null;
    const started = db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND chat_id IS ?
      AND agent_id = ? AND kind = 'invoke_started' AND seq < ? LIMIT 1`)
      .get(row.run_id, row.chat_id, payload.executionAgentId, row.seq);
    if (!started) return null;
    // Main terminal markers only. A runner result, promotion, model citation or
    // old mcp_final marker cannot close the run or provide item-level credit.
    const terminal = db.prepare(`SELECT id, kind,
        CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.hostStopCause') END AS stop_cause
      FROM run_events WHERE run_id = ? AND chat_id IS ? AND (agent_id IS NULL OR agent_id = ?) AND seq > ?
        AND kind IN ('invoke_completed','invoke_failed','invoke_cancelled','invoke_interrupted','invoke_threw')
      ORDER BY seq DESC LIMIT 1`).get(row.run_id, row.chat_id, payload.executionAgentId, row.seq) as
      { id: string; kind: string; stop_cause: unknown } | undefined;
    let outcome: ExperienceObservedOutcome = "unknown";
    if (terminal) {
      outcome = terminal.kind === "invoke_completed" ? "completed"
        : terminal.kind === "invoke_cancelled" ? "cancelled"
        : terminal.kind === "invoke_interrupted" ? "interrupted" : "failed";
      const cause = invocationHostStopCause(terminal.stop_cause);
      if (outcome === "failed" && isOwnerGoalStopCause(cause)) outcome = "cancelled";
      if (outcome === "failed" && (cause === "app_closed" || cause === "update_restart")) outcome = "interrupted";
    }
    return { applicationId, snapshot, outcome, terminalEventId: terminal?.id ?? null, itemAttribution: "unknown" };
  } catch {
    return null;
  }
}

/** One indexed, bounded actor window; source-only historical markers stay uncredited. */
export function summarizeExperienceApplicationOutcomes(agentId: string): NonNullable<ExperienceOntologySummary["applicationOutcomes"]> {
  const summary = { sampledApplications: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, unknown: 0, attributedItems: 0 as const };
  try {
    const rows = getDb().prepare(`SELECT id FROM run_events WHERE agent_id = ? AND kind = ? ORDER BY ts DESC, rowid DESC LIMIT 100`)
      .all(agentId, EXPERIENCE_APPLICATION_EVENT_KIND) as Array<{ id: string }>;
    for (const row of rows) {
      const application = getExperienceApplicationOutcome(row.id);
      if (!application) continue;
      summary.sampledApplications += 1;
      summary[application.outcome] += 1;
    }
  } catch { /* Legacy/optional stores retain their normal diagnostics. */ }
  return summary;
}
