#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const electron = require("electron");
const app = electron && typeof electron === "object" ? electron.app : null;

app?.disableHardwareAcceleration();

const {
  scrubInactiveUpdaterRecoveryOpenCrabCredentialUrls,
  verifyUpdaterRecoveryCopies,
} = require("../dist/electron/updater/continuity.js");
const { CONTINUITY_CORE_TABLES } = require("../dist/electron/updater/controller.js");
const {
  OPENCRAB_MCP_URL_SENTINEL,
} = require("../dist/electron/opencrab/constants.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-opencrab-recovery-scrub-"));
const userDataPath = path.join(root, "user-data");
const recoveryRoot = path.join(userDataPath, "updater", "recovery");
const updaterRoot = path.dirname(recoveryRoot);
const tokenA = ["ocm", "recovery-active-regression-secret-a"].join("_");
const tokenB = ["ocm", "recovery-free-page-regression-secret-b"].join("_");
const urlA = `https://opencrab.sh/api/mcp/${tokenA}`;
const urlB = `malformed-opencrab-endpoint/${tokenB}`;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function contains(file, value) {
  return fs.existsSync(file) && fs.readFileSync(file).includes(Buffer.from(value));
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function snapshotFacts(databasePath) {
  const db = new Database(databasePath, { readonly: true });
  const databaseSchemaVersion = Number(db.pragma("user_version", { simple: true }) || 0);
  const rowCounts = {};
  const tableIdentityHashes = {};
  try {
    for (const table of CONTINUITY_CORE_TABLES) {
      const exists = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
      );
      if (!exists) {
        rowCounts[table] = 0;
        tableIdentityHashes[table] = crypto.createHash("sha256").update(`missing:${table}`).digest("hex");
        continue;
      }
      rowCounts[table] = Number(
        db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count,
      );
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
      const identity = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      const selected = identity.length > 0 ? identity : columns.slice(0, 1);
      if (selected.length === 0) {
        tableIdentityHashes[table] = crypto.createHash("sha256").update(`empty-schema:${table}`).digest("hex");
        continue;
      }
      const projection = selected.map((column) => quoteIdentifier(column.name)).join(", ");
      const order = selected.map((column) => quoteIdentifier(column.name)).join(", ");
      const hash = crypto.createHash("sha256");
      for (const row of db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)} ORDER BY ${order}`).iterate()) {
        hash.update(JSON.stringify(row));
        hash.update("\n");
      }
      tableIdentityHashes[table] = hash.digest("hex");
    }
    return { databaseSchemaVersion, rowCounts, tableIdentityHashes };
  } finally {
    db.close();
  }
}

function writeContinuitySnapshot(directory, databasePath) {
  const agentsBackupPath = path.join(directory, "agents");
  fs.mkdirSync(agentsBackupPath, { recursive: true });
  const facts = snapshotFacts(databasePath);
  const snapshot = {
    schemaVersion: 1,
    userDataPath: path.resolve(userDataPath),
    databasePath: path.resolve(path.join(userDataPath, "agentlas.sqlite")),
    backupPath: path.resolve(databasePath),
    databaseSchemaVersion: facts.databaseSchemaVersion,
    rowCounts: facts.rowCounts,
    tableIdentityHashes: facts.tableIdentityHashes,
    agentDirectoryNames: [],
    agentAssetHashes: {},
    agentsBackupPath: path.resolve(agentsBackupPath),
    authCookiePresent: false,
    accountSignedIn: false,
    routeFilePresent: false,
    routeFileHash: null,
    routeBackupPath: null,
    capturedAt: new Date().toISOString(),
  };
  const continuityPath = path.join(directory, "continuity.json");
  fs.writeFileSync(continuityPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return { continuityPath, snapshot };
}

function createRecovery(name, credentialUrl, options = {}) {
  const directory = path.join(recoveryRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  const databasePath = path.join(directory, "agentlas.sqlite");
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  db.pragma("secure_delete = OFF");
  db.exec(`
    CREATE TABLE installed_agents (id TEXT PRIMARY KEY);
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY,
      catalog_id TEXT,
      name TEXT NOT NULL,
      name_en TEXT NOT NULL DEFAULT '',
      transport TEXT NOT NULL,
      command TEXT,
      args_json TEXT NOT NULL DEFAULT '[]',
      url TEXT,
      env_keys_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL
    );
    CREATE TABLE agent_mcp_servers (
      agent_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, server_id),
      FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
      FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
    );
    CREATE TABLE agent_tools (
      id TEXT PRIMARY KEY,
      installed_server_id TEXT,
      note TEXT,
      FOREIGN KEY(installed_server_id) REFERENCES mcp_servers(id) ON DELETE SET NULL
    );
    INSERT INTO installed_agents (id) VALUES ('agent-a');
  `);
  db.prepare(
    `INSERT INTO mcp_servers
       (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
     VALUES (?, NULL, ?, ?, 'http', NULL, '[]', ?, '[]', 1, ?)`,
  ).run("legacy-opencrab", "My preserved OpenCrab", "My preserved OpenCrab", credentialUrl, "2026-07-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO mcp_servers
       (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
     VALUES ('normal-http', NULL, 'Normal HTTP', 'Normal HTTP', 'http', NULL, '[]', ?, '[]', 1, ?)`,
  ).run("https://mcp.example.test/plain", "2026-07-02T00:00:00.000Z");
  db.prepare("INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES ('agent-a', 'legacy-opencrab')").run();
  db.prepare("INSERT INTO agent_tools (id, installed_server_id, note) VALUES ('tool-a', 'legacy-opencrab', 'preserve me')").run();
  if (options.duplicateLegacy) {
    db.prepare(
      `INSERT INTO mcp_servers
         (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
       VALUES ('legacy-opencrab-duplicate', NULL, 'Duplicate OpenCrab', 'Duplicate OpenCrab',
               'http', NULL, '[]', ?, '[]', 1, '2026-06-30T00:00:00.000Z')`,
    ).run(`${credentialUrl}/duplicate`);
    db.prepare(
      "INSERT INTO agent_mcp_servers (agent_id, server_id) VALUES ('agent-a', 'legacy-opencrab-duplicate')",
    ).run();
    db.prepare(
      "INSERT INTO agent_tools (id, installed_server_id, note) VALUES ('tool-b', 'legacy-opencrab-duplicate', 'preserve duplicate binding')",
    ).run();
  }
  if (options.logicalAlreadyScrubbed) {
    db.prepare("UPDATE mcp_servers SET url = ?, enabled = 0 WHERE id = 'legacy-opencrab'")
      .run(OPENCRAB_MCP_URL_SENTINEL);
    // Force the old URL through deleted b-tree/free pages. A simple in-place
    // UPDATE can reuse and overwrite the same cell on some SQLite builds,
    // which would not prove that VACUUM clears an already-stale credential.
    const insertStale = db.prepare(
      `INSERT INTO mcp_servers
         (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
       VALUES (?, NULL, 'stale', 'stale', 'http', NULL, '[]', ?, '[]', 0, ?)`,
    );
    const deleteStale = db.prepare("DELETE FROM mcp_servers WHERE id LIKE 'stale-secret-%'");
    db.transaction(() => {
      for (let index = 0; index < 40; index += 1) {
        insertStale.run(
          `stale-secret-${index}`,
          `${credentialUrl}/${"x".repeat(1_500)}/${index}`,
          `2026-06-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        );
      }
      deleteStale.run();
    })();
  }
  db.close();
  assert.equal(contains(databasePath, credentialUrl), true, "fixture must contain the plaintext credential before scrub");
  return { directory, databasePath, ...writeContinuitySnapshot(directory, databasePath) };
}

let exitCode = 0;
try {
  const logical = createRecovery("0.7.47-100", urlA, { duplicateLegacy: true });
  const staleFreelist = createRecovery("0.7.46-90", urlB, { logicalAlreadyScrubbed: true });
  const now = Date.now() / 1000;
  fs.utimesSync(logical.directory, now, now);
  fs.utimesSync(staleFreelist.directory, now - 10, now - 10);

  fs.mkdirSync(updaterRoot, { recursive: true });
  const journalPath = path.join(updaterRoot, "install-journal.v1.json");
  fs.writeFileSync(journalPath, JSON.stringify({
    schemaVersion: 1,
    phase: "recovery-required",
    sourceVersion: "0.7.47",
    targetVersion: "0.7.48",
    requestedAt: new Date().toISOString(),
    continuity: { backupPath: logical.databasePath },
  }));
  const activeHash = sha256(logical.databasePath);
  const staleHash = sha256(staleFreelist.databasePath);
  const activeContinuityHash = sha256(logical.continuityPath);
  const staleContinuityHash = sha256(staleFreelist.continuityPath);
  const protectedResult = scrubInactiveUpdaterRecoveryOpenCrabCredentialUrls({ userDataPath });
  assert.equal(protectedResult.skippedActive, true);
  assert.equal(protectedResult.scanned, 0);
  assert.equal(sha256(logical.databasePath), activeHash, "recovery-required backup must remain byte-for-byte untouched");
  assert.equal(sha256(staleFreelist.databasePath), staleHash, "no recovery copy is mutated before journal cleanup");
  assert.equal(
    sha256(logical.continuityPath),
    activeContinuityHash,
    "recovery-required continuity metadata must remain byte-for-byte untouched",
  );
  assert.equal(
    sha256(staleFreelist.continuityPath),
    staleContinuityHash,
    "no continuity metadata is re-sealed before journal cleanup",
  );
  assert.equal(contains(logical.databasePath, tokenA), true);
  assert.equal(contains(staleFreelist.databasePath, tokenB), true);

  // Simulate the controller's verified-success path: continuity passed and the
  // durable journal was cleared before inactive retention copies are sanitized.
  fs.rmSync(journalPath);
  const scrubbed = scrubInactiveUpdaterRecoveryOpenCrabCredentialUrls({ userDataPath });
  assert.deepEqual(scrubbed, {
    scanned: 2,
    scrubbedDatabases: 2,
    scrubbedRows: 2,
    consolidatedRows: 1,
    skippedActive: false,
    skippedUnsafe: 0,
  });

  const logicalDb = new Database(logical.databasePath, { readonly: true });
  const logicalRows = logicalDb.prepare("SELECT * FROM mcp_servers ORDER BY id").all();
  assert.equal(logicalDb.pragma("quick_check", { simple: true }), "ok");
  assert.equal(logicalRows.length, 2, "unrelated MCP rows must be preserved");
  const canonical = logicalRows.find((row) => row.id === "legacy-opencrab");
  assert.equal(canonical.catalog_id, "opencrab");
  assert.equal(canonical.url, OPENCRAB_MCP_URL_SENTINEL);
  assert.equal(canonical.enabled, 0, "legacy URL rows fail closed until Keychain reconnect");
  assert.equal(logicalRows.find((row) => row.id === "normal-http").url, "https://mcp.example.test/plain");
  assert.deepEqual(
    logicalDb.prepare("SELECT agent_id, server_id FROM agent_mcp_servers").all(),
    [{ agent_id: "agent-a", server_id: "legacy-opencrab" }],
    "agent MCP bindings must survive consolidation",
  );
  assert.deepEqual(
    logicalDb.prepare("SELECT id, installed_server_id, note FROM agent_tools ORDER BY id").all(),
    [
      { id: "tool-a", installed_server_id: "legacy-opencrab", note: "preserve me" },
      { id: "tool-b", installed_server_id: "legacy-opencrab", note: "preserve duplicate binding" },
    ],
    "agent tool ownership and user metadata must survive consolidation",
  );
  logicalDb.close();

  const staleDb = new Database(staleFreelist.databasePath, { readonly: true });
  assert.equal(staleDb.pragma("quick_check", { simple: true }), "ok");
  assert.equal(
    staleDb.prepare("SELECT url FROM mcp_servers WHERE id = 'legacy-opencrab'").get().url,
    OPENCRAB_MCP_URL_SENTINEL,
    "already-logically-scrubbed rows stay intact while freelist bytes are purged",
  );
  staleDb.close();

  for (const [databasePath, token, url] of [
    [logical.databasePath, tokenA, urlA],
    [staleFreelist.databasePath, tokenB, urlB],
  ]) {
    assert.equal(contains(databasePath, token), false, "actual recovery SQLite must not retain ocm_ bytes");
    assert.equal(contains(databasePath, url), false, "actual recovery SQLite must not retain the full private URL");
    assert.equal(fs.existsSync(`${databasePath}-wal`), false, "WAL must be truncated after scrub");
    assert.equal(fs.existsSync(`${databasePath}-shm`), false, "SHM sidecar must not survive inactive scrub");
    assert.equal(fs.existsSync(`${databasePath}-journal`), false, "rollback journal must not survive inactive scrub");
  }

  for (const recovery of [logical, staleFreelist]) {
    const resealed = JSON.parse(fs.readFileSync(recovery.continuityPath, "utf8"));
    assert.equal(resealed.sanitizationVersion, "opencrab-url-credential-v1");
    assert.ok(Number.isFinite(Date.parse(resealed.sanitizedAt)));
    const verification = verifyUpdaterRecoveryCopies({
      snapshot: resealed,
      currentUserDataPath: userDataPath,
    });
    assert.deepEqual(
      verification,
      { ok: true, violations: [] },
      "re-sealed inactive recovery metadata must exactly verify its sanitized SQLite copy",
    );
  }

  const idempotent = scrubInactiveUpdaterRecoveryOpenCrabCredentialUrls({ userDataPath });
  assert.equal(idempotent.scanned, 2);
  assert.equal(idempotent.scrubbedDatabases, 0);
  assert.equal(idempotent.scrubbedRows, 0);
  assert.equal(idempotent.skippedUnsafe, 0);

  console.log(JSON.stringify({ ok: true, protected: protectedResult, scrubbed, idempotent }, null, 2));
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  if (app) app.exit(exitCode);
  else process.exitCode = exitCode;
}
