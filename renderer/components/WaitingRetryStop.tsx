"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";

/**
 * The owner's Stop in the gap between two attempts of a message the app is sending again by itself (a start that failed before any
 * model call for the app's own state, started again after a backoff). No run is live in that gap, so the composer's own Stop is not
 * drawn, and the owner had no way to take the message back. Main counts the waiting messages of the chat (invoke:waitingRetries) and
 * the Stop is the same abandonWaitingRetries the run's Stop and the phone's Stop call (invoke:stopWaitingRetries).
 *
 * Draws nothing while a run is live (`live`: the usual Stop is there) or while nothing waits. One line and one button, no code.
 */
export function waitingRetryCopy(locale: "ko" | "en"): { waiting: string; stop: string; stopped: string } {
  return locale === "ko"
    ? { waiting: "메시지를 앱이 다시 보내는 중이에요.", stop: "중지", stopped: "멈췄어요. 이 메시지는 다시 보내지 않아요." }
    : { waiting: "The app is sending your message again.", stop: "Stop", stopped: "Stopped. This message will not be sent again." };
}

const POLL_WHILE_WAITING_MS = 5_000;
const STOPPED_NOTICE_MS = 6_000;

export function WaitingRetryStop({ chatId, locale, live, maxWidth }: { chatId: string | null; locale: "ko" | "en"; live: boolean; maxWidth?: number }) {
  const [waiting, setWaiting] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [stoppedNotice, setStoppedNotice] = useState(false);
  const chatRef = useRef(chatId);
  chatRef.current = chatId;
  const copy = waitingRetryCopy(locale);

  const read = useCallback(() => {
    const api = ipc();
    const id = chatRef.current;
    if (!api?.invoke.waitingRetries || !id) { setWaiting(0); return; }
    void api.invoke.waitingRetries(id).then((answer) => {
      if (chatRef.current === id) setWaiting(Math.max(0, Math.floor(Number(answer?.waiting) || 0)));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    setWaiting(0);
    setStopping(false);
    setStoppedNotice(false);
    if (!chatId) return;
    read();
    const events = ipcEvents();
    const unsubscribe = events?.onStoreChanged?.((change) => {
      if (change.entity === "chat" && change.id === chatId) read();
    });
    return () => { unsubscribe?.(); };
  }, [chatId, read]);

  // The queue emits a change when a message starts waiting or starts again; the slow read is only the net under a missed event.
  useEffect(() => {
    if (waiting <= 0) return;
    const timer = setInterval(read, POLL_WHILE_WAITING_MS);
    return () => clearInterval(timer);
  }, [waiting, read]);

  useEffect(() => {
    if (!stoppedNotice) return;
    const timer = setTimeout(() => setStoppedNotice(false), STOPPED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [stoppedNotice]);

  const stop = useCallback(() => {
    const api = ipc();
    const id = chatRef.current;
    if (!api?.invoke.stopWaitingRetries || !id || stopping) return;
    setStopping(true);
    void api.invoke.stopWaitingRetries(id).then((answer) => {
      if (chatRef.current !== id) return;
      setWaiting(0);
      if ((answer?.stopped ?? 0) > 0) setStoppedNotice(true);
      else read(); // one just started: the run's own Stop is drawn now
    }).catch(() => { read(); }).finally(() => setStopping(false));
  }, [read, stopping]);

  const box = { maxWidth, margin: "6px auto", display: "flex", alignItems: "center", gap: 10, color: "var(--ink-soft)", fontSize: 12 } as const;
  if (stoppedNotice && !live) return <p role="status" data-waiting-retry-stopped="true" style={box}>{copy.stopped}</p>;
  if (live || waiting <= 0) return null;
  return (
    <div role="status" data-waiting-retry-stop="true" style={box}>
      <span>{copy.waiting}</span>
      <button
        type="button"
        data-waiting-retry-stop-button="true"
        onClick={stop}
        disabled={stopping}
        aria-label={copy.stop}
        style={{ border: "1px solid var(--paper-edge)", background: "var(--paper)", color: "var(--ink)", borderRadius: 8, padding: "3px 10px", fontSize: 12, cursor: stopping ? "default" : "pointer", opacity: stopping ? 0.72 : 1 }}
      >
        {copy.stop}
      </button>
    </div>
  );
}
