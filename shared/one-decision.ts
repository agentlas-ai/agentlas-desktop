import { redactSecrets } from "./secret-patterns";
import type { PendingConfirmation } from "./types";

export const ONE_DECISION_CONTRACT_VERSION = "1.0.0" as const;

export type OneDecisionRiskLevel = "R0" | "R1" | "R2" | "R3" | "R4";
export type OneDecisionRiskCertainty = "inferred" | "ambiguous";
export type OneDecisionOptionDisposition = "choice" | "approve" | "reject" | "modify";
export type OneDecisionFieldStatus = "stated" | "context_only" | "not_stated" | "not_applicable";

export interface OneDecisionField {
  status: OneDecisionFieldStatus;
  value: string | null;
  source: "question" | "header" | "chat_title" | "option_description" | "policy";
}

export interface OneDecisionEvidenceRef {
  kind: "source_message" | "task" | "requested_at";
  ref: string;
  label: string;
}

export interface OneDecisionOption {
  index: number;
  label: string;
  description: string | null;
  disposition: OneDecisionOptionDisposition;
  grantsAuthority: boolean;
  enabled: boolean;
  blockedReason: "unstructured_high_risk" | "multi_select_requires_work" | null;
}

export interface OneDecisionViewV1 {
  contractVersion: typeof ONE_DECISION_CONTRACT_VERSION;
  decisionId: string;
  taskId: string | null;
  chatId: string;
  state: "open";
  createdAt: string;
  target: OneDecisionField;
  action: OneDecisionField;
  impact: OneDecisionField;
  cost: OneDecisionField;
  reversibility: OneDecisionField;
  deadline: OneDecisionField;
  evidence: OneDecisionEvidenceRef[];
  risk: {
    level: OneDecisionRiskLevel;
    certainty: OneDecisionRiskCertainty;
    reasons: Array<"read_only" | "preparation_only" | "limited_change" | "external_effect" | "critical_effect" | "unstructured_authority_request" | "conflicting_signals">;
  };
  options: OneDecisionOption[];
  controls: {
    reject: {
      enabled: true;
      reply: string;
      source: "explicit_option" | "product_safe_default";
    };
    modify: { enabled: true; destination: "work" };
    snooze: { enabled: true; durationHours: 24 };
  };
}

const RISK_ORDER: Record<OneDecisionRiskLevel, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

/** Judgment-cache kinds shared by the async electron warm pass and synchronous peeks. */
export const ONE_DECISION_RISK_JUDGMENT_KIND = "one-decision-risk";
export const ONE_DECISION_DISPOSITION_JUDGMENT_KIND = "one-decision-disposition";

/**
 * Synchronous readers of already-judged verdicts. Electron passes peeks into the
 * resident judgment cache (warmed by prejudgeOneDecision on the async paths that
 * precede projection/authority). The renderer render pass passes nothing and keeps
 * the deterministic wordlist verdicts as the labeled fallback.
 */
