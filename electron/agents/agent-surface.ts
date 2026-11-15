// 에이전트 화면(Dashboard 카드·Agents "참여한 방")이 읽는 두 가지 읽기 전용 조회.
//
//   · agentRoomStats(db): 에이전트마다 "참여한 방 수 + 그 방의 chat id(최대 ROOM_ID_CAP)". 카드의 방 수와 "작업 중" 점(renderer 가 이미 받는
//     active-chats 방송과 id 로 맞춘다)에 쓴다. 쿼리 3개(1:1 방 GROUP BY, 그룹방 멤버 JSON, 프로젝트 이름 없음) — 에이전트 수와 무관하게 한 번.
//   · agentRooms(db, agentId): 이 에이전트가 앉은 방 목록(프로젝트 · 방 이름 · 종류). Agents "참여한 방" 탭이 보일 때만 읽는다.
//
// 저장은 없다 — 새 표·열·캐시 0. SELECT 만 한다. 없는 표(구세대·데몬 전용 저장소)는 빈 결과다(던지지 않는다).
// 방의 정의는 Home 트리(home-tree.ts)와 같다: 보관되지 않은 사용자 대화, 하위 세션 아님, 개인 에이전트의 방 아님, 비어 있지 않음.
import type Database from "better-sqlite3";

export const ROOM_ID_CAP = 12;
export const ROOM_LIST_CAP = 100;

export interface AgentRoomStat { rooms: number; chatIds: string[] }
export interface AgentRoomRow { chatId: string; kind: "solo" | "group"; title: string; projectId: string | null; projectName: string | null; updatedAt: string }

function tables(db: Database.Database): Set<string> {
  try { return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)); }
  catch { return new Set(); }
}
function columns(db: Database.Database, table: string): Set<string> {
  try { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)); }
  catch { return new Set(); }
}
function memberIds(json: string | null): string[] {
  if (!json) return [];
  try { const parsed: unknown = JSON.parse(json); return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0) : []; }
  catch { return []; }
}

/** 보이는 방의 공통 조건. 개인 에이전트가 자기 몫으로 쥔 방은 뺀다(개인 에이전트는 방 구성원이 아니라 비서). */
function visibleRoomWhere(cols: Set<string>, t: Set<string>): string {
  const parts = ["c.archived_at IS NULL"];
  if (cols.has("kind")) parts.push("c.kind = 'user'");
  if (cols.has("parent_chat_id")) parts.push("c.parent_chat_id IS NULL");
  if (cols.has("surface_pack")) parts.push("c.surface_pack IS NULL");
  if (cols.has("origin_surface")) parts.push("c.origin_surface = 'one'");
  if (cols.has("used_at")) parts.push(`(c.used_at IS NOT NULL OR c.created_at >= '${new Date(Date.now() - 5 * 60_000).toISOString()}')`);
  if (t.has("one_personal_agent_rooms")) parts.push("NOT EXISTS (SELECT 1 FROM one_personal_agent_rooms r WHERE r.chat_id = c.id AND r.released_at IS NULL)");
  return parts.join(" AND ");
}

export function agentRoomStats(db: Database.Database): Record<string, AgentRoomStat> {
  const out: Record<string, AgentRoomStat> = {};
  const t = tables(db);
  if (!t.has("chats")) return out;
  const cols = columns(db, "chats");
  if (!cols.has("agent_id")) return out;
  const where = visibleRoomWhere(cols, t);
  const add = (agentId: string, chatId: string) => {
    const stat = out[agentId] ?? (out[agentId] = { rooms: 0, chatIds: [] });
    stat.rooms += 1;
    if (stat.chatIds.length < ROOM_ID_CAP) stat.chatIds.push(chatId);
  };
  const groupJoin = t.has("one_taskforces") ? "LEFT JOIN one_taskforces tf ON tf.chat_id = c.id" : "";
  const rows = db.prepare(`SELECT c.id AS id, c.agent_id AS agent_id, ${groupJoin ? "tf.member_agent_ids_json" : "NULL"} AS members
      FROM chats c ${groupJoin} WHERE ${where} AND (c.agent_id IS NOT NULL${groupJoin ? " OR tf.id IS NOT NULL" : ""})`).all() as Array<{ id: string; agent_id: string | null; members: string | null }>;
  for (const row of rows) {
    const members = memberIds(row.members);
    if (members.length) for (const agentId of new Set(members)) add(agentId, row.id);
    else if (row.agent_id) add(row.agent_id, row.id);
  }
  return out;
}

