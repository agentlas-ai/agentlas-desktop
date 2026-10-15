import {memoryDatabaseForOriginalSource as memorySource} from '../memory/database';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentWorkspaceProposal } from '../../shared/agent-workspace';
import type { AgentWorkspaceAppliedReadback } from '../agents/workspace-service';
import { employeeAgentChangeObject as object, employeeAgentChangeArray as array, employeeAgentChangePath as portable,
  employeeAgentChangeHex as hex, employeeAgentChangeId as id, isEmployeeAgentChangeBinding, isEmployeeAgentChangeReceipt,
  BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA, EMPLOYEE_AGENT_CHANGE_EFFECT_KIND,
  type EmployeeAgentChangeBinding, type EmployeeAgentChangeClaim, type EmployeeAgentChangeReceipt, type EmployeeAgentChangeStage } from '../../shared/business/employee-agent-change';
import { employeeAgentChangeDigest as digest, type EmployeeAgentChangeRegistration, type EmployeeAgentChangeExclusion } from './employee-agent-change-adapter';
import type { EmployeeAgentChangeJournalWithEvidence } from './employee-agent-change-journal';
import { workspaceHash, workspaceTreeDigest, workspaceFileRole, decodeWorkspaceText, workspaceTarget,
  MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_TOTAL_BYTES, type WorkspaceTree } from '../agents/workspace-snapshot';

/** Presence in installed_agents and a local route are NOT organization authority.
 * The original owner must prove WORK-only root AND ledger custody before any body read. */
