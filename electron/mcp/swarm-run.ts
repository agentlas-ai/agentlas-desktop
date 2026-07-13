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
  resolveWorkloadAllocation,
  workloadAllocationPromptExample,
  workloadAllocationReceipt,
  type WorkloadAllocation,
} from "../runtime/workload-routing";
import { buildAgentRuntimeOntologyContext } from "../ontology/runtime-context";

// 총 작업 수/라운드 안전 상한 — 무한 스폰·무한루프로부터 컴/지갑을 지키는 최후 방어선(엔진이 강제).
// 각 작업 = 실 LLM 호출이라 비용이 나가므로 보수적으로. (동시 실행 수는 별개로 슬라이더가 제어)
const SWARM_MAX_TASKS = 24;
const SWARM_MAX_ROUNDS = 100_000;

/** 스웜 워커에게 주는 규약 — 자기 작업을 하고, 새 하위작업/핸드오프가 필요하면 `## Spawn`으로. */
function swarmProtocol(goal: string, board: SwarmBoard, task: SwarmTask): string {
  const doneList = board.tasks
    .filter((t) => t.status === "done")
    .slice(-8)
    .map((t) => `- ${t.title}`)
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
    "",
    "RULES:",
    "1. Do your task concretely with available tools/files in the current working folder.",
    "2. If the goal needs MORE work beyond your task, split it into concrete next steps.",
    "   Judge each child's complexity, risk, context size, and precision needs yourself.",
    "   Assign provider-neutral capacity independently; do not put every worker on frontier.",
    "   End with a `## Spawn` JSON block when spawning:",
    "   ## Spawn",
    "   ```json",
    `   {"tasks":[{"role":"optional","brief":"concrete child task","allocation":${workloadAllocationPromptExample("delegate")}}]${!task.spawnedBy ? `,"synthesis":${workloadAllocationPromptExample("synthesize")}` : ""}}`,
    "   ```",
    !task.spawnedBy
      ? "   You are the initial seed: always include the synthesis allocation; use tasks:[] if no child is needed."
      : "   Omit the block if no child is needed. Role is optional.",
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
export async function runSwarmInvocation(p: BorrowedTaskForceParams): Promise<{ finalText: string }> {
  const goal = p.req.userPrompt;
  const runId = p.req.runId ?? `swarm-${Date.now()}`;
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
        break;
      case "spawn":
        tryRecordRunEvent({
          runId,
          kind: "swarm_spawn",
          chatId: p.chat.id,
          nodeId: ev.parent,
          payload: { spawnedTaskIds: ev.tasks.map((task) => task.id), count: ev.tasks.length },
        });
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

  // 한 작업을 활성 런타임으로 실행 → 텍스트 → `## Spawn` 파싱.
  const runOneTask = async (task: SwarmTask, board: SwarmBoard, signal?: AbortSignal) => {
    const resolution = task.allocation
      ? resolveWorkloadAllocation({
          allocation: task.allocation,
          runtime: p.active,
          phase: "delegate",
          manualOverride: p.runtimeOverride,
        })
      : null;
    const active = resolution?.runtime ?? p.active;
    if (resolution) {
      tryRecordRunEvent({
        runId,
        kind: "workload_allocation",
        chatId: p.chat.id,
        nodeId: task.id,
        agentId: task.id,
        payload: workloadAllocationReceipt(resolution),
      });
      if (resolution.resolutionCodes.includes("tier-unavailable-active-preserved")) {
        emit(task, {
          kind: "tool-use",
          status: p.locale === "ko"
            ? `${task.allocation?.tier} 등급 모델이 없어 활성 모델을 유지합니다.`
            : `${task.allocation?.tier} tier unavailable; preserving the active model.`,
        });
      }
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
    const result = await p.picked.runner(
      {
        // The canonical package prompt is authoritative, but the per-task
        // swarm protocol is invocation context. Passing both as the fallback
        // silently drops the protocol whenever a canonical prompt file exists.
        systemPrompt: [
          buildEffectiveAgentSystemPrompt(
            p.orchestratorAgent.id,
            p.orchestratorAgent.systemPrompt,
          ),
          swarmProtocol(goal, board, task),
          ontology.prompt,
        ].filter(Boolean).join("\n\n"),
        history: [],
        userPrompt: task.brief || task.title,
        backendLabel: p.picked.label,
        model: active.model ?? undefined,
        longContext: active.longContextEnabled ?? false,
        effort: active.effort ?? undefined,
        signal: signal ?? p.signal,
        permission: p.req.permissions,
        cwd: p.workingFolder ?? undefined,
        mcpConfigPath: p.mcpConfigPath,
        mcpAllowedTools: p.mcpAllowedTools,
        mcpCodexConfigArgs: p.mcpCodexConfigArgs,
        env: p.runnerEnv,
        locale: p.locale,
      },
      {
        onStatus: (status) => emit(task, { kind: "tool-use", status }),
        onPartial: (text) => emit(task, { kind: "partial", text }),
        onTool: (name, args, r, id, isError) => emit(task, { kind: "tool-use", tool: { name, args, result: r, id, isError } }),
      },
    );
    emit(task, { kind: "tool-use", done: true, status: p.locale === "ko" ? `${task.title} 완료` : `${task.title} done` });
    const parsed = parseSwarmOutput(result.text);
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
    const resolution = resolveWorkloadAllocation({
      allocation: board.synthesisAllocation ?? defaultWorkloadAllocation("synthesize"),
      runtime: p.active,
      phase: "synthesize",
      manualOverride: p.runtimeOverride,
    });
    const active = resolution.runtime;
    tryRecordRunEvent({
      runId,
      kind: "workload_allocation",
      chatId: p.chat.id,
      nodeId: "swarm-synthesizer",
      agentId: p.orchestratorAgent.id,
      payload: workloadAllocationReceipt(resolution),
    });
    if (resolution.resolutionCodes.includes("tier-unavailable-active-preserved")) {
      synthEmit({
        kind: "tool-use",
        status: p.locale === "ko"
          ? `${resolution.allocation.tier} 종합 등급을 사용할 수 없어 활성 모델로 종합합니다.`
          : `${resolution.allocation.tier} synthesis tier unavailable; preserving the active model.`,
      });
    }
    synthEmit({
      kind: "thinking",
      status: p.locale === "ko" ? "스웜 결과 종합 중…" : "Synthesizing swarm results…",
      model: active.model ?? active.kind,
    });
    const pieces = done.map((t, i) => `### ${i + 1}. ${t.title}\n${t.result}`).join("\n\n");
    const ontology = await buildAgentRuntimeOntologyContext({
      runSessionId: runId,
      installedAgent: p.orchestratorAgent,
      projectId: p.chat.projectId,
      projectPath: p.workingFolder,
      runtimeKind: active.kind,
      task: goal,
      includeOperational: false,
    });
    const result = await p.picked.runner(
      {
        systemPrompt: [
          buildEffectiveAgentSystemPrompt(
            p.orchestratorAgent.id,
            p.orchestratorAgent.systemPrompt,
          ),
          "",
          "You are the synthesizer of an agent swarm. Below are the results your peers produced for the shared goal.",
          "Integrate them into ONE coherent final answer for the user. Reconcile overlaps, note anything incomplete.",
          "Do not just concatenate. Do not include a `## Spawn` block.",
          `SHARED GOAL: ${goal}`,
          ontology.prompt,
        ].join("\n"),
        history: [],
        userPrompt: pieces || "(no completed results)",
        backendLabel: p.picked.label,
        model: active.model ?? undefined,
        longContext: active.longContextEnabled ?? false,
        effort: active.effort ?? undefined,
        signal: signal ?? p.signal,
        permission: p.req.permissions,
        cwd: p.workingFolder ?? undefined,
        env: p.runnerEnv,
        locale: p.locale,
      },
      {
        onStatus: (status) => synthEmit({ kind: "tool-use", status }),
        onPartial: (text) => synthEmit({ kind: "partial", text }),
        onTool: (name, args, r, id, isError) => synthEmit({ kind: "tool-use", tool: { name, args, result: r, id, isError } }),
      },
    );
    return result.text.trim();
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

  const finalText = aborted
    ? p.locale === "ko"
      ? `스웜을 멈췄어요. (완료 ${doneCount}개)`
      : `Swarm stopped. (${doneCount} tasks done)`
    : final || (p.locale === "ko" ? "스웜이 완료할 작업을 찾지 못했습니다." : "The swarm found no work to complete.");
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
