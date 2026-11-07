import { supervisorError } from "../../shared/one-supervisor";
import { createHash } from "node:crypto";
import { isHostCheckinInstruction } from "./host-checkin-instructions";
import { purgeCheckinSessions, purgeOrphanCheckinSessions } from "./checkin-session";
import type Database from "better-sqlite3";
import { ONE_CHECKIN_LIMITS, ONE_CHECKIN_POLICY, checkinStaleAllowanceMs, clampCheckinCadence, nextCheckinAt, type OneCheckin, type OneCheckinCadence, type SupervisorCommandReceipt, type SupervisorNotice, type SupervisorRequestState } from "../../shared/one-supervisor";
import { ONE_SUPERVISOR_JOURNAL_SCHEMA, type SupervisorJournalPage, type SupervisorJournalEvent } from "../../shared/one-supervisor-runtime";

export interface SupervisorRequestRow {
  command_id: string; one_id: string; kind: SupervisorCommandReceipt["kind"]; payload_json: string;
  payload_hash: string; state: SupervisorRequestState; task_id: string | null; run_id: string | null;
  origin_chat_id: string; receipt_json: string; created_at: string; updated_at: string;
  user_message_id: string | null;
  source_reply_run_id: string | null;
  dispatch_retry_json?: string | null;
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

/** The Work hand-off that owns a worker conversation, found by its exact workerChatId however old it is. A bounded
 * "latest N rows" scan lost the owner once N newer hand-offs existed (native-harness notyet NH16 4th audit: row 401). */
export function supervisorWorkForWorkerChat(db: Database.Database, workerChatId: string, oneId?: string): {one_id: string; command_id: string; task_id: string} | undefined {
  if (!workerChatId || !db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_requests'").get()) return undefined;
  return db.prepare(`SELECT one_id,command_id,task_id FROM one_supervisor_requests
    WHERE kind='work' AND task_id IS NOT NULL ${oneId ? "AND one_id=?" : ""} AND json_valid(payload_json)
      AND json_extract(payload_json,'$.workerChatId')=? ORDER BY rowid DESC LIMIT 1`)
    .get(...(oneId ? [oneId, workerChatId] : [workerChatId])) as {one_id: string; command_id: string; task_id: string} | undefined;
}

/** A graph/automation result answering One's conversation or a Work session it delegated (native-harness notyet NH16,
 * one/graph-review.ts). Written inside the scheduler's delivery transaction, so a crash cannot lose it and a replayed
 * delivery cannot queue it twice; the owner's own stop is kept as skipped. Same notice id rule as notice(). A store that
 * the supervisor has not upgraded yet (no review columns) queues nothing; the origin report itself is already saved. */
export function insertGraphResultNotice(db: Database.Database, input: {oneId: string; automationId: string; runId: string; personalChatId: string; state: string; ownerStopped: boolean; detail: string}): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_notices'").get()) return false;
  const columns = new Set((db.prepare("PRAGMA table_info(one_supervisor_notices)").all() as Array<{name:string}>).map(column => column.name));
  if (!columns.has("review_state") || !columns.has("detail")) return false;
  const taskId = `graph:${input.automationId}`;
  return db.prepare(`INSERT OR IGNORE INTO one_supervisor_notices(id,one_id,task_id,origin_chat_id,run_id,state,created_at,review_state,review_reason,detail)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(supervisorHash([input.oneId,taskId,input.runId]),input.oneId,taskId,input.personalChatId,input.runId,input.state,
    new Date().toISOString(),input.ownerStopped ? "skipped" : "pending",input.ownerStopped ? "owner_cancelled" : null,input.detail).changes === 1;
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
    if (!(db.prepare("PRAGMA table_info(one_supervisor_requests)").all() as Array<{name:string}>).some(column=>column.name === "dispatch_retry_json")) {
      db.exec("ALTER TABLE one_supervisor_requests ADD COLUMN dispatch_retry_json TEXT");
    }
    if (!(db.prepare("PRAGMA table_info(one_supervisor_notices)").all() as Array<{name:string}>).some(column=>column.name === "review_state")) {
      db.transaction(() => {
        db.exec(`ALTER TABLE one_supervisor_notices ADD COLUMN review_state TEXT NOT NULL DEFAULT 'pending';
          ALTER TABLE one_supervisor_notices ADD COLUMN review_run_id TEXT;
          ALTER TABLE one_supervisor_notices ADD COLUMN reviewed_at TEXT;
          ALTER TABLE one_supervisor_notices ADD COLUMN review_reason TEXT;
          ALTER TABLE one_supervisor_notices ADD COLUMN review_attempts INTEGER NOT NULL DEFAULT 0;`);
        // Results that settled before One reviewed its own delegations were already shown; never replay them as new reports.
        db.prepare("UPDATE one_supervisor_notices SET review_state='skipped',review_reason='settled_before_review_loop'").run();
      })();
    }
    if (!(db.prepare("PRAGMA table_info(one_supervisor_notices)").all() as Array<{name:string}>).some(column=>column.name === "detail")) {
      db.exec("ALTER TABLE one_supervisor_notices ADD COLUMN detail TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS one_supervisor_notice_review ON one_supervisor_notices(one_id,review_state)");
    // Check-ins the owner asked One to run on its own (dots parity). Additive, like the tables above.
    db.exec(`CREATE TABLE IF NOT EXISTS one_supervisor_checkins (
        id TEXT PRIMARY KEY, one_id TEXT NOT NULL, instruction TEXT NOT NULL, cadence_json TEXT NOT NULL,
        notify TEXT NOT NULL CHECK(notify IN ('important','always')), next_at INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, fires INTEGER NOT NULL DEFAULT 0, last_fired_at INTEGER,
        created_at TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS one_supervisor_checkin_due ON one_supervisor_checkins(one_id,active,next_at);`);
    // Receipts and their ordered change records commit in the same SQLite transaction,
    // including writes made by existing native adapters. Notification delivery is not authority.
    // The one-time backfill below is for a store that had requests before this table existed. Once the table exists, its rows are trimmed by
    // storage/db-retention-policy.ts (one_supervisor_command_events.closed); a backfill that ran on every start would put them back.
    const eventsTableExisted = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_command_events'").get());
    db.exec(`CREATE TABLE IF NOT EXISTS one_supervisor_command_events (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, one_id TEXT NOT NULL, command_id TEXT NOT NULL,
      receipt_json TEXT NOT NULL, recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS one_supervisor_command_event_scope ON one_supervisor_command_events(one_id,cursor);
    CREATE INDEX IF NOT EXISTS one_supervisor_command_event_command ON one_supervisor_command_events(command_id);
    CREATE TRIGGER IF NOT EXISTS one_supervisor_request_insert_event AFTER INSERT ON one_supervisor_requests BEGIN
      INSERT INTO one_supervisor_command_events(one_id,command_id,receipt_json,recorded_at)
      VALUES(NEW.one_id,NEW.command_id,NEW.receipt_json,NEW.updated_at);
    END;
    CREATE TRIGGER IF NOT EXISTS one_supervisor_request_update_event AFTER UPDATE OF receipt_json ON one_supervisor_requests
    WHEN NEW.receipt_json<>OLD.receipt_json BEGIN
      INSERT INTO one_supervisor_command_events(one_id,command_id,receipt_json,recorded_at)
      VALUES(NEW.one_id,NEW.command_id,NEW.receipt_json,NEW.updated_at);
    END;`);
    if (!eventsTableExisted) db.exec(`INSERT INTO one_supervisor_command_events(one_id,command_id,receipt_json,recorded_at)
      SELECT r.one_id,r.command_id,r.receipt_json,r.updated_at FROM one_supervisor_requests r
      WHERE NOT EXISTS(SELECT 1 FROM one_supervisor_command_events e WHERE e.command_id=r.command_id);`);
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
  cursor(oneId: string): number {
    return (this.db.prepare("SELECT COALESCE(MAX(cursor),0) AS cursor FROM one_supervisor_command_events WHERE one_id=?").get(oneId) as {cursor:number}).cursor;
  }
  journal(oneId:string,afterCursor:number,limit=100):SupervisorJournalPage {
    if(!Number.isSafeInteger(afterCursor)||afterCursor<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw supervisorError('supervisor_journal_cursor_invalid');
    return this.db.transaction(()=>{
      const latestCursor=this.cursor(oneId);
      if(afterCursor>latestCursor)return {schema:ONE_SUPERVISOR_JOURNAL_SCHEMA,oneId,events:[],nextCursor:latestCursor,latestCursor,hasMore:false,resetRequired:true};
      const rows=this.db.prepare(`SELECT cursor,command_id,receipt_json,recorded_at FROM one_supervisor_command_events
        WHERE one_id=? AND cursor>? ORDER BY cursor LIMIT ?`).all(oneId,afterCursor,limit) as Array<{cursor:number;command_id:string;receipt_json:string;recorded_at:string}>;
      const events:SupervisorJournalEvent[]=rows.map(row=>({cursor:row.cursor,commandId:row.command_id,receipt:JSON.parse(row.receipt_json),recordedAt:row.recorded_at}));
      const nextCursor=events.at(-1)?.cursor ?? afterCursor;
      return {schema:ONE_SUPERVISOR_JOURNAL_SCHEMA,oneId,events,nextCursor,latestCursor,hasMore:nextCursor<latestCursor,resetRequired:false};
    })();
  }
  receive(input: { commandId: string; oneId: string; kind: SupervisorCommandReceipt["kind"]; payload: unknown; originChatId: string; taskId?: string; runId?: string }, persist?: () => string | void): SupervisorRequestRow {
    const hash = supervisorHash([input.oneId,input.kind,input.payload]);
    return this.db.transaction(() => {
      const prior = this.get(input.commandId);
      if (prior) {
        if (prior.one_id !== input.oneId || prior.payload_hash !== hash) throw supervisorError('supervisor_command_identity_conflict');
        return prior;
      }
      const now = new Date().toISOString();
      const receipt: SupervisorCommandReceipt = { commandId: input.commandId, kind: input.kind, state: "stored", taskId: input.taskId ?? null, runId: input.runId ?? null, acknowledgement: "stored", reason: null,
        ...(["cancel","stop-reply"].includes(input.kind)?{control:{phase:"requested" as const,requestedAt:now,observedAt:now}}:{}) };
      const messageId = persist?.(); // message and ACK are committed together; disk failure emits no success
      this.db.prepare(`INSERT INTO one_supervisor_requests(command_id,one_id,kind,payload_json,payload_hash,state,task_id,run_id,origin_chat_id,user_message_id,receipt_json,created_at,updated_at)
        VALUES(?,?,?,?,?,'stored',?,?,?,?,?,?,?)`).run(input.commandId,input.oneId,input.kind,JSON.stringify(input.payload),hash,input.taskId ?? null,input.runId ?? null,input.originChatId,messageId ?? null,JSON.stringify(receipt),now,now);
      return this.get(input.commandId)!;
    }).immediate();
  }
  update(row: SupervisorRequestRow, patch: Partial<SupervisorCommandReceipt>, expectedState = row.state): SupervisorCommandReceipt {
    const receipt = {...JSON.parse(row.receipt_json) as SupervisorCommandReceipt,...patch};
    if(receipt.kind==="cancel"||receipt.kind==="stop-reply")receipt.control={
      phase:receipt.state==="cancelled"?"stopped":receipt.state==="held"?"unknown":receipt.state==="completed"?"settled"
        :receipt.state==="failed"?(receipt.reason==="cancel_raced_terminal_outcome"||receipt.reason==="interrupted_requires_review"?"settled":"rejected")
        :receipt.acknowledgement==="delivered"?"delivered":"requested",
      requestedAt:receipt.control?.requestedAt ?? row.created_at,observedAt:new Date().toISOString(),
    };
    const changed = this.db.prepare(`UPDATE one_supervisor_requests SET state=?,task_id=?,run_id=?,receipt_json=?,updated_at=? WHERE command_id=? AND one_id=? AND state=?`)
      .run(receipt.state,receipt.taskId,receipt.runId,JSON.stringify(receipt),new Date().toISOString(),row.command_id,row.one_id,expectedState);
    if (changed.changes !== 1) throw supervisorError('supervisor_request_state_conflict');
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
  /** Written in the same transaction as the settlement, so a crash cannot lose a finished delegation's report (D06).
   * The owner's own cancellation needs no report back. */
  notice(row: SupervisorRequestRow, state: string): boolean {
    if (!row.task_id || !row.run_id) return false;
    return this.db.prepare(`INSERT OR IGNORE INTO one_supervisor_notices(id,one_id,task_id,origin_chat_id,run_id,state,created_at,review_state,review_reason)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(supervisorHash([row.one_id,row.task_id,row.run_id]),row.one_id,row.task_id,row.origin_chat_id,row.run_id,state,new Date().toISOString(),
      state === "cancelled" ? "skipped" : "pending", state === "cancelled" ? "owner_cancelled" : null).changes === 1;
  }
  /** A hand-off's outcome carried by a later run of the same worker conversation: the turn that brought the reports of sessions the
   * worker delegated back, after the hand-off's own turn ended with them still running (supervisor-service noticeDelegatedOutcome). */
  noticeRun(row: SupervisorRequestRow, runId: string, state: string): boolean {
    if (!row.task_id || !runId) return false;
    return this.db.prepare(`INSERT OR IGNORE INTO one_supervisor_notices(id,one_id,task_id,origin_chat_id,run_id,state,created_at,review_state,review_reason)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(supervisorHash([row.one_id,row.task_id,runId]),row.one_id,row.task_id,row.origin_chat_id,runId,state,new Date().toISOString(),
      state === "cancelled" ? "skipped" : "pending", state === "cancelled" ? "owner_cancelled" : null).changes === 1;
  }
  /** A teammate result linked to the exact one_chat_send run that started it (22 O1). Once per teammate run. */
  noticeTeamResult(oneId: string, input: {dispatchId: string; childRunId: string; chatId: string; state: string; detail: string}): boolean {
    const taskId = `team:${input.dispatchId}`;
    return this.db.prepare(`INSERT OR IGNORE INTO one_supervisor_notices(id,one_id,task_id,origin_chat_id,run_id,state,created_at,review_state,review_reason,detail)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(supervisorHash([oneId,taskId,input.childRunId]),oneId,taskId,input.chatId,input.childRunId,input.state,new Date().toISOString(),
      input.state === "cancelled" ? "skipped" : "pending", input.state === "cancelled" ? "owner_cancelled" : null, input.detail.slice(0, 6000)).changes === 1;
  }
  private checkinRow(row: {id:string;instruction:string;cadence_json:string;notify:"important"|"always";next_at:number;last_fired_at:number|null;fires:number}): OneCheckin {
    return {id:row.id,instruction:row.instruction,cadence:JSON.parse(row.cadence_json) as OneCheckinCadence,notify:row.notify,
      nextAt:new Date(row.next_at).toISOString(),lastFiredAt:row.last_fired_at ? new Date(row.last_fired_at).toISOString() : null,fires:row.fires};
  }
  addCheckin(oneId: string, input: {commandId: string; instruction: string; cadence: OneCheckinCadence; notify: "important" | "always"}, now = Date.now()): OneCheckin {
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE command_id=?").get(input.commandId) as Parameters<OneSupervisorStore["checkinRow"]>[0] & {one_id:string} | undefined;
      if (prior) { if (prior.one_id !== oneId) throw supervisorError('supervisor_command_identity_conflict'); return this.checkinRow(prior); }
      // The cap bounds the model's check-ins: one active check-in per host-authored instruction (host-checkin-instructions.ts) is exempt, the rest count.
      if (this.checkinCapReached(oneId, input.instruction)) throw supervisorError('supervisor_checkin_limit');
      const id = `checkin_${supervisorHash([oneId,input.commandId]).slice(0,24)}`;
      this.db.prepare(`INSERT INTO one_supervisor_checkins(id,one_id,instruction,cadence_json,notify,next_at,created_at,command_id) VALUES(?,?,?,?,?,?,?,?)`)
        .run(id,oneId,input.instruction,JSON.stringify(input.cadence),input.notify,nextCheckinAt(input.cadence,now),new Date(now).toISOString(),input.commandId);
      return this.checkinRow(this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE id=?").get(id) as Parameters<OneSupervisorStore["checkinRow"]>[0]);
    }).immediate();
  }
  /** Active check-ins count against the cap (a pending owner proposal is not active and does not). One per host-authored instruction is exempt. */
  private checkinCapReached(oneId: string, instruction: string): boolean {
    const active = this.db.prepare("SELECT instruction FROM one_supervisor_checkins WHERE one_id=? AND active=1").all(oneId) as {instruction:string}[];
    const exempt = new Set<string>();
    let counted = 0;
    for (const row of active) { if (isHostCheckinInstruction(row.instruction) && !exempt.has(row.instruction)) exempt.add(row.instruction); else counted++; }
    return !(isHostCheckinInstruction(instruction) && !exempt.has(instruction)) && counted >= ONE_CHECKIN_LIMITS.active;
  }
  /** An unanswered proposal expires with its card: nothing reads it after that, so it is deleted (called by every reader and by the sweep). */
  purgeExpiredProposals(oneId: string, now = Date.now()): number {
    return Number(this.db.prepare("DELETE FROM one_supervisor_checkins WHERE one_id=? AND active=2 AND created_at<?")
      .run(oneId, new Date(now - ONE_CHECKIN_POLICY.proposalTtlMs).toISOString()).changes);
  }
  /**
   * A check-in the model asked for is stored inactive (active=2) until the owner turns it on from the card. The same command id, or the same
   * instruction/cadence/notify already waiting, returns the stored proposal and is not fresh: the caller posts one card per fresh proposal.
   * At most maxPendingProposals wait; a new one replaces the oldest.
   */
  proposeCheckin(oneId: string, input: {commandId: string; instruction: string; cadence: OneCheckinCadence; notify: "important" | "always"}, now = Date.now()): {checkin: OneCheckin; fresh: boolean; evicted: OneCheckin[]} {
    return this.db.transaction(() => {
      this.purgeExpiredProposals(oneId, now);
      type Row = Parameters<OneSupervisorStore["checkinRow"]>[0];
      const prior = this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE command_id=?").get(input.commandId) as Row & {one_id:string} | undefined;
      if (prior) { if (prior.one_id !== oneId) throw supervisorError('supervisor_command_identity_conflict'); return {checkin: this.checkinRow(prior), fresh: false, evicted: []}; }
      const cadenceJson = JSON.stringify(input.cadence);
      const same = this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE one_id=? AND active=2 AND instruction=? AND cadence_json=? AND notify=?")
        .get(oneId, input.instruction, cadenceJson, input.notify) as Row | undefined;
      if (same) return {checkin: this.checkinRow(same), fresh: false, evicted: []};
      const next = nextCheckinAt(input.cadence, now); // refuses an invalid cadence before anything is stored
      const waiting = this.db.prepare("SELECT id FROM one_supervisor_checkins WHERE one_id=? AND active=2 ORDER BY created_at DESC, rowid DESC").all(oneId) as {id:string}[];
      const evictedRows = waiting.slice(Math.max(0, ONE_CHECKIN_POLICY.maxPendingProposals - 1));
      const evicted = evictedRows.map(old => this.checkinRow(this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE id=?").get(old.id) as Row));
      for (const old of evictedRows) this.db.prepare("DELETE FROM one_supervisor_checkins WHERE id=? AND active=2").run(old.id);
      const id = `checkin_${supervisorHash([oneId,input.commandId]).slice(0,24)}`;
      this.db.prepare(`INSERT INTO one_supervisor_checkins(id,one_id,instruction,cadence_json,notify,next_at,active,created_at,command_id) VALUES(?,?,?,?,?,?,2,?,?)`)
        .run(id,oneId,input.instruction,cadenceJson,input.notify,next,new Date(now).toISOString(),input.commandId);
      return {checkin: this.checkinRow(this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE id=?").get(id) as Row), fresh: true, evicted};
    }).immediate();
  }
  /** Whether the check-in was created by the model's tool path (its create request is marked as a proposal). */
  modelMade(commandId: string): boolean {
    try {
      const row = this.db.prepare("SELECT payload_json FROM one_supervisor_requests WHERE command_id=?").get(commandId) as {payload_json: string} | undefined;
      return !!row && JSON.parse(row.payload_json).proposal === true;
    } catch { return false; }
  }
  /**
   * Once per check-in, true the first time it is asked: the owner is told that a check-in now runs read-only (one line, the first time an
   * already-active check-in runs that way). The mark is a meta row, deleted with the check-in's other leftovers by the owner's cancel.
   */
  markReadOnlyTold(checkinId: string): boolean {
    try {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) return false;
      return this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)").run(`checkin.readonly-told:${checkinId}`, "1").changes === 1;
    } catch { return false; }
  }
  /** Proposals still waiting for the owner, newest first. */
  proposedCheckins(oneId: string, now = Date.now()): Array<OneCheckin & {createdAt: string}> {
    this.purgeExpiredProposals(oneId, now);
    return (this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE one_id=? AND active=2 ORDER BY created_at DESC, rowid DESC").all(oneId) as Array<Parameters<OneSupervisorStore["checkinRow"]>[0] & {created_at:string}>)
      .map(row => ({...this.checkinRow(row), createdAt: row.created_at}));
  }
  /**
   * The owner's decision on a proposal. enable: active=2 -> 1 in one compare-and-set (a second tap or a replay finds nothing to change),
   * the first run is one cadence step from now. decline: the proposal is deleted. Both answer "missing" for an expired or already decided one.
   */
  decideCheckin(oneId: string, id: string, decision: "enable" | "decline", now = Date.now()): {state: "enabled"; checkin: OneCheckin} | {state: "declined" | "missing" | "limit"} {
    return this.db.transaction(() => {
      this.purgeExpiredProposals(oneId, now);
      type Row = Parameters<OneSupervisorStore["checkinRow"]>[0];
      const row = this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE one_id=? AND id=? AND active=2").get(oneId, id) as Row | undefined;
      if (!row) return {state: "missing" as const};
      if (decision === "decline") {
        this.db.prepare("DELETE FROM one_supervisor_checkins WHERE id=? AND active=2").run(id);
        return {state: "declined" as const};
      }
      if (this.checkinCapReached(oneId, row.instruction)) {
        this.db.prepare("DELETE FROM one_supervisor_checkins WHERE id=? AND active=2").run(id);
        return {state: "limit" as const};
      }
      // The proposal was stored with the cadence the card showed (clamped when the model asked for it): that is what turns on.
      const cadence = JSON.parse(row.cadence_json) as OneCheckinCadence;
      const moved = this.db.prepare("UPDATE one_supervisor_checkins SET active=1,next_at=? WHERE id=? AND active=2")
        .run(nextCheckinAt(cadence, now), id).changes;
      if (moved !== 1) return {state: "missing" as const};
      this.markReadOnlyTold(id); // the card already said "read-only"; no second line for a check-in the owner turned on
      return {state: "enabled" as const, checkin: this.checkinRow(this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE id=?").get(id) as Row)};
    }).immediate();
  }
  checkins(oneId: string): OneCheckin[] {
    return (this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE one_id=? AND active=1 ORDER BY next_at").all(oneId) as Array<Parameters<OneSupervisorStore["checkinRow"]>[0]>).map(row=>this.checkinRow(row));
  }
  checkin(oneId: string, id: string): (OneCheckin & {active:boolean}) | null {
    const row = this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE one_id=? AND id=?").get(oneId,id) as (Parameters<OneSupervisorStore["checkinRow"]>[0] & {active:number}) | undefined;
    return row ? {...this.checkinRow(row),active:row.active===1} : null;
  }
  /** Cancelling is never confirmed: an active check-in stops, and a proposal still waiting for the owner is dropped. */
  cancelCheckin(oneId: string, id: string): boolean {
    const stopped = this.db.prepare("UPDATE one_supervisor_checkins SET active=0 WHERE one_id=? AND id=? AND active=1").run(oneId,id).changes === 1
      || this.db.prepare("DELETE FROM one_supervisor_checkins WHERE one_id=? AND id=? AND active=2").run(oneId,id).changes === 1;
    if (stopped) { purgeCheckinSessions(this.db, id); try { if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) this.db.prepare("DELETE FROM meta WHERE key=?").run(`checkin.readonly-told:${id}`); } catch { /* the mark is a leftover only */ } }
    return stopped;
  }
  /**
   * Moves due check-ins to their next time (CAS on next_at) and queues one notice per firing.
   * - A slot missed while the app was closed fires only inside its allowance (half the interval, at most 2 h; daily 2 h); beyond it the
   *   check-in moves to its next slot without a run, so a long sleep does not queue a run.
   * - A model-made check-in runs at most perCheckinPerDay times a day and the owner's check-ins perOnePerDay together; at the cap the
   *   day's remaining slots are skipped and it resumes on the next local day (a skip is not a failure).
   * - At most maxFiresPerSweep model-made check-ins are queued per sweep; the rest stay due for the next sweep. Host-authored ones
   *   (a feature's own briefing) are outside the caps.
   * - An interval below the policy floor (older rows) runs at the floor.
   */
  private orphanSessionsChecked = false;
  fireDueCheckins(oneId: string, chatId: string, now = Date.now(), hold?: readonly string[], onCap?: (info: {checkinId: string; scope: "checkin" | "all"}) => void): number {
    if (!this.orphanSessionsChecked) { this.orphanSessionsChecked = true; purgeOrphanCheckinSessions(this.db); }
    return this.db.transaction(() => {
      this.purgeExpiredProposals(oneId, now);
      let fired = 0, modelFired = 0;
      const due = this.db.prepare("SELECT * FROM one_supervisor_checkins WHERE one_id=? AND active=1 AND next_at<=? ORDER BY next_at LIMIT 20").all(oneId,now) as Array<Parameters<OneSupervisorStore["checkinRow"]>[0] & {id:string;instruction:string;command_id:string}>;
      if (!due.length) return 0;
      const dayStart = new Date(now); dayStart.setHours(0,0,0,0);
      const dayStartIso = dayStart.toISOString();
      const nextDay = new Date(now); nextDay.setHours(24,0,0,0);
      const countFired = (taskId?: string): number => taskId
        ? (this.db.prepare("SELECT COUNT(*) AS n FROM one_supervisor_notices WHERE one_id=? AND task_id=? AND run_id LIKE 'fire:%' AND created_at>=?").get(oneId,taskId,dayStartIso) as {n:number}).n
        : (this.db.prepare(`SELECT c.instruction AS instruction FROM one_supervisor_notices n JOIN one_supervisor_checkins c ON n.task_id='checkin:'||c.id
            WHERE n.one_id=? AND n.run_id LIKE 'fire:%' AND n.created_at>=?`).all(oneId,dayStartIso) as Array<{instruction:string}>).filter(r => !isHostCheckinInstruction(r.instruction)).length;
      let firedToday: number | null = null;
      for (const row of due) {
        if (hold?.includes(row.id)) continue;
        let cadence: OneCheckinCadence;
        let next: number;
        try {
          cadence = JSON.parse(row.cadence_json) as OneCheckinCadence;
          // Only a check-in the model made is held to the floor; a row from the host or the owner's UI runs the cadence it has.
          const floored = this.modelMade(row.command_id) ? clampCheckinCadence(cadence) : { cadence, raisedFrom: null };
          if (floored.raisedFrom !== null) this.db.prepare("UPDATE one_supervisor_checkins SET cadence_json=? WHERE id=?").run(JSON.stringify(floored.cadence), row.id); // the list shows what runs
          cadence = floored.cadence;
          next = nextCheckinAt(cadence, now);
        } catch { this.cancelCheckin(oneId,row.id); continue; }
        const advance = (to: number): void => { this.db.prepare("UPDATE one_supervisor_checkins SET next_at=? WHERE id=? AND next_at=?").run(to,row.id,row.next_at); };
        const host = isHostCheckinInstruction(row.instruction);
        // The caps and the missed-slot skip are for check-ins the model made; one the owner set in the UI (or a host briefing) runs as set.
        const capped = !host && this.modelMade(row.command_id);
        if (capped && now - row.next_at > checkinStaleAllowanceMs(cadence)) { advance(next); continue; }
        if (capped) {
          if (modelFired >= ONE_CHECKIN_POLICY.maxFiresPerSweep) continue;
          firedToday ??= countFired();
          const perCheckinHit = countFired(`checkin:${row.id}`) >= ONE_CHECKIN_POLICY.perCheckinPerDay;
          if (perCheckinHit || firedToday >= ONE_CHECKIN_POLICY.perOnePerDay) {
            // The first cap of the local day is told to the owner once (a skipped notice row is the once-a-day mark; it is never reviewed).
            const day = `${dayStart.getFullYear()}-${dayStart.getMonth() + 1}-${dayStart.getDate()}`;
            if (this.db.prepare(`INSERT OR IGNORE INTO one_supervisor_notices(id,one_id,task_id,origin_chat_id,run_id,state,created_at,review_state,review_reason)
              VALUES(?,?,?,?,?,'skipped',?,'skipped','daily_cap_told')`).run(supervisorHash([oneId,"checkin-cap",day]),oneId,"checkin-cap",chatId,`cap:${day}`,new Date(now).toISOString()).changes === 1) {
              try { onCap?.({checkinId: row.id, scope: perCheckinHit ? "checkin" : "all"}); } catch { /* telling the owner is best effort */ }
            }
            advance(cadence.kind === "daily" ? nextCheckinAt(cadence, nextDay.getTime() - 1) : nextDay.getTime());
            continue;
          }
        }
        const moved = this.db.prepare("UPDATE one_supervisor_checkins SET next_at=?,last_fired_at=?,fires=fires+1 WHERE id=? AND next_at=?").run(next,now,row.id,row.next_at).changes;
        if (moved !== 1) continue;
        const firing = `fire:${row.next_at}`;
        this.db.prepare(`INSERT OR IGNORE INTO one_supervisor_notices(id,one_id,task_id,origin_chat_id,run_id,state,created_at,review_state)
          VALUES(?,?,?,?,?,'scheduled',?,'pending')`).run(supervisorHash([oneId,`checkin:${row.id}`,firing]),oneId,`checkin:${row.id}`,chatId,firing,new Date(now).toISOString());
        fired += 1;
        if (!host) { if (capped) modelFired += 1; if (firedToday !== null) firedToday += 1; }
      }
      return fired;
    }).immediate();
  }
  /** A delegated worker is waiting for the owner (a question). One tells the owner; it does not answer for them. */
  noticeNeedsOwner(oneId: string, taskId: string, chatId: string, waitId: string, detail: string): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO one_supervisor_notices(id,one_id,task_id,origin_chat_id,run_id,state,created_at,review_state,detail)
      VALUES(?,?,?,?,?,'needs-owner',?,'pending',?)`).run(supervisorHash([oneId,taskId,`wait:${waitId}`]),oneId,taskId,chatId,`wait:${waitId}`,new Date().toISOString(),detail.slice(0,2000)).changes === 1;
  }
  /** Results waiting for a review turn, including ones another process queued (a graph delivered by the scheduler). */
  hasPendingReview(oneId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM one_supervisor_notices WHERE one_id=? AND review_state='pending' LIMIT 1").get(oneId);
  }
  noticeDetail(id: string): string | null {
    return (this.db.prepare("SELECT detail FROM one_supervisor_notices WHERE id=?").get(id) as {detail:string|null}|undefined)?.detail ?? null;
  }
  /** Binds up to `limit` unreviewed results to one review run. The run id is the generation: a notice is claimed once,
   * and only that run's settlement may close it, so a late or replayed outcome cannot report it twice (D07). */
  claimReview(oneId: string, reviewRunId: string, limit = 5): SupervisorNotice[] {
    // A review is either check-ins (read-only, no computer use) or finished work (may follow up): the first waiting notice picks the class.
    const first = this.db.prepare("SELECT state FROM one_supervisor_notices WHERE one_id=? AND review_state='pending' ORDER BY rowid LIMIT 1").get(oneId) as {state: string} | undefined;
    const ids = (this.db.prepare("SELECT id FROM one_supervisor_notices WHERE one_id=? AND review_state='pending' AND ((state='scheduled')=?) ORDER BY rowid LIMIT ?")
      .all(oneId, first?.state === "scheduled" ? 1 : 0, first?.state === "scheduled" ? 1 : Math.max(1, Math.min(5, limit))) as Array<{id: string}>).map(row => row.id);
    for (const id of ids) {
      this.db.prepare(`UPDATE one_supervisor_notices SET review_state='claimed',review_run_id=?,review_attempts=review_attempts+1
        WHERE id=? AND review_state='pending'`).run(reviewRunId, id);
    }
    return this.claimedByReview(reviewRunId);
  }
  /** The results this review run holds (claimed and not yet closed). */
  claimedByReview(reviewRunId: string): SupervisorNotice[] {
    return this.db.prepare(`SELECT id,task_id AS taskId,origin_chat_id AS originChatId,run_id AS runId,state,created_at AS createdAt
      FROM one_supervisor_notices WHERE review_run_id=? AND review_state='claimed' ORDER BY rowid`).all(reviewRunId) as SupervisorNotice[];
  }
  /** closeReview, also naming the closed results grouped by One chat (for a close the owner must hear about). */
  closeReviewReporting(reviewRunId: string, reason: string | null): { changes: number; closed: Array<{ originChatId: string; count: number }> } {
    const closed = this.db.prepare(`SELECT origin_chat_id AS originChatId, COUNT(*) AS count FROM one_supervisor_notices
      WHERE review_run_id=? AND review_state='claimed' GROUP BY origin_chat_id`).all(reviewRunId) as Array<{ originChatId: string; count: number }>;
    return { changes: this.closeReview(reviewRunId, reason), closed };
  }
  closeReview(reviewRunId: string, reason: string | null): number {
    return Number(this.db.prepare(`UPDATE one_supervisor_notices SET review_state='reviewed',reviewed_at=?,review_reason=?
      WHERE review_run_id=? AND review_state='claimed'`).run(new Date().toISOString(), reason, reviewRunId).changes);
  }
  /**
   * A review run that produced no report returns its results to the queue. Only a review that STARTED counts as an attempt (it
   * spent a model call); one with the ledger's no-start proof (`started: false`) gives its attempt back, so a refusal or a restart
   * can never use up a result's tries. A result whose third started review failed is not "reviewed": it is "unreviewed" (said so
   * truthfully, still readable in Activity, never retried and never reported as done). review_reason keeps the cause.
   */
  retryReview(reviewRunId: string, reason: string, started = true): number {
    return this.retryReviewReporting(reviewRunId, reason, started).changes;
  }
  /** retryReview, also naming the results this retry left unreviewed for good (their third started attempt), grouped by the One chat. */
  retryReviewReporting(reviewRunId: string, reason: string, started = true): { changes: number; exhausted: Array<{ originChatId: string; count: number }> } {
    if (!started) {
      const changes = Number(this.db.prepare(`UPDATE one_supervisor_notices SET review_state='pending', review_run_id=NULL, reviewed_at=NULL,
          review_attempts=MAX(review_attempts-1,0), review_reason=?
        WHERE review_run_id=? AND review_state='claimed'`).run(reason.slice(0, 240), reviewRunId).changes);
      return { changes, exhausted: [] };
    }
    const exhausted = this.db.prepare(`SELECT origin_chat_id AS originChatId, COUNT(*) AS count FROM one_supervisor_notices
      WHERE review_run_id=? AND review_state='claimed' AND review_attempts>=3 GROUP BY origin_chat_id`).all(reviewRunId) as Array<{ originChatId: string; count: number }>;
    const changes = Number(this.db.prepare(`UPDATE one_supervisor_notices SET
        review_state=CASE WHEN review_attempts<3 THEN 'pending' ELSE 'unreviewed' END,
        review_run_id=CASE WHEN review_attempts<3 THEN NULL ELSE review_run_id END,
        reviewed_at=CASE WHEN review_attempts<3 THEN NULL ELSE ? END, review_reason=?
      WHERE review_run_id=? AND review_state='claimed'`).run(new Date().toISOString(), reason.slice(0, 240), reviewRunId).changes);
    return { changes, exhausted };
  }
  /** The results a review run's last retry left unreviewed (their third started attempt), with the One they belong to. */
  unreviewedByRun(reviewRunId: string): Array<SupervisorNotice & { oneId: string }> {
    return this.db.prepare(`SELECT id,one_id AS oneId,task_id AS taskId,origin_chat_id AS originChatId,run_id AS runId,state,created_at AS createdAt
      FROM one_supervisor_notices WHERE review_run_id=? AND review_state='unreviewed' ORDER BY rowid LIMIT 50`).all(reviewRunId) as Array<SupervisorNotice & { oneId: string }>;
  }
  /** Review runs whose results are claimed but whose review request is no longer alive (a restart between claim and start). */
  orphanClaimedReviewRuns(oneId: string): string[] {
    return (this.db.prepare(`SELECT DISTINCT n.review_run_id AS runId FROM one_supervisor_notices n
      WHERE n.one_id=? AND n.review_state='claimed' AND n.review_run_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM one_supervisor_requests r WHERE r.run_id=n.review_run_id AND r.state IN ('stored','dispatching','accepted','held'))
      LIMIT 50`).all(oneId) as Array<{ runId: string }>).map(row => row.runId);
  }
  notices(oneId: string): SupervisorNotice[] {
    return this.db.prepare("SELECT id,task_id AS taskId,origin_chat_id AS originChatId,run_id AS runId,state,created_at AS createdAt FROM one_supervisor_notices WHERE one_id=? ORDER BY rowid DESC LIMIT 100").all(oneId) as SupervisorNotice[];
  }
}
