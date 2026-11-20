/*
 * How a window re-reads a conversation's state: on Main's store signal, never on a clock of its own. One call = one watcher of one
 * conversation: a signal for THIS conversation (a row written, a send queued, a stop) runs `run` once after a short burst window, and one safety net per watcher (60 s, only while
 * the window is visible) catches a signal that was lost (a write by another process reaches the window through Main's own data_version look, so a missed signal is rare, not
 * routine). A surface that used to poll the same state every 1-5 s calls this instead; the 1-5 s loops are gone.
 */
import { subscribeStoreChanges } from "@/lib/store-change-bus";

export const CHAT_SIGNAL_SAFETY_MS = 60_000;
const BURST_MS = 250;

export function watchChat(chatId: string | null | undefined, run: () => void, options: { safetyMs?: number; entities?: readonly string[] } = {}): () => void {
  if (!chatId) return () => undefined;
  const entities = new Set(options.entities ?? ["chat", "task", "long-run"]);
  let burst: ReturnType<typeof setTimeout> | null = null;
  const off = subscribeStoreChanges((change) => {
    if (!entities.has(change.entity) || (change.entity === "chat" && change.id && change.id !== chatId) || burst) return;
    burst = setTimeout(() => { burst = null; run(); }, BURST_MS);
  });
  const safety = setInterval(() => { if (typeof document === "undefined" || document.visibilityState !== "hidden") run(); }, options.safetyMs ?? CHAT_SIGNAL_SAFETY_MS);
  return () => { off(); clearInterval(safety); if (burst) clearTimeout(burst); };
}
