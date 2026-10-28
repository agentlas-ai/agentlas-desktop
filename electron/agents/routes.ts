// 에이전트 위치 라우팅 설정 — 로컬에서 임포트한 원본과 Agent Cloud에서 복원한 실행 사본이
// "어느 폴더에 있고, 어떤 CLI 런타임 전용인지"를 영구 저장한다. userData/agent-routes.json.
// source/packageHash는 자산 출처와 복원 버전을 UI·진단에 전달하며, 구버전 레코드와의 호환을
// 위해 optional이다(누락된 기존 route는 local-import로 해석).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { computeLocalAgentDefinitionHash } from "./definition-hash";
import { userDataPath } from "../runtime-paths";

export type RuntimeLabel = "claude-code" | "codex" | "gemini" | "cursor" | "generic";

export interface AgentRoute {
  /** installed_agents.id */
  agentId: string;
  /** 원본 로컬 폴더 절대경로 */
  path: string;
  /** 주 런타임 라벨 */
  runtime: RuntimeLabel;
  /** 감지된 모든 라벨 (팀은 여러 개일 수 있음) */
  labels: RuntimeLabel[];
  /** 단일 에이전트인지 팀인지 */
  kind: "agent" | "team";
  importedAt: string;
  /** 파일의 권위 출처. 구버전에서 누락됐으면 local-import. */
  source?: "local-import" | "agent-cloud" | "hub";
  /** Agent Cloud에서 복원한 불변 package hash. */
  packageHash?: string;
  /** Legacy/local-only AgentDefinition fingerprint. Never a Hub release claim. */
  definitionHash?: string;
  /**
   * ISO time when the source folder was first observed to be unreadable.
   *
   * A local agent whose folder was deleted or moved otherwise stays in the list
   * forever with no way to tell why it is broken. This is deliberately NOT an
   * auto-delete signal: an external disk, a cloud-synced folder, or a rename can
   * make a perfectly good agent look missing for a while, and silently deleting
   * a user's agent (and its chats) over that would be unrecoverable. It only
   * lets the UI say "this folder is gone" and offer repair/remove.
   *
   * Cleared as soon as the folder reads again.
   */
  missingSince?: string;
}

function routesFile(): string {
  return userDataPath("agent-routes.json");
}

// Process-local generation for route mutations. Consumers that cache a repair
// pass can use this to notice a same-process backfill without rescanning the
// route file on every picker read. A fresh process starts at zero and performs
// its first repair normally.
let routesRevision = 0;

// 파일이 안 바뀌었으면 다시 파싱하지 않는다 — getRoute 가 에이전트 목록의 행마다 불려 같은 JSON 을 N번 읽었다(2026-09-14).
let readCache: { file: string; mtimeMs: number; size: number; map: Record<string, AgentRoute> } | null = null;
function readAll(): Record<string, AgentRoute> {
  const file = routesFile();
  try {
    const stat = fs.statSync(file);
    if (readCache && readCache.file === file && readCache.mtimeMs === stat.mtimeMs && readCache.size === stat.size) return readCache.map;
    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw.replace(/^﻿/, "")) as Record<string, AgentRoute>;
    const map = obj && typeof obj === "object" ? obj : {};
    readCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, map };
    return map;
  } catch {
    readCache = null;
    return {};
  }
}

function writeAll(map: Record<string, AgentRoute>): void {
  readCache = null;
  const target = routesFile();
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, JSON.stringify(map, null, 2) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
    fsyncDirectoryBestEffort(parent);
    routesRevision += 1;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // A successful rename consumes the temporary path. Failed cleanup is
      // intentionally best-effort; the live routes file was never truncated.
    }
  }
}

export function getRoutesRevision(): number {
  return routesRevision;
}

/*
 * Read-modify-write for agent-routes.json. readAll() above is for readers: it folds every read failure into {}.
 * A writer that starts from that {} and saves one route wipes every other route (and a writer that read earlier
 * loses whatever another process — the Terminal engine shares this file — saved in between). So a writer:
 *   ① treats only a missing/empty file as empty, ② retries transient errors (EPERM/EBUSY while another process
 *   renames the file) and half-written content briefly, ③ preserves a file that stays unparseable as
 *   `<file>.corrupt-<ts>` and continues from the routes it can still read, ④ commits only if the file is unchanged
 *   since it was read, otherwise re-reads and re-applies its change. Mirror of agentlas_terminal/engine/json-state-file.cjs.
 */
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EAGAIN", "EMFILE", "ENFILE"]);
const ROUTES_READ_ATTEMPTS = 6;
const ROUTES_CAS_ATTEMPTS = 8;
const ROUTES_WRITE_ATTEMPTS = 4;
const routesWaitCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(routesWaitCell, 0, 0, ms);
}

