import { createHash } from "node:crypto";
import { getMemoryDb, getMemoryStoreInfo } from "./database";
import { insertMemoryEntry, supersedeMemoryEntries, memoryAudienceKey } from "./store";
import { invalidateMemoryContinuationAfterOwnerEdit, revokeOneMemoryEntry } from "./revocations";
import { projectCanonicalMemorySupersedes } from "./graph";
import { memoryAuthorityOwnerKeys, memoryContentHash } from "./revocations";
import { sameMemoryActor, isOneMemoryActor } from "../../shared/memory-actor-family";
import { nativeTextsFor } from "./native-text";
import { looksSecret } from "../../shared/secret-patterns";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";
import type { DesktopMemoryTarget, DesktopMemoryMutationResult } from "../../shared/desktop-memory-inspector";
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
export function ownedMemoryRecord(id: string): OwnerMemoryRecord {
  const db = getMemoryDb(), store = getMemoryStoreInfo();
  const row = db.prepare(`${ownerMemorySelect} WHERE m.id=?`).get(id) as OwnerMemoryRecord | undefined;
  if (!row || (row.owner_namespace && row.owner_namespace !== store.ownerNamespace)
    || (!row.owner_namespace && !store.ownerNamespace.startsWith("device-local:"))) throw new Error("memory_owner_target_unavailable");
  return row;
}
export function memoryTargetRevision(row: OwnerMemoryRecord): string {
  const db = getMemoryDb();
  return hash([row,nativeTextsFor("memory_entry",[row.id]).get(row.id) ?? null,
    db.prepare("SELECT source_kind,source_id,source_revision,relation FROM memory_origin_links WHERE memory_id=? ORDER BY source_kind,source_id,source_revision,relation").all(row.id),
    db.prepare("SELECT project_id,relation,source_ref FROM memory_project_links WHERE memory_id=? ORDER BY project_id,relation,source_ref").all(row.id)]);
}
function validateInput(input: unknown,edit:boolean): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key=>!["memoryId","ownerRef","actorId","expectedRevision","expectedEpoch",...(edit?["content"]:[])].includes(key))) throw new Error("memory_owner_target_invalid");
}
function assertTarget(input: DesktopMemoryTarget): OwnerMemoryRecord {
  if (!input || typeof input.memoryId !== "string" || input.memoryId.length > 512
    || typeof input.ownerRef !== "string" || typeof input.expectedRevision !== "string"
    || typeof input.actorId !== "string" || !input.actorId || !Number.isInteger(input.expectedEpoch)) throw new Error("memory_owner_target_invalid");
  const store = getMemoryStoreInfo();
  if (input.ownerRef !== currentMemoryOwnerRef() || input.expectedEpoch !== store.revocationEpoch) throw new Error("memory_owner_custody_changed");
  const row = ownedMemoryRecord(input.memoryId);
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
    if (old.sensitivity === "secret") throw new Error("memory_owner_edit_restricted");
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
      evidence:[`owner-edit:${old.id}`,`supersedes:${old.id}`],curationActor:"host_admitted",policyVersion:"agentlas.owner-memory-edit.v1",
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
  return receipt;
}
export function forgetOwnedMemory(input: DesktopMemoryTarget): DesktopMemoryMutationResult {
  validateInput(input,false);
  const db = getMemoryDb();
  const forgotten = db.transaction(() => {
    assertTarget(input);
    const receipt = revokeOneMemoryEntry(input.memoryId,input.actorId!,{bindingActor:true});
    if (!receipt) throw new Error("memory_owner_target_unavailable");
    return receipt;
  }).immediate();
  // Reuse the known projection cleanup path, never delete a UI/Graph node as memory authority.
  for (const projectPath of forgotten.projectPaths) for (const contentHash of [forgotten.contentHash,...forgotten.nativeContentHashes]) {
    try { forgetProjectMemoryProjection(projectPath,forgotten.kind,contentHash,forgotten.forgottenAt); } catch { /* Canonical cleanup receipts remain retryable. */ }
  }
  for (const slug of findAgentNestExperienceSlugs(forgotten.sourceMemoryIds)) {
    try { forgetAgentNestExperienceMemory(slug,forgotten.sourceMemoryIds,forgotten.forgottenAt); } catch { /* Same canonical cleanup outbox. */ }
  }
  return result(input.memoryId,null,forgotten.sourceMemoryIds);
}
