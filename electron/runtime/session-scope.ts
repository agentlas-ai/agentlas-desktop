// Session scope: which journal, and so which native session, a conversation's turns belong to.
//
// Until this module every conversation owned its own journal (`chat:<chat id>`), so a new conversation with the same
// agent in the same seat opened a new native session and the agent forgot what its newest session had read. Here a
// one-to-one seat conversation takes its journal from the seat and the agent instead: the first turn after an update
// adopts the newest earlier journal of that agent in that seat BY ITS OLD DOMAIN STRING, so the context key, the
// fingerprint seed and the runner owner string stay exactly what that journal's own conversation used (an adopted
// session resumes under the very handle it had). Nothing is moved or deleted; the other journals stay where they are.
//
// A roster member (an agent seated on the One org chart, not archived) is one agent in two places: it works in the team
// dispatches of a group room (child conversations, one per dispatch or reused, each with a journal of its own until now) and
// the owner talks to it one-to-one. Those are ONE session: a dispatch child of a group room whose agent is a roster member
// takes the same journal as the member's one-to-one seat conversations (scope `seat:<the member's solo seat>`), across every
// room the member works in. The first assignment adopts the newest earlier journal of the member among its one-to-one
// conversations AND its dispatch children (the one with a native session handle first, then the most recently written), by its
// old domain string; the rest stay as they are. The message lists stay per conversation; each turn is told where it is spoken
// (the channel, session-channel.ts). The roster switch below can split the rooms from each other.
//
// This file must not import Electron: the background service loads the same code as the window process, and both
// must reach the same answer from the same database (the first assignment is written with INSERT OR IGNORE and
// re-read, so whichever process writes first wins).
//
// Safety switches (meta keys). `session-scope.mode`: `chat` returns the old formula for every conversation; `seat` and
// `full` scope the one-to-one seat conversations and the roster (`full` is reserved for later stages and means `seat` today). A
// missing value is `seat`; any other value is read as `chat`. `session-scope.roster` (only read when the mode is not `chat`):
// `shared` (the default) = one session per seat and member across rooms and the one-to-one conversations; `room` = one session
// per seat, member AND room (a room's dispatch children share their room's session; the one-to-one conversations keep theirs, so
// rooms do not share anything with each other or with the owner's one-to-one talk); `off` (and any other value) = a dispatch child
// keeps its own journal as before and the one-to-one conversations of a member look at their own journals only. A failure while
// resolving returns the old formula for a conversation outside the scoped kinds (it never reads the seat's records). For a seat
// conversation or a roster dispatch child it does NOT: the old formula would open a journal and a native session of its own for that
// turn, the turn would be missing from the shared session, and a conversation that already took a turn in the shared journal would
// never bring it in afterwards. The answer then says `unavailable` and the caller refuses the turn in plain words (a failure here is a
// busy or unreadable store, which the next try usually clears; `session-scope.mode` = `chat` is the way out when it does not). An
// assignment record that cannot be read is not a failure: it is rewritten (see resolveAssignment).
import type Database from "better-sqlite3";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";

export type SessionScopeMode = "chat" | "seat" | "full";
export const SESSION_SCOPE_MODE_KEY = "session-scope.mode";
export const DEFAULT_SESSION_SCOPE_MODE: SessionScopeMode = "seat";
const ACTOR_KEY_PREFIX = "session-scope.actor:";
/** The assignment record keeps the other candidates for diagnostics only; a seat never has this many journals of one agent. */
const MAX_RETAINED = 256;

export interface SessionScopeInput {
  chatId: string;
  agentId: string;
  /** The conversation's kind and parent as the caller read them: the old formula is computed from these, whatever fails here. */
  kind: string | null;
  parentChatId: string | null;
  /** The alive controller's own domain; never scoped. */
  aliveController: boolean;
  /** The account/install part of the journal identity: assignments are made per owner scope. */
  ownerScope: string;
  /** The conversation's row as the caller already read it: with it a failure while resolving still knows whether the conversation is a seat conversation. */
  chat?: { agentId: string | null; kind: string | null; origin: string | null; seatId: string | null; seatKind: string | null };
  /**
   * true: the first assignment is stored (turn admission). false: the same answer is computed without writing
   * (recall of memory for a turn that has not been admitted yet) — until a record exists it names the domain the
   * admission will store, unless another process stored a different one in between.
   */
  persist: boolean;
  /** A current host already bound a working range; transient reads must never split its journal. */
  workingScopeRequired?: boolean;
}

