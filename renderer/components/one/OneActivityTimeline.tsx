"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { LiveOutputViewer, type LiveOutputKind } from "@/components/LiveOutputViewer";
import { CodeIdeViewer, isCodeArtifactName } from "@/components/CodeIdeViewer";
import { LiveDeviceMockup } from "@/components/LiveDeviceMockup";
import { ipc } from "@/lib/ipc";
import {
  isWideOutputKind,
  outputPresentationKindForName,
  outputPresentationKindForViewerKind,
  type OutputPresentationKind,
} from "@/lib/output-presentation";
import { designOutputSurfaceProps, designSurfaceKindForOutput } from "@/lib/design-output-tokens";
import { isOneArtifactOpenRequest, ONE_ARTIFACT_OPEN_EVENT, requestOneArtifactOpen, type OneArtifactOpenRequest } from "@/lib/one-artifact-open";
import type { BrowserLiveDispatchResult, BrowserLiveFrame, BrowserLiveInput } from "@/lib/types";
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
import type { OnePermissionMode } from "./OneComposerControls";
import { OneComputerHistory } from "./OneComputerHistory";
import { McpResultPreview } from "../McpResultPreview";
import { ChatFileTabs, nextFileTabSelection } from "../ChatFileExperience";
import { CHAT_FILE_OPEN_EVENT, chatFilesBridge, formatChatFileSize, isChatFileItem, type ChatFileItem } from "@/lib/chat-files";
import styles from "./OneActivityTimeline.module.css";

const ONE_OUTPUT_SECTIONS_STORAGE_KEY = "agentlas.one.output-sections.v1";
const ONE_OUTPUT_HISTORY_HEIGHT_STORAGE_KEY = "agentlas.one.output-history-height.v1";
/** 미리보기 ↔ 아래 섹션 분할선의 높이. 없으면 "미리보기가 남는 높이를 전부" 가 기본. */
const ONE_OUTPUT_PREVIEW_HEIGHT_STORAGE_KEY = "agentlas.one.output-preview-height.v1";
const ONE_OUTPUT_PREVIEW_HEIGHT_MIN = 160;
/** 아래 섹션이 최소한 한 줄은 보이도록 남겨 두는 높이. */
const ONE_OUTPUT_BELOW_MIN = 120;
type OutputSectionKey = "files" | "mcp" | "agents" | "processes" | "computer" | "sources";
type OutputRailView = "result" | "activity" | "terminal" | "browser" | "app";

/** 탭마다 제 아이콘 — 글자만 있으면 어느 탭인지 눈으로 못 고른다. */
function RailTabIcon({ view }: { view: OutputRailView }) {
  if (view === "browser") return <IconNetwork size={12} />;
  if (view === "terminal") return <IconCode size={12} />;
  if (view === "app") return <IconPanelRight size={12} />;
  if (view === "result") return <IconCheck size={12} />;
  return <IconSparkles size={12} />;
}

function railTabLabel(view: OutputRailView, locale: "ko" | "en"): string {
  if (view === "result") return locale === "ko" ? "결과" : "Result";
  if (view === "app") return locale === "ko" ? "앱" : "App";
  if (view === "activity") return locale === "ko" ? "작업" : "Activity";
  if (view === "terminal") return locale === "ko" ? "터미널" : "Terminal";
  return locale === "ko" ? "브라우저" : "Browser";
}
type BrowserLiveInputBody = BrowserLiveInput extends infer Input
  ? Input extends { sessionId: string } ? Omit<Input, "sessionId"> : never
  : never;

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

