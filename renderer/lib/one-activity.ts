import type { AgentMessageDirection, InvocationRunReceipt, McpInvocationEvent, RunEventUi } from "@shared/types";
import type { OneArtifactBindingRequestV1 } from "@shared/one-artifacts";
import { classifyToolFailure, isToolFailureCode, type ToolFailureCode } from "@shared/tool-failure";

export type OneActivityStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "info";
export type OneActivityKind = "run" | "reasoning" | "tool" | "agent" | "notice" | "result" | "terminal";
export type OneActivityCode = "runtime_wait" | "queue_wait" | "recovery_retry" | "session_resume" | "goal_pass_retry";

export type OneHandoffStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * A bounded, typed worker message. This is projected from the existing
 * `agentMessage` envelope; it is not a second chat or a free-form transcript.
 */
export interface OneActivityHandoffMessage {
  reportAvailable?: boolean;
  id: string;
  direction: AgentMessageDirection;
  fromAgentId: string;
  toAgentId: string;
  replyToMessageId?: string;
  /** 이 발언을 만들며 실제로 부른 도구 이름들 — 관측값이지 모델이 쓴 말이 아니다. */
  usedTools?: string[];
  text: string;
  observedAt: string;
}

/**
 * One typed delegation edge and its messages. The edge is intentionally
 * grouped by source/target because the protocol has no separate handoff id.
 * Its task/run binding is supplied by the surrounding One turn block.
 */
export interface OneActivityHandoff {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  fromAgentName?: string;
  toAgentName?: string;
  status: OneHandoffStatus;
  createdAt: string;
  updatedAt: string;
  delegateObserved: boolean;
  messages: OneActivityHandoffMessage[];
  /** A worker terminal signal is distinct from an individual tool failure. */
  workerAgentId?: string;
  workerTerminalStatus?: "completed" | "failed";
}

export interface OneActivityTool {
  name: string;
  args?: string;
  result?: string;
  id?: string;
  isError?: boolean;
  failureCode?: ToolFailureCode;
}

export interface OneActivityItem {
  id: string;
  kind: OneActivityKind;
  status: OneActivityStatus;
  observedAt: string;
  /** Latest typed event updating this row, independent of its original start. */
  updatedAt?: string;
  completedAt?: string;
  durationMs?: number;
  agentName?: string;
  role?: string;
  phase?: "plan" | "delegate" | "synthesize";
  /** Orchestration node identity; several workers may share one accounting agent. */
  agentId?: string;
  model?: string;
  observedModel?: string;
  /** True only for an explicit worker terminal envelope, never whole-turn closure. */
  agentTerminalObserved?: boolean;
  message?: string;
  failureCode?: ToolFailureCode;
  detail?: string;
  noticeLevel?: "info" | "success" | "warning" | "error";
  /** A durable notice carries both product locales so a mirrored screen does not inherit the sender's language. */
  noticeI18n?: { ko: string; en: string };
  activityCode?: OneActivityCode;
  /** notice rows: `divider` marks a conversation boundary (context compaction) — a typed fact, not a wording. */
  noticeDisplay?: "row" | "divider";
  tool?: OneActivityTool;
  /** Characters of the streamed answer so far — only on the live `answer:stream` result row. */
  answerChars?: number;
  /**
   * Reasoning rows only: the model's own summary/thought text for this span
   * (Codex reasoning-summary headline, Claude thinking block, ACP thought chunk).
   * Streams in through `reasoning.delta`; the `end` event may replace it with
   * the full span text (also what the ledger keeps). Never mixed into the answer.
   */
  text?: string;
}

export interface OneActivityArtifact {
  id: string;
  kind: "file" | "image";
  label: string;
  agentName?: string;
  // An artifact is actionable only with Main's opaque, version-pinned binding.
  // The renderer never receives or opens a filesystem path on its own.
  binding: OneArtifactBindingRequestV1;
}

export interface OneActivitySource {
  id: string;
  url: string;
  label: string;
  toolName: string;
  status: OneActivityStatus;
}

export interface OneActivityState {
  items: OneActivityItem[];
  artifacts: OneActivityArtifact[];
  sources: OneActivitySource[];
  handoffs: OneActivityHandoff[];
  tokens?: number;
  lastSequence: number;
  activeReasoningId?: string;
  effectivePermission?: "read" | "write" | "full";
  selectedPermissionMode?: "auto" | "read" | "write" | "full";
  terminalStatus?: "completed" | "failed" | "cancelled";
  /** The run's working folder from the lifecycle start fact — tool paths are shown relative to it. */
  cwd?: string;
  /**
   * Model/runtime label the orchestrator run actually executed with, from the
   * runtime's own `final` event (ledger: mcp_final payload.observedModel). Display =
   * execution (contract 7-C-8 / C-D-1) — never the settings' current default.
   */
  model?: string;
}

/** Same ceiling as Main's reasoning span cap — a thought row is evidence, not a transcript. */
const REASONING_TEXT_CAP = 6_000;

export function initialOneActivityState(): OneActivityState {
  return { items: [], artifacts: [], sources: [], handoffs: [], lastSequence: 0 };
}

/**
 * Show the accepted local dispatch immediately, before Main's first protocol
 * event makes the renderer round trip. This row does not consume a protocol
 * sequence, so the authoritative lifecycle event can still update it at
 * sequence 1 instead of being mistaken for a replay.
 */
export function beginOneActivityState(input: {
  observedAt: string;
  selectedPermissionMode: "auto" | "read" | "write" | "full";
  effectivePermission: "read" | "write" | "full";
}): OneActivityState {
  return {
    items: [{
      id: "run:lifecycle",
      kind: "run",
      status: "running",
      observedAt: input.observedAt,
    }],
    artifacts: [],
    sources: [],
    handoffs: [],
    lastSequence: 0,
    selectedPermissionMode: input.selectedPermissionMode,
    effectivePermission: input.effectivePermission,
  };
}

function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function mergeSources(current: OneActivitySource[], event: McpInvocationEvent): OneActivitySource[] {
  if (event.kind !== "tool-use" || !event.tool || event.tool.isError || !event.tool.sourceUrls?.length) return current;
  const next = [...current];
  for (const url of event.tool.sourceUrls) {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
        || parsed.hostname.endsWith(".invalid")
        || parsed.hostname.endsWith(".local")
      ) continue;
      const normalized = parsed.href;
      const id = `source:${normalized}`;
      const source: OneActivitySource = {
        id,
        url: normalized,
        label: sourceLabel(normalized),
        toolName: event.tool.name,
        status: event.tool.result !== undefined ? "completed" : "running",
      };
      const index = next.findIndex((candidate) => candidate.id === id);
      if (index >= 0) next[index] = { ...next[index], ...source };
      else next.push(source);
    } catch {
      // Source URLs come from untrusted tool text; malformed references never render.
    }
  }
  return next;
}

