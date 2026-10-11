/**
 * Group-room discussion contracts shared by Main and the One room screen (1.3.0 A4/A5).
 *
 * A discussion is a free conversation about one owner post: the members that have something to add speak, each
 * message enters the room log as soon as its speaker finishes, and the talk ends when nobody has more to add.
 * `roundNo`/`maxRounds` are internal batch counters and a hidden safety cap; the screen never shows them. Reply and
 * comment threads point at an earlier message through `replyTo`. Streamed text is never part of this contract; the screen reads it from the
 * speakers' own run event channels.
 */

export type OneDiscussionStatus = "running" | "completed" | "stopped" | "interrupted" | "failed";

/** Machine-readable reasons a discussion ended. The screen turns them into plain sentences. */
export type OneDiscussionStopReason =
  | "max_rounds" | "no_new_content" | "budget" | "owner_stop" | "settled" | "no_candidates"
  | "cap_refused" | "owner_replaced" | "interrupted_by_restart" | "failed";

export type OneDiscussionTurnStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "refused";

export interface OneDiscussionSpeaker {
  turnId: string;
  agentId: string;
  name: string;
  mode: "message" | "comment";
  status: OneDiscussionTurnStatus;
  /** The speaker's run id: its streamed text arrives on `invoke:event:<runId>`. */
  runId: string | null;
  /** The (member, room) session the run lives in; its events carry this chat id. */
  childChatId: string | null;
  /** Machine code when the turn was refused or failed (e.g. `global_speaker_cap`, `member_speaker_cap`). */
  reasonCode: string | null;
}

export interface OneDiscussionView {
  chatId: string;
  /** Effective "토론 모드": the owner's choice, else on when the room has at least two members. */
  enabled: boolean;
  /** The owner's explicit choice; null means the default applies. */
  explicit: boolean | null;
  memberCount: number;
  active: null | {
    discussionId: string;
    roundNo: number;
    maxRounds: number;
    stopRequested: boolean;
    queuedOwnerPosts: number;
    budget: { spent: number; total: number };
    speakers: OneDiscussionSpeaker[];
  };
  last: null | { discussionId: string; status: OneDiscussionStatus; stopReason: OneDiscussionStopReason | null; roundNo: number };
}

/** Thread index of the room log: where a message sits in a reply or comment thread. */
export interface OneDiscussionMessageMeta {
  messageId: string;
  seq: number;
  kind: "post" | "comment";
  author: "owner" | "member" | "system";
  speakerAgentId: string | null;
  replyTo: string | null;
  roundNo: number | null;
}

export interface OneDiscussionState extends OneDiscussionView {
  messages: OneDiscussionMessageMeta[];
}

export type OneDiscussionPostResult =
  | { handled: false; reason: "empty_post" | "not_group_room" | "discussion_off" | "too_few_members" | "not_a_discussion_post" | "room_busy" }
  | { handled: true; status: "started"; discussionId: string; messageId: string; seq: number }
  | { handled: true; status: "queued"; discussionId: string; messageId: string; seq: number; interrupt: boolean };

export interface OneDiscussionPostInput {
  chatId: string;
  text: string;
  /** Cancel the speakers that are talking now and answer this post at once. Default: queue it behind the round. */
  interrupt?: boolean;
}
