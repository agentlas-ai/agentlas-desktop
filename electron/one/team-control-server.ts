import { withCurrentHistoryTool } from "./history-runtime-fences";
import { withOneHistoryNativeInvocation } from "./personal-integrations-runtime";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
import { userDataPath } from "../runtime-paths";
import { outsideInvocationJudgmentContext } from "../runtime/judgment-context";
import { oneGraphDispatch } from "./graph-dispatch";
import { registerOneToolchainNativeCapability, forgetOneToolchainNativeCapability,
  forgetAllOneToolchainNativeCapabilities, withOneToolchainNativeInvocation } from "./toolchain-native-runtime";
import { AGENTLAS_ONE_TEAM_TOOL_NAMES } from "./team-mcp-server";
import { ONE_SUPERVISOR_TOOL_NAMES } from "../../shared/one-supervisor-tools";
import { ONE_PERSONAL_TOOL_NAMES } from '../../shared/one-personal-tools';
import { ONE_HISTORY_TOOL_NAMES } from '../../shared/one-history-tools';
import { createHistoryTeamDispatch } from './history-team-glue';
import { currentOneHistoryExecution, prepareOnePersonalIntegrationsNative } from './personal-integrations-runtime';
import { personalDataHash, personalDataError } from './personal-data-store';
import type { PersonalDataTarget } from '../../shared/one-personal-data';
import { getDb } from '../store/db';
import { supervisorError } from "../../shared/one-supervisor";
import {
  oneTeamCreateMember,
  oneTeamComposeGroup,
  oneTeamInvite,
  oneTeamList,
  oneTeamSessionStatus,
  oneTeamStartSession,
  oneTeamSteer,
  type OneTeamCaller,
} from "./team-dispatch";

// Main-side handler for the inline one-team MCP child. Loopback only, one
// random server token, one capability per run config (bound to the caller chat
// and its permission). Same shape as the agent-mail control server.

const MAX_REQUEST_BYTES = 64 * 1024;

// The server outlives the turn that first starts it, and Node gives every later
// request the async context that was live at listen(). Started inside a turn, it
// served all later chats with that finished turn's runtime pin and aborted
// signal: toolchain_publish's test model never ran ("isolated_runtime_failed").
// So listen from the module-load context, and handle each request outside any
// invocation's judgment context.
const hostRootContext = AsyncLocalStorage.snapshot();

export interface OneTeamCapabilityBinding extends OneTeamCaller {
  /** Exact Main invocation; optional for legacy capabilities, never supplied by the MCP child. */
  supervisorReplyRunId?: string;
  /** A Work task: only `tools` (Toolchain search/run/result) may be called through this capability. */
  scope?: "toolchain-consumer";
  tools?: readonly string[];
  capabilityId: string;
  personalSource?: { commandId: string; runId: string; occurrenceId: string };
  historySource?: { commandId: string; runId: string };
}

let server: http.Server | null = null;
let boundPort = 0;
let serverToken = "";
let serverStarting: Promise<number> | null = null;
let shutdownRegistered = false;
const capabilities = new Map<string, OneTeamCapabilityBinding>();

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96) || randomUUID();
}

function controlDir(): string {
  return userDataPath("one-team");
}

