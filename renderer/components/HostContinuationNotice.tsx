"use client";
import type { ChatHostNotice } from "../../shared/types";
import { Markdown } from "./Markdown";
import { automationReportDisplay } from "../lib/automation-report-display";

/** Historical host request, not a projection of the invocation's current state.
 * Keep the original text in the message ledger; internal resume instructions
 * and verifier payloads are not user-facing task instructions.
 */
export function HostContinuationNotice({ text, locale, notice }: { text: string; locale: "ko" | "en"; notice?: ChatHostNotice }) {
  if (notice?.purpose === "automation-report") {
    // 기록 원문은 기계 표식을 일부러 남긴다 — 그릴 때만 사람 첫머리로 바꾸고 코드는 칩으로.
    const display = automationReportDisplay(text, locale);
    return <article
    data-host-notice="automation-report"
    data-automation-id={notice.automationId}
    data-automation-run-id={notice.runId}
    style={{ alignSelf: "stretch", width: "100%", maxWidth: 760, minWidth: 0, margin: "12px 0", overflowWrap: "anywhere" }}
  >
    <p style={{ color: "var(--muted-deep)", fontSize: 12, marginBottom: 8 }}>{locale === "ko" ? "예약 보고" : "Scheduled report"}</p>
    <Markdown text={display.name ? `${display.name}\n\n${display.body}` : display.body} messageId={`automation-report:${notice.automationId}:${notice.runId}`} />
    {display.code && <code
      data-machine-code={display.code}
      title={locale === "ko" ? "사유 코드" : "Reason code"}
      style={{ display: "inline-block", maxWidth: "100%", marginTop: 4, padding: "1px 6px", borderRadius: 5, background: "var(--paper-3)", color: "var(--muted-deep)", fontSize: 10.5, lineHeight: 1.6, overflowWrap: "anywhere" }}
    >{display.code}</code>}
  </article>;
  }
  return <p
    data-host-notice="goal-continuation"
    role="status"
    style={{ alignSelf: "stretch", maxWidth: 760, margin: "4px 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}
  >{locale === "ko" ? "자동 이어가기 요청" : "Automatic continuation requested"}</p>;
}
