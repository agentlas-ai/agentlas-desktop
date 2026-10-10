import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { PersonalDataTarget, PersonalDataBlock, PersonalDataPageRevision, PersonalDataProposal, PersonalDataSourceState, PersonalDataSourceBatch, PersonalDataSpace, PersonalDataSpaceLink, PersonalDataTaskAnchor, PersonalDataWriteReceipt, PersonalDataSourceItem } from "../../shared/one-personal-data";

export function personalDataError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
export function personalDataHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, canonical(item)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function personalDataId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) throw personalDataError("personal_data_identifier_invalid");
  return value;
}
export function personalDataText(value: unknown, max = 100_000): string {
  if (typeof value !== "string" || value.length > max || value.includes("\u0000")) throw personalDataError("personal_data_text_invalid");
  return value;
}
export function personalDataTarget(raw: PersonalDataTarget): PersonalDataTarget {
  if (!raw || Object.keys(raw).sort().join(",") !== "audience,deploymentId,oneId,organizationId,pageId,projectId,scope,spaceId"
    || !["personal","project","organization"].includes(raw.scope) || !["owner","organization"].includes(raw.audience)
    || raw.scope === "personal" && (raw.organizationId !== null || raw.projectId !== null || raw.audience !== "owner")
    || raw.scope === "project" && raw.projectId === null
    || raw.scope === "organization" && raw.organizationId === null
    || raw.audience === "organization" && raw.organizationId === null) throw personalDataError("personal_data_scope_refused");
  return { deploymentId: personalDataId(raw.deploymentId), oneId: personalDataId(raw.oneId), scope: raw.scope,
    organizationId: raw.organizationId === null ? null : personalDataId(raw.organizationId),
    projectId: raw.projectId === null ? null : personalDataId(raw.projectId), spaceId: personalDataId(raw.spaceId), pageId: personalDataId(raw.pageId), audience: raw.audience };
}
export function personalDataBlocks(blocks: PersonalDataBlock[]): PersonalDataBlock[] {
  if (!Array.isArray(blocks) || blocks.length > 128) throw personalDataError("personal_data_blocks_invalid");
  const seen = new Set<string>();
  return blocks.map(b => {
    const id = personalDataId(b.id);
    if (seen.has(id) || !["manual", "inference"].includes(b.kind) || !Array.isArray(b.sourceRefs) || b.sourceRefs.length > 128) throw personalDataError("personal_data_blocks_invalid");
    seen.add(id);
    if(b.provenance && (b.kind!=="inference" || !Number.isFinite(Date.parse(b.provenance.observedAt))))throw personalDataError("personal_data_provenance_invalid");
    return { id, kind: b.kind, text: personalDataText(b.text), sourceRefs: b.sourceRefs.map(personalDataId),
      ...(b.provenance?{provenance:{...b.provenance,occurrenceId:personalDataId(b.provenance.occurrenceId),sourceRevision:personalDataId(b.provenance.sourceRevision)}}:{}) };
  });
}
type JsonRow = { value_json: string };
type CommandRow = { target_key: string; intent_hash: string; receipt_json: string };
export interface PersonalDataOccurrence { occurrenceId: string; target: PersonalDataTarget; sourceId: string; sourceRevision: number; commandId: string; baseRevision: number; sourceSnapshotRevision: string; observedAt: string; sourceBinding: import("../../shared/one-personal-data").PersonalDataSourceBinding; items: PersonalDataSourceItem[]; receipt: import("../../shared/one-supervisor").SupervisorCommandReceipt | null }

