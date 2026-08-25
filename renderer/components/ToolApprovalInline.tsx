"use client";

/*
 * 도구 승인 인라인 카드 — 실행이 붙어 있는 대화 안에서, 묻는 순간에만 뜬다.
 *
 * ★오너 결정(2026-08-15): 승인은 모달이 아니라 대화의 한 줄이다. 런타임이 실행 전에
 * 물어본 요청(live)만 여기 온다. 이미 거부되고 지나간 것(post-denial)은 러너가 남긴
 * 알림 한 줄이 전부이며 카드가 되지 않는다.
 *
 * 세 답: [이번만 허용] [이 작업에서 계속 허용] [거부]. 답은 한 번만 간다.
 */
import { useEffect } from "react";
import { AskCard, type AskCardOption } from "@/components/AskCard";
import { useT } from "@/lib/i18n";
import type { ToolApprovalRequestEvent } from "@/lib/types";
import { decideToolApproval, markChatVisible, useToolApprovals } from "@/lib/tool-approvals";

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

export function ToolApprovalCard({ request, compact = false }: { request: ToolApprovalRequestEvent; compact?: boolean }) {
  const { locale } = useT();
  const ko = locale === "ko";
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
    },
    {
      id: "allow_session",
      title: ko ? "이 작업에서 계속 허용" : "Allow for this task",
      note: escalation
        ? (ko ? "이 대화에서는 승격을 다시 묻지 않습니다." : "No more escalation questions in this conversation.")
        : (ko ? "이 작업이 끝날 때까지 다시 묻지 않습니다." : "No more questions until this task ends."),
    },
    ...(compact ? [] : [{
      id: "allow_always",
      title: ko ? "항상 허용" : "Always allow",
      note: escalation
        ? (ko ? "권한이 모자랄 때 항상 전체 액세스로 진행합니다." : "Always continue with full access when permission falls short.")
        : (ko ? "어떤 에이전트에서도 이 도구를 다시 묻지 않습니다." : "Never ask again for this tool, in any agent."),
    }]),
    {
      id: "deny",
      title: ko ? "거부" : "Deny",
      note: escalation
        ? (ko ? "읽기 전용을 유지합니다 — 요청된 변경은 실행되지 않습니다." : "Stay read-only — the requested change is not executed.")
        : (ko ? "이 호출만 거부되고 나머지는 그대로 진행됩니다." : "Only this call is refused; the rest of the run continues."),
    },
  ];

  return (
    <AskCard
      title={askTitle}
      locale={ko ? "ko" : "en"}
      options={askOptions}
      onChoose={(id) => decideToolApproval(request.id, id as Parameters<typeof decideToolApproval>[1])}
      data-testid="tool-approval-card"
    />
  );
}

export function ToolApprovalInline({ chatId, compact = false }: { chatId: string | null | undefined; compact?: boolean }) {
  const { queue } = useToolApprovals();
  useEffect(() => markChatVisible(chatId), [chatId]);
  if (!chatId) return null;
  const mine = queue.filter((item) => item.chatId === chatId);
  if (mine.length === 0) return null;
  return (
    <div data-testid="tool-approval-inline">
      {mine.map((request) => <ToolApprovalCard key={request.id} request={request} compact={compact} />)}
    </div>
  );
}
