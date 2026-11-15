// 에이전트 루트(`~/.agentlas/agents`)를 다른 곳으로 옮긴다.
//
// ★ 이 파일은 위치를 *바꾸는* 한 곳이다. 위치를 *읽는* 곳은 home.ts(`agentHomeRoot`/`agentHomeRootStatus`)와 엔진 `agent_home.py` 이고 둘 다 같은 설정 파일
//   `~/.agentlas/agents-root.json` `{"v":1,"path":"/절대/경로"}` 을 읽는다. 위치 표식 파일·심볼릭 링크·세 번째 등록부는 만들지 않는다: 상태(`.agentlas-local`, 기억)는
//   항상 `agentsRoot()/<이름>/` 이고, 정의 위치의 정본은 기존 `agent-routes.json` 이다.
//   Electron 을 가져오지 않는다(데몬이 읽을 수 있게). 제품 상태에 닿는 것(DB·라우트·실행 잠금)은 `RootMoveDeps` 로 받고 기본값은 늦게 `require` 한다.
//
// ★ 커밋 시점은 `agents-root.json` 교체 *한 번*이다. 그 전에는 모든 프로세스(앱·데몬·엔진 CLI·훅)가 옛 루트를, 그 뒤에는 새 루트를 본다.
//   저널은 `~/.agentlas/agents-root-move.json` 한 파일: `planned`(복사 중) → `copied`(복사·검증 끝) → `committing` → `committed`.
//   - 같은 볼륨이고 새 루트가 없으면 **루트 폴더째 rename 한 번**(복사 없음). 설정 파일을 *먼저* 쓰고 곧바로 rename 한다: 그 사이(밀리초)에 읽는 쪽은 "지금 쓸 수 없음"으로
//     물러날 뿐 기본 루트에 새 상태를 만들지 않는다(설정된 루트가 없으면 쓰지 않는다 — `agentHomeRootStatus`). rename 이 안 되면 설정을 되돌린다.
//   - 그 밖(다른 볼륨·새 루트가 이미 있는 빈 폴더)은 **복사형**: 새 루트 아래에 에이전트 폴더(소유 표식이 있는 폴더만)를 복사하고 크기·해시를 검증한다. 복사 중에도 옛 루트가 계속
//     쓰이므로(턴·훅·큐레이터) 지문 비교로 바뀐 파일을 다시 복사하는 패스를 안정될 때까지 되풀이하고(최대 6번), 마지막에 에이전트 쓰기 잠금 아래서 한 번 더 비교한 뒤 커밋한다.
//     SQLite 곁 파일(`-wal`)은 본 파일과 같은 패스에서 복사되고 `-shm` 은 복사하지 않는다(열 때 다시 만들어진다).
//   - 커밋 뒤 마지막 밀리초에 훅이 옛 루트에 쓴 행·파일은 `retireOldAgentRoot` 가 합친다(`mergeMemoryStoreResult`, 그 밖의 파일은 새 폴더의 `.agentlas-local/absorbed-<시각>/`).
// ★ 되돌림: `planned`·`copied`·(설정 파일을 아직 안 쓴) `committing` 에서 죽거나 취소하면 새 루트에 복사한 폴더만 지우고 저널을 지운다 — 읽을 수 있는 쪽은 옛 루트 하나.
//   설정 파일을 쓴 뒤(`committing` 의 나머지, `committed`)는 앞으로만 간다: rename 을 마치고, 라우트·워크스페이스 변경안의 경로를 새 루트로 바꾼다(모두 다시 불러도 안전).
//   취소는 커밋 전 어느 단계에서든 되고, 커밋 뒤에는 `already_committed`(읽을 수 있는 쪽은 새 루트 하나).
// ★ 이전 루트(복사형): 지우지 않고 14일 둔다(`RETAIN_MS`, `.pre-home-` 과 같은 값). **지우는 것은 앱이고 때는 지난 뒤의 첫 유휴 패스(`runAgentHomeMovePass`)**, 또는 사용자가
//   "지금 지우기"(`retire`)를 눌렀을 때다. 지우는 것은 이 이동이 복사한 에이전트 폴더(소유 표식이 있는 것)와 앱이 만든 이름(`.pre-home-*`·`.restore-*`·`absorbed-*`)뿐이고,
//   그 밖의 파일(사용자 소유)이 있으면 폴더째 남기고 저널만 닫는다. 합치지 못한 기억 저장소가 있으면 지우지 않고 90일 뒤 저널을 닫는다(유실보다 남는 쪽).
//   rename 형은 이전 루트가 없다. 저널은 이전 루트가 정리되면 지운다(읽는 곳은 상태 조회와 시작 복구, 지우는 곳은 `retireOldAgentRoot`·`recoverAgentRootMove`).
// ★ 이동은 "행을 옮기는 중" 문(`migration/gate.ts memoryMoveActive`)을 *읽기만* 한다: 첫 실행 이주 지휘가 엔진 호출을 하는 중이면 시작하지 않고(`memory_move_active`), 이동이 도는 동안
//   그 문을 잡지는 않는다(배경 일이 이 이동 때문에 멈추지 않는다 — 그 사이 쓴 행은 지문 비교가 바뀐 파일로 보고 다시 복사하고, 마지막 밀리초의 것은 정리 단계가 합친다).
//   폴더 이동 패스(`runAgentHomeMovePass`)는 이동이 도는 동안 옛 루트를 만지지 않고 `skipped: "root-move"` 로 물러난다.
// ★ 타이머·폴링·파일 감시 없음. 모델 호출 없음. 새 표 없음(저널 한 파일).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentRootMoveOutcome, AgentRootPreviewResult, AgentRootRefusal, AgentRootStatusView } from "../../shared/agent-root";
import { AGENT_LOCAL_STATE_FOLDER, agentHomeRootStatus, agentlasHomeDir, invalidateOwnerIndex, ownerIds, writeFileDurable } from "./home";
import { dropRecallIndex } from "../memory/forget-derived";
import { folderIsWritable } from "../fs/writable-folder";

export const ROOT_SETTINGS_FILE = "agents-root.json";
export const ROOT_MOVE_JOURNAL = "agents-root-move.json";
/** 복사형 이동 뒤 이전 루트를 두는 기간(`.pre-home-` 14일과 같다). */
export const RETAIN_MS = 14 * 24 * 60 * 60 * 1000;
/** 합치지 못한 기억 저장소가 남아 이전 루트를 못 지울 때 저널을 들고 있는 한도. 지난 뒤에는 폴더를 남기고 저널만 닫는다. */
export const RETAIN_BLOCKED_MAX_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_CATCH_UP_PASSES = 6;
/** 이 크기 이하의 파일은 복사 뒤 해시까지 비교한다(그 위는 크기·수정 시각). */
export const HASH_VERIFY_MAX_BYTES = 64 * 1024 * 1024;
const FREE_SPACE_SLACK_BYTES = 32 * 1024 * 1024;
const SKIP_NAME = /(?:-shm|\.split\.lock)$/;
const APP_NOISE_NAME = /^(?:\.pre-home-.*|\.restore-.*|absorbed-.*|\.DS_Store|Thumbs\.db|desktop\.ini|\.agentlas-root-.*)$/;

type Phase = "planned" | "copied" | "committing" | "committed";
interface Journal {
  schema: "agentlas.agents-root-move.v1";
  id: string;
  phase: Phase;
  mode: "rename" | "copy";
  from: string;
  to: string;
  realFrom: string;
  realTo: string;
  /** 새 루트가 없었다면, 이 이동이 만들게 될 가장 위의 폴더(되돌리면 비어 있는 것을 거기까지 지운다). 새 루트가 이미 있던 빈 폴더이면 null. */
  createdRoot: string | null;
  /** 옮기는 에이전트 폴더 이름(복사형). rename 형은 루트째라 비어 있다. */
  names: string[];
  /** 이동 전 설정 파일의 원문(없었으면 null) — 되돌릴 때 그대로 쓴다. */
  previousSettings: string | null;
  startedAt: string;
  pid: number;
  host: string;
  /** 커밋 직전 마지막 비교를 시작한 시각(에이전트 쓰기 잠금 안, 설정 파일을 새 루트로 교체하기 전). 정리 단계는 이보다 뒤에 쓰인 옛 항목·파일만 합친다. */
  committedAt?: string;
  /** 복사형: 마지막으로 안정된(바뀌지 않은) 복사 패스가 옛 루트를 읽기 시작한 시각(커밋 시각이 없는 옛 저널의 대신). */
  verifiedAt?: string;
  /** 커밋 뒤 마무리(라우트·변경안 경로)를 끝냈는가. */
  finished?: boolean;
  retireAfter?: string;
  /** 지우지 못한 이유(기계가 읽는 코드) — 상태 조회가 보여 준다. */
  blocked?: string;
}

export interface RootMoveDeps {
  now(): number;
  deviceOf(target: string): number | bigint | null;
  freeBytes(target: string): number | null;
  /** 이 에이전트의 폴더가 지금 쓰이는 이유(실행·열린 파일 작업·동기화 대기), 없으면 null. */
  blockerFor(agentId: string, folder: string): string | null;
  /** 모든 에이전트의 쓰기 잠금 아래서 동기로 실행한다. 잠금이 잡히지 않으면 `{busy:true}`. */
  withLocks<T>(agentIds: readonly string[], action: () => T): T | { busy: true };
  /** 끝나지 않은 설치·복원 트랜잭션이 있는가(읽을 수 없는 것도 있다고 본다). */
  installOpen(): boolean;
  memoryMoveActive(): boolean;
  homeMovePassActive(): boolean;
  closeStoresUnder(folder: string): void;
  rebindRoutes(from: string, to: string): string[];
  rebindWorkspaceRoot(agentId: string, from: string, to: string): number;
  routePathOf(agentId: string): string | null;
  /** 합치기(복사 뒤 옛 루트에 늦게 쓰인 기억 행: `createdAfter` 보다 뒤에 만들어진 항목만). `merged` 이면 새로 들어온 항목 수. */
  mergeStore(fromFile: string, toFile: string, createdAfter: string): { status: "merged" | string; inserted: number };
  sleep(ms: number): Promise<void>;
}