function capabilityPath(configKey: string, capabilityId: string): string {
  return path.join(controlDir(), `capability-${safeKey(configKey)}-${safeKey(capabilityId)}.json`);
}

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(value && typeof value === "object" ? value : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** Internal capability dispatch shared by the same-process host and the
 * authenticated original native source callback. Not an IPC/HTTP endpoint. */
export async function dispatchOneSupervisorTool(binding: Pick<OneTeamCapabilityBinding,'chatId'|'supervisorReplyRunId'>,name:string,input:Record<string,unknown>):Promise<unknown> {
    const {isPersonalSupervisorConversation,oneSupervisor} = require("./supervisor") as typeof import("./supervisor");
    if (!binding.chatId || !isPersonalSupervisorConversation(binding.chatId)) throw new Error("supervisor_personal_conversation_required");
    const service = (await import("./supervisor")).supervisorRunsInDaemon() ? oneSupervisor() : (await import("./supervisor-native-runtime")).oneSupervisorEndpoint();
    await service.assertConversation(binding.chatId);
    const observation = name === "one_supervisor_status" || name === "one_app_operations"
      || (name === "one_supervisor_checkin" && (input.action === "list" || input.action === "cancel"))
      || (name === "one_supervisor_control" && input.action === "cancel");
    if (!observation) {
      if(!binding.supervisorReplyRunId)throw supervisorError('supervisor_handoff_origin_invalid');
      await service.assertAutomaticWriteAllowed(binding.supervisorReplyRunId);
    }
    switch (name) {
      case "one_supervisor_status": {
        const snapshot = await service.snapshot();
        return { one_id: snapshot.oneId, executor: snapshot.executor, observed_at: snapshot.observedAt, science_error: snapshot.scienceError,
          science_projects:snapshot.scienceProjects,
          tasks: snapshot.tasks.filter(task => !input.task_id || task.taskId === input.task_id).map(task=>input.task_id ? task : {...task,result:null}) };
      }
      // Owner 2026-10-04: what One hands off runs with full access and Always allow, whatever this reply's own permission.
      case "one_supervisor_start_work": return service.startWork({commandId:String(input.command_id ?? ""),text:String(input.brief ?? ""),
        ...(input.project_id ? {projectId:String(input.project_id)} : {}),permissions:"full"},binding.supervisorReplyRunId);
      case "one_supervisor_start_science": return service.startScience({commandId:String(input.command_id ?? ""),text:String(input.brief ?? ""),projectId:String(input.project_id ?? ""),
        ...(input.conversation_id ? {conversationId:String(input.conversation_id)} : {})},binding.supervisorReplyRunId);
      case "one_chat_send": return service.sendToChat({commandId:String(input.command_id ?? ""),chatId:String(input.chat_id ?? ""),text:String(input.message ?? "")},binding.supervisorReplyRunId);
      case "one_supervisor_follow_up": return service.followUp({commandId:String(input.command_id ?? ""),taskId:String(input.task_id ?? ""),text:String(input.message ?? "")},binding.supervisorReplyRunId);
      case "one_supervisor_checkin": return service.checkin({commandId:String(input.command_id ?? ""),action:input.action as "create"|"cancel"|"list",
        ...(input.instruction !== undefined ? {instruction:String(input.instruction)} : {}),...(input.every_minutes !== undefined ? {everyMinutes:Number(input.every_minutes)} : {}),
        ...(input.daily_at !== undefined ? {dailyAt:String(input.daily_at)} : {}),...(input.notify !== undefined ? {notify:input.notify as "important"|"always"} : {}),
        ...(input.checkin_id !== undefined ? {checkinId:String(input.checkin_id)} : {})});
      // The app-control catalog (every bridge operation) loads only when One first uses it.
      case "one_app_operations": return (require("../app-control/service") as typeof import("../app-control/service")).appControlOperations(input);
      case "one_app_call": return (require("../app-control/service") as typeof import("../app-control/service"))
        .appControlCall({ownerTurn:await service.ownerTurn(binding.supervisorReplyRunId)},{operation:input.operation,args:input.args});
      case "one_supervisor_control": return service.control({commandId:String(input.command_id ?? ""),taskId:String(input.task_id ?? ""),expectedVersion:String(input.control_version ?? ""),action:input.action as "steer"|"cancel",...(input.message ? {text:String(input.message)} : {})});
      default: throw new Error("supervisor_operation_unknown");
    }
}

async function handleOneTeamControlRequestUnchecked(request: Record<string, unknown>): Promise<unknown> {
  if (typeof request.token !== "string" || !serverToken || request.token !== serverToken) throw new Error("one-team-capability-invalid");
  const binding = typeof request.capabilityId === "string" ? capabilities.get(request.capabilityId) : undefined;
  if (!binding) throw new Error("one-team-capability-invalid");
  if(request.operation==='history') {
    const name=String(request.name??'');
    if(!(ONE_HISTORY_TOOL_NAMES as readonly string[]).includes(name)||binding.tools&&!binding.tools.includes(name))throw personalDataError('history_native_tool_not_granted');
    await prepareOnePersonalIntegrationsNative();
    const execution=currentOneHistoryExecution();if(!execution)throw personalDataError('history_native_execution_adapter_required');
    const host=await import('./supervisor'),domain=await import('./personal-data-runtime');
    const supervisor=host.supervisorRunsInDaemon()?host.oneSupervisor():(await import('./supervisor-native-runtime')).oneSupervisorEndpoint();
    const targets=name==='one_history_source_read'?[]:await domain.onePersonalDataEndpoint().listTargets();
    const assertCapability=(capability:object)=>{
      if(capability!==binding||capabilities.get(binding.capabilityId)!==binding||!binding.chatId)throw personalDataError('history_native_run_capability_required');
      const runId=binding.historySource?.runId??binding.supervisorReplyRunId;if(!runId)throw personalDataError('history_native_original_command_required');
      if(binding.historySource)execution.assertRun({chatId:binding.chatId,runId});
      else if(!host.isPersonalSupervisorConversation(binding.chatId))throw personalDataError('history_native_personal_conversation_required');
      return {chatId:binding.chatId,runId};
    };
    const dispatch=createHistoryTeamDispatch({execution,resolveCaller:assertCapability,
      resolveTarget:(capability,pageId)=>{assertCapability(capability);const target=targets.find(item=>item.target.pageId===pageId)?.target;if(!target)throw personalDataError('history_native_target_acl_denied');return target;},
      assertOwnerAction:(capability,method,target:PersonalDataTarget)=>{const caller=assertCapability(capability);if(binding.scope==='toolchain-consumer'||binding.historySource||!binding.supervisorReplyRunId||binding.permission==='read'||!host.isPersonalSupervisorConversation(caller.chatId))throw personalDataError('history_native_explicit_owner_turn_required');
        if(!targets.some(item=>personalDataHash(item.target)===personalDataHash(target)))throw personalDataError('history_native_target_acl_denied');},
      invokePersonalCommand:async(capability,method,value)=>{assertCapability(capability);if(method!=='historySnapshot'&&(!binding.supervisorReplyRunId||!await supervisor.ownerTurn(binding.supervisorReplyRunId)))throw personalDataError('history_native_explicit_owner_turn_required');
        const result=await (domain.onePersonalDataEndpoint() as unknown as Record<string,(input:unknown)=>Promise<unknown>>)[method](value);assertCapability(capability);return result;},
    });
    return dispatch(binding,name,request.input);
  }
  if(request.operation==='personal') {
    const name=String(request.name??''), args=request.input as Record<string,unknown>;
    if(!args || typeof args!=='object' || Array.isArray(args) || !ONE_PERSONAL_TOOL_NAMES.includes(name as typeof ONE_PERSONAL_TOOL_NAMES[number]))throw new Error('personal_data_tool_invalid');
    if(binding.tools && !binding.tools.includes(name))throw new Error('personal_data_tool_not_granted');
    const domain=await import('./personal-data-runtime');
    if(name==='one_personal_source_read') {
      if(!binding.personalSource || !binding.chatId || Object.keys(args).join(',')!=='occurrence_id' || args.occurrence_id!==binding.personalSource.occurrenceId)throw new Error('personal_data_original_run_required');
      return domain.readOnePersonalDataForNativeRun({...binding.personalSource,chatId:binding.chatId});
    }
    if(binding.scope==='toolchain-consumer')throw new Error('one-team-consumer-scope');
    const host=await import('./supervisor');const supervisor=host.supervisorRunsInDaemon()?host.oneSupervisor():(await import('./supervisor-native-runtime')).oneSupervisorEndpoint();
    if(!binding.chatId || !host.isPersonalSupervisorConversation(binding.chatId))throw new Error('personal_data_personal_conversation_required');
    await supervisor.assertConversation(binding.chatId);
    const endpoint=domain.onePersonalDataEndpoint(), targets=await endpoint.listTargets();
    if(name==='one_personal_pages'){if(Object.keys(args).length)throw new Error('personal_data_tool_invalid');return targets;}
    const target=targets.find(item=>item.target.pageId===args.page_id)?.target;if(!target)throw new Error('personal_data_page_acl_denied');
    if(name==='one_personal_page_read'){if(Object.keys(args).some(k=>k!=='page_id'))throw new Error('personal_data_tool_invalid');return endpoint.snapshot({target});}
    if(!binding.supervisorReplyRunId || !(await supervisor.ownerTurn(binding.supervisorReplyRunId)))throw new Error('personal_data_explicit_owner_turn_required');
    if(binding.permission==='read')throw new Error('personal_data_write_permission_required');
    if(Object.keys(args).some(k=>!['page_id','command_id','expected_revision','title','text'].includes(k)))throw new Error('personal_data_tool_invalid');
    return endpoint.edit({commandId:args.command_id as string,target,expectedRevision:args.expected_revision as number,title:args.title as string,text:args.text as string});
  }
  if (request.operation === "supervisor") {
    if (binding.scope === "toolchain-consumer") throw new Error("one-team-consumer-scope");
    const input = request.input && typeof request.input === "object" && !Array.isArray(request.input) ? request.input as Record<string, unknown> : {};
    if(binding.supervisorReplyRunId && !(await import("./supervisor")).supervisorRunsInDaemon()) {
      const relay=(await import("./supervisor-native-relay")).supervisorNativeRelay(binding.chatId ?? '',binding.supervisorReplyRunId);
      if(relay)return relay(String(request.name ?? ''),input);
    }
    return dispatchOneSupervisorTool(binding,String(request.name ?? ''),input);
  }
  // The child lists only the consumer tools, but the boundary is here, not in the child.
  if (binding.scope === "toolchain-consumer"
    && (request.operation !== "graph" || !binding.tools?.includes(String(request.name ?? "")))) throw new Error("one-team-consumer-scope");
  switch (request.operation) {
    case "graph": {
      const name = String(request.name ?? ""), input = request.input && typeof request.input === "object" && !Array.isArray(request.input)
        ? request.input as Record<string, unknown> : {};
      const execute = () => oneGraphDispatch(binding, name, input);
      return name.startsWith("toolchain_") && (name === "toolchain_inspect" ? input.include_reports === true : name !== "toolchain_search")
        ? withOneToolchainNativeInvocation(binding, execute) : execute();
    }
    case "list": return oneTeamList(binding);
    case "start": return oneTeamStartSession(binding, { member: request.member, brief: request.brief, newSession: request.newSession });
    case "steer": return oneTeamSteer(binding, { sessionId: request.sessionId, message: request.message });
    case "status": return oneTeamSessionStatus(binding, { sessionId: request.sessionId, waitSeconds: request.waitSeconds });
    case "create": return oneTeamCreateMember(binding, { name: request.name, role: request.role, personality: request.personality, invite: request.invite });
    case "invite": return oneTeamInvite(binding, { member: request.member });
    case "compose_group": return oneTeamComposeGroup(binding, { members: request.members });
    default: throw new Error("one-team-unknown-operation");
  }
}

function dispose(): void {
  try { forgetAllOneToolchainNativeCapabilities(); }
  finally {
    capabilities.clear();
    if (server) {
      try { server.close(); } catch { /* best effort */ }
    }
    server = null;
    boundPort = 0;
    serverToken = "";
  }
}

export function startOneTeamControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  if (serverStarting) return serverStarting;
  serverToken = randomUUID();
  const startup = hostRootContext(() => new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/one-team") return writeJson(res, 404, { ok: false, error: "not-found" });
      void readJsonBody(req).then(async (body) => {
        if (!body) return writeJson(res, 400, { ok: false, error: "invalid-request" });
        try {
          writeJson(res, 200, { ok: true, result: await outsideInvocationJudgmentContext(() => handleOneTeamControlRequest(body)) });
        } catch (error) {
          writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : "one-team-failed" });
        }
      });
    });
    // Waiting for a teammate can take minutes; the default request timeout must not cut it.
    srv.requestTimeout = 0;
    srv.headersTimeout = 60_000;
    srv.once("error", () => { server = null; boundPort = 0; resolve(0); });
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      boundPort = typeof address === "object" && address ? address.port : 0;
      server = srv;
      srv.unref();
      if (!shutdownRegistered) {
        shutdownRegistered = true;
        onHostShutdown(dispose);
      }
      resolve(boundPort);
    });
  }));
  serverStarting = startup;
  void startup.finally(() => { if (serverStarting === startup) serverStarting = null; });
  return startup;
}

