import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { RuntimeSelection } from "../../shared/types";
import { isRuntimeRole } from "../../shared/runtime-roles";
import type { LocalModelHubSnapshot, LocalModelInstallationReceipt } from "../../shared/local-model-hub";
import {
  LOCAL_MODEL_MIGRATION_SCHEMA_VERSION,
  type OllamaMigrationAuthority,
  type OllamaMigrationBinding,
  type OllamaMigrationEntry,
  type OllamaMigrationSnapshot,
} from "../../shared/local-model-migration";

type Db = Database.Database;

interface AuthorityRow {
  authority: OllamaMigrationAuthority;
  reference: string;
  selection: RuntimeSelection;
  historical: boolean;
  automationEnabled: boolean | null;
  isCurrent: () => boolean;
  mutate: (selection: RuntimeSelection) => boolean;
  pause?: () => boolean;
}

interface OllamaBlob {
  names: Set<string>;
  path: string;
  expectedSha256: string;
}

export interface OllamaMigrationServiceOptions {
  db: Db;
  snapshot: () => Promise<LocalModelHubSnapshot>;
  ollamaModelRoots: string[];
  now?: () => Date;
}

function sha256Text(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveDone, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveDone);
  });
  return hash.digest("hex");
}

function selection(value: unknown): RuntimeSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== "ollama") return null;
  if (row.backend !== undefined && row.backend !== "ollama") return null;
  if (row.model !== undefined && row.model !== null && typeof row.model !== "string") return null;
  return {
    kind: "ollama",
    backend: "ollama",
    source: typeof row.source === "string" && row.source ? row.source : "ollama",
    model: typeof row.model === "string" && row.model ? row.model : undefined,
    ...(typeof row.effort === "string" ? { effort: row.effort } : {}),
    ...(typeof row.longContext === "boolean" ? { longContext: row.longContext } : {}),
    ...(isRuntimeRole(row.role) ? { role: row.role } : {}),
    ...(typeof row.inherit === "boolean" ? { inherit: row.inherit } : {}),
  };
}

function parseSelection(raw: unknown): RuntimeSelection | null {
  if (typeof raw !== "string") return null;
  try { return selection(JSON.parse(raw)); } catch { return null; }
}

function tableExists(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function boundedManifestPath(root: string, path: string): boolean {
  const base = `${resolve(root)}${sep}`;
  return resolve(path).startsWith(base);
}

async function manifestFiles(root: string, maxEntries: number): Promise<{ files: string[]; visited: number }> {
  const manifests = join(root, "manifests");
  const output: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || visited >= maxEntries || !boundedManifestPath(root, dir)) return;
    let items;
    try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (visited >= maxEntries) return;
      visited += 1;
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) await walk(path, depth + 1);
      else if (item.isFile()) output.push(path);
    }
  };
  await walk(manifests, 0);
  return { files: output, visited };
}

async function discoverOllamaBlobs(roots: string[]): Promise<OllamaBlob[]> {
  const byDigest = new Map<string, OllamaBlob>();
  let remainingEntries = 20_000;
  for (const rootValue of roots) {
    if (remainingEntries <= 0) break;
    const root = resolve(rootValue);
    const walked = await manifestFiles(root, remainingEntries);
    remainingEntries -= walked.visited;
    const files = walked.files;
    for (const path of files) {
      let value: unknown;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) continue;
        value = JSON.parse(await readFile(path, "utf8"));
      } catch { continue; }
      const layers = value && typeof value === "object" && Array.isArray((value as { layers?: unknown }).layers)
        ? (value as { layers: Array<Record<string, unknown>> }).layers : [];
      const layer = layers.find((item) => item.mediaType === "application/vnd.ollama.image.model")
        ?? layers.find((item) => typeof item.digest === "string");
      const digest = typeof layer?.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(layer.digest)
        ? layer.digest.slice(7) : null;
      if (!digest) continue;
      const rel = relative(join(root, "manifests"), path).split(sep);
      if (rel.length < 2) continue;
      const tag = rel.at(-1)!;
      const registryRelative = rel.slice(1, -1);
      const modelSegments = registryRelative[0] === "library" ? registryRelative.slice(1) : registryRelative;
      const name = modelSegments.join("/");
      if (!name) continue;
      const blobPath = join(root, "blobs", `sha256-${digest}`);
      if (!boundedManifestPath(root, blobPath)) continue;
      try {
        const info = await lstat(blobPath);
        if (!info.isFile() || info.isSymbolicLink()) continue;
      } catch { continue; }
      const found = byDigest.get(digest) ?? { names: new Set<string>(), path: blobPath, expectedSha256: digest };
      found.names.add(`${name}:${tag}`);
      if (tag === "latest") found.names.add(name);
      byDigest.set(digest, found);
    }
  }
  return [...byDigest.values()];
}

