"use client";

import { IconClose, IconTarget } from "@/components/Icon";
import type { ChatGoalContext } from "@shared/types";

export function GoalFeedbackBar({
  context,
  armed,
  locale,
  onEndGoal,
  className,
}: {
  context: ChatGoalContext | null;
  armed: boolean;
  locale: "ko" | "en";
  onEndGoal: () => void;
  className?: string;
}) {
  if (!armed) return null;
  const objective = context?.objective?.replace(/\s+/g, " ").trim() || (locale === "ko"
    ? "다음 요청 한 번으로 목표와 성공 기준을 확정합니다"
    : "Your next request will define the goal and its acceptance criteria");
  const criteria = context?.acceptanceCriteria ?? [];
  return (
    <div
      className={["agentlas-goal-feedback", className].filter(Boolean).join(" ")}
      role="status"
      aria-live="polite"
      data-agentlas-goal-feedback="true"
      data-chat-goal-bar="true"
      data-goal-defined={context?.objective ? "true" : "false"}
    >
      <span className="agentlas-goal-feedback__icon" aria-hidden><IconTarget size={13} /></span>
      <strong>{locale === "ko" ? "목표" : "Goal"}</strong>
      <span className="agentlas-goal-feedback__objective" title={objective}>{objective}</span>
      {criteria.length > 0 && (
        <details className="agentlas-goal-feedback__criteria">
          <summary>{locale === "ko" ? `성공 기준 ${criteria.length}개` : `${criteria.length} acceptance criteria`}</summary>
          <ol>{criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ol>
        </details>
      )}
      <button
        type="button"
        onClick={onEndGoal}
        aria-label={locale === "ko" ? "목표 종료" : "End goal"}
        title={locale === "ko" ? "목표 종료" : "End goal"}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}
