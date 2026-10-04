import type Database from 'better-sqlite3';
import type { SupervisorLegacyHistory } from '../../shared/one-supervisor';

const table=(db:Database.Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * Versioned, non-destructive source mapping. Existing message IDs, attachment rows,
 * events and interrupted attempts stay in their original chat. Model context is not ownership evidence.
 * Old machine-wide chats have no account/oneId column: inventory holds those instead of guessing.
 */
export class OneSupervisorLegacyMigration {
  constructor(private readonly db:Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS one_supervisor_legacy_sources (
      source_chat_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL DEFAULT 1,
      owner_one_id TEXT, owner_evidence_ref TEXT,
      state TEXT NOT NULL CHECK(state IN ('held','linked','excluded')),
      reason TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
      source_updated_at TEXT NOT NULL, inventoried_at TEXT NOT NULL,
      linked_at TEXT
    );`);
  }
  inventory(oneId:string,personalChatId:string,activeChats:ReadonlySet<string>,hasLegacyLineage:boolean):SupervisorLegacyHistory {
    const empty:SupervisorLegacyHistory={schemaVersion:1,linked:[],heldCount:0,scannedCount:0,limitReached:false};
    if(!table(this.db,'installed_agents')||!table(this.db,'one_seats')||!table(this.db,'chat_messages'))return empty;
    const sources=this.db.prepare(`SELECT c.id,c.title,c.kind,c.project_id,c.firm_id,c.goal_id,c.seat_id,c.updated_at,
      s.kind AS seat_kind,s.project_id AS seat_project_id,c.participants_json,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id=c.id) AS message_count
      FROM chats c JOIN installed_agents a ON a.id=c.agent_id LEFT JOIN one_seats s ON s.id=c.seat_id
      WHERE c.origin_surface='one' AND a.slug='agentlas-one' AND c.id<>?
        AND NOT EXISTS(SELECT 1 FROM one_supervisor_conversations p WHERE p.chat_id=c.id)
      ORDER BY c.created_at ASC,c.id ASC LIMIT 501`).all(personalChatId) as Array<{
        id:string;title:string;kind:string|null;project_id:string|null;firm_id:string|null;goal_id:string|null;
        seat_id:string|null;seat_kind:string|null;seat_project_id:string|null;participants_json:string|null;updated_at:string;message_count:number;
      }>;
    const hasTasks=table(this.db,'tasks'),hasGroups=table(this.db,'one_taskforces');
    this.db.transaction(()=>{
      for(const source of sources.slice(0,500)) {
        const prior=this.db.prepare('SELECT schema_version,owner_one_id,owner_evidence_ref,linked_at FROM one_supervisor_legacy_sources WHERE source_chat_id=?').get(source.id) as {schema_version:number;owner_one_id:string|null;owner_evidence_ref:string|null;linked_at:string|null}|undefined;
        if(prior && prior.schema_version!==1)continue;
        let reason='account_ownership_unrecorded',state:'held'|'linked'|'excluded'='held';
        let participants:unknown;try{participants=JSON.parse(source.participants_json ?? '[]');}catch{participants=null;}
        if(source.kind!=='user'||source.project_id||source.firm_id||source.goal_id||source.seat_project_id) {state='excluded';reason='task_or_scoped_conversation';}
        else if(source.seat_kind==='group'||!Array.isArray(participants)||participants.length>1||hasGroups&&this.db.prepare('SELECT 1 FROM one_taskforces WHERE chat_id=?').get(source.id)) {state='excluded';reason='group_conversation';}
        else if(hasTasks&&this.db.prepare('SELECT 1 FROM tasks WHERE origin_chat_id=?').get(source.id)) {state='excluded';reason='owned_task';}
        else if(activeChats.has(source.id)) {reason='active_invocation';}
        else if(prior?.owner_one_id && prior.owner_evidence_ref?.startsWith('account-chat-owner.v1:')) {state='linked';reason='verified_owner_mapping';}
        this.db.prepare(`INSERT INTO one_supervisor_legacy_sources(source_chat_id,state,reason,message_count,source_updated_at,inventoried_at,linked_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_chat_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,
            message_count=excluded.message_count,source_updated_at=excluded.source_updated_at,inventoried_at=excluded.inventoried_at,
            linked_at=CASE WHEN excluded.state='linked' THEN COALESCE(one_supervisor_legacy_sources.linked_at,excluded.linked_at) ELSE one_supervisor_legacy_sources.linked_at END
          WHERE one_supervisor_legacy_sources.state<>excluded.state OR one_supervisor_legacy_sources.reason<>excluded.reason
            OR one_supervisor_legacy_sources.message_count<>excluded.message_count OR one_supervisor_legacy_sources.source_updated_at<>excluded.source_updated_at
            OR excluded.state='linked' AND one_supervisor_legacy_sources.linked_at IS NULL`)
          .run(source.id,state,reason,source.message_count,source.updated_at,new Date().toISOString(),state==='linked'?new Date().toISOString():null);
      }
    })();
    const visible=new Set(sources.slice(0,500).map(source=>source.id));
    const mapped=this.db.prepare(`SELECT c.id AS chatId,c.title,l.message_count AS messageCount
      FROM one_supervisor_legacy_sources l JOIN chats c ON c.id=l.source_chat_id
      WHERE l.schema_version=1 AND l.state='linked' AND l.owner_one_id=? ORDER BY c.created_at,c.id`).all(oneId) as SupervisorLegacyHistory['linked'];
    const held=hasLegacyLineage?this.db.prepare("SELECT source_chat_id FROM one_supervisor_legacy_sources WHERE schema_version=1 AND state='held' AND (owner_one_id IS NULL OR owner_one_id=?)").all(oneId) as Array<{source_chat_id:string}>:[];
    if(!hasLegacyLineage && !mapped.length)return empty;
    return {schemaVersion:1,linked:mapped.filter(source=>visible.has(source.chatId)).map(source=>({...source})),heldCount:held.filter(source=>visible.has(source.source_chat_id)).length,scannedCount:Math.min(sources.length,500),limitReached:sources.length>500};
  }
}
