"use client";

import { BoundImageArtifacts } from "./BoundImageArtifacts";
import { scopedBoundImages } from "@/lib/bound-image-artifacts";
import { filePreviewEmptyMessage } from "@/lib/file-preview-reason";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { receiptAutoExpanded } from "@/lib/run-receipt-state";

/** 한 번에 그리는 활동 줄 수. 나머지는 "이전 N개 더 보기"로 이어 붙인다. */
const ACTIVITY_ROW_WINDOW = 120;
import {
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconCode,
  IconFileUp,
  IconMoreHorizontal,
  IconNetwork,
  IconPanelRight,
  IconPlus,
  IconRefresh,
  IconShield,
  IconSparkles,
} from "@/components/Icon";
import { TaskBrowser } from "@/components/browser/TaskBrowser";
import { RailAgentScreen } from "@/components/browser/RailAgentScreen";
import { agentScreenModeForTool } from "@/lib/agent-screen-mode";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { LiveOutputViewer, type LiveOutputKind } from "@/components/LiveOutputViewer";
import { CodeIdeViewer, isCodeArtifactName } from "@/components/CodeIdeViewer";
import { ipc } from "@/lib/ipc";
import {
  isWideOutputKind,
  outputPresentationKindForName,
  outputPresentationKindForViewerKind,
  type OutputPresentationKind,
} from "@/lib/output-presentation";
import { designOutputSurfaceProps, designSurfaceKindForOutput } from "@/lib/design-output-tokens";
import { isOneArtifactOpenRequest, ONE_ARTIFACT_OPEN_EVENT, requestOneArtifactOpen, type OneArtifactOpenRequest } from "@/lib/one-artifact-open";
import type { OneArtifactPreviewCapabilityV1 } from "@shared/one-artifacts";
import type { ComputerHistoryEntry, ComputerHistoryState } from "@shared/computer-history";
import type {
  OneActivityCode,
  OneActivityArtifact,
  OneActivityItem,
  OneActivitySource,
  OneActivityState,
} from "@/lib/one-activity";
import { buildToolCallDisplay, normalizeToolCall } from "@shared/tool-call-detail";
import { parseMcpResult } from "@shared/mcp-result-rendering";
import { isCommandTool, isComputerUseTool } from "@shared/tool-taxonomy";
import { toolFailureCopy } from "@shared/tool-failure";
import type { OnePermissionMode } from "../one/OneComposerControls";
import { OneComputerHistory } from "../one/OneComputerHistory";
import { McpResultPreview } from "../McpResultPreview";
import { ChatFileTabs, nextFileTabSelection } from "../ChatFileExperience";
import { CHAT_FILE_OPEN_EVENT, chatFilesBridge, formatChatFileSize, isChatFileItem, type ChatFileItem } from "@/lib/chat-files";
import { OneWorkerPanel } from "../one/OneWorkerPanel";
import type { OneWorkerPanelRun, OneWorkerPanelSelection } from "@/lib/one-worker-panel";
import styles from "./TaskSidePanel.module.css";

const ONE_OUTPUT_SECTIONS_STORAGE_KEY = "agentlas.one.output-sections.v1";
const ONE_OUTPUT_HISTORY_HEIGHT_STORAGE_KEY = "agentlas.one.output-history-height.v1";
type OutputSectionKey = "files" | "mcp" | "agents" | "processes" | "computer" | "sources";
type OutputRailView = "worker" | "result" | "activity" | "terminal" | "browser" | "screen";

/** 탭마다 제 아이콘 — 글자만 있으면 어느 탭인지 눈으로 못 고른다. */
function RailTabIcon({ view }: { view: OutputRailView }) {
  if (view === "browser") return <IconNetwork size={12} />;
  if (view === "screen") return <IconPanelRight size={12} />;
  if (view === "terminal") return <IconCode size={12} />;
  if (view === "result") return <IconCheck size={12} />;
  return <IconSparkles size={12} />;
}

function railTabLabel(view: OutputRailView, locale: "ko" | "en"): string {
  if (view === "worker") return locale === "ko" ? "서브에이전트" : "Subagent";
  if (view === "result") return locale === "ko" ? "결과" : "Result";
  if (view === "activity") return locale === "ko" ? "작업" : "Activity";
  if (view === "terminal") return locale === "ko" ? "터미널" : "Terminal";
  if (view === "screen") return locale === "ko" ? "화면" : "Screen";
  return locale === "ko" ? "브라우저" : "Browser";
}
function readCollapsedOutputSections(): Set<OutputSectionKey> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored = JSON.parse(window.localStorage.getItem(ONE_OUTPUT_SECTIONS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(stored)) return new Set();
    const allowed = new Set<OutputSectionKey>(["files", "mcp", "agents", "processes", "computer", "sources"]);
    return new Set(stored.filter((value): value is OutputSectionKey => typeof value === "string" && allowed.has(value as OutputSectionKey)));
  } catch {
    return new Set();
  }
}

function readOutputHistoryHeight(): number {
  if (typeof window === "undefined") return 250;
  const value = Number(window.localStorage.getItem(ONE_OUTPUT_HISTORY_HEIGHT_STORAGE_KEY));
  return Number.isFinite(value) ? Math.min(480, Math.max(150, Math.round(value))) : 250;
}

function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function useElapsed(startedAt: number | null, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt == null) return;
    // The component stays mounted against an older assistant message while a
    // new One turn begins. Resetting only on the busy edge retained the prior
    // run's `now`, making a fresh optimistic start appear minutes old until
    // the next timer tick.
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return startedAt == null ? "" : elapsedLabel(Math.max(0, now - startedAt));
}

function phaseLabel(phase: OneActivityItem["phase"], locale: "ko" | "en"): string {
  if (phase === "plan") return locale === "ko" ? "계획" : "Planning";
  if (phase === "delegate") return locale === "ko" ? "위임" : "Delegating";
  if (phase === "synthesize") return locale === "ko" ? "종합" : "Synthesizing";
  return locale === "ko" ? "작업" : "Working";
}

function agentStateLabel(item: OneActivityItem, locale: "ko" | "en"): string {
  if (item.status === "completed") return locale === "ko" ? "완료" : "Completed";
  if (item.status === "cancelled") return locale === "ko" ? "취소됨" : "Cancelled";
  if (item.status === "failed") return locale === "ko" ? "중단" : "Stopped";
  return phaseLabel(item.phase, locale);
}

function activityCodeLabel(code: OneActivityCode | undefined, locale: "ko" | "en"): string {
  if (code === "runtime_wait") return locale === "ko" ? "실행 결과를 기다리는 중…" : "Waiting for runtime output…";
  if (code === "queue_wait") return locale === "ko" ? "차례를 기다리는 중…" : "Waiting in queue…";
  if (code === "recovery_retry") return locale === "ko" ? "중단된 단계를 다시 시도하는 중…" : "Retrying a blocked step…";
  if (code === "goal_pass_retry") return locale === "ko" ? "실패한 턴을 잠시 뒤 다시 시도하는 중…" : "Retrying the failed pass shortly…";
  if (code === "session_resume") return locale === "ko" ? "이전 실행을 이어가는 중…" : "Resuming the previous run…";
  return "";
}

const HANGUL_PATTERN = /[\u3131-\u318e\uac00-\ud7a3]/;

/**
 * Runtime identities can come from old local installs whose English column was
 * populated with a mixed Korean label. English chrome must never echo that
 * stale localization. For names only, retain a real Latin prefix (for example
 * `Agentlas One 오케스트레이터` -> `Agentlas One`); roles and status prose fall
 * back to the typed English label owned by this component.
 */
function localeSafeRuntimeText(
  value: string | undefined,
  locale: "ko" | "en",
  keepLatinPrefix = false,
): string {
  const clean = value?.trim() ?? "";
  if (!clean || locale === "ko" || !HANGUL_PATTERN.test(clean)) return clean;
  if (!keepLatinPrefix) return "";
  const firstHangul = clean.search(HANGUL_PATTERN);
  return clean.slice(0, firstHangul).replace(/[\s·:()\-–—/]+$/g, "").trim();
}

function itemIcon(item: OneActivityItem) {
  if (item.status === "completed") return <IconCheck size={13} />;
  if (item.kind === "tool") return <IconCode size={13} />;
  if (item.kind === "notice") return <IconShield size={13} />;
  return <IconSparkles size={13} />;
}

function toolPresentation(item: OneActivityItem, locale: "ko" | "en", workspacePath: string | null) {
  const tool = item.tool;
  if (!tool) return null;
  const detail = normalizeToolCall({
    name: tool.name,
    args: tool.args,
    result: tool.result,
    cwd: workspacePath ?? undefined,
  });
  return buildToolCallDisplay({
    name: tool.name,
    detail,
    status: item.status === "info"
      ? undefined
      : item.status === "cancelled"
        ? "canceled"
        : item.status === "cancelling"
          ? "running"
          : item.status,
    errorText: tool.isError ? tool.result : undefined,
    locale,
  });
}

/**
 * Codex-style activity keeps the row scannable: a terminal command is evidence
 * available on expand, not the primary status itself. Raw shell strings often
 * include a whole heredoc, private cache paths, and chained commands, which
 * previously made a single Activity row overflow the conversation column.
 */
function conciseShellSummary(command: string, locale: "ko" | "en"): string {
  const value = command.toLowerCase();
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run|test|exec)\b|\b(?:validate|verify|test)[:\s-]/.test(value)) {
    return locale === "ko" ? "프로젝트 검사 실행" : "Run project checks";
  }
  if (/\b(?:sed|cat|head|tail|rg|grep|find|ls)\b/.test(value)) {
    return locale === "ko" ? "로컬 파일 확인" : "Inspect local files";
  }
  if (/\b(?:apply_patch|mkdir|touch|cp|mv)\b/.test(value)) {
    return locale === "ko" ? "로컬 파일 업데이트" : "Update local files";
  }
  if (/\b(?:hephaestus|stormbreaker)\b/.test(value)) {
    return locale === "ko" ? "Stormbreaker 준비" : "Prepare Stormbreaker";
  }
  return locale === "ko" ? "로컬 명령 실행" : "Run local command";
}

