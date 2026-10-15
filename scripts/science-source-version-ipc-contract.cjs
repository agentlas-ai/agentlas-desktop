#!/usr/bin/env node
'use strict';
// Actual Main handler statements and helper selected by TS AST; no Main launch.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'..'),out=process.argv[2];if(!out||!path.isAbsolute(out))throw Error('absolute private output directory required');fs.mkdirSync(out,{recursive:true});
const ts=require(require.resolve('typescript',{paths:[repo]})),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const main=fs.readFileSync(path.join(repo,'electron/main.ts'),'utf8'),ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true),pieces=[];
function visit(n){
 if(ts.isFunctionDeclaration(n)&&n.name?.text==='scienceSourceReaderForIpc')pieces.push(n.getText(ast));
 if(ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(ast)==='ipcMain.handle'
 &&ts.isStringLiteral(n.expression.arguments[0])&&['science:sources:reader','science:sources:openOriginal'].includes(n.expression.arguments[0].text))pieces.push(n.getText(ast));
 ts.forEachChild(n,visit);
}visit(ast);assert.equal(pieces.length,3);
const compile=s=>{const c=ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.ok(!c.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error));return c.outputText;};
const compiled=compile(pieces.join('\n'));fs.writeFileSync(path.join(out,'actual-source-handlers.cjs'),compiled);
const project=fs.mkdtempSync(path.join(out,'public-fixture-project-'));fs.mkdirSync(path.join(project,'papers'),{recursive:true});
const pdf=path.join(project,'papers','paper.pdf'),html=path.join(project,'papers','paper.html'),pdfBytes=Buffer.from('%PDF-1.7\nPublic fixture bytes only.\n%%EOF');fs.writeFileSync(pdf,pdfBytes);fs.writeFileSync(html,'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><p>Public fixture</p>');
const scope={projectId:'11111111-1111-4111-8111-111111111111',sourceId:'22222222-2222-4222-8222-222222222222'},oldVersion='33333333-3333-4333-8333-333333333333',currentVersion='44444444-4444-4444-8444-444444444444',parsedHash=sha(Buffer.from('parsed public paper'));
let checks=0,opens=[],calls=[],allowed=true,current,readHook;
const check=(v,label)=>{assert.ok(v,label);checks++;};
function view(version=oldVersion,file=pdf,kind='pdf'){
 const bytes=fs.readFileSync(file),hash=sha(bytes);
 return {schema:'agentlas.science.source-reader/v1',...scope,sourceVersionId:version,sourceContentSha256:parsedHash,bodyState:'hash-verified',original:{path:file,kind,sourceId:scope.sourceId,sourceVersionId:version,sourceContentSha256:parsedHash,rawSha256:kind==='pdf'?hash:sha(Buffer.from('raw html')),mirrorSha256:hash,transformation:kind==='pdf'?'identity':'inert-html/v1'}};
}
const handlers=new Map(),store={sourceReaderView(...args){calls.push(args);return current;},getProject(id){assert.equal(id,scope.projectId);return {folderPath:project};}};
const event={sender:{id:7},senderFrame:{}};
const fsPort=new Proxy(fs,{get(target,key){if(key==='readFileSync')return (...args)=>{const bytes=target.readFileSync(...args);if(readHook&&typeof args[0]==='number')readHook();return bytes;};return Reflect.get(target,key);}});
vm.runInNewContext(compiled,{ipcMain:{handle(c,h){handlers.set(c,h);}},scienceStore:()=>store,assertScienceSender(e,input){if(!allowed||e!==event||input.extensionId!=='fixture-science')throw Error('fixture-sender-denied');},fs:fsPort,path,createHash:crypto.createHash,Buffer,shell:{async openPath(file){opens.push(file);return '';}}},{filename:'actual-source-handlers.cjs'});
const envelope=(...args)=>{const version=args.length?args[0]:oldVersion;return {extensionId:'fixture-science',...scope,...(version===undefined?{}:{sourceVersionId:version})};};
const reader=handlers.get('science:sources:reader'),open=handlers.get('science:sources:openOriginal');
async function refused(label,mutate){current=view();const count=opens.length;mutate();assert.equal((await open(event,envelope())).ok,false,label);checks++;check(opens.length===count,label+' no shell call');}
(async()=>{
 current=view();assert.equal(reader(event,envelope()),current);checks++;assert.deepEqual(calls.at(-1),[scope.projectId,scope.sourceId,oldVersion]);checks++;
 current=view(currentVersion);assert.equal(reader(event,envelope(undefined)),current);checks++;assert.deepEqual(calls.at(-1),[scope.projectId,scope.sourceId,undefined]);checks++;
 assert.throws(()=>reader(event,envelope()),/version-mismatch/);checks++;
 current={...view(),sourceVersionId:undefined};assert.throws(()=>reader(event,envelope()),/version-mismatch/);checks++;
 current={...view(),sourceId:'foreign'};assert.throws(()=>reader(event,envelope()),/version-mismatch/);checks++;
 current=view();assert.throws(()=>reader(event,{...envelope(),sourceVersionId:''}),/version-invalid/);checks++;
 assert.throws(()=>reader(event,{...envelope(),projectId:''}),/scope-invalid/);checks++;
 allowed=false;assert.throws(()=>reader(event,envelope()),/sender-denied/);checks++;allowed=true;
 current=view();assert.equal((await open(event,envelope())).ok,true);checks++;check(opens.at(-1)===pdf,'historical exact PDF opened');
 current=view(currentVersion);assert.equal((await open(event,envelope(undefined))).ok,true);checks++;
 await refused('legacy original unavailable',()=>{current.original={path:pdf};});
 await refused('source original mismatch',()=>{current.original.sourceId='foreign';});
 await refused('version original mismatch',()=>{current.original.sourceVersionId=currentVersion;});
 await refused('content original mismatch',()=>{current.original.sourceContentSha256='0'.repeat(64);});
 await refused('unknown source hash',()=>{current.sourceContentSha256=null;});
 await refused('unverified body',()=>{current.bodyState='unavailable';});
 await refused('coerced kind refused',()=>{current.original.kind={toString:()=> 'pdf'};});
 await refused('unknown mirror hash',()=>{delete current.original.mirrorSha256;});
 await refused('unknown transform',()=>{current.original.transformation='unknown';});
 await refused('PDF raw mirror mismatch',()=>{current.original.rawSha256='0'.repeat(64);});
 await refused('changed path bytes',()=>{fs.writeFileSync(pdf,Buffer.from('%PDF-changed'));});fs.writeFileSync(pdf,pdfBytes);
 const fakePdf=path.join(project,'papers','notpdf.pdf');fs.writeFileSync(fakePdf,'not pdf');await refused('PDF magic absent',()=>{current=view(oldVersion,fakePdf);});
 const outside=path.join(out,'outside.pdf');fs.writeFileSync(outside,pdfBytes);await refused('outside papers',()=>{current=view(oldVersion,outside);});
 const linked=path.join(project,'papers','linked.pdf');fs.symlinkSync(pdf,linked);await refused('symlink path',()=>{current=view(oldVersion,linked);});
 current=view(oldVersion,html,'html');assert.equal((await open(event,envelope())).ok,true);checks++;check(opens.at(-1)===html,'pinned inert HTML opened');
 await refused('HTML missing transform',()=>{current=view(oldVersion,html,'html');current.original.transformation='identity';});
 current=view();const before=opens.length;readHook=()=>{allowed=false;};await assert.rejects(open(event,envelope()),/sender-denied/);checks++;readHook=undefined;allowed=true;check(opens.length===before,'read-time revocation rejects shell');
 current=view(currentVersion);await assert.rejects(open(event,envelope()),/version-mismatch/);checks++;
 // Execute production preload only in inert Electron ports; the owner gesture
 // remains mandatory for originals. No browser, window or Electron is started.
 let bridge,invokes=[],active=true;
 const preload=compile(fs.readFileSync(path.join(repo,'electron/science-preload.ts'),'utf8'));
 vm.runInNewContext(preload,{exports:{},require(name){assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld(n,v){bridge=v;}},ipcRenderer:{invoke(c,input){invokes.push({c,input});return Promise.resolve({});}}};},process:{argv:['--agentlas-extension-id=fixture-science'],env:{}},navigator:{userActivation:{get isActive(){return active;}}},Promise,Error});
 await bridge.sources.reader(scope.projectId,scope.sourceId,oldVersion);check(invokes.at(-1).input.sourceVersionId===oldVersion,'preload reader historical version');
 await bridge.sources.reader(scope.projectId,scope.sourceId);check(invokes.at(-1).input.sourceVersionId===undefined,'preload current compatibility');
 await bridge.sources.openOriginal(scope.projectId,scope.sourceId,oldVersion);check(invokes.at(-1).input.sourceVersionId===oldVersion,'preload original historical version');
 active=false;const invokeCount=invokes.length;await assert.rejects(bridge.sources.openOriginal(scope.projectId,scope.sourceId,oldVersion),/user-gesture-required/);checks++;check(invokes.length===invokeCount,'gesture denial no IPC');
 const catalogExports={},schemaExports={};vm.runInNewContext(compile(fs.readFileSync(path.join(repo,'electron/app-control/catalog.generated.ts'),'utf8')),{exports:catalogExports});vm.runInNewContext(compile(fs.readFileSync(path.join(repo,'electron/app-control/argument-schemas.generated.ts'),'utf8')),{exports:schemaExports});
 const entry=catalogExports.APP_CONTROL_CATALOG.find(e=>e.path==='science.sources.reader');check(entry.params.includes('sourceVersionId'),'generated catalog version param');
 const schema=schemaExports.APP_CONTROL_ARGUMENT_SCHEMAS['science.sources.reader'];check(schema.properties.sourceVersionId.type==='string'&&!schema.required.includes('sourceVersionId'),'generated optional argument');
 check(!catalogExports.APP_CONTROL_CATALOG.some(e=>e.path==='science.sources.openOriginal'),'owner-gesture original remains excluded from app-control');
 const receipt={schema:'agentlas.science-source-version-ipc-contract.v1',status:'passed',checks,shellMockCalls:opens.length,source:{mainSha256:sha(Buffer.from(main)),preloadSha256:sha(fs.readFileSync(path.join(repo,'electron/science-preload.ts')))},compiledSha256:sha(Buffer.from(compiled)),contractSha256:sha(fs.readFileSync(__filename)),boundaries:{actualAstSelectedRegisteredHandlers:true,publicFixtureFiles:true,shellMockOnly:true,realAuth:false,mainAppLaunch:false,existingUserDataTouched:false,installedUi:'unverified',atomicViewerPathHandoff:'not-guaranteed',modelConsumption:'unknown'}};fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
})().catch(e=>{console.error(e.stack||String(e));process.exitCode=1;});
