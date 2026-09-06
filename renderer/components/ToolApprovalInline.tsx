"use client";

/*
 * 도구 승인 인라인 카드 — 실행이 붙어 있는 대화 안에서, 묻는 순간에만 뜬다.
 *
 * ★오너 결정(2026-08-15): 승인은 모달이 아니라 대화의 한 줄이다. 런타임이 실행 전에
 * 물어본 요청(live)만 여기 온다. 이미 거부되고 지나간 것(post-denial)은 러너가 남긴
 * 알림 한 줄이 전부이며 카드가 되지 않는다.
 *
 * Graph 칩은 네 답([이번만 허용] [이 작업에서 계속 허용] [항상 허용] [거부])을
 * 보여 준다. One의 기존 compact AskCard는 세 답을 유지한다.
 *
 * 승인 자체는 대화를 멈추는 경계지만, 화면을 차지하는 질문 시트가 아니다. Graph 칩은
 * 제목·런타임·네 선택지를 한 줄로 보여 주고, One은 기존 질문 카드를 그대로 쓴다.
 */
import { useEffect, useState } from "react";
import { AskCard, type AskCardOption } from "@/components/AskCard";
import { useT } from "@/lib/i18n";
import type { ToolApprovalRequestEvent } from "@/lib/types";
import {
  decideToolApproval,
  dismissToolApproval,
  markChatVisible,
  refreshToolApprovalDecision,
  useToolApprovals,
} from "@/lib/tool-approvals";

const RUNTIME_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  kimi: "Kimi",
  acp: "ACP",
  ollama: "Ollama",
  agentlas: "Agentlas",
};

