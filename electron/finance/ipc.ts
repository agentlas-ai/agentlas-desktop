import { BrowserWindow, dialog, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateFinanceWorkspace, FinanceDataSaveRequestSchema, type FinanceWorkspace } from '../../shared/finance';
import { getAuthenticatedSessionBinding, onAuthSessionOwnershipChanged } from '../auth';
import { userDataPath } from '../runtime-paths';
import { createWorkStart } from '../work-start';
import { detectRuntimes } from '../runtime/detect';
import { FinanceStore, type FinanceScope } from './store';
import { queryFinanceData, refreshFinanceQuotes } from './data';
import { financeResearchPrompt } from './prompts';
import { captureFinanceScope, getFinanceService } from './service';
import { financeWorkProject } from './work-project';
import { onFinanceWorkspaceChange } from './events';
import { FinanceArchiveRequestSchema } from './archive';
import { financeDataConnection } from './connections';
import { financeExperience, requireFinanceConsent } from './experience';
import { clearFinanceWorldMarketsCache, getFinanceWorldMarkets } from './world-markets';
import { clearFinanceDashboardFeedCache } from './dashboard-feeds';
import { resolveFinanceDataSource } from '../../shared/finance-data-routing';
import { pauseFinanceMonitor, readFinanceMonitor, rollbackFinanceMonitor, scheduleFinanceMonitor } from './monitor';
import { FinancePortfolioRequestSchema } from '../../shared/finance-portfolio';
import { extractFinancePortfolio, saveFinancePortfolio } from './portfolio';
import { financeBuiltinPlugin } from './builtin-plugin';
import { FINANCE_NOTICE_VERSION } from '../../shared/finance-experience';
import type { FinancePlanningResult } from '../../shared/finance-planning';
import { FinancePlanningReviews } from './planning-review';

