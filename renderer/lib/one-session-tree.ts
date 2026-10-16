import type { Chat } from "@shared/types";
import type { OneOrgMember } from "@shared/one-org";
import type { OneTaskforce } from "@shared/one-taskforces";

/**
 * The One session list as a tree (owner 2026-10-16): a group room is a parent row and the agents taking part in it are
 * its children. A child stands for that member's seat thread (the 1:1 thread that already shows its room work), so the
 * tree shows membership only and merges no storage: a room is never folded into a seat thread, and a member's own 1:1
 * sessions stay top-level rows exactly as before (owner decision 2026-10-13 #1).
 *
 * Membership comes from typed facts only: the room's Taskforce member list, or for a room whose Taskforce is gone, the
 * chat's seat snapshot (seatKind "group" + participants). Titles and text never decide anything.
 */

export type OneSessionChildStatus = "attention" | "running" | "failed" | "idle" | "unavailable";

export interface OneSessionTreeChild {
  key: string;
  roomChatId: string;
  memberId: string;
  agentId: string;
  name: string;
  status: OneSessionChildStatus;
}

export interface OneSessionTreeNode<Row> {
  key: string;
  row: Row;
  /** The room's chat id when this row is a group room, else null. */
  roomChatId: string | null;
  children: OneSessionTreeChild[];
}

export type OneSessionTreeRow = { key: string; chat: Pick<Chat, "id" | "seatKind" | "participants"> | null };

export type OneSessionTreeMember = Pick<
  OneOrgMember,
  "id" | "installedAgentId" | "displayName" | "nameEn" | "archivedAt" | "statusKind" | "unreadCount" | "pendingCount" | "unavailable"
>;

/**
 * One dot per child, from the member's host-observed state (the same unread/running facts the org chart shows).
 * Running is scoped to this room: the member is working AND this room has a live run.
 */
export function oneSessionChildStatus(member: OneSessionTreeMember, roomRunning: boolean): OneSessionChildStatus {
  if (member.unavailable) return "unavailable";
  if (member.unreadCount > 0 || member.pendingCount > 0) return "attention";
  if (roomRunning && member.statusKind === "working") return "running";
  if (member.statusKind === "failed") return "failed";
  return "idle";
}

export function buildOneSessionTree<Row extends OneSessionTreeRow>(
  rows: readonly Row[],
  input: {
    taskforces: readonly Pick<OneTaskforce, "chatId" | "memberAgentIds">[];
    members: readonly OneSessionTreeMember[];
    runningChatIds: ReadonlySet<string>;
    locale: "ko" | "en";
  },
): OneSessionTreeNode<Row>[] {
  const memberByAgent = new Map(input.members.map((member) => [member.installedAgentId, member]));
  const taskforceByChat = new Map(input.taskforces.map((taskforce) => [taskforce.chatId, taskforce]));
  return rows.map((row) => {
    const chat = row.chat;
    const taskforce = chat ? taskforceByChat.get(chat.id) : undefined;
    if (!chat || (!taskforce && chat.seatKind !== "group")) return { key: row.key, row, roomChatId: null, children: [] };
    const agentIds = taskforce
      ? taskforce.memberAgentIds
      : (chat.participants ?? []).flatMap((participant) => (participant.agentId ? [participant.agentId] : []));
    const roomRunning = input.runningChatIds.has(chat.id);
    const seen = new Set<string>();
    const children: OneSessionTreeChild[] = [];
    for (const agentId of agentIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const member = memberByAgent.get(agentId);
      // A member who left the organisation has no seat thread to open; the room itself records the departure.
      if (!member || member.archivedAt) continue;
      const name = (input.locale === "en" ? member.nameEn || member.displayName : member.displayName).trim();
      if (!name) continue;
      children.push({
        key: `${chat.id}:${agentId}`,
        roomChatId: chat.id,
        memberId: member.id,
        agentId,
        name,
        status: oneSessionChildStatus(member, roomRunning),
      });
    }
    return { key: row.key, row, roomChatId: chat.id, children };
  });
}
