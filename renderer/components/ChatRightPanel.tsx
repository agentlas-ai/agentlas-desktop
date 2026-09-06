// Unified right rail for chat: files, agent workflow, and artifact/viewer panel.
"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Markdown, type CodeArtifact } from "./Markdown";
import { WorkspacePanel, type WorkspaceFilePreview } from "./WorkspacePanel";
import {
  AgentNetworkPanel,
  type LiveAgent,
  type NetTimelineItem,
} from "./AgentNetworkPanel";
import {
  WorkbenchPanel,
  type SurfaceActionHandler,
  type SurfaceStatePatchHandler,
  type WorkbenchSurface,
} from "./WorkbenchPanel";
import type { InstalledAgent, InstalledFirm, InvocationRunReceipt, Project, ProjectTimelineSnapshot, ResolvedOrg } from "@/lib/types";
import { IconClose, IconFileUp, IconFilm, IconFolder, IconImage, IconLayers, IconNetwork, IconPanelRight, IconPlus, IconSparkles } from "./Icon";
import railStyles from "./one/OneActivityTimeline.module.css";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { receiptAutoExpanded } from "@/lib/run-receipt-state";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { projectPoolMemberKey } from "@shared/project-agent-pool";
import { LiveOutputViewer, type LiveOutputKind } from "./LiveOutputViewer";
import { CodeIdeViewer, isCodeArtifactName } from "./CodeIdeViewer";
import { NativeLiveWebView } from "./NativeLiveWebView";
import { RailAgentScreen } from "./browser/RailAgentScreen";
import type { AgentScreenMode } from "./browser/AgentScreenView";
import {
  isWideOutputKind,
  outputPresentationKindForViewerKind,
  outputPresentationKindForWorkbenchManifest,
  preferredOutputRailWidth,
  type OutputPresentationKind,
} from "@/lib/output-presentation";
import { ChatFileTabs, nextFileTabSelection, type ChatFileTab } from "./ChatFileExperience";
import { previewTabIdentity } from "@/lib/chat-files";

export type ChatRightPanelTab = "agent" | "file" | "panel" | "memory";
type PanelViewerSource = "workbench" | "file";

type OutputRow = {
  key: string;
  title: string;
  meta: string;
  icon: ReactNode;
  action: () => void;
};

interface Props {
  /**
   * 에이전트가 지금 보고 있는 화면(브라우저·컴퓨터). One 과 같은 자리 — 결과 레일 안이다.
   * 떠 있는 카드로 떨어져 나가지 않는다.
   */
  agentScreen?: { mode: AgentScreenMode } | null;
  onAgentScreenMode?: (mode: AgentScreenMode) => void;
  activeTab: ChatRightPanelTab;
  onTabChange: (tab: ChatRightPanelTab) => void;
  onClose: () => void;
  chatId: string | null;
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
  filePreview?: WorkspaceFilePreview | null;
  linkedFiles?: WorkspaceFilePreview[];
  /** Files the agent changed or linked as a result; read-only inputs stay out of this list. */
  linkedOutputs?: WorkspaceFilePreview[];
  onSurfaceAction?: SurfaceActionHandler;
  onSurfaceStatePatch?: SurfaceStatePatchHandler;
  firm: InstalledFirm | null;
  org: ResolvedOrg | null;
  agent: InstalledAgent | null;
  agents: InstalledAgent[];
  project: Project | null;
  busy: boolean;
  liveAgents: Record<string, LiveAgent>;
  timeline: NetTimelineItem[];
  chatTitle: string;
  latestUserPrompt: string;
  hasPipeline?: boolean;
  width?: number;
  onResizeWidth?: (width: number) => void;
  /** Temporary auto-width for readable output; the parent must not persist it. */
  onRequestReadableWidth?: (width: number) => void;
  /** Called after the final file tab closes so the saved width can be restored. */
  onFileTabsEmpty?: () => void;
  /** null = 세로 전체(기본). 숫자 = 상단 가장자리를 끌어 줄여 둔 높이. */
  height?: number | null;
  onResizeHeight?: (height: number | null) => void;
  /** 파일을 **내용까지 읽어서** 뷰어에 올린다. 부모만 chatId 스코프의 fs 접근을 갖는다. */
  onHydrateFilePreview?: (preview: WorkspaceFilePreview) => void | Promise<void>;
}

