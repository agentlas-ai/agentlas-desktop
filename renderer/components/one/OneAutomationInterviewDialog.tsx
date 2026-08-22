"use client";

import { DescribeAutomation } from "@/components/automation/DescribeAutomation";
import { OneBottomSheet } from "./OneBottomSheet";

/**
 * Graph automation creation stays inside One as a short conversation. The
 * existing DescribeAutomation contract owns clarification, graph generation,
 * pre-save verification, and recovery; the node canvas is opt-in only.
 */
export function OneAutomationInterviewDialog({
  open,
  locale,
  onClose,
  onOpenAutomation,
}: {
  open: boolean;
  locale: "ko" | "en";
  onClose: () => void;
  onOpenAutomation: (automationId: string) => void;
}) {
  return (
    <OneBottomSheet
      open={open}
      onClose={onClose}
      closeLabel={locale === "ko" ? "자동화 인터뷰 닫기" : "Close automation interview"}
      size="wide"
      eyebrow="One"
      title={locale === "ko" ? "자동화 만들기" : "Create automation"}
      titleId="one-automation-interview-title"
      ariaLabelledBy="one-automation-interview-title"
      description={locale === "ko"
        ? "할 일을 말하면 꼭 필요한 것만 되묻고, 실제 그래프 초안을 꺼진 상태로 저장합니다."
        : "Describe the job. One asks only what it must, then saves a real graph draft switched off."}
    >
      <DescribeAutomation
        locale={locale}
        openAfterCreate={false}
        onCreated={() => undefined}
        onOpenAutomation={onOpenAutomation}
      />
    </OneBottomSheet>
  );
}