export function ToolApprovalCard({
  request,
  compact = false,
  chip = false,
}: {
  request: ToolApprovalRequestEvent;
  compact?: boolean;
  /** The compact Graph surface is opt-in; One keeps its existing AskCard. */
  chip?: boolean;
}) {
  const { locale } = useT();
  const { actions } = useToolApprovals();
  const ko = locale === "ko";
  const action = actions.get(request.id);
  const expiryMs = Date.parse(request.expiresAt ?? "");
  const [clientExpired, setClientExpired] = useState(() => Number.isFinite(expiryMs) && expiryMs <= Date.now());
  useEffect(() => {
    if (!Number.isFinite(expiryMs)) return;
    const remaining = expiryMs - Date.now();
    if (remaining <= 0) {
      setClientExpired(true);
      return;
    }
    setClientExpired(false);
    const timer = window.setTimeout(() => setClientExpired(true), Math.min(remaining, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [expiryMs, request.id]);
  const durableFailure = action?.durableConsent && action.durableConsent.status !== "persisted";
  // A durable-save failure is a resolved call that must remain visible until
  // dismissal; the original live request's wall-clock expiry must not hide
  // that receipt after the user has already answered.
  const expired = !durableFailure && (clientExpired || (action?.phase === "terminal" && action.terminalStatus === "expired"));
  const locked = expired || action?.phase === "submitting" || action?.phase === "unknown" || action?.phase === "terminal";
  const runtimeName = RUNTIME_LABEL[request.runtime] ?? request.runtime;
  const imageTool = /(?:image|dall|flux|midjourney|imagen)/i.test(request.tool);
  /*
   * 권한 승격 요청(오너 결정 2026-08-25) — "읽기 전용이라 실행 불가"는 거절이 아니라
   * 이 칩으로 전체 액세스 승격을 묻는다. 채널은 일반 도구 승인과 같은 한 벌이고,
   * 문구만 승격의 의미(무엇이 넓어지는지)를 정확히 말한다.
   */
  const escalation = request.tool === "permission-escalation";
  /*
   * 오너 지시 2026-08-24: 묻는 자리는 앱 어디서나 한 모양이다.
   * 예전에는 도구 이름과 [거부][이 작업 동안][이번만 허용] 이 한 줄에 가로로
   * 늘어서서, 무엇을 허락하는지 읽기 전에 버튼부터 보였다.
   * 규격은 docs/DESIGN-ASK-CARD.md.
   */
  const askTitle = escalation
    ? (ko ? "전체 액세스로 진행할까요?" : "Continue with full access?")
    : imageTool
      ? (ko ? "이미지 생성을 허용할까요?" : "Allow image generation?")
      : (ko ? `${request.tool} 사용을 허용할까요?` : `Allow ${request.tool}?`);
  const askOptions: AskCardOption[] = [
    {
      id: "allow_once",
      title: ko ? "이번만 허용" : "Allow once",
      note: escalation
        ? (ko ? "이번 이어가기 실행에만 전체 액세스를 줍니다." : "Full access for this resumed run only.")
        : (ko ? `${runtimeName} 가 지금 이 호출에만 씁니다.` : `${runtimeName} uses it for this call only.`),
      active: true,
      disabled: locked,
    },
    {
      id: "allow_session",
      title: ko ? "이 작업에서 계속 허용" : "Allow for this task",
      note: escalation
        ? (ko ? "이 대화에서는 승격을 다시 묻지 않습니다." : "No more escalation questions in this conversation.")
        : (ko ? "이 작업이 끝날 때까지 다시 묻지 않습니다." : "No more questions until this task ends."),
      disabled: locked,
    },
    ...(compact && !chip ? [] : [{
      id: "allow_always",
      title: ko ? "항상 허용" : "Always allow",
      note: escalation
        ? (ko ? "권한이 모자랄 때 항상 전체 액세스로 진행합니다." : "Always continue with full access when permission falls short.")
        : (ko ? "이 도구의 같은 작업 패턴을 다시 묻지 않습니다." : "Do not ask again for this tool's matching action pattern."),
      disabled: locked,
    }]),
    {
      id: "deny",
      title: ko ? "거부" : "Deny",
      note: escalation
        ? (ko ? "읽기 전용을 유지합니다 — 요청된 변경은 실행되지 않습니다." : "Stay read-only — the requested change is not executed.")
        : (ko ? "이 호출만 거부되고 나머지는 그대로 진행됩니다." : "Only this call is refused; the rest of the run continues."),
      disabled: locked,
    },
  ];

  const choose = (id: string) => {
    void decideToolApproval(request.id, id as Parameters<typeof decideToolApproval>[1]);
  };

  const decisionLabel = action?.resolvedDecision === "allow_once"
    ? (ko ? "이번만 허용" : "Allow once")
    : action?.resolvedDecision === "allow_session"
      ? (ko ? "이 작업에서 계속 허용" : "Allow for this task")
      : action?.resolvedDecision === "allow_always"
        ? (ko ? "항상 허용" : "Always allow")
        : action?.resolvedDecision === "deny"
          ? (ko ? "거부" : "Deny")
          : null;
  const feedback = action?.phase === "submitting"
    ? (ko ? "결정을 전달하고 실제 실행 상태를 확인하는 중입니다." : "Sending the decision and verifying the actual runtime state.")
    : action?.phase === "retryable"
      ? (ko ? "결정이 적용되지 않았습니다. 승인 카드는 그대로 유지됐습니다. 다시 선택해 주세요." : "The decision was not applied. This approval is still waiting; choose again.")
      : action?.phase === "unknown"
        ? (ko ? "결정 요청 뒤 실제 상태를 확인하지 못했습니다. 같은 선택을 다시 보내지 말고 상태를 다시 확인하세요." : "The decision outcome could not be verified. Check status before sending the choice again.")
        : action?.phase === "terminal" && action.terminalStatus === "expired"
          ? (ko ? "승인 요청 시간이 만료되어 이 호출은 실행되지 않았습니다." : "This approval expired, so the call was not run.")
          : action?.phase === "terminal"
            ? (ko
              ? `이 요청은${decisionLabel ? ` '${decisionLabel}' 선택으로` : ""} 이미 처리되었습니다.`
              : `This request was already resolved${decisionLabel ? ` as '${decisionLabel}'` : ""}.`)
            : null;
  const durableNotice = action?.durableConsent && action.durableConsent.status !== "persisted"
    ? (ko
      ? "이번 호출은 선택대로 처리됐지만 ‘항상 허용’ 저장에 실패했습니다. 이 세션이 끝나면 다시 확인이 필요합니다."
      : "This call followed your choice, but the Always allow rule was not saved. A later session will ask again.")
    : null;

  const feedbackNode = feedback ? (
    <div
      role={action?.phase === "submitting" ? "status" : "alert"}
      data-testid="tool-approval-outcome"
      style={{
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <span>{feedback}</span>
      {durableNotice && <span style={{ display: "block", marginTop: 4 }}>{durableNotice}</span>}
      {action?.phase === "unknown" && (
        <button
          type="button"
          onClick={() => { void refreshToolApprovalDecision(request.id); }}
          style={{ marginInlineStart: 8 }}
        >
          {ko ? "상태 다시 확인" : "Check status"}
        </button>
      )}
      {action?.phase === "terminal" && (
        <button
          type="button"
          onClick={() => dismissToolApproval(request.id)}
          style={{ marginInlineStart: 8 }}
        >
          {ko ? "확인" : "Dismiss"}
        </button>
      )}
    </div>
  ) : durableNotice ? (
    <div
      role="alert"
      data-testid="tool-approval-durable-outcome"
      style={{
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {durableNotice}
    </div>
  ) : null;

  if (expired) {
    return (
      <section
        role="status"
        aria-live="polite"
        aria-label={ko ? "만료된 도구 승인" : "Expired tool approval"}
        data-testid="tool-approval-card"
        data-approval-state="expired"
        style={{
          padding: compact ? "12px 14px" : "16px 18px",
          borderRadius: 14,
          border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
          background: "color-mix(in srgb, var(--surface, var(--paper)) 94%, currentColor 6%)",
          opacity: 0.78,
        }}
      >
        <small style={{ display: "block", marginBottom: 5, fontWeight: 800, letterSpacing: ".04em" }}>
          {ko ? "승인 만료" : "Approval expired"}
        </small>
        <strong style={{ display: "block", lineHeight: 1.45 }}>{askTitle}</strong>
        <div data-testid="tool-approval-outcome" style={{ marginTop: 7, fontSize: 12, lineHeight: 1.45 }}>
          {ko
            ? "승인 요청 시간이 만료되어 이 호출은 실행되지 않았습니다."
            : "This approval expired, so the call was not run."}
          {action?.phase === "terminal" && (
            <button
              type="button"
              onClick={() => dismissToolApproval(request.id)}
              style={{ marginInlineStart: 8 }}
            >
              {ko ? "확인" : "Dismiss"}
            </button>
          )}
        </div>
      </section>
    );
  }

  if (compact && chip) {
    return (
      <section
        className="tool-approval-chip"
        role="alertdialog"
        aria-live="assertive"
        aria-label={askTitle}
        data-ask-card="true"
        data-testid="tool-approval-card"
      >
        <div className="tool-approval-chip-copy">
          <span className="tool-approval-chip-kicker">{ko ? "승인 필요" : "Approval needed"}</span>
          <strong>{askTitle}</strong>
          <small>{ko ? `${runtimeName} · 실행 전 확인` : `${runtimeName} · confirm before running`}</small>
        </div>
        <div className="tool-approval-chip-actions" role="group" aria-label={ko ? "승인 선택" : "Approval choices"}>
          {askOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`tool-approval-chip-action tool-approval-chip-action-${option.id.replace("allow_", "")}`}
              data-ask-option={option.id}
              data-active={option.active ? "true" : "false"}
              title={option.note}
              aria-label={`${option.title}: ${option.note}`}
              disabled={locked}
              onClick={() => choose(option.id)}
            >
              {option.title}
            </button>
          ))}
        </div>
        {feedbackNode}
      </section>
    );
  }

  return (
    <div data-testid="tool-approval-card-shell">
      <AskCard
        title={askTitle}
        locale={ko ? "ko" : "en"}
        options={askOptions}
        onChoose={choose}
        data-testid="tool-approval-card"
      />
      {feedbackNode}
    </div>
  );
}

export function ToolApprovalInline({
  chatId,
  compact = false,
  chip = false,
}: {
  chatId: string | null | undefined;
  compact?: boolean;
  /** Enables the Graph approval chip without changing One's existing card. */
  chip?: boolean;
}) {
  const { queue } = useToolApprovals();
  useEffect(() => markChatVisible(chatId), [chatId]);
  if (!chatId) return null;
  const mine = queue.filter((item) => item.chatId === chatId);
  if (mine.length === 0) return null;
  return (
    <div className={chip ? "tool-approval-inline" : undefined} data-testid="tool-approval-inline">
      {mine.map((request) => <ToolApprovalCard key={request.id} request={request} compact={compact} chip={chip} />)}
    </div>
  );
}
