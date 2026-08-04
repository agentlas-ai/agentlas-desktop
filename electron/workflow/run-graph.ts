// 워크플로우 그래프 러너 — 기존 runMcpInvocation dispatch 위의 얇은 위상 워커(설계 §4.4).
// 각 노드는 엔진이 이미 실행하는 무언가로 컴파일된다: agent 노드는 McpInvocationRequest,
// tool 노드는 인접 agent 런타임에 붙는 MCP 설정, action/output/condition/transform는 인러너.
// per-run 변수 백 Record<string,unknown>이 위상 워크를 관통하며 {{var}} 치환을 구동한다
// (promptTemplate이 늘 약속했던 파라미터화, 설계 한계 #12).
//
// 실행 엔진은 손대지 않는다 — 러너는 "어떤 요청을 어떤 순서로 runMcpInvocation에 넘길지"만 결정.
import type {
  Automation,
  WorkflowGraph,
  WorkflowNode,
  McpInvocationEvent,
  WorkflowNodeRunState,
} from "../../shared/types";
import { createHash, randomUUID } from "node:crypto";
import { runMcpInvocation } from "../mcp/client";
import type { WorkforcePrepareCheckpointReceipt } from "../mcp/workforce-orchestrator";
import { listChatMessages } from "../store/chats";
import { getOrCreateAutomationSession } from "../store/automation-sessions";
import {
  startGraphRun,
  checkpointGraphRunNode,
  getLatestFailedGraphCheckpoint,
  saveGraphRunCheckpoint,
  updateGraphRunNode,
  finishGraphRun,
  getNodeApproval,
  getLatestNodeApproval,
  saveGraphRunFailures,
  consumeGraphResumeCoordinate,
  appendGraphJournal,
} from "../store/automations";
import { getAgentById } from "../mcp/registry";
import { getFirm } from "../store/firms";
import { getAgentConcurrency } from "../store/concurrency";
import { listRunEvents, tryRecordFailureEvent, tryRecordRunEvent } from "../store/run-events";
import { awaitAutomationRunnerWithAbortGrace } from "../automation-watchdog";
import { buildStrategyDirective, collectAutomationFailureContext } from "../automation-strategy";
import { AUTOMATION_CONTINUITY_OPEN, AUTOMATION_CONTINUITY_CLOSE } from "../automation-continuity";
import { graphInputRequirement } from "../../shared/graph-trigger-input";

type EventSink = (ev: McpInvocationEvent) => void;

export interface RunGraphOptions {
  sink?: EventSink;
  signal?: AbortSignal;
  /** 이 실행의 안정 id — automation_runs 스냅샷 키(라이브 오버레이 재하이드레이트). */
  runId?: string;
  /** Exact durable source occurrence. Retries only resume this same id. */
  occurrenceId?: string;
  /** Source payload variables used only when creating a new occurrence checkpoint. */
  initialVars?: Record<string, unknown>;
  /** Abort 후 취소를 무시하는 노드를 기다릴 정리 유예. 테스트는 짧게 주입한다. */
  abortGraceMs?: number;
  /**
   * 시뮬레이션 실행. 외부에 나가는 변경을 막고, 무엇이 막혔는지 영수증으로 남긴다.
   * 켜지면 ① 모든 노드 호출이 읽기 권한으로 강등되고(런타임이 쓰기를 거부한다),
   * ② 부수효과 노드(effect: "mutation")는 아예 호출하지 않고 모의 결과를 돌려준다.
   */
  dryRun?: boolean;
}

/** 노드가 바깥 세상에 무엇을 하는가. 선언하지 않으면 시뮬레이션에서 변경으로 간주한다(fail-closed). */
export type GraphNodeEffect = "pure" | "read" | "mutation";

/** 시뮬레이션 영수증 한 줄 — "실전이었으면 무엇이 일어났는가". */
export type GraphDryRunBlock = {
  nodeId: string;
  nodeLabel: string;
  effect: GraphNodeEffect;
  reason: string;
};

/**
 * 노드 단위 실행 상한. 선언이 없으면 이 값이 걸린다 — 상한 없는 노드는 무한정 붙잡혀
 * 있을 수 있고, 실행 전체를 보는 워치독은 "활동이 없는 것"만 잡지 "끝나지 않는 것"은 못 잡는다.
 */
const DEFAULT_NODE_TIMEOUT_MS = 60 * 60 * 1000;
const MIN_NODE_TIMEOUT_MS = 1_000;

function nodeTimeoutMs(node: WorkflowNode): number {
  const raw = node.config?.timeoutSeconds;
  const seconds = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (seconds === null) return DEFAULT_NODE_TIMEOUT_MS;
  return Math.max(MIN_NODE_TIMEOUT_MS, Math.floor(seconds * 1000));
}

function nodeEffect(node: WorkflowNode): GraphNodeEffect {
  const raw = str(node.config, "effect");
  return raw === "pure" || raw === "read" || raw === "mutation" ? raw : "read";
}

/**
 * 이 단계를 사람이 먼저 확인해야 하는가.
 * - `auto`(기본): 확인 없이 진행.
 * - `ask`: 실행할 때마다 확인.
 * - `ask_once`: 이 노드를 처음 내보낼 때 한 번만 확인.
 */
export type GraphNodeApprovalTier = "auto" | "ask" | "ask_once";

function nodeApprovalTier(node: WorkflowNode): GraphNodeApprovalTier {
  const raw = str(node.config, "approval");
  if (raw === "ask" || raw === "ask_once") return raw;
  // 선언이 없으면 자동. 다만 바깥을 바꾸는 단계는 기본을 "매번 확인"으로 둔다 —
  // 되돌리기 어려운 일을 아무 말 없이 내보내는 쪽이 더 큰 사고다(D20).
  if (raw === "auto") return "auto";
  return nodeEffect(node) === "mutation" ? "ask" : "auto";
}

/**
 * 이 노드를 몇 번까지 다시 시도해도 되는가.
 *
 * 재시도는 "같은 일이 두 번 일어나도 괜찮다"가 보장될 때만 안전하다. 바깥을 바꾸는
 * 단계는 멱등 키를 선언했을 때만 자동 재시도를 허용하고, 선언이 없으면 0회 —
 * 게시가 나갔는지 모르는 채로 다시 누르는 것이 가장 흔한 이중 발행 사고다.
 */
function nodeMaxAttempts(node: WorkflowNode): number {
  const declared = node.config?.retries;
  if (typeof declared === "number" && Number.isFinite(declared) && declared >= 0) {
    // 변경 단계는 멱등 선언 없이 재시도 횟수만 올릴 수 없다 — 그 조합이 이중 발행이다.
    if (nodeEffect(node) === "mutation" && !str(node.config, "idempotencyKey")) return 1;
    return Math.min(5, Math.floor(declared)) + 1;
  }
  if (nodeEffect(node) === "mutation") {
    return str(node.config, "idempotencyKey") ? 3 : 1;
  }
  return 3;
}

/** 사용자가 재시도를 명시적으로 켰는가 — 근거 없는 재시도와 구분한다. */
function retriesDeclared(node: WorkflowNode): boolean {
  const declared = node.config?.retries;
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0;
}

/** 일시 오류 재시도 간격 — 같은 순간에 몰려 다시 실패하지 않게 지수적으로 벌린다. */
function retryBackoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1));
}

function nodeMaxTokens(node: WorkflowNode): number | null {
  const raw = node.config?.maxTokens;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

function durableInitialVars(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("automation_trigger_context_invalid: initial vars must be an object");
  }
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error("automation_trigger_context_invalid: initial vars are not JSON durable");
  }
  if (!json || Buffer.byteLength(json, "utf8") > 256 * 1024) {
    throw new Error("automation_trigger_context_invalid: initial vars exceed the durable limit");
  }
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("automation_trigger_context_invalid: initial vars are not a record");
  }
  return parsed as Record<string, unknown>;
}

export interface RunGraphResult {
  ok: boolean;
  /** 노드 id → 최종 텍스트 출력. */
  outputs: Record<string, string>;
  /** produces 이름 → 값(변수 백 스냅샷). */
  vars: Record<string, unknown>;
  error?: string;
  /**
   * 노드 id → 실패 3요소. UI 실패 카드는 이 값을 렌더한다 —
   * 사유 원문 없이 코드만 보여주거나, 지금 누를 행동 없이 실패만 알리는 표면은 결함이다.
   */
  nodeFailures?: Record<string, GraphNodeFailure>;
  /** 시뮬레이션 실행이었는가. 결과를 실전 결과로 오해하지 않도록 항상 함께 전달한다. */
  dryRun?: boolean;
  /** 시뮬레이션에서 막은 부수효과 목록(실전이었으면 일어났을 일). */
  dryRunBlocks?: GraphDryRunBlock[];
  /** 이번 실행이 실제로 쓴 토큰(런타임 보고 합계). */
  tokensUsed?: number;
  /** 상한이 선언됐는데 런타임이 사용량을 보고하지 않아 집행할 수 없었는가. */
  budgetUnmeasured?: boolean;
}

const GRAPH_CHECKPOINT_SCHEMA = "agentlas.automation-graph-checkpoint.v3";
const LEGACY_GRAPH_CHECKPOINT_SCHEMA = "agentlas.automation-graph-checkpoint.v2";
const WORKFORCE_PREPARE_RECEIPT_SCHEMA = "agentlas.workforce-prepare-checkpoint-receipt.v1";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

type GraphToolReceipt = {
  name: string;
  resultDigest: string;
  readOnly: boolean;
  succeeded: boolean;
};

export type GraphCheckpoint = {
  schemaVersion: typeof GRAPH_CHECKPOINT_SCHEMA;
  occurrenceId: string;
  graphDigest: string;
  effectNodeIds: string[];
  completedNodeIds: string[];
  skippedNodeIds: string[];
  blockedEdgeIds: string[];
  inFlightNodeIds: string[];
  ambiguousNodeIds: string[];
  outputs: Record<string, string>;
  vars: Record<string, unknown>;
  nodeInputDigests: Record<string, string>;
  toolReceipts: Record<string, GraphToolReceipt[]>;
  prepareReceipts: Record<string, WorkforcePrepareCheckpointReceipt[]>;
  updatedAt: string;
  checkpointDigest: string;
};

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

function sha256Value(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex")}`;
}

function graphExecutionDigest(automation: Automation, graph: WorkflowGraph): string {
  return sha256Value({
    graph,
    targetType: automation.targetType,
    targetId: automation.targetId,
    targetVersion: automation.targetVersion ?? null,
    promptTemplate: automation.promptTemplate,
    executionPermission: automation.executionPermission ?? "write",
    toolMode: automation.toolMode ?? "auto",
    hubMode: automation.hubMode ?? "hub-allowed",
    runtimeSelection: automation.runtimeSelection ?? null,
  });
}

function hubTargetForNode(
  automation: Automation,
  node: WorkflowNode,
): { slug: string; version: string | null } | null {
  if (node.type === "agent") {
    const ref = str(node.config, "ref");
    const nodeTargetType = str(node.config, "targetType");
    if (nodeTargetType === "hub" && ref) {
      return {
        slug: ref,
        version: str(node.config, "targetVersion") ??
          (automation.targetType === "hub" && automation.targetId === ref
            ? automation.targetVersion ?? null
            : null),
      };
    }
    if (!ref && automation.targetType === "hub") {
      return { slug: automation.targetId, version: automation.targetVersion ?? null };
    }
    return null;
  }
  if ((node.type === "action" || node.type === "output") && automation.targetType === "hub") {
    return { slug: automation.targetId, version: automation.targetVersion ?? null };
  }
  return null;
}

function checkpointPayload(checkpoint: GraphCheckpoint): Omit<GraphCheckpoint, "checkpointDigest"> {
  const { checkpointDigest: _checkpointDigest, ...payload } = checkpoint;
  return payload;
}

function sealCheckpoint(checkpoint: GraphCheckpoint): GraphCheckpoint {
  checkpoint.updatedAt = new Date().toISOString();
  checkpoint.checkpointDigest = sha256Value(checkpointPayload(checkpoint));
  return checkpoint;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rows = Object.entries(value as Record<string, unknown>);
  if (rows.some(([, child]) => typeof child !== "string")) return null;
  return Object.fromEntries(rows) as Record<string, string>;
}

