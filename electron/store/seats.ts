// 좌석(seat) 1급 읽기·조작 경로 — SEAT-SESSION-PLAN-v2 (2026-08-25).
//
// 좌석 = 사람이 보는 고정 자리. 세션(chats) = 그 좌석에서 오간 대화 한 판(좌석 1:N).
// 점유자 = 지금 그 자리에 앉은 에이전트(교체 가능·빈 자리 가능).
//
// 불변식(기획 §1):
//   I1 좌석의 어떤 상태 변화도 세션을 지우거나 본문을 바꾸지 않는다.
//   I2 세션→좌석 참조는 끊길 수 있다 — 세션은 자기 스냅샷(seat_label·seat_kind·
//      participants_json)만으로 완결적으로 렌더된다.
//   I6 점유 이력은 append-only: 열린 행을 닫을 수만 있고 수정·삭제하지 않는다.
//   I7 "한 슬롯에 현재 점유자 ≤ 1"은 부분 유니크 인덱스(idx_seat_occupants_current)가
//      강제한다 — 이 모듈은 그 제약을 우회하지 않는다.
//   I9 스냅샷은 사건이 일어나는 그 트랜잭션에서 기록한다(소멸 뒤 역참조 금지).
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";

export interface OneSeatOccupant {
  slot: number;
  agentId: string | null;
  displayName: string;
  since: string;
  until: string | null;
}

export interface OneSeatRecord {
  id: string;
  kind: "solo" | "group";
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  dissolvedAt: string | null;
  /** 현재 점유(열린 행)만. 이력 전체는 listSeatOccupantHistory. */
  occupants: OneSeatOccupant[];
}

export interface SeatParticipantSnapshot {
  slot: number;
  agentId: string | null;
  displayName: string;
}

type SeatRow = {
  id: string;
  kind: "solo" | "group";
  title: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  dissolved_at: string | null;
};

type OccupantRow = {
  seat_id: string;
  slot: number;
  agent_id: string | null;
  display_name: string;
  since: string;
  until: string | null;
};

/**
 * 새 점유 행의 since 는 그 (seat, slot) 이력의 어떤 행과도 겹치면 안 된다 —
 * 자연 키가 (seat_id, slot, since)라, 같은 밀리초에 "닫고 새로 앉히기"가 일어나면
 * INSERT OR IGNORE 가 착석을 조용히 버린다(게이트 실측으로 잡은 결함). 겹치면 1ms 민다.
 */
function nextOccupancySince(seatId: string, slot: number, now: string): string {
  const row = getDb()
    .prepare("SELECT MAX(since) AS m FROM one_seat_occupants WHERE seat_id = ? AND slot = ?")
    .get(seatId, slot) as { m: string | null } | undefined;
  if (!row?.m || now > row.m) return now;
  const bumped = Date.parse(row.m) + 1;
  return Number.isFinite(bumped) ? new Date(bumped).toISOString() : now;
}

function agentDisplayName(agentId: string): string {
  const row = getDb().prepare("SELECT name FROM installed_agents WHERE id = ?").get(agentId) as
    | { name: string }
    | undefined;
  return row?.name ?? "";
}

function openOccupants(seatId: string): OccupantRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM one_seat_occupants WHERE seat_id = ? AND until IS NULL ORDER BY slot, since",
    )
    .all(seatId) as OccupantRow[];
}

function toSeat(row: SeatRow): OneSeatRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    dissolvedAt: row.dissolved_at,
    occupants: openOccupants(row.id).map((occupant) => ({
      slot: occupant.slot,
      agentId: occupant.agent_id,
      displayName: occupant.display_name,
      since: occupant.since,
      until: occupant.until,
    })),
  };
}

export function getSeat(seatId: string): OneSeatRecord | null {
  const row = getDb().prepare("SELECT * FROM one_seats WHERE id = ?").get(seatId) as SeatRow | undefined;
  return row ? toSeat(row) : null;
}

