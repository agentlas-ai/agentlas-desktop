import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createFinanceWorkspace, validateFinanceWorkspace, type FinanceWorkspace } from '../../shared/finance';
import { publishFinanceWorkspaceChange } from './events';

export interface FinanceScope { workspaceId: string; userId: string; assertCurrent(): void }
const lockfile = require('proper-lockfile') as { lock(path: string, options: unknown): Promise<() => Promise<void>> };
const MAX_BYTES = 24 * 1024 * 1024;
/** Host account authority only; renderer cannot select a filesystem partition. */
export class FinanceStore {
  constructor(private readonly root: string) {}
  private directory(scope: FinanceScope): string {
    scope.assertCurrent();
    if (!scope.workspaceId || !scope.userId) throw new Error('finance_sign_in_required');
    return path.join(this.root, createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.userId])).digest('hex'));
  }
  private read(directory: string): FinanceWorkspace {
    const file = path.join(directory, 'workspace.json');
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('finance_store_invalid');
      return validateFinanceWorkspace(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createFinanceWorkspace();
      throw new Error('finance_store_unreadable');
    }
  }
  async load(scope: FinanceScope): Promise<FinanceWorkspace> {
    const directory = this.directory(scope), ownerScope = path.basename(directory);
    const result = this.read(directory); scope.assertCurrent();
    if (result.ownerScope && result.ownerScope !== ownerScope) throw new Error('finance_owner_scope_mismatch');
    return { ...result, ownerScope };
  }
  async save(scope: FinanceScope, input: { workspace: FinanceWorkspace; expectedRevision: number }): Promise<FinanceWorkspace> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('finance_revision_invalid');
    const proposed = validateFinanceWorkspace(input.workspace);
    const directory = this.directory(scope);
    if (proposed.ownerScope !== path.basename(directory)) throw new Error('finance_owner_scope_mismatch');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('finance_store_invalid');
    const release = await lockfile.lock(directory, { realpath: false, stale: 15000, retries: { retries: 40, minTimeout: 20, maxTimeout: 250 } });
    try {
      scope.assertCurrent();
      const current = this.read(directory);
      if (current.revision !== input.expectedRevision) throw new Error('finance_revision_conflict');
      const next = validateFinanceWorkspace({ ...proposed, revision: current.revision + 1 });
      const bytes = Buffer.from(JSON.stringify(next), 'utf8');
      if (bytes.length > MAX_BYTES) throw new Error('finance_workspace_too_large');
      const temporary = path.join(directory, `.workspace-${randomUUID()}.tmp`);
      try {
        scope.assertCurrent();
        fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, path.join(directory, 'workspace.json'));
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      publishFinanceWorkspaceChange({ownerScope:path.basename(directory),revision:next.revision});
      return next;
    } finally { await release(); }
  }
}