/** Uses Main's existing One DB. Occurrences are reconciliation records, never another work queue. */
export class OnePersonalDataStore {
  constructor(readonly db: Database.Database, private readonly now = () => new Date().toISOString()) {
    db.exec(`CREATE TABLE IF NOT EXISTS one_personal_data_pages(target_key TEXT PRIMARY KEY,target_json TEXT NOT NULL,current_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS one_personal_data_revisions(target_key TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(target_key,revision));
      CREATE TABLE IF NOT EXISTS one_personal_data_spaces(space_key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_personal_data_sources(target_key TEXT NOT NULL,source_id TEXT NOT NULL,value_json TEXT NOT NULL,items_json TEXT NOT NULL,PRIMARY KEY(target_key,source_id));
      CREATE TABLE IF NOT EXISTS one_personal_data_proposals(proposal_id TEXT PRIMARY KEY,target_key TEXT NOT NULL,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_personal_data_occurrences(occurrence_id TEXT PRIMARY KEY,target_key TEXT NOT NULL,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS one_personal_data_commands(command_id TEXT PRIMARY KEY,target_key TEXT NOT NULL,intent_hash TEXT NOT NULL,receipt_json TEXT NOT NULL);`);
  }
  key(target: PersonalDataTarget): string { return personalDataHash(personalDataTarget(target)); }
  atomic<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  private decode<T>(row: JsonRow | undefined): T | null { return row ? JSON.parse(row.value_json) as T : null; }
  page(target: PersonalDataTarget, revision?: number): PersonalDataPageRevision | null {
    const key = this.key(target);
    return this.decode(this.db.prepare(`SELECT value_json FROM one_personal_data_revisions WHERE target_key=? AND revision=${revision === undefined ? "(SELECT current_revision FROM one_personal_data_pages WHERE target_key=?)" : "?"}`).get(key, revision ?? key) as JsonRow | undefined);
  }
  space(target: PersonalDataTarget): PersonalDataSpace | null {
    const t = personalDataTarget(target);
    return this.decode(this.db.prepare("SELECT value_json FROM one_personal_data_spaces WHERE space_key=?").get(personalDataHash([t.deploymentId,t.oneId,t.scope,t.organizationId,t.projectId,t.spaceId,t.audience])) as JsonRow | undefined);
  }
  private link(target: PersonalDataTarget, links: PersonalDataSpaceLink[]): void {
    const current = this.space(target) ?? { spaceId: target.spaceId, revision: 0, links: [] };
    const merged = [...current.links];
    for (const item of links) if (!merged.some(l => l.kind === item.kind && l.ref === item.ref)) merged.push(item);
    const next = { ...current, revision: current.revision + 1, links: merged };
    this.db.prepare("INSERT INTO one_personal_data_spaces VALUES(?,?) ON CONFLICT(space_key) DO UPDATE SET value_json=excluded.value_json")
      .run(personalDataHash([target.deploymentId,target.oneId,target.scope,target.organizationId,target.projectId,target.spaceId,target.audience]),JSON.stringify(next));
  }
  priorWrite(commandId: string, target: PersonalDataTarget, intent: unknown): PersonalDataWriteReceipt | null {
    const row = this.db.prepare("SELECT * FROM one_personal_data_commands WHERE command_id=?").get(personalDataId(commandId)) as CommandRow | undefined;
    if (!row) return null;
    if (row.target_key !== this.key(target) || row.intent_hash !== personalDataHash(intent)) throw personalDataError("personal_data_command_conflict");
    const receipt = JSON.parse(row.receipt_json) as PersonalDataWriteReceipt;
    const exact = this.page(target,receipt.revision);
    if (!exact || exact.digest !== receipt.digest) throw personalDataError("personal_data_readback_mismatch");
    return { ...receipt, page: exact };
  }
  write(input: { commandId: string; target: PersonalDataTarget; expectedRevision: number; title: string; blocks: PersonalDataBlock[]; origin: PersonalDataPageRevision["origin"]; anchor?: PersonalDataTaskAnchor; intent: unknown }): PersonalDataWriteReceipt {
    return this.atomic(() => {
      const target = personalDataTarget(input.target), key = this.key(target);
      const prior = this.priorWrite(input.commandId,target,input.intent); if (prior) return prior;
      const current = this.page(target);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || (current?.revision ?? 0) !== input.expectedRevision) throw personalDataError("personal_data_revision_conflict");
      const title = personalDataText(input.title,500), blocks = personalDataBlocks(input.blocks);
      const revision = input.expectedRevision + 1;
      const acceptedAnchor=input.anchor??null,origin=input.origin;
      const page: PersonalDataPageRevision = { target, revision, title, blocks, digest: personalDataHash({target,revision,title,blocks,acceptedAnchor,origin}), updatedAt: this.now(), origin, acceptedAnchor };
      this.db.prepare("INSERT INTO one_personal_data_revisions VALUES(?,?,?)").run(key,revision,JSON.stringify(page));
      this.db.prepare("INSERT INTO one_personal_data_pages VALUES(?,?,?) ON CONFLICT(target_key) DO UPDATE SET current_revision=excluded.current_revision").run(key,JSON.stringify(target),revision);
      this.link(target,[{kind:"page",ref:target.pageId,label:title},...(input.anchor?.chatId?[{kind:"conversation" as const,ref:personalDataId(input.anchor.chatId),label:"Inference conversation"}]:[]),...(input.anchor ? [{kind:"file" as const,ref:input.anchor.artifactId,label:"Accepted inference artifact"}] : [])]);
      const exact = this.page(target,revision);
      if (!exact || exact.digest !== page.digest) throw personalDataError("personal_data_readback_mismatch");
      const receipt: PersonalDataWriteReceipt = {commandId:input.commandId,target,revision,digest:page.digest,readBackVerified:true,page:exact};
      this.db.prepare("INSERT INTO one_personal_data_commands VALUES(?,?,?,?)").run(personalDataId(input.commandId),key,personalDataHash(input.intent),JSON.stringify(receipt));
      return receipt;
    });
  }
  sources(target: PersonalDataTarget): PersonalDataSourceState[] {
    return (this.db.prepare("SELECT value_json FROM one_personal_data_sources WHERE target_key=? ORDER BY source_id").all(this.key(target)) as JsonRow[]).map(r => JSON.parse(r.value_json));
  }
  source(target: PersonalDataTarget, sourceId: string): PersonalDataSourceState | null { return this.sources(target).find(s=>s.binding.sourceId===sourceId) ?? null; }
  items(target: PersonalDataTarget, sourceId: string): PersonalDataSourceItem[] {
    const row = this.db.prepare("SELECT items_json FROM one_personal_data_sources WHERE target_key=? AND source_id=?").get(this.key(target),personalDataId(sourceId)) as {items_json:string}|undefined;
    return row ? JSON.parse(row.items_json) : [];
  }
  setSource(state: PersonalDataSourceState, expectedRevision: number, items?: PersonalDataSourceItem[]): PersonalDataSourceState {
    const key = this.key(state.target), sourceId = personalDataId(state.binding.sourceId);
    return this.atomic(() => {
      const current = this.source(state.target,sourceId);
      if ((current?.revision ?? 0) !== expectedRevision) throw personalDataError("personal_data_source_revision_conflict");
      const next = { ...state, revision: expectedRevision + 1 };
      this.db.prepare("INSERT INTO one_personal_data_sources VALUES(?,?,?,?) ON CONFLICT(target_key,source_id) DO UPDATE SET value_json=excluded.value_json,items_json=excluded.items_json")
        .run(key,sourceId,JSON.stringify(next),JSON.stringify(items ?? this.items(state.target,sourceId)));
      return next;
    });
  }
  applyBatch(source: PersonalDataSourceState, batch: PersonalDataSourceBatch): PersonalDataSourceState {
    const items = new Map(this.items(source.target,source.binding.sourceId).map(i=>[i.id,i]));
    for (const item of batch.items) items.set(item.id,item);
    if (items.size > 10_000) throw personalDataError("personal_data_retention_limit");
    return this.setSource({ ...source, cursor: batch.nextCursor, sourceRevision: batch.sourceRevision,
      observedAt: batch.observedAt, status: batch.complete ? "ready" : "partial", reason: null },source.revision,[...items.values()]);
  }
  occurrence(occurrenceId: string, target: PersonalDataTarget): PersonalDataOccurrence | null {
    const row = this.db.prepare("SELECT value_json FROM one_personal_data_occurrences WHERE occurrence_id=? AND target_key=?").get(occurrenceId,this.key(target)) as JsonRow | undefined;
    return this.decode(row);
  }
  putOccurrence(value: PersonalDataOccurrence): void {
    const existing = this.db.prepare("SELECT target_key FROM one_personal_data_occurrences WHERE occurrence_id=?").get(value.occurrenceId) as {target_key:string}|undefined;
    if(existing && existing.target_key!==this.key(value.target))throw personalDataError("personal_data_occurrence_conflict");
    const prior = this.occurrence(value.occurrenceId,value.target);
    if (prior && prior.commandId !== value.commandId) throw personalDataError("personal_data_occurrence_conflict");
    this.db.prepare("INSERT INTO one_personal_data_occurrences VALUES(?,?,?) ON CONFLICT(occurrence_id) DO UPDATE SET value_json=excluded.value_json")
      .run(value.occurrenceId,this.key(value.target),JSON.stringify(value));
  }
  proposal(target: PersonalDataTarget, proposalId: string): PersonalDataProposal | null {
    return this.decode(this.db.prepare("SELECT value_json FROM one_personal_data_proposals WHERE proposal_id=? AND target_key=?").get(personalDataId(proposalId),this.key(target)) as JsonRow | undefined);
  }
  proposals(target: PersonalDataTarget): PersonalDataProposal[] {
    return (this.db.prepare("SELECT value_json FROM one_personal_data_proposals WHERE target_key=? ORDER BY rowid DESC LIMIT 100").all(this.key(target)) as JsonRow[]).map(r=>JSON.parse(r.value_json));
  }
  putProposal(proposal: PersonalDataProposal): PersonalDataProposal {
    const existing = this.db.prepare("SELECT target_key FROM one_personal_data_proposals WHERE proposal_id=?").get(proposal.proposalId) as {target_key:string}|undefined;
    if(existing && existing.target_key!==this.key(proposal.target))throw personalDataError("personal_data_proposal_conflict");
    const prior = this.proposal(proposal.target,proposal.proposalId);
    if (prior && (personalDataHash([prior.target,prior.baseRevision,prior.blocks,prior.anchor,prior.sourceBindings]) !== personalDataHash([proposal.target,proposal.baseRevision,proposal.blocks,proposal.anchor,proposal.sourceBindings]) || prior.status !== "pending" && prior.status !== proposal.status)) throw personalDataError("personal_data_proposal_conflict");
    this.db.prepare("INSERT INTO one_personal_data_proposals VALUES(?,?,?) ON CONFLICT(proposal_id) DO UPDATE SET value_json=excluded.value_json")
      .run(personalDataId(proposal.proposalId),this.key(proposal.target),JSON.stringify(proposal));
    return proposal;
  }
}