/** legacy: the conversation's own journal; seat: a one-to-one seat conversation; roster: a roster member's dispatch child in a group room. */
export type SessionScopeKind = "legacy" | "seat" | "roster" | "work" | "taskforce";
const WORK_SCOPE_PREFIX = "session-scope.work:";
const WORK_TASK_ROOT_PREFIX = "session-scope.work-task-root:";
export interface WorkingSessionScope {
  projectId: string;
  subSessionId: string | null;
  /** v3 Desktop Work: one main journal per real conversation; project assets remain shared. */
  rootChatId?: string;
}
const scopeIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const WORK_SCOPE_REQUIRED_PREFIX = "session-scope.work-required:";
export type ManagedWorkingProvenance = {kind:"desktop-project"}|{kind:"external-logical";logicalId:string};
type ManagedTransport = {projectId:string|null;firmId:string|null;kind:string|null;parentChatId:string|null;origin:string|null;title?:string};
interface ManagedWorkingWitness {schema:"agentlas.managed-working-transport.v1";provenance:ManagedWorkingProvenance;transport:ManagedTransport}
interface WorkingRegistration {scope:WorkingSessionScope;raw:string;witness:ManagedWorkingWitness|null}
function workingRegistration(db:Pick<Database.Database,"prepare">,chatId:string):WorkingRegistration|null {
  let raw:string|undefined,required:string|undefined;
  try { raw=(db.prepare("SELECT value FROM meta WHERE key=?").get(WORK_SCOPE_PREFIX+chatId) as {value:string}|undefined)?.value;
    required=(db.prepare("SELECT value FROM meta WHERE key=?").get(WORK_SCOPE_REQUIRED_PREFIX+chatId) as {value:string}|undefined)?.value;
  } catch(error) { if(raw===undefined)throw error; throw new Error("session_scope_work_binding_read_failed",{cause:error}); }
  if(raw===undefined){if(required!==undefined)throw new Error("session_scope_work_binding_required");return null;}
  let value:{v?:unknown;projectId?:unknown;subSessionId?:unknown;rootChatId?:unknown;hostWitness?:ManagedWorkingWitness};
  try{value=JSON.parse(raw);}catch{throw new Error("session_scope_work_binding_invalid");}
  if(!value || (value.v!==1&&value.v!==2&&value.v!==3) || !scopeIdentifier(value.projectId)
    || (value.subSessionId!==null&&!scopeIdentifier(value.subSessionId)))throw new Error("session_scope_work_binding_invalid");
  if(value.v===1){if(required!==undefined)throw new Error("session_scope_work_binding_downgraded");return {scope:{projectId:value.projectId,subSessionId:value.subSessionId},raw,witness:null};}
  const w=value.hostWitness;
  if(required!==raw || !w || w.schema!=="agentlas.managed-working-transport.v1"
    || !w.provenance || !["desktop-project","external-logical"].includes(w.provenance.kind)
    || (w.provenance.kind==="external-logical"&&!scopeIdentifier(w.provenance.logicalId))
    || !w.transport || typeof w.transport!=="object")throw new Error("session_scope_work_binding_invalid");
  const legacyScope:WorkingSessionScope={projectId:value.projectId,subSessionId:value.subSessionId};
  if(value.v===3 && (w.provenance.kind!=="desktop-project" || !scopeIdentifier(value.rootChatId)))throw new Error("session_scope_work_binding_invalid");
  // Read-only normalization: the existing registration is upgraded only at admission.
  const scope=w.provenance.kind==="desktop-project"?desktopWorkingScope(db,chatId,legacyScope):legacyScope;
  if(value.v===3 && (scope.rootChatId!==value.rootChatId || scope.subSessionId!==value.subSessionId))throw new Error("session_scope_work_binding_changed");
  return {scope,raw,witness:w};
}
function setWorkingRoot(db:Pick<Database.Database,"prepare">,scope:WorkingSessionScope):void {
  if(scope.rootChatId){
    db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(`${WORK_TASK_ROOT_PREFIX}${scope.projectId}:conversation:${scope.rootChatId}`,scope.rootChatId);
    return;
  }
  const key=WORK_TASK_ROOT_PREFIX+scope.projectId;
  if(!db.prepare("SELECT value FROM meta WHERE key=?").get(key)){
    const root=registeredWorkingMainChatId(db,scope.projectId);if(root)db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(key,root);
  }
}
/** Existing generic external-host v1 contract: no Desktop row schema or provenance inference. */
export function bindWorkingSessionScope(db:Pick<Database.Database,"prepare">,chatId:string,scope:WorkingSessionScope):void {
  if(!scopeIdentifier(chatId)||!scopeIdentifier(scope.projectId)||(scope.subSessionId!==null&&!scopeIdentifier(scope.subSessionId)))throw new Error("session_scope_work_identity_invalid");
  const prior=workingRegistration(db,chatId);
  if(prior?.witness){assertWorkingSessionBindingCurrent(db,{chatId,agentId:managedTransport(db,chatId,prior.witness.provenance).agentId,scope,registration:prior.raw});return;}
  const value=JSON.stringify({v:1,projectId:scope.projectId,subSessionId:scope.subSessionId});
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(WORK_SCOPE_PREFIX+chatId,value);
  if((db.prepare("SELECT value FROM meta WHERE key=?").get(WORK_SCOPE_PREFIX+chatId) as {value:string}|undefined)?.value!==value)throw new Error("session_scope_work_binding_changed");
  setWorkingRoot(db,scope);
}
function managedTransport(db:Pick<Database.Database,"prepare">,chatId:string,provenance:ManagedWorkingProvenance):{agentId:string;facts:ManagedTransport} {
  const row=db.prepare("SELECT id,title,project_id,firm_id,kind,parent_chat_id,origin_surface,archived_at,agent_id FROM chats WHERE id=?").get(chatId) as
    {id:string;title:string;project_id:string|null;firm_id:string|null;kind:string|null;parent_chat_id:string|null;origin_surface:string|null;archived_at:string|null;agent_id:string}|undefined;
  if(!row||row.archived_at||(typeof row.agent_id!=="string"||!row.agent_id.trim()))throw new Error("session_scope_work_binding_changed");
  return {agentId:row.agent_id,facts:{projectId:row.project_id,firmId:row.firm_id,kind:row.kind,parentChatId:row.parent_chat_id,origin:row.origin_surface,...(provenance.kind==="external-logical"?{title:row.title}:{})}};
}
/** Resolve only real Work ancestry. A project peer or hidden standalone ledger is never a parent. */
function desktopWorkingScope(db:Pick<Database.Database,"prepare">,chatId:string,scope:WorkingSessionScope):WorkingSessionScope {
  const seen=new Set<string>();let id=chatId;let child=false;
  for(;;){
    if(seen.has(id)||seen.size>=64)throw new Error("session_scope_work_binding_changed");seen.add(id);
    const row=db.prepare("SELECT project_id,origin_surface,kind,parent_chat_id,archived_at FROM chats WHERE id=?").get(id) as
      {project_id:string|null;origin_surface:string|null;kind:string|null;parent_chat_id:string|null;archived_at:string|null}|undefined;
    if(!row||row.archived_at||row.project_id!==scope.projectId||row.origin_surface!=="work")throw new Error("session_scope_work_binding_changed");
    if(row.kind!=="division"){
      if((row.kind!=="user"&&row.kind!==null)||row.parent_chat_id)throw new Error("session_scope_work_binding_changed");
      if(scope.rootChatId&&scope.rootChatId!==id)throw new Error("session_scope_work_binding_changed");
      return {projectId:scope.projectId,rootChatId:id,subSessionId:child?chatId:null};
    }
    if(!row.parent_chat_id)throw new Error("session_scope_work_binding_changed");
    child=true;id=row.parent_chat_id;
  }
}
/** Called only by the existing trusted host creators/admission. No renderer or model registration API. */
export function bindManagedWorkingSessionScope(db:Pick<Database.Database,"prepare"|"transaction">,chatId:string,scope:WorkingSessionScope,provenance:ManagedWorkingProvenance):void {
  if(!scopeIdentifier(chatId)||!scopeIdentifier(scope.projectId)||(scope.subSessionId!==null&&!scopeIdentifier(scope.subSessionId))
    || !provenance || !["desktop-project","external-logical"].includes(provenance.kind)
    || (provenance.kind==="external-logical"&&!scopeIdentifier(provenance.logicalId)))throw new Error("session_scope_work_identity_invalid");
  db.transaction(()=>{
    if(provenance.kind==="desktop-project")scope=desktopWorkingScope(db,chatId,scope);
    const prior=workingRegistration(db,chatId);
    if(prior && (prior.scope.projectId!==scope.projectId||prior.scope.subSessionId!==scope.subSessionId||prior.scope.rootChatId!==scope.rootChatId))throw new Error("session_scope_work_binding_changed");
    if(prior?.witness){
      if(JSON.stringify(prior.witness.provenance)!==JSON.stringify(provenance))throw new Error("session_scope_work_binding_changed");
      assertWorkingSessionBindingCurrent(db,{chatId,agentId:managedTransport(db,chatId,prior.witness.provenance).agentId,scope,registration:prior.raw});
      if(provenance.kind!=="desktop-project"||JSON.parse(prior.raw).v===3)return;
    }
    const live=managedTransport(db,chatId,provenance),transport=live.facts;
    if(provenance.kind==="desktop-project" && (transport.projectId!==scope.projectId||transport.origin!=="work"
      || !db.prepare("SELECT id FROM projects WHERE id=?").get(scope.projectId)))throw new Error("session_scope_work_binding_changed");
    const value=JSON.stringify({v:scope.rootChatId?3:2,projectId:scope.projectId,subSessionId:scope.subSessionId,
      ...(scope.rootChatId?{rootChatId:scope.rootChatId}:{}),hostWitness:{schema:"agentlas.managed-working-transport.v1",provenance,transport}});
    if(prior){if(db.prepare("UPDATE meta SET value=? WHERE key=? AND value=?").run(value,WORK_SCOPE_PREFIX+chatId,prior.raw).changes!==1)throw new Error("session_scope_work_binding_changed");}
    else db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(WORK_SCOPE_PREFIX+chatId,value);
    db.prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(WORK_SCOPE_REQUIRED_PREFIX+chatId,value);
    assertWorkingSessionBindingCurrent(db,{chatId,agentId:live.agentId,scope,registration:value});setWorkingRoot(db,scope);
  }).immediate();
}
/** Inherit only the actual parent's host-authored registration; public callers cannot select a provenance. */
export function inheritWorkingSessionScope(db:Pick<Database.Database,"prepare"|"transaction">,childId:string,parentId:string):void {
  db.transaction(()=>{
    const parent=workingRegistration(db,parentId);if(!parent)return;
    const child=db.prepare("SELECT kind,parent_chat_id FROM chats WHERE id=?").get(childId) as {kind:string;parent_chat_id:string|null}|undefined;
    if(!child||child.kind!=="division"||child.parent_chat_id!==parentId)throw new Error("work_project_session_child_mismatch");
    const scope={projectId:parent.scope.projectId,subSessionId:childId,...(parent.scope.rootChatId?{rootChatId:parent.scope.rootChatId}:{})};
    if(parent.witness){
      assertWorkingSessionBindingCurrent(db,{chatId:parentId,agentId:managedTransport(db,parentId,parent.witness.provenance).agentId,scope:parent.scope,registration:parent.raw});
      bindManagedWorkingSessionScope(db,childId,scope,parent.witness.provenance);
    }else bindWorkingSessionScope(db,childId,scope);
  }).immediate();
}
export function workingSessionScope(db:Pick<Database.Database,"prepare">,chatId:string):WorkingSessionScope|null{return workingRegistration(db,chatId)?.scope??null;}
/** Canonical registration and adopted journal visibility are deliberately distinct. */
export interface WorkingSessionBinding {readonly chatId:string;readonly agentId:string;readonly scope:Readonly<WorkingSessionScope>;readonly registration?:string}
export function assertWorkingSessionBindingCurrent(db:Pick<Database.Database,"prepare">,expected:WorkingSessionBinding):void {
  try{
    const current=workingRegistration(db,expected.chatId);
    if(!current||current.scope.projectId!==expected.scope.projectId||current.scope.subSessionId!==expected.scope.subSessionId||current.scope.rootChatId!==expected.scope.rootChatId
      || (expected.registration!==undefined&&current.raw!==expected.registration))throw new Error("session_scope_work_binding_changed");
    if(!current.witness)return; // Legacy v1 external registration keeps its original prepare-only/minimal-schema contract.
    const live=managedTransport(db,expected.chatId,current.witness.provenance);
    if(live.agentId!==expected.agentId||JSON.stringify(live.facts)!==JSON.stringify(current.witness.transport)
      || (current.witness.provenance.kind==="desktop-project" && (live.facts.projectId!==current.scope.projectId
        || !db.prepare("SELECT id FROM projects WHERE id=?").get(current.scope.projectId))))throw new Error("session_scope_work_binding_changed");
  }catch(error){if(error instanceof Error&&error.message.startsWith("session_scope_work_binding_"))throw error;throw new Error("session_scope_work_binding_read_failed",{cause:error});}
}
/** Host facts for ordinary Desktop Work. No renderer DTO or read-side write can
 * register a project range. Internal Science transports have no desktop project
 * and continue through their existing explicit registration. */
