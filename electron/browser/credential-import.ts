// 평소 쓰는 Chrome 계열 브라우저의 로그인 세션을 Agentlas 전용 CDP 프로필로 가져온다.
//
// 왜: 전용 프로필은 빈 상태로 태어나므로 사용자가 Connect에서 사이트를 하나씩 손으로 적고
// 전용 창에서 다시 로그인해야 했다. 평소 브라우저에는 이미 그 로그인이 다 있다.
//
// 경계 (이 파일이 지키는 것):
//  1) **값을 복호화하지 않는다.** 쿠키는 암호화된 바이트 그대로 옮긴다. 복호화 키는 OS 저장소
//     (macOS Keychain / Windows DPAPI)에 있고 우리는 꺼내지 않는다.
//  2) **비밀번호와 결제수단은 만지지 않는다.** `Login Data`·`Web Data`는 읽지도 복사하지도 않는다.
//     (Agentlas-OS 레일의 seedProfile 은 이 둘까지 복사한다 — 여기서는 하지 않는다.)
//  3) **원본 DB에 연결하지 않는다.** 실행 중인 브라우저가 mmap 한 SQLite에 외부 연결을 붙이면
//     그 브라우저가 SIGBUS 로 죽을 수 있다(2026-08-19 Agentlas 앱에서 2회 실측). 그래서
//     파일을 먼저 복사하고 **사본만** 연다. 사본은 무결성 검사를 통과해야 쓰인다 — 깨졌으면
//     빈 결과로 조용히 진행하지 않고 실패를 말한다.
//  4) **덮어쓰지 않는다(merge).** 전용 프로필에 이미 있는 쿠키 행은 건드리지 않고, 없는 것만 넣는다.
//     에이전트가 전용 창에서 새로 만든 세션을 평소 브라우저 상태가 지우면 안 된다.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  BrowserCredentialImportResult,
  BrowserCredentialScanResult,
  DiscoveredBrowserProfile,
  DiscoveredCredentialDomain,
} from "../../shared/browser-credentials";
import {
  browserCdpOwnerIsLive,
  browserCdpProfilePath,
  ensureBrowserCdpProfilePrivate,
} from "../mcp-tools/browser-cdp-launcher";
import { listBrowserSites, normalizeSite, upsertBrowserSite } from "../store/browser-vault";

interface BrowserFamilyRoot {
  browser: string;
  userDataDir: string;
}

/** Chrome 계열 user-data 디렉터리 후보 — 플랫폼별 표준 위치. */
function browserFamilyRoots(): BrowserFamilyRoot[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return [
      { browser: "Google Chrome", userDataDir: path.join(base, "Google", "Chrome") },
      { browser: "Microsoft Edge", userDataDir: path.join(base, "Microsoft Edge") },
      { browser: "Brave", userDataDir: path.join(base, "BraveSoftware", "Brave-Browser") },
      { browser: "Chromium", userDataDir: path.join(base, "Chromium") },
    ];
  }
  if (process.platform === "win32") {
    // Chrome 계열은 전부 LOCALAPPDATA 밑 "<vendor>/<product>/User Data".
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      { browser: "Google Chrome", userDataDir: path.join(local, "Google", "Chrome", "User Data") },
      { browser: "Microsoft Edge", userDataDir: path.join(local, "Microsoft", "Edge", "User Data") },
      { browser: "Brave", userDataDir: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
      { browser: "Chromium", userDataDir: path.join(local, "Chromium", "User Data") },
    ];
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    { browser: "Google Chrome", userDataDir: path.join(config, "google-chrome") },
    { browser: "Microsoft Edge", userDataDir: path.join(config, "microsoft-edge") },
    { browser: "Brave", userDataDir: path.join(config, "BraveSoftware", "Brave-Browser") },
    { browser: "Chromium", userDataDir: path.join(config, "chromium") },
  ];
}

/** 프로필 디렉터리 안에서 쿠키 저장소의 실경로. 신형 Chrome 은 Network/ 밑으로 옮겼다. */
function cookieStorePath(profileDir: string): string | null {
  const modern = path.join(profileDir, "Network", "Cookies");
  if (fs.existsSync(modern)) return modern;
  const legacy = path.join(profileDir, "Cookies");
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

function readLocalStateNames(userDataDir: string): Record<string, { name?: string; user_name?: string }> {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, "Local State"), "utf8");
    const parsed = JSON.parse(raw) as {
      profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> };
    };
    return parsed.profile?.info_cache ?? {};
  } catch {
    return {};
  }
}

