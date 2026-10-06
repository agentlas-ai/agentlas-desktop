"use client";
import type { ChatHostNotice } from "../../shared/types";
import { Markdown } from "./Markdown";
import { OneDispatchNotice } from "./one/OneDispatchNotice";
import { automationReportDisplay } from "../lib/automation-report-display";
import { agiActionNoticeLine, hostStatusLabel } from "../../shared/chat-host-notice";

/** Historical host request, not a projection of the invocation's current state.
 * Keep the original text in the message ledger; internal resume instructions
 * and verifier payloads are not user-facing task instructions.
 */
export function HostContinuationNotice({ text, locale, notice }: { text: string; locale: "ko" | "en"; notice?: ChatHostNotice; onOpenChat?: (chatId: string) => void }) {
  if (notice?.purpose === "one-dispatch-brief") {
    // 팀원 세션 첫머리: One 이 맡긴 일. 사람(오너)이 쓴 말처럼 보이면 안 된다.
    return <article
      data-host-notice="one-dispatch-brief"
      data-run-id={notice.runId}
      style={{ alignSelf: "stretch", width: "100%", maxWidth: 760, minWidth: 0, margin: "12px 0", padding: "10px 12px", borderRadius: 10, background: "var(--paper-2)", overflowWrap: "anywhere" }}
    >
      <p style={{ color: "var(--muted-deep)", fontSize: 12, marginBottom: 6 }}>{locale === "ko" ? "One 이 맡긴 일" : "Handed over by One"}</p>
      <Markdown text={text} messageId={`one-dispatch-brief:${notice.runId}`} />
    </article>;
  }
  if (notice?.purpose === "one-dispatch-link" || notice?.purpose === "one-dispatch-result") {
    return <OneDispatchNotice notice={notice} locale={locale} />;
  }
  if (notice?.purpose === "one-team-member-joined") {
    // One 이 팀원을 만들거나 단톡방에 초대한 영수증 — 글은 Main 이 쓴 기록이 아니라 표식으로 다시 그린다.
    const label = locale === "ko"
      ? `${notice.created ? "새 팀원을 만들어 초대함" : "팀원 초대함"} · ${notice.memberName}`
      : `${notice.created ? "New teammate created and invited" : "Teammate invited"} · ${notice.memberName}`;
    return <p
      data-host-notice="one-team-member-joined"
      role="status"
      style={{ alignSelf: "stretch", maxWidth: 760, margin: "6px 0", color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.5 }}
    >{label}</p>;
  }
  if (notice?.purpose === "update-resume") {
    // The app continued a turn the update restart interrupted. The ledger keeps the internal
    // continuation instructions; the person sees one line.
    return <p
      data-host-notice="update-resume"
      data-run-id={notice.runId}
      role="status"
      style={{ alignSelf: "stretch", maxWidth: 760, margin: "4px 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}
    >{locale === "ko" ? "업데이트 후 이어서 진행합니다" : "Continuing after the update"}</p>;
  }
  if (notice?.purpose === "one-delegation-review") {
    // One woke because work it handed off finished. The ledger keeps the host's review request; the person sees one line.
    return <p
      data-host-notice="one-delegation-review"
      data-run-id={notice.runId}
      role="status"
      style={{ alignSelf: "stretch", maxWidth: 760, margin: "4px 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5 }}
    >{locale === "ko" ? "맡긴 일이 끝나 결과를 확인합니다" : "Checking the work that finished"}</p>;
  }
  if (notice?.purpose === "host-status") {
    // The host's own status line (effect check, wait, cycle). Where One cannot fold it into its turn's
    // work block it is still one quiet line: the short status, then the sentence as written.
    return <p
      data-host-notice="host-status"
      data-host-status={notice.status}
      data-run-id={notice.runId}
      role="status"
      style={{ alignSelf: "stretch", maxWidth: 760, margin: "4px 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5, overflowWrap: "anywhere" }}
    ><strong style={{ fontWeight: 600 }}>{hostStatusLabel(notice, locale)}</strong> · {text}</p>;
  }
  const agiLine = agiActionNoticeLine(notice, text);
  if (agiLine) {
    // AGI's own action: one quiet host-status line, never a "예약 보고" card with a bare "AGI" name line.
    return <p
      data-host-notice="agi-action"
      data-run-id={notice?.purpose === "automation-report" ? notice.runId : undefined}
      role="status"
      style={{ alignSelf: "stretch", maxWidth: 760, margin: "4px 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5, overflowWrap: "anywhere" }}
    ><strong style={{ fontWeight: 600 }}>AGI</strong> · {agiLine}</p>;
  }
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