export interface ProjectWorkSessionFacts {
  chatId: string; agentId: string; rootChatId: string; taskId: string;
  projectId: string; scope: WorkingSessionScope;
  rows: readonly { id: string; agent: string; kind: string | null; parent: string | null }[];
}
export function projectWorkSessionFacts(db: Pick<Database.Database, "prepare">,
  input: Pick<SessionScopeInput, "chatId" | "agentId"> & Partial<Pick<SessionScopeInput,"chat">>): ProjectWorkSessionFacts | null {
  type Row = { id: string; agent_id: string; project_id: string | null; origin_surface: string | null;
    kind: string | null; parent_chat_id: string | null; archived_at: string | null };
  const read = (id: string) => db.prepare("SELECT id,agent_id,project_id,origin_surface,kind,parent_chat_id,archived_at FROM chats WHERE id=?").get(id) as Row | undefined;
  let first: Row | undefined;
  try { first = read(input.chatId); } catch (error) {
    throw new Error("session_scope_project_work_read_failed", {cause:error});
  }
  if (!first || first.origin_surface !== "work" || !first.project_id) return null;
  // Standalone background ledgers have their own automation/App contract;
  // only actual user roots and exact-parent dispatch are project Work.
  if (first.kind === "division" && !first.parent_chat_id) return null;
  try {
  const reject = (): never => { throw new Error("session_scope_project_work_authority_changed"); };
  if (first.agent_id !== input.agentId || first.archived_at || !scopeIdentifier(first.project_id)
    || !db.prepare("SELECT id FROM projects WHERE id=?").get(first.project_id)
    || !db.prepare("SELECT id FROM installed_agents WHERE id=?").get(first.agent_id)) return reject();
  const rows: { id: string; agent: string; kind: string | null; parent: string | null }[] = [];
  const seen = new Set<string>(); let row = first;
  for (;;) {
    if (seen.has(row.id) || rows.length >= 64 || row.archived_at || row.origin_surface !== "work"
      || row.project_id !== first.project_id) return reject();
    seen.add(row.id); rows.push({ id: row.id, agent: row.agent_id, kind: row.kind, parent: row.parent_chat_id });
    if (row.kind !== "division") { if (row.kind !== "user" && row.kind !== null) return reject(); break; }
    if (!row.parent_chat_id) return reject();
    const parent = read(row.parent_chat_id); if (!parent) return reject(); row = parent;
  }
  const task = db.prepare("SELECT id,project_id,origin_chat_id,archived_at,status FROM tasks WHERE id=?").get(`task_${row.id}`) as
    { id: string; project_id: string | null; origin_chat_id: string | null; archived_at: string | null; status: string } | undefined;
  if (!task || task.origin_chat_id !== row.id || task.project_id !== first.project_id || task.archived_at || task.status === "archived") return reject();
  const registered = workingSessionScope(db, input.chatId);
  if (registered && registered.projectId !== first.project_id) return reject();
  return { chatId: first.id, agentId: first.agent_id, rootChatId: row.id, taskId: task.id, projectId: first.project_id,
    scope: registered ?? { projectId: first.project_id, rootChatId: row.id, subSessionId: first.kind === "division" ? first.id : null }, rows };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("session_scope_project_work_")) throw error;
    throw new Error("session_scope_project_work_read_failed", {cause:error});
  }
}
export function assertProjectWorkSessionFacts(db: Pick<Database.Database, "prepare">, facts: ProjectWorkSessionFacts): void {
  const current = projectWorkSessionFacts(db, facts);
  if (!current || JSON.stringify(current) !== JSON.stringify(facts)) throw new Error("session_scope_project_work_authority_changed");
}
/** Existing legacy journals are eligible only through the same live host facts
 * used for this turn. Preview and admission use the same candidate set. */
function projectWorkCandidateDomains(db: Pick<Database.Database, "prepare">, input: SessionScopeInput, facts: ProjectWorkSessionFacts): string[] {
  // A rooted conversation can adopt only its own former transport journal.
  // Do not inspect unrelated project peers: their stale custody cannot refuse this turn.
  if(facts.scope.rootChatId){const row=facts.rows[0];return [legacyVisibilityDomain({chatId:row.id,kind:row.kind,parentChatId:row.parent},false)];}
  const candidates = db.prepare("SELECT id FROM chats WHERE agent_id=? AND project_id=? AND origin_surface='work' AND archived_at IS NULL").all(input.agentId, facts.projectId) as { id: string }[];
  const domains: string[] = [];
  for (const candidate of candidates) {
    let other: ProjectWorkSessionFacts | null;
    try { other = projectWorkSessionFacts(db, { chatId: candidate.id, agentId: input.agentId }); }
    catch (error) {
      if (sessionScopeFailureCause(error) === "session_scope_project_work_authority_changed") continue;
      throw error;
    }
    if (!other || other.scope.projectId !== facts.scope.projectId || other.scope.rootChatId !== facts.scope.rootChatId || other.scope.subSessionId !== facts.scope.subSessionId) continue;
    const row = other.rows[0]; domains.push(legacyVisibilityDomain({chatId: row.id, kind: row.kind, parentChatId: row.parent}, false));
  }
  return domains;
}

/** The canonical Task for a registered working range anchors to its oldest
 * real main transport row. Helpers share that Task without becoming user chats.
 * This uses the same host-owned registration as session admission/recall. */
function registeredWorkingMainChatId(db: Pick<Database.Database, "prepare">, projectId: string): string | null {
  return (db.prepare(`SELECT c.id FROM chats c JOIN meta m ON m.key = ? || c.id
    WHERE json_valid(m.value) AND json_extract(m.value,'$.v') IN (1,2)
      AND json_extract(m.value,'$.projectId') = ? AND json_type(m.value,'$.subSessionId') = 'null'
    ORDER BY c.rowid,c.id LIMIT 1`).get(WORK_SCOPE_PREFIX, projectId) as { id: string } | undefined)?.id ?? null;
}
export function workingTaskRootChatId(db: Pick<Database.Database, "prepare">, chatId: string): string | null {
  try {
    const scope = workingSessionScope(db, chatId);
    if (!scope) return null;
    if(scope.rootChatId){
      // An old exact parent may not have admitted its first scoped turn yet.
      // Ancestry is observed here; this lookup never creates its registration.
      desktopWorkingScope(db,scope.rootChatId,{projectId:scope.projectId,rootChatId:scope.rootChatId,subSessionId:null});
      const root=workingSessionScope(db,scope.rootChatId);
      return !root||(root.projectId===scope.projectId&&root.rootChatId===scope.rootChatId&&root.subSessionId===null)?scope.rootChatId:null;
    }
    const anchor = (db.prepare("SELECT value FROM meta WHERE key=?").get(WORK_TASK_ROOT_PREFIX + scope.projectId) as { value: string } | undefined)?.value;
    // Deleting an anchor cannot transfer old files or Task custody to another
    // conversation. Registration writes it once; reads never repair/retarget it.
    if (!anchor || !db.prepare("SELECT id FROM chats WHERE id=?").get(anchor)) return null;
    const registered = workingSessionScope(db, anchor);
    return registered?.projectId === scope.projectId && registered.subSessionId === null ? anchor : null;
  } catch { return null; }
}