function legacyBinding(value: RuntimeSelection): OllamaMigrationBinding {
  return {
    kind: "ollama", backend: "ollama", source: value.source ?? "ollama", model: value.model ?? null,
    enginePackageId: null, installationId: null, fileSha256: null,
    repository: null, revision: null, quantization: null,
  };
}

function managedBinding(install: LocalModelInstallationReceipt): OllamaMigrationBinding {
  return {
    kind: "agentlas-local", backend: "agentlas-local",
    source: `agentlas-local:${install.enginePackageId}:${install.installationId}`,
    model: install.fileName, enginePackageId: install.enginePackageId,
    installationId: install.installationId, fileSha256: install.fileSha256,
    repository: install.repository, revision: install.revision, quantization: install.quantization,
  };
}

function managedSelection(source: RuntimeSelection, install: LocalModelInstallationReceipt): RuntimeSelection {
  return {
    ...source,
    kind: "agentlas-local",
    backend: "agentlas-local",
    source: `agentlas-local:${install.enginePackageId}:${install.installationId}`,
    model: install.fileName,
  };
}

function sameRuntimeSelection(left: RuntimeSelection, right: RuntimeSelection): boolean {
  return left.kind === right.kind
    && left.backend === right.backend
    && left.source === right.source
    && left.model === right.model
    && left.effort === right.effort
    && left.longContext === right.longContext
    && left.role === right.role
    && left.inherit === right.inherit;
}

function jsonSelection(raw: string | null, next: RuntimeSelection): string {
  let prior: Record<string, unknown> = {};
  try { prior = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* replace invalid row */ }
  return JSON.stringify({ ...prior, ...next });
}

export class OllamaMigrationService {
  private readonly db: Db;
  private readonly snapshotProvider: () => Promise<LocalModelHubSnapshot>;
  private readonly roots: string[];
  private readonly now: () => Date;
  private readonly observedFileHashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  private reconcilePromise: Promise<OllamaMigrationSnapshot> | null = null;

