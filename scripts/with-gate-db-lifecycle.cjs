#!/usr/bin/env node
'use strict';
// Private operator helper. Neither this file nor its observer/native source is a
// public release asset. Original guards and verifiers are never edited here.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const life=require('./lib/gate-db-lifecycle.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2),separator=args.indexOf('--'),evidenceAt=args.indexOf('--evidence-dir');
if(separator<0||evidenceAt<0||evidenceAt+1>=separator||args[separator+1]!=='git'||args[separator+2]!=='commit')throw Error('usage: with-gate-db-lifecycle.cjs --evidence-dir /private/out -- git commit ...');
if(process.env.AGENTLAS_SKIP_PRECOMMIT==='1'||process.env[life.ENV])throw Error('gate_life_original_guard_bypass_or_nested_run_refused');
const repo=fs.realpathSync(cp.execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim());
if(path.basename(repo)!=='agentlas_desktop')throw Error('gate_life_desktop_operator_only');
const evidenceDir=path.resolve(args[evidenceAt+1]);if(evidenceDir===repo||evidenceDir.startsWith(repo+path.sep))throw Error('gate_life_evidence_must_be_private');
const files=['scripts/lib/gate-db-lifecycle.cjs','scripts/lib/gate-db-vfs.c','scripts/with-gate-db-lifecycle.cjs'];
// The operator must run the exact helper bytes selected by the existing private
// index. No live unstaged helper or peer change is borrowed for verification.
for(const file of files){const staged=cp.execFileSync('git',['show',':'+file],{cwd:repo,maxBuffer:4*1024*1024});if(sha(staged)!==sha(fs.readFileSync(path.join(repo,file))))throw Error('gate_life_helper_differs_from_selected_index:'+file);}
const ownerId='agentlas-private-normal-commit:'+sha(repo);
life.recoverOwnedSessions(evidenceDir,ownerId);
const electron=require(require.resolve('electron',{paths:[repo]}));
const gitExecutables=process.platform==='darwin'?[cp.execFileSync('/usr/bin/xcrun',['--find','git'],{encoding:'utf8',timeout:5000}).trim()]:[cp.execFileSync('which',['git'],{encoding:'utf8',timeout:5000}).trim()];
const ctx=life.createSession({sourceFile:require.resolve('./lib/gate-db-lifecycle.cjs'),evidenceDir,repoRoot:repo,ownerId,nodeExecutables:[electron],gitExecutables});
let child,result,cleanup,processCleanup;const signals=[];
function forward(signal){signals.push(signal);if(child&&child.exitCode===null&&child.signalCode===null)try{child.kill(signal);}catch{}}
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>forward(signal));
(async()=>{
 try{
  life.prepareNativeVfs(ctx,{sourceFile:path.join(__dirname,'lib/gate-db-vfs.c'),includeDirectory:path.join(repo,'node_modules/better-sqlite3/deps/sqlite3')});
  const existing=process.env.NODE_OPTIONS??'';
  const env={...process.env,[life.ENV]:ctx.manifest,NODE_OPTIONS:`--require=${ctx.bootstrap}`+(existing?' '+existing:'')};
  child=cp.spawn('git',args.slice(separator+2),{cwd:repo,env,stdio:'inherit'});
  result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 }catch(error){result={code:1,signal:null,error:error.code??error.message??'gate_life_git_launch_failed'};}
 finally{
  try{processCleanup=await life.stopOwnedProcesses(ctx);cleanup=life.auditAndCleanup(ctx);}catch(error){cleanup={complete:false,error:error.code??error.message,controlRoot:ctx.root};}
  const record={schema:'agentlas.gate-db-normal-commit.v1',runId:ctx.runId,originalGit:result,signals,processCleanup,cleanup,scope:'Original normal git hook with additive lifecycle admission. Original assertions, execution modes and nonzero statuses remain unchanged. Failed or unexecuted checks are never passes.'};
  fs.mkdirSync(evidenceDir,{recursive:true});fs.writeFileSync(path.join(evidenceDir,ctx.runId+'-commit.json'),JSON.stringify(record,null,2));
 }
 if(result?.signal)process.exitCode=128+({SIGHUP:1,SIGINT:2,SIGTERM:15}[result.signal]??1);
 else process.exitCode=result?.code!==0?(result?.code??1):(cleanup?.complete&&processCleanup?.complete?0:1);
})().catch(error=>{console.error(error);process.exitCode=1;});
