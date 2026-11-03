"use strict";
// Additive test-data ownership. This never changes a verifier assertion, SQL text,
// execution mode, HOME, TMPDIR, original exit code, or an existing INDEX reader.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const cp = require("node:child_process"), Module = require("node:module"), crypto = require("node:crypto");
const {fileURLToPath} = require("node:url");
const raw = Object.fromEntries(["readFileSync","writeFileSync","appendFileSync","mkdirSync","mkdtempSync","lstatSync","statSync","realpathSync","readdirSync","unlinkSync","rmdirSync","existsSync","openSync","readSync","closeSync","fsyncSync","writeSync","renameSync"].map(name => [name,fs[name].bind(fs)]));
const rawSpawn = cp.spawnSync.bind(cp);
const ENV = "AGENTLAS_GATE_DB_LIFECYCLE";
const SCHEMA = "agentlas.gate-db-lifecycle.v1";
const markerName = "OWNER.manifest.json";
const prefix = "agentlas-gate-life-";
const memoryDb = name => name === ":memory:";
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const within = (child,root) => child === root || child.startsWith(root + path.sep);
const overlaps = (a,b) => within(a,b) || within(b,a);
function processBirth(pid) {
  if(process.platform === "win32") return null;
  const result=rawSpawn("ps",["-p",String(pid),"-o","lstart="],{encoding:"utf8",stdio:["ignore","pipe","ignore"],env:{...process.env,LC_ALL:"C"},timeout:5000});
  return result.status===0 ? result.stdout.trim() : null;
}
function productionRoots() {
  const home=os.userInfo().homedir;
  return [path.join(home,"Library/Application Support/Agentlas"),path.join(home,"Library/Application Support/agentlas"),path.join(home,".agentlas"),path.join(home,".config/Agentlas"),path.join(home,"AppData/Roaming/Agentlas")]
    .flatMap(p=>{try{return[p,raw.realpathSync(p)];}catch{return[p];}});
}
function canonical(filename) {
  let name=Buffer.isBuffer(filename)?filename.toString():filename;
  if(name instanceof URL)name=fileURLToPath(name);
  if(typeof name!=="string")throw Error("gate_life_path_not_text");
  const absolute=path.resolve(name);let existing=absolute,tail=[];
  while(!raw.existsSync(existing)){tail.unshift(path.basename(existing));const parent=path.dirname(existing);if(parent===existing)throw Error("gate_life_path_unresolvable");existing=parent;}
  return path.join(raw.realpathSync(existing),...tail);
}
function readContext(file) {
  const p=path.resolve(file),stat=raw.lstatSync(p);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw Error("gate_life_manifest_invalid");
  const ctx=JSON.parse(raw.readFileSync(p,"utf8"));
  if(ctx.schema!==SCHEMA||ctx.manifest!==p||raw.realpathSync(ctx.root)!==ctx.root||!within(p,ctx.root)
    ||raw.lstatSync(ctx.root).isSymbolicLink()||!ctx.runId||!path.basename(ctx.root).startsWith(prefix))throw Error("gate_life_manifest_invalid");
  const identity=raw.lstatSync(ctx.root);if(!ctx.rootIdentity||identity.dev!==ctx.rootIdentity.dev||identity.ino!==ctx.rootIdentity.ino||identity.birthtimeMs!==ctx.rootIdentity.birthtimeMs)throw Error("gate_life_control_root_changed");
  for(const prod of productionRoots())if(overlaps(ctx.root,prod))throw Error("gate_life_production_overlap");
  return ctx;
}
function durableFile(file,bytes){const fd=raw.openSync(file,"wx",0o600);try{const value=Buffer.from(bytes);let offset=0;while(offset<value.length){const written=raw.writeSync(fd,value,offset,value.length-offset);if(written<=0)throw Error("gate_life_metadata_write_incomplete");offset+=written;}raw.fsyncSync(fd);}finally{raw.closeSync(fd);}}
// Registered-only removal (owner policy). Nothing below reads file content and nothing
// below is recursive: every file or symlink is removed only when the manifest registered that exact path, every
// directory only when it is empty (rmdir), and every removal is re-read to confirm absence. Anything else is
// kept and reported with the exact path and reason. `isRegisteredFile`/`isRegisteredLink` receive absolute paths.
function removeRegisteredTree(rootPath,isRegisteredFile,isRegisteredLink){
  const removed=[],kept=[],failed=[];
  const confirmAbsent=(entry)=>{try{raw.lstatSync(entry);return false;}catch(error){return error.code==="ENOENT";}};
  const drop=(entry,remover)=>{
    try{remover(entry);}catch(error){if(error.code!=="ENOENT"){failed.push({path:entry,reason:"gate_life_cleanup_failed",code:error.code??null});return false;}}
    if(!confirmAbsent(entry)){failed.push({path:entry,reason:"gate_life_cleanup_failed",code:"still_present_after_remove"});return false;}
    removed.push(entry);return true;
  };
  function walk(directory){
    let names;
    try{names=raw.readdirSync(directory).sort();}catch(error){kept.push({path:directory,reason:"gate_life_cleanup_directory_unreadable",code:error.code??null});return false;}
    let empty=true;
    for(const name of names){
      const entry=path.join(directory,name);let stat;
      try{stat=raw.lstatSync(entry);}catch(error){if(error.code==="ENOENT")continue;kept.push({path:entry,reason:"gate_life_cleanup_entry_unreadable",code:error.code??null});empty=false;continue;}
      if(stat.isSymbolicLink()){
        if(!isRegisteredLink(entry)){kept.push({path:entry,reason:"gate_life_cleanup_symlink_unregistered"});empty=false;continue;}
        if(!drop(entry,raw.unlinkSync))empty=false;
      }else if(stat.isDirectory()){
        if(!walk(entry)){empty=false;continue;}
        if(!drop(entry,raw.rmdirSync))empty=false;
      }else if(stat.isFile()){
        if(!isRegisteredFile(entry)){kept.push({path:entry,reason:"gate_life_cleanup_unregistered_entry_kept"});empty=false;continue;}
        if(!drop(entry,raw.unlinkSync))empty=false;
      }else{kept.push({path:entry,reason:"gate_life_cleanup_special_entry_kept"});empty=false;}
    }
    return empty;
  }
  if(walk(rootPath))drop(rootPath,raw.rmdirSync);
  return {removed,kept,failed,absent:confirmAbsent(rootPath)};
}
// The control root holds only files this tool wrote: manifest, bootstrap, native build output and event logs.
function controlRegistration(root,ctx){
  const exact=new Set([path.join(root,markerName),path.join(root,"bootstrap.cjs"),ctx?.nativeVfs?.source,ctx?.nativeVfs?.library].filter(Boolean));
  const events=path.join(root,"events");
  return file=>exact.has(file)||(path.dirname(file)===events&&/^\d+-[a-f0-9-]+\.jsonl$/.test(path.basename(file)))||(path.dirname(file)===root&&path.basename(file).startsWith(markerName+".update-"));
}
function createSession({sourceFile=__filename,evidenceDir,repoRoot=null,ownerId=null,nativeFixture=false,nodeExecutables=[],gitExecutables=[]}={}) {
  if(global[Symbol.for(SCHEMA)])throw Error("gate_life_nested_session_refused");
  const sourceBytes=raw.readFileSync(sourceFile);
  const executables=[...new Set([process.execPath,...nodeExecutables].map(file=>raw.realpathSync(file)))].map(file=>({path:file,sha256:sha(raw.readFileSync(file))}));
  const repository=repoRoot?raw.realpathSync(repoRoot):null,evidence=evidenceDir?path.resolve(evidenceDir):null;
  const temp=raw.realpathSync(os.tmpdir());
  for(const prod of productionRoots())if(overlaps(temp,prod)||evidence&&overlaps(evidence,prod))throw Error("gate_life_control_production_overlap");
  if(evidence){raw.mkdirSync(path.join(evidence,"active"),{recursive:true,mode:0o700});if(raw.realpathSync(evidence)!==evidence||raw.lstatSync(path.join(evidence,"active")).isSymbolicLink())throw Error("gate_life_registry_symlink_refused");}
  const root=raw.realpathSync(raw.mkdtempSync(path.join(temp,prefix))),identity=raw.lstatSync(root);let ctx;
  try{
    fs.chmodSync(root,0o700);const runId=crypto.randomUUID(),manifest=path.join(root,markerName),bootstrap=path.join(root,"bootstrap.cjs");
    ctx={schema:SCHEMA,runId,createdAt:new Date().toISOString(),pid:process.pid,ppid:process.ppid,birth:processBirth(process.pid),root,manifest,bootstrap,
      rootIdentity:{dev:identity.dev,ino:identity.ino,birthtimeMs:identity.birthtimeMs},nodeExecutables:executables,gitExecutables:[...new Set(["/usr/bin/git",...gitExecutables].filter(file=>raw.existsSync(file)).map(file=>raw.realpathSync(file)))].map(file=>({path:file,sha256:sha(raw.readFileSync(file))})),ownerId:ownerId??runId,nativeFixture:nativeFixture===true,bootstrapSha256:sha(sourceBytes),repoRoot:repository,evidenceDir:evidence,dbSidecars:["-wal","-shm","-journal"],state:"active"};
    if(evidence)ctx.registryFile=path.join(evidence,"active",runId+".json");
    durableFile(manifest,JSON.stringify(ctx,null,2));raw.mkdirSync(path.join(root,"events"),{mode:0o700});durableFile(bootstrap,sourceBytes);
    if(ctx.registryFile)durableFile(ctx.registryFile,JSON.stringify({schema:SCHEMA,ownerId:ctx.ownerId,runId,manifest,pid:ctx.pid,birth:ctx.birth,state:"active"}));
    return ctx;
  }catch(error){
    // No verifier or database has started in this synchronous setup phase.
    // Remove only the empty/new control directory with its original identity.
    const current=raw.lstatSync(root);if(!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino&&current.birthtimeMs===identity.birthtimeMs){removeRegisteredTree(root,controlRegistration(root,ctx),()=>false);if(raw.existsSync(root))throw Error("gate_life_setup_cleanup_incomplete");}
    else throw Error("gate_life_setup_root_identity_changed");throw error;
  }
}