/* eslint-disable @typescript-eslint/no-require-imports */
function defaultDeps(): RootMoveDeps {
  return {
    now: () => Date.now(),
    deviceOf: (target) => { try { return fs.statSync(target, { bigint: true }).dev; } catch { return null; } },
    freeBytes: (target) => { try { const stat = fs.statfsSync(target); return Number(stat.bavail) * Number(stat.bsize); } catch { return null; } },
    blockerFor: (id, folder) => (require("./workspace-service") as typeof import("./workspace-service")).agentFolderMoveBlocker(id, folder),
    withLocks: (ids, action) => (require("./workspace-service") as typeof import("./workspace-service")).withAgentFolderMoveLocks(ids, action),
    installOpen: () => { const open = (require("../cloud-agents/registry-transaction") as typeof import("../cloud-agents/registry-transaction")).openCloudRegistryFolders(); return open.unreadable || open.folders.length > 0; },
    memoryMoveActive: () => (require("../migration/gate") as typeof import("../migration/gate")).memoryMoveActive(),
    homeMovePassActive: () => (require("./home-move") as typeof import("./home-move")).agentHomeMovePassActive(),
    closeStoresUnder: (folder) => { try { (require("../memory/stores") as typeof import("../memory/stores")).closeStoresUnder(folder); } catch { /* nothing open */ } },
    rebindRoutes: (from, to) => (require("./routes") as typeof import("./routes")).rebindRoutesUnder(from, to),
    rebindWorkspaceRoot: (id, from, to) => (require("./workspace-service") as typeof import("./workspace-service")).rebindAgentWorkspaceRoot(id, from, to),
    routePathOf: (id) => { try { return (require("./routes") as typeof import("./routes")).getRoute(id)?.path ?? null; } catch { return null; } },
    mergeStore: (fromFile, toFile, createdAfter) => { const result = (require("./home-move") as typeof import("./home-move")).mergeMemoryStoreResult(fromFile, toFile, { createdAfter }); return result.status === "merged" ? { status: "merged", inserted: result.inserted ?? 0 } : { status: `${result.status}${result.code ? `:${result.code}` : ""}`, inserted: 0 }; },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
/* eslint-enable @typescript-eslint/no-require-imports */

let deps: RootMoveDeps | null = null;
function d(): RootMoveDeps { return deps ?? (deps = defaultDeps()); }
/** 시험이 제품 상태 대신 가짜를 꽂는다. `null` 이면 기본값. */
export function setRootMoveDepsForTests(next: Partial<RootMoveDeps> | null): void { deps = next ? { ...defaultDeps(), ...next } : null; recoveredState = null; }

/** 시험 장치: 지정한 지점에서 불린다(시험이 SIGKILL 로 끊는다). 제품은 아무것도 꽂지 않는다. */
let faultHook: ((point: string) => void) | null = null;
export function setRootMoveFaultHookForTests(hook: ((point: string) => void) | null): void { faultHook = hook; }
const fault = (point: string): void => { if (faultHook) faultHook(point); };

// ───────────────────────────── 작은 도구 ─────────────────────────────

const fold = (value: string): string => (process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value);
function realOrAncestor(value: string): string {
  const missing: string[] = [];
  let current = path.resolve(value);
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...missing); } catch { /* 없는 쪽을 한 칸 올린다 */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    missing.unshift(path.basename(current));
    current = parent;
  }
}
function insideOrSame(root: string, target: string): boolean {
  const relative = path.relative(fold(path.resolve(root)), fold(path.resolve(target)));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
/** 아직 없는 경로에서 가장 위의 없는 폴더(만들면 이 폴더부터 생긴다). */
function topMissing(target: string): string {
  let top = path.resolve(target);
  for (;;) { const parent = path.dirname(top); if (parent === top || exists(parent)) return top; top = parent; }
}
function sameFolder(a: string, b: string): boolean { return fold(path.resolve(a)) === fold(path.resolve(b)); }
function sameFolderOrNull(a: string | null, b: string): boolean { return a !== null && sameFolder(a, b); }
function isDir(target: string): boolean { try { return fs.statSync(target).isDirectory(); } catch { return false; } }
function isDirNoLink(target: string): boolean { try { const stat = fs.lstatSync(target); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } }
function exists(target: string): boolean { try { fs.lstatSync(target); return true; } catch { return false; } }
function settingsFile(): string { return path.join(agentlasHomeDir(), ROOT_SETTINGS_FILE); }
function journalFile(): string { return path.join(agentlasHomeDir(), ROOT_MOVE_JOURNAL); }
/** 기억 루트와 앱 데이터 폴더(없는 경우·읽을 수 없는 경우는 건너뛴다). 데몬에서도 부르므로 Electron 을 가져오지 않는 모듈만 늦게 읽는다. */
function appOwnedFolders(): string[] {
  const out: string[] = [];
  /* eslint-disable @typescript-eslint/no-require-imports */
  try { const root = (require("../memory/database") as typeof import("../memory/database")).memoryRoot(); if (root) out.push(root); } catch { /* no memory root here */ }
  try { const dir = (require("../runtime-paths") as typeof import("../runtime-paths")).userDataDir(); if (dir) out.push(dir); } catch { /* no userData here */ }
  /* eslint-enable @typescript-eslint/no-require-imports */
  return out;
}
function rootPinnedByEnv(): boolean { const value = process.env.AGENTLAS_AGENT_HOME?.trim(); return Boolean(value && path.isAbsolute(value)); }

function fsyncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); } catch { /* 일부 파일 시스템은 폴더 fsync 를 지원하지 않는다 */ } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}
function writeDurable(file: string, text: string): void {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { writeFileDurable(file, text); fsyncDirectory(path.dirname(file)); return; } catch (error) {
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) break; // Windows: 읽는 쪽이 파일을 연 순간의 교체 실패
      const until = Date.now() + 25 * (attempt + 1); while (Date.now() < until) { /* 짧게 기다린다(동기 쓰기 안) */ }
    }
  }
  throw lastError;
}

function readRawSettings(): { state: "none" } | { state: "unreadable" } | { state: "text"; text: string } {
  try { return { state: "text", text: fs.readFileSync(settingsFile(), "utf8") }; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "none" } : { state: "unreadable" }; }
}
function settingsText(root: string): string { return JSON.stringify({ v: 1, path: root }) + "\n"; }
function writeSettingsRoot(root: string): void { writeDurable(settingsFile(), settingsText(root)); invalidateOwnerIndex(); }
/** 설정 파일을 새 루트로 교체한다(원자적). 이동·다시 연결(`relocate.ts`)이 쓰는 유일한 쓰기 지점이다. */
export function writeAgentsRootSetting(root: string): void { writeSettingsRoot(root); }
/** 루트 바로 아래의 에이전트 폴더(소유 표식이 있는 폴더) 이름. */
export function agentFoldersIn(root: string): string[] { return scanRoot(root).names; }
/** 루트 바로 아래 에이전트 폴더들의 소유 표식에 적힌 에이전트 id. */
export function agentIdsIn(root: string): string[] { return scanRoot(root).ids; }
/** 루트 이동이 이 프로세스에서 돌거나 저널이 남아 있는가(다시 연결·위치 바꾸기가 겹치지 않게). 저널 파일을 읽는다. */
/** An open journal nobody is writing (its process is gone, or it has not touched the file for ten minutes) is settled here - rolled back or finished, the same recovery the start runs. Returns the journal as it is afterwards. */
function healDeadWriterJournal(): ReturnType<typeof readJournal> {
  const state = readJournal();
  if (!active && state.state === "journal" && journalOpen(state.journal) && !journalOwnerBusy(state.journal)) { recoverAgentRootMove(); return readJournal(); }
  return state;
}
/** An open move: the journal says it has not finished (planned / copied / committing, or committed with its finishing step undone). A committed, finished copy move only RETAINS the old root until `retireAfter`: that is not a move in progress. */
function journalOpen(journal: Journal): boolean { return journal.phase !== "committed" || journal.finished !== true; }
/**
 * Is a move open (running in this process, or a journal that is still going)? Audit 62 (first run B1, B8, B9): it used to be "any journal exists", so a finished copy move blocked the Build
 * editor and the reconnect for the 14 days its old root is kept, and a journal whose writing process was gone blocked them until an owner-role start recovered it. A journal whose writer is
 * gone is settled here first (the same recovery the start runs; it rolls back or finishes, never deletes anything but the copy it made), so the question is answered about a move that exists.
 * An unreadable journal still counts as open: it is the owner's (`setAsideUnreadableRootMoveJournal`).
 */
export function agentRootMoveBusy(): boolean {
  if (active !== null) return true;
  const state = healDeadWriterJournal();
  if (state.state === "none") return false;
  if (state.state === "unreadable") return true;
  return journalOpen(state.journal);
}
function restoreSettings(previous: string | null): void {
  if (previous === null) { try { fs.unlinkSync(settingsFile()); } catch { /* 없다 */ } fsyncDirectory(agentlasHomeDir()); }
  else writeDurable(settingsFile(), previous);
  invalidateOwnerIndex();
}
function settingsRootNow(): string | null {
  const raw = readRawSettings();
  if (raw.state !== "text") return null;
  try { const parsed = JSON.parse(raw.text.replace(/^﻿/, "")) as { v?: unknown; path?: unknown }; return parsed.v === 1 && typeof parsed.path === "string" && path.isAbsolute(parsed.path) ? path.resolve(parsed.path) : null; } catch { return null; }
}

