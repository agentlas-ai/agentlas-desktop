#!/usr/bin/env node
/*
 * 브라우저 가져오기는 **누적**이다 — 값으로 단언하는 계약 (오너 신고 2026-09-14).
 *
 * 신고: "쿠키 가져오기를 하면 전체 DB에 누적돼야 하는데 가져올 때마다 초기화해서 덮어쓴다.
 *        쿠키 가져왔다가 로그인 기록 가져오면 방금 가져온 쿠키가 없어진다."
 *
 * 이 계약은 소스 문자열을 대조하지 않는다. 진짜 SQLite 저장소를 만들고 **진짜**
 * importBrowserCredentials 를 돌려서, 두 번째 가져오기 뒤에도 첫 번째 쿠키가 남아 있는지
 * 행으로 확인한다. 그리고 진짜 importBrowserProfileData(비밀번호·방문 기록)를 돌려 쿠키
 * 저장소가 한 바이트도 바뀌지 않는지 확인한다. 마지막에 옛 고장(좁은 고유키 + 원본 모양을
 * 따라가는 목적지)을 주입해 이 계약이 실제로 빨간불이 되는지까지 확인한다.
 *
 * better-sqlite3 는 Electron ABI 라 시스템 node 로 못 연다. 그래서 node 내장 node:sqlite 로
 * 같은 표면(prepare/run/all/get/exec/pragma/transaction)을 만들어 끼운다 — 저장소는 진짜다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cookie-merge-contract-"));
process.on("exit", () => { try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* scratch */ } });

// ── better-sqlite3 표면을 node:sqlite 로 ───────────────────────────────────────
function flatten(args) {
  const list = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  return list.map((value) => {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  });
}
class SqliteShim {
  constructor(file, options = {}) {
    this.db = new DatabaseSync(file, { readOnly: options.readonly === true });
  }
  pragma(text, options = {}) {
    const body = String(text).trim();
    if (/table_info/i.test(body)) return this.db.prepare(`PRAGMA ${body}`).all();
    if (options.simple) {
      const row = this.db.prepare(`PRAGMA ${body}`).get();
      return row ? Object.values(row)[0] : null;
    }
    this.db.exec(`PRAGMA ${body}`);
    return [];
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      get: (...args) => statement.get(...flatten(args)),
      all: (...args) => statement.all(...flatten(args)),
      run: (...args) => {
        const result = statement.run(...flatten(args));
        return { changes: Number(result.changes) };
      },
    };
  }
  transaction(fn) {
    return (...args) => {
      this.db.exec("BEGIN");
      try {
        const value = fn(...args);
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw error;
      }
    };
  }
  close() { this.db.close(); }
}

// ── TS 소스를 그 자리에서 불러오는 로더(스텁 주입 가능) ─────────────────────────
function makeLoader(stubs) {
  const cache = new Map();
  function loadTs(rel) {
    const file = path.join(root, rel);
    if (cache.has(file)) return cache.get(file);
    const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: file,
    }).outputText;
    const loaded = new Module(file, module);
    loaded.filename = file;
    loaded.paths = Module._nodeModulePaths(path.dirname(file));
    cache.set(file, loaded.exports);
    const originalRequire = loaded.require.bind(loaded);
    loaded.require = (request) => {
      if (stubs[request]) return stubs[request];
      if (request === "better-sqlite3") return SqliteShim;
      if (request.startsWith(".")) {
        const target = path.relative(root, path.join(path.dirname(file), request));
        if (stubs[target]) return stubs[target];
        const candidate = fs.existsSync(path.join(root, `${target}.ts`)) ? `${target}.ts` : `${target}.tsx`;
        return loadTs(candidate);
      }
      return originalRequire(request);
    };
    loaded._compile(output, file);
    cache.set(file, loaded.exports);
    return loaded.exports;
  }
  return loadTs;
}

// ── 1) 순수 판정을 값으로 단언한다 ────────────────────────────────────────────
const merge = makeLoader({})("electron/browser/cookie-merge.ts");

