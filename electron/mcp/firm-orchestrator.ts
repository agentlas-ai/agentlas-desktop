// 멀티 에이전트 firm 오케스트레이터 — 3-tier (CEO → 본부 → 전문가).
//   PLAN: 리더가 <<Delegate>>로 필요한 하위만 선택 → DELEGATE: 하위 병렬 실행 → SYNTHESIZE.
//   본부(division)는 지속 세션(숨김 sub-chat, 히스토리·메모리 유지), 전문가는 1회성 worker.
//   본부 1개면 CEO=본부로 보고 tier-2 skip. 각 노드는 자기 agentId로 메모리를 쓰고 읽는다.
//   모든 이벤트는 agentId/role/tier/phase로 태깅 → 렌더러 네트워크 패널 실시간 텔레메트리.
import { randomUUID } from "node:crypto";
import type {
  ChatHistoryEntry,
  InstalledAgent,
  McpInvocationEvent,
  McpInvocationRequest,
  ResolvedDivision,
  ResolvedNode,
  ResolvedOrg,
  RuntimeStatus,
} from "../../shared/types";
import type { Runner } from "../runtime/runner";
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
import { pickRunner, selectRuntimeForTargets } from "../runtime/selection";
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

type EventSink = (ev: McpInvocationEvent) => void;

function mainOneProfileContext(req: McpInvocationRequest): string {
  const value = (req as McpInvocationRequest & { oneProfileContext?: unknown }).oneProfileContext;
  return typeof value === "string" && value.length > 0 && value.length <= 16_000 ? value : "";
}

function sameRuntime(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return left.kind === right.kind && left.backend === right.backend && left.source === right.source;
}

