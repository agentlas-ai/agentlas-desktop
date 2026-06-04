// Agent-made Apps registry.
// Shows service apps that agents scaffolded from safe Agentlas Surface manifests.
"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { sanitizePublicAppCopy } from "@shared/brand-safety";
import type {
  AppFactoryAppRecord,
  AppFactoryAppStatus,
  AppFactoryOperationKind,
  AppFactoryOperationRecord,
  AppFactoryProviderBrowserSession,
  AppFactoryProviderNoDeadEndStrategy,
  AppFactoryProviderPaymentGate,
  AppFactoryProviderResolutionPlan,
  AppFactoryProviderTaskRunResult,
  InstalledAgent,
  Project,
} from "@/lib/types";
import {
  IconBolt,
  IconCheck,
  IconChevronRight,
  IconCircleDollar,
  IconClose,
  IconKey,
  IconLayers,
  IconRoute,
  IconSparkles,
} from "@/components/Icon";

function selectedAppIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("id");
}

export default function LibraryAppsPage() {
  const { t, locale } = useT();
  const [apps, setApps] = useState<AppFactoryAppRecord[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operations, setOperations] = useState<AppFactoryOperationRecord[]>([]);
  const [busyAction, setBusyAction] = useState<AppFactoryOperationKind | null>(null);
  const [message, setMessage] = useState<string>("");
  const [vaultDraft, setVaultDraft] = useState<Record<string, string>>({});

  const selected = apps.find((app) => app.id === selectedId) ?? apps[0] ?? null;

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [nextApps, nextAgents, nextProjects] = await Promise.all([
      api.appFactory.listApps(),
      api.team.list(),
      api.projects.list(),
    ]);
    setApps(nextApps);
    setAgents(nextAgents);
    setProjects(nextProjects);
    setSelectedId((cur) => {
      if (cur && nextApps.some((app) => app.id === cur)) return cur;
      const requested = selectedAppIdFromUrl();
      if (requested && nextApps.some((app) => app.id === requested)) return requested;
      return nextApps[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const api = ipc();
    if (!api || !selected?.id) {
      setOperations([]);
      return;
    }
    let cancelled = false;
    void api.appFactory.listOperations(selected.id).then((rows) => {
      if (!cancelled) setOperations(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const runAction = useCallback(
    async (kind: AppFactoryOperationKind) => {
      const api = ipc();
      if (!api || !selected) return;
      setBusyAction(kind);
      setMessage("");
      try {
        if (kind === "run-autopilot") {
          const result = await api.appFactory.runAutopilot({
            rootPath: selected.rootPath,
            budgetApproved: true,
            approvedBy: "agentlas-library-user",
            approvalReason: "User clicked Operate OS in the Agentlas app library.",
            credentialSource: "agentlas-env-vault",
            captureProviderSessions: false,
            browserMode: "plan-only",
          });
          setMessage(`${result.summary}${result.waitingOn.length ? ` Waiting: ${result.waitingOn.join(", ")}` : ""}`);
        } else if (kind === "install-mcp") {
          const result = await api.appFactory.installMcpPlan({ rootPath: selected.rootPath });
          setMessage(
            result.missingCredentials.length
              ? `Missing credentials: ${result.missingCredentials.join(", ")}`
              : `MCP adapters ready: ${result.adapters.length}`,
          );
        } else if (kind === "run-provider-tasks") {
          const result = await api.appFactory.runProviderTasks({ rootPath: selected.rootPath });
          setMessage(result.summary);
        } else if (kind === "materialize-assets") {
          const result = await api.appFactory.materializeAssets({
            rootPath: selected.rootPath,
            budgetApproved: true,
            approvedBy: "agentlas-library-user",
            approvalReason: "User clicked Materialize assets in the Agentlas app library.",
          });
          setMessage(result.summary);
        } else if (kind === "activate-local-commerce-stack") {
          const result = await api.appFactory.activateLocalCommerceStack({
            rootPath: selected.rootPath,
            mode: "local-first",
            activatedBy: "agentlas-library-user",
          });
          setMessage(result.summary);
        } else if (kind === "capture-provider-browser-sessions") {
          const result = await api.appFactory.captureProviderBrowserSessions({
            rootPath: selected.rootPath,
            mode: "headless",
            timeoutMs: 8000,
            screenshot: true,
          });
          setMessage(result.summary);
        } else if (kind === "resolve-provider-credentials") {
          const result = await api.appFactory.resolveProviderCredentials({
            rootPath: selected.rootPath,
            source: "agentlas-env-vault",
          });
          setMessage(result.summary);
        } else if (kind === "open-provider-browser") {
          const result = await api.appFactory.openProviderBrowser({ rootPath: selected.rootPath });
          setMessage(result.summary);
        } else if (kind === "run-smoke-test") {
          const result = await api.appFactory.runSmoke({ rootPath: selected.rootPath });
          setMessage(result.ok ? "Smoke passed" : `Smoke failed: exit ${result.exitCode ?? "unknown"}`);
        } else if (kind === "deploy-preview") {
          const result = await api.appFactory.preparePreview({ rootPath: selected.rootPath });
          setMessage(`Preview package ready: ${result.deployPath}`);
          window.open(result.fileUrl, "_blank", "noopener,noreferrer");
        } else if (kind === "publish-as-tool") {
          const result = await api.appFactory.publishAsTool({ rootPath: selected.rootPath });
          setMessage(result.summary);
        } else if (kind === "archive") {
          const result = await api.appFactory.archive({ rootPath: selected.rootPath });
          const archiveResult = result.result && typeof result.result === "object" ? result.result as Record<string, unknown> : {};
          const mcpNote = archiveResult.removedMcpServerId ? ` · MCP unregistered: ${String(archiveResult.removedMcpServerId)}` : "";
          setMessage(`Archived reversibly: ${String(archiveResult.archivePath ?? selected.rootPath)}${mcpNote}`);
        } else if (kind === "restore") {
          const result = await api.appFactory.restore({ rootPath: selected.rootPath });
          const restoreResult = result.result && typeof result.result === "object" ? result.result as Record<string, unknown> : {};
          setMessage(String(restoreResult.summary ?? "Generated app restored."));
        }
        await refresh();
        const latest = await api.appFactory.getApp(selected.id);
        if (latest) {
          setSelectedId(latest.id);
          const ops = await api.appFactory.listOperations(latest.id);
          setOperations(ops);
        }
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, selected],
  );

  const approvePaymentGate = useCallback(
    async (gate: AppFactoryProviderPaymentGate) => {
      const api = ipc();
      if (!api || !selected) return;
      const scopeKey = paymentScopeKey(gate);
      setBusyAction("approve-provider-payment");
      setMessage("");
      try {
        await api.surfaces.approve({
          surfaceId: selected.surfaceId,
          actionId: gate.actionId ?? null,
          actionType: "request-payment-approval",
          kind: "payment",
          scopeKey,
          title: `Approve payment scope for ${gate.merchant}`,
          summary: paymentApprovalSummary(gate),
          metadata: {
            merchant: gate.merchant,
            quoteRequired: gate.quoteRequired,
            amount: gate.amount ?? null,
            currency: gate.currency ?? null,
            recurrence: gate.recurrence,
            approvalMode: gate.approvalMode,
            cardHandling: gate.cardHandling,
          },
        }).catch(() => null);
        const result = await api.appFactory.approveProviderPayment({
          rootPath: selected.rootPath,
          merchant: gate.merchant,
          quoteRequired: gate.quoteRequired,
          amount: gate.amount ?? null,
          currency: gate.currency ?? null,
          recurrence: gate.recurrence,
          approvalMode: gate.approvalMode,
          cardHandling: gate.cardHandling,
          ...(gate.actionId ? { actionId: gate.actionId } : {}),
          scopeKey,
          approvedBy: "agentlas-library-user",
          purpose: "User approved this provider payment scope from the Agentlas app library.",
        });
        setMessage(result.summary);
        await refresh();
        const latest = await api.appFactory.getApp(selected.id);
        if (latest) {
          setSelectedId(latest.id);
          setOperations(await api.appFactory.listOperations(latest.id));
        }
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, selected],
  );

  const resumeProviderSession = useCallback(
    async (session: AppFactoryProviderBrowserSession) => {
      const api = ipc();
      if (!api || !selected) return;
      const connectorName = session.connectorName || session.connectorId || "provider";
      const approved = window.confirm(
        `Open the controlled provider browser for ${connectorName}?\n\nAgentlas will continue in the provider UI and pause for passwords, OTP, legal identity, CAPTCHA, terms acceptance, or paid checkout.`,
      );
      setBusyAction("launch-provider-session");
      setMessage("");
      try {
        const result = await api.appFactory.launchProviderBrowserSession({
          rootPath: selected.rootPath,
          connectorId: session.connectorId,
          approved,
          dryRun: !approved,
        });
        setMessage(result.summary);
        await refresh();
        const latest = await api.appFactory.getApp(selected.id);
        if (latest) {
          setSelectedId(latest.id);
          setOperations(await api.appFactory.listOperations(latest.id));
        }
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, selected],
  );

  const syncProviderResult = useCallback(
    async (session: AppFactoryProviderBrowserSession) => {
      const api = ipc();
      if (!api || !selected) return;
      setBusyAction("sync-provider-browser-results");
      setMessage("");
      try {
        const result = await api.appFactory.syncProviderBrowserResults({
          rootPath: selected.rootPath,
          connectorId: session.connectorId,
        });
        setMessage(result.summary);
        await refresh();
        const latest = await api.appFactory.getApp(selected.id);
        if (latest) {
          setSelectedId(latest.id);
          setOperations(await api.appFactory.listOperations(latest.id));
        }
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, selected],
  );

  const copyRoot = useCallback(() => {
    if (!selected) return;
    void navigator.clipboard.writeText(selected.rootPath);
    setMessage("Copied root path");
  }, [selected]);

  const openLaunchTarget = useCallback(async () => {
    if (!selected) return;
    const api = ipc();
    if (!api) return;
    setBusyAction("open-launch-target");
    try {
      const result = await api.appFactory.openLaunchTarget({ rootPath: selected.rootPath });
      setMessage(result.summary);
      setOperations(await api.appFactory.listOperations(selected.id));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }, [selected]);

  const saveVaultGate = useCallback(
    async (envKey: string) => {
      const api = ipc();
      const value = vaultDraft[envKey] ?? "";
      if (!api || !value.trim()) return;
      await api.env.set(envKey, value);
      setVaultDraft((cur) => ({ ...cur, [envKey]: "" }));
      if (selected) {
        const result = await api.appFactory.resolveProviderCredentials({
          rootPath: selected.rootPath,
          source: "agentlas-env-vault",
        });
        setOperations(await api.appFactory.listOperations(selected.id));
        setMessage(`Saved ${envKey} to Agentlas env vault. ${result.summary}`);
      } else {
        setMessage(`Saved ${envKey} to Agentlas env vault.`);
      }
    },
    [selected, vaultDraft],
  );

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <section style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "24px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 13 }}>
            {t("library.apps.subtitle")}
          </p>
          <span style={countPill}>
            <IconLayers size={12} />
            {apps.length}
          </span>
        </div>

        {apps.length === 0 ? (
          <div style={emptyState}>
            <IconLayers size={24} style={{ color: "var(--muted-deep)" }} />
            <strong style={{ color: "var(--ink)", fontSize: 14 }}>{t("library.apps.empty")}</strong>
            <span style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("library.apps.empty_hint")}</span>
            <Link href="/" style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "none", marginTop: 4 }}>
              {t("sidebar.new_chat")} <IconChevronRight size={11} />
            </Link>
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {apps.map((app) => {
              const active = app.id === selected?.id;
              const agent = agentById.get(app.agentId);
              const project = app.projectId ? projectById.get(app.projectId) : null;
              const appName = sanitizePublicAppCopy(app.appName, app.appName);
              const appDomain = sanitizePublicAppCopy(app.domain, app.domain);
              const routes = app.manifest.app?.routes?.length ?? 0;
              const connectors = app.manifest.app?.connectors?.length ?? 0;
              return (
                <li key={app.id}>
                  <button
                    onClick={() => setSelectedId(app.id)}
                    style={{
                      ...appRow,
                      borderColor: active ? "var(--accent)" : "var(--paper-edge)",
                      background: active ? "var(--fill-1)" : "var(--paper)",
                    }}
                  >
                    <span style={appIcon(app.status)}>
                      <IconSparkles size={15} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 4, textAlign: "left" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <strong style={ellipsis}>{appName}</strong>
                        <StatusPill status={app.status} />
                      </span>
                      <span style={{ display: "flex", gap: 8, color: "var(--muted-deep)", fontSize: 11, minWidth: 0, flexWrap: "wrap" }}>
                        <span>{appDomain}</span>
                        {agent && <span>{pickLocalized(agent, locale).name}</span>}
                        {project && <span>{project.name}</span>}
                      </span>
                    </span>
                    <span style={metricPill}>
                      <IconRoute size={11} />
                      {routes}
                    </span>
                    <span style={metricPill}>
                      <IconKey size={11} />
                      {connectors}
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
          <AppDetail
            app={selected}
            agent={agentById.get(selected.agentId) ?? null}
            project={selected.projectId ? projectById.get(selected.projectId) ?? null : null}
            operations={operations}
            busyAction={busyAction}
            message={message}
            onCopyRoot={copyRoot}
            onRunAutopilot={() => void runAction("run-autopilot")}
            onPreparePreview={() => void runAction("deploy-preview")}
            onOpenPreview={() => void openLaunchTarget()}
            onInstallMcp={() => void runAction("install-mcp")}
            onRunProviderTasks={() => void runAction("run-provider-tasks")}
            onMaterializeAssets={() => void runAction("materialize-assets")}
            onActivateLocalStack={() => void runAction("activate-local-commerce-stack")}
            onCaptureProviderSessions={() => void runAction("capture-provider-browser-sessions")}
            onResolveCredentials={() => void runAction("resolve-provider-credentials")}
            onOpenProviderBrowser={() => void runAction("open-provider-browser")}
            onResumeProviderSession={(session) => void resumeProviderSession(session)}
            onSyncProviderResult={(session) => void syncProviderResult(session)}
            onRunSmoke={() => void runAction("run-smoke-test")}
            onPublishAsTool={() => void runAction("publish-as-tool")}
            onArchive={() => void runAction("archive")}
            onRestore={() => void runAction("restore")}
            onApprovePaymentGate={(gate) => void approvePaymentGate(gate)}
            vaultDraft={vaultDraft}
            onVaultDraftChange={(key, value) => setVaultDraft((cur) => ({ ...cur, [key]: value }))}
            onSaveVaultGate={(key) => void saveVaultGate(key)}
            onClearMessage={() => setMessage("")}
          />
        ) : (
          <div style={{ color: "var(--muted-deep)", fontSize: 13 }}>{t("library.apps.empty")}</div>
        )}
      </aside>
    </div>
  );
}

function AppDetail({
  app,
  agent,
  project,
  operations,
  busyAction,
  message,
  onCopyRoot,
  onRunAutopilot,
  onPreparePreview,
  onOpenPreview,
  onInstallMcp,
  onRunProviderTasks,
  onMaterializeAssets,
  onActivateLocalStack,
  onCaptureProviderSessions,
  onResolveCredentials,
  onOpenProviderBrowser,
  onResumeProviderSession,
  onSyncProviderResult,
  onRunSmoke,
  onPublishAsTool,
  onArchive,
  onRestore,
  onApprovePaymentGate,
  vaultDraft,
  onVaultDraftChange,
  onSaveVaultGate,
  onClearMessage,
}: {
  app: AppFactoryAppRecord;
  agent: InstalledAgent | null;
  project: Project | null;
  operations: AppFactoryOperationRecord[];
  busyAction: AppFactoryOperationKind | null;
  message: string;
  onCopyRoot: () => void;
  onRunAutopilot: () => void;
  onPreparePreview: () => void;
  onOpenPreview: () => void;
  onInstallMcp: () => void;
  onRunProviderTasks: () => void;
  onMaterializeAssets: () => void;
  onActivateLocalStack: () => void;
  onCaptureProviderSessions: () => void;
  onResolveCredentials: () => void;
  onOpenProviderBrowser: () => void;
  onResumeProviderSession: (session: AppFactoryProviderBrowserSession) => void;
  onSyncProviderResult: (session: AppFactoryProviderBrowserSession) => void;
  onRunSmoke: () => void;
  onPublishAsTool: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onApprovePaymentGate: (gate: AppFactoryProviderPaymentGate) => void;
  vaultDraft: Record<string, string>;
  onVaultDraftChange: (key: string, value: string) => void;
  onSaveVaultGate: (key: string) => void;
  onClearMessage: () => void;
}) {
  const { t, locale } = useT();
  const routes = app.manifest.app?.routes ?? [];
  const connectors = app.manifest.app?.connectors ?? [];
  const files = [
    app.rootPath,
    app.previewPath,
    app.setupPath,
    app.smokePath,
  ];
  const providerRun = latestProviderRun(operations);
  const providerSessions = latestProviderBrowserSessions(operations);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "22px 22px 16px", borderBottom: "var(--hairline)", display: "grid", gap: 12 }}>
        <AppShowcaseHero
          app={app}
          agent={agent}
          project={project}
          routes={routes}
          connectors={connectors}
          providerSessions={providerSessions}
          operations={operations}
        />

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <ActionButton href={`/chat?id=${app.chatId}`} label={t("library.apps.open_chat")} icon={<IconSparkles size={12} />} />
          <ActionButton onClick={onCopyRoot} label={t("library.apps.copy_path")} icon={<IconLayers size={12} />} />
          <ActionButton onClick={onRunAutopilot} label="Operate OS" icon={<IconBolt size={12} />} busy={busyAction === "run-autopilot"} disabled={app.status === "archived"} />
          <ActionButton onClick={onInstallMcp} label={t("library.apps.install_mcp")} icon={<IconKey size={12} />} busy={busyAction === "install-mcp"} disabled={app.status === "archived"} />
          <ActionButton onClick={onRunProviderTasks} label={t("library.apps.run_provider_tasks")} icon={<IconBolt size={12} />} busy={busyAction === "run-provider-tasks"} disabled={app.status === "archived"} />
          <ActionButton onClick={onOpenProviderBrowser} label={t("library.apps.open_provider_browser")} icon={<IconRoute size={12} />} busy={busyAction === "open-provider-browser"} disabled={app.status === "archived"} />
          <ActionButton onClick={onCaptureProviderSessions} label={t("library.apps.capture_provider_sessions")} icon={<IconRoute size={12} />} busy={busyAction === "capture-provider-browser-sessions"} disabled={app.status === "archived"} />
          <ActionButton onClick={onResolveCredentials} label={t("library.apps.resolve_credentials")} icon={<IconKey size={12} />} busy={busyAction === "resolve-provider-credentials"} disabled={app.status === "archived"} />
          {app.domain === "ecommerce" && (
            <>
              <ActionButton onClick={onMaterializeAssets} label={t("library.apps.materialize_assets")} icon={<IconSparkles size={12} />} busy={busyAction === "materialize-assets"} disabled={app.status === "archived"} />
              <ActionButton onClick={onActivateLocalStack} label={t("library.apps.activate_local_stack")} icon={<IconCircleDollar size={12} />} busy={busyAction === "activate-local-commerce-stack"} disabled={app.status === "archived"} />
            </>
          )}
          <ActionButton onClick={onRunSmoke} label={t("library.apps.run_smoke")} icon={<IconBolt size={12} />} busy={busyAction === "run-smoke-test"} disabled={app.status === "archived"} />
          <ActionButton onClick={onPreparePreview} label={t("library.apps.deploy_preview")} icon={<IconCircleDollar size={12} />} busy={busyAction === "deploy-preview"} disabled={app.status === "archived"} />
          <ActionButton onClick={onOpenPreview} label={t("library.apps.open_preview")} icon={<IconRoute size={12} />} busy={busyAction === "open-launch-target"} disabled={app.status === "archived"} />
          <ActionButton onClick={onPublishAsTool} label={t("library.apps.publish_tool")} icon={<IconKey size={12} />} busy={busyAction === "publish-as-tool"} disabled={app.status === "archived"} />
          {app.status === "archived" ? (
            <ActionButton onClick={onRestore} label={t("library.apps.restore")} icon={<IconCheck size={12} />} busy={busyAction === "restore"} />
          ) : (
            <ActionButton onClick={onArchive} label={t("library.apps.archive")} icon={<IconClose size={12} />} busy={busyAction === "archive"} />
          )}
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

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 22px", display: "grid", gap: 18, alignContent: "start" }}>
        <AgentOperatorConsole
          app={app}
          providerRun={providerRun}
          providerSessions={providerSessions}
          operations={operations}
        />

        <DetailSection title={t("library.apps.routes")}>
          {routes.length ? (
            <div style={{ display: "grid", gap: 6 }}>
              {routes.map((route) => (
                <div key={`${route.path}:${route.label}`} style={lineItem}>
                  <IconRoute size={13} style={{ color: "var(--accent)" }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12 }}>
                      {sanitizePublicAppCopy(route.label, route.label)}
                    </div>
                    <div style={{ color: "var(--muted-deep)", fontSize: 11, overflowWrap: "anywhere" }}>{route.path}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <MutedLine text="No routes declared." />
          )}
        </DetailSection>

        <DetailSection title={t("library.apps.connectors")}>
          {connectors.length ? (
            <div style={{ display: "grid", gap: 6 }}>
              {connectors.map((connector) => (
                <div key={connector.id} style={lineItem}>
                  <IconKey size={13} style={{ color: connector.status === "verified" ? "var(--green-deep)" : "var(--peach-ink)" }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 12 }}>{connector.name}</strong>
                      <span style={tinyPill}>{connector.type}</span>
                      <span style={tinyPill}>{connector.status || "proposed"}</span>
                    </div>
                    {connector.purpose && (
                      <div style={{ color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.4 }}>{connector.purpose}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <MutedLine text="No connectors declared." />
          )}
        </DetailSection>

        <DetailSection title={t("library.apps.operations")}>
          {operations.length ? (
            <div style={{ display: "grid", gap: 0, borderTop: "var(--hairline)" }}>
              {operations.map((op) => (
                <div key={op.id} style={operationRow}>
                  <span style={{ color: op.ok ? "var(--green-deep)" : "var(--danger, #b4533a)" }}>
                    {op.ok ? <IconCheck size={13} /> : <IconClose size={13} />}
                  </span>
                  <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                    <strong style={{ fontSize: 12 }}>{operationLabel(op.operation)}</strong>
                    <span style={{ color: "var(--muted-deep)", fontSize: 11 }}>{operationSummary(op)}</span>
                  </div>
                  <span style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>{shortDate(op.createdAt, locale)}</span>
                </div>
              ))}
            </div>
          ) : (
            <MutedLine text={t("library.apps.no_operations")} />
          )}
        </DetailSection>

        <DetailSection title={t("library.apps.secure_gates")}>
          {providerRun || providerSessions.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              {providerRun && (
                <div style={gateSummary}>
                  <MiniStat label="Ready" value={String(providerRun.readyCount)} />
                  <MiniStat label="Secure gates" value={String(providerRun.secureInputRequiredCount)} />
                  <MiniStat
                    label="No dead ends"
                    value={providerRun.noDeadEndStrategy?.status === "recoverable" ? "recoverable" : providerRun.noDeadEndStrategy?.status ?? "pending"}
                  />
                </div>
              )}
              {providerRun?.noDeadEndStrategy && (
                <NoDeadEndStrategyCard strategy={providerRun.noDeadEndStrategy} />
              )}
              {providerRun && providerRun.browserPlans.length > 0 && (
                <div style={{ display: "grid", gap: 5 }}>
                  {providerRun.browserPlans.map((plan) => (
                    <div key={`${plan.connectorId}:${plan.startUrl}`} style={lineItem}>
                      <IconRoute size={13} style={{ color: "var(--accent)" }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 12 }}>{plan.connectorName}</div>
                        <div style={{ color: "var(--muted-deep)", fontSize: 11, overflowWrap: "anywhere" }}>{plan.startUrl}</div>
                        {plan.envKey && <code style={inlineCode}>{plan.envKey}</code>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {providerSessions.length > 0 && (
                <div style={{ display: "grid", gap: 6 }}>
                  {providerSessions.map((session) => (
                    <div key={`${session.connectorId}:${session.capturedAt}`} style={taskCard}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <strong style={{ fontSize: 12 }}>{session.connectorName}</strong>
                        <span style={tinyPill}>{session.status}</span>
                        <span style={tinyPill}>{session.blockerKind || "none"}</span>
                      </div>
                      <span style={{ color: "var(--muted-deep)", fontSize: 11, overflowWrap: "anywhere" }}>
                        {session.finalUrl || session.startUrl}
                      </span>
                      {session.nextAction && (
                        <span style={{ color: "var(--ink-soft)", fontSize: 11, lineHeight: 1.4 }}>{session.nextAction}</span>
                      )}
                      {session.resultStatus && (
                        <span style={{ color: session.agentCanContinue ? "var(--green-deep)" : "var(--muted-deep)", fontSize: 11, lineHeight: 1.4 }}>
                          Result: {session.resultStatus}{session.resultSyncedAt ? ` · ${shortDate(session.resultSyncedAt, locale)}` : ""}
                        </span>
                      )}
                      <CodeRef label="Launch" value={session.resumeCommand || session.resumeLauncherPath} />
                      <CodeRef label="Queue" value={session.actionQueuePath} />
                      <CodeRef label="Checkpoint" value={session.checkpointManifestPath} />
                      <CodeRef label="Handoff" value={session.handoffPath} />
                      <CodeRef label="Result" value={session.resultPath} />
                      <CodeRef label="Shot" value={session.screenshotPath} />
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          onClick={() => onResumeProviderSession(session)}
                          disabled={busyAction === "launch-provider-session" || app.status === "archived"}
                          style={providerResumeButton}
                        >
                          <IconRoute size={11} />
                          {busyAction === "launch-provider-session" ? "..." : t("library.apps.resume_provider_session")}
                        </button>
                        <button
                          onClick={() => onSyncProviderResult(session)}
                          disabled={busyAction === "sync-provider-browser-results" || app.status === "archived"}
                          style={providerResumeButton}
                        >
                          <IconCheck size={11} />
                          {busyAction === "sync-provider-browser-results" ? "..." : t("library.apps.sync_provider_result")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {providerRun && providerRun.credentialGates.length > 0 && (
                <div style={{ display: "grid", gap: 6 }}>
                  {providerRun.credentialGates.map((gate) => (
                    <div key={gate.envKey} style={vaultCard}>
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ fontSize: 12 }}>{gate.label}</strong>
                        <div style={{ color: "var(--muted-deep)", fontSize: 11, overflowWrap: "anywhere" }}>{gate.envKey}</div>
                      </div>
                      <div style={vaultInputRow}>
                        <input
                          type="password"
                          value={vaultDraft[gate.envKey] ?? ""}
                          onChange={(event) => onVaultDraftChange(gate.envKey, event.target.value)}
                          placeholder={gate.inputMode}
                          style={vaultInput}
                        />
                        <button
                          onClick={() => onSaveVaultGate(gate.envKey)}
                          disabled={!(vaultDraft[gate.envKey] ?? "").trim()}
                          style={vaultSaveButton}
                        >
                          {t("library.apps.save_vault")}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {providerRun && providerRun.paymentGates.length > 0 && (
                <div style={{ display: "grid", gap: 5 }}>
                  {providerRun.paymentGates.map((gate) => (
                    <div key={`${gate.merchant}:${gate.actionId ?? ""}`} style={taskCard}>
                      <strong style={{ fontSize: 12 }}>{gate.merchant}</strong>
                      <span style={{ color: "var(--muted-deep)", fontSize: 11 }}>
                        {gate.quoteRequired ? "quote required" : `${gate.currency ?? ""} ${gate.amount ?? ""}`.trim()} · {gate.recurrence} · {gate.approvalMode}
                      </span>
                      <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>{gate.cardHandling}</span>
                      <button
                        onClick={() => onApprovePaymentGate(gate)}
                        disabled={busyAction === "approve-provider-payment" || app.status === "archived"}
                        style={approvalButton}
                      >
                        {busyAction === "approve-provider-payment" ? "..." : t("library.apps.approve_payment_scope")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {providerRun && providerRun.tasks.map((task) => (
                <div key={task.id} style={taskCard}>
                  <strong style={{ fontSize: 12 }}>{task.label}</strong>
                  <span style={{ color: "var(--muted-deep)", fontSize: 11 }}>{task.afterStatus}</span>
                  <span style={{ color: "var(--ink-soft)", fontSize: 11, lineHeight: 1.4 }}>{task.summary}</span>
                </div>
              ))}
            </div>
          ) : (
            <MutedLine text={t("library.apps.no_secure_gates")} />
          )}
        </DetailSection>

        <DetailSection title={t("library.apps.files")}>
          <div style={{ display: "grid", gap: 5 }}>
            {files.map((file) => (
              <code key={file} style={filePath}>
                {file}
              </code>
            ))}
          </div>
        </DetailSection>
      </div>
    </div>
  );
}

function AgentOperatorConsole({
  app,
  providerRun,
  providerSessions,
  operations,
}: {
  app: AppFactoryAppRecord;
  providerRun: AppFactoryProviderTaskRunResult | null;
  providerSessions: AppFactoryProviderBrowserSession[];
  operations: AppFactoryOperationRecord[];
}) {
  const connectors = app.manifest.app?.connectors ?? [];
  const paymentGates =
    providerRun?.paymentGates.length ??
    Number(operations.some((item) => item.operation === "approve-provider-payment" && item.ok));
  const credentialGates =
    providerRun?.credentialGates.length ??
    Number(operations.some((item) => item.operation === "resolve-provider-credentials" && item.ok));
  const secureSessions = providerSessions.filter((session) =>
    /checkpoint|required|login|signup|payment|captcha/i.test(`${session.status || ""} ${session.blockerKind || ""}`),
  ).length;
  const browserStarts = Math.max(providerSessions.length, providerRun?.browserPlans.length ?? 0);
  const providerResults = providerSessions.filter((session) => session.agentCanContinue || session.resultStatus).length;
  const noDeadEnd = providerRun?.noDeadEndStrategy?.status ?? (connectors.length ? "planned" : "not-needed");
  const latestReusableTool = operations.find((item) => item.operation === "publish-as-tool" && item.ok);
  const rows = [
    {
      label: "External services",
      value: String(connectors.length),
      status: connectors.length ? "ready" : "planned",
      detail: connectors.length ? "Provider surfaces the agent can operate." : "No provider declared yet.",
    },
    {
      label: "Browser delegation",
      value: String(browserStarts),
      status: browserStarts ? "ready" : "planned",
      detail: "Controlled provider profiles with resumable handoff artifacts.",
    },
    {
      label: "Secure checkpoints",
      value: String(paymentGates + credentialGates + secureSessions),
      status: paymentGates + credentialGates + secureSessions ? "approval-required" : "ready",
      detail: "Vault/provider/payment UI for secrets, identity, card/CVV, CAPTCHA, and paid submit.",
    },
    {
      label: "No-dead-end policy",
      value: noDeadEnd,
      status: noDeadEnd,
      detail: "MCP/API absence falls to browser, alternate provider, or local helper.",
    },
    {
      label: "Provider results",
      value: String(providerResults),
      status: providerResults ? "ready" : "planned",
      detail: "Only sanitized status returns to Agentlas OS.",
    },
    {
      label: "Reusable app tool",
      value: latestReusableTool ? "published" : app.status === "tool-published" ? "published" : app.status,
      status: latestReusableTool || app.status === "tool-published" ? "ready" : app.status,
      detail: "Persistent OS object that another agent can call.",
    },
  ];
  return (
    <DetailSection title="Agent Operator">
      <div style={operatorPanel}>
        <div style={operatorGrid}>
          {rows.map((row) => (
            <div key={row.label} style={operatorCard}>
              <span style={{ ...tinyPill, ...operatorTone(row.status) }}>{row.status}</span>
              <strong style={operatorValue}>{row.value}</strong>
              <span style={operatorLabel}>{row.label}</span>
              <span style={operatorDetail}>{row.detail}</span>
            </div>
          ))}
        </div>
        <div style={operatorPolicy}>
          <div style={operatorPolicyCard}>
            <strong>Agent-first external-service operation</strong>
            <span>Missing API/MCP paths become controlled browser delegation, alternate provider, generated local helper, or local fallback.</span>
          </div>
          <div style={operatorPolicyCard}>
            <strong>Secure input concierge</strong>
            <span>Account, credential, identity, and payment details go through Agentlas vault, provider pages, or tokenized payment UI; ledgers keep only fingerprints, approvals, receipts, and sanitized status.</span>
          </div>
        </div>
      </div>
    </DetailSection>
  );
}

function AppShowcaseHero({
  app,
  agent,
  project,
  routes,
  connectors,
  providerSessions,
  operations,
}: {
  app: AppFactoryAppRecord;
  agent: InstalledAgent | null;
  project: Project | null;
  routes: Array<{ path: string; label: string; purpose?: string }>;
  connectors: Array<{ id: string; name: string; type: string; status?: string }>;
  providerSessions: AppFactoryProviderBrowserSession[];
  operations: AppFactoryOperationRecord[];
}) {
  const { t, locale } = useT();
  const agentName = agent ? pickLocalized(agent, locale).name : app.agentId;
  const appName = sanitizePublicAppCopy(app.appName, app.appName);
  const appDomain = sanitizePublicAppCopy(app.domain, app.domain);
  const appType = sanitizePublicAppCopy(app.manifest.app?.appType || app.layout, app.layout);
  const showcaseDescription = sanitizePublicAppCopy(
    app.manifest.app?.valueProp || app.manifest.app?.tagline || app.manifest.title,
    app.manifest.title,
  );
  const successfulOps = operations.filter((op) => op.ok).length;
  const providerResults = providerSessions.filter((session) => session.agentCanContinue || session.resultStatus).length;
  const published = app.status === "tool-published";
  const flow = [
    { label: "Intent", value: appDomain, tone: "claimed" },
    { label: "App", value: `${routes.length} screens`, tone: routes.length ? "ready" : "planned" },
    { label: "Services", value: `${connectors.length} providers`, tone: connectors.length ? "ready" : "planned" },
    { label: "Results", value: `${providerResults} synced`, tone: providerResults ? "ready" : "planned" },
    { label: "Reuse", value: published ? "tool" : app.status, tone: published ? "ready" : app.status },
  ];
  return (
    <div style={showcaseHero}>
      <div style={{ display: "grid", gap: 9, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusPill status={app.status} />
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
            {t("library.apps.updated", { date: shortDate(app.updatedAt, locale) })}
          </span>
        </div>
        <h2 style={showcaseTitle}>{appName}</h2>
        <p style={showcaseCopy}>{showcaseDescription}</p>
      </div>
      <div style={showcaseFlow}>
        {flow.map((item, index) => (
          <div key={item.label} style={showcaseStep}>
            <span style={showcaseStepNumber}>{index + 1}</span>
            <div style={{ minWidth: 0 }}>
              <strong style={showcaseStepLabel}>{item.label}</strong>
              <span style={showcaseStepValue}>{item.value}</span>
            </div>
            <span style={{ ...tinyPill, ...operatorTone(item.tone), justifySelf: "end" }}>{item.tone}</span>
          </div>
        ))}
      </div>
      <div style={showcaseStats}>
        <MiniStat label="Agent" value={agentName} />
        <MiniStat label="Project" value={project?.name || "Local"} />
        <MiniStat label="Ops done" value={String(successfulOps)} />
        <MiniStat label="Type" value={appType} />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: AppFactoryAppStatus }) {
  const { t } = useT();
  return (
    <span style={{ ...statusPill, ...statusColors(status) }}>
      {statusLabel(status, t)}
    </span>
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

function NoDeadEndStrategyCard({ strategy }: { strategy: AppFactoryProviderNoDeadEndStrategy }) {
  const plans = Array.isArray(strategy.plans) ? strategy.plans : [];
  const violations = Array.isArray(strategy.violations) ? strategy.violations : [];
  return (
    <div style={noDeadEndPanel}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 12 }}>No-Dead-End Provider Strategy</strong>
        <span style={{ ...tinyPill, color: strategy.status === "recoverable" ? "var(--green-deep)" : "var(--danger, #b4533a)" }}>
          {strategy.status}
        </span>
      </div>
      <div style={{ color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.4 }}>
        Missing MCP/API becomes browser delegation, alternate provider, or generated local helper. User input goes through secure vault, provider, identity, or payment checkpoints.
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {plans.slice(0, 4).map((plan) => (
          <NoDeadEndPlanRow key={plan.connectorId} plan={plan} />
        ))}
      </div>
      {violations.length > 0 && (
        <div style={{ color: "var(--danger, #b4533a)", fontSize: 11, lineHeight: 1.4 }}>
          {violations.join("; ")}
        </div>
      )}
    </div>
  );
}

function NoDeadEndPlanRow({ plan }: { plan: AppFactoryProviderResolutionPlan }) {
  return (
    <div style={noDeadEndRow}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 12 }}>{plan.connectorName}</strong>
          <span style={tinyPill}>{plan.status}</span>
        </div>
        <div style={{ color: "var(--muted-deep)", fontSize: 11, overflowWrap: "anywhere" }}>
          {plan.currentBestPath}
        </div>
        {plan.localFallback && (
          <div style={{ color: "var(--ink-soft)", fontSize: 11, lineHeight: 1.35 }}>{plan.localFallback}</div>
        )}
      </div>
      <span style={{ ...tinyPill, color: plan.canProceedWithoutMcp ? "var(--green-deep)" : "var(--danger, #b4533a)" }}>
        {plan.canProceedWithoutMcp ? "MCP optional" : "contract gap"}
      </span>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 12, letterSpacing: 0, color: "var(--ink)" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function ActionButton({
  href,
  onClick,
  label,
  icon,
  busy,
  disabled,
}: {
  href?: string;
  onClick?: () => void;
  label: string;
  icon: ReactNode;
  busy?: boolean;
  disabled?: boolean;
}) {
  const content = (
    <>
      {icon}
      <span>{busy ? "..." : label}</span>
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
    <button onClick={onClick} disabled={busy || disabled} style={{ ...actionButton, opacity: disabled ? 0.55 : 1 }}>
      {content}
    </button>
  );
}

function MutedLine({ text }: { text: string }) {
  return <div style={{ color: "var(--muted-deep)", fontSize: 12 }}>{text}</div>;
}

function paymentScopeKey(gate: AppFactoryProviderPaymentGate): string {
  const quote = gate.quoteRequired ? "quote" : `${gate.currency ?? "currency"}-${gate.amount ?? "amount"}`;
  return ["app-provider-payment", slug(gate.merchant), quote, slug(gate.recurrence)].join(":");
}

function paymentApprovalSummary(gate: AppFactoryProviderPaymentGate): string {
  const price = gate.quoteRequired ? "quoted at provider checkout" : `${gate.currency ?? ""} ${gate.amount ?? ""}`.trim();
  return [
    `Merchant: ${gate.merchant}`,
    `Scope: ${price || "amount not declared"}`,
    `Recurrence: ${gate.recurrence}`,
    `Approval mode: ${gate.approvalMode}`,
    `Card handling: ${gate.cardHandling}`,
    "Raw card number, CVV/CVC, OTP, cookies, and provider tokens are not stored in Agentlas chat, files, or manifests.",
  ].join("\n");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "scope";
}

function statusLabel(status: AppFactoryAppStatus, t: ReturnType<typeof useT>["t"]): string {
  switch (status) {
    case "mcp-ready":
      return t("library.apps.status.mcp-ready");
    case "operations-ready":
      return t("library.apps.status.operations-ready");
    case "smoke-passed":
      return t("library.apps.status.smoke-passed");
    case "smoke-failed":
      return t("library.apps.status.smoke-failed");
    case "preview-ready":
      return t("library.apps.status.preview-ready");
    case "tool-published":
      return t("library.apps.status.tool-published");
    case "restored":
      return t("library.apps.status.restored");
    case "archived":
      return t("library.apps.status.archived");
    case "scaffolded":
    default:
      return t("library.apps.status.scaffolded");
  }
}

function statusColors(status: AppFactoryAppStatus): CSSProperties {
  if (status === "smoke-passed" || status === "preview-ready" || status === "operations-ready" || status === "tool-published" || status === "restored") {
    return { background: "rgba(99,154,118,0.16)", color: "var(--green-deep)" };
  }
  if (status === "smoke-failed") {
    return { background: "rgba(224,120,96,0.16)", color: "#b4533a" };
  }
  if (status === "archived") {
    return { background: "var(--paper-2)", color: "var(--muted)" };
  }
  if (status === "mcp-ready") {
    return { background: "rgba(96,139,224,0.16)", color: "var(--blue-deep)" };
  }
  return { background: "var(--paper-2)", color: "var(--muted-deep)" };
}

function operatorTone(status: string): CSSProperties {
  const raw = status.toLowerCase();
  if (raw.includes("ready") || raw.includes("published") || raw.includes("connected") || raw.includes("recoverable") || raw.includes("passed")) {
    return { color: "var(--green-deep)", background: "rgba(99,154,118,0.16)" };
  }
  if (raw.includes("approval") || raw.includes("required") || raw.includes("planned") || raw.includes("scaffolded")) {
    return { color: "var(--peach-ink)", background: "rgba(224,120,96,0.14)" };
  }
  if (raw.includes("fail") || raw.includes("violation") || raw.includes("blocked")) {
    return { color: "var(--danger, #b4533a)", background: "rgba(224,120,96,0.16)" };
  }
  return { color: "var(--muted-deep)", background: "var(--paper-2)" };
}

function appIcon(status: AppFactoryAppStatus): CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: 8,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    ...statusColors(status),
  };
}

function operationLabel(operation: AppFactoryOperationKind): string {
  if (operation === "run-autopilot") return "OS autopilot";
  if (operation === "install-mcp") return "MCP install plan";
  if (operation === "run-provider-tasks") return "Provider tasks";
  if (operation === "materialize-assets") return "Materialize assets";
  if (operation === "activate-local-commerce-stack") return "Local commerce stack";
  if (operation === "capture-provider-browser-sessions") return "Browser checkpoints";
  if (operation === "launch-provider-session") return "Provider handoff";
  if (operation === "sync-provider-browser-results") return "Provider result sync";
  if (operation === "resolve-provider-credentials") return "Credential resolution";
  if (operation === "approve-provider-payment") return "Payment approval";
  if (operation === "open-provider-browser") return "Provider browser";
  if (operation === "run-smoke-test") return "Smoke test";
  if (operation === "deploy-preview") return "Preview package";
  if (operation === "open-launch-target") return "Open local app";
  if (operation === "publish-as-tool") return "Publish as tool";
  if (operation === "archive") return "Archive";
  if (operation === "restore") return "Restore";
  return "Scaffold";
}

function operationSummary(op: AppFactoryOperationRecord): string {
  if (!op.result || typeof op.result !== "object" || Array.isArray(op.result)) {
    return op.ok ? "Completed" : "Failed";
  }
  const result = op.result as Record<string, unknown>;
  if (op.operation === "open-launch-target") {
    return String(result.summary ?? result.target ?? "Opened local app");
  }
  if (op.operation === "run-autopilot") {
    const steps = Array.isArray(result.steps) ? result.steps.length : 0;
    const waiting = Array.isArray(result.waitingOn) ? result.waitingOn.length : 0;
    return `${String(result.status ?? "ran")} · ${steps} steps · ${waiting} waiting`;
  }
  if (op.operation === "install-mcp") {
    const adapters = Array.isArray(result.adapters) ? result.adapters.length : 0;
    const missing = Array.isArray(result.missingCredentials) ? result.missingCredentials.length : 0;
    return `${adapters} adapters · ${missing} missing credentials`;
  }
  if (op.operation === "run-provider-tasks") {
    return String(result.summary ?? "Provider tasks advanced");
  }
  if (op.operation === "materialize-assets") {
    const assets = Array.isArray(result.assets) ? result.assets.length : 0;
    return String(result.summary ?? `${assets} assets materialized`);
  }
  if (op.operation === "activate-local-commerce-stack") {
    return String(result.summary ?? "Local commerce stack activated");
  }
  if (op.operation === "capture-provider-browser-sessions") {
    const sessions = Array.isArray(result.sessions) ? result.sessions.length : 0;
    const screenshots = Array.isArray(result.sessions) ? result.sessions.filter((item) => item && typeof item === "object" && "screenshotPath" in item).length : 0;
    return `${sessions} provider checkpoint${sessions === 1 ? "" : "s"} · ${screenshots} screenshot${screenshots === 1 ? "" : "s"}`;
  }
  if (op.operation === "launch-provider-session") {
    return String(result.summary ?? (result.launched ? "Controlled provider browser opened" : "Provider browser handoff ready"));
  }
  if (op.operation === "sync-provider-browser-results") {
    return String(result.summary ?? "Provider result metadata synced");
  }
  if (op.operation === "resolve-provider-credentials") {
    return String(result.summary ?? "Credential resolution completed");
  }
  if (op.operation === "approve-provider-payment") {
    return String(result.summary ?? "Payment scope approved");
  }
  if (op.operation === "open-provider-browser") {
    const opened = Array.isArray(result.opened) ? result.opened.length : 0;
    return `${opened} provider page${opened === 1 ? "" : "s"} opened`;
  }
  if (op.operation === "run-smoke-test") {
    return `exit ${String(result.exitCode ?? "unknown")}`;
  }
  if (op.operation === "deploy-preview") {
    return String(result.deployPath ?? result.previewPath ?? "Preview ready");
  }
  if (op.operation === "publish-as-tool") {
    return String(result.summary ?? result.toolName ?? "Published as tool");
  }
  if (op.operation === "archive") {
    return result.reversible ? String(result.summary ?? "Reversibly archived") : "Archived";
  }
  if (op.operation === "restore") {
    return String(result.summary ?? "Restored");
  }
  return String(result.summary ?? "Scaffolded");
}

function latestProviderRun(operations: AppFactoryOperationRecord[]): AppFactoryProviderTaskRunResult | null {
  const op = operations.find((item) => item.operation === "run-provider-tasks" || item.operation === "run-autopilot");
  if (!op || !op.result || typeof op.result !== "object" || Array.isArray(op.result)) return null;
  const raw = op.result as Record<string, unknown>;
  const result = (op.operation === "run-autopilot" && raw.providerRun && typeof raw.providerRun === "object" && !Array.isArray(raw.providerRun)
    ? raw.providerRun
    : raw) as unknown as AppFactoryProviderTaskRunResult;
  if (!Array.isArray(result.tasks)) return null;
  return {
    ...result,
    browserPlans: Array.isArray(result.browserPlans) ? result.browserPlans : [],
    credentialGates: Array.isArray(result.credentialGates) ? result.credentialGates : [],
    paymentGates: Array.isArray(result.paymentGates) ? result.paymentGates : [],
  };
}

function latestProviderBrowserSessions(operations: AppFactoryOperationRecord[]): AppFactoryProviderBrowserSession[] {
  const op = operations.find((item) => item.operation === "capture-provider-browser-sessions" && item.ok);
  if (!op || !op.result || typeof op.result !== "object" || Array.isArray(op.result)) return [];
  const sessions = (op.result as Record<string, unknown>).sessions;
  const rows = Array.isArray(sessions) ? sessions.filter((item): item is AppFactoryProviderBrowserSession => Boolean(item) && typeof item === "object") : [];
  const syncOp = operations.find((item) => item.operation === "sync-provider-browser-results" && item.ok);
  if (!syncOp || !syncOp.result || typeof syncOp.result !== "object" || Array.isArray(syncOp.result)) return rows;
  const syncResultRecord = syncOp.result as Record<string, unknown>;
  const syncResults = syncResultRecord.results;
  if (!Array.isArray(syncResults)) return rows;
  const syncCreatedAt: string | undefined = typeof syncResultRecord.createdAt === "string" ? syncResultRecord.createdAt : undefined;
  const resultByConnector = new Map(
    syncResults
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => [String(item.connectorId || ""), item]),
  );
  return rows.map((session) => {
    const result = resultByConnector.get(session.connectorId);
    if (!result) return session;
    return {
      ...session,
      resultStatus: typeof result.resultStatus === "string" ? result.resultStatus : undefined,
      resultSyncedAt: syncCreatedAt,
      resultObservedAt: typeof result.observedAt === "string" ? result.observedAt : undefined,
      resultSummary: typeof result.summary === "string" ? result.summary : undefined,
      agentCanContinue: result.agentCanContinue === true,
    };
  });
}

function CodeRef({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <code style={inlineCode} title={value}>
      {label}: {shortPathLabel(value)}
    </code>
  );
}

function shortPathLabel(value: string): string {
  const quoted = value.match(/"([^"]+)"/)?.[1];
  const clean = (quoted || value).replace(/^node\s+/, "").trim();
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean.slice(0, 80);
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

const showcaseHero: CSSProperties = {
  display: "grid",
  gap: 12,
  padding: 14,
  borderRadius: "var(--radius-md)",
  background:
    "radial-gradient(circle at 86% 12%, rgba(41,87,255,0.22), transparent 32%), radial-gradient(circle at 12% 88%, rgba(15,118,110,0.2), transparent 34%), linear-gradient(135deg, #151513, #17231d 62%, #10222a)",
  border: "1px solid rgba(82, 69, 255, 0.18)",
  boxShadow: "0 18px 54px rgba(24, 24, 20, 0.12)",
};

const showcaseTitle: CSSProperties = {
  margin: 0,
  color: "white",
  fontFamily: "var(--font-head)",
  fontSize: 24,
  lineHeight: 1.02,
  letterSpacing: 0,
  overflowWrap: "anywhere",
};

const showcaseCopy: CSSProperties = {
  margin: 0,
  color: "rgba(255,255,255,0.76)",
  fontSize: 12,
  lineHeight: 1.45,
};

const showcaseFlow: CSSProperties = {
  display: "grid",
  gap: 6,
};

const showcaseStep: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "24px minmax(0, 1fr) auto",
  gap: 8,
  alignItems: "center",
  padding: "8px 9px",
  borderRadius: "var(--radius-md)",
  border: "1px solid rgba(255,255,255,0.5)",
  background: "rgba(255,254,250,0.92)",
};

const showcaseStepNumber: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 999,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--ink)",
  color: "var(--paper)",
  fontSize: 10,
  fontWeight: 900,
};

const showcaseStepLabel: CSSProperties = {
  display: "block",
  color: "var(--ink)",
  fontSize: 11,
  lineHeight: 1.1,
};

const showcaseStepValue: CSSProperties = {
  display: "block",
  color: "var(--muted-deep)",
  fontSize: 11,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const showcaseStats: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
};

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

const appRow: CSSProperties = {
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

const ellipsis: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-head)",
  fontSize: 14,
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
  width: 440,
  maxWidth: "46vw",
  minWidth: 340,
  borderLeft: "var(--hairline)",
  background: "var(--paper)",
  minHeight: 0,
  overflow: "hidden",
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

const lineItem: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "8px 0",
  borderTop: "var(--hairline)",
};

const tinyPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 18,
  padding: "0 6px",
  borderRadius: 999,
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
  fontSize: 10,
  fontWeight: 800,
};

const operationRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "18px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  padding: "9px 0",
  borderBottom: "var(--hairline)",
};

const filePath: CSSProperties = {
  display: "block",
  padding: "6px 8px",
  borderRadius: 6,
  background: "var(--paper-2)",
  color: "var(--ink-soft)",
  fontSize: 11,
  overflowWrap: "anywhere",
};

const operatorPanel: CSSProperties = {
  display: "grid",
  gap: 9,
  padding: 10,
  borderRadius: "var(--radius-md)",
  border: "1px solid rgba(82, 69, 255, 0.18)",
  background: "var(--fill-1)",
};

const operatorGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const operatorCard: CSSProperties = {
  display: "grid",
  gap: 3,
  alignContent: "start",
  minWidth: 0,
  padding: "9px 10px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
};

const operatorValue: CSSProperties = {
  fontFamily: "var(--font-head)",
  fontSize: 18,
  lineHeight: 1.05,
  color: "var(--ink)",
  overflowWrap: "anywhere",
};

const operatorLabel: CSSProperties = {
  color: "var(--ink-soft)",
  fontSize: 11,
  fontWeight: 850,
};

const operatorDetail: CSSProperties = {
  color: "var(--muted-deep)",
  fontSize: 10,
  lineHeight: 1.35,
};

const operatorPolicy: CSSProperties = {
  display: "grid",
  gap: 6,
};

const operatorPolicyCard: CSSProperties = {
  display: "grid",
  gap: 3,
  padding: "8px 9px",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  color: "var(--muted-deep)",
  fontSize: 11,
  lineHeight: 1.35,
};

const gateSummary: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 8,
};

const noDeadEndPanel: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "9px 10px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--fill-1)",
};

const noDeadEndRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 8,
  alignItems: "start",
  padding: "7px 0",
  borderTop: "var(--hairline)",
};

const taskCard: CSSProperties = {
  display: "grid",
  gap: 3,
  padding: "8px 9px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
};

const inlineCode: CSSProperties = {
  display: "inline-flex",
  width: "fit-content",
  marginTop: 4,
  padding: "2px 5px",
  borderRadius: 5,
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 10,
};

const providerResumeButton: CSSProperties = {
  marginTop: 5,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 5,
  width: "fit-content",
  minHeight: 24,
  padding: "4px 8px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid rgba(82, 69, 255, 0.22)",
  background: "var(--paper)",
  color: "var(--accent)",
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const vaultCard: CSSProperties = {
  display: "grid",
  gap: 7,
  padding: "9px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
};

const vaultInputRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  gap: 6,
};

const vaultInput: CSSProperties = {
  minWidth: 0,
  padding: "7px 8px",
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontSize: 12,
};

const vaultSaveButton: CSSProperties = {
  padding: "7px 9px",
  borderRadius: 7,
  border: "1px solid var(--paper-edge)",
  background: "var(--ink)",
  color: "var(--paper)",
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const approvalButton: CSSProperties = {
  width: "fit-content",
  marginTop: 4,
  padding: "7px 9px",
  borderRadius: 7,
  border: "1px solid color-mix(in srgb, var(--green-deep) 32%, var(--paper-edge))",
  background: "color-mix(in srgb, var(--green-deep) 12%, var(--paper))",
  color: "var(--green-deep)",
  fontSize: 11,
  fontWeight: 850,
  cursor: "pointer",
};
