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
};

export function ToolApprovalCard({ request, compact = false }: { request: ToolApprovalRequestEvent; compact?: boolean }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const runtimeName = RUNTIME_LABEL[request.runtime] ?? request.runtime;
  return (
    <div className="tac" role="group" aria-label={ko ? "도구 실행 승인" : "Tool call approval"} data-testid="tool-approval-card" data-approval-id={request.id}>
      <div className="tac-head">
        <span className="tac-eyebrow">{runtimeName}</span>
        <strong className="tac-title">{ko ? "이 도구 실행을 허용할까요?" : "Allow this tool call?"}</strong>
      </div>
      <div className="tac-row"><span className="tac-key">{ko ? "도구" : "Tool"}</span><span className="tac-val mono">{request.tool}</span></div>
      {request.detail && <div className="tac-row"><span className="tac-key">{ko ? "대상" : "Target"}</span><span className="tac-val mono">{request.detail}</span></div>}
      {!compact && request.cwd && <div className="tac-row"><span className="tac-key">{ko ? "작업 폴더" : "Folder"}</span><span className="tac-val mono">{request.cwd}</span></div>}
      <p className="tac-note">
        {ko
          ? "허용하지 않으면 이 호출만 거부되고 나머지는 그대로 진행됩니다. \"항상 허용\"은 이 도구를 영구 허용해 어떤 에이전트에서도 다시 묻지 않습니다."
          : "Denying rejects only this call; the rest of the run proceeds. \"Always allow\" permanently allows this tool for every agent — it will never ask again."}
      </p>
      <div className="tac-actions">
        <button type="button" className="deny" onClick={() => decideToolApproval(request.id, "deny")}>{ko ? "거부" : "Deny"}</button>
        <button type="button" onClick={() => decideToolApproval(request.id, "allow_always")}>{ko ? "항상 허용" : "Always allow"}</button>
        <button type="button" onClick={() => decideToolApproval(request.id, "allow_session")}>{ko ? "이 작업에서 계속 허용" : "Allow for this task"}</button>
        <button type="button" className="primary" onClick={() => decideToolApproval(request.id, "allow_once")}>{ko ? "이번만 허용" : "Allow once"}</button>
      </div>
      <style jsx>{`
        .tac {
          display: flex; flex-direction: column; gap: 8px;
          margin: 8px 0; padding: 12px 14px;
          border: 1px solid var(--one-sheet-primary, #2f6f4f);
          border-radius: 12px;
          background: var(--one-sheet-bg, rgba(47, 111, 79, 0.06));
        }
        .tac-head { display: flex; flex-direction: column; gap: 2px; }
        .tac-eyebrow { font-size: 11px; letter-spacing: 0.02em; color: var(--one-sheet-muted, #7a7f76); }
        .tac-title { font-size: 14px; }
        .tac-row { display: flex; gap: 10px; align-items: baseline; }
        .tac-key { flex: 0 0 auto; min-width: 62px; font-size: 12px; color: var(--one-sheet-muted, #7a7f76); }
        .tac-val { font-size: 13px; overflow-wrap: anywhere; }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .tac-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--one-sheet-muted, #7a7f76); }
        .tac-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
        .tac-actions button {
          min-height: 34px; padding: 0 12px;
          border: 1px solid var(--one-sheet-control-border, rgba(0, 0, 0, 0.14));
          border-radius: 10px; background: transparent; color: inherit; font-size: 13px; cursor: pointer;
        }
        .tac-actions button:focus-visible { outline: none; box-shadow: var(--one-sheet-focus, 0 0 0 3px rgba(90, 120, 255, 0.35)); }
        .tac-actions .deny { color: var(--one-sheet-danger, #b4443a); }
        .tac-actions .primary { border-color: var(--one-sheet-primary, #2f6f4f); background: var(--one-sheet-primary, #2f6f4f); color: #fff; }
      `}</style>
    </div>
  );
}

/**
 * 대화 화면이 자기 chatId 로 마운트한다. 이 대화의 live 요청을 도착 순서대로 인라인 렌더하고,
 * 마운트되어 있는 동안 전역 배지는 이 대화 요청을 세지 않는다.
 */
export function ToolApprovalInline({ chatId }: { chatId: string | null | undefined }) {
  const { queue } = useToolApprovals();
  useEffect(() => markChatVisible(chatId), [chatId]);
  if (!chatId) return null;
  const mine = queue.filter((item) => item.chatId === chatId);
  if (mine.length === 0) return null;
  return (
    <div data-testid="tool-approval-inline">
      {mine.map((request) => <ToolApprovalCard key={request.id} request={request} />)}
    </div>
  );
}
