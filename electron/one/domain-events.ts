import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { ONE_DOMAIN_EVENT_KIND, recordRunEvent } from "../store/run-events";
import {
  ONE_DOMAIN_EVENT_CONTRACT_VERSION,
  ONE_DOMAIN_EVENT_RULES,
  isOneDomainEventV1,
  parseOneDomainEventJson,
  type OneDomainEventActor,
  type OneDomainEventPayloadEntry,
  type OneDomainEventType,
  type OneDomainEventV1,
  type OneDomainEventVisibility,
} from "../../shared/one-domain-events";

interface DomainEventRow {
  payload_json: string;
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value);
}

function ledgerRunId(entityId: string): string {
  return `one-domain:${entityId}`;
}

function eventFromRow(row: DomainEventRow): OneDomainEventV1 | null {
  try {
    const wrapper = JSON.parse(row.payload_json) as { oneDomainEventJson?: unknown };
    return typeof wrapper.oneDomainEventJson === "string"
      ? parseOneDomainEventJson(wrapper.oneDomainEventJson)
      : null;
  } catch {
    return null;
  }
}

function findOneDomainEventById(eventId: string): OneDomainEventV1 | null {
  if (!safeId(eventId)) return null;
  const row = getDb().prepare(
    `SELECT payload_json FROM run_events
     WHERE kind = ?
       AND json_extract(json_extract(payload_json, '$.oneDomainEventJson'), '$.eventId') = ?
     ORDER BY rowid DESC LIMIT 1`,
  ).get(ONE_DOMAIN_EVENT_KIND, eventId) as DomainEventRow | undefined;
  return row ? eventFromRow(row) : null;
}

function latestEntityVersion(entityId: string): number {
  const row = getDb().prepare(
    `SELECT MAX(CAST(json_extract(json_extract(payload_json, '$.oneDomainEventJson'), '$.version') AS INTEGER)) AS version
     FROM run_events WHERE run_id = ? AND kind = ?`,
  ).get(ledgerRunId(entityId), ONE_DOMAIN_EVENT_KIND) as { version?: number | null } | undefined;
  return Number.isSafeInteger(row?.version) ? Number(row?.version) : 0;
}

export interface RecordOneDomainEventInput {
  eventId?: string;
  eventType: OneDomainEventType;
  occurredAt?: string;
  actor: OneDomainEventActor;
  entityId: string;
  projectId?: string;
  taskId?: string;
  version: number;
  visibility: OneDomainEventVisibility;
  entries: OneDomainEventPayloadEntry[];
}

export function recordOneDomainEvent(input: RecordOneDomainEventInput): OneDomainEventV1 {
  const event: OneDomainEventV1 = {
    contractVersion: ONE_DOMAIN_EVENT_CONTRACT_VERSION,
    eventId: input.eventId ?? `event:${randomUUID()}`,
    eventType: input.eventType,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    actor: input.actor,
    entityId: input.entityId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    version: input.version,
    visibility: input.visibility,
    payload: { entries: input.entries },
  };
  if (!isOneDomainEventV1(event)) throw new TypeError(`Invalid Agentlas One domain event: ${input.eventType}`);
  const serialized = JSON.stringify(event);
  const persist = getDb().transaction(() => {
    const existing = findOneDomainEventById(event.eventId);
    if (existing) {
      if (JSON.stringify(existing) !== serialized) throw new Error("Agentlas One domain event id collision");
      return existing;
    }
    if (event.version < latestEntityVersion(event.entityId)) {
      throw new Error("Agentlas One domain event version moved backwards");
    }
    recordRunEvent({
      runId: ledgerRunId(event.entityId),
      kind: ONE_DOMAIN_EVENT_KIND,
      payload: { oneDomainEventJson: serialized },
    });
    return event;
  });
  // Serialize the lookup/version/write boundary across GUI and headless
  // Desktop writers. JSON payloads have no database-level unique index, so a
  // deferred transaction would still permit duplicate event ids under race.
  return persist.immediate();
}

/** Domain evidence must never make the product action itself fail. */
export function tryRecordOneDomainEvent(input: RecordOneDomainEventInput): OneDomainEventV1 | null {
  try {
    return recordOneDomainEvent(input);
  } catch {
    return null;
  }
}

export function listOneDomainEvents(entityId: string, limit = 100): OneDomainEventV1[] {
  if (!safeId(entityId)) return [];
  const bounded = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const rows = getDb().prepare(
    `SELECT payload_json FROM run_events
     WHERE run_id = ? AND kind = ?
     ORDER BY seq DESC LIMIT ?`,
  ).all(ledgerRunId(entityId), ONE_DOMAIN_EVENT_KIND, bounded) as DomainEventRow[];
  return rows.map(eventFromRow).filter((item): item is OneDomainEventV1 => Boolean(item));
}

/**
 * Bounded, validated cross-entity read used for aggregate-only product
 * feedback. Raw rows never leave Main and malformed ledger entries are
 * ignored instead of being projected into One.
 */
export function listOneDomainEventsByType(
  eventType: OneDomainEventType,
  input: { occurredAtOrAfter: string; occurredBefore: string; limit?: number },
): OneDomainEventV1[] {
  // The type is compile-time closed, while this guard protects direct JS and
  // corrupted IPC-adjacent callers.
  if (!Object.prototype.hasOwnProperty.call(ONE_DOMAIN_EVENT_RULES, eventType)) return [];
  const startMs = Date.parse(input.occurredAtOrAfter);
  const endMs = Date.parse(input.occurredBefore);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const bounded = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 500)));
  const rows = getDb().prepare(
    `SELECT payload_json FROM run_events
     WHERE kind = ?
       AND json_extract(json_extract(payload_json, '$.oneDomainEventJson'), '$.eventType') = ?
       AND julianday(json_extract(json_extract(payload_json, '$.oneDomainEventJson'), '$.occurredAt')) >= julianday(?)
       AND julianday(json_extract(json_extract(payload_json, '$.oneDomainEventJson'), '$.occurredAt')) < julianday(?)
     ORDER BY julianday(json_extract(json_extract(payload_json, '$.oneDomainEventJson'), '$.occurredAt')) ASC,
              rowid ASC
     LIMIT ?`,
  ).all(ONE_DOMAIN_EVENT_KIND, eventType, new Date(startMs).toISOString(), new Date(endMs).toISOString(), bounded) as DomainEventRow[];
  return rows.map(eventFromRow).filter((item): item is OneDomainEventV1 => item?.eventType === eventType);
}
