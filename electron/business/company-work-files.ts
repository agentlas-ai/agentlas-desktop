import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash,randomUUID,timingSafeEqual } from 'node:crypto';
import { businessOnlyKeys } from '../../shared/business/context';
import { assertCompanyWorkGrant,refreshCompanyWorkGrant } from './company-work-grant';
import { recordCompanyWorkContent,withCompanyWorkContent } from './company-work-content';
import { defineBuiltinMcpLaunch } from '../mcp-tools/builtin-mcp-launch';
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const fileName=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.(?:md|txt|json|csv)$/i.test(v)&&!v.includes('..');
const tools=[{name:'company_file_read',description:'Read an explicitly approved company input or this job output. Returns exact UTF-8 text and SHA-256.',inputSchema:{type:'object',properties:{area:{type:'string',enum:['inputs','outputs']},path:{type:'string'}},required:['area','path'],additionalProperties:false}},{name:'company_file_write',description:'Create or replace a UTF-8 company job output. Relative filename only; expectedSha256:null creates, otherwise exact prior SHA-256 is required. Source inputs are immutable.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string',maxLength:65536},expectedSha256:{type:['string','null']}},required:['path','content','expectedSha256'],additionalProperties:false}}];
const source=String.raw`
const fs=require('node:fs'),readline=require('node:readline');
const tools=${JSON.stringify(tools)};
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
async function handle(v){if(!v||typeof v!=='object'||!Object.hasOwn(v,'id'))return;
 try{let result;if(v.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'agentlas-company-files',version:'1'}};
 else if(v.method==='ping')result={};else if(v.method==='tools/list')result={tools};
 else if(v.method==='tools/call'){if(!tools.some(t=>t.name===v.params?.name))throw Error('company_file_operation_denied');const c=JSON.parse(fs.readFileSync(process.env.AGENTLAS_COMPANY_FILE_CONTROL,'utf8'));const response=await fetch('http://127.0.0.1:'+c.port+'/company-files',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+c.token},body:JSON.stringify({name:v.params.name,args:v.params.arguments})});const body=await response.json();result={content:[{type:'text',text:JSON.stringify(body)}],isError:!response.ok};}
 else throw Error('method_not_found');send({jsonrpc:'2.0',id:v.id,result});}catch{send({jsonrpc:'2.0',id:v.id,error:{code:-32000,message:'company_file_request_failed'}})}}
readline.createInterface({input:process.stdin}).on('line',line=>{try{void handle(JSON.parse(line))}catch{}});
`;
const launches=new Map<string,ReturnType<typeof defineBuiltinMcpLaunch>>();
const companyFileLaunch=(names:readonly string[])=>{if(!names.length||names.some(n=>!['company_file_read','company_file_write'].includes(n))||new Set(names).size!==names.length)throw Error('company_file_operation_denied');const key=JSON.stringify([...names].sort());let launch=launches.get(key);if(!launch){launch=defineBuiltinMcpLaunch('agentlas-company-files',source.replace('const tools='+JSON.stringify(tools)+';', 'const tools='+JSON.stringify(tools.filter(t=>names.includes(t.name)))+';'));launches.set(key,launch)}return launch};
export const companyFileMcpLaunchArgs=(names:readonly string[])=>companyFileLaunch(names).launchArgs();
export const isAuthenticCompanyFileMcpLaunch=(command:string|null,args:readonly string[],names:readonly string[])=>command===process.execPath&&companyFileLaunch(names).isAuthenticArgs(args);
/** Pure bounded owner path, independently revalidated at every read/effect. */
export async function dispatchCompanyFile(cap:object,name:string,args:unknown):Promise<{path:string;sha256:string;bytes:number;text?:string}>{
 await refreshCompanyWorkGrant(cap);const grant=assertCompanyWorkGrant(cap),root=grant.workspace.canonicalPath!;
 if(!grant.job.policy.tools.includes(name as 'company_file_read'))throw Error('company_file_operation_denied');
 if(name==='company_file_read'){
  if(!businessOnlyKeys(args,['area','path'])||typeof args.path!=='string'||!['inputs','outputs'].includes(String(args.area)))throw Error('company_file_request_invalid');
  let selected:string,expected:{digest:string;bytes:number}|undefined;
  if(args.area==='inputs'){expected=grant.asset.files.find(f=>f.path===args.path);if(!expected||!grant.asset.approvedPaths.includes(args.path))throw Error('company_file_input_denied');selected=path.join(grant.asset.rootPath,args.path)}
  else{if(!fileName(args.path))throw Error('company_file_path_denied');selected=path.join(root,args.path)}
  const fd=fs.openSync(selected,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes:Buffer;
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>196608||fs.realpathSync.native(selected)!==selected)throw Error('company_file_path_denied');bytes=fs.readFileSync(fd)}finally{fs.closeSync(fd)}
  if(expected&&(bytes.length!==expected.bytes||hash(bytes)!==expected.digest))throw Error('company_file_input_changed');
  const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))throw Error('company_file_utf8_required');assertCompanyWorkGrant(cap);
  return{path:args.path,sha256:hash(bytes),bytes:bytes.length,text};
 }
 if(name!=='company_file_write'||!businessOnlyKeys(args,['path','content','expectedSha256'])||!fileName(args.path)||typeof args.content!=='string'||Buffer.byteLength(args.content)>65536||args.expectedSha256!==null&&(typeof args.expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(args.expectedSha256)))throw Error('company_file_request_invalid');
 const destination=path.join(root,args.path),bytes=Buffer.from(args.content,'utf8');
 let previous:string|null=null;try{const stat=fs.lstatSync(destination);if(!stat.isFile()||stat.isSymbolicLink())throw Error('company_file_path_denied');previous=hash(fs.readFileSync(destination))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 if(previous!==args.expectedSha256)throw Error('company_file_revision_conflict');
 // No awaited work separates the original CAS observation from atomic rename.
 const temporary=path.join(root,'.company-output-'+randomUUID()+'.tmp');
 try{const fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}assertCompanyWorkGrant(cap);fs.renameSync(temporary,destination)}finally{try{fs.unlinkSync(temporary)}catch{}}
 const result={path:args.path,sha256:hash(bytes),bytes:bytes.length};recordCompanyWorkContent('output-file',result);assertCompanyWorkGrant(cap);return result;
}
export async function createCompanyFileServer(cap:object,controlPath:string):Promise<{close():void}>{
 const token=randomUUID();const server=http.createServer((request,response)=>{void(async()=>{try{
  const supplied=Buffer.from(request.headers.authorization??''),expected=Buffer.from('Bearer '+token);
  if(request.method!=='POST'||request.url!=='/company-files'||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw Error('company_file_auth_required');
  const chunks:Buffer[]=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>300000)throw Error('company_file_body_too_large');chunks.push(Buffer.from(chunk))}
  const raw:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!businessOnlyKeys(raw,['name','args'])||typeof raw.name!=='string')throw Error('company_file_request_invalid');
  const grant=assertCompanyWorkGrant(cap);const result=await withCompanyWorkContent({capability:cap,db:grant.companyDb,jobId:grant.job.jobId,runId:grant.job.runId},()=>dispatchCompanyFile(cap,raw.name as string,raw.args));response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result));
 }catch{response.writeHead(403,{'content-type':'application/json'});response.end(JSON.stringify({error:'company_file_request_denied'}))}})()});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});server.unref();const address=server.address();if(!address||typeof address==='string'){server.close();throw Error('company_file_server_unavailable')}
 fs.writeFileSync(controlPath,JSON.stringify({port:address.port,token}),{flag:'wx',mode:0o600});return{close(){server.close();try{fs.unlinkSync(controlPath)}catch{}}};
}