export interface OneDecisionJudgedReaders {
  risk?: (combinedText: string) => OneDecisionRiskLevel | null;
  disposition?: (optionText: string) => OneDecisionOptionDisposition | null;
}
const RISK_REASONS = new Set<OneDecisionViewV1["risk"]["reasons"][number]>([
  "read_only", "preparation_only", "limited_change", "external_effect", "critical_effect",
  "unstructured_authority_request", "conflicting_signals",
]);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COST_RE = /(?:[$₩€£]\s*\d[\d,.]*|\d[\d,.]*\s*(?:원|krw|usd|eur|gbp|credits?))/i;
const DEADLINE_RE = /(?:\b\d{4}-\d{1,2}-\d{1,2}(?:[t\s]\d{1,2}(?::\d{2})?)?\b|\b(?:by|before|until)\s+[^,.!?\n]{2,48}|\d{1,2}\s*월\s*\d{1,2}\s*일(?:\s*(?:오전|오후)?\s*\d{1,2}(?::\d{2})?)?\s*(?:까지|이전)?)/i;
const IRREVERSIBLE_RE = /(?:irreversible|permanent(?:ly)?|cannot\s+(?:be\s+)?undo|can't\s+(?:be\s+)?undo|되돌릴\s*수\s*없|영구적)/i;
const REVERSIBLE_RE = /(?:reversible|can\s+(?:be\s+)?undo|rollback|recoverable|되돌릴\s*수\s*있|롤백|복구\s*가능|취소\s*가능)/i;
const COST_RELEVANT_RE = /(?:payment|checkout|purchase|buy|paid|billing|subscription|credit|결제|구매|구독|비용|크레딧)/i;

const RISK_PATTERNS: Array<{ level: OneDecisionRiskLevel; reason: OneDecisionViewV1["risk"]["reasons"][number]; re: RegExp }> = [
  // Under-warning is the dangerous direction here, so the money/destruction verbs stay
  // broad: "wire the money", "wipe all records", "drop the database" used to fall through
  // to a lower level than the equivalent "transfer funds" / "mass delete".
  { level: "R4", reason: "critical_effect", re: /(?:legal\s+(?:filing|submission)|file\s+(?:a\s+)?lawsuit|(?:transfer|wire|remit|withdraw)\s+(?:the\s+)?(?:funds?|money|balance|payment)|security\s+(?:setting|permission)|change\s+(?:owner|admin)|(?:mass\s+delet|wipe|erase|purge|drop)\s*(?:all|the|every)?\s*(?:record|data|database|table|account|user)?|법적\s*제출|소송\s*제출|자금\s*(?:이체|송금)|송금|권한\s*변경|보안\s*설정|(?:대규모|전체|모든)\s*(?:삭제|초기화))/i },
  { level: "R3", reason: "external_effect", re: /(?:send\s+(?:an?\s+)?(?:email|message)|publish|post\s+(?:it|this|public)|book(?:ing)?|reserve|pay(?:ment)?|checkout|purchase|delete|invite\s+(?:a\s+)?user|메일\s*발송|메시지\s*전송|공개\s*게시|게시|예약|결제|구매|삭제|사용자\s*초대)/i },
  { level: "R2", reason: "limited_change", re: /(?:save|write|update|edit\s+(?:the\s+)?file|share\s+(?:with|to)|upload|install|connect\s+(?:the|to)|enable|rename|move\s+(?:the\s+)?file|저장|파일\s*쓰기|업데이트|팀원.*공유|업로드|설치|연결|활성화|이름\s*변경|파일\s*이동)/i },
  { level: "R1", reason: "preparation_only", re: /(?:draft|prepare|preview|compare|temporary|proposal|research|초안|준비|미리보기|비교|임시|제안|조사)/i },
  { level: "R0", reason: "read_only", re: /(?:read|view|inspect|search|review|summari[sz]e|읽|조회|검색|검토|요약)/i },
];

// "without" / "…없이 계속" / "…하지 않" are usually QUALIFIERS on an action option
// ("Send without CC", "확인 없이 계속", "위험을 초래하지 않고 진행"), not a refusal. They used
// to classify an approve option as a rejection, which then under-rated the decision's risk —
// the dangerous direction for a send/pay/publish card. Only treat them as a refusal when
// they negate the action itself (do not send / 발송하지 않).
const REJECT_RE = /(?:\breject\b|\bdeny\b|\bdecline\b|\bdo\s+not\b|\bdon't\b|\bcancel\b|\bstop\b|\bskip\b|\bnot\s+now\b|거절|거부|허용\s*안|취소|중단|건너뛰|저장\s*안|발송\s*안|게시\s*안|(?:보내|발송|게시|저장|결제|구매|삭제|공유|업로드|설치|연결|진행|실행)\s*하지\s*않)/i;
const MODIFY_RE = /(?:\bmodify\b|\bedit\b|\bchange\b|\badjust\b|review\s+scope|수정|변경|범위\s*검토)/i;
const APPROVE_RE = /(?:\bapprove\b|\ballow\b|\bconfirm\b|\bproceed\b|\bcontinue\b|\bsend\b|\bpublish\b|\bpay\b|\bpurchase\b|\bbook\b|\bdelete\b|\bsave\b|\bshare\b|\bupload\b|\bconnect\b|\benable\b|\binstall\b|이\s*범위|허용|승인|확정|진행|계속|보내|발송|게시|결제|구매|예약|삭제|저장|공유|업로드|연결|활성|설치)/i;

function safeText(value: string, maxLength: number): string {
  return redactSecrets(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => allowed.has(key));
}

/** The exact per-option text the disposition judgment reads (and electron pre-judges). */
export function oneDecisionOptionJudgmentInput(label: string, description: string): string {
  return `${label} ${description}`;
}

/** Deterministic wordlist disposition — the labeled fallback, never the final authority. */
export function lexicalOneDecisionDisposition(text: string): OneDecisionOptionDisposition {
  if (REJECT_RE.test(text)) return "reject";
  if (MODIFY_RE.test(text)) return "modify";
  if (APPROVE_RE.test(text)) return "approve";
  return "choice";
}

function classifyOption(
  label: string,
  description: string,
  judged?: OneDecisionJudgedReaders["disposition"],
): OneDecisionOptionDisposition {
  const text = oneDecisionOptionJudgmentInput(label, description);
  // The connected-model verdict decides. With NO verdict we FAIL CLOSED to a
  // neutral "choice" (which, under the fail-closed R4 level below, cannot grant
  // authority without explicit approval) — never a keyword disposition. The
  // reject/modify CONTROLS still work, so the user can always decline. The
  // disposition wordlists survive only as the judge's prior.
  return (judged?.(text) ?? null) ?? "choice";
}

/** Deterministic wordlist risk level — the labeled fallback prior for the judge. */
export function lexicalOneDecisionRiskLevel(
  text: string,
  optionDispositions: readonly OneDecisionOptionDisposition[],
): OneDecisionRiskLevel {
  const matches = RISK_PATTERNS.filter((pattern) => pattern.re.test(text));
  let level: OneDecisionRiskLevel = "R0";
  for (const match of matches) {
    if (RISK_ORDER[match.level] > RISK_ORDER[level]) level = match.level;
  }
  if (optionDispositions.includes("approve") && matches.length === 0) level = "R2";
  return level;
}

const CANONICAL_LEVEL_REASON: Record<OneDecisionRiskLevel, OneDecisionViewV1["risk"]["reasons"][number]> = {
  R0: "read_only",
  R1: "preparation_only",
  R2: "limited_change",
  R3: "external_effect",
  R4: "critical_effect",
};

function inferRisk(
  text: string,
  optionDispositions: readonly OneDecisionOptionDisposition[],
  judged?: OneDecisionJudgedReaders["risk"],
): OneDecisionViewV1["risk"] {
  // The connected model decides the risk level (a payment/send phrased in a
  // language the wordlists never covered still reaches R3/R4). With NO verdict —
  // no reader (renderer render pass) or a reader that returns null (no model /
  // not warmed) — we FAIL CLOSED to the highest risk and require explicit
  // approval. This is a safe stop, not a keyword decision; the RISK_PATTERNS
  // wordlists survive only as the judge's prior.
  const judgedLevel = judged?.(text) ?? null;
  if (judgedLevel === null) {
    return { level: "R4", certainty: "ambiguous", reasons: ["critical_effect", "unstructured_authority_request"] };
  }
  const level = judgedLevel;
  // RISK_PATTERNS matches are used ONLY to attribute descriptive reasons to the
  // model-decided level, never to decide it.
  const matches = RISK_PATTERNS.filter((pattern) => pattern.re.test(text));
  const hasUnstructuredAuthority = optionDispositions.includes("approve");
  const reasons = [...new Set(matches
    .filter((match) => match.level === level)
    .map((match) => match.reason))];
  if (reasons.length === 0) reasons.push(CANONICAL_LEVEL_REASON[level]);
  if (hasUnstructuredAuthority && RISK_ORDER[level] >= RISK_ORDER.R2) reasons.push("unstructured_authority_request");
  if (matches.some((match) => RISK_ORDER[match.level] <= 1) && matches.some((match) => RISK_ORDER[match.level] >= 2)) {
    reasons.push("conflicting_signals");
  }
  if (reasons.length === 0) reasons.push(level === "R0" ? "read_only" : "unstructured_authority_request");
  return {
    level,
    certainty: RISK_ORDER[level] >= RISK_ORDER.R2 || reasons.includes("conflicting_signals") ? "ambiguous" : "inferred",
    reasons: [...new Set(reasons)],
  };
}

function matchedField(text: string, re: RegExp, source: OneDecisionField["source"]): OneDecisionField | null {
  const match = text.match(re)?.[0];
  return match ? { status: "stated", value: safeText(match, 160), source } : null;
}

/**
 * The exact judgment inputs for one pending Decision: the combined risk text and
 * every option's disposition text. The async electron pre-pass judges these exact
 * strings so the synchronous peeks inside normalizeOneDecision hit the cache.
 */
export function oneDecisionJudgmentTexts(
  confirmation: Pick<PendingConfirmation, "question" | "header" | "options">,
): { combined: string; options: string[] } {
  const question = safeText(confirmation.question, 4_000);
  const header = safeText(confirmation.header ?? "", 200);
  const rawOptions = confirmation.options.slice(0, 8).map((option) => ({
    label: safeText(option.label, 200),
    description: safeText(option.description ?? "", 1_000),
  }));
  return {
    combined: [question, header, ...rawOptions.flatMap((option) => [option.label, option.description])].join(" "),
    options: rawOptions.map((option) => oneDecisionOptionJudgmentInput(option.label, option.description)),
  };
}

export function normalizeOneDecision(
  confirmation: PendingConfirmation,
  taskId: string | null = null,
  judged?: OneDecisionJudgedReaders,
): OneDecisionViewV1 {
  const question = safeText(confirmation.question, 4_000);
  const header = safeText(confirmation.header ?? "", 200);
  const chatTitle = safeText(confirmation.chatTitle, 512);
  const rawOptions = confirmation.options.slice(0, 8).map((option) => ({
    label: safeText(option.label, 200),
    description: safeText(option.description ?? "", 1_000),
  }));
  const dispositions = rawOptions.map((option) => classifyOption(option.label, option.description, judged?.disposition));
  const combined = [question, header, ...rawOptions.flatMap((option) => [option.label, option.description])].join(" ");
  const risk = inferRisk(combined, dispositions, judged?.risk);
  const unstructuredHighRisk = RISK_ORDER[risk.level] >= RISK_ORDER.R2 && risk.certainty === "ambiguous";
  const impactText = rawOptions.map((option) => option.description).filter(Boolean).join(" · ");
  const explicitRejectIndex = dispositions.findIndex((item) => item === "reject");
  const cost: OneDecisionField = matchedField(combined, COST_RE, "question") ?? (COST_RELEVANT_RE.test(combined)
    ? { status: "not_stated", value: null, source: "policy" as const }
    : { status: "not_applicable", value: null, source: "policy" as const });
  const reversibility: OneDecisionField = IRREVERSIBLE_RE.test(combined)
    ? { status: "stated", value: "irreversible", source: "question" as const }
    : REVERSIBLE_RE.test(combined)
      ? { status: "stated", value: "reversible", source: "question" as const }
      : risk.level === "R0"
        ? { status: "not_applicable", value: null, source: "policy" as const }
        : { status: "not_stated", value: null, source: "policy" as const };
  const deadline: OneDecisionField = matchedField(combined, DEADLINE_RE, "question")
    ?? { status: "not_stated", value: null, source: "policy" as const };

  const options: OneDecisionOption[] = rawOptions.map((option, index) => {
    const disposition = dispositions[index];
    const grantsAuthority = disposition === "approve" || (unstructuredHighRisk && disposition === "choice");
    const blockedReason = disposition === "modify" || disposition === "reject"
      ? null
      : confirmation.multiSelect
        ? "multi_select_requires_work" as const
        : grantsAuthority && unstructuredHighRisk
          ? "unstructured_high_risk" as const
          : null;
    return {
      index,
      label: option.label,
      description: option.description || null,
      disposition,
      grantsAuthority,
      enabled: disposition === "reject" || (disposition !== "modify" && blockedReason === null),
      blockedReason,
    };
  });

  const view: OneDecisionViewV1 = {
    contractVersion: ONE_DECISION_CONTRACT_VERSION,
    decisionId: confirmation.sourceMessageId,
    taskId,
    chatId: confirmation.chatId,
    state: "open",
    createdAt: confirmation.createdAt,
    target: header
      ? { status: "stated", value: header, source: "header" }
      : chatTitle
        ? { status: "context_only", value: chatTitle, source: "chat_title" }
        : { status: "not_stated", value: null, source: "policy" },
    action: { status: "stated", value: question, source: "question" },
    impact: impactText
      ? { status: "stated", value: safeText(impactText, 2_000), source: "option_description" }
      : { status: "not_stated", value: null, source: "policy" },
    cost,
    reversibility,
    deadline,
    evidence: [
      { kind: "source_message", ref: confirmation.sourceMessageId, label: "Assistant decision request" },
      ...(taskId ? [{ kind: "task" as const, ref: taskId, label: "Canonical Task" }] : []),
      { kind: "requested_at", ref: confirmation.createdAt, label: "Request timestamp" },
    ],
    risk,
    options,
    controls: {
      reject: explicitRejectIndex >= 0
        ? { enabled: true, reply: rawOptions[explicitRejectIndex].label, source: "explicit_option" }
        : { enabled: true, reply: "Reject. Do not take the proposed action.", source: "product_safe_default" },
      modify: { enabled: true, destination: "work" },
      snooze: { enabled: true, durationHours: 24 },
    },
  };
  return view;
}

function isField(value: unknown): value is OneDecisionField {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const field = value as Record<string, unknown>;
  if (!exactKeys(field, ["status", "value", "source"])) return false;
  if (!["stated", "context_only", "not_stated", "not_applicable"].includes(String(field.status))) return false;
  if (!["question", "header", "chat_title", "option_description", "policy"].includes(String(field.source))) return false;
  if (field.status === "stated" || field.status === "context_only") {
    return typeof field.value === "string" && field.value.length > 0 && field.value.length <= 4_000;
  }
  return field.value === null;
}

export function isOneDecisionViewV1(value: unknown): value is OneDecisionViewV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  if (!exactKeys(view, [
    "contractVersion", "decisionId", "taskId", "chatId", "state", "createdAt", "target", "action",
    "impact", "cost", "reversibility", "deadline", "evidence", "risk", "options", "controls",
  ])) return false;
  if (view.contractVersion !== ONE_DECISION_CONTRACT_VERSION || view.state !== "open") return false;
  if (typeof view.decisionId !== "string" || !SAFE_ID_RE.test(view.decisionId)) return false;
  if (view.taskId !== null && (typeof view.taskId !== "string" || !SAFE_ID_RE.test(view.taskId))) return false;
  if (typeof view.chatId !== "string" || !SAFE_ID_RE.test(view.chatId)) return false;
  if (typeof view.createdAt !== "string" || !Number.isFinite(Date.parse(view.createdAt))) return false;
  if (![view.target, view.action, view.impact, view.cost, view.reversibility, view.deadline].every(isField)) return false;
  if (!Array.isArray(view.evidence) || view.evidence.length < 2 || view.evidence.length > 3) return false;
  for (const raw of view.evidence) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const evidence = raw as Record<string, unknown>;
    if (!exactKeys(evidence, ["kind", "ref", "label"])) return false;
    if (!["source_message", "task", "requested_at"].includes(String(evidence.kind))) return false;
    if (typeof evidence.ref !== "string" || !evidence.ref || evidence.ref.length > 256) return false;
    if (typeof evidence.label !== "string" || !evidence.label || evidence.label.length > 200) return false;
  }
  if (!view.risk || typeof view.risk !== "object" || Array.isArray(view.risk)) return false;
  const risk = view.risk as Record<string, unknown>;
  if (!exactKeys(risk, ["level", "certainty", "reasons"])) return false;
  if (!["R0", "R1", "R2", "R3", "R4"].includes(String(risk.level))) return false;
  if (!["inferred", "ambiguous"].includes(String(risk.certainty)) || !Array.isArray(risk.reasons) || risk.reasons.length < 1) return false;
  if (!risk.reasons.every((reason) => typeof reason === "string" && RISK_REASONS.has(reason as OneDecisionViewV1["risk"]["reasons"][number]))) return false;
  if (new Set(risk.reasons).size !== risk.reasons.length) return false;
  if (!Array.isArray(view.options) || view.options.length < 2 || view.options.length > 8) return false;
  const optionIndexes = new Set<number>();
  for (const raw of view.options) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const option = raw as Record<string, unknown>;
    if (!exactKeys(option, ["index", "label", "description", "disposition", "grantsAuthority", "enabled", "blockedReason"])) return false;
    if (!Number.isInteger(option.index) || Number(option.index) < 0 || Number(option.index) > 7 || optionIndexes.has(Number(option.index))) return false;
    optionIndexes.add(Number(option.index));
    if (typeof option.label !== "string" || !option.label || option.label.length > 200) return false;
    if (option.description !== null && (typeof option.description !== "string" || option.description.length > 1_000)) return false;
    if (!["choice", "approve", "reject", "modify"].includes(String(option.disposition))) return false;
    if (typeof option.grantsAuthority !== "boolean" || typeof option.enabled !== "boolean") return false;
    if (option.blockedReason !== null && !["unstructured_high_risk", "multi_select_requires_work"].includes(String(option.blockedReason))) return false;
    if (RISK_ORDER[risk.level as OneDecisionRiskLevel] >= RISK_ORDER.R2 && risk.certainty === "ambiguous" && option.grantsAuthority && option.enabled) return false;
  }
  if (!view.controls || typeof view.controls !== "object" || Array.isArray(view.controls)) return false;
  const controls = view.controls as Record<string, unknown>;
  if (!exactKeys(controls, ["reject", "modify", "snooze"])) return false;
  const reject = controls.reject as Record<string, unknown> | null;
  const modify = controls.modify as Record<string, unknown> | null;
  const snooze = controls.snooze as Record<string, unknown> | null;
  return Boolean(
    reject && exactKeys(reject, ["enabled", "reply", "source"]) && reject.enabled === true
      && typeof reject.reply === "string" && reject.reply.length > 0 && reject.reply.length <= 200
      && ["explicit_option", "product_safe_default"].includes(String(reject.source))
      && modify && exactKeys(modify, ["enabled", "destination"]) && modify.enabled === true && modify.destination === "work"
      && snooze && exactKeys(snooze, ["enabled", "durationHours"]) && snooze.enabled === true && snooze.durationHours === 24,
  );
}

export function isPendingConfirmationSnoozed(confirmation: Pick<PendingConfirmation, "snoozedUntil">, now = Date.now()): boolean {
  return typeof confirmation.snoozedUntil === "string"
    && Number.isFinite(Date.parse(confirmation.snoozedUntil))
    && Date.parse(confirmation.snoozedUntil) > now;
}
