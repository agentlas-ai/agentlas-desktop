import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FINANCE_ANALYST_LIMITS, FinanceAnalystDraftSchema, FinanceAnalystRefSchema, FinanceAnalystRefsSchema, FinanceAnalystRequestSchema, type FinanceAnalyst, type FinanceAnalystDraft, type FinanceAnalystRef, type FinanceAnalystRequest, type FinanceAnalystResult } from '../../shared/finance-analysts';
import type { FinanceScope } from './store';

const lockfile = require('proper-lockfile') as { lock(directory: string, options: unknown): Promise<() => Promise<void>> };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const MAX_SKILL_BYTES = 64 * 1024, MAX_CATALOG_BYTES = 32 * 1024;
const customRef = FinanceAnalystRefSchema.refine(ref => ref.id.startsWith('custom-'));
const CatalogSchema = z.object({ schemaVersion: z.literal(1), ownerScope: z.string().regex(/^[a-f0-9]{64}$/), items: z.array(customRef).max(FINANCE_ANALYST_LIMITS.custom).refine(items => new Set(items.map(item => item.id)).size === items.length) }).strict();
type Catalog = z.infer<typeof CatalogSchema>;
/** JSON-quoted YAML scalars and an exact body make each revision a canonical SKILL.md, never an agent definition. */
function skillBytes(draft: FinanceAnalystDraft): Buffer {
  return Buffer.from(`---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description)}\n---\n${draft.instructions}`, 'utf8');
}
function readSkill(bytes: Buffer): FinanceAnalystDraft {
  const match = /^---\nname: ("[^\n]*")\ndescription: ("[^\n]*")\n---\n([\s\S]*)$/.exec(bytes.toString('utf8'));
  if (!match) throw new Error('finance_analyst_skill_invalid');
  try {
    const draft = FinanceAnalystDraftSchema.parse({ name: JSON.parse(match[1]), description: JSON.parse(match[2]), instructions: match[3] });
    if (!skillBytes(draft).equals(bytes)) throw new Error('noncanonical');
    return draft;
  } catch { throw new Error('finance_analyst_skill_invalid'); }
}
const builtinDrafts: Array<FinanceAnalystDraft & { id: FinanceAnalyst['id'] }> = [
  { id: 'builtin:value', name: 'Value', description: 'Assess business value, financial resilience, and valuation assumptions.', instructions: '# Value research\n\nAssess the selected company using available filings and dated observations. Examine normalized earnings, cash conversion, balance-sheet resilience, capital allocation, and valuation sensitivity. Distinguish reported facts, adjustments, and assumptions. Explain downside cases and evidence that would change the thesis. Do not invent financial values, peers, or an investment universe. Use price, currency, period, and return definitions consistently; identify missing data rather than treating it as zero.' },
  { id: 'builtin:growth', name: 'Growth', description: 'Examine durable growth, unit economics, reinvestment, and financing risk.', instructions: '# Growth research\n\nEvaluate observed revenue growth, margins, customer concentration, reinvestment, dilution, and funding needs for the selected assets. Separate organic growth from acquisitions and currency effects when evidence permits. Assess competitive durability and unit economics only where supported. Present assumptions and counterevidence alongside the thesis; do not extrapolate unavailable observations or invent addressable markets. Label scenarios as assumptions and distinguish publication dates from the periods measured.' },
  { id: 'builtin:income', name: 'Income', description: 'Evaluate distribution coverage, sustainability, and income-related risks.', instructions: '# Income research\n\nExamine distributions, cash-flow coverage, payout policy, leverage, and refinancing risk using available dated evidence. Separate recurring income from capital returns or exceptional distributions. Distinguish historical distributions, indicated yield, and assumed future income. Consider rates, currency, fees, and tax assumptions explicitly where relevant. Do not imply guaranteed income or substitute missing distributions with zero. State the evidence and conditions that could undermine sustainability.' },
  { id: 'builtin:etf', name: 'ETF', description: 'Analyze fund exposures, holdings coverage, costs, and implementation risks.', instructions: '# ETF research\n\nUse verified fund identities and dated holdings to examine exposure, concentration, overlap, costs, and liquidity. Report holdings coverage and partial look-through explicitly. Separate market price from NAV, price return from total return, and fund currency from underlying currency exposures. Do not treat derivatives, leverage, or inverse strategies as simple cash holdings. Explain assumptions behind overlap or allocation calculations and avoid summing incompatible currencies or observation dates. Do not invent holdings or fund coverage.' },
];
function builtins(): FinanceAnalyst[] { return builtinDrafts.map(({ id, ...draft }) => ({ ...draft, id, revision: hash(skillBytes(draft)), origin: 'builtin' })); }
async function checkDirectory(directory: string): Promise<boolean> {
  const parent = path.dirname(directory);
  if (parent !== directory && !await checkDirectory(parent)) return false;
  try { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('finance_analyst_path_invalid'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function ensureDirectory(directory: string): Promise<void> {
  if (await checkDirectory(directory)) return;
  const parent = path.dirname(directory); if (parent !== directory) await ensureDirectory(parent);
  try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!await checkDirectory(directory)) throw new Error('finance_analyst_path_invalid');
}
async function readBytes(file: string, max: number): Promise<Buffer> {
  if (!await checkDirectory(path.dirname(file))) throw new Error('finance_analyst_file_missing');
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('finance_analyst_file_invalid');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) throw new Error('finance_analyst_file_invalid'); const bytes = await handle.readFile(); if (bytes.length > max) throw new Error('finance_analyst_file_invalid'); return bytes; }
  finally { await handle.close(); }
}
/** Host-only owner-partitioned skill storage. No Electron, model execution, network, or global skill installation. */
export class FinanceAnalystLibrary {
  constructor(private readonly root: string) {}
  private location(scope: FinanceScope): { directory: string; owner: string } {
    scope.assertCurrent(); if (!scope.workspaceId || !scope.userId) throw new Error('finance_sign_in_required');
    const owner = hash(JSON.stringify([scope.workspaceId, scope.userId])); return { directory: path.join(path.resolve(this.root), owner), owner };
  }
  private async catalog(scope: FinanceScope, directory: string, owner: string): Promise<Catalog> {
    if (!await checkDirectory(directory)) { scope.assertCurrent(); return { schemaVersion: 1, ownerScope: owner, items: [] }; }
    let bytes: Buffer;
    try { bytes = await readBytes(path.join(directory, 'catalog.json'), MAX_CATALOG_BYTES); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // An unpublished first write may leave immutable content. Never silently turn it into an empty library.
      const versions = path.join(directory, 'versions');
      if (await checkDirectory(versions) && (await fs.readdir(versions)).length) throw new Error('finance_analyst_catalog_missing');
      scope.assertCurrent(); return { schemaVersion: 1, ownerScope: owner, items: [] };
    }
    let catalog: Catalog;
    try { catalog = CatalogSchema.parse(JSON.parse(bytes.toString('utf8'))); } catch { throw new Error('finance_analyst_catalog_invalid'); }
    scope.assertCurrent(); if (catalog.ownerScope !== owner) throw new Error('finance_analyst_owner_mismatch'); return catalog;
  }
  private async custom(scope: FinanceScope, directory: string, ref: FinanceAnalystRef): Promise<FinanceAnalyst> {
    let bytes: Buffer;
    try { bytes = await readBytes(path.join(directory, 'versions', ref.revision, 'SKILL.md'), MAX_SKILL_BYTES); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).message === 'finance_analyst_file_missing') throw new Error('finance_analyst_skill_missing'); throw error; }
    scope.assertCurrent(); if (hash(bytes) !== ref.revision) throw new Error('finance_analyst_integrity_failed');
    return { ...readSkill(bytes), ...ref, origin: 'custom' };
  }
  private async items(scope: FinanceScope, directory: string, catalog: Catalog): Promise<FinanceAnalyst[]> {
    const result = builtins(); for (const ref of catalog.items) result.push(await this.custom(scope, directory, ref)); scope.assertCurrent(); return result;
  }
  async list(scope: FinanceScope): Promise<FinanceAnalystResult> {
    const { directory, owner } = this.location(scope), catalog = await this.catalog(scope, directory, owner);
    return { items: await this.items(scope, directory, catalog) };
  }
  async resolve(scope: FinanceScope, input: FinanceAnalystRef[]): Promise<FinanceAnalyst[]> {
    const refs = FinanceAnalystRefsSchema.parse(input), { directory, owner } = this.location(scope);
    if (!refs.length) { scope.assertCurrent(); return []; }
    const catalog = await this.catalog(scope, directory, owner), available = await this.items(scope, directory, catalog);
    const selected = refs.map(ref => { const item = available.find(item => item.id === ref.id); if (!item) throw new Error('finance_analyst_not_found'); if (item.revision !== ref.revision) throw new Error('finance_analyst_revision_conflict'); return item; });
    const current = await this.catalog(scope, directory, owner);
    for (const item of selected.filter(item => item.origin === 'custom')) if (!current.items.some(ref => ref.id === item.id && ref.revision === item.revision)) throw new Error('finance_analyst_revision_conflict');
    scope.assertCurrent(); return selected;
  }
  private async persistSkill(scope: FinanceScope, directory: string, draft: FinanceAnalystDraft): Promise<string> {
    const bytes = skillBytes(draft), revision = hash(bytes), versionDirectory = path.join(directory, 'versions', revision);
    await ensureDirectory(versionDirectory); scope.assertCurrent();
    const file = path.join(versionDirectory, 'SKILL.md');
    try { const existing = await readBytes(file, MAX_SKILL_BYTES); if (!existing.equals(bytes)) throw new Error('finance_analyst_integrity_failed'); return revision; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = path.join(versionDirectory, `.${randomUUID()}.tmp`), handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { scope.assertCurrent(); await checkDirectory(versionDirectory); await fs.link(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await fs.unlink(temporary).catch(() => undefined); }
    const verified = await readBytes(file, MAX_SKILL_BYTES); scope.assertCurrent(); if (!verified.equals(bytes)) throw new Error('finance_analyst_integrity_failed'); return revision;
  }
  private async publish(scope: FinanceScope, directory: string, catalog: Catalog): Promise<void> {
    const file = path.join(directory, 'catalog.json'), temporary = path.join(directory, `.catalog-${randomUUID()}.tmp`);
    const bytes = Buffer.from(JSON.stringify(CatalogSchema.parse(catalog)));
    if (bytes.length > MAX_CATALOG_BYTES) throw new Error('finance_analyst_catalog_invalid');
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      scope.assertCurrent(); await checkDirectory(directory);
      try { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('finance_analyst_file_invalid'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      scope.assertCurrent(); await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
  async handle(scope: FinanceScope, input: FinanceAnalystRequest): Promise<FinanceAnalystResult> {
    const request = FinanceAnalystRequestSchema.parse(input);
    if (request.action === 'list') return this.list(scope);
    if (request.id?.startsWith('builtin:')) throw new Error('finance_analyst_builtin_immutable');
    const { directory, owner } = this.location(scope);
    await ensureDirectory(directory); scope.assertCurrent();
    const release = await lockfile.lock(directory, { realpath: false, stale: 15000, retries: { retries: 40, minTimeout: 20, maxTimeout: 250 } });
    try {
      scope.assertCurrent(); const catalog = await this.catalog(scope, directory, owner);
      await this.items(scope, directory, catalog); // Fail closed on any corrupt active skill.
      const current = request.id ? catalog.items.find(item => item.id === request.id) : undefined;
      if (request.id && !current) throw new Error('finance_analyst_not_found');
      if (current && current.revision !== request.expectedRevision) throw new Error('finance_analyst_revision_conflict');
      if (request.action === 'remove') catalog.items = catalog.items.filter(item => item.id !== request.id);
      else {
        if (!current && catalog.items.length >= FINANCE_ANALYST_LIMITS.custom) throw new Error('finance_analyst_capacity_reached');
        // Publish an empty, verified head before the first immutable version: a crash can leave an orphan, never a lost catalog.
        try { await fs.lstat(path.join(directory, 'catalog.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.publish(scope, directory, catalog); }
        const revision = await this.persistSkill(scope, directory, request.draft), id = current?.id ?? `custom-${randomUUID()}`;
        catalog.items = [...catalog.items.filter(item => item.id !== id), { id, revision }];
      }
      await this.publish(scope, directory, catalog);
      return { items: await this.items(scope, directory, catalog) };
    } finally { await release(); }
  }
}
