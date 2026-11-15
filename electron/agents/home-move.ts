// 에이전트 폴더를 `~/.agentlas/agents/<이름>/` 으로 옮긴다.
//
// ★ 옮기는 것은 *앱이 만든* 폴더다(`classifyAgentFolder`, home.ts): `userData/agents/<slug>`(3파일 스텁, 엔진이 가져온 패키지, Agent Cloud·Hub 가 설치한
//   패키지, 사진이 든 폴더), 앱이 프로젝트 없이 만든 팀(`userData/generated-agent-os/…`), `~/.agentlas/agentlas-agent/<슬러그>`. 사용자가 자기 폴더를 가리켜
//   등록한 에이전트·프로젝트 폴더 안의 에이전트·git 저장소·링크는 *건드리지 않는다* — 라우트(`agent-routes.json`, 정의 위치의 정본)가 그 폴더를 그대로 가리키고,
//   앱 쪽에는 상태 폴더(`~/.agentlas/agents/<이름>/.agentlas-local/`)만 만든다. 사용자의 폴더에는 아무 파일도 쓰지 않는다.
//   Agent Cloud·Hub 패키지는 설치 트랜잭션(registry-transaction.ts)이 같은 위치 해석(`managedAgentFolder`)을 쓰므로 옮긴 뒤의 업데이트가 옮긴 자리를 다시 쓴다.
//   다른 볼륨에 있는 앱 폴더는 복사하지 않는다 — 제자리에서 계속 쓰고 `other-volume` 으로 보고한다.
//
// ★ 한 에이전트 = 한 폴더. 이 컴퓨터에만 있는 상태(`.agentlas-local/`: 소유 표식, 기억, 사진)는 정의 폴더 안에 있다. 정의보다 먼저 생긴 상태 전용 폴더
//   (`agents/local-<이름>` 등)는 정의 폴더로 합친다: 없는 것은 옮겨 넣고, 양쪽에 있으면 더 새 것을 남기고 다른 쪽은 `absorbed-<시각>/` 아래에 보존한다(지우지 않는다).
//
// ★ 한 폴더(단위)의 순서 — 단계 사이 어디서 죽어도 에이전트가 사라지거나 둘로 보이거나 id 가 바뀌지 않는다. 새 표·저널 없음:
//   0. 실행 중이 아님을 확인한다(`agentFolderMoveBlocker`: 실행 임대·열린 파일 작업·동기화 대기, 끝나지 않은 설치 트랜잭션). 실행 중이면 *지금은* 옮기지 않는다.
//   1. 그 에이전트들의 쓰기 잠금을 잡는다(새 실행이 이 사이에 시작하지 못한다).
//   2. 옮기기 *전에* 옛 폴더 안에 소유 표식(`owner.json`)과 출처(`origin.json {from}`)를 쓴다 — 임시 파일에 쓰고 fsync 한 뒤 rename 한다.
//   3. `rename` 한 번(같은 볼륨; 복사 없음). 잠김(EPERM/EBUSY)이면 방금 쓴 표식을 되돌리고 제자리에 둔다.
//   4. 라우트 갱신(`rebindRoutesUnder`, 한 번의 CAS) + 아직 처리 안 된 변경안의 `rootPath` + 사진을 상태 폴더로 + 먼저 생긴 상태 폴더 합치기.
//   5. 엔진 등록 갱신은 *이동을 막지 않는다*: 모든 이동·라우트가 끝난 뒤 `syncMovedFoldersWithEngine` 이 따로 한다. 엔진이 답하지 않으면 그 실행의 나머지는
//      `pending` 으로 두고 다음 시작에 다시 한다(횟수로 포기하지 않는다).
//   크래시 복구(`repairInterruptedMoves`, 창이 뜨기 전): 라우트가 없는 옛 앱 경로를 가리키면 ① 새 폴더의 origin.json(from) ② 소유 표식이 그 에이전트를 이름
//   붙인 정의 폴더로 라우트를 맞춘다. 표식이 빈 파일이면(전원 차단) 라우트·출처·스텁의 manifest 로 다시 쓴다(`repairOwnerMarkers`).
//
// ★ 언제 도는가: 앱 시작 뒤 첫 화면이 뜬 다음 유휴 슬롯에서, 그리고 "실행 중이라 미룬" 에이전트의 실행이 끝났다는 신호(`onAgentWorkspaceRunLeaseReleased`)·창 focus(데몬에서 끝난 실행·닫힌 설치 저널)에서
//   그 에이전트만 다시(대기 집합이 있을 때만 구독). 타이머·폴링·파일 감시 없음. 데몬(follower)은 돌리지 않는다. `AGENTLAS_AGENT_HOME_MOVE=0` 이면 끈다. 다시 불러도 안전하다.
// ★ 결과(`HomeMoveReport`)는 "끝남 / 남음(지금만 못 옮김 · 옮길 수 없는 종류 · 사용자 소유) / 실패" 를 나눠 돌려준다. 디스크에 완료 표식을 남기지 않는다.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { forgetEpochOf, lowerForgetEpochAfterCopy } from "../memory/forget-copy-guard";
import { ensureK1Columns, K1_COLUMNS } from "../memory/store-columns";
import { getDb } from "../store/db";
import { listRoutes, rebindRoutesUnder, type AgentRoute } from "./routes";
import {
  AGENT_LOCAL_STATE_FOLDER, AGENT_OWNER_FILE, agentHomeRootStatus, classifyAgentFolder, ensureAgentStateDir, generatedAgentOsRoot, invalidateOwnerIndex, isStateOnlyFolder,
  legacyAgentsRoot, legacyFolderName, ownedAgentFolder, ownerIds, safeHomeName, writeFileDurable, type AppFolderRoot,
} from "./home";
import { agentFolderMoveBlocker, onAgentWorkspaceRunLeaseReleased, rebindAgentWorkspaceRoot, withAgentFolderMoveLocks } from "./workspace-service";
import { movedFolders, type MovedFolder } from "./home-relocation";
import { agentRootMoveActive, recoverAgentRootMove, retireOldAgentRoot, rootMoveJournalKnownAbsent, rootMoveRetirementMayBeDue } from "./root-move";
import { openCloudRegistryFolders } from "../cloud-agents/registry-transaction";
import { sweepStaleRestoreStaging } from "../cloud-agents/restore";

export const ORIGIN_FILE = "origin.json";
export const AGENT_PHOTO_FILE = /^one-avatar\.(?:png|jpe?g|webp)$/i;
const CLOUD_MARKER = ".agentlas-cloud-package.json";
const STATE_MARKERS = new Set([".gitignore", AGENT_OWNER_FILE, ORIGIN_FILE]);
const STUB_FILES = new Set(["system-prompt.md", "AGENT.md", "manifest.md"]);
/** 지금만 못 옮긴다 — 실행이 끝나거나 다음 시작에 다시 된다. */
const DEFER_REASONS = new Set(["run-active", "file-operation-open", "pending-sync", "workspace-locked", "locked", "state-unreadable", "vanished",
  "destination-taken", "cloud-transaction-open", "routes-pending", "memory-busy"]);
/** 다시 해도 같다 — 제자리에서 계속 쓴다. "사용 중이라 다음에" 로 보이면 거짓이다. */
const PERMANENT_REASONS = new Set(["other-volume", "name-taken", "owner-mismatch", "state-folder-unsafe", "home-exists-same-owner", "not-a-folder", "no-permission",
  "duplicate-folder"]);

export type MoveOutcome = "moved" | "in-place" | "deferred" | "permanent" | "failed";
export interface MoveEntry {
  unit: string;
  ids: string[];
  /** moved: 옮김 / in-place: 사용자 소유(의도) / deferred: 지금만 못 옮김 / permanent: 옮길 수 없는 종류 / failed: 오류. */
  outcome: MoveOutcome;
  /** 이유(기계가 읽는 코드). */
  reason?: string;
  to?: string;
  /** 엔진 레지스트리: pending(`syncMovedFoldersWithEngine` 이 알린다) / none(엔진 패키지가 아니다). */
  engine?: "pending" | "none";
}
export interface HomeMoveReport {
  schema: "agentlas.agent-home-move.v2";
  /** 패스가 끝까지 돌지 않은 이유(disabled / follower / root-missing / aborted / error-*). 없으면 끝까지 돌았다. */
  skipped?: string;
  /** 이번에 옮긴 단위. */
  moved: number;
  /** 이미 에이전트 루트에 있어 할 일이 없던 단위. */
  alreadyHome: number;
  /** 사용자 소유 폴더 — 의도적으로 제자리. */
  inPlace: number;
  /** 지금만 못 옮긴 단위(실행 중 등). */
  deferred: number;
  /** 옮길 수 없는 종류(다른 볼륨·이름 충돌 등). 다시 해도 같다. */
  permanent: number;
  failed: number;
  /** 이전 실행이 rename 뒤 라우트를 못 바꾸고 죽은 단위를 이어 마친 수. */
  recovered: number;
  /** 먼저 생긴 상태 폴더를 정의 폴더로 합친 수. */
  merged: number;
  /** 읽을 수 없던 소유 표식을 다른 증거로 다시 쓴 수. */
  markersRepaired: number;
  /** 옛 자리의 사진을 상태 폴더로 옮긴 수. */
  photosMoved: number;
  /** 엔진에 아직 알리지 못한 옮긴 폴더 수(`syncMovedFoldersWithEngine` 의 몫). */
  enginePending: number;
  /** 끝났는가: 끝까지 돌았고 지금만 못 옮긴 것·실패가 없다. (옮길 수 없는 종류와 사용자 소유는 "남은 일"이 아니다.) */
  complete: boolean;
  entries: MoveEntry[];
}

/** 엔진 레지스트리와 말하는 문. 시험은 가짜를 넣는다. 던지지 않는다. */
export interface HomeMoveEngine {
  /** 엔진이 등록해 둔 소스 폴더들. 엔진을 못 부르면 null. */
  registeredRoots(): Promise<string[] | null>;
  /** 새 폴더를 등록한다(엔진이 내용이 같고 옛 폴더가 사라진 정의를 "옮김"으로 알아보고 id 를 유지한다). 못 부르면 null. */
  register(root: string): Promise<{ ok: boolean; movedFrom?: string } | null>;
}

export interface HomeMoveOptions {
  signal?: AbortSignal;
  /** 이 에이전트들이 든 단위만 다시 본다(실행이 끝났다는 신호). 없으면 전부. */
  onlyIds?: readonly string[];
  /** 단위 사이에 양보한다. 기본: setImmediate. */
  yieldToLoop?: () => Promise<void>;
}

