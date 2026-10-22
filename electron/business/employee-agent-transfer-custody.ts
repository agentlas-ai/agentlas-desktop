import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {OneVaultSqlite} from '../secrets/one-vault-journal';
import { workSnapshot } from '../../shared/business/employee-agent-work';
import { EMPLOYEE_AGENT_TRANSFER_SCHEMA, EMPLOYEE_AGENT_TRANSFER_MAX_BYTES, employeeAgentTransferCanonical as canonical,
  isEmployeeAgentTransferTicket, isEmployeeAgentTransferPackage, isEmployeeAgentTransferReceipt, employeeAgentTransferSafeText,
  type EmployeeAgentTransferTicket, type EmployeeAgentTransferPackage, type EmployeeAgentTransferAcceptance,
  EMPLOYEE_AGENT_INSTALLATION_SCHEMA, isEmployeeAgentInstallationAck, isEmployeeAgentInstallationReceipt,
  type EmployeeAgentInstallationAck, type EmployeeAgentInstallationReceipt, type EmployeeAgentTransferReceipt, type EmployeeAgentTransferLocalReceipt } from '../../shared/business/employee-agent-transfer';
import type { BusinessSession } from '../../shared/business/context';
import type { BusinessNativeIdentity } from '../../shared/business/native-sharing-wire';
import type { BusinessNativeAssociation } from '../../shared/business/native-sharing-wire';

export const employeeAgentTransferDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const bytesDigest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw Error(`employee_agent_transfer_${code}`); }
function directory(root: string) {
  if (!path.isAbsolute(root)) fail('root_invalid');
  const value = fs.lstatSync(root);
  if (!value.isDirectory() || value.isSymbolicLink() || fs.realpathSync.native(root) !== path.resolve(root)) fail('root_invalid');
  return value;
}
function sameDirectory(root: string, original: fs.Stats) {
  const current = directory(root); if (current.dev !== original.dev || current.ino !== original.ino) fail('source_changed');
}
/** No recursive enumeration. Only the separately approved portable file names
 * are opened; private siblings are neither read nor copied. */
export function readEmployeeAgentTransferFile(root: string, relative: string): Buffer {
  const rootPin = directory(root); let target = root;
  const components = relative.split('/');
  for (const [i, component] of components.entries()) {
    if (!component || component === '.' || component === '..' || /[\\\x00-\x1f]/.test(component)) fail('path_invalid');
    target = path.join(target, component); const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (i < components.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > EMPLOYEE_AGENT_TRANSFER_MAX_BYTES)) fail('unsafe_file');
  }
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd), data = fs.readFileSync(fd), after = fs.fstatSync(fd), live = fs.lstatSync(target);
    if (!before.isFile() || before.nlink !== 1 || before.size > EMPLOYEE_AGENT_TRANSFER_MAX_BYTES || before.mode & 0o111
      || data.length !== before.size || [after, live].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size
        || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs || s.nlink !== 1)) fail('source_changed');
    sameDirectory(root, rootPin); return data;
  } finally { fs.closeSync(fd); }
}
export function validateEmployeeAgentTransferPackage(input: unknown): EmployeeAgentTransferPackage {
  const value = workSnapshot(input);
  if (!isEmployeeAgentTransferPackage(value)) fail('package_invalid');
  let total = 0;
  for (const [i, file] of value.files.entries()) {
    const bytes = Buffer.from(file.content, 'utf8'), expected = value.ticket.files[i]; total += bytes.length;
    if (bytes.toString('utf8') !== file.content || bytes.length !== expected.bytes || bytesDigest(bytes) !== expected.digest
      || total > EMPLOYEE_AGENT_TRANSFER_MAX_BYTES) fail('package_tampered');
  }
  return value;
}
export function employeeAgentTransferReceiptMatches(receipt: EmployeeAgentTransferReceipt, value: EmployeeAgentTransferPackage) {
  const t = value.ticket;
  return isEmployeeAgentTransferReceipt(receipt) && receipt.state === 'committed' && receipt.transferId === t.transferId
    && receipt.idempotencyKey === t.idempotencyKey && receipt.organizationId === t.organizationId && receipt.mode === t.mode
    && receipt.sourceAgentId === t.source.agentId && receipt.targetAgentId === t.target.agentId
    && receipt.targetEmployeePrincipalId === t.target.employeePrincipalId && receipt.ticketDigest === employeeAgentTransferDigest(t)
    && receipt.packageDigest === employeeAgentTransferDigest(value) && receipt.sourceRevision === t.source.revision
    && receipt.targetRevision >= 1;
}
/** Main/daemon owner port only. This current original asset observation is not
 * an execution grant; the company work owner must obtain independent admission. */
