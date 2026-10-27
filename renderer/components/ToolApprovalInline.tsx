"use client";

/*
 * 도구 승인 인라인 카드 — 실행이 붙어 있는 대화 안에서, 묻는 순간에만 뜬다.
 *
 * ★오너 결정(2026-08-15): 승인은 모달이 아니라 대화의 한 줄이다. 런타임이 실행 전에
 * 물어본 요청(live)만 여기 온다. 이미 거부되고 지나간 것(post-denial)은 러너가 남긴
 * 알림 한 줄이 전부이며 카드가 되지 않는다.
 *
 * 칩은 네 답(allow_once · allow_session · allow_always · deny)을 번호 붙은 세로 목록으로 보여 준다
 * ("예 / 이 작업 동안 다시 묻지 않기 / 항상 허용 / 아니오").
 *
 * ★오너 2026-10-27 "승인카드 디자인이 좀 애매하다. 코덱스나 클로드코드 앱의 승인카드를 따라해라": 모양은
 * components/ApprovalPrompt 한 곳 — 질문 한 줄, 실제 실행될 명령·경로(코드 블록), 번호 선택지, 단축키 힌트,
 * 여러 건이면 한 장씩 "1/3 · 다음". 선택지의 뜻과 저장·전송은 그대로다.
 */
import { redactSecrets } from "@shared/secret-patterns";
import { useEffect, useState } from "react";
import { AskCard, type AskCardOption } from "@/components/AskCard";
import { IconShield, IconFolder } from "./Icon";
import { ApprovalPrompt, type ApprovalPromptDeck, type ApprovalPromptOption } from "./ApprovalPrompt";
import { useT } from "@/lib/i18n";
import type { ToolApprovalRequestEvent } from "@/lib/types";
import {
  decideToolApproval,
  dismissToolApproval,
  markChatVisible,
  refreshToolApprovalDecision,
  useApprovalDeck,
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
  "agentlas-local": "Agentlas Local · On-device",
  agentlas: "Agentlas",
};

/**
 * A tool as a person reads it. MCP calls arrive as "mcp__<server>__<tool>" (owner 2026-10-04 screenshot:
 * "mcp__one-team__one_supervi…" in an approval chip); the server prefix and underscores are machine spelling.
 */
export function toolDisplayName(tool: string): string {
  // The server part may itself contain underscores ("claude_ai_Notion"): it ends at the next "__" (mobile
  // tool_approval_presentation.dart toolApprovalDisplayName is the same rule).
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool.trim());
  const name = (mcp ? mcp[2] : tool).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return name || tool;
}