const TF_SCOPE_PREFIX = "session-scope.taskforce:";
const TF_SCOPE_REQUIRED_PREFIX = "session-scope.taskforce-required:";
export interface OneTaskforceSessionScope { taskforceId: string; rootChatId: string; seatId: string; actorOccupancy?: { slot:number; since:string } }
const taskforceDomain = (scope: OneTaskforceSessionScope) => `taskforce:${scope.taskforceId}:seat:${scope.seatId}`;
function taskforceFromRoot(db: Pick<Database.Database,"prepare">, rootChatId: string): OneTaskforceSessionScope | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='one_taskforces'").get()) return null;
  const row = db.prepare(`SELECT tf.id AS taskforce_id,c.id AS root_chat_id,c.kind,c.parent_chat_id,c.origin_surface,
    c.seat_id,c.seat_kind,s.kind AS actual_seat_kind,s.dissolved_at,c.archived_at
    FROM one_taskforces tf JOIN chats c ON c.id=tf.chat_id LEFT JOIN one_seats s ON s.id=c.seat_id WHERE tf.chat_id=?`).get(rootChatId) as
    {taskforce_id:string;root_chat_id:string;kind:string|null;parent_chat_id:string|null;origin_surface:string|null;seat_id:string|null;seat_kind:string|null;actual_seat_kind:string|null;dissolved_at:string|null;archived_at:string|null}|undefined;
  if (!row) return null;
  if (!scopeIdentifier(row.taskforce_id) || row.root_chat_id!==rootChatId || row.origin_surface!=="one" || row.parent_chat_id!==null
    || (row.kind!=="user" && row.kind!==null) || row.seat_id!==`seat_tf_${row.taskforce_id}` || row.seat_kind!=="group"
    || row.actual_seat_kind!=="group" || row.dissolved_at!==null || row.archived_at!==null) throw new Error("session_scope_taskforce_binding_invalid");
  return {taskforceId:row.taskforce_id,rootChatId,seatId:row.seat_id};
}
/** Called only after the canonical TF/seat producer transaction or before its actual dispatch. */
export function bindOneTaskforceSessionScope(db: Database.Database, rootChatId: string): OneTaskforceSessionScope | null {
  return db.transaction(()=>{
    const scope=taskforceFromRoot(db,rootChatId);if(!scope)return null;
    const key=TF_SCOPE_PREFIX+rootChatId,requiredKey=TF_SCOPE_REQUIRED_PREFIX+rootChatId,value=JSON.stringify({v:1,...scope});
    const read=(name:string)=>(db.prepare("SELECT value FROM meta WHERE key=?").get(name) as {value:string}|undefined)?.value;
    const raw=read(key),required=read(requiredKey);
    if(raw!==undefined||required!==undefined){if(raw!==value||required!==value)throw new Error("session_scope_taskforce_binding_changed");return scope;}
    db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(key,value);
    db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run(requiredKey,value);
    if(read(key)!==value||read(requiredKey)!==value)throw new Error("session_scope_taskforce_binding_changed");
    return scope;
  }).immediate();
}
function registeredTaskforceScope(db: Pick<Database.Database,"prepare">, rootChatId:string):OneTaskforceSessionScope|null {
  const read=(prefix:string)=>(db.prepare("SELECT value FROM meta WHERE key=?").get(prefix+rootChatId) as {value:string}|undefined)?.value;
  const raw=read(TF_SCOPE_PREFIX),required=read(TF_SCOPE_REQUIRED_PREFIX);
  // Existing TF rows are not themselves a new scope opt-in. Read-only callers
  // retain their old roster session until an actual host producer registers it.
  if(raw===undefined&&required===undefined)return null;
  if(raw===undefined||required===undefined)throw new Error("session_scope_taskforce_binding_required");
  const current=taskforceFromRoot(db,rootChatId);if(!current)throw new Error("session_scope_taskforce_binding_changed");
  let value:{v?:unknown;taskforceId?:unknown;rootChatId?:unknown;seatId?:unknown};try{value=JSON.parse(raw);}catch{throw new Error("session_scope_taskforce_binding_invalid");}
  if(!value||value.v!==1||value.taskforceId!==current.taskforceId||value.rootChatId!==current.rootChatId||value.seatId!==current.seatId
    || Object.keys(value).sort().join()!=="rootChatId,seatId,taskforceId,v" || required!==raw)throw new Error("session_scope_taskforce_binding_changed");
  return current;
}
export function taskforceSessionScopeIsCurrent(db:Pick<Database.Database,"prepare">,scope:OneTaskforceSessionScope,agentId:string):boolean {
  try{const current=registeredTaskforceScope(db,scope.rootChatId);if(!current||current.taskforceId!==scope.taskforceId||current.rootChatId!==scope.rootChatId||current.seatId!==scope.seatId||agentId===BUILTIN_ONE_AGENT_ID||!isRosterMember(db,agentId))return false;
    const row=db.prepare("SELECT member_agent_ids_json FROM one_taskforces WHERE id=? AND chat_id=?").get(scope.taskforceId,scope.rootChatId) as {member_agent_ids_json:string}|undefined;
    const members:unknown=row?JSON.parse(row.member_agent_ids_json):null;
    if(!Array.isArray(members)||!members.includes(agentId))return false;
    const occupants=db.prepare("SELECT slot,since FROM one_seat_occupants WHERE seat_id=? AND agent_id=? AND until IS NULL").all(scope.seatId,agentId) as Array<{slot:number;since:string}>;
    if(occupants.length!==1)return false;
    return scope.actorOccupancy===undefined || (scope.actorOccupancy.slot===occupants[0].slot&&scope.actorOccupancy.since===occupants[0].since);
  }catch{return false;}
}
function taskforceScopeForChat(db:Pick<Database.Database,"prepare">,input:{chatId:string;agentId:string;kind:string|null;parentChatId:string|null}):OneTaskforceSessionScope|null {
  if(input.agentId===BUILTIN_ONE_AGENT_ID)return null;
  const scope=registeredTaskforceScope(db,input.kind==="division"&&input.parentChatId?input.parentChatId:input.chatId);if(!scope)return null;
  if(!taskforceSessionScopeIsCurrent(db,scope,input.agentId))throw new Error("session_scope_taskforce_actor_changed");
  return scope;
}
function resolveTaskforce(db:Database.Database,input:SessionScopeInput,mode:SessionScopeMode,row:ChatRow,channel:SessionChannel):ResolvedSessionScope|null {
  if(rosterScopeMode(db)==="off"||isolatedChild(db,input.chatId)||input.agentId===BUILTIN_ONE_AGENT_ID)return null;
  if(row.agent_id!==input.agentId||row.origin_surface!=="one")return null;
  const scope=taskforceScopeForChat(db,{...input,parentChatId:row.parent_chat_id});if(!scope)return null;
  const domain=taskforceDomain(scope),raw=(db.prepare("SELECT value FROM meta WHERE key=?").get(sessionScopeActorMetaKey(input.ownerScope,domain,`agent:${input.agentId}`)) as {value:string}|undefined)?.value;
  // TF scopes never salvage/adopt a global/foreign native owner. Old journals remain untouched.
  if(raw!==undefined && parseAssignment(raw)?.domain!==domain)throw new Error("session_scope_taskforce_assignment_invalid");
  const witness=db.prepare("SELECT slot,since FROM one_seat_occupants WHERE seat_id=? AND agent_id=? AND until IS NULL").get(scope.seatId,input.agentId) as {slot:number;since:string}|undefined;
  if(!witness)throw new Error("session_scope_taskforce_actor_changed");
  return {...resolveAssignment(db,input,mode,{kind:"taskforce",scopeId:domain,actorKey:`agent:${input.agentId}`,seat:null,candidates:()=>[]},channel),taskforce:{...scope,actorOccupancy:{slot:witness.slot,since:witness.since}}};
}

const workDomain = (scope: WorkingSessionScope) => `work:${scope.projectId}${scope.rootChatId ? `:conversation:${scope.rootChatId}` : ""}:main${scope.subSessionId ? `:subsession:${scope.subSessionId}` : ""}`;
/**
 * Where a conversation's turns are spoken: with the owner alone (`direct`), in a group room (`room`: the room's own
 * conversation), as a child task dispatched from another conversation (`dispatch`: a room's teammate, or a Work stage), or
 * somewhere that has no human audience (`other`: the alive controller, an unknown kind). A label of the conversation, read from
 * its row: it changes neither the journal's domain nor who shares it.
 */
export type SessionChannelKind = "direct" | "room" | "dispatch" | "other";
export interface SessionChannel {
  kind: SessionChannelKind;
  /** The group room this conversation is (`room`) or was dispatched from (`dispatch` whose parent is a room); else null. */
  roomChatId: string | null;
  /** The room's title as the owner sees it (one line, bounded); null when there is none or this is not a room channel. */
  roomTitle: string | null;
}
export interface SessionScopeAssignment {
  /** adopted: an earlier journal of this agent in this seat continues; fresh: none existed; existing: stored before; healed: the stored record was unreadable and was rewritten. */
  outcome: "adopted" | "fresh" | "existing" | "healed";
  /** `chat:<id>` the assignment adopted, if it did. */
  fromDomain: string | null;
  /** Other journals of this agent in this seat that stay as they are. */
  retainedDomains: readonly string[];
  /** This call stored the record (the caller reports it once). */
  created: boolean;
}
export interface ResolvedSessionScope {
  kind: SessionScopeKind;
  mode: SessionScopeMode;
  visibilityDomain: string;
  /** Several conversations of one seat and agent use this journal: their turns run one after the other. */
  shared: boolean;
  scopeId: string | null;
  actorKey: string | null;
  /** The seat columns of the conversation this answer depends on; a later change of them is a changed scope. Null for a roster dispatch child: it keeps the group seat of its room, the member's own seat is not one of its columns. */
  seat: { seatId: string; seatKind: string } | null;
  assignment: SessionScopeAssignment | null;
  /** The old formula was returned because resolving failed (never because of the switch). */
  fallback: "error" | null;
  /** Resolving failed for a seat conversation: the old formula must not be used for its turn; the caller refuses it. */
  unavailable: boolean;
  /** The machine cause of that failure (a SQLite code, or this module's own). */
  failure: { causeCode: string } | null;
  /** Where this conversation speaks (a label; see SessionChannel). Shared sessions tell the agent; every other conversation is unchanged. */
  channel: SessionChannel;
  /** Host-registered TF range; absent for every legacy/working/supervisor scope. */
  taskforce?: OneTaskforceSessionScope;
  projectWork?: ProjectWorkSessionFacts;
  workBinding?: WorkingSessionBinding;
}

/**
 * The domain every conversation had before scopes existed, byte for byte. The two places that derived it
 * (agent-context-admission.ts and memory/context-generation.ts) now call this through the resolver.
 */
export function legacyVisibilityDomain(row: { chatId: string; kind: string | null; parentChatId: string | null }, aliveController: boolean): string {
  return aliveController ? `alive-controller:${row.chatId}`
    : row.kind === "division" && row.parentChatId ? `one-team:${row.parentChatId}:session:${row.chatId}` : `chat:${row.chatId}`;
}

