// 평소 쓰는 Chrome 계열 브라우저의 로그인 세션을 Agentlas 전용 CDP 프로필로 가져온다.
//
// 왜: 전용 프로필은 빈 상태로 태어나므로 사용자가 Connect에서 사이트를 하나씩 손으로 적고
// 전용 창에서 다시 로그인해야 했다. 평소 브라우저에는 이미 그 로그인이 다 있다.
//
// 경계 (이 파일이 지키는 것):
//  1) **값을 노출하지 않는다.** Windows/Linux는 OS가 감싼 프로필 키를 이어받는다. macOS는
//     원본과 번들 런타임의 실제 제품 ID에 맞는 Safe Storage 항목을 선택하고, 서로 다를 때만
//     사용자가 고른 사이트 쿠키를 메모리에서 변환한다. 평문은 파일/로그/응답에 쓰지 않고 키
//     버퍼도 변환 직후 지운다.
//  2) **비밀번호와 결제수단은 만지지 않는다.** `Login Data`·`Web Data`는 읽지도 복사하지도 않는다.
//     이유는 보안 위생이 아니라 손익이다: (a) 로그인 성공률에 거의 기여하지 않는다(로그인은
//     쿠키 + `Local State` 암호화 키로 된다) (b) `Login Data`+`Local State` 동시 접근은
//     인포스틸러 시그니처라 백신·EDR 에 걸려 배포가 막힐 수 있다 (c) 마켓플레이스 플러그인이
//     그 폴더를 읽으면 피해가 "세션 탈취"에서 "전부"로 커진다.
//     Agentlas-OS 레일도 같은 원칙을 따라야 한다 — 비밀번호/결제 저장소는 가져오지 않는다.
//  3) **원본 DB에 연결하지 않는다.** 실행 중인 브라우저가 mmap 한 SQLite에 외부 연결을 붙이면
//     그 브라우저가 SIGBUS 로 죽을 수 있다(2026-08-19 Agentlas 앱에서 2회 실측). 그래서
//     파일을 먼저 복사하고 **사본만** 연다. 사본은 무결성 검사를 통과해야 쓰인다 — 깨졌으면
//     빈 결과로 조용히 진행하지 않고 실패를 말한다.
//  4) **덮어쓰지 않는다(merge).** 전용 프로필에 이미 있는 쿠키 행은 건드리지 않고, 없는 것만 넣는다.
//     에이전트가 전용 창에서 새로 만든 세션을 평소 브라우저 상태가 지우면 안 된다.
import Database from "better-sqlite3";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import type {
  BrowserCredentialImportResult,
  BrowserCredentialScanResult,
  DiscoveredBrowserProfile,
  DiscoveredCredentialDomain,
} from "../../shared/browser-credentials";
import { registrableDomain } from "../../shared/registrable-domain";
import {
  browserCdpPort,
  browserCdpPortReady,
  browserCdpProfilePath,
  clearBrowserCdpOwner,
  ensureBrowserCdpProfilePrivate,
  inspectBrowserCdpOwnership,
  resetBrowserCdpSessionRestoreArtifacts,
  withBrowserCdpMaintenance,
  writeBrowserCdpOwner,
} from "../mcp-tools/browser-cdp-launcher";
import { resolveAgentlasBrowserRuntime } from "./runtime";
import { listBrowserSites, normalizeSite, setBrowserSession, upsertBrowserSite } from "../store/browser-vault";

export interface BrowserFamilyRoot {
  browser: string;
  userDataDir: string;
}

/** Chrome-family user-data candidates for the target OS (pure for matrix tests). */
export function browserFamilyRootsForPlatform(
  platform: NodeJS.Platform,
  home: string,
  env: Partial<Pick<NodeJS.ProcessEnv, "LOCALAPPDATA" | "XDG_CONFIG_HOME">> = process.env,
): BrowserFamilyRoot[] {
  const targetPath = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin") {
    const base = targetPath.join(home, "Library", "Application Support");
    return [
      { browser: "Google Chrome", userDataDir: targetPath.join(base, "Google", "Chrome") },
      { browser: "Microsoft Edge", userDataDir: targetPath.join(base, "Microsoft Edge") },
      { browser: "Brave", userDataDir: targetPath.join(base, "BraveSoftware", "Brave-Browser") },
      { browser: "Chromium", userDataDir: targetPath.join(base, "Chromium") },
    ];
  }
  if (platform === "win32") {
    // Chrome 계열은 전부 LOCALAPPDATA 밑 "<vendor>/<product>/User Data".
    const local = env.LOCALAPPDATA || targetPath.join(home, "AppData", "Local");
    return [
      { browser: "Google Chrome", userDataDir: targetPath.join(local, "Google", "Chrome", "User Data") },
      { browser: "Microsoft Edge", userDataDir: targetPath.join(local, "Microsoft", "Edge", "User Data") },
      { browser: "Brave", userDataDir: targetPath.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
      { browser: "Chromium", userDataDir: targetPath.join(local, "Chromium", "User Data") },
    ];
  }
  const config = env.XDG_CONFIG_HOME || targetPath.join(home, ".config");
  return [
    { browser: "Google Chrome", userDataDir: targetPath.join(config, "google-chrome") },
    { browser: "Microsoft Edge", userDataDir: targetPath.join(config, "microsoft-edge") },
    { browser: "Brave", userDataDir: targetPath.join(config, "BraveSoftware", "Brave-Browser") },
    { browser: "Chromium", userDataDir: targetPath.join(config, "chromium") },
  ];
}

