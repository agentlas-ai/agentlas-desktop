import { readCanonicalPromptFromDirectory } from "../agents/prompt-authority";
import type { RuntimeSelection } from "../../shared/types";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { scienceStore } from "agentlas-science";
import type { ScienceCriterionReview, ScienceCriterionReviewHost, ScienceCriterionReviewObservation, ScienceReviewerPin } from "agentlas-science";
import { listInstalledAgentsReadOnly } from "../mcp/registry";
import { buildEffectiveAgentSystemPrompt, computeAgentPackageHash, resolveAgentPackageDir } from "../agents/files";
import { getDb } from "../store/db";
import { createChat, getChat, setChatRuntimeSelection } from "../store/chats";
import { invocationService } from "../invocation/service";
import { captureScienceInvocationBinding } from "../invocation/workspace-binding";
import { readInvocationEffectBoundary } from "../invocation/effect-boundary-reader";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key,v) => v && typeof v==="object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
interface Authority { projectId:string; reviewRequestId:string; invocationRunId:string; runtimeChatId:string; inputSha256:string }
const authorities = new WeakMap<object,Authority>();
const launched = new Set<string>();
const interrupted = (code:string):ScienceCriterionReviewObservation=>({status:"interrupted",code});

function installedPin(agentId:string, producers:string[]):ScienceReviewerPin {
  const agent=listInstalledAgentsReadOnly().find(a=>a.id===agentId);
  if(!agent || agent.kind==="team" || agent.sourceMissingSince) throw new Error("science-review-installed-agent-unavailable");
  for(const runId of producers){
    const rows=getDb().prepare("SELECT agent_id FROM run_events WHERE run_id=? AND kind='invoke_started'").all(runId) as {agent_id:string|null}[];
    if(rows.length!==1 || !rows[0].agent_id)throw new Error("science-review-producer-identity-unavailable");
    if(rows[0].agent_id===agentId)throw new Error("science-independent-review-producer-conflict");
  }
  const location=resolveAgentPackageDir(agent.id,agent.slug);
  // Reading a proposal must not materialize an uninstalled package or manufacture a reviewer.
  if(!location.isLocal || !fs.existsSync(location.dir))throw new Error("science-review-installed-package-unavailable");
  const prompt=buildEffectiveAgentSystemPrompt(agent.id,agent.systemPrompt);
  if(!prompt.trim())throw new Error("science-review-prompt-unavailable");
  const basePrompt=readCanonicalPromptFromDirectory(location.dir)?.content ?? agent.systemPrompt;
  for(const runId of producers){
    const producerId=(getDb().prepare("SELECT agent_id FROM run_events WHERE run_id=? AND kind='invoke_started'").get(runId) as {agent_id:string}).agent_id;
    const producer=listInstalledAgentsReadOnly().find(a=>a.id===producerId);
    if(!producer)throw new Error("science-review-producer-identity-unavailable");
    const source=resolveAgentPackageDir(producer.id,producer.slug);
    const producerPrompt=readCanonicalPromptFromDirectory(source.dir)?.content ?? producer.systemPrompt;
    if(basePrompt.trim()===producerPrompt.trim() || prompt.trim()===producer.systemPrompt.trim())throw new Error("science-independent-review-producer-conflict");
  }
  const digest=computeAgentPackageHash(agent.id,"agent.md");
  return {agentId:agent.id,agentSlug:agent.slug,packageDigest:`sha256:${digest}`,packageVersion:`content-sha256:${digest}`,systemPromptSha256:sha(prompt)};
}
function current(projectId:string,id:string):ScienceCriterionReview {
  const review=scienceStore().criterionReviews().get(projectId,id);
  if(!review)throw new Error("science-review-not-found");
  return review;
}
/** Object identity, not JSON fields, authorizes the separate Science read grant. */
export function resolveScienceReviewAuthority(authority:object,runId:string,chatId:string):ScienceCriterionReview {
  const admitted=authorities.get(authority);
  if(!admitted || admitted.invocationRunId!==runId || admitted.runtimeChatId!==chatId)throw new Error("science-review-main-authority-required");
  const review=current(admitted.projectId,admitted.reviewRequestId);
  if(review.inputSha256!==admitted.inputSha256 || !["dispatching","running"].includes(review.status))throw new Error("science-review-grant-stale");
  scienceStore().assertCriterionReviewCurrent(review);
  if(stable(installedPin(review.reviewer.agentId,review.basis.producerInvocationRunIds))!==stable(review.reviewer))throw new Error("science-review-package-changed");
  const chat=getChat(chatId);
  if(!chat || chat.agentId!==review.reviewer.agentId)throw new Error("science-review-chat-binding-mismatch");
  return review;
}
function observe(projectId:string,id:string):ScienceCriterionReviewObservation {
  const review=current(projectId,id);
  const rows=getDb().prepare("SELECT id,kind,chat_id,agent_id,payload_json FROM run_events WHERE run_id=? ORDER BY seq").all(review.invocationRunId) as Array<{id:string;kind:string;chat_id:string|null;agent_id:string|null;payload_json:string}>;
  if(!rows.length)return interrupted("science-review-execution-not-found");
  const starts=rows.filter(r=>r.kind==="invoke_started");
  if(starts.length!==1 || starts[0].agent_id!==review.reviewer.agentId || starts[0].chat_id!==review.runtimeChatId) return interrupted("science-review-execution-binding-mismatch");
  const boundary=readInvocationEffectBoundary({invocationRunId:review.invocationRunId,expectedChatId:review.runtimeChatId,expectedSource:"science"});
  if(!boundary.terminal)return {status:"running"};
  // A streamed final precedes the actual runner's closed effect receipt. Re-query while it is still active.
  if(!boundary.receiptEventId && invocationService.receipt(review.invocationRunId)?.status==="running")return {status:"running"};
  const terminal=rows.find(r=>r.id===boundary.terminalEventId);
  if(terminal && ["invoke_failed","invoke_threw"].includes(terminal.kind)) {
    const receipt=invocationService.receipt(review.invocationRunId);
    if(receipt?.errorCode && /^[a-zA-Z0-9_.:-]{1,160}$/.test(receipt.errorCode))return {status:"unavailable",code:receipt.errorCode};
  }
  if(boundary.effects!=="settled" || !boundary.snapshotDigest || !boundary.terminalEventId)return interrupted("science-review-effect-boundary-unconfirmed");
  const selectionRows=rows.filter(r=>r.kind==="runtime_selection");
  const selections=selectionRows.map(r=>JSON.parse(r.payload_json) as Record<string,unknown>).filter(p=>p.runtimeRole==="orchestrator");
  const pin=review.basis.runtimeSelection;
  if(!selections.length || selections.some(p=>p.runtimeKind!==pin.kind || (p.runtimeBackend??null)!==(pin.backend??null) || (p.runtimeSource??null)!==(pin.source??null)
    || (p.runtimeModel??null)!==(pin.model??null) || (p.runtimeEffort??null)!==(pin.effort??null) || Boolean(p.runtimeLongContext)!==Boolean(pin.longContext)))return interrupted("science-review-runtime-binding-mismatch");
  const finals=rows.filter(r=>r.kind==="mcp_final");
  if(finals.length!==1)return interrupted("science-review-final-findings-unavailable");
  const finalPayload=JSON.parse(finals[0].payload_json) as Record<string,unknown>;
  const answer=getDb().prepare("SELECT id,text FROM chat_messages WHERE id=? AND chat_id=? AND role='assistant'").get(finalPayload.durableMessageId,review.runtimeChatId) as {id:string;text:string}|undefined;
  if(!answer)return interrupted("science-review-final-backlink-unavailable");
  let result:any;try{result=JSON.parse(answer.text);}catch{return interrupted("science-review-final-findings-invalid");}
  const exact=(o:any,keys:string[])=>o && typeof o==="object" && !Array.isArray(o) && Object.keys(o).sort().join()===keys.sort().join();
  if(!exact(result,["schema","reviewRequestId","inputSha256","finding"]) || result.schema!=="agentlas.science-criterion-review-findings.v1" || result.reviewRequestId!==review.id || result.inputSha256!==review.inputSha256
    || !exact(result.finding,["criterionIndex","verdict","scientificOutcome","summary","limitations"]))return interrupted("science-review-final-findings-invalid");
  const finding=result.finding;
  if(finding.criterionIndex!==review.basis.criterionIndex || !["passed","failed","inconclusive"].includes(finding.verdict) || !["supported","contradicted","inconclusive","not-assessed"].includes(finding.scientificOutcome)
    || typeof finding.summary!=="string" || !finding.summary.trim() || finding.summary.length>8000 || !Array.isArray(finding.limitations) || finding.limitations.length>40 || finding.limitations.some((v:unknown)=>typeof v!=="string" || !v.trim() || v.length>2000))return interrupted("science-review-final-findings-invalid");
  if(stable(installedPin(review.reviewer.agentId,review.basis.producerInvocationRunIds))!==stable(review.reviewer))return interrupted("science-review-package-changed");
  return {status:"settled",execution:{schema:"agentlas.science-criterion-review-execution.v1",reviewRequestId:review.id,invocationRunId:review.invocationRunId,runtimeChatId:review.runtimeChatId,
    inputSha256:review.inputSha256,reviewer:review.reviewer,runtimeSelection:pin,startedEventId:starts[0].id,terminalEventId:boundary.terminalEventId,
    finalAnswerId:answer.id,finalAnswerSha256:sha(answer.text),effectBoundarySha256:boundary.snapshotDigest,finding}};
}
export const scienceCriterionReviewHost:ScienceCriterionReviewHost={
  list:async ({projectId,producerInvocationRunId})=>{
    const turn=scienceStore().getTurnByInvocationRunId(producerInvocationRunId);
    if(!turn || turn.projectId!==projectId)throw new Error("science-review-producer-authority-missing");
    scienceStore().assertScienceTurnExecutionAuthority(turn);
    const producers=getDb().prepare("SELECT agent_id FROM run_events WHERE run_id=? AND kind='invoke_started'").all(producerInvocationRunId) as {agent_id:string|null}[];
    if(producers.length!==1 || !producers[0].agent_id)throw new Error("science-review-producer-identity-unavailable");
    return listInstalledAgentsReadOnly().filter(a=>{
      if(a.id===producers[0].agent_id || a.kind==="team" || a.sourceMissingSince)return false;
      const location=resolveAgentPackageDir(a.id,a.slug);
      return location.isLocal && fs.existsSync(location.dir);
    }).map(a=>({agentId:a.id,name:a.name,description:a.tagline}));
  },
  authorize:({authority,invocationRunId,runtimeChatId})=>resolveScienceReviewAuthority(authority,invocationRunId,runtimeChatId),
  prepare:async input=>installedPin(input.reviewerAgentId,input.producerInvocationRunIds),
  start:async ({projectId,reviewRequestId})=>{
    let dispatchEntered=false;
    try {
    const review=current(projectId,reviewRequestId);
    if(!["dispatching","running"].includes(review.status))return interrupted("science-review-not-dispatchable");
    if(getDb().prepare("SELECT 1 FROM run_events WHERE run_id=? LIMIT 1").get(review.invocationRunId))return observe(projectId,reviewRequestId);
    if(launched.has(review.invocationRunId))return interrupted("science-review-dispatch-uncertain");
    scienceStore().assertCriterionReviewCurrent(review);
    if(stable(installedPin(review.reviewer.agentId,review.basis.producerInvocationRunIds))!==stable(review.reviewer))throw new Error("science-review-package-changed");
    const parent=scienceStore().getConversationRuntimeBinding(projectId,review.basis.conversationId);
    const project=scienceStore().getProject(projectId);
    if(!parent || !project?.folderPath)throw new Error("science-review-workspace-unavailable");
    const binding=captureScienceInvocationBinding(project.folderPath);
    let chat=getChat(review.runtimeChatId);
    if(!chat)chat=createChat({internalId:review.runtimeChatId,agentId:review.reviewer.agentId,kind:"division",parentChatId:parent.runtimeChatId,title:"Independent scientific review"});
    const parentRow=getDb().prepare("SELECT parent_chat_id FROM chats WHERE id=?").get(chat.id) as {parent_chat_id:string};
    if(chat.agentId!==review.reviewer.agentId || chat.kind!=="division" || parentRow.parent_chat_id!==parent.runtimeChatId)throw new Error("science-review-chat-binding-mismatch");
    if(review.basis.runtimeSelection.role!==undefined && !["orchestrator","worker","multimodal"].includes(review.basis.runtimeSelection.role))throw new Error("science-review-runtime-binding-invalid");
    const selection=review.basis.runtimeSelection as RuntimeSelection;
    setChatRuntimeSelection(chat.id,selection);
    const authority=Object.freeze({});authorities.set(authority,{projectId,reviewRequestId,invocationRunId:review.invocationRunId,runtimeChatId:review.runtimeChatId,inputSha256:review.inputSha256});
    launched.add(review.invocationRunId);
    const unsubscribe=invocationService.onSettled(async event=>{
      if(event.runId!==review.invocationRunId)return;
      unsubscribe();
      try { await scienceStore().criterionReviews().reconcile(projectId,reviewRequestId); } catch { /* The exact reservation remains queryable; no replay dispatch. */ }
    });
    dispatchEntered=true;
    try { invocationService.start({runId:review.invocationRunId,chatId:review.runtimeChatId,permissions:"read",planMode:true,runtimeSelection:selection,promptOrigin:"system",taskIntent:"conversation",
      userPrompt:`Independently review only the exact scientific criterion and immutable evidence below. Do not produce or modify research data, install tools, delegate, or perform external writes. Distinguish method adequacy from the scientific outcome; a negative scientific finding is not automatically a failed method. Return exactly one JSON object, without Markdown, using schema agentlas.science-criterion-review-findings.v1, reviewRequestId ${review.id}, inputSha256 ${review.inputSha256}, and finding {criterionIndex:${review.basis.criterionIndex},verdict:passed|failed|inconclusive,scientificOutcome:supported|contradicted|inconclusive|not-assessed,summary:string,limitations:string[]}. Do not claim verification of information absent from the snapshot.\n${review.basis.inputText}`},binding,{source:"science",scienceReview:authority}); } catch(error) { unsubscribe(); throw error; }
    return {status:"running"};
    } catch(error) {
      if(dispatchEntered)throw error;
      const code=error instanceof Error?error.message:"";
      const refusals=new Set(["science-review-installed-agent-unavailable","science-review-installed-package-unavailable","science-review-prompt-unavailable","science-review-producer-identity-unavailable","science-independent-review-producer-conflict","science-review-package-changed","science-review-workspace-unavailable","science-review-chat-binding-mismatch","science-review-runtime-binding-invalid"]);
      if(refusals.has(code))return {status:"unavailable",code};
      throw error;
    }
  },
  read:async ({projectId,reviewRequestId})=>observe(projectId,reviewRequestId),
  cancel:async ({projectId,reviewRequestId})=>{const review=current(projectId,reviewRequestId);invocationService.cancel(review.invocationRunId);},
};
