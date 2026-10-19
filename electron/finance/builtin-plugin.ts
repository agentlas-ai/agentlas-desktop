import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Module from 'node:module';
import { z } from 'zod';
import type { FinanceScope } from './store';
import { userDataPath } from '../runtime-paths';
import { bundledPluginRelease, installedPluginsRoot, materializePluginRelease, verifiedInstalledPluginRelease, verifiedPinnedPluginRelease, type VerifiedInstalledPluginRelease } from '../plugins/materialize';

const SLUG = 'finance', VERSION = '0.2.0', ENTRY = 'runtime/index.cjs';
const ACTIONS = ['planning', 'valuation', 'planning.artifact', 'portfolio.artifact', 'compute', 'compute.artifact'] as const;
const WORKFLOWS = ['index', 'research', 'portfolio', 'planning', 'report', 'workspace', 'monitor', 'analyst'] as const;
export type FinanceBuiltinPureAction = typeof ACTIONS[number];
export type FinanceBuiltinWorkflow = typeof WORKFLOWS[number];
export interface FinanceBuiltinPluginStatus { ready: boolean; phase: 'ready' | 'missing' | 'error'; items: { id: string; name: string; ready: boolean }[]; errorCode?: string }
export interface FinanceBuiltinRuntime { apiVersion: 1; callPureTool(action: FinanceBuiltinPureAction, payload: unknown): unknown }
export interface FinanceBuiltinWorkflowResult { id: string; version: string; digest: string; instructions: string }
const PinSchema = z.object({ schemaVersion: z.literal(1), ownerScope: z.string().regex(/^[a-f0-9]{64}$/), noticeVersion: z.string().min(1).max(200), slug: z.literal(SLUG), version: z.literal(VERSION), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), revision: z.number().int().positive(), activatedAt: z.string().datetime({ offset: true }) }).strict();
type Pin = z.infer<typeof PinSchema>;
const lockfile = require('proper-lockfile') as { lock(directory: string, options: unknown): Promise<() => Promise<void>> };
const digest = (value: Buffer | string): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const errorCode = (error: unknown): string => error instanceof Error && /^finance_plugin_[a-z_]+$/.test(error.message) ? error.message : 'finance_plugin_release_unavailable';

/** Check every ancestor, including existing junctions, without creating directories. */
function directoryExists(directory: string): boolean {
  const parent = path.dirname(directory);
  if (parent !== directory && !directoryExists(parent)) return false;
  try { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('finance_plugin_path_invalid'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function ensureDirectory(directory: string): void {
  if (directoryExists(directory)) return;
  const parent = path.dirname(directory); if (parent !== directory) ensureDirectory(parent);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!directoryExists(directory)) throw new Error('finance_plugin_path_invalid');
}
function readBytes(file: string, max: number): Buffer {
  if (!directoryExists(path.dirname(file))) { const error = new Error('missing') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('finance_plugin_file_invalid');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > max || stat.ino !== info.ino || stat.dev !== info.dev) throw new Error('finance_plugin_file_invalid'); const bytes = fs.readFileSync(fd); if (bytes.length > max) throw new Error('finance_plugin_file_invalid'); return bytes; }
  finally { fs.closeSync(fd); }
}
/** JSON-only boundary: no accessors, custom prototypes, nonfinite numbers, cycles or unbounded data. */
function detachedJSON(value: unknown): unknown {
  let nodes = 0; const active = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 1000000 || depth > 64) throw new Error('finance_plugin_payload_too_large');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('finance_plugin_payload_invalid'); return; }
    if (typeof item !== 'object' || active.has(item)) throw new Error('finance_plugin_payload_invalid');
    const proto = Object.getPrototypeOf(item); if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('finance_plugin_payload_invalid');
    if (Array.isArray(item)) for (let index = 0; index < item.length; index++) if (!Object.hasOwn(item, index)) throw new Error('finance_plugin_payload_invalid');
    active.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string') throw new Error('finance_plugin_payload_invalid');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(descriptor, 'value')) throw new Error('finance_plugin_payload_invalid');
      if (descriptor.value === undefined && !Array.isArray(item)) continue;
      visit(descriptor.value, depth + 1);
    }
    active.delete(item);
  };
  visit(value, 0); const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 52 * 1024 * 1024) throw new Error('finance_plugin_payload_too_large');
  return JSON.parse(encoded);
}

