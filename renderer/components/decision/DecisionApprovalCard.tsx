"use client";
// The approve / always / reject card of a One decision that has nothing to choose between (a question with choices is the QuestionCardHost's).
// Registered with the approval card of the feature registry: it draws through the shared AskCard, carries the marks the screen test reads, and holds
// no decision logic - the surface passes what each answer means.
import { AskCard, type AskCardOption } from "@/components/AskCard";
import { tFor } from "@/lib/i18n";

export function DecisionApprovalCard({ locale, title, riskRank, approveNote, approvalReply, disabled, rejectLabel, rejectReply, alwaysAllowed, onAnswer, onAlways, onClose }: {
  locale: "ko" | "en";
  title: string;
  /** 0 is a lightweight choice; from 2 the approve row carries the full "approve" wording. */
  riskRank: number;
  approveNote?: string | null;
  /** The reply the approve row sends (null: nothing can be approved yet, so the approve rows are off). */
  approvalReply: string | null;
  disabled: boolean;
  rejectLabel: string;
  rejectReply: string;
  /** "Always approve" answers this card too, so it is offered only for a yes/no permission (never for a question whose other option is a real alternative). */
  alwaysAllowed: boolean;
  onAnswer: (reply: string, shouldStart?: boolean) => void;
  onAlways: () => void;
  onClose?: () => void;
}) {
  const options: AskCardOption[] = [
    {
      id: "approve",
      title: riskRank >= 2 ? tFor(locale, "one.shell.decision.approve") : (locale === "ko" ? "승인" : "Approve"),
      note: approveNote ?? undefined,
      disabled: disabled || approvalReply === null,
      active: true,
    },
    ...(alwaysAllowed ? [{
      id: "always",
      title: tFor(locale, "one.shell.decision.always_approve"),
      note: tFor(locale, "one.shell.decision.always_approve_hint"),
      disabled: disabled || approvalReply === null,
    }] : []),
    { id: "reject", title: rejectLabel, disabled },
  ];
  const choose = (id: string) => {
    if (id === "reject") { onAnswer(rejectReply, false); return; }
    if (id === "always") {
      if (approvalReply === null) return;
      onAlways();
      onAnswer(approvalReply);
      return;
    }
    if (id === "approve" && approvalReply !== null) onAnswer(approvalReply);
  };
  return (
    <div data-feature="approval-card" data-impl="decision-approval-card">
      <AskCard title={title} locale={locale} onClose={onClose} options={options} onChoose={choose} data-testid="one-decision-ask-card" />
    </div>
  );
}
