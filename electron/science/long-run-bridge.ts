import {
  SCIENCE_LONG_RUN_PROJECTION_SCHEMA,
  type ScienceLoopLongRunProjection,
} from "../../shared/science-long-run";
import type { ScienceLoopEvent } from "../../shared/science-contract";
import { scienceResearchContractContentSha256, type ScienceStore } from "./store";

export interface ScienceLongRunProjectionSink {
  project(snapshot: ScienceLoopLongRunProjection): void | Promise<void>;
}

function pauseReason(events: ScienceLoopEvent[]): ScienceLoopLongRunProjection["pauseReason"] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const raw = event.payload.pauseReason;
    if (raw === "app_closed" || raw === "crash_recovery" || raw === "approval_required" || raw === "user") return raw;
    if (event.code === "loop.pause") return "user";
  }
  return null;
}

export class ScienceLongRunBridge {
  private removeListener: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly store: ScienceStore, private readonly sink: ScienceLongRunProjectionSink) {}

  start(options: { reconcile?: boolean } = {}): Promise<void> {
    if (!this.removeListener) {
      this.removeListener = this.store.onLoopSessionChanged((change) => {
        this.enqueue(change.projectId, change.loopSessionId);
      });
    }
    if (options.reconcile === false) return Promise.resolve();
    return this.reconcileAll();
  }

  reconcileAll(): Promise<void> {
    for (const project of this.store.listProjects()) {
      for (const session of this.store.listLoopSessions(project.id)) this.enqueue(project.id, session.id);
    }
    return this.flush();
  }

  private enqueue(projectId: string, loopSessionId: string): void {
    if (this.closed) return;
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => this.project(projectId, loopSessionId))
      .catch(async (error) => {
        try { await this.projectError(projectId, loopSessionId, error); } catch { /* one broken projection must not poison later loops */ }
      });
  }

  private async projectError(projectId: string, loopSessionId: string, error: unknown): Promise<void> {
    const session = this.store.getLoopSessionForProject(projectId, loopSessionId);
    if (!session) return;
    const contract = this.store.getResearchContractForProject(projectId, session.contractId);
    if (!contract) return;
    const events = this.store.listLoopEvents(loopSessionId, 0, 5_000);
    const code = error instanceof Error ? error.message : "science-long-run-projection-failed";
    await this.sink.project({
      schema: SCIENCE_LONG_RUN_PROJECTION_SCHEMA,
      loopSessionId: session.id,
      scienceProjectId: projectId,
      runtimeChatId: session.runtimeChatId,
      contractId: session.contractId,
      contractVersion: session.contractVersion,
      contractContentSha256: session.contractContentSha256,
      objective: contract.objective,
      successCriteria: contract.successCriteria,
      maxEpisodes: session.maxEpisodes,
      deadlineAt: session.deadlineAt,
      sourceVersion: session.version,
      sourceStateSha256: session.stateSha256,
      eventCursor: events.at(-1)?.sequence ?? 0,
      status: session.status,
      pauseReason: pauseReason(events),
      waitingForDecision: session.stage === "awaiting-approval",
      verifying: session.stage === "verifying" || session.status === "completed",
      completionReceiptSetSha256: session.completionReceiptSetSha256,
      criterionEvidence: [],
      projectionStatus: "error",
      lastError: code.slice(0, 240),
    });
  }

  private async project(projectId: string, loopSessionId: string): Promise<void> {
    const session = this.store.getLoopSessionForProject(projectId, loopSessionId);
    if (!session) return;
    const contract = this.store.getResearchContractForProject(projectId, session.contractId);
    if (!contract || contract.version !== session.contractVersion
      || scienceResearchContractContentSha256(contract) !== session.contractContentSha256) {
      throw new Error("science-long-run-contract-binding-stale");
    }
    const events = this.store.listLoopEvents(loopSessionId, 0, 5_000);
    const activeEpisode = this.store.listResearchEpisodes(projectId, loopSessionId)
      .find((episode) => ["planned", "running", "waiting-for-decision"].includes(episode.status)) ?? null;
    const criterionEvidence = this.store.listLatestLoopCriterionVerificationReceipts(projectId, loopSessionId).map((receipt) => ({
      criterionIndex: receipt.criterionIndex,
      receiptId: receipt.id,
      receiptVersion: receipt.receiptVersion,
      criterionTextSha256: receipt.criterionTextSha256,
      verdict: receipt.verdict,
      evidenceRefs: [
        `science-criterion-receipt:${receipt.id}:${receipt.receiptSha256}:${receipt.provenanceSha256}`,
        ...receipt.evidenceSpanIds.map((id) => `science-evidence-span:${id}`),
      ],
      artifactRefs: receipt.artifacts.map((artifact) =>
        `science-artifact:${artifact.artifactId}@${artifact.artifactVersion}:${artifact.contentSha256}`),
      verifier: receipt.verifier,
      summary: receipt.summary,
      receiptSha256: receipt.receiptSha256,
      provenanceSha256: receipt.provenanceSha256,
    }));
    const snapshot: ScienceLoopLongRunProjection = {
      schema: SCIENCE_LONG_RUN_PROJECTION_SCHEMA,
      loopSessionId: session.id,
      scienceProjectId: projectId,
      runtimeChatId: session.runtimeChatId,
      contractId: session.contractId,
      contractVersion: session.contractVersion,
      contractContentSha256: session.contractContentSha256,
      objective: contract.objective,
      successCriteria: contract.successCriteria,
      maxEpisodes: session.maxEpisodes,
      deadlineAt: session.deadlineAt,
      sourceVersion: session.version,
      sourceStateSha256: session.stateSha256,
      eventCursor: events.at(-1)?.sequence ?? 0,
      status: session.status,
      pauseReason: pauseReason(events),
      waitingForDecision: activeEpisode?.status === "waiting-for-decision" || session.stage === "awaiting-approval",
      verifying: session.stage === "verifying" || session.status === "completed",
      completionReceiptSetSha256: session.completionReceiptSetSha256,
      criterionEvidence,
      projectionStatus: "current",
      lastError: null,
    };
    await this.sink.project(snapshot);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  close(): void {
    this.closed = true;
    this.removeListener?.();
    this.removeListener = null;
  }
}
