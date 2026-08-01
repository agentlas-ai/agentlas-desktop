// Unified right rail for chat: files, agent workflow, and artifact/viewer panel.
"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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
import type { InstalledAgent, InstalledFirm, InvocationRunReceipt, Project, ResolvedOrg } from "@/lib/types";
import { IconClose, IconFileUp, IconFilm, IconFolder, IconImage, IconLayers, IconNetwork, IconPanelRight, IconSparkles } from "./Icon";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { receiptAutoExpanded } from "@/lib/run-receipt-state";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";

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
  activeTab: ChatRightPanelTab;
  onTabChange: (tab: ChatRightPanelTab) => void;
  onClose: () => void;
  chatId: string | null;
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
  filePreview?: WorkspaceFilePreview | null;
  linkedFiles?: WorkspaceFilePreview[];
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
}

export function ChatRightPanel({
  activeTab,
  onTabChange,
  onClose,
  chatId,
  artifact,
  surface,
  filePreview: externalFilePreview,
  linkedFiles = [],
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
}: Props) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [filePreview, setFilePreview] = useState<WorkspaceFilePreview | null>(null);
  const [viewerSource, setViewerSource] = useState<PanelViewerSource>("workbench");
  const hasPanelContent = Boolean(artifact || surface || filePreview);
  const showFilePreview = viewerSource === "file" && filePreview;
  const showWorkbench = viewerSource === "workbench" && (artifact || surface);

  useEffect(() => {
    setFilePreview(null);
    setViewerSource("workbench");
  }, [chatId]);

  useEffect(() => {
    if (artifact || surface) setViewerSource("workbench");
  }, [artifact?.id, surface?.id]);

  useEffect(() => {
    if (!externalFilePreview) return;
    setFilePreview(externalFilePreview);
    setViewerSource("file");
  }, [externalFilePreview?.path, externalFilePreview?.fileUrl]);

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onResizeWidth) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width ?? 360;
    const maxWidth = Math.max(340, Math.min(window.innerWidth - 420, Math.floor(window.innerWidth * 0.64)));
    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.round(startWidth + startX - moveEvent.clientX);
      onResizeWidth(Math.min(maxWidth, Math.max(300, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  return (
    <aside className="chat-right-panel titlebar-nodrag" style={{ ...shellStyle, width: width ?? shellStyle.width, maxWidth: "none" }}>
      {onResizeWidth && (
        <div
          role="separator"
          aria-orientation="vertical"
          title={ko ? "패널 너비 조절" : "Resize panel"}
          onPointerDown={beginResize}
          style={resizeHandleStyle}
        />
      )}
      <header style={headerStyle}>
        <div style={headerMarkStyle}>
          {activeTab === "file" ? <IconFolder size={15} /> : activeTab === "agent" ? <IconNetwork size={15} /> : activeTab === "memory" ? <IconSparkles size={15} /> : <IconPanelRight size={15} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={eyebrowStyle}>{ko ? "우측 패널" : "Right panel"}</div>
          <strong style={titleStyle}>
            {activeTab === "file" ? (ko ? "파일" : "Files") : activeTab === "agent" ? (ko ? "팀" : "Team") : activeTab === "memory" ? (ko ? "기억" : "Memory") : (ko ? "미리보기" : "Preview")}
          </strong>
        </div>
        <button type="button" onClick={onClose} aria-label={ko ? "우측 패널 닫기" : "Close right panel"} title={ko ? "닫기" : "Close"} style={iconButtonStyle}>
          <IconClose size={14} />
        </button>
      </header>

      <nav style={tabsStyle} aria-label={ko ? "우측 패널 탭" : "Right panel tabs"}>
        <TabButton tab="agent" activeTab={activeTab} onClick={onTabChange} label={ko ? "팀" : "Team"} icon={<IconNetwork size={13} />} />
        <TabButton tab="file" activeTab={activeTab} onClick={onTabChange} label={ko ? "파일" : "Files"} icon={<IconFolder size={13} />} />
        <TabButton tab="panel" activeTab={activeTab} onClick={onTabChange} label={ko ? "미리보기" : "Preview"} icon={<IconPanelRight size={13} />} badge={hasPanelContent} />
        <TabButton tab="memory" activeTab={activeTab} onClick={onTabChange} label={ko ? "기억" : "Memory"} icon={<IconSparkles size={13} />} />
      </nav>

      <div style={bodyStyle}>
        {activeTab === "file" && (
          <FileTab
            artifact={artifact}
            surface={surface}
            onOpenPanel={() => {
              setViewerSource("workbench");
              onTabChange("panel");
            }}
            onOpenFilePreview={(preview) => {
              setFilePreview(preview);
              setViewerSource("file");
              onTabChange("panel");
            }}
            chatId={chatId}
            linkedFiles={linkedFiles}
          />
        )}
        {activeTab === "agent" && (
          <div style={agentTabStyle}>
            {project ? <ProjectTeamCard project={project} agents={agents} ko={ko} /> : null}
            {(busy || Object.keys(liveAgents).length > 0 || timeline.length > 0 || hasPipeline) ? <AgentNetworkPanel
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
            <RunReceiptCard chatId={chatId} busy={busy} />
          </div>
        )}
        {activeTab === "panel" && (
          showFilePreview ? (
            <FileViewer file={filePreview} />
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
        {activeTab === "memory" && <ProjectMemoryCard project={project} ko={ko} />}
      </div>
    </aside>
  );
}

function ProjectTeamCard({ project, agents, ko }: { project: Project; agents: InstalledAgent[]; ko: boolean }) {
  const nameById = new Map(agents.map((agent) => [agent.id, ko ? agent.name : agent.nameEn || agent.name]));
  return <section style={{ padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: ".08em", color: "var(--muted-deep)", textTransform: "uppercase" }}>{ko ? "프로젝트 선호 팀" : "Project team priority"}</div>
    <div style={{ display: "grid", gap: 6, marginTop: 9 }}>
      {project.agentPool.map((member, index) => <div key={`${member.source}:${member.agentId}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
        <span style={{ width: 20, height: 20, display: "grid", placeItems: "center", borderRadius: 6, background: "var(--fill-1)", color: "var(--accent)", fontWeight: 800 }}>{index + 1}</span>
        <strong>{nameById.get(member.agentId) || member.nameSnapshot}</strong>
      </div>)}
    </div>
    <p style={{ margin: "10px 0 0", color: "var(--muted-deep)", fontSize: 10.5, lineHeight: 1.45 }}>{ko ? "실행 중에는 실제 WorkOrder와 영수증이 생긴 에이전트만 아래에 표시됩니다." : "During a run, only agents backed by an actual WorkOrder and receipt appear below."}</p>
  </section>;
}

function ProjectMemoryCard({ project, ko }: { project: Project | null; ko: boolean }) {
  if (!project) return <div style={{ padding: 18, color: "var(--muted-deep)", fontSize: 12 }}>{ko ? "이 작업에 연결된 프로젝트가 없습니다." : "No project is connected to this task."}</div>;
  return <section style={{ display: "grid", gap: 12 }}>
    <div style={{ padding: 14, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--muted-deep)", letterSpacing: ".08em", textTransform: "uppercase" }}>{ko ? "프로젝트 지시" : "Project instructions"}</div>
      <p style={{ margin: "9px 0 0", whiteSpace: "pre-wrap", color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.55 }}>{project.systemPrompt || (ko ? "One이 프로젝트와 현재 작업을 보고 필요한 안내를 제시합니다." : "One will use the project and current task to present the next useful guidance.")}</p>
    </div>
    <div style={{ padding: 14, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
      <strong style={{ fontSize: 12 }}>{ko ? "축적되는 프로젝트 기억" : "Growing project memory"}</strong>
      <p style={{ margin: "6px 0 0", color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.5 }}>{ko ? "결정, PM Soul, 사이트맵, 코드맵은 에이전트 릴리스와 분리되어 이 프로젝트에 남습니다." : "Decisions, PM Soul, sitemap, and code map stay with this project independently of agent releases."}</p>
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
  const openResultFolder = async () => {
    if (!receipt.resultFolder) return;
    setOpenError(null);
    const result = await ipc()?.fs.openPath(receipt.resultFolder).catch(() => ({
      ok: false,
      message: "",
    }));
    if (result && !result.ok) setOpenError(result.message || (ko ? "결과 폴더를 열 수 없습니다." : "Could not open the result folder."));
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
            <button type="button" onClick={() => void openResultFolder()} title={receipt.resultFolder} style={receiptFolderButtonStyle}>
              <IconFolder size={12} />
              <span>{ko ? "결과 폴더 열기" : "Open result folder"}</span>
            </button>
          )}
          {(receipt.errorMessage || openError) && (
            <div role="status" style={receiptErrorStyle} data-one-content-slot data-capability="task-recovery">{openError || null}</div>
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
}: {
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
  onOpenPanel: () => void;
  onOpenFilePreview: (preview: WorkspaceFilePreview) => void;
  chatId: string | null;
  linkedFiles: WorkspaceFilePreview[];
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

  return (
    <div style={fileTabStyle}>
      <section style={outputsStyle}>
        <div style={sectionHeaderStyle}>
          <span>{ko ? "산출물" : "Outputs"}</span>
          <span>{outputRows.length}</span>
        </div>
        {outputRows.length === 0 ? (
          <div style={smallEmptyStyle}>{ko ? "열린 산출물이 아직 없습니다." : "No outputs opened yet."}</div>
        ) : (
          <div style={outputListStyle}>
            {outputRows.map((row) => (
              <button
                key={row.key}
                type="button"
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
      {linkedFiles.length > 0 && (
        <section style={outputsStyle}>
          <div style={sectionHeaderStyle}>
            <span>{ko ? "링크된 파일" : "Linked files"}</span>
            <span>{linkedFiles.length}</span>
          </div>
          <div style={outputListStyle}>
            {linkedFiles.map((file) => (
              <button
                key={`${file.path}:${file.fileUrl}`}
                type="button"
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
          {contextMenu && (
            <FileContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              file={contextMenu.file}
              onClose={() => setContextMenu(null)}
            />
          )}
        </section>
      )}
      <div style={workspaceWrapStyle}>
        <WorkspacePanel embedded chatId={chatId} onOpenFilePreview={onOpenFilePreview} />
      </div>
    </div>
  );
}

function FileViewer({ file }: { file: WorkspaceFilePreview }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [openError, setOpenError] = useState<string | null>(null);
  const typeLabel = viewerKindLabel(file.viewerKind, ko);
  const openExternal = async () => {
    setOpenError(null);
    const message = await openWorkspaceFileExternal(file, ko);
    if (message) setOpenError(message);
  };
  const revealInFolder = async () => {
    setOpenError(null);
    const message = await revealWorkspaceFile(file, ko);
    if (message) setOpenError(message);
  };
  return (
    <section style={fileViewerStyle}>
      <header style={fileViewerHeaderStyle}>
        <span style={fileViewerIconStyle}>{iconForViewerKind(file.viewerKind)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={fileViewerTitleStyle} title={file.path}>{file.name}</strong>
          <span style={fileViewerMetaStyle}>{typeLabel} · {formatBytes(file.size)}</span>
        </div>
        <button type="button" onClick={openExternal} style={fileViewerOpenButtonStyle}>
          {ko ? "외부 열기" : "Open"}
        </button>
        {canRevealWorkspaceFile(file) && (
          <button type="button" onClick={revealInFolder} style={fileViewerOpenButtonStyle}>
            {ko ? "Finder에서 보기" : "Show"}
          </button>
        )}
      </header>
      {openError && <div style={fileNoticeStyle} data-one-content-slot data-capability="file-recovery">{openError}</div>}
      <div style={fileViewerBodyStyle}>
        {file.viewerKind === "browser" ? (
          <BrowserViewer file={file} />
        ) : file.viewerKind === "image" ? (
          <div style={mediaStageStyle}>
            <img src={file.fileUrl} alt={file.name} style={imagePreviewStyle} />
          </div>
        ) : file.viewerKind === "video" ? (
          <div style={mediaStageStyle}>
            <video src={file.fileUrl} controls preload="metadata" style={videoPreviewStyle} />
          </div>
        ) : file.viewerKind === "pdf" ? (
          <iframe src={file.fileUrl} title={file.name} style={iframePreviewStyle} />
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
              {file.viewerKind === "document"
                ? (ko ? "문서 파일은 기본 앱으로 열어 확인하세요." : "Open this document in its default app.")
                : (ko ? "이 파일 형식은 기본 앱으로 여는 것이 안전합니다." : "Open this file type in its default app.")}
            </p>
            <button type="button" onClick={openExternal} style={fileViewerPrimaryButtonStyle}>
              {ko ? "파일 열기" : "Open file"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
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

async function openWorkspaceFileExternal(file: WorkspaceFilePreview, ko: boolean): Promise<string | null> {
  const targets = externalOpenTargets(file);
  const bridge = ipc();
  if (bridge?.fs?.openPath) {
    for (const target of targets) {
      if (/^(data:|blob:)/i.test(target)) continue;
      const result = await bridge.fs.openPath(target).catch(() => ({ ok: false, message: "" }));
      if (result.ok) return null;
    }
    return ko ? "이 파일을 외부 앱에서 열지 못했습니다. One이 가능한 다음 행동을 제안할 수 있습니다." : "This file could not be opened externally. One can suggest the next available action.";
  }
  window.open(file.browserUrl || file.fileUrl, "_blank", "noopener,noreferrer");
  return null;
}

async function revealWorkspaceFile(file: WorkspaceFilePreview, ko: boolean): Promise<string | null> {
  const bridge = ipc();
  if (!bridge?.fs?.showItemInFolder) {
    return ko ? "Finder에서 보기 기능을 사용할 수 없습니다." : "Show in folder is not available.";
  }
  for (const target of externalOpenTargets(file)) {
    if (/^(https?:|data:|blob:)/i.test(target)) continue;
    const result = await bridge.fs.showItemInFolder(target).catch(() => ({ ok: false, message: "" }));
    if (result.ok) return null;
  }
  return ko ? "Finder에서 이 파일을 표시하지 못했습니다. One이 가능한 다음 행동을 제안할 수 있습니다." : "This file could not be shown in Finder. One can suggest the next available action.";
}

function canRevealWorkspaceFile(file: WorkspaceFilePreview): boolean {
  return externalOpenTargets(file).some((target) => {
    if (/^agentlas:\/\/localfile\//i.test(target) || target.startsWith("file://")) return true;
    return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
  });
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
      <button type="button" role="menuitem" style={contextMenuItemStyle} onClick={() => run(() => void openWorkspaceFileExternal(file, ko))}>
        {ko ? "외부 앱으로 열기" : "Open externally"}
      </button>
      {canRevealWorkspaceFile(file) && (
        <button type="button" role="menuitem" style={contextMenuItemStyle} onClick={() => run(() => void revealWorkspaceFile(file, ko))}>
          {ko ? "Finder에서 보기" : "Show in folder"}
        </button>
      )}
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
  return (
    <>
      <div style={browserAddressStyle} title={source}>
        {source}
      </div>
      {isHtml && file.content ? (
        <iframe
          srcDoc={file.content}
          title={file.name}
          sandbox="allow-forms allow-modals allow-popups"
          style={iframePreviewStyle}
        />
      ) : (
        <iframe
          src={source}
          title={file.name}
          sandbox="allow-forms allow-modals allow-popups allow-same-origin"
          style={iframePreviewStyle}
        />
      )}
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
  if (kind === "pdf") return "PDF";
  if (kind === "document") return ko ? "문서" : "Document";
  return ko ? "파일" : "File";
}

function iconForViewerKind(kind: WorkspaceFilePreview["viewerKind"]) {
  if (kind === "image") return <IconImage size={14} />;
  if (kind === "video") return <IconFilm size={14} />;
  if (kind === "pdf" || kind === "document") return <IconFileUp size={14} />;
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
    <button type="button" onClick={() => onClick(tab)} style={tabButtonStyle(active)} aria-pressed={active}>
      {icon}
      <span>{label}</span>
      {badge && <span aria-hidden style={tabBadgeStyle} />}
    </button>
  );
}

const shellStyle: CSSProperties = {
  position: "relative",
  width: "clamp(310px, 32vw, 430px)",
  minWidth: 290,
  maxWidth: "44vw",
  flexShrink: 1,
  height: "100%",
  background: "var(--paper)",
  borderLeft: "1px solid var(--paper-edge)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  overflow: "hidden",
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

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "10px 12px",
  borderBottom: "var(--hairline)",
  background: "var(--paper)",
};

const headerMarkStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--accent)",
  background: "var(--fill-1)",
  flexShrink: 0,
};

const eyebrowStyle: CSSProperties = {
  fontSize: 10,
  color: "var(--muted-deep)",
  fontWeight: 750,
  textTransform: "uppercase",
  letterSpacing: 0.35,
};

const titleStyle: CSSProperties = {
  display: "block",
  marginTop: 1,
  color: "var(--ink)",
  fontSize: 12.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
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
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 6,
  padding: "8px 10px",
  borderBottom: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
};

function tabButtonStyle(active: boolean): CSSProperties {
  return {
    position: "relative",
    minWidth: 0,
    height: 30,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 7,
    border: active ? "1px solid var(--accent-soft)" : "1px solid transparent",
    background: active ? "var(--paper)" : "transparent",
    color: active ? "var(--accent)" : "var(--ink-soft)",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: "pointer",
  };
}

const tabBadgeStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--green-deep)",
  position: "absolute",
  right: 9,
  top: 7,
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
  overflow: "hidden",
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
  overflow: "hidden",
};

const outputsStyle: CSSProperties = {
  flexShrink: 0,
  borderBottom: "1px solid var(--paper-edge)",
  padding: "10px",
  display: "grid",
  gap: 8,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  color: "var(--muted-deep)",
  fontSize: 10.5,
  fontWeight: 820,
  textTransform: "uppercase",
  letterSpacing: 0.35,
};

const smallEmptyStyle: CSSProperties = {
  border: "1px dashed var(--paper-edge)",
  borderRadius: 8,
  padding: "9px 10px",
  color: "var(--muted-deep)",
  fontSize: 11.5,
  lineHeight: 1.45,
};

const outputListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const outputRowStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
  padding: "8px 9px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  textAlign: "left",
  cursor: "pointer",
};

const outputIconStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 7,
  background: "var(--fill-1)",
  color: "var(--accent)",
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
  flex: 1,
  minHeight: 0,
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
