/** Work's main conversation owns these bounded asynchronous assignments. */
export const WORK_SESSION_TOOL_NAMES = [
  "work_session_agents", "work_session_delegate", "work_session_status", "work_session_steer", "work_session_cancel",
] as const;
export type WorkSessionToolName = typeof WORK_SESSION_TOOL_NAMES[number];

/** These are authenticated session controls, not external effects. The dispatcher
 * binds every child to the caller's current authority; arguments cannot raise it. */
export function workSessionReadPermissionCall(input:{catalogId?:string|null;toolName:string;args?:unknown}):boolean {
  if(input.catalogId!=="one-team")return false;
  const value=input.args??{};
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const args=value as Record<string,unknown>;
  const text=(item:unknown,max:number)=>typeof item==="string"&&item.trim().length>0&&item.length<=max&&!/\u0000/u.test(item);
  const closed=(keys:string[])=>Object.keys(args).every(key=>keys.includes(key));
  const request=()=>text(args.request_id,128)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(args.request_id as string);
  const paging=()=>["offset","limit"].every(key=>args[key]===undefined||(Number.isSafeInteger(args[key])&&Number(args[key])>=(key==="limit"?1:0)&&Number(args[key])<=(key==="limit"?65536:Number.MAX_SAFE_INTEGER)))
    &&(args.snapshot_id===undefined||text(args.snapshot_id,128));
  if(input.toolName==="work_session_agents")return closed(["section","offset","limit","snapshot_id"])&&paging()
    &&(args.section===undefined||["agents","runtimes","sessions"].includes(String(args.section)));
  if(input.toolName==="work_session_status")return closed(["session_id","section","offset","limit","snapshot_id"])&&text(args.session_id,128)&&paging()
    &&(args.section===undefined||["summary","result","diagnostics"].includes(String(args.section)));
  if(input.toolName==="work_session_cancel")return closed(["session_id"])&&text(args.session_id,128);
  if(input.toolName==="work_session_steer")return closed(["session_id","request_id","message","recovery_mode"])
    &&text(args.session_id,128)&&request()&&text(args.message,12000)
    &&(args.recovery_mode===undefined||args.recovery_mode==="diagnose"||args.recovery_mode==="continue");
  if(input.toolName!=="work_session_delegate"||!closed(["request_id","target","brief","allocation"])||!request()||!text(args.target,300)||!text(args.brief,12000))return false;
  if(args.allocation===undefined)return true;
  if(!args.allocation||typeof args.allocation!=="object"||Array.isArray(args.allocation))return false;
  const allocation=args.allocation as Record<string,unknown>;
  const requirements=allocation.requirements;
  if(!requirements||typeof requirements!=="object"||Array.isArray(requirements))return false;
  const needed=requirements as Record<string,unknown>;
  return Object.keys(allocation).every(key=>["schema","runtimeId","modelId","tier","effort","phase","requirements","reasonCodes","rationale"].includes(key))
    &&allocation.schema==="agentlas.workload-allocation.v1"&&allocation.phase==="delegate"
    &&typeof allocation.runtimeId==="string"&&/^runtime-[1-9][0-9]*$/.test(allocation.runtimeId)&&text(allocation.modelId,160)
    &&["economy","balanced","frontier"].includes(String(allocation.tier))&&typeof allocation.effort==="string"&&/^[a-z][a-z0-9-]{0,23}$/.test(allocation.effort)
    &&Object.keys(needed).every(key=>["inputTokens","expectedOutputTokens","toolRequired","multimodalRequired"].includes(key))
    &&Number.isSafeInteger(needed.inputTokens)&&Number(needed.inputTokens)>=0&&Number(needed.inputTokens)<=10_000_000
    &&Number.isSafeInteger(needed.expectedOutputTokens)&&Number(needed.expectedOutputTokens)>=0&&Number(needed.expectedOutputTokens)<=10_000_000
    &&typeof needed.toolRequired==="boolean"&&typeof needed.multimodalRequired==="boolean"
    &&Array.isArray(allocation.reasonCodes)&&allocation.reasonCodes.length<=8&&allocation.reasonCodes.every(code=>text(code,80))&&text(allocation.rationale,240);
}

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const handle = { type: "string", minLength: 1, maxLength: 128 };
const paging = {
  offset:{type:"integer",minimum:0,description:"Continue at the previous next_offset. Items for agents/sessions; UTF-8 bytes for runtimes/result/diagnostics."},
  limit:{type:"integer",minimum:1,maximum:65536,description:"Item pages cap at 64 items (default 16); text pages cap at 65536 UTF-8 bytes (default 32768), further reduced to the wire budget."},
  snapshot_id:{type:"string",minLength:1,maxLength:128,description:"Copy the previous page snapshot_id to avoid combining different versions. Changed text/catalog snapshots require restarting that read."},
};
const allocation = {
  type: "object", additionalProperties: false,
  description: "Choose exact runtimeId/modelId from the advertised inventory. Omit the entire allocation to retain this conversation's selected runtime. The host validates requirements and authority.",
  properties: {
    schema:{type:"string",const:"agentlas.workload-allocation.v1"},
    phase:{type:"string",const:"delegate"},
    runtimeId:{type:"string",pattern:"^runtime-[1-9][0-9]*$"},
    modelId:{type:"string",minLength:1,maxLength:160},
    tier:{type:"string",enum:["economy","balanced","frontier"]},
    effort:{type:"string",pattern:"^[a-z][a-z0-9-]{0,23}$",description:"Copy an advertised effort supported by the selected runtime/model."},
    requirements:{type:"object",additionalProperties:false,properties:{
      inputTokens:{type:"integer",minimum:0,maximum:10000000},expectedOutputTokens:{type:"integer",minimum:0,maximum:10000000},
      toolRequired:{type:"boolean"},multimodalRequired:{type:"boolean"},
    },required:["inputTokens","expectedOutputTokens","toolRequired","multimodalRequired"]},
    reasonCodes:{type:"array",maxItems:8,items:{type:"string",minLength:1,maxLength:80}},
    rationale:{type:"string",minLength:1,maxLength:240},
  },required:["schema","phase","runtimeId","modelId","tier","effort","requirements","reasonCodes","rationale"],
};
export const WORK_SESSION_TOOL_DEFINITIONS = [
  { name: "work_session_agents", annotations: read,
    description: "Read bounded inventory pages. Default section agents lists available project specialists; sessions lists assignment summaries without result bodies. Section runtimes returns lossless JSON text pages of exact runtime/model profiles: continue next_offset with snapshot_id. Availability never requires delegation. Answer or do simple work yourself.",
    inputSchema: { type: "object", properties: {section:{type:"string",enum:["agents","runtimes","sessions"]},...paging}, additionalProperties: false } },
  { name: "work_session_delegate", annotations: act,
    description: "Assign a bounded independent task to one exact available specialist. Returns a durable handle immediately; completion returns to this main conversation. Keep the same request_id and payload after an uncertain response. End your turn while the task works; receive owner messages normally. Do not poll or duplicate the assigned work.",
    inputSchema: { type: "object", properties: {
      request_id: handle, target: { type: "string", minLength: 1, maxLength: 300, description: "Exact target key from work_session_agents." },
      brief: { type: "string", minLength: 1, maxLength: 12000, description: "Purpose, bounded work and observable completion criteria." }, allocation,
    }, required: ["request_id", "target", "brief"], additionalProperties: false } },
  { name: "work_session_status", annotations: read,
    description: "Read one assignment. Default summary is bounded state/preview/primary cause and reader handles. Section result returns complete durable text as UTF-8 byte pages; diagnostics returns full typed failure/effect JSON as text pages. Follow next_offset and snapshot_id; truncated pages never mean complete output. Running work reports itself; use for owner questions, reading a reported result, or reconciling lost responses.",
    inputSchema: { type: "object", properties: { session_id: handle,section:{type:"string",enum:["summary","result","diagnostics"]},...paging }, required: ["session_id"], additionalProperties: false } },
  { name: "work_session_steer", annotations: act,
    description: "Send a correction or cause-specific recovery plan to the same child session, including after failure. Retain accepted outputs; repair only remaining work. Unknown effects default to read-only diagnosis. Inspect an unknown outcome before repeating that same effect; explicit continuation may perform different remaining work. This never resends the original brief or declares an unknown effect settled.",
    inputSchema: { type: "object", properties: { session_id: handle, request_id: handle,
      message: { type: "string", minLength: 1, maxLength: 12000 },
      recovery_mode: {type:"string",enum:["diagnose","continue"],description:"diagnose uses read authority. Explicit continue carries this fresh remaining-work plan under the lesser of original and current caller authority; exact-action recovery guards still apply."} }, required: ["session_id", "request_id", "message"], additionalProperties: false } },
  { name: "work_session_cancel", annotations: act,
    description: "Cancel this conversation's assignment and its pending continuation. Cancellation remains available independently of the assignment's other state.",
    inputSchema: { type: "object", properties: { session_id: handle }, required: ["session_id"], additionalProperties: false } },
] as const;
