/**
 * Pure helpers for the group-room discussion screen (A5): thread index, plain Korean/English copy and the
 * display form of a streaming speaker answer. No React and no IPC here, so the rules are testable.
 */
import type {
  OneDiscussionMessageMeta, OneDiscussionSpeaker, OneDiscussionState, OneDiscussionStopReason,
} from "@shared/one-discussion";

export type DiscussionLocale = "ko" | "en";

export interface DiscussionThreadIndex {
  byId: Map<string, OneDiscussionMessageMeta>;
  /** Comments grouped under the message they comment on, oldest first. */
  comments: Map<string, OneDiscussionMessageMeta[]>;
}

export function indexDiscussionMessages(meta: readonly OneDiscussionMessageMeta[]): DiscussionThreadIndex {
  const byId = new Map<string, OneDiscussionMessageMeta>();
  const comments = new Map<string, OneDiscussionMessageMeta[]>();
  for (const item of meta) {
    byId.set(item.messageId, item);
    if (item.kind === "comment" && item.replyTo) {
      const list = comments.get(item.replyTo) ?? [];
      list.push(item);
      comments.set(item.replyTo, list);
    }
  }
  for (const list of comments.values()) list.sort((a, b) => a.seq - b.seq);
  return { byId, comments };
}

/**
 * A comment draws under the message it comments on, not in the main flow. Only when that message is on screen:
 * otherwise (older page, deleted parent) it stays in the flow so nothing is hidden.
 */
export function isNestedComment(meta: OneDiscussionMessageMeta | undefined, visibleIds: ReadonlySet<string>): boolean {
  return Boolean(meta && meta.kind === "comment" && meta.replyTo && visibleIds.has(meta.replyTo));
}

export const THREAD_PREVIEW_COUNT = 2;
export const THREAD_LONG_TEXT = 260;

/** Collapse a long thread: show the first few comments, say how many are hidden. A single long comment also folds. */
export function collapseThread<T extends { text: string }>(comments: readonly T[], expanded: boolean): { shown: T[]; hidden: number; foldedText: boolean } {
  if (expanded) return { shown: [...comments], hidden: 0, foldedText: false };
  const shown = comments.slice(0, THREAD_PREVIEW_COUNT);
  return { shown, hidden: comments.length - shown.length, foldedText: comments.some((comment) => comment.text.length > THREAD_LONG_TEXT) };
}

export function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}

