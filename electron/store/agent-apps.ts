// Agent-made service apps — durable registry for App Factory outputs.
// The generated files live on disk; this table makes them first-class OS assets
// that can survive chat reloads and accumulate launch-operation evidence.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
  AgentlasSurfaceManifest,
  AppFactoryAppRecord,
  AppFactoryAppStatus,
  AppFactoryCloudAppInstallResult,
  AppFactoryCloudAppManifestRequest,
  AppFactoryOperationKind,
  AppFactoryOperationRecord,
  AppFactoryScaffoldSnapshot,
  JsonObject,
  JsonValue,
} from "../../shared/types";
import { sanitizePublicAppCopy, sanitizePublicAppManifestCopy } from "../../shared/brand-safety";

const CLOUD_APP_ROOT_PREFIX = "agentlas-cloud://apps/";

interface AgentAppRow {
  id: string;
  chat_id: string;
  project_id: string | null;
  agent_id: string;
  surface_id: string;
  action_id: string | null;
  app_name: string;
  domain: string;
  layout: string;
  root_path: string;
  preview_path: string;
  setup_path: string;
  smoke_path: string;
  manifest_json: string;
  result_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface AgentAppOperationRow {
  id: string;
  app_id: string;
  operation: string;
  ok: number;
  result_json: string;
  created_at: string;
}

export function recordScaffoldedApp(input: {
  chatId: string;
  projectId?: string | null;
  agentId: string;
  surfaceId: string;
  actionId?: string | null;
  manifest: AgentlasSurfaceManifest;
  scaffold: AppFactoryScaffoldSnapshot;
}): AppFactoryAppRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  const manifest = sanitizePublicAppManifestCopy(input.manifest);
  const appName = sanitizePublicAppCopy(input.scaffold.appName, input.scaffold.appName);
  const scaffold = { ...input.scaffold, appName };
  db.prepare(
    `INSERT INTO agent_apps (
       id, chat_id, project_id, agent_id, surface_id, action_id, app_name,
       domain, layout, root_path, preview_path, setup_path, smoke_path,
       manifest_json, result_json, status, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scaffolded', ?, ?)
     ON CONFLICT(root_path) DO UPDATE SET
       chat_id = excluded.chat_id,
       project_id = excluded.project_id,
       agent_id = excluded.agent_id,
       surface_id = excluded.surface_id,
       action_id = excluded.action_id,
       app_name = excluded.app_name,
       domain = excluded.domain,
       layout = excluded.layout,
       preview_path = excluded.preview_path,
       setup_path = excluded.setup_path,
       smoke_path = excluded.smoke_path,
       manifest_json = excluded.manifest_json,
       result_json = excluded.result_json,
       status = 'scaffolded',
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.chatId,
    input.projectId ?? null,
    input.agentId,
    input.surfaceId,
    input.actionId ?? null,
    appName,
    manifest.domain,
    manifest.layout,
    scaffold.rootPath,
    scaffold.previewPath,
    scaffold.setupPath,
    scaffold.smokePath,
    encodeJson(manifest),
    encodeJson(scaffold),
    now,
    now,
  );

  const app = getAgentAppByRoot(input.scaffold.rootPath);
  if (!app) throw new Error(`Agent app registry write failed: ${input.scaffold.rootPath}`);
  recordAgentAppOperation(app.id, "scaffold", true, scaffold, "scaffolded");
  return getAgentApp(app.id) ?? app;
}

export function cloudAppRootPath(slugOrId: string): string {
  const slug = sanitizeCloudSlug(slugOrId);
  return `${CLOUD_APP_ROOT_PREFIX}${slug}`;
}

export function isCloudAppRoot(rootPath: string): boolean {
  return rootPath.startsWith(CLOUD_APP_ROOT_PREFIX);
}

export function recordCloudAppManifest(
  input: AppFactoryCloudAppManifestRequest & {
    chatId: string;
    agentId: string;
  },
): AppFactoryCloudAppInstallResult {
  const existingRoot = cloudAppRootPath(input.slug || input.cloudId);
  const existing = getAgentAppByRoot(existingRoot);
  const id = randomUUID();
  const now = new Date().toISOString();
  const manifest = sanitizePublicAppManifestCopy(input.manifest);
  const appName = sanitizePublicAppCopy(
    manifest.app?.name || manifest.title || input.slug,
    input.slug || "Cloud App",
  );
  const version = String(input.version || "0.0.0");
  const runtimeEngine = String(input.runtimeEngine || "generated-app");
  const launchUrl = sanitizeLaunchUrl(input.launchUrl || stringFromMetadata(input.metadata, "launchUrl"));
  const localPort = launchUrl ? localPortFromLaunchUrl(launchUrl) : null;
  const status: AppFactoryAppStatus = existing ? "cloud-synced" : "cloud-installed";
  const operation: AppFactoryOperationKind = existing ? "sync-cloud-manifest" : "install-cloud-app";
  const cloudSnapshot = {
    appId: input.cloudId,
    appName,
    rootPath: existingRoot,
    previewPath: `/apps/generated?id=${existing?.id ?? id}`,
    setupPath: input.sourceUrl || "",
    smokePath: "",
    runtimeMode: "cloud-manifest",
    launchUrl: launchUrl ?? input.sourceUrl ?? "",
    devCommand: input.devCommand || stringFromMetadata(input.metadata, "devCommand") || "",
    localPort: localPort ?? undefined,
    createdAt: input.publishedAt || input.updatedAt || now,
    files: [
      {
        path: `${sanitizeCloudSlug(input.slug || input.cloudId)}.manifest.json`,
        kind: "config",
        bytes: JSON.stringify(manifest).length,
      },
    ],
    summary: `Cloud App ${input.slug}@${version} runs on the ${runtimeEngine} Desktop engine.`,
    cloudId: input.cloudId,
    slug: input.slug,
    version,
    runtimeEngine,
    minDesktopVersion: input.minDesktopVersion ?? null,
    sourceUrl: input.sourceUrl ?? null,
    fileCount: input.fileCount ?? 1,
    publishedAt: input.publishedAt ?? null,
    updatedAt: input.updatedAt ?? now,
    metadata: (input.metadata ?? {}) as JsonObject,
  };

  getDb()
    .prepare(
      `INSERT INTO agent_apps (
         id, chat_id, project_id, agent_id, surface_id, action_id, app_name,
         domain, layout, root_path, preview_path, setup_path, smoke_path,
         manifest_json, result_json, status, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_path) DO UPDATE SET
         chat_id = excluded.chat_id,
         project_id = excluded.project_id,
         agent_id = excluded.agent_id,
         surface_id = excluded.surface_id,
         action_id = excluded.action_id,
         app_name = excluded.app_name,
         domain = excluded.domain,
         layout = excluded.layout,
         preview_path = excluded.preview_path,
         setup_path = excluded.setup_path,
         smoke_path = excluded.smoke_path,
         manifest_json = excluded.manifest_json,
         result_json = excluded.result_json,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.chatId,
      input.projectId ?? null,
      input.agentId,
      input.surfaceId || `cloud:${sanitizeCloudSlug(input.slug || input.cloudId)}`,
      input.actionId ?? null,
      appName,
      manifest.domain,
      manifest.layout,
      existingRoot,
      cloudSnapshot.previewPath,
      cloudSnapshot.setupPath,
      cloudSnapshot.smokePath,
      encodeJson(manifest),
      encodeJson(cloudSnapshot),
      status,
      now,
      now,
    );

