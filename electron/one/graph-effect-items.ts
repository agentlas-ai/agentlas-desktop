import { createHash } from "node:crypto";
import { getDb } from "../store/db";
import { getRunEventBySource, recordRunEvent } from "../store/run-events";
import {
  AUTOMATION_EFFECT_KINDS, automationEffectLedgerRunId, findAutomationEffectItem, listAutomationEffectItems,
  recordAutomationEffectItem, type AutomationEffectItem, type AutomationEffectKind,
} from "../store/automation-effect-items";
import { composeDeclaredPrompt } from "../runtime/prompt-order";
import { liveGraphTeamGrantForChat, liveGraphTeamGrantForOwner, type GraphTeamGrant } from "./graph-team-grant";

/*
 * "Already published" is a host fact of the automation occurrence, not something the model rediscovers.
 *
 * Before this, the daily TCIagent graph (cdf732ca) had no host record of what it had published: step1's own text asked
 * the model to "compare existing runs and outputs first to avoid duplicate work", a resume added the prompt note
 * "unknown outside effect: check current state first" (run-graph UNCERTAIN_EFFECT_NOTE_CODES), the per-item record of
 * store/automation-effect-items.ts had no reader and no writer, and a teammate's YouTube publish click under the step's
 * full access was approved without any item identity (browser/connect.ts permission "full"). So a re-run of the same
 * occurrence planned every video again and nothing on the publish path could tell a second upload of the same video.
 *
 * Now, for every session that acts for a room-saved graph step (the step's own chat with its team grant, and each
 * teammate session that step dispatched: one_team_dispatches.graph_owner), all scoped by the host:
 *   - effect_item_check(item_key) answers published / publish_unconfirmed / not_published from the record, and binds the
 *     session's next publish to that item;
 *   - effect_item_record(item_key, external_id) writes the record (first write wins; a different id is refused,
 *     effect_item_already_recorded);
 *   - a browser publish click (approval class "publish", the model-declared post/publish effect) in such a session is
 *     refused unless it publishes a checked, unpublished item (effect_item_required / effect_item_already_recorded); an
 *     admitted click is recorded as a host-seen attempt, so a run that dies before effect_item_record still never
 *     publishes that item again;
 *   - a re-run of the occurrence starts its team step with the items already published, as typed facts.
 * The record is durable (run events on one ledger run per automation, never pruned); claims are per process and end
 * with the session's tool capability.
 */

export const GRAPH_EFFECT_ITEM_ATTEMPT_KIND = "automation_effect_item_attempt";
const ATTEMPT_SCHEMA = "agentlas.automation-effect-item-attempt.v1";
export const EFFECT_ITEM_ALREADY_RECORDED = "effect_item_already_recorded";
export const EFFECT_ITEM_REQUIRED = "effect_item_required";

export interface GraphEffectScope {
  automationId: string;
  occurrenceId: string | null;
  runId: string;
  nodeId: string;
  /** The session that acts: the step's own chat or a teammate's chat. Claims and the publish admission key on it. */
  sessionChatId: string;
  permission: "read" | "write";
}

export interface GraphEffectItemAttempt {
  schemaVersion: typeof ATTEMPT_SCHEMA;
  automationId: string;
  itemKey: string;
  effectKind: AutomationEffectKind;
  site: string;
  occurrenceId: string | null;
  runId: string;
  nodeId: string;
  sessionChatId: string;
  attemptedAt: string;
}

type Refusal = { ok: false; code: string; message: string } & Record<string, unknown>;
const refusal = (code: string, message: string, extra: Record<string, unknown> = {}): Refusal => ({ ok: false, code, message, ...extra });

// ── Scope: which automation step a session acts for (host facts only) ─────────────────────────────────

export function graphEffectScopeForGrant(grant: GraphTeamGrant): GraphEffectScope {
  return { automationId: grant.automationId, occurrenceId: grant.occurrenceId ?? runOccurrence(grant.runId),
    runId: grant.runId, nodeId: grant.nodeId, sessionChatId: grant.chatId, permission: grant.permission };
}