type ChatRow = { agent_id: string | null; kind: string | null; parent_chat_id: string | null; origin_surface: string | null; seat_id: string | null; seat_kind: string | null };

export function sessionScopeMode(db: Pick<Database.Database, "prepare">): SessionScopeMode {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(SESSION_SCOPE_MODE_KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_SESSION_SCOPE_MODE;
  const value = String(row.value).trim().toLowerCase();
  return value === "seat" || value === "full" ? value : "chat";
}

export type RosterScopeMode = "shared" | "room" | "off";
export const ROSTER_SCOPE_KEY = "session-scope.roster";
export const DEFAULT_ROSTER_SCOPE_MODE: RosterScopeMode = "shared";
/** How roster members' dispatch children are scoped (see the header). A missing value is the default; any other value than `shared`/`room` is `off`. */
export function rosterScopeMode(db: Pick<Database.Database, "prepare">): RosterScopeMode {
  const row = db.prepare("SELECT value FROM meta WHERE key=?").get(ROSTER_SCOPE_KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_ROSTER_SCOPE_MODE;
  const value = String(row.value).trim().toLowerCase();
  return value === "shared" || value === "room" ? value : "off";
}

/** The conversations whose one-to-one journals a seat's agent may continue: user conversations of that solo seat. */
const SEAT_CHAT_PREDICATE = "c.seat_id=? AND c.seat_kind='solo' AND c.kind='user' AND c.origin_surface='one'";

const MAX_ROOM_TITLE_CHARS = 80;
const otherChannel = (): SessionChannel => ({ kind: "other", roomChatId: null, roomTitle: null });
/** A conversation title as one bounded line: it is owner-written text that ends up in a prompt line, so no control characters or line breaks. */
function oneLineTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, MAX_ROOM_TITLE_CHARS).join("") : null;
}
type ChannelRow = { kind: string | null; parent_chat_id: string | null; origin_surface: string | null; seat_kind: string | null; title: string | null };
const isGroupRoom = (row: ChannelRow): boolean => row.origin_surface === "one" && row.seat_kind === "group" && !row.parent_chat_id && (row.kind === "user" || row.kind === null);

/**
 * Where the turns of one conversation are spoken, read from its row (never from a title, a message or a model): a group room
 * (One surface, group seat, no parent) is `room`; a child with a parent is `dispatch` (naming the room when the parent is one);
 * any other user conversation is `direct`; the alive controller and anything unrecognised are `other`. A label only: it is
 * computed beside the journal's domain and changes neither it nor any adoption. A failure answers `other`, which tells no
 * agent anything.
 */
export function deriveSessionChannel(db: Pick<Database.Database, "prepare">, chatId: string, aliveController: boolean): SessionChannel {
  if (aliveController) return otherChannel();
  try {
    const work = workingSessionScope(db, chatId);
    const read = (id: string): ChannelRow | undefined => db.prepare("SELECT kind,parent_chat_id,origin_surface,seat_kind,title FROM chats WHERE id=?").get(id) as ChannelRow | undefined;
    if (work) {
      // An owner's explicit New is a user subsession; subsession is not a dispatch role.
      const row = work.subSessionId ? read(chatId) : undefined;
      return { kind: !work.subSessionId || row?.kind === "user" || row?.kind === null ? "direct" : "dispatch", roomChatId: null, roomTitle: null };
    }
    const row = read(chatId);
    if (!row) return otherChannel();
    if (row.kind === "division" && row.parent_chat_id) {
      const parent = read(row.parent_chat_id);
      return parent && isGroupRoom(parent) ? { kind: "dispatch", roomChatId: row.parent_chat_id, roomTitle: oneLineTitle(parent.title) }
        : { kind: "dispatch", roomChatId: null, roomTitle: null };
    }
    if (isGroupRoom(row)) return { kind: "room", roomChatId: chatId, roomTitle: oneLineTitle(row.title) };
    if (row.kind === "user" || row.kind === null) return { kind: "direct", roomChatId: null, roomTitle: null };
    return otherChannel();
  } catch { return otherChannel(); }
}

export const sessionScopeActorMetaKey = (ownerScope: string, scopeId: string, actorKey: string): string =>
  `${ACTOR_KEY_PREFIX}${ownerScope.slice(0, 16)}|${scopeId}|${actorKey}`;

interface StoredAssignment { v: 1; domain: string; adoptedFrom: string | null; retained: string[]; at: string }
const validDomain = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 512;
function parseAssignment(raw: string | undefined | null): StoredAssignment | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredAssignment>;
    if (value?.v !== 1 || !validDomain(value.domain)) return null;
    return { v: 1, domain: value.domain, adoptedFrom: typeof value.adoptedFrom === "string" ? value.adoptedFrom : null,
      retained: Array.isArray(value.retained) ? value.retained.filter((item): item is string => typeof item === "string") : [],
      at: typeof value.at === "string" ? value.at : "" };
  } catch { return null; }
}
/**
 * What an unreadable record still says. `newer`: a record of a later format (readable by a later build) that this build must
 * not overwrite; its domain is used as it is.
 */
function salvageAssignment(raw: string): { domain: string | null; adoptedFrom: string | null; retained: string[]; newer: boolean } {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { domain: validDomain(value.domain) ? value.domain : null, adoptedFrom: typeof value.adoptedFrom === "string" ? value.adoptedFrom : null,
        retained: Array.isArray(value.retained) ? value.retained.filter((item): item is string => typeof item === "string") : [],
        newer: typeof value.v === "number" && value.v > 1 };
    }
  } catch { /* not JSON at all */ }
  return { domain: null, adoptedFrom: null, retained: [], newer: false };
}
/** Read-only consumers follow the same preserved domain as the resolver,
 * including a valid domain salvaged from a newer assignment version. */
function assignmentDomain(raw: string | undefined | null): string | null {
  return parseAssignment(raw)?.domain ?? (raw ? salvageAssignment(raw).domain : null);
}
const assignmentOf = (stored: StoredAssignment, created: boolean, healed = false): SessionScopeAssignment => ({
  outcome: healed && created ? "healed" : created ? (stored.adoptedFrom ? "adopted" : "fresh") : "existing",
  fromDomain: stored.adoptedFrom, retainedDomains: stored.retained, created });

/**
 * The journal an agent's one-to-one conversations in a seat continue: among the owner's journals of this agent whose
 * domain is `chat:<conversation of this seat>`, the one that holds a native session handle comes first, then the most
 * recently written one. The rest are retained as they are.
 */
function chooseSeatCandidates(db: Pick<Database.Database, "prepare">, ownerScope: string, seatId: string, agentId: string): string[] {
  // The seat's own domain `seat:<id>` is a candidate too: it is the journal an earlier assignment of this seat created when no
  // older one existed, so a seat whose record is lost or unreadable finds the journal its conversations were using.
  const rows = db.prepare(`SELECT json_extract(h.identity_json,'$.visibilityDomain') AS domain, MAX(h.updated_at) AS updated_at,
      MAX(EXISTS(SELECT 1 FROM agent_context_bindings b WHERE b.context_key=h.context_key AND b.native_handle IS NOT NULL AND b.native_handle<>'')) AS has_handle
    FROM agent_context_heads h
    WHERE json_extract(h.identity_json,'$.ownerScope')=? AND json_extract(h.identity_json,'$.agentId')=?
      AND (json_extract(h.identity_json,'$.visibilityDomain') IN (SELECT 'chat:'||c.id FROM chats c WHERE ${SEAT_CHAT_PREDICATE})
        OR json_extract(h.identity_json,'$.visibilityDomain')=?)
    GROUP BY domain ORDER BY has_handle DESC, updated_at DESC, domain ASC`).all(ownerScope, agentId, seatId, `seat:${seatId}`) as Array<{ domain: string }>;
  return rows.map(row => row.domain).filter(domain => typeof domain === "string" && domain.length > 0);
}

/** Adopt only journals of this owner/actor whose actual transport rows were
 * registered to this exact immutable working range. Other projects and helper
 * scopes never become candidates merely because they share an actor. */