assert.equal(merge.decideCookieWrite({
  hasExisting: false, destinationReadable: true, hasFreshnessColumns: true, incomingFreshness: 1, existingFreshness: 0,
}), "insert", "목적지에 없는 쿠키는 넣는다");
assert.equal(merge.decideCookieWrite({
  hasExisting: true, destinationReadable: true, hasFreshnessColumns: true, incomingFreshness: 5, existingFreshness: 9,
}), "keep", "더 낡은 원본은 이미 있는 줄을 덮지 않는다");
assert.equal(merge.decideCookieWrite({
  hasExisting: true, destinationReadable: true, hasFreshnessColumns: true, incomingFreshness: 9, existingFreshness: 5,
}), "replace", "더 새 원본은 갱신한다");
assert.equal(merge.decideCookieWrite({
  hasExisting: true, destinationReadable: false, hasFreshnessColumns: true, incomingFreshness: 1, existingFreshness: 9,
}), "replace", "전용 런타임이 못 읽는 암호문은 반드시 교체한다");
assert.equal(merge.decideCookieWrite({
  hasExisting: true, destinationReadable: true, hasFreshnessColumns: false, incomingFreshness: 9, existingFreshness: 0,
}), "keep", "신선도 칸이 없는 저장소 형식은 건드리지 않는다");

assert.deepEqual(
  merge.cookieIdentityColumns(["host_key", "name", "path", "value", "top_frame_site_key", "source_port"]),
  ["host_key", "top_frame_site_key", "name", "path", "source_port"],
  "고유키는 저장소의 UNIQUE 조합이어야 한다 — (host, name, path) 만으로 지우면 형제 줄이 죽는다",
);

assert.equal(merge.resolveCookieStoreLayout({ legacyRows: 12, networkRows: null, sourceUsesNetworkDir: true }), "legacy",
  "이미 쿠키가 쌓인 목적지 파일이 있으면 원본 모양과 달라도 거기에 누적한다");
assert.equal(merge.resolveCookieStoreLayout({ legacyRows: null, networkRows: null, sourceUsesNetworkDir: true }), "network",
  "목적지가 완전히 비었을 때만 원본 모양을 따른다");

assert.equal(merge.decideNativeCookieWrite({ hasExisting: true, explicitImport: false }), "preserve",
  "주기 갱신은 살아 있는 One/Work 세션을 덮지 않는다");
assert.equal(merge.decideNativeCookieWrite({ hasExisting: true, explicitImport: true }), "write",
  "사용자가 방금 가져오기를 눌렀으면 가져온 값이 이긴다");

// ── 2) 진짜 저장소 시나리오 ───────────────────────────────────────────────────
const COOKIE_DDL = `CREATE TABLE cookies(
  creation_utc INTEGER NOT NULL,
  host_key TEXT NOT NULL,
  top_frame_site_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  encrypted_value BLOB NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  expires_utc INTEGER NOT NULL,
  is_secure INTEGER NOT NULL,
  is_httponly INTEGER NOT NULL,
  last_access_utc INTEGER NOT NULL,
  has_expires INTEGER NOT NULL DEFAULT 1,
  is_persistent INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  samesite INTEGER NOT NULL DEFAULT -1,
  source_scheme INTEGER NOT NULL DEFAULT 0,
  source_port INTEGER NOT NULL DEFAULT -1,
  last_update_utc INTEGER NOT NULL DEFAULT 0,
  source_type INTEGER NOT NULL DEFAULT 0,
  has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0,
  UNIQUE (host_key, top_frame_site_key, name, path, source_scheme, source_port)
)`;

