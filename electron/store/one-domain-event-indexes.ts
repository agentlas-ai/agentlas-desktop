import type Database from "better-sqlite3";

// Historical ledger envelopes may be malformed. CASE short-circuits before
// each JSON operation; the same expressions must be used by reads and indexes.
export const ONE_DOMAIN_EVENT_OBJECT_SQL = `CASE WHEN json_valid(payload_json)
  THEN CASE WHEN json_type(payload_json, '$.oneDomainEventJson') = 'text'
    THEN CASE WHEN json_valid(json_extract(payload_json, '$.oneDomainEventJson'))
      THEN CASE WHEN json_type(json_extract(payload_json, '$.oneDomainEventJson')) = 'object'
        THEN json_extract(payload_json, '$.oneDomainEventJson') END END END END`;
export const ONE_DOMAIN_EVENT_ID_SQL = `json_extract(${ONE_DOMAIN_EVENT_OBJECT_SQL}, '$.eventId')`;
export const ONE_DOMAIN_EVENT_VERSION_SQL = `CAST(json_extract(${ONE_DOMAIN_EVENT_OBJECT_SQL}, '$.version') AS INTEGER)`;
export const ONE_DOMAIN_EVENT_TYPE_SQL = `json_extract(${ONE_DOMAIN_EVENT_OBJECT_SQL}, '$.eventType')`;
export const ONE_DOMAIN_EVENT_TIME_SQL = `julianday(json_extract(${ONE_DOMAIN_EVENT_OBJECT_SQL}, '$.occurredAt'))`;

/** Additive owner migration: retain legacy duplicate IDs and original payloads. */
export function createOneDomainEventIndexes(db: Pick<Database.Database, "exec">): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_one_domain_event_id
      ON run_events(${ONE_DOMAIN_EVENT_ID_SQL}) WHERE kind = 'one_domain_event';
    CREATE INDEX IF NOT EXISTS idx_one_domain_event_entity_version
      ON run_events(run_id, ${ONE_DOMAIN_EVENT_VERSION_SQL} DESC) WHERE kind = 'one_domain_event';
    CREATE INDEX IF NOT EXISTS idx_one_domain_event_type_time
      ON run_events(${ONE_DOMAIN_EVENT_TYPE_SQL}, ${ONE_DOMAIN_EVENT_TIME_SQL}) WHERE kind = 'one_domain_event';
  `);
}
