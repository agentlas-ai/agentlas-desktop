import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CONTINUITY_CORE_TABLES,
  type ContinuitySnapshot,
  type ContinuityVerification,
} from "./controller";

const CONTINUITY_TABLES = CONTINUITY_CORE_TABLES;

type TableColumn = { name: string; pk: number };

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

function databaseFacts(db: Database.Database): {
  databaseSchemaVersion: number;
  rowCounts: Record<string, number>;
  tableIdentityHashes: Record<string, string>;
} {
  const databaseSchemaVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  const rowCounts: Record<string, number> = {};
  const tableIdentityHashes: Record<string, string> = {};
  for (const table of CONTINUITY_TABLES) {
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

function verifyProtectedDatabaseRows(
  backup: Database.Database,
  current: Database.Database,
): string[] {
  const violations: string[] = [];
  const approvedDeletedChats = migrationApprovedDeletedChats(current);
  for (const table of CONTINUITY_TABLES) {
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
    const currentLookup = current.prepare(
      `SELECT ${projection} FROM ${quoteIdentifier(table)} WHERE ${primaryKeyColumns
        .map((column) => `${quoteIdentifier(column.name)} = ?`)
        .join(" AND ")} LIMIT 1`,
    );
    const backupRows = backup.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}`).iterate() as Iterable<Record<string, unknown>>;
    for (const before of backupRows) {
      const key = rowKey(before, primaryKeyColumns);
      const after = currentLookup.get(...primaryKeyColumns.map((column) => before[column.name])) as Record<string, unknown> | undefined;
      if (!after) {
        const chatId = table === "chats" && primaryKeyColumns.length === 1
          ? String(before[primaryKeyColumns[0].name] ?? "")
          : "";
        if (!chatId || !approvedDeletedChats.has(chatId)) violations.push(`protected-row-missing:${table}:${sha256(key)}`);
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
      schemaVersion: 1,
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
      const facts = databaseFacts(recoveryDb);
      if (facts.databaseSchemaVersion !== input.snapshot.databaseSchemaVersion) {
        violations.push("recovery-schema-mismatch");
      }
      for (const table of CONTINUITY_TABLES) {
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
    const current = databaseFacts(db);
    if (current.databaseSchemaVersion < input.snapshot.databaseSchemaVersion) {
      violations.push("database-schema-regressed");
    }
    for (const [table, expected] of Object.entries(input.snapshot.rowCounts)) {
      if ((current.rowCounts[table] ?? 0) < expected) violations.push(`row-count-regressed:${table}`);
      if (
        (current.rowCounts[table] ?? 0) === expected &&
        current.tableIdentityHashes[table] !== input.snapshot.tableIdentityHashes[table]
      ) {
        violations.push(`table-identity-changed:${table}`);
      }
    }
    violations.push(...verifyProtectedDatabaseRows(backupDb, db));
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
