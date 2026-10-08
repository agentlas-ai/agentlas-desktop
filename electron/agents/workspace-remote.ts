import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionCookieHeader } from "../auth";
import { getRoute } from "./routes";
import { readCloudAgentRestoreMarker, updateCloudAgentRegistrationBaseline } from "../cloud-agents/restore";
import type { CloudAgentRevisionIdentity } from "../../shared/types";
import { looksSecret } from "../../shared/secret-patterns";
import { agentWorkspaceStorePath } from "./workspace-guard";
import { getAgentWorkspace, prepareAgentWorkspaceProposal, writeAgentWorkspaceRecord } from "./workspace-service";
import { AgentWorkspaceError, snapshotAgentWorkspace, workspaceTreeDigest, workspaceHash, isWorkspaceAsset,
  decodeWorkspaceText, normalizeWorkspacePath, workspaceFileRole, MAX_WORKSPACE_FILES, MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_TOTAL_BYTES,
  type WorkspaceAsset, type WorkspaceTree } from "./workspace-snapshot";
import type { AgentWorkspaceComparison, AgentWorkspaceProposal, AgentWorkspaceChange, AgentWorkspaceFile } from "../../shared/agent-workspace";

interface RemoteSnapshot {
  cloudId: string; slug?: string; revisionId: string; treeDigest: string; canonicalEntry: string | null;
  files: AgentWorkspaceFile[]; etag?: string; cloudRevision?: string; packageHash: string;
  packageHashVersion: string; assetPolicyVersion: string; coverageComplete?: boolean; sourceAllowed?: boolean;
  parentRevisionIds?: string[]; ancestryKnown?: boolean; canPublish?: boolean;
}
interface SyncBase { localRevisionId: string; localTreeDigest: string; remoteRevisionId: string; remoteTreeDigest: string; }
interface PublicationFile { path: string; contentBase64: string; executable: boolean; bytes: number; sha256: string; }
interface PublicationPreview {
  schemaVersion: string; proposalId: string; proposalDigest: string; destination: string; manifestId: string;
  basePrivateRevision: string; basePrivatePackageHash: string; basePrivateTreeDigest: string;
  publicTargetId: string; publicSlug: string; basePublicCloudRevision: string; basePublicPackageHash: string;
  proposedTreeDigest: string; packageHash: string; sourceBrowsing: boolean; expiresAt: string;
  beforeFiles: PublicationFile[]; files: PublicationFile[];
}
export interface AgentWorkspaceRemoteReview {
  agentId: string; target: "cloud" | "hub"; direction: "receive" | "send"; localRevisionId: string; local: WorkspaceTree;
  remote: RemoteSnapshot; remoteFiles: WorkspaceAsset[]; reviewedHash: string; cookieHash: string;
  publication?: PublicationPreview; privateHead?: RemoteSnapshot;
  markerRevision?: string; markerSlug?: string;
}
interface PendingSync { operationId: string; agentId: string; target: "cloud" | "hub"; cloudId: string; localRevisionId: string; localTreeDigest: string;
  publicTargetId?: string; publicSlug?: string; publicPackageHash?: string; publicTreeDigest?: string; }
