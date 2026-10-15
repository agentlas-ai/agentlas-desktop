// System Optimizer is the model-owned recovery controller. Code supplies
// evidence and authority; it never classifies causes with words or regexes.
import type { SystemAgentSpec } from "../types";

/**
 * 이 프롬프트의 첫 줄. 제품이 자기 자신에게 보내는 지시라, 세션 대화에서 사용자 발화처럼
 * 보이면 안 된다. 지금은 system 턴으로 기록하지만, 그 이전에 user 턴으로 저장된 기록이
 * 남아 있어 표시 단계에서도 이 표식으로 걸러낸다.
 */
export const SYSTEM_OPTIMIZER_PROMPT_MARKER = "You are One's private recovery worker.";

/** 자동화 실패 시 원샷 진단 런에 주입하는 플레이북 프롬프트. */
export function buildSystemOptimizerPrompt(input: {
  automationName: string;
  errorMessage: string;
  doctorSummary?: string;
  consecutiveFailures: number;
}): string {
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.system-agent.system-optimizer.playbook).
  return [
    SYSTEM_OPTIMIZER_PROMPT_MARKER,
    "task: repair safely (reversible, within granted authority, keep user work), verify, retry differently if needed",
    "boundary: identity, payment, irreversible choice = ask one short question",
    "visible: max 3 short lines (ready now; next choice if needed; what One does next); no error strings, codes, paths, model names, system terms",
    `automation: ${JSON.stringify(input.automationName)} (no accepted result, attempt ${input.consecutiveFailures})`,
    "evidence (private, never quote to the user):",
    "```",
    input.errorMessage.slice(0, 1500),
    "```",
    input.doctorSummary ? `prior observation: ${input.doctorSummary}` : "prior diagnosis: none authoritative",
  ].join("\n");
}

export const SYSTEM_OPTIMIZER_SYSTEM_AGENT: SystemAgentSpec = {
  id: "system-optimizer",
  core: [
    "## System Optimizer",
    "role: One's private recovery worker for any operational boundary",
    "cause: judge from full evidence; no keyword lists, regexes, glossaries, default substitutes",
    "repair: within granted authority, preserve user work, verify; expose only concise natural-language results",
  ].join("\n"),
  modules: [],
};
