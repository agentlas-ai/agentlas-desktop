import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { takeCompanionFrontAdmission } from "./companion-front-admission";
import { seedCompanionWorkHistory } from "./companion-work-history";
import { COMPANION_HANDOFF_PROOF_FIELDS } from "../../shared/companion-handoff-proof";

/** Main/daemon code only: a renderer value cannot select this execution lane. */
export function isCompanionFrontOwnLane(db: Database.Database, runId: string | undefined, chatId: string): boolean {
  if (!runId || !chatId || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_companion_front_turns'").get()) return false;
  return !!db.prepare("SELECT 1 FROM one_companion_front_turns WHERE run_id=? AND chat_id=? AND state IN ('starting','running')").get(runId,chatId);
}

/** An isolated One conversation, created only after native admission. The
 * current user turn is kept separately so the invocation writes it once. */
export function createCompanionFrontInbox(options: {db:Database.Database; createConversation():string; assertOwner():void}) {
  options.db.exec(`CREATE TABLE IF NOT EXISTS one_companion_front_turns (
    command_id TEXT PRIMARY KEY, one_id TEXT NOT NULL, turn_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
    binding_json TEXT NOT NULL, chat_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE,
    user_text TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('stored','starting','running','terminal','held')), host_kind TEXT, terminal_receipt_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS one_companion_front_contexts (
    command_id TEXT PRIMARY KEY, context_json TEXT NOT NULL,
    FOREIGN KEY(command_id) REFERENCES one_companion_front_turns(command_id) ON DELETE CASCADE
  )`);
  function admit(capability: unknown) {
    const verified = takeCompanionFrontAdmission(capability);
    if (!verified) throw new Error("companion_front_admission_invalid");
    return options.db.transaction(() => {
      options.assertOwner(); verified.assertCurrent();
      const {binding,context} = verified;
      const prior = options.db.prepare("SELECT * FROM one_companion_front_turns WHERE command_id=?").get(binding.commandId) as
        {command_id:string;one_id:string;turn_id:string;payload_digest:string;binding_json:string;chat_id:string;run_id:string;state:string} | undefined;
      if (prior) {
        const old = JSON.parse(prior.binding_json) as Record<string, unknown>;
        if (prior.one_id !== binding.oneId || prior.turn_id !== binding.turnId || prior.payload_digest !== binding.payloadDigest ||
            COMPANION_HANDOFF_PROOF_FIELDS.some(key => old[key] !== binding[key])) throw new Error("companion_front_admission_conflict");
        if(context.version===2) {
          const saved=options.db.prepare("SELECT context_json FROM one_companion_front_contexts WHERE command_id=?").get(binding.commandId) as {context_json:string}|undefined;
          if(!saved || saved.context_json!==JSON.stringify(context))throw new Error("companion_front_context_changed");
        }
        verified.assertCurrent(); options.assertOwner();
        return {commandId:prior.command_id,chatId:prior.chat_id,runId:prior.run_id,state:prior.state};
      }
      const chatId = options.createConversation();
      if (!chatId || !options.db.inTransaction) throw new Error("companion_front_conversation_invalid");
      if(options.db.prepare("SELECT 1 FROM chat_messages WHERE chat_id=? LIMIT 1").get(chatId) ||
        (options.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_supervisor_conversations'").get() &&
         options.db.prepare("SELECT 1 FROM one_supervisor_conversations WHERE chat_id=?").get(chatId))) throw new Error("companion_front_conversation_not_isolated");
      const earlier = context.messages.slice(0,-1), user = context.messages.at(-1)!;
      if (earlier.length) seedCompanionWorkHistory(options.db,chatId,{version:1,accountEpoch:context.accountEpoch,
        throughUserSeq:context.throughUserSeq,dropped:0,messages:earlier});
      const runId = randomUUID(), now = new Date().toISOString();
      options.db.prepare(`INSERT INTO one_companion_front_turns(command_id,one_id,turn_id,payload_digest,binding_json,chat_id,run_id,user_text,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'stored',?,?)`).run(binding.commandId,binding.oneId,binding.turnId,binding.payloadDigest,JSON.stringify(binding),chatId,runId,user.text,now,now);
      if(context.version===2) options.db.prepare("INSERT INTO one_companion_front_contexts(command_id,context_json) VALUES(?,?)")
        .run(binding.commandId,JSON.stringify(context));
      verified.assertCurrent(); options.assertOwner();
      return {commandId:binding.commandId,chatId,runId,state:"stored"};
    }).immediate();
  }
  return Object.freeze({admit});
}