function runOccurrence(runId: string): string | null {
  try {
    const row = getDb().prepare("SELECT occurrence_id FROM automation_runs WHERE id = ?").get(runId) as { occurrence_id: string | null } | undefined;
    return row?.occurrence_id ?? null;
  } catch { return null; }
}

/** A teammate session working on a dispatch that a graph step owns (one_team_dispatches.graph_owner, written by the host). */
export function graphEffectScopeForTeammate(chatId: string | null | undefined): GraphEffectScope | null {
  if (!chatId) return null;
  let owner: string | null = null;
  try {
    const row = getDb().prepare(`SELECT graph_owner FROM one_team_dispatches WHERE child_chat_id = ? AND graph_owner IS NOT NULL
      AND status IN ('running','queued') ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(chatId) as { graph_owner: string | null } | undefined;
    owner = row?.graph_owner ?? null;
  } catch { return null; }
  const split = owner ? owner.indexOf("#") : -1;
  if (!owner || split <= 0 || split === owner.length - 1) return null;
  const runId = owner.slice(0, split), nodeId = owner.slice(split + 1);
  const live = liveGraphTeamGrantForOwner(owner);
  if (live) return { ...graphEffectScopeForGrant(live), sessionChatId: chatId, permission: "write" };
  try {
    const run = getDb().prepare("SELECT automation_id, occurrence_id FROM automation_runs WHERE id = ?").get(runId) as
      { automation_id: string | null; occurrence_id: string | null } | undefined;
    if (!run?.automation_id) return null;
    // Teammates a step hands work to run with full delegated access (team-dispatch ONE_DELEGATION_PERMISSION).
    return { automationId: run.automation_id, occurrenceId: run.occurrence_id, runId, nodeId, sessionChatId: chatId, permission: "write" };
  } catch { return null; }
}

/** The step's own chat (live grant) or a teammate session of a graph-owned dispatch. */
export function graphEffectScopeForSession(chatId: string | null | undefined): GraphEffectScope | null {
  const grant = liveGraphTeamGrantForChat(chatId);
  return grant ? graphEffectScopeForGrant(grant) : graphEffectScopeForTeammate(chatId);
}

// ── Record lookups ───────────────────────────────────────────────────────────────────────────────

const MAX_KEY = 200;
const MAX_EXTERNAL_ID = 512;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function itemKeyOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.normalize("NFC").trim();
  return key && key.length <= MAX_KEY && !CONTROL.test(key) ? key : null;
}

function externalIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= MAX_EXTERNAL_ID && !CONTROL.test(id) ? id : null;
}

function kindOf(value: unknown): AutomationEffectKind | null {
  if (value === undefined || value === null || value === "") return "publish";
  return (AUTOMATION_EFFECT_KINDS as readonly unknown[]).includes(value) ? value as AutomationEffectKind : null;
}

/** The item's record under any effect kind: one item is published once, whatever kind the caller named. */
function recordedItem(automationId: string, itemKey: string): AutomationEffectItem | null {
  for (const kind of AUTOMATION_EFFECT_KINDS) {
    const item = findAutomationEffectItem(automationId, kind, itemKey);
    if (item) return item;
  }
  return null;
}

const attemptSource = (itemKey: string): string => `attempt:${createHash("sha256").update(itemKey, "utf8").digest("hex")}`;

function parseAttempt(payload: unknown): GraphEffectItemAttempt | null {
  const row = payload as Partial<GraphEffectItemAttempt> | null;
  return row?.schemaVersion === ATTEMPT_SCHEMA && typeof row.itemKey === "string" ? row as GraphEffectItemAttempt : null;
}

function attemptOf(automationId: string, itemKey: string): GraphEffectItemAttempt | null {
  const event = getRunEventBySource(automationEffectLedgerRunId(automationId), attemptSource(itemKey));
  return event ? parseAttempt(event.payload) : null;
}

export interface GraphEffectItemDone { itemKey: string; externalId: string | null; effectKind: AutomationEffectKind; at: string }

/** Items published in this occurrence: recorded ids, then host-seen publish attempts that have no record yet. */
export function graphEffectItemsDone(automationId: string, occurrenceId: string): GraphEffectItemDone[] {
  const done = new Map<string, GraphEffectItemDone>();
  for (const item of listAutomationEffectItems(automationId, { occurrenceId })) {
    if (!done.has(item.itemKey)) done.set(item.itemKey, { itemKey: item.itemKey, externalId: item.externalId, effectKind: item.effectKind, at: item.recordedAt });
  }
  let rows: Array<{ payload_json: string | null }> = [];
  try {
    rows = getDb().prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq ASC LIMIT 5000")
      .all(automationEffectLedgerRunId(automationId), GRAPH_EFFECT_ITEM_ATTEMPT_KIND) as typeof rows;
  } catch { rows = []; }
  for (const row of rows) {
    let payload: unknown = null;
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch { payload = null; }
    const attempt = parseAttempt(payload);
    if (!attempt || attempt.occurrenceId !== occurrenceId || done.has(attempt.itemKey) || recordedItem(automationId, attempt.itemKey)) continue;
    done.set(attempt.itemKey, { itemKey: attempt.itemKey, externalId: null, effectKind: attempt.effectKind, at: attempt.attemptedAt });
  }
  return [...done.values()];
}

// ── Claims: the item a session's next publish belongs to ───────────────────────────────────────

interface Claim { itemKey: string; effectKind: AutomationEffectKind; scope: GraphEffectScope; done: boolean; attempted: boolean }
const claims = new Map<string, Claim>();
const effectToolSessions = new Map<string, number>();

/** A session's run was given the effect tools (team-control-server capability): its publish clicks need a checked item. */
export function markGraphEffectToolSession(chatId: string): void {
  effectToolSessions.set(chatId, (effectToolSessions.get(chatId) ?? 0) + 1);
}

/** That capability ended: no claim of this session survives it. */
export function unmarkGraphEffectToolSession(chatId: string): void {
  const left = (effectToolSessions.get(chatId) ?? 0) - 1;
  if (left > 0) { effectToolSessions.set(chatId, left); return; }
  effectToolSessions.delete(chatId);
  claims.delete(chatId);
}

// ── Tools (team-control-server operation "effect") ─────────────────────────────────────────────

export function effectItemCheck(scope: GraphEffectScope, input: Record<string, unknown>): Record<string, unknown> {
  const itemKey = itemKeyOf(input.item_key);
  if (!itemKey) return refusal("effect_item_key_invalid", `item_key: one stable key per work item, 1-${MAX_KEY} characters, no line breaks`);
  const effectKind = kindOf(input.effect_kind);
  if (!effectKind) return refusal("effect_item_kind_invalid", `effect_kind: one of ${AUTOMATION_EFFECT_KINDS.join(", ")}`);
  const recorded = recordedItem(scope.automationId, itemKey);
  if (recorded) {
    claims.set(scope.sessionChatId, { itemKey, effectKind, scope, done: true, attempted: false });
    return { ok: true, item_key: itemKey, status: "published", external_id: recorded.externalId, recorded_at: recorded.recordedAt,
      next: "done: never publish this item again" };
  }
  const attempt = attemptOf(scope.automationId, itemKey);
  if (attempt) {
    claims.set(scope.sessionChatId, { itemKey, effectKind, scope, done: true, attempted: false });
    return { ok: true, item_key: itemKey, status: "publish_unconfirmed", attempted_at: attempt.attemptedAt, site: attempt.site,
      next: "the host saw this item's publish action: find it on the site and record its id with effect_item_record; never publish it again" };
  }
  if (scope.permission !== "write") return { ok: true, item_key: itemKey, status: "not_published", next: "read-only step: report it as not published" };
  claims.set(scope.sessionChatId, { itemKey, effectKind, scope, done: false, attempted: false });
  return { ok: true, item_key: itemKey, status: "not_published", next: "publish it now, then call effect_item_record with the id the site shows" };
}

export function effectItemRecord(scope: GraphEffectScope, input: Record<string, unknown>): Record<string, unknown> {
  if (scope.permission !== "write") return refusal("effect_item_write_permission_required", "this step is read-only; it cannot record a publish");
  const itemKey = itemKeyOf(input.item_key);
  if (!itemKey) return refusal("effect_item_key_invalid", `item_key: one stable key per work item, 1-${MAX_KEY} characters, no line breaks`);
  const externalId = externalIdOf(input.external_id);
  if (!externalId) return refusal("effect_item_external_id_invalid", `external_id: the id the site returned, 1-${MAX_EXTERNAL_ID} characters`);
  const effectKind = kindOf(input.effect_kind);
  if (!effectKind) return refusal("effect_item_kind_invalid", `effect_kind: one of ${AUTOMATION_EFFECT_KINDS.join(", ")}`);
  const prior = recordedItem(scope.automationId, itemKey);
  const result = prior ? { recorded: false, conflict: prior.externalId !== externalId, item: prior }
    : recordAutomationEffectItem({ automationId: scope.automationId, effectKind, itemKey, externalId,
      occurrenceId: scope.occurrenceId, runId: scope.runId, nodeId: scope.nodeId });
  if (result.conflict) {
    return refusal(EFFECT_ITEM_ALREADY_RECORDED, `item ${itemKey} is already recorded as published with id ${result.item.externalId}; it was not recorded again`,
      { item_key: itemKey, external_id: result.item.externalId, recorded_at: result.item.recordedAt });
  }
  const claim = claims.get(scope.sessionChatId);
  if (claim?.itemKey === itemKey) claims.delete(scope.sessionChatId);
  return { ok: true, item_key: itemKey, external_id: result.item.externalId, recorded: result.recorded, ...(result.recorded ? {} : { already_recorded: true }) };
}

// ── Browser publish admission (browser/approval-server.ts, before the approval decision) ────────────

export type GraphEffectPublishAdmission = { refused: false } | { refused: true; code: string; message: string };

/**
 * A model-declared publish click (approval class "publish") in a session that holds the effect tools publishes exactly
 * one checked, unpublished item. Anything else is refused before the click runs; an admitted click is a durable attempt.
 */
export function graphEffectPublishAdmission(input: { chatId: string | null | undefined; actionType: string; site: string }): GraphEffectPublishAdmission {
  if (input.actionType !== "publish" || !input.chatId || !effectToolSessions.has(input.chatId)) return { refused: false };
  const claim = claims.get(input.chatId);
  if (!claim) {
    return { refused: true, code: EFFECT_ITEM_REQUIRED, message: "EFFECT_ITEM_REQUIRED: this automation publishes per work item. "
      + "Call effect_item_check with the item's stable item_key first, then repeat this click. The click was not executed." };
  }
  const { scope } = claim;
  const recorded = claim.done ? null : recordedItem(scope.automationId, claim.itemKey);
  const attempt = claim.done || recorded || claim.attempted ? null : attemptOf(scope.automationId, claim.itemKey);
  if (claim.done || recorded || attempt) {
    claim.done = true;
    const id = recorded?.externalId ?? recordedItem(scope.automationId, claim.itemKey)?.externalId ?? null;
    return { refused: true, code: EFFECT_ITEM_ALREADY_RECORDED, message: `EFFECT_ITEM_ALREADY_RECORDED: item ${claim.itemKey} was already published`
      + `${id ? ` (id ${id})` : " (the host saw its publish action)"}. Never publish it again. The click was not executed.` };
  }
  if (!claim.attempted) {
    const payload: GraphEffectItemAttempt = { schemaVersion: ATTEMPT_SCHEMA, automationId: scope.automationId, itemKey: claim.itemKey,
      effectKind: claim.effectKind, site: String(input.site || "").slice(0, 200), occurrenceId: scope.occurrenceId, runId: scope.runId,
      nodeId: scope.nodeId, sessionChatId: input.chatId, attemptedAt: new Date().toISOString() };
    let event: ReturnType<typeof recordRunEvent>;
    try {
      event = recordRunEvent({ runId: automationEffectLedgerRunId(scope.automationId), automationId: scope.automationId,
        kind: GRAPH_EFFECT_ITEM_ATTEMPT_KIND, sourceEventId: attemptSource(claim.itemKey), evidencePhase: "observed",
        payload: payload as unknown as Record<string, unknown> });
    } catch {
      // Unrecorded, the publish could repeat after a crash: it does not run.
      return { refused: true, code: "effect_item_record_unavailable", message: "EFFECT_ITEM_RECORD_UNAVAILABLE: the host could not record this publish, so the click was not executed. Try the click again." };
    }
    const stored = parseAttempt(event.payload);
    // Another session's attempt won the source identity first: this click would publish the item a second time.
    if (stored && (stored.sessionChatId !== input.chatId || stored.runId !== scope.runId)) {
      claim.done = true;
      return { refused: true, code: EFFECT_ITEM_ALREADY_RECORDED, message: `EFFECT_ITEM_ALREADY_RECORDED: item ${claim.itemKey} is being published by another session. Never publish it again. The click was not executed.` };
    }
    claim.attempted = true;
  }
  return { refused: false };
}

// ── Re-run facts (run-graph: appended to a team step's first turn, outside the node input digest) ───────

const MAX_DONE_LINES = 60;

/** The items this occurrence already published, as host facts for a write team step; empty when there are none. */
export function graphEffectItemsPromptBlock(grant: GraphTeamGrant | null | undefined): string {
  if (!grant || grant.permission !== "write") return "";
  const occurrenceId = grant.occurrenceId ?? runOccurrence(grant.runId);
  if (!occurrenceId) return "";
  let done: GraphEffectItemDone[] = [];
  try { done = graphEffectItemsDone(grant.automationId, occurrenceId); } catch { done = []; }
  if (done.length === 0) return "";
  const lines = done.slice(0, MAX_DONE_LINES).map((item) => `- ${item.itemKey}: ${item.externalId ?? "publish seen, id not recorded"}`);
  if (done.length > MAX_DONE_LINES) lines.push(`- and ${done.length - MAX_DONE_LINES} more (effect_item_check answers each)`);
  return `\n\n${composeDeclaredPrompt([
    { id: "graph-node.effect-items.rule", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 0,
      text: "already published in this occurrence (host record): never produce or publish these items again; plan only the rest" },
    { id: "graph-node.effect-items.done", revision: 1, stability: "turn-context", changeTriggers: ["checkpoint"], order: 0, text: lines.join("\n") },
  ], "\n")}`;
}

/** Owner-visible summary for a held step (run-graph interrupted hold): how many items this occurrence already published. */
export function graphEffectItemsHeldSummary(automationId: string, occurrenceId: string | null): { count: number; keys: string[] } {
  if (!occurrenceId) return { count: 0, keys: [] };
  try {
    const done = graphEffectItemsDone(automationId, occurrenceId);
    return { count: done.length, keys: done.slice(0, 5).map((item) => item.itemKey) };
  } catch { return { count: 0, keys: [] }; }
}

/** Test seam (contract gates only): the in-process claim of a session. */
export function graphEffectClaimForTest(chatId: string): { itemKey: string; done: boolean; attempted: boolean } | null {
  const claim = claims.get(chatId);
  return claim ? { itemKey: claim.itemKey, done: claim.done, attempted: claim.attempted } : null;
}
