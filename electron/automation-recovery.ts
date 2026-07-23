// 자율 복구 학습(성공→기억→진화) — 실패 스트릭 후 방법 전환으로 성공한 자동화 런을
// (1) durable 복구 이벤트로 기록하고, (2) 에이전트 메모리 + Experience 후보로 남긴 뒤
// 실제 성공 런 영수증(outcome)으로 자동 승격하며, (3) 같은 실패 계열이 2회 독립 복구되면
// 프롬프트 진화 제안을 자동 생성·적용한다(사후통보 + 기존 롤백 경로 유지).
// 이 모듈의 어떤 실패도 자동화 런 결과를 오염시키면 안 된다 — 모든 단계는 격리 try/catch.
import { app, Notification } from "electron";
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
import {
  approveAndApplyAgentEvolutionProposal,
  createAgentEvolutionProposal,
} from "./agents/evolution";
import { inspectAgentFileText } from "./agents/files";
import { getOrCreateAutomationSession, appendChatMessage } from "./store/chats";
import {
  extractStrategyChangeLine,
  failureSignature,
  type AutomationFailureContext,
} from "./automation-strategy";

/** 같은 실패 서명이 이 횟수만큼 독립 복구되면 프롬프트 진화를 자동 적용한다. */
export const AUTONOMOUS_EVOLUTION_RECOVERY_THRESHOLD = 2;

/** evolution.ts의 rule 타깃 화이트리스트와 동일한 후보를 우선순위 순서로 탐색한다. */
const PROMPT_TARGET_CANDIDATES = [
  "system-prompt.md",
  "soul.md",
  "agent.md",
  "claude.md",
  "agents.md",
  "gemini.md",
  "persona.md",
  "prompt.md",
];

const AUTO_EVOLUTION_SECTION_HEADER = "## Learned recovery playbooks (autonomous)";

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

function notifyRecovery(title: string, body: string): void {
  try {
    if (!app.isReady() || !Notification.isSupported()) return;
    new Notification({ title, body: body.slice(0, 220), silent: true }).show();
  } catch {
    /* 알림 실패는 무시 */
  }
}

