"use client";
import { useState } from "react";
import { AskCard } from "@/components/AskCard";
import { composeAskAnswer } from "../../../shared/ask-action-bar";
import type { PersonalOnePendingAsk } from "@/lib/personal-one-transcript";

/**
 * The personal window's card for a question Hope ended its answer on. Picking a choice sends it as the
 * owner's next message through the window's own send path (the supervisor outbox), the same as typing it.
 */
export function PersonalOneAskCard({ ask, locale, disabled, onAnswer, onDismiss }: {
  ask: PersonalOnePendingAsk;
  locale: "ko" | "en";
  disabled: boolean;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const ko = locale === "ko";
  const [picked, setPicked] = useState<number[]>([]);
  const send = (labels: string[], typed: string) => {
    const answer = composeAskAnswer(labels, typed);
    if (answer && !disabled) onAnswer(answer);
  };
  return (
    <AskCard
      data-testid="personal-one-ask"
      locale={locale}
      title={ask.header || ask.question}
      subtitle={ask.header ? ask.question : undefined}
      options={ask.options.map((option, index) => ({
        id: `pick:${index}`,
        title: option.label,
        ...(option.description ? { note: option.description } : {}),
        ...(ask.multiSelect ? { checked: picked.includes(index) } : {}),
        disabled,
      }))}
      onChoose={(id, typed) => {
        const index = Number(id.slice("pick:".length));
        if (!Number.isInteger(index) || !ask.options[index] || disabled) return;
        if (ask.multiSelect) {
          setPicked((current) => current.includes(index) ? current.filter((value) => value !== index) : [...current, index]);
          return;
        }
        send([ask.options[index].label], typed);
      }}
      onClose={onDismiss}
      collapsible
      footer={{
        placeholder: ko ? "직접 입력" : "Type your own answer",
        skipLabel: ko ? "닫기" : "Close",
        submitLabel: ko ? "보내기" : "Send",
        hasSelection: picked.length > 0,
        onSkip: (typed) => {
          const labels = picked.map((index) => ask.options[index].label);
          if (labels.length || typed.trim()) send(labels, typed);
          else onDismiss();
        },
      }}
    />
  );
}
