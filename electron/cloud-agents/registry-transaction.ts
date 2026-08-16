import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { app } from "electron";
import { getRoute, removeRoute, setRoute, type AgentRoute } from "../agents/routes";
import { getDb } from "../store/db";
import { readCloudAgentRestoreMarker, restoreCloudAgentPackage } from "./restore";
import type {
  AgentVisibility,
  CloudAgentCloudScope,
  CloudAgentPackageDownload,
  CloudAgentPackageHashVersion,
  CloudAgentRevisionIdentity,
  RuntimeBackend,
} from "../../shared/types";

const JOURNAL_SCHEMA_VERSION = 1;

type JournalPhase =
  | "prepared"
  | "backup-created"
  | "assets-swapped"
  | "db-mutated"
  | "route-written"
  | "committed";

export interface CloudRegistryAgentRow {
  id: string;
  slug: string;
  name: string;
  name_en: string;
  tagline: string;
  tagline_en: string;
  system_prompt: string;
  mcp_servers_json: string;
  env_requirements_json: string;
  preferred_backend: RuntimeBackend | null;
  trust_grade: "A" | "B" | "C" | "unknown";
  installed_at: string;
  tone: string;
  builtin: number;
  role: string | null;
  visibility: AgentVisibility;
  entity_kind: "agent" | "team" | null;
  /** Desktop-only metadata; older transaction journals legitimately omit it. */
  local_display_name?: string | null;
  /** v75 team-member cell: owning firm id, NULL/absent for standalone agents. */
  parent_team_id?: string | null;
}

interface CloudRegistryJournal {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  transactionId: string;
  phase: JournalPhase;
  createdAt: string;
  updatedAt: string;
  agentId: string;
  slug: string;
  destinationDir: string;
  backupDir: string;
  hadDestination: boolean;
  previousRoute: AgentRoute | null;
  expectedRoute: AgentRoute;
  registration?: CloudAgentRevisionIdentity;
  registrations?: Partial<Record<CloudAgentCloudScope, CloudAgentRevisionIdentity>>;
  expectedPackageHashVersion: CloudAgentPackageHashVersion;
  expectedFiles: Array<{ path: string; bytes: number; sha256: string; executable: boolean }>;
  previousRow: CloudRegistryAgentRow | null;
  expectedRow: CloudRegistryAgentRow;
}

export interface CommitCloudRegistryPackageInput {
  slug: string;
  package: CloudAgentPackageDownload;
  previousRow: CloudRegistryAgentRow | null;
  expectedRow: CloudRegistryAgentRow;
  expectedRoute: AgentRoute;
  registration?: CloudAgentRevisionIdentity;
  /** Runs inside the same SQLite transaction as the route-file transition. */
  mutateDb: () => void;
}

/**
 * Commits an already verified Agent Cloud/Hub package across the three durable
 * authorities used by Desktop: managed files, SQLite metadata, and routes.
 *
 * SQLite cannot atomically include a JSON file or directory rename, so this is
 * a small write-ahead transaction. The prior package is retained until the DB
 * transaction commits, every journal write and route write is atomic, and a
 * boot-time reconciliation can either roll the three surfaces back or finish a
 * committed transition after an abrupt process exit.
 */
