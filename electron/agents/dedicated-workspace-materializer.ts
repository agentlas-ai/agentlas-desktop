import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {employeeAgentChangePath} from '../../shared/business/employee-agent-change';
import type {WorkspaceTree} from './workspace-snapshot';

export class DedicatedWorkspaceMaterializationError extends Error {
  readonly code = 'dedicated_workspace_materialization_error';
  constructor(readonly reason: string) { super(reason); }
}
const fail = (reason: string): never => { throw new DedicatedWorkspaceMaterializationError(reason); };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Sources = Readonly<{
  userDataPath(...segments: string[]): string;
  agentWorkspaceStorePath(agentId: string): string;
  snapshotAgentWorkspace(root: string): WorkspaceTree;
}>;
type SelectedFile = Readonly<{path: string; bytes: Buffer; hash: string}>;
function directory(root: string) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== path.resolve(root)) fail('unsafe_root');
  return stat;
}
function checkDirectory(root: string, pin: fs.Stats) {
  const stat = directory(root);
  if (stat.dev !== pin.dev || stat.ino !== pin.ino) fail('readback_changed');
}
function syncDirectory(root: string) {
  // Windows Node does not expose a directory fsync. File sync still runs; this
  // primitive does not claim native DACL or cross-platform crash durability.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readExact(root: string, relative: string): Buffer {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part); const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail('unsafe_file');
  }
  const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const a = fs.fstatSync(fd); if (!a.isFile() || a.nlink !== 1 || a.size > 200000) fail('unsafe_file');
    const bytes = fs.readFileSync(fd), z = fs.fstatSync(fd), live = fs.lstatSync(current);
    if (bytes.length !== a.size || [z, live].some(v => v.dev !== a.dev || v.ino !== a.ino || v.size !== a.size
      || v.mtimeMs !== a.mtimeMs || v.ctimeMs !== a.ctimeMs || v.nlink !== 1)) fail('readback_changed');
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** Internal filesystem primitive only. The actual owner must first validate its
 * current source, explicit review and durable claimed intent. No permission,
 * queue, agent registration or baseline revision is produced here. */
export function createDedicatedWorkspaceMaterializer(input: Readonly<{
  namespace: 'business-work' | 'history-work'; sources: Sources;
}>) {
  if (!['business-work', 'history-work'].includes(input.namespace)) fail('namespace_invalid');
  const namespace = input.namespace, sources = input.sources;
  const refs = [sources.userDataPath, sources.agentWorkspaceStorePath, sources.snapshotAgentWorkspace];
  const assetId = randomUUID(), root = sources.userDataPath(namespace + '-assets', assetId), store = sources.agentWorkspaceStorePath(assetId);
  if (!path.isAbsolute(root) || !path.isAbsolute(store) || root === store || root.startsWith(store + path.sep)
    || store.startsWith(root + path.sep)) fail('unsafe_root');
  let used = false;
  return Object.freeze({assetId, root, store, materialize(options: Readonly<{files: readonly SelectedFile[]; assertCurrent(): void}>) {
    if (used) fail('materialization_reused'); used = true;
    const assertCurrent = options.assertCurrent;
    const current = () => {
      if (input.sources !== sources || input.namespace !== namespace || options.assertCurrent !== assertCurrent
        || refs.some((v, i) => v !== [sources.userDataPath, sources.agentWorkspaceStorePath, sources.snapshotAgentWorkspace][i])) fail('source_owner_changed');
      assertCurrent();
    };
    current();
    if (!Array.isArray(options.files) || !options.files.length || options.files.length > 32) fail('selection_invalid');
    const names = new Set<string>();
    const files = options.files.map(file => {
      if (!employeeAgentChangePath(file.path) || !file.path.toLowerCase().endsWith('.md') || names.has(file.path.toLowerCase())
        || !Buffer.isBuffer(file.bytes) || file.bytes.length > 200000 || !/^[a-f0-9]{64}$/.test(file.hash)) fail('selection_invalid');
      names.add(file.path.toLowerCase()); const bytes = Buffer.from(file.bytes);
      if (digest(bytes) !== file.hash) fail('source_changed'); return {path: file.path, bytes, hash: file.hash};
    });
    if (!files.some(file => file.path.toLowerCase() === 'agent.md')) fail('canonical_entry_required');
    current(); const parent = path.dirname(root);
    fs.mkdirSync(parent, {recursive: true, mode: 0o700}); const parentPin = directory(parent);
    current(); fs.mkdirSync(root, {mode: 0o700}); const rootPin = directory(root);
    syncDirectory(parent); const pins = new Map<string, fs.Stats>([[root, rootPin]]);
    for (const file of files) {
      current(); checkDirectory(parent, parentPin); checkDirectory(root, rootPin);
      let folder = root; const parts = file.path.split('/');
      for (const part of parts.slice(0, -1)) {
        checkDirectory(folder, pins.get(folder)!); const next = path.join(folder, part);
        if (!pins.has(next)) { fs.mkdirSync(next, {mode: 0o700}); pins.set(next, directory(next)); syncDirectory(folder); }
        checkDirectory(next, pins.get(next)!); folder = next;
      }
      const target = path.join(root, file.path), fd = fs.openSync(target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        try { current(); checkDirectory(parent, parentPin); checkDirectory(root, rootPin); checkDirectory(folder, pins.get(folder)!); }
        catch (error) { (error as Error & {emptyOutputMayExistOutsideRoot?: boolean}).emptyOutputMayExistOutsideRoot = true; throw error; }
        const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1) fail('unsafe_file');
        fs.writeFileSync(fd, file.bytes); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      current(); checkDirectory(folder, pins.get(folder)!); syncDirectory(folder);
    }
    current(); for (const [folder, pin] of pins) checkDirectory(folder, pin);
    for (const file of files) if (digest(readExact(root, file.path)) !== file.hash) fail('readback_changed');
    current(); checkDirectory(parent, parentPin); checkDirectory(root, rootPin);
    fs.mkdirSync(store, {recursive: true, mode: 0o700}); const storePin = directory(store);
    const tree = sources.snapshotAgentWorkspace(root);
    if (tree.files.length !== files.length || tree.files.some(file => !files.some(v => v.path === file.path && v.hash === file.blobHash))
      || tree.canonicalEntry === null) fail('readback_changed');
    current(); checkDirectory(store, storePin); checkDirectory(parent, parentPin);
    for (const [folder, pin] of pins) checkDirectory(folder, pin);
    for (const file of files) if (digest(readExact(root, file.path)) !== file.hash) fail('readback_changed');
    syncDirectory(root); syncDirectory(store); current();
    // No portable pathname API establishes atomic confinement against every
    // concurrent rename by the same OS user. Unknown partial files are retained.
    return tree;
  }});
}
