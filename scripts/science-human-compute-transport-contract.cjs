#!/usr/bin/env node
'use strict';
// Actual registered source handlers, extracted actual Main gate, actual local
// socket client and daemon dispatch. Runtime/effect ports are inert fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('absolute private output directory required');
fs.mkdirSync(output, { recursive: true });
const ts = require(require.resolve('typescript', { paths: [repo] }));
let checks = 0, starts = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sources = new Map();
function compiled(file, requires = {}, globals = {}) {
  const source = fs.readFileSync(file, 'utf8'); sources.set(file, digest(file));
  const built = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, reportDiagnostics: true });
  assert.ok(!built.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error));
  const exports = {}, module = { exports };
  const compiledPath = path.join(output, path.basename(file) + '.cjs');
  fs.writeFileSync(compiledPath, built.outputText, { mode: 0o600 });
  vm.runInNewContext(built.outputText, { exports, module, require(name) {
    if (Object.hasOwn(requires, name)) return requires[name];
    if (name.startsWith('node:')) return require(name);
    throw Error('unapproved fixture import: ' + name);
  }, Buffer, Date, Error, console, process, setTimeout, clearTimeout, setInterval, clearInterval, AbortController, ...globals }, { filename: compiledPath });
  return module.exports;
}
const scope = { projectId: crypto.randomUUID(), conversationId: crypto.randomUUID() };
const target = { ...scope, executionId: crypto.randomUUID(), kernelId: crypto.randomUUID(), kernelGeneration: 1,
  turnId: crypto.randomUUID(), invocationRunId: crypto.randomUUID(), originMessageId: crypto.randomUUID(), codeSha256: 'a'.repeat(64), environmentSha256: 'b'.repeat(64) };
const request = () => ({ ...target, requestId: crypto.randomUUID() });
const owner = { ownerServiceIdentity: 'native-service-identity', ownerBootId: crypto.randomUUID() };
const noAuth = { sessionForDaemonHandoff: () => null, onAuthSessionRestored: () => () => {}, onAuthSessionInvalidated: () => () => {} };
const noopRegister = { registerScienceMathHandlers() {} };
const clientModuleFile = path.join(repo, 'electron/science-host/daemon-client.ts');
const clientPorts = socketPath => ({ '../daemon/app-launcher': { ensureDaemonRunning() { starts++; throw Error('no heal allowed'); } },
  '../daemon/service-identity': { canonicalDaemonPath: p => p, daemonControlSocketPath: () => socketPath,
    resolveDaemonServiceIdentity: options => ({ userDataDir: options.userDataDir, storePath: options.storePath, serviceIdentity: owner.ownerServiceIdentity }) },
  '../../shared/ipc-error-code': { isIpcErrorCode: v => typeof v === 'string' && /^[a-z][a-z0-9_-]+$/.test(v) } });
