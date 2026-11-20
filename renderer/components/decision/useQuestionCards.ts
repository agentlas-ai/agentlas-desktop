"use client";
// The questions a conversation waits on, from the three places Main holds them, as one list of cards, with the closed state and the way back.
//   1. the last assistant row's <<agentlas-ask>> fence  - read from the stored history on a store signal (never a timer); a surface that already holds
//      its own live view of that row (Work streams it) passes it as `fence` instead and nothing is read here
//   2. Main's pending decision questions                 - lib/attention.ts (the confirmations Main lists)
//   3. a tool's blocking ask_user                        - lib/ask-user-queue.ts (Main pushes it)
// The hook answers nothing: each surface keeps its own Main commit for a given answer and hands the card to QuestionCardHost.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { extractQuestions } from "@/lib/ask-question";
import { useChatConfirmations, usePendingConfirmationList } from "@/lib/attention";
import { useAskUserQueue } from "@/lib/ask-user-queue";
import { ipc } from "@/lib/ipc";
import { readOneChatHistory } from "@/lib/one-chat-history";
import { subscribeStoreChanges } from "@/lib/store-change-bus";
import {
  askUserToCard, closeQuestionCard, confirmationToCard, fenceCardKey, pruneClosedQuestionCards, reopenQuestionCard, useClosedQuestionCards,
  type QuestionCardModel,
} from "@/lib/question-cards";

export interface QuestionCards {
  /** Every question the conversation waits on (closed ones included). */
  cards: QuestionCardModel[];
  /** The ones to draw as a card now (not closed by the person). */
  open: QuestionCardModel[];
  /** The ones the person closed with X that still wait: the surface draws a Reopen line for each. */
  closed: Array<{ card: QuestionCardModel; count: number }>;
  close: (card: QuestionCardModel) => void;
  reopen: (card: QuestionCardModel) => void;
}

export function useQuestionCards(chatId: string | null | undefined, options: {
  /** The surface's own live view of the fence batch (null: it has none). Leave undefined to have it read from the stored history. */
  fence?: QuestionCardModel | null;
  /** Which of the Main-held sources this surface draws (default: all). */
  sources?: { decision?: boolean; askUser?: boolean };
  /**
   * Forget a closed entry once its question is gone from the sources this hook reads (default true). A surface that draws a decision from a list of its
   * own (the full One view also holds decisions embedded from other panes) passes false: the shared list may not know a decision that surface shows,
   * and a closed card must not reopen by itself. Such an entry ends by the retention rule alone (lib/question-cards.ts).
   */
  prune?: boolean;
} = {}): QuestionCards {
  const wantDecision = options.sources?.decision !== false;
  const wantAskUser = options.sources?.askUser !== false;
  const confirmations = useChatConfirmations(wantDecision ? chatId : null);
  // Main's decision list has not been read yet (null): an empty answer then means "not known", never "gone".
  const decisionList = usePendingConfirmationList();
  const decisionsKnown = !wantDecision || decisionList !== null;
  const askUsers = useAskUserQueue();
  const closedList = useClosedQuestionCards(chatId);
  const ownFence = options.fence !== undefined;
  const [stored, setStored] = useState<{ chatId: string | null; card: QuestionCardModel | null; read: boolean }>({ chatId: null, card: null, read: false });
  const chatRef = useRef(chatId);
  chatRef.current = chatId;

  useEffect(() => {
    if (ownFence || !chatId) return;
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    let loading = false;
    let burst: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      if (cancelled || loading) return;
      loading = true;
      void readOneChatHistory(api, chatId).then((rows) => {
        if (cancelled || chatRef.current !== chatId) return;
        // The newest assistant row with a fence, and no person's row after it: a newer message makes the question stale (Main's own rule).
        const lastUser = rows.map((row) => row.role).lastIndexOf("user");
        let card: QuestionCardModel | null = null;
        for (let index = rows.length - 1; index > lastUser; index -= 1) {
          const row = rows[index];
          if (row.role !== "assistant" || typeof row.text !== "string") continue;
          const found = extractQuestions(row.text, row.id).questions.filter((item) => item.question.trim() && item.options.length > 0);
          if (found.length) {
            card = { key: fenceCardKey(found), source: "chat-fence", chatId, origin: { messageId: row.id }, questions: found };
          }
          break;
        }
        setStored((current) => (current.chatId === chatId && current.read && current.card?.key === card?.key ? current : { chatId, card, read: true }));
      }).catch(() => undefined).finally(() => { loading = false; });
    };
    read();
    const off = subscribeStoreChanges((change) => {
      if (change.entity !== "chat" || (change.id && change.id !== chatId) || burst) return;
      burst = setTimeout(() => { burst = null; read(); }, 250);
    });
    return () => { cancelled = true; off(); if (burst) clearTimeout(burst); };
  }, [chatId, ownFence]);

  const cards = useMemo(() => {
    const list: QuestionCardModel[] = [];
    const fence = ownFence ? options.fence ?? null : (stored.chatId === chatId ? stored.card : null);
    if (fence) list.push(fence);
    if (chatId) for (const confirmation of confirmations) list.push(confirmationToCard(confirmation, chatId));
    if (wantAskUser && chatId) for (const request of askUsers) if (request.chatId === chatId) list.push(askUserToCard(request));
    return list;
  }, [askUsers, chatId, confirmations, options.fence, ownFence, stored, wantAskUser]);

  // A closed entry whose question is gone from its source (answered, superseded, expired) is forgotten - but only once the sources have been read.
  const ready = (ownFence || (stored.chatId === chatId && stored.read)) && decisionsKnown && options.prune !== false;
  useEffect(() => {
    if (ready) pruneClosedQuestionCards(chatId, new Set(cards.map((card) => card.key)));
  }, [cards, chatId, ready]);

  const closedKeys = useMemo(() => new Map(closedList.map((item) => [item.key, item.count])), [closedList]);
  const open = useMemo(() => cards.filter((card) => !closedKeys.has(card.key)), [cards, closedKeys]);
  const closed = useMemo(() => cards.filter((card) => closedKeys.has(card.key)).map((card) => ({ card, count: closedKeys.get(card.key) ?? 1 })), [cards, closedKeys]);
  const close = useCallback((card: QuestionCardModel) => closeQuestionCard(chatId, card.key, card.questions.length), [chatId]);
  const reopen = useCallback((card: QuestionCardModel) => reopenQuestionCard(chatId, card.key), [chatId]);
  return { cards, open, closed, close, reopen };
}