/** Chrome 계열 user-data 디렉터리 후보 — 플랫폼별 표준 위치. */
function browserFamilyRoots(): BrowserFamilyRoot[] {
  return browserFamilyRootsForPlatform(process.platform, os.homedir(), process.env);
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

/**
 * host_key → **사이트 한 줄**(등록 가능 도메인).
 *
 * ★앞의 점만 떼면 안 된다(2026-08-20 실측): `.mongodb.com`(쿠키 19, 로그인 후보 0)과
 * `auth.mongodb.com`(4, 4)이 다른 줄로 남으면, 로그인 쿠키 필터가 **쿠키를 제일 많이 가진
 * 줄을 떨어뜨리고** 엉뚱한 서브도메인만 남긴다. 그걸 고르면 4개만 복사돼 로그인이 깨진다.
 * `.railway.com`/`backboard.railway.com`, `.google.com`/`play.google.com` 도 같은 모양.
 */
function normalizeHostKey(hostKey: string): string {
  return registrableDomain(hostKey);
}

/** 한 도메인의 방문 기록 요약 — 대표 제목과 방문 횟수 합. */
interface DomainHistory {
  /** 방문 수가 가장 많은 URL 의 제목. 없으면 null — 지어내지 않는다. */
  title: string | null;
  /** 이 도메인(및 하위 도메인) URL 들의 visit_count 합. 자주 쓰는 사이트일수록 크다. */
  visits: number;
}

/**
 * 방문 기록에서 도메인별 대표 제목과 방문 횟수 합을 뽑는다.
 * 방문 횟수는 목록 정렬의 1순위다 — "쿠키가 많은 곳"이 아니라 "자주 쓰는 곳"을 위로 올린다.
 * 기록을 못 읽으면 빈 맵 — 그때는 제목도 방문수도 없이 도메인만 나간다(목록 자체는 나가야 한다).
 */
function readDomainHistory(profileDir: string, workDir: string, wanted: Set<string>): Map<string, DomainHistory> {
  const out = new Map<string, DomainHistory>();
  const historySrc = path.join(profileDir, "History");
  if (!fs.existsSync(historySrc)) return out;
  const snap = snapshotSqlite(historySrc, workDir, "History.snapshot");
  if (!snap) return out;
  try {
    const db = new Database(snap, { readonly: true });
    const rows = db
      .prepare(
        `SELECT url, title, visit_count FROM urls
         WHERE visit_count > 0
         ORDER BY visit_count DESC LIMIT 20000`,
      )
      .all() as Array<{ url: string; title: string | null; visit_count: number }>;
    db.close();
    for (const row of rows) {
      let host: string;
      try {
        host = new URL(row.url).hostname.toLowerCase();
      } catch {
        continue;
      }
      // 방문 호스트도 같은 규칙으로 접는다(mail.google.com → google.com 줄의 제목·방문수).
      const domain = registrableDomain(host);
      if (!wanted.has(domain)) continue;
      const prev = out.get(domain) ?? { title: null, visits: 0 };
      const title = (row.title ?? "").trim();
      out.set(domain, {
        // 행은 visit_count 내림차순이라 먼저 잡히는 제목이 가장 많이 방문한 페이지의 것이다.
        title: prev.title ?? (title ? title.slice(0, 80) : null),
        visits: prev.visits + Number(row.visit_count || 0),
      });
    }
  } catch {
    /* 제목·방문수는 순서를 좋게 하는 정보다 — 못 읽어도 도메인 목록은 나가야 한다 */
  }
  return out;
}

/**
 * 필터를 통과한 후보가 이 수보다 적으면 필터를 푼다.
 * 목록이 비면 사용자는 "가져올 게 없다"고 읽고 기능 자체를 버린다 — 적게 잡히는 쪽이
 * 과하게 잡히는 쪽보다 훨씬 나쁘다. 풀었다는 사실은 응답에 표식으로 싣는다.
 */
const LOGIN_FILTER_MIN_RESULTS = 5;

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
    // 이 프로필의 쿠키 테이블에 로그인 쿠키를 가릴 플래그 칸이 실제로 있는가.
    // 없으면(아주 오래된/변형 스키마) 필터를 걸 근거가 없으므로 아예 걸지 않는다.
    const cookieColumns = new Set(
      (db.pragma("table_info(cookies)") as Array<{ name: string }>).map((c) => c.name),
    );
    const canJudgeLogin = cookieColumns.has("is_httponly") && cookieColumns.has("is_secure");
    // ★값(value·encrypted_value)은 SELECT 하지 않는다. 세는 것은 행 수와 플래그뿐이다.
    const loginExpr = canJudgeLogin
      ? "SUM(CASE WHEN is_httponly = 1 AND is_secure = 1 THEN 1 ELSE 0 END)"
      : "0";
    const rows = db
      .prepare(
        `SELECT host_key, COUNT(*) AS n,
                SUM(CASE WHEN has_expires = 1 THEN 1 ELSE 0 END) AS persistent,
                ${loginExpr} AS login_like
         FROM cookies GROUP BY host_key`,
      )
      .all() as Array<{ host_key: string; n: number; persistent: number; login_like: number }>;
    db.close();

    const byDomain = new Map<string, { count: number; persistent: number; login: number }>();
    for (const row of rows) {
      const domain = normalizeHostKey(row.host_key);
      if (!domain || !domain.includes(".")) continue;
      const prev = byDomain.get(domain) ?? { count: 0, persistent: 0, login: 0 };
      byDomain.set(domain, {
        count: prev.count + Number(row.n || 0),
        persistent: prev.persistent + Number(row.persistent || 0),
        login: prev.login + Number(row.login_like || 0),
      });
    }

    const history = readDomainHistory(profile.path, workDir, new Set(byDomain.keys()));
    // 이미 Connect 에 있는 사이트도 같은 규칙으로 접어야 한 줄과 맞붙는다
    // (등록된 것이 `www.notion.so` 여도 목록의 `notion.so` 줄이 '연동됨'이 되어야 한다).
    const linked = new Set(
      listBrowserSites()
        .map((s) => {
          try {
            return registrableDomain(new URL(s.site).hostname);
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    );

    // 정렬: ① 자주 쓰는 사이트(방문 수 합) ② 로그인 쿠키 후보 수 ③ 세션 지속 쿠키 유무 ④ 이름.
    // 쿠키 개수는 정렬에 쓰지 않는다 — 그 축은 광고·분석 도메인을 1등으로 올린다.
    const byRelevance = (a: DiscoveredCredentialDomain, b: DiscoveredCredentialDomain): number => {
      if (b.visitCount !== a.visitCount) return b.visitCount - a.visitCount;
      if (b.loginCookieCount !== a.loginCookieCount) return b.loginCookieCount - a.loginCookieCount;
      if (a.hasPersistentCookie !== b.hasPersistentCookie) return a.hasPersistentCookie ? -1 : 1;
      return a.domain.localeCompare(b.domain);
    };

    const all: DiscoveredCredentialDomain[] = [...byDomain.entries()]
      .map(([domain, agg]) => ({
        domain,
        title: history.get(domain)?.title ?? null,
        cookieCount: agg.count,
        loginCookieCount: agg.login,
        visitCount: history.get(domain)?.visits ?? 0,
        hasPersistentCookie: agg.persistent > 0,
        alreadyLinked: linked.has(domain),
      }))
      .sort(byRelevance);

    // "로그인 쿠키가 있는 사이트"만 남긴다. 광고·분석 도메인은 httpOnly+Secure 세션 쿠키를
    // 두지 않으므로 여기서 떨어진다.
    const filtered = canJudgeLogin ? all.filter((d) => d.loginCookieCount > 0) : [];
    if (canJudgeLogin && filtered.length >= LOGIN_FILTER_MIN_RESULTS) {
      return { ok: true, profiles, domains: filtered, profileId };
    }
    // 너무 적게 잡혔다(또는 판단할 칸이 없다) — 필터를 풀고, 풀었다는 사실을 말한다.
    return { ok: true, profiles, domains: all, profileId, loginFilterRelaxed: true };
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
 * macOS 는 제품별 Keychain 항목이 달라 아래의 선택적 재암호화 경로를 사용한다.
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

const WINDOWS_APP_BOUND_COOKIE_PREFIX = "v20";

/**
 * Chrome's Windows App-Bound Encryption tags cookie ciphertext with `v20`.
 * Those values are deliberately bound to the source browser application path;
 * copying their DB row or Local State key into the Agentlas runtime cannot make
 * them readable. Keep this pure so every release target can test the Windows
 * decision without pretending a macOS build is Windows hardware.
 */
export function cookieUsesWindowsAppBoundEncryption(
  encryptedValue: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    && Buffer.isBuffer(encryptedValue)
    && encryptedValue.length >= WINDOWS_APP_BOUND_COOKIE_PREFIX.length
    && encryptedValue.subarray(0, WINDOWS_APP_BOUND_COOKIE_PREFIX.length).toString("ascii")
      === WINDOWS_APP_BOUND_COOKIE_PREFIX;
}

const MAC_SAFE_STORAGE_SERVICE: Record<string, string> = {
  "Google Chrome": "Chrome Safe Storage",
  "Microsoft Edge": "Microsoft Edge Safe Storage",
  Brave: "Brave Safe Storage",
  Chromium: "Chromium Safe Storage",
};

/**
 * Playwright's Chrome for Testing bundle uses Chromium's OSCrypt Keychain
 * identity on macOS. Select it from the attested runtime identity, never from a
 * user's installed browser. A runtime-written cookie is covered by live QA so a
 * packaging rename cannot silently change this contract.
 */
export function macSafeStorageServiceForRuntime(input: {
  macBundleId?: string | null;
  executable?: string | null;
}): string | null {
  const bundleId = input.macBundleId?.trim().toLowerCase() ?? "";
  const executable = input.executable ?? "";
  if (
    bundleId === "com.google.chrome.for.testing"
    || /(?:^|[\\/])Google Chrome for Testing\.app[\\/]/u.test(executable)
  ) return "Chromium Safe Storage";
  if (/(?:^|[\\/])Chromium\.app[\\/]/u.test(executable)) return "Chromium Safe Storage";
  return null;
}

function agentlasMacSafeStorageService(): string | null {
  const runtime = resolveAgentlasBrowserRuntime();
  if (!runtime) return null;
  return macSafeStorageServiceForRuntime({
    macBundleId: runtime.manifest?.macBundleId ?? null,
    executable: runtime.executable,
  });
}

function readMacSafeStorageKey(service: string): Buffer | null {
  let password: Buffer | null = null;
  try {
    password = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", service],
      { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
    );
    let length = password.length;
    while (length > 0 && (password[length - 1] === 0x0a || password[length - 1] === 0x0d)) length -= 1;
    if (length === 0) return null;
    return pbkdf2Sync(password.subarray(0, length), "saltysalt", 1_003, 16, "sha1");
  } catch {
    return null;
  } finally {
    password?.fill(0);
  }
}

export function reencryptMacChromiumCookie(
  encryptedValue: Buffer,
  hostKey: string,
  sourceKey: Buffer,
  destinationKey: Buffer,
  schemaVersion: number,
): Buffer {
  const plaintext = decryptMacChromiumCookie(encryptedValue, hostKey, sourceKey, schemaVersion);
  try {
    const prefix = encryptedValue.subarray(0, 3);
    const cipher = createCipheriv("aes-128-cbc", destinationKey, Buffer.alloc(16, 0x20));
    return Buffer.concat([prefix, cipher.update(plaintext), cipher.final()]);
  } finally {
    plaintext.fill(0);
  }
}

function decryptMacChromiumCookie(
  encryptedValue: Buffer,
  hostKey: string,
  key: Buffer,
  schemaVersion: number,
): Buffer {
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    throw new Error("지원하지 않는 macOS 쿠키 암호문 형식입니다.");
  }
  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const plaintext = Buffer.concat([decipher.update(encryptedValue.subarray(3)), decipher.final()]);
  if (schemaVersion >= 24) {
    const expectedHostHash = createHash("sha256").update(hostKey).digest();
    if (plaintext.length < expectedHostHash.length
      || !timingSafeEqual(plaintext.subarray(0, expectedHostHash.length), expectedHostHash)) {
      plaintext.fill(0);
      throw new Error("macOS 쿠키의 사이트 무결성 검증에 실패했습니다.");
    }
  }
  return plaintext;
}

function macCookieReencryptor(
  browser: string,
  schemaVersion: number,
): {
  transform: (row: Record<string, unknown>) => Record<string, unknown>;
  destinationCanRead: (row: Record<string, unknown>) => boolean;
  dispose: () => void;
} | null {
  if (process.platform !== "darwin") return null;
  const sourceService = MAC_SAFE_STORAGE_SERVICE[browser];
  if (!sourceService) throw new Error(`${browser}의 macOS 쿠키 암호화 방식을 지원하지 않습니다.`);
  const destinationService = agentlasMacSafeStorageService();
  if (!destinationService) {
    throw new Error("Agentlas 전용 브라우저의 macOS 쿠키 암호화 대상을 확인하지 못했습니다.");
  }
  const destinationKey = readMacSafeStorageKey(destinationService);
  if (!destinationKey) {
    throw new Error(
      "macOS 키체인에서 Agentlas 브라우저의 로그인 변환 키를 읽지 못했습니다. 키체인 접근을 허용한 뒤 다시 시도해 주세요.",
    );
  }
  const destinationCanRead = (row: Record<string, unknown>): boolean => {
    const encrypted = row.encrypted_value;
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) return true;
    try {
      const plaintext = decryptMacChromiumCookie(
        encrypted,
        String(row.host_key ?? ""),
        destinationKey,
        schemaVersion,
      );
      plaintext.fill(0);
      return true;
    } catch {
      return false;
    }
  };

  // Chrome -> Chrome for Testing is the same Keychain identity. Still return a
  // validator: older Agentlas builds wrote these rows with Chromium Safe
  // Storage, and `INSERT OR IGNORE` would otherwise preserve that unreadable
  // ciphertext forever while the UI continued to say "logged in".
  if (sourceService === destinationService) {
    return {
      transform(row) {
        return row;
      },
      destinationCanRead,
      dispose() {
        destinationKey.fill(0);
      },
    };
  }

  const sourceKey = readMacSafeStorageKey(sourceService);
  if (!sourceKey) {
    destinationKey.fill(0);
    throw new Error(
      "macOS 키체인에서 브라우저 로그인 변환 키를 읽지 못했습니다. 키체인 접근을 허용한 뒤 다시 시도해 주세요.",
    );
  }
  return {
    transform(row) {
      const encrypted = row.encrypted_value;
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) return row;
      return {
        ...row,
        encrypted_value: reencryptMacChromiumCookie(
          encrypted,
          String(row.host_key ?? ""),
          sourceKey,
          destinationKey,
          schemaVersion,
        ),
      };
    },
    destinationCanRead,
    dispose() {
      sourceKey.fill(0);
      destinationKey.fill(0);
    },
  };
}

interface MacCdpCookieImportResult {
  accepted: number;
  domains: string[];
  /** Provider pages that confirmed a usable authenticated session, not merely stored cookies. */
  verifiedDomains: string[];
  /** Provider pages that explicitly redirected to a sign-in route. */
  loginRequiredDomains: string[];
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsLive(pid) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return !processIsLive(pid);
}

async function stopMacCookieImportBrowser(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || !processIsLive(pid)) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  if (await waitForProcessExit(pid, 3_000)) return;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  if (!(await waitForProcessExit(pid, 3_000))) {
    throw new Error(`Agentlas 로그인 가져오기 브라우저 정리에 실패했습니다 (${pid}).`);
  }
}

