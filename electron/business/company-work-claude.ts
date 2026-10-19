import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import crossSpawn from 'cross-spawn';
import {observeCliExecutableIdentity} from '../runtime/cli-executable-identity';
import {detectRuntimes} from '../runtime/detect';
import {detachedSpawnOpts,killCliTree} from '../runtime/exec';
import type {RuntimeSelection} from '../../shared/types';
import type {RunnerRequest,RunnerEvents,RunnerResult} from '../runtime/runner';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Company-only wall clock bound; a current Root policy may expire sooner. */
export function companyClaudeTimeBudget(policyExpiresAt:string,now=Date.now()):{milliseconds:number;reason:'company_work_claude_timeout'|'company_work_policy_expired'}{
 const remaining=Date.parse(policyExpiresAt)-now;
 if(!Number.isFinite(remaining)||remaining<=0)throw Error('company_work_policy_expired');
 return remaining<=600000?{milliseconds:remaining,reason:'company_work_policy_expired'}:{milliseconds:600000,reason:'company_work_claude_timeout'};
}
type Auth={loggedIn:true;authMethod:'claude.ai';apiProvider:'firstParty';subscriptionType:string;accountDigest:string;accountMetadataPresent:boolean;accountMetadataAbsent:boolean};
export type CompanyClaudePin={source:string;fingerprint:string;binarySha256:string;auth:Auth;credentialSourceContractDigest:string|null;configurationDigest:string};
// The installed macOS CLI embeds this exact secure-storage key derivation and
// keychain read. An empty selector uses the unsuffixed key even when the work
// process has a separate CLAUDE_CONFIG_DIR. Unknown CLI builds fail closed.
const MAC_SHARED_KEYCHAIN_SOURCE=[
 'var oCe="-credentials";function zx(){',
 'function D1(e=""){let n=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,t=n!==void 0?!n:!process.env.CLAUDE_CONFIG_DIR',
 'a=t?"":`-${c("sha256").update(r).digest("hex").substring(0,8)}`;return`Claude Code${ln().OAUTH_FILE_SUFFIX}${e}${a}`',
 'let s=D1(oCe),n=Vx(),o=lHe(`security find-generic-password -a "${n}" -w -s "${s}"`',
].map(value=>Buffer.from(value));
async function sharedKeychainSourceContract(realPath:string):Promise<string>{
 if(process.platform!=='darwin')throw Error('company_work_claude_credential_source_unverified');
 const found=MAC_SHARED_KEYCHAIN_SOURCE.map(()=>false),longest=Math.max(...MAC_SHARED_KEYCHAIN_SOURCE.map(part=>part.length)),input=fs.createReadStream(realPath);let tail=Buffer.alloc(0);
 for await(const chunk of input){const combined=Buffer.concat([tail,chunk]);for(let i=0;i<found.length;i++)if(!found[i]&&combined.includes(MAC_SHARED_KEYCHAIN_SOURCE[i]))found[i]=true;tail=combined.subarray(Math.max(0,combined.length-longest+1))}
 if(found.some(value=>!value))throw Error('company_work_claude_credential_source_unverified');
 return digest({kind:'macos-shared-keychain',selector:'empty',source:MAC_SHARED_KEYCHAIN_SOURCE.map(part=>part.toString('utf8'))});
}

/** An allowlist, because the host environment may contain unrelated API keys,
 * personal hooks, cloud credentials and product control variables. HOME and
 * USER are retained solely for Claude's original subscription auth owner. */