export function parseWorkforcePrepareCheckpointReceipt(
  value: unknown,
  expectedOccurrenceId: string,
): WorkforcePrepareCheckpointReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const exactKeys = [
    "schemaVersion", "occurrenceId", "idempotencyKey", "preparationReceiptId",
    "requestDigest", "responseDigest", "workOrderDigest", "selectionDigest",
    "federatedSelectionDigest", "selectedSourcePinDigests", "candidateSetDigest",
    "selectionReceiptId", "executionContextDigest", "preparedReleasesDigest", "receiptDigest",
  ];
  if (Object.keys(row).sort().join("\u0000") !== exactKeys.sort().join("\u0000")) return null;
  const boundedString = (key: string, max = 512): string | null => {
    const value = row[key];
    return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
      ? value
      : null;
  };
  const sha = (key: string): string | null => {
    const value = boundedString(key, 71);
    return value && SHA256_RE.test(value) ? value : null;
  };
  const occurrenceId = boundedString("occurrenceId");
  const preparationReceiptId = boundedString("preparationReceiptId");
  const selectionReceiptId = boundedString("selectionReceiptId");
  const idempotencyKey = sha("idempotencyKey");
  const requestDigest = sha("requestDigest");
  const responseDigest = sha("responseDigest");
  const workOrderDigest = sha("workOrderDigest");
  const selectionDigest = sha("selectionDigest");
  const federatedSelectionDigest = sha("federatedSelectionDigest");
  const candidateSetDigest = sha("candidateSetDigest");
  const executionContextDigest = sha("executionContextDigest");
  const preparedReleasesDigest = sha("preparedReleasesDigest");
  const receiptDigest = sha("receiptDigest");
  const rawSelectedSourcePinDigests = Array.isArray(row.selectedSourcePinDigests)
    ? row.selectedSourcePinDigests
    : null;
  const selectedSourcePinDigests = rawSelectedSourcePinDigests
    ? rawSelectedSourcePinDigests.filter((digest): digest is string => typeof digest === "string")
    : [];
  if (
    row.schemaVersion !== WORKFORCE_PREPARE_RECEIPT_SCHEMA ||
    occurrenceId !== expectedOccurrenceId || !preparationReceiptId || !selectionReceiptId ||
    !idempotencyKey || !requestDigest || !responseDigest || !workOrderDigest || !selectionDigest ||
    !federatedSelectionDigest || !candidateSetDigest || !executionContextDigest ||
    !preparedReleasesDigest || !receiptDigest ||
    selectedSourcePinDigests.length < 1 || selectedSourcePinDigests.length > 128 ||
    !rawSelectedSourcePinDigests ||
    selectedSourcePinDigests.length !== rawSelectedSourcePinDigests.length ||
    selectedSourcePinDigests.some((digest) => !SHA256_RE.test(digest)) ||
    new Set(selectedSourcePinDigests).size !== selectedSourcePinDigests.length
  ) return null;
  const attemptPayload = {
    schemaVersion: "agentlas.workforce-prepare-attempt.v1",
    occurrenceId,
    workOrderDigest,
    selectionDigest,
    federatedSelectionDigest,
    selectedSourcePinDigests,
  };
  if (idempotencyKey !== sha256Value(attemptPayload)) return null;
  const receiptPayload = {
    schemaVersion: WORKFORCE_PREPARE_RECEIPT_SCHEMA as typeof WORKFORCE_PREPARE_RECEIPT_SCHEMA,
    occurrenceId,
    idempotencyKey,
    preparationReceiptId,
    requestDigest,
    responseDigest,
    workOrderDigest,
    selectionDigest,
    federatedSelectionDigest,
    selectedSourcePinDigests,
    candidateSetDigest,
    selectionReceiptId,
    executionContextDigest,
    preparedReleasesDigest,
  };
  if (receiptDigest !== sha256Value(receiptPayload)) return null;
  return { ...receiptPayload, receiptDigest };
}

export function parseGraphCheckpoint(
  value: unknown,
  expectedGraphDigest: string,
  expectedOccurrenceId: string | null,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>,
  expectedEffectNodeIds: ReadonlySet<string>,
): GraphCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const legacy = row.schemaVersion === LEGACY_GRAPH_CHECKPOINT_SCHEMA;
  if (!legacy && row.schemaVersion !== GRAPH_CHECKPOINT_SCHEMA) return null;
  const exactKeys = [
    "schemaVersion", "occurrenceId", "graphDigest", "effectNodeIds", "completedNodeIds", "skippedNodeIds",
    "blockedEdgeIds", "inFlightNodeIds", "ambiguousNodeIds", "outputs", "vars",
    "nodeInputDigests", "toolReceipts", "updatedAt", "checkpointDigest",
  ];
  if (!legacy) exactKeys.push("prepareReceipts");
  if (Object.keys(row).sort().join("\u0000") !== exactKeys.sort().join("\u0000")) return null;
  if (
    row.graphDigest !== expectedGraphDigest ||
    !expectedOccurrenceId || row.occurrenceId !== expectedOccurrenceId ||
    typeof row.occurrenceId !== "string" ||
    row.occurrenceId.length < 1 || row.occurrenceId.length > 240 ||
    typeof row.updatedAt !== "string" || Number.isNaN(Date.parse(row.updatedAt)) ||
    typeof row.checkpointDigest !== "string" || !SHA256_RE.test(row.checkpointDigest)
  ) return null;
  const idArray = (key: string, allowed: ReadonlySet<string>): string[] | null => {
    const raw = row[key];
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || !allowed.has(id))) return null;
    const ids = raw as string[];
    return new Set(ids).size === ids.length ? ids : null;
  };
  const completedNodeIds = idArray("completedNodeIds", nodeIds);
  const effectNodeIds = idArray("effectNodeIds", nodeIds);
  const skippedNodeIds = idArray("skippedNodeIds", nodeIds);
  const blockedEdgeIds = idArray("blockedEdgeIds", edgeIds);
  const inFlightNodeIds = idArray("inFlightNodeIds", nodeIds);
  const ambiguousNodeIds = idArray("ambiguousNodeIds", nodeIds);
  const outputs = stringRecord(row.outputs);
  const nodeInputDigests = stringRecord(row.nodeInputDigests);
  if (
    !effectNodeIds || !completedNodeIds || !skippedNodeIds || !blockedEdgeIds || !inFlightNodeIds ||
    !ambiguousNodeIds || !outputs || !nodeInputDigests ||
    !row.vars || typeof row.vars !== "object" || Array.isArray(row.vars) ||
    !row.toolReceipts || typeof row.toolReceipts !== "object" || Array.isArray(row.toolReceipts) ||
    (!legacy && (!row.prepareReceipts || typeof row.prepareReceipts !== "object" || Array.isArray(row.prepareReceipts)))
  ) return null;
  if (effectNodeIds.length !== expectedEffectNodeIds.size ||
      effectNodeIds.some((nodeId) => !expectedEffectNodeIds.has(nodeId))) return null;
  const stateIds = [completedNodeIds, skippedNodeIds, inFlightNodeIds, ambiguousNodeIds].flat();
  if (new Set(stateIds).size !== stateIds.length) return null;
  if (Object.keys(outputs).some((nodeId) => !nodeIds.has(nodeId)) ||
      Object.keys(nodeInputDigests).some((nodeId) => !nodeIds.has(nodeId))) return null;
  if (Object.values(nodeInputDigests).some((digest) => !SHA256_RE.test(digest))) return null;
  for (const [nodeId, rawReceipts] of Object.entries(row.toolReceipts as Record<string, unknown>)) {
    if (!nodeIds.has(nodeId) || !Array.isArray(rawReceipts) || rawReceipts.length > 64) return null;
    for (const rawReceipt of rawReceipts) {
      if (!rawReceipt || typeof rawReceipt !== "object" || Array.isArray(rawReceipt)) return null;
      const receipt = rawReceipt as Record<string, unknown>;
      if (
        Object.keys(receipt).sort().join("\u0000") !== ["name", "readOnly", "resultDigest", "succeeded"].sort().join("\u0000") ||
        typeof receipt.name !== "string" || receipt.name.length < 1 || receipt.name.length > 240 ||
        typeof receipt.resultDigest !== "string" || !SHA256_RE.test(receipt.resultDigest) ||
        typeof receipt.readOnly !== "boolean" || typeof receipt.succeeded !== "boolean"
      ) return null;
    }
  }
  const originalPayload = { ...row };
  delete originalPayload.checkpointDigest;
  if (row.checkpointDigest !== sha256Value(originalPayload)) return null;
  const prepareReceipts: Record<string, WorkforcePrepareCheckpointReceipt[]> = {};
  if (!legacy) {
    for (const [nodeId, rawReceipts] of Object.entries(row.prepareReceipts as Record<string, unknown>)) {
      if (!nodeIds.has(nodeId) || !Array.isArray(rawReceipts) || rawReceipts.length > 8) return null;
      const receipts: WorkforcePrepareCheckpointReceipt[] = [];
      for (const rawReceipt of rawReceipts) {
        const receipt = parseWorkforcePrepareCheckpointReceipt(rawReceipt, row.occurrenceId as string);
        if (!receipt || receipts.some((entry) => entry.idempotencyKey === receipt.idempotencyKey)) return null;
        receipts.push(receipt);
      }
      prepareReceipts[nodeId] = receipts;
    }
  }
  const checkpoint = structuredClone({
    ...row,
    schemaVersion: GRAPH_CHECKPOINT_SCHEMA,
    prepareReceipts,
  }) as unknown as GraphCheckpoint;
  if (legacy) {
    checkpoint.checkpointDigest = sha256Value(checkpointPayload(checkpoint));
  }
  return checkpoint;
}

function failedRunHasCommittedEffect(
  latestFailed: NonNullable<ReturnType<typeof getLatestFailedGraphCheckpoint>>,
): boolean {
  const value = latestFailed.checkpoint;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    const effectNodeIds = Array.isArray(row.effectNodeIds) ? row.effectNodeIds : null;
    const completedNodeIds = Array.isArray(row.completedNodeIds) ? row.completedNodeIds : null;
    const digest = typeof row.checkpointDigest === "string" ? row.checkpointDigest : "";
    const payload = { ...row };
    delete payload.checkpointDigest;
    if (
      (row.schemaVersion === GRAPH_CHECKPOINT_SCHEMA || row.schemaVersion === LEGACY_GRAPH_CHECKPOINT_SCHEMA) &&
      row.occurrenceId === latestFailed.occurrenceId &&
      row.graphDigest === latestFailed.graphDigest &&
      SHA256_RE.test(digest) && digest === sha256Value(payload) &&
      effectNodeIds && completedNodeIds &&
      effectNodeIds.every((id) => typeof id === "string") &&
      completedNodeIds.every((id) => typeof id === "string")
    ) {
      const effects = new Set(effectNodeIds as string[]);
      return (completedNodeIds as string[]).some((id) => effects.has(id));
    }
  }
  const legacyStates = latestFailed.nodeStates;
  const legacyNodeIds = Object.keys(legacyStates).sort();
  if (
    latestFailed.graphDigest === null && latestFailed.occurrenceId === null &&
    legacyNodeIds.every((nodeId) => nodeId === "n0" || nodeId === "n1") &&
    legacyStates.n0 === "done" && legacyStates.n1 !== "done"
  ) {
    const events = listRunEvents(latestFailed.runId, 500);
    if (events.length === 0) return true;
    return events.some((event) => {
      if (event.kind !== "mcp_tool-use") return false;
      const name = typeof event.payload.toolName === "string" ? event.payload.toolName : "";
      return Boolean(name) && event.payload.toolIsError !== true && !isReadOnlyCheckpointTool(name);
    });
  }
  // Historical/corrupt rows did not seal the old graph's node types. Once a
  // graph changes, any completed node is conservatively treated as a possible
  // effect so deleting/renaming the old node cannot authorize duplicate work.
  return Object.values(latestFailed.nodeStates).some((state) => state === "done");
}

const READ_ONLY_WORKFORCE_AUDIT_TOOLS = new Set([
  "agentlas.workforce.schema_attempt",
  "agentlas.workforce.hub_tool_observation",
  "agentlas.workforce.hub_tool_supersession",
  "agentlas.workforce.leader_decision_supersession",
  "agentlas.workforce.work_order_refinement",
  "agentlas.workforce.benchmark_selection_artifacts",
]);

function isReadOnlyCheckpointTool(name: string): boolean {
  // search/validate are digest-bound transaction operations. Preparation may
  // fetch a metered runtime bundle, so it is never considered replay-safe
  // without a provider idempotency receipt.
  return READ_ONLY_WORKFORCE_AUDIT_TOOLS.has(name) ||
    /^(?:workforce\.(?:search_candidates|validate_selection)|Agentlas Plugins\b)/i.test(name);
}

function isReplaySafeGraphToolReceipt(
  checkpoint: GraphCheckpoint,
  nodeId: string,
  receipt: GraphToolReceipt,
): boolean {
  if (receipt.readOnly) return true;
  // The status event itself carries only "ok" and is not replay authority.
  // It becomes safe only after the trusted main-process result supplies a
  // digest-sealed Hub idempotency receipt for this exact graph occurrence.
  return receipt.succeeded && receipt.name === "workforce.prepare_execution" &&
    (checkpoint.prepareReceipts[nodeId]?.length ?? 0) > 0;
}

