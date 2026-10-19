import fs from 'node:fs';
import { companyFileMcpLaunchArgs,createCompanyFileServer } from './company-work-files';
import { withCompanyWorkContent,recordCompanyWorkContent } from './company-work-content';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { InstalledMcpServer,McpInvocationEvent,McpInvocationRequest } from '../../shared/types';
import type { Runner } from '../runtime/runner';
import * as byok from '../runtime/byok';
import { composeTracedPrompt } from '../runtime/prompt-composition-trace';
import { composeDeclaredPrompt } from '../runtime/prompt-order';
import type { DeclaredPromptPart } from '../runtime/prompt-order';
import { assertCompanyWorkGrant,refreshCompanyWorkGrant } from './company-work-grant';
import { companyProviderHost,companyClaudePin,withCompanyProvider } from './company-work-provider';
import {runCompanyClaude} from './company-work-claude';
import { createCompanyAgentMailCapability,removeAgentMailCapability } from '../agent-mail/control-server';
import { companyAgentMailMcpLaunchArgs,AGENT_MAIL_CONTROL_ENV } from '../agent-mail/mcp-server';
import { registerPreparedMcpConfig } from '../mcp-tools/prepared-transport';
import { appendChatMessage,appendInvocationAssistantResult,getChat } from '../store/chats';
const runners:Record<string,Runner>={anthropic:byok.runAnthropicByok,openai:byok.runOpenAIByok,google:byok.runGoogleByok,glm:byok.runGlmByok,kimi:byok.runKimiByok,deepseek:byok.runDeepseekByok,minimax:byok.runMinimaxByok,xai:byok.runXaiByok,openrouter:byok.runOpenRouterByok,upstage:byok.runUpstageByok};
/** Entirely separate data preparation: no personal history/profile/preferences,
 * global MCP registry, recall, relay or implicit Work folder resolution. */
