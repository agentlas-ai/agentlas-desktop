// Agent OS workbench panel.
// Renders traditional code artifacts and safe Agentlas Surface manifests in one
// in-app right-side workspace. Surface manifests remain declarative; registered
// live apps run in a sandboxed native web surface with no Desktop IPC.
"use client";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { buildSurfaceDelegationPlan } from "@shared/surface-delegation";
import type { AgentlasSurfaceCredentialRequest, AgentlasSurfacePaymentRequest } from "@shared/surface-delegation";
import { sanitizePublicAppCopy } from "@shared/brand-safety";
import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceDataSet,
  AgentlasSurfaceFlintInput,
  AgentlasSurfaceManifest,
  JsonObject,
  JsonValue,
  SurfaceJobCostSummary,
  SurfaceStatePatchRequest,
} from "@/lib/types";
import type { CodeArtifact } from "./Markdown";
import { CodeIdeViewer } from "./CodeIdeViewer";
import {
  IconBolt,
  IconCircleDollar,
  IconCheck,
  IconClose,
  IconFileUp,
  IconFilm,
  IconImage,
  IconKey,
  IconLayers,
  IconLock,
  IconRoute,
  IconShield,
  IconSparkles,
  IconStore,
  IconTarget,
  IconWand,
} from "./Icon";
import { useT } from "@/lib/i18n";
import { LiveDeviceMockup } from "./LiveDeviceMockup";
import { OneLiveMap } from "./one/OneLiveMap";
import { FlintChart } from "./FlintChart";
import type { FlintChartRenderInput } from "@/lib/flint-runtime";
import type { OneSurfaceMapBlock } from "@shared/one-surface";
import { designOutputSurfaceProps, designSurfaceKindForOutput } from "@/lib/design-output-tokens";

export interface WorkbenchSurface {
  id: string;
  manifest: AgentlasSurfaceManifest;
  state?: JsonObject;
  jobSummary?: SurfaceJobCostSummary;
  /** Durable generated-app record backing a real live preview, when one exists. */
  liveAppId?: string;
}

export type SurfaceActionHandler = (
  surface: WorkbenchSurface,
  action: AgentlasSurfaceAction,
) => void | Promise<void>;

export type SurfaceStatePatchHandler = (
  surface: WorkbenchSurface,
  patch: Omit<SurfaceStatePatchRequest, "surfaceId">,
) => void;

/** A live app owns the result canvas; blueprint chrome belongs only to the
 * non-running fallback. Keep this predicate shared by the outer shell and the
 * app surface so a preview URL cannot accidentally render both layers. */
function isLiveAppSurface(surface: WorkbenchSurface | null): boolean {
  const previewUrl = surface?.manifest.app?.deployment?.previewUrl;
  return Boolean(
    surface?.liveAppId ||
    (typeof previewUrl === "string" && previewUrl.trim()),
  );
}

