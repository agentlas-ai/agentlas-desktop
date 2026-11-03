const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('renderer/components/HostContinuationNotice.tsx', 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const events = [];
const Markdown = () => null, Dispatch = () => null;
const context = {exports:{}, window:{dispatchEvent:event=>events.push(event)}, CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}}, require:id => {
  if(id==='react/jsx-runtime') return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  if(id==='./Markdown') return {Markdown};
  if(id==='./one/OneDispatchNotice') return {OneDispatchNotice:Dispatch};
  if(id.includes('automation-report-display')) return {automationReportDisplay:()=>({name:'',body:'body'})};
  if(id.includes('chat-host-notice')) return {isHousekeepingHostNotice:()=>false,agiActionNoticeLine:()=>null};
  throw new Error(id);
}};
vm.runInNewContext(compiled,context);
const render=context.exports.HostContinuationNotice;
const find=(node,type)=>{if(!node||typeof node!=='object')return null;if(node.type===type)return node;for(const value of Object.values(node.props||{})){for(const child of Array.isArray(value)?value:[value]){const result=find(child,type);if(result)return result;}}return null;};
const web={href:'https://example.com/a',name:'web'}, local={href:'/private/child.txt',name:'child'};
for(const purpose of ['one-dispatch-brief','automation-report','one-dispatch-result']) {
  const notice={purpose,runId:'r',automationId:'a'};
  const node=render({text:'text',locale:'en',notice,chatId:'parent'});
  const child=find(node,purpose==='one-dispatch-result'?Dispatch:Markdown);
  assert.ok(child, purpose);
  child.props.onOpenLinkedFile(web);
  assert.equal(events.at(-1).detail.chatId,'parent');
  assert.equal(events.at(-1).detail.href,web.href);
  const before=events.length;
  child.props.onOpenLinkedFile(local);
  assert.equal(events.length,before,'child local file must not inherit parent scope');
}
const unbound=find(render({text:'text',locale:'en',notice:{purpose:'one-dispatch-brief',runId:'r'}}),Markdown);
const before=events.length; unbound.props.onOpenLinkedFile(web); assert.equal(events.length,before);
let received;
const scoped=find(render({text:'text',locale:'en',notice:{purpose:'one-dispatch-brief',runId:'r'},chatId:'parent',onOpenLinkedFile:file=>{received=file;}}),Markdown);
scoped.props.onOpenLinkedFile(web); assert.equal(received,web);
console.log('host notice links: scoped web routing and child local isolation passed');
// Exercise the actual Personal One callback and post-render effect with a
// simulated panel listener. This checks the owner transition without an app DB.
const personal=fs.readFileSync('renderer/components/one/PersonalOneWorkspace.tsx','utf8');
const tree=ts.createSourceFile('PersonalOneWorkspace.tsx',personal,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let openInitializer, pendingEffect;
function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(tree)==='openFile') openInitializer=node.initializer;
  if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useEffect'&&node.arguments[0]?.getText(tree).includes('pendingWebLink.chatId!==panelChatId')) pendingEffect=node.arguments[0];
  ts.forEachChild(node,visit);
}
visit(tree); assert.ok(openInitializer); assert.ok(pendingEffect);
const evaluate=(expression,globals)=>{
  const js=ts.transpileModule(`result = ${expression.getText(tree)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const sandbox={...globals};vm.runInNewContext(js,sandbox);return sandbox.result;
};
const state={file:{chatId:'old-task'},taskOpen:true,browserChatId:null,artifactOpen:false,pending:null,error:false};
let localCalls=0;
const open=evaluate(openInitializer,{useCallback:fn=>fn,setFile:v=>state.file=v,setTasksOpen:v=>state.taskOpen=v,setBrowserChatId:v=>state.browserChatId=v,setArtifactOpen:v=>state.artifactOpen=v,setPendingWebLink:v=>state.pending=v,setError:v=>state.error=v,personalOneFile:(file,chatId)=>{localCalls++;return {path:file.href,chatId};}});
open(web,'conversation');
assert.equal(state.file,null);assert.equal(state.browserChatId,'conversation');assert.equal(state.artifactOpen,true);assert.equal(state.taskOpen,false);assert.equal(localCalls,0);
let panelOwner='old-task';const accepted=[];
const dispatch=event=>{if(event.detail.chatId===panelOwner)accepted.push(event.detail);};
const effect=()=>evaluate(pendingEffect,{pendingWebLink:state.pending,panelChatId:state.browserChatId,window:{dispatchEvent:dispatch},CustomEvent:context.CustomEvent,setPendingWebLink:v=>state.pending=v})();
// A different panel ignores the scoped event, as TaskSidePanel's listener does.
effect();assert.equal(accepted.length,0);
open(web,'conversation');panelOwner=state.browserChatId;effect();assert.equal(accepted.length,1);assert.equal(accepted[0].href,web.href);assert.equal(state.pending,null);
open(local,'child');assert.equal(localCalls,1);assert.equal(state.file.chatId,'child');assert.equal(state.file.path,local.href);assert.equal(state.browserChatId,null);assert.equal(state.error,false);
console.log('personal One links: panel owner switch, scoped delivery and local file routing passed');
