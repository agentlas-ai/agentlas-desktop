// 에이전트 폴더 "다시 연결"과 에이전트별 정의 위치 바꾸기.
//
// ★ 복사하지 않는다. 상태(`.agentlas-local`, 기억)는 항상 `agentsRoot()/<이름>/` 에 그대로 있고, 여기서 바꾸는 것은 *정의가 어디 있는가*(라우트 `agent-routes.json`,
//   정의 위치의 정본)와 *루트가 어디를 가리키는가*(설정 파일 `agents-root.json`) 둘뿐이다. 위치 표식 파일·심볼릭 링크·세 번째 등록부는 없다. 사용자 폴더에는 아무것도 쓰지 않는다.
// ★ 폴더가 사라졌을 때(드라이브 분리·이름 변경)의 규칙은 한 줄이다: 에이전트 행은 목록에 남고, 턴은 DB 에 둔 정본 프롬프트로 돌며(`files.ts readAgentPromptSource`),
//   기억·대화는 지워지지 않는다. 이 파일은 그 상태를 *읽어* 보여 주고(`agentFolderStatus`) 다시 이어 주는 쪽(`reconnectAgentRoot`, `setAgentDefinitionLocation`)만 맡는다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentFolderStatusView, AgentLocationOutcome, AgentRootRefusal } from "../../shared/agent-root";
import { getDb } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import { emitDesktopStoreChange } from "../store/change-bus";
import { userDataDir } from "../runtime-paths";
import { agentHomeRootStatus, agentStateDir, agentlasHomeDir, invalidateOwnerIndex, ownedAgentFolder, ownerIds } from "./home";
import { getRoute, rebindRoutesUnder, listRoutes, setRoute, type AgentRoute } from "./routes";
import { readCanonicalPromptFromDirectory } from "./prompt-authority";
import { agentFolderMoveBlocker, rebindAgentWorkspaceRoot, withAgentFolderMoveLocks } from "./workspace-service";
import { defaultHomeMoveEngine, type HomeMoveEngine } from "./home-move";
import { agentFoldersIn, agentIdsIn, agentRootMoveBusy, noteAgentRootReconnected, writeAgentsRootSetting } from "./root-move";