export interface EmployeeAgentWorkspaceCustodyOwner {
  assertHeldCurrent(scope: object, registration: EmployeeAgentChangeRegistration): boolean;
  assertOriginalWorkCustody(scope: object, registration: EmployeeAgentChangeRegistration): boolean;
  originalDatabase(scope: object, registration: EmployeeAgentChangeRegistration): object;
  originalApprovalReceipt(scope: object, registration: EmployeeAgentChangeRegistration, operationId: string): EmployeeAgentChangeReceipt | null;
  /** Exact DB-backed apply claim under the same original held lease. Required only
   * for the own applied-head transition before/after accepted source checkpoint. */
  originalApplyClaim(scope: object, registration: EmployeeAgentChangeRegistration): ReturnType<EmployeeAgentChangeJournalWithEvidence['readOriginalClaim']>;
  originalLocations(scope: object, registration: EmployeeAgentChangeRegistration): Readonly<{ rootPath: string; storePath: string }>;
  checkpoint(scope: object, input: Readonly<{ registration: EmployeeAgentChangeRegistration; claim: EmployeeAgentChangeClaim;
    proposal: AgentWorkspaceProposal; snapshot: AgentWorkspaceAppliedReadback; storedProposalDigest: string; storedRevisionDigest: string;
    approvalReceiptId: string }>): ReturnType<EmployeeAgentChangeExclusion['acceptedWorkspaceResult']>;
  withCurrentRead<T>(capability: object, operationId: string, stage: EmployeeAgentChangeStage,
    reducer: (scope: Readonly<{ registration: EmployeeAgentChangeRegistration; claim: EmployeeAgentChangeClaim;
      receipt: EmployeeAgentChangeReceipt | null }>) => T): Promise<T | null>;
}
type Source = {
  getDb: () => { prepare(sql: string): { get(...args: unknown[]): unknown } };
  getRoute: (agentId: string) => { path: string } | null | undefined;
  resolveAgentPackageDir: (agentId: string, slug: string) => { dir: string };
  agentWorkspaceStorePath: (agentId: string) => string;
};
export interface EmployeeAgentWorkspaceCustodyOptions { owner: EmployeeAgentWorkspaceCustodyOwner; source?: () => Source; }
export interface EmployeeAgentChangeStoredDiff {
  receipt: EmployeeAgentChangeReceipt; proposalId: string; baseVersionId: string; baseDigest: string;
  proposedDigest: string; proposalDigest: string; approvalExpiresAt: number | null;
  changes: Array<{ path: string; beforeText: string; afterText: string; beforeHash: string | null; afterHash: string | null }>;
}
function fail(code: string): never { throw new Error(`employee_agent_workspace_${code}`); }
function own(o: unknown, k: string): unknown {
  if (!o || typeof o !== 'object' && typeof o !== 'function') return undefined;
  const d = Object.getOwnPropertyDescriptor(o, k); return d && Object.hasOwn(d, 'value') ? d.value : undefined;
}
function fn<T extends (...args: any[]) => any>(o: unknown, k: string): T {
  const v = own(o, k); if (typeof v !== 'function') fail('owner_unavailable'); return v.bind(o) as T;
}
function exact(a: unknown, b: unknown): boolean { return digest(a) === digest(b); }
function shape(v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> {
  return object(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
}
const revisionId = (v: unknown): v is string => typeof v === 'string' && /^awr_[a-f0-9-]{36}$/.test(v);
const proposalId = (v: unknown): v is string => typeof v === 'string' && /^awp_[a-f0-9-]{36}$/.test(v);
const approvalId = (v: unknown): v is string => typeof v === 'string' && /^awa_[a-f0-9-]{36}$/.test(v);
const timestamp = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const freeze = <T>(v: T): T => { const c = JSON.parse(JSON.stringify(v)); const visit = (x: any): void => {
  if (x && typeof x === 'object') { Object.values(x).forEach(visit); Object.freeze(x); } }; visit(c); return c; };

/** Stable no-follow reads. All parent components, hard links and post-open replacement
 * are checked. No baseline, materialization, recovery or memory body reader is called. */
function bytes(root: string, relative: string, limit: number): Buffer {
  const file = workspaceTarget(root, relative), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const a = fs.fstatSync(fd); if (!a.isFile() || a.nlink !== 1 || a.size > limit) fail('unsafe_file');
    const data = fs.readFileSync(fd), b = fs.fstatSync(fd), live = fs.lstatSync(file);
    if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs
      || a.mode !== b.mode || live.dev !== b.dev || live.ino !== b.ino || live.size !== b.size || live.mtimeMs !== b.mtimeMs
      || live.ctimeMs !== b.ctimeMs || live.mode !== b.mode || data.length !== a.size) fail('source_changed');
    return data;
  } finally { fs.closeSync(fd); }
}
function json(root: string, relative: string): any {
  const data = bytes(root, relative, 96 * 1024 * 1024), text = decodeWorkspaceText(data);
  if (text === null) fail('record_invalid');
  try { return JSON.parse(text); } catch { fail('record_invalid'); }
}
function realDirectory(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('location_invalid');
  const stat = fs.lstatSync(value); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_root');
  const real = fs.realpathSync.native(value); if (path.resolve(value) !== real) fail('unsafe_root'); return real;
}
function tree(raw: unknown, allowed: readonly string[]): WorkspaceTree {
  if (!object(raw, ['schemaVersion', 'assetPolicyVersion', 'canonicalEntry', 'treeDigest', 'files'])
    || raw.schemaVersion !== 'agentlas.agent-tree.v1' || raw.assetPolicyVersion !== 'agentlas.runtime-assets.v1'
    || !hex(raw.treeDigest) || !(raw.canonicalEntry === null || portable(raw.canonicalEntry) && allowed.includes(raw.canonicalEntry))
    || !array(raw.files) || raw.files.length > 512) fail('tree_invalid');
  const names = new Set<string>(); let total = 0;
  // Check every name and coverage BEFORE decoding any stored file body.
  for (const f of raw.files) {
    if (!object(f, ['path', 'role', 'blobHash', 'byteLength', 'executable', 'kind', 'binary', 'contentBase64'])
      || !portable(f.path) || !allowed.includes(f.path) || names.has(f.path.toLowerCase()) || !hex(f.blobHash)
      || !Number.isSafeInteger(f.byteLength) || (f.byteLength as number) < 0 || (f.byteLength as number) > MAX_WORKSPACE_FILE_BYTES
      || typeof f.executable !== 'boolean' || f.kind !== 'file' || f.binary !== false || typeof f.contentBase64 !== 'string'
      || f.contentBase64.length > MAX_WORKSPACE_FILE_BYTES * 2 || f.role !== workspaceFileRole(f.path, raw.canonicalEntry as string | null)) fail('tree_scope');
    names.add(f.path.toLowerCase()); total += f.byteLength as number;
  }
  if (total > MAX_WORKSPACE_TOTAL_BYTES) fail('tree_limit');
  for (const f of raw.files as any[]) {
    const data = Buffer.from(f.contentBase64, 'base64');
    if (data.toString('base64') !== f.contentBase64 || data.length !== f.byteLength || workspaceHash(data) !== f.blobHash
      || decodeWorkspaceText(data) === null) fail('tree_bytes');
  }
  if (workspaceTreeDigest(raw.files as any) !== raw.treeDigest) fail('tree_digest');
  return raw as unknown as WorkspaceTree;
}
function revision(raw: any, agentId: string, allowed: readonly string[]): any {
  if (!shape(raw, ['id', 'agentId', 'parentRevisionIds', 'treeDigest', 'createdAt', 'operation', 'summary', 'tree'], ['proposalId'])
    || !revisionId(raw.id) || raw.agentId !== agentId || !array(raw.parentRevisionIds) || raw.parentRevisionIds.length > 2
    || !raw.parentRevisionIds.every(revisionId) || !timestamp(raw.createdAt) || typeof raw.summary !== 'string'
    || !['baseline', 'external_edit', 'apply', 'sync', 'rollback'].includes(raw.operation as string)
    || raw.proposalId !== undefined && !proposalId(raw.proposalId)) fail('revision_invalid');
  const t = tree(raw.tree, allowed); if (raw.treeDigest !== t.treeDigest) fail('revision_digest'); return raw;
}
function proposal(raw: any, b: EmployeeAgentChangeBinding, root: string): any {
  if (!shape(raw, ['schemaVersion', 'id', 'agentId', 'summary', 'status', 'baseRevisionId', 'baseTreeDigest', 'proposedTreeDigest',
    'proposalDigest', 'changes', 'memoryEntryIds', 'createdAt', 'rootPath', 'before', 'after', 'sourceHashes'], ['appliedAt', 'appliedRevisionId', 'lastError'])
    || raw.schemaVersion !== 'agentlas.workspace-proposal.v2' || !proposalId(raw.id) || raw.agentId !== b.assetId || raw.rootPath !== root
    || !revisionId(raw.baseRevisionId) || !hex(raw.proposalDigest) || !timestamp(raw.createdAt) || typeof raw.summary !== 'string'
    || !['review_ready', 'applying', 'applied', 'rejected', 'stale', 'recovery_required'].includes(raw.status as string)
    || !array(raw.memoryEntryIds) || raw.memoryEntryIds.length || !object(raw.sourceHashes, []) || !array(raw.changes)
    || raw.changes.length > 512 || raw.appliedRevisionId !== undefined && !revisionId(raw.appliedRevisionId)
    || raw.appliedAt !== undefined && !timestamp(raw.appliedAt) || raw.lastError !== undefined && typeof raw.lastError !== 'string') fail('proposal_invalid');
  const before = tree(raw.before, b.approvedPaths), after = tree(raw.after, b.approvedPaths), seen = new Set<string>();
  const changed = [...new Set([...before.files.map(f => f.path), ...after.files.map(f => f.path)])].filter(name => {
    const a = before.files.find(f => f.path === name), z = after.files.find(f => f.path === name);
    return a?.blobHash !== z?.blobHash || a?.executable !== z?.executable;
  });
  for (const c of raw.changes as any[]) {
    if (!shape(c, ['path', 'operation', 'beforeHash', 'afterHash', 'beforeContent', 'afterContent'], ['binary', 'beforeExecutable', 'afterExecutable'])
      || !portable(c.path) || !b.assetPaths.includes(c.path) || seen.has(c.path.toLowerCase()) || !changed.includes(c.path)
      || typeof c.beforeContent !== 'string' || typeof c.afterContent !== 'string' || c.binary !== undefined && c.binary !== false) fail('change_scope');
    seen.add(c.path.toLowerCase()); const a = before.files.find(f => f.path === c.path), z = after.files.find(f => f.path === c.path);
    if (c.beforeHash !== (a?.blobHash ?? null) || c.afterHash !== (z?.blobHash ?? null)
      || c.beforeContent !== (a ? decodeWorkspaceText(Buffer.from(a.contentBase64, 'base64')) : '')
      || c.afterContent !== (z ? decodeWorkspaceText(Buffer.from(z.contentBase64, 'base64')) : '')
      || c.beforeExecutable !== (a?.executable ?? false) || c.afterExecutable !== (z?.executable ?? false)
      || c.operation !== (!a ? 'create' : !z ? 'delete' : 'modify')) fail('change_bytes');
  }
  if (changed.length !== raw.changes.length || before.treeDigest !== raw.baseTreeDigest || after.treeDigest !== raw.proposedTreeDigest
    || workspaceHash(JSON.stringify({ schemaVersion: raw.schemaVersion, id: raw.id, agentId: raw.agentId, baseRevisionId: raw.baseRevisionId,
      baseTreeDigest: raw.baseTreeDigest, proposedTreeDigest: raw.proposedTreeDigest, changes: raw.changes, sourceHashes: raw.sourceHashes })) !== raw.proposalDigest) fail('proposal_digest');
  return raw;
}

