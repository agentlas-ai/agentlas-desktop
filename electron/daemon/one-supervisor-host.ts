import { createHash } from "node:crypto";
import { onAskUserLifecycle,listPendingAskUserRequests,submitAskUserAnswer } from "../confirm/ask-user";
import type { AskUserRequestEvent } from "../../shared/types";
import { OneSupervisorOwner } from "../one/supervisor-owner";
import { getDb, STORE_SCHEMA_VERSION } from "../store/db";
import { getOneProfile } from "../store/one-profile";
import { getAuthenticatedActorIds } from "../auth";
import { ONE_SUPERVISOR_SCHEMA } from "../../shared/one-supervisor";
import { ONE_SUPERVISOR_JOURNAL_SCHEMA, ONE_SUPERVISOR_RUNTIME_PROTOCOL, sameSupervisorRuntimeCompatibility } from "../../shared/one-supervisor-runtime";
import { getInvocationAdmission } from "../store/invocation-admissions";
import { invocationRunOwners } from "../store/invocation-run-owners";
import type { ScienceDaemonClient } from "../science-host/daemon-client";
import type { OneSupervisorService } from "../one/supervisor-service";

const METHODS = new Set(["snapshot", "send", "startWork", "startScience", "control", "stopReply", "appearance", "journal", "receipt", "stopTask", "checkin", "followUp", "sendToChat", "assertConversation", "ownerTurn", "assertAutomaticWriteAllowed", "budgets", "budgetConfigure"]);
function fail(code: string): never { throw Object.assign(new Error(code),{code}); }
function exact(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
/** Constructed only by the enrolled native daemon. The public control socket
 * cannot adopt this domain or dispatch an original command. */
export function createDaemonOneSupervisorHost(options: { bootId: string; assertOwner(): void; science?:Pick<ScienceDaemonClient,"commandObserved"> }) {
  let service: OneSupervisorService | undefined;
  let identity: { oneId: string; actor: string } | undefined;
  let adopting:Promise<unknown>|undefined;
  const questions=new Map<string,{event:AskUserRequestEvent;runId:string;leaseId:string;revision:string}>();
  let stopQuestions:(()=>void)|undefined;
  const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  let closeHost:(()=>void)|undefined;
  const compatibility = Object.freeze({ protocol: ONE_SUPERVISOR_RUNTIME_PROTOCOL, supervisorSchema: ONE_SUPERVISOR_SCHEMA,
    journalSchema: ONE_SUPERVISOR_JOURNAL_SCHEMA, storeSchema:STORE_SCHEMA_VERSION, nativeAbi: process.versions.modules });
  function authority() {
    options.assertOwner(); const actor = getAuthenticatedActorIds();
    if (!identity || JSON.stringify(actor)!==identity.actor || getOneProfile().oneId !== identity.oneId) fail("supervisor_daemon_identity_authority_changed");
  }
  function owner() {
    const db = getDb();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_runtime_owner'").get()) return null;
    return db.prepare("SELECT one_id AS oneId,owner_epoch AS ownerEpoch,owner_kind AS ownerKind,generation,phase FROM one_supervisor_runtime_owner WHERE slot='personal'").get() ?? null;
  }
  type OwnerProjection={oneId:string;ownerEpoch:string;ownerKind:string;generation:number;phase:string};
  function adoption(){return {adopted:true,compatibility,bootId:options.bootId,owner:owner()};}
  async function initialize(oneId:string,actor:string,expected:OwnerProjection):Promise<unknown>{
    if(adopting)return adopting;
    adopting=(async()=>{
      const host=await import("../one/supervisor");
      identity={oneId,actor};authority();
      const db=getDb();
      db.exec(`CREATE TABLE IF NOT EXISTS one_supervisor_domain_authority (
        slot TEXT PRIMARY KEY CHECK(slot='personal'),one_id TEXT NOT NULL,actor_json TEXT NOT NULL,
        owner_epoch TEXT NOT NULL,generation INTEGER NOT NULL,compatibility_json TEXT NOT NULL
      )`);
      db.transaction(()=>{
        const prior=owner() as OwnerProjection|null;
        if(!prior || prior.oneId!==expected.oneId || prior.ownerEpoch!==expected.ownerEpoch || prior.generation!==expected.generation)fail("supervisor_daemon_handoff_fenced");
        const lease=new OneSupervisorOwner(db,{ownerEpoch:options.bootId,ownerKind:"work-daemon"}).assert(oneId);
        db.prepare(`INSERT INTO one_supervisor_domain_authority VALUES('personal',?,?,?,?,?)
          ON CONFLICT(slot) DO UPDATE SET one_id=excluded.one_id,actor_json=excluded.actor_json,owner_epoch=excluded.owner_epoch,generation=excluded.generation,compatibility_json=excluded.compatibility_json`)
          .run(oneId,actor,lease.ownerEpoch,lease.generation,JSON.stringify(compatibility));
      }).immediate();
      host.configureOneSupervisorDaemonHost({ownerKind:"work-daemon",ownerEpoch:options.bootId,assertAuthority:authority});
      if(options.science)host.configureOneSupervisorScience(options.science);
      service=host.oneSupervisor();closeHost=host.closeOneSupervisorHostAdmission;
      db.exec(`CREATE TABLE IF NOT EXISTS one_supervisor_question_answers (
        request_id TEXT PRIMARY KEY,one_id TEXT NOT NULL,run_id TEXT NOT NULL,revision TEXT NOT NULL,
        answer_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('dispatching','answered','held'))
      )`);
      stopQuestions??=onAskUserLifecycle(event=>{
        if(event.expiresAt<=Date.now()){questions.delete(event.requestId);return false;}
        try{
          authority();if(!event.chatId)return false;
          const custody=invocationRunOwners.getActiveOwner(event.chatId);
          if(!custody || custody.ownerId!==options.bootId || !runBinding(event.chatId,custody.runId))return false;
          questions.set(event.requestId,{event:{...event,options:event.options.map(option=>({...option}))},runId:custody.runId,leaseId:custody.leaseId,revision:digest(event)});
          return true;
        }catch{return false;}
      });
      return adoption();
    })();
    try{return await adopting;}finally{adopting=undefined;}
  }
  /** The persisted grant is only a source identity. Native enrollment/socket
   * fencing and a proven released/dead prior process still authorize custody. */
  async function recover():Promise<boolean>{
    if(service)return true;
    options.assertOwner();const db=getDb();
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_supervisor_domain_authority'").get())return false;
    const grant=db.prepare("SELECT * FROM one_supervisor_domain_authority WHERE slot='personal'").get() as {one_id:string;actor_json:string;owner_epoch:string;generation:number;compatibility_json:string}|undefined;
    const prior=owner() as OwnerProjection|null;
    if(!grant || !prior || prior.ownerKind!=="work-daemon" || prior.oneId!==grant.one_id || prior.ownerEpoch!==grant.owner_epoch || prior.generation!==grant.generation)return false;
    if(grant.compatibility_json!==JSON.stringify(compatibility))fail("supervisor_daemon_version_mismatch");
    if(grant.one_id!==getOneProfile().oneId || grant.actor_json!==JSON.stringify(getAuthenticatedActorIds()))fail("supervisor_daemon_identity_authority_changed");
    await initialize(grant.one_id,grant.actor_json,prior);return true;
  }
  async function dispatch(raw: unknown): Promise<unknown> {
    options.assertOwner();
    if (!exact(raw, ["version", "op"], ["input"]) || raw.version !== ONE_SUPERVISOR_RUNTIME_PROTOCOL || typeof raw.op !== "string") fail("supervisor_daemon_protocol_invalid");
    if (raw.op === "status") {
      let authorityCurrent=true;try{if(service)authority();}catch{authorityCurrent=false;}
      return { compatibility, bootId: options.bootId, owner: owner(), active: !!service, authorityCurrent };
    }
    if (raw.op === "adopt") {
      if (!exact(raw.input, ["compatibility", "oneId", "ownerEpoch", "generation"])) fail("supervisor_daemon_handoff_invalid");
      const input = raw.input;
      if (!sameSupervisorRuntimeCompatibility(input.compatibility,compatibility)) fail("supervisor_daemon_version_mismatch");
      if (input.oneId !== getOneProfile().oneId) fail("supervisor_daemon_identity_changed");
      // Native enrollment proves the local OS owner even without a cloud account.
      if (service) { authority(); return adoption(); }
      const prior = owner() as OwnerProjection | null;
      if (!prior || prior.phase !== "released" || prior.ownerEpoch !== input.ownerEpoch || prior.generation !== input.generation || prior.oneId !== input.oneId) fail("supervisor_daemon_handoff_fenced");
      return initialize(String(input.oneId),JSON.stringify(getAuthenticatedActorIds()),prior);

    }
    authority(); if (!service) fail("supervisor_daemon_not_adopted");
    if(raw.op==="questions.list")return [...questions.values()].map(row=>row.event).filter(row=>row.expiresAt>Date.now());
    if(raw.op==="questions.answer"){
      if(!exact(raw.input,["requestId","answer"]) || typeof raw.input.requestId!=="string" || !(raw.input.answer===null || typeof raw.input.answer==="string"&&raw.input.answer.length<=100000))fail("supervisor_question_answer_invalid");
      const {requestId,answer}=raw.input,answerHash=digest(answer),db=getDb();
      service!.assertHostWriteAuthority(identity!.oneId);
      const previous=db.prepare("SELECT * FROM one_supervisor_question_answers WHERE request_id=?").get(requestId) as {one_id:string;answer_hash:string;state:string}|undefined;
      if(previous){if(previous.one_id!==identity!.oneId || previous.answer_hash!==answerHash)fail("supervisor_question_answer_conflict");return previous.state==="answered";}
      const question=questions.get(requestId),pending=listPendingAskUserRequests().find(row=>row.requestId===requestId);
      if(!question || !pending || question.revision!==digest(pending) || pending.expiresAt<=Date.now() || !pending.chatId)fail("supervisor_question_stale");
      const custody=invocationRunOwners.getRunOwner(pending.chatId,question.runId);
      if(!custody || custody.state!=="active" || custody.leaseId!==question.leaseId || !runBinding(pending.chatId,question.runId))fail("supervisor_question_source_fenced");
      db.prepare("INSERT INTO one_supervisor_question_answers VALUES(?,?,?,?,?,'dispatching')").run(requestId,identity!.oneId,question.runId,question.revision,answerHash);
      const answered=submitAskUserAnswer(requestId,answer as string|null);
      db.prepare("UPDATE one_supervisor_question_answers SET state=? WHERE request_id=? AND state='dispatching'").run(answered?'answered':'held',requestId);
      return answered;
    }
    if (raw.op === "harness.result" || raw.op === "harness.action") {
      const harness = (await import("../one/harness")).localOneHarness();
      authority();
      return raw.op === "harness.result" ? harness.getResult(raw.input as Parameters<typeof harness.getResult>[0]) : harness.action(raw.input as Parameters<typeof harness.action>[0]);
    }
    if (raw.op !== "command" || !exact(raw.input, ["method", "args"]) || !METHODS.has(String(raw.input.method)) || !Array.isArray(raw.input.args) || raw.input.args.length > 2) fail("supervisor_daemon_command_invalid");
    const method = raw.input.method as keyof OneSupervisorService;
    return (service[method] as (...args: unknown[]) => unknown).apply(service, raw.input.args);
  }
  function runBinding(chatId:string,runId:string) {
    if(!service)return null;
    try{authority();}catch{return null;}
    const admission=getInvocationAdmission(runId),custody=invocationRunOwners.getRunOwner(chatId,runId);
    if(!admission || admission.chatId!==chatId || admission.ownerProcessEpoch!==options.bootId
      || !custody || custody.ownerKind!=='daemon' || custody.ownerId!==options.bootId)return null;
    if(!getDb().prepare("SELECT 1 FROM one_supervisor_requests WHERE one_id=? AND run_id=?").get(identity!.oneId,runId))return null;
    return {chatId,runId,inputDigest:admission.inputDigest};
  }
  function captures(){
    if(!service)return [];
    try{authority();}catch{return [];}
    return (getDb().prepare("SELECT DISTINCT o.chat_id,o.run_id,o.state FROM invocation_run_owners o JOIN one_supervisor_requests r ON r.run_id=o.run_id WHERE r.one_id=? AND o.owner_id=? AND o.owner_kind='daemon' ORDER BY o.created_at DESC LIMIT 500")
      .all(identity!.oneId,options.bootId) as Array<{chat_id:string;run_id:string;state:string}>).filter(row=>runBinding(row.chat_id,row.run_id)).map(row=>({chatId:row.chat_id,runId:row.run_id,nativeCustody:row.state==='released'?'released':'retained'}));
  }
  return { dispatch,recover,runBinding,captures, get active() { return !!service; }, closeAdmission() { stopQuestions?.();stopQuestions=undefined;closeHost?.(); } };
}