function chooseWorkingCandidates(db: Pick<Database.Database, "prepare">, input: SessionScopeInput, scope: WorkingSessionScope, additionalDomains: readonly string[] = []): string[] {
  if(scope.rootChatId){
    const domains=new Set([workDomain(scope),...additionalDomains]);
    // Only the original project anchor may retain the former shared native journal.
    // Other conversations retain their own legacy journal; no peer journal is adopted.
    const anchor=(db.prepare("SELECT value FROM meta WHERE key=?").get(WORK_TASK_ROOT_PREFIX+scope.projectId) as {value:string}|undefined)?.value;
    const oldDomain=`work:${scope.projectId}:main`;
    const old=(db.prepare("SELECT value FROM meta WHERE key=?").get(sessionScopeActorMetaKey(input.ownerScope,oldDomain,`agent:${input.agentId}`)) as {value:string}|undefined)?.value;
    const sharedDomain=assignmentDomain(old)??oldDomain;
    if(!scope.subSessionId&&anchor===scope.rootChatId)domains.add(sharedDomain);
    else domains.delete(sharedDomain); // An adopted chat:<peer> handle must not resume in two roots.
    const rows=db.prepare(`SELECT json_extract(h.identity_json,'$.visibilityDomain') AS domain,MAX(h.updated_at) AS updated_at,
      MAX(EXISTS(SELECT 1 FROM agent_context_bindings b WHERE b.context_key=h.context_key AND b.native_handle IS NOT NULL AND b.native_handle<>'')) AS has_handle
      FROM agent_context_heads h WHERE json_extract(h.identity_json,'$.ownerScope')=? AND json_extract(h.identity_json,'$.agentId')=?
      AND json_extract(h.identity_json,'$.visibilityDomain') IN (SELECT value FROM json_each(?))
      GROUP BY domain ORDER BY has_handle DESC,updated_at DESC,domain ASC`).all(input.ownerScope,input.agentId,JSON.stringify([...domains])) as Array<{domain:string}>;
    return rows.map(row=>row.domain).filter(validDomain);
  }
  const rows = db.prepare(`SELECT json_extract(h.identity_json,'$.visibilityDomain') AS domain, MAX(h.updated_at) AS updated_at,
      MAX(EXISTS(SELECT 1 FROM agent_context_bindings b WHERE b.context_key=h.context_key AND b.native_handle IS NOT NULL AND b.native_handle<>'')) AS has_handle
    FROM agent_context_heads h
    WHERE json_extract(h.identity_json,'$.ownerScope')=? AND json_extract(h.identity_json,'$.agentId')=?
      AND (json_extract(h.identity_json,'$.visibilityDomain')=? OR json_extract(h.identity_json,'$.visibilityDomain') IN (SELECT value FROM json_each(?)) OR json_extract(h.identity_json,'$.visibilityDomain') IN (
        SELECT CASE WHEN c.kind='division' AND c.parent_chat_id IS NOT NULL
          THEN 'one-team:'||c.parent_chat_id||':session:'||c.id ELSE 'chat:'||c.id END
        FROM chats c JOIN meta m ON m.key=?||c.id
        WHERE c.agent_id=? AND json_valid(m.value) AND json_extract(m.value,'$.v') IN (1,2)
          AND json_extract(m.value,'$.projectId')=? AND json_type(m.value,'$.subSessionId')=? AND json_extract(m.value,'$.subSessionId') IS ?))
    GROUP BY domain ORDER BY has_handle DESC, updated_at DESC, domain ASC`)
    .all(input.ownerScope,input.agentId,workDomain(scope),JSON.stringify(additionalDomains),WORK_SCOPE_PREFIX,input.agentId,scope.projectId,scope.subSessionId===null?"null":"text",scope.subSessionId) as Array<{domain:string}>;
  return rows.map(row=>row.domain).filter(validDomain);
}

/** The dispatch children of group rooms a roster member worked in: child (division, One surface) of a parent that is a group room. */
const ROOM_CHILD_PREDICATE = `c.kind='division' AND c.origin_surface='one' AND c.agent_id=? AND p.origin_surface='one' AND p.seat_kind='group'
  AND p.parent_chat_id IS NULL AND (p.kind='user' OR p.kind IS NULL)`;
const ROOM_CHILD_DOMAINS = `SELECT 'one-team:'||c.parent_chat_id||':session:'||c.id FROM chats c JOIN chats p ON p.id=c.parent_chat_id WHERE ${ROOM_CHILD_PREDICATE}`;

/**
 * The journal a roster member's session continues, among the owner's journals of the member: for the shared scope its
 * one-to-one seat conversations' (`chat:<c>`), its dispatch children's (`one-team:<room>:session:<child>`, any room) and the
 * seat's own (`seat:<id>`); for a room's scope only that room's dispatch children's. The journal with a native session handle
 * comes first, then the most recently written one (the member's running session is the newest). The rest are retained.
 */
function chooseRosterCandidates(db: Pick<Database.Database, "prepare">, ownerScope: string, agentId: string,
  spec: { shared: { seatId: string } } | { room: { roomChatId: string } }): string[] {
  const where: string[] = [], args: unknown[] = [ownerScope, agentId];
  if ("shared" in spec) {
    where.push(`json_extract(h.identity_json,'$.visibilityDomain') IN (SELECT 'chat:'||c.id FROM chats c WHERE ${SEAT_CHAT_PREDICATE})`, `json_extract(h.identity_json,'$.visibilityDomain')=?`,
      `json_extract(h.identity_json,'$.visibilityDomain') IN (${ROOM_CHILD_DOMAINS})`);
    args.push(spec.shared.seatId, `seat:${spec.shared.seatId}`, agentId);
  } else {
    where.push(`json_extract(h.identity_json,'$.visibilityDomain') IN (${ROOM_CHILD_DOMAINS} AND c.parent_chat_id=?)`);
    args.push(agentId, spec.room.roomChatId);
  }
  const rows = db.prepare(`SELECT json_extract(h.identity_json,'$.visibilityDomain') AS domain, MAX(h.updated_at) AS updated_at,
      MAX(EXISTS(SELECT 1 FROM agent_context_bindings b WHERE b.context_key=h.context_key AND b.native_handle IS NOT NULL AND b.native_handle<>'')) AS has_handle
    FROM agent_context_heads h
    WHERE json_extract(h.identity_json,'$.ownerScope')=? AND json_extract(h.identity_json,'$.agentId')=? AND (${where.join(" OR ")})
    GROUP BY domain ORDER BY has_handle DESC, updated_at DESC, domain ASC`).all(...args) as Array<{ domain: string }>;
  return rows.map(row => row.domain).filter(domain => typeof domain === "string" && domain.length > 0);
}

/** An agent seated on the One org chart and not archived: the meaning of "roster member" for every rule here. */
/**
 * A dispatch child that was started as a NEW isolated session (one_team_start_session new_session): it keeps the conversation's own journal
 * and never joins the member's shared roster session. The owner or the model asked for a session that does not know the earlier work (an
 * independent check); sharing the member's session would hand it exactly what was meant to be withheld.
 */
export const ISOLATED_CHILD_KEY_PREFIX = "session-scope.isolated:";
export function isolatedChildKey(chatId: string): string { return `${ISOLATED_CHILD_KEY_PREFIX}${chatId}`; }
export function isolatedChild(db: Pick<Database.Database, "prepare">, chatId: string): boolean {
  return db.prepare("SELECT 1 AS present FROM meta WHERE key=?").get(isolatedChildKey(chatId)) !== undefined;
}

export function isRosterMember(db: Pick<Database.Database, "prepare">, agentId: string): boolean {
  return !!db.prepare("SELECT 1 FROM one_org_members WHERE installed_agent_id=? AND archived_at IS NULL LIMIT 1").get(agentId);
}
/**
 * The solo seat a roster member's one-to-one conversations sit in: the newest open occupancy of a solo seat that belongs to no
 * Work project (the seat store's own choice for a new conversation, store/seats.ts ensureSoloSeatForAgent), else the seat id
 * that function would create first. The member's real seat ids are not all `seat_<agent id>` (a seat made with another id keeps it).
 */
export function rosterMemberSoloSeatId(db: Pick<Database.Database, "prepare">, agentId: string, ownerScope?: string): string {
  const open = db.prepare(`SELECT o.seat_id AS seat_id FROM one_seat_occupants o JOIN one_seats s ON s.id=o.seat_id
    WHERE o.agent_id=? AND o.until IS NULL AND s.kind='solo' AND s.dissolved_at IS NULL AND s.project_id IS NULL
    ORDER BY o.since DESC, o.seat_id ASC`).all(agentId) as Array<{ seat_id: string }>;
  // A seat that already holds this member's session keeps it: seating the member somewhere newer (a Telegram room's solo seat, a
  // second seat) must not move its dispatch children to a journal of their own while its one-to-one talk stays on the old one. Among
  // several such seats the oldest occupancy wins, so a newer seat never takes the children over.
  if (ownerScope && open.length > 1) {
    const has = db.prepare("SELECT 1 FROM meta WHERE key=?");
    for (const seat of [...open].reverse()) if (has.get(sessionScopeActorMetaKey(ownerScope, `seat:${seat.seat_id}`, `agent:${agentId}`))) return seat.seat_id;
  }
  return open[0]?.seat_id || `seat_${agentId}`;
}

interface AssignmentSpec {
  kind: SessionScopeKind; scopeId: string; actorKey: string; seat: { seatId: string; seatKind: string } | null;
  candidates: () => string[];
}
/**
 * The one stored decision of a (scope, actor): read it; when there is none, choose it (adopt the best candidate by its old domain
 * string, else the scope's own), and store it once whichever process gets here first. Used by the one-to-one seat conversations
 * and by a roster member's dispatch children, which are the same actor in the same scope.
 */