export function getSeatForChat(chatId: string): OneSeatRecord | null {
  const row = getDb().prepare("SELECT seat_id AS seatId FROM chats WHERE id = ?").get(chatId) as
    | { seatId: string | null }
    | undefined;
  if (!row?.seatId) return null;
  return getSeat(row.seatId);
}

export function listSeats(): OneSeatRecord[] {
  const rows = getDb().prepare("SELECT * FROM one_seats ORDER BY updated_at DESC").all() as SeatRow[];
  return rows.map(toSeat);
}

/** "그때 누가 있었나" 재구성용 — append-only 이력 전체(닫힌 행 포함). */
export function listSeatOccupantHistory(seatId: string): OneSeatOccupant[] {
  const rows = getDb()
    .prepare("SELECT * FROM one_seat_occupants WHERE seat_id = ? ORDER BY since, slot")
    .all(seatId) as OccupantRow[];
  return rows.map((row) => ({
    slot: row.slot,
    agentId: row.agent_id,
    displayName: row.display_name,
    since: row.since,
    until: row.until,
  }));
}

export function seatSessionCount(seatId: string): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM chats WHERE seat_id = ?").get(seatId) as { n: number }).n;
}

export function currentSeatParticipants(seatId: string): SeatParticipantSnapshot[] {
  return openOccupants(seatId).map((row) => ({
    slot: row.slot,
    agentId: row.agent_id,
    displayName: row.display_name,
  }));
}

/**
 * 표시용 참여자 스냅샷 — 열린 점유가 있으면 그들, 전부 닫혔으면(빈 좌석·해체)
 * 슬롯별 **마지막** 점유자를 남긴다. 봇이 삭제돼도 세션은 "누가 있었나"를 계속
 * 말해야 한다(I2·I9 — 빈 값으로 덮으면 스냅샷이 지워진다. T1 라이브 실측으로 잡은 결함).
 */
function displaySeatParticipants(seatId: string): SeatParticipantSnapshot[] {
  const open = currentSeatParticipants(seatId);
  if (open.length > 0) return open;
  const lastPerSlot = getDb()
    .prepare(
      `SELECT o.slot, o.agent_id, o.display_name FROM one_seat_occupants o
        JOIN (SELECT slot, MAX(since) AS m FROM one_seat_occupants WHERE seat_id = ? GROUP BY slot) latest
          ON latest.slot = o.slot AND latest.m = o.since
       WHERE o.seat_id = ? ORDER BY o.slot`,
    )
    .all(seatId, seatId) as Array<{ slot: number; agent_id: string | null; display_name: string }>;
  return lastPerSlot.map((row) => ({ slot: row.slot, agentId: row.agent_id, displayName: row.display_name }));
}

/** 좌석 라벨 = 제목 → 열린 점유자 → 마지막 점유자 이름 → null(지어내지 않는다 — I9). */
function seatLabelOf(seatId: string): string | null {
  const seat = getDb().prepare("SELECT title FROM one_seats WHERE id = ?").get(seatId) as
    | { title: string }
    | undefined;
  if (!seat) return null;
  if (seat.title.trim()) return seat.title.trim();
  const named = displaySeatParticipants(seatId).find((row) => row.displayName.trim());
  return named ? named.displayName.trim() : null;
}

/**
 * 표시 스냅샷을 이 좌석의 모든 세션에 기록한다(I9 — 사건 트랜잭션 안에서 호출).
 * 좌석이 나중에 소멸해도 세션은 이 칸만으로 렌더된다(I2).
 */
export function applySeatSnapshotToChats(seatId: string): void {
  const db = getDb();
  const seat = db.prepare("SELECT kind FROM one_seats WHERE id = ?").get(seatId) as
    | { kind: string }
    | undefined;
  if (!seat) return;
  const participantsJson = JSON.stringify(displaySeatParticipants(seatId));
  db.prepare(
    "UPDATE chats SET seat_label = ?, seat_kind = ?, participants_json = ? WHERE seat_id = ?",
  ).run(seatLabelOf(seatId), seat.kind, participantsJson, seatId);
}

