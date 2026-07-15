export type AutomationResultStatus = "ok" | "error" | "skipped";
export type AutomationTerminalOutcome = "ok" | "skipped" | "blocked" | "needs_input" | "error";

export interface AutomationResultClassification {
  status: AutomationResultStatus;
  outcome: AutomationTerminalOutcome;
  reasonCode: string | null;
  reason: string | null;
  evidence: string | null;
}

const NEEDS_INPUT_PATTERNS: Array<{ re: RegExp; code: string; reason: string }> = [
  // 무인 런의 질문 = 답할 사람이 없는 조용한 실패. runner.ts UNATTENDED_NO_ASK_DIRECTIVE와 짝.
  // (예전엔 질문 fence가 남은 런이 "ok"로 마킹돼 작업이 안 된 채 성공으로 보였다.)
  { re: /<<agentlas-ask>>/i, code: "unattended_question", reason: "agent asked a user question during an unattended run" },
  { re: /\bNEEDS-INPUT\s*:/i, code: "missing_input", reason: "missing required input for an unattended run" },
  { re: /##\s*Automation\s+Intervention|type:\s*(tool-choice|login-required|permission-required|credential-required|hub-approval|human-review|workflow-patch)/i, code: "intervention_required", reason: "automation requires user intervention" },
];

const BLOCKED_PATTERNS: Array<{ re: RegExp; code: string; reason: string }> = [
  { re: /\bEPERM\b|Operation not permitted/i, code: "workspace_permission_denied", reason: "workspace operation was denied by the automation sandbox" },
  { re: /브라우저\s*도구\s*사용\s*불가|browser tools?\s+unavailable/i, code: "browser_unavailable", reason: "browser tools unavailable" },
  { re: /haven['’]?t\s+granted|not\s+granted|permission\s+not\s+granted|권한.{0,20}(미승인|없|허용되지)/i, code: "permission_not_granted", reason: "tool permission not granted" },
  { re: /Browser\s+is\s+already\s+in\s+use|profile.{0,40}(lock|locked)|프로필.{0,40}(잠김|사용\s*중)|브라우저.{0,40}(잠김|사용\s*중)/i, reason: "browser profile locked" },
  { re: /blocked\s+by\s+network\s+security|network\s+security|you['’]?ve\s+been\s+blocked/i, reason: "network security blocked the run" },
  { re: /waiting-for-secure-input|secure-provider-input|credential-vault-input|one-time\s+code|card\s+details/i, reason: "waiting for secure user input" },
  { re: /(?:execution|automation|run|작업|자동화).{0,40}(?:halted|blocked|중단|차단)/i, code: "execution_blocked", reason: "automation reported that execution was blocked or halted" },
].map((pattern) => ({ code: pattern.code ?? "execution_blocked", ...pattern }));

const ERROR_PATTERNS: Array<{ re: RegExp; code: string; reason: string }> = [
  { re: /파이프라인.{0,60}(무산|실패)|pipeline.{0,60}(failed|aborted)/i, reason: "pipeline failed" },
  { re: /게시\s*0\s*건[\s\S]{0,160}(무산|실패|사용\s*불가|도구\s*사용\s*불가)/i, reason: "no posts because required tools failed" },
].map((pattern) => ({ code: "reported_failure", ...pattern }));

const SKIPPED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bNO_APPROVED\b|\bNO_POSTS_YET\b|no\s+approved|approved\s+drafts?\s*[:=]?\s*0/i, reason: "nothing approved to run" },
  { re: /승인.{0,30}0\s*개|게시할.{0,30}(없|없음)|처리할.{0,30}(없|없음)/i, reason: "nothing eligible to run" },
  { re: /nothing\s+to\s+(post|publish|do|process)/i, reason: "nothing eligible to run" },
];

export function classifyAutomationOutput(text: string | null | undefined): AutomationResultClassification {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return { status: "error", outcome: "error", reasonCode: "missing_result", reason: "automation finished without an assistant result", evidence: null };
  for (const pattern of NEEDS_INPUT_PATTERNS) {
    const match = normalized.match(pattern.re);
    if (match) return { status: "error", outcome: "needs_input", reasonCode: pattern.code, reason: pattern.reason, evidence: match[0].slice(0, 240) };
  }
  for (const pattern of BLOCKED_PATTERNS) {
    const match = normalized.match(pattern.re);
    if (match) return { status: "error", outcome: "blocked", reasonCode: pattern.code, reason: pattern.reason, evidence: match[0].slice(0, 240) };
  }
  for (const pattern of ERROR_PATTERNS) {
    const match = normalized.match(pattern.re);
    if (match) return { status: "error", outcome: "error", reasonCode: pattern.code, reason: pattern.reason, evidence: match[0].slice(0, 240) };
  }
  for (const pattern of SKIPPED_PATTERNS) {
    const match = normalized.match(pattern.re);
    if (match) return { status: "skipped", outcome: "skipped", reasonCode: "nothing_to_do", reason: pattern.reason, evidence: match[0].slice(0, 240) };
  }
  return { status: "ok", outcome: "ok", reasonCode: null, reason: null, evidence: null };
}
