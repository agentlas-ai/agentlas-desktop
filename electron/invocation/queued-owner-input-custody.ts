import { isTransientRunFailureCode, sendRefusalCode } from "../../shared/transient-send-refusal";
import { canQueuePendingSend } from "./pending-chat-sends";
import { randomUUID, createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChatHistoryEntry, McpInvocationRequest } from "../../shared/types";
import { getAuthSession } from "../auth";
import { getChat, getChatWorkingFolder } from "../store/chats";
import { getProject } from "../store/projects";
import { getSeatForChat } from "../store/seats";
import { ensureCanonicalTaskForChat } from "../store/tasks";
import { getInvocationAdmission, canonicalInvocationRequestJson, INVOCATION_ADMISSION_DIGEST_VERSION } from "../store/invocation-admissions";
import { getInvocationRunReceipt } from "../store/run-events";
import { createQueuedOwnerInputStore, type QueuedOwnerInputRow } from "../store/queued-owner-inputs";
import { userDataPath } from "../runtime-paths";
import { QueuedInputEscrow, queuedInputDigest, queuedInputRequestDigest, type QueuedInputOwner } from "../one/queued-input-escrow";
import { reserveOneAttachmentsForQueue, reissueQueuedOneAttachments, releaseOneAttachmentRun, discardOneAttachments } from "../one/attachments";
import { reserveOneTeamPreflightForQueue, reissueQueuedOneTeamPreflight, failOneTeamPreflightStart, type OneTeamPreflightDependencies } from "../one/team-preflight";

/** Only IPC's original start source calls this immediately before handing its
 * exact reserved request to the native driver. Never accepted from renderer. */