/**
 * macOS Chromium does not reliably adopt cookie rows written into a closed DB:
 * it can accept the SQLite schema and ciphertext, then discard authentication
 * rows during OSCrypt/store initialization. Feed the selected plaintext only to
 * the loopback CDP of one attested Agentlas runtime instead. The runtime writes
 * its own durable encrypted row, values never enter logs/files, and the exact
 * browser root is reaped before the maintenance window is released.
 */
async function importMacCookiesThroughDedicatedRuntime(
  browser: string,
  schemaVersion: number,
  jobs: Array<{ domain: string; rows: Record<string, unknown>[] }>,
): Promise<MacCdpCookieImportResult> {
  if (jobs.length === 0) {
    return { accepted: 0, domains: [], verifiedDomains: [], loginRequiredDomains: [] };
  }
  const sourceService = MAC_SAFE_STORAGE_SERVICE[browser];
  if (!sourceService) throw new Error(`${browser}의 macOS 쿠키 암호화 방식을 지원하지 않습니다.`);
  const sourceKey = readMacSafeStorageKey(sourceService);
  if (!sourceKey) {
    throw new Error("macOS 키체인에서 원본 브라우저의 로그인 키를 읽지 못했습니다.");
  }

  const plaintexts: Buffer[] = [];
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }> = [];
  const cookieDomain = new Map<string, string>();
  try {
    for (const job of jobs) {
      for (const row of job.rows) {
        // Partitioned third-party cookies are not login identity and cannot be
        // represented by Playwright's portable cookie shape without a top-level
        // site. Keep the import first-party and deterministic.
        if (String(row.top_frame_site_key ?? "")) continue;
        const hostKey = String(row.host_key ?? "");
        const name = String(row.name ?? "");
        const cookiePath = String(row.path ?? "/") || "/";
        if (!hostKey || !name) continue;
        let value = typeof row.value === "string" ? row.value : "";
        const encrypted = row.encrypted_value;
        if (Buffer.isBuffer(encrypted) && encrypted.length > 0) {
          let plaintext: Buffer;
          try {
            plaintext = decryptMacChromiumCookie(encrypted, hostKey, sourceKey, schemaVersion);
          } catch {
            continue;
          }
          plaintexts.push(plaintext);
          const offset = schemaVersion >= 24 ? 32 : 0;
          value = plaintext.subarray(offset).toString("utf8");
        }
        const expires = Number(row.expires_utc ?? 0) / 1_000_000 - 11_644_473_600;
        if (Number(row.has_expires ?? 0) !== 0 && Number.isFinite(expires) && expires <= Date.now() / 1000) {
          continue;
        }
        const cookie: (typeof cookies)[number] = {
          name,
          value,
          domain: hostKey,
          path: cookiePath,
          httpOnly: Boolean(row.is_httponly),
          secure: Boolean(row.is_secure),
        };
        if (Number(row.has_expires ?? 0) !== 0 && Number.isFinite(expires) && expires > 0) cookie.expires = expires;
        if (Number(row.samesite) === 0) cookie.sameSite = "None";
        else if (Number(row.samesite) === 1) cookie.sameSite = "Lax";
        else if (Number(row.samesite) === 2) cookie.sameSite = "Strict";
        cookies.push(cookie);
        cookieDomain.set(`${hostKey}\u0000${name}\u0000${cookiePath}`, job.domain);
      }
    }
  } finally {
    sourceKey.fill(0);
  }
  if (cookies.length === 0) {
    for (const plaintext of plaintexts) plaintext.fill(0);
    return { accepted: 0, domains: [], verifiedDomains: [], loginRequiredDomains: [] };
  }

  const runtime = resolveAgentlasBrowserRuntime();
  if (!runtime?.executable || !fs.existsSync(runtime.executable)) {
    for (const plaintext of plaintexts) plaintext.fill(0);
    throw new Error("Agentlas 전용 브라우저 런타임이 없어 로그인을 가져올 수 없습니다.");
  }
  if (await browserCdpPortReady()) {
    for (const plaintext of plaintexts) plaintext.fill(0);
    throw new Error(`Agentlas 브라우저 포트 ${browserCdpPort()}가 이미 사용 중입니다.`);
  }

  let child: ChildProcess | null = null;
  let connection: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    child = spawn(runtime.executable, [
      `--user-data-dir=${browserCdpProfilePath()}`,
      `--remote-debugging-port=${browserCdpPort()}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--disable-features=Translate",
      "--disable-component-update",
      "--disable-background-networking",
      "--headless=new",
      // Do not seed an about:blank target during credential maintenance.
      "chrome://version/",
    ], { detached: false, stdio: "ignore" });
    if (!child.pid) throw new Error("Agentlas 로그인 가져오기 브라우저를 시작하지 못했습니다.");
    let launchError: Error | null = null;
    child.once("error", (error) => { launchError = error; });
    const deadline = Date.now() + 20_000;
    while (!(await browserCdpPortReady()) && Date.now() < deadline && !launchError) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    if (launchError) throw launchError;
    if (!(await browserCdpPortReady())) throw new Error("Agentlas 로그인 가져오기 브라우저가 준비되지 않았습니다.");
    writeBrowserCdpOwner(child.pid);
    const ownership = await inspectBrowserCdpOwnership();
    if (ownership.state !== "owned" || ownership.pid !== child.pid) {
      throw new Error(`Agentlas 로그인 가져오기 브라우저 소유권 확인 실패 (${ownership.state}:${ownership.reason}).`);
    }

    connection = await chromium.connectOverCDP(`http://127.0.0.1:${browserCdpPort()}`);
    const context = connection.contexts()[0];
    if (!context) throw new Error("Agentlas 로그인 가져오기 브라우저 컨텍스트가 없습니다.");
    for (const page of context.pages()) await page.close().catch(() => undefined);
    await context.addCookies(cookies);
    const observed = await context.cookies(jobs.map((job) => `https://${job.domain}/`));
    const acceptedDomains = new Set<string>();
    let accepted = 0;
    for (const cookie of observed) {
      const domain = cookieDomain.get(`${cookie.domain}\u0000${cookie.name}\u0000${cookie.path}`);
      if (!domain) continue;
      accepted += 1;
      acceptedDomains.add(domain);
    }
    const verifiedDomains: string[] = [];
    const loginRequiredDomains: string[] = [];
    // A provider can retain syntactically valid cookies after the account
    // session expires. Cookie-store acceptance is therefore not login proof;
    // confirm X itself before Connect shows a green authenticated state.
    if (acceptedDomains.has("x.com")) {
      const page = await context.newPage();
      try {
        await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 20_000 });
        const finalUrl = page.url();
        const redirectedToLogin = /\/i\/flow\/login|\/login(?:[/?#]|$)/i.test(finalUrl);
        const signedInUi = await page.locator(
          '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="primaryColumn"] [aria-label="Home timeline"]',
        ).first().isVisible({ timeout: 8_000 }).catch(() => false);
        if (redirectedToLogin) loginRequiredDomains.push("x.com");
        else if (signedInUi) verifiedDomains.push("x.com");
      } catch {
        // A network/provider failure cannot be upgraded to a verified login.
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    return { accepted, domains: [...acceptedDomains], verifiedDomains, loginRequiredDomains };
  } finally {
    for (const plaintext of plaintexts) plaintext.fill(0);
    if (connection) await connection.close().catch(() => undefined);
    if (child) {
      const pid = child.pid;
      try {
        await stopMacCookieImportBrowser(child);
      } finally {
        if (pid) clearBrowserCdpOwner(pid);
      }
    }
    resetBrowserCdpSessionRestoreArtifacts();
  }
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
  // 목록의 한 줄과 같은 단위(등록 가능 도메인)로 접는다. 예전 승인 기록이 서브도메인을
  // 담고 있어도 여기서 사이트 단위로 넓어진다 — 좁게 복사해 반쯤 깨진 로그인을 만드느니
  // 그 사이트 쿠키를 전부 옮기는 쪽이 옳다(오너 결정 2026-08-20).
  const wanted = [...new Set(domains.map((d) => registrableDomain(d)).filter(Boolean))];
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

  // Refreshes must not erase a connection that was already verified in
  // Connect. A provider check can fail transiently (network outage, provider
  // UI change, or a short-lived rate limit), and Windows may hide protected
  // cookie values from the importer; retain the pre-refresh state and only
  // downgrade when the provider explicitly redirects to its login route.
  const existingSessionStatuses = new Map(
    listBrowserSites().map((row) => [normalizeSite(row.site), row.session.status] as const),
  );

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

    // 사용자가 보지 못하는 전용 창/헤드리스 작업도 모두 자동화 소유다. 가져오기 전체를
    // 유지보수 잠금 안에서 수행해 Agentlas가 정확한 전용 프로필 프로세스를 자동 종료하고,
    // 쿠키 DB 쓰기가 끝날 때까지 다른 자동화가 다시 브라우저를 띄우지 못하게 한다.
    return await withBrowserCdpMaintenance(async () => {
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

    const schemaVersion = Number(
      (src.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined)?.value ?? 0,
    );
    let reencryptor: ReturnType<typeof macCookieReencryptor> = null;
    try {
      reencryptor = macCookieReencryptor(profile.browser, schemaVersion);
    } catch (error) {
      src.close();
      dest.close();
      throw error;
    }

    const quoted = shared.map((c) => `"${c}"`).join(", ");
    const placeholders = shared.map(() => "?").join(", ");
    // merge: 이미 있는 (host_key, name, path) 는 건드리지 않는다.
    const insert = dest.prepare(`INSERT OR IGNORE INTO cookies (${quoted}) VALUES (${placeholders})`);
    /*
     * ★ 왜 "있으면 건드리지 않는다" 를 버렸나 (오너 신고 2026-08-24, 실측으로 확인):
     *   같은 (host_key, name, path) 를 그냥 건너뛰면, 전용 프로필에 한 번이라도 그 쿠키가
     *   들어간 뒤로는 **낡은 값이 영원히 남는다.** 실제로 돌려 보니 사이트 3개를 고르고
     *   `cookiesAdded: 0` 인데 `ok: true` 였다 — 목록에는 "연결됨" 으로 올라가고 로그인은
     *   되지 않는, 정확히 신고된 상태다. 로그인 쿠키는 회전한다. 원본이 더 새것이면
     *   갱신해야 옮긴 것이 된다.
     */
    const existingStmt = dest.prepare(
      "SELECT expires_utc AS expiresUtc, last_update_utc AS updatedUtc, encrypted_value AS encryptedValue, value AS plainValue FROM cookies WHERE host_key = ? AND name = ? AND path = ? LIMIT 1",
    );
    const deleteStmt = dest.prepare("DELETE FROM cookies WHERE host_key = ? AND name = ? AND path = ?");
    const freshnessOf = (record: Record<string, unknown>): number => {
      // Chrome 은 두 칸 다 마이크로초 정수다. 있는 것 중 큰 값을 신선도로 본다.
      const expires = Number(record.expires_utc ?? record.expiresUtc ?? 0);
      const updated = Number(record.last_update_utc ?? record.updatedUtc ?? 0);
      return Math.max(Number.isFinite(expires) ? expires : 0, Number.isFinite(updated) ? updated : 0);
    };

    let added = 0;
    let refreshed = 0;
    const linkedSites: string[] = [];
    const selectRows = src.prepare(
      `SELECT ${quoted} FROM cookies WHERE host_key = ? OR host_key = ? OR host_key LIKE ?`,
    );

    const runAll = dest.transaction((jobs: Array<{ domain: string; rows: Record<string, unknown>[] }>) => {
      for (const job of jobs) {
        for (const row of job.rows) {
          const hostKey = String(row.host_key ?? "");
          const name = String(row.name ?? "");
          const cookiePath = String(row.path ?? "/");
          const already = existingStmt.get(hostKey, name, cookiePath) as
            { expiresUtc?: number; updatedUtc?: number; encryptedValue?: Buffer; plainValue?: string } | undefined;
          if (already) {
            // 신선도를 비교할 칸이 아예 없는 저장소 형식이면 예전처럼 건드리지 않는다.
            const destinationReadable = !reencryptor || reencryptor.destinationCanRead({
              host_key: hostKey,
              encrypted_value: already.encryptedValue,
              value: already.plainValue,
            });
            if (destinationReadable) {
              if (!destColumns.has("expires_utc") && !destColumns.has("last_update_utc")) continue;
              if (freshnessOf(row) <= freshnessOf(already as Record<string, unknown>)) continue;
            }
            deleteStmt.run(hostKey, name, cookiePath);
            const prepared = reencryptor?.transform(row) ?? row;
            insert.run(shared.map((c) => prepared[c] ?? null));
            refreshed += 1;
            continue;
          }
          const prepared = reencryptor?.transform(row) ?? row;
          insert.run(shared.map((c) => prepared[c] ?? null));
          added += 1;
        }
      }
    });

    const jobs: Array<{ domain: string; rows: Record<string, unknown>[] }> = [];
    const interactiveDomains: string[] = [];
    for (const domain of wanted) {
      const rows = selectRows.all(domain, `.${domain}`, `%.${domain}`) as Record<string, unknown>[];
      if (rows.length === 0) {
        skipped.push({ domain, reason: "이 프로필에서 그 도메인의 쿠키를 찾지 못했습니다." });
        continue;
      }
      // Modern Windows Chrome binds v20 cookie ciphertext to Chrome's own
      // installed application path. A partial copy (legacy rows copied, v20
      // auth rows unreadable) looks successful but opens a logged-out page.
      // Register the site for one-time login in the dedicated runtime instead;
      // never weaken App-Bound Encryption or fall back to automating ordinary
      // Chrome. Once signed in, that dedicated profile persists normally.
      if (rows.some((row) => cookieUsesWindowsAppBoundEncryption(row.encrypted_value))) {
        interactiveDomains.push(domain);
        continue;
      }
      jobs.push({ domain, rows });
    }
    try {
      runAll(jobs);
    } finally {
      reencryptor?.dispose();
      src.close();
      dest.close();
    }

    let runtimeImported: MacCdpCookieImportResult | null = null;
    if (process.platform === "darwin" && jobs.length > 0) {
      runtimeImported = await importMacCookiesThroughDedicatedRuntime(profile.browser, schemaVersion, jobs);
      const acceptedDomains = new Set(runtimeImported.domains);
      for (const job of jobs) {
        if (!acceptedDomains.has(job.domain)) {
          skipped.push({
            domain: job.domain,
            reason: "전용 브라우저가 이 사이트의 로그인 쿠키를 받아들이지 않았습니다.",
          });
        }
      }
    }

    const importedSites: string[] = [];
    const requiresLoginSites: string[] = [];
    const preservedSites: string[] = [];
    const acceptedJobDomains = runtimeImported
      ? jobs.map((job) => job.domain).filter((domain) => (
        runtimeImported!.domains.includes(domain)
        && (domain !== "x.com" || runtimeImported!.verifiedDomains.includes(domain))
      ))
      : jobs.map((job) => job.domain);
    const providerVerificationFailed = runtimeImported
      ? jobs.map((job) => job.domain).filter((domain) => (
        domain === "x.com"
        && runtimeImported!.domains.includes(domain)
        && !runtimeImported!.verifiedDomains.includes(domain)
      ))
      : [];
    const providerLoginRequired = runtimeImported
      ? jobs.map((job) => job.domain).filter((domain) => (
        runtimeImported!.loginRequiredDomains.includes(domain)
      ))
      : [];
    for (const domain of [...acceptedJobDomains, ...providerVerificationFailed, ...interactiveDomains]) {
      const site = normalizeSite(`https://${domain}`);
      if (!site) {
        skipped.push({ domain, reason: "사이트 주소로 바꿀 수 없는 도메인입니다." });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- 사이트 수는 사용자가 고른 만큼이라 작다.
      await upsertBrowserSite({ site, label: domain });
      linkedSites.push(site);
      const providerCheckUnavailable = interactiveDomains.includes(domain)
        || (providerVerificationFailed.includes(domain) && !providerLoginRequired.includes(domain));
      if (interactiveDomains.includes(domain) || providerLoginRequired.includes(domain)) {
        setBrowserSession(site, "none");
        requiresLoginSites.push(site);
      } else if (providerCheckUnavailable && !existingSessionStatuses.has(site)) {
        // A new site has no trusted state to retain. Leave its newly-created
        // session as `none` and ask for one explicit login; an existing site,
        // including a previously valid one, is deliberately left untouched.
        setBrowserSession(site, "none");
        requiresLoginSites.push(site);
      } else if (providerCheckUnavailable) {
        // Do not add this site to importedSites: the final valid-state pass
        // must not turn an unverified refresh back into a green connection.
        preservedSites.push(site);
      } else {
        importedSites.push(site);
      }
    }

    /*
     * `moved === 0` alone is not a failure. It normally means every selected
     * row is already present, readable with the destination key, and at least
     * as fresh. Treating that healthy steady state as failure made the 3-day
     * refresh retry on every launch and showed an error after a successful
     * earlier import. Only fail when no importable or interactive site exists.
     */
    const moved = runtimeImported?.accepted ?? (added + refreshed);
    if (moved === 0
      && importedSites.length === 0
      && requiresLoginSites.length === 0
      && preservedSites.length === 0) {
      return {
        ok: false,
        cookiesAdded: 0,
        linkedSites,
        skipped,
        error: linkedSites.length > 0
          ? "사이트는 목록에 올렸지만 새로 옮길 로그인 정보가 없었습니다. 그 브라우저에서 다시 로그인한 뒤 가져오거나, 연동 창에서 한 번 로그인해 주세요."
          : "옮길 로그인 정보를 찾지 못했습니다. 그 브라우저에서 해당 사이트에 로그인되어 있는지 확인해 주세요.",
      };
    }
    // The source list contains only domains with secure HttpOnly login-cookie
    // evidence, and a successful result means those rows were newly added or
    // refreshed into the dedicated profile. Reflect that completed import in
    // Connect immediately instead of leaving the contradictory "Not signed in"
    // badge until a separate manual login-window confirmation.
    for (const site of importedSites) setBrowserSession(site, "valid");
    return {
      ok: true,
      cookiesAdded: moved,
      linkedSites,
      skipped,
      ...(requiresLoginSites.length > 0 ? { requiresLoginSites } : {}),
    };
    });
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
