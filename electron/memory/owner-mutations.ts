import { noteHumanForget } from "./shared-ids";
import { createHash } from "node:crypto";
import path from "node:path";
import { notifyMemoryRowsChanged } from "./memory-written-signal";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { insertMemoryEntry, locateEntryStore, newRowLeavesRoot, supersedeMemoryEntries, memoryAudienceKey } from "./store";
import { memoryRoot } from "./database";
import { openStore, type StoreRef } from "./stores";
import { withoutNullK1 } from "./store-columns";
import { finishForgetInStores, finishOlderVersions, invalidateMemoryContinuationAfterOwnerEdit, revokeOneMemoryEntry } from "./revocations";
import { projectCanonicalMemorySupersedes } from "./graph";
import { memoryAuthorityOwnerKeys, memoryContentHash } from "./revocations";
import { sameMemoryActor, isOneMemoryActor } from "../../shared/memory-actor-family";
import { nativeTextsFor } from "./native-text";
import { looksSecret } from "../../shared/secret-patterns";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import type { DesktopMemoryTarget, DesktopMemoryMutationResult } from "../../shared/desktop-memory-inspector";
import { originEvidenceRefs } from "./run-evidence";
import { findAgentNestExperienceSlugs, forgetAgentNestExperienceMemory, forgetProjectMemoryProjection } from "./project-files";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function currentMemoryOwnerRef(): string { return hash(["memory-owner-view.v1",getMemoryStoreInfo().ownerNamespace]); }
export interface OwnerMemoryRecord {
  id: string; scope: MemoryScope; kind: MemoryKind; content: string; project_id: string | null; project_path: string | null;
  agent_id: string | null; chat_id: string | null; confidence: "high" | "medium" | "low";
  sensitivity: "public" | "internal" | "private" | "confidential" | "secret";
  evidence_json: string; context_json: string; created_at: string; superseded_at: string | null; embedding_json: string | null;
  owner_namespace: string | null; actor_id: string | null; applicability_json: string | null; origin_refs_json: string | null;
  curation_actor: string | null; policy_version: string | null; binding_revision: number | null;
}
export const ownerMemorySelect = `SELECT m.*,b.owner_namespace,b.actor_id,b.applicability_json,b.origin_refs_json,
  b.curation_actor,b.policy_version,b.revision AS binding_revision
  FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id`;
