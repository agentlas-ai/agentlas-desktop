/** OUTPUT candidate. Composition-only adapter; the common wait engine is the sole scheduler/store/claim owner. */
import { createHash } from "node:crypto";
import { readCanonicalGoalWaitObservation } from "../long-run/canonical-owner-waits";
import { scienceLongRunId } from "agentlas-science/dist/contracts/science-long-run";
import { assertScienceHostWritable, scienceStore, scienceConversationService } from "agentlas-science";
import type { InvocationExecutionContext } from "../mcp/client";
import type { CanonicalGoalWaitOwnerRef, CanonicalGoalWaitOwnerProvider, CanonicalGoalWaitSourceToken, CanonicalGoalWaitPrepared,
  CanonicalGoalWaitIntake, CanonicalGoalWaitOwnerSnapshot } from "../long-run/canonical-owner-port";
import type { GoalWaitHostOwner } from "../long-run/wait-subscriptions";
import { goalTimerAuthorityForOwner } from "../long-run/goal-deadline";
import { getDb } from "../store/db";
import { readQuestionDecision } from "../confirm";
import { readGoalWaitProposal } from "../long-run/goal-wait-proposal";
import { goalWaitObservationPart } from "../long-run/goal-wait-observation";
import type { DeclaredPromptPart } from "../runtime/prompt-order";
import { getChat } from "../store/chats";
import { getRunEventBySource, getInvocationRunReceipt } from "../store/run-events";
import { invocationProcessOwner, invocationRunOwners, assertInvocationRunOwner } from "../store/invocation-run-owners";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { workingSessionScope } from "../runtime/session-scope";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";

type Store=ReturnType<typeof scienceStore> & {
  canonicalGoalWaitResumeReference(input:{projectId:string;conversationId:string;turnId:string;invocationRunId:string;prospectiveRequestId?:string}):{requestId:string;loopSessionId:string}|null;
  canonicalGoalWaitEmptySettlementReference(projectId:string,conversationId:string,turnId:string):EmptyReference|null;
  canonicalDecisionControlFence(projectId:string,conversationId:string):{stopped:boolean;loop:unknown;[key:string]:unknown};
  canonicalDecisionSourceReference(projectId:string,conversationId:string,turnId:string):{sourceMessageId:string;sourceContentSha256:string;sourceRawContentSha256?:string}|null;
};
type EmptyReference={proposalEventId:string;proposalSha256:string;terminalEventId:string;receiptEventId:string};
type Ref=CanonicalGoalWaitOwnerRef;
type Input={ref:Readonly<Ref>;waitId:string;reservedRunId:string;expectedOwnerStamp:string;locale?:"ko"|"en";hostObservation?:DeclaredPromptPart};
type Packet={turn:NonNullable<ReturnType<ReturnType<typeof scienceStore>["getTurnByInvocationRunId"]>>;request:unknown;executionContext:unknown;workspaceBinding?:unknown;userMessage:unknown};
type Conversations={prepareHostGoalWaitContinuation(input:Input):Packet;startPreparedHostGoalWait(packet:Packet):
  {start:true;runId:string}|{start:false;reason:string;retryAt?:string}};
const fail=(code:string):never=>{throw Object.assign(new Error(code),{code});};
const stable=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const sha=(value:unknown):string=>createHash("sha256").update(stable(value),"utf8").digest("hex");
const same=(a:unknown,b:unknown)=>stable(a)===stable(b);
let installed:ReturnType<typeof createScienceCanonicalGoalWaitOwner>|null=null;

