"use client";
// One Enter rule for every chat composer (owner 2026-10-13, "전수조사 챗창들"): Enter sends, Shift+Enter is a newline,
// keys the IME still holds are left alone, and the Enter that commits a Hangul syllable also sends. The decision is
// decideComposerEnter (one-composer-ime.ts); this hook carries the composition state a textarea needs for it.
import { useRef } from "react";
import type { CompositionEvent, KeyboardEvent } from "react";
import { decideComposerEnter, isHangulComposition } from "./one-composer-ime";

export interface ComposerEnterHandlers<T extends HTMLElement> {
  onCompositionUpdate: (event: CompositionEvent<T>) => void;
  onCompositionEnd: (event: CompositionEvent<T>) => void;
  /** Returns true when the key was handled here (sent, held for the commit, or swallowed). */
  handleEnter: (event: KeyboardEvent<T>) => boolean;
}

export function useComposerEnter<T extends HTMLElement = HTMLTextAreaElement>(send: () => void): ComposerEnterHandlers<T> {
  const sendRef = useRef(send);
  sendRef.current = send;
  const compositionText = useRef("");
  const lastEnd = useRef<number | null>(null);
  const sendAfterCommit = useRef(false);
  // The commit's send is scheduled: Chromium on macOS follows a composing Enter with a second, plain Enter keydown, and
  // sending on it too made one Enter two sends (owner 2026-10-14, One room: the second, empty one paused the run).
  const commitSendScheduled = useRef(false);
  return {
    onCompositionUpdate: (event) => { compositionText.current = event.data ?? ""; },
    onCompositionEnd: (event) => {
      lastEnd.current = performance.now();
      if (event.data) compositionText.current = event.data;
      if (sendAfterCommit.current) {
        sendAfterCommit.current = false;
        commitSendScheduled.current = true;
        // The committed syllable reaches the value (and React state) after this event.
        window.setTimeout(() => { commitSendScheduled.current = false; sendRef.current(); }, 0);
      }
    },
    handleEnter: (event) => {
      const decision = decideComposerEnter({
        key: event.key,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        msSinceCompositionEnd: lastEnd.current === null ? null : performance.now() - lastEnd.current,
        committedHangul: isHangulComposition(compositionText.current),
      });
      if (decision === "ignore") return false;
      if (decision === "send-after-commit") { sendAfterCommit.current = true; return true; }
      event.preventDefault();
      if (decision === "send" && !commitSendScheduled.current) {
        // A composing Enter whose compositionend never came must not send a later syllable on its own.
        sendAfterCommit.current = false;
        sendRef.current();
      }
      return true;
    },
  };
}
