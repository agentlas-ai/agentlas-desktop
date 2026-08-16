"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconCode,
  IconFileUp,
  IconFolder,
  IconImage,
  IconPanelRight,
  IconPlus,
  IconShield,
  IconSparkles,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import type {
  OneActivityCode,
  OneActivityArtifact,
  OneActivityItem,
  OneActivitySource,
  OneActivityState,
} from "@/lib/one-activity";
import { buildToolCallDisplay, normalizeToolCall } from "@shared/tool-call-detail";
import { isCommandTool, isComputerUseTool } from "@shared/tool-taxonomy";
import type { OnePermissionMode } from "./OneComposerControls";
import styles from "./OneActivityTimeline.module.css";

const ONE_OUTPUT_SECTIONS_STORAGE_KEY = "agentlas.one.output-sections.v1";
type OutputSectionKey = "files" | "agents" | "processes" | "computer" | "sources";

function readCollapsedOutputSections(): Set<OutputSectionKey> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored = JSON.parse(window.localStorage.getItem(ONE_OUTPUT_SECTIONS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(stored)) return new Set();
    const allowed = new Set<OutputSectionKey>(["files", "agents", "processes", "computer", "sources"]);
    return new Set(stored.filter((value): value is OutputSectionKey => typeof value === "string" && allowed.has(value as OutputSectionKey)));
  } catch {
    return new Set();
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
        ? (locale === "ko" ? "작업 중" : "Working")
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
  const secondary = [toolSummary, toolOwner].filter(Boolean).join(" · ")
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
    return <div className={styles.row} data-kind={item.kind} data-status={item.status}>{content}</div>;
  }
  return (
    <details className={styles.rowDetails} data-kind={item.kind} data-status={item.status}>
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
      className={styles.activity}
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

async function openArtifact(item: OneActivityArtifact): Promise<void> {
  const bridge = ipc();
  if (!bridge?.oneArtifacts?.open) return;
  await bridge.oneArtifacts.open(item.binding).catch(() => ({ opened: false }));
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
  minWidth = 300,
  maxWidth = 720,
  defaultWidth = 420,
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
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
}) {
  const [collapsedSections, setCollapsedSections] = useState<Set<OutputSectionKey>>(readCollapsedOutputSections);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const clampWidth = (value: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
  const agents = useMemo(() => {
    const candidates = activity?.items.filter((item) => item.kind === "agent" || (item.kind === "tool" && item.agentName)) ?? [];
    const unique = new Map<string, OneActivityItem>();
    for (const item of candidates) {
      const key = localeSafeRuntimeText(item.agentName, locale, true) || item.id;
      if (!unique.has(key)) unique.set(key, item);
    }
    return [...unique.values()];
  }, [activity?.items, locale]);
  /*
   * 분류는 도구 이름의 단어가 아니라 그 도구가 한 일로 한다 — shared/tool-taxonomy.ts.
   * 단어 매칭은 claude 의 `Bash` 하나만 잡고 codex `bash`(소문자 통과), grok `write`,
   * agy `write_to_file`, ACP 의 kind 는 전부 놓쳤다. 그래서 이 두 칸은 대부분의
   * 런타임에서 늘 0 이었다.
   */
  const processes = activity?.items.filter((item) => item.kind === "tool" && isCommandTool(item.tool?.name)) ?? [];
  const computerUse = activity?.items.filter((item) => item.kind === "tool" && isComputerUseTool(item.tool?.name)) ?? [];
  const sources = activity?.sources ?? [];
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
      className={styles.artifactRail}
      aria-label={locale === "ko" ? "작업 산출물" : "Work outputs"}
      data-one-runtime-artifacts="true"
      data-resizing={resizing ? "true" : "false"}
      style={width ? { width } : undefined}
    >
      {onResize && (
        // Drag the left edge to resize (owner request 2026-08-16). Keyboard:
        // ←/→ move 16px, Home/End jump to the bounds, double-click resets.
        <div
          className={styles.artifactResizeHandle}
          role="separator"
          aria-orientation="vertical"
          aria-label={locale === "ko" ? "출력 패널 너비 조절" : "Resize output panel"}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={width ?? defaultWidth}
          tabIndex={0}
          data-one-rail-resize="true"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width ?? defaultWidth };
            event.currentTarget.setPointerCapture(event.pointerId);
            setResizing(true);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            const drag = resizeRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            // The rail sits on the right: dragging left widens it.
            onResize(clampWidth(drag.startWidth + (drag.startX - event.clientX)));
          }}
          onPointerUp={(event) => {
            if (resizeRef.current?.pointerId !== event.pointerId) return;
            resizeRef.current = null;
            setResizing(false);
          }}
          onPointerCancel={() => {
            resizeRef.current = null;
            setResizing(false);
          }}
          onDoubleClick={() => onResize(defaultWidth)}
          onKeyDown={(event) => {
            const current = width ?? defaultWidth;
            if (event.key === "ArrowLeft") onResize(clampWidth(current + 16));
            else if (event.key === "ArrowRight") onResize(clampWidth(current - 16));
            else if (event.key === "Home") onResize(maxWidth);
            else if (event.key === "End") onResize(minWidth);
            else return;
            event.preventDefault();
          }}
        />
      )}
      <header>
        <strong>{locale === "ko" ? "출력" : "Outputs"}</strong>
        <div className={styles.artifactHeaderActions}>
          <button type="button" onClick={onAdd} aria-label={locale === "ko" ? "파일 추가" : "Add file"}><IconPlus size={15} /></button>
          {onClose && <button type="button" onClick={onClose} aria-label={locale === "ko" ? "출력 패널 접기" : "Collapse output panel"}><IconClose size={15} /></button>}
        </div>
      </header>
      <div className={styles.artifactList}>
        <OutputDisclosure section="files" label={locale === "ko" ? "결과물" : "Artifacts"} count={items.length} expanded={sectionExpanded("files")} onToggle={toggleSection}>
          {items.length === 0 && <p className={styles.artifactEmpty}>{locale === "ko" ? "만든 파일 또는 사이트가 여기에 표시됩니다" : "Files or sites you create appear here"}</p>}
          {items.map((item) => (
            <button key={item.id} type="button" className={styles.artifact} onClick={() => void openArtifact(item)} title={item.label}>
              <span className={styles.artifactFileIcon}><IconFileUp size={16} /></span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.kind === "image" ? <><IconImage size={11} /> {locale === "ko" ? "이미지" : "Image"}</> : <><IconFolder size={11} /> {locale === "ko" ? "파일" : "File"}</>}</small>
              </span>
            </button>
          ))}
        </OutputDisclosure>
        <OutputDisclosure section="agents" label={locale === "ko" ? "하위 에이전트" : "Subagents"} count={agents.length} expanded={sectionExpanded("agents")} onToggle={toggleSection}>
          {agents.length === 0
            ? <p className={styles.artifactEmpty}>{locale === "ko" ? "실행된 하위 에이전트 없음" : "No subagents used"}</p>
            : agents.slice(-5).map((item) => <div key={item.id} className={styles.artifactRuntimeRow}><IconSparkles size={13} /><span>{item.agentName || (locale === "ko" ? "에이전트" : "Agent")}</span><small>{item.status === "completed" ? "✓" : ""}</small></div>)}
        </OutputDisclosure>
        {/* A completed shell tool is evidence of a command, not proof that a
            persistent background process exists. The prior label fabricated
            process lifetime from ordinary terminal events. */}
        <OutputDisclosure section="processes" label={locale === "ko" ? "명령" : "Commands"} count={processes.length} expanded={sectionExpanded("processes")} onToggle={toggleSection}>
          {processes.length === 0
            ? <p className={styles.artifactEmpty}>{locale === "ko" ? "실행된 명령 없음" : "No commands run"}</p>
            : processes.slice(-3).map((item) => <div key={item.id} className={styles.artifactRuntimeRow}><IconCode size={13} /><span>{item.tool?.name || (locale === "ko" ? "명령" : "Command")}</span><small>{item.status === "completed" ? "✓" : ""}</small></div>)}
        </OutputDisclosure>
        <OutputDisclosure section="computer" label={locale === "ko" ? "컴퓨터 사용" : "Computer use"} count={computerUse.length} expanded={sectionExpanded("computer")} onToggle={toggleSection}>
          {computerUse.length === 0
            ? <p className={styles.artifactEmpty}>{locale === "ko" ? "사용 기록 없음" : "No computer activity"}</p>
            : computerUse.slice(-3).map((item) => <div key={item.id} className={styles.artifactRuntimeRow}><IconPanelRight size={13} /><span>{item.tool?.name || (locale === "ko" ? "컴퓨터 작업" : "Computer task")}</span><small>{item.status === "completed" ? "✓" : ""}</small></div>)}
        </OutputDisclosure>
        <OutputDisclosure section="sources" label={locale === "ko" ? "출처" : "Sources"} count={sources.length} expanded={sectionExpanded("sources")} onToggle={toggleSection}>
          {sources.length === 0
            ? <p className={styles.artifactEmpty}>{locale === "ko" ? "사용된 출처 없음" : "No sources used"}</p>
            : sources.slice(-5).map((source) => <SourceRow key={source.id} source={source} />)}
        </OutputDisclosure>
      </div>
    </aside>
  );
}

function SourceRow({ source }: { source: OneActivitySource }) {
  return <a className={styles.artifactRuntimeRow} href={source.url} target="_blank" rel="noreferrer" title={source.url}>
    <IconFileUp size={13} /><span>{source.label}</span><small>{source.status === "completed" ? "✓" : ""}</small>
  </a>;
}
