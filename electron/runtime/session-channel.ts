// The words a shared session is given about where it is speaking (runtime/session-scope.ts names the channel from the
// conversation's row; this file only turns that label into text).
//
// One native session can be addressed from different places: the owner's one-to-one conversation with the agent, a group
// room the agent works in, a task dispatched to it. The model keeps ONE memory for all of them, so each turn says where it
// is being spoken, and one fixed rule says what may cross: what the owner tells the agent privately stays there unless the
// owner asks; in a room the agent speaks from what that room has seen. The host cannot check meaning, so this is a rule the
// model is asked to keep, not a boundary the host enforces; the journal also records the channel of every event it writes
// (agent-context.ts `channel`), which is what a host-side filter would read.
//
// No Electron import: the background service loads the same code as the window process.
import type { SessionChannel } from "./session-scope";

/**
 * The fixed privacy rule, delivered once per session with the One-mode instructions of a seat or team-member agent (mcp/client.ts,
 * next to `reply.display` and `reply.document`). An exact line: the wording is fixed.
 */
export const CHANNEL_PRIVACY_RULE =
  "channels: what the owner tells you in a one-to-one conversation stays there unless the owner asks you to share it; in a group room speak only from what that room has seen";

/**
 * The channel as a short machine tag for the journal (`channel` on the events of a turn): `direct`, `room:<room conversation id>`,
 * `dispatch:<room conversation id>` or `dispatch`. `other` has no tag: such a turn tells the journal nothing.
 */
export function sessionChannelTag(channel: SessionChannel): string | null {
  switch (channel.kind) {
    case "direct": return "direct";
    case "room": return channel.roomChatId ? `room:${channel.roomChatId}` : "room";
    case "dispatch": return channel.roomChatId ? `dispatch:${channel.roomChatId}` : "dispatch";
    default: return null;
  }
}

/**
 * The clause every room line ends with. A rule given once, as a block of the session's first turn, is not reliably kept by every
 * model, so the reminder rides the line of every turn spoken in a room.
 */
export const ROOM_CHANNEL_CLAUSE = "speak only from what this room has seen, not from one-to-one talk";

/** The channel line of one turn (module `agent-context.channel`, turn-context); null when the channel says nothing to the agent. */
export function renderChannelLine(channel: SessionChannel): string | null {
  const room = channel.roomTitle ? `room ${JSON.stringify(channel.roomTitle)}` : "a group room";
  switch (channel.kind) {
    case "direct": return "channel: direct, one-to-one with the owner";
    case "room": return `channel: ${room}; everyone in it reads your reply; ${ROOM_CHANNEL_CLAUSE}`;
    case "dispatch": return channel.roomChatId ? `channel: ${room}, as a teammate dispatched into it; your reply goes back to that room; ${ROOM_CHANNEL_CLAUSE}`
      : "channel: a task dispatched from another conversation; your reply goes back to it";
    default: return null;
  }
}