function firmCandidateRuntimes(
  p: FirmRunParams,
  baseActive: RuntimeStatus,
  manuallyPinned: boolean,
): RuntimeStatus[] {
  const supplied = p.req.agentAppMode || manuallyPinned ? [baseActive] : [...p.runtimes];
  if (!supplied.some((runtime) => sameRuntime(runtime, baseActive))) supplied.unshift(baseActive);
  const runnable = supplied.filter((runtime, index, list) => (
    list.findIndex((candidate) => sameRuntime(candidate, runtime)) === index && Boolean(pickRunner(runtime))
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
  req: McpInvocationRequest;
  chat: { id: string; projectId: string | null; firmId: string | null };
  org: ResolvedOrg;
  ceoAgent: InstalledAgent;
  /** Conversation turns captured before the current user request was stored. */
  priorHistory?: ChatHistoryEntry[];
  active: RuntimeStatus;
  runtimes: RuntimeStatus[];
  picked: { runner: Runner; label: string };
  workingFolder?: string | null;
  workspaceBinding?: InvocationWorkspaceBinding;
  restrictedReadBoundary?: true;
  mcpConfigPath?: string;
  mcpAllowedTools?: string[];
  mcpCodexConfigArgs?: string[];
  /** Main-minted opaque MCP aliases for a one-run Agent App grant. */
  agentAppMcpRuntimeEnv?: NodeJS.ProcessEnv;
  /** Marks the main-owned one-run grant unavailable after a runtime MCP fatal. */
  onAgentAppMcpRuntimeUnavailable?: () => void;
  runnerEnv?: NodeJS.ProcessEnv;
  locale: RuntimeLocale;
  sink: EventSink;
  signal?: AbortSignal;
  /** Nested teams return one result to their parent TF instead of emitting a user-visible final. */
  emitFinal?: boolean;
}

export interface FirmRunResult {
  ok: boolean;
  text: string;
}

function restrictedFirmText(
  p: FirmRunParams,
  text: string,
  nodeId: string,
  phase: NodeTurn["phase"],
  agentId: string | null,
  chatId: string | null | undefined,
  projectPath: string | null,
): string {
  if (!firmProjectReadOnly(p)) return text;
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

function firmProjectReadOnly(p: FirmRunParams): boolean {
  return p.restrictedReadBoundary === true ||
    (p.req.permissions !== "write" && p.req.permissions !== "full");
}

function firmMemoryTurnId(p: FirmRunParams, nodeId: string, phase: NodeTurn["phase"]): string {
  return `firm:run:${p.req.runId ?? "direct"}:chat:${p.chat.id}:node:${nodeId}:phase:${phase}`;
}

function firmTeamMemoryRoute(
  p: FirmRunParams,
  memberAgentId: string,
): NonNullable<Parameters<typeof curateReply>[1]["teamRun"]> {
  return {
    orchestratorAgentId: p.ceoAgent.id,
    memberAgentId: memberAgentId === p.ceoAgent.id ? null : memberAgentId,
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
  ok: boolean;
}> {
  const link = linkAbort(p.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    link.abort();
  }, NODE_TIMEOUT_MS);
  try {
    const r = await runNodeTurn(p, { ...turn, signal: link.signal });
    return { ...r, ok: true };
  } catch (err) {
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
        ok: false,
      };
    }
    if (timedOut) {
      return {
        text:
          p.locale === "ko"
            ? `(${turn.node.name} 응답 실패: ${Math.round(NODE_TIMEOUT_MS / 1000)}초 동안 응답이 없어 자동 중단했습니다.)`
            : `(${turn.node.name} failed: no response for ${Math.round(NODE_TIMEOUT_MS / 1000)}s, auto-aborted.)`,
        delegations: [],
        synthesisAllocation: null,
        ok: false,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: p.locale === "ko" ? `(${turn.node.name} 응답 실패: ${msg})` : `(${turn.node.name} failed: ${msg})`,
      delegations: [],
      synthesisAllocation: null,
      ok: false,
    };
  } finally {
    clearTimeout(timer);
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
}

/** 노드 1턴 실행 — 프롬프트 조립(노드 프롬프트 + per-agent 메모리 + 위임/메모리 프로토콜),
 *  러너 실행(속성 태깅 스트림), delegation 파싱 + 메모리 큐레이션. */
async function runNodeTurn(p: FirmRunParams, turn: NodeTurn): Promise<{
  text: string;
  delegations: Delegation[];
  synthesisAllocation: WorkloadAllocation | null;
}> {
  const { node, tier, phase } = turn;
  const memoryOwnerId = node.agentId ?? node.id;
  const tag = (ev: McpInvocationEvent): McpInvocationEvent => ({
    ...ev,
    agentId: node.id,
    runtimeAgentId: memoryOwnerId,
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
  let activePath: string | null = null;
  if (!p.req.agentAppMode && workingFolder) {
    if (p.req.permissions === "write" || p.req.permissions === "full") {
      try {
        const v = await recordFolderVisit(workingFolder, undefined, {
          permission: p.req.permissions,
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
      permission: p.req.permissions,
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
  const approvedOneContext = !p.workspaceBinding && !p.req.agentAppMode
    ? mainOneProfileContext(p.req)
    : "";
  if (approvedOneContext) systemPrompt += `\n\n${approvedOneContext}`;
  if (node.agentId && node.prompt?.trim() && !systemPrompt.includes(node.prompt.trim())) {
    systemPrompt += `\n\n## Firm role context\n${node.prompt.trim()}`;
  }
  if (!p.req.agentAppMode) {
    try {
      const mem = buildMemoryContext(memoryReadPath, memoryOwnerId, {
        materializeCodeMap: Boolean(activePath),
        taskPrompt: turn.userPrompt,
        projectId: p.chat.projectId ?? null,
      });
      if (mem) systemPrompt += `\n\n${mem}`;
      if (memoryReadPath) {
        const ontologyContext = await queryWorkingFolderOntologyContext(memoryReadPath, turn.userPrompt, {
          readOnly: firmProjectReadOnly(p),
        });
        if (ontologyContext.used) systemPrompt += `\n\n${ontologyContext.context}`;
      }
    } catch {
      // ignore memory failures
    }
  }
  const runtimeChoice = p.req.agentAppMode
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
        turn.tier === 1 ? "orchestrator" : "worker",
      );
  const baseActive = runtimeChoice?.picked ? runtimeChoice.active : p.active;
  const basePicked = runtimeChoice?.picked ?? p.picked;
  const candidateRuntimes = firmCandidateRuntimes(p, baseActive, Boolean(runtimeChoice?.override));
  if (turn.reports && turn.reports.length > 0) {
    systemPrompt += `\n\n${buildDelegateProtocol(
      turn.reports.map((r) => ({ role: r.role, name: r.name })),
      candidateRuntimes,
    )}`;
  }
  if (!p.req.agentAppMode && !firmProjectReadOnly(p)) {
    systemPrompt += `\n\n${memoryEmitterPromptFor(turn.userPrompt)}`;
  }

  const workloadResolution = turn.allocation
    ? resolveWorkloadAllocationAcrossRuntimes({
        allocation: turn.allocation,
        runtimes: candidateRuntimes,
        fallbackRuntime: baseActive,
        phase: turn.allocation.phase,
        manualOverride: runtimeChoice?.override ?? null,
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
  if (!p.req.agentAppMode && node.agentId) {
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
  const result = await picked.runner(
    {
      systemPrompt,
      history: p.req.agentAppMode ? [] : turn.history,
      userPrompt: turn.userPrompt,
      images: p.req.agentAppMode ? undefined : turn.withImages ? p.req.images : undefined,
      backendLabel: picked.label,
      model: active.model ?? undefined,
      longContext: active.longContextEnabled ?? false,
      effort: active.effort ?? undefined,
      signal: turn.signal ?? p.signal,
      permission: p.req.agentAppMode ? "read" : p.req.permissions,
      restrictedReadBoundary: p.restrictedReadBoundary,
      cwd: p.req.agentAppMode ? undefined : workingFolder ?? undefined,
      chatId: p.req.agentAppMode
        ? `site-agent-app:${p.req.runId ?? "run"}:${node.id}:${phase}:${randomUUID()}`
        : turn.chatId ?? undefined,
      mcpConfigPath: p.req.agentAppMode ? (agentAppAllowedTools ? p.mcpConfigPath : undefined) : p.mcpConfigPath,
      mcpAllowedTools: p.req.agentAppMode ? agentAppAllowedTools : p.mcpAllowedTools,
      mcpCodexConfigArgs: p.req.agentAppMode ? undefined : p.mcpCodexConfigArgs,
      env: p.req.agentAppMode
        ? buildAgentAppRunnerEnv(p.runnerEnv ?? process.env, p.agentAppMcpRuntimeEnv)
        : p.runnerEnv,
      untrustedNoTools: p.req.agentAppMode === true,
      untrustedAllowedMcpTools: agentAppAllowedTools,
      onAgentAppMcpRuntimeUnavailable: p.req.agentAppMode
        ? p.onAgentAppMcpRuntimeUnavailable
        : undefined,
      locale: p.locale,
    },
    {
      onStatus: (status) => {
        emit({ kind: "tool-use", status });
        if (turn.toMainBubble) p.sink({ kind: "tool-use", status });
      },
      onPartial: (text) => {
        if (!p.req.agentAppMode && !firmProjectReadOnly(p)) {
          emit({ kind: "partial", text });
          if (turn.toMainBubble) p.sink({ kind: "partial", text });
        }
      },
      onTool: (name, args, result, id, isError) => {
        const tool = { name, args, result, id, isError };
        emit({ kind: "tool-use", tool });
        if (turn.toMainBubble) p.sink({ kind: "tool-use", tool });
      },
    },
  );
  // delegation 블록 분리 → 메모리 큐레이션(노드 agentId로) → 정리된 텍스트
  const safeResultText = restrictedFirmText(
    p,
    result.text,
    node.id,
    phase,
    memoryOwnerId,
    turn.chatId,
    memoryReadPath,
  );
  const { delegations, synthesisAllocation, cleanedText } = parseDelegations(safeResultText);
  let display = p.req.agentAppMode ? cleanAgentAppControlBlocks(cleanedText) : cleanedText;
  if (!p.req.agentAppMode && !firmProjectReadOnly(p)) {
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
                runtimeKind: active.kind,
                basePackageHash: getAgentById(node.agentId)?.packageHash ?? null,
                taskHint: turn.userPrompt,
              },
            }
          : {}),
      };
      const semanticOptions = await runSemanticMemoryReview({
        replyText: display,
        runner: picked.runner,
        backendLabel: picked.label,
        model: active.model ?? undefined,
        effort: active.effort ?? undefined,
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
  if (workloadResolution) {
    const executedResolution = reconcileWorkloadRunnerResult(workloadResolution, result);
    tryRecordRunEvent({
      runId: p.req.runId ?? `firm:${p.chat.id}`,
      kind: "workload_allocation",
      chatId: p.chat.id,
      nodeId: node.id,
      agentId: memoryOwnerId,
      payload: workloadAllocationReceipt(executedResolution, result.observedUsage),
    });
  }
  // per-node 완료 신호 — 이 노드의 한 턴이 끝났다. UI(오케스트레이션 트리)가 이 노드만 ▶→✓ 로 정리한다.
  // 단, plan 턴은 곧 delegate/synthesize가 이어지므로 완료로 보지 않는다 — orchestrator/본부 행이
  // 위임 단계 내내 ▶(실행)으로 유지되어 "끝난 듯 보였다 되돌아오는" 플리커를 막는다.
  if (phase !== "plan") emit({ kind: "tool-use", done: true });
  return { text: display, delegations, synthesisAllocation };
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
): Promise<{ node: ResolvedNode; result: string; ok: boolean }> {
  const fkAgentId = division.agentId || p.ceoAgent.id; // FK-safe (실 agent 없으면 CEO id)
  const divChatId = p.req.agentAppMode
    ? `site-agent-app:${p.req.runId ?? "run"}:division:${division.id}`
    : getOrCreateDivisionSession(p.chat.id, division.id, fkAgentId).id;
  const history = p.req.agentAppMode ? [] : listChatMessages(divChatId, 80);
  if (!p.req.agentAppMode) appendChatMessage(divChatId, "user", brief);

  const specialists = division.specialists;
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
  });

  let result = plan.text;
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
      });
      return { name: m.node.name, role: m.node.role, text: r.text, ok: r.ok };
    });
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
    });
    result = synth.text;
    divisionOk = synth.ok && specResults.every((s) => s.ok);
  }

  if (!p.req.agentAppMode) appendChatMessage(divChatId, "assistant", result);
  return { node: division, result, ok: divisionOk };
}

/** firm 채팅 진입점 — runMcpInvocation에서 firmId+divisions가 있으면 호출. */
export async function runFirmInvocation(p: FirmRunParams): Promise<FirmRunResult> {
  if (!p.req.runId) {
    p = { ...p, req: { ...p.req, runId: `firm-direct-${randomUUID()}` } };
  }
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
    appendChatMessage(chat.id, "user", req.userPrompt);
    if (history.length === 0) autoTitleFromFirstMessage(chat.id, req.userPrompt);
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
  mainStatus(
    ko
      ? `${matched.length}개 팀에 위임 — 병렬 실행 중…`
      : `Delegated to ${matched.length} — running in parallel…`,
  );

  // 2) DELEGATE — 병렬 실행 (본부 2+: 지속 본부 세션 / 본부 1개: 전문가 ephemeral)
  // runNodeTurnSafe가 노드별 타임아웃 + 실패 격리 → 하나 실패해도 나머지는 계속.
  let teamResults: Array<{ node: ResolvedNode; result: string; ok: boolean }>;
  if (singleDivision) {
    // tier-2 skip: matched는 전문가 — ephemeral 병렬
    teamResults = await parallelCap(matched, getAgentConcurrency(), async (m) => {
      const r = await runNodeTurnSafe(p, {
        node: m.node,
        tier: 3,
        phase: "delegate",
        userPrompt: m.brief,
        history: [],
        chatId: null,
        divisionId: divisions[0]?.id,
        allocation: m.allocation,
      });
      return { node: m.node, result: r.text, ok: r.ok };
    });
  } else {
    // 본부들 — 지속 세션 병렬, 각자 전문가에게 재위임
    teamResults = await parallelCap(matched, getAgentConcurrency(), async (m) =>
      runDivision(p, m.node as ResolvedDivision, m.brief, m.allocation),
    );
  }

  // 3) CEO SYNTHESIZE — 팀 결과 종합 → 최종 답 (메인 버블)
  mainStatus(ko ? "팀 결과를 종합하는 중…" : "Synthesizing team results…");
  const synthPrompt =
    `${req.userPrompt}\n\n[Results from your team — synthesize into one final answer for the user]\n` +
    `${CONFLICT_SYNTHESIS_GUIDANCE}\n\n` +
    teamResults
      .map((r) => `## ${r.node.name} (${r.node.role})\nstatus: ${r.ok ? "ok" : "failed"}\n${r.result}`)
      .join("\n\n");
  const finalTurn = await runNodeTurnSafe(p, {
    node: org.ceo,
    tier: 1,
    phase: "synthesize",
    userPrompt: synthPrompt,
    history,
    chatId: chat.id,
    toMainBubble: true,
    allocation: plan.synthesisAllocation ?? defaultWorkloadAllocation("synthesize"),
  });
  if (!finalTurn.ok) {
    sink({ kind: "error", error: firmFailure(req.agentAppMode, "ceo-failed", finalTurn.text) });
    return { ok: false, text: finalTurn.text };
  }

  if (!req.agentAppMode) appendChatMessage(chat.id, "assistant", finalTurn.text);
  if (p.emitFinal !== false) sink({ kind: "final", text: finalTurn.text });
  // CEO 종합 턴의 성공은 팀의 성공이 아니다. 본부/전문가가 전멸해도 CEO가 문장을 만들어내면
  // 예전엔 ok:true로 완전 성공 보고됐다(실패 텍스트를 산출물로 오해한 종합문 + 성공 표시).
  // 자식 결과를 집계해 부분 완료가 성공으로 둔갑하지 않게 한다.
  return { ok: teamResults.every((r) => r.ok), text: finalTurn.text };
}