function profileIdOf(browser: string, profileKey: string): string {
  return `${browser}::${profileKey}`;
}

/** 사용자의 평소 브라우저 프로필 전수. 쿠키 저장소가 없는 프로필은 readable=false 로 남긴다. */
export function listDiscoverableProfiles(): DiscoveredBrowserProfile[] {
  const out: DiscoveredBrowserProfile[] = [];
  for (const root of browserFamilyRoots()) {
    if (!fs.existsSync(root.userDataDir)) continue;
    const names = readLocalStateNames(root.userDataDir);
    let entries: string[];
    try {
      entries = fs.readdirSync(root.userDataDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry !== "Default" && !/^Profile \d+$/.test(entry)) continue;
      const profileDir = path.join(root.userDataDir, entry);
      if (!fs.statSync(profileDir, { throwIfNoEntry: false })?.isDirectory()) continue;
      const info = names[entry] ?? {};
      const store = cookieStorePath(profileDir);
      out.push({
        id: profileIdOf(root.browser, entry),
        browser: root.browser,
        profileKey: entry,
        displayName: info.name?.trim() || entry,
        accountEmail: info.user_name?.trim() || null,
        path: profileDir,
        readable: Boolean(store),
        ...(store ? {} : { reason: "이 프로필에는 쿠키 저장소가 없습니다(한 번도 안 쓴 프로필)." }),
      });
    }
  }
  return out;
}

function findProfile(profileId: string): DiscoveredBrowserProfile | null {
  return listDiscoverableProfiles().find((p) => p.id === profileId) ?? null;
}

/**
 * 실행 중인 브라우저의 SQLite 를 **열지 않고** 스냅샷한다.
 * 본체 + -wal + -shm 을 함께 복사한 뒤 사본을 열어 WAL 을 재생시키고 무결성을 확인한다.
 * 무결성이 깨지면 null — 호출자는 조용한 빈 결과 대신 실패로 다뤄야 한다.
 */
function snapshotSqlite(src: string, workDir: string, basename: string): string | null {
  const dst = path.join(workDir, basename);
  try {
    fs.copyFileSync(src, dst);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${src}${suffix}`;
      if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${dst}${suffix}`);
    }
  } catch {
    return null;
  }
  try {
    // 읽기전용으로 열면 WAL 을 본체에 흡수하지 못해 최근 로그인이 빠진다. 사본이므로 쓰기로 연다.
    const db = new Database(dst);
    const check = db.pragma("integrity_check", { simple: true }) as unknown as string;
    db.close();
    if (String(check) !== "ok") return null;
    return dst;
  } catch {
    return null;
  }
}

function makeWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-credimport-"));
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 비 POSIX 파일시스템에서는 최선만 */
  }
  return dir;
}

function removeWorkDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 임시 디렉터리 정리 실패가 결과를 뒤집지는 않는다 */
  }
}

/** host_key(".x.com") → 등록 도메인("x.com"). */
function normalizeHostKey(hostKey: string): string {
  return hostKey.replace(/^\./, "").trim().toLowerCase();
}

/** 방문 기록에서 도메인별 대표 제목을 뽑는다. 없으면 그 도메인은 제목 없이 남는다(지어내지 않음). */
function readDomainTitles(profileDir: string, workDir: string, wanted: Set<string>): Map<string, string> {
  const titles = new Map<string, string>();
  const historySrc = path.join(profileDir, "History");
  if (!fs.existsSync(historySrc)) return titles;
  const snap = snapshotSqlite(historySrc, workDir, "History.snapshot");
  if (!snap) return titles;
  try {
    const db = new Database(snap, { readonly: true });
    const rows = db
      .prepare(
        `SELECT url, title, visit_count FROM urls
         WHERE title IS NOT NULL AND title <> '' AND visit_count > 0
         ORDER BY visit_count DESC LIMIT 20000`,
      )
      .all() as Array<{ url: string; title: string; visit_count: number }>;
    db.close();
    for (const row of rows) {
      let host: string;
      try {
        host = new URL(row.url).hostname.toLowerCase();
      } catch {
        continue;
      }
      // 서브도메인 방문도 등록 도메인 후보에 붙인다(mail.google.com → google.com 목록의 제목).
      for (const domain of wanted) {
        if (host !== domain && !host.endsWith(`.${domain}`)) continue;
        if (!titles.has(domain)) titles.set(domain, row.title.trim().slice(0, 80));
        break;
      }
    }
  } catch {
    /* 제목은 편의 정보다 — 못 읽어도 도메인 목록은 나가야 한다 */
  }
  return titles;
}

