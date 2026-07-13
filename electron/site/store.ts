// Site design studio — project/screen persistence.
//
// Layout on disk (all under userData, same convention as trex-images /
// oberon-motion):
//   <userData>/site-projects/<projectId>/project.json
//   <userData>/site-projects/<projectId>/screens/<screenId>.html
// project.json is the source of truth for screen metadata; screen HTML lives
// as plain files so users can inspect/export them directly.
import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  SiteAgentAppArtifact,
  SiteAgentAppContractSnapshot,
  SiteAgentAppDeploymentRecord,
  SiteAgentAppMcpConsentReceipt,
  SiteAgentAppPublishRecord,
  SiteAgentAppTarget,
  SiteAgentAppVisualSnapshot,
  SiteAstryxTemplate,
  SiteConversationEntry,
  SiteProjectMeta,
  SiteProjectPublicMeta,
  SiteScreenMeta,
  SiteSurface,
} from "../../shared/site-studio";
import { normalizeSiteAgentAppContract } from "./agent-app-contract";
import { normalizeSiteAgentAppMcpConsentReceipt } from "./agent-app-mcp-consent";
import { defaultSiteAgentAppVisual, normalizeSiteAgentAppVisual } from "./agent-app-visual";

function projectsRoot(): string {
  return path.join(app.getPath("userData"), "site-projects");
}

export function siteAgentAppsRoot(): string {
  return path.join(app.getPath("home"), ".agentlas", "site", "agentapp");
}

function projectDir(projectId: string): string {
  return path.join(projectsRoot(), projectId);
}

function screensDir(projectId: string): string {
  return path.join(projectDir(projectId), "screens");
}

function projectMetaPath(projectId: string): string {
  return path.join(projectDir(projectId), "project.json");
}

function conversationPath(projectId: string): string {
  return path.join(projectDir(safeId(projectId)), "conversation.json");
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error(`잘못된 id: ${id}`);
  }
  return id;
}

function screenFilePath(projectId: string, screenId: string): string {
  return path.join(screensDir(safeId(projectId)), `${safeId(screenId)}.html`);
}

function readProjectMeta(projectId: string): SiteProjectMeta | null {
  try {
    const raw = fs.readFileSync(projectMetaPath(projectId), "utf8");
    const parsed = JSON.parse(raw) as SiteProjectMeta;
    if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.screens)) return null;
    const surface: SiteSurface =
      parsed.surface === "mobile" || parsed.surface === "agent-app" ? parsed.surface : "web";
    const agentAppTarget = normalizeAgentAppTarget(parsed.agentAppTarget);
    const agentAppContract = normalizeSiteAgentAppContract(
      parsed.agentAppContract,
      (parsed.agentAppContract as SiteAgentAppContractSnapshot | null)?.source === "declared-package" ||
      (parsed.agentAppContract as SiteAgentAppContractSnapshot | null)?.source === "declared-routing-card" ||
      (parsed.agentAppContract as SiteAgentAppContractSnapshot | null)?.source === "composed-target"
        ? (parsed.agentAppContract as SiteAgentAppContractSnapshot).source
        : "inferred-fallback",
    );
    const agentAppMcpConsent = surface === "agent-app"
      ? normalizeSiteAgentAppMcpConsentReceipt(parsed.agentAppMcpConsent)
      : null;
    const astryxTemplate: SiteAstryxTemplate | null =
      parsed.astryxTemplate === "ai-chat" ||
      parsed.astryxTemplate === "ai-chat-landing" ||
      parsed.astryxTemplate === "form-two-column"
        ? parsed.astryxTemplate
        : null;
    const normalizedArtifact = surface === "agent-app"
      ? normalizeSiteAgentAppArtifact(parsed.agentAppArtifact)
      : null;
    const agentAppDeployments = surface === "agent-app"
      ? normalizedDeploymentLedger(parsed.agentAppDeployments, parsed.id, normalizedArtifact)
      : [];
    const publishBinding = normalizedArtifact?.publish
      ? normalizedArtifact.publishBinding ?? null
      : null;
    const boundDeployment = normalizedArtifact && publishBinding
      ? [...agentAppDeployments].reverse().find((record) =>
          record.deploymentId === publishBinding.deploymentId &&
          record.artifactAppRecordId === normalizedArtifact.appRecordId &&
          record.artifactDigest === publishBinding.artifactDigest &&
          record.intentDigest === publishBinding.intentDigest &&
          record.provider === normalizedArtifact.publish?.provider &&
          record.status === normalizedArtifact.publish.status &&
          record.providerProjectId === normalizedArtifact.publish.providerProjectId &&
          record.url === normalizedArtifact.publish.url,
        ) ?? null
      : null;
    // Backward compatibility only: old project files had a single artifact-
    // embedded receipt and no binding. Once a rebuild writes publish:null,
    // this fallback cannot revive a historical remote as the current app.
    const legacyDeployment = normalizedArtifact?.publish && !publishBinding
      ? [...agentAppDeployments].reverse().find((record) =>
          record.artifactAppRecordId === normalizedArtifact.appRecordId &&
          record.provider === normalizedArtifact.publish?.provider &&
          record.status === normalizedArtifact.publish.status &&
          record.providerProjectId === normalizedArtifact.publish.providerProjectId &&
          record.url === normalizedArtifact.publish.url,
        ) ?? null
      : null;
    const projectedDeployment = boundDeployment ?? legacyDeployment;
    const agentAppArtifact = normalizedArtifact
      ? {
          ...normalizedArtifact,
          publish: projectedDeployment ? publishRecordFromDeployment(projectedDeployment) : null,
        }
      : null;
    return {
      ...parsed,
      surface,
      agentAppTarget: surface === "agent-app" ? agentAppTarget : null,
      astryxTemplate: surface === "agent-app" ? astryxTemplate : null,
      agentAppContract: surface === "agent-app" ? agentAppContract : null,
      agentAppMcpConsent,
      agentAppVisual: surface === "agent-app" && agentAppTarget
        ? normalizeSiteAgentAppVisual(parsed.agentAppVisual) ?? defaultSiteAgentAppVisual(agentAppTarget)
        : null,
      agentAppArtifact,
      agentAppDeployments,
    };
  } catch {
    return null;
  }
}

