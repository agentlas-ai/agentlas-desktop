import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb, openedStorePath } from "../store/db";
import { MEMORY_STORE_SCHEMA_SQL } from "./schema";

const SCHEMA = "agentlas_memory";
const VERSION = 1;
const OWNER_KEY = "agentlas.memory.owner.v1";
const states = new WeakMap<Database.Database, StoreState>();

interface StoreState {
  ownerNamespace: string;
  path: string;
  facade: Database.Database;
}
function scheduleViews(state: StoreState): void {
  try { (require("./projections") as typeof import("./projections")).scheduleMemoryProjectionProcessing(state); }
  catch { /* Projection failure never blocks canonical storage; outbox remains. */ }
}

export interface MemoryStoreInfo {
  ownerNamespace: string;
  path: string;
  schemaVersion: number;
  revocationEpoch: number;
  revision: number;
}

export function memoryRoot(): string {
  const override = process.env.AGENTLAS_MEMORY_ROOT?.trim();
  // Existing isolated product fixtures predate the central store. Keep their
  // memory beside the explicitly selected fixture database as well.
  const fixtureStore = process.env.AGENTLAS_E2E === "1" ? process.env.AGENTLAS_STORE_PATH?.trim() : undefined;
  const fixtureRoot = fixtureStore && path.isAbsolute(fixtureStore) ? path.join(path.dirname(fixtureStore), "agentlas-memory") : undefined;
  const root = override || fixtureRoot || path.join(process.env.AGENTLAS_HOME?.trim() || path.join(os.homedir(), ".agentlas"), "memory");
  if (!path.isAbsolute(root)) throw new Error("memory_root_must_be_absolute");
  return path.resolve(root);
}

/** Identity comes from the host's existing account custody, never model output. */
export function activeMemoryOwnerNamespace(): string {
  const { oneScopedMetaKey } = require("../store/one-profile") as typeof import("../store/one-profile");
  const slot = oneScopedMetaKey(OWNER_KEY);
  const custody = deviceMemoryCustodyId();
  // The inherited machine lineage stays explicitly device-local. It is not
  // relabelled as an account's verified personal data during migration.
  return slot === OWNER_KEY ? `device-local:${custody}`
    : slot.endsWith("#signed-out") ? `signed-out:${custody}`
      : `account:${slot.slice(OWNER_KEY.length + 1)}`;
}

