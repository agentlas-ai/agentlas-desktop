/**
 * Home's left tree: what Main sends the renderer. Rows are light on purpose — no message text, no
 * runtime state. Running / needs-attention dots are not here: the renderer joins them from its existing sources
 * (`useChatAttention`, the active-chats broadcast), so a model turn never makes Main rebuild the tree.
 *
 * Read-only: every field is derived from rows that already exist (`chats`, `tasks`, `one_taskforces`, `one_seats`,
 * `installed_agents`). Nothing here is stored, migrated or written back.
 */
export type HomeTreeRowKind = "solo" | "group" | "work";

export interface HomeTreeRow {
  /** `chats.id`. The one key every surface already uses to open the conversation. */
  id: string;
  kind: HomeTreeRowKind;
  /** `projects.id`, null = No Project. */
  projectId: string | null;
  /** Work rows: the task title (what the Work lists showed). Agent chats: the chat title (may be the default "New chat"). */
  title: string;
  /** Work rows only: the task a Work route needs (`/workspace/task?id=<chat>&task=<task>`). */
  taskId: string | null;
  /** Up to three agent display names (solo: the one agent; group: the first members). */
  agentNames: string[];
  /** Group rows: how many members the room has (>= agentIds.length). Solo / work: 1 or 0. */
  memberCount: number;
  /** When the last visible line appeared (Work: the task's update time) — NOT chats.updated_at, which quiet state changes also move. */
  updatedAt: string;
}

export interface HomeTreeSnapshot {
  rows: HomeTreeRow[];
  /** True when more rows matched than were sent (the tree then says so instead of silently dropping). */
  truncated: boolean;
}

export interface HomeTreeParticipant {
  agentId: string;
  /** Null when the agent is no longer installed (the room keeps the id; the renderer shows a neutral label). */
  name: string | null;
}

export interface HomeRowsByIdsResult {
  rows: HomeTreeRow[];
  /**
   * Every chat id the given ids resolved to (the ids themselves when they are chat ids, `tasks.origin_chat_id` for task ids,
   * `one_taskforces.chat_id` for taskforce ids). A resolved chat that is not in `rows` no longer belongs in the tree.
   */
  chatIds: string[];
}

/** Channel names, kept in one place so Main, preload and the renderer cannot drift. */
export const HOME_TREE_CHANNELS = {
  tree: "home:tree",
  rowsByIds: "home:rowsByIds",
  participants: "home:participants",
  search: "home:search",
  /** A group room's live state: members waiting behind their own earlier turn or out a provider limit. Live only; nothing stored. */
  roomWaiting: "home:roomWaiting",
  /** The room's own Stop: ends the whole request (running and waiting turns, queued turns, hand-offs to come). */
  stopRoom: "home:stopRoom",
  /** What the lines on screen draw beyond a row: preview, faces, runner. Asked only for the rows in view; nothing stored. */
  lines: "home:lines",
  /** A member clicked under a group room: the one-to-one with that member in the room's own project (found, or made). */
  openMember: "home:openMember",
} as const;

/** One face in a row's overlapped avatar: the agent and the tone `installed_agents.tone` gives it. */
export interface HomeLineFace { agentId: string; name: string; tone: string }

/**
 * What one visible row needs that `home:tree` rows do not carry (they stay light). Agent chats: `preview` (the last user or
 * agent line, one line, at most 160 characters) and `faces` (at most three). Work sessions: `runner`, the runtime kind the
 * session was started on (`chats.runtime_selection_json.kind`) and its display label when the selection gave one; absent when
 * the session has no saved choice - the app then shows no runner name rather than guess one. `lead` is set on a group room that
 * runs under the lead model (the personal agent is not in it, decision): the room's own mark, never read from a title.
 */
export interface HomeLine { id: string; preview?: string; faces?: HomeLineFace[]; runner?: string; runnerLabel?: string; lead?: true }

/** Most characters of a preview. */
export const HOME_LINE_PREVIEW_LIMIT = 160;
/** Most faces a row draws. */
export const HOME_LINE_FACE_LIMIT = 3;

export interface HomeOpenMemberResult { chatId: string; created: boolean }

export interface HomeRoomWaiting { agentId: string; kind: "turn" | "retry" }

/** Most rows one `home:tree` call sends. Past this the tree shows "more…" for the project (never a silent cut). */
export const HOME_TREE_ROW_LIMIT = 2_000;
/** Most ids one `home:rowsByIds` call takes. */
export const HOME_TREE_ID_LIMIT = 200;