function readJournal(): { state: "none" } | { state: "journal"; journal: Journal } | { state: "unreadable" } {
  let text: string;
  try { text = fs.readFileSync(journalFile(), "utf8"); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "none" } : { state: "unreadable" }; }
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, "")) as Journal;
    const okPhase = parsed && (parsed.phase === "planned" || parsed.phase === "copied" || parsed.phase === "committing" || parsed.phase === "committed");
    if (!parsed || parsed.schema !== "agentlas.agents-root-move.v1" || !okPhase || (parsed.mode !== "rename" && parsed.mode !== "copy")
      || typeof parsed.from !== "string" || typeof parsed.to !== "string" || !path.isAbsolute(parsed.from) || !path.isAbsolute(parsed.to) || !Array.isArray(parsed.names)) return { state: "unreadable" };
    return { state: "journal", journal: parsed };
  } catch { return { state: "unreadable" }; }
}
function writeJournal(journal: Journal): void { writeDurable(journalFile(), JSON.stringify(journal) + "\n"); recoveredState = { journal: true }; } // a journal now exists: an erase later in this session must clear the retained copy too (defect 12)
function deleteJournal(): void { try { fs.unlinkSync(journalFile()); } catch { /* 이미 없다 */ } fsyncDirectory(agentlasHomeDir()); recoveredState = { journal: false }; }

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
/** 저널을 쓴 프로세스가 아직 이동 중인가. 번호가 다른 프로세스로 재사용됐을 수 있으니 하루가 지난 저널은 살아 있다고 보지 않는다(복사가 하루를 넘길 일은 없다). */
function journalOwnerBusy(journal: Journal): boolean {
  if (journal.pid === process.pid) return false;
  if (!processAlive(journal.pid)) return false;
  if (d().now() - (Date.parse(journal.startedAt) || 0) >= 24 * 60 * 60 * 1000) return false;   // a copy never takes a day: a pid that lives after a day is another program's
  // Audit 62 (first run B9): a pid is reused by other programs (Windows reuses numbers fast), so "the pid lives" proved nothing for up to a day. The writer touches the journal file while it works
  // (`journalHeartbeat`, at most every 30 s, and every write of the journal is one): a journal nobody has touched for ten minutes has no writer, whatever its pid is now.
  const age = d().now() - journalTouchedAt(journal);
  return age < JOURNAL_HEARTBEAT_STALE_MS;
}
/** The writer of an open journal must have touched its file within this time to count as alive (the heartbeat is every 30 s). */
export const JOURNAL_HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const JOURNAL_HEARTBEAT_EVERY_MS = 30 * 1000;
let lastHeartbeatAt = 0;
function journalTouchedAt(journal: Journal): number {
  // The file's own modification time is the last touch (every write of the journal and every heartbeat sets it); the start time only stands in when the file cannot be read.
  try { return fs.statSync(journalFile()).mtimeMs; } catch { return Date.parse(journal.startedAt) || 0; }
}
/** Called from the copy loop: keeps the journal's modification time fresh without rewriting it. Cheap when called often. */
function journalHeartbeat(): void {
  const at = d().now();
  if (at - lastHeartbeatAt < JOURNAL_HEARTBEAT_EVERY_MS) return;
  lastHeartbeatAt = at;
  try { const when = new Date(Date.now()); fs.utimesSync(journalFile(), when, when); } catch { /* no journal: nothing to keep alive */ }
}

// ───────────────────────────── 계획·미리보기 ─────────────────────────────

/** 옮길 에이전트 폴더: 루트 바로 아래의, 링크가 아니고 소유 표식이 있는 폴더. `others` 는 소유 표식 없는 항목(사용자 소유일 수 있다). */
function scanRoot(root: string): { names: string[]; others: string[]; allAppOwned: boolean; ids: string[] } {
  const names: string[] = [];
  const ids = new Set<string>();
  const others: string[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(root).sort(); } catch { return { names, others, allAppOwned: false, ids: [] }; }
  for (const name of entries) {
    const full = path.join(root, name);
    const owners = isDirNoLink(full) ? ownerIds(full) : [];
    if (owners.length > 0) { names.push(name); for (const id of owners) ids.add(id); }
    else if (!APP_NOISE_NAME.test(name)) others.push(name);
  }
  return { names, others, allAppOwned: others.length === 0, ids: [...ids] };
}

interface Entry { kind: "d" | "f" | "l"; size: number; mtimeMs: number; link?: string; mode: number }
type Snapshot = Map<string, Entry>;
function walk(dir: string, rel: string, out: Snapshot, stats: { links: number; longest: number }): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (SKIP_NAME.test(name)) continue;
    const full = path.join(dir, name);
    const key = rel ? `${rel}/${name}` : name;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(full); } catch { continue; }
    stats.longest = Math.max(stats.longest, key.length);
    if (stat.isSymbolicLink()) { stats.links += 1; let link = ""; try { link = fs.readlinkSync(full); } catch { /* gone */ } out.set(key, { kind: "l", size: 0, mtimeMs: 0, link, mode: 0 }); }
    else if (stat.isDirectory()) { out.set(key, { kind: "d", size: 0, mtimeMs: 0, mode: stat.mode & 0o7777 }); walk(full, key, out, stats); }
    else if (stat.isFile()) out.set(key, { kind: "f", size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o7777 });
  }
}
function snapshotFolders(root: string, names: readonly string[]): { snap: Snapshot; links: number; longest: number } {
  const snap: Snapshot = new Map();
  const stats = { links: 0, longest: 0 };
  for (const name of names) {
    const dir = path.join(root, name);
    if (!isDirNoLink(dir)) continue;
    snap.set(name, { kind: "d", size: 0, mtimeMs: 0, mode: 0 });
    walk(dir, name, snap, stats);
  }
  return { snap, ...stats };
}
function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  return Boolean(a && b && a.kind === b.kind && a.size === b.size && a.mtimeMs === b.mtimeMs && a.link === b.link);
}
function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [key, entry] of a) if (!sameEntry(entry, b.get(key))) return false;
  return true;
}
function totalBytes(snap: Snapshot): number { let sum = 0; for (const entry of snap.values()) if (entry.kind === "f") sum += entry.size; return sum; }

function normalizeTarget(input: unknown): { ok: true; target: string } | { ok: false; code: AgentRootRefusal } {
  if (typeof input !== "string" || !input.trim() || input.includes("\0") || !path.isAbsolute(input.trim())) return { ok: false, code: "target_invalid" };
  return { ok: true, target: path.resolve(input.trim()) };
}

interface Plan {
  mode: "rename" | "copy";
  from: string; to: string; realFrom: string; realTo: string;
  names: string[]; leftBehind: number; bytes: number; free: number | null; createdRoot: string | null;
}