const boundedId = z.string().min(1).max(200);
function captureScope(): FinanceScope {
  const captured = getAuthenticatedSessionBinding();
  if (!captured) throw new Error('finance_sign_in_required');
  return { workspaceId: captured.workspaceId, userId: captured.userId, assertCurrent() {
    const current = getAuthenticatedSessionBinding();
    if (!current || current.sessionId !== captured.sessionId || current.workspaceId !== captured.workspaceId || current.userId !== captured.userId) throw new Error('finance_account_changed');
  } };
}
export function registerFinanceIpc(input: { ipc: Pick<IpcMain, 'handle'>; assertTrustedSender(event: IpcMainInvokeEvent): void }): void {
  const service = getFinanceService();
  const store = service.store;
  const planningReviews=new FinancePlanningReviews();
  const running = new Map<string, { controller: AbortController; senderId: number }>();
  onAuthSessionOwnershipChanged(() => { for (const item of running.values()) item.controller.abort(); running.clear(); clearFinanceWorldMarketsCache(); clearFinanceDashboardFeedCache(); });
  const load = (scope: FinanceScope) => service.load(scope);
  const handle = (name: string, fn: (event: IpcMainInvokeEvent, raw: unknown, scope: FinanceScope) => unknown) => input.ipc.handle(`finance:${name}`, (event, raw) => { input.assertTrustedSender(event); return fn(event, raw, captureScope()); });
  handle('load', (_event, _raw, scope) => load(scope));
  handle('workProject', async(_event, raw, originalScope) => {
    z.union([z.undefined(), z.object({}).strict()]).parse(raw);
    originalScope.assertCurrent();
    const scope = await captureFinanceScope();
    originalScope.assertCurrent();
    await requireFinanceConsent(scope); scope.assertCurrent();
    const result = financeWorkProject(scope); scope.assertCurrent(); return result;
  });
  handle('planning', async(_event, raw, scope) => { await requireFinanceConsent(scope);scope.assertCurrent();const plugin=await financeBuiltinPlugin().runtime(scope,FINANCE_NOTICE_VERSION);scope.assertCurrent();const result=plugin.callPureTool('planning',raw) as FinancePlanningResult;scope.assertCurrent();planningReviews.record(scope,raw);return result; });
  handle('analysts', (_event, raw, scope) => service.analysts(scope, raw as import('../../shared/finance-analysts').FinanceAnalystRequest));
  handle('portfolio', async(event, raw, scope) => {
    const request=FinancePortfolioRequestSchema.parse(raw);
    if(request.action==='save'){await requireFinanceConsent(scope);scope.assertCurrent();return saveFinancePortfolio(store,scope,request);}
    const key=`${event.sender.id}:${request.requestId}`;
    if(running.has(key)||[...running.values()].filter(item=>item.senderId===event.sender.id).length>=2)throw new Error('finance_request_busy');
    const controller=new AbortController();running.set(key,{controller,senderId:event.sender.id});
    const onDestroyed=()=>controller.abort();event.sender.once('destroyed',onDestroyed);
    try{await requireFinanceConsent(scope);scope.assertCurrent();controller.signal.throwIfAborted();const workflow=await financeBuiltinPlugin().workflow(scope,FINANCE_NOTICE_VERSION,'portfolio');scope.assertCurrent();controller.signal.throwIfAborted();return await extractFinancePortfolio(request,controller.signal,()=>scope.assertCurrent(),undefined,workflow);}
    finally{event.sender.removeListener('destroyed',onDestroyed);running.delete(key);}
  });
  handle('experience', (_event, raw, scope) => financeExperience(scope, raw as import('../../shared/finance-experience').FinanceExperienceRequest));
  handle('worldMarkets', async (_event, _raw, scope) => {
    const selection = await requireFinanceConsent(scope); scope.assertCurrent();
    const sourceId=resolveFinanceDataSource(selection,'market');
    return getFinanceWorldMarkets({scope,sourceId});
  });
  handle('dashboardFeeds', (_event, _raw, scope) => service.dashboardFeeds(scope));
  handle('dataConnection', async (_event, raw, scope) => {
    const request=z.object({ action: z.enum(['status', 'test']) }).strict().parse(raw);
    if(request.action==='test')await requireFinanceConsent(scope);
    return financeDataConnection(request, { assertCurrent: scope.assertCurrent });
  });
  handle('save', async(_event, raw, scope) => {
    const arg = z.object({ workspace: z.unknown(), expectedRevision: z.number().int().nonnegative() }).strict().parse(raw);
    return service.save(scope,{ workspace: validateFinanceWorkspace(arg.workspace), expectedRevision: arg.expectedRevision });
  });
  handle('search', async(_event, raw, scope) => {
    const arg = z.object({ query: z.string().min(1).max(200) }).strict().parse(raw);
    const result = await service.search(scope,arg); scope.assertCurrent(); return result;
  });
  handle('queryData', async(_event, raw, scope) => {
    const route={...await requireFinanceConsent(scope),assertCurrent:()=>scope.assertCurrent()};
    const arg = z.object({ query: z.string().max(2000), assetIds: z.array(boundedId).max(10), metrics: z.array(z.string().max(80)).max(10), period: z.string().max(80) }).strict().parse(raw);
    const workspace = await store.load(scope); scope.assertCurrent();
    const result = await queryFinanceData(arg, workspace.watchlist,route); scope.assertCurrent(); return result;
  });
  handle('refreshQuotes', async(_event, _raw, scope) => {
    const route={...await requireFinanceConsent(scope),assertCurrent:()=>scope.assertCurrent()};
    const workspace = await store.load(scope); scope.assertCurrent();
    const result = await refreshFinanceQuotes(workspace,route); scope.assertCurrent();
    if ((await store.load(scope)).revision !== workspace.revision) return { baseRevision: workspace.revision, status: 'conflict', message: 'The workspace changed while quotes were loading. Refresh again.', operations: [] };
    return result;
  });
  // The Finance conversation is a Work chat in the owner's Finance Work project (FinanceWorkChat, finance:workProject): it runs
  // through the shared invocation service and runner like every Work turn. There is no second Finance-only model loop here.
  // Cancellation is unconditional with respect to auth, revisions and request completion.
  input.ipc.handle('finance:cancelAsk', (event, raw) => {
    input.assertTrustedSender(event); const arg = z.object({ requestId: boundedId }).strict().parse(raw);
    const item = running.get(`${event.sender.id}:${arg.requestId}`); item?.controller.abort(); return { cancelled: Boolean(item) };
  });
  handle('startResearch', async(_event, raw, scope) => {
    await requireFinanceConsent(scope);
    const arg = z.object({ assetId: boundedId, question: z.string().max(20000).optional() }).strict().parse(raw);
    const workspace = await store.load(scope); scope.assertCurrent(); const asset = workspace.watchlist.find(item => item.id === arg.assetId);
    if (!asset) throw new Error('finance_asset_not_found');
    // Research runs as a Work chat in the owner's Finance Work project, so it is a Finance conversation like any other:
    // the Finance tools, the finance.chat line and the owner fence come from the stored project binding (mcp/client.ts).
    const { projectId } = financeWorkProject(scope); scope.assertCurrent();
    const receipt = await createWorkStart({ intentId: randomUUID(), prompt: financeResearchPrompt(asset, arg.question ?? ''), projectId, options: { permissions: 'read' } }, async() => { const runtimes = await detectRuntimes(); scope.assertCurrent(); return runtimes; });
    scope.assertCurrent(); return { chatId: receipt.chatId, intentId: receipt.intentId, status: receipt.status };
  });
  for (const action of ['scheduleMonitor','pauseMonitor'] as const) handle(action,async(_event,raw,scope)=>{
    if(action==='scheduleMonitor')return service.schedule(scope,z.object({monitorId:boundedId,scheduleHuman:z.enum(['daily-09:00','weekday-09:00','hourly','every-5m'])}).strict().parse(raw));
    return service.pause(scope,z.object({monitorId:boundedId}).strict().parse(raw));
  });
  handle('queryAndSave',async(_event,raw,scope)=>{await requireFinanceConsent(scope);return service.queryAndSave(scope,FinanceDataSaveRequestSchema.parse(raw));});
  handle('runMonitor',async(_event,raw,scope)=>service.runMonitor(scope,z.object({monitorId:boundedId}).strict().parse(raw)));
  handle('monitorRuns',async(_event,raw,scope)=>service.monitorRuns(scope,z.object({monitorId:boundedId,cursor:z.string().min(1).max(2000).optional(),limit:z.number().int().min(1).max(50).optional()}).strict().parse(raw)));
  handle('archives',async(_event,raw,scope)=>service.archives(scope,FinanceArchiveRequestSchema.parse(raw)));
  const broadcast=(change:{ownerScope:string;revision:number})=>{
    let current:FinanceScope;try{current=captureScope();}catch{return;}
    const ownerScope=createHash('sha256').update(JSON.stringify([current.workspaceId,current.userId])).digest('hex');
    if(change.ownerScope!==ownerScope)return;
    for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send('finance:changed',change);
  };
  onFinanceWorkspaceChange(broadcast);
  // A daemon's @finance tool writes the same atomic store; a Main observer forwards the committed revision.
  const workspaceRoot=userDataPath('finance','workspaces');fs.mkdirSync(workspaceRoot,{recursive:true,mode:0o700});
  let refreshTimer:ReturnType<typeof setTimeout>|undefined;
  try{const watcher=fs.watch(workspaceRoot,{recursive:true},(_event,name)=>{if(!name?.toString().endsWith('workspace.json'))return;if(refreshTimer)clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{let scope:FinanceScope;try{scope=captureScope();}catch{return;}void store.load(scope).then(workspace=>{scope.assertCurrent();if(workspace.ownerScope)broadcast({ownerScope:workspace.ownerScope,revision:workspace.revision});}).catch(()=>undefined);},80);});watcher.unref();}catch{ /* Same-host events remain available; polling/reopening reads canonical state. */ }
  handle('exportFile', async(event, raw, scope) => {
    const arg = z.object({ filename: z.string().min(1).max(200), content: z.string().max(16000000), mimeType: z.enum(['text/markdown', 'text/plain', 'text/csv', 'application/json', 'text/html']), ownerScope: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
    if ((await store.load(scope)).ownerScope !== arg.ownerScope) throw new Error('finance_owner_scope_mismatch');
    scope.assertCurrent();
    const extensions: Record<string, string[]> = { 'text/markdown': ['md'], 'text/plain': ['txt'], 'text/csv': ['csv'], 'application/json': ['json'], 'text/html': ['html'] };
    const ext = extensions[arg.mimeType];
    const filename = path.basename(arg.filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const options = { title: 'Export Finance file', defaultPath: ext.some(extension => filename.endsWith(`.${extension}`)) ? filename : `${filename}.${ext[0]}`, filters: [{ name: 'Finance document', extensions: ext }] };
    const owner = BrowserWindow.fromWebContents(event.sender); const chosen = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    scope.assertCurrent(); if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true };
    const bytes = Buffer.from(arg.content, 'utf8'); if (bytes.length > 24 * 1024 * 1024) throw new Error('finance_export_too_large');
    const temporary = path.join(path.dirname(chosen.filePath), `.finance-export-${randomUUID()}.tmp`);
    try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); scope.assertCurrent(); fs.renameSync(temporary, chosen.filePath); }
    catch (error) {
      // Windows: Excel keeps an open file locked (EBUSY/EPERM). Say so instead of a raw errno (Windows audit fs.md #22).
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw new Error('finance_export_file_locked: the file is open in another program. Close it and export again.');
      throw error;
    }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    const sha256 = createHash('sha256').update(fs.readFileSync(chosen.filePath)).digest('hex');
    if (sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('finance_export_readback_mismatch');
    const receipt = { ok: true, path: chosen.filePath, sha256, bytes: bytes.length, savedAt: new Date().toISOString() };
    const partition = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.userId])).digest('hex');
    const receiptDir = userDataPath('finance', 'exports', partition);
    try { fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(receiptDir, `${randomUUID()}.json`), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }); }
    catch { return { ...receipt, error: 'The file was saved, but its local export receipt could not be retained.' }; }
    return receipt;
  });
}