function routesFingerprint(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unknown";
  }
}

type RoutesFileState =
  | { status: "ok"; map: Record<string, AgentRoute>; fingerprint: string }
  | { status: "absent"; fingerprint: string }
  | { status: "empty"; fingerprint: string }
  | { status: "corrupt"; raw: string; fingerprint: string }
  | { status: "unreadable"; code: string; fingerprint: string };

function readRoutesFileState(file: string): RoutesFileState {
  let last: RoutesFileState = { status: "unreadable", code: "EREAD", fingerprint: "unknown" };
  for (let attempt = 0; attempt < ROUTES_READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleepSync(20 * attempt);
    const fingerprint = routesFingerprint(file);
    if (fingerprint === "absent") return { status: "absent", fingerprint };
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return { status: "absent", fingerprint: "absent" };
      last = { status: "unreadable", code: code ?? "EREAD", fingerprint };
      continue;
    }
    if (!raw.trim()) return { status: "empty", fingerprint };
    try {
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { status: "ok", map: parsed as Record<string, AgentRoute>, fingerprint };
      }
    } catch {
      /* corrupt — recorded below */
    }
    last = { status: "corrupt", raw, fingerprint };
  }
  return last;
}

// Closed route objects are flat (no nested braces), so a truncated file still yields every route written before the cut.
function salvageRoutes(raw: string): Record<string, AgentRoute> {
  const map: Record<string, AgentRoute> = {};
  for (const match of raw.matchAll(/"([^"\\]+)"\s*:\s*(\{[^{}]*\})/g)) {
    try {
      const route = JSON.parse(match[2]) as AgentRoute;
      if (route && typeof route.path === "string" && route.agentId === match[1]) map[match[1]] = route;
    } catch {
      /* closed but not JSON — drop */
    }
  }
  return map;
}