function companyCliEnv(source:string,configDir?:string):NodeJS.ProcessEnv{
 const username=os.userInfo().username,home=os.homedir();
 const env:NodeJS.ProcessEnv={HOME:home,USER:username,LOGNAME:username,
  PATH:[path.dirname(source),path.dirname(process.execPath),...(process.platform==='win32'?[process.env.SystemRoot?path.join(process.env.SystemRoot,'System32'):'C:\\Windows\\System32'] : ['/usr/bin','/bin'])].join(path.delimiter),
  LANG:'en_US.UTF-8',NO_COLOR:'1',CLAUDE_SECURESTORAGE_CONFIG_DIR:''};
 if(process.platform==='win32')for(const key of ['APPDATA','LOCALAPPDATA','USERPROFILE','SystemRoot','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 if(configDir)env.CLAUDE_CONFIG_DIR=configDir;
 return env;
}
async function collect(source:string,args:string[],env:NodeJS.ProcessEnv,cwd:string,signal?:AbortSignal,limit=32768):Promise<{code:number|null;stdout:string}>{
 return new Promise((resolve,reject)=>{const child=crossSpawn(source,args,{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderrBytes=0,closed=false;const timer=setTimeout(()=>child.kill(),15000);
  const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout?.on('data',(chunk:Buffer)=>{stdout+=chunk.toString('utf8');if(Buffer.byteLength(stdout)>limit)child.kill()});
  child.stderr?.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>limit)child.kill()});
  child.once('error',error=>{if(closed)return;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error)});
  child.once('close',code=>{if(closed)return;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({code,stdout})});
 });
}
async function auth(source:string,configDir:string|null,signal?:AbortSignal):Promise<Auth>{
 const result=await collect(source,['auth','status','--json'],companyCliEnv(source,configDir??undefined),os.tmpdir(),signal);
 if(result.code!==0)throw Error('company_work_claude_auth_unavailable');
 let raw:unknown;try{raw=JSON.parse(result.stdout)}catch{throw Error('company_work_claude_auth_invalid')}
 if(!own(raw)||raw.loggedIn!==true||raw.authMethod!=='claude.ai'||raw.apiProvider!=='firstParty'||typeof raw.subscriptionType!=='string'||!raw.subscriptionType)throw Error('company_work_claude_subscription_required');
 return{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:raw.subscriptionType,
  accountDigest:digest([raw.email??null,raw.orgId??null,raw.orgName??null,raw.authMethod,raw.apiProvider,raw.subscriptionType]),
  accountMetadataPresent:typeof raw.email==='string'&&raw.email.length>0,
  accountMetadataAbsent:raw.email==null&&raw.orgId==null&&raw.orgName==null};
}
function identity(source:string){const current=observeCliExecutableIdentity({bin:source,cwd:os.tmpdir(),env:companyCliEnv(source)});if(!current||current.executable!==source)throw Error('company_work_claude_binary_unavailable');return current}
async function binarySha256(realPath:string,signal?:AbortSignal):Promise<string>{
 const hash=createHash('sha256');const input=fs.createReadStream(realPath);
 const abort=()=>input.destroy(Error('company_work_claude_binary_changed'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{for await(const chunk of input)hash.update(chunk);return hash.digest('hex')}
 finally{signal?.removeEventListener('abort',abort)}
}
function temporaryConfig(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentlas-company-claude-'));fs.chmodSync(dir,0o700);return dir}
export async function reviewCompanyClaudePin(runtime:RuntimeSelection,assertFocusedOwner:()=>void):Promise<CompanyClaudePin>{
 assertFocusedOwner();if(runtime.kind!=='claude-code'||runtime.backend!=='anthropic'||typeof runtime.source!=='string'||!path.isAbsolute(runtime.source)||typeof runtime.model!=='string'||!runtime.model||runtime.acpAgentId||runtime.longContext||runtime.inherit||runtime.role||runtime.effort&& !['low','medium','high','xhigh','max'].includes(runtime.effort))throw Error('company_work_runtime_tools_unverified');
 const detected=(await detectRuntimes()).find(row=>row.kind==='claude-code'&&row.backend==='anthropic'&&row.source===runtime.source&&row.availableModels?.includes(runtime.model!));
 assertFocusedOwner();if(!detected)throw Error('company_work_runtime_source_not_detected');
 const current=identity(runtime.source),binaryHash=await binarySha256(current.realPath),dir=temporaryConfig();
 try{const original=await auth(current.executable,null);assertFocusedOwner();const isolated=await auth(current.executable,dir);assertFocusedOwner();
  if(!original.accountMetadataPresent)throw Error('company_work_claude_account_unverified');
  let credentialSourceContractDigest:string|null=null;
  if(digest(original)!==digest(isolated)){
   if(!isolated.accountMetadataAbsent||original.authMethod!==isolated.authMethod||original.apiProvider!==isolated.apiProvider||original.subscriptionType!==isolated.subscriptionType)throw Error('company_work_claude_auth_mismatch');
   credentialSourceContractDigest=await sharedKeychainSourceContract(current.realPath);assertFocusedOwner();
  }
  if(identity(runtime.source).fingerprint!==current.fingerprint||await binarySha256(current.realPath)!==binaryHash)throw Error('company_work_claude_binary_changed');
  const configurationDigest=digest({source:current.executable,fingerprint:current.fingerprint,binarySha256:binaryHash,auth:original,credentialSourceContractDigest,flags:['setting-sources-empty','strict-mcp','restricted','tools-empty','no-session-persistence']});
  return Object.freeze({source:current.executable,fingerprint:current.fingerprint,binarySha256:binaryHash,auth:original,credentialSourceContractDigest,configurationDigest});
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
}
export async function assertCompanyClaudePin(pin:CompanyClaudePin,signal?:AbortSignal,verifyBytes=false):Promise<void>{
 const current=identity(pin.source);if(current.fingerprint!==pin.fingerprint)throw Error('company_work_claude_binary_changed');
 if(verifyBytes&&await binarySha256(current.realPath,signal)!==pin.binarySha256)throw Error('company_work_claude_binary_changed');
 const original=await auth(pin.source,null,signal);if(digest(original)!==digest(pin.auth))throw Error('company_work_claude_subscription_changed');
}

/** A fresh CLI process per Root-admitted job. Claude's init inventory must be
 * exactly the two prepared company servers' finite tool names before any
 * model/tool event is accepted. No personal config, session or built-in tool
 * can be selected by a model or renderer. */
export async function runCompanyClaude(req:RunnerRequest,events:RunnerEvents,pin:CompanyClaudePin,allowedTools:readonly string[],configDir:string,policyExpiresAt:string):Promise<RunnerResult>{
 if(!req.mcpConfigPath||!req.cwd||!allowedTools.length||new Set(allowedTools).size!==allowedTools.length||allowedTools.some(name=>!/^mcp__(?:company-agent-mail|company-files)__(?:agent_mail_(?:thread|read|reply|draft)|company_file_(?:read|write))$/.test(name)))throw Error('company_work_claude_tools_invalid');
 await assertCompanyClaudePin(pin,req.signal,true);fs.mkdirSync(configDir,{recursive:true,mode:0o700});
 const env=companyCliEnv(pin.source,configDir),args=['-p','--input-format','text','--system-prompt',req.systemPrompt,'--output-format','stream-json','--verbose','--no-session-persistence',
  '--setting-sources','','--strict-mcp-config','--restricted','--disable-slash-commands','--no-chrome','--tools','','--permission-mode','dontAsk',
  '--permission-prompts','none','--allowedTools',allowedTools.join(','),'--mcp-config',req.mcpConfigPath];
 if(req.model)args.push('--model',req.model);if(req.effort)args.push('--effort',req.effort);
 if(Buffer.byteLength(req.systemPrompt)+Buffer.byteLength(req.userPrompt)>150000)throw Error('company_work_claude_prompt_too_large');
 const timeBudget=companyClaudeTimeBudget(policyExpiresAt);
 return new Promise<RunnerResult>((resolve,reject)=>{const child=crossSpawn(pin.source,args,{cwd:configDir,env,stdio:['pipe','pipe','pipe'],windowsHide:true,...detachedSpawnOpts()});
  const pending=new Map<string,{name:string;args:string}>();let buffer='',outputBytes=0,stderrBytes=0,init=false,terminal:Record<string,unknown>|null=null,settled=false,fatal:Error|null=null;
  const violation=(code:string)=>{if(fatal)return;fatal=Error(code);killCliTree(child)};
  const deadline=setTimeout(()=>violation(timeBudget.reason),timeBudget.milliseconds),abort=()=>violation('company_work_claude_cancelled');req.signal?.addEventListener('abort',abort,{once:true});if(req.signal?.aborted)abort();
  const finish=(error?:Error,result?:RunnerResult)=>{if(settled)return;settled=true;clearTimeout(deadline);req.signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(result!)};
  const parse=(line:string)=>{if(fatal||!line.trim())return;let item:unknown;try{item=JSON.parse(line)}catch{return violation('company_work_claude_protocol_invalid')}
   if(!own(item))return violation('company_work_claude_protocol_invalid');
   if(item.type==='system'&&item.subtype==='init'){
    const tools=item.tools,servers=item.mcp_servers;if(init||!Array.isArray(tools)||tools.length!==allowedTools.length||tools.some(v=>typeof v!=='string'||!allowedTools.includes(v))||!Array.isArray(servers)||servers.length!==new Set(allowedTools.map(v=>v.split('__')[1])).size||servers.some(v=>!own(v)||v.status!=='connected'||!['company-agent-mail','company-files'].includes(String(v.name))))return violation('company_work_claude_tool_inventory_mismatch');
    init=true;return;
   }
   if(item.type==='assistant'&&own(item.message)&&Array.isArray(item.message.content)){if(!init)return violation('company_work_claude_init_missing');
    for(const part of item.message.content){if(!own(part))continue;if(part.type==='text'&&typeof part.text==='string'){events.onPartial(part.text)}
     if(part.type==='tool_use'){if(typeof part.name!=='string'||!allowedTools.includes(part.name)||typeof part.id!=='string')return violation('company_work_claude_tool_unapproved');pending.set(part.id,{name:part.name,args:JSON.stringify(part.input??{})})}}
    return;
   }
   if(item.type==='user'&&own(item.message)&&Array.isArray(item.message.content)){if(!init)return violation('company_work_claude_init_missing');for(const part of item.message.content){if(!own(part)||part.type!=='tool_result')continue;
    const id=String(part.tool_use_id??''),call=pending.get(id);if(!call)return violation('company_work_claude_tool_result_unknown');pending.delete(id);
    events.onTool?.(call.name,call.args,JSON.stringify(part.content??null),id,part.is_error===true);}
    return;
   }
   if(item.type==='result'){if(terminal)return violation('company_work_claude_duplicate_terminal');terminal=item;return}
  };
  child.stdin?.on('error',()=>violation('company_work_claude_stdin_failed'));child.stdin?.end(req.userPrompt);
  child.stdout?.on('data',(chunk:Buffer)=>{if(fatal)return;outputBytes+=chunk.length;if(outputBytes>2_000_000)return violation('company_work_claude_output_limit');buffer+=chunk.toString('utf8');let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);parse(line);if(fatal||settled)return}});
  child.stderr?.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>65536)violation('company_work_claude_stderr_limit')});
  child.once('error',()=>finish(Error('company_work_claude_spawn_failed')));
  child.once('close',code=>{if(settled)return;if(fatal)return finish(fatal);if(buffer.trim())parse(buffer);if(fatal)return finish(fatal);if(settled)return;
   if(code!==0||!init||!terminal||terminal.is_error!==false||terminal.subtype!=='success'||typeof terminal.result!=='string'||pending.size)return finish(Error('company_work_claude_terminal_failed'));
   const usage=own(terminal.usage)?terminal.usage:null, inputTokens=usage?.input_tokens,outputTokens=usage?.output_tokens,cacheTokens=usage?.cache_read_input_tokens;
   if(typeof outputTokens==='number'&&req.maxOutputTokens&&outputTokens>req.maxOutputTokens)return finish(Error('company_work_claude_output_tokens_exceeded'));
   void assertCompanyClaudePin(pin,req.signal,true).then(()=>finish(undefined,{text:terminal!.result as string,observedModel:own(terminal!.modelUsage)?Object.keys(terminal!.modelUsage)[0]:undefined,
    ...(typeof inputTokens==='number'&&typeof outputTokens==='number'?{observedUsage:{inputTokens,outputTokens,...(typeof cacheTokens==='number'?{cachedInputTokens:cacheTokens}:{})}}:{})})).catch(()=>finish(Error('company_work_claude_subscription_changed')));
  });
 });
}