// Extract the exact native Main callback, rather than duplicating its gate.
const mainFile = path.join(repo, 'electron/main.ts');
const mainSource = fs.readFileSync(mainFile, 'utf8'); sources.set(mainFile, digest(mainFile));
const ast = ts.createSourceFile(mainFile, mainSource, ts.ScriptTarget.Latest, true);
let humanGate;
function visit(node) { if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'assertHumanComputeSender') humanGate = node.initializer.getText(ast); ts.forEachChild(node, visit); }
visit(ast); assert.ok(humanGate, 'real Main human gate present');
const gateJs = ts.transpileModule('exports.gate = ' + humanGate, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const appControl = compiled(path.join(repo, 'electron/app-control/ipc-registry.ts'), { electron: { dialog: {} } });
const signedPayload = compiled(path.join(repo, 'shared/product-extension.ts')).productExtensionSignedPayload;
let api;
compiled(path.join(repo, 'electron/science-preload.ts'), { electron: { contextBridge: { exposeInMainWorld(name, value) { if (name === 'agentlasScience') api = value; } },
  ipcRenderer: { invoke: async (...args) => args } } }, { process: { argv: ['node', '--agentlas-extension-id=agentlas-science'] } });
async function ipcTests() {
  const loadIpc = clientModule => compiled(path.join(repo, 'electron/science-host/daemon-ipc.ts'), {
    './daemon-client': clientModule, '../auth': noAuth, './math-ipc': noopRegister,
    './publication-ipc': { registerSciencePublicationIpc() {}, SCIENCE_PUBLICATION_IPC_CHANNELS: [] },
    './style-library-ipc': { registerScienceStyleLibraryIpc() {}, SCIENCE_STYLE_LIBRARY_IPC_CHANNELS: [] } });
  const clientClass = compiled(clientModuleFile, clientPorts('/private/nonexistent-human-fixture.sock')).ScienceDaemonClientError;
  const ipc = loadIpc({ ScienceDaemonClientError: clientClass });
  function fixture() {
    const handlers = new Map(), pending = [], commands = [], stops = [];
    let allowed = true, releaseVersion = '1.0.0', destroyed = false;
    const sender = Object.assign(new EventEmitter(), { id: 77, mainFrame: {}, isDestroyed: () => destroyed });
    const event = { sender, senderFrame: sender.mainFrame };
    const envelope = input => ({ extensionId: 'agentlas-science', input });
    const assertSender = (e, v) => { if (!allowed || e.sender !== sender || v.extensionId !== 'agentlas-science') throw Error('fixture-permission-denied'); };
    const ex = {};
    vm.runInNewContext(gateJs, { exports: ex, isAppControlEvent: appControl.isAppControlEvent,
      isScienceExtensionViewSender: id => id === sender.id && !destroyed,
      assertScienceSender: assertSender, assertScienceExtensionViewPermission: () => { if (!allowed) throw Error('fixture-permission-denied'); },
      activeScienceExtension: () => ({ manifest: { id: 'agentlas-science', version: releaseVersion } }), productExtensionSignedPayload: signedPayload,
      createHash: crypto.createHash, Error });
    const client = { close() {}, command: async () => ({}), commandObserved: async command => { stops.push(command); return { requested: true }; }, commandHuman(admission, options) {
      return new Promise((resolve, reject) => pending.push({ admission, options, resolve, reject }));
    } };
    const execution = ipc.registerScienceDaemonExecutionIpc({ ipcMain: { handle(c, h) { handlers.set(c, h); appControl.recordAppControlHandler(c, h); }, removeHandler(c) { handlers.delete(c); } },
      assertScienceSender: assertSender, assertScienceViewPermission: () => { if (!allowed) throw Error('fixture-permission-denied'); }, assertHumanComputeSender: ex.gate, client });
    const dispatch = item => { item.admission.assertBeforeDispatch(); const c = item.admission.build(owner); item.admission.assertBeforeDispatch(); commands.push(c); return c; };
    return { handlers, event, envelope, sender, pending, commands, stops, dispatch, execution, revoke() { allowed = false; }, changeRelease() { releaseVersion = '2.0.0'; }, destroy() { destroyed = true; sender.emit('destroyed'); } };
  }
  for (const action of ['interrupt', 'clearGeneration', 'readHumanControl']) {
    const f = fixture(), input = action === 'readHumanControl' ? { ...scope, requestId: crypto.randomUUID() } : request();
    const preload = await api.researchCompute[action](input);
    check(preload[0] === 'science:researchCompute:' + action && preload[1].input === input, 'actual preload forwards only explicit input');
    const h = f.handlers.get(preload[0]), p = h(f.event, f.envelope(input));
    check(f.pending.length === 1, 'registered human handler awaits preflight');
    const stop = await f.handlers.get('science:composer:cancel')(f.event, f.envelope({ ...scope, turnId: target.turnId }));
    check(stop.requested === true && f.stops.length === 1 && f.stops[0].op === 'composer.cancel' && f.pending.length === 1, 'existing global Stop dispatches independently while human control awaits');
    const c = f.dispatch(f.pending[0]);
    check(c.op === 'compute.' + action && c.input.requestId === input.requestId && c.requester.ownerBootId === owner.ownerBootId && c.requester.ownerServiceIdentity === owner.ownerServiceIdentity, 'native requester uses verified owner');
    check(c.requester.releaseId.length === 64 && !Object.hasOwn(c.input, 'requester'), 'release hash native, requester absent renderer input');
    const answer = { schema: 'inert-response' }; f.pending[0].resolve(answer); check(await p === answer, 'exact accepted reply once');
    check(f.commands.length === 1, 'no automatic mutation retry'); f.execution.close();
    for (const mutation of ['permission', 'release', 'navigation', 'destroyed', 'closed']) {
      const g = fixture(), q = g.handlers.get(preload[0])(g.event, g.envelope(input));
      if (mutation === 'permission') g.revoke();
      if (mutation === 'release') g.changeRelease();
      if (mutation === 'navigation') g.sender.emit('did-start-navigation', {}, 'other', false, true);
      if (mutation === 'destroyed') g.destroy();
      if (mutation === 'closed') g.execution.close();
      try { g.dispatch(g.pending[0]); } catch { g.pending[0].reject(new clientClass({ schema: 'agentlas.science-daemon-client-error.v1', code: 'science_human_compute_admission_changed', phase: 'request', outcome: 'not-dispatched' })); }
      const result = await q;
      check(result.outcome === 'not-dispatched' && g.commands.length === 0, 'preflight ' + mutation + ' zero dispatch'); g.execution.close();
    }
    const lateFixture = fixture(), latePromise = lateFixture.handlers.get(preload[0])(lateFixture.event, lateFixture.envelope(input)); lateFixture.dispatch(lateFixture.pending[0]); lateFixture.revoke(); lateFixture.pending[0].resolve(answer);
    const late = await latePromise; check(late.outcome === 'unknown' && late.requestId === input.requestId && lateFixture.commands.length === 1, 'postdispatch revocation has unknown effect with original request'); lateFixture.execution.close();
    for (const outcome of ['unknown', 'rejected']) {
      const lostFixture = fixture(), lostPromise = lostFixture.handlers.get(preload[0])(lostFixture.event, lostFixture.envelope(input));
      lostFixture.dispatch(lostFixture.pending[0]);
      lostFixture.pending[0].reject(new clientClass({ schema:'agentlas.science-daemon-client-error.v1', code:'science_daemon_connection_closed',phase:'request',outcome }));
      const result = await lostPromise;
      check(result.schema === 'agentlas.science-human-compute-transport.v1' && result.outcome === 'unknown' && result.requestId === input.requestId && result.action === (action === 'clearGeneration' ? 'clear-generation' : action === 'readHumanControl' ? 'read-control' : action), 'typed lost or rejected reply retains original request/action with unknown effects');
      if (action !== 'readHumanControl') check(JSON.stringify(result.target) === JSON.stringify(target), 'typed uncertainty retains exact original target');
      check(lostFixture.commands.length === 1, 'typed uncertainty never resends'); lostFixture.execution.close();
    }
    for (const wrong of [{ ...input, requester: owner }, { ...input, actor: 'user' }, { ...input, token: 'injected' }]) {
      const g = fixture(), bad = await g.handlers.get(preload[0])(g.event, g.envelope(wrong));
      check(bad.outcome === 'not-dispatched' && g.pending.length === 0 && !JSON.stringify(bad).includes('injected'), 'renderer authority injection denied without leaking'); g.execution.close();
    }
    const g = fixture(); const sub = await g.handlers.get(preload[0])({ ...g.event, senderFrame: {} }, g.envelope(input));
    check(sub.outcome === 'not-dispatched' && g.pending.length === 0, 'subframe denied');
    appControl.configureAppControlInteractionValidator(() => {}); appControl.recordAppControlRendererEvent(g.event);
    const controlled = await appControl.invokeAppControlIpc({ window: { isDestroyed: () => false, webContents: g.sender }, channel: preload[0], args: [g.envelope(input)], operation: 'own-fixture' });
    check(controlled.outcome === 'not-dispatched' && controlled.code === 'science-human-compute-view-required' && g.pending.length === 0, 'actual app-control with recorded real view event denied'); g.execution.close();
  }

  const sid=crypto.randomUUID(),rid=crypto.randomUUID(),sessionInputs={beginSession:{...scope,requestId:rid,anchorTarget:target,mode:'fresh-generation'},runSession:{...scope,requestId:rid,sessionId:sid,sessionEpoch:1,code:'x=1',outputs:['x.txt']},readSession:{...scope,sessionId:sid},readSessionRequest:{...scope,sessionId:sid,requestId:rid},stopSession:{...scope,sessionId:sid,sessionEpoch:1,requestId:rid}};
  for(const action of Object.keys(sessionInputs)){
    const input=sessionInputs[action],preload=await api.researchCompute[action](input);check(preload[0]==='science:researchCompute:'+action&&preload[1].input===input,'actual '+action+' preload exact input, no actor');
    const f=fixture(),q=f.handlers.get(preload[0])(f.event,f.envelope(input));check(f.pending.length===1,'session '+action+' awaits no-heal native preflight');const c=f.dispatch(f.pending[0]);check(c.op==='compute.'+action&&JSON.stringify(c.input)===JSON.stringify(input)&&c.requester.ownerBootId===owner.ownerBootId&&!('requester'in c.input),'session command exact input with native owner pins');f.pending[0].resolve({observed:true});check((await q).observed&&f.commands.length===1,'session single dispatch reply');f.execution.close();
    const late=fixture(),pending=late.handlers.get(preload[0])(late.event,late.envelope(input));late.dispatch(late.pending[0]);late.revoke();late.pending[0].resolve({observed:true});const unknown=await pending;check(unknown.schema==='agentlas.science-human-compute-session-transport.v1'&&unknown.outcome==='unknown'&&JSON.stringify(unknown.input)===JSON.stringify(input)&&late.commands.length===1,'session post-dispatch revoke retains exact request input, no retry');late.execution.close();
    for(const mutation of ['permission','release','navigation']){const g=fixture(),wait=g.handlers.get(preload[0])(g.event,g.envelope(input));if(mutation==='permission')g.revoke();if(mutation==='release')g.changeRelease();if(mutation==='navigation')g.sender.emit('did-start-navigation',{},'other',false,true);try{g.dispatch(g.pending[0]);}catch{g.pending[0].reject(new clientClass({schema:'agentlas.science-daemon-client-error.v1',code:'science_human_compute_admission_changed',phase:'request',outcome:'not-dispatched'}));}check((await wait).outcome==='not-dispatched'&&g.commands.length===0,'session preflight '+mutation+' refuses before effect');g.execution.close();}
    for(const patch of [{requester:owner},{actor:'human'},{token:'injected'}]){const g=fixture(),v=await g.handlers.get(preload[0])(g.event,g.envelope({...input,...patch}));check(v.outcome==='not-dispatched'&&g.pending.length===0,'session renderer authority input denied');g.execution.close();}
    const g=fixture();check((await g.handlers.get(preload[0])({...g.event,senderFrame:{}},g.envelope(input))).outcome==='not-dispatched','session subframe denied');appControl.configureAppControlInteractionValidator(()=>{});appControl.recordAppControlRendererEvent(g.event);const denied=await appControl.invokeAppControlIpc({window:{isDestroyed:()=>false,webContents:g.sender},channel:preload[0],args:[g.envelope(input)],operation:'own-fixture'});check(denied.outcome==='not-dispatched'&&g.pending.length===0,'session app-control recorded view denied');g.execution.close();
  }
  for(const action of ['interrupt','clearGeneration']){const f=fixture(),input={...request(),turnId:null,invocationRunId:null},q=f.handlers.get('science:researchCompute:'+action)(f.event,f.envelope(input));const c=f.dispatch(f.pending[0]);check(c.input.turnId===null&&c.input.invocationRunId===null,'native bootstrap '+action+' forwards paired null model scope to exact backend closure, not model grant');f.pending[0].resolve({observed:true});await q;f.execution.close();for(const partial of [{turnId:null},{invocationRunId:null}]){const g=fixture(),v=await g.handlers.get('science:researchCompute:'+action)(g.event,g.envelope({...request(),...partial}));check(v.outcome==='not-dispatched'&&g.pending.length===0,'mixed nullable model scope denied before dispatch');g.execution.close();}}
  const bootstrap={...scope,requestId:crypto.randomUUID(),mode:'bootstrap-python',originMessageId:target.originMessageId,language:'python',environment:{kind:'system'},limits:{maxCells:100}};
  const bf=fixture(),bp=bf.handlers.get('science:researchCompute:beginSession')(bf.event,bf.envelope(bootstrap));const dispatched=bf.dispatch(bf.pending[0]);check(JSON.stringify(dispatched.input)===JSON.stringify(bootstrap)&&Object.isFrozen(dispatched.input.environment)&&Object.isFrozen(dispatched.input.limits)&&!('anchorTarget'in dispatched.input)&&dispatched.requester.ownerBootId===owner.ownerBootId,'bootstrap existing signed RPC owns exact native origin/system/limits without model anchor');bf.pending[0].resolve({accepted:true});await bp;bf.execution.close();
  for(const patch of [{anchorTarget:target},{originMessageId:null},{language:'r'},{environment:{kind:'system',path:'/tmp'}},{environment:{kind:'named',name:'analysis'}},{requester:owner},{turnId:target.turnId},{limits:{maxCells:0}}]){const f=fixture(),v=await f.handlers.get('science:researchCompute:beginSession')(f.event,f.envelope({...bootstrap,...patch}));check(v.outcome==='not-dispatched'&&f.pending.length===0,'bootstrap malformed lineage/environment/native identity denied before dispatch');f.execution.close();}
  for(const mutation of ['permission','release','navigation']){const f=fixture(),promise=f.handlers.get('science:researchCompute:beginSession')(f.event,f.envelope(bootstrap));if(mutation==='permission')f.revoke();if(mutation==='release')f.changeRelease();if(mutation==='navigation')f.sender.emit('did-start-navigation',{},'other',false,true);try{f.dispatch(f.pending[0]);}catch{f.pending[0].reject(new clientClass({schema:'agentlas.science-daemon-client-error.v1',code:'science_human_compute_admission_changed',phase:'request',outcome:'not-dispatched'}));}check((await promise).outcome==='not-dispatched'&&f.commands.length===0,'bootstrap preflight revocation before any dispatch');f.execution.close();}
  const lostBootstrap=fixture(),lostPromise=lostBootstrap.handlers.get('science:researchCompute:beginSession')(lostBootstrap.event,lostBootstrap.envelope(bootstrap));lostBootstrap.dispatch(lostBootstrap.pending[0]);lostBootstrap.revoke();lostBootstrap.pending[0].resolve({accepted:true});const unknownBootstrap=await lostPromise;check(unknownBootstrap.outcome==='unknown'&&JSON.stringify(unknownBootstrap.input)===JSON.stringify(bootstrap)&&lostBootstrap.commands.length===1,'bootstrap postdispatch uncertainty preserves exact ID/input without resend');lostBootstrap.execution.close();
  const af=fixture();appControl.configureAppControlInteractionValidator(()=>{});appControl.recordAppControlRendererEvent(af.event);const av=await appControl.invokeAppControlIpc({window:{isDestroyed:()=>false,webContents:af.sender},channel:'science:researchCompute:beginSession',args:[af.envelope(bootstrap)],operation:'own-fixture'});check(av.outcome==='not-dispatched'&&af.pending.length===0,'bootstrap actual app-control recorded view never mints signed human Start');af.execution.close();
  for(const invalid of [{...sessionInputs.beginSession,mode:'automatic'},{...sessionInputs.beginSession,limits:{maxCells:0}},{...sessionInputs.runSession,sessionEpoch:0},{...sessionInputs.runSession,outputs:['../escape']},{...sessionInputs.readSession,requestId:rid},{...scope}]){const action=Object.hasOwn(invalid,'anchorTarget')?'beginSession':Object.hasOwn(invalid,'code')?'runSession':'readSession',g=fixture();const r=await g.handlers.get('science:researchCompute:'+action)(g.event,g.envelope(invalid));check(r.outcome==='not-dispatched'&&g.pending.length===0,'malformed session DTO no dispatch');g.execution.close();}
}
async function socketTests() {
  const dir = fs.mkdtempSync('/tmp/science-human-compute-'), socketPath = path.join(dir, 'control.sock'), storePath = path.join(dir, 'store.sqlite'); fs.writeFileSync(storePath, 'inert store fixture');
  let commands = [], mode = 'normal', beforeCommand = null;
  const server = net.createServer(socket => { let text = ''; socket.on('data', data => { text += data; for (;;) { const pos = text.indexOf('\n'); if (pos < 0) break; const msg = JSON.parse(text.slice(0, pos)); text = text.slice(pos + 1);
    let result;
    if (msg.method === 'daemon.ping') result = { ok: true, serviceProtocolVersion: 2, lifetime: 'service', processRole: 'desktop-daemon', controlSocketReady: true, version: 'fixture', storeSchemaVersion: 1, storePath, serviceIdentity: owner.ownerServiceIdentity, bootId: owner.ownerBootId, pid: process.pid };
    if (msg.method === 'science.status') { if (beforeCommand) beforeCommand(); result = { schema: 'agentlas.science-daemon-status.v1', ownerEpoch: owner.ownerBootId, state: mode === 'not-ready' ? 'idle' : 'ready', settled: true, extensionVersion: null, errorCode: null, activeToolRequests: 0 }; }
    if (msg.method === 'science.command') { commands.push(msg); if (mode === 'lost') { socket.end(); return; } if (mode === 'reject') { socket.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'owner changed', data: { sourceCode: 'owner_changed' } } }) + '\n'); return; } result = { accepted: true }; }
    socket.write(JSON.stringify({ id: msg.id, result }) + '\n');
  } }); });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const module = compiled(clientModuleFile, clientPorts(socketPath));
  const client = module.createScienceDaemonClient({ userDataDir: dir, storePath, installIdentity: {}, requiredSchemaVersion: 1, appVersion: 'fixture' });
  let allowed = true, buildCount = 0, release = 'pinned-release', frame = 'pinned-frame';
  const admission = { assertBeforeDispatch() { if (!allowed || release !== 'pinned-release' || frame !== 'pinned-frame') throw Error('revoked'); }, build(native) { buildCount++; assert.deepEqual(JSON.parse(JSON.stringify(native)), owner); return { op: 'compute.interrupt', input: request(), requester: { kind: 'signed-science-main-frame', viewInstanceId: crypto.randomUUID(), releaseId: 'c'.repeat(64), ...native } }; } };
  try {
    const handlers = new Map();
    const ipc = compiled(path.join(repo, 'electron/science-host/daemon-ipc.ts'), {
      './daemon-client': module, '../auth': noAuth, './math-ipc': noopRegister,
      './publication-ipc': {registerSciencePublicationIpc(){},SCIENCE_PUBLICATION_IPC_CHANNELS:[]},
      './style-library-ipc': {registerScienceStyleLibraryIpc(){},SCIENCE_STYLE_LIBRARY_IPC_CHANNELS:[]},
    });
    const sender = {id:99,mainFrame:{},isDestroyed:()=>false}; const event = {sender,senderFrame:sender.mainFrame};
    const registered = ipc.registerScienceDaemonExecutionIpc({ipcMain:{handle(c,h){handlers.set(c,h);},removeHandler(c){handlers.delete(c);}},client: { ...client, command(command, options) {
        if (command.op === 'runtime.adoptSession') return Promise.resolve({ fixtureAuthHandoff: true });
        return client.command(command, options);
      } },
      assertScienceSender(e,v){assert.equal(e.sender,sender);assert.equal(v.extensionId,'agentlas-science');},assertScienceViewPermission(){}});
    for (const action of ['list','read','capability']) {
      const channel = action === 'capability' ? 'science:researchCapabilities:inspect' : 'science:researchCompute:' + action;
      const input = action === 'read' ? {...scope,executionId:target.executionId} : scope;
      const result = await handlers.get(channel)(event,{extensionId:'agentlas-science',input});
      check(result.accepted === true && commands.at(-1).params.command.op === (action === 'capability' ? 'capability.inspect' : 'compute.'+action), 'actual registered ' + action + ' → actual client/socket roundtrip with monotonic deadline');
    }

    for(const op of ['compute.beginSession','compute.runSession','compute.readSession','compute.readSessionRequest','compute.stopSession']) {
      const value=await client.commandHuman({...admission,build(native){const result=admission.build(native);return {...result,op};}});check(value.accepted&&commands.at(-1).params.command.op===op,'actual socket client admits whitelisted '+op+' without creating owner');
    }
    buildCount=0; // Start the original guard counter after the separate session whitelist probes.
    const initialCommands = commands.length;
    const accepted = await client.commandHuman(admission); check(accepted.accepted && commands.length === initialCommands + 1 && buildCount === 1, 'actual socket dispatch exactly once after actual preflight');
    beforeCommand = () => { allowed = false; }; const count = commands.length;
    await assert.rejects(client.commandHuman(admission), e => e.failure.outcome === 'not-dispatched'); checks++;
    check(commands.length === count, 'actual async preflight revocation zero mutation dispatch'); beforeCommand = null; allowed = true;
    // Revoke at the actual socket connect callback after preflight/build.
    for (const mutation of ['permission', 'release', 'navigation']) {
      const connectedPorts = clientPorts(socketPath), realConnect = net.connect;
      const netSeam = { connect(...args) { const socket = realConnect(...args); socket.prependOnceListener('connect', () => {
        if (buildCount > 1) { if (mutation === 'permission') allowed = false; if (mutation === 'release') release = 'changed'; if (mutation === 'navigation') frame = 'changed'; }
      }); return socket; } };
      const seam = compiled(clientModuleFile, { ...connectedPorts, 'node:net': netSeam });
      const seamClient = seam.createScienceDaemonClient({ userDataDir: dir, storePath, installIdentity: {}, requiredSchemaVersion: 1, appVersion: 'fixture' });
      buildCount = 0; const seamAdmission = { ...admission, build(native) { buildCount = 2; return admission.build(native); } };
      await assert.rejects(seamClient.commandHuman(seamAdmission), e => e.failure.outcome === 'not-dispatched'); checks++;
      check(commands.length === count, 'actual final socket barrier ' + mutation + ' zero dispatch'); seamClient.close(); allowed = true; release = 'pinned-release'; frame = 'pinned-frame';
    }
    mode = 'lost'; await assert.rejects(client.commandHuman(admission), e => e.failure.outcome === 'unknown'); checks++;
    check(commands.length === count + 1, 'lost reply unknown without retry');
    mode = 'reject'; await assert.rejects(client.commandHuman(admission), e => e.failure.outcome === 'rejected'); checks++;
    check(commands.length === count + 2, 'remote owner rejection preserved, not auto retried');
    mode = 'not-ready'; await assert.rejects(handlers.get('science:researchCompute:list')(event,{extensionId:'agentlas-science',input:scope}), e => e.failure.outcome === 'not-dispatched'); checks++;
    check(starts === 0, 'actual registered read when unavailable never heals');
    await assert.rejects(client.commandHuman(admission), e => e.failure.outcome === 'not-dispatched'); checks++;
    check(commands.length === count + 2 && starts === 0, 'not ready never starts/heals daemon');
  } finally { client.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
}
async function daemonTests() {
  const ui = compiled(path.resolve(repo, '../agentlas-science/src/scientific-compute-ui.ts'));
  let lease = true, effects = 0, seen = null, ownedService;
  const saved = new Map();
  const service = { interruptHuman(r, i, guard) { assert.equal(this, service); guard(r); effects++; seen = r; const result = { schema: 'agentlas.science-human-compute-control.v1', action: 'interrupt', target: Object.fromEntries(Object.entries(i).filter(([k]) => k !== 'requestId')), requestId: i.requestId, phase: 'accepted', processState: 'live', ramState: 'live-with-mutations-possible', receiptState: 'unavailable', requestReceiptBlob: null, facts: [] }; saved.set(i.requestId, result); return result; },
    clearGenerationHuman(r, i, g) { const result = this.interruptHuman(r, i, g); result.action = 'clear-generation'; return result; }, readHumanControl(r, i, g) { assert.equal(this, service); g(r); const value = saved.get(i.requestId); if (!value) throw Error('science-human-compute-not-found'); return value; } };
  const store = { getProject: id => id === scope.projectId ? {} : null, listConversations: () => [{ id: scope.conversationId }], onResearchLifecycleChanged: () => () => {} };
  const fakeScience = { ...ui, configureScienceRuntimeRole() {}, configureScienceServiceAvailability() {}, scienceStore: () => store,
    scienceToolGateway: () => ({ activeRequestCount: () => 0 }), scienceScientificExecutionService: () => service,
    scienceConversationService: () => ({ onEvent: () => () => {} }), createScienceDesktopLongRunAdapter: () => ({ isSettled: () => true, recoverAndProjectAtStartup: async () => {}, closeAdmission() {}, interrupt: async () => {} }), closeScienceStore: async () => {} };
  const daemon = compiled(path.join(repo, 'electron/daemon/science-service.ts'), {
    '../../shared/tool-approval-action': { toolApprovalActionId: () => '' }, './science-publication-commands': { dispatchSciencePublicationCommand() {} },
    '../extensions/science': { scienceExtensionStatus: () => ({ phase: 'installed', enabled: true, version: 'fixture' }) }, 'agentlas-science': fakeScience,
    './science-host': { installDaemonScienceHost: () => ({ registerQuestionUi() {}, stopClock() {}, project() {} }) },
    '../long-run/science-projection': { adoptScienceLongRunOwnership() {} },
    '../runtime/tool-approval': { listPendingToolApprovals: () => [], onToolApprovalRequested: () => () => {}, onToolApprovalResolved: () => () => {} },
    '../store/capability-grants': {}, '../confirm/ask-user': { onAskUserLifecycle: () => () => {} } });
  ownedService = daemon.createDaemonScienceService({ ownerEpoch: owner.ownerBootId, ownerServiceIdentity: owner.ownerServiceIdentity, assertOwner() { if (!lease) throw Error('lease-withdrawn'); } });
  await ownedService.start();
  const requester = { kind: 'signed-science-main-frame', viewInstanceId: crypto.randomUUID(), releaseId: 'c'.repeat(64), ...owner }, i = request();
  try {
    const good = await ownedService.dispatch({ op: 'compute.interrupt', requester, input: i }); check(good.requestId === i.requestId && effects === 1 && seen.ownerBootId === owner.ownerBootId, 'actual daemon dispatch reaches same service with native guard');
    const read = await ownedService.dispatch({ op: 'compute.readHumanControl', requester, input: { ...scope, requestId: i.requestId } }); check(read.requestId === i.requestId && effects === 1, 'actual original-request read cannot replay effect');
    await assert.rejects(ownedService.dispatch({ op:'compute.readHumanControl',requester,input:{...scope,requestId:crypto.randomUUID()} }), /science-human-compute-not-found/); checks++;
    check(effects === 1, 'absent original control read refuses without synthesizing effect success');
    const clearInput = request(); const cleared = await ownedService.dispatch({op:'compute.clearGeneration',requester,input:clearInput});
    check(cleared.action === 'clear-generation' && cleared.requestId === clearInput.requestId && effects === 2, 'hard clear has dedicated native factory/service path');
    for (const patch of [{ ownerBootId: crypto.randomUUID() }, { ownerServiceIdentity: 'foreign-service-identity' }, { kind: 'user' }, { actor: 'user' }]) { await assert.rejects(ownedService.dispatch({ op: 'compute.interrupt', requester: { ...requester, ...patch }, input: i }), /owner_invalid/); checks++; }
    await assert.rejects(ownedService.dispatch({ op: 'compute.interrupt', requester, input: { ...i, conversationId: crypto.randomUUID() } }), /conversation-not-found/); checks++;
    lease = false; await assert.rejects(ownedService.dispatch({ op: 'compute.interrupt', requester, input: i }), /lease-withdrawn/); checks++;
    check(effects === 2, 'wrong scope/boot/identity/kind/lease never reaches effect'); lease = true;

    const sessionId=crypto.randomUUID(),beginId=crypto.randomUUID(),pin={blobRef:'science-run-blob:sha256:'+'f'.repeat(64),sha256:'f'.repeat(64),byteSize:1500},time='2026-10-11T13:00:00.000Z';let sessionEffects=0,sessionReads=0;
    const session={schema:'agentlas.science-human-compute-session.v1',...scope,sessionId,requestId:beginId,epoch:1,status:'active',mode:'fresh-generation',admissionReceiptBlob:pin,lineage:{kind:'lineage-only',target},variablesRestored:false,kernel:{id:crypto.randomUUID(),generation:2,language:'python',environmentSha256:target.environmentSha256},observation:null,budget:{limits:{wallTimeMs:3600000,maxCells:100,maxActiveRuntimeMs:900000,maxCellTimeMs:120000},usedCells:0,activeRuntimeMs:0,deadlineAt:time},receiptState:'persisted'};
    service.beginHumanSession=function(r,input,g){assert.equal(this,service);g(r);sessionEffects++;return {...session,requestId:input.requestId,mode:input.mode,...(input.mode==='bootstrap-python'?{lineage:{kind:'native-bootstrap',...scope,originMessageId:input.originMessageId,environmentReceiptBlob:{blobRef:'science-run-blob:sha256:'+target.environmentSha256,sha256:target.environmentSha256,byteSize:1500}}}:{})};};
    const bootstrapResult=await ownedService.dispatch({op:'compute.beginSession',requester,input:{...scope,requestId:crypto.randomUUID(),mode:'bootstrap-python',originMessageId:target.originMessageId,language:'python',environment:{kind:'system'}}});check(bootstrapResult.mode==='bootstrap-python'&&bootstrapResult.lineage.kind==='native-bootstrap'&&bootstrapResult.lineage.originMessageId===target.originMessageId,'actual daemon singleton forwarding preserves bootstrap discriminator and native guard');sessionEffects=0;
    service.readHumanSession=function(r,input,g){assert.equal(this,service);g(r);sessionReads++;return session;};
    service.runHumanSession=function(r,input,g){assert.equal(this,service);g(r);sessionEffects++;return {schema:'agentlas.science-human-compute-session-execution.v1',...scope,requestId:input.requestId,sessionId,receiptState:'unavailable',requestReceiptBlob:null,execution:null};};
    service.readHumanSessionRequest=function(r,input,g){assert.equal(this,service);g(r);sessionReads++;return {schema:'agentlas.science-human-compute-session-execution.v1',...scope,requestId:input.requestId,sessionId,receiptState:'unavailable',requestReceiptBlob:null,execution:null};};
    service.stopHumanSession=function(r,input,g){assert.equal(this,service);g(r);sessionEffects++;return {...session,status:'stopped'};};
    const inputs={beginSession:{...scope,requestId:beginId,anchorTarget:target,mode:'fresh-generation'},runSession:{...scope,requestId:crypto.randomUUID(),sessionId,sessionEpoch:1,code:'x=1'},readSession:{...scope,sessionId},readSessionRequest:{...scope,sessionId,requestId:crypto.randomUUID()},stopSession:{...scope,sessionId,sessionEpoch:1,requestId:crypto.randomUUID()}};
    for(const action of Object.keys(inputs)){await ownedService.dispatch({op:'compute.'+action,requester,input:inputs[action]});check(true,'actual daemon singleton→factory→'+action+' native scoped service');}
    check(sessionEffects===3&&sessionReads===2,'session observational reads do not invoke effect ports');
    for(const action of Object.keys(inputs)){await assert.rejects(ownedService.dispatch({op:'compute.'+action,requester:{...requester,ownerBootId:'stale'},input:inputs[action]}),/owner_invalid/);checks++;await assert.rejects(ownedService.dispatch({op:'compute.'+action,requester,input:{...inputs[action],conversationId:crypto.randomUUID()}}),action==='beginSession'?/human-scope-mismatch/:/conversation-not-found/);checks++;}
    const oldRun=service.runHumanSession;delete service.runHumanSession;await assert.rejects(ownedService.dispatch({op:'compute.runSession',requester,input:inputs.runSession}),/human_unavailable/);checks++;service.runHumanSession=oldRun;check(sessionEffects===3,'missing session runtime refuses without duplicating service or effect');
    const original = fakeScience.createScientificComputeUiControls; delete fakeScience.createScientificComputeUiControls;
    await assert.rejects(ownedService.dispatch({ op: 'compute.interrupt', requester, input: i }), /human_unavailable/); checks++; fakeScience.createScientificComputeUiControls = original;
  } finally { lease = true; await ownedService.close(); }
}
(async () => {
  await ipcTests(); await socketTests(); await daemonTests();
  const receipt = { schema: 'agentlas.science-human-compute-transport-contract.v1', status: 'passed', checks, daemonStarts: starts,
    sourcePins: [...sources].map(([p, sha256]) => ({ path: p, sha256 })), contractSha256: digest(__filename),
    evidenceLayer: 'actual-registered-source-and-native-gate-with-actual-disposable-unix-socket-client-and-actual-daemon-dispatch-inert-effect-ports',
    boundaries: { installedSignedView: 'unknown', physicalClick: 'unproven', realDaemonOwner: 'not-used', registrationAuthSessionHandoff: 'inert-port-not-tested', kernelSignal: 'not-exercised-here', provider: 0, model: 0, mutationRetry: 0 } };
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(receipt));
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
