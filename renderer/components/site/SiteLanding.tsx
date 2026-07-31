"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import type { AgentGroupResolved, InstalledAgent, InstalledFirm } from "@shared/types";
import type {
  SiteAgentAppMcpRecommendation,
  SiteAgentAppTargetRef,
  SiteProjectPublicMeta,
  SiteSurface,
} from "@shared/site-studio";
import styles from "./SiteLanding.module.css";

type AgentChoice = SiteAgentAppTargetRef & {
  name: string;
  description: string;
  meta: string;
};

export type SiteAgentAppThumbnailState =
  | { status: "loading" }
  | { status: "ready"; dataUrl: string }
  | { status: "failed"; reason: string };

export type SiteAgentAppThumbnailResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: string };

/**
 * Card truth is deliberately separate from the persisted consent receipt.
 * `offline` includes an absent bridge, a failed lookup, and an unverified
 * initial render; none of those states may inherit an old approval checkmark.
 */
export type SiteAgentAppMcpLiveState =
  | { kind: "resolved"; recommendation: SiteAgentAppMcpRecommendation }
  | { kind: "offline" };

type SiteLandingProps = {
  projects: SiteProjectPublicMeta[];
  locale: "ko" | "en";
  busy: boolean;
  noEngine: boolean;
  generating: boolean;
  /** Live status and design feedback from the running generation. */
  activity?: { status: string; feedback: string } | null;
  /** The last create that failed, kept on screen instead of a vanishing toast. */
  failure?: { reason: string } | null;
  onRetryCreate?: () => void;
  onDismissFailure?: () => void;
  /** Fresh main-owned readiness. Missing entries fail closed as offline. */
  agentAppMcpLiveStates?: Record<string, SiteAgentAppMcpLiveState>;
  onCreate: (input: {
    brief: string;
    surface: SiteSurface;
    agentAppTarget?: SiteAgentAppTargetRef;
  }) => void;
  onOpenProject: (project: SiteProjectPublicMeta) => void;
  onExit: () => void;
  onDeleteProject: (projectId: string) => void;
  /** Main owns thumbnail validation and reading. Only visible cards request image data. */
  onLoadAgentAppThumbnail?: (projectId: string) => Promise<SiteAgentAppThumbnailResult>;
  /** Publishing is always explicit: the user must select a card before this fires. */
  onPublishProject?: (project: SiteProjectPublicMeta) => void;
  /** Opens Electron main's native MCP recommendation/consent review. */
  onReviewAgentAppMcp?: (project: SiteProjectPublicMeta) => void;
};

const AGENT_APPS_PER_PAGE = 9;