  const app = getAgentAppByRoot(existingRoot);
  if (!app) throw new Error(`Cloud app registry write failed: ${existingRoot}`);
  const op = recordAgentAppOperation(app.id, operation, true, cloudSnapshot, status);
  return {
    app: getAgentApp(app.id) ?? app,
    operation: op,
    rootPath: existingRoot,
    installed: !existing,
  };
}

export function recordAgentAppOperation(
  appId: string,
  operation: AppFactoryOperationKind,
  ok: boolean,
  result: unknown,
  status?: AppFactoryAppStatus,
): AppFactoryOperationRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_app_operations (id, app_id, operation, ok, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, appId, operation, ok ? 1 : 0, encodeJson(result), now);
  if (status) {
    db.prepare("UPDATE agent_apps SET status = ?, updated_at = ? WHERE id = ?").run(
      status,
      now,
      appId,
    );
  }
  const row = db
    .prepare("SELECT * FROM agent_app_operations WHERE id = ?")
    .get(id) as AgentAppOperationRow | undefined;
  if (!row) throw new Error(`Agent app operation write failed: ${operation}`);
  return toOperation(row);
}

export function listAgentApps(chatId?: string): AppFactoryAppRecord[] {
  const rows = chatId
    ? (getDb()
        .prepare("SELECT * FROM agent_apps WHERE chat_id = ? ORDER BY updated_at DESC")
        .all(chatId) as AgentAppRow[])
    : (getDb()
        .prepare("SELECT * FROM agent_apps ORDER BY updated_at DESC")
        .all() as AgentAppRow[]);
  return rows.map(toApp);
}

