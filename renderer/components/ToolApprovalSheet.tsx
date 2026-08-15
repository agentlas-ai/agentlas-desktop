"use client";

/*
 * 도구 승인 바텀시트.
 *
 * ★이 시트의 설계 중심은 `mode` 다. 승인은 두 종류이고, 같은 버튼으로 그리면
 * "허용을 눌렀는데 아무 일도 일어나지 않는" 화면이 된다.
 *
 *  - live: 런타임이 실행 전에 물었고 답을 기다린다. 선택이 이번 호출을 결정한다.
 *    → [이번만 허용] [이 작업에서 계속 허용] [거부]
 *
 *  - post-denial: 헤드리스라 물어볼 상대가 없어 런타임이 **이미 거부하고 지나갔다.**
 *    이번 호출은 되돌릴 수 없다. 그래서 "허용" 버튼을 이번 실행의 약속처럼 보이게
 *    두면 안 된다. 무엇이 막혔는지 보여주고, 다음 실행을 위한 선택만 받는다.
 *    → [다음부터 허용] [확인]
 *
 * 그리고 두 경우 모두, 런타임이 남긴 "사용자가 거절했다"는 기록이 사실이 아님을
 * 화면이 명시한다(`deniedBy`). 사용자는 손도 대지 않았다.
 */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { ToolApprovalRequestEvent, ToolApprovalDecision } from "@/lib/types";
import { OneBottomSheet } from "@/components/one/OneBottomSheet";

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

export function ToolApprovalSheet() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [queue, setQueue] = useState<ToolApprovalRequestEvent[]>([]);
  const req = queue[0] ?? null;

  useEffect(() => {
    const events = ipcEvents();
    if (!events?.onToolApproval) return;
    return events.onToolApproval((next) => {
      setQueue((current) => (current.some((item) => item.id === next.id) ? current : [...current, next]));
    });
  }, []);

  if (!req) return null;

  const live = req.mode === "live";
  const runtimeName = RUNTIME_LABEL[req.runtime] ?? req.runtime;

  const decide = (decision: ToolApprovalDecision) => {
    const id = req.id;
    setQueue((current) => current.filter((item) => item.id !== id));
    void ipc()?.resolveToolApproval(id, decision);
  };

  const title = live
    ? ko ? "이 도구 실행을 허용할까요?" : "Allow this tool call?"
    : ko ? "승인이 없어 자동 거부된 단계가 있습니다" : "A step was auto-denied for missing approval";

  const description = live
    ? ko
      ? "이 작업이 계속되려면 아래 실행을 허용해야 합니다. 허용하지 않으면 해당 호출만 거부되고 나머지는 그대로 진행됩니다."
      : "This task needs the call below to continue. Denying it rejects only that call; the rest of the run proceeds."
    : ko
      ? "이 실행에는 승인할 사람이 붙어 있지 않아 런타임이 스스로 거부했습니다. 사용자가 거절한 것이 아니며, 이번 호출은 되돌릴 수 없습니다. 아래 선택은 다음 실행부터 적용됩니다."
      : "This run had nobody to approve it, so the runtime denied it on its own. You did not reject it, and this call cannot be replayed. The choice below applies from the next run.";

  return (
    <OneBottomSheet
      open
      onClose={() => decide(live ? "deny" : "deny")}
      closeLabel={ko ? "닫기" : "Close"}
      ariaLabelledBy="tool-approval-title"
      dialogRole="alertdialog"
      closeOnBackdrop={false}
      closeOnEscape={false}
      eyebrow={runtimeName}
      title={title}
      titleId="tool-approval-title"
      description={description}
    >
      <div className="ta">
        <div className="ta-row">
          <span className="ta-key">{ko ? "도구" : "Tool"}</span>
          <span className="ta-val mono">{req.tool}</span>
        </div>
        {req.detail && (
          <div className="ta-row">
            <span className="ta-key">{ko ? "대상" : "Target"}</span>
            <span className="ta-val mono">{req.detail}</span>
          </div>
        )}
        {req.cwd && (
          <div className="ta-row">
            <span className="ta-key">{ko ? "작업 폴더" : "Folder"}</span>
            <span className="ta-val mono">{req.cwd}</span>
          </div>
        )}
        {!live && req.deniedBy === "runtime-headless" && (
          <p className="ta-note">
            {ko
              ? "참고: 런타임 기록에는 “사용자가 거부함”으로 남습니다. 실제로는 물어볼 상대가 없어 자동 거부된 것입니다."
              : "Note: the runtime logs this as a user rejection. In fact it was auto-denied because there was nobody to ask."}
          </p>
        )}
        <div className="ta-actions">
          {live ? (
            <>
              <button type="button" className="deny" onClick={() => decide("deny")}>
                {ko ? "거부" : "Deny"}
              </button>
              <button type="button" onClick={() => decide("allow_session")}>
                {ko ? "이 작업에서 계속 허용" : "Allow for this task"}
              </button>
              <button type="button" className="primary" onClick={() => decide("allow_once")}>
                {ko ? "이번만 허용" : "Allow once"}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => decide("deny")}>
                {ko ? "확인" : "Dismiss"}
              </button>
              <button type="button" className="primary" onClick={() => decide("allow_session")}>
                {ko ? "다음부터 허용" : "Allow from next run"}
              </button>
            </>
          )}
        </div>
      </div>
      <style jsx>{`
        .ta { display: flex; flex-direction: column; gap: 10px; }
        .ta-row { display: flex; gap: 10px; align-items: baseline; }
        .ta-key {
          flex: 0 0 auto;
          min-width: 62px;
          font-size: 12px;
          color: var(--one-sheet-muted, #7a7f76);
        }
        .ta-val { font-size: 13px; overflow-wrap: anywhere; }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .ta-note {
          margin: 2px 0 0;
          font-size: 12px;
          line-height: 1.5;
          color: var(--one-sheet-muted, #7a7f76);
        }
        .ta-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 4px;
        }
        .ta-actions button {
          min-height: var(--one-sheet-control-height, 38px);
          padding: 0 14px;
          border: 1px solid var(--one-sheet-control-border, rgba(0, 0, 0, 0.14));
          border-radius: var(--one-sheet-control-radius, 10px);
          background: transparent;
          color: var(--one-sheet-ink, inherit);
          font-size: 13px;
          cursor: pointer;
        }
        .ta-actions button:focus-visible {
          outline: none;
          box-shadow: var(--one-sheet-focus, 0 0 0 3px rgba(90, 120, 255, 0.35));
        }
        .ta-actions .deny { color: var(--one-sheet-danger, #b4443a); }
        .ta-actions .primary {
          border-color: var(--one-sheet-primary, #2f6f4f);
          background: var(--one-sheet-primary, #2f6f4f);
          color: #fff;
        }
      `}</style>
    </OneBottomSheet>
  );
}