function resolveAssignment(db: Database.Database, input: SessionScopeInput, mode: SessionScopeMode, spec: AssignmentSpec, channel: SessionChannel): ResolvedSessionScope {
  const { scopeId, actorKey } = spec, key = sessionScopeActorMetaKey(input.ownerScope, scopeId, actorKey);
  const base = { kind: spec.kind, mode, shared: true, scopeId, actorKey, seat: spec.seat, fallback: null, unavailable: false, failure: null, channel };
  const read = (): string | undefined => (db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  const raw = read();
  const stored = parseAssignment(raw);
  if (stored) return { ...base, visibilityDomain: stored.domain, assignment: assignmentOf(stored, false) };
  // A value that is there but cannot be read is not "no record": reading the seat's journal from scratch could pick another
  // journal than the one its conversations were using. What the damaged record still says (its domain, the journals it retained)
  // is kept; only what is missing is resolved again.
  const damaged = raw !== undefined;
  const salvage = damaged ? salvageAssignment(raw!) : null;
  const candidates = spec.candidates();
  const domain = salvage?.domain ?? candidates[0] ?? scopeId;
  const adoptedFrom = salvage?.domain ? salvage.adoptedFrom : candidates.length ? candidates[0] : null;
  const retained = [...new Set([...(salvage?.retained ?? []), ...candidates].filter(item => item !== domain))].slice(0, MAX_RETAINED);
  const chosen: StoredAssignment = { v: 1, domain, adoptedFrom, retained, at: new Date().toISOString() };
  // A record of a later format is read, never overwritten.
  if (!input.persist || salvage?.newer) return { ...base, visibilityDomain: chosen.domain, assignment: assignmentOf(chosen, false) };
  if (damaged) {
    // Rewrite it, once, whichever process gets here first: the replace only applies to the very value that was read.
    const rewritten = db.prepare("UPDATE meta SET value=? WHERE key=? AND value=?").run(JSON.stringify(chosen), key, raw).changes === 1;
    const winner = parseAssignment(read());
    if (!winner) throw new Error("session_scope_assignment_unreadable");
    return { ...base, visibilityDomain: winner.domain, assignment: assignmentOf(winner, rewritten, true) };
  }
  // First writer wins: the window process and the background service may both be here with the same first turn.
  const inserted = db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)").run(key, JSON.stringify(chosen)).changes === 1;
  const winner = parseAssignment(read());
  if (!winner) throw new Error("session_scope_assignment_unreadable");
  return { ...base, visibilityDomain: winner.domain, assignment: assignmentOf(winner, inserted) };
}

function resolveSeat(db: Database.Database, input: SessionScopeInput, mode: SessionScopeMode, seatId: string, channel: SessionChannel): ResolvedSessionScope {
  // A roster member's one-to-one conversations also look at the member's dispatch children (the same session); every other agent's
  // look at their own conversations only, exactly as before.
  const roster = rosterScopeMode(db) === "shared" && isRosterMember(db, input.agentId);
  return resolveAssignment(db, input, mode, { kind: "seat", scopeId: `seat:${seatId}`, actorKey: `agent:${input.agentId}`, seat: { seatId, seatKind: "solo" },
    candidates: () => roster ? chooseRosterCandidates(db, input.ownerScope, input.agentId, { shared: { seatId } }) : chooseSeatCandidates(db, input.ownerScope, seatId, input.agentId) }, channel);
}

/**
 * A dispatch child of a group room whose agent is a roster member: the member's team work. Its journal is the member's seat
 * scope (shared with its one-to-one conversations and, in the shared mode, with its work in every other room), or in the room mode
 * the member's scope in this room. null for every other conversation.
 */
function resolveRosterChild(db: Database.Database, input: SessionScopeInput, mode: SessionScopeMode, row: ChatRow, channel: SessionChannel): ResolvedSessionScope | null {
  const rosterMode = rosterScopeMode(db);
  if (rosterMode === "off") return null;
  if (!rosterShape({ agentId: row.agent_id, kind: row.kind, origin: row.origin_surface }, input)) return null;
  if (isolatedChild(db, input.chatId)) return null; // started as a new isolated session: the old per-conversation journal
  const parent = db.prepare("SELECT kind,parent_chat_id,origin_surface,seat_kind,title FROM chats WHERE id=?").get(row.parent_chat_id) as ChannelRow | undefined;
  if (!parent || !isGroupRoom(parent) || !isRosterMember(db, input.agentId)) return null;
  const roomChatId = row.parent_chat_id as string, seatId = rosterMemberSoloSeatId(db, input.agentId, input.ownerScope);
  const room = rosterMode === "room";
  return resolveAssignment(db, input, mode, { kind: "roster", scopeId: room ? `seat:${seatId}#room:${roomChatId}` : `seat:${seatId}`, actorKey: `agent:${input.agentId}`, seat: null,
    candidates: () => chooseRosterCandidates(db, input.ownerScope, input.agentId, room ? { room: { roomChatId } } : { shared: { seatId } }) }, channel);
}

/** The conversation looks like a dispatch child of a member from its own row alone: everything the resolver reads first, before the first database read that can fail. */
function rosterShape(row: { agentId: string | null; kind: string | null; origin: string | null }, input: SessionScopeInput): boolean {
  return row.origin === "one" && row.kind === "division" && !!input.parentChatId && row.agentId === input.agentId
    && input.agentId !== BUILTIN_ONE_AGENT_ID && !!input.agentId.trim() && !!input.ownerScope.trim();
}