/** Mint a per-config capability file (0600) that the MCP child reads. */
export async function createOneTeamCapability(
  input: OneTeamCaller & Pick<OneTeamCapabilityBinding, "scope" | "tools" | "supervisorReplyRunId">,
  configKey: string,
): Promise<{ path: string; binding: OneTeamCapabilityBinding }> {
  const port = await startOneTeamControlServer();
  if (!port) throw new Error("one-team-control-unavailable");
  // The personal-supervisor tools answer only in the owner's personal One conversation (the request handler below
  // refuses them anywhere else). Listing them in every conversation made room Ones call one_app_operations and get
  // supervisor_personal_conversation_required (production 2026-10-05, Thread Marketing and Youtube launch), so a
  // conversation that is not the personal one is not offered them.
  let tools = input.tools ?? (personalSupervisorConversation(input.chatId) ? undefined
    : AGENTLAS_ONE_TEAM_TOOL_NAMES.filter((name) => !(ONE_SUPERVISOR_TOOL_NAMES as readonly string[]).includes(name)&&!(ONE_HISTORY_TOOL_NAMES as readonly string[]).includes(name)));
  let personalSource: OneTeamCapabilityBinding['personalSource'];
  let historySource: OneTeamCapabilityBinding['historySource'];
  const db=getDb();
  if(input.chatId && db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_personal_data_occurrences'").get()) {
    const rows=db.prepare(`SELECT r.command_id,r.run_id,json_extract(o.value_json,'$.occurrenceId') AS occurrence_id FROM one_supervisor_requests r
      JOIN one_personal_data_occurrences o ON json_extract(o.value_json,'$.commandId')=r.command_id
      WHERE json_extract(r.payload_json,'$.workerChatId')=? AND r.state IN ('dispatching','accepted')`).all(input.chatId) as Array<{command_id:string;run_id:string;occurrence_id:string}>;
    if(rows.length===1){const r=rows[0];personalSource={commandId:r.command_id,runId:r.run_id,occurrenceId:r.occurrence_id};}
  }
  if(input.chatId&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_history_native_bindings'").get()){
    const rows=db.prepare("SELECT r.command_id,r.run_id FROM one_history_native_bindings b JOIN one_supervisor_requests r ON r.command_id=b.command_id WHERE json_extract(r.payload_json,'$.workerChatId')=? AND r.state IN ('dispatching','accepted')").all(input.chatId) as Array<{command_id:string;run_id:string}>;
    if(rows.length===1){historySource={commandId:rows[0].command_id,runId:rows[0].run_id};currentOneHistoryExecution()?.assertRun({chatId:input.chatId,runId:rows[0].run_id});}
  }
  if(tools)tools=[...tools.filter(name=>!ONE_PERSONAL_TOOL_NAMES.includes(name as typeof ONE_PERSONAL_TOOL_NAMES[number])),...(personalSource?['one_personal_source_read']:personalSupervisorConversation(input.chatId)?ONE_PERSONAL_TOOL_NAMES.filter(name=>name!=='one_personal_source_read'):[])];
  if(tools)tools=[...tools.filter(name=>!(ONE_HISTORY_TOOL_NAMES as readonly string[]).includes(name)),...(historySource?['one_history_source_read']:personalSupervisorConversation(input.chatId)?ONE_HISTORY_TOOL_NAMES.filter(name=>name!=='one_history_source_read'):[])];
  const binding: OneTeamCapabilityBinding = { ...input, ...(tools ? { tools } : {}), ...(personalSource?{personalSource}:{}), ...(historySource?{historySource}:{}), capabilityId: randomUUID() };
  capabilities.set(binding.capabilityId, binding);
  let target: string | null = null, temp: string | null = null;
  try {
    registerOneToolchainNativeCapability(binding, () => capabilities.get(binding.capabilityId) === binding);
    const directory = controlDir();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
    target = capabilityPath(configKey, binding.capabilityId);
    temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, port, token: serverToken, capabilityId: binding.capabilityId,
      ...(binding.tools ? { tools: [...binding.tools] } : {}) }), { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, target);
    return { path: target, binding };
  } catch (error) {
    // Failed publication must not leave an unpublished native capability live.
    try { forgetOneToolchainNativeCapability(binding); } catch { /* all local revocation still follows */ }
    capabilities.delete(binding.capabilityId);
    for (const file of [temp, target]) if (file) {
      try { fs.rmSync(file, { force: true }); } catch { /* exact unpublished capability file cleanup is best effort */ }
    }
    throw error;
  }
}

