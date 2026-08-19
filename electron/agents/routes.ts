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

function readAll(): Record<string, AgentRoute> {
  try {
    const raw = fs.readFileSync(routesFile(), "utf8");
    const obj = JSON.parse(raw) as Record<string, AgentRoute>;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, AgentRoute>): void {
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
  const map = readAll();
  map[route.agentId] = route;
  writeAll(map);
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
        map[agentId] = next;
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
        map[agentId] = { ...route, missingSince: now };
        updated += 1;
      }
      missing += 1;
    }
  }
  if (updated > 0) writeAll(map);
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
      map[agentId] = { ...route, source: "local-import", definitionHash };
      updated += 1;
    } catch {
      failed += 1;
      missing += 1;
      map[agentId] = { ...route, missingSince: now };
      updated += 1;
    }
  }
  if (updated > 0) writeAll(map);
  return { scanned, updated, failed, missing };
}

/**
 * Atomically replace one route while removing stale identities for the same
 * source folder. Used by local import so a repaired dangling route never
 * survives beside the new installed-agent id.
 */
export function replaceRoute(route: AgentRoute, removeAgentIds: string[] = []): void {
  const map = readAll();
  for (const agentId of removeAgentIds) delete map[agentId];
  map[route.agentId] = route;
  writeAll(map);
}

export function removeRoute(agentId: string): void {
  const map = readAll();
  if (map[agentId]) {
    delete map[agentId];
    writeAll(map);
  }
}