/**
 * 봇의 solo 좌석 확보 — 새 세션(createChat)이 좌석을 참조하게 하는 유일한 관문.
 * 1) 그 봇이 지금 앉아 있는 solo 좌석이 있으면 재사용(점유 이력이 좌석의 정체다).
 * 2) 없으면 'seat_<agentId>' 를 만들고 착석시킨다. 그 id 의 좌석에 다른 봇이 앉아
 *    있으면(교체 이력) 새 좌석 id 를 만들어 준다 — I7 제약을 우회하지 않는다.
 */
export function ensureSoloSeatForAgent(agentId: string): string {
  const db = getDb();
  const seated = db
    .prepare(
      `SELECT o.seat_id AS seatId FROM one_seat_occupants o
        JOIN one_seats s ON s.id = o.seat_id
       WHERE o.agent_id = ? AND o.until IS NULL AND s.kind = 'solo' AND s.dissolved_at IS NULL
       ORDER BY o.since DESC LIMIT 1`,
    )
    .get(agentId) as { seatId: string } | undefined;
  if (seated) return seated.seatId;

  const now = new Date().toISOString();
  let seatId = `seat_${agentId}`;
  const existing = db.prepare("SELECT id FROM one_seats WHERE id = ?").get(seatId) as { id: string } | undefined;
  if (existing) {
    const occupied = openOccupants(seatId).some((row) => row.agent_id !== agentId);
    const dissolved = (db.prepare("SELECT dissolved_at AS d FROM one_seats WHERE id = ?").get(seatId) as { d: string | null }).d;
    if (occupied || dissolved) seatId = `seat_${agentId}_${Date.now().toString(36)}`;
  }
  db.prepare(
    "INSERT OR IGNORE INTO one_seats (id, kind, title, project_id, created_at, updated_at) VALUES (?, 'solo', '', NULL, ?, ?)",
  ).run(seatId, now, now);
  db.prepare(
    "INSERT OR IGNORE INTO one_seat_occupants (seat_id, slot, agent_id, display_name, since, until) VALUES (?, 0, ?, ?, ?, NULL)",
  ).run(seatId, agentId, agentDisplayName(agentId), nextOccupancySince(seatId, 0, now));
  return seatId;
}

/**
 * 텔레그램 방 = 좌석(원기획 §2.4). 방 하나가 고정 자리이고 `/new` 는 그 자리에 세션을
 * 하나 더 여는 일이다 — 그래서 방의 담당 봇을 갈아도 지난 세션이 방에 남는다.
 * 점유자가 바뀌면 이전 행을 닫고 새로 앉힌다(T2와 같은 규칙, append-only).
 */
export function ensureTelegramRoomSeat(input: {
  bindingId: string;
  agentId: string | null;
  title: string;
}): string {
  const db = getDb();
  const seatId = `seat_tg_${input.bindingId}`;
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO one_seats (id, kind, title, project_id, created_at, updated_at) VALUES (?, 'solo', ?, NULL, ?, ?)",
  ).run(seatId, input.title, now, now);
  db.prepare("UPDATE one_seats SET title = ?, updated_at = ? WHERE id = ?").run(input.title, now, seatId);
  if (input.agentId) {
    const open = openOccupants(seatId).find((row) => row.slot === 0);
    if (!open) {
      db.prepare(
        "INSERT OR IGNORE INTO one_seat_occupants (seat_id, slot, agent_id, display_name, since, until) VALUES (?, 0, ?, ?, ?, NULL)",
      ).run(seatId, input.agentId, agentDisplayName(input.agentId), nextOccupancySince(seatId, 0, now));
    } else if (open.agent_id !== input.agentId) {
      replaceSeatOccupant(seatId, open.agent_id ?? "", input.agentId);
    }
  }
  applySeatSnapshotToChats(seatId);
  return seatId;
}

