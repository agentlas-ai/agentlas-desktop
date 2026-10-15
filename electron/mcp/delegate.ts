// 위임 프로토콜 — CEO/본부가 "어느 하위에게 무엇을" 위임할지 선언하는 펜스 블록.
// memory/events.ts의 파싱 방식을 그대로 따른다(heading + JSON fence, 관용적).
// 오케스트레이터가 reply에서 이 블록을 파싱해 하위 세션을 선택적으로 spawn한다.

import {
  normalizeWorkloadAllocation,
  workloadAllocationInventoryPrompt,
  workloadAllocationPromptExample,
  type WorkloadAllocation,
} from "../runtime/workload-routing";
import type { RuntimeStatus } from "../../shared/types";

export const DELEGATE_HEADING = "## Delegate";

/** Which stage a delegated slot runs in; the parent model declares it (no host word matching). */
export type DelegationStage = "production" | "integration" | "verification";
const DELEGATION_STAGES: readonly DelegationStage[] = ["production", "integration", "verification"];

export interface Delegation {
  /** 하위 노드의 role 또는 name (오케스트레이터가 ResolvedOrg 자식과 매칭) */
  target: string;
  /** 그 하위에게 줄 집중 브리프(서브태스크) */
  brief: string;
  /** Parent-AI-authored capacity assignment; host code only validates/translates it. */
  allocation: WorkloadAllocation;
  /** production (default) · integration (combines finished results) · verification (checks them, runs last). */
  stage: DelegationStage;
}

export interface ParsedDelegation {
  delegations: Delegation[];
  synthesisAllocation: WorkloadAllocation | null;
  /** Delegate 블록을 제거한 reply (사용자에게 보일 텍스트) */
  cleanedText: string;
}

/** 리더 노드(직속 보고자가 있는 노드)의 시스템 프롬프트에 주입할 위임 가이드.
 *  reports는 동적이므로 함수로 생성한다. */
export function buildDelegateProtocol(
  reports: Array<{ role: string; name?: string }>,
  runtimes: RuntimeStatus[],
  options: { allowFollowup?: boolean } = {},
): string {
  const list = reports
    .map((r) => `  - ${r.role}${r.name && r.name !== r.role ? ` (${r.name})` : ""}`)
    .join("\n");
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.mcp.firm.delegate-protocol).
  return [
    "## Delegation (you orchestrate a team)",
    "",
    options.allowFollowup
      ? "follow-up: after team results; delegate only the smallest repair / re-verification a failed check needs (name the failed acceptance item, pass the latest evidence); else no Delegate block, final answer"
      : "delegate: only the direct reports this task needs (never all), each a focused brief; none needed → do it yourself, no Delegate block; this is the only initial round: include every needed role now, including independent QA/verification",
    "stage per delegation: production (default) · integration (combines other slots' finished results) · verification (checks them; the host runs it after production/integration)",
    "never a runtime's own sub-agent / Agent / Task / SendMessage tool: the host runs only the Delegate block",
    "",
    "allocation: judge each slot's complexity, risk, context and synthesis burden; provider-neutral capacity + one exact live runtime/model pair; never one flagship for every slot",
    "To delegate, end your reply with exactly this block (omit entirely if delegating to none):",
    "",
    DELEGATE_HEADING,
    "```json",
    `{ "delegations": [ { "target": "<report role or name from 'Your direct reports:'>", "brief": "<what they should do>", "stage": "production", "allocation": ${workloadAllocationPromptExample("delegate")} } ], "synthesis": ${workloadAllocationPromptExample("synthesize")} }`,
    "```",
    "",
    options.allowFollowup
      ? "After emitting a follow-up Delegate block, STOP. The host runs that one bounded follow-up and returns the updated result for synthesis."
      : "After delegating, STOP — their results come back to you to synthesize.",
    "",
    workloadAllocationInventoryPrompt(runtimes),
    "",
    "Your direct reports:",
    list,
  ].join("\n");
}

/** reply에서 Delegate 블록을 파싱하고, 그 블록을 제거한 텍스트를 함께 반환. */
export function parseDelegations(text: string): ParsedDelegation {
  const idx = text.lastIndexOf(DELEGATE_HEADING);
  if (idx < 0) return { delegations: [], synthesisAllocation: null, cleanedText: text.trim() };

  const after = text.slice(idx + DELEGATE_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let delegations: Delegation[] = [];
  let synthesisAllocation: WorkloadAllocation | null = null;
  if (fence) {
    try {
      const data = JSON.parse(fence[1].trim());
      const rawDelegations = Array.isArray(data)
        ? data
        : data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).delegations)
          ? (data as Record<string, unknown>).delegations as unknown[]
          : [];
      if (!Array.isArray(data) && data && typeof data === "object") {
        const synthesis = (data as Record<string, unknown>).synthesis;
        if (synthesis) synthesisAllocation = normalizeWorkloadAllocation(synthesis, "synthesize");
      }
      if (rawDelegations.length > 0) {
        delegations = rawDelegations
          .map((d): Delegation | null => {
            if (!d || typeof d !== "object") return null;
            const o = d as Record<string, unknown>;
            const target = typeof o.target === "string" ? o.target.trim() : "";
            const brief = typeof o.brief === "string" ? o.brief.trim() : "";
            const stage = DELEGATION_STAGES.includes(o.stage as DelegationStage) ? o.stage as DelegationStage : "production";
            return target
              ? { target, brief, allocation: normalizeWorkloadAllocation(o.allocation, "delegate"), stage }
              : null;
          })
          .filter((d): d is Delegation => d !== null);
      }
    } catch {
      delegations = [];
    }
  }

  let cut = text.length;
  if (fence && fence.index != null) {
    cut = idx + DELEGATE_HEADING.length + fence.index + fence[0].length;
  } else {
    cut = idx; // 펜스 없으면 dangling heading도 제거
  }
  const cleaned = (text.slice(0, idx) + text.slice(cut)).trim();
  return { delegations, synthesisAllocation, cleanedText: cleaned };
}