export function learningActor(row: OwnerMemoryRecord): string | null { return row.actor_id?.trim() || row.agent_id || null; }
// 2.0 K1: the revision token is a hash of the whole row; a file that gained four empty columns must not change the token of a line (withoutNullK1), or every open edit window of the screen and the phone would read "changed".
/** a record read from another store (layout switch not OFF) carries its store in a NON-enumerable property — the revision hash and every JSON of the record stay as they were for root rows. */
const STORE_OF = Symbol.for("agentlas.memory-store-of");
export function recordStore(row: OwnerMemoryRecord): StoreRef | null { return ((row as unknown as Record<symbol, StoreRef | undefined>)[STORE_OF]) ?? null; }
function storeHandle(ref: StoreRef) {
  const info = getMemoryStoreInfo();
  return openStore(ref, info.ownerNamespace, getMemoryDb(), memoryRoot()).store;
}
function recordInStores(id: string): OwnerMemoryRecord | undefined {
  const ref = locateEntryStore(id);
  if (!ref) return undefined;
  const opened = storeHandle(ref);
  if (!opened) return undefined;
  const row = opened.db.prepare(`${ownerMemorySelect} WHERE m.id=?`).get(id) as OwnerMemoryRecord | undefined;
  if (!row || opened.withheld.has(row.id)) return undefined;
  Object.defineProperty(row, STORE_OF, { value: ref, enumerable: false });
  return row;
}
export function ownedMemoryRecord(id: string): OwnerMemoryRecord {
  const db = getMemoryDb(), store = getMemoryStoreInfo();
  const row = (db.prepare(`${ownerMemorySelect} WHERE m.id=?`).get(id) as OwnerMemoryRecord | undefined) ?? recordInStores(id);
  if (!row || (row.owner_namespace && row.owner_namespace !== store.ownerNamespace)
    || (!row.owner_namespace && !store.ownerNamespace.startsWith("device-local:"))) throw new Error("memory_owner_target_unavailable");
  return row;
}
export function memoryTargetRevision(row: OwnerMemoryRecord): string {
  const ref = recordStore(row);
  if (ref) {
    const opened = storeHandle(ref);
    if (!opened) return hash([withoutNullK1(row), null, [], []]);
    const sub = opened.db;
    let native: string | null = null;
    try { native = (sub.prepare("SELECT content_native FROM memory_entry_native WHERE entry_id=?").get(row.id) as { content_native: string } | undefined)?.content_native ?? null; } catch { /* no twin table in this store */ }
    return hash([withoutNullK1(row), native,
      sub.prepare("SELECT source_kind,source_id,source_revision,relation FROM memory_origin_links WHERE memory_id=? ORDER BY source_kind,source_id,source_revision,relation").all(row.id),
      sub.prepare("SELECT project_id,relation,source_ref FROM memory_project_links WHERE memory_id=? ORDER BY project_id,relation,source_ref").all(row.id)]);
  }
  const db = getMemoryDb();
  return hash([withoutNullK1(row),nativeTextsFor("memory_entry",[row.id]).get(row.id) ?? null,
    db.prepare("SELECT source_kind,source_id,source_revision,relation FROM memory_origin_links WHERE memory_id=? ORDER BY source_kind,source_id,source_revision,relation").all(row.id),
    db.prepare("SELECT project_id,relation,source_ref FROM memory_project_links WHERE memory_id=? ORDER BY project_id,relation,source_ref").all(row.id)]);
}
function validateInput(input: unknown,edit:boolean): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key=>!["memoryId","ownerRef","actorId","expectedRevision","expectedEpoch",...(edit?["content"]:[])].includes(key))) throw new Error("memory_owner_target_invalid");
}
import { personalWriteRefusal } from "../one/write-gate";
function assertTarget(input: DesktopMemoryTarget): OwnerMemoryRecord {
  if (!input || typeof input.memoryId !== "string" || input.memoryId.length > 512
    || typeof input.ownerRef !== "string" || typeof input.expectedRevision !== "string"
    || typeof input.actorId !== "string" || !input.actorId || !Number.isInteger(input.expectedEpoch)) throw new Error("memory_owner_target_invalid");
  const store = getMemoryStoreInfo();
  if (input.ownerRef !== currentMemoryOwnerRef() || input.expectedEpoch !== store.revocationEpoch) throw new Error("memory_owner_custody_changed");
  const row = ownedMemoryRecord(input.memoryId);
  // Audit 59 F-6: a Personal line (scope `user_identity`) is the personal agent's own: a sealed computer (its pack was made) or an away one (it is not the home) takes no edit or forget of it. `home` and `legacy` pass (null).
  if (row.scope === "user_identity") { const refusal = personalWriteRefusal(); if (refusal) throw new Error(refusal); }
  if (!sameMemoryActor(learningActor(row),input.actorId)) throw new Error("memory_owner_actor_changed");
  if (memoryTargetRevision(row) !== input.expectedRevision) throw new Error("memory_owner_revision_changed");
  let applicability: { enabled?: boolean }; try { applicability = JSON.parse(row.applicability_json ?? "{}"); } catch { throw new Error("memory_owner_applicability_unknown"); }
  if (row.superseded_at || !row.content || applicability.enabled === false || memoryAudienceKey(row.id) === null) throw new Error("memory_owner_target_inactive");
  return row;
}
function applicationKey(row: OwnerMemoryRecord): string {
  const normalize=(value: unknown,key=""): unknown => {
    if ((key==="actorId" || key==="agentId") && typeof value==="string" && isOneMemoryActor(value)) return "product:One";
    if (Array.isArray(value)) return key==="projectIds" ? [...value].sort() : value.map(item=>normalize(item));
    if (value && typeof value==="object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([field,item])=>[field,normalize(item,field)]));
    return value;
  };
  return JSON.stringify(normalize(JSON.parse(row.applicability_json ?? "{}")));
}
/** Replacement retires exact duplicates only inside the current binding,
 * actual applicability/audience and canonical authority. Raw source ids stay. */
function editedAliases(old: OwnerMemoryRecord): OwnerMemoryRecord[] {
  const ownerKeys=memoryAuthorityOwnerKeys({scope:old.scope,projectId:old.project_id,projectPath:old.project_path,agentId:old.agent_id ?? learningActor(old),chatId:old.chat_id});
  const contentHash=memoryContentHash(old.content),application=applicationKey(old),audience=memoryAudienceKey(old.id);
  const store=getMemoryStoreInfo();
  return (getMemoryDb().prepare(`${ownerMemorySelect} WHERE m.scope=? AND m.kind=? AND m.content<>'' AND m.superseded_at IS NULL`).all(old.scope,old.kind) as OwnerMemoryRecord[]).filter(row=>{
    if (row.owner_namespace ? row.owner_namespace!==store.ownerNamespace : !store.ownerNamespace.startsWith("device-local:")) return false;
    if (!sameMemoryActor(learningActor(row),learningActor(old)) || memoryContentHash(row.content)!==contentHash || memoryAudienceKey(row.id)!==audience) return false;
    try {if (applicationKey(row)!==application) return false;} catch {return false;}
    return memoryAuthorityOwnerKeys({scope:row.scope,projectId:row.project_id,projectPath:row.project_path,agentId:row.agent_id ?? learningActor(row),chatId:row.chat_id}).some(key=>ownerKeys.includes(key));
  });
}
function result(id: string,replacementId: string | null,affected: string[]): DesktopMemoryMutationResult {
  const current = getMemoryStoreInfo();
  return { ok: true,memoryId:id,replacementId,revocationEpoch:current.revocationEpoch,authorityRevision:current.revision,affectedMemoryIds:affected };
}
/** Protected adapter to the existing canonical admission/revoke meanings. The
 * renderer supplies a version fence, never owner namespace, authority or scope. */
export function editOwnedMemory(input: DesktopMemoryTarget & { content: string }): DesktopMemoryMutationResult {
  validateInput(input,true);
  const text = typeof input?.content === "string" ? input.content.trim() : "";
  if (!text || text.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || looksSecret(text)) throw new Error("memory_owner_edit_invalid");
  const db = getMemoryDb();
  const receipt=db.transaction(() => {
    const old = assertTarget(input);
    // editing a row that lives in another store is not built (the replacement and its links would have to be written into that store). Forgetting it is.
    if (recordStore(old)) throw new Error("memory_owner_edit_store_unsupported");
    if (old.sensitivity === "secret") throw new Error("memory_owner_edit_restricted");
    // Audit 62 (memory B8): a line in the root whose replacement would be written into another store (an English text under an agent or project that has its own store) cannot be edited either:
    // the links below are written into the root and would point at a line that is not there, and the replacement would be left in the other store. Refused before anything is written, with the same code.
    if (newRowLeavesRoot({ scope: old.scope, kind: old.kind, content: text, agentId: old.agent_id, projectId: old.project_id, projectPath: old.project_path, chatId: old.chat_id })) throw new Error("memory_owner_edit_store_unsupported");
    const native = nativeTextsFor("memory_entry",[old.id]).get(old.id);
    if (text === old.content || text === native) return result(old.id,null,[]);
    const aliases=editedAliases(old);
    const epoch = invalidateMemoryContinuationAfterOwnerEdit();
    let origins: Array<{ kind: "ticket" | "run" | "source" | "project"; id: string; revision?: string }> = [];
    try { const parsed: unknown = JSON.parse(old.origin_refs_json ?? "[]"); if (Array.isArray(parsed)) origins = parsed.map(ref=>typeof ref === "string"?{kind:"source",id:ref}:ref).filter(ref => ref && typeof ref === "object" && typeof ref.id === "string" && ["ticket","run","source","project"].includes(ref.kind)).slice(0,30); } catch { /* Exact original source rows remain in the audit. */ }
    const applicability = JSON.parse(old.applicability_json ?? "{}") as { recallChannel?: "default" | "legacy_one_overlay"; compatibilityScope?: {scope:"personal"|"project"|"agent"|"team";scopeRef:string|null} };
    const replacement = insertMemoryEntry({ scope:old.scope,kind:old.kind,content:text,
      projectId:old.project_id,projectPath:old.project_path,agentId:old.agent_id,chatId:old.chat_id,
      confidence:old.confidence,sensitivity:old.sensitivity,intakeEpoch:epoch,
      // an edit of a shared line keeps what the line IS (identity, or a boundary with its structure): the column alone cannot say it (the replacement would become a plain fact or a preference).
      ...(keptKindContext(old) ? { requestContext: keptKindContext(old) as never } : {}),
      evidence:[`owner-edit:${old.id}`,`supersedes:${old.id}`,...originMarksOf(old)],curationActor:"host_admitted",policyVersion:"agentlas.owner-memory-edit.v1",
      originRefs:[...origins,{kind:"source",id:old.id,revision:input.expectedRevision}],
      recallChannel:applicability.recallChannel,compatibilityScope:applicability.compatibilityScope });
    // Preserve exact original applicability, including unknown legacy fields;
    // owner editing is not model curation or explicit memory approval.
    db.prepare("UPDATE memory_identity_bindings SET actor_id=?,applicability_json=?,curation_actor='owner_editor',revision=revision+1 WHERE memory_id=?")
      .run(learningActor(old),old.applicability_json ?? "{}",replacement.id);
    for (const source of aliases) {
      db.prepare("INSERT OR IGNORE INTO memory_project_links(memory_id,project_id,relation,source_ref) SELECT ?,project_id,relation,source_ref FROM memory_project_links WHERE memory_id=?").run(replacement.id,source.id);
      db.prepare("INSERT OR IGNORE INTO memory_origin_links(memory_id,source_kind,source_id,source_revision,relation) SELECT ?,source_kind,source_id,source_revision,relation FROM memory_origin_links WHERE memory_id=?").run(replacement.id,source.id);
      db.prepare("INSERT OR IGNORE INTO memory_origin_links VALUES(?,'memory',?,?,'supersedes')").run(replacement.id,source.id,memoryTargetRevision(source));
      let refs: unknown;try {refs=JSON.parse(source.origin_refs_json ?? "[]");} catch {refs=[];}
      if (Array.isArray(refs)) for (const ref of refs.slice(0,64)) {
        const item=typeof ref==="string" ? {kind:"source",id:ref,revision:""}:ref;
        if (item && typeof item==="object" && typeof item.id==="string" && typeof item.kind==="string") db.prepare("INSERT OR IGNORE INTO memory_origin_links VALUES(?,?,?,?,'origin')").run(replacement.id,item.kind,item.id,typeof item.revision==="string"?item.revision:"");
      }
    }
    // Discard the pre-restoration similarity projection; the existing outbox
    // repairs it from the final audience. It never grants recall permission.
    db.prepare("DELETE FROM memory_relation_edges WHERE from_memory_id=? OR to_memory_id=?").run(replacement.id,replacement.id);
    supersedeMemoryEntries(aliases.map(row=>row.id));
    return result(old.id,replacement.id,[...aliases.map(row=>row.id),replacement.id]);
  }).immediate();
  if(receipt.replacementId) try {projectCanonicalMemorySupersedes(receipt.replacementId);} catch { /* Existing canonical outbox retries the derived edge; admission is complete. */ }
  if(receipt.replacementId) notifyMemoryRowsChanged();   // TG: the personal agent's mirror finds the replaced line and the new one by comparing the store
  return receipt;
}
/** The `ticket_kind` and the boundary structure of a Personal line (the two things the columns cannot hold), or null when it has neither. */
function keptKindContext(old: OwnerMemoryRecord): Record<string, unknown> | null {
  if (old.scope !== "user_identity") return null;
  try {
    const c = JSON.parse(old.context_json || "{}") as { ticket_kind?: unknown; boundary?: unknown };
    const out: Record<string, unknown> = {};
    if (c.ticket_kind === "identity" || c.ticket_kind === "boundary") out.ticket_kind = c.ticket_kind;
    if (c.boundary && typeof c.boundary === "object" && !Array.isArray(c.boundary)) out.boundary = c.boundary;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}
/** The origin marks (`origin:instruction`, `origin:owner-spoke`) the edited line carries: the line that replaces it keeps them (none exists with the workspace-rules switch off). */
function originMarksOf(row: OwnerMemoryRecord): string[] {
  try { const parsed: unknown = JSON.parse(row.evidence_json); return Array.isArray(parsed) ? originEvidenceRefs(parsed.filter((item): item is string => typeof item === "string")) : []; } catch { return []; }
}
/**
 * K7': THE forget. Every door ends here - the memory screen (`oneMemory:inspectForget`), the phone's forget, the One memory map (`oneMemory:forgetEntry`), the model's `remove` ticket (`forgetOwnedLine`), the
 * move's purge - so what is forgotten, what is left behind and what is told to the server are the same whichever door the person used:
 *   1. the target's fences are checked (owner, actor, revision, epoch, the Personal write gate) and, in ONE transaction, the stamp, the line, the older versions it replaced, the same words of the SAME owner,
 *      the relations and contradiction marks, the turn records it came from (summary, host facts, observed turn) and the stored answers of the resting-time passes are emptied (`revokeOneMemoryEntry`);
 *   2. then the other stores catch up (their rows are blanked by opening them) and the search indexes beside them are deleted (`finishForgetInStores`), a longer chain is finished (`finishOlderVersions`);
 *   3. then the files that quoted the line (the project's files, the agent nest) and the skills made from it are reported, and the mirror is told (`notifyMemoryRowsChanged`: a forgotten Personal line goes up as `gone`).
 * A kill anywhere is finished by the next open of a store (the stamp is the first thing written); until then the words are hidden by the forget epoch, never visible.
 */
export function forgetOwnedMemory(input: DesktopMemoryTarget, options?: { ownerOnly?: boolean; remote?: boolean }): DesktopMemoryMutationResult {
  validateInput(input,false);
  const db = getMemoryDb();
  const forgotten = db.transaction(() => {
    assertTarget(input);
    // the PERSON's forget of a shared-kind line is told to the server (an `F` row, written before the words are blanked, in this same transaction); a forget that came from another place is not told back.
    if (options?.remote !== true) { try { noteHumanForget(db, input.memoryId); } catch { /* the forget goes on; a line the table could not note is found again by the sync (a blanked line whose stamp says forgotten) */ } }
    const receipt = revokeOneMemoryEntry(input.memoryId,input.actorId!,{bindingActor:true,...(options?.ownerOnly===true?{ownerOnly:true}:{}),...(options?.remote===true?{remote:true}:{})});
    if (!receipt) throw new Error("memory_owner_target_unavailable");
    return receipt;
  }).immediate();
  // The stamp is committed (the transaction above ended): blank the rows other stores held and drop the indexes beside them.
  // with the switch on this also drops the root folder's search index even when no other store held the words. A `partial` is kept as codes
  // (`forgetOpenCodes()`, read by the skipped-stores answer); the inspector's result shape is unchanged.
  // K7': every layout (the engine's search index beside the root store quotes the words with the switch off as well).
  finishForgetInStores(forgotten);
  // A chain of older versions longer than one forget follows: the rest is forgotten now, outside the transaction.
  if (forgotten.olderLeft) finishOlderVersions(forgotten,input.actorId!,{bindingActor:true});
  // Reuse the known projection cleanup path, never delete a UI/Graph node as memory authority.
  // The older versions the line replaced were forgotten with it: their words leave the project files too.
  for (const part of [forgotten,...(forgotten.also ?? [])]) for (const projectPath of part.projectPaths) for (const contentHash of [part.contentHash,...part.nativeContentHashes]) {
    try { forgetProjectMemoryProjection(projectPath,part.kind,contentHash,part.forgottenAt); } catch { /* Canonical cleanup receipts remain retryable. */ }
  }
  for (const slug of findAgentNestExperienceSlugs(forgotten.sourceMemoryIds)) {
    try { forgetAgentNestExperienceMemory(slug,forgotten.sourceMemoryIds,forgotten.forgottenAt); } catch { /* Same canonical cleanup outbox. */ }
  }
  const forgottenResult = result(input.memoryId,null,forgotten.sourceMemoryIds);
  const derivedSkills = derivedSkillsOf(input.actorId,forgotten.sourceMemoryIds);
  notifyMemoryRowsChanged();   // TG: the mirror tells the server a line is gone (the forget stamp is committed above)
  return derivedSkills ? { ...forgottenResult, derivedSkills } : forgottenResult;
}

/** Who is asking to forget a line when the asker is not the memory screen: the conversation a model's `remove` ticket came from (or the resting-time pass that read the turns). */
export interface ForgetSubject {
  /** the personal agent's own conversation: the only one that may forget a Personal line */
  personal: boolean;
  /** the memory actor of the turn (the folder agent, the Work session's host); an agent's line is forgotten by that actor only */
  agentId: string | null;
  projectId?: string | null;
  projectPath?: string | null;
}

const samePath = (a: string | null, b: string | null): boolean => Boolean(a && b && path.resolve(a) === path.resolve(b));

/** Whether a line is the subject's own to forget: Personal -> the personal agent's conversation; an agent's line -> that actor (the One family counts as one); a project's line -> the project the turn is bound to. Anything else (another agent's line, another project's, a session line) is not. */
export function lineBelongsToSubject(row: OwnerMemoryRecord, subject: ForgetSubject): boolean {
  if (row.scope === "user_identity") return subject.personal === true;
  if (row.scope === "agent_repo") return subject.agentId !== null && sameMemoryActor(learningActor(row), subject.agentId);
  if (row.scope === "project") return Boolean((subject.projectId && row.project_id === subject.projectId) || samePath(row.project_path, subject.projectPath ?? null));
  return false;
}

/**
 * K7': the forget of one line by its id, for the doors that have no screen to hold the fences (the model's `remove` ticket, the One memory map, the move's purge): the fences are read now, from the line itself,
 * and the same `forgetOwnedMemory` runs. With a `subject` the line must be the subject's own (`memory_owner_subject_mismatch` otherwise, nothing touched); without one the door says it is the owner's own screen or a host
 * purge. Throws the same codes as the screen's path.
 */
export function forgetOwnedLine(memoryId: string, subject?: ForgetSubject): DesktopMemoryMutationResult {
  const row = ownedMemoryRecord(memoryId);
  if (subject && !lineBelongsToSubject(row, subject)) throw new Error("memory_owner_subject_mismatch");
  const actorId = learningActor(row);
  if (!actorId) throw new Error("memory_owner_target_unavailable");
  // K7''' (junction): a turn that asks for itself (a `subject`) and is not the personal agent's own conversation cannot read Personal, so its forget stays inside the line's own owner; no subject = the owner's own door (map, move), the family is one subject.
  return forgetOwnedMemory({ memoryId: row.id, ownerRef: currentMemoryOwnerRef(), actorId, expectedRevision: memoryTargetRevision(row), expectedEpoch: getMemoryStoreInfo().revocationEpoch }, subject && subject.personal !== true ? { ownerOnly: true } : undefined);
}
/**
 * The skills an applied learning change made from the lines this forget blanked (P 2.3 step 5), for the agent that held them and every agent whose row carries one of the ids. undefined when the
 * lookup could not run: the answer then has no `derivedSkills` key, which says "unknown", never "none". The skills are not changed.
 */
function derivedSkillsOf(actorId: string | null,memoryIds: string[]): Array<{ agentId: string; skillName: string; proposalId: string }> | undefined {
  try {
    const agents = new Set<string>(actorId ? [actorId] : []);
    for (let start=0;start<memoryIds.length;start+=400) {
      const part=memoryIds.slice(start,start+400);
      for (const row of getMemoryDb().prepare(`SELECT DISTINCT agent_id FROM memory_entries WHERE id IN (${part.map(()=>"?").join(",")}) AND agent_id IS NOT NULL`).all(...part) as Array<{ agent_id: string }>) agents.add(row.agent_id);
    }
    const { skillsDerivedFromMemories } = require("../agents/workspace-service") as typeof import("../agents/workspace-service");
    return [...agents].flatMap(agentId => skillsDerivedFromMemories(agentId,memoryIds));
  } catch { return undefined; }
}
