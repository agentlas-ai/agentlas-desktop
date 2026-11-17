import { createHash } from "node:crypto";
import { sameMemoryActor } from "../../shared/memory-actor-family";
import { memoryActorKind } from "../../shared/memory-ownership";
import { personalLineReadable, personalReadable } from "../../shared/memory-classification";
import { memoryClassificationRules, workspaceRulesOn } from "./classification";
import { sharedOpenHere } from "./shared-ids";
import { isOneMemoryActor } from "../../shared/memory-actor-family";
export interface MemoryRecallScope { projectId?: string|null; projectPath?: string|null; agentId?: string|null;
  chatId?: string|null; visibilityDomain?: string|null; recallBoundary?: "assigned-target";
  /** Agentlas 2.0 P3b: a borrowed (Hub/Cloud) team-run node reads nothing of the owner's: no Personal line, no team-shared line. Set only with the workspace-rules switch on. */
  guest?: boolean;
  /** Agentlas 2.0 P3b: the host already decided whether this reader's conversation is the personal agent's own (a team run reads with no chat id). Used only with the switch on. */
  personalRead?: boolean }
export interface MemoryRecallPolicyRow { scope:string;kind?:string|null;context_json?:string|null;project_id:string|null;project_path:string|null;agent_id:string|null;chat_id:string|null;
  binding_owner?:string|null;binding_actor?:string|null;applicability_json?:string|null }
const fields=new Set(["scope","projectIds","projectPathHash","actorId","chatId","recallChannel","enabled","compatibilityScope","visibilityDomain","audience"]);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>Boolean(v)&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v as object).sort().join()===keys.sort().join();
// What the workspace-rules switch and the conversation say for one reader scope (Agentlas 2.0 P3a): asked once per scope object, not once per candidate line.
const personalReadOf = new WeakMap<object, { rulesOn: boolean; personalRead: boolean; sharedOpen: boolean }>();
function workspaceReadState(scope: MemoryRecallScope): { rulesOn: boolean; personalRead: boolean; sharedOpen: boolean } {
  const known = personalReadOf.get(scope);
  if (known) return known;
  let state = { rulesOn: false, personalRead: false, sharedOpen: false };
  // the shared kinds are read by the One family only once shared memory was opened HERE (the store's first-merge mark). A store that never merged reads exactly as before.
  try { state.sharedOpen = sharedOpenHere((require("./database") as typeof import("./database")).getMemoryDb()); } catch { /* unknown = not open */ }
  try {
    state.rulesOn = workspaceRulesOn() && memoryClassificationRules() !== null;
    // Switch on: Personal lines are the personal agent's own conversation's. A reader with no conversation is not that conversation (unknown means no).
    if (state.rulesOn && typeof scope.personalRead === "boolean") state = { ...state, rulesOn: true, personalRead: scope.personalRead };
    else if (state.rulesOn && scope.chatId) {
      const { getDb } = require("../store/db") as typeof import("../store/db");
      const { isPersonalAgentConversation } = require("../workspace-rules/scope") as typeof import("../workspace-rules/scope");
      state = { ...state, rulesOn: true, personalRead: isPersonalAgentConversation(getDb(), scope.chatId) };
    }
  } catch { /* a reader that cannot tell keeps the switch-off answer */ }
  personalReadOf.set(scope, state);
  return state;
}

/** A stored Personal line of a shared kind: a fact by its column, or an identity / a boundary by its `ticket_kind` (the column alone cannot say it). */
function sharedKindRow(row: MemoryRecallPolicyRow): boolean {
  if (row.kind === "fact") return true;
  if (!row.context_json) return false;
  try { const t = (JSON.parse(row.context_json) as { ticket_kind?: unknown }).ticket_kind; return t === "identity" || t === "boundary"; } catch { return false; }
}

