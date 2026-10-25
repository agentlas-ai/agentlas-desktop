"use client";
import { useState } from "react";
import { AskCard } from "@/components/AskCard";
import { ASK_ACTION_COPY, composeAskAnswer } from "../../../shared/ask-action-bar";
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
  const [typed, setTyped] = useState("");
  const copy = ASK_ACTION_COPY[locale];
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
      otherOption={{ title: copy.other, note: copy.otherNote }}
      freeText={typed}
      onFreeTextChange={setTyped}
      statusLabel={copy.needsInput}
      footer={{
        placeholder: ko ? "직접 입력" : "Type your own answer",
        skipLabel: ko ? "닫기" : "Close",
        submitLabel: ko ? "보내기" : "Send",
        hasSelection: picked.length > 0,
        // 단추는 아래 동작 줄([건너뛰기][제출 ⌘↵])이 맡는다. 입력칸의 Enter 는 예전처럼 보내거나(답이 있으면) 닫는다.
        hideButton: true,
        onSkip: (typed) => {
          const labels = picked.map((index) => ask.options[index].label);
          if (labels.length || typed.trim()) send(labels, typed);
          else onDismiss();
        },
      }}
      actionRow={{
        secondary: { id: "skip", label: copy.skip },
        primary: {
          id: "submit",
          label: ask.multiSelect ? copy.submit(picked.length + (typed.trim() ? 1 : 0)) : copy.submitSingle,
          disabled: disabled || (picked.length === 0 && !typed.trim()),
        },
        onAction: (id, text) => {
          if (id === "skip") { onDismiss(); return; }
          send(picked.map((index) => ask.options[index].label), text);
        },
      }}
    />
  );
}
