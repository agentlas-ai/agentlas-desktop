import { workerCapabilityRunner, WorkerCapabilityError, type PrepareWorkerCapabilities, type WorkerCapabilityInput } from "./worker-capabilities";
// 멀티 에이전트 firm 오케스트레이터 — 3-tier (CEO → 본부 → 전문가).
//   PLAN: 리더가 <<Delegate>>로 필요한 하위만 선택 → DELEGATE: 하위 병렬 실행 → SYNTHESIZE.
//   본부(division)는 지속 세션(숨김 sub-chat, 히스토리·메모리 유지), 전문가는 1회성 worker.
//   본부 1개면 CEO=본부로 보고 tier-2 skip. 각 노드는 자기 agentId로 메모리를 쓰고 읽는다.
//   모든 이벤트는 agentId/role/tier/phase로 태깅 → 렌더러 네트워크 패널 실시간 텔레메트리.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  AgentMessageDirection,
  ChatHistoryEntry,
  InstalledAgent,
  McpInvocationEvent,
  McpInvocationRequest,
  ResolvedDivision,
  ResolvedNode,
  ResolvedOrg,
  RuntimeStatus,
} from "../../shared/types";
import { memoryOwnerAgentId } from "../../shared/memory-ownership";
import { compileLongRunCheckpoint, type LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import { runnerFailureFromError, type Runner, type RunnerFailure, type RunnerRequest, type RunnerResult } from "../runtime/runner";
import type { RuntimeLocale } from "../runtime/status-i18n";
import {
  appendChatMessage,
  autoTitleFromFirstMessage,
  getOrCreateDivisionSession,
  getChatWorkingFolder,
  listChatMessages,
} from "../store/chats";
import { canReadActivatedFolderMemory, recordFolderVisit } from "../architecture/activation";
import { buildMemoryContext } from "../memory/context";
import { queryWorkingFolderOntologyContext } from "../ontology/project-runtime";
import { buildAgentRuntimeOntologyContext } from "../ontology/runtime-context";
import {
  curateReply,
  recordTerminalMemoryTurn,
  stripReplyMemoryEventsReadOnly,
} from "../memory/curator";
import { runSemanticMemoryReview } from "../memory/semantic-curator";
import { parseMemoryEvents, stripAllMemoryEventBlocks } from "../memory/events";
import { memoryEmitterPromptFor } from "../system-agents/memory";
import { parseAutomations } from "../automation-emitter";
import { parseSurfaces } from "../surface-emitter";
import { stripStormbreakerContinueMarker } from "../hephaestus/loop-engineering";
import { buildDelegateProtocol, parseDelegations, type Delegation } from "./delegate";
import { validSiteAgentAppMcpGrantTools } from "../site/agent-app-tool-policy";
import { pickRunner, rolePriorityRuntimes, selectRuntimeForTargets } from "../runtime/selection";
import { getAgentConcurrency } from "../store/concurrency";
import { tryRecordRunEvent } from "../store/run-events";
import { buildEffectiveAgentSystemPrompt } from "../agents/files";
import { getAgentById } from "./registry";
import { buildAgentAppRunnerEnv } from "../runtime/env-resolver";
import {
  UNTRUSTED_RUNTIME_FAILURE_MESSAGE,
  untrustedRuntimeFailurePayload,
} from "../runtime/untrusted-error";
import { SURFACE_INTENT_MARKER } from "../runtime/runner";
import {
  defaultWorkloadAllocation,
  reconcileWorkloadRunnerResult,
  resolveWorkloadAllocationAcrossRuntimes,
  workloadAllocationReceipt,
  type WorkloadAllocation,
} from "../runtime/workload-routing";
import {
  revalidateInvocationWorkspaceBinding,
  type InvocationWorkspaceBinding,
} from "../invocation/workspace-binding";
import { withProjectWriteLease } from "./project-write-lease";
import { createInactivityGuard } from "./inactivity-guard";
import {
  FirmExecutionEvidenceCollector,
  evaluateFirmVerificationEvidence,
  firmEvidencePromptSummary,
  firmExecutionBoundaryOk,
  mergeFirmExecutionEvidence,
  updateFirmPartialCheckpoint,
  withFirmEvidenceIssues,
  type FirmExecutionEvidence,
} from "./firm-execution-evidence";

type EventSink = (ev: McpInvocationEvent) => void;

function mainOneProfileContext(req: McpInvocationRequest): string {
  const value = (req as McpInvocationRequest & { oneProfileContext?: unknown }).oneProfileContext;
  return typeof value === "string" && value.length > 0 && value.length <= 16_000 ? value : "";
}
function sameRuntime(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return left.kind === right.kind && left.backend === right.backend && left.source === right.source;
}

function sameRuntimeModel(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return sameRuntime(left, right) && left.model === right.model;
}

function firmCandidateRuntimes(
  p: FirmRunParams,
  baseActive: RuntimeStatus,
  role: "orchestrator" | "worker",
  manuallyPinned: boolean,
): RuntimeStatus[] {
  const rolePriority = rolePriorityRuntimes(p.runtimes, role);
  const supplied = p.req.agentAppMode
    ? [baseActive]
    : manuallyPinned
      ? [baseActive, ...rolePriority]
      : rolePriority.length > 0
        ? rolePriority
        : [baseActive];
  if (!supplied.some((runtime) => sameRuntimeModel(runtime, baseActive))) supplied.push(baseActive);
  const runnable = supplied.filter((runtime, index, list) => (
    list.findIndex((candidate) => sameRuntimeModel(candidate, runtime)) === index && Boolean(pickRunner(runtime))
  ));
  const candidates = runnable;
  return candidates.length > 0 ? candidates : [baseActive];
}

function firmFailure(
  agentAppMode: boolean | undefined,
  fallbackCode: string,
  fallbackMessage: string,
): { code: string; message: string } {
  return agentAppMode
    ? untrustedRuntimeFailurePayload()
    : { code: fallbackCode, message: fallbackMessage };
}

function cleanAgentAppControlBlocks(text: string): string {
  const withoutContinuation = stripStormbreakerContinueMarker(text).text;
  const withoutIntent = withoutContinuation.split(SURFACE_INTENT_MARKER).join("");
  const withoutSurface = parseSurfaces(withoutIntent).cleanedText;
  const withoutAutomation = parseAutomations(withoutSurface).cleanedText;
  return parseMemoryEvents(withoutAutomation).cleanedText.trim();
}

/** 동시성 캡 — 팀이 많아도 한 번에 이만큼만 연다. 하드코딩이 아니라 사양 기반 추천 + 사용자
 *  슬라이더 설정값(getAgentConcurrency). 저사양은 낮게, 강한 머신은 크게 = 스웜 크기 조절. */
/** 노드 1턴 안전 타임아웃 — 멈춘 CLI 1개가 전체를 무한 대기시키지 않게. */
const NODE_TIMEOUT_MS = 30 * 60 * 1000;

export interface FirmRunParams {
  prepareWorkerCapabilities?: PrepareWorkerCapabilities;
  workerCapabilityTask?: WorkerCapabilityInput["task"];
  workerCapabilityCeiling?: WorkerCapabilityInput["ceiling"];
  req: McpInvocationRequest;
  chat: { id: string; projectId: string | null; firmId: string | null; goalId?: string | null };
  org: ResolvedOrg;
  ceoAgent: InstalledAgent;
  /** Conversation turns captured before the current user request was stored. */
  priorHistory?: ChatHistoryEntry[];
  /** Main-owned durable state, never accepted from the renderer request. */
  goalCheckpoint?: LongRunTaskCheckpoint;
  active: RuntimeStatus;
  runtimes: RuntimeStatus[];
  picked: { runner: Runner; label: string };
  workingFolder?: string | null;
  workspaceBinding?: InvocationWorkspaceBinding;
  restrictedReadBoundary?: true;
  mcpConfigPath?: string;
  mcpAllowedTools?: string[];
  mcpCodexConfigArgs?: string[];
  /** Main-owned MCP inventory isolation; does not remove permitted builtin tools. */
  isolatedMcpConfig?: true;
  /** Explicit Main-owned browser-only execution restriction for delegates. */
  browserOnly?: true;
  /** Main-minted opaque MCP aliases for a one-run Agent App grant. */
  agentAppMcpRuntimeEnv?: NodeJS.ProcessEnv;
  /** Marks the main-owned one-run grant unavailable after a runtime MCP fatal. */
  onAgentAppMcpRuntimeUnavailable?: () => void;
  /** Main persists a controller fallback and updates the visible One picker. */
  onControllerRuntimeFallback?: (
    runtime: RuntimeStatus,
    failure: RunnerFailure,
  ) => void;
  /** True when the visible One composer pin was actually used for this run. */
  runtimePinHonored?: boolean;
  runnerEnv?: NodeJS.ProcessEnv;
  locale: RuntimeLocale;
  sink: EventSink;
  signal?: AbortSignal;
  /** Nested teams return one result to their parent TF instead of emitting a user-visible final. */
  emitFinal?: boolean;
  /** Main-owned typed handoff guard, initialized once per firm run. */
  handoffGuard?: HandoffGuard;
}

export interface FirmRunResult {
  ok: boolean;
  text: string;
}

interface FirmStageResult {
  node: ResolvedNode;
  result: string;
  ok: boolean;
  evidence: FirmExecutionEvidence;
}

function restrictedFirmText(
  p: FirmRunParams,
  text: string,
  nodeId: string,
  phase: NodeTurn["phase"],
  agentId: string | null,
  chatId: string | null | undefined,
  projectPath: string | null,
  permission: RunnerRequest["permission"] = p.req.permissions,
): string {
  if (!firmProjectReadOnly(p, permission)) return text;
  const context = {
    turnId: firmMemoryTurnId(p, nodeId, phase),
    projectPath: p.req.agentAppMode ? null : projectPath,
    projectId: p.req.agentAppMode ? null : p.chat.projectId ?? null,
    agentId,
    chatId: chatId ?? p.chat.id,
    runId: p.req.runId,
    nodeId,
    cwdAtRequest: p.req.agentAppMode ? null : p.workingFolder ?? null,
  };
  try {
    return stripReplyMemoryEventsReadOnly(text, context).cleanedText;
  } catch (error) {
    try {
      recordTerminalMemoryTurn(context, "curation_failed");
    } catch (ticketError) {
      console.error("[memory] firm read-only curation failure receipt failed:", ticketError);
    }
    console.error("[memory] firm read-only curation failed:", error);
    return stripAllMemoryEventBlocks(text).cleanedText;
  }
}

function firmProjectReadOnly(
  p: FirmRunParams,
  permission: RunnerRequest["permission"] = p.req.permissions,
): boolean {
  return p.restrictedReadBoundary === true || (permission !== "write" && permission !== "full");
}

/**
 * A firm node receives an explicit stage grant.  Child plan/synthesis turns
 * are read-only; only a delegated implementation turn may receive bounded
 * write access.  The CEO/root may retain the host mode, but `full` is never
 * inherited by a child node.
 */
export function firmNodePermission(
  p: Pick<FirmRunParams, "req" | "restrictedReadBoundary">,
  turn: Pick<NodeTurn, "tier" | "phase">,
): RunnerRequest["permission"] {
  const host = p.req.permissions;
  if (p.restrictedReadBoundary === true || host === "read") return "read";
  if (turn.tier === 1) return host;
  return turn.phase === "delegate" ? "write" : "read";
}

export function firmDivisionRequiresDirectExecution(
  _stageKind: "production" | "integration" | "verification",
  matchedSpecialistCount: number,
  runtimeToolsDisabled: boolean,
): boolean {
  return matchedSpecialistCount === 0 && !runtimeToolsDisabled;
}

function firmMemoryTurnId(p: FirmRunParams, nodeId: string, phase: NodeTurn["phase"]): string {
  return `firm:run:${p.req.runId ?? "direct"}:chat:${p.chat.id}:node:${nodeId}:phase:${phase}`;
}

function firmTeamMemoryRoute(
  p: FirmRunParams,
  memberAgentId: string | null,
): NonNullable<Parameters<typeof curateReply>[1]["teamRun"]> {
  return {
    orchestratorAgentId: p.ceoAgent.id,
    // 멤버 칸이 없는 턴(팀 낙인·설치 에이전트 없는 조직 노드)은 null 이다.
    // 큐레이터의 마지막 관문이 그때 팀 공유 칸으로 보낸다.
    memberAgentId: !memberAgentId || memberAgentId === p.ceoAgent.id ? null : memberAgentId,
  };
}

/** 간단한 동시성 풀 — items를 cap개씩 병렬 실행. */
async function parallelCap<I, O>(
  items: I[],
  cap: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()));
  return out;
}

