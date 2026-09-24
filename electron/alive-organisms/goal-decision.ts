/**
 * The One/Work Alive controller's final answer: the same agentlas.alive-decision.v2 envelope Science uses
 * (electron/alive-decision-schema.ts), with the action vocabulary of the goal playgrounds instead of
 * science.continue_research. Kept in a separate module so the Science schema and parser stay byte-identical.
 */
import type { AliveDecision } from "../alive-core/contracts";

export const GOAL_CONTINUE_ACTION = "goal.continue" as const;
export const GOAL_CONTINUABLE_STATUSES = ["paused", "blocked"] as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

export const ALIVE_GOAL_DECISION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema: { type: "string", enum: ["agentlas.alive-decision.v2"] },
    kind: { type: "string", enum: ["wait", "review", "act"] },
    reason: { type: "string" },
    nextWakeAtMs: { type: ["integer", "null"] },
    action: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: [GOAL_CONTINUE_ACTION] },
        attachmentId: { type: "string" },
        expected: {
          type: "object",
          additionalProperties: false,
          properties: {
            goalId: { type: "string" },
            runId: { type: "string" },
            runVersion: { type: "integer" },
            status: { type: "string", enum: [...GOAL_CONTINUABLE_STATUSES] },
          },
          required: ["goalId", "runId", "runVersion", "status"],
        },
      },
      required: ["kind", "attachmentId", "expected"],
    },
  },
  required: ["schema", "kind", "reason", "nextWakeAtMs", "action"],
};

/** Exact fence validation shared by the registry and the parser. */
export function validGoalContinueExpected(expected: Record<string, unknown>): boolean {
  return typeof expected.goalId === "string" && ID.test(expected.goalId)
    && typeof expected.runId === "string" && ID.test(expected.runId)
    && Number.isSafeInteger(expected.runVersion) && Number(expected.runVersion) >= 0
    && (GOAL_CONTINUABLE_STATUSES as readonly unknown[]).includes(expected.status);
}

/** A controller decision is an exact JSON object, never an inference from answer prose. */
export function parseAliveGoalDecision(text: string): AliveDecision | undefined {
  if (!text || Buffer.byteLength(text, "utf8") > 4_096) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.schema !== "agentlas.alive-decision.v2"
    || Object.keys(row).sort().join("|") !== "action|kind|nextWakeAtMs|reason|schema"
    || typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 500
    || (row.nextWakeAtMs !== null && (!Number.isSafeInteger(row.nextWakeAtMs) || Number(row.nextWakeAtMs) < 0))) return undefined;
  const reason = row.reason.trim();
  const nextWakeAtMs = row.nextWakeAtMs as number | null;
  if ((row.kind === "wait" || row.kind === "review") && row.action === null) return { kind: row.kind, reason, nextWakeAtMs };
  if (row.kind !== "act") return undefined;
  const action = row.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
  const a = action as Record<string, unknown>;
  if (Object.keys(a).sort().join("|") !== "attachmentId|expected|kind" || a.kind !== GOAL_CONTINUE_ACTION
    || typeof a.attachmentId !== "string" || !UUID.test(a.attachmentId)
    || !a.expected || typeof a.expected !== "object" || Array.isArray(a.expected)) return undefined;
  const e = a.expected as Record<string, unknown>;
  if (Object.keys(e).sort().join("|") !== "goalId|runId|runVersion|status" || !validGoalContinueExpected(e)) return undefined;
  return { kind: "act", reason, nextWakeAtMs, action: { kind: GOAL_CONTINUE_ACTION, attachmentId: a.attachmentId,
    expected: { goalId: e.goalId, runId: e.runId, runVersion: Number(e.runVersion), status: e.status } } };
}
