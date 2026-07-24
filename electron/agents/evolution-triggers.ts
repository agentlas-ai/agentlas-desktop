// 일반 실행 증거 → 자가진화 제안 트리거 (Phase 2 / P0-2).
//
// 근본 문제(확인): 진화 제안 생성(createAgentEvolutionProposal)이 automation-recovery
// (스케줄 실패복구)에서만 호출돼 라이브 0건이었다. 이 모듈은 "일반 인터랙티브/팀 실행"의
// durable 증거에서도 제안을 만든다. 세 트리거:
//   ① 반복 실패: 같은 에이전트 + 같은 실패 서명이 N개의 서로 다른 런에서 재발 → 복구 지침 제안.
//   ② 승격 누적: 승격 경험 M건 누적 → "배운 걸 프롬프트에 접자" 제안.
//   ③ 반복 교정: 같은 에이전트를 스티어링으로 반복 교정 → "행동/역할 조정" 제안.
//
// 신뢰 티어(결정적): 저위험(learned 섹션에 append-only, 되돌리기 쉬움) → 자동 적용 + 수동태
// 알림. 고위험(행동/역할 변경) → candidate로 남겨 4표면 승인. 트리거 판정은 결정적 카운터라
// 임베딩/LLM이 필요 없고, 제안 문구도 결정적 템플릿(automation-recovery와 동일 패턴, 폴백 금지).
//
// 어떤 실패도 사용자 턴/런 결과를 오염시키지 않는다 — 전 구간 격리 try/catch.
import { failureSignature, normalizeFailureText } from "../automation-strategy";
import { getDb } from "../store/db";
import { inspectAgentFileText } from "./files";
import { listRecentAgentFailures, countAgentSteeringEvents } from "../store/run-events";
import {
  listPromotedExperienceSummariesForAgent,
  countPromotedExperiencesForAgent,
} from "../experience/store";
import { appendRecoveryPlaybookToPrompt } from "../automation-recovery";
import {
  createAgentEvolutionProposal,
  approveAndApplyAgentEvolutionProposal,
  findGrowthProposalByEvidenceKey,
} from "./evolution";
import type { AgentEvolutionProposalUi } from "../../shared/types";

/** 같은 실패 서명이 이 수만큼 서로 다른 런에서 재발하면 복구 지침을 제안한다. */
export const REPEATED_FAILURE_THRESHOLD = 3;
/** 승격 경험이 이 수만큼 누적될 때마다(버킷) 프롬프트 접기를 한 번 제안한다. */
export const PROMOTION_FOLD_THRESHOLD = 3;
/** 같은 대화에서 스티어링 교정이 이 수 이상이면 행동 조정을 제안한다. */
export const STEERING_CORRECTION_THRESHOLD = 3;

/** evolution.ts의 rule 타깃 화이트리스트와 동일한 후보(우선순위 순). */
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

export type GrowthTriggerKind =
  | "repeated-failure"
  | "promotion-fold"
  | "steering-correction";

export type GrowthRiskTier = "low" | "high";

export interface GrowthCardCopy {
  /** 무엇을 배웠나 */
  learned: string;
  /** 무엇이 바뀌나 */
  change: string;
  /** 되돌릴 수 있음 */
  reversible: string;
}

export interface GrowthTriggerResult {
  kind: GrowthTriggerKind;
  proposalId: string;
  riskTier: GrowthRiskTier;
  autoApplied: boolean;
}

interface PromptTarget {
  targetPath: string;
  content: string;
}