export function hasReplaySafePreparedWorkforce(checkpoint: GraphCheckpoint, nodeId: string): boolean {
  const prepareReceipts = checkpoint.prepareReceipts[nodeId] ?? [];
  const toolReceipts = checkpoint.toolReceipts[nodeId] ?? [];
  return prepareReceipts.length > 0 && toolReceipts.length > 0 &&
    toolReceipts.every((receipt) => isReplaySafeGraphToolReceipt(checkpoint, nodeId, receipt));
}

export function reconcileReplaySafePreparedWorkforceNodes(checkpoint: GraphCheckpoint): string[] {
  const replaySafePreparedNodes = new Set(
    [...checkpoint.inFlightNodeIds, ...checkpoint.ambiguousNodeIds]
      .filter((nodeId) => hasReplaySafePreparedWorkforce(checkpoint, nodeId)),
  );
  checkpoint.inFlightNodeIds = checkpoint.inFlightNodeIds
    .filter((nodeId) => !replaySafePreparedNodes.has(nodeId));
  checkpoint.ambiguousNodeIds = checkpoint.ambiguousNodeIds
    .filter((nodeId) => !replaySafePreparedNodes.has(nodeId));
  return [...replaySafePreparedNodes].sort();
}

const REPLAY_SAFE_WORKFORCE_ERROR_CODES = new Set([
  "work_order_invalid",
  "selection_invalid",
  "candidate_expansion_repeated",
  "workforce_runtime_incompatible",
  "workforce_session_refresh_exhausted",
  "federation_session_expired",
  "federation_session_not_found",
  "hub_response_too_large",
  "hub_tool_invalid",
  "hub_tool_error",
  "hub_transport_error",
  "hub_source_scope_mismatch",
  "hub_source_result_invalid",
  "hub_source_receipt_invalid",
  "hub_source_result_not_succeeded",
  "hub_source_provenance_mismatch",
  "hub_source_pin_mismatch",
  "hub_federation_digest_mismatch",
  "hub_federation_session_mismatch",
  "source_bundle_fetch_failed",
  "source_bundle_fetch_not_supported",
  "source_bundle_verification_failed",
  "source_bundle_claim_mismatch",
  "selected_release_source_pin_mismatch",
  "insufficient_credits",
  "owner_only",
  "no_cloud_package",
  "agent_not_found",
]);

const REPLAY_SAFE_PRE_DISPATCH_ERROR_CODES = new Set([
  "no-chat",
  "no-agent",
  "app-not-found",
  "hep-network-goal-required",
  "borrowed-agent-unavailable",
  "hep-network-route-failed",
  "pinned-runtime-unavailable",
  "no-runtime",
  "no-runner",
  "workforce-leader-runtime-unsupported",
  "stormbreaker-core-harness-unavailable",
]);

function isTypedReplaySafeWorkforceError(code: string): boolean {
  return REPLAY_SAFE_WORKFORCE_ERROR_CODES.has(code) ||
    /^source_(?:unauthorized|unavailable|forbidden|timeout|rate_limited|not_supported|not_configured)$/i.test(code);
}

function isTypedReplaySafeInvocationError(code: string): boolean {
  return REPLAY_SAFE_PRE_DISPATCH_ERROR_CODES.has(code) || isTypedReplaySafeWorkforceError(code);
}

/**
 * 다음 노드 완료 또는 실행 전체 abort 중 먼저 발생한 쪽을 기다린다.
 *
 * 단순 Promise.race(running.values())는 런타임이 AbortSignal을 무시하면 영원히
 * pending이라 바깥 루프가 abort를 다시 확인하지 못한다. 이 gate는 abort 이벤트가
 * 그 대기를 즉시 깨우되, 늦게 settle하는 노드 promise에는 rejection handler를
 * 계속 붙여 unhandled rejection을 만들지 않는다.
 */
function waitForRunningNodeOrAbort(
  running: ReadonlyMap<string, Promise<void>>,
  signal: AbortSignal,
): Promise<void> {
  if (running.size === 0 || signal.aborted) return Promise.resolve();

  const nextNode = Promise.race(running.values());
  let detachAbort = () => {};
  const aborted = new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => signal.removeEventListener("abort", onAbort);
    // abort가 위의 선확인과 listener 등록 사이에 일어난 경우도 놓치지 않는다.
    if (signal.aborted) onAbort();
  });

  return Promise.race([nextNode, aborted]).finally(detachAbort);
}

/** {{var}} 치환 결과 — 미해결 키를 호출자가 볼 수 있게 함께 반환한다. */
interface Substitution {
  text: string;
  /** 변수 백에 값이 없던 키들. 앞 단계가 안 돌았거나(skip) 산출을 못 낸 경우. */
  missing: string[];
}

/** {{var}} 치환 — 변수 백에서 값을 읽어 문자열에 삽입.
 *  미정의 키를 빈 문자열로 바꿔치우면 "값이 없다"와 "빈 값이 나왔다"가 구분되지 않는다.
 *  condition으로 건너뛴 브랜치가 produce하던 변수를 하류 노드가 읽으면, 앞 단계가 실행조차
 *  안 됐는데 프롬프트만 조용히 뭉개진 채 실행됐다. 치환은 그대로 하되 사실을 보고한다. */
function substitute(template: string, vars: Record<string, unknown>): Substitution {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v == null) {
      if (!missing.includes(key)) missing.push(key);
      return "";
    }
    return typeof v === "string" ? v : JSON.stringify(v);
  });
  return { text, missing };
}

/** config에서 문자열 필드 안전 추출. */
function str(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === "string" ? v : undefined;
}

function buildNodeContinuityPrompt(chatId: string, prompt: string, strategyDirective = ""): string {
  // 전략 진화 지시문은 실패 스트릭이 있을 때만 비어 있지 않다. 프롬프트 바로 앞에 붙여
  // 재시도가 동일 방법을 반복하지 못하게 한다(continuity capsule보다 뒤 = 더 지배적 위치).
  const effectivePrompt = strategyDirective ? `${strategyDirective}\n\n${prompt}` : prompt;
  const prior = listChatMessages(chatId, 12)
    .filter((message) => message.role === "assistant" || message.role === "system")
    .slice(-4)
    .map((message) => (
      `[${message.role} ${message.createdAt}] ${message.text.replace(/\s+/g, " ").trim().slice(0, 1_200)}`
    ));
  if (prior.length === 0) return effectivePrompt;
  return [
    AUTOMATION_CONTINUITY_OPEN,
    "This is the same durable automation session and occurrence. Continue from prior outcomes; do not restart setup or repeat an external action already recorded as complete.",
    ...prior,
    AUTOMATION_CONTINUITY_CLOSE,
    "",
    effectivePrompt,
  ].join("\n");
}

/**
 * 위상 정렬 — edges의 source→target DAG를 Kahn 알고리즘으로 정렬. 사이클/고아는 안전하게
 * 뒤에 붙인다(무한 루프 방지). 결정적 순서를 위해 원본 노드 배열 순서를 tie-break로 쓴다.
 */
// ── 반복(되돌아가는 연결) ──────────────────────────────────────────────────
// "만들고 → 검토하고 → 부족하면 다시 만든다"는 그래프의 기본 모양이다. 예전 커널은
// 되돌아가는 연결을 만나면 위상 정렬이 풀리지 않아 **아무 이유도 없이** 실행이 멈췄다
// (nodeFailures가 비어 있어 화면에는 실패 카드조차 뜨지 않았다).
//
// 반복을 지원하되 두 가지는 양보하지 않는다:
//  · 상한을 선언하지 않은 반복은 실행하지 않는다. 자동화는 사람이 없는 동안 도는 것이라,
//    멈출 사람이 그 자리에 없다.
//  · 되돌아가는 연결은 갈림길에서만 나갈 수 있다. 조건 없이 되돌아가는 그래프는
//    빠져나갈 방법이 정의돼 있지 않다.

export interface GraphLoop {
  edgeId: string;
  /** 되돌아갈 지점(반복의 머리). */
  head: string;
  /** 되돌리는 지점(반복의 꼬리) — 반드시 갈림길이어야 한다. */
  tail: string;
  maxIterations: number;
  /** 한 바퀴를 돌 때 다시 실행돼야 하는 노드들. */
  body: string[];
}

const DEFAULT_MAX_ITERATIONS = 5;
const HARD_MAX_ITERATIONS = 50;

/** DFS 스택 위의 노드를 가리키는 연결 = 되돌아가는 연결. */
function findBackEdges(graph: WorkflowGraph): Set<string> {
  const adj = new Map<string, Array<{ target: string; edgeId: string }>>();
  for (const node of graph.nodes) adj.set(node.id, []);
  for (const edge of graph.edges) adj.get(edge.source)?.push({ target: edge.target, edgeId: edge.id });
  const back = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 0 미방문 · 1 스택 위 · 2 완료
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      const seen = state.get(next.target) ?? 0;
      if (seen === 1) back.add(next.edgeId);
      else if (seen === 0) visit(next.target);
    }
    state.set(id, 2);
  };
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  for (const node of graph.nodes) if (!hasIncoming.has(node.id) && !state.get(node.id)) visit(node.id);
  for (const node of graph.nodes) if (!state.get(node.id)) visit(node.id);
  return back;
}

/** head에서 닿을 수 있고 동시에 tail에 닿을 수 있는 노드 = 이 반복의 몸통. */
function loopBody(graph: WorkflowGraph, head: string, tail: string, backEdgeIds: Set<string>): string[] {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes) { forward.set(node.id, []); reverse.set(node.id, []); }
  for (const edge of graph.edges) {
    if (backEdgeIds.has(edge.id)) continue;
    forward.get(edge.source)?.push(edge.target);
    reverse.get(edge.target)?.push(edge.source);
  }
  const reach = (start: string, map: Map<string, string[]>): Set<string> => {
    const out = new Set<string>([start]);
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      for (const next of map.get(id) ?? []) if (!out.has(next)) { out.add(next); stack.push(next); }
    }
    return out;
  };
  const fromHead = reach(head, forward);
  const toTail = reach(tail, reverse);
  return graph.nodes.map((n) => n.id).filter((id) => fromHead.has(id) && toTail.has(id));
}

export type GraphLoopPlan =
  | { ok: true; loops: GraphLoop[] }
  | { ok: false; nodeId: string; failure: GraphNodeFailure };

/** 이 그래프의 반복을 읽어 낸다. 안전하게 돌릴 수 없는 반복은 실행 전에 막는다. */
export function planGraphLoops(graph: WorkflowGraph): GraphLoopPlan {
  const backEdgeIds = findBackEdges(graph);
  const loops: GraphLoop[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const edge of graph.edges) {
    if (!backEdgeIds.has(edge.id)) continue;
    const tailNode = byId.get(edge.source);
    const headNode = byId.get(edge.target);
    if (!tailNode || !headNode) continue;
    const label = tailNode.label || tailNode.id;
    if (tailNode.type !== "condition") {
      return {
        ok: false,
        nodeId: tailNode.id,
        failure: {
          code: "LOOP_WITHOUT_EXIT",
          reason: `"${label}"에서 "${headNode.label || headNode.id}"(으)로 되돌아가는 반복에 빠져나갈 갈림길이 없습니다.`,
          nextAction: "되돌아가기 전에 갈림길 단계를 넣고, 참·거짓 중 한쪽만 되돌아가게 이으세요.",
        },
      };
    }
    const declared = typeof edge.maxIterations === "number"
      ? edge.maxIterations
      : (typeof headNode.config?.maxIterations === "number" ? headNode.config.maxIterations : null);
    if (declared === null) {
      return {
        ok: false,
        nodeId: tailNode.id,
        failure: {
          code: "LOOP_BOUND_UNDECLARED",
          reason: `"${label}"에서 되돌아가는 반복에 몇 바퀴까지 돌지가 정해져 있지 않습니다. 자동화는 사람이 보지 않는 동안 돌기 때문에, 멈출 지점이 없는 반복은 실행하지 않습니다.`,
          nextAction: `되돌아가는 연결을 눌러 반복 횟수를 정하세요(예: ${DEFAULT_MAX_ITERATIONS}회).`,
        },
      };
    }
    if (!Number.isFinite(declared) || declared < 1 || declared > HARD_MAX_ITERATIONS) {
      return {
        ok: false,
        nodeId: tailNode.id,
        failure: {
          code: "LOOP_BOUND_INVALID",
          reason: `"${label}"의 반복 횟수 ${declared}은(는) 실행할 수 있는 범위(1~${HARD_MAX_ITERATIONS})를 벗어납니다.`,
          nextAction: `반복 횟수를 1~${HARD_MAX_ITERATIONS} 사이로 고치세요.`,
        },
      };
    }
    loops.push({
      edgeId: edge.id,
      head: edge.target,
      tail: edge.source,
      maxIterations: Math.floor(declared),
      body: loopBody(graph, edge.target, edge.source, backEdgeIds),
    });
  }
  return { ok: true, loops };
}

