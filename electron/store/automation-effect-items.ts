import { createHash } from "node:crypto";
import { getDb } from "./db";
import { getRunEventBySource, recordRunEvent } from "./run-events";

/*
 * Per-item outside-effect record: item key -> published id, per automation (owner decision 2026-10-16, YouTube daily
 * upload). A re-run of the same occurrence, a resume after the host died, or a team packet that is planned again
 * checks this record before it uploads, so "already published" is a host fact instead of a prompt instruction.
 *
 * Stored as immutable run events on one ledger run per automation: the first record of an item wins and a repeat
 * returns it (recordRunEvent source identity). The kind is not in any run-detail retention list and the ledger run
 * has no terminal marker, so storage-budget pruning never removes it.
 */
export const AUTOMATION_EFFECT_ITEM_SCHEMA = "agentlas.automation-effect-item.v1";
export const AUTOMATION_EFFECT_ITEM_KIND = "automation_effect_item";
export const AUTOMATION_EFFECT_KINDS = ["publish", "upload", "post", "send"] as const;
export type AutomationEffectKind = (typeof AUTOMATION_EFFECT_KINDS)[number];

export interface AutomationEffectItem {
  schemaVersion: typeof AUTOMATION_EFFECT_ITEM_SCHEMA;
  automationId: string;
  effectKind: AutomationEffectKind;
  /** Caller-stable identity of the item (e.g. the video's slug for that day), never a title the model may reword. */
  itemKey: string;
  /** The id the outside service returned (e.g. a YouTube video id). */
  externalId: string;
  occurrenceId: string | null;
  runId: string | null;
  nodeId: string | null;
  recordedAt: string;
}

const MAX_FIELD = 512;
/** The ledger run that holds every per-item fact of one automation (records here, host-seen publish attempts in one/graph-effect-items). */
export const automationEffectLedgerRunId = (automationId: string): string => `automation-effect-items:${automationId}`;
const ledgerRunId = automationEffectLedgerRunId;
const itemSourceId = (effectKind: AutomationEffectKind, itemKey: string): string =>
  `${effectKind}:${createHash("sha256").update(itemKey, "utf8").digest("hex")}`;

function field(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_FIELD || value.includes("\0")) {
    throw new Error(`automation_effect_item_${name}_invalid`);
  }
  return value;
}

function optionalField(value: unknown, name: string): string | null {
  return value == null ? null : field(value, name);
}

function effectKind(value: unknown): AutomationEffectKind {
  if (!AUTOMATION_EFFECT_KINDS.includes(value as AutomationEffectKind)) throw new Error("automation_effect_item_kind_invalid");
  return value as AutomationEffectKind;
}

function parseItem(payload: unknown): AutomationEffectItem | null {
  const row = payload as Partial<AutomationEffectItem> | null;
  return row?.schemaVersion === AUTOMATION_EFFECT_ITEM_SCHEMA && typeof row.itemKey === "string" && typeof row.externalId === "string"
    ? row as AutomationEffectItem : null;
}

/** The recorded outside effect for this item, or null when none was recorded. */
export function findAutomationEffectItem(automationId: string, kind: AutomationEffectKind, itemKey: string): AutomationEffectItem | null {
  const event = getRunEventBySource(ledgerRunId(field(automationId, "automation")), itemSourceId(effectKind(kind), field(itemKey, "item_key")));
  return event ? parseItem(event.payload) : null;
}

/**
 * Record that this item's outside effect happened. The first record wins: a second record of the same item returns
 * the original (recorded false), and `conflict` says the caller reported a different external id for it.
 */
export function recordAutomationEffectItem(input: {
  automationId: string; effectKind: AutomationEffectKind; itemKey: string; externalId: string;
  occurrenceId?: string | null; runId?: string | null; nodeId?: string | null; now?: Date;
}): { recorded: boolean; conflict: boolean; item: AutomationEffectItem } {
  const automationId = field(input.automationId, "automation");
  const kind = effectKind(input.effectKind);
  const itemKey = field(input.itemKey, "item_key");
  const externalId = field(input.externalId, "external_id");
  const existing = findAutomationEffectItem(automationId, kind, itemKey);
  if (existing) return { recorded: false, conflict: existing.externalId !== externalId, item: existing };
  const item: AutomationEffectItem = {
    schemaVersion: AUTOMATION_EFFECT_ITEM_SCHEMA, automationId, effectKind: kind, itemKey, externalId,
    occurrenceId: optionalField(input.occurrenceId, "occurrence"), runId: optionalField(input.runId, "run"),
    nodeId: optionalField(input.nodeId, "node"), recordedAt: (input.now ?? new Date()).toISOString(),
  };
  const event = recordRunEvent({ runId: ledgerRunId(automationId), automationId, kind: AUTOMATION_EFFECT_ITEM_KIND,
    sourceEventId: itemSourceId(kind, itemKey), evidencePhase: "observed", payload: item as unknown as Record<string, unknown> });
  const stored = parseItem(event.payload) ?? item;
  return { recorded: stored.externalId === externalId && stored.recordedAt === item.recordedAt, conflict: stored.externalId !== externalId, item: stored };
}

/** Every recorded item of this automation (optionally one occurrence), oldest first. */
export function listAutomationEffectItems(automationId: string, opts: { occurrenceId?: string } = {}): AutomationEffectItem[] {
  const rows = getDb().prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND kind = ? ORDER BY seq ASC LIMIT 5000`)
    .all(ledgerRunId(field(automationId, "automation")), AUTOMATION_EFFECT_ITEM_KIND) as Array<{ payload_json: string | null }>;
  const items: AutomationEffectItem[] = [];
  for (const row of rows) {
    let payload: unknown = null;
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch { payload = null; }
    const item = parseItem(payload);
    if (item && (!opts.occurrenceId || item.occurrenceId === opts.occurrenceId)) items.push(item);
  }
  return items;
}
