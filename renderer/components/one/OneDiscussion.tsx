"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { ipc, ipcEvents } from "@/lib/ipc";
import { subscribeOrderedRunEvents } from "@/lib/ordered-run-events";
import {
  clipText, collapseThread, indexDiscussionMessages, reduceLiveSpeakerText,
  type DiscussionLocale, type DiscussionThreadIndex, type LiveSpeakerText,
} from "@/lib/one-discussion";
import { isLivePartialCommitBoundary } from "@shared/interrupted-partial";
import type { OneDiscussionPostResult, OneDiscussionState } from "@shared/one-discussion";
import type { OneOrgMember } from "@shared/one-org";
import { OneAgentPortrait } from "./OneAgentPortrait";
import shell from "./OneShell.module.css";
import styles from "./OneDiscussion.module.css";

export function memberForAgent(members: readonly OneOrgMember[] | undefined, agentId: string | null | undefined): OneOrgMember | undefined {
  return agentId ? members?.find((member) => member.installedAgentId === agentId) : undefined;
}

export interface OneDiscussionController {
  state: OneDiscussionState | null;
  index: DiscussionThreadIndex;
  live: Record<string, LiveSpeakerText>;
  stopping: boolean;
  refresh: () => void;
  post: (text: string) => Promise<OneDiscussionPostResult>;
  stop: () => Promise<void>;
  setEnabled: (enabled: boolean | null) => Promise<void>;
}

const EMPTY_INDEX: DiscussionThreadIndex = { byId: new Map(), comments: new Map() };

/**
 * State of the room's discussion plus each speaker's streaming text. Streamed text comes from the speakers' own run
 * event channels (the same ordered stream the single-run screen reads); only finished messages are in the room log.
 */
export function useOneDiscussion(input: { chatId: string | null; enabled: boolean }): OneDiscussionController {
  const { chatId, enabled } = input;
  const [state, setState] = useState<OneDiscussionState | null>(null);
  const [live, setLive] = useState<Record<string, LiveSpeakerText>>({});
  const [stopping, setStopping] = useState(false);
  const chatRef = useRef<string | null>(null);
  chatRef.current = enabled ? chatId : null;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const target = chatRef.current;
    const api = ipc();
    if (!target || !api?.oneDiscussion) return;
    try {
      const next = await api.oneDiscussion.state(target);
      if (chatRef.current === target) setState(next);
    } catch { /* the room still works as a single-run room */ }
  }, []);

  const refresh = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => { timerRef.current = null; void load(); }, 120);
  }, [load]);

  useEffect(() => {
    setState(null);
    setLive({});
    setStopping(false);
    if (!enabled || !chatId) return;
    void load();
    const unsubscribe = ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "chat" && change.id === chatId) refresh();
      if (change.entity === "one-taskforce") refresh();
    });
    return () => {
      unsubscribe?.();
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [chatId, enabled, load, refresh]);

  // Safety net while a discussion runs: a missed change event never leaves the bar stale.
  const running = Boolean(state?.active);
  useEffect(() => {
    if (!running) { setStopping(false); return; }
    const id = setInterval(() => { void load(); }, 2_000);
    return () => clearInterval(id);
  }, [running, load]);

  // One ordered subscription per speaker that is talking now.
  const speakers = state?.active?.speakers ?? [];
  const streamKey = speakers
    .filter((speaker) => speaker.runId && speaker.childChatId && (speaker.status === "running" || speaker.status === "pending"))
    .map((speaker) => `${speaker.runId}@${speaker.childChatId}`).join("|");
  useEffect(() => {
    const api = ipc();
    const events = ipcEvents();
    if (!api || !events || !streamKey) return;
    const unsubscribes = streamKey.split("|").map((pair) => {
      const [runId, childChatId] = pair.split("@") as [string, string];
      const apply = (event: Parameters<typeof reduceLiveSpeakerText>[1] & { kind: string }) => {
        setLive((current) => {
          const next = reduceLiveSpeakerText(current[runId], event, isLivePartialCommitBoundary(event as never));
          return next === current[runId] || !next ? current : { ...current, [runId]: next };
        });
      };
      return subscribeOrderedRunEvents({
        runId, chatId: childChatId,
        listen: (listener) => events.on(api.invoke.eventChannel(runId), listener),
        replay: (replayInput) => api.invoke.replay(replayInput),
        consume: (event) => apply(event as never),
        recover: async (snapshot) => {
          if (snapshot.partialText !== undefined) {
            setLive((current) => ({ ...current, [runId]: { text: snapshot.partialText!, done: false } }));
          }
          return true;
        },
      });
    });
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [streamKey]);

  // Speakers that left the round no longer need their buffered text.
  useEffect(() => {
    if (running) return;
    setLive((current) => (Object.keys(current).length ? {} : current));
  }, [running]);

  const index = useMemo(() => (state ? indexDiscussionMessages(state.messages) : EMPTY_INDEX), [state]);

  const post = useCallback(async (text: string): Promise<OneDiscussionPostResult> => {
    const target = chatRef.current;
    const api = ipc();
    if (!target || !api?.oneDiscussion) return { handled: false, reason: "not_group_room" };
    const result = await api.oneDiscussion.post({ chatId: target, text });
    void load();
    return result;
  }, [load]);

  const stop = useCallback(async () => {
    const target = chatRef.current;
    const api = ipc();
    if (!target || !api?.oneDiscussion) return;
    setStopping(true);
    try { await api.oneDiscussion.stop(target); } finally { void load(); }
  }, [load]);

  const setEnabled = useCallback(async (next: boolean | null) => {
    const target = chatRef.current;
    const api = ipc();
    if (!target || !api?.oneDiscussion) return;
    setState(await api.oneDiscussion.setEnabled({ chatId: target, enabled: next }));
  }, []);

  return { state, index, live, stopping, refresh, post, stop, setEnabled };
}

