import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CONTINUITY_CORE_TABLES,
  isValidContinuitySnapshot,
  type ContinuitySnapshot,
  type ContinuityVerification,
} from "./controller";
import { MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS } from "../automation-watchdog";
import {
  OPENCRAB_CATALOG_ID,
  OPENCRAB_CREDENTIAL_PATTERN,
  OPENCRAB_MCP_URL_KEY,
  OPENCRAB_MCP_URL_SENTINEL,
  isOpenCrabCredentialUrl,
} from "../opencrab/constants";

const CONTINUITY_TABLES = CONTINUITY_CORE_TABLES;
const V52_AUTOMATION_RECOVERY_STALE_MS = MAX_AUTOMATION_ACTIVE_TOOL_STALL_MS + 2 * 60 * 1000;

type TableColumn = { name: string; pk: number };

function protectedTablesForSnapshot(snapshot: ContinuitySnapshot): readonly string[] {
  // Verify exactly the tables the snapshot's writer protected. The writer is
  // the previous app version, so the current CONTINUITY_CORE_TABLES may be
  // larger; verifying against it would flag healthy journals as violations.
  return Object.keys(snapshot.rowCounts).sort();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(file: string): string {
  return sha256(fs.readFileSync(file));
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}

function databaseFacts(db: Database.Database, protectedTables: readonly string[] = CONTINUITY_TABLES): {
  databaseSchemaVersion: number;
  rowCounts: Record<string, number>;
  tableIdentityHashes: Record<string, string>;
} {
  const databaseSchemaVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  const rowCounts: Record<string, number> = {};
  const tableIdentityHashes: Record<string, string> = {};
  for (const table of protectedTables) {
    if (!tableExists(db, table)) {
      rowCounts[table] = 0;
      tableIdentityHashes[table] = sha256(`missing:${table}`);
      continue;
    }
    rowCounts[table] = Number(
      (db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count?: number } | undefined)?.count ?? 0,
    );
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableColumn[];
    const identityColumns = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    const selected = identityColumns.length > 0 ? identityColumns : columns.slice(0, 1);
    if (selected.length === 0) {
      tableIdentityHashes[table] = sha256(`empty-schema:${table}`);
      continue;
    }
    // This projects PRIMARY KEY columns only, so it is an index scan rather
    // than a table scan — cheap even at tens of thousands of rows. It was
    // briefly replaced with an inert digest on the assumption that it was the
    // update-time cost that forced writer quiescence; that assumption was
    // wrong, and removing it also silently disabled the identity comparison
    // this snapshot still owes its callers. Keep it.
    const projection = selected.map((column) => quoteIdentifier(column.name)).join(", ");
    const order = selected.map((column) => quoteIdentifier(column.name)).join(", ");
    const identityHash = createHash("sha256");
    for (const row of db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)} ORDER BY ${order}`).iterate()) {
      identityHash.update(JSON.stringify(row));
      identityHash.update("\n");
    }
    tableIdentityHashes[table] = identityHash.digest("hex");
  }
  return { databaseSchemaVersion, rowCounts, tableIdentityHashes };
}

function assetFingerprint(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  if (!fs.existsSync(root)) return hashes;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
      const stat = fs.lstatSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        hashes[relativePath] = `file:${hashFile(fullPath)}`;
      } else if (stat.isSymbolicLink()) {
        hashes[relativePath] = `symlink:${sha256(fs.readlinkSync(fullPath))}`;
      } else {
        throw new Error(`Unsupported agent asset type: ${relativePath}`);
      }
    }
  };
  walk(root);
  return hashes;
}

function copyAgentAssets(sourceRoot: string, backupRoot: string): Record<string, string> {
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(sourceRoot)) return {};
  const walk = (sourceDirectory: string, targetDirectory: string): void => {
    fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = path.join(sourceDirectory, entry.name);
      const target = path.join(targetDirectory, entry.name);
      const stat = fs.lstatSync(source);
      if (stat.isDirectory()) {
        walk(source, target);
      } else if (stat.isFile()) {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, stat.mode & 0o777);
      } else if (stat.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(source), target);
      } else {
        throw new Error(`Unsupported agent asset type: ${path.relative(sourceRoot, source)}`);
      }
    }
  };
  walk(sourceRoot, backupRoot);
  const sourceHashes = assetFingerprint(sourceRoot);
  const backupHashes = assetFingerprint(backupRoot);
  if (JSON.stringify(sourceHashes) !== JSON.stringify(backupHashes)) {
    throw new Error("Agent asset recovery copy does not match the live assets");
  }
  return sourceHashes;
}

function topLevelAgentDirectories(userDataPath: string): string[] {
  const agentsPath = path.join(userDataPath, "agents");
  try {
    return fs
      .readdirSync(agentsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function copyRouteFile(userDataPath: string, recoveryDir: string): {
  routeFilePresent: boolean;
  routeFileHash: string | null;
  routeBackupPath: string | null;
} {
  const source = path.join(userDataPath, "agent-routes.json");
  if (!fs.existsSync(source)) return { routeFilePresent: false, routeFileHash: null, routeBackupPath: null };
  if (!fs.lstatSync(source).isFile()) throw new Error("Route state must be a regular file");
  const routeBackupPath = path.join(recoveryDir, "agent-routes.json");
  fs.copyFileSync(source, routeBackupPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(routeBackupPath, 0o600);
  const sourceHash = hashFile(source);
  if (hashFile(routeBackupPath) !== sourceHash) throw new Error("Route recovery copy does not match the live route file");
  return { routeFilePresent: true, routeFileHash: sourceHash, routeBackupPath };
}

function valueKey(value: unknown): string {
  if (Buffer.isBuffer(value)) return `buffer:${value.toString("base64")}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

function rowKey(row: Record<string, unknown>, columns: TableColumn[]): string {
  return columns.map((column) => valueKey(row[column.name])).join("\u001f");
}

function migrationApprovedDeletedChats(current: Database.Database): Set<string> {
  if (!tableExists(current, "meta")) return new Set();
  try {
    const columns = current.prepare("PRAGMA table_info(meta)").all() as TableColumn[];
    if (!columns.some((column) => column.name === "key") || !columns.some((column) => column.name === "value")) {
      return new Set();
    }
    const row = current
      .prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
      .get("migration:v50:orphan-chat-repair") as { value?: unknown } | undefined;
    const parsed = JSON.parse(String(row?.value ?? "{}")) as { deleted?: Array<{ chatId?: unknown }> };
    return new Set(
      Array.isArray(parsed.deleted)
        ? parsed.deleted.map((entry) => entry.chatId).filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function v52RecoveredNodeStates(value: unknown): unknown {
  if (typeof value !== "string" || !value) return value;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    let changed = false;
    for (const [nodeId, state] of Object.entries(parsed)) {
      if (state === "running") {
        parsed[nodeId] = "failed";
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : value;
  } catch {
    return value;
  }
}

function isV52ApprovedDeletedAutomationRun(
  backup: Database.Database,
  before: Record<string, unknown>,
): boolean {
  if (!tableExists(backup, "automations")) return false;
  const automationId = typeof before.automation_id === "string" ? before.automation_id : "";
  if (!automationId) return true;
  return !backup.prepare("SELECT 1 FROM automations WHERE id = ? LIMIT 1").get(automationId);
}

function isV52ApprovedRecoveredAutomationRun(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  comparableColumns: TableColumn[],
  nowMs: number,
): boolean {
  if (before.status !== "running" || after.status !== "error") return false;
  const lastActivity = before.last_activity_at ?? before.started_at;
  const lastActivityMs = Date.parse(String(lastActivity ?? ""));
  if (!Number.isFinite(lastActivityMs) || lastActivityMs > nowMs - V52_AUTOMATION_RECOVERY_STALE_MS) {
    return false;
  }
  for (const column of comparableColumns) {
    if (column.name === "status") continue;
    const expected = column.name === "node_states_json"
      ? v52RecoveredNodeStates(before[column.name])
      : before[column.name];
    if (valueKey(after[column.name]) !== valueKey(expected)) return false;
  }
  return true;
}

function verifyProtectedDatabaseRows(
  backup: Database.Database,
  current: Database.Database,
  nowMs: number,
  protectedTables: readonly string[],
): string[] {
  const violations: string[] = [];
  const approvedDeletedChats = migrationApprovedDeletedChats(current);
  const currentSchemaVersion = Number(current.pragma("user_version", { simple: true }) ?? 0);
  for (const table of protectedTables) {
    if (!tableExists(backup, table)) continue;
    if (!tableExists(current, table)) {
      const count = Number(
        (backup.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count?: number })?.count ?? 0,
      );
      if (count > 0) violations.push(`protected-table-missing:${table}`);
      continue;
    }
    const backupColumns = backup.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableColumn[];
    const currentColumns = current.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableColumn[];
    const currentColumnNames = new Set(currentColumns.map((column) => column.name));
    const comparableColumns = backupColumns.filter((column) => currentColumnNames.has(column.name));
    const primaryKeyColumns = backupColumns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    if (primaryKeyColumns.length === 0 || primaryKeyColumns.some((column) => !currentColumnNames.has(column.name))) {
      violations.push(`protected-table-key-unavailable:${table}`);
      continue;
    }
    const projection = comparableColumns.map((column) => quoteIdentifier(column.name)).join(", ");
    const isV53HubBookmarkKeyMigration =
      table === "hub_agent_bookmarks" &&
      currentSchemaVersion >= 53 &&
      !backupColumns.some((column) => column.name === "workspace_id") &&
      currentColumnNames.has("workspace_id") &&
      currentColumnNames.has("entity_kind");
    const currentProjection = isV53HubBookmarkKeyMigration
      ? `${projection}, sync_state, server_updated_at, last_sync_error, claim_workspace_id`
      : projection;
    const currentLookup = current.prepare(
      isV53HubBookmarkKeyMigration
        ? `SELECT ${currentProjection} FROM ${quoteIdentifier(table)}
           WHERE workspace_id = '__device__' AND slug = ? AND entity_kind = ? LIMIT 1`
        : `SELECT ${currentProjection} FROM ${quoteIdentifier(table)} WHERE ${primaryKeyColumns
            .map((column) => `${quoteIdentifier(column.name)} = ?`)
            .join(" AND ")} LIMIT 1`,
    );
    const backupRows = backup.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}`).iterate() as Iterable<Record<string, unknown>>;
    for (const before of backupRows) {
      const key = rowKey(before, primaryKeyColumns);
      const after = currentLookup.get(
        ...(isV53HubBookmarkKeyMigration
          ? [
              before.slug,
              String(before.entity_kind ?? "").trim().toLowerCase() === "team"
                ? "team"
                : String(before.entity_kind ?? "").trim().toLowerCase() === "plugin"
                  ? "plugin"
                  : "agent",
            ]
          : primaryKeyColumns.map((column) => before[column.name])),
      ) as Record<string, unknown> | undefined;
      if (!after) {
        if (
          table === "automation_runs" &&
          currentSchemaVersion >= 52 &&
          isV52ApprovedDeletedAutomationRun(backup, before)
        ) {
          continue;
        }
        const chatId = table === "chats" && primaryKeyColumns.length === 1
          ? String(before[primaryKeyColumns[0].name] ?? "")
          : "";
        if (!chatId || !approvedDeletedChats.has(chatId)) violations.push(`protected-row-missing:${table}:${sha256(key)}`);
        continue;
      }
      if (isV53HubBookmarkKeyMigration) {
        const expectedNewFields: Record<string, unknown> = {
          sync_state: "clean",
          server_updated_at: null,
          last_sync_error: null,
          claim_workspace_id: null,
        };
        for (const [column, expected] of Object.entries(expectedNewFields)) {
          if (valueKey(after[column]) !== valueKey(expected)) {
            violations.push(`protected-value-changed:${table}:${column}:${sha256(key)}`);
          }
        }
      }
      if (
        table === "automation_runs" &&
        currentSchemaVersion >= 52 &&
        isV52ApprovedRecoveredAutomationRun(before, after, comparableColumns, nowMs)
      ) {
        continue;
      }
      for (const column of comparableColumns) {
        if (valueKey(after[column.name]) !== valueKey(before[column.name])) {
          violations.push(`protected-value-changed:${table}:${column.name}:${sha256(key)}`);
        }
      }
    }
  }
  return violations;
}

function quickCheck(databasePath: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const result = db.pragma("quick_check", { simple: true });
    return String(result).toLowerCase() === "ok";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function pruneOldRecoveryCopies(root: string, keepPath: string): void {
  try {
    const directories = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const fullPath = path.join(root, entry.name);
        return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    let kept = 0;
    for (const directory of directories) {
      if (directory.fullPath === keepPath || kept < 2) {
        kept += 1;
        continue;
      }
      fs.rmSync(directory.fullPath, { recursive: true, force: true });
    }
  } catch {
    // Retention is best effort. Never fail a safe install because an older backup could not be pruned.
  }
}

const RECOVERY_DATABASE_NAME = "agentlas.sqlite";
const MAX_INACTIVE_RECOVERY_DATABASES = 2;

export interface InactiveRecoveryOpenCrabScrubResult {
  scanned: number;
  scrubbedDatabases: number;
  scrubbedRows: number;
  consolidatedRows: number;
  skippedActive: boolean;
  skippedUnsafe: number;
}

type RecoveryMcpRow = {
  id: string;
  catalog_id: string | null;
  url: string;
  enabled: number;
  installed_at: string;
};

function tableHasColumns(db: Database.Database, table: string, required: string[]): boolean {
  if (!tableExists(db, table)) return false;
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableColumn[]).map((column) => column.name),
  );
  return required.every((column) => columns.has(column));
}

function fileContainsPattern(file: string, pattern: RegExp): boolean {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let carry = "";
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead <= 0) return false;
      const text = carry + chunk.subarray(0, bytesRead).toString("latin1");
      pattern.lastIndex = 0;
      if (pattern.test(text)) return true;
      carry = text.slice(-8_192);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function fileContainsBytes(file: string, needle: string): boolean {
  if (!needle || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const fd = fs.openSync(file, "r");
  const target = Buffer.from(needle, "utf8");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead <= 0) return false;
      const current = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (current.indexOf(target) >= 0) return true;
      carry = current.subarray(Math.max(0, current.length - Math.max(0, target.length - 1)));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function assertCheckpointComplete(db: Database.Database): void {
  const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
  if (rows.some((row) => Number(row.busy ?? 0) !== 0)) {
    throw new Error("inactive recovery SQLite checkpoint is busy");
  }
}

function fsyncFileAndDirectory(file: string): void {
  const fileFd = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fileFd);
  } finally {
    fs.closeSync(fileFd);
  }
  try {
    const directoryFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch {
    // Directory fsync is unavailable on some platforms; SQLite/file fsync still applies.
  }
}

function writePrivateJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows inherits the private updater directory ACL.
    }
    fsyncFileAndDirectory(file);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function resealRecoveryContinuityMetadata(databasePath: string): boolean {
  const continuityPath = path.join(path.dirname(databasePath), "continuity.json");
  if (!fs.existsSync(continuityPath)) return true;
  try {
    const stat = fs.lstatSync(continuityPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const parsed = JSON.parse(fs.readFileSync(continuityPath, "utf8"));
    if (!isValidContinuitySnapshot(parsed)) return false;
    if (fs.realpathSync(parsed.backupPath) !== fs.realpathSync(databasePath)) return false;

    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    let facts: ReturnType<typeof databaseFacts>;
    try {
      facts = databaseFacts(db, protectedTablesForSnapshot(parsed));
    } finally {
      db.close();
    }
    writePrivateJsonAtomic(continuityPath, {
      ...parsed,
      databaseSchemaVersion: facts.databaseSchemaVersion,
      rowCounts: facts.rowCounts,
      tableIdentityHashes: facts.tableIdentityHashes,
      sanitizedAt: new Date().toISOString(),
      sanitizationVersion: "opencrab-url-credential-v1",
    });
    return true;
  } catch {
    return false;
  }
}

function scrubRecoveryDatabase(databasePath: string): {
  changed: boolean;
  scrubbedRows: number;
  consolidatedRows: number;
} {
  let db: Database.Database | null = null;
  let legacyUrls: string[] = [];
  let scrubbedRows = 0;
  let consolidatedRows = 0;
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
  const rawCredentialBytesBefore = [databasePath, ...sidecars].some((file) =>
    fileContainsPattern(file, OPENCRAB_CREDENTIAL_PATTERN),
  );
  try {
    db = new Database(databasePath, { fileMustExist: true });
    db.pragma("busy_timeout = 1000");
    if (!tableHasColumns(db, "mcp_servers", [
      "id", "catalog_id", "name", "name_en", "transport", "command",
      "args_json", "url", "env_keys_json", "enabled", "installed_at",
    ])) {
      return { changed: false, scrubbedRows: 0, consolidatedRows: 0 };
    }

    const rows = db
      .prepare(
        "SELECT id, catalog_id, url, enabled, installed_at FROM mcp_servers WHERE url IS NOT NULL ORDER BY installed_at DESC",
      )
      .all() as RecoveryMcpRow[];
    const legacy = rows.filter(
      (row) => row.url !== OPENCRAB_MCP_URL_SENTINEL && isOpenCrabCredentialUrl(row.url),
    );
    legacyUrls = legacy.map((row) => row.url);
    scrubbedRows = legacy.length;
    if (legacy.length === 0 && !rawCredentialBytesBefore) {
      return { changed: false, scrubbedRows: 0, consolidatedRows: 0 };
    }

    db.pragma("secure_delete = ON");
    if (legacy.length > 0) {
      const safeCatalogRows = rows.filter(
        (row) => row.catalog_id === OPENCRAB_CATALOG_ID && row.url === OPENCRAB_MCP_URL_SENTINEL,
      );
      const canonical = safeCatalogRows.find((row) => row.enabled === 1) ?? safeCatalogRows[0] ?? legacy[0];
      const openCrabRows = [...safeCatalogRows, ...legacy].filter(
        (row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index,
      );

      db.transaction(() => {
        db!.prepare(
          `UPDATE mcp_servers
           SET catalog_id = ?, name = ?, name_en = ?, transport = 'http', command = NULL,
               args_json = '[]', url = ?, env_keys_json = ?
           WHERE id = ?`,
        ).run(
          OPENCRAB_CATALOG_ID,
          "OpenCrab 온톨로지",
          "OpenCrab Ontology",
          OPENCRAB_MCP_URL_SENTINEL,
          JSON.stringify([OPENCRAB_MCP_URL_KEY]),
          canonical.id,
        );
        if (!safeCatalogRows.some((row) => row.id === canonical.id)) {
          db!.prepare("UPDATE mcp_servers SET enabled = 0 WHERE id = ?").run(canonical.id);
        }

        for (const row of openCrabRows) {
          if (row.id === canonical.id) continue;
          if (tableHasColumns(db!, "agent_mcp_servers", ["agent_id", "server_id"])) {
            db!.prepare(
              `INSERT OR IGNORE INTO agent_mcp_servers (agent_id, server_id)
               SELECT agent_id, ? FROM agent_mcp_servers WHERE server_id = ?`,
            ).run(canonical.id, row.id);
          }
          if (tableHasColumns(db!, "agent_tools", ["installed_server_id"])) {
            db!.prepare("UPDATE agent_tools SET installed_server_id = ? WHERE installed_server_id = ?")
              .run(canonical.id, row.id);
          }
          db!.prepare("DELETE FROM mcp_servers WHERE id = ?").run(row.id);
          consolidatedRows += 1;
        }
      })();
    }

    // Even when the logical row was already scrubbed, an older value may remain
    // in freelist pages. Rebuild the inactive copy and truncate its WAL before it
    // can be retained as a user-visible recovery artifact.
    assertCheckpointComplete(db);
    db.exec("VACUUM");
    assertCheckpointComplete(db);
    const check = String(db.pragma("quick_check", { simple: true })).toLowerCase();
    if (check !== "ok") throw new Error("inactive recovery SQLite failed quick_check after credential scrub");
  } finally {
    db?.close();
  }

  for (const sidecar of sidecars) fs.rmSync(sidecar, { force: true });
  fsyncFileAndDirectory(databasePath);
  if (
    legacyUrls.some((value) => fileContainsBytes(databasePath, value)) ||
    fileContainsPattern(databasePath, OPENCRAB_CREDENTIAL_PATTERN)
  ) {
    throw new Error("inactive recovery SQLite still contains an OpenCrab credential");
  }
  return { changed: true, scrubbedRows, consolidatedRows };
}

/**
 * Scrub only retention copies that can no longer participate in updater
 * continuity. Any live/corrupt install journal proves that recovery ownership
 * is unresolved, so this function leaves every backup byte-for-byte untouched.
 * Call only after updater reconciliation has verified continuity and cleared its
 * durable journal.
 */
export function scrubInactiveUpdaterRecoveryOpenCrabCredentialUrls(input: {
  userDataPath: string;
}): InactiveRecoveryOpenCrabScrubResult {
  const result: InactiveRecoveryOpenCrabScrubResult = {
    scanned: 0,
    scrubbedDatabases: 0,
    scrubbedRows: 0,
    consolidatedRows: 0,
    skippedActive: false,
    skippedUnsafe: 0,
  };
  const updaterRoot = path.join(input.userDataPath, "updater");
  const journalPath = path.join(updaterRoot, "install-journal.v1.json");
  const corruptMarkerPath = path.join(updaterRoot, "install-journal-corrupt.v1.json");
  if (fs.existsSync(journalPath) || fs.existsSync(corruptMarkerPath)) {
    result.skippedActive = true;
    return result;
  }

  const recoveryRoot = path.join(updaterRoot, "recovery");
  if (!fs.existsSync(recoveryRoot)) return result;
  let realRecoveryRoot: string;
  try {
    realRecoveryRoot = fs.realpathSync(recoveryRoot);
  } catch {
    result.skippedUnsafe += 1;
    return result;
  }

  const candidates: Array<{ databasePath: string; mtimeMs: number }> = [];
  try {
    for (const entry of fs.readdirSync(recoveryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const directory = path.join(recoveryRoot, entry.name);
        candidates.push({
          databasePath: path.join(directory, RECOVERY_DATABASE_NAME),
          mtimeMs: fs.statSync(directory).mtimeMs,
        });
      } catch {
        result.skippedUnsafe += 1;
      }
    }
  } catch {
    result.skippedUnsafe += 1;
    return result;
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const candidate of candidates.slice(0, MAX_INACTIVE_RECOVERY_DATABASES)) {
    if (!fs.existsSync(candidate.databasePath)) continue;
    result.scanned += 1;
    try {
      const stat = fs.lstatSync(candidate.databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe inactive recovery SQLite path");
      const realDatabasePath = fs.realpathSync(candidate.databasePath);
      if (!isInside(realRecoveryRoot, realDatabasePath) || !quickCheck(realDatabasePath)) {
        throw new Error("unsafe inactive recovery SQLite copy");
      }
      const scrubbed = scrubRecoveryDatabase(realDatabasePath);
      if (scrubbed.changed) result.scrubbedDatabases += 1;
      result.scrubbedRows += scrubbed.scrubbedRows;
      result.consolidatedRows += scrubbed.consolidatedRows;
      if (scrubbed.changed && !resealRecoveryContinuityMetadata(realDatabasePath)) {
        // The credential remains removed and the DB passed quick_check, but the
        // preserved metadata can no longer be claimed as a verified snapshot.
        result.skippedUnsafe += 1;
      }
    } catch {
      // A malformed copy remains available for manual recovery. Never delete or
      // replace user recovery material merely because credential scrub failed.
      result.skippedUnsafe += 1;
    }
  }
  return result;
}

export function readDatabaseSchemaVersion(databasePath: string): number | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const value = Number(db.pragma("user_version", { simple: true }));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export function readBundledRuntimeVersion(resourcesPath: string, sourceRoot?: string): string | null {
  const candidates = [
    path.join(resourcesPath, "Hephaestus", "manifest.json"),
    sourceRoot ? path.join(sourceRoot, "Hephaestus", "manifest.json") : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // Try the source-tree fallback for local verification builds.
    }
  }
  return null;
}

export async function captureUpdaterContinuity(input: {
  userDataPath: string;
  databasePath: string;
  targetVersion: string;
  accountSignedIn: boolean;
  accountExpiresAt?: number;
  now?: () => number;
}): Promise<ContinuitySnapshot> {
  const now = input.now ?? Date.now;
  const safeVersion = input.targetVersion.replace(/[^0-9A-Za-z._-]/g, "_");
  const recoveryRoot = path.join(input.userDataPath, "updater", "recovery");
  const recoveryDir = path.join(recoveryRoot, `${safeVersion}-${now()}`);
  const backupPath = path.join(recoveryDir, "agentlas.sqlite");
  const agentsBackupPath = path.join(recoveryDir, "agents");
  fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });

  let source: Database.Database | null = null;
  try {
    source = new Database(input.databasePath, { readonly: true, fileMustExist: true });
    const before = databaseFacts(source);
    await source.backup(backupPath);
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size <= 0 || !quickCheck(backupPath)) {
      throw new Error("SQLite recovery copy did not pass quick_check");
    }
    try {
      fs.chmodSync(backupPath, 0o600);
    } catch {
      // Windows ACLs are inherited from userData.
    }
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    const copied = databaseFacts(backup);
    backup.close();
    if (
      copied.databaseSchemaVersion !== before.databaseSchemaVersion ||
      CONTINUITY_TABLES.some(
        (table) =>
          copied.rowCounts[table] !== before.rowCounts[table] ||
          copied.tableIdentityHashes[table] !== before.tableIdentityHashes[table],
      )
    ) {
      throw new Error("SQLite recovery copy facts do not match the live store");
    }

    const agentAssetHashes = copyAgentAssets(path.join(input.userDataPath, "agents"), agentsBackupPath);
    const route = copyRouteFile(input.userDataPath, recoveryDir);

    const snapshot: ContinuitySnapshot = {
      schemaVersion: 2,
      userDataPath: path.resolve(input.userDataPath),
      databasePath: path.resolve(input.databasePath),
      backupPath: path.resolve(backupPath),
      databaseSchemaVersion: before.databaseSchemaVersion,
      rowCounts: before.rowCounts,
      tableIdentityHashes: before.tableIdentityHashes,
      agentDirectoryNames: topLevelAgentDirectories(input.userDataPath),
      agentAssetHashes,
      agentsBackupPath: path.resolve(agentsBackupPath),
      authCookiePresent: fs.existsSync(path.join(input.userDataPath, "auth", "session-cookie.v1.json")),
      accountSignedIn: input.accountSignedIn,
      ...(input.accountExpiresAt !== undefined ? { accountExpiresAt: input.accountExpiresAt } : {}),
      ...route,
      capturedAt: new Date(now()).toISOString(),
    };
    fs.writeFileSync(path.join(recoveryDir, "continuity.json"), `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    pruneOldRecoveryCopies(recoveryRoot, recoveryDir);
    return snapshot;
  } catch (error) {
    fs.rmSync(recoveryDir, { recursive: true, force: true });
    throw error;
  } finally {
    source?.close();
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Pre-migration gate: prove that the recovery material named by the durable
 * install journal is local, contained, and readable before initStore can mutate
 * the live DB. It deliberately does not open or migrate the live database.
 */
export function verifyUpdaterRecoveryCopies(input: {
  snapshot: ContinuitySnapshot;
  currentUserDataPath: string;
}): ContinuityVerification {
  const violations: string[] = [];
  const recoveryRoot = path.join(input.currentUserDataPath, "updater", "recovery");
  if (path.resolve(input.currentUserDataPath) !== path.resolve(input.snapshot.userDataPath)) {
    violations.push("user-data-path-changed");
  }
  for (const candidate of [
    input.snapshot.backupPath,
    input.snapshot.agentsBackupPath,
    ...(input.snapshot.routeBackupPath ? [input.snapshot.routeBackupPath] : []),
  ]) {
    if (!isInside(recoveryRoot, candidate)) {
      violations.push("recovery-path-outside-user-data");
      continue;
    }
    try {
      if (fs.existsSync(candidate) && !isInside(fs.realpathSync(recoveryRoot), fs.realpathSync(candidate))) {
        violations.push("recovery-path-outside-user-data");
      }
    } catch {
      // Missing/unreadable material is reported by the artifact checks below.
    }
  }
  if (!fs.existsSync(input.snapshot.backupPath) || !quickCheck(input.snapshot.backupPath)) {
    violations.push("recovery-copy-missing-or-invalid");
  } else {
    let recoveryDb: Database.Database | null = null;
    try {
      recoveryDb = new Database(input.snapshot.backupPath, { readonly: true, fileMustExist: true });
      const protectedTables = protectedTablesForSnapshot(input.snapshot);
      const facts = databaseFacts(recoveryDb, protectedTables);
      if (facts.databaseSchemaVersion !== input.snapshot.databaseSchemaVersion) {
        violations.push("recovery-schema-mismatch");
      }
      for (const table of protectedTables) {
        if (
          facts.rowCounts[table] !== input.snapshot.rowCounts[table] ||
          facts.tableIdentityHashes[table] !== input.snapshot.tableIdentityHashes[table]
        ) {
          violations.push(`recovery-table-mismatch:${table}`);
        }
      }
    } catch {
      violations.push("recovery-copy-missing-or-invalid");
    } finally {
      recoveryDb?.close();
    }
  }
  try {
    const backupAssets = assetFingerprint(input.snapshot.agentsBackupPath);
    if (JSON.stringify(backupAssets) !== JSON.stringify(input.snapshot.agentAssetHashes)) {
      violations.push("agent-recovery-copy-invalid");
    }
  } catch {
    violations.push("agent-recovery-copy-invalid");
  }
  if (input.snapshot.routeFilePresent) {
    try {
      if (
        !input.snapshot.routeBackupPath ||
        !fs.existsSync(input.snapshot.routeBackupPath) ||
        hashFile(input.snapshot.routeBackupPath) !== input.snapshot.routeFileHash
      ) {
        violations.push("route-recovery-copy-invalid");
      }
    } catch {
      violations.push("route-recovery-copy-invalid");
    }
  }
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

export async function verifyUpdaterContinuity(input: {
  snapshot: ContinuitySnapshot;
  currentUserDataPath: string;
  currentDatabasePath: string;
  currentAccountSignedIn: boolean;
  now?: () => number;
}): Promise<ContinuityVerification> {
  const recoveryVerification = verifyUpdaterRecoveryCopies({
    snapshot: input.snapshot,
    currentUserDataPath: input.currentUserDataPath,
  });
  const violations: string[] = [...recoveryVerification.violations];
  if (path.resolve(input.currentDatabasePath) !== path.resolve(input.snapshot.databasePath)) {
    violations.push("database-path-changed");
  }

  let db: Database.Database | null = null;
  let backupDb: Database.Database | null = null;
  try {
    db = new Database(input.currentDatabasePath, { readonly: true, fileMustExist: true });
    backupDb = new Database(input.snapshot.backupPath, { readonly: true, fileMustExist: true });
    const protectedTables = protectedTablesForSnapshot(input.snapshot);
    const current = databaseFacts(db, protectedTables);
    if (current.databaseSchemaVersion < input.snapshot.databaseSchemaVersion) {
      violations.push("database-schema-regressed");
    }
    for (const [table, expected] of Object.entries(input.snapshot.rowCounts)) {
      // v52 intentionally prunes only orphan live projections and terminalizes
      // abandoned ones. Row-level verification below proves every missing or
      // changed pre-update identity matches that narrow migration contract.
      if (table === "automation_runs" && current.databaseSchemaVersion >= 52) continue;
      if ((current.rowCounts[table] ?? 0) < expected) violations.push(`row-count-regressed:${table}`);
      if (
        (current.rowCounts[table] ?? 0) === expected &&
        current.tableIdentityHashes[table] !== input.snapshot.tableIdentityHashes[table] &&
        // v53 intentionally changes only this table's identity from slug to
        // device/workspace + entity kind + slug. Row-level verification above
        // still proves every pre-update value survived at its exact device key.
        !(table === "hub_agent_bookmarks" && current.databaseSchemaVersion >= 53)
      ) {
        violations.push(`table-identity-changed:${table}`);
      }
    }
    violations.push(...verifyProtectedDatabaseRows(
      backupDb,
      db,
      (input.now ?? Date.now)(),
      protectedTables,
    ));
  } catch {
    violations.push("database-unavailable");
  } finally {
    db?.close();
    backupDb?.close();
  }

  const currentAgents = new Set(topLevelAgentDirectories(input.currentUserDataPath));
  for (const agentDirectory of input.snapshot.agentDirectoryNames) {
    if (!currentAgents.has(agentDirectory)) violations.push(`agent-directory-missing:${agentDirectory}`);
  }
  try {
    const currentAssetHashes = assetFingerprint(path.join(input.currentUserDataPath, "agents"));
    for (const [relativePath, expectedHash] of Object.entries(input.snapshot.agentAssetHashes)) {
      if (currentAssetHashes[relativePath] !== expectedHash) violations.push(`agent-asset-changed:${relativePath}`);
    }
  } catch {
    violations.push("agent-assets-unavailable");
  }
  const now = input.now ?? Date.now;
  const priorSessionStillValid =
    input.snapshot.accountExpiresAt === undefined || input.snapshot.accountExpiresAt > now();
  if (
    input.snapshot.accountSignedIn &&
    priorSessionStillValid &&
    input.snapshot.authCookiePresent &&
    !fs.existsSync(path.join(input.currentUserDataPath, "auth", "session-cookie.v1.json"))
  ) {
    violations.push("account-session-missing");
  }
  if (input.snapshot.accountSignedIn && priorSessionStillValid && !input.currentAccountSignedIn) {
    violations.push("account-session-not-restored");
  }
  if (input.snapshot.routeFilePresent) {
    const currentRoutePath = path.join(input.currentUserDataPath, "agent-routes.json");
    if (!fs.existsSync(currentRoutePath)) {
      violations.push("agent-routes-missing");
    } else if (input.snapshot.routeFileHash && hashFile(currentRoutePath) !== input.snapshot.routeFileHash) {
      violations.push("agent-routes-changed");
    }
  }
  return { ok: violations.length === 0, violations };
}