function resolvePromptTarget(agentId: string): PromptTarget | null {
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

/**
 * 순수 additive 여부 — before의 모든 줄이 after에 그대로 남아 있으면 append-only(비파괴).
 * append(끝에 추가)와 섹션 중간 삽입 둘 다 만족한다. 결정적, 임베딩/LLM 불필요.
 */
export function isPureAdditive(before: string, after: string): boolean {
  if (after.length < before.length) return false;
  const afterSet = new Set(after.split("\n"));
  return before.split("\n").every((line) => afterSet.has(line));
}

/**
 * 티어 결정(결정적 — 변경 종류 + blast radius).
 * - steering-correction(행동/역할 변경) → 항상 high(명시 승인).
 * - 그 외: before의 모든 줄을 보존하는 순수 append면 low(자동 적용 + undo), 아니면 high.
 */
export function decideRiskTier(
  kind: GrowthTriggerKind,
  before: string,
  after: string,
): GrowthRiskTier {
  if (kind === "steering-correction") return "high";
  return isPureAdditive(before, after) ? "low" : "high";
}

function humanCard(kind: GrowthTriggerKind, learnedDetail: string): GrowthCardCopy {
  const reversible = "언제든 되돌릴 수 있음 (에이전트 진화 탭 · agentlas evolve revert)";
  if (kind === "repeated-failure") {
    return {
      learned: `같은 실패가 반복됐어요: ${learnedDetail}`,
      change: "앞으로 이 상황에선 실패한 방법을 다시 쓰지 않고 방법을 먼저 바꾸도록 지침을 추가합니다.",
      reversible,
    };
  }
  if (kind === "promotion-fold") {
    return {
      learned: `검증된 경험이 여러 건 쌓였어요: ${learnedDetail}`,
      change: "이 배움을 에이전트 프롬프트의 '배운 것' 섹션에 접어 매번 반영되게 합니다.",
      reversible,
    };
  }
  return {
    learned: `같은 지점을 반복해서 교정하셨어요: ${learnedDetail}`,
    change: "그 교정을 에이전트의 기본 행동으로 반영하도록 프롬프트 조정을 제안합니다(행동 변경이라 승인 필요).",
    reversible,
  };
}

function buildProposal(input: {
  agentId: string;
  kind: GrowthTriggerKind;
  target: PromptTarget;
  proposedContent: string;
  evidenceKey: string;
  learnedDetail: string;
  summary: string;
  memoryEntryIds?: string[];
}): GrowthTriggerResult | null {
  const { agentId, kind, target, proposedContent, evidenceKey } = input;
  if (proposedContent === target.content) return null;
  // 멱등: 같은 증거로 이미 제안(어느 상태든)했으면 재생성하지 않는다.
  if (findGrowthProposalByEvidenceKey(agentId, evidenceKey)) return null;

  const riskTier = decideRiskTier(kind, target.content, proposedContent);
  const card = humanCard(kind, input.learnedDetail);
  let proposal: AgentEvolutionProposalUi;
  try {
    proposal = createAgentEvolutionProposal({
      agentId,
      targetPath: target.targetPath,
      proposalType: "rule",
      currentContent: target.content,
      proposedContent,
      summary: input.summary,
      risk: riskTier,
      source: {
        origin: "normal-run-trigger",
        trigger: kind,
        _growth: true,
        _triggerEvidenceKey: evidenceKey,
        riskTier,
        humanCard: card,
        ...(input.memoryEntryIds && input.memoryEntryIds.length
          ? { memoryEntryIds: input.memoryEntryIds }
          : {}),
      },
      decisionNote: `normal-run trigger: ${kind}`,
    });
  } catch (error) {
    // 같은 타깃에 다른 pending 제안이 있거나 base가 바뀐 경우 등 — 다음 실행에서 재시도.
    console.warn(`[evolution-triggers] proposal creation deferred (${kind}):`, error);
    return null;
  }

  // 저위험(순수 append) → 자동 적용 + 수동태 알림. 고위험 → candidate 유지(4표면 승인).
  if (riskTier === "low") {
    try {
      const applied = approveAndApplyAgentEvolutionProposal(
        proposal.id,
        `auto-applied low-risk growth (${kind}); undo available in Agent Evolution`,
      );
      // 자동적용분을 수동태 인박스에서 "적용됨 · 되돌리기"로 보이게 표식.
      try {
        markGrowthProposalAutoApplied(proposal.id);
      } catch {
        /* 표식 실패는 무해 — 롤백 경로는 그대로 산다 */
      }
      return {
        kind,
        proposalId: proposal.id,
        riskTier,
        autoApplied: applied.status === "applied" || applied.status === "measured",
      };
    } catch (error) {
      console.warn(`[evolution-triggers] low-risk auto-apply deferred (${kind}):`, error);
      return { kind, proposalId: proposal.id, riskTier, autoApplied: false };
    }
  }
  return { kind, proposalId: proposal.id, riskTier, autoApplied: false };
}

/** 자동적용된 저위험 제안을 수동태 인박스가 인지하도록 source에 _autoApplied 표식만 얹는다. */
function markGrowthProposalAutoApplied(proposalId: string): void {
  const row = getDb()
    .prepare("SELECT source_json FROM agent_evolution_proposals WHERE id = ?")
    .get(proposalId) as { source_json: string } | undefined;
  if (!row) return;
  let source: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.source_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) source = parsed;
  } catch {
    /* keep {} */
  }
  source._autoApplied = true;
  getDb()
    .prepare("UPDATE agent_evolution_proposals SET source_json = ? WHERE id = ?")
    .run(JSON.stringify(source), proposalId);
}

