import { webContents, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { createHash, randomUUID } from "node:crypto";
import type { ProductExtensionPermission } from "../../shared/product-extension";
import type { ScienceStore } from "agentlas-science";
import type { ScienceDatasetIngestionService } from "agentlas-science";
import { createScienceDatasetIngestionService } from "agentlas-science";
import {
  discoverScienceProjectData,
  revalidateResolvedScienceProjectDataCandidate,
  readResolvedScienceProjectDataCandidate,
  resolveScienceProjectDataCandidate,
  type ScienceProjectDataCandidate,
} from "agentlas-science";
import {
  ScienceProjectDataAutoRefreshCoordinator,
  scienceProjectDataRefreshInputFromFilesystem,
} from "agentlas-science";
import {
  persistPreparedScienceWorkbook,
  type ScienceWorkbookImportInput,
} from "./workbook-intake-ipc";
import { prepareScienceWorkbook } from "agentlas-science";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type IpcBoundary = Pick<IpcMain, "handle">;
type ScienceSenderAssertion = (event: IpcMainInvokeEvent, input: unknown, permission?: ProductExtensionPermission) => unknown;
type ScienceProjectDocumentAssertion = (event: IpcMainInvokeEvent, input: unknown) => string;
type DatasetServiceFactory = (store: ScienceStore) => ScienceDatasetIngestionService;

function inputRecord(envelope: unknown): Record<string, unknown> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("science-project-data-input-invalid");
  const input = "input" in envelope ? (envelope as { input?: unknown }).input : null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-project-data-input-invalid");
  return input as Record<string, unknown>;
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(code);
  return value;
}

function optionalTitle(value: unknown, fallback: string): string | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error("science-project-data-title-invalid");
  const title = value.replace(/\r\n/g, "\n").trim();
  if (!title || title.length > 1_000) throw new Error("science-project-data-title-invalid");
  return title;
}

function assertOrigin(store: ScienceStore, projectId: string, conversationId: string, originMessageId: string): void {
  if (!store.getProject(projectId)) throw new Error("science-project-not-found");
  if (!store.getMessageForProject(projectId, conversationId, originMessageId)) throw new Error("science-project-data-origin-not-found");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateRef(input: Record<string, unknown>): {
  candidateId: string;
  relativePath: string;
  scanId?: string;
  revision?: number;
} {
  if (typeof input.candidateId !== "string" || typeof input.relativePath !== "string") throw new Error("science-project-data-candidate-invalid");
  const scanId = input.scanId === undefined ? undefined : uuid(input.scanId, "science-project-data-scan-invalid");
  const revision = input.revision === undefined ? undefined : input.revision;
  if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) throw new Error("science-project-data-revision-invalid");
  return { candidateId: input.candidateId, relativePath: input.relativePath, ...(scanId ? { scanId } : {}), ...(revision !== undefined ? { revision } : {}) };
}

function snapshotCandidate(
  store: ScienceStore,
  projectId: string,
  ref: ReturnType<typeof candidateRef>,
): { snapshot: NonNullable<ReturnType<ScienceStore["getScienceProjectDataSnapshot"]>>; entry: NonNullable<ReturnType<ScienceStore["getScienceProjectDataSnapshot"]>>["entries"][number] } | null {
  const snapshot = store.getScienceProjectDataSnapshot(projectId);
  if (!snapshot) return null;
  if ((ref.scanId && ref.scanId !== snapshot.scanId) || (ref.revision !== undefined && ref.revision !== snapshot.revision)) {
    throw new Error("science-project-data-candidate-stale");
  }
  const entry = snapshot.entries.find((candidate) => candidate.relativePath === ref.relativePath && candidate.candidateId === ref.candidateId);
  if (!entry || !entry.candidate || entry.state === "missing" || entry.state === "unreadable") {
    throw new Error("science-project-data-candidate-stale");
  }
  return { snapshot, entry };
}

function candidateResult(candidate: ScienceProjectDataCandidate, contentSha256?: string): Record<string, unknown> {
  return {
    schema: "agentlas.science-data-candidate-read/v1",
    candidate,
    ...(contentSha256 ? { contentSha256 } : {}),
  };
}

function refreshMode(value: unknown): "manual" | "automatic" {
  if (value !== "manual" && value !== "automatic") throw new Error("science-project-data-refresh-mode-invalid");
  return value;
}

