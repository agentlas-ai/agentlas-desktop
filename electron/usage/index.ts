import { developmentEffectsSuppressed } from "../development-effect-policy";
// 엔진 사용량 매니저 — 구독형 프로바이더(Claude/Codex/Grok)의 usage를 모아
// 정규화된 UsageSnapshot으로. main에서 60초 캐시(엔드포인트 과호출 방지).
//
// 일시 장애 내성: HTTP 429/네트워크류 실패는 "조회 실패" UI로 떨어뜨리지 않고
// 마지막 정상 스냅샷(30분 내)을 유지한다 — 429는 5분 백오프, force 폴링(재로그인 감지
// 5초 폴링 등)도 프로바이더당 최소 10초 간격으로 묶어 rate-limit 자체를 유발하지 않게 한다.
//
// API 키형(DeepSeek·GLM·Pi 등)은 구독 rate-limit 창이 없어(키 과금) 여기서 다루지 않고,
// Grok CLI는 실제 추론에서 확인된 402 소진 상태만 별도 어댑터가 표시하고,
// 로컬(Ollama)은 무제한 — 둘 다 대시보드 "연결" 칩은 runtime.detect가 담당한다.
// 향후 프로바이더는 이 배열에 어댑터만 추가하면 됨.
import { forgetRuntimeAccountCache } from "../runtime/runtime-account";
import { emitRuntimeSignal } from "../runtime/runtime-signals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ProviderUsage,
  UsageRetryProviderId,
  UsageRetryResult,
  UsageSnapshot,
  UsageWindow,
} from "../../shared/types";
import { getDb } from "../store/db";
import { claudeUsageIdentityFile, currentClaudeUsageAccountFingerprint, getClaudeUsage } from "./claude";
import { codexAuthFile, currentCodexUsageAccountFingerprint, getCodexUsage } from "./codex";
import { getGrokUsage } from "./grok";
import { currentKimiUsageAccountFingerprint, currentKimiUsageCredentialFingerprint, getKimiUsage, kimiUsageIdentityFiles } from "./kimi";
import { localTokensForAsync } from "./local-logs";
import { readProviderHealth } from "./provider-health";
import { UsageRetryGate } from "./retry-policy";
import { userDataPath } from "../runtime-paths";
import { cliUserHome } from "../runtime/product-home-identity";
import { isPaidOverageUsageWindow, isSupportedProviderUsageWindow, providerQuotaExhausted } from "../../shared/runtime-quota";

// 하이브리드 사용량(ccusage + agentcat 절충):
//  - 서버 usage API = 정확한 리밋 %·리셋 시각. 단 rate limit이 짜서 자주 못 친다.
//  - 로컬 로그(local-logs) = rate-limit 0의 실시간 토큰. 단 "한도 대비 %"는 모른다.
// 평상시 서버 조회는 10분 간격으로 급감시켜 429를 예방하고(그 사이 last-good 재사용),
// 서버가 완전히 죽었을 때만(429/네트워크 + last-good 만료) 로컬 토큰으로 폴백해 빈손을 막는다.
const TTL_MS = 120_000; // 전체 스냅샷 캐시(여러 위젯이 공유)
const SERVER_MIN_INTERVAL_MS = 10 * 60_000; // 프로바이더별 실제 서버 재조회 최소 간격(비-force)
const FORCE_MIN_MS = 10_000; // force여도 프로바이더당 최소 재조회 간격
const LAST_GOOD_MAX_MS = 2 * 60 * 60_000; // 일시 장애 시 정상 스냅샷을 대신 보여줄 최대 나이(재시작·장기 429 커버)
const BACKOFF_429_MS = 5 * 60_000; // rate-limit 맞으면 그 프로바이더만 쉰다
// 인증 문제(auth_expired)는 일시 장애가 아니다 — 그건 그대로 표면화해 재로그인 액션을 준다.
const TRANSIENT_ERRORS = new Set(["rate_limited", "network_error"]);

let cache: { snapshot: UsageSnapshot; at: number } | null = null;
const lastResult = new Map<string, { usage: ProviderUsage; at: number }>();
const lastGood = new Map<string, { usage: ProviderUsage; at: number }>();
const backoffUntil = new Map<string, number>();
const providerFetchInFlight = new Map<string, Promise<ProviderUsage | null>>();
const explicitRetryGate = new UsageRetryGate(FORCE_MIN_MS);
const explicitRetryInFlight = new Map<UsageRetryProviderId, Promise<UsageRetryResult>>();

/** Opt-in is local to Agentlas. It does not buy credits or change provider controls. */
export function getSubscriptionCreditUse(): boolean {
  try {
    const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get("subscription_credit_use") as { value: string } | undefined;
    return row?.value === "true";
  } catch { return false; }
}

