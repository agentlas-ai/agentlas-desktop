// Hephaestus 로컬 등록 → 데스크탑 라이브러리 자동 반영.
//
// 계약(엔진 agentlas_cloud/networking/desktop_sync.py와 쌍):
//   - 엔진은 trusted `local/*` 카드를 저장할 때마다
//     ~/.agentlas/networking/desktop-sync/pending/<slug>.json 을 쓴다.
//     (어느 런타임에서 빌드했든 — Claude 플러그인, Codex, 터미널, 데스크탑 벤더 —
//      카드 쓰기는 전부 save_card 단일 관문을 지난다.)
//   - 데스크탑은 시작 시 + pending 디렉토리 감시로 드레인한다: 각 항목의 ref 폴더를
//     importLocalFolder(경로 멱등)로 임포트하고 항목을 done/으로 옮긴다.
//     done 파일의 content_hash를 엔진이 읽어 같은 카드를 재큐잉하지 않는다.
// - **오너가 만들라고 하지 않은 것은 설치하지 않는다.** 큐 항목은 엔진이 빌드·등록을 끝내고 넣은 것이라 지금까지처럼 설치한다 —
//     공개 엔진(1.2.9x)은 `explicit` 을 싣지 않으므로 표식이 없다는 이유로 보류하지 않는다(보류하면 터미널에서 만든 에이전트가 갇힌다).
// 새 엔진이 `explicit: false` 를 *명시한* 큐 항목과 카드 저장소 스캔으로 우연히 발견된 폴더(오너가 만들라고 한 적 없음)만 `held`: pending 에
// 그대로 두고 임포트하지 않는다. 오너가 "가져오기"를 누르면(`importHeldLocal`) 그때 설치한다. 스캔은 후보 목록만 만든다.
//     이미 설치된 폴더는 보류하지 않고 기존 경로(재임포트)로 간다 — 터미널에서 고친 내용이 반영돼야 한다.
//     routing_ready 포지 실험 카드(수백 장 가능)는 절대 자격이 없다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { importLocalFolder } from "./import-local";
import { listRoutes } from "./routes";
import { getDb } from "../store/db";
import { ownerIds } from "../memory/stores";
import { AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE, agentlasHomeDir, resolveAgentHome } from "./home";

const PACKAGE_MARKERS = ["agentlas.json", "AGENT.md", "AGENTS.md", "TEAM.md", "CLAUDE.md"];
const CARD_SUBDIRS = ["agents", "teams"];
const WATCH_DEBOUNCE_MS = 2_000;
/** Ceiling for the watcher reconnect delay: a watch that cannot attach costs one mkdir and one watch per minute, never a stop. */
const WATCH_RETRY_MAX_DELAY_MS = 60_000;
/** An import that failed stays queued; this many failures in one process move it to failed/ (a permanent failure). */
const IMPORT_FAILURES_BEFORE_FAILED = 3;
const IMPORT_RETRY_DELAY_MS = 30_000;
/** Most recent entries kept in failed/ (the engine reads done/ as its per-card idempotency marker, so done/ is not pruned). */
const KEEP_FAILED_ENTRIES = 50;
const MAX_TRACKED_IMPORT_FAILURES = 200;

function networkingHome(): string {
  const override = process.env.AGENTLAS_NETWORKING_HOME;
  if (override) return override;
  return path.join(agentlasHomeDir(), "networking"); // the one home resolver: AGENTLAS_HOME is respected, unset = ~/.agentlas as before
}

function pendingDir(): string {
  return path.join(networkingHome(), "desktop-sync", "pending");
}

function doneDir(): string {
  return path.join(networkingHome(), "desktop-sync", "done");
}