/** Main-owned linked-project data discovery and candidate import boundary. */
export function registerScienceProjectDataHandlers(options: {
  ipcMain: IpcBoundary;
  assertScienceSender: ScienceSenderAssertion;
  assertScienceProjectDocument: ScienceProjectDocumentAssertion;
  scienceStore: () => ScienceStore;
  datasetIngestionService?: DatasetServiceFactory;
}): void {
  const datasetService = options.datasetIngestionService ?? ((store: ScienceStore) => createScienceDatasetIngestionService(store));
  const autoRefresh = new ScienceProjectDataAutoRefreshCoordinator({
    store: options.scienceStore,
    notify: (senderId, change) => {
      const sender = webContents.fromId(senderId);
      if (!sender || sender.isDestroyed()) return;
      sender.send("science:projectDataChanged", change);
    },
  });

  options.ipcMain.handle("science:projects:discoverData", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    return discoverScienceProjectData(options.scienceStore(), projectId);
  });

  options.ipcMain.handle("science:projects:activate", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope);
    options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    autoRefresh.attachSenderCleanup(event.sender);
    return autoRefresh.activate(projectId, event.sender.id);
  });

  options.ipcMain.handle("science:projects:refreshData", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    const documentId = options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    const requestId = uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    const mode = refreshMode(input.mode);
    const store = options.scienceStore();
    const refreshInput = scienceProjectDataRefreshInputFromFilesystem(store, { requestId, projectId, mode });
    if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
    const result = store.refreshScienceProjectData(refreshInput);
    return { ...result.snapshot, replayed: result.replayed };
  });

  options.ipcMain.handle("science:projects:dataSnapshot", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    const store = options.scienceStore();
    if (!store.getProject(projectId)) throw new Error("science-project-not-found");
    return store.getScienceProjectDataSnapshot(projectId);
  });

  options.ipcMain.handle("science:datasets:readCandidate", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    const documentId = options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    const ref = candidateRef(input);
    const store = options.scienceStore();
    const snapshotCurrent = snapshotCandidate(store, projectId, ref);
    const resolved = resolveScienceProjectDataCandidate(store, projectId, ref.candidateId, ref.relativePath);
    if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
    const bytes = readResolvedScienceProjectDataCandidate(resolved);
    const contentSha256 = sha256(bytes);
    if (snapshotCurrent?.entry.contentSha256 && snapshotCurrent.entry.contentSha256 !== contentSha256) throw new Error("science-project-data-candidate-stale");
    return {
      ...candidateResult(resolved.candidate, contentSha256),
      ...(snapshotCurrent ? { scanId: snapshotCurrent.snapshot.scanId, revision: snapshotCurrent.snapshot.revision, entryId: snapshotCurrent.entry.id } : {}),
    };
  });

  options.ipcMain.handle("science:datasets:importCandidate", async (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    const documentId = options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    const requestId = uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    const conversationId = uuid(input.conversationId, "science-project-data-origin-invalid");
    const originMessageId = uuid(input.originMessageId, "science-project-data-origin-invalid");
    const ref = candidateRef(input);
    const store = options.scienceStore();
    assertOrigin(store, projectId, conversationId, originMessageId);
    const snapshotCurrent = snapshotCandidate(store, projectId, ref);
    const resolved = resolveScienceProjectDataCandidate(store, projectId, ref.candidateId, ref.relativePath);
    if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
    revalidateResolvedScienceProjectDataCandidate(resolved);
    if (snapshotCurrent?.entry.contentSha256) {
      const currentBytes = readResolvedScienceProjectDataCandidate(resolved);
      if (sha256(currentBytes) !== snapshotCurrent.entry.contentSha256) throw new Error("science-project-data-candidate-stale");
    }
    const title = optionalTitle(input.title, resolved.candidate.relativePath);
    if (resolved.candidate.extension === "csv") {
      const artifactRequestId = uuid(input.artifactRequestId, "science-artifact-request-id-invalid");
      const imported = await datasetService(store).importFile(resolved.absolutePath, {
        requestId,
        projectId,
        conversationId,
        originMessageId,
        title,
      }, resolved.identity, () => {
        if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
        assertOrigin(store, projectId, conversationId, originMessageId);
        revalidateResolvedScienceProjectDataCandidate(resolved);
      });
      const materialized = store.materializeDatasetTable({
        requestId: artifactRequestId,
        projectId,
        runId: imported.run.id,
        title,
      });
      const association = snapshotCurrent ? store.recordScienceProjectDataEntryImport({
        requestId: randomUUID(),
        projectId,
        entryId: snapshotCurrent.entry.id,
        sourceId: imported.source.id,
        sourceVersionId: imported.source.version.id,
        importRunId: imported.run.id,
        contentSha256: snapshotCurrent.entry.contentSha256 ?? sha256(readResolvedScienceProjectDataCandidate(resolved)),
      }).association : null;
      return {
        schema: "agentlas.science-data-import/v1",
        candidate: resolved.candidate,
        format: "csv" as const,
        ...(snapshotCurrent ? { scanId: snapshotCurrent.snapshot.scanId, revision: snapshotCurrent.snapshot.revision, entryId: snapshotCurrent.entry.id, association } : {}),
        ...imported,
        artifact: materialized.artifact,
        artifactReplayed: materialized.replayed,
      };
    }
    revalidateResolvedScienceProjectDataCandidate(resolved);
    const prepared = await prepareScienceWorkbook(resolved.absolutePath, undefined, resolved.identity);
    if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
    assertOrigin(store, projectId, conversationId, originMessageId);
    const resolvedCurrent = resolveScienceProjectDataCandidate(store, projectId, ref.candidateId, ref.relativePath);
    if (resolvedCurrent.candidate.candidateId !== resolved.candidate.candidateId) throw new Error("science-project-data-candidate-stale");
    revalidateResolvedScienceProjectDataCandidate(resolvedCurrent);
    const imported = persistPreparedScienceWorkbook(store, resolved.absolutePath, {
      requestId,
      projectId,
      conversationId,
      originMessageId,
      title,
    } satisfies ScienceWorkbookImportInput, prepared);
    const association = snapshotCurrent ? store.recordScienceProjectDataEntryImport({
      requestId: randomUUID(),
      projectId,
      entryId: snapshotCurrent.entry.id,
      sourceId: imported.source.id,
      sourceVersionId: imported.source.version.id,
      importRunId: imported.run.id,
      contentSha256: snapshotCurrent.entry.contentSha256 ?? sha256(readResolvedScienceProjectDataCandidate(resolved)),
    }).association : null;
    return {
      schema: "agentlas.science-data-import/v1",
      candidate: resolved.candidate,
      format: resolved.candidate.extension,
      ...(snapshotCurrent ? { scanId: snapshotCurrent.snapshot.scanId, revision: snapshotCurrent.snapshot.revision, entryId: snapshotCurrent.entry.id, association } : {}),
      ...imported,
    };
  });
}
