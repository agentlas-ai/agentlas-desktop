/*
 * The files of one conversation, computed once for every place that names them: the chip line under each answer (OneTurnFiles) and the Overview's Outputs
 * list (TaskSidePanel) read the same ledger, so a file the chip shows is a file the list shows, and a file an earlier answer wrote reads "Edited" in a
 * later one (turn-files.ts: settleTurnFileOps). Before this the chips came from each answer's own typed edit calls while the list read only what Main
 * bound as an artifact, and the two disagreed.
 *
 * Pure apart from two WeakMaps keyed by the message object: a message in React state is replaced, never changed in place, so an answer that has settled
 * is read once however often the stream re-renders around it (a streaming frame replaces only the last message). Nothing is persisted.
 */
import type { OneActivityState } from "./one-activity";
import { distinctTurnFiles, settleTurnFileOps, turnFilesOfActivity, type TurnFile } from "./turn-files";

export interface TurnFileMessage { id: string; role: string; busy?: boolean; streaming?: boolean }
export interface ChatTurnFiles {
  /** Per answer (by the message's id): its files, ops settled across the conversation. An answer that is still running or made no file is absent. */
  byMessage: ReadonlyMap<string, readonly TurnFile[]>;
  /** The conversation's files, once each, in the order they were first touched. */
  chat: readonly TurnFile[];
}

const rawCache = new WeakMap<object, { locale: string; root: string; files: TurnFile[] }>();
const settledCache = new WeakMap<object, readonly TurnFile[]>();
const EMPTY: ChatTurnFiles = { byMessage: new Map(), chat: [] };

const sameFiles = (a: readonly TurnFile[], b: readonly TurnFile[]): boolean => a.length === b.length && a.every((file, index) => file.path === b[index].path && file.op === b[index].op);

export function chatTurnFiles<M extends TurnFileMessage>(
  messages: readonly M[],
  statesOf: (message: M) => readonly OneActivityState[],
  locale: "ko" | "en",
  workspacePath: string | null | undefined,
): ChatTurnFiles {
  const answers = messages.filter((message) => message.role === "agent" && !message.busy && !message.streaming);
  if (answers.length === 0) return EMPTY;
  const root = workspacePath ?? "";
  const raw = answers.map((message) => {
    const cached = rawCache.get(message);
    if (cached && cached.locale === locale && cached.root === root) return cached.files;
    const files = turnFilesOfActivity(statesOf(message), locale, workspacePath);
    rawCache.set(message, { locale, root, files });
    return files;
  });
  const settled = settleTurnFileOps(raw);
  const byMessage = new Map<string, readonly TurnFile[]>();
  answers.forEach((message, index) => {
    const files = settled[index];
    if (files.length === 0) return;
    const before = settledCache.get(message);
    const keep = before && sameFiles(before, files) ? before : files;
    settledCache.set(message, keep);
    byMessage.set(message.id, keep);
  });
  return { byMessage, chat: distinctTurnFiles(settled) };
}