function failedDir(): string {
  return path.join(networkingHome(), "desktop-sync", "failed");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 엔진 desktop_sync.qualifies_for_desktop과 동일한 규칙 — 변경 시 함께 변경할 것. */
function packageRefFromCard(card: Record<string, unknown>): string | null {
  if (card.stale) return null;
  if (String(card.routing_status ?? "") !== "trusted") return null;
  if (!String(card.id ?? "").startsWith("local/")) return null;
  const type = String(card.type ?? "");
  if (type !== "agent" && type !== "team") return null;
  const source = (card.source ?? {}) as Record<string, unknown>;
  if (String(source.kind ?? "") !== "local_path") return null;
  return validPackageRef(String(source.ref ?? ""));
}

/**
 * 임시 폴더에서 온 패키지는 제품 자산이 아니다.
 *
 * 중복 판정이 경로 기준이라, 테스트가 실행될 때마다 새로 만드는 임시 폴더
 * (`.../pytest-of-<user>/pytest-<n>/...`)는 매번 "처음 보는 에이전트"가 됐다.
 * 그렇게 같은 스튜디오가 43개까지 쌓여 한 번 정리했는데(2026-08-23), 유입을
 * 막지 않아 59개로 다시 늘었다. 청소가 아니라 수도꼭지를 잠근다.
 *
 * 살아 있는 임시 폴더도 거부한다 — 다음 실행이면 사라질 경로를 라이브러리에
 * 등록하면, 그 자리는 반드시 "소스 없음" 상태가 된다.
 */
export function isEphemeralPackagePath(resolved: string): boolean {
  const lower = resolved.toLowerCase();
  if (/[/\\]pytest-of-[^/\\]+[/\\]/.test(lower)) return true;
  if (/[/\\]pytest-\d+[/\\]/.test(lower)) return true;
  // macOS 에서 /var 는 /private/var 의 심링크다. path.resolve 는 심링크를 풀지
  // 않으므로 두 형태를 모두 적어야 한다 — 감사에서 /var/folders 와 /var/tmp 가
  // 그대로 통과하는 것이 실측됐다(2026-08-25).
  for (const base of [
    os.tmpdir(),
    "/tmp", "/private/tmp",
    "/var/tmp", "/private/var/tmp",
    "/var/folders", "/private/var/folders",
  ]) {
    try {
      const root = path.resolve(base).toLowerCase();
      if (lower === root || lower.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return true;
    } catch {
      // 해석할 수 없는 기준 경로는 판단에 쓰지 않는다.
    }
  }
  return false;
}

function validPackageRef(raw: string): string | null {
  if (!raw || !path.isAbsolute(raw)) return null;
  if (isEphemeralPackagePath(path.resolve(raw))) return null;
  try {
    if (!fs.statSync(raw).isDirectory()) return null;
  } catch {
    return null;
  }
  const hasMarker = PACKAGE_MARKERS.some((m) => {
    try {
      return fs.statSync(path.join(raw, m)).isFile();
    } catch {
      return false;
    }
  });
  return hasMarker ? path.resolve(raw) : null;
}

/** 큐 항목이 30일 넘게 held 로 남으면 부팅 때 치운다(오너가 원했다면 그동안 가져왔다). */
const HELD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface SyncItem {
  ref: string;
  /** 자동 설치하지 않는 후보(카드 저장소 스캔으로 발견된 폴더, 새 엔진이 `explicit:false` 로 넣은 큐 항목). */
  held?: boolean;
  /** pending 큐 파일(있으면 처리 후 done/failed로 이동). */
  pendingFile?: string;
  pendingEntry?: Record<string, unknown>;
}

function collectItems(): SyncItem[] {
  const byRef = new Map<string, SyncItem>();

  // 1) 카드 저장소 스캔 — 소급 반영의 원천(큐 도입 전 등록 포함).
  for (const sub of CARD_SUBDIRS) {
    const dir = path.join(networkingHome(), "cards", sub);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const card = readJson(path.join(dir, f));
      if (!card) continue;
      const ref = packageRefFromCard(card);
      if (ref && !byRef.has(ref)) byRef.set(ref, { ref, held: true });
    }
  }

  // 2) pending 큐 — 엔진의 실시간 신호. done 이동으로 재큐잉을 멈추므로 항상 소비한다.
  let pendingFiles: string[] = [];
  try {
    // The publisher writes .tmp-*.json before its atomic rename. It still owns
    // those paths; reading or moving one can destroy an in-flight write.
    pendingFiles = fs.readdirSync(pendingDir()).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
  } catch {
    pendingFiles = [];
  }
  for (const f of pendingFiles) {
    const file = path.join(pendingDir(), f);
    const entry = readJson(file);
    const ref = entry ? validPackageRef(String(entry.ref ?? "")) : null;
    if (!ref) {
      // ref가 사라졌거나 손상된 항목 — 재시도 무의미, failed로 치운다.
      moveEntry(file, failedDir(), { ...(entry ?? {}), error: "invalid or missing ref", reason: "permanent" });
      continue;
    }
    // 표식이 없는 항목(공개 엔진 1.2.9x)은 엔진이 빌드·등록을 끝내고 넣은 것 — 보류하지 않는다. 보류는 새 엔진이 `false` 를 명시한 것뿐.
    const held = entry?.explicit === false;
    const existing = byRef.get(ref);
    if (existing) {
      existing.pendingFile = file;
      existing.pendingEntry = entry ?? undefined;
      existing.held = held;
    } else {
      byRef.set(ref, { ref, pendingFile: file, pendingEntry: entry ?? undefined, held });
    }
  }
  return [...byRef.values()];
}

function moveEntry(file: string, targetDir: string, payload: Record<string, unknown>): void {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, path.basename(file)),
      `${JSON.stringify({ ...payload, drained_at: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    fs.rmSync(file, { force: true });
  } catch (err) {
    console.error("[hephaestus-sync] queue move failed:", err);
    return;
  }
  if (targetDir === failedDir()) pruneOldEntries(targetDir, KEEP_FAILED_ENTRIES);
}

/** Keeps the newest `keep` files by mtime. Only a directory listing is read until the count is over the limit. */
function pruneOldEntries(dir: string, keep: number): void {
  try {
    const names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (names.length <= keep) return;
    const aged = names.flatMap((name) => {
      try { return [{ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }]; } catch { return []; }
    }).sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
    for (const old of aged.slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });
  } catch (err) {
    console.error("[hephaestus-sync] queue prune failed:", err);
  }
}

const LEGACY_PERMANENT_ERROR = "invalid or missing ref";

/**
 * Once per process start (the app booting is the signal): failed/ entries whose reason is not permanent go back to pending/ so
 * the start drain imports them again. The engine enqueues only when a card is saved, so an unchanged card that failed three times
 * on a transient fault would otherwise never come back. An entry written before reasons were recorded has none: it is retried once,
 * unless it carries the one error that was always permanent or its folder is no longer a valid package. An existing pending entry
 * of the same name is never overwritten. At most KEEP_FAILED_ENTRIES are read; failed/ is not read again until the next start.
 */
function requeueTransientFailures(): void {
  let names: string[] = [];
  try { names = fs.readdirSync(failedDir()).filter((f) => f.endsWith(".json")).slice(0, KEEP_FAILED_ENTRIES); } catch { return; }
  for (const name of names) {
    const file = path.join(failedDir(), name);
    const target = path.join(pendingDir(), name);
    try {
      const entry = readJson(file);
      if (!entry || entry.reason === "permanent" || entry.error === LEGACY_PERMANENT_ERROR) continue;
      if (!validPackageRef(String(entry.ref ?? "")) || fs.existsSync(target)) continue;
      const { error: _error, reason: _reason, drained_at: _drainedAt, status: _status, ...original } = entry;
      fs.mkdirSync(pendingDir(), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(original, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      fs.rmSync(file, { force: true });
    } catch (err) {
      console.error("[hephaestus-sync] failed entry requeue skipped:", name, err);
    }
  }
}

// Failures are counted in this process only. Writing the count back into pending/ would wake the watcher on our own write and
// retry in a loop; a restart simply starts counting again over the same pending file.
const importFailures = new Map<string, number>();

function noteImportFailure(pendingFile: string): number {
  const count = (importFailures.get(pendingFile) ?? 0) + 1;
  importFailures.delete(pendingFile);
  importFailures.set(pendingFile, count);
  while (importFailures.size > MAX_TRACKED_IMPORT_FAILURES) {
    const oldest = importFailures.keys().next().value;
    if (oldest === undefined) break;
    importFailures.delete(oldest);
  }
  return count;
}

function alreadyImported(ref: string): boolean {
  try {
    return listRoutes().some((r) => {
      try {
        return path.resolve(r.path) === ref;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export interface HephaestusSyncResult {
  imported: string[];
  skipped: number;
  /** 설치하지 않고 둔 후보 수(카드 스캔 발견·`explicit:false`; Agents 화면 "가져올 수 있는 에이전트"). */
  held?: number;
  failed: Array<{ ref: string; error: string }>;
}

let drainInFlight: Promise<HephaestusSyncResult> | null = null;

function sameDirectory(a: string, b: string): boolean {
  const real = (target: string): string => { try { return fs.realpathSync(target); } catch { return path.resolve(target); } };
  const left = real(a), right = real(b);
  return process.platform === "linux" ? left === right : left.toLowerCase() === right.toLowerCase();
}

/**
 * 폴더의 소유 표식(`.agentlas-local/owner.json`)이 이미 설치된 에이전트의 id 를 가리킬 때 그 폴더가 무엇인가. 던지지 않는다.
 * "moved": 그 에이전트의 폴더는 이제 여기뿐이다(엔진이 폴더를 옮겼다,) — 새 에이전트가 아니다.
 *  "copy":  그 에이전트의 원래 폴더가 아직 제자리에 있다 — `cp -r` 로 만든 복사본이라 owner.json 이 같이 복사됐을 뿐 새 에이전트다.
 *  null:    표식이 없거나 설치된 에이전트를 가리키지 않는다.
 * 원래 폴더는 `resolveAgentHome`(라우트 → 에이전트 루트 안 소유 폴더 → 예전 위치)이 푼 곳이다. 풀지 못하면 옮겨진 것으로 본다(지금까지의 동작).
 */
function installedOwnerKind(ref: string): "moved" | "copy" | null {
  try {
    const ids = ownerIds(ref);
    if (!ids.length) return null;
    const db = getDb();
    let owned = false;
    for (const id of ids) {
      const row = db.prepare("SELECT id, slug FROM installed_agents WHERE id = ?").get(id) as { id: string; slug: string } | undefined;
      if (!row) continue;
      owned = true;
      try {
        const route = listRoutes().find((r) => r.agentId === row.id) ?? null;
        const original = resolveAgentHome({ id: row.id, slug: row.slug }, route).dir;
        if (fs.statSync(original).isDirectory() && !sameDirectory(original, ref)) return "copy";
      } catch { /* 원래 폴더를 못 풀거나 없다 — 옮겨진 것 */ }
    }
    return owned ? "moved" : null;
  } catch {
    return null;
  }
}

/** 복사본이 들고 온 owner.json 을 새 에이전트의 것으로 바꾼다(파일이 있을 때만; 링크는 따라가지 않는다). 던지지 않는다. */
function rewriteOwnerMarker(ref: string, agentId: string): void {
  try {
    const dir = path.join(ref, AGENT_LOCAL_STATE_FOLDER);
    const file = path.join(dir, AGENT_OWNER_FILE);
    if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) return;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 1, agentId }) + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch { /* 표식이 없으면 쓸 것도 없다 */ }
}

export interface HeldLocalAgent {
  /** 폴더의 절대 경로(가져오기에 그대로 넘긴다). */
  ref: string;
  /** queue: `explicit:false` 큐 항목 / scan: 카드 저장소에서 찾은 후보. */
  source: "queue" | "scan";
  name: string | null;
  type: "agent" | "team" | null;
  enqueuedAt: string | null;
}

/** 아직 설치하지 않은 가져올 수 있는 로컬 에이전트. 읽기만 한다(큐·카드·DB 모두 쓰지 않는다). */
export function listHeldLocalAgents(): HeldLocalAgent[] {
  const out: HeldLocalAgent[] = [];
  for (const item of collectItems()) {
    if (!item.held || alreadyImported(item.ref)) continue;
    const entry = item.pendingEntry;
    out.push({
      ref: item.ref,
      source: item.pendingFile ? "queue" : "scan",
      name: typeof entry?.id === "string" ? entry.id.replace(/^local\//, "") : path.basename(item.ref),
      type: entry?.type === "team" ? "team" : entry?.type === "agent" ? "agent" : null,
      enqueuedAt: typeof entry?.enqueued_at === "string" ? entry.enqueued_at : null,
    });
  }
  return out;
}

/** 오너가 고른 held 후보를 설치한다. 목록에 있는 폴더만(임의 경로를 받지 않는다). 큐 항목이면 done 으로 옮긴다. */
export async function importHeldLocalAgent(ref: string): Promise<{ imported: boolean }> {
  const wanted = path.resolve(String(ref ?? ""));
  const item = collectItems().find((candidate) => candidate.held && candidate.ref === wanted);
  if (!item) throw new Error("not_a_held_local_agent");
  try {
    await importLocalFolder(item.ref);
  } catch (error) {
    // The reason travels as a code in the rejection message (the success shape {imported} is unchanged); the screen words it.
    const text = error instanceof Error ? error.message : String(error);
    const code = /Not a folder|ENOENT/i.test(text) ? "folder_missing" : /Couldn't find an agent|찾지 못/.test(text) ? "no_agent_in_folder" : "import_failed";
    console.error("[hephaestus-sync] held import failed:", item.ref, text);
    throw new Error(code);
  }
  if (item.pendingFile) moveEntry(item.pendingFile, doneDir(), { ...(item.pendingEntry ?? {}), status: "imported-by-owner" });
  return { imported: true };
}

/** 부팅 때 한 번: ref 가 사라졌거나 30일 넘은 held 큐 항목을 치운다(숨기지 않는다 — 그때까지는 목록에 있다). */
function pruneHeldEntries(): void {
  let names: string[] = [];
  try { names = fs.readdirSync(pendingDir()).filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-")); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(pendingDir(), name);
    try {
      const entry = readJson(file);
      if (!entry || entry.explicit !== false) continue; // 표식 없는 항목은 설치 대기 중인 정상 항목이다 — 치우지 않는다
      const enqueued = typeof entry.enqueued_at === "string" ? Date.parse(entry.enqueued_at) : NaN;
      const age = now - (Number.isFinite(enqueued) ? enqueued : fs.statSync(file).mtimeMs);
      const gone = !validPackageRef(String(entry.ref ?? ""));
      if (gone || age > HELD_MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch (err) {
      console.error("[hephaestus-sync] held prune skipped:", name, err);
    }
  }
}

/** pending 큐 + 카드 저장소를 드레인해 미등록 로컬 패키지를 라이브러리에 반영한다. */
export function drainHephaestusSync(): Promise<HephaestusSyncResult> {
  if (drainInFlight) return drainInFlight;
  const task = drainOnce().finally(() => {
    if (drainInFlight === task) drainInFlight = null;
  });
  drainInFlight = task;
  return task;
}

async function drainOnce(): Promise<HephaestusSyncResult> {
  const result: HephaestusSyncResult = { imported: [], skipped: 0, held: 0, failed: [] };
  let retryPending = false;
  for (const item of collectItems()) {
    // 이미 설치된 폴더는 보류가 아니다 — 터미널에서 고친 내용이 반영돼야 하므로 기존 경로(재임포트)로 간다(3401a7060 전과 같다).
    if (item.held && !alreadyImported(item.ref)) {
      // 설치하지 않는다. 큐 항목은 pending 에 그대로 남고(done 으로 옮기지 않는다) 목록에 보인다.
      result.held = (result.held ?? 0) + 1;
      continue;
    }
    let asNewAgent = false;
    try {
      // 엔진이 폴더를 옮기며 카드의 source.ref 를 바꿨는데 데스크탑 경로는 아직 옛 곳이면, 같은 에이전트가 새 폴더로 한 번 더 들어온다. 폴더의
      // 소유 표식(owner.json)이 이미 설치된 에이전트를 가리키고 그 에이전트의 원래 폴더가 사라졌으면 새 임포트가 아니라 옮겨진 폴더다 — 설치하지
      // 않고 항목만 끝낸다. 원래 폴더가 제자리에 있으면 복사본이므로 새 에이전트로 등록하고 새 owner.json 을 쓴다.
      if (!alreadyImported(item.ref)) {
        const owner = installedOwnerKind(item.ref);
        if (owner === "moved") {
          result.skipped += 1;
          if (item.pendingFile) moveEntry(item.pendingFile, doneDir(), { ...(item.pendingEntry ?? {}), status: "moved-folder-of-installed-agent" });
          continue;
        }
        asNewAgent = owner === "copy";
      }
      // A pending entry is the engine saying this card changed (it re-queues only on a new content_hash), so an
      // already-registered folder is imported again: same row and seats, new instructions. Skipping it left the
      // Yotube room's Motiondirector on its 2026-10-08 AGENTS.md after the owner's 10-13 21:46Z edit, while the
      // queue entry still moved to done/ as "imported". Card-store scans (no entry) keep skipping known folders.
      if (alreadyImported(item.ref) && !item.pendingFile) {
        result.skipped += 1;
      } else {
        if (asNewAgent) {
          const imported = await importLocalFolder(item.ref, undefined, { asNewAgent: true });
          rewriteOwnerMarker(item.ref, imported.agent.id);
        } else {
          await importLocalFolder(item.ref);
        }
        result.imported.push(item.ref);
        console.log("[hephaestus-sync] imported:", item.ref);
      }
      if (item.pendingFile) {
        importFailures.delete(item.pendingFile);
        moveEntry(item.pendingFile, doneDir(), { ...(item.pendingEntry ?? {}), status: "imported" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ ref: item.ref, error: message });
      console.error("[hephaestus-sync] import failed:", item.ref, message);
      if (item.pendingFile) {
        // A failure may be transient (a folder still being written, a locked file): the entry stays in pending/ and is tried
        // again. Only the third failure in this process makes it permanent.
        if (noteImportFailure(item.pendingFile) >= IMPORT_FAILURES_BEFORE_FAILED) {
          importFailures.delete(item.pendingFile);
          moveEntry(item.pendingFile, failedDir(), { ...(item.pendingEntry ?? {}), error: message, reason: "transient" });
        } else {
          retryPending = true;
        }
      }
    }
  }
  if (retryPending) scheduleImportRetry();
  return result;
}

let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let syncStarted = false;
let syncGeneration = 0;
let retryCount = 0;
let importRetryTimer: NodeJS.Timeout | null = null;
let requeuedThisProcess = false;

/** One short-lived timer re-drains entries whose import failed; it is not re-armed by the drain it starts unless one failed again. */
function scheduleImportRetry(): void {
  if (!syncStarted || importRetryTimer) return;
  const generation = syncGeneration;
  importRetryTimer = setTimeout(() => {
    importRetryTimer = null;
    if (!syncStarted || generation !== syncGeneration) return;
    void drainHephaestusSync().catch((err) => console.error("[hephaestus-sync] import retry drain failed:", err));
  }, IMPORT_RETRY_DELAY_MS);
  importRetryTimer.unref();
}

function clearWatchDebounce(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
}

function scheduleWatchRetry(generation: number): void {
  if (!syncStarted || generation !== syncGeneration || retryTimer) return;
  const delay = Math.min(WATCH_RETRY_MAX_DELAY_MS, WATCH_DEBOUNCE_MS * 2 ** Math.min(retryCount++, 10));
  retryTimer = setTimeout(() => {
    if (!syncStarted || generation !== syncGeneration) return;
    retryTimer = null;
    connectSyncWatcher(generation);
  }, delay);
  retryTimer.unref();
}

function connectSyncWatcher(generation: number): void {
  if (!syncStarted || generation !== syncGeneration || watcher) return;
  try {
    fs.mkdirSync(pendingDir(), { recursive: true });
    const current = fs.watch(pendingDir(), () => {
      if (!syncStarted || generation !== syncGeneration || watcher !== current) return;
      // The watch is delivering events again: the next failure starts from the short delay.
      retryCount = 0;
      clearWatchDebounce();
      debounceTimer = setTimeout(() => {
        if (!syncStarted || generation !== syncGeneration || watcher !== current) return;
        debounceTimer = null;
        void drainHephaestusSync().catch((err) => console.error("[hephaestus-sync] drain failed:", err));
      }, WATCH_DEBOUNCE_MS);
    });
    watcher = current;
    // fs.watch can fail asynchronously after construction (e.g. EMFILE).
    // A synchronous try/catch cannot prevent that error from reaching Main.
    current.on("error", (err) => {
      if (watcher !== current) return;
      watcher = null;
      clearWatchDebounce();
      try { current.close(); } catch { /* already closed by the OS */ }
      console.error("[hephaestus-sync] watch failed (startup drain still ran):", err);
      scheduleWatchRetry(generation);
    });
    current.on("close", () => {
      if (watcher !== current) return;
      watcher = null;
      clearWatchDebounce();
      scheduleWatchRetry(generation);
    });
    if (retryCount > 0) {
      // Replay items queued while the watcher was unavailable.
      void drainHephaestusSync().catch((err) => console.error("[hephaestus-sync] retry drain failed:", err));
    }
  } catch (err) {
    console.error("[hephaestus-sync] watch failed (startup drain still ran):", err);
    scheduleWatchRetry(generation);
  }
}

/** 시작 시 1회 드레인 + pending 감시. 실패해도 앱 시작을 막지 않는다. */
export function startHephaestusSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  retryCount = 0;
  const generation = ++syncGeneration;
  if (!requeuedThisProcess) { requeuedThisProcess = true; pruneHeldEntries(); requeueTransientFailures(); }
  void drainHephaestusSync().catch((err) => console.error("[hephaestus-sync] initial drain failed:", err));
  connectSyncWatcher(generation);
}

export function stopHephaestusSync(): void {
  syncStarted = false;
  ++syncGeneration;
  clearWatchDebounce();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (importRetryTimer) clearTimeout(importRetryTimer);
  importRetryTimer = null;
  const current = watcher;
  watcher = null;
  try { current?.close(); } catch { /* already closed */ }
}