export function ChatRightPanel({
  activeTab,
  onTabChange,
  onClose,
  chatId,
  artifact,
  surface,
  filePreview: externalFilePreview,
  onHydrateFilePreview,
  linkedFiles = [],
  linkedOutputs = [],
  agentScreen,
  onAgentScreenMode,
  onSurfaceAction,
  onSurfaceStatePatch,
  firm,
  org,
  agent,
  agents,
  project,
  busy,
  liveAgents,
  timeline,
  chatTitle,
  latestUserPrompt,
  hasPipeline,
  width,
  onResizeWidth,
  onRequestReadableWidth,
  onFileTabsEmpty,
  height,
  onResizeHeight,
}: Props) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [openViews, setOpenViews] = useState<ChatRightPanelTab[]>([activeTab]);
  const [addViewOpen, setAddViewOpen] = useState(false);
  const viewMenuRef = useRef<HTMLSpanElement | null>(null);
  const viewLabels: Record<ChatRightPanelTab, string> = {
    agent: ko ? "작업" : "Activity", file: ko ? "파일" : "Files",
    panel: ko ? "미리보기" : "Preview", memory: ko ? "기억" : "Memory",
  };
  useEffect(() => {
    setOpenViews([activeTab]);
    setAddViewOpen(false);
  }, [chatId]);
  useEffect(() => {
    setOpenViews((views) => views.includes(activeTab) ? views : [...views, activeTab]);
  }, [activeTab]);
  useEffect(() => {
    if (!addViewOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !viewMenuRef.current?.contains(event.target)) setAddViewOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setAddViewOpen(false); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape, true); };
  }, [addViewOpen]);
  const closeView = (view: ChatRightPanelTab) => {
    const remaining = openViews.filter((item) => item !== view);
    if (!remaining.length) { onClose(); return; }
    setOpenViews(remaining);
    if (activeTab === view) onTabChange(remaining[remaining.length - 1]);
  };
  const [filePreview, setFilePreview] = useState<WorkspaceFilePreview | null>(null);
  const [fileTabs, setFileTabs] = useState<Array<ChatFileTab & { preview: WorkspaceFilePreview }>>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [viewerSource, setViewerSource] = useState<PanelViewerSource>("workbench");
  const [resizing, setResizing] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const shellRef = useRef<HTMLElement | null>(null);

  // 패널이 세로로 차지할 수 있는 최대치 — 부모(task-cockpit-shell)의 실제 높이다.
  function availableHeight() {
    const parent = shellRef.current?.parentElement;
    return parent?.clientHeight || (typeof window === "undefined" ? 720 : window.innerHeight);
  }
  const hasPanelContent = Boolean(artifact || surface || filePreview || externalFilePreview || linkedOutputs.length > 0);
  const showFilePreview = viewerSource === "file" && filePreview;
  const showWorkbench = viewerSource === "workbench" && (artifact || surface);
  const outputKind: OutputPresentationKind = showFilePreview
    ? outputPresentationKindForViewerKind(showFilePreview.viewerKind)
    : artifact
      ? "code"
      : outputPresentationKindForWorkbenchManifest(surface?.manifest as unknown as Record<string, unknown> | null);
  const outputIdentity = showFilePreview
    ? `file:${showFilePreview.viewerKind}:${showFilePreview.path || showFilePreview.fileUrl}`
    : artifact
      ? `code:${artifact.id}`
      : surface
        ? `surface:${surface.id}`
        : "empty";
  useEffect(() => {
    setFilePreview(null);
    setFileTabs([]);
    setActiveFileTabId(null);
    setViewerSource("workbench");
  }, [chatId]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setIsNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // ★저장된 높이는 마운트 즉시 재검사해야 한다. 큰 화면에서 줄여 둔 값을 작은 화면에서
  //   그대로 쓰면, 부모가 overflow:hidden 이고 패널이 하단 정렬이라 헤더·탭·닫기 버튼이
  //   위로 잘려 나가 패널을 아예 조작할 수 없게 된다.
  useEffect(() => {
    if (typeof height !== "number" || !onResizeHeight) return;
    const check = () => {
      if (height >= availableHeight()) onResizeHeight(null);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [height, onResizeHeight]);

  useEffect(() => {
    if (artifact || surface) setViewerSource("workbench");
  }, [artifact?.id, surface?.id]);

  /*
   * ★사본은 **내용이 채워질 때도** 따라가야 한다(2026-09-04 실측).
   *
   * 부모는 자리를 먼저 열고 파일을 읽어 같은 경로의 미리보기를 내용과 함께 다시 보낸다.
   * 그런데 이 복사는 의존성이 경로·URL 뿐이라 두 번째(내용 있는) 판을 무시했고, 화면에는
   * 내용 없는 첫 판이 그대로 남아 "이 파일의 내용을 읽지 못했습니다" 가 떴다.
   * 방금 에이전트가 만든 파일이 영영 안 열렸다 — 읽기는 88자를 정상으로 돌려주고 있었다.
   */
  useEffect(() => {
    if (!externalFilePreview) return;
    const id = previewTabIdentity(externalFilePreview);
    setFileTabs((current) => current.some((tab) => tab.id === id)
      ? current.map((tab) => tab.id === id ? { ...tab, name: externalFilePreview.name, preview: externalFilePreview } : tab)
      : [...current, { id, name: externalFilePreview.name, provenance: "linked-file", preview: externalFilePreview }]);
    setActiveFileTabId(id);
    setFilePreview(externalFilePreview);
    setViewerSource("file");
  }, [externalFilePreview]);

  // The parent clears its chat-scoped preview during navigation. Clear the
  // panel's local copy too; otherwise a persisted open-rail preference can
  // remount the panel with the previous chat's file still selected.
  useEffect(() => {
    if (externalFilePreview || fileTabs.length > 0) return;
    setFilePreview(null);
    setViewerSource("workbench");
  }, [externalFilePreview, fileTabs.length]);

  const selectFileTab = useCallback((id: string) => {
    const target = fileTabs.find((tab) => tab.id === id);
    if (!target) return;
    setActiveFileTabId(id);
    setFilePreview(target.preview);
    setViewerSource("file");
  }, [fileTabs]);
  const closeFileTab = useCallback((id: string) => {
    const nextActive = nextFileTabSelection(fileTabs, id, activeFileTabId);
    const nextTabs = fileTabs.filter((tab) => tab.id !== id);
    setFileTabs(nextTabs);
    setActiveFileTabId(nextActive);
    if (nextTabs.length === 0) onFileTabsEmpty?.();
    if (activeFileTabId !== id) return;
    const target = nextTabs.find((tab) => tab.id === nextActive) ?? null;
    setFilePreview(target?.preview ?? null);
    if (!target) {
      setViewerSource("workbench");
    }
  }, [activeFileTabId, fileTabs, onFileTabsEmpty]);

  useEffect(() => {
    const requestWidth = onRequestReadableWidth ?? onResizeWidth;
    if (!requestWidth || activeTab !== "panel" || !isWideOutputKind(outputKind)) return;
    // The right rail widens once for a new rich result. The width dependency is
    // intentionally omitted so a person can drag the same result narrower
    // without React immediately fighting the explicit resize.
    const currentWidth = width ?? 392;
    const preferred = typeof window === "undefined"
      ? 640
      : preferredOutputRailWidth(window.innerWidth, 320, 1280);
    if (currentWidth < preferred) requestWidth(preferred);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, onRequestReadableWidth, onResizeWidth, outputIdentity, outputKind]);

  const expandFilePreview = useCallback(() => {
    const requestWidth = onRequestReadableWidth ?? onResizeWidth;
    if (!requestWidth) return;
    const maxWidth = typeof window === "undefined"
      ? 960
      : Math.max(560, Math.min(1280, window.innerWidth - 420));
    requestWidth(maxWidth);
  }, [onRequestReadableWidth, onResizeWidth]);

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onResizeWidth) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width ?? 392;
    const maxWidth = window.innerWidth <= 760
      ? Math.max(320, window.innerWidth - 40)
      : Math.max(320, Math.min(1280, window.innerWidth - 520));
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.round(startWidth + startX - moveEvent.clientX);
      onResizeWidth(Math.min(maxWidth, Math.max(300, next)));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function beginResizeHeight(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onResizeHeight || isNarrow) return;
    event.preventDefault();
    const startY = event.clientY;
    const available = availableHeight();
    const startHeight = height ?? available;
    setResizing(true);
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const onMove = (moveEvent: PointerEvent) => {
      // ★좁은 화면에서는 globals.css가 height 를 !important 로 덮는다. 드래그 도중
      //   경계를 넘어가면 계산값이 반영되지 않으면서 저장만 되어 값이 튄다 — 즉시 중단.
      if (window.innerWidth <= 760) { onUp(); return; }
      const next = Math.round(startHeight + startY - moveEvent.clientY);
      const clamped = Math.min(available, Math.max(RIGHT_PANEL_MIN_HEIGHT, next));
      // 다시 꽉 채우면 null 로 되돌려 창 크기 변화를 그대로 따라가게 둔다.
      onResizeHeight(clamped >= available ? null : clamped);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function resizeHeightByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!onResizeHeight || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const available = availableHeight();
    const current = height ?? available;
    const next = event.key === "Home"
      ? RIGHT_PANEL_MIN_HEIGHT
      : event.key === "End"
        ? available
        : current + (event.key === "ArrowUp" ? 16 : -16);
    const clamped = Math.min(available, Math.max(RIGHT_PANEL_MIN_HEIGHT, next));
    onResizeHeight(clamped >= available ? null : clamped);
  }

  function resizeByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!onResizeWidth || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = width ?? 392;
    const maxWidth = window.innerWidth <= 760
      ? Math.max(320, window.innerWidth - 40)
      : Math.max(320, Math.min(1280, window.innerWidth - 520));
    const next = event.key === "Home"
      ? 320
      : event.key === "End"
        ? maxWidth
        : current + (event.key === "ArrowLeft" ? 16 : -16);
    onResizeWidth(Math.min(maxWidth, Math.max(320, next)));
  }

  return (
    <aside
      ref={shellRef}
      className="chat-right-panel titlebar-nodrag"
      data-active-tab={activeTab}
      data-rich-output={activeTab === "panel" && hasPanelContent ? "true" : "false"}
      data-output-kind={outputKind}
      data-output-wide={isWideOutputKind(outputKind) ? "true" : "false"}
      data-output-auto-width={activeTab === "panel" && isWideOutputKind(outputKind) ? "true" : "false"}
      data-resizing={resizing ? "true" : "false"}
      data-height-adjusted={typeof height === "number" ? "true" : "false"}
      style={{
        ...shellStyle,
        width: width ?? shellStyle.width,
        maxWidth: "none",
        height: typeof height === "number" ? height : shellStyle.height,
        // 아래를 기준으로 줄어든다 — 상단 가장자리를 끄는 방향과 일치한다.
        // 비는 위쪽은 채우지 않고 페이지 배경을 그대로 노출한다(오너 결정).
        alignSelf: typeof height === "number" ? "flex-end" : undefined,
        transition: resizing ? "none" : shellStyle.transition,
      }}
    >
      {onResizeWidth && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={1280}
          aria-valuenow={width ?? 392}
          aria-label={ko ? "우측 패널 너비" : "Right panel width"}
          title={ko ? "패널 너비 조절" : "Resize panel"}
          onPointerDown={beginResize}
          onKeyDown={resizeByKeyboard}
          style={resizeHandleStyle}
        />
      )}
      {onResizeHeight && !isNarrow && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-valuemin={RIGHT_PANEL_MIN_HEIGHT}
          aria-valuenow={typeof height === "number" ? height : undefined}
          aria-label={ko ? "우측 패널 높이" : "Right panel height"}
          title={ko ? "패널 높이 조절 (더블클릭: 전체 높이)" : "Resize panel height (double-click: full height)"}
          onPointerDown={beginResizeHeight}
          onKeyDown={resizeHeightByKeyboard}
          onDoubleClick={() => onResizeHeight(null)}
          style={resizeHeightHandleStyle}
        />
      )}
      <nav className={railStyles.artifactTabs} aria-label={ko ? "출력 보기" : "Output views"} role="tablist">
        <div className={railStyles.artifactTabList}>
          {openViews.map((view) => (
            <span key={view} className={railStyles.artifactTab} data-active={activeTab === view ? "true" : "false"}>
              <button type="button" role="tab" data-right-panel-tab={view} aria-selected={activeTab === view} onClick={() => onTabChange(view)}>
                {view === "agent" ? <IconNetwork size={13} /> : view === "file" ? <IconFolder size={13} /> : view === "memory" ? <IconSparkles size={13} /> : <IconPanelRight size={13} />}
                {viewLabels[view]}
                {view === "agent" && (busy || Object.values(liveAgents).some((entry) => entry.active)) && <span aria-label={ko ? "실행 중" : "Running"}>·</span>}
              </button>
              <button type="button" className={railStyles.artifactTabClose} aria-label={ko ? `${viewLabels[view]} 닫기` : `Close ${viewLabels[view]}`} onClick={() => closeView(view)}><IconClose size={11} /></button>
            </span>
          ))}
          <span ref={viewMenuRef} className={railStyles.artifactAddWrap}>
            <button type="button" aria-label={ko ? "보기 추가" : "Add view"} aria-haspopup="menu" aria-expanded={addViewOpen} onClick={() => setAddViewOpen(!addViewOpen)}><IconPlus size={15} /></button>
            {addViewOpen && <div className={railStyles.artifactAddMenu} role="menu">
              {(["agent", "file", "panel", "memory"] as const).map((view) => <button key={view} type="button" role="menuitem" disabled={openViews.includes(view)} onClick={() => { setAddViewOpen(false); onTabChange(view); }}>{viewLabels[view]}</button>)}
            </div>}
          </span>
        </div>
        <div className={railStyles.artifactHeaderActions}>
          <button type="button" onClick={onClose} aria-label={ko ? "출력 패널 접기" : "Collapse output panel"}><IconClose size={15} /></button>
        </div>
      </nav>

      <div style={bodyStyle} data-right-panel-body={activeTab}>
        {activeTab === "file" && (
          <FileTab
            artifact={artifact}
            surface={surface}
            onOpenPanel={() => {
              setViewerSource("workbench");
              onTabChange("panel");
            }}
            onOpenFilePreview={(preview) => {
              /* ★파일을 열 때는 **반드시 내용을 읽어서** 연다.
                 링크된 파일 목록이 넘겨주는 preview 는 `content: ""` 인 껍데기다
                 (`workspacePreviewFromLinkedFile`). 예전엔 그걸 그대로 뷰어에 넣어서
                 헤더는 뜨는데 본문만 백지인 화면이 나왔다 — 사용자에게는 "미리보기가
                 아무것도 못 띄운다"로 보였다. 하이드레이션은 부모(TaskCockpit)만 할 수
                 있으므로(chatId 스코프의 fs 접근) 여기서 자체 상태로 처리하지 않는다. */
              if (onHydrateFilePreview) {
                void onHydrateFilePreview(preview);
                onTabChange("panel");
                return;
              }
              setFilePreview(preview);
              setViewerSource("file");
              onTabChange("panel");
            }}
            chatId={chatId}
            linkedFiles={linkedFiles}
            linkedOutputs={linkedOutputs}
            project={project}
          />
        )}
        {activeTab === "agent" && (
          <div style={agentTabStyle}>
            {(Object.values(liveAgents).some((entry) => entry.active || entry.processState === "closed" || entry.processState === "failed") || timeline.length > 0 || hasPipeline) ? <AgentNetworkPanel
              embedded
              firm={firm}
              org={org}
              agent={agent}
              agents={agents}
              busy={busy}
              liveAgents={liveAgents}
              timeline={timeline}
              chatTitle={chatTitle}
              latestUserPrompt={latestUserPrompt}
              hasPipeline={hasPipeline}
            /> : null}
            {project ? <ProjectContextSummary project={project} busy={busy} ko={ko} onOpenMemory={() => onTabChange("memory")} /> : null}
            {project ? <ProjectTeamCard project={project} agents={agents} liveAgents={liveAgents} ko={ko} /> : null}
            <RunReceiptCard chatId={chatId} busy={busy} />
          </div>
        )}
        {activeTab === "panel" && (
          agentScreen ? (
            <RailAgentScreen
              mode={agentScreen.mode}
              active
              onModeChange={(next) => onAgentScreenMode?.(next)}
              ko={ko}
            />
          ) : showFilePreview ? (
            <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
              <ChatFileTabs tabs={fileTabs} activeId={activeFileTabId} locale={ko ? "ko" : "en"} onSelect={selectFileTab} onClose={closeFileTab} />
              <div style={{ minWidth: 0, minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}><FileViewer file={filePreview} onExpand={onResizeWidth || onRequestReadableWidth ? expandFilePreview : undefined} /></div>
            </div>
          ) : showWorkbench ? (
            <WorkbenchPanel
              embedded
              artifact={artifact}
              surface={surface}
              onSurfaceAction={onSurfaceAction}
              onSurfaceStatePatch={onSurfaceStatePatch}
              onClose={onClose}
            />
          ) : filePreview ? (
            <FileViewer file={filePreview} />
          ) : artifact || surface ? (
            <WorkbenchPanel
              embedded
              artifact={artifact}
              surface={surface}
              onSurfaceAction={onSurfaceAction}
              onSurfaceStatePatch={onSurfaceStatePatch}
              onClose={onClose}
            />
          ) : (
            <EmptyViewer />
          )
        )}
        {activeTab === "memory" && <ProjectMemoryCard project={project} busy={busy} ko={ko} />}
      </div>
    </aside>
  );
}

