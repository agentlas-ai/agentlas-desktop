import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userDataPath } from './runtime-paths';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import type { WorkStartAPI, WorkStartInput, WorkStartOptions, WorkStartReceipt } from '../shared/work-start';
import type { RuntimeSelection, RuntimeStatus } from '../shared/types';
import { getDb } from './store/db';
import { createProject, getProject, updateProject } from './store/projects';
import { createChat, getChat, normalizeChatRuntimeSelection, setChatRuntimeSelection, setChatWorkingFolder } from './store/chats';
import { normalizeRuntimeSelectionInput, runtimeMatchesSelection, selectionForRuntime } from '../shared/runtime-selection';
import { getCanonicalTaskForChat } from './store/tasks';
import { listInstalledAgentsReadOnly } from './mcp/registry';
import { detectRuntimes } from './runtime/detect';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = { intent_id: string; input_digest: string; project_id: string; chat_id: string; task_id: string; prompt_text: string; options_json: string; runtime_selection_json: string; status: WorkStartReceipt['status']; claim_token: string | null; error_code: string | null };
function receipt(row: Row): WorkStartReceipt { return { intentId: row.intent_id, inputDigest: row.input_digest, projectId: row.project_id, chatId: row.chat_id, taskId: row.task_id, prompt: row.prompt_text, options: JSON.parse(row.options_json), runtimeSelection: JSON.parse(row.runtime_selection_json), status: row.status, errorCode: row.error_code }; }
function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('work_start_input_invalid'); }
export function normalizeWorkStartInput(input: WorkStartInput): WorkStartInput { return normalize(input); }
function normalize(input: WorkStartInput): WorkStartInput {
  exactKeys(input, ['intentId','prompt','projectId','runtimeSelection','options']);
  if (!UUID.test(input.intentId) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 250_000 || input.prompt.includes('\0') || input.projectId !== undefined && !UUID.test(input.projectId)) throw new Error('work_start_input_invalid');
  const options = input.options ?? {}; exactKeys(options, ['permissions','planMode','goalMode','appsGenerateMode','sessionRouting','stormbreakerMode','images','files','taskForceTargets']);
  if (options.permissions !== undefined && !['read','write','full'].includes(String(options.permissions))) throw new Error('work_start_permission_invalid');
  for (const key of ['planMode','goalMode','appsGenerateMode','sessionRouting','stormbreakerMode']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('work_start_options_invalid');
  for (const key of ['images','files','taskForceTargets']) if (options[key] !== undefined && (!Array.isArray(options[key]) || options[key].length > 32)) throw new Error('work_start_attachments_invalid');
  if (JSON.stringify(options).length > 32_000_000) throw new Error('work_start_attachments_too_large');
  // ★2026-09-23 — 이 허용 목록이 acpAgentId·label 을 몰라 ACP 엔진으로는 Work 를 시작할 수 없었다.
  //   RuntimeSelection 을 받는 모든 Main 경계는 공용 정규화기 하나를 쓴다("" = 없음).
  if (input.runtimeSelection !== undefined) normalizeRuntimeSelectionInput(input.runtimeSelection, { roles: ['orchestrator'], allowInherit: false });
  return { ...input, options: { ...options, sessionRouting: true } as WorkStartOptions };
}
function canonical(value: unknown): string { if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']'; if (value && typeof value === 'object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value); }
/**
 * The stored pin is exactly what the chat store will read back (normalizeChatRuntimeSelection),
 * so the claim-time comparison cannot diverge on "" vs absent or on the ACP seat/label.
 * A requested "" model/effort is the picker's explicit "engine default" and stays absent.
 */
function pin(runtime: RuntimeStatus, selection?: RuntimeSelection): RuntimeSelection {
  const built = selectionForRuntime(runtime, {
    model: selection && selection.model !== undefined ? selection.model : undefined,
    effort: selection && selection.effort !== undefined ? selection.effort : undefined,
    longContext: selection?.longContext ?? runtime.longContextEnabled ?? false,
    role: 'orchestrator', inherit: false,
  });
  const normalized = normalizeChatRuntimeSelection(built);
  if (!normalized) throw new Error('work_start_runtime_unavailable');
  return normalized;
}
/** Contract seam: the exact pin createWorkStart stores and claimWorkStart compares. */
export const workStartRuntimePin = pin;
export function storedWorkStartPin(json: string): RuntimeSelection | null { return storedPin(json); }
function storedPin(json: string): RuntimeSelection | null { try { return normalizeChatRuntimeSelection(JSON.parse(json)); } catch { return null; } }
function owned(intentId: string, chatId: string): Row {
  if (!UUID.test(intentId) || !UUID.test(chatId)) throw new Error('work_start_scope_invalid');
  const row = getDb().prepare('SELECT * FROM work_start_intents WHERE intent_id=? AND chat_id=?').get(intentId,chatId) as Row | undefined;
  const chat = row && getChat(chatId); const task = row && getCanonicalTaskForChat(chatId);
  if (!row || !chat || chat.projectId !== row.project_id || chat.originSurface !== 'work' || task?.id !== row.task_id) throw new Error('work_start_target_unavailable');
  return row;
}
/** Only persists local project/chat/task intent. Actual provider execution stays in the existing Work send authority. */
export async function createWorkStart(raw: WorkStartInput, detect = detectRuntimes): Promise<WorkStartReceipt> {
  const input=normalize(raw), digest=createHash('sha256').update(canonical(input)).digest('hex'),db=getDb();
  const prior=db.prepare('SELECT * FROM work_start_intents WHERE intent_id=?').get(input.intentId) as Row | undefined;
  if (prior) { if (prior.input_digest !== digest) throw new Error('work_start_intent_conflict');return receipt(owned(input.intentId,prior.chat_id)); }
  const runtimes=await detect();const requested=input.runtimeSelection?normalizeRuntimeSelectionInput(input.runtimeSelection):undefined;
  const runtime=requested ? runtimes.find(r=>runtimeMatchesSelection(r,requested)) : runtimes.find(r=>r.active);
  if (!runtime || runtime.credentialAccess?.status === 'unavailable' || runtime.signInRequired) throw new Error('work_start_runtime_unavailable');
  const selection=pin(runtime,input.runtimeSelection);
  const controller=listInstalledAgentsReadOnly().find(a=>a.slug==='agentlas-orchestrator');if (!controller) throw new Error('work_start_orchestrator_unavailable');
  let createdFolder: string | null = null;
  try { return db.transaction(()=>{
    const replay=db.prepare('SELECT * FROM work_start_intents WHERE intent_id=?').get(input.intentId) as Row | undefined;
    if (replay) { if (replay.input_digest !== digest) throw new Error('work_start_intent_conflict');return receipt(owned(input.intentId,replay.chat_id)); }
    const title=input.prompt.replace(/\s+/g,' ').trim().slice(0,80);
    const project=input.projectId ? getProject(input.projectId) : createProject({name:title,sourceType:'local',agentPool:[]});
    if (!project) throw new Error('work_start_project_unavailable');
    let folder = project.folderPath;
    if (!folder) {
      if (project.sourceType !== 'local' || project.sourceRef) throw new Error('work_start_project_folder_unavailable');
      folder = userDataPath('workspaces','projects',project.id);
      fs.mkdirSync(path.dirname(folder), { recursive: true, mode: 0o700 });
      try { fs.mkdirSync(folder, { mode: 0o700 }); createdFolder = folder; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const metadata=fs.lstatSync(folder);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('work_start_project_folder_unavailable');
      updateProject(project.id,{folderPath:folder});
    } else if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('work_start_project_folder_unavailable');
    const chat=createChat({projectId:project.id,agentId:controller.id,title,taskMode:'task',originSurface:'work'});
    if (chat.agentId!==controller.id) throw new Error('work_start_controller_mismatch');
    setChatRuntimeSelection(chat.id,selection);setChatWorkingFolder(chat.id,folder);
    const task=getCanonicalTaskForChat(chat.id);if(!task)throw new Error('work_start_task_unavailable');
    const now=new Date().toISOString();
    db.prepare("INSERT INTO work_start_intents(intent_id,input_digest,project_id,chat_id,task_id,prompt_text,options_json,runtime_selection_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)").run(input.intentId,digest,project.id,chat.id,task.id,input.prompt,JSON.stringify(input.options),JSON.stringify(selection),now,now);
    return receipt(owned(input.intentId,chat.id));
  }).immediate(); } catch(error) {
    // Remove only the new empty directory created by this rolled-back intent. Never recurse or touch a user folder.
    if(createdFolder){try{fs.rmdirSync(createdFolder);}catch{/* nonempty or externally changed content is preserved */}}
    throw error;
  }
}
export function getWorkStart(input: Parameters<WorkStartAPI['get']>[0]): WorkStartReceipt { exactKeys(input,['intentId','chatId']);return receipt(owned(input.intentId,input.chatId)); }
export function claimWorkStart(input: Parameters<WorkStartAPI['claim']>[0]): { receipt: WorkStartReceipt; claimToken: string | null } {
  exactKeys(input,['intentId','chatId']);return getDb().transaction(()=>{ const row=owned(input.intentId,input.chatId);if(row.status!=='queued')return {receipt:receipt(row),claimToken:null};if(canonical(getChat(input.chatId)?.runtimeSelection)!==canonical(storedPin(row.runtime_selection_json)))throw new Error('work_start_runtime_binding_changed');const token=randomUUID();getDb().prepare("UPDATE work_start_intents SET status='claimed',claim_token=?,updated_at=? WHERE intent_id=? AND status='queued'").run(token,new Date().toISOString(),row.intent_id);return {receipt:receipt(owned(input.intentId,input.chatId)),claimToken:token}; }).immediate();
}
export function settleWorkStart(input: Parameters<WorkStartAPI['settle']>[0]): WorkStartReceipt {
  exactKeys(input,['intentId','chatId','claimToken','accepted']);if(!UUID.test(input.claimToken)||typeof input.accepted!=='boolean')throw new Error('work_start_settlement_invalid');
  return getDb().transaction(()=>{const row=owned(input.intentId,input.chatId);if(row.status==='claimed'&&row.claim_token===input.claimToken)getDb().prepare("UPDATE work_start_intents SET status=?,error_code=?,claim_token=NULL,updated_at=? WHERE intent_id=?").run(input.accepted?'accepted':'failed',input.accepted?null:'work_start_not_admitted',new Date().toISOString(),row.intent_id);return receipt(owned(input.intentId,input.chatId));}).immediate();
}
export function registerWorkStartIpc({ipc,assertTrustedSender}:{ipc:Pick<IpcMain,'handle'>;assertTrustedSender:(event:IpcMainInvokeEvent)=>BrowserWindow}):void {
  ipc.handle('workStart:create',(event,input:WorkStartInput)=>{assertTrustedSender(event);return createWorkStart(input)});
  ipc.handle('workStart:get',(event,input:Parameters<WorkStartAPI['get']>[0])=>{assertTrustedSender(event);return getWorkStart(input)});
  ipc.handle('workStart:claim',(event,input:Parameters<WorkStartAPI['claim']>[0])=>{assertTrustedSender(event);return claimWorkStart(input)});
  ipc.handle('workStart:settle',(event,input:Parameters<WorkStartAPI['settle']>[0])=>{assertTrustedSender(event);return settleWorkStart(input)});
}