function isVerificationNode(node: ResolvedNode): boolean {
  const label = `${node.id} ${node.name} ${node.role}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  return /\b(?:eval|qa|quality|test|verification|verifier)\b|policy\s+gate/.test(label);
}

type MatchedWork = { node: ResolvedNode; brief: string; allocation: WorkloadAllocation };

function isIntegrationWork(item: MatchedWork, siblingProductionCount: number): boolean {
  if (siblingProductionCount < 2 || isVerificationNode(item.node)) return false;
  const label = `${item.node.id} ${item.node.name} ${item.node.role}`
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  const brief = item.brief.toLowerCase();
  if (/\bdesign\b/.test(label)) return false;
  return /\b(?:web|frontend|integration|integrator|release|report|writer|synthesis)\b/.test(label)
    || /\b(?:integrat(?:e|ion)|wire|combine|merge)\b/.test(brief)
    || /\bafter\b[\s\S]{0,80}\b(?:game|design|production|upstream|implementation)\b/.test(brief)
    || /\b(?:once|when)\b[\s\S]{0,80}\b(?:complete|ready|finish)/.test(brief);
}

function stageMatched(targets: MatchedWork[]) {
  const nonVerification = targets.filter((item) => !isVerificationNode(item.node));
  const integration = nonVerification.filter((item) => isIntegrationWork(item, nonVerification.length));
  const integrationIds = new Set(integration.map((item) => item.node.id));
  return {
    production: nonVerification.filter((item) => !integrationIds.has(item.node.id)),
    integration,
    verification: targets.filter((item) => isVerificationNode(item.node)),
  };
}

function resultStatusContext(results: FirmStageResult[]): string {
  if (results.length === 0) {
    return "- No upstream production slot was selected; inspect the current folder honestly.";
  }
  // Verification often reviews an inline research/data handoff, not a file.
  // Status-only context made the verifier search .agentlas logs and stale
  // memory for evidence that the host already had in the worker results. Pass
  // the bounded, actual upstream deliverables directly so QA can verify the
  // same facts the CEO will synthesize. The cap prevents a large worker reply
  // from turning the verification prompt into an unbounded transcript.
  let remaining = 24_000;
  return results.map((result) => {
    const raw = result.result.trim();
    const allowed = Math.max(0, Math.min(8_000, remaining));
    const bounded = raw.length > allowed
      ? `${raw.slice(0, Math.max(0, allowed - 1))}…`
      : raw;
    remaining -= Math.min(raw.length, allowed);
    return [
      `## ${result.node.name}`,
      `status: ${result.ok ? "completed" : "failed"}`,
      firmEvidencePromptSummary(result.evidence),
      bounded || "(no deliverable returned)",
    ].join("\n");
  }).join("\n\n");
}

function requestsInlineConversationResult(value: string): boolean {
  const text = value.toLowerCase();
  /*
   * This switch removes project tools from non-production stages, so it must
   * express a request about *this turn's answer*, not merely notice the words
   * "in chat".  Real product briefs describe layout policy such as "only one
   * immediate media item may be shown in chat; long documents belong in the
   * sidebar".  The old word-presence test treated that sentence as an inline
   * answer request and silently stripped Research, Copy and Dev of every
   * filesystem/browser tool.
   *
   * Keep the supported shortcut, but require both an answer/deliverable noun
   * and an explicit display verb near the conversation destination.  A media
   * placement rule no longer changes execution authority.
   */
  const koreanInlineResult = /(?:결과|답변|보고서|산출물|문서|내용).{0,32}(?:이\s*대화|이\s*채팅|대화에|채팅에|여기에|이\s*화면).{0,20}(?:보여|표시|써|작성|정리|남겨)/u.test(value)
    || /(?:이\s*대화|이\s*채팅|대화에|채팅에|여기에|이\s*화면).{0,32}(?:결과|답변|보고서|산출물|문서|내용).{0,20}(?:보여|표시|써|작성|정리|남겨)/u.test(value);
  const englishInlineResult = /\b(?:show|display|write|put|return|render|leave)\b.{0,48}\b(?:answer|result|report|deliverable|document|output|response)\b.{0,48}\b(?:in\s+(?:this\s+)?(?:chat|conversation)|here|inline)\b/.test(text)
    || /\b(?:in\s+(?:this\s+)?(?:chat|conversation)|here|inline)\b.{0,48}\b(?:show|display|write|put|return|render|leave)\b.{0,48}\b(?:answer|result|report|deliverable|document|output|response)\b/.test(text)
    || /\binline\s+(?:answer|result|report|deliverable|document|output|response)\b/.test(text);
  return koreanInlineResult || englishInlineResult;
}

function verificationResultOk(text: string, sessionOk: boolean): boolean {
  if (!sessionOk) return false;
  const explicit = text.match(/<verification_verdict>\s*(PASS|FAIL)\s*<\/verification_verdict>/i);
  if (explicit) return explicit[1].toUpperCase() === "PASS";
  const opening = text.trim().slice(0, 900);
  return !/(?:\bverdict\s*:\s*fail\b|\brelease[- ]blocking\b|\bnot complete\b|\bcannot truthfully\b|\bno[- ]go\b|\bblocking defect\b)/i.test(opening);
}

function stripVerificationVerdict(text: string): string {
  return text.replace(/<verification_verdict>\s*(?:PASS|FAIL)\s*<\/verification_verdict>/gi, "").trim();
}

const AGENT_MESSAGE_MAX_CHARS = 720;

const MAX_HANDOFF_DEPTH = 3;
const MAX_PAIR_ROUNDTRIPS = 4;

type HandoffBlockReason = "depth" | "roundtrip" | "permission";

interface HandoffGuard {
  readonly maxDepth: number;
  readonly maxRoundtrips: number;
  readonly pairCounts: Map<string, number>;
  blocked: { reason: HandoffBlockReason; from: string; to: string; depth: number; roundtrip: number } | null;
}

function handoffGuardFor(p: FirmRunParams): HandoffGuard {
  if (!p.handoffGuard) {
    p.handoffGuard = {
      maxDepth: MAX_HANDOFF_DEPTH,
      maxRoundtrips: MAX_PAIR_ROUNDTRIPS,
      pairCounts: new Map(),
      blocked: null,
    };
  }
  return p.handoffGuard;
}

function handoffPairKey(from: ResolvedNode, to: ResolvedNode): string {
  return [from.id, to.id].sort().join("::");
}

function handoffBlockedText(p: FirmRunParams, reason: HandoffBlockReason): string {
  if (p.locale === "ko") {
    return reason === "depth"
      ? "핸드오프 깊이 제한(최대 3)에 걸려 One에게 에스컬레이션했습니다."
      : reason === "roundtrip"
        ? "같은 에이전트 쌍의 왕복 제한(최대 4)에 걸려 One에게 에스컬레이션했습니다."
        : "핸드오프 권한 경계가 확인되지 않아 One에게 에스컬레이션했습니다.";
  }
  return reason === "depth"
    ? "Handoff depth limit (3) reached; escalated to One."
    : reason === "roundtrip"
      ? "The pair round-trip limit (4) was reached; escalated to One."
      : "The handoff permission boundary was not verified; escalated to One.";
}

function handoffFailure(p: FirmRunParams): FirmRunResult {
  const reason = p.handoffGuard?.blocked?.reason ?? "permission";
  const text = handoffBlockedText(p, reason);
  p.sink({ kind: "error", error: firmFailure(p.req.agentAppMode, `handoff-${reason}`, text) });
  return { ok: false, text };
}

function boundedAgentMessage(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > AGENT_MESSAGE_MAX_CHARS
    ? `${compact.slice(0, AGENT_MESSAGE_MAX_CHARS - 1)}…`
    : compact;
}

/** Emit an explicit worker envelope. The full result remains in the parent
 * prompt; only a bounded excerpt is exposed to the activity UI and ledger. */
