// 에이전트 위치 라우팅 설정 — 로컬에서 임포트한 원본과 Agent Cloud에서 복원한 실행 사본이
// "어느 폴더에 있고, 어떤 CLI 런타임 전용인지"를 영구 저장한다. userData/agent-routes.json.
// source/packageHash는 자산 출처와 복원 버전을 UI·진단에 전달하며, 구버전 레코드와의 호환을
// 위해 optional이다(누락된 기존 route는 local-import로 해석).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";

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
}

function routesFile(): string {
  return path.join(app.getPath("userData"), "agent-routes.json");
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