export interface QueuedOwnerStartBoundary { enterSource(): void }
export interface QueuedOwnerInputCustodyOptions {
  db: Database.Database;
  epoch: string;
  running(runId: string): boolean;
  placement(runId: string): "placed"|"not-dispatched"|"unconfirmed";
  root?: string;
  accountDigest?(): string;
  teamDependencies?: OneTeamPreflightDependencies;
}
function currentAccountDigest(): string {
  const session = getAuthSession();
  if (session.signedIn && !session.accountFingerprint) throw new Error("queued_input_account_unknown");
  return queuedInputDigest({ signedIn: session.signedIn, account: session.accountFingerprint ?? null, workspace: session.workspaceId ?? null });
}
function currentScopeDigest(request: McpInvocationRequest): string {
  const chat = getChat(request.chatId);
  const seat = getSeatForChat(request.chatId);
  const task = request.oneTeamPreflightRef ? ensureCanonicalTaskForChat(request.chatId) : null;
  if (!chat || chat.archivedAt) throw new Error("queued_input_chat_unavailable");
  // A title, transcript timestamp or Main-created Goal does not revoke saved
  // owner words. Execution subject, runtime pin and explicit team Task do.
  return queuedInputDigest({ agentId: chat.agentId, firmId: chat.firmId, projectId: chat.projectId,
    workingFolder: getChatWorkingFolder(request.chatId),
    projectFolder: chat.projectId ? getProject(chat.projectId)?.folderPath ?? null : null,
    originSurface: chat.originSurface, runtimeSelection: chat.runtimeSelection ?? null,
    seatId: chat.seatId ?? null, participants: chat.participants?.map(({slot,agentId}) => ({slot,agentId})) ?? null,
    seat: seat ? {id:seat.id,kind:seat.kind,projectId:seat.projectId,archivedAt:seat.archivedAt,dissolvedAt:seat.dissolvedAt,
      occupants:seat.occupants.map(({slot,agentId}) => ({slot,agentId}))} : null,
    ...(request.oneTeamPreflightRef ? { taskId: task?.id ?? null, taskVersion: task?.version ?? null } : {}) });
}
export function createQueuedOwnerInputCustody(options: QueuedOwnerInputCustodyOptions) {
  const {db,epoch} = options, store = createQueuedOwnerInputStore(db);
  const account = options.accountDigest ?? currentAccountDigest;
  const original = (row: QueuedOwnerInputRow) => JSON.parse(row.request_json) as McpInvocationRequest;
  const assertOwner = (owner: QueuedInputOwner, queueId: string|null, operation: string) => {
    const row = store.exact(owner);
    // Stop and cleanup must remain unconditional even after sign-out or a
    // changed room. Neither grants another execution capability.
    if (operation === "cancel") return;
    if (row.queue_id !== queueId) throw new Error("queued_input_queue_changed");
    if (row.state !== "active" || operation !== "complete" && (row.account_digest !== account() || row.scope_digest !== currentScopeDigest(original(row)))) {
      throw new Error("queued_input_owner_changed");
    }
    if (queueId) {
      const queued = db.prepare("SELECT chat_id,request_json,state FROM pending_chat_sends WHERE id=?").get(queueId) as {chat_id:string;request_json:string;state:string}|undefined;
      if (!queued || queued.chat_id !== owner.chatId || queuedInputRequestDigest(JSON.parse(queued.request_json) as McpInvocationRequest) !== owner.requestDigest
        || operation !== "complete" && !(operation === "recover" ? ["queued","starting","started","held","uncertain","failed","gave_up"] : ["queued","starting","started"]).includes(queued.state)) throw new Error("queued_input_queue_changed");
    }
  };
  const placement = (runId: string): "placed"|"not-dispatched"|"unconfirmed" => {
    const attempt = store.attempt(runId);
    // Custody owns only attachment/team input. A run no custody row knows is plain text: the host's own typed facts decide it
    // (renderer-send-queue.ts queuedSendPlacement), exactly as when no custody is wired. Answering "unconfirmed" for it made every
    // finished plain message "uncertain" and kept a refused-before-dispatch one from starting again. A custody-owned run that has
    // no attempt row yet stays conservative.
    if (!attempt) return store.byRun(runId) ? "unconfirmed" : options.placement(runId);
    if (options.running(runId)) return "unconfirmed";
    const row = store.byOwner(attempt.owner_id);
    if (!row) return "unconfirmed";
    if (attempt.state === "reserved") {
      // The queued dispatch identity was committed before any source could be
      // entered. Closing this exact phase wins the CAS against begin(); a live
      // caller that loses it cannot start. This is a positive host marker,
      // not an inference from a missing receipt or process death.
      const queued=row.queue_id ? db.prepare("SELECT run_id,state FROM pending_chat_sends WHERE id=?").get(row.queue_id) as {run_id:string;state:string}|undefined : undefined;
      if (queued?.run_id!==runId || queued.state!=="starting" || getInvocationAdmission(runId) || getInvocationRunReceipt(runId)) return "unconfirmed";
      return store.closeReserved(runId) ? "not-dispatched" : "unconfirmed";
    }
    const fact = options.placement(runId);
    if (fact === "placed") return "placed";
    // Typed Main closure is independent of a missing invocation receipt. Only
    // the exact original caller can write it while its source is unentered.
    if (attempt.state === "closed-before-source" && attempt.closed_at !== null) return "not-dispatched";
    const admission = getInvocationAdmission(runId);
    if (admission?.status === "rejected" && admission.chatId === row.chat_id) {
      const canonical = db.prepare("SELECT canonical_digest FROM queued_owner_input_admissions WHERE run_id=?").get(runId) as {canonical_digest:string}|undefined;
      if (canonical && admission.inputDigest === canonical.canonical_digest) return "not-dispatched";
    }
    return fact;
  };
  // Admission digests bind a rejected native attempt to the exact regenerated
  // envelope. Never write/repair invocation receipts or their authority here.
  db.exec("CREATE TABLE IF NOT EXISTS queued_owner_input_admissions (run_id TEXT PRIMARY KEY REFERENCES queued_owner_input_attempts(run_id), canonical_digest TEXT NOT NULL)");
  const escrow = new QueuedInputEscrow({root:options.root ?? userDataPath("queued-owner-inputs-v1"),
    withOwnerLock: (_owner,fn) => db.transaction(fn).immediate(), assertOwner,
    assertAdoption: (owner,id,previousId) => {
      const row=store.exact(owner);
      if (row.queue_id !== id || row.state !== "active") throw new Error("queued_input_adoption_changed");
      if (previousId && previousId !== id && db.prepare("SELECT 1 FROM pending_chat_sends WHERE id=?").get(previousId)) throw new Error("queued_input_adoption_changed");
      assertOwner(owner,id,"adopt");
    }, sealResource:store.seal, assertResource:store.assertResource, attemptHead:store.attemptHead, sealAttempt:store.sealAttempt, placement });
  const finish = (row: QueuedOwnerInputRow, outcome:"placed"|"cancelled") => db.transaction(() => {
    const owner=store.ownerOf(row);
    const last=db.prepare("SELECT run_id FROM queued_owner_input_attempts WHERE owner_id=? ORDER BY rowid DESC LIMIT 1").get(owner.ownerId) as {run_id:string}|undefined;
    escrow.finish(owner,outcome,{queueId:row.queue_id,lastRunId:last?.run_id ?? null});
    if (outcome === "placed") cancelResources(row);
    store.retire(owner,outcome);
  }).immediate();
  const cancelResources = (row: QueuedOwnerInputRow) => {
    const request=original(row);
    const last=db.prepare("SELECT run_id FROM queued_owner_input_attempts WHERE owner_id=? ORDER BY rowid DESC LIMIT 1").get(row.owner_id) as {run_id:string}|undefined;
    if (request.oneTeamPreflightRef) failOneTeamPreflightStart({...request.oneTeamPreflightRef,reservedRunId:last?.run_id ?? row.origin_run_id});
    // Only a still-prepared original is discarded. A claimed run copy belongs
    // to the native run lifetime and is released after that run quiesces.
    if (request.oneAttachmentRef) discardOneAttachments({ref:request.oneAttachmentRef});
    // A retry may have minted a different pending ref before its start failed.
    // Revoke only still-prepared copies; a claimed run's own teardown retains
    // responsibility for its live input files until it quiesces.
    for (const refs of store.cleanupRefs(store.ownerOf(row))) {
      if (refs.oneTeamPreflightRef) failOneTeamPreflightStart(refs.oneTeamPreflightRef);
      if (refs.oneAttachmentRef) discardOneAttachments({ref:refs.oneAttachmentRef});
    }
  };
  const reconcile = () => {
    for (const row of store.active()) {
      if (row.state === "cancelled") { try { cancelResources(row); finish(row,"cancelled"); } catch { /* Retry exact cleanup later. */ } continue; }
      const attempts=db.prepare("SELECT run_id FROM queued_owner_input_attempts WHERE owner_id=? ORDER BY rowid DESC LIMIT 1").get(row.owner_id) as {run_id:string}|undefined;
      if (attempts && placement(attempts.run_id)==="placed") {
        try {
          if (row.queue_id) db.prepare("UPDATE pending_chat_sends SET state='started',updated_at=? WHERE id=? AND run_id=? AND state IN ('starting','held','uncertain','failed','gave_up')")
            .run(Date.now(),row.queue_id,attempts.run_id);
          finish(row,"placed");
        } catch { /* Exact ownership/cleanup remains pending; never replay. */ }
      }
    }
  };
  const ownsInput = (request:McpInvocationRequest) => request.promptOrigin !== "system" && !request.agentAppMode
    && Boolean(request.oneAttachmentRef || request.oneTeamPreflightRef);
  const canHold = (request:McpInvocationRequest): boolean => {
    const row=request.runId ? store.byOrigin(request.runId) : undefined;
    if (!row || row.state!=="active" || row.queue_id || row.account_digest!==account()
      || row.request_digest!==queuedInputRequestDigest(request) || options.running(row.origin_run_id)) return false;
    return row.capture_complete===1 || !store.attempt(row.origin_run_id)
      && !getInvocationAdmission(row.origin_run_id) && !getInvocationRunReceipt(row.origin_run_id);
  };
  const capture = (request: McpInvocationRequest): void => {
    if (!ownsInput(request)) return;
    if (!request.runId) request.runId=request.oneTeamPreflightRef?.reservedRunId ?? randomUUID();
    if (store.byRun(request.runId) || getInvocationAdmission(request.runId) || getInvocationRunReceipt(request.runId)) throw new Error("queued_input_run_identity_exists");
    // Reconcile semantic Task scope under the same writer transaction as the
    // provisional owner. A stale capability is then held, without losing text.
    const owner=db.transaction(() => store.create(request,account(),currentScopeDigest(request))).immediate();
    try {
      // Capture independently valid resources even when another capability is
      // stale. A stale team must not discard otherwise approved upload bytes.
      let failed=false, failure:unknown;
      const reserve=(fn:()=>unknown) => { try { fn(); } catch(error) { if (!failed) failure=error; failed=true; } };
      if (request.oneTeamPreflightRef) reserve(() => reserveOneTeamPreflightForQueue(escrow,owner,request.oneTeamPreflightRef!,options.teamDependencies));
      if (request.oneAttachmentRef) reserve(() => reserveOneAttachmentsForQueue(escrow,owner,{ref:request.oneAttachmentRef!,userPrompt:request.userPrompt,teamProposalId:request.oneTeamPreflightRef?.proposalId}));
      if (failed) throw failure;
      store.captureComplete(owner);
    } catch (error) {
      // This Main call has never entered a source. Retain the owner's words
      // and any sealed bytes as held input; incomplete capture grants nothing.
      try { store.hold(owner,sendRefusalCode(error) ?? "queued_input_capture_incomplete"); } catch { /* Exact ownership stays in the durable row. */ }
      throw error;
    }
  };
  return {
    capture, placement, reconcile, canHold,
    savedUserRow(request:McpInvocationRequest): ChatHistoryEntry|null {
      const row=request.runId ? store.byOrigin(request.runId) : undefined;
      if (!row || row.request_digest!==queuedInputRequestDigest(request)) return null;
      // Only Main's exact durable binding can reuse a row. Text/time matching
      // would merge two different owner messages that happen to say the same thing.
      const rows=db.prepare(`SELECT DISTINCT m.id,m.text,m.created_at FROM run_events e
        JOIN chat_messages m ON m.id=json_extract(CASE WHEN json_valid(e.payload_json) THEN e.payload_json ELSE '{}' END,'$.promptMessageId')
        AND m.chat_id=e.chat_id AND m.role='user'
        WHERE e.run_id=? AND e.chat_id=? AND e.kind='invoke_prompt_bound'`).all(row.origin_run_id,row.chat_id) as {id:string;text:string;created_at:string}[];
      if (rows.length>1 || rows.length===1 && rows[0].text!==request.userPrompt) throw new Error("queued_input_prompt_binding_ambiguous");
      return rows.length===1 ? {id:rows[0].id,durableMessageId:rows[0].id,role:"user",text:rows[0].text,createdAt:rows[0].created_at} : null;
    },
    captureHeld(request:McpInvocationRequest): boolean {
      const row=request.runId ? store.byOrigin(request.runId) : undefined;
      return Boolean(row && row.state === "active" && row.capture_complete===0 && !row.queue_id
        && row.request_digest===queuedInputRequestDigest(request) && !store.attempt(row.origin_run_id)
        && !getInvocationAdmission(row.origin_run_id) && !getInvocationRunReceipt(row.origin_run_id));
    },
    adoptHeld(request:McpInvocationRequest,queueId:string,code:string):void {
      const row=request.runId ? store.byOrigin(request.runId) : undefined;
      if (!row || !canHold(request)) throw new Error("queued_input_owner_changed");
      store.adopt(store.ownerOf(row),queueId);
      store.hold(store.ownerOf(row),code);
      // Prepared capabilities must not survive as a parallel start lane. A
      // claimed live run's own media remains under its native teardown.
      if (request.oneAttachmentRef) discardOneAttachments({ref:request.oneAttachmentRef});
      if (request.oneTeamPreflightRef) failOneTeamPreflightStart(request.oneTeamPreflightRef);
    },
    reserveStart(queueId:string,request:McpInvocationRequest,markStarting:()=>void):void {
      db.transaction(() => {
        const row=store.byQueue(queueId);
        if (!row || row.request_digest!==queuedInputRequestDigest(request)) throw new Error("queued_input_owner_changed");
        const owner=store.ownerOf(row);
        assertOwner(owner,queueId,"attempt");
        store.reserve(owner,request,epoch);
        markStarting();
      }).immediate();
    },
    persistentInput(queueId:string): boolean {
      const row=store.byQueue(queueId);
      return Boolean(row && row.state === "active" && row.capture_complete === 1 && row.cleanup_done === 0);
    },
    hold(queueId:string,code:string):void {
      const row=store.byQueue(queueId);
      if (row?.state === "active") store.hold(store.ownerOf(row),code);
    },
    readyForQueue(queueId:string): boolean {
      const row=store.byQueue(queueId);
      if (!row || row.state !== "active" || row.capture_complete!==1 || row.hold_code) return false;
      try { assertOwner(store.ownerOf(row),queueId,"attempt"); return true; } catch { return false; }
    },
    resumeHeldQueues(restoreAuthority=false): {chatId:string;queueId:string}[] {
      return db.transaction(() => {
        const resumed: {chatId:string;queueId:string}[]=[];
        for (const row of store.active()) {
          if (row.state !== "active" || !row.queue_id || !row.hold_code
            || !restoreAuthority && row.hold_code!=="queued_input_authority_unavailable" && !isTransientRunFailureCode(row.hold_code)) continue;
          const last=db.prepare("SELECT run_id FROM queued_owner_input_attempts WHERE owner_id=? ORDER BY rowid DESC LIMIT 1").get(row.owner_id) as {run_id:string}|undefined;
          if (last ? placement(last.run_id)!=="not-dispatched"
            : row.capture_complete!==1 || options.running(row.origin_run_id) || getInvocationAdmission(row.origin_run_id) || getInvocationRunReceipt(row.origin_run_id)) continue;
          try { assertOwner(store.ownerOf(row),row.queue_id,"recover"); } catch { continue; }
          const changed=db.prepare("UPDATE pending_chat_sends SET state='queued',run_id=NULL,refused_since=NULL,not_before=NULL,updated_at=? WHERE id=? AND state IN ('held','uncertain','failed','gave_up')")
            .run(Date.now(),row.queue_id);
          if (changed.changes===1) {
            // A first-source refusal was adopted as storage only. The typed
            // no-effect proof above now permits binding its sealed media lane.
            escrow.adopt(store.ownerOf(row),row.queue_id);
            store.hold(store.ownerOf(row),null);
            resumed.push({chatId:row.chat_id,queueId:row.queue_id});
          }
        }
        return resumed;
      }).immediate();
    },
    recoverableRequests(restoreAuthority=false): McpInvocationRequest[] {
      return db.transaction(() => store.active().filter(row => {
        if (row.state !== "active" || row.queue_id || !ownsInput(original(row)) || !canQueuePendingSend(original(row),true)) return false;
        if (row.capture_complete!==1) {
          const request=original(row),owner=store.ownerOf(row);
          const kinds: ("attachments"|"team")[]=[];
          if (request.oneAttachmentRef) kinds.push("attachments");
          if (request.oneTeamPreflightRef) kinds.push("team");
          try {
            if (getInvocationAdmission(row.origin_run_id) || getInvocationRunReceipt(row.origin_run_id)
              || !escrow.confirmCaptured(owner,kinds)) return false;
            store.captureComplete(owner);
          } catch { return false; } // Incomplete capture remains owned, never guessed or deleted.
        }
        const last=db.prepare("SELECT run_id FROM queued_owner_input_attempts WHERE owner_id=? ORDER BY rowid DESC LIMIT 1").get(row.owner_id) as {run_id:string}|undefined;
        if (last && placement(last.run_id) !== "not-dispatched") return false;
        if (!last && (options.running(row.origin_run_id) || getInvocationAdmission(row.origin_run_id) || getInvocationRunReceipt(row.origin_run_id))) return false;
        if (row.hold_code && !restoreAuthority && !isTransientRunFailureCode(row.hold_code)) return false;
        try { assertOwner(store.ownerOf(row),null,"adopt"); if (row.hold_code) store.hold(store.ownerOf(row),null); return true; } catch { return false; }
      }).map(original)).immediate();
    },
    heldRequests(): McpInvocationRequest[] {
      // A crash during capture may leave bytes incomplete. Surface the owned
      // text as held without treating a missing media manifest as a grant.
      let currentAccount:string;
      try { currentAccount=account(); } catch { return []; } // Auth is still restoring; keep input, not a startup exception.
      return store.active().filter(row => row.state === "active" && !row.queue_id && row.capture_complete===0
        && row.account_digest===currentAccount && !store.attempt(row.origin_run_id)
        && !getInvocationAdmission(row.origin_run_id) && !getInvocationRunReceipt(row.origin_run_id))
        .map(original).filter(request => ownsInput(request) && canQueuePendingSend(request,true));
    },
    existing(request:McpInvocationRequest): QueuedOwnerInputRow|undefined {
      const row=request.runId ? store.byOrigin(request.runId) : undefined;
      if (row && row.request_digest !== queuedInputRequestDigest(request)) throw new Error("queued_input_owner_changed");
      return row;
    },
    canQueue(request:McpInvocationRequest): boolean {
      const row=request.runId ? store.byRun(request.runId) : undefined;
      if (!row || row.state!=="active") return false;
      const attempt=store.attempt(request.runId!);
      return row.request_digest===queuedInputRequestDigest(request) || attempt?.request_digest===queuedInputRequestDigest(request);
    },
    adopt(request:McpInvocationRequest,queueId:string):void {
      if (!request.oneAttachmentRef && !request.oneTeamPreflightRef) return;
      const row=request.runId ? store.byOrigin(request.runId) : undefined;
      if (!row || row.request_digest!==queuedInputRequestDigest(request)) throw new Error("queued_input_owner_changed");
      const owner=store.ownerOf(row);
      store.adopt(owner,queueId);
      escrow.adopt(owner,queueId);
      // The original one-use refs must not remain a parallel execution lane.
      if (request.oneAttachmentRef) releaseOneAttachmentRun(request.oneAttachmentRef);
      if (request.oneTeamPreflightRef) failOneTeamPreflightStart(request.oneTeamPreflightRef);
    },
    async start<T>(request:McpInvocationRequest,queueId:string|null,start:(request:McpInvocationRequest,boundary:QueuedOwnerStartBoundary)=>Promise<T>):Promise<T> {
      const row=queueId ? store.byQueue(queueId) : request.runId ? store.byOrigin(request.runId) : undefined;
      if (!row) {
        if (ownsInput(request)) throw new Error("queued_input_custody_required");
        return start(request,{enterSource(){}});
      }
      const owner=store.ownerOf(row);
      assertOwner(owner,queueId,"attempt");
      if (!request.runId) throw new Error("queued_input_run_required");
      let entered=false, freshTeam:McpInvocationRequest["oneTeamPreflightRef"], freshAttachments:McpInvocationRequest["oneAttachmentRef"];
      const execution={...request};
      const attempt=db.transaction(() => {
        const next=escrow.beginAttempt(owner,request.runId!);
        store.begin(owner,execution,epoch);
        return next;
      }).immediate();
      try {
        if (queueId) {
          if (request.oneTeamPreflightRef) execution.oneTeamPreflightRef=freshTeam=await reissueQueuedOneTeamPreflight(escrow,owner,attempt,options.teamDependencies);
          if (request.oneAttachmentRef) execution.oneAttachmentRef=freshAttachments=reissueQueuedOneAttachments(escrow,owner,attempt,{userPrompt:request.userPrompt,teamProposalId:execution.oneTeamPreflightRef?.proposalId}).ref;
        }
        escrow.withAttempt(owner,attempt,() => {
          store.bindAttempt(owner,execution,epoch);
          const {preflightSubmissionId:_submission,...admittedRequest}=execution;
          const canonical=canonicalInvocationRequestJson(admittedRequest);
          const digest=createHash("sha256").update(INVOCATION_ADMISSION_DIGEST_VERSION+"\0").update(canonical).digest("hex");
          db.prepare("INSERT INTO queued_owner_input_admissions VALUES (?,?)").run(execution.runId,digest);
        });
        return await start(execution,{enterSource(){
          // Recheck after every awaited preflight immediately at the native
          // source handoff. Stop/account changes cannot slip through the await.
          escrow.withAttempt(owner,attempt,() => { entered=true; });
        }});
      } catch(error) {
        if (!entered) {
          // No original source entry happened in this awaited call. A foreign
          // live/admitted run with this id would contradict that closure.
          const admission=getInvocationAdmission(request.runId);
          if (!options.running(request.runId) && (!admission || admission.status==="rejected") && !getInvocationRunReceipt(request.runId)) {
            store.closeBeforeSource(request.runId,epoch);
            if (freshTeam) failOneTeamPreflightStart(freshTeam);
            if (freshAttachments) releaseOneAttachmentRun(freshAttachments);
          }
        }
        // A refusal is not execution authority. Preserve non-transient owner
        // boundaries until a Main recovery signal rechecks the exact input.
        if (!isTransientRunFailureCode(sendRefusalCode(error))) {
          store.hold(owner,sendRefusalCode(error) ?? "queued_input_start_refused");
        }
        throw error;
      } finally { reconcile(); }
    },
    currentRunId(runId:string): string | null {
      const row=store.byRun(runId);
      if (!row) return null;
      const last=db.prepare("SELECT run_id FROM queued_owner_input_attempts WHERE owner_id=? ORDER BY rowid DESC LIMIT 1").get(row.owner_id) as {run_id:string}|undefined;
      return last?.run_id ?? row.origin_run_id;
    },
    cancel(runId:string): {queueId:string|null;runId:string}|null {
      const row=store.byRun(runId);
      if (!row || row.state!=="active") return null;
      store.stop(store.ownerOf(row));
      if (row.queue_id) db.prepare("UPDATE pending_chat_sends SET state='abandoned',last_code='owner_cancelled',updated_at=? WHERE id=? AND state IN ('queued','starting','held','uncertain','failed','gave_up')").run(Date.now(),row.queue_id);
      cancelResources(row);
      finish(row,"cancelled");
      return {queueId:row.queue_id,runId};
    },
  };
}
export type QueuedOwnerInputCustody=ReturnType<typeof createQueuedOwnerInputCustody>;
