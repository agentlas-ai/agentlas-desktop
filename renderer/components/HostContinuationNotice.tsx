"use client";
import type { ChatHostNotice } from "../../shared/types";
import { Markdown, type LinkedFileArtifact } from "./Markdown";
import { OneDispatchNotice } from "./one/OneDispatchNotice";
import { automationReportDisplay } from "../lib/automation-report-display";
import { useState } from "react";
import { ipc } from "@/lib/ipc";
import { IconRefresh } from "@/components/Icon";
import { agiActionNoticeLine, hostStatusLabel, isHousekeepingHostNotice } from "../../shared/chat-host-notice";

/** Historical host request, not a projection of the invocation's current state.
 * Keep the original text in the message ledger; internal resume instructions
 * and verifier payloads are not user-facing task instructions.
 */
export function HostContinuationNotice({ text, locale, notice, onOpenChat, chatId, onOpenLinkedFile }: { text: string; locale: "ko" | "en"; notice?: ChatHostNotice; onOpenChat?: (chatId: string) => void; chatId?: string | null; onOpenLinkedFile?: (file: LinkedFileArtifact) => void }) {
  // Reports may come from a different chat. Only web URLs can be opened in the
  // displaying chat; local files must retain their originating authorization.
  const openNoticeLink = (file: LinkedFileArtifact) => {
    if (!/^https?:\/\//iu.test(file.href) || !chatId) return;
    if (onOpenLinkedFile) onOpenLinkedFile(file);
    else window.dispatchEvent(new CustomEvent("agentlas:in-app-linked-file", { detail: { ...file, chatId } }));
  };
  // Housekeeping (the host checking, continuing, waiting, resuming; One waking to review handed-off work) is not drawn.
  if (isHousekeepingHostNotice(notice)) return null;
  if (notice?.purpose === "one-dispatch-brief") {
    // 팀원 세션 첫머리: One 이 맡긴 일. 사람(오너)이 쓴 말처럼 보이면 안 된다.
    return <article
      data-host-notice="one-dispatch-brief"
      data-run-id={notice.runId}
      style={{ alignSelf: "stretch", width: "100%", maxWidth: 760, minWidth: 0, margin: "12px 0", padding: "10px 12px", borderRadius: 10, background: "var(--paper-2)", overflowWrap: "anywhere" }}
    >
      <p style={{ color: "var(--muted-deep)", fontSize: 12, marginBottom: 6 }}>{locale === "ko" ? "One 이 맡긴 일" : "Handed over by One"}</p>
      <Markdown text={text} messageId={`one-dispatch-brief:${notice.runId}`} onOpenLinkedFile={openNoticeLink} />
    </article>;
  }
  if (notice?.purpose === "one-dispatch-link" || notice?.purpose === "one-dispatch-result") {
    return <OneDispatchNotice notice={notice} locale={locale} onOpenChat={onOpenChat} onOpenLinkedFile={openNoticeLink} />;
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
  if (notice?.purpose === "host-status" && notice.status === "startup-resumed") return <StartupResumedLine locale={locale} chatId={chatId ?? null} runId={notice.runId} />;
  if (notice?.purpose === "host-status") {
    // A host status that is not housekeeping (needs-owner, goal-closed, runtime-kept): the short status, then the
    // sentence as written.
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
    <Markdown text={display.name ? `${display.name}\n\n${display.body}` : display.body} messageId={`automation-report:${notice.automationId}:${notice.runId}`} onOpenLinkedFile={openNoticeLink} />
    {/* The owner reads the sentence; the machine code stays only as a hidden marker for diagnostics, never as visible text. */}
    {display.code && <span hidden data-machine-code={display.code} />}
  </article>;
  }
  // goal-continuation and any other host-written continuation request: internal, not rendered.
  return null;
}

/** "App restarted · continuing" + the conversation's one Stop (api.chat.stop); the stored sentence is for the phone. */
function StartupResumedLine({ locale, chatId, runId }: { locale: "ko" | "en"; chatId: string | null; runId: string }) {
  const [state, setState] = useState<"idle" | "stopping" | "stopped" | "failed">("idle");
  const stop = () => {
    const api = ipc();
    if (!chatId || !api?.chat?.stop || state === "stopping") return;
    setState("stopping");
    void api.chat.stop(chatId).then(() => setState("stopped")).catch(() => setState("failed"));
  };
  const ko = locale === "ko";
  return <p
    data-host-notice="host-status"
    data-host-status="startup-resumed"
    data-run-id={runId}
    role="status"
    style={{ alignSelf: "stretch", maxWidth: 760, margin: "4px 0", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.5, overflowWrap: "anywhere" }}
  >
    <IconRefresh size={12} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} /><strong style={{ fontWeight: 600 }}>{ko ? "앱 다시 켜짐" : "App restarted"}</strong> · {ko ? "이어서 해요" : "continuing"}
    {chatId && state !== "stopped" && <> · <button type="button" data-startup-resumed-stop="true" disabled={state === "stopping"} onClick={stop}
      style={{ all: "unset", cursor: "pointer", textDecoration: "underline", color: "inherit" }}>{state === "failed" ? (ko ? "멈추지 못했어요 · 다시" : "Could not stop · retry") : (ko ? "멈추기" : "Stop")}</button></>}
    {state === "stopped" && <> · {ko ? "멈췄어요" : "Stopped"}</>}
  </p>;
}