function activityToolSummary(
  item: OneActivityItem,
  presentation: ReturnType<typeof toolPresentation>,
  locale: "ko" | "en",
): string {
  if (!presentation) return "";
  const normalizedName = item.tool?.name.trim().toLowerCase() ?? "";
  if (/^(?:bash|shell|run_command|exec|execute|run_terminal_cmd|local_shell|terminal)$/.test(normalizedName)) {
    // `normalizeToolCall` has already extracted the command from runner-specific
    // JSON arguments. Prefer it over an often-empty wrapper argument object.
    return conciseShellSummary(presentation.summary || item.tool?.args || "", locale);
  }
  return presentation.summary ?? "";
}

function activityToolPrimary(
  item: OneActivityItem,
  presentation: ReturnType<typeof toolPresentation>,
  locale: "ko" | "en",
): string | null {
  const normalizedName = item.tool?.name.trim().toLowerCase() ?? "";
  // Some Codex hosts expose only `mcp_tool_call` as the provider envelope and
  // deliberately omit the private tool arguments from the durable ledger.
  // Showing the internal envelope verbatim is neither an action a person can
  // understand nor a useful Activity status. Keep the evidence row, but use a
  // truthful product label that does not pretend we know which private tool
  // was called.
  if (/^(?:mcp[_. -]*tool[_. -]*call|custom_tool_call)$/.test(normalizedName)) {
    return locale === "ko" ? "연결된 도구 사용" : "Use connected tool";
  }
  return presentation?.displayName ?? null;
}

function ActivityRow({
  item,
  locale,
  workspacePath,
}: {
  item: OneActivityItem;
  locale: "ko" | "en";
  workspacePath: string | null;
}) {
  const tool = toolPresentation(item, locale, workspacePath);
  const safeAgentName = localeSafeRuntimeText(item.agentName, locale, true);
  const safeRole = localeSafeRuntimeText(item.role, locale);
  const safeMessage = localeSafeRuntimeText(item.noticeI18n?.[locale] ?? item.message, locale);
  const typedActivityMessage = activityCodeLabel(item.activityCode, locale);
  const primary = activityToolPrimary(item, tool, locale)
    || (item.kind === "run"
      ? item.status === "running"
        ? item.activityCode === "queue_wait"
          ? (locale === "ko" ? "차례를 기다리는 중" : "Waiting in queue")
          : (locale === "ko" ? "작업 중" : "Working")
        : item.status === "cancelling"
          ? (locale === "ko" ? "중지하는 중" : "Stopping")
        : item.status === "cancelled"
          ? (locale === "ko" ? "작업 취소됨" : "Run cancelled")
        : item.status === "failed"
          ? (locale === "ko" ? "작업 중단" : "Run stopped")
          : (locale === "ko" ? "작업 완료" : "Completed")
      : item.kind === "reasoning"
      ? item.status === "running"
        ? (locale === "ko" ? "생각 중" : "Thinking")
        : (locale === "ko" ? "생각" : "Thought")
      : item.kind === "agent"
        ? (safeAgentName || (locale === "ko" ? "에이전트" : "Agent"))
        : item.kind === "result"
          ? item.status === "running"
            ? (locale === "ko" ? "답변 작성 중" : "Writing answer")
            : item.answerChars != null
              ? item.status === "completed"
                ? (locale === "ko" ? "답변 작성됨" : "Answer written")
                : (locale === "ko" ? "답변 중단" : "Answer stopped")
              : (locale === "ko" ? "결과 준비됨" : "Result ready")
          : item.kind === "terminal"
            ? item.status === "cancelled"
              ? (locale === "ko" ? "실행 취소됨" : "Run cancelled")
              : item.status === "failed"
              ? (locale === "ko" ? "실행 중단" : "Run stopped")
              : (locale === "ko" ? "실행 완료" : "Run completed")
            : typedActivityMessage || safeMessage || (locale === "ko" ? "알림" : "Notice"));
  const toolSummary = activityToolSummary(item, tool, locale);
  const toolOwner = item.kind === "tool"
    ? [safeAgentName, safeRole].filter(Boolean).join(" · ")
    : "";
  const toolFailure = item.kind === "tool" ? toolFailureCopy(item.tool?.failureCode, locale) : null;
  const secondary = [toolFailure ?? toolFailureCopy(item.failureCode, locale) ?? toolSummary, toolOwner].filter(Boolean).join(" · ")
    || (item.kind === "agent" ? [safeRole, agentStateLabel(item, locale)].filter(Boolean).join(" · ") : "")
    || (item.kind === "reasoning" && item.durationMs != null ? elapsedLabel(item.durationMs) : "")
    || (item.kind === "run" && item.durationMs != null ? elapsedLabel(item.durationMs) : "")
    || (item.kind === "result" && item.answerChars != null
      ? (locale === "ko" ? `${item.answerChars.toLocaleString()}자` : `${item.answerChars.toLocaleString()} chars`)
      : "")
    || (item.kind === "terminal" ? safeMessage : "");
  const facts = tool?.facts;
  const detail = item.detail || tool?.errorText || (item.tool
    ? [item.tool.args, item.tool.result].filter(Boolean).join("\n")
    : "");

  const content = (
    <>
      <span className={styles.rowIcon} data-status={item.status}>{itemIcon(item)}</span>
      <span className={styles.rowCopy}>
        <strong>{primary}</strong>
        {secondary && <span title={item.kind === "tool" && tool?.displayName === (locale === "ko" ? "실행" : "Shell") ? undefined : secondary}>{secondary}</span>}
      </span>
      {facts && <small>{facts}</small>}
      {item.status === "running" && <span className={styles.liveDot} aria-hidden="true" />}
    </>
  );

  if (!detail) {
    return <div className={styles.row} data-kind={item.kind} data-status={item.status} data-failure-code={item.tool?.failureCode}>{content}</div>;
  }
  return (
    <details className={styles.rowDetails} data-kind={item.kind} data-status={item.status} data-failure-code={item.tool?.failureCode}>
      <summary className={styles.row}>{content}<IconChevronDown size={12} /></summary>
      <pre>{detail}</pre>
    </details>
  );
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function OneActivityTimeline({
  state,
  busy,
  preparing = false,
  startedAt,
  permission,
  workspacePath,
  locale,
}: {
  state: OneActivityState;
  busy: boolean;
  /**
   * A request can be in Main's real preflight before an invocation/run id
   * exists. Keep that phase visibly distinct from a runtime run: it has no
   * emitted events, no inferred progress and must never borrow the previous
   * run's Activity or elapsed clock.
   */
  preparing?: boolean;
  startedAt: number | null;
  permission: OnePermissionMode;
  workspacePath: string | null;
  locale: "ko" | "en";
}) {
  const active = busy || preparing;
  const [expanded, setExpanded] = useState(active);
  /*
   * ★증거는 다 갖되, 한 번에 다 그리지는 않는다 (오너 실사용 2026-09-08: "48G 맥에서 렉").
   *
   * 실측: 오너 저장소의 한 대화에 실행 이벤트 21,412개, **한 실행에 6,725개**가 붙어 있다.
   * 이 목록은 상한이 없다 — 예전에 12개에서 조용히 잘라 긴 실행을 감사할 수 없게 만든
   * 적이 있어 일부러 뺐다. 그 판단은 옳았다. 문제는 **조용히 버린 것**이었지 상한 자체가
   * 아니었다.
   *
   * 그래서 버리지 않고 **최근 것부터 창 단위로** 그린다. 나머지는 사라진 게 아니라 한 번
   * 더 누르면 나오고, 몇 개가 더 있는지 그 단추가 말한다. DOM 은 작고 증거는 그대로다.
   */
  const [shownRows, setShownRows] = useState(ACTIVITY_ROW_WINDOW);
  const liveElapsed = useElapsed(startedAt, active);
  const settledDurationMs = useMemo(
    () => state.items.find((item) => item.kind === "run" && item.durationMs != null)?.durationMs,
    [state.items],
  );
  // A settled run must display the immutable runtime duration. Reusing
  // Date.now() after a remount made completed Activity headers keep aging.
  const elapsed = busy
    ? liveElapsed
    : settledDurationMs != null
      ? elapsedLabel(settledDurationMs)
      : liveElapsed;
  // Keep the complete typed run history inspectable. A previous presentation
  // cap silently discarded early tool and reasoning rows after item 12, which
  // made long runs impossible to audit. The rows container owns bounded
  // scrolling instead of deleting evidence from the UI.
  const visible = useMemo(() => {
    if (busy) {
      // The lifecycle row's live label is the generic "Working". While a
      // specific row (tool, thought, answer) is already running, that generic
      // line is a second spinner saying nothing — drop it until it settles
      // and can report the run duration.
      const specificRunning = state.items.some((item) => item.kind !== "run" && item.status === "running");
      return specificRunning
        ? state.items.filter((item) => !(item.kind === "run" && item.status === "running"))
        : state.items;
    }
    // The lifecycle row starts first but completes last. Keeping it at array
    // position zero made settled Activity read "Completed" before "Thought",
    // reversing the visible causal order. Terminal run summary belongs last.
    return [
      ...state.items.filter((item) => item.kind !== "run"),
      ...state.items.filter((item) => item.kind === "run"),
    ];
  }, [busy, state.items]);
  /*
   * ★ 끝난 작업은 접힌다 — One 설계는 실행 중엔 펼쳐 보여 주고, 끝나면 "27초 동안 작업 ›"
   * 한 줄로 접히는 것이다. 그런데 여기엔 펼치는 쪽만 있고 접는 쪽이 없어서, 한 번 펼쳐진
   * 활동 블록이 대화 내내 그대로 남았다. 턴이 쌓일수록 화면이 활동 로그로 덮인다.
   *
   * 접을지 말지의 판정은 이미 renderer/lib/run-receipt-state.ts 에 있었는데 **부르는 곳이
   * 하나도 없었다.** Work 전용 영수증 카드를 이 타임라인으로 합칠 때(97df0295) 판정만
   * 남고 호출이 사라진 것이다. 그 함수를 다시 부른다 — 실패·취소는 펼친 채 남고
   * (복구할 것이 있다), 완료만 접힌다.
   *
   * deps 가 active 와 terminalStatus 뿐이라, 사람이 손으로 다시 펼친 것은 그대로 남는다.
   */
  useEffect(() => {
    const next = receiptAutoExpanded(active, active ? "running" : state.terminalStatus);
    if (next !== null) setExpanded(next);
  }, [active, state.terminalStatus]);
  if (!active && visible.length === 0) return null;
  const liveStatus = preparing
    ? (locale === "ko" ? "실행 준비 중" : "Preparing execution")
    : busy
    ? (locale === "ko" ? "작업 진행 중" : "Run in progress")
    : state.terminalStatus === "cancelled"
      ? (locale === "ko" ? "작업 취소됨" : "Run cancelled")
      : state.terminalStatus === "failed"
        ? (locale === "ko" ? "작업 중단" : "Run stopped")
        : (locale === "ko" ? "작업 완료" : "Run completed");
  const heading = locale === "ko" ? "활동" : "Activity";
  // This is an execution summary, not a second composer. Permission, token
  // usage, and workspace identity stay at their point of control so an old
  // Activity row cannot look like it is changing the next prompt's settings.
  const summary = elapsed ? `${liveStatus} · ${elapsed}` : liveStatus;

  return (
    <section
      {...designOutputSurfaceProps("report", styles.activity)}
      data-one-activity="true"
      data-state={preparing ? "preparing" : busy ? "running" : "settled"}
      data-permission={state.selectedPermissionMode ?? permission}
      aria-busy={active}
    >
      <span className={styles.srOnly} role="status" aria-live="polite">{liveStatus}</span>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className={styles.pulse} data-active={active ? "true" : "false"} aria-hidden="true" />
        <strong>{heading}</strong>
        <span className={styles.meta}>{summary}</span>
        <span className={styles.count}>{!preparing && visible.length > 0 ? (locale === "ko" ? `${visible.length}개 이벤트` : `${visible.length} events`) : ""}</span>
        <span className={styles.chevron} aria-hidden="true"><IconChevronDown size={13} /></span>
      </button>
      {active && <div className={styles.activityEta}><LoadingEstimate locale={locale} operationKey={preparing ? "one-run-prepare" : "one-run-execution"} startedAt={startedAt} expectedSeconds={preparing ? [2, 45] : [30, 600]} /></div>}
      {expanded && visible.length > 0 && (
        <div className={styles.rows}>
          {visible.length > shownRows && (
            <button
              type="button"
              className={styles.moreRows}
              onClick={() => setShownRows((current) => current + ACTIVITY_ROW_WINDOW * 2)}
            >
              {locale === "ko"
                ? `이전 ${visible.length - shownRows}개 더 보기`
                : `Show ${visible.length - shownRows} earlier`}
            </button>
          )}
          {visible.slice(-shownRows).map((item) => (
            <ActivityRow key={item.id} item={item} locale={locale} workspacePath={workspacePath} />
          ))}
        </div>
      )}
    </section>
  );
}

function openArtifact(item: OneActivityArtifact): void {
  requestOneArtifactOpen({ binding: item.binding, label: item.label });
}

function liveKindForCapability(capability: OneArtifactPreviewCapabilityV1): LiveOutputKind {
  if (capability.kind === "document") {
    if (capability.mimeType === "application/pdf") return "pdf";
    if (/presentation|powerpoint/i.test(capability.mimeType)) return "presentation";
    return "document";
  }
  return capability.kind;
}

function ArtifactPreviewCard({ item, locale, wide = false }: { item: OneActivityArtifact; locale: "ko" | "en"; wide?: boolean }) {
  const [preview, setPreview] = useState<OneArtifactPreviewCapabilityV1 | null>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const bridge = ipc();
    if (!bridge?.oneArtifacts?.issuePreview) {
      setSettled(true);
      return;
    }
    let disposed = false;
    let issued: OneArtifactPreviewCapabilityV1 | null = null;
    setPreview(null);
    setSettled(false);
    void bridge.oneArtifacts.issuePreview(item.binding)
      .then((capability) => {
        if (disposed) {
          if (capability) void bridge.oneArtifacts.revokePreview({ ...item.binding, capabilityUrl: capability.capabilityUrl }).catch(() => ({ revoked: false }));
          return;
        }
        issued = capability;
        setPreview(capability);
        setSettled(true);
      })
      .catch(() => setSettled(true));
    return () => {
      disposed = true;
      if (issued) void bridge.oneArtifacts.revokePreview({ ...item.binding, capabilityUrl: issued.capabilityUrl }).catch(() => ({ revoked: false }));
    };
  }, [item.binding, item.id]);

  return <article className={styles.artifactPreviewCard} data-preview-kind={preview?.kind ?? "file"}>
    {preview && <div className={`${styles.artifactVisual} ${preview.kind === "audio" ? styles.artifactAudio : ""}`}>
      {preview.kind === "data" && isCodeArtifactName(item.label)
        ? <CodeIdeViewer source={preview.capabilityUrl} name={item.label} locale={locale} compact={!wide} />
        : <LiveOutputViewer source={preview.capabilityUrl} name={item.label} kind={liveKindForCapability(preview)} mimeType={preview.mimeType} size={preview.sizeBytes} locale={locale} compact={!wide} placement="sidebar" />}
    </div>}
    {!preview && <div className={styles.artifactFileFallback} data-loading={!settled ? "true" : "false"}><IconFileUp size={18} /></div>}
    <div className={styles.artifactPreviewCopy}>
      <span><strong>{item.label}</strong><small>{preview
        ? `${preview.mimeType} · ${Math.max(1, Math.round(preview.sizeBytes / 1024))} KB`
        : settled ? (locale === "ko" ? "파일" : "File") : (locale === "ko" ? "미리보기 준비 중…" : "Preparing preview…")}</small></span>
      <button type="button" onClick={() => void openArtifact(item)}>{locale === "ko" ? "열기" : "Open"}</button>
    </div>
  </article>;
}