/** null = 아직 사용자가 정한 적 없음 → 미리보기가 남는 높이를 전부 먹는다(기본). */
function readOutputPreviewHeight(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ONE_OUTPUT_PREVIEW_HEIGHT_STORAGE_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= ONE_OUTPUT_PREVIEW_HEIGHT_MIN ? Math.round(value) : null;
  } catch {
    return null;
  }
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
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);
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
          {visible.map((item) => (
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
        <pre style={{ margin: 0, padding: 12, fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview.content || (locale === "ko" ? "내용을 읽을 수 없습니다." : "The file content is unavailable.")}</pre>
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
      const parsed = new URL(value.url);
      if (/^https?:$/u.test(parsed.protocol) && !parsed.username && !parsed.password) return parsed.toString();
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

type BrowserShellTab = {
  id: string;
  title: string;
  url: string | null;
};

function normalizedBrowserAddress(value: string): string | null {
  const candidate = /^https?:\/\//iu.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const MAX_BROWSER_LIVE_RETRIES = 5;

function browserLiveErrorCopy(error: Exclude<BrowserLiveFrame["error"], null>, locale: "ko" | "en"): string {
  if (error === "browser-offline") {
    return locale === "ko"
      ? "전용 브라우저가 아직 준비되지 않았습니다. 잠시 후 다시 연결해 주세요."
      : "The dedicated browser is not ready yet. Try connecting again in a moment.";
  }
  if (error === "no-page") {
    return locale === "ko"
      ? "이 주소에 연결된 브라우저 화면을 찾지 못했습니다. 다시 연결해 주세요."
      : "The browser page for this address was not found. Try connecting again.";
  }
  return locale === "ko"
    ? "브라우저 화면을 캡처하지 못했습니다. 다시 연결해 주세요."
    : "The browser view could not be captured. Try connecting again.";
}

function OneBrowserLiveView({ active, locale, preferredUrl, previewScopeId }: { active: boolean; locale: "ko" | "en"; preferredUrl?: string; previewScopeId?: string }) {
  const [frame, setFrame] = useState<BrowserLiveFrame | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveError, setLiveError] = useState<Exclude<BrowserLiveFrame["error"], null> | null>(null);
  const [interactive, setInteractive] = useState(false);
  /*
   * 로컬 검증 서버 생명주기 — U-D-1/U-D-5.
   * One이 검증용 임시 서버를 정리한 뒤에도 이 탭은 죽은 127.0.0.1 주소에
   * LIVE 배지를 유지했고, 만들어진 파일을 인앱에서 다시 볼 길이 없었다.
   * localPreviewGone 은 매 주기 재평가한다(죽음도 살아남도 낙인이 아니다).
   */
  const [localPreviewGone, setLocalPreviewGone] = useState(false);
  const [filePreview, setFilePreview] = useState<{ name: string; html: string } | null>(null);
  const [fileCandidate, setFileCandidate] = useState<{ name: string; path: string } | null>(null);
  const [viewport, setViewport] = useState<"desktop" | "phone">("desktop");
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [tabs, setTabs] = useState<BrowserShellTab[]>(() => [{
    id: "task-output",
    title: locale === "ko" ? "이 사이트에 연결" : "Connected site",
    url: preferredUrl ?? null,
  }]);
  const [activeTabId, setActiveTabId] = useState("task-output");
  const [address, setAddress] = useState(preferredUrl ?? "");
  const tabSequenceRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const stopFlightRef = useRef<Promise<unknown>>(Promise.resolve());
  const [retryNonce, setRetryNonce] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const pointerFrameRef = useRef<number | null>(null);
  const queuedPointerRef = useRef<{ x: number; y: number } | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const effectiveUrl = activeTab?.url ?? undefined;

  useEffect(() => {
    if (!preferredUrl) return;
    setTabs((current) => current.map((tab) => tab.id === "task-output"
      ? { ...tab, url: preferredUrl }
      : tab));
    setActiveTabId("task-output");
    setAddress(preferredUrl);
  }, [preferredUrl]);

  useEffect(() => {
    setAddress(activeTab?.url ?? "");
    setMenuOpen(false);
  }, [activeTab?.id, activeTab?.url]);

  useEffect(() => {
    if (!active) {
      setFrame(null);
      setInteractive(false);
      setLoading(false);
      setLiveError(null);
      return;
    }
    const bridge = ipc();
    if (!bridge?.browser?.startLiveView || !bridge.browser.onLiveFrame) return;
    // A changed task URL invalidates the prior frame immediately. Keeping it
    // while an exact-target capture fails is how a completed Soulin run leaked
    // into a later Latchwork task's Browser rail.
    setFrame(null);
    setInteractive(false);
    // Browser output belongs to a Taskforce/thread. With no URL observed for
    // that scope, showing whichever CDP tab happens to be open would leak an
    // unrelated job into this room.
    if (!effectiveUrl) {
      setLoading(false);
      return;
    }
    let disposed = false;
    let ownedSession: string | null = null;
    let retryTimer: number | null = null;
    let retryAttempt = 0;
    setLoading(true);
    setLiveError(null);
    const unsubscribe = bridge.browser.onLiveFrame((next) => {
      if (!disposed && next.sessionId === sessionRef.current && next.viewport === viewport) {
        setFrame(next);
        setLoading(false);
        if (next.available) setLiveError(null);
        else if (next.error) setLiveError(next.error);
        if (next.url) {
          setAddress(next.url);
          setTabs((current) => {
            const target = current.find((tab) => tab.id === activeTabId);
            const nextTitle = next.title || target?.title || (locale === "ko" ? "이 사이트에 연결" : "Connected site");
            if (!target || (target.url === next.url && target.title === nextTitle)) return current;
            return current.map((tab) => tab.id === activeTabId
              ? { ...tab, url: next.url, title: nextTitle }
              : tab);
          });
        }
      }
    });
    const scheduleRetry = (error: Exclude<BrowserLiveFrame["error"], null>) => {
      if (disposed || retryTimer != null) return;
      if (retryAttempt >= MAX_BROWSER_LIVE_RETRIES) {
        setLoading(false);
        setLiveError(error);
        return;
      }
      const delay = Math.min(2_500, 600 + retryAttempt * 400);
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void start();
      }, delay);
    };
    const start = async () => {
      try {
        // Page.stopScreencast is target-global. A tab/viewport switch used to
        // start the replacement session while cleanup of the previous session
        // was still in flight; the late stop then killed the fresh stream.
        // Serialize that handoff without blocking React cleanup.
        await stopFlightRef.current.catch(() => undefined);
        if (disposed) return;
        const result = await bridge.browser.startLiveView(effectiveUrl, viewport);
        if (disposed) {
          if (result.sessionId) void bridge.browser.stopLiveView(result.sessionId);
          return;
        }
        ownedSession = result.sessionId;
        sessionRef.current = result.sessionId;
        setFrame(result.frame);
        setInteractive(result.interactive);
        if (result.sessionId && result.frame.available) {
          retryAttempt = 0;
          setLiveError(null);
          setLoading(false);
          return;
        }
        // The tool event can arrive a fraction before the headless CDP host is
        // ready, and the URL can be identical to a previous run. Neither case
        // changes React dependencies, so a one-shot attempt strands the rail
        // empty forever. Retry only the exact attributed URL until its durable
        // rail target exists.
        setLoading(true);
        scheduleRetry(result.frame.error ?? "capture-failed");
      } catch {
        if (!disposed) {
          setFrame(null);
          setInteractive(false);
          setLoading(true);
          scheduleRetry("capture-failed");
        }
      }
    };
    void start();
    return () => {
      disposed = true;
      if (retryTimer != null) window.clearTimeout(retryTimer);
      unsubscribe();
      if (ownedSession) {
        stopFlightRef.current = bridge.browser.stopLiveView(ownedSession).catch(() => undefined);
      }
      if (sessionRef.current === ownedSession) sessionRef.current = null;
    };
  }, [active, activeTabId, effectiveUrl, locale, retryNonce, viewport]);

  useEffect(() => () => {
    if (pointerFrameRef.current != null) window.cancelAnimationFrame(pointerFrameRef.current);
  }, []);

  // 도달성은 루프백 주소에만 묻되, 렌더러와 같은 오리진일 때만 묻는다.
  // managed preview/브라우저 target은 다른 포트를 쓰고 CORP: same-origin을
  // 보낼 수 있으므로, cross-origin HEAD 실패는 정리된 서버의 증거가 아니다.
  const localOrigin = useMemo(() => {
    if (!effectiveUrl) return null;
    try {
      const parsed = new URL(effectiveUrl);
      return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(parsed.hostname) ? parsed.origin : null;
    } catch {
      return null;
    }
  }, [effectiveUrl]);

  useEffect(() => {
    if (!active || !localOrigin || localOrigin !== window.location.origin) {
      setLocalPreviewGone(false);
      return;
    }
    let disposed = false;
    const probe = async () => {
      // 뒤로 간 창에서까지 묻지 않는다(유휴 비용).
      if (document.visibilityState === "hidden") return;
      try {
        // no-cors: 응답을 읽지 않고 도달성만 본다 — 연결 거부만 reject 된다.
        await fetch(localOrigin, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(1_500) });
        if (!disposed) setLocalPreviewGone(false);
      } catch {
        if (!disposed) setLocalPreviewGone(true);
      }
    };
    void probe();
    const timer = window.setInterval(() => { void probe(); }, 6_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, localOrigin]);

  // 서버가 사라졌을 때만 재열람 후보를 찾는다. 경로 권위는 Main(fs 스코프)이다:
  // 대화 연결 폴더 → 기본 실행 폴더 순서로, 주소의 파일명과 같은 .html 을 먼저 찾고
  // 없으면 가장 최근에 바뀐 .html 하나를 고른다.
  useEffect(() => {
    setFilePreview(null);
    if (!localPreviewGone || !previewScopeId) {
      setFileCandidate(null);
      return;
    }
    const bridge = ipc();
    if (!bridge?.fs?.listDirectory || !bridge.workspace?.defaultRunFolder) return;
    let cancelled = false;
    void (async () => {
      const scope = { kind: "chat-assets", chatId: previewScopeId } as const;
      const roots: string[] = [];
      const linked = await bridge.workspace.get(previewScopeId).catch(() => null);
      if (typeof linked === "string" && linked) roots.push(linked);
      const fallback = await bridge.workspace.defaultRunFolder().catch(() => null);
      if (typeof fallback === "string" && fallback && !roots.includes(fallback)) roots.push(fallback);
      const wantedName = (() => {
        try {
          return decodeURIComponent(new URL(effectiveUrl ?? "").pathname.split("/").filter(Boolean).pop() ?? "");
        } catch {
          return "";
        }
      })();
      const htmlFiles: Array<{ name: string; path: string; size: number }> = [];
      for (const root of roots) {
        const top = await bridge.fs.listDirectory(root, scope).catch(() => null);
        if (!top?.exists) continue;
        const dirs: string[] = [];
        for (const node of top.entries) {
          if (node.kind === "file" && /\.html?$/i.test(node.name)) htmlFiles.push(node);
          else if (node.kind === "dir") dirs.push(node.path);
        }
        // 한 단계 아래까지만 본다 — 실행 폴더 전체를 걷는 것은 이 배너의 몫이 아니다.
        for (const dir of dirs.slice(0, 12)) {
          const sub = await bridge.fs.listDirectory(dir, scope).catch(() => null);
          for (const node of sub?.entries ?? []) {
            if (node.kind === "file" && /\.html?$/i.test(node.name)) htmlFiles.push(node);
          }
        }
        if (htmlFiles.length > 0) break;
      }
      if (cancelled) return;
      const exact = wantedName ? htmlFiles.find((file) => file.name === wantedName) : undefined;
      const pick = exact ?? htmlFiles[0] ?? null;
      setFileCandidate(pick ? { name: pick.name, path: pick.path } : null);
    })();
    return () => { cancelled = true; };
  }, [localPreviewGone, previewScopeId, effectiveUrl]);

  const openFilePreview = useCallback(async () => {
    if (!fileCandidate || !previewScopeId) return;
    const bridge = ipc();
    if (!bridge?.fs?.readTextFile) return;
    const preview = await bridge.fs.readTextFile(fileCandidate.path, { kind: "chat-assets", chatId: previewScopeId }).catch(() => null);
    if (preview && typeof preview.content === "string") setFilePreview({ name: fileCandidate.name, html: preview.content });
  }, [fileCandidate, previewScopeId]);

  const pointInFrame = (element: HTMLElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height))),
    };
  };
  const dispatch = async (
    input: BrowserLiveInputBody,
    options: { label?: string; busy?: boolean; quietSuccess?: boolean; quietFailure?: boolean } = {},
  ): Promise<BrowserLiveDispatchResult | null> => {
    const sessionId = sessionRef.current;
    const bridge = ipc();
    if (!sessionId || !bridge?.browser?.dispatchLiveInput) {
      if (!options.quietFailure) {
        setActionFeedback({
          tone: "error",
          message: locale === "ko" ? "실시간 브라우저 세션이 끝나 이 작업을 보내지 못했습니다." : "The live browser session ended, so this action was not sent.",
        });
      }
      setInteractive(false);
      return null;
    }
    if (options.busy) setActionPending(options.label ?? "browser-action");
    try {
      const result = await bridge.browser.dispatchLiveInput({ ...input, sessionId } as BrowserLiveInput);
      if (sessionRef.current !== sessionId || result?.ok !== true) {
        if (!options.quietFailure) {
          const noHistory = result?.ok === false && result.code === "no_history";
          setActionFeedback({
            tone: "error",
            message: noHistory
              ? (locale === "ko" ? "이 방향으로 이동할 방문 기록이 없습니다." : "There is no history entry in that direction.")
              : (locale === "ko" ? "브라우저가 이 작업을 받지 않았습니다. 현재 화면을 확인한 뒤 다시 시도하세요." : "The browser did not accept this action. Check the current page before trying again."),
          });
        }
        if (
          sessionRef.current !== sessionId
          || (result?.ok === false && result.code === "session_missing")
        ) setInteractive(false);
        return result ?? null;
      }
      if (!options.quietSuccess) {
        setActionFeedback({
          tone: "success",
          message: locale === "ko" ? `${options.label ?? "브라우저 작업"}을(를) 전달했습니다.` : `${options.label ?? "Browser action"} was accepted.`,
        });
      }
      return result;
    } catch {
      if (!options.quietFailure) {
        setActionFeedback({
          tone: "error",
          message: locale === "ko" ? "브라우저 작업의 결과를 확인하지 못했습니다. 현재 프레임이 바뀌는지 확인하고 반복하지 마세요." : "The browser action outcome could not be verified. Check whether the frame changes before repeating it.",
        });
      }
      return null;
    } finally {
      if (options.busy) setActionPending(null);
    }
  };
  const modifierMask = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
    (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

  const currentFrame = frame?.viewport === viewport ? frame : null;
  /*
   * 우리가 껐다는 걸 아는 주소에서는 스트림 화면을 그리지 않는다 (오너 관측 2026-08-25).
   *
   * 프레임은 "사진"일 뿐이라, 임시 서버가 죽은 뒤에도 스트림은 계속 찍힌다 — 그리고 그
   * 사진의 내용이 크롬 자체의 오류 페이지("사이트에 연결할 수 없음 / localhost에서 연결을
   * 거부했습니다 / ERR_CONNECTION_REFUSED / [세부정보][새로고침]") 였다. 우리 화면 자리에
   * 남의 오류 프레임이 그대로 뜬 것이다. 바로 위 배너에 "정리되었습니다" 라고 우리가 이미
   * 적어 놓고서. available 은 "프레임이 있다" 는 사실이지 "보여줄 만하다" 는 뜻이 아니다.
   */
  const available = Boolean(currentFrame?.available && currentFrame.dataUrl) && !localPreviewGone;
  const addTab = () => {
    const id = `browser-tab-${++tabSequenceRef.current}`;
    setTabs((current) => [...current, {
      id,
      title: locale === "ko" ? "새 탭" : "New tab",
      url: null,
    }]);
    setActiveTabId(id);
    setFrame(null);
    setInteractive(false);
  };
  const closeTab = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (tabs.length === 1) {
      const blank = { ...tabs[0], title: locale === "ko" ? "새 탭" : "New tab", url: null };
      setTabs([blank]);
      setActiveTabId(blank.id);
      return;
    }
    const next = tabs.filter((tab) => tab.id !== id);
    // Keep related tab + selection updates in the same event batch. Calling a
    // state setter from inside another state updater left React free to replay
    // the updater and strand activeTabId on the deleted tab, so its live CDP
    // session never reconnected after closing a new tab.
    setTabs(next);
    if (activeTabId === id) setActiveTabId(next[Math.min(index, next.length - 1)].id);
  };
  const runNavigationAction = async (action: "back" | "forward" | "reload") => {
    const labels = action === "back"
      ? { ko: "뒤로 이동", en: "Back" }
      : action === "forward"
        ? { ko: "앞으로 이동", en: "Forward" }
        : { ko: "새로고침", en: "Reload" };
    const result = await dispatch(
      { kind: "navigation", action },
      { label: labels[locale], busy: true },
    );
    if (result?.ok && result.finalUrl) {
      const finalUrl = result.finalUrl;
      setAddress(finalUrl);
      setTabs((current) => current.map((tab) => tab.id === activeTabId
        ? { ...tab, url: finalUrl, title: new URL(finalUrl).hostname }
        : tab));
    }
  };
  const navigateFromAddress = async () => {
    const url = normalizedBrowserAddress(address);
    if (!url || !activeTab) {
      setActionFeedback({ tone: "error", message: locale === "ko" ? "열 수 있는 http 또는 https 주소를 입력하세요." : "Enter a valid http or https address." });
      return;
    }
    const sessionId = sessionRef.current;
    const bridge = ipc();
    if (sessionId && bridge?.browser?.dispatchLiveInput) {
      const actualAddress = currentFrame?.url ?? activeTab.url ?? "";
      const receipt = await dispatch(
        { kind: "navigation", action: "navigate", url },
        { label: locale === "ko" ? "주소 열기" : "Open address", busy: true },
      );
      if (receipt?.ok) {
        const settledUrl = receipt.finalUrl ?? url;
        setAddress(settledUrl);
        setTabs((current) => current.map((tab) => tab.id === activeTab.id
          ? { ...tab, url: settledUrl, title: new URL(settledUrl).hostname }
          : tab));
      } else {
        setAddress(actualAddress);
      }
      return;
    }
    setTabs((current) => current.map((tab) => tab.id === activeTab.id
      ? { ...tab, url, title: new URL(url).hostname }
      : tab));
    setAddress(url);
    setFrame(null);
    setInteractive(false);
    setActionFeedback({ tone: "success", message: locale === "ko" ? "새 주소를 여는 중입니다." : "Opening the new address." });
  };

  const copyAddress = async () => {
    if (!effectiveUrl || actionPending) return;
    setActionPending("copy-address");
    try {
      await navigator.clipboard.writeText(effectiveUrl);
      setActionFeedback({ tone: "success", message: locale === "ko" ? "주소를 복사했습니다." : "Address copied." });
      setMenuOpen(false);
    } catch {
      setActionFeedback({ tone: "error", message: locale === "ko" ? "주소를 복사하지 못했습니다. 주소창에서 직접 선택해 복사하세요." : "The address could not be copied. Select it directly in the address bar." });
    } finally {
      setActionPending(null);
    }
  };

  return <section className={styles.browserLive} data-available={available ? "true" : "false"} data-viewport={viewport} data-interactive={interactive ? "true" : "false"}>
    {/*
      * 탭이 하나뿐일 때는 이 줄이 바깥 패널의 "브라우저" 탭과 같은 말을 두 번
      * 한다. 그동안 머리가 세 겹(패널 탭 + 브라우저 탭 + 주소줄)이었다.
      * 탭이 둘 이상일 때만 줄을 세우고, 새 탭과 LIVE 표시는 주소줄로 옮겼다.
      */}
    {tabs.length > 1 && <div className={styles.browserTabBar}>
      <div className={styles.browserTabs} role="tablist" aria-label={locale === "ko" ? "브라우저 탭" : "Browser tabs"}>
        {tabs.map((tab) => <div
          key={tab.id}
          className={styles.browserTab}
          data-selected={tab.id === activeTabId ? "true" : undefined}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={styles.browserTabSelect}
            onClick={() => setActiveTabId(tab.id)}
          ><IconNetwork size={12} /><span>{tab.title}</span></button>
          <button
            type="button"
            className={styles.browserTabClose}
            aria-label={locale === "ko" ? `${tab.title} 탭 닫기` : `Close ${tab.title} tab`}
            onClick={() => closeTab(tab.id)}
          ><IconClose size={10} /></button>
        </div>)}
      </div>
      <button type="button" className={styles.browserNewTab} onClick={addTab} aria-label={locale === "ko" ? "새 탭" : "New tab"}><IconPlus size={14} /></button>
      {interactive && !localPreviewGone && <span className={styles.browserLiveBadge}><i />LIVE</span>}
      {localPreviewGone && <span className={styles.browserLiveBadge} data-gone="true"><i />{locale === "ko" ? "정리됨" : "Cleaned up"}</span>}
    </div>}
    <div className={styles.browserNavigationBar}>
      <button type="button" onClick={() => void runNavigationAction("back")} disabled={!interactive || actionPending !== null} aria-label={locale === "ko" ? "뒤로" : "Back"}><IconArrowLeft size={14} /></button>
      <button type="button" onClick={() => void runNavigationAction("forward")} disabled={!interactive || actionPending !== null} aria-label={locale === "ko" ? "앞으로" : "Forward"}><IconChevronRight size={14} /></button>
      <button type="button" onClick={() => void runNavigationAction("reload")} disabled={!interactive || actionPending !== null} aria-label={locale === "ko" ? "새로고침" : "Reload"}><IconRefresh size={13} /></button>
      <form className={styles.browserAddressForm} onSubmit={(event) => { event.preventDefault(); void navigateFromAddress(); }}>
        <IconNetwork size={12} />
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label={locale === "ko" ? "주소" : "Address"}
          placeholder={locale === "ko" ? "검색하거나 주소 입력" : "Search or enter address"}
          spellCheck={false}
        />
      </form>
      {tabs.length <= 1 && <button type="button" className={styles.browserNewTab} onClick={addTab} aria-label={locale === "ko" ? "새 탭" : "New tab"}><IconPlus size={14} /></button>}
      {tabs.length <= 1 && interactive && !localPreviewGone && <span className={styles.browserLiveBadge}><i />LIVE</span>}
      {tabs.length <= 1 && localPreviewGone && <span className={styles.browserLiveBadge} data-gone="true"><i />{locale === "ko" ? "정리됨" : "Cleaned up"}</span>}
      <div className={styles.browserMenuAnchor}>
        <button type="button" aria-label={locale === "ko" ? "브라우저 메뉴" : "Browser menu"} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><IconMoreHorizontal size={15} /></button>
        {menuOpen && <div className={styles.browserMenu} role="menu">
          <button type="button" role="menuitem" onClick={() => { setViewport("desktop"); setMenuOpen(false); }} data-selected={viewport === "desktop" ? "true" : undefined}>{locale === "ko" ? "웹 화면" : "Web viewport"}<small>1280×800</small></button>
          <button type="button" role="menuitem" onClick={() => { setViewport("phone"); setMenuOpen(false); }} data-selected={viewport === "phone" ? "true" : undefined}>{locale === "ko" ? "휴대폰 화면" : "Phone viewport"}<small>390×844</small></button>
          <span />
          <button type="button" role="menuitem" disabled={!effectiveUrl || actionPending !== null} onClick={() => void copyAddress()}>{actionPending === "copy-address" ? (locale === "ko" ? "복사 중…" : "Copying…") : (locale === "ko" ? "주소 복사" : "Copy address")}</button>
          <button type="button" role="menuitem" onClick={() => { closeTab(activeTabId); setMenuOpen(false); }}>{locale === "ko" ? "탭 닫기" : "Close tab"}</button>
        </div>}
      </div>
    </div>
    {actionFeedback && <div className={styles.browserActionNotice} data-tone={actionFeedback.tone} role={actionFeedback.tone === "error" ? "alert" : "status"}>{actionFeedback.message}</div>}
    {/* 아래 빈 상태가 같은 사실과 같은 행동을 이미 가운데에 크게 말하고 있을 때는 배너를
        띄우지 않는다 — 같은 버튼이 한 화면에 두 번 나오던 것. */}
    {localPreviewGone && (available || filePreview) && <div className={styles.browserGoneNotice} role="status">
      <span>
        <strong>{locale === "ko" ? "미리보기 임시 서버가 정리되었습니다" : "The temporary preview server was cleaned up"}</strong>
        <small>{locale === "ko"
          ? "One이 검증을 마치고 서버를 종료해 이 주소는 더 열리지 않습니다."
          : "One shut the server down after verifying, so this address no longer loads."}</small>
      </span>
      {filePreview
        ? <button type="button" onClick={() => setFilePreview(null)}>{locale === "ko" ? "브라우저 화면 보기" : "Show browser view"}</button>
        : fileCandidate && <button type="button" onClick={() => void openFilePreview()}>{locale === "ko" ? `만든 파일 미리보기 (${fileCandidate.name})` : `Preview the built file (${fileCandidate.name})`}</button>}
    </div>}
    {filePreview
      ? <div className={styles.browserFilePreview} data-mode={viewport}>
          {/* 정리된 서버 대신 디스크의 산출물을 그대로 연다 — 웹 One 미리보기와 같은
              srcDoc 방식(원격 로드 없음), 스크립트만 허용한 sandbox. */}
          <iframe srcDoc={filePreview.html} sandbox="allow-scripts" title={filePreview.name} />
        </div>
      : available
      // eslint-disable-next-line @next/next/no-img-element
      ? <div className={styles.browserViewport} data-mode={viewport}>
          <div
            className={styles.browserStreamInput}
            role="application"
            aria-label={interactive
              ? (locale === "ko" ? "실시간 브라우저. 클릭, 스크롤, 키보드 입력 가능" : "Live browser. Click, scroll, and type here")
              : (locale === "ko" ? "브라우저 화면. 실시간 조작 세션 없음" : "Browser view. No live interaction session")}
            onPointerDown={(event) => {
              if (!interactive) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              inputRef.current?.focus({ preventScroll: true });
              const point = pointInFrame(event.currentTarget, event.clientX, event.clientY);
              void dispatch({ kind: "pointer", phase: "down", ...point, button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left", clickCount: event.detail || 1 }, { label: locale === "ko" ? "클릭" : "Click", quietSuccess: true });
            }}
            onPointerUp={(event) => {
              if (!interactive) return;
              const point = pointInFrame(event.currentTarget, event.clientX, event.clientY);
              void dispatch({ kind: "pointer", phase: "up", ...point, button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left", clickCount: event.detail || 1 }, { label: locale === "ko" ? "클릭" : "Click", quietSuccess: true });
            }}
            onPointerMove={(event) => {
              if (!interactive) return;
              queuedPointerRef.current = pointInFrame(event.currentTarget, event.clientX, event.clientY);
              if (pointerFrameRef.current != null) return;
              pointerFrameRef.current = window.requestAnimationFrame(() => {
                pointerFrameRef.current = null;
                const point = queuedPointerRef.current;
                if (point) void dispatch({ kind: "pointer", phase: "move", ...point }, { quietSuccess: true, quietFailure: true });
              });
            }}
            onWheel={(event) => {
              if (!interactive) return;
              event.preventDefault();
              const point = pointInFrame(event.currentTarget, event.clientX, event.clientY);
              void dispatch({ kind: "wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY }, { label: locale === "ko" ? "스크롤" : "Scroll", quietSuccess: true });
            }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (!interactive) return;
              if (composingRef.current || event.nativeEvent.isComposing) return;
              event.preventDefault();
              const modifiers = modifierMask(event);
              void (async () => {
                const down = await dispatch({ kind: "key", phase: "down", key: event.key, code: event.code, modifiers }, { label: locale === "ko" ? "키 입력" : "Key input", quietSuccess: true });
                if (down?.ok) await dispatch({ kind: "key", phase: "up", key: event.key, code: event.code, modifiers }, { label: locale === "ko" ? "키 입력" : "Key input", quietSuccess: true });
              })();
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              if (interactive && event.data) void dispatch({ kind: "text", text: event.data }, { label: locale === "ko" ? "텍스트 입력" : "Text input", quietSuccess: true });
            }}
            onPaste={(event) => {
              event.preventDefault();
              const text = event.clipboardData.getData("text/plain");
              if (interactive && text) void dispatch({ kind: "text", text }, { label: locale === "ko" ? "붙여넣기" : "Paste", quietSuccess: true });
            }}
          >
            <img src={currentFrame!.dataUrl!} draggable={false} alt={currentFrame?.title || (locale === "ko" ? "인앱 브라우저 라이브 화면" : "Live in-app browser view")} />
            <textarea ref={inputRef} className={styles.browserInputCapture} aria-label={locale === "ko" ? "브라우저 키보드 입력" : "Browser keyboard input"} value="" onChange={() => undefined} />
          </div>
        </div>
      : <div className={styles.browserEmpty}>
          <IconPanelRight size={22} />
          {/*
            * 도달 불가일 때 남의 오류 화면 문구를 흉내 내지 않는다 (오너 관측 2026-08-25).
            * 예전 문구 "이 사이트에 연결할 수 없습니다 / 연결 상태를 확인한 뒤 새로고침해
            * 주세요" 는 크롬 오류 페이지의 문장 그대로였다 — 우리 화면 자리에 남의 오류가
            * 뜬 것처럼 보였을 뿐 아니라, 우리가 스스로 끈 서버에 대고 "연결 상태를 확인"
            * 하라고 시켜서 사용자가 고칠 수 없는 일을 하게 만든다. 정리된 것을 이미 아는
            * 화면이므로(localPreviewGone) 그 사실과 다음 행동을 말한다.
            */}
          {loading ? <>
            <strong>{locale === "ko" ? "브라우저 화면 불러오는 중…" : "Loading browser view…"}</strong>
            <small>{locale === "ko" ? "실제 페이지를 인앱 브라우저에 연결하고 있습니다." : "Connecting the real page to the in-app browser."}</small>
            <LoadingEstimate locale={locale} operationKey="one-browser-live-frame" expectedSeconds={[1, 10]} />
          </> : liveError ? <>
            <strong>{locale === "ko" ? "브라우저 화면을 불러오지 못했습니다" : "The browser view could not be loaded"}</strong>
            <small>{browserLiveErrorCopy(liveError, locale)}</small>
            <button type="button" onClick={() => {
              setFrame(null);
              setInteractive(false);
              setLiveError(null);
              setLoading(true);
              setRetryNonce((value) => value + 1);
            }}>{locale === "ko" ? "다시 연결" : "Connect again"}</button>
          </> : localPreviewGone ? <>
            <strong>{locale === "ko" ? "미리보기를 정리했습니다" : "The preview was cleaned up"}</strong>
            <small>{locale === "ko"
              ? "One이 확인을 마치고 임시 서버를 껐습니다. 만든 파일은 그대로 있습니다."
              : "One finished checking and shut the temporary server down. The files it built are still there."}</small>
            {fileCandidate && <button type="button" onClick={() => void openFilePreview()}>
              {locale === "ko" ? `만든 파일 열기 (${fileCandidate.name})` : `Open the built file (${fileCandidate.name})`}
            </button>}
          </> : effectiveUrl ? <>
            <strong>{locale === "ko" ? "이 주소는 지금 열리지 않습니다" : "This address isn't answering"}</strong>
            <small>{locale === "ko"
              ? "서버가 꺼져 있거나 아직 준비 중입니다. 주소창의 새로고침으로 다시 시도할 수 있습니다."
              : "The server is off or still starting. Reload from the address bar to try again."}</small>
          </> : <>
            <strong>{locale === "ko" ? "새 탭" : "New tab"}</strong>
            <small>{locale === "ko" ? "주소창에 사이트 주소를 입력하세요." : "Enter a site in the address bar."}</small>
          </>}
        </div>}
  </section>;
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

export function OneActivityArtifactRail({
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
  browserScopeKey,
  browserHistoryUrl,
  onBrowserObserved,
  result,
  resultKey,
  resultKind = "standard",
  appPreview,
}: {
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
  /** Stable Taskforce/thread identity used to retain only its own browser URL across turns. */
  browserScopeKey?: string;
  /** Latest proven Browser navigation from this thread's durable run history. */
  browserHistoryUrl?: string;
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
}) {
  const [collapsedSections, setCollapsedSections] = useState<Set<OutputSectionKey>>(readCollapsedOutputSections);
  /*
   * 탭은 고정 목록이 아니다(오너 지시 2026-08-24). 무언가 결과가 나오면 그
   * 탭이 하나 생기고, 나머지는 + 로 사람이 직접 연다. 아무것도 안 한 대화에서
   * "결과 / Activity / Terminal / Browser" 네 개가 늘 떠 있을 이유가 없다.
   */
  const [openTabs, setOpenTabs] = useState<OutputRailView[]>([]);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [railView, setRailView] = useState<OutputRailView | null>(null);
  /*
   * 브라우저와 앱은 좁은 칸에서 아무것도 못 읽는다(실측 324px 에서 페이지가
   * 찌그러졌다). 그 탭을 실제로 보기 시작할 때만 읽을 수 있는 폭을 확보한다 —
   * 결과가 생길 때마다 저 혼자 벌어지던 예전 동작과는 다르다.
   */
  const selectRailView = useCallback((view: OutputRailView) => {
    setRailView(view);
    if (view !== "browser" && view !== "app") return;
    const readable = Math.min(maxWidth, 560);
    (onRequestReadableWidth ?? onResize)?.(Math.max(width ?? defaultWidth, readable));
  }, [defaultWidth, maxWidth, onRequestReadableWidth, onResize, width]);
  const openRailTab = useCallback((view: OutputRailView) => {
    setOpenTabs((tabs) => (tabs.includes(view) ? tabs : [...tabs, view]));
    selectRailView(view);
  }, [selectRailView]);
  const closeRailTab = useCallback((view: OutputRailView) => {
    setOpenTabs((tabs) => {
      const next = tabs.filter((tab) => tab !== view);
      setRailView((current) => (current === view ? next[next.length - 1] ?? null : current));
      return next;
    });
  }, []);
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
  const presentedAppTargetRef = useRef<string | null>(null);
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
  /**
   * 미리보기 ↔ 아래 섹션 분할선 (오너 요구 2026-08-25).
   * 어포던스·키보드·저장 계약은 위 기록 패널 높이 드래그와 동형이다. 차이는 하나 —
   * 여기서는 "정한 적 없음"(null) 이 유효한 상태이고, 그때 미리보기가 남는 높이를
   * 전부 먹는다. 두 번 클릭하면 그 기본으로 되돌아간다.
   */
  const [previewHeight, setPreviewHeight] = useState<number | null>(readOutputPreviewHeight);
  const [previewResizing, setPreviewResizing] = useState(false);
  const previewResizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const livePaneRef = useRef<HTMLDivElement | null>(null);
  const liveListRef = useRef<HTMLDivElement | null>(null);
  const clampPreviewHeight = (value: number) => {
    const available = liveListRef.current?.clientHeight ?? 0;
    const ceiling = available > 0
      ? Math.max(ONE_OUTPUT_PREVIEW_HEIGHT_MIN, available - ONE_OUTPUT_BELOW_MIN)
      : Number.MAX_SAFE_INTEGER;
    return Math.min(ceiling, Math.max(ONE_OUTPUT_PREVIEW_HEIGHT_MIN, Math.round(value)));
  };
  const commitPreviewHeight = (value: number | null) => {
    const next = value === null ? null : clampPreviewHeight(value);
    setPreviewHeight(next);
    try {
      if (next === null) window.localStorage.removeItem(ONE_OUTPUT_PREVIEW_HEIGHT_STORAGE_KEY);
      else window.localStorage.setItem(ONE_OUTPUT_PREVIEW_HEIGHT_STORAGE_KEY, String(next));
    } catch { /* persistence is best effort */ }
  };
  /** 드래그를 시작한 순간의 실제 높이 — null(자동 채움) 상태에서도 이어서 끌 수 있어야 한다. */
  const measuredPreviewHeight = () => previewHeight ?? livePaneRef.current?.clientHeight ?? ONE_OUTPUT_PREVIEW_HEIGHT_MIN;
  const previewSplitHandle = (
    <div
      className={styles.previewSplitHandle}
      role="separator"
      aria-orientation="horizontal"
      aria-label={locale === "ko" ? "미리보기 높이 조절" : "Resize preview"}
      aria-valuemin={ONE_OUTPUT_PREVIEW_HEIGHT_MIN}
      aria-valuenow={Math.round(measuredPreviewHeight())}
      tabIndex={0}
      data-resizing={previewResizing ? "true" : "false"}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        previewResizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: measuredPreviewHeight() };
        event.currentTarget.setPointerCapture(event.pointerId);
        setPreviewResizing(true);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const drag = previewResizeRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        setPreviewHeight(clampPreviewHeight(drag.startHeight + (event.clientY - drag.startY)));
      }}
      onPointerUp={(event) => {
        if (previewResizeRef.current?.pointerId !== event.pointerId) return;
        previewResizeRef.current = null;
        setPreviewResizing(false);
        commitPreviewHeight(measuredPreviewHeight());
      }}
      onPointerCancel={() => {
        previewResizeRef.current = null;
        setPreviewResizing(false);
      }}
      onDoubleClick={() => commitPreviewHeight(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") commitPreviewHeight(measuredPreviewHeight() - 16);
        else if (event.key === "ArrowDown") commitPreviewHeight(measuredPreviewHeight() + 16);
        else if (event.key === "Home") commitPreviewHeight(ONE_OUTPUT_PREVIEW_HEIGHT_MIN);
        else if (event.key === "End") commitPreviewHeight(null);
        else return;
        event.preventDefault();
      }}
    />
  );
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
  const preferredBrowserUrl = currentBrowserUrl
    ?? browserHistoryUrl
    ?? (browserScopeKey ? browserUrlsByScope[browserScopeKey] : undefined);
  const latestArtifactId = items.at(-1)?.id ?? null;
  const activeChatFile = chatFileTabs.find((file) => file.tabId === activeChatFileTabId) ?? null;
  const openedArtifactKind = openedArtifact ? outputPresentationKindForName(openedArtifact.label) : "standard";
  const latestArtifactKind = outputPresentationKindForName(items.at(-1)?.label);
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
    : appPreview
      ? `app:${appPreview.appId}:${appPreview.url}`
    : preferredBrowserUrl
      ? `browser:${preferredBrowserUrl}`
      : resultKey
        ? `result:${resultKey}`
        : `kind:${activeOutputKind}`;
  const appViewId = useMemo(
    () => appPreview ? `one_app_${appPreview.appId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}` : undefined,
    [appPreview?.appId],
  );
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isOneArtifactOpenRequest(detail)) return;
      (onRequestReadableWidth ?? onResize)?.(Math.min(maxWidth, 560));
      setOpenedArtifact(detail);
      setActiveChatFileTabId(null);
      setRailView("result");
    };
    window.addEventListener(ONE_ARTIFACT_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(ONE_ARTIFACT_OPEN_EVENT, handleOpen);
  }, [maxWidth, onRequestReadableWidth, onResize]);
  useEffect(() => {
    setChatFileTabs([]);
    setActiveChatFileTabId(null);
    onRestorePreferredWidth?.();
  }, [browserScopeKey, onRestorePreferredWidth]);
  useEffect(() => {
    const handleChatFile = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isChatFileItem(detail) || (browserScopeKey && detail.chatId !== browserScopeKey)) return;
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
  }, [browserScopeKey, maxWidth, onRequestReadableWidth, onResize]);
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
      const candidate = detail as { href?: unknown; fileUrl?: unknown };
      const url = typeof candidate.href === "string" && /^https?:\/\//iu.test(candidate.href)
        ? candidate.href
        : typeof candidate.fileUrl === "string" && /^https?:\/\//iu.test(candidate.fileUrl)
          ? candidate.fileUrl
          : null;
      if (!url) return;
      const scope = browserScopeKey ?? "unscoped";
      setBrowserUrlsByScope((current) => current[scope] === url ? current : { ...current, [scope]: url });
      setRailView("browser");
    };
    window.addEventListener("agentlas:in-app-linked-file", handleInAppLink);
    return () => window.removeEventListener("agentlas:in-app-linked-file", handleInAppLink);
  }, [browserScopeKey]);
  useEffect(() => {
    if (result || !latestArtifactId || presentedArtifactIdRef.current === latestArtifactId) return;
    presentedArtifactIdRef.current = latestArtifactId;
    // 자동 표시는 Browser 를 빼앗지 않는다 — 브라우저 작업 자체가 산출물이고, 새 아티팩트가
    // 도착할 때마다 Activity 로 튕기면 사람이 보던 화면이 사라진다(P0: 재열람 시 Browser 유지).
    setRailView((current) => (current === "browser" ? current : "activity"));
  }, [latestArtifactId, result]);
  useEffect(() => {
    const latest = mcpResults.at(-1)?.id ?? null;
    if (!latest || presentedMcpResultIdRef.current === latest) return;
    presentedMcpResultIdRef.current = latest;
    setOpenTabs((tabs) => (tabs.includes("activity") ? tabs : [...tabs, "activity"]));
    // Keep a user-selected Result/Browser/App view stable; otherwise expose
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
    setRailView((current) => current === "app" ? current : "browser");
    onBrowserObserved?.(preferredBrowserUrl);
  }, [browserScopeKey, onBrowserObserved, preferredBrowserUrl]);
  useEffect(() => {
    if (!appPreview?.url) {
      presentedAppTargetRef.current = null;
      setOpenTabs((tabs) => tabs.filter((tab) => tab !== "app"));
      if (railView === "app") setRailView(null);
      return;
    }
    const targetKey = `${appPreview.appId}\u0000${appPreview.url}`;
    if (presentedAppTargetRef.current === targetKey) return;
    presentedAppTargetRef.current = targetKey;
    // The app itself is the primary output. Open it once when the verified
    // preview becomes reachable, but do not fight a user's later tab choice.
    setOpenTabs((tabs) => (tabs.includes("app") ? tabs : [...tabs, "app"]));
    setRailView("app");
  }, [appPreview?.appId, appPreview?.url, railView]);
  useEffect(() => {
    if (!result || !resultKey || presentedResultKeyRef.current === resultKey) return;
    presentedResultKeyRef.current = resultKey;
    // 결과가 나오면 그 탭이 하나 생긴다. 다만 확인된 Browser/App 표면 위로는
    // 올라오지 않는다 — 탭만 만들고 보고 있던 것을 빼앗지 않는다.
    setOpenTabs((tabs) => (tabs.includes("result") ? tabs : [...tabs, "result"]));
    setRailView((current) => (current === "browser" || current === "app" ? current : "result"));
  }, [result, resultKey]);
  /*
   * 폭을 저 혼자 넓히던 자리(제거, 오너 지시 2026-08-24 "디폴트로 접히고
   * 켜져도 지금의 반만"). 넓은 산출물이 뜰 때마다 화면의 43% 로 벌어지고
   * 그 값이 저장까지 돼서, 기본 폭을 아무리 줄여도 다음 실행이 다시
   * 579px 로 되돌려 놓았다(실측). 폭은 이제 사람이 끌 때만 바뀐다.
   */
  useEffect(() => {
    if (!onResize) return;
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
      onResize(ready ? minWidth : Math.min(maxWidth, Math.max(minWidth, Math.round(rawWidth))));
      event.preventDefault();
    };
    const finish = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const shouldCollapse = event.type === "pointerup" && drag.rawWidth <= collapseThreshold;
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
  const rowResizing = previewResizing || historyResizing;
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
        <button
          type="button"
          className={styles.artifactResizeHandle}
          aria-label={locale === "ko" ? "출력 패널 너비 조절" : "Resize output panel"}
          title={locale === "ko" ? "드래그하거나 화살표 키로 너비 조절" : "Drag or use arrow keys to resize"}
          data-one-rail-resize="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.focus({ preventScroll: true });
            const startWidth = width ?? defaultWidth;
            resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, rawWidth: startWidth };
            setResizing(true);
            setCollapseReady(false);
            event.preventDefault();
          }}
          onClick={(event) => event.currentTarget.focus({ preventScroll: true })}
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
          {openTabs.map((view) => (
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
                onClick={() => closeRailTab(view)}
              >
                <IconClose size={11} />
              </button>
            </span>
          ))}
          <span className={styles.artifactAddWrap}>
            <button
              type="button"
              aria-label={locale === "ko" ? "보기 추가" : "Add view"}
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((value) => !value)}
            ><IconPlus size={15} /></button>
            {addMenuOpen && (
              <div className={styles.artifactAddMenu} role="menu">
                {(["activity", "terminal", "browser"] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    role="menuitem"
                    disabled={openTabs.includes(view)}
                    onClick={() => { setAddMenuOpen(false); openRailTab(view); }}
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
            {(["activity", "terminal", "browser"] as const).map((view) => (
              <button key={view} type="button" onClick={() => openRailTab(view)}>{railTabLabel(view, locale)}</button>
            ))}
          </div>
        </div>
      )}
      <div className={styles.artifactContentStack}>
      <div
        className={styles.artifactList}
        ref={liveListRef}
        /* 분할선이 있는 뷰(브라우저)에서 사용자가 높이를 정했을 때만 고정한다 — 앱 뷰는
           아래에 맞바꿀 섹션이 없어 분할선을 달지 않는다. */
        data-preview-fixed={railView === "browser" && previewHeight != null ? "true" : undefined}
        style={railView === "browser" && previewHeight != null
          ? ({ "--one-preview-height": `${previewHeight}px` } as React.CSSProperties)
          : undefined}
      >
        {railView === "result" && (activeChatFile || openedArtifact || result) && <div className={styles.resultView}>
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
            <ArtifactOpenViewer target={openedArtifact} locale={locale} wide={isWideOutputKind(activeOutputKind) || (width ?? defaultWidth) >= 560} />
          </>}
          {!activeChatFile && !openedArtifact && result}
        </div>}
        {railView === "activity" && <>
          <OutputDisclosure section="files" label={locale === "ko" ? "결과물" : "Artifacts"} count={items.length} expanded={sectionExpanded("files")} onToggle={toggleSection}>
            {items.length === 0 && <p className={styles.artifactEmpty}>{locale === "ko" ? "만든 파일 또는 사이트가 여기에 표시됩니다" : "Files or sites you create appear here"}</p>}
            {items.map((item) => <ArtifactPreviewCard key={item.id} item={item} locale={locale} wide={(width ?? defaultWidth) >= 560} />)}
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
        {railView === "browser" && <>
          <div className={styles.livePane} ref={livePaneRef}>
            <OneBrowserLiveView active={railView === "browser"} locale={locale} preferredUrl={preferredBrowserUrl} previewScopeId={browserScopeKey} />
          </div>
          {previewSplitHandle}
          <div className={styles.liveBelow}>
            <OutputDisclosure section="sources" label={locale === "ko" ? "출처" : "Sources"} count={sources.length} expanded={sectionExpanded("sources")} onToggle={toggleSection}>
              {sources.length === 0
                ? <p className={styles.artifactEmpty}>{locale === "ko" ? "브라우저 출처 없음" : "No browser sources"}</p>
                : sources.slice(-5).map((source) => <SourceRow key={source.id} source={source} />)}
            </OutputDisclosure>
          </div>
        </>}
        {railView === "app" && appPreview && appViewId && (
          <div className={styles.livePane} ref={livePaneRef}>
            <div {...designOutputSurfaceProps("web", styles.appPreviewView)} data-one-live-app="true" data-app-id={appPreview.appId}>
              <LiveDeviceMockup
                url={appPreview.url}
                title={appPreview.title}
                runtimeLabel={appPreview.runtime ?? "managed preview"}
                locale={locale}
                viewId={appViewId}
                onClose={onClose}
              />
            </div>
          </div>
        )}
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
