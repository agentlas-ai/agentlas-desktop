#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { app } = require("electron");

const originalLoad = Module._load;
const deletedKeychainAccounts = [];
Module._load = function loadWithKeytarStub(request, parent, isMain) {
  if (request === "keytar") {
    return {
      getPassword: async () => null,
      setPassword: async () => undefined,
      deletePassword: async (_service, account) => {
        deletedKeychainAccounts.push(account);
        return true;
      },
      findCredentials: async () => [],
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-browser-legacy-scrub-"));
  app.setPath("userData", tmp);
  const store = require("../dist/electron/store/db.js");
  const vault = require("../dist/electron/store/browser-vault.js");
  const browser = require("../dist/electron/browser/connect.js");

  try {
    store.initStore();
    const db = store.getDb();
    const ts = new Date().toISOString();
    const legacySite = `https://${"fixture-user"}:${"fixture-pass"}@legacy.example/login`;

    await vault.upsertBrowserSite({ site: "safe.example", label: "Safe" });
    db.prepare(
      `INSERT INTO browser_sites (id, site, label, username, has_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run("legacy-site", legacySite, "Legacy", null, ts, ts);
    db.prepare(
      "INSERT INTO browser_sessions (id, site, status, captured_at) VALUES (?, ?, 'valid', ?)",
    ).run("legacy-session", legacySite, ts);
    db.prepare(
      `INSERT INTO browser_permissions (id, site, action_type, decision, created_at)
       VALUES (?, ?, 'publish', 'always', ?)`,
    ).run("legacy-permission", legacySite, ts);

    const insertLog = db.prepare(
      `INSERT INTO browser_action_logs (id, ts, site, action, target, result, approval, meta)
       VALUES (?, ?, ?, ?, ?, 'ok', NULL, NULL)`,
    );
    insertLog.run(
      "legacy-log-site",
      ts,
      `https://${"log-user"}:${"log-pass"}@logs.example/path`,
      "legacy.site",
      "https://safe.example/path",
    );
    insertLog.run(
      "legacy-log-target",
      ts,
      "safe.example",
      "legacy.target",
      `Open https://${"target-user"}:${"target-pass"}@target.example/path now`,
    );
    insertLog.run(
      "normal-log",
      ts,
      "safe.example",
      "normal",
      "https://safe.example/unchanged",
    );

    const sites = await browser.browserListSites();
    assert.deepEqual(sites.map((row) => row.site), ["safe.example"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_sites WHERE id = 'legacy-site'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_sessions WHERE id = 'legacy-session'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_permissions WHERE id = 'legacy-permission'").get().n, 0);
    assert.ok(
      deletedKeychainAccounts.includes(`secret:browser.cred:${legacySite}`),
      "the legacy raw-site Keychain locator must be cleared before its DB row is removed",
    );

    assert.deepEqual(
      db.prepare("SELECT site, target FROM browser_action_logs WHERE id = ?").get("legacy-log-site"),
      { site: "[redacted-userinfo-url]", target: "https://safe.example/path" },
      "only the credential-bearing audit site field should be redacted",
    );
    assert.deepEqual(
      db.prepare("SELECT site, target FROM browser_action_logs WHERE id = ?").get("legacy-log-target"),
      { site: "safe.example", target: "[redacted-userinfo-url]" },
      "an embedded explicit credential URL must be removed from the audit target",
    );
    assert.deepEqual(
      db.prepare("SELECT site, target FROM browser_action_logs WHERE id = ?").get("normal-log"),
      { site: "safe.example", target: "https://safe.example/unchanged" },
      "unrelated audit data must remain unchanged",
    );

    const failedLegacySite = `https://${"failed-user"}:${"failed-pass"}@failed.example`;
    db.prepare(
      `INSERT INTO browser_sites (id, site, label, username, has_password, created_at, updated_at)
       VALUES ('failed-site', ?, 'Failed fixture', NULL, 0, ?, ?)`,
    ).run(failedLegacySite, ts, ts);
    db.prepare(
      `INSERT INTO browser_permissions (id, site, action_type, decision, created_at)
       VALUES ('failed-permission', ?, 'publish', 'always', ?)`,
    ).run(failedLegacySite, ts);
    insertLog.run(
      "forced-failure-log",
      ts,
      failedLegacySite,
      "forced.failure",
      `https://${"failed-user"}:${"failed-pass"}@failed.example/post`,
    );
    db.exec(`
      CREATE TRIGGER force_legacy_scrub_failure
      BEFORE UPDATE ON browser_action_logs
      WHEN OLD.id = 'forced-failure-log'
      BEGIN
        SELECT RAISE(ABORT, 'fixture credential cleanup exploded');
      END;
    `);

    const filteredSites = await browser.browserListSites();
    assert.deepEqual(
      filteredSites.map((row) => row.site),
      ["safe.example"],
      "the read path must hide credential-bearing sites even when scrub fails",
    );
    assert.equal(
      browser.browserListPermissions().some((row) => row.site === failedLegacySite),
      false,
      "the permission read path must fail closed when cleanup rolls back",
    );
    const filteredFailureLog = browser.browserListLogs().find((row) => row.id === "forced-failure-log");
    assert.ok(filteredFailureLog, "the redacted audit record should remain visible");
    assert.deepEqual(
      { site: filteredFailureLog.site, target: filteredFailureLog.target },
      { site: "[redacted-userinfo-url]", target: "[redacted-userinfo-url]" },
      "the log read path must redact raw legacy fields even when cleanup rolls back",
    );
    const cleanupFailureLog = db.prepare(
      "SELECT result, meta FROM browser_action_logs WHERE action = 'vault.legacy_passwords_purge_failed' ORDER BY ts DESC LIMIT 1",
    ).get();
    assert.equal(cleanupFailureLog.result, "cleanup-failed");
    assert.deepEqual(JSON.parse(cleanupFailureLog.meta), {
      reasonCode: "legacy-browser-cleanup-failed",
    });
    assert.doesNotMatch(
      `${cleanupFailureLog.result} ${cleanupFailureLog.meta}`,
      /fixture credential cleanup exploded/iu,
      "raw cleanup errors must not enter durable browser logs",
    );
    db.exec("DROP TRIGGER force_legacy_scrub_failure");
    await vault.scrubLegacyBrowserCredentialRows();

    vault.logBrowserAction({
      site: `https://${"future-user"}:${"future-pass"}@future.example`,
      action: "future.redaction",
      target: `https://${"future-user"}:${"future-pass"}@target.example/path`,
    });
    assert.deepEqual(
      db.prepare("SELECT site, target FROM browser_action_logs WHERE action = 'future.redaction'").get(),
      { site: null, target: "[redacted-userinfo-url]" },
      "new audit writes must never persist URL userinfo",
    );

    const permissionCountBefore = db.prepare("SELECT COUNT(*) AS n FROM browser_permissions").get().n;
    const approval = await browser.browserRequestApproval({
      site: `https://${"approval-user"}:${"approval-pass"}@approval.example`,
      actionType: "publish",
      summary: "must fail without presenting an approval sheet",
      target: `https://${"approval-user"}:${"approval-pass"}@approval.example/post`,
    });
    assert.equal(approval, "denied", "an empty normalized site must fail closed immediately");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM browser_permissions").get().n,
      permissionCountBefore,
      "an invalid site must not create or consume a durable approval",
    );
    assert.deepEqual(
      db.prepare(
        "SELECT site, target, result, approval FROM browser_action_logs WHERE approval = 'invalid-site' ORDER BY ts DESC LIMIT 1",
      ).get(),
      {
        site: null,
        target: "[redacted-userinfo-url]",
        result: "denied",
        approval: "invalid-site",
      },
    );

    const login = await browser.browserOpenLogin(
      `https://${"login-user"}:${"login-pass"}@login.example`,
    );
    assert.deepEqual(login, {
      ok: false,
      error: "A valid HTTP(S) site address is required.",
    });

    console.log("browser legacy credential scrub and invalid-site fail-closed contract ok");
  } finally {
    Module._load = originalLoad;
    try { store.getDb().close(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