interface Row { id: string; slug: string }
function rowOf(agentId: string): Row | null {
  if (typeof agentId !== "string" || !agentId) return null;
  try { return (getDb().prepare("SELECT id, slug FROM installed_agents WHERE id = ?").get(agentId) as Row | undefined) ?? null; } catch { return null; }
}
const exists = (target: string): boolean => { try { fs.lstatSync(target); return true; } catch { return false; } };
const isDir = (target: string): boolean => { try { return fs.statSync(target).isDirectory(); } catch { return false; } };
const fold = (value: string): string => (process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value);
const insideOrSame = (root: string, target: string): boolean => { const relative = path.relative(fold(path.resolve(root)), fold(path.resolve(target))); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
const realOrSelf = (target: string): string => { try { return fs.realpathSync.native(target); } catch { return path.resolve(target); } };

/**
 * 이 에이전트의 폴더가 지금 어떤 상태인가(읽기만 한다). 화면은 `root-unavailable`·`folder-missing` 일 때 "폴더를 찾을 수 없음 — 다시 연결" 칩을 보여 준다.
 * 목록에서 에이전트를 빼는 근거로 쓰지 않는다(행은 DB 에 있다).
 */
export function agentFolderStatus(agentId: string): AgentFolderStatusView | null {
  const row = rowOf(agentId);
  if (!row) return null;
  const root = agentHomeRootStatus();
  const route = getRoute(agentId);
  const stateDir = agentStateDir(row, route);
  if (route?.path) {
    if (exists(route.path)) return { agentId, state: "ok", path: route.path, stateDir, reconnectable: false };
    const underRoot = root.path ? insideOrSame(root.path, route.path) : false;
    return { agentId, state: !root.available && underRoot ? "root-unavailable" : "folder-missing", path: route.path, stateDir, reconnectable: true };
  }
  if (!root.available) return { agentId, state: "root-unavailable", path: null, stateDir: null, reconnectable: true };
  const owned = ownedAgentFolder(row, root.path);
  return owned ? { agentId, state: "ok", path: owned, stateDir, reconnectable: false } : { agentId, state: "no-folder", path: null, stateDir, reconnectable: false };
}

/** `agents` = 고른 폴더에서 찾은 *이 계정의* 에이전트 수(소유 표식의 id 가 내 에이전트 목록에 있는 것) — 화면이 "내 에이전트 N개를 찾았습니다"를 보여 준다. `folders` 는 소유 표식이 있는 폴더 전부(남의 것 포함). */
export type ReconnectRootResult = { ok: true; path: string; folders: number; agents: number; routesRebound: number; revertedTo?: true } | { ok: false; code: AgentRootRefusal };

/** 다시 연결 직전의 루트: 잘못 연결했을 때 이전 위치로 돌아가는 길. 앱 DB 의 키 하나(`getMeta`) — 읽는 곳은 `reconnectAgentRoot` 뿐, 지우는 때는 되돌아갈 때·현재 루트가 그 연결의 루트가 아닐 때(읽을 때 비운다). */
const RECONNECT_PREVIOUS_KEY = "agents_root_reconnect_previous:v1";
function readReconnectPrevious(currentRoot: string | null): string | null {
  try {
    const raw = getMeta(RECONNECT_PREVIOUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { from?: unknown; to?: unknown };
    if (typeof parsed.from === "string" && typeof parsed.to === "string" && currentRoot && fold(path.resolve(parsed.to)) === fold(path.resolve(currentRoot))) return parsed.from;
    setMeta(RECONNECT_PREVIOUS_KEY, ""); // 그 사이 루트가 다시 바뀌었다(이동·다른 연결): 이 기록은 쓸모없다
  } catch { /* no store here */ }
  return null;
}
function writeReconnectPrevious(value: { from: string; to: string } | null): void { try { setMeta(RECONNECT_PREVIOUS_KEY, value ? JSON.stringify(value) : ""); } catch { /* no store here */ } }
/** 내 에이전트(`installed_agents`)의 id 집합. */
function installedIds(): Set<string> {
  try { return new Set((getDb().prepare("SELECT id FROM installed_agents").all() as Array<{ id: string }>).map((row) => row.id)); } catch { return new Set(); }
}

/**
 * 루트가 사라졌을 때(드라이브가 빠졌거나 이름이 바뀌었다) 그 폴더를 다시 가리킨다 — 복사하지 않는다. 지금 루트가 읽히면 거절한다(`root_available`: 루트를 바꾸려면 이동을 쓴다).
 * 단, 지금 루트에 내 에이전트가 하나도 없거나(엉뚱한 폴더에 연결돼 있다) 직전 다시 연결의 이전 루트로 되돌아가는 것이면 받는다.
 * 고른 폴더에 *이 계정의 에이전트*(소유 표식의 id 가 내 에이전트 목록에 있는 것)가 하나도 없는데 DB 에 에이전트가 있으면 거절한다(`target_has_no_agents`: 남의 폴더·남의 계정의 백업·빈 폴더를 가리키면 기억이 사라진 것처럼 보이고 기억이 두 곳으로 갈린다).
 */
export function reconnectAgentRoot(target: unknown): ReconnectRootResult {
  const refuse = (code: AgentRootRefusal): ReconnectRootResult => ({ ok: false, code });
  const pinned = process.env.AGENTLAS_AGENT_HOME?.trim();
  if (pinned && path.isAbsolute(pinned)) return refuse("root_pinned_by_env");
  if (typeof target !== "string" || !target.trim() || target.includes("\0") || !path.isAbsolute(target.trim())) return refuse("target_invalid");
  if (agentRootMoveBusy()) return refuse("move_in_progress");
  const status = agentHomeRootStatus();
  const root = path.resolve(target.trim());
  const mine = installedIds();
  const mineIn = (folder: string): number => agentIdsIn(folder).filter((id) => mine.has(id)).length;
  const back = status.available && status.path ? readReconnectPrevious(status.path) : null;
  const revert = back !== null && fold(path.resolve(back)) === fold(root);
  if (status.available && status.path && fold(path.resolve(status.path)) === fold(root)) return refuse("root_available");
  if (status.available && !revert && !(mine.size > 0 && status.path && mineIn(status.path) === 0)) return refuse("root_available");
  if (!isDir(root)) return refuse("target_invalid");
  if (path.parse(root).root === root || insideOrSame(root, os.homedir()) || insideOrSame(root, agentlasHomeDir())) return refuse("target_unsafe");
  const ids = agentIdsIn(root);
  const found = ids.filter((id) => mine.has(id)).length;
  const folders = agentFoldersIn(root).length;
  if (found === 0 && mine.size > 0) return refuse("target_has_no_agents");
  const previous = status.path;
  writeAgentsRootSetting(root);
  invalidateOwnerIndex();
  noteAgentRootReconnected(root);   // (first run B2): a retained move's target follows the root that is read now
  // 이전 위치로 돌아가는 길: 지금 루트가 읽히지 않아 이어 붙인 것이면 그 이전 루트를 남기고, 되돌아갔으면 지운다.
  if (revert) writeReconnectPrevious(null); else if (previous && fold(path.resolve(previous)) !== fold(root)) writeReconnectPrevious({ from: path.resolve(previous), to: root });
  let routesRebound = 0;
  try { if (previous) routesRebound = rebindRoutesUnder(previous, root).length; } catch { /* 라우트 파일을 못 썼다: 다음 시작의 복구는 없지만 다시 연결하면 된다 */ }
  return { ok: true, path: root, folders, agents: found, routesRebound, ...(revert ? { revertedTo: true as const } : {}) };
}

/**
 * 에이전트 하나의 *정의* 위치를 바꾼다(복사 없음, 상태는 그대로): 라우트의 경로를 새 폴더로 바꾸고, 아직 처리 안 된 변경안의 `rootPath` 를 따라 옮기고, 엔진 등록의
 * `sourceRoot` 를 새 폴더로 알린다(같은 id — 엔진은 "옛 폴더가 사라지고 내용이 같은" 정의를 옮김으로 알아본다). 옛 폴더가 아직 있으면 엔진 등록은 건드리지 않는다
 * (`skipped-old-folder-exists`: 엔진은 그것을 두 번째 사본으로 본다). 폴더가 정의 폴더로 보이는지(정본 프롬프트 파일이 읽히는지)를 먼저 본다.
 */
export async function setAgentDefinitionLocation(agentId: string, folder: unknown, options: { engine?: HomeMoveEngine } = {}): Promise<AgentLocationOutcome> {
  const fail = (code: Extract<AgentLocationOutcome, { ok: false }>["code"], detail?: string): AgentLocationOutcome => ({ ok: false, code, ...(detail ? { detail } : {}) });
  const row = rowOf(agentId);
  if (!row) return fail("agent_not_found");
  if (typeof folder !== "string" || !folder.trim() || folder.includes("\0") || !path.isAbsolute(folder.trim())) return fail("folder_invalid");
  const target = path.resolve(folder.trim());
  if (!isDir(target)) return fail("folder_invalid", "not-a-folder");
  const status = agentHomeRootStatus();
  const realTarget = realOrSelf(target);
  const segments = realTarget.split(path.sep);
  if (segments.includes(".agentlas-local") || path.parse(target).root === target || insideOrSame(target, os.homedir()) || insideOrSame(target, agentlasHomeDir())
    || (status.path && fold(realOrSelf(status.path)) === fold(realTarget))) return fail("folder_unsafe");
  try { if (insideOrSame(userDataDir(), realTarget)) return fail("folder_unsafe"); } catch { /* no userData here */ }
  // 다른 에이전트가 이미 이 폴더를 쓴다: 한 폴더 = 한 에이전트.
  const owners = ownerIds(target);
  if (owners.length > 0 && !owners.includes(agentId)) return fail("folder_used_by_other_agent");
  for (const route of listRoutes()) if (route.agentId !== agentId && route.path && fold(path.resolve(route.path)) === fold(target)) return fail("folder_used_by_other_agent");
  try { if (!readCanonicalPromptFromDirectory(target)) return fail("not_an_agent_folder"); } catch { return fail("not_an_agent_folder"); }
  const previous = getRoute(agentId);
  const previousPath = previous?.path ?? null;
  const blocker = agentFolderMoveBlocker(agentId, previousPath ?? target);
  if (blocker) return fail("agent_running", blocker);
  const next: AgentRoute = previous
    ? { ...previous, path: target }
    : { agentId, path: target, runtime: "generic", labels: ["generic"], kind: "agent", importedAt: new Date().toISOString(), source: "local-import" };
  delete next.missingSince;
  const written = { state: "failed" as "ok" | "busy" | "failed" };
  const held = withAgentFolderMoveLocks([agentId], () => { try { setRoute(next); written.state = "ok"; } catch { written.state = "failed"; } });
  if (held && typeof held === "object" && "busy" in held) written.state = "busy";
  if (written.state === "busy") return fail("agent_running", "workspace-locked");
  if (written.state !== "ok") return fail("route_write_failed");
  invalidateOwnerIndex();
  if (previousPath) { try { rebindAgentWorkspaceRoot(agentId, realOrSelf(previousPath), realTarget); } catch { /* 변경안 하나를 못 바꿔도 위치는 바뀌었다 */ } }
  const foreignState = exists(path.join(target, ".agentlas-local")) && owners.includes(agentId) && !(status.path && insideOrSame(status.path, target));
  let engineState: Extract<AgentLocationOutcome, { ok: true }>["engine"] = "not-engine-package";
  if (previousPath && (exists(path.join(target, ".agentlas", "routing-card.json")) || exists(path.join(target, "agentlas.json")))) {
    engineState = "unavailable";
    try {
      const engine = options.engine ?? defaultHomeMoveEngine();
      const known = await engine.registeredRoots();
      if (known === null) engineState = "unavailable";
      else if (!known.some((root) => path.resolve(root) === path.resolve(previousPath))) engineState = "not-engine-package";
      else if (exists(previousPath)) engineState = "skipped-old-folder-exists";
      else { const registered = await engine.register(target); engineState = registered === null ? "unavailable" : registered.ok ? "registered" : "refused"; }
    } catch { engineState = "unavailable"; }
  }
  try { emitDesktopStoreChange({ entity: "agent", id: agentId }); } catch { /* no window here */ }
  return { ok: true, agentId, path: target, previousPath, engine: engineState, foreignState };
}