function ArtifactOpenViewer({ target, locale, wide }: { target: OneArtifactOpenRequest; locale: "ko" | "en"; wide: boolean }) {
  const [capability, setCapability] = useState<OneArtifactPreviewCapabilityV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const binding = target.binding;
  const issue = useCallback(() => {
    const bridge = ipc();
    if (!bridge?.oneArtifacts?.issuePreview) {
      setCapability(null);
      setLoading(false);
      setFailed(true);
      return;
    }
    setLoading(true);
    setFailed(false);
    void bridge.oneArtifacts.issuePreview(binding)
      .then((next) => {
        setCapability(next);
        setLoading(false);
        setFailed(!next);
      })
      .catch(() => {
        setCapability(null);
        setLoading(false);
        setFailed(true);
      });
  }, [binding]);
  useEffect(() => {
    let issued: OneArtifactPreviewCapabilityV1 | null = null;
    const bridge = ipc();
    if (bridge?.oneArtifacts?.issuePreview) {
      setLoading(true);
      setFailed(false);
      void bridge.oneArtifacts.issuePreview(binding)
        .then((next) => {
          issued = next;
          setCapability(next);
          setLoading(false);
          setFailed(!next);
        })
        .catch(() => {
          setCapability(null);
          setLoading(false);
          setFailed(true);
        });
    } else {
      setCapability(null);
      setLoading(false);
      setFailed(true);
    }
    return () => {
      // The capability is intentionally short-lived and Main revalidates every
      // read. There is no path or OS-open escape from this viewer.
      if (issued) void bridge?.oneArtifacts?.revokePreview({ ...binding, capabilityUrl: issued.capabilityUrl }).catch(() => ({ revoked: false }));
    };
  // Binding fields, not object identity, define the exact capability scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding.taskId, binding.taskVersion, binding.chatId, binding.runId, binding.manifestId, binding.artifactRef]);

  if (loading) return <div className={styles.artifactFileFallback} data-loading="true" role="status">{locale === "ko" ? "파일을 여는 중…" : "Opening artifact…"}</div>;
  if (failed || !capability) return <div className={styles.artifactFileFallback} role="alert"><span>{locale === "ko" ? "아티팩트를 인앱에서 열지 못했습니다." : "This artifact could not be opened in the app."}</span><button type="button" onClick={issue}>{locale === "ko" ? "다시 시도" : "Retry"}</button></div>;
  return capability.kind === "data" && isCodeArtifactName(target.label)
    ? <CodeIdeViewer source={capability.capabilityUrl} name={target.label} locale={locale} fill={wide} />
    : <LiveOutputViewer source={capability.capabilityUrl} name={target.label} kind={liveKindForCapability(capability)} mimeType={capability.mimeType} size={capability.sizeBytes} locale={locale} fill placement="sidebar" />;
}

function ChatFileOpenViewer({ file, locale, onExpand }: { file: ChatFileItem; locale: "ko" | "en"; onExpand?: () => void }) {
  const preview = file.viewer;
  const liveKinds = new Set<LiveOutputKind>(["image", "video", "audio", "pdf", "document", "spreadsheet", "presentation", "archive"]);
  const liveKind = liveKinds.has(preview.viewerKind as LiveOutputKind) ? preview.viewerKind as LiveOutputKind : null;
  const kindLabel = file.kind === "directory"
    ? (locale === "ko" ? "폴더" : "Folder")
    : (file.name.trim().match(/\.([a-z0-9]+)$/iu)?.[1]?.toUpperCase() ?? preview.viewerKind.toUpperCase());
  return <div data-chat-file-viewer="true" data-chat-file-tab-id={file.tabId} style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
    {!liveKind && <div data-chat-file-header="true" style={{ display: "grid", gap: 2, padding: "8px 10px", borderBottom: "1px solid var(--paper-edge)", fontSize: 10.5, color: "var(--muted-deep)" }}>
      <strong style={{ color: "var(--ink)", overflowWrap: "anywhere" }}>{file.name}</strong>
      <span>{file.kind === "directory" ? kindLabel : `${formatChatFileSize(file.size)} · ${kindLabel}`}</span>
      <details data-chat-file-info="true" style={{ marginTop: 2 }}>
        <summary style={{ cursor: "pointer", width: "fit-content", color: "var(--muted-deep)", userSelect: "none" }}>
          {locale === "ko" ? "파일 정보" : "File info"}
        </summary>
        <div style={{ display: "grid", gap: 2, marginTop: 4, paddingLeft: 10, overflowWrap: "anywhere" }}>
          <span>SHA-256: {file.sha256}</span>
          <span>{locale === "ko" ? "바인딩" : "Binding"}: {file.chatId}/{file.groupId}/{file.id}</span>
          <span>{locale === "ko" ? "탭 ID" : "Tab ID"}: {file.tabId}</span>
        </div>
      </details>
    </div>}
    <div style={{ minHeight: 0, flex: 1, overflow: liveKind ? "hidden" : "auto" }}>
      {file.kind === "directory" || ["markdown", "json", "text"].includes(preview.viewerKind) ? (
        <pre style={{ margin: 0, padding: 12, fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview.content || filePreviewEmptyMessage(preview.reason, locale, preview.name, preview.path)}</pre>
      ) : liveKind && file.fileUrl ? (
        <LiveOutputViewer
          source={file.fileUrl}
          name={file.name}
          kind={liveKind}
          mimeType={file.mediaType}
          size={file.size}
          locale={locale}
          fill
          placement="sidebar"
          onExpand={onExpand}
          onOpenExternal={file.kind === "file" ? async () => {
            const bridge = chatFilesBridge();
            if (!bridge?.openExternal) throw new Error("chat-file-open-unavailable");
            const result = await bridge.openExternal({ chatId: file.chatId, groupId: file.groupId, id: file.id, sha256: file.sha256 });
            if (!result.ok) throw new Error(result.message || "chat-file-open-failed");
          } : undefined}
          openExternalHint={locale === "ko" ? "검증된 읽기 전용 임시 사본 열기" : "Open a verified, temporary read-only copy"}
          fileInfo={{ sha256: file.sha256, binding: `${file.chatId}/${file.groupId}/${file.id}`, tabId: file.tabId }}
        />
      ) : (
        <div role="alert" style={{ padding: 16, fontSize: 12, color: "var(--red-deep)" }}>
          {locale === "ko" ? "이 형식은 인앱 미리보기를 지원하지 않습니다. 원본 경로를 저장하지 않아 Finder 열기는 제공되지 않습니다." : "This format has no in-app preview. Finder is unavailable because the original path is not retained."}
        </div>
      )}
    </div>
  </div>;
}

/**
 * A browser navigation can legitimately end at a deep app route, but a tool
 * may also navigate to an implementation asset while inspecting a page. The
 * latter must not become the Browser rail's app URL: loading `/src/main.js`
 * as a document produces a misleading blank/offline preview.
 */
export function isBrowserDocumentUrl(value: string): value is string {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) return false;
    const pathname = decodeURIComponent(parsed.pathname);
    return !/\.(?:m?js|cjs|css|map|json|wasm|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|mp[34]|webm|zip)$/iu.test(pathname);
  } catch {
    return false;
  }
}

export function taskBrowserUrl(items: OneActivityItem[]): string | undefined {
  for (const item of [...items].reverse()) {
    if (item.kind !== "tool" || !item.tool?.args || item.tool.isError) continue;
    const toolName = item.tool.name ?? "";
    const isExactNavigation = /browser.*navigate/iu.test(toolName);
    // Runs written before exact MCP attribution was repaired contain only the
    // Codex envelope name. Recover those durable Taskforce events narrowly:
    // the completed result must itself prove a browser navigation. An
    // arbitrary MCP call that happens to accept a URL must never claim the
    // Browser rail.
    const isLegacyProvenNavigation = toolName === "mcp_tool_call"
      && typeof item.tool.result === "string"
      && /(?:\bpage\.goto\b|\bpage url\s*:|\bnavigat(?:e|ed|ing)\b[^\n]{0,160}https?:\/\/)/iu.test(item.tool.result);
    if (!isExactNavigation && !isLegacyProvenNavigation) continue;
    try {
      const value = JSON.parse(item.tool.args) as { url?: unknown };
      if (typeof value.url !== "string") continue;
      if (isBrowserDocumentUrl(value.url)) return new URL(value.url).toString();
    } catch {
      // Tool arguments are untrusted runtime text. Invalid JSON/URLs are not a browser source.
    }
  }
  return undefined;
}

/**
 * A generated web app is a first-class One output, not an artifact link.
 * Work and One share the same main-owned loopback preview runtime; this
 * descriptor only carries the verified app identity and URL to the rail.
 */
export interface OneLiveAppPreview {
  appId: string;
  title: string;
  url: string;
  runtime?: string;
}

function OutputDisclosure({
  section,
  label,
  count,
  expanded,
  onToggle,
  children,
}: {
  section: OutputSectionKey;
  label: string;
  count?: number;
  expanded: boolean;
  onToggle: (section: OutputSectionKey) => void;
  children?: React.ReactNode;
}) {
  return (
    <section className={styles.artifactSection} data-output-section={section}>
      <button
        type="button"
        className={styles.artifactSectionToggle}
        aria-expanded={expanded}
        onClick={() => onToggle(section)}
      >
        <span>{label}</span>
        {typeof count === "number" && <strong>{count}</strong>}
        <span className={styles.artifactSectionChevron} aria-hidden="true"><IconChevronDown size={13} /></span>
      </button>
      {expanded && children && <div className={styles.artifactSectionBody}>{children}</div>}
    </section>
  );
}

export type TaskSidePanelProps = {
  workerSelection?: OneWorkerPanelSelection | null;
  workerRun?: OneWorkerPanelRun | null;
  onCloseWorker?: () => void;
  items: OneActivityArtifact[];
  activity?: OneActivityState;
  locale: "ko" | "en";
  visible?: boolean;
  onAdd?: () => void;
  onClose?: () => void;
  /** Current rail width in px; the shell owns and persists it. */
  width?: number;
  /** Drag/keyboard resize — the shell clamps and persists. Absent = fixed width. */
  onResize?: (width: number) => void;
  /** Temporary readability correction; unlike a drag resize this is not persisted. */
  onRequestReadableWidth?: (width: number) => void;
  /** Restore the person's saved width after a temporary file view is closed. */
  onRestorePreferredWidth?: () => void;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  computerHistory?: ComputerHistoryState | null;
  onHistoryConsent?: (enabled: boolean) => Promise<void>;
  onHistoryClear?: () => void;
  onHistoryAsk?: () => void;
  onHistoryReviewRecommendation?: (entry: ComputerHistoryEntry) => void;
  /** Exact current chat used to keep captured agent screens task-scoped. */
  onRequestOpen?: () => void;
  screenChatId: string | null;
  /** Stable Taskforce/thread identity used to retain only its own browser URL across turns. */
  browserScopeKey?: string;
  /** Latest proven Browser navigation from this thread's durable run history. */
  browserHistoryUrl?: string;
  /** Browser URL carried by the current result preview; live URLs belong in Browser. */
  browserPreviewUrl?: string;
  /** Present the scoped Browser rail when this thread observes a real navigation. */
  onBrowserObserved?: (url: string) => void;
  /** The structured/live result retained in both chat and this in-app rail. */
  result?: ReactNode;
  /** Stable identity used to present a newly arrived result automatically. */
  resultKey?: string | null;
  /** Result kind drives the same comfortable in-app width for map/media/docs/code. */
  resultKind?: OutputPresentationKind;
  /** A generated web app that is already reachable on its verified preview URL. */
  appPreview?: OneLiveAppPreview | null;
};

/** Task-local view state belongs to this exact thread and chat pair. */
export function TaskSidePanel(props: TaskSidePanelProps) {
  useEffect(() => {
    if (!props.screenChatId) return;
    // Register the exact task owner even while its browser tab is folded.
    void ipc()?.workLiveView?.listTabs({ taskScopeId: props.screenChatId }).catch(() => undefined);
  }, [props.screenChatId]);
  return <TaskSidePanelContent key={JSON.stringify([props.browserScopeKey ?? null, props.screenChatId])} {...props} />;
}

function TaskSidePanelContent({
  items,
  activity,
  locale,
  visible = items.length > 0,
  onAdd,
  onClose,
  width,
  onResize,
  onRequestReadableWidth,
  onRestorePreferredWidth,
  minWidth = 200,
  maxWidth = 720,
  defaultWidth = 324,
  computerHistory,
  onHistoryConsent,
  onHistoryClear,
  onHistoryAsk,
  onHistoryReviewRecommendation,
  screenChatId,
  onRequestOpen,
  browserScopeKey,
  browserHistoryUrl,
  browserPreviewUrl,
  onBrowserObserved,
  result,
  resultKey,
  resultKind = "standard",
  appPreview,
  workerSelection,
  workerRun,
  onCloseWorker,
}: TaskSidePanelProps) {
  const [collapsedSections, setCollapsedSections] = useState<Set<OutputSectionKey>>(readCollapsedOutputSections);
  /*
   * 탭은 고정 목록이 아니다(오너 지시 2026-08-24). 무언가 결과가 나오면 그
   * 탭이 하나 생기고, 나머지는 + 로 사람이 직접 연다. 아무것도 안 한 대화에서
   * "결과 / Activity / Terminal / Browser" 네 개가 늘 떠 있을 이유가 없다.
   */
  const [openTabs, setOpenTabs] = useState<OutputRailView[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [browserHeaderHost, setBrowserHeaderHost] = useState<HTMLDivElement | null>(null);
  const [browserNewTabRequest, setBrowserNewTabRequest] = useState(0);
  const [railView, setRailView] = useState<OutputRailView | null>(null);
  /*
   * 브라우저와 앱은 좁은 칸에서 아무것도 못 읽는다(실측 324px 에서 페이지가
   * 찌그러졌다). 그 탭을 실제로 보기 시작할 때만 읽을 수 있는 폭을 확보한다 —
   * 결과가 생길 때마다 저 혼자 벌어지던 예전 동작과는 다르다.
   */
  const selectRailView = useCallback((view: OutputRailView) => {
    setRailView(view);
    if (view !== "browser") return;
    const readable = Math.min(maxWidth, 560);
    (onRequestReadableWidth ?? onResize)?.(Math.max(width ?? defaultWidth, readable));
  }, [defaultWidth, maxWidth, onRequestReadableWidth, onResize, width]);
  const openRailTab = useCallback((view: OutputRailView) => {
    setOpenTabs((tabs) => (tabs.includes(view) ? tabs : [...tabs, view]));
    selectRailView(view);
  }, [selectRailView]);
  const nativeBrowserObservedRef = useRef(onBrowserObserved);
  nativeBrowserObservedRef.current = onBrowserObserved;
  const [presentedBrowser, setPresentedBrowser] = useState<{ viewId: string; id: string }>();
  useEffect(() => {
    if (!screenChatId) return;
    let disposed = false;
    let latestPresentation: string | null = null;
    const api = ipc();
    const off = api?.workLiveView?.onStatus((status) => {
      const presentation = status.presentation;
      if (status.taskScopeId !== screenChatId || !presentation?.id || !presentation.runId
        || !status.url || status.state === "closed" || latestPresentation === presentation.id) return;
      latestPresentation = presentation.id;
      // Main's live invocation is authoritative, including nested worker actions.
      // Never reopen another run's historical tab or a completed/cancelled run.
      void api.invoke.attach(screenChatId, { includeEvents: false }).then((attached) => {
        if (disposed || latestPresentation !== presentation.id || attached?.runId !== presentation.runId || !status.url) return;
        setPresentedBrowser({ viewId: status.viewId, id: presentation.id });
        openRailTab("browser");
        nativeBrowserObservedRef.current?.(status.url);
      }).catch(() => undefined);
    });
    return () => { disposed = true; off?.(); };
  }, [screenChatId, openRailTab]);
  const closeRailTab = useCallback((view: OutputRailView) => {
    setOpenTabs((tabs) => {
      const next = tabs.filter((tab) => tab !== view);
      setRailView((current) => (current === view ? next[next.length - 1] ?? null : current));
      return next;
    });
  }, []);
  const workerKey = workerSelection?.chatId === screenChatId
    ? JSON.stringify([workerSelection.chatId, workerSelection.runId, workerSelection.agentId]) : null;
  const presentedWorkerRef = useRef<string | null>(null);
  const workerReturnViewRef = useRef<OutputRailView | null>(null);
  const railViewRef = useRef(railView);
  railViewRef.current = railView;
  useEffect(() => {
    if (workerKey) {
      if (railViewRef.current !== "worker") workerReturnViewRef.current = railViewRef.current;
      setOpenTabs((tabs) => tabs.includes("worker") ? tabs : [...tabs, "worker"]);
      setRailView("worker");
    } else if (!workerKey && presentedWorkerRef.current) {
      closeRailTab("worker");
    }
    presentedWorkerRef.current = workerKey;
  }, [workerKey, workerSelection, closeRailTab]);
  const closeWorkerTab = () => {
    const next = openTabs.filter((tab) => tab !== "worker");
    setOpenTabs(next);
    const previous = workerReturnViewRef.current;
    setRailView(previous && previous !== "worker" && next.includes(previous)
      ? previous : next.at(-1) ?? null);
    onCloseWorker?.();
  };
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; rawWidth: number } | null>(null);
  const historyResizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [collapseReady, setCollapseReady] = useState(false);
  const [historyResizing, setHistoryResizing] = useState(false);
  const [historyHeight, setHistoryHeight] = useState(readOutputHistoryHeight);
  const [browserUrlsByScope, setBrowserUrlsByScope] = useState<Record<string, string>>({});
  const [openedArtifact, setOpenedArtifact] = useState<OneArtifactOpenRequest | null>(null);
  const [chatFileTabs, setChatFileTabs] = useState<ChatFileItem[]>([]);
  const [activeChatFileTabId, setActiveChatFileTabId] = useState<string | null>(null);
  const presentedBrowserTargetRef = useRef<string | null>(null);
  const presentedResultKeyRef = useRef<string | null>(null);
  const presentedArtifactIdRef = useRef<string | null>(null);
  const presentedMcpResultIdRef = useRef<string | null>(null);
  const clampWidth = (value: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
  const collapseThreshold = Math.max(120, Math.min(220, minWidth - 48));
  const clampHistoryHeight = (value: number) => Math.min(480, Math.max(150, Math.round(value)));
  const commitHistoryHeight = (value: number) => {
    const next = clampHistoryHeight(value);
    setHistoryHeight(next);
    try { window.localStorage.setItem(ONE_OUTPUT_HISTORY_HEIGHT_STORAGE_KEY, String(next)); } catch { /* persistence is best effort */ }
  };
  const agents = useMemo(() => {
    const candidates = activity?.items.filter((item) => item.kind === "agent" || (item.kind === "tool" && item.agentName)) ?? [];
    const unique = new Map<string, OneActivityItem>();
    for (const item of candidates) {
      const key = localeSafeRuntimeText(item.agentName, locale, true) || item.id;
      if (!unique.has(key)) unique.set(key, item);
    }
    return [...unique.values()];
  }, [activity?.items, locale]);
  const mcpResults = useMemo(
    () => (activity?.items ?? []).filter((item) => (
      item.kind === "tool"
      && item.tool?.isError !== true
      && typeof item.tool?.result === "string"
      && parseMcpResult(item.tool.result, item.tool.name).blocks.length > 0
    )).slice(-8),
    [activity?.items],
  );
  /*
   * 분류는 도구 이름의 단어가 아니라 그 도구가 한 일로 한다 — shared/tool-taxonomy.ts.
   * 단어 매칭은 claude 의 `Bash` 하나만 잡고 codex `bash`(소문자 통과), grok `write`,
   * agy `write_to_file`, ACP 의 kind 는 전부 놓쳤다. 그래서 이 두 칸은 대부분의
   * 런타임에서 늘 0 이었다.
   */
  const processes = activity?.items.filter((item) => item.kind === "tool" && isCommandTool(item.tool?.name)) ?? [];
  const computerUse = activity?.items.filter((item) => item.kind === "tool" && isComputerUseTool(item.tool?.name)) ?? [];
  const currentBrowserUrl = useMemo(() => taskBrowserUrl(activity?.items ?? []), [activity?.items]);
  useEffect(() => {
    if (!browserScopeKey || !currentBrowserUrl) return;
    setBrowserUrlsByScope((current) => current[browserScopeKey] === currentBrowserUrl
      ? current
      : { ...current, [browserScopeKey]: currentBrowserUrl });
  }, [browserScopeKey, currentBrowserUrl]);
  /*
   * ★에이전트가 화면을 몰고 있으면 그 화면을 보여 준다 (실측 2026-09-08).
   *
   *   컴퓨터 조작(cua-driver 등)은 **어느 화면에도 자리가 없었다.** Work 는 패널을
   *   열지만 그릴 것이 없었고(릴리스 1.1.5 가 그리는 부품의 호출부를 지웠다),
   *   One 은 판정 자체가 없었다. 남은 곳은 스스로 열리지 않는 떠 있는 카드뿐이라
   *   사람 눈에는 "아무 일도 안 일어남"으로 보였다. 오너: "컴퓨터 유즈를 못하네".
   *
   *   호스트가 알려 주기를 기다리지 않고 **활동 기록에서 직접 끌어낸다** — 그래야
   *   One 과 Work 가 같은 순간에 같은 것을 본다. 브라우저는 이미 전용 보기가 있으므로
   *   여기서는 컴퓨터 조작만 맡는다(같은 것을 두 번 그리지 않는다).
   */
  const computerToolActive = useMemo(() => {
    const rows = activity?.items ?? [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.kind !== "tool") continue;
      if (agentScreenModeForTool(row.tool?.name) !== "computer") continue;
      return true;
    }
    return false;
  }, [activity?.items]);
  const [screenMode, setScreenMode] = useState<"browser" | "computer">("computer");

  const boundImages = scopedBoundImages(items, screenChatId);
  const fileArtifacts = items.filter((item) => item.kind !== "image");
  const latestArtifactId = items.at(-1)?.id ?? null;
  const activeChatFile = chatFileTabs.find((file) => file.tabId === activeChatFileTabId) ?? null;
  const openedArtifactKind = openedArtifact ? outputPresentationKindForName(openedArtifact.label) : "standard";
  const latestArtifactKind = outputPresentationKindForName(items.at(-1)?.label);
  const appPreviewBrowserUrl = appPreview?.url && isBrowserDocumentUrl(appPreview.url)
    ? new URL(appPreview.url).toString()
    : undefined;
  const resultBrowserUrl = browserPreviewUrl && isBrowserDocumentUrl(browserPreviewUrl)
    ? new URL(browserPreviewUrl).toString()
    : undefined;
  // Live app URLs are browser output. Keep the most recent task navigation as
  // a fallback for ordinary browser work, while a verified app preview wins so
  // it cannot be rendered again inside Result.
  const preferredBrowserUrl = appPreviewBrowserUrl
    ?? resultBrowserUrl
    ?? currentBrowserUrl
    ?? browserHistoryUrl
    ?? (browserScopeKey ? browserUrlsByScope[browserScopeKey] : undefined);
  const activeOutputKind: OutputPresentationKind = appPreview
    ? "web"
    : openedArtifactKind !== "standard"
      ? openedArtifactKind
      : resultKind !== "standard"
        ? resultKind
        : preferredBrowserUrl
          ? "web"
            : activeChatFile
              ? outputPresentationKindForViewerKind(activeChatFile.viewer.viewerKind)
              : openedArtifact
            ? "document"
            : latestArtifactKind;
  const outputIdentity = activeChatFile
    ? `chat-file:${activeChatFile.tabId}`
    : openedArtifact
    ? `artifact:${openedArtifact.binding.runId}:${openedArtifact.binding.artifactRef}`
    : preferredBrowserUrl
      ? `browser:${preferredBrowserUrl}`
      : resultKey
        ? `result:${resultKey}`
        : `kind:${activeOutputKind}`;
  useEffect(() => {
    if (!computerToolActive) return;
    setOpenTabs((tabs) => (tabs.includes("screen") ? tabs : [...tabs, "screen"]));
    /*
     * ★탭만 연다. 자동 선택은 넣었다가 **되돌렸다**(2026-09-08): 여기서
     * setRailView 를 부르면 레일 자체가 화면에서 사라졌다(실측 — aside 가 통째로 없어짐).
     * 레일의 표시 조건과 어떻게 얽혀 있는지 아직 모르므로, 모르는 채로 밀어 넣지 않는다.
     * 지금은 "화면" 탭이 생기는 것까지가 확인된 동작이다.
     */
  }, [computerToolActive]);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isOneArtifactOpenRequest(detail) || !screenChatId || detail.binding.chatId !== screenChatId) return;
      (onRequestReadableWidth ?? onResize)?.(Math.min(maxWidth, 560));
      onRequestOpen?.();
      setOpenTabs((tabs) => tabs.includes("result") ? tabs : [...tabs, "result"]);
      setOpenedArtifact(detail);
      setActiveChatFileTabId(null);
      setRailView("result");
    };
    window.addEventListener(ONE_ARTIFACT_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(ONE_ARTIFACT_OPEN_EVENT, handleOpen);
  }, [screenChatId, maxWidth, onRequestReadableWidth, onResize, onRequestOpen]);
  useEffect(() => {
    setChatFileTabs([]);
    setActiveChatFileTabId(null);
    onRestorePreferredWidth?.();
  }, [browserScopeKey, onRestorePreferredWidth]);
  useEffect(() => {
    const handleChatFile = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isChatFileItem(detail) || !screenChatId || detail.chatId !== screenChatId) return;
      (onRequestReadableWidth ?? onResize)?.(Math.min(maxWidth, 560));
      setChatFileTabs((current) => current.some((file) => file.tabId === detail.tabId)
        ? current.map((file) => file.tabId === detail.tabId ? detail : file)
        : [...current, detail]);
      setActiveChatFileTabId(detail.tabId);
      setOpenedArtifact(null);
      setOpenTabs((tabs) => tabs.includes("result") ? tabs : [...tabs, "result"]);
      setRailView("result");
    };
    window.addEventListener(CHAT_FILE_OPEN_EVENT, handleChatFile);
    return () => window.removeEventListener(CHAT_FILE_OPEN_EVENT, handleChatFile);
  }, [screenChatId, maxWidth, onRequestReadableWidth, onResize]);
  const selectChatFileTab = useCallback((id: string) => {
    if (!chatFileTabs.some((file) => file.tabId === id)) return;
    (onRequestReadableWidth ?? onResize)?.(Math.min(maxWidth, 560));
    setActiveChatFileTabId(id);
    setOpenedArtifact(null);
    setRailView("result");
  }, [chatFileTabs, maxWidth, onRequestReadableWidth, onResize]);
  const closeChatFileTab = useCallback((id: string) => {
    const tabs = chatFileTabs.map((file) => ({ id: file.tabId, name: file.name, provenance: file.provenance }));
    const nextId = nextFileTabSelection(tabs, id, activeChatFileTabId);
    setChatFileTabs((current) => current.filter((file) => file.tabId !== id));
    setActiveChatFileTabId(nextId);
    if (!nextId) onRestorePreferredWidth?.();
  }, [activeChatFileTabId, chatFileTabs, onRestorePreferredWidth]);
  useEffect(() => {
    const handleInAppLink = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const candidate = detail as { href?: unknown; fileUrl?: unknown; chatId?: unknown };
      if (!screenChatId || candidate.chatId !== screenChatId) return;
      const url = typeof candidate.href === "string" && /^https?:\/\//iu.test(candidate.href)
        ? candidate.href
        : typeof candidate.fileUrl === "string" && /^https?:\/\//iu.test(candidate.fileUrl)
          ? candidate.fileUrl
          : null;
      if (!url) return;
      const scope = browserScopeKey ?? "unscoped";
      setBrowserUrlsByScope((current) => current[scope] === url ? current : { ...current, [scope]: url });
      setOpenTabs((tabs) => tabs.includes("browser") ? tabs : [...tabs, "browser"]);
      setRailView("browser");
    };
    window.addEventListener("agentlas:in-app-linked-file", handleInAppLink);
    return () => window.removeEventListener("agentlas:in-app-linked-file", handleInAppLink);
  }, [browserScopeKey, screenChatId]);
  useEffect(() => {
    if (!latestArtifactId || presentedArtifactIdRef.current === latestArtifactId) return;
    presentedArtifactIdRef.current = latestArtifactId;
    setOpenTabs((tabs) => tabs.includes("result") ? tabs : [...tabs, "result"]);
    // 자동 표시는 Browser 를 빼앗지 않는다 — 브라우저 작업 자체가 산출물이고, 새 아티팩트가
    // 도착할 때마다 Activity 로 튕기면 사람이 보던 화면이 사라진다(P0: 재열람 시 Browser 유지).
    setRailView((current) => (items.at(-1)?.kind === "image" || current === "browser" || current === "worker") ? current : "activity");
  }, [latestArtifactId, result, items]);
  useEffect(() => {
    const latest = mcpResults.at(-1)?.id ?? null;
    if (!latest || presentedMcpResultIdRef.current === latest) return;
    presentedMcpResultIdRef.current = latest;
    setOpenTabs((tabs) => (tabs.includes("activity") ? tabs : [...tabs, "activity"]));
    // Keep a user-selected Result/Browser view stable; otherwise expose
    // the new MCP result in the activity tab as soon as the rail is opened.
    setRailView((current) => current ?? "activity");
  }, [mcpResults]);
  useEffect(() => {
    if (!preferredBrowserUrl) return;
    const targetKey = `${browserScopeKey ?? "unscoped"}\u0000${preferredBrowserUrl}`;
    if (presentedBrowserTargetRef.current === targetKey) return;
    presentedBrowserTargetRef.current = targetKey;
    // Browser work is itself the output. A person should not have to discover
    // a hidden tab after the agent opens a page, and the external Chrome window
    // is never the One presentation surface.
    // 브라우저 작업 자체가 결과다 — 탭이 없으면 이때 하나 생긴다.
    setOpenTabs((tabs) => (tabs.includes("browser") ? tabs : [...tabs, "browser"]));
    setRailView((current) => (current === "worker") ? current : "browser");
    // Stored URLs restore tabs, but only the scoped live native event above
    // reveals the panel. Reopening an old conversation is not a new action.
  }, [browserScopeKey, preferredBrowserUrl]);
  useEffect(() => {
    if (!result || !resultKey || presentedResultKeyRef.current === resultKey) return;
    presentedResultKeyRef.current = resultKey;
    // 결과가 나오면 그 탭이 하나 생긴다. 다만 확인된 Browser 표면 위로는
    // 올라오지 않는다 — 탭만 만들고 보고 있던 것을 빼앗지 않는다.
    setOpenTabs((tabs) => (tabs.includes("result") ? tabs : [...tabs, "result"]));
    setRailView((current) => (current === "browser" || current === "worker" ? current : "result"));
  }, [result, resultKey]);
  /*
   * 폭을 저 혼자 넓히던 자리(제거, 오너 지시 2026-08-24 "디폴트로 접히고
   * 켜져도 지금의 반만"). 넓은 산출물이 뜰 때마다 화면의 43% 로 벌어지고
   * 그 값이 저장까지 돼서, 기본 폭을 아무리 줄여도 다음 실행이 다시
   * 579px 로 되돌려 놓았다(실측). 폭은 이제 사람이 끌 때만 바뀐다.
   */
  useEffect(() => {
    if (!onResize) return;
    let resizeFrame = 0;
    let pendingWidth: number | null = null;
    let pendingDrag: typeof resizeRef.current = null;
    const flushWidth = () => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = 0;
      if (pendingWidth !== null && pendingDrag === resizeRef.current) onResize(pendingWidth);
      pendingWidth = null;
      pendingDrag = null;
    };
    const move = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      // Window-level tracking keeps the drag alive when the pointer leaves the
      // narrow panel edge or Electron drops element pointer capture.
      const rawWidth = drag.startWidth + (drag.startX - event.clientX);
      drag.rawWidth = rawWidth;
      const ready = rawWidth <= collapseThreshold;
      setCollapseReady((current) => current === ready ? current : ready);
      // Once the grip reaches the minimum, keep tracking the pointer beyond the
      // panel. Releasing near the window edge collapses instead of leaving an
      // awkward sliver that cannot be resized reliably.
      pendingWidth = ready ? minWidth : Math.min(maxWidth, Math.max(minWidth, Math.round(rawWidth)));
      pendingDrag = drag;
      if (!resizeFrame) resizeFrame = requestAnimationFrame(flushWidth);
      event.preventDefault();
    };
    const finish = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const shouldCollapse = event.type === "pointerup" && drag.rawWidth <= collapseThreshold;
      if (event.type === "pointerup" && !shouldCollapse) flushWidth();
      else {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
        pendingWidth = null;
        pendingDrag = null;
      }
      resizeRef.current = null;
      setResizing(false);
      setCollapseReady(false);
      if (shouldCollapse) {
        // Collapsing is a visibility action, not a request to permanently
        // reopen at the minimum. Preserve the last comfortable width (or the
        // product default when the drag began from a narrow rail).
        onResize(Math.max(defaultWidth, Math.min(maxWidth, Math.round(drag.startWidth))));
        onClose?.();
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      cancelAnimationFrame(resizeFrame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [collapseThreshold, defaultWidth, maxWidth, minWidth, onClose, onResize]);
  useEffect(() => {
    if (!resizing) return;
    const root = document.documentElement;
    const body = document.body;
    const prior = root.getAttribute("data-one-output-resizing");
    const priorRootCursor = root.style.cursor;
    const priorRootUserSelect = root.style.userSelect;
    const priorBodyCursor = body.style.cursor;
    const priorBodyUserSelect = body.style.userSelect;
    root.setAttribute("data-one-output-resizing", "true");
    // 끄는 동안에는 모션을 끈다. 이 표식 하나가 One 의 모션 토큰을 통째로 0ms 로
    // 눌러, 폭이 손가락을 그대로 따라온다(모션이 남으면 고무줄처럼 늘어져 더 나쁘다).
    // 놓는 순간 표식이 사라지므로, 접힘 복원 같은 되돌림은 다시 흐른다.
    root.setAttribute("data-one-resizing", "true");
    root.style.cursor = "col-resize";
    root.style.userSelect = "none";
    body.style.cursor = "col-resize";
    body.style.userSelect = "none";
    return () => {
      root.removeAttribute("data-one-resizing");
      if (prior == null) root.removeAttribute("data-one-output-resizing");
      else root.setAttribute("data-one-output-resizing", prior);
      root.style.cursor = priorRootCursor;
      root.style.userSelect = priorRootUserSelect;
      body.style.cursor = priorBodyCursor;
      body.style.userSelect = priorBodyUserSelect;
    };
  }, [resizing]);
  /**
   * 가로 손잡이 둘(미리보기 ↔ 아래 칸 분할선, 기록 패널 높이)도 같은 계약을 쓴다.
   * 끄는 동안 모션을 끄고 커서를 row-resize 로 잡아, 포인터가 손잡이 밖으로
   * 나가도 화면이 흔들리지 않는다. 세로 드래그와 동시에 일어날 수 없으므로
   * 표식은 하나로 충분하다.
   */
  const rowResizing = historyResizing;
  useEffect(() => {
    if (!rowResizing) return;
    const root = document.documentElement;
    const body = document.body;
    const priorRootCursor = root.style.cursor;
    const priorRootUserSelect = root.style.userSelect;
    const priorBodyCursor = body.style.cursor;
    const priorBodyUserSelect = body.style.userSelect;
    root.setAttribute("data-one-resizing", "true");
    root.style.cursor = "row-resize";
    root.style.userSelect = "none";
    body.style.cursor = "row-resize";
    body.style.userSelect = "none";
    return () => {
      root.removeAttribute("data-one-resizing");
      root.style.cursor = priorRootCursor;
      root.style.userSelect = priorRootUserSelect;
      body.style.cursor = priorBodyCursor;
      body.style.userSelect = priorBodyUserSelect;
    };
  }, [rowResizing]);
  const sources = useMemo(() => {
    const current = activity?.sources ?? [];
    if (!preferredBrowserUrl || current.some((source) => source.url === preferredBrowserUrl)) return current;
    return [...current, {
      id: `source:${preferredBrowserUrl}`,
      url: preferredBrowserUrl,
      label: (() => {
        try {
          const parsed = new URL(preferredBrowserUrl);
          return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
        } catch { return preferredBrowserUrl; }
      })(),
      toolName: "browser_navigate",
      status: "completed" as const,
    }];
  }, [activity?.sources, preferredBrowserUrl]);
  const toggleSection = (section: OutputSectionKey) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      try {
        window.localStorage.setItem(ONE_OUTPUT_SECTIONS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Section disclosure remains usable even when persistence is unavailable.
      }
      return next;
    });
  };
  const sectionExpanded = (section: OutputSectionKey) => !collapsedSections.has(section);
  if (!visible) return null;
  return (
    <aside
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape" || !addMenuOpen) return;
        event.preventDefault();
        event.stopPropagation();
        setAddMenuOpen(false);
        addMenuButtonRef.current?.focus();
      }}
      {...designOutputSurfaceProps(designSurfaceKindForOutput(activeOutputKind), styles.artifactRail)}
      aria-label={locale === "ko" ? "작업 산출물" : "Work outputs"}
      data-one-runtime-artifacts="true"
      data-rail-view={railView}
      data-output-kind={activeOutputKind}
      data-output-wide={isWideOutputKind(activeOutputKind) ? "true" : "false"}
      data-output-auto-width={isWideOutputKind(activeOutputKind) ? "true" : "false"}
      data-resizing={resizing ? "true" : "false"}
      data-collapse-ready={collapseReady ? "true" : "false"}
      style={width ? { width } : undefined}
    >
      {onResize && (
        // Drag the left edge to resize (owner request 2026-08-16). Keyboard:
        // ←/→ move 16px, Home widens, End collapses, double-click resets.
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(width ?? defaultWidth)}
          className={styles.artifactResizeHandle}
          aria-label={locale === "ko" ? "출력 패널 너비 조절" : "Resize output panel"}
          title={locale === "ko" ? "드래그하거나 화살표 키로 너비 조절" : "Drag or use arrow keys to resize"}
          data-one-rail-resize="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.focus({ preventScroll: true });
            const startWidth = width ?? defaultWidth;
            resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, rawWidth: startWidth };
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window tracking remains available. */ }
            setResizing(true);
            setCollapseReady(false);
            event.preventDefault();
            event.stopPropagation();
          }}
          onLostPointerCapture={() => {
            resizeRef.current = null;
            setResizing(false);
            setCollapseReady(false);
          }}
          onDoubleClick={() => onResize(defaultWidth)}
          onKeyDown={(event) => {
            const current = width ?? defaultWidth;
            if (event.key === "ArrowLeft") onResize(clampWidth(current + 16));
            else if (event.key === "ArrowRight") onResize(clampWidth(current - 16));
            else if (event.key === "Home") onResize(maxWidth);
            else if (event.key === "End" && onClose) onClose();
            else if (event.key === "End") onResize(minWidth);
            else return;
            event.preventDefault();
          }}
        />
      )}
      <nav className={styles.artifactTabs} aria-label={locale === "ko" ? "출력 보기" : "Output views"} role="tablist">
        <div className={styles.artifactTabList}>
          {openTabs.filter((view) => view !== "browser" || !screenChatId).map((view) => (
            <span key={view} className={styles.artifactTab} data-active={railView === view ? "true" : "false"}>
              <button
                type="button"
                role="tab"
                aria-selected={railView === view}
                onClick={() => selectRailView(view)}
              >
                <RailTabIcon view={view} />
                {railTabLabel(view, locale)}
              </button>
              <button
                type="button"
                className={styles.artifactTabClose}
                aria-label={locale === "ko" ? `${railTabLabel(view, locale)} 닫기` : `Close ${railTabLabel(view, locale)}`}
                onClick={() => view === "worker" ? closeWorkerTab() : closeRailTab(view)}
              >
                <IconClose size={11} />
              </button>
            </span>
          ))}
          <div ref={setBrowserHeaderHost} className={styles.browserTabHost} />
          <span className={styles.artifactAddWrap}>
            <button
              type="button"
              ref={addMenuButtonRef}
              aria-label={locale === "ko" ? "보기 추가" : "Add view"}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((value) => !value)}
            ><IconPlus size={15} /></button>
            {addMenuOpen && (
              <div className={styles.artifactAddMenu} role="menu">
                {(["activity", "terminal", "browser", "screen"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    role="menuitem"
                    disabled={view !== "browser" && openTabs.includes(view)}
                    onClick={() => { setAddMenuOpen(false); if (view === "browser") setBrowserNewTabRequest((value) => value + 1); openRailTab(view); }}
                  >
                    {railTabLabel(view, locale)}
                  </button>
                ))}
                {onAdd && (
                  <button type="button" role="menuitem" onClick={() => { setAddMenuOpen(false); onAdd(); }}>
                    {locale === "ko" ? "파일 추가" : "Add file"}
                  </button>
                )}
              </div>
            )}
          </span>
        </div>
        <div className={styles.artifactHeaderActions}>
          {onClose && <button type="button" onClick={onClose} aria-label={locale === "ko" ? "출력 패널 접기" : "Collapse output panel"}><IconClose size={15} /></button>}
        </div>
      </nav>
      {openTabs.length === 0 && (
        <div className={styles.artifactEmptyStage}>
          <p className={styles.artifactEmptyTitle}>{locale === "ko" ? "여기에 결과가 쌓입니다" : "Outputs appear here"}</p>
          <p className={styles.artifactEmptyNote}>
            {locale === "ko"
              ? "무언가 만들어지면 그 탭이 저절로 생깁니다. 지금 바로 열 수도 있습니다."
              : "A tab appears on its own when something is produced. You can also open one now."}
          </p>
          <div className={styles.artifactEmptyList}>
            {(["activity", "terminal", "browser", "screen"] as const).map((view) => (
              <button key={view} type="button" onClick={() => { if (view === "browser") setBrowserNewTabRequest((value) => value + 1); openRailTab(view); }}>{railTabLabel(view, locale)}</button>
            ))}
          </div>
        </div>
      )}
      <div className={styles.artifactContentStack}>
      <div
        className={styles.artifactList}

      >
        {railView === "worker" && workerKey && workerSelection && <OneWorkerPanel
          key={workerKey} selection={workerSelection} run={workerRun ?? null} locale={locale} onBack={closeWorkerTab}
        />}
        {railView === "result" && (activeChatFile || openedArtifact || result || boundImages.length > 0) && <div className={styles.resultView}>
          {chatFileTabs.length > 0 && <ChatFileTabs
            tabs={chatFileTabs.map((file) => ({ id: file.tabId, name: file.name, provenance: file.provenance }))}
            activeId={activeChatFileTabId}
            locale={locale}
            onSelect={selectChatFileTab}
            onClose={closeChatFileTab}
          />}
          {activeChatFile && <ChatFileOpenViewer
            file={activeChatFile}
            locale={locale}
            onExpand={onResize || onRequestReadableWidth ? () => (onRequestReadableWidth ?? onResize)?.(maxWidth) : undefined}
          />}
          {!activeChatFile && openedArtifact && <>
            <button type="button" className={styles.artifactBackButton} onClick={() => { setOpenedArtifact(null); onRestorePreferredWidth?.(); }}>
              <IconArrowLeft size={13} /> {locale === "ko" ? "결과로 돌아가기" : "Back to result"}
            </button>
            <ArtifactOpenViewer key={JSON.stringify(openedArtifact.binding)} target={openedArtifact} locale={locale} wide={isWideOutputKind(activeOutputKind) || (width ?? defaultWidth) >= 560} />
          </>}
          {!activeChatFile && !openedArtifact && <><BoundImageArtifacts items={boundImages} chatId={screenChatId} locale={locale} />{result}</>}
        </div>}
        {railView === "activity" && <>
          <OutputDisclosure section="files" label={locale === "ko" ? "결과물" : "Artifacts"} count={fileArtifacts.length} expanded={sectionExpanded("files")} onToggle={toggleSection}>
            {fileArtifacts.length === 0 && <p className={styles.artifactEmpty}>{locale === "ko" ? "만든 파일 또는 사이트가 여기에 표시됩니다" : "Files or sites you create appear here"}</p>}
            {fileArtifacts.map((item) => <ArtifactPreviewCard key={item.id} item={item} locale={locale} wide={(width ?? defaultWidth) >= 560} />)}
          </OutputDisclosure>
          {mcpResults.length > 0 && <OutputDisclosure section="mcp" label={locale === "ko" ? "MCP 결과" : "MCP results"} count={mcpResults.length} expanded={sectionExpanded("mcp")} onToggle={toggleSection}>
            {mcpResults.map((item) => (
              <McpResultPreview
                key={`mcp-rail-preview:${item.id}`}
                result={item.tool?.result}
                toolName={item.tool?.name}
                locale={locale}
                compact
                placement="sidebar"
              />
            ))}
          </OutputDisclosure>}
          {sources.length > 0 && <OutputDisclosure section="sources" label={locale === "ko" ? "출처" : "Sources"} count={sources.length} expanded={sectionExpanded("sources")} onToggle={toggleSection}>
            {sources.slice(-5).map((source) => <SourceRow key={source.id} source={source} />)}
          </OutputDisclosure>}
          <OutputDisclosure section="agents" label={locale === "ko" ? "하위 에이전트" : "Subagents"} count={agents.length} expanded={sectionExpanded("agents")} onToggle={toggleSection}>
            {agents.length === 0
              ? <p className={styles.artifactEmpty}>{locale === "ko" ? "실행된 하위 에이전트 없음" : "No subagents used"}</p>
              : agents.slice(-5).map((item) => <div key={item.id} className={styles.artifactRuntimeRow}><IconSparkles size={13} /><span>{item.agentName || (locale === "ko" ? "에이전트" : "Agent")}</span><small>{item.status === "completed" ? <IconCheck size={12} /> : null}</small></div>)}
          </OutputDisclosure>
        </>}
        {railView === "terminal" && <>
          {/* A completed shell tool is evidence of a command, not proof that a
              persistent background process exists. */}
          <OutputDisclosure section="processes" label={locale === "ko" ? "명령" : "Commands"} count={processes.length} expanded={sectionExpanded("processes")} onToggle={toggleSection}>
            {processes.length === 0
              ? <p className={styles.artifactEmpty}>{locale === "ko" ? "실행된 명령 없음" : "No commands run"}</p>
              : processes.slice(-3).map((item) => <div key={item.id} className={styles.artifactRuntimeRow}><IconCode size={13} /><span>{item.tool?.name || (locale === "ko" ? "명령" : "Command")}</span><small>{item.status === "completed" ? <IconCheck size={12} /> : null}</small></div>)}
          </OutputDisclosure>
          <OutputDisclosure section="computer" label={locale === "ko" ? "컴퓨터 사용" : "Computer use"} count={computerUse.length} expanded={sectionExpanded("computer")} onToggle={toggleSection}>
            {computerUse.length === 0
              ? <p className={styles.artifactEmpty}>{locale === "ko" ? "사용 기록 없음" : "No computer activity"}</p>
              : computerUse.slice(-3).map((item) => <div key={item.id} className={styles.artifactRuntimeRow}><IconPanelRight size={13} /><span>{item.tool?.name || (locale === "ko" ? "컴퓨터 작업" : "Computer task")}</span><small>{item.status === "completed" ? <IconCheck size={12} /> : null}</small></div>)}
          </OutputDisclosure>
        </>}
        {railView === "screen" && (
          <RailAgentScreen
            mode={screenMode}
            active={railView === "screen"}
            onModeChange={setScreenMode}
            ko={locale === "ko"}
            chatId={screenChatId}
          />
        )}
        {openTabs.includes("browser") && <div className={styles.browserPane} hidden={railView !== "browser"}>
          {screenChatId ? <TaskBrowser key={screenChatId} active={railView === "browser"} locale={locale} preferredUrl={preferredBrowserUrl} taskScopeId={screenChatId}
            presentation={presentedBrowser} headerHost={browserHeaderHost} onActivate={() => selectRailView("browser")} newTabRequest={browserNewTabRequest} />
            : <p className={styles.artifactEmpty}>{locale === "ko" ? "작업이 연결되면 브라우저를 열 수 있습니다." : "The browser becomes available when this conversation is bound to a task."}</p>}
        </div>}
      </div>
      {(railView === "activity" || railView === "terminal") && <><div
        className={styles.artifactHistoryResizeHandle}
        role="separator"
        aria-orientation="horizontal"
        aria-label={locale === "ko" ? "기록 패널 높이 조절" : "Resize history panel"}
        aria-valuemin={150}
        aria-valuemax={480}
        aria-valuenow={historyHeight}
        tabIndex={0}
        data-resizing={historyResizing ? "true" : "false"}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          historyResizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: historyHeight };
          event.currentTarget.setPointerCapture(event.pointerId);
          setHistoryResizing(true);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const drag = historyResizeRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setHistoryHeight(clampHistoryHeight(drag.startHeight + (drag.startY - event.clientY)));
        }}
        onPointerUp={(event) => {
          if (historyResizeRef.current?.pointerId !== event.pointerId) return;
          historyResizeRef.current = null;
          setHistoryResizing(false);
          commitHistoryHeight(historyHeight);
        }}
        onPointerCancel={() => {
          historyResizeRef.current = null;
          setHistoryResizing(false);
        }}
        onDoubleClick={() => commitHistoryHeight(250)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") commitHistoryHeight(historyHeight + 16);
          else if (event.key === "ArrowDown") commitHistoryHeight(historyHeight - 16);
          else if (event.key === "Home") commitHistoryHeight(480);
          else if (event.key === "End") commitHistoryHeight(150);
          else return;
          event.preventDefault();
        }}
      />
      <div className={styles.artifactHistoryPane} style={{ height: historyHeight }} aria-label={locale === "ko" ? "기록과 추천" : "History and recommendations"}>
        <OneComputerHistory
          compact
          state={computerHistory ?? null}
          locale={locale}
          onConsent={onHistoryConsent ?? (async () => {})}
          onClear={onHistoryClear ?? (() => {})}
          onAsk={onHistoryAsk ?? (() => {})}
          onReviewRecommendation={onHistoryReviewRecommendation}
        />
      </div>
      </>}
      </div>
    </aside>
  );
}

function SourceRow({ source }: { source: OneActivitySource }) {
  return <a className={styles.artifactRuntimeRow} href={source.url} target="_blank" rel="noreferrer" title={source.url}>
    <IconFileUp size={13} /><span>{source.label}</span><small>{source.status === "completed" ? <IconCheck size={12} /> : null}</small>
  </a>;
}