export function WorkbenchPanel({
  artifact,
  surface,
  onClose,
  onSurfaceAction,
  onSurfaceStatePatch,
  embedded = false,
}: {
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
  onClose?: () => void;
  onSurfaceAction?: SurfaceActionHandler;
  onSurfaceStatePatch?: SurfaceStatePatchHandler;
  embedded?: boolean;
}) {
  const { t } = useT();
  if (!artifact && !surface) return null;

  const isSurface = surface !== null;
  const title = surface?.manifest.title ?? artifact?.language ?? "Artifact";
  const subtitle = surface
    ? `${surface.manifest.domain} · ${surface.manifest.layout}`
    : artifact
      ? t("chatstream.lines", { count: artifact.code.split("\n").length })
      : "";
  const outputKind = surface
    ? designSurfaceKindForOutput(surface.manifest.layout)
    : "code";
  const liveAppSurface = isLiveAppSurface(surface);

  return (
    <aside
      {...designOutputSurfaceProps(outputKind, "agentlas-workbench-panel")}
      data-live-app-surface={liveAppSurface ? "true" : "false"}
      style={liveAppSurface ? (embedded ? liveEmbeddedShell : liveShell) : (embedded ? embeddedShell : shell)}
    >
      <style>{`
        @keyframes workbench-in {
          from { transform: translateX(20px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @media (max-width: 980px) {
          .agentlas-workbench-panel {
            width: min(520px, 100vw) !important;
            min-width: 0 !important;
          }
          .agentlas-creative-grid {
            grid-template-columns: 1fr !important;
          }
          .agentlas-workbench-hero {
            flex-direction: column !important;
          }
          .agentlas-workbench-pills {
            justify-content: flex-start !important;
            max-width: none !important;
          }
          .agentlas-generic-content {
            grid-template-columns: 1fr !important;
          }
          .agentlas-app-preview-body,
          .agentlas-app-lower-grid,
          .agentlas-app-metric-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
      {!liveAppSurface && (
        <>
          <header style={header}>
            <div style={mark}>
              {isSurface ? <IconSparkles size={15} /> : <IconLayers size={15} />}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={eyebrow}>{isSurface ? "Agent OS Workbench" : "Code Artifact"}</div>
              <div style={titleStyle} title={title}>
                {title}
              </div>
            </div>
            {subtitle && <span style={chip}>{subtitle}</span>}
            <button
              onClick={() =>
                void navigator.clipboard.writeText(
                  surface ? JSON.stringify(surface.manifest, null, 2) : artifact?.code ?? "",
                )
              }
              style={ghostButton}
            >
              {t("chatstream.copy")}
            </button>
            {onClose && (
              <button onClick={onClose} aria-label={t("chatstream.close_panel")} title={t("chatstream.close")} style={iconButton}>
                <IconClose size={15} />
              </button>
            )}
          </header>
          <ExportBar artifact={artifact} surface={surface} />
        </>
      )}
      {surface ? (
        <SurfaceWorkbench surface={surface} onAction={onSurfaceAction} onStatePatch={onSurfaceStatePatch} wide={embedded} />
      ) : artifact ? (
        <CodeWorkbench artifact={artifact} />
      ) : null}
    </aside>
  );
}

/**
 * ExportBar — 산출물을 .agentlas/MD/JSON 등으로 가져갈 수 있다는 점을 노출. "내보내기: lock-in 없음".
 * MD/JSON 복사는 클립보드로, "파일로 저장"은 fs.saveTextFile(네이티브 저장 다이얼로그)로 디스크에 실제 기록한다.
 */
function ExportBar({
  artifact,
  surface,
}: {
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [copied, setCopied] = useState<string | null>(null);

  // 실제로 클립보드에 넣을 수 있는 내용물만 — 없으면 버튼 비활성.
  const copyAsMarkdown = () => {
    const text = surface
      ? surfaceToMarkdown(surface)
      : artifact
        ? `\`\`\`${artifact.language || ""}\n${artifact.code}\n\`\`\``
        : "";
    if (!text) return;
    void copyToClipboard(text, "md");
  };
  const copyAsJson = () => {
    const text = surface
      ? JSON.stringify(surface.manifest, null, 2)
      : artifact
        ? JSON.stringify({ id: artifact.id, language: artifact.language, code: artifact.code }, null, 2)
        : "";
    if (!text) return;
    void copyToClipboard(text, "json");
  };
  const copyToClipboard = async (text: string, which: string) => {
    try {
      await navigator.clipboard.writeText(text);
      flash(which);
    } catch {
      flash(`${which}-error`);
    }
  };
  const flash = (which: string) => {
    setCopied(which);
    window.setTimeout(() => setCopied((cur) => (cur === which ? null : cur)), 1600);
  };

  // 파일로 저장 — 네이티브 저장 다이얼로그(fs.saveTextFile)로 디스크에 실제로 쓴다. lock-in 없음.
  const saveToFile = async () => {
    const api = window.agentlas?.fs;
    if (!api?.saveTextFile) return;
    const langExt: Record<string, string> = {
      typescript: "ts", javascript: "js", tsx: "tsx", jsx: "jsx",
      python: "py", json: "json", html: "html", css: "css", markdown: "md",
    };
    const name = surface
      ? `${surface.id || "surface"}.agentlas.json`
      : `artifact.${langExt[(artifact?.language || "").toLowerCase()] || "txt"}`;
    const content = surface
      ? JSON.stringify(surface.manifest, null, 2)
      : (artifact?.code ?? "");
    if (!content) return;
    const res = await api.saveTextFile(name, content);
    if (res.ok) flash("saved");
    else if (!res.canceled) flash("save-error");
  };

  const hasContent = Boolean(artifact || surface);
  if (!hasContent) return null;

  // ArtifactFileBridge — 이 산출물이 디스크 어디에 연결돼 있는지 실측 경로만 표시(없으면 미표시).
  const diskPath = surface ? surfaceDiskPath(surface) : null;

  return (
    <div style={exportBar}>
      <span style={exportLabel}>
        {ko ? "내보내기" : "Export"}
        <span style={exportLockFree}>{ko ? "lock-in 없음" : "no lock-in"}</span>
      </span>
      <button type="button" style={exportButton} onClick={copyAsMarkdown}>
        {copied === "md" ? (ko ? "복사됨" : "Copied") : copied === "md-error" ? (ko ? "복사 실패" : "Copy failed") : ko ? "MD 복사" : "Copy MD"}
      </button>
      <button type="button" style={exportButton} onClick={copyAsJson}>
        {copied === "json" ? (ko ? "복사됨" : "Copied") : copied === "json-error" ? (ko ? "복사 실패" : "Copy failed") : ko ? "JSON 복사" : "Copy JSON"}
      </button>
      {/* 파일로 저장 — 네이티브 저장 다이얼로그로 디스크에 실제 기록(fs.saveTextFile) */}
      <button
        type="button"
        style={exportButton}
        onClick={saveToFile}
        title={ko ? "산출물을 내 디스크의 파일로 저장합니다 (lock-in 없음)" : "Save the artifact to a file on your disk (no lock-in)"}
      >
        {copied === "saved"
          ? ko ? "저장됨" : "Saved"
          : copied === "save-error"
            ? ko ? "저장 실패" : "Save failed"
            : ko ? "파일로 저장" : "Save to file"}
      </button>
      {diskPath && (
        <span style={exportFileBridge} title={diskPath}>
          <IconLayers size={11} />
          {ko ? "파일 위치" : "On disk"} · <code style={exportFilePath}>{diskPath}</code>
        </span>
      )}
    </div>
  );
}

/**
 * ArtifactFileBridge — surface가 실제 디스크에 연결된 경로를 실측으로 찾는다.
 * 1순위: app.deployment.repoPath, 2순위: artifacts 데이터셋 row의 path 필드. 둘 다 없으면 null
 * (지어내지 않음 — CodeArtifact에는 경로 자체가 없어 항상 null).
 */
function surfaceDiskPath(surface: WorkbenchSurface): string | null {
  const repoPath = surface.manifest.app?.deployment?.repoPath;
  if (typeof repoPath === "string" && repoPath.trim()) return repoPath.trim();
  const artifactData = dataByName(surface.manifest, "artifacts") ?? firstData(surface.manifest, "artifacts");
  for (const row of rowsOf(artifactData)) {
    const path = stringField(row, "path") || stringField(row, "filePath") || stringField(row, "rootPath");
    if (path && path.trim()) return path.trim();
  }
  return null;
}

/** Surface manifest를 사람이 읽는 마크다운으로 — 내보내기용. 실측 필드만, 추측 금지. */
function surfaceToMarkdown(surface: WorkbenchSurface): string {
  const m = surface.manifest;
  const lines: string[] = [`# ${m.title}`, "", `- domain: ${m.domain}`, `- layout: ${m.layout}`];
  const dataKeys = Object.keys(m.data ?? {});
  if (dataKeys.length > 0) {
    lines.push("", "## Data", ...dataKeys.map((k) => `- ${k}`));
  }
  lines.push("", "```json", JSON.stringify(m, null, 2), "```");
  return lines.join("\n");
}

export function SurfaceWorkbench({
  surface,
  onAction,
  onStatePatch,
  wide = false,
}: {
  surface: WorkbenchSurface;
  onAction?: SurfaceActionHandler;
  onStatePatch?: SurfaceStatePatchHandler;
  wide?: boolean;
}) {
  if (isLiveAppSurface(surface)) {
    return <LiveAppSurface surface={surface} />;
  }

  const manifest = surface.manifest;
  const widgetTypes = new Set(manifest.widgets.map((w) => w.type));
  if (
    manifest.layout === "service-app" ||
    widgetTypes.has("app-shell") ||
    widgetTypes.has("service-blueprint") ||
    widgetTypes.has("mcp-builder")
  ) {
    return <AppFactorySurface surface={surface} onAction={onAction} />;
  }
  if (manifest.layout === "creative-studio" || widgetTypes.has("storyboard") || widgetTypes.has("asset-board")) {
    return <CreativeStudioSurface surface={surface} onAction={onAction} onStatePatch={onStatePatch} />;
  }
  return <GenericSurface surface={surface} onAction={onAction} wide={wide} />;
}

/** The live URL is the result. Keep it as the only child of the result rail so
 * the old blueprint/Export chrome cannot compete with the running page. */
function LiveAppSurface({ surface }: { surface: WorkbenchSurface }) {
  const app = surface.manifest.app;
  const title = sanitizePublicAppCopy(app?.name || surface.manifest.title, surface.manifest.title);
  return (
    <div
      {...designOutputSurfaceProps("web", "agentlas-live-app-canvas")}
      data-live-app-canvas="true"
      aria-label={`${title} live app`}
      style={liveAppCanvas}
    >
      <RunningAppPreview
        appId={surface.liveAppId}
        declaredUrl={app?.deployment?.previewUrl}
        title={title}
      />
    </div>
  );
}

function RunningAppPreview({
  appId,
  declaredUrl,
  title,
}: {
  appId?: string;
  declaredUrl?: string;
  title: string;
}) {
  const { locale } = useT();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    pending: boolean;
    url: string | null;
    runtime: string | null;
    error: string | null;
  }>({
    pending: Boolean(appId),
    url: appId ? null : declaredUrl?.trim() || null,
    runtime: appId ? null : "declared web",
    error: null,
  });

  useEffect(() => {
    let disposed = false;
    const direct = declaredUrl?.trim() || null;
    if (!appId) {
      setState({
        pending: false,
        url: direct,
        runtime: direct ? "declared web" : null,
        error: direct ? null : "No live URL is attached to this app.",
      });
      return;
    }
    setState({ pending: true, url: null, runtime: null, error: null });
    void window.agentlas.appFactory.startLivePreview({ appId }).then((result) => {
      if (disposed) return;
      if (result.ok && result.url) {
        setState({ pending: false, url: result.url, runtime: result.runtime, error: null });
      } else if (direct) {
        setState({ pending: false, url: direct, runtime: "declared web", error: null });
      } else {
        setState({
          pending: false,
          url: null,
          runtime: result.runtime,
          error: result.reason || "The app runtime is not reachable.",
        });
      }
    }).catch((error) => {
      if (disposed) return;
      if (direct) setState({ pending: false, url: direct, runtime: "declared web", error: null });
      else setState({
        pending: false,
        url: null,
        runtime: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return () => {
      disposed = true;
      /*
       * 켜기만 하고 끄는 곳이 없었다(감사 2026-08-25). 이 화면을 떠나도 앱
       * 미리보기 서버가 계속 떠 있고, 앱 안에서 끌 방법이 없다. 이 칸이
       * 사라질 때가 그 서버가 필요 없어지는 때다.
       */
      void window.agentlas?.appFactory?.stopLivePreview?.({ appId }).catch(() => undefined);
    };
  }, [appId, declaredUrl, attempt]);

  if (state.url) {
    const viewId = appId
      ? `work_app_${appId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}`
      : undefined;
    return (
      <LiveDeviceMockup
        url={state.url}
        title={title}
        runtimeLabel={state.runtime ?? undefined}
        locale={locale}
        viewId={viewId}
      />
    );
  }
  return (
    <section style={appRuntimeUnavailable} role={state.error ? "alert" : "status"}>
      <span style={appRuntimeStatusDot} />
      <div>
        <strong>{state.pending ? "Starting the real app runtime…" : "Live app unavailable"}</strong>
        <p>{state.pending ? "Allocating a private loopback URL and attaching the in-app web surface." : state.error}</p>
      </div>
      {!state.pending ? (
        <button type="button" style={exportButton} onClick={() => setAttempt((value) => value + 1)}>Retry</button>
      ) : null}
    </section>
  );
}

function AppFactorySurface({
  surface,
  onAction,
}: {
  surface: WorkbenchSurface;
  onAction?: SurfaceActionHandler;
}) {
  const manifest = surface.manifest;
  const app = manifest.app;
  const routes =
    app?.routes ??
    rowsOf(dataByName(manifest, "routes") ?? firstData(manifest, "routes")).map((row, idx) => ({
      path: stringField(row, "path") || `/${idx === 0 ? "" : `screen-${idx + 1}`}`,
      label: stringField(row, "label") || stringField(row, "name") || `Screen ${idx + 1}`,
      purpose: stringField(row, "purpose") || stringField(row, "description"),
      status: stringField(row, "status") || "planned",
    }));
  const connectors =
    app?.connectors ??
    rowsOf(dataByName(manifest, "connectors") ?? firstData(manifest, "connectors")).map((row, idx) => ({
      id: stringField(row, "id") || `connector-${idx + 1}`,
      name: stringField(row, "name") || `Connector ${idx + 1}`,
      type: stringField(row, "type") || "mcp",
      purpose: stringField(row, "purpose") || stringField(row, "description"),
      auth: stringField(row, "auth") || "user-approval",
      status: stringField(row, "status") || "proposed",
    }));
  const tools =
    app?.tools ??
    rowsOf(dataByName(manifest, "tools") ?? firstData(manifest, "tools")).map((row, idx) => ({
      id: stringField(row, "id") || `tool-${idx + 1}`,
      name: stringField(row, "name") || `Tool ${idx + 1}`,
      description: stringField(row, "description") || stringField(row, "purpose") || "Agent-made local tool",
      kind: stringField(row, "kind") || "validator",
    }));
  const launchRows = rowsOf(dataByName(manifest, "launch") ?? firstData(manifest, "launch-checklist"));
  const artifactRows = rowsOf(dataByName(manifest, "artifacts") ?? firstData(manifest, "artifacts"));
  const metricsRows = rowsOf(dataByName(manifest, "metrics") ?? firstData(manifest, "metrics"));
  const appName = sanitizePublicAppCopy(app?.name || manifest.title, manifest.title);
  const tagline = sanitizePublicAppCopy(app?.tagline || app?.valueProp, "Agent-made app blueprint");
  const business = app?.business ?? objectValue(dataByName(manifest, "business"));

  return (
    <div style={surfaceBody}>
      <div className="agentlas-creative-grid" style={appFactoryGrid}>
        <section style={leftRail}>
          <SectionTitle icon={<IconTarget size={14} />} label="Product Thesis" />
          <div style={appThesis}>
            <strong>{appName}</strong>
            <span>{tagline}</span>
          </div>
          <KeyValueList
            value={{
              audience: sanitizePublicAppCopy(app?.audience || business?.audience, "Not declared"),
              offer: sanitizePublicAppCopy(business?.offer || app?.valueProp, "Not declared"),
              pricing: sanitizePublicAppCopy(business?.pricing, "Not declared"),
              moat: sanitizePublicAppCopy(business?.moat, "Not declared"),
            }}
            fallback="No product thesis yet."
          />

          <SectionTitle icon={<IconCircleDollar size={14} />} label="Business Pack" />
          <div style={miniStack}>
            <div style={businessRow}>
              <strong>{sanitizePublicAppCopy(business?.launchMetric, "Not declared")}</strong>
              <span>launch metric</span>
            </div>
            <div style={businessRow}>
              <strong>{sanitizePublicAppCopy(app?.appType, "service-app")}</strong>
              <span>product type</span>
            </div>
          </div>
        </section>

        <main style={centerRail}>
          <div className="agentlas-workbench-hero" style={appHeroBand}>
            <div>
              <div style={eyebrowDark}>Agent-made App</div>
              <h2 style={surfaceTitle}>{appName}</h2>
              <p style={appHeroCopy}>{tagline}</p>
            </div>
            <div className="agentlas-workbench-pills" style={formatPills}>
              <span style={darkPill}>{app?.deployment?.readiness || "readiness pending"}</span>
              <span style={darkPill}>{connectors.length} services</span>
              <span style={darkPill}>{routes.length} screens</span>
            </div>
          </div>

          <section style={appPreviewShell} aria-label={`${appName} blueprint, not running`}>
            <div style={appPreviewTopbar}>
              <span style={appLogoMark}>{appName.slice(0, 1).toUpperCase()}</span>
              <strong>{appName}</strong>
              <nav style={appPreviewNav}>
                {routes.slice(0, 4).map((route) => (
                  <span key={route.path}>{sanitizePublicAppCopy(route.label, route.label)}</span>
                ))}
                {routes.length === 0 && <span>No screens declared</span>}
              </nav>
            </div>
            <div className="agentlas-app-preview-body" style={appPreviewBody}>
              <div style={appPreviewMain}>
                <div style={appPreviewHeadline}>
                  <span>Blueprint · not running</span>
                  <strong>{sanitizePublicAppCopy(routes[0]?.purpose, "No primary route declared.")}</strong>
                </div>
                <div className="agentlas-app-metric-grid" style={metricGrid}>
                  {metricsRows.length > 0 ? (
                    metricsRows.slice(0, 3).map((row, idx) => (
                      <div key={idx} style={metricCard}>
                        <span>{stringField(row, "label") || stringField(row, "name") || `Metric ${idx + 1}`}</span>
                        <strong>{stringField(row, "value") || stringField(row, "amount") || "Not declared"}</strong>
                        <EvidencePill kind={evidenceKindForRow(row, manifest)} />
                      </div>
                    ))
                  ) : (
                    <div style={emptyGridNote}>No metrics declared.</div>
                  )}
                </div>
              </div>
              <div style={appPreviewSide}>
                <SectionTitle icon={<IconBolt size={13} />} label="Agent Runtime" />
                <div style={miniStack}>
                  {connectors.slice(0, 4).map((c) => (
                    <div key={c.id} style={connectorRow}>
                      <span style={connectorIcon}>{String(c.type || "mcp").slice(0, 3).toUpperCase()}</span>
                      <span style={truncate}>{c.name}</span>
                      <small>{c.status || "proposed"}</small>
                    </div>
                  ))}
                  {connectors.length === 0 && <div style={mutedSmall}>No connectors declared yet.</div>}
                </div>
                <SectionTitle icon={<IconWand size={13} />} label="Agent Tools" />
                <div style={miniStack}>
                  {tools.slice(0, 4).map((tool) => (
                    <div key={tool.id} style={connectorRow}>
                      <span style={connectorIcon}>TL</span>
                      <span style={truncate}>{tool.name}</span>
                      <small>{tool.kind || "tool"}</small>
                    </div>
                  ))}
                  {tools.length === 0 && <div style={mutedSmall}>No local tools declared yet.</div>}
                </div>
              </div>
            </div>
          </section>

          <section className="agentlas-app-lower-grid" style={appLowerGrid}>
            <div style={genericColumn}>
              <SectionTitle icon={<IconRoute size={14} />} label="Screens" />
              <div style={miniStack}>
                {routes.slice(0, 6).map((route) => (
                  <div key={route.path} style={routeRow}>
                    <strong>{sanitizePublicAppCopy(route.label, route.label)}</strong>
                    <span>{route.path}</span>
                  </div>
                ))}
                {routes.length === 0 && <div style={mutedSmall}>No screens declared yet.</div>}
              </div>
            </div>
            <div style={genericColumn}>
              <SectionTitle icon={<IconFileUp size={14} />} label="Artifacts" />
              <div style={miniStack}>
                {artifactRows.length > 0 ? (
                  artifactRows.slice(0, 6).map((row, idx) => {
                    // ArtifactFileBridge — 산출물의 실제 디스크 경로가 있으면 명시적으로 노출(없으면 미표시).
                    const filePath =
                      stringField(row, "path") ||
                      stringField(row, "filePath") ||
                      stringField(row, "rootPath");
                    return (
                      <div key={idx} style={artifactRow}>
                        <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                          <span style={truncate}>
                            {stringField(row, "name") || filePath || `Artifact ${idx + 1}`}
                          </span>
                          {filePath && (
                            <code style={artifactPathStyle} title={filePath}>
                              {filePath}
                            </code>
                          )}
                        </div>
                        <small>{stringField(row, "status") || "Not declared"}</small>
                      </div>
                    );
                  })
                ) : (
                  <div style={mutedSmall}>No artifacts declared yet.</div>
                )}
              </div>
            </div>
          </section>
        </main>

        <section style={rightRail}>
          <SectionTitle icon={<IconStore size={14} />} label="Ship Console" />
          <div style={actionStack}>
            {(manifest.actions ?? []).slice(0, 6).map((action) => (
              <SurfaceActionButton
                key={action.id}
                surface={surface}
                action={action}
                onAction={onAction}
              />
            ))}
            {(manifest.actions ?? []).length === 0 && <div style={mutedSmall}>No launch actions declared.</div>}
          </div>

          <GovernancePanel manifest={manifest} jobSummary={surface.jobSummary} />
          <DelegationPanel surface={surface} onAction={onAction} />

          <SectionTitle icon={<IconShield size={14} />} label="Launch Proof" />
          <div style={miniStack}>
            {launchRows.length > 0 ? (
              launchRows.slice(0, 7).map((row, idx) => (
                <div key={idx} style={launchRow}>
                  <IconCheck size={12} />
                  <span>{stringField(row, "item") || stringField(row, "label") || `Check ${idx + 1}`}</span>
                  <small>{stringField(row, "status") || "Not declared"}</small>
                </div>
              ))
            ) : (
              <div style={mutedSmall}>No launch checks declared yet.</div>
            )}
          </div>

          <SectionTitle icon={<IconLayers size={14} />} label="Deployment" />
          <KeyValueList
            value={
              app?.deployment
                ? {
                    target: app.deployment.target || "Not declared",
                    repoPath: app.deployment.repoPath || "Not declared",
                    command: app.deployment.command || "Not declared",
                    previewUrl: app.deployment.previewUrl || "Not declared",
                  }
                : undefined
            }
            fallback="No deployment plan yet."
          />
        </section>
      </div>
    </div>
  );
}

function CreativeStudioSurface({
  surface,
  onAction,
  onStatePatch,
}: {
  surface: WorkbenchSurface;
  onAction?: SurfaceActionHandler;
  onStatePatch?: SurfaceStatePatchHandler;
}) {
  const manifest = surface.manifest;
  const brief = dataByName(manifest, "brief") ?? firstData(manifest, "json");
  const shots = dataByName(manifest, "shots") ?? firstData(manifest, "table");
  const assets = dataByName(manifest, "assets") ?? firstData(manifest, "media");
  const shotRows = rowsWithSurfaceState(surface, "shots", rowsOf(shots));
  const assetRows = rowsWithSurfaceState(surface, "assets", rowsOf(assets));
  const canPatchShots = isUserOwnedRows(surface, "shots");
  const provenanceRows =
    (manifest.provenance ?? []).length > 0
      ? (manifest.provenance ?? []).map((item) => ({
          source: item.source,
          note: item.note || item.url || item.retrievedAt,
        }))
      : (manifest.evidence ?? [])
          .filter((item) => item.source || item.url)
          .map((item) => ({
            source: item.source || item.url || item.id,
            note: item.kind,
          }));

  return (
    <div style={surfaceBody}>
      <div className="agentlas-creative-grid" style={creativeGrid}>
        <section style={leftRail}>
          <SectionTitle icon={<IconWand size={14} />} label="Brief" />
          <KeyValueList value={brief?.value} fallback={brief?.summary ?? "No brief data yet."} />
          <SectionTitle icon={<IconRoute size={14} />} label="Model Router" />
          <div style={miniStack}>
            {shotRows.slice(0, 4).map((row, idx) => (
              <div key={idx} style={routerRow}>
                <span style={dot} />
                <span style={truncate}>{stringField(row, "model") || "auto"}</span>
              </div>
            ))}
            {shotRows.length === 0 && <div style={mutedSmall}>Waiting for planned shots.</div>}
          </div>
        </section>

        <main style={centerRail}>
          <div className="agentlas-workbench-hero" style={heroBand}>
            <div>
              <div style={eyebrowDark}>Creative Studio</div>
              <h2 style={surfaceTitle}>{manifest.title}</h2>
            </div>
            <div className="agentlas-workbench-pills" style={formatPills}>
              <span style={darkPill}>Storyboard</span>
              <span style={darkPill}>Assets</span>
              <span style={darkPill}>Exports</span>
            </div>
          </div>

          <section style={timelineSection}>
            <SectionTitle icon={<IconFilm size={14} />} label="Storyboard" />
            <div style={shotStrip}>
              {shotRows.length > 0 ? (
                shotRows.slice(0, 8).map((row, idx) => (
                  <ShotCard
                    key={idx}
                    index={idx + 1}
                    row={row}
                    editable={canPatchShots}
                    onStatusChange={(status) =>
                      onStatePatch?.(surface, {
                        path: `/data/shots/rows/${idx}/status`,
                        value: status,
                        actor: "user",
                        label: `${status} shot ${idx + 1}`,
                      })
                    }
                  />
                ))
              ) : (
                <div style={mutedSmall}>No storyboard shots declared yet.</div>
              )}
            </div>
          </section>

          <section style={assetSection}>
            <SectionTitle icon={<IconImage size={14} />} label="Asset Board" />
            <div style={assetGrid}>
              {assetRows.length > 0 ? (
                assetRows.slice(0, 6).map((row, idx) => (
                  <AssetTile key={idx} row={row} index={idx + 1} manifest={manifest} />
                ))
              ) : (
                <div style={mutedSmall}>No assets declared yet.</div>
              )}
            </div>
          </section>
        </main>

        <section style={rightRail}>
          <SectionTitle icon={<IconCheck size={14} />} label="Actions" />
          <div style={actionStack}>
            {(manifest.actions ?? []).slice(0, 5).map((action) => (
              <SurfaceActionButton
                key={action.id}
                surface={surface}
                action={action}
                onAction={onAction}
              />
            ))}
            {(manifest.actions ?? []).length === 0 && <div style={mutedSmall}>No actions declared.</div>}
          </div>
          <GovernancePanel manifest={manifest} jobSummary={surface.jobSummary} />
          <DelegationPanel surface={surface} onAction={onAction} />
          <SectionTitle icon={<IconLayers size={14} />} label="Provenance" />
          <div style={miniStack}>
            {provenanceRows.slice(0, 4).map((p, idx) => (
              <div key={idx} style={provenanceRow}>
                <strong>{p.source}</strong>
                {p.note && <span>{p.note}</span>}
              </div>
            ))}
            {provenanceRows.length === 0 && <div style={mutedSmall}>No sources attached.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function GenericSurface({
  surface,
  onAction,
  wide = false,
}: {
  surface: WorkbenchSurface;
  onAction?: SurfaceActionHandler;
  wide?: boolean;
}) {
  const { locale } = useT();
  const manifest = surface.manifest;
  const first = Object.entries(manifest.data)[0];
  const rows = rowsOf(first?.[1]);
  const mapBlock = surfaceMapBlock(manifest);
  const chartBlocks = manifest.widgets.flatMap((widget, index) => {
    const input = surfaceChartInput(manifest, widget);
    return input ? [{ input, title: widget.title || `${manifest.title} chart ${index + 1}` }] : [];
  });
  return (
    <div style={surfaceBody}>
      <section style={genericHero}>
        <div style={eyebrowDark}>Generated Workbench</div>
        <h2 style={surfaceTitle}>{manifest.title}</h2>
        <div className="agentlas-workbench-pills" style={formatPills}>
          <span style={darkPill}>{manifest.domain}</span>
          <span style={darkPill}>{manifest.layout}</span>
          <span style={darkPill}>{manifest.widgets.length} widgets</span>
        </div>
      </section>
      {mapBlock && (
        <section style={genericMapSection} data-surface-renderer="live-map">
          <SectionTitle icon={<IconRoute size={14} />} label={mapBlock.title} />
          <OneLiveMap block={mapBlock} locale={locale} compact={!wide} />
        </section>
      )}
      {chartBlocks.map(({ input, title }) => (
        <section key={title} style={genericMapSection} data-surface-block-type="chart">
          <SectionTitle icon={<IconSparkles size={14} />} label={title} />
          <FlintChart input={input} title={title} />
        </section>
      ))}
      <section className="agentlas-generic-content" style={genericContent}>
        <div style={genericColumn}>
          <SectionTitle icon={<IconLayers size={14} />} label="Widgets" />
          <div style={miniStack}>
            {manifest.widgets.map((widget, idx) => (
              <div key={`${widget.type}-${idx}`} style={widgetRow}>
                <span>{widget.type}</span>
                {widget.data && <small>{widget.data}</small>}
              </div>
            ))}
          </div>
        </div>
        <div style={genericColumnWide}>
          <SectionTitle icon={<IconSparkles size={14} />} label={first?.[0] ?? "Data"} />
          <SimpleTable rows={rows} />
          {(manifest.actions ?? []).length > 0 && (
            <div style={genericActionRow}>
              {(manifest.actions ?? []).slice(0, 4).map((action) => (
                <SurfaceActionButton
                  key={action.id}
                  surface={surface}
                  action={action}
                  onAction={onAction}
                />
              ))}
            </div>
          )}
          <GovernancePanel manifest={manifest} jobSummary={surface.jobSummary} />
          <DelegationPanel surface={surface} onAction={onAction} />
        </div>
      </section>
    </div>
  );
}

function SurfaceActionButton({
  surface,
  action,
  onAction,
}: {
  surface: WorkbenchSurface;
  action: AgentlasSurfaceAction;
  onAction?: SurfaceActionHandler;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = surfaceActionProfile(action, ko);
  const title = [
    action.prompt || action.url || action.label,
    profile.description,
  ].filter(Boolean).join("\n\n");

  const run = async () => {
    if (pending) return;
    if (!onAction) {
      setError(ko ? "실행할 수 없는 작업입니다." : "This action is not available.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onAction(surface, action);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <button
        type="button"
        style={{ ...actionButton, ...profile.style, opacity: pending ? 0.68 : 1 }}
        title={title}
        onClick={() => void run()}
        disabled={pending}
      >
        <span style={actionButtonTopLine}>
          <span style={truncate}>{pending ? (ko ? "진행 중..." : "Running...") : action.label}</span>
          <span style={profile.badgeStyle}>{profile.badge}</span>
        </span>
        <span style={actionButtonMeta}>{profile.description}</span>
      </button>
      {error && <span style={actionErrorStyle}>{error}</span>}
    </div>
  );
}

function surfaceActionProfile(action: AgentlasSurfaceAction, ko: boolean): {
  badge: string;
  description: string;
  badgeStyle: CSSProperties;
  style: CSSProperties;
} {
  const type = String(action.type || "");
  const permission = action.permission || "write";
  if (permission === "full") {
    return {
      badge: ko ? "전체 권한" : "Full",
      description: ko ? "파일/도구/외부 작업을 크게 바꿀 수 있어 승인 후 실행됩니다." : "Can change files/tools/external work; approval is required.",
      badgeStyle: actionBadgeDanger,
      style: actionButtonDanger,
    };
  }
  if (type === "request-payment-approval") {
    return {
      badge: ko ? "결제" : "Payment",
      description: ko ? "상점/결제 단계입니다. 금액과 다음 행동을 확인하세요." : "Payment step. Check amount and next action.",
      badgeStyle: actionBadgeWarn,
      style: actionButtonWarn,
    };
  }
  if (type === "request-credential") {
    return {
      badge: ko ? "키/계정" : "Credential",
      description: ko ? "키나 계정 연결이 필요한 작업입니다." : "Needs a key or account connection.",
      badgeStyle: actionBadgeWarn,
      style: actionButtonWarn,
    };
  }
  if (type === "delegate-browser" || type === "connect-service") {
    return {
      badge: ko ? "브라우저" : "Browser",
      description: ko ? "외부 서비스나 브라우저 세션을 열 수 있습니다." : "May open an external service or browser session.",
      badgeStyle: actionBadgeWarn,
      style: actionButtonWarn,
    };
  }
  if (type.includes("install") || type.includes("deploy") || type.includes("scaffold") || type.includes("materialize")) {
    return {
      badge: ko ? "로컬 변경" : "Local change",
      description: ko ? "파일 생성, 설치, 배포 같은 변경 작업입니다." : "Creates files, installs, or deploys local work.",
      badgeStyle: actionBadgeInfo,
      style: actionButtonInfo,
    };
  }
  if (permission === "read") {
    return {
      badge: ko ? "읽기" : "Read",
      description: ko ? "읽기 중심 작업입니다. 쓰기 권한은 요청하지 않습니다." : "Read-oriented action; no write permission requested.",
      badgeStyle: actionBadgeNeutral,
      style: {},
    };
  }
  return {
    badge: ko ? "쓰기" : "Write",
    description: ko ? "기본 쓰기 작업입니다. 실행 전 결과 위치를 확인하세요." : "Default write action. Check where the result will land.",
    badgeStyle: actionBadgeNeutral,
    style: {},
  };
}

function GovernancePanel({
  manifest,
  jobSummary,
}: {
  manifest: AgentlasSurfaceManifest;
  jobSummary?: SurfaceJobCostSummary;
}) {
  const evidence = manifest.evidence ?? [];
  const claims = manifest.claims ?? [];
  const capabilities = manifest.capabilities ?? [];
  const jobs = manifest.jobs ?? [];
  const budget = manifest.budget;
  const summary = jobSummary ?? summarizeManifestJobs(manifest);
  const verified = evidence.filter((item) => item.kind === "verified").length;
  const claimed =
    evidence.filter((item) => item.kind === "claimed").length +
    claims.filter((claim) => claim.kind === "claimed").length;
  const estimated = evidence.filter((item) => item.kind === "estimated").length;
  const unverified =
    evidence.filter((item) => item.kind === "unverified").length +
    claims.filter((claim) => claim.kind === "unverified" || claim.status === "unchecked").length;
  const spent = summary?.costSpent ?? (typeof budget?.spent === "number" ? budget.spent : 0);
  const estimate = summary?.costEstimate ?? 0;
  const limit = summary?.budgetLimit ?? (typeof budget?.limit === "number" ? budget.limit : undefined);
  const currency = summary?.currency ?? budget?.currency ?? jobs.find((job) => job.currency)?.currency ?? "USD";
  const activeJobs = summary ? summary.queuedCount + summary.runningCount + summary.pausedCount : 0;

  return (
    <div style={governanceBox}>
      <SectionTitle icon={<IconShield size={14} />} label="Trust & Control" />
      <div style={trustGrid}>
        <TrustTile label="Verified" value={String(verified)} tone="ok" />
        <TrustTile label="Claimed" value={String(claimed)} tone="claim" />
        <TrustTile label="Estimated" value={String(estimated)} tone="warn" />
        <TrustTile label="Unverified" value={String(unverified)} tone={unverified ? "risk" : "neutral"} />
      </div>
      <div style={miniStack}>
        <div style={governanceRow}>
          <span>Capabilities</span>
          <strong>{capabilities.length ? `${capabilities.length} declared` : "none declared"}</strong>
        </div>
        <div style={governanceRow}>
          <span>Budget</span>
          <strong>
            {limit !== undefined
              ? `${currency} ${spent}/${limit}${estimate ? ` · ${estimate} est` : ""}`
              : summary
                ? `${currency} ${spent} spent${estimate ? ` · ${estimate} est` : ""}`
                : "not declared"}
          </strong>
        </div>
        <div style={governanceRow}>
          <span>Jobs</span>
          <strong>
            {summary
              ? `${activeJobs} active · ${summary.resumableCount}/${summary.jobCount} resumable`
              : jobs.length
                ? `${jobs.filter((job) => job.resumable).length}/${jobs.length} resumable`
                : "none"}
          </strong>
        </div>
        <div style={governanceRow}>
          <span>Cost gate</span>
          <strong>
            {summary
              ? summary.overLimit
                ? "over limit"
                : summary.needsApproval
                  ? "approval needed"
                  : "clear"
              : "not declared"}
          </strong>
        </div>
        <div style={governanceRow}>
          <span>State ownership</span>
          <strong>{manifest.stateSchema?.fields?.length ? `${manifest.stateSchema.fields.length} fields` : "not declared"}</strong>
        </div>
      </div>
      {capabilities.length > 0 && (
        <div style={capabilityList}>
          {capabilities.slice(0, 4).map((capability) => (
            <span key={capability.id} style={capabilityPill} title={capability.purpose}>
              {capability.type}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DelegationPanel({
  surface,
  onAction,
}: {
  surface: WorkbenchSurface;
  onAction?: SurfaceActionHandler;
}) {
  const plan = useMemo(() => buildSurfaceDelegationPlan(surface.manifest), [surface.manifest]);
  const [draftSecrets, setDraftSecrets] = useState<Record<string, string>>({});
  const [saveStatus, setSaveStatus] = useState<Record<string, string>>({});
  const [approvedPayments, setApprovedPayments] = useState<Record<string, string>>({});
  const [activeCredentialId, setActiveCredentialId] = useState<string | null>(null);
  const actionsById = new Map((surface.manifest.actions ?? []).map((action) => [action.id, action]));
  const visibleSteps = plan.steps.slice(0, 5);
  const activeCredential = plan.credentialRequests.find((request) => request.id === activeCredentialId) ?? null;
  const hasPanel =
    visibleSteps.length > 0 ||
    plan.credentialRequests.length > 0 ||
    plan.paymentRequests.length > 0 ||
    plan.issues.length > 0;
  if (!hasPanel) return null;

  const triggerStepAction = (actionIds: string[]) => {
    const action = actionIds.map((id) => actionsById.get(id)).find(Boolean);
    if (action) onAction?.(surface, action);
  };

  const saveCredential = async (request: AgentlasSurfaceCredentialRequest) => {
    const value = draftSecrets[request.id]?.trim();
    if (!value) {
      setSaveStatus((prev) => ({ ...prev, [request.id]: "Enter value in secure field" }));
      return;
    }
    if (typeof window === "undefined" || !window.agentlas?.env) {
      setSaveStatus((prev) => ({ ...prev, [request.id]: "Vault unavailable in preview" }));
      return;
    }
    setSaveStatus((prev) => ({ ...prev, [request.id]: "Saving..." }));
    try {
      await window.agentlas.env.set(request.envKey, value);
      setDraftSecrets((prev) => ({ ...prev, [request.id]: "" }));
      setSaveStatus((prev) => ({ ...prev, [request.id]: "Saved to vault" }));
      setActiveCredentialId(null);
    } catch (err) {
      setSaveStatus((prev) => ({ ...prev, [request.id]: err instanceof Error ? err.message : String(err) }));
    }
  };

  const approvePayment = async (request: AgentlasSurfacePaymentRequest) => {
    const summary = paymentSummary(request);
    const ok = window.confirm(`Approve payment step?\n\n${summary}\n\nCard details stay in provider checkout or secure UI.`);
    if (!ok) return;
    const action = (surface.manifest.actions ?? []).find((item) => item.type === "request-payment-approval");
    if (typeof window !== "undefined" && window.agentlas?.surfaces && !isPreviewSurfaceId(surface.id)) {
      try {
        await window.agentlas.surfaces.approve({
          surfaceId: surface.id,
          actionId: action?.id ?? request.id,
          actionType: action?.type ?? "request-payment-approval",
          kind: "payment",
          scopeKey: paymentApprovalScopeKey(surface, request, action),
          title: `Approve payment for ${request.merchant}`,
          summary,
          metadata: {
            payment: {
              merchant: request.merchant,
              quoteRequired: request.quoteRequired === true,
              amount: typeof request.amount === "number" ? request.amount : null,
              currency: request.currency ?? null,
              recurrence: request.recurrence,
              approvalMode: request.approvalMode,
              cardHandling: request.cardHandling,
            },
          },
        });
      } catch (err) {
        setApprovedPayments((prev) => ({
          ...prev,
          [request.id]: `error:${err instanceof Error ? err.message : String(err)}`,
        }));
        return;
      }
    }
    setApprovedPayments((prev) => ({ ...prev, [request.id]: new Date().toISOString() }));
    if (action) onAction?.(surface, action);
  };

  return (
    <div style={delegationBox}>
      <SectionTitle icon={<IconLock size={14} />} label="OS Delegation" />
      <div style={delegationStep}>
        <div style={delegationStepTop}>
          <strong>{plan.autonomy.mode === "agent-first" ? "Agent-first operator" : "Supervised operator"}</strong>
          <span style={delegationStatus(plan.autonomy.mode === "agent-first" ? "ready" : "needs-approval")}>
            {plan.autonomy.mode}
          </span>
        </div>
        <span style={delegationDetail}>
          Handles {plan.autonomy.allowedWithoutPrompt.slice(0, 3).join(", ")}; pauses for{" "}
          {plan.autonomy.checkpoints.slice(0, 3).join(", ")}.
        </span>
      </div>
      <div style={miniStack}>
        {visibleSteps.map((step) => (
          <div key={step.id} style={delegationStep}>
            <div style={delegationStepTop}>
              <strong>{step.label}</strong>
              <span style={delegationStatus(step.status)}>{step.status}</span>
            </div>
            <span style={delegationDetail}>{step.details[0]}</span>
            {step.actionIds.length > 0 && (
              <button type="button" style={compactActionButton} onClick={() => triggerStepAction(step.actionIds)}>
                Run step
              </button>
            )}
          </div>
        ))}
        {plan.issues.slice(0, 3).map((issue) => (
          <div key={issue} style={delegationIssue}>
            {issue}
          </div>
        ))}
      </div>

      {plan.credentialRequests.length > 0 && (
        <>
          <SectionTitle icon={<IconKey size={14} />} label="Vault Requests" />
          <div style={miniStack}>
            {plan.credentialRequests.slice(0, 3).map((request) => (
              <div key={request.id} style={credentialBox}>
                <div style={delegationStepTop}>
                  <strong>{request.label}</strong>
                  <span style={credentialModePill(request.brokerMode)}>{request.brokerMode || "runtime-env-injection"}</span>
                </div>
                <div style={credentialMetaGrid}>
                  <span>Key</span>
                  <strong>{request.envKey}</strong>
                  <span>Provider</span>
                  <strong>{request.provider || "declared by agent"}</strong>
                  <span>Allowed host</span>
                  <strong>{credentialHostText(request)}</strong>
                  <span>Scope</span>
                  <strong>{request.scope || request.purpose || "not declared"}</strong>
                </div>
                <span style={delegationDetail}>{credentialBrokerText(request)}</span>
                <button type="button" style={compactActionButton} onClick={() => setActiveCredentialId(request.id)}>
                  Open secure input
                </button>
                {saveStatus[request.id] && <span style={delegationDetail}>{saveStatus[request.id]}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {activeCredential && (
        <div style={secureCredentialOverlay} role="dialog" aria-modal="true" aria-label="Secure credential input">
          <div style={secureCredentialDialog}>
            <div style={secureCredentialHeader}>
              <span style={secureCredentialMark}>
                <IconShield size={15} />
              </span>
              <div style={{ minWidth: 0 }}>
                <strong>Secure credential save</strong>
                <span>Agentlas vault · {activeCredential.envKey}</span>
              </div>
              <button
                type="button"
                style={iconButton}
                aria-label="Close credential dialog"
                onClick={() => setActiveCredentialId(null)}
              >
                <IconClose size={15} />
              </button>
            </div>
            <div style={secureCredentialFacts}>
              <div>
                <span>Requested by</span>
                <strong>{activeCredential.provider || activeCredential.label}</strong>
              </div>
              <div>
                <span>Allowed host</span>
                <strong>{credentialHostText(activeCredential)}</strong>
              </div>
              <div>
                <span>Use</span>
                <strong>{activeCredential.scope || activeCredential.purpose || activeCredential.requiredWhen || "not declared"}</strong>
              </div>
              <div>
                <span>Storage</span>
                <strong>{credentialStorageText(activeCredential)}</strong>
              </div>
            </div>
            <div style={secureCredentialNotice(activeCredential.brokerMode)}>
              {credentialBrokerText(activeCredential)}
            </div>
            <div style={credentialInputRow}>
              <input
                type="password"
                autoComplete="off"
                autoFocus
                value={draftSecrets[activeCredential.id] ?? ""}
                placeholder="Paste secret into Agentlas vault"
                style={credentialInput}
                onChange={(event) =>
                  setDraftSecrets((prev) => ({ ...prev, [activeCredential.id]: event.currentTarget.value }))
                }
              />
              <button type="button" style={compactActionButton} onClick={() => void saveCredential(activeCredential)}>
                Save
              </button>
            </div>
            {activeCredential.setupUrl && (
              <button
                type="button"
                style={linkLikeButton}
                onClick={() => window.open(activeCredential.setupUrl, "_blank", "noopener,noreferrer")}
              >
                Open provider setup page
              </button>
            )}
            {saveStatus[activeCredential.id] && <span style={delegationDetail}>{saveStatus[activeCredential.id]}</span>}
          </div>
        </div>
      )}

      {plan.paymentRequests.length > 0 && (
        <>
          <SectionTitle icon={<IconCircleDollar size={14} />} label="Payment Gates" />
          <div style={miniStack}>
            {plan.paymentRequests.slice(0, 3).map((request) => (
              <div key={request.id} style={credentialBox}>
                <div style={delegationStepTop}>
                  <strong>{request.merchant}</strong>
                  <span>{paymentApprovalLabel(approvedPayments[request.id])}</span>
                </div>
                <span style={delegationDetail}>{paymentSummary(request)}</span>
                <button type="button" style={compactActionButton} onClick={() => void approvePayment(request)}>
                  Approve checkout
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function paymentApprovalScopeKey(
  surface: WorkbenchSurface,
  request: AgentlasSurfacePaymentRequest,
  action?: AgentlasSurfaceAction,
): string {
  const amount = request.quoteRequired === true ? "quote" : `${request.currency ?? "currency"}-${request.amount ?? "amount"}`;
  return [
    "surface-payment",
    surface.id,
    action?.id ?? request.id,
    request.merchant,
    amount,
    request.recurrence,
    request.approvalMode,
  ].join(":");
}

function paymentApprovalLabel(value: string | undefined): string {
  if (!value) return "approval required";
  if (value.startsWith("error:")) return value;
  return "approved";
}

function isPreviewSurfaceId(surfaceId: string): boolean {
  return surfaceId === "preview" || surfaceId.startsWith("surface-preview") || surfaceId.startsWith("preview-");
}

function paymentSummary(request: AgentlasSurfacePaymentRequest): string {
  const amount =
    request.quoteRequired === true
      ? "quoted at checkout"
      : `${request.currency ?? "?"} ${request.amount ?? "?"}`;
  return `${amount} · ${request.recurrence} · ${request.approvalMode}`;
}

function credentialHostText(request: AgentlasSurfaceCredentialRequest): string {
  return request.allowedHosts?.length ? request.allowedHosts.join(", ") : "not declared";
}

function credentialStorageText(request: AgentlasSurfaceCredentialRequest): string {
  if (request.inputMode === "oauth-browser") return "provider OAuth flow";
  if (request.inputMode === "provider-page") return "provider page";
  return request.saveTarget === "agentlas-env-vault" || !request.saveTarget
    ? "Agentlas OS keychain vault"
    : request.saveTarget;
}

function credentialBrokerText(request: AgentlasSurfaceCredentialRequest): string {
  if (request.brokerMode === "host-bound-broker") {
    return "Host-bound broker mode: Agentlas should attach the credential only to the declared upstream host and return the API result, not the raw secret.";
  }
  if (request.inputMode === "oauth-browser" || request.brokerMode === "provider-managed-oauth") {
    return "OAuth/provider mode: the user signs in at the provider, and Agentlas stores only the returned local token reference when available.";
  }
  if (request.inputMode === "provider-page" || request.brokerMode === "manual-provider-page") {
    return "Provider-page mode: enter the secret only in the provider page or Agentlas secure UI, not in chat or generated source.";
  }
  return "Current runtime mode: Agentlas stores the value in the OS keychain, but legacy MCP/runner paths may still inject it into a child process environment.";
}

function summarizeManifestJobs(manifest: AgentlasSurfaceManifest): SurfaceJobCostSummary | null {
  const jobs = manifest.jobs ?? [];
  if (jobs.length === 0) return null;
  const budget = manifest.budget;
  const costEstimate = round2(
    jobs.reduce((sum, job) => sum + (typeof job.costEstimate === "number" ? job.costEstimate : 0), 0),
  );
  const costSpent = round2(
    jobs.reduce((sum, job) => sum + (typeof job.costSpent === "number" ? job.costSpent : 0), 0),
  );
  const budgetLimit = typeof budget?.limit === "number" ? budget.limit : undefined;
  const approvalThreshold = typeof budget?.approvalThreshold === "number" ? budget.approvalThreshold : undefined;
  const projected = costSpent + costEstimate;
  return {
    currency:
      (typeof budget?.currency === "string" && budget.currency.trim()
        ? budget.currency.trim().toUpperCase()
        : undefined) ??
      (jobs.find((job) => typeof job.currency === "string" && job.currency.trim())?.currency ?? "USD").toUpperCase(),
    jobCount: jobs.length,
    queuedCount: jobs.filter((job) => job.status === "queued").length,
    runningCount: jobs.filter((job) => job.status === "running").length,
    pausedCount: jobs.filter((job) => job.status === "paused").length,
    succeededCount: jobs.filter((job) => job.status === "succeeded").length,
    failedCount: jobs.filter((job) => job.status === "failed" || job.status === "cancelled").length,
    resumableCount: jobs.filter((job) => job.resumable).length,
    costEstimate,
    costSpent,
    ...(budgetLimit !== undefined ? { budgetLimit } : {}),
    ...(approvalThreshold !== undefined ? { approvalThreshold } : {}),
    overLimit: budgetLimit !== undefined ? projected > budgetLimit : false,
    needsApproval: approvalThreshold !== undefined ? projected >= approvalThreshold : false,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function TrustTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "claim" | "warn" | "risk" | "neutral";
}) {
  return (
    <div style={{ ...trustTile, ...trustTone(tone) }}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function EvidencePill({ kind }: { kind: string }) {
  return <span style={{ ...evidencePill, ...evidenceTone(kind) }}>{evidenceLabel(kind)}</span>;
}

function CodeWorkbench({ artifact }: { artifact: CodeArtifact }) {
  const { locale } = useT();
  return (
    <CodeIdeViewer
      path={artifact.path}
      name={artifact.path || artifact.language || "code"}
      locale={locale}
      initialContent={artifact.code}
      fill
    />
  );
}

function SectionTitle({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div style={sectionTitle}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function ShotCard({
  index,
  row,
  editable,
  onStatusChange,
}: {
  index: number;
  row: JsonObject;
  editable?: boolean;
  onStatusChange?: (status: "approved" | "rejected") => void;
}) {
  const scene = stringField(row, "scene") || stringField(row, "title") || `Shot ${index}`;
  const duration = stringField(row, "duration") || stringField(row, "time") || "";
  const prompt = stringField(row, "prompt") || stringField(row, "description") || "No prompt yet.";
  const status = stringField(row, "status") || "planned";
  return (
    <article style={shotCard}>
      <div style={shotPreview}>
        <IconFilm size={18} />
        <span>{index}</span>
      </div>
      <div style={shotMeta}>
        <div style={shotTitle}>
          <span>{scene}</span>
          {duration && <small>{duration}</small>}
        </div>
        <p style={shotPrompt}>{prompt}</p>
        <div style={shotStatusRow}>
          <span style={statusPill}>{status}</span>
          {editable && (
            <span style={shotDecisionGroup}>
              <button
                type="button"
                style={shotDecisionButton}
                title="Approve this user-owned shot state"
                onClick={() => onStatusChange?.("approved")}
              >
                Approve
              </button>
              <button
                type="button"
                style={shotDecisionButton}
                title="Reject this user-owned shot state"
                onClick={() => onStatusChange?.("rejected")}
              >
                Reject
              </button>
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function AssetTile({
  row,
  index,
  manifest,
}: {
  row: JsonObject;
  index: number;
  manifest: AgentlasSurfaceManifest;
}) {
  const title = stringField(row, "title") || stringField(row, "scene") || `Variant ${index}`;
  const status = stringField(row, "status") || "queued";
  const source = assetMediaSource(row);
  const sourceText = source ?? "";
  const isRemote = /^https?:\/\//i.test(sourceText);
  const canRenderRemote = isRemote ? manifestAllowsRemoteMedia(manifest, sourceText) : true;
  const mediaType = stringField(row, "mediaType") || stringField(row, "mimeType") || stringField(row, "mime") || "";
  const isVideo = Boolean(source && isVideoSource(sourceText, mediaType));
  const evidenceKind = evidenceKindForRow(row, manifest);
  const sourceLabel = isRemote ? hostLabel(sourceText) : sourceText.startsWith("data:") ? "embedded" : source ? "local" : "none";
  return (
    <article style={assetTile}>
      {source && canRenderRemote && isVideo ? (
        <video src={source} muted playsInline controls preload="metadata" style={assetImage} />
      ) : source && canRenderRemote ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={source} alt={title} style={assetImage} />
      ) : (
        <div style={assetPlaceholder}>
          <IconImage size={19} />
          {source && !canRenderRemote && <span>remote gated</span>}
        </div>
      )}
      <div style={assetInfo}>
        <strong title={title}>{title}</strong>
        <div style={assetMetaRow}>
          <span>{status}</span>
          <span>{sourceLabel}</span>
        </div>
        <EvidencePill kind={evidenceKind} />
      </div>
    </article>
  );
}

function SimpleTable({ rows }: { rows: JsonObject[] }) {
  if (rows.length === 0) return <div style={emptyState}>No table rows yet.</div>;
  const cols = Object.keys(rows[0] ?? {}).slice(0, 5);
  return (
    <div style={tableWrap}>
      <table style={table}>
        <thead>
          <tr>
            {cols.map((col) => (
              <th key={col} style={th}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map((row, i) => (
            <tr key={i}>
              {cols.map((col) => (
                <td key={col} style={td}>
                  {stringifyValue(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyValueList({ value, fallback }: { value?: JsonValue; fallback: string }) {
  if (!isObject(value)) return <div style={mutedSmall}>{fallback}</div>;
  return (
    <dl style={kvList}>
      {Object.entries(value).slice(0, 8).map(([key, val]) => (
        <div key={key} style={kvRow}>
          <dt>{key}</dt>
          <dd>{stringifyValue(val)}</dd>
        </div>
      ))}
    </dl>
  );
}

function dataByName(manifest: AgentlasSurfaceManifest, name: string): AgentlasSurfaceDataSet | undefined {
  return manifest.data[name];
}

function firstData(manifest: AgentlasSurfaceManifest, type: string): AgentlasSurfaceDataSet | undefined {
  return Object.values(manifest.data).find((data) => data.type === type);
}

function rowsOf(data?: AgentlasSurfaceDataSet): JsonObject[] {
  if (!data) return [];
  if (Array.isArray(data.rows)) return data.rows;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

export function surfaceMapBlock(manifest: AgentlasSurfaceManifest): OneSurfaceMapBlock | null {
  const widget = manifest.widgets.find((candidate) => String(candidate.type).toLowerCase() === "map");
  if (!widget) return null;
  const dataset = (widget.data ? dataByName(manifest, widget.data) : undefined) ?? firstData(manifest, "routes");
  const locations = rowsOf(dataset).flatMap((row, index) => {
    const latitude = numericField(row, "latitude", "lat");
    const longitude = numericField(row, "longitude", "lng", "lon");
    if (latitude == null || longitude == null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];
    const declaredSequence = numericField(row, "sequence", "order");
    return [{
      locationRef: stringField(row, "locationRef") || stringField(row, "id") || `location-${index + 1}`,
      label: stringField(row, "label") || stringField(row, "name") || `Location ${index + 1}`,
      latitude,
      longitude,
      sequence: declaredSequence != null && Number.isSafeInteger(declaredSequence) && declaredSequence > 0
        ? declaredSequence
        : index + 1,
    }];
  });
  if (locations.length === 0) return null;
  return {
    blockId: "work-live-map",
    type: "Map",
    title: widget.title || dataset?.summary || manifest.title,
    locations,
  };
}

/**
 * Resolve the portable Flint payload from a declarative Surface. Keeping this
 * adapter here means the manifest remains JSON-only and older surfaces still
 * render their table fallback when no valid chart payload is present.
 */
export function surfaceChartInput(
  manifest: AgentlasSurfaceManifest,
  widget: AgentlasSurfaceManifest["widgets"][number],
): FlintChartRenderInput | null {
  if (String(widget.type).toLowerCase() !== "chart") return null;
  const dataset = (widget.data ? dataByName(manifest, widget.data) : undefined) ?? firstData(manifest, "table");
  if (!dataset) return null;
  const flint = isObject(widget.flint)
    ? widget.flint
    : isObject(dataset.flint)
      ? dataset.flint
      : null;
  if (!flint) return null;
  const rawSpec = isObject(flint.chart_spec)
    ? flint.chart_spec
    : isObject(flint.chartSpec)
      ? flint.chartSpec
      : null;
  if (!rawSpec) return null;
  const chartType = typeof rawSpec.chartType === "string"
    ? rawSpec.chartType
    : typeof rawSpec.chart_type === "string"
      ? rawSpec.chart_type
      : "";
  const rawEncodings = isObject(rawSpec.encodings) ? rawSpec.encodings : null;
  if (!chartType || !rawEncodings) return null;
  const encodings = Object.fromEntries(
    Object.entries(rawEncodings).flatMap(([channel, value]) => (
      typeof value === "string" || isObject(value) ? [[channel, value] as const] : []
    )),
  );
  if (Object.keys(encodings).length === 0) return null;
  const input: FlintChartRenderInput = {
    data: {
      values: rowsOf(dataset),
    },
    chart_spec: {
      chartType,
      encodings,
      ...(typeof rawSpec.title === "string" ? { title: rawSpec.title } : {}),
      ...(typeof rawSpec.subtitle === "string" ? { subtitle: rawSpec.subtitle } : {}),
      ...(isObject(rawSpec.baseSize) ? { baseSize: rawSpec.baseSize as { width: number; height: number } } : {}),
      ...(isObject(rawSpec.canvasSize) ? { canvasSize: rawSpec.canvasSize as { width: number; height: number } } : {}),
      ...(isObject(rawSpec.chartProperties) ? { chartProperties: rawSpec.chartProperties } : {}),
    },
    ...(isObject(flint.semantic_types)
      ? { semantic_types: flint.semantic_types as AgentlasSurfaceFlintInput["semantic_types"] }
      : isObject(flint.semanticTypes)
        ? { semantic_types: flint.semanticTypes as AgentlasSurfaceFlintInput["semantic_types"] }
        : {}),
    ...(typeof flint.theme_spec === "string" || isObject(flint.theme_spec) ? { theme_spec: flint.theme_spec as AgentlasSurfaceFlintInput["theme_spec"] } : {}),
    ...(isObject(flint.options) ? { options: flint.options } : {}),
    ...(isObject(flint.field_display_names) ? { field_display_names: flint.field_display_names as Record<string, string> } : {}),
  };
  return input;
}

function numericField(row: JsonObject, ...keys: string[]): number | null {
  for (const key of keys) {
    const raw = row[key];
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function rowsWithSurfaceState(surface: WorkbenchSurface, dataName: string, rows: JsonObject[]): JsonObject[] {
  const overlayRows = objectAt(surface.state, ["data", dataName, "rows"]);
  if (!Array.isArray(overlayRows)) return rows;
  return rows.map((row, idx) => {
    const overlay = overlayRows[idx];
    return isObject(overlay) ? { ...row, ...overlay } : row;
  });
}

function isUserOwnedRows(surface: WorkbenchSurface, dataName: string): boolean {
  const path = `/data/${dataName}/rows`;
  return Boolean(
    surface.manifest.stateSchema?.fields?.some(
      (field) =>
        field.owner === "user" &&
        (field.path === path || field.path.startsWith(`${path}/`)) &&
        (field.merge === undefined || field.merge === "preserve-user" || field.merge === "replace"),
    ),
  );
}

function objectAt(root: JsonObject | undefined, path: string[]): JsonValue | undefined {
  let cursor: JsonValue | undefined = root;
  for (const segment of path) {
    if (!isObject(cursor)) return undefined;
    cursor = cursor[segment] as JsonValue | undefined;
  }
  return cursor;
}

function objectValue(data?: AgentlasSurfaceDataSet): JsonObject | undefined {
  return isObject(data?.value) ? data.value : undefined;
}

function stringField(row: JsonObject, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function evidenceKindForRow(row: JsonObject, manifest: AgentlasSurfaceManifest): string {
  const explicit = stringField(row, "kind") || stringField(row, "evidenceKind") || stringField(row, "trust");
  if (explicit) return explicit;
  const evidenceId = stringField(row, "evidenceId") || stringField(row, "sourceId");
  if (evidenceId) {
    return manifest.evidence?.find((item) => item.id === evidenceId)?.kind || "unverified";
  }
  const evidenceIds = row.evidenceIds;
  if (Array.isArray(evidenceIds)) {
    const kinds = evidenceIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => manifest.evidence?.find((item) => item.id === id)?.kind)
      .filter((kind): kind is string => Boolean(kind));
    if (kinds.includes("verified")) return "verified";
    if (kinds[0]) return kinds[0];
  }
  if (stringField(row, "source") || stringField(row, "url")) return "claimed";
  return "unverified";
}

function assetMediaSource(row: JsonObject): string | undefined {
  return (
    stringField(row, "dataUrl") ||
    stringField(row, "src") ||
    stringField(row, "previewUrl") ||
    stringField(row, "thumbnail") ||
    stringField(row, "imageUrl") ||
    stringField(row, "videoUrl") ||
    stringField(row, "fileUrl") ||
    stringField(row, "url")
  );
}

function isVideoSource(source: string, mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("video/") || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(source);
}

function manifestAllowsRemoteMedia(manifest: AgentlasSurfaceManifest, source: string): boolean {
  return Boolean(
    manifest.capabilities?.some((capability) => {
      if (capability.type !== "network" && capability.type !== "external-api") return false;
      return (capability.allowlist ?? []).some((entry) => remoteAllowlistMatches(entry, source));
    }),
  );
}

function remoteAllowlistMatches(entry: string, source: string): boolean {
  try {
    const sourceUrl = new URL(source);
    const entryUrl = new URL(entry);
    if (sourceUrl.origin === entryUrl.origin) return true;
    return source.startsWith(entry.endsWith("/") ? entry : `${entry}/`);
  } catch {
    return false;
  }
}

function hostLabel(source: string): string {
  try {
    return new URL(source).hostname.replace(/^www\./, "");
  } catch {
    return "remote";
  }
}

function evidenceLabel(kind: string): string {
  if (kind === "verified") return "verified";
  if (kind === "estimated") return "estimate";
  if (kind === "claimed") return "claim";
  if (kind === "unverified") return "unverified";
  return kind;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringifyValue).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return "";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const shell: CSSProperties = {
  width: "min(900px, 62vw)",
  minWidth: 520,
  flexShrink: 0,
  height: "100%",
  background: "var(--paper)",
  borderLeft: "1px solid var(--paper-edge)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  animation: "workbench-in 0.18s ease",
};

const embeddedShell: CSSProperties = {
  ...shell,
  width: "100%",
  minWidth: 0,
  maxWidth: "none",
  flex: 1,
  flexShrink: 1,
  borderLeft: "none",
  animation: "none",
};

const liveShell: CSSProperties = {
  ...shell,
  minWidth: 0,
  background: "var(--design-bg, var(--paper))",
};

const liveEmbeddedShell: CSSProperties = {
  ...embeddedShell,
  minHeight: 0,
  padding: 0,
  background: "var(--design-bg, var(--paper))",
};

const header: CSSProperties = {
  padding: "10px 14px",
  display: "flex",
  alignItems: "center",
  gap: 10,
  background: "var(--paper)",
  borderBottom: "1px solid var(--paper-edge)",
  minHeight: 56,
};

const mark: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  background: "var(--fill-1)",
  color: "var(--accent)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const eyebrow: CSSProperties = {
  fontSize: 10,
  color: "var(--muted-deep)",
  fontWeight: 700,
  textTransform: "uppercase",
};

const titleStyle: CSSProperties = {
  fontFamily: "var(--font-head)",
  fontSize: 14,
  fontWeight: 700,
  color: "var(--ink)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const chip: CSSProperties = {
  fontSize: 11,
  padding: "4px 8px",
  borderRadius: 8,
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
  border: "1px solid var(--paper-edge)",
  maxWidth: 180,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ghostButton: CSSProperties = {
  fontSize: 11,
  padding: "5px 10px",
  borderRadius: 8,
  background: "var(--paper-2)",
  color: "var(--ink-soft)",
  border: "1px solid var(--paper-edge)",
  fontWeight: 700,
};

const iconButton: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  background: "transparent",
  color: "var(--muted-deep)",
  border: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const exportBar: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 7,
  padding: "8px 14px",
  borderBottom: "1px solid var(--paper-edge)",
  background: "var(--paper)",
};

const exportLabel: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  fontWeight: 800,
  color: "var(--muted-deep)",
  marginRight: 2,
};

const exportLockFree: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 800,
  color: "var(--green-deep)",
  background: "rgba(80,150,110,0.12)",
  border: "1px solid rgba(80,150,110,0.24)",
  borderRadius: 999,
  padding: "1px 6px",
};

const exportButton: CSSProperties = {
  minHeight: 26,
  borderRadius: 8,
  border: "1px solid var(--accent-soft)",
  background: "var(--fill-1)",
  color: "var(--ink)",
  fontSize: 11,
  fontWeight: 800,
  padding: "3px 9px",
  cursor: "pointer",
};


// ArtifactFileBridge — 디스크 경로 칩. 좁은 폭에서 줄여 넘침 방지.
const exportFileBridge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  minWidth: 0,
  maxWidth: "100%",
  marginLeft: "auto",
  color: "var(--muted-deep)",
  fontSize: 10.5,
  fontWeight: 700,
};

const exportFilePath: CSSProperties = {
  minWidth: 0,
  maxWidth: 260,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--ink-soft)",
};

const surfaceBody: CSSProperties = {
  flex: 1,
  overflow: "auto",
  background: "var(--paper-2)",
};

const liveAppCanvas: CSSProperties = {
  width: "100%",
  height: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  background: "var(--design-bg, var(--paper))",
};

const creativeGrid: CSSProperties = {
  minHeight: "100%",
  display: "grid",
  gridTemplateColumns: "210px minmax(280px, 1fr) 220px",
  gap: 1,
  background: "var(--paper-edge)",
};

const appFactoryGrid: CSSProperties = {
  minHeight: "100%",
  display: "grid",
  gridTemplateColumns: "220px minmax(320px, 1fr) 240px",
  gap: 1,
  background: "var(--paper-edge)",
};

const leftRail: CSSProperties = {
  background: "var(--paper)",
  padding: 14,
  overflow: "auto",
};

const centerRail: CSSProperties = {
  background: "var(--paper-2)",
  padding: 14,
  minWidth: 0,
  overflow: "auto",
};

const rightRail: CSSProperties = {
  background: "var(--paper)",
  padding: 14,
  overflow: "auto",
};

const appThesis: CSSProperties = {
  padding: 12,
  borderRadius: 8,
  background: "var(--fill-1)",
  border: "1px solid var(--accent-soft)",
  display: "grid",
  gap: 5,
  marginBottom: 12,
  fontSize: 12,
};

const businessRow: CSSProperties = {
  padding: 10,
  borderRadius: 8,
  background: "var(--paper-2)",
  border: "1px solid var(--paper-edge)",
  display: "grid",
  gap: 3,
  fontSize: 11,
  color: "var(--muted-deep)",
};

const sectionTitle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 800,
  margin: "14px 0 8px",
};

const miniStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

const mutedSmall: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: "var(--muted-deep)",
};

const routerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
  fontSize: 12,
  color: "var(--ink-soft)",
};

const dot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  background: "var(--accent)",
  flexShrink: 0,
};

const truncate: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const heroBand: CSSProperties = {
  minHeight: 116,
  display: "flex",
  justifyContent: "space-between",
  gap: 14,
  padding: 16,
  borderRadius: 8,
  background: "var(--black)",
  color: "white",
  overflow: "hidden",
};

const appHeroBand: CSSProperties = {
  ...heroBand,
  background:
    "linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, var(--black)) 0%, var(--black) 58%, var(--black-soft) 100%)",
};

const appHeroCopy: CSSProperties = {
  margin: "5px 0 0",
  fontSize: 12,
  color: "var(--white-soft)",
  lineHeight: 1.45,
  maxWidth: 480,
};

const genericHero: CSSProperties = {
  margin: 14,
  minHeight: 112,
  padding: 16,
  borderRadius: 8,
  background: "var(--black)",
  color: "white",
};

const genericMapSection: CSSProperties = {
  minWidth: 0,
  margin: "0 14px 14px",
  padding: 12,
  border: "1px solid var(--paper-edge)",
  borderRadius: 12,
  background: "var(--paper)",
};

const eyebrowDark: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  color: "var(--white-soft)",
  textTransform: "uppercase",
};

const surfaceTitle: CSSProperties = {
  margin: "8px 0 0",
  fontFamily: "var(--font-head)",
  fontSize: 22,
  lineHeight: 1.18,
  fontWeight: 800,
};

const formatPills: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "flex-end",
  flexWrap: "wrap",
  gap: 6,
  maxWidth: 210,
};

const darkPill: CSSProperties = {
  fontSize: 11,
  padding: "5px 8px",
  borderRadius: 8,
  background: "rgba(255,255,255,0.10)",
  color: "var(--white)",
  border: "1px solid rgba(255,255,255,0.12)",
};

const timelineSection: CSSProperties = {
  marginTop: 14,
};

const appPreviewShell: CSSProperties = {
  marginTop: 12,
  borderRadius: 8,
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  overflow: "hidden",
};

const appRuntimeUnavailable: CSSProperties = {
  marginTop: 12,
  minHeight: 150,
  padding: 20,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  borderRadius: 10,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
};

const appRuntimeStatusDot: CSSProperties = {
  width: 9,
  height: 9,
  flex: "0 0 auto",
  borderRadius: 999,
  background: "var(--warn)",
  boxShadow: "0 0 0 4px rgba(245,158,11,.12)",
};

const appPreviewTopbar: CSSProperties = {
  minHeight: 46,
  padding: "0 12px",
  display: "flex",
  alignItems: "center",
  gap: 10,
  borderBottom: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  minWidth: 0,
};

const appLogoMark: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--ink)",
  color: "var(--paper)",
  fontSize: 12,
  fontWeight: 900,
  flexShrink: 0,
};

const appPreviewNav: CSSProperties = {
  marginLeft: "auto",
  display: "flex",
  gap: 8,
  alignItems: "center",
  color: "var(--muted-deep)",
  fontSize: 11,
  minWidth: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
};

const appPreviewBody: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(160px, 34%)",
  gap: 1,
  background: "var(--paper-edge)",
};

const appPreviewMain: CSSProperties = {
  padding: 14,
  minWidth: 0,
  background: "var(--paper-2)",
};

const appPreviewSide: CSSProperties = {
  padding: 12,
  minWidth: 0,
  background: "var(--paper)",
};

const appPreviewHeadline: CSSProperties = {
  display: "grid",
  gap: 4,
  marginBottom: 12,
  fontSize: 12,
  color: "var(--muted-deep)",
};

const metricGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 8,
};

const emptyGridNote: CSSProperties = {
  ...mutedSmall,
  gridColumn: "1 / -1",
  padding: "10px 0",
};

const metricCard: CSSProperties = {
  minHeight: 74,
  padding: 10,
  borderRadius: 8,
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  display: "grid",
  alignContent: "space-between",
  minWidth: 0,
  fontSize: 11,
  color: "var(--muted-deep)",
};

const connectorRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "38px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  padding: "8px 0",
  borderBottom: "1px solid var(--paper-edge)",
  fontSize: 11,
  color: "var(--muted-deep)",
};

const connectorIcon: CSSProperties = {
  width: 34,
  height: 24,
  borderRadius: 6,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--fill-1)",
  color: "var(--accent)",
  fontSize: 9,
  fontFamily: "var(--font-mono)",
  fontWeight: 800,
};

const appLowerGrid: CSSProperties = {
  marginTop: 12,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
};

const routeRow: CSSProperties = {
  padding: 9,
  borderRadius: 8,
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  display: "grid",
  gap: 3,
  fontSize: 11,
  color: "var(--muted-deep)",
};

const artifactRow: CSSProperties = {
  padding: 9,
  borderRadius: 8,
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
  fontSize: 11,
  color: "var(--muted-deep)",
};

const artifactPathStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  color: "var(--muted-deep)",
};

const launchRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "16px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 7,
  padding: "7px 0",
  borderBottom: "1px solid var(--paper-edge)",
  color: "var(--ink-soft)",
  fontSize: 12,
};

const shotStrip: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: 10,
};

const shotCard: CSSProperties = {
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  overflow: "hidden",
  minHeight: 208,
  display: "flex",
  flexDirection: "column",
};

const shotPreview: CSSProperties = {
  height: 88,
  background: "linear-gradient(135deg, var(--info), var(--info))",
  color: "var(--white-soft)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  fontWeight: 800,
};

const shotMeta: CSSProperties = {
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 7,
  minHeight: 0,
};

const shotTitle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
  fontWeight: 800,
  color: "var(--ink)",
};

const shotPrompt: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.45,
  color: "var(--muted-deep)",
  display: "-webkit-box",
  WebkitLineClamp: 3,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const statusPill: CSSProperties = {
  alignSelf: "flex-start",
  fontSize: 10,
  fontWeight: 800,
  color: "var(--accent)",
  background: "var(--fill-1)",
  borderRadius: 8,
  padding: "3px 6px",
};

const shotStatusRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  flexWrap: "wrap",
};

const shotDecisionGroup: CSSProperties = {
  display: "inline-flex",
  gap: 4,
  flexWrap: "wrap",
};

const shotDecisionButton: CSSProperties = {
  height: 24,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink)",
  borderRadius: 6,
  padding: "0 7px",
  fontSize: 10,
  fontWeight: 800,
  cursor: "pointer",
};

const assetSection: CSSProperties = {
  marginTop: 16,
};

const assetGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 10,
};

const assetTile: CSSProperties = {
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  overflow: "hidden",
};

const assetPlaceholder: CSSProperties = {
  aspectRatio: "16 / 10",
  background: "var(--fill-1)",
  color: "var(--accent)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexDirection: "column",
  gap: 6,
  fontSize: 10,
  fontWeight: 800,
  textTransform: "uppercase",
};

const assetImage: CSSProperties = {
  width: "100%",
  aspectRatio: "16 / 10",
  display: "block",
  objectFit: "contain",
  background: "linear-gradient(135deg, var(--warn-soft), var(--warn-soft))",
};

const assetInfo: CSSProperties = {
  padding: 9,
  display: "grid",
  gap: 5,
  fontSize: 11,
  color: "var(--muted-deep)",
  minWidth: 0,
};

const assetMetaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
};

const actionStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const actionButton: CSSProperties = {
  width: "100%",
  minHeight: 50,
  borderRadius: 8,
  border: "1px solid var(--accent-soft)",
  background: "var(--fill-1)",
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 800,
  textAlign: "left",
  padding: "8px 9px",
  display: "grid",
  gap: 5,
};

const actionButtonTopLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
};

const actionButtonMeta: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 10.5,
  lineHeight: 1.3,
  fontWeight: 650,
};

const actionErrorStyle: CSSProperties = {
  color: "var(--red-deep)",
  fontSize: 10.5,
  lineHeight: 1.35,
  fontWeight: 700,
};

const actionButtonDanger: CSSProperties = {
  border: "1px solid rgba(180,83,58,0.38)",
  background: "rgba(180,83,58,0.08)",
};

const actionButtonWarn: CSSProperties = {
  border: "1px solid rgba(186,116,44,0.34)",
  background: "rgba(233,169,108,0.12)",
};

const actionButtonInfo: CSSProperties = {
  border: "1px solid rgba(45,117,184,0.28)",
  background: "rgba(96,139,224,0.10)",
};

const actionBadgeBase: CSSProperties = {
  flexShrink: 0,
  borderRadius: 999,
  padding: "2px 6px",
  fontSize: 9.5,
  lineHeight: 1.2,
  fontWeight: 900,
  maxWidth: 108,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const actionBadgeDanger: CSSProperties = {
  ...actionBadgeBase,
  color: "var(--danger, var(--danger))",
  background: "rgba(180,83,58,0.12)",
  border: "1px solid rgba(180,83,58,0.32)",
};

const actionBadgeWarn: CSSProperties = {
  ...actionBadgeBase,
  color: "var(--peach-ink)",
  background: "rgba(233,169,108,0.20)",
  border: "1px solid rgba(186,116,44,0.26)",
};

const actionBadgeInfo: CSSProperties = {
  ...actionBadgeBase,
  color: "var(--blue-deep)",
  background: "rgba(96,139,224,0.16)",
  border: "1px solid rgba(45,117,184,0.22)",
};

const actionBadgeNeutral: CSSProperties = {
  ...actionBadgeBase,
  color: "var(--muted-deep)",
  background: "var(--paper-2)",
  border: "1px solid var(--paper-edge)",
};

const provenanceRow: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  fontSize: 11,
  lineHeight: 1.35,
  color: "var(--muted-deep)",
  borderBottom: "1px solid var(--paper-edge)",
  paddingBottom: 7,
};

const kvList: CSSProperties = {
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 7,
};

const kvRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "72px minmax(0, 1fr)",
  gap: 8,
  fontSize: 11,
  color: "var(--muted-deep)",
};

const genericContent: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "220px minmax(0, 1fr)",
  gap: 12,
  padding: "0 14px 14px",
};

const genericColumn: CSSProperties = {
  minWidth: 0,
};

const genericColumnWide: CSSProperties = {
  minWidth: 0,
};

const genericActionRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginTop: 12,
};

const widgetRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  padding: "8px 9px",
  borderRadius: 8,
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  fontSize: 12,
  color: "var(--ink-soft)",
};

const governanceBox: CSSProperties = {
  marginTop: 14,
  paddingTop: 2,
};

const trustGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 6,
  marginBottom: 8,
};

const trustTile: CSSProperties = {
  display: "grid",
  gap: 2,
  minWidth: 0,
  padding: "8px 7px",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  fontSize: 10,
};

function trustTone(tone: "ok" | "claim" | "warn" | "risk" | "neutral"): CSSProperties {
  if (tone === "ok") return { color: "var(--green-deep)" };
  if (tone === "claim") return { color: "var(--blue-deep)" };
  if (tone === "warn") return { color: "var(--peach-ink)" };
  if (tone === "risk") return { color: "var(--danger, var(--danger))" };
  return { color: "var(--muted-deep)" };
}

const governanceRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  color: "var(--muted-deep)",
  fontSize: 11,
};

const capabilityList: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
  marginTop: 8,
};

const capabilityPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  maxWidth: "100%",
  padding: "4px 6px",
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 10,
  fontWeight: 800,
};

const delegationBox: CSSProperties = {
  marginTop: 14,
  paddingTop: 2,
};

const delegationStep: CSSProperties = {
  padding: 9,
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  display: "grid",
  gap: 6,
  fontSize: 11,
  color: "var(--muted-deep)",
};

const delegationStepTop: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
  fontSize: 11,
};

const delegationDetail: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 10.5,
  lineHeight: 1.35,
};

const delegationIssue: CSSProperties = {
  padding: 8,
  borderRadius: 8,
  border: "1px solid rgba(180,83,58,0.28)",
  background: "rgba(180,83,58,0.08)",
  color: "var(--danger, var(--danger))",
  fontSize: 10.5,
  lineHeight: 1.35,
};

const credentialBox: CSSProperties = {
  padding: 9,
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  display: "grid",
  gap: 7,
  fontSize: 11,
  color: "var(--muted-deep)",
};

const credentialMetaGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "82px minmax(0, 1fr)",
  gap: "4px 8px",
  alignItems: "baseline",
  minWidth: 0,
};

const secureCredentialOverlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(20, 24, 32, 0.22)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 80,
  padding: 18,
};

const secureCredentialDialog: CSSProperties = {
  width: "var(--popup-3-width)",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  boxShadow: "0 18px 60px rgba(20, 24, 32, 0.24)",
  display: "grid",
  gap: 12,
  padding: 14,
};

const secureCredentialHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "34px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 10,
};

const secureCredentialMark: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  background: "var(--fill-1)",
  color: "var(--accent)",
  border: "1px solid var(--accent-soft)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const secureCredentialFacts: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

function secureCredentialNotice(mode: string | undefined): CSSProperties {
  const brokered = mode === "host-bound-broker";
  return {
    padding: 9,
    borderRadius: 8,
    border: brokered ? "1px solid rgba(42,127,98,0.28)" : "1px solid rgba(180,83,58,0.24)",
    background: brokered ? "rgba(42,127,98,0.08)" : "rgba(180,83,58,0.08)",
    color: brokered ? "var(--green-deep)" : "var(--danger, var(--danger))",
    fontSize: 11,
    lineHeight: 1.4,
  };
}

const credentialInputRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 6,
  alignItems: "center",
};

const credentialInput: CSSProperties = {
  minWidth: 0,
  height: 30,
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink)",
  padding: "0 8px",
  fontSize: 11,
};

const compactActionButton: CSSProperties = {
  minHeight: 28,
  borderRadius: 8,
  border: "1px solid var(--accent-soft)",
  background: "var(--fill-1)",
  color: "var(--ink)",
  fontSize: 10.5,
  fontWeight: 800,
  padding: "5px 8px",
};

function credentialModePill(mode: string | undefined): CSSProperties {
  const brokered = mode === "host-bound-broker";
  return {
    maxWidth: 150,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    borderRadius: 999,
    border: brokered ? "1px solid rgba(42,127,98,0.28)" : "1px solid var(--paper-edge)",
    background: brokered ? "rgba(42,127,98,0.08)" : "var(--paper-2)",
    color: brokered ? "var(--green-deep)" : "var(--muted-deep)",
    padding: "2px 6px",
    fontSize: 9.5,
    fontWeight: 800,
  };
}

const linkLikeButton: CSSProperties = {
  justifySelf: "start",
  border: "none",
  background: "transparent",
  color: "var(--accent)",
  padding: 0,
  fontSize: 11,
  fontWeight: 800,
};

function delegationStatus(status: string): CSSProperties {
  if (status === "ready") return { color: "var(--green-deep)", fontWeight: 800 };
  if (status === "blocked-by-contract") return { color: "var(--danger, var(--danger))", fontWeight: 800 };
  if (status.includes("secret") || status.includes("payment")) return { color: "var(--peach-ink)", fontWeight: 800 };
  return { color: "var(--blue-deep)", fontWeight: 800 };
}

const evidencePill: CSSProperties = {
  width: "fit-content",
  maxWidth: "100%",
  padding: "3px 6px",
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  fontSize: 10,
  fontWeight: 800,
};

function evidenceTone(kind: string): CSSProperties {
  if (kind === "verified") return { color: "var(--green-deep)", background: "rgba(80,150,110,0.12)" };
  if (kind === "estimated") return { color: "var(--peach-ink)", background: "rgba(233,169,108,0.16)" };
  if (kind === "claimed") return { color: "var(--blue-deep)", background: "rgba(96,139,224,0.14)" };
  return { color: "var(--muted-deep)", background: "var(--paper-2)" };
}

const tableWrap: CSSProperties = {
  overflow: "auto",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
};

const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12,
};

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  color: "var(--muted-deep)",
  background: "var(--paper-2)",
  borderBottom: "1px solid var(--paper-edge)",
};

const td: CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--paper-edge)",
  color: "var(--ink-soft)",
  maxWidth: 220,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const emptyState: CSSProperties = {
  padding: 18,
  borderRadius: 8,
  border: "1px dashed var(--paper-edge)",
  color: "var(--muted-deep)",
  background: "var(--paper)",
  fontSize: 12,
};