/** Owner activation only; no account lookup, provider calls, model calls, remote install or global environment changes. */
export class FinanceBuiltinPlugin {
  constructor(private readonly root: string = userDataPath('finance', 'plugins')) {}
  private location(scope: FinanceScope): { directory: string; owner: string } {
    scope.assertCurrent(); if (!scope.workspaceId || !scope.userId) throw new Error('finance_plugin_owner_required');
    const owner = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.userId])).digest('hex');
    return { directory: path.join(path.resolve(this.root), owner), owner };
  }
  private pin(scope: FinanceScope, noticeVersion: string): Pin | null {
    z.string().min(1).max(200).parse(noticeVersion); const { directory, owner } = this.location(scope);
    let raw: Buffer; try { raw = readBytes(path.join(directory, 'activation.json'), 16384); }
    catch (error) { scope.assertCurrent(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let pin: Pin; try { pin = PinSchema.parse(JSON.parse(raw.toString('utf8'))); } catch { throw new Error('finance_plugin_activation_invalid'); }
    scope.assertCurrent(); if (pin.ownerScope !== owner) throw new Error('finance_plugin_owner_mismatch');
    if (pin.noticeVersion !== noticeVersion) throw new Error('finance_plugin_activation_required'); return pin;
  }
  private bundled(): VerifiedInstalledPluginRelease {
    const release = bundledPluginRelease(SLUG);
    if (release.version !== VERSION) throw new Error('finance_plugin_bundled_version_mismatch');
    const manifest = JSON.parse(readBytes(path.join(release.directory, 'plugin.json'), 1024 * 1024).toString('utf8'));
    if (manifest.schema !== 'agentlas.plugin/v2' || manifest.builtin !== false || manifest.invocation?.implicit !== 'never' || manifest.native?.apiVersion !== 1 || manifest.native?.entry !== ENTRY) throw new Error('finance_plugin_manifest_invalid');
    return release;
  }
  private verified(scope: FinanceScope, noticeVersion: string): { pin: Pin; release: VerifiedInstalledPluginRelease } {
    const pin = this.pin(scope, noticeVersion); if (!pin) throw new Error('finance_plugin_activation_required');
    const bundled = this.bundled(), directory = path.join(installedPluginsRoot({ configureScience: false }), SLUG);
    const admitted = verifiedInstalledPluginRelease(directory, { configureScience: false });
    // The uncached exact-tree check also protects native in-process activation, not only a child launcher.
    const release = admitted && verifiedPinnedPluginRelease(directory, pin.digest);
    scope.assertCurrent();
    if (!release) throw new Error('finance_plugin_installed_release_invalid');
    if (pin.digest !== bundled.digest || release.digest !== bundled.digest || release.version !== VERSION) throw new Error('finance_plugin_release_mismatch');
    return { pin, release };
  }
  private publicStatus(ready: boolean, phase: FinanceBuiltinPluginStatus['phase'], code?: string): FinanceBuiltinPluginStatus {
    return { ready, phase, items: [{ id: SLUG, name: 'Agentlas Finance', ready }], ...(code ? { errorCode: code } : {}) };
  }
  async status(scope: FinanceScope, noticeVersion: string): Promise<FinanceBuiltinPluginStatus> {
    scope.assertCurrent();
    try { if (!this.pin(scope, noticeVersion)) return this.publicStatus(false, 'missing'); this.verified(scope, noticeVersion); return this.publicStatus(true, 'ready'); }
    catch (error) { scope.assertCurrent(); const code = errorCode(error); return this.publicStatus(false, code === 'finance_plugin_activation_required' ? 'missing' : 'error', code); }
  }
  /** Caller is the owner-consent host flow. Reading status/runtime never calls prepare. */
  async prepare(scope: FinanceScope, noticeVersion: string): Promise<FinanceBuiltinPluginStatus> {
    const { directory, owner } = this.location(scope); z.string().min(1).max(200).parse(noticeVersion); ensureDirectory(directory); scope.assertCurrent();
    const unlock = await lockfile.lock(directory, { realpath: false, stale: 60000, update: 10000, retries: { retries: 20, minTimeout: 25, maxTimeout: 250 } });
    try {
      scope.assertCurrent(); let previous: Pin | null;
      // A changed notice may be explicitly re-approved; malformed/cross-owner pins are never overwritten.
      try { previous = this.pin(scope, noticeVersion); } catch (error) { if (errorCode(error) !== 'finance_plugin_activation_required') throw error; previous = this.readPriorPin(scope, directory, owner); }
      const bundled = this.bundled(), destinationDir = path.join(installedPluginsRoot({ configureScience: false }), SLUG);
      const receipt = materializePluginRelease({ slug: SLUG, sourceDir: bundled.directory, destinationDir }); scope.assertCurrent();
      if (receipt.action === 'failed') throw new Error('finance_plugin_install_failed');
      const installed = verifiedInstalledPluginRelease(destinationDir, { configureScience: false });
      if (!installed || installed.digest !== bundled.digest || installed.version !== VERSION || this.bundled().digest !== bundled.digest) throw new Error('finance_plugin_release_mismatch');
      if (previous && previous.noticeVersion === noticeVersion && previous.digest === installed.digest) { this.verified(scope, noticeVersion); return this.publicStatus(true, 'ready'); }
      const current = this.readPriorPin(scope, directory, owner);
      if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('finance_plugin_activation_conflict');
      const pin = PinSchema.parse({ schemaVersion: 1, ownerScope: owner, noticeVersion, slug: SLUG, version: VERSION, digest: installed.digest, revision: (previous?.revision ?? 0) + 1, activatedAt: new Date().toISOString() });
      const temp = path.join(directory, `.activation-${randomUUID()}.tmp`), fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(pin)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { scope.assertCurrent(); fs.renameSync(temp, path.join(directory, 'activation.json')); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      scope.assertCurrent(); this.verified(scope, noticeVersion); return this.publicStatus(true, 'ready');
    } catch (error) { scope.assertCurrent(); return this.publicStatus(false, 'error', errorCode(error)); }
    finally { await unlock(); scope.assertCurrent(); }
  }
  private readPriorPin(scope: FinanceScope, directory: string, owner: string): Pin | null {
    let value: Pin; try { value = PinSchema.parse(JSON.parse(readBytes(path.join(directory, 'activation.json'), 16384).toString('utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('finance_plugin_activation_invalid'); }
    scope.assertCurrent(); if (value.ownerScope !== owner) throw new Error('finance_plugin_owner_mismatch'); return value;
  }
  private clearRuntime(directory: string): void {
    const prefix = path.resolve(directory) + path.sep;
    for (const key of Object.keys(require.cache)) if (key.startsWith(prefix)) delete require.cache[key];
  }
  async runtime(scope: FinanceScope, noticeVersion: string): Promise<FinanceBuiltinRuntime> {
    const { pin, release } = this.verified(scope, noticeVersion), entry = path.join(release.directory, ENTRY);
    const bundled = this.bundled(), manifest = JSON.parse(readBytes(path.join(bundled.directory, 'plugin.json'), 1024 * 1024).toString('utf8'));
    const proof = manifest.integrity?.files?.filter((item: { path?: unknown }) => item.path === ENTRY);
    const bytes = readBytes(entry, 16 * 1024 * 1024);
    if (!Array.isArray(proof) || proof.length !== 1 || proof[0].bytes !== bytes.length || `sha256:${proof[0].sha256}` !== digest(bytes) || this.bundled().digest !== bundled.digest) throw new Error('finance_plugin_runtime_integrity_invalid');
    this.clearRuntime(release.directory); scope.assertCurrent(); this.verified(scope, noticeVersion);
    // Compile the exact verified bytes, rather than reopening a pathname after validation.
    // The self-contained pure bundle may use crypto only; it has no filesystem/network/model require port.
    const compiled = new Module(entry, module); compiled.filename = entry; compiled.paths = [];
    compiled.require = (name: string) => { if (name !== 'node:crypto') throw new Error('finance_plugin_runtime_dependency_invalid'); return require('node:crypto'); };
    (compiled as Module & { _compile(source: string, filename: string): void })._compile(bytes.toString('utf8'), entry);
    const loaded = compiled.exports as FinanceBuiltinRuntime;
    if (loaded?.apiVersion !== 1 || typeof loaded.callPureTool !== 'function') { this.clearRuntime(release.directory); throw new Error('finance_plugin_runtime_contract_invalid'); }
    this.verified(scope, noticeVersion); let revoked = false;
    return { apiVersion: 1, callPureTool: (action, payload) => {
      scope.assertCurrent(); if (revoked) throw new Error('finance_plugin_runtime_changed');
      try {
        const current = this.verified(scope, noticeVersion);
        if (JSON.stringify(current.pin) !== JSON.stringify(pin)) throw new Error('finance_plugin_runtime_changed');
      } catch (error) { revoked = true; this.clearRuntime(release.directory); throw error; }
      if (!ACTIONS.includes(action)) throw new Error('finance_plugin_action_invalid');
      const input = detachedJSON(payload), output = loaded.callPureTool(action, input);
      scope.assertCurrent(); this.verified(scope, noticeVersion);
      return detachedJSON(output);
    } };
  }
  async workflow(scope: FinanceScope, noticeVersion: string, name: FinanceBuiltinWorkflow): Promise<FinanceBuiltinWorkflowResult> {
    if (!WORKFLOWS.includes(name)) throw new Error('finance_plugin_workflow_invalid');
    const { pin, release } = this.verified(scope, noticeVersion), bytes = readBytes(path.join(release.directory, 'skills', name, 'SKILL.md'), 32768);
    let instructions: string; try { instructions = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('finance_plugin_workflow_invalid'); }
    if (!instructions.trim()) throw new Error('finance_plugin_workflow_invalid');
    scope.assertCurrent(); const current = this.verified(scope, noticeVersion); if (JSON.stringify(current.pin) !== JSON.stringify(pin)) throw new Error('finance_plugin_runtime_changed');
    return { id: `plugin:finance/${name}`, version: release.version, digest: digest(bytes), instructions };
  }
}
let singleton: FinanceBuiltinPlugin | undefined;
export function financeBuiltinPlugin(): FinanceBuiltinPlugin { return singleton ??= new FinanceBuiltinPlugin(); }
