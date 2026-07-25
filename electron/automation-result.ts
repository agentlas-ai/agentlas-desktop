export type AutomationResultStatus = "ok" | "partial" | "error" | "skipped" | "blocked" | "needs_input";
export type AutomationTerminalOutcome = AutomationResultStatus;

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
  { re: /\bautomation_hub_version_pin_required\b/i, code: "hub_version_pin_required", reason: "an exact Hub package version must be selected before this automation can run" },
  { re: /\bpinned_runtime_contract_invalid\b/i, code: "pinned_runtime_contract_invalid", reason: "the saved runtime pin is malformed and must be selected again" },
  { re: /\bautomation_hub_mode_contract_invalid\b/i, code: "hub_mode_contract_invalid", reason: "the saved Hub routing policy is unknown and must be selected again" },
];

const BLOCKED_PATTERNS: Array<{ re: RegExp; code: string; reason: string }> = [
  { re: /\bEPERM\b|Operation not permitted/i, code: "workspace_permission_denied", reason: "workspace operation was denied by the automation sandbox" },
  { re: /브라우저\s*도구\s*사용\s*불가|browser tools?\s+unavailable/i, code: "browser_unavailable", reason: "browser tools unavailable" },
  { re: /haven['’]?t\s+granted|not\s+granted|permission\s+not\s+granted|권한.{0,20}(미승인|없|허용되지)/i, code: "permission_not_granted", reason: "tool permission not granted" },
  { re: /Browser\s+is\s+already\s+in\s+use|profile.{0,40}(lock|locked)|프로필.{0,40}(잠김|사용\s*중)|브라우저.{0,40}(잠김|사용\s*중)/i, reason: "browser profile locked" },
  { re: /blocked\s+by\s+network\s+security|network\s+security|you['’]?ve\s+been\s+blocked/i, reason: "network security blocked the run" },
  { re: /waiting-for-secure-input|secure-provider-input|credential-vault-input|one-time\s+code|card\s+details/i, reason: "waiting for secure user input" },
  { re: /\binsufficient_credits\b/i, code: "insufficient_credits", reason: "Hub credits are insufficient for this exact Workforce request" },
  { re: /\bowner_only\b/i, code: "owner_only", reason: "the selected Hub capability is restricted to its owner" },
  { re: /\bno_cloud_package\b/i, code: "no_cloud_package", reason: "the exact requested Cloud package is unavailable" },
  { re: /\bagent_not_found\b/i, code: "agent_not_found", reason: "the exact requested Hub agent release was not found" },
  { re: /\bsource_unauthorized\b|authentication\s+required|sign[ -]?in\s+required|로그인.{0,20}(필요|만료)/i, code: "hub_auth_required", reason: "Agentlas Hub authentication is required" },
  { re: /\bsource_(?:timeout|unavailable|rate_limited)\b/i, code: "hub_source_temporarily_unavailable", reason: "the required Hub source is temporarily unavailable" },
  { re: /\bsource_bundle_fetch_failed\b/i, code: "hub_bundle_temporarily_unavailable", reason: "the exact Hub runtime bundle could not be fetched temporarily" },
  { re: /\bautomation_hub_version_pin_unavailable\b/i, code: "hub_version_pin_temporarily_unavailable", reason: "the exact callable Hub release could not be verified yet; the automation remains enabled for retry" },
  { re: /\bautomation_hub_version_pin_invalid\b/i, code: "hub_version_pin_invalid", reason: "the saved Hub release pin is malformed and requires repair" },
  { re: /\bsource_(?:not_configured|not_supported)\b/i, code: "hub_source_not_configured", reason: "the required Hub source is not configured or supported by this runtime" },
  { re: /\bsource_bundle_fetch_not_supported\b/i, code: "hub_bundle_fetch_not_supported", reason: "this runtime cannot fetch the exact selected Hub release" },
  { re: /\bsource_forbidden\b/i, code: "hub_source_forbidden", reason: "the signed-in account is forbidden from using the required Hub source" },
  { re: /\b(?:source_bundle_verification_failed|source_bundle_claim_mismatch|selected_release_source_pin_mismatch)\b/i, code: "workforce_bundle_contract_invalid", reason: "the fetched Hub bundle does not match the exact selected release pin" },
  { re: /\bhub_(?:source_(?:scope_mismatch|result_invalid|receipt_invalid|result_not_succeeded|provenance_mismatch|pin_mismatch)|federation_(?:digest_mismatch|session_mismatch))\b/i, code: "workforce_hub_source_contract_invalid", reason: "the Hub-required Workforce source receipt or provenance contract is invalid" },
  { re: /\bworkforce_session_refresh_exhausted\b|\bfederation_session_(?:expired|not_found)\b/i, code: "workforce_session_unavailable", reason: "the Workforce transaction expired before preparation completed" },
  { re: /\bworkforce_runtime_incompatible\b|unsupported.{0,50}(?:workforce|federat)|pinned Core schema|federated-(?:selection|preparation) schema|runtime.{0,50}incompatible/i, code: "workforce_runtime_incompatible", reason: "Desktop and Agentlas OS Workforce contracts are incompatible" },
  { re: /\bautomation_partial_reconciliation_required\b|\bautomation_partial_graph_changed\b/i, code: "partial_reconciliation_required", reason: "a prior partial occurrence must be reconciled before any committed node can be replayed" },
  { re: /\bautomation_ambiguous_side_effect\b|\bautomation_checkpoint_unavailable\b/i, code: "ambiguous_side_effect", reason: "an external action may have committed without a durable provider receipt" },
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

/** Reason codes that come from a literal, structured marker (an exact error code or fence),
 *  not from prose. These are format signals — high-precision and language-independent — so the
 *  resident judge is not allowed to override them. Everything else is prose the judge adjudicates. */
const STRUCTURED_REASON_CODES = new Set<string>([
  "unattended_question", "missing_input", "intervention_required",
  "hub_version_pin_required", "pinned_runtime_contract_invalid", "hub_mode_contract_invalid",
  "insufficient_credits", "owner_only", "no_cloud_package", "agent_not_found",
  "hub_source_temporarily_unavailable", "hub_bundle_temporarily_unavailable",
  "hub_version_pin_temporarily_unavailable", "hub_version_pin_invalid", "hub_source_not_configured",
  "hub_bundle_fetch_not_supported", "hub_source_forbidden", "workforce_bundle_contract_invalid",
  "workforce_hub_source_contract_invalid", "workforce_session_unavailable",
  "workforce_runtime_incompatible", "partial_reconciliation_required", "ambiguous_side_effect",
  "workspace_permission_denied", "insufficient_credits",
]);

/**
 * Meaning-aware automation outcome. The regex patterns above stop being the decider for the
 * prose cases that misfire (e.g. "the run completed and nothing was blocked" wrongly read as
 * blocked); the resident judge decides by intent, with the deterministic result as a strong
 * prior and the reason strings demoted to hints. Structured error-code markers stay
 * authoritative. Safety invariant preserved: a detected failure/blocked/needs_input is only
 * downgraded to "ok" when the judge is highly confident it was a false positive, and a clean
 * "ok" is upgraded to a failure when the judge is confident the run actually failed — an
 * unknown result is never turned into success.
 *
 * Falls back to the pure deterministic classification when no model is reachable.
 */
export async function classifyAutomationOutcome(
  text: string | null | undefined,
  opts: { signal?: AbortSignal } = {},
): Promise<AutomationResultClassification> {
  const det = classifyAutomationOutput(text);
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return det;
  // Structured marker → format signal, authoritative. No model call.
  if (det.reasonCode && STRUCTURED_REASON_CODES.has(det.reasonCode)) return det;

  const { judge } = await import("./system-agents/judgment");
  const verdict = await judge<AutomationResultStatus>({
    kind: "automation-outcome",
    question:
      "Given an AI automation run's own final result text, did the run actually complete its work, or did it fail, get blocked, need user input, have nothing eligible to do, or only partially finish?",
    labels: ["ok", "error", "blocked", "needs_input", "skipped", "partial"] as const,
    input: normalized.slice(0, 4000),
    guidance:
      `A deterministic pre-pass classified this as "${det.status}"` +
      (det.reason ? ` (${det.reason})` : "") +
      `. Treat that as a prior, not a fact. Judge the actual outcome the text describes. ` +
      `"ok" = the intended work was done. Negated phrases like "nothing was blocked" or ` +
      `"no permission errors" describe SUCCESS, not a block. Only say blocked/error/needs_input ` +
      `if the run genuinely did not finish its work.`,
    hints: [
      { label: "blocked", words: ["blocked", "halted", "중단", "차단", "not granted", "permission", "authentication required", "sign-in required"] },
      { label: "needs_input", words: ["needs input", "question", "intervention", "user input"] },
      { label: "skipped", words: ["nothing to do", "no approved", "nothing eligible"] },
      { label: "error", words: ["failed", "aborted", "무산", "실패"] },
    ],
    fallback: det.status,
    signal: opts.signal,
  });

  if (verdict.source === "fallback") return det;

  const detFailed = det.status !== "ok";
  const judgeOk = verdict.verdict === "ok";
  // Safety invariant: only downgrade a detected failure to ok on high confidence.
  if (detFailed && judgeOk && verdict.confidence < 0.7) return det;
  // Upgrade a clean ok to a failure only when the judge is reasonably confident.
  if (!detFailed && !judgeOk && verdict.confidence < 0.6) return det;

  if (verdict.verdict === det.status) return det; // agree — keep richer evidence/reasonCode
  return {
    status: verdict.verdict,
    outcome: verdict.verdict,
    reasonCode: judgeOk ? null : det.reasonCode ?? "judged_" + verdict.verdict,
    reason: verdict.reason || det.reason,
    evidence: det.evidence,
  };
}

/** Classify an exception/error event without ever turning an unknown failure into success. */
export function classifyAutomationFailure(text: string | null | undefined): AutomationResultClassification {
  const classified = classifyAutomationOutput(text);
  return classified.outcome === "blocked" || classified.outcome === "needs_input"
    ? { ...classified, status: classified.outcome }
    : {
        status: "error",
        outcome: "error",
        reasonCode: classified.reasonCode ?? "automation_failed",
        reason: classified.reason ?? (text?.trim() || "automation failed"),
        evidence: classified.evidence,
      };
}