/** 단톡의 group 좌석 확보 + 멤버를 점유로 동기화. 호출자는 자기 트랜잭션 안에서 부른다. */
export function ensureGroupSeatForTaskforce(input: {
  taskforceId: string;
  title: string;
  memberAgentIds: string[];
  createdAt?: string;
}): string {
  const db = getDb();
  const seatId = `seat_tf_${input.taskforceId}`;
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO one_seats (id, kind, title, project_id, created_at, updated_at) VALUES (?, 'group', ?, NULL, ?, ?)",
  ).run(seatId, input.title, input.createdAt ?? now, now);
  db.prepare("UPDATE one_seats SET title = ?, updated_at = ? WHERE id = ?").run(input.title, now, seatId);
  syncGroupSeatOccupants(seatId, input.memberAgentIds);
  return seatId;
}

/**
 * T3(슬롯 추가)·T4(슬롯 제거) — 열린 점유를 멤버 목록에 맞춘다.
 * 남는 멤버는 자기 슬롯을 유지하고(이력 연속), 빠진 멤버의 행은 닫고(수정·삭제 아님 — I6),
 * 새 멤버는 다음 빈 슬롯에 연다.
 */
export function syncGroupSeatOccupants(seatId: string, memberAgentIds: string[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const open = openOccupants(seatId);
  const wanted = new Set(memberAgentIds);
  const seatedAgents = new Set(open.map((row) => row.agent_id).filter((id): id is string => id !== null));
  for (const row of open) {
    if (row.agent_id !== null && !wanted.has(row.agent_id)) {
      db.prepare(
        "UPDATE one_seat_occupants SET until = ? WHERE seat_id = ? AND slot = ? AND since = ? AND until IS NULL",
      ).run(now, seatId, row.slot, row.since);
    }
  }
  let nextSlot = open.reduce((max, row) => Math.max(max, row.slot), -1) + 1;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO one_seat_occupants (seat_id, slot, agent_id, display_name, since, until) VALUES (?, ?, ?, ?, ?, NULL)",
  );
  for (const agentId of memberAgentIds) {
    if (seatedAgents.has(agentId)) continue;
    insert.run(seatId, nextSlot, agentId, agentDisplayName(agentId), nextOccupancySince(seatId, nextSlot, now));
    nextSlot += 1;
  }
  db.prepare("UPDATE one_seats SET updated_at = ? WHERE id = ?").run(now, seatId);
  applySeatSnapshotToChats(seatId);
}

export function renameSeat(seatId: string, title: string): void {
  const db = getDb();
  db.prepare("UPDATE one_seats SET title = ?, updated_at = ? WHERE id = ?").run(
    title,
    new Date().toISOString(),
    seatId,
  );
  applySeatSnapshotToChats(seatId);
}

/**
 * T7 좌석 해체 — 단톡 "삭제"의 실체. 점유를 전부 닫고 해체 표시만 한다.
 * 세션(chats)은 어떤 것도 지우지 않는다(I3). 물리 삭제는 이 함수가 아니다.
 */
export function dissolveSeat(seatId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  // 닫기 전에 스냅샷을 확정한다 — 해체 후에도 "누가 있었나"가 세션에 남는다(I9).
  applySeatSnapshotToChats(seatId);
  db.prepare("UPDATE one_seat_occupants SET until = ? WHERE seat_id = ? AND until IS NULL").run(now, seatId);
  db.prepare("UPDATE one_seats SET dissolved_at = ?, updated_at = ? WHERE id = ? AND dissolved_at IS NULL").run(
    now,
    now,
    seatId,
  );
  emitDesktopStoreChange({ entity: "chat" });
}

/**
 * T1 봇 삭제 — 그 봇의 열린 점유 행을 전부 닫는다(자리 비우기).
 * 좌석·세션·이력은 전부 보존. 반환값은 빈 자리가 된 좌석 id 목록.
 */