function ProjectTeamCard({
  project,
  agents,
  liveAgents,
  ko,
}: {
  project: Project;
  agents: InstalledAgent[];
  liveAgents: Record<string, LiveAgent>;
  ko: boolean;
}) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const rows = project.agentPool.map((member, index) => {
    const installed = [member.agentId, member.controllerAgentId, member.targetId]
      .map((id) => id ? agentById.get(id) : undefined)
      .find(Boolean);
    const name = installed
      ? (installed.localDisplayName || (ko ? installed.name : installed.nameEn || installed.name))
      : member.nameSnapshot;
    const purpose = installed
      ? (ko ? installed.tagline : installed.taglineEn || installed.tagline)
      : "";
    const identities = new Set([
      member.targetId,
      member.agentId,
      member.controllerAgentId,
      member.firmId,
      member.nameSnapshot,
      name,
    ].filter((value): value is string => Boolean(value)));
    const live = Object.entries(liveAgents).find(([key, entry]) => identities.has(key) || identities.has(entry.name))?.[1];
    return { member, index, name, purpose, live };
  });
  const activeRows = rows.filter((row) => row.live?.active);
  const waitingRows = rows.filter((row) => !row.live?.active);
  const visibleWaitingRows = waitingRows.slice(0, activeRows.length > 0 ? 2 : 3);
  const hiddenWaitingRows = waitingRows.slice(visibleWaitingRows.length);
  const renderRow = ({ member, index, name, purpose, live }: (typeof rows)[number]) => (
    <div key={projectPoolMemberKey(member)} style={{ display: "grid", gridTemplateColumns: "24px minmax(0, 1fr) auto", alignItems: "center", gap: 8, minHeight: 44, fontSize: 12 }}>
      <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: 7, background: live?.active ? "color-mix(in srgb, var(--green-deep) 14%, var(--paper))" : "var(--fill-1)", color: live?.active ? "var(--green-deep)" : "var(--muted-deep)", fontWeight: 800 }}>{index + 1}</span>
      <span style={{ minWidth: 0 }}>
        <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</strong>
        <span style={{ display: "block", marginTop: 2, color: live?.active ? "var(--ink-soft)" : "var(--muted-deep)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {live?.active && live.status ? live.status : purpose || (ko ? "프로젝트에서 필요할 때 참여" : "Joins when the project needs it")}
        </span>
      </span>
      <span style={{ color: live?.active ? "var(--green-deep)" : "var(--muted-deep)", fontSize: 10, fontWeight: live?.active ? 750 : 500 }}>
        {live?.active
          ? (ko ? "실행 중" : "Running")
          : (ko ? "대기" : "Ready")}
      </span>
    </div>
  );
  return <section className={railStyles.artifactSection} style={{ padding: "16px 2px", flexShrink: 0 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: "var(--muted-deep)", textTransform: "uppercase" }}>{ko ? "프로젝트 에이전트" : "Project agents"}</div>
      <span style={{ marginLeft: "auto", color: "var(--muted-deep)", fontSize: 10 }}>{ko ? `${rows.length}명 연결됨` : `${rows.length} connected`}</span>
    </div>
    {activeRows.length > 0 || visibleWaitingRows.length > 0 ? <div style={{ display: "grid", gap: 4, marginTop: 8 }}>{activeRows.map(renderRow)}{visibleWaitingRows.map(renderRow)}</div> : null}
    {hiddenWaitingRows.length > 0 ? (
      <details style={{ marginTop: activeRows.length > 0 ? 8 : 6 }}>
        <summary style={{ cursor: "pointer", minHeight: 32, display: "flex", alignItems: "center", color: "var(--ink-soft)", fontSize: 11.5, fontWeight: 650 }}>
          {ko ? `나머지 에이전트 ${hiddenWaitingRows.length}명 보기` : `Show ${hiddenWaitingRows.length} more agents`}
        </summary>
        <div style={{ display: "grid", gap: 2, paddingTop: 4 }}>{hiddenWaitingRows.map(renderRow)}</div>
      </details>
    ) : null}
    {rows.length === 0 ? <p style={{ margin: "8px 0 0", color: "var(--muted-deep)", fontSize: 11 }}>{ko ? "이 프로젝트에 연결된 에이전트가 없습니다." : "No agents are connected to this project."}</p> : null}
  </section>;
}

