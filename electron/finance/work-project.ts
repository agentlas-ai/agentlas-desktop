import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../store/db';
import { createProject, getProject } from '../store/projects';
import { getChat } from '../store/chats';
import { userDataPath } from '../runtime-paths';
import type { FinanceScope } from './store';

const PREFIX = 'finance.work-project.v1:';
const MARKER = '.agentlas-finance-owner.json';
const Binding = z.object({ schemaVersion: z.literal(1), ownerScope: z.string().regex(/^[a-f0-9]{64}$/), projectId: z.string().uuid(), folderPath: z.string().min(1).max(10000) }).strict();
type Binding = z.infer<typeof Binding>;
interface WorkProjectDependencies {
  db: ReturnType<typeof getDb>;
  createProject: typeof createProject;
  getProject: typeof getProject;
  /** Private owned verification root only; never accepted from IPC. */
  managedProjectsRoot: string;
}
const failure = (): never => { throw new Error('finance_work_project_binding_invalid'); };
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}
function verifiedFolder(folder: string, root: string): void {
  if (!samePath(path.dirname(folder), root)) failure();
  for (const directory of [root, folder]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) failure();
  }
}
function verifyRootBeforeAllocation(root: string): void {
  for (let directory = path.resolve(root);;) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) failure();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
function verify(binding: Binding, dependencies: WorkProjectDependencies): void {
  const project = dependencies.getProject(binding.projectId);
  if (!project || project.sourceType !== 'empty' || project.sourceRef !== null || !project.folderPath || !samePath(project.folderPath, binding.folderPath)) failure();
  verifiedFolder(binding.folderPath, dependencies.managedProjectsRoot);
  const file = path.join(binding.folderPath, MARKER), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12000) failure();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 12000) failure();
    const parsed = Binding.parse(JSON.parse(fs.readFileSync(fd, 'utf8')));
    if (JSON.stringify(parsed) !== JSON.stringify(binding)) failure();
  } finally { fs.closeSync(fd); }
}

/** Provision only a Work project. Existing Work owns chats, execution and history. */
export function financeWorkProject(scope: FinanceScope, injected?: WorkProjectDependencies): { ownerScope: string; projectId: string } {
  scope.assertCurrent();
  if (!scope.workspaceId || !scope.userId) throw new Error('finance_sign_in_required');
  const dependencies = injected ?? { db: getDb(), createProject, getProject, managedProjectsRoot: userDataPath('finance', 'work-projects') };
  const ownerScope = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.userId])).digest('hex');
  const key = `${PREFIX}owner:${ownerScope}`;
  let created: Binding | null = null;
  let createdIdentity: { dev: number; ino: number } | null = null;
  try {
    return dependencies.db.transaction(() => {
      scope.assertCurrent();
      const row = dependencies.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
      let binding: Binding;
      if (row) {
        binding = Binding.parse(JSON.parse(row.value));
        if (binding.ownerScope !== ownerScope) failure();
      } else {
        // A lost forward mapping must never silently allocate a replacement project.
        if (dependencies.db.prepare('SELECT key FROM meta WHERE key LIKE ? AND value = ? LIMIT 1').get(`${PREFIX}project:%`, ownerScope)) failure();
        verifyRootBeforeAllocation(dependencies.managedProjectsRoot);
        const project = dependencies.createProject({ name: 'Agentlas Finance', sourceType: 'empty', agentPool: [] }, { managedProjectsRoot: dependencies.managedProjectsRoot });
        if (!project.folderPath) failure();
        binding = Binding.parse({ schemaVersion: 1, ownerScope, projectId: project.id, folderPath: project.folderPath });
        created = binding;
        verifiedFolder(binding.folderPath, dependencies.managedProjectsRoot);
        const createdStat = fs.lstatSync(binding.folderPath);
        createdIdentity = { dev: createdStat.dev, ino: createdStat.ino };
        scope.assertCurrent();
        fs.writeFileSync(path.join(binding.folderPath, MARKER), JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
        dependencies.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(key, JSON.stringify(binding));
        dependencies.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`${PREFIX}project:${binding.projectId}`, ownerScope);
      }
      const reverse = dependencies.db.prepare('SELECT value FROM meta WHERE key = ?').get(`${PREFIX}project:${binding.projectId}`) as { value: string } | undefined;
      if (reverse?.value !== ownerScope) failure();
      verify(binding, dependencies);
      scope.assertCurrent();
      return { ownerScope, projectId: binding.projectId };
    }).immediate();
  } catch (error) {
    // Only this rolled-back allocation is eligible, and only an empty owned folder.
    const allocated = created as Binding | null;
    const allocatedIdentity = createdIdentity as { dev: number; ino: number } | null;
    if (allocated) {
      try {
        verifiedFolder(allocated.folderPath, dependencies.managedProjectsRoot);
        const current = fs.lstatSync(allocated.folderPath);
        if (!allocatedIdentity || current.dev !== allocatedIdentity.dev || current.ino !== allocatedIdentity.ino) throw new Error('finance_work_project_directory_changed');
        const file = path.join(allocated.folderPath, MARKER);
        try {
          const stat = fs.lstatSync(file);
          if (stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(file, 'utf8') === JSON.stringify(allocated)) fs.unlinkSync(file);
        } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
        fs.rmdirSync(allocated.folderPath);
      } catch { /* Unknown or changed bytes are preserved. */ }
    }
    throw error;
  }
}