function emitAgentMessage(
  p: FirmRunParams,
  from: ResolvedNode,
  to: ResolvedNode,
  direction: AgentMessageDirection,
  tier: 1 | 2 | 3,
  text: string,
): boolean {
  const excerpt = boundedAgentMessage(text);
  if (!excerpt) return true;
  const guard = handoffGuardFor(p);
  const pair = handoffPairKey(from, to);
  const nextRoundtrip = (guard.pairCounts.get(pair) ?? 0) + 1;
  const blockedReason: HandoffBlockReason | null = tier > guard.maxDepth
    ? "depth"
    : nextRoundtrip > guard.maxRoundtrips
      ? "roundtrip"
      : null;
  if (blockedReason) {
    const blockedText = handoffBlockedText(p, blockedReason);
    guard.blocked = { reason: blockedReason, from: from.id, to: to.id, depth: tier, roundtrip: nextRoundtrip };
    p.sink({
      kind: "tool-use",
      status: blockedText,
      agentId: from.id,
      runtimeAgentId: from.agentId ?? from.id,
      nodeId: from.id,
      agentName: from.name,
      role: from.role,
      tier,
      phase: "delegate",
      agentMessage: {
        messageId: randomUUID(),
        direction,
        fromAgentId: from.id,
        toAgentId: to.id,
        text: blockedText,
        handoffDepth: tier,
        handoffRoundtrip: nextRoundtrip,
        handoffPermission: "read",
        permissionInherited: false,
        handoffBlocked: blockedReason,
      },
    });
    return false;
  }
  guard.pairCounts.set(pair, nextRoundtrip);
  // A handoff is a typed packet, not an authority transfer.  Child turns are
  // bounded to write at most; the parent's `full` mode never crosses this
  // edge.  The actual runner enforces the same grant independently.
  const handoffPermission: RunnerRequest["permission"] =
    p.req.permissions === "read" ? "read" : "write";
  const outgoing = direction === "orchestrator-to-worker";
  p.sink({
    kind: "tool-use",
    status: p.locale === "ko"
      ? outgoing ? `${from.name} → ${to.name} 메시지 전송` : `${from.name} → ${to.name} 결과 전달`
      : outgoing ? `${from.name} → ${to.name} message sent` : `${from.name} → ${to.name} result sent`,
    agentId: from.id,
    runtimeAgentId: from.agentId ?? from.id,
    nodeId: from.id,
    agentName: from.name,
    role: from.role,
    tier,
    phase: "delegate",
    ...(outgoing ? { delegateTo: [to.id] } : {}),
    agentMessage: {
      messageId: randomUUID(),
      direction,
      fromAgentId: from.id,
      toAgentId: to.id,
      text: excerpt,
      handoffDepth: tier,
      handoffRoundtrip: nextRoundtrip,
      handoffPermission,
      permissionInherited: false,
    },
  });
  return true;
}

function emitDelegationMessages(
  p: FirmRunParams,
  from: ResolvedNode,
  tier: 1 | 2,
  targets: Array<{ node: ResolvedNode; brief: string }>,
): boolean {
  for (const target of targets) {
    if (!emitAgentMessage(p, from, target.node, "orchestrator-to-worker", tier, target.brief)) return false;
  }
  return true;
}

function latestTeamResultsAllOk(results: FirmStageResult[]): boolean {
  const latest = new Map<string, boolean>();
  for (const result of results) latest.set(result.node.id, result.ok);
  return [...latest.values()].every(Boolean);
}

/** 부모 signal에 연결된 자식 AbortController — 부모 취소 전파 + 자체 abort(타임아웃) 가능. */
function linkAbort(parent?: AbortSignal) {
  const ctrl = new AbortController();
  const onParent = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  return {
    signal: ctrl.signal,
    abort: () => ctrl.abort(),
    dispose: () => parent?.removeEventListener("abort", onParent),
  };
}