function closeRunning(
  items: OneActivityItem[],
  completedAt: string,
  status: "completed" | "failed" | "cancelled" = "completed",
  onlyReasoning = false,
): OneActivityItem[] {
  let changed = false;
  const completedMs = Date.parse(completedAt);
  const next = items.map((item) => {
    if ((item.status !== "running" && item.status !== "cancelling") || (onlyReasoning && item.kind !== "reasoning")) return item;
    changed = true;
    const startedMs = Date.parse(item.observedAt);
    return {
      ...item,
      status,
      completedAt,
      ...(Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? { durationMs: Math.max(0, completedMs - startedMs) }
        : {}),
    };
  });
  return changed ? next : items;
}

function upsertItem(items: OneActivityItem[], item: OneActivityItem): OneActivityItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  const next = index >= 0
    ? items.map((candidate, candidateIndex) => candidateIndex === index ? { ...candidate, ...item } : candidate)
    : [...items, item];
  return next;
}

function handoffId(fromAgentId: string, toAgentId: string): string {
  const pair = [fromAgentId, toAgentId].sort();
  return `handoff:${encodeURIComponent(pair[0])}:${encodeURIComponent(pair[1])}`;
}

function nonEmptyAgentId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Project only the existing typed delegation/message fields. No status prose
 * is parsed and no handoff is invented when the protocol lacks a source or
 * target identity.
 */
function mergeHandoffs(
  current: OneActivityHandoff[],
  event: McpInvocationEvent,
  observedAt: string,
): OneActivityHandoff[] {
  const sourceId = nonEmptyAgentId(event.agentMessage?.fromAgentId)
    ?? nonEmptyAgentId(event.agentId)
    ?? nonEmptyAgentId(event.runtimeAgentId);
  if (!sourceId) return current;
  const targets = new Set<string>();
  for (const target of event.delegateTo ?? []) {
    const id = nonEmptyAgentId(target);
    if (id && id !== sourceId) targets.add(id);
  }
  const message = event.agentMessage;
  const messageId = message?.messageId.trim();
  if (messageId) {
    const existingMessage = current
      .flatMap((handoff) => handoff.messages)
      .find((candidate) => candidate.id === messageId);
    if (existingMessage && (
      existingMessage.fromAgentId !== message?.fromAgentId.trim()
      || existingMessage.toAgentId !== message?.toAgentId.trim()
    )) {
      // Message IDs are protocol identities. A replay that reuses one for a
      // different edge is contradictory evidence; keep the first typed owner
      // instead of duplicating it or guessing equivalence from message text.
      return current;
    }
  }
  // `agentId` is the orchestration node used by delegateTo; runtimeAgentId is
  // the installed memory/accounting owner. Topology must prefer the former.
  const observedAgentId = nonEmptyAgentId(event.agentId) ?? nonEmptyAgentId(event.runtimeAgentId);
  const observedAgentName = event.agentName?.trim() || undefined;
  const messageTarget = nonEmptyAgentId(message?.toAgentId);
  if (messageTarget && messageTarget !== sourceId) targets.add(messageTarget);
  if (targets.size === 0 && observedAgentId
    && (event.done || event.agentLifecycle?.state === "failed" || event.nodeState === "failed")) {
    for (const edge of current) {
      if (edge.workerAgentId === observedAgentId) {
        targets.add(edge.fromAgentId === sourceId ? edge.toAgentId : edge.fromAgentId);
      }
    }
  }
  if (targets.size === 0) {
    if (!observedAgentId || !observedAgentName) return current;
    return current.map((candidate) => ({
      ...candidate,
      ...(candidate.fromAgentId === observedAgentId && !candidate.fromAgentName
        ? { fromAgentName: observedAgentName }
        : {}),
      ...(candidate.toAgentId === observedAgentId && !candidate.toAgentName
        ? { toAgentName: observedAgentName }
        : {}),
    }));
  }

  let next = current;
  for (const targetId of targets) {
    const id = handoffId(sourceId, targetId);
    const existing = next.find((candidate) => candidate.id === id);
    const isDelegate = (event.delegateTo ?? []).some((candidate) => candidate.trim() === targetId);
    const matchingMessage = message
      && message.fromAgentId.trim() === sourceId
      && message.toAgentId.trim() === targetId
      && message.messageId.trim()
      && message.text.trim()
        ? {
            id: message.messageId.trim(),
            direction: message.direction,
            fromAgentId: sourceId,
            toAgentId: targetId,
            ...(message.replyToMessageId?.trim()
              ? { replyToMessageId: message.replyToMessageId.trim() }
              : {}),
            ...(message.usedTools && message.usedTools.length > 0
              ? { usedTools: message.usedTools }
              : {}),
            reportAvailable: message.reportAvailable === true,
            text: message.text.trim(),
            observedAt,
          } satisfies OneActivityHandoffMessage
        : undefined;
    const messages = existing?.messages ? [...existing.messages] : [];
    if (matchingMessage) {
      const messageIndex = messages.findIndex((candidate) => candidate.id === matchingMessage.id);
      if (messageIndex >= 0) {
        // A lifecycle event and the room-delivery event may carry the same
        // protocol message at different times. Merge typed enrichment such as
        // replyTo/usedTools while retaining one visible message identity.
        messages[messageIndex] = { ...messages[messageIndex], ...matchingMessage };
      } else {
        messages.push(matchingMessage);
      }
    }
    const hasDeliveredWorkerMessage = messages.some((candidate) => candidate.direction === "worker-to-orchestrator");
    const workerAgentId = matchingMessage?.direction === "worker-to-orchestrator" ? sourceId
      : matchingMessage?.direction === "orchestrator-to-worker" ? targetId
        : existing?.workerAgentId ?? (isDelegate ? targetId : undefined);
    const workerEvent = workerAgentId === (observedAgentId ?? sourceId);
    const newWorkerReply = matchingMessage?.direction === "worker-to-orchestrator"
      && !existing?.messages.some((candidate) => candidate.id === matchingMessage.id);
    const workerTerminalStatus = workerEvent && (event.agentLifecycle?.state === "failed" || event.nodeState === "failed")
      ? "failed" as const
      : workerEvent && (newWorkerReply || event.done && !event.tool?.isError)
        ? "completed" as const
        : existing?.workerTerminalStatus;
    const nextStatus: OneHandoffStatus = workerTerminalStatus
      ?? (hasDeliveredWorkerMessage || existing?.status === "completed"
          ? "completed"
          : event.tool?.isError
            ? "failed"
            : isDelegate
              ? "running"
              : event.done === true
                ? "completed"
                : existing?.status ?? "running");
    const nextHandoff: OneActivityHandoff = {
      id,
      fromAgentId: existing?.fromAgentId ?? sourceId,
      toAgentId: existing?.toAgentId ?? targetId,
      ...(existing?.fromAgentName || observedAgentName && (sourceId === observedAgentId || sourceId === message?.fromAgentId)
        ? { fromAgentName: existing?.fromAgentName ?? observedAgentName }
        : {}),
      ...(existing?.toAgentName || observedAgentName && targetId === observedAgentId
        ? { toAgentName: existing?.toAgentName ?? observedAgentName }
        : {}),
      status: nextStatus,
      createdAt: existing?.createdAt ?? observedAt,
      updatedAt: observedAt,
      delegateObserved: Boolean(existing?.delegateObserved || isDelegate),
      messages,
      ...(workerAgentId ? { workerAgentId } : {}),
      ...(workerTerminalStatus ? { workerTerminalStatus } : {}),
    };
    next = existing
      ? next.map((candidate) => candidate.id === id ? nextHandoff : candidate)
      : [...next, nextHandoff];
  }
  // Worker activity often arrives after the outgoing delegation envelope. Use
  // its typed identity/name to label the target without parsing status copy.
  if (observedAgentId && observedAgentName) {
    next = next.map((candidate) => ({
      ...candidate,
      ...(candidate.fromAgentId === observedAgentId
        ? { fromAgentName: candidate.fromAgentName ?? observedAgentName }
        : {}),
      ...(candidate.toAgentId === observedAgentId
        ? { toAgentName: candidate.toAgentName ?? observedAgentName }
        : {}),
    }));
  }
  return next;
}