export function scanBrowserCredentials(profileId?: string | null): BrowserCredentialScanResult {
  const profiles = listDiscoverableProfiles();
  if (!profileId) return { ok: true, profiles, domains: [], profileId: null };

  const profile = profiles.find((p) => p.id === profileId);
  if (!profile) {
    return { ok: false, profiles, domains: [], profileId, error: "그 브라우저 프로필을 찾지 못했습니다." };
  }
  const store = cookieStorePath(profile.path);
  if (!store) {
    return { ok: false, profiles, domains: [], profileId, error: "이 프로필에는 쿠키 저장소가 없습니다." };
  }

  const workDir = makeWorkDir();
  try {
    const snap = snapshotSqlite(store, workDir, "Cookies.snapshot");
    if (!snap) {
      return {
        ok: false,
        profiles,
        domains: [],
        profileId,
        error: "쿠키 저장소 사본이 무결성 검사를 통과하지 못했습니다. 브라우저를 닫고 다시 시도해 주세요.",
      };
    }
    const db = new Database(snap, { readonly: true });
    const rows = db
      .prepare(
        `SELECT host_key, COUNT(*) AS n,
                SUM(CASE WHEN has_expires = 1 THEN 1 ELSE 0 END) AS persistent
         FROM cookies GROUP BY host_key`,
      )
      .all() as Array<{ host_key: string; n: number; persistent: number }>;
    db.close();

    const byDomain = new Map<string, { count: number; persistent: number }>();
    for (const row of rows) {
      const domain = normalizeHostKey(row.host_key);
      if (!domain || !domain.includes(".")) continue;
      const prev = byDomain.get(domain) ?? { count: 0, persistent: 0 };
      byDomain.set(domain, {
        count: prev.count + Number(row.n || 0),
        persistent: prev.persistent + Number(row.persistent || 0),
      });
    }

    const titles = readDomainTitles(profile.path, workDir, new Set(byDomain.keys()));
    const linked = new Set(
      listBrowserSites()
        .map((s) => {
          try {
            return new URL(s.site).hostname.replace(/^www\./, "").toLowerCase();
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    );

    const domains: DiscoveredCredentialDomain[] = [...byDomain.entries()]
      .map(([domain, agg]) => ({
        domain,
        title: titles.get(domain) ?? null,
        cookieCount: agg.count,
        hasPersistentCookie: agg.persistent > 0,
        alreadyLinked: linked.has(domain),
      }))
      // 세션이 살아 있을 법한 것(만료 있는 쿠키 보유)을 위로, 그다음 쿠키 많은 순.
      .sort((a, b) => {
        if (a.hasPersistentCookie !== b.hasPersistentCookie) return a.hasPersistentCookie ? -1 : 1;
        if (b.cookieCount !== a.cookieCount) return b.cookieCount - a.cookieCount;
        return a.domain.localeCompare(b.domain);
      });

    return { ok: true, profiles, domains, profileId };
  } finally {
    removeWorkDir(workDir);
  }
}

/** 전용 프로필의 쿠키 저장소 경로 — 원본이 신형(Network/)이면 목적지도 신형으로 맞춘다. */
function destinationCookieStore(sourceStore: string): string {
  const dedicated = ensureBrowserCdpProfilePrivate();
  const useNetworkDir = path.basename(path.dirname(sourceStore)) === "Network";
  const dir = useNetworkDir
    ? path.join(dedicated, "Default", "Network")
    : path.join(dedicated, "Default");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "Cookies");
}

/**
 * Windows·Linux 는 쿠키 복호화 키가 `Local State` 안에 (OS 로 한 번 더 감싸져) 들어 있다.
 * 전용 프로필이 아직 자기 쿠키를 갖기 전이라면 그 키를 그대로 물려받아야 옮긴 쿠키가 읽힌다.
 * macOS 는 키가 Keychain 의 앱 단위 항목이라 경로가 달라도 같은 키가 쓰인다 — 손대지 않는다.
 */
function inheritEncryptionKeyIfNeeded(
  sourceProfileDir: string,
  destHadCookies: boolean,
): { ok: boolean; reason?: string } {
  if (process.platform === "darwin") return { ok: true };
  const sourceUserData = path.dirname(sourceProfileDir);
  const srcLocalState = path.join(sourceUserData, "Local State");
  if (!fs.existsSync(srcLocalState)) {
    return { ok: false, reason: "원본 브라우저의 Local State 를 찾지 못해 복호화 키를 물려받을 수 없습니다." };
  }
  const dedicated = ensureBrowserCdpProfilePrivate();
  const dstLocalState = path.join(dedicated, "Local State");

  let srcKey: string | undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(srcLocalState, "utf8")) as {
      os_crypt?: { encrypted_key?: string; app_bound_encrypted_key?: string };
    };
    srcKey = parsed.os_crypt?.encrypted_key;
  } catch {
    return { ok: false, reason: "원본 Local State 를 읽지 못했습니다." };
  }
  if (!srcKey) return { ok: false, reason: "원본 브라우저에 복호화 키 항목이 없습니다." };

  let dst: Record<string, unknown> = {};
  if (fs.existsSync(dstLocalState)) {
    try {
      dst = JSON.parse(fs.readFileSync(dstLocalState, "utf8")) as Record<string, unknown>;
    } catch {
      dst = {};
    }
  }
  const dstCrypt = (dst.os_crypt ?? {}) as { encrypted_key?: string };
  if (dstCrypt.encrypted_key && dstCrypt.encrypted_key !== srcKey) {
    // 키가 다른데 이미 전용 프로필에 쿠키가 있으면, 키를 바꾸는 순간 기존 쿠키가 못 읽힌다.
    if (destHadCookies) {
      return {
        ok: false,
        reason:
          "전용 프로필이 이미 다른 복호화 키로 만든 쿠키를 갖고 있습니다. 기존 세션을 잃지 않으려면 가져오기를 건너뜁니다.",
      };
    }
  }
  dst.os_crypt = { ...dstCrypt, encrypted_key: srcKey };
  try {
    fs.writeFileSync(dstLocalState, JSON.stringify(dst), { mode: 0o600 });
  } catch {
    return { ok: false, reason: "전용 프로필의 Local State 에 쓰지 못했습니다." };
  }
  return { ok: true };
}