function firmTurnProjectWriteKey(p: FirmRunParams, turn: NodeTurn): string | null {
  if (p.req.agentAppMode || turn.phase !== "delegate") return null;
  const permission = firmNodePermission(p, turn);
  if (permission !== "write" && permission !== "full") return null;
  const workingFolder = firmWorkingFolder(p);
  if (!workingFolder) return null;
  const resolved = path.resolve(workingFolder);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function firmWorkingFolder(p: FirmRunParams): string | null {
  if (p.req.agentAppMode) return null;
  return p.workspaceBinding
    ? revalidateInvocationWorkspaceBinding(p.workspaceBinding)
    : p.workingFolder ?? getChatWorkingFolder(p.chat.id);
}

function firmFailureCheckpoint(
  base: string,
  partial: string,
  evidence: FirmExecutionEvidence,
): string {
  const cleaned = stripAllMemoryEventBlocks(partial).cleanedText.trim();
  const hasEvidence = evidence.completedToolCount > 0
    || evidence.artifactPaths.length > 0
    || evidence.deletedArtifactPaths.length > 0
    || evidence.executedTestPaths.length > 0
    || evidence.invalidEvidenceCodes.length > 0;
  if (!cleaned && !hasEvidence) return base;
  return [
    base,
    "[Partial execution checkpoint — this is recovery evidence, not a completed deliverable]",
    firmEvidencePromptSummary(evidence),
    cleaned || "(no bounded model text was available)",
  ].join("\n\n");
}

function emitProjectWriteWait(p: FirmRunParams, turn: NodeTurn): void {
  p.sink({
    kind: "tool-use",
    status: p.locale === "ko"
      ? `${turn.node.name}이(가) 같은 프로젝트의 이전 쓰기 작업 완료를 기다립니다.`
      : `${turn.node.name} is waiting for the prior write turn on this project.`,
    agentId: turn.node.id,
    runtimeAgentId: turn.node.agentId ?? turn.node.id,
    nodeId: turn.node.id,
    agentName: turn.node.name,
    role: turn.node.role,
    tier: turn.tier,
    phase: turn.phase,
  });
}

/** runNodeTurn을 노드별 타임아웃 + 실패 격리로 감싼다.
 *  - 노드 타임아웃/에러 → ok:false + 에러 노트(비치명적, 오케스트레이션 계속)
 *  - 사용자 취소(부모 signal abort) → throw 전파(전체 중단) */
async function runNodeTurnSafe(
  p: FirmRunParams,
  turn: NodeTurn,
): Promise<{
  text: string;
  delegations: Delegation[];
  synthesisAllocation: WorkloadAllocation | null;
  evidence: FirmExecutionEvidence;
  ok: boolean;
}> {
  const link = linkAbort(p.signal);
  let timedOut = false;
  let partialCheckpoint = "";
  let evidenceCollector = new FirmExecutionEvidenceCollector(null);
  const inactivityGuard: { current: ReturnType<typeof createInactivityGuard> | null } = { current: null };
  try {
    evidenceCollector = new FirmExecutionEvidenceCollector(firmWorkingFolder(p));
    const projectWriteKey = firmTurnProjectWriteKey(p, turn);
    const r = await withProjectWriteLease(
      projectWriteKey,
      {
        signal: link.signal,
        onWait: () => emitProjectWriteWait(p, turn),
      },
      async () => {
        // Time spent behind a sibling's project write does not consume this
        // worker's execution budget. The timeout starts only after the turn
        // owns the project write lease.
        inactivityGuard.current = createInactivityGuard({
          timeoutMs: NODE_TIMEOUT_MS,
          onTimeout: () => {
            timedOut = true;
            link.abort();
          },
        });
        const scopedParams: FirmRunParams = {
          ...p,
          sink: (event) => {
            inactivityGuard.current?.record(event);
            p.sink(event);
          },
        };
        return runNodeTurn(scopedParams, {
          ...turn,
          signal: link.signal,
          executionEvidence: evidenceCollector,
          onPartialCheckpoint: (text) => {
            partialCheckpoint = updateFirmPartialCheckpoint(partialCheckpoint, text);
          },
        });
      },
    );
    if (timedOut) throw new Error("firm_node_inactivity_timeout");
    return { ...r, ok: firmExecutionBoundaryOk(r.evidence) };
  } catch (err) {
    const evidence = evidenceCollector.finalize();
    try {
      recordTerminalMemoryTurn({
        turnId: firmMemoryTurnId(p, turn.node.id, turn.phase),
        projectPath: p.req.agentAppMode ? null : p.workingFolder ?? getChatWorkingFolder(p.chat.id),
        projectId: p.req.agentAppMode ? null : p.chat.projectId ?? null,
        agentId: turn.node.agentId ?? turn.node.id,
        chatId: turn.chatId ?? p.chat.id,
        runId: p.req.runId,
        nodeId: turn.node.id,
        cwdAtRequest: p.req.agentAppMode ? null : p.workingFolder ?? null,
      }, p.signal?.aborted ? "cancelled" : "failed");
    } catch (ticketError) {
      console.error("[memory] firm terminal turn receipt failed:", ticketError);
    }
    if (p.signal?.aborted) throw err; // 사용자 취소는 전파
    // 실패/타임아웃 노드도 per-node 완료 신호 → UI에서 ▶ 가 멈추고 정리된다(스턱 방지).
    p.sink({
      kind: "tool-use",
      done: true,
      status: p.locale === "ko" ? `${turn.node.name} 응답 실패` : `${turn.node.name} failed`,
      agentId: turn.node.id,
      agentName: turn.node.name,
      role: turn.node.role,
      tier: turn.tier,
    });
    if (p.req.agentAppMode) {
      return {
        text: UNTRUSTED_RUNTIME_FAILURE_MESSAGE,
        delegations: [],
        synthesisAllocation: null,
        evidence,
        ok: false,
      };
    }
    if (timedOut) {
      return {
        text: firmFailureCheckpoint(
          p.locale === "ko"
            ? `(${turn.node.name} 응답 실패: ${Math.round(NODE_TIMEOUT_MS / 1000)}초 동안 응답이 없어 자동 중단했습니다.)`
            : `(${turn.node.name} failed: no response for ${Math.round(NODE_TIMEOUT_MS / 1000)}s, auto-aborted.)`,
          partialCheckpoint,
          evidence,
        ),
        delegations: [],
        synthesisAllocation: null,
        evidence,
        ok: false,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: firmFailureCheckpoint(
        p.locale === "ko" ? `(${turn.node.name} 응답 실패: ${msg})` : `(${turn.node.name} failed: ${msg})`,
        partialCheckpoint,
        evidence,
      ),
      delegations: [],
      synthesisAllocation: null,
      evidence,
      ok: false,
    };
  } finally {
    inactivityGuard.current?.dispose();
    link.dispose();
  }
}

/** delegation 타깃을 후보 노드(role/name)와 매칭. */
function matchTargets(
  delegations: Delegation[],
  candidates: ResolvedNode[],
): Array<{ node: ResolvedNode; brief: string; allocation: WorkloadAllocation }> {
  const norm = (s: string) => s.trim().toLowerCase();
  const picked: Array<{ node: ResolvedNode; brief: string; allocation: WorkloadAllocation }> = [];
  const used = new Set<string>();
  for (const d of delegations) {
    const t = norm(d.target);
    const node = candidates.find(
      (c) =>
        !used.has(c.id) &&
        (norm(c.role) === t || norm(c.name) === t || norm(c.role).includes(t) || t.includes(norm(c.role))),
    );
    if (node) {
      used.add(node.id);
      picked.push({ node, brief: d.brief || "", allocation: d.allocation });
    }
  }
  return picked;
}

interface NodeTurn {
  node: ResolvedNode;
  tier: 1 | 2 | 3;
  phase: "plan" | "delegate" | "synthesize";
  userPrompt: string;
  history: ChatHistoryEntry[];
  /** 직속 보고자 (있으면 위임 프로토콜 주입) */
  reports?: ResolvedNode[];
  /** 메모리 컨텍스트(스코프) chatId — 노드가 도는 세션 */
  chatId: string | null;
  /** 이 turn의 출력을 메인 버블에도 흘릴지 (CEO 종합) */
  toMainBubble?: boolean;
  withImages?: boolean;
  /** per-call abort (노드별 타임아웃) — 없으면 p.signal 사용 */
  signal?: AbortSignal;
  /** The division branch this node belongs to, used for division-wide runtime defaults. */
  divisionId?: string;
  /** Present only when a higher-level AI assigned this child/synthesis turn. */
  allocation?: WorkloadAllocation | null;
  /**
   * Inline integration/review receives the complete bounded upstream answer in
   * the prompt.  It must not inspect ambient project state just because the
   * runtime exposes file/shell tools.  This is enforced at the runner boundary,
   * not left as a prose suggestion that a model can ignore.
   */
  runtimeToolsDisabled?: boolean;
  /** Main-only mutable receipt shared with runNodeTurnSafe so an aborted turn
   * can return bounded tool/artifact evidence instead of a one-line failure. */
  executionEvidence?: FirmExecutionEvidenceCollector;
  /** Main-only partial checkpoint sink. It never enters the renderer DTO. */
  onPartialCheckpoint?: (text: string) => void;
}

/** Keep the local history available to approval/handoff decisions while the
 * model continues a durable Goal from host state instead of replaying it.
 * userPrompt reaches both fresh and resumed native sessions. */
export function firmRunnerConversation(
  p: Pick<FirmRunParams, "req" | "chat" | "goalCheckpoint">,
  turn: Pick<NodeTurn, "history" | "userPrompt">,
  runtime: Pick<RuntimeStatus, "kind">,
): Pick<RunnerRequest, "history" | "userPrompt"> {
  const checkpoint = p.req.agentAppMode ? undefined : p.goalCheckpoint;
  if (checkpoint && checkpoint.goalId !== p.chat.goalId) {
    throw new Error("firm_goal_checkpoint_mismatch");
  }
  return {
    history: p.req.agentAppMode || p.chat.goalId ? [] : turn.history,
    userPrompt: [turn.userPrompt, checkpoint ? compileLongRunCheckpoint(checkpoint, runtime.kind) : ""]
      .filter(Boolean).join("\n\n"),
  };
}

/** 노드 1턴 실행 — 프롬프트 조립(노드 프롬프트 + per-agent 메모리 + 위임/메모리 프로토콜),
 *  러너 실행(속성 태깅 스트림), delegation 파싱 + 메모리 큐레이션. */
async function runNodeTurn(p: FirmRunParams, turn: NodeTurn): Promise<{
  text: string;
  delegations: Delegation[];
  synthesisAllocation: WorkloadAllocation | null;
  evidence: FirmExecutionEvidence;
}> {
  const { node, tier, phase } = turn;
  const hasReports = Boolean(turn.reports?.length);
  // Planning-with-a-roster and every synthesis turn are control-plane work.
  // They receive the bounded roster/results in the prompt and must not regain
  // ambient project, MCP, memory, or resident-session authority merely because
  // the selected runtime exposes built-in shell/file tools.
  const controlPlaneTurn = phase === "synthesize" || (phase === "plan" && hasReports);
  const runtimeRole: "orchestrator" | "worker" = tier === 1 ? "orchestrator" : "worker";
  // One's visible model is the controller's first attempt for an in-One team
  // run. It is a preference with a typed fallback, not a replacement for the
  // orchestrator role pool after a provider failure.
  const oneControllerPreferred = runtimeRole === "orchestrator"
    && p.req.oneMode === true
    && p.runtimePinHonored === true
    && Boolean(p.req.runtimeSelection);
  const nodePermission = firmNodePermission(p, turn);
  // 두 id 를 가른다 — 섞으면 고아 기억이 생긴다.
  //  · nodeRuntimeId: **관측용**. 이 노드가 실제로 무엇으로 돌았나(이벤트 태깅·실행 기록).
  //    설치 에이전트가 없으면 노드 id 로 부르는 것이 맞다 — 화면이 그 줄을 그린다.
  //  · memoryOwnerId: **기억용**. 개인 칸을 가질 수 있는 신원만. 팀 낙인이거나 설치 에이전트가
  //    없으면 null 이고, 그때 학습은 팀 공유 칸으로 간다(`normalizeMemoryOwnership`).
  //    실측 2026-08-26: 예전엔 이 둘이 같은 값이라 조직 노드 id 가 그대로 기억 주인이 됐고,
  //    정리기가 그 주인을 못 찾아 조용히 건너뛰어 쌓이기만 했다.
  const nodeRuntimeId = node.agentId ?? node.id;
  const memoryOwnerId = memoryOwnerAgentId(node.agentId);
  const tag = (ev: McpInvocationEvent): McpInvocationEvent => ({
    ...ev,
    agentId: node.id,
    runtimeAgentId: nodeRuntimeId,
    nodeId: node.id,
    agentName: node.name,
    role: node.role,
    tier,
    phase,
  });
  const emit = (ev: McpInvocationEvent) => p.sink(tag(ev));

  // 워킹 폴더(활성 시 프로젝트 메모리)
  const workingFolder = p.req.agentAppMode
    ? null
    : p.workspaceBinding
      ? revalidateInvocationWorkspaceBinding(p.workspaceBinding)
      : p.workingFolder ?? getChatWorkingFolder(p.chat.id);
  const executionEvidence = turn.executionEvidence ?? new FirmExecutionEvidenceCollector(workingFolder);
  let activePath: string | null = null;
  if (!p.req.agentAppMode && !controlPlaneTurn && workingFolder) {
    if (nodePermission === "write" || nodePermission === "full") {
      try {
        const v = await recordFolderVisit(workingFolder, undefined, {
          permission: nodePermission,
          restrictedReadBoundary: p.restrictedReadBoundary,
          agentAppMode: p.req.agentAppMode,
        });
        if (v.activated) activePath = workingFolder;
      } catch {
        // ignore
      }
    }
  }
  const memoryReadPath = workingFolder && (
    activePath === workingFolder ||
    canReadActivatedFolderMemory(workingFolder, {
      permission: nodePermission,
      restrictedReadBoundary: p.restrictedReadBoundary,
      agentAppMode: p.req.agentAppMode,
    })
  )
    ? workingFolder
    : null;

  // 시스템 프롬프트 = 노드 프롬프트 + canonical owner memory + (리더면 위임) + 메모리 emitter
  const firmRolePrompt = node.prompt?.trim() || `You are ${node.name}, the ${node.role} of this firm.`;
  let systemPrompt = node.agentId
    ? buildEffectiveAgentSystemPrompt(node.agentId, firmRolePrompt)
    : firmRolePrompt;
  if (!controlPlaneTurn && !p.req.agentAppMode) {
    systemPrompt += nodePermission === "read"
      ? "\n\n## Execution authority\nCurrent host permission mode: read-only. Inspect and report only; do not write or claim that write access was granted."
      : "\n\n## Execution authority\nCurrent host permission mode: read-write. The host has already granted bounded write authority inside the assigned working folder. When the packet asks for implementation, authored files, fixes, tests, or build work, perform that work directly within the assigned folder; do not describe this turn as read-only and do not ask the user to grant access again.";
  }
  const approvedOneContext = !turn.runtimeToolsDisabled && !controlPlaneTurn && !p.workspaceBinding && !p.req.agentAppMode
    ? mainOneProfileContext(p.req)
    : "";
  if (approvedOneContext) systemPrompt += `\n\n${approvedOneContext}`;
  if (node.agentId && node.prompt?.trim() && !systemPrompt.includes(node.prompt.trim())) {
    systemPrompt += `\n\n## Firm role context\n${node.prompt.trim()}`;
  }
  if (!p.req.agentAppMode && !turn.runtimeToolsDisabled && !controlPlaneTurn) {
    const memorySignal = turn.signal ?? p.signal;
    try {
      const mem = await buildMemoryContext(memoryReadPath, memoryOwnerId, {
        materializeCodeMap: Boolean(activePath),
        taskPrompt: turn.userPrompt,
        projectId: p.chat.projectId ?? null,
        signal: memorySignal,
      });
      if (mem) systemPrompt += `\n\n${mem}`;
      if (memoryReadPath) {
        const ontologyContext = await queryWorkingFolderOntologyContext(memoryReadPath, turn.userPrompt, {
          readOnly: firmProjectReadOnly(p, nodePermission),
        });
        if (ontologyContext.used) systemPrompt += `\n\n${ontologyContext.context}`;
      }
    } catch {
      // ignore memory failures
    }
    if (memorySignal?.aborted) throw new Error("Firm turn cancelled");
  }
  const runtimeChoice = p.req.agentAppMode || oneControllerPreferred
    ? null
    : selectRuntimeForTargets(
        p.runtimes,
        [
          { scope: "agent", targetId: node.agentId },
          {
            scope: "division",
            targetId:
              turn.divisionId && p.chat.firmId
                ? `${p.chat.firmId}:${turn.divisionId}`
                : null,
          },
          { scope: "firm", targetId: p.chat.firmId },
        ],
        // A firm's CEO is the quality-bearing orchestrator. Every delegated
        // division/specialist turn uses the worker role, including a division
        // manager's own plan/synthesis inside that delegated branch.
        runtimeRole,
      );
  const baseActive = oneControllerPreferred
    ? p.active
    : runtimeChoice?.picked
      ? runtimeChoice.active
      : p.active;
  const basePicked = oneControllerPreferred
    ? p.picked
    : runtimeChoice?.picked ?? p.picked;
  const candidateRuntimes = firmCandidateRuntimes(
    p,
    baseActive,
    runtimeRole,
    oneControllerPreferred || Boolean(runtimeChoice?.override),
  );
  if (turn.reports && turn.reports.length > 0) {
    systemPrompt += `\n\n${buildDelegateProtocol(
      turn.reports.map((r) => ({ role: r.role, name: r.name })),
      candidateRuntimes,
      { allowFollowup: phase === "synthesize" },
    )}`;
    if (phase === "plan") {
      systemPrompt += [
        "",
        "## Planning boundary",
        "This turn only chooses and briefs direct reports for the host orchestrator.",
        "Do not inspect files, call tools, spawn sub-agents, implement, edit, test, or solve the task yourself.",
        "Return the Delegate block immediately, then stop. The host executes the chosen workers after parsing it.",
      ].join("\n");
    }
  }
  if (phase === "synthesize") {
    systemPrompt += [
      "",
      "## Synthesis boundary",
      "This turn may use only the bounded worker results supplied in this prompt.",
      "Do not inspect files, call tools, read ambient skills or memory, spawn sub-agents, implement, edit, test, or browse.",
      "Synthesize the supplied results, or return only a Delegate block for a genuinely missing listed report, then stop.",
    ].join("\n");
  }
  if (!p.req.agentAppMode && !turn.runtimeToolsDisabled && !controlPlaneTurn && !firmProjectReadOnly(p, nodePermission)) {
    systemPrompt += `\n\n${memoryEmitterPromptFor(turn.userPrompt)}`;
  }

  const workloadResolution = turn.allocation
    ? resolveWorkloadAllocationAcrossRuntimes({
        allocation: turn.allocation,
        runtimes: candidateRuntimes,
        fallbackRuntime: baseActive,
        phase: turn.allocation.phase,
        manualOverride: runtimeChoice?.override ?? null,
        // Firm runtime choice is host-owned. The model may suggest capacity,
        // but it cannot reorder the DB role pool or smuggle another provider
        // ahead of the selected role's priority chain.
        explicitPinned: !p.req.agentAppMode,
      })
    : null;
  const active = workloadResolution?.runtime ?? baseActive;
  const picked = sameRuntime(active, baseActive) ? basePicked : pickRunner(active) ?? basePicked;
  if (workloadResolution) {
    if (workloadResolution.resolutionCodes.some((code) => code.includes("active-preserved"))) {
      emit({
        kind: "tool-use",
        status: p.locale === "ko"
          ? "상위 AI가 고른 런타임/모델이 실행 재고에 없어 활성 모델을 유지합니다."
          : "The parent-selected runtime/model pair is not in live execution inventory; preserving the active model.",
      });
    }
  }
  if (!p.req.agentAppMode && !turn.runtimeToolsDisabled && !controlPlaneTurn && node.agentId) {
    try {
      const installedAgent = getAgentById(node.agentId);
      const ontology = installedAgent ? await buildAgentRuntimeOntologyContext({
        runSessionId: p.req.runId ?? p.chat.id,
        installedAgent,
        projectId: p.chat.projectId,
        projectPath: workingFolder,
        runtimeKind: active.kind,
        task: turn.userPrompt,
      }) : null;
      if (ontology?.prompt) systemPrompt += `\n\n${ontology.prompt}`;
    } catch {
      // Operational/Taste overlays are optional and never block a firm node.
    }
  }
  // 이 노드가 어떤 모델/런타임으로 도는지 — 오케스트레이션 트리에 "모델 사용 중" 표시용.
  const modelLabel =
    active.model ||
    (active.kind === "byok" ? active.backend ?? "api" : active.kind === "claude-code" ? "claude" : active.kind);

  emit({ kind: "thinking", status: phaseStatus(p.locale, phase, node.name), model: modelLabel });
  if (runtimeChoice?.unavailableOverride) {
    emit({
      kind: "tool-use",
      status:
        p.locale === "ko"
          ? `지정 런타임(${runtimeChoice.unavailableOverride.selection.kind})을 찾지 못해 기본 런타임으로 실행합니다.`
          : `Assigned runtime (${runtimeChoice.unavailableOverride.selection.kind}) is unavailable, using the default runtime.`,
    });
  }

  if (p.workspaceBinding) revalidateInvocationWorkspaceBinding(p.workspaceBinding);
  const agentAppAllowedTools = p.req.agentAppMode && p.mcpConfigPath && p.mcpAllowedTools?.length &&
    validSiteAgentAppMcpGrantTools(p.mcpAllowedTools)
    ? p.mcpAllowedTools
    : undefined;
  const runNodeOn = async (
    runtime: RuntimeStatus,
    runtimePicked: { runner: Runner; label: string },
  ): Promise<RunnerResult> => {
    try {
      const capabilityAttemptId = `firm-worker:${node.id}:${randomUUID()}`;
      const workerRunner = turn.runtimeToolsDisabled || controlPlaneTurn ? runtimePicked.runner
        : workerCapabilityRunner(p.prepareWorkerCapabilities, {
          workerId: node.id, attemptId: capabilityAttemptId, agentId: node.agentId ?? undefined, agentName: node.name,
          task: { ...p.workerCapabilityTask, brief: turn.userPrompt, doneWhen: p.workerCapabilityTask?.doneWhen ?? [] },
          runtime, ceiling: p.req.agentAppMode ? "agent-app" : p.workerCapabilityCeiling ?? "host",
        }, runtimePicked.runner, (code) => {
          tryRecordRunEvent({ runId: p.req.runId ?? p.chat.id, chatId: p.chat.id, agentId: node.id,
            kind: "worker_capability_preparation", payload: { code, attemptId: capabilityAttemptId } });
        });
      return await workerRunner(
        {
          systemPrompt,
          ...firmRunnerConversation(p, turn, runtime),
          images: p.req.agentAppMode ? undefined : turn.withImages ? p.req.images : undefined,
          backendLabel: runtimePicked.label,
          model: runtime.model ?? undefined,
          longContext: runtime.longContextEnabled ?? false,
          effort: runtime.effort ?? undefined,
          signal: turn.signal ?? p.signal,
          permission: p.req.agentAppMode || turn.runtimeToolsDisabled || controlPlaneTurn
            ? "read"
            : nodePermission,
          approvalChatId: phase === "delegate" ? p.chat.id : undefined,
          approvalsReviewer:
            // A delegated worker is non-interactive. Requiring the allocation
            // planner to have guessed `toolRequired` leaves an ordinary user
            // request such as "open the app and verify it in a browser" on the
            // `user` reviewer, where nobody can answer and Codex reports the
            // phantom refusal as "user rejected MCP tool call". The owner has
            // already granted this stage bounded write authority; let the
            // resident reviewer evaluate its concrete calls. Plan/synthesis
            // turns remain read-only and never reach this branch.
            phase === "delegate" && nodePermission !== "read"
              ? "auto_review"
              : "user",
          restrictedReadBoundary: p.restrictedReadBoundary,
          cwd: p.req.agentAppMode || turn.runtimeToolsDisabled || controlPlaneTurn ? undefined : workingFolder ?? undefined,
          chatId: p.req.agentAppMode
            ? `site-agent-app:${p.req.runId ?? "run"}:${node.id}:${phase}:${randomUUID()}`
            : controlPlaneTurn
              ? undefined
              : turn.chatId ?? undefined,
          // 러너의 agentId 는 능력 규칙 대상·런타임 세션 키·상주 판정에 쓰인다(기억이 아니다).
          // 값이 바뀌면 세션이 갈리므로 실제로 돈 신원을 그대로 넘긴다.
          agentId: nodeRuntimeId,
          orchestrationAgentId: node.id,
          isolatedMcpConfig: p.isolatedMcpConfig,
          browserOnly: turn.runtimeToolsDisabled || controlPlaneTurn ? undefined : p.browserOnly,
          mcpConfigPath: turn.runtimeToolsDisabled || controlPlaneTurn
            ? undefined
            : p.req.agentAppMode
              ? (agentAppAllowedTools ? p.mcpConfigPath : undefined)
              : p.mcpConfigPath,
          mcpAllowedTools: turn.runtimeToolsDisabled || controlPlaneTurn
            ? undefined
            : p.req.agentAppMode
              ? agentAppAllowedTools
              : p.mcpAllowedTools,
          mcpCodexConfigArgs: p.req.agentAppMode || turn.runtimeToolsDisabled || controlPlaneTurn
            ? undefined
            : p.mcpCodexConfigArgs,
          env: p.req.agentAppMode
            ? buildAgentAppRunnerEnv(p.runnerEnv ?? process.env, p.agentAppMcpRuntimeEnv)
            : p.runnerEnv,
          // Planning-with-a-roster and synthesis are control-plane turns. The
          // prompt already says not to inspect or execute, but prompt text is
          // not an authority boundary: a real nested firm run showed a Codex
          // planner issuing hundreds of file/shell/MCP calls, then stalling in
          // read-only build and hidden approval failures instead of returning
          // its Delegate block. Require the runtime's measured zero-tool mode
          // here. Runtimes that cannot prove it fail closed and the role pool
          // may select a capable fallback; implementation delegates retain the
          // bounded project/tool grant below this control plane.
          untrustedNoTools:
            p.req.agentAppMode === true ||
            turn.runtimeToolsDisabled === true ||
            controlPlaneTurn,
          untrustedAllowedMcpTools: agentAppAllowedTools,
          onAgentAppMcpRuntimeUnavailable: p.req.agentAppMode
            ? p.onAgentAppMcpRuntimeUnavailable
            : undefined,
          locale: p.locale,
        },
        {
          onStatus: (status, activity) => {
            emit({ kind: "tool-use", status, ...(activity ? { activity } : {}) });
            if (turn.toMainBubble) p.sink({ kind: "tool-use", status, ...(activity ? { activity } : {}) });
          },
          onPartial: (text) => {
            turn.onPartialCheckpoint?.(text);
            if (!p.req.agentAppMode && !firmProjectReadOnly(p, nodePermission)) {
              emit({ kind: "partial", text });
              if (turn.toMainBubble) p.sink({ kind: "partial", text });
            }
          },
          onTool: (name, args, result, id, isError, artifactPaths) => {
            executionEvidence.recordTool(name, args, result, id, isError, artifactPaths);
            const tool = { name, args, result, id, isError };
            emit({ kind: "tool-use", tool });
            if (turn.toMainBubble) p.sink({ kind: "tool-use", tool });
          },
        },
      );
    } catch (error) {
      if (error instanceof WorkerCapabilityError || (turn.signal ?? p.signal)?.aborted) throw error;
      return { text: "", failure: runnerFailureFromError(error, runtime.kind) };
    }
  };
  let executedRuntime = active;
  let executedPicked = picked;
  let result = await runNodeOn(executedRuntime, executedPicked);
  while (result.failure && !p.req.agentAppMode && !(turn.signal ?? p.signal)?.aborted) {
    const fallback = rolePriorityRuntimes(candidateRuntimes, runtimeRole, {
      failedRuntime: executedRuntime,
      failure: result.failure,
    })[0];
    const fallbackPicked = fallback ? pickRunner(fallback) : null;
    if (!fallback || !fallbackPicked) break;
    if (tier === 1) {
      p.onControllerRuntimeFallback?.(fallback, result.failure);
    }
    emit({
      kind: "tool-use",
      status: p.locale === "ko"
        ? `${executedRuntime.model ?? executedRuntime.kind} 실행이 거절되어 ${fallback.model ?? fallback.kind}로 재시도합니다.`
        : `${executedRuntime.model ?? executedRuntime.kind} was rejected; retrying on ${fallback.model ?? fallback.kind}.`,
    });
    executedRuntime = fallback;
    executedPicked = fallbackPicked;
    result = await runNodeOn(executedRuntime, executedPicked);
  }
  if (result.failure) {
    throw new Error(`${result.failure.runtime} runtime ${result.failure.kind}: ${result.failure.message}`);
  }
  // Keep later CEO/manager turns in the same firm run on the runtime that
  // actually survived the fallback. Worker turns still resolve independently
  // from the Worker role pool.
  if (oneControllerPreferred && tier === 1 && !sameRuntime(executedRuntime, p.active)) {
    p.active = executedRuntime;
    p.picked = executedPicked;
  }
  const executionResolution = workloadResolution && !sameRuntime(executedRuntime, active)
    ? {
        ...workloadResolution,
        runtime: { ...executedRuntime },
        source: "safe-fallback" as const,
        resolutionCodes: [
          ...workloadResolution.resolutionCodes,
          "runtime-failed-fell-back-to-role-priority",
        ],
      }
    : workloadResolution;
  // delegation 블록 분리 → 메모리 큐레이션(노드 agentId로) → 정리된 텍스트
  const safeResultText = restrictedFirmText(
    p,
    result.text,
    node.id,
    phase,
    memoryOwnerId,
    turn.chatId,
    memoryReadPath,
    nodePermission,
  );
  const { delegations, synthesisAllocation, cleanedText } = parseDelegations(safeResultText);
  let display = p.req.agentAppMode ? cleanAgentAppControlBlocks(cleanedText) : cleanedText;
  if (!p.req.agentAppMode && !firmProjectReadOnly(p, nodePermission)) {
    try {
      const curationContext = {
        turnId: firmMemoryTurnId(p, node.id, phase),
        projectPath: memoryReadPath,
        projectId: p.chat.projectId ?? null,
        agentId: memoryOwnerId,
        chatId: turn.chatId,
        runId: p.req.runId,
        nodeId: node.id,
        cwdAtRequest: workingFolder,
        teamRun: firmTeamMemoryRoute(p, memoryOwnerId),
        ...(node.agentId
          ? {
              experienceIntake: {
                platform: process.platform,
                arch: process.arch,
                runtimeKind: executedRuntime.kind,
                basePackageHash: getAgentById(node.agentId)?.packageHash ?? null,
                taskHint: turn.userPrompt,
              },
            }
          : {}),
      };
      const semanticOptions = await runSemanticMemoryReview({
        replyText: display,
        runner: executedPicked.runner,
        backendLabel: executedPicked.label,
        model: executedRuntime.model ?? undefined,
        effort: executedRuntime.effort ?? undefined,
        env: p.runnerEnv,
        locale: p.locale,
        signal: turn.signal ?? p.signal,
        hasProject: Boolean(memoryReadPath),
        hasAgent: Boolean(memoryOwnerId),
      }).catch(() => ({ semanticAttempted: true, semanticFailed: true }));
      const { cleanedText: c2 } = curateReply(display, curationContext, semanticOptions);
      display = c2 || display;
    } catch (error) {
      try {
        recordTerminalMemoryTurn({
          turnId: firmMemoryTurnId(p, node.id, phase),
          projectPath: memoryReadPath,
          projectId: p.chat.projectId ?? null,
          agentId: memoryOwnerId,
          chatId: turn.chatId,
          runId: p.req.runId,
          nodeId: node.id,
          cwdAtRequest: workingFolder,
        }, "curation_failed");
      } catch (ticketError) {
        console.error("[memory] firm curation failure receipt failed:", ticketError);
      }
      console.error("[memory] firm curation failed:", error);
    }
  }
  if (executionResolution) {
    const executedResolution = reconcileWorkloadRunnerResult(executionResolution, result);
    tryRecordRunEvent({
      runId: p.req.runId ?? `firm:${p.chat.id}`,
      kind: "workload_allocation",
      chatId: p.chat.id,
      nodeId: node.id,
      // 관측 기록이므로 기억 주인이 아니라 실제로 돈 신원을 적는다.
      agentId: nodeRuntimeId,
      payload: workloadAllocationReceipt(executedResolution, result.observedUsage),
    });
  }
  // per-node 완료 신호 — 이 노드의 한 턴이 끝났다. UI(오케스트레이션 트리)가 이 노드만 ▶→✓ 로 정리한다.
  // 단, plan 턴은 곧 delegate/synthesize가 이어지므로 완료로 보지 않는다 — orchestrator/본부 행이
  // 위임 단계 내내 ▶(실행)으로 유지되어 "끝난 듯 보였다 되돌아오는" 플리커를 막는다.
  if (phase !== "plan") emit({ kind: "tool-use", done: true,
    ...(typeof result.observedModel === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(result.observedModel)
      ? { observedModel: result.observedModel } : {}),
  });
  return { text: display, delegations, synthesisAllocation, evidence: executionEvidence.finalize() };
}

/** 종합 노드(본부·CEO)에게 주는 상충/실패 처리 규칙. borrowed-task-force의 종합 계약과 같은 문장을
 *  쓴다 — firm은 3-tier로 가장 복잡한데 지금까지 상충 지시가 한 줄도 없었다. status: failed로 표시된
 *  결과는 오류 문자열이지 산출물이 아니므로, 없는 내용을 지어내 메우지 말고 실패로 보고해야 한다. */
const CONFLICT_SYNTHESIS_GUIDANCE = [
  "Rules for this synthesis:",
  '- A result marked "status: failed" is an error message, not a deliverable. Never treat it as findings, and never invent content to fill its gap.',
  "- Resolve conflicts between results explicitly instead of averaging or silently picking one.",
  "- If a failed or missing result means the goal was not met, say so plainly rather than presenting a partial answer as complete.",
].join("\n");

function phaseStatus(locale: RuntimeLocale, phase: NodeTurn["phase"], name: string): string {
  const ko = locale === "ko";
  if (phase === "plan") return ko ? `${name} · 위임 계획 중` : `${name} · planning`;
  if (phase === "synthesize") return ko ? `${name} · 종합 중` : `${name} · synthesizing`;
  return ko ? `${name} · 작업 중` : `${name} · working`;
}

/** 본부(division) 지속 세션 1회 처리 — 자기 전문가에게 재위임 후 종합. */
async function runDivision(
  p: FirmRunParams,
  division: ResolvedDivision,
  brief: string,
  allocation: WorkloadAllocation,
  stageKind: "production" | "integration" | "verification",
  runtimeToolsDisabled = false,
): Promise<FirmStageResult> {
  const fkAgentId = division.agentId || p.ceoAgent.id; // FK-safe (실 agent 없으면 CEO id)
  const divChatId = p.req.agentAppMode
    ? `site-agent-app:${p.req.runId ?? "run"}:division:${division.id}`
    : getOrCreateDivisionSession(p.chat.id, division.id, fkAgentId).id;
  const history = p.req.agentAppMode ? [] : listChatMessages(divChatId, 80);
  if (!p.req.agentAppMode) appendChatMessage(divChatId, "user", brief);

  const specialists = division.specialists;
  const runDirectDivision = async () => {
    p.sink({
      kind: "tool-use",
      status: p.locale === "ko"
        ? `${division.name} · 직접 작업으로 전환`
        : `${division.name} · continuing as direct execution`,
      agentId: division.id,
      agentName: division.name,
      role: division.role,
      tier: 2,
      phase: "delegate",
    });
    return runNodeTurnSafe(p, {
      node: division,
      tier: 2,
      phase: "delegate",
      userPrompt: [
        brief,
        "",
        "[Direct division execution]",
        "No specialist was assigned to this division slot. You now own the assigned work directly.",
        "Carry out the requested assigned-stage work in the project folder, then verify the result before returning.",
      ].join("\n"),
      history: p.req.agentAppMode ? [] : listChatMessages(divChatId, 80),
      chatId: divChatId,
      divisionId: division.id,
      allocation,
      runtimeToolsDisabled: false,
    });
  };

  // A division with no specialists has nobody to plan a handoff to. Running a
  // read-only manager plan first used to spend minutes inspecting the project,
  // request denied shell commands, and only then discover the empty roster.
  // Enter the assigned execution stage immediately, matching the existing
  // single-division path.
  if (specialists.length === 0 && firmDivisionRequiresDirectExecution(stageKind, 0, runtimeToolsDisabled)) {
    const direct = await runDirectDivision();
    if (!p.req.agentAppMode) appendChatMessage(divChatId, "assistant", direct.text);
    return { node: division, result: direct.text, ok: direct.ok, evidence: direct.evidence };
  }
  const plan = await runNodeTurnSafe(p, {
    node: division,
    tier: 2,
    phase: "plan",
    userPrompt: brief,
    history,
    reports: specialists.length > 0 ? specialists : undefined,
    chatId: divChatId,
    divisionId: division.id,
    allocation,
    runtimeToolsDisabled,
  });

  let result = plan.text;
  let evidence = plan.evidence;
  // 위임이 없으면 본부 자기 턴(plan)이 곧 산출물이므로 그 성공 여부가 본부의 성공 여부다.
  let divisionOk = plan.ok;
  const matched = specialists.length > 0 ? matchTargets(plan.delegations, specialists) : [];
  if (matched.length > 0) {
    p.sink({
      kind: "tool-use",
      status: `${division.name} → ${matched.map((m) => m.node.name).join(", ")}`,
      agentId: division.id,
      agentName: division.name,
      role: division.role,
      tier: 2,
      phase: "delegate",
      delegateTo: matched.map((m) => m.node.id),
    });
    if (!emitDelegationMessages(p, division, 2, matched)) {
      return {
        node: division,
        result: handoffBlockedText(p, p.handoffGuard?.blocked?.reason ?? "permission"),
        ok: false,
        evidence: plan.evidence,
      };
    }
    const specResults = await parallelCap(matched, getAgentConcurrency(), async (m) => {
      const r = await runNodeTurnSafe(p, {
        node: m.node,
        tier: 3,
        phase: "delegate",
        userPrompt: m.brief,
        history: [],
        chatId: null, // ephemeral — 메모리는 node.id로 저장됨
        divisionId: division.id,
        allocation: m.allocation,
        runtimeToolsDisabled,
      });
      emitAgentMessage(p, m.node, division, "worker-to-orchestrator", 3, r.text);
      return { name: m.node.name, role: m.node.role, text: r.text, ok: r.ok, evidence: r.evidence };
    });
    if (p.handoffGuard?.blocked) {
      return {
        node: division,
        result: handoffBlockedText(p, p.handoffGuard.blocked.reason),
        ok: false,
        evidence: mergeFirmExecutionEvidence([plan.evidence, ...specResults.map((specialist) => specialist.evidence)]),
      };
    }
    // 실패한 전문가의 텍스트는 "(이름 응답 실패: …)" 같은 오류 문자열이다. status 없이 넘기면
    // 본부가 그걸 정상 산출물로 읽고 종합한다. borrowed-task-force의 기존 패턴과 동일하게 표기.
    const synthPrompt =
      `${brief}\n\n[Results from your specialists — synthesize into one division answer]\n` +
      `${CONFLICT_SYNTHESIS_GUIDANCE}\n\n` +
      specResults
        .map((s) => `## ${s.name} (${s.role})\nstatus: ${s.ok ? "ok" : "failed"}\n${s.text}`)
        .join("\n\n");
    const synth = await runNodeTurnSafe(p, {
      node: division,
      tier: 2,
      phase: "synthesize",
      userPrompt: synthPrompt,
      history: p.req.agentAppMode ? [] : listChatMessages(divChatId, 80),
      chatId: divChatId,
      divisionId: division.id,
      allocation: plan.synthesisAllocation ?? defaultWorkloadAllocation("synthesize"),
      runtimeToolsDisabled,
    });
    result = synth.text;
    divisionOk = synth.ok && specResults.every((s) => s.ok);
    evidence = mergeFirmExecutionEvidence([
      plan.evidence,
      ...specResults.map((specialist) => specialist.evidence),
      synth.evidence,
    ]);
  } else if (firmDivisionRequiresDirectExecution(stageKind, matched.length, runtimeToolsDisabled)) {
    // A division manager's roster-bearing plan turn is intentionally read-only.
    // Previously, when the manager selected no specialist (including divisions
    // with no specialist rows), that read-only plan text was accepted as the
    // assigned result.  Real implementation requests therefore ended with
    // "the folder is read-only" even though One had granted the installed firm
    // bounded project-write authority; verification slots could not even run
    // their checks. The manager owns the unassigned slot:
    // execute it as an ordinary delegated worker turn, which receives `write`
    // through firmNodePermission while read/pre-approval/control-plane turns
    // remain unchanged.
    const direct = await runDirectDivision();
    result = direct.text;
    divisionOk = direct.ok;
    evidence = mergeFirmExecutionEvidence([plan.evidence, direct.evidence]);
  }

  if (!p.req.agentAppMode) appendChatMessage(divChatId, "assistant", result);
  return { node: division, result, ok: divisionOk, evidence };
}

/** firm 채팅 진입점 — runMcpInvocation에서 firmId+divisions가 있으면 호출. */
export async function runFirmInvocation(p: FirmRunParams): Promise<FirmRunResult> {
  if (!p.req.runId) {
    p = { ...p, req: { ...p.req, runId: `firm-direct-${randomUUID()}` } };
  }
  handoffGuardFor(p);
  const { req, chat, org, sink } = p;
  const ko = p.locale === "ko";
  // 메인 버블 진행 표시 (un-attributed → 메인 메시지 step). 네트워크 패널은 속성 이벤트로 별도.
  const mainStatus = (text: string) => sink({ kind: "tool-use", status: text });

  // 메인 히스토리 캡처 후 사용자 메시지 영구화 (단일 경로와 동일)
  const suppliedPriorHistory = Array.isArray(p.priorHistory);
  const history = req.agentAppMode
    ? []
    : suppliedPriorHistory
      ? p.priorHistory!.map((entry) => ({ ...entry }))
      : listChatMessages(chat.id, 80);
  if (!req.agentAppMode && !suppliedPriorHistory) {
    // A product-authored continuation is durable context, not the person's turn.
    const systemAuthored = req.promptOrigin === "system";
    if (systemAuthored) {
      appendChatMessage(chat.id, "system", req.userPrompt);
    } else {
      // 첨부도 그 사람의 턴이다 — client.ts 의 같은 자리 주석 참고.
      appendChatMessage(chat.id, "user", req.userPrompt, req.images?.length ? { images: req.images } : undefined);
      if (history.length === 0) autoTitleFromFirstMessage(chat.id, req.userPrompt);
    }
  }

  const divisions = org.divisions;
  const singleDivision = divisions.length === 1;
  // CEO의 직속 보고자: 본부 2+면 본부들, 본부 1개면 그 본부의 전문가(tier-2 skip).
  const ceoReports: ResolvedNode[] = singleDivision ? divisions[0].specialists : divisions;

  if (ceoReports.length === 0) {
    // 위임할 하위가 없음 → CEO 단독 응답
    const solo = await runNodeTurnSafe(p, {
      node: org.ceo,
      tier: 1,
      phase: "synthesize",
      userPrompt: req.userPrompt,
      history,
      chatId: chat.id,
      toMainBubble: true,
      withImages: true,
    });
    if (!solo.ok) {
      sink({ kind: "error", error: firmFailure(req.agentAppMode, "ceo-failed", solo.text) });
      return { ok: false, text: solo.text };
    }
    if (!req.agentAppMode) appendChatMessage(chat.id, "assistant", solo.text);
    if (p.emitFinal !== false) sink({ kind: "final", text: solo.text });
    return { ok: true, text: solo.text };
  }

  // 1) CEO PLAN — 어떤 하위를 쓸지 선택
  mainStatus(ko ? "CEO가 작업을 분배하는 중…" : "CEO is planning the work…");
  const plan = await runNodeTurnSafe(p, {
    node: org.ceo,
    tier: 1,
    phase: "plan",
    userPrompt: req.userPrompt,
    history,
    reports: ceoReports,
    chatId: chat.id,
    withImages: true,
  });
  if (!plan.ok) {
    mainStatus(
      ko
        ? "CEO 위임 계획이 지연되어 단독 실행으로 자동 재시도합니다…"
        : "CEO planning stalled — retrying as a direct execution…",
    );
    const solo = await runNodeTurnSafe(p, {
      node: org.ceo,
      tier: 1,
      phase: "synthesize",
      userPrompt: req.userPrompt,
      history,
      chatId: chat.id,
      toMainBubble: true,
      withImages: true,
    });
    if (!solo.ok) {
      if (!req.agentAppMode) appendChatMessage(chat.id, "assistant", solo.text);
      sink({ kind: "error", error: firmFailure(req.agentAppMode, "ceo-failed", solo.text) });
      return { ok: false, text: solo.text };
    }
    if (!req.agentAppMode) appendChatMessage(chat.id, "assistant", solo.text);
    if (p.emitFinal !== false) sink({ kind: "final", text: solo.text });
    return { ok: true, text: solo.text };
  }

  const matched = matchTargets(plan.delegations, ceoReports);
  if (matched.length === 0) {
    // CEO가 위임 안 함 → plan.text가 곧 최종 답
    if (!req.agentAppMode) appendChatMessage(chat.id, "assistant", plan.text);
    if (p.emitFinal !== false) sink({ kind: "final", text: plan.text });
    return { ok: true, text: plan.text };
  }

  // 핸드오프: 네트워크 패널(속성) + 메인 버블(진행) 둘 다
  sink({
    kind: "tool-use",
    status: `${org.ceo.name} → ${matched.map((m) => m.node.name).join(", ")}`,
    agentId: org.ceo.id,
    agentName: org.ceo.name,
    role: org.ceo.role,
    tier: 1,
    phase: "delegate",
    delegateTo: matched.map((m) => m.node.id),
  });
  if (!emitDelegationMessages(p, org.ceo, 1, matched)) return handoffFailure(p);
  const initialStages = stageMatched(matched);
  mainStatus(
    initialStages.verification.length > 0
      ? (ko
          ? `${initialStages.production.length}개 제작 슬롯 병렬 실행 · 통합 ${initialStages.integration.length}개 · 독립 검증 ${initialStages.verification.length}개 대기…`
          : `${initialStages.production.length} production slots running · ${initialStages.integration.length} integration · ${initialStages.verification.length} verification waiting…`)
      : (ko
          ? `${matched.length}개 팀에 위임 — 병렬 실행 중…`
          : `Delegated to ${matched.length} — running in parallel…`),
  );

  // 2) DELEGATE — 구현/디자인은 병렬, 검증은 결과가 실제 폴더에 반영된 뒤 실행한다.
  // QA를 구현과 동시에 시작하면 빈 폴더를 검사한 실패 영수증이 정상 구현 결과와 충돌한다.
  const runMatched = async (
    targets: typeof matched,
    stageContext: string,
    stageKind: "production" | "integration" | "verification",
  ): Promise<FirmStageResult[]> => {
    const runtimeToolsDisabled = stageKind !== "production" && requestsInlineConversationResult(req.userPrompt);
    const projectRoot = p.workspaceBinding
      ? revalidateInvocationWorkspaceBinding(p.workspaceBinding)
      : p.workingFolder ?? getChatWorkingFolder(p.chat.id);
    const stagedPrompt = (brief: string) => stageKind === "verification"
      ? `${brief}\n\n[Independent verification stage]\nAll upstream production and integration WorkOrders have finished. Verify the bounded upstream deliverables below directly. Inspect the current project folder only for claims about files or runnable artifacts; do not search hidden Agentlas state, memory, contact ledgers, or prior-run logs for an inline result. Do not rely on an earlier empty-workspace observation.\n${stageContext}\n\nEnd the response with exactly <verification_verdict>PASS</verification_verdict> only when every requested acceptance condition passes after fixes. Otherwise end with <verification_verdict>FAIL</verification_verdict> and identify the remaining blocker.`
      : stageKind === "integration"
        ? `${brief}\n\n[Integration stage]\nThe upstream production WorkOrders have finished. Use the bounded upstream deliverables below directly. Inspect the current project folder only when the requested deliverable is a file or runnable artifact; for an inline report, do not call file-search tools or inspect hidden Agentlas state, memory, contact ledgers, or prior-run logs. Integrate every relevant upstream result into the requested final deliverable, then verify it before returning.\n${stageContext}`
        : brief;
    if (singleDivision) {
      // tier-2 skip: matched는 전문가 — ephemeral 병렬
      return parallelCap(targets, getAgentConcurrency(), async (m) => {
        const userPrompt = stagedPrompt(m.brief);
        const r = await runNodeTurnSafe(p, {
          node: m.node,
          tier: 3,
          phase: "delegate",
          userPrompt,
          history: [],
          chatId: null,
          divisionId: divisions[0]?.id,
          allocation: m.allocation,
          runtimeToolsDisabled,
        });
        emitAgentMessage(p, m.node, org.ceo, "worker-to-orchestrator", 3, r.text);
        const verificationEvidence = stageKind === "verification"
          ? evaluateFirmVerificationEvidence({
              evidence: r.evidence,
              prompt: userPrompt,
              projectRoot,
              inlineOnly: runtimeToolsDisabled,
            })
          : null;
        const finalEvidence = verificationEvidence
          ? withFirmEvidenceIssues(r.evidence, verificationEvidence.issues)
          : r.evidence;
        return {
          node: m.node,
          result: stripVerificationVerdict(r.text),
          ok: stageKind === "verification"
            ? verificationResultOk(r.text, r.ok) && Boolean(verificationEvidence?.ok)
            : r.ok,
          evidence: finalEvidence,
        };
      });
    }
    // 본부들 — 지속 세션 병렬, 각자 전문가에게 재위임
    return parallelCap(targets, getAgentConcurrency(), async (m) => {
      const brief = stagedPrompt(m.brief);
      const result = await runDivision(
        p,
        m.node as ResolvedDivision,
        brief,
        m.allocation,
        stageKind,
        runtimeToolsDisabled,
      );
      emitAgentMessage(p, result.node, org.ceo, "worker-to-orchestrator", 2, result.result);
      const verificationEvidence = stageKind === "verification"
        ? evaluateFirmVerificationEvidence({
            evidence: result.evidence,
            prompt: brief,
            projectRoot,
            inlineOnly: runtimeToolsDisabled,
          })
        : null;
      const finalEvidence = verificationEvidence
        ? withFirmEvidenceIssues(result.evidence, verificationEvidence.issues)
        : result.evidence;
      return {
        ...result,
        result: stripVerificationVerdict(result.result),
        ok: stageKind === "verification"
          ? verificationResultOk(result.result, result.ok) && Boolean(verificationEvidence?.ok)
          : result.ok,
        evidence: finalEvidence,
      };
    });
  };
  const productionResults = await runMatched(initialStages.production, "", "production");
  let integrationResults: FirmStageResult[] = [];
  if (initialStages.integration.length > 0) {
    mainStatus(ko ? "제작 결과 준비 완료 — 통합 중…" : "Production ready — integration running…");
    integrationResults = await runMatched(initialStages.integration, resultStatusContext(productionResults), "integration");
  }
  let verificationResults: FirmStageResult[] = [];
  if (initialStages.verification.length > 0) {
    const upstream = [...productionResults, ...integrationResults];
    mainStatus(ko ? "제작 결과 준비 완료 — 독립 검증 중…" : "Production ready — independent verification running…");
    verificationResults = await runMatched(
      initialStages.verification,
      resultStatusContext(upstream),
      "verification",
    );
  }
  const teamResults = [...productionResults, ...integrationResults, ...verificationResults];
  if (p.handoffGuard?.blocked) return handoffFailure(p);
  const usedDivisionIds = new Set(matched.map((item) => item.node.id));
  const divisionAttempts = new Map(matched.map((item) => [item.node.id, 1]));

  // 3) CEO SYNTHESIZE — 팀 결과 종합 → 최종 답 (메인 버블)
  mainStatus(ko ? "팀 결과를 종합하는 중…" : "Synthesizing team results…");
  const synthPrompt =
    `${req.userPrompt}\n\n[Results from your team — synthesize into one final answer for the user]\n` +
    `${CONFLICT_SYNTHESIS_GUIDANCE}\n\n` +
    teamResults
      .map((r) => `## ${r.node.name} (${r.node.role})\nstatus: ${r.ok ? "ok" : "failed"}\n${firmEvidencePromptSummary(r.evidence)}\n${r.result}`)
      .join("\n\n");
  // The team has already paid for and completed its production and verification
  // turns.  A controller-only synthesis failure must not make the parent task
  // force run the whole firm from scratch.  Retry only this bounded synthesis
  // step against the exact same team results, then return an honest failure if
  // the controller is still unavailable.
  const runCeoSynthesis = async (
    userPrompt: string,
    allocation: WorkloadAllocation,
  ) => {
    let turn = await runNodeTurnSafe(p, {
      node: org.ceo,
      tier: 1,
      phase: "synthesize",
      userPrompt,
      history,
      chatId: chat.id,
      reports: ceoReports,
      toMainBubble: true,
      allocation,
    });
    if (!turn.ok && !p.signal?.aborted) {
      mainStatus(
        ko
          ? "완료된 팀 결과를 보존한 채 종합 단계만 다시 진행하는 중…"
          : "Preserving completed team results and retrying synthesis only…",
      );
      turn = await runNodeTurnSafe(p, {
        node: org.ceo,
        tier: 1,
        phase: "synthesize",
        userPrompt:
          `${userPrompt}\n\n[Controller-only recovery]\n` +
          "The prior synthesis turn failed. Reuse the completed team results above exactly. " +
          "Do not delegate or rerun any worker. Produce the best honest final answer now, " +
          "clearly preserving any failed or missing acceptance condition.",
        history,
        chatId: chat.id,
        reports: ceoReports,
        toMainBubble: true,
        allocation,
      });
    }
    return turn;
  };
  let finalTurn = await runCeoSynthesis(
    synthPrompt,
    plan.synthesisAllocation ?? defaultWorkloadAllocation("synthesize"),
  );
  if (!finalTurn.ok) {
    sink({ kind: "error", error: firmFailure(req.agentAppMode, "ceo-failed", finalTurn.text) });
    return { ok: false, text: finalTurn.text };
  }

  // The controller can discover a genuinely missing downstream role only
  // after reading upstream results. Execute bounded, previously-unused
  // follow-up delegations instead of rendering "starting QA" prose and ending
  // the run without a corresponding WorkOrder or receipt.
  for (let round = 0; round < ceoReports.length; round += 1) {
    const hasFailedResult = !latestTeamResultsAllOk(teamResults);
    const followupMatched = matchTargets(finalTurn.delegations, ceoReports)
      .filter((item) => !usedDivisionIds.has(item.node.id) || (hasFailedResult && (divisionAttempts.get(item.node.id) ?? 0) < 2));
    if (followupMatched.length === 0) break;
    for (const item of followupMatched) {
      usedDivisionIds.add(item.node.id);
      divisionAttempts.set(item.node.id, (divisionAttempts.get(item.node.id) ?? 0) + 1);
    }
    if (!emitDelegationMessages(p, org.ceo, 1, followupMatched)) return handoffFailure(p);
    mainStatus(ko
      ? `추가로 필요한 ${followupMatched.length}개 작업 슬롯 실행 중…`
      : `Running ${followupMatched.length} newly required work slot(s)…`);
    const followupStages = stageMatched(followupMatched);
    const followupProductionResults = await runMatched(followupStages.production, "", "production");
    let followupIntegrationResults: FirmStageResult[] = [];
    if (followupStages.integration.length > 0) {
      const upstream = [...teamResults, ...followupProductionResults];
      mainStatus(ko ? "제작 결과 준비 완료 — 통합 중…" : "Production ready — integration running…");
      followupIntegrationResults = await runMatched(followupStages.integration, resultStatusContext(upstream), "integration");
    }
    let followupVerificationResults: FirmStageResult[] = [];
    if (followupStages.verification.length > 0) {
      const upstream = [...teamResults, ...followupProductionResults, ...followupIntegrationResults];
      mainStatus(ko ? "제작 결과 준비 완료 — 독립 검증 중…" : "Production ready — independent verification running…");
      followupVerificationResults = await runMatched(followupStages.verification, resultStatusContext(upstream), "verification");
    }
    // A verifier-directed correction is the new result for that exact role,
    // not a second independent answer beside the corrected one. Replace the
    // prior result whether it was marked failed or not: the verifier can flag a
    // defect in an otherwise successful writer result, and keeping both makes
    // the next QA pass compare stale and corrected copies together.
    for (const followupResult of [
      ...followupProductionResults,
      ...followupIntegrationResults,
      ...followupVerificationResults,
    ]) {
      const supersededIndex = teamResults.findIndex((result) => (
        result.node.id === followupResult.node.id
      ));
      if (supersededIndex >= 0) teamResults[supersededIndex] = followupResult;
      else teamResults.push(followupResult);
    }
    // When a failed verifier requested a correction from another role, that
    // verifier result is evidence about the old draft. Re-run only the same
    // verifier once against the corrected bounded upstream deliverables. If we
    // leave the old FAIL in teamResults, the parent sees the installed team as
    // failed and restarts the whole CEO/worker graph even though the requested
    // one-role correction already succeeded.
    const correctedNonVerification = followupProductionResults.length > 0 || followupIntegrationResults.length > 0;
    if (correctedNonVerification && followupVerificationResults.length === 0) {
      const failedVerifierIds = new Set(
        teamResults.filter((result) => !result.ok && isVerificationNode(result.node)).map((result) => result.node.id),
      );
      const verifierRechecks = matched.filter((item) => (
        failedVerifierIds.has(item.node.id) && (divisionAttempts.get(item.node.id) ?? 0) < 2
      ));
      if (verifierRechecks.length > 0) {
        for (const item of verifierRechecks) {
          usedDivisionIds.add(item.node.id);
          divisionAttempts.set(item.node.id, (divisionAttempts.get(item.node.id) ?? 0) + 1);
        }
        if (!emitDelegationMessages(p, org.ceo, 1, verifierRechecks)) return handoffFailure(p);
        mainStatus(ko ? "수정된 결과만 독립 재검수 중…" : "Rechecking only the corrected result…");
        const upstream = teamResults.filter((result) => !isVerificationNode(result.node));
        const rechecked = await runMatched(verifierRechecks, resultStatusContext(upstream), "verification");
        for (const verification of rechecked) {
          const index = teamResults.findIndex((result) => result.node.id === verification.node.id);
          if (index >= 0) teamResults[index] = verification;
          else teamResults.push(verification);
        }
      }
    }
    if (p.handoffGuard?.blocked) return handoffFailure(p);
    mainStatus(ko ? "추가 작업 결과를 종합하는 중…" : "Synthesizing the additional results…");
    finalTurn = await runCeoSynthesis(
      (
        `${req.userPrompt}\n\n[Updated results from your team — continue orchestration only if a still-unused required role is missing; otherwise return the final user result.]\n` +
        `${CONFLICT_SYNTHESIS_GUIDANCE}\n\n` +
        teamResults
          .map((result) => `## ${result.node.name} (${result.node.role})\nstatus: ${result.ok ? "ok" : "failed"}\n${firmEvidencePromptSummary(result.evidence)}\n${result.result}`)
          .join("\n\n")
      ),
      finalTurn.synthesisAllocation ?? plan.synthesisAllocation ?? defaultWorkloadAllocation("synthesize"),
    );
    if (!finalTurn.ok) {
      sink({ kind: "error", error: firmFailure(req.agentAppMode, "ceo-failed", finalTurn.text) });
      return { ok: false, text: finalTurn.text };
    }
  }

  if (!req.agentAppMode) appendChatMessage(chat.id, "assistant", finalTurn.text);
  // CEO 종합 턴의 성공은 팀의 성공이 아니다. 본부/전문가가 전멸해도 CEO가 문장을 만들어내면
  // 예전엔 return.ok 만 false 로 바꿨지만 direct Firm 호출부는 그 반환값을 소비하지 않고
  // 스트림의 `final` 이벤트로 실행을 정산한다. 그 결과 실패한 Worker의 복구 체크포인트가
  // 있어도 One 화면과 원장은 성공 terminal 로 뒤집혔다. 실패 종합문은 대화에 보존하되
  // user-visible terminal 은 error 로 닫고, nested Firm은 부모가 같은 ok=false를 정산한다.
  const teamOk = latestTeamResultsAllOk(teamResults);
  if (!teamOk) {
    if (p.emitFinal !== false) {
      sink({
        kind: "error",
        error: firmFailure(
          req.agentAppMode,
          "firm-incomplete",
          finalTurn.text || (ko ? "팀 작업이 완료되지 않았습니다." : "The team did not complete the task."),
        ),
      });
    }
    return { ok: false, text: finalTurn.text };
  }
  if (p.emitFinal !== false) sink({ kind: "final", text: finalTurn.text });
  return { ok: true, text: finalTurn.text };
}
