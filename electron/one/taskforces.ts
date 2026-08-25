import { randomUUID } from "node:crypto";
import type {
  CreateOneTaskforceInput,
  OneTaskforce,
  RemoveOneTaskforceInput,
  UpdateOneTaskforceInput,
} from "../../shared/one-taskforces";
import { createChat, renameChat } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getDb } from "../store/db";
import {
  applySeatSnapshotToChats,
  dissolveSeat,
  ensureGroupSeatForTaskforce,
  renameSeat,
  seatSessionCount,
  syncGroupSeatOccupants,
} from "../store/seats";

type Row = {
  id: string;
  chat_id: string;
  title: string;
  description: string;
  member_agent_ids_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
};

const MAX_MEMBERS = 16;

function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("Taskforce title must be text.");
  const title = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!title || Array.from(title).length > 80 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error("Taskforce title is invalid.");
  }
  return title;
}

function normalizeDescription(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error("Taskforce description must be text.");
  const description = value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (Array.from(description).length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) {
    throw new Error("Taskforce description is invalid.");
  }
  return description;
}

function normalizeMemberIds(value: unknown, options: { allowUnavailable: boolean }): string[] {
  if (!Array.isArray(value) || value.length > MAX_MEMBERS) {
    throw new Error(`A Taskforce may include up to ${MAX_MEMBERS} staff members.`);
  }
  const ids = [...new Set(value.map((id) => assertId(id, "memberAgentId")))];
  if (!options.allowUnavailable && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const rows = getDb().prepare(
      `SELECT installed_agent_id FROM one_org_members
       WHERE archived_at IS NULL AND installed_agent_id IN (${placeholders})`,
    ).all(...ids) as Array<{ installed_agent_id: string }>;
    const available = new Set(rows.map((row) => row.installed_agent_id));
    const missing = ids.filter((id) => !available.has(id));
    if (missing.length > 0) throw new Error("Only active One staff can be added to a Taskforce.");
  }
  return ids;
}

function assertMembersAvailable(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT installed_agent_id FROM one_org_members
     WHERE archived_at IS NULL AND installed_agent_id IN (${placeholders})`,
  ).all(...ids) as Array<{ installed_agent_id: string }>;
  const available = new Set(rows.map((row) => row.installed_agent_id));
  if (ids.some((id) => !available.has(id))) {
    throw new Error("Only active One staff can be added to a Taskforce.");
  }
}

function readMemberIds(raw: string): string[] {
  try {
    return normalizeMemberIds(JSON.parse(raw), { allowUnavailable: true });
  } catch {
    return [];
  }
}

function toTaskforce(row: Row): OneTaskforce {
  return {
    id: row.id,
    chatId: row.chat_id,
    title: row.title,
    description: row.description ?? "",
    memberAgentIds: readMemberIds(row.member_agent_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function rowFor(id: string): Row {
  const row = getDb().prepare("SELECT * FROM one_taskforces WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new Error("Taskforce not found.");
  return row;
}

function assertExpectedRevision(row: Row, expectedRevision?: number): void {
  if (expectedRevision === undefined) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || row.revision !== expectedRevision) {
    throw new Error("This Taskforce changed on another surface. Reload and try again.");
  }
}

function emitTaskforceChanged(id?: string): void {
  emitDesktopStoreChange({ entity: "one-taskforce", ...(id ? { id } : {}) });
}

export function listOneTaskforces(): OneTaskforce[] {
  // 해체(dissolved)된 좌석의 단톡은 활동 목록에서 빠진다 — 세션(chats)은 보존되고
  // 세션 목록에서 읽기 전용 아카이브로 계속 보인다(SEAT-SESSION-PLAN-v2 T7, I3).
  return (getDb().prepare(
    `SELECT tf.* FROM one_taskforces tf
     JOIN chats c ON c.id = tf.chat_id
     LEFT JOIN one_seats s ON s.id = c.seat_id
     WHERE c.archived_at IS NULL
       AND (s.id IS NULL OR s.dissolved_at IS NULL)
     ORDER BY tf.updated_at DESC`,
  ).all() as Row[]).map(toTaskforce);
}

export function createOneTaskforce(input: CreateOneTaskforceInput): OneTaskforce {
  const title = normalizeTitle(input?.title);
  const description = normalizeDescription(input?.description);
  const memberAgentIds = normalizeMemberIds(input?.memberAgentIds, { allowUnavailable: false });
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().transaction(() => {
    const chat = createChat({ title, originSurface: "one", taskMode: "conversation" });
    getDb().prepare(
      `INSERT INTO one_taskforces
       (id, chat_id, title, description, member_agent_ids_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, chat.id, title, description, JSON.stringify(memberAgentIds), now, now);
    // 단톡의 좌석은 group 좌석이다(스펙 §3 ①-5). createChat 이 붙인 solo 좌석(One 루트)을
    // 이 단톡의 좌석으로 바로잡고, 멤버를 점유로 앉힌 뒤 스냅샷을 같은 트랜잭션에서 남긴다(I9).
    const seatId = ensureGroupSeatForTaskforce({ taskforceId: id, title, memberAgentIds, createdAt: now });
    getDb().prepare("UPDATE chats SET seat_id = ? WHERE id = ?").run(seatId, chat.id);
    applySeatSnapshotToChats(seatId);
  })();
  emitTaskforceChanged(id);
  return toTaskforce(rowFor(id));
}

