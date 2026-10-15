#!/usr/bin/env node
'use strict';
// Actual registered handlers compiled into a private output directory. Only
// inert Electron/client/auth ports are injected; no daemon or provider starts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const repo = path.resolve(__dirname, '..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('absolute private output directory required');
fs.mkdirSync(output, { recursive: true });
const ts = require(require.resolve('typescript', { paths: [repo] }));
const sourcePath = path.join(repo, 'electron/science-host/daemon-ipc.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const built = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
assert.ok(!built.diagnostics?.some(row => row.category === ts.DiagnosticCategory.Error));
const compiledPath = path.join(output, 'daemon-ipc.cjs');
fs.writeFileSync(compiledPath, built.outputText);
const exportsPort = {};
class ClientError extends Error {}
const requirePort = name => {
  if (name === 'node:crypto') return crypto;
  if (name === 'node:perf_hooks') return require('node:perf_hooks');
  if (name === './daemon-client') return { ScienceDaemonClientError: ClientError };
  if (name === '../auth') return { sessionForDaemonHandoff: () => null, onAuthSessionRestored: () => () => {}, onAuthSessionInvalidated: () => () => {} };
  if (name === './math-ipc') return { registerScienceMathHandlers() {} };
  if (name === './publication-ipc') return { registerSciencePublicationIpc() {}, SCIENCE_PUBLICATION_IPC_CHANNELS: [] };
  if (name === './style-library-ipc') return { registerScienceStyleLibraryIpc() {}, SCIENCE_STYLE_LIBRARY_IPC_CHANNELS: [] };
  throw Error('unexpected runtime import: ' + name);
};
vm.runInNewContext(built.outputText, { exports: exportsPort, require: requirePort, Date, Map, Set, Promise, Error, Number }, { filename: compiledPath });
const scope = { projectId: 'c6124398-9aa5-463c-bb25-6ded919de8a8', conversationId: '38c49cc8-55ab-4343-98b2-27742c7eac92' };
const channels = [ ['science:researchCompute:list', 'compute.list'], ['science:researchCompute:read', 'compute.read'], ['science:researchCapabilities:inspect', 'capability.inspect'] ];
let checks = 0, starts = 0, directReadCommands = 0, observedCalls = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
function fixture() {
  const handlers = new Map(), pending = [], removed = [];
  let allowed = true, authCalls = 0;
  const mainFrame = {}, sender = { id: 7, mainFrame, isDestroyed: () => false };
  const event = { sender, senderFrame: mainFrame };
  const client = {
    command(command) { if (command.op !== 'runtime.adoptSession') directReadCommands++; return Promise.resolve({}); },
    commandObserved(command, options) { observedCalls++; return new Promise((resolve, reject) => pending.push({ command, options, resolve, reject })); },
    ensureStarted() { starts++; throw Error('observation must never start/heal'); },
    close() {},
  };
  const execution = exportsPort.registerScienceDaemonExecutionIpc({
    ipcMain: { handle(channel, handler) { assert.ok(!handlers.has(channel)); handlers.set(channel, handler); }, removeHandler(channel) { removed.push(channel); handlers.delete(channel); } },
    assertScienceSender(current, envelope, permission) {
      authCalls++;
      if (!allowed) throw Error('fixture-runtime-capability-revoked');
      if (current.sender !== sender || envelope.extensionId !== 'fixture-signed-science') throw Error('fixture-sender-denied');
      assert.equal(permission, 'science:agent-runtime');
    }, assertScienceViewPermission() {}, client,
  });
  return { handlers, pending, removed, event, sender, execution,
    revoke() { allowed = false; }, authCalls: () => authCalls,
    envelope(input = scope) { return { extensionId: 'fixture-signed-science', input }; },
  };
}
async function main() {
  for (const [channel, op] of channels) {
    const f = fixture(), handler = f.handlers.get(channel);
    const input = op === 'compute.read' ? { ...scope, executionId: '71d14f76-d496-49eb-b29d-1df714e5efb9', afterCursor: 2, maxEvents: 5 } : { ...scope };
    const startedAt = performance.now();
    const request = handler(f.event, f.envelope(input));
    check(f.pending.length === 1, channel + ' dispatches exactly one observed read');
    const dispatch = f.pending[0];
    assert.deepEqual(JSON.parse(JSON.stringify(dispatch.command)), { op, input }); checks++;
    check(dispatch.options.timeoutMs === 5000 && dispatch.options.observationDeadlineMs >= startedAt + 5000 && dispatch.options.observationDeadlineMs <= performance.now() + 5000, channel + ' uses bounded monotonic observation');
    const response = { ...scope, schema: 'inert-response', result: { status: 'failed', osProcessState: 'live' } };
    dispatch.resolve(response);
    assert.equal(await request, response); checks++;
    check(f.authCalls() === 2, channel + ' checks authority before and after await');
    f.execution.close();
    check(f.removed.includes(channel), channel + ' removed on close');

    for (const mutation of ['navigation', 'capability-revocation', 'ipc-close']) {
      const g = fixture(), lateHandler = g.handlers.get(channel);
      const late = lateHandler(g.event, g.envelope(input));
      check(g.pending.length === 1, channel + ' pending read for ' + mutation);
      if (mutation === 'navigation') g.sender.mainFrame = {};
      if (mutation === 'capability-revocation') g.revoke();
      if (mutation === 'ipc-close') g.execution.close();
      g.pending[0].resolve(response);
      await assert.rejects(late, mutation === 'navigation' ? /subframe-denied/ : mutation === 'capability-revocation' ? /capability-revoked/ : /ipc-closed/); checks++;
      check(g.pending.length === 1, channel + ' never redispatches stale reply');
      g.execution.close();
    }

    const h = fixture(), invalidHandler = h.handlers.get(channel);
    await assert.rejects(Promise.resolve().then(() => invalidHandler(h.event, h.envelope({ ...scope, projectId: '' }))), /scope-invalid/); checks++;
    await assert.rejects(Promise.resolve().then(() => invalidHandler({ ...h.event, senderFrame: {} }, h.envelope())), /subframe-denied/); checks++;
    await assert.rejects(Promise.resolve().then(() => invalidHandler(h.event, { extensionId: 'foreign', input: scope })), /sender-denied/); checks++;
    h.revoke();
    await assert.rejects(Promise.resolve().then(() => invalidHandler(h.event, h.envelope())), /capability-revoked/); checks++;
    check(h.pending.length === 0, channel + ' bad scope/frame/capability never reaches client');
    h.execution.close();
  }
  check(starts === 0 && directReadCommands === 0, 'all read handlers never start/heal or issue direct commands');
  const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const receipt = { schema: 'agentlas.science-compute-observation-scope-contract.v1', status: 'passed', checks,
    testedChannels: channels.map(([channel]) => channel), observedCalls, daemonStarts: starts, directReadCommands,
    source: { path: 'electron/science-host/daemon-ipc.ts', sha256: digest(sourcePath) }, compiled: { sha256: digest(compiledPath) }, contract: { sha256: digest(__filename) },
    evidenceLayer: 'actual-registered-source-handlers-with-inert-ports', boundaries: { electronLaunch: false, daemonStart: false, scienceRuntime: false, provider: false, realAuthentication: false, installedSignedUi: 'unverified', modelConsumption: 'unknown' } };
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
