// 위임 프로토콜 — CEO/본부가 "어느 하위에게 무엇을" 위임할지 선언하는 펜스 블록.
// memory/events.ts의 파싱 방식을 그대로 따른다(heading + JSON fence, 관용적).
// 오케스트레이터가 reply에서 이 블록을 파싱해 하위 세션을 선택적으로 spawn한다.

import {
  normalizeWorkloadAllocation,
  workloadAllocationPromptExample,
  type WorkloadAllocation,
} from "../runtime/workload-routing";

export const DELEGATE_HEADING = "## Delegate";

export interface Delegation {
  /** 하위 노드의 role 또는 name (오케스트레이터가 ResolvedOrg 자식과 매칭) */
  target: string;
  /** 그 하위에게 줄 집중 브리프(서브태스크) */
  brief: string;
  /** Parent-AI-authored capacity assignment; host code only validates/translates it. */
  allocation: WorkloadAllocation;
}

export interface ParsedDelegation {
  delegations: Delegation[];
  synthesisAllocation: WorkloadAllocation | null;
  /** Delegate 블록을 제거한 reply (사용자에게 보일 텍스트) */
  cleanedText: string;
}

/** 리더 노드(직속 보고자가 있는 노드)의 시스템 프롬프트에 주입할 위임 가이드.
 *  reports는 동적이므로 함수로 생성한다. */
export function buildDelegateProtocol(reports: Array<{ role: string; name?: string }>): string {
  const list = reports
    .map((r) => `  - ${r.role}${r.name && r.name !== r.role ? ` (${r.name})` : ""}`)
    .join("\n");
  return [
    "## Delegation (you orchestrate a team)",
    "",
    "You lead a team. For THIS task, engage ONLY the direct reports actually needed —",
    "never all of them. Give each a focused brief (goal + specifics). If none are needed,",
    "do the work yourself and emit no Delegate block.",
    "",
    "Your direct reports:",
    list,
    "",
    "Judge each child task's complexity, risk, context size, and synthesis burden yourself.",
    "Assign provider-neutral capacity; never copy one flagship model to every child.",
    "To delegate, end your reply with exactly this block (omit entirely if delegating to none):",
    "",
    DELEGATE_HEADING,
    "```json",
    `{ "delegations": [ { "target": "<report role or name above>", "brief": "<what they should do>", "allocation": ${workloadAllocationPromptExample("delegate")} } ], "synthesis": ${workloadAllocationPromptExample("synthesize")} }`,
    "```",
    "",
    "After delegating, STOP — their results come back to you to synthesize. Don't do their work yourself.",
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
            return target
              ? { target, brief, allocation: normalizeWorkloadAllocation(o.allocation, "delegate") }
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
