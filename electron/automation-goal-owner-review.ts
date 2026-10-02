import { createHash, randomUUID } from "node:crypto";
import type { Automation, GoalAutomationExecutionReview } from "../shared/types";
import { AUTO_GOAL_SCHEMA } from "../shared/auto-goal";
import { getDb } from "./store/db";
import { getAutomation } from "./store/automations";
import { getLongRunGoalRevisionBinding } from "./store/long-runs";
import { getAutomationDefinitionDigest } from "./long-run/automation-provenance";
import { recordRunEvent } from "./store/run-events";

const EVENT = "automation_goal_execution_owner_reviewed";
const REQUIRED_EVENT = "automation_goal_execution_review_required";
const SCHEMA = "agentlas.automation-goal-execution-owner-review.v1";
type ReviewErrorCode = "automation_goal_execution_review_required"
  | "automation_goal_execution_review_changed" | "automation_goal_execution_review_unavailable";
export class AutomationGoalExecutionReviewError extends Error {
  constructor(readonly code: ReviewErrorCode) { super(code); this.name = "AutomationGoalExecutionReviewError"; }
}
function fail(code: ReviewErrorCode): never { throw new AutomationGoalExecutionReviewError(code); }
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value;
}
function hash(value: unknown): string {
  // Canonical object ordering makes serialization changes irrelevant; array order
  // and every revision/contract field remain part of the reviewed authority.
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, canonical(val)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function reviewedDefinitionDigest(a: Automation): string | null {
  const base = getAutomationDefinitionDigest(a.id);
  return base ? hash({ base, executionPermission: a.executionPermission, toolMode: a.toolMode ?? null,
    hubMode: a.hubMode ?? null, targetVersion: a.targetVersion ?? null, goal: a.goal ?? null, monitor: a.monitor ?? null }) : null;
}
interface CanonicalRow {
  root_chat_id: string; origin_surface: string; archived_at: string | null;
  goal_id: string; objective: string; acceptance_criteria_json: string; contract_status: string;
  long_run_id: string; surface: string; run_status: string; version: number;
  run_objective: string; run_criteria: string; run_created_at: string;
}
interface Candidate {
  review: Omit<GoalAutomationExecutionReview, "snapshotDigest">;
  contractStatus: string; runStatus: string;
}
/** Mutable goal_id is only a proposed linkage. This read neither adopts it nor
 * repairs chats, arms execution, enables an automation, or grants a workspace. */
function candidate(input: { automationId: string; goalId: string; rootChatId: string }): Candidate {
  if (!identity(input.automationId) || !identity(input.goalId) || !identity(input.rootChatId)) fail("automation_goal_execution_review_unavailable");
  const a = getAutomation(input.automationId);
  const definitionDigest = a && reviewedDefinitionDigest(a);
  if (!a || a.createdBy !== "agent" || a.goalId !== input.goalId || !identity(a.createdAt)
    || !Number.isFinite(Date.parse(a.createdAt)) || typeof a.name !== "string" || !definitionDigest) fail("automation_goal_execution_review_unavailable");
  const row = getDb().prepare(`SELECT ch.id AS root_chat_id, ch.origin_surface, ch.archived_at,
      c.goal_id, c.objective, c.acceptance_criteria_json, c.status AS contract_status,
      r.id AS long_run_id, r.surface, r.status AS run_status, r.version,
      r.objective AS run_objective, r.acceptance_criteria_json AS run_criteria, r.created_at AS run_created_at
    FROM chats ch JOIN chat_goal_contracts c ON c.chat_id = ch.id AND c.goal_id = ch.goal_id
    JOIN long_runs r ON r.goal_id = c.goal_id AND r.root_chat_id = ch.id
    WHERE ch.id = ? AND c.goal_id = ? LIMIT 1`).get(input.rootChatId, input.goalId) as CanonicalRow | undefined;
  const revisionRow = getDb().prepare(`SELECT revision, payload_json FROM chat_goal_revisions
    WHERE goal_id = ? ORDER BY revision DESC LIMIT 1`).get(input.goalId) as { revision: number; payload_json: string } | undefined;
  if (!row || !identity(row.long_run_id) || row.archived_at != null
    || !["one", "work"].includes(row.surface) || row.origin_surface !== row.surface
    || !["active", "blocked"].includes(row.contract_status) || !row.objective?.trim()
    || !["draft", "queued", "running", "waiting_worker", "waiting_tool", "waiting_user", "verifying", "pausing", "paused", "blocked"].includes(row.run_status)
    || !Number.isSafeInteger(row.version) || row.version < 0 || !revisionRow) fail("automation_goal_execution_review_unavailable");
  let revision: Record<string, unknown>, contractCriteria: unknown, runCriteria: unknown;
  try {
    revision = JSON.parse(revisionRow.payload_json);
    contractCriteria = JSON.parse(row.acceptance_criteria_json);
    runCriteria = JSON.parse(row.run_criteria);
  } catch { fail("automation_goal_execution_review_unavailable"); }
  if (!revision || typeof revision !== "object" || Array.isArray(revision)
    || revision.schemaVersion !== AUTO_GOAL_SCHEMA || revision.goalId !== input.goalId || revision.chatId !== input.rootChatId
    || !Number.isSafeInteger(revision.revision) || Number(revision.revision) < 1 || revision.revision !== revisionRow.revision
    || !(revision.lifecycle === undefined || revision.lifecycle === "finite" || revision.lifecycle === "ongoing")
    || typeof revision.objective !== "string" || !revision.objective.trim()
    || !Array.isArray(revision.acceptanceCriteria) || !Array.isArray(contractCriteria) || !Array.isArray(runCriteria)) fail("automation_goal_execution_review_unavailable");
  let binding;
  try { binding = getLongRunGoalRevisionBinding(row.long_run_id); }
  catch { fail("automation_goal_execution_review_unavailable"); }
  if (binding?.revision !== revision.revision) fail("automation_goal_execution_review_unavailable");
  const canonicalGoalDigest = hash({ revision, contract: { goalId: row.goal_id, rootChatId: row.root_chat_id,
    objective: row.objective, acceptanceCriteria: contractCriteria }, run: { id: row.long_run_id,
    goalId: row.goal_id, rootChatId: row.root_chat_id, surface: row.surface, objective: row.run_objective,
    acceptanceCriteria: runCriteria, createdAt: row.run_created_at }, originSurface: row.origin_surface });
  return { review: { automationId: a.id, title: a.name, automationCreatedAt: a.createdAt, definitionDigest,
    goalId: input.goalId, rootChatId: input.rootChatId, longRunId: row.long_run_id,
    revision: Number(revision.revision), version: row.version, canonicalGoalDigest },
    contractStatus: row.contract_status, runStatus: row.run_status };
}
function snapshot(value: Candidate): GoalAutomationExecutionReview {
  return { ...value.review, snapshotDigest: hash(value) };
}
export function getAutomationGoalExecutionReview(input: {
  automationId: string; goalId: string; rootChatId: string; expectedVersion: number;
}): GoalAutomationExecutionReview {
  const value = candidate(input);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== value.review.version) fail("automation_goal_execution_review_changed");
  return snapshot(value);
}

