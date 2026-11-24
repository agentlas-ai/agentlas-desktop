import { homeParticipantName, type HomeLine, type HomeTreeParticipant, type HomeTreeRow } from "@shared/home-tree";
import type { ConversationListFace, ConversationListGroupFace, ConversationListItem } from "@/components/one/ConversationListButton";
import { oneSessionChildStatus, type OneSessionTreeChild, type OneSessionTreeMember } from "./one-session-tree";
import { rowDisplayName } from "./home-tree";
import { runtimeProviderLabel } from "./runtime-provider-label";

/*
 * The Workspace menu's rows are drawn by the One Session list's own components (ConversationListButton, OneSessionTree). Those
 * read a Chat; the menu has a light HomeTreeRow plus the line Main gave for it. This file is the only place that turns one
 * into the other - pure functions, no React, so the rules can be checked without a DOM.
 */

/** The row the Session list draws for an agent chat (1:1 or group). The title is the chat's, or who is in it when it has none. */
export function agentChatItem(row: HomeTreeRow, line: HomeLine | null, fallbackTitle: string, locale: "ko" | "en" = "ko"): ConversationListItem {
  const raw = row.title.trim();
  return {
    id: row.id,
    title: !raw || raw === "New chat" ? rowDisplayName(row, fallbackTitle, locale) : raw,
    updatedAt: row.updatedAt,
    seatKind: row.kind === "group" ? "group" : "solo",
    ...(line?.preview ? { lastMessagePreview: line.preview } : {}),
  };
}

type OrgFace = Pick<OneSessionTreeMember, "installedAgentId" | "statusKind" | "archivedAt">;

/**
 * Faces of an agent chat. A 1:1 shows its one agent, a group room shows its first three members and NOT the personal agent (owner
 * O5: the personal agent is the assistant, not a member). The state ring comes from the organisation when it is loaded; until
 * then the faces are quiet.
 */
export function agentChatFaces(row: HomeTreeRow, line: HomeLine | null, org: ReadonlyMap<string, OrgFace> | null, locale: "ko" | "en" = "ko"): {
  member: ConversationListFace | null; groupMembers: ConversationListGroupFace[];
} {
  const faces = line?.faces ?? [];
  const statusOf = (agentId: string) => org?.get(agentId)?.statusKind ?? "quiet";
  if (row.kind === "group") {
    return {
      member: null,
      groupMembers: faces.map((face) => ({ installedAgentId: face.agentId, archivedAt: org?.get(face.agentId)?.archivedAt ?? null, statusKind: statusOf(face.agentId), displayName: locale === "en" && face.nameEn ? face.nameEn : face.name, icon: face.tone, agent: { id: face.agentId, seedName: face.name } })),
    };
  }
  const face = faces[0];
  return { member: face ? { statusKind: statusOf(face.agentId), icon: face.tone, agent: { id: face.agentId, seedName: face.name } } : null, groupMembers: [] };
}

/** A Work row's title with the runner it started on in front ("Codex · Chart work"); no runner saved, no prefix. */
export function workRowTitle(title: string, line: HomeLine | null): string {
  const runner = line?.runner ? runtimeProviderLabel(line.runner, line.runnerLabel) : null;
  return runner ? `${runner} · ${title}` : title;
}

/** The rows OneSessionTree takes: a group room is a parent row (its members are read when it opens, so it carries none). */
export interface MenuTreeRow { key: string; row: HomeTreeRow; chat: { id: string; seatKind: "solo" | "group"; participants: undefined } }
export function menuTreeRows(rows: readonly HomeTreeRow[]): MenuTreeRow[] {
  return rows.map((row) => ({ key: row.id, row, chat: { id: row.id, seatKind: row.kind === "group" ? "group" : "solo", participants: undefined } }));
}

/** Member rows under one open room: name, and the same dot the Session list gives (needs-attention / running / failed / idle). */
export function memberChildren(
  roomChatId: string, list: readonly HomeTreeParticipant[], org: ReadonlyMap<string, OneSessionTreeMember> | null, roomRunning: boolean, locale: "ko" | "en",
): OneSessionTreeChild[] {
  return list.map((participant, index) => {
    const member = org?.get(participant.agentId);
    const name = (member ? (locale === "en" ? member.nameEn || member.displayName : member.displayName) : homeParticipantName(participant, locale))?.trim()
      || (locale === "ko" ? "삭제된 에이전트" : "Removed agent");
    return {
      key: `${roomChatId}:${participant.agentId}:${index}`,
      roomChatId,
      memberId: member?.id ?? participant.agentId,
      agentId: participant.agentId,
      name,
      status: member ? oneSessionChildStatus(member, roomRunning) : participant.name === null ? "unavailable" : "idle",
    };
  });
}