export function getAgentApp(id: string): AppFactoryAppRecord | null {
  const row = getDb().prepare("SELECT * FROM agent_apps WHERE id = ?").get(id) as
    | AgentAppRow
    | undefined;
  return row ? toApp(row) : null;
}

export function getAgentAppByRoot(rootPath: string): AppFactoryAppRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_apps WHERE root_path = ?")
    .get(rootPath) as AgentAppRow | undefined;
  return row ? toApp(row) : null;
}

export function getAgentAppBySurface(
  chatId: string,
  surfaceId: string,
): AppFactoryAppRecord | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM agent_apps WHERE chat_id = ? AND surface_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(chatId, surfaceId) as AgentAppRow | undefined;
  return row ? toApp(row) : null;
}

/** Remove one local AppFactory registration; operation rows cascade with it. */
export function removeAgentApp(id: string): boolean {
  return getDb().prepare("DELETE FROM agent_apps WHERE id = ?").run(id).changes > 0;
}

export function listAgentAppOperations(appId: string): AppFactoryOperationRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_app_operations WHERE app_id = ? ORDER BY created_at DESC")
    .all(appId) as AgentAppOperationRow[];
  return rows.map(toOperation);
}

function toApp(row: AgentAppRow): AppFactoryAppRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    actionId: row.action_id,
    appName: row.app_name,
    domain: row.domain,
    layout: row.layout,
    rootPath: row.root_path,
    previewPath: row.preview_path,
    setupPath: row.setup_path,
    smokePath: row.smoke_path,
    manifest: decodeJson(row.manifest_json, fallbackManifest(row)) as AgentlasSurfaceManifest,
    scaffold: decodeJson(row.result_json, fallbackScaffold(row)) as unknown as AppFactoryScaffoldSnapshot,
    status: isAppStatus(row.status) ? row.status : "scaffolded",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOperation(row: AgentAppOperationRow): AppFactoryOperationRecord {
  return {
    id: row.id,
    appId: row.app_id,
    operation: isOperationKind(row.operation) ? row.operation : "scaffold",
    ok: !!row.ok,
    result: decodeJson(row.result_json, null),
    createdAt: row.created_at,
  };
}

function encodeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) return "null";
  return serialized;
}

function decodeJson(raw: string, fallback: JsonValue | AgentlasSurfaceManifest | AppFactoryScaffoldSnapshot): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return fallback as JsonValue;
  }
}

function fallbackManifest(row: AgentAppRow): AgentlasSurfaceManifest {
  return {
    version: "0.1",
    kind: "surface",
    title: row.app_name,
    domain: row.domain,
    layout: row.layout,
    data: {},
    widgets: [],
  };
}

function fallbackScaffold(row: AgentAppRow): AppFactoryScaffoldSnapshot {
  return {
    appId: row.id,
    appName: row.app_name,
    rootPath: row.root_path,
    previewPath: row.preview_path,
    setupPath: row.setup_path,
    smokePath: row.smoke_path,
    createdAt: row.created_at,
    files: [],
    summary: "Recovered from Agentlas app registry.",
  };
}

function isAppStatus(value: string): value is AppFactoryAppStatus {
  return (
    value === "scaffolded" ||
    value === "cloud-installed" ||
    value === "cloud-synced" ||
    value === "mcp-ready" ||
    value === "operations-ready" ||
    value === "smoke-passed" ||
    value === "smoke-failed" ||
    value === "preview-ready" ||
    value === "tool-published" ||
    value === "restored" ||
    value === "archived"
  );
}

function isOperationKind(value: string): value is AppFactoryOperationKind {
  return (
    value === "scaffold" ||
    value === "install-cloud-app" ||
    value === "sync-cloud-manifest" ||
    value === "open-launch-target" ||
    value === "run-autopilot" ||
    value === "install-mcp" ||
    value === "run-provider-tasks" ||
    value === "materialize-assets" ||
    value === "activate-local-commerce-stack" ||
    value === "capture-provider-browser-sessions" ||
    value === "launch-provider-session" ||
    value === "sync-provider-browser-results" ||
    value === "resolve-provider-credentials" ||
    value === "approve-provider-payment" ||
    value === "open-provider-browser" ||
    value === "run-smoke-test" ||
    value === "deploy-preview" ||
    value === "publish-as-tool" ||
    value === "archive" ||
    value === "restore"
  );
}

function sanitizeCloudSlug(value: string): string {
  const trimmed = String(value || "").trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "cloud-app";
}

function sanitizeLaunchUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function localPortFromLaunchUrl(value: string): number | null {
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

function stringFromMetadata(metadata: unknown, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