export function commitCloudRegistryPackage(input: CommitCloudRegistryPackageInput): AgentRoute {
  recoverCloudRegistryTransactions();
  validateInput(input);
  const expectedRoute: AgentRoute = {
    ...input.expectedRoute,
    packageHash: normalizeSha256(input.package.packageHash, "packageHash"),
  };

  const transactionId = randomUUID();
  const destinationDir = managedDestination(input.slug);
  const previousRestoreMarker = fs.existsSync(destinationDir)
    ? readCloudAgentRestoreMarker(destinationDir)
    : null;
  const registrations = mergeRegistrations(previousRestoreMarker?.registrations, input.registration);
  const backupDir = path.join(
    agentsRoot(),
    `.${path.basename(destinationDir)}.registry-backup-${transactionId}`,
  );
  const journalFile = path.join(journalRoot(), `${transactionId}.json`);
  const now = new Date().toISOString();
  const journal: CloudRegistryJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    transactionId,
    phase: "prepared",
    createdAt: now,
    updatedAt: now,
    agentId: input.expectedRow.id,
    slug: input.slug,
    destinationDir,
    backupDir,
    hadDestination: fs.existsSync(destinationDir),
    previousRoute: input.previousRow ? getRoute(input.previousRow.id) : null,
    expectedRoute,
    registration: input.registration,
    ...(registrations ? { registrations } : {}),
    expectedPackageHashVersion: input.package.packageHashVersion ?? "path-sha256-v1",
    expectedFiles: input.package.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: normalizeSha256(file.sha256, `file hash for ${file.path}`),
      executable: file.executable === true,
    })),
    previousRow: input.previousRow,
    expectedRow: input.expectedRow,
  };

  validateJournal(journalFile, journal);
  writeJournal(journalFile, journal);
  try {
    if (journal.hadDestination) {
      assertReplaceableManagedDirectory(destinationDir);
      fs.renameSync(destinationDir, backupDir);
      fsyncDirectoryBestEffort(agentsRoot());
    }
    updateJournal(journalFile, journal, "backup-created");

    restoreCloudAgentPackage({
      destinationDir,
      slug: input.slug,
      package: input.package,
      restoredAt: input.expectedRoute.importedAt,
      registration: input.registration,
      preservedRegistrations: previousRestoreMarker?.registrations,
      // Lineage travels with the package. Falling back to the marker already on
      // disk means a repair or re-restore cannot launder a copy into an
      // original by arriving without it.
      fork: input.package.fork ?? previousRestoreMarker?.fork,
    });
    updateJournal(journalFile, journal, "assets-swapped");
    injectFailure("after-swap");

    const db = getDb();
    const mutate = db.transaction(() => {
      input.mutateDb();
      updateJournal(journalFile, journal, "db-mutated");
      injectFailure("after-db");

      setRoute(expectedRoute);
      updateJournal(journalFile, journal, "route-written");
      injectFailure("after-route");
    });
    mutate();
    fsyncManagedTree(destinationDir);
    if (
      !diskMatchesJournal(journal) ||
      !rowsEqual(readRow(journal.agentId), journal.expectedRow) ||
      !routesEqual(getRoute(journal.agentId), journal.expectedRoute)
    ) {
      throw new Error("Agent Cloud registry post-commit durability verification failed.");
    }
    injectFailure("after-commit");
  } catch (error) {
    if (error instanceof SimulatedAbruptExit) {
      // E2E-only crash simulation: deliberately leave the durable journal and
      // filesystem state exactly where a killed process would leave them.
      throw error;
    }
    try {
      rollbackJournal(journalFile, journal);
    } catch (rollbackError) {
      throw new Error(
        `Agent Cloud registry transaction failed and automatic rollback needs recovery: ${errorMessage(error)}; rollback: ${errorMessage(rollbackError)}`,
      );
    }
    throw error;
  }

  // The three live surfaces are coherent once the SQLite transaction returns.
  // Cleanup failure must not report the install as failed: the durable journal
  // lets the next startup finish deleting the obsolete backup.
  try {
    updateJournal(journalFile, journal, "committed");
    injectFailure("after-journal-commit");
    finalizeJournal(journalFile, journal);
  } catch (error) {
    if (error instanceof SimulatedAbruptExit) throw error;
    console.warn("[agent-cloud] committed registry transaction cleanup deferred:", errorMessage(error));
  }
  return expectedRoute;
}