async function runCompanyWorkInvocationInner(req:McpInvocationRequest,cap:object,sink:(event:McpInvocationEvent)=>void,signal?:AbortSignal):Promise<import('../mcp/client').McpInvocationResult>{
 const grant=assertCompanyWorkGrant(cap,req),{asset,job}=grant;
 if(req.oneMode||req.agentAppMode||req.automationId||getChat(req.chatId)?.originSurface!=='work'||getChat(req.chatId)?.agentId!==asset.agentId)throw Error('company_work_request_isolation_required');
 await refreshCompanyWorkGrant(cap);const host=await companyProviderHost(grant.providerCapability);
 if(JSON.stringify(host)!==JSON.stringify(job.policy.host)||JSON.stringify(req.runtimeSelection)!==JSON.stringify(host.runtime)
  ||!(host.runtime.kind==='claude-code'&&host.credential===null||host.runtime.kind==='byok'&&!!host.runtime.backend&&!!runners[host.runtime.backend]))throw Error('company_work_runtime_tools_unverified');
 const parts:DeclaredPromptPart[]=[];
 for(const file of asset.files){if(!['definition','skill','company-memory','work-artifact'].includes(file.kind))throw Error('company_work_file_kind_denied');
  const selected=path.resolve(asset.rootPath,file.path),real=fs.realpathSync.native(selected);
  if(real!==selected||!real.startsWith(asset.rootPath+path.sep)||!asset.approvedPaths.includes(file.path))throw Error('company_work_file_path_denied');
  const bytes=fs.readFileSync(real);if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.digest)throw Error('company_work_file_changed');
  if(file.kind==='work-artifact'&&!/\.(?:md|txt|json|csv)$/i.test(file.path))continue;
  const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))continue;
  parts.push({id:'company.work.asset.'+file.kind+'.'+createHash('sha256').update(file.path).digest('hex').slice(0,16),revision:1,stability:file.kind==='definition'||file.kind==='skill'?'versioned-content':'task-context',changeTriggers:['agent-instructions','skill-package','owner-input'],text});
 }
 parts.push(...grant.surfaceParts);
 const prompt=composeTracedPrompt(parts,{separator:'\n\n',kind:'company-work'});
 const userPrompt=composeDeclaredPrompt([{id:'company.work.user-request',revision:1,stability:'turn-context',changeTriggers:['owner-input','task'],text:grant.userPrompt}]);
 const controller=new AbortController(),aborted=()=>controller.abort(signal?.reason);if(signal?.aborted)aborted();else signal?.addEventListener('abort',aborted,{once:true});
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agentlas-company-work-')),configPath=path.join(directory,'mcp.json'),configKey='company-agent-mail';
 const mailTools=job.policy.tools.filter(n=>n.startsWith('agent_mail_')),fileTools=job.policy.tools.filter(n=>n.startsWith('company_file_'));
 let release:(()=>boolean)|undefined,files:Awaited<ReturnType<typeof createCompanyFileServer>>|undefined,capability:Awaited<ReturnType<typeof createCompanyAgentMailCapability>>|undefined;
 try{
  const servers:Parameters<typeof registerPreparedMcpConfig>[0]['servers']=[],serialized:Record<string,unknown>={},runtimeEnv:Record<string,string>={ELECTRON_RUN_AS_NODE:'1'};
  const server=(id:string,catalogId:string,args:string[]):InstalledMcpServer=>({id,catalogId,name:'',nameEn:'',transport:'stdio',command:process.execPath,args,url:null,envKeys:[],enabled:true,installedAt:new Date().toISOString()});
  if(mailTools.length){capability=await createCompanyAgentMailCapability({chatId:req.chatId,permission:'full',cwd:null},configKey,{threadId:job.threadId,assertCurrent:()=>refreshCompanyWorkGrant(cap),allowedOperations:mailTools.map(n=>n.slice('agent_mail_'.length))});
   const args=companyAgentMailMcpLaunchArgs(mailTools),env={[AGENT_MAIL_CONTROL_ENV]:capability.path,ELECTRON_RUN_AS_NODE:'1'},transport={command:process.execPath,args,env};
   serialized[configKey]=transport;Object.assign(runtimeEnv,env);servers.push({configKey,server:server(configKey,'agent-mail',args),transport});}
  if(fileTools.length){const fileControl=path.join(directory,'files.json');files=await createCompanyFileServer(cap,fileControl);const args=companyFileMcpLaunchArgs(fileTools),env={AGENTLAS_COMPANY_FILE_CONTROL:fileControl,ELECTRON_RUN_AS_NODE:'1'},transport={command:process.execPath,args,env},key='company-files';
   serialized[key]=transport;Object.assign(runtimeEnv,env);servers.push({configKey:key,server:server(key,'company-files',args),transport});}
  fs.writeFileSync(configPath,JSON.stringify({mcpServers:serialized}),{flag:'wx',mode:0o600});
  release=registerPreparedMcpConfig({path:configPath,servers,runtimeEnv,isCurrent:()=>{try{assertCompanyWorkGrant(cap,req);return true}catch{return false}}});
  appendChatMessage(req.chatId,'user',req.userPrompt);
  const request={systemPrompt:prompt.text,systemPromptComposition:prompt.composition,history:[],userPrompt,backendLabel:'Company · '+(host.runtime.backend??'Claude Code'),model:host.runtime.model,effort:host.runtime.effort,locale:req.locale??'en',signal:controller.signal,cwd:grant.workspace.canonicalPath!,permission:'read' as const,mcpConfigPath:configPath,mcpGrantCatalogOnly:true as const,isolatedMcpConfig:true as const,ephemeralToolGrant:true as const,unattended:true as const,unattendedNoAsk:true as const,maxOutputTokens:job.policy.maxOutputTokens,sessionFingerprintSeed:job.jobId,beforeMcpToolResult:async()=>{await refreshCompanyWorkGrant(cap)}};
  const events={onPartial:(chunk:string)=>recordCompanyWorkContent('partial',{text:chunk}),onStatus:(text:string)=>recordCompanyWorkContent('status',{text}),onTool:(name:string,args?:string,result?:string,id?:string,isError?:boolean)=>{recordCompanyWorkContent('tool',{name,args,result,id,isError});sink({kind:'tool-use',tool:{name,id,isError}})}};
  const result=await withCompanyProvider(grant.providerCapability,async()=>host.runtime.kind==='claude-code'
   ? runCompanyClaude(request,events,await companyClaudePin(grant.providerCapability),[
    ...mailTools.map(name=>'mcp__'+configKey+'__'+name),...fileTools.map(name=>'mcp__company-files__'+name)],path.join(directory,'claude-config'),job.policy.expiresAt)
   : runners[host.runtime.backend!](request,events));
  signal?.throwIfAborted();await refreshCompanyWorkGrant(cap);
  if(result.failure)throw Object.assign(Error('company_work_provider_failed'),{code:'company_work_provider_failed',failure:result.failure});
  recordCompanyWorkContent('result',{text:result.text,observedUsage:result.observedUsage??null});
  const metadata='Company work completed.';
  const saved=appendInvocationAssistantResult({chatId:req.chatId,speakerAgentId:asset.agentId,text:metadata,goalId:null,runId:req.runId});
  sink({kind:'final',text:metadata,runtimeAgentId:asset.agentId,durableAssistantMessageIdForVerification:saved.id,durableTextForVerification:metadata});return{finalText:metadata,stormbreakerContinueRequested:false,observedUsage:result.observedUsage};
 }finally{controller.abort('company_work_settled');signal?.removeEventListener('abort',aborted);release?.();files?.close();if(capability)removeAgentMailCapability(configKey,capability.binding.capabilityId);fs.rmSync(directory,{recursive:true,force:true})}
}

export async function runCompanyWorkInvocation(req:McpInvocationRequest,cap:object,sink:(event:McpInvocationEvent)=>void,signal?:AbortSignal):Promise<import('../mcp/client').McpInvocationResult>{
 const g=assertCompanyWorkGrant(cap,req);
 return withCompanyWorkContent({capability:cap,db:g.companyDb,jobId:g.job.jobId,runId:g.job.runId},async()=>{
  recordCompanyWorkContent('request',{prompt:g.userPrompt});
  try{return await runCompanyWorkInvocationInner(req,cap,sink,signal)}catch(error){recordCompanyWorkContent('error',{error:error instanceof Error?error.message:String(error)});throw Object.assign(Error('company_work_execution_failed'),{code:'company_work_execution_failed'})}
 });
}