function mergeVerifiedSurfaceArtifacts(
  current: OneActivityArtifact[],
  event: McpInvocationEvent,
): OneActivityArtifact[] {
  // Main-owned `oneArtifacts` binding is the sole artifact source. Raw tool
  // result text is deliberately retained only inside its Activity row.
  if (!event.oneArtifacts?.length) return current;
  const next = [...current];
  for (const artifact of event.oneArtifacts) {
    const binding: OneArtifactBindingRequestV1 = {
      taskId: artifact.taskId,
      taskVersion: artifact.taskVersion,
      chatId: artifact.chatId,
      runId: artifact.runId,
      manifestId: artifact.manifestId,
      artifactRef: artifact.artifactRef,
    };
    const kind: OneActivityArtifact["kind"] = artifact.type === "image" ? "image" : "file";
    const nextArtifact: OneActivityArtifact = {
      id: `bound:${artifact.runId}:${artifact.artifactRef}`,
      kind,
      label: artifact.label,
      binding,
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
    };
    const normalizedLabel = nextArtifact.label.trim().toLocaleLowerCase();
    let index = next.findIndex((candidate) => candidate.id === nextArtifact.id);
    if (index < 0) index = next.findIndex((candidate) => (
      candidate.kind === nextArtifact.kind
      && candidate.binding.taskId === binding.taskId
      && candidate.binding.chatId === binding.chatId
      && candidate.label.trim().toLocaleLowerCase() === normalizedLabel
    ));
    if (index >= 0) next[index] = { ...next[index], ...nextArtifact };
    else next.push(nextArtifact);
  }
  return next;
}

/**
 * One activity is a projection of the structured runtime protocol only.
 * Free-form status strings never choose a stage or become progress copy.
 */
