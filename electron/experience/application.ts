import { createHash } from "node:crypto";
import type { ExperienceApplicationSnapshot, ExperienceOntologySummary } from "../../shared/experience";
import { invocationHostStopCause, isOwnerGoalStopCause } from "../../shared/invocation-host-stop";
import { getDb } from "../store/db";

const SCHEMA = "agentlas.experience-application.v1" as const;
export const EXPERIENCE_APPLICATION_EVENT_KIND = "experience_application";
const MAX_ITEMS = 8;
const HEX = /^[a-f0-9]{64}$/;
const safeId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

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

/** Write paths (dispatch snapshots, application records) were retired with the experience chips; history stays readable. */
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