export function updateOneTaskforce(input: UpdateOneTaskforceInput): OneTaskforce {
  const id = assertId(input?.id, "id");
  const row = rowFor(id);
  assertExpectedRevision(row, input.expectedRevision);
  const title = normalizeTitle(input.title);
  const description = normalizeDescription(input.description);
  // Existing members intentionally survive lease expiry, archival, or package
  // removal so the group transcript keeps an honest grey participant row.
  // Only newly-added identities must still be active staff.
  const priorMemberIds = readMemberIds(row.member_agent_ids_json);
  const memberAgentIds = normalizeMemberIds(input.memberAgentIds, { allowUnavailable: true });
  const prior = new Set(priorMemberIds);
  assertMembersAvailable(memberAgentIds.filter((agentId) => !prior.has(agentId)));
  const now = new Date().toISOString();
  getDb().transaction(() => {
    getDb().prepare(
      `UPDATE one_taskforces
       SET title = ?, description = ?, member_agent_ids_json = ?, updated_at = ?, revision = revision + 1
       WHERE id = ?`,
    ).run(title, description, JSON.stringify(memberAgentIds), now, id);
    renameChat(row.chat_id, title);
    // T3(멤버 영입)·T4(멤버 방출) — 열린 점유를 멤버 목록에 맞추고(빠진 멤버는 행을
    // 닫기만 한다, I6) 좌석 제목·세션 스냅샷을 같은 트랜잭션에서 갱신한다(I9).
    const seatId = ensureGroupSeatForTaskforce({ taskforceId: id, title, memberAgentIds, createdAt: row.created_at });
    getDb().prepare("UPDATE chats SET seat_id = ? WHERE id = ? AND (seat_id IS NULL OR seat_id <> ?)").run(seatId, row.chat_id, seatId);
    renameSeat(seatId, title);
    syncGroupSeatOccupants(seatId, memberAgentIds);
  })();
  emitTaskforceChanged(id);
  return toTaskforce(rowFor(id));
}

/**
 * 단톡 "삭제" = 좌석 해체(T7) — 대화는 절대 지우지 않는다 (오너 지시 2026-08-25,
 * SEAT-SESSION-PLAN-v2 I3). 점유를 전부 닫고 좌석을 해체 표시하면:
 *   - 단톡 목록에서는 빠지고(listOneTaskforces 가 해체 좌석 제외),
 *   - 세션(chats)은 표시 스냅샷과 함께 전부 남아 읽기 전용 아카이브로 열람된다.
 * 물리 삭제(chats 까지 지우는 일)는 별도 동작으로만 존재해야 하며 이 경로에 없다.
 * IPC 층의 "실행 중 삭제 거부" 가드는 그대로 승계된다.
 */
export function removeOneTaskforce(input: RemoveOneTaskforceInput): void {
  const id = assertId(input?.id, "id");
  const row = rowFor(id);
  assertExpectedRevision(row, input.expectedRevision);
  const db = getDb();
  db.transaction(() => {
    const chatSeat = db.prepare("SELECT seat_id AS seatId FROM chats WHERE id = ?").get(row.chat_id) as
      | { seatId: string | null }
      | undefined;
    // 좌석이 없던 구세대 행도 해체 계약을 지킨다 — 이관을 여기서 마저 한다.
    const seatId = chatSeat?.seatId ?? ensureGroupSeatForTaskforce({
      taskforceId: id,
      title: row.title,
      memberAgentIds: readMemberIds(row.member_agent_ids_json),
      createdAt: row.created_at,
    });
    if (!chatSeat?.seatId) {
      db.prepare("UPDATE chats SET seat_id = ? WHERE id = ?").run(seatId, row.chat_id);
    }
    dissolveSeat(seatId);
    db.prepare("UPDATE one_taskforces SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
  })();
  emitTaskforceChanged(id);
}

/** 해체 확인 문구용 사전 COUNT — "대화 N개는 기록으로 남습니다"(정확한 수, 기획 §4-7). */
export function oneTaskforceRemovalPreview(input: { id: string }): { sessionCount: number } {
  const id = assertId(input?.id, "id");
  const row = rowFor(id);
  const chatSeat = getDb().prepare("SELECT seat_id AS seatId FROM chats WHERE id = ?").get(row.chat_id) as
    | { seatId: string | null }
    | undefined;
  if (chatSeat?.seatId) return { sessionCount: seatSessionCount(chatSeat.seatId) };
  // 좌석 미이관 행 — 최소한 이 방의 대화 1개는 보존된다.
  return { sessionCount: 1 };
}