  constructor(options: OllamaMigrationServiceOptions) {
    this.db = options.db;
    this.snapshotProvider = options.snapshot;
    this.roots = [...new Set(options.ollamaModelRoots.map((item) => resolve(item)))];
    this.now = options.now ?? (() => new Date());
  }

  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS local_model_migrations (
      migration_id TEXT PRIMARY KEY,
      authority TEXT NOT NULL,
      reference_hash TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      requested_json TEXT NOT NULL,
      actual_json TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      automation_was_enabled INTEGER,
      observed_at TEXT NOT NULL
    ); CREATE UNIQUE INDEX IF NOT EXISTS idx_local_model_migrations_ref ON local_model_migrations(reference_hash);`);
  }

  private authorityRows(): AuthorityRow[] {
    const rows: AuthorityRow[] = [];
    const addJsonRows = (table: string, authority: OllamaMigrationAuthority, keyColumns: string[], jsonColumn: string, historical = false): void => {
      if (!tableExists(this.db, table)) return;
      const selected = this.db.prepare(`SELECT ${[...keyColumns, jsonColumn].join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>;
      for (const row of selected) {
        const current = parseSelection(row[jsonColumn]);
        if (!current) continue;
        const originalJson = row[jsonColumn] as string | null;
        const reference = `${authority}:${keyColumns.map((key) => String(row[key])).join(":")}`;
        rows.push({ authority, reference, selection: current, historical, automationEnabled: null,
          isCurrent: () => {
            const found = this.db.prepare(`SELECT ${jsonColumn} FROM ${table} WHERE ${keyColumns.map((key) => `${key} = ?`).join(" AND ")}`).get(...keyColumns.map((key) => row[key])) as Record<string, unknown> | undefined;
            return Boolean(found) && found![jsonColumn] === originalJson;
          },
          mutate: (next) => this.db.prepare(`UPDATE ${table} SET ${jsonColumn} = ? WHERE ${keyColumns.map((key) => `${key} = ?`).join(" AND ")} AND ${jsonColumn} IS ?`)
            .run(jsonSelection(originalJson, next), ...keyColumns.map((key) => row[key]), originalJson).changes === 1, });
      }
    };
    if (tableExists(this.db, "active_runtime")) {
      const row = this.db.prepare("SELECT id, kind, backend, source, model, long_context FROM active_runtime WHERE kind = 'ollama'").get() as Record<string, unknown> | undefined;
      if (row) rows.push({ authority: "active-runtime", reference: `active-runtime:${row.id}`, selection: selection({ kind: row.kind, backend: row.backend, source: row.source, model: row.model, longContext: row.long_context === 1 })!, historical: false, automationEnabled: null,
        isCurrent: () => Boolean(this.db.prepare("SELECT 1 FROM active_runtime WHERE id = ? AND kind = ? AND backend IS ? AND source IS ? AND model IS ? AND long_context = ?").get(row.id, row.kind, row.backend, row.source, row.model, row.long_context)),
        mutate: (next) => this.db.prepare("UPDATE active_runtime SET kind = ?, backend = ?, source = ?, model = ?, long_context = ? WHERE id = ? AND kind = ? AND backend IS ? AND source IS ? AND model IS ? AND long_context = ?")
          .run(next.kind, next.backend ?? null, next.source ?? null, next.model ?? null, next.longContext ? 1 : 0, row.id, row.kind, row.backend, row.source, row.model, row.long_context).changes === 1, });
    }
    if (tableExists(this.db, "meta")) {
      const row = this.db.prepare("SELECT key, value FROM meta WHERE key = 'runtime_selection:ollama:ollama'").get() as { key: string; value: string } | undefined;
      let remembered: Record<string, unknown> | null = null;
      try { remembered = row ? JSON.parse(row.value) as Record<string, unknown> : null; } catch { /* damaged memory is not a usable pin */ }
      const current = parseSelection(remembered ? JSON.stringify({ ...remembered, kind: "ollama", backend: "ollama", source: "ollama" }) : null);
      const destinationKey = "runtime_selection:agentlas-local:agentlas-local";
      const destination = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(destinationKey) as { value: string } | undefined;
      if (row && current) rows.push({ authority: "runtime-memory", reference: `runtime-memory:${row.key}`, selection: current, historical: false, automationEnabled: null,
        isCurrent: () => (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(row.key) as { value: string } | undefined)?.value === row.value
          && (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(destinationKey) as { value: string } | undefined)?.value === destination?.value,
        mutate: (next) => {
          if ((this.db.prepare("SELECT value FROM meta WHERE key = ?").get(row.key) as { value: string } | undefined)?.value !== row.value) return false;
          const currentDestination = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(destinationKey) as { value: string } | undefined;
          if (currentDestination?.value !== destination?.value) return false;
          const nextValue = JSON.stringify({ model: next.model ?? null, longContext: Boolean(next.longContext), source: next.source });
          if (destination && destination.value !== nextValue) return false;
          if (this.db.prepare("DELETE FROM meta WHERE key = ? AND value = ?").run(row.key, row.value).changes !== 1) return false;
          if (!destination) this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(destinationKey, nextValue);
          return true;
        }, });
    }
    addJsonRows("chats", "chat", ["id"], "runtime_selection_json");
    if (tableExists(this.db, "automations")) {
      const selected = this.db.prepare("SELECT id, enabled, claimed_at, lease_owner, runtime_selection_json FROM automations").all() as Array<{ id: string; enabled: number; claimed_at: string | null; lease_owner: string | null; runtime_selection_json: string | null }>;
      for (const row of selected) {
        const current = parseSelection(row.runtime_selection_json);
        if (!current) continue;
        rows.push({ authority: "automation", reference: `automation:${row.id}`, selection: current, historical: false, automationEnabled: Boolean(row.enabled),
          isCurrent: () => Boolean(this.db.prepare("SELECT 1 FROM automations WHERE id = ? AND enabled = ? AND claimed_at IS ? AND lease_owner IS ? AND runtime_selection_json IS ?").get(row.id, row.enabled, row.claimed_at, row.lease_owner, row.runtime_selection_json)),
          mutate: (next) => this.db.prepare("UPDATE automations SET runtime_selection_json = ? WHERE id = ? AND enabled = ? AND claimed_at IS ? AND lease_owner IS ? AND runtime_selection_json IS ?")
            .run(jsonSelection(row.runtime_selection_json, next), row.id, row.enabled, row.claimed_at, row.lease_owner, row.runtime_selection_json).changes === 1,
          pause: () => this.db.prepare("UPDATE automations SET enabled = 0, claimed_at = NULL, lease_owner = NULL WHERE id = ? AND enabled = ? AND claimed_at IS ? AND lease_owner IS ? AND runtime_selection_json IS ?")
            .run(row.id, row.enabled, row.claimed_at, row.lease_owner, row.runtime_selection_json).changes === 1, });
      }
    }
    if (tableExists(this.db, "agent_runtime_overrides")) {
      const selected = this.db.prepare("SELECT scope, target_id, kind, backend, source, model, effort, long_context FROM agent_runtime_overrides WHERE kind = 'ollama'").all() as Array<Record<string, unknown>>;
      for (const row of selected) rows.push({ authority: "agent-override", reference: `agent-override:${row.scope}:${row.target_id}`, selection: selection({ kind: row.kind, backend: row.backend, source: row.source, model: row.model, effort: row.effort, longContext: row.long_context === 1 })!, historical: false, automationEnabled: null,
        isCurrent: () => Boolean(this.db.prepare("SELECT 1 FROM agent_runtime_overrides WHERE scope = ? AND target_id = ? AND kind = ? AND backend IS ? AND source IS ? AND model IS ? AND effort IS ? AND long_context = ?").get(row.scope, row.target_id, row.kind, row.backend, row.source, row.model, row.effort, row.long_context)),
        mutate: (next) => this.db.prepare("UPDATE agent_runtime_overrides SET kind = ?, backend = ?, source = ?, model = ?, effort = ?, long_context = ? WHERE scope = ? AND target_id = ? AND kind = ? AND backend IS ? AND source IS ? AND model IS ? AND effort IS ? AND long_context = ?")
          .run(next.kind, next.backend ?? null, next.source ?? null, next.model ?? null, next.effort ?? null, next.longContext ? 1 : 0, row.scope, row.target_id, row.kind, row.backend, row.source, row.model, row.effort, row.long_context).changes === 1, });
    }
    for (const [table, authority, keys] of [["model_roles", "model-role", ["role"]], ["model_role_members", "model-role-member", ["role", "position"]]] as const) {
      if (!tableExists(this.db, table)) continue;
      const selected = this.db.prepare(`SELECT * FROM ${table} WHERE kind = 'ollama'`).all() as Array<Record<string, unknown>>;
      for (const row of selected) rows.push({ authority, reference: `${authority}:${keys.map((key) => row[key]).join(":")}`, selection: selection({ kind: row.kind, backend: row.backend, source: row.source, model: row.model, effort: row.effort, longContext: row.long_context === 1, role: row.role })!, historical: false, automationEnabled: null,
        isCurrent: () => Boolean(this.db.prepare(`SELECT 1 FROM ${table} WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")} AND kind = ? AND backend IS ? AND source IS ? AND model IS ? AND effort IS ? AND long_context = ?`).get(...keys.map((key) => row[key]), row.kind, row.backend, row.source, row.model, row.effort, row.long_context)),
        mutate: (next) => this.db.prepare(`UPDATE ${table} SET kind = ?, backend = ?, source = ?, model = ?, effort = ?, long_context = ? WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")} AND kind = ? AND backend IS ? AND source IS ? AND model IS ? AND effort IS ? AND long_context = ?`)
          .run(next.kind, next.backend ?? null, next.source ?? null, next.model ?? null, next.effort ?? null, next.longContext ? 1 : 0, ...keys.map((key) => row[key]), row.kind, row.backend, row.source, row.model, row.effort, row.long_context).changes === 1, });
    }
    addJsonRows("long_run_workers", "long-run-history", ["id"], "runtime_selection_json", true);
    return rows;
  }

  private entry(row: Pick<AuthorityRow, "authority" | "reference" | "selection" | "historical">, install: LocalModelInstallationReceipt | null, automationPaused: boolean, conflict = false): OllamaMigrationEntry {
    const referenceHash = sha256Text(row.reference);
    const requested = legacyBinding(row.selection);
    if (install) requested.fileSha256 = install.fileSha256;
    const actual = install ? managedBinding(install) : requested;
    const state = conflict ? "conflict" : row.historical ? "history-preserved" : install ? "mapped" : automationPaused ? "paused-migration-needed" : "migration-needed";
    const sourceHash = sha256Text(JSON.stringify(requested));
    return {
      schemaVersion: LOCAL_MODEL_MIGRATION_SCHEMA_VERSION,
      migrationId: `ollama-migration:${referenceHash.slice(7, 31)}:${sourceHash.slice(7, 19)}`,
      authority: row.authority,
      referenceHash,
      state,
      requested,
      actual,
      reasonCodes: conflict ? ["authority_changed_during_reconcile"] : row.historical ? ["historical_binding_preserved"] : install ? ["exact_model_blob_sha256_matched"] : ["exact_model_blob_sha256_mapping_missing"],
      automationPaused,
      observedAt: this.now().toISOString(),
    };
  }

  private persist(entry: OllamaMigrationEntry, automationWasEnabled: boolean | null): void {
    this.db.prepare(`INSERT INTO local_model_migrations (
      migration_id, authority, reference_hash, source_hash, state, requested_json, actual_json,
      reason_codes_json, automation_was_enabled, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reference_hash) DO UPDATE SET migration_id=excluded.migration_id, source_hash=excluded.source_hash,
      state=excluded.state, requested_json=excluded.requested_json, actual_json=excluded.actual_json,
      reason_codes_json=excluded.reason_codes_json,
      automation_was_enabled=COALESCE(local_model_migrations.automation_was_enabled, excluded.automation_was_enabled), observed_at=excluded.observed_at`)
      .run(entry.migrationId, entry.authority, entry.referenceHash, sha256Text(JSON.stringify(entry.requested)), entry.state,
        JSON.stringify(entry.requested), JSON.stringify(entry.actual), JSON.stringify(entry.reasonCodes),
        automationWasEnabled == null ? null : automationWasEnabled ? 1 : 0, entry.observedAt);
  }

  private async mappings(snapshot: LocalModelHubSnapshot, legacyModels: Set<string>): Promise<Map<string, LocalModelInstallationReceipt>> {
    const installsByHash = new Map(snapshot.modelInstallations
      .filter((item) => item.enginePackageId
        && snapshot.engineInstallations.some((engine) => engine.enginePackageId === item.enginePackageId)
        && snapshot.resident?.state === "resident"
        && snapshot.resident.installationId === item.installationId
        && snapshot.resident.enginePackageId === item.enginePackageId)
      .map((item) => [item.fileSha256, item]));
    const result = new Map<string, LocalModelInstallationReceipt>();
    if (legacyModels.size === 0 || installsByHash.size === 0) return result;
    for (const blob of await discoverOllamaBlobs(this.roots)) {
      if (![...blob.names].some((name) => legacyModels.has(name))) continue;
      const install = installsByHash.get(blob.expectedSha256);
      if (!install) continue;
      const info = await lstat(blob.path).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      const cached = this.observedFileHashes.get(blob.path);
      const observed = cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs
        ? cached.sha256
        : await sha256File(blob.path).catch(() => null);
      if (!observed || observed !== blob.expectedSha256) continue;
      this.observedFileHashes.set(blob.path, { size: info.size, mtimeMs: info.mtimeMs, sha256: observed });
      for (const name of blob.names) result.set(name, install);
    }
    return result;
  }

  reconcile(): Promise<OllamaMigrationSnapshot> {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.performReconcile().finally(() => { this.reconcilePromise = null; });
    return this.reconcilePromise;
  }

  private async performReconcile(): Promise<OllamaMigrationSnapshot> {
    this.initialize();
    const rows = this.authorityRows();
    const snapshot = await this.snapshotProvider();
    const mappings = await this.mappings(snapshot, new Set(rows.map((row) => row.selection.model).filter((item): item is string => Boolean(item))));
    const entries: OllamaMigrationEntry[] = [];
    this.db.transaction(() => {
      for (const row of rows) {
        const install = row.historical ? null : row.selection.model ? mappings.get(row.selection.model) ?? null : null;
        const alreadyMigrationPaused = row.authority === "automation" && row.automationEnabled === false && this.wasMigrationPaused(sha256Text(row.reference));
        const shouldPause = row.authority === "automation" && !install && (row.automationEnabled === true || alreadyMigrationPaused);
        const entry = this.entry(row, install, shouldPause);
        if (!row.isCurrent()) {
          const conflict = this.entry(row, null, false, true);
          this.persist(conflict, row.automationEnabled);
          entries.push(conflict);
          continue;
        }
        if (row.historical) {
          this.persist(entry, null);
        } else if (install) {
          if (!row.mutate(managedSelection(row.selection, install))) {
            const conflict = this.entry(row, null, false, true);
            this.persist(conflict, row.automationEnabled);
            entries.push(conflict);
            continue;
          }
          this.persist(entry, row.automationEnabled);
        } else {
          if (shouldPause && !row.pause?.()) {
            const conflict = this.entry(row, null, false, true);
            this.persist(conflict, row.automationEnabled);
            entries.push(conflict);
            continue;
          }
          this.persist(entry, row.automationEnabled);
        }
        entries.push(entry);
      }
    })();
    return this.result(entries);
  }

  async snapshot(): Promise<OllamaMigrationSnapshot> {
    if (this.reconcilePromise) return await this.reconcilePromise;
    this.initialize();
    const rows = this.authorityRows();
    return this.result(rows.map((row) => {
      const conflict = this.storedConflictMatches(row);
      return this.entry(
        row,
        null,
        row.authority === "automation" && !row.historical && row.automationEnabled === false && this.wasMigrationPaused(sha256Text(row.reference)),
        conflict,
      );
    }));
  }

  async inspectOneSelection(value: RuntimeSelection | null): Promise<OllamaMigrationEntry | null> {
    const current = selection(value);
    if (!current) return null;
    const hub = await this.snapshotProvider();
    const mappings = await this.mappings(hub, new Set(current.model ? [current.model] : []));
    return this.entry({ authority: "one-local-storage", reference: `one-local-storage:${sha256Text(JSON.stringify(current))}`, selection: current, historical: false }, current.model ? mappings.get(current.model) ?? null : null, false);
  }

  async commitOneSelection(requestedValue: RuntimeSelection, actualValue: RuntimeSelection): Promise<OllamaMigrationEntry> {
    const requested = selection(requestedValue);
    if (!requested || actualValue.kind !== "agentlas-local") throw new TypeError("invalid_one_migration_commit");
    this.initialize();
    const hub = await this.snapshotProvider();
    const mappings = await this.mappings(hub, new Set(requested.model ? [requested.model] : []));
    const install = requested.model ? mappings.get(requested.model) ?? null : null;
    if (!install) throw new Error("one_migration_mapping_no_longer_available");
    const expected = managedSelection(requested, install);
    if (!sameRuntimeSelection(actualValue, expected)) {
      throw new Error("one_migration_actual_binding_mismatch");
    }
    const entry = this.entry({ authority: "one-local-storage", reference: `one-local-storage:${sha256Text(JSON.stringify(requested))}`, selection: requested, historical: false }, install, false);
    this.persist(entry, null);
    return entry;
  }

  private wasMigrationPaused(referenceHash: string): boolean {
    return (this.db.prepare("SELECT state FROM local_model_migrations WHERE reference_hash = ?").get(referenceHash) as { state: string } | undefined)?.state === "paused-migration-needed";
  }

  private storedConflictMatches(row: Pick<AuthorityRow, "reference" | "selection">): boolean {
    const stored = this.db.prepare("SELECT state, requested_json FROM local_model_migrations WHERE reference_hash = ?").get(sha256Text(row.reference)) as { state: string; requested_json: string } | undefined;
    if (stored?.state !== "conflict") return false;
    try { return JSON.stringify(JSON.parse(stored.requested_json)) === JSON.stringify(legacyBinding(row.selection)); } catch { return false; }
  }

  private result(entries: OllamaMigrationEntry[]): OllamaMigrationSnapshot {
    const merged = new Map(entries.map((entry) => [entry.referenceHash, entry]));
    if (tableExists(this.db, "local_model_migrations")) {
      const stored = this.db.prepare("SELECT * FROM local_model_migrations").all() as Array<Record<string, unknown>>;
      for (const row of stored) {
        const referenceHash = row.reference_hash as `sha256:${string}`;
        if (merged.has(referenceHash)) continue;
        try {
          const requested = JSON.parse(String(row.requested_json)) as OllamaMigrationBinding;
          const actual = JSON.parse(String(row.actual_json)) as OllamaMigrationBinding;
          const reasonCodes = JSON.parse(String(row.reason_codes_json)) as string[];
          const state = row.state as OllamaMigrationEntry["state"];
          if (state === "migration-needed" || state === "paused-migration-needed") continue;
          merged.set(referenceHash, {
            schemaVersion: LOCAL_MODEL_MIGRATION_SCHEMA_VERSION,
            migrationId: String(row.migration_id),
            authority: row.authority as OllamaMigrationAuthority,
            referenceHash,
            state,
            requested,
            actual,
            reasonCodes,
            automationPaused: row.state === "paused-migration-needed",
            observedAt: String(row.observed_at),
          });
        } catch { /* corrupt audit rows are not projected as valid receipts */ }
      }
    }
    const counts: OllamaMigrationSnapshot["counts"] = { mapped: 0, "migration-needed": 0, "paused-migration-needed": 0, conflict: 0, "history-preserved": 0 };
    const all = [...merged.values()].sort((a, b) => a.authority.localeCompare(b.authority) || a.referenceHash.localeCompare(b.referenceHash));
    for (const entry of all) counts[entry.state] += 1;
    return { schemaVersion: LOCAL_MODEL_MIGRATION_SCHEMA_VERSION, generatedAt: this.now().toISOString(), entries: all, counts, externalOllamaModified: false, systemOllamaUninstalled: false };
  }
}
