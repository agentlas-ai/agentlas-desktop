"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatHostNotice } from "@shared/types";
import { stripAgentControlBlocks } from "@shared/agent-control-blocks";
import { flattenAskFences } from "@shared/ask-fence-flatten";
import { withoutCutLink } from "@shared/report-text-cut";
import { ipc, ipcEvents } from "@/lib/ipc";
import { ipcErrorCode } from "@shared/ipc-error-code";
import { createDirtyGate } from "@/lib/store-change-policy";
import { readOneChatHistory } from "@/lib/one-chat-history";
import { markChatVisible } from "@/lib/tool-approvals";
import { Markdown, type LinkedFileArtifact } from "../Markdown";
import { OneAgentPortrait } from "./OneAgentPortrait";
import { ToolApprovalInline } from "../ToolApprovalInline";
import { BrowserActionApprovalSheet } from "../BrowserActionApprovalSheet";
import { ChatQuestionSheet } from "../ChatQuestionSheet";

type Notice = Extract<ChatHostNotice, { purpose: "one-dispatch-link" | "one-dispatch-result" }>;
type ReportPage = { key: string; messageId: string; text: string; nextOffset: number | null };
type ReportReply = { available: false } | { available: true; messageId: string; text: string; nextOffset: number | null };

/** Displays the member's observed work on an existing room receipt, without creating messages. */
export function OneDispatchNotice({ notice, locale, onOpenChat, onOpenLinkedFile }: { notice: Notice; locale: "ko" | "en"; onOpenLinkedFile?: (file: LinkedFileArtifact) => void;
  /** Opens the teammate's own session (read-only when the personal agent opened it). Absent: no link is drawn. */
  onOpenChat?: (chatId: string) => void }) {
  const [current, setCurrent] = useState(notice);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answeredSource, setAnsweredSource] = useState<string | null>(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopNote, setStopNote] = useState<"saved" | "failed" | null>(null);
  const [report, setReport] = useState<ReportPage | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState(false);
  useEffect(() => setCurrent(notice), [notice]);
  const dispatch = current.dispatch;
  const reportKey = JSON.stringify([dispatch?.dispatchId, dispatch?.parentChatId, current.chatId, current.runId]);
  const reportKeyRef = useRef(reportKey);
  reportKeyRef.current = reportKey;
  const reportMounted = useRef(true);
  const reportRequest = useRef<string | null>(null);
  useEffect(() => { reportMounted.current = true; return () => { reportMounted.current = false; }; }, []);
  useEffect(() => { setReport(null); setReportBusy(false); setReportError(false); }, [reportKey]);
  const currentReport = report?.key === reportKey ? report : null;
  // The teammate wrote its report from its own folder: `./clip/preview.gif` means that folder, not this conversation's.
  const [memberFolders, setMemberFolders] = useState<string[]>([]);
  useEffect(() => {
    const api = ipc();
    let live = true;
    void Promise.all([api?.workspace?.get?.(current.chatId), api?.workspace?.defaultRunFolder?.()])
      .then(([saved, runFolder]) => {
        const folder = saved || runFolder;
        if (live && folder) setMemberFolders([folder]);
      }).catch(() => { /* A relative picture then shows as missing; the rest of the report still reads. */ });
    return () => { live = false; };
  }, [current.chatId]);
  useEffect(() => {
    if (dispatch && current.purpose === "one-dispatch-link" && ["running", "waiting_input"].includes(dispatch.status)) {
      // Existing question/approval sheets answer the original child request in this room's composer.
      return markChatVisible(current.chatId);
    }
  }, [current.chatId, current.purpose, dispatch?.dispatchId, dispatch?.status]);
  useEffect(() => {
    if (!dispatch || !["running", "waiting_input"].includes(dispatch.status)) return;
    const api = ipc();
    if (!api?.invoke?.history) return;
    let cancelled = false;
    let busy = false;
    // The notice is projected from the parent chat (its link/result rows) and the member's own chat (its question).
    // Re-read the parent history (up to about 1 MB) only after a change to either, or every 15 s as a safety net for
    // a status write that announces nothing (perf review R-09).
    const childChatId = current.chatId;
    const gate = createDirtyGate({ maxAgeMs: 15_000 });
    const stopWatching = ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "chat" && (!change.id || change.id === dispatch.parentChatId || change.id === childChatId)) gate.mark();
    });
    const timer = setInterval(async () => {
      if (busy || document.visibilityState === "hidden" || !gate.shouldRead()) return;
      busy = true;
      try {
        const history = await readOneChatHistory(api, dispatch.parentChatId);
        const updated = history.find(row => row.hostNotice?.purpose === current.purpose
          && "dispatch" in row.hostNotice && row.hostNotice.dispatch?.dispatchId === dispatch.dispatchId
          && "runId" in row.hostNotice && row.hostNotice.runId === current.runId)?.hostNotice;
        if (!cancelled && updated) setCurrent(updated as Notice);
      } catch { /* A failed read does not change the observed execution state. */ }
      finally { busy = false; }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); stopWatching?.(); };
  }, [dispatch?.dispatchId, dispatch?.parentChatId, dispatch?.status, current.purpose, current.runId, current.chatId]);
  const ko = locale === "ko";
  /*
   * Stop: a job handed to a teammate could not be stopped from where it was handed over. The session opens read-only
   * for the owner when the personal agent started it, and its composer, where Stop lives, is replaced by a notice. This is the owner's
   * own Stop of the run (invoke.cancel): Main finds the teammate job by its run, closes it as stopped and reports nothing about it. It
   * stays while the job runs or waits for an answer, in the personal agent's room and in group rooms alike, and needs no open session.
   */
  const stopRun = async () => {
    const api = ipc();
    if (stopBusy || !api?.invoke?.cancel || !dispatch || current.purpose !== "one-dispatch-link") return;
    setStopBusy(true); setStopNote(null);
    let refused: "saved" | "failed" | null = null;
    try {
      await api.invoke.cancel(current.runId);
    } catch (error) {
      // The service holding the run did not answer: Main kept the stop and asks again by itself, so this is not the job's failure.
      refused = ipcErrorCode(error) === "invocation_owner_unavailable" ? "saved" : "failed";
    }
    try {
      const history = await readOneChatHistory(api, dispatch.parentChatId);
      const updated = history.find(row => row.hostNotice?.purpose === current.purpose
        && "dispatch" in row.hostNotice && row.hostNotice.dispatch?.dispatchId === dispatch.dispatchId
        && "runId" in row.hostNotice && row.hostNotice.runId === current.runId)?.hostNotice;
      if (updated) setCurrent(updated as Notice);
      // A Stop pressed as the job ended is answered with the job's end, not with a note about the Stop.
      const updatedStatus = updated && "dispatch" in updated ? updated.dispatch?.status : undefined;
      if (updatedStatus && updatedStatus !== "running" && updatedStatus !== "waiting_input") refused = null;
    } catch { /* the next store change re-reads it */ }
    setStopNote(refused);
    setStopBusy(false);
  };
  const labels = {
    running: ko ? "작업 중" : "Working", waiting_input: ko ? "응답 대기" : "Waiting for input",
    completed: ko ? "완료" : "Completed", failed: ko ? "실패" : "Failed",
    cancelled: ko ? "취소됨" : "Cancelled", interrupted: ko ? "중단됨" : "Interrupted",
  };
  const status = dispatch?.status;
  const question = dispatch?.pendingQuestion;
  const loadReportPage = async () => {
    const api = ipc();
    const oneOrg = api?.oneOrg as (NonNullable<ReturnType<typeof ipc>>["oneOrg"] & {
      readDispatchResult?: (input: unknown) => Promise<ReportReply>;
    }) | undefined;
    if (!dispatch || reportBusy || reportRequest.current === reportKey || currentReport?.nextOffset === null || !oneOrg?.readDispatchResult) return;
    const offset = currentReport?.nextOffset ?? 0;
    const key = reportKey;
    reportRequest.current = key;
    setReportBusy(true); setReportError(false);
    try {
      const page = await oneOrg.readDispatchResult({ parentChatId: dispatch.parentChatId,
        dispatchId: dispatch.dispatchId, chatId: current.chatId, runId: current.runId, offset,
        ...(currentReport ? { messageId: currentReport.messageId } : {}) });
      if (!reportMounted.current || reportKeyRef.current !== key) return;
      if (!page?.available || typeof page.text !== "string" || typeof page.messageId !== "string"
        || (currentReport && page.messageId !== currentReport.messageId)
        || (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))) {
        throw new Error("report-page-unavailable");
      }
      setReport({ key, messageId: page.messageId, text: (currentReport?.text ?? "") + page.text, nextOffset: page.nextOffset });
    } catch {
      if (reportMounted.current && reportKeyRef.current === key) setReportError(true);
    } finally {
      if (reportRequest.current === key) reportRequest.current = null;
      if (reportMounted.current && reportKeyRef.current === key) setReportBusy(false);
    }
  };
  const answer = async (reply: string) => {
    const api = ipc();
    if (!dispatch || !question || answerBusy || !api?.confirm?.answerDelegatedQuestion) return;
    setAnswerBusy(true); setAnswerError(null);
    try {
      const receipt = await api.confirm.answerDelegatedQuestion({ parentChatId:dispatch.parentChatId,dispatchId:dispatch.dispatchId,
        chatId:current.chatId,runId:current.runId,sourceMessageId:question.sourceMessageId,locale,
        ...(question.continuationRunId ? {retryCommitted:true} : {reply}) });
      if (receipt.chatId !== current.chatId || receipt.sourceMessageId !== question.sourceMessageId || receipt.status === "rejected") throw new Error("question-not-started");
      setAnsweredSource(question.sourceMessageId);
    } catch {
      setAnswerError(ko ? "답변 전달을 확인하지 못했습니다. 입력을 유지했어요. 다시 확인해 주세요." : "The answer was not confirmed. Your input is retained; please retry.");
    } finally { setAnswerBusy(false); }
  };
  return <article data-host-notice={current.purpose} data-one-dispatch-chat={current.chatId}
    data-speaker-agent-id={dispatch?.memberAgentId}
    style={{ alignSelf: "stretch", width: "100%", maxWidth: 760, minWidth: 0, margin: "10px 0", overflowWrap: "anywhere" }}>
    <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted-deep)", marginBottom: 6 }}>
      {dispatch && <OneAgentPortrait size="small" tone={dispatch.memberIcon || undefined} label={current.memberName}
        status={status === "running" ? "working" : status === "waiting_input" ? "waiting" : status === "failed" ? "failed" : "quiet"} />}
      <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{current.memberName}</strong>
      <span>{status ? labels[status] : current.purpose === "one-dispatch-result" ? (ko ? "결과 도착" : "Result received") : (ko ? "작업 전달됨" : "Work delegated")}</span>
      {onOpenChat && <button type="button" data-one-dispatch-open={current.chatId} onClick={() => onOpenChat(current.chatId)}
        style={{ marginLeft: "auto", border: 0, background: "transparent", padding: 0, color: "var(--accent)", font: "inherit", fontSize: 12, cursor: "pointer", flexShrink: 0 }}>
        {ko ? "세션 열기" : "Open session"}
      </button>}
      {dispatch && current.purpose === "one-dispatch-link" && (status === "running" || status === "waiting_input") && <button type="button" data-one-dispatch-stop={current.chatId}
        disabled={stopBusy} onClick={() => { void stopRun(); }} aria-label={ko ? `${current.memberName} 작업 중지` : `Stop ${current.memberName}'s job`}
        style={{ marginLeft: onOpenChat ? 0 : "auto", border: 0, background: "transparent", padding: 0, color: "var(--muted-deep)", font: "inherit", fontSize: 12, cursor: stopBusy ? "default" : "pointer", flexShrink: 0, opacity: stopBusy ? .6 : 1 }}>
        {stopBusy ? (ko ? "중지하는 중…" : "Stopping…") : (ko ? "중지" : "Stop")}
      </button>}
    </div>
    {stopNote && <p role="status" data-one-dispatch-stop-note={stopNote} style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 6px" }}>
      {stopNote === "saved"
        ? (ko ? "중지 요청을 저장했어요. 작업을 맡은 서비스가 응답하면 바로 멈춰요." : "The stop is saved. It takes effect as soon as the service running the job answers.")
        : (ko ? "중지하지 못했어요. 다시 눌러 주세요." : "Could not stop it. Press Stop again.")}
    </p>}
    {!!dispatch?.activity?.length && <details open={status === "running" || status === "waiting_input"} style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 8 }}>
      <summary>{ko ? "진행 기록" : "Work activity"}</summary>
      {dispatch.activity.map(item => <div key={item.id} style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
        <span style={{ opacity: .65 }}>{item.kind === "tool" ? (ko ? "도구 · " : "Tool · ") : ""}</span>{item.text}
      </div>)}
    </details>}
    {dispatch?.resultText && <>
      <Markdown text={withoutCutLink(stripAgentControlBlocks(flattenAskFences(currentReport?.text ?? dispatch.resultText, locale)))} messageId={`one-dispatch-result:${dispatch.dispatchId}:${current.runId}`} mediaBasePaths={memberFolders} onOpenLinkedFile={onOpenLinkedFile} />
      {currentReport?.nextOffset !== null && <button type="button" disabled={reportBusy} onClick={() => { void loadReportPage(); }}
        style={{ border: 0, background: "transparent", padding: "6px 0", color: "var(--accent)", font: "inherit", fontSize: 12, cursor: "pointer" }}>
        {reportBusy ? (ko ? "보고서를 불러오는 중…" : "Loading report…")
          : currentReport ? (ko ? "다음 부분 보기" : "Show next part") : (ko ? "전체 보고 보기" : "Show full report")}
      </button>}
      {reportError && <p role="status" style={{ fontSize: 12, color: "var(--muted-deep)" }}>
        {ko ? "이 보고서의 원문을 불러오지 못했습니다. 팀원 세션에서 확인할 수 있어요." : "The full report could not be loaded. You can check the teammate's session."}
      </p>}
    </>}
    {question && answeredSource !== question.sourceMessageId && <ChatQuestionSheet
      questions={(question.questionBank?.questions ?? question.questions).map((item,index) => ({...item,id:`${question.sourceMessageId}-q${index}`}))}
      initialReply={question.committedReply}
      onRetryCommitted={question.committedReply ? () => { void answer(question.committedReply!); } : undefined}
      busy={answerBusy} onConfirm={(reply) => { void answer(reply); }} onDismiss={() => setAnsweredSource(question.sourceMessageId)} />}
    {answerError && <p role="alert" style={{fontSize:12,color:"var(--muted-deep)"}}>{answerError}</p>}
    {dispatch && current.purpose === "one-dispatch-link" && (status === "running" || status === "waiting_input") && <>
      <ToolApprovalInline chatId={current.chatId} compact />
      <BrowserActionApprovalSheet chatId={current.chatId} />
    </>}
  </article>;
}