/** Recover every transaction left by an interrupted Desktop process. */
export function recoverCloudRegistryTransactions(): void {
  const root = journalRoot();
  if (!fs.existsSync(root)) return;
  const files = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(root, entry.name))
    .sort();

  for (const file of files) {
    const journal = readJournal(file);
    validateJournal(file, journal);
    const currentRow = readRow(journal.agentId);
    const dbIsExpected = rowsEqual(currentRow, journal.expectedRow);
    const diskIsExpected = diskMatchesJournal(journal);
    const dbIsPrevious = rowsEqual(currentRow, journal.previousRow);
    const currentRoute = getRoute(journal.agentId);
    const routeIsKnown =
      routesEqual(currentRoute, journal.previousRoute) ||
      routesEqual(currentRoute, journal.expectedRoute);

    if (journal.phase === "committed") {
      if (dbIsExpected && diskIsExpected && routeIsKnown) {
        setRoute(journal.expectedRoute);
        finalizeJournal(file, journal);
        continue;
      }
      if ((!dbIsExpected && !dbIsPrevious) || !routeIsKnown) {
        throw new Error(
          `Agent Cloud committed registry recovery stopped for ${journal.slug}: durable authority changed outside transaction ${journal.transactionId}.`,
        );
      }
      // A committed marker is not proof that every live byte reached durable
      // storage. If exact CAS verification fails while the old backup exists,
      // compensate all three surfaces and preserve any modified new copy.
      rollbackJournal(file, journal);
      continue;
    }

    if (dbIsExpected && diskIsExpected) {
      // SQLite committed before the process could mark the journal. The package
      // marker is exact, so repairing the atomic route file safely rolls forward.
      setRoute(journal.expectedRoute);
      updateJournal(file, journal, "committed");
      finalizeJournal(file, journal);
      continue;
    }

    if (!dbIsExpected && !dbIsPrevious) {
      throw new Error(
        `Agent Cloud registry recovery stopped: SQLite row for ${journal.slug} changed outside transaction ${journal.transactionId}.`,
      );
    }
    if (!routeIsKnown) {
      throw new Error(
        `Agent Cloud registry recovery stopped: route for ${journal.slug} changed outside transaction ${journal.transactionId}.`,
      );
    }

    if (!fs.existsSync(journal.backupDir) && diskIsExpected && journal.hadDestination) {
      // The new package is complete but the obsolete backup disappeared. It is
      // safer and lossless to finish the journal than to delete the only copy.
      writeRow(journal.expectedRow);
      setRoute(journal.expectedRoute);
      updateJournal(file, journal, "committed");
      finalizeJournal(file, journal);
      continue;
    }

    rollbackJournal(file, journal);
  }
}

function rollbackJournal(
  journalFile: string,
  journal: CloudRegistryJournal,
): void {
  restoreManagedDirectory(journal);
  restoreRoute(journal.agentId, journal.previousRoute);
  restoreRow(journal.previousRow, journal.expectedRow);
  removeFileDurably(journalFile);
}

function restoreManagedDirectory(journal: CloudRegistryJournal): void {
  const destinationExists = fs.existsSync(journal.destinationDir);
  const backupExists = fs.existsSync(journal.backupDir);

  if (backupExists) {
    if (destinationExists) {
      const orphan = path.join(
        agentsRoot(),
        `.${path.basename(journal.destinationDir)}.registry-orphan-${journal.transactionId}`,
      );
      fs.renameSync(journal.destinationDir, orphan);
      fs.renameSync(journal.backupDir, journal.destinationDir);
      fsyncDirectoryBestEffort(agentsRoot());
      // Preserve an unexpectedly edited post-swap copy instead of deleting user
      // work. Exact transaction output can be removed after the old live copy is
      // safely back in place.
      if (diskMatchesJournal(journal, orphan)) {
        fs.rmSync(orphan, { recursive: true, force: true });
      } else {
        console.warn(`[agent-cloud] preserved recovery orphan at ${orphan}`);
      }
    } else {
      fs.renameSync(journal.backupDir, journal.destinationDir);
      fsyncDirectoryBestEffort(agentsRoot());
    }
    return;
  }

  if (!journal.hadDestination && destinationExists) {
    if (diskMatchesJournal(journal)) {
      fs.rmSync(journal.destinationDir, { recursive: true, force: true });
      fsyncDirectoryBestEffort(agentsRoot());
      return;
    }
    const orphan = path.join(
      agentsRoot(),
      `.${path.basename(journal.destinationDir)}.registry-orphan-${journal.transactionId}`,
    );
    fs.renameSync(journal.destinationDir, orphan);
    fsyncDirectoryBestEffort(agentsRoot());
    console.warn(`[agent-cloud] preserved unrecognized recovery orphan at ${orphan}`);
    return;
  }

  if (journal.hadDestination) {
    throw new Error(
      `Previous managed package backup is missing and the live copy is not the exact committed package for ${journal.slug}; recovery is blocked to avoid splitting disk, route, and SQLite authority.`,
    );
  }
}

