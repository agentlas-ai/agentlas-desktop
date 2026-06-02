// Agent-made Surfaces registry.
// A surface is the durable Workbench outcome emitted by an agent before it is
// converted into generated apps, tools, exports, or automation.
"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceRecord,
  AppFactoryScaffoldResult,
  InstalledAgent,
  Project,
  ToolFactoryScaffoldResult,
} from "@/lib/types";
import { surfaceApprovalRequirement, type SurfaceApprovalRequirement } from "@/lib/surface-approval";
import { SurfaceWorkbench, type SurfaceStatePatchHandler, type WorkbenchSurface } from "@/components/WorkbenchPanel";
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconLayers,
  IconRoute,
  IconSparkles,
} from "@/components/Icon";

async function ensureSurfaceApproval(
  api: NonNullable<ReturnType<typeof ipc>>,
  surfaceId: string,
  action: AgentlasSurfaceAction,
  approval: SurfaceApprovalRequirement,
): Promise<boolean> {
  if (approval.persist) {
    try {
      if (await api.surfaces.hasApproval({ surfaceId, scopeKey: approval.scopeKey })) return true;
    } catch {
      // Fall through to explicit confirmation.
    }
  }
  const ok = window.confirm(approval.message);
  if (!ok) return false;
  try {
    await api.surfaces.approve({
      surfaceId,
      actionId: action.id,
      actionType: action.type,
      kind: approval.kind,
      scopeKey: approval.scopeKey,
      title: approval.title,
      summary: approval.summary,
      metadata: approval.metadata,
    });
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err));
    return false;
  }
  return true;
}