function writeSourceProfile(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "Cookies");
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(COOKIE_DDL);
  db.exec("CREATE TABLE meta(key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta(key, value) VALUES ('version', '24')").run();
  const insert = db.prepare(`INSERT INTO cookies
    (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc,
     is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite,
     source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    insert.run(
      row.creation ?? 1, row.host, row.partition ?? "", row.name, row.value ?? "", Buffer.from(`v10-${row.name}`),
      row.path ?? "/", row.expires ?? 4000, 1, 1, 1, 1, 1, 1, -1,
      row.scheme ?? 2, row.port ?? 443, row.updated ?? 1000, 0, 0,
    );
  }
  db.close();
}

function readCookies(file) {
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare(
    "SELECT host_key, top_frame_site_key, name, path, source_port, last_update_utc FROM cookies ORDER BY host_key, name, source_port",
  ).all();
  db.close();
  return rows.map((row) => ({ ...row }));
}

function scenarioStubs(paths, faulty) {
  const sites = new Map();
  const sessions = new Map();
  const stubs = {
    playwright: { chromium: { connectOverCDP: async () => { throw new Error("not used on this platform"); } } },
    "electron/mcp-tools/browser-cdp-launcher": {
      browserCdpPort: () => 9222,
      browserCdpPortReady: async () => false,
      browserCdpProfilePath: () => paths.dedicated,
      clearBrowserCdpOwner: () => {},
      ensureBrowserCdpProfilePrivate: () => { fs.mkdirSync(paths.dedicated, { recursive: true }); return paths.dedicated; },
      inspectBrowserCdpOwnership: async () => ({ state: "absent", pid: null, reason: "test" }),
      resetBrowserCdpSessionRestoreArtifacts: () => ({ sessionArtifactsRemoved: 0, preferencesUpdated: false }),
      withBrowserCdpMaintenance: async (work) => work({ rootsClosed: 0, leasesCancelled: 0, staleLocksRemoved: 0 }),
      writeBrowserCdpOwner: () => {},
    },
    "electron/store/browser-vault": {
      normalizeSite: (site) => String(site).replace(/^https?:\/\//u, "").replace(/\/$/u, "").toLowerCase(),
      listBrowserSites: () => [...sites.values()].map((site) => ({ site, session: { status: sessions.get(site) ?? "none" } })),
      upsertBrowserSite: async (input) => { sites.set(input.site, input.site); return input; },
      setBrowserSession: (site, status) => { sessions.set(site, status); },
    },
    "electron/browser/runtime": { resolveAgentlasBrowserRuntime: () => ({ executable: "/nonexistent/chrome", manifest: {} }) },
    "electron/ui-locale": { currentUiLocale: () => "ko" },
    "electron/development-effect-policy": {
      developmentEffectsSuppressed: () => false,
      assertDevelopmentEffectAllowed: () => {},
    },
  };
  if (faulty === "identity") {
    // 옛 고장 ①: 고유키가 (host_key, name, path) 뿐이라 형제 줄까지 지운다.
    stubs["electron/browser/cookie-merge"] = {
      ...merge,
      cookieIdentityColumns: (shared) => ["host_key", "name", "path"].filter((c) => shared.includes(c)),
    };
  }
  if (faulty === "layout") {
    // 옛 고장 ②: 목적지 파일을 **원본 모양**으로 정해 전용 프로필 안에서 저장소가 갈린다.
    stubs["electron/browser/cookie-merge"] = {
      ...merge,
      resolveCookieStoreLayout: (input) => (input.sourceUsesNetworkDir ? "network" : "legacy"),
    };
  }
  return { stubs, sites, sessions };
}

async function runScenario({ faulty = null } = {}) {
  const base = fs.mkdtempSync(path.join(workRoot, faulty ? `faulty-${faulty}-` : "fixed-"));
  const paths = {
    modernSource: path.join(base, "config", "google-chrome", "Default", "Network"),
    legacySource: path.join(base, "config", "chromium", "Default"),
    dedicated: path.join(base, "dedicated"),
  };
  process.env.XDG_CONFIG_HOME = path.join(base, "config");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    // 신형 배치(Network/) 원본에 a.example 쿠키, 구형 배치 원본에 b.example 쿠키.
    writeSourceProfile(paths.modernSource, [
      { host: ".a.example", name: "session_a", updated: 1000 },
      { host: ".a.example", name: "csrf_a", updated: 1000 },
    ]);
    writeSourceProfile(paths.legacySource, [{ host: ".b.example", name: "session_b", updated: 1000 }]);
    for (const dir of [path.join(base, "config", "google-chrome"), path.join(base, "config", "chromium")]) {
      fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: "dGVzdC1rZXk=" } }));
    }

    const { stubs } = scenarioStubs(paths, faulty);
    const load = makeLoader(stubs);
    const importer = load("electron/browser/credential-import.ts");
    const profileImporter = load("electron/browser/profile-import.ts");

    // (1) 쿠키 가져오기 — a.example
    const first = await importer.importBrowserCredentials("Google Chrome::Default", ["a.example"]);
    assert.equal(first.ok, true, `첫 가져오기는 성공해야 한다: ${first.error ?? ""}`);
    const storeOf = () => {
      const legacy = readCookies(path.join(paths.dedicated, "Default", "Cookies"));
      const network = readCookies(path.join(paths.dedicated, "Default", "Network", "Cookies"));
      return { legacy, network, all: [...legacy, ...network] };
    };
    assert.equal(storeOf().all.filter((row) => row.host_key === ".a.example").length, 2,
      "가져온 쿠키 2줄이 전용 프로필에 있어야 한다");

    // (2) ★오너의 재현 순서 — 쿠키를 가져온 **직후** 로그인 기록(방문 기록)을 가져온다.
    //     다른 종류의 가져오기는 쿠키 저장소를 단 한 줄도 건드리면 안 된다.
    const beforeProfileImport = storeOf().all;
    const persisted = { history: [] };
    fs.writeFileSync(path.join(path.dirname(paths.modernSource), "History"), "");
    const historyDb = path.join(base, "History.source");
    const seedHistory = new DatabaseSync(historyDb);
    seedHistory.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER)");
    seedHistory.prepare("INSERT INTO urls(url, title, visit_count, last_visit_time) VALUES (?,?,?,?)")
      // Chrome 의 마이크로초 시각은 2^53 을 넘어 node:sqlite 가 숫자로 못 읽는다(계약 전용 축약값).
      // node:sqlite 는 2^53 을 넘는 정수를 숫자로 못 읽는다. 진짜 Chrome 시각(약 1.3e16) 대신
      // 축약값을 쓴다 — 이 계약이 보는 것은 시각이 아니라 저장소 경계다.
      .run("https://a.example/dashboard", "A dashboard", 4, 4000000000);
    seedHistory.close();
    const profileDeps = {
      platform: "linux",
      resolveProfile: () => ({ browser: "Google Chrome", path: path.dirname(paths.modernSource) }),
      makeWorkDir: () => fs.mkdtempSync(path.join(base, "profile-import-")),
      removeWorkDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
      snapshotSqlite: (_src, _workDir, basename) => (basename.startsWith("History") ? historyDb : null),
      createDecryptBoundary: () => ({ decrypt: () => ({ ok: false, reason: "decrypt-unavailable" }), dispose() {} }),
      persistCredentials: async () => ({ ok: true, imported: 0, updated: 0 }),
      persistHistory: (_scope, _profile, entries) => { persisted.history.push(...entries); return { ok: true, imported: entries.length }; },
    };
    const scan = profileImporter.scanBrowserProfileData({ profileId: "Google Chrome::Default" }, profileDeps);
    assert.equal(scan.history.length, 1, "방문 기록 한 줄을 읽어야 다음 단계가 의미가 있다");
    const data = await profileImporter.importBrowserProfileData(
      {
        profileId: "Google Chrome::Default",
        passwordIds: [],
        historyIds: [scan.history[0].id],
        taskScopeId: "task:cookie-merge-contract",
        userConfirmed: true,
      },
      profileDeps,
    );
    assert.equal(data.ok, true, `로그인 기록 가져오기는 성공해야 한다: ${data.reason ?? ""}`);
    assert.equal(persisted.history.length, 1, "방문 기록은 자기 저장소로 들어가야 한다");
    assert.deepEqual(storeOf().all, beforeProfileImport,
      "★로그인 기록 가져오기가 방금 가져온 쿠키를 지우면 안 된다(종류별 저장소 경계)");

    // (3) 두 번째 쿠키 가져오기 — 다른 브라우저(구형 배치), 다른 사이트.
    const second = await importer.importBrowserCredentials("Chromium::Default", ["b.example"]);
    assert.equal(second.ok, true, `두 번째 가져오기는 성공해야 한다: ${second.error ?? ""}`);
    const after = storeOf();
    const hosts = after.all.map((row) => row.host_key);
    assert.ok(hosts.includes(".b.example"), "두 번째로 가져온 쿠키가 있어야 한다");
    assert.equal(after.all.filter((row) => row.host_key === ".a.example").length, 2,
      "★첫 번째로 가져온 쿠키는 두 번째 가져오기 뒤에도 그대로 남아야 한다(누적)");
    assert.ok(after.legacy.length === 0 || after.network.length === 0,
      "★전용 프로필 안에서 쿠키가 두 파일로 갈라지면 전용 브라우저가 한쪽만 읽는다");

    // (4) 같은 쿠키를 다시 가져오면 한 줄이어야 한다(멱등).
    const again = await importer.importBrowserCredentials("Google Chrome::Default", ["a.example"]);
    assert.equal(again.ok, true, "재가져오기는 성공해야 한다");
    assert.equal(storeOf().all.filter((row) => row.host_key === ".a.example").length, 2,
      "같은 쿠키를 두 번 가져와도 줄이 늘지 않는다");
    assert.equal(again.cookiesAdded, 0, "이미 누적된 쿠키를 '새로 추가'라고 세면 안 된다");
    assert.equal(again.cookiesPreserved, 2, "이미 있던 줄은 유지로 정직하게 센다");

    // (5) 형제 줄 보존 — 같은 (host, name, path) 인데 포트가 다른 줄은 서로를 지우면 안 된다.
    writeSourceProfile(paths.modernSource, [
      { host: ".a.example", name: "session_a", updated: 5000, port: 443 },
      { host: ".a.example", name: "csrf_a", updated: 1000 },
    ]);
    const target = path.join(paths.dedicated, "Default", after.network.length > 0 ? path.join("Network", "Cookies") : "Cookies");
    const sibling = new DatabaseSync(target);
    sibling.prepare(`INSERT INTO cookies
      (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc,
       is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite,
       source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor)
      VALUES (9,'.a.example','','session_a','',x'763130',  '/',4000,1,1,1,1,1,1,-1,2,8443,1000,0,0)`).run();
    sibling.close();
    const refreshed = await importer.importBrowserCredentials("Google Chrome::Default", ["a.example"]);
    assert.equal(refreshed.ok, true, "갱신 가져오기는 성공해야 한다");
    assert.equal(refreshed.cookiesUpdated, 1, "더 새로운 줄 하나만 갱신해야 한다");
    assert.equal(storeOf().all.filter((row) => row.host_key === ".a.example" && row.source_port === 8443).length, 1,
      "★포트만 다른 형제 쿠키는 갱신 때 지워지면 안 된다");
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }
}

(async () => {
  await runScenario();

  // ── 3) 옛 고장 주입 — 이 계약이 실제로 빨간불이 되는지 확인한다 ──────────────
  const caught = [];
  for (const faulty of ["identity", "layout"]) {
    let failure = null;
    try {
      await runScenario({ faulty });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `옛 고장(${faulty})을 주입하면 이 계약은 반드시 실패해야 한다`);
    assert.match(String(failure.message), /★/,
      `주입한 고장(${faulty})은 누적 단언에서 잡혀야 한다: ${failure.message}`);
    caught.push(`${faulty}: ${String(failure.message).split("\n")[0]}`);
  }

  console.log("PASS browser cookie import accumulates (merge/upsert) contract");
  for (const line of caught) console.log(`  fault injection caught — ${line}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