type PendingRegistration = PendingSync & { rootPath: string; markerRevision?: string; markerSlug?: string };
function registration(remote: RemoteSnapshot, target: "cloud" | "hub", slug?: string): CloudAgentRevisionIdentity | undefined {
  const name = remote.slug ?? slug;
  if (!name || !remote.cloudRevision || !/^rev_[a-f0-9]{32}$/.test(remote.cloudRevision)
    || !["path-sha256-v1", "path-sha256-executable-v2"].includes(remote.packageHashVersion)) return undefined;
  return { cloudId: remote.cloudId, slug: name, scope: target === "cloud" ? "owner-private" : "hub-public", packageHash: remote.packageHash,
    packageHashVersion: remote.packageHashVersion as CloudAgentRevisionIdentity["packageHashVersion"], revision: remote.cloudRevision };
}
function baseUrl(): string { return (process.env.AGENTLAS_WEB_BASE_URL || "https://agentlas.cloud").replace(/\/$/, ""); }
function credentials(): string {
  const cookie = getSessionCookieHeader();
  if (!cookie) throw new AgentWorkspaceError("sign_in_required", "Sign in to compare this agent with Cloud or Hub.");
  return cookie;
}
async function request<T>(endpoint: string, input?: unknown, etag?: string): Promise<T> {
  const response = await fetch(baseUrl() + endpoint, { method: input === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(30_000), headers: { cookie: credentials(), origin: baseUrl(), "sec-fetch-site": "same-origin",
      ...(input === undefined ? {} : { "content-type": "application/json" }), ...(etag ? { "if-match": etag } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 45 * 1024 * 1024) throw new AgentWorkspaceError("remote_limit", "The remote reply exceeds the comparison limit.");
  let body: unknown; try { body = JSON.parse(raw); } catch { throw new AgentWorkspaceError("remote_protocol", "This server does not yet support Agent Workspace."); }
  if (!response.ok) {
    const code = body && typeof body === "object" && "error" in body ? String(body.error) : "remote_unavailable";
    throw new AgentWorkspaceError(code, response.status === 412 || response.status === 409
      ? "The remote version changed. Refresh the comparison before syncing."
      : response.status === 403 ? "This account cannot change or read this source." : "The remote workspace is unavailable. Refresh to retry.");
  }
  return body as T;
}
function validateRemote(remote: RemoteSnapshot, partial = false): void {
  if (!remote || !remote.revisionId || !/^[a-f0-9]{64}$/.test(remote.treeDigest) || !Array.isArray(remote.files)
    || remote.assetPolicyVersion !== "agentlas.runtime-assets.v1" || remote.files.length > MAX_WORKSPACE_FILES) {
    throw new AgentWorkspaceError("remote_protocol", "The remote file version could not be verified.");
  }
  const names = new Set<string>(); let total = 0;
  for (const file of remote.files) {
    const key = file.path.normalize("NFC").toLowerCase();
    if (!isWorkspaceAsset(file.path) || names.has(key) || !/^[a-f0-9]{64}$/.test(file.blobHash) || !Number.isSafeInteger(file.byteLength)
      || file.byteLength < 0 || file.byteLength > MAX_WORKSPACE_FILE_BYTES || typeof file.executable !== "boolean"
      || file.role !== workspaceFileRole(file.path, remote.canonicalEntry)) {
      throw new AgentWorkspaceError("remote_files_invalid", "The remote file list cannot be used safely.");
    }
    names.add(key); total += file.byteLength;
  }
  if (remote.canonicalEntry && (!isWorkspaceAsset(remote.canonicalEntry) || (!partial && !remote.files.some(file => file.path === remote.canonicalEntry)))) {
    throw new AgentWorkspaceError("remote_entry_invalid", "The remote agent entry is outside its verified files.");
  }
  if (total > MAX_WORKSPACE_TOTAL_BYTES || workspaceTreeDigest(remote.files) !== remote.treeDigest) throw new AgentWorkspaceError("remote_digest", "The remote tree digest does not match its files.");
}
async function remoteState(agentId: string, target: "cloud" | "hub", direction: "receive" | "send" = "receive"): Promise<{ snapshot: RemoteSnapshot; revisions: Array<{ revisionId: string; parentRevisionIds: string[] }> }> {
  const workspace = getAgentWorkspace(agentId); const marker = readCloudAgentRestoreMarker(workspace.rootPath);
  if (target === "cloud") {
    const cloudId = workspace.cloudId;
    if (!cloudId) throw new AgentWorkspaceError("cloud_not_linked", "Save or connect this agent to your Cloud first.");
    return request<{ head: RemoteSnapshot; revisions: Array<{ revisionId: string; parentRevisionIds: string[] }> }>(`/api/agent-cloud/manifests/${encodeURIComponent(cloudId)}/revisions`)
      .then(result => ({ snapshot: result.head, revisions: result.revisions }));
  }
  const slug = marker?.fork?.originSlug ?? workspace.hubRef ?? (getRoute(agentId)?.source === "hub" ? marker?.slug : null);
  if (!slug) throw new AgentWorkspaceError("hub_not_linked", "Connect the upstream Hub agent first.");
  const snapshot = await request<RemoteSnapshot>(`/api/hub/agents/${encodeURIComponent(slug)}/workspace`);
  if (snapshot.sourceAllowed !== true && !(direction === "send" && snapshot.canPublish === true)) throw new AgentWorkspaceError("source_not_licensed", "This Hub publisher has not shared the source files.");
  return { snapshot, revisions: [] };
}
async function remoteFile(remote: RemoteSnapshot, target: "cloud" | "hub", file: AgentWorkspaceFile): Promise<WorkspaceAsset> {
  const params = new URLSearchParams({ path: file.path, treeDigest: remote.treeDigest });
  let endpoint: string;
  if (target === "cloud") endpoint = `/api/agent-cloud/manifests/${encodeURIComponent(remote.cloudId)}/revisions/${encodeURIComponent(remote.revisionId)}/files?${params}`;
  else { params.set("releaseId", remote.revisionId); params.set("packageHash", remote.packageHash); endpoint = `/api/hub/agents/${encodeURIComponent(remote.slug!)}/workspace?${params}`; }
  const reply = await request<{ path: string; contentBase64: string; blobHash: string; byteLength: number; executable: boolean }>(endpoint);
  const bytes = Buffer.from(reply.contentBase64, "base64");
  if (reply.path !== file.path || bytes.toString("base64") !== reply.contentBase64 || workspaceHash(bytes) !== file.blobHash
    || bytes.length !== file.byteLength || reply.blobHash !== file.blobHash || reply.byteLength !== file.byteLength || reply.executable !== file.executable) {
    throw new AgentWorkspaceError("remote_blob_changed", "The remote file differs from the version being reviewed.");
  }
  return { ...file, kind: "file", binary: decodeWorkspaceText(bytes) === null, contentBase64: bytes.toString("base64") };
}
function changesBetween(before: WorkspaceAsset[], after: WorkspaceAsset[], complete: boolean): AgentWorkspaceChange[] {
  const paths = new Set([...(complete ? before.map(file => file.path) : []), ...after.map(file => file.path)]);
  return [...paths].sort().flatMap(relative => {
    const old = before.find(file => file.path === relative); const next = after.find(file => file.path === relative);
    if (old?.blobHash === next?.blobHash && old?.executable === next?.executable) return [];
    return [{ path: relative, operation: !old ? "create" as const : !next ? "delete" as const : "modify" as const,
      beforeHash: old?.blobHash ?? null, afterHash: next?.blobHash ?? null,
      beforeContent: old ? decodeWorkspaceText(Buffer.from(old.contentBase64, "base64")) ?? "" : "",
      afterContent: next ? decodeWorkspaceText(Buffer.from(next.contentBase64, "base64")) ?? "" : "",
      binary: Boolean(old?.binary || next?.binary), beforeExecutable: old?.executable ?? false, afterExecutable: next?.executable ?? false }];
  });
}
function publicationFiles(files: PublicationFile[], entry: string | null, outgoing: boolean): WorkspaceAsset[] {
  if (!Array.isArray(files) || files.length > MAX_WORKSPACE_FILES) throw new AgentWorkspaceError("publication_invalid", "The public file preview exceeds its bounds.");
  let total = 0; const names = new Set<string>();
  return files.map(file => {
    normalizeWorkspacePath(file.path); const key = file.path.toLowerCase(); const bytes = Buffer.from(file.contentBase64, "base64");
    if (names.has(key) || typeof file.executable !== "boolean" || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || file.bytes > MAX_WORKSPACE_FILE_BYTES || bytes.length !== file.bytes || bytes.toString("base64") !== file.contentBase64
      || workspaceHash(bytes) !== file.sha256 || (outgoing && !isWorkspaceAsset(file.path)
        && ![".agentlas/routing-card.json", ".agentlas/workforce-profile.json"].includes(file.path))) {
      throw new AgentWorkspaceError("publication_invalid", "The public file preview could not be verified.");
    }
    names.add(key); total += bytes.length;
    if (total > MAX_WORKSPACE_TOTAL_BYTES) throw new AgentWorkspaceError("publication_invalid", "The public file preview exceeds its bounds.");
    return { path: file.path, role: workspaceFileRole(file.path, entry), blobHash: file.sha256, byteLength: file.bytes,
      executable: file.executable, kind: "file", binary: decodeWorkspaceText(bytes) === null, contentBase64: file.contentBase64 };
  });
}
function validatePublication(publication: PublicationPreview, remote: RemoteSnapshot, privateHead: RemoteSnapshot, local: WorkspaceTree): { before: WorkspaceAsset[]; after: WorkspaceAsset[] } {
  const { proposalDigest, ...body } = publication;
  if (publication.schemaVersion !== "agentlas.hub-publication-proposal.v1" || publication.destination !== "hub-public"
    || !/^awpub_[a-f0-9-]{36}$/.test(publication.proposalId) || workspaceHash(JSON.stringify(body)) !== proposalDigest
    || !Number.isFinite(Date.parse(publication.expiresAt)) || Date.parse(publication.expiresAt) <= Date.now()
    || publication.manifestId !== privateHead.cloudId || publication.basePrivateRevision !== privateHead.cloudRevision
    || publication.basePrivatePackageHash !== privateHead.packageHash || publication.basePrivateTreeDigest !== local.treeDigest
    || publication.publicTargetId !== remote.cloudId || publication.publicSlug !== remote.slug
    || publication.basePublicCloudRevision !== remote.cloudRevision || publication.basePublicPackageHash !== remote.packageHash
    || publication.sourceBrowsing !== (remote.sourceAllowed === true)) {
    throw new AgentWorkspaceError("publication_stale", "The public preview differs from the versions being compared.");
  }
  const before = publicationFiles(publication.beforeFiles, null, false); const after = publicationFiles(publication.files, local.canonicalEntry, true);
  const runtime = after.filter(file => isWorkspaceAsset(file.path));
  if (workspaceTreeDigest(runtime) !== publication.proposedTreeDigest || (local.canonicalEntry && !runtime.some(file => file.path === local.canonicalEntry))) {
    throw new AgentWorkspaceError("publication_digest", "The public instruction files differ from their verified tree.");
  }
  // The existing Cloud v2 package contract also includes portable public metadata.
  const packageHash = workspaceHash([...after].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => `${file.path}\0${file.blobHash}\0${file.executable ? "x" : "-"}\0`).join(""));
  if (packageHash !== publication.packageHash) throw new AgentWorkspaceError("publication_digest", "The public package differs from the files shown for approval.");
  return { before, after };
}
export async function prepareAgentWorkspaceComparison(agentId: string, target: "cloud" | "hub", direction: "receive" | "send" = "receive"): Promise<{ comparison: AgentWorkspaceComparison; review?: AgentWorkspaceRemoteReview }> {
  const localState = getAgentWorkspace(agentId); const local = snapshotAgentWorkspace(localState.rootPath);
  try {
    await reconcilePendingSync(agentId);
    const { snapshot: remote, revisions } = await remoteState(agentId, target, direction);
    let publication: PublicationPreview | undefined; let privateHead: RemoteSnapshot | undefined;
    let outgoingChanges: AgentWorkspaceChange[] | undefined;
    if (target === "hub" && direction === "send") {
      if (!remote.canPublish || !remote.cloudId || !remote.cloudRevision || !remote.revisionId || !/^[a-f0-9]{64}$/.test(remote.packageHash)) {
        throw new AgentWorkspaceError("publisher_required", "Only this Hub publisher can approve a new public release.");
      }
      privateHead = (await remoteState(agentId, "cloud")).snapshot; validateRemote(privateHead);
      if (privateHead.treeDigest !== local.treeDigest) throw new AgentWorkspaceError("cloud_publish_base_required", "Save this exact local version to Cloud before reviewing its Hub publication.");
      try {
        publication = await request<PublicationPreview>(`/api/agent-cloud/manifests/${encodeURIComponent(privateHead.cloudId)}/publish-proposals`, {
          expectedPrivateRevision: privateHead.cloudRevision, expectedPackageHash: privateHead.packageHash,
          hubCloudId: remote.cloudId, expectedHubRevision: remote.cloudRevision, sourceBrowsing: remote.sourceAllowed === true });
      } catch (error) {
        if (!(error instanceof AgentWorkspaceError) || error.code !== "no_public_changes") throw error;
        return { comparison: { agentId, target, direction, state: remote.coverageComplete && remote.treeDigest === local.treeDigest ? "content_equal" : "unknown",
          reason: "public_projection_current", localTreeDigest: local.treeDigest, ...(remote.treeDigest ? { remoteTreeDigest: remote.treeDigest } : {}),
          remoteRevisionId: remote.revisionId, changes: [], outgoingChanges: [], canSend: false, canReceive: false } };
      }
      const projected = validatePublication(publication, remote, privateHead, local);
      outgoingChanges = changesBetween(projected.before, projected.after, true);
    } else validateRemote(remote, target === "hub" && remote.coverageComplete !== true);
    const remoteFiles: WorkspaceAsset[] = [];
    // Reuse byte-identical files; fetch changed immutable blobs in bounded batches.
    for (let offset = 0; !publication && offset < remote.files.length; offset += 8) {
      remoteFiles.push(...await Promise.all(remote.files.slice(offset, offset + 8).map(async file => {
        const same = local.files.find(candidate => candidate.path === file.path && candidate.blobHash === file.blobHash && candidate.executable === file.executable);
        return same ? { ...same, role: file.role } : remoteFile(remote, target, file);
      })));
    }
    if (snapshotAgentWorkspace(localState.rootPath).treeDigest !== local.treeDigest) throw new AgentWorkspaceError("base_changed", "The local files changed while comparing versions.");
    const complete = !publication && (target === "cloud" || remote.coverageComplete === true);
    let state: AgentWorkspaceComparison["state"] = "unknown"; let reason = complete ? "common_ancestor_unverified" : "public_source_subset";
    const baseFile = path.join(agentWorkspaceStorePath(agentId), `sync-base-${target}.json`);
    const base = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, "utf8")) as SyncBase : null;
    const localAncestor = base && localState.history.some(revision => revision.id === base.localRevisionId);
    const ancestry = new Set<string>(); const visit = (id: string) => { if (ancestry.has(id)) return; ancestry.add(id); revisions.find(row => row.revisionId === id)?.parentRevisionIds.forEach(visit); }; visit(remote.revisionId);
    if (complete && local.treeDigest === remote.treeDigest) {
      state = base?.localRevisionId === localState.currentRevisionId && base.remoteRevisionId === remote.revisionId ? "in_sync" : "content_equal";
      reason = state === "in_sync" ? "verified_sync_base" : "same_tree_different_history";
    } else if (complete && base && localAncestor && ancestry.has(base.remoteRevisionId)) {
      state = localState.currentRevisionId === base.localRevisionId ? "cloud_ahead" : remote.revisionId === base.remoteRevisionId ? "local_ahead" : "diverged";
      reason = "verified_sync_base";
    }
    const changes = publication ? [] : changesBetween(local.files, remoteFiles, complete);
    outgoingChanges ??= changesBetween(remoteFiles, local.files, true);
    const marker = readCloudAgentRestoreMarker(localState.rootPath);
    const markerRevision = marker?.registrations?.[target === "cloud" ? "owner-private" : "hub-public"]?.revision;
    const canReceive = !publication && localState.writable && localState.activation === "ready" && changes.length > 0;
    const canSend = localState.writable && localState.activation === "ready" && outgoingChanges.length > 0 && (target === "cloud" || Boolean(publication));
    const reviewedHash = workspaceHash(JSON.stringify({ agentId, target, direction, localRevisionId: localState.currentRevisionId, localTreeDigest: local.treeDigest,
      remoteRevisionId: remote.revisionId, remoteTreeDigest: remote.treeDigest, etag: remote.etag ?? null, complete, changes, outgoingChanges,
      publicationDigest: publication?.proposalDigest ?? null }));
    return { comparison: { agentId, target, direction, state, reason: publication ? "reviewed_public_projection" : reason, localTreeDigest: local.treeDigest,
      ...(remote.treeDigest ? { remoteTreeDigest: remote.treeDigest } : {}), remoteRevisionId: remote.revisionId,
      ...(remote.etag ? { cloudETag: remote.etag } : {}), changes, outgoingChanges, canSend, canReceive, reviewedHash },
      ...((direction === "send" ? canSend : canReceive) ? { review: { agentId, target, direction, localRevisionId: localState.currentRevisionId,
        local, remote, remoteFiles, reviewedHash, cookieHash: workspaceHash(credentials()), ...(publication ? { publication, privateHead } : {}),
        ...(markerRevision ? { markerRevision, markerSlug: marker?.slug } : {}) } } : {}) };
  } catch (error) {
    return { comparison: { agentId, target, direction, state: "unavailable", reason: error instanceof AgentWorkspaceError ? error.code : "remote_unavailable", localTreeDigest: local.treeDigest, changes: [], canSend: false, canReceive: false } };
  }
}
async function verifyReview(review: AgentWorkspaceRemoteReview): Promise<void> {
  const current = getAgentWorkspace(review.agentId);
  if (!current.writable || current.activation !== "ready") throw new AgentWorkspaceError("run_active", "Finish or recover the current run before syncing its files.");
  if (workspaceHash(credentials()) !== review.cookieHash || current.currentRevisionId !== review.localRevisionId || current.treeDigest !== review.local.treeDigest) {
    throw new AgentWorkspaceError("sync_review_stale", "The account or local files changed. Review a fresh comparison.");
  }
  const { snapshot } = await remoteState(review.agentId, review.target, review.direction);
  if (snapshot.revisionId !== review.remote.revisionId || snapshot.treeDigest !== review.remote.treeDigest || snapshot.etag !== review.remote.etag) {
    throw new AgentWorkspaceError("remote_changed", "The remote version changed. Review a fresh comparison.");
  }
  if (review.publication && review.privateHead) {
    const currentPrivate = (await remoteState(review.agentId, "cloud")).snapshot; validateRemote(currentPrivate);
    if (currentPrivate.revisionId !== review.privateHead.revisionId || currentPrivate.cloudRevision !== review.privateHead.cloudRevision
      || currentPrivate.packageHash !== review.privateHead.packageHash || currentPrivate.treeDigest !== review.local.treeDigest) {
      throw new AgentWorkspaceError("publication_stale", "The Cloud publication source changed. Review a fresh public diff.");
    }
    const exact = await request<PublicationPreview>(`/api/agent-cloud/manifests/${encodeURIComponent(currentPrivate.cloudId)}/publish-proposals/${encodeURIComponent(review.publication.proposalId)}`);
    validatePublication(exact, snapshot, currentPrivate, review.local);
    if (exact.proposalDigest !== review.publication.proposalDigest) throw new AgentWorkspaceError("publication_stale", "The public file preview changed after review.");
  }
}
export async function receiveAgentWorkspace(review: AgentWorkspaceRemoteReview): Promise<AgentWorkspaceProposal> {
  if (review.direction !== "receive") throw new AgentWorkspaceError("review_direction", "Review the receive direction before applying remote files.");
  await verifyReview(review);
  const complete = review.target === "cloud" || review.remote.coverageComplete === true;
  const changes = changesBetween(review.local.files, review.remoteFiles, complete).map(change => {
    const file = review.remoteFiles.find(candidate => candidate.path === change.path);
    return { path: change.path, afterContent: null, ...(file ? { afterContentBase64: file.contentBase64, executable: file.executable } : {}) };
  });
  const proposal = prepareAgentWorkspaceProposal({ agentId: review.agentId, changes, expectedBaseTreeDigest: review.local.treeDigest,
    summary: complete ? `Receive ${review.target} version` : "Merge shared Hub files" });
  writeAgentWorkspaceRecord(path.join(agentWorkspaceStorePath(review.agentId), "sync-proposals", `${proposal.id}.json`), {
    target: review.target, remoteRevisionId: review.remote.revisionId, remoteTreeDigest: review.remote.treeDigest, complete,
    registration: registration(review.remote, review.target, review.markerSlug), markerRevision: review.markerRevision });
  return proposal;
}
export async function sendAgentWorkspace(review: AgentWorkspaceRemoteReview): Promise<AgentWorkspaceComparison> {
  if (review.direction !== "send") throw new AgentWorkspaceError("review_direction", "Review the send direction before saving remote files.");
  await verifyReview(review);
  const journal = path.join(agentWorkspaceStorePath(review.agentId), "pending-sync.json");
  if (fs.existsSync(journal)) throw new AgentWorkspaceError("sync_outcome_pending", "The previous sync needs remote reconciliation before another send.");
  for (const file of review.publication?.files ?? review.local.files) {
    const text = decodeWorkspaceText(Buffer.from(file.contentBase64, "base64"));
    if (text !== null && looksSecret(text)) throw new AgentWorkspaceError("private_content", "Remove credential values before sending this file version.");
  }
  const cloudId = review.publication?.manifestId ?? review.remote.cloudId;
  const endpoint = `/api/agent-cloud/manifests/${encodeURIComponent(cloudId)}`;
  const proposal = review.publication ?? await request<{ proposalId: string; proposalDigest: string; proposedTreeDigest: string }>(endpoint + "/proposals", {
      baseRevisionId: review.remote.revisionId, baseTreeDigest: review.remote.treeDigest, proposedTreeDigest: review.local.treeDigest,
      files: review.local.files.map(file => ({ path: file.path, contentBase64: file.contentBase64, executable: file.executable })), memoryRefs: [] }, review.remote.etag);
  if (!review.publication && proposal.proposedTreeDigest !== review.local.treeDigest) throw new AgentWorkspaceError("remote_preview_mismatch", "The server's proposed files differ from this review.");
  const proposalEndpoint = `${endpoint}/${review.publication ? "publish-proposals" : "proposals"}/${encodeURIComponent(proposal.proposalId)}`;
  const idempotencyKey = randomUUID();
  const grant = await request<{ reviewGrant: string; operationId: string }>(`${proposalEndpoint}/review`, { proposalDigest: proposal.proposalDigest, idempotencyKey });
  if (!/^awo_[a-f0-9]{64}$/.test(grant.operationId) || typeof grant.reviewGrant !== "string" || !grant.reviewGrant) throw new AgentWorkspaceError("remote_grant_invalid", "The remote approval could not be verified.");
  writeAgentWorkspaceRecord(journal, { operationId: grant.operationId, agentId: review.agentId, target: review.target, cloudId,
    localRevisionId: review.localRevisionId, localTreeDigest: review.local.treeDigest, rootPath: getAgentWorkspace(review.agentId).rootPath,
    markerRevision: review.markerRevision, markerSlug: review.markerSlug, ...(review.publication ? {
      publicTargetId: review.publication.publicTargetId, publicSlug: review.publication.publicSlug,
      publicPackageHash: review.publication.packageHash, publicTreeDigest: review.publication.proposedTreeDigest } : {}) } satisfies PendingRegistration);
  try {
    await request(`${proposalEndpoint}/apply`, { proposalDigest: proposal.proposalDigest, reviewGrant: grant.reviewGrant, idempotencyKey }, review.publication ? undefined : review.remote.etag);
    await reconcilePendingSync(review.agentId);
  } catch (error) {
    throw new AgentWorkspaceError("sync_outcome_pending", "The sync outcome needs remote reconciliation. Refresh to check the recorded operation.");
  }
  if (fs.existsSync(journal)) throw new AgentWorkspaceError("sync_outcome_pending", "The server has not confirmed this operation yet. Refresh to check it.");
  if (review.publication) return { agentId: review.agentId, target: "hub", direction: "send", state: "unknown", reason: "public_release_verified",
    localTreeDigest: review.local.treeDigest, remoteTreeDigest: review.publication.proposedTreeDigest, changes: [], outgoingChanges: [], canSend: false, canReceive: false };
  return (await prepareAgentWorkspaceComparison(review.agentId, review.target, "send")).comparison;
}
async function reconcilePendingSync(agentId: string): Promise<void> {
  const journal = path.join(agentWorkspaceStorePath(agentId), "pending-sync.json"); if (!fs.existsSync(journal)) return;
  const pending = JSON.parse(fs.readFileSync(journal, "utf8")) as PendingRegistration;
  if (pending.agentId !== agentId || !/^awo_/.test(pending.operationId)) throw new AgentWorkspaceError("sync_journal_invalid", "The saved sync operation needs review.");
  const operation = await request<{ id: string; manifestId: string; state: string; destination?: string; snapshot?: RemoteSnapshot;
    receipt?: { publicHubPublished: boolean; cloudId: string; slug: string; revision: string; packageHash: string; packageHashVersion: string;
      treeDigest: string; agentDefinitionId: string; agentReleaseId: string } }>(`/api/agent-cloud/operations/${encodeURIComponent(pending.operationId)}`);
  if (operation.id !== pending.operationId || operation.manifestId !== pending.cloudId) throw new AgentWorkspaceError("sync_receipt_invalid", "The sync receipt belongs to another operation.");
  if (operation.state === "conflict" || operation.state === "failed") { fs.unlinkSync(journal); return; }
  if (operation.state !== "applied_verified") throw new AgentWorkspaceError("sync_outcome_pending", "This sync is awaiting verified remote readback.");
  if (pending.target === "hub") {
    const receipt = operation.receipt;
    if (operation.destination !== "hub-public" || !receipt?.publicHubPublished || receipt.cloudId !== pending.publicTargetId
      || receipt.slug !== pending.publicSlug || receipt.packageHash !== pending.publicPackageHash || !receipt.revision || !receipt.agentDefinitionId || !receipt.agentReleaseId
      || receipt.packageHashVersion !== "path-sha256-executable-v2" || receipt.treeDigest !== pending.publicTreeDigest) throw new AgentWorkspaceError("sync_receipt_mismatch", "The public release receipt differs from the approved package.");
    writeAgentWorkspaceRecord(path.join(agentWorkspaceStorePath(agentId), "sync-base-hub.json"), {
      localRevisionId: pending.localRevisionId, localTreeDigest: pending.localTreeDigest,
      remoteRevisionId: receipt.agentReleaseId, remoteTreeDigest: pending.publicTreeDigest } satisfies SyncBase);
    writeAgentWorkspaceRecord(path.join(agentWorkspaceStorePath(agentId), "hub-publication-receipt.json"), { ...receipt, verifiedAt: new Date().toISOString() });
    if (pending.rootPath && pending.markerRevision) updateCloudAgentRegistrationBaseline({ rootPath: pending.rootPath, expectedRevision: pending.markerRevision,
      registration: { cloudId: receipt.cloudId, slug: receipt.slug, scope: "hub-public", packageHash: receipt.packageHash,
        packageHashVersion: "path-sha256-executable-v2", revision: receipt.revision } });
    fs.unlinkSync(journal); return;
  }
  if (!operation.snapshot) throw new AgentWorkspaceError("sync_outcome_pending", "This sync is awaiting verified remote readback.");
  validateRemote(operation.snapshot);
  if (operation.snapshot.treeDigest !== pending.localTreeDigest) throw new AgentWorkspaceError("sync_receipt_mismatch", "The verified remote files differ from the approved version.");
  writeAgentWorkspaceRecord(path.join(agentWorkspaceStorePath(agentId), `sync-base-${pending.target}.json`), {
    localRevisionId: pending.localRevisionId, localTreeDigest: pending.localTreeDigest,
    remoteRevisionId: operation.snapshot.revisionId, remoteTreeDigest: operation.snapshot.treeDigest } satisfies SyncBase);
  const remoteRegistration = registration(operation.snapshot, "cloud", pending.markerSlug);
  if (pending.rootPath && pending.markerRevision && remoteRegistration) updateCloudAgentRegistrationBaseline({
    rootPath: pending.rootPath, expectedRevision: pending.markerRevision, registration: remoteRegistration });
  fs.unlinkSync(journal);
}
