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
} from "../store/automations";
import { getAgentById } from "../mcp/registry";
import { getFirm } from "../store/firms";
import { getAgentConcurrency } from "../store/concurrency";
import { listRunEvents, tryRecordFailureEvent, tryRecordRunEvent } from "../store/run-events";
import { awaitAutomationRunnerWithAbortGrace } from "../automation-watchdog";
import { buildStrategyDirective, collectAutomationFailureContext } from "../automation-strategy";
import { AUTOMATION_CONTINUITY_OPEN, AUTOMATION_CONTINUITY_CLOSE } from "../automation-continuity";

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

/** condition 노드 평가 — 변수 백을 읽어 true/false 반환. 단순 op만 지원(P0). */
function evalCondition(node: WorkflowNode, vars: Record<string, unknown>): boolean {
  const cfg = node.config;
  const left = str(cfg, "var") ? vars[str(cfg, "var")!] : undefined;
  const op = str(cfg, "op") ?? "truthy";
  const right = cfg.value;
  switch (op) {
    case "truthy":
      return Boolean(left);
    case "falsy":
      return !left;
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "contains":
      return typeof left === "string" && typeof right === "string" && left.includes(right);
    default:
      return Boolean(left);
  }
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
  let ok = true;
  let error: string | undefined;
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
    const ins = inbound.get(nodeId) ?? [];
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
    (inbound.get(nodeId) ?? []).every((i) => blockedEdges.has(i.edgeId) || settled(i.source));

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
    checkpointNodeState(node.id, "running");
  };

  const completeNode = (nodeId: string): void => {
    checkpoint!.inFlightNodeIds = checkpoint!.inFlightNodeIds.filter((id) => id !== nodeId);
    checkpoint!.ambiguousNodeIds = checkpoint!.ambiguousNodeIds.filter((id) => id !== nodeId);
    skipped.delete(nodeId);
    completed.add(nodeId);
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
    checkpointNodeState(nodeId, "failed");
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
        const result = evalCondition(node, vars);
        const drop = result ? "false" : "true";
        for (const edge of outByNode.get(node.id) ?? []) {
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
        const rawPrompt = str(node.config, "prompt") ?? str(node.config, "text") ?? automation.promptTemplate;
        const substituted = substitute(rawPrompt, vars);
        const prompt = substituted.text;
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
        try {
          // agent 노드는 config.ref가 가리키는 에이전트/회사 세션에서 실행(멀티에이전트 그래프).
          let runnerError: string | null = null;
          const result = await runMcpInvocation(
            {
              runId,
              chatId: nodeChat.id,
              userPrompt: executionPrompt,
              permissions: automation.executionPermission === "read" ? "read" : "write",
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
            runSignal,
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
          const text = result.finalText ?? "";
          if (checkpointPersistenceError) throw checkpointPersistenceError;
          if (runnerError) throw new Error(runnerError);
          if (!text.trim()) throw new Error(`Node "${node.label || node.id}" finished without an assistant result`);
          outputs[node.id] = text;
          const produces = str(node.config, "produces");
          if (produces) {
            // 이전 주석은 "병렬 노드는 deps로 분리돼 vars 경합이 없다"고 단언했지만 코드가 그걸
            // 보장하지 않는다: ready 필터는 서로 엣지가 없는 노드를 같은 배치로 동시에 띄우므로,
            // 두 독립 브랜치가 같은 produces 이름을 쓰면 마지막 완료 노드가 이긴다(비결정적).
            // 막지는 않는다 — 순차 재할당은 정상 패턴이다. 다만 조용히 덮어쓰지는 않는다.
            if (produces in vars && vars[produces] !== text) {
              console.warn(
                `[workflow] variable "${produces}" overwritten by node ${node.id}; ` +
                  `concurrent producers of the same name are last-writer-wins and non-deterministic`,
              );
            }
            vars[produces] = text;
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
          const message = ambiguous
            ? `automation_ambiguous_side_effect: ${node.id} may have committed an external action; ${rawMessage}`
            : rawMessage;
          failNode(node.id, ambiguous);
          status.set(node.id, "failed");
          tryRecordFailureEvent({
            runId,
            source: "workflow_node",
            automationId: automation.id,
            nodeId: node.id,
            agentId: node.id,
            errorCode: "node_failed",
            errorMessage: message,
            payload: { nodeType: node.type, nodeLabel: node.label },
          });
          if (error === undefined) error = message;
          ok = false;
        }
        return;
      }
      default:
        beginNode(node);
        completeNode(node.id);
        status.set(node.id, "done");
        return;
    }
  };

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
      for (const n of ordered) {
        if (status.get(n.id) === "pending") {
          status.set(n.id, "failed");
          failNode(n.id, false);
        }
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
  return ok ? { ok: true, outputs, vars } : { ok: false, outputs, vars, error };
}