function isImeSubmit(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function Icon({ children, size = 18, viewBox = "0 0 24 24" }: { children: React.ReactNode; size?: number; viewBox?: string }) {
  return (
    <svg width={size} height={size} viewBox={viewBox} fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

function ArrowUp() {
  return <Icon size={20}><path d="M12 18V6m0 0-5 5m5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

function SearchIcon() {
  return <Icon size={16}><circle cx="10.5" cy="10.5" r="5.2" stroke="currentColor" strokeWidth="1.4" /><path d="m14.4 14.4 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></Icon>;
}

function PublishIcon() {
  return <Icon size={16}><path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

function ExternalIcon() {
  return <Icon size={14}><path d="M14 5h5v5M19 5l-8 8M17 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></Icon>;
}

function McpIcon() {
  return <Icon size={13}><circle cx="7" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.5" /><circle cx="17" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.5" /><circle cx="17" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.5" /><path d="m9 11 5.8-3M9 13l5.8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></Icon>;
}

function TemplateIllustration({ surface }: { surface: SiteSurface }) {
  if (surface === "mobile") {
    return (
      <div className={styles.mobileArt} aria-hidden="true">
        <span className={styles.mobileStatus} />
        <span className={styles.mobileHero} />
        <span className={styles.mobileLine} />
        <span className={styles.mobileLineShort} />
        <span className={styles.mobileButton} />
        <span className={styles.mobileNav}><i /><i /><i /></span>
      </div>
    );
  }
  if (surface === "agent-app") {
    return (
      <div className={styles.agentArt} aria-hidden="true">
        <span className={styles.agentRail}><i /><i /><i /><i /></span>
        <span className={styles.agentCanvas}>
          <b>Input</b><i /><i /><em>Run agent</em><strong>Output</strong><u />
        </span>
      </div>
    );
  }
  return (
    <div className={styles.webArt} aria-hidden="true">
      <span className={styles.webChrome}><i /><i /><i /></span>
      <span className={styles.webNav} />
      <span className={styles.webHeadline} />
      <span className={styles.webCopy}><i /><i /></span>
      <span className={styles.webCta} />
      <span className={styles.webPanel} />
    </div>
  );
}

function formatDate(value: string, locale: "ko" | "en"): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function targetKindLabel(project: SiteProjectPublicMeta, ko: boolean): string {
  const kind = project.agentAppTarget?.kind;
  if (kind === "team") return ko ? "에이전트 팀" : "Agent team";
  if (kind === "firm") return ko ? "에이전트 회사" : "Agent firm";
  if (kind === "group") return ko ? "에이전트 조합" : "Agent group";
  return ko ? "내 에이전트" : "My agent";
}

function mcpCardPresentation(
  liveState: SiteAgentAppMcpLiveState | undefined,
  ko: boolean,
): { status: "ready" | "review" | "offline" | "off" | "blocked"; label: string; title: string } {
  if (!liveState || liveState.kind === "offline") {
    return {
      status: "offline",
      label: "MCP offline",
      title: ko ? "MCP 상태를 확인할 수 없습니다. 다시 검토하세요." : "MCP status could not be verified. Review it again.",
    };
  }
  const { recommendation } = liveState;
  if (recommendation.rows.length === 0 && recommendation.blocked.length > 0) {
    return {
      status: "blocked",
      label: ko ? "MCP 차단" : "MCP blocked",
      title: ko
        ? "앱이 선언한 MCP가 Agent App 안전 정책에서 제외됐습니다. 눌러서 차단 항목을 확인하세요."
        : "The app-declared MCP was excluded by Agent App safety policy. Open to review the blocked declaration.",
    };
  }
  if (recommendation.status === "declined" || recommendation.status === "not-required") {
    return {
      status: "off",
      label: ko ? "MCP 끔" : "MCP off",
      title: ko ? "이 Agent App은 MCP 없이 실행됩니다." : "This Agent App runs without MCP.",
    };
  }
  const total = recommendation.rows.length;
  const ready = recommendation.rows.filter((row) => row.readiness === "ready").length;
  const liveApprovalReady = recommendation.status === "approved" && total > 0 && ready === total;
  if (liveApprovalReady) {
    return {
      status: "ready",
      label: ko ? `MCP ${ready}/${total} 설정됨` : `MCP ${ready}/${total} configured`,
      title: ko
        ? "승인과 설치·키 설정이 확인됐습니다. 실제 연결은 실행 직전에 다시 검증합니다."
        : "Consent, installation, and key setup are confirmed. Connection is verified again immediately before each run.",
    };
  }
  return {
    status: "review",
    label: ko ? "MCP 검토" : "MCP review",
    title: ko
      ? "승인 또는 현재 연결 상태가 달라졌습니다. 다시 검토하세요."
      : "Consent or live readiness changed. Review it again.",
  };
}

function ThumbnailPlaceholder({
  project,
  thumbnail,
  ko,
}: {
  project: SiteProjectPublicMeta;
  thumbnail?: SiteAgentAppThumbnailState;
  ko: boolean;
}) {
  if (thumbnail?.status === "ready") {
    return <img className={styles.agentAppImage} src={thumbnail.dataUrl} alt={ko ? `${project.agentAppTarget?.name || project.name} 웹앱 스크린샷` : `${project.agentAppTarget?.name || project.name} web app screenshot`} />;
  }

  const artifact = project.agentAppArtifact;
  const failed = thumbnail?.status === "failed" || artifact?.status === "failed";
  const loading = thumbnail?.status === "loading" || artifact?.status === "building" || artifact?.status === "scaffolded";
  const reason = thumbnail?.status === "failed" ? thumbnail.reason : artifact?.failureReason;

  return (
    <span className={styles.thumbnailState} data-state={failed ? "failed" : loading ? "loading" : "missing"}>
      {loading && <span className={styles.thumbnailSpinner} aria-hidden="true" />}
      {failed ? (
        <><b>{ko ? "스크린샷 생성 실패" : "Screenshot failed"}</b><small>{reason || (ko ? "생성 기록을 확인하세요." : "Check the build record.")}</small></>
      ) : loading ? (
        <><b>{ko ? "실제 앱을 렌더링하는 중" : "Rendering the real app"}</b><small>1280 × 720</small></>
      ) : (
        <><b>{ko ? "스크린샷 없음" : "No screenshot yet"}</b><small>{ko ? "앱 빌드가 완료되면 표시됩니다." : "It will appear after the app build completes."}</small></>
      )}
    </span>
  );
}

export function SiteLanding({
  projects,
  locale,
  busy,
  noEngine,
  generating,
  activity,
  failure,
  onRetryCreate,
  onDismissFailure,
  agentAppMcpLiveStates,
  onCreate,
  onOpenProject,
  onExit,
  onDeleteProject,
  onLoadAgentAppThumbnail,
  onPublishProject,
  onReviewAgentAppMcp,
}: SiteLandingProps) {
  const ko = locale === "ko";
  const [brief, setBrief] = useState("");
  const [surface, setSurface] = useState<SiteSurface>("web");
  const [target, setTarget] = useState<AgentChoice | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"mine" | "multi">("mine");
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [groups, setGroups] = useState<AgentGroupResolved[]>([]);
  const [pendingTarget, setPendingTarget] = useState<AgentChoice | null>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [agentAppPage, setAgentAppPage] = useState(1);
  const [selectedAgentAppId, setSelectedAgentAppId] = useState<string | null>(null);
  const [thumbnailStates, setThumbnailStates] = useState<Record<string, SiteAgentAppThumbnailState>>({});
  const thumbnailRequests = useRef(new Set<string>());
  const mounted = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const loadPicker = async () => {
    if (pickerLoading || agents.length || firms.length || groups.length) return;
    const api = ipc();
    if (!api) {
      setPickerError(ko ? "Electron 브리지를 사용할 수 없습니다." : "Electron bridge unavailable.");
      return;
    }
    setPickerLoading(true);
    setPickerError("");
    try {
      const [agentRows, firmRows, groupRows] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.agentGroups.listResolved(),
      ]);
      setAgents(visibleAgents(agentRows, { includeTeams: true }));
      setFirms(firmRows);
      setGroups(groupRows);
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error));
    } finally {
      setPickerLoading(false);
    }
  };

  useEffect(() => {
    if (pickerOpen) void loadPicker();
    // The picker only refreshes when it is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const myChoices = useMemo<AgentChoice[]>(
    () => agents
      .filter((agent) => (agent.kind ?? "agent") !== "team")
      .map((agent) => ({
        kind: "agent",
        id: agent.id,
        name: agent.localDisplayName || (ko ? agent.name : agent.nameEn || agent.name),
        description: ko ? agent.tagline : agent.taglineEn || agent.tagline,
        meta: ko ? "내 에이전트" : "My agent",
      })),
    [agents, ko],
  );

  const multiChoices = useMemo<AgentChoice[]>(() => [
    ...agents
      .filter((agent) => (agent.kind ?? "agent") === "team")
      .map((agent) => ({
        kind: "team" as const,
        id: agent.id,
        name: agent.localDisplayName || (ko ? agent.name : agent.nameEn || agent.name),
        description: ko ? agent.tagline : agent.taglineEn || agent.tagline,
        meta: ko ? "팀" : "Team",
      })),
    ...firms.map((firm) => ({
      kind: "firm" as const,
      id: firm.id,
      name: ko ? firm.name : firm.nameEn || firm.name,
      description: ko ? firm.tagline : firm.taglineEn || firm.tagline,
      meta: ko ? `${firm.orgChart.length}명 · 회사` : `${firm.orgChart.length} members · Firm`,
    })),
    ...groups
      .filter((group) => group.members.every((member) => member.source !== "hub"))
      .map((group) => ({
      kind: "group" as const,
      id: group.id,
      name: group.name,
      description: group.description,
      meta: ko ? `${group.members.length}명 · 에이전트 조합` : `${group.members.length} members · Agent group`,
      })),
  ], [agents, firms, groups, ko]);

  const pickerChoices = useMemo(() => {
    const rows = pickerTab === "mine" ? myChoices : multiChoices;
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((item) => `${item.name} ${item.description} ${item.meta}`.toLowerCase().includes(q));
  }, [multiChoices, myChoices, pickerQuery, pickerTab]);

  const agentApps = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    return projects.filter((project) => {
      if (project.surface !== "agent-app") return false;
      if (!q) return true;
      return `${project.agentAppTarget?.name || ""} ${project.name}`.toLowerCase().includes(q);
    });
  }, [projectQuery, projects]);

  const standardProjects = useMemo(() => projects.filter((project) => project.surface !== "agent-app"), [projects]);
  const pageCount = Math.max(1, Math.ceil(agentApps.length / AGENT_APPS_PER_PAGE));
  const visibleAgentApps = useMemo(
    () => agentApps.slice((agentAppPage - 1) * AGENT_APPS_PER_PAGE, agentAppPage * AGENT_APPS_PER_PAGE),
    [agentAppPage, agentApps],
  );
  const selectedAgentApp = useMemo(
    () => projects.find((project) => project.id === selectedAgentAppId && project.surface === "agent-app") ?? null,
    [projects, selectedAgentAppId],
  );

  useEffect(() => {
    setAgentAppPage(1);
  }, [projectQuery]);

  useEffect(() => {
    if (agentAppPage > pageCount) setAgentAppPage(pageCount);
  }, [agentAppPage, pageCount]);

  useEffect(() => {
    if (selectedAgentAppId && !projects.some((project) => project.id === selectedAgentAppId && project.surface === "agent-app")) {
      setSelectedAgentAppId(null);
    }
  }, [projects, selectedAgentAppId]);

  useEffect(() => {
    if (!onLoadAgentAppThumbnail) return;
    for (const project of visibleAgentApps) {
      const artifact = project.agentAppArtifact;
      if (artifact?.status !== "ready" || !artifact.thumbnail) continue;
      const requestKey = `${project.id}:${artifact.thumbnail.updatedAt}`;
      if (thumbnailRequests.current.has(requestKey)) continue;
      thumbnailRequests.current.add(requestKey);
      setThumbnailStates((current) => ({ ...current, [project.id]: { status: "loading" } }));
      void onLoadAgentAppThumbnail(project.id).then((result) => {
        if (!mounted.current) return;
        setThumbnailStates((current) => ({
          ...current,
          [project.id]: result.ok
            ? { status: "ready", dataUrl: result.dataUrl }
            : { status: "failed", reason: result.reason },
        }));
      }).catch((error) => {
        if (!mounted.current) return;
        setThumbnailStates((current) => ({
          ...current,
          [project.id]: { status: "failed", reason: error instanceof Error ? error.message : String(error) },
        }));
      });
    }
  }, [onLoadAgentAppThumbnail, visibleAgentApps]);

  const openPicker = () => {
    setPendingTarget(target);
    setPickerQuery("");
    setPickerOpen(true);
  };

  const chooseTemplate = (next: SiteSurface) => {
    if (next === "agent-app") {
      openPicker();
      return;
    }
    setSurface(next);
    setTarget(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submit = () => {
    const text = brief.trim();
    if (!text || busy || noEngine || (surface === "agent-app" && !target)) return;
    onCreate({
      brief: text,
      surface,
      agentAppTarget: surface === "agent-app" && target ? { kind: target.kind, id: target.id } : undefined,
    });
  };

  const disabled = busy || noEngine || !brief.trim() || (surface === "agent-app" && !target);
  const canPublish = Boolean(selectedAgentApp && onPublishProject && selectedAgentApp.agentAppArtifact?.status === "ready");

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerStart}>
          <button type="button" className={styles.exitButton} onClick={onExit}>
            <span aria-hidden="true">←</span> Work
          </button>
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
            <span><strong>Agentlas Site</strong><small>Build interfaces around intelligence</small></span>
          </div>
        </div>
        <div className={styles.headerActions}>
          {selectedAgentApp && <span className={styles.selectedProject}>{selectedAgentApp.agentAppTarget?.name || selectedAgentApp.name}</span>}
          <button
            type="button"
            className={styles.publishButton}
            disabled={!canPublish || busy}
            onClick={() => selectedAgentApp && onPublishProject?.(selectedAgentApp)}
            title={!selectedAgentApp
              ? (ko ? "먼저 아래 Agent App 카드를 선택하세요." : "Select an Agent App card first.")
              : selectedAgentApp.agentAppArtifact?.status !== "ready"
                ? (ko ? "앱 빌드가 완료된 뒤 게시할 수 있습니다." : "Publishing is available after the app build completes.")
                : !onPublishProject
                  ? (ko ? "게시 연결을 준비하는 중입니다." : "Publishing connection is not ready.")
                  : undefined}
          >
            <PublishIcon />
            {ko ? "게시" : "Publish"}
          </button>
        </div>
      </header>

      <section className={styles.hero} aria-labelledby="site-create-heading">
        <span className={styles.eyebrow}>AGENTLAS SITE</span>
        <h1 id="site-create-heading">{ko ? "아이디어를 실제 인터페이스로." : "Turn an idea into a working interface."}</h1>
        <p>{ko ? "웹, 모바일, 에이전트 앱을 한 곳에서 설계하고 실행하세요." : "Design and run web, mobile, and agent-powered apps in one place."}</p>

        <div className={styles.composer} data-busy={busy ? "true" : "false"}>
          <div className={styles.surfaceSwitch} aria-label={ko ? "앱 유형" : "App type"}>
            {(["web", "mobile", "agent-app"] as SiteSurface[]).map((item) => (
              <button
                type="button"
                key={item}
                data-selected={surface === item ? "true" : "false"}
                onClick={() => chooseTemplate(item)}
              >
                {item === "web" ? "Web" : item === "mobile" ? "Mobile" : "Agent App"}
              </button>
            ))}
          </div>
          <textarea
            ref={inputRef}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                if (isImeSubmit(event)) return;
                event.preventDefault();
                submit();
              }
            }}
            placeholder={ko ? "만들고 싶은 화면과 경험을 설명하세요" : "Describe the screen and experience you want to create"}
            aria-label={ko ? "만들 화면 설명" : "Describe what to create"}
            disabled={busy}
          />
          <div className={styles.composerFooter}>
            <div className={styles.composerContext}>
              {surface === "agent-app" ? (
                target ? (
                  <button type="button" className={styles.targetChip} onClick={openPicker}>
                    <span className={styles.targetAvatar}>{target.name.slice(0, 1).toUpperCase()}</span>
                    <span><b>{target.name}</b><small>{target.meta} · Astryx</small></span>
                    <em>{ko ? "변경" : "Change"}</em>
                  </button>
                ) : <button type="button" className={styles.chooseAgentButton} onClick={openPicker}>{ko ? "에이전트 선택" : "Choose an agent"}</button>
              ) : (
                <span className={styles.keyboardHint}>{ko ? "⌘ + Enter로 만들기" : "Press ⌘ + Enter to create"}</span>
              )}
            </div>
            <button type="button" className={styles.sendButton} disabled={disabled} onClick={submit}>
              <span>{generating ? (ko ? "만드는 중" : "Creating") : (ko ? "만들기" : "Create")}</span>
              <ArrowUp />
            </button>
          </div>
        </div>
        {noEngine && <p className={styles.engineWarning} role="status">{ko ? "설정에서 Claude Code 또는 Codex 런타임을 연결하면 생성을 시작할 수 있습니다." : "Connect Claude Code or Codex in Settings to start creating."}</p>}

        {generating && (
          <section className={styles.progressPanel} role="status" aria-live="polite">
            <span className={styles.progressSpinner} aria-hidden="true" />
            <div className={styles.progressCopy}>
              <strong>{activity?.status || (ko ? "Agentlas가 화면과 앱 구조를 만들고 있습니다…" : "Agentlas is composing the interface and app structure…")}</strong>
              {activity?.feedback && <p className={styles.progressFeedback}>{activity.feedback}</p>}
              <small>{ko
                ? "설계에는 보통 1–3분이 걸립니다. 이 화면을 열어 두면 진행 상황이 계속 표시됩니다."
                : "Designing usually takes 1–3 minutes. Keep this screen open to follow the progress."}</small>
            </div>
          </section>
        )}

        {!generating && failure && (
          <section className={styles.failurePanel} role="alert">
            <div className={styles.progressCopy}>
              <strong>{ko ? "이번에는 화면을 만들지 못했어요" : "This attempt did not produce a screen"}</strong>
              <p className={styles.failureReason}>{failure.reason}</p>
              <small>{ko
                ? "입력한 설명은 그대로 두었습니다. 다시 시도하면 같은 요청으로 이어서 만듭니다."
                : "Your description is unchanged. Retrying continues with the same request."}</small>
            </div>
            <div className={styles.failureActions}>
              {onRetryCreate && (
                <button type="button" className={styles.failureRetry} onClick={onRetryCreate} disabled={busy}>
                  {ko ? "다시 시도" : "Try again"}
                </button>
              )}
              {onDismissFailure && (
                <button type="button" className={styles.failureDismiss} onClick={onDismissFailure}>
                  {ko ? "닫기" : "Dismiss"}
                </button>
              )}
            </div>
          </section>
        )}
      </section>

      <section className={styles.templates} aria-labelledby="site-template-heading">
        <div className={styles.sectionHeading}>
          <div><span>STARTING POINTS</span><h2 id="site-template-heading">Use a template</h2></div>
          <p>{ko ? "3개의 목적별 레이아웃" : "Three purpose-built layouts"}</p>
        </div>
        <div className={styles.templateGrid}>
          {([[
            "web", "Web", ko ? "반응형 웹사이트와 대시보드" : "Responsive sites and dashboards",
          ], [
            "mobile", "Mobile", ko ? "모바일 우선 앱 화면" : "Mobile-first app screens",
          ], [
            "agent-app", "Agent App", ko ? "에이전트 입출력에 맞춘 Astryx 앱" : "Astryx apps shaped to agent I/O",
          ]] as Array<[SiteSurface, string, string]>).map(([id, label, description]) => (
            <button key={id} type="button" className={styles.templateCard} data-selected={surface === id ? "true" : "false"} onClick={() => chooseTemplate(id)}>
              <span className={styles.templatePreview}><TemplateIllustration surface={id} /></span>
              <span className={styles.templateCopy}><b>{label}</b><small>{description}</small></span>
              <span className={styles.templateArrow}>↗</span>
            </button>
          ))}
        </div>
      </section>

      <section className={styles.agentApps} aria-labelledby="agent-apps-heading">
        <div className={styles.sectionHeading}>
          <div><span>BUILT WITH ASTRYX</span><h2 id="agent-apps-heading">Agent Apps</h2></div>
          <p>{ko ? "카드를 선택하면 상단 게시 버튼이 활성화됩니다." : "Select a card to enable the Publish action above."}</p>
        </div>
        <div className={styles.galleryToolbar}>
          <span className={styles.resultCount}>{agentApps.length} {ko ? "개 앱" : agentApps.length === 1 ? "app" : "apps"}</span>
          <label className={styles.searchBox}>
            <SearchIcon />
            <input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder={ko ? "Agent App 검색" : "Search Agent Apps"} />
          </label>
        </div>

        {visibleAgentApps.length ? (
          <div className={styles.agentAppGrid}>
            {visibleAgentApps.map((project) => {
              const selected = selectedAgentAppId === project.id;
              const title = project.agentAppTarget?.name || project.name;
              const publish = project.agentAppArtifact?.publish;
              const capabilities = project.agentAppContract?.capabilities;
              const mcpCount = (capabilities?.readonlyMcpCatalogIds?.length ?? 0) +
                (capabilities?.unavailable?.length ?? 0);
              const mcpPresentation = mcpCardPresentation(agentAppMcpLiveStates?.[project.id], ko);
              return (
                <article className={styles.agentAppCard} data-selected={selected ? "true" : "false"} key={project.id}>
                  <button
                    type="button"
                    className={styles.screenshotButton}
                    aria-pressed={selected}
                    aria-label={ko ? `${title} 앱 선택` : `Select ${title}`}
                    onClick={() => setSelectedAgentAppId((current) => current === project.id ? null : project.id)}
                  >
                    <span className={styles.screenshotFrame}>
                      <ThumbnailPlaceholder project={project} thumbnail={thumbnailStates[project.id]} ko={ko} />
                    </span>
                    <span className={styles.selectionMark} aria-hidden="true">{selected ? "✓" : ""}</span>
                  </button>
                  <div className={styles.cardMeta}>
                    <div>
                      <h3>{title}</h3>
                      <p>{targetKindLabel(project, ko)} · Astryx</p>
                    </div>
                    <div className={styles.cardActions}>
                      {mcpCount > 0 && onReviewAgentAppMcp && (
                        <button
                          type="button"
                          className={styles.mcpButton}
                          data-status={mcpPresentation.status}
                          disabled={busy}
                          onClick={() => onReviewAgentAppMcp(project)}
                          title={mcpPresentation.title}
                        >
                          <McpIcon />
                          {mcpPresentation.label}
                        </button>
                      )}
                      <button type="button" className={styles.openButton} disabled={busy || project.agentAppArtifact?.status !== "ready"} onClick={() => onOpenProject(project)}>
                        {ko ? "실행" : "Launch"}<ExternalIcon />
                      </button>
                    </div>
                  </div>
                  <div className={styles.cardFooter}>
                    <time dateTime={project.updatedAt}>{formatDate(project.updatedAt, locale)}</time>
                    {publish?.status === "published" && publish.url
                      ? <span className={styles.liveBadge}>Live · {publish.provider}</span>
                      : publish?.status === "configuration-required"
                        ? <span className={styles.buildBadge} data-status="configuration-required">{ko ? "설정 필요" : "Setup required"} · {publish.provider}</span>
                      : publish?.status === "verification-required"
                        ? <span className={styles.buildBadge} data-status="verification-required">{ko ? "검증 필요" : "Verify"} · {publish.provider}</span>
                      : publish?.status === "provisioning"
                        ? <span className={styles.buildBadge} data-status="provisioning">{ko ? "원격 확인 필요" : "Remote check"} · {publish.provider}</span>
                      : publish?.status === "failed" && (publish.providerProjectId || publish.url)
                        ? <span className={styles.buildBadge} data-status="failed">{ko ? "원격 실패 확인" : "Remote failed"} · {publish.provider}</span>
                      : <span className={styles.buildBadge} data-status={project.agentAppArtifact?.status || "missing"}>{project.agentAppArtifact?.status || (ko ? "앱 미생성" : "not built")}</span>}
                    <button type="button" className={styles.deleteButton} disabled={busy} onClick={() => onDeleteProject(project.id)}>{ko ? "삭제" : "Delete"}</button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className={styles.emptyGallery}>
            <span className={styles.emptyGlyph} aria-hidden="true">A</span>
            <h3>{projects.some((project) => project.surface === "agent-app") ? (ko ? "검색 결과가 없습니다." : "No matching Agent Apps.") : (ko ? "아직 만든 Agent App이 없습니다." : "No Agent Apps yet.")}</h3>
            <p>{ko ? "Agent App 템플릿에서 에이전트를 선택해 첫 앱을 만드세요." : "Choose an agent from the Agent App template to build your first one."}</p>
          </div>
        )}

        {pageCount > 1 && (
          <nav className={styles.pagination} aria-label={ko ? "Agent App 페이지" : "Agent App pages"}>
            <button type="button" disabled={agentAppPage === 1} onClick={() => setAgentAppPage((page) => Math.max(1, page - 1))}>{ko ? "이전" : "Previous"}</button>
            <span>{agentAppPage} / {pageCount}</span>
            <button type="button" disabled={agentAppPage === pageCount} onClick={() => setAgentAppPage((page) => Math.min(pageCount, page + 1))}>{ko ? "다음" : "Next"}</button>
          </nav>
        )}
      </section>

      {standardProjects.length > 0 && (
        <section className={styles.standardProjects} aria-labelledby="standard-projects-heading">
          <div className={styles.sectionHeading}>
            <div><span>CANVAS PROJECTS</span><h2 id="standard-projects-heading">Web &amp; Mobile</h2></div>
          </div>
          <div className={styles.standardProjectList}>
            {standardProjects.map((project) => (
              <article key={project.id}>
                <button type="button" disabled={busy} onClick={() => onOpenProject(project)}>
                  <span className={styles.surfaceTag}>{project.surface === "mobile" ? "M" : "W"}</span>
                  <span><b>{project.name}</b><small>{project.surface === "mobile" ? "Mobile" : "Web"} · {formatDate(project.updatedAt, locale)}</small></span>
                </button>
                <button type="button" className={styles.deleteButton} disabled={busy} onClick={() => onDeleteProject(project.id)}>{ko ? "삭제" : "Delete"}</button>
              </article>
            ))}
          </div>
        </section>
      )}

      {pickerOpen && (
        <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setPickerOpen(false);
        }}>
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="agent-picker-title">
            <div className={styles.dialogHeader}>
              <div><span className={styles.dialogEyebrow}>AGENT APP</span><h2 id="agent-picker-title">{ko ? "앱으로 만들 에이전트 선택" : "Choose an agent for this app"}</h2><p>{ko ? "선택한 에이전트의 입력과 출력에 맞춰 Astryx 웹앱을 만듭니다." : "We will shape an Astryx web app around this agent's inputs and outputs."}</p></div>
              <button type="button" className={styles.dialogClose} aria-label={ko ? "닫기" : "Close"} onClick={() => setPickerOpen(false)}>×</button>
            </div>
            <div className={styles.pickerTabs} role="tablist">
              <button type="button" role="tab" aria-selected={pickerTab === "mine"} onClick={() => { setPickerTab("mine"); setPendingTarget(null); }}>{ko ? "내 에이전트" : "My agents"}</button>
              <button type="button" role="tab" aria-selected={pickerTab === "multi"} onClick={() => { setPickerTab("multi"); setPendingTarget(null); }}>{ko ? "멀티에이전트" : "Multi-agent"}</button>
            </div>
            <label className={styles.pickerSearch}><SearchIcon /><input autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder={ko ? "에이전트 검색" : "Search agents"} /></label>
            <div className={styles.choiceList} role="listbox" aria-label={ko ? "에이전트 목록" : "Agent list"}>
              {pickerLoading && <div className={styles.choiceEmpty}>{ko ? "에이전트를 불러오는 중…" : "Loading agents…"}</div>}
              {pickerError && <div className={styles.choiceError}>{pickerError}</div>}
              {!pickerLoading && !pickerError && pickerChoices.map((choice) => {
                const selected = pendingTarget?.kind === choice.kind && pendingTarget.id === choice.id;
                return (
                  <button type="button" role="option" aria-selected={selected} className={styles.choice} data-selected={selected ? "true" : "false"} key={`${choice.kind}:${choice.id}`} onClick={() => setPendingTarget(choice)}>
                    <span className={styles.choiceAvatar}>{choice.name.slice(0, 1).toUpperCase()}</span>
                    <span className={styles.choiceCopy}><b>{choice.name}</b><small>{choice.description || (ko ? "설명이 없습니다." : "No description.")}</small></span>
                    <span className={styles.choiceMeta}>{choice.meta}</span>
                  </button>
                );
              })}
              {!pickerLoading && !pickerError && !pickerChoices.length && <div className={styles.choiceEmpty}>{ko ? "선택할 수 있는 항목이 없습니다." : "No available choices."}</div>}
            </div>
            <div className={styles.dialogFooter}>
              <span><b>Astryx</b> · official React components · v0.1.4</span>
              <div>
                <button type="button" className={styles.secondaryAction} onClick={() => setPickerOpen(false)}>{ko ? "취소" : "Cancel"}</button>
                <button type="button" className={styles.primaryAction} disabled={!pendingTarget} onClick={() => {
                  if (!pendingTarget) return;
                  setTarget(pendingTarget);
                  setSurface("agent-app");
                  setPickerOpen(false);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}>{ko ? "이 에이전트로 만들기" : "Use this agent"}</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