export interface CompanyAgentAsset {
  readonly protocol: 'agentlas.business.original-company-agent.v1';
  readonly organizationSession: BusinessSession;
  readonly associationId: string; readonly associationRevision: number;
  readonly agentResourceId: string; readonly agentId: string; readonly employeePrincipalId: string;
  readonly sourceKind:'company-source'|'transfer';readonly registrationId:string|null;readonly transferId: string|null; readonly packageDigest: string; readonly sourceAgentId: string;
  readonly sourceRevision: number; readonly targetRevision: number;
  readonly rootPath: string; readonly entryPath: string; readonly approvedPaths: readonly string[];
  readonly files: EmployeeAgentTransferTicket['files']; readonly native: BusinessNativeIdentity;
}
export interface CompanyAgentAssetOwner {
  readonly protocol: 'agentlas.business.original-company-agent.v1';
  capture(agentId: string): Promise<object | null>;
  read(capability: object): CompanyAgentAsset | null;
  assertCurrent(capability: object): void;
  refresh(capability: object): Promise<void>;
  request(capability: object, input: { operation: 'admit' | 'claim' | 'refresh' | 'settle' | 'receipt' | 'cancel' | 'review' | 'policies'; payload: unknown }): Promise<unknown>;
}
export interface EmployeeAgentTransferCustodyInput {
  db: OneVaultSqlite;
  association(): BusinessNativeAssociation | null;
  assertNativeOwner(): void;
  refresh(): Promise<unknown>;
  userDataPath(...segments: string[]): string;
  /** Existing local agent registration owner. It must retain the new immutable
   * identity and must never deduplicate a clone by matching source definition. */
  install(value: EmployeeAgentTransferPackage, root: string): Promise<void>;
  installed(value: EmployeeAgentTransferPackage, root: string): boolean;
}
export function createEmployeeAgentTransferCustody(input: EmployeeAgentTransferCustodyInput) {
  const refs = [input.db, input.association, input.assertNativeOwner, input.refresh, input.userDataPath, input.install, input.installed];
  let initialized = false;
  const capturedAssets = new WeakMap<object, { value: EmployeeAgentTransferPackage; root: string; receipt: EmployeeAgentTransferReceipt; association: string }>();
  function owner() {
    if ([input.db, input.association, input.assertNativeOwner, input.refresh, input.userDataPath, input.install, input.installed].some((f, i) => f !== refs[i])) fail('owner_changed');
    input.assertNativeOwner(); const a = input.association();
    if (!a || a.state !== 'active' || Date.parse(a.expiresAt) <= Date.now()) fail('association_revoked'); return a;
  }
  function schema() {
    if (initialized) return;
    input.db.exec(`CREATE TABLE IF NOT EXISTS one_business_agent_transfers(
      transfer_id TEXT NOT NULL,association_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,
      package_digest TEXT NOT NULL,package_json TEXT NOT NULL,acceptance_json TEXT,root_path TEXT,receipt_json TEXT,PRIMARY KEY(transfer_id,kind));
      CREATE UNIQUE INDEX IF NOT EXISTS one_business_agent_transfer_identity ON one_business_agent_transfers(kind,transfer_id);
      CREATE TABLE IF NOT EXISTS one_business_agent_installation_receipts(
        transfer_id TEXT PRIMARY KEY,state TEXT NOT NULL,record_json TEXT NOT NULL,record_digest TEXT NOT NULL,receipt_json TEXT);`);
    initialized = true;
  }
  function sourceTicket(raw: unknown) {
    const t = workSnapshot(raw), a = owner();
    if (!isEmployeeAgentTransferTicket(t) || t.expiresAt <= Date.now() || t.issuedAt > Date.now() + 30000
      || t.organizationId !== a.orgSession.organizationId || t.deploymentId !== a.orgSession.deploymentId
      || t.identityAuthorityId !== a.orgSession.identityAuthorityId || t.source.employeePrincipalId !== a.orgSession.principalId
      || t.association.associationId !== a.associationId || t.association.associationRevision !== a.associationRevision
      || t.association.sourceRevision !== a.sourceRevision || t.association.consentRevision !== a.consentRevision) fail('source_admission_changed');
    return t;
  }
  function targetPackage(value: EmployeeAgentTransferPackage) {
    const a = owner(), t = value.ticket;
    if (t.organizationId !== a.orgSession.organizationId || t.deploymentId !== a.orgSession.deploymentId
      || t.identityAuthorityId !== a.orgSession.identityAuthorityId || t.target.employeePrincipalId !== a.orgSession.principalId) fail('target_admission_changed');
  }
  function readRow(transferId: string, kind: 'export' | 'import') {
    schema(); return input.db.prepare('SELECT * FROM one_business_agent_transfers WHERE transfer_id=? AND kind=?').get(transferId, kind) as {
      transfer_id: string; association_id: string; kind: string; state: string; package_digest: string;
      package_json: string; acceptance_json: string | null; root_path: string | null; receipt_json: string | null;
    } | undefined;
  }
  function installedTransfer(transferId: string) {
    const row = readRow(transferId, 'import');
    return row?.association_id === owner().associationId && row.state === 'installed' && !!row.receipt_json;
  }
  function selectedPackage(ticket: EmployeeAgentTransferTicket, root: string) {
    sourceTicket(ticket); const pin = directory(root);
    const files = ticket.files.map(file => {
      const bytes = readEmployeeAgentTransferFile(root, file.path), content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes) || !employeeAgentTransferSafeText(content)
        || bytes.length !== file.bytes || bytesDigest(bytes) !== file.digest) fail('selected_source_changed');
      return { path: file.path, content };
    });
    sourceTicket(ticket); sameDirectory(root, pin);
    return validateEmployeeAgentTransferPackage({ schema: EMPLOYEE_AGENT_TRANSFER_SCHEMA, ticket, files });
  }
  /** Review callback is the actual focused native dialog, never renderer allow. */
  async function acceptExport(raw: unknown, root: string, review: (value: EmployeeAgentTransferPackage, digest: string) => Promise<{receiptId: string; assertCurrent(): void}>) {
    const ticket = sourceTicket(raw); schema();
    const existing = readRow(ticket.transferId, 'export');
    if (existing) fail('receipt_lookup_required');
    const value = selectedPackage(ticket, root), digest = employeeAgentTransferDigest(value), approved = await review(value, digest);
    await input.refresh(); sourceTicket(ticket); approved.assertCurrent();
    if (employeeAgentTransferDigest(selectedPackage(ticket, root)) !== digest) fail('selected_source_changed');
    const acceptance: EmployeeAgentTransferAcceptance = { schema: EMPLOYEE_AGENT_TRANSFER_SCHEMA,
      transferId: ticket.transferId, idempotencyKey: ticket.idempotencyKey, ticketDigest: employeeAgentTransferDigest(ticket), packageDigest: digest,
      nativeReviewReceiptId: approved.receiptId, approvedAt: Date.now() };
    input.db.transaction(() => {
      sourceTicket(ticket); approved.assertCurrent();
      input.db.prepare("INSERT INTO one_business_agent_transfers VALUES(?,?,'export','accepted',?,?,?,NULL,NULL)")
        .run(ticket.transferId, ticket.association.associationId, digest, canonical(value), canonical(acceptance));
    }).immediate();
    return { value: workSnapshot(value), acceptance: workSnapshot(acceptance) };
  }
  function originalExport(transferId: string) {
    const a = owner(), row = readRow(transferId, 'export');
    if (!row || row.kind !== 'export' || row.association_id !== a.associationId || !row.acceptance_json) fail('original_export_required');
    const value = validateEmployeeAgentTransferPackage(JSON.parse(row.package_json)), acceptance = JSON.parse(row.acceptance_json) as EmployeeAgentTransferAcceptance;
    if (row.package_digest !== employeeAgentTransferDigest(value) || acceptance.packageDigest !== row.package_digest
      || acceptance.ticketDigest !== employeeAgentTransferDigest(value.ticket)) fail('original_export_tampered');
    return { value, acceptance, state: row.state };
  }
  function markAttempt(transferId: string) {
    const existing = originalExport(transferId);
    if (existing.state !== 'accepted') fail('receipt_lookup_required');
    if (input.db.prepare("UPDATE one_business_agent_transfers SET state='attempted' WHERE transfer_id=? AND kind='export' AND state='accepted'").run(transferId).changes !== 1) fail('receipt_lookup_required');
    return existing;
  }
  function settleExport(transferId: string, receipt: EmployeeAgentTransferReceipt) {
    const existing = originalExport(transferId);
    if (!employeeAgentTransferReceiptMatches(receipt, existing.value)) fail('receipt_changed');
    const saved = readRow(transferId, 'export')?.receipt_json;
    if (saved && saved !== canonical({ ...receipt, replayed: false })) fail('receipt_changed');
    input.db.prepare("UPDATE one_business_agent_transfers SET state='committed',receipt_json=? WHERE transfer_id=? AND kind='export' AND state IN ('attempted','committed')")
      .run(canonical({ ...receipt, replayed: false }), transferId);
  }
  function importedReadback(value: EmployeeAgentTransferPackage, root: string) {
    targetPackage(value); directory(root);
    for (const file of value.files) if (bytesDigest(readEmployeeAgentTransferFile(root, file.path)) !== bytesDigest(file.content)) fail('import_readback_changed');
    const manifest = JSON.parse(readEmployeeAgentTransferFile(root, 'agentlas.json').toString('utf8'));
    if (canonical(manifest) !== canonical({ agentId: value.ticket.target.agentId, entry: value.ticket.files.find(f => f.kind === 'definition')!.path })) fail('import_readback_changed');
    const expected = new Set([...value.files.map(f => f.path), 'agentlas.json']);
    const walk = (folder: string, prefix: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isSymbolicLink()) fail('import_readback_changed');
        if (entry.isDirectory()) { if (![...expected].some(p => p.startsWith(relative + '/'))) fail('import_readback_changed'); walk(path.join(folder, entry.name), relative + '/'); }
        else if (!entry.isFile() || !expected.delete(relative)) fail('import_readback_changed');
      }
    };
    walk(root, ''); if (expected.size || !input.installed(value, root)) fail('import_readback_changed');
    targetPackage(value);
  }
  async function importCommitted(raw: unknown, remoteReceipt: EmployeeAgentTransferReceipt,
    review: (value: EmployeeAgentTransferPackage) => Promise<{ assertCurrent(): void }>, confirmCurrent: () => Promise<EmployeeAgentTransferReceipt>) {
    const value = validateEmployeeAgentTransferPackage(raw), ticket = value.ticket, digest = employeeAgentTransferDigest(value);
    targetPackage(value); if (!employeeAgentTransferReceiptMatches(remoteReceipt, value)) fail('receipt_changed'); schema();
    const existing = readRow(ticket.transferId, 'import');
    const localReceipt = (): EmployeeAgentTransferLocalReceipt => ({ transferId: ticket.transferId, packageDigest: digest, installationState: 'unknown', installationReceiptId: null,
      agentId: ticket.target.agentId, localState: 'installed', companyState: 'committed', fileCount: value.files.length });
    if (existing) {
      if (existing.kind !== 'import' || existing.package_digest !== digest || existing.association_id !== owner().associationId) fail('idempotency_conflict');
      if (existing.state !== 'installed' || !existing.root_path) fail('import_effect_unknown');
      if (!employeeAgentTransferReceiptMatches(await confirmCurrent(), value)) fail('receipt_changed');
      importedReadback(value, existing.root_path); return localReceipt();
    }
    const approval = await review(value); await input.refresh(); targetPackage(value); approval.assertCurrent();
    if (!employeeAgentTransferReceiptMatches(await confirmCurrent(), value)) fail('receipt_changed'); targetPackage(value); approval.assertCurrent();
    const root = input.userDataPath('business-agent-transfers', ticket.target.agentId), parent = path.dirname(root);
    if (!path.isAbsolute(root)) fail('root_invalid');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); const parentPin = directory(parent);
    input.db.prepare("INSERT INTO one_business_agent_transfers VALUES(?,?,'import','claimed',?,?,NULL,?,?)")
      .run(ticket.transferId, owner().associationId, digest, canonical(value), root, canonical(remoteReceipt));
    try {
      targetPackage(value); approval.assertCurrent(); sameDirectory(parent, parentPin); fs.mkdirSync(root, { mode: 0o700 }); const rootPin = directory(root);
      const files = [...value.files, { path: 'agentlas.json', content: canonical({ agentId: ticket.target.agentId, entry: ticket.files.find(f => f.kind === 'definition')!.path }) }];
      for (const file of files) {
        targetPackage(value); approval.assertCurrent(); sameDirectory(root, rootPin); sameDirectory(parent, parentPin);
        let folder = root;
        for (const component of file.path.split('/').slice(0, -1)) {
          folder = path.join(folder, component); if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 }); directory(folder);
        }
        const fd = fs.openSync(path.join(root, file.path), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        try { targetPackage(value); approval.assertCurrent(); sameDirectory(root, rootPin); directory(folder); fs.writeFileSync(fd, file.content, 'utf8'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      }
      if (!employeeAgentTransferReceiptMatches(await confirmCurrent(), value)) fail('receipt_changed'); targetPackage(value); approval.assertCurrent();
      await input.install(value, root); importedReadback(value, root); targetPackage(value); approval.assertCurrent();
      input.db.prepare("UPDATE one_business_agent_transfers SET state='installed' WHERE transfer_id=? AND kind='import' AND state='claimed' AND package_digest=?").run(ticket.transferId, digest);
      return localReceipt();
    } catch (error) {
      input.db.prepare("UPDATE one_business_agent_transfers SET state='unknown' WHERE transfer_id=? AND kind='import' AND state='claimed'").run(ticket.transferId); throw error;
    }
  }
  function installationAck(transferId: string) {
    const a = owner(), row = readRow(transferId, 'import');
    if (!row || row.state !== 'installed' || !row.root_path || row.association_id !== a.associationId) fail('installed_agent_required');
    const value = validateEmployeeAgentTransferPackage(JSON.parse(row.package_json)); importedReadback(value,row.root_path);
    const manifestDigest = employeeAgentTransferDigest(value.ticket.files.map(({source:_source,...file})=>file));
    let saved = input.db.prepare('SELECT * FROM one_business_agent_installation_receipts WHERE transfer_id=?').get(transferId) as {
      state:string;record_json:string;record_digest:string;receipt_json:string|null } | undefined;
    if (!saved) {
      const ack: EmployeeAgentInstallationAck = { schema:EMPLOYEE_AGENT_INSTALLATION_SCHEMA, transferId, packageDigest:row.package_digest,
        agentId:value.ticket.target.agentId,manifestDigest,fileCount:value.files.length,localReceiptId:randomUUID(),installedAt:Date.now(),
        associationId:a.associationId,associationRevision:a.associationRevision };
      input.db.prepare("INSERT INTO one_business_agent_installation_receipts VALUES(?,'accepted',?,?,NULL)").run(transferId,canonical(ack),employeeAgentTransferDigest(ack));
      saved = {state:'accepted',record_json:canonical(ack),record_digest:employeeAgentTransferDigest(ack),receipt_json:null};
    }
    const ack = JSON.parse(saved.record_json);
    if (!isEmployeeAgentInstallationAck(ack) || saved.record_digest !== employeeAgentTransferDigest(ack) || ack.transferId!==transferId
      || ack.packageDigest!==row.package_digest || ack.agentId!==value.ticket.target.agentId || ack.manifestDigest!==manifestDigest || ack.fileCount!==value.files.length
      || ack.associationId!==a.associationId || ack.associationRevision!==a.associationRevision) fail('installation_receipt_changed');
    return {ack:workSnapshot(ack),state:saved.state,receipt:saved.receipt_json?JSON.parse(saved.receipt_json) as EmployeeAgentInstallationReceipt:null};
  }
  function claimInstallationAck(transferId:string) {
    const current=installationAck(transferId);
    if(current.state!=='accepted'||input.db.prepare("UPDATE one_business_agent_installation_receipts SET state='attempted' WHERE transfer_id=? AND state='accepted'").run(transferId).changes!==1) fail('installation_receipt_lookup_required');
    return current.ack;
  }
  function settleInstallationAck(transferId:string, receipt:EmployeeAgentInstallationReceipt) {
    const current=installationAck(transferId),a=owner();
    if(!isEmployeeAgentInstallationReceipt(receipt))fail('installation_receipt_changed');
    const {receiptId:_id,receivedAt:_received,nativeHostId,employeePrincipalId,state:_state,replayed:_replayed,...ack}=receipt;
    if(canonical(ack)!==canonical(current.ack)||nativeHostId!==a.native.nativeHostId||employeePrincipalId!==a.orgSession.principalId)fail('installation_receipt_changed');
    const normalized={...receipt,replayed:false};
    if(current.receipt&&canonical({...current.receipt,replayed:false})!==canonical(normalized))fail('installation_receipt_changed');
    if(input.db.prepare("UPDATE one_business_agent_installation_receipts SET state='confirmed',receipt_json=? WHERE transfer_id=? AND state IN ('attempted','confirmed')")
      .run(canonical(normalized),transferId).changes!==1)fail('installation_receipt_changed');
    return workSnapshot(normalized);
  }
  async function captureInstalledAgent(agentId: string, confirm: (transferId: string) => Promise<EmployeeAgentTransferReceipt>) {
    owner(); schema();
    if (typeof agentId !== 'string' || !/^agt_[A-Za-z0-9_.-]{4,120}$/.test(agentId)) fail('installed_agent_required');
    const rows = input.db.prepare("SELECT transfer_id FROM one_business_agent_transfers WHERE kind='import' AND state='installed' AND json_extract(package_json,'$.ticket.target.agentId')=?").all(agentId) as Array<{transfer_id:string}>;
    if (rows.length !== 1) return null;
    const row = readRow(rows[0].transfer_id, 'import'); if (!row?.root_path || !row.receipt_json) fail('installed_agent_required');
    const value = validateEmployeeAgentTransferPackage(JSON.parse(row.package_json)), receipt = JSON.parse(row.receipt_json) as EmployeeAgentTransferReceipt;
    targetPackage(value); if (row.package_digest !== employeeAgentTransferDigest(value) || !employeeAgentTransferReceiptMatches(receipt, value)) fail('installed_agent_changed');
    if (!employeeAgentTransferReceiptMatches(await confirm(value.ticket.transferId), value)) fail('receipt_changed');
    importedReadback(value, row.root_path);
    const capability = Object.freeze({}); capturedAssets.set(capability, { value, root: row.root_path, receipt, association: canonical(owner()) });
    return capability;
  }
  function readInstalledAgent(capability: object): CompanyAgentAsset | null {
    try {
      const held = capturedAssets.get(capability); if (!held || canonical(owner()) !== held.association) return null;
      const row = readRow(held.value.ticket.transferId, 'import');
      if (!row || row.state !== 'installed' || row.root_path !== held.root || row.package_digest !== employeeAgentTransferDigest(held.value)
        || row.package_json !== canonical(held.value) || row.receipt_json !== canonical(held.receipt)) return null;
      importedReadback(held.value, held.root); const a = owner(), t = held.value.ticket;
      return workSnapshot({ protocol: 'agentlas.business.original-company-agent.v1', organizationSession: a.orgSession,
        associationId: a.associationId, associationRevision: a.associationRevision,sourceKind:'transfer',registrationId:null, agentResourceId: t.target.agentResourceId,
        agentId: t.target.agentId, employeePrincipalId: t.target.employeePrincipalId, transferId: t.transferId,
        packageDigest: row.package_digest, sourceAgentId: t.source.agentId, sourceRevision: t.source.revision,
        targetRevision: held.receipt.targetRevision, rootPath: held.root, entryPath: t.files.find(f => f.kind === 'definition')!.path,
        approvedPaths: t.files.map(f => f.path), files: t.files, native: a.native });
    } catch { return null; }
  }
  async function refreshInstalledAgent(capability: object, confirm: (transferId: string) => Promise<EmployeeAgentTransferReceipt>) {
    const held = capturedAssets.get(capability); if (!held || !readInstalledAgent(capability)) fail('installed_agent_changed');
    await input.refresh(); if (!employeeAgentTransferReceiptMatches(await confirm(held.value.ticket.transferId), held.value) || !readInstalledAgent(capability)) fail('installed_agent_changed');
  }
  return Object.freeze({ acceptExport, originalExport, markAttempt, settleExport, importCommitted, installedTransfer, captureInstalledAgent, readInstalledAgent, refreshInstalledAgent, installationAck, claimInstallationAck, settleInstallationAck });
}