function normalizedPublishRecord(value: unknown): SiteAgentAppPublishRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SiteAgentAppPublishRecord>;
  if (raw.provider !== "vercel" && raw.provider !== "railway" && raw.provider !== "render") return null;
  if (
    raw.status !== "published" &&
    raw.status !== "provisioning" &&
    raw.status !== "configuration-required" &&
    raw.status !== "verification-required" &&
    raw.status !== "failed"
  ) return null;
  if (raw.llmProvider !== "openai" && raw.llmProvider !== "anthropic" && raw.llmProvider !== "google") return null;
  const url = typeof raw.url === "string" && /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(raw.url)
    ? raw.url.slice(0, 2_048)
    : null;
  return {
    provider: raw.provider,
    status: raw.status,
    url,
    providerProjectId: typeof raw.providerProjectId === "string" ? raw.providerProjectId.slice(0, 200) : null,
    publishedAt: typeof raw.publishedAt === "string" ? raw.publishedAt : new Date(0).toISOString(),
    llmProvider: raw.llmProvider,
    reason: typeof raw.reason === "string" ? raw.reason.slice(0, 1_000) : null,
  };
}

function deploymentPhase(value: unknown): SiteAgentAppDeploymentRecord["phase"] | null {
  return value === "mutation-attempted" ||
    value === "resource-created" ||
    value === "service-created" ||
    value === "secret-transfer-attempted" ||
    value === "secret-transferred" ||
    value === "verification-required" ||
    value === "configuration-required" ||
    value === "published" ||
    value === "failed"
    ? value
    : null;
}

function publishRecordFromDeployment(record: SiteAgentAppDeploymentRecord): SiteAgentAppPublishRecord {
  return {
    provider: record.provider,
    status: record.status,
    url: record.url,
    providerProjectId: record.providerProjectId,
    publishedAt: record.publishedAt,
    llmProvider: record.llmProvider,
    reason: record.reason,
  };
}

