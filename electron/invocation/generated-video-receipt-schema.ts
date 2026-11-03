import type Database from 'better-sqlite3';
/** Additive v139 metadata only. Main creates it in the existing migration transaction. */
export function createGeneratedVideoReceiptSchema(db:Pick<Database.Database,'exec'>):void {
 db.exec(`CREATE TABLE IF NOT EXISTS generated_video_receipts (
 operation_id TEXT PRIMARY KEY REFERENCES media_operations(id) ON DELETE CASCADE,
 chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
 account_key TEXT NOT NULL, workspace_hash TEXT NOT NULL,
 origin_run_id TEXT NOT NULL, origin_owner_id TEXT NOT NULL, origin_lease_id TEXT NOT NULL, origin_seq INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('origin','observed','sealed')),
 observer_run_id TEXT, observer_owner_id TEXT, observer_lease_id TEXT, observed_seq INTEGER, witness_json TEXT,
 message_id TEXT REFERENCES chat_messages(id) ON DELETE CASCADE,
 CHECK ((state='origin' AND observer_run_id IS NULL AND observer_owner_id IS NULL AND observer_lease_id IS NULL AND observed_seq IS NULL AND witness_json IS NULL AND message_id IS NULL)
 OR (state='observed' AND observer_run_id IS NOT NULL AND observer_owner_id IS NOT NULL AND observer_lease_id IS NOT NULL AND observed_seq IS NOT NULL AND witness_json IS NOT NULL AND message_id IS NULL)
 OR (state='sealed' AND observer_run_id IS NOT NULL AND observer_owner_id IS NOT NULL AND observer_lease_id IS NOT NULL AND observed_seq IS NOT NULL AND witness_json IS NOT NULL AND message_id IS NOT NULL))
 ); CREATE INDEX IF NOT EXISTS idx_generated_video_receipts_message ON generated_video_receipts(chat_id,message_id,state);`);
}
