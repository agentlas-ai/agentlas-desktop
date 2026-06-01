// Agent OS workbench panel.
// Renders traditional code artifacts and safe Agentlas Surface manifests in one
// right-side workspace. Surface manifests are declarative; this component never
// executes model-generated HTML/JS.
"use client";
import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { buildSurfaceDelegationPlan } from "@shared/surface-delegation";
import type { AgentlasSurfaceCredentialRequest, AgentlasSurfacePaymentRequest } from "@shared/surface-delegation";
import type {
  AgentlasSurfaceAction,
  AgentlasSurfaceDataSet,
  AgentlasSurfaceManifest,
  JsonObject,
  JsonValue,
  SurfaceJobCostSummary,
  SurfaceStatePatchRequest,
} from "@/lib/types";
import type { CodeArtifact } from "./Markdown";
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

export interface WorkbenchSurface {
  id: string;
  manifest: AgentlasSurfaceManifest;
  state?: JsonObject;
  jobSummary?: SurfaceJobCostSummary;
}

export type SurfaceActionHandler = (
  surface: WorkbenchSurface,
  action: AgentlasSurfaceAction,
) => void;

export type SurfaceStatePatchHandler = (
  surface: WorkbenchSurface,
  patch: Omit<SurfaceStatePatchRequest, "surfaceId">,
) => void;

export function WorkbenchPanel({
  artifact,
  surface,
  onClose,
  onSurfaceAction,
  onSurfaceStatePatch,
}: {
  artifact: CodeArtifact | null;
  surface: WorkbenchSurface | null;
  onClose: () => void;
  onSurfaceAction?: SurfaceActionHandler;
  onSurfaceStatePatch?: SurfaceStatePatchHandler;
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

  return (
    <aside className="agentlas-workbench-panel" style={shell}>
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
        <button onClick={onClose} aria-label={t("chatstream.close_panel")} title={t("chatstream.close")} style={iconButton}>
          <IconClose size={15} />
        </button>
      </header>
      {surface ? (
        <SurfaceWorkbench surface={surface} onAction={onSurfaceAction} onStatePatch={onSurfaceStatePatch} />
      ) : artifact ? (
        <CodeWorkbench artifact={artifact} />
      ) : null}
    </aside>
  );
}

export function SurfaceWorkbench({
  surface,
  onAction,
  onStatePatch,
}: {
  surface: WorkbenchSurface;
  onAction?: SurfaceActionHandler;
  onStatePatch?: SurfaceStatePatchHandler;
}) {
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
  return <GenericSurface surface={surface} onAction={onAction} />;
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
  const appName = app?.name || manifest.title;
  const tagline = app?.tagline || app?.valueProp || "Agent-made app blueprint";
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
              audience: app?.audience || business?.audience || "Not declared",
              offer: business?.offer || app?.valueProp || "Not declared",
              pricing: business?.pricing || "Not declared",
              moat: business?.moat || "Not declared",
            }}
            fallback="No product thesis yet."
          />

          <SectionTitle icon={<IconCircleDollar size={14} />} label="Business Pack" />
          <div style={miniStack}>
            <div style={businessRow}>
              <strong>{stringifyValue(business?.launchMetric || "Not declared")}</strong>
              <span>launch metric</span>
            </div>
            <div style={businessRow}>
              <strong>{app?.appType || "service-app"}</strong>
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

          <section style={appPreviewShell}>
            <div style={appPreviewTopbar}>
              <span style={appLogoMark}>{appName.slice(0, 1).toUpperCase()}</span>
              <strong>{appName}</strong>
              <nav style={appPreviewNav}>
                {routes.slice(0, 4).map((route) => (
                  <span key={route.path}>{route.label}</span>
                ))}
                {routes.length === 0 && <span>No screens declared</span>}
              </nav>
            </div>
            <div className="agentlas-app-preview-body" style={appPreviewBody}>
              <div style={appPreviewMain}>
                <div style={appPreviewHeadline}>
                  <span>Live workflow</span>
                  <strong>{routes[0]?.purpose || "No primary route declared."}</strong>
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
                    <strong>{route.label}</strong>
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
                  artifactRows.slice(0, 6).map((row, idx) => (
                    <div key={idx} style={artifactRow}>
                      <span>{stringField(row, "name") || stringField(row, "path") || `Artifact ${idx + 1}`}</span>
                      <small>{stringField(row, "status") || "Not declared"}</small>
                    </div>
                  ))
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
              <button
                key={action.id}
                style={actionButton}
                title={action.prompt || action.url || action.label}
                onClick={() => onAction?.(surface, action)}
              >
                {action.label}
              </button>
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
              <button
                key={action.id}
                style={actionButton}
                title={action.prompt || action.url || action.label}
                onClick={() => onAction?.(surface, action)}
              >
                {action.label}
              </button>
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
}: {
  surface: WorkbenchSurface;
  onAction?: SurfaceActionHandler;
}) {
  const manifest = surface.manifest;
  const first = Object.entries(manifest.data)[0];
  const rows = rowsOf(first?.[1]);
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
                <button
                  key={action.id}
                  style={actionButton}
                  title={action.prompt || action.url || action.label}
                  onClick={() => onAction?.(surface, action)}
                >
                  {action.label}
                </button>
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
  const actionsById = new Map((surface.manifest.actions ?? []).map((action) => [action.id, action]));
  const visibleSteps = plan.steps.slice(0, 5);
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
                  <span>{request.envKey}</span>
                </div>
                <div style={credentialInputRow}>
                  <input
                    type="password"
                    autoComplete="off"
                    value={draftSecrets[request.id] ?? ""}
                    placeholder="Paste secret into vault"
                    style={credentialInput}
                    onChange={(event) =>
                      setDraftSecrets((prev) => ({ ...prev, [request.id]: event.currentTarget.value }))
                    }
                  />
                  <button type="button" style={compactActionButton} onClick={() => void saveCredential(request)}>
                    Save
                  </button>
                </div>
                {saveStatus[request.id] && <span style={delegationDetail}>{saveStatus[request.id]}</span>}
              </div>
            ))}
          </div>
        </>
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
  return surfaceId === "preview" || surfaceId.startsWith("surface-preview");
}

