// Main-owned Site project deletion lifecycle.
//
// Local deletion never calls a hosting-provider delete API. When a durable
// remote receipt exists, the caller must first acknowledge that the provider
// resource will remain and must be removed manually in that provider.
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SiteDeleteProjectResult,
  SiteProjectMeta,
  SiteRemoteDeploymentRetention,
} from "../../shared/site-studio";
import { getAgentApp, listAgentApps, removeAgentApp } from "../store/agent-apps";
import { getChat, removeChat } from "../store/chats";
import { getDb } from "../store/db";
import { stopSiteAgentApp } from "./agent-app-runtime";
import { deleteSiteProject, getSiteProject, siteAgentAppsRoot } from "./store";
import { currentUiLocale } from "../ui-locale";

const uiText = (ko: string, en: string): string => (currentUiLocale() === "ko" ? ko : en);

const PROVIDER_DASHBOARDS = {
  vercel: "https://vercel.com/dashboard",
  railway: "https://railway.com/dashboard",
  render: "https://dashboard.render.com/",
} as const;

type SiteDeletionPlan = {
  project: SiteProjectMeta;
  remoteDeploymentsRetained: SiteRemoteDeploymentRetention[];
};

type SessionRow = { id: string; title: string };

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function retainedRemoteDeployments(project: SiteProjectMeta): SiteRemoteDeploymentRetention[] {
  const latestByDeployment = new Map<string, NonNullable<SiteProjectMeta["agentAppDeployments"]>[number]>();
  for (const record of project.agentAppDeployments ?? []) latestByDeployment.set(record.deploymentId, record);
  const retained: SiteRemoteDeploymentRetention[] = [];
  for (const receipt of [...latestByDeployment.values()].reverse()) {
    if (!receipt.url && !receipt.providerProjectId && !receipt.providerServiceId && !receipt.providerServiceName) continue;
    const identity = [
      receipt.providerProjectId ? `ID ${receipt.providerProjectId}` : null,
      receipt.providerServiceId ? `Service ID ${receipt.providerServiceId}` : null,
      receipt.providerServiceName ? `Service ${receipt.providerServiceName}` : null,
      receipt.url,
    ].filter(Boolean).join(" · ");
    const secretWarning = receipt.transferredSecrets.length
      ? uiText(` Provider secret storage에 ${receipt.transferredSecrets.join(", ")}가 남아 있을 수 있습니다.`, ` ${receipt.transferredSecrets.join(", ")} may still be stored in the provider's secret storage.`)
      : uiText(" Agentlas가 이 배포에 LLM/app secret을 전송한 기록은 없습니다.", " Agentlas has no record of sending LLM or app secrets to this deployment.");
    retained.push({
      deploymentId: receipt.deploymentId,
      provider: receipt.provider,
      status: receipt.status,
      url: receipt.url,
      providerProjectId: receipt.providerProjectId,
      providerServiceId: receipt.providerServiceId,
      providerServiceName: receipt.providerServiceName,
      transferredSecrets: [...receipt.transferredSecrets],
      dashboardUrl: PROVIDER_DASHBOARDS[receipt.provider],
      message: uiText(`로컬 Site 프로젝트를 삭제해도 ${receipt.provider} 원격 resource(${identity})는 삭제되지 않습니다.${secretWarning} Provider dashboard에서 사용자가 직접 확인하고 삭제해야 합니다.`, `Deleting the local Site project does not delete the ${receipt.provider} remote resource (${identity}).${secretWarning} Check and delete it yourself in the provider dashboard.`),
    });
  }
  return retained;
}

export function inspectSiteProjectDeletion(projectId: string): SiteDeletionPlan {
  const project = getSiteProject(projectId);
  return { project, remoteDeploymentsRetained: retainedRemoteDeployments(project) };
}

function siteSessionRows(projectId: string): SessionRow[] {
  const siteMarker = `⟦site⟧${projectId}`;
  const appMarker = `⟦automation⟧site-agent-app:${projectId}`;
  return getDb()
    .prepare(
      `SELECT id, title FROM chats
       WHERE kind = 'division'
         AND (title = ? OR title = ? OR title LIKE ?)`,
    )
    .all(siteMarker, appMarker, `${appMarker}::target:%`) as SessionRow[];
}