export function deviceMemoryCustodyId(): string {
  const root = memoryRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const registry = path.join(root, "registry.json");
  if (!fs.existsSync(registry)) {
    const temp = path.join(root, `.registry-${randomUUID()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: "agentlas.memory-registry.v1", deviceCustodyId: randomUUID() }), { flag: "wx", mode: 0o600 });
    try { fs.linkSync(temp, registry); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { fs.unlinkSync(temp); }
  }
  const value = JSON.parse(fs.readFileSync(registry, "utf8")) as { schemaVersion?: string; deviceCustodyId?: string };
  if (value.schemaVersion !== "agentlas.memory-registry.v1" || !/^[0-9a-f-]{36}$/.test(value.deviceCustodyId ?? "")) throw new Error("memory_registry_invalid");
  return value.deviceCustodyId!;
}

export function memoryStorePath(ownerNamespace = activeMemoryOwnerNamespace()): string {
  if (!ownerNamespace.trim() || ownerNamespace.length > 512) throw new Error("memory_owner_namespace_invalid");
  const key = createHash("sha256").update(ownerNamespace, "utf8").digest("hex");
  return path.join(memoryRoot(), "owners", key, "memory.sqlite");
}

/** Split trusted SQL while preserving complete trigger bodies and literals. */
function statements(sql: string): string[] {
  const parts: string[] = [];
  let begin = 0, start = 0;
  const tokens = /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\b(?:BEGIN|CASE|END)\b|;/gi;
  for (const token of sql.matchAll(tokens)) {
    const value = token[0].toUpperCase();
    if (value === "BEGIN" || value === "CASE") begin++;
    else if (value === "END") begin = Math.max(0, begin - 1);
    else if (value === ";" && begin === 0) {
      parts.push(sql.slice(start, token.index! + 1)); start = token.index! + 1;
    }
  }
  if (sql.slice(start).trim()) parts.push(sql.slice(start));
  return parts.filter(part => part.trim());
}

function routeSql(sql: string): string {
  // Trigger bodies resolve unqualified names in their owning database. SQLite
  // forbids qualified DML names inside a persistent trigger.
  const trigger = /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w]+)[\s\S]*?\bON\s+(memory_[\w]+)/i.exec(sql);
  if (trigger) return sql.replace(new RegExp(`(TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(?:${trigger[1]})(?=\\s)`, "i"), `$1${SCHEMA}.${trigger[1]}`);
  if (/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(sql)) return sql;
  const index = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w]+)\s+ON\s+(memory_[\w]+)/i.exec(sql);
  if (index) return sql.replace(new RegExp(`(INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(?:${index[1]})(?=\\s)`, "i"), `$1${SCHEMA}.${index[1]}`);
  // Tokenize literals/comments so quoted data is never rewritten as SQL.
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\b[\w]+\b|[^\w]/g) ?? [];
  let previous = "", tableExpected = false;
  return tokens.map((token, i) => {
    if (/^\s+$/.test(token)) return token;
    if (/^(?:'|--|\/\*)/.test(token)) return token;
    const upper = token.toUpperCase();
    const tableName = token.replace(/^"|"$/g, "");
    const isMemory = /^memory_\w+$/.test(tableName);
    const qualify = isMemory && tableExpected && previous !== "REFERENCES" && tokens[i - 1] !== ".";
    if (tableExpected && upper === "SQLITE_MASTER") {
      tableExpected = false; previous = upper;
      return `(SELECT * FROM main.sqlite_master WHERE name NOT LIKE 'memory_%' UNION ALL SELECT * FROM ${SCHEMA}.sqlite_master)`;
    }
    if (["FROM", "JOIN", "INTO", "UPDATE", "TABLE"].includes(upper)) tableExpected = true;
    else if (!["IF", "NOT", "EXISTS", "OR", "REPLACE", "IGNORE"].includes(upper)) tableExpected = false;
    previous = upper;
    return qualify ? `${SCHEMA}.${token}` : token;
  }).join("").replace(/^\s*PRAGMA\s+table_info\((memory_\w+)\)/i, `PRAGMA ${SCHEMA}.table_info($1)`);
}

function createStore(product: Database.Database, ownerNamespace: string, file: string): void {
  product.prepare(`ATTACH DATABASE ? AS ${SCHEMA}`).run(file);
  const hasMetadata = product.prepare(`SELECT 1 FROM ${SCHEMA}.sqlite_master WHERE type='table' AND name='memory_store_meta'`).get();
  if (hasMetadata) {
    const existingVersion = product.prepare(`SELECT value FROM ${SCHEMA}.memory_store_meta WHERE key='schema_version'`).get() as { value: string } | undefined;
    const existingOwner = product.prepare(`SELECT value FROM ${SCHEMA}.memory_store_meta WHERE key='owner_namespace'`).get() as { value: string } | undefined;
    if (existingVersion && Number(existingVersion.value) !== VERSION) throw new Error("memory_store_schema_incompatible");
    if (existingOwner && existingOwner.value !== ownerNamespace) throw new Error("memory_owner_mismatch");
  }
  product.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.memory_store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.memory_source_mappings(
      source_store TEXT NOT NULL, source_id TEXT NOT NULL, target_table TEXT NOT NULL,
      target_id TEXT NOT NULL, source_digest TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(source_store,target_table,source_id));`);
  const oldVersion = product.prepare(`SELECT value FROM ${SCHEMA}.memory_store_meta WHERE key='schema_version'`).get() as { value: string } | undefined;
  if (oldVersion && Number(oldVersion.value) !== VERSION) throw new Error("memory_store_schema_incompatible");
  const owner = product.prepare(`SELECT value FROM ${SCHEMA}.memory_store_meta WHERE key='owner_namespace'`).get() as { value: string } | undefined;
  if (owner && owner.value !== ownerNamespace) throw new Error("memory_owner_mismatch");
  const sourceId = createHash("sha256").update(path.resolve(product.name)).digest("hex");
  const marker = `memory-store-cutover:${sourceId}`;
  const cutover = product.prepare("SELECT value FROM main.meta WHERE key=?").get(marker) as { value: string } | undefined;
  const tables = product.prepare("SELECT name,sql FROM main.sqlite_master WHERE type='table' AND name LIKE 'memory_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
  const migrate = product.transaction(() => {
    product.pragma("defer_foreign_keys=ON");
    for (const statement of statements(MEMORY_STORE_SCHEMA_SQL)) product.exec(routeSql(statement));
    for (const table of tables) product.exec(routeSql(table.sql.replace(/^CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS")));
    const indices = product.prepare("SELECT sql FROM main.sqlite_master WHERE type='index' AND tbl_name LIKE 'memory_%' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
    for (const index of indices) product.exec(routeSql(index.sql.replace(/CREATE (UNIQUE )?INDEX/i, "CREATE $1INDEX IF NOT EXISTS")));
    if (!cutover && ownerNamespace.startsWith("device-local:")) {
      // This holds the source write lock until the old writer fence is installed.
      for (const table of tables) {
        const columnNames = (product.prepare(`PRAGMA main.table_info(${table.name})`).all() as Array<{ name: string }>).map(c => c.name);
        const columns = columnNames.map(c => `"${c}"`).join(",");
        const primary = (product.prepare(`PRAGMA main.table_info(${table.name})`).all() as Array<{ name: string; pk: number }>).filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => c.name);
        if (!primary.length) throw new Error("memory_migration_primary_key_required");
        const rows = product.prepare(`SELECT ${columns} FROM main.${table.name}`).all() as Array<Record<string, unknown>>;
        const lookup = product.prepare(`SELECT ${columns} FROM ${SCHEMA}.${table.name} WHERE ${primary.map(k => `"${k}"=?`).join(" AND ")}`);
        const insert = product.prepare(`INSERT INTO ${SCHEMA}.${table.name} (${columns}) VALUES (${columnNames.map(() => "?").join(",")})`);
        for (const row of rows) {
          const prior = lookup.get(...primary.map(k => row[k])) as Record<string, unknown> | undefined;
          // A Core writer may have opened the canonical store first. Epochs
          // are monotonic authority, never a body collision or a reset.
          if (table.name === "memory_forget_clock" && prior) {
            product.prepare(`UPDATE ${SCHEMA}.memory_forget_clock SET epoch=MAX(epoch,?) WHERE id=?`).run(Number(row.epoch), row.id);
          } else {
            if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("memory_migration_source_collision");
            if (!prior) insert.run(...Object.values(row));
          }
          product.prepare(`INSERT OR REPLACE INTO ${SCHEMA}.memory_source_mappings VALUES (?, ?, ?, ?, ?, 'migrated')`)
            .run(sourceId, JSON.stringify(primary.map(k => row[k])), table.name, JSON.stringify(primary.map(k => row[k])), createHash("sha256").update(JSON.stringify(row)).digest("hex"));
        }
        product.prepare(`INSERT OR REPLACE INTO ${SCHEMA}.memory_source_mappings VALUES (?, ?, ?, ?, ?, 'migrated')`)
          .run(sourceId, "*", table.name, "*", createHash("sha256").update(table.sql).digest("hex"));
      }
    }
    if (!cutover && ownerNamespace.startsWith("device-local:")) {
      // These persistent guards also reject writes from binaries that know
      // nothing about the new root or its migration/revocation epoch.
      for (const table of tables.filter(t => ["memory_entries", "memory_tickets", "memory_decisions", "memory_revocations", "memory_forget_clock"].includes(t.name))) {
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) product.exec(`CREATE TRIGGER IF NOT EXISTS main.memory_cutover_${table.name}_${operation.toLowerCase()}
          BEFORE ${operation} ON ${table.name}${table.name === "memory_forget_clock" && operation === "INSERT" ? " WHEN NOT EXISTS(SELECT 1 FROM memory_forget_clock WHERE id=NEW.id)" : ""}
          BEGIN SELECT RAISE(ABORT,'memory_store_moved_upgrade_required'); END;`);
      }
      product.prepare("INSERT INTO main.meta(key,value) VALUES (?,?)").run(marker, file);
    }
    product.exec(`INSERT OR IGNORE INTO ${SCHEMA}.memory_forget_clock(id,epoch) VALUES(1,0)`);
    product.exec(`INSERT OR IGNORE INTO ${SCHEMA}.memory_store_meta(key,value) VALUES('revision','0');
      CREATE TRIGGER IF NOT EXISTS ${SCHEMA}.memory_revision_insert AFTER INSERT ON memory_entries BEGIN UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'; END;
      CREATE TRIGGER IF NOT EXISTS ${SCHEMA}.memory_revision_update AFTER UPDATE OF content,scope,kind,project_id,project_path,agent_id,chat_id,superseded_at ON memory_entries BEGIN UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'; END;
      CREATE TRIGGER IF NOT EXISTS ${SCHEMA}.memory_revision_delete AFTER DELETE ON memory_entries BEGIN UPDATE memory_store_meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'; END;`);
    product.prepare(`INSERT OR REPLACE INTO ${SCHEMA}.memory_store_meta(key,value) VALUES ('schema_version',?),('owner_namespace',?),('migration_epoch','1')`).run(String(VERSION), ownerNamespace);
  });
  migrate.immediate();
}

export function getMemoryDb(): Database.Database {
  const product = getDb();
  const ownerNamespace = activeMemoryOwnerNamespace();
  const file = memoryStorePath(ownerNamespace);
  const existing = states.get(product);
  if (existing?.ownerNamespace === ownerNamespace && existing.path === file) { scheduleViews(existing); return existing.facade; }
  if (existing) {
    if (product.inTransaction) throw new Error("memory_owner_changed_during_transaction");
    product.exec(`DETACH DATABASE ${SCHEMA}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (!ownerNamespace.startsWith("device-local:")) {
      const sourceId = createHash("sha256").update(path.resolve(product.name)).digest("hex");
      const already = product.prepare("SELECT 1 FROM main.meta WHERE key=?").get(`memory-store-cutover:${sourceId}`);
      if (!already) {
        const deviceNamespace = `device-local:${deviceMemoryCustodyId()}`;
        const deviceFile = memoryStorePath(deviceNamespace);
        fs.mkdirSync(path.dirname(deviceFile), { recursive: true, mode: 0o700 });
        createStore(product, deviceNamespace, deviceFile);
        product.exec(`DETACH DATABASE ${SCHEMA}`);
      }
    }
    createStore(product, ownerNamespace, file);
  }
  catch (error) { try { product.exec(`DETACH DATABASE ${SCHEMA}`); } catch { /* An active source transaction retains its attachment. */ } throw error; }
  const assertCurrent = () => {
    if (activeMemoryOwnerNamespace() !== ownerNamespace || states.get(product)?.path !== file) throw new Error("memory_owner_changed");
  };
  const facade = new Proxy(product, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => {
        assertCurrent();
        const statement = target.prepare(routeSql(sql));
        return new Proxy(statement, { get(stmt, method) {
          const value = Reflect.get(stmt, method, stmt);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            assertCurrent();
            const result = value.apply(stmt, args);
            if (method !== "iterate") return result;
            const iterator = result as IterableIterator<unknown>;
            const guarded = new Proxy(iterator, { get(target, key) {
              if (key === Symbol.iterator) return () => guarded;
              const item = Reflect.get(target, key, target);
              if (typeof item !== "function") return item;
              return (...values: unknown[]) => {
                if (key === "next") try { assertCurrent(); }
                catch (error) { try { iterator.return?.(); } catch { /* Release an old owner cursor before switching custody. */ } throw error; }
                // return/throw release the cursor even after the owner changes.
                return item.apply(target, values);
              };
            }});
            return guarded;
          };
        }});
      };
      if (prop === "exec") return (sql: string) => { assertCurrent(); for (const statement of statements(sql)) target.exec(routeSql(statement)); return facade; };
      if (prop === "pragma") return (sql: string, ...args: unknown[]) => { assertCurrent(); return target.pragma(sql.replace(/^table_info\((memory_\w+)\)/i, `${SCHEMA}.table_info($1)`), ...args as []); };
      if (prop === "transaction") return (fn: (...args: unknown[]) => unknown) => {
        const tx = target.transaction((...args: unknown[]) => { assertCurrent(); return fn(...args); });
        const wrap = (mode: (...args: unknown[]) => unknown) => (...args: unknown[]) => { assertCurrent(); return mode(...args); };
        const wrapped = wrap(tx);
        return Object.assign(wrapped, { deferred: wrap(tx.deferred), immediate: wrap(tx.immediate), exclusive: wrap(tx.exclusive) });
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database.Database;
  const state = { ownerNamespace, path: file, facade };
  states.set(product, state);
  try {
    const sources = require("./source-catalogue") as typeof import("./source-catalogue");
    sources.registerOriginalMemorySource(facade, ownerNamespace, sources.productSourceProducer(product), {
      actorId: null, visibilityDomain: "product-original", logicalKey: "product-store", sourceKind: "product-store",
      readerContract: "desktop.product-store.v1", writerContract: "desktop.original-product-store",
      schemaVersion: "agentlas.product-store.v1", sourceRevision: String(product.pragma("user_version", { simple: true })),
      address: { path: product.name },
    });
  } catch { /* Source metadata is retryable; canonical storage remains authoritative. */ }
  scheduleViews(state);
  return facade;
}

export function getMemoryStoreInfo(): MemoryStoreInfo {
  const db = getMemoryDb();
  const state = states.get(getDb())!;
  const epoch = db.prepare("SELECT epoch FROM memory_forget_clock WHERE id=1").get() as { epoch: number } | undefined;
  const revision = db.prepare("SELECT value FROM memory_store_meta WHERE key='revision'").get() as { value: string } | undefined;
  return { ownerNamespace: state.ownerNamespace, path: state.path, schemaVersion: VERSION, revocationEpoch: epoch?.epoch ?? 0, revision: Number(revision?.value ?? 0) };
}

/** Preserve an original-source capability while routing its memory exclusion
 * checks through canonical storage. Injected isolated sources remain isolated. */
export function memoryDatabaseForOriginalSource<T extends object>(source: T): T {
  const opened = openedStorePath();
  const name = (source as { name?: string }).name;
  if (!opened || !name || path.resolve(name) !== path.resolve(opened)) return source;
  if (source !== getDb() as unknown) throw new Error("memory_original_database_changed");
  return getMemoryDb() as unknown as T;
}

/** Scrub migrated plaintext copies under the current revocation transaction.
 * The frozen source remains a recovery reference, never a recall authority. */
export function purgeLegacyMemoryCopies(memoryIds: readonly string[], ticketIds: readonly string[]): void {
  const canonical = getMemoryDb();
  const state = states.get(getDb())!;
  if (!state.ownerNamespace.startsWith("device-local:")) return;
  const product = getDb();
  if (!product.inTransaction) throw new Error("memory_legacy_purge_requires_transaction");
  const sourceId = createHash("sha256").update(path.resolve(product.name)).digest("hex");
  const cutover = product.prepare("SELECT value FROM main.meta WHERE key=?").get(`memory-store-cutover:${sourceId}`) as { value: string } | undefined;
  if (cutover?.value !== state.path) throw new Error("memory_legacy_source_changed");
  const accepted: string[] = [];
  for (const id of new Set(memoryIds)) {
    const mapping = canonical.prepare(`SELECT 1 FROM memory_source_mappings
      WHERE source_store=? AND target_table='memory_entries' AND target_id=? AND state='migrated'`).get(sourceId, JSON.stringify([id]));
    if (mapping) accepted.push(id);
  }
  if (!accepted.length) return;
  const has = (name: string) => Boolean(product.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(name));
  const sources = accepted.map(() => "?").join(",");
  const legacyTickets = has("memory_decisions") ? product.prepare(`SELECT DISTINCT ticket_id FROM main.memory_decisions WHERE target_memory_id IN (${sources})`).all(...accepted) as Array<{ ticket_id: string }> : [];
  const tickets = [...new Set([...ticketIds, ...legacyTickets.map(row => row.ticket_id)])];
  // Persistent guards stay installed outside this source-locked transaction.
  // Restore them even if a scrub fails; rollback also restores their prior DDL.
  const guards = product.prepare(`SELECT name,sql FROM main.sqlite_master WHERE type='trigger'
    AND name IN ('memory_cutover_memory_entries_delete','memory_cutover_memory_decisions_update')`).all() as Array<{ name: string; sql: string }>;
  try {
    for (const guard of guards) product.exec(`DROP TRIGGER main.${guard.name}`);
    if (has("memory_episodes") && tickets.length) {
      const keys = tickets.map(() => "?").join(",");
      const episodes = product.prepare(`SELECT episode_id FROM main.memory_episodes WHERE ticket_id IN (${keys})`).all(...tickets) as Array<{ episode_id: string }>;
      product.prepare(`UPDATE main.memory_episodes SET summary=NULL,summary_hash=NULL,
        embedding_model=NULL,embedding_adapter=NULL,embedding_model_sha256=NULL,embedding_content_hash=NULL,
        embedding_dimensions=NULL,embedding_json=NULL WHERE ticket_id IN (${keys})`).run(...tickets);
      for (const row of episodes) {
        if (has("memory_episode_native")) product.prepare("DELETE FROM main.memory_episode_native WHERE episode_id=?").run(row.episode_id);
        if (has("memory_translation_jobs")) product.prepare("DELETE FROM main.memory_translation_jobs WHERE target_kind='memory_episode' AND target_id=?").run(row.episode_id);
      }
    }
    for (const id of accepted) {
      if (has("memory_entry_native")) product.prepare("DELETE FROM main.memory_entry_native WHERE entry_id=?").run(id);
      if (has("memory_translation_jobs")) product.prepare("DELETE FROM main.memory_translation_jobs WHERE target_kind='memory_entry' AND target_id=?").run(id);
      product.prepare("DELETE FROM main.memory_entries WHERE id=?").run(id);
    }
  } finally { for (const guard of guards) product.exec(guard.sql); }
}

export const memorySqlRouting = { routeSql, statements };