function paymentSummary(request: AgentlasSurfacePaymentRequest): string {
  const amount =
    request.quoteRequired === true
      ? "quoted at checkout"
      : `${request.currency ?? "?"} ${request.amount ?? "?"}`;
  return `${amount} · ${request.recurrence} · ${request.approvalMode}`;
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
  const { t } = useT();
  const lines = artifact.code.split("\n");
  const lineNumWidth = String(lines.length).length;
  return (
    <pre style={codePre}>
      {lines.map((line, i) => (
        <div key={i} style={codeLine}>
          <span style={{ ...lineNumber, minWidth: lineNumWidth * 9 }}>{i + 1}</span>
          <span style={{ whiteSpace: "pre", flex: 1 }}>{line || " "}</span>
        </div>
      ))}
      {lines.length === 0 && <div style={{ padding: 16 }}>{t("chatstream.lines", { count: 0 })}</div>}
    </pre>
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
        <video src={source} muted playsInline controls={false} style={assetImage} />
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

const surfaceBody: CSSProperties = {
  flex: 1,
  overflow: "auto",
  background: "var(--paper-2)",
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
  background: "#181713",
  color: "white",
  overflow: "hidden",
};

const appHeroBand: CSSProperties = {
  ...heroBand,
  background:
    "linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, #181713) 0%, #181713 58%, #0f172a 100%)",
};

const appHeroCopy: CSSProperties = {
  margin: "5px 0 0",
  fontSize: 12,
  color: "#d1d5db",
  lineHeight: 1.45,
  maxWidth: 480,
};

const genericHero: CSSProperties = {
  margin: 14,
  minHeight: 112,
  padding: 16,
  borderRadius: 8,
  background: "#181713",
  color: "white",
};

const eyebrowDark: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  color: "#a7f3d0",
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
  color: "#f8fafc",
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
  background: "linear-gradient(135deg, #1f2937, #111827)",
  color: "#e5e7eb",
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
  background: "linear-gradient(135deg, #f7f4ec, #ece7dc)",
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
  minHeight: 34,
  borderRadius: 8,
  border: "1px solid var(--accent-soft)",
  background: "var(--fill-1)",
  color: "var(--ink)",
  fontSize: 12,
  fontWeight: 800,
  textAlign: "left",
  padding: "7px 9px",
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
  if (tone === "risk") return { color: "var(--danger, #b4533a)" };
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
  color: "var(--danger, #b4533a)",
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

function delegationStatus(status: string): CSSProperties {
  if (status === "ready") return { color: "var(--green-deep)", fontWeight: 800 };
  if (status === "blocked-by-contract") return { color: "var(--danger, #b4533a)", fontWeight: 800 };
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

const codePre: CSSProperties = {
  flex: 1,
  margin: 0,
  padding: "16px 0",
  overflow: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: 1.6,
  color: "#fafafa",
  background: "#1c1a17",
};

const codeLine: CSSProperties = {
  display: "flex",
  gap: 16,
  padding: "0 16px",
};

const lineNumber: CSSProperties = {
  color: "#52525b",
  fontVariantNumeric: "tabular-nums",
  userSelect: "none",
  textAlign: "right",
};
