"use client";

import { useState } from "react";

/** A display-only host notice; the original public continuation text stays inspectable. */
export function HostContinuationNotice({ text, locale }: { text: string; locale: "ko" | "en" }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details data-host-notice="goal-continuation" onToggle={(event) => setExpanded(event.currentTarget.open)}
      style={{ alignSelf: "stretch", maxWidth: 760, color: "var(--muted-deep)", fontSize: 12.5, lineHeight: 1.55 }}>
      <summary style={{ cursor: "pointer", padding: "4px 0" }}>
        {locale === "ko" ? "남은 작업을 자동으로 이어갑니다" : "Continuing the remaining work automatically."}
      </summary>
      {expanded && <pre style={{ margin: "6px 0", padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 8,
        background: "var(--paper-2)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>{text}</pre>}
    </details>
  );
}
