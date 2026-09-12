import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppFactoryAppRecord } from "../../shared/types";
import type { ArtifactBuildReceipt, ArtifactReadyRevision, ArtifactRenderReceipt } from "../../shared/artifact-build";
import { userDataPath } from "../runtime-paths";
import { getAgentApp, listAgentAppOperations, recordAgentAppOperation } from "../store/agent-apps";
import { snapshotArtifactSource, writeArtifactSourceSnapshot, artifactTreeDigest, artifactBytesDigest, type ArtifactSourceSnapshot } from "./artifact-files";
import { artifactBuildProfile, compileReactArtifact } from "./artifact-profile";

export type ArtifactBundle = { snapshot: ArtifactSourceSnapshot; build: ArtifactBuildReceipt };
const artifactDirectory = (id: string) => userDataPath("artifact-build", "artifacts", artifactBytesDigest(id));
const bundleDirectory = (id: string, digest: string) => path.join(artifactDirectory(id), "revisions", digest);
const ownerMatches = (current: AppFactoryAppRecord, before: AppFactoryAppRecord) => current.id === before.id
  && current.chatId === before.chatId && current.projectId === before.projectId && current.agentId === before.agentId
  && current.surfaceId === before.surfaceId && current.rootPath === before.rootPath && current.status !== "archived";

export function assertArtifactBuildOwner(record: AppFactoryAppRecord): void {
  const current = getAgentApp(record.id);
  if (!current || !ownerMatches(current, record)) throw new Error("artifact_build_owner_changed");
}

export async function readAppArtifactSource(record: AppFactoryAppRecord, signal?: AbortSignal): Promise<{snapshot: ArtifactSourceSnapshot; react: boolean; identityDigest: string}> {
  assertArtifactBuildOwner(record);
  const stat = await fs.lstat(record.rootPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("artifact_app_root_invalid");
  const root = await fs.realpath(record.rootPath);
  const reactRoot = path.join(root, "astryx-app");
  let react = false;
  try { await fs.lstat(reactRoot); react = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const snapshot = await snapshotArtifactSource(react ? reactRoot : path.join(root, "src"), signal);
  const now = await fs.lstat(record.rootPath);
  if (now.dev !== stat.dev || now.ino !== stat.ino || now.isSymbolicLink()) throw new Error("artifact_app_root_changed");
  assertArtifactBuildOwner(record);
  const identityDigest = artifactBytesDigest(JSON.stringify({root,dev:stat.dev,ino:stat.ino,sourceRoot:snapshot.root,sourceIdentity:snapshot.identity}));
  return {snapshot, react, identityDigest};
}

/** Builds read-once bytes in a private snapshot; only a later render receipt may make it ready. */
export async function buildAppArtifact(record: AppFactoryAppRecord, input: Awaited<ReturnType<typeof readAppArtifactSource>>, signal?: AbortSignal): Promise<ArtifactBundle> {
  assertArtifactBuildOwner(record);
  const staging = path.join(artifactDirectory(record.id), `${randomUUID()}.pending`);
  const source = path.join(staging, "source"), output = path.join(staging, "output");
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await writeArtifactSourceSnapshot(input.snapshot, source);
    const profile = input.react ? await compileReactArtifact(source, output, signal) : artifactBuildProfile("html-static-v1");
    if (!input.react) await writeArtifactSourceSnapshot(input.snapshot, output);
    const snapshot = await snapshotArtifactSource(output, signal);
    const files = snapshot.files.map(({bytes: _bytes, ...file}) => file);
    const build: ArtifactBuildReceipt = {
      schemaVersion: "agentlas.artifact-build-receipt.v1", artifactId: record.id, surfaceId: record.surfaceId,
      owner: { chatId: record.chatId, projectId: record.projectId, agentId: record.agentId },
      sourceDigest: input.snapshot.digest,
      sourceIdentityDigest: input.identityDigest,
      dataDigest: artifactTreeDigest(input.snapshot.files.filter(file => /\.(?:json|csv|tsv)$/.test(file.path))),
      profile, files, bundleDigest: snapshot.digest, builtAt: new Date().toISOString(), state: "built",
    };
    assertArtifactBuildOwner(record); signal?.throwIfAborted();
    const destination = bundleDirectory(record.id, build.bundleDigest);
    await fs.mkdir(path.dirname(destination), {recursive:true, mode:0o700});
    try { await fs.rename(output, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const existing = await snapshotArtifactSource(destination, signal);
      if (existing.digest !== build.bundleDigest) throw new Error("artifact_bundle_cache_changed");
    }
    return {snapshot: {...snapshot, root:destination}, build};
  } finally { await fs.rm(staging, {recursive:true,force:true}); }
}

export function publishReadyArtifact(record: AppFactoryAppRecord, bundle: ArtifactBundle, render: ArtifactRenderReceipt): ArtifactReadyRevision {
  assertArtifactBuildOwner(record);
  if (render.artifactId !== record.id || render.bundleDigest !== bundle.build.bundleDigest
    || render.sourceDigest !== bundle.build.sourceDigest || render.state !== "render_checked"
    || render.consoleFailures.length || render.horizontalOverflow > 1) throw new Error("artifact_render_receipt_mismatch");
  const ready: ArtifactReadyRevision = {schemaVersion:"agentlas.artifact-ready.v1",build:bundle.build,render,readyAt:new Date().toISOString()};
  // The existing app ledger owns the ready pointer. Files alone cannot advance it.
  recordAgentAppOperation(record.id, "build-artifact", true, ready, "preview-ready");
  return ready;
}

export function recordArtifactBuildFailure(record: AppFactoryAppRecord, sourceDigest: string | null, reason: string): void {
  assertArtifactBuildOwner(record);
  recordAgentAppOperation(record.id, "build-artifact", false, {schemaVersion:"agentlas.artifact-build-failure.v1",sourceDigest,reason,at:new Date().toISOString()});
}

export async function loadReadyArtifact(record: AppFactoryAppRecord, signal?: AbortSignal): Promise<(ArtifactBundle & {ready: ArtifactReadyRevision}) | null> {
  assertArtifactBuildOwner(record);
  for (const operation of listAgentAppOperations(record.id)) {
    if (operation.operation !== "build-artifact" || !operation.ok) continue;
    const ready = operation.result as unknown as ArtifactReadyRevision;
    if (ready?.schemaVersion !== "agentlas.artifact-ready.v1") continue;
    if (ready.build.artifactId !== record.id || ready.build.surfaceId !== record.surfaceId
      || ready.build.owner.chatId !== record.chatId || ready.build.owner.projectId !== record.projectId
      || ready.build.owner.agentId !== record.agentId || !/^[a-f0-9]{64}$/.test(ready.build.bundleDigest)
      || ready.render.bundleDigest !== ready.build.bundleDigest || ready.render.sourceDigest !== ready.build.sourceDigest
      || ready.render.state !== "render_checked" || ready.render.consoleFailures.length || ready.render.horizontalOverflow > 1) {
      throw new Error("artifact_ready_receipt_invalid");
    }
    const snapshot = await snapshotArtifactSource(bundleDirectory(record.id, ready.build.bundleDigest), signal);
    if (snapshot.digest !== ready.build.bundleDigest || artifactTreeDigest(ready.build.files) !== snapshot.digest) {
      throw new Error("artifact_ready_bytes_changed");
    }
    assertArtifactBuildOwner(record);
    return {snapshot, build:ready.build, ready};
  }
  return null;
}