function normalizeDeploymentRecord(value: unknown): SiteAgentAppDeploymentRecord | null {
  const publish = normalizedPublishRecord(value);
  if (!publish || !value || typeof value !== "object") return null;
  const raw = value as Partial<SiteAgentAppDeploymentRecord>;
  const phase = deploymentPhase(raw.phase);
  if (
    !phase ||
    typeof raw.ledgerEntryId !== "string" || !raw.ledgerEntryId.trim() ||
    typeof raw.deploymentId !== "string" || !raw.deploymentId.trim() ||
    typeof raw.artifactAppRecordId !== "string"
  ) return null;
  const normalizedDigest = (candidate: unknown) =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null;
  const transferredSecrets = Array.isArray(raw.transferredSecrets)
    ? [...new Set(raw.transferredSecrets
        .filter((item): item is string => typeof item === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(item)))]
    : [];
  return {
    ...publish,
    ledgerEntryId: raw.ledgerEntryId.trim().slice(0, 200),
    deploymentId: raw.deploymentId.trim().slice(0, 200),
    phase,
    recordedAt: typeof raw.recordedAt === "string" && Number.isFinite(Date.parse(raw.recordedAt))
      ? raw.recordedAt
      : publish.publishedAt,
    artifactAppRecordId: raw.artifactAppRecordId.slice(0, 160),
    artifactDigest: normalizedDigest(raw.artifactDigest),
    intentDigest: normalizedDigest(raw.intentDigest),
    providerAccountLabel: typeof raw.providerAccountLabel === "string" ? raw.providerAccountLabel.slice(0, 160) : null,
    providerAccountScope: typeof raw.providerAccountScope === "string" ? raw.providerAccountScope.slice(0, 200) : null,
    providerServiceId: typeof raw.providerServiceId === "string" ? raw.providerServiceId.slice(0, 200) : null,
    providerServiceName: typeof raw.providerServiceName === "string" ? raw.providerServiceName.slice(0, 160) : null,
    transferredSecrets,
    appAccessKeyFingerprint: normalizedDigest(raw.appAccessKeyFingerprint),
  };
}

function legacyDeploymentRecord(
  projectId: string,
  artifact: SiteAgentAppArtifact,
  publish: SiteAgentAppPublishRecord,
): SiteAgentAppDeploymentRecord {
  const identity = `${publish.provider}:${publish.providerProjectId ?? publish.url ?? publish.publishedAt}`
    .replace(/[^A-Za-z0-9:._-]+/g, "-")
    .slice(0, 140);
  const phase: SiteAgentAppDeploymentRecord["phase"] = publish.status === "published"
    ? "published"
    : publish.status === "configuration-required"
      ? "configuration-required"
      : publish.status === "verification-required"
        ? "verification-required"
        : "failed";
  const llmSecret = publish.llmProvider === "openai"
    ? "OPENAI_API_KEY"
    : publish.llmProvider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : "GEMINI_API_KEY";
  const transferredSecrets = (publish.provider === "vercel" || publish.provider === "railway") &&
    (publish.status === "published" || publish.status === "verification-required")
    ? ["AGENTLAS_APP_ACCESS_KEY", llmSecret]
    : [];
  return {
    ...publish,
    ledgerEntryId: `legacy-entry:${projectId}:${identity}`.slice(0, 200),
    deploymentId: `legacy-deployment:${projectId}:${identity}`.slice(0, 200),
    phase,
    recordedAt: publish.publishedAt,
    artifactAppRecordId: artifact.appRecordId,
    artifactDigest: null,
    intentDigest: null,
    providerAccountLabel: null,
    providerAccountScope: null,
    providerServiceId: null,
    providerServiceName: null,
    transferredSecrets,
    appAccessKeyFingerprint: null,
  };
}

function normalizedDeploymentLedger(
  value: unknown,
  projectId: string,
  artifact: SiteAgentAppArtifact | null,
): SiteAgentAppDeploymentRecord[] {
  const entries = Array.isArray(value)
    ? value.map(normalizeDeploymentRecord).filter((entry): entry is SiteAgentAppDeploymentRecord => Boolean(entry))
    : [];
  const seen = new Set<string>();
  const ledger = entries.filter((entry) => {
    if (seen.has(entry.ledgerEntryId)) return false;
    seen.add(entry.ledgerEntryId);
    return true;
  });
  if (artifact?.publish && ledger.length === 0) ledger.push(legacyDeploymentRecord(projectId, artifact, artifact.publish));
  return ledger;
}