export function closeAgentOccupancies(agentId: string): string[] {
  const db = getDb();
  const now = new Date().toISOString();
  const seats = (db
    .prepare("SELECT DISTINCT seat_id AS seatId FROM one_seat_occupants WHERE agent_id = ? AND until IS NULL")
    .all(agentId) as Array<{ seatId: string }>).map((row) => row.seatId);
  if (seats.length === 0) return [];
  db.prepare("UPDATE one_seat_occupants SET until = ? WHERE agent_id = ? AND until IS NULL").run(now, agentId);
  for (const seatId of seats) applySeatSnapshotToChats(seatId);
  emitDesktopStoreChange({ entity: "chat" });
  return seats;
}

/**
 * T2 점유자 교체 — 이전 봇의 열린 행을 닫고 같은 슬롯에 새 봇을 앉힌다.
 * 세션 연속성은 호출자(org.ts)가 시스템 줄과 chats.agent_id(마지막 담당) 갱신으로 잇는다.
 */
export function replaceSeatOccupant(seatId: string, previousAgentId: string, nextAgentId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const open = openOccupants(seatId).find((row) => row.agent_id === previousAgentId);
  const slot = open?.slot ?? 0;
  if (open) {
    db.prepare(
      "UPDATE one_seat_occupants SET until = ? WHERE seat_id = ? AND slot = ? AND since = ? AND until IS NULL",
    ).run(now, seatId, open.slot, open.since);
  }
  db.prepare(
    "INSERT OR IGNORE INTO one_seat_occupants (seat_id, slot, agent_id, display_name, since, until) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(seatId, slot, nextAgentId, agentDisplayName(nextAgentId), nextOccupancySince(seatId, slot, now));
  db.prepare("UPDATE one_seats SET updated_at = ? WHERE id = ?").run(now, seatId);
  // Direct sessions keep the agent set captured when they were created. Replacing the
  // organisational seat must not silently rewrite old rooms to speak as a new agent;
  // those rooms remain readable and the UI asks the user to start a fresh session.
}

/**
 * T10 빈 좌석 배정 — 비어 있는 슬롯에 새 점유자를 앉힌다.
 * 좌석의 세션들은 그대로 이어지고, "마지막 담당"(chats.agent_id)이 새 봇으로 옮겨간다.
 * 이미 그 슬롯에 열린 점유가 있으면 교체(T2)이지 배정이 아니므로 거절한다 — I7 우회 금지.
 */
export function assignSeatOccupant(seatId: string, agentId: string, slot = 0): OneSeatRecord {
  const db = getDb();
  const seat = db.prepare("SELECT dissolved_at AS dissolvedAt FROM one_seats WHERE id = ?").get(seatId) as
    | { dissolvedAt: string | null }
    | undefined;
  if (!seat) throw new Error("Seat not found.");
  if (seat.dissolvedAt) throw new Error("This seat was dissolved; its sessions are a read-only archive.");
  const taken = openOccupants(seatId).find((row) => row.slot === slot);
  if (taken) throw new Error("That slot already has an occupant. Replace the occupant instead.");
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO one_seat_occupants (seat_id, slot, agent_id, display_name, since, until) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(seatId, slot, agentId, agentDisplayName(agentId), nextOccupancySince(seatId, slot, now));
  db.prepare("UPDATE one_seats SET updated_at = ? WHERE id = ?").run(now, seatId);
  // Existing direct sessions stay bound to their original agent. A new occupant becomes
  // available only to a newly opened session; old rooms are preserved as read-only history.
  emitDesktopStoreChange({ entity: "chat" });
  return getSeat(seatId) as OneSeatRecord;
}

/** 봇 삭제 확인 문구용 사전 COUNT — "좌석 N곳이 빈 자리… 대화 M개는 그대로"(정확한 수). */
export function agentRemovalPreview(agentId: string): { seatCount: number; chatCount: number } {
  const db = getDb();
  const seatCount = (db
    .prepare("SELECT COUNT(DISTINCT seat_id) AS n FROM one_seat_occupants WHERE agent_id = ? AND until IS NULL")
    .get(agentId) as { n: number }).n;
  const chatCount = (db.prepare("SELECT COUNT(*) AS n FROM chats WHERE agent_id = ?").get(agentId) as { n: number }).n;
  return { seatCount, chatCount };
}