/** The seat id when the conversation row is a seat conversation of the agent the turn is for; null for every other conversation. */
function seatOf(row: { agentId: string | null; kind: string | null; origin: string | null; seatId: string | null; seatKind: string | null }, input: SessionScopeInput): string | null {
  const solo = row.origin === "one" && row.kind === "user" && row.seatKind === "solo" && !!row.seatId
    && row.agentId === input.agentId && input.agentId !== BUILTIN_ONE_AGENT_ID && !!input.agentId.trim() && !!input.ownerScope.trim();
  return solo ? row.seatId : null;
}
/** The machine cause of a failure: a SQLite code or this module's own code, never a message. */
export function sessionScopeFailureCause(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string" ? (error as { code: string }).code : "";
  if (/^SQLITE_[A-Z_]+$/.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  return /^session_scope_[a-z_]+$/.test(message) ? message : "session_scope_resolve_failed";
}

/** Eligibility from a host-read Desktop chat row only; this requests fail-closed
 * resolution and grants no working scope or invocation authority. */
export function requiresProjectWorkingSessionScope(row: {
  origin: string | null; projectId: string | null; kind: string | null; parentChatId: string | null;
}): boolean {
  return row.origin === "work" && row.projectId !== null
    && !(row.kind === "division" && row.parentChatId === null);
}

export function resolveSessionScope(db: Database.Database, input: SessionScopeInput): ResolvedSessionScope {
  const old = (mode: SessionScopeMode, fallback: "error" | null, failure: string | null = null, unavailable = false): ResolvedSessionScope => ({
    kind: "legacy", mode, shared: false, scopeId: null, actorKey: null, seat: null, assignment: null, fallback, unavailable,
    failure: failure ? { causeCode: failure } : null,
    channel: deriveSessionChannel(db, input.chatId, input.aliveController),
    visibilityDomain: legacyVisibilityDomain({ chatId: input.chatId, kind: input.kind, parentChatId: input.parentChatId }, input.aliveController) });
  // Known as soon as the conversation row is: a failure after that point concerns a seat conversation or a member's dispatch child.
  let seatId: string | null = input.chat ? seatOf(input.chat, input) : null;
  let member = !!input.chat && rosterShape(input.chat, input);
  let working = input.workingScopeRequired === true;
  try {
    const mode = sessionScopeMode(db);
    if (input.aliveController) return old(mode, null);
    // Explicit working ranges are independent of the legacy seat rollout switch.
    // They are read by recall and admission in both hosts from the same store.
    const registration = workingRegistration(db,input.chatId);
    const registeredWork = registration?.scope??null;
    working = registeredWork !== null || input.workingScopeRequired === true;
    const projectWork = (registration && (!registration.witness || registration.witness.provenance.kind==="external-logical")) || input.chat?.origin === "one" || (input.kind === "division" && !input.parentChatId)
      ? null : projectWorkSessionFacts(db, input);
    const work = registeredWork ?? projectWork?.scope ?? null;
    if (projectWork && input.persist) {
      assertProjectWorkSessionFacts(db, projectWork);
      bindManagedWorkingSessionScope(db, input.chatId, projectWork.scope, {kind:"desktop-project"});
    }
    if (!work && input.workingScopeRequired) throw new Error("session_scope_work_binding_required");
    working = work !== null;
    const workBinding: WorkingSessionBinding | undefined = work && (registeredWork || input.persist)
      ? Object.freeze({chatId:input.chatId,agentId:input.agentId,scope:Object.freeze({...work}),registration:workingRegistration(db,input.chatId)?.raw}) : undefined;
    if(workBinding)assertWorkingSessionBindingCurrent(db,workBinding);
    if (work) return { ...resolveAssignment(db, input, mode, { kind: "work", scopeId: workDomain(work),
      actorKey: `agent:${input.agentId}`, seat: null, candidates: () => chooseWorkingCandidates(db,input,work,
        projectWork ? projectWorkCandidateDomains(db,input,projectWork) : []) },
      deriveSessionChannel(db, input.chatId, input.aliveController)), ...(projectWork ? { projectWork } : {}), ...(workBinding ? {workBinding} : {}) };
    if (mode === "chat") return old(mode, null);
    const row = db.prepare("SELECT agent_id,kind,parent_chat_id,origin_surface,seat_id,seat_kind FROM chats WHERE id=?").get(input.chatId) as ChatRow | undefined;
    if (!row) return old(mode, null);
    const tf=resolveTaskforce(db,input,mode,row,deriveSessionChannel(db,input.chatId,false));if(tf)return tf;
    seatId = seatOf({ agentId: row.agent_id, kind: row.kind, origin: row.origin_surface, seatId: row.seat_id, seatKind: row.seat_kind }, input);
    member = rosterShape({ agentId: row.agent_id, kind: row.kind, origin: row.origin_surface }, { ...input, parentChatId: row.parent_chat_id });
    if (seatId) return resolveSeat(db, input, mode, seatId, deriveSessionChannel(db, input.chatId, false));
    if (member) {
      const scoped = resolveRosterChild(db, input, mode, row, deriveSessionChannel(db, input.chatId, false));
      if (scoped) return scoped;
    }
    return old(mode, null);
  } catch (error) {
    const cause = sessionScopeFailureCause(error);
    const refused = (working || cause.startsWith("session_scope_work_binding_") || cause.startsWith("session_scope_project_work_") || cause.startsWith("session_scope_taskforce_") || seatId !== null || member) && !input.aliveController;
    console.warn("[session-scope] resolve failed", {
      causeCode: cause,
      operation: input.persist ? "turn-admission" : "read-only-lookup",
      outcome: refused ? (input.persist ? "turn-refused" : "scope-unavailable") : "legacy-fallback",
    });
    return old("chat", "error", cause, refused);
  }
}

/** A registered working actor uses the same daemon residency lifetime as a seated roster actor. */
export function workingSessionIsCurrent(db: Pick<Database.Database, "prepare">, identity: { agentId: string; visibilityDomain: string; ownerScope?: string }): boolean {
  const chats = db.prepare("SELECT id FROM chats WHERE agent_id=? AND archived_at IS NULL").all(identity.agentId) as Array<{ id: string }>;
  return chats.some(chat => {
    try {
      const scope = workingSessionScope(db, chat.id);
      if (!scope) return false;
      // Residency still requires a persisted registration; validate live Desktop Work custody too.
      assertWorkingSessionBindingCurrent(db,{chatId:chat.id,agentId:identity.agentId,scope});
      if(workingRegistration(db,chat.id)?.witness?.provenance.kind==="desktop-project")projectWorkSessionFacts(db, {chatId:chat.id,agentId:identity.agentId});
      const canonical = workDomain(scope);
      const raw = identity.ownerScope ? (db.prepare("SELECT value FROM meta WHERE key=?")
        .get(sessionScopeActorMetaKey(identity.ownerScope,canonical,`agent:${identity.agentId}`)) as {value:string}|undefined)?.value : undefined;
      return (assignmentDomain(raw) ?? canonical) === identity.visibilityDomain;
    } catch { return false; }
  });
}

/**
 * Every journal domain a seat scope assigned to this agent under this owner scope (one record per scope the agent has a session in).
 * A turn digest, a recall or a rollback that looks for the journal a conversation's turns went to reads these besides the
 * conversation's own formula: after an assignment, a roster member's dispatch child writes to the member's journal.
 */
export function assignedSeatDomains(db: Pick<Database.Database, "prepare">, ownerScope: string, agentId: string): string[] {
  if (!ownerScope.trim() || !agentId.trim()) return [];
  const rows = db.prepare("SELECT key,value FROM meta WHERE key LIKE ? ESCAPE '\\'").all(`${ACTOR_KEY_PREFIX.replace(/[%_\\]/g, "\\$&")}${ownerScope.slice(0, 16)}|seat:%`) as Array<{ key: string; value: string }>;
  const suffix = `|agent:${agentId}`, domains: string[] = [];
  for (const row of rows) {
    if (!row.key.endsWith(suffix)) continue;
    const domain = assignmentDomain(row.value);
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

/**
 * The journals a conversation's turns can be found in: its own old domain, and the domain its seat scope assigned to its agent.
 * Reading only: never stores an assignment, whatever the switches say now (turns that ran under a scope stay readable after a rollback).
 */
export function journalDomainsOfConversation(db: Pick<Database.Database, "prepare">, input: { ownerScope: string; agentId: string; chatId: string; kind: string | null; parentChatId: string | null }): string[] {
  const own = legacyVisibilityDomain({ chatId: input.chatId, kind: input.kind, parentChatId: input.parentChatId }, false);
  let retiredSharedDomain:string|null=null;
  let assigned: string[] = [];
  try { if(isolatedChild(db,input.chatId) && registeredTaskforceScope(db,input.kind==="division"&&input.parentChatId?input.parentChatId:input.chatId))return [own];
    const tf=taskforceScopeForChat(db,input);if(tf){const domain=taskforceDomain(tf),raw=(db.prepare("SELECT value FROM meta WHERE key=?").get(sessionScopeActorMetaKey(input.ownerScope,domain,`agent:${input.agentId}`)) as {value:string}|undefined)?.value;
      return raw===undefined?[own]:parseAssignment(raw)?.domain===domain?[own,domain].filter((v,i,a)=>a.indexOf(v)===i):[own];}
  }catch{return [own];}
  try { assigned = assignedSeatDomains(db, input.ownerScope, input.agentId); } catch { /* the conversation's own domain is still readable */ }
  try {
    const work = workingSessionScope(db, input.chatId);
    if(work)assertWorkingSessionBindingCurrent(db,{...input,scope:work});
    if(work?.rootChatId){
      const anchor=(db.prepare("SELECT value FROM meta WHERE key=?").get(WORK_TASK_ROOT_PREFIX+work.projectId) as {value:string}|undefined)?.value;
      if(work.subSessionId||anchor!==work.rootChatId){
        const oldDomain=`work:${work.projectId}:main`;
        const old=(db.prepare("SELECT value FROM meta WHERE key=?").get(sessionScopeActorMetaKey(input.ownerScope,oldDomain,`agent:${input.agentId}`)) as {value:string}|undefined)?.value;
        retiredSharedDomain=assignmentDomain(old)??oldDomain;
      }
    }
    const record=workingRegistration(db,input.chatId);
    const facts = work && (!record?.witness || record.witness.provenance.kind==="external-logical") ? null : projectWorkSessionFacts(db, input);
    if (facts) {
      const preview = resolveSessionScope(db as Database.Database, {...input, aliveController:false, persist:false, workingScopeRequired:true});
      if (preview.unavailable) throw new Error("session_scope_project_work_read_failed");
      assigned.push(preview.visibilityDomain);
    } else if (work) {
      const scopeId = workDomain(work);
      const raw = (db.prepare("SELECT value FROM meta WHERE key=?").get(sessionScopeActorMetaKey(input.ownerScope, scopeId, `agent:${input.agentId}`)) as { value: string } | undefined)?.value;
      assigned.push(assignmentDomain(raw) ?? scopeId);
    }
  } catch (error) {
    if (["session_scope_project_work_","session_scope_work_binding_"].some(prefix=>sessionScopeFailureCause(error).startsWith(prefix))) throw error;
    /* Keep unrelated legacy domains without writing or adopting another journal. */
  }
  return [own, ...assigned.filter(domain => domain !== own)].filter(domain=>domain!==retiredSharedDomain);
}

/**
 * Whether the journal `identity` names is the session of a roster member that is on the roster now: the background service keeps
 * such a session's resident process awake (daemon/agent-context-host.ts awakeLifetime). Either the journal is a seat scope's
 * assignment for this agent, or (as before) it is the journal of the member's own dispatch child.
 */
export function rosterSessionIsCurrent(db: Pick<Database.Database, "prepare">, identity: { ownerScope: string; agentId: string; visibilityDomain: string }): boolean {
  if (!isRosterMember(db, identity.agentId)) return false;
  if(identity.visibilityDomain.startsWith("taskforce:")){
    const match=/^taskforce:([A-Za-z0-9_-]+):seat:(seat_tf_[A-Za-z0-9_-]+)$/.exec(identity.visibilityDomain);if(!match)return false;
    try{const row=db.prepare("SELECT chat_id FROM one_taskforces WHERE id=?").get(match[1]) as {chat_id:string}|undefined;if(!row)return false;
      const scope=registeredTaskforceScope(db,row.chat_id);if(!scope||scope.seatId!==match[2]||!taskforceSessionScopeIsCurrent(db,scope,identity.agentId))return false;
      const raw=(db.prepare("SELECT value FROM meta WHERE key=?").get(sessionScopeActorMetaKey(identity.ownerScope,identity.visibilityDomain,`agent:${identity.agentId}`)) as {value:string}|undefined)?.value;
      return parseAssignment(raw)?.domain===identity.visibilityDomain;
    }catch{return false;}
  }
  return assignedSeatDomains(db, identity.ownerScope, identity.agentId).includes(identity.visibilityDomain);
}