function finalizeJournal(journalFile: string, journal: CloudRegistryJournal): void {
  if (fs.existsSync(journal.backupDir)) {
    fs.rmSync(journal.backupDir, { recursive: true, force: true });
    fsyncDirectoryBestEffort(agentsRoot());
  }
  removeFileDurably(journalFile);
}

function fsyncManagedTree(root: string): void {
  const syncDirectory = (directory: string): void => {
    const before = fs.lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`Cannot durably sync non-directory package path: ${directory}`);
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Cannot durably sync symbolic-link package path: ${target}`);
      }
      if (entry.isDirectory()) {
        syncDirectory(target);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Cannot durably sync special package path: ${target}`);
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error(`Cannot durably sync non-regular package file: ${target}`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const after = fs.lstatSync(directory);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error(`Managed package directory changed during durable sync: ${directory}`);
    }
  };
  syncDirectory(root);
  fsyncDirectoryBestEffort(path.dirname(root));
}

function restoreRoute(agentId: string, route: AgentRoute | null): void {
  if (route) setRoute(route);
  else removeRoute(agentId);
}

function restoreRow(
  previous: CloudRegistryAgentRow | null,
  expected: CloudRegistryAgentRow,
): void {
  const db = getDb();
  const restore = db.transaction(() => {
    const current = readRow(expected.id);
    if (previous) {
      if (current && !rowsEqual(current, previous) && !rowsEqual(current, expected)) {
        throw new Error(`Refusing to overwrite an unrelated SQLite row for ${expected.slug}.`);
      }
      writeRow(previous);
      return;
    }
    if (!current) return;
    if (!rowsEqual(current, expected)) {
      throw new Error(`Refusing to delete an unrelated SQLite row for ${expected.slug}.`);
    }
    db.prepare("DELETE FROM installed_agents WHERE id = ?").run(expected.id);
  });
  restore();
}

function readRow(id: string): CloudRegistryAgentRow | null {
  return (
    (getDb().prepare("SELECT * FROM installed_agents WHERE id = ?").get(id) as
      | CloudRegistryAgentRow
      | undefined) ?? null
  );
}