function topoSort(graph: WorkflowGraph): WorkflowNode[] {
  const nodes = graph.nodes;
  const indexOf = new Map<string, number>(nodes.map((n, i) => [n.id, i]));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) {
    if (!indexOf.has(e.source) || !indexOf.has(e.target)) continue;
    adj.get(e.source)!.push(e.target);
    indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  const ready = nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .sort((a, b) => (indexOf.get(a.id)! - indexOf.get(b.id)!))
    .map((n) => n.id);
  const order: string[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const outs = (adj.get(id) ?? []).slice().sort((a, b) => (indexOf.get(a)! - indexOf.get(b)!));
    for (const t of outs) {
      indegree.set(t, (indegree.get(t) ?? 0) - 1);
      if ((indegree.get(t) ?? 0) <= 0 && !seen.has(t)) ready.push(t);
    }
  }
  // 사이클/미도달 노드는 원 순서로 뒤에 붙인다.
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * 노드 실패의 정직한 3요소 — 코드(기계), 사유 원문(사람), 지금 누를 행동.
 * 사유 없는 실패·행동 없는 실패 카드는 결함으로 취급한다.
 */
export type GraphNodeFailure = {
  code: string;
  reason: string;
  nextAction: string;
};

/** 실패 3요소를 실어 나르는 에러. 커널 내부 throw는 전부 이 형태를 목표로 한다. */
export class GraphContractError extends Error {
  readonly failure: GraphNodeFailure;
  constructor(failure: GraphNodeFailure) {
    super(`${failure.code}: ${failure.reason}`);
    this.name = "GraphContractError";
    this.failure = failure;
  }
}

export function graphFailureOf(err: unknown): GraphNodeFailure | null {
  return err instanceof GraphContractError ? err.failure : null;
}

const CONDITION_HANDLES = new Set(["true", "false"]);

type ConditionOutcome =
  | { ok: true; value: boolean }
  | { ok: false; failure: GraphNodeFailure };

/**
 * condition 노드 평가 — 변수 백을 읽어 true/false 반환.
 *
 * 평가 불능(선언 변수 부재, 미지 연산자, 숫자 비교 불가)은 **fail-closed**다.
 * 예전 구현은 미지 op에서 `Boolean(left)`로, 변수 부재에서 undefined→falsy로 조용히
 * 흘려보냈다 — 조건이 틀린 게 아니라 "평가되지 않았다"는 사실이 사라져 분기가 임의로
 * 결정됐다. 모르는 것을 그럴듯한 기본값으로 메꾸지 않는다.
 */
function evalCondition(node: WorkflowNode, vars: Record<string, unknown>): ConditionOutcome {
  const cfg = node.config;
  const label = node.label || node.id;
  const varName = str(cfg, "var");
  const op = str(cfg, "op") ?? "truthy";
  const right = cfg.value;
  const unresolved = (reason: string, nextAction: string): ConditionOutcome => ({
    ok: false,
    failure: { code: "EDGE_CONDITION_UNRESOLVED", reason, nextAction },
  });

  if (varName && !(varName in vars)) {
    return unresolved(
      `조건 노드 "${label}"이 읽으려는 변수 "${varName}"가 이 실행에 존재하지 않습니다.`,
      "이 변수를 만드는 상류 노드를 연결하거나, 조건에서 참조하는 변수 이름을 고치세요.",
    );
  }
  const left = varName ? vars[varName] : undefined;
  if (!varName && op !== "truthy" && op !== "falsy") {
    return unresolved(
      `조건 노드 "${label}"에 비교할 변수가 지정되지 않았습니다(연산자 "${op}").`,
      "조건 노드를 열어 비교할 변수를 선택하세요.",
    );
  }

  switch (op) {
    case "truthy":
      return { ok: true, value: Boolean(left) };
    case "falsy":
      return { ok: true, value: !left };
    case "eq":
      return { ok: true, value: left === right };
    case "ne":
      return { ok: true, value: left !== right };
    case "gt":
    case "lt": {
      const l = Number(left);
      const r = Number(right);
      if (!Number.isFinite(l) || !Number.isFinite(r)) {
        return unresolved(
          `조건 노드 "${label}"이 숫자로 비교할 수 없는 값을 받았습니다(좌: ${JSON.stringify(left)}, 우: ${JSON.stringify(right)}).`,
          "비교 값을 숫자로 만들거나 연산자를 문자열 비교로 바꾸세요.",
        );
      }
      return { ok: true, value: op === "gt" ? l > r : l < r };
    }
    case "contains": {
      if (typeof left !== "string" || typeof right !== "string") {
        return unresolved(
          `조건 노드 "${label}"의 포함 비교는 문자열끼리만 가능합니다(좌: ${typeof left}, 우: ${typeof right}).`,
          "먼저 transform 노드로 문자열을 만들거나 연산자를 바꾸세요.",
        );
      }
      return { ok: true, value: left.includes(right) };
    }
    default:
      return unresolved(
        `조건 노드 "${label}"에 이 커널이 모르는 연산자 "${op}"가 지정돼 있습니다.`,
        "조건 노드를 열어 지원되는 연산자를 다시 고르세요.",
      );
  }
}

/** produces 결과 병합 정책. 선언이 없으면 overwrite(기존 동작)로 본다. */
export type GraphReducerPolicy = "overwrite" | "append" | "merge";

function reducerPolicyOf(node: WorkflowNode): GraphReducerPolicy {
  const raw = str(node.config, "reducer");
  return raw === "append" || raw === "merge" ? raw : "overwrite";
}

/**
 * 노드 도달 가능성(상류→하류). 두 노드가 서로 도달 불가면 **동시 실행 가능**이며,
 * 같은 변수에 overwrite로 쓰면 결과가 도착 순서에 좌우된다(비결정적).
 */
function buildReachability(graph: WorkflowGraph): Map<string, Set<string>> {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source)!.push(e.target);
  }
  const cache = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const seen = new Set<string>();
    const stack = [...(out.get(node.id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const child of out.get(next) ?? []) if (!seen.has(child)) stack.push(child);
    }
    cache.set(node.id, seen);
  }
  return cache;
}

/** transform 노드 — 변수 백을 순수 함수로 reshape(extract/format/json). */
function applyTransform(node: WorkflowNode, vars: Record<string, unknown>): void {
  const cfg = node.config;
  const from = str(cfg, "from");
  const to = str(cfg, "to") ?? from;
  if (!from || !to) return;
  const source = vars[from];
  const mode = str(cfg, "mode") ?? "identity";
  switch (mode) {
    case "json":
      try {
        vars[to] = typeof source === "string" ? JSON.parse(source) : source;
      } catch {
        vars[to] = source;
      }
      break;
    case "format": {
      const tmpl = str(cfg, "template") ?? "{{" + from + "}}";
      vars[to] = substitute(tmpl, vars).text;
      break;
    }
    case "extract": {
      const pattern = str(cfg, "pattern");
      if (pattern && typeof source === "string") {
        try {
          const m = source.match(new RegExp(pattern));
          vars[to] = m ? (m[1] ?? m[0]) : "";
        } catch {
          vars[to] = source;
        }
      } else {
        vars[to] = source;
      }
      break;
    }
    default:
      vars[to] = source;
  }
}

/**
 * 그래프를 실행한다. 백그라운드 division 챗 + 자동화에 저장된 read/write 권한을 재사용한다
 * (automation-scheduler.ts와 동일, full 승격 금지). agent 노드마다 runMcpInvocation을 호출하고, produces를
 * 변수 백에 기록, condition/transform은 인러너로 처리한다.
 *
 * 분기(condition)는 엣지 단위로 처리한다: condition이 drop한 핸들의 엣지를 "blocked"로 표시하고,
 * 각 노드는 자기 inbound 엣지가 전부 blocked이거나 skipped 부모에서 올 때만 skipped가 된다.
 * 이렇게 하면 diamond/join(살아있는 다른 부모가 있으면 노드는 실행)이 올바르게 처리된다 —
 * 서브트리를 통째로 pre-collect하면 join 뒤 노드를 잘못 스킵할 수 있어 엣지 단위로 판정한다.
 */