export function reduceOneActivity(
  state: OneActivityState,
  event: McpInvocationEvent,
): OneActivityState {
  const hasTypedSequence = Number.isSafeInteger(event.sequence);
  const incomingSequence = hasTypedSequence ? Number(event.sequence) : null;
  // Reattach/replay can deliver an already-applied suffix. A typed sequence is
  // an identity, not a suggestion that may be renumbered.
  if (incomingSequence !== null && incomingSequence <= state.lastSequence) return state;
  // A terminal turn is immutable. Late provider/tool events must not reopen it.
  if (state.terminalStatus) return state;
  const sequence = incomingSequence !== null
    ? incomingSequence
    : state.lastSequence + 1;
  const observedAt = event.observedAt || new Date().toISOString();
  let items = state.items;
  let activeReasoningId = state.activeReasoningId;
  let tokens = state.tokens;
  let effectivePermission = state.effectivePermission;
  let selectedPermissionMode = state.selectedPermissionMode;
  let cwd = state.cwd;
  let model = state.model;
  let handoffs = state.handoffs;
  let terminalStatus: OneActivityState["terminalStatus"] = undefined;

  // A node finishing is independent of the envelope kind. Worker completion
  // often arrives on a tool-use with no tool, before the overall run ends.
  const topologyAgentId = event.agentId || event.runtimeAgentId;
  if (event.done && topologyAgentId) {
    items = items.map((item) => item.kind === "agent" && item.agentId === topologyAgentId
      && (!event.phase || item.phase === event.phase) ? {
        ...item,
        status: event.tool?.isError || event.agentLifecycle?.state === "failed" || event.nodeState === "failed" ? "failed" : "completed",
        completedAt: observedAt,
        agentTerminalObserved: true,
        updatedAt: observedAt,
        ...(event.observedModel?.trim() ? { observedModel: event.observedModel.trim() } : {}),
        ...(event.model || event.runtimeSelection?.model ? { model: event.model || event.runtimeSelection?.model } : {}),
      } : item);
  }

  // Delegation and worker-message envelopes are orthogonal to the event kind
  // (`firm-orchestrator` emits them on tool-use), so project them before the
  // ordinary activity branches. This keeps the existing runtime contract and
  // gives the chat a read-only handoff projection.
  if (
    event.delegateTo?.length
    || event.agentMessage
    || (event.agentName?.trim() && (event.agentId || event.runtimeAgentId))
  ) {
    handoffs = mergeHandoffs(handoffs, event, observedAt);
  }

  if (event.kind === "lifecycle" && event.lifecycle?.phase === "start") {
    effectivePermission = event.lifecycle.permission ?? effectivePermission;
    selectedPermissionMode = event.lifecycle.selectedPermissionMode ?? selectedPermissionMode;
    if (typeof event.lifecycle.cwd === "string" && event.lifecycle.cwd.trim()) cwd = event.lifecycle.cwd.trim();
    // ★ 차례를 기다리는 것은 도는 것이 아니다 (2026-08-23).
    //   큐에 들어간 실행도 같은 lifecycle:start 로 오는데, 그 사실(status)을 여기서
    //   안 보고 무조건 "도는 중"으로 적었다. 그래서 아무도 안 집은 실행이 화면에서는
    //   이미 일하는 것으로 보였고, 사용자는 아무 일도 안 일어나는 진행 표시를 보다가
    //   다시 보낸다 — 그 재전송이 큐를 더 밀어 올린다.
    //   상태는 그대로 running 으로 둔다(끝맺음·취소 판정이 전부 이 값에 걸려 있다).
    //   달라지는 것은 **사람에게 뭐라고 말하는가** 하나다.
    items = upsertItem(items, {
      id: "run:lifecycle",
      kind: "run",
      status: "running",
      ...(event.status === "queued" ? { activityCode: "queue_wait" as const } : {}),
      observedAt,
    });
  } else if (event.kind === "lifecycle" && event.lifecycle?.phase === "cancel_requested") {
    items = items.map((item) => item.kind === "run" && item.status === "running"
      ? { ...item, status: "cancelling" }
      : item);
  } else if (event.kind === "usage") {
    if (typeof event.tokens === "number" && Number.isFinite(event.tokens)) {
      tokens = Math.max(tokens ?? 0, event.tokens);
    }
  } else if (event.kind === "reasoning" && event.reasoning?.phase === "start") {
    const id = `reasoning:${sequence}`;
    items = upsertItem(items, {
      id,
      kind: "reasoning",
      status: "running",
      observedAt,
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
    });
    activeReasoningId = id;
  } else if (event.kind === "reasoning" && event.reasoning?.phase === "delta") {
    // A delta can arrive before the runner's explicit start (some runtimes emit
    // text first). Open the span implicitly so no thought text is ever lost.
    let id = activeReasoningId;
    if (!id) {
      id = `reasoning:${sequence}`;
      items = upsertItem(items, { id, kind: "reasoning", status: "running", observedAt });
      activeReasoningId = id;
    }
    const chunk = typeof event.reasoning.text === "string" ? event.reasoning.text : "";
    if (chunk) {
      const target = id;
      items = items.map((item) => item.id === target
        ? { ...item, text: `${item.text ?? ""}${chunk}`.slice(0, REASONING_TEXT_CAP) }
        : item);
    }
  } else if (event.kind === "reasoning" && event.reasoning?.phase === "end") {
    const id = activeReasoningId;
    const fullText = typeof event.reasoning.text === "string" && event.reasoning.text.trim()
      ? event.reasoning.text.slice(0, REASONING_TEXT_CAP)
      : undefined;
    if (id) {
      items = items.map((item) => item.id === id ? {
        ...item,
        status: "completed",
        completedAt: observedAt,
        ...(typeof event.reasoning?.durationMs === "number"
          ? { durationMs: Math.max(0, event.reasoning.durationMs) }
          : {}),
        ...(fullText ? { text: fullText } : {}),
      } : item);
      activeReasoningId = undefined;
    } else if (fullText) {
      // Ledger replay: the start row may be older than the retained window, or
      // a runner reported a whole summary in one end event. Keep the thought.
      items = upsertItem(items, {
        id: `reasoning:${sequence}`,
        kind: "reasoning",
        status: "completed",
        observedAt,
        completedAt: observedAt,
        text: fullText,
        ...(typeof event.reasoning?.durationMs === "number"
          ? { durationMs: Math.max(0, event.reasoning.durationMs) }
          : {}),
      });
    }
  } else if (event.kind === "thinking") {
    // The legacy provider bridge emits one generic owner `thinking` pulse for
    // almost every turn. Rendering it beside the lifecycle row duplicates
    // "Working" and makes a no-tool greeting look like orchestration. Show an
    // agent item only when the protocol carries an actual typed phase/tier.
    if (
      (event.agentId || event.runtimeAgentId || event.agentName)
      && (event.phase !== undefined || (event.tier ?? 1) > 1)
    ) {
      const agentId = event.agentId || event.runtimeAgentId;
      const id = agentId ? `agent:${agentId}:${event.phase || "work"}` : `agent:unattributed:${sequence}`;
      const existing = items.find((item) => item.id === id);
      items = upsertItem(items, {
        id,
        kind: "agent",
        status: event.nodeState === "failed" || event.agentLifecycle?.state === "failed" ? "failed" : event.done ? "completed" : "running",
        observedAt: existing?.observedAt || observedAt,
        ...(agentId ? { agentId } : {}),
        updatedAt: observedAt,
        agentTerminalObserved: Boolean(event.done || event.nodeState === "failed" || event.agentLifecycle?.state === "failed"),
        ...(event.model || event.runtimeSelection?.model ? { model: event.model || event.runtimeSelection?.model } : {}),
        ...(event.observedModel?.trim() ? { observedModel: event.observedModel.trim() }
          : existing?.observedModel ? { observedModel: existing.observedModel } : {}),
        ...(event.done ? { completedAt: observedAt } : {}),
        ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
        ...(event.role?.trim() ? { role: event.role.trim() } : {}),
        ...(event.phase ? { phase: event.phase } : {}),
      });
    } else if (
      !(event.agentId || event.runtimeAgentId || event.agentName)
      && !activeReasoningId
    ) {
      const id = `reasoning:${sequence}`;
      items = upsertItem(items, { id, kind: "reasoning", status: "running", observedAt });
      activeReasoningId = id;
    }
  } else if (
    event.kind === "tool-use"
    && event.tool
    // Host plugin-universe discovery is invocation plumbing, not work the
    // user asked One to perform. It must not become two fake tool rows at the
    // start of every greeting or promote the conversation to a Task.
    && !event.tool.name.trim().startsWith("Agentlas Plugins ·")
  ) {
    items = closeRunning(items, observedAt, "completed", true);
    activeReasoningId = undefined;
    const toolActor = event.agentId || event.runtimeAgentId;
    const matchingIds = event.tool.id ? items.filter((item) => item.kind === "tool"
      && item.tool?.id === event.tool?.id && (!toolActor || item.agentId === toolActor)) : [];
    const existing = event.tool.id
      ? matchingIds.length === 1 ? matchingIds[0] : undefined
      : [...items].reverse().find((item) => (
          item.kind === "tool"
          && item.status === "running"
          && item.agentId === toolActor
          && item.tool?.name === event.tool?.name
        ));
    const id = existing?.id || (toolActor
      ? `tool:${JSON.stringify([toolActor, event.tool.id || sequence])}`
      : `tool:${event.tool.id || sequence}`);
    const status: OneActivityStatus = event.tool.isError
      ? "failed"
      : event.tool.result !== undefined
        ? "completed"
        : "running";
    const failureCode = event.tool.isError
      ? classifyToolFailure({
          explicitCode: event.tool.failureCode,
          result: event.tool.result,
          status: event.status,
        })
      : undefined;
    items = upsertItem(items, {
      id,
      kind: "tool",
      status,
      observedAt: existing?.observedAt || observedAt,
      updatedAt: observedAt,
      ...(status !== "running" ? { completedAt: observedAt } : {}),
      ...(event.agentId || event.runtimeAgentId ? { agentId: event.agentId || event.runtimeAgentId } : existing?.agentId ? { agentId: existing.agentId } : {}),
      ...(event.model || event.runtimeSelection?.model ? { model: event.model || event.runtimeSelection?.model } : existing?.model ? { model: existing.model } : {}),
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : existing?.agentName ? { agentName: existing.agentName } : {}),
      ...(event.role?.trim() ? { role: event.role.trim() } : {}),
      // A completion event often repeats the tool without its arguments. A
      // spread copies `args: undefined` over the start event's real args and
      // the live row loses its command until the ledger replays it — keep
      // only the keys the new event actually carries.
      tool: {
        ...existing?.tool,
        ...Object.fromEntries(Object.entries(event.tool).filter(([, value]) => value !== undefined)),
        ...(failureCode ? { failureCode } : {}),
      } as OneActivityTool,
    });
  } else if (event.kind === "tool-use" && event.activity) {
    const activityActor = event.agentId || event.runtimeAgentId;
    const id = activityActor ? `notice:${JSON.stringify([activityActor, event.activity.code])}` : `notice:${event.activity.code}`;
    const existing = items.find((item) => item.id === id);
    items = upsertItem(items, {
      id,
      kind: "notice",
      status: "info",
      observedAt: existing?.observedAt || observedAt,
      activityCode: event.activity.code,
      updatedAt: observedAt,
      ...(event.agentId || event.runtimeAgentId ? { agentId: event.agentId || event.runtimeAgentId } : {}),
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
      noticeLevel: "info",
    });
  } else if (event.kind === "notice" && event.notice?.message) {
    items = upsertItem(items, {
      id: `notice:${sequence}`,
      kind: "notice",
      status: event.notice.level === "error" ? "failed" : "info",
      observedAt,
      message: event.notice.message,
      // A runtime accounting identity alone is not a worker node.
      ...(event.agentId || (event.agentName?.trim() && event.runtimeAgentId)
        ? { agentId: event.agentId || event.runtimeAgentId } : {}),
      detail: event.notice.details,
      noticeLevel: event.notice.level,
      ...(event.role?.trim() ? { role: event.role.trim() } : {}),
      ...(event.phase ? { phase: event.phase } : {}),
      ...(event.model || event.runtimeSelection?.model ? { model: event.model || event.runtimeSelection?.model } : {}),
      ...(event.notice.display ? { noticeDisplay: event.notice.display } : {}),
      ...(event.notice.i18n?.ko?.trim() && event.notice.i18n?.en?.trim()
        ? { noticeI18n: { ko: event.notice.i18n.ko.trim(), en: event.notice.i18n.en.trim() } }
        : {}),
      ...(event.agentName?.trim() ? { agentName: event.agentName.trim() } : {}),
    });
  } else if (event.kind === "surface") {
    items = closeRunning(items, observedAt);
    activeReasoningId = undefined;
    items = upsertItem(items, {
      id: `result:${event.surfaceId || event.oneSurface?.manifestId || sequence}`,
      kind: "result",
      status: "completed",
      observedAt,
      completedAt: observedAt,
    });
  } else if (event.kind === "partial") {
    items = closeRunning(items, observedAt, "completed", true);
    activeReasoningId = undefined;
    // The answer is streaming. Without this the timeline sat on the run row's
    // generic "Working" for the whole generation (measured: 45s of "Working"
    // while 300 lines were visibly arriving underneath). Say what is happening
    // and how far along, the way tool rows do; the row closes on final/error.
    // Live partials are deltas: the size lives in `textLen`; replay/fallback
    // partials still carry the accumulated `text`.
    const answerLength = typeof event.textLen === "number" && Number.isFinite(event.textLen)
      ? event.textLen
      : typeof event.text === "string"
        ? event.text.length
        : 0;
    const existing = items.find((item) => item.id === "answer:stream");
    items = upsertItem(items, {
      id: "answer:stream",
      kind: "result",
      status: "running",
      observedAt: existing?.observedAt || observedAt,
      answerChars: Math.max(existing?.answerChars ?? 0, answerLength),
    });
  } else if (event.kind === "final") {
    // The answer row is closed by closeRunning below; settle its final size.
    // A ledger replay never saw the live partials (they are not persisted),
    // so the row is created here from the recorded length instead of vanishing
    // from Activity the moment the run settles.
    const finalAnswerChars = typeof event.textLen === "number" && Number.isFinite(event.textLen)
      ? event.textLen
      : typeof event.text === "string"
        ? event.text.length
        : null;
    if (finalAnswerChars != null && finalAnswerChars > 0) {
      const existing = items.find((item) => item.id === "answer:stream");
      items = upsertItem(items, {
        id: "answer:stream",
        kind: "result",
        status: existing?.status ?? "running",
        observedAt: existing?.observedAt || observedAt,
        answerChars: Math.max(existing?.answerChars ?? 0, finalAnswerChars),
      });
    }
    items = closeRunning(items, observedAt);
    activeReasoningId = undefined;
    if (!items.some((item) => item.kind === "run")) {
      items = upsertItem(items, {
        id: `terminal:${sequence}`,
        kind: "terminal",
        status: "completed",
        observedAt,
        completedAt: observedAt,
      });
    }
    if (typeof event.tokens === "number" && Number.isFinite(event.tokens)) {
      tokens = Math.max(tokens ?? 0, event.tokens);
    }
    // The orchestrator's own final event names what actually ran this turn.
    // Worker events never reach this branch (they end as tool-use rows), so
    // this is the run-level execution model, not a delegate's (C-D-1).
    if (typeof event.observedModel === "string" && event.observedModel.trim()) model = event.observedModel.trim();
    terminalStatus = "completed";
  } else if (event.kind === "error") {
    // A run the person stopped ends through the same error channel as a
    // runtime failure; the earlier cancel_requested lifecycle fact (or an
    // explicit cancel code) tells them apart. "Stopped" is not "failed".
    // Typed facts only — never the wording of the message.
    const cancelled = /^(?:cancelled|canceled|interrupted|user_cancelled|user-cancelled|aborted_by_user)$/i.test(event.error?.code ?? "")
      || items.some((item) => item.status === "cancelling");
    const status = cancelled ? "cancelled" : "failed";
    const failureCode = !cancelled
      ? classifyToolFailure({ explicitCode: event.error?.code, result: event.error?.message })
      : "cancelled" as const;
    const meaningfulFailureCode = failureCode === "tool_failed" ? undefined : failureCode;
    items = closeRunning(items, observedAt, status);
    activeReasoningId = undefined;
    // Keep the reason on the run row so the turn block can say why it failed
    // (Codex shows the runtime's error inline; a bare "failed" is not enough).
    if (!cancelled && event.error?.message?.trim()) {
      const reason = event.error.message.trim();
      items = items.map((item) => item.kind === "run" && item.status === "failed" && !item.message
        ? { ...item, message: reason, ...(meaningfulFailureCode ? { failureCode: meaningfulFailureCode } : {}) }
        : item);
    }
    if (!items.some((item) => item.kind === "run")) {
      items = upsertItem(items, {
        id: `terminal:${sequence}`,
        kind: "terminal",
        status,
        observedAt,
        completedAt: observedAt,
        message: event.error?.message,
        ...(meaningfulFailureCode ? { failureCode: meaningfulFailureCode } : {}),
      });
    }
    terminalStatus = status;
  }

  if (terminalStatus) {
    handoffs = handoffs.map((handoff) => handoff.status === "running"
      ? { ...handoff, status: terminalStatus === "cancelled" ? "cancelled" : terminalStatus, updatedAt: observedAt }
      : handoff);
  }

  return {
    items,
    artifacts: mergeVerifiedSurfaceArtifacts(state.artifacts, event),
    sources: mergeSources(state.sources, event),
    handoffs,
    ...(tokens !== undefined ? { tokens } : {}),
    lastSequence: sequence,
    ...(activeReasoningId ? { activeReasoningId } : {}),
    ...(effectivePermission ? { effectivePermission } : {}),
    ...(selectedPermissionMode ? { selectedPermissionMode } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
  };
}

