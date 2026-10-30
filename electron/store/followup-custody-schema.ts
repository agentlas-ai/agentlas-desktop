/** Installed only by Desktop's versioned owner migration. Followers do no DDL. */
export function createFollowupCustodySchema(db: { exec(sql: string): unknown }): void {
  db.exec(`CREATE TABLE IF NOT EXISTS invocation_followup_custody (
    intent_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    origin_run_id TEXT NOT NULL,
    account_digest TEXT NOT NULL,
    request_json TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('entered','stopped')),
    queue_id TEXT UNIQUE,
    closed_attempt_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS invocation_followup_custody_origin ON invocation_followup_custody(origin_run_id);`);
}
