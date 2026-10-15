'use strict';
// Current metadata readers/Main registration against disposable files and SQLite.
// No installed app, provider, model, source package import, auth or user DB.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto'), Module = require('node:module'), ts = require('typescript');
const repo = path.resolve(__dirname, '..'), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'science-catalog-contract-'));
const sha = b => createHash('sha256').update(b).digest('hex');
let checks = 0;
function check(value, name) { assert.ok(value, name); checks++; }
function reject(fn, pattern, name) { assert.throws(fn, pattern, name); checks++; }
async function refuse(fn, pattern, name) { await assert.rejects(fn, pattern, name); checks++; }
function load(relative, intercept = {}) {
  const filename = path.join(repo, relative), source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename, reportDiagnostics: true });
  assert.equal(output.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const compiled = new Module(filename);
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const normalRequire = compiled.require.bind(compiled);
  compiled.require = name => Object.hasOwn(intercept, name) ? intercept[name] : normalRequire(name);
  compiled._compile(output.outputText, filename);
  return compiled.exports;
}
const { createScienceCapabilityCatalog, readScientificSkillCatalogMetadata, registerScienceCapabilityCatalogIpc } = load('electron/science-host/capability-catalog.ts');
const { readMcpManagementInventory } = load('shared/mcp-inventory-refresh.ts');
const { appControlPolicy } = load('electron/app-control/policy.ts');
const Database = require('better-sqlite3'), db = new Database(':memory:');
const library = path.join(temporary, 'dist/plugins/agentlas-science-skills');
const index = { schema: 'agentlas.science-skill-index/v3', count: 3, skills: [
  { name: 'zeta', description: 'Protein workflow' }, { name: 'alpha', description: '<safe> data work', sidecar: 'NEVER_READ' },
  { name: 'beta', description: 'Protein method' }] };
function writeLibrary() {
  fs.mkdirSync(path.join(library, 'schemas'), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(index));
  fs.writeFileSync(path.join(library, 'schemas/skill-index.json'), bytes);
  fs.writeFileSync(path.join(library, 'plugin.json'), JSON.stringify({ slug: 'agentlas-science-skills', integrity: { files: [
    { path: 'schemas/skill-index.json', bytes: bytes.length, sha256: sha(bytes) }] } }));
}
writeLibrary();
db.exec(`CREATE TABLE mcp_servers(id TEXT,name TEXT,name_en TEXT,catalog_id TEXT,transport TEXT,enabled INTEGER,
  command TEXT,args_json TEXT,url TEXT,env_keys_json TEXT);
CREATE TABLE installed_agents(id TEXT,slug TEXT,name TEXT,builtin INTEGER);`);
const insert = db.prepare('INSERT INTO mcp_servers VALUES(?,?,?,?,?,?, ?,?,?,?)');
insert.run('skills', '스킬', 'Scientific Skills', 'agentlas-science-skills', 'stdio', 1, 'PRIVATE_COMMAND', 'PRIVATE_ARGS', 'PRIVATE_URL', 'PRIVATE_ENV_NAMES');
insert.run('disabled', '꺼짐', 'Off connector', 'custom', 'http', 0, 'PRIVATE_COMMAND', 'PRIVATE_ARGS', 'PRIVATE_URL', 'PRIVATE_ENV_NAMES');
insert.run('host', 'Science', 'Science', 'agentlas-science', 'http', 1, null, null, null, null);
const putAgent = db.prepare('INSERT INTO installed_agents VALUES(?,?,?,?)');
putAgent.run('expert & 1', 'own-expert', 'Own expert', 0); putAgent.run('gone', 'gone', 'Missing expert', 0);
putAgent.run('team', 'team', 'Team', 0); putAgent.run('director', 'director', 'Director', 1);
const routes = [{ agentId: 'expert & 1', kind: 'agent', source: 'local-import' }, { agentId: 'gone', kind: 'agent', missingSince: 'fixture' },
  { agentId: 'team', kind: 'team', source: 'hub' }];
const handlers = new Map(), navigation = [], permissions = [];
let live = true, appControl = false, destroyed = false, revokeAfterRead = false;
const frame = {}, event = { sender: { id: 7, mainFrame: frame, isDestroyed: () => destroyed }, senderFrame: frame };
const mainSource = fs.readFileSync(path.join(repo, 'electron/main.ts'), 'utf8');
const ast = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
let registration;
function visit(node) { if (ts.isCallExpression(node) && node.expression.getText(ast) === 'registerScienceCapabilityCatalogIpc') registration = node;
  ts.forEachChild(node, visit); }