function ledgerString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ledgerToolFailureCode(payload: Record<string, unknown>): ToolFailureCode | undefined {
  const value = ledgerString(payload, "toolFailureCode");
  return isToolFailureCode(value) ? value : undefined;
}

function ledgerBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Restore only the existing typed state contract, never status/error prose. */
function ledgerAgentState(payload: Record<string, unknown>): Pick<McpInvocationEvent, "agentLifecycle" | "nodeState"> {
  const state = payload.agentProcessState;
  const reason = payload.agentProcessReason;
  const nodeState = payload.nodeState;
  const lifecycle: McpInvocationEvent["agentLifecycle"] = payload.agentProcessSource === "cli-process"
    && (state === "running" || state === "idle" || state === "closed" || state === "failed")
    && (reason === "spawned" || reason === "turn-started" || reason === "turn-complete"
      || reason === "transport-closed" || reason === "process-exit" || reason === "reaped"
      || reason === "shutdown" || reason === "evicted" || reason === "error")
    ? { source: "cli-process" as const, state, reason,
        ...(ledgerString(payload, "agentProcessRuntime") ? { runtime: ledgerString(payload, "agentProcessRuntime") } : {}) }
    : undefined;
  return {
    ...(lifecycle ? { agentLifecycle: lifecycle } : {}),
    ...(nodeState === "pending" || nodeState === "running" || nodeState === "done" || nodeState === "failed" || nodeState === "skipped"
      ? { nodeState } : {}),
  };
}

function ledgerStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  const accepted = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  return accepted.length > 0 ? [...new Set(accepted)] : undefined;
}

function ledgerAgentMessage(payload: Record<string, unknown>): NonNullable<McpInvocationEvent["agentMessage"]> | undefined {
  const messageId = ledgerString(payload, "agentMessageId");
  const direction = ledgerString(payload, "agentMessageDirection");
  const fromAgentId = ledgerString(payload, "agentMessageFrom");
  const toAgentId = ledgerString(payload, "agentMessageTo");
  const replyToMessageId = ledgerString(payload, "agentMessageReplyTo");
  const text = ledgerString(payload, "agentMessageText");
  const usedTools = Array.isArray(payload.agentMessageTools)
    ? payload.agentMessageTools.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 12)
    : [];
  if (!messageId || !fromAgentId || !toAgentId || !text) return undefined;
  if (direction !== "orchestrator-to-worker" && direction !== "worker-to-orchestrator") return undefined;
  return {
    messageId, direction, fromAgentId, toAgentId,
    reportAvailable: payload.agentMessageReportAvailable === true,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(usedTools.length > 0 ? { usedTools } : {}),
    text,
  };
}

function ledgerHttpsUrls(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) return undefined;
  const urls = value.filter((item): item is string => {
    if (typeof item !== "string") return false;
    try {
      const parsed = new URL(item);
      return parsed.protocol === "https:"
        && !parsed.username
        && !parsed.password
        && !parsed.hostname.endsWith(".invalid")
        && !parsed.hostname.endsWith(".local");
    } catch {
      return false;
    }
  });
  return urls.length ? urls : undefined;
}

function ledgerOneArtifacts(payload: Record<string, unknown>): NonNullable<McpInvocationEvent["oneArtifacts"]> | undefined {
  const value = payload.oneArtifacts;
  if (!Array.isArray(value)) return undefined;
  const accepted = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const type = row.type;
    if (
      typeof row.taskId !== "string" || typeof row.taskVersion !== "number" || !Number.isSafeInteger(row.taskVersion)
      || typeof row.chatId !== "string" || typeof row.runId !== "string" || typeof row.manifestId !== "string"
      || typeof row.artifactRef !== "string" || typeof row.label !== "string"
      || !["document", "spreadsheet", "image", "video", "audio", "archive", "data", "other"].includes(String(type))
    ) return [];
    return [{
      taskId: row.taskId,
      taskVersion: row.taskVersion,
      chatId: row.chatId,
      runId: row.runId,
      manifestId: row.manifestId,
      artifactRef: row.artifactRef,
      label: row.label,
      type: type as NonNullable<McpInvocationEvent["oneArtifacts"]>[number]["type"],
      ...(typeof row.sizeBytes === "number" && Number.isSafeInteger(row.sizeBytes) ? { sizeBytes: row.sizeBytes } : {}),
    }];
  });
  return accepted.length ? accepted : undefined;
}

function ledgerPermission(value: unknown): "read" | "write" | "full" | undefined {
  return value === "read" || value === "write" || value === "full" ? value : undefined;
}

function ledgerPermissionMode(value: unknown): "auto" | "read" | "write" | "full" | undefined {
  return value === "auto" || value === "read" || value === "write" || value === "full"
    ? value
    : undefined;
}

function ledgerActivityCode(value: unknown): NonNullable<McpInvocationEvent["activity"]>["code"] | undefined {
  return value === "runtime_wait" || value === "queue_wait" || value === "recovery_retry" || value === "session_resume" || value === "goal_pass_retry"
    ? value
    : undefined;
}

function ledgerNoticeI18n(payload: Record<string, unknown>): { ko: string; en: string } | undefined {
  const value = payload.noticeI18n;
  let candidate: unknown = value;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const ko = typeof record.ko === "string" ? record.ko.trim() : "";
  const en = typeof record.en === "string" ? record.en.trim() : "";
  return ko && en ? { ko, en } : undefined;
}