export function setSubscriptionCreditUse(enabled: boolean): boolean {
  if (typeof enabled !== "boolean") throw new Error("invalid subscription credit preference");
  getDb().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("subscription_credit_use", String(enabled));
  return getSubscriptionCreditUse();
}

function withSubscriptionCreditPolicy(snapshot: UsageSnapshot): UsageSnapshot {
  const enabled = getSubscriptionCreditUse();
  return { ...snapshot, subscriptionCreditUse: enabled, providers: snapshot.providers.map(provider =>
    ["claude-code", "codex"].includes(provider.provider) ? { ...provider, allowPaidUsage: enabled } : provider) };
}


// ── last-good 디스크 영속화 ────────────────────────────────────────────────
// 메모리 전용이면 앱 재시작 직후 첫 조회가 429/네트워크 장애를 맞을 때 보여줄 게 없어
// "조회 실패"부터 뜬다. 마지막 정상 수치를 userData에 남겨 재시작을 건너 유지한다.
function lastGoodFile(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    return userDataPath("usage-last-good.json");
  } catch {
    return null; // electron 밖(헤드리스 스크립트) — 영속화 생략
  }
}
let lastGoodLoaded = false;
function loadLastGood(): void {
  if (lastGoodLoaded) return;
  lastGoodLoaded = true;
  const file = lastGoodFile();
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      { usage: ProviderUsage; at: number }
    >;
    for (const [id, entry] of Object.entries(raw)) {
      if (entry?.usage && typeof entry.at === "number") {
        entry.usage = { ...entry.usage, windows: entry.usage.windows.filter(window => isSupportedProviderUsageWindow(window, id)) };
        lastGood.set(id, entry);
      }
    }
  } catch {
    // 없음/손상 — 무시
  }
}
function saveLastGood(): void {
  const file = lastGoodFile();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(lastGood)), "utf8");
  } catch {
    // best-effort
  }
}

const ADAPTERS: Array<{ id: UsageRetryProviderId; fn: () => Promise<ProviderUsage | null> }> = [
  { id: "claude-code", fn: getClaudeUsage },
  { id: "codex", fn: getCodexUsage },
  { id: "grok", fn: getGrokUsage },
  { id: "kimi", fn: getKimiUsage },
];

/** 로컬 로그는 토큰 절대량만 안다. 구독 사용률을 추정하거나 옛 서버 %를 복사하지 않는다. */
async function localFallback(id: string, base: ProviderUsage | null, now: number): Promise<ProviderUsage | null> {
  const local = await localTokensForAsync(id);
  if (!local || local.lastActivity == null || (local.fiveHour === 0 && local.sevenDay === 0)) return null;
  const mk = (kind: UsageWindow["kind"], label: string, tokens: number): UsageWindow => ({
    id: `${id}-local-${kind}`,
    label,
    kind,
    usedPercent: 0,
    used: tokens,
    unit: "tokens",
  });
  return {
    provider: id,
    backend: base?.backend,
    label: base?.label ?? id,
    status: "ok",
    fetchedAt: now,
    error: "local_estimate", // status=ok라 UI엔 에러 아님 — 렌더가 '로컬 추정' 배지로만 쓴다
    windows: [mk("5h", "Last 5h (local)", local.fiveHour), mk("7d", "Last 7d (local)", local.sevenDay)],
  };
}

/**
 * Owner 2026-10-16: "사용량을 제때제때 갈아끼워줘야지". Only Agentlas's own login button invalidated usage
 * (ipc.ts runtime:openCliLogin), so a sign-in made outside it — a terminal `claude` login, the vendor's own app — left the
 * previous account's figures in place until a usage screen happened to be opened. Production: Claude switched accounts at
 * 13:21Z while usage-last-good still held the old account's weekly 100% read at 08:18Z.
 * Main reads each provider's LOCAL identity (a file read, never the network) once at start and again when one of the
 * files it is read from changes. When the identity changes, that provider's cache is dropped and the new account's usage
 * is read once (fetchProvider discards an entry whose account no longer matches, on disk too); `onChange` lets screens
 * re-read.
 */