/** ① 반복 실패 — 같은 에이전트 + 같은 실패 서명이 N개 이상의 서로 다른 런에서 재발. */
function tryRepeatedFailure(agentId: string, target: PromptTarget): GrowthTriggerResult | null {
  const failures = listRecentAgentFailures(agentId, 300);
  if (failures.length < REPEATED_FAILURE_THRESHOLD) return null;
  // 서명별로 서로 다른 런을 센다(같은 런의 중복 실패는 1회로).
  const runsBySignature = new Map<string, { runs: Set<string>; sample: string }>();
  for (const failure of failures) {
    const normalized = normalizeFailureText(failure.errorMessage);
    if (!normalized) continue;
    const signature = failureSignature([normalized]);
    const bucket = runsBySignature.get(signature) ?? { runs: new Set<string>(), sample: normalized };
    bucket.runs.add(failure.runId);
    runsBySignature.set(signature, bucket);
  }
  let hit: { signature: string; count: number; sample: string } | null = null;
  for (const [signature, bucket] of runsBySignature) {
    if (bucket.runs.size >= REPEATED_FAILURE_THRESHOLD) {
      if (!hit || bucket.runs.size > hit.count) {
        hit = { signature, count: bucket.runs.size, sample: bucket.sample };
      }
    }
  }
  if (!hit) return null;
  const playbookLine =
    `When this task fails with "${hit.sample}", do not retry the failing approach — diagnose first and change method ` +
    `(different tool / data source / order). Observed in ${hit.count} separate runs (${hit.signature}).`;
  const proposedContent = appendRecoveryPlaybookToPrompt(target.content, playbookLine);
  return buildProposal({
    agentId,
    kind: "repeated-failure",
    target,
    proposedContent,
    evidenceKey: `failure:${hit.signature}`,
    learnedDetail: `"${hit.sample}" (${hit.count}회)`,
    summary: `Repeated-failure recovery guidance (${hit.signature}, ${hit.count} runs)`,
  });
}

/** ② 승격 누적 — 승격 경험 M건 버킷마다 한 번 "프롬프트에 접기" 제안. */
function tryPromotionFold(agentId: string, target: PromptTarget): GrowthTriggerResult | null {
  const total = countPromotedExperiencesForAgent(agentId);
  if (total < PROMOTION_FOLD_THRESHOLD) return null;
  const bucket = Math.floor(total / PROMOTION_FOLD_THRESHOLD);
  const promoted = listPromotedExperienceSummariesForAgent(agentId, PROMOTION_FOLD_THRESHOLD);
  if (promoted.length < 1) return null;
  const memoryEntryIds: string[] = [];
  let proposedContent = target.content;
  for (const experience of promoted) {
    const line = experience.summary.replace(/\s+/g, " ").trim().slice(0, 280);
    if (!line) continue;
    proposedContent = appendRecoveryPlaybookToPrompt(proposedContent, line);
  }
  const sampleDetail = promoted
    .map((experience) => experience.summary.replace(/\s+/g, " ").trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 2)
    .join(" · ");
  return buildProposal({
    agentId,
    kind: "promotion-fold",
    target,
    proposedContent,
    evidenceKey: `promotion-fold:${bucket}`,
    learnedDetail: sampleDetail || `${total}건`,
    summary: `Fold ${promoted.length} promoted experience(s) into the prompt (bucket ${bucket})`,
    memoryEntryIds,
  });
}

/** ③ 반복 교정 — 같은 대화에서 스티어링 교정 K회 이상 → 행동 조정(고위험) 제안. */
function trySteeringCorrection(
  agentId: string,
  target: PromptTarget,
  chatId: string | null | undefined,
): GrowthTriggerResult | null {
  const count = countAgentSteeringEvents(agentId, chatId ?? undefined);
  if (count < STEERING_CORRECTION_THRESHOLD) return null;
  const bucket = Math.floor(count / STEERING_CORRECTION_THRESHOLD);
  const behaviorLine =
    `Users have repeatedly corrected this agent mid-run (${count} times). Re-check the task's intent and constraints ` +
    "before acting, and confirm ambiguous scope rather than proceeding on assumptions.";
  const proposedContent = appendRecoveryPlaybookToPrompt(target.content, behaviorLine);
  return buildProposal({
    agentId,
    kind: "steering-correction",
    target,
    proposedContent,
    evidenceKey: `steering:${chatId ?? "global"}:${bucket}`,
    learnedDetail: `${count}회 교정`,
    summary: `Behavior adjustment from ${count} user corrections`,
  });
}

/**
 * 턴 완료 훅 — 인터랙티브/팀 성공 턴 마무리에서 호출된다(client.ts).
 * 결정적 카운터로 세 트리거를 순서대로 평가하고, 첫 히트 하나만 제안한다(한 턴에 최대 1건).
 * 어떤 예외도 던지지 않는다.
 */
export function maybeProposeEvolutionFromRun(input: {
  agentId: string;
  chatId?: string | null;
}): GrowthTriggerResult | null {
  const agentId = input.agentId?.trim();
  if (!agentId) return null;
  try {
    const target = resolvePromptTarget(agentId);
    if (!target) return null;
    return (
      tryRepeatedFailure(agentId, target) ||
      tryPromotionFold(agentId, target) ||
      trySteeringCorrection(agentId, target, input.chatId) ||
      null
    );
  } catch (error) {
    console.warn("[evolution-triggers] evaluation deferred:", error);
    return null;
  }
}
