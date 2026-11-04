import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createFinanceWorkspace, normalizeFinanceDashboard, validateFinanceWorkspace, type FinanceWorkspace } from '../../shared/finance';
import { publishFinanceWorkspaceChange } from './events';

/** `origin` marks a scope used by this app's own agent tools or scheduled automation: its writes are recorded so that a caller holding an older revision can be rebased over them (see selfOnlyGap). The owner's screens and phone carry no origin. */
export interface FinanceScope { workspaceId: string; userId: string; assertCurrent(): void; readOnly?: boolean; origin?: 'agent' | 'automation' }
const lockfile = require('proper-lockfile') as { lock(path: string, options: unknown): Promise<() => Promise<void>> };
const MAX_BYTES = 24 * 1024 * 1024;
/**
 * The validated workspace of each recently read file, reused while the file is the same file: validating a 7 MB workspace costs about
 * half a second and every Finance tool call used to do it twice (the read, then the dashboard normalisation), measured with 60 saved
 * reports. A file's identity is its inode, size and modification and change times in nanoseconds; a save writes a new file and renames it, so any
 * write by this or another process is a new identity and the next read validates again. Nothing a caller receives is the kept object: every
 * hand-out is a copy, so a caller that edits what it was given cannot change what the next caller reads.
 */
interface Kept { key: string; workspace: FinanceWorkspace; normalized?: { ownerScope: string; value: FinanceWorkspace } }
const KEPT_LIMIT = 2;
/** Revisions written by this app's own agent/automation, per workspace directory (newest kept). A revision gap made only of these is not an owner's conflicting edit. */
const SELF_WRITE_LIMIT = 500;
const selfWrites = new Map<string, number[]>();
const kept = new Map<string, Kept>();
const identity = (info: fs.BigIntStats): string => `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
/** Host account authority only; renderer cannot select a filesystem partition. */
export class FinanceStore {
  constructor(private readonly root: string) {}
  private directory(scope: FinanceScope): string {
    scope.assertCurrent();
    if (!scope.workspaceId || !scope.userId) throw new Error('finance_sign_in_required');
    return path.join(this.root, createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.userId])).digest('hex'));
  }
  /** The validated workspace file as a kept entry (not for editing: copy what you hand out). An absent file is an empty workspace that is not kept. */
  private keep(directory: string): Kept {
    const file = path.join(directory, 'workspace.json');
    try {
      const info = fs.lstatSync(file, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_BYTES)) throw new Error('finance_store_invalid');
      const key = identity(info), hit = kept.get(file);
      if (hit && hit.key === key) { kept.delete(file); kept.set(file, hit); return hit; }
      const entry: Kept = { key, workspace: validateFinanceWorkspace(JSON.parse(fs.readFileSync(file, 'utf8'))) };
      // A file replaced while it was being read is not remembered.
      if (identity(fs.lstatSync(file, { bigint: true })) === key) { kept.delete(file); kept.set(file, entry); while (kept.size > KEPT_LIMIT) kept.delete(kept.keys().next().value!); }
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { key: '', workspace: createFinanceWorkspace() };
      throw new Error('finance_store_unreadable');
    }
  }
  private read(directory: string): FinanceWorkspace { return structuredClone(this.keep(directory).workspace); }
  /** Size of the saved workspace file; 0 when none exists yet. */
  sizeBytes(scope: FinanceScope): number { try { return Number(fs.lstatSync(path.join(this.directory(scope), 'workspace.json'), { bigint: true }).size); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; } }
  /** True when every revision after `from` up to and including `to` was written by this app's own agent or automation (never by the owner's screen or phone). Held only in memory: after a restart a gap is treated as the owner's. */
  selfOnlyGap(scope: FinanceScope, from: number, to: number): boolean {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to) return false;
    const written = new Set(selfWrites.get(this.directory(scope)) ?? []);
    for (let revision = from + 1; revision <= to; revision++) if (!written.has(revision)) return false;
    return true;
  }
  async load(scope: FinanceScope): Promise<FinanceWorkspace> {
    const directory = this.directory(scope), ownerScope = path.basename(directory);
    for(let attempt=0;attempt<3;attempt++){
      const entry=this.keep(directory),result=entry.workspace;scope.assertCurrent();
      if(result.ownerScope&&result.ownerScope!==ownerScope)throw new Error('finance_owner_scope_mismatch');
      // `result` is only read here (scalars); what is returned is always a copy of the normalised workspace.
      let value=entry.normalized?.ownerScope===ownerScope?entry.normalized.value:undefined;
      if(!value){value=normalizeFinanceDashboard({...result,ownerScope});if(entry.key)entry.normalized={ownerScope,value};}
      const normalized=structuredClone(value);
      if(scope.readOnly)return normalized;
      if(result.dashboards.length===1&&result.activeDashboardId===normalized.activeDashboardId)return normalized;
      try{return await this.transaction(scope,result.revision,current=>normalizeFinanceDashboard(current),true);}
      catch(error){if((error as Error).message!=='finance_revision_conflict'||attempt===2)throw error;}
    }
    throw new Error('finance_revision_conflict');
  }

  async save(scope: FinanceScope, input: { workspace: FinanceWorkspace; expectedRevision: number }): Promise<FinanceWorkspace> {
    const proposed = validateFinanceWorkspace(input.workspace);
    return this.transaction(scope,input.expectedRevision,()=>proposed);
  }
  /** Archive verification and active membership changes share the canonical workspace lease and CAS. */
  async transaction(scope:FinanceScope,expectedRevision:number,update:(current:FinanceWorkspace)=>Promise<FinanceWorkspace>|FinanceWorkspace,internal=false):Promise<FinanceWorkspace> {
    if (scope.readOnly) throw new Error('finance_read_only');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('finance_revision_invalid');
    const directory = this.directory(scope);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('finance_store_invalid');
    const release = await lockfile.lock(directory, { realpath: false, stale: 15000, retries: { retries: 40, minTimeout: 20, maxTimeout: 250 } });
    try {
      scope.assertCurrent();
      const current = this.read(directory);
      if (current.revision !== expectedRevision) throw new Error('finance_revision_conflict');
      if(current.ownerScope&&current.ownerScope!==path.basename(directory))throw new Error('finance_owner_scope_mismatch');
      const proposed=normalizeFinanceDashboard(validateFinanceWorkspace(await update({...current,ownerScope:path.basename(directory)})),current.activeDashboardId);
      scope.assertCurrent();
      if (proposed.ownerScope !== path.basename(directory)) throw new Error('finance_owner_scope_mismatch');
      const next = validateFinanceWorkspace({ ...proposed, revision: current.revision + 1 });
      const bytes = Buffer.from(JSON.stringify(next), 'utf8');
      if (bytes.length > MAX_BYTES) throw new Error('finance_workspace_too_large');
      const temporary = path.join(directory, `.workspace-${randomUUID()}.tmp`);
      try {
        scope.assertCurrent();
        fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
        const target = path.join(directory, 'workspace.json');
        fs.renameSync(temporary, target);
        // What was just written is already validated: remember it under the new file's identity (a later write by anyone is another identity).
        try { const written = fs.lstatSync(target, { bigint: true }); if (written.isFile() && written.size === BigInt(bytes.length)) { kept.delete(target); kept.set(target, { key: identity(written), workspace: structuredClone(next) }); while (kept.size > KEPT_LIMIT) kept.delete(kept.keys().next().value!); } } catch { /* the next read validates */ }
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      if (scope.origin || internal) { const written = selfWrites.get(directory) ?? []; written.push(next.revision); while (written.length > SELF_WRITE_LIMIT) written.shift(); selfWrites.set(directory, written); }
      publishFinanceWorkspaceChange({ownerScope:path.basename(directory),revision:next.revision});
      return next;
    } finally { await release(); }
  }
}
