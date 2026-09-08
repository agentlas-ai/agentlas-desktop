// 스웜 실행 배선 — 순수 엔진(swarm-engine)을 실제 러너/채팅에 연결한다.
//   - 각 작업(task)을 활성 런타임으로 실행하며 이벤트를 task 단위로 태깅 → UI가 스웜을 라이브로 표시
//   - 에이전트 출력의 `## Spawn` 블록을 파싱해 런타임에 새 작업/핸드오프를 그래프에 추가(emergent)
//   - 준비/실행 작업이 소진되면 종합 → 최종 답변을 메인 버블에 스트리밍 + 채팅에 저장
import type { McpInvocationEvent } from "../../shared/types";
import { appendChatMessage, listChatMessages } from "../store/chats";
import {
  renderConversationContext,
  SWARM_HISTORY_CONTEXT_TOKENS,
} from "../runtime/continuity";
import { getAgentConcurrency } from "../store/concurrency";
import { tryRecordFailureEvent, tryRecordRunEvent } from "../store/run-events";
import type { BorrowedTaskForceParams } from "./borrowed-task-force";
import { runSwarm, type SwarmBoard, type SwarmEvent, type SwarmTask } from "./swarm-engine";
import { buildEffectiveAgentSystemPrompt } from "../agents/files";
import {
  defaultWorkloadAllocation,
  normalizeWorkloadAllocation,
  reconcileWorkloadRunnerResult,
  resolveWorkloadAllocationAcrossRuntimes,
  workloadAllocationPromptExample,
  workloadAllocationReceipt,
  workloadRuntimeInventory,
  type WorkloadAllocation,
} from "../runtime/workload-routing";
import { pickActive, pickRunner, rolePriorityRuntimes } from "../runtime/selection";
import { runnerFailureFromError } from "../runtime/runner";
import { buildAgentRuntimeOntologyContext } from "../ontology/runtime-context";
import {
  isMobileReadRuntimeAllowed,
  MobileReadRuntimeBoundaryError,
  revalidateInvocationWorkspaceBinding,
} from "../invocation/workspace-binding";
import { stripReplyMemoryEventsReadOnly } from "../memory/curator";
import { buildProjectContextSlice } from "../memory/context-map";
import { STORMBREAKER_LOOP_PROTOCOL } from "../hephaestus/loop-engineering";
import type { CoreStormbreakerHarness } from "../hephaestus/commands";

// 총 작업 수/라운드 안전 상한 — 무한 스폰·무한루프로부터 컴/지갑을 지키는 최후 방어선(엔진이 강제).
// 각 작업 = 실 LLM 호출이라 비용이 나가므로 보수적으로. (동시 실행 수는 별개로 슬라이더가 제어)
const SWARM_MAX_TASKS = 24;
const SWARM_MAX_ROUNDS = 100_000;

function mainOneProfileContext(req: BorrowedTaskForceParams["req"]): string {
  const value = (req as BorrowedTaskForceParams["req"] & { oneProfileContext?: unknown }).oneProfileContext;
  return typeof value === "string" && value.length > 0 && value.length <= 16_000 ? value : "";
}

function restrictedSwarmText(
  p: BorrowedTaskForceParams,
  text: string,
  nodeId: string,
): string {
  if (!p.restrictedReadBoundary) return text;
  return stripReplyMemoryEventsReadOnly(text, {
    projectPath: p.workingFolder ?? null,
    projectId: p.chat.projectId ?? null,
    agentId: p.chat.agentId,
    chatId: p.chat.id,
    runId: p.req.runId,
    nodeId,
    cwdAtRequest: p.workingFolder ?? null,
  }).cleanedText;
}