function appendAutomationChatMessage(automation: Automation, text: string): void {
  try {
    const chat = getOrCreateAutomationSession({
      automationId: automation.id,
      ...(automation.targetType === "firm"
        ? { firmId: automation.targetId }
        : automation.targetType === "agent"
          ? { agentId: automation.targetId }
          : {}),
    });
    appendChatMessage(chat.id, "system", text);
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

/** 에이전트 패키지에서 rule 진화가 허용된 프롬프트 파일을 찾는다(존재하는 첫 후보). */
function resolvePromptTarget(agentId: string): { targetPath: string; content: string } | null {
  for (const candidate of PROMPT_TARGET_CANDIDATES) {
    try {
      const snapshot = inspectAgentFileText(agentId, candidate);
      if (snapshot.exists) return { targetPath: snapshot.relativePath, content: snapshot.content };
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

/** 학습 플레이북 한 줄을 프롬프트의 자율 진화 섹션에 추가(섹션 없으면 생성). */
export function appendRecoveryPlaybookToPrompt(current: string, playbookLine: string): string {
  const line = `- ${playbookLine.replace(/\s+/g, " ").trim()}`;
  if (current.includes(line)) return current;
  if (current.includes(AUTO_EVOLUTION_SECTION_HEADER)) {
    const index = current.indexOf(AUTO_EVOLUTION_SECTION_HEADER);
    const insertAt = current.indexOf("\n", index + AUTO_EVOLUTION_SECTION_HEADER.length);
    if (insertAt === -1) return `${current}\n${line}\n`;
    return `${current.slice(0, insertAt + 1)}${line}\n${current.slice(insertAt + 1)}`;
  }
  const base = current.endsWith("\n") || current.length === 0 ? current : `${current}\n`;
  return `${base}\n${AUTO_EVOLUTION_SECTION_HEADER}\n${line}\n`;
}

function tryAutonomousEvolution(
  input: AutomationRecoveryInput,
  signature: string,
  recoveryCount: number,
  strategyChange: string | null,
  memoryId: string | null,
): { applied: boolean; proposalId: string | null } {
  if (input.automation.targetType !== "agent") return { applied: false, proposalId: null };
  if (recoveryCount < AUTONOMOUS_EVOLUTION_RECOVERY_THRESHOLD) return { applied: false, proposalId: null };
  const agentId = input.automation.targetId;
  const target = resolvePromptTarget(agentId);
  if (!target) {
    console.warn(`[automation-recovery] no evolvable prompt file for agent ${agentId}; skipping autonomous evolution`);
    return { applied: false, proposalId: null };
  }
  const errors = input.prior.recentErrors.slice(0, 2).join(" | ") || "a recurring failure";
  const playbookLine = strategyChange
    ? `When this task fails with "${errors}", do not retry the failing approach — use: ${strategyChange} (verified by ${recoveryCount} recovered runs, ${signature}).`
    : `When this task fails with "${errors}", do not retry the failing approach — change strategy first; a method change recovered ${recoveryCount} runs (${signature}).`;
  const proposedContent = appendRecoveryPlaybookToPrompt(target.content, playbookLine);
  if (proposedContent === target.content) return { applied: false, proposalId: null };
  try {
    const proposal = createAgentEvolutionProposal({
      agentId,
      targetPath: target.targetPath,
      proposalType: "rule",
      currentContent: target.content,
      proposedContent,
      summary: `Autonomous recovery playbook (${signature}, ${recoveryCount} verified recoveries)`,
      risk: "low",
      source: {
        origin: "automation-recovery",
        automationId: input.automation.id,
        signature,
        recoveryCount,
        evidenceRunId: input.runId,
        ...(memoryId ? { memoryEntryIds: [memoryId] } : {}),
      },
      decisionNote: "autonomous: outcome-attested by repeated recovered runs",
    });
    const applied = approveAndApplyAgentEvolutionProposal(
      proposal.id,
      `autonomous apply after ${recoveryCount} verified recoveries; rollback available in Agent Evolution`,
    );
    return { applied: applied.status === "applied" || applied.status === "measured", proposalId: proposal.id };
  } catch (error) {
    // 동일 타깃에 pending 제안이 이미 있거나 base가 바뀐 경우 등 — 다음 복구에서 재시도된다.
    console.warn("[automation-recovery] autonomous evolution deferred:", error);
    return { applied: false, proposalId: null };
  }
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

  const evolution = tryAutonomousEvolution(input, signature, recoveryCount, strategyChange, memoryId);

  const lines = [
    `🧬 방법 전환으로 복구 성공 — 이전 ${input.prior.streak}회 실패하던 작업이 이번 실행에서 성공했습니다.`,
    strategyChange ? `🔀 전환된 전략: ${strategyChange}` : "🔀 전환된 전략이 선언되지 않아 이번 런 기록을 근거로 남깁니다.",
    experiencePromoted
      ? "🧠 이 경험을 자동으로 기억했습니다(성공 영수증 기반 자동 승격)."
      : memoryId
        ? "🧠 이 경험을 에이전트 메모리에 기록했습니다."
        : "🧠 대상이 단일 에이전트가 아니어서 실행 기록으로만 남깁니다.",
  ];
  if (evolution.applied) {
    lines.push(
      `🧬 같은 실패가 ${recoveryCount}회 복구되어 에이전트 프롬프트에 복구 플레이북을 자동 적용했습니다. ` +
        "에이전트 진화 탭에서 언제든 롤백할 수 있습니다.",
    );
    notifyRecovery(
      `Agent evolved: ${input.automation.name}`,
      "A verified recovery playbook was applied to the agent prompt. Rollback is available in the Agent Evolution tab.",
    );
  }
  appendAutomationChatMessage(input.automation, lines.join("\n"));

  return {
    signature,
    recoveryCount,
    memoryId,
    experiencePromoted,
    evolutionApplied: evolution.applied,
    evolutionProposalId: evolution.proposalId,
  };
}