interface DurableOwner {
  schemaVersion: typeof SCHEMA;
  automationId: string; automationCreatedAt: string; definitionDigest: string; titleDigest: string;
  goalId: string; rootChatId: string; longRunId: string; revision: number; canonicalGoalDigest: string;
}
interface Receipt { id: string; runId: string; cursor: number; owner: DurableOwner }
function owner(review: GoalAutomationExecutionReview): DurableOwner {
  return { schemaVersion: SCHEMA, automationId: review.automationId, automationCreatedAt: review.automationCreatedAt,
    definitionDigest: review.definitionDigest, titleDigest: hash(review.title), goalId: review.goalId,
    rootChatId: review.rootChatId, longRunId: review.longRunId, revision: review.revision, canonicalGoalDigest: review.canonicalGoalDigest };
}
function receipt(automationId: string): Receipt | undefined {
  const row = getDb().prepare(`SELECT id, run_id, rowid AS receipt_cursor, payload_json FROM run_events
    WHERE automation_id = ? AND kind = ? ORDER BY rowid DESC LIMIT 1`).get(automationId, EVENT) as
    { id: string; run_id: string; receipt_cursor: number; payload_json: string } | undefined;
  if (!row) return undefined;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(row.payload_json); } catch { fail("automation_goal_execution_review_changed"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== SCHEMA
    || !Number.isSafeInteger(row.receipt_cursor) || row.receipt_cursor < 1
    || raw.automationId !== automationId || !row.run_id.startsWith("automation-goal-owner-review:")
    || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
    || ![raw.automationId, raw.automationCreatedAt, raw.goalId, raw.rootChatId, raw.longRunId].every(identity)
    || ![raw.definitionDigest, raw.titleDigest, raw.canonicalGoalDigest, raw.ownerDigest].every((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) fail("automation_goal_execution_review_changed");
  // Project only our closed scalar schema. safePayload adds runtimeEvidence and
  // omits null fields; neither can change semantic equality or idempotence.
  const value: DurableOwner = { schemaVersion: SCHEMA, automationId: raw.automationId as string,
    automationCreatedAt: raw.automationCreatedAt as string, definitionDigest: raw.definitionDigest as string,
    titleDigest: raw.titleDigest as string, goalId: raw.goalId as string, rootChatId: raw.rootChatId as string,
    longRunId: raw.longRunId as string, revision: Number(raw.revision), canonicalGoalDigest: raw.canonicalGoalDigest as string };
  if (raw.ownerDigest !== hash(value)) fail("automation_goal_execution_review_changed");
  return { id: row.id, runId: row.run_id, cursor: row.receipt_cursor, owner: value };
}
/** An unchanged identity still needs a new explicit receipt after Main parks
 * this creation. Inspect only newer markers for this automation, newest first;
 * a marker for a different creation must not obscure this creation's marker. */
function hasPendingReviewMarker(value: DurableOwner, afterCursor: number): boolean {
  const rows = getDb().prepare(`SELECT payload_json FROM run_events
    WHERE automation_id = ? AND kind = ? AND rowid > ? ORDER BY rowid DESC`)
    .iterate(value.automationId, REQUIRED_EVENT, afterCursor) as Iterable<{ payload_json: string }>;
  for (const row of rows) {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(row.payload_json); } catch { return true; }
    // An invalid marker cannot grant or silently clear authority. A new exact
    // explicit review can supersede it while retaining the original audit row.
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.automationId !== value.automationId
      || !identity(raw.automationCreatedAt) || !Number.isFinite(Date.parse(raw.automationCreatedAt))) return true;
    if (raw.automationCreatedAt === value.automationCreatedAt) return true;
    // Valid markers belonging to another creation are outside this owner scope.
  }
  return false;
}
/** Only the explicit owner-confirmation Main ingress writes this receipt. It is
 * an execution relationship, never native invocation or filesystem authority. */