/** Policy precedes ranking/embedding. Scope comes from an actual host reader. */
export function allowsOrdinaryMemoryRecall(row:MemoryRecallPolicyRow,scope:MemoryRecallScope,owner:string):boolean {
  if(scope.recallBoundary === "assigned-target")return false;
  // A borrowed team-run node is a guest (P3b, decision): the owner's Personal and team-shared lines are not its to read. Its project lines go through the ordinary rules below.
  if(scope.guest===true&&(row.scope==="user_identity"||row.scope==="team_memory"||row.scope==="agent_team"))return false;
  // A hub-called agent reads and keeps no memory of the owner's (decision; #5): the team's shared lines are the owner's, too.
  if((row.scope==="team_memory"||row.scope==="agent_team")&&memoryActorKind(scope.agentId)==="hub")return false;
  // (section 12-6): the owner's Personal facts are read by the personal agent only. One definition (shared/memory-classification.ts, the port of the
  // engine's reads_personal_fact); every prompt-bound reader of memory lines asks this function, the owner's own screens and the phone's map read the store directly.
  // Switch on (P3a): every Personal line, whatever its kind, is read by the personal agent's own conversation only. Switch off: only a Personal fact is held back, as before.
  if(row.scope==="user_identity"){
    const state=workspaceReadState(scope);
    if(state.rulesOn){ if(!personalReadable(memoryClassificationRules(),row.scope,row.kind,scope.agentId??null,{rulesOn:true,personalRead:state.personalRead}))return false; }
    else if(row.kind==="fact"&&!personalLineReadable(memoryClassificationRules(),row.scope,row.kind,scope.agentId??null))return false;
    // A boundary or identity the model gave (kept in the preference column or the fact column with its `ticket_kind`) is a shared kind too: with shared memory open, only the One family reads it.
    else if(state.sharedOpen&&!isOneMemoryActor(scope.agentId??null)&&sharedKindRow(row))return false;
  }
  if(!row.binding_owner)return owner.startsWith("device-local:");
  if(row.binding_owner!==owner)return false;
  let p:Record<string,unknown>;try {p=JSON.parse(row.applicability_json??"{}");}catch{return false;}
  if(!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).some(k=>!fields.has(k))
    ||(p.enabled!==undefined&&p.enabled!==true)||(p.scope!==undefined&&p.scope!==row.scope)
    ||(p.recallChannel!==undefined&&p.recallChannel!=="default")||p.compatibilityScope!==undefined)return false;
  const actor=row.binding_actor??row.agent_id;
  if(p.actorId!==undefined&&p.actorId!==null&&(typeof p.actorId!=="string"||!sameMemoryActor(p.actorId,actor)))return false;
  if((row.scope==="agent_repo"||row.scope==="session")&&actor!==null&&!sameMemoryActor(actor,scope.agentId??null))return false;
  if(p.projectIds!==undefined) {
    if(!Array.isArray(p.projectIds)||p.projectIds.some(v=>typeof v!=="string"||v!==row.project_id))return false;
    // The original default writer records the origin project even for portable
    // agent/user learning. Scope/path and an explicit audience still determine
    // applicability; origin alone cannot turn portable learning into a grant.
    if((row.scope==="project"||row.project_path!==null||p.audience!==undefined)
      &&p.projectIds.some(v=>v!==scope.projectId))return false;
  }
  if(p.projectPathHash!==undefined&&p.projectPathHash!==null&&p.projectPathHash!==createHash("sha256").update(scope.projectPath??"").digest("hex"))return false;
  // For portable learning chat_id records origin; only session scope constrains its reader.
  if(p.chatId!==undefined&&p.chatId!==null&&(p.chatId!==row.chat_id||(row.scope==="session"&&p.chatId!==scope.chatId)))return false;
  if(p.visibilityDomain!==undefined&&p.visibilityDomain!==scope.visibilityDomain)return false;
  if(p.audience===undefined)return true;
  const a=p.audience;if(!exact(a,["schemaVersion","receiver","visibilityDomain"])||a.schemaVersion!=="agentlas.surface-memory-audience.v1"
    ||!scope.visibilityDomain||a.visibilityDomain!==scope.visibilityDomain)return false;
  const target=a.receiver;
  if(exact(target,["kind","appId","projectId","actorId"])&&target.kind==="agent-app")return target.projectId===scope.projectId
    &&target.actorId===scope.agentId&&scope.visibilityDomain===`agent-app:${target.appId}`;
  if(exact(target,["kind","lifeId","organism","actorId"])&&target.kind==="alive-controller")return target.actorId===scope.agentId
    &&scope.visibilityDomain===`alive-decision:${target.organism}:${target.lifeId}`;
  return false;
}
