"use client";

import { useState } from "react";

/** Historical host request, not a projection of the invocation's current state.
 * Keep the original text in the message ledger; internal resume instructions
 * and verifier payloads are not user-facing task instructions.
 */
export function HostContinuationNotice({ locale }: { text: string; locale: "ko" | "en" }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details data-host-notice="goal-continuation" onToggle={(event) => setExpanded(event.currentTarget.open)}
      style={{ alignSelf: "stretch", maxWidth: 760, color: "var(--muted-deep)", fontSize: 12.5, lineHeight: 1.55 }}>
      <summary style={{ cursor: "pointer", padding: "4px 0" }}>
        {locale === "ko" ? "자동 이어가기 요청 기록" : "Automatic continuation request"}
      </summary>
      {expanded && <p style={{ margin: "6px 0", padding: "0 0 4px", overflowWrap: "anywhere" }}>
        {locale === "ko"
          ? "저장된 목표와 진행 기록을 바탕으로 작업을 이어가도록 요청했습니다. 이 기록은 현재 실행 중인지, 이후 중지되거나 완료됐는지를 나타내지 않습니다."
          : "A continuation was requested using the saved goal and progress. This historical record does not indicate whether the work is still running, was stopped, or has finished."}
      </p>}
    </details>
  );
}
