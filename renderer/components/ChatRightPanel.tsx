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
import { IconClose, IconFileUp, IconFilm, IconFolder, IconImage, IconLayers, IconNetwork, IconPanelRight, IconSparkles } from "./Icon";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { receiptAutoExpanded } from "@/lib/run-receipt-state";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import { projectPoolMemberKey } from "@shared/project-agent-pool";

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
  const activeLabel = activeTab === "file"
    ? (ko ? "파일" : "Files")
    : activeTab === "agent"
      ? (ko ? "에이전트" : "Agents")
      : activeTab === "memory"
        ? (ko ? "기억" : "Memory")
        : (ko ? "미리보기" : "Preview");
  const activeIcon = activeTab === "file"
    ? <IconFolder size={14} />
    : activeTab === "agent"
      ? <IconNetwork size={14} />
      : activeTab === "memory"
        ? <IconSparkles size={14} />
        : <IconPanelRight size={14} />;

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
    const startWidth = width ?? 392;
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

  function resizeByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!onResizeWidth || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = width ?? 392;
    const maxWidth = Math.max(340, Math.min(window.innerWidth - 420, Math.floor(window.innerWidth * 0.64)));
    const next = event.key === "Home"
      ? 300
      : event.key === "End"
        ? maxWidth
        : current + (event.key === "ArrowLeft" ? 16 : -16);
    onResizeWidth(Math.min(maxWidth, Math.max(300, next)));
  }

  return (
    <aside className="chat-right-panel titlebar-nodrag" data-active-tab={activeTab} style={{ ...shellStyle, width: width ?? shellStyle.width, maxWidth: "none" }}>
      {onResizeWidth && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={300}
          aria-valuemax={960}
          aria-valuenow={width ?? 392}
          aria-label={ko ? "우측 패널 너비" : "Right panel width"}
          title={ko ? "패널 너비 조절" : "Resize panel"}
          onPointerDown={beginResize}
          onKeyDown={resizeByKeyboard}
          style={resizeHandleStyle}
        />
      )}
      <header style={headerStyle}>
      <nav style={tabsStyle} aria-label={ko ? "우측 패널 탭" : "Right panel tabs"}>
        {/* ★도는 중이라는 사실은 탭을 눌러야 알 수 있으면 안 된다 — 눌러 보기 전에 보여야 한다. */}
        <TabButton tab="agent" activeTab={activeTab} onClick={onTabChange} label={ko ? "에이전트" : "Agents"} icon={<IconNetwork size={13} />} badge={busy || Object.values(liveAgents).some((entry) => entry.active)} />
        <TabButton tab="file" activeTab={activeTab} onClick={onTabChange} label={ko ? "파일" : "Files"} icon={<IconFolder size={13} />} />
        <TabButton tab="panel" activeTab={activeTab} onClick={onTabChange} label={ko ? "미리보기" : "Preview"} icon={<IconPanelRight size={13} />} badge={hasPanelContent} />
        <TabButton tab="memory" activeTab={activeTab} onClick={onTabChange} label={ko ? "기억" : "Memory"} icon={<IconSparkles size={13} />} />
      </nav>
        <button type="button" onClick={onClose} aria-label={ko ? "우측 패널 닫기" : "Close right panel"} title={ko ? "닫기" : "Close"} style={iconButtonStyle}>
          <IconClose size={14} />
        </button>
      </header>

      <div style={panelContextStyle}>
        <span style={headerMarkStyle}>{activeIcon}</span>
        <strong style={titleStyle}>{activeLabel}</strong>
        <span style={contextTitleStyle} title={chatTitle}>{chatTitle}</span>
      </div>

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
            project={project}
          />
        )}
        {activeTab === "agent" && (
          <div style={agentTabStyle}>
            {(Object.values(liveAgents).some((entry) => entry.active) || timeline.length > 0 || hasPipeline) ? <AgentNetworkPanel
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
  return <section style={{ padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)" }}>
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
      setSnapshot(await api.projects.timeline(project.id, 20));
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
    const interval = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(interval);
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
      style={{ width: "100%", padding: 12, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)", color: "var(--ink)", textAlign: "left", cursor: "pointer" }}
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
  project,
}: {
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
  onOpenPanel: () => void;
  onOpenFilePreview: (preview: WorkspaceFilePreview) => void;
  chatId: string | null;
  linkedFiles: WorkspaceFilePreview[];
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
      {linkedFiles.length > 0 && (
        <section style={outputsStyle}>
          <div style={sectionHeaderStyle}>
            <span>{ko ? "산출물" : "Outputs"}</span>
            <span>{linkedFiles.length}</span>
          </div>
          <div style={outputListStyle}>
            {linkedFiles.map((file) => (
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
      {openError && <div role="alert" style={fileNoticeStyle}>{openError}</div>}
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
        ) : isTextualViewerKind(file.viewerKind) && !file.content ? (
          /* ★내용이 없으면 **백지 대신 이유를 말한다.** 헤더만 뜨고 본문이 비어 있는
             화면은 "미리보기가 고장났다"로 읽힌다 — 실제로 그렇게 보고됐다. */
          <div style={unsupportedViewerStyle}>
            <IconFileUp size={28} style={{ color: "var(--muted)" }} />
            <strong>{ko ? "이 파일의 내용을 읽지 못했습니다" : "Could not read this file"}</strong>
            <p>
              {ko
                ? "파일이 옮겨졌거나 이 대화의 작업 폴더 밖에 있을 수 있습니다. 기본 앱으로 열어 확인하세요."
                : "It may have moved, or it sits outside this chat's working folder. Open it in its default app."}
            </p>
            <button type="button" onClick={openExternal} style={fileViewerPrimaryButtonStyle}>
              {ko ? "파일 열기" : "Open file"}
            </button>
          </div>
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

/** 본문을 텍스트로 그리는 뷰어들 — 이들만 `content` 하이드레이션에 의존한다. */
function isTextualViewerKind(kind: WorkspaceFilePreview["viewerKind"]): boolean {
  return kind === "markdown" || kind === "json" || kind === "text";
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
    return ko ? "이 파일을 외부 앱에서 열지 못했습니다. 파일 위치와 기본 앱 설정을 확인해 주세요." : "This file could not be opened externally. Check its location and default app.";
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
  return ko ? "Finder에서 이 파일을 표시하지 못했습니다. 파일이 이동되거나 삭제되지 않았는지 확인해 주세요." : "This file could not be shown in Finder. Check whether it was moved or deleted.";
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
  minWidth: 300,
  maxWidth: "none",
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
  gap: 4,
  minHeight: 47,
  height: 47,
  padding: "6px 8px",
  borderBottom: "var(--hairline)",
  background: "var(--paper)",
};

const headerMarkStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 6,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--ink-soft)",
  background: "transparent",
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  display: "block",
  color: "var(--ink)",
  fontSize: 11.5,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const panelContextStyle: CSSProperties = {
  minHeight: 45,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 10px",
  borderBottom: "1px solid var(--paper-edge)",
  background: "var(--paper)",
};

const contextTitleStyle: CSSProperties = {
  minWidth: 0,
  marginLeft: "auto",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--muted-deep)",
  fontSize: 10.5,
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
