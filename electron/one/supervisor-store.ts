import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { SupervisorCommandReceipt, SupervisorNotice, SupervisorRequestState } from "../../shared/one-supervisor";

export interface SupervisorRequestRow {
  command_id: string; one_id: string; kind: SupervisorCommandReceipt["kind"]; payload_json: string;
  payload_hash: string; state: SupervisorRequestState; task_id: string | null; run_id: string | null;
  origin_chat_id: string; receipt_json: string; created_at: string; updated_at: string;
  user_message_id: string | null;
  source_reply_run_id: string | null;
}
export const supervisorHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function personalSupervisorConversationInDb(db: Database.Database, oneId: string, chatId: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_conversations'").get()) return false;
  return !!db.prepare("SELECT 1 FROM one_supervisor_conversations WHERE one_id=? AND chat_id=?").get(oneId,chatId);
}

/** Exact host-sealed ingress boundary. Later queued user inputs must not enter an earlier reply. */
export function supervisorExcludedHistoryMessages(db: Database.Database, chatId: string, runId: string | undefined): Set<string> {
  if (!runId || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_requests'").get()) return new Set();
  const bound = db.prepare(`SELECT r.rowid AS sequence FROM one_supervisor_requests r
    JOIN one_supervisor_conversations c ON c.one_id=r.one_id AND c.chat_id=r.origin_chat_id
    WHERE r.run_id=? AND r.origin_chat_id=? AND r.kind='reply'`).get(runId,chatId) as {sequence:number} | undefined;
  if (!bound) return new Set();
  return new Set((db.prepare("SELECT user_message_id AS id FROM one_supervisor_requests WHERE origin_chat_id=? AND kind='reply' AND rowid>=?")
    .all(chatId,bound.sequence) as Array<{id:string|null}>).flatMap(row=>row.id ? [row.id] : []));
}
export function supervisorIngressMessage(db:Database.Database,chatId:string,runId:string|undefined):string|null {
  if (!runId || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_requests'").get()) return null;
  return (db.prepare(`SELECT r.user_message_id AS id FROM one_supervisor_requests r
    JOIN one_supervisor_conversations c ON c.one_id=r.one_id AND c.chat_id=r.origin_chat_id
    WHERE r.run_id=? AND r.origin_chat_id=? AND r.kind='reply'`).get(runId,chatId) as {id:string|null}|undefined)?.id ?? null;
}
/** A stopped Goal may have been detached from its chat. Keep only the exact old receipt's projection. */
export function supervisorStoppedGoalForTask(db:Database.Database,taskId:string,runId:string|null):string|null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_requests'").get()) return null;
  const row=db.prepare(`SELECT json_extract(payload_json,'$.boundGoalId') AS goalId FROM one_supervisor_requests
    WHERE kind='cancel' AND task_id=? AND state IN ('dispatching','accepted','held','cancelled','completed')
      AND (run_id=? OR (run_id IS NULL AND ? IS NULL))
    ORDER BY rowid DESC LIMIT 1`).get(taskId,runId,runId) as {goalId:string|null}|undefined;
  return typeof row?.goalId === "string" ? row.goalId : null;
}

/** Additive ingress/attribution journal. Tasks, attempts, effects and approvals stay in their existing ledgers. */
export class OneSupervisorStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS one_supervisor_conversations (
        one_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS one_supervisor_requests (
        command_id TEXT PRIMARY KEY, one_id TEXT NOT NULL, kind TEXT NOT NULL,
        payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('stored','dispatching','accepted','completed','cancelled','failed','held')),
        task_id TEXT, run_id TEXT, origin_chat_id TEXT NOT NULL, user_message_id TEXT, receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS one_supervisor_request_queue ON one_supervisor_requests(one_id,state,created_at);
      CREATE INDEX IF NOT EXISTS one_supervisor_request_run ON one_supervisor_requests(run_id);
      CREATE TABLE IF NOT EXISTS one_supervisor_notices (
        id TEXT PRIMARY KEY, one_id TEXT NOT NULL, task_id TEXT NOT NULL, origin_chat_id TEXT NOT NULL,
        run_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(one_id,task_id,run_id)
      );
    `);
    if (!(db.prepare("PRAGMA table_info(one_supervisor_requests)").all() as Array<{name:string}>).some(column=>column.name === "user_message_id")) {
      db.exec("ALTER TABLE one_supervisor_requests ADD COLUMN user_message_id TEXT");
    }
    if (!(db.prepare("PRAGMA table_info(one_supervisor_requests)").all() as Array<{name:string}>).some(column=>column.name === "source_reply_run_id")) {
      db.exec("ALTER TABLE one_supervisor_requests ADD COLUMN source_reply_run_id TEXT");
    }
  }
  conversation(oneId: string): string | null {
    return (this.db.prepare("SELECT chat_id FROM one_supervisor_conversations WHERE one_id=?").get(oneId) as {chat_id: string} | undefined)?.chat_id ?? null;
  }
  bindConversation(oneId: string, create: () => string): string {
    return this.db.transaction(() => {
      const prior = this.conversation(oneId);
      if (prior) return prior;
      const id = create();
      this.db.prepare("INSERT INTO one_supervisor_conversations(one_id,chat_id) VALUES(?,?)").run(oneId, id);
      return id;
    })();
  }
  get(commandId: string): SupervisorRequestRow | null {
    return this.db.prepare("SELECT * FROM one_supervisor_requests WHERE command_id=?").get(commandId) as SupervisorRequestRow | undefined ?? null;
  }
  receive(input: { commandId: string; oneId: string; kind: SupervisorCommandReceipt["kind"]; payload: unknown; originChatId: string; taskId?: string; runId?: string }, persist?: () => string | void): SupervisorRequestRow {
    const hash = supervisorHash([input.oneId,input.kind,input.payload]);
    return this.db.transaction(() => {
      const prior = this.get(input.commandId);
      if (prior) {
        if (prior.one_id !== input.oneId || prior.payload_hash !== hash) throw new Error("supervisor_command_identity_conflict");
        return prior;
      }
      const now = new Date().toISOString();
      const receipt: SupervisorCommandReceipt = { commandId: input.commandId, kind: input.kind, state: "stored", taskId: input.taskId ?? null, runId: input.runId ?? null, acknowledgement: "stored", reason: null };
      const messageId = persist?.(); // message and ACK are committed together; disk failure emits no success
      this.db.prepare(`INSERT INTO one_supervisor_requests(command_id,one_id,kind,payload_json,payload_hash,state,task_id,run_id,origin_chat_id,user_message_id,receipt_json,created_at,updated_at)
        VALUES(?,?,?,?,?,'stored',?,?,?,?,?,?,?)`).run(input.commandId,input.oneId,input.kind,JSON.stringify(input.payload),hash,input.taskId ?? null,input.runId ?? null,input.originChatId,messageId ?? null,JSON.stringify(receipt),now,now);
      return this.get(input.commandId)!;
    })();
  }
  update(row: SupervisorRequestRow, patch: Partial<SupervisorCommandReceipt>, expectedState = row.state): SupervisorCommandReceipt {
    const receipt = {...JSON.parse(row.receipt_json) as SupervisorCommandReceipt,...patch};
    const changed = this.db.prepare(`UPDATE one_supervisor_requests SET state=?,task_id=?,run_id=?,receipt_json=?,updated_at=? WHERE command_id=? AND one_id=? AND state=?`)
      .run(receipt.state,receipt.taskId,receipt.runId,JSON.stringify(receipt),new Date().toISOString(),row.command_id,row.one_id,expectedState);
    if (changed.changes !== 1) throw new Error("supervisor_request_state_conflict");
    return receipt;
  }
  list(oneId: string, state?: SupervisorRequestState): SupervisorRequestRow[] {
    return this.db.prepare(`SELECT * FROM one_supervisor_requests WHERE one_id=? ${state ? "AND state=?" : ""} ORDER BY rowid ${state ? "ASC" : "DESC"} LIMIT 100`).all(...(state ? [oneId,state] : [oneId])) as SupervisorRequestRow[];
  }
  forRun(runId: string): SupervisorRequestRow[] {
    return this.db.prepare("SELECT * FROM one_supervisor_requests WHERE run_id=? AND state IN ('dispatching','accepted','held')").all(runId) as SupervisorRequestRow[];
  }
  pending(oneId:string):SupervisorRequestRow[] {
    return this.db.prepare("SELECT * FROM one_supervisor_requests WHERE one_id=? AND state IN ('stored','dispatching','accepted','held') ORDER BY rowid ASC").all(oneId) as SupervisorRequestRow[];
  }
  notice(row: SupervisorRequestRow, state: string): void {
    if (!row.task_id || !row.run_id) return;
    this.db.prepare("INSERT OR IGNORE INTO one_supervisor_notices(id,one_id,task_id,origin_chat_id,run_id,state,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(supervisorHash([row.one_id,row.task_id,row.run_id]),row.one_id,row.task_id,row.origin_chat_id,row.run_id,state,new Date().toISOString());
  }
  notices(oneId: string): SupervisorNotice[] {
    return this.db.prepare("SELECT id,task_id AS taskId,origin_chat_id AS originChatId,run_id AS runId,state,created_at AS createdAt FROM one_supervisor_notices WHERE one_id=? ORDER BY rowid DESC LIMIT 100").all(oneId) as SupervisorNotice[];
  }
}
