import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMemoryDb, getMemoryStoreInfo, type MemoryStoreInfo } from "./database";
import { readMemoryEntryForProjection } from "./store";
import { linkMemoryEntryBySimilarity, projectCanonicalMemorySupersedes } from "./graph";
import { BUILTIN_ONE_AGENT_ID } from "../../shared/builtin-agent-ids";
import { MEMORY_ACTOR_FAMILY_SCHEMA, isOneMemoryActor } from "../../shared/memory-actor-family";

const SCHEMA = "agentlas.memory-view.v1";
const MAX_ROWS = 20_000;
const MAX_BYTES = 12 * 1024 * 1024;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();

interface ViewRow {
  id: string; scope: string; kind: string; content: string; agent_id: string | null; actor_id: string | null;
  project_id: string | null; project_path: string | null; chat_id: string | null;
  confidence: string; sensitivity: string; created_at: string;
  owner_namespace: string | null; origin_refs_json: string | null;
  applicability_json: string | null; curation_actor: string | null; policy_version: string | null;
}
interface ViewManifest {
  schemaVersion: typeof SCHEMA; generated: true; ownerRef: string;
  actorFamilyContract?: typeof MEMORY_ACTOR_FAMILY_SCHEMA;
  authorityRevision: number; revocationEpoch: number;
  files: Array<{ path: string; kind: string; actorId?: string; projectId?: string; count: number }>;
}
interface ViewGroup { kind: string; actorId?: string; projectId?: string; entries: unknown[] }
function ownerRef(info: MemoryStoreInfo): string {
  return createHash("sha256").update(info.ownerNamespace).digest("hex");
}
function viewRoot(info: MemoryStoreInfo): string { return path.join(path.dirname(info.path), "views"); }
function parseObject(value: string | null): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value ?? "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}
/** Generated views are never a second source for import/automatic learning. */
export function isGeneratedMemoryView(value: unknown): boolean {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return false; } }
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).schemaVersion === SCHEMA
    && (value as Record<string, unknown>).generated === true);
}
function realDirectory(base: string, relative = ""): string {
  const root = path.resolve(base);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("memory_view_directory_changed");
  let current = root;
  for (const part of relative.split("/").filter(Boolean)) {
    if (!/^[a-z0-9._-]+$/.test(part) || part === "." || part === "..") throw new Error("memory_view_path_invalid");
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const next = fs.lstatSync(current);
    if (!next.isDirectory() || next.isSymbolicLink()) throw new Error("memory_view_directory_changed");
  }
  return current;
}
function managedJson(file: string, expectedOwner: string): unknown | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("memory_view_file_changed");
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isGeneratedMemoryView(parsed) || (parsed as Record<string, unknown>).ownerRef !== expectedOwner) throw new Error("memory_view_foreign_file");
    return parsed;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function safeRelative(value: string): boolean {
  return /^(?:one|agents\/[a-f0-9]{64}|projects\/[a-f0-9]{64})\/memory\.json$/.test(value);
}
function atomicJson(base: string, relative: string, value: unknown, expectedOwner: string): void {
  const dirname = realDirectory(base, path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative));
  const target = path.join(dirname, path.posix.basename(relative));
  managedJson(target, expectedOwner);
  const temp = path.join(dirname, `.memory-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    realDirectory(base, path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative));
    managedJson(target, expectedOwner);
    fs.renameSync(temp, target);
  } finally { try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
function removeManagedFile(base: string, relative: string, expectedOwner: string): void {
  if (!safeRelative(relative) && relative !== "manifest.json") throw new Error("memory_view_path_invalid");
  realDirectory(base, path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative));
  const target = path.join(base, ...relative.split("/"));
  if (managedJson(target, expectedOwner)) fs.unlinkSync(target);
}

/** Metadata/native mutations change view contents even when the learned
 * English row stays identical. These triggers use the existing revision. */
function trackViewDependencies(db: ReturnType<typeof getMemoryDb>): void {
  for (const table of ["memory_identity_bindings", "memory_origin_links", "memory_project_links", "memory_entry_native"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    let installed = false;
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const trigger = `memory_view_revision_${table}_${operation.toLowerCase()}`;
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger)) continue;
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger} AFTER ${operation} ON ${table}
        BEGIN UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'; END;`);
      installed = true;
    }
    // Reconcile an existing view when tracking is first installed or a native
    // table has just appeared after that view's original snapshot.
    if (installed) db.prepare("UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run();
  }
}

/** Redaction happens synchronously under the existing forget transaction. A
 * later rollback can rebuild this disposable view; it never restores bytes. */