/** Rebuild the latest Activity from Main's redacted append-only run ledger. */
export function projectOneActivityFromLedger(events: RunEventUi[], receipt?: InvocationRunReceipt | null): OneActivityState {
  let state = initialOneActivityState();
  let projectedSequence = 0;
  const observedToolIds = new Set<string>();
  const apply = (event: Omit<McpInvocationEvent, "sequence" | "observedAt">, observedAt: string) => {
    projectedSequence += 1;
    state = reduceOneActivity(state, { ...event, sequence: projectedSequence, observedAt });
  };

  // A stop arrives as mcp_error followed by invoke_cancelled. The first row
  // would otherwise seal the run as "failed" before the cancel row is read.
  const cancelledRun = events.some((row) => row.kind === "invoke_cancelled" || row.kind === "invoke_interrupted");
  for (const row of events) {
    const payload = row.payload ?? {};
    if (row.kind.startsWith("task_force_model_call_") && row.nodeId) {
      const callPhase = ledgerString(payload, "phase");
      const phase = callPhase === "planner" ? "plan" : callPhase === "worker" ? "delegate" : undefined;
      // A model return is not a validated handoff or a completed worker.
      // Call-start can add the requested model; only an explicit node done closes it.
      if (phase && row.kind === "task_force_model_call_completed" && ledgerString(payload, "observedModel")) {
        apply({ kind: "thinking", agentId: row.nodeId, phase, observedModel: ledgerString(payload, "observedModel") }, row.ts);
      }
      if (phase && row.kind === "task_force_model_call_started") {
        apply({ kind: "thinking", agentId: row.nodeId, phase,
          ...(ledgerString(payload, "runtimeModel") ? { model: ledgerString(payload, "runtimeModel") } : {}),
        }, row.ts);
      }
      continue;
    }
    if (row.kind === "invoke_started") {
      const permission = ledgerPermission(payload.permissions);
      const selectedPermissionMode = ledgerPermissionMode(payload.onePermissionMode);
      apply({
        kind: "lifecycle",
        lifecycle: {
          phase: "start",
          ...(permission ? { permission } : {}),
          ...(selectedPermissionMode ? { selectedPermissionMode } : {}),
        },
      }, row.ts);
      continue;
    }
    if (row.kind === "mcp_lifecycle") {
      // The desktop lifecycle fact carries the run's working folder; the
      // invoke_started row above does not.
      const lifecycleCwd = ledgerString(payload, "lifecycleCwd");
      if (ledgerString(payload, "lifecyclePhase") === "start" && lifecycleCwd) {
        apply({ kind: "lifecycle", lifecycle: { phase: "start", cwd: lifecycleCwd } }, row.ts);
      }
      continue;
    }
    if (row.kind === "invoke_cancel_requested") {
      apply({ kind: "lifecycle", lifecycle: { phase: "cancel_requested" } }, row.ts);
      continue;
    }
    if (row.kind === "mcp_tool-use") {
      const agentState = ledgerAgentState(payload);
      const toolName = ledgerString(payload, "toolName");
      const toolId = ledgerString(payload, "toolId");
      const delegateTo = ledgerStringArray(payload, "delegateTo");
      const agentMessage = ledgerAgentMessage(payload);
      const toolIsError = ledgerBoolean(payload, "toolIsError") === true;
      const toolSourceUrls = ledgerHttpsUrls(payload, "toolSourceUrls");
      const oneArtifacts = ledgerOneArtifacts(payload);
      const topologyAgentId = ledgerString(payload, "agentNodeId") || row.nodeId || row.agentId;
      const done = ledgerBoolean(payload, "done");
      const rawPhase = ledgerString(payload, "phase");
      const phase = rawPhase === "plan" || rawPhase === "delegate" || rawPhase === "synthesize" ? rawPhase : undefined;
      if (toolName) {
        // A ledger row that carries a result preview is a completion even when
        // the tool id was never observed (single-event runners like agy DONE).
        const toolArgs = ledgerString(payload, "toolArgs");
        const rawResultPreview = payload.toolResultPreview;
        const hasResultPreview = typeof rawResultPreview === "string";
        const isCompletion = toolIsError || hasResultPreview || Boolean(toolId && observedToolIds.has(toolId));
        const toolFailureCode = toolIsError
          ? classifyToolFailure({
              explicitCode: ledgerToolFailureCode(payload),
              result: rawResultPreview,
              status: payload.status,
            })
          : undefined;
        if (toolId) observedToolIds.add(toolId);
        const agentName = ledgerString(payload, "agentName");
        const role = ledgerString(payload, "role");
        apply({
          kind: "tool-use",
          ...agentState,
          ...(ledgerString(payload, "observedModel") ? { observedModel: ledgerString(payload, "observedModel") } : {}),
          tool: {
            name: toolName,
            ...(toolId ? { id: toolId } : {}),
            ...(toolArgs ? { args: toolArgs } : {}),
            ...(isCompletion ? { result: hasResultPreview ? (rawResultPreview as string) : "" } : {}),
            ...(toolIsError ? { isError: true } : {}),
            ...(toolFailureCode ? { failureCode: toolFailureCode } : {}),
            ...(toolSourceUrls ? { sourceUrls: toolSourceUrls } : {}),
          },
          ...(topologyAgentId ? { agentId: topologyAgentId } : {}),
          ...(phase ? { phase } : {}),
          ...(done ? { done: true } : {}),
          ...(agentName ? { agentName } : {}),
          ...(role ? { role } : {}),
          ...(oneArtifacts ? { oneArtifacts } : {}),
          ...(delegateTo ? { delegateTo } : {}),
          ...(agentMessage ? { agentMessage } : {}),
        }, row.ts);
        continue;
      }
      if (delegateTo || agentMessage || done || agentState.agentLifecycle || agentState.nodeState) {
        const agentName = ledgerString(payload, "agentName");
        const role = ledgerString(payload, "role");
        const topologyAgentId = ledgerString(payload, "agentNodeId") || row.agentId;
        const rawPhase = ledgerString(payload, "phase");
        const phase = rawPhase === "plan" || rawPhase === "delegate" || rawPhase === "synthesize"
          ? rawPhase
          : undefined;
        apply({
          kind: "tool-use",
          ...agentState,
          ...(ledgerString(payload, "observedModel") ? { observedModel: ledgerString(payload, "observedModel") } : {}),
          ...(topologyAgentId ? { agentId: topologyAgentId } : {}),
          ...(ledgerString(payload, "runtimeAgentId")
            ? { runtimeAgentId: ledgerString(payload, "runtimeAgentId") }
            : {}),
          ...(agentName ? { agentName } : {}),
          ...(role ? { role } : {}),
          ...(phase ? { phase } : {}),
          ...(done ? { done: true } : {}),
          ...(delegateTo ? { delegateTo } : {}),
          ...(agentMessage ? { agentMessage } : {}),
        }, row.ts);
        continue;
      }
      const activityCode = ledgerActivityCode(payload.activityCode);
      if (activityCode) {
        apply({ kind: "tool-use", activity: { code: activityCode } }, row.ts);
      }
      continue;
    }
    if (row.kind === "mcp_reasoning") {
      const phase = ledgerString(payload, "reasoningPhase");
      if (phase === "start" || phase === "end") {
        const durationValue = Number(payload.reasoningDurationMs);
        const reasoningText = ledgerString(payload, "reasoningText");
        apply({
          kind: "reasoning",
          reasoning: {
            phase,
            ...(phase === "end" && Number.isFinite(durationValue)
              ? { durationMs: Math.max(0, durationValue) }
              : {}),
            ...(phase === "end" && reasoningText ? { text: reasoningText } : {}),
          },
        }, row.ts);
      }
      continue;
    }
    if (row.kind === "mcp_thinking") {
      const agentName = ledgerString(payload, "agentName");
      const role = ledgerString(payload, "role");
      const delegateTo = ledgerStringArray(payload, "delegateTo");
      const rawPhase = ledgerString(payload, "phase");
      const phase = rawPhase === "plan" || rawPhase === "delegate" || rawPhase === "synthesize"
        ? rawPhase
        : undefined;
      apply({
        kind: "thinking",
        ...ledgerAgentState(payload),
        ...(ledgerString(payload, "agentNodeId") || row.nodeId || row.agentId
          ? { agentId: ledgerString(payload, "agentNodeId") || row.nodeId || row.agentId! } : {}),
        ...(ledgerString(payload, "runtimeModel") || ledgerString(payload, "model")
          ? { model: ledgerString(payload, "runtimeModel") || ledgerString(payload, "model") } : {}),
        ...(ledgerBoolean(payload, "done") ? { done: true } : {}),
        ...(agentName ? { agentName } : {}),
        ...(role ? { role } : {}),
        ...(phase ? { phase } : {}),
        ...(delegateTo ? { delegateTo } : {}),
      }, row.ts);
      continue;
    }
    if (row.kind === "mcp_notice") {
      // Host capture bindings also arrive as notices. Preserve them during
      // durable catchup even when the notification has no display text.
      const oneArtifacts = ledgerOneArtifacts(payload)?.filter((artifact) =>
        artifact.runId === row.runId && artifact.chatId === row.chatId);
      const noticeI18n = ledgerNoticeI18n(payload);
      const message = ledgerString(payload, "noticeMessage") || noticeI18n?.en || noticeI18n?.ko;
      const rawLevel = ledgerString(payload, "noticeLevel");
      const level = rawLevel === "info" || rawLevel === "success" || rawLevel === "warning" || rawLevel === "error"
        ? rawLevel
        : "info";
      const display = ledgerString(payload, "noticeDisplay");
      // agent_id may be the enclosing runtime's accounting identity. Only
      // an explicit topology node or a named legacy actor groups this notice.
      const noticeAgentId = ledgerString(payload, "agentNodeId") || row.nodeId
        || (ledgerString(payload, "agentName") ? row.agentId : undefined);
      if (message || oneArtifacts?.length) {
        apply({
          kind: "notice",
          ...(oneArtifacts?.length ? { oneArtifacts } : {}),
          notice: {
            level,
            message: message ?? "",
            ...(ledgerString(payload, "noticeCode") ? { code: ledgerString(payload, "noticeCode") } : {}),
            ...(noticeI18n ? { i18n: noticeI18n } : {}),
            ...(ledgerString(payload, "noticeDetails") ? { details: ledgerString(payload, "noticeDetails") } : {}),
            ...(display === "row" || display === "divider" ? { display } : {}),
          },
          ...(noticeAgentId ? { agentId: noticeAgentId } : {}),
          ...(ledgerString(payload, "agentName") ? { agentName: ledgerString(payload, "agentName") } : {}),
          ...(ledgerString(payload, "role") ? { role: ledgerString(payload, "role") } : {}),
          ...(["plan", "delegate", "synthesize"].includes(ledgerString(payload, "phase") ?? "")
            ? { phase: ledgerString(payload, "phase") as "plan" | "delegate" | "synthesize" } : {}),
          ...(ledgerString(payload, "runtimeModel") || ledgerString(payload, "model")
            ? { model: ledgerString(payload, "runtimeModel") || ledgerString(payload, "model") } : {}),
        }, row.ts);
      }
      continue;
    }
    if (row.kind === "mcp_surface") {
      const oneArtifacts = ledgerOneArtifacts(payload);
      apply({ kind: "surface", surfaceId: ledgerString(payload, "surfaceId"), ...(oneArtifacts ? { oneArtifacts } : {}) }, row.ts);
      continue;
    }
    if (row.kind === "mcp_final" || row.kind === "invoke_completed") {
      // Main may persist settlement immediately before the richer final event.
      // Do not freeze replay before its actual model receipt is consumed.
      if (row.kind === "invoke_completed" && events.some((event) => event.kind === "mcp_final" && event.runId === row.runId)) continue;
      const tokenValue = Number(payload.tokens);
      const textLenValue = Number(payload.textLen);
      const executedModel = ledgerString(payload, "observedModel");
      apply({
        kind: "final",
        ...(Number.isFinite(tokenValue) ? { tokens: tokenValue } : {}),
        ...(Number.isFinite(textLenValue) && textLenValue > 0 ? { textLen: textLenValue } : {}),
        // 실행 기록의 모델 표기(C-D-1): 원장에 남은 final의 observedModel이 유일한
        // "실제 실행" 근거다 — 재방문/재기동 후에도 표시=실행이 유지된다.
        ...(executedModel ? { observedModel: executedModel } : {}),
      }, row.ts);
      continue;
    }
    if (row.kind === "mcp_error" || row.kind === "invoke_failed" || row.kind === "invoke_cancelled" || row.kind === "invoke_interrupted") {
      const cancelled = row.kind === "invoke_cancelled" || row.kind === "invoke_interrupted" || cancelledRun;
      apply({
        kind: "error",
        error: {
          code: cancelled ? "cancelled" : ledgerString(payload, "errorCode") || "runtime_error",
          message: ledgerString(payload, "errorMessage") || (cancelled ? "Run cancelled" : "Run stopped"),
        },
      }, row.ts);
    }
  }
  // The bounded event page can omit the terminal row. Main's exact-run
  // receipt supplies lifecycle facts without expanding the page or inventing
  // outcomes for individual tools/workers whose completion rows are absent.
  if (receipt?.runId && events.every((row) => row.runId === receipt.runId
    && (!row.chatId || row.chatId === receipt.chatId))) {
    const startedMs = Date.parse(receipt.startedAt);
    const finishedMs = receipt.finishedAt ? Date.parse(receipt.finishedAt) : NaN;
    const status: OneActivityStatus = receipt.status === "interrupted" ? "cancelled" : receipt.status;
    if (Number.isFinite(startedMs)) {
      const settled = status === "completed" || status === "failed" || status === "cancelled";
      const measured = settled && Number.isFinite(finishedMs) && finishedMs >= startedMs;
      const previous = state.items.find((item) => item.kind === "run");
      const { durationMs: _duration, completedAt: _completed, ...detail } = previous ?? {};
      const lifecycle: OneActivityItem = {
        ...detail, id: "run:lifecycle", kind: "run", status, observedAt: receipt.startedAt,
        ...(measured ? { completedAt: receipt.finishedAt, durationMs: finishedMs - startedMs } : {}),
      };
      state = { ...state, items: [...state.items.filter((item) => item.kind !== "run"), lifecycle] };
    }
  }
  return state;
}