export interface ThreadComment { messageId: string; text: string; createdAt?: string; timeLabel?: string; speakerAgentId: string | null }

/** Comments under the message they answer. Folded to the first two when the thread is long. */
export function OneDiscussionThread({ comments, members, locale }: {
  comments: readonly ThreadComment[];
  members: readonly OneOrgMember[] | undefined;
  locale: DiscussionLocale;
}) {
  const [expanded, setExpanded] = useState(false);
  if (comments.length === 0) return null;
  const { shown, hidden, foldedText } = collapseThread(comments, expanded);
  return (
    <div className={styles.thread} data-one-discussion-thread="true" data-count={comments.length}>
      {shown.map((comment) => {
        const member = memberForAgent(members, comment.speakerAgentId);
        const label = member?.displayName ?? (locale === "ko" ? "팀원" : "Member");
        return (
          <div key={comment.messageId} className={styles.comment} data-one-comment-id={comment.messageId}>
            <OneAgentPortrait status={member?.statusKind ?? "quiet"} label={label} tone={member?.icon ?? "character:blue-wave"} size="small" />
            <div>
              <div className={styles.commentMeta}>
                <strong>{label}</strong>
                {comment.createdAt && <time dateTime={comment.createdAt}>{comment.timeLabel}</time>}
              </div>
              <div className={styles.commentBody} data-folded={foldedText && !expanded ? "true" : undefined}>
                <Markdown text={comment.text} messageId={`comment:${comment.messageId}`} />
              </div>
            </div>
          </div>
        );
      })}
      {(hidden > 0 || foldedText || expanded) && (
        <button type="button" className={styles.more} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded
            ? (locale === "ko" ? "접기" : "Collapse")
            : hidden > 0
              ? (locale === "ko" ? `댓글 ${hidden}개 더 보기` : `Show ${hidden} more ${hidden === 1 ? "comment" : "comments"}`)
              : (locale === "ko" ? "펼쳐 보기" : "Show full text")}
        </button>
      )}
    </div>
  );
}

/** "↪ Kai: 그 날짜는 …" above a member's reply, pointing at the message it answers. */
export function OneDiscussionReplyContext({ parentLabel, snippet, onJump, locale }: {
  parentLabel: string; snippet: string; onJump: () => void; locale: DiscussionLocale;
}) {
  return (
    <button type="button" className={styles.replyContext} onClick={onJump} data-one-discussion-reply="true"
      aria-label={locale === "ko" ? `${parentLabel}의 글에 답한 글, 원문으로 이동` : `Reply to ${parentLabel}, jump to the original`}>
      <strong>↪ {parentLabel}</strong>
      <span>{clipText(snippet, 80)}</span>
    </button>
  );
}