export interface UsageAccountWatchTarget {
  id: UsageRetryProviderId;
  /** The local account identity; undefined when signed out or unreadable. */
  read: () => string | undefined;
  /** The files `read` looks at. Only a change to one of them can change the identity. */
  files: () => string[];
}
// Readers and paths are looked up at call time, so a host that replaces a module export is followed.
const USAGE_ACCOUNT_TARGETS: ReadonlyArray<UsageAccountWatchTarget> = [
  { id: "claude-code", read: () => currentClaudeUsageAccountFingerprint(), files: () => [claudeUsageIdentityFile()] },
  { id: "codex", read: () => currentCodexUsageAccountFingerprint(), files: () => [codexAuthFile()] },
  { id: "kimi", read: () => currentKimiUsageAccountFingerprint(), files: () => kimiUsageIdentityFiles() },
];
function readAccountFingerprint(read: () => string | undefined): string | undefined {
  try { return read(); } catch { return undefined; }
}
export function checkUsageAccountChanges(
  seen: Map<string, string | undefined>,
  onChange: (providerId: UsageRetryProviderId) => void,
  targets: ReadonlyArray<UsageAccountWatchTarget> = USAGE_ACCOUNT_TARGETS,
): UsageRetryProviderId[] {
  if (developmentEffectsSuppressed()) return [];
  const changed: UsageRetryProviderId[] = [];
  for (const { id, read } of targets) {
    const current = readAccountFingerprint(read);
    if (!seen.has(id)) { seen.set(id, current); continue; }
    if (seen.get(id) === current) continue;
    seen.set(id, current);
    changed.push(id);
    // The retry windows and cooldowns are keyed by this account (runtime/runtime-account.ts): forget the cached identity, and when
    // another account is now signed in tell every waiter to look again, since what it waited for (the old account's limit) is gone.
    forgetRuntimeAccountCache();
    if (current !== undefined) emitRuntimeSignal("signed-in", id);
    invalidateUsage(id);
    void buildUsageSnapshot({ forceProviderId: id })
      .catch((error) => console.warn(`[usage] account change refresh ${id} failed:`, error instanceof Error ? error.message : error))
      .finally(() => onChange(id));
  }
  return changed;
}

/** Quiet time after the last file event before the identity is read: a sign-in writes its file more than once. */
const USAGE_ACCOUNT_DEBOUNCE_MS = 1_000;
/** A file that never goes quiet (Claude Code rewrites ~/.claude.json all session long) is still read this soon. */
const USAGE_ACCOUNT_MAX_WAIT_MS = 10_000;
/** After a read that found the same account, the next read of that provider waits this long, however often its file is rewritten. */
const USAGE_ACCOUNT_MIN_INTERVAL_MS = 30_000;
/** Period of the timed check, which runs only for a provider whose folders cannot be watched. */
const USAGE_ACCOUNT_FALLBACK_MS = 30_000;

type UsageFolderListener = (event: string, filename: string | Buffer | null) => void;
export interface UsageAccountWatchOptions {
  targets?: ReadonlyArray<UsageAccountWatchTarget>;
  debounceMs?: number;
  maxWaitMs?: number;
  minIntervalMs?: number;
  fallbackMs?: number;
  /** fs.watch, replaceable so a gate can stand in for a platform where it fails. */
  watch?: (folder: string, options: { persistent: boolean }, listener: UsageFolderListener) => fs.FSWatcher;
}
interface WatchedUsageAccount {
  target: UsageAccountWatchTarget;
  /** Inode, size and write time of the identity files at the last read. An event that changed none of them needs no read. */
  signature: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the first event of the pending check arrived. */
  pendingSince: number;
  /** Earliest time of the next read while the last one found the same account. */
  notBefore: number;
  /** The timed check; set only while one of this provider's folders cannot be watched. */
  fallback: ReturnType<typeof setInterval> | null;
}
interface WatchedUsageFolder {
  watcher: fs.FSWatcher;
  inode: string;
  /** Entry name in this folder -> the providers to check when it changes. */
  names: Map<string, Set<WatchedUsageAccount>>;
}