/** What the owner sees of a streaming answer: the control markers the speaker may write are not for reading. */
export function displaySpeakerText(raw: string): string {
  return raw
    .replace(/^\s*\[\[(?:reply|comment):#\d{1,9}\]\]\s*/iu, "")
    .replace(/\[\[(?:reply|comment):#\d{1,9}\]\]\s*/giu, "")
    .replace(/^\s*\[\[pass\]\]\s*$/iu, "")
    .replace(/^\s*\[\[(?:r|re|rep|repl|reply|c|co|com|comm|comme|commen|comment|p|pa|pas|pass)?\]?\]?\s*$/iu, "")
    .trimStart();
}

export function speakingNames(speakers: readonly OneDiscussionSpeaker[]): string[] {
  return speakers.filter((speaker) => speaker.status === "running" || speaker.status === "pending").map((speaker) => speaker.name);
}

/** Screen-reader text for the quiet activity strip. Never shown as a label: the strip is avatars with a dot. */
export function activityLabel(state: OneDiscussionState | null, locale: DiscussionLocale): string | null {
  const active = state?.active;
  if (!active) return null;
  if (active.stopRequested) return locale === "ko" ? "대화를 멈추는 중" : "Stopping the conversation";
  const names = speakingNames(active.speakers);
  if (names.length === 0) return null;
  return locale === "ko" ? `${names.join(", ")} 님이 답을 쓰고 있어요` : `${names.join(", ")} replying`;
}

/** Members who are working on a reply right now, for the avatar strip. */
export function activeSpeakers(state: OneDiscussionState | null): OneDiscussionSpeaker[] {
  return (state?.active?.speakers ?? []).filter((speaker) => speaker.status === "running" || speaker.status === "pending");
}

export function queuedNotice(state: OneDiscussionState | null, locale: DiscussionLocale): string | null {
  const queued = state?.active?.queuedOwnerPosts ?? 0;
  if (queued <= 0) return null;
  return locale === "ko"
    ? `보낸 글 ${queued}개는 곧 이어서 답해요.`
    : `${queued === 1 ? "Your new post" : `Your ${queued} new posts`} will be answered next.`;
}

/**
 * Plain sentence for a conversation that ended in a way the owner should know about; null when it simply finished.
 * A natural end (nobody had more to add) and the hidden safety caps (`max_rounds`, `budget`) are silent.
 */
export function stopNotice(state: OneDiscussionState | null, locale: DiscussionLocale): string | null {
  const last = state?.last;
  if (!last || state?.active) return null;
  const reason: OneDiscussionStopReason | null = last.stopReason;
  const ko: Partial<Record<OneDiscussionStopReason, string>> = {
    owner_stop: "대화를 멈췄어요.",
    cap_refused: "동시에 말할 수 있는 수가 가득 차 아무도 시작하지 못했어요. 잠시 뒤 다시 보내 주세요.",
    interrupted_by_restart: "앱이 다시 시작되며 대화가 중단됐어요. 이어가려면 글을 보내 주세요.",
    failed: "대화가 오류로 멈췄어요.",
  };
  const en: Partial<Record<OneDiscussionStopReason, string>> = {
    owner_stop: "Conversation stopped.",
    cap_refused: "Every speaking slot was taken, so nobody could start. Try again shortly.",
    interrupted_by_restart: "The app restarted and the conversation was interrupted. Send a post to continue.",
    failed: "The conversation stopped because of an error.",
  };
  return reason ? (locale === "ko" ? ko : en)[reason] ?? null : null;
}

/** Why one speaker did not speak this round, in plain words. */
export function speakerRefusalNotice(speaker: OneDiscussionSpeaker, locale: DiscussionLocale): string | null {
  if (speaker.status !== "refused" && speaker.status !== "failed" && speaker.status !== "cancelled") return null;
  const code = speaker.reasonCode ?? "";
  const ko: Record<string, string> = {
    global_speaker_cap: "동시에 말할 수 있는 수가 가득 차 이번엔 건너뛰었어요",
    member_speaker_cap: "다른 방에서 이미 말하는 중이라 이번엔 건너뛰었어요",
    member_busy: "다른 일을 하는 중이라 이번엔 건너뛰었어요",
    invocation_chat_busy: "다른 일을 하는 중이라 이번엔 건너뛰었어요",
    turn_timeout: "답이 너무 오래 걸려 멈췄어요",
    empty_answer: "답을 받지 못했어요",
  };
  const en: Record<string, string> = {
    global_speaker_cap: "skipped: every speaking slot was taken",
    member_speaker_cap: "skipped: already speaking in another room",
    member_busy: "skipped: busy with other work",
    invocation_chat_busy: "skipped: busy with other work",
    turn_timeout: "stopped: the answer took too long",
    empty_answer: "no answer received",
  };
  const fallback = speaker.status === "cancelled"
    ? (locale === "ko" ? "멈췄어요" : "stopped")
    : (locale === "ko" ? "이번엔 말하지 못했어요" : "could not speak this time");
  return (locale === "ko" ? ko : en)[code] ?? fallback;
}

/** Accumulates one speaker's streamed answer from run events (the same deltas the single-run screen reads). */
export interface LiveSpeakerText { text: string; done: boolean }

export function reduceLiveSpeakerText(
  current: LiveSpeakerText | undefined,
  event: { kind: string; delta?: string; text?: string; agentId?: string; phase?: string },
  isCommitBoundary: boolean,
): LiveSpeakerText | undefined {
  const base = current ?? { text: "", done: false };
  if (event.agentId && event.phase !== "synthesize") return current;
  if (event.kind === "partial") {
    if (isCommitBoundary) return base;
    if (typeof event.delta === "string") return { ...base, text: base.text + event.delta };
    if (typeof event.text === "string") return { ...base, text: event.text };
    return base;
  }
  if (event.kind === "final") return { text: typeof event.text === "string" && event.text ? event.text : base.text, done: true };
  return current;
}

/** An explicit `@One` (or `@<One's name>`) sends the post to One itself, never to a group discussion. */
export function addressesOneDirectly(text: string, oneName: string): boolean {
  const names = new Set(["one", oneName.trim().toLowerCase()].filter(Boolean));
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)@${escaped}(?=$|[\\s,.!?:])`, "iu").test(text)) return true;
  }
  return false;
}

type RoomRow = { id: string; durableMessageId?: string; createdAt?: string };

/** Ids the discussion log holds that the screen's transcript does not show yet. */
export function missingDiscussionIds(current: readonly RoomRow[], meta: readonly OneDiscussionMessageMeta[]): string[] {
  const seen = new Set(current.flatMap((row) => [row.id, row.durableMessageId ?? row.id]));
  return meta.filter((item) => !seen.has(item.messageId)).map((item) => item.messageId);
}

/**
 * Adds the room messages a conversation wrote after the transcript was loaded (members' replies, the owner's own
 * post). Only rows the discussion log names are added, at their durable time; optimistic turns and the live
 * response of an ordinary run are never replaced by a history snapshot.
 */
export function mergeDiscussionRows<T extends RoomRow>(current: T[], history: readonly T[], wanted: ReadonlySet<string>): T[] {
  const seen = new Set(current.flatMap((row) => [row.id, row.durableMessageId ?? row.id]));
  let next = current;
  for (const row of history) {
    const durable = row.durableMessageId ?? row.id;
    if (!(wanted.has(row.id) || wanted.has(durable)) || seen.has(row.id) || seen.has(durable)) continue;
    if (next === current) next = [...current];
    const at = row.createdAt ? Date.parse(row.createdAt) : NaN;
    const index = Number.isFinite(at) ? next.findIndex((item) => item.createdAt && Date.parse(item.createdAt) > at) : -1;
    next.splice(index < 0 ? next.length : index, 0, row);
    seen.add(row.id);
    seen.add(durable);
  }
  return next;
}
