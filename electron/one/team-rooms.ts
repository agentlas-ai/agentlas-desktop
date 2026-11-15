import type { Chat } from "../../shared/types";
import { assertOneTeamMemberUsable, assertOneTeamRoomCaller, oneTeamOwnerMessage as ownerMessage, type OneTeamCaller } from "./team-dispatch";
import { resolveRosterEntry, type RosterEntry } from "./team-roster";

/*
 * What the personal agent can do with rooms, sessions and projects when the owner asks (Agentlas 2.0 D5, section 3, decision).
 *
 * Each of the three tools calls the SAME function the owner's screen calls, not a copy of it:
 *   one_team_new_chat        -> createAgentChatRoom          (the New chat button, IPC `chats:createAgentChat`)
 *   one_team_add_to_chat     -> addAgentChatParticipants     (the room's "add participants", IPC `chats:addAgentChatParticipants`)
 *   one_team_attach_project  -> attachChatToProject          (the session's "join a project", IPC `chats:attachProject`)
 * so the lead (the first agent picked), the isolation mark, the "reads the room only from the moment it joined" cursor, the registered-first check (a seat is made only for
 * an agent registered here with its folder), the member limit and a running turn's refusal are all the screen's own. This file adds only what the tool's caller needs and
 * the screen's click does not: WHO may call (the personal agent's own conversation, on a run that may write: `assertOneTeamRoomCaller`, the capability's D1 identity) and which
 * agent a name points at (the registry: team-roster.ts).
 *
 * Not here, on purpose (a chip is for money, deleting and sending out; the personal agent is the secretary): leaving a room, deleting or archiving one, and
 * sending words into one (`one_chat_send`, which the personal agent already has). The personal agent is never a member of a room it opens (the screen's functions drop it).
 * No table, column or timer is added; a refusal is an answer (the closed `one-team-*` prefixes of team-control-server.ts), nothing is changed by it.
 */

const MAX_MEMBERS = 16;
const MAX_TITLE = 80;

function refused(code: "one-team-chat-refused" | "one-team-project-not-found", message: string): Error {
  return new Error(`${code}: ${message}`);
}

function memberQueries(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MEMBERS || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    throw refused("one-team-chat-refused", ownerMessage("에이전트를 1~16개, 이름이나 member_id로 적어 주세요. 아무것도 바뀌지 않았어요.", "Give one to sixteen agents by name or member_id. Nothing was changed."));
  }
  return value.map((item) => String(item).trim());
}

/** Registered agents by name / slug / id: distinct, each one usable (the closed `one-team-member-unusable` answer carries the register words when not). */
function resolveMembers(queries: readonly string[]): RosterEntry[] {
  const entries: RosterEntry[] = [];
  for (const query of queries) {
    const entry = resolveRosterEntry(query);
    assertOneTeamMemberUsable({ installedAgentId: entry.agentId });
    if (!entries.some((known) => known.agentId === entry.agentId)) entries.push(entry);
  }
  return entries;
}

/** A project by id, or by its exact name when that names one project. An unknown one is a refusal: the screen's function would silently open the chat with none. */
function resolveProject(value: unknown): string {
  const { getProject, listProjects } = require("../store/projects") as typeof import("../store/projects"); // eslint-disable-line @typescript-eslint/no-require-imports
  const wanted = typeof value === "string" ? value.trim() : "";
  if (!wanted) throw refused("one-team-project-not-found", ownerMessage("프로젝트 id를 적어 주세요(one_app_call projects.list). 아무것도 바뀌지 않았어요.", "Name the project by id (one_app_call projects.list). Nothing was changed."));
  if (getProject(wanted)) return wanted;
  const byName = listProjects().filter((project) => project.name.trim().toLowerCase() === wanted.toLowerCase());
  if (byName.length === 1) return byName[0]!.id;
  throw refused("one-team-project-not-found", byName.length > 1
    ? ownerMessage(`"${wanted}" 이름의 프로젝트가 여럿이에요. id로 적어 주세요. 아무것도 바뀌지 않았어요.`, `Several projects are named "${wanted}". Use the id. Nothing was changed.`)
    : ownerMessage(`"${wanted}" 프로젝트를 찾을 수 없어요(one_app_call projects.list). 아무것도 바뀌지 않았어요.`, `No project "${wanted}" (one_app_call projects.list). Nothing was changed.`));
}