function plan(targetInput: unknown): { ok: true; plan: Plan } | { ok: false; code: AgentRootRefusal; detail?: string } {
  const fail = (code: AgentRootRefusal, detail?: string) => ({ ok: false as const, code, ...(detail ? { detail } : {}) });
  if (rootPinnedByEnv()) return fail("root_pinned_by_env");
  const journal = readJournal();
  if (journal.state === "unreadable") return fail("settings_unreadable", "journal");
  if (journal.state === "journal") return fail(journal.journal.phase === "committed" && journal.journal.mode === "copy" ? "previous_root_retained" : "move_in_progress", journal.journal.from);
  if (active) return fail("move_in_progress");
  const normalized = normalizeTarget(targetInput);
  if (!normalized.ok) return fail(normalized.code);
  const target = normalized.target;
  const status = agentHomeRootStatus();
  if (!status.available) return fail("source_unavailable", status.reason);
  const raw = readRawSettings();
  if (raw.state === "unreadable") return fail("settings_unreadable");
  const from = path.resolve(status.path);
  const realFrom = realOrAncestor(from);
  const realTo = realOrAncestor(target);
  if (sameFolder(realFrom, realTo)) return fail("same_root");
  if (insideOrSame(realFrom, realTo)) return fail("target_inside_source");
  if (insideOrSame(realTo, realFrom)) return fail("source_inside_target");
  const realHome = realOrAncestor(os.homedir()), realAgentlasHome = realOrAncestor(agentlasHomeDir());
  // 파일 시스템 루트·홈·앱 홈(설정과 저널이 사는 곳)이거나 그것들의 상위 폴더는 에이전트 루트가 될 수 없다.
  if (path.parse(target).root === target || insideOrSame(realTo, realHome) || insideOrSame(realTo, realAgentlasHome)) return fail("target_unsafe");
  // 앱이 따로 쓰는 두 곳(기억 루트·앱 데이터 폴더)의 안팎도 에이전트 루트가 될 수 없다(기억 루트가 앱 홈 밖에 설정된 경우도 같다).
  for (const guarded of appOwnedFolders()) { const real = realOrAncestor(guarded); if (insideOrSame(real, realTo) || insideOrSame(realTo, real)) return fail("target_unsafe"); }
  let targetExists = false;
  try {
    const stat = fs.lstatSync(target);
    targetExists = true;
    if (stat.isSymbolicLink()) return fail("target_is_link");
    if (!stat.isDirectory()) return fail("target_invalid", "not-a-folder");
    const entries = fs.readdirSync(target).filter((name) => name !== ".DS_Store" && name !== "Thumbs.db" && name !== "desktop.ini");
    if (entries.length > 0) return fail("target_not_empty");
    if (!folderIsWritable(target)) return fail("target_not_writable");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("target_invalid", (error as NodeJS.ErrnoException).code);
    // 아직 없는 새 루트: 가장 가까운 기존 상위가 쓸 수 있는 폴더여야 한다.
    let parent = path.dirname(target);
    while (!exists(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    if (!isDir(parent)) return fail("target_invalid", "parent");
    if (!folderIsWritable(parent)) return fail("target_not_writable");
  }
  const scan = scanRoot(from);
  const { snap, links, longest } = snapshotFolders(from, scan.names);
  if (process.platform === "win32") {
    if (links > 0) return fail("links_unsupported");
    if (target.length + 1 + longest + 1 > 259) return fail("path_too_long");
  }
  const bytes = totalBytes(snap);
  let ancestor = target;
  while (!exists(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  const sameVolume = (() => { const a = d().deviceOf(from), b = d().deviceOf(ancestor); return a !== null && b !== null && a === b; })();
  const mode: "rename" | "copy" = sameVolume && !targetExists && scan.allAppOwned && isDirNoLink(from) ? "rename" : "copy";
  const free = d().freeBytes(ancestor);
  if (mode === "copy" && free !== null && free < Math.ceil(bytes * 1.05) + FREE_SPACE_SLACK_BYTES) return fail("disk_low", JSON.stringify({ needed: Math.ceil(bytes * 1.05) + FREE_SPACE_SLACK_BYTES, free }));
  return { ok: true, plan: { mode, from, to: target, realFrom, realTo, names: scan.names, leftBehind: scan.others.length, bytes, free, createdRoot: targetExists ? null : topMissing(target) } };
}

/** 옮기기 전에 보여 줄 것(아무것도 쓰지 않는다). */
export function previewAgentRootMove(target: unknown): AgentRootPreviewResult {
  const result = plan(target);
  if (!result.ok) return result;
  const p = result.plan;
  return { ok: true, mode: p.mode, from: p.from, to: p.to, folders: p.names.length, leftBehind: p.leftBehind, bytes: p.bytes, freeBytes: p.free };
}

// ───────────────────────────── 이동 ─────────────────────────────

interface Active { id: string; abort: boolean; progress: { files: number; filesTotal: number; bytes: number; bytesTotal: number; pass: number }; release: (() => void) | null; done: Promise<AgentRootMoveOutcome> }
let active: Active | null = null;
let activeJournalPhase: Phase | null = null;

export function agentRootMoveActive(): boolean { return active !== null; }

class Cancelled extends Error { constructor() { super("cancelled"); } }

function listTop(root: string): string[] { try { return fs.readdirSync(root).sort(); } catch { return []; } }
function ownerIdsOfFolders(root: string, names: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const name of names) for (const id of ownerIds(path.join(root, name))) ids.add(id);
  return [...ids];
}
function firstBlocker(root: string, names: readonly string[]): string | null {
  for (const name of names) {
    const folder = path.join(root, name);
    for (const id of ownerIds(folder)) {
      const blocker = d().blockerFor(id, d().routePathOf(id) ?? folder);
      if (blocker) { lastBlockerId = id; return blocker; }
    }
  }
  return null;
}
/** Audit 62 (first run B14): the agent that held the last refusal (`agent_running`), so the result can say whose turn or file work it was. Codes and ids only. */
let lastBlockerId: string | null = null;

function hashFile(file: string): string | null {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function copyEntry(srcRoot: string, dstRoot: string, key: string, entry: Entry): void {
  const src = path.join(srcRoot, ...key.split("/"));
  const dst = path.join(dstRoot, ...key.split("/"));
  if (entry.kind === "d") { fs.mkdirSync(dst, { recursive: true }); try { fs.chmodSync(dst, entry.mode || 0o755); } catch { /* 권한을 못 바꾸는 파일 시스템 */ } return; }
  if (entry.kind === "l") { try { fs.unlinkSync(dst); } catch { /* 없다 */ } fs.symlinkSync(entry.link ?? "", dst); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const stat = fs.statSync(src);
  fs.utimesSync(dst, stat.atime, stat.mtime);
}

function removeCopied(dstRoot: string, key: string): void { try { fs.rmSync(path.join(dstRoot, ...key.split("/")), { recursive: true, force: true }); } catch { /* 다음 패스·되돌림이 다시 본다 */ } }

function verifyCopy(srcRoot: string, dstRoot: string, snap: Snapshot): string | null {
  for (const [key, entry] of snap) {
    const dst = path.join(dstRoot, ...key.split("/"));
    let stat: fs.Stats;
    try { stat = fs.lstatSync(dst); } catch { return `missing:${key}`; }
    if (entry.kind === "d") { if (!stat.isDirectory()) return `kind:${key}`; continue; }
    if (entry.kind === "l") { if (!stat.isSymbolicLink()) return `kind:${key}`; continue; }
    if (!stat.isFile() || stat.size !== entry.size) return `size:${key}`;
    if (entry.size <= HASH_VERIFY_MAX_BYTES) {
      const srcFile = path.join(srcRoot, ...key.split("/"));
      const a = hashFile(srcFile), b = hashFile(dst);
      if (a === null && !exists(srcFile)) return `changed:${key}`; // 확인하는 동안 원본이 사라졌다(SQLite 는 마지막 연결이 닫힐 때 `-wal` 을 지운다): 디스크가 거짓말한 것이 아니라 원본이 바뀐 것이다
      if (a === null || b === null || a !== b) {
        let now: fs.Stats | null = null; try { now = fs.lstatSync(srcFile); } catch { /* gone */ }
        if (!now || now.size !== entry.size || now.mtimeMs !== entry.mtimeMs) return `changed:${key}`; // 지문 뒤에 원본이 또 바뀌었다: 디스크가 거짓말한 것이 아니다
        return `hash:${key}`;
      }
    }
  }
  return null;
}

function rollbackCopy(journal: Journal): void {
  if (journal.mode === "copy") {
    for (const name of journal.names) {
      const folder = path.join(journal.to, name);
      // 새 루트는 이 이동이 시작할 때 비어 있었다(미리 검사했다): 이름이 저널에 있는 것만 지운다. 링크이면 링크만 지운다.
      try { if (isDirNoLink(folder)) fs.rmSync(folder, { recursive: true, force: true }); else if (exists(folder)) fs.unlinkSync(folder); } catch { /* 다음 시작의 복구가 다시 한다 */ }
    }
  }
  // 이 이동이 만든 폴더(새 루트와 없던 상위)를 비어 있는 만큼만 위로 지운다 — 사용자가 그 사이에 넣은 것이 있으면 거기서 멈춘다.
  if (journal.createdRoot) {
    let current = path.resolve(journal.to);
    for (;;) {
      try { fs.rmdirSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") break; } // 아직 안 만든 칸은 건너뛰고 위로
      if (sameFolder(current, journal.createdRoot)) break;
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
}

function toOutcomeFailure(code: AgentRootRefusal, detail?: string): AgentRootMoveOutcome { return { ok: false, code, ...(detail ? { detail } : {}) }; }

/**
 * 에이전트 루트를 `target` 으로 옮긴다. 실행 중인 에이전트가 있으면 시작하지 않는다(`agent_running`). 던지지 않는다 — 거절·실패는 코드로 돌려주고, 커밋 전이면 옛 루트가 그대로다.
 * `signal`(또는 `cancelAgentRootMove`)로 커밋 전 어느 단계에서든 취소된다.
 */
export function startAgentRootMove(target: unknown, options: { signal?: AbortSignal } = {}): Promise<AgentRootMoveOutcome> {
  if (active) return Promise.resolve(toOutcomeFailure("move_in_progress"));
  const planned = plan(target);
  if (!planned.ok) return Promise.resolve(toOutcomeFailure(planned.code, planned.detail));
  const p = planned.plan;
  if (d().memoryMoveActive()) return Promise.resolve(toOutcomeFailure("memory_move_active"));
  if (d().homeMovePassActive()) return Promise.resolve(toOutcomeFailure("home_move_active"));
  if (d().installOpen()) return Promise.resolve(toOutcomeFailure("install_in_progress"));
  const blocker = firstBlocker(p.from, p.names);
  if (blocker) return Promise.resolve(toOutcomeFailure("agent_running", blocker));
  const me: Active = { id: randomUUID(), abort: false, progress: { files: 0, filesTotal: 0, bytes: 0, bytesTotal: p.bytes, pass: 0 }, release: null, done: Promise.resolve(toOutcomeFailure("cancelled")) };
  active = me;
  const onAbort = (): void => { me.abort = true; };
  if (options.signal) { if (options.signal.aborted) me.abort = true; else options.signal.addEventListener("abort", onAbort, { once: true }); }
  // 같은 장치로 보였는데 rename 이 거절됐다(EXDEV: 바인드 마운트·다른 파일 시스템이 같은 장치 번호를 보인다 / EBUSY: 루트가 마운트 지점이다 / EPERM: Windows 에서 열린 핸들이 폴더를 잡고 있다): 복사형으로 한 번 더 한다. 설정은 이미 되돌려졌다.
  const withExdevFallback = async (): Promise<AgentRootMoveOutcome> => {
    const first = await run(me, p);
    if (!first.ok && first.code === "rename_failed" && ["EXDEV", "EBUSY", "EPERM"].includes(first.detail ?? "") && p.mode === "rename" && !me.abort) return run(me, { ...p, mode: "copy" });
    return first;
  };
  me.done = withExdevFallback().catch((error): AgentRootMoveOutcome => toOutcomeFailure("copy_failed", (error as NodeJS.ErrnoException)?.code ?? String(error))).finally(() => {
    options.signal?.removeEventListener("abort", onAbort);
    try { me.release?.(); } catch { /* released */ }
    if (active === me) { active = null; activeJournalPhase = null; }
  });
  return me.done;
}

/** 진행 중인 이동을 취소한다. 커밋 전이면 새 루트에 복사한 것만 지우고(옛 루트 하나가 남는다), 커밋 뒤이면 `already_committed`. */
export async function cancelAgentRootMove(): Promise<{ cancelled: boolean; code?: AgentRootRefusal }> {
  if (active) {
    active.abort = true;
    const outcome = await active.done;
    if (!outcome.ok && outcome.code === "cancelled") return { cancelled: true };
    return outcome.ok ? { cancelled: false, code: "already_committed" } : { cancelled: false, code: outcome.code };
  }
  const state = readJournal();
  if (state.state !== "journal") return { cancelled: false, code: "not_retained" };
  const journal = state.journal;
  if (journal.phase === "planned" || journal.phase === "copied") {
    if (journalOwnerBusy(journal)) return { cancelled: false, code: "move_in_progress" };
    rollbackCopy(journal);
    deleteJournal();
    return { cancelled: true };
  }
  // Audit 62 (first run B9): `committing` with the settings file still on the old root is before the commit point (the commit is the one settings write): it is cancelled like the earlier phases, not
  // answered `already_committed` (which was not true and left no way out). When the settings already name the new root it is past the point.
  if (journal.phase === "committing" && !sameFolderOrNull(settingsRootNow(), journal.to) && !(journal.mode === "rename" && !exists(journal.from))) {
    if (journalOwnerBusy(journal)) return { cancelled: false, code: "move_in_progress" };
    recoverAgentRootMove();
    return readJournal().state === "none" ? { cancelled: true } : { cancelled: false, code: "move_in_progress" };
  }
  return { cancelled: false, code: "already_committed" };
}

async function run(me: Active, p: Plan): Promise<AgentRootMoveOutcome> {
  const startedAt = new Date(d().now()).toISOString();
  const raw = readRawSettings();
  const journal: Journal = {
    schema: "agentlas.agents-root-move.v1", id: me.id, phase: "planned", mode: p.mode, from: p.from, to: p.to, realFrom: p.realFrom, realTo: p.realTo,
    createdRoot: p.createdRoot, names: p.mode === "copy" ? [...p.names] : [], previousSettings: raw.state === "text" ? raw.text : null, startedAt, pid: process.pid, host: os.hostname(),
  };
  // 새 루트에 아무것이든 만들기 전에 저널을 먼저 쓴다: 되돌림이 아무것도 모르는 채 만든 폴더를 남기지 않는다.
  writeJournal(journal);
  activeJournalPhase = "planned";
  fault("after-planned");
  const bail = (code: AgentRootRefusal, detail?: string): AgentRootMoveOutcome => { rollbackCopy(journal); deleteJournal(); return toOutcomeFailure(code, detail); };
  try {
    let verified: Snapshot | null = null;
    if (p.mode === "copy") {
      d().closeStoresUnder(p.from);
      fs.mkdirSync(p.to, { recursive: true });
      const copied = await copyUntilStable(me, p, journal);
      if (copied.code) return bail(copied.code, copied.detail);
      verified = copied.snap ?? null;
      journal.verifiedAt = new Date(copied.at ?? d().now()).toISOString();
      journal.phase = "copied";
      writeJournal(journal);
      activeJournalPhase = "copied";
      fault("after-copied");
    }
    if (me.abort) return bail("cancelled");
    return await commit(me, p, journal, verified);
  } catch (error) {
    if (error instanceof Cancelled) return bail("cancelled");
    // 설정 파일을 쓴 뒤의 예외는 앞으로 가야 한다(저널이 이미 `committing`/`committed` 이고 설정이 새 루트를 가리킨다 — 다음 시작이 마무리한다).
    const now = settingsRootNow();
    const state = readJournal();
    if (state.state === "journal" && (state.journal.phase === "committing" || state.journal.phase === "committed") && now !== null && sameFolder(now, journal.to)) return toOutcomeFailure("commit_failed", (error as NodeJS.ErrnoException)?.code ?? "after-commit");
    return bail("copy_failed", (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error)));
  }
}

async function copyUntilStable(me: Active, p: Plan, journal: Journal): Promise<{ code?: AgentRootRefusal; detail?: string; names: string[]; snap?: Snapshot; at?: number }> {
  const copied: Snapshot = new Map();
  let names = [...p.names];
  let yielded = 0;
  for (let pass = 1; pass <= MAX_CATCH_UP_PASSES; pass += 1) {
    me.progress.pass = pass;
    const passStartedAt = d().now();
    names = scanRoot(p.from).names; // 복사 중에 설치된 에이전트도, 지워진 에이전트도 이 패스가 본다
    const before = snapshotFolders(p.from, names);
    me.progress.filesTotal = before.snap.size;
    for (const key of [...copied.keys()]) if (!before.snap.has(key)) { removeCopied(p.to, key); copied.delete(key); } // 지워진 것은 새 쪽에서도 지운다
    const union = [...new Set([...journal.names, ...names])]; // 새로 생긴 이름도 되돌림이 알아야 한다(폴더를 만들기 전에 저널에 먼저)
    if (union.length !== journal.names.length) { journal.names = union; writeJournal(journal); }
    let vanished = false;
    for (const [key, entry] of before.snap) {
      if (me.abort) throw new Cancelled();
      if (sameEntry(copied.get(key), entry)) continue;
      journalHeartbeat();   // before the copy too: a big file keeps this process busy for a while, and the beat before it is the one that carries it
      try { copyEntry(p.from, p.to, key, entry); } catch (error) {
        // 복사하는 동안 원본이 사라졌다(다른 프로세스가 쓰는 SQLite 의 `-wal` 이 마지막 연결이 닫힐 때 지워진다): 실패가 아니라 "바뀜"이다. 새 쪽에 남은 반쪽은 지우고(낡은 `-wal` 이 새 본 파일에 덧씌워지지 않게)
        // 이 항목은 건너뛰며, 패스는 바뀐 것으로 보아 다음 패스가 그 시점의 모양으로 다시 복사한다.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && entry.kind !== "d" && !exists(path.join(p.from, ...key.split("/")))) { removeCopied(p.to, key); copied.delete(key); vanished = true; continue; }
        return { code: "copy_failed", detail: (error as NodeJS.ErrnoException).code ?? "copy", names };
      }
      journalHeartbeat();
      copied.set(key, entry);
      me.progress.files += 1; me.progress.bytes += entry.kind === "f" ? entry.size : 0;
      yielded += 1;
      if (yielded % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      fault("copy-file");
    }
    const after = snapshotFolders(p.from, names);
    // 복사하는 동안 바뀌었다: 잠깐 쉬고(쓰는 쪽이 한 번 쓰고 조용해지는 창을 기다린다 — 끝없이 되풀이하지 않는다: 패스 상한 MAX_CATCH_UP_PASSES, 넘으면 `source_changing`) 다음 패스가 바뀐 것만 다시 복사한다.
    if (vanished || !sameSnapshot(before.snap, after.snap)) { await d().sleep(Math.min(60 * pass, 300)); continue; }
    const bad = verifyCopy(p.from, p.to, after.snap); // 안정됐다: 복사본이 이 지문의 상태와 같은지(크기·해시)
    if (bad?.startsWith("changed:")) { await d().sleep(Math.min(60 * pass, 300)); continue; } // 확인 중 원본이 바뀌었다: 복사본은 멀쩡하다, 다음 패스가 다시 본다
    if (bad) { copied.clear(); if (pass === MAX_CATCH_UP_PASSES) return { code: "verify_failed", detail: bad, names }; continue; } // 한 번은 디스크가 거짓말한 것일 수 있다: 처음부터 다시
    return { names, snap: after.snap, at: passStartedAt };
  }
  return { code: "source_changing", names };
}

async function commit(me: Active, p: Plan, journal: Journal, verified: Snapshot | null): Promise<AgentRootMoveOutcome> {
  // 에이전트 쓰기 잠금 아래서 마지막으로 본다. 잠금이 안 잡히거나(다른 변경이 에이전트를 만지는 중) 그 사이 바뀌었으면 조금 기다렸다 다시 한다.
  let lastCode: AgentRootRefusal = "agent_busy";
  let lastDetail: string | undefined;
  let proof = verified;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (me.abort) throw new Cancelled();
    if (attempt > 0) await d().sleep(120);
    d().closeStoresUnder(p.from); // 닫을 때 로그가 본 파일에 반영될 수 있다: 잠금 *앞*에서 닫아 아래의 마지막 비교가 그 결과를 본다
    // 잠금 *앞*에서 할 수 있는 것은 다 한다(잠금은 에이전트마다 파일 하나라 오래 쥘수록 다른 프로세스의 턴 시작이 `update_busy` 를 만날 수 있다).
    const scan = scanRoot(p.from);
    const top = listTop(p.from);
    let outcome: AgentRootMoveOutcome | "retry" | "recopy" = "retry";
    const held = d().withLocks(scan.ids, (): AgentRootMoveOutcome | "retry" | "recopy" => {
      const lockedAt = d().now(); // 마지막 비교가 시작된 시각: 비교하는 동안(수 ms) 옛 루트에 쓰인 것은 복사본에 없을 수 있다 — 정리 단계의 "늦게 쓰인 것"은 이 시각 뒤다
      if (d().installOpen()) { lastCode = "install_in_progress"; return "retry"; }
      if (d().memoryMoveActive()) { lastCode = "memory_move_active"; return "retry"; }
      if (listTop(p.from).join("\0") !== top.join("\0")) { lastCode = "source_changing"; return "retry"; } // 루트에 폴더가 생겼거나 사라졌다
      { const blocker = firstBlocker(p.from, scan.names); if (blocker) { lastCode = "agent_running"; lastDetail = `${lastBlockerId ?? "agent"}:${String(blocker).slice(0, 64)}`; return "retry"; } }
      if (journal.mode === "copy") {
        const now = snapshotFolders(p.from, scan.names);
        if (!proof || scan.names.length !== journal.names.length || scan.names.some((name) => !journal.names.includes(name)) || !sameSnapshot(now.snap, proof)) return "recopy";
      } else if (!scan.allAppOwned || !isDirNoLink(p.from) || exists(p.to)) { lastCode = "source_changing"; return "retry"; }
      journal.phase = "committing";
      journal.committedAt = new Date(lockedAt).toISOString(); // 이 시각 뒤에 옛 루트에 쓰인 것만 "늦게 쓰인 것"이다(정리 단계가 읽는다)
      writeJournal(journal);
      activeJournalPhase = "committing";
      fault("before-commit");
      if (me.abort) throw new Cancelled(); // 취소가 설정 파일을 쓰기 직전까지는 먹힌다(잠금은 finally 가 놓고, 저널은 되돌림이 지운다)
      if (journal.mode === "rename") { try { fs.mkdirSync(path.dirname(p.to), { recursive: true }); } catch { /* the rename below reports it */ } }
      writeSettingsRoot(p.to); // ★ 커밋 시점: 이 교체 한 번 뒤로는 모든 프로세스가 새 루트를 본다(rename 형은 곧바로 아래 rename — 사이의 밀리초는 "쓸 수 없음"으로 물러난다)
      fault("after-json");
      if (journal.mode === "rename") {
        try { fs.renameSync(p.from, p.to); } catch (error) {
          try { restoreSettings(journal.previousSettings); } catch { /* 다음 시작의 복구가 다시 한다 */ }
          rollbackCopy(journal); // 이 이동이 만든 빈 폴더만 지운다
          deleteJournal();
          return toOutcomeFailure("rename_failed", (error as NodeJS.ErrnoException).code ?? "rename");
        }
        fault("after-rename");
      }
      journal.phase = "committed";
      // (`committedAt` stays what the lock set above: the moment of the last comparison. Writing the time of this line over it lost the lines the old root took in between: defect 12.)
      if (journal.mode === "copy") journal.retireAfter = new Date(d().now() + RETAIN_MS).toISOString();
      writeJournal(journal);
      activeJournalPhase = "committed";
      fault("after-committed");
      return { ok: true, state: "committed", mode: journal.mode, from: p.from, to: p.to, folders: scan.names.length, bytes: p.bytes, passes: me.progress.pass, ...(journal.retireAfter ? { retireAfter: journal.retireAfter } : {}) };
    });
    if (held && typeof held === "object" && "busy" in held) { lastCode = "agent_busy"; outcome = "retry"; } else outcome = held as AgentRootMoveOutcome | "retry" | "recopy";
    if (outcome === "recopy") { // 마지막 비교에서 달라졌다: 잠금을 놓고 한 번 더 따라잡는다.
      lastCode = "source_changing"; // 8번 모두 이렇게 끝나면 이유는 "원본이 계속 바뀐다"이다(`agent_busy` 는 잠금을 못 잡았을 때만)
      const again = await copyUntilStable(me, p, journal);
      if (again.code) { rollbackCopy(journal); deleteJournal(); return toOutcomeFailure(again.code, again.detail); }
      proof = again.snap ?? null;
      journal.verifiedAt = new Date(again.at ?? d().now()).toISOString();
      continue;
    }
    if (outcome === "retry") continue;
    if (!outcome.ok) return outcome;
    const finished = finishCommitted(journal); // 마무리(라우트·변경안 경로)는 다시 불러도 안전하다 — 실패하면 다음 시작이 마친다
    return finished ? outcome : { ...outcome, finishPending: true };
  }
  rollbackCopy(journal); deleteJournal();
  return toOutcomeFailure(lastCode, (lastCode as AgentRootRefusal) === "agent_running" ? lastDetail : undefined);
}

// ───────────────────────────── 커밋 뒤 마무리 ─────────────────────────────

/** 라우트·워크스페이스 변경안·엔진 표식을 새 루트로 맞춘다. 모두 다시 불러도 안전하다. rename 형은 저널까지 지운다. 끝났으면 true. */
function finishCommitted(journal: Journal): boolean {
  invalidateOwnerIndex();
  try {
    d().rebindRoutes(journal.from, journal.to);
    if (journal.realFrom !== journal.from) d().rebindRoutes(journal.realFrom, journal.realTo);
    const names = journal.mode === "rename" ? scanRoot(journal.to).names : journal.names;
    for (const name of names) {
      const folder = path.join(journal.to, name);
      for (const id of ownerIds(folder)) {
        try { d().rebindWorkspaceRoot(id, path.join(journal.realFrom, name), path.join(journal.realTo, name)); } catch { /* 변경안 하나를 못 바꿔도 이동은 끝났다 */ }
        if (journal.mode === "rename") { /* 원본이 사라졌으니 엔진이 "옮겨 왔다"고 알아볼 수 있다 */ }
      }
    }
    if (journal.mode === "rename") {
      markMovedForEngine(journal, names);
      deleteJournal();
    } else {
      // 이전 루트의 폴더는 소유 표식을 숨긴다: 설정된 루트가 빠졌을 때 읽는 쪽이 기본 루트로 내려앉아 *낡은* 사본(잊은 글이 남아 있을 수 있다)을 읽거나, 이미 새 루트를 가리키는
      // 훅이 옛 폴더를 찾지 못한다. 표식이 있어야 앱이 에이전트 폴더로 알아보므로(`ownerIds`), 이름을 바꾸는 것만으로 옛 사본은 앱에서 보이지 않는다. 지울 때는 이 이름을 본다.
      if (!hideOwnerMarkers(journal)) return false; // 표식을 하나라도 못 숨겼다(Windows: 다른 프로세스가 열고 있다): 마무리하지 않는다 — 다음 시작이 다시 한다
      journal.finished = true;
      writeJournal(journal);
    }
    return true;
  } catch { return false; }
}

function retiredMarkerName(journal: Journal): string { return `owner.json.moved-${journal.id}`; }
function hideOwnerMarkers(journal: Journal): boolean {
  let all = true;
  for (const name of journal.names) {
    const state = path.join(journal.from, name, AGENT_LOCAL_STATE_FOLDER);
    const marker = path.join(state, "owner.json"), hidden = path.join(state, retiredMarkerName(journal));
    try { if (exists(marker) && !exists(hidden)) fs.renameSync(marker, hidden); } catch { all = false; /* 표식을 못 숨겨도 이동은 끝났다: 다음 시작이 다시 한다 */ }
  }
  return all;
}
/** 이 이동이 복사해 간 에이전트 폴더인가(표식이 아직 있거나 숨겨졌다). */
function isMovedAppFolder(folder: string, journal: Journal): boolean {
  return isDirNoLink(folder) && (ownerIds(folder).length > 0 || exists(path.join(folder, AGENT_LOCAL_STATE_FOLDER, retiredMarkerName(journal))));
}

/** 엔진 레지스트리에 새 자리를 알리도록 `origin.json` 에 옮김 표식을 남긴다(`syncMovedFoldersWithEngine` 이 시작 때 읽는다 — 엔진은 옛 폴더가 사라진 뒤에만 옮김으로 알아본다). */
function markMovedForEngine(journal: Journal, names: readonly string[]): void {
  for (const name of names) {
    const folder = path.join(journal.to, name);
    if (!exists(path.join(folder, ".agentlas", "routing-card.json")) && !exists(path.join(folder, "agentlas.json"))) continue;
    try {
      const state = path.join(folder, AGENT_LOCAL_STATE_FOLDER);
      const originFile = path.join(state, "origin.json");
      let current: Record<string, unknown> = {};
      try { const parsed = JSON.parse(fs.readFileSync(originFile, "utf8").replace(/^﻿/, "")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>; } catch { /* 없다 */ }
      writeFileDurable(originFile, JSON.stringify({ schema: 1, ...current, kind: "moved", from: path.join(journal.from, name), realFrom: path.join(journal.realFrom, name), at: new Date(d().now()).toISOString(), engine: "pending" }) + "\n");
    } catch { /* 표식이 없으면 엔진이 다음 가져오기에서 알아본다 */ }
  }
}

// ───────────────────────────── 시작 복구 ─────────────────────────────

let recoveredState: { journal: boolean } | null = null;

export type RecoverResult = "none" | "in-progress-elsewhere" | "rolled-back" | "completed" | "retained" | "unreadable" | "needs-review";

/**
 * 시작할 때(창이 뜨기 전, 소유자 역할만) 저널을 본다 — 동기, 저널이 없으면 파일 하나를 읽고 끝난다.
 *  - 설정 파일을 쓰기 전(`planned`·`copied`·`committing` 의 앞부분)이면 되돌린다: 복사한 폴더를 지우고 저널을 지운다(읽을 수 있는 쪽은 옛 루트).
 *  - 설정 파일을 쓴 뒤(`committing` 의 나머지·`committed`)이면 앞으로 간다: rename 형이면 rename 을 마치고, 마무리(라우트 등)를 다시 한다.
 * 이 프로세스가 쓴 저널이거나 쓴 프로세스가 아직 살아 있으면 건드리지 않는다. 던지지 않는다.
 */
export function recoverAgentRootMove(): RecoverResult {
  const result = recoverAgentRootMoveOnce();
  lastRecovery = result;
  return result;
}
function recoverAgentRootMoveOnce(): RecoverResult {
  try {
    const state = readJournal();
    if (state.state === "none") { recoveredState = { journal: false }; return "none"; }
    recoveredState = { journal: true };
    if (state.state === "unreadable") return "unreadable";
    const journal = state.journal;
    if (active) return "in-progress-elsewhere";
    if (journal.phase !== "committed" && journalOwnerBusy(journal)) return "in-progress-elsewhere";
    const settingsPointsToTarget = (() => { const now = settingsRootNow(); return now !== null && sameFolder(now, journal.to); })();
    if (journal.phase === "committed") {
      if (journal.finished !== true || journal.mode === "rename") finishCommitted(journal);
      return journal.mode === "rename" ? "completed" : "retained";
    }
    if (journal.phase === "planned" || journal.phase === "copied" || !settingsPointsToTarget) {
      if (journal.mode === "rename" && journal.phase === "committing" && !settingsPointsToTarget && !exists(journal.from) && isDirNoLink(journal.to)) {
        // 설정을 쓰기 전에 rename 이 끝났을 수는 없지만(순서), 만약 그렇다면 데이터는 새 자리에 있다: 앞으로 간다.
        writeSettingsRoot(journal.to);
      } else {
        // rename 형은 이 단계까지 파일을 옮기지 않았다. 복사형은 복사본만 지운다.
        if (journal.mode === "rename" && journal.phase === "committing" && exists(journal.from) && !exists(journal.to)) { try { restoreSettings(journal.previousSettings); } catch { /* 다음에 */ } }
        if (settingsPointsToTarget) { try { restoreSettings(journal.previousSettings); } catch { return "needs-review"; } } // 아직 커밋 전인데 설정이 새 루트를 가리킨다: 옛 루트를 읽게 되돌린다
        rollbackCopy(journal);
        deleteJournal();
        return "rolled-back";
      }
    }
    // 설정 파일이 새 루트를 가리킨다: 앞으로.
    if (journal.mode === "rename") {
      if (!isDirNoLink(journal.to) && isDirNoLink(journal.from)) {
        try { fs.renameSync(journal.from, journal.to); } catch { return "needs-review"; } // 설정은 새 루트를 가리키고 데이터는 옛 자리: 읽는 쪽은 "쓸 수 없음"으로 물러나 있다 — 다음 시작이 다시 한다
      } else if (isDirNoLink(journal.from) && isDirNoLink(journal.to)) return "needs-review"; // 둘 다 있다: 사람이 본다(어느 쪽도 지우지 않는다)
    } else if (journal.names.some((name) => !isDirNoLink(path.join(journal.to, name)))) {
      // 복사형인데 새 쪽에 빠진 폴더가 있다: 설정만 되돌려 옛 루트를 읽게 한다.
      try { restoreSettings(journal.previousSettings); } catch { return "needs-review"; }
      rollbackCopy(journal); deleteJournal();
      return "rolled-back";
    }
    journal.phase = "committed";
    journal.committedAt = journal.committedAt ?? new Date(d().now()).toISOString();
    if (journal.mode === "copy" && !journal.retireAfter) journal.retireAfter = new Date(d().now() + RETAIN_MS).toISOString();
    writeJournal(journal);
    finishCommitted(journal);
    return journal.mode === "rename" ? "completed" : "retained";
  } catch { return "unreadable"; }
}

// ───────────────────────────── 이전 루트 정리 ─────────────────────────────

export interface RetireResult {
  ok: boolean; code?: AgentRootRefusal; removed?: number; blocked?: string; merged?: number;
  /** 합치지 않고 버린 것의 기계 코드별 개수(`derived_after_commit` 파생 파일 · `parent_missing` 새 쪽에서 폴더째 지워진 곳의 파일 · `store_missing` 새 쪽에서 지워진 저장소). 없으면 생략. */
  dropped?: Record<string, number>;
}

/** 다시 만들 수 있는 파생물: 검색 색인과 옛 `MEMORY.md`. 옛 루트에서 가져오지 않는다 — 새 루트에서 다시 만들어지고, 옛 것에는 새 쪽에서 잊은 글이 남아 있을 수 있다. */
const DERIVED_NAME = /^(?:recall-index\.sqlite(?:-wal|-shm|-journal)?|MEMORY\.md|\.MEMORY\.md\..*\.tmp)$/;

function newestWrite(file: string): number {
  let newest = 0;
  for (const candidate of [file, `${file}-wal`]) { try { newest = Math.max(newest, fs.statSync(candidate).mtimeMs); } catch { /* 없다 */ } }
  return newest;
}
function unlinkQuiet(file: string): void { try { fs.unlinkSync(file); } catch { /* 다음 정리가 폴더째 지운다 */ } }

/**
 * 옛 폴더에서 새 폴더로 합치는 것은 "새 루트에 없고, 새 루트에서 그 뒤로 지워진 적도 없는 것"뿐이다 — 이동이 확정된 시각(`since`) 뒤에 옛 루트에 새로 쓰인 것:
 *  - 저장소: 그 시각 뒤에 *만들어진* 항목만(`created_at`). 그 전의 항목은 이미 새 쪽에 복사됐거나 새 쪽에서 지워졌다(잊기는 같은 id 를 빈 채로 남기고, 프로젝트 삭제는 행을 지운다). 새 쪽에 저장소가 없으면 가져오지 않는다(지운 계정).
 *  - 파일: 새 쪽에 폴더가 있고 파일이 없으며 수정 시각이 그 뒤일 때만 복사한다. 새 쪽에 폴더가 없으면(계정 삭제·되돌린 스킬 폴더) 가져오지 않는다. 파생물은 가져오지 않는다.
 *  - 지울 수 없는 근거(새 쪽에서 지웠는지)가 없는 것은 가져오지 않는다 — 늦게 쓰인 한두 줄을 잃는 쪽이 지운 글이 돌아오는 쪽보다 낫다. 버린 것은 코드로 센다.
 * 합친(또는 버린 것으로 판정한) 옛 파일은 바로 지운다: 정리가 도중에 죽어 다시 돌아도 새 쪽에서 지운 것이 같은 줄로 다시 들어오지 않는다. 합친 수 / 못 합친 이유(있으면) / 버린 것.
 */
function sweepLateWrites(oldFolder: string, newFolder: string, since: number, stamp: string): { merged: number; blocked: string | null; dropped: Record<string, number> } {
  let merged = 0;
  let blocked: string | null = null;
  const dropped: Record<string, number> = {};
  const note = (code: string): void => { dropped[code] = (dropped[code] ?? 0) + 1; };
  // 경계는 확정 시각을 *초 단위로 내린* 값이다: 엔진은 `created_at` 을 초 단위로 찍으므로 같은 초에 만들어진 항목은 "그 뒤"로 읽는다(이미 새 쪽에 있으면 `INSERT OR IGNORE` 가 무시한다).
  // 예전의 5초 여유는 사라진 줄의 원인(`committedAt` 덮어쓰기)을 가리느라 있었고, 그 5초 안에서 지운 프로젝트 줄을 되살렸다(결함 12).
  const sinceIso = new Date(Math.floor(since / 1000) * 1000 - 1).toISOString(); // (the merge compares with `>`: one millisecond before the second, so a line of that second is "after")
  const visit = (dir: string, rel: string): void => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (SKIP_NAME.test(name) || /-wal$|-journal$/.test(name)) { if (!DERIVED_NAME.test(name)) continue; }
      const full = path.join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.isDirectory() && !stat.isSymbolicLink()) { visit(full, key); continue; }
      if (!stat.isFile()) continue;
      const dest = path.join(newFolder, ...key.split("/"));
      const isStore = name === "memory.sqlite";
      if (DERIVED_NAME.test(name)) { if (stat.mtimeMs > since) note("derived_after_commit"); continue; }
      const lastWrite = isStore ? newestWrite(full) : stat.mtimeMs;
      if (lastWrite <= (isStore ? since - 7000 : since)) continue; // 저장소는 항목의 `created_at` 이 판정이다 — 파일 시각은 거르는 데만 쓴다
      if (!isDir(path.dirname(dest))) { note("parent_missing"); continue; } // 새 쪽에서 폴더째 지워졌다(계정 삭제·되돌린 스킬): 되살리지 않는다
      if (isStore) {
        if (!exists(dest)) { note("store_missing"); continue; }
        const result = d().mergeStore(full, dest, sinceIso);
        if (result.status === "merged") {
          if (result.inserted > 0) { merged += 1; dropRecallIndex(path.dirname(dest)); } // 새 항목이 들어갔다: 새 쪽의 검색 색인은 다시 만든다
          for (const suffix of ["", "-wal", "-shm", "-journal"]) unlinkQuiet(full + suffix);
        } else blocked = blocked ?? `memory-${result.status}`;
        continue;
      }
      try {
        if (!exists(dest)) { fs.copyFileSync(full, dest); merged += 1; unlinkQuiet(full); continue; }
        if (hashFile(full) === hashFile(dest)) { unlinkQuiet(full); continue; }
        // 두 쪽이 다르다: 어느 쪽이 맞는지 모른다 — 옛 쪽을 지우지 않고 새 폴더의 보존 폴더(`absorbed-*`, 30일 뒤 기존 규칙이 지운다)에 둔다.
        const keep = path.join(newFolder, AGENT_LOCAL_STATE_FOLDER, `absorbed-${stamp}`, ...key.split("/"));
        fs.mkdirSync(path.dirname(keep), { recursive: true });
        fs.copyFileSync(full, keep);
        merged += 1;
        unlinkQuiet(full);
      } catch { blocked = blocked ?? "copy-file"; }
    }
  };
  visit(oldFolder, "");
  return { merged, blocked, dropped };
}

let retiring: Promise<RetireResult> | null = null;
/**
 * 복사형 이동 뒤 남긴 이전 루트를 정리한다. `force` 가 아니면 보존 기간(14일)이 지난 뒤에만 한다. 늦게 쓰인 기억·파일을 새 폴더에 합친 뒤(`sweepLateWrites`: 새 쪽에서 지워진 것은 되살리지 않는다) 이 이동이 복사한 에이전트
 * 폴더(소유 표식이 있는 것)와 앱이 만든 이름만 지운다. 합치지 못한 것이 있으면 지우지 않는다(저널의 `blocked`). 사용자 소유 항목이 있으면 루트 폴더는 남긴다. 던지지 않는다. 동시에 둘이 불러도 한 번만 돈다.
 */
export function retireOldAgentRoot(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<RetireResult> {
  if (retiring) return retiring;
  const run = retireOldAgentRootOnce(options).finally(() => { if (retiring === run) retiring = null; });
  retiring = run;
  return run;
}

async function retireOldAgentRootOnce(options: { force?: boolean; signal?: AbortSignal }): Promise<RetireResult> {
  try {
    const state = readJournal();
    if (state.state !== "journal" || state.journal.phase !== "committed" || state.journal.mode !== "copy") return { ok: false, code: "not_retained" };
    const journal = state.journal;
    const now = d().now();
    if (!options.force && now < Date.parse(journal.retireAfter ?? "")) return { ok: false, code: "retire_not_due" };
    if (active) return { ok: false, code: "move_in_progress" };
    // 이전 루트가 지금 읽히는 루트이면(사용자가 설정을 되돌렸다) 지우지 않는다 — 저널만 닫는다.
    const current = agentHomeRootStatus();
    if (current.path && (sameFolder(current.path, journal.from) || insideOrSame(current.path, journal.from) || insideOrSame(journal.from, current.path))) { deleteJournal(); return { ok: false, code: "retire_blocked", blocked: "old-root-is-current" }; }
    if (!isDir(journal.from)) { deleteJournal(); return { ok: true, removed: 0 }; }
    // 새 루트가 지금 안 보이면(드라이브가 빠졌다) 합칠 수 없다: 지우지 않는다.
    // Audit 62 (first run B2, D6): the reason is written into the journal so the status says it (`retained.blocked`), and the wait has the same 90-day end as an unmergeable store: past it the journal is
    // closed and the old folders stay where they are (nothing is deleted). A drive that comes back under another path is reconnected (`noteAgentRootReconnected` moves the journal's target with it).
    if (!isDir(journal.to)) {
      const waited = now - (Date.parse(journal.retireAfter ?? "") || now);
      if (waited > RETAIN_BLOCKED_MAX_MS) { deleteJournal(); return { ok: false, code: "retire_blocked", blocked: "new-root-unavailable" }; }
      if (journal.blocked !== "new-root-unavailable") writeJournal({ ...journal, blocked: "new-root-unavailable" });
      return { ok: false, code: "retire_blocked", blocked: "new-root-unavailable" };
    }
    // 이 시각 뒤에 쓰인 옛 항목·파일만 합친다. 커밋 시작 시각이 없는 옛 저널은 마지막으로 안정된 복사 패스의 시작 시각을 쓴다.
    const since = Date.parse(journal.committedAt ?? "") || Date.parse(journal.verifiedAt ?? "") || now;
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    let merged = 0;
    let blocked: string | null = null;
    const dropped: Record<string, number> = {};
    // 커밋 뒤 옛 루트에서 설치가 끝난 에이전트(옛 루트를 푼 채 있던 설치 프로세스): 이동 때 없던 이름이라 새 쪽에서 지워졌을 수 없다 — 새 루트로 옮겨 오고 저널의 이름에 넣어 아래에서 함께 정리한다.
    try {
      for (const name of scanRoot(journal.from).names) {
        if (exists(path.join(journal.to, name))) continue;
        if (!journal.names.includes(name)) { journal.names.push(name); writeJournal(journal); }
        const temp = path.join(journal.to, `.agentlas-root-tmp-${name}`); // 반쯤 복사된 폴더가 에이전트 폴더로 보이지 않게 앱 이름으로 복사한 뒤 rename 한다
        fs.rmSync(temp, { recursive: true, force: true });
        fs.cpSync(path.join(journal.from, name), temp, { recursive: true });
        fs.renameSync(temp, path.join(journal.to, name));
        merged += 1;
      }
    } catch { blocked = blocked ?? "adopt-late-agent"; }
    for (const name of journal.names) {
      if (options.signal?.aborted) return { ok: false, code: "cancelled" };
      const oldFolder = path.join(journal.from, name), newFolder = path.join(journal.to, name);
      if (!isDirNoLink(oldFolder)) continue;
      if (!isDirNoLink(newFolder)) continue; // 새 쪽에서 지워진 에이전트(삭제·잊기): 옛 사본도 함께 정리한다
      const swept = sweepLateWrites(oldFolder, newFolder, since, stamp);
      merged += swept.merged;
      for (const [code, n] of Object.entries(swept.dropped)) dropped[code] = (dropped[code] ?? 0) + n;
      if (swept.blocked) blocked = blocked ?? swept.blocked;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const droppedView = Object.keys(dropped).length ? { dropped } : {};
    if (droppedView.dropped) console.info(`[agent-root] retire left behind: ${JSON.stringify(dropped)}`);
    if (blocked) {
      const age = now - (Date.parse(journal.retireAfter ?? "") || now);
      if (age > RETAIN_BLOCKED_MAX_MS) { deleteJournal(); return { ok: false, code: "retire_blocked", blocked, merged, ...droppedView }; }
      writeJournal({ ...journal, blocked });
      return { ok: false, code: "retire_blocked", blocked, merged, ...droppedView };
    }
    let removed = 0;
    for (const name of journal.names) {
      const oldFolder = path.join(journal.from, name);
      // 지우기 직전 소유 판정: 폴더·링크가 아니고 앱의 소유 표식이 있다.
      if (isMovedAppFolder(oldFolder, journal)) {
        d().closeStoresUnder(oldFolder);
        // 이름을 먼저 앱이 만든 이름으로 바꾼다(같은 폴더 안의 rename 한 번 = 원자적): 지우다 죽어도 반쯤 지워진 폴더가 "소유 표식이 없는 사용자 폴더"처럼 남아 영영 안 지워지지 않는다 — 다음 정리가 `.pre-home-*` 로 알아보고 마저 지운다.
        let target = oldFolder;
        try { const aside = path.join(journal.from, `.pre-home-retire-${journal.id.slice(0, 8)}-${name}`); fs.renameSync(oldFolder, aside); target = aside; } catch { /* 열린 핸들 등: 제자리에서 지운다 */ }
        fs.rmSync(target, { recursive: true, force: true }); removed += 1; fault("retire-folder");
      }
    }
    let leftover: string[] = [];
    try { leftover = fs.readdirSync(journal.from); } catch { /* gone */ }
    for (const name of leftover) if (APP_NOISE_NAME.test(name)) { try { fs.rmSync(path.join(journal.from, name), { recursive: true, force: true }); } catch { /* the next pass */ } }
    try { fs.rmdirSync(journal.from); } catch { /* 사용자 소유 항목이 남았다: 루트는 남긴다 */ }
    markMovedForEngine({ ...journal, mode: "rename" }, journal.names.filter((name) => isDirNoLink(path.join(journal.to, name))));
    deleteJournal();
    return { ok: true, removed, merged, ...droppedView };
  } catch { return { ok: false, code: "retire_blocked", blocked: "unexpected" }; }
}

/**
 * 잊기·프로젝트 삭제·계정 삭제·에이전트 삭제 앞뒤에 부른다: 보존된 이전 루트(복사형 이동 뒤 14일)가 있으면 지금 정리한다 — 그 안의 사본에는 지운 글이 그대로 있고(`-wal` 포함),
 * 보존본이 없으면 저널 파일 하나를 읽고 끝난다(시작 복구가 "저널 없음"을 이미 봤으면 그것도 읽지 않는다). 정리는 새 쪽에서 지워진 것을 되살리지 않으므로(`sweepLateWrites`) 지우기 앞에 불러도 뒤에 불러도 안전하다.
 * 정리가 막히면(새 루트가 안 보임·합치지 못한 저장소) 지우기 자체는 이미 성공한 것이고, 보존본은 나중 정리 때 새 쪽에서 지운 것을 가져오지 않는다. 던지지 않는다.
 */
export function retireRetainedRootAfterErase(): Promise<RetireResult | null> {
  try {
    if (!rootMoveRetirementMayBeDue()) return Promise.resolve(null);
    const state = readJournal();
    if (state.state !== "journal" || state.journal.phase !== "committed" || state.journal.mode !== "copy") return Promise.resolve(null);
    return retireOldAgentRoot({ force: true }).then((result) => { if (!result.ok && result.code === "retire_blocked") console.warn(`[agent-root] retained root not cleared after an erase: ${result.blocked ?? "blocked"}`); return result; }, () => null);
  } catch { return Promise.resolve(null); }
}

/**
 * Audit 62 (first run B2): the root was reconnected to `root` (the drive came back under another path, or the folder was renamed). A retained move (committed) points its target at the root that is
 * read now, so the retirement merges the late writes into the root in use instead of waiting for a path that is gone, and its blocked mark is cleared. An open move is left alone (a reconnect is
 * refused while one runs). Nothing is deleted.
 */
export function noteAgentRootReconnected(root: string): void {
  try {
    const state = readJournal();
    if (state.state !== "journal" || state.journal.phase !== "committed" || state.journal.mode !== "copy") return;
    const journal = state.journal;
    if (sameFolder(journal.to, root) && !journal.blocked) return;
    writeJournal({ ...journal, to: path.resolve(root), realTo: realOrAncestor(root), blocked: undefined });
  } catch { /* the journal stays as it was; the retirement still waits for its end */ }
}

/** What the start (or the first question that found a dead writer) did with an interrupted move, for the status (first run, section 6.5 item 7). In memory; a restart reads the journal again. */
let lastRecovery: RecoverResult | null = null;

/**
 * Audit 62 (first run B10): the two ways out of a journal that no code can settle. Both delete nothing but the journal (the old folders and the new folders are the owner's data, kept as they are).
 *  - `keep_old`: the old root is the root (the settings file goes back to what it was before the move), the journal is closed; a folder the move made at the new place stays.
 *  - `keep_new`: the new root is the root (the settings file names it), the journal is closed; the old folders stay.
 * Only for a journal that is not being written (no live writer) and that is open or marked for review.
 */
export function settleAgentRootMove(choice: unknown): { ok: boolean; code?: AgentRootRefusal } {
  if (choice !== "keep_old" && choice !== "keep_new") return { ok: false, code: "target_invalid" };
  if (active) return { ok: false, code: "move_in_progress" };
  const state = readJournal();
  if (state.state !== "journal") return { ok: false, code: "not_retained" };
  const journal = state.journal;
  if (journal.phase === "committed" && journal.finished === true) return { ok: false, code: "already_committed" };
  if (journalOwnerBusy(journal)) return { ok: false, code: "move_in_progress" };
  // Desktop repair 6: `keep_new` makes the new root THE root, so it must be a folder; naming a missing one would leave every agent without its memory. Nothing is written then.
  if (choice === "keep_new" && !isDirNoLink(journal.to)) return { ok: false, code: "target_invalid" };
  try {
    if (choice === "keep_old") restoreSettings(journal.previousSettings);
    else writeSettingsRoot(journal.to);
    deleteJournal();
    lastRecovery = null;
    return { ok: true };
  } catch { return { ok: false, code: "commit_failed" }; }
}

/** Audit 62 (first run B10): a journal this build cannot read is put aside (renamed, never deleted) so it stops blocking; the owner keeps the file. */
export function setAsideUnreadableRootMoveJournal(): { ok: boolean; code?: AgentRootRefusal; asideName?: string } {
  if (active) return { ok: false, code: "move_in_progress" };
  if (readJournal().state !== "unreadable") return { ok: false, code: "not_retained" };
  try {
    const asideName = `${ROOT_MOVE_JOURNAL}.unreadable-${new Date(d().now()).toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(journalFile(), path.join(agentlasHomeDir(), asideName));
    fsyncDirectory(agentlasHomeDir());
    recoveredState = { journal: false };
    lastRecovery = null;
    return { ok: true, asideName };
  } catch { return { ok: false, code: "commit_failed" }; }
}

// ───────────────────────────── 상태 ─────────────────────────────

/** 화면이 읽는 상태. 파일 하나를 읽는다(이 프로세스가 이동 중이면 그 진행도 함께). */
export function getAgentRootMoveStatus(): AgentRootStatusView {
  healDeadWriterJournal();   // (first run B8): a screen that asks settles an interrupted move whose writer is gone before it reports the root
  const status = agentHomeRootStatus();
  const root: AgentRootStatusView["root"] = { path: status.path, configured: status.configured, available: status.available, ...(status.available ? {} : { reason: status.reason }) };
  const view: AgentRootStatusView = { root, move: { phase: "idle" } };
  const state = readJournal();
  if (state.state === "unreadable") { view.move.unreadable = true; return view; }
  if (lastRecovery === "needs-review" || lastRecovery === "in-progress-elsewhere") view.move.recovery = lastRecovery;
  if (active) { view.move.phase = activeJournalPhase ?? "planned"; view.move.progress = { ...active.progress }; }
  if (state.state === "journal") {
    const journal = state.journal;
    view.move = { ...view.move, phase: journal.phase, mode: journal.mode, from: journal.from, to: journal.to };
    if (journal.phase === "committed" && journal.mode === "copy") view.move.retained = { path: journal.from, retireAfter: journal.retireAfter ?? "", ...(journal.blocked ? { blocked: journal.blocked } : {}) };
  }
  return view;
}

/** 저널을 다시 읽지 않아도 되는가(시작 복구가 "저널 없음"을 이미 봤다). 한 번도 이동하지 않은 사용자의 시작 비용을 늘리지 않으려는 것이다. */
export function rootMoveJournalKnownAbsent(): boolean { return recoveredState !== null && recoveredState.journal === false; }

/** 이 프로세스가 `retireOldAgentRoot` 를 시도해 볼 만한가(저널이 있을 때만). */
export function rootMoveRetirementMayBeDue(): boolean { return recoveredState === null || recoveredState.journal === true; }

/** 시험: 모듈 상태를 비운다. */
export function resetRootMoveForTests(): void { active = null; activeJournalPhase = null; recoveredState = null; faultHook = null; deps = null; lastRecovery = null; lastHeartbeatAt = 0; }