export default function LibrarySurfacesPage() {
  const { t, locale } = useT();
  const [surfaces, setSurfaces] = useState<AgentlasSurfaceRecord[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const selected = surfaces.find((surface) => surface.id === selectedId) ?? surfaces[0] ?? null;

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [nextSurfaces, nextAgents, nextProjects] = await Promise.all([
      api.surfaces.listSurfaces(),
      api.team.list(),
      api.projects.list(),
    ]);
    setSurfaces(nextSurfaces);
    setAgents(nextAgents);
    setProjects(nextProjects);
    setSelectedId((cur) =>
      cur && nextSurfaces.some((surface) => surface.id === cur)
        ? cur
        : nextSurfaces[0]?.id ?? null,
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const copyManifest = useCallback(() => {
    if (!selected) return;
    void navigator.clipboard.writeText(JSON.stringify(selected.manifest, null, 2));
    setMessage("Copied manifest");
  }, [selected]);

  const handleSurfaceAction = useCallback(
    async (surface: WorkbenchSurface, action: AgentlasSurfaceAction) => {
      const api = ipc();
      const record = surfaces.find((item) => item.id === surface.id);
      if (action.type === "external-link" && action.url) {
        window.open(action.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (action.type === "copy") {
        void navigator.clipboard.writeText(action.prompt || JSON.stringify(surface.manifest, null, 2));
        setMessage("Copied action payload");
        return;
      }

      if (
        action.type === "scaffold-agent-team" ||
        action.type === "scaffold-app" ||
        action.type === "install-mcp" ||
        action.type === "run-smoke-test" ||
        action.type === "deploy-preview" ||
        action.type === "scaffold-tool" ||
        action.type === "run-tool-smoke" ||
        action.type === "install-tool-mcp" ||
        action.type === "materialize-asset-pack"
      ) {
        if (!api || !record) return;
        const approval = surfaceApprovalRequirement(record, action);
        if (approval) {
          const approved = await ensureSurfaceApproval(api, record.id, action, approval);
          if (!approved) {
            setMessage(`${action.label} cancelled before changing anything.`);
            return;
          }
        }
        const label = record.manifest.app?.name || record.title;
        setBusyActionId(action.id);
        setMessage(`${action.label} started for ${label}...`);

        const ensureScaffold = async (): Promise<AppFactoryScaffoldResult> => {
          const existing = await api.appFactory.getAppBySurface(record.chatId, record.id);
          if (existing) return { ...existing.scaffold, record: existing };
          return api.appFactory.scaffold({
            chatId: record.chatId,
            surfaceId: record.id,
            actionId: action.id,
            manifest: record.manifest,
          });
        };

        const ensureTool = async (): Promise<ToolFactoryScaffoldResult> => {
          const requestedToolId = typeof action.toolId === "string" ? action.toolId : undefined;
          const existing = await api.toolFactory.getToolBySurface(
            record.chatId,
            record.id,
            requestedToolId,
          );
          if (existing) return { ...existing.scaffold, record: existing };
          return api.toolFactory.scaffold({
            chatId: record.chatId,
            surfaceId: record.id,
            actionId: action.id,
            toolId: requestedToolId,
            manifest: record.manifest,
          });
        };

        void (async () => {
          try {
            if (action.type === "scaffold-agent-team") {
              const result = await api.metaAgent.createCommerceTeam({
                chatId: record.chatId,
                surfaceId: record.id,
                manifest: record.manifest,
              });
              setMessage(`Agent team ready: ${result.firm.name}\n${result.rootPath}`);
              return;
            }
            if (action.type === "materialize-asset-pack") {
              const result = await api.surfaceAssets.materialize({
                chatId: record.chatId,
                surfaceId: record.id,
                actionId: action.id,
                manifest: record.manifest,
              });
              setMessage(`Asset pack ready: ${result.rootPath}`);
              window.open(result.fileUrl, "_blank", "noopener,noreferrer");
              return;
            }
            if (
              action.type === "scaffold-tool" ||
              action.type === "run-tool-smoke" ||
              action.type === "install-tool-mcp"
            ) {
              const tool = await ensureTool();
              if (action.type === "scaffold-tool") {
                setMessage(`Tool scaffold ready: ${tool.toolName}\n${tool.rootPath}`);
                return;
              }
              if (action.type === "run-tool-smoke") {
                const result = await api.toolFactory.runSmoke({ rootPath: tool.rootPath });
                setMessage(
                  result.ok
                    ? `Tool smoke passed: ${tool.toolName}`
                    : `Tool smoke failed: ${tool.toolName} · exit ${result.exitCode ?? "unknown"}`,
                );
                return;
              }
              const result = await api.toolFactory.installMcp({ rootPath: tool.rootPath });
              setMessage(`Tool MCP installed: ${result.server.name}`);
              return;
            }

            const app = await ensureScaffold();
            if (action.type === "scaffold-app") {
              setMessage(`App scaffold ready: ${app.appName}\n${app.rootPath}`);
            } else if (action.type === "install-mcp") {
              const result = await api.appFactory.installMcpPlan({ rootPath: app.rootPath });
              setMessage(
                result.missingCredentials.length
                  ? `MCP plan ready with missing credentials: ${result.missingCredentials.join(", ")}`
                  : `MCP adapters ready: ${result.adapters.length}`,
              );
            } else if (action.type === "run-smoke-test") {
              const result = await api.appFactory.runSmoke({ rootPath: app.rootPath });
              setMessage(
                result.ok
                  ? `App smoke passed: ${app.appName}`
                  : `App smoke failed: ${app.appName} · exit ${result.exitCode ?? "unknown"}`,
              );
            } else if (action.type === "deploy-preview") {
              const result = await api.appFactory.preparePreview({ rootPath: app.rootPath });
              setMessage(`Preview package ready: ${result.deployPath}`);
              window.open(result.fileUrl, "_blank", "noopener,noreferrer");
            }
          } catch (err: unknown) {
            setMessage(err instanceof Error ? err.message : String(err));
          } finally {
            setBusyActionId(null);
          }
        })();
        return;
      }

      if (api && record) {
        const approval = surfaceApprovalRequirement(record, action);
        if (approval && !(await ensureSurfaceApproval(api, record.id, action, approval))) {
          setMessage(`${action.label} cancelled before changing anything.`);
          return;
        }
      }
      setMessage("Open the originating chat to run this action with context.");
    },
    [surfaces],
  );

  const handleSurfaceStatePatch = useCallback<SurfaceStatePatchHandler>((surface, patch) => {
    const api = ipc();
    if (!api) return;
    void api.surfaces
      .updateState({
        surfaceId: surface.id,
        ...patch,
        actor: patch.actor || "user",
      })
      .then((record) => {
        setSurfaces((items) => items.map((item) => (item.id === record.id ? record : item)));
        setMessage(`Saved state: ${patch.label || patch.path}`);
      })
      .catch((err: unknown) => {
        setMessage(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <section style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "24px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 13 }}>
            {t("library.surfaces.subtitle")}
          </p>
          <span style={countPill}>
            <IconSparkles size={12} />
            {surfaces.length}
          </span>
        </div>

        {surfaces.length === 0 ? (
          <div style={emptyState}>
            <IconSparkles size={24} style={{ color: "var(--muted-deep)" }} />
            <strong style={{ color: "var(--ink)", fontSize: 14 }}>{t("library.surfaces.empty")}</strong>
            <span style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("library.surfaces.empty_hint")}</span>
            <Link href="/" style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "none", marginTop: 4 }}>
              {t("sidebar.new_chat")} <IconChevronRight size={11} />
            </Link>
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {surfaces.map((surface) => {
              const active = surface.id === selected?.id;
              const agent = agentById.get(surface.agentId);
              const project = surface.projectId ? projectById.get(surface.projectId) : null;
              const actionCount = surface.manifest.actions?.length ?? 0;
              return (
                <li key={surface.id}>
                  <button
                    onClick={() => setSelectedId(surface.id)}
                    style={{
                      ...surfaceRow,
                      borderColor: active ? "var(--accent)" : "var(--paper-edge)",
                      background: active ? "var(--fill-1)" : "var(--paper)",
                    }}
                  >
                    <span style={surfaceIcon}>
                      <IconSparkles size={15} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 4, textAlign: "left" }}>
                      <strong style={ellipsis}>{surface.title}</strong>
                      <span style={{ display: "flex", gap: 8, color: "var(--muted-deep)", fontSize: 11, minWidth: 0, flexWrap: "wrap" }}>
                        <span>{surface.domain}</span>
                        <span>{surface.layout}</span>
                        {agent && <span>{pickLocalized(agent, locale).name}</span>}
                        {project && <span>{project.name}</span>}
                      </span>
                    </span>
                    <span style={metricPill}>
                      <IconLayers size={11} />
                      {surface.manifest.widgets.length}
                    </span>
                    <span style={metricPill}>
                      <IconCheck size={11} />
                      {actionCount}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <aside style={detailPane}>
        {selected ? (
          <SurfaceDetail
            surface={selected}
            agent={agentById.get(selected.agentId) ?? null}
            project={selected.projectId ? projectById.get(selected.projectId) ?? null : null}
            message={message}
            busyActionId={busyActionId}
            onCopyManifest={copyManifest}
            onClearMessage={() => setMessage("")}
            onAction={handleSurfaceAction}
            onStatePatch={handleSurfaceStatePatch}
          />
        ) : (
          <div style={{ color: "var(--muted-deep)", fontSize: 13 }}>{t("library.surfaces.empty")}</div>
        )}
      </aside>
    </div>
  );
}

function SurfaceDetail({
  surface,
  agent,
  project,
  message,
  busyActionId,
  onCopyManifest,
  onClearMessage,
  onAction,
  onStatePatch,
}: {
  surface: AgentlasSurfaceRecord;
  agent: InstalledAgent | null;
  project: Project | null;
  message: string;
  busyActionId: string | null;
  onCopyManifest: () => void;
  onClearMessage: () => void;
  onAction: (surface: WorkbenchSurface, action: AgentlasSurfaceAction) => void;
  onStatePatch: SurfaceStatePatchHandler;
}) {
  const { t, locale } = useT();
  const dataSets = Object.keys(surface.manifest.data);
  const workbenchSurface = { id: surface.id, manifest: surface.manifest, state: surface.state, jobSummary: surface.jobSummary };
  const costValue = surface.jobSummary
    ? `${surface.jobSummary.currency} ${surface.jobSummary.costSpent}${
        surface.jobSummary.budgetLimit !== undefined ? `/${surface.jobSummary.budgetLimit}` : ""
      }`
    : "None";
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "22px 22px 16px", borderBottom: "var(--hairline)", display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={statusPill}>{surface.layout}</span>
            <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
              {t("library.surfaces.updated", { date: shortDate(surface.updatedAt, locale) })}
            </span>
          </div>
          <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 21, lineHeight: 1.1 }}>
            {surface.title}
          </h2>
          <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.5 }}>
            {surface.domain} · {surface.manifest.widgets.length} widgets · {dataSets.length} data sets
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <MiniStat label="Agent" value={agent ? pickLocalized(agent, locale).name : surface.agentId} />
          <MiniStat label="Project" value={project?.name || "Local"} />
          <MiniStat label={t("library.surfaces.data")} value={String(dataSets.length)} />
          <MiniStat label={t("library.surfaces.actions")} value={String(surface.manifest.actions?.length ?? 0)} />
          <MiniStat label="Cost" value={costValue} />
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <ActionButton
            href={`/chat?id=${surface.chatId}&surface=${surface.id}`}
            label={t("library.surfaces.open_chat")}
            icon={<IconRoute size={12} />}
          />
          <ActionButton
            onClick={onCopyManifest}
            label={t("library.surfaces.copy_manifest")}
            icon={<IconLayers size={12} />}
          />
          {busyActionId && <span style={statusPill}>{t("library.surfaces.running")}</span>}
        </div>

        {message && (
          <div style={messageBox}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{message}</span>
            <button onClick={onClearMessage} aria-label={t("common.close")} style={plainIconButton}>
              <IconClose size={12} />
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div className="agentlas-surface-library-preview" style={previewWrap}>
          <style>{`
            .agentlas-surface-library-preview .agentlas-creative-grid,
            .agentlas-surface-library-preview .agentlas-generic-content,
            .agentlas-surface-library-preview .agentlas-app-preview-body,
            .agentlas-surface-library-preview .agentlas-app-lower-grid,
            .agentlas-surface-library-preview .agentlas-app-metric-grid {
              grid-template-columns: 1fr !important;
            }
            .agentlas-surface-library-preview .agentlas-workbench-hero {
              flex-direction: column !important;
            }
          `}</style>
          <SurfaceWorkbench surface={workbenchSurface} onAction={onAction} onStatePatch={onStatePatch} />
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniStat}>
      <span style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", fontWeight: 800 }}>{label}</span>
      <strong style={{ fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</strong>
    </div>
  );
}

function ActionButton({
  href,
  onClick,
  label,
  icon,
}: {
  href?: string;
  onClick?: () => void;
  label: string;
  icon: ReactNode;
}) {
  const content = (
    <>
      {icon}
      <span>{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} style={{ ...actionButton, textDecoration: "none" }}>
        {content}
      </Link>
    );
  }
  return (
    <button onClick={onClick} style={actionButton}>
      {content}
    </button>
  );
}

function shortDate(value: string, locale: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const countPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 9px",
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 12,
  fontWeight: 800,
};

const emptyState: CSSProperties = {
  minHeight: 260,
  border: "1.5px dashed var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexDirection: "column",
  gap: 8,
  textAlign: "center",
};

const surfaceRow: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  cursor: "pointer",
  minWidth: 0,
};

const surfaceIcon: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  background: "rgba(96,139,224,0.16)",
  color: "var(--blue-deep)",
};

const ellipsis: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-head)",
  fontSize: 14,
};

const metricPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
  padding: "4px 7px",
  borderRadius: 999,
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 700,
};

const detailPane: CSSProperties = {
  width: 520,
  maxWidth: "52vw",
  minWidth: 360,
  borderLeft: "var(--hairline)",
  background: "var(--paper)",
  minHeight: 0,
  overflow: "hidden",
};

const statusPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 20,
  padding: "0 7px",
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 800,
  whiteSpace: "nowrap",
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
};

const miniStat: CSSProperties = {
  display: "grid",
  gap: 3,
  minWidth: 0,
  padding: "8px 9px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
};

const actionButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "7px 10px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink-soft)",
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const messageBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  justifyContent: "space-between",
  padding: "8px 10px",
  borderRadius: "var(--radius-md)",
  background: "var(--fill-1)",
  color: "var(--ink-soft)",
  fontSize: 12,
};

const plainIconButton: CSSProperties = {
  width: 22,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "var(--muted-deep)",
  cursor: "pointer",
};

const previewWrap: CSSProperties = {
  padding: 16,
};