interface RowLite { id: string; slug: string }
interface Unit {
  dir: string;
  appRoot: AppFolderRoot;
  /** 이 폴더 자체의 에이전트 id(같은 경로를 가리키는 행이 둘이면 둘 다) — owner.json 에 적는다. */
  ids: string[];
  /** 폴더 안쪽 라우트(팀 구성원 등)의 id. */
  nestedIds: string[];
  /** 라우트가 있는가(라우트 없는 스텁은 이름 규칙이 정해져 있다). */
  routed: boolean;
  slug: string;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function writeJsonDurable(file: string, value: unknown): void {
  writeFileDurable(file, JSON.stringify(value) + "\n");
}

function id6(id: string): string {
  return createHash("sha256").update(String(id ?? "")).digest("hex").slice(0, 6);
}

function isDirectoryNoLink(target: string): boolean {
  try { const stat = fs.lstatSync(target); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
}

/** 링크를 따라간 결과가 폴더인가(사용자가 링크로 등록한 경우도 폴더다). */
function isDirectory(target: string): boolean {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

function under(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realOrSelf(target: string): string {
  try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
}

function closeMemoryStoresUnder(folder: string): void {
  // 이 폴더 아래에 열린 기억 저장소가 있으면 먼저 닫는다(Windows 에서는 열린 핸들이 rename 을 막는다). 지금은 대개 없다.
  if (!exists(path.join(folder, AGENT_LOCAL_STATE_FOLDER, "memory"))) return;
  try { (require("../memory/stores") as typeof import("../memory/stores")).closeAllStores(); } catch { /* nothing open */ } // eslint-disable-line @typescript-eslint/no-require-imports
}

// ───────────────────────────── 계획 ─────────────────────────────

interface Plan { units: Unit[]; home: Unit[]; inPlace: AgentRoute[]; rows: Map<string, RowLite>; routes: AgentRoute[] }

function planUnits(): Plan {
  const rows = new Map<string, RowLite>();
  for (const row of getDb().prepare("SELECT id, slug FROM installed_agents").all() as RowLite[]) rows.set(row.id, row);
  const routes = listRoutes();
  const routeIds = new Set(routes.map((route) => route.agentId));
  const units = new Map<string, Unit>();
  const home = new Map<string, Unit>();
  const inPlace: AgentRoute[] = [];

  for (const route of routes) {
    if (!route?.path || typeof route.path !== "string" || !path.isAbsolute(route.path) || !rows.has(route.agentId)) continue;
    if (route.missingSince || !exists(route.path)) continue; // 폴더가 사라진 에이전트: "다시 연결"의 몫, 여기서 추측하지 않는다
    const cls = classifyAgentFolder(route.path);
    if (cls.owner === "user") { inPlace.push(route); continue; }
    const bucket = cls.appRoot === "agent-home" ? home : units;
    const unit = bucket.get(cls.unit) ?? { dir: cls.unit, appRoot: cls.appRoot, ids: [], nestedIds: [], routed: true, slug: rows.get(route.agentId)!.slug };
    if (path.resolve(route.path) === cls.unit) unit.ids.push(route.agentId); else unit.nestedIds.push(route.agentId);
    bucket.set(cls.unit, unit);
  }

  // 라우트 없는 행의 스텁 폴더: 예전 위치(`userData/agents/<slug>`)에 있으면 옮길 단위, 이미 에이전트 루트에 있으면 끝난 단위.
  for (const row of rows.values()) {
    if (routeIds.has(row.id)) continue;
    let dir: string;
    try { dir = path.join(legacyAgentsRoot(), legacyFolderName(row)); } catch { continue; }
    if (isDirectoryNoLink(dir)) {
      const cls = classifyAgentFolder(dir);
      if (cls.owner !== "app" || cls.nested) continue;
      const unit = units.get(cls.unit) ?? { dir: cls.unit, appRoot: cls.appRoot, ids: [], nestedIds: [], routed: false, slug: row.slug };
      unit.ids.push(row.id);
      units.set(cls.unit, unit);
      continue;
    }
    const owned = ownedAgentFolder(row);
    if (owned && !isStateOnlyFolder(owned) && !home.has(owned)) home.set(owned, { dir: owned, appRoot: "agent-home", ids: [row.id], nestedIds: [], routed: false, slug: row.slug });
  }
  const sorted = (map: Map<string, Unit>) => {
    for (const unit of map.values()) { unit.ids.sort(); unit.nestedIds.sort(); }
    return [...map.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1));
  };
  return { units: sorted(units), home: sorted(home), inPlace, rows, routes };
}

/** 옮기면 안 되는 이유(코드), 없으면 null. 읽기만 한다. */
function unitBlocker(unit: Unit, root: string, routeOf: (id: string) => AgentRoute | undefined, openTransactions: { folders: string[]; unreadable: boolean }): string | null {
  if (!isDirectoryNoLink(unit.dir)) return "not-a-folder";
  // 다른 볼륨의 폴더는 rename 으로 옮길 수 없다. 복사하지 않는다(큰 폴더의 사본을 만들지 않는다) — 제자리에서 계속 쓴다.
  try { if (fs.statSync(unit.dir).dev !== fs.statSync(root).dev) return "other-volume"; } catch { return "unreadable"; }
  // 상태 폴더가 링크이거나 폴더가 아니면 그 안에 표식을 쓰지 않는다(링크가 가리키는 곳에 쓰게 된다).
  const state = path.join(unit.dir, AGENT_LOCAL_STATE_FOLDER);
  if (exists(state) && !isDirectoryNoLink(state)) return "state-folder-unsafe";
  const claimed = ownerIds(unit.dir);
  const ours = new Set([...unit.ids, ...unit.nestedIds]);
  if (claimed.length > 0 && !claimed.some((id) => ours.has(id))) return "owner-mismatch";
  // 끝나지 않은 설치·업데이트 트랜잭션이 이 폴더를 쥐고 있으면 그 저널이 정리된 뒤에 옮긴다(저널은 폴더 위치를 적어 둔다).
  if (openTransactions.unreadable && exists(path.join(unit.dir, CLOUD_MARKER))) return "cloud-transaction-open"; // 읽을 수 없는 저널: 어느 패키지의 것인지 모른다
  if (openTransactions.folders.includes(path.resolve(unit.dir))) return "cloud-transaction-open";
  for (const id of [...unit.ids, ...unit.nestedIds]) {
    const blocker = agentFolderMoveBlocker(id, routeOf(id)?.path ?? unit.dir);
    if (blocker) return blocker;
  }
  return null;
}

type Destination = { dest: string; aside?: string } | { reason: string };

/**
 * 새 이름: 소문자 ASCII 이름, 이미 쓰는 이름이면 `-id6`. 그 이름에 *이 에이전트의 상태 전용 폴더*가 먼저 있으면(정의보다 상태가 먼저 생겼다) 그 폴더를 잠깐
 * 비켜 두고 같은 이름으로 옮긴 뒤 합친다. 같은 에이전트의 *정의* 폴더가 이미 있으면 새 자리가 이긴다 — 옛 것은 지우지 않는다.
 */
function chooseDestination(unit: Unit, root: string): Destination {
  const primary = unit.ids[0] ?? unit.nestedIds[0] ?? unit.slug;
  const base = safeHomeName(unit.routed ? path.basename(unit.dir) : unit.slug, primary);
  for (const candidate of [path.join(root, base), path.join(root, `${base}-${id6(primary)}`)]) {
    if (!exists(candidate)) return { dest: candidate };
    if (!ownerIds(candidate).some((id) => unit.ids.includes(id))) continue;
    return isStateOnlyFolder(candidate) && isDirectoryNoLink(candidate) ? { dest: candidate, aside: candidate } : { reason: "home-exists-same-owner" };
  }
  return { reason: "name-taken" };
}

// ───────────────────────────── 표식 ─────────────────────────────

interface StagedMarkers { createdState: boolean; created: string[]; previousOrigin: string | null; previousOwner: string | null }

function stageMarkers(unit: Unit, realFrom: string, needsEngine: boolean): StagedMarkers {
  const state = path.join(unit.dir, AGENT_LOCAL_STATE_FOLDER);
  const staged: StagedMarkers = { createdState: !exists(state), created: [], previousOrigin: null, previousOwner: null };
  try {
    // 재귀로 만들지 않는다: 단위 폴더가 그 사이 다른 프로세스에 의해 옮겨졌다면 옛 자리에 빈 폴더를 되살리지 않고 실패해야 한다.
    try { fs.mkdirSync(state); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try { fs.writeFileSync(path.join(state, ".gitignore"), "*\n", { flag: "wx" }); staged.created.push(".gitignore"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (unit.ids.length > 0) {
      const ownerFile = path.join(state, AGENT_OWNER_FILE);
      const existing = readJsonObject(ownerFile);
      try { staged.previousOwner = fs.readFileSync(ownerFile, "utf8"); } catch { /* none */ }
      if (!existing || ownerIds(unit.dir).length === 0) {
        // 없거나 읽을 수 없는(빈 파일) 표식: 새로 쓴다.
        writeJsonDurable(ownerFile, { schema: 1, agentId: unit.ids[0], ids: unit.ids, createdAt: new Date().toISOString() });
        if (staged.previousOwner === null) staged.created.push(AGENT_OWNER_FILE);
      } else {
        // 있던 표식은 그대로 둔다. 같은 경로를 가리키는 다른 행이 있으면 별칭으로만 더한다(기억을 찾는 쪽이 둘 다 같은 폴더로 해석한다).
        const known = new Set(ownerIds(unit.dir));
        const missing = unit.ids.filter((id) => !known.has(id));
        if (missing.length) {
          const ids = [...new Set([...(Array.isArray(existing.ids) ? existing.ids.filter((x): x is string => typeof x === "string") : []), ...missing])];
          writeJsonDurable(ownerFile, { ...existing, ids });
        }
      }
    }
    const originFile = path.join(state, ORIGIN_FILE);
    try { staged.previousOrigin = fs.readFileSync(originFile, "utf8"); } catch { /* none */ }
    if (staged.previousOrigin === null) staged.created.push(ORIGIN_FILE);
    writeJsonDurable(originFile, { schema: 1, kind: "moved", from: unit.dir, realFrom, at: new Date().toISOString(), engine: needsEngine ? "pending" : "none" });
    return staged;
  } catch (error) {
    unstageMarkers(unit, staged); // 디스크가 가득 찼거나 쓸 수 없다: 쓰다 만 표식을 남기지 않고 폴더를 처음 모양으로 둔다
    throw error;
  }
}

/** rename 이 안 됐다: 방금 쓴 표식을 되돌려 옛 폴더를 처음 모양으로 둔다. */
function unstageMarkers(unit: Unit, staged: StagedMarkers): void {
  const state = path.join(unit.dir, AGENT_LOCAL_STATE_FOLDER);
  try {
    if (staged.previousOrigin !== null) fs.writeFileSync(path.join(state, ORIGIN_FILE), staged.previousOrigin);
    if (staged.previousOwner !== null && !staged.created.includes(AGENT_OWNER_FILE)) fs.writeFileSync(path.join(state, AGENT_OWNER_FILE), staged.previousOwner);
    for (const name of staged.created) { try { fs.unlinkSync(path.join(state, name)); } catch { /* already gone */ } }
    if (staged.createdState) { try { fs.rmdirSync(state); } catch { /* not empty: something else lives there */ } }
  } catch { /* a leftover marker is rewritten by the next try */ }
  invalidateOwnerIndex();
}

function updateOrigin(folder: string, patch: Record<string, unknown>): void {
  try {
    const file = path.join(folder, AGENT_LOCAL_STATE_FOLDER, ORIGIN_FILE);
    const current = readJsonObject(file);
    if (current) writeJsonDurable(file, { ...current, ...patch });
  } catch { /* the marker is a hint for the next start; losing the update only repeats an idempotent step */ }
}

function hasEnginePackage(dir: string): boolean {
  return exists(path.join(dir, ".agentlas", "routing-card.json")) || exists(path.join(dir, "agentlas.json"));
}

// ───────────────────────────── 상태 폴더 합치기 ─────────────────────────────

/** SQLite 파일과 그 곁 파일(-wal, -shm, -journal)은 한 묶음으로 다룬다. */
function familyOf(name: string): string {
  return name.replace(/-(?:wal|shm|journal)$/, "");
}

function newestMtime(directory: string, names: string[]): number {
  let newest = 0;
  for (const name of names) { try { newest = Math.max(newest, fs.statSync(path.join(directory, name)).mtimeMs); } catch { /* gone */ } }
  return newest;
}

/** 복구가 끝난 뒤 주인 없는 설치 스테이징 사본을 치운다(감사 33-5). 열린 저널을 읽을 수 없으면 아무것도 치우지 않는다. 앱이 쓴 패키지 표식이 없는 것은 남기고 이유를 보고에 적는다(감사 35-11). */
function sweepRestoreLeftovers(root: string, report?: HomeMoveReport): number {
  const open = openCloudRegistryFolders();
  if (open.unreadable) return 0;
  const kept: Array<{ path: string; reason: string }> = [];
  let removed = sweepStaleRestoreStaging(root, open.folders, kept);
  try { removed += sweepStaleRestoreStaging(legacyAgentsRoot(), open.folders, kept); } catch { /* userData unknown */ }
  if (report) for (const item of kept) { report.permanent += 1; report.entries.push({ unit: item.path, ids: [], outcome: "permanent", reason: item.reason }); }
  return removed;
}

// ───────────────────────────── 기억 저장소 합치기 ─────────────────────────────

const MEMORY_STORE_FILE = "memory.sqlite";
/** 항목과 그것에 매달린 표(엔진 `memory_split.ROW_TABLES` 와 같은 순서). 항목이 먼저다. */
const MEMORY_ROW_TABLES = ["memory_entries", "memory_identity_bindings", "memory_project_links", "memory_origin_links", "memory_entry_native"] as const;
/** 잊은 항목이 비워지는 열(`memory/stores.ts BLANK_COLUMNS`, 엔진 `forget` 과 같다). 있는 열만 쓴다. */
const MEMORY_BLANK_COLUMNS: ReadonlyArray<readonly [column: string, value: string]> = [
  ["content", "''"], ["evidence_json", "'[]'"], ["context_json", "'{}'"], ["chat_id", "NULL"], ["embedding_model", "NULL"], ["embedding_adapter", "NULL"],
  ["embedding_model_sha256", "NULL"], ["embedding_content_hash", "NULL"], ["embedding_dimensions", "NULL"], ["embedding_json", "NULL"],
];

export type MemoryMergeStatus = "merged" | "busy" | "not-a-store" | "schema-differs" | "count-mismatch" | "error";
export interface MemoryMergeResult {
  status: MemoryMergeStatus;
  /** `error` 일 때 SQLite·OS 오류 코드(기계가 읽는다). */
  code?: string;
  /** `merged` 일 때 새로 들어온 항목 수(`createdAfter` 와 함께 쓸 때만 센다). */
  inserted?: number;
}

/** 합치기 트랜잭션 안에서 던져 되돌린다(아무것도 바뀌지 않는다). */
class MemoryMergeStop extends Error {
  constructor(readonly status: "schema-differs" | "count-mismatch") { super(status); }
}

/** 합치기가 끝나지 않았다는 사실을 부르는 쪽(단위 단위의 보고)에 전한다. 파일은 아무것도 지우지 않았다. */
class MemoryMergeDeferred extends Error {
  constructor(readonly outcome: "deferred" | "permanent" | "failed", readonly reason: string) { super(reason); }
}

/** 합치기 결과가 "merged" 가 아닐 때의 보고 이유(기계가 읽는 코드). */
function memoryMergeReason(result: MemoryMergeResult): { outcome: "deferred" | "permanent" | "failed"; reason: string } {
  switch (result.status) {
    case "busy": return { outcome: "deferred", reason: "memory-busy" };
    case "schema-differs": return { outcome: "permanent", reason: "memory-schema-differs" };
    case "count-mismatch": return { outcome: "permanent", reason: "memory-rows-not-landed" };
    case "not-a-store": return { outcome: "permanent", reason: "memory-not-a-store" };
    default: return { outcome: "failed", reason: `memory-merge-${result.code ?? "unexpected"}` };
  }
}

function memoryMergeFailure(result: MemoryMergeResult): MemoryMergeDeferred {
  const { outcome, reason } = memoryMergeReason(result);
  return new MemoryMergeDeferred(outcome, reason);
}

/**
 * `fromFile` 의 기억 행을 `toFile` 에 합친다(`INSERT OR IGNORE`, id 기준; 엔진 `memory_split.copy_rows` 와 같은 규칙). 이 표에는 `updated_at` 이 없다: 같은 id 에 내용이
 * 다르면 `toFile`(정의 폴더 쪽)의 행이 남는다. 두 가지는 한쪽으로만 간다 — 폐기 표시(`superseded_at`)는 내려가지 않고, 잊은 행(내용을 비우고 폐기)은 어느 쪽에서든 그 말을
 * 되살리지 않는다. 한 트랜잭션이라 도중에 죽어도 반쯤 합쳐지지 않고(다시 부르면 이어 마친다), 다른 프로세스가 연 저장소와 파일 잠금으로 공존한다.
 * 결과: `merged`(원본의 모든 행이 이쪽에 있다 — 그때만 원본을 지울 수 있다) / `busy`(다른 프로세스가 쓰는 중이라 250ms 안에 못 잡았다: 아무것도 바꾸지 않았고 다음에 다시) /
 * `not-a-store`(SQLite 가 아니거나 항목 표가 없다: 부르는 쪽만 파일 규칙으로 간다) / `schema-differs`(두 저장소의 열 집합·스키마 버전이 다르다: 합치지 않는다) /
 * `count-mismatch`(원본의 행이 이쪽에 도착하지 않았다 — NOT NULL·CHECK 가 건너뛴 것: 되돌리고 원본을 지우지 않는다) / `error`(그 밖: 디스크 가득 참·읽기 전용·손상).
 * 합친 뒤 잊기 번호(`forget_epoch_applied`)는 `lowerForgetEpochAfterCopy`(`memory/forget-copy-guard.ts`)가 같은 트랜잭션에서 두 값 중 작은 쪽으로 내린다 — 원본이 모르던 잊기를 다음 읽기가 다시 적용한다.
 * 스키마 문(#3): 한쪽만 `schema_version` 이 올라간 정상적인 버전 차이는 막지 않는다 — 원본에 있는 열이 이쪽에 *없을 때만* `schema-differs`(열이 빠지면 값이 조용히 사라진다).
 * 이쪽에만 있는 열은 기본값으로 채우고, 못 채워 건너뛴 행은 도착 확인이 잡아 되돌린다. 합친 뒤 로그(WAL)를 본 파일에 반영한다 — 합치다 들어온 잊은 글이 로그에만 남지 않게. 던지지 않는다.
 */
export function mergeMemoryStoreResult(fromFile: string, toFile: string, options: { createdAfter?: string } = {}): MemoryMergeResult {
  let db: Database.Database | null = null;
  let inserted = 0;
  // 루트 이동의 보존본 정리(`root-move.ts`)는 "이동이 확정된 뒤 옛 루트에 새로 쓰인 항목"만 합친다: 그 전의 항목은 이미 새 쪽에 복사됐거나 새 쪽에서 일부러 지워졌다(프로젝트 삭제는 행을 지울 뿐 표식을 남기지 않는다).
  // 항목은 `created_at`, 매달린 표는 그 항목의 id 로 같은 범위를 고른다. `julianday` 는 ISO 와 `YYYY-MM-DD HH:MM:SS` 를 모두 읽는다.
  const since = options.createdAfter && Number.isFinite(Date.parse(options.createdAfter)) ? options.createdAfter : null;
  const LATE_IDS = "SELECT id FROM incoming.memory_entries WHERE julianday(created_at) > julianday(?)";
  /** 이 표에서 고르는 행의 조건(`incoming.<표> ` 별칭 없이). `idColumn` 이 null 이면 항목 표 자신. */
  const lateWhere = (idColumn: string | null): { sql: string; params: string[] } => {
    if (!since) return { sql: "", params: [] };
    return idColumn === null ? { sql: "julianday(created_at) > julianday(?)", params: [since] } : { sql: `${idColumn} IN (${LATE_IDS})`, params: [since] };
  };
  const ID_COLUMN: Record<string, string | null> = { memory_entries: null, memory_identity_bindings: "memory_id", memory_project_links: "memory_id", memory_origin_links: "memory_id", memory_entry_native: "entry_id" };
  if (!exists(fromFile) || !exists(toFile)) return { status: "not-a-store" };
  try {
    db = new Database(toFile, { fileMustExist: true, timeout: 250 });
    db.prepare("ATTACH DATABASE ? AS incoming").run(fromFile);
    const tables = (schema: "main" | "incoming"): Set<string> => new Set((db!.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((row) => row.name));
    const info = (schema: "main" | "incoming", table: string): Array<{ name: string; pk: number }> => db!.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string; pk: number }>;
    const columns = (schema: "main" | "incoming", table: string): string[] => info(schema, table).map((row) => row.name);
    const incomingTables = tables("incoming");
    if (!incomingTables.has("memory_entries")) return { status: "not-a-store" };
    db.pragma("secure_delete=ON"); // 합치기가 잊은 행을 비울 때 옛 글자가 빈 페이지에 남지 않게
    const merge = db.transaction(() => {
      const mainTables = tables("main");
      // 2.0 K1: the source may already carry the four nullable columns (the engine or the desktop added them there) while this destination does not. That is the same shape one step earlier, not a different
      // schema: add them here once (a transaction of ours, marked in its meta) before the "a column the destination lacks" check below. Only when the source has one the destination lacks; a lock leaves the old refusal.
      if ([...K1_COLUMNS].some(([table, column]) => incomingTables.has(table) && mainTables.has(table) && columns("incoming", table).includes(column) && !columns("main", table).includes(column))) ensureK1Columns(db!, "main");
      // 원본에 있는 열이 이쪽에 없으면 합치지 않는다(그 열의 값이 조용히 사라진다). 버전 문자열만 다른 것, 이쪽에만 있는 열은 막지 않는다 — `INSERT OR IGNORE` 가 새 규칙(NOT NULL·CHECK)에
      // 걸려 건너뛴 행은 아래 도착 확인이 되돌린다(원본이 지워지지 않는다).
      for (const table of [...MEMORY_ROW_TABLES, "memory_relation_edges"]) {
        if (!incomingTables.has(table) || !mainTables.has(table)) continue;
        const have = new Set(columns("main", table));
        if (columns("incoming", table).some((column) => !have.has(column))) throw new MemoryMergeStop("schema-differs");
      }
      for (const table of MEMORY_ROW_TABLES) {
        if (!incomingTables.has(table)) continue;
        if (!mainTables.has(table)) {
          // 이쪽에 표가 없으면 들어오는 쪽이 정의한 대로 만든다(다른 도구가 뿌리에 더한 열도 함께 간다). 항목 표가 없는 파일이면 그 표부터 만든다.
          for (const kind of ["table", "index", "trigger"]) {
            for (const row of db!.prepare(`SELECT sql FROM incoming.sqlite_master WHERE type=? AND tbl_name=? AND sql IS NOT NULL`).all(kind, table) as Array<{ sql: string }>) {
              db!.exec(kind === "table" ? row.sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ") : row.sql);
            }
          }
        }
        const inMain = new Set(columns("main", table));
        const shared = columns("incoming", table).filter((column) => inMain.has(column));
        if (shared.length === 0) continue;
        const names = shared.join(",");
        const late = since && table in ID_COLUMN && (ID_COLUMN[table] === null || columns("incoming", table).includes(ID_COLUMN[table]!)) ? lateWhere(ID_COLUMN[table]!) : { sql: "", params: [] as string[] };
        const changes = db!.prepare(`INSERT OR IGNORE INTO main.${table}(${names}) SELECT ${names} FROM incoming.${table}${late.sql ? ` WHERE ${late.sql}` : ""}`).run(...late.params).changes;
        if (table === "memory_entries") inserted += changes;
        // 도착 확인(엔진 `landed()` 와 같은 뜻): 원본의 모든 행이 이쪽에 있어야 한다 = 들어간 줄 + 이미 있던 줄 = 원본 줄. 하나라도 없으면 되돌린다.
        const keys = info("incoming", table).filter((row) => row.pk > 0).sort((x, y) => x.pk - y.pk).map((row) => row.name);
        if (keys.length > 0 && keys.every((column) => inMain.has(column))) {
          const missing = db!.prepare(`SELECT COUNT(*) AS n FROM incoming.${table} i WHERE ${late.sql ? `${late.sql} AND ` : ""}NOT EXISTS (SELECT 1 FROM main.${table} m WHERE ${keys.map((column) => `m.${column} IS i.${column}`).join(" AND ")})`).get(...late.params) as { n: number };
          if (missing.n > 0) throw new MemoryMergeStop("count-mismatch");
        }
        if (table !== "memory_entries" || !shared.includes("superseded_at")) continue;
        // 같은 id: 폐기 표시는 내려가지 않는다.
        db!.exec(`UPDATE main.memory_entries SET superseded_at=(SELECT i.superseded_at FROM incoming.memory_entries i WHERE i.id=main.memory_entries.id)
          WHERE superseded_at IS NULL AND id IN (SELECT id FROM incoming.memory_entries WHERE superseded_at IS NOT NULL)`);
        // 같은 id: 들어오는 쪽이 잊은 행이면 이쪽의 말도 비운다(잊은 말이 되살아나지 않게).
        const blank = MEMORY_BLANK_COLUMNS.filter(([column]) => inMain.has(column)).map(([column, value]) => `${column}=${value}`).join(",");
        if (inMain.has("content") && blank) {
          db!.exec(`UPDATE main.memory_entries SET ${blank} WHERE content<>'' AND id IN (SELECT id FROM incoming.memory_entries WHERE content='' AND superseded_at IS NOT NULL)`);
        }
      }
      // 두 끝이 모두 이쪽에 있는 관계선만(엔진과 같다). 둘 중 하나가 없으면 파생값이라 가져오지 않는다.
      if (incomingTables.has("memory_relation_edges") && tables("main").has("memory_relation_edges")) {
        const inMain = new Set(columns("main", "memory_relation_edges"));
        const shared = columns("incoming", "memory_relation_edges").filter((column) => inMain.has(column));
        if (shared.length > 0 && shared.includes("from_memory_id") && shared.includes("to_memory_id")) {
          const names = shared.join(",");
          const late = since ? { sql: ` AND (from_memory_id IN (${LATE_IDS}) OR to_memory_id IN (${LATE_IDS}))`, params: [since, since] } : { sql: "", params: [] as string[] };
          db!.prepare(`INSERT OR IGNORE INTO main.memory_relation_edges(${names}) SELECT ${names} FROM incoming.memory_relation_edges
            WHERE from_memory_id IN (SELECT id FROM main.memory_entries) AND to_memory_id IN (SELECT id FROM main.memory_entries)${late.sql}`).run(...late.params);
        }
      }
      // 잊기 번호(`forget_epoch_applied`): "이 저장소는 잊기를 몇 번까지 적용했나". 원본이 더 낮으면 원본에 남아 있던 잊은 문장이 이쪽에 들어왔으므로 이쪽 번호도 그 값으로 내린다
      // (한쪽에 값이 없으면 0). 다음 읽기가 그 번호 뒤의 잊기를 다시 적용한다(`memory/stores.ts catchUp`). 내리지 않으면 잊은 말이 다시는 지워지지 않고 되살아난다.
      lowerForgetEpochAfterCopy(db!, "main", forgetEpochOf(db!, "incoming"));
    });
    merge();
    db.exec("DETACH DATABASE incoming");
    // 저장소의 잊기 번호가 내려갔을 수 있다 — 시작 때 따라잡기가 "이미 끝났다"는 지문을 믿지 말고 다시 모든 저장소를 대조하게 한다(#6). 던지지 않는다.
    try { (require("../memory/forget-stores") as typeof import("../memory/forget-stores")).invalidateCatchUpMarker(); } catch { /* 지문이 없거나 뿌리를 못 열면 다음 시작은 어차피 전부 연다 */ }
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 다른 프로세스가 읽는 중 — 다음 체크포인트가 반영한다 */ }
    return { status: "merged", ...(since ? { inserted } : {}) };
  } catch (error) {
    if (error instanceof MemoryMergeStop) return { status: error.status };
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    if (/^SQLITE_(?:BUSY|LOCKED)/.test(code)) return { status: "busy" };
    if (code === "SQLITE_NOTADB") return { status: "not-a-store" };
    return { status: "error", code: code || "unexpected" };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** `mergeMemoryStoreResult` 가 `merged` 일 때만 true. */
export function mergeMemoryStore(fromFile: string, toFile: string): boolean {
  return mergeMemoryStoreResult(fromFile, toFile).status === "merged";
}

/** 보존 폴더 이름(`absorbed-<ISO 시각의 : . 를 - 로>`)에서 시각. 이 규칙이 아니면 null(손대지 않는다). */
function absorbedStamp(name: string): number | null {
  const match = /^absorbed-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  if (!match) return null;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(at) ? at : null;
}

/** 합치다 진 쪽의 보존본(`absorbed-*`)을 지운다(감사 33-4: 읽는 곳도 지우는 곳도 없어 쌓였다): 지난 30일. */
export const ABSORBED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** 합치지 못한 기억 저장소 하나: 어느 파일이 왜(기계가 읽는 코드). */
interface AbsorbedLeftover { file: string; reason: string }

/**
 * 이미 쌓인 보존본 정리(감사 33-4·35-2·35-11): ① 안에 든 기억 저장소는 같은 자리의 살아 있는 저장소에 행을 합치고(이전 빌드가 숨겨 둔 행을 되찾는다), 살아 있는
 * 저장소가 없으면 그 자리로 옮겨 놓는다. ② **합쳐지지 않은 기억 저장소가 하나라도 남은 보존본은 30일이 지나도 지우지 않는다**(유실보다 남는 쪽) — 다음 패스가 다시 시도하고,
 * 못 합치는 이유를 기계가 읽는 코드로 보고에 남긴다. ③ 기억 저장소가 하나도 안 남은 보존본만 폴더 이름의 시각이 30일 지났을 때 지운다. 이름이 규칙이 아니거나 시각을 못
 * 읽으면 손대지 않는다. ④ 에이전트 루트 바로 아래 폴더 중 **앱이 만든 소유 표식이 있는 폴더**의 상태 폴더만 본다(링크를 따라가지 않는다). 표식 없는 폴더는 건드리지 않고 사유를 남긴다.
 */
function sweepAbsorbed(root: string, report?: HomeMoveReport, now: number = Date.now()): number {
  let removed = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  const note = (folder: string, dir: string, outcome: "deferred" | "permanent" | "failed", reason: string): void => {
    if (!report) return;
    report[outcome] += 1;
    report.entries.push({ unit: dir, ids: ownerIds(folder), outcome, reason });
  };
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const folder = path.join(root, name);
    const state = path.join(folder, AGENT_LOCAL_STATE_FOLDER);
    let entries: string[] = [];
    try { entries = fs.readdirSync(state).filter((entry) => entry.startsWith("absorbed-")); } catch { continue; }
    if (entries.length === 0) continue;
    // 지우기 전 소유 판정: 폴더도 상태 폴더도 링크가 아니고, 앱이 쓴 소유 표식이 있어야 한다.
    const owned = isDirectoryNoLink(folder) && isDirectoryNoLink(state) && ownerIds(folder).length > 0;
    for (const entry of entries) {
      const stamp = absorbedStamp(entry);
      if (stamp === null) continue;
      const dir = path.join(state, entry);
      try {
        if (!isDirectoryNoLink(dir)) continue;
        if (!owned) { if (now - stamp >= ABSORBED_KEEP_MS) note(folder, dir, "permanent", "absorbed-not-app-owned"); continue; }
        const left = healAbsorbedMemory(dir, state);
        for (const item of left) note(folder, item.file, memoryReasonOutcome(item.reason).outcome, `absorbed-${item.reason}`); // `absorbed-` 접두사: 이 패스에서만 다시 본다(포커스 대기 집합에 넣지 않는다)
        if (left.length > 0 || containsMemoryStore(dir)) continue; // 합쳐지지 않은 기억은 지우지 않는다
        if (now - stamp < ABSORBED_KEEP_MS) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch { /* the next pass tries again */ }
    }
  }
  return removed;
}

function memoryReasonOutcome(reason: string): { outcome: "deferred" | "permanent" | "failed" } {
  if (reason === "memory-busy" || reason === "memory-live-appeared") return { outcome: "deferred" };
  if (reason.startsWith("memory-merge-") || reason.startsWith("memory-adopt-")) return { outcome: "failed" };
  return { outcome: "permanent" };
}

/** 이 폴더 아래에 기억 저장소 본 파일(`memory.sqlite`)이 아직 있는가. 곁 파일(-wal·-shm)만 있는 것은 저장소가 아니다. */
function containsMemoryStore(directory: string): boolean {
  let names: string[] = [];
  try { names = fs.readdirSync(directory); } catch { return false; }
  for (const name of names) {
    const full = path.join(directory, name);
    if (isDirectoryNoLink(full)) { if (containsMemoryStore(full)) return true; continue; }
    if (name === MEMORY_STORE_FILE) return true;
  }
  return false;
}

/**
 * 합칠 수 없다고 이미 판정한 보존본 저장소(SQLite 가 아님·열 집합이 다름·행이 도착하지 않음)는 입력(크기·mtime)과 규칙 판(`HEAL_RULES`)이 그대로면 다시 열어 보지 않는다 —
 * 시작마다 같은 40개를 다시 여는 비용이 쌓이지 않게(#5). 파일은 지우지 않는다(유실보다 남는 쪽): 이유 코드는 매번 보고에 그대로 나온다. 메모는 그 보존 폴더 안의 작은 파일이라
 * 폴더가 지워지면 같이 없어진다. 쓰는 곳은 이 함수뿐, 규칙을 바꿀 때(`HEAL_RULES` 올림) 옛 메모는 읽히지 않는다. 바쁨·어댑트 실패 같은 일시 사유는 적지 않는다.
 */
const HEAL_RULES = 2;
const HEAL_MEMO_FILE = ".heal-skip.json";
function healFingerprint(file: string): string | null {
  try { const stat = fs.statSync(file); return `${stat.size}:${Math.trunc(stat.mtimeMs)}`; } catch { return null; }
}
function readHealMemo(dir: string): Record<string, { fp: string; reason: string }> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, HEAL_MEMO_FILE), "utf8")) as { rules?: unknown; files?: unknown };
    if (parsed?.rules === HEAL_RULES && parsed.files && typeof parsed.files === "object" && !Array.isArray(parsed.files)) return parsed.files as Record<string, { fp: string; reason: string }>;
  } catch { /* 메모 없음·깨짐 — 다시 시도한다 */ }
  return {};
}
function writeHealMemo(dir: string, files: Record<string, { fp: string; reason: string }>): void {
  try { fs.writeFileSync(path.join(dir, HEAL_MEMO_FILE), JSON.stringify({ rules: HEAL_RULES, files })); } catch { /* 다음에 다시 시도할 뿐이다 */ }
}

/**
 * 보존본 안의 `memory.sqlite` 를 살아 있는 저장소에 합치고 그 묶음을 지운다. 살아 있는 저장소가 아직 없으면 그 자리로 옮겨 놓는다. 합치지 못한 저장소는 지우지 않고
 * 파일과 이유 코드를 돌려준다.
 */
function healAbsorbedMemory(absorbed: string, live: string, relative = "", left: AbsorbedLeftover[] = []): AbsorbedLeftover[] {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(absorbed, relative)); } catch { return left; }
  for (const name of names) {
    const child = path.join(relative, name);
    const full = path.join(absorbed, child);
    if (isDirectoryNoLink(full)) { healAbsorbedMemory(absorbed, live, child, left); continue; }
    if (name !== MEMORY_STORE_FILE) continue;
    const target = path.join(live, child);
    if (isDirectoryNoLink(target)) { left.push({ file: full, reason: "memory-live-target-unusable" }); continue; }
    const memo = readHealMemo(absorbed);
    const fingerprint = healFingerprint(full);
    const remembered = memo[child];
    if (remembered && fingerprint && remembered.fp === fingerprint) { left.push({ file: full, reason: remembered.reason }); continue; }
    let reason: string | null;
    if (!exists(target)) {
      reason = adoptAbsorbedStore(full, target);
    } else {
      const result = mergeMemoryStoreResult(full, target);
      reason = result.status === "merged" ? null : memoryMergeReason(result).reason;
    }
    if (reason && fingerprint && ["memory-not-a-store", "memory-schema-differs", "memory-rows-not-landed"].includes(reason)) { memo[child] = { fp: fingerprint, reason }; writeHealMemo(absorbed, memo); }
    if (reason) { left.push({ file: full, reason }); continue; }
    for (const sibling of names.filter((candidate) => familyOf(candidate) === MEMORY_STORE_FILE)) { try { fs.unlinkSync(path.join(absorbed, relative, sibling)); } catch { /* gone */ } }
  }
  return left;
}

/**
 * 살아 있는 자리에 저장소가 없는 보존본의 저장소를 그 자리로 옮긴다(이름이 같은 파일을 덮어쓰지 않게 하드 링크로 — 안 되는 볼륨이면 한 번 더 확인하고 rename).
 * 먼저 `-wal` 을 본 파일에 반영해 곁 파일 없이 한 파일이 되게 한다. 성공이면 null, 아니면 이유 코드. 원본은 `healAbsorbedMemory` 가 지운다.
 */
function adoptAbsorbedStore(full: string, target: string): string | null {
  try {
    const db = new Database(full, { fileMustExist: true, timeout: 250 });
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
  } catch (error) {
    const code = String((error as { code?: unknown } | null)?.code ?? "");
    if (/^SQLITE_(?:BUSY|LOCKED)/.test(code)) return "memory-busy";
    if (code === "SQLITE_NOTADB") return "memory-not-a-store";
    return `memory-adopt-${code || "unexpected"}`;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.linkSync(full, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "memory-live-appeared"; // 그 사이 살아 있는 저장소가 생겼다: 다음 패스가 합친다
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK", "EXDEV"].includes(code ?? "")) throw error;
      if (exists(target)) return "memory-live-appeared";
      fs.renameSync(full, target);
    }
    invalidateOwnerIndex();
    return null;
  } catch (error) {
    return `memory-adopt-${(error as NodeJS.ErrnoException).code ?? "unexpected"}`;
  }
}

/** `from` 의 내용을 `to` 로 옮겨 넣는다. 없는 것은 rename, 양쪽에 있는 폴더는 안으로 들어가고, 양쪽에 있는 파일은 더 새 묶음을 남기고 다른 쪽을 `keep` 에 보존한다. */
function mergeDirectory(from: string, to: string, keep: string, relative: string, skip: ReadonlySet<string>, tally: { conflicts: number }): void {
  const names = fs.readdirSync(from).filter((name) => !(relative === "" && skip.has(name)));
  const families = new Map<string, string[]>();
  for (const name of names) families.set(familyOf(name), [...(families.get(familyOf(name)) ?? []), name]);
  for (const [family, members] of families) {
    const there = (() => { try { return fs.readdirSync(to).filter((name) => familyOf(name) === family); } catch { return []; } })();
    if (there.length === 0) {
      for (const name of members) fs.renameSync(path.join(from, name), path.join(to, name));
      continue;
    }
    if (members.length === 1 && there.length === 1 && members[0] === there[0] && isDirectoryNoLink(path.join(from, family)) && isDirectoryNoLink(path.join(to, family))) {
      mergeDirectory(path.join(from, family), path.join(to, family), keep, relative ? `${relative}/${family}` : family, skip, tally);
      try { fs.rmdirSync(path.join(from, family)); } catch { /* something stayed: the source folder is then left in place */ }
      continue;
    }
    // 양쪽에 기억 저장소(`memory.sqlite`)가 있다: 파일을 고르지 않고 행을 합친다(누가 더 최근에 *건드려졌나* 로 승자를 정하면 읽기만 해도 뒤집힌다 — 감사 33-4).
    // 합친 행은 이쪽에 있으니 들어오는 쪽 묶음은 지운다. 파일 규칙은 SQLite 가 아닌 파일(`not-a-store`)에만 쓴다: 쓰는 중(`busy`)이거나 스키마가 다르거나 행이 도착하지 않았으면
    // 아무 파일도 옮기지 않고 지우지 않은 채 미룬다(감사 35-3·4: 살아 있는 저장소를 옮겨 놓고 지우던 길).
    if (family === MEMORY_STORE_FILE && members.includes(family) && there.includes(family) && !isDirectoryNoLink(path.join(from, family)) && !isDirectoryNoLink(path.join(to, family))) {
      const result = mergeMemoryStoreResult(path.join(from, family), path.join(to, family));
      if (result.status === "merged") {
        for (const name of members) { try { fs.unlinkSync(path.join(from, name)); } catch { /* gone */ } }
        continue;
      }
      if (result.status !== "not-a-store") throw memoryMergeFailure(result);
    }
    // 양쪽에 같은 이름이 있다: 더 새 묶음이 제자리에 남고, 다른 쪽은 보존 폴더로 간다(30일 뒤 `sweepAbsorbed` 가 지운다).
    tally.conflicts += 1;
    const keepDir = path.join(keep, ...relative.split("/").filter(Boolean));
    fs.mkdirSync(keepDir, { recursive: true });
    // 들어오는 묶음에 본체가 없으면(곁 파일만) 이기지 못한다. 이쪽에 본체가 없으면(곁 파일만) 들어오는 본체가 이긴다(감사 35-5: 곁 파일만 더 새롭다고 살아 있는 저장소를 밀어냈다).
    const incomingWins = members.includes(family) && (!there.includes(family) || newestMtime(from, members) > newestMtime(to, there));
    if (incomingWins) {
      for (const name of there) fs.renameSync(path.join(to, name), path.join(keepDir, name));
      for (const name of members) fs.renameSync(path.join(from, name), path.join(to, name));
    } else {
      for (const name of members) fs.renameSync(path.join(from, name), path.join(keepDir, name));
    }
  }
}

/**
 * 상태 전용 폴더 `source` 를 정의 폴더 `dest` 로 합친다(한 에이전트 = 한 폴더). `dest` 의 소유 표식이 먼저 `source` 가 이름 붙인 id 를 모두 갖게 한 뒤 내용을
 * 옮기고, `source` 의 표식을 마지막에 지운다 — 어느 시점에 죽어도 그 id 를 이름 붙인 폴더가 하나 이상 있고, 다시 부르면 이어 마친다. 호출자가 쓰기 잠금을 쥔다.
 */
function absorbStateFolder(source: string, dest: string): { conflicts: number } {
  const tally = { conflicts: 0 };
  const from = path.join(source, AGENT_LOCAL_STATE_FOLDER);
  const to = path.join(dest, AGENT_LOCAL_STATE_FOLDER);
  if (isDirectoryNoLink(from)) {
    closeMemoryStoresUnder(source);
    closeMemoryStoresUnder(dest);
    try { fs.mkdirSync(to); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try { fs.writeFileSync(path.join(to, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const mine = ownerIds(dest), theirs = ownerIds(source);
    const union = [...new Set([...mine, ...theirs])];
    if (union.length > mine.length) {
      const current = readJsonObject(path.join(to, AGENT_OWNER_FILE));
      writeJsonDurable(path.join(to, AGENT_OWNER_FILE), { schema: 1, ...(current ?? {}), agentId: mine[0] ?? union[0], ids: union });
    }
    const keep = path.join(to, `absorbed-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    mergeDirectory(from, to, keep, "", STATE_MARKERS, tally);
    for (const name of [ORIGIN_FILE, ".gitignore", AGENT_OWNER_FILE]) { try { fs.unlinkSync(path.join(from, name)); } catch { /* not there */ } }
    try { fs.rmdirSync(from); } catch { /* something stayed (a file this build does not know): the folder is left and reported */ }
  }
  for (const junk of [".DS_Store", "Thumbs.db"]) { try { fs.unlinkSync(path.join(source, junk)); } catch { /* none */ } }
  try { fs.rmdirSync(source); } catch { /* not empty: left in place */ }
  invalidateOwnerIndex();
  return tally;
}

/** 에이전트 루트의 폴더들을 한 번 읽어 `{id → 그 id 를 이름 붙인 폴더들}` 을 만든다(이름순; 숨은 이름의 비켜 둔 폴더도 포함). */
function scanOwners(root: string): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  let names: string[] = [];
  try { names = fs.readdirSync(root).sort(); } catch { return owners; }
  for (const name of names) {
    const folder = path.join(root, name);
    for (const id of ownerIds(folder)) owners.set(id, [...(owners.get(id) ?? []), folder]);
  }
  return owners;
}

/** 사진(`one-avatar.*`)이 폴더 맨 위에 있으면 상태 폴더로 옮긴다: 사진은 이 컴퓨터에만 있고 패키지·해시·업로드에 들지 않는다. 같은 폴더 안 rename. */
function relocatePhotos(folder: string): number {
  let moved = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(folder).filter((name) => AGENT_PHOTO_FILE.test(name)); } catch { return 0; }
  for (const name of names) {
    const target = path.join(folder, AGENT_LOCAL_STATE_FOLDER, name.toLowerCase());
    try {
      if (exists(target)) continue; // 상태 폴더에 이미 사진이 있다(더 나중에 고른 것): 맨 위의 것은 그대로 둔다
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(path.join(folder, name), target);
      moved += 1;
    } catch { /* the reader still finds it where it is */ }
  }
  return moved;
}

// ───────────────────────────── 한 단위 ─────────────────────────────

type SyncMove =
  | { ok: true; dest: string; routesRebound: boolean; realFrom: string; merged: number; photos: number }
  | { ok: false; reason: string };

function renameFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EXDEV") return "other-volume";
  if (code === "EBUSY" || (code === "EPERM" && process.platform === "win32")) return "locked"; // 백신·색인기가 잠깐 쥔 것: 다음에 다시
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "no-permission";        // 쓸 수 없는 위치: 다시 해도 같다
  if (code === "ENOENT") return "vanished";
  if (code === "ENOTEMPTY" || code === "EEXIST") return "destination-taken";
  return `rename-${code ?? "failed"}`;
}

function moveUnitSync(unit: Unit, choice: { dest: string; aside?: string }, root: string, routeOf: (id: string) => AgentRoute | undefined,
  stateFolders: ReadonlyMap<string, string[]>): SyncMove {
  const allIds = [...unit.ids, ...unit.nestedIds];
  const dest = choice.dest;
  const locked = withAgentFolderMoveLocks(allIds, (): SyncMove => {
    // 잠금 안에서 한 번 더 — 확인과 rename 사이에 실행이 시작하지 못했음을, 다른 프로세스가 이 폴더를 먼저 옮기지 않았음을 같은 잠금 아래서 본다.
    if (!isDirectoryNoLink(unit.dir)) return { ok: false, reason: "vanished" };
    if (exists(dest) && !(choice.aside && isStateOnlyFolder(dest) && ownerIds(dest).some((id) => unit.ids.includes(id)))) return { ok: false, reason: "destination-taken" };
    for (const id of allIds) {
      const blocker = agentFolderMoveBlocker(id, routeOf(id)?.path ?? unit.dir);
      if (blocker) return { ok: false, reason: blocker };
    }
    const realFrom = realOrSelf(unit.dir);
    const realOfId = new Map(allIds.map((id) => [id, realOrSelf(routeOf(id)?.path ?? unit.dir)]));
    const staged = (() => { try { return stageMarkers(unit, realFrom, hasEnginePackage(unit.dir)); } catch { return null; } })();
    if (!staged) return { ok: false, reason: "marker-write-failed" };
    closeMemoryStoresUnder(unit.dir);
    // 그 이름에 이 에이전트의 상태 폴더가 먼저 있으면 숨은 이름으로 비켜 둔다(표식은 그대로라 기억을 찾는 쪽은 계속 찾는다). 아래에서 합친다.
    let aside: string | null = null;
    if (choice.aside) {
      aside = path.join(root, `.absorbing-${path.basename(dest)}-${id6(`${unit.ids[0] ?? ""}:${Date.now()}`)}`);
      closeMemoryStoresUnder(choice.aside);
      try { fs.renameSync(choice.aside, aside); } catch { unstageMarkers(unit, staged); return { ok: false, reason: "destination-taken" }; }
    }
    try {
      fs.renameSync(unit.dir, dest);
    } catch (error) {
      unstageMarkers(unit, staged);
      if (aside) { try { fs.renameSync(aside, choice.aside!); } catch { /* the next pass absorbs the set-aside folder */ } }
      return { ok: false, reason: renameFailure(error) };
    }
    invalidateOwnerIndex();
    // ↓ 여기부터 같은 동기 구간: 이 프로세스 안에서 다른 코드가 끼어들 수 없다.
    let routesRebound = true;
    if (unit.routed) {
      try { rebindRoutesUnder(unit.dir, dest); } catch { routesRebound = false; } // 못 쓰면 다음 시작의 복구가 origin.json 으로 마친다
    }
    const realTo = realOrSelf(dest);
    if (routesRebound && unit.routed) {
      for (const id of allIds) {
        try {
          const from = realOfId.get(id) ?? realFrom;
          const relative = path.relative(realFrom, from);
          rebindAgentWorkspaceRoot(id, from, relative ? path.join(realTo, relative) : realTo);
        } catch { /* a proposal that stays pinned is re-prepared by the owner */ }
      }
    }
    const photos = relocatePhotos(dest);
    let merged = 0;
    for (const folder of new Set([...(aside ? [aside] : []), ...unit.ids.flatMap((id) => stateFolders.get(id) ?? [])])) {
      if (path.resolve(folder) === path.resolve(dest) || !isStateOnlyFolder(folder)) continue;
      try { absorbStateFolder(folder, dest); merged += 1; } catch { /* the next pass finishes the merge */ }
    }
    return { ok: true, dest, routesRebound, realFrom, merged, photos };
  });
  return "busy" in locked ? { ok: false, reason: "workspace-locked" } : locked;
}

// ───────────────────────────── 복구 ─────────────────────────────

/**
 * 라우트가 지금 없는 *옛 앱 경로*를 가리킨다: rename 뒤 라우트를 바꾸기 전에 죽었거나(kill -9·전원), 좌석 라우트가 없는 옛 자리로 적혔다(감사 29-1).
 * ① 새 폴더의 origin.json 이 그 옛 경로(`from`)를 알면 그 폴더로, ② 아니면 소유 표식이 그 에이전트를 이름 붙인 *정의* 폴더로 라우트를 맞춘다(폴더의 표식이
 * 증거다 — 추측하지 않는다: 표식 없는 폴더와 정의 없는 상태 전용 폴더는 대상이 아니다). 동기이고 새 표·저널이 없으며 다시 불러도 안전하다.
 * 사용자 폴더가 사라진 라우트는 여기서 보지 않는다 — 그런 라우트만 있으면 폴더 목록을 읽지도 않는다. main.ts 가 라우트를 읽는 어떤 것보다 먼저 부른다.
 */
export function repairInterruptedMoves(root?: string): { repaired: number; ids: string[] } {
  const result = { repaired: 0, ids: [] as string[] };
  // 에이전트 루트 이동이 도중에 끊겼으면 먼저 매듭짓는다(되돌리거나 마친다). 저널이 없는 평소에는 파일 하나를 한 번 읽고, 그 뒤로는 다시 읽지 않는다.
  if (!rootMoveJournalKnownAbsent()) recoverAgentRootMove();
  const dangling = listRoutes().filter((route) => {
    if (!route?.path || !path.isAbsolute(route.path) || exists(route.path)) return false;
    const cls = classifyAgentFolder(route.path);
    return cls.owner === "app" && cls.appRoot !== "agent-home";
  });
  if (dangling.length === 0) return result;
  const home = root ?? agentHomeRootStatus().path ?? undefined;
  for (const item of movedFolders(home)) {
    if (exists(item.from) || !exists(item.folder)) continue;
    const origin = readJsonObject(path.join(item.folder, AGENT_LOCAL_STATE_FOLDER, ORIGIN_FILE));
    const pointing = dangling.filter((route) => under(item.from, route.path));
    if (pointing.length === 0) continue;
    try {
      rebindRoutesUnder(item.from, item.folder);
    } catch { continue; } // 라우트 파일을 못 쓴다: 다음 시작에 다시
    const realFrom = typeof origin?.realFrom === "string" ? origin.realFrom : null;
    const realTo = realOrSelf(item.folder);
    for (const route of pointing) {
      result.repaired += 1;
      result.ids.push(route.agentId);
      if (!realFrom) continue;
      try {
        const relative = path.relative(path.resolve(item.from), path.resolve(route.path));
        rebindAgentWorkspaceRoot(route.agentId, relative ? path.join(realFrom, relative) : realFrom, relative ? path.join(realTo, relative) : realTo);
      } catch { /* a proposal that stays pinned is re-prepared by the owner */ }
    }
  }
  // ② 출처 표식이 없거나 읽을 수 없다(빈 파일): 소유 표식으로.
  for (const route of dangling) {
    if (result.ids.includes(route.agentId)) continue;
    try {
      if (exists(route.path)) continue;
      const row = getDb().prepare("SELECT id, slug FROM installed_agents WHERE id = ?").get(route.agentId) as RowLite | undefined;
      if (!row) continue;
      const folder = ownedAgentFolder(row, home);
      if (!folder || !isDirectoryNoLink(folder) || isStateOnlyFolder(folder)) continue;
      for (const id of rebindRoutesUnder(route.path, folder)) { if (!result.ids.includes(id)) { result.repaired += 1; result.ids.push(id); } }
    } catch { /* 다음 시작에 다시 */ }
  }
  return result;
}

/**
 * 읽을 수 없는 소유 표식(전원 차단으로 빈 파일이 된 owner.json)을 폴더의 다른 증거로 다시 쓴다: ① 그 폴더를 가리키는 라우트 ② 출처 표식의 `from` 이 어느 행의
 * 예전 스텁 경로인지 ③ 스텁의 manifest.md 가 적은 id(이 설치의 행이고 폴더 이름이 그 행의 이름일 때). 증거가 없거나 다른 폴더가 이미 그 id 를 이름 붙였으면
 * 건드리지 않는다. 죽은 프로세스가 남긴 표식 임시 파일도 지운다. 표식이 멀쩡한 폴더는 읽기만 한다.
 */
function repairOwnerMarkers(root: string, plan: Plan, owners: Map<string, string[]>): number {
  let repaired = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return 0; }
  const routedIds = new Set(plan.routes.map((route) => route.agentId));
  const stubRows = [...plan.rows.values()].filter((row) => !routedIds.has(row.id));
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const folder = path.join(root, name);
    const state = path.join(folder, AGENT_LOCAL_STATE_FOLDER);
    let stateNames: string[];
    try { if (!isDirectoryNoLink(state)) continue; stateNames = fs.readdirSync(state); } catch { continue; }
    for (const leftover of stateNames) {
      const match = /^(?:owner|origin)\.json\.tmp-(\d+)-/.exec(leftover);
      if (!match) continue;
      try { process.kill(Number(match[1]), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { try { fs.unlinkSync(path.join(state, leftover)); } catch { /* gone */ } } }
    }
    if (ownerIds(folder).length > 0) continue;
    if (!stateNames.includes(AGENT_OWNER_FILE) && !stateNames.includes(ORIGIN_FILE)) continue; // 표식을 쓴 적이 없는 폴더: 우리 것인지 알 수 없다
    let ids = plan.routes.filter((route) => route?.path && path.resolve(route.path) === folder && plan.rows.has(route.agentId)).map((route) => route.agentId);
    if (ids.length === 0) {
      const from = readJsonObject(path.join(state, ORIGIN_FILE))?.from;
      if (typeof from === "string") ids = stubRows.filter((row) => { try { return path.join(legacyAgentsRoot(), legacyFolderName(row)) === path.resolve(from); } catch { return false; } }).map((row) => row.id);
    }
    if (ids.length === 0) {
      const declared = /^\*\*id\*\*: (\S+)$/m.exec((() => { try { return fs.readFileSync(path.join(folder, "manifest.md"), "utf8"); } catch { return ""; } })())?.[1];
      const row = declared ? plan.rows.get(declared) : undefined;
      const base = row ? safeHomeName(row.slug, row.id) : null;
      if (row && !routedIds.has(row.id) && (name === base || name === `${base}-${id6(row.id)}`)) ids = [row.id];
    }
    ids = [...new Set(ids)].sort();
    if (ids.length === 0 || ids.some((id) => (owners.get(id) ?? []).some((other) => other !== folder))) continue;
    try {
      writeJsonDurable(path.join(state, AGENT_OWNER_FILE), { schema: 1, agentId: ids[0], ids, createdAt: new Date().toISOString() });
      for (const id of ids) owners.set(id, [...(owners.get(id) ?? []), folder]);
      repaired += 1;
    } catch { /* 다음 시작에 다시 */ }
  }
  return repaired;
}

/**
 * 이미 에이전트 루트에 있는 폴더의 마무리: 라우트가 가리키는데 소유 표식이 없는 폴더(엔진이 거기에 직접 만든 것)에 표식을 쓰고, 같은 에이전트의 상태 전용 폴더가
 * 따로 있으면 정의 폴더로 합치고, 맨 위에 남은 사진을 상태 폴더로 옮긴다. 이 설치의 행이 이름 붙인 폴더만 본다(에이전트 루트는 다른 설치와 함께 쓴다).
 */
function settleHomeUnits(root: string, plan: Plan, report: HomeMoveReport, onlyIds: ReadonlySet<string> | null): void {
  const routeById = new Map(plan.routes.map((route) => [route.agentId, route]));
  const owners = scanOwners(root);
  for (const unit of plan.home) {
    const allIds = [...unit.ids, ...unit.nestedIds];
    if (onlyIds && !allIds.some((id) => onlyIds.has(id))) continue;
    if (unit.ids.length === 0) continue; // 폴더 자신의 행이 없는 묶음(구성원만 라우트가 있다): 표식을 쓸 id 가 없다
    const note = (outcome: "deferred" | "permanent" | "failed", reason: string) => { report[outcome] += 1; report.entries.push({ unit: unit.dir, ids: allIds, outcome, reason }); };
    try {
      const claimed = ownerIds(unit.dir);
      if (claimed.length > 0 && !claimed.some((id) => unit.ids.includes(id))) { note("permanent", "owner-mismatch"); continue; }
      const others = [...new Set(unit.ids.flatMap((id) => owners.get(id) ?? []))].filter((folder) => path.resolve(folder) !== path.resolve(unit.dir));
      const stateOnly = others.filter((folder) => isStateOnlyFolder(folder));
      const needsMarker = unit.ids.some((id) => !claimed.includes(id));
      const hasRootPhoto = (() => { try { return fs.readdirSync(unit.dir).some((name) => AGENT_PHOTO_FILE.test(name)); } catch { return false; } })();
      if (others.length > stateOnly.length) note("permanent", "duplicate-folder"); // 같은 에이전트의 정의 폴더가 둘: 이름 규칙이 고른 쪽을 쓰고 다른 쪽은 지우지 않는다
      if (!needsMarker && stateOnly.length === 0 && !hasRootPhoto) continue;
      const state = path.join(unit.dir, AGENT_LOCAL_STATE_FOLDER);
      if (exists(state) && !isDirectoryNoLink(state)) { note("permanent", "state-folder-unsafe"); continue; }
      const busy = allIds.map((id) => agentFolderMoveBlocker(id, routeById.get(id)?.path ?? unit.dir)).find(Boolean);
      if (busy) { note("deferred", busy); continue; }
      const done = withAgentFolderMoveLocks(allIds, () => {
        if (needsMarker) {
          fs.mkdirSync(state, { recursive: true });
          try { fs.writeFileSync(path.join(state, ".gitignore"), "*\n", { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          const current = readJsonObject(path.join(state, AGENT_OWNER_FILE));
          const ids = [...new Set([...claimed, ...unit.ids])];
          writeJsonDurable(path.join(state, AGENT_OWNER_FILE), { schema: 1, createdAt: new Date().toISOString(), ...(current ?? {}), agentId: claimed[0] ?? unit.ids[0], ids });
        }
        report.photosMoved += relocatePhotos(unit.dir);
        // 한 상태 폴더의 합치기가 던져도 같은 에이전트의 다른 상태 폴더는 계속 본다. 첫 실패는 끝에 다시 던져 단위의 사유로 남는다.
        let firstFailure: unknown = null;
        for (const folder of stateOnly) { try { absorbStateFolder(folder, unit.dir); report.merged += 1; } catch (error) { firstFailure ??= error; } }
        if (firstFailure) throw firstFailure;
        return true;
      });
      if (done !== true) note("deferred", "workspace-locked");
    } catch (error) {
      if (error instanceof MemoryMergeDeferred) note(error.outcome, error.reason);
      else note("failed", `error-${(error as { code?: string })?.code ?? "unexpected"}`);
    }
  }
}

// ───────────────────────────── 제자리에 두는 에이전트의 상태 폴더·사진 ─────────────────────────────

/**
 * 옮기지 않는 에이전트(사용자 폴더를 가리켜 등록한 것, 다른 볼륨 등 옮길 수 없는 앱 폴더): 폴더는 그대로 두고 앱 쪽에만 상태 폴더를 만든다. 팀 구성원처럼
 * 다른 라우트 안쪽에 있는 것은 그 라우트의 폴더가 대표한다. 폴더가 지금 없는 에이전트는 만들지 않는다(다시 연결이 먼저). 사용자 폴더에는 아무것도 쓰지 않는다.
 */
function ensureStateDirsForUnmoved(staying: Array<{ id: string; path: string }>, rows: Map<string, RowLite>, all: AgentRoute[]): void {
  if (!agentHomeRootStatus().available) return;
  for (const item of staying) {
    const row = rows.get(item.id);
    if (!row || !isDirectory(item.path)) continue;
    const nested = all.some((other) => other.agentId !== item.id && path.resolve(other.path) !== path.resolve(item.path) && under(other.path, item.path));
    if (nested) continue;
    const result = ensureAgentStateDir({ id: row.id, slug: row.slug });
    if (!result.ok) continue;
    try { writeFileDurable(path.join(result.dir, ORIGIN_FILE), JSON.stringify({ schema: 1, kind: "registered", from: path.resolve(item.path), at: new Date().toISOString() }) + "\n", { keepExisting: true }); }
    catch { /* written by the next pass */ }
  }
}

/**
 * 예전 자리(`userData/agents/<slug>/one-avatar.*`)에 남은 사진을 그 에이전트의 상태 폴더로 옮긴다(같은 볼륨 rename; 다른 볼륨이면 제자리에서 계속 읽는다 —
 * one/avatar.ts 가 옛 자리도 읽는다). 곧 통째로 옮겨질 폴더(스텁 단위)의 사진은 폴더와 함께 간다. 사진만 있던 옛 폴더가 비면 지운다.
 */
function sweepLegacyPhotos(plan: Plan, pendingUnits: ReadonlySet<string>): number {
  let moved = 0;
  let members: Array<{ id: string; slug: string; installedSlug: string }> = [];
  try {
    members = getDb().prepare(`SELECT agent.id AS id, member.agent_slug AS slug, agent.slug AS installedSlug FROM one_org_members member
      JOIN installed_agents agent ON agent.id = member.installed_agent_id WHERE member.icon = 'one-avatar:' || agent.id`).all() as typeof members;
  } catch { return 0; } // 구세대 저장소: 좌석 표가 없다
  let legacyRoot: string;
  try { legacyRoot = legacyAgentsRoot(); } catch { return 0; }
  const routeById = new Map(plan.routes.map((route) => [route.agentId, route]));
  for (const member of members) {
    const row = plan.rows.get(member.id);
    if (!row) continue;
    for (const slug of new Set([member.slug, member.installedSlug])) {
      if (!slug || slug === "." || slug === ".." || /[\\/\u0000-\u001f\u007f]/.test(slug)) continue;
      const dir = path.join(legacyRoot, slug);
      if (pendingUnits.has(path.resolve(dir)) || !isDirectoryNoLink(dir)) continue;
      let photos: string[] = [];
      try { photos = fs.readdirSync(dir).filter((name) => AGENT_PHOTO_FILE.test(name)); } catch { continue; }
      if (photos.length === 0) continue;
      const state = ensureAgentStateDir({ id: row.id, slug: row.slug }, routeById.get(row.id));
      if (!state.ok) continue;
      for (const name of photos) {
        const target = path.join(state.dir, name.toLowerCase());
        try { if (!exists(target)) { fs.renameSync(path.join(dir, name), target); moved += 1; } } catch { /* other volume or locked: read where it is */ }
      }
      try {
        if (fs.readdirSync(dir).every((name) => name === ".DS_Store")) { try { fs.unlinkSync(path.join(dir, ".DS_Store")); } catch { /* none */ } fs.rmdirSync(dir); }
      } catch { /* not empty */ }
    }
  }
  return moved;
}

/**
 * 이 설치가 옮겼다가 그 뒤 지운 에이전트의 스텁 폴더 정리(이미 쌓인 것): 소유 표식의 id 가 이 설치의 행에 하나도 없고, 출처 표식이 *이 설치의* 예전 스텁 자리에서
 * 옮겨 왔다고 적혀 있고(에이전트 루트는 다른 설치와 함께 쓰므로 이것이 "우리 것"의 증거다), 내용이 3파일 스텁과 표식뿐일 때만 OS 휴지통으로 보낸다. 기억·스킬 등
 * 다른 것이 든 폴더는 건드리지 않는다(지운 에이전트의 기억은 묻지 않고 지우지 않는다 —).
 */
async function trashOrphanedStubs(moved: readonly MovedFolder[], plan: Plan): Promise<number> {
  let trashed = 0;
  let legacyRoot: string;
  try { legacyRoot = legacyAgentsRoot(); } catch { return 0; }
  for (const item of moved) {
    try {
      if (path.dirname(item.from) !== legacyRoot || exists(item.from)) continue;
      const ids = ownerIds(item.folder);
      if (ids.length === 0 || ids.some((id) => plan.rows.has(id))) continue;
      if (plan.routes.some((route) => route?.path && under(item.folder, route.path))) continue;
      if (!fs.readdirSync(item.folder).every((name) => STUB_FILES.has(name) || name === AGENT_LOCAL_STATE_FOLDER || name === ".DS_Store")) continue;
      if (!fs.readdirSync(path.join(item.folder, AGENT_LOCAL_STATE_FOLDER)).every((name) => STATE_MARKERS.has(name))) continue;
      const { shell } = await import("electron");
      await shell.trashItem(item.folder);
      trashed += 1;
    } catch { /* stays where it is */ }
  }
  if (trashed > 0) invalidateOwnerIndex();
  return trashed;
}

// ───────────────────────────── 옮겨진 옛 팀의 저장된 글에서 죽은 경로 ─────────────────────────────

const TEAM_TEXT_FIX = "team-root-v1";
/** 앱이 만든 팀의 가이드 4파일과 CEO 글(`commerce-team.ts` 가 쓴다). */
const TEAM_GUIDE_FILES = ["AGENTS.md", "CLAUDE.md", path.join(".claude", "CLAUDE.md"), "GEMINI.md"];
const TEAM_CEO_FILE = path.join("agents", "ceo", "AGENT.md");

/** 파일을 같은 모드의 임시 파일에 쓰고 rename 한다(링크·일반 파일이 아니면 건드리지 않는다). */
function rewriteTextFile(file: string, text: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("not-a-file"), { code: "ENOTFILE" });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, text, { encoding: "utf8", flag: "wx", mode: stat.mode & 0o777 });
    fs.chmodSync(temp, stat.mode & 0o777);
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch { /* the rename consumed it */ } }
}

/** `text` 안에 `old` 가 정확히 한 번 있으면 `next` 로 바꾼 글, 아니면 null(없거나 여러 번이면 원형이 아니다). */
function replaceOnce(text: string, old: string, next: string): string | null {
  const parts = text.split(old);
  return parts.length === 2 ? parts[0] + next + parts[1] : null;
}

/**
 * 앱이 만든 옛 팀(`generated-agent-os/.agentlas/generated-teams/<슬러그>`)이 에이전트 루트로 옮겨졌다: 새 팀을 만들 때 뺀 것과 **똑같은 조각**(CEO 글의 `root: <옛 경로>; `, 가이드의
 * `team root: <옛 경로>; `)만 그 팀의 저장된 글(CEO `AGENT.md`·가이드 4파일·CEO 행의 `system_prompt`·조직도 `meta` 행)에서 뺀다 — 안 그러면 모델이 없는 경로를 먼저 시도한다
 * (실모델 A/B 감사 35: 도구 호출 평균 3.3 → 4.3, 3/3 이 죽은 경로 먼저). 앱이 만든 팀에만(소유 표식 + `agentlas.team.json` 의 생성 표지), 한 번만(출처 표식에 `textFix` 를 적는다),
 * 글 전체가 앱이 쓴 원형 줄(`CEO of <이름>; root: <옛 경로>; <카테고리>; audience: …`)과 같을 때만: 사용자가 손으로 고친 글은 건드리지 않는다. 바뀐 것은 그 조각뿐이다.
 * 돌려주는 값은 바꾼 글의 수. 던지지 않는다(실패하면 표지를 적지 않아 다음 패스가 다시 한다).
 */
function stripDeadTeamRoot(folder: string): number {
  try {
    const originFile = path.join(folder, AGENT_LOCAL_STATE_FOLDER, ORIGIN_FILE);
    const origin = readJsonObject(originFile);
    if (!origin || origin.kind !== "moved" || origin.textFix === TEAM_TEXT_FIX || typeof origin.from !== "string") return 0;
    const teams = path.join(generatedAgentOsRoot(), ".agentlas", "generated-teams");
    if (path.dirname(path.resolve(origin.from)) !== path.resolve(teams)) return 0; // 앱이 프로젝트 없이 만든 옛 팀의 자리가 아니다
    const ids = ownerIds(folder);
    const team = readJsonObject(path.join(folder, "agentlas.team.json"));
    const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
    const name = text(team?.name), category = text(team?.category), audience = text(team?.audience), createdAt = text(team?.createdAt), slug = text(team?.slug);
    const surface = team && "sourceSurfaceId" in team ? (team.sourceSurfaceId === null ? "not linked" : text(team.sourceSurfaceId)) : null;
    if (ids.length === 0 || team?.kind !== "agentlas-generated-team" || !name || !category || !audience || !createdAt || !slug || surface === null || slug !== path.basename(origin.from)) {
      updateOrigin(folder, { textFix: "not-applicable" });
      return 0;
    }
    const froms = [...new Set([origin.from, typeof origin.realFrom === "string" ? origin.realFrom : null].filter((value): value is string => Boolean(value)))];
    const ceo = (from: string | null) => `CEO of ${name}; ${from ? `root: ${from}; ` : ""}${category}; audience: ${audience}`;
    const guide = (from: string | null) => `${from ? `team root: ${from}; ` : ""}created: ${createdAt}; source: ${surface}`;
    const fix = (value: string, form: (from: string | null) => string): string | null => {
      for (const from of froms) { const next = replaceOnce(value, form(from), form(null)); if (next !== null) return next; }
      return null;
    };
    let changed = 0;
    for (const [relative, form] of [[TEAM_CEO_FILE, ceo] as const, ...TEAM_GUIDE_FILES.map((file) => [file, guide] as const)]) {
      const file = path.join(folder, relative);
      let current: string;
      try { current = fs.readFileSync(file, "utf8"); } catch { continue; }
      const next = fix(current, form);
      if (next !== null) { rewriteTextFile(file, next); changed += 1; }
    }
    const db = getDb();
    for (const id of ids) {
      const row = db.prepare("SELECT system_prompt FROM installed_agents WHERE id = ? AND slug = ?").get(id, slug) as { system_prompt?: unknown } | undefined;
      if (!row || typeof row.system_prompt !== "string") continue;
      const next = fix(row.system_prompt, ceo);
      if (next !== null && db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ? AND system_prompt = ?").run(next, id, row.system_prompt).changes > 0) changed += 1;
      // 조직도 스펙(`meta` 의 `orgspec:<firm>` JSON)에 든 CEO 글: JSON 으로 이스케이프한 같은 조각만 바꾼다(다른 바이트는 그대로).
      for (const from of froms) {
        const escaped = (value: string) => JSON.stringify(value).slice(1, -1);
        for (const meta of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'orgspec:%' AND instr(value, ?) > 0").all(escaped(ceo(from))) as Array<{ key: string; value: string }>) {
          const nextMeta = replaceOnce(meta.value, escaped(ceo(from)), escaped(ceo(null)));
          if (nextMeta !== null && db.prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?").run(nextMeta, meta.key, meta.value).changes > 0) changed += 1;
        }
      }
    }
    updateOrigin(folder, { textFix: TEAM_TEXT_FIX });
    return changed;
  } catch { return 0; }
}

/** 이미 옮겨진 옛 팀 중 아직 글을 고치지 않은 것(옮긴 직후 죽었거나 이전 빌드가 옮긴 것). 출처 표식이 이미 읽혀 있어 새 읽기는 팀 폴더마다 한 번뿐이다. */
function stripDeadTeamRoots(moved: readonly MovedFolder[]): number {
  let changed = 0;
  let teams: string;
  try { teams = path.resolve(generatedAgentOsRoot(), ".agentlas", "generated-teams"); } catch { return 0; }
  for (const item of moved) if (path.dirname(item.from) === teams) changed += stripDeadTeamRoot(item.folder);
  return changed;
}

// ───────────────────────────── 실행이 끝났다는 신호에 다시 ─────────────────────────────

// 다시 보면 풀릴 수 있는 미룸 이유. 데몬이 끝낸 실행·다른 프로세스가 닫은 설치 저널·뒤늦게 비는 이름은 이 프로세스에 신호가 없다 → 창 `focus` 가 다시 보는 계기다.
const WAIT_FOR_RUN_END = new Set(["run-active", "workspace-locked", "file-operation-open", "pending-sync", "state-unreadable", "locked", "destination-taken",
  "cloud-transaction-open", "routes-pending", "memory-busy"]);
/** `agentFolderMoveBlocker` 가 곧바로 답하는 이유: focus 에서는 이 답이 풀렸는지만 먼저 본다(파일 몇 개). */
const BLOCKER_REASONS = new Set(["run-active", "file-operation-open", "pending-sync", "state-unreadable"]);
/** 기다리는 에이전트: 막은 이유, 막은 폴더를 가리키던 경로(`agentFolderMoveBlocker` 의 두 번째 인자), 같은 단위로 함께 막힌 에이전트들(하나라도 막혀 있으면 단위는 못 옮긴다). */
const waitingForRunEnd = new Map<string, { reason: string; root: string; group: readonly string[] }>();
let stopListeningForRunEnd: (() => void) | null = null;
let stopListeningForWindowFocus: (() => void) | null = null;
let waitingPassRunning = false;

/** 기다리던 에이전트 단위만 다시 본다. 겹쳐 오는 신호는 한 번으로 합친다. */
function repassWaiting(ids: readonly string[] = [...waitingForRunEnd.keys()]): void {
  if (waitingForRunEnd.size === 0 || waitingPassRunning || ids.length === 0) return;
  waitingPassRunning = true;
  void runAgentHomeMovePass({ onlyIds: ids })
    .then((report) => { if (report.enginePending > 0) void syncMovedFoldersWithEngine(); })
    .finally(() => { waitingPassRunning = false; });
}

/**
 * 창이 다시 보일 때: 기다리는 에이전트가 있을 때만 일을 한다. 막은 이유가 "실행 중·열린 파일 작업·동기화 대기"인 에이전트는 그 답이 풀렸는지 파일 몇 개로 먼저 보고, 풀린 것(과 다른
 * 이유로 기다리는 것)만 패스에 맡긴다 — 기다리는 에이전트가 하나라도 있으면 창을 볼 때마다 전체 계획을 두 번 세우고 루트를 세 번 훑던 것(400개에서 Main 이 약 130ms 멈춤, 감사 35-7).
 */
function onWindowFocus(): void {
  if (waitingForRunEnd.size === 0 || waitingPassRunning) return;
  const ready = new Set<string>();
  const seen = new Set<readonly string[]>();
  for (const waiting of waitingForRunEnd.values()) {
    if (seen.has(waiting.group)) continue;
    seen.add(waiting.group);
    const stillBlocked = BLOCKER_REASONS.has(waiting.reason) && waiting.group.some((id) => {
      try { return agentFolderMoveBlocker(id, waitingForRunEnd.get(id)?.root ?? waiting.root) !== null; } catch { return true; }
    });
    if (!stillBlocked) for (const id of waiting.group) ready.add(id);
  }
  repassWaiting([...ready]);
}

/** 창이 다시 보일 때의 OS 신호 하나(타이머·폴링이 아니다). 대기 집합이 비면 구독이 끊긴다. */
function listenForWindowFocus(): (() => void) {
  let cancelled = false;
  let off = (): void => { cancelled = true; };
  void import("electron").then(({ app }) => {
    if (cancelled || typeof app?.on !== "function") return;
    app.on("browser-window-focus", onWindowFocus);
    off = () => { app.removeListener("browser-window-focus", onWindowFocus); };
  }).catch(() => undefined);
  return () => off();
}

function noteWaiting(report: HomeMoveReport, onlyIds: ReadonlySet<string> | null): void {
  if (!onlyIds) waitingForRunEnd.clear(); else for (const id of onlyIds) waitingForRunEnd.delete(id);
  let routePath: Map<string, string> | null = null;
  for (const entry of report.entries) {
    if (entry.outcome !== "deferred" || !entry.reason || !WAIT_FOR_RUN_END.has(entry.reason)) continue;
    routePath ??= new Map(listRoutes().map((route) => [route.agentId, route.path]));
    for (const id of entry.ids) waitingForRunEnd.set(id, { reason: entry.reason, root: routePath.get(id) ?? entry.unit, group: entry.ids });
  }
  if (waitingForRunEnd.size === 0) {
    stopListeningForRunEnd?.(); stopListeningForRunEnd = null;
    stopListeningForWindowFocus?.(); stopListeningForWindowFocus = null;
    return;
  }
  // 실행 임대가 풀렸다는 신호(같은 프로세스의 실행): 기다리던 에이전트가 든 단위만 다시 본다.
  stopListeningForRunEnd ??= onAgentWorkspaceRunLeaseReleased((agentId) => { if (waitingForRunEnd.has(agentId)) repassWaiting([...waitingForRunEnd.keys()]); });
  // 다른 프로세스(데몬)에서 끝난 실행·열린 설치 저널은 이 프로세스가 신호를 못 받는다: 사용자가 창을 다시 보는 순간에 한 번 더 본다.
  stopListeningForWindowFocus ??= listenForWindowFocus();
}

/** 시험용: 신호 구독을 끊고 대기 목록을 비운다. */
export function resetHomeMoveWaitersForTests(): void {
  waitingForRunEnd.clear();
  stopListeningForRunEnd?.();
  stopListeningForRunEnd = null;
  stopListeningForWindowFocus?.();
  stopListeningForWindowFocus = null;
  waitingPassRunning = false;
}

// ───────────────────────────── 한 번의 실행 ─────────────────────────────

let inFlight: Promise<HomeMoveReport> | null = null;
let inFlightCoversAll = false;

/** 이동 패스가 지금 도는가 — 에이전트 루트 이동은 패스가 도는 동안 시작하지 않는다. */
export function agentHomeMovePassActive(): boolean { return inFlight !== null; }

/**
 * 이동 패스. Main(owner)만 부른다. 같은 프로세스에서 겹쳐 부르면 먼저 시작한 *전체* 실행의 결과를 같이 받는다(일부만 보는 실행이 돌고 있으면 그 뒤에 이어서 돈다 —
 * 일부의 결과를 전체의 결과로 돌려주지 않는다). 던지지 않는다. 엔진을 기다리지 않는다.
 */
export function runAgentHomeMovePass(options: HomeMoveOptions = {}): Promise<HomeMoveReport> {
  if (inFlight) return inFlightCoversAll ? inFlight : inFlight.then(() => runAgentHomeMovePass(options));
  inFlightCoversAll = !options.onlyIds;
  const task = runPass(options).then((report) => {
    // 기계가 읽는 한 줄 — 무언가 옮겼거나 고쳤거나 실패했을 때만. 옮긴 항목은 수만 남기고, 남은 항목은 이유와 함께 40개까지.
    if (report.moved + report.failed + report.recovered + report.merged + report.markersRepaired + report.photosMoved > 0 || report.skipped?.startsWith("error")
      || report.entries.some((entry) => entry.reason?.startsWith("memory-") || entry.reason?.startsWith("absorbed-") || entry.reason?.startsWith("restore-"))) {
      console.log(`[agent-home-move] ${JSON.stringify({ ...report, entries: report.entries.filter((entry) => entry.outcome !== "moved").slice(0, 40) })}`);
    }
    return report;
  }).finally(() => { if (inFlight === task) inFlight = null; });
  inFlight = task;
  return task;
}

async function runPass(options: HomeMoveOptions): Promise<HomeMoveReport> {
  const report: HomeMoveReport = {
    schema: "agentlas.agent-home-move.v2", moved: 0, alreadyHome: 0, inPlace: 0, deferred: 0, permanent: 0, failed: 0, recovered: 0, merged: 0,
    markersRepaired: 0, photosMoved: 0, enginePending: 0, complete: false, entries: [],
  };
  const onlyIds = options.onlyIds ? new Set(options.onlyIds) : null;
  try {
    if (process.env.AGENTLAS_AGENT_HOME_MOVE === "0") { report.skipped = "disabled"; return report; }
    try {
      const { openedStoreMigrationRole } = await import("../store/db");
      if (openedStoreMigrationRole() === "follower") { report.skipped = "follower"; return report; }
    } catch { /* role unknown: this is Main */ }
    // 에이전트 루트를 옮기는 중이다: 옛 루트를 다루지 않는다 — 커밋 뒤 다음 패스가 새 루트를 본다.
    if (agentRootMoveActive()) { report.skipped = "root-move"; return report; }
    const status = agentHomeRootStatus();
    // 설정된 루트가 지금 없다(드라이브 분리 등): 기본 루트로 떨어져 옮기지 않는다 — 돌아오면 에이전트가 두 곳으로 갈린다.
    if (!status.available) { report.skipped = `root-${status.reason}`; return report; }
    const root = status.path;
    const yieldToLoop = options.yieldToLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));

    const repaired = repairInterruptedMoves(root);
    report.recovered = repaired.repaired;
    if (repaired.repaired > 0) report.entries.push({ unit: "(interrupted moves)", ids: repaired.ids, outcome: "moved", reason: "recovered" });
    // 복사형 루트 이동 뒤 남겨 둔 이전 루트: 보존 기간이 지났으면 앱이 여기서 정리한다(저널이 있을 때만 들어온다 — 신호도 타이머도 아니고 이 패스가 부른 것).
    if (rootMoveRetirementMayBeDue()) {
      const retired = await retireOldAgentRoot({ signal: options.signal });
      if (retired.ok && retired.removed) report.entries.push({ unit: "(retired agent root)", ids: [], outcome: "moved", reason: "old-root-retired" });
      else if (!retired.ok && retired.code === "retire_blocked") report.entries.push({ unit: "(retired agent root)", ids: [], outcome: "deferred", reason: `old-root-${retired.blocked ?? "blocked"}` });
    }
    // 끝나지 않은 설치 트랜잭션은 먼저 마무리한다(읽기용 복구: 던지지 않는다). 남은 저널의 폴더는 이번에 옮기지 않는다.
    try { (await import("../cloud-agents/registry-transaction")).recoverCloudRegistryTransactionsForRead(); } catch { /* reported by the transaction itself */ }
    const openTransactions = openCloudRegistryFolders();

    const plan = planUnits();
    const routeById = new Map(plan.routes.map((route) => [route.agentId, route]));
    const routeOf = (id: string) => routeById.get(id);
    if (exists(root)) report.markersRepaired = repairOwnerMarkers(root, plan, scanOwners(root));
    report.inPlace = plan.inPlace.length;
    report.alreadyHome = plan.home.length;
    const staying: Array<{ id: string; path: string }> = plan.inPlace.map((route) => ({ id: route.agentId, path: route.path }));

    // 이 에이전트들을 이름 붙인 폴더가 에이전트 루트에 이미 있는가(정의보다 먼저 생긴 상태 폴더) — 한 번만 읽는다.
    const stateFolders = scanOwners(root);
    let touched = false;
    const stillPending = new Set<string>();
    for (const unit of plan.units) {
      const ids = [...unit.ids, ...unit.nestedIds];
      if (onlyIds && !ids.some((id) => onlyIds.has(id))) { stillPending.add(path.resolve(unit.dir)); continue; }
      if (options.signal?.aborted) { report.skipped = "aborted"; break; }
      await yieldToLoop();
      const entry: MoveEntry = { unit: unit.dir, ids, outcome: "deferred" };
      const settle = (reason: string) => {
        entry.reason = reason;
        if (DEFER_REASONS.has(reason)) { entry.outcome = "deferred"; report.deferred += 1; stillPending.add(path.resolve(unit.dir)); }
        else if (PERMANENT_REASONS.has(reason)) { entry.outcome = "permanent"; report.permanent += 1; for (const id of unit.ids) staying.push({ id, path: routeOf(id)?.path ?? unit.dir }); }
        else { entry.outcome = "failed"; report.failed += 1; stillPending.add(path.resolve(unit.dir)); }
        report.entries.push(entry);
      };
      try {
        const blocker = unitBlocker(unit, root, routeOf, openTransactions);
        if (blocker) { settle(blocker); continue; }
        fs.mkdirSync(root, { recursive: true });
        const choice = chooseDestination(unit, root);
        if ("reason" in choice) { settle(choice.reason); continue; }
        const moved = moveUnitSync(unit, choice, root, routeOf, stateFolders);
        if (!moved.ok) { settle(moved.reason); continue; }
        touched = true;
        if (unit.appRoot === "generated-agent-os") stripDeadTeamRoot(moved.dest); // 옮긴 옛 팀의 저장된 글에서 죽은 경로 조각만 뺀다(없으면 아무것도 안 바뀐다)
        entry.outcome = "moved"; entry.to = moved.dest; report.moved += 1; report.merged += moved.merged; report.photosMoved += moved.photos;
        entry.engine = hasEnginePackage(moved.dest) ? "pending" : "none";
        if (entry.engine === "pending") report.enginePending += 1;
        if (!moved.routesRebound) entry.reason = "routes-pending"; // 다음 시작의 복구가 라우트를 마친다 — 그 전에는 엔진에 알리지 않는다
        report.entries.push(entry);
      } catch (error) {
        settle(`error-${(error as { code?: string })?.code ?? "unexpected"}`);
      }
    }

    if (!report.skipped) {
      await yieldToLoop();
      const before = report.merged + report.photosMoved;
      try { settleHomeUnits(root, planUnits(), report, onlyIds); } catch { /* the next pass settles them */ }
      if (!onlyIds) {
        ensureStateDirsForUnmoved(staying, plan.rows, plan.routes);
        try { report.photosMoved += sweepLegacyPhotos(plan, stillPending); } catch { /* photos are read where they are */ }
        const moved = movedFolders(root);
        try { await trashOrphanedStubs(moved, plan); } catch { /* leftovers stay */ }
        try { stripDeadTeamRoots(moved); } catch { /* the next pass tries again */ }
        try { sweepAbsorbed(root, report); } catch { /* the next pass tries again */ }
        try { sweepRestoreLeftovers(root, report); } catch { /* the next pass tries again */ }
      }
      if (report.merged + report.photosMoved > before) touched = true;
    }
    if (report.moved > 0) {
      // 라우트 파일은 다른 프로세스(데몬·엔진)도 쓴다: 이 실행 도중 그쪽의 쓰기가 방금 바꾼 경로를 옛 값으로 되돌렸다면 여기서 다시 맞춘다(끊긴 라우트가 없으면 아무것도 읽지 않는다).
      try { const again = repairInterruptedMoves(root); report.recovered += again.repaired; } catch { /* the next start repairs it */ }
    }
    if (touched || report.recovered > 0) {
      try { (await import("../store/change-bus")).emitDesktopStoreChange({ entity: "agent" }); } catch { /* the next read sees it */ }
    }
    report.complete = !report.skipped && report.deferred === 0 && report.failed === 0;
    noteWaiting(report, onlyIds);
  } catch (error) {
    report.skipped = `error-${(error as { code?: string })?.code ?? "unexpected"}`;
  }
  return report;
}

// ───────────────────────────── 엔진 ─────────────────────────────

export interface EngineSyncReport {
  /** 이번에 엔진이 새 경로로 등록한 폴더. */
  registered: number;
  /** 아직 알리지 못한 폴더(다음 시작에 다시). */
  pending: number;
  /** 엔진이 답하지 않아 이번 실행을 멈춘 이유. */
  stopped?: "engine-unavailable" | "aborted";
}

export function defaultHomeMoveEngine(): HomeMoveEngine {
  const run = async <T,>(args: string[]): Promise<T | null> => {
    try {
      const { runHephaestus } = await import("../hephaestus/engine");
      const result = await runHephaestus<T>("agentlas_cloud", args, { timeoutMs: 60_000 });
      return result.json ?? null;
    } catch { return null; }
  };
  return {
    async registeredRoots() {
      const json = await run<{ registrations?: Array<{ sourceRoot?: unknown }> }>(["workforce", "local-list"]);
      if (!json || !Array.isArray(json.registrations)) return null;
      return json.registrations.map((row) => row?.sourceRoot).filter((value): value is string => typeof value === "string" && value.length > 0);
    },
    async register(root) {
      const json = await run<{ status?: unknown; movedFrom?: unknown; error?: unknown }>(["workforce", "local-register", root]);
      if (!json) return null;
      const bad = typeof json.status === "string" && /quarantin|reject|error|fail/i.test(json.status);
      return { ok: !bad && json.error === undefined, ...(typeof json.movedFrom === "string" ? { movedFrom: json.movedFrom } : {}) };
    },
  };
}

let engineInFlight: Promise<EngineSyncReport> | null = null;

/**
 * 옮긴 폴더를 엔진 레지스트리에 알린다 — 이동·라우트가 *끝난 뒤*에, 이동과 따로. 엔진이 예전부터 알던 폴더만 새 경로로 등록한다(엔진이 내용이 같고 옛 폴더가
 * 사라진 정의를 "옮김"으로 알아보고 id 를 유지한다). 엔진이 한 번 답하지 않으면 그 실행을 멈추고 나머지는 `pending` 으로 둔다: 다음 시작이 다시 하고, 몇 번
 * 실패했는지는 세지 않는다(감사 29-7: 단위마다 60초씩 직렬로 기다렸고 5번 뒤 영영 포기했다). 엔진이 "안 된다"고 *답한* 폴더는 `refused` 로 적고 다시 묻지 않는다.
 * 겹쳐 부르면 먼저 시작한 실행의 결과를 같이 받는다. 던지지 않는다. 새 폴더들의 origin.json 만 읽는다.
 */
export function syncMovedFoldersWithEngine(options: { engine?: HomeMoveEngine; signal?: AbortSignal } = {}): Promise<EngineSyncReport> {
  if (engineInFlight) return engineInFlight;
  const task = runEngineSync(options).catch((): EngineSyncReport => ({ registered: 0, pending: 0 })).finally(() => { if (engineInFlight === task) engineInFlight = null; });
  engineInFlight = task;
  return task;
}

async function runEngineSync(options: { engine?: HomeMoveEngine; signal?: AbortSignal }): Promise<EngineSyncReport> {
  const report: EngineSyncReport = { registered: 0, pending: 0 };
  const status = agentHomeRootStatus();
  if (!status.available || process.env.AGENTLAS_AGENT_HOME_MOVE === "0") return report;
  const waiting: Array<{ folder: string; from: string[] }> = [];
  let names: string[] = [];
  try { names = fs.readdirSync(status.path); } catch { return report; }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const folder = path.join(status.path, name);
    const origin = readJsonObject(path.join(folder, AGENT_LOCAL_STATE_FOLDER, ORIGIN_FILE));
    // `abandoned` 는 예전 빌드가 다섯 번 실패하고 굳힌 값이다: 다시 시도한다.
    if (!origin || origin.kind !== "moved" || (origin.engine !== "pending" && origin.engine !== "abandoned") || typeof origin.from !== "string") continue;
    if (!hasEnginePackage(folder)) { updateOrigin(folder, { engine: "none" }); continue; }
    waiting.push({ folder, from: [origin.from, ...(typeof origin.realFrom === "string" ? [origin.realFrom] : [])] });
  }
  if (waiting.length === 0) return report;
  report.pending = waiting.length;
  const engine = options.engine ?? defaultHomeMoveEngine();
  const roots = await engine.registeredRoots().catch(() => null);
  if (roots === null) { report.stopped = "engine-unavailable"; return report; }
  const known = new Set(roots.map((root) => path.resolve(root)));
  for (const item of waiting) {
    if (options.signal?.aborted) { report.stopped = "aborted"; break; }
    // 라우트가 아직 옛 경로를 가리키면 엔진에 새 경로를 알리지 않는다(순서: 라우트 먼저 — 아니면 같은 에이전트가 새 임포트로 한 번 더 들어온다,).
    if (listRoutes().some((route) => route?.path && under(item.from[0], route.path) && !exists(route.path))) continue;
    if (!item.from.some((dir) => known.has(path.resolve(dir)))) { updateOrigin(item.folder, { engine: "not-registered" }); report.pending -= 1; continue; }
    const result = await engine.register(item.folder).catch(() => null);
    if (result === null) { report.stopped = "engine-unavailable"; break; }
    updateOrigin(item.folder, { engine: result.ok ? "registered" : "refused" });
    report.pending -= 1;
    if (result.ok) report.registered += 1;
  }
  return report;
}