/** 스웜 워커에게 주는 규약 — 자기 작업을 하고, 새 하위작업/핸드오프가 필요하면 `## Spawn`으로. */
function swarmProtocol(
  goal: string,
  board: SwarmBoard,
  task: SwarmTask,
  runtimeInventory: ReturnType<typeof workloadRuntimeInventory>,
  conversationContext = "",
): string {
  const doneList = board.tasks
    .filter((t) => t.status === "done")
    .slice(-8)
    .map((t) => `- ${t.title}`)
    .join("\n");
  const assignedList = board.tasks
    .filter((t) => t.id !== task.id && t.status !== "failed")
    .slice(0, 24)
    .map((t) => `- [${t.status}] ${t.title}${t.brief ? ` — ${t.brief}` : ""}`)
    .join("\n");
  return [
    "You are one worker in an EMERGENT AGENT SWARM collaborating on a shared goal.",
    `SHARED GOAL: ${goal}`,
    conversationContext
      ? `\nONGOING CONVERSATION (this swarm continues the user's chat — interpret the goal in this context, and never call it a previous session):\n${conversationContext}`
      : "",
    "",
    "YOUR TASK RIGHT NOW:",
    `- ${task.title}${task.role ? ` (role: ${task.role})` : ""}`,
    task.brief ? `- Details: ${task.brief}` : "",
    "",
    doneList ? `Already completed by peers (recent):\n${doneList}` : "No peer results yet — you may be first.",
    assignedList ? `WORK ALREADY ASSIGNED TO PEERS (never duplicate these packets):\n${assignedList}` : "",
    "",
    "LIVE_RUNTIME_INVENTORY (the only allowed worker targets; copy runtimeId/modelId exactly):",
    JSON.stringify(runtimeInventory),
    "",
    "RULES:",
    "1. Do your task concretely with available tools/files in the current working folder.",
    "2. If the goal needs MORE work beyond your task, split it into concrete next steps.",
    "   Judge each child's complexity, risk, context size, and precision needs yourself.",
    "   As the parent model, choose runtimeId, modelId, and effort from LIVE_RUNTIME_INVENTORY for each child.",
    "   Do not infer IDs from model names and do not put every worker on frontier. Use the smallest sufficient live model.",
    "   End with a `## Spawn` JSON block when spawning:",
    "   ## Spawn",
    "   ```json",
    `   {"tasks":[{"role":"optional","brief":"concrete child task","files":["relative/path/it/writes.ts"],"allocation":${workloadAllocationPromptExample("delegate")}}]${!task.spawnedBy ? `,"synthesis":${workloadAllocationPromptExample("synthesize")}` : ""}}`,
    "   ```",
    !task.spawnedBy
      ? "   You are the initial seed: always include the synthesis allocation; use tasks:[] if no child is needed."
      : "   Omit the block if no child is needed. Role is optional.",
    "   Never spawn work that another pending, running, or completed peer packet already owns.",
    // 워커들은 하나의 작업 폴더를 공유한다. 선언이 있어야 호스트가 겹치는 작업을 직렬화해
    // 서로의 편집(또는 사용자 변경)을 덮어쓰는 것을 막을 수 있다.
    "   `files`: list every project file the child will CREATE or MODIFY (relative paths). Peers share one working folder, so the host serializes tasks that declare the same file. Omit it only for read-only or research work — an omitted list means the host cannot protect that file from a concurrent writer.",
    "3. Do NOT restate the whole goal. Do NOT invent work that isn't needed — over-spawning wastes the user's money.",
    "4. Everything above the `## Spawn` block is your result and is shared with peers on the blackboard.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 에이전트 출력에서 `## Spawn` 블록을 분리 → { result(본문), spawn[] }. */
export function parseSwarmOutput(text: string): {
  result: string;
  spawn: Array<{ title: string; brief: string; role?: string; files?: string[]; allocation: WorkloadAllocation }>;
  synthesisAllocation: WorkloadAllocation | null;
} {
  // 앞 개행을 먹지 않도록 수평 공백만([ \t]) 허용 — `\s`는 개행 포함이라 슬라이스가 어긋난다.
  const m = text.match(/^[ \t]*##[ \t]*Spawn[ \t]*$/im);
  if (!m || m.index === undefined) return { result: text.trim(), spawn: [], synthesisAllocation: null };
  const result = text.slice(0, m.index).trim();
  const afterHeading = text.slice(m.index + m[0].length);
  const fence = afterHeading.match(/```(?:json)?\s*([\s\S]*?)```/);
  const spawn: Array<{ title: string; brief: string; role?: string; files?: string[]; allocation: WorkloadAllocation }> = [];
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
      const rawTasks = Array.isArray(parsed)
        ? parsed
        : Array.isArray(obj.tasks)
          ? obj.tasks
          : [];
      for (const raw of rawTasks.slice(0, 12)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        const brief = typeof item.brief === "string" ? item.brief.trim() : "";
        const title = typeof item.title === "string" ? item.title.trim() : brief.slice(0, 80);
        const role = typeof item.role === "string" ? item.role.trim() || undefined : undefined;
        // 워커가 선언한 쓰기 대상. 스케줄러가 겹치는 작업을 직렬화하는 근거가 된다.
        const files = Array.isArray(item.files)
          ? [
              ...new Set(
                item.files
                  .map((file) => (typeof file === "string" ? file.trim() : ""))
                  .filter((file): file is string => Boolean(file))
                  .slice(0, 24),
              ),
            ]
          : undefined;
        if (brief) {
          spawn.push({
            title: title || brief.slice(0, 80),
            brief,
            role,
            ...(files?.length ? { files } : {}),
            allocation: normalizeWorkloadAllocation(item.allocation, "delegate"),
          });
        }
      }
      return {
        result,
        spawn,
        synthesisAllocation: obj.synthesis
          ? normalizeWorkloadAllocation(obj.synthesis, "synthesize")
          : null,
      };
    } catch {
      // Fall through to the legacy line parser below.
    }
  }
  const block = afterHeading.split("\n"); // legacy `role | brief` compatibility
  for (const raw of block) {
    const line = raw.trim();
    if (!line.startsWith("-")) {
      if (line.startsWith("#")) break; // 다음 섹션이면 종료
      continue;
    }
    const body = line.replace(/^-\s*/, "");
    // "role | brief" 또는 "| brief" 또는 "brief"
    const parts = body.split("|");
    let role: string | undefined;
    let brief: string;
    if (parts.length >= 2) {
      role = parts[0].trim() || undefined;
      brief = parts.slice(1).join("|").trim();
    } else {
      brief = body.trim();
    }
    if (brief) {
      spawn.push({
        title: brief.slice(0, 80),
        brief,
        role,
        allocation: defaultWorkloadAllocation("delegate", "legacy-spawn-format"),
      });
    }
    if (spawn.length >= 12) break; // 한 턴 스폰 상한
  }
  return { result, spawn, synthesisAllocation: null };
}

/** 스웜 실행 엔트리 — runMcpInvocation이 호출. 최종 텍스트를 반환하고 채팅에 저장한다. */
export async function runSwarmInvocation(
  p: BorrowedTaskForceParams & {
    runtimes?: BorrowedTaskForceParams["active"][];
    stormbreakerMode?: boolean;
    stormbreakerHarness?: CoreStormbreakerHarness;
  },
): Promise<{ finalText: string }> {
  const goal = p.req.userPrompt;
  if (p.stormbreakerMode && !p.stormbreakerHarness) {
    throw new Error("Stormbreaker requires the canonical Goal + UltraCode harness from Agentlas Core.");
  }
  // 대화 연속성 — 스웜으로 빠져도 같은 채팅의 맥락이 워커/신시사이저에 전달돼야 한다.
  // Main이 현재 턴을 저장하기 전에 캡처한 히스토리를 우선 사용한다.
  let conversationContext = "";
  try {
    const rawHistory = p.priorHistory ?? listChatMessages(p.chat.id, 60);
    const priorHistory = p.priorHistory
      ? rawHistory
      : rawHistory.length > 0 && rawHistory[rawHistory.length - 1].role === "user"
        ? rawHistory.slice(0, -1)
        : rawHistory;
    conversationContext = renderConversationContext(
      priorHistory,
      p.locale,
      SWARM_HISTORY_CONTEXT_TOKENS,
    ).block;
  } catch {
    // 히스토리 조회 실패가 스웜 실행 자체를 막아선 안 된다 — 맥락 없이 진행.
  }
  const coreHarnessPrompt = p.stormbreakerMode ? p.stormbreakerHarness?.system_prompt : undefined;
  if (p.restrictedReadBoundary && !isMobileReadRuntimeAllowed(p.active.kind)) {
    throw new MobileReadRuntimeBoundaryError(
      "This swarm runtime has no verified restricted read-only boundary. Select BYOK or Ollama on Desktop.",
    );
  }
  const sameRuntime = (left: typeof p.active, right: typeof p.active) => (
    left.kind === right.kind && left.backend === right.backend && left.source === right.source
  );
  const availableRuntimes = [...(p.runtimes ?? [p.active])];
  if (!availableRuntimes.some((runtime) => sameRuntime(runtime, p.active))) availableRuntimes.unshift(p.active);
  const runnableRuntimes = availableRuntimes.filter((runtime, index, list) => (
    list.findIndex((candidate) => sameRuntime(candidate, runtime)) === index && Boolean(pickRunner(runtime))
  ));
  const candidateRuntimes = p.restrictedReadBoundary
    ? runnableRuntimes.filter((runtime) => isMobileReadRuntimeAllowed(runtime.kind))
    : runnableRuntimes;
  if (p.restrictedReadBoundary && candidateRuntimes.length === 0) {
    throw new MobileReadRuntimeBoundaryError(
      "This swarm has no verified restricted read-only runtime. Select BYOK or Ollama on Desktop.",
    );
  }
  if (candidateRuntimes.length === 0) candidateRuntimes.push(p.active);
  const workerPriority = rolePriorityRuntimes(candidateRuntimes, "worker");
  const workerDefault = workerPriority[0] ?? pickActive(candidateRuntimes, "worker") ?? p.active;
  const workerDefaultRunner = sameRuntime(workerDefault, p.active)
    ? p.picked
    : pickRunner(workerDefault) ?? p.picked;
  const runtimeInventory = workloadRuntimeInventory(candidateRuntimes);
  const runId = p.req.runId ?? `swarm-${Date.now()}`;
  const stormStatus = (
    status: string,
    phase: "plan" | "delegate" | "synthesize" = "plan",
    done = false,
  ): void => {
    if (!p.stormbreakerMode) return;
    p.sink({
      kind: "thinking",
      status,
      agentId: "stormbreaker-supervisor",
      agentName: "Stormbreaker",
      role: "Goal · UltraCode",
      phase,
      done,
    });
  };
  const taskLabel = (task: SwarmTask): string => `“${task.title.replace(/\s+/g, " ").slice(0, 72)}”`;
  const runtimeLabel = (kind: string): string =>
    kind === "claude-code" ? "Claude Code" : kind === "codex" ? "Codex" : kind === "antigravity" ? "Antigravity" : kind;
  const emit = (task: SwarmTask, ev: McpInvocationEvent): void =>
    p.sink({ ...ev, agentId: task.id, agentName: task.title, role: task.role ?? "worker" });
  const recordSwarmEvent = (ev: SwarmEvent): void => {
    switch (ev.kind) {
      case "task-start":
      case "task-done":
        tryRecordRunEvent({
          runId,
          kind: `swarm_${ev.kind}`,
          chatId: p.chat.id,
          nodeId: ev.task.id,
          agentId: ev.task.id,
          payload: {
            title: ev.task.title,
            role: ev.task.role,
            status: ev.task.status,
            spawnedBy: ev.task.spawnedBy,
          },
        });
        if (ev.kind === "task-done") {
          stormStatus(
            p.locale === "ko"
              ? `Stormbreaker · ${taskLabel(ev.task)} 결과를 회수해 증거에 반영했습니다.`
              : `Stormbreaker · collected ${taskLabel(ev.task)} and added it to the evidence set.`,
            "delegate",
          );
        }
        break;
      case "task-failed":
        tryRecordRunEvent({
          runId,
          kind: "swarm_task_failed",
          chatId: p.chat.id,
          nodeId: ev.task.id,
          agentId: ev.task.id,
          payload: { title: ev.task.title, role: ev.task.role, reason: ev.reason },
        });
        tryRecordFailureEvent({
          runId,
          source: "swarm_task",
          chatId: p.chat.id,
          nodeId: ev.task.id,
          agentId: ev.task.id,
          errorCode: ev.reason ?? "task_failed",
          errorMessage: ev.reason ? `Swarm task failed: ${ev.reason}` : "Swarm task failed",
          payload: { title: ev.task.title, role: ev.task.role, spawnedBy: ev.task.spawnedBy },
        });
        stormStatus(
          p.locale === "ko"
            ? `Stormbreaker · ${taskLabel(ev.task)} 실패를 기록하고 안전하게 계속할 수 있는 작업을 확인합니다.`
            : `Stormbreaker · recorded the failure in ${taskLabel(ev.task)} and is checking safe remaining work.`,
          "delegate",
        );
        break;
      case "spawn":
        tryRecordRunEvent({
          runId,
          kind: "swarm_spawn",
          chatId: p.chat.id,
          nodeId: ev.parent,
          payload: { spawnedTaskIds: ev.tasks.map((task) => task.id), count: ev.tasks.length },
        });
        stormStatus(
          p.locale === "ko"
            ? `Stormbreaker · 부모 플래너가 ${ev.tasks.length}개 작업 패킷을 추가로 분해했습니다.`
            : `Stormbreaker · the parent planner decomposed ${ev.tasks.length} additional work packet${ev.tasks.length === 1 ? "" : "s"}.`,
          "plan",
        );
        break;
      case "capped":
        tryRecordRunEvent({
          runId,
          kind: "swarm_capped",
          chatId: p.chat.id,
          payload: { reason: ev.reason },
        });
        if (ev.reason !== "aborted") {
          tryRecordFailureEvent({
            runId,
            source: "swarm",
            chatId: p.chat.id,
            errorCode: ev.reason,
            errorMessage: `Swarm stopped by ${ev.reason} guard`,
          });
        }
        break;
      case "synthesize":
        tryRecordRunEvent({ runId, kind: "swarm_synthesize", chatId: p.chat.id });
        stormStatus(
          p.locale === "ko"
            ? "Stormbreaker · 작업 증거를 서로 대조하고 최종 완료 게이트를 판정합니다."
            : "Stormbreaker · cross-checking worker evidence and evaluating the final completion gate.",
          "synthesize",
        );
        break;
      case "round":
        break;
    }
  };
  tryRecordRunEvent({
    runId,
    kind: "swarm_started",
    chatId: p.chat.id,
    payload: { maxTasks: SWARM_MAX_TASKS, maxRounds: SWARM_MAX_ROUNDS, concurrency: getAgentConcurrency() },
  });
  stormStatus(
    p.locale === "ko"
      ? "Stormbreaker · 목표와 완료 조건을 잠그고 실행 범위를 정리합니다."
      : "Stormbreaker · locking the goal, completion checks, and execution scope.",
    "plan",
  );
  stormStatus(
    p.locale === "ko"
      ? `Stormbreaker · 연결된 ${runtimeInventory.length}개 런타임에서 작업별 모델·effort 후보를 확인했습니다.`
      : `Stormbreaker · inspected model and effort choices across ${runtimeInventory.length} connected runtime${runtimeInventory.length === 1 ? "" : "s"}.`,
    "plan",
  );

  // Parent allocation may select a different installed CLI per worker. The
  // host validates only its live inventory before invoking that CLI.
  const runOneTask = async (task: SwarmTask, board: SwarmBoard, signal?: AbortSignal) => {
    const resolution = task.allocation
      ? resolveWorkloadAllocationAcrossRuntimes({
        allocation: task.allocation,
        runtimes: candidateRuntimes,
        fallbackRuntime: workerDefault,
        phase: "delegate",
        manualOverride: p.runtimeOverride,
        explicitPinned: !p.workforceSelectionReceipt,
      })
    : null;
    const active = resolution?.runtime ?? workerDefault;
    const taskRunner = sameRuntime(active, workerDefault)
      ? workerDefaultRunner
      : pickRunner(active) ?? workerDefaultRunner;
    if (resolution) {
      task.resolvedAllocation = {
        runtimeId: resolution.resolvedRuntimeId,
        runtimeKind: active.kind ?? active.backend ?? null,
        model: active.model ?? null,
        effort: active.effort ?? null,
        source: resolution.source,
        resolutionCodes: [...resolution.resolutionCodes],
      };
      const effort = active.effort || resolution.allocation.effort || (p.locale === "ko" ? "기본" : "default");
      stormStatus(
        p.locale === "ko"
          ? `Stormbreaker · ${taskLabel(task)}에 ${runtimeLabel(active.kind)} · ${active.model ?? active.kind} · effort ${effort}를 배정했습니다.`
          : `Stormbreaker · assigned ${taskLabel(task)} to ${runtimeLabel(active.kind)} · ${active.model ?? active.kind} · effort ${effort}.`,
        "delegate",
      );
      if (resolution.resolutionCodes.some((code) => code.includes("active-preserved"))) {
        emit(task, {
          kind: "tool-use",
          status: p.locale === "ko"
            ? "상위 AI가 고른 런타임/모델이 실행 재고에 없어 활성 모델을 유지합니다."
            : "The parent-selected runtime/model pair is not in live inventory; preserving the active model.",
        });
      }
    }
    if (!resolution && !task.spawnedBy) {
      stormStatus(
        p.locale === "ko"
          ? "Stormbreaker · 부모 플래너가 목표를 독립 작업으로 나누고 런타임·모델·effort를 선택합니다."
          : "Stormbreaker · the parent planner is splitting the goal and selecting runtime, model, and effort per task.",
        "plan",
      );
    }
    emit(task, {
      kind: "thinking",
      status: p.locale === "ko" ? `${task.title}` : task.title,
      model: active.model ?? active.kind,
    });
    const ontology = await buildAgentRuntimeOntologyContext({
      runSessionId: runId,
      installedAgent: p.orchestratorAgent,
      projectId: p.chat.projectId,
      projectPath: p.workingFolder,
      runtimeKind: active.kind,
      task: task.brief || task.title,
      includeOperational: false,
    });
    const projectContextSlice = await buildProjectContextSlice(
      p.workingFolder ?? null,
      task.brief || task.title,
      { signal: p.signal },
    );
    if (p.signal?.aborted) throw new Error("Swarm worker cancelled");
    if (p.restrictedReadBoundary && !isMobileReadRuntimeAllowed(active.kind)) {
      throw new MobileReadRuntimeBoundaryError(
        "This swarm worker runtime has no verified restricted read-only boundary. Select BYOK or Ollama on Desktop.",
      );
    }
    if (p.workspaceBinding) revalidateInvocationWorkspaceBinding(p.workspaceBinding);
    // The canonical package prompt is authoritative, but the per-task
    // swarm protocol is invocation context. Passing both as the fallback
    // silently drops the protocol whenever a canonical prompt file exists.
    const workerSystemPrompt = [
      buildEffectiveAgentSystemPrompt(
        p.orchestratorAgent.id,
        p.orchestratorAgent.systemPrompt,
      ),
      !p.workspaceBinding && !p.req.agentAppMode ? mainOneProfileContext(p.req) : "",
      coreHarnessPrompt,
      swarmProtocol(goal, board, task, runtimeInventory, conversationContext),
      p.stormbreakerMode ? STORMBREAKER_LOOP_PROTOCOL : "",
      projectContextSlice ?? "",
      ontology.prompt,
    ].filter(Boolean).join("\n\n");
    const runWorkerOn = async (target: typeof p.active, targetRunner: typeof taskRunner) => {
      try {
        return await targetRunner.runner(
          {
            systemPrompt: workerSystemPrompt,
            history: [],
            userPrompt: task.brief || task.title,
            backendLabel: targetRunner.label,
            model: target.model ?? undefined,
            longContext: target.longContextEnabled ?? false,
            effort: target.effort ?? undefined,
            signal: signal ?? p.signal,
            permission: p.req.permissions,
            restrictedReadBoundary: p.restrictedReadBoundary,
            cwd: p.workingFolder ?? undefined,
            mcpConfigPath: p.mcpConfigPath,
            mcpAllowedTools: p.mcpAllowedTools,
            mcpCodexConfigArgs: p.mcpCodexConfigArgs,
            env: p.runnerEnv,
            locale: p.locale,
          },
          {
            onStatus: (status) => emit(task, { kind: "tool-use", status }),
            onPartial: (text) => {
              if (!p.restrictedReadBoundary) emit(task, { kind: "partial", text });
            },
            onTool: (name, args, r, id, isError) => emit(task, { kind: "tool-use", tool: { name, args, result: r, id, isError } }),
          },
        );
      } catch (error) {
        if ((signal ?? p.signal)?.aborted) throw error;
        return { text: "", failure: runnerFailureFromError(error, target.kind) };
      }
    };
    // A worker failure advances through the configured worker pool. The
    // parent allocation is descriptive input; the host's role order is the
    // executable source of truth for ordinary local/One swarm runs.
    let workerFellBack = false;
    let executedRuntime = active;
    let executedRunner = taskRunner;
    const announceFallback = (from: typeof active, to: typeof active, why: string): void => {
      workerFellBack = true;
      emit(task, {
        kind: "tool-use",
        status: p.locale === "ko"
          ? `워커 모델(${from.model ?? from.kind}) 실행 실패 — 우선순위 다음 모델(${to.model ?? to.kind})로 재시도: ${why}`
          : `Worker model (${from.model ?? from.kind}) failed — retrying on the next priority model (${to.model ?? to.kind}): ${why}`,
      });
    };
    let result: Awaited<ReturnType<typeof runWorkerOn>>;
    result = await runWorkerOn(executedRuntime, executedRunner);
    while (result.failure && !(signal ?? p.signal)?.aborted) {
      const fallback = rolePriorityRuntimes(candidateRuntimes, "worker", {
        failedRuntime: executedRuntime,
        failure: result.failure,
      })[0];
      const fallbackRunner = fallback ? pickRunner(fallback) : null;
      if (!fallback || !fallbackRunner) break;
      announceFallback(executedRuntime, fallback, result.failure.kind);
      executedRuntime = fallback;
      executedRunner = fallbackRunner;
      result = await runWorkerOn(executedRuntime, executedRunner);
    }
    if (result.failure) {
      throw new Error(`${result.failure.runtime} runtime ${result.failure.kind}: ${result.failure.message}`);
    }
    const effectiveResolution = resolution && workerFellBack
      ? {
          ...resolution,
          runtime: { ...executedRuntime },
          source: "safe-fallback" as const,
          resolutionCodes: [...resolution.resolutionCodes, "allocated-worker-failed-fell-back-to-default"],
        }
      : resolution;
    if (effectiveResolution) {
      const executedResolution = reconcileWorkloadRunnerResult(effectiveResolution, result);
      task.resolvedAllocation = {
        runtimeId: executedResolution.resolvedRuntimeId,
        runtimeKind: executedResolution.runtime.kind ?? executedResolution.runtime.backend ?? null,
        model: executedResolution.runtime.model ?? null,
        effort: executedResolution.runtime.effort ?? null,
        source: executedResolution.source,
        resolutionCodes: [...executedResolution.resolutionCodes],
      };
      tryRecordRunEvent({
        runId,
        kind: "workload_allocation",
        chatId: p.chat.id,
        nodeId: task.id,
        agentId: task.id,
        payload: workloadAllocationReceipt(executedResolution, result.observedUsage),
      });
    }
    emit(task, { kind: "tool-use", done: true, status: p.locale === "ko" ? `${task.title} 완료` : `${task.title} done` });
    const parsed = parseSwarmOutput(restrictedSwarmText(p, result.text, task.id));
    return {
      result: parsed.result,
      spawn: parsed.spawn,
      synthesisAllocation: parsed.synthesisAllocation ?? undefined,
    };
  };

  // 완료된 블랙보드를 하나로 종합 → 메인 버블에 스트리밍.
  const synthEmit = (ev: McpInvocationEvent): void =>
    p.sink({ ...ev, agentId: "swarm-synthesizer", agentName: "Swarm Synthesizer", role: "synthesizer", phase: "synthesize" });
  const synthesize = async (board: SwarmBoard, signal?: AbortSignal): Promise<string> => {
    const done = board.tasks.filter((t) => t.status === "done" && t.result);
    const oneControllerPreferred = p.req.oneMode === true
      && p.runtimePinHonored === true
      && Boolean(p.req.runtimeSelection);
    const controllerPriority = rolePriorityRuntimes(candidateRuntimes, "orchestrator");
    const controllerDefault = oneControllerPreferred
      ? p.active
      : p.runtimeOverride
        ? p.active
        : controllerPriority[0] ?? p.active;
    const resolution = resolveWorkloadAllocationAcrossRuntimes({
      allocation: board.synthesisAllocation ?? defaultWorkloadAllocation("synthesize"),
      runtimes: candidateRuntimes,
      fallbackRuntime: controllerDefault,
      phase: "synthesize",
      manualOverride: p.runtimeOverride,
      explicitPinned: !p.workforceSelectionReceipt,
    });
    const active = resolution.runtime;
    const synthesisRunner = sameRuntime(active, p.active) ? p.picked : pickRunner(active) ?? p.picked;
    if (resolution.resolutionCodes.some((code) => code.includes("active-preserved"))) {
      synthEmit({
        kind: "tool-use",
        status: p.locale === "ko"
          ? "상위 AI의 종합 런타임/모델이 실행 재고에 없어 활성 모델로 종합합니다."
          : "The parent-selected synthesis runtime/model is not in live inventory; preserving the active model.",
      });
    }
    synthEmit({
      kind: "thinking",
      status: p.locale === "ko" ? "스웜 결과 종합 중…" : "Synthesizing swarm results…",
      model: active.model ?? active.kind,
    });
    const pieces = done.map((t, i) => [
      `### ${i + 1}. ${t.title}`,
      `HOST-VERIFIED ALLOCATION: ${JSON.stringify(t.resolvedAllocation ?? null)}`,
      t.result,
    ].join("\n")).join("\n\n");
    const ontology = await buildAgentRuntimeOntologyContext({
      runSessionId: runId,
      installedAgent: p.orchestratorAgent,
      projectId: p.chat.projectId,
      projectPath: p.workingFolder,
      runtimeKind: active.kind,
      task: goal,
      includeOperational: false,
    });
    const projectContextSlice = await buildProjectContextSlice(
      p.workingFolder ?? null,
      goal,
      { signal: p.signal },
    );
    if (p.signal?.aborted) throw new Error("Swarm synthesis cancelled");
    if (p.restrictedReadBoundary && !isMobileReadRuntimeAllowed(active.kind)) {
      throw new MobileReadRuntimeBoundaryError(
        "This swarm synthesis runtime has no verified restricted read-only boundary. Select BYOK or Ollama on Desktop.",
      );
    }
    if (p.workspaceBinding) revalidateInvocationWorkspaceBinding(p.workspaceBinding);
    const runSynthesisOn = async (
      targetRuntime: typeof active,
      targetRunner: typeof synthesisRunner,
    ) => {
      try {
        return await targetRunner.runner(
          {
            systemPrompt: [
              buildEffectiveAgentSystemPrompt(
                p.orchestratorAgent.id,
                p.orchestratorAgent.systemPrompt,
              ),
              !p.workspaceBinding && !p.req.agentAppMode ? mainOneProfileContext(p.req) : "",
              coreHarnessPrompt,
              p.stormbreakerMode ? STORMBREAKER_LOOP_PROTOCOL : "",
              "You are the synthesizer of an agent swarm. Below are the results your peers produced for the shared goal.",
              "Integrate them into ONE coherent final answer for the user. Reconcile overlaps, note anything incomplete.",
              "Do not just concatenate. Do not include a `## Spawn` block.",
              `SHARED GOAL: ${goal}`,
              conversationContext
                ? `ONGOING CONVERSATION (this swarm continues the user's chat — answer as its natural next reply, and never call it a previous session):\n${conversationContext}`
                : "",
              projectContextSlice ?? "",
              ontology.prompt,
            ].join("\n"),
            history: [],
            userPrompt: pieces || "(no completed results)",
            backendLabel: targetRunner.label,
            model: targetRuntime.model ?? undefined,
            longContext: targetRuntime.longContextEnabled ?? false,
            effort: targetRuntime.effort ?? undefined,
            signal: signal ?? p.signal,
            permission: p.req.permissions,
            restrictedReadBoundary: p.restrictedReadBoundary,
            cwd: p.workingFolder ?? undefined,
            env: p.runnerEnv,
            locale: p.locale,
          },
          {
            onStatus: (status) => synthEmit({ kind: "tool-use", status }),
            onPartial: (text) => {
              if (!p.restrictedReadBoundary) synthEmit({ kind: "partial", text });
            },
            onTool: (name, args, r, id, isError) => synthEmit({ kind: "tool-use", tool: { name, args, result: r, id, isError } }),
          },
        );
      } catch (error) {
        if ((signal ?? p.signal)?.aborted) throw error;
        return { text: "", failure: runnerFailureFromError(error, targetRuntime.kind) };
      }
    };
    let executedRuntime = active;
    let executedRunner = synthesisRunner;
    let result = await runSynthesisOn(executedRuntime, executedRunner);
    while (
      result.failure
      && !p.workforceSelectionReceipt
      && !p.req.agentAppMode
      && !p.benchmarkMode
      && !(signal ?? p.signal)?.aborted
    ) {
      const fallback = rolePriorityRuntimes(candidateRuntimes, "orchestrator", {
        failedRuntime: executedRuntime,
        failure: result.failure,
      })[0];
      const fallbackRunner = fallback ? pickRunner(fallback) : null;
      if (!fallback || !fallbackRunner) break;
      if (oneControllerPreferred) p.onControllerRuntimeFallback?.(fallback, result.failure);
      synthEmit({
        kind: "tool-use",
        status: p.locale === "ko"
          ? "스웜 종합 런타임이 막혀 오케스트레이터 우선순위 다음 모델로 이어갑니다."
          : "The swarm synthesis runtime is unavailable; continuing on the next orchestrator-priority model.",
      });
      executedRuntime = fallback;
      executedRunner = fallbackRunner;
      result = await runSynthesisOn(executedRuntime, executedRunner);
    }
    if (result.failure) {
      throw new Error(`${result.failure.runtime} runtime ${result.failure.kind}: ${result.failure.message}`);
    }
    const executedResolution = reconcileWorkloadRunnerResult(
      executedRuntime === active
        ? resolution
        : {
            ...resolution,
            runtime: { ...executedRuntime },
            source: "safe-fallback" as const,
            resolutionCodes: [...resolution.resolutionCodes, "synthesis-runtime-failed-fell-back-to-priority"],
          },
      result,
    );
    tryRecordRunEvent({
      runId,
      kind: "workload_allocation",
      chatId: p.chat.id,
      nodeId: "swarm-synthesizer",
      agentId: p.orchestratorAgent.id,
      payload: workloadAllocationReceipt(executedResolution, result.observedUsage),
    });
    stormStatus(
      p.locale === "ko"
        ? "Stormbreaker · 검증된 작업 결과를 종합했습니다. 최종 게이트는 전체 패킷 상태를 확인한 뒤 판정합니다."
        : "Stormbreaker · synthesized verified worker results. The final gate will be evaluated from every packet state next.",
      "synthesize",
    );
    return restrictedSwarmText(p, result.text, "swarm-synthesizer").trim();
  };

  let idCounter = 0;
  let swarmResult: Awaited<ReturnType<typeof runSwarm>>;
  try {
    swarmResult = await runSwarm(
      goal,
      // 시드: 목표 자체를 첫 작업으로 — 첫 워커가 분해해서 `## Spawn`으로 그래프를 키운다.
      [{ title: goal.slice(0, 80), brief: goal }],
      { concurrency: getAgentConcurrency(), maxTasks: SWARM_MAX_TASKS, maxRounds: SWARM_MAX_ROUNDS },
      {
        nextId: () => `swarm-${++idCounter}`,
        runTask: runOneTask,
        synthesize,
        onEvent: (ev) => {
          /* 진행 이벤트는 runOneTask/synthesize 안에서 sink로 직접 흘리고, 원장에는 축약 메타만 남긴다. */
          recordSwarmEvent(ev);
        },
      },
      p.signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tryRecordFailureEvent({
      runId,
      source: "swarm",
      chatId: p.chat.id,
      errorCode: "swarm_threw",
      errorMessage: message,
    });
    throw error;
  }
  const { board, final, aborted, doneCount, finalGate } = swarmResult;

  if (p.stormbreakerMode) {
    const failedOrIncomplete = [...finalGate.blocked, ...finalGate.incomplete];
    stormStatus(
      finalGate.canReportSuccess
        ? p.locale === "ko"
          ? `Stormbreaker · 최종 게이트 통과: 필수 패킷 ${finalGate.passing.length}/${finalGate.required}개가 검증됐습니다.`
          : `Stormbreaker · final gate passed: ${finalGate.passing.length}/${finalGate.required} required packets verified.`
        : finalGate.status === "aborted"
          ? p.locale === "ko"
            ? `Stormbreaker · 최종 게이트 미검증: 실행이 중단되었습니다. 완료 ${finalGate.passing.length}/${finalGate.required}개.`
            : `Stormbreaker · final gate unverified: the run was stopped. ${finalGate.passing.length}/${finalGate.required} completed.`
          : p.locale === "ko"
            ? `Stormbreaker · 최종 게이트 차단: 필수 패킷 ${failedOrIncomplete.length}/${finalGate.required}개가 통과하지 못했습니다.`
            : `Stormbreaker · final gate blocked: ${failedOrIncomplete.length}/${finalGate.required} required packets did not pass.`,
      "synthesize",
      true,
    );
  }

  const rawFinalText = aborted
    ? p.locale === "ko"
      ? `스웜을 멈췄어요. (완료 ${doneCount}개)`
      : `Swarm stopped. (${doneCount} tasks done)`
    : finalGate.canReportSuccess
      ? final || (p.locale === "ko" ? "스웜이 완료할 작업을 찾지 못했습니다." : "The swarm found no work to complete.")
      : [
          p.locale === "ko"
            ? `Stormbreaker 최종 게이트 차단: 필수 패킷 ${finalGate.passing.length}/${finalGate.required}개만 통과했습니다. 통과하지 못한 패킷: ${[...finalGate.blocked, ...finalGate.incomplete].join(", ") || "알 수 없음"}. 아래 내용은 부분 결과이며 목표 완료 증명이 아닙니다.`
            : `Stormbreaker final gate blocked: only ${finalGate.passing.length}/${finalGate.required} required packets passed. Non-passing packets: ${[...finalGate.blocked, ...finalGate.incomplete].join(", ") || "unknown"}. The content below is partial output, not proof that the goal completed.`,
          final || (p.locale === "ko" ? "완료된 패킷의 결과가 없습니다." : "No completed packet result is available."),
        ].join("\n\n");
  const finalText = restrictedSwarmText(p, rawFinalText, "swarm-final");
  tryRecordRunEvent({
    runId,
    kind: "swarm_finished",
    chatId: p.chat.id,
    payload: {
      aborted,
      doneCount,
      taskCount: board.tasks.length,
      finalGate: {
        status: finalGate.status,
        canReportSuccess: finalGate.canReportSuccess,
        required: finalGate.required,
        passing: finalGate.passing.length,
        blocked: finalGate.blocked.length,
        incomplete: finalGate.incomplete.length,
      },
    },
  });
  // 채팅에 먼저 저장 → 그 다음 final 이벤트(정상 종료 경로와 동일 순서, 재접속 시 유실 방지).
  appendChatMessage(p.chat.id, "assistant", finalText);
  p.sink({ kind: "final", text: finalText });
  return { finalText };
}
