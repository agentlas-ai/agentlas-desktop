import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { userDataPath } from '../runtime-paths';
import type { FinanceScope } from './store';

export const FINANCE_RECEIPT_GROUPS = ['summary', 'dashboard', 'report', 'monitor', 'source', 'warnings', 'narrative', 'asset'] as const;
type Group = typeof FINANCE_RECEIPT_GROUPS[number];
const Scalar = z.union([z.string().max(200000), z.number().finite(), z.boolean(), z.null()]);
const Fact = z.object({ group: z.enum(FINANCE_RECEIPT_GROUPS), field: z.string().max(500), value: Scalar }).strict();
type Fact = z.infer<typeof Fact>;
const Receipt = z.object({
  schemaVersion: z.literal('finance.observation.v1'), id: z.string().uuid(), owner: z.string().regex(/^[a-f0-9]{64}$/),
  chatId: z.string().min(1).max(200), runId: z.string().min(1).max(200), operation: z.string().regex(/^finance\.[a-z.]+$/),
  observedAt: z.string().datetime(), basis: z.enum(['service-result', 'saved-result', 'read-snapshot']),
  facts: z.array(Fact).max(40000), digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Receipt = z.infer<typeof Receipt>;
export type FinanceReceiptReference =
  | { status: 'recorded'; id: string; digest: string; basis: Receipt['basis']; observedAt: string }
  | { status: 'unavailable'; reason: 'finance_receipt_not_recorded'; operationOutcome: 'succeeded' };
export const FinanceReceiptReadSchema = z.object({ receiptId: z.string().uuid(), group: z.enum(FINANCE_RECEIPT_GROUPS).default('summary'), index: z.number().int().nonnegative().default(0), offset: z.number().int().nonnegative().default(0) }).strict();
export type FinanceReceiptReadInput = z.input<typeof FinanceReceiptReadSchema>;
type Binding = { chatId: string; runId: string };
const MAX_BYTES = 8 * 1024 * 1024;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Allowlisted observations only, never model arguments, account identifiers, arbitrary provider rows or credentials. */
function observations(data: unknown): Fact[] {
  const facts: Fact[] = [];
  const add = (group: Group, field: string, value: unknown) => { if (value !== undefined) facts.push(Fact.parse({ group, field, value })); };
  const fields = (group: Group, prefix: string, value: unknown, names: string[]) => { const row = object(value); for (const key of names) add(group, `${prefix}${key}`, row[key]); };
  const warnings = (prefix: string, value: unknown) => array(value).forEach((v, i) => add('warnings', `${prefix}${i}]`, v));
  const report = (value: unknown, prefix: string) => {
    const r = object(value);
    fields('report', prefix, r, ['id', 'title', 'createdAt', 'sourceRevision', 'reviewPending', 'parentReportId']);
    add('report', `${prefix}contentDigest`, digest(r));
    array(r.sections).forEach((s, i) => { const section = object(s); const p = `${prefix}sections[${i}].`;
      fields('report', p, section, ['id', 'title', 'kind']); add('narrative', `${p}narrative`, section.narrative);
      fields('report', `${p}projection.`, section.projection, ['status', 'asOf']);
      warnings(`${p}warnings[`, object(section.projection).warnings);
    });
  };
  const root = object(data), workspace = root.workspace ? object(root.workspace) : root.workspaceSnapshot ? object(root.workspaceSnapshot) : root;
  fields('summary', '', workspace, ['revision', 'activeDashboardId']);
  fields('summary', '', root, ['workspaceRevision', 'reportId', 'status', 'asOf', 'retrievedAt', 'provider', 'automationId', 'executionAvailability', 'archiveId', 'sha256']);
  fields('summary', 'reclaimed.', root.reclaimed, ['reports', 'sources']);
  fields('summary', 'restored.', root.restored, ['reports', 'sources']);
  array(workspace.dashboards).forEach((d, i) => {
    const p = `dashboards[${i}].`; fields('dashboard', p, d, ['id', 'name', 'period']);
    array(object(d).widgets).forEach((w, n) => fields('dashboard', `${p}widgets[${n}].`, w, ['id', 'title', 'type', 'metric', 'period', 'hidden']));
  });
  array(workspace.reports).forEach((r, i) => report(r, `reports[${i}].`));
  if (root.report) report(root.report, 'report.');
  array(workspace.sources).forEach((s, i) => {
    fields('source', `sources[${i}].`, s, ['id', 'name', 'kind', 'status', 'url', 'asOf', 'retrievedAt']);
    add('warnings', `sources[${i}].note`, object(s).note);
  });
  const monitorFields = ['id', 'monitorId', 'name', 'status', 'reportId', 'sourceRevision', 'startedAt', 'finishedAt', 'lastCheckedAt', 'nextCheckAt', 'automationId', 'executionAvailability', 'scheduleHuman', 'error'];
  array(workspace.monitors).forEach((m, i) => { fields('monitor', `monitors[${i}].`, m, monitorFields); add('warnings', `monitors[${i}].note`, object(m).note); });
  array(root.runs).forEach((r, i) => { fields('monitor', `runs[${i}].`, r, monitorFields); warnings(`runs[${i}].warnings[`, object(r).warnings); });
  if (root.monitorId) fields('monitor', '', root, monitorFields);
  if (root.summary !== undefined) add('narrative', 'summary', root.summary);
  warnings('warnings[', root.warnings);
  array(root.providers).forEach((p, i) => fields('source', `providers[${i}].`, p, ['id', 'label', 'status', 'coverage', 'rights']));
  array(root.sourceUrls).forEach((url, i) => add('source', `sourceUrls[${i}]`, url));
  const assets = root.assets ?? workspace.watchlist;
  array(assets).forEach((a, i) => fields('asset', `assets[${i}].`, a, ['id', 'symbol', 'name', 'currency', 'exchange', 'kind']));
  return facts;
}

/** Host-only immutable local observations, not signatures or Goal/domain-success proof. */
export class FinanceReceiptStore {
  constructor(private readonly root: string) {}
  private directory(scope: FinanceScope, binding: Binding, create: boolean): { directory: string; owner: string } {
    scope.assertCurrent();
    if (![scope.workspaceId, scope.userId, binding.chatId, binding.runId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 200)) throw new Error('finance_receipt_scope_invalid');
    const owner = digest([scope.workspaceId, scope.userId]), directory = path.join(this.root, owner);
    for (const dir of [this.root, directory]) {
      if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('finance_receipt_store_invalid');
    }
    return { directory, owner };
  }
  record(scope: FinanceScope, binding: Binding, operation: string, data: unknown, basis: Receipt['basis']): FinanceReceiptReference {
    scope.assertCurrent();
    try {
      const { directory, owner } = this.directory(scope, binding, true);
      const body = { schemaVersion: 'finance.observation.v1' as const, id: randomUUID(), owner, chatId: binding.chatId, runId: binding.runId, operation, observedAt: new Date().toISOString(), basis, facts: observations(data) };
      const receipt = Receipt.parse({ ...body, digest: digest(body) }), bytes = JSON.stringify(receipt);
      if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('finance_receipt_too_large');
      scope.assertCurrent();
      // Exclusive create; readers reject incomplete files. Never overwrite or replay the original operation.
      fs.writeFileSync(path.join(directory, `${receipt.id}.json`), bytes, { flag: 'wx', mode: 0o600 });
      scope.assertCurrent();
      return { status: 'recorded', id: receipt.id, digest: receipt.digest, basis, observedAt: receipt.observedAt };
    } catch {
      scope.assertCurrent();
      return { status: 'unavailable', reason: 'finance_receipt_not_recorded', operationOutcome: 'succeeded' };
    }
  }
  read(scope: FinanceScope, binding: Binding, input: FinanceReceiptReadInput): Record<string, unknown> {
    const args = FinanceReceiptReadSchema.parse(input), { directory, owner } = this.directory(scope, binding, false);
    const file = path.join(directory, `${args.receiptId}.json`), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('finance_receipt_invalid');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let receipt: Receipt;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile() || opened.size > MAX_BYTES) throw new Error('finance_receipt_invalid');
      receipt = Receipt.parse(JSON.parse(fs.readFileSync(fd, 'utf8')));
    } finally { fs.closeSync(fd); }
    scope.assertCurrent();
    const { digest: expected, ...body } = receipt;
    if (receipt.id !== args.receiptId || receipt.owner !== owner || receipt.chatId !== binding.chatId || digest(body) !== expected) throw new Error('finance_receipt_binding_mismatch');
    // Same authenticated chat may read from a later verification/retry run; provenance retains the original run.
    const facts = receipt.facts.filter(f => f.group === args.group);
    if (args.index > facts.length || (args.index === facts.length && (facts.length !== 0 || args.offset !== 0))) throw new Error('finance_receipt_cursor_invalid');
    const fact = facts[args.index];
    const base = { receiptId: receipt.id, operation: receipt.operation, observedAt: receipt.observedAt, basis: receipt.basis, state: 'prior-snapshot', digest: receipt.digest, group: args.group, total: facts.length };
    if (!fact) return { ...base, item: null, nextCursor: null };
    const chars = typeof fact.value === 'string' ? Array.from(fact.value) : null;
    if ((chars && args.offset > chars.length) || (!chars && args.offset !== 0)) throw new Error('finance_receipt_cursor_invalid');
    const page = (length: number) => {
      const end = args.offset + length, complete = !chars || end === chars.length;
      return { ...base, item: { field: fact.field, index: args.index, offset: args.offset, value: chars ? chars.slice(args.offset, end).join('') : fact.value, complete },
        nextCursor: !complete ? { index: args.index, offset: end } : args.index + 1 < facts.length ? { index: args.index + 1, offset: 0 } : null };
    };
    let low = 0, high = chars ? chars.length - args.offset : 0;
    if (financeReceiptWireLength(page(0)) >= 1200) throw new Error('finance_receipt_projection_too_large');
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (financeReceiptWireLength(page(mid)) < 1200) low = mid; else high = mid - 1; }
    if (chars && args.offset < chars.length && low === 0) throw new Error('finance_receipt_projection_too_large');
    scope.assertCurrent(); return page(low);
  }
}

/** Includes the actual nested MCP text envelope and harness receipt overhead; not only the inner facts. */
export function financeReceiptWireLength(data: unknown): number {
  const result = { schemaVersion: 'agentlas.harness-result.v1', operationId: 'finance.receipt.read', status: 'ok', data, receiptId: `hr_${'0'.repeat(36)}` };
  return JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: null, _meta: null }).length;
}
export function financeReceiptStore(): FinanceReceiptStore { return new FinanceReceiptStore(userDataPath(path.join('finance', 'receipts'))); }