function quarantineRoutesFile(file: string, raw: string): string {
  const target = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 4)}`;
  try {
    fs.writeFileSync(target, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (cause) {
    throw Object.assign(new Error(`json_state_quarantine_failed: could not preserve ${file} before repairing it`), {
      code: "json_state_quarantine_failed",
      cause,
    });
  }
  return target;
}

function writeAllWithRetry(map: Record<string, AgentRoute>): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeAll(map);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt + 1 >= ROUTES_WRITE_ATTEMPTS || !code || !TRANSIENT_FS_CODES.has(code)) throw error;
      sleepSync(25 * 2 ** attempt);
    }
  }
}

/** mutate edits the freshly read map in place; return false when nothing changed (no write). */
function updateRoutes(mutate: (map: Record<string, AgentRoute>) => boolean | void): void {
  const file = routesFile();
  for (let attempt = 0; ; attempt += 1) {
    const state = readRoutesFileState(file);
    let base: Record<string, AgentRoute>;
    if (state.status === "ok") {
      base = state.map;
    } else if (state.status === "absent" || state.status === "empty") {
      base = {};
    } else if (state.status === "corrupt") {
      const preserved = quarantineRoutesFile(file, state.raw);
      console.warn(`[agent-routes] json_state_corrupt_quarantined: original kept at ${preserved}`);
      base = salvageRoutes(state.raw);
    } else {
      throw Object.assign(new Error(`json_state_unreadable: ${file} could not be read (${state.code}); it was left untouched`), {
        code: "json_state_unreadable",
      });
    }
    if (mutate(base) === false) return;
    // The last attempt skips the fingerprint check: merging into the content just read beats refusing to save.
    if (attempt + 1 < ROUTES_CAS_ATTEMPTS && routesFingerprint(file) !== state.fingerprint) {
      sleepSync(10 + Math.floor(Math.random() * 30));
      continue;
    }
    writeAllWithRetry(base);
    return;
  }
}

/** Apply values computed from an earlier snapshot only where the route is still exactly what that snapshot saw. */
function applyRoutePatches(patches: Map<string, { before: AgentRoute; after: AgentRoute }>): void {
  if (patches.size === 0) return;
  try {
    updateRoutes((map) => {
      let changed = false;
      for (const [agentId, { before, after }] of patches) {
        const current = map[agentId];
        if (current && JSON.stringify(current) === JSON.stringify(before)) {
          map[agentId] = after;
          changed = true;
        }
      }
      return changed;
    });
  } catch (error) {
    // Startup maintenance must never stop the app: an unwritable routes file is retried by the next pass.
    console.warn(`[agent-routes] route maintenance deferred: ${(error as { code?: string })?.code ?? "unknown"}`);
  }
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
    // Some supported filesystems do not allow directory fsync. The same-dir
    // rename still guarantees readers see either the complete old or new map.
  }
}

export function getRoute(agentId: string): AgentRoute | null {
  return readAll()[agentId] ?? null;
}

export function listRoutes(): AgentRoute[] {
  return Object.values(readAll());
}

export function setRoute(route: AgentRoute): void {
  updateRoutes((map) => {
    map[route.agentId] = route;
  });
}

/**
 * Reconcile exact local AgentDefinition fingerprints for legacy routes.
 * Only the value-free hash is persisted; paths stay in the existing private
 * route record and no package, Memory or Experience content is copied.
 */
export function reconcileLocalRouteDefinitionHashes(): {
  scanned: number;
  updated: number;
  failed: number;
  missing: number;
} {
  const map = readAll();
  // Computed from this snapshot, merged into the freshly read file only where a route is still unchanged
  // (a hash walk can take long; a route saved meanwhile by another process must not be overwritten by it).
  const patches = new Map<string, { before: AgentRoute; after: AgentRoute }>();
  let scanned = 0;
  let updated = 0;
  let failed = 0;
  let missing = 0;
  const now = new Date().toISOString();
  for (const [agentId, route] of Object.entries(map)) {
    if (route.source === "agent-cloud" || route.source === "hub") continue;
    scanned += 1;
    try {
      const definitionHash = computeLocalAgentDefinitionHash(route.path);
      // The folder read, so any earlier missing mark is stale — a moved or
      // temporarily unmounted folder must recover silently.
      if (
        route.definitionHash !== definitionHash ||
        route.source !== "local-import" ||
        route.missingSince
      ) {
        const next = { ...route, source: "local-import" as const, definitionHash };
        delete next.missingSince;
        patches.set(agentId, { before: route, after: next });
        updated += 1;
      }
    } catch {
      failed += 1;
      // Record WHEN the folder went missing instead of only counting the
      // failure. Without this the agent stays in the roster forever with no
      // explanation and no repair path. Never delete here: absence can be
      // temporary (external disk, cloud sync, rename) and deleting a user's
      // agent and chats over it is unrecoverable.
      if (!route.missingSince) {
        patches.set(agentId, { before: route, after: { ...route, missingSince: now } });
        updated += 1;
      }
      missing += 1;
    }
  }
  applyRoutePatches(patches);
  return { scanned, updated, failed, missing };
}

/**
 * Startup-only migration for routes created before definitionHash existed.
 *
 * A full reconciliation recursively fingerprints as many as 2,000 definition
 * files per local route. Repeating that synchronous disk walk on every launch
 * blocked Electron's main thread for minutes on large skill libraries and made
 * the already-visible window beachball. Imports already compute a fresh hash,
 * while explicit repair/diagnostic flows can still call the full reconciler
 * above. Startup therefore touches only genuinely legacy, not-yet-attempted
 * routes and never turns a durable cache into a mandatory rescan.
 */
export function backfillLegacyLocalRouteDefinitionHashes(): {
  scanned: number;
  updated: number;
  failed: number;
  missing: number;
} {
  const map = readAll();
  const patches = new Map<string, { before: AgentRoute; after: AgentRoute }>();
  let scanned = 0;
  let updated = 0;
  let failed = 0;
  let missing = 0;
  const now = new Date().toISOString();
  for (const [agentId, route] of Object.entries(map)) {
    if (
      route.source === "agent-cloud"
      || route.source === "hub"
      || route.definitionHash
      || route.missingSince
    ) continue;
    scanned += 1;
    try {
      const definitionHash = computeLocalAgentDefinitionHash(route.path);
      patches.set(agentId, { before: route, after: { ...route, source: "local-import", definitionHash } });
      updated += 1;
    } catch {
      failed += 1;
      missing += 1;
      patches.set(agentId, { before: route, after: { ...route, missingSince: now } });
      updated += 1;
    }
  }
  applyRoutePatches(patches);
  return { scanned, updated, failed, missing };
}

/**
 * Atomically replace one route while removing stale identities for the same
 * source folder. Used by local import so a repaired dangling route never
 * survives beside the new installed-agent id.
 */
export function replaceRoute(route: AgentRoute, removeAgentIds: string[] = []): void {
  updateRoutes((map) => {
    for (const agentId of removeAgentIds) delete map[agentId];
    map[route.agentId] = route;
  });
}

export function removeRoute(agentId: string): void {
  updateRoutes((map) => {
    if (!map[agentId]) return false;
    delete map[agentId];
    return true;
  });
}
