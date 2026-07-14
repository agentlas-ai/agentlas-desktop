// 스웜 실행 배선 — 순수 엔진(swarm-engine)을 실제 러너/채팅에 연결한다.
//   - 각 작업(task)을 활성 런타임으로 실행하며 이벤트를 task 단위로 태깅 → UI가 스웜을 라이브로 표시
//   - 에이전트 출력의 `## Spawn` 블록을 파싱해 런타임에 새 작업/핸드오프를 그래프에 추가(emergent)
//   - 준비/실행 작업이 소진되면 종합 → 최종 답변을 메인 버블에 스트리밍 + 채팅에 저장
import type { McpInvocationEvent } from "../../shared/types";
import { appendChatMessage } from "../store/chats";
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
import { pickRunner } from "../runtime/selection";
import { buildAgentRuntimeOntologyContext } from "../ontology/runtime-context";
import {
  isMobileReadRuntimeAllowed,
  MobileReadRuntimeBoundaryError,
  revalidateInvocationWorkspaceBinding,
} from "../invocation/workspace-binding";
import { stripReplyMemoryEventsReadOnly } from "../memory/curator";
import { STORMBREAKER_LOOP_PROTOCOL } from "../hephaestus/loop-engineering";
import type { CoreStormbreakerHarness } from "../hephaestus/commands";

// 총 작업 수/라운드 안전 상한 — 무한 스폰·무한루프로부터 컴/지갑을 지키는 최후 방어선(엔진이 강제).
// 각 작업 = 실 LLM 호출이라 비용이 나가므로 보수적으로. (동시 실행 수는 별개로 슬라이더가 제어)
const SWARM_MAX_TASKS = 24;
const SWARM_MAX_ROUNDS = 100_000;

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
    `   {"tasks":[{"role":"optional","brief":"concrete child task","allocation":${workloadAllocationPromptExample("delegate")}}]${!task.spawnedBy ? `,"synthesis":${workloadAllocationPromptExample("synthesize")}` : ""}}`,
    "   ```",
    !task.spawnedBy
      ? "   You are the initial seed: always include the synthesis allocation; use tasks:[] if no child is needed."
      : "   Omit the block if no child is needed. Role is optional.",
    "   Never spawn work that another pending, running, or completed peer packet already owns.",
    "3. Do NOT restate the whole goal. Do NOT invent work that isn't needed — over-spawning wastes the user's money.",
    "4. Everything above the `## Spawn` block is your result and is shared with peers on the blackboard.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 에이전트 출력에서 `## Spawn` 블록을 분리 → { result(본문), spawn[] }. */
