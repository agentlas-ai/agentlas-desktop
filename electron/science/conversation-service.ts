import { createHash, randomUUID } from "node:crypto";
import type {
  McpInvocationEvent,
  McpInvocationRequest,
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

export type ScienceComposerStartInput = {
  requestId: string;
  projectId: string;
  conversationId: string;
  locale?: "ko" | "en";
  parentTurnId?: string | null;
} & (
  | { mode: "existing-user-message"; userMessageId: string }
  | { mode: "append-user-message"; content: string }
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
    workspaceBinding?: undefined,
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
    this.removeSettledListener = this.runtime.onSettled((envelope) => this.settleRuntimeTurn(envelope));
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
      const userMessage = this.store.getMessageForProject(existing.projectId, existing.conversationId, existing.userMessageId);
      if (!userMessage) throw new Error("science-turn-user-message-integrity-failed");
      if (existing.status === "queued" && this.runtime.receipt(existing.invocationRunId) === null) {
        this.dispatchTurn(existing, userMessage, input.locale ?? currentUiLocale());
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
      ...(input.mode === "existing-user-message"
        ? { mode: input.mode, userMessageId: input.userMessageId }
        : { mode: input.mode, content: input.content }),
    });
    try {
      this.dispatchTurn(started.turn, started.userMessage, input.locale ?? currentUiLocale());
    } catch (error) {
      const current = this.store.getTurnForProject(project.id, started.turn.id) ?? started.turn;
      if (current.status === "queued") {
        const failed = this.store.appendTurnEvent({
          requestId: stableUuid(`science:dispatch-failed:v1:${current.invocationRunId}`),
          projectId: current.projectId,
          conversationId: current.conversationId,
          turnId: current.id,
          sequence: current.lastSequence + 1,
          kind: "error",
          code: "failed",
          payload: {
            errorCode: "invocation-start-failed",
            message: bounded(error instanceof Error ? error.message : String(error), 1_000) ?? "Invocation start failed",
          },
        });
        this.emit(failed.event);
      }
      throw error;
    }
    const turn = this.store.getTurnForProject(project.id, started.turn.id) ?? started.turn;
    return { turn, userMessage: started.userMessage, replayed: started.replayed };
  }

  cancel(input: { projectId: string; conversationId: string; turnId: string }): "requested" | "already-requested" | "terminal" {
    const turn = this.store.getTurnForProject(input.projectId, input.turnId);
    if (!turn || turn.conversationId !== input.conversationId) throw new Error("science-turn-not-found");
    if (["completed", "failed", "cancelled", "interrupted"].includes(turn.status)) return "terminal";
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

  attach(input: { projectId: string; conversationId: string }): ScienceComposerAttachResult | null {
    const turn = this.store.getActiveTurn(input.projectId, input.conversationId);
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
    const researchLifecycle = this.store.getResearchLifecycleForProject(project.id);
    if (!researchLifecycle) throw new Error("science-research-lifecycle-canonical-missing");
    const researchLoop = this.store.getActiveLoopSession(project.id);
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
    let result;
    try {
      result = this.runtime.start({
      runId: turn.invocationRunId,
      chatId: turn.runtimeChatId,
      userPrompt: userMessage.content,
      promptOrigin: "user",
      taskIntent: "conversation",
      permissions: "read",
      sessionRouting: true,
      locale,
    }, undefined, {
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
      },
      surfaceContext: JSON.stringify({
        schema: "agentlas.science-context/v1",
        projectId: project.id,
        title: project.title,
        question: project.question,
        domain: project.domain,
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
        evidenceGraph: evidenceGraphContext,
        provenancePolicy: "Never claim a source, run, artifact, validation, or manuscript binding unless a typed Science tool receipt exists.",
        evidenceGraphPolicy: "Use the bounded exact Evidence Graph for retrieval and gap awareness. Citation edges are not support. Never promote an inference candidate or accepted review to fact; use exact non-invalidated evidence paths and explicit conditioning contexts.",
        researchDirectorPolicy: "This turn is owned by the exact built-in Research Director identity and its verified full workflow prompt. Keep one study state across literature, hypotheses, frozen analysis planning, Lab execution, evidence reconciliation, manuscript versions, and target-journal validation.",
        researchLoopPolicy: "After the human-approved Research Contract and evidence-bound hypothesis exist, use the authoritative loop tools. Persist an episode plan before Lab execution, then settle it only with exact terminal run, run-backed artifact, and evidence receipts. Never describe prose-only iteration as an executed episode.",
        literaturePolicy: "For prior research, novelty, state-of-the-art, citation, related-paper, or literature-review work, call search_academic_literature before answering. Metadata discovery is not full-text verification.",
        statisticsPolicy: "For statistical inference, make the estimand, variables, assumptions, multiplicity handling, diagnostics, and sensitivity plan explicit; freeze confirmatory choices before calling run_statistical_analysis. Persist only its receipt-bound Lab artifact.",
        astronomyPolicy: "For a sky-field or astronomical catalog task, route through the installed @agentlas-astronomy provider policy, call search_astronomy_catalog with exact ICRS coordinates, and then build_astronomy_sky_map from its returned runId. For irregular time-series already stored as an exact immutable Data Table, call analyze_light_curve_periodicity with its exact version/hash, explicit column mapping, time system, period grid, and weighting policy; preserve missing rows and treat the strongest grid period as a candidate, not a confirmed physical period, because false-alarm probability and period uncertainty are not computed. Preserve exact provider bytes and null measurements; never invent catalog rows, impute missing measurements, or bypass the bounded SIMBAD policy.",
        domainPluginPolicy: "Astronomy, Earth-science, and physics work may route to the installed @agentlas-astronomy, @agentlas-earth-science, and @agentlas-physics plugins. Verify the live tool and preserve provider/raw/normalized receipts; never describe unavailable simulation engines as executed.",
      }),
      });
    } catch (error) {
      if (researchLoop?.status === "queued") {
        try {
          this.store.failLoopResumeDispatch({
            projectId: researchLoop.projectId,
            loopSessionId: researchLoop.id,
            expectedLoopVersion: researchLoop.version,
            expectedLoopStateSha256: researchLoop.stateSha256,
            errorCode: error instanceof Error ? error.message : String(error),
          });
        } catch { /* a newer canonical Science state wins */ }
      }
      throw error;
    }
    if (result.runId !== turn.invocationRunId) throw new Error("science-invocation-run-receipt-mismatch");
    if (researchLoop?.status === "queued") {
      this.store.confirmLoopResumeDispatch({
        projectId: researchLoop.projectId,
        loopSessionId: researchLoop.id,
        expectedLoopVersion: researchLoop.version,
        expectedLoopStateSha256: researchLoop.stateSha256,
        invocationRunId: result.runId,
      });
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
    const common = { genericSequence: event.sequence ?? null, genericObservedAt: event.observedAt ?? null, genericKind: event.kind };
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
    this.store.pauseLoopAfterControllerSettlement({
      projectId: turn.projectId,
      invocationRunId: turn.invocationRunId,
      receiptStatus: envelope.receipt.status,
    });
    if (envelope.receipt.status === "completed") {
      const durable = latestDurableAssistantMessage(turn.runtimeChatId, turn.startedAt ?? turn.createdAt);
      if (!durable) {
        this.appendTerminalError(turn, "failed", "result-not-durable");
        return;
      }
      const current = this.store.getTurnForProject(turn.projectId, turn.id) ?? turn;
      const content = scienceAssistantText(durable.text);
      if (!content) {
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
      return;
    }
    const status = envelope.receipt.status === "cancelled" ? "cancelled"
      : envelope.receipt.status === "interrupted" ? "interrupted"
        : "failed";
    this.appendTerminalError(turn, status, envelope.receipt.errorCode ?? status);
  }

  private appendTerminalError(turn: ScienceTurn, status: "failed" | "cancelled" | "interrupted", errorCode: string): void {
    const current = this.store.getTurnForProject(turn.projectId, turn.id);
    if (!current || ["completed", "failed", "cancelled", "interrupted"].includes(current.status)) return;
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
