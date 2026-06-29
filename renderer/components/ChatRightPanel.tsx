// Unified right rail for chat: files, agent workflow, and artifact/viewer panel.
"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
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
import type { AppFactoryAppRecord, InstalledAgent, InstalledFirm, ResolvedOrg } from "@/lib/types";
import { IconClose, IconFileUp, IconFilm, IconFolder, IconImage, IconLayers, IconNetwork, IconPanelRight } from "./Icon";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";

export type ChatRightPanelTab = "file" | "agent" | "panel";
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
  generatedApps: AppFactoryAppRecord[];
  onSurfaceAction?: SurfaceActionHandler;
  onSurfaceStatePatch?: SurfaceStatePatchHandler;
  firm: InstalledFirm | null;
  org: ResolvedOrg | null;
  agent: InstalledAgent | null;
  agents: InstalledAgent[];
  busy: boolean;
  liveAgents: Record<string, LiveAgent>;
  timeline: NetTimelineItem[];
  chatTitle: string;
  latestUserPrompt: string;
}

export function ChatRightPanel({
  activeTab,
  onTabChange,
  onClose,
  chatId,
  artifact,
  surface,
  generatedApps,
  onSurfaceAction,
  onSurfaceStatePatch,
  firm,
  org,
  agent,
  agents,
  busy,
  liveAgents,
  timeline,
  chatTitle,
  latestUserPrompt,
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

  return (
    <aside className="chat-right-panel titlebar-nodrag" style={shellStyle}>
      <header style={headerStyle}>
        <div style={headerMarkStyle}>
          {activeTab === "file" ? <IconFolder size={15} /> : activeTab === "agent" ? <IconNetwork size={15} /> : <IconPanelRight size={15} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={eyebrowStyle}>{ko ? "우측 패널" : "Right panel"}</div>
          <strong style={titleStyle}>
            {activeTab === "file" ? (ko ? "파일과 산출물" : "Files and outputs") : activeTab === "agent" ? (ko ? "에이전트 작업" : "Agent work") : (ko ? "뷰어" : "Viewer")}
          </strong>
        </div>
        <button type="button" onClick={onClose} aria-label={ko ? "우측 패널 닫기" : "Close right panel"} title={ko ? "닫기" : "Close"} style={iconButtonStyle}>
          <IconClose size={14} />
        </button>
      </header>

      <nav style={tabsStyle} aria-label={ko ? "우측 패널 탭" : "Right panel tabs"}>
        <TabButton tab="file" activeTab={activeTab} onClick={onTabChange} label={ko ? "파일" : "file"} icon={<IconFolder size={13} />} />
        <TabButton tab="agent" activeTab={activeTab} onClick={onTabChange} label={ko ? "에이전트" : "agent"} icon={<IconNetwork size={13} />} />
        <TabButton tab="panel" activeTab={activeTab} onClick={onTabChange} label={ko ? "패널" : "panel"} icon={<IconPanelRight size={13} />} badge={hasPanelContent} />
      </nav>

      <div style={bodyStyle}>
        {activeTab === "file" && (
          <FileTab
            artifact={artifact}
            surface={surface}
            generatedApps={generatedApps}
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
          />
        )}
        {activeTab === "agent" && (
          <AgentNetworkPanel
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
          />
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
      </div>
    </aside>
  );
}

function FileTab({
  artifact,
  surface,
  generatedApps,
  onOpenPanel,
  onOpenFilePreview,
  chatId,
}: {
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
  generatedApps: AppFactoryAppRecord[];
  onOpenPanel: () => void;
  onOpenFilePreview: (preview: WorkspaceFilePreview) => void;
  chatId: string | null;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
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
    ...generatedApps.slice(0, 4).map((app) => ({
      key: `app:${app.id}`,
      title: app.appName || app.manifest.app?.name || app.manifest.title || "Generated App",
      meta: `${app.status} · ${app.manifest.domain}`,
      icon: <IconLayers size={13} />,
      action: () => navigate(`/apps/generated?id=${encodeURIComponent(app.id)}`),
    })),
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
      <div style={workspaceWrapStyle}>
        <WorkspacePanel embedded chatId={chatId} onOpenFilePreview={onOpenFilePreview} />
      </div>
    </div>
  );
}

function FileViewer({ file }: { file: WorkspaceFilePreview }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const typeLabel = viewerKindLabel(file.viewerKind, ko);
  const openExternal = () => window.open(file.fileUrl, "_blank", "noopener,noreferrer");
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
      </header>
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
      <p>{ko ? "채팅에서 코드, surface, 파일 미리보기, 앱 산출물을 열면 여기에서 확인합니다." : "Open a code block, surface, file preview, or app output from chat to inspect it here."}</p>
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