const COOKIE_TABLE_DDL = `CREATE TABLE cookies(
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

export async function importBrowserCredentials(
  profileId: string,
  domains: string[],
): Promise<BrowserCredentialImportResult> {
  const skipped: Array<{ domain: string; reason: string }> = [];
  const wanted = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (wanted.length === 0) {
    return { ok: false, cookiesAdded: 0, linkedSites: [], skipped, error: "가져올 도메인을 하나 이상 골라 주세요." };
  }
  const profile = findProfile(profileId);
  if (!profile) {
    return { ok: false, cookiesAdded: 0, linkedSites: [], skipped, error: "그 브라우저 프로필을 찾지 못했습니다." };
  }
  const sourceStore = cookieStorePath(profile.path);
  if (!sourceStore) {
    return { ok: false, cookiesAdded: 0, linkedSites: [], skipped, error: "이 프로필에는 쿠키 저장소가 없습니다." };
  }

  const workDir = makeWorkDir();
  try {
    const snap = snapshotSqlite(sourceStore, workDir, "Cookies.snapshot");
    if (!snap) {
      return {
        ok: false,
        cookiesAdded: 0,
        linkedSites: [],
        skipped,
        error: "쿠키 저장소 사본이 무결성 검사를 통과하지 못했습니다. 브라우저를 닫고 다시 시도해 주세요.",
      };
    }

    // 전용 Chrome 이 떠 있으면 그 프로세스가 이 쿠키 DB 를 mmap 하고 있다. 거기에 밖에서 쓰면
    // (a) 그 Chrome 이 SIGBUS 로 죽을 수 있고 (b) 살아남더라도 자기 메모리 상태로 우리 행을
    // 덮어써 "가져왔는데 로그인이 안 됨"이 된다. 조용히 실패하느니 이유를 말하고 멈춘다.
    if (await browserCdpOwnerIsLive()) {
      return {
        ok: false,
        cookiesAdded: 0,
        linkedSites: [],
        skipped,
        error: "Agentlas 전용 브라우저 창이 열려 있습니다. 그 창을 닫고 다시 가져오기를 눌러 주세요.",
      };
    }

    const destPath = destinationCookieStore(sourceStore);
    const destExisted = fs.existsSync(destPath);
    let destHadCookies = false;
    if (destExisted) {
      try {
        const probe = new Database(destPath, { readonly: true });
        const row = probe.prepare("SELECT COUNT(*) AS n FROM cookies").get() as { n: number };
        probe.close();
        destHadCookies = Number(row?.n || 0) > 0;
      } catch {
        destHadCookies = false;
      }
    }

    const keyResult = inheritEncryptionKeyIfNeeded(profile.path, destHadCookies);
    if (!keyResult.ok) {
      return {
        ok: false,
        cookiesAdded: 0,
        linkedSites: [],
        skipped,
        error: keyResult.reason ?? "복호화 키를 준비하지 못했습니다.",
      };
    }

    const dest = new Database(destPath);
    dest.pragma("journal_mode = WAL");
    // 목적지가 비어 있으면(첫 가져오기) 원본과 같은 모양의 테이블을 만든다. 이미 있으면 그대로 쓴다.
    const hasTable = dest
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cookies'")
      .get() as { name?: string } | undefined;
    if (!hasTable?.name) dest.exec(COOKIE_TABLE_DDL);

    const destColumns = new Set(
      (dest.pragma("table_info(cookies)") as Array<{ name: string }>).map((c) => c.name),
    );

    const src = new Database(snap, { readonly: true });
    const srcColumns = (src.pragma("table_info(cookies)") as Array<{ name: string }>).map((c) => c.name);
    // 두 스키마의 **교집합만** 옮긴다. 크롬 버전이 다르면 칸이 달라지는데, 없는 칸을 넣으려 하면
    // 통째로 실패한다. 교집합이면 기본값이 있는 새 칸은 목적지 기본값으로 채워진다.
    const shared = srcColumns.filter((c) => destColumns.has(c));
    if (!shared.includes("host_key") || !shared.includes("name")) {
      src.close();
      dest.close();
      return {
        ok: false,
        cookiesAdded: 0,
        linkedSites: [],
        skipped,
        error: "쿠키 저장소 형식이 예상과 달라 안전하게 옮길 수 없습니다.",
      };
    }

    const quoted = shared.map((c) => `"${c}"`).join(", ");
    const placeholders = shared.map(() => "?").join(", ");
    // merge: 이미 있는 (host_key, name, path) 는 건드리지 않는다.
    const insert = dest.prepare(`INSERT OR IGNORE INTO cookies (${quoted}) VALUES (${placeholders})`);
    const existsStmt = dest.prepare(
      "SELECT 1 AS found FROM cookies WHERE host_key = ? AND name = ? AND path = ? LIMIT 1",
    );

    let added = 0;
    const linkedSites: string[] = [];
    const selectRows = src.prepare(
      `SELECT ${quoted} FROM cookies WHERE host_key = ? OR host_key = ? OR host_key LIKE ?`,
    );

    const runAll = dest.transaction((jobs: Array<{ domain: string; rows: Record<string, unknown>[] }>) => {
      for (const job of jobs) {
        for (const row of job.rows) {
          const already = existsStmt.get(
            String(row.host_key ?? ""),
            String(row.name ?? ""),
            String(row.path ?? "/"),
          ) as { found?: number } | undefined;
          if (already?.found) continue;
          insert.run(shared.map((c) => (row as Record<string, unknown>)[c] ?? null));
          added += 1;
        }
      }
    });

    const jobs: Array<{ domain: string; rows: Record<string, unknown>[] }> = [];
    for (const domain of wanted) {
      const rows = selectRows.all(domain, `.${domain}`, `%.${domain}`) as Record<string, unknown>[];
      if (rows.length === 0) {
        skipped.push({ domain, reason: "이 프로필에서 그 도메인의 쿠키를 찾지 못했습니다." });
        continue;
      }
      jobs.push({ domain, rows });
    }
    runAll(jobs);
    src.close();
    dest.close();

    for (const job of jobs) {
      const site = normalizeSite(`https://${job.domain}`);
      if (!site) {
        skipped.push({ domain: job.domain, reason: "사이트 주소로 바꿀 수 없는 도메인입니다." });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- 사이트 수는 사용자가 고른 만큼이라 작다.
      await upsertBrowserSite({ site, label: job.domain });
      linkedSites.push(site);
    }

    return { ok: true, cookiesAdded: added, linkedSites, skipped };
  } catch (error) {
    return {
      ok: false,
      cookiesAdded: 0,
      linkedSites: [],
      skipped,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    removeWorkDir(workDir);
  }
}

export { browserCdpProfilePath };