export async function runGraph(
  automation: Automation,
  graph: WorkflowGraph,
  opts: RunGraphOptions = {},
): Promise<RunGraphResult> {
  const sink: EventSink = opts.sink ?? (() => {});
  const runId = opts.runId ?? `run-${automation.id}-${Date.now()}`;
  const requestedOccurrenceId = opts.occurrenceId?.trim() || null;
  if (
    requestedOccurrenceId &&
    (requestedOccurrenceId.length > 240 || requestedOccurrenceId.includes("\0"))
  ) {
    throw new Error("automation_occurrence_id_invalid");
  }
  const initialVars = durableInitialVars(opts.initialVars);
  // 자율 전략 진화 — 이 자동화의 현재 실패 스트릭을 1회 수집해, 실패가 이어지는 동안
  // 모든 agent/action/output 노드 프롬프트에 "다른 방법 강제" 지시문을 주입한다.
  let strategyDirective = "";
  try {
    strategyDirective = buildStrategyDirective(collectAutomationFailureContext(automation.id));
  } catch (error) {
    console.warn("[run-graph] strategy directive unavailable:", error);
  }
  const unpinnedHubTargets = graph.nodes
    .map((node) => ({ nodeId: node.id, target: hubTargetForNode(automation, node) }))
    .filter((row) => row.target && !/^[0-9a-f]{64}$/.test(row.target.version ?? ""));
  if (unpinnedHubTargets.length > 0) {
    throw new Error(
      `automation_hub_version_pin_required: exact Hub package version is missing for node(s) ${unpinnedHubTargets
        .map((row) => row.nodeId)
        .join(", ")}.`,
    );
  }
  const graphDigest = graphExecutionDigest(automation, graph);
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  const graphEdgeIds = new Set(graph.edges.map((edge) => edge.id));
  const effectNodeIds = new Set(
    graph.nodes
      .filter((node) => node.type === "agent" || node.type === "action" || node.type === "output")
      .map((node) => node.id),
  );
  const latestFailedCandidate = getLatestFailedGraphCheckpoint(automation.id);
  // Trigger deliveries carry a stable event occurrence. Never resume the
  // latest failure from a different fs/chain/webhook/poll event.
  const latestFailed = latestFailedCandidate &&
      (!requestedOccurrenceId || latestFailedCandidate.occurrenceId === requestedOccurrenceId)
    ? latestFailedCandidate
    : null;
  let resumeOfRunId: string | undefined;
  let checkpoint: GraphCheckpoint | null = null;
  if (latestFailed) {
    // 재개 좌표는 한 번만 소비된다. 두 실행이 같은 실패 스냅샷을 동시에 집으면
    // 이미 끝난 단계가 두 번 돌 수 있으므로, 진 쪽은 재개하지 않고 정직하게 멈춘다.
    if (!consumeGraphResumeCoordinate(latestFailed.runId)) {
      throw new GraphContractError({
        code: "RESUME_CONFLICT",
        reason:
          "다른 실행이 이미 같은 지점에서 이어서 돌고 있습니다. 같은 단계를 두 번 실행하지 않기 위해 이번 요청은 시작하지 않았습니다.",
        nextAction: "진행 중인 실행이 끝난 뒤 결과를 확인하고, 필요하면 그때 다시 실행하세요.",
      });
    }
    const completedEffectFromSnapshot = latestFailed.graphDigest === graphDigest
      ? Object.entries(latestFailed.nodeStates)
        .some(([nodeId, state]) => state === "done" && effectNodeIds.has(nodeId))
      : failedRunHasCommittedEffect(latestFailed);
    if (latestFailed.graphDigest && latestFailed.graphDigest !== graphDigest) {
      if (completedEffectFromSnapshot) {
        throw new Error(
          "automation_partial_graph_changed: a prior occurrence committed side effects under a different graph; reconciliation is required before replay.",
        );
      }
    } else {
      checkpoint = parseGraphCheckpoint(
        latestFailed.checkpoint,
        graphDigest,
        latestFailed.graphDigest === graphDigest ? latestFailed.occurrenceId : null,
        graphNodeIds,
        graphEdgeIds,
        effectNodeIds,
      );
      if (!checkpoint && completedEffectFromSnapshot) {
        throw new Error(
          "automation_partial_reconciliation_required: a legacy partial occurrence has committed nodes but no resumable output receipt.",
        );
      }
      if (checkpoint) {
        reconcileReplaySafePreparedWorkforceNodes(checkpoint);
        if (checkpoint.inFlightNodeIds.length > 0 || checkpoint.ambiguousNodeIds.length > 0) {
          throw new Error(
            `automation_ambiguous_side_effect: reconciliation required for node(s) ${[
              ...checkpoint.inFlightNodeIds,
              ...checkpoint.ambiguousNodeIds,
            ].join(", ")}.`,
          );
        }
        resumeOfRunId = latestFailed.runId;
      }
    }
  }
  if (!checkpoint) {
    checkpoint = sealCheckpoint({
      schemaVersion: GRAPH_CHECKPOINT_SCHEMA,
      occurrenceId: requestedOccurrenceId ?? `occurrence:${automation.id}:${randomUUID()}`,
      graphDigest,
      effectNodeIds: [...effectNodeIds].sort(),
      completedNodeIds: [],
      skippedNodeIds: [],
      blockedEdgeIds: [],
      inFlightNodeIds: [],
      ambiguousNodeIds: [],
      outputs: {},
      vars: initialVars,
      nodeInputDigests: {},
      toolReceipts: {},
      prepareReceipts: {},
      updatedAt: new Date().toISOString(),
      checkpointDigest: "sha256:" + "0".repeat(64),
    });
  }
  const vars: Record<string, unknown> = structuredClone(checkpoint.vars);
  const outputs: Record<string, string> = { ...checkpoint.outputs };
  const completed = new Set(checkpoint.completedNodeIds);
  const skipped = new Set(checkpoint.skippedNodeIds);
  const blockedEdges = new Set(checkpoint.blockedEdgeIds);

  const syncCheckpoint = (): GraphCheckpoint => {
    checkpoint!.completedNodeIds = [...completed].sort();
    checkpoint!.skippedNodeIds = [...skipped].sort();
    checkpoint!.blockedEdgeIds = [...blockedEdges].sort();
    checkpoint!.outputs = { ...outputs };
    checkpoint!.vars = structuredClone(vars);
    return sealCheckpoint(checkpoint!);
  };
  const runController = new AbortController();
  let detachCallerAbort = () => {};
  if (opts.signal?.aborted) {
    runController.abort(opts.signal.reason);
  } else if (opts.signal) {
    const relayAbort = () => runController.abort(opts.signal?.reason);
    opts.signal.addEventListener("abort", relayAbort, { once: true });
    detachCallerAbort = () => opts.signal?.removeEventListener("abort", relayAbort);
  }
  const runSignal = runController.signal;

  // per-node 라이브 상태 — sink로 emit하고 automation_runs에 영속화(새로고침 후 재하이드레이트).
  const emitNodeState = (
    nodeId: string,
    state: WorkflowNodeRunState,
    persist = true,
  ): void => {
    if (persist) updateGraphRunNode(runId, nodeId, state);
    tryRecordRunEvent({
      runId,
      kind: "workflow_node_state",
      automationId: automation.id,
      nodeId,
      payload: { state },
    });
    sink({ kind: "partial", nodeId, nodeState: state, agentId: nodeId });
  };

  const checkpointNodeState = (nodeId: string, state: WorkflowNodeRunState): void => {
    checkpointGraphRunNode(runId, nodeId, state, syncCheckpoint());
    emitNodeState(nodeId, state, false);
  };

  const ordered = topoSort(graph);
  // 반복 계획을 실행 전에 세운다. 안전하게 돌릴 수 없는 반복은 한 노드도 실행하기 전에 막는다
  // — 반쯤 돌린 뒤 막으면 이미 나간 작업을 되돌릴 수 없다.
  const loopPlan = planGraphLoops(graph);
  const loops = loopPlan.ok ? loopPlan.loops : [];
  const backEdgeIds = new Set(loops.map((loop) => loop.edgeId));
  const loopIterations = new Map<string, number>(loops.map((loop) => [loop.edgeId, 0] as const));
  let ok = true;
  let error: string | undefined;
  /** 노드 id → 실패 3요소(코드·사유 원문·지금 누를 행동). 실패 카드의 정본. */
  const nodeFailures: Record<string, GraphNodeFailure> = {};
  /** 선언 순서 인덱스 — append 리듀서의 결정론적 정렬 키(도착 순서 아님). */
  const declarationIndex = new Map<string, number>(graph.nodes.map((n, i) => [n.id, i] as const));
  /** 도달 가능성 — 같은 변수에 동시 overwrite하는 두 노드를 잡아내는 데 쓴다. */
  const reachability = buildReachability(graph);
  /** 변수 이름 → 이번 실행에서 그 변수를 쓴 노드들. */
  const varWriters = new Map<string, string[]>();
  /** 노드 id → 이번 실행에서 시도한 횟수(재시도 판정용). */
  const nodeAttempts = new Map<string, number>();
  /** 저널 한 줄. 관측 실패가 실행을 멈추지는 않는다. */
  const journal = (
    kind: Parameters<typeof appendGraphJournal>[1],
    nodeId?: string | null,
    payload?: Record<string, unknown>,
  ): void => {
    try {
      appendGraphJournal(runId, kind, nodeId ?? null, payload);
    } catch {
      /* 저널은 감사용이다 — 쓰지 못해도 실행은 계속한다 */
    }
  };
  const dryRun = opts.dryRun === true;
  /** 시뮬레이션에서 막은 것들 — "실전이었으면 무엇이 일어났는가"를 그대로 보여주는 영수증. */
  const dryRunBlocks: GraphDryRunBlock[] = [];
  /** 런타임이 보고한 토큰 누계(실행 전체 / 노드별). 보고가 없으면 상한을 집행할 수 없다. */
  let runTokensUsed = 0;
  /** 관측된 노드 1회 최대 사용량 — 다음 노드를 띄워도 되는지 판단하는 예약치. */
  let maxObservedNodeTokens = 0;
  const nodeTokensUsed = new Map<string, number>();
  /** 상한이 선언됐는데 런타임이 사용량을 보고하지 않은 경우 — 집행한 척하지 않고 고지한다. */
  let budgetUnmeasured = false;
  const runTokenCap = typeof graph.budget?.maxTokens === "number" && graph.budget.maxTokens > 0
    ? Math.floor(graph.budget.maxTokens)
    : null;

  /**
   * 노드를 띄우기 전 남은 예산을 확인한다. 넘겼으면 3요소를 돌려주고, 여유가 있으면 null.
   *
   * 예약치는 **이번 실행에서 실제로 관측된 최대 노드 사용량**이다. 다 쓴 뒤에 멈추면
   * 상한은 이미 뚫린 뒤라 의미가 없고, 근거 없는 추정치를 쓰면 멀쩡한 실행을 막는다.
   * 관측이 아직 없는 첫 노드는 예약할 근거가 없으므로 통과시킨다(모르면 지어내지 않는다).
   */
  const budgetGuard = (node: WorkflowNode): GraphNodeFailure | null => {
    const label = node.label || node.id;
    if (runTokenCap !== null && runTokensUsed + maxObservedNodeTokens > runTokenCap) {
      const remaining = Math.max(0, runTokenCap - runTokensUsed);
      return {
        code: "BUDGET_EXHAUSTED",
        reason:
          `이번 실행의 남은 토큰(${remaining.toLocaleString()})으로는 "${label}"을(를) 돌릴 수 없습니다. ` +
          `상한 ${runTokenCap.toLocaleString()} 중 ${runTokensUsed.toLocaleString()}을 썼고, 앞선 노드는 한 번에 최대 ${maxObservedNodeTokens.toLocaleString()} 토큰을 썼습니다.`,
        nextAction: "상한을 올린 뒤 [이 노드부터 재실행]하거나, 앞 단계에서 넘기는 내용을 줄이세요.",
      };
    }
    const cap = nodeMaxTokens(node);
    const used = nodeTokensUsed.get(node.id) ?? 0;
    if (cap !== null && used >= cap) {
      return {
        code: "BUDGET_EXHAUSTED",
        reason: `노드 "${label}"이 자기 상한 ${cap.toLocaleString()} 토큰을 모두 썼습니다(현재 ${used.toLocaleString()}).`,
        nextAction: "이 노드의 상한을 올리거나, 프롬프트를 줄여 다시 실행하세요.",
      };
    }
    return null;
  };

  /**
   * 승인이 필요한 단계인데 아직 결정이 없으면 실행을 세운다.
   * 거절은 승인 없음과 다르게 말한다 — 사용자가 이미 판단한 결과이기 때문이다.
   */
  const approvalGuard = (node: WorkflowNode): GraphNodeFailure | null => {
    const tier = nodeApprovalTier(node);
    if (tier === "auto") return null;
    const label = node.label || node.id;
    const decision = tier === "ask_once"
      ? (getNodeApproval(automation.id, checkpoint!.occurrenceId, node.id)
        ?? getLatestNodeApproval(automation.id, node.id))
      : getNodeApproval(automation.id, checkpoint!.occurrenceId, node.id);
    if (decision?.decision === "approved") return null;
    if (decision?.decision === "rejected") {
      return {
        code: "APPROVAL_REJECTED",
        reason: `"${label}" 단계를 실행하지 않기로 하셨습니다(${new Date(decision.decidedAt).toLocaleString()}).`,
        nextAction: "그대로 두려면 아무것도 하지 않아도 됩니다. 다시 진행하려면 이 단계를 승인하세요.",
      };
    }
    return {
      code: "APPROVAL_REQUIRED",
      reason:
        `"${label}" 단계는 바깥으로 나가기 전에 확인이 필요합니다. 아직 실행하지 않았습니다.`,
      nextAction: "내용을 확인한 뒤 [승인하고 이어서 실행] 또는 [이번엔 실행하지 않기]를 고르세요.",
    };
  };

  /** 실행 후 실제 사용량을 반영한다. 상한이 있는데 보고가 없으면 그 사실을 남긴다. */
  const settleBudget = (node: WorkflowNode, tokens: number | undefined): void => {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
      if (runTokenCap !== null || nodeMaxTokens(node) !== null) budgetUnmeasured = true;
      return;
    }
    runTokensUsed += tokens;
    nodeTokensUsed.set(node.id, (nodeTokensUsed.get(node.id) ?? 0) + tokens);
    maxObservedNodeTokens = Math.max(maxObservedNodeTokens, tokens);
  };
  const running = new Map<string, Promise<void>>();
  const drainRunning = async (): Promise<void> => {
    const pending = [...running.values()];
    if (pending.length === 0) return;
    const drain = Promise.allSettled(pending);
    if (!runSignal.aborted) {
      await drain;
      return;
    }
    try {
      await awaitAutomationRunnerWithAbortGrace(drain, runSignal, opts.abortGraceMs);
    } catch {
      // A cancellation-ignoring sibling is detached after the shared bounded
      // grace. Terminal CAS prevents any late callback from reviving the row.
    }
  };
  try {
    const initialNodeStates = Object.fromEntries(graph.nodes.map((node) => [
      node.id,
      completed.has(node.id) ? "done" : skipped.has(node.id) ? "skipped" : "pending",
    ])) as Record<string, WorkflowNodeRunState>;
    startGraphRun({
      runId,
      automationId: automation.id,
      nodeIds: graph.nodes.map((n) => n.id),
      occurrenceId: checkpoint.occurrenceId,
      graphDigest,
      checkpoint: syncCheckpoint(),
      resumeOfRunId,
      initialNodeStates,
    });
    tryRecordRunEvent({
      runId,
      kind: "workflow_graph_started",
      automationId: automation.id,
      payload: {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        occurrenceId: checkpoint.occurrenceId,
        graphDigest,
        resumeOfRunId: resumeOfRunId ?? null,
      },
    });
    if (resumeOfRunId) {
      for (const nodeId of [...completed, ...skipped]) {
        emitNodeState(nodeId, completed.has(nodeId) ? "done" : "skipped", false);
      }
    }
  } catch (snapshotError) {
    // The durable checkpoint is the duplicate-side-effect authority. Never
    // execute a node when its occurrence row could not be created.
    detachCallerAbort();
    throw snapshotError;
  }

  try {
  const rootSession = getOrCreateAutomationSession({
    automationId: automation.id,
    ...(automation.targetType === "firm"
      ? { firmId: automation.targetId }
      : automation.targetType === "agent"
        ? { agentId: automation.targetId }
        : {}),
  });
  const chat = rootSession.chat;

  // 노드별 타깃 세션 — agent 노드의 config.ref(에이전트/회사/그룹 id)를 그 타깃에 바인딩된
  // division 세션으로 실행한다(설계 §4.4: agent(agent)→agent.id). ref 없음/미해석이면 자동화
  // 기본 타깃으로 폴백(dangling 방지). automationId 마커에 타깃 키를 붙여 타깃별로 세션 재사용.
  const nodeChatCache = new Map<string, typeof chat>();
  const chatForNode = (node: WorkflowNode): typeof chat => {
    const ref = str(node.config, "ref");
    if (!ref) return chat;
    if (
      (automation.targetType === "agent" && ref === automation.targetId) ||
      (automation.targetType === "firm" && ref === automation.targetId) ||
      (automation.targetType === "hub" && ref === automation.targetId)
    ) {
      return chat;
    }
    const cached = nodeChatCache.get(ref);
    if (cached) return cached;
    let resolved = chat;
    if (getAgentById(ref)) {
      resolved = getOrCreateAutomationSession({ automationId: `${automation.id}::a:${ref}`, agentId: ref }).chat;
    } else if (getFirm(ref)) {
      resolved = getOrCreateAutomationSession({ automationId: `${automation.id}::f:${ref}`, firmId: ref }).chat;
    } else if (str(node.config, "targetType") === "hub") {
      resolved = getOrCreateAutomationSession({ automationId: `${automation.id}::h:${ref}`, hubId: ref }).chat;
    }
    nodeChatCache.set(ref, resolved);
    return resolved;
  };

  const hubBorrowForNode = (node: WorkflowNode): string[] | undefined => {
    const target = hubTargetForNode(automation, node);
    return target ? [target.slug] : undefined;
  };

  const hubBorrowVersionsForNode = (node: WorkflowNode): Record<string, string> | undefined => {
    const target = hubTargetForNode(automation, node);
    return target?.version ? { [target.slug]: target.version } : undefined;
  };

  // skipped: 실행하지 않기로 확정된 노드. blockedEdges: condition이 drop한 엣지 id.
  // A resumed occurrence restores both sets from its digest-bound checkpoint.
  // 노드별 inbound 엣지(엣지 id + source) — 스킵 전파 판정용.
  const inbound = new Map<string, { edgeId: string; source: string }[]>();
  for (const e of graph.edges) {
    if (!inbound.has(e.target)) inbound.set(e.target, []);
    inbound.get(e.target)!.push({ edgeId: e.id, source: e.source });
  }
  // condition 노드의 소스 엣지(핸들별) — drop 판정용.
  const outByNode = new Map<string, { edgeId: string; handle?: string }[]>();
  for (const e of graph.edges) {
    if (!outByNode.has(e.source)) outByNode.set(e.source, []);
    outByNode.get(e.source)!.push({ edgeId: e.id, handle: e.sourceHandle });
  }

  /**
   * 노드가 스킵돼야 하는가? inbound 엣지가 하나도 없으면(트리거/시작점) 스킵 아님.
   * inbound 엣지가 있으면, 모든 엣지가 blocked이거나 skipped 부모에서 올 때만 스킵
   * (살아있는 부모가 하나라도 있으면 실행 — join 보호).
   */
  const shouldSkip = (nodeId: string): boolean => {
    // 되돌아가는 연결은 "아직 안 온 미래"다. 그걸 기다리거나 근거로 삼으면
    // 반복의 머리는 영원히 준비되지 않는다.
    const ins = (inbound.get(nodeId) ?? []).filter((i) => !backEdgeIds.has(i.edgeId));
    if (ins.length === 0) return false;
    return ins.every((i) => blockedEdges.has(i.edgeId) || skipped.has(i.source));
  };

  // 노드 상태 — 슬롯 기반 동시 스케줄러(스웜 엔진과 동일 패턴)로 의존성이 충족된 노드를
  // 동시성 한도(getAgentConcurrency = 사용자 슬라이더)만큼 병렬 실행한다. 독립 분기는 실제로
  // 동시에 돌고, 의존 있는 노드는 상류가 끝난 뒤에만 시작한다("상황에 따라 병렬").
  type NodeStatus = "pending" | "running" | "done" | "skipped" | "failed";
  const status = new Map<string, NodeStatus>();
  for (const n of ordered) {
    status.set(n.id, completed.has(n.id) ? "done" : skipped.has(n.id) ? "skipped" : "pending");
  }
  const settled = (id: string): boolean => {
    const s = status.get(id);
    return s === "done" || s === "skipped" || s === "failed";
  };
  // 노드가 실행 가능한가? 모든 inbound 엣지가 blocked이거나 그 source가 settled여야(상류 완료).
  const inboundResolved = (nodeId: string): boolean =>
    (inbound.get(nodeId) ?? [])
      .filter((i) => !backEdgeIds.has(i.edgeId))
      .every((i) => blockedEdges.has(i.edgeId) || settled(i.source));

  /**
   * 한 바퀴를 더 돈다 — 반복 몸통을 처음 상태로 되돌린다.
   * 되돌리지 않으면 이미 끝난 노드로 취급돼 두 번째 바퀴가 실행되지 않는다.
   */
  const rewindLoop = (loop: GraphLoop): void => {
    for (const nodeId of loop.body) {
      completed.delete(nodeId);
      skipped.delete(nodeId);
      status.set(nodeId, "pending");
      // 캔버스도 다시 "대기"로 되돌려야 두 번째 바퀴가 도는 것이 보인다.
      checkpointNodeState(nodeId, "pending");
    }
    // 지난 바퀴에서 막아 둔 분기도 함께 푼다 — 안 그러면 이번 바퀴는 다른 길로 간다.
    for (const edge of graph.edges) {
      if (loop.body.includes(edge.source) && !backEdgeIds.has(edge.id)) blockedEdges.delete(edge.id);
    }
  };

  const beginNode = (node: WorkflowNode, resolvedPrompt?: string): void => {
    checkpoint!.inFlightNodeIds = [...new Set([...checkpoint!.inFlightNodeIds, node.id])].sort();
    checkpoint!.nodeInputDigests[node.id] = sha256Value({
      graphDigest,
      nodeId: node.id,
      nodeType: node.type,
      config: node.config,
      resolvedPrompt: resolvedPrompt ?? null,
      vars,
    });
    journal("node_reserved", node.id, { nodeType: node.type });
    journal("node_intent", node.id, { nodeType: node.type });
    checkpointNodeState(node.id, "running");
  };

  const completeNode = (nodeId: string): void => {
    checkpoint!.inFlightNodeIds = checkpoint!.inFlightNodeIds.filter((id) => id !== nodeId);
    checkpoint!.ambiguousNodeIds = checkpoint!.ambiguousNodeIds.filter((id) => id !== nodeId);
    skipped.delete(nodeId);
    completed.add(nodeId);
    journal("node_settled", nodeId);
    checkpointNodeState(nodeId, "done");
  };

  const skipNode = (nodeId: string): void => {
    checkpoint!.inFlightNodeIds = checkpoint!.inFlightNodeIds.filter((id) => id !== nodeId);
    completed.delete(nodeId);
    skipped.add(nodeId);
    checkpointNodeState(nodeId, "skipped");
  };

  const failNode = (nodeId: string, ambiguous: boolean): void => {
    checkpoint!.inFlightNodeIds = checkpoint!.inFlightNodeIds.filter((id) => id !== nodeId);
    completed.delete(nodeId);
    skipped.delete(nodeId);
    if (ambiguous && !checkpoint!.ambiguousNodeIds.includes(nodeId)) {
      checkpoint!.ambiguousNodeIds = [...checkpoint!.ambiguousNodeIds, nodeId].sort();
    }
    journal("node_failed", nodeId, { ambiguous });
    checkpointNodeState(nodeId, "failed");
  };

  /**
   * produces 결과를 변수 백에 병합한다. 실패하면 3요소를 돌려주고, 성공하면 null.
   *
   * - `overwrite`(기본): 순차 재할당은 정상이지만, **서로 도달 불가한(=동시 실행 가능한)**
   *   두 노드가 같은 이름을 덮어쓰면 도착 순서가 결과를 바꾼다. 예전엔 경고만 찍고 넘어가
   *   같은 그래프가 실행마다 다른 값을 냈다. 이제 거부한다.
   * - `append`: 노드 **선언 순서**로 정렬해 담는다(도착 순서 아님) — 재실행해도 같은 배열.
   * - `merge`: 객체끼리만. 문자열 산출은 JSON 객체로 파싱될 때만 병합한다.
   */
  const applyProduces = (
    node: WorkflowNode,
    produces: string,
    text: string,
  ): GraphNodeFailure | null => {
    const policy = reducerPolicyOf(node);
    const writers = varWriters.get(produces) ?? [];
    if (policy === "overwrite") {
      const rival = writers.find((other) =>
        other !== node.id &&
        !reachability.get(other)?.has(node.id) &&
        !reachability.get(node.id)?.has(other),
      );
      if (rival) {
        return {
          code: "REDUCER_WRITE_CONFLICT",
          reason:
            `노드 "${node.label || node.id}"와 "${rival}"이(가) 동시에 실행될 수 있는데 같은 결과 이름 "${produces}"에 덮어쓰기로 저장합니다. 어느 쪽이 남을지는 먼저 끝나는 쪽에 따라 매번 달라집니다.`,
          nextAction:
            "두 노드의 결과 이름을 다르게 하거나, 저장 규칙을 '이어붙이기'로 바꾸세요.",
        };
      }
      vars[produces] = text;
    } else if (policy === "append") {
      const prior = vars[produces];
      const bucket: { order: number; nodeId: string; value: string }[] = Array.isArray(prior)
        ? (prior as unknown[]).filter((row): row is { order: number; nodeId: string; value: string } =>
            !!row && typeof row === "object" && "order" in row && "value" in row)
        : prior === undefined
          ? []
          : [{ order: -1, nodeId: "", value: String(prior) }];
      bucket.push({ order: declarationIndex.get(node.id) ?? 0, nodeId: node.id, value: text });
      bucket.sort((a, b) => (a.order - b.order) || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
      vars[produces] = bucket;
    } else {
      const prior = vars[produces];
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
          code: "REDUCER_MERGE_CONFLICT",
          reason: `노드 "${node.label || node.id}"의 저장 규칙이 '합치기'인데 결과가 객체가 아닙니다(받은 값: ${typeof parsed}).`,
          nextAction: "저장 규칙을 '덮어쓰기'나 '이어붙이기'로 바꾸거나, 앞에 transform 노드로 JSON 객체를 만드세요.",
        };
      }
      const base = prior && typeof prior === "object" && !Array.isArray(prior)
        ? (prior as Record<string, unknown>)
        : {};
      vars[produces] = { ...base, ...(parsed as Record<string, unknown>) };
    }
    varWriters.set(produces, [...writers, node.id]);
    return null;
  };

  /**
   * 계약 위반으로 노드를 세운다. 부수효과가 발생할 수 없는 인러너 판정(조건/변환/리듀서)에서만
   * 쓰며, ambiguous로 올리지 않는다 — 외부에 아무것도 나가지 않았음이 확정이기 때문이다.
   * 사유 원문과 지금 누를 행동을 함께 남긴다(코드만 남기지 않는다).
   */
  const failGraphNode = (node: WorkflowNode, failure: GraphNodeFailure): void => {
    failNode(node.id, false);
    status.set(node.id, "failed");
    nodeFailures[node.id] = failure;
    tryRecordFailureEvent({
      runId,
      source: "workflow_node",
      automationId: automation.id,
      nodeId: node.id,
      agentId: node.id,
      errorCode: failure.code,
      errorMessage: failure.reason,
      payload: {
        nodeType: node.type,
        nodeLabel: node.label,
        nextAction: failure.nextAction,
      },
    });
    if (error === undefined) error = `${failure.code}: ${failure.reason}`;
    ok = false;
  };

  const runNode = async (node: (typeof ordered)[number]): Promise<void> => {
    switch (node.type) {
      case "trigger":
        beginNode(node);
        completeNode(node.id);
        status.set(node.id, "done");
        return;
      case "condition": {
        beginNode(node);
        const label = node.label || node.id;
        const outgoing = outByNode.get(node.id) ?? [];
        // 분기 계약은 실행 전에 확인한다. 핸들을 선언하지 않은 엣지는 어느 쪽 drop과도
        // 일치하지 않아 **양쪽 분기가 동시에 살아나는** 무성 결함이었다. 모르는 배선은
        // 통과시키지 않는다.
        const undeclared = outgoing.filter((edge) => !edge.handle || !CONDITION_HANDLES.has(edge.handle));
        if (undeclared.length > 0) {
          failGraphNode(node, {
            code: "EDGE_CONDITION_UNRESOLVED",
            reason:
              `조건 노드 "${label}"에서 나가는 연결 ${undeclared.length}개가 참/거짓 중 어느 쪽인지 선언하지 않았습니다.`,
            nextAction: "캔버스에서 해당 연결을 지우고 조건 노드의 참·거짓 출구에서 다시 이으세요.",
          });
          return;
        }
        const outcome = evalCondition(node, vars);
        if (!outcome.ok) {
          failGraphNode(node, outcome.failure);
          return;
        }
        const take = outcome.value ? "true" : "false";
        const drop = outcome.value ? "false" : "true";
        // 갈 곳이 선언돼 있는데 이번 판정과 맞는 출구가 하나도 없으면 조용히 흘리지 않는다.
        if (outgoing.length > 0 && !outgoing.some((edge) => edge.handle === take)) {
          failGraphNode(node, {
            code: "NO_MATCHING_EDGE",
            reason: `조건 노드 "${label}"이 ${take === "true" ? "참" : "거짓"}으로 판정됐지만 그쪽으로 이어진 연결이 없습니다.`,
            nextAction: `조건 노드의 ${take === "true" ? "참" : "거짓"} 출구에 다음 작업을 연결하거나, 여기서 끝나는 게 맞다면 종료 노드를 이으세요.`,
          });
          return;
        }
        // 이번 판정이 되돌아가는 쪽이면 한 바퀴를 더 돈다. 상한에 닿으면 돌지 않고
        // 그 사실을 말한다 — 조용히 멈추면 사용자는 왜 결과가 없는지 알 수 없다.
        const takenBackEdge = outgoing.find((edge) => edge.handle === take && backEdgeIds.has(edge.edgeId));
        if (takenBackEdge) {
          const loop = loops.find((candidate) => candidate.edgeId === takenBackEdge.edgeId)!;
          const done = loopIterations.get(loop.edgeId) ?? 0;
          if (done >= loop.maxIterations) {
            failGraphNode(node, {
              code: "LOOP_LIMIT_REACHED",
              reason: `"${label}"이 ${loop.maxIterations}바퀴를 다 돌 때까지 빠져나가는 조건을 만족하지 못했습니다.`,
              nextAction: "반복 횟수를 늘리거나, 빠져나가는 조건을 지금 결과에 맞게 고친 뒤 다시 실행하세요.",
            });
            return;
          }
          loopIterations.set(loop.edgeId, done + 1);
          journal("node_routed", node.id, {
            loopEdgeId: loop.edgeId,
            iteration: done + 1,
            maxIterations: loop.maxIterations,
          });
          for (const edge of outgoing) {
            if (edge.handle === drop) blockedEdges.add(edge.edgeId);
          }
          completeNode(node.id);
          status.set(node.id, "done");
          rewindLoop(loop);
          return;
        }
        for (const edge of outgoing) {
          if (edge.handle === drop) blockedEdges.add(edge.edgeId);
        }
        completeNode(node.id);
        status.set(node.id, "done");
        return;
      }
      case "transform":
        beginNode(node);
        applyTransform(node, vars);
        completeNode(node.id);
        status.set(node.id, "done");
        return;
      case "tool":
        // 툴은 러너가 직접 호출하지 않는다 — 인접 agent 런타임 선언(설계 §4.4).
        beginNode(node);
        completeNode(node.id);
        status.set(node.id, "done");
        return;
      case "agent":
      case "action":
      case "output": {
        // 시뮬레이션에서 부수효과 노드는 아예 호출하지 않는다. 읽기 권한으로 낮춰 돌리면
        // "성공했다"는 모양만 남고 실제로는 아무것도 반영되지 않아 결과를 오해하게 된다.
        const effect = nodeEffect(node);
        if (dryRun && effect === "mutation") {
          beginNode(node);
          const label = node.label || node.id;
          dryRunBlocks.push({
            nodeId: node.id,
            nodeLabel: label,
            effect,
            reason: `실전이었다면 "${label}"이 외부에 변경을 반영했을 지점입니다. 시뮬레이션이라 호출하지 않았습니다.`,
          });
          outputs[node.id] = `[시뮬레이션] "${label}"은(는) 실행하지 않았습니다.`;
          const producesKey = str(node.config, "produces");
          if (producesKey) {
            const applied = applyProduces(node, producesKey, outputs[node.id]);
            if (applied) {
              failGraphNode(node, applied);
              return;
            }
          }
          completeNode(node.id);
          status.set(node.id, "done");
          return;
        }
        // 승인 브레이크 — 사람이 "나가도 된다"고 하기 전에는 실행하지 않는다.
        // 시뮬레이션은 바깥으로 나가는 게 없으므로 확인을 요구하지 않는다.
        const approvalStop = dryRun ? null : approvalGuard(node);
        if (approvalStop) {
          failGraphNode(node, approvalStop);
          return;
        }
        // 예산은 노드를 띄우기 전에 확인한다 — 넘긴 뒤 정산하면 이미 돈이 나간 뒤다.
        const budgetStop = budgetGuard(node);
        if (budgetStop) {
          failGraphNode(node, budgetStop);
          return;
        }
        const rawPrompt = str(node.config, "prompt") ?? str(node.config, "text") ?? automation.promptTemplate;
        const substituted = substitute(rawPrompt, vars);
        const prompt = substituted.text;
        // 참조한 값이 없으면 실행하지 않는다. 예전에는 프롬프트가 **통째로** 비었을 때만
        // 막았다. 그래서 "'{{topic}}' 주제로 계획을 세워줘"처럼 나머지 문장이 남아 있으면
        // 빈 구멍인 채로 실행돼, 주제 없이 지어낸 결과가 정상 완료로 기록됐다.
        // 값이 없는 것과 값이 비어 있는 것은 다르며, 전자는 사람이 채워야 하는 상태다.
        if (substituted.missing.length > 0 && prompt.trim()) {
          const names = substituted.missing.join(", ");
          // "앞 단계가 안 만들어 줬다"와 "사람이 넣어야 하는데 안 넣었다"는 고치는 방법이
          // 완전히 다르다. 그래프가 밖에서 받아야 하는 값이면 그렇게 말해야 한다.
          const requirement = graphInputRequirement(graph);
          const fromTrigger = !!requirement && substituted.missing.includes(requirement.varName);
          failGraphNode(node, {
            code: "NODE_INPUT_MISSING",
            reason: fromTrigger
              ? `이 그래프는 시작할 때 "${names}" 값을 받아야 하는데, 값 없이 실행됐습니다.`
              : `"${names}" 값을 앞 단계가 만들어 주지 않아 이 단계를 실행하지 않았습니다.`,
            nextAction: fromTrigger
              ? "‘지금 실행’을 눌러 값을 입력하거나, 터미널에서 agentlas graph run \"<이름>\" 으로 값을 넣어 실행하세요."
              : "앞 단계가 이 값을 만들어 내는지 확인하고, 조건 분기로 건너뛰었다면 그 분기를 점검하세요.",
          });
          return;
        }
        if (!prompt.trim()) {
          // 예전엔 무조건 "done"이었다. 프롬프트가 통째로 비었는데 성공 모양의 no-op으로 기록돼,
          // 앞 단계가 산출을 못 낸 사실이 실행 결과 어디에도 남지 않았다. 원인을 구분해 보고한다:
          // 참조한 변수가 비어 있으면 실패(앞 단계 문제), 템플릿 자체가 비었으면 skip(설정대로).
          if (substituted.missing.length > 0) {
            const detail = `Prompt resolved to empty because upstream produced no value for: ${substituted.missing.join(", ")}`;
            failNode(node.id, false);
            status.set(node.id, "failed");
            ok = false;
            error ??= `${node.id}: ${detail}`;
            return;
          }
          skipNode(node.id);
          status.set(node.id, "skipped");
          return;
        }
        const nodeChat = node.type === "agent" ? chatForNode(node) : chat;
        const executionPrompt = buildNodeContinuityPrompt(nodeChat.id, prompt, strategyDirective);
        beginNode(node, executionPrompt);
        let checkpointPersistenceError: Error | null = null;
        let unsafeToolObserved = false;
        const refreshUnsafeToolObservation = (): void => {
          unsafeToolObserved = (checkpoint!.toolReceipts[node.id] ?? []).some((receipt) => (
            receipt.succeeded && !isReplaySafeGraphToolReceipt(checkpoint!, node.id, receipt)
          ));
        };
        const persistWorkforcePrepareReceipt = (rawReceipt: WorkforcePrepareCheckpointReceipt): void => {
          const prepareReceipt = parseWorkforcePrepareCheckpointReceipt(rawReceipt, checkpoint!.occurrenceId);
          if (!prepareReceipt) {
            unsafeToolObserved = true;
            throw new Error("automation_prepare_receipt_invalid: Workforce prepare proof was malformed or occurrence-mismatched");
          }
          const rows = checkpoint!.prepareReceipts[node.id] ?? [];
          const existing = rows.find((row) => row.idempotencyKey === prepareReceipt.idempotencyKey);
          if (existing && existing.receiptDigest !== prepareReceipt.receiptDigest) {
            unsafeToolObserved = true;
            throw new Error("automation_prepare_receipt_collision: Workforce prepare proof changed for the same idempotency key");
          }
          if (!existing) {
            checkpoint!.prepareReceipts[node.id] = [...rows, prepareReceipt].slice(-8);
            try {
              saveGraphRunCheckpoint(runId, syncCheckpoint());
            } catch (checkpointError) {
              checkpointPersistenceError = checkpointError instanceof Error
                ? checkpointError
                : new Error(String(checkpointError));
              throw checkpointPersistenceError;
            }
          }
          refreshUnsafeToolObservation();
        };
        // 노드 단위 상한 — 실행 전체를 보는 워치독은 "조용해진 것"만 잡지 "끝나지 않는 것"은
        // 못 잡는다. 토큰을 계속 뱉으면서 영원히 도는 노드가 실제로 가능했다.
        const nodeDeadlineMs = nodeTimeoutMs(node);
        const nodeAbort = new AbortController();
        let nodeTimedOut = false;
        const relayRunAbort = () => nodeAbort.abort(runSignal.reason);
        if (runSignal.aborted) relayRunAbort();
        else runSignal.addEventListener("abort", relayRunAbort, { once: true });
        const nodeTimer = setTimeout(() => {
          nodeTimedOut = true;
          nodeAbort.abort(new Error("automation_node_timeout"));
        }, nodeDeadlineMs);
        try {
          // agent 노드는 config.ref가 가리키는 에이전트/회사 세션에서 실행(멀티에이전트 그래프).
          let runnerError: string | null = null;
          const result = await runMcpInvocation(
            {
              runId,
              chatId: nodeChat.id,
              userPrompt: executionPrompt,
              // 시뮬레이션은 읽기 권한으로 내려 실행한다 — 런타임이 쓰기 도구를 거부하므로
              // 선언되지 않은 부수효과까지 실제로 막힌다(라벨만 붙이는 게 아니다).
              permissions: dryRun || automation.executionPermission === "read" ? "read" : "write",
              borrowAgents: hubBorrowForNode(node),
              borrowVersions: hubBorrowVersionsForNode(node),
              mcpBrowserProfileKey: `automation-${automation.id}`,
              toolMode: automation.toolMode ?? "auto",
              hubMode: automation.hubMode ?? "hub-allowed",
              runtimeSelection: automation.runtimeSelection,
            },
            (ev) => {
              if (ev.kind === "error") {
                runnerError = ev.error?.message || "runner failed";
              }
              if (
                ev.kind === "tool-use" &&
                ev.tool?.name &&
                (ev.done === true || typeof ev.tool.result === "string")
              ) {
                const receipt: GraphToolReceipt = {
                  name: ev.tool.name.slice(0, 240),
                  resultDigest: sha256Value(ev.tool.result ?? null),
                  readOnly: isReadOnlyCheckpointTool(ev.tool.name),
                  succeeded: ev.tool.isError !== true,
                };
                const rows = checkpoint!.toolReceipts[node.id] ?? [];
                if (!rows.some((row) => row.name === receipt.name && row.resultDigest === receipt.resultDigest)) {
                  checkpoint!.toolReceipts[node.id] = [...rows, receipt].slice(-64);
                  refreshUnsafeToolObservation();
                  try {
                    saveGraphRunCheckpoint(runId, syncCheckpoint());
                  } catch (checkpointError) {
                    checkpointPersistenceError = checkpointError instanceof Error
                      ? checkpointError
                      : new Error(String(checkpointError));
                    runnerError = "automation_checkpoint_unavailable: tool receipt could not be persisted";
                    if (!runSignal.aborted) runController.abort(checkpointPersistenceError);
                  }
                }
              }
              if (ev.kind === "error" && ev.error?.code && isTypedReplaySafeInvocationError(ev.error.code)) {
                const receipt: GraphToolReceipt = {
                  name: `error:${ev.error.code}`.slice(0, 240),
                  resultDigest: sha256Value(ev.error.message ?? null),
                  readOnly: true,
                  succeeded: false,
                };
                const rows = checkpoint!.toolReceipts[node.id] ?? [];
                if (!rows.some((row) => row.name === receipt.name && row.resultDigest === receipt.resultDigest)) {
                  checkpoint!.toolReceipts[node.id] = [...rows, receipt].slice(-64);
                  try {
                    saveGraphRunCheckpoint(runId, syncCheckpoint());
                  } catch (checkpointError) {
                    checkpointPersistenceError = checkpointError instanceof Error
                      ? checkpointError
                      : new Error(String(checkpointError));
                    runnerError = "automation_checkpoint_unavailable: typed failure receipt could not be persisted";
                    if (!runSignal.aborted) runController.abort(checkpointPersistenceError);
                  }
                }
              }
              sink({ ...ev, agentId: ev.agentId ?? node.id, nodeId: node.id });
            },
            nodeAbort.signal,
            undefined,
            {
              source: "automation",
              nodeId: node.id,
              occurrenceId: checkpoint.occurrenceId,
              onWorkforcePrepareReceipt: persistWorkforcePrepareReceipt,
            },
          );
          if (result.workforcePrepareReceipt) {
            persistWorkforcePrepareReceipt(result.workforcePrepareReceipt);
          }
          settleBudget(node, result.tokens);
          const text = result.finalText ?? "";
          if (checkpointPersistenceError) throw checkpointPersistenceError;
          if (runnerError) throw new Error(runnerError);
          if (!text.trim()) throw new Error(`Node "${node.label || node.id}" finished without an assistant result`);
          outputs[node.id] = text;
          const produces = str(node.config, "produces");
          if (produces) {
            const applied = applyProduces(node, produces, text);
            if (applied) {
              failGraphNode(node, applied);
              return;
            }
          }
          completeNode(node.id);
          status.set(node.id, "done");
        } catch (nodeErr) {
          const rawMessage = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
          const receipts = checkpoint!.toolReceipts[node.id] ?? [];
          const replaySafeObservedReceipts = receipts.length > 0 && receipts.every((receipt) => (
            isReplaySafeGraphToolReceipt(checkpoint!, node.id, receipt)
          ));
          const replaySafeTypedFailure = receipts.some((receipt) =>
            receipt.name.startsWith("error:") &&
            isTypedReplaySafeInvocationError(receipt.name.slice("error:".length)),
          ) && replaySafeObservedReceipts;
          const replaySafePreparedFailure = (checkpoint!.prepareReceipts[node.id]?.length ?? 0) > 0 &&
            replaySafeObservedReceipts;
          // A failure with no observed tool receipt and no prepared action never
          // reached an external side effect (e.g. the LLM call threw before any
          // tool ran). With no checkpoint-persistence error and no unsafe tool
          // observed — the other two independent side-effect signals below — such
          // a failure is unambiguously replay-safe and must retry on the next
          // slot, not silently suspend the whole automation for reconciliation.
          const noObservedSideEffect = receipts.length === 0 &&
            (checkpoint!.prepareReceipts[node.id]?.length ?? 0) === 0;
          const replaySafeFailure = automation.executionPermission === "read" ||
            replaySafeTypedFailure || replaySafePreparedFailure || noObservedSideEffect;
          const ambiguous = checkpointPersistenceError !== null || unsafeToolObserved || !replaySafeFailure;
          // 재시도 레인 — 부수효과가 **확실히 없었을 때만** 다시 시도한다. 모호하면
          // 재시도가 곧 이중 실행이므로, 그 판단은 사람에게 넘긴다.
          const attempts = (nodeAttempts.get(node.id) ?? 0) + 1;
          nodeAttempts.set(node.id, attempts);
          const maxAttempts = nodeMaxAttempts(node);
          const contractStop = graphFailureOf(nodeErr) !== null;
          // 재시도의 근거는 "부수효과가 없었다"가 아니라 "일시 오류였다"여야 한다.
          // 부수효과 부재만으로 즉시 다시 두드리면, 영구 고장 자동화가 매 스케줄마다
          // 몇 배의 호출을 태운다(이 제품의 기존 설계는 다음 슬롯 재시도였다).
          // 근거는 둘 중 하나다: 런타임이 타입으로 일시 오류라고 알렸거나, 사용자가 켰거나.
          const transientSignal = receipts.some((receipt) =>
            receipt.name.startsWith("error:") &&
            isTypedReplaySafeInvocationError(receipt.name.slice("error:".length)),
          ) || retriesDeclared(node);
          if (
            transientSignal && !ambiguous && !nodeTimedOut && !contractStop &&
            !runSignal.aborted && attempts < maxAttempts
          ) {
            checkpoint!.inFlightNodeIds = checkpoint!.inFlightNodeIds.filter((id) => id !== node.id);
            status.set(node.id, "pending");
            emitNodeState(node.id, "pending");
            journal("node_retry", node.id, { attempt: attempts, maxAttempts });
            tryRecordRunEvent({
              runId,
              kind: "workflow_node_retry",
              automationId: automation.id,
              nodeId: node.id,
              payload: { attempt: attempts, maxAttempts, reason: rawMessage.slice(0, 240) },
            });
            await new Promise<void>((resolve) => setTimeout(resolve, retryBackoffMs(attempts)));
            return;
          }
          const message = ambiguous
            ? `automation_ambiguous_side_effect: ${node.id} may have committed an external action; ${rawMessage}`
            : rawMessage;
          failNode(node.id, ambiguous);
          status.set(node.id, "failed");
          // 실패 카드의 정본. 예전엔 모든 노드 실패가 errorCode "node_failed" 하나로 뭉개져
          // 사용자에게 보여줄 사유도, 지금 누를 행동도 남지 않았다.
          const contractFailure = graphFailureOf(nodeErr);
          const failure: GraphNodeFailure = contractFailure ?? (nodeTimedOut
            ? {
                code: "NODE_TIMEOUT",
                reason: `노드 "${node.label || node.id}"이 제한 시간 ${Math.round(nodeDeadlineMs / 1000)}초 안에 끝나지 않아 중단했습니다.`,
                nextAction: "이 노드의 제한 시간을 늘리거나, 작업을 더 작은 노드로 나눈 뒤 [이 노드부터 재실행]하세요.",
              }
            : ambiguous
            ? {
                code: "MUTATION_UNVERIFIED",
                reason: `노드 "${node.label || node.id}"이 외부에 무언가를 반영했는지 확인되지 않은 채로 멈췄습니다. 원문: ${rawMessage}`,
                nextAction: "실제로 반영됐는지 확인한 뒤 [이 노드부터 재실행] 또는 [건너뛰기]를 고르세요.",
              }
            : {
                code: "NODE_FAILED",
                reason: rawMessage,
                nextAction: "사유를 확인하고 [이 노드부터 재실행]하거나, 노드 설정을 고친 뒤 다시 실행하세요.",
              });
          nodeFailures[node.id] = failure;
          tryRecordFailureEvent({
            runId,
            source: "workflow_node",
            automationId: automation.id,
            nodeId: node.id,
            agentId: node.id,
            errorCode: failure.code,
            errorMessage: message,
            payload: {
              nodeType: node.type,
              nodeLabel: node.label,
              nextAction: failure.nextAction,
            },
          });
          if (error === undefined) error = message;
          ok = false;
        } finally {
          clearTimeout(nodeTimer);
          runSignal.removeEventListener("abort", relayRunAbort);
        }
        return;
      }
      default:
        // 이 커널이 모르는 노드 종류를 성공으로 통과시키면, 사용자는 실행됐다고 믿고
        // 결과는 아무 데도 없다. 모르는 것은 통과가 아니라 정지다.
        beginNode(node);
        failGraphNode(node, {
          code: "NODE_TYPE_UNSUPPORTED",
          reason: `이 버전의 Agentlas는 노드 종류 "${node.type}"을(를) 실행할 수 없습니다.`,
          nextAction: "Agentlas를 최신 버전으로 업데이트하거나, 이 노드를 지원되는 종류로 바꾸세요.",
        });
        return;
    }
  };

  // 안전하게 돌릴 수 없는 반복은 한 노드도 실행하기 전에 막는다.
  if (!loopPlan.ok) {
    const target = graph.nodes.find((n) => n.id === loopPlan.nodeId);
    if (target) {
      beginNode(target);
      failGraphNode(target, loopPlan.failure);
    } else {
      ok = false;
      error = loopPlan.failure.reason;
    }
  }

  const concurrency = Math.max(1, Math.floor(getAgentConcurrency()));
  for (;;) {
    if (runSignal.aborted) {
      ok = false;
      error = error ?? "aborted";
      tryRecordFailureEvent({
        runId,
        source: "workflow_graph",
        automationId: automation.id,
        errorCode: "aborted",
        errorMessage: "Workflow graph aborted",
      });
      break;
    }
    // 스킵 전파(고정점): inbound가 전부 blocked/skipped인 노드는 실행 없이 skip.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of ordered) {
        if (status.get(node.id) === "pending" && inboundResolved(node.id) && shouldSkip(node.id)) {
          status.set(node.id, "skipped");
          skipNode(node.id);
          changed = true;
        }
      }
    }
    // 첫 실패가 나면 새 노드는 더 안 띄운다(fail-stop) — 진행 중인 것만 마무리.
    if (!ok) break;
    const ready = ordered.filter(
      (n) => status.get(n.id) === "pending" && inboundResolved(n.id) && !shouldSkip(n.id),
    );
    const slots = Math.max(0, concurrency - running.size);
    for (const node of ready.slice(0, slots)) {
      status.set(node.id, "running");
      const p = runNode(node).finally(() => running.delete(node.id));
      running.set(node.id, p);
    }
    if (running.size === 0) {
      const stillPending = ordered.some((n) => status.get(n.id) === "pending");
      if (!stillPending) break; // 정상 수렴
      // pending인데 실행도 준비도 안 됨(사이클 등) → 실패 처리하고 종료(무한루프 방지).
      // 예전에는 여기서 상태만 failed로 바꾸고 끝냈다. 실패 카드가 하나도 안 떠서
      // 화면에는 "실패"만 뜨고 왜 멈췄는지도, 무엇을 고쳐야 하는지도 없었다.
      const stuck = ordered.filter((n) => status.get(n.id) === "pending");
      for (const n of stuck) {
        status.set(n.id, "failed");
        failNode(n.id, false);
        nodeFailures[n.id] ??= {
          code: "NODE_NEVER_REACHED",
          reason: `"${n.label || n.id}" 앞의 연결이 끝내 정해지지 않아 이 단계는 시작하지 못했습니다.`
            + (backEdgeIds.size > 0
              ? " 되돌아가는 연결이 있는 그래프입니다 — 반복이 빠져나가지 못했을 수 있습니다."
              : " 서로 맞물려 기다리는 연결(순환)이 있는지 확인하세요."),
          nextAction: "캔버스에서 이 단계로 들어오는 연결을 확인하고, 되돌아가는 연결이 있다면 갈림길과 반복 횟수를 점검하세요.",
        };
      }
      ok = false;
      error = error ?? "graph did not converge (cycle or unreachable node)";
      tryRecordFailureEvent({
        runId,
        source: "workflow_graph",
        automationId: automation.id,
        errorCode: "graph_not_converged",
        errorMessage: error,
        payload: { pendingNodeIds: ordered.filter((n) => status.get(n.id) === "failed").map((n) => n.id) },
      });
      break;
    }
    await waitForRunningNodeOrAbort(running, runSignal);
    await Promise.resolve(); // 마이크로태스크 flush — 완료 노드의 finally(running.delete) 반영
  }
  // 남은 실행 정리(취소/조기종료 시).
  await drainRunning();
  } catch (unexpected) {
    ok = false;
    error = unexpected instanceof Error ? unexpected.message : String(unexpected);
    if (!runSignal.aborted) runController.abort(unexpected);
    await drainRunning();
    tryRecordFailureEvent({
      runId,
      source: "workflow_graph",
      automationId: automation.id,
      errorCode: "workflow_graph_unexpected",
      errorMessage: error,
    });
    throw unexpected;
  } finally {
    detachCallerAbort();
    try {
      finishGraphRun(runId, ok ? "ok" : "error");
    } catch {
      /* 스냅샷 종료 실패는 다음 boot/periodic recovery가 닫는다 */
    }
    tryRecordRunEvent({
      runId,
      kind: "workflow_graph_finished",
      automationId: automation.id,
      payload: { ok, error },
    });
  }
  journal(ok ? "run_completed" : "run_failed", null, {
    ...(error ? { error: String(error).slice(0, 240) } : {}),
    tokensUsed: runTokensUsed,
  });
  // 실패 3요소는 실행 스냅샷에 남겨야 화면이 사유와 행동을 말할 수 있다.
  try {
    saveGraphRunFailures(runId, nodeFailures);
  } catch (persistError) {
    console.error("[workflow] node failure detail could not be persisted:", persistError);
  }
  const failures = Object.keys(nodeFailures).length > 0 ? { nodeFailures } : {};
  const simulation = dryRun ? { dryRun: true as const, dryRunBlocks } : {};
  const budget = {
    tokensUsed: runTokensUsed,
    ...(budgetUnmeasured ? { budgetUnmeasured: true as const } : {}),
  };
  return ok
    ? { ok: true, outputs, vars, ...failures, ...simulation, ...budget }
    : { ok: false, outputs, vars, error, ...failures, ...simulation, ...budget };
}