export function purgeGeneratedMemoryViews(): boolean {
  const info = getMemoryStoreInfo(), base = viewRoot(info), ref = ownerRef(info);
  if (!fs.existsSync(base)) return true;
  try {
    realDirectory(path.dirname(info.path), "views");
    const manifest = managedJson(path.join(base, "manifest.json"), ref) as ViewManifest | null;
    if (!manifest) return true;
    if (!Array.isArray(manifest.files) || manifest.files.length > MAX_ROWS) return false;
    let complete = true;
    for (const file of manifest.files) { try { removeManagedFile(base, file.path, ref); } catch { complete = false; } }
    try { removeManagedFile(base, "manifest.json", ref); } catch { complete = false; }
    return complete;
  } catch { return false; } // A changed/manual file cannot veto canonical forget.
}

/** File projection only. No model call, memory admission or project-file write. */
export function processMemoryProjections(): { completed: number; state: "idle" | "complete" | "retry"; moreWork?: boolean } {
  const db = getMemoryDb(), info = getMemoryStoreInfo();
  if (running.has(info.path) || db.inTransaction) return { completed: 0, state: "idle" };
  running.add(info.path);
  try {
    return db.transaction(() => {
      trackViewDependencies(db);
      const current = getMemoryStoreInfo();
      const pending = db.prepare("SELECT outbox_id,memory_id FROM memory_projection_outbox WHERE state IN ('queued','processing','retry') ORDER BY created_at LIMIT 32").all() as Array<{ outbox_id: string; memory_id: string | null }>;
      const base = viewRoot(current), ref = ownerRef(current);
      if (fs.existsSync(base)) realDirectory(path.dirname(current.path), "views");
      let fresh = false;
      if (fs.existsSync(path.join(base, "manifest.json"))) {
        const existing = managedJson(path.join(base, "manifest.json"), ref) as ViewManifest;
        fresh = existing.authorityRevision === current.revision && existing.revocationEpoch === current.revocationEpoch
          && existing.actorFamilyContract === MEMORY_ACTOR_FAMILY_SCHEMA;
      }
      if (!pending.length && fresh) return { completed: 0, state: "idle" as const };
      // Repair the existing deterministic similarity projection, never infer
      // a new durable memory or a replacement decision from these files.
      for (const id of new Set(pending.map(row => row.memory_id).filter((value): value is string => Boolean(value)))) {
        const entry = readMemoryEntryForProjection(id);
        if (entry) {
          linkMemoryEntryBySimilarity(entry);
          projectCanonicalMemorySupersedes(id);
        }
      }
      const finishPending = () => {
        const finish = db.prepare("UPDATE memory_projection_outbox SET state='complete',updated_at=? WHERE outbox_id=?");
        for (const row of pending) finish.run(new Date().toISOString(), row.outbox_id);
        const moreWork = Boolean(db.prepare("SELECT 1 FROM memory_projection_outbox WHERE state IN ('queued','processing','retry') LIMIT 1").get());
        return { completed: pending.length, state: "complete" as const, moreWork };
      };
      // Later outbox chunks can repair graph edges without regenerating the
      // same already-current files for every chunk.
      if (fresh) return finishPending();
      const rows = db.prepare(`SELECT m.id,m.scope,m.kind,m.content,m.agent_id,b.actor_id,m.project_id,m.project_path,m.chat_id,
        m.confidence,m.sensitivity,m.created_at,b.owner_namespace,b.origin_refs_json,b.applicability_json,b.curation_actor,b.policy_version
        FROM memory_entries m LEFT JOIN memory_identity_bindings b ON b.memory_id=m.id
        WHERE m.superseded_at IS NULL AND m.content<>'' AND m.scope<>'session' AND m.sensitivity<>'secret'
          AND (b.owner_namespace IS NULL OR b.owner_namespace=?)
          AND COALESCE(json_extract(b.applicability_json,'$.enabled'),1)<>0
        ORDER BY m.created_at,m.id LIMIT ?`).all(current.ownerNamespace, MAX_ROWS + 1) as ViewRow[];
      if (rows.length > MAX_ROWS) throw new Error("memory_view_budget_exceeded");
      const nativeExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_entry_native'").get();
      const native = new Map<string, string>();
      if (nativeExists) for (const row of db.prepare("SELECT entry_id,content_native FROM memory_entry_native").all() as Array<{ entry_id: string; content_native: string }>) native.set(row.entry_id, row.content_native);
      const projectLinks = db.prepare("SELECT memory_id,project_id,relation FROM memory_project_links").all() as Array<{ memory_id: string; project_id: string; relation: string }>;
      const links = new Map<string, Array<{ projectId: string; relation: string }>>();
      for (const link of projectLinks) { const values = links.get(link.memory_id) ?? []; values.push({ projectId: link.project_id, relation: link.relation }); links.set(link.memory_id, values); }
      const groups = new Map<string, ViewGroup>();
      const add = (key: string, description: Omit<ViewGroup, "entries">, entry: unknown) => {
        const group = groups.get(key) ?? { ...description, entries: [] };
        group.entries.push(entry); groups.set(key, group);
      };
      for (const row of rows) {
        const actorId = row.actor_id ?? row.agent_id;
        let origins: unknown = []; try { origins = JSON.parse(row.origin_refs_json ?? "[]"); } catch { /* Legacy provenance is explicitly unknown. */ }
        const entry = { id: row.id, scope: row.scope, kind: row.kind, content: row.content,
          ...(native.has(row.id) ? { contentNative: native.get(row.id) } : {}),
          actorId, originProjectId: row.project_id, projectRelations: links.get(row.id) ?? [],
          applicability: parseObject(row.applicability_json), originRefs: origins,
          curationActor: row.curation_actor ?? "legacy", policyVersion: row.policy_version,
          confidence: row.confidence, sensitivity: row.sensitivity, createdAt: row.created_at };
        if (isOneMemoryActor(actorId)) add("one/memory.json", { kind: "one", actorId: BUILTIN_ONE_AGENT_ID }, entry);
        else if (actorId) add(`agents/${createHash("sha256").update(actorId).digest("hex")}/memory.json`, { kind: "agent", actorId }, entry);
        const projects = new Set((links.get(row.id) ?? []).map(link => link.projectId));
        if (row.project_id) projects.add(row.project_id);
        for (const projectId of projects) add(`projects/${createHash("sha256").update(projectId).digest("hex")}/memory.json`, { kind: "project", projectId }, entry);
      }
      // A valid empty One view also provides a stable human-readable address.
      if (!groups.has("one/memory.json")) groups.set("one/memory.json", { kind: "one", actorId: BUILTIN_ONE_AGENT_ID, entries: [] });
      const manifest: ViewManifest = { schemaVersion: SCHEMA, generated: true, ownerRef: ref,
        actorFamilyContract: MEMORY_ACTOR_FAMILY_SCHEMA,
        authorityRevision: current.revision, revocationEpoch: current.revocationEpoch, files: [] };
      const rendered = [...groups].map(([relative, group]) => {
        manifest.files.push({ path: relative, kind: group.kind, ...(group.actorId ? { actorId: group.actorId } : {}), ...(group.projectId ? { projectId: group.projectId } : {}), count: group.entries.length });
        return { relative, value: { schemaVersion: SCHEMA, generated: true, ownerRef: ref,
          actorFamilyContract: MEMORY_ACTOR_FAMILY_SCHEMA,
          authorityRevision: current.revision, revocationEpoch: current.revocationEpoch, kind: group.kind,
          actorId: group.actorId, projectId: group.projectId, entries: group.entries } };
      });
      if (rendered.reduce((bytes, file) => bytes + Buffer.byteLength(JSON.stringify(file.value)), 0) > MAX_BYTES) throw new Error("memory_view_budget_exceeded");
      realDirectory(path.dirname(current.path), "views");
      const old = managedJson(path.join(base, "manifest.json"), ref) as ViewManifest | null;
      const next = new Set(manifest.files.map(file => file.path));
      for (const file of rendered) atomicJson(base, file.relative, file.value, ref);
      for (const file of old?.files ?? []) if (!next.has(file.path)) removeManagedFile(base, file.path, ref);
      // Manifest commits last. Readers must compare its epoch/revision with DB.
      atomicJson(base, "manifest.json", manifest, ref);
      return finishPending();
    }).immediate();
  } catch {
    try { db.prepare("UPDATE memory_projection_outbox SET state='retry',updated_at=? WHERE state IN ('queued','processing','retry')").run(new Date().toISOString()); } catch { /* Changed owner/source remains unavailable; no cross-owner write. */ }
    return { completed: 0, state: "retry" };
  } finally { running.delete(info.path); }
}

export function scheduleMemoryProjectionProcessing(info: Pick<MemoryStoreInfo, "path">, delayMs = 150): void {
  if (process.env.AGENTLAS_MEMORY_PROJECTIONS === "0" || running.has(info.path) || timers.has(info.path)) return;
  const timer = setTimeout(() => {
    let retry: number | undefined;
    try { if (getMemoryStoreInfo().path === info.path) { const result = processMemoryProjections(); if (result.state === "retry") retry = 30_000; else if (result.moreWork) retry = 150; } }
    catch { /* Closing/switched product custody cancels this disposable work. */ }
    finally { timers.delete(info.path); if (retry !== undefined) scheduleMemoryProjectionProcessing(info, retry); }
  }, delayMs);
  timer.unref(); timers.set(info.path, timer);
}