/**
 * Host automation-registration receipts, promoted out of the collapsed work
 * rows. `electron/mcp/client.ts` confirms each `## Automation` block with an
 * `automation.create` / `automation.update` tool event whose args carry
 * { name, schedule, targetType, targetId, graph }; the One conversation renders
 * those receipts as first-class Automation cards instead of a generic notice
 * line. Pure projection — this never invents a registration the host did not
 * report, and a refused registration (isError) stays a plain error row.
 */
export interface OneAutomationRegistration {
  /** Stable per-turn identity — the source activity item's id. */
  itemId: string;
  action: "created" | "updated";
  name: string;
  schedule?: string;
  targetType?: string;
  targetId?: string;
  graph?: boolean;
}

const AUTOMATION_REGISTRATION_TOOL_RE = /^automation\.(create|update)$/;

export function extractAutomationRegistrations(state: OneActivityState): OneAutomationRegistration[] {
  const registrations: OneAutomationRegistration[] = [];
  for (const item of state.items) {
    if (item.kind !== "tool" || !item.tool || item.tool.isError) continue;
    const match = AUTOMATION_REGISTRATION_TOOL_RE.exec(item.tool.name.trim());
    if (!match) continue;
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(item.tool.args ?? "");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      args = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) continue;
    registrations.push({
      itemId: item.id,
      action: match[1] === "create" ? "created" : "updated",
      name,
      ...(typeof args.schedule === "string" && args.schedule.trim() ? { schedule: args.schedule.trim() } : {}),
      ...(typeof args.targetType === "string" ? { targetType: args.targetType } : {}),
      ...(typeof args.targetId === "string" ? { targetId: args.targetId } : {}),
      ...(typeof args.graph === "boolean" ? { graph: args.graph } : {}),
    });
  }
  return registrations;
}