type FinanceWorkActor = { workspaceId: string; userId: string };
type FinanceWorkBinding = { ownerScope: string; projectId: string };
/** Read-only execution fence. An ordinary Work project retains its existing behavior. */
export function assertFinanceWorkChatOwner(chatId: string, actor: FinanceWorkActor | null, expected?: FinanceWorkBinding | null,
  injected?: WorkProjectDependencies & { getChat: (id: string) => { projectId: string | null } | null }): FinanceWorkBinding | null {
  const dependencies = injected ?? { db: getDb(), createProject, getProject, getChat, managedProjectsRoot: userDataPath('finance', 'work-projects') };
  const projectId = dependencies.getChat(chatId)?.projectId;
  if (!projectId) { if (expected) failure(); return null; }
  const reverse = dependencies.db.prepare('SELECT value FROM meta WHERE key = ?').get(`${PREFIX}project:${projectId}`) as { value: string } | undefined;
  const project = dependencies.getProject(projectId);
  const folder = project?.folderPath;
  const relative = folder ? path.relative(dependencies.managedProjectsRoot, folder) : null;
  const managed = relative !== null && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  let marked = false;
  if (folder) { try { fs.lstatSync(path.join(folder, MARKER)); marked = true; } catch { /* A foreign Work folder may be absent or unreadable. */ } }
  const forward = !reverse ? dependencies.db.prepare('SELECT value FROM meta WHERE key LIKE ? AND value LIKE ? LIMIT 1').get(`${PREFIX}owner:%`, `%"projectId":"${projectId}"%`) : undefined;
  if (!reverse && !managed && !marked && !forward) { if (expected) failure(); return null; }
  if (!actor?.workspaceId || !actor.userId) throw new Error('finance_work_project_owner_mismatch');
  const ownerScope = createHash('sha256').update(JSON.stringify([actor.workspaceId, actor.userId])).digest('hex');
  if (reverse?.value !== ownerScope || expected && (expected.ownerScope !== ownerScope || expected.projectId !== projectId)) throw new Error('finance_work_project_owner_mismatch');
  const row = dependencies.db.prepare('SELECT value FROM meta WHERE key = ?').get(`${PREFIX}owner:${ownerScope}`) as { value: string } | undefined;
  if (!row) failure();
  const binding = Binding.parse(JSON.parse(row!.value));
  if (binding.ownerScope !== ownerScope || binding.projectId !== projectId) failure();
  verify(binding, dependencies);
  return { ownerScope, projectId };
}
