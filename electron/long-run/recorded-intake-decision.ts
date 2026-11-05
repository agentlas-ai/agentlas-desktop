/**
 * One Goal-intake classification per owner message.
 *
 * The background service classifies a daemon-run owner message (prepareInvocationAutomaticGoal, classifyOnly) and hands it to
 * Main, which classified it again (invocation/goal-intake-forward.ts performIntake): 6 of 16 recorded intake judgments on
 * /05 were byte-identical prompts 2-14 s apart. The in-process verdict cache cannot join two processes, and the
 * durable verdict is keyed by the runtime the call ran under, which differs between the service turn and Main.
 *
 * The first classification already leaves a run event (`automatic_goal_intake`, classified:true) with the typed decision.
 * The second caller reads that decision instead of asking the model again. Only a CLASSIFIED decision is reused: an
 * unavailable classifier is never recorded as a decision, so a retry after the runtime comes back still asks the model.
 * No import of electron: the daemon loads this file (test-daemon-loads-without-electron).
 */
import { createHash } from "node:crypto";
import type { GoalIntakeDecision } from "../../shared/auto-goal";
import { getDb } from "../store/db";

export const AUTOMATIC_GOAL_INTAKE_EVENT = "automatic_goal_intake";

/** Identity of the exact words classified. A different text for the same message id is a different question. */
export function intakeSourceDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export type RecordedIntakeDecision = GoalIntakeDecision & { series?: true; cadenceReason?: string };

/**
 * The classified decision a previous call of this run recorded for this exact message text, or null.
 * `needCadence`: the caller reads a bounded series' interval and count. A series recorded without them (the classification-only
 * pass never reads them) is not enough for that caller, so it asks again rather than invent numbers.
 */
export function recordedIntakeDecision(input: { runId: string; messageId: string; text: string; needCadence: boolean }): RecordedIntakeDecision | null {
  let rows: Array<{ payload_json: string }>;
  try {
    rows = getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ? AND json_extract(payload_json, '$.sourceMessageId') = ?
      AND json_extract(payload_json, '$.classified') IN (1, 'true') ORDER BY rowid DESC LIMIT 5`)
      .all(input.runId, AUTOMATIC_GOAL_INTAKE_EVENT, input.messageId) as Array<{ payload_json: string }>;
  } catch { return null; }
  const digest = intakeSourceDigest(input.text);
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { continue; }
    if (payload.sourceDigest !== digest) continue; // an event written before the digest existed is never trusted
    const intent = payload.intent, commitment = payload.commitment;
    if (!["execute", "question", "explore", "conditional", "unknown"].includes(String(intent))
      || !["now", "later", "uncertain"].includes(String(commitment))) continue;
    const everySeconds = Number(payload.cadenceEverySeconds), maxRuns = Number(payload.cadenceMaxRuns);
    const cadence = Number.isFinite(everySeconds) && Number.isFinite(maxRuns) && everySeconds > 0 && maxRuns > 0 ? { everySeconds, maxRuns } : undefined;
    const series = payload.series === true || payload.series === 1 || payload.series === "true";
    if (series && input.needCadence && !cadence) return null;
    const decision: RecordedIntakeDecision = {
      messageId: input.messageId, intent: intent as GoalIntakeDecision["intent"], commitment: commitment as GoalIntakeDecision["commitment"],
      ...(payload.lifecycle === "finite" || payload.lifecycle === "ongoing" ? { lifecycle: payload.lifecycle } : {}),
      ...(payload.turnScope === "single" || payload.turnScope === "multi" ? { turnScope: payload.turnScope } : {}),
      ...(cadence ? { cadence } : {}),
      ...(series ? { series: true as const } : {}),
      ...(typeof payload.cadenceReason === "string" ? { cadenceReason: payload.cadenceReason } : {}),
    };
    return decision;
  }
  return null;
}