export function agentRooms(db: Database.Database, agentId: unknown): AgentRoomRow[] {
  if (typeof agentId !== "string" || !agentId || agentId.length > 200) return [];
  const t = tables(db);
  if (!t.has("chats")) return [];
  const cols = columns(db, "chats");
  if (!cols.has("agent_id")) return [];
  const where = visibleRoomWhere(cols, t);
  const groupJoin = t.has("one_taskforces") ? "LEFT JOIN one_taskforces tf ON tf.chat_id = c.id" : "";
  const projectJoin = t.has("projects") && cols.has("project_id") ? "LEFT JOIN projects p ON p.id = c.project_id" : "";
  const rows = db.prepare(`SELECT c.id AS id, c.title AS title, ${cols.has("project_id") ? "c.project_id" : "NULL"} AS project_id, ${projectJoin ? "p.name" : "NULL"} AS project_name,
      c.updated_at AS updated_at, ${groupJoin ? "tf.member_agent_ids_json" : "NULL"} AS members, ${groupJoin ? "tf.id" : "NULL"} AS tf_id, c.agent_id AS agent_id
      FROM chats c ${groupJoin} ${projectJoin} WHERE ${where}
      AND (c.agent_id = @id${groupJoin ? " OR (tf.id IS NOT NULL AND tf.member_agent_ids_json LIKE @like)" : ""})
      ORDER BY c.updated_at DESC, c.id LIMIT ${ROOM_LIST_CAP * 2}`).all({ id: agentId, like: `%"${agentId.replace(/[%_"\\]/g, "")}"%` }) as Array<{
    id: string; title: string | null; project_id: string | null; project_name: string | null; updated_at: string; members: string | null; tf_id: string | null; agent_id: string | null }>;
  const result: AgentRoomRow[] = [];
  for (const row of rows) {
    const members = memberIds(row.members);
    const group = Boolean(row.tf_id) && members.length > 0;
    if (group ? !members.includes(agentId) : row.agent_id !== agentId) continue; // LIKE 는 거르기만 한다 — 정확한 멤버십은 여기서
    result.push({ chatId: row.id, kind: group ? "group" : "solo", title: row.title ?? "", projectId: row.project_id, projectName: row.project_name, updatedAt: row.updated_at });
    if (result.length >= ROOM_LIST_CAP) break;
  }
  return result;
}

export const AGENT_SURFACE_CHANNELS = {
  roomStats: "agents:room-stats",
  rooms: "agents:rooms",
  forgetPending: "agents:forget-pending",
} as const;

/** 렌더러 전용 읽기 채널. 폰 브리지·앱 컨트롤 카탈로그에는 올리지 않는다(구버전 폰 응답 모양 불변). */
export function registerAgentSurfaceIpc(
  ipcMain: { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void },
  getDb: () => Database.Database,
): void {
  ipcMain.handle(AGENT_SURFACE_CHANNELS.roomStats, () => agentRoomStats(getDb()));
  ipcMain.handle(AGENT_SURFACE_CHANNELS.rooms, (_event, agentId: unknown) => agentRooms(getDb(), agentId));
  // Read-only: the Agents screen only says how many cleanups still wait. Retrying is signal-driven (app start below, the next removal), never a screen open.
  ipcMain.handle(AGENT_SURFACE_CHANNELS.forgetPending, async () => ({ pending: await (await import("./agent-forget")).pendingAgentForgetCount(), retried: 0 }));
  // The app-start retry of leftovers lives in ONE place, `memory/forget-stores.ts runStartupForgetCatchUp` (once per start, apart from the startup chain). A second 20-second timer here made every start retry twice (#1).
}
