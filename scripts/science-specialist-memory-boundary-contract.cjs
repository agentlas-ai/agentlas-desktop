#!/usr/bin/env node
'use strict';
// Current production readers/Main + disposable SQLite/packages. Native runner events are
// deterministic fixtures: no provider, real registration, model, sidecar or installed app.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { app } = require('electron');
const root = path.resolve(__dirname, '..'), science = path.resolve(root, '../agentlas-science');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'science-specialist-memory-')));
const user = path.join(scratch, 'user'), home = path.join(scratch, 'home');
fs.mkdirSync(user); fs.mkdirSync(home);
app.setPath('userData', user); app.setPath('home', home);
process.env.AGENTLAS_E2E = '1';
process.env.AGENTLAS_STORE_PATH = path.join(user, 'desktop.sqlite');
let scienceStore, desktopDb;
function cleanup() {
  try { scienceStore?.close(); } catch {}
  try { desktopDb?.close(); } catch {}
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
process.once('exit', cleanup);
const sd = path.join(scratch, 'science-dist'), dd = path.join(scratch, 'desktop-dist');
// Compile current source instead of borrowing stale shared dist. Dependencies remain local.
function compile(project, config, options) {
  const file = path.join(scratch, `${path.basename(project)}-tsconfig.json`);
  fs.writeFileSync(file, JSON.stringify({ extends: path.join(project, config), compilerOptions: options }));
  const tsc = require.resolve('typescript/bin/tsc', { paths: [project] });
  const result = spawnSync(process.execPath, [tsc, '-p', file], {
    cwd: project, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.error || result.status !== 0) throw new Error(`Private source compilation failed: ${result.error?.message || result.stdout + result.stderr}`);
}
compile(science, 'tsconfig.json', { outDir: sd, typeRoots: [path.join(science, 'node_modules/@types')] });
compile(root, 'electron/tsconfig.json', { outDir: dd, baseUrl: root, typeRoots: [path.join(root, 'node_modules/@types')],
  paths: { '@shared/*': ['shared/*'], 'agentlas-science': [path.join(sd, 'index.d.ts')], 'agentlas-science/dist/*': [path.join(sd, '*')] } });
fs.symlinkSync(path.join(root, 'node_modules'), path.join(scratch, 'node_modules'), 'junction');
const built = name => require(path.join(dd, name)), sc = name => require(path.join(sd, name));
const id = () => crypto.randomUUID(), sha = value => crypto.createHash('sha256').update(value).digest('hex');
const checks = [];
function check(value, name) { assert.ok(value, name); checks.push(name); }
function throws(action, pattern, name) { assert.throws(action, pattern, name); checks.push(name); }
async function rejects(action, pattern, name) { await assert.rejects(action, pattern, name); checks.push(name); }
function tree(folder) {
  const out = [];
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      out.push({ path: path.relative(folder, file), mode: stat.mode, size: stat.size, mtime: stat.mtimeMs,
        type: stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file', hash: stat.isFile() ? sha(fs.readFileSync(file)) : null });
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(folder); return out;
}

async function main() {
  await app.whenReady();
  const dbModule = built('electron/store/db.js'); dbModule.initStore(); desktopDb = dbModule.getDb();
  // A bounded hashing adapter avoids probing host model assets. Governance/SQL/recall readers stay production.
  const embeddings = built('electron/memory/local-embedding.js');
  embeddings.autoLocalEmbedding = embeddings.localHashingEmbedding;
  const bootstrap = built('electron/architecture/project-bootstrap.js');
  const originalBootstrap = bootstrap.ensureDesktopProjectBootstrap;
  bootstrap.ensureDesktopProjectBootstrap = async () => ({ mode: 'core' });
  const activation = built('electron/architecture/activation.js');
  const project = path.join(scratch, 'project'), memoryDir = path.join(project, '.agentlas');
  fs.mkdirSync(memoryDir, { recursive: true });
  const soul = path.join(memoryDir, 'project-soul-memory.md');
  fs.writeFileSync(soul, '# Project Soul Memory\n\n## Decisions\n- READ ONLY PROJECT MARKER.\n');
  await activation.activateFolder(project, 'Disposable specialist memory project', { permission: 'write' });
  bootstrap.ensureDesktopProjectBootstrap = originalBootstrap;
  const { ScienceStore } = sc('store.js');
  const pins = sc('local-specialist-binding.js');
  sc('host.js').installScienceHost({ RUNTIME_KIND_SET: new Set(['codex']), RUNTIME_BACKEND_SET: new Set(['subscription']),
    currentUiLocale: () => 'en', userDataPath: (...parts) => path.join(user, ...parts) });
  scienceStore = new ScienceStore(path.join(user, 'science.sqlite'));
  const created = scienceStore.createProject({ requestId: id(), question: 'Disposable memory boundary', domain: 'general' });
  const pid = created.project.id, author = created.conversation.id;
  scienceStore.setApprovalPolicy({ requestId: id(), projectId: pid, mode: 'autonomous', scopes: ['full-autonomy'], grantedBy: 'researcher' });
  const expert = id(), director = id(), other = id(), now = new Date().toISOString();
  const packageRoot = path.join(scratch, 'local-expert'); fs.mkdirSync(packageRoot);
  const prompt = 'Inspect only the assigned Source. Return evidence limitations.';
  fs.writeFileSync(path.join(packageRoot, 'agent.md'), prompt);
  for (const agent of [expert, director, other]) desktopDb.prepare(`INSERT INTO installed_agents
    (id,slug,name,tagline,system_prompt,mcp_servers_json,trust_grade,installed_at,tone,env_requirements_json,builtin)
    VALUES (?,?,?,?,?,'[]','A',?,'neutral','[]',0)`).run(agent, agent, 'Fixture actor', 'Fixture', prompt, now);
  const chat = (agentId, title) => { const cid = id(); desktopDb.prepare(`INSERT INTO chats
    (id,agent_id,title,kind,created_at,updated_at,origin_surface) VALUES (?,?,?,'user',?,?,'work')`).run(cid, agentId, title, now, now); return cid; };
  const authorChat = chat(director, 'Disposable author');
  scienceStore.bindConversationRuntime({ requestId: id(), projectId: pid, conversationId: author, runtimeChatId: authorChat });
  const selection = { kind: 'codex', backend: 'subscription', model: 'inert-fixture', source: 'private-contract' };
  const owner = scienceStore.startTurn({ requestId: id(), projectId: pid, conversationId: author, runtimeChatId: authorChat,
    invocationRunId: id(), runtimeSelection: selection, mode: 'append-user-message', content: 'Read assigned Source.' }).turn;
  scienceStore.appendTurnEvent({ requestId: id(), projectId: pid, conversationId: author, turnId: owner.id,
    sequence: owner.lastSequence + 1, kind: 'lifecycle', code: 'invoke-started', payload: {} });
  const bytes = Buffer.from('Disposable exact source bytes.'), source = scienceStore.createSource({ requestId: id(), projectId: pid,
    kind: 'journal-article', canonicalUri: 'https://example.invalid/fixture', title: 'Fixture', authors: [], publicationYear: 2024,
    accessState: 'parsed', mimeType: 'text/plain', contentSha256: sha(bytes), retrievedAt: now, retrievalMethod: 'private-fixture' }, bytes).source;
  const target = sc('research-assistants.js').researchAssistantSourceTarget(scienceStore.getSourceForProject(pid, source.id));
  check(target && target.versionId && target.contentSha256 === sha(bytes), 'assignment derives exact saved Source version pin');
  const route = { agentId: expert, path: packageRoot, runtime: 'generic', labels: ['generic'], kind: 'agent', source: 'local-import', importedAt: now };
  const boundaryReader = built('electron/invocation/effect-boundary-reader.js').readInvocationEffectBoundary;
  const canonical = built('electron/agents/prompt-authority.js');
  const ports = { db: () => desktopDb, route: aid => aid === expert ? route : null, routes: () => [route],
    effectivePrompt: () => canonical.readCanonicalPromptFromDirectory(packageRoot).content, activationReady: () => {},
    task: scope => scienceStore.getAuthorResearchAssistantAssignmentTask({ projectId: scope.projectId, authorConversationId: scope.authorConversationId, taskId: scope.taskId }),
    turn: (p, t) => scienceStore.getTurnForProject(p, t), assertTurn: t => scienceStore.assertScienceTurnExecutionAuthority(t),
    assertAuthor: scope => { if (scienceStore.getResearchAssistantTaskForConversation(scope.projectId, scope.conversationId)) throw Error('helper-cannot-recruit'); },
    stopped: cid => scienceStore.scienceConversationStopped(cid), evict: () => {}, boundary: boundaryReader };
  // Isolate singleton dependencies only; factory, canonical fingerprint and boundary reader are actual production code.
  const originalLoad = Module._load;
  Module._load = function(request, parent, ...rest) {
    if (parent?.filename === path.join(dd, 'electron/science-host/local-specialists.js')) {
      if (request === 'agentlas-science') return { ...pins, scienceStore: () => scienceStore };
      const dependencies = { '../agents/routes': { getRoute: ports.route, listRoutes: ports.routes }, '../agents/files': { buildEffectiveAgentSystemPrompt: ports.effectivePrompt },
        '../agents/workspace-guard': { assertAgentWorkspaceActivationReady: ports.activationReady }, '../store/db': { getDb: ports.db },
        '../store/runtime-sessions': { evictRuntimeSessionsForChat: ports.evict }, '../invocation/effect-boundary-reader': { readInvocationEffectBoundary: boundaryReader } };
      if (dependencies[request]) return dependencies[request];
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  let host; try { host = built('electron/science-host/local-specialists.js').createScienceLocalSpecialistHost(ports); } finally { Module._load = originalLoad; }
  const requester = { projectId: pid, conversationId: author, turnId: owner.id, invocationRunId: owner.invocationRunId };
  const task = scienceStore.admitResearchAssistantSpecialist(
    () => scienceStore.ensureResearchAssistantTask({ requestId: id(), projectId: pid, authorConversationId: author, kind: 'read-source', target, requestedByTurnId: owner.id }),
    task => host.prepare({ requester, scope: pins.specialistScope(task), agentId: expert }));
  const helperChat = chat(director, `⟦science⟧${task.conversationId}`);
  desktopDb.prepare("UPDATE chats SET kind='division',origin_surface='work',working_folder=? WHERE id=?").run(project, helperChat);
  scienceStore.bindConversationRuntime({ requestId: id(), projectId: pid, conversationId: task.conversationId, runtimeChatId: helperChat });
  const turn = scienceStore.startTurn({ requestId: id(), projectId: pid, conversationId: task.conversationId, runtimeChatId: helperChat,
    invocationRunId: id(), runtimeSelection: selection, mode: 'append-user-message', content: 'Read exact task evidence.' }).turn;
  const binding = host.bind({ pin: task.executionAgent, runtimeChatId: helperChat, turnId: turn.id, invocationRunId: turn.invocationRunId });
  const scope = { projectId: pid, conversationId: task.conversationId, turnId: turn.id, invocationRunId: turn.invocationRunId };
  host.assertTurnScope(scope); check(true, 'actual Main current-turn authority admits bound helper');
  check(desktopDb.prepare('SELECT agent_id FROM chats WHERE id=?').get(helperChat).agent_id === expert, 'Main rebinds fixture SQLite chat to exact expert');
  const context = { source: 'science', science: { projectId: pid, researchDirectorAgentId: director, executionAgent: task.executionAgent } };
  const executing = built('electron/memory/invocation-scope.js').invocationMemoryScope(context, director, 'other-project');
  check(executing.agentId === expert && executing.projectId === pid, 'memory identity follows executing expert and Science project');
  const memory = built('electron/memory/store.js');
  for (const [actor, content] of [[expert, 'EXPERT PRIVATE MEMORY MARKER'], [director, 'DIRECTOR PRIVATE MEMORY MARKER'], [other, 'OTHER ACTOR PRIVATE MEMORY MARKER']])
    memory.insertMemoryEntry({ scope: 'agent_repo', kind: 'decision', content, agentId: actor, projectPath: null });
  const reader = built('electron/memory/context.js').buildMemoryContext;
  const safe = built('electron/memory/safe-project-read.js');
  const before = tree(project), activity = desktopDb.prepare('SELECT * FROM folder_activity WHERE path=?').get(project);
  const curatedBefore = desktopDb.prepare('SELECT * FROM memory_entries ORDER BY id').all();
  check(activation.canReadActivatedFolderMemory(project, { permission: 'read' }), 'activated read-only folder can be recalled');
  check(!activation.canReadActivatedFolderMemory(project, { permission: 'read', restrictedReadBoundary: true }), 'restricted read forbids project memory');
  check(!activation.canReadActivatedFolderMemory(project, { permission: 'read', agentAppMode: true }), 'stateless Agent App cannot read mutable project memory');
  const recall = async () => { host.assertCurrent(binding.authority, turn.invocationRunId, helperChat, task.executionAgent);
    return reader(project, executing.agentId, { materializeCodeMap: false, projectId: executing.projectId }); };
  const recalled = await recall();
  check(recalled.includes('READ ONLY PROJECT MARKER'), 'bound specialist receives activated project soul');
  check(recalled.includes('EXPERT PRIVATE MEMORY MARKER'), 'bound specialist receives its own curated memory');
  check(!recalled.includes('DIRECTOR PRIVATE MEMORY MARKER') && !recalled.includes('OTHER ACTOR PRIVATE MEMORY MARKER'), 'Director and other actors remain isolated');
  assert.deepEqual(tree(project), before); checks.push('read recall preserves project bytes and mtimes');
  assert.deepEqual(desktopDb.prepare('SELECT * FROM folder_activity WHERE path=?').get(project), activity); checks.push('read recall preserves activation ledger');
  assert.deepEqual(desktopDb.prepare('SELECT * FROM memory_entries ORDER BY id').all(), curatedBefore); checks.push('read recall preserves curated memory rows');
  check(!fs.existsSync(path.join(memoryDir, 'code-map')), 'read recall never creates Code Map');
  const inactive = path.join(scratch, 'inactive'); fs.mkdirSync(path.join(inactive, '.agentlas'), { recursive: true });
  fs.writeFileSync(path.join(inactive, '.agentlas/project-soul-memory.md'), 'INACTIVE PROJECT MUST NOT ENTER');
  check(!activation.canReadActivatedFolderMemory(inactive, { permission: 'read' }), 'read cannot activate an inactive folder');
  check(!(await reader(inactive, expert, { materializeCodeMap: false })).includes('INACTIVE PROJECT MUST NOT ENTER'), 'inactive soul rejected by production reader');
  const identity = desktopDb.prepare('SELECT * FROM activated_folder_identity WHERE path=?').get(project);
  desktopDb.prepare('DELETE FROM activated_folder_identity WHERE path=?').run(project);
  const missing = await recall();
  check(!missing.includes('READ ONLY PROJECT MARKER') && missing.includes('EXPERT PRIVATE MEMORY MARKER'), 'lost project identity closes project recall while own memory remains');
  desktopDb.prepare('INSERT INTO activated_folder_identity(path,identity_json,captured_at) VALUES(?,?,?)').run(project, identity.identity_json, identity.captured_at);
  fs.symlinkSync(path.join(inactive, '.agentlas/project-soul-memory.md'), path.join(memoryDir, 'linked.md'));
  check(safe.readActivatedProjectMemoryText(project, 'linked.md') === null, 'symlink memory file rejected');
  check(safe.readActivatedProjectMemoryText(project, '../inactive/.agentlas/project-soul-memory.md') === null, 'traversal rejected');
  check(safe.readActivatedProjectMemoryText(project, 'project-soul-memory.md', 4) === null, 'oversized memory fails bounded read');
  fs.unlinkSync(path.join(memoryDir, 'linked.md'));
  const originalSoul = fs.readFileSync(soul), replacement = path.join(memoryDir, 'replacement.md');
  fs.writeFileSync(replacement, 'SWAPPED FILE MUST NOT ENTER');
  safe.setProjectMemoryReadTestHook((_stage, filename) => { if (filename === soul) { safe.setProjectMemoryReadTestHook(null);
    if (process.platform === 'win32') fs.writeFileSync(soul, 'SWAPPED FILE MUST NOT ENTER'); else fs.renameSync(replacement, soul); } });
  check(safe.readActivatedProjectMemoryText(project, 'project-soul-memory.md') === null, 'descriptor/path file swap closes read');
  fs.writeFileSync(soul, originalSoul); safe.setProjectMemoryReadTestHook(null);

  const runner = built('electron/runtime/observed-runner.js');
  const request = { runId: turn.invocationRunId, chatId: helperChat, userPrompt: 'Fixture memory inspection', systemPrompt: recalled,
    locale: 'en', permissions: 'read', workingFolder: project };
  const events = { onPartial: () => {} };
  await rejects(() => runner.runObservedRunner(async () => ({ text: 'Prose claims completed', tokens: 1 }), request, events, 'codex'), error => error.code === 'runtime_turn_unsettled',
    'text-only inert runner rejected without native terminal');
  const native = await runner.runObservedRunner(async () => ({ text: 'Fixture read completed', ownerControlTerminal: 'completed' }), request, events, 'codex');
  check(native.ownerControlTerminal === 'completed' && !native.observedUsage, 'explicit native terminal admitted without invented usage');
  const ledger = built('electron/store/run-events.js');
  const tracker = new (built('electron/invocation/effect-boundary.js').InvocationEffectBoundaryTracker)(turn.invocationRunId, helperChat);
  ledger.recordRunEvent({ runId: turn.invocationRunId, chatId: helperChat, agentId: expert, kind: 'invoke_started', payload: { invocationSource: 'science', permissions: 'read' } });
  tracker.observe({ kind: 'notice', notice: { code: 'runtime-selected' }, runtimeSelection: selection });
  const durable = { id: id() };
  desktopDb.prepare("INSERT INTO chat_messages(id,chat_id,role,text,created_at,speaker_agent_id) VALUES (?,?,'assistant',?,?,?)")
    .run(durable.id, helperChat, native.text, new Date().toISOString(), expert);
  ledger.recordRunEvent({ runId: turn.invocationRunId, chatId: helperChat, agentId: expert, kind: 'mcp_final', payload: { durableMessageId: durable.id } });
  const returned = { pin: task.executionAgent, runtimeChatId: helperChat, turnId: turn.id, invocationRunId: turn.invocationRunId,
    runtimeMessageId: durable.id, rawContentSha256: sha(native.text) };
  throws(() => host.verifyReturn(returned), /effect-unconfirmed/, 'durable final prose alone cannot settle Main return');
  ledger.recordRunEvent({ runId: turn.invocationRunId, chatId: helperChat, agentId: expert, kind: 'invoke_completed', payload: {} });
  throws(() => host.verifyReturn(returned), /effect-unconfirmed/, 'terminal event still needs actual effect boundary');
  const receipt = tracker.persist(), measured = boundaryReader({ invocationRunId: turn.invocationRunId, expectedChatId: helperChat, expectedSource: 'science' });
  check(receipt.effects === 'settled' && measured.effects === 'settled' && measured.terminal, 'actual Main tracker and reader agree on isolated native settlement');
  const accepted = host.verifyReturn(returned);
  check(accepted.runtimeMessageId === durable.id && accepted.rawContentSha256 === sha(native.text) && accepted.scientificVerification === 'unchecked', 'Main exact final backlink closes return without scientific success claim');
  throws(() => host.verifyReturn({ ...returned, rawContentSha256: sha('forged') }), /content-mismatch/, 'wrong returned bytes refused');
  throws(() => host.assertCurrent(binding.authority, turn.invocationRunId, helperChat, { ...task.executionAgent, agentId: other }), /context-pin-mismatch/, 'actor spoof cannot consume bound authority');
  fs.writeFileSync(path.join(packageRoot, 'agent.md'), prompt + ' changed');
  await rejects(recall, /package-changed/, 'changed package revokes memory admission');
  fs.writeFileSync(path.join(packageRoot, 'agent.md'), prompt);
  scienceStore.stopScienceConversation(pid, author);
  await rejects(recall, /scope-stale/, 'author Stop revokes subsequent specialist memory admission');
  console.log(JSON.stringify({ status: 'PASS', checks: checks.length, names: checks, sourceCompilation: 'current private Science+Desktop',
    main: 'actual factory/canonical reader/SQLite/effect tracker/effect reader', nativeRunner: 'deterministic fixture',
    embedding: 'production bounded local hashing adapter fixture', providerModel: 'NOT_RUN', installedApp: 'NOT_RUN',
    originalIgnoredContract: 'UNCHANGED; original historical failure not relabelled' }));
}
main().then(() => { cleanup(); app.exit(0); }).catch(error => { console.error(error); cleanup(); app.exit(1); });
