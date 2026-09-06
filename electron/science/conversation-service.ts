import { createHash, randomUUID } from "node:crypto";
import type {
  McpInvocationEvent,
  McpInvocationRequest,
  RuntimeSelection,
} from "../../shared/types";
import type {
  ScienceMessage,
  ScienceTurn,
  ScienceTurnEvent,
} from "../../shared/science-contract";
import {
  invocationService,
  type InvocationEventEnvelope,
  type InvocationSettledEnvelope,
  type InvocationStartResult,
  type InvocationAttachResult,
} from "../invocation/service";
import type { InvocationExecutionContext } from "../mcp/client";
import { captureScienceInvocationBinding, type InvocationWorkspaceBinding } from "../invocation/workspace-binding";
import { validateScienceProjectFolderPath } from "./project-folder-selection";
import {
  ensureScienceRuntimeChat,
  latestDurableAssistantMessage,
} from "../store/chats";
import {
  listPendingScienceRuntimeOutboxEvents,
  markScienceRuntimeOutboxDelivered,
  type ScienceRuntimeOutboxEvent,
} from "../store/run-events";
import { currentUiLocale } from "../ui-locale";
import { ScienceStore } from "./store";
import {
  scienceResearchDirectorRuntime,
  type ScienceResearchDirectorRuntime,
} from "./research-director";
import type { ScienceEvidenceGraphService } from "./evidence-graph";
import { normalizeScienceRuntimeSelection } from "./runtime-selection";

export type ScienceComposerStartInput = {
  requestId: string;
  projectId: string;
  conversationId: string;
  locale?: "ko" | "en";
  parentTurnId?: string | null;
  runtimeSelection?: RuntimeSelection | null;
} & (
  | { mode: "existing-user-message"; userMessageId: string }
  | { mode: "append-user-message"; content: string }
  | { mode: "append-controller-message"; content: string; continuationBasis: Record<string, unknown> }
);

export interface ScienceComposerStartResult {
  turn: ScienceTurn;
  userMessage: ScienceMessage;
  replayed: boolean;
}

export interface ScienceComposerAttachResult {
  turn: ScienceTurn;
  events: ScienceTurnEvent[];
}

export interface ScienceConversationInvocationRuntime {
  onEvent(listener: (envelope: InvocationEventEnvelope) => void): () => void;
  onSettled(listener: (envelope: InvocationSettledEnvelope) => void | Promise<void>): () => void;
  start(
    request: McpInvocationRequest,
    workspaceBinding?: InvocationWorkspaceBinding,
    executionContext?: InvocationExecutionContext,
  ): InvocationStartResult;
  cancel(runId: string): "requested" | "already-requested" | "not-found";
  attach(chatId: string): InvocationAttachResult | null;
  receipt(runId: string): ReturnType<typeof invocationService.receipt>;
}