async function assertSafeArtifactBinding(project: SiteProjectMeta): Promise<{
  rootPath: string | null;
  appRecordId: string | null;
  sessionRows: SessionRow[];
}> {
  const artifact = project.agentAppArtifact;
  const sessions = siteSessionRows(project.id);
  const expectedSurface = `site:${project.id}`;
  const surfaceApps = listAgentApps().filter((app) => app.surfaceId === expectedSurface);
  for (const session of sessions) {
    const foreignApp = listAgentApps(session.id).find((app) => app.surfaceId !== expectedSurface);
    if (foreignApp) {
      throw new Error(uiText("Site 전용 hidden session에 다른 AppFactory asset이 연결되어 있어 삭제를 중단했습니다.", "Deletion stopped: another AppFactory asset is linked to this Site's hidden session."));
    }
  }
  if (!artifact) {
    if (surfaceApps.length > 0) {
      throw new Error(uiText("Site metadata에는 artifact가 없지만 AppFactory 등록이 남아 있어 삭제를 중단했습니다.", "Deletion stopped: the Site has no artifact, but an AppFactory registration remains."));
    }
    return { rootPath: null, appRecordId: null, sessionRows: sessions };
  }
  if (surfaceApps.length !== 1 || surfaceApps[0].id !== artifact.appRecordId) {
    throw new Error(uiText("Site 프로젝트의 AppFactory surface binding이 유일하지 않아 삭제를 중단했습니다.", "Deletion stopped: the Site project's AppFactory surface binding is not unique."));
  }

  const allowedRoot = path.resolve(siteAgentAppsRoot());
  const rootPath = path.resolve(artifact.rootPath);
  if (!isInside(allowedRoot, rootPath)) throw new Error(uiText("Agent App artifact가 Site 전용 root 밖을 가리켜 삭제를 중단했습니다.", "Deletion stopped: the Agent App artifact points outside the Site folder."));
  let rootExists = false;
  try {
    const [allowedRootStat, lexicalStat] = await Promise.all([
      fs.lstat(allowedRoot),
      fs.lstat(rootPath),
    ]);
    if (!allowedRootStat.isDirectory() || allowedRootStat.isSymbolicLink()) {
      throw new Error(uiText("Site 전용 Agent App root가 안전한 directory가 아닙니다.", "The Site's Agent App folder is not a safe directory."));
    }
    if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) {
      throw new Error(uiText("Agent App artifact root가 안전한 directory가 아닙니다.", "The Agent App artifact folder is not a safe directory."));
    }
    const [canonicalAllowedRoot, canonicalRoot] = await Promise.all([
      fs.realpath(allowedRoot),
      fs.realpath(rootPath),
    ]);
    // macOS commonly exposes /var through the canonical /private/var path.
    // Compare both sides canonically, while the lstat above still rejects an
    // artifact root that is itself a symlink.
    if (!isInside(canonicalAllowedRoot, canonicalRoot)) {
      throw new Error(uiText("Agent App artifact canonical path가 Site 전용 root와 일치하지 않습니다.", "The Agent App artifact path does not match the Site folder."));
    }
    rootExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const record = getAgentApp(artifact.appRecordId);
  if (!record) {
    if (rootExists) throw new Error(uiText("Agent App artifact registry binding이 없어 로컬 파일 삭제를 중단했습니다.", "Local file deletion stopped: the Agent App artifact has no registry binding."));
    return { rootPath, appRecordId: null, sessionRows: sessions };
  }
  if (
    record.id !== artifact.appRecordId ||
    record.surfaceId !== expectedSurface ||
    path.resolve(record.rootPath) !== rootPath ||
    record.scaffold.appId !== artifact.appId
  ) throw new Error(uiText("Site 프로젝트와 AppFactory registry binding이 일치하지 않아 삭제를 중단했습니다.", "Deletion stopped: the Site project and its AppFactory registry binding do not match."));

  if (!sessions.some((session) => session.id === record.chatId)) {
    const chat = getChat(record.chatId);
    if (chat) throw new Error(uiText("Agent App registry chat이 Site 전용 hidden session이 아니어서 삭제를 중단했습니다.", "Deletion stopped: the Agent App registry chat is not this Site's hidden session."));
  }
  return { rootPath, appRecordId: record.id, sessionRows: sessions };
}

export async function deleteSiteProjectWithAssets(
  projectId: string,
  options: { acknowledgeRemoteRetained?: boolean } = {},
): Promise<SiteDeleteProjectResult> {
  const plan = inspectSiteProjectDeletion(projectId);
  const latestRemote = plan.remoteDeploymentsRetained[0] ?? null;
  if (plan.remoteDeploymentsRetained.length > 0 && !options.acknowledgeRemoteRetained) {
    const providers = [...new Set(plan.remoteDeploymentsRetained.map((remote) => remote.provider))].join(", ");
    return {
      ok: false,
      code: "remote-deployment-acknowledgement-required",
      message: uiText(`${plan.remoteDeploymentsRetained.length}개의 원격 resource(${providers})는 로컬 삭제로 제거되지 않습니다. 각 provider dashboard에서 ID/URL과 남은 secret을 확인해 직접 삭제해야 합니다.`, `${plan.remoteDeploymentsRetained.length} remote resource(s) (${providers}) are not removed by deleting locally. Check the ID/URL and any remaining secrets in each provider dashboard and delete them yourself.`),
      remoteDeploymentRetained: latestRemote,
      remoteDeploymentsRetained: plan.remoteDeploymentsRetained,
    };
  }

  const binding = await assertSafeArtifactBinding(plan.project);
  await stopSiteAgentApp(projectId);
  let artifactRemoved = false;
  if (binding.rootPath) {
    await fs.rm(binding.rootPath, { recursive: true, force: true });
    artifactRemoved = true;
  }

  let hiddenSessionsRemoved = 0;
  for (const session of binding.sessionRows) {
    removeChat(session.id);
    if (!getChat(session.id)) hiddenSessionsRemoved += 1;
  }
  let appRegistrationRemoved = false;
  if (binding.appRecordId) {
    if (getAgentApp(binding.appRecordId)) removeAgentApp(binding.appRecordId);
    appRegistrationRemoved = !getAgentApp(binding.appRecordId);
  }
  deleteSiteProject(projectId);
  return {
    ok: true,
    message: plan.remoteDeploymentsRetained.length > 0
      ? uiText(`로컬 Site 프로젝트를 삭제했습니다. ${plan.remoteDeploymentsRetained.length}개의 원격 resource는 유지되며 각 provider dashboard에서 직접 삭제해야 합니다.`, `Deleted the local Site project. ${plan.remoteDeploymentsRetained.length} remote resource(s) remain; delete them in each provider dashboard.`)
      : uiText("로컬 Site 프로젝트와 생성된 Agent App asset을 삭제했습니다.", "Deleted the local Site project and its generated Agent App assets."),
    remoteDeploymentRetained: latestRemote,
    remoteDeploymentsRetained: plan.remoteDeploymentsRetained,
    localCleanup: {
      artifactRemoved,
      appRegistrationRemoved,
      hiddenSessionsRemoved,
    },
  };
}
