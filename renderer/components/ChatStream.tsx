"use client";
import type { GoalResultPresentation } from "../../shared/goal-result";
import { GoalResultReport } from "./GoalResultReport";
import type { ChatHostNotice } from "../../shared/types";
import { normalizeChatHostNotice } from "../../shared/chat-host-notice";
import { HostContinuationNotice } from "./HostContinuationNotice";
// 메시지 스트림 렌더 — agent 메시지는 Markdown으로, 사용자 메시지는 plain.
// 작업 중 메시지는 Codex/Claude 데스크톱처럼 step log + 경과 시간을 실시간으로 보여준다.
import { Fragment, createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { HubAgentBookmark, InstalledAgent, InstalledFirm, InstalledMcpServer, Project } from "@/lib/types";
import { hubBookmarksWithoutLocalDuplicates } from "@/lib/hub-bookmark-events";
import { AgentAvatar } from "./AgentAvatar";
import { Markdown, MarkdownSegment, StreamingMarkdown, type CodeArtifact, type LinkedFileArtifact, type MediaArtifact } from "./Markdown";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import {
  buildToolCallDisplay,
  formatToolRunSummary,
  normalizeToolCall,
  summarizeToolRun,
  type ToolCallDetail,
} from "@shared/tool-call-detail";
import { useRouter } from "next/navigation";
import { stageDocumentHandoff } from "@/lib/document-store";
import {
  stripAgentControlBlocks,
  stripAgentIdentityBadges,
} from "@shared/agent-control-blocks";
import { McpResultPreview } from "./McpResultPreview";
import { LiveOutputViewer } from "./LiveOutputViewer";
import { ChatFileCards } from "./ChatFileExperience";
import type { ChatFileItem } from "@/lib/chat-files";
import { OneTurnWork } from "./one/OneTurnWork";
import type { OneWorkerWorkGroup } from "@/lib/one-turn-work";
import type { OneActivityItem, OneActivityState } from "@/lib/one-activity";

/**
 * Work keeps its transport projection in StreamMessage for compatibility with
 * the chat bridge.  The visible execution surface is One's canonical
 * OneTurnWork component, so this adapter is the only Work-specific boundary:
 * it maps typed stream steps to the same One activity ledger shape without
 * reimplementing any row, disclosure, or status styling here.
 */
export function workActivityStateFromMessage(message: StreamMessage): OneActivityState {
  // A Work message may carry the same Main-owned typed projection that One
  // renders. Keep this as the first branch so the compatibility fallback below
  // remains useful for older transcript snapshots without replacing durable
  // run identity, sequence, artifacts, sources, or handoffs with guessed rows.
  const latestActivityRun = message.activityRuns?.at(-1);
  if (latestActivityRun) return latestActivityRun.state;
  if (message.activityState) return message.activityState;
  const startedAt = message.startedAt ?? Date.now();
  const startedIso = new Date(startedAt).toISOString();
  const finishedIso = message.finishedAt != null ? new Date(message.finishedAt).toISOString() : undefined;
  const settled = !message.busy;
  const cancelled = message.failure?.code === "cancelled";
  const items: OneActivityItem[] = [{
    id: "run:lifecycle",
    kind: "run",
    status: cancelled ? "cancelled" : message.failure ? "failed" : settled ? "completed" : "running",
    observedAt: startedIso,
    ...(finishedIso ? { completedAt: finishedIso } : {}),
    ...(message.finishedAt != null ? { durationMs: Math.max(0, message.finishedAt - startedAt) } : {}),
  }];

  for (const step of message.steps ?? []) {
    const observedAt = new Date(step.createdAt ?? startedAt).toISOString();
    const status: OneActivityItem["status"] = step.resultIsError
      ? "failed"
      : step.result != null
        ? "completed"
        : !settled
          ? "running"
          : cancelled
            ? "cancelled"
            : message.failure
              ? "failed"
              : "info";
    if (step.kind === "tool") {
      items.push({
        id: `tool:${step.id}`,
        kind: "tool",
        status,
        observedAt,
        ...(finishedIso && status !== "running" ? { completedAt: finishedIso } : {}),
        agentName: step.agentName,
        role: step.role,
        phase: step.phase,
        tool: {
          name: step.tool ?? step.text,
          args: step.args,
          result: step.result,
          id: step.toolUseId,
          isError: step.resultIsError,
        },
      });
      continue;
    }
    items.push({
      id: `reasoning:${step.id}`,
      kind: "reasoning",
      status,
      observedAt,
      ...(finishedIso && status !== "running" ? { completedAt: finishedIso } : {}),
      agentName: step.agentName,
      role: step.role,
      phase: step.phase,
      message: step.text,
      text: step.text,
    });
  }

  for (const notice of message.notices ?? []) {
    items.push({
      id: `notice:${notice.id}`,
      kind: "notice",
      status: notice.level === "error" ? "failed" : "info",
      observedAt: finishedIso ?? startedIso,
      message: notice.message,
      detail: notice.details,
      noticeLevel: notice.level,
      noticeDisplay: notice.display,
    });
  }
  if (message.failure && !items.some((item) => item.kind === "notice" && item.message === message.failure?.message)) {
    items.push({
      id: `failure:${message.id}`,
      kind: "notice",
      status: "failed",
      observedAt: finishedIso ?? startedIso,
      message: message.failure.message,
      noticeLevel: "error",
    });
  }
  return {
    items,
    artifacts: [],
    sources: [],
    handoffs: [],
    tokens: message.tokens ?? message.liveTokens,
    lastSequence: items.length,
    terminalStatus: cancelled ? "cancelled" : message.failure ? "failed" : settled ? "completed" : undefined,
  };
}

/** 작업 중 패널에 누적되는 단일 단계. 새 이벤트마다 push (replace 아님). */
export interface StreamStep {
  id: string;
  /** thinking = 모델 사고, tool = 런타임/툴 호출 */
  kind: "thinking" | "tool";
  text: string;
  /** tool 호출 이름 (있으면 Claude Code식 접기/펴기 블록으로 렌더) */
  tool?: string;
  /** tool 인자 JSON 문자열 — 펼쳤을 때 표시 */
  args?: string;
  /** tool_use id — 호출과 결과를 같은 행으로 병합하기 위한 런타임 id */
  toolUseId?: string;
  /** tool 결과 문자열 — 펼쳤을 때 표시 */
  result?: string;
  /** 결과가 오류인지 여부 */
  resultIsError?: boolean;
  /** 실행 이벤트를 낸 에이전트 표시명. 멀티 에이전트/위임 카드에 사용한다. */
  agentName?: string;
  /** 회사/팀 안에서의 역할명. */
  role?: string;
  /** 오케스트레이션 단계 — plan/delegate/synthesize. */
  phase?: "plan" | "delegate" | "synthesize";
  /** 위임 카드 표시용 대상 노드 id 목록. */
  delegateTo?: string[];
  /** 채팅 안에서 카드로 보여줄 활동 상태. */
  activity?: "start" | "handoff" | "tool" | "complete" | "status";
  /** 런타임이 사용자에게 공개한 reasoning summary 행. 원시 chain-of-thought가 아니다. */
  reasoning?: boolean;
  /** 이 단계가 화면에 들어온 시각. 긴 실행 중 마지막 활동 표시용. */
  createdAt?: number;
  /** 이 도구 이벤트가 도착했을 때까지 스트리밍된 본문 길이 — 단일 실행에서 텍스트 사이에
   *  도구 그룹을 영상처럼 끼워 넣는(interleave) 분할 앵커. 없으면 본문 앞에 몰아서 렌더. */
  anchorTextLen?: number;
}

/** 에이전트가 사용자에게 옵션을 묻는 질문. Markdown에서 fence를 파싱해 채워진다. */
export interface ChatQuestion {
  /** 메시지 내 고유 id — 같은 메시지에서 여러 개 가능하면 인덱스로 구분 */
  id: string;
  question: string;
  /** 짧은 라벨 (UI 칩) — 선택 사항 */
  header?: string;
  /** 여러 옵션 동시 선택 허용 여부 */
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
  /** 사용자가 답한 옵션 라벨(들) — 한 번 답하면 잠금 */
  answer?: string[];
}

/** PRD→build→QA 같은 다단계 파이프라인의 한 단계 — 추천 시트에서 pipeline 을 고르면 시드된다(계획 가시화). */
export interface PipelineStage {
  order: number;
  /** 엔진 stage 키(plan/build/verify 등). */
  kind: string;
  agentName?: string;
  agentId?: string;
  /** 실행 상태 — 라이브 이벤트가 이 단계의 에이전트를 낼 때만 갱신(매칭 안 되면 미정으로 둔다 — 가짜 진행 금지). */
  status?: "pending" | "running" | "done";
}

/** A durable run projection attached to the assistant row it produced. */
export interface StreamActivityRun {
  runId: string;
  state: OneActivityState;
}

export interface StreamMessage {
  goalResult?: GoalResultPresentation;
  hostNotice?: ChatHostNotice;
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  /** Main-issued invocation identity for this assistant turn, when available. */
  runId?: string;
  /** Canonical typed One activity projection for this turn's exact run. */
  activityState?: OneActivityState;
  /** Rare fallback when multiple durable runs have no distinct assistant row. */
  activityRuns?: StreamActivityRun[];
  /** Durable run has no Main-issued assistant row anchor; render it separately. */
  unboundRun?: boolean;
  /** Durable transcript timestamp used to bind a ledger run to its answer row. */
  createdAt?: string;
  durableMessageId?: string;
  /** 가장 최근 status — 단일 줄 fallback (steps와 병행 가능) */
  status?: string;
  /** 진행 중일 때 누적된 step log. final 도착 시 비워도 되고 남겨둬도 됨. */
  steps?: StreamStep[];
  /** 호출 시작 시각 ms — 경과 시간 표시 */
  startedAt?: number;
  /** 호출 종료 시각 ms — 완료 후 상태줄의 총 경과 표시("50s · 175 tokens") */
  finishedAt?: number;
  /** 토큰 partial이 도착하기 시작했는지. true면 본문 끝에 깜빡이는 커서. */
  streaming?: boolean;
  /** 진행 중인지 — true면 워킹 패널 노출, false면 일반 메시지 */
  busy?: boolean;
  /** 첨부된 이미지 미리보기 URL — data:image/... base64 */
  imageDataUrls?: string[];
  /** Durable generic attachment groups are resolved to in-app file cards. */
  chatFiles?: ChatFileItem[];
  chatFileGroupIds?: string[];
  /** 본문에서 fence로 추출된 질문들 — UI는 본문 텍스트 아래에 카드로 렌더 */
  questions?: ChatQuestion[];
  /** Main-owned durable assistant row that owns the current question batch. */
  questionSourceMessageId?: string;
  /** Durable answer accepted before its continuation run began; used only to retry. */
  pendingCommittedReply?: string;
  /** Main-reserved run identity for the pending committed continuation. */
  pendingContinuationRunId?: string;
  /** A transport loss may auto-resume; typed rejection deliberately may not. */
  pendingContinuationAutoResume?: boolean;
  /** 생성 토큰 수 — "N tokens" 표시 (Claude Code 스타일) */
  tokens?: number;
  /** 라이브 누적 토큰(usage 이벤트, 단조 증가) — final 전 실시간 "N tokens" 표시 */
  liveTokens?: number;
  /** reasoning(thinking) 구간 상태 — 상태줄 문구 회전("생각 중…")과 "N초 동안 생각함"의 근거.
   *  lastMs는 직전 구간 지속시간으로, 이후 새 활동(텍스트/도구)이 오면 지워진다. */
  thinking?: { active: boolean; startedAt?: number; cumMs: number; lastMs?: number; headline?: string };
  /** 파이프라인 단계 계획 — 있으면 메시지 상단에 스테퍼로 표시(PRD→배포 가시화). */
  pipeline?: PipelineStage[];
  /** 멀티모달 엔진 미연결 — 본문 아래에 "설정으로 가기" 버튼을 렌더한다. */
  needsMultimodalSetup?: boolean;
  /**
   * ★호스트가 이 턴에 대해 한 말. **본문(text)과 분리된 칸이다.**
   *
   * 예전에는 자동화 등록 요약도, 서피스 정리 실패 사과도 전부 `text`에 이어붙거나
   * 대입돼서 모델이 그렇게 말한 것처럼 읽혔다(2026-08-08 실측). 고지는 자기 행으로
   * 심각도와 함께 뜨고, 기계 원문은 접혀 있다.
   */
  notices?: ChatNotice[];
  /** Main-authoritative terminal failure, kept separate from assistant copy. */
  failure?: { code: string; message: string };
}

export interface ChatNotice {
  id: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  code?: string;
  details?: string;
  /** divider면 좌우 선 사이의 라벨 — 대화의 경계(컨텍스트 압축 등). */
  display?: "row" | "divider";
}

export interface ChatEmptyDirectory {
  agents: InstalledAgent[];
  hubBookmarks: HubAgentBookmark[];
  firms: InstalledFirm[];
  projects: Project[];
  envKeys: string[];
  plugins: InstalledMcpServer[];
  /** Exact saved project order. First row owns the session; later rows are turn workers. */
  projectTeam?: Array<{ id: string; token: string; label: string }>;
}

function messageDomId(messageId: string): string {
  return `chat-message-${encodeURIComponent(messageId)}`;
}

export function ChatStream({
  messages,
  agentName,
  agentTone,
  emptyDirectory,
  onOpenArtifact,
  onOpenMedia,
  onOpenLinkedFile,
  onOpenChatFile,
  onOpenWorkflow,
  onAnswerQuestion,
  onOpenMultimodalSetup,
  onInspectWorker,
  artifactChatId,
  mediaBasePaths = [],
  workspaceRoot,
  focusMessageId,
}: {
  messages: StreamMessage[];
  agentName: string;
  agentTone: InstalledAgent["tone"];
  emptyDirectory?: ChatEmptyDirectory;
  /** 실행 폴더 — 도구 행의 파일 경로를 이 기준 상대경로로 줄인다. */
  workspaceRoot?: string;
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  onOpenChatFile?: (file: ChatFileItem) => void;
  onOpenWorkflow?: () => void;
  onStop?: () => void;
  /** 사용자가 질문에 답함 — 부모가 user 메시지로 전송 */
  onAnswerQuestion?: (messageId: string, questionId: string, answers: string[]) => void;
  /** 멀티모달 설정 화면으로 이동 — 엔진 미연결 CTA 버튼 클릭 시 */
  onOpenMultimodalSetup?: () => void;
  onInspectWorker?: (runId: string, group: OneWorkerWorkGroup) => void;
  artifactChatId?: string;
  /** 다른 메시지가 실행 중이면 오래된 질문 카드도 전송하지 않는다. */
  interactionBusy?: boolean;
  stopRequested?: boolean;
  mediaBasePaths?: string[];
  /** Project timeline deep link target. The id is local history metadata only. */
  focusMessageId?: string | null;
}) {
  const { t, locale } = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const scrollingToBottomRef = useRef(false);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [hasNewContent, setHasNewContent] = useState(false);
  const last = messages[messages.length - 1];
  const scrollSignal = last
    ? `${messages.length}:${last.id}:${last.text.length}:${last.busy ? 1 : 0}:${last.streaming ? 1 : 0}:${last.steps?.length ?? 0}`
    : "empty";
  const previousScrollSignalRef = useRef(scrollSignal);
  const hasFocusMessage = Boolean(
    focusMessageId && messages.some((message) => message.id === focusMessageId),
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const contentChanged = previousScrollSignalRef.current !== scrollSignal;
    previousScrollSignalRef.current = scrollSignal;

    if (messages.length === 0) {
      stickToBottomRef.current = true;
      scrollingToBottomRef.current = false;
      setAwayFromBottom(false);
      setHasNewContent(false);
      el.scrollTop = 0;
      return;
    }

    if (!stickToBottomRef.current) {
      if (contentChanged) setHasNewContent(true);
      return;
    }

    setAwayFromBottom(false);
    setHasNewContent(false);
    const handle = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(handle);
  }, [messages.length, scrollSignal]);

  useEffect(() => {
    if (!focusMessageId || !hasFocusMessage) return;
    stickToBottomRef.current = false;
    scrollingToBottomRef.current = false;
    setHasNewContent(false);
    const handle = window.requestAnimationFrame(() => {
      const target = document.getElementById(messageDomId(focusMessageId));
      if (!target) return;
      target.scrollIntoView({
        block: "center",
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      target.focus({ preventScroll: true });
      setAwayFromBottom(true);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [focusMessageId, hasFocusMessage]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 96;
    if (scrollingToBottomRef.current && !atBottom) return;
    scrollingToBottomRef.current = false;
    stickToBottomRef.current = atBottom;
    setAwayFromBottom(!atBottom);
    if (atBottom) setHasNewContent(false);
  }

  function cancelProgrammaticScroll() {
    // A wheel/touch/pointer gesture during smooth scrolling is an explicit
    // user takeover. Let the following scroll event recompute stickiness;
    // otherwise scrollingToBottomRef can stay true forever after interruption.
    scrollingToBottomRef.current = false;
  }

  // 아웃라인 레일 입력 — 사용자 프롬프트는 스트리밍으로 변하지 않으므로, 내용이
  // 같으면 이전 배열 참조를 유지해 memo된 레일이 토큰 델타마다 리렌더되지 않게 한다.
  const outlinePromptsRef = useRef<{ id: string; text: string }[]>([]);
  const outlinePrompts = useMemo(() => {
    const next = messages.filter((m) => m.role === "user").map((m) => ({ id: m.id, text: m.text }));
    const prev = outlinePromptsRef.current;
    if (prev.length === next.length && next.every((p, i) => prev[i].id === p.id && prev[i].text === p.text)) {
      return prev;
    }
    outlinePromptsRef.current = next;
    return next;
  }, [messages]);
  const jumpToPrompt = useCallback((id: string) => {
    const node = document.getElementById(messageDomId(id));
    node?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  function scrollToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    stickToBottomRef.current = true;
    scrollingToBottomRef.current = !reduceMotion;
    setHasNewContent(false);
    if (reduceMotion) {
      el.scrollTop = el.scrollHeight;
      setAwayFromBottom(false);
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  return (
    <WorkspaceRootContext.Provider value={workspaceRoot}>
    <div
      className="agentlas-chat-stream"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        position: "relative",
        display: "flex",
      }}
    >
      <ChatOutlineRail prompts={outlinePrompts} onJump={jumpToPrompt} />
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={cancelProgrammaticScroll}
        onTouchStart={cancelProgrammaticScroll}
        onPointerDown={cancelProgrammaticScroll}
        className="agentlas-chat-stream-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          // 좁은 pane에서 넓은 콘텐츠(코드블록·표·긴 URL)가 챗창 전체를 옆으로 밀어 깨뜨리지
          // 않게 가로 오버플로는 여기서 차단 — 스크롤은 각 블록(pre/table)이 자체 처리한다.
          overflowX: "hidden",
          padding: messages.length === 0
            ? "var(--chat-stream-empty-padding, 20px 28px)"
            : "var(--chat-stream-padding, 24px 32px)",
          background: "var(--paper)",
          display: "flex",
          flexDirection: "column",
          // 간격은 컨테이너가 아니라 **이웃 쌍**이 정한다(아래 messageGap).
          // flat gap 하나면 사용자 연속 발화와 역할 전환이 같은 거리로 벌어져
          // 대화의 덩어리가 안 보인다.
        }}
      >
        {messages.length === 0 && (
          <EmptyChatState agentName={agentName} directory={emptyDirectory} />
        )}
        {messages.map((m, index) => (
          <div
            key={m.id}
            id={messageDomId(m.id)}
            tabIndex={-1}
            data-chat-message-id={m.id}
            data-timeline-focus={focusMessageId === m.id ? "true" : "false"}
            className="agentlas-chat-message-anchor"
            style={{ marginTop: messageGap(messages[index - 1], m) }}
          >
            <Bubble
              message={m}
              agentName={agentName}
              agentTone={agentTone}
              onOpenArtifact={onOpenArtifact}
              onOpenMedia={onOpenMedia}
              onOpenLinkedFile={onOpenLinkedFile}
              onOpenChatFile={onOpenChatFile}
              onOpenWorkflow={onOpenWorkflow}
              onAnswerQuestion={onAnswerQuestion}
              onOpenMultimodalSetup={onOpenMultimodalSetup}
              onInspectWorker={onInspectWorker}
              artifactChatId={artifactChatId}
              mediaBasePaths={mediaBasePaths}
            />
          </div>
        ))}
      </div>

      {messages.length > 0 && awayFromBottom && (
        <button
          type="button"
          className="agentlas-chat-latest-button"
          onClick={scrollToLatest}
          aria-label={hasNewContent ? t("chatstream.new_messages") : t("chatstream.scroll_to_bottom")}
        >
          <span aria-hidden>↓</span>
          <span>{hasNewContent ? t("chatstream.new_messages") : t("chatstream.scroll_to_bottom")}</span>
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {hasNewContent ? t("chatstream.new_messages") : ""}
      </span>

      <style jsx global>{`
        .agentlas-chat-stream-scroll {
          scrollbar-gutter: stable;
        }
        .agentlas-chat-empty {
          width: min(820px, 100%);
          margin: auto;
          padding: 28px 0;
        }
        .agentlas-chat-empty-header {
          max-width: 620px;
          margin: 0 auto 24px;
          text-align: center;
        }
        .agentlas-chat-empty-header h2 {
          margin: 0;
          color: var(--ink);
          font-size: clamp(22px, 3vw, 30px);
          font-weight: 720;
          letter-spacing: -0.035em;
          line-height: 1.16;
        }
        .agentlas-chat-empty-header p {
          margin: 9px 0 0;
          color: var(--muted-deep);
          font-size: 13px;
          line-height: 1.55;
        }
        .agentlas-chat-empty-directory {
          border: 1px solid var(--paper-edge);
          border-radius: 18px;
          background: var(--paper-raised, var(--paper));
          box-shadow: var(--shadow-1);
          overflow: hidden;
        }
        .agentlas-chat-empty-directory-intro {
          padding: 16px 18px 14px;
          border-bottom: 1px solid var(--paper-edge);
        }
        .agentlas-chat-empty-directory-intro strong {
          display: block;
          color: var(--ink);
          font-size: 13px;
          line-height: 1.3;
        }
        .agentlas-chat-empty-directory-intro span {
          display: block;
          margin-top: 4px;
          color: var(--muted-deep);
          font-size: 11.5px;
          line-height: 1.45;
        }
        .agentlas-chat-empty-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 1px;
          background: var(--paper-edge);
        }
        .agentlas-chat-empty-group {
          min-width: 0;
          padding: 15px 18px 17px;
          background: var(--paper-raised, var(--paper));
        }
        .agentlas-chat-empty-group:last-child:nth-child(odd) {
          grid-column: 1 / -1;
        }
        .agentlas-chat-empty-group h3 {
          margin: 0 0 10px;
          color: var(--muted-deep);
          font: 650 10px/1.2 var(--font-mono);
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .agentlas-chat-empty-list {
          display: grid;
          gap: 7px;
          margin: 0;
          padding: 0;
          list-style: none;
        }
        .agentlas-chat-empty-item {
          min-width: 0;
          display: grid;
          grid-template-columns: minmax(86px, auto) minmax(0, 1fr);
          align-items: baseline;
          gap: 10px;
        }
        .agentlas-chat-empty-item code {
          overflow: hidden;
          color: var(--accent-strong, var(--accent));
          font: 600 11px/1.45 var(--font-mono);
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .agentlas-chat-empty-item span {
          overflow: hidden;
          color: var(--ink-soft);
          font-size: 11.5px;
          line-height: 1.45;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .agentlas-chat-latest-button {
          position: absolute;
          z-index: 4;
          left: 50%;
          bottom: 14px;
          transform: translateX(-50%);
          display: inline-flex;
          align-items: center;
          gap: 7px;
          min-height: 34px;
          padding: 7px 12px;
          border: 1px solid var(--paper-edge);
          border-radius: 999px;
          background: var(--paper-raised, var(--paper));
          box-shadow: var(--shadow-2);
          color: var(--ink);
          font: 650 11.5px/1 var(--font-body);
          cursor: pointer;
        }
        .agentlas-chat-latest-button:hover {
          border-color: color-mix(in srgb, var(--accent) 36%, var(--paper-edge));
          color: var(--accent-strong, var(--accent));
        }
        .agentlas-chat-latest-button:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .agentlas-chat-copy-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          padding: 0;
          border: 1px solid transparent;
          border-radius: 7px;
          background: transparent;
          color: var(--muted-deep);
          font-size: 11px;
          line-height: 1.35;
          cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .agentlas-chat-copy-button:hover {
          border-color: color-mix(in srgb, var(--ink-soft) 28%, var(--paper-edge));
          background: var(--fill-1);
          color: var(--ink);
        }
        /* 메시지 하단 액션(복사/읽어주기) — 영상처럼 호버/포커스 시에만 드러난다. */
        .agentlas-msg-actions {
          opacity: 0;
          transition: opacity 130ms ease;
        }
        .agentlas-chat-turn:hover .agentlas-msg-actions,
        .agentlas-msg-actions:focus-within {
          opacity: 1;
        }
        .agentlas-chat-copy-button:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .agentlas-chat-copy-button[data-copy-state="copied"] {
          border-color: color-mix(in srgb, var(--green-deep) 34%, var(--paper-edge));
          background: color-mix(in srgb, var(--green-deep) 8%, var(--paper));
          color: var(--green-deep);
        }
        .agentlas-chat-copy-button[data-copy-state="error"] {
          border-color: color-mix(in srgb, var(--red-deep) 32%, var(--paper-edge));
          background: color-mix(in srgb, var(--red-deep) 7%, var(--paper));
          color: var(--red-deep);
        }
        .agentlas-chat-message-anchor {
          border-radius: 14px;
          outline: 0 solid transparent;
          outline-offset: 5px;
          transition: background 180ms ease, outline-color 180ms ease;
        }
        .agentlas-chat-message-anchor[data-timeline-focus="true"] {
          background: color-mix(in srgb, var(--accent) 7%, transparent);
          outline: 2px solid color-mix(in srgb, var(--accent) 52%, transparent);
        }
        .agentlas-chat-message-anchor:focus-visible {
          outline: 2px solid var(--accent);
        }
        .agentlas-chat-streaming-cursor {
          display: inline-block;
          width: 7px;
          height: 14px;
          margin-left: 2px;
          vertical-align: text-bottom;
          border-radius: 1px;
          background: var(--accent);
          animation: agentlas-chat-cursor-blink 1s steps(1, end) infinite;
        }
        @keyframes agentlas-chat-cursor-blink {
          0%, 46% { opacity: 0.68; }
          47%, 100% { opacity: 0.12; }
        }
        @media (max-width: 640px) {
          .agentlas-chat-stream {
            --chat-stream-empty-padding: 16px;
            --chat-stream-padding: 18px 16px 24px;
          }
          .agentlas-chat-empty {
            padding: 12px 0 18px;
          }
          .agentlas-chat-empty-header {
            margin-bottom: 18px;
            text-align: left;
          }
          .agentlas-chat-empty-header h2 {
            font-size: 23px;
            line-height: 1.22;
          }
          .agentlas-chat-empty-grid {
            grid-template-columns: 1fr;
          }
          .agentlas-chat-empty-group:last-child:nth-child(odd) {
            grid-column: auto;
          }
          .agentlas-chat-latest-button {
            bottom: 10px;
            max-width: calc(100% - 32px);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .agentlas-chat-streaming-cursor {
            animation: none;
            opacity: 0.55;
          }
          .agentlas-chat-latest-button {
            scroll-behavior: auto;
          }
          .agentlas-chat-copy-button {
            transition: none;
          }
        }
      `}</style>
    </div>
    </WorkspaceRootContext.Provider>
  );
}

interface EmptyDirectoryItem {
  id: string;
  token: string;
  label: string;
}

function EmptyChatState({
  agentName,
  directory,
}: {
  agentName: string;
  directory?: ChatEmptyDirectory;
}) {
  const { t, locale } = useT();
  const isProjectTask = Array.isArray(directory?.projectTeam);
  const sections = useMemo(() => {
    if (!directory) return [];
    // ★목록 하나가 비어 있다고 작업 화면 전체가 죽으면 안 된다.
    // 실측(2026-08-08, 실렌더 검증): 로스터가 null 인 상태에서
    // `directory.agents.filter` 가 던져 ErrorBoundary 가 채팅을 통째로 대체했다
    // ("One이 화면을 바로잡고 있습니다"). 부분 실패는 그 부분만 비운다.
    const agents = Array.isArray(directory.agents) ? directory.agents : [];
    const bookmarks = Array.isArray(directory.hubBookmarks) ? directory.hubBookmarks : [];
    const mentions: EmptyDirectoryItem[] = directory.projectTeam ?? [
      ...agents
        .filter((agent) => agent.visibility !== "background" && agent.visibility !== "private")
        .slice(0, 2)
        .map((agent) => ({
          id: `agent-${agent.id}`,
          token: `@${locale === "en" ? agent.nameEn || agent.name : agent.name}`,
          label: t("chatstream.empty_mention_agent"),
        })),
      ...hubBookmarksWithoutLocalDuplicates(bookmarks, agents).slice(0, 2).map((bookmark) => ({
        id: `hub-${String(bookmark.listing.entityKind || "agent")}-${bookmark.slug}`,
        token: `@${locale === "en" ? bookmark.listing.nameEn || bookmark.listing.name : bookmark.listing.name}`,
        label: t("chatstream.empty_mention_hub"),
      })),
    ];

    return [
      { id: "context", title: locale === "ko" ? "책임자와 선호 팀" : "Controller and preferences", items: mentions },
    ].filter((section) => section.items.length > 0);
  }, [directory, locale, t]);

  return (
    <section className="agentlas-chat-empty" aria-labelledby="agentlas-chat-empty-title">
      <header className="agentlas-chat-empty-header">
        <h2 id="agentlas-chat-empty-title">{locale === "ko" ? "이 프로젝트에서 무엇을 완성할까요?" : "What should this project accomplish?"}</h2>
        {!isProjectTask ? <p>{locale === "ko" ? "원하는 결과를 설명하세요." : "Describe the outcome you want."}</p> : null}
      </header>
      {!isProjectTask && directory && sections.length > 0 && (
        <div className="agentlas-chat-empty-directory">
          <div className="agentlas-chat-empty-directory-intro">
            <strong>{locale === "ko" ? "자동 오케스트레이션 기준" : "Automatic orchestration"}</strong>
            <span>{locale === "ko" ? "아래 명단은 우선순위이며 매번 전부 투입되지 않습니다. @ 지정은 필요한 경우의 1회성 수동 개입입니다." : "This roster is a preference, not a forced run list. @ is an optional one-turn override."}</span>
          </div>
          <div className="agentlas-chat-empty-grid">
              {sections.map((section) => (
                <section
                  key={section.id}
                  className="agentlas-chat-empty-group"
                  aria-label={section.title}
                >
                  <h3>{section.title}</h3>
                  <ul className="agentlas-chat-empty-list">
                    {section.items.map((item) => (
                      <li key={item.id} className="agentlas-chat-empty-item" title={`${item.token} — ${item.label}`}>
                        <strong>{item.token}</strong>
                        <span>{item.label}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

// React.memo: props 동일 시 리렌더 스킵(스트리밍 중 무관 버블 재렌더 비용 제거). 표시명 유지.
const Bubble = memo(function Bubble({
  message,
  agentName,
  agentTone,
  onOpenArtifact,
  onOpenMedia,
  onOpenLinkedFile,
  onOpenChatFile,
  onOpenWorkflow,
  onAnswerQuestion,
  onOpenMultimodalSetup,
  onInspectWorker,
  artifactChatId,
  mediaBasePaths,
}: {
  message: StreamMessage;
  agentName: string;
  agentTone: InstalledAgent["tone"];
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  onOpenChatFile?: (file: ChatFileItem) => void;
  onOpenWorkflow?: () => void;
  onAnswerQuestion?: (messageId: string, questionId: string, answers: string[]) => void;
  onOpenMultimodalSetup?: () => void;
  onInspectWorker?: (runId: string, group: OneWorkerWorkGroup) => void;
  artifactChatId?: string;
  mediaBasePaths: string[];
}) {
  const { locale } = useT();
  // These hooks must run before the role-specific early returns below. A
  // streaming assistant row can become a settled/user/system row during
  // transcript reconciliation; keeping the adapter hooks conditional causes a
  // hook-order crash exactly at that transition.
  const workspaceRootForRun = useContext(WorkspaceRootContext);
  const workActivity = useMemo(() => workActivityStateFromMessage(message), [message]);
  const workActivities = useMemo(
    () => message.activityRuns?.length
      ? message.activityRuns.map((run) => ({ runId: run.runId, state: run.state }))
      : [{ runId: message.runId ?? message.id, state: workActivity }],
    [message.activityRuns, message.id, message.runId, workActivity],
  );
  // Activity notices belong under the work heading. Keep a separate plain
  // row only for an actionable sign-in, a context boundary, or a notice that
  // is absent from the canonical activity projection.
  const persistentNotices = (message.notices ?? []).filter((notice) =>
    notice.code === "runtime-signed-out" || notice.display === "divider"
    || (!message.busy && (notice.level === "warning" || notice.level === "error"))
    || !workActivities.some(({ state }) => state.items.some((item) =>
      item.kind === "notice" && item.message === notice.message
      && (item.detail ?? "") === (notice.details ?? ""))));
  if (message.role === "user") {
    // 질문 시트 배치 답장(스캐폴드 "질문:/선택:/답변:")은 어시스턴트 턴의 인용 카드가
    // 이미 질문+답을 보여준다 — 영상처럼 원문 버블은 숨긴다(첨부 이미지가 있으면 유지).
    if (
      message.text &&
      isQuestionBatchReply(message.text) &&
      !(message.imageDataUrls && message.imageDataUrls.length > 0)
    ) {
      return null;
    }
    return (
      <div style={{ alignSelf: "flex-end", maxWidth: "75%" }}>
        {message.chatFiles && message.chatFiles.length > 0 && onOpenChatFile && (
          <ChatFileCards files={message.chatFiles} locale={locale === "ko" ? "ko" : "en"} onOpen={onOpenChatFile} />
        )}
        {message.imageDataUrls && message.imageDataUrls.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {message.imageDataUrls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={url}
                alt=""
                style={{
                  maxWidth: 220,
                  maxHeight: 160,
                  borderRadius: 10,
                  border: "1px solid var(--paper-edge)",
                  objectFit: "cover",
                }}
              />
            ))}
          </div>
        )}
        {message.text && (
          <div
            style={{
              background: "var(--fill-2)",
              color: "var(--ink)",
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              fontSize: 14,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {message.text}
          </div>
        )}
      </div>
    );
  }
  if (message.role === "system") {
    if (normalizeChatHostNotice(message.role, message.hostNotice)) {
      return <HostContinuationNotice text={message.text} locale={locale === "ko" ? "ko" : "en"} />;
    }
    if (isInternalSystemNote(message.text)) return null;
    const isError = message.text.trim().startsWith("⚠️");
    return (
      <div
        data-chat-failure-code={message.failure?.code}
        style={{
          alignSelf: "stretch",
          maxWidth: 760,
          fontSize: 12.5,
          lineHeight: 1.55,
          color: isError ? "var(--red-deep)" : "var(--muted-deep)",
          background: isError ? "rgba(255,138,138,0.10)" : "transparent",
          padding: isError ? "9px 12px" : "2px 0",
          borderRadius: isError ? "var(--radius-sm)" : 0,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {message.text}
      </div>
    );
  }
  // agent — Markdown 렌더링.
  // 단일 실행은 기본적으로 영상형 인터리브 본문을 쓰되, 런타임이 공개한 reasoning
  // summary가 있으면 One과 같은 투명 활동 타임라인으로 남긴다.
  const displayText = userFacingAssistantText(message.text, Boolean(message.streaming));
  const displayMessage = displayText === message.text ? message : { ...message, text: displayText };
  const hasCanonicalActivity = workActivities.some(({ state }) => (
    state.items.length > 0
    || state.artifacts.length > 0
    || state.sources.length > 0
    || state.handoffs.length > 0
  ));
  const hasProgress = Boolean(message.busy || message.status || (message.steps && message.steps.length > 0) || hasCanonicalActivity);
  const showWorkActivity = hasCanonicalActivity || (hasProgress && (
    isParallelWorkMessage(message)
    || (message.steps ?? []).some((step) => step.reasoning === true || step.kind === "tool")
  ));
  return (
    <div className="agentlas-chat-turn" style={{ display: "flex", gap: 0, alignSelf: "stretch", width: "100%", maxWidth: 740, minWidth: 0 }}>
      <div className="agentlas-chat-avatar" style={{ position: "relative", flexShrink: 0 }}>
        <AgentAvatar name={agentName} tone={agentTone} size={28} />
      </div>
      <div
        className="agentlas-chat-answer"
        style={{ minWidth: 0, flex: 1, width: "100%", overflow: "hidden", padding: "9px 0 14px" }}
      >
        {message.chatFiles && message.chatFiles.length > 0 && onOpenChatFile && (
          <ChatFileCards files={message.chatFiles} locale={locale === "ko" ? "ko" : "en"} onOpen={onOpenChatFile} />
        )}
        {message.unboundRun && showWorkActivity && (
          <div
            data-work-run-unbound="true"
            style={{ color: "var(--muted-deep)", fontSize: 11.5, marginBottom: 5 }}
          >
            {locale === "ko"
              ? "실행 기록이 답변 행과 연결되지 않아 별도 작업 기록으로 표시됩니다."
              : "This durable run has no linked answer row, so its work record is shown separately."}
          </div>
        )}
        {showWorkActivity && workActivities.map(({ runId, state }, index) => (
          <OneTurnWork
            key={`work:${runId}`}
            state={state}
            artifactScope={artifactChatId ? { chatId: artifactChatId, runId } : undefined}
            busy={Boolean(message.busy && index === workActivities.length - 1)}
            startedAt={message.startedAt ?? null}
            locale={locale === "ko" ? "ko" : "en"}
            workspacePath={workspaceRootForRun ?? null}
            onInspectWorker={onInspectWorker && (message.activityRuns?.some((run) => run.runId === runId) || message.runId === runId)
              ? (group) => onInspectWorker(runId, group) : undefined}
          />
        ))}
        {persistentNotices.length > 0 && (
          <div className="agentlas-chat-notices">
            {persistentNotices.map((notice) => (
              <ChatNoticeRow key={notice.id} notice={notice} />
            ))}
          </div>
        )}
        <GoalResultReport result={message.goalResult} locale={locale}>
        {showWorkActivity && displayText && message.busy && (
          <LiveOutputPanel
            text={displayText}
            streaming={message.streaming}
            onOpenArtifact={onOpenArtifact}
            onOpenMedia={onOpenMedia}
            onOpenLinkedFile={onOpenLinkedFile}
            messageId={message.id}
            mediaBasePaths={mediaBasePaths}
          />
        )}
        {showWorkActivity && displayText && !message.busy && (
          <div
            style={{
              color: "var(--ink)",
              fontSize: 14,
              lineHeight: 1.65,
              marginTop: 10,
            }}
          >
            <Markdown
              text={displayText}
              messageId={message.id}
              onOpenArtifact={onOpenArtifact}
              onOpenMedia={onOpenMedia}
              onOpenLinkedFile={onOpenLinkedFile}
              mediaBasePaths={mediaBasePaths}
            />
            {message.streaming && <BlinkingCursor />}
          </div>
        )}
        {!showWorkActivity && (
          <SingleRunBody
            message={displayMessage}
            onOpenArtifact={onOpenArtifact}
            onOpenMedia={onOpenMedia}
            onOpenLinkedFile={onOpenLinkedFile}
            onOpenWorkflow={onOpenWorkflow}
            mediaBasePaths={mediaBasePaths}
          />
        )}
        </GoalResultReport>
        {message.imageDataUrls && message.imageDataUrls.length > 0 && (
          <div
            data-testid="chat-generated-images"
            style={{ display: "grid", gap: 8, marginTop: 10, maxWidth: 620 }}
          >
            {message.imageDataUrls.map((url, index) => (
              <LiveOutputViewer
                key={`${message.id}-image-${index}`}
                source={url}
                name={`agentlas-image-${index + 1}.png`}
                kind="image"
                locale={locale === "ko" ? "ko" : "en"}
                imageActions
              />
            ))}
          </div>
        )}
        {!showWorkActivity && <RunStatusLine message={message} onOpenWorkflow={onOpenWorkflow} />}
        {/* 질문은 이제 바텀 시트(ChatQuestionSheet)에서 답한다 — 스트림에는 답변이 끝난
            질문만 잠긴 기록으로 남긴다. ("—"는 시트에서 스킵된 질문의 잠금 마커라 숨김.) */}
        {message.questions && message.questions.some((q) => q.answer && q.answer.length > 0 && q.answer[0] !== "—") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
            {message.questions
              .filter((q) => q.answer && q.answer.length > 0 && q.answer[0] !== "—")
              .map((q) => (
                <QuestionBlock
                  key={q.id}
                  question={q}
                  disabled
                  onAnswer={(answers) => onAnswerQuestion?.(message.id, q.id, answers)}
                />
              ))}
          </div>
        )}
        {message.needsMultimodalSetup && !message.busy && (
          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => onOpenMultimodalSetup?.()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "9px 16px",
                borderRadius: 12,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--on-accent, var(--white))",
                fontWeight: 700,
                fontSize: 13,
                boxShadow: "var(--neu-raised)",
              }}
            >
              <span aria-hidden style={{ fontSize: 14 }}>🎨</span>
              {locale === "ko" ? "멀티모달 설정으로 가기" : "Open multimodal settings"}
            </button>
          </div>
        )}
        {displayText && !message.busy && (
          <div className="agentlas-msg-actions" style={{ display: "flex", gap: 4, marginTop: 6 }}>
            <CopyMessageButton text={displayText} />
            <SpeakMessageButton text={displayText} />
            <OpenAsDocumentButton text={displayText} />
          </div>
        )}
      </div>
    </div>
  );
});
Bubble.displayName = "Bubble";

/**
 * Hand a finished answer to Document Studio.
 *
 * A long-form answer used to dead-end in the transcript: Document Studio had no
 * inbound path, so a paper could be produced and then never reach an editor,
 * a citation list, or any export. Short replies are not documents, so the
 * action only appears once the answer is substantial.
 */
function OpenAsDocumentButton({ text }: { text: string }) {
  const { locale } = useT();
  const router = useRouter();
  if (text.trim().length < 400) return null;
  const label = locale === "ko" ? "문서로 열기" : "Open as document";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        // The first markdown heading is the document's own title; otherwise
        // leave it empty rather than inventing one from the first sentence.
        const heading = text.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim() ?? "";
        if (!stageDocumentHandoff({
          title: heading,
          body: text,
          sourceLabel: locale === "ko" ? "채팅" : "Chat",
        })) return;
        router.push("/apps/document-studio");
      }}
      className="agentlas-chat-copy-button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8" />
        <path d="M8 17h5" />
      </svg>
    </button>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  const { t } = useT();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  async function copyMessage() {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 1_800);
  }

  const label = copyState === "copied"
    ? t("chatstream.copied")
    : copyState === "error"
      ? t("chatstream.copy_failed")
      : t("chatstream.copy");

  return (
    <button
      type="button"
      className="agentlas-chat-copy-button"
      data-copy-state={copyState}
      onClick={() => void copyMessage()}
      aria-label={label}
      aria-live="polite"
      title={label}
    >
      {copyState === "copied" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

/** 답변 읽어주기 — OS TTS(speechSynthesis) 토글. 영상의 소리 아이콘 액션. */
function SpeakMessageButton({ text }: { text: string }) {
  const { t, locale } = useT();
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    return () => {
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* TTS 미지원 환경 무시 */
      }
    };
  }, []);
  const synthAvailable = typeof window !== "undefined" && "speechSynthesis" in window;
  if (!synthAvailable) return null;
  const label = speaking ? t("chatstream.speak_stop") : t("chatstream.speak");
  const toggle = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const spoken = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[*_#>`|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
    if (!spoken) return;
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = locale === "ko" ? "ko-KR" : "en-US";
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(utterance);
    setSpeaking(true);
  };
  return (
    <button
      type="button"
      className="agentlas-chat-copy-button"
      data-speaking={speaking ? "true" : undefined}
      onClick={toggle}
      aria-label={label}
      aria-pressed={speaking}
      title={label}
    >
      {speaking ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 5 6 9H2v6h4l5 4V5z" />
          <line x1="22" x2="16" y1="9" y2="15" />
          <line x1="16" x2="22" y1="9" y2="15" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M11 5 6 9H2v6h4l5 4V5z" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        </svg>
      )}
    </button>
  );
}

// (이전의 rAF 기반 useSmoothReveal은 제거 — 매 프레임(60fps) setState + 전체 마크다운
//  재파싱으로 긴 답변에서 스트리밍이 끊기는 주범이었다. 이제 partial 도착(≈60ms) 단위로만
//  렌더하고, StreamingMarkdown이 완결 세그먼트를 memo로 고정해 마지막 세그먼트만 재파싱한다.)

function LiveOutputPanel({
  text,
  streaming,
  messageId,
  onOpenArtifact,
  onOpenMedia,
  onOpenLinkedFile,
  mediaBasePaths,
}: {
  text: string;
  streaming?: boolean;
  messageId: string;
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  mediaBasePaths: string[];
}) {
  return (
    <div
      style={{
        color: "var(--ink-soft)",
        fontSize: 13.5,
        lineHeight: 1.6,
        marginTop: 8,
        opacity: 0.92,
      }}
    >
      {streaming ? (
        <StreamingMarkdown
          text={text}
          messageId={messageId}
          onOpenArtifact={onOpenArtifact}
          onOpenMedia={onOpenMedia}
          onOpenLinkedFile={onOpenLinkedFile}
          mediaBasePaths={mediaBasePaths}
        />
      ) : (
        <Markdown
          text={text}
          messageId={messageId}
          onOpenArtifact={onOpenArtifact}
          onOpenMedia={onOpenMedia}
          onOpenLinkedFile={onOpenLinkedFile}
          mediaBasePaths={mediaBasePaths}
        />
      )}
      {streaming && <BlinkingCursor />}
    </div>
  );
}

// ── 단일 실행 본문 — 영상형 인터리브: 텍스트 세그먼트 사이에 도구 그룹을 끼워 렌더 ──
// 도구 이벤트가 도착한 시점의 본문 길이(anchorTextLen)를 분할 앵커로 쓰고, 마크다운이
// 깨지지 않는 줄 경계로 스냅한다. 마지막 세그먼트만 타자기(StreamingMarkdown)로 흐른다.
function SingleRunBody({
  message,
  onOpenArtifact,
  onOpenMedia,
  onOpenLinkedFile,
  onOpenWorkflow,
  mediaBasePaths,
}: {
  message: StreamMessage;
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  onOpenWorkflow?: () => void;
  mediaBasePaths: string[];
}) {
  const text = message.text ?? "";
  const busy = Boolean(message.busy);
  const toolSteps = useMemo(() => (message.steps ?? []).filter((s) => s.tool), [message.steps]);
  const groups = useMemo(() => buildToolGroups(toolSteps, text), [toolSteps, text]);
  // 콜백/배열 identity 고정 — 완결 세그먼트(MarkdownSegment memo)가 부모 재렌더마다
  // 깨지지 않게 한다(StreamingMarkdown과 같은 패턴).
  const artifactRef = useRef(onOpenArtifact);
  artifactRef.current = onOpenArtifact;
  const mediaRef = useRef(onOpenMedia);
  mediaRef.current = onOpenMedia;
  const linkedFileRef = useRef(onOpenLinkedFile);
  linkedFileRef.current = onOpenLinkedFile;
  const stableArtifact = useCallback((a: CodeArtifact) => artifactRef.current?.(a), []);
  const stableMedia = useCallback((a: MediaArtifact) => mediaRef.current?.(a), []);
  const stableLinkedFile = useCallback((a: LinkedFileArtifact) => linkedFileRef.current?.(a), []);
  const basePathsKey = mediaBasePaths.join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableBasePaths = useMemo(() => mediaBasePaths.slice(), [basePathsKey]);
  if (!text.trim() && toolSteps.length === 0) return null;

  const segments: Array<{ key: string; text: string; group?: StreamStep[] }> = [];
  let cursor = 0;
  for (const g of groups) {
    // key는 앵커 값이 아니라 그룹 첫 스텝 id — 앵커가 스냅으로 움직여도 그룹/세그먼트가
    // 리마운트되지 않아 펼침 상태와 memo가 보존된다.
    segments.push({ key: `seg-${g.steps[0]?.id ?? g.anchor}`, text: text.slice(cursor, g.anchor), group: g.steps });
    cursor = g.anchor;
  }
  const tail = text.slice(cursor);
  const lastGroup = groups[groups.length - 1];
  const lastGroupLive =
    busy && !!lastGroup && !tail.trim() && lastGroup.steps.some((s) => s.result == null);

  const markdownProps = {
    onOpenArtifact: stableArtifact,
    onOpenMedia: stableMedia,
    onOpenLinkedFile: stableLinkedFile,
    mediaBasePaths: stableBasePaths,
  };
  return (
    <div
      style={{
        color: "var(--ink)",
        fontSize: 14,
        lineHeight: 1.65,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {segments.map((seg, i) => (
        <Fragment key={seg.key}>
          {seg.text.trim() && (
            <div style={{ minWidth: 0 }}>
              <MarkdownSegment text={seg.text} messageId={`${message.id}:${seg.key}`} {...markdownProps} />
            </div>
          )}
          {seg.group && seg.group.length > 0 && (
            <ToolGroupBlock
              steps={seg.group}
              live={lastGroupLive && i === segments.length - 1}
              onOpenLinkedFile={onOpenLinkedFile}
              onOpenWorkflow={onOpenWorkflow}
            />
          )}
        </Fragment>
      ))}
      {tail.trim() && (
        <div style={{ minWidth: 0 }}>
          {busy && message.streaming ? (
            <StreamingMarkdown text={tail} messageId={`${message.id}:t${cursor}`} {...markdownProps} />
          ) : (
            <Markdown text={tail} messageId={`${message.id}:t${cursor}`} {...markdownProps} />
          )}
          {message.streaming && <BlinkingCursor />}
        </div>
      )}
    </div>
  );
}

/** 도구 그룹 분할 앵커 계산 — 같은 스냅 지점에 도착한 연속 도구는 한 그룹으로 묶는다. */
function buildToolGroups(
  toolSteps: StreamStep[],
  text: string,
): Array<{ anchor: number; steps: StreamStep[] }> {
  if (toolSteps.length === 0) return [];
  const groups: Array<{ anchor: number; steps: StreamStep[] }> = [];
  for (const s of toolSteps) {
    const anchor = snapAnchor(text, s.anchorTextLen ?? 0);
    const last = groups[groups.length - 1];
    if (last && anchor <= last.anchor) last.steps.push(s);
    else groups.push({ anchor, steps: [s] });
  }
  return groups;
}

/** 마크다운을 깨지 않는 분할 지점으로 스냅 — 줄 경계가 아니면 다음 줄 끝까지 전진하고
 *  (partial 스로틀로 문장 꼬리가 도구 카드 아래로 떨어지는 것 방지), 코드펜스 안이면
 *  펜스가 닫힌 뒤로 전진한다. */
function snapAnchor(text: string, raw: number): number {
  let anchor = Math.min(Math.max(raw, 0), text.length);
  const atBoundary =
    anchor === 0 || anchor === text.length || text[anchor - 1] === "\n" || text[anchor] === "\n";
  if (!atBoundary) {
    const next = text.indexOf("\n", anchor);
    anchor = next < 0 ? text.length : next + 1;
  }
  const fences = (text.slice(0, anchor).match(/```/g) || []).length;
  if (fences % 2 === 1) {
    const close = text.indexOf("```", anchor);
    if (close < 0) {
      // 아직 닫히지 않은 펜스 — text.length를 반환하면 스트리밍 중 매 partial마다 앵커가
      // 따라 움직여(chase) 리마운트 폭주가 된다. 펜스 시작 직전 줄 경계로 '뒤로' 고정.
      const fenceStart = text.lastIndexOf("```", Math.max(0, anchor - 1));
      if (fenceStart <= 0) return 0;
      const back = text.lastIndexOf("\n", fenceStart - 1);
      return back < 0 ? 0 : back + 1;
    }
    const after = text.indexOf("\n", close + 3);
    anchor = after < 0 ? text.length : after + 1;
  }
  return anchor;
}

// ── 도구 그룹 카드 — 실행 중 "읽는 중 ›" 라이브 라벨, 완료 후
//    "실행됨 명령 N개, 읽기 파일 N개 ›" 접힘 요약 → 클릭 시 행 카드 펼침 ──
function ToolGroupBlock({
  steps,
  live,
  onOpenLinkedFile,
  onOpenWorkflow,
}: {
  steps: StreamStep[];
  live: boolean;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  onOpenWorkflow?: () => void;
}) {
  const { locale } = useT();
  const workspaceRootForRun = useContext(WorkspaceRootContext);
  const [open, setOpen] = useState(false);
  if (live) {
    const running = steps.filter((s) => s.result == null);
    const cur = running[running.length - 1] ?? steps[steps.length - 1];
    const view = toolView(cur.tool!, cur.args, locale, cur.result, workspaceRootForRun);
    const liveFilePath = toolStepFilePath(cur);
    const liveLabel = liveFilePath ? baseName(liveFilePath) : view.label;
    const completedResultSteps = steps.filter((step) => step.result?.trim()).slice(-3);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            minWidth: 0,
            overflow: "hidden",
            fontSize: 13,
            fontWeight: 550,
            color: "var(--muted-deep)",
          }}
        >
          <span>{progressiveToolVerb(view.group, locale)}</span>
          {liveLabel && (
            <span
              title={view.label}
              style={{
                flex: 1,
                minWidth: 0,
                maxWidth: "100%",
                overflow: "hidden",
                color: "var(--ink-soft)",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {liveLabel}
            </span>
          )}
          <span aria-hidden style={{ color: "var(--muted)", fontSize: 14, lineHeight: 1 }}>›</span>
        </div>
        {completedResultSteps.map((step) => (
          <McpResultPreview key={`mcp-preview:${step.id}`} result={step.result} toolName={step.tool} locale={locale} compact />
        ))}
      </div>
    );
  }
  // 같은 파일을 5번 고쳐도 "파일 1개 편집"이다 — 집합으로 센다(공용 집계).
  const summary = formatToolRunSummary(
    summarizeToolRun(steps.map((s) => toolView(s.tool!, s.args, locale, s.result, workspaceRootForRun).detail)),
    locale,
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, width: "100%", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          alignSelf: "flex-start",
          maxWidth: "100%",
          border: "none",
          background: "transparent",
          padding: 0,
          fontSize: 13,
          fontWeight: 550,
          color: "var(--muted-deep)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        <span
          aria-hidden
          style={{
            color: "var(--muted)",
            fontSize: 14,
            lineHeight: 1,
            display: "inline-flex",
            flexShrink: 0,
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform .12s",
          }}
        >
          ›
        </span>
      </button>
      {steps.filter((step) => step.result?.trim()).slice(-3).map((step) => (
        <McpResultPreview key={`mcp-preview:${step.id}`} result={step.result} toolName={step.tool} locale={locale} compact />
      ))}
      {open && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderRadius: 10,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            overflow: "hidden",
          }}
        >
          {steps.map((s, i) => (
            <ToolGroupRow
              key={s.id}
              step={s}
              divider={i > 0}
              onOpenLinkedFile={onOpenLinkedFile}
              onOpenWorkflow={onOpenWorkflow}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolGroupRow({
  step,
  divider,
  onOpenLinkedFile,
  onOpenWorkflow,
}: {
  step: StreamStep;
  divider: boolean;
  onOpenLinkedFile?: (a: LinkedFileArtifact) => void;
  onOpenWorkflow?: () => void;
}) {
  const { locale } = useT();
  const workspaceRootForRun = useContext(WorkspaceRootContext);
  const [detailOpen, setDetailOpen] = useState(false);
  const workspaceRoot = useContext(WorkspaceRootContext);
  const view = toolView(step.tool!, step.args, locale, step.result, workspaceRoot);
  const filePath = toolStepFilePath(step);
  const detailText = step.result?.trim() || (step.args && step.args !== "{}" ? prettyJson(step.args) : "");
  const openFile = () => {
    if (!filePath || !onOpenLinkedFile) return false;
    onOpenLinkedFile({
      id: `tool-${step.id}`,
      name: baseName(filePath),
      href: filePath,
      path: filePath,
      fileUrl: fileUrlFromPath(filePath),
    });
    return true;
  };
  const onActivate = () => {
    if (openFile()) return;
    if (detailText) setDetailOpen((v) => !v);
    else onOpenWorkflow?.();
  };
  return (
    <div style={{ width: "100%", minWidth: 0, maxWidth: "100%", overflow: "hidden", borderTop: divider ? "1px solid var(--paper-edge)" : "none" }}>
      <button
        type="button"
        onClick={onActivate}
        title={
          filePath
            ? locale === "ko" ? "파일 뷰어로 열기" : "Open in file viewer"
            : detailText
              ? locale === "ko" ? "자세히 보기" : "Show details"
              : undefined
        }
        style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
          alignItems: "center",
          gap: 7,
          width: "100%",
          minWidth: 0,
          boxSizing: "border-box",
          overflow: "hidden",
          border: "none",
          background: "transparent",
          padding: "10px 12px",
          fontSize: 13,
          cursor: "pointer",
          textAlign: "left",
          color: "var(--ink)",
        }}
      >
        <span style={{ flexShrink: 0, color: "var(--muted-deep)", fontWeight: 550 }}>{view.verb}</span>
        <span
          className="agentlas-working-tool-verb"
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: 650,
            color: step.resultIsError ? "var(--red-deep)" : "var(--ink)",
          }}
        >
          {view.label || step.tool}
        </span>
        {view.facts && (
          <span
            style={{
              flexShrink: 0,
              color: "var(--muted-deep)",
              fontSize: 12,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {view.facts}
          </span>
        )}
        <span aria-hidden style={{ flexShrink: 0, color: "var(--muted)", fontSize: 14, lineHeight: 1 }}>›</span>
      </button>
      {detailOpen && view.detail.type === "todo" && (
        // 모델의 계획은 JSON 덩어리가 아니라 체크리스트다. 정규화가 이미 항목을 준다.
        <ul className="agentlas-chat-todo">
          {view.detail.items.map((item, i) => (
            <li
              key={`${i}-${item.text}`}
              className={item.completed ? "agentlas-chat-todo-done" : undefined}
            >
              <span aria-hidden className="agentlas-chat-todo-mark">
                {item.completed ? "✓" : "○"}
              </span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
      {detailOpen && view.detail.type !== "todo" && detailText && (
        <pre style={{ ...toolPre, margin: "0 12px 10px" }}>{detailText}</pre>
      )}
    </div>
  );
}

/** 진행형 도구 동사 — 영상의 "읽는 중 ›" 라이브 라벨. */
function progressiveToolVerb(group: ToolGroup, locale: "ko" | "en"): string {
  const ko: Record<ToolGroup, string> = {
    command: "실행 중",
    read: "읽는 중",
    edit: "쓰는 중",
    search: "검색 중",
    other: "작업 중",
  };
  const en: Record<ToolGroup, string> = {
    command: "Running",
    read: "Reading",
    edit: "Writing",
    search: "Searching",
    other: "Working",
  };
  return (locale === "ko" ? ko : en)[group];
}

/** read/edit 도구의 대상 파일 절대경로 — 행 클릭 시 파일 뷰어로 열기.
 *  POSIX(/...)와 Windows 드라이브 경로(C:\ / C:/) 모두 인정. */
function toolStepFilePath(step: StreamStep): string | null {
  if (!step.tool) return null;
  const group = toolView(step.tool, step.args, "en").group;
  if (group !== "read" && group !== "edit") return null;
  const a = parseArgs(step.args);
  const candidates = [a.file_path, a.path, a.notebook_path];
  for (const c of candidates) {
    if (typeof c === "string" && (c.startsWith("/") || /^[A-Za-z]:[\\/]/.test(c))) return c;
  }
  return null;
}

/** 로컬 절대경로 → file: URL (Windows 역슬래시/드라이브 문자 안전). */
function fileUrlFromPath(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

// ── ✳ 상태줄 — "{15s|2m 30s} · {N} tokens · {생각 문구}" (영상 재현) ──
const RUN_GLYPHS = ["·", "✢", "✳", "✻", "✽", "✻", "✳", "✢"] as const;

function GlyphSpinner({ active }: { active: boolean }) {
  // 동작 줄이기 사용자는 프레임 애니메이션 없이 정적 ✳ — 인덱스 0("·")에 고정되면
  // 실행 중이 완료보다 비어 보이는 역전이 생긴다.
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [frame, setFrame] = useState(2);
  useEffect(() => {
    if (!active || reducedMotion) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % RUN_GLYPHS.length), 120);
    return () => clearInterval(id);
  }, [active, reducedMotion]);
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: "1.1em",
        textAlign: "center",
        flexShrink: 0,
        color: "var(--muted-deep)",
        fontSize: 13,
        lineHeight: 1,
        fontWeight: 700,
      }}
    >
      {active ? (reducedMotion ? "✳" : RUN_GLYPHS[frame]) : "✳"}
    </span>
  );
}

function RunStatusLine({
  message,
  onOpenWorkflow,
}: {
  message: StreamMessage;
  onOpenWorkflow?: () => void;
}) {
  const { t, locale } = useT();
  const busy = Boolean(message.busy);
  const liveElapsed = useElapsedSeconds(message.startedAt, busy);
  const thinkTick = useElapsedSeconds(
    message.thinking?.active ? message.thinking.startedAt : undefined,
    busy && Boolean(message.thinking?.active),
  );
  const doneElapsed =
    message.startedAt != null && message.finishedAt != null
      ? Math.max(0, Math.floor((message.finishedAt - message.startedAt) / 1000))
      : null;
  const elapsed = busy ? liveElapsed : doneElapsed;
  if (elapsed == null || (!busy && message.startedAt == null)) return null;
  const tokens = busy ? (message.liveTokens ?? message.tokens) : (message.tokens ?? message.liveTokens);
  // 구조화 reasoning 이벤트가 없는 런타임도 thinking/tool-use 상태 문자열은 보낸다.
  // 그 값을 숨기면 사용자는 실행 중에 스피너와 `0s`만 보게 되므로, 가장 최근의
  // 비어 있지 않은 활동 문구를 상태줄 폴백으로 노출한다. reasoning 문구가 있으면
  // 그것을 우선해 동일 화면에 서로 다른 두 상태가 경쟁하지 않게 한다.
  const latestActivity = [...(message.steps ?? [])]
    .reverse()
    .find((step) => isUserFacingStreamStep(step) && step.text.trim())
    ?.text.trim();
  const phrase = busy
    ? runStatusPhrase(message.thinking, thinkTick, t)
      || userFacingRunStatus(message.status?.trim() || latestActivity, locale)
    : "";
  const parts = [formatElapsedShort(elapsed)];
  if (tokens != null && tokens > 0) parts.push(`${formatTokens(tokens)} ${t("chatstream.tokens_unit")}`);
  if (phrase) parts.push(phrase);
  return (
    <div
      role={busy ? "status" : undefined}
      style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 12, minHeight: 18 }}
    >
      <GlyphSpinner active={busy} />
      <button
        type="button"
        onClick={onOpenWorkflow}
        disabled={!onOpenWorkflow}
        title={onOpenWorkflow ? t("chatstream.open_run_log") : undefined}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          fontSize: 12.5,
          fontWeight: 550,
          color: "var(--muted-deep)",
          cursor: onOpenWorkflow ? "pointer" : "default",
          textAlign: "left",
        }}
      >
        {parts.join(" · ")}
      </button>
    </div>
  );
}

/** thinking 문구 회전 — 누적 thinking 시간 기반 에스컬레이션 + 종료 직후 "N초 동안 생각함". */
function runStatusPhrase(
  thinking: StreamMessage["thinking"],
  activeElapsedSec: number,
  t: ReturnType<typeof useT>["t"],
): string {
  if (!thinking) return "";
  /*
   * ★모델이 남긴 추론 요약이 있으면 그것을 보여준다(2026-09-04, One 과 같은 규칙).
   *
   * 예전에는 경과 시간으로 도는 상투구("생각 중…")만 보여주고 추론 텍스트는 통째로
   * 버렸다. 같은 순간 One 은 모델이 쓴 한 줄("Planning applypatch creation")을 그대로
   * 띄운다 — 무엇을 하고 있는지가 보인다. 텍스트가 없을 때만 예전 문구로 되돌아간다.
   */
  if (thinking.active && thinking.headline) return thinking.headline;
  if (thinking.active) {
    const cumSec = Math.floor(thinking.cumMs / 1000) + activeElapsedSec;
    if (cumSec < 2) return t("chatstream.think_1");
    if (cumSec < 15) return t("chatstream.think_2");
    if (cumSec < 60) return t("chatstream.think_3");
    return t("chatstream.think_4");
  }
  if (thinking.lastMs != null) {
    return t("chatstream.thought_for", { sec: Math.max(1, Math.round(thinking.lastMs / 1000)) });
  }
  return "";
}

/** 영상 형식의 경과 표시 — 60초 미만 "43s", 이후 "2m 30s" (로케일 공통). */
function formatElapsedShort(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/** 질문 시트 배치 답장 스캐폴드 감지 — ChatQuestionSheet.composeQuestionReply 형식과 짝. */
function isQuestionBatchReply(text: string): boolean {
  const trimmed = text.trim();
  return /^(질문|Question): /.test(trimmed) && /\n(선택|답변|Selected|Answer): /.test(trimmed);
}

function isInternalSystemNote(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("Agentlas OS operated this surface hands-free.") ||
    trimmed.startsWith("Agentlas OS prepared this surface hands-free.")
  );
}

function isInternalRuntimeStatus(text: string): boolean {
  return /가\s*생각\s*중|is\s+thinking|(?:^|\s)codex:\s|\[runtime-session\]|sessionend hook|skill descriptions were shortened|agentlas plugins|career graph (?:색인 갱신|refreshed):?\s*nodes=|\/Users\/[^\s]+\/(?:\.codex|\.claude|Library\/Application Support)|(?:^|\s)(?:mcp__|automation_graph_|hep-network|stormbreaker[_-])|\b(?:bash|collab_tool_call|mcp_tool_call|write|read|edit|glob|grep|websearch|webfetch)\b|\b(?:codex|claude code|gemini|kimi|grok)\s+cli\b/i.test(text);
}

function userFacingAssistantText(text: string, streaming = false): string {
  // Main normally removes these blocks before persisting a final event. This
  // renderer-side backstop also protects older Work history and partial
  // streams, so protocol JSON can never become ordinary Markdown content.
  let visible = stripAgentControlBlocks(text, { streaming });
  visible = stripAgentIdentityBadges(visible)
    .replace(/^\s*(?:사용 스킬|Skills used)\s*:[^\n]*(?:\n|$)/i, "")
    .replace(/^\s*I(?:'|’)m using (?:the )?`?[^`.\n]+`? skill because [^.]*\.\s*/i, "")
    .replace(/^\s*Execution mode:\s*`?appbridge-ceo-orchestrator`?[^\n]*\n?/gim, "")
    .trimStart();

  // Older runtimes sometimes persisted every internal progress update inside
  // one final assistant message. Keep that evidence in the local database, but
  // render only the controller's final result once a clear completion section
  // exists. Short ordinary answers are never trimmed by this legacy guard.
  /*
   * ★긴 답의 앞부분을 잘라내던 legacy guard는 제거했다.
   * "완료했습니다"가 600자 뒤에 나오고 앞에 흔한 낱말(회귀·게이트·localhost…)이 있으면
   * 그 앞을 통째로 버렸는데, 그 앞부분이 실제 설명인 경우와 진행 로그인 경우를
   * 낱말로는 가를 수 없다. 가를 수 없는 판정은 반드시 진짜 답을 먹는다.
   * 내부 진행 로그는 애초에 최종 메시지에 섞이지 않게 Main이 막는 것이 옳고,
   * 렌더는 받은 본문을 자르지 않는다.
   */

  // Local filesystem layout is implementation detail. Preserve useful link
  // labels and filenames without revealing account names or absolute paths.
  //
  // ★단, 마크다운 이미지 참조(![alt](/abs/path.png))는 통째로 보존한다(2026-08-18
  // 캡처 정본 사고): 이 치환이 ![screen](/Users/…/x.png) 을 "!screen" 으로 바꿔
  // 채팅의 캡처가 항상 깨졌다. 이미지 src는 텍스트로 노출되는 경로가 아니라
  // <img> 로만 쓰이므로, 경로 축약은 이미지 밖 텍스트에만 적용한다.
  const shortenLocalPaths = (chunk: string) => chunk
    .replace(/\[([^\]]+)\]\((?:file:\/\/)?\/Users\/[^)\n]+\)/g, "$1")
    .replace(/(?:file:\/\/)?\/Users\/[^\s)\]}>`,]+/g, (path) => path.split("/").filter(Boolean).at(-1) ?? "");
  return visible
    .split(/(!\[[^\]\n]*\]\([^)\n]*\))/)
    .map((segment, index) => (index % 2 === 1 ? segment : shortenLocalPaths(segment)))
    .join("")
    /*
     * ★여기서 지우던 것들을 되돌렸다 — 이 함수는 프로토콜을 벗기는 자리이지
     * 답을 편집하는 자리가 아니다.
     *
     * 지웠던 것과 그 결과:
     * - 모든 셸 코드블록(```bash|sh|shell|zsh|powershell|cmd) → 사용자가 실행하라고
     *   받은 명령이 화면에서 사라졌다. DB 원문에는 그대로 있어서 화면만 거짓이 됐다.
     * - `실행:` / `Run locally:` + 코드블록 → 같은 과잉.
     * - localhost·127.0.0.1 URL → "local preview" 치환. 로컬 미리보기 주소는
     *   **사용자가 열어야 하는 정보**인데 주소를 지우면 열 방법이 없어진다.
     *
     * 실행 위험은 렌더가 명령을 삭제해서 막는 게 아니라, 명령을 자동 실행하지
     * 않음으로써 막는다. 보여주는 것과 실행하는 것은 다른 권한이다.
     */
    // U+FFFD means the upstream byte stream was already decoded incorrectly.
    // The original bytes cannot be reconstructed at render time; hide the
    // replacement run instead of exposing `���`/`???` as if it were an answer.
    .replace(/\uFFFD+/gu, "…")
    .trim();
}

function userFacingRunStatus(text: string | undefined, locale: "ko" | "en"): string {
  const value = text?.replace(/\s+/g, " ").trim() ?? "";
  if (!value || isInternalRuntimeStatus(value)) {
    return locale === "ko" ? "작업을 진행하고 있습니다." : "Work is in progress.";
  }
  return value;
}

function isUserFacingStreamStep(step: StreamStep): boolean {
  if (step.tool) return true;
  return Boolean(step.text.trim()) && !isInternalRuntimeStatus(step.text);
}

function isParallelWorkMessage(message: StreamMessage): boolean {
  const steps = message.steps ?? [];
  const stepAgents = steps
    .map((step) => (step.agentName || step.role || "").trim().toLowerCase())
    .filter(Boolean);
  const pipelineAgents = (message.pipeline ?? [])
    .map((stage) => (stage.agentId || stage.agentName || "").trim().toLowerCase())
    .filter(Boolean);
  const uniqueAgents = new Set([...stepAgents, ...pipelineAgents]);
  const fanout = steps.some((step) => (step.delegateTo?.length ?? 0) > 1);
  return uniqueAgents.size > 1 || fanout;
}

// ── 질문 카드 ───────────────────────────────────────────
// LLM이 본문 fence로 emit한 옵션 질문. 사용자가 답하면 부모가 user 메시지로 자동 전송.
// React.memo: 다른 메시지 스트리밍 중 질문 카드 리렌더 스킵. 표시명 유지.
const QuestionBlock = memo(function QuestionBlock({
  question,
  disabled,
  onAnswer,
}: {
  question: ChatQuestion;
  disabled: boolean;
  onAnswer: (answers: string[]) => void;
}) {
  const { t } = useT();
  // lazy initializer: 매 렌더마다 new Set 생성하지 않고 최초 마운트 시에만 만든다.
  const [picked, setPicked] = useState<Set<string>>(() => new Set(question.answer ?? []));
  const [otherText, setOtherText] = useState("");
  const answered = !!question.answer && question.answer.length > 0;

  // 기타(직접 입력) — 제공된 선택지 외 자유 답변. multiSelect면 고른 것과 합쳐 보냄.
  function submitOther() {
    const v = otherText.trim();
    if (!v || answered || disabled) return;
    onAnswer(question.multiSelect ? [...picked, v] : [v]);
  }

  // useCallback + 함수형 setState: memo된 옵션 버튼에 안정적인 핸들러 전달, picked 의존성 제거.
  const toggle = useCallback(
    (label: string) => {
      if (answered || disabled) return;
      if (question.multiSelect) {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(label)) next.delete(label);
          else next.add(label);
          return next;
        });
      } else {
        // 단일 선택도 확인 버튼 전까지는 전송하지 않는다.
        setPicked(new Set([label]));
      }
    },
    [answered, disabled, question.multiSelect],
  );

  function submit() {
    if (answered || disabled || picked.size === 0) return;
    onAnswer([...picked]);
  }

  // 답변 완료 — 영상의 인용 카드: 질문(회색 한 줄) + 답변(본문색) 컴팩트 기록.
  if (answered) {
    const answerText = (question.answer ?? []).filter((a) => a !== "—").join(", ");
    return (
      <div
        style={{
          border: "1px solid var(--paper-edge)",
          borderRadius: 10,
          background: "var(--paper)",
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 5,
          maxWidth: 640,
        }}
      >
        <span style={{ fontSize: 13, color: "var(--muted-deep)", lineHeight: 1.5 }}>{question.question}</span>
        <span style={{ fontSize: 13.5, color: "var(--ink)", fontWeight: 600, lineHeight: 1.5 }}>{answerText}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        border: "1px solid color-mix(in srgb, var(--accent) 20%, var(--paper-edge))",
        borderRadius: 8,
        background: "linear-gradient(180deg, var(--paper) 0%, var(--fill-1) 100%)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 9,
        boxShadow: "0 8px 22px rgba(17, 24, 39, 0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 2 }}>
        <span
          className="agentlas-working-tool-copy"
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--accent)",
            background: "color-mix(in srgb, var(--accent) 10%, var(--paper))",
            padding: "2px 7px",
            borderRadius: 999,
            fontWeight: 750,
            border: "1px solid color-mix(in srgb, var(--accent) 16%, transparent)",
          }}
        >
          {question.header || "1/1"}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.45 }}>
          {question.question}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {question.options.map((opt, index) => {
          const isPicked = picked.has(opt.label);
          const isAnswered = answered && (question.answer ?? []).includes(opt.label);
          const dim = answered && !isAnswered;
          const selected = isAnswered || isPicked;
          return (
            <button
              key={opt.label}
              onClick={() => toggle(opt.label)}
              disabled={answered || disabled}
              aria-pressed={selected}
              style={{
                display: "grid",
                gridTemplateColumns: "30px minmax(0, 1fr)",
                alignItems: "flex-start",
                gap: 10,
                textAlign: "left",
                padding: "10px 11px",
                borderRadius: 8,
                border: selected
                  ? "1px solid color-mix(in srgb, var(--accent) 56%, var(--paper-edge))"
                  : "1px solid transparent",
                background: selected
                  ? "linear-gradient(135deg, color-mix(in srgb, var(--accent) 14%, var(--paper)), color-mix(in srgb, var(--amber-deep) 8%, var(--paper)))"
                  : "var(--paper-2)",
                boxShadow: selected ? "0 8px 18px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
                opacity: dim ? 0.45 : 1,
                cursor: answered || disabled ? "default" : "pointer",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 30,
                  height: 30,
                  flexShrink: 0,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: selected
                    ? "1px solid var(--accent)"
                    : "1px solid var(--paper-edge)",
                  background: selected ? "var(--accent)" : "var(--paper)",
                  color: selected ? "var(--white)" : "var(--ink-soft)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  fontWeight: 800,
                }}
              >
                {index + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 12.8,
                    fontWeight: 720,
                    color: "var(--ink)",
                    lineHeight: 1.35,
                    overflowWrap: "anywhere",
                  }}
                >
                  {opt.label}
                </span>
                {opt.description && (
                  <span
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: "var(--muted-deep)",
                      lineHeight: 1.45,
                      marginTop: 2,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {/* 기타 (직접 입력) — 선택지에 없는 답을 자유 입력 */}
      {!answered && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            className="agentlas-working-tool-result"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {t("ask.other")}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder={t("ask.other_placeholder")}
              // 타이핑 자체는 항상 허용 — 실행이 끝나기 직전(busy)에도 답을 미리 작성할 수 있게.
              // 실제 제출만 submitOther/answerQuestion 쪽 busy 가드로 통제한다.
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitOther();
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--paper-edge)",
                background: "var(--paper)",
                color: "var(--ink)",
                fontSize: 12.5,
              }}
            />
            <button
              onClick={submitOther}
              disabled={!otherText.trim() || disabled}
              style={{
                flexShrink: 0,
                padding: "8px 14px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: otherText.trim() ? "var(--paper)" : "var(--paper-2)",
                color: otherText.trim() ? "var(--ink)" : "var(--muted-deep)",
                border: "1px solid var(--paper-edge)",
                boxShadow: otherText.trim() ? "var(--neu-raised)" : "none",
                cursor: otherText.trim() ? "pointer" : "default",
              }}
            >
              {t("ask.submit")}
            </button>
          </div>
        </div>
      )}
      {!answered && (
        <button
          onClick={submit}
          disabled={picked.size === 0 || disabled}
          style={{
            alignSelf: "flex-end",
            padding: "6px 14px",
            borderRadius: 999,
            background: picked.size === 0 ? "var(--paper-2)" : "var(--paper)",
            color: picked.size === 0 ? "var(--muted-deep)" : "var(--ink)",
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid var(--paper-edge)",
            boxShadow: picked.size === 0 ? "none" : "var(--neu-raised)",
            cursor: picked.size === 0 ? "default" : "pointer",
          }}
        >
          {t("ask.submit")}
        </button>
      )}
    </div>
  );
});
QuestionBlock.displayName = "QuestionBlock";

// ── 도구 분류 (이름+인자 → 동사 + 간결 라벨 + 그룹) ───────────────
type ToolGroup = "command" | "read" | "edit" | "search" | "other";
interface ToolViewModel {
  group: ToolGroup;
  verb: string;
  label: string;
  /** 오른쪽 보조 사실 — `+23 −1`, `exit 0`, `파일 8개 · 31건 일치`. */
  facts?: string;
  /** 정규화된 의미 — 상세 렌더와 요약 집계가 이걸 읽는다. */
  detail: ToolCallDetail;
}

const toolPre: CSSProperties = {
  margin: "5px 0 2px 0",
  padding: "8px 10px",
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--ink-soft)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 220,
  overflow: "auto",
};

const VERB: Record<ToolGroup, { ko: string; en: string }> = {
  command: { ko: "실행됨", en: "ran" },
  read: { ko: "읽기", en: "read" },
  edit: { ko: "편집", en: "edited" },
  search: { ko: "검색", en: "searched" },
  other: { ko: "사용", en: "used" },
};

function baseName(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
function squish(s: string, n = 72): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function parseArgs(s?: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolView(
  tool: string,
  argsStr: string | undefined,
  locale: "ko" | "en",
  result?: string,
  cwd?: string,
): ToolViewModel {
  // ★판별은 shared/tool-call-detail.ts 한 곳에서만. 예전에는 이 함수가 Claude Code
  // 도구명에 하드코딩돼 codex/gemini/ollama/MCP가 전부 "기타"로 떨어졌고,
  // `bash`는 실제 명령을 버리고 "검증 단계"로 치환했다(정보량이 가장 큰 값을 지움).
  const detail = normalizeToolCall({ name: tool, args: argsStr, result, cwd });
  const display = buildToolCallDisplay({ name: tool, detail, locale });
  const group = toolGroupOf(detail);
  return {
    group,
    verb: VERB[group][locale],
    label: display.summary?.trim() || display.displayName,
    ...(display.facts ? { facts: display.facts } : {}),
    detail,
  };
}

/**
 * 호스트 고지 한 줄. 심각도가 색과 아이콘을 정하고, 기계 원문(details·code)은 접혀 있다.
 * 이 행은 **모델의 답이 아니다** — 그래서 말풍선 본문과 다른 표면을 쓴다.
 */
function ChatNoticeRow({ notice }: { notice: ChatNotice }) {
  const { locale } = useT();
  const [open, setOpen] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  /** Which runtime needs a sign-in, taken from the typed notice rather than its wording. */
  const signedOutRuntime = (() => {
    if (notice.code !== "runtime-signed-out" || !notice.details) return null;
    try {
      const parsed = JSON.parse(notice.details) as { runtime?: unknown };
      const runtime = typeof parsed.runtime === "string" ? parsed.runtime : "";
      return ["claude-code", "codex", "antigravity", "kimi", "grok"].includes(runtime) ? runtime : null;
    } catch {
      return null;
    }
  })();
  if (notice.display === "divider") {
    // 대화의 경계. 예전에는 상태줄로 지나가서 사용자는 자기 대화가 잘렸다는 걸
    // 알 수 없었다 — "왜 아까 말한 걸 잊었냐"의 절반이 여기서 나온다.
    return (
      <div className="agentlas-chat-divider" role="separator" aria-label={notice.message}>
        <span className="agentlas-chat-divider-line" aria-hidden />
        <span className="agentlas-chat-divider-label">
          <span aria-hidden>✂</span>
          {notice.message}
        </span>
        <span className="agentlas-chat-divider-line" aria-hidden />
      </div>
    );
  }
  const tone = {
    info: { fg: "var(--accent)", icon: "ⓘ" },
    success: { fg: "var(--ok)", icon: "✓" },
    warning: { fg: "var(--warn)", icon: "!" },
    error: { fg: "var(--red-deep)", icon: "×" },
  }[notice.level];
  const expandable = Boolean(notice.details || notice.code);
  return (
    <div className={`agentlas-chat-notice agentlas-chat-notice-${notice.level}`}>
      <span aria-hidden className="agentlas-chat-notice-icon" style={{ color: tone.fg }}>
        {tone.icon}
      </span>
      <div className="agentlas-chat-notice-body">
        <span style={{ color: tone.fg }}>{notice.message}</span>
        {signedOutRuntime && (
          /*
           * The one thing this notice exists to offer.
           *
           * The app never checks whether a runtime is signed in -- a present CLI with a version is
           * shown as connected -- so an expired login produced a failure whose only remedy was
           * opening a terminal and running the login command by hand. The mechanism to do it from
           * here already existed and nothing called it.
           */
          <button
            type="button"
            className="agentlas-chat-notice-toggle"
            data-testid="runtime-sign-in"
            disabled={signInBusy}
            onClick={() => {
              setSignInBusy(true);
              void ipc()?.runtime?.openCliLogin?.(signedOutRuntime as never)
                .catch(() => {})
                .finally(() => setSignInBusy(false));
            }}
          >
            {locale === "ko"
              ? (signInBusy ? "로그인 창 여는 중…" : "로그인")
              : (signInBusy ? "Opening sign-in…" : "Sign in")}
          </button>
        )}
        {expandable && (
          <button
            type="button"
            className="agentlas-chat-notice-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {locale === "ko"
              ? (open ? "자세히 닫기" : "자세히")
              : (open ? "Hide details" : "Details")}
          </button>
        )}
        {open && (
          <pre className="agentlas-chat-notice-details">
            {[notice.code ? `code: ${notice.code}` : "", notice.details ?? ""]
              .filter(Boolean)
              .join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * 이웃 두 메시지의 **종류 조합**이 간격을 정한다.
 *
 * flat `gap: 16` 하나로는 "사용자가 연달아 두 마디 한 것"과 "역할이 바뀐 것"이 같은
 * 거리로 벌어져 대화 덩어리가 안 읽힌다. 조합별로 정하면 덩어리가 눈에 들어온다.
 */
/**
 * 대화 아웃라인 레일 — 사용자 프롬프트 하나당 눈금 하나.
 *
 * 긴 실행 하나가 수백 행을 만드는데 "내가 아까 뭘 요청했지"를 찾을 방법이 없었다
 * (Ctrl+F도 없다). 눈금을 누르면 그 프롬프트로 간다. 눈금 3개 미만이면 숨는다 —
 * 짧은 대화에서는 레일이 소음이다.
 */
const ChatOutlineRail = memo(function ChatOutlineRail({
  prompts,
  onJump,
}: {
  prompts: { id: string; text: string }[];
  onJump: (messageId: string) => void;
}) {
  const { locale } = useT();
  const [hovered, setHovered] = useState<number | null>(null);
  if (prompts.length < 3) return null;
  return (
    <div
      className="agentlas-chat-outline"
      role="navigation"
      aria-label={locale === "ko" ? "대화 아웃라인" : "Conversation outline"}
      onPointerLeave={() => setHovered(null)}
    >
      {prompts.map((prompt, index) => {
        // 포인터 근처가 부드럽게 굵어진다(raised cosine, 반경 2) — 밴드가 켜졌다
        // 꺼지는 게 아니라 하나의 융기가 포인터를 따라 움직이는 것으로 읽힌다.
        const distance = hovered === null ? Infinity : Math.abs(index - hovered);
        const lift = distance >= 2 ? 0 : (1 + Math.cos((Math.PI * distance) / 2)) / 2;
        return (
          <button
            key={prompt.id}
            type="button"
            className="agentlas-chat-outline-tick"
            title={prompt.text.slice(0, 80)}
            aria-label={prompt.text.slice(0, 80)}
            onPointerEnter={() => setHovered(index)}
            onClick={() => onJump(prompt.id)}
            style={{ width: 10 + lift * 8, opacity: 0.45 + lift * 0.55 }}
          />
        );
      })}
    </div>
  );
});

/**
 * 실행 폴더 — 도구 행의 경로를 상대경로로 줄이는 데만 쓴다.
 *
 * ★실렌더 검증(2026-08-08)에서 잡힌 것: `stripCwdPrefix` 는 게이트에서 단독으로
 * 통과했는데, 정작 렌더러가 cwd 를 안 넘겨서 화면에는 절대경로가 그대로 나왔다.
 * 순수 함수 테스트만으로는 "호출부가 인자를 안 준다"를 못 잡는다.
 */
const WorkspaceRootContext = createContext<string | undefined>(undefined);

function messageGap(above: StreamMessage | undefined, below: StreamMessage): number {
  if (!above) return 0;
  // 같은 화자가 연달아 말하면 붙인다 — 한 사람의 여러 마디는 한 덩어리다.
  if (above.role === below.role) return above.role === "user" ? 4 : 8;
  // 시스템 고지는 앞뒤와 살짝 떨어져 자기 존재를 드러낸다.
  if (above.role === "system" || below.role === "system") return 14;
  // 사용자 → 에이전트: 답이 시작되는 자리라 가장 크게 연다.
  if (above.role === "user") return 20;
  return 16;
}

function toolGroupOf(detail: ToolCallDetail): ToolGroup {
  switch (detail.type) {
    case "shell":
      return "command";
    case "read":
      return "read";
    case "edit":
    case "write":
      return "edit";
    case "search":
    case "list":
      return "search";
    case "fetch":
      return "command";
    default:
      return "other";
  }
}
function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function BlinkingCursor() {
  return <span aria-hidden className="agentlas-chat-streaming-cursor" />;
}

function useElapsedSeconds(startedAt: number | undefined, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking || !startedAt) return;
    // 경과초 표시는 1초 단위라 250ms→1000ms로 낮춰 초당 setState 4회→1회.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking, startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}