export function createEmployeeAgentWorkspaceCustody(options: EmployeeAgentWorkspaceCustodyOptions) {
  const owner = own(options, 'owner') as EmployeeAgentWorkspaceCustodyOwner;
  const keys = ['assertHeldCurrent', 'assertOriginalWorkCustody', 'originalDatabase', 'originalApprovalReceipt', 'originalApplyClaim', 'originalLocations', 'checkpoint', 'withCurrentRead'] as const;
  const refs = keys.map(k => own(owner, k)); if (refs.some(x => typeof x !== 'function')) fail('owner_unavailable');
  const held = fn<EmployeeAgentWorkspaceCustodyOwner['assertHeldCurrent']>(owner, 'assertHeldCurrent');
  const custody = fn<EmployeeAgentWorkspaceCustodyOwner['assertOriginalWorkCustody']>(owner, 'assertOriginalWorkCustody');
  const originalDb = fn<EmployeeAgentWorkspaceCustodyOwner['originalDatabase']>(owner, 'originalDatabase');
  const approval = fn<EmployeeAgentWorkspaceCustodyOwner['originalApprovalReceipt']>(owner, 'originalApprovalReceipt');
  const applyClaim = fn<EmployeeAgentWorkspaceCustodyOwner['originalApplyClaim']>(owner, 'originalApplyClaim');
  const locations = fn<EmployeeAgentWorkspaceCustodyOwner['originalLocations']>(owner, 'originalLocations');
  const checkpoint = fn<EmployeeAgentWorkspaceCustodyOwner['checkpoint']>(owner, 'checkpoint');
  const read = fn<EmployeeAgentWorkspaceCustodyOwner['withCurrentRead']>(owner, 'withCurrentRead');
  const supplied = own(options, 'source'); if (supplied !== undefined && typeof supplied !== 'function') fail('source_unavailable');
  let source: Source | null = null, sourceRefs: unknown[] = [], db: unknown;
  const methods = ['getDb', 'getRoute', 'resolveAgentPackageDir', 'agentWorkspaceStorePath'] as const;
  function current(scope: object, r: EmployeeAgentChangeRegistration): void {
    if (keys.some((k, i) => own(owner, k) !== refs[i]) || own(options, 'source') !== supplied
      || !held(scope, r) || !custody(scope, r) || !isEmployeeAgentChangeBinding(own(r, 'binding'))) fail('original_custody_required');
  }
  function namespace(): Source {
    const actual = supplied ? (supplied as () => Source)() : source ?? { getDb: require('../store/db').getDb, getRoute: require('../agents/routes').getRoute,
      resolveAgentPackageDir: require('../agents/files').resolveAgentPackageDir, agentWorkspaceStorePath: require('../agents/workspace-guard').agentWorkspaceStorePath };
    if (!source) { source = actual; sourceRefs = methods.map(k => own(actual, k)); }
    if (actual !== source || methods.some((k, i) => own(actual, k) !== sourceRefs[i] || typeof sourceRefs[i] !== 'function')) fail('source_changed');
    const actualDb = actual.getDb(); if (db && db !== actualDb) fail('source_changed'); db = actualDb; return actual;
  }
  function originalApply(scope: object, r: EmployeeAgentChangeRegistration) {
    const original = applyClaim(scope, r);
    if (!object(original, ['claim', 'claimId', 'claimDigest', 'state']) || !['claimed', 'settled'].includes(original.state as string)
      || !object(original.claim, ['schema', 'operationId', 'stage', 'effectKind', 'inputDigest', 'requestDigest', 'bindingDigest', 'binding'])
      || original.claim.schema !== BUSINESS_EMPLOYEE_AGENT_CHANGE_SCHEMA || original.claim.stage !== 'apply'
      || original.claim.effectKind !== EMPLOYEE_AGENT_CHANGE_EFFECT_KIND.apply || !id(original.claim.operationId) || !hex(original.claim.requestDigest)
      || !exact(original.claim.binding, r.binding) || original.claim.bindingDigest !== digest(r.binding)
      || original.claim.inputDigest !== digest({ stage: 'apply', requestDigest: original.claim.requestDigest, bindingDigest: original.claim.bindingDigest })
      || original.claimDigest !== digest(original.claim) || original.claimId !== `r13_${original.claimDigest}`) fail('original_apply_claim_required');
    return original as unknown as NonNullable<ReturnType<EmployeeAgentWorkspaceCustodyOwner['originalApplyClaim']>>;
  }
  function originalApplied(scope: object, r: EmployeeAgentChangeRegistration, c: EmployeeAgentChangeClaim, p: any, rev: any, store: string) {
    if (!exact(c.binding, r.binding) || c.bindingDigest !== digest(r.binding) || c.stage !== 'apply'
      || c.inputDigest !== digest({ stage: 'apply', requestDigest: c.requestDigest, bindingDigest: c.bindingDigest })
      || p.status !== 'applied' || p.appliedRevisionId !== rev.id || rev.proposalId !== p.id || !['apply', 'rollback'].includes(rev.operation)
      || !exact(rev.parentRevisionIds, [r.binding.currentVersionId]) || p.baseRevisionId !== r.binding.currentVersionId
      || p.baseTreeDigest !== r.binding.currentDigest || p.proposedTreeDigest !== rev.treeDigest || !exact(p.after, rev.tree)) fail('applied_provenance_changed');
    const original = approval(scope, r, c.operationId);
    if (!isEmployeeAgentChangeReceipt(original) || original.stage !== 'approve' || original.state !== 'approved'
      || original.operationId !== c.operationId || original.bindingDigest !== c.bindingDigest || original.requestDigest !== c.requestDigest
      || original.inputDigest !== digest({ stage: 'approve', requestDigest: c.requestDigest, bindingDigest: c.bindingDigest })
      || original.proposalId !== p.id || original.proposalDigest !== p.proposalDigest || original.proposedDigest !== p.proposedTreeDigest
      || !original.approvalReceiptId || !approvalId(original.approvalReceiptId) || !original.employeeReview
      || original.employeePrincipalId !== r.binding.employeePrincipalId || original.requesterPrincipalId !== r.binding.requester.principalId
      || original.employeeReview.nativeSessionId !== r.binding.nativeSessionId || original.employeeReview.nativePrincipalId !== r.binding.nativePrincipalId
      || original.employeeReview.employeePrincipalId !== r.binding.employeePrincipalId || original.employeeReview.bindingDigest !== c.bindingDigest
      || original.employeeReview.operationId !== c.operationId || original.employeeReview.reviewedHash !== p.proposalDigest
      || original.employeeReview.proposalId !== p.id || original.employeeReview.authorityRevision !== r.binding.authorityRevision) fail('original_approval_required');
    const a = json(store, `approvals/${original.approvalReceiptId}.json`);
    if (!object(a, ['id', 'proposalId', 'reviewedHash', 'issuedAt', 'expiresAt', 'state']) || a.id !== original.approvalReceiptId
      || a.proposalId !== p.id || a.state !== 'consumed' || a.reviewedHash !== p.proposalDigest || !timestamp(a.issuedAt) || !timestamp(a.expiresAt)
      || Date.parse(a.expiresAt as string) <= Date.parse(a.issuedAt as string) || !timestamp(p.appliedAt)
      || Date.parse(p.appliedAt) < Date.parse(a.issuedAt as string)
      || Date.parse(p.appliedAt) > Math.min(Date.parse(a.expiresAt as string), original.employeeReview.expiresAt)) fail('approval_invalid');
    return a as { id: string };
  }
  function inspect(scope: object, r: EmployeeAgentChangeRegistration, applied?: { versionId: string; digest: string }) {
    current(scope, r); const original = locations(scope, r);
    if (!object(original, ['rootPath', 'storePath'])) fail('location_invalid');
    const s = namespace(), b = r.binding;
    if (s.getDb() !== originalDb(scope, r)) fail('original_database_required');
    const row = s.getDb().prepare('SELECT slug, builtin, visibility FROM installed_agents WHERE id = ?').get(b.assetId);
    if (!object(row, ['slug', 'builtin', 'visibility']) || typeof row.slug !== 'string' || row.builtin !== 0 || row.visibility !== 'visible') fail('installed_source_unavailable');
    const route = s.getRoute(b.assetId);
    if (route != null && (!object(route) || typeof route.path !== 'string' || Object.hasOwn(route, 'agentId') && own(route, 'agentId') !== b.assetId)) fail('route_invalid');
    const packageDir = route == null ? s.resolveAgentPackageDir(b.assetId, row.slug) : null;
    if (packageDir !== null && (!object(packageDir) || typeof packageDir.dir !== 'string')) fail('package_location_invalid');
    const root = realDirectory(route?.path ?? packageDir!.dir);
    const store = realDirectory(s.agentWorkspaceStorePath(b.assetId));
    if (root !== original.rootPath || store !== original.storePath || path.basename(store) !== workspaceHash(b.assetId)) fail('original_location_changed');
    // Metadata-only association check. Never retrieve personal memory bodies.
    if (memorySource(s.getDb()).prepare('SELECT id FROM memory_entries WHERE agent_id = ? LIMIT 1').get(b.assetId)) fail('private_memory_association');
    if (fs.existsSync(path.join(store, 'operation.json'))) fail('recovery_required');
    const names: string[] = [], collisions = new Set<string>();
    function visit(dir: string, prefix: string): void {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = prefix + ent.name;
        if (!portable(name) || collisions.has(name.toLowerCase()) || ent.isSymbolicLink()) fail('root_scope');
        collisions.add(name.toLowerCase()); if (collisions.size > 1024) fail('root_limit');
        if (ent.isDirectory()) { if (!b.approvedPaths.some(p => p.startsWith(name + '/'))) fail('root_scope'); visit(path.join(dir, ent.name), name + '/'); }
        else if (ent.isFile() && b.approvedPaths.includes(name)) names.push(name); else fail('root_scope');
      }
    }
    visit(root, ''); // Whole-root metadata preflight precedes every live file body.
    const head = json(store, 'head.json'); if (!object(head, ['id', 'treeDigest']) || !revisionId(head.id) || !hex(head.treeDigest)) fail('head_unavailable');
    const expected = applied ?? { versionId: b.currentVersionId, digest: b.currentDigest };
    const rev = revision(json(store, `revisions/${head.id}.json`), b.assetId, b.approvedPaths);
    let transition = false;
    if (head.id !== expected.versionId || head.treeDigest !== expected.digest) {
      if (applied) fail('head_changed'); const original = originalApply(scope, r);
      const c = original.claim as EmployeeAgentChangeClaim, receipt = approval(scope, r, c.operationId);
      if (!isEmployeeAgentChangeReceipt(receipt) || !receipt.proposalId || !proposalId(receipt.proposalId)) fail('original_approval_required');
      const p = proposal(json(store, `proposals/${receipt.proposalId}.json`), b, root);
      originalApplied(scope, r, c, p, rev, store); transition = true;
    }
    if (rev.id !== head.id || rev.treeDigest !== head.treeDigest || !exact(names.sort(), rev.tree.files.map((f: any) => f.path).sort())) fail('head_changed');
    if (b.assetKind === 'work-persona' && (b.assetPaths.length !== 1 || rev.tree.canonicalEntry !== b.assetPaths[0])) fail('canonical_persona_required');
    function pinned(t: WorkspaceTree, pins: EmployeeAgentChangeBinding['currentFiles']): void {
      if (!exact([...t.files].map(f => ({ path: f.path, digest: f.blobHash, executable: f.executable })).sort((a, z) => a.path.localeCompare(z.path)),
        [...pins].sort((a, z) => a.path.localeCompare(z.path)))) fail('source_pins_changed');
    }
    if (!applied && !transition) pinned(rev.tree, b.currentFiles);
    if (b.historical) {
      const old = revision(json(store, `revisions/${b.historical.versionId}.json`), b.assetId, b.approvedPaths);
      if (old.id !== b.historical.versionId || old.treeDigest !== b.historical.digest || b.historical.rootId !== b.assetRootId) fail('history_changed');
      pinned(old.tree, b.historical.files);
    }
    const liveFiles = rev.tree.files.map((f: any) => {
      const data = bytes(root, f.path, MAX_WORKSPACE_FILE_BYTES), stat = fs.lstatSync(workspaceTarget(root, f.path));
      if (workspaceHash(data) !== f.blobHash || data.length !== f.byteLength || Boolean(stat.mode & 0o111) !== f.executable) fail('live_bytes_changed'); return f;
    });
    if (workspaceTreeDigest(liveFiles) !== head.treeDigest) fail('live_digest_changed');
    const firstNames = [...names].sort(); names.length = 0; collisions.clear(); visit(root, '');
    if (!exact(firstNames, names.sort())) fail('root_changed');
    current(scope, r); return { root, store, head, revision: rev };
  }
  function stored(scope: object, r: EmployeeAgentChangeRegistration, pId: string, applied?: { versionId: string; digest: string }) {
    if (!proposalId(pId)) fail('proposal_invalid'); const evidence = inspect(scope, r, applied);
    const p = proposal(json(evidence.store, `proposals/${pId}.json`), r.binding, evidence.root);
    if (p.id !== pId || p.baseRevisionId !== r.binding.currentVersionId || p.baseTreeDigest !== r.binding.currentDigest) fail('proposal_binding_changed');
    current(scope, r); return { ...evidence, proposal: p };
  }
  return Object.freeze({
    assertWorkspaceCustody(scope: object, registration: EmployeeAgentChangeRegistration, binding: Readonly<EmployeeAgentChangeBinding>): boolean {
      current(scope, registration);
      if (!isEmployeeAgentChangeBinding(binding) || !exact(binding, registration.binding)) fail('binding_changed');
      inspect(scope, registration); return true;
    },
    acceptedWorkspaceResult(scope: object, registration: EmployeeAgentChangeRegistration,
      input: Parameters<EmployeeAgentChangeExclusion['acceptedWorkspaceResult']>[0]): ReturnType<EmployeeAgentChangeExclusion['acceptedWorkspaceResult']> {
      current(scope, registration);
      if (!object(input, ['claim', 'workspace', 'proposal', 'snapshot']) || !object(input.claim) || !object(input.proposal) || !object(input.snapshot)
        || !exact(input.claim.binding, registration.binding) || input.claim.bindingDigest !== digest(registration.binding)
        || input.claim.stage !== 'apply' || !input.proposal || !input.snapshot) fail('accepted_binding_changed');
      // Explicit applied-head reads must not bypass the original durable claim.
      const original = originalApply(scope, registration);
      if (digest(input.claim) !== original.claimDigest) fail('original_apply_claim_required');
      const evidence = stored(scope, registration, input.proposal.id, { versionId: input.snapshot.currentRevisionId, digest: input.snapshot.treeDigest });
      const p = evidence.proposal, rev = evidence.revision, { before: _b, after: _a, rootPath: _r, schemaVersion: _s, sourceHashes: _h, ...ui } = p;
      if (p.status !== 'applied' || p.appliedRevisionId !== rev.id || rev.proposalId !== p.id || !['apply', 'rollback'].includes(rev.operation)
        || !exact(rev.parentRevisionIds, [registration.binding.currentVersionId]) || p.proposedTreeDigest !== rev.treeDigest
        || !exact(ui, input.proposal) || input.snapshot.agentId !== registration.binding.assetId || input.snapshot.rootPath !== evidence.root
        || !exact(input.snapshot.files, rev.tree.files.map(({ contentBase64: _c, ...f }: any) => f))) fail('accepted_readback_changed');
      const a = originalApplied(scope, registration, input.claim, p, rev, evidence.store);
      current(scope, registration);
      return checkpoint(scope, { registration, claim: input.claim, proposal: input.proposal, snapshot: input.snapshot,
        storedProposalDigest: digest(p), storedRevisionDigest: digest(rev), approvalReceiptId: a.id });
    },
    async readDiff(input: Readonly<{ readCapability: object; operationId: string; stage: EmployeeAgentChangeStage }>): Promise<EmployeeAgentChangeStoredDiff | null> {
      if (!object(input, ['readCapability', 'operationId', 'stage']) || !input.readCapability || typeof input.readCapability !== 'object'
        || !id(input.operationId) || !['prepare', 'evaluate', 'approve', 'apply'].includes(input.stage)) fail('read_invalid');
      return read(input.readCapability, input.operationId, input.stage, scope => {
        const r = own(scope, 'registration') as EmployeeAgentChangeRegistration, c = own(scope, 'claim') as EmployeeAgentChangeClaim,
          receipt = own(scope, 'receipt') as EmployeeAgentChangeReceipt | null;
        current(scope, r);
        if (!object(c)) fail('read_claim_invalid');
        if (!receipt) return null;
        if (!isEmployeeAgentChangeReceipt(receipt) || receipt.operationId !== input.operationId || receipt.stage !== input.stage
          || c.operationId !== input.operationId || c.stage !== input.stage || c.bindingDigest !== digest(r.binding)
          || receipt.bindingDigest !== c.bindingDigest || receipt.requestDigest !== c.requestDigest || receipt.inputDigest !== c.inputDigest
          || !receipt.proposalId || !receipt.proposalDigest || !receipt.proposedDigest || receipt.state === 'unknown') fail('read_receipt_changed');
        const applied = receipt.newVersionId && receipt.newDigest ? { versionId: receipt.newVersionId, digest: receipt.newDigest } : undefined;
        const e = stored(scope, r, receipt.proposalId, applied), p = e.proposal;
        if (p.proposalDigest !== receipt.proposalDigest || p.proposedTreeDigest !== receipt.proposedDigest
          || !exact(p.changes.map((x: any) => x.path).sort(), [...receipt.changedPaths].sort())) fail('read_proposal_changed');
        current(scope, r);
        let approvalExpiresAt: number | null = null;
        if (receipt.approvalReceiptId) {
          if (!approvalId(receipt.approvalReceiptId) || !receipt.employeeReview) fail('read_approval_invalid');
          const a = json(e.store, `approvals/${receipt.approvalReceiptId}.json`);
          if (!object(a, ['id', 'proposalId', 'reviewedHash', 'issuedAt', 'expiresAt', 'state']) || a.id !== receipt.approvalReceiptId
            || a.proposalId !== p.id || a.reviewedHash !== p.proposalDigest || !timestamp(a.issuedAt) || !timestamp(a.expiresAt)
            || Date.parse(a.expiresAt as string) <= Date.parse(a.issuedAt as string) || !['issued', 'consumed'].includes(a.state as string)
            || input.stage === 'approve' && a.state !== 'issued' || input.stage === 'apply' && a.state !== 'consumed') fail('read_approval_invalid');
          approvalExpiresAt = Math.min(Date.parse(a.expiresAt as string), receipt.employeeReview.expiresAt);
          if (!Number.isFinite(approvalExpiresAt)) fail('read_approval_invalid');
        } else if (input.stage === 'approve' || input.stage === 'apply') fail('read_approval_missing');
        current(scope, r);
        return freeze({ receipt, proposalId: p.id, baseVersionId: p.baseRevisionId, baseDigest: p.baseTreeDigest,
          proposedDigest: p.proposedTreeDigest, proposalDigest: p.proposalDigest, approvalExpiresAt,
          changes: p.changes.map((x: any) => ({ path: x.path, beforeText: x.beforeContent, afterText: x.afterContent, beforeHash: x.beforeHash, afterHash: x.afterHash })) });
      });
    },
  });
}