function normalizeSiteAgentAppArtifact(value: unknown): SiteAgentAppArtifact | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SiteAgentAppArtifact>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.appRecordId !== "string" ||
    typeof raw.appId !== "string" ||
    typeof raw.appName !== "string" ||
    typeof raw.rootPath !== "string" ||
    typeof raw.sourceScreenId !== "string" ||
    (raw.status !== "scaffolded" && raw.status !== "building" && raw.status !== "ready" && raw.status !== "failed")
  ) return null;
  const rootPath = path.resolve(raw.rootPath);
  const allowedRoot = path.resolve(siteAgentAppsRoot());
  const relative = path.relative(allowedRoot, rootPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const thumbnailRaw = raw.thumbnail;
  let thumbnail: SiteAgentAppArtifact["thumbnail"] = null;
  if (thumbnailRaw && typeof thumbnailRaw === "object" && typeof thumbnailRaw.path === "string") {
    const thumbnailPath = path.resolve(thumbnailRaw.path);
    const thumbnailRelative = path.relative(rootPath, thumbnailPath);
    if (
      thumbnailRelative &&
      !thumbnailRelative.startsWith("..") &&
      !path.isAbsolute(thumbnailRelative) &&
      path.extname(thumbnailPath).toLowerCase() === ".png"
    ) {
      thumbnail = {
        path: thumbnailPath,
        width: 1280,
        height: 720,
        updatedAt: typeof thumbnailRaw.updatedAt === "string" ? thumbnailRaw.updatedAt : new Date(0).toISOString(),
      };
    }
  }
  const launchUrl = typeof raw.launchUrl === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/i.test(raw.launchUrl)
    ? raw.launchUrl
    : null;
  const publishBindingRaw = raw.publishBinding;
  const publishBinding = publishBindingRaw &&
    typeof publishBindingRaw === "object" &&
    typeof publishBindingRaw.deploymentId === "string" &&
    /^[a-f0-9]{64}$/i.test(String(publishBindingRaw.artifactDigest ?? "")) &&
    /^[a-f0-9]{64}$/i.test(String(publishBindingRaw.intentDigest ?? ""))
    ? {
        deploymentId: publishBindingRaw.deploymentId.slice(0, 200),
        artifactDigest: String(publishBindingRaw.artifactDigest).toLowerCase(),
        intentDigest: String(publishBindingRaw.intentDigest).toLowerCase(),
      }
    : null;
  return {
    schemaVersion: 1,
    appRecordId: raw.appRecordId.slice(0, 160),
    appId: raw.appId.slice(0, 160),
    appName: raw.appName.replace(/[\0\r\n<>`]/g, " ").trim().slice(0, 160) || "Agent App",
    rootPath,
    sourceScreenId: raw.sourceScreenId.slice(0, 160),
    status: raw.status,
    launchUrl,
    thumbnail,
    publish: normalizedPublishRecord(raw.publish),
    publishBinding,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    failureReason: typeof raw.failureReason === "string" ? raw.failureReason.slice(0, 1_000) : null,
  };
}

function normalizeAgentAppTarget(value: unknown): SiteAgentAppTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Partial<SiteAgentAppTarget>;
  if (
    (target.kind !== "agent" && target.kind !== "team" && target.kind !== "firm" && target.kind !== "group") ||
    typeof target.id !== "string" ||
    typeof target.name !== "string"
  ) {
    return null;
  }
  return {
    kind: target.kind,
    id: target.id,
    name: target.name.slice(0, 160),
    description: typeof target.description === "string" ? target.description.slice(0, 500) : "",
    memberCount: Number.isFinite(target.memberCount) ? Math.max(1, Math.floor(target.memberCount as number)) : 1,
  };
}

function writeProjectMeta(meta: SiteProjectMeta): void {
  const projectId = safeId(meta.id);
  const directory = projectDir(projectId);
  const target = projectMetaPath(projectId);
  const temp = path.join(directory, `.project.json.${process.pid}.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, JSON.stringify(meta, null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // Same-directory rename is the commit point: readers observe either the
    // previous complete ledger or this complete ledger, never truncated JSON.
    fs.renameSync(temp, target);
    try {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      // Some filesystems reject directory fsync. The same-directory atomic
      // rename still prevents partial project.json reads.
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // A successful rename consumes the temp. On pre-commit failure cleanup
      // never touches the previous durable project.json.
    }
  }
}

export function listSiteProjects(): SiteProjectMeta[] {
  const root = projectsRoot();
  let ids: string[] = [];
  try {
    ids = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const projects: SiteProjectMeta[] = [];
  for (const id of ids) {
    const meta = readProjectMeta(id);
    if (meta) projects.push(meta);
  }
  projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return projects;
}

/** Main-owned filesystem locations never cross the Site renderer IPC. */
export function siteProjectForRenderer(project: SiteProjectMeta): SiteProjectPublicMeta {
  const artifact = project.agentAppArtifact;
  if (!artifact) return { ...project, agentAppArtifact: null };
  const { rootPath: _rootPath, thumbnail, ...publicArtifact } = artifact;
  const publicThumbnail = thumbnail
    ? {
        width: thumbnail.width,
        height: thumbnail.height,
        updatedAt: thumbnail.updatedAt,
      }
    : null;
  return {
    ...project,
    agentAppArtifact: {
      ...publicArtifact,
      thumbnail: publicThumbnail,
      // Build tooling may include absolute paths in stderr. The renderer gets
      // only a stable value-safe state; detailed diagnostics remain in main.
      failureReason: artifact.failureReason ? "agent-app-build-failed" : null,
    },
  };
}

export function listSiteProjectsForRenderer(): SiteProjectPublicMeta[] {
  return listSiteProjects().map(siteProjectForRenderer);
}

export function createSiteProject(
  input: string | {
    name: string;
    surface?: SiteSurface;
    agentAppTarget?: SiteAgentAppTarget | null;
    astryxTemplate?: SiteAstryxTemplate | null;
    agentAppContract?: SiteAgentAppContractSnapshot | null;
    agentAppVisual?: SiteAgentAppVisualSnapshot | null;
  },
): SiteProjectMeta {
  const now = new Date().toISOString();
  const name = typeof input === "string" ? input : input.name;
  const surface: SiteSurface =
    typeof input !== "string" && (input.surface === "mobile" || input.surface === "agent-app")
      ? input.surface
      : "web";
  const agentAppTarget = surface === "agent-app" && typeof input !== "string"
    ? normalizeAgentAppTarget(input.agentAppTarget)
    : null;
  const astryxTemplate = surface === "agent-app" && typeof input !== "string" &&
    (input.astryxTemplate === "ai-chat" || input.astryxTemplate === "ai-chat-landing" || input.astryxTemplate === "form-two-column")
      ? input.astryxTemplate
      : null;
  const agentAppContract = surface === "agent-app" && typeof input !== "string"
      ? normalizeSiteAgentAppContract(
        input.agentAppContract,
        input.agentAppContract?.source === "declared-package" ||
        input.agentAppContract?.source === "declared-routing-card" ||
        input.agentAppContract?.source === "composed-target"
          ? input.agentAppContract.source
          : "inferred-fallback",
      )
    : null;
  if (surface === "agent-app" && (!agentAppTarget || !astryxTemplate || !agentAppContract)) {
    throw new Error("Agent App 프로젝트에는 대상, Astryx 템플릿, 입출력 계약 스냅샷이 모두 필요합니다.");
  }
  const meta: SiteProjectMeta = {
    id: randomUUID(),
    name: name.trim() || "새 사이트",
    surface,
    agentAppTarget,
    astryxTemplate,
    agentAppContract,
    agentAppMcpConsent: null,
    agentAppVisual: surface === "agent-app" && agentAppTarget && typeof input !== "string"
      ? normalizeSiteAgentAppVisual(input.agentAppVisual) ?? defaultSiteAgentAppVisual(agentAppTarget)
      : null,
    agentAppArtifact: null,
    agentAppDeployments: [],
    createdAt: now,
    updatedAt: now,
    screens: [],
  };
  writeProjectMeta(meta);
  return meta;
}

export function updateSiteAgentAppArtifact(
  projectId: string,
  artifact: SiteAgentAppArtifact,
): SiteProjectMeta {
  const meta = getSiteProject(projectId);
  if (meta.surface !== "agent-app") throw new Error("Agent App 프로젝트만 실행 artifact를 저장할 수 있습니다.");
  const normalized = normalizeSiteAgentAppArtifact(artifact);
  if (!normalized) throw new Error("Agent App artifact 경로 또는 메타데이터가 올바르지 않습니다.");
  meta.agentAppArtifact = normalized.publish
    ? normalized
    : { ...normalized, publishBinding: null };
  meta.updatedAt = new Date().toISOString();
  writeProjectMeta(meta);
  return meta;
}

export function updateSiteAgentAppMcpConsent(
  projectId: string,
  receipt: SiteAgentAppMcpConsentReceipt,
): SiteProjectMeta {
  const meta = getSiteProject(projectId);
  if (meta.surface !== "agent-app") throw new Error("Agent App 프로젝트만 MCP 동의를 저장할 수 있습니다.");
  const normalized = normalizeSiteAgentAppMcpConsentReceipt(receipt);
  if (!normalized || normalized.projectId !== meta.id) {
    throw new Error("Agent App MCP 동의 영수증이 올바르지 않습니다.");
  }
  meta.agentAppMcpConsent = normalized;
  meta.updatedAt = new Date().toISOString();
  writeProjectMeta(meta);
  return meta;
}

/** Append one immutable provider-mutation event and project its latest status for the UI. */
export function appendSiteAgentAppDeployment(
  projectId: string,
  record: SiteAgentAppDeploymentRecord,
): SiteProjectMeta {
  const meta = getSiteProject(projectId);
  if (meta.surface !== "agent-app" || !meta.agentAppArtifact) {
    throw new Error("Agent App artifact가 있는 프로젝트만 배포 이력을 저장할 수 있습니다.");
  }
  const normalized = normalizeDeploymentRecord(record);
  if (!normalized) throw new Error("Agent App 배포 ledger 항목이 올바르지 않습니다.");
  if ((meta.agentAppDeployments ?? []).some((entry) => entry.ledgerEntryId === normalized.ledgerEntryId)) {
    throw new Error("Agent App 배포 ledger entry id가 중복되었습니다.");
  }
  meta.agentAppDeployments = [...(meta.agentAppDeployments ?? []), normalized];
  meta.agentAppArtifact = {
    ...meta.agentAppArtifact,
    publish: publishRecordFromDeployment(normalized),
    publishBinding: normalized.artifactDigest && normalized.intentDigest
      ? {
          deploymentId: normalized.deploymentId,
          artifactDigest: normalized.artifactDigest,
          intentDigest: normalized.intentDigest,
        }
      : null,
    updatedAt: normalized.recordedAt,
  };
  meta.updatedAt = normalized.recordedAt;
  writeProjectMeta(meta);
  return meta;
}

export function getSiteProject(projectId: string): SiteProjectMeta {
  const meta = readProjectMeta(safeId(projectId));
  if (!meta) throw new Error("프로젝트를 찾을 수 없음");
  return meta;
}

export function deleteSiteProject(projectId: string): void {
  fs.rmSync(projectDir(safeId(projectId)), { recursive: true, force: true });
}

function readSiteConversation(projectId: string): SiteConversationEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(conversationPath(projectId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("사이트 대화 기록이 손상되어 원본을 보존했습니다.", { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error("사이트 대화 기록 형식이 올바르지 않아 원본을 보존했습니다.");
  const valid = parsed.every(
    (entry): entry is SiteConversationEntry =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as SiteConversationEntry).id === "string" &&
      (entry as SiteConversationEntry).projectId === projectId &&
      ((entry as SiteConversationEntry).role === "user" || (entry as SiteConversationEntry).role === "assistant") &&
      typeof (entry as SiteConversationEntry).text === "string" &&
      typeof (entry as SiteConversationEntry).createdAt === "string",
  );
  if (!valid) throw new Error("사이트 대화 기록 항목이 손상되어 원본을 보존했습니다.");
  return parsed.slice(-200);
}

function writeSiteConversation(projectId: string, entries: SiteConversationEntry[]): void {
  const directory = projectDir(safeId(projectId));
  const target = conversationPath(projectId);
  const temp = path.join(directory, `.conversation.json.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, JSON.stringify(entries.slice(-200), null, 2), "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, target);
    try {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      // Some supported filesystems reject directory fsync; same-dir rename
      // still prevents readers from observing a partially written transcript.
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // Successful rename consumes the temp path; failed cleanup never touches
      // the previous durable conversation.json.
    }
  }
}

export function listSiteConversation(projectId: string): SiteConversationEntry[] {
  getSiteProject(projectId); // 프로젝트 존재와 id 형식을 함께 검증.
  return readSiteConversation(projectId);
}

export function appendSiteConversation(input: {
  projectId: string;
  role: SiteConversationEntry["role"];
  text: string;
  context?: string | null;
}): SiteConversationEntry {
  getSiteProject(input.projectId);
  const entry: SiteConversationEntry = {
    id: randomUUID(),
    projectId: input.projectId,
    role: input.role,
    text: input.text.trim().slice(0, 4_000),
    createdAt: new Date().toISOString(),
    context: input.context?.trim().slice(0, 300) || null,
  };
  const entries = readSiteConversation(input.projectId);
  entries.push(entry);
  writeSiteConversation(input.projectId, entries);
  return entry;
}

export function readSiteScreenHtml(projectId: string, screenId: string): string {
  return fs.readFileSync(screenFilePath(projectId, screenId), "utf8");
}

export type SaveScreenInput = {
  projectId: string;
  name: string;
  html: string;
  variantGroup?: string | null;
  variantLabel?: string | null;
};

export function saveSiteScreen(input: SaveScreenInput): SiteScreenMeta {
  const meta = getSiteProject(input.projectId);
  const now = new Date().toISOString();
  const screen: SiteScreenMeta = {
    id: randomUUID(),
    projectId: meta.id,
    name: input.name.trim() || `화면 ${meta.screens.length + 1}`,
    fileName: "",
    createdAt: now,
    updatedAt: now,
    variantGroup: input.variantGroup ?? null,
    variantLabel: input.variantLabel ?? null,
  };
  screen.fileName = `${screen.id}.html`;
  fs.mkdirSync(screensDir(meta.id), { recursive: true });
  fs.writeFileSync(screenFilePath(meta.id, screen.id), input.html, "utf8");
  meta.screens.push(screen);
  meta.updatedAt = now;
  writeProjectMeta(meta);
  return screen;
}

export function updateSiteScreenHtml(projectId: string, screenId: string, html: string): SiteScreenMeta {
  const meta = getSiteProject(projectId);
  const screen = meta.screens.find((s) => s.id === screenId);
  if (!screen) throw new Error("화면을 찾을 수 없음");
  fs.writeFileSync(screenFilePath(projectId, screenId), html, "utf8");
  const now = new Date().toISOString();
  screen.updatedAt = now;
  meta.updatedAt = now;
  writeProjectMeta(meta);
  return screen;
}

export function updateSiteAgentAppVisual(
  projectId: string,
  visual: SiteAgentAppVisualSnapshot,
): SiteProjectMeta {
  const meta = getSiteProject(projectId);
  if (meta.surface !== "agent-app") throw new Error("Agent App 프로젝트만 시각 스냅샷을 저장할 수 있습니다.");
  const normalized = normalizeSiteAgentAppVisual(visual);
  if (!normalized) throw new Error("Agent App 시각 스냅샷이 올바르지 않습니다.");
  meta.agentAppVisual = normalized;
  meta.updatedAt = new Date().toISOString();
  writeProjectMeta(meta);
  return meta;
}

export function renameSiteScreen(projectId: string, screenId: string, name: string): SiteScreenMeta {
  const meta = getSiteProject(projectId);
  const screen = meta.screens.find((s) => s.id === screenId);
  if (!screen) throw new Error("화면을 찾을 수 없음");
  screen.name = name.trim() || screen.name;
  screen.updatedAt = new Date().toISOString();
  meta.updatedAt = screen.updatedAt;
  writeProjectMeta(meta);
  return screen;
}

export function deleteSiteScreen(projectId: string, screenId: string): void {
  const meta = getSiteProject(projectId);
  const index = meta.screens.findIndex((s) => s.id === screenId);
  if (index < 0) return;
  meta.screens.splice(index, 1);
  meta.updatedAt = new Date().toISOString();
  try {
    fs.rmSync(screenFilePath(projectId, screenId), { force: true });
  } catch {
    /* 파일이 이미 없으면 무시 */
  }
  writeProjectMeta(meta);
}

export function listSiteScreenFiles(projectId: string): { name: string; data: Buffer }[] {
  const meta = getSiteProject(projectId);
  const files: { name: string; data: Buffer }[] = [];
  for (const screen of meta.screens) {
    try {
      const data = fs.readFileSync(screenFilePath(projectId, screen.id));
      const base = screen.name.replace(/[^\w가-힣 .-]+/g, "_").trim() || screen.id;
      files.push({ name: `${base}.html`, data });
    } catch {
      /* 깨진 화면은 건너뜀 */
    }
  }
  return files;
}