export function parseSwarmOutput(text: string): {
  result: string;
  spawn: Array<{ title: string; brief: string; role?: string; allocation: WorkloadAllocation }>;
  synthesisAllocation: WorkloadAllocation | null;
} {
  // 앞 개행을 먹지 않도록 수평 공백만([ \t]) 허용 — `\s`는 개행 포함이라 슬라이스가 어긋난다.
  const m = text.match(/^[ \t]*##[ \t]*Spawn[ \t]*$/im);
  if (!m || m.index === undefined) return { result: text.trim(), spawn: [], synthesisAllocation: null };
  const result = text.slice(0, m.index).trim();
  const afterHeading = text.slice(m.index + m[0].length);
  const fence = afterHeading.match(/```(?:json)?\s*([\s\S]*?)```/);
  const spawn: Array<{ title: string; brief: string; role?: string; allocation: WorkloadAllocation }> = [];
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
        if (brief) {
          spawn.push({
            title: title || brief.slice(0, 80),
            brief,
            role,
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
    kind === "claude-code" ? "Claude Code" : kind === "codex" ? "Codex" : kind === "gemini" ? "Gemini" : kind;
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
          fallbackRuntime: p.active,
          phase: "delegate",
          manualOverride: p.runtimeOverride,
        })
      : null;
    const active = resolution?.runtime ?? p.active;
    const taskRunner = sameRuntime(active, p.active) ? p.picked : pickRunner(active) ?? p.picked;
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
    if (p.restrictedReadBoundary && !isMobileReadRuntimeAllowed(active.kind)) {
      throw new MobileReadRuntimeBoundaryError(
        "This swarm worker runtime has no verified restricted read-only boundary. Select BYOK or Ollama on Desktop.",
      );
    }
    if (p.workspaceBinding) revalidateInvocationWorkspaceBinding(p.workspaceBinding);
    const result = await taskRunner.runner(
      {
        // The canonical package prompt is authoritative, but the per-task
        // swarm protocol is invocation context. Passing both as the fallback
        // silently drops the protocol whenever a canonical prompt file exists.
        systemPrompt: [
          buildEffectiveAgentSystemPrompt(
            p.orchestratorAgent.id,
            p.orchestratorAgent.systemPrompt,
          ),
          coreHarnessPrompt,
          swarmProtocol(goal, board, task, runtimeInventory),
          p.stormbreakerMode ? STORMBREAKER_LOOP_PROTOCOL : "",
          ontology.prompt,
        ].filter(Boolean).join("\n\n"),
        history: [],
        userPrompt: task.brief || task.title,
        backendLabel: taskRunner.label,
        model: active.model ?? undefined,
        longContext: active.longContextEnabled ?? false,
        effort: active.effort ?? undefined,
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
    if (resolution) {
      const executedResolution = reconcileWorkloadRunnerResult(resolution, result);
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
        payload: workloadAllocationReceipt(executedResolution),
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
    const resolution = resolveWorkloadAllocationAcrossRuntimes({
      allocation: board.synthesisAllocation ?? defaultWorkloadAllocation("synthesize"),
      runtimes: candidateRuntimes,
      fallbackRuntime: p.active,
      phase: "synthesize",
      manualOverride: p.runtimeOverride,
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
    if (p.restrictedReadBoundary && !isMobileReadRuntimeAllowed(active.kind)) {
      throw new MobileReadRuntimeBoundaryError(
        "This swarm synthesis runtime has no verified restricted read-only boundary. Select BYOK or Ollama on Desktop.",
      );
    }
    if (p.workspaceBinding) revalidateInvocationWorkspaceBinding(p.workspaceBinding);
    const result = await synthesisRunner.runner(
      {
        systemPrompt: [
          buildEffectiveAgentSystemPrompt(
            p.orchestratorAgent.id,
            p.orchestratorAgent.systemPrompt,
          ),
          coreHarnessPrompt,
          p.stormbreakerMode ? STORMBREAKER_LOOP_PROTOCOL : "",
          "You are the synthesizer of an agent swarm. Below are the results your peers produced for the shared goal.",
          "Integrate them into ONE coherent final answer for the user. Reconcile overlaps, note anything incomplete.",
          "Do not just concatenate. Do not include a `## Spawn` block.",
          `SHARED GOAL: ${goal}`,
          ontology.prompt,
        ].join("\n"),
        history: [],
        userPrompt: pieces || "(no completed results)",
        backendLabel: synthesisRunner.label,
        model: active.model ?? undefined,
        longContext: active.longContextEnabled ?? false,
        effort: active.effort ?? undefined,
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
    const executedResolution = reconcileWorkloadRunnerResult(resolution, result);
    tryRecordRunEvent({
      runId,
      kind: "workload_allocation",
      chatId: p.chat.id,
      nodeId: "swarm-synthesizer",
      agentId: p.orchestratorAgent.id,
      payload: workloadAllocationReceipt(executedResolution),
    });
    stormStatus(
      p.locale === "ko"
        ? "Stormbreaker · 최종 게이트 판정과 결과 종합을 마쳤습니다."
        : "Stormbreaker · completed the final-gate decision and result synthesis.",
      "synthesize",
      true,
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
  const { board, final, aborted, doneCount } = swarmResult;

  const rawFinalText = aborted
    ? p.locale === "ko"
      ? `스웜을 멈췄어요. (완료 ${doneCount}개)`
      : `Swarm stopped. (${doneCount} tasks done)`
    : final || (p.locale === "ko" ? "스웜이 완료할 작업을 찾지 못했습니다." : "The swarm found no work to complete.");
  const finalText = restrictedSwarmText(p, rawFinalText, "swarm-final");
  tryRecordRunEvent({
    runId,
    kind: "swarm_finished",
    chatId: p.chat.id,
    payload: { aborted, doneCount, taskCount: board.tasks.length },
  });
  // 채팅에 먼저 저장 → 그 다음 final 이벤트(정상 종료 경로와 동일 순서, 재접속 시 유실 방지).
  appendChatMessage(p.chat.id, "assistant", finalText);
  p.sink({ kind: "final", text: finalText });
  return { finalText };
}