/** The screen's own functions throw plain sentences and the join guard's typed error: both become the closed refusal answer, never a failed step. */
function asRefusal(error: unknown): Error {
  // The join guard's typed error (org.ts OneGroupMemberUnavailableError, read by name: org.ts is loaded only where a room is made).
  if (error instanceof Error && error.name === "OneGroupMemberUnavailableError") {
    return Object.assign(new Error(`one-team-member-unusable: ${error.message}`), { code: (error as { reason?: unknown }).reason });
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith("one-team-")) return error as Error;
  return refused("one-team-chat-refused", `${raw} ${ownerMessage("아무것도 바뀌지 않았어요.", "Nothing was changed.")}`);
}

function viewOf(chat: Chat) {
  return { chat_id: chat.id, title: chat.title ?? "" };
}

export function oneTeamNewChat(caller: OneTeamCaller, input: { members?: unknown; project_id?: unknown; title?: unknown }) {
  assertOneTeamRoomCaller(caller);
  const queries = memberQueries(input?.members);
  const entries = resolveMembers(queries);
  const projectId = input?.project_id === undefined || input.project_id === null || input.project_id === "" ? null : resolveProject(input.project_id);
  const title = typeof input?.title === "string" ? input.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
  let receipt: import("../../shared/types").AgentChatReceipt;
  try {
    const { createAgentChatRoom } = require("./agent-chat") as typeof import("./agent-chat"); // eslint-disable-line @typescript-eslint/no-require-imports
    receipt = createAgentChatRoom({ agentIds: entries.map((entry) => entry.agentId), projectId, ...(title ? { title } : {}) });
  } catch (error) { throw asRefusal(error); }
  return {
    confirmed: true,
    ...viewOf(receipt.chat),
    kind: receipt.kind,
    ...(receipt.kind === "group" ? { lead: entries[0]!.name } : {}),
    members: entries.map((entry) => ({ member_id: entry.seat?.id ?? entry.agentId, name: entry.name })),
    project_id: receipt.chat.projectId ?? null,
    ...(receipt.reused ? { reused_empty_chat: true } : {}),
    owner_message: receipt.kind === "group"
      ? ownerMessage(`${entries.map((entry) => entry.name).join(", ")} 그룹 대화를 만들었어요. 첫 에이전트가 팀장이에요.`, `Opened a group chat with ${entries.map((entry) => entry.name).join(", ")}. The first agent leads it.`)
      : ownerMessage(`${entries[0]!.name}와(과)의 새 대화를 만들었어요.`, `Opened a new chat with ${entries[0]!.name}.`),
    note: "Nothing was sent. To say something in it, call one_chat_send with this chat_id. The owner's screen shows the chat already.",
  };
}