visit(ast); assert.ok(registration);
const registrationJS = ts.transpileModule(registration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS } }).outputText;
new Function('registerScienceCapabilityCatalogIpc', 'createScienceCapabilityCatalog', 'readScientificSkillCatalogMetadata', 'path', '__dirname',
  'getDb', 'listScienceCapabilityAgentRoutes', 'ipcMain', 'isAppControlEvent', 'isScienceExtensionViewSender', 'assertScienceSender', 'mainWindow', registrationJS)(
  registerScienceCapabilityCatalogIpc, createScienceCapabilityCatalog, readScientificSkillCatalogMetadata, path, path.join(temporary, 'dist/electron'),
  () => db, () => routes, { handle: (channel, fn) => handlers.set(channel, fn) }, () => appControl, () => live,
  (_event, _envelope, permission) => { permissions.push(permission); if (!live) throw Error('view-revoked');
    if (revokeAfterRead) { revokeAfterRead = false; queueMicrotask(() => { live = false; }); } },
  { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => navigation.push(args) }, show() {}, focus() {} });
const catalogHandler = handlers.get('science:researchCapabilities:catalog'), managerHandler = handlers.get('science:shell:openCapabilityManager');
const request = input => catalogHandler(event, { extensionId: 'agentlas-science', input });
const manage = input => managerHandler(event, { extensionId: 'agentlas-science', input });
async function main() {
  try {
    const first = await request({ kind: 'skills', limit: 2 });
    check(first.total === 3 && first.query === '' && first.items.map(r => r.id).join(',') === 'alpha,beta' && first.nextOffset === 2,
      'actual Main bundled path yields bounded stable metadata page');
    check(permissions.every(v => v === 'science:agent-runtime'), 'Main uses signed runtime view permission before and after read');
    check(first.items.every(r => r.registration === 'enabled' && r.execution === 'on-demand') && !JSON.stringify(first).includes('NEVER_READ'),
      'index metadata does not expose sidecar or claim loading/execution');
    const next = await request({ kind: 'skills', offset: 2, limit: 2, expectedCatalogSha256: first.catalogSha256 });
    check(next.items[0].id === 'zeta' && next.nextOffset === null, 'same generation closes final page exactly');
    const filtered = await request({ kind: 'skills', query: ' PROTEIN ' });
    check(filtered.query === 'protein' && filtered.total === 2, 'query canonicalization and search agree');
    await refuse(() => request({ kind: 'skills', offset: 2 }), /page-invalid/, 'later page requires observed generation');
    await refuse(() => request({ kind: 'skills', offset: 4, expectedCatalogSha256: first.catalogSha256 }), /page-invalid/, 'out-of-range page denied');
    await refuse(() => request({ kind: 'skills', limit: 61 }), /page-invalid/, 'unbounded page denied');
    await refuse(() => request({ kind: 'skills', query: 'x'.repeat(161) }), /input-invalid/, 'overlong query denied');
    await refuse(() => request({ kind: 'skills', projectId: 'fake-author-grant' }), /input-invalid/, 'GUI catalog refuses execution scope fields');
    db.prepare("UPDATE mcp_servers SET enabled=0 WHERE id='skills'").run();
    await refuse(() => request({ kind: 'skills', offset: 2, expectedCatalogSha256: first.catalogSha256 }), /catalog-changed/, 'changed provider registration invalidates prior page');
    const connectors = await request({ kind: 'connectors' });
    check(connectors.total === 2 && connectors.items.every(r => r.execution === 'unknown' && r.registration === 'disabled'),
      'enabled metadata remains distinct from live connector readiness and omits host');
    check(!JSON.stringify(connectors).includes('PRIVATE_'), 'actual Main SQL excludes commands arguments URLs and env names');
    const specialists = await request({ kind: 'specialists' });
    check(specialists.total === 2 && specialists.items.find(r => r.id === 'gone').registration === 'source-unavailable',
      'registered agents are candidates; builtin Director and teams remain distinct');
    check((await manage({ manager: 'specialist-files', agentId: 'expert & 1' })).route === '/library/agents?agentId=expert%20%26%201&tab=files',
      'owner file editor retains exact encoded agent ID');
    check((await manage({ manager: 'specialist-build' })).route === '/build', 'specialist builder is owner navigation only');
    check((await manage({ manager: 'connector-library' })).route === '/library/mcps?observe=1', 'connector manager uses passive entry');
    await refuse(() => manage({ manager: 'specialist-files', agentId: 'director' }), /not-registered/, 'Director cannot be selected as Specialist editor target');
    await refuse(() => manage({ manager: 'https://arbitrary.example' }), /manager-invalid/, 'arbitrary navigation denied');
    const before = navigation.length;
    await refuse(() => manage({ manager: 'specialist-build', agentId: 'expert & 1' }), /manager-invalid/, 'builder request does not carry actor grant');
    check(navigation.length === before, 'rejected manager does not navigate');
    appControl = true;
    await refuse(() => request({ kind: 'connectors' }), /view-required/, 'App Control cannot impersonate visible GUI'); appControl = false;
    await refuse(() => catalogHandler({ ...event, senderFrame: {} }, { extensionId: 'agentlas-science', input: { kind: 'skills' } }), /view-required/, 'subframe denied');
    await refuse(() => catalogHandler(event, { extensionId: 'foreign', input: { kind: 'skills' } }), /view-required/, 'foreign extension denied');
    await refuse(() => catalogHandler(event, { extensionId: 'agentlas-science', input: { kind: 'skills' }, grant: true }), /input-invalid/, 'unknown envelope denied');
    destroyed = true; await refuse(() => request({ kind: 'skills' }), /view-required/, 'destroyed view denied'); destroyed = false;
    revokeAfterRead = true; await refuse(() => request({ kind: 'skills' }), /view-required|view-revoked/, 'navigation during read revokes response'); live = true;
    check(!appControlPolicy({ path: 'science.researchCapabilities.catalog' }).allowed
      && !appControlPolicy({ path: 'science.shell.openCapabilityManager' }).allowed, 'App Control policy denies both GUI-only channels');
    fs.appendFileSync(path.join(library, 'schemas/skill-index.json'), ' ');
    reject(() => readScientificSkillCatalogMetadata(library), /pin-mismatch/, 'modified index fails release byte/hash pin'); writeLibrary();
    const indexFile = path.join(library, 'schemas/skill-index.json'); fs.renameSync(indexFile, `${indexFile}.saved`); fs.symlinkSync(`${indexFile}.saved`, indexFile);
    reject(() => readScientificSkillCatalogMetadata(library), /file-invalid/, 'symlink metadata index denied'); fs.unlinkSync(indexFile); fs.renameSync(`${indexFile}.saved`, indexFile);
    const actual = readScientificSkillCatalogMetadata(path.join(repo, 'plugins/agentlas-science-skills'));
    check(actual.skills.length > 0 && /^[a-f0-9]{64}$/.test(actual.indexSha256), 'current shipped source manifest/index passes own declared pins');
    let probes = 0, reads = 0;
    const inventoryPorts = { listInstalled: async () => { reads++; return [{ id: 'fixture' }]; }, status: async () => { probes++; return [{ connected: false }]; } };
    const passive = await readMcpManagementInventory(inventoryPorts, false);
    check(reads === 1 && probes === 0 && passive[1] === null, 'passive management does not call provider status');
    const normal = await readMcpManagementInventory(inventoryPorts, true);
    check(reads === 2 && probes === 1 && normal[1].length === 1, 'explicit management check retains status probe');
    await refuse(() => readMcpManagementInventory({ ...inventoryPorts, listInstalled: async () => { throw Error('fixture-read-failed'); } }, false),
      /fixture-read-failed/, 'metadata read failure propagates without empty/success fallback');
    let effects = [], brands = 0;
    const react = { useState: initial => [initial, () => {}], useEffect: fn => effects.push(fn), createElement: () => ({}) };
    const logos = load('renderer/components/PluginLogo.tsx', { react, 'react/jsx-runtime': { jsx: () => ({}), jsxs: () => ({}) },
      '@/lib/ipc': { ipc: () => ({ mcpTools: { brandMap: async () => { brands++; return {}; } } }) } });
    const flushEffects = async () => { const active = effects; effects = []; active.forEach(fn => fn()); await Promise.resolve(); };
    logos.usePluginBrandMap({ enabled: false }); await flushEffects();
    check(brands === 0, 'passive branding hook does not request Hub cache/network');
    logos.PluginLogo({ name: 'fixture', brandMap: {} }); await flushEffects();
    check(brands === 0, 'supplied passive map prevents child logo own auto-request');
    logos.usePluginBrandMap({ enabled: true }); await flushEffects();
    check(brands === 1, 'explicit enabled branding retains shared Hub cache request');
    const page = fs.readFileSync(path.join(repo, 'renderer/app/(shell)/library/mcps/page.tsx'), 'utf8');
    check(page.includes('key={passiveEntry ? "observe" : "manage"}') && page.includes('useState(!passiveEntry)')
      && page.includes('usePluginCatalog({ enabled: catalogRequested })') && page.includes('usePluginBrandMap({ enabled: catalogRequested })')
      && page.includes('readMcpManagementInventory(api.mcpTools, probeStatus)'), 'owner route source wires keyed passive inventory/catalog/branding state');
    console.log(JSON.stringify({ status: 'PASS', checks, sources: 'current transpiled modules plus actual Main registration',
      storage: 'disposable SQLite and pinned metadata files', gui: 'hook fixtures; not installed DOM', providerModel: 'NOT_RUN', installedApp: 'NOT_RUN' }, null, 2));
  } finally { db.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