function writeRow(row: CloudRegistryAgentRow): void {
  const db = getDb();
  const values = rowValues(row);
  if (readRow(row.id)) {
    db.prepare(
      `UPDATE installed_agents
       SET slug = ?, name = ?, name_en = ?, tagline = ?, tagline_en = ?, system_prompt = ?,
           mcp_servers_json = ?, env_requirements_json = ?, preferred_backend = ?, trust_grade = ?,
           installed_at = ?, tone = ?, builtin = ?, role = ?, visibility = ?, entity_kind = ?,
           local_display_name = ?
       WHERE id = ?`,
    ).run(...values.slice(1), row.id);
    return;
  }
  db.prepare(
    `INSERT INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role,
      visibility, entity_kind, local_display_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...values);
}

function rowValues(row: CloudRegistryAgentRow): unknown[] {
  return [
    row.id,
    row.slug,
    row.name,
    row.name_en,
    row.tagline,
    row.tagline_en,
    row.system_prompt,
    row.mcp_servers_json,
    row.env_requirements_json,
    row.preferred_backend,
    row.trust_grade,
    row.installed_at,
    row.tone,
    row.builtin,
    row.role,
    row.visibility,
    row.entity_kind,
    row.local_display_name ?? null,
  ];
}

function rowsEqual(
  left: CloudRegistryAgentRow | null,
  right: CloudRegistryAgentRow | null,
): boolean {
  if (!left || !right) return left === right;
  return rowValues(left).every((value, index) => value === rowValues(right)[index]);
}

function routesEqual(left: AgentRoute | null, right: AgentRoute | null): boolean {
  if (!left || !right) return left === right;
  return (
    left.agentId === right.agentId &&
    left.path === right.path &&
    left.runtime === right.runtime &&
    left.kind === right.kind &&
    left.importedAt === right.importedAt &&
    left.source === right.source &&
    left.packageHash === right.packageHash &&
    left.labels.length === right.labels.length &&
    left.labels.every((label, index) => label === right.labels[index])
  );
}

function validateInput(input: CommitCloudRegistryPackageInput): void {
  if (input.expectedRow.id !== input.expectedRoute.agentId) {
    throw new Error("Agent Cloud registry row and route identities do not match.");
  }
  if (input.expectedRow.slug !== input.slug) {
    throw new Error("Agent Cloud registry row and package slugs do not match.");
  }
  const destination = managedDestination(input.slug);
  if (path.resolve(input.expectedRoute.path) !== destination) {
    throw new Error("Agent Cloud registry route does not target the managed package directory.");
  }
  if (
    !input.expectedRoute.packageHash ||
    normalizeSha256(input.expectedRoute.packageHash, "route packageHash") !==
      normalizeSha256(input.package.packageHash, "packageHash")
  ) {
    throw new Error("Agent Cloud registry route and package hashes do not match.");
  }
}

function validateJournal(file: string, journal: CloudRegistryJournal): void {
  if (
    journal.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    typeof journal.transactionId !== "string" ||
    typeof journal.slug !== "string" ||
    typeof journal.agentId !== "string" ||
    !journal.expectedRow ||
    !journal.expectedRoute ||
    !Array.isArray(journal.expectedFiles)
  ) {
    throw new Error(`Invalid Agent Cloud registry transaction journal: ${file}`);
  }
  const expectedDestination = managedDestination(journal.slug);
  if (path.resolve(journal.destinationDir) !== expectedDestination) {
    throw new Error(`Agent Cloud registry journal has an unsafe destination: ${file}`);
  }
  const expectedBackupPrefix = `.${path.basename(expectedDestination)}.registry-backup-`;
  if (
    path.dirname(path.resolve(journal.backupDir)) !== agentsRoot() ||
    path.basename(journal.backupDir) !== `${expectedBackupPrefix}${journal.transactionId}`
  ) {
    throw new Error(`Agent Cloud registry journal has an unsafe backup: ${file}`);
  }
  if (journal.agentId !== journal.expectedRow.id || journal.agentId !== journal.expectedRoute.agentId) {
    throw new Error(`Agent Cloud registry journal identity mismatch: ${file}`);
  }
  if (path.basename(file) !== `${journal.transactionId}.json`) {
    throw new Error(`Agent Cloud registry journal filename mismatch: ${file}`);
  }
  if (
    journal.expectedRow.slug !== journal.slug ||
    (journal.previousRow &&
      (journal.previousRow.id !== journal.agentId || journal.previousRow.slug !== journal.slug)) ||
    path.resolve(journal.expectedRoute.path) !== expectedDestination ||
    !/^[a-f0-9]{64}$/.test(journal.expectedRoute.packageHash ?? "")
  ) {
    throw new Error(`Agent Cloud registry journal authority mismatch: ${file}`);
  }
  const hashVersion = journal.expectedPackageHashVersion;
  if (hashVersion !== "path-sha256-v1" && hashVersion !== "path-sha256-executable-v2") {
    throw new Error(`Agent Cloud registry journal hash version mismatch: ${file}`);
  }
  if (journal.expectedFiles.length === 0 || journal.expectedFiles.length > 400) {
    throw new Error(`Agent Cloud registry journal file count mismatch: ${file}`);
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const expected of journal.expectedFiles) {
    const safePath = validateExpectedFilePath(expected.path);
    const portableKey = safePath.toLowerCase();
    if (
      paths.has(portableKey) ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 0 ||
      expected.bytes > 512 * 1024 ||
      !/^[a-f0-9]{64}$/.test(expected.sha256) ||
      typeof expected.executable !== "boolean" ||
      (hashVersion === "path-sha256-v1" && expected.executable)
    ) {
      throw new Error(`Agent Cloud registry journal file manifest mismatch: ${file}`);
    }
    paths.add(portableKey);
    totalBytes += expected.bytes;
    if (totalBytes > 3 * 1024 * 1024) {
      throw new Error(`Agent Cloud registry journal byte count mismatch: ${file}`);
    }
  }
  if (hashJournalFiles(journal.expectedFiles, hashVersion) !== journal.expectedRoute.packageHash) {
    throw new Error(`Agent Cloud registry journal package hash mismatch: ${file}`);
  }
  const registrations = expectedJournalRegistrations(journal);
  if (!journalRegistrationsAreValid(registrations, journal.slug)) {
    throw new Error(`Agent Cloud registry journal registration mismatch: ${file}`);
  }
  if (
    journal.registration &&
    !registrationsEqual(
      { [journal.registration.scope]: journal.registration },
      { [journal.registration.scope]: registrations?.[journal.registration.scope] },
    )
  ) {
    throw new Error(`Agent Cloud registry journal current registration mismatch: ${file}`);
  }
}

function validateExpectedFilePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.length > 260
  ) {
    throw new Error(`Unsafe Agent Cloud registry journal path: ${String(value)}`);
  }
  for (const part of value.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[<>:"|?*\u0000-\u001f]/.test(part) ||
      /[ .]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    ) {
      throw new Error(`Unsafe Agent Cloud registry journal path: ${value}`);
    }
  }
  if (value.toLowerCase() === ".agentlas-cloud-package.json") {
    throw new Error("Agent Cloud registry journal cannot include its restore marker.");
  }
  return value;
}

function diskMatchesJournal(
  journal: CloudRegistryJournal,
  candidateDir = journal.destinationDir,
): boolean {
  const expectedExecutablePaths = journal.expectedFiles
    .filter((file) => file.executable)
    .map((file) => file.path)
    .sort();
  const expected = new Map(journal.expectedFiles.map((file) => [file.path, file]));
  const expectedDirectories = new Set<string>();
  for (const file of journal.expectedFiles) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      expectedDirectories.add(parts.slice(0, index).join("/"));
    }
  }
  const seen = new Set<string>();
  let markerSeen = false;
  let rootReal: string;
  try {
    const stat = fs.lstatSync(candidateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !directoryModeMatches(stat.mode)) return false;
    rootReal = fs.realpathSync.native(candidateDir);
  } catch {
    return false;
  }

  const walk = (directory: string, relativeDirectory: string): boolean => {
    let directoryBefore: fs.Stats;
    let directoryRealBefore: string;
    let entries: fs.Dirent[];
    try {
      directoryBefore = fs.lstatSync(directory);
      directoryRealBefore = fs.realpathSync.native(directory);
      if (
        !directoryBefore.isDirectory() ||
        directoryBefore.isSymbolicLink() ||
        !directoryModeMatches(directoryBefore.mode) ||
        !isInside(rootReal, directoryRealBefore)
      ) return false;
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relative) || !walk(absolute, relative)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      if (relative === ".agentlas-cloud-package.json") {
        try {
          const stable = readStableFile(absolute, rootReal, 256 * 1024);
          if (!fileModeMatches(stable.mode, false)) return false;
          const marker = JSON.parse(stable.content.toString("utf8")) as {
            source?: unknown;
            slug?: unknown;
            packageHash?: unknown;
            packageHashVersion?: unknown;
            fileCount?: unknown;
            totalBytes?: unknown;
            executablePaths?: unknown;
            registrations?: unknown;
          };
          const markerExecutableMetadataValid =
            journal.expectedPackageHashVersion === "path-sha256-v1"
              ? marker.executablePaths === undefined
              : Array.isArray(marker.executablePaths) &&
                marker.executablePaths.every((value) => typeof value === "string");
          const markerExecutablePaths = markerExecutableMetadataValid && Array.isArray(marker.executablePaths)
            ? [...marker.executablePaths].sort()
            : [];
          if (
            !markerExecutableMetadataValid ||
            marker.source !== "agentlas-cloud" ||
            marker.slug !== journal.slug ||
            marker.packageHash !== journal.expectedRoute.packageHash ||
            (marker.packageHashVersion ?? "path-sha256-v1") !== journal.expectedPackageHashVersion ||
            marker.fileCount !== journal.expectedFiles.length ||
            marker.totalBytes !== journal.expectedFiles.reduce((sum, file) => sum + file.bytes, 0) ||
            markerExecutablePaths.length !== expectedExecutablePaths.length ||
            !markerExecutablePaths.every((value, index) => value === expectedExecutablePaths[index]) ||
            !registrationsEqual(marker.registrations, expectedJournalRegistrations(journal))
          ) return false;
          markerSeen = true;
        } catch {
          return false;
        }
        continue;
      }
      const expectedFile = expected.get(relative);
      if (!expectedFile) return false;
      try {
        const stable = readStableFile(absolute, rootReal, expectedFile.bytes, expectedFile.bytes);
        if (
          stable.content.length !== expectedFile.bytes ||
          createHash("sha256").update(stable.content).digest("hex") !== expectedFile.sha256 ||
          !fileModeMatches(stable.mode, expectedFile.executable)
        ) return false;
      } catch {
        return false;
      }
      seen.add(relative);
    }
    try {
      const directoryAfter = fs.lstatSync(directory);
      const directoryRealAfter = fs.realpathSync.native(directory);
      return (
        directoryAfter.isDirectory() &&
        !directoryAfter.isSymbolicLink() &&
        directoryRealBefore === directoryRealAfter &&
        directoryBefore.dev === directoryAfter.dev &&
        directoryBefore.ino === directoryAfter.ino &&
        directoryBefore.mode === directoryAfter.mode &&
        directoryBefore.mtimeMs === directoryAfter.mtimeMs &&
        directoryBefore.ctimeMs === directoryAfter.ctimeMs
      );
    } catch {
      return false;
    }
  };
  return walk(candidateDir, "") && markerSeen && seen.size === expected.size;
}

function mergeRegistrations(
  previous: Partial<Record<CloudAgentCloudScope, CloudAgentRevisionIdentity>> | undefined,
  current: CloudAgentRevisionIdentity | undefined,
): Partial<Record<CloudAgentCloudScope, CloudAgentRevisionIdentity>> | undefined {
  const merged = {
    ...(previous ?? {}),
    ...(current ? { [current.scope]: current } : {}),
  };
  return Object.keys(merged).length ? merged : undefined;
}

function expectedJournalRegistrations(
  journal: CloudRegistryJournal,
): Partial<Record<CloudAgentCloudScope, CloudAgentRevisionIdentity>> | undefined {
  return journal.registrations ?? mergeRegistrations(undefined, journal.registration);
}

function journalRegistrationsAreValid(value: unknown, slug: string): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((scope) => scope !== "owner-private" && scope !== "hub-public")) return false;
  return (["owner-private", "hub-public"] as const).every((scope) => {
    const raw = record[scope];
    if (raw === undefined) return true;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const item = raw as Partial<CloudAgentRevisionIdentity>;
    return (
      typeof item.cloudId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(item.cloudId) &&
      item.slug === slug &&
      item.scope === scope &&
      typeof item.packageHash === "string" && /^[a-f0-9]{64}$/.test(item.packageHash) &&
      (item.packageHashVersion === "path-sha256-v1" || item.packageHashVersion === "path-sha256-executable-v2") &&
      typeof item.revision === "string" && /^rev_[a-f0-9]{32}$/.test(item.revision) &&
      (item.updatedAt === undefined ||
        (typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt))))
    );
  });
}

function registrationsEqual(left: unknown, right: unknown): boolean {
  if (!journalRegistrationsAreValid(left, registrationSlug(left)) ||
      !journalRegistrationsAreValid(right, registrationSlug(right))) return false;
  return JSON.stringify(canonicalRegistrations(left)) === JSON.stringify(canonicalRegistrations(right));
}

function registrationSlug(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const scope of ["owner-private", "hub-public"] as const) {
    const item = record[scope];
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const slug = (item as Record<string, unknown>).slug;
      if (typeof slug === "string") return slug;
    }
  }
  return "";
}

function canonicalRegistrations(value: unknown): unknown {
  if (value === undefined) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(record["owner-private"] !== undefined ? { "owner-private": record["owner-private"] } : {}),
    ...(record["hub-public"] !== undefined ? { "hub-public": record["hub-public"] } : {}),
  };
}

function readStableFile(
  file: string,
  rootReal: string,
  maxBytes: number,
  exactBytes?: number,
): { content: Buffer; mode: number } {
  const beforeReal = fs.realpathSync.native(file);
  if (!isInside(rootReal, beforeReal)) throw new Error("registry package file resolves outside root");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > maxBytes ||
      (exactBytes !== undefined && before.size !== exactBytes)
    ) throw new Error("unstable registry package file");
    const chunks: Buffer[] = [];
    let actualBytes = 0;
    for (;;) {
      const remaining = maxBytes + 1 - actualBytes;
      if (remaining <= 0) throw new Error("registry package file exceeded its byte limit");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const read = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      actualBytes += read;
      if (actualBytes > maxBytes) throw new Error("registry package file exceeded its byte limit");
      chunks.push(chunk.subarray(0, read));
    }
    const after = fs.fstatSync(fd);
    const afterReal = fs.realpathSync.native(file);
    const pathStat = fs.lstatSync(file);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      beforeReal !== afterReal ||
      !isInside(rootReal, afterReal) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      after.dev !== pathStat.dev ||
      after.ino !== pathStat.ino ||
      after.mode !== pathStat.mode ||
      actualBytes !== after.size ||
      (exactBytes !== undefined && actualBytes !== exactBytes)
    ) throw new Error("registry package file changed during recovery");
    return { content: Buffer.concat(chunks, actualBytes), mode: after.mode };
  } finally {
    fs.closeSync(fd);
  }
}

function hashJournalFiles(
  files: CloudRegistryJournal["expectedFiles"],
  version: CloudAgentPackageHashVersion,
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    if (version === "path-sha256-executable-v2") {
      hash.update(file.executable ? "x" : "-");
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileModeMatches(mode: number, executable: boolean): boolean {
  return process.platform === "win32" || (mode & 0o777) === (executable ? 0o700 : 0o600);
}

function directoryModeMatches(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o777) === 0o700;
}

function managedDestination(slug: string): string {
  if (
    typeof slug !== "string" ||
    !slug ||
    slug === "." ||
    slug === ".." ||
    slug.includes("/") ||
    slug.includes("\\") ||
    slug.includes("\0")
  ) {
    throw new Error(`Unsafe managed agent slug: ${String(slug)}`);
  }
  const destination = path.resolve(agentsRoot(), slug);
  if (path.dirname(destination) !== agentsRoot()) {
    throw new Error(`Managed agent path escapes the agents directory: ${slug}`);
  }
  return destination;
}

function assertReplaceableManagedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Agent Cloud managed destination must be a non-symbolic-link directory.");
  }
}

function agentsRoot(): string {
  return path.resolve(app.getPath("userData"), "agents");
}

function journalRoot(): string {
  return path.resolve(app.getPath("userData"), "agent-cloud-registry-journal");
}

function readJournal(file: string): CloudRegistryJournal {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CloudRegistryJournal;
  } catch (error) {
    throw new Error(`Cannot read Agent Cloud registry transaction journal ${file}: ${errorMessage(error)}`);
  }
}

function updateJournal(
  file: string,
  journal: CloudRegistryJournal,
  phase: JournalPhase,
): void {
  journal.phase = phase;
  journal.updatedAt = new Date().toISOString();
  writeJournal(file, journal);
}

function writeJournal(file: string, journal: CloudRegistryJournal): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    fsyncDirectoryBestEffort(parent);
    // Persist the journal-directory entry too. This matters on the first Cloud
    // install, when the directory itself may have been created just before the
    // write-ahead record.
    fsyncDirectoryBestEffort(path.dirname(parent));
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // Successful rename consumes the temp path.
    }
  }
}

function removeFileDurably(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fsyncDirectoryBestEffort(path.dirname(file));
}

function fsyncDirectoryBestEffort(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is unsupported on a subset of filesystems. Atomic rename
    // still protects the individual file/directory transition.
  }
}

type FailurePhase =
  | "after-swap"
  | "after-db"
  | "after-route"
  | "after-commit"
  | "after-journal-commit";

class SimulatedAbruptExit extends Error {}

function injectFailure(phase: FailurePhase): void {
  if (process.env.AGENTLAS_E2E !== "1") return;
  const requested = process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE;
  if (requested === phase) {
    throw new Error(`Injected Agent Cloud registry failure: ${phase}`);
  }
  if (requested === `crash-${phase}`) {
    throw new SimulatedAbruptExit(`Simulated abrupt Agent Cloud registry exit: ${phase}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSha256(value: unknown, label: string): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`Agent Cloud registry ${label} is not a SHA-256 digest.`);
  }
  return normalized;
}