function personalSupervisorConversation(chatId: string | null | undefined): boolean {
  if (!chatId) return false;
  try {
    const { isPersonalSupervisorConversation } = require("./supervisor") as typeof import("./supervisor");
    return isPersonalSupervisorConversation(chatId);
  } catch {
    // Unknown means not offered; the request handler would refuse the call anyway.
    return false;
  }
}

export function removeOneTeamCapability(configKey: string, capabilityId: string): void {
  const binding = capabilities.get(capabilityId);
  try { if (binding) forgetOneToolchainNativeCapability(binding); }
  finally {
    capabilities.delete(capabilityId);
    try { fs.rmSync(capabilityPath(configKey, capabilityId), { force: true }); } catch { /* best effort */ }
  }
}

/** Bind only the original authenticated native capability before dispatch; renderer/model JSON supplies no native identity. */
export async function handleOneTeamControlRequest(request:Record<string,unknown>):Promise<unknown>{
  if(typeof request.token!=="string"||!serverToken||request.token!==serverToken)throw new Error("one-team-capability-invalid");
  const binding=typeof request.capabilityId==="string"?capabilities.get(request.capabilityId):undefined;
  if(!binding)throw new Error("one-team-capability-invalid");
  if(!binding.historySource)return handleOneTeamControlRequestUnchecked(request);
  const original=binding.historySource;if(!binding.chatId)throw personalDataError("history_native_original_command_required");
  const operations:Record<string,string>={list:"one_team_list",start:"one_team_start_session",steer:"one_team_steer",status:"one_team_session_status",create:"one_team_create_member",invite:"one_team_invite",compose_group:"one_team_compose_group"};
  const operation=String(request.operation??""),name=["graph","history","personal","supervisor"].includes(operation)?String(request.name??""):operations[operation];
  if(!name||!(AGENTLAS_ONE_TEAM_TOOL_NAMES as readonly string[]).includes(name)||binding.tools&&!binding.tools.includes(name))throw personalDataError("history_native_tool_not_granted");
  const input=["graph","history","personal","supervisor"].includes(operation)?request.input??{}:Object.fromEntries(Object.entries(request).filter(([key])=>!["token","capabilityId","operation"].includes(key)));
  const current=()=>{if(capabilities.get(binding.capabilityId)!==binding||binding.historySource!==original)throw personalDataError("history_native_run_capability_required");const execution=currentOneHistoryExecution();if(!execution)throw personalDataError("history_native_execution_adapter_required");const b=execution.assertCommand(original.commandId);if(!b||b.commandId!==original.commandId||b.runId!==original.runId||b.chatId!==binding.chatId)throw personalDataError("history_native_original_command_required");execution.assertRun({runId:original.runId,chatId:binding.chatId!});};
  return withOneHistoryNativeInvocation({runId:original.runId,chatId:binding.chatId},()=>withCurrentHistoryTool({kind:"builtin",serverId:null,catalogId:null,toolName:name,args:input,schemaDigest:null},async()=>{current();const result=await handleOneTeamControlRequestUnchecked(request);current();return result;}));
}
