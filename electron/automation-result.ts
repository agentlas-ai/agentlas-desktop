export type AutomationResultStatus = "ok" | "error" | "skipped";

export interface AutomationResultClassification {
  status: AutomationResultStatus;
  reason: string | null;
}

const ERROR_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /##\s*Automation\s+Intervention|type:\s*(tool-choice|login-required|permission-required|credential-required|hub-approval|human-review|workflow-patch)/i, reason: "automation requires user intervention" },
  { re: /브라우저\s*도구\s*사용\s*불가|browser tools?\s+unavailable/i, reason: "browser tools unavailable" },
  { re: /haven['’]?t\s+granted|not\s+granted|permission\s+not\s+granted|권한.{0,20}(미승인|없|허용되지)/i, reason: "tool permission not granted" },
  { re: /Browser\s+is\s+already\s+in\s+use|profile.{0,40}(lock|locked)|프로필.{0,40}(잠김|사용\s*중)|브라우저.{0,40}(잠김|사용\s*중)/i, reason: "browser profile locked" },
  { re: /blocked\s+by\s+network\s+security|network\s+security|you['’]?ve\s+been\s+blocked/i, reason: "network security blocked the run" },
  { re: /waiting-for-secure-input|secure-provider-input|credential-vault-input|one-time\s+code|card\s+details/i, reason: "waiting for secure user input" },
  { re: /파이프라인.{0,60}(무산|실패)|pipeline.{0,60}(failed|aborted)/i, reason: "pipeline failed" },
  { re: /게시\s*0\s*건[\s\S]{0,160}(무산|실패|사용\s*불가|도구\s*사용\s*불가)/i, reason: "no posts because required tools failed" },
];

const SKIPPED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bNO_APPROVED\b|\bNO_POSTS_YET\b|no\s+approved|approved\s+drafts?\s*[:=]?\s*0/i, reason: "nothing approved to run" },
  { re: /승인.{0,30}0\s*개|게시할.{0,30}(없|없음)|처리할.{0,30}(없|없음)/i, reason: "nothing eligible to run" },
  { re: /nothing\s+to\s+(post|publish|do|process)/i, reason: "nothing eligible to run" },
];

export function classifyAutomationOutput(text: string | null | undefined): AutomationResultClassification {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return { status: "error", reason: "automation finished without an assistant result" };
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.re.test(normalized)) return { status: "error", reason: pattern.reason };
  }
  for (const pattern of SKIPPED_PATTERNS) {
    if (pattern.re.test(normalized)) return { status: "skipped", reason: pattern.reason };
  }
  return { status: "ok", reason: null };
}