function existingRealPath(target: string): string | undefined {
  try { return fs.realpathSync.native(target); } catch { /* missing, or a volume the native call cannot resolve */ }
  try { return fs.realpathSync(target); } catch { return undefined; }
}
function inodeOf(target: string): string {
  try { const stat = fs.statSync(target); return `${stat.dev}:${stat.ino}`; } catch { return "-"; }
}
function usageFilesSignature(files: string[]): string {
  const now = Date.now();
  return files.map((file) => {
    try {
      const stat = fs.statSync(file);
      // A filesystem that stamps whole seconds cannot tell two quick writes of the same size apart. Such a file, written
      // moments ago, gets a signature that equals no other, so the next event reads it.
      const unsettled = stat.mtimeMs % 1000 === 0 && now - stat.mtimeMs < 3_000;
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}${unsettled ? `:unsettled@${now}` : ""}`;
    } catch { return "-"; }
  }).join("|");
}
/** Entry names as the folder watch reports them: the name on disk, which may differ in case from the configured path. */
function watchedName(name: string): string {
  return process.platform === "linux" ? name : name.toLowerCase();
}
/**
 * The folders that can tell when `file` changes: its own folder, and the folder above (which sees that folder appear,
 * vanish or be replaced), climbing further only while nothing on the way exists yet. A credential file is usually
 * replaced by rename and may not exist yet, so the folder is watched and events are filtered by name.
 * It never climbs above a home folder and never reaches the filesystem root: on macOS a folder watch is fed every event
 * below that folder, so a higher folder costs more and tells nothing new.
 */
function usageWatchPlan(file: string, ceilings: ReadonlySet<string>): Array<{ folder: string; name: string }> {
  const plan: Array<{ folder: string; name: string }> = [];
  let child = path.resolve(file);
  for (let level = 0; level < 8; level++) {
    const folder = path.dirname(child);
    if (folder === child || path.dirname(folder) === folder) break;
    plan.push({ folder, name: path.basename(child) });
    const real = existingRealPath(folder);
    if (ceilings.has(folder) || (real && (ceilings.has(real) || level >= 1))) break;
    child = folder;
  }
  return plan;
}

/**
 * Starts the account watch and returns its stop function. It is driven by file events, not by a clock: with no change to
 * an identity file nothing is read. Works when a file or its folder does not exist yet and when the file is replaced by
 * rename. A provider whose folders cannot be watched (fs.watch throws: no inotify watches left on Linux, a volume without
 * change events, a path with nothing existing on it) gets the timed check instead, for that provider only, until a watch
 * can be set up. Nothing here throws into the caller after start.
 */
export function startUsageAccountWatch(
  onChange: (providerId: UsageRetryProviderId) => void,
  options: UsageAccountWatchOptions = {},
): () => void {
  const targets = options.targets ?? USAGE_ACCOUNT_TARGETS;
  const debounceMs = options.debounceMs ?? USAGE_ACCOUNT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? USAGE_ACCOUNT_MAX_WAIT_MS;
  const minIntervalMs = options.minIntervalMs ?? USAGE_ACCOUNT_MIN_INTERVAL_MS;
  const fallbackMs = options.fallbackMs ?? USAGE_ACCOUNT_FALLBACK_MS;
  const watch = options.watch ?? ((folder, watchOptions, listener) => fs.watch(folder, watchOptions, listener));
  const seen = new Map<string, string | undefined>();
  const filesOf = (target: UsageAccountWatchTarget): string[] => { try { return target.files(); } catch { return []; } };
  // The signature is taken before the read, so a write landing in between is read again rather than missed.
  const accounts: WatchedUsageAccount[] = targets.map((target) => ({
    target, signature: usageFilesSignature(filesOf(target)), timer: null, pendingSince: 0, notBefore: 0, fallback: null,
  }));
  checkUsageAccountChanges(seen, onChange, targets);
  if (developmentEffectsSuppressed()) return () => undefined;

  const folders = new Map<string, WatchedUsageFolder>();
  /** Folders whose watch failed. They are tried again by the timed check, not on every event. */
  const unwatchable = new Set<string>();
  let stopped = false;

  function closeFolder(folder: string): void {
    const entry = folders.get(folder);
    if (!entry) return;
    folders.delete(folder);
    try { entry.watcher.close(); } catch { /* already closed */ }
  }
  function accountsIn(entry: WatchedUsageFolder): Set<WatchedUsageAccount> {
    const all = new Set<WatchedUsageAccount>();
    for (const set of entry.names.values()) for (const account of set) all.add(account);
    return all;
  }
  function onFolderEvent(folder: string, filename: string | Buffer | null): void {
    const entry = folders.get(folder);
    if (!entry || stopped) return;
    // No name: the OS dropped detail (a full event buffer on Windows), so any entry may have changed.
    if (filename == null) { for (const account of accountsIn(entry)) schedule(account); return; }
    const name = watchedName(path.basename(String(filename)));
    const hit = entry.names.get(name);
    if (hit) for (const account of hit) schedule(account);
    // Linux reports the removal or rename of the watched folder itself under the folder's own name.
    else if (name === watchedName(path.basename(folder))) for (const account of accountsIn(entry)) schedule(account);
  }
  /** Brings the set of watched folders in line with the paths the readers use now and with what exists on disk now. */
  function arm(retryUnwatchable: boolean): void {
    if (retryUnwatchable) unwatchable.clear();
    const ceilings = new Set([os.homedir(), cliUserHome()].flatMap((home) => [path.resolve(home), existingRealPath(home) ?? path.resolve(home)]));
    const wanted = new Map<string, Map<string, Set<WatchedUsageAccount>>>();
    const blocked = new Set<WatchedUsageAccount>();
    for (const account of accounts) {
      for (const file of filesOf(account.target)) {
        const plan = usageWatchPlan(file, ceilings);
        // A file reached through a link changes in the folder it really lives in.
        const real = existingRealPath(file);
        if (real) plan.push({ folder: path.dirname(real), name: path.basename(real) });
        let reachable = false;
        for (const { folder, name } of plan) {
          const realFolder = existingRealPath(folder);
          if (!realFolder) continue;
          reachable = true;
          let names = wanted.get(realFolder);
          if (!names) { names = new Map(); wanted.set(realFolder, names); }
          let set = names.get(watchedName(name));
          if (!set) { set = new Set(); names.set(watchedName(name), set); }
          set.add(account);
        }
        if (!reachable) blocked.add(account);
      }
    }
    for (const folder of [...unwatchable]) if (!wanted.has(folder)) unwatchable.delete(folder);
    for (const [folder, entry] of [...folders]) {
      const names = wanted.get(folder);
      // A folder removed and created again is a new folder: a watch on the old one hears nothing on Linux.
      if (names && inodeOf(folder) === entry.inode) entry.names = names;
      else closeFolder(folder);
    }
    for (const [folder, names] of wanted) {
      if (folders.has(folder)) continue;
      if (!unwatchable.has(folder)) {
        try {
          const inode = inodeOf(folder);
          const watcher = watch(folder, { persistent: false }, (_event, filename) => {
            try { onFolderEvent(folder, filename); } catch (error) { console.warn("[usage] account watch event failed:", error instanceof Error ? error.message : error); }
          });
          watcher.on("error", () => {
            const entry = folders.get(folder);
            if (!entry || entry.watcher !== watcher) return;
            // The folder went away (Windows) or the watch broke: stop listening and look again from scratch.
            closeFolder(folder);
            unwatchable.add(folder);
            for (const account of accountsIn(entry)) schedule(account);
          });
          folders.set(folder, { watcher, inode, names });
          continue;
        } catch { unwatchable.add(folder); }
      }
      for (const set of names.values()) for (const account of set) blocked.add(account);
    }
    for (const account of accounts) {
      if (!blocked.has(account)) {
        if (account.fallback) { clearInterval(account.fallback); account.fallback = null; }
      } else if (!account.fallback && !stopped) {
        account.fallback = setInterval(() => check(account, true), fallbackMs);
        account.fallback.unref?.();
      }
    }
  }
  function schedule(account: WatchedUsageAccount): void {
    if (stopped) return;
    const now = Date.now();
    if (account.timer) clearTimeout(account.timer);
    else account.pendingSince = now;
    const due = Math.max(Math.min(now + debounceMs, account.pendingSince + maxWaitMs), account.notBefore);
    account.timer = setTimeout(() => { account.timer = null; check(account, false); }, Math.max(0, due - now));
    account.timer.unref?.();
  }
  /** One look at one provider. `timed` is the fallback clock, which cannot trust events and so always reads. */
  function check(account: WatchedUsageAccount, timed: boolean): void {
    if (stopped) return;
    try {
      arm(timed);
      const signature = usageFilesSignature(filesOf(account.target));
      if (!timed && signature === account.signature) return;
      account.signature = signature;
      const changed = checkUsageAccountChanges(seen, onChange, [account.target]);
      // A change is rare and may be followed by the rest of the sign-in, so only an unchanged read holds the next one back.
      account.notBefore = changed.length ? 0 : Date.now() + minIntervalMs;
      for (const id of changed) console.info(`[usage] ${id} account changed; usage re-read`);
    } catch (error) {
      console.warn("[usage] account watch check failed:", error instanceof Error ? error.message : error);
    }
  }

  arm(false);
  // A write between the first read and the watch being set up raised no event here: compare once more.
  for (const account of accounts) if (usageFilesSignature(filesOf(account.target)) !== account.signature) schedule(account);
  return () => {
    stopped = true;
    for (const account of accounts) {
      if (account.timer) { clearTimeout(account.timer); account.timer = null; }
      if (account.fallback) { clearInterval(account.fallback); account.fallback = null; }
    }
    for (const folder of [...folders.keys()]) closeFolder(folder);
  };
}

/** Main 내부에서 재로그인/실행 영수증 직후 호출 — Renderer에는 직접 노출하지 않는다.
 *  스냅샷 캐시와 프로바이더별 lastResult/backoff를
 *  즉시 무효화해, 다음 조회(force든 일반 폴링이든)가 새 토큰으로 서버를 실제로 다시 치게 한다.
 *  (이게 없으면 429 백오프(최대 15분)·lastResult 체인이 로그인 성공을 가려 "앱 재시작해야 반영"이 된다.)
 *  lastGood(마지막 정상 수치)은 지우지 않는다 — 여전히 유효한 표시 폴백이다. */
export function invalidateUsage(providerId?: string): void {
  cache = null;
  if (providerId) {
    lastResult.delete(providerId);
    backoffUntil.delete(providerId);
  } else {
    lastResult.clear();
    backoffUntil.clear();
  }
}

/**
 * 역할 풀 선택용 동기 peek — 네트워크를 절대 치지 않는다. 마지막 정상
 * 스냅샷(메모리 → 디스크 last-good)에서 해당 프로바이더의 최대 사용률(%)을
 * 돌려주고, 자료가 없거나 너무 오래됐으면 null(= 판단 보류, 스킵 금지).
 * model이 있으면 그 모델에 해당하는 창만 포함한다. 리셋된 창은 현재 한도의 증거가 아니다.
 */
export function peekProviderUsedPercent(providerId: string, now = Date.now(), model?: string): number | null {
  if (developmentEffectsSuppressed()) return null;
  loadLastGood();
  const entry = lastResult.get(providerId) ?? lastGood.get(providerId);
  if (providerId === "codex" && !codexAccountMatches(entry?.usage)) return null;
  if (providerId === "claude-code" && !claudeAccountMatches(entry?.usage)) return null;
  if (providerId === "kimi" && !kimiCredentialMatches(entry?.usage)) return null;
  if (!entry || !Number.isFinite(entry.usage.fetchedAt)
    || now - entry.usage.fetchedAt > LAST_GOOD_MAX_MS) return null;
  const windows = entry.usage?.windows ?? [];
  let max: number | null = null;
  for (const window of windows) {
    if (!isSupportedProviderUsageWindow(window, providerId)) continue;
    if (isPaidOverageUsageWindow(window, providerId)) continue;
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    // An expired limit is no longer evidence of current exhaustion. Do not
    // invent a fresh zero: a missing live observation remains unknown.
    if (typeof window.resetAt === "number" && Number.isFinite(window.resetAt) && window.resetAt <= now) continue;
    if (model && window.model && window.model !== model
      && !(providerId === "claude-code" && ["opus", "sonnet", "haiku"].includes(window.model)
        && (model === window.model || model.startsWith(`claude-${window.model}-`)))) continue;
    max = max === null ? window.usedPercent : Math.max(max, window.usedPercent);
  }
  return max;
}

/** Runtime eligibility uses the same observed quota and native credits as the dashboard. */
export function peekProviderQuotaExhausted(providerId: string, now = Date.now(), model?: string): boolean {
  if (developmentEffectsSuppressed()) return false;
  loadLastGood();
  const entry = lastResult.get(providerId) ?? lastGood.get(providerId);
  if (providerId === "codex" && !codexAccountMatches(entry?.usage)) return false;
  if (providerId === "claude-code" && !claudeAccountMatches(entry?.usage)) return false;
  if (providerId === "kimi" && !kimiCredentialMatches(entry?.usage)) return false;
  if (!entry || !Number.isFinite(entry.usage.fetchedAt)
    || now - entry.usage.fetchedAt > LAST_GOOD_MAX_MS) return false;
  if ((entry.usage.status !== "ok" && entry.usage.status !== "no_quota") || entry.usage.error === "local_estimate") return false;
  return providerQuotaExhausted({ ...entry.usage,
    ...(["claude-code", "codex"].includes(providerId) ? { allowPaidUsage: getSubscriptionCreditUse() } : {}),
  }, now, model, providerId);
}

function codexAccountMatches(usage: ProviderUsage | undefined): boolean {
  const current = currentCodexUsageAccountFingerprint();
  return !!current && !!usage?.accountFingerprint && current === usage.accountFingerprint;
}

function claudeAccountMatches(usage: ProviderUsage | undefined): boolean {
  const current = currentClaudeUsageAccountFingerprint();
  return !!current && !!usage?.accountFingerprint && current === usage.accountFingerprint;
}

function kimiCredentialMatches(usage: ProviderUsage | undefined): boolean {
  const current = currentKimiUsageCredentialFingerprint();
  return !!current && !!usage?.credentialFingerprint && current === usage.credentialFingerprint;
}

async function fetchProvider(
  id: UsageRetryProviderId,
  fn: () => Promise<ProviderUsage | null>,
  now: number,
  force: boolean,
): Promise<ProviderUsage | null> {
  // Account changes must invalidate every fast path, including cooldown and
  // last-good reuse. An old cache without identity cannot prove an account match.
  if (id === "codex" && [lastResult.get(id), lastGood.get(id)]
    .some((entry) => entry && !codexAccountMatches(entry.usage))) {
    lastResult.delete(id);
    lastGood.delete(id);
    backoffUntil.delete(id);
  }
  if (id === "claude-code" && [lastResult.get(id), lastGood.get(id)]
    .some((entry) => entry && !claudeAccountMatches(entry.usage))) {
    lastResult.delete(id);
    lastGood.delete(id);
    backoffUntil.delete(id);
  }
  if (id === "kimi" && [lastResult.get(id), lastGood.get(id)]
    .some((entry) => entry && !kimiCredentialMatches(entry.usage))) {
    lastResult.delete(id);
    lastGood.delete(id);
    backoffUntil.delete(id);
  }
  // 실제 실행에서 확인된 terminal 상태는 과거 정상/비할당 last-good보다 권위가 높다.
  // runtime이 전체 cache를 비운 직후뿐 아니라 앱 재시작 후에도 바로 어댑터를 읽는다.
  const terminalHealth = readProviderHealth(id);
  const hasTerminalHealth = terminalHealth?.code === "grok_quota_exhausted";
  const last = lastResult.get(id);
  if (!hasTerminalHealth && (backoffUntil.get(id) ?? 0) > now && last) return last.usage;
  if (!hasTerminalHealth && last && now - last.at < FORCE_MIN_MS) return last.usage;
  // 평상시(비-force)엔 서버를 10분에 한 번만 친다 — 그 사이 last-good을 그대로 재사용해 429 예방.
  const good = lastGood.get(id);
  // A provider reset ends the cached observation's validity even inside the
  // ordinary polling interval. Read again instead of displaying last week's %.
  const hasResetWindow = good?.usage.windows.some((window) =>
    typeof window.resetAt === "number" && Number.isFinite(window.resetAt) && window.resetAt <= now,
  );
  if (!hasTerminalHealth && !force && good && !hasResetWindow && now - good.at < SERVER_MIN_INTERVAL_MS) {
    lastResult.set(id, { usage: good.usage, at: now });
    return good.usage;
  }

  // Snapshot refresh와 명시 retry가 겹쳐도 동일 Provider 네트워크 요청은 하나만 실행한다.
  const existingFetch = providerFetchInFlight.get(id);
  if (existingFetch) return existingFetch;

  const task = (async (): Promise<ProviderUsage | null> => {
    let usage: ProviderUsage | null = null;
    try {
      usage = await fn();
    } catch (err) {
      usage = null;
      // Renderer에는 원문을 반환하지 않지만 main 진단 로그에는 오류 원인을 남긴다.
      console.warn(`[usage] adapter ${id} threw:`, err instanceof Error ? err.message : err);
    }
    if (!usage) {
      // A disconnected account cannot keep granting eligibility from its disk cache.
      lastResult.delete(id);
      lastGood.delete(id);
      saveLastGood();
      return null;
    }
    if (id === "codex" && !codexAccountMatches(usage)) {
      // The owner may switch accounts while a request is in flight. Do not
      // publish or persist the previous account's eventual response.
      lastResult.delete(id);
      lastGood.delete(id);
      saveLastGood();
      return null;
    }
    if (id === "claude-code" && usage.accountFingerprint && !claudeAccountMatches(usage)) {
      lastResult.delete(id);
      lastGood.delete(id);
      saveLastGood();
      return null;
    }
    if (id === "kimi" && !kimiCredentialMatches(usage)) {
      lastResult.delete(id);
      lastGood.delete(id);
      saveLastGood();
      return null;
    }

    const sameAccount = id === "kimi"
      ? !!usage.credentialFingerprint && !!good?.usage.credentialFingerprint && usage.credentialFingerprint === good.usage.credentialFingerprint
      : id === "codex" || id === "claude-code"
      ? !!usage.accountFingerprint && !!good?.usage.accountFingerprint
        && usage.accountFingerprint === good.usage.accountFingerprint
      : !usage.accountFingerprint || !good?.usage.accountFingerprint
        || usage.accountFingerprint === good.usage.accountFingerprint;
    if (!sameAccount) {
      lastGood.delete(id);
      saveLastGood();
    }

    if (usage.status === "error" && usage.error && TRANSIENT_ERRORS.has(usage.error)) {
      if (usage.error === "rate_limited") {
        // 서버가 Retry-After를 주면 그대로(최소 1분/최대 15분), 없으면 기본 5분.
        const ra = Number(usage.retryAfterSeconds);
        const waitMs = Number.isFinite(ra) && ra > 0
          ? Math.min(Math.max(ra * 1000, 60_000), 15 * 60_000)
          : BACKOFF_429_MS;
        backoffUntil.set(id, now + waitMs);
      }
      if (good && sameAccount && now - good.usage.fetchedAt < LAST_GOOD_MAX_MS) {
        // 일시 장애 — 에러 UI 대신 마지막 정상 수치를 유지(다음 주기에 자연 회복).
        const staleUsage = { ...good.usage, stale: true };
        lastResult.set(id, { usage: staleUsage, at: now });
        return staleUsage;
      }
      // last-good도 없다 — 로컬 로그로라도 표시(빈 "조회 실패" 방지). 로컬조차 없으면 원래 에러.
      const fb = await localFallback(id, sameAccount ? good?.usage ?? null : null, now);
      // The asynchronous log scan may outlive an account switch. Recheck the
      // adapter's identity before publishing its fallback observation.
      if (id === "claude-code" && usage.accountFingerprint && !claudeAccountMatches(usage)) return null;
      if (fb) {
        lastResult.set(id, { usage: fb, at: now });
        return fb;
      }
    }
    if ((usage.status === "ok" || usage.status === "no_quota") && (id !== "claude-code" || claudeAccountMatches(usage))) {
      lastGood.set(id, { usage, at: now });
      backoffUntil.delete(id);
      saveLastGood();
    }
    lastResult.set(id, { usage, at: now });
    return usage;
  })();

  providerFetchInFlight.set(id, task);
  try {
    return await task;
  } finally {
    if (providerFetchInFlight.get(id) === task) providerFetchInFlight.delete(id);
  }
}

function suppressedUsageSnapshot(): UsageSnapshot {
  return { providers: [], fetchedAt: Date.now(), collection: { status: "suppressed", reason: "development_effect_policy_disabled" } };
}

async function buildUsageSnapshot(options?: {
  forceAll?: boolean;
  forceProviderId?: UsageRetryProviderId;
}): Promise<UsageSnapshot> {
  if (developmentEffectsSuppressed()) return suppressedUsageSnapshot();
  loadLastGood();
  const now = Date.now();
  if (cache) {
    const cachedCodex = cache.snapshot.providers.find((provider) => provider.provider === "codex");
    const currentCodex = currentCodexUsageAccountFingerprint();
    if ((cachedCodex && (!currentCodex || cachedCodex.accountFingerprint !== currentCodex))
      || (!cachedCodex && currentCodex)) cache = null;
    const cachedClaude = cache?.snapshot.providers.find((provider) => provider.provider === "claude-code");
    const currentClaude = currentClaudeUsageAccountFingerprint();
    if ((cachedClaude && (!currentClaude || cachedClaude.accountFingerprint !== currentClaude))
      || (!cachedClaude && currentClaude)) cache = null;
    const cachedKimi = cache?.snapshot.providers.find((provider) => provider.provider === "kimi");
    const currentKimi = currentKimiUsageCredentialFingerprint();
    if ((cachedKimi && (!currentKimi || cachedKimi.credentialFingerprint !== currentKimi))
      || (!cachedKimi && currentKimi)) cache = null;
  }
  const forced = options?.forceAll === true || options?.forceProviderId != null;
  if (!forced && cache && now - cache.at < TTL_MS) {
    return withSubscriptionCreditPolicy(cache.snapshot);
  }
  const results = await Promise.allSettled(ADAPTERS.map((adapter) => fetchProvider(
    adapter.id,
    adapter.fn,
    now,
    options?.forceAll === true || options?.forceProviderId === adapter.id,
  )));
  const providers: ProviderUsage[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) providers.push(r.value);
  }
  const snapshot: UsageSnapshot = {
    providers,
    fetchedAt: now,
    // `modelRoleUsage` (the seven-day split of observed tokens by role) is not computed any more: the Dashboard that showed it is gone and nothing else reads it
    // (not the phone, not the terminal, not the app-control catalog's consumers). The field stays optional in the shape, so an older reader sees it absent (desktop 3).
  };
  cache = { snapshot, at: now };
  return withSubscriptionCreditPolicy(snapshot);
}

export async function getUsageSnapshot(opts?: { force?: boolean }): Promise<UsageSnapshot> {
  return buildUsageSnapshot({ forceAll: opts?.force === true });
}

/** Renderer가 호출할 수 있는 유일한 캐시 무효화 경로. Provider별 cooldown과 singleflight를 main이 소유한다. */
export async function retryUsageProvider(providerId: UsageRetryProviderId): Promise<UsageRetryResult> {
  if (developmentEffectsSuppressed()) return { snapshot: suppressedUsageSnapshot(), attempted: false, retryAfterMs: 0 };
  const active = explicitRetryInFlight.get(providerId);
  if (active) {
    const shared = await active;
    return {
      ...shared,
      attempted: false,
      retryAfterMs: explicitRetryGate.remaining(providerId),
    };
  }

  const claim = explicitRetryGate.claim(providerId);
  if (!claim.allowed) {
    return {
      snapshot: await getUsageSnapshot(),
      attempted: false,
      retryAfterMs: claim.retryAfterMs,
    };
  }

  const task = (async (): Promise<UsageRetryResult> => {
    // Gate claim 이후에만 내부 캐시/백오프를 지운다. Gate deadline 자체는 invalidateUsage와 분리돼 있다.
    invalidateUsage(providerId);
    const snapshot = await buildUsageSnapshot({ forceProviderId: providerId });
    return {
      snapshot,
      attempted: true,
      retryAfterMs: explicitRetryGate.remaining(providerId),
    };
  })();
  explicitRetryInFlight.set(providerId, task);
  try {
    return await task;
  } finally {
    if (explicitRetryInFlight.get(providerId) === task) explicitRetryInFlight.delete(providerId);
  }
}