export interface ScienceConversationToolRuntime {
  cancelInvocation(invocationRunId: string): number;
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function bounded(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

/**
 * Dinosaur requests have a stricter evidence order than ordinary literature
 * questions. Keep the classifier deliberately small and host-side: it only
 * selects the workflow guard, never invents taxa or starts a run.
 */
function isDinosaurComparativeRequest(value: string): boolean {
  return /(?:\bdinosaur(?:s)?\b|\bde[- ]?extinction\b|\bdeextinction\b|\barchosaur(?:s)?\b|\bpaleontolog(?:y|ical)\b|\bfossil(?:s)?\b|\ban?cient DNA\b|\bgenome(?:s|ic)?\b|\bphylogen(?:y|etic)\b|공룡|고생물|멸종복원|복원 가능성)/iu.test(value);
}

function scienceAssistantText(value: string): string {
  // Science is its own product surface. A shared One runtime may still carry
  // the owner's Hope presentation instruction, but that character must never
  // leak into the scientific record. Keep the normalization deliberately
  // narrow so ordinary mentions of Hope inside research prose are untouched.
  return value.replace(/(^|\n)[ \t]*\*\*\[Hope\]\*\*[ \t]*/g, "$1").trim();
}

function eventIdentity(envelope: InvocationEventEnvelope): string {
  const source = envelope.event.sequence == null
    ? `${envelope.event.kind}:${envelope.event.observedAt ?? "unsequenced"}`
    : String(envelope.event.sequence);
  return `science:runtime-event:v1:${envelope.runId}:${source}`;
}

export class ScienceConversationService {
  private readonly removeEventListener: () => void;
  private readonly removeSettledListener: () => void;
  private readonly projectedEventListeners = new Set<(event: ScienceTurnEvent) => void>();
  private accepting = true;

  constructor(
    private readonly store: ScienceStore,
    private readonly runtime: ScienceConversationInvocationRuntime = invocationService,
    private readonly toolRuntime: ScienceConversationToolRuntime | null = null,
    private readonly researchDirectorRuntime: ScienceResearchDirectorRuntime = scienceResearchDirectorRuntime,
    private readonly evidenceGraphService: ScienceEvidenceGraphService | null = null,
  ) {
    this.removeEventListener = this.runtime.onEvent((envelope) => this.projectRuntimeEvent(envelope));
    this.removeSettledListener = this.runtime.onSettled((envelope) => this.handleRuntimeSettlement(envelope));
  }

  close(): void {
    this.removeEventListener();
    this.removeSettledListener();
    this.projectedEventListeners.clear();
  }

  openAdmission(): void {
    this.accepting = true;
  }

  closeAdmission(): void {
    this.accepting = false;
  }

  shutdownForAppClose(): { interruptedTurns: number; cancellationRequests: number } {
    this.closeAdmission();
    let interruptedTurns = 0;
    let cancellationRequests = 0;
    for (const turn of this.store.listRecoverableTurns()) {
      this.toolRuntime?.cancelInvocation(turn.invocationRunId);
      this.revokeToolGrant(turn.invocationRunId);
      const result = this.runtime.cancel(turn.invocationRunId);
      if (result === "requested" || result === "already-requested") {
        cancellationRequests += 1;
      } else {
        this.appendTerminalError(turn, "interrupted", "desktop-app-closed");
        interruptedTurns += 1;
      }
    }
    return { interruptedTurns, cancellationRequests };
  }

  onEvent(listener: (event: ScienceTurnEvent) => void): () => void {
    this.projectedEventListeners.add(listener);
    return () => this.projectedEventListeners.delete(listener);
  }

  start(input: ScienceComposerStartInput): ScienceComposerStartResult {
    if (!this.accepting) throw new Error("science-runtime-closing");
    const existing = this.store.getTurnByRequestId(input.requestId);
    if (existing) {
      if (existing.projectId !== input.projectId || existing.conversationId !== input.conversationId) throw new Error("science-turn-request-scope-conflict");
      if (input.runtimeSelection !== undefined && JSON.stringify(normalizeScienceRuntimeSelection(input.runtimeSelection)) !== JSON.stringify(existing.runtimeSelection ?? null)) {
        throw new Error("science-turn-runtime-selection-conflict");
      }
      const userMessage = this.store.getMessageForProject(existing.projectId, existing.conversationId, existing.userMessageId);
      if (!userMessage) throw new Error("science-turn-user-message-integrity-failed");
      if (existing.status === "queued" && this.runtime.receipt(existing.invocationRunId) === null) {
        try {
          this.dispatchTurn(existing, userMessage, input.locale ?? currentUiLocale());
        } catch (error) {
          this.appendTerminalError(existing, "failed", error instanceof Error ? error.message : "invocation-start-failed");
          throw error;
        }
      }
      return { turn: this.store.getTurnForProject(existing.projectId, existing.id) ?? existing, userMessage, replayed: true };
    }

    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error("science-project-not-found");
    const conversation = this.store.listConversations(input.projectId).find((candidate) => candidate.id === input.conversationId);
    if (!conversation) throw new Error("science-conversation-not-found");
    const runtimeChat = ensureScienceRuntimeChat({ conversationId: conversation.id, title: project.title });
    const binding = this.store.bindConversationRuntime({
      requestId: stableUuid(`science:runtime-binding:v1:${conversation.id}:${runtimeChat.id}`),
      projectId: project.id,
      conversationId: conversation.id,
      runtimeChatId: runtimeChat.id,
    }).binding;
    const invocationRunId = randomUUID();
    const started = this.store.startTurn({
      requestId: input.requestId,
      projectId: project.id,
      conversationId: conversation.id,
      runtimeChatId: binding.runtimeChatId,
      invocationRunId,
      parentTurnId: input.parentTurnId ?? null,
      runtimeSelection: normalizeScienceRuntimeSelection(input.runtimeSelection),
      ...(input.mode === "existing-user-message"
        ? { mode: input.mode, userMessageId: input.userMessageId }
        : input.mode === "append-user-message"
          ? { mode: input.mode, content: input.content }
          : { mode: input.mode, content: input.content, continuationBasis: input.continuationBasis }),
    });
    try {
      this.dispatchTurn(started.turn, started.userMessage, input.locale ?? currentUiLocale());
    } catch (error) {
      const current = this.store.getTurnForProject(project.id, started.turn.id) ?? started.turn;
      // Adapters may have delivered `invoke-started` before throwing or
      // returning a receipt for another run. In either case the durable turn
      // is already running, so a queued-only cleanup leaves it stranded until
      // restart recovery. Close every non-terminal turn with the bounded
      // dispatch cause; the loop reservation was already failed inside
      // dispatchTurn and therefore remains paused.
      if (!["completed", "failed", "cancelled", "interrupted"].includes(current.status)) {
        try {
          this.appendTerminalError(
            current,
            "failed",
            bounded(error instanceof Error ? error.message : String(error), 240) ?? "invocation-start-failed",
          );
        } catch {
          // Preserve the original adapter failure. A later attach/recovery
          // path can still inspect the non-terminal turn if persistence itself
          // was interrupted.
        }
      }
      throw error;
    }
    const turn = this.store.getTurnForProject(project.id, started.turn.id) ?? started.turn;
    return { turn, userMessage: started.userMessage, replayed: started.replayed };
  }

  cancel(input: { projectId: string; conversationId: string; turnId: string }): "requested" | "already-requested" | "terminal" {
    const turn = this.store.getTurnForProject(input.projectId, input.turnId);
    if (!turn || turn.conversationId !== input.conversationId) throw new Error("science-turn-not-found");
    if (["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) {
      // A synchronous settlement can durably create a loop-continuation child
      // before a renderer sends the user's stop for the parent. Follow only
      // that exact active descendant chain; an unrelated new user turn must
      // remain untouched and a terminal parent without a child stays terminal.
      const active = this.store.getActiveTurn(turn.projectId, turn.conversationId);
      const loop = this.store.getActiveLoopSession(turn.projectId);
      if (!active || active.origin !== "loop-continuation"
        || !loop || loop.status !== "running" || loop.activeRunId !== active.invocationRunId) return "terminal";
      let cursor: ScienceTurn | null = active;
      const seen = new Set<string>();
      let descendant = false;
      while (cursor?.parentTurnId && !seen.has(cursor.id)) {
        if (cursor.parentTurnId === turn.id) { descendant = true; break; }
        seen.add(cursor.id);
        cursor = this.store.getTurnForProject(turn.projectId, cursor.parentTurnId);
      }
      if (!descendant) return "terminal";
      return this.cancel({ projectId: active.projectId, conversationId: active.conversationId, turnId: active.id });
    }
    // Close continuation admission before requesting asynchronous adapter
    // cancellation; a simultaneous completed receipt must not spawn a child.
    this.store.pauseLoopAfterControllerSettlement({
      projectId: turn.projectId,
      invocationRunId: turn.invocationRunId,
      receiptStatus: "cancelled",
      errorCode: "researcher-cancelled",
    });
    this.toolRuntime?.cancelInvocation(turn.invocationRunId);
    this.revokeToolGrant(turn.invocationRunId);
    const result = this.runtime.cancel(turn.invocationRunId);
    if (result === "not-found") {
      const receipt = this.runtime.receipt(turn.invocationRunId);
      if (receipt && receipt.status !== "running" && receipt.status !== "cancelling") {
        this.settleRuntimeTurn({
          runId: turn.invocationRunId,
          chatId: turn.runtimeChatId,
          receipt,
          oneMode: false,
          goal: "",
        });
        return "terminal";
      }
      throw new Error("science-runtime-run-not-active");
    }
    return result;
  }

  /**
   * Dispatch exactly one controller turn after an explicit loop resume.
   *
   * The caller must have durably transitioned the loop from paused to queued
   * first. This method never scans for work or resumes a loop at startup; it
   * binds the request to the loop's persisted chat and runtime pin, and
   * idempotently replays an already-created turn when the IPC response is
   * retried.
   */
  resumeLoop(input: {
    requestId: string;
    projectId: string;
    conversationId: string;
    loopSessionId: string;
    expectedLoopVersion: number;
    expectedLoopStateSha256: string;
    locale?: "ko" | "en";
  }): ScienceComposerStartResult {
    const session = this.store.getLoopSessionForProject(input.projectId, input.loopSessionId);
    if (!session) throw new Error("science-loop-not-found");
    if (session.runtimeSelection === null || !session.runtimeSelection.model) {
      throw new Error("science-runtime-selection-required");
    }
    const requestId = stableUuid(`science:loop-resume:v1:${input.requestId}:${session.id}`);
    if (session.status === "running") {
      if (!session.activeRunId) throw new Error("science-loop-running-turn-missing");
      const turn = this.store.getTurnByInvocationRunId(session.activeRunId);
      if (!turn || turn.projectId !== input.projectId || turn.conversationId !== input.conversationId) {
        throw new Error("science-loop-running-turn-missing");
      }
      if (turn.requestId !== requestId) throw new Error("science-loop-resume-request-conflict");
      const userMessage = this.store.getMessageForProject(turn.projectId, turn.conversationId, turn.userMessageId);
      if (!userMessage) throw new Error("science-turn-user-message-integrity-failed");
      return { turn, userMessage, replayed: true };
    }
    const priorResumeTurn = this.store.getTurnByRequestId(requestId);
    if (priorResumeTurn) {
      if (priorResumeTurn.projectId !== input.projectId || priorResumeTurn.conversationId !== input.conversationId) {
        throw new Error("science-loop-resume-request-scope-conflict");
      }
      const userMessage = this.store.getMessageForProject(priorResumeTurn.projectId, priorResumeTurn.conversationId, priorResumeTurn.userMessageId);
      if (!userMessage) throw new Error("science-turn-user-message-integrity-failed");
      return { turn: priorResumeTurn, userMessage, replayed: true };
    }
    if (session.status !== "queued") throw new Error("science-loop-resume-not-queued");
    if (session.version !== input.expectedLoopVersion || session.stateSha256 !== input.expectedLoopStateSha256) {
      throw new Error("science-loop-resume-version-conflict");
    }
    const contract = this.store.getResearchContractForProject(input.projectId, session.contractId);
    if (!contract || contract.status !== "approved" || contract.version !== session.contractVersion) {
      throw new Error("science-loop-contract-changed");
    }
    const lifecycle = this.store.getResearchLifecycleForProject(input.projectId);
    const fullStudyFinalization = contract.completionScope === "full-study"
      && lifecycle?.phase === "ready_to_submit" && lifecycle.status === "complete";
    if (!lifecycle || lifecycle.studyId !== session.lifecycleStudyId
      || (!fullStudyFinalization && lifecycle.status !== "active")
      || lifecycle.openBlockingDecisions.length > 0 || lifecycle.blockers.length > 0
      || this.store.listResearchEpisodes(input.projectId, session.id).some((episode) => episode.status === "waiting-for-decision")) {
      throw new Error("science-loop-researcher-decision-required");
    }
    if (!Number.isFinite(Date.parse(session.deadlineAt)) || Date.now() >= Date.parse(session.deadlineAt)) {
      throw new Error("science-loop-deadline-exhausted");
    }
    if (session.currentEpisode >= session.maxEpisodes) throw new Error("science-loop-episode-budget-exhausted");
    const binding = this.store.getConversationRuntimeBinding(input.projectId, input.conversationId);
    if (!binding || binding.runtimeChatId !== session.runtimeChatId) {
      throw new Error("science-loop-runtime-chat-binding-mismatch");
    }
    const latest = this.store.getLatestTurn(input.projectId, input.conversationId);
    if (!latest) throw new Error("science-loop-resume-turn-missing");
    if (!["completed", "failed", "cancelled", "interrupted"].includes(latest.status)) {
      throw new Error("science-loop-resume-turn-active");
    }
    const continuationBasis = {
      ...(latest.continuationBasis ?? {}),
      schema: "agentlas.science.loop-resume-basis/v1",
      projectId: input.projectId,
      conversationId: input.conversationId,
      loopSessionId: session.id,
      sourceTurnId: latest.id,
      sourceInvocationRunId: latest.invocationRunId,
      loopVersion: session.version,
      loopStateSha256: session.stateSha256,
      noProgressStreak: 0,
    };
    return this.start({
      requestId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      parentTurnId: latest.id,
      mode: "append-controller-message",
      content: "Resume the authorized research loop from its canonical state. Inspect the loop, lifecycle, evidence graph, and exact OCC receipts first. Plan and execute at most one successor episode, complete the loop if verified, or pause at a concrete decision, blocker, deadline, or budget boundary.",
      continuationBasis,
      runtimeSelection: session.runtimeSelection,
      locale: input.locale ?? currentUiLocale(),
    });
  }

  attach(input: { projectId: string; conversationId: string }): ScienceComposerAttachResult | null {
    // A fast failure may finish before the renderer subscribes. Reattach its
    // durable receipt as well; absence of an active run does not mean ready.
    const turn = this.store.getActiveTurn(input.projectId, input.conversationId)
      ?? this.store.getLatestTurn(input.projectId, input.conversationId);
    if (!turn) return null;
    return { turn, events: this.store.listTurnEvents(input.projectId, turn.id) };
  }

  receipt(input: { projectId: string; conversationId: string; turnId: string }): ScienceTurn {
    const turn = this.store.getTurnForProject(input.projectId, input.turnId);
    if (!turn || turn.conversationId !== input.conversationId) throw new Error("science-turn-not-found");
    return turn;
  }

  reconcileAfterRuntimeReady(): { delivered: number; dispatched: number; settled: number; interrupted: number } {
    const delivered = this.drainRuntimeOutbox();
    let dispatched = 0;
    let settled = 0;
    let interrupted = 0;
    for (const turn of this.store.listRecoverableTurns()) {
      const receipt = this.runtime.receipt(turn.invocationRunId);
      if (!receipt) {
        this.appendTerminalError(turn, "interrupted", "manual-resume-required-after-restart");
        interrupted += 1;
        continue;
      }
      if (receipt.status === "running" || receipt.status === "cancelling") {
        const attached = this.runtime.attach(turn.runtimeChatId);
        if (attached?.runId === turn.invocationRunId) continue;
        this.toolRuntime?.cancelInvocation(turn.invocationRunId);
        this.revokeToolGrant(turn.invocationRunId);
        this.runtime.cancel(turn.invocationRunId);
        this.appendTerminalError(turn, "interrupted", "manual-resume-required-after-restart");
        interrupted += 1;
        continue;
      }
      this.settleRuntimeTurn({ runId: turn.invocationRunId, chatId: turn.runtimeChatId, receipt, oneMode: false, goal: "" });
      if (receipt.status === "interrupted") interrupted += 1;
      else settled += 1;
    }
    return { delivered, dispatched, settled, interrupted };
  }

  private dispatchTurn(turn: ScienceTurn, userMessage: ScienceMessage, locale: "ko" | "en"): void {
    const project = this.store.getProject(turn.projectId);
    if (!project) throw new Error("science-project-not-found");
    // Snapshot the host-owned folder before director/loop side effects. Legacy
    // projects keep their existing unbound behavior; prompt text cannot select a path.
    let workspaceBinding: InvocationWorkspaceBinding | undefined;
    if (project.folderPath != null) {
      const canonical = validateScienceProjectFolderPath(project.folderPath);
      if (canonical !== project.folderPath) throw new Error("science-project-folder-selection-changed");
      workspaceBinding = captureScienceInvocationBinding(canonical);
    }
    const dinosaurRouteEnabled = isDinosaurComparativeRequest(
      [project.title, project.question, userMessage.content].filter(Boolean).join("\n"),
    );
    const researchLifecycle = this.store.getResearchLifecycleForProject(project.id);
    if (!researchLifecycle) throw new Error("science-research-lifecycle-canonical-missing");
    const researchLoop = this.store.getActiveLoopSession(project.id);
    const researchContract = this.store.latestResearchContract(project.id);
    const activeResearchEpisode = researchLoop
      ? this.store.listResearchEpisodes(project.id, researchLoop.id).find((episode) => ["planned", "running", "waiting-for-decision"].includes(episode.status)) ?? null
      : null;
    const evidenceGraphContext = this.evidenceGraphService
      ? (() => {
          const refreshed = this.evidenceGraphService!.refresh({
            requestId: stableUuid(`science:evidence-graph-refresh:v1:${turn.invocationRunId}`),
            projectId: project.id,
          });
          const boundedGraph = this.evidenceGraphService!.boundedContext(project.id, userMessage.content, 24);
          return boundedGraph ? {
            revisionId: refreshed.graph.id,
            revision: refreshed.graph.revision,
            contentSha256: refreshed.graph.contentSha256,
            projectionSha256: refreshed.graph.projectionSha256,
            traversal: boundedGraph.traversal,
            nodes: boundedGraph.nodes.map((node) => ({
              id: node.id,
              kind: node.kind,
              assertionKind: node.assertionKind,
              epistemicStatus: node.epistemicStatus,
              label: node.label,
              statement: node.statement,
              canonicalRef: node.canonicalRef,
            })),
            edges: boundedGraph.edges.map((edge) => ({
              id: edge.id,
              kind: edge.kind,
              fromNodeId: edge.fromNodeId,
              toNodeId: edge.toNodeId,
              evidencePathNodeIds: edge.evidencePathNodeIds,
              ruleId: edge.derivation.ruleId,
              reviewStatus: edge.derivation.reviewStatus,
            })),
            inferenceCandidates: boundedGraph.inferenceCandidates,
            inferenceReviews: boundedGraph.reviews,
            literatureChunks: boundedGraph.literatureChunks,
            chunkBindings: boundedGraph.chunkBindings,
            missing: boundedGraph.missing,
          } : null;
        })()
      : null;
    // Science turns are not plugin-router prompts. Main verifies the exact
    // installed workflow package, binds the hidden runtime chat to the stable
    // built-in identity, and only then lets InvocationService resolve the
    // package-owned system prompt from that agent.
    const researchDirector = this.researchDirectorRuntime.bind({
      runtimeChatId: turn.runtimeChatId,
      conversationId: turn.conversationId,
    });
    // Reserve the loop's active run before entering the external runtime. A
    // synchronous adapter may settle during `start()`, so confirming only
    // after that call would resurrect a completed turn as a running loop.
    const loopDispatchState = researchLoop?.status === "queued"
      ? this.store.confirmLoopResumeDispatch({
          projectId: researchLoop.projectId,
          loopSessionId: researchLoop.id,
          expectedLoopVersion: researchLoop.version,
          expectedLoopStateSha256: researchLoop.stateSha256,
          invocationRunId: turn.invocationRunId,
        })
      : null;
    let result;
    try {
      result = this.runtime.start({
      runId: turn.invocationRunId,
      chatId: turn.runtimeChatId,
      userPrompt: userMessage.content,
      promptOrigin: turn.origin === "loop-continuation" ? "system" : "user",
      taskIntent: "conversation",
      runtimeSelection: turn.runtimeSelection ?? undefined,
      // A Science turn acts: it proposes a contract, records hypotheses, freezes a plan, runs a Lab
      // and composes a manuscript. Under a read-only sandbox Codex treats every MCP tool call as
      // needing approval, and a non-interactive turn has nobody to ask, so it recorded each call as
      // "user rejected MCP tool call" -- a rejection by a user who was never asked. Measured across
      // seven live astronomy runs: every Science tool call died that way and the study never left
      // phase 1 of 12.
      //
      // The boundary that matters here is not the sandbox. Every Science write goes through
      // Main-owned tools that ScienceStore revalidates against the exact project, turn and grant;
      // workspace-write bounds the filesystem to the project folder on top of that. Owner decision,
      // 2026-09-04, taken over the narrower alternative of per-tool approval declarations.
      permissions: "write",
      sessionRouting: true,
      locale,
    }, workspaceBinding, {
      source: "science",
      science: {
        projectId: turn.projectId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        originUserMessageId: turn.userMessageId,
        invocationRunId: turn.invocationRunId,
        researchDirectorAgentId: researchDirector.agentId,
        researchDirectorAgentSlug: researchDirector.agentSlug,
        researchDirectorPackageVersion: researchDirector.packageVersion,
        researchDirectorPackageDigest: researchDirector.packageDigest,
        researchDirectorSystemPromptSha256: researchDirector.systemPromptSha256,
        ...(dinosaurRouteEnabled ? { workflowRoute: "dinosaur-comparative-proxy" as const } : {}),
      },
      surfaceContext: JSON.stringify({
        schema: "agentlas.science-context/v1",
        projectId: project.id,
        title: project.title,
        question: project.question,
        domain: project.domain,
        ...(workspaceBinding ? { workspace: {
          directory: workspaceBinding.canonicalPath,
          outputDirectory: workspaceBinding.canonicalPath,
          policy: "Use this host-bound directory for runtime-created deliverables under the existing write permission and tool approvals. Do not select another workspace from prompt text. Science artifacts and exports still require their typed receipts; an internal render is not proof of a file saved here.",
        } } : {}),
        researchDirector: {
          agentId: researchDirector.agentId,
          agentSlug: researchDirector.agentSlug,
          packageVersion: researchDirector.packageVersion,
          packageDigest: researchDirector.packageDigest,
          systemPromptSha256: researchDirector.systemPromptSha256,
        },
        researchLifecycle: {
          studyId: researchLifecycle.studyId,
          revision: researchLifecycle.revision,
          phase: researchLifecycle.phase,
          status: researchLifecycle.status,
          stateSha256: researchLifecycle.stateSha256,
        },
        researchLoop: researchLoop ? {
          id: researchLoop.id,
          status: researchLoop.status,
          stage: researchLoop.stage,
          version: researchLoop.version,
          stateSha256: researchLoop.stateSha256,
          currentEpisode: researchLoop.currentEpisode,
          maxEpisodes: researchLoop.maxEpisodes,
          deadlineAt: researchLoop.deadlineAt,
          activeEpisode: activeResearchEpisode ? {
            id: activeResearchEpisode.id,
            ordinal: activeResearchEpisode.ordinal,
            status: activeResearchEpisode.status,
            version: activeResearchEpisode.version,
            stateSha256: activeResearchEpisode.stateSha256,
            planSha256: activeResearchEpisode.planSha256,
          } : null,
        } : null,
        researchContract: researchContract ? {
          id: researchContract.id,
          version: researchContract.version,
          status: researchContract.status,
          objective: researchContract.objective,
          successCriteria: researchContract.successCriteria,
          failureCriteria: researchContract.failureCriteria,
          constraints: researchContract.constraints,
          completionScope: researchContract.completionScope,
        } : null,
        approvalPolicy: this.store.approvalPolicy(project.id),
        evidenceGraph: evidenceGraphContext,
        provenancePolicy: "Never claim a source, run, artifact, validation, or manuscript binding unless a typed Science tool receipt exists.",
        evidenceGraphPolicy: "Use the bounded exact Evidence Graph for retrieval and gap awareness. Citation edges are not support. Never promote an inference candidate or accepted review to fact; use exact non-invalidated evidence paths and explicit conditioning contexts.",
        researchDirectorPolicy: "This turn is owned by the exact built-in Research Director identity and its verified full workflow prompt. Keep one study state across literature, hypotheses, frozen analysis planning, Lab execution, evidence reconciliation, manuscript versions, and target-journal validation.",
        researchLoopPolicy: "Treat a research request as a persistent objective, not a single response. Propose a contract with evidence-verifiable success criteria and budgets appropriate to the depth requested. Honor Main's exact standing-approval receipt; do not ask again when its contract is approved. Start the authoritative research loop as soon as the authorized contract exists, then build the evidence-bound hypothesis and episode plan. Persist each episode before Lab execution and settle it only with exact run, artifact and evidence receipts. Continue literature, analysis, falsification, independent checks and manuscript revision while criteria remain unmet. A provider turn ending, elapsed minutes, page count or a first manuscript is not goal completion. Verify every success criterion through the loop tools before completion; preserve concrete blockers and budget exhaustion as paused/incomplete. Never describe prose-only iteration as an executed episode.",
        literaturePolicy: dinosaurRouteEnabled
          ? "For a dinosaur or de-extinction question, the dedicated comparative-proxy route has priority over broad literature discovery: call search_paleontology_occurrences first, then advance through the dedicated paleontology/genomics tools in dinosaurResearchRoutePolicy. Use search_academic_literature only as supplementary evidence after the dedicated route has a receipt. Metadata discovery is not full-text verification."
          : "For prior research, novelty, state-of-the-art, citation, related-paper, or literature-review work, call search_academic_literature before answering. Metadata discovery is not full-text verification.",
        statisticsPolicy: "For statistical inference, make the estimand, variables, assumptions, multiplicity handling, diagnostics, and sensitivity plan explicit; freeze confirmatory choices before calling run_statistical_analysis. Persist only its receipt-bound Lab artifact.",
        astronomyPolicy: "For a sky-field or astronomical catalog task, route through the installed @agentlas-astronomy provider policy, call search_astronomy_catalog with exact ICRS coordinates, and then build_astronomy_sky_map from its returned runId. For irregular time-series already stored as an exact immutable Data Table, call analyze_light_curve_periodicity with its exact version/hash, explicit column mapping, time system, period grid, and weighting policy; preserve missing rows and treat the strongest grid period as a candidate, not a confirmed physical period, and interpret any analytic false-alarm upper bound and model period standard error only within the returned assumptions, not as a confidence interval or calibrated discovery claim. Use analyze_light_curve_periodicity_depth when the frozen plan calls for sampling-window, alias, bootstrap, or robustness analysis with explicit inputs. Preserve exact provider bytes and null measurements; never invent catalog rows, impute missing measurements, or bypass the bounded SIMBAD policy.",
        domainPluginPolicy: "Astronomy, Earth-science, physics, and paleontology work may route to the installed @agentlas-astronomy, @agentlas-earth-science, @agentlas-physics, and @agentlas-paleontology plugins. Verify the live tool and preserve provider/raw/normalized receipts; PBDB fossil occurrences support taxonomic, geographic, and stratigraphic claims only and never direct DNA, genome, embryo, hatching, or de-extinction claims; never describe unavailable simulation engines as executed.",
        dinosaurResearchRoute: {
          enabled: dinosaurRouteEnabled,
          priority: [
            "search_paleontology_occurrences",
            "analyze_paleontology_stratigraphic_support",
            "build_extant_reference_assembly_manifest",
            "build_comparative_genomics_gene_tree",
            "run_hypothetical_asr_fitch",
            "materialize_extant_archosaur_locus_panel",
            "assess_deextinction_feasibility",
          ],
          policy: dinosaurRouteEnabled
            ? "For a bounded dinosaur/comparative-proxy study, identify an initial batch of 2–4 named candidate taxa from the user's scope (ask one focused decision if the scope is genuinely missing; a later turn may expand the set to 8), call search_paleontology_occurrences before any academic search, then call analyze_paleontology_stratigraphic_support. Only after those receipts may you build the extant reference assembly and comparative gene tree. Read the comparative tool's dinosaurRoute metadata before ASR or locus-panel execution: use its exact hypotheticalAsrTargetNodeId and locusPanelSelection, and if fewer than two crocodilian leaves are available ask one focused human decision instead of duplicating or relabelling a taxon. Finish with assess_deextinction_feasibility when the sealed evidence set is complete. Advance once per receipt, never repeat an identical query, and do not answer as complete until the dedicated route or an explicit blocking decision is recorded. Fossil and extant-proxy evidence can support comparative feasibility only; never claim recovered dinosaur DNA, a dinosaur genome, a viable embryo, hatching, or biological revival."
            : null,
        },
      }),
      });
      if (result.runId !== turn.invocationRunId) throw new Error("science-invocation-run-receipt-mismatch");
    } catch (error) {
      if (loopDispatchState) {
        try {
          this.store.failLoopResumeDispatch({
            projectId: loopDispatchState.projectId,
            loopSessionId: loopDispatchState.id,
            expectedLoopVersion: loopDispatchState.version,
            expectedLoopStateSha256: loopDispatchState.stateSha256,
            invocationRunId: turn.invocationRunId,
            errorCode: bounded(error instanceof Error ? error.message : String(error), 240) ?? "science-runtime-start-failed",
          });
        } catch { /* a newer canonical Science state wins */ }
      }
      // An adapter may throw after spawning its process. Close this request's
      // tool authority and request cancellation even when no valid start
      // receipt was returned; never cancel the mismatched receipt's other ID.
      try {
        this.appendTerminalError(turn, "failed", bounded(error instanceof Error ? error.message : String(error), 240) ?? "science-runtime-start-failed");
      } catch { /* preserve the dispatch failure if storage is unavailable */ }
      this.revokeToolGrant(turn.invocationRunId);
      try { this.toolRuntime?.cancelInvocation(turn.invocationRunId); } catch { /* preserve the dispatch failure */ }
      try { this.runtime.cancel(turn.invocationRunId); } catch { /* preserve the dispatch failure */ }
      throw error;
    }
  }

  private projectRuntimeEvent(envelope: InvocationEventEnvelope): void {
    if (envelope.scienceDelivery) {
      this.projectRuntimeDelivery(envelope.scienceDelivery);
      return;
    }
    const turn = this.store.getTurnByInvocationRunId(envelope.runId);
    if (!turn || turn.runtimeChatId !== envelope.chatId || ["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) return;
    const genericSequence = envelope.event.sequence ?? null;
    const observedAt = envelope.event.observedAt ?? null;
    const duplicate = this.store.listTurnEvents(turn.projectId, turn.id).some((event) =>
      event.payload.genericSequence === genericSequence
      && event.payload.genericObservedAt === observedAt
      && event.payload.genericKind === envelope.event.kind);
    if (duplicate) return;
    const projected = this.projectEvent(turn, envelope.event);
    const appended = this.store.appendTurnEvent({
      requestId: stableUuid(eventIdentity(envelope)),
      projectId: turn.projectId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      sequence: turn.lastSequence + 1,
      ...projected,
    });
    this.emit(appended.event);
  }

  private projectRuntimeDelivery(delivery: ScienceRuntimeOutboxEvent): void {
    const prior = this.store.getTurnEventBySourceDeliveryId(delivery.deliveryId);
    if (prior) {
      if (prior.invocationRunId !== delivery.runId || prior.sourceRunEventId !== delivery.sourceRunEventId
        || prior.sourceSequence !== delivery.sourceSequence || prior.sourceEventSha256 !== delivery.sourceEventSha256) {
        throw new Error("science-runtime-delivery-integrity-failed");
      }
      markScienceRuntimeOutboxDelivered(delivery.deliveryId);
      return;
    }
    const turn = this.store.getTurnByInvocationRunId(delivery.runId);
    if (!turn) return;
    if (turn.runtimeChatId !== delivery.chatId) throw new Error("science-runtime-delivery-chat-mismatch");
    if (["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) {
      throw new Error("science-runtime-delivery-after-terminal");
    }
    const projected = this.projectEvent(turn, delivery.event);
    const current = this.store.getTurnForProject(turn.projectId, turn.id) ?? turn;
    const appended = this.store.appendTurnEvent({
      requestId: delivery.deliveryId,
      projectId: turn.projectId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      sequence: current.lastSequence + 1,
      sourceDeliveryId: delivery.deliveryId,
      sourceRunEventId: delivery.sourceRunEventId,
      sourceSequence: delivery.sourceSequence,
      sourceEventSha256: delivery.sourceEventSha256,
      ...projected,
    });
    markScienceRuntimeOutboxDelivered(delivery.deliveryId);
    this.emit(appended.event);
  }

  private drainRuntimeOutbox(): number {
    let delivered = 0;
    for (const event of listPendingScienceRuntimeOutboxEvents()) {
      const before = event.status;
      this.projectRuntimeDelivery(event);
      if (before === "pending" && this.store.getTurnEventBySourceDeliveryId(event.deliveryId)) delivered += 1;
    }
    return delivered;
  }

  private projectEvent(turn: ScienceTurn, event: McpInvocationEvent): Pick<Parameters<ScienceStore["appendTurnEvent"]>[0], "kind" | "code" | "payload" | "delta"> {
    const common = {
      genericSequence: event.sequence ?? null,
      genericObservedAt: event.observedAt ?? null,
      genericKind: event.kind,
      ...(event.runtimeSelection ? { runtimeSelection: event.runtimeSelection } : {}),
    };
    if (event.runtimeSelection && turn.runtimeSelection) {
      const actual = event.runtimeSelection;
      const expected = turn.runtimeSelection;
      if (actual.kind !== expected.kind || actual.model !== expected.model
        || (expected.backend && actual.backend !== expected.backend)
        || (expected.source && actual.source !== expected.source)) {
        this.store.pauseLoopAfterControllerSettlement({
          projectId: turn.projectId,
          invocationRunId: turn.invocationRunId,
          receiptStatus: "failed",
          errorCode: "science-runtime-selection-mismatch",
        });
        this.toolRuntime?.cancelInvocation(turn.invocationRunId);
        this.revokeToolGrant(turn.invocationRunId);
        this.runtime.cancel(turn.invocationRunId);
        return { kind: "error", code: "failed", payload: { ...common, errorCode: "science-runtime-selection-mismatch" } };
      }
    }
    if (event.kind === "lifecycle") {
      return {
        kind: "lifecycle",
        code: event.lifecycle?.phase === "cancel_requested" ? "cancel-requested" : "invoke-started",
        payload: { ...common, permission: event.lifecycle?.permission ?? null },
      };
    }
    if (event.kind === "partial") {
      const delta = typeof event.delta === "string"
        ? event.delta
        : typeof event.text === "string" && event.text.startsWith(turn.partialText)
          ? event.text.slice(turn.partialText.length)
          : "";
      if (delta) return { kind: "partial", code: "assistant-delta", payload: { ...common, textLen: event.textLen ?? null }, delta };
      return { kind: "reasoning", code: "partial-checkpoint", payload: { ...common, textLen: event.textLen ?? null } };
    }
    if (event.kind === "tool-use") {
      return {
        kind: "tool",
        code: "tool-observed",
        payload: {
          ...common,
          toolId: bounded(event.tool?.id, 200) ?? null,
          toolName: bounded(event.tool?.name, 200) ?? "unknown",
          isError: event.tool?.isError === true,
          sourceCount: event.tool?.sourceUrls?.length ?? 0,
        },
      };
    }
    if (event.kind === "error") {
      return {
        kind: "error",
        code: "runtime-error-observed",
        payload: { ...common, errorCode: bounded(event.error?.code, 160) ?? "runtime-error", message: bounded(event.error?.message, 1_000) ?? null },
      };
    }
    if (event.kind === "final") {
      return {
        kind: "reasoning",
        code: "runtime-final-observed",
        payload: {
          ...common,
          textLen: event.text?.length ?? 0,
          textSha256: event.text ? createHash("sha256").update(event.text, "utf8").digest("hex") : null,
        },
      };
    }
    if (event.kind === "reasoning" || event.kind === "thinking") {
      return {
        kind: "reasoning",
        code: `runtime-${event.kind}`,
        payload: { ...common, phase: event.reasoning?.phase ?? null, durationMs: event.reasoning?.durationMs ?? null, textLen: event.reasoning?.text?.length ?? event.text?.length ?? 0 },
      };
    }
    return {
      kind: "reasoning",
      code: `runtime-${event.kind}`,
      payload: { ...common, status: bounded(event.status, 500) ?? null, tokens: event.tokens ?? null, surfaceId: bounded(event.surfaceId, 200) ?? null },
    };
  }

  private settleRuntimeTurn(envelope: InvocationSettledEnvelope): void {
    const turn = this.store.getTurnByInvocationRunId(envelope.runId);
    if (!turn || ["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) return;
    if (turn.runtimeChatId !== envelope.chatId || envelope.receipt.chatId !== turn.runtimeChatId) {
      this.appendTerminalError(turn, "failed", "runtime-chat-scope-mismatch");
      return;
    }
    if (envelope.receipt.status === "running" || envelope.receipt.status === "cancelling") return;
    this.revokeToolGrant(turn.invocationRunId);
    if (envelope.receipt.status === "completed") {
      const durable = latestDurableAssistantMessage(turn.runtimeChatId, turn.startedAt ?? turn.createdAt);
      if (!durable) {
        this.store.pauseLoopAfterControllerSettlement({
          projectId: turn.projectId,
          invocationRunId: turn.invocationRunId,
          receiptStatus: envelope.receipt.status,
          errorCode: "result-not-durable",
        });
        this.appendTerminalError(turn, "failed", "result-not-durable");
        return;
      }
      const current = this.store.getTurnForProject(turn.projectId, turn.id) ?? turn;
      const content = scienceAssistantText(durable.text);
      if (!content) {
        this.store.pauseLoopAfterControllerSettlement({
          projectId: turn.projectId,
          invocationRunId: turn.invocationRunId,
          receiptStatus: envelope.receipt.status,
          errorCode: "science-result-empty-after-presentation-normalization",
        });
        this.appendTerminalError(turn, "failed", "science-result-empty-after-presentation-normalization");
        return;
      }
      const settled = this.store.settleAssistantTurn({
        requestId: stableUuid(`science:assistant-settle:v1:${turn.invocationRunId}`),
        projectId: turn.projectId,
        conversationId: turn.conversationId,
        turnId: turn.id,
        sequence: current.lastSequence + 1,
        content,
        payload: {
          runtimeReceiptStatus: envelope.receipt.status,
          coreMessageId: durable.id,
          coreMessageSha256: createHash("sha256").update(durable.text, "utf8").digest("hex"),
        },
      });
      try {
        // Tool calls happen before the runtime's final assistant message exists.
        // Reconcile the exact, pre-validated evidence plans only after the
        // durable message is committed, and before the final UI event is
        // emitted so message readers observe citations atomically enough for
        // the presentation boundary. A mismatch fails closed as a rejected
        // stage; it never fabricates a citation.
        this.store.reconcileStagedMessageEvidence(turn.projectId, turn.id, settled.message.id);
      } catch {
        // The assistant message is already durable and must remain readable.
        // Pending stages remain inspectable and uncited for recovery instead
        // of turning an evidence-reconciliation fault into a false citation.
      }
      this.emit(settled.event);
      this.prepareAndDispatchLoopContinuation(turn, envelope.receipt.status);
      return;
    }
    this.store.pauseLoopAfterControllerSettlement({
      projectId: turn.projectId,
      invocationRunId: turn.invocationRunId,
      receiptStatus: envelope.receipt.status,
      ...(envelope.receipt.errorCode ? { errorCode: bounded(envelope.receipt.errorCode, 240) ?? "runtime-failed" } : {}),
    });
    const status = envelope.receipt.status === "cancelled" ? "cancelled"
      : envelope.receipt.status === "interrupted" ? "interrupted"
        : "failed";
    this.appendTerminalError(turn, status, envelope.receipt.errorCode ?? status);
  }

  private handleRuntimeSettlement(envelope: InvocationSettledEnvelope): void {
    try {
      this.settleRuntimeTurn(envelope);
    } catch (error) {
      const turn = this.store.getTurnByInvocationRunId(envelope.runId);
      if (!turn || ["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) return;
      const cause = error instanceof Error && /^science-[a-z0-9-]+$/.test(error.message)
        ? error.message
        : "runtime-settlement-projection-failed";
      this.appendTerminalError(turn, "failed", cause);
    }
  }

  private prepareAndDispatchLoopContinuation(turn: ScienceTurn, receiptStatus: string): void {
    const loop = this.store.getActiveLoopSession(turn.projectId);
    if (!loop || loop.status !== "running" || loop.activeRunId !== turn.invocationRunId) return;
    const requestId = stableUuid(`science:loop-continuation-prepare:v1:${turn.invocationRunId}:${loop.version}`);
    const targetInvocationRunId = stableUuid(`science:loop-continuation-run:v1:${turn.invocationRunId}:${loop.version}`);
    let prepared;
    try {
      prepared = this.store.prepareLoopContinuationAfterSettlement({
        requestId,
        projectId: turn.projectId,
        conversationId: turn.conversationId,
        sourceTurnId: turn.id,
        sourceInvocationRunId: turn.invocationRunId,
        expectedLoopVersion: loop.version,
        expectedLoopStateSha256: loop.stateSha256,
        receiptStatus,
        targetInvocationRunId,
      });
    } catch (error) {
      // A concurrent researcher pause/cancel or an OCC mismatch is already a
      // valid stop boundary.  Preserve the newer canonical state; only pause
      // an unchanged running session when preparation itself failed.
      try {
        this.store.pauseLoopAfterControllerSettlement({
          projectId: turn.projectId,
          invocationRunId: turn.invocationRunId,
          receiptStatus: "failed",
          errorCode: bounded(error instanceof Error ? error.message : String(error), 240) ?? "science-continuation-preparation-failed",
        });
      } catch { /* the newer loop state wins */ }
      return;
    }
    if (prepared.outcome !== "dispatch") return;
    const userMessage = this.store.getMessageForProject(turn.projectId, turn.conversationId, prepared.turn.userMessageId);
    if (!userMessage) {
      try {
        this.store.failLoopResumeDispatch({
          projectId: prepared.session.projectId,
          loopSessionId: prepared.session.id,
          expectedLoopVersion: prepared.session.version,
          expectedLoopStateSha256: prepared.session.stateSha256,
          errorCode: "science-loop-continuation-message-missing",
        });
      } catch { /* preserve the latest loop state */ }
      return;
    }
    try {
      this.dispatchTurn(prepared.turn, userMessage, currentUiLocale());
    } catch (error) {
      const current = this.store.getTurnForProject(prepared.turn.projectId, prepared.turn.id);
      if (current && !["completed", "failed", "cancelled", "interrupted"].includes(current.status)) {
        this.appendTerminalError(current, "failed", error instanceof Error ? error.message : "loop-continuation-dispatch-failed");
      }
    }
  }

  private appendTerminalError(turn: ScienceTurn, status: "failed" | "cancelled" | "interrupted", errorCode: string): void {
    const current = this.store.getTurnForProject(turn.projectId, turn.id);
    if (!current || ["completed", "failed", "cancelled", "interrupted"].includes(current.status)) return;
    this.store.pauseLoopAfterControllerSettlement({
      projectId: current.projectId,
      invocationRunId: current.invocationRunId,
      receiptStatus: status,
      errorCode: bounded(errorCode, 240) ?? status,
    });
    const appended = this.store.appendTurnEvent({
      requestId: stableUuid(`science:terminal:v1:${turn.invocationRunId}:${status}`),
      projectId: turn.projectId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      sequence: current.lastSequence + 1,
      kind: "error",
      code: status,
      payload: { errorCode: bounded(errorCode, 160) ?? status },
    });
    this.emit(appended.event);
  }

  private revokeToolGrant(invocationRunId: string): void {
    void import("./tool-control-server")
      .then(({ revokeScienceMcpGrant }) => { revokeScienceMcpGrant(invocationRunId); })
      .catch(() => { /* Expiry remains the fail-safe if the bridge never started. */ });
  }

  private emit(event: ScienceTurnEvent): void {
    for (const listener of this.projectedEventListeners) {
      try { listener(event); } catch { /* A closed Science view cannot affect durable runtime state. */ }
    }
  }
}
