// 자율 복구 학습(성공→기억→진화) — 실패 스트릭 후 방법 전환으로 성공한 자동화 런을
// (1) durable 복구 이벤트로 기록하고, (2) 에이전트 메모리 + Experience 후보로 남긴 뒤
// 실제 성공 런 영수증(outcome)으로 자동 승격한다. 실행 횟수나 오류 문자열은
// 관측 증거일 뿐이며, 코드가 그 증거로 프롬프트 문구를 만들거나 적용하지 않는다.
// 이 모듈의 어떤 실패도 자동화 런 결과를 오염시키면 안 된다 — 모든 단계는 격리 try/catch.
import type { Automation } from "../shared/types";
import {
  AUTOMATION_RECOVERY_EVENT_KIND,
  countAutomationRecoveryEvents,
  tryRecordRunEvent,
} from "./store/run-events";
import { insertMemoryEntry } from "./memory/store";
import {
  autoIntakeCuratedMemory,
  findExperienceCandidateBySourceMemory,
  promoteExperienceCandidateFromRunReceipt,
} from "./experience/store";
import { getAgentById } from "./mcp/registry";
import { appendChatMessage } from "./store/chats";
import { getOrCreateAutomationSession } from "./store/automation-sessions";
import {
  extractStrategyChangeLine,
  failureSignature,
  type AutomationFailureContext,
} from "./automation-strategy";


export interface AutomationRecoveryInput {
  automation: Automation;
  runId: string;
  /** 이번 성공 런 "이전"의 실패 맥락(실행 시작 전에 수집된 값). */
  prior: AutomationFailureContext;
  output?: string;
}

export interface AutomationRecoveryReceipt {
  signature: string;
  recoveryCount: number;
  memoryId: string | null;
  experiencePromoted: boolean;
  evolutionApplied: boolean;
  evolutionProposalId: string | null;
}

function appendAutomationChatMessage(automation: Automation, text: string): void {
  try {
    const chat = getOrCreateAutomationSession({
      automationId: automation.id,
      runtimeSelection: automation.runtimeSelection ?? null,
      ...(automation.targetType === "firm"
        ? { firmId: automation.targetId }
        : automation.targetType === "agent"
          ? { agentId: automation.targetId }
          : {}),
    });
    appendChatMessage(chat.chat.id, "system", text);
  } catch (error) {
    console.warn("[automation-recovery] chat feedback failed:", error);
  }
}

function recoveryMemoryContent(input: AutomationRecoveryInput, strategyChange: string | null): string {
  const errors = input.prior.recentErrors.slice(0, 3).join(" | ") || "unknown failure";
  const method = strategyChange
    ? `Working method: ${strategyChange}.`
    : "The winning method was not declared; consult the successful run transcript.";
  return (
    `Recovery playbook for automation "${input.automation.name}": ` +
    `after ${input.prior.streak} consecutive failures (${errors}), a strategy change succeeded. ${method} ` +
    `Evidence run: ${input.runId}.`
  );
}

/**
 * 성공 런 마무리 훅 — 실패 스트릭(prior.streak >= 1) 후의 성공에서만 호출된다.
 * 어떤 예외도 밖으로 던지지 않는다(런 결과·스케줄에 영향 금지).
 */
export function recordAutomationRecovery(input: AutomationRecoveryInput): AutomationRecoveryReceipt | null {
  if (input.prior.streak < 1) return null;
  const signature = failureSignature(input.prior.recentErrors);
  const strategyChange = extractStrategyChangeLine(input.output);

  try {
    tryRecordRunEvent({
      runId: input.runId,
      kind: AUTOMATION_RECOVERY_EVENT_KIND,
      automationId: input.automation.id,
      ...(input.automation.targetType === "agent" ? { agentId: input.automation.targetId } : {}),
      payload: {
        signature,
        priorStreak: input.prior.streak,
        errors: input.prior.recentErrors.slice(0, 3),
        strategyChange: strategyChange ?? null,
      },
    });
  } catch (error) {
    console.warn("[automation-recovery] recovery event record failed:", error);
  }

  let recoveryCount = 1;
  try {
    recoveryCount = Math.max(1, countAutomationRecoveryEvents(input.automation.id, signature));
  } catch {
    /* 집계 실패는 1회로 취급(진화 임계 미달로만 작동) */
  }

  let memoryId: string | null = null;
  let experiencePromoted = false;
  if (input.automation.targetType === "agent") {
    const agentId = input.automation.targetId;
    try {
      const memory = insertMemoryEntry({
        scope: "agent_repo",
        kind: "procedure",
        content: recoveryMemoryContent(input, strategyChange),
        agentId,
        confidence: strategyChange ? "high" : "medium",
        sensitivity: "internal",
        evidence: [input.runId],
        requestContext: {
          userIntent: `automation recovery: ${input.automation.name}`.slice(0, 200),
          triggerTerms: [],
        },
      });
      memoryId = memory.id;
    } catch (error) {
      console.warn("[automation-recovery] recovery memory write failed:", error);
    }
    if (memoryId) {
      try {
        const basePackageHash = getAgentById(agentId)?.packageHash ?? null;
        autoIntakeCuratedMemory({
          memory: {
            id: memoryId,
            kind: "procedure",
            content: recoveryMemoryContent(input, strategyChange),
            confidence: strategyChange ? "high" : "medium",
            sensitivity: "internal",
            requestContext: {
              userIntent: `automation recovery: ${input.automation.name}`.slice(0, 200),
              triggerTerms: [],
            },
          },
          agentId,
          environment: { platform: process.platform, arch: process.arch, runtimeKind: "agentlas-desktop" },
          basePackageHash,
          taskHint: input.automation.promptTemplate?.slice(0, 400) ?? input.automation.name,
          runId: input.runId,
        });
        const candidate = findExperienceCandidateBySourceMemory(agentId, memoryId);
        if (candidate && candidate.status === "candidate") {
          promoteExperienceCandidateFromRunReceipt({ candidateId: candidate.id, runId: input.runId });
          experiencePromoted = true;
        }
      } catch (error) {
        console.warn("[automation-recovery] experience outcome promotion deferred:", error);
      }
    }
  }

  const lines = [
    `🧬 방법 전환으로 복구 성공 — 이전 ${input.prior.streak}회 실패하던 작업이 이번 실행에서 성공했습니다.`,
    strategyChange ? `🔀 전환된 전략: ${strategyChange}` : "🔀 전환된 전략이 선언되지 않아 이번 런 기록을 근거로 남깁니다.",
    experiencePromoted
      ? "🧠 이 경험을 자동으로 기억했습니다(성공 영수증 기반 자동 승격)."
      : memoryId
        ? "🧠 이 경험을 에이전트 메모리에 기록했습니다."
        : "🧠 대상이 단일 에이전트가 아니어서 실행 기록으로만 남깁니다.",
  ];
  appendAutomationChatMessage(input.automation, lines.join("\n"));

  return {
    signature,
    recoveryCount,
    memoryId,
    experiencePromoted,
    // Only One may author a semantic prompt change. This recorder preserves
    // evidence and memory; it never fabricates an evolution proposal.
    evolutionApplied: false,
    evolutionProposalId: null,
  };
}
