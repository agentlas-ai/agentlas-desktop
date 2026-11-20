"use client";
import { useState } from "react";
import { ClosedQuestionLine, QuestionCardHost } from "@/components/decision/QuestionCardHost";
import { closeQuestionCard, reopenQuestionCard, useClosedQuestionCards } from "@/lib/question-cards";
import type { PersonalOnePendingAsk } from "@/lib/personal-one-transcript";

/**
 * The personal window's question for a question Hope ended its answer on. It draws nothing itself: the card is the one question card
 * (components/decision/QuestionCardHost.tsx), the same one Work, One and a room draw. Picking a choice sends it as the owner's next
 * message through the window's own send path (the supervisor outbox), the same as typing it. X closes the card and leaves a Reopen line.
 */
export function PersonalOneAskCard({ ask, chatId, locale, disabled, onAnswer }: {
  ask: PersonalOnePendingAsk;
  /** The personal conversation that asked; null while the window has none yet (the close then lives in this component only). */
  chatId: string | null;
  locale: "ko" | "en";
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  const cardKey = `personal-ask:${ask.sourceMessageId}`;
  const closedCards = useClosedQuestionCards(chatId);
  const [closedLocally, setClosedLocally] = useState(false);
  const closed = chatId ? closedCards.some((item) => item.key === cardKey) : closedLocally;
  const reopen = () => { if (chatId) reopenQuestionCard(chatId, cardKey); else setClosedLocally(false); };
  if (closed) return <ClosedQuestionLine count={1} onReopen={reopen} />;
  return (
    <QuestionCardHost
      source="personal-ask"
      chatId={chatId}
      replyStyle="plain"
      locked={disabled}
      questions={[{
        id: ask.sourceMessageId,
        question: ask.question,
        ...(ask.header ? { header: ask.header } : {}),
        multiSelect: ask.multiSelect,
        options: ask.options,
      }]}
      onConfirm={(reply) => { if (reply.trim() && !disabled) onAnswer(reply); }}
      onDismiss={() => { if (chatId) closeQuestionCard(chatId, cardKey, 1); else setClosedLocally(true); }}
    />
  );
}