function prepareNativeVfs(ctx,{sourceFile,includeDirectory}={}){
  ctx=readContext(ctx.manifest);
  if(!["darwin","linux"].includes(process.platform))throw Error("gate_life_native_vfs_compiler_platform_unsupported");
  const compiler=process.platform==="darwin"?"/usr/bin/clang":"/usr/bin/cc";
  const directory=path.join(ctx.root,"native");raw.mkdirSync(directory,{mode:0o700});
  const source=path.join(directory,"gate-db-vfs.c"),library=path.join(directory,process.platform==="darwin"?"gate-db-vfs.dylib":"gate-db-vfs.so");
  const bytes=raw.readFileSync(sourceFile);durableFile(source,bytes);
  ctx.nativeVfs={binding:((file)=>({path:raw.realpathSync(file),sha256:sha(raw.readFileSync(file))}))(path.join(includeDirectory,"../../build/Release/better_sqlite3.node")),source,sourceSha256:sha(bytes),library,librarySha256:null,compiler,includeDirectory:raw.realpathSync(includeDirectory),state:"planned"};
  function save(){const temp=ctx.manifest+".update-"+crypto.randomUUID();durableFile(temp,JSON.stringify(ctx,null,2));raw.renameSync(temp,ctx.manifest);}
  save();
  const args=[process.platform==="darwin"?"-dynamiclib":"-shared","-std=c11","-Wall","-Wextra","-Werror","-fPIC","-I",ctx.nativeVfs.includeDirectory,source,"-o",library];
  const r=rawSpawn(compiler,args,{encoding:"utf8",timeout:30000,maxBuffer:1024*1024});
  if(r.status!==0){ctx.nativeVfs.state="failed";save();throw Error("gate_life_native_vfs_compile_failed:"+(r.error?.code??r.status));}
  ctx.nativeVfs.librarySha256=sha(raw.readFileSync(library));ctx.nativeVfs.state="ready";save();return ctx;
}
function eventWriter(ctx) {
  const file=path.join(ctx.root,"events",`${process.pid}-${crypto.randomUUID()}.jsonl`);
  raw.writeFileSync(file,"",{flag:"wx",mode:0o600});
  let serial=0;
  return value=>{const line={schema:SCHEMA,runId:ctx.runId,pid:process.pid,ppid:process.ppid,serial:++serial,at:new Date().toISOString(),...value};
    const fd=raw.openSync(file,"a");try{const bytes=Buffer.from(JSON.stringify(line)+"\n");let offset=0;while(offset<bytes.length){const wrote=raw.writeSync(fd,bytes,offset,bytes.length-offset);if(wrote<=0)throw Error("gate_life_metadata_write_incomplete");offset+=wrote;}raw.fsyncSync(fd);}finally{raw.closeSync(fd);}};
}
function readEvents(ctx) {
  return raw.readdirSync(path.join(ctx.root,"events")).flatMap(name=>{
    if(!/^\d+-[a-f0-9-]+\.jsonl$/.test(name))throw Error("gate_life_event_name_invalid");
    return raw.readFileSync(path.join(ctx.root,"events",name),"utf8").trim().split("\n").filter(Boolean).map(line=>{const event=JSON.parse(line);if(event.schema!==SCHEMA||event.runId!==ctx.runId)throw Error("gate_life_event_owner_changed");return event;});
  });
}
function install(file) {
  const ctx=readContext(file),key=Symbol.for(SCHEMA);
  if(global[key])return global[key];
  if(sha(raw.readFileSync(ctx.bootstrap))!==ctx.bootstrapSha256)throw Error("gate_life_bootstrap_changed");
  const record=eventWriter(ctx);record({type:"process-start",birth:processBirth(process.pid),threadId:require("node:worker_threads").threadId,entry:path.basename(process.argv[1]??""),argCount:process.argv.length,launchId:process.env.AGENTLAS_GATE_DB_LAUNCH_ID??null,argvSha256:sha(JSON.stringify(process.argv)),mode:{electron:process.versions.electron??null,runAsNode:process.env.ELECTRON_RUN_AS_NODE??null}});
  const knownRoots=readEvents(ctx).filter(e=>e.type==="root-created");
  const roots=()=>knownRoots;
  const fail=(code,details={})=>{record({type:"unsupported",code,...details});throw Error(code);};
  function assertOwned(filename) {
    const real=canonical(filename);
    for(const prod of productionRoots())if(within(real,prod))return fail("gate_life_production_path_refused",{path:real});
    let root=roots().find(e=>within(real,e.path));
    if(!root){for(const entry of readEvents(ctx).filter(e=>e.type==="root-created"))if(!knownRoots.some(r=>r.path===entry.path))knownRoots.push(entry);root=roots().find(e=>within(real,e.path));}
    if(!root)return fail("gate_life_unowned_data_path",{path:real});
    const info=raw.lstatSync(root.path);
    if(info.isSymbolicLink()||info.dev!==root.dev||info.ino!==root.ino||info.birthtimeMs!==root.birthtimeMs)return fail("gate_life_root_identity_changed",{path:root.path});
    const relative=path.relative(root.path,real);let entry=root.path;
    for(const part of relative.split(path.sep).filter(Boolean)){entry=path.join(entry,part);if(raw.existsSync(entry)&&raw.lstatSync(entry).isSymbolicLink())return fail("gate_life_symlink_refused",{path:entry});}
    if(raw.existsSync(real)&&raw.lstatSync(real).isFile()&&raw.lstatSync(real).nlink>1)return fail("gate_life_hardlink_refused",{path:real});
    return real;
  }
  function declareDb(filename,reason) {
    let name=Buffer.isBuffer(filename)?filename.toString():String(filename);
    if(memoryDb(name)){record({type:"memory-db",reason});return;}
    if(name.startsWith("file:")){
      const u=new URL(name);if(u.searchParams.get("mode")==="memory")return;
      if(u.host&&u.host!=="localhost")return fail("gate_life_remote_uri_refused");
      name=fileURLToPath(u);
    }
    const db=assertOwned(name);
    record({type:"db-declared",reason,path:db,paths:[db,...ctx.dbSidecars.map(s=>db+s)],existed:raw.existsSync(db)});return db;
  }
  function ownedMkdtemp(prefixValue,options) {
    const input=Buffer.isBuffer(prefixValue)?prefixValue.toString():prefixValue instanceof URL?fileURLToPath(prefixValue):prefixValue;
    if(typeof input!=="string")return raw.mkdtempSync(prefixValue,options);
    const parent=canonical(path.dirname(input)),temp=raw.realpathSync(os.tmpdir());
    if(!within(parent,temp))return fail("gate_life_temp_parent_refused",{path:parent});
    for(let tries=0;tries<32;tries++){
      const lexical=input+crypto.randomBytes(6).toString("base64url").replace(/[-_]/g,"a").slice(0,6),target=canonical(lexical);
      for(const prod of productionRoots())if(overlaps(target,prod))return fail("gate_life_production_overlap");
      record({type:"root-planned",path:target,lexical});
      try{raw.mkdirSync(target,{mode:0o700});}catch(e){if(e.code==="EEXIST")continue;throw e;}
      const stat=raw.lstatSync(target);const rootRecord={type:"root-created",path:target,lexical,dev:stat.dev,ino:stat.ino,birthtimeMs:stat.birthtimeMs};record(rootRecord);knownRoots.push(rootRecord);
      const encoding=typeof options==="string"?options:options?.encoding;
      return encoding==="buffer"?Buffer.from(lexical):lexical;
    }return fail("gate_life_temp_collision_limit");
  }
  fs.mkdtempSync=ownedMkdtemp;
  fs.mkdtemp=(value,options,callback)=>{if(typeof options==="function"){callback=options;options=undefined;}try{const result=ownedMkdtemp(value,options);process.nextTick(callback,null,result);}catch(e){process.nextTick(callback,e);}};
  fs.promises.mkdtemp=async(value,options)=>ownedMkdtemp(value,options);
  const dbLike=name=>/\.(?:sqlite|sqlite3|db)(?:$|[.\-])|(?:-wal|-shm|-journal)$/.test(String(name));
  // Name-based only: unregistered files are never opened to guess whether they are a database.
  const inspectBeforeRemove=target=>{
    if(typeof target!=="string"&&!Buffer.isBuffer(target)&&!(target instanceof URL))return;
    const real=canonical(target);if(!raw.existsSync(real))return;
    if(overlaps(real,ctx.root))return fail("gate_life_control_delete_refused",{path:real});
    for(const prod of productionRoots())if(overlaps(real,prod))return fail("gate_life_production_delete_refused",{path:real});
    const temp=raw.realpathSync(os.tmpdir());if(within(real,temp)&&!roots().some(root=>within(real,root.path))&&!within(real,ctx.root))return fail("gate_life_foreign_temp_delete_refused",{path:real});
    if(!roots().some(root=>within(real,root.path)))return;
    const events=readEvents(ctx),declared=new Set(events.filter(e=>["db-declared","file-declared"].includes(e.type)).flatMap(e=>e.paths));
    function inspect(file){const stat=raw.lstatSync(file);if(stat.isSymbolicLink())return;if(stat.isDirectory()){for(const name of raw.readdirSync(file))inspect(path.join(file,name));}else if(dbLike(file)&&!declared.has(file))fail("gate_life_unmeasured_sqlite_before_delete",{path:file});}
    inspect(real);record({type:"owned-delete",path:real});
  };
  for(const name of ["rmSync","rmdirSync","unlinkSync"]){const original=fs[name];if(!original)continue;fs[name]=function(value,...args){inspectBeforeRemove(value);return Reflect.apply(original,this,[value,...args]);};}
  for(const name of ["rm","rmdir","unlink"]){const original=fs[name];if(!original)continue;fs[name]=function(value,...args){inspectBeforeRemove(value);return Reflect.apply(original,this,[value,...args]);};}
  for(const name of ["rm","rmdir","unlink"]){const original=fs.promises[name]?.bind(fs.promises);if(original)fs.promises[name]=async(value,...args)=>{inspectBeforeRemove(value);return original(value,...args);};}
  function beforeCopy(source,destination){const src=canonical(source);for(const prod of productionRoots())if(within(src,prod))return fail("gate_life_production_copy_refused",{path:src});declareFile(destination,"filesystem exact copy");
    if(dbLike(src)&&!roots().some(root=>within(src,root.path)))return fail("gate_life_external_database_source_unapproved",{path:src});
    if(dbLike(src)||dbLike(destination))declareDb(destination,"filesystem database copy");}
  for(const name of ["copyFileSync","copyFile"]){const original=fs[name];fs[name]=function(source,destination,...args){beforeCopy(source,destination);return Reflect.apply(original,this,[source,destination,...args]);};}
  const copyPromise=fs.promises.copyFile.bind(fs.promises);fs.promises.copyFile=async(source,destination,...args)=>{beforeCopy(source,destination);return copyPromise(source,destination,...args);};
  // A Node filesystem sink can create an extensionless database or a renamed
  // snapshot. Record every writable file (and possible SQLite sidecars) before
  // creation, without inspecting or retaining the data being written.
  function declareFile(file,reason){
    if(typeof file==="number")return;
    const absolute=assertOwned(file);
    record({type:"file-declared",reason,path:absolute,paths:[absolute,...ctx.dbSidecars.map(s=>absolute+s)]});
  }
  for(const name of ["writeFileSync","appendFileSync","writeFile","appendFile"]){const original=fs[name];fs[name]=function(file,...args){declareFile(file,"filesystem file write");return Reflect.apply(original,this,[file,...args]);};}
  for(const name of ["writeFile","appendFile"]){const original=fs.promises[name].bind(fs.promises);fs.promises[name]=async(file,...args)=>{declareFile(file,"filesystem promised write");return original(file,...args);};}
  const writing=flags=>typeof flags==="number"?(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))!==0:/[wa+]/.test(String(flags??"r"));
  for(const name of ["openSync","open"]){const original=fs[name];fs[name]=function(file,flags,...args){if(writing(flags))declareFile(file,"filesystem writable open");return Reflect.apply(original,this,[file,flags,...args]);};}
  const openPromise=fs.promises.open.bind(fs.promises);fs.promises.open=async(file,flags,...args)=>{if(writing(flags))declareFile(file,"filesystem promised open");return openPromise(file,flags,...args);};
  const createStream=fs.createWriteStream;fs.createWriteStream=function(file,...args){declareFile(file,"filesystem write stream");return Reflect.apply(createStream,this,[file,...args]);};
  for(const name of ["renameSync","rename"]){const original=fs[name];fs[name]=function(source,destination,...args){assertOwned(source);declareFile(destination,"filesystem atomic rename");return Reflect.apply(original,this,[source,destination,...args]);};}
  const renamePromise=fs.promises.rename.bind(fs.promises);fs.promises.rename=async(source,destination,...args)=>{assertOwned(source);declareFile(destination,"filesystem promised rename");return renamePromise(source,destination,...args);};
  function declareCopyTree(source,destination){const stat=raw.lstatSync(source);if(stat.isSymbolicLink())return fail("gate_life_recursive_copy_symlink_unmeasured");if(stat.isDirectory()){assertOwned(destination);for(const name of raw.readdirSync(source))declareCopyTree(path.join(source,name),path.join(destination,name));}else{declareFile(destination,"filesystem tree copy");beforeCopy(source,destination);}}
  for(const name of ["cpSync","cp"]){const original=fs[name];if(original)fs[name]=function(source,destination,...args){declareCopyTree(source,destination);return Reflect.apply(original,this,[source,destination,...args]);};}
  const cpPromise=fs.promises.cp?.bind(fs.promises);if(cpPromise)fs.promises.cp=async(source,destination,...args)=>{declareCopyTree(source,destination);return cpPromise(source,destination,...args);};
  for(const name of ["symlinkSync","symlink"]){const original=fs[name];fs[name]=function(target,file,...args){const absolute=assertOwned(file);record({type:"symlink-declared",path:absolute,targetSha256:sha(String(target))});return Reflect.apply(original,this,[target,file,...args]);};}
  const symlinkPromise=fs.promises.symlink.bind(fs.promises);fs.promises.symlink=async(target,file,...args)=>{const absolute=assertOwned(file);record({type:"symlink-declared",path:absolute,targetSha256:sha(String(target))});return symlinkPromise(target,file,...args);};
  const driverCache=new WeakMap(),nativePrimers=new Map();let nativeBindingDepth=0;
  function initializeNativeVfs(target,kind){
    if(nativePrimers.has(target))return;
    if(kind!=="better-sqlite3")return fail("gate_life_sqlite_driver_observer_unsupported",{driver:kind});
    if(ctx.nativeVfs?.state!=="ready"||!within(ctx.nativeVfs.library,ctx.root)||sha(raw.readFileSync(ctx.nativeVfs.library))!==ctx.nativeVfs.librarySha256)return fail("gate_life_native_vfs_missing_or_changed");
    let primer;
    try{
      const eventFile=path.join(ctx.root,"events",`${process.pid}-${ctx.runId}.jsonl`);
      try{durableFile(eventFile,"");}catch(error){if(error.code!=="EEXIST")throw error;const stat=raw.lstatSync(eventFile);if(stat.isSymbolicLink()||!stat.isFile())throw Error("gate_life_native_event_file_changed");}
      const line=JSON.stringify({schema:SCHEMA,runId:ctx.runId,pid:process.pid,ppid:process.ppid,serial:0,at:null,type:"unsupported",code:"gate_life_native_sqlite_observation_denied"})+"\n";
      nativeBindingDepth++;try{primer=Reflect.construct(target,[":memory:"]);}finally{nativeBindingDepth--;}
      primer.function("agentlas_gate_file",(file,operation)=>{if(file===null)return fail("gate_life_anonymous_sqlite_file_refused",{operation});declareDb(file,"SQLite VFS "+operation);return 1;});
      primer.function("agentlas_gate_native_config",key=>key==="file"?eventFile:key==="library"?ctx.nativeVfs.library:line);
      primer.loadExtension(ctx.nativeVfs.library);
      const statement=primer.prepare("SELECT agentlas_gate_vfs_denials() AS count");statement.get();
      nativePrimers.set(target,{primer,statement});record({type:"native-vfs-ready",librarySha256:ctx.nativeVfs.librarySha256,threadId:require("node:worker_threads").threadId});
    }catch(error){return fail("gate_life_native_vfs_install_failed",{reason:error?.code??error?.message??"unknown"});}
  }

  function wrapDriver(driver,kind="better-sqlite3"){if(driverCache.has(driver))return driverCache.get(driver);const proxy=new Proxy(driver,{construct(target,args,newTarget){if(args[1]?.nativeBinding)return fail("gate_life_custom_sqlite_binding_unmeasured");initializeNativeVfs(target,kind);const dbPath=declareDb(args[0]??":memory:","SQLite constructor");const db=Reflect.construct(target,args,newTarget===proxy?target:newTarget);record({type:"db-handle-open",path:dbPath});return db;},apply(target,thisArg,args){if(args[1]?.nativeBinding)return fail("gate_life_custom_sqlite_binding_unmeasured");initializeNativeVfs(target,kind);const dbPath=declareDb(args[0]??":memory:","SQLite constructor");const db=Reflect.apply(target,thisArg,args);record({type:"db-handle-open",path:dbPath});return db;}});const descriptor=Object.getOwnPropertyDescriptor(driver.prototype,"constructor");if(descriptor?.value===driver&&descriptor.writable)Object.defineProperty(driver.prototype,"constructor",{...descriptor,value:proxy});driverCache.set(driver,proxy);return proxy;}
  const nativeProfiles=new Set();
  function declareNativeProfile(directory){const profile=assertOwned(directory);if(nativeProfiles.has(profile))return;const declarations=new Set(readEvents(ctx).filter(e=>e.type==="db-declared").flatMap(e=>e.paths));
    for(const relative of nativeDatabaseNames()){const file=path.join(profile,relative);if(raw.existsSync(file)&&!declarations.has(file))return fail("gate_life_native_profile_declared_late",{path:file});declareDb(file,"native profile planned database");}
    nativeProfiles.add(profile);record({type:"native-profile",path:profile});
  }
  const electronCache=new WeakMap();
  function instrumentElectron(value){if(!process.versions.electron||process.env.ELECTRON_RUN_AS_NODE==="1"||!value||typeof value!=="object")return value;if(electronCache.has(value))return electronCache.get(value);
    const sessions=new WeakMap();const app=value.app;if(app?.setPath&&!app[Symbol.for("agentlas.gate.life.app")]){const setPath=app.setPath;app.setPath=function(name,directory){if(name==="userData"||name==="sessionData")declareNativeProfile(directory);return Reflect.apply(setPath,app,[name,directory]);};Object.defineProperty(app,Symbol.for("agentlas.gate.life.app"),{value:true});}
    const proxy=new Proxy(value,{get(target,key){const entry=Reflect.get(target,key,target);if(key!=="session"||!entry)return entry;if(sessions.has(entry))return sessions.get(entry);const methods=new Map();const sessionProxy=new Proxy(entry,{get(target,key){const item=Reflect.get(target,key,target);if(key==="defaultSession"&&item?.storagePath)declareNativeProfile(item.storagePath);if(key==="fromPartition"&&typeof item==="function"){if(!methods.has(key))methods.set(key,(...args)=>{const session=Reflect.apply(item,target,args);if(session.storagePath)declareNativeProfile(session.storagePath);return session;});return methods.get(key);}return item;}});sessions.set(entry,sessionProxy);return sessionProxy;}});electronCache.set(value,proxy);return proxy;
  }
  const originalDlopen=process.dlopen;
  process.dlopen=function(module,file,...args){const target=canonical(file),allowed=ctx.nativeVfs?.binding;
    if(!allowed||allowed.path!==target||sha(raw.readFileSync(target))!==allowed.sha256||nativeBindingDepth===0)return fail("gate_life_native_addon_contract_missing",{path:target});
    record({type:"native-addon-admitted",path:target,sha256:allowed.sha256});return Reflect.apply(originalDlopen,this,[module,file,...args]);
  };
  const originalBinding=process.binding;
  process.binding=function(name,...args){if(name==="fs")return fail("gate_life_direct_native_fs_binding_refused");return Reflect.apply(originalBinding,this,[name,...args]);};
  const builtinSqlite=name=>name==="node:sqlite"||name==="sqlite";
  if(typeof process.getBuiltinModule==="function"){const getBuiltin=process.getBuiltinModule;process.getBuiltinModule=function(name,...args){if(builtinSqlite(name))return fail("gate_life_sqlite_driver_observer_unsupported",{driver:String(name)});return Reflect.apply(getBuiltin,this,[name,...args]);};}
  if(typeof Module.registerHooks==="function")Module.registerHooks({resolve(specifier,context,next){if(builtinSqlite(specifier))return fail("gate_life_sqlite_driver_observer_unsupported",{driver:"node:sqlite"});return next(specifier,context);}});
  else if(Number(process.versions.node.split(".")[0])>=22)return fail("gate_life_builtin_sqlite_esm_admission_unavailable");
  const originalLoad=Module._load;
  Module._load=function(request,parent,...args){if(builtinSqlite(request))return fail("gate_life_sqlite_driver_observer_unsupported",{driver:request});const result=Reflect.apply(originalLoad,this,[request,parent,...args]);
    if(typeof result==="function"&&(request==="better-sqlite3"||/[\\/]better-sqlite3(?:[\\/]|$)/.test(request)))return wrapDriver(result);
    if(request==="electron"||/[\\/]electron$/.test(request))return instrumentElectron(result);
    return result;
  };
  // Preserve minimal envs and all execution-mode values. The lifecycle and the
  // existing INDEX preload are additive, even when a runner replaces options.
  function executableFile(command,options){
    const env=options?.env??process.env;
    const candidates=String(command).includes(path.sep)?[path.resolve(options?.cwd??process.cwd(),String(command))]:String(env.PATH??"").split(path.delimiter).filter(Boolean).map(base=>path.join(base,String(command)));
    for(const file of candidates){try{const stat=raw.statSync(file);if(stat.isFile())return raw.realpathSync(file);}catch{}}
    return null;
  }
  function childContract(command,args,options,method){
    if(["exec","execSync"].includes(method)||options?.shell)return fail("gate_life_shell_child_contract_missing",{command:path.basename(String(command))});
    const executable=method==="fork"?raw.realpathSync(options?.execPath??process.execPath):executableFile(command,options);
    if(!executable)return {kind:"unresolved-no-executable"}; // Original ENOENT is preserved; nothing executes.
    const base=path.basename(executable).toLowerCase();
    const approved=ctx.nodeExecutables.find(entry=>entry.path===executable);
    if(approved&&sha(raw.readFileSync(executable))!==approved.sha256)return fail("gate_life_node_executable_changed",{executable});
    if(approved&&(base==="electron"||base==="electron.exe")){
      if(options.env.ELECTRON_RUN_AS_NODE==="1")return {kind:"instrumented-node",executable};
      if(!ctx.nativeFixture)return fail("gate_life_native_gui_contract_missing",{command:base});
      const equal=args.find(arg=>typeof arg==="string"&&arg.startsWith("--user-data-dir="));const split=args.indexOf("--user-data-dir");
      const profile=equal?.slice("--user-data-dir=".length)??(split>=0?args[split+1]:null);
      if(typeof profile!=="string")return fail("gate_life_native_profile_not_predeclared",{command:base});
      declareNativeProfile(profile);return {kind:"explicit-native-fixture",executable};
    }
    if(approved)return {kind:"instrumented-node",executable};
    // Node launchers inherit exactly the additive preload. A shell/Python/native
    // launcher is not assumed safe merely because it eventually launches Node.
    {const fd=raw.openSync(executable,"r"),bytes=Buffer.alloc(256);let n;try{n=raw.readSync(fd,bytes,0,bytes.length,0);}finally{raw.closeSync(fd);}
      if(/^#![^\n]*(?:\/|\s)node(?:\s|$)/.test(bytes.subarray(0,n).toString().split("\n")[0]))return {kind:"instrumented-node",executable};}
    const passive=new Set(["/bin/ps","/usr/bin/ps","/usr/sbin/lsof","/usr/bin/lsof","/bin/sleep","/usr/bin/uname","/usr/bin/which","/bin/kill"]);
    if(passive.has(executable))return {kind:"native-read-or-process",executable};
    const approvedGit=ctx.gitExecutables.find(entry=>entry.path===executable);
    if(approvedGit){
      if(sha(raw.readFileSync(executable))!==approvedGit.sha256)return fail("gate_life_git_executable_changed",{executable});
      let n=0;while(["-C","--git-dir","--work-tree"].includes(args[n])){n+=2;}const verb=args[n],rest=args.slice(n+1);
      const hazardous=rest.some(arg=>/^(?:--(?:output|remote|exec-path|upload-pack|receive-pack|filters|textconv|ext-diff))(?:=|$)/.test(String(arg)));
      let safe=["cat-file","ls-tree","rev-parse","ls-files","write-tree"].includes(verb);
      if(verb==="config")safe=["--get","--get-regexp","--get-all"].includes(rest[0])||rest.length===1&&/^[A-Za-z][A-Za-z0-9_.-]*$/.test(rest[0]);
      if(verb==="show")safe=rest.some(arg=>/^[A-Za-z0-9._~^/\-]+:.+/.test(String(arg)))||rest.includes("--no-patch")||rest.includes("--name-only");
      if(verb==="diff"||verb==="diff-tree")safe=rest.some(arg=>["--name-only","--name-status","--raw"].includes(arg))||rest.includes("--no-ext-diff")&&rest.includes("--no-textconv");
      if(verb==="hash-object")safe=rest.includes("--no-filters")||!rest.some(arg=>String(arg).startsWith("--path"));
      if(verb==="archive")safe=rest.length===2&&rest[0]==="--format=tar"&&/^[a-f0-9]{40}$/.test(rest[1]);
      if(safe&&!hazardous)return {kind:"native-git-metadata",executable};

    }
    if(executable==="/bin/cp"){
      const operands=args.filter(arg=>!String(arg).startsWith("-"));
      if(operands.length!==2||args.some(arg=>/^-.*[Rr]/.test(String(arg))))return fail("gate_life_native_copy_contract_missing");
      beforeCopy(operands[0],operands[1]);return {kind:"native-exact-copy",executable};
    }
    return fail("gate_life_native_child_contract_missing",{command:path.basename(executable),executable,argvSha256:sha(JSON.stringify(args)),argumentCount:args.length});
  }
  function childOptions(options){
    const env={...(options?.env??process.env)},flag=`--require=${ctx.bootstrap}`,current=env.NODE_OPTIONS??"";
    env.NODE_OPTIONS=current.includes(ctx.bootstrap)?current:`${flag}${current?" ":""}${current}`;env[ENV]=ctx.manifest;env.AGENTLAS_GATE_DB_LAUNCH_ID=crypto.randomUUID();
    return {...(options??{}),env};
  }
  function childResult(command,args,options,result){
    if(result&&typeof result.pid==="number"){
      record({type:"child-start",childPid:result.pid,childBirth:processBirth(result.pid),command:path.basename(String(command)),commandSha256:sha(JSON.stringify([command,args])),mode:options?.env?.ELECTRON_RUN_AS_NODE??null});
      if(typeof result.once==="function")result.once("exit",(code,signal)=>{try{record({type:"child-exit",childPid:result.pid,code,signal});}catch{}});
      else record({type:"child-exit",childPid:result.pid,code:result.status,signal:result.signal});
    }return result;
  }
  for(const method of ["spawn","spawnSync","execFile","execFileSync","fork"]){const original=cp[method];cp[method]=function(command,...supplied){
    // Preserve Node's omitted-args, callback and fork overloads; only the options
    // object is copied. argv, executable, execution mode and callbacks are exact.
    let args=Array.isArray(supplied[0])?supplied.shift():[];
    const hasOptions=supplied[0]&&typeof supplied[0]==="object";
    const options=childOptions(hasOptions?supplied.shift():undefined);
    const contract=childContract(command,args,options,method);
    record({type:"child-intent",launchId:options.env.AGENTLAS_GATE_DB_LAUNCH_ID,method,kind:contract.kind,executable:contract.executable??null,argvSha256:sha(JSON.stringify(args))});
    const result=Reflect.apply(original,this,[command,args,options,...supplied]);
    return childResult(command,args,options,result);
  };}
  for(const method of ["exec","execSync"]){const original=cp[method];cp[method]=function(command,...supplied){
    const hasOptions=supplied[0]&&typeof supplied[0]==="object";const options=childOptions(hasOptions?supplied.shift():undefined);
    childContract(command,[],options,method);
    return childResult("shell",[sha(String(command))],options,Reflect.apply(original,this,[command,options,...supplied]));
  };}
  const threads=require("node:worker_threads"),OriginalWorker=threads.Worker;
  threads.Worker=new Proxy(OriginalWorker,{construct(target,args,newTarget){let [entry,options={}]=args;
    const execArgv=[...(options.execArgv??process.execArgv)];if(!execArgv.some(value=>String(value).includes(ctx.bootstrap)))execArgv.push("--require",ctx.bootstrap);
    let workerEnv=options.env;if(workerEnv!==threads.SHARE_ENV)workerEnv=childOptions({env:workerEnv??process.env}).env;
    const worker=Reflect.construct(target,[entry,{...options,execArgv,env:workerEnv}],newTarget===threads.Worker?target:newTarget);
    const threadId=worker.threadId;record({type:"worker-intent",threadId});worker.once("exit",code=>{try{record({type:"worker-exit",threadId,code});}catch{}});return worker;
  }});
  Module.syncBuiltinESMExports();
  process.once("exit",code=>{try{for(const {statement} of nativePrimers.values())if(statement.get().count!==0)record({type:"unsupported",code:"gate_life_native_vfs_denial_sticky"});record({type:"process-exit",code});}catch{}});
  const api={ctx,record,declareDb,declareNativeProfile};global[key]=api;
  if(ctx.repoRoot&&process.argv.includes("--staged")&&path.resolve(process.argv[1]??"")===path.join(ctx.repoRoot,"scripts/run-bound-gates.mjs")){
    const exit=process.exit.bind(process);let finalized=false;
    process.exit=function(code=process.exitCode??0){const originalCode=Number(code);if(finalized)return exit(originalCode);finalized=true;
      let lifecycleCode=1;try{const report=auditAndCleanup(ctx,{keepControl:true});lifecycleCode=report.complete?0:1;record({type:"normal-gate-finalized",originalCode,lifecycleCode,cleanupComplete:report.dataCleanupComplete});if(lifecycleCode)console.error(`gate lifecycle rejected completion: ${report.errors.map(e=>e.code).join(",")}`);}catch(error){try{record({type:"unsupported",code:"gate_life_finalization_failed",reason:String(error?.message??error)});}catch{}console.error("gate lifecycle finalization failed");}
      return exit(originalCode!==0?originalCode:lifecycleCode);
    };
  }
  return api;
}
function nativeDatabaseNames(){const names=["Cookies","Trust Tokens","Reporting and NEL","Network Action Predictor","QuotaManager","DIPS","History","Web Data","Login Data","Favicons","MediaDeviceSalts","SharedStorage","BrowsingTopicsSiteData","OriginTrials","BudgetDatabase","HeavyAdInterventionOptOut.db"];return [...new Set([... ["","Default","Network","Default/Network","WebStorage"].flatMap(prefix=>names.map(name=>prefix?path.join(prefix,name):name)),"Shared Dictionary/db"])];}
function ownerIsAliveOrUnknown(ctx){
  try{process.kill(ctx.pid,0);}catch(error){if(error.code==="ESRCH")return false;return true;}
  const birth=processBirth(ctx.pid);return !birth||!ctx.birth||birth===ctx.birth;
}
function recoverSession(file,ownerId,{evidenceDir}={}){const ctx=readContext(file);if(!ownerId||ctx.ownerId!==ownerId)throw Error("gate_life_recovery_owner_mismatch");if(ownerIsAliveOrUnknown(ctx))throw Error("gate_life_recovery_owner_alive_or_unknown");return auditAndCleanup(ctx,{evidenceDir,recoveryOwnerId:ownerId});}
function recoverOwnedSessions(evidenceDir,ownerId){
  const directory=path.join(path.resolve(evidenceDir),"active");if(!raw.existsSync(directory))return [];
  if(raw.lstatSync(directory).isSymbolicLink()||raw.realpathSync(directory)!==directory)throw Error("gate_life_registry_symlink_refused");
  const results=[];
  for(const name of raw.readdirSync(directory)){
    if(!/^[a-f0-9-]{36}\.json$/.test(name)){
      if(/^[a-f0-9-]{36}\.json\.(?:closed|data)-[a-f0-9-]{36}$/.test(name))continue; // Retain interrupted metadata; never treat it as authority.
      throw Error("gate_life_registry_entry_unknown");
    }
    const file=path.join(directory,name),stat=raw.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error("gate_life_registry_entry_invalid");
    const entry=JSON.parse(raw.readFileSync(file,"utf8"));if(entry.schema!==SCHEMA||entry.ownerId!==ownerId||!["active","data-cleaned"].includes(entry.state))continue;
    if(entry.state==="data-cleaned"&&!raw.existsSync(entry.controlRoot)){
      if(ownerIsAliveOrUnknown(entry)||(entry.dataRoots??[]).some(root=>raw.existsSync(root))||(entry.databasePaths??[]).some(file=>raw.existsSync(file)))throw Error("gate_life_interrupted_cleanup_unconfirmed");
      const temp=file+".closed-"+crypto.randomUUID();durableFile(temp,JSON.stringify({...entry,state:"cleaned",closedAt:new Date().toISOString(),controlRootAbsent:true}));raw.renameSync(temp,file);results.push({complete:true,runId:entry.runId,interruptedControlCleanupRecovered:true,controlRootAbsent:true});continue;
    }
    const ctx=readContext(entry.manifest);if(ctx.runId!==entry.runId||ctx.ownerId!==ownerId||ctx.registryFile!==file||ctx.pid!==entry.pid||ctx.birth!==entry.birth)throw Error("gate_life_registry_owner_changed");
    const result=recoverSession(entry.manifest,ownerId,{evidenceDir});results.push(result);if(!result.complete)throw Error("gate_life_previous_owned_cleanup_incomplete");
  }return results;
}
async function stopOwnedProcesses(ctxOrFile){
  const ctx=readContext(typeof ctxOrFile==="string"?ctxOrFile:ctxOrFile.manifest);if(ctx.pid!==process.pid)throw Error("gate_life_stop_requires_issuing_coordinator");
  const events=readEvents(ctx),actors=new Map();for(const event of events){if(event.type==="process-start")actors.set(event.pid,event.birth);if(event.type==="child-start"&&(!actors.has(event.childPid)||event.childBirth))actors.set(event.childPid,event.childBirth);}
  actors.delete(process.pid);const stopped=[],unknown=[];
  function state(pid,birth){try{process.kill(pid,0);}catch(error){if(error.code==="ESRCH")return "gone";return "unknown";}const current=processBirth(pid);if(!birth||!current)return "unknown";return current===birth?"owned":"reused";}
  for(const [pid,birth] of actors){const before=state(pid,birth);if(before==="owned"){process.kill(pid,"SIGTERM");stopped.push({pid,birth});}else if(before==="unknown")unknown.push(pid);}
  for(let round=0;round<100;round++){
    const active=stopped.filter(actor=>state(actor.pid,actor.birth)==="owned");if(!active.length)break;
    if(round===30)for(const actor of active)if(state(actor.pid,actor.birth)==="owned")try{process.kill(actor.pid,"SIGKILL");}catch{}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const remaining=stopped.filter(actor=>state(actor.pid,actor.birth)==="owned"||state(actor.pid,actor.birth)==="unknown").map(actor=>actor.pid);
  return {complete:unknown.length===0&&remaining.length===0,stopped:stopped.map(actor=>actor.pid),unknown,remaining};
}

function lsofState(directory) {
  if(process.platform==="win32")return {state:"unsupported",reason:"Windows native handle enumeration not implemented"};
  const r=rawSpawn("lsof",["-F","p","+D",directory],{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:20000});
  const pids=[...new Set((r.stdout??"").split("\n").filter(x=>/^p\d+$/.test(x)).map(x=>Number(x.slice(1))))];
  if(pids.length)return{state:"in-use",pids};
  return r.status===1&&!r.error&&!r.stderr.trim()?{state:"free"}:{state:"unknown",reason:r.error?.code??`lsof:${r.status}`};
}
function auditAndCleanup(ctxOrFile,{evidenceDir,keepControl=false,recoveryOwnerId=null}={}) {
  const ctx=readContext(typeof ctxOrFile==="string"?ctxOrFile:ctxOrFile.manifest),events=readEvents(ctx),errors=events.filter(e=>e.type==="unsupported").map(e=>({code:e.code,path:e.path??null}));
  const isMaster=keepControl&&ctx.repoRoot&&process.argv.includes("--staged")&&path.resolve(process.argv[1]??"")===path.join(ctx.repoRoot,"scripts/run-bound-gates.mjs")&&events.some(e=>e.type==="process-start"&&e.pid===process.pid&&e.birth===processBirth(process.pid));
  if(ctx.pid!==process.pid&&!isMaster&&(recoveryOwnerId!==ctx.ownerId||ownerIsAliveOrUnknown(ctx)))throw Error("gate_life_cleanup_requires_exact_owner");
  const roots=events.filter(e=>e.type==="root-created"),dbs=events.filter(e=>e.type==="db-declared"),files=events.filter(e=>e.type==="file-declared"),declared=new Set([...dbs,...files].flatMap(e=>e.paths));
  const leftovers=[];
  const childStarts=new Set(events.filter(e=>e.type==="process-start"&&e.launchId).map(e=>e.launchId));
  for(const intent of events.filter(e=>e.type==="child-intent"&&e.kind==="instrumented-node"))if(!childStarts.has(intent.launchId))errors.push({code:"gate_life_node_child_preload_unproven",launchId:intent.launchId,executable:intent.executable});
  for(const worker of events.filter(e=>e.type==="worker-intent")){
    const actorAlive=(()=>{try{process.kill(worker.pid,0);return true;}catch(e){return e.code!=="ESRCH";}})();
    if(actorAlive&&!events.some(e=>e.type==="worker-exit"&&e.pid===worker.pid&&e.threadId===worker.threadId))errors.push({code:"gate_life_worker_exit_unproven",pid:worker.pid,threadId:worker.threadId});
    if(!events.some(e=>e.type==="process-start"&&e.pid===worker.pid&&e.threadId===worker.threadId))errors.push({code:"gate_life_worker_preload_unproven",pid:worker.pid,threadId:worker.threadId});
  }
  const pendingNative=events.filter(e=>e.type==="child-start"&&!events.some(done=>done.type==="child-exit"&&done.pid===e.pid&&done.childPid===e.childPid)).filter(e=>{
    try{process.kill(e.childPid,0);}catch(error){return error.code!=="ESRCH";}
    const birth=processBirth(e.childPid);return !birth||!e.childBirth||birth===e.childBirth;
  });
  if(pendingNative.length)errors.push({code:"gate_life_cleanup_child_exit_unproven",pids:pendingNative.map(e=>e.childPid)});
  const active=events.filter(e=>e.type==="process-start"&&e.pid!==process.pid).filter(e=>{
    try{process.kill(e.pid,0);}catch(error){return error.code!=="ESRCH";}
    const birth=processBirth(e.pid);return !birth||!e.birth||birth===e.birth;
  });
  if(active.length||pendingNative.length){errors.push({code:"gate_life_cleanup_processes_still_active",pids:[...new Set([...active.map(e=>e.pid),...pendingNative.map(e=>e.childPid)])]});leftovers.push(...roots.filter(root=>raw.existsSync(root.path)).map(root=>root.path));}

  const symlinkEvents=events.filter(e=>e.type==="symlink-declared");
  const keptEntries=[];
  for(const root of roots){if(active.length||pendingNative.length||!raw.existsSync(root.path))continue;const s=raw.lstatSync(root.path);if(s.isSymbolicLink()||s.dev!==root.dev||s.ino!==root.ino||s.birthtimeMs!==root.birthtimeMs){errors.push({code:"gate_life_cleanup_root_identity_changed",path:root.path});leftovers.push(root.path);continue;}
    const handles=lsofState(root.path);if(handles.state!=="free"){errors.push({code:"gate_life_cleanup_handles_unproven",path:root.path,handles});leftovers.push(root.path);continue;}
    // Only manifest-registered paths are removed; unregistered content is neither read nor deleted.
    const outcome=removeRegisteredTree(root.path,file=>declared.has(file),link=>{const entry=symlinkEvents.find(e=>e.path===link);return Boolean(entry)&&entry.targetSha256===sha(fs.readlinkSync(link));});
    for(const item of [...outcome.kept,...outcome.failed]){errors.push({code:item.reason,path:item.path,...(item.code?{detail:item.code}:{})});leftovers.push(item.path);keptEntries.push({path:item.path,reason:item.reason});}
    if(!outcome.absent&&!outcome.kept.length&&!outcome.failed.length){errors.push({code:"gate_life_cleanup_failed",path:root.path});leftovers.push(root.path);}
    else if(!outcome.absent&&!leftovers.includes(root.path)){leftovers.push(root.path);}
  }
  for(const file of declared)if(raw.existsSync(file))leftovers.push(file);
  const report={schema:SCHEMA,runId:ctx.runId,root:ctx.root,keptEntries,roots:roots.map(e=>e.path),files:files.map(e=>({path:e.path,paths:e.paths,reason:e.reason,pid:e.pid})),databases:dbs.map(e=>({path:e.path,paths:e.paths,reason:e.reason,pid:e.pid})),events,errors,leftovers,complete:errors.length===0&&leftovers.length===0,originalGateStatuses:events.filter(e=>e.type==="process-exit").map(e=>({pid:e.pid,code:e.code})),environmentPolicy:"HOME/TMPDIR/ELECTRON_RUN_AS_NODE unchanged"};
  const evidence=evidenceDir??ctx.evidenceDir;if(evidence){raw.mkdirSync(evidence,{recursive:true});raw.writeFileSync(path.join(evidence,`${ctx.runId}.json`),JSON.stringify(report,null,2));}
  report.dataCleanupComplete=leftovers.length===0;
  if(leftovers.length===0&&!keepControl&&ctx.registryFile){const entry=JSON.parse(raw.readFileSync(ctx.registryFile,"utf8"));if(entry.schema!==SCHEMA||entry.runId!==ctx.runId||entry.ownerId!==ctx.ownerId||entry.manifest!==ctx.manifest)throw Error("gate_life_registry_owner_changed");const temp=ctx.registryFile+".data-"+crypto.randomUUID();durableFile(temp,JSON.stringify({...entry,state:"data-cleaned",controlRoot:ctx.root,rootIdentity:ctx.rootIdentity,dataRoots:roots.map(root=>root.path),databasePaths:[...declared]}));raw.renameSync(temp,ctx.registryFile);}
  if(leftovers.length===0&&!keepControl){const control=removeRegisteredTree(ctx.root,controlRegistration(ctx.root,ctx),()=>false);for(const item of [...control.kept,...control.failed]){const code=item.reason==="gate_life_cleanup_failed"?item.reason:"gate_life_control_entry_kept";report.errors.push({code,path:item.path});report.keptEntries.push({path:item.path,reason:code});}report.controlRootAbsent=!raw.existsSync(ctx.root);}else report.controlRootAbsent=false;
  report.controlCleanupPending=keepControl;
  if(!report.controlRootAbsent&&!keepControl)report.complete=false;
  if(ctx.registryFile&&report.controlRootAbsent){const entry=JSON.parse(raw.readFileSync(ctx.registryFile,"utf8"));if(entry.schema!==SCHEMA||entry.runId!==ctx.runId||entry.ownerId!==ctx.ownerId||entry.manifest!==ctx.manifest)throw Error("gate_life_registry_owner_changed");const temp=ctx.registryFile+".closed-"+crypto.randomUUID();durableFile(temp,JSON.stringify({...entry,state:report.complete?"cleaned":"cleaned-with-test-failures",closedAt:new Date().toISOString(),dbAndSidecarsAbsent:true}));raw.renameSync(temp,ctx.registryFile);}
  if(evidence)raw.writeFileSync(path.join(evidence,`${ctx.runId}.json`),JSON.stringify(report,null,2));
  return report;
}
module.exports={createSession,prepareNativeVfs,recoverOwnedSessions,stopOwnedProcesses,install,auditAndCleanup,recoverSession,readContext,SCHEMA,ENV};
if(process.env[ENV])install(process.env[ENV]);