/** The caller is the current process composition, never a renderer/model parameter. */
export function createScienceCanonicalGoalWaitOwner(ports:{owner():GoalWaitHostOwner|null;assertExecution():void;assertCurrentOwner(owner:Readonly<GoalWaitHostOwner>):void;intake:CanonicalGoalWaitIntake;
  cancelScope(scope:{domain:"science";projectId:string;conversationId:string;chatId:string},reason:string):void}) {
  const tokens=new WeakMap<CanonicalGoalWaitSourceToken,{ref:Readonly<Ref>;sourceStamp:string;ownerStamp:string}>();
  const inputs=new WeakMap<Input,{ref:Readonly<Ref>;sourceStamp:string;postStamp:string|null;inputStamp:string;inputSha256:string;waitId:string;reservedRunId:string}>();
  const packets=new WeakMap<CanonicalGoalWaitPrepared,{packet:Packet;input:Input;sourceStamp:string;postStamp:string}>();
  const emptyTokens=new WeakMap<object,{ref:Readonly<Ref>;stamp:string;reference:EmptyReference}>();
  const captures=new WeakMap<object,{ref:Readonly<Ref>;stamp:string;owner:ReturnType<typeof invocationRunOwners.getRunOwner>}>();
  function sourceFacts(ref:Readonly<Ref>,allowUnsettled:boolean,readOnlyCapture:boolean,observationOnly:boolean) {
    assertScienceHostWritable();
    if(!ref||ref.domain!=="science")return fail("science_goal_wait_scope_invalid");
    const store=scienceStore() as Store,source=store.getTurnByInvocationRunId(ref.sourceInvocationId);
    const binding=store.getConversationRuntimeBinding(ref.projectId,ref.conversationId);
    const reverse=binding&&store.getConversationScopeForRuntimeChat(binding.runtimeChatId);
    const registered=binding&&workingSessionScope(getDb(),binding.runtimeChatId),chat=binding&&getChat(binding.runtimeChatId);
    const loop=store.getLoopSessionForProject(ref.projectId,ref.loopSessionId),owner=ports.owner();
    if((!observationOnly&&!owner)||!source||source.id!==ref.sourceTurnId||source.projectId!==ref.projectId||source.conversationId!==ref.conversationId
      ||source.runtimeChatId!==ref.chatId||!binding||binding.runtimeChatId!==ref.chatId||!reverse
      ||reverse.projectId!==ref.projectId||reverse.conversationId!==ref.conversationId||!registered||registered.projectId!==ref.projectId
      ||!chat||chat.archivedAt!==null||!chat.agentId||!loop||loop.runtimeChatId!==ref.chatId
      ||store.getActiveLoopSession(ref.projectId)?.id!==loop.id
      ||store.getResearchAssistantTaskForConversation(ref.projectId,ref.conversationId)
      ||store.peerReview().refereeRoleForConversation(ref.projectId,ref.conversationId))return fail("science_goal_wait_scope_changed");
    if(!observationOnly&&!readOnlyCapture)ports.assertCurrentOwner(owner!);
    const question=readQuestionDecision(ref.chatId);
    if(question?.awaitingOwner)return fail("science_goal_wait_question_priority");
    const control=store.canonicalDecisionControlFence(ref.projectId,ref.conversationId),budget=store.researchExecutionBudget(ref.projectId,ref.conversationId);
    if(control.stopped||!budget||budget.status!=="active")return fail("science_goal_wait_control_blocked");
    const wait=(observationOnly?readCanonicalGoalWaitObservation(ref):ports.intake.read(ref)),reserved=wait?.reservedRunId?store.getTurnByInvocationRunId(wait.reservedRunId):null;
    const latest=store.getLatestTurn(ref.projectId,ref.conversationId);
    let sourceLoop={id:loop.id,version:loop.version,stateSha256:loop.stateSha256,status:loop.status,activeRunId:loop.activeRunId};
    if(reserved) {
      const basis=reserved.continuationBasis;
      if(reserved.projectId!==ref.projectId||reserved.conversationId!==ref.conversationId||reserved.runtimeChatId!==ref.chatId
        ||reserved.parentTurnId!==source.id||reserved.origin!=="loop-continuation"||basis?.schema!=="agentlas.science.loop-continuation-basis/v1"
        ||basis.sourceInvocationRunId!==source.invocationRunId||basis.loopSessionId!==loop.id||!Number.isSafeInteger(basis.loopVersion)
        ||typeof basis.loopStateSha256!=="string"||loop.version!==Number(basis.loopVersion)+1
        ||loop.status!=="queued"||loop.activeRunId!==null||latest?.id!==reserved.id)return fail("science_goal_wait_reserved_lineage_changed");
      store.assertScienceTurnExecutionAuthority(reserved);
      // Old source control must also remain current: preparation never grants a new owner epoch/revision.
      store.assertScienceTurnExecutionAuthority(source);
      sourceLoop={id:loop.id,version:Number(basis.loopVersion),stateSha256:basis.loopStateSha256,status:"running",activeRunId:source.invocationRunId};
    } else {
      if(loop.status!=="running"||loop.activeRunId!==source.invocationRunId||latest?.id!==source.id)return fail("science_goal_wait_source_superseded");
      store.assertScienceTurnExecutionAuthority(source);
    }
    if(!allowUnsettled&&source.status!=="completed")return fail("science_goal_wait_source_unsettled");
    if(allowUnsettled&&!["queued","running","completed"].includes(source.status))return fail("science_goal_wait_source_terminal");
    const contract=store.getResearchContractForProject(ref.projectId,loop.contractId);
    const common={ref,ownerBinding:agentContextOwnerBinding(),agentId:chat.agentId,registered,
      contract:contract?{id:contract.id,version:contract.version,status:contract.status}:null,
      control:{...control,loop:null},approvalPolicy:store.approvalPolicy(ref.projectId),runtimeSelection:source.runtimeSelection};
    const sourceStamp=sha({...common,loop:sourceLoop});
    const ownerStamp=sha({...common,loop:{id:loop.id,version:loop.version,stateSha256:loop.stateSha256,status:loop.status,activeRunId:loop.activeRunId}});
    const deadline=budget?.deadlineAt??null;
    const timer=goalTimerAuthorityForOwner({lifecycle:"finite"});
    return {store,source,binding,registered,chat,loop,owner,control,budget,sourceStamp,ownerStamp,deadline,timer,reserved};
  }
  // Strict callers cannot opt into observation mode or receive a nullable owner.
  function facts(ref:Readonly<Ref>,allowUnsettled=false,readOnlyCapture=false) {
    const current=sourceFacts(ref,allowUnsettled,readOnlyCapture,false);
    if(!current.owner)return fail("science_goal_wait_scope_changed");
    return {...current,owner:current.owner};
  }

  function readHostBoundaryObservation(ref:Readonly<Ref>) {
    try {
      const current=sourceFacts(ref,true,true,true);
      const receipt=getInvocationRunReceipt(ref.sourceInvocationId);
      const boundary=readInvocationEffectBoundary({invocationRunId:ref.sourceInvocationId,expectedChatId:ref.chatId,expectedSource:"science"});
      if(!receipt||receipt.chatId!==ref.chatId||receipt.status!=="completed"||receipt.executionPermission!=="full"
        ||!boundary.terminal||boundary.effects!=="settled"||!boundary.terminalEventId||!boundary.receiptEventId)return null;
      const wait=readCanonicalGoalWaitObservation(ref,{sourceStamp:current.sourceStamp,currentStamp:current.ownerStamp});
      if(!wait||!["proposed","pending","prepared"].includes(wait.state))return null;
      // Claimed/unknown and any successor with a runtime receipt follow ordinary host recovery.
      if(current.reserved && (current.reserved.status!=="queued"||getInvocationRunReceipt(current.reserved.invocationRunId)))return null;
      return wait;
    }catch{return null;}
  }

  function emptyReceipt(ref:Readonly<Ref>) {
    const current=facts(ref,true),receipt=getInvocationRunReceipt(ref.sourceInvocationId),proposal=readGoalWaitProposal(ref);
    const event=getRunEventBySource(ref.sourceInvocationId,`goal-wait-proposed:${ref.sourceInvocationId}`);
    const boundary=readInvocationEffectBoundary({invocationRunId:ref.sourceInvocationId,expectedChatId:ref.chatId,expectedSource:"science"});
    const finals=getDb().prepare("SELECT agent_id,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='mcp_final'").all(ref.sourceInvocationId,ref.chatId) as Array<{agent_id:string|null;payload_json:string}>;
    if(!proposal||proposal.status!=="requested"||!event||event.chatId!==ref.chatId||event.kind!=="goal_wait_proposed"
      ||!receipt||receipt.chatId!==ref.chatId||receipt.status!=="completed"||receipt.executionPermission!=="full"
      ||!boundary.terminal||boundary.effects!=="settled"||!boundary.terminalEventId||!boundary.receiptEventId||finals.length!==1
      ||finals[0].agent_id!==current.chat.agentId)return fail("science_goal_wait_empty_receipt_unconfirmed");
    const final=JSON.parse(finals[0].payload_json);
    if(final.textLen!==0)return fail("science_goal_wait_empty_receipt_nonempty");
    if(final.durableMessageId) {
      const message=getDb().prepare("SELECT text FROM chat_messages WHERE id=? AND chat_id=? AND role='assistant'").get(final.durableMessageId,ref.chatId) as {text:string}|undefined;
      if(!message||message.text.trim()!=="")return fail("science_goal_wait_empty_receipt_nonempty");
    }
    return {current,reference:{proposalEventId:event.id,proposalSha256:sha(proposal),terminalEventId:boundary.terminalEventId,receiptEventId:boundary.receiptEventId}};
  }
  function settled(ref:Readonly<Ref>) {
    const current=facts(ref),receipt=getInvocationRunReceipt(ref.sourceInvocationId);
    const empty=current.store.canonicalGoalWaitEmptySettlementReference(ref.projectId,ref.conversationId,ref.sourceTurnId);
    if(empty) {
      const verified=emptyReceipt(ref);
      if(!same(empty,verified.reference))return fail("science_goal_wait_empty_final_changed");
      return current;
    }
    const reference=current.store.canonicalDecisionSourceReference(ref.projectId,ref.conversationId,ref.sourceTurnId);
    const boundary=readInvocationEffectBoundary({invocationRunId:ref.sourceInvocationId,expectedChatId:ref.chatId,expectedSource:"science"});
    const finals=reference?getDb().prepare("SELECT agent_id,payload_json FROM run_events WHERE run_id=? AND chat_id=? AND kind='mcp_final' AND json_valid(payload_json) AND json_extract(payload_json,'$.durableMessageId')=?").all(ref.sourceInvocationId,ref.chatId,reference.sourceMessageId) as Array<{agent_id:string|null;payload_json:string}>:[];
    const final=finals.length===1?JSON.parse(finals[0].payload_json):null;
    const message=reference&&getDb().prepare("SELECT text FROM chat_messages WHERE id=? AND chat_id=? AND role='assistant'").get(reference.sourceMessageId,ref.chatId) as {text:string}|undefined;
    const raw=message?createHash("sha256").update(message.text,"utf8").digest("hex"):null;
    if(!receipt||receipt.chatId!==ref.chatId||receipt.status!=="completed"||receipt.executionPermission!=="full"
      ||!boundary.terminal||boundary.effects!=="settled"||!boundary.terminalEventId||!boundary.receiptEventId
      ||!reference?.sourceRawContentSha256||reference.sourceRawContentSha256!==raw||finals[0]?.agent_id!==current.chat.agentId
      ||final?.durableMessageId!==reference.sourceMessageId)return fail("science_goal_wait_source_receipt_unconfirmed");
    return current;
  }
  const provider:CanonicalGoalWaitOwnerProvider={domain:"science",
    assertCurrentOwner(owner) {const actual=ports.owner();if(!actual||!same(actual,owner))return fail("science_goal_wait_owner_changed");ports.assertCurrentOwner(owner);},
    resolveSource({chatId,sourceInvocationId}) {
      try {
        const store=scienceStore(),source=store.getTurnByInvocationRunId(sourceInvocationId),loop=source&&store.getActiveLoopSession(source.projectId);
        if(!source||source.runtimeChatId!==chatId||!loop)return null;
        const ref:Ref={domain:"science",projectId:source.projectId,conversationId:source.conversationId,loopSessionId:loop.id,
          chatId,sourceTurnId:source.id,sourceInvocationId};
        settled(ref);return ref;
      }catch{return null;}
    },
    readOwner(ref) {
      try {
        const current=settled(ref),token=Object.freeze({});
        tokens.set(token,{ref:Object.freeze({...ref}),sourceStamp:current.sourceStamp,ownerStamp:current.ownerStamp});
        return {ref:Object.freeze({...ref}),ownerStamp:current.ownerStamp,sourceStamp:current.sourceStamp,
          preparedRunId:current.reserved?.invocationRunId??null,owner:current.owner,sourceSettled:true,resourceDeadline:current.deadline,
          timerAuthority:current.timer,state:current.reserved?"held":"source-settled",sourceToken:token} as CanonicalGoalWaitOwnerSnapshot;
      } catch {return null;}
    },
    authorizeInvocationSubject(token,subject) {
      try {
        const retained=tokens.get(token);if(!retained)return false;
        const source=settled(retained.ref);if(source.sourceStamp!==retained.sourceStamp)return false;
        const target=source.store.getTurnByInvocationRunId(subject.invocationRunId);
        const targetBinding=target&&source.store.getConversationRuntimeBinding(target.projectId,target.conversationId);
        const reverse=targetBinding&&source.store.getConversationScopeForRuntimeChat(targetBinding.runtimeChatId);
        return Boolean(target&&target.projectId===retained.ref.projectId&&target.runtimeChatId===subject.chatId
          &&targetBinding?.runtimeChatId===subject.chatId&&reverse?.projectId===target.projectId&&reverse.conversationId===target.conversationId);
      } catch {return false;}
    },
    holdCurrentSource({sourceToken,waitId}) {
      const retained=tokens.get(sourceToken);if(!retained)return fail("science_goal_wait_source_token_required");
      const current=settled(retained.ref),wait=ports.intake.read(retained.ref);
      if(current.ownerStamp!==retained.ownerStamp||!wait||wait.waitId!==waitId)return fail("science_goal_wait_hold_changed");
      // The actual persisted common record is the hold. SDK guards read that same record; no shadow SDK state.
    },
    prepareContinuation({sourceToken,waitId,reservedRunId,expectedOwnerStamp,observationData}) {
      ports.assertExecution();
      const retained=tokens.get(sourceToken);if(!retained)return fail("science_goal_wait_source_token_required");
      const current=settled(retained.ref),wait=ports.intake.read(retained.ref);
      if(current.ownerStamp!==expectedOwnerStamp||current.sourceStamp!==retained.sourceStamp||wait?.waitId!==waitId
        ||wait.reservedRunId!==reservedRunId)return fail("science_goal_wait_preparation_currentness_failed");
      const input:Input={ref:retained.ref,waitId,reservedRunId,expectedOwnerStamp,hostObservation:goalWaitObservationPart(observationData)};
      const record={ref:retained.ref,sourceStamp:current.sourceStamp,postStamp:null as string|null,inputStamp:expectedOwnerStamp,inputSha256:sha(input),waitId,reservedRunId};inputs.set(input,record);
      const packet=(scienceConversationService() as unknown as Conversations).prepareHostGoalWaitContinuation(input);
      const after=settled(retained.ref);
      if(after.reserved?.invocationRunId!==reservedRunId||after.sourceStamp!==record.sourceStamp)return fail("science_goal_wait_post_preparation_changed");
      record.postStamp=after.ownerStamp;
      const opaque=Object.freeze({});packets.set(opaque,{packet,input,sourceStamp:record.sourceStamp,postStamp:after.ownerStamp});return opaque;
    },
    admitAndStart(opaque) {
      ports.assertExecution();
      const retained=packets.get(opaque);if(!retained)return fail("science_goal_wait_prepared_required");
      sdkHost.assertPreparation(retained.input,"start");
      const result=(scienceConversationService() as unknown as Conversations).startPreparedHostGoalWait(retained.packet);
      if(result.start){packets.delete(opaque);return result;}
      return {...result,retryAt:result.retryAt??new Date(Date.now()+1000).toISOString()};
    },
    continuationReceipt({ref,waitId,reservedRunId}) {
      const wait=ports.intake.read(ref);if(wait?.waitId!==waitId||wait.reservedRunId!==reservedRunId)return null;
      const store=scienceStore() as Store,turn=store.getTurnByInvocationRunId(reservedRunId),receipt=getInvocationRunReceipt(reservedRunId);
      if(!turn||turn.projectId!==ref.projectId||turn.conversationId!==ref.conversationId||turn.parentTurnId!==ref.sourceTurnId
        ||turn.runtimeChatId!==ref.chatId||!receipt||receipt.chatId!==ref.chatId)return null;
      if(!["running","completed","failed","cancelled","interrupted"].includes(receipt.status))return null;
      return {runId:reservedRunId,status:receipt.status as "running"|"completed"|"failed"|"cancelled"|"interrupted"};
    },
    releaseHold({ref,waitId}) {
      const wait=ports.intake.read(ref);
      if(wait?.waitId===waitId&&["pending","prepared","claimed"].includes(wait.state))return fail("science_goal_wait_release_before_shared_terminal");
      // No independent SDK hold exists. A shared terminal transition releases every SDK reader;
      // never call shared cancel from its release notification (that would recurse).
    },
  };
  const sdkHost={
    prepareEmptySettlement(input:{projectId:string;conversationId:string;turnId:string;invocationRunId:string}):object|null {
      try {
        ports.assertExecution();
        const store=scienceStore(),source=store.getTurnForProject(input.projectId,input.turnId),loop=store.getActiveLoopSession(input.projectId);
        if(!source||source.conversationId!==input.conversationId||source.invocationRunId!==input.invocationRunId||!loop)return null;
        const ref:Ref={domain:"science",projectId:input.projectId,conversationId:input.conversationId,loopSessionId:loop.id,chatId:source.runtimeChatId,sourceTurnId:source.id,sourceInvocationId:source.invocationRunId};
        const verified=emptyReceipt(ref),token=Object.freeze({});emptyTokens.set(token,{ref,stamp:verified.current.ownerStamp,reference:verified.reference});return token;
      }catch{return null;}
    },
    assertEmptySettlement(token:object,input:{projectId:string;conversationId:string;turnId:string;invocationRunId:string}):EmptyReference {
      ports.assertExecution();
      const retained=emptyTokens.get(token);
      if(!retained||retained.ref.projectId!==input.projectId||retained.ref.conversationId!==input.conversationId
        ||retained.ref.sourceTurnId!==input.turnId||retained.ref.sourceInvocationId!==input.invocationRunId)return fail("science_goal_wait_empty_token_required");
      const verified=emptyReceipt(retained.ref);
      if(verified.current.ownerStamp!==retained.stamp||!same(verified.reference,retained.reference))return fail("science_goal_wait_empty_token_stale");
      return {...verified.reference};
    },
    // Scheduling-only denial: deliberately separate from facts/capture/prepare authority.
    readAutomaticHold(input:{projectId:string;conversationId:string;turnId:string;invocationRunId:string;prospectiveRequestId?:string}) {
      const store=scienceStore() as Store,initial=store.getTurnForProject(input.projectId,input.turnId);
      const binding=store.getConversationRuntimeBinding(input.projectId,input.conversationId);
      if (!initial || initial.conversationId!==input.conversationId || initial.invocationRunId!==input.invocationRunId
        || !binding || initial.runtimeChatId!==binding.runtimeChatId) return fail("science_goal_wait_hold_scope_invalid");
      if (store.getResearchAssistantTaskForConversation(input.projectId,input.conversationId)
        || store.peerReview().refereeRoleForConversation(input.projectId,input.conversationId)) return null;
      const nativeResume=(candidate:typeof input):boolean=>{
        const resume=store.canonicalGoalWaitResumeReference(candidate);
        if (!resume) return false;
        const workload=scienceLongRunId(input.projectId);
        const event=getRunEventBySource(`goal-owner-control:${workload}`,`owner-control:${resume.requestId}`);
        return Boolean(event && event.chatId===binding.runtimeChatId && event.kind==="goal_wake_owner_control"
          && event.payload.longRunId===workload && event.payload.cause==="resume");
      };
      // Before a new turn exists, only the exact current queued domain receipt plus native UUID may supersede its source wait.
      if (input.prospectiveRequestId && nativeResume(input)) return null;
      const loops=store.listLoopSessions(input.projectId).filter(loop=>loop.runtimeChatId===binding.runtimeChatId);
      const seen=new Set<string>();let turn:typeof initial|null=initial;
      for (;turn&&!seen.has(turn.id);) {
        if (turn.projectId!==input.projectId || turn.conversationId!==input.conversationId || turn.runtimeChatId!==binding.runtimeChatId)
          return fail("science_goal_wait_hold_lineage_invalid");
        seen.add(turn.id);
        for (const loop of loops) {
          const ref:Ref={domain:"science",projectId:turn.projectId,conversationId:turn.conversationId,
            loopSessionId:loop.id,chatId:turn.runtimeChatId,sourceTurnId:turn.id,sourceInvocationId:turn.invocationRunId};
          const wait=readCanonicalGoalWaitObservation(ref);
          if (wait) return {waitId:wait.waitId,state:wait.state};
        }
        // Read this turn's own wait before cutting older ancestry at a genuine owner boundary.
        if (nativeResume({projectId:turn.projectId,conversationId:turn.conversationId,turnId:turn.id,invocationRunId:turn.invocationRunId})) return null;
        // A genuine applied owner directive is an authority boundary, not an inferred schema name.
        if (turn.origin === "loop-continuation" && store.listSteering(input.projectId,input.conversationId).some(receipt=>
          receipt.successorTurnId===turn!.id && receipt.status==="applied" && receipt.intent!=="stop")) return null;
        // Stop at each actual fresh user turn; never cross a new owner request into an old wait.
        if (turn.origin!=="loop-continuation" || !turn.parentTurnId) return null;
        turn=store.getTurnForProject(input.projectId,turn.parentTurnId);
      }
      if (turn) return fail("science_goal_wait_hold_lineage_unresolved");
      return null;
    },
    read(ref:Readonly<Ref>,options?:{forHostBoundary?:true}) {try {
      if(options?.forHostBoundary)return readHostBoundaryObservation(ref);
      facts(ref,true);
      const wait=ports.intake.read(ref);
      if(wait?.state==="proposed") {
        const receipt=getInvocationRunReceipt(ref.sourceInvocationId);
        const boundary=readInvocationEffectBoundary({invocationRunId:ref.sourceInvocationId,expectedChatId:ref.chatId,expectedSource:"science"});
        if(!receipt||receipt.chatId!==ref.chatId||receipt.status!=="completed"||receipt.executionPermission!=="full"
          ||!boundary.terminal||boundary.effects!=="settled"||!boundary.terminalEventId||!boundary.receiptEventId)return null;
      }
      return wait;
    }catch{return null;}},
    hold({ref}:{ref:Readonly<Ref>;proposal?:unknown}) {
      try {settled(ref);return ports.intake.hold({ref});}catch(error){return {status:"refused" as const,code:(error as {code?:string}).code??"science_goal_wait_owner_unavailable"};}
    },
    assertPreparation(input:Input,phase:"prepare"|"start") {
      const retained=inputs.get(input);if(!retained)return fail("science_goal_wait_opaque_preparation_required");
      const current=settled(retained.ref),wait=ports.intake.read(retained.ref);
      if(!same(input.ref,retained.ref)||wait?.waitId!==retained.waitId||wait.reservedRunId!==retained.reservedRunId
        ||(phase==="prepare"?!["pending","prepared"].includes(wait.state):wait.state!=="claimed")
        ||current.sourceStamp!==retained.sourceStamp||input.expectedOwnerStamp!==retained.inputStamp||sha(input)!==retained.inputSha256
        ||phase==="start"&&(!retained.postStamp||current.ownerStamp!==retained.postStamp))return fail("science_goal_wait_preparation_stale");
    },
    cancel(input:{projectId:string;conversationId:string;turnId:string;invocationRunId:string}) {
      const store=scienceStore() as Store,turn=store.getTurnForProject(input.projectId,input.turnId);
      if(!turn||turn.conversationId!==input.conversationId||turn.invocationRunId!==input.invocationRunId)return fail("science_goal_wait_cancel_scope_invalid");
      // The canonical loop may already be cancelled by the native control entry.
      // Cancel only the actual turn's exact shared scope; never infer a replacement loop or grant.
      ports.cancelScope({domain:"science",projectId:turn.projectId,conversationId:turn.conversationId,
        chatId:turn.runtimeChatId},"owner_stop");
    },
  };
  function capture(context:InvocationExecutionContext|undefined,runId:string,chatId:string,permission:string):object|null {
    try {
      if(context?.source!=="science"||!context.science||permission!=="full")return null;
      const science=context.science,store=scienceStore(),source=store.getTurnByInvocationRunId(runId),loop=source&&store.getActiveLoopSession(source.projectId);
      if(!source||!loop||source.id!==science.turnId||source.projectId!==science.projectId||source.conversationId!==science.conversationId
        ||source.invocationRunId!==science.invocationRunId||source.runtimeChatId!==chatId)return null;
      const ref:Ref={domain:"science",projectId:source.projectId,conversationId:source.conversationId,loopSessionId:loop.id,chatId,sourceTurnId:source.id,sourceInvocationId:runId};
      const current=facts(ref,true,true),lease=invocationRunOwners.getRunOwner(chatId,runId),process=invocationProcessOwner();
      if(!lease||lease.ownerId!==process.ownerId||lease.ownerKind!==process.ownerKind)return null;assertInvocationRunOwner(lease);

      const token=Object.freeze({});captures.set(token,{ref,stamp:current.ownerStamp,owner:lease});return token;
    }catch{return null;}
  }
  function currentCapture(token:object) {
    try {const retained=captures.get(token);if(!retained?.owner)return null;assertInvocationRunOwner(retained.owner);
      const current=facts(retained.ref,true,true);if(current.ownerStamp!==retained.stamp)return null;
      return {ref:retained.ref,goalId:retained.ref.loopSessionId,timer:current.timer,deadlineAt:null,resourceDeadline:current.deadline};
    }catch{return null;}
  }
  return {provider,sdkHost,capture,currentCapture};
}
export function installScienceCanonicalGoalWaitOwner(value:ReturnType<typeof createScienceCanonicalGoalWaitOwner>|null):void {installed=value;}
export function captureCanonicalGoalWaitSource(context:InvocationExecutionContext|undefined,runId:string,chatId:string,permission:string):object|null {
  return installed?.capture(context,runId,chatId,permission)??null;
}
export function currentCanonicalGoalWaitSource(token:object) {return installed?.currentCapture(token)??null;}