export function ToolApprovalCard({
  request,
  compact = false,
  chip = false,
  deck,
}: {
  request: ToolApprovalRequestEvent;
  compact?: boolean;
  /** The compact Graph surface is opt-in; One keeps its existing AskCard. */
  chip?: boolean;
  /** "1/3 · 다음" — set when this is one of several waiting approvals shown one at a time. */
  deck?: ApprovalPromptDeck;
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
  const durableFailure = (action?.durableConsent && action.durableConsent.status !== "persisted") || Boolean(action?.noteFailure);
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
   * A folder a room run needs (owner-named folder or a teammate's write lift, electron/mcp/run-workspace-grant.ts). The
   * phone already words this tool as a folder question (mobile tool_approval_presentation.dart); Desktop says the same:
   * the folder's last two path parts, and "edit" capability means creating and editing files there.
   */
  const folderAccess = request.tool === "folder-access";
  const folderWrite = folderAccess && request.capability === "edit";
  const folderLabel = folderAccess
    ? (request.detail || request.cwd || "").replace(/[\x00-\x1f\x7f]/g, "").split(/[\\/]+/).filter(Boolean).slice(-2).join("/")
      || (ko ? "요청한 폴더" : "the requested folder")
    : "";
  /*
   * 오너 지시 2026-08-24: 묻는 자리는 앱 어디서나 한 모양이다.
   * 예전에는 도구 이름과 [거부][이 작업 동안][이번만 허용] 이 한 줄에 가로로
   * 늘어서서, 무엇을 허락하는지 읽기 전에 버튼부터 보였다.
   * 규격은 docs/DESIGN-ASK-CARD.md.
   */
  const askTitle = escalation
    ? (ko ? "전체 액세스로 진행할까요?" : "Continue with full access?")
    : folderAccess
      ? folderWrite
        ? (ko ? `“${folderLabel}”에 파일을 만들고 수정할까요?` : `Allow creating and editing files in “${folderLabel}”?`)
        : (ko ? `“${folderLabel}” 폴더를 읽을까요?` : `Allow reading the “${folderLabel}” folder?`)
    : imageTool
      ? (ko ? "이미지 생성을 허용할까요?" : "Allow image generation?")
      : (ko ? `${toolDisplayName(request.tool)} 사용을 허용할까요?` : `Allow ${toolDisplayName(request.tool)}?`);
  /*
   * 오너 2026-10-27: Claude Code·Codex 의 승인 프롬프트 문구를 따른다 — 예 / 이 작업 동안 다시 묻지 않기 / 항상 허용 / 아니오.
   * 선택지의 뜻과 저장·전송(allow_once·allow_session·allow_always·deny)은 그대로다. "항상 허용"은 실제로 저장되는 범위만 말한다:
   * 영구 규칙은 사용자·작업 폴더·요청한 에이전트·정확한 대상(credentialResourceIdentity)·권한 수준에 묶인
   * consentBinding 한 건이다(electron/runtime/tool-approval.ts persistAlwaysGrant) — 도구 이름이나 명령 패턴 전체가 아니다.
   */
  const askOptions: (AskCardOption & Pick<ApprovalPromptOption, "role" | "showNote">)[] = [
    {
      id: "allow_once",
      title: ko ? "예" : "Yes",
      note: escalation
        ? (ko ? "이번 이어가기 실행에만 전체 액세스를 줍니다." : "Full access for this resumed run only.")
        // No "<runtime> 가": the particle does not fit every name. Folder notes say what happens to the
        // folder; mobile agentlas_screen.dart _inlineToolApprovalCard uses the same notes.
        : folderAccess
          ? (ko ? "지금 이 요청에만 허용합니다." : "This request only.")
          : (ko ? "이번 호출에만 씁니다." : "For this call only."),
      active: true,
      role: "primary",
      showNote: escalation,
      disabled: locked,
    },
    {
      id: "allow_session",
      title: ko ? "예, 이 작업 동안 다시 묻지 않기" : "Yes, and don't ask again during this task",
      note: escalation
        ? (ko ? "이 대화에서는 승격을 다시 묻지 않습니다." : "No more escalation questions in this conversation.")
        : (ko ? "이 작업이 끝날 때까지 다시 묻지 않습니다." : "No more questions until this task ends."),
      showNote: escalation,
      disabled: locked,
    },
    {
      id: "allow_always",
      title: ko ? "예, 항상 허용" : "Yes, always allow",
      note: escalation
        ? (ko ? "권한이 모자랄 때 항상 전체 액세스로 진행합니다." : "Always continue with full access when permission falls short.")
        : folderAccess
          ? folderWrite
            ? (ko ? "이 폴더의 파일 생성과 수정을 다시 묻지 않습니다." : "Never ask again about editing files here.")
            : (ko ? "이 폴더 읽기를 다시 묻지 않습니다." : "Never ask again about reading this folder.")
          : (ko ? "이 폴더에서 이 에이전트의 똑같은 호출만 다시 묻지 않습니다." : "Only this exact call, by this agent, in this folder is not asked again."),
      showNote: true,
      disabled: locked,
    },
    {
      id: "deny",
      title: ko ? "아니오" : "No",
      note: escalation
        ? (ko ? "읽기 전용을 유지합니다 — 요청된 변경은 실행되지 않습니다." : "Stay read-only — the requested change is not executed.")
        : folderAccess
          ? folderWrite
            ? (ko ? "이 폴더에 파일을 만들거나 수정하지 않고 계속합니다." : "Continues without editing files in this folder.")
            : (ko ? "이 폴더를 읽지 않고 계속합니다." : "Continues without reading this folder.")
          : (ko ? "이 호출만 거절하고 계속합니다." : "Refuses this call; the run continues."),
      role: "deny",
      showNote: escalation || folderAccess,
      disabled: locked,
    },
  ];

  // "아니오, 그리고 대신 이렇게 하세요" (오너 2026-10-27): 거절에 한 줄을 실어 보낸다. 줄은 이 요청이 붙어 있던 방(request.chatId)의 오너
  // 메시지로 한 번 간다 — 개인 에이전트 대화에 그려진 감독 방 카드도 그 방으로 간다. 방이 없는 요청에는 보낼 곳이 없어 입력을 열지 않는다.
  const noteTarget = request.chatId ? { draftKey: request.id } : null;
  const choose = (id: string, note?: string) => {
    void decideToolApproval(request.id, id as Parameters<typeof decideToolApproval>[1], id === "deny" ? note : undefined);
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
  const noteFailure = action?.noteFailure;
  const feedback = noteFailure
    ? (ko
      ? "거절은 적용됐지만 지시를 방에 보내지 못했습니다. 아래 글을 방 입력창에 직접 보내 주세요."
      : "The refusal was applied, but the instruction could not be sent to the room. Send the text below in the room yourself.")
    : action?.phase === "submitting"
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
      {noteFailure && <q data-testid="tool-approval-note-failed" style={{ display: "block", marginTop: 4, overflowWrap: "anywhere", userSelect: "text" }}>{noteFailure.text}</q>}
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

  const detailText = request.detail?.trim() ? redactSecrets(request.detail.trim()) : "";
  // The command or path the runtime is actually about to run, as code. An escalation request carries none, so a
  // line states the boundary it would widen instead.
  const chipDetail = request.detail?.trim()
    ? `${runtimeName} · ${redactSecrets(request.detail.trim())}`
    : escalation
      ? (ko ? "지금은 읽기 전용 — 허용하면 이 요청을 이어서 합니다" : "Read-only now — allowing continues this request")
      : runtimeName;
  if (compact && chip) {
    const folder = request.cwd
      ? redactSecrets(request.cwd).replace(/[\x00-\x1f\x7f]/g, "").split(/[\\/]+/).filter(Boolean).slice(-2).join("/")
      : "";
    return (
      <ApprovalPrompt
        question={askTitle}
        code={detailText || null}
        codeLabel={ko ? "실행될 명령 또는 대상" : "Command or target to run"}
        meta={(
          <span title={[runtimeName, request.cwd ? redactSecrets(request.cwd) : ""].filter(Boolean).join(" · ")}>
            {detailText
              ? <>{runtimeName}{folder ? ` · ${folder}` : ""}</>
              : <small title={chipDetail}>{chipDetail}</small>}
          </span>
        )}
        options={askOptions}
        locked={locked}
        onChoose={choose}
        denyNote={noteTarget}
        deck={deck}
        footer={feedbackNode}
      />
    );
  }

  return (
    <div data-testid="tool-approval-card-shell">
      <AskCard
        icon={<IconShield size={18} />}
        title={askTitle}
        subtitle={chipDetail}
        locale={ko ? "ko" : "en"}
        options={askOptions}
        onChoose={(id, freeText) => choose(id, freeText)}
        // The same "No, and do this instead" line as the prompt above: typing in this row and pressing Enter refuses with it.
        // An empty Enter does nothing here (this card's rows are the choices), unlike the prompt where it refuses without a line.
        {...(noteTarget ? {
          otherOption: { title: ko ? "아니오, 대신 이렇게 하세요" : "No, and tell the personal agent what to do instead" },
          footer: {
            placeholder: ko ? "대신 이렇게 하세요 (Enter 로 보내기)" : "Tell the personal agent what to do instead (Enter to send)",
            skipLabel: "", submitLabel: "", hideButton: true,
            onSkip: (text: string) => { if (!locked && text.trim()) choose("deny", text); },
          },
        } : {})}
        data-testid="tool-approval-card"
      >
        {request.cwd && <div style={{display: "flex", alignItems: "center", gap: 8, marginBottom: 8, color: "var(--muted-deep)", fontSize: 12, overflowWrap: "anywhere"}}>
          <IconFolder size={15} /><span>{redactSecrets(request.cwd)}</span>
        </div>}
      </AskCard>
      {feedbackNode}
    </div>
  );
}

export function ToolApprovalInline({
  chatId,
  permission,
  compact = false,
  chip = false,
  composerWidth,
  composerInset = 0,
}: {
  chatId: string | null | undefined;
  /** Full access settles stale live cards without painting an Allow once chip. */
  permission?: "auto" | "read" | "write" | "full";
  compact?: boolean;
  /** Enables the Graph approval chip without changing One's existing card. */
  chip?: boolean;
  /**
   * The width of the box this surface's person answers from, in px.
   *
   * An approval that spans the whole conversation column reads as a full-screen interruption. Each
   * surface has its own composer width -- One is 920, Work is 740 -- so the ask lines up with the
   * place the answer is typed instead of with whatever the column happens to be.
   */
  composerWidth?: number;
  /**
   * 작성창이 양옆에서 빼는 여백(px). 두 화면의 식이 다르다 —
   * One 은 `min(720px, 100%)` 이라 0, Work 는 `min(calc(100% - 32px), 740px)` 이라 32.
   * 상한만 맞추면 좁은 창에서 다시 어긋난다.
   */
  composerInset?: number;
}) {
  const { queue } = useToolApprovals();
  useEffect(() => markChatVisible(chatId), [chatId]);
  const mine = chatId ? queue.filter((item) => item.chatId === chatId) : [];
  const deck = useApprovalDeck(mine);
  const shown = deck.current;
  useEffect(() => {
    if (permission !== "full" || mine.length === 0) return;
    for (const request of mine) void decideToolApproval(request.id, "allow_session");
  }, [mine, permission]);
  if (!chatId) return null;
  if (permission === "full") return null;
  if (mine.length === 0) return null;
  return (
    <div
      className={chip ? "tool-approval-inline" : undefined}
      data-testid="tool-approval-inline"
      style={composerWidth ? ({
        "--agentlas-composer-width": `${composerWidth}px`,
        "--agentlas-composer-inset": `${composerInset}px`,
      } as React.CSSProperties) : undefined}
    >
      {/* One card at a time (owner 2026-10-27): the rest wait behind "1/3 · Next" instead of stacking above the composer. */}
      {shown ? (
        <ToolApprovalCard key={shown.id} request={shown} compact={compact} chip={chip}
          deck={{ index: deck.index, total: deck.total, onPrev: deck.prev, onNext: deck.next }} />
      ) : null}
    </div>
  );
}
