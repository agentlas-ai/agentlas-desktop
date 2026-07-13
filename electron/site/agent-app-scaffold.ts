import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppFactoryScaffoldResult } from "../../shared/types";
import type { SiteAgentAppArtifact } from "../../shared/site-studio";
import { scaffoldServiceApp } from "../app-factory/scaffold";
import { recordScaffoldedApp } from "../store/agent-apps";
import { getOrCreateAutomationSession, setChatWorkingFolder } from "../store/chats";
import { siteAgentAppContextFromProject } from "./agent-app";
import { buildSiteAgentApp, captureSiteAgentAppThumbnail } from "./agent-app-thumbnail";
import { extractSiteAgentAppVisual } from "./agent-app-visual";
import {
  getSiteProject,
  readSiteScreenHtml,
  siteAgentAppsRoot,
  updateSiteAgentAppArtifact,
  updateSiteAgentAppVisual,
} from "./store";

function developmentPort(projectId: string): number {
  const hash = createHash("sha256").update(projectId).digest().readUInt32BE(0);
  return 40_000 + (hash % 10_000);
}

/**
 * Materialize the real React 19 + Astryx companion for an Agent App project.
 * The external app is target-bound but deliberately contains no system prompt,
 * secret, memory, or fake runtime endpoint.
 */
export async function scaffoldSiteAgentApp(projectId: string, screenId: string): Promise<AppFactoryScaffoldResult> {
  let project = getSiteProject(projectId);
  if (project.surface !== "agent-app" || !project.agentAppTarget) {
    throw new Error("Agent App 프로젝트만 Astryx 앱으로 만들 수 있습니다.");
  }

  // Never rewrite dist/source underneath an already-open capability runtime.
  const { stopSiteAgentApp } = await import("./agent-app-runtime");
  await stopSiteAgentApp(projectId);

  // The exact accepted screen is main-owned. Only its strict visual snapshot is
  // persisted; preview HTML/CSS/scripts never enter the generated source tree.
  const visual = extractSiteAgentAppVisual(readSiteScreenHtml(projectId, screenId));
  project = updateSiteAgentAppVisual(projectId, visual);

  const context = siteAgentAppContextFromProject(project);
  context.manifest.designSystem = {
    ...(context.manifest.designSystem && typeof context.manifest.designSystem === "object" ? context.manifest.designSystem : {}),
    sourceScreenId: screenId,
  };
  const target = context.target;
  const chat = getOrCreateAutomationSession({
    automationId: `site-agent-app:${project.id}`,
    agentId: target.kind === "agent" || target.kind === "team" ? target.id : undefined,
    firmId: target.kind === "firm" ? target.id : null,
    agentGroupId: target.kind === "group" ? target.id : null,
  });
  const request = {
    chatId: chat.id,
    surfaceId: `site:${project.id}`,
    manifest: context.manifest,
  };
  const result = await scaffoldServiceApp(request, {
    baseDir: siteAgentAppsRoot(),
    directChild: true,
    localPort: developmentPort(project.id),
  });
  const runtimeWorkspace = path.join(result.rootPath, "runtime", "workspace");
  await fs.mkdir(runtimeWorkspace, { recursive: true, mode: 0o700 });
  setChatWorkingFolder(chat.id, runtimeWorkspace);
  const record = recordScaffoldedApp({
    chatId: chat.id,
    projectId: null,
    agentId: chat.agentId,
    surfaceId: request.surfaceId,
    manifest: request.manifest,
    scaffold: result,
  });
  const now = new Date().toISOString();
  const createdAt = project.agentAppArtifact?.createdAt ?? now;
  const baseArtifact: SiteAgentAppArtifact = {
    schemaVersion: 1,
    appRecordId: record.id,
    appId: result.appId,
    appName: target.name,
    rootPath: result.rootPath,
    sourceScreenId: screenId,
    status: "building",
    launchUrl: null,
    thumbnail: null,
    // A source rebuild is a new release candidate. A previous provider receipt
    // still exists remotely, but it must not be presented as this new artifact.
    publish: null,
    createdAt,
    updatedAt: now,
    failureReason: null,
  };
  updateSiteAgentAppArtifact(project.id, baseArtifact);
  try {
    const distRoot = await buildSiteAgentApp(result.rootPath);
    const thumbnailPath = await captureSiteAgentAppThumbnail(result.rootPath, distRoot);
    updateSiteAgentAppArtifact(project.id, {
      ...baseArtifact,
      status: "ready",
      thumbnail: {
        path: thumbnailPath,
        width: 1_280,
        height: 720,
        updatedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateSiteAgentAppArtifact(project.id, {
      ...baseArtifact,
      status: "failed",
      updatedAt: new Date().toISOString(),
      failureReason: reason,
    });
    throw new Error(`Astryx production build or thumbnail capture failed: ${reason}`);
  }
  return { ...result, appName: target.name, record };
}