export function acknowledgeAutomationGoalExecutionReview(review: GoalAutomationExecutionReview & { acknowledged: true }): void {
  if (!review || review.acknowledged !== true) fail("automation_goal_execution_review_required");
  getDb().transaction(() => {
    let current: GoalAutomationExecutionReview;
    try { current = getAutomationGoalExecutionReview({ automationId: review.automationId, goalId: review.goalId,
      rootChatId: review.rootChatId, expectedVersion: review.version }); }
    catch (error) {
      if (error instanceof AutomationGoalExecutionReviewError) fail("automation_goal_execution_review_changed");
      throw error;
    }
    if (Object.entries(current).some(([key, value]) => review[key as keyof GoalAutomationExecutionReview] !== value)) fail("automation_goal_execution_review_changed");
    const value = owner(current);
    let prior: Receipt | undefined;
    try { prior = receipt(current.automationId); }
    catch (error) {
      // A corrupt historical row never grants authority, but must not trap an
      // owner who explicitly reviewed this exact live canonical relationship.
      // Preserve that row for audit and append a new independently valid receipt.
      if (!(error instanceof AutomationGoalExecutionReviewError) || error.code !== "automation_goal_execution_review_changed") throw error;
    }
    if (prior && hash(prior.owner) === hash(value) && !hasPendingReviewMarker(value, prior.cursor)) return;
    recordRunEvent({ runId: `automation-goal-owner-review:${randomUUID()}`, chatId: current.rootChatId,
      automationId: current.automationId, kind: EVENT, payload: { ...value, ownerDigest: hash(value) } });
    // Refuse and roll back if durable safety serialization cannot preserve the
    // exact authority fields; no caller may rely on a merely attempted append.
    const stored = receipt(current.automationId);
    if (!stored || hash(stored.owner) !== hash(value)) fail("automation_goal_execution_review_changed");
  })();
}
export function readReviewedAutomationGoalExecutionOwner(automationId: string): {
  automationId: string; automationCreatedAt: string; definitionDigest: string;
  goalId: string; rootChatId: string; longRunId: string; revision: number;
  sourceInvocationId: null; receiptId: string;
} | undefined {
  const stored = receipt(automationId);
  if (!stored) return undefined;
  let current: Candidate;
  try { current = candidate(stored.owner); }
  catch (error) {
    if (error instanceof AutomationGoalExecutionReviewError) fail("automation_goal_execution_review_changed");
    throw error;
  }
  // Pauses/resumes change run version/status and enabled, but not this reviewed
  // identity. This remains readable for stopping a paused/blocked controller.
  if (hash(stored.owner) !== hash(owner(snapshot(current)))) fail("automation_goal_execution_review_changed");
  const { automationId: id, automationCreatedAt, definitionDigest, goalId, rootChatId, longRunId, revision } = stored.owner;
  return { automationId: id, automationCreatedAt, definitionDigest, goalId, rootChatId, longRunId, revision,
    sourceInvocationId: null, receiptId: stored.id };
}
