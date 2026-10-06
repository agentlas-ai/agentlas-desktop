"use client";

import { useEffect, useState } from "react";
import type { ChatHostNotice } from "@shared/types";
import { stripAgentControlBlocks } from "@shared/agent-control-blocks";
import { flattenAskFences } from "@shared/ask-fence-flatten";
import { ipc } from "@/lib/ipc";
import { markChatVisible } from "@/lib/tool-approvals";
import { Markdown } from "../Markdown";
import { OneAgentPortrait } from "./OneAgentPortrait";
import { ToolApprovalInline } from "../ToolApprovalInline";
import { BrowserActionApprovalSheet } from "../BrowserActionApprovalSheet";
import { ChatQuestionSheet } from "../ChatQuestionSheet";

type Notice = Extract<ChatHostNotice, { purpose: "one-dispatch-link" | "one-dispatch-result" }>;

/** Displays the member's observed work on an existing room receipt, without creating messages. */
export function OneDispatchNotice({ notice, locale }: { notice: Notice; locale: "ko" | "en" }) {
  const [current, setCurrent] = useState(notice);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answeredSource, setAnsweredSource] = useState<string | null>(null);
  useEffect(() => setCurrent(notice), [notice]);
  const dispatch = current.dispatch;
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
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const history = await api.invoke.history(dispatch.parentChatId);
        const updated = history.find(row => row.hostNotice?.purpose === current.purpose
          && "dispatch" in row.hostNotice && row.hostNotice.dispatch?.dispatchId === dispatch.dispatchId
          && "runId" in row.hostNotice && row.hostNotice.runId === current.runId)?.hostNotice;
        if (!cancelled && updated) setCurrent(updated as Notice);
      } catch { /* A failed read does not change the observed execution state. */ }
      finally { busy = false; }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [dispatch?.dispatchId, dispatch?.parentChatId, dispatch?.status, current.purpose, current.runId]);
  const ko = locale === "ko";
  const labels = {
    running: ko ? "작업 중" : "Working", waiting_input: ko ? "응답 대기" : "Waiting for input",
    completed: ko ? "완료" : "Completed", failed: ko ? "실패" : "Failed",
    cancelled: ko ? "취소됨" : "Cancelled", interrupted: ko ? "중단됨" : "Interrupted",
  };
  const status = dispatch?.status;
  const question = dispatch?.pendingQuestion;
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
    </div>
    {!!dispatch?.activity?.length && <details open={status === "running" || status === "waiting_input"} style={{ fontSize: 12, color: "var(--muted-deep)", marginBottom: 8 }}>
      <summary>{ko ? "진행 기록" : "Work activity"}</summary>
      {dispatch.activity.map(item => <div key={item.id} style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
        <span style={{ opacity: .65 }}>{item.kind === "tool" ? (ko ? "도구 · " : "Tool · ") : ""}</span>{item.text}
      </div>)}
    </details>}
    {dispatch?.resultText && <Markdown text={stripAgentControlBlocks(flattenAskFences(dispatch.resultText, locale))} messageId={`one-dispatch-result:${dispatch.dispatchId}:${current.runId}`} />}
    {question && answeredSource !== question.sourceMessageId && <ChatQuestionSheet
      questions={question.questions.map((item,index) => ({...item,id:`${question.sourceMessageId}-q${index}`}))}
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