function useProjectTimeline(project: Project | null, busy: boolean) {
  const [snapshot, setSnapshot] = useState<ProjectTimelineSnapshot | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const load = useCallback(async () => {
    if (!project) return;
    const api = ipc();
    if (!api) {
      setState("error");
      return;
    }
    try {
      const next = await api.projects.timeline(project.id, 20);
      // generatedAt은 호출마다 바뀌므로 표시 내용만 비교한다 — 내용이 같으면
      // 이전 참조를 유지해 실행 중 2.5초 폴마다 패널이 리렌더되지 않게 한다.
      setSnapshot((prev) =>
        prev
        && prev.projectId === next.projectId
        && prev.truncated === next.truncated
        && JSON.stringify(prev.entries) === JSON.stringify(next.entries)
        && JSON.stringify(prev.sources) === JSON.stringify(next.sources)
          ? prev
          : next);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [project?.id]);

  useEffect(() => {
    setSnapshot(null);
    setState("loading");
    void load();
    if (!busy) return;
    // 숨은 창에서는 폴을 멈추고, 다시 보이면 즉시 한 번 당긴다.
    const tick = () => { if (document.visibilityState !== "hidden") void load(); };
    const onVisible = () => { if (document.visibilityState !== "hidden") void load(); };
    const interval = window.setInterval(tick, 2500);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [busy, load]);

  const retry = useCallback(() => {
    setState("loading");
    void load();
  }, [load]);

  return { snapshot, state, retry };
}

function ProjectContextSummary({
  project,
  busy,
  ko,
  onOpenMemory,
}: {
  project: Project;
  busy: boolean;
  ko: boolean;
  onOpenMemory: () => void;
}) {
  const { snapshot, state } = useProjectTimeline(project, busy);
  const readySources = snapshot?.sources.filter((source) => source.status === "ready") ?? [];
  const sourceName = (kind: ProjectTimelineSnapshot["sources"][number]["kind"]) => ({
    pm_soul: "PM Soul",
    sitemap: ko ? "사이트맵" : "Sitemap",
    code_map: ko ? "코드맵" : "Code map",
  })[kind];
  const instruction = project.systemPrompt?.trim() || (ko ? "프로젝트 지시가 아직 없습니다." : "No project instruction yet.");
  const health = state === "loading"
    ? (ko ? "저장 상태 확인 중…" : "Checking saved state…")
    : state === "error"
      ? (ko ? "저장 상태를 확인할 수 없음" : "Saved state unavailable")
      : readySources.length > 0
        ? readySources.map((source) => sourceName(source.kind)).join(" · ")
        : (ko ? "아직 생성된 기억 자산 없음" : "No memory assets yet");

  return (
    <button
      type="button"
      onClick={onOpenMemory}
      aria-label={ko ? "프로젝트 지시와 기억 자세히 보기" : "Open project instructions and memory"}
      className={railStyles.artifactSection}
      style={{ width: "100%", padding: "16px 2px", flexShrink: 0, borderTop: 0, borderLeft: 0, borderRight: 0, borderRadius: 0, background: "transparent", color: "var(--ink)", textAlign: "left", cursor: "pointer" }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: "var(--muted-deep)", textTransform: "uppercase" }}>{ko ? "프로젝트 맥락" : "Project context"}</span>
        <span style={{ marginLeft: "auto", color: "var(--muted-deep)", fontSize: 10 }}>
          {state === "ready" ? (ko ? `기억 ${snapshot?.entries.length ?? 0}건` : `${snapshot?.entries.length ?? 0} memories`) : ""}
        </span>
      </span>
      <strong style={{ display: "block", marginTop: 8, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{instruction}</strong>
      <span style={{ display: "block", marginTop: 6, color: state === "error" ? "var(--red-deep)" : "var(--muted-deep)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {ko ? "축적 상태 · " : "Saved state · "}{health}
      </span>
    </button>
  );
}

function ProjectMemoryCard({ project, busy, ko }: { project: Project | null; busy: boolean; ko: boolean }) {
  const { snapshot, state, retry } = useProjectTimeline(project, busy);

  if (!project) return <div style={{ padding: 18, color: "var(--muted-deep)", fontSize: 12 }}>{ko ? "이 작업에 연결된 프로젝트가 없습니다." : "No project is connected to this task."}</div>;
  const sourceLabel = (kind: ProjectTimelineSnapshot["sources"][number]["kind"]) => ({
    pm_soul: ko ? "PM Soul" : "PM Soul",
    sitemap: ko ? "사이트맵" : "Sitemap",
    code_map: ko ? "코드맵" : "Code map",
  })[kind];
  const sourceDetail = (source: ProjectTimelineSnapshot["sources"][number]) => {
    if (source.status === "ready") {
      const count = source.detail?.split(":")[1];
      if (source.kind === "pm_soul" && count) return ko ? `${Number(count).toLocaleString()}자 저장됨` : `${Number(count).toLocaleString()} chars saved`;
      if (source.kind === "sitemap" && count) return ko ? `${Number(count).toLocaleString()}개 노드` : `${Number(count).toLocaleString()} nodes`;
      if (source.kind === "code_map" && source.detail) return source.detail.replace("files:", ko ? "파일 " : "files ").replace(",symbols:", ko ? " · 심볼 " : " · symbols ");
      return ko ? "저장됨" : "Ready";
    }
    if (source.status === "missing") return ko ? "아직 생성되지 않음" : "Not created yet";
    if (source.status === "invalid") return ko ? "읽기 오류" : "Unreadable";
    return source.detail === "project-folder-not-connected"
      ? (ko ? "프로젝트 폴더 연결 필요" : "Connect a project folder")
      : (ko ? "폴더 다시 연결 필요" : "Reconnect the folder");
  };
  const latestEntries = snapshot?.entries.slice(0, 6) ?? [];
  return <section style={{ display: "grid", gap: 12 }}>
    <div style={{ padding: 14, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 12.5 }}>{ko ? "프로젝트 기억" : "Project memory"}</strong>
        {state === "ready" ? <span style={{ marginLeft: "auto", color: "var(--muted-deep)", fontSize: 10 }}>{ko ? `작업 기록 ${snapshot?.entries.length ?? 0}개` : `${snapshot?.entries.length ?? 0} work records`}</span> : null}
      </div>
      {state === "loading" ? <p style={{ margin: "10px 0 0", color: "var(--muted-deep)", fontSize: 11 }}>{ko ? "실제 저장 상태를 확인하는 중…" : "Checking saved memory…"}</p> : null}
      {state === "error" ? (
        <div role="alert" style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, color: "var(--red-deep)", fontSize: 11 }}>
          <span>{ko ? "프로젝트 기억을 불러오지 못했습니다." : "Could not load project memory."}</span>
          <button type="button" onClick={retry} style={{ marginLeft: "auto", fontWeight: 750 }}>{ko ? "다시 시도" : "Retry"}</button>
        </div>
      ) : null}
      {state === "ready" ? (
        <>
          <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
            {snapshot?.sources.map((source) => <div key={source.kind} style={{ display: "grid", gridTemplateColumns: "8px minmax(72px, .7fr) minmax(0, 1fr)", alignItems: "center", gap: 7, minHeight: 24, fontSize: 11 }}>
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: source.status === "ready" ? "var(--green-deep)" : source.status === "invalid" ? "var(--red-deep)" : source.status === "missing" ? "var(--amber-deep)" : "var(--muted)" }} />
              <strong>{sourceLabel(source.kind)}</strong>
              <span style={{ color: "var(--muted-deep)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sourceDetail(source)}</span>
            </div>)}
          </div>
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: "var(--hairline)" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--muted-deep)", letterSpacing: ".06em" }}>{ko ? "최근 기억" : "RECENT MEMORY"}</div>
            {latestEntries.length === 0 ? <p style={{ margin: "8px 0 0", color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.5 }}>{ko ? "아직 저장된 작업 기록이 없습니다. 작업이 완료되어 durable decision이나 결과가 생기면 여기에 표시됩니다." : "No work record has been saved yet. Durable decisions and outcomes appear here after work completes."}</p> : (
              <ol style={{ margin: "8px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 7 }}>
                {latestEntries.map((entry) => <li key={entry.id} style={{ fontSize: 11.5, lineHeight: 1.45 }}>
                  {entry.chatId && (entry.navigationStatus === "exact" || entry.navigationStatus === "chat_only")
                    ? <Link href={`/workspace/task?id=${encodeURIComponent(entry.chatId)}${entry.messageId ? `&focus=${encodeURIComponent(entry.messageId)}` : ""}`} style={{ color: "var(--ink)", textDecoration: "none" }}>{entry.summary}</Link>
                    : <span>{entry.summary}</span>}
                </li>)}
              </ol>
            )}
          </div>
        </>
      ) : null}
    </div>
    <div style={{ padding: 14, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--muted-deep)", letterSpacing: ".08em", textTransform: "uppercase" }}>{ko ? "프로젝트 지시" : "Project instructions"}</div>
      <p style={{ margin: "9px 0 0", whiteSpace: "pre-wrap", color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.55 }}>{project.systemPrompt || (ko ? "이 프로젝트의 목표와 작업 기준을 여기에 적어 두세요." : "Add this project's goals and working instructions here.")}</p>
    </div>
  </section>;
}

function RunReceiptCard({ chatId, busy }: { chatId: string | null; busy: boolean }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [receipt, setReceipt] = useState<InvocationRunReceipt | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) {
      setReceipt(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const next =
        typeof api.invoke.latestReceipt === "function"
          ? await api.invoke.latestReceipt(chatId).catch(() => null)
          : null;
      if (!cancelled) setReceipt(next);
    };
    void load();
    const interval = busy ? window.setInterval(load, 1200) : null;
    return () => {
      cancelled = true;
      if (interval != null) window.clearInterval(interval);
    };
  }, [busy, chatId]);

  // 완료 영수증은 평소에는 한 줄 요약만 남겨 작업 패널을 밀어내지 않는다.
  // 실행 중·실패·중단 상태는 사용자가 즉시 원인을 볼 수 있게 펼친다.
  useEffect(() => {
    const next = receiptAutoExpanded(busy, receipt?.status);
    if (next !== null) setExpanded(next);
  }, [busy, receipt?.runId, receipt?.status]);
  useEffect(() => {
    setOpenError(null);
  }, [receipt?.runId]);
  useEffect(() => {
    setExpanded(false);
    setOpenError(null);
  }, [chatId]);

  if (!receipt) return null;
  const status = receiptStatus(receipt.status, ko);
  const copyResultFolder = async () => {
    if (!receipt.resultFolder) return;
    setOpenError(null);
    try {
      await navigator.clipboard.writeText(receipt.resultFolder);
    } catch {
      setOpenError(ko ? "결과 경로를 복사하지 못했습니다." : "Could not copy the result path.");
    }
  };

  return (
    <section aria-label={ko ? "실행 영수증" : "Run receipt"} style={receiptCardStyle}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        style={receiptToggleStyle}
      >
        <span style={receiptHeaderStyle}>{ko ? "실행 영수증" : "Run receipt"}</span>
        <span style={{ ...receiptStatusStyle, color: status.color }}>{status.label}</span>
        <span style={receiptSummaryStyle}>{ko ? `${receipt.eventCount}개 이벤트` : `${receipt.eventCount} events`}</span>
        <span aria-hidden style={receiptChevronStyle}>{expanded ? "⌃" : "⌄"}</span>
      </button>
      {expanded && (
        <div style={receiptDetailsStyle}>
          <div style={receiptGridStyle}>
            <span>{ko ? "이벤트" : "Events"}</span>
            <strong>{receipt.eventCount}</strong>
          </div>
          {receipt.resultFolder && (
            <button type="button" onClick={() => void copyResultFolder()} title={receipt.resultFolder} style={receiptFolderButtonStyle}>
              <IconFolder size={12} />
              <span>{ko ? "결과 경로 복사" : "Copy result path"}</span>
            </button>
          )}
          {(receipt.errorMessage || receipt.errorCode) && (
            <div data-run-receipt-error="true" style={receiptErrorStyle}>
              <div>{receipt.errorMessage || (ko ? "실행 오류" : "Runtime error")}</div>
              {receipt.errorCode && <code>{receipt.errorCode}</code>}
            </div>
          )}
          {openError && (
            <div role="alert" style={receiptErrorStyle}>{openError}</div>
          )}
        </div>
      )}
    </section>
  );
}

function receiptStatus(status: InvocationRunReceipt["status"], ko: boolean): { label: string; color: string } {
  const labels: Record<InvocationRunReceipt["status"], [string, string, string]> = {
    running: ["실행 중", "Running", "var(--accent)"],
    cancelling: ["종료 확인 중", "Stopping", "var(--amber-deep)"],
    completed: ["완료", "Completed", "var(--green-deep)"],
    failed: ["실패", "Failed", "var(--red-deep)"],
    cancelled: ["취소됨", "Cancelled", "var(--muted-deep)"],
    interrupted: ["중단 복구 필요", "Interrupted", "var(--amber-deep)"],
  };
  const entry = labels[status];
  return { label: ko ? entry[0] : entry[1], color: entry[2] };
}

function FileTab({
  artifact,
  surface,
  onOpenPanel,
  onOpenFilePreview,
  chatId,
  linkedFiles,
  linkedOutputs,
  project,
}: {
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
  onOpenPanel: () => void;
  onOpenFilePreview: (preview: WorkspaceFilePreview) => void;
  chatId: string | null;
  linkedFiles: WorkspaceFilePreview[];
  linkedOutputs: WorkspaceFilePreview[];
  project: Project | null;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: WorkspaceFilePreview } | null>(null);
  const rawOutputRows: Array<OutputRow | null> = [
    surface
      ? {
          key: `surface:${surface.id}`,
          title: surface.manifest.title,
          meta: `${surface.manifest.domain} · ${surface.manifest.layout}`,
          icon: <IconLayers size={13} />,
          action: onOpenPanel,
        }
      : null,
    artifact
      ? {
          key: `artifact:${artifact.id}`,
          title: artifact.language || "artifact",
          meta: `${artifact.code.split("\n").length} lines`,
          icon: <IconFileUp size={13} />,
          action: onOpenPanel,
        }
      : null,
  ];
  const outputRows = rawOutputRows.filter((row): row is OutputRow => row !== null);
  const outputKeys = new Set(linkedOutputs.map((file) => file.path || file.fileUrl));
  const inspectedFiles = linkedFiles.filter((file) => !outputKeys.has(file.path || file.fileUrl));

  return (
    <div style={fileTabStyle}>
      {/* ★"산출물 0"인데 아래에 파일이 27개 있는 화면은 거짓 신호였다. 이 섹션이 세는 것은
          만들어진 결과물이 아니라 **지금 뷰어에 올라와 있는 것**이다. 이름을 실제에 맞추고,
          없을 때는 0을 자랑하는 대신 섹션을 접는다 — 사람이 세는 것은 아래의 산출물이다. */}
      {outputRows.length > 0 && (
      <section style={outputsStyle}>
        <div style={sectionHeaderStyle}>
          <span>{ko ? "열린 뷰어" : "Open viewers"}</span>
          <span>{outputRows.length}</span>
        </div>
        {(
          <div style={outputListStyle}>
            {outputRows.map((row) => (
              <button
                key={row.key}
                type="button"
                className="chat-right-output-row"
                onClick={row.action}
                style={outputRowStyle}
                title={row.title}
              >
                <span style={outputIconStyle}>{row.icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong style={outputTitleStyle}>{row.title}</strong>
                  <span style={outputMetaStyle}>{row.meta}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      )}
      {linkedFiles.length === 0 && outputRows.length === 0 && (
        <div style={smallEmptyStyle}>
          {ko
            ? "아직 만들어진 산출물이 없습니다. 에이전트가 파일을 만들면 여기에 바로 올라옵니다."
            : "Nothing produced yet. Files the agent creates show up here."}
        </div>
      )}
      {linkedOutputs.length > 0 && (
        <section style={outputsStyle}>
          <div style={sectionHeaderStyle}>
            <span>{ko ? "산출물" : "Outputs"}</span>
            <span>{linkedOutputs.length}</span>
          </div>
          <div style={outputListStyle}>
            {linkedOutputs.map((file) => (
              <button
                key={`${file.path}:${file.fileUrl}`}
                type="button"
                className="chat-right-output-row"
                onClick={() => onOpenFilePreview(file)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ x: event.clientX, y: event.clientY, file });
                }}
                style={outputRowStyle}
                title={file.path}
              >
                <span style={outputIconStyle}>{iconForViewerKind(file.viewerKind)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong style={outputTitleStyle}>{file.name}</strong>
                  <span style={outputMetaStyle}>{previewMeta(file, ko)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {inspectedFiles.length > 0 && (
        <section style={outputsStyle}>
          <div style={sectionHeaderStyle}>
            <span>{ko ? "확인한 파일" : "Inspected files"}</span>
            <span>{inspectedFiles.length}</span>
          </div>
          <div style={outputListStyle}>
            {inspectedFiles.map((file) => (
              <button
                key={`${file.path}:${file.fileUrl}`}
                type="button"
                className="chat-right-output-row"
                onClick={() => onOpenFilePreview(file)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ x: event.clientX, y: event.clientY, file });
                }}
                style={outputRowStyle}
                title={file.path}
              >
                <span style={outputIconStyle}>{iconForViewerKind(file.viewerKind)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong style={outputTitleStyle}>{file.name}</strong>
                  <span style={outputMetaStyle}>{previewMeta(file, ko)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={() => setContextMenu(null)}
        />
      )}
      <div style={workspaceWrapStyle}>
        <WorkspacePanel
          embedded
          chatId={chatId}
          projectFolder={project?.folderPath ? { projectId: project.id, projectName: project.name } : null}
          onOpenFilePreview={onOpenFilePreview}
        />
      </div>
    </div>
  );
}

function FileUnavailableState({ ko, explicit = false }: { ko: boolean; explicit?: boolean }) {
  return (
    <div data-file-unavailable-state="true" style={unsupportedViewerStyle}>
      <IconFileUp size={28} style={{ color: "var(--muted)" }} />
      <strong>{ko ? "이 파일의 내용을 읽지 못했습니다" : "Could not read this file"}</strong>
      <p style={unavailableMessageStyle}>
        {explicit
          ? ko
            ? "파일이 없거나 옮겨졌거나, 이 대화에 읽기 권한이 없습니다. 경로를 확인한 뒤 다시 첨부하세요."
            : "The file is missing, moved, or not readable by this conversation. Check the path and attach it again."
          : ko
            ? "파일이 옮겨졌거나 이 대화의 작업 폴더 밖에 있을 수 있습니다. 채팅에서 다시 생성하거나 경로를 확인하세요."
            : "It may have moved, or it sits outside this chat's working folder. Recreate it in chat or check the path."}
      </p>
    </div>
  );
}

function FileViewer({ file, onExpand }: { file: WorkspaceFilePreview; onExpand?: () => void }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const codePreview = isCodeFilePreview(file);
  const hasDocumentToolbar = file.available !== false
    && isLiveOutputKind(file.viewerKind)
    && file.viewerKind !== "image"
    && file.viewerKind !== "video"
    && file.viewerKind !== "audio";
  const typeLabel = viewerKindLabel(file.viewerKind, ko);
  return (
    <section style={fileViewerStyle}>
      {!codePreview && !hasDocumentToolbar && (
        <header style={fileViewerHeaderStyle}>
          <span style={fileViewerIconStyle}>{iconForViewerKind(file.viewerKind)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={fileViewerTitleStyle} title={file.path}>{file.name}</strong>
            {/* ★크기를 모를 때 "0 B" 라고 지어내지 않는다(2026-09-04 실앱 실측: 233KB
                스크린샷이 레일 머리글에 "이미지 · 0 B" 로 떴다). One 의 결과 카드도
                크기를 모르면 그 칸을 통째로 생략한다(OneAdaptiveResult) — 같은 규칙을 쓴다. */}
            <span style={fileViewerMetaStyle}>{typeLabel}{file.size > 0 ? ` · ${formatBytes(file.size)}` : ""}{file.live ? <b style={{ marginLeft: 6, color: "#23724d", fontSize: 9, letterSpacing: ".04em" }}>● LIVE</b> : null}</span>
          </div>
        </header>
      )}
      <div style={fileViewerBodyStyle}>
        {file.available === false ? (
          <FileUnavailableState ko={ko} explicit />
        ) : codePreview && !file.content ? (
          /* ★코드·HTML 도 **백지 대신 이유를 말한다.** 마크다운·JSON·텍스트에는 이미 이
             안내가 있었는데 코드류에는 없어서, 지워지거나 못 읽은 파일이 "빈 편집기"로
             열렸다 — 사람은 그것을 "파일이 비었다"로 읽는다(2026-09-03 실측: 지운 .html 을
             열면 경로와 '읽기 전용'만 뜨고 본문이 백지). */
          <FileUnavailableState ko={ko} />
        ) : codePreview ? (
          <CodeIdeViewer path={file.path} name={file.name} locale={ko ? "ko" : "en"} initialContent={file.viewerKind === "json" ? prettyJson(file.content || "") : file.content || ""} fill />
        ) : file.viewerKind === "browser" ? (
          <BrowserViewer file={file} />
        ) : isLiveOutputKind(file.viewerKind) ? (
          <LiveOutputViewer
            source={file.fileUrl}
            name={file.name}
            kind={file.viewerKind}
            mimeType={file.mimeType}
            size={file.size}
            locale={ko ? "ko" : "en"}
            fill
            placement="sidebar"
            imageActions={file.viewerKind === "image"}
            onOpenExternal={openableExternalTarget(file) ? async () => {
              const target = openableExternalTarget(file);
              const bridge = ipc();
              if (!target || !bridge) throw new Error("file-open-unavailable");
              const result = await bridge.fs.openPath(target);
              if (!result.ok) throw new Error(result.message || "file-open-failed");
            } : undefined}
            openExternalHint={ko ? "시스템 기본 앱에서 원본 대상 열기" : "Open the original target in the system default app"}
            onExpand={onExpand}
          />
        ) : isTextualViewerKind(file.viewerKind) && !file.content ? (
          /* ★내용이 없으면 **백지 대신 이유를 말한다.** 헤더만 뜨고 본문이 비어 있는
             화면은 "미리보기가 고장났다"로 읽힌다 — 실제로 그렇게 보고됐다. */
          <FileUnavailableState ko={ko} />
        ) : file.viewerKind === "markdown" ? (
          <MarkdownFileViewer file={file} />
        ) : file.viewerKind === "json" || file.viewerKind === "text" ? (
          <>
            {file.truncated && (
              <div style={fileNoticeStyle}>{ko ? "큰 파일이라 앞부분만 표시합니다." : "Large file; showing a preview."}</div>
            )}
            <pre style={textPreviewStyle}>{file.viewerKind === "json" ? prettyJson(file.content || "") : file.content || ""}</pre>
          </>
        ) : (
          <div style={unsupportedViewerStyle}>
            <IconFileUp size={28} style={{ color: "var(--muted)" }} />
            <strong>{ko ? "인앱 미리보기가 제한된 파일입니다" : "In-app preview is limited"}</strong>
            <p>
              {ko ? "이 형식은 현재 인앱 렌더러에서 지원하지 않습니다." : "This format is not supported by the in-app renderer yet."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/** 본문을 텍스트로 그리는 뷰어들 — 이들만 `content` 하이드레이션에 의존한다. */
function isTextualViewerKind(kind: WorkspaceFilePreview["viewerKind"]): boolean {
  return kind === "markdown" || kind === "json" || kind === "text";
}

/** Source-like files use the IDE even when the same extension can also be a
 * runnable web surface. A browser result is still selected explicitly by a
 * live URL or by a preview without hydrated source bytes. */
function isCodeFilePreview(file: WorkspaceFilePreview): boolean {
  if (!isCodeArtifactName(file.name)) return false;
  if (file.viewerKind === "json" || file.viewerKind === "text") return true;
  // A hydrated local HTML file is still a runnable web result when its
  // source came through the explicit file:// preview path. Static source
  // references are classified as text above and remain IDE previews.
  return file.viewerKind === "browser"
    && Boolean(file.content)
    && !/^file:|^agentlas:/iu.test(file.fileUrl);
}

type WorkspaceLiveOutputKind = Extract<LiveOutputKind, WorkspaceFilePreview["viewerKind"]>;

function isLiveOutputKind(kind: WorkspaceFilePreview["viewerKind"]): kind is WorkspaceLiveOutputKind {
  return ["image", "video", "audio", "pdf", "document", "spreadsheet", "presentation", "archive"].includes(kind);
}

function externalOpenTargets(file: WorkspaceFilePreview): string[] {
  const candidates = [
    file.viewerKind === "browser" ? file.browserUrl : undefined,
    ...(file.openTargets ?? []),
    file.path,
    file.fileUrl,
    file.browserUrl,
  ];
  const out: string[] = [];
  for (const raw of candidates) {
    const value = raw?.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function openableExternalTarget(file: WorkspaceFilePreview): string | null {
  return externalOpenTargets(file).find((target) => (
    /^https?:\/\//iu.test(target)
    || /^file:\/\//iu.test(target)
    || /^agentlas:\/\/localfile\//iu.test(target)
    || /^(?:\/|[A-Za-z]:[\\/])/u.test(target)
  )) ?? null;
}

function previewMeta(file: WorkspaceFilePreview, ko: boolean): string {
  const type = viewerKindLabel(file.viewerKind, ko);
  const size = file.size > 0 ? formatBytes(file.size) : ko ? "로컬 파일" : "Local file";
  return `${type} · ${size}`;
}

function firstCopyableFileTarget(file: WorkspaceFilePreview): string {
  return externalOpenTargets(file).find((target) => !/^(data:|blob:)/i.test(target)) || file.path || file.fileUrl;
}

function FileContextMenu({
  x,
  y,
  file,
  onClose,
}: {
  x: number;
  y: number;
  file: WorkspaceFilePreview;
  onClose: () => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissibleLayer({
    open: true,
    roots: [menuRef],
    onDismiss: onClose,
    dismissOnScroll: true,
    dismissOnWindowBlur: true,
  });
  const run = (fn: () => void) => {
    fn();
    onClose();
  };
  return (
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 80,
        minWidth: 190,
        padding: 6,
        borderRadius: 8,
        border: "1px solid var(--paper-edge)",
        background: "var(--paper)",
        boxShadow: "0 14px 34px rgba(15, 23, 42, 0.18)",
      }}
    >
      <button
        type="button"
        role="menuitem"
        style={contextMenuItemStyle}
        onClick={() => run(() => void navigator.clipboard.writeText(firstCopyableFileTarget(file)))}
      >
        {ko ? "경로 복사" : "Copy path"}
      </button>
    </div>
  );
}

function MarkdownFileViewer({ file }: { file: WorkspaceFilePreview }) {
  const { locale } = useT();
  const ko = locale === "ko";
  return (
    <div style={markdownPreviewStyle}>
      {file.truncated && (
        <div style={fileNoticeStyle}>{ko ? "큰 파일이라 앞부분만 표시합니다." : "Large file; showing a preview."}</div>
      )}
      <Markdown text={file.content || ""} messageId={`file:${file.path}`} />
    </div>
  );
}

function BrowserViewer({ file }: { file: WorkspaceFilePreview }) {
  const source = file.browserUrl || file.fileUrl;
  const isHtml = isHtmlFile(file.name);
  if (!isHtml || !file.content) {
    return <NativeLiveWebView url={source} title={file.name} runtimeLabel={file.live ? "watched" : "web"} />;
  }
  return (
    <>
      <div style={browserAddressStyle} title={source}>
        {source}
      </div>
      <iframe
        srcDoc={file.content}
        title={file.name}
        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
        allow="autoplay; clipboard-read; clipboard-write; fullscreen; picture-in-picture"
        style={iframePreviewStyle}
      />
    </>
  );
}

function EmptyViewer() {
  const { locale } = useT();
  const ko = locale === "ko";
  const viewers = [
    { label: "MD", icon: <IconLayers size={14} /> },
    { label: "PDF", icon: <IconFileUp size={14} /> },
    { label: ko ? "문서" : "Docs", icon: <IconFileUp size={14} /> },
    { label: ko ? "이미지" : "Image", icon: <IconImage size={14} /> },
    { label: ko ? "영상" : "Video", icon: <IconFilm size={14} /> },
    { label: ko ? "음성" : "Audio", icon: <IconFilm size={14} /> },
    { label: ko ? "브라우저" : "Browser", icon: <IconPanelRight size={14} /> },
  ];
  return (
    <div style={emptyViewerStyle}>
      <IconPanelRight size={30} style={{ color: "var(--muted)" }} />
      <strong>{ko ? "열린 뷰어가 없습니다" : "No viewer is open"}</strong>
      <p>{ko ? "채팅에서 코드, surface, 파일 미리보기를 열면 여기에서 확인합니다." : "Open a code block, surface, or file preview from chat to inspect it here."}</p>
      <div style={viewerGridStyle}>
        {viewers.map((viewer) => (
          <span key={viewer.label} style={viewerChipStyle} title={ko ? "지원되는 뷰어 형식" : "Supported viewer type"}>
            {viewer.icon}
            {viewer.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function viewerKindLabel(kind: WorkspaceFilePreview["viewerKind"], ko: boolean): string {
  if (kind === "markdown") return "Markdown";
  if (kind === "json") return "JSON";
  if (kind === "text") return ko ? "텍스트" : "Text";
  if (kind === "browser") return ko ? "브라우저" : "Browser";
  if (kind === "image") return ko ? "이미지" : "Image";
  if (kind === "video") return ko ? "영상" : "Video";
  if (kind === "audio") return ko ? "음성" : "Audio";
  if (kind === "pdf") return "PDF";
  if (kind === "spreadsheet") return ko ? "스프레드시트" : "Spreadsheet";
  if (kind === "presentation") return ko ? "프레젠테이션" : "Presentation";
  if (kind === "archive") return ko ? "압축 파일" : "Archive";
  if (kind === "document") return ko ? "문서" : "Document";
  return ko ? "파일" : "File";
}

function iconForViewerKind(kind: WorkspaceFilePreview["viewerKind"]) {
  if (kind === "image") return <IconImage size={14} />;
  if (kind === "video" || kind === "audio") return <IconFilm size={14} />;
  if (kind === "pdf" || kind === "document" || kind === "spreadsheet" || kind === "presentation" || kind === "archive") return <IconFileUp size={14} />;
  if (kind === "browser") return <IconPanelRight size={14} />;
  return <IconLayers size={14} />;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function isHtmlFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function TabButton({
  tab,
  activeTab,
  onClick,
  label,
  icon,
  badge,
}: {
  tab: ChatRightPanelTab;
  activeTab: ChatRightPanelTab;
  onClick: (tab: ChatRightPanelTab) => void;
  label: string;
  icon: ReactNode;
  badge?: boolean;
}) {
  const active = activeTab === tab;
  return (
    <button type="button" data-right-panel-tab={tab} onClick={() => onClick(tab)} style={tabButtonStyle(active)} aria-pressed={active}>
      {icon}
      <span>{label}</span>
      {badge && <span aria-hidden style={tabBadgeStyle} />}
    </button>
  );
}

const shellStyle: CSSProperties = {
  position: "relative",
  width: 392,
  minWidth: 320,
  maxWidth: "none",
  flexShrink: 1,
  height: "100%",
  background: "var(--paper)",
  borderLeft: "1px solid var(--paper-edge)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  overflow: "hidden",
  transition: "width 180ms ease, height 180ms ease",
};

const resizeHandleStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 7,
  cursor: "col-resize",
  zIndex: 6,
  touchAction: "none",
};

/** 패널을 세로로 줄일 수 있는 최소 높이 — TaskCockpit 이 저장값 검증에 함께 쓴다. */
export const RIGHT_PANEL_MIN_HEIGHT = 240;

// 좌상단 모서리는 폭 핸들(zIndex 6)이 가져간다. 헤더 탭 버튼은 상단에서 7.5px 지점에
// 시작하므로(헤더 47 - 탭 32, 센터 정렬) 5px 로 잡아 히트영역이 겹치지 않게 한다.
const resizeHeightHandleStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 7,
  right: 0,
  height: 5,
  cursor: "row-resize",
  zIndex: 5,
  touchAction: "none",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  minHeight: 47,
  height: 47,
  padding: "6px 8px",
  borderBottom: "var(--hairline)",
  background: "var(--paper)",
};

const iconButtonStyle: CSSProperties = {
  width: 26,
  height: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: 7,
  background: "transparent",
  color: "var(--muted-deep)",
  cursor: "pointer",
  flexShrink: 0,
};

const tabsStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: 0,
  overflow: "hidden",
  background: "var(--paper)",
};

function tabButtonStyle(active: boolean): CSSProperties {
  return {
    position: "relative",
    minWidth: 0,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: "0 8px",
    borderRadius: 8,
    border: "1px solid transparent",
    background: active ? "var(--fill-1)" : "transparent",
    color: active ? "var(--ink)" : "var(--muted-deep)",
    fontSize: 10.5,
    fontWeight: active ? 700 : 600,
    cursor: "pointer",
  };
}

const tabBadgeStyle: CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: "50%",
  background: "var(--muted-deep)",
  position: "absolute",
  right: 4,
  top: 5,
};

const bodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const agentTabStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflowY: "auto",
  overflowX: "hidden",
  padding: "0 20px",
};

const receiptCardStyle: CSSProperties = {
  flexShrink: 0,
  padding: "8px 12px 10px",
  borderTop: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
};

const receiptHeaderStyle: CSSProperties = {
  color: "var(--ink-soft)",
  fontSize: 11.5,
  fontWeight: 800,
};

const receiptToggleStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto auto auto",
  alignItems: "center",
  gap: 7,
  border: "none",
  background: "transparent",
  padding: 0,
  textAlign: "left",
  cursor: "pointer",
};

const receiptStatusStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 850,
};

const receiptGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
  alignItems: "center",
  gap: 6,
  color: "var(--muted-deep)",
  fontSize: 10.5,
};

const receiptDetailsStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  marginTop: 8,
};

const receiptSummaryStyle: CSSProperties = {
  flexShrink: 0,
  color: "var(--muted-deep)",
  fontSize: 10.5,
  fontWeight: 650,
  fontVariantNumeric: "tabular-nums",
};

const receiptChevronStyle: CSSProperties = {
  flexShrink: 0,
  color: "var(--muted-deep)",
  fontSize: 13,
  lineHeight: 1,
};

const receiptRunIdStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const receiptFolderButtonStyle: CSSProperties = {
  minWidth: 0,
  display: "inline-flex",
  width: "fit-content",
  maxWidth: "100%",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--paper-edge)",
  borderRadius: 7,
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: "7px 8px",
  textAlign: "left",
  cursor: "pointer",
  fontSize: 10.5,
  whiteSpace: "nowrap",
};

const receiptErrorStyle: CSSProperties = {
  color: "var(--red-deep)",
  fontSize: 10.5,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};

const fileTabStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflowY: "auto",
  overflowX: "hidden",
};

const outputsStyle: CSSProperties = {
  flexShrink: 0,
  borderBottom: "1px solid var(--paper-edge)",
  padding: "11px 10px",
  display: "grid",
  gap: 6,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  color: "var(--muted-deep)",
  fontSize: 10.5,
  fontWeight: 650,
  letterSpacing: 0,
};

const smallEmptyStyle: CSSProperties = {
  border: "none",
  borderRadius: 0,
  padding: "14px 12px",
  color: "var(--muted-deep)",
  fontSize: 11.5,
  lineHeight: 1.45,
};

const outputListStyle: CSSProperties = {
  display: "grid",
  gap: 1,
};

const outputRowStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  border: "1px solid transparent",
  borderRadius: 7,
  background: "transparent",
  padding: "7px 6px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  textAlign: "left",
  cursor: "pointer",
};

const outputIconStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 6,
  background: "transparent",
  color: "var(--muted-deep)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const outputTitleStyle: CSSProperties = {
  display: "block",
  color: "var(--ink)",
  fontSize: 11.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const outputMetaStyle: CSSProperties = {
  display: "block",
  marginTop: 2,
  color: "var(--muted-deep)",
  fontSize: 10.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const workspaceWrapStyle: CSSProperties = {
  flex: "1 0 240px",
  minHeight: 240,
  display: "flex",
  overflow: "hidden",
};

const emptyViewerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: 24,
  textAlign: "center",
  color: "var(--ink-soft)",
};

const fileViewerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--paper)",
};

const fileViewerHeaderStyle: CSSProperties = {
  minHeight: 48,
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "9px 10px",
  borderBottom: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
};

const fileViewerIconStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 7,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--fill-1)",
  color: "var(--accent)",
  flexShrink: 0,
};

const fileViewerTitleStyle: CSSProperties = {
  display: "block",
  color: "var(--ink)",
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const fileViewerMetaStyle: CSSProperties = {
  display: "block",
  marginTop: 2,
  color: "var(--muted-deep)",
  fontSize: 10.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const fileViewerOpenButtonStyle: CSSProperties = {
  flexShrink: 0,
  border: "1px solid var(--paper-edge)",
  borderRadius: 7,
  background: "var(--paper)",
  color: "var(--ink-soft)",
  minHeight: 28,
  padding: "0 9px",
  fontSize: 11,
  fontWeight: 780,
  cursor: "pointer",
};

const fileViewerBodyStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
};

const mediaStageStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  placeItems: "center",
  padding: 12,
  background: "var(--paper-2)",
};

const imagePreviewStyle: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
};

const videoPreviewStyle: CSSProperties = {
  width: "100%",
  maxHeight: "100%",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "#000",
};

const iframePreviewStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  border: "none",
  background: "var(--paper)",
};

const browserAddressStyle: CSSProperties = {
  flexShrink: 0,
  minHeight: 30,
  display: "flex",
  alignItems: "center",
  padding: "0 10px",
  borderBottom: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--muted-deep)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const markdownPreviewStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "6px 14px 18px",
  background: "var(--paper)",
  color: "var(--ink)",
};

const textPreviewStyle: CSSProperties = {
  margin: 0,
  flex: 1,
  minHeight: 0,
  padding: "12px 14px",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.55,
  color: "var(--ink)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

const fileNoticeStyle: CSSProperties = {
  margin: "10px 10px 0",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
  padding: "7px 9px",
  fontSize: 11.5,
};

const unsupportedViewerStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  gap: 10,
  padding: 24,
  color: "var(--ink-soft)",
};

const unavailableMessageStyle: CSSProperties = {
  width: "100%",
  maxWidth: 520,
  minWidth: 0,
  margin: 0,
  lineHeight: 1.55,
  overflowWrap: "anywhere",
};

const fileViewerPrimaryButtonStyle: CSSProperties = {
  minHeight: 32,
  border: "1px solid var(--accent-soft)",
  borderRadius: 8,
  background: "var(--fill-1)",
  color: "var(--accent)",
  padding: "0 12px",
  fontSize: 12,
  fontWeight: 820,
  cursor: "pointer",
};

const viewerGridStyle: CSSProperties = {
  marginTop: 8,
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: 7,
};

const viewerChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: "1px solid var(--paper-edge)",
  borderRadius: 999,
  padding: "5px 8px",
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 750,
};

const contextMenuItemStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  minHeight: 28,
  padding: "0 9px",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 650,
  textAlign: "left",
  cursor: "pointer",
};