export function oneTeamAddToChat(caller: OneTeamCaller, input: { chat_id?: unknown; members?: unknown }) {
  const callerChatId = assertOneTeamRoomCaller(caller);
  const chatId = typeof input?.chat_id === "string" ? input.chat_id.trim() : "";
  const chat = chatId ? (require("../store/chats") as typeof import("../store/chats")).getChat(chatId) : null; // eslint-disable-line @typescript-eslint/no-require-imports
  if (!chat || chat.originSurface !== "one" || chat.archivedAt) throw refused("one-team-chat-refused", ownerMessage("그 대화방을 찾을 수 없어요(one_app_call chats.listRecent). 아무것도 바뀌지 않았어요.", "That chat is not available (one_app_call chats.listRecent). Nothing was changed."));
  // Only a room of the owner's agents: never the personal agent's own conversation or a room it supervises, a screen pack's chat, or a member's hidden session of a room.
  const { peerChatFacts } = require("../harness/deliver-runtime") as typeof import("../harness/deliver-runtime"); // eslint-disable-line @typescript-eslint/no-require-imports
  const facts = peerChatFacts(chat.id);
  if (chat.id === callerChatId || facts.personal || facts.pack || facts.memberSession || chat.parentChatId) {
    throw refused("one-team-chat-refused", ownerMessage("이 대화는 에이전트를 더할 수 있는 방이 아니에요. 아무것도 바뀌지 않았어요.", "This is not a room agents can be added to. Nothing was changed."));
  }
  const entries = resolveMembers(memberQueries(input?.members));
  const taskforces = (require("./taskforces") as typeof import("./taskforces")).listOneTaskforces(); // eslint-disable-line @typescript-eslint/no-require-imports
  const group = taskforces.find((taskforce) => taskforce.chatId === chat.id);
  const prior = group ? [...group.memberAgentIds] : chat.agentId ? [chat.agentId] : [];
  const fresh = entries.filter((entry) => !prior.includes(entry.agentId));
  if (fresh.length === 0) {
    return { confirmed: true, ...viewOf(chat), already_members: true, owner_message: ownerMessage("요청한 에이전트가 모두 이미 이 방에 있어요.", "All requested agents are already in this room."), note: "Nothing was changed." };
  }
  let receipt: import("../../shared/types").AgentChatReceipt;
  try {
    const { addAgentChatParticipants } = require("./agent-chat") as typeof import("./agent-chat"); // eslint-disable-line @typescript-eslint/no-require-imports
    receipt = addAgentChatParticipants({ chatId: chat.id, agentIds: fresh.map((entry) => entry.agentId) });
  } catch (error) { throw asRefusal(error); }
  return {
    confirmed: true,
    ...viewOf(receipt.chat),
    kind: receipt.kind,
    added: fresh.map((entry) => ({ member_id: entry.seat?.id ?? entry.agentId, name: entry.name })),
    owner_message: ownerMessage(`${fresh.map((entry) => entry.name).join(", ")}을(를) 이 방에 더했어요. 들어온 뒤의 말부터 읽어요.`, `Added ${fresh.map((entry) => entry.name).join(", ")} to this room. They read it from the moment they joined.`),
    note: "No work was started and nothing was sent. The room's lead stays the same.",
  };
}

export function oneTeamAttachProject(caller: OneTeamCaller, input: { chat_id?: unknown; project_id?: unknown }) {
  assertOneTeamRoomCaller(caller);
  const chatId = typeof input?.chat_id === "string" ? input.chat_id.trim() : "";
  if (!chatId) throw refused("one-team-chat-refused", ownerMessage("대화 chat_id를 적어 주세요. 아무것도 바뀌지 않았어요.", "Give the chat_id. Nothing was changed."));
  const projectId = resolveProject(input?.project_id);
  const { attachChatToProject, productionAttachDeps } = require("../chat/chat-moves") as typeof import("../chat/chat-moves"); // eslint-disable-line @typescript-eslint/no-require-imports
  // The screen's own function and answer; a folder is never taken from the model (only a project that already exists).
  const result = attachChatToProject({ chatId, projectId }, productionAttachDeps()) as { ok: boolean; code?: string; message?: string; alreadyAttached?: boolean; appliesFrom?: string };
  if (!result.ok) {
    return { confirmed: false, refusal: "one-team-attach-refused", code: result.code ?? "refused", message: result.message ?? "", note: "nothing was changed; tell the owner why (a running turn: try again when it ends)" };
  }
  return {
    confirmed: true, chat_id: chatId, project_id: projectId,
    ...(result.alreadyAttached ? { already_attached: true } : {}),
    applies_from: result.appliesFrom ?? "next_turn",
    owner_message: ownerMessage("이 세션을 프로젝트에 붙였어요. 다음 턴부터 프로젝트의 폴더와 기억을 써요.", "Joined this session to the project. From its next turn it uses the project's folder and memory."),
  };
}
